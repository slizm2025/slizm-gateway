// 按上游模型系列做的请求体适配。
// 网关的下游永远是 Claude Code：默认对所有上游原样保留 Claude Code 的请求特征
// （请求头见 providers/client-headers.js）。只有确实与某个模型系列冲突的部分，才在这里
// 按"系列"做例外——之后新增同系列模型不需要再单独配置，其它系列也不受影响。

// Gemini 系列经 Antigravity（Google）转发时，system prompt 里的 Claude 身份句
// （例如子 agent 首行 "You are a Claude agent, built on Anthropic's Claude Agent SDK."）
// 会被 Google 拒绝，返回不带细节的 429 RESOURCE_EXHAUSTED（2026-09-24 实测，改写后 200）。
const GEMINI_SERIES = /(^|\/)gemini-/i;
const CLAUDE_IDENTITY = /You are [^.\n]*(?:Claude|Anthropic)[^.\n]*\./g;
const NEUTRAL_IDENTITY = 'You are an AI coding agent.';

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

function rewriteIdentity(content) {
  if (typeof content === 'string') return content.replace(CLAUDE_IDENTITY, NEUTRAL_IDENTITY);
  if (!Array.isArray(content)) return content;
  return content.map((b) =>
    b?.type === 'text' && typeof b.text === 'string'
      ? { ...b, text: b.text.replace(CLAUDE_IDENTITY, NEUTRAL_IDENTITY) }
      : b,
  );
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
  return out;
}
