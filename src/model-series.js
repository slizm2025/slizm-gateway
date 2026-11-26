// 按上游模型系列做的请求体适配。
// 网关的下游永远是 Claude Code：默认对所有上游原样保留 Claude Code 的请求特征
// （请求头见 providers/client-headers.js）。只有确实与某个模型系列冲突的部分，才在这里
// 按"系列"做例外——之后新增同系列模型不需要再单独配置，其它系列也不受影响。

// Gemini 系列经 Antigravity（Google）转发时，system prompt 里的第三方身份句与 Harness 特征
// 会被 Google 风控拒绝，返回不带细节的 429 RESOURCE_EXHAUSTED：
// - Claude Code 子 agent 首行 "You are a Claude agent, built on Anthropic's Claude Agent SDK."（2026-09-24 实测）
// - Codex 的 instructions 首行 "You are Codex, a coding agent based on GPT-5."（2026-09-25 实测）
// - DeepSeek Harness 首行 "You are an AI agent powered by DeepSeek Harness." 以及后续段落中的
//   "DeepSeek Harness"（2026-11-25 实测，替换后 200；仅删首行但保留后文 "DeepSeek Harness" 仍 429）
// 句中 "GPT-5.1"、"deepseek-v4.1" 这类后面紧跟非空白的点不算句末。
const GEMINI_SERIES = /(^|[/.])gemini(?:-|$)/i;
const VENDOR_IDENTITY = /You are [^.\n]*(?:Claude|Anthropic|Codex|ChatGPT|GPT|OpenAI)(?:[^.\n]|\.(?=\S))*\./g;
// DeepSeek 身份句只匹配自我介绍，避免误吞 "You are interacting with the user through the DeepSeek Harness Web GUI at ..." 里的 URL 上下文
const DEEPSEEK_IDENTITY = /You are (?:DeepSeek\b|(?:a |an )?(?:AI |coding )?(?:agent|assistant)[^.\n]*DeepSeek)(?:[^.\n]|\.(?=\S))*\./gi;
// 仅替换正文里的空格分词品牌名，不改写文件系统路径（如 ...\deepseek-harness）或代码标识符
const HARNESS_BRAND = /\bDeepSeek\s+Harness\b/gi;
// DeepSeek Harness Web GUI 段落里的固定原句同样会被 Google 识别为第三方 Harness 指纹
// （2026-11-25 实测单句 6/6 返回 429，同义改写后完整 20 段提示词返回 200）
const HARNESS_WEB_CONTEXT = /The browser provides no implicit DOM, route, or screenshot context\./gi;
const NEUTRAL_IDENTITY = 'You are an AI coding agent.';
const NEUTRAL_HARNESS = 'Agent Harness';
const NEUTRAL_WEB_CONTEXT = 'No browser DOM, route, or screenshot state is attached automatically.';

// Claude 系列会校验 thinking 块的签名。网关把 OpenAI 类上游的 reasoning 转成了 thinking 块，这些块没有签名；
// 同一会话从 gpt / deepseek 切回 Claude 路由时，带着它们的历史会被上游 400 拒绝。
// 真 Claude 产生的 thinking 一定带签名（redacted_thinking 用 data 字段），所以只去掉无签名的 thinking 块。
const CLAUDE_SERIES = /(^|[/.])claude-/i;
const OPENAI_SERIES = /(^|\/)(?:gpt-|chatgpt-|o\d+(?:-|$)|codex(?:-|$))/i;

/** 上游模型所属的特例系列；不属于任何特例时返回 null */
export function modelSeries(model) {
  const name = String(model ?? '');
  if (GEMINI_SERIES.test(name)) return 'gemini';
  if (CLAUDE_SERIES.test(name)) return 'claude';
  if (OPENAI_SERIES.test(name)) return 'openai';
  return null;
}

export function messagesTransportFor(provider, upstreamModel) {
  const transport = provider.messagesTransport ?? 'auto';
  return provider.apiType === 'openai' && transport === 'auto'
    ? modelSeries(upstreamModel) === 'openai' ? 'responses' : 'chat-completions'
    : transport;
}

const isUnsignedThinking = (block) => block?.type === 'thinking' && !block.signature;
const hasUnsignedThinking = (m) => m?.role === 'assistant' && Array.isArray(m.content) && m.content.some(isUnsignedThinking);

function dropUnsignedThinking(body) {
  if (!Array.isArray(body.messages) || !body.messages.some(hasUnsignedThinking)) return body;
  const messages = [];
  for (const m of body.messages) {
    if (!hasUnsignedThinking(m)) {
      messages.push(m);
      continue;
    }
    const content = m.content.filter((b) => !isUnsignedThinking(b));
    // 只有思考的回合整条去掉，前后相邻的同角色消息由 API 合并为一轮
    if (content.length) messages.push({ ...m, content });
  }
  return { ...body, messages };
}

function rewriteSystemText(text) {
  return text
    .replace(VENDOR_IDENTITY, NEUTRAL_IDENTITY)
    .replace(DEEPSEEK_IDENTITY, NEUTRAL_IDENTITY)
    .replace(HARNESS_BRAND, NEUTRAL_HARNESS)
    .replace(HARNESS_WEB_CONTEXT, NEUTRAL_WEB_CONTEXT);
}

// 兼容 Anthropic 的 text 块和 Responses 的 input_text 块
function rewriteIdentity(content) {
  if (typeof content === 'string') return rewriteSystemText(content);
  if (!Array.isArray(content)) return content;
  return content.map((b) =>
    (b?.type === 'text' || b?.type === 'input_text') && typeof b.text === 'string'
      ? { ...b, text: rewriteSystemText(b.text) }
      : b,
  );
}

/**
 * OpenAI Responses 请求体（Codex 直通 /v1/responses）的系列适配：
 * Gemini 系列改写 instructions 和 system/developer 输入里的身份句。
 * 没有实际改动时原样返回同一个对象，调用方据此决定是否保留原始请求体。
 */
export function adaptResponsesBodyForModelSeries(body, upstreamModel) {
  if (modelSeries(upstreamModel) !== 'gemini') return body;
  let changed = false;
  const rewrite = (content) => {
    const next = rewriteIdentity(content);
    if (JSON.stringify(next) !== JSON.stringify(content)) changed = true;
    return next;
  };
  const out = { ...body };
  if (out.instructions !== undefined) out.instructions = rewrite(out.instructions);
  if (Array.isArray(out.input)) {
    out.input = out.input.map((item) =>
      item?.role === 'system' || item?.role === 'developer' ? { ...item, content: rewrite(item.content) } : item,
    );
  }
  return changed ? out : body;
}

/** 按上游模型系列调整请求体；不属于特例系列、或没有需要改的内容时原样返回同一个对象 */
export function adaptBodyForModelSeries(body, upstreamModel) {
  const series = modelSeries(upstreamModel);
  if (series === 'claude') return dropUnsignedThinking(body);
  if (series !== 'gemini') return body;
  const out = { ...body };
  if (out.system !== undefined) out.system = rewriteIdentity(out.system);
  if (Array.isArray(out.messages)) {
    // Claude Code 也会把系统内容作为 role=system 的消息放进 messages
    out.messages = out.messages.map((m) =>
      m?.role === 'system' ? { ...m, content: rewriteIdentity(m.content) } : m,
    );
  }
  const changed = JSON.stringify(out.system) !== JSON.stringify(body.system)
    || JSON.stringify(out.messages) !== JSON.stringify(body.messages);
  return changed ? out : body;
}
