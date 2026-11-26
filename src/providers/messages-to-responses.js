// Responses transport for Messages clients; reuse the Chat -> Messages output
// adapter to retain tool validation, cancellation and usage accounting.
import { upstreamFetch, readResponseText } from '../upstream-fetch.js';
import { buildOpenAIHeaders, parseToolInput, mergeOpenAIUsage, NON_ANTHROPIC_IMAGE_PLACEHOLDER } from './openai.js';
import { ssePayloads } from '../sse.js';

function text(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.some((p) => p?.type !== 'text')) throw new Error('Responses adapter requires text-only system/tool-result content');
  return content.map((p) => p.text ?? '').join('\n');
}

// DeepSeek Harness 的 system 消息里可能夹带 tool_addition / tool_removal 控制块
// （中途工具启停）。工具本身仍在顶层 tools 里声明，Responses 输入没有对应表达，
// 只跳过控制块；出现其它未知块时仍然报错，不改「拒绝而不是静默丢弃」的约定。
function systemText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw new Error('Responses adapter requires text-only system/tool-result content');
  const parts = [];
  for (const part of content) {
    if (part?.type === 'tool_addition' || part?.type === 'tool_removal') continue;
    if (part?.type !== 'text') throw new Error('Responses adapter requires text-only system/tool-result content');
    parts.push(part.text ?? '');
  }
  return parts.join('\n');
}

// DSH 的工具结果可以内联图片；Responses 的 function_call_output 只接受文本，
// 与聊天补全适配器一样降级为标记，而不是让整条请求 400。
function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw new Error('Responses adapter requires text-only system/tool-result content');
  const parts = [];
  for (const part of content) {
    if (part?.type === 'text') parts.push(part.text ?? '');
    else if (part?.type === 'image') parts.push(NON_ANTHROPIC_IMAGE_PLACEHOLDER);
    else throw new Error('Responses adapter requires text-only system/tool-result content');
  }
  return parts.join('\n');
}

export function buildResponsesBody(body, targetModel, options = {}) {
  if (body.stop_sequences?.length) throw new Error('Responses adapter does not support stop_sequences');
  // body.thinking（Anthropic 思考开关）在这里被忽略：Responses 输入无法重放推理项，
  // 而擅自补 reasoning.effort 会让不支持推理的上游直接 400。DeepSeek Harness 每个
  // 请求都会带这个字段，因此不能像以前那样直接拒绝整条请求。
  const input = [];
  const systems = body.system ? [text(body.system)] : [];
  for (const message of body.messages ?? []) {
    if (message.role === 'system') {
      const value = systemText(message.content);
      if (value.trim()) systems.push(value);
      continue;
    }
    if (!['user', 'assistant'].includes(message.role)) throw new Error('Unsupported Messages role');
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    // 同一条消息里连续的文本/图片合并成一个 input item，并保持它们相对工具调用/结果的顺序；
    // 助手文本用 output_text，用户文本/图片用 input_text/input_image。
    let pending = null;
    const flush = () => { if (pending?.content.length) input.push(pending); pending = null; };
    const pushPart = (part) => {
      if (!pending) pending = { role: message.role, content: [] };
      pending.content.push(part);
    };
    for (const block of blocks ?? []) {
      if (block.type === 'text') {
        pushPart(message.role === 'assistant' ? { type: 'output_text', text: block.text ?? '' } : { type: 'input_text', text: block.text ?? '' });
      } else if (block.type === 'image' && message.role === 'user') {
        const source = block.source;
        const imageUrl = source?.type === 'url' ? source.url : source?.type === 'base64' ? 'data:' + source.media_type + ';base64,' + source.data : undefined;
        if (!imageUrl) throw new Error('Unsupported Messages image source');
        pushPart({ type: 'input_image', image_url: imageUrl });
      } else if (block.type === 'tool_use' && message.role === 'assistant') {
        if (!block.id || !block.name) throw new Error('Tool use requires id and name');
        const args = JSON.stringify(block.input ?? {});
        parseToolInput(args);
        flush();
        input.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: args });
      } else if (block.type === 'tool_result' && message.role === 'user') {
        if (!block.tool_use_id) throw new Error('Tool result requires tool_use_id');
        const output = toolResultText(block.content ?? '');
        flush();
        input.push({ type: 'function_call_output', call_id: block.tool_use_id, output: block.is_error ? 'Tool error: ' + output : output });
      } else if (block.type === 'thinking') {
        // DSH 会回放带签名的思考块；Responses 输入没有可重放的推理项，
        // 跳过而不是让整条请求失败（聊天补全适配器同样忽略思考块）。
      } else throw new Error('Unsupported Messages content block: ' + (block.type ?? '(missing)'));
    }
    flush();
  }
  const result = { model: targetModel, input, stream: Boolean(body.stream), max_output_tokens: body.max_tokens ?? 4096, store: false };
  if (systems.length) result.instructions = systems.join('\n\n');
  for (const key of ['temperature', 'top_p']) if (typeof body[key] === 'number') result[key] = body[key];
  // 会话上下文存在时给出稳定的缓存键（同一会话命中同一份前缀缓存）；没有上下文就不猜。
  if (options.codexContext?.sessionId) result.prompt_cache_key = options.codexContext.sessionId;
  if (body.tools?.length) {
    result.tools = body.tools.map((tool) => {
      if (tool.type && tool.type !== 'custom') throw new Error('Responses adapter supports custom function tools only');
      return { type: 'function', name: tool.name, description: tool.description ?? '', parameters: tool.input_schema ?? { type: 'object', properties: {} }, strict: false };
    });
    const choice = body.tool_choice;
    result.tool_choice = choice?.type === 'tool' ? { type: 'function', name: choice.name }
      : choice?.type === 'any' ? 'required' : choice?.type === 'none' ? 'none' : 'auto';
    if (choice?.disable_parallel_tool_use !== undefined) result.parallel_tool_calls = !choice.disable_parallel_tool_use;
  }
  return result;
}

export function callOpenAI(provider, body, targetModel, signal, incomingHeaders = {}, options = {}) {
  return upstreamFetch(provider, provider.baseUrl + '/responses', {
    method: 'POST', headers: buildOpenAIHeaders(provider, incomingHeaders, { ...options, targetModel }),
    body: JSON.stringify(buildResponsesBody(body, targetModel, options)), signal,
  });
}

// 保留上游 usage 的全部字段，只在有有效源字段时补 chat 对应名称，避免注入 undefined 覆盖兼容字段。
function completionUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const out = { ...usage };
  if (usage.input_tokens != null) out.prompt_tokens = usage.input_tokens;
  if (usage.output_tokens != null) out.completion_tokens = usage.output_tokens;
  // 源可能同时带原生 details 与兼容 details，逐字段合并保留双方字段，而不是整体覆盖。
  if (usage.input_tokens_details != null) out.prompt_tokens_details = mergeOpenAIUsage(
    { prompt_tokens_details: usage.prompt_tokens_details }, { prompt_tokens_details: usage.input_tokens_details }).prompt_tokens_details;
  if (usage.output_tokens_details != null) out.completion_tokens_details = mergeOpenAIUsage(
    { completion_tokens_details: usage.completion_tokens_details }, { completion_tokens_details: usage.output_tokens_details }).completion_tokens_details;
  return out;
}

export function responseToCompletion(response) {
  if (!response || response.error || !['completed', 'incomplete'].includes(response.status)) throw new Error('Responses upstream did not complete successfully');
  if (response.status === 'incomplete' && response.incomplete_details?.reason !== 'max_output_tokens') throw new Error('Unsupported incomplete Responses result');
  if (!Array.isArray(response.output)) throw new Error('Responses upstream omitted output');
  const parts = [];
  const tools = [];
  for (const item of response.output) {
    if (item.type === 'message') {
      for (const part of item.content ?? []) {
        if (part.type === 'output_text') parts.push(part.text ?? '');
        else if (part.type === 'refusal') parts.push(part.refusal ?? '');
        else throw new Error('Unsupported Responses output content: ' + part.type);
      }
    } else if (item.type === 'function_call') {
      if (!item.call_id || !item.name) throw new Error('Responses tool call requires call_id and name');
      parseToolInput(item.arguments);
      tools.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments || '{}' } });
    } else if (item.type !== 'reasoning') throw new Error('Unsupported Responses output item: ' + item.type);
  }
  return { id: response.id, choices: [{ index: 0, message: { role: 'assistant', content: parts.join(''), tool_calls: tools },
    finish_reason: response.status === 'incomplete' ? 'length' : tools.length ? 'tool_calls' : 'stop' }], usage: completionUsage(response.usage) };
}

export async function parseCompletion(response) {
  if (!(response.headers.get('content-type') ?? '').includes('event-stream')) return responseToCompletion(JSON.parse(await readResponseText(response)));
  let usage;
  for await (const payload of ssePayloads(response.body)) {
    const event = JSON.parse(payload);
    if (event.type === 'error' || event.type === 'response.failed') throw new Error('Responses upstream failed');
    // 非终止分段可能已经带了 usage（部分中转提前上报），先逐字段累积。
    const fragment = event.response?.usage ?? event.usage;
    if (fragment) usage = mergeOpenAIUsage(usage, fragment);
    if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      const completion = responseToCompletion(event.response);
      // 终止事件缺/部分 usage 时保留此前分段已上报的字段，不编造未上报的 token。
      const merged = mergeOpenAIUsage(completion.usage, usage);
      if (Object.keys(merged).length) completion.usage = merged;
      return completion;
    }
  }
  throw new Error('Responses stream ended without a terminal event');
}

export function toChatStream(body) {
  const reader = body?.getReader();
  const input = { async *[Symbol.asyncIterator]() {
    if (!reader) throw new Error('Responses upstream omitted body');
    try { while (true) { const { done, value } = await reader.read(); if (done) break; yield value; } }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  } };
  const encoder = new TextEncoder();
  const frame = (value) => encoder.encode('data: ' + JSON.stringify(value) + '\n\n');
  async function* chunks() {
    const emitted = new Map();
    let size = 0;
    let usage;
    for await (const payload of ssePayloads(input)) {
      const event = JSON.parse(payload);
      if (event.type === 'error' || event.type === 'response.failed') throw new Error('Responses upstream failed');
      const terminal = event.type === 'response.completed' || event.type === 'response.incomplete';
      // 逐字段累积每个分段的 usage；终止事件缺/部分 usage 时也能保留先到的字段。
      const fragment = event.response?.usage ?? event.usage;
      if (fragment) {
        usage = mergeOpenAIUsage(usage, fragment);
        // 终止事件之前的分段 usage 以空 choices 帧下发，供记账消费；终止帧再带合并后的完整 usage。
        if (!terminal) yield frame({ choices: [], usage });
      }
      if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
        const key = event.output_index + ':' + event.content_index;
        const delta = event.delta ?? '';
        emitted.set(key, (emitted.get(key) ?? '') + delta);
        size += delta.length;
        if (size > 64 * 1024 * 1024) throw new Error('Responses output exceeds buffer limit');
        yield frame({ choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] });
      }
      if (terminal) {
        const complete = responseToCompletion(event.response);
        // Compatible endpoints may only send the final output snapshot.
        for (const [index, item] of event.response.output.entries()) {
          if (item.type !== 'message') continue;
          for (const [contentIndex, part] of (item.content ?? []).entries()) {
            const full = part.text ?? part.refusal ?? '';
            const prior = emitted.get(index + ':' + contentIndex) ?? '';
            if (!full.startsWith(prior)) throw new Error('Responses terminal text disagrees with deltas');
            const tail = full.slice(prior.length);
            if (tail) yield frame({ choices: [{ index: 0, delta: { content: tail }, finish_reason: null }] });
          }
        }
        const choice = complete.choices[0];
        const merged = mergeOpenAIUsage(complete.usage, usage);
        // The Messages converter requires complete validated tools. Emit once
        // from the terminal snapshot; Responses output indexes also count text.
        yield frame({ id: complete.id, choices: [{ index: 0, delta: { tool_calls: choice.message.tool_calls.map((tool, index) => ({ ...tool, index })) }, finish_reason: choice.finish_reason }], usage: Object.keys(merged).length ? merged : undefined });
        return;
      }
    }
    throw new Error('Responses stream ended without a terminal event');
  }
  const iterator = chunks();
  let cancelled = false;
  return new ReadableStream({
    async pull(controller) {
      try { const { done, value } = await iterator.next(); if (!cancelled) { if (done) controller.close(); else controller.enqueue(value); } }
      catch (error) { if (!cancelled) controller.error(error); }
    },
    async cancel(reason) {
      cancelled = true;
      await reader?.cancel(reason).catch(() => {});
      await iterator.return();
      // A consumer may cancel before the generator's first pull/finally.
      try { reader?.releaseLock(); } catch {}
    },
  });
}
