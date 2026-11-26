// OpenAI SSE -> Anthropic SSE, pulled by the downstream consumer.
import { toAnthropicResponse, parseToolInput, anthropicUsageFromOpenAI, mergeOpenAIUsage } from './providers/openai.js';
import { openAIChunks } from './sse.js';

const enc = new TextEncoder();
function sse(event, data) {
  return enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function openAIToAnthropicStream(upstreamBody, requestedModel, options = {}) {
  const reader = upstreamBody?.getReader();
  let cancelled = false;
  const input = {
    async *[Symbol.asyncIterator]() {
      if (!reader) throw new Error('上游缺少响应体');
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          yield value;
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    },
  };
  async function* frames() {
    let started = false;
    let nextIndex = 0;
    // 思考和正文都是增量块，同一时刻只开一个：上游可能交替输出 reasoning 与正文，
    // 类型切换时先关掉上一个，保证每个块都是 start → delta… → stop，不会往已关闭的块里写。
    let open = null;
    const tools = new Map();
    let usage = { input_tokens: 0, output_tokens: 0 };
    let upstreamUsage = {};
    let stopReason = 'end_turn';
    function* switchTo(type) {
      if (open?.type === type) return;
      if (open) yield sse('content_block_stop', { type: 'content_block_stop', index: open.index });
      open = { type, index: nextIndex++ };
      const block = type === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' };
      yield sse('content_block_start', { type: 'content_block_start', index: open.index, content_block: block });
    }
    try {
      for await (const value of openAIChunks(input)) {
        if (value.usage) {
          upstreamUsage = mergeOpenAIUsage(upstreamUsage, value.usage);
          usage = anthropicUsageFromOpenAI(upstreamUsage);
          try { options.onUsage?.(usage); } catch { /* Usage reporting must not affect the stream. */ }
        }
        const choice = value.choices?.find((c) => (c.index ?? 0) === 0);
        if (!choice) continue;
        // openAIChunks 保证至少出现一个选择块，所以 message_start 一定先于任何内容事件。
        if (!started) {
          started = true;
          yield sse('message_start', { type: 'message_start', message: {
            id: value.id ? `msg_${value.id}` : `msg_${Date.now()}`, type: 'message', role: 'assistant',
            model: requestedModel, content: [], stop_reason: null, stop_sequence: null,
            usage: { ...usage, input_tokens: usage.input_tokens ?? 0, output_tokens: 0 },
          } });
        }
        const delta = choice.delta ?? {};
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === 'string' && reasoning) {
          yield* switchTo('thinking');
          yield sse('content_block_delta', { type: 'content_block_delta', index: open.index, delta: { type: 'thinking_delta', thinking: reasoning } });
        }
        if (typeof delta.content === 'string' && delta.content) {
          yield* switchTo('text');
          yield sse('content_block_delta', { type: 'content_block_delta', index: open.index, delta: { type: 'text_delta', text: delta.content } });
        }
        for (const tc of delta.tool_calls ?? []) {
          const index = tc.index ?? 0;
          if (!tools.has(index)) tools.set(index, { id: '', name: '', arguments: '', size: 0 });
          const tool = tools.get(index);
          if (tc.id) tool.id = tc.id;
          tool.name += tc.function?.name ?? '';
          tool.arguments += tc.function?.arguments ?? '';
          tool.size += (tc.function?.name?.length ?? 0) + (tc.function?.arguments?.length ?? 0);
          if (tools.size > 128 || tool.size > 4 * 1024 * 1024) throw new Error('上游工具调用超过缓冲上限');
        }
        if (choice.finish_reason) {
          stopReason = choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn';
        }
      }
      if (open) yield sse('content_block_stop', { type: 'content_block_stop', index: open.index });
      // Anthropic 保证至少一个内容块；零块 + end_turn 会让 DeepSeek Harness 的
      // translate() 直接按 EMPTY_RESPONSE 报错，所以完全没有内容时补一个空文本块。
      // 只有工具调用的完成本来就有一个 tool_use 块，不能凭空多出文本块。
      if (nextIndex === 0 && tools.size === 0) {
        yield sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        yield sse('content_block_stop', { type: 'content_block_stop', index: 0 });
        nextIndex = 1;
      }
      // Anthropic requires a complete immutable tool name at block_start.
      // Buffer tool fragments until complete; text remains incremental.
      for (const tool of tools.values()) {
        if (!tool.id || !tool.name) throw new Error('上游工具调用缺少 id 或名称');
        parseToolInput(tool.arguments);
      }
      for (const tool of tools.values()) {
        const index = nextIndex++;
        yield sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } });
        if (tool.arguments) yield sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: tool.arguments } });
        yield sse('content_block_stop', { type: 'content_block_stop', index });
      }
      yield sse('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { input_tokens: 0, output_tokens: 0, ...usage } });
      yield sse('message_stop', { type: 'message_stop' });
    } catch (error) {
      if (!cancelled) {
        try { options.onError?.(error); } catch { /* Logging must not prevent the error response. */ }
      }
      // Do not leak upstream bodies or credentials in SSE diagnostics.
      yield sse('error', { type: 'error', error: { type: 'api_error', message: '上游流式响应中断或格式错误；本次请求未自动重试' } });
    }
  }
  const iterator = frames();
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await iterator.next();
      if (cancelled) return;
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel(reason) {
      cancelled = true;
      await reader?.cancel(reason).catch(() => {});
      await iterator.return();
    },
  });
}

/** Convert an already completed Anthropic message into the expected SSE events. */
export function anthropicJsonToStream(message, options = {}) {
  if (!message || message.type !== 'message' || !Array.isArray(message.content)) {
    throw new Error('上游不是有效的 Anthropic message');
  }
  const usage = message.usage ?? {};
  function* frames() {
    yield sse('message_start', { type: 'message_start', message: {
      ...message, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, ...usage, output_tokens: 0 },
    } });
    for (const [index, block] of message.content.entries()) {
      if (!block?.type) throw new Error('上游 content block 缺少 type');
      const contentBlock = block.type === 'text' ? { type: 'text', text: '' }
        : block.type === 'tool_use' ? { type: 'tool_use', id: block.id, name: block.name, input: {} } : block;
      yield sse('content_block_start', { type: 'content_block_start', index, content_block: contentBlock });
      if (block.type === 'text' && block.text) {
        yield sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
      } else if (block.type === 'tool_use') {
        yield sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) } });
      }
      yield sse('content_block_stop', { type: 'content_block_stop', index });
    }
    yield sse('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason ?? 'end_turn', stop_sequence: message.stop_sequence ?? null }, usage: { output_tokens: usage.output_tokens ?? 0 } });
    yield sse('message_stop', { type: 'message_stop' });
  }
  const iterator = frames();
  return new ReadableStream({
    pull(controller) {
      const { done, value } = iterator.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel() { iterator.return(); },
  });
}

export async function convertJsonResponse(upstreamRes, requestedModel, adapter) {
  const oai = adapter?.parseCompletion ? await adapter.parseCompletion(upstreamRes) : await upstreamRes.json();
  return toAnthropicResponse(oai, requestedModel);
}

export const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
};
