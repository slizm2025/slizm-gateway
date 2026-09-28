// Anthropic 原生 / Anthropic 兼容中转（如 DeepSeek 的 /anthropic 端点）。
// 这类上游不需要格式转换，只做透传 + 鉴权头替换。
import { upstreamFetch, readResponseText } from '../upstream-fetch.js';
import { redact } from '../config.js';
import { forwardEndToEndHeaders } from './client-headers.js';

// 入站头**全量透传**：上游看到的请求头应与 Claude Code 直连时一致（UA、x-app、anthropic-beta、
// x-stainless-*、x-claude-code-session-id、accept 等都不改），避免中转站因头部差异拒绝或降级。
// 只去掉逐跳头、由 fetch 自行计算的头，以及网关自己的鉴权（换成上游 key）。
export function buildHeaders(provider, incoming = {}) {
  const headers = forwardEndToEndHeaders(incoming);
  const auth = new Headers(incoming);
  delete headers.authorization;
  delete headers['x-api-key'];
  if (provider.apiKey) {
    const style = provider.authStyle === 'auto'
      ? (auth.has('x-api-key') && !auth.has('authorization') ? 'x-api-key' : 'bearer')
      : provider.authStyle;
    if (style === 'x-api-key') headers['x-api-key'] = provider.apiKey;
    else headers.authorization = `Bearer ${provider.apiKey}`;
  }
  return headers;
}

/**
 * 请求上游 /v1/messages。
 * 返回上游的 Response，由调用方决定如何回传。
 */
export async function callMessages(provider, body, incomingHeaders, signal, options = {}, rawBody) {
  const url = `${provider.baseUrl}/v1/messages`;
  const headers = buildHeaders(provider, incomingHeaders);

  const res = await upstreamFetch(provider, url, {
    method: 'POST',
    headers,
    body: rawBody ?? JSON.stringify(body),
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
