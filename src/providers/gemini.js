// Google Gemini 上游。使用 Gemini 的 OpenAI 兼容层
// (/v1beta/openai/chat/completions)，复用 openai.js 的转换逻辑，
// 避免依赖 @google/genai 包。
import { upstreamFetch, readResponseText } from '../upstream-fetch.js';
import {
  buildOpenAIBody,
  toAnthropicResponse,
  buildOpenAIHeaders,
} from './openai.js';

export function normalizeBaseUrl(baseUrl) {
  // 用户可能填 https://generativelanguage.googleapis.com
  // 或带 /v1beta。统一补成 OpenAI 兼容路径的根。
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (/\/v1beta\/openai$/.test(trimmed)) return trimmed;
  if (/\/v1beta$/.test(trimmed)) return `${trimmed}/openai`;
  return `${trimmed}/v1beta/openai`;
}

export async function callOpenAI(provider, body, targetModel, signal, incomingHeaders = {}, options = {}) {
  const url = `${normalizeBaseUrl(provider.baseUrl)}/chat/completions`;
  const res = await upstreamFetch(provider, url, {
    method: 'POST',
    headers: buildOpenAIHeaders(provider, incomingHeaders, { ...options, targetModel }),
    body: JSON.stringify(buildOpenAIBody(body, targetModel)),
    signal,
  });
  return res;
}

export async function listOpenAIModels(provider) {
  try {
    const res = await upstreamFetch(provider, `${normalizeBaseUrl(provider.baseUrl)}/models`, {
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

export { toAnthropicResponse };
export { parseCompletion } from './openai.js';
