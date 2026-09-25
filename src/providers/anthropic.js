// Anthropic 原生 / Anthropic 兼容中转（如 DeepSeek 的 /anthropic 端点）。
// 这类上游不需要格式转换，只做透传 + 鉴权头替换。
import { upstreamFetch, readResponseText } from '../upstream-fetch.js';
import { redact } from '../config.js';
import { forwardEndToEndHeaders, resolveClientProfile, createCodexContext, buildCodexHeaders, withExtraHeaders } from './client-headers.js';

// 入站头**全量透传**：上游看到的请求头应与 Claude Code 直连时一致（UA、x-app、anthropic-beta、
// x-stainless-*、x-claude-code-session-id、accept 等都不改），避免中转站因头部差异拒绝或降级。
// 只去掉逐跳头、由 fetch 自行计算的头，以及网关自己的鉴权（换成上游 key）。
export function buildHeaders(provider, incoming = {}, options = {}) {
  const codex = resolveClientProfile(provider, options.targetModel, options.clientProfile) === 'codex';
  const headers = codex
    ? buildCodexHeaders({ ...provider, extraHeaders: {} }, options.codexContext ?? createCodexContext(options.targetModel ?? '', provider.codexReasoningEffort))
    : forwardEndToEndHeaders(incoming);
  if (!headers['content-type']) headers['content-type'] = 'application/json';
  if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01';

  // 鉴权：auto 时沿用 Claude Code 自己用的那种形式（ANTHROPIC_AUTH_TOKEN → Bearer，ANTHROPIC_API_KEY → x-api-key），
  // 与直连时一致；显式 bearer / x-api-key 时按配置。
  let style = provider.authStyle;
  if (style !== 'bearer' && style !== 'x-api-key') {
    const auth = new Headers(incoming);
    style = !codex && auth.has('x-api-key') && !auth.has('authorization') ? 'x-api-key' : 'bearer';
  }
  delete headers.authorization;
  if (provider.apiKey) {
    if (style === 'bearer') headers.authorization = `Bearer ${provider.apiKey}`;
    else headers['x-api-key'] = provider.apiKey;
  }
  return withExtraHeaders(headers, provider.extraHeaders);
}

/** 生成官方 CLI 形态的 user_id：user_<hash>_account_<uuid>_session_<uuid> */
function makeUserId() {
  const h = () => Math.random().toString(16).slice(2, 18);
  const uuid = () =>
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  return `user_${h()}${h()}_account_${uuid()}_session_${uuid()}`;
}

/**
 * 补齐"仅限官方 Claude Code"渠道要求的身份信息。
 * 这类中转站在网关层校验：User-Agent 必须是 claude-cli/*，且 body.metadata.user_id 必须存在。
 * 少了任何一项都会直接 403 claude_code_required。
 */
export function normalizeClaudeCodeBody(body) {
  const out = { ...body };
  const meta = { ...(out.metadata ?? {}) };
  if (!meta.user_id) meta.user_id = makeUserId();
  out.metadata = meta;
  return out;
}

/**
 * 请求上游 /v1/messages。
 * 返回上游的 Response，由调用方决定如何回传。
 */
export async function callMessages(provider, body, incomingHeaders, signal, options = {}) {
  const url = `${provider.baseUrl}/v1/messages`;
  const headers = buildHeaders(provider, incomingHeaders, { ...options, targetModel: body.model });
  // accept 保持 Claude Code 原值（与直连一致）；个别站点确需 SSE accept 时在 provider 上开 forceStreamAccept
  if (body.stream && provider.forceStreamAccept) headers.accept = 'text/event-stream';
  const payload = normalizeClaudeCodeBody(body);

  const res = await upstreamFetch(provider, url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal,
  });
  return res;
}

/** 列出上游模型，用于 /v1/models 聚合 */
export async function listModels(provider) {
  try {
    const res = await upstreamFetch(provider, `${provider.baseUrl}/v1/models`, {
      headers: buildHeaders(provider),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) { await res.body?.cancel(); return []; }
    const json = JSON.parse(await readResponseText(res, 4 * 1024 * 1024));
    return (json.data ?? []).map((m) => m.id).filter(Boolean);
  } catch (e) {
    console.error(`  [${provider.name}] 模型列表获取失败: ${redact(e.message)}`);
    return [];
  }
}
