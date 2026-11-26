// OpenAI 兼容上游（DeepSeek / GLM / Kimi / Qwen / OpenAI 官方等）。
// 负责 Anthropic Messages 格式 <-> OpenAI Chat Completions 格式的双向转换。
// 转换规则参考 claude-code-router 与 cc-fleet 的做法。
import { upstreamFetch, readResponseText } from '../upstream-fetch.js';
import { openAIChunks } from '../sse.js';
import { forwardClientHeaders, forwardEndToEndHeaders, resolveClientProfile, createRequestProfile, buildCodexHeaders, withExtraHeaders } from './client-headers.js';
import { replaceResponseModel } from './response-body.js';

function blocksToText(content) {
  return Array.isArray(content)
    ? content.map((b) => b?.text ?? '').join('\n')
    : String(content ?? '');
}

/** 非 Anthropic 上游无法表达图片时的统一降级标记（聊天补全与 Responses 适配器共用）。 */
export const NON_ANTHROPIC_IMAGE_PLACEHOLDER = '[图片输入在非 Anthropic 上游被忽略]';

/**
 * Anthropic 图片块 -> Chat Completions 的 image_url 部件。
 * 上游（DeepSeek 视觉模型，2026-11 实测 deepseek-v4.1-flash 认图）接受 data URL 与远程 URL 两种写法；
 * Files API 引用（source.type === 'file'）在网关侧没有对应文件句柄，只能降级。
 * @param block Anthropic 内容块
 * @returns image_url 的 url 字段，无法表达时为 undefined
 */
function imageURLOf(block) {
  const source = block?.source;
  if (!source || typeof source !== 'object') return undefined;
  if (source.type === 'base64' && typeof source.data === 'string' && source.data) {
    const mediaType = typeof source.media_type === 'string' && source.media_type ? source.media_type : 'image/png';
    return `data:${mediaType};base64,${source.data}`;
  }
  if (source.type === 'url' && typeof source.url === 'string' && source.url) return source.url;
  return undefined;
}

/**
 * 构造 user 消息的 content：有图片时用部件数组（文本在前、图片在后），否则退回纯字符串。
 * @param textParts 文本片段
 * @param imageParts 图片 URL 列表
 */
function userContent(textParts, imageParts) {
  if (!imageParts.length) return textParts.join('\n');
  const parts = [];
  if (textParts.length) parts.push({ type: 'text', text: textParts.join('\n') });
  for (const url of imageParts) parts.push({ type: 'image_url', image_url: { url } });
  return parts;
}

/**
 * DeepSeek 思考模式要求把上一轮思考原样带回：请求以 tool 结果结尾时，
 * 最后一条带 tool_calls 的 assistant 消息必须带 reasoning_content，缺字段或 null 会被上游 400
 * （"The `reasoning_content` in the thinking mode must be passed back to the API."，2026-11-01 实测）。
 * 空字符串可以通过校验，所以拿不到思考文本时也要显式回填空串。
 * 其它 OpenAI 兼容上游没有这个字段，只对 DeepSeek 系列模型回填，避免把陌生字段传给 GPT 等上游。
 */
const DEEPSEEK_MODEL = /(^|[/])deepseek/i;

export function toOpenAIMessages(system, messages, options = {}) {
  const replayReasoning = options.replayReasoning === true;
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
    const imageParts = [];
    const thinkingParts = [];
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
        // 视觉上游（如 DeepSeek 视觉模型）接受 image_url 部件；解析不了来源的才降级为文字标记。
        const url = imageURLOf(b);
        if (url) imageParts.push(url);
        else textParts.push(NON_ANTHROPIC_IMAGE_PLACEHOLDER);
      } else if (b.type === 'tool_addition' || b.type === 'tool_removal') {
        // DeepSeek 官方 Messages 协议的中途工具启停块（dsh-llm-deepseek）：
        // 被引用的工具本身已在顶层 tools 里声明，聊天补全没有“此刻启用/停用”的表达，
        // 只能丢掉这个顺序信号，绝不能把控制块当成文本写进消息。
      } else if (b.type === 'thinking') {
        // Anthropic 的思考块在 Chat Completions 里没有独立位置，只能回填成 reasoning_content；
        // 不需要回填的上游（非 DeepSeek）保持原来的丢弃行为。
        if (replayReasoning && typeof b.thinking === 'string' && b.thinking) thinkingParts.push(b.thinking);
      }
    }

    if (toolResults.length) {
      out.push(...toolResults);
      if (textParts.length || imageParts.length) out.push({ role: 'user', content: userContent(textParts, imageParts) });
      continue;
    }
    if (m.role === 'assistant' && toolCalls.length) {
      const message = {
        role: 'assistant',
        content: textParts.join('\n') || null,
        tool_calls: toolCalls,
      };
      // 带 tool_calls 的 assistant 消息是 DeepSeek 思考模式校验的对象：必须带字符串，
      // 没有思考文本可重放时给空串（上游拒绝缺失/null，但接受空串）。
      if (replayReasoning) message.reasoning_content = thinkingParts.join('\n');
      out.push(message);
      continue;
    }
    if (textParts.length || imageParts.length || m.role === 'user') {
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      // assistant 消息在聊天补全里不带图片部件，图片只出现在 user 侧。
      const message = { role, content: role === 'user' ? userContent(textParts, imageParts) : textParts.join('\n') };
      if (replayReasoning && role === 'assistant' && thinkingParts.length) {
        message.reasoning_content = thinkingParts.join('\n');
      }
      out.push(message);
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
    messages: toOpenAIMessages(body.system, body.messages, {
      replayReasoning: DEEPSEEK_MODEL.test(String(targetModel ?? '')),
    }),
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

// 缓存读写别名的优先级；同一批数据只取第一个合法正整数，不累加。
const CACHE_READ_PATHS = [
  ['input_tokens_details', 'cached_tokens'],
  ['prompt_tokens_details', 'cached_tokens'],
  ['cached_tokens'],
  ['cache_read_tokens'],
  ['cache_read_input_tokens'],
  ['prompt_cache_hit_tokens'],
];
const CACHE_WRITE_PATHS = [
  ['input_tokens_details', 'cache_write_tokens'],
  ['prompt_tokens_details', 'cache_write_tokens'],
  ['input_tokens_details', 'cache_creation_tokens'],
  ['prompt_tokens_details', 'cache_creation_tokens'],
  ['cache_write_tokens'],
  ['cache_creation_input_tokens'],
  ['cache_write_input_tokens'],
  ['cache_creation_tokens'],
];

function readPath(usage, path) {
  let value = usage;
  for (const key of path) {
    if (value == null || typeof value !== 'object') return undefined;
    value = value[key];
  }
  return value;
}

// 零值和非法别名不遮蔽后续正值；没有正值时区分明确零与未上报。
function firstTokenCount(usage, paths) {
  let reportedZero = false;
  for (const path of paths) {
    const raw = readPath(usage, path);
    if (raw == null || !['number', 'string'].includes(typeof raw) || (typeof raw === 'string' && !raw.trim())) continue;
    const n = tokenCount(raw);
    if (n > 0) return { value: n, reported: true };
    if (n === 0 && Number(raw) === 0) reportedZero = true;
  }
  return { value: 0, reported: reportedZero };
}

/**
 * OpenAI usage 换算成 Anthropic 语义。prompt_tokens / input_tokens 是总输入，
 * cached_tokens 是缓存读取；cache_write_tokens 是缓存写入。中转可能使用
 * cache_creation_tokens 等兼容字段，同一批写入只取一个字段，不累加。
 * DeepSeek 的 prompt_cache_miss_tokens 是普通输入，不代表缓存写入。
 * 只有总输入可用时才拆分普通输入；缺总输入时不凭空制造 input_tokens = 0。
 */
export function anthropicUsageFromOpenAI(usage) {
  if (!usage || typeof usage !== 'object') return {};
  const hasPrompt = usage.prompt_tokens != null || usage.input_tokens != null;
  const hasOutput = usage.completion_tokens != null || usage.output_tokens != null;
  const read = firstTokenCount(usage, CACHE_READ_PATHS);
  const write = firstTokenCount(usage, CACHE_WRITE_PATHS);
  if (!hasPrompt && !hasOutput && !read.reported && !write.reported) return {};

  const out = {};
  if (hasPrompt) {
    const prompt = tokenCount(usage.prompt_tokens ?? usage.input_tokens);
    const cached = Math.min(prompt, read.value);
    const written = Math.min(prompt - cached, write.value);
    out.input_tokens = prompt - cached - written;
    // 明确上报（含 0）才输出缓存字段：未上报与上报 0 不能混淆，累计 usage 才能用 0 覆盖旧正值。
    if (read.reported) out.cache_read_input_tokens = cached;
    if (write.reported) out.cache_creation_input_tokens = written;
  } else {
    // 没有总输入就不拆分、不编造 input_tokens；只保留明确上报的合法缓存读写。
    if (read.reported) out.cache_read_input_tokens = read.value;
    if (write.reported) out.cache_creation_input_tokens = write.value;
  }
  if (hasOutput) out.output_tokens = tokenCount(usage.completion_tokens ?? usage.output_tokens);
  return out;
}

// 多段 usage 里需要逐字段浅合并的 details 对象，避免后到的分段整体覆盖丢掉先到的缓存字段。
const USAGE_DETAIL_KEYS = ['input_tokens_details', 'prompt_tokens_details', 'output_tokens_details', 'completion_tokens_details'];

/** 合并同一响应的多段 OpenAI usage：只覆盖非 null/undefined 字段（显式 0 也覆盖），details 逐字段合并。 */
export function mergeOpenAIUsage(prev, next) {
  const merged = { ...(prev ?? {}) };
  if (!next || typeof next !== 'object') return merged;
  for (const [key, value] of Object.entries(next)) {
    if (value == null) continue;
    if (USAGE_DETAIL_KEYS.includes(key) && typeof value === 'object' && !Array.isArray(value)) {
      const base = merged[key];
      const detail = { ...(base && typeof base === 'object' ? base : {}) };
      for (const [field, fieldValue] of Object.entries(value)) if (fieldValue != null) detail[field] = fieldValue;
      merged[key] = detail;
    } else {
      merged[key] = value;
    }
  }
  return merged;
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
  if (resolveClientProfile(provider, options.targetModel, options.clientProfile, incomingHeaders) === 'codex') {
    const context = options.codexContext ?? createRequestProfile(provider, options.targetModel ?? '', options.clientProfile, incomingHeaders).codexContext;
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
  const outgoing = buildOpenAIBody(body, targetModel);
  const res = await upstreamFetch(provider, url, {
    method: 'POST',
    headers: buildOpenAIHeaders(provider, incomingHeaders, { ...options, targetModel }),
    body: JSON.stringify(outgoing),
    signal,
  });
  return res;
}

export function buildResponsesHeaders(provider, incomingHeaders = {}) {
  const headers = forwardEndToEndHeaders(incomingHeaders);
  delete headers.authorization;
  delete headers['x-api-key'];

  const incomingEntries = incomingHeaders instanceof Headers ? [...incomingHeaders] : Object.entries(incomingHeaders);
  const connHeader = incomingEntries.find(([k]) => k.toLowerCase() === 'connection')?.[1];
  const nominated = new Set(String(connHeader ?? '').toLowerCase().split(',').map((s) => s.trim()));

  if (provider.extraHeaders && typeof provider.extraHeaders === 'object') {
    const safeExtras = forwardEndToEndHeaders(provider.extraHeaders);
    for (const [lower, value] of Object.entries(safeExtras)) {
      if (
        nominated.has(lower) ||
        lower === 'authorization' ||
        lower === 'x-api-key' ||
        lower === 'user-agent' ||
        lower === 'originator' ||
        lower === 'x-app' ||
        lower === 'session-id' ||
        lower === 'thread-id' ||
        lower === 'x-request-id' ||
        lower.startsWith('x-client-') ||
        lower.startsWith('x-codex-') ||
        lower.startsWith('x-claude-') ||
        lower.startsWith('x-stainless-')
      ) {
        continue;
      }
      if (!Object.hasOwn(headers, lower)) {
        headers[lower] = value;
      }
    }
  }
  if (provider.apiKey) {
    headers.authorization = 'Bearer ' + provider.apiKey;
  }
  return headers;
}

/** Native OpenAI Responses passthrough; preserve the request except routed model. */
export async function callResponses(provider, body, targetModel, signal, incomingHeaders = {}, options = {}, rawBody) {
  const url = `${provider.baseUrl}/responses`;
  const payload = body.model === targetModel ? rawBody : replaceResponseModel(rawBody, targetModel);
  return upstreamFetch(provider, url, {
    method: 'POST',
    headers: buildResponsesHeaders(provider, incomingHeaders),
    body: payload,
    signal,
  });
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
    // 逐字段合并，保留先前分段里的 prompt_tokens_details.cached_tokens 等缓存字段
    if (j.usage) merged.usage = mergeOpenAIUsage(merged.usage, j.usage);
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
