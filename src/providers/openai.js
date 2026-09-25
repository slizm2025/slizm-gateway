// OpenAI 兼容上游（DeepSeek / GLM / Kimi / Qwen / OpenAI 官方等）。
// 负责 Anthropic Messages 格式 <-> OpenAI Chat Completions 格式的双向转换。
// 转换规则参考 claude-code-router 与 cc-fleet 的做法。
import { upstreamFetch, readResponseText } from '../upstream-fetch.js';
import { openAIChunks } from '../sse.js';
import { forwardClientHeaders, resolveClientProfile, createCodexContext, buildCodexHeaders, withExtraHeaders } from './client-headers.js';

function blocksToText(content) {
  return Array.isArray(content)
    ? content.map((b) => b?.text ?? '').join('\n')
    : String(content ?? '');
}

export function toOpenAIMessages(system, messages) {
  const out = [];
  // Claude Code 会把环境信息等作为 role=system 的消息放进 messages（mid-conversation system）。
  // 降级成 user 会让它变成最后一条"用户输入"，所以统一并回开头的 system 消息。
  const systemTexts = [];
  if (system) {
    const text = blocksToText(system);
    if (text.trim()) systemTexts.push(text);
  }

  for (const m of messages ?? []) {
    if (m?.role === 'system') {
      const text = blocksToText(m.content);
      if (text.trim()) systemTexts.push(text);
      continue;
    }
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
    const textParts = [];
    const toolCalls = [];
    const toolResults = [];

    for (const b of blocks) {
      if (!b) continue;
      if (b.type === 'text') textParts.push(b.text ?? '');
      else if (b.type === 'tool_use') {
        toolCalls.push({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        });
      } else if (b.type === 'tool_result') {
        const content = Array.isArray(b.content)
          ? b.content.map((c) => c.text ?? '').join('\n')
          : String(b.content ?? '');
        toolResults.push({ role: 'tool', tool_call_id: b.tool_use_id, content });
      } else if (b.type === 'image') {
        // 非 Claude 上游多数不支持图片，降级为文字标记而不是报错
        textParts.push('[图片输入在非 Anthropic 上游被忽略]');
      }
    }

    if (toolResults.length) {
      out.push(...toolResults);
      if (textParts.length) out.push({ role: 'user', content: textParts.join('\n') });
      continue;
    }
    if (m.role === 'assistant' && toolCalls.length) {
      out.push({
        role: 'assistant',
        content: textParts.join('\n') || null,
        tool_calls: toolCalls,
      });
      continue;
    }
    if (textParts.length || m.role === 'user') {
      out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: textParts.join('\n') });
    }
  }
  if (systemTexts.length) {
    out.unshift({ role: 'system', content: systemTexts.join('\n\n') });
  }
  return out;
}

export function toOpenAITools(tools, toolChoice) {
  if (!tools?.length) return { tools: undefined, tool_choice: undefined };
  return {
    tools: tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description ?? '',
        parameters: t.input_schema ?? { type: 'object', properties: {} },
      },
    })),
    tool_choice:
      toolChoice?.type === 'tool'
        ? { type: 'function', function: { name: toolChoice.name } }
        : toolChoice?.type === 'any'
          ? 'required'
          : toolChoice?.type === 'none'
            ? 'none'
            : 'auto',
  };
}

/** 把 Anthropic 的 tool 定义/消息体整体转成 OpenAI 请求体 */
export function buildOpenAIBody(body, targetModel) {
  const { tools, tool_choice } = toOpenAITools(body.tools, body.tool_choice);
  const req = {
    model: targetModel,
    messages: toOpenAIMessages(body.system, body.messages),
    max_tokens: body.max_tokens ?? 4096,
    stream: Boolean(body.stream),
  };
  if (tools) req.tools = tools;
  if (tool_choice && tools) req.tool_choice = tool_choice;
  if (typeof body.temperature === 'number') req.temperature = body.temperature;
  if (typeof body.top_p === 'number') req.top_p = body.top_p;
  if (body.stop_sequences?.length) req.stop = body.stop_sequences.slice(0, 4);
  if (body.stream) req.stream_options = { include_usage: true };
  return req;
}

/** Tool input must be an object; malformed arguments must never become executable defaults. */
export function parseToolInput(argumentsText) {
  let input;
  try { input = JSON.parse(argumentsText || '{}'); } catch { throw new Error('上游工具参数不是合法 JSON'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('上游工具参数必须是 JSON 对象');
  return input;
}

const tokenCount = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

/**
 * OpenAI usage 换算成 Anthropic 语义。OpenAI 的 prompt_tokens 含缓存命中（prompt_tokens_details.cached_tokens，
 * DeepSeek 原生字段为 prompt_cache_hit_tokens），拆成未缓存输入 + cache_read_input_tokens。
 * 两者之和不变，Claude Code 按 input + cache 计算的上下文占用不受影响。
 */
export function anthropicUsageFromOpenAI(usage) {
  if (!usage || !['prompt_tokens', 'input_tokens', 'completion_tokens', 'output_tokens'].some((k) => usage[k] != null)) return {};
  const prompt = tokenCount(usage?.prompt_tokens ?? usage?.input_tokens);
  const cached = Math.min(prompt, tokenCount(
    usage?.prompt_tokens_details?.cached_tokens ?? usage?.input_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens,
  ));
  const out = { input_tokens: prompt - cached, output_tokens: tokenCount(usage?.completion_tokens ?? usage?.output_tokens) };
  if (cached) out.cache_read_input_tokens = cached;
  return out;
}

/** 把 OpenAI 的完成结果转回 Anthropic Messages 响应体 */
export function toAnthropicResponse(oai, requestedModel) {
  const choice = oai?.choices?.[0];
  if (oai?.error || !choice?.message || typeof choice.message !== 'object') throw new Error('上游未返回有效 Chat Completion');
  const msg = choice.message;
  if (msg.content != null && typeof msg.content !== 'string') throw new Error('上游 message.content 必须是文本');
  const content = [];
  // 推理过程：DeepSeek 等用 reasoning_content，OpenRouter 等用 reasoning
  const reasoning = msg.reasoning_content ?? msg.reasoning;
  if (typeof reasoning === 'string' && reasoning) {
    content.push({ type: 'thinking', thinking: reasoning, signature: '' });
  }
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const tc of msg.tool_calls ?? []) {
    if (!tc.id || !tc.function?.name) throw new Error('上游工具调用缺少 id 或名称');
    const input = parseToolInput(tc.function.arguments);
    content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
  }
  if (!content.length) content.push({ type: 'text', text: '' });

  const finish = choice.finish_reason;
  return {
    id: `msg_${oai.id ?? Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason:
      finish === 'tool_calls' ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end_turn',
    stop_sequence: null,
    usage: anthropicUsageFromOpenAI(oai.usage),
  };
}

export function buildOpenAIHeaders(provider, incomingHeaders = {}, options = {}) {
  if (resolveClientProfile(provider, options.targetModel, options.clientProfile) === 'codex') {
    const context = options.codexContext ?? createCodexContext(options.targetModel ?? '', provider.codexReasoningEffort);
    return buildCodexHeaders(provider, context);
  }
  return withExtraHeaders({
    'content-type': 'application/json',
    ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
    ...forwardClientHeaders(incomingHeaders),
  }, provider.extraHeaders);
}

export async function callOpenAI(provider, body, targetModel, signal, incomingHeaders = {}, options = {}) {
  const url = `${provider.baseUrl}/chat/completions`;
  const res = await upstreamFetch(provider, url, {
    method: 'POST',
    headers: buildOpenAIHeaders(provider, incomingHeaders, { ...options, targetModel }),
    body: JSON.stringify(buildOpenAIBody(body, targetModel)),
    signal,
  });
  return res;
}

/**
 * 有些中转站对非流式请求也返回 SSE 格式的响应体。
 * 这里按 content-type 判断，若是 SSE 就把事件拼回一个完整的完成对象。
 */
export async function parseCompletion(upstreamRes) {
  const ct = upstreamRes.headers.get('content-type') ?? '';
  if (!ct.includes('event-stream')) {
    return JSON.parse(await readResponseText(upstreamRes));
  }

  const merged = {
    id: `chatcmpl_${Date.now()}`,
    choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [] }, finish_reason: 'end_turn' }],
    usage: {},
  };
  const contentParts = [];
  const reasoningParts = [];
  const toolAcc = new Map();
  let bufferedChars = 0;

  for await (const j of openAIChunks(upstreamRes.body)) {
    bufferedChars += JSON.stringify(j).length;
    if (bufferedChars > 64 * 1024 * 1024) throw new Error('上游 SSE 累计响应超过缓冲上限');
    if (j.id) merged.id = j.id;
    // 整体合并，保留 prompt_tokens_details.cached_tokens 等缓存字段
    if (j.usage) merged.usage = { ...merged.usage, ...j.usage };
    const choice = j.choices?.find((c) => (c.index ?? 0) === 0);
    if (!choice) continue;
    const delta = choice.delta ?? {};
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === 'string') reasoningParts.push(reasoning);
    if (typeof delta.content === 'string') contentParts.push(delta.content);
    for (const tc of delta.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      if (!toolAcc.has(idx)) {
        toolAcc.set(idx, { id: tc.id, type: 'function', function: { name: '', arguments: '' } });
      }
      const entry = toolAcc.get(idx);
      if (tc.id) entry.id = tc.id;
      if (tc.function?.name) entry.function.name += tc.function.name;
      if (tc.function?.arguments) entry.function.arguments += tc.function.arguments;
    }
    if (choice.finish_reason) merged.choices[0].finish_reason = choice.finish_reason;
  }

  merged.choices[0].message.content = contentParts.join('');
  if (reasoningParts.length) merged.choices[0].message.reasoning_content = reasoningParts.join('');
  if (toolAcc.size) merged.choices[0].message.tool_calls = [...toolAcc.values()];
  return merged;
}

export async function listOpenAIModels(provider) {
  try {
    const res = await upstreamFetch(provider, `${provider.baseUrl}/models`, {
      headers: buildOpenAIHeaders(provider),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) { await res.body?.cancel(); return []; }
    const json = JSON.parse(await readResponseText(res, 4 * 1024 * 1024));
    return (json.data ?? []).map((m) => m.id).filter(Boolean);
  } catch {
    return [];
  }
}
