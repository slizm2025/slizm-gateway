// Local Anthropic Messages gateway with provider routing and safe retries.
import http from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig, redact, missingSecretRefs, ROOT, env } from './config.js';
import { upstreamFetch, readResponseText } from './upstream-fetch.js';
import * as anthropic from './providers/anthropic.js';
import * as openai from './providers/openai.js';
import * as gemini from './providers/gemini.js';
import * as responses from './providers/responses.js';
import * as messagesResponses from './providers/messages-to-responses.js';
import { openAIToAnthropicStream, anthropicJsonToStream, convertJsonResponse, SSE_HEADERS } from './stream.js';
import { withUpstream, gateStats, configureProviderLimits, networkErrorCode, isSafeToRetryNetworkError, isRetryableStatus } from './limiter.js';
import { modelSeries, adaptBodyForModelSeries, adaptResponsesBodyForModelSeries } from './model-series.js';
import { createRequestProfile, forwardEndToEndHeaders } from './providers/client-headers.js';
import { replaceResponseModel } from './providers/response-body.js';
import { createSseDecoder } from './sse.js';
import { createRuntimePricing, publishPricingControl } from './runtime-pricing.js';
import { beginUsage, finishUsage, recordStreamUsage, estimateInputTokens, usageStats, summarizeError } from './usage.js';

const configPath = resolve(env('GATEWAY_CONFIG', join(ROOT, 'providers.json')));
const initialContent = readFileSync(configPath, 'utf8');
let cfg = loadConfig({ raw: JSON.parse(initialContent) });
configureProviderLimits(cfg.providers);
const configContext = new AsyncLocalStorage();
const currentConfig = () => configContext.getStore()?.config ?? cfg;
const capturePricing = (provider, model) => (configContext.getStore()?.capturePricing ?? runtimePricing.capture)(provider, model);
const runtimePricing = createRuntimePricing({ configPath, initialContent,
  prepareConfig: (raw) => {
    const next = loadConfig({ raw });
    return () => {
      configureProviderLimits(next.providers);
      cfg = next;
    };
  },
  onError: (error) => print(null, `配置热更新失败，保留原配置: ${redact(error.message)}`, console.error) });
const pricingControlToken = randomBytes(32).toString('hex');
let stopPricingWatch;
let removePricingControl;
const startedAt = Date.now();
const instanceId = randomUUID();
// Restart protection spans HTTP handling, including uploads and token counting.
let activeHttpRequests = 0;

function resolveRoute(requestedModel) {
  const cfg = currentConfig();
  const direct = cfg.routes.get(requestedModel);
  if (direct) {
    const provider = cfg.providers.get(direct.provider);
    return { alias: requestedModel, provider, targetModel: direct.model ?? requestedModel, clientProfile: direct.clientProfile ?? provider?.clientProfile };
  }
  for (const provider of cfg.providers.values()) {
    if (Object.hasOwn(provider.models, requestedModel)) return { alias: requestedModel, provider, targetModel: provider.models[requestedModel], clientProfile: provider.clientProfile };
  }
  const provider = cfg.providers.get(cfg.defaultRoute);
  return { alias: requestedModel, provider, targetModel: requestedModel, clientProfile: provider?.clientProfile };
}
function targetFor(route) {
  return Object.hasOwn(route.provider.models, route.targetModel) ? route.provider.models[route.targetModel] : route.targetModel;
}
function json(res, status, obj, headers = {}) {
  if (res.headersSent || res.writableEnded || res.destroyed) {
    if (!res.writableEnded) res.destroy();
    return;
  }
  const body = JSON.stringify(obj);
  const requestHeader = res.requestId ? { 'x-request-id': res.requestId } : {};
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), ...requestHeader, ...headers });
  res.end(body);
}
function errorResponse(res, status, message, type = 'api_error', headers) {
  json(res, status, { type: 'error', error: { type, message: redact(String(message)) } }, headers);
}
const pad = (n, width = 2) => String(n).padStart(width, '0');
/** 本地时间（用户在 UTC+8），到毫秒：2026-09-25 05:04:03.128 */
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
function fmtMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m${pad(s % 60)}s`;
}
const fmtCount = (n) => {
  if (n < 1000) return String(n);
  const [unit, size] = n >= 999_500_000 ? ['B', 1e9] : n >= 999_500 ? ['M', 1e6] : ['K', 1e3];
  const value = n / size;
  return `${Number(value.toFixed(value < 10 ? 2 : value < 100 ? 1 : 0))}${unit}`;
};
const fmtBytes = (b) => (b < 1024 ? `${b}B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)}KB` : `${(b / 1024 / 1024).toFixed(1)}MB`);
function fmtUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '未配置';
  return '$' + n.toFixed(6);
}
/** 上游上报的用量 → "输入 3 · 缓存读 185.2K · 输出 1.2K"，缓存为 0 时省略 */
function usageText(item) {
  const parts = [`输入 ${fmtCount(item.inputTokens)}`];
  if (item.cacheReadTokens) parts.push(`缓存读 ${fmtCount(item.cacheReadTokens)}`);
  if (item.cacheWriteTokens) parts.push(`缓存写 ${fmtCount(item.cacheWriteTokens)}`);
  parts.push(`输出 ${fmtCount(item.outputTokens)}`);
  return parts.join(' · ');
}
function costText(item) {
  if (item?.costUsd === null || item?.costUsd === undefined) return '费用 未配置';
  const m = item.priceMultiplier;
  if (!m) return `费用 ${fmtUsd(item.costUsd)}`;
  const rates = [['输入', m.input], ['缓存读', m.cacheRead], ['缓存写', m.cacheWrite], ['输出', m.output]].map(([k, v]) => `${k}×${v ?? 1}`).join(' ');
  return `费用 ${fmtUsd(item.costUsd)}（原价 ${fmtUsd(item.baseCostUsd)} · ${rates}）`;
}
/** 一条日志只占一行：[本地时间] [请求 ID] 内容。内容脱敏，换行折叠成空格 */
function print(requestId, message, write = console.log) {
  write(`[${stamp()}]${requestId ? ` [${requestId}]` : ''} ${redact(String(message)).replace(/\s*[\r\n]+\s*/g, ' ')}`);
}
function log(requestId, message) {
  if (currentConfig().server.logRequests) print(requestId, message);
}
const CLIENT_BADGES = Object.freeze({
  codex: '◖⚆ᴥ⚆◗',
  'claude-code': '▗[•.•]▖',
  'deepseek-harness': '~(·)><',
  deepseek: '~(·)><',
  gemini: '▼(ᴥ)▼',
  unknown: '·?·',
});
function clientTag(clientType) {
  return CLIENT_BADGES[clientType] ?? CLIENT_BADGES.unknown;
}
/** Keep the status symbol and route in their legacy positions for gw.js parsing. */
function requestLog(requestId, clientType, message) {
  const text = String(message);
  const event = /^([→←✗⚠↻⊘]) (\S+)/.exec(text);
  if (!event) return log(requestId, `${clientTag(clientType)} ${text}`);
  const rest = text.slice(event[0].length);
  const split = rest.search(/ (?=@|·)/);
  if (split >= 0) {
    return log(requestId, `${event[1]} ${event[2]}${rest.slice(0, split)} ${clientTag(clientType)}${rest.slice(split)}`);
  }
  return log(requestId, `${event[1]} ${event[2]}${rest} ${clientTag(clientType)}`);
}
function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true; chunks = [];
        reject(Object.assign(new Error(`请求体超过 ${limit} 字节上限`), { status: 413 }));
      } else chunks.push(chunk);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('客户端取消请求体上传')));
  });
}
function validBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (typeof body.model !== 'string' || !body.model.trim()) return false;
  if (!Array.isArray(body.messages) || !body.messages.length) return false;
  if (body.stream !== undefined && typeof body.stream !== 'boolean') return false;
  if (body.max_tokens !== undefined && (!Number.isInteger(body.max_tokens) || body.max_tokens <= 0)) return false;
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some((t) => !t || typeof t !== 'object'))) return false;
  return body.messages.every((m) => m && ['user', 'assistant', 'system'].includes(m.role) && (typeof m.content === 'string' || (Array.isArray(m.content) && m.content.every((b) => b && typeof b === 'object' && !Array.isArray(b)))));
}
function checkClientAuth(req) {
  const expected = Buffer.from(currentConfig().server.clientToken);
  const auth = req.headers.authorization ?? '';
  const candidates = [auth.startsWith('Bearer ') ? auth.slice(7) : '', req.headers['x-api-key'] ?? ''];
  return candidates.some((value) => { const b = Buffer.from(String(value)); return b.length === expected.length && timingSafeEqual(b, expected); });
}
function requestContext(res, timeoutMs) {
  const client = new AbortController();
  const deadline = new AbortController();
  const onClose = () => { if (!res.writableFinished) client.abort(); };
  res.once('close', onClose);
  if (res.destroyed) client.abort();
  const timer = setTimeout(() => deadline.abort(new DOMException('上游请求超时', 'TimeoutError')), timeoutMs);
  timer.unref();
  return { client, signal: AbortSignal.any([client.signal, deadline.signal]), dispose() { clearTimeout(timer); res.off('close', onClose); } };
}
/** 扫描透传的 Anthropic SSE：记 usage，并记下流里的 error 事件、是否正常收尾（message_stop） */
function createSseMonitor(onUsage) {
  const state = { stopped: false, error: null };
  let failed = false;
  const decoder = createSseDecoder((data) => {
    const payload = JSON.parse(data);
    if (payload.type === 'message_stop') state.stopped = true;
    else if (payload.type === 'error') state.error = payload.error ?? {};
    const u = payload.usage ?? payload.message?.usage;
    if (u) onUsage(u);
  });
  const inspect = (fn) => {
    if (failed) return;
    try { fn(); } catch {
      failed = true;
      state.error = { type: 'api_error', message: '上游 SSE 事件不完整或格式错误' };
    }
  };
  state.push = (chunk) => inspect(() => decoder.push(chunk));
  state.end = () => inspect(() => decoder.end());
  return state;
}

// Observe usage without rewriting or delaying any upstream response bytes.
// terminal：SSE 里已出现终止事件（completed / incomplete / failed / error），此后响应对客户端已完整。
function createResponsesMonitor(contentType, onUsage) {
  let failed = false;
  let size = 0;
  const chunks = [];
  const state = { error: null, terminal: false };
  const inspect = (payload) => {
    const response = payload.response ?? payload;
    if (response.usage) onUsage(openai.anthropicUsageFromOpenAI(response.usage));
    if (payload.type === 'error' || payload.type === 'response.failed' || response.status === 'failed') state.error = 'Upstream Responses failure';
  };
  const decoder = contentType.includes('event-stream') ? createSseDecoder((data) => {
    if (data === '[DONE]') return;
    const payload = JSON.parse(data);
    if (['response.completed', 'response.incomplete', 'response.failed', 'error'].includes(payload.type)) state.terminal = true;
    inspect(payload);
  }) : null;
  state.push = (chunk) => {
    if (failed) return;
    try {
      if (decoder) decoder.push(chunk);
      else {
        size += chunk.byteLength;
        if (size > 4 * 1024 * 1024) { chunks.length = 0; failed = true; }
        else chunks.push(chunk);
      }
    } catch {
      failed = true;
      if (decoder) state.error = 'Upstream Responses stream contains an invalid or oversized event';
    }
  };
  state.end = () => {
    if (failed) return;
    try {
      if (decoder) decoder.end();
      else if (size) inspect(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch {
      if (decoder) state.error = 'Upstream Responses stream ended with an incomplete event';
    }
    if (decoder && !state.terminal) state.error ??= 'Upstream Responses stream ended without a terminal event';
  };
  return state;
}

async function relayBody(body, res, signal, onChunk, shouldStop) {
  if (!body) throw new Error('上游缺少响应体');
  const reader = body.getReader();
  let bytes = 0;
  try {
    // Forward accepted headers without waiting for the first upstream body chunk.
    res.flushHeaders();
    while (true) {
      signal.throwIfAborted();
      if (res.destroyed) throw new DOMException('客户端已断开', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      const writable = res.write(value);
      try { onChunk?.(value); } catch { /* 统计出错不能影响转发 */ }
      // Anthropic/Responses streams have an explicit terminal event. Some relays
      // keep the HTTP connection open after sending it, so do not wait for EOF.
      if (shouldStop?.()) {
        await reader.cancel().catch(() => {});
        if (!res.writableEnded && !res.destroyed) res.end();
        return bytes;
      }
      if (!writable) {
        await new Promise((resolve, reject) => {
          const cleanup = () => { res.off('drain', onDrain); res.off('close', onClose); res.off('error', onError); signal.removeEventListener('abort', onAbort); };
          const onDrain = () => { cleanup(); resolve(); };
          const onError = (e) => { cleanup(); reject(e); };
          const onClose = () => onError(new DOMException('客户端已断开', 'AbortError'));
          const onAbort = () => onError(signal.reason);
          res.once('drain', onDrain); res.once('close', onClose); res.once('error', onError); signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort(); else if (res.destroyed) onClose();
        });
      }
    }
    res.end();
    return bytes;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
// Bound the observation copy; the relay always writes the original chunk.
function createBodySample(maxBytes) {
  const chunks = [];
  let size = 0;
  let truncated = false;
  return {
    push(chunk) {
      const remaining = maxBytes - size;
      if (chunk.byteLength > remaining) truncated = true;
      if (remaining <= 0) return;
      const copy = Buffer.from(chunk.subarray(0, remaining));
      chunks.push(copy);
      size += copy.byteLength;
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
    get truncated() { return truncated; },
  };
}

async function handleMessages(req, res, body, requestId, rawBody) {
  const route = resolveRoute(body.model);
  if (!route.provider) return errorResponse(res, 404, `模型 ${body.model} 没有匹配的 provider`, 'not_found_error');
  const { provider } = route;
  if (provider.requireKey !== false && !provider.apiKey) return errorResponse(res, 503, `provider ${provider.name} 的密钥未配置，请填入密钥后重启网关`, 'authentication_error', { 'x-should-retry': 'false' });
  const upstreamModel = targetFor(route);
  const profile = createRequestProfile(provider, upstreamModel, route.clientProfile, req.headers);
  const responsesTransport = provider.apiType === 'openai' && provider.messagesTransport === 'responses';
  if (responsesTransport) {
    try { messagesResponses.buildResponsesBody(body, upstreamModel); }
    catch (error) { return errorResponse(res, 400, error.message, 'invalid_request_error'); }
  }
  const upstreamProtocol = provider.apiType === 'anthropic' ? 'messages' : responsesTransport ? 'responses' : 'chat-completions';
  const protocolAdapter = upstreamProtocol === 'messages' ? 'direct' : 'messages-to-' + upstreamProtocol;
  const usage = beginUsage({ requestId, route: route.alias, provider: provider.name, model: upstreamModel, clientType: profile.clientType, inputProtocol: 'messages', upstreamProtocol, adapter: protocolAdapter, ...capturePricing(provider.name, upstreamModel), estimatedInputTokens: estimateInputTokens(body) });
  const requested = { ...body, model: upstreamModel };
  const outgoing = provider.apiType === 'anthropic' && modelSeries(upstreamModel) !== 'gemini'
    ? requested
    : adaptBodyForModelSeries(requested, upstreamModel);
  // Gemini identity adaptation is the explicit exception to native passthrough.
  const directRaw = provider.apiType === 'anthropic' && outgoing === requested
    ? (body.model === upstreamModel ? rawBody : replaceResponseModel(rawBody, upstreamModel))
    : undefined;
  const t0 = Date.now();
  const ctx = requestContext(res, provider.requestTimeoutMs);
  const target = route.alias === upstreamModel ? route.alias : `${route.alias} ⇒ ${upstreamModel}`;
  const adapted = outgoing === requested ? '' : ` · [${modelSeries(upstreamModel)} 适配]`;
  const transport = provider.apiType === 'anthropic' && outgoing === requested ? 'direct' : 'adapter';
  const mode = `${transport}${adapted}`;
  requestLog(requestId, profile.clientType, `→ messages ${target} @${provider.name} · ${transport} · ${body.stream ? '流式' : '非流式'} · 输入≈${fmtCount(usage.estimatedInputTokens)}${adapted}`);
  let acquired;
  let attemptStarted;
  let headersMs; // 从收到请求到上游响应头到达，含排队和重试
  // 每个请求结束时只写一行：← 成功、⚠ 流没有正常收尾、✗ 失败
  const finish = ({ status, mark = '←', label = String(status), usageStatus = status, reported, error, extra, ttfb = body.stream }) => {
    const item = finishUsage(usage, { status: usageStatus, usage: reported, error });
    const total = Date.now() - t0;
    const parts = [label, ttfb && headersMs !== undefined ? `首字节 ${fmtMs(headersMs)} · 共 ${fmtMs(total)}` : fmtMs(total)];
    if (extra) parts.push(extra);
    if (error) parts.push(summarizeError(error));
    if (item?.usageSource === 'reported') parts.push(usageText(item), costText(item));
    else if (mark === '←') parts.push(`用量未上报（估算输入 ${fmtCount(usage.estimatedInputTokens)}）`);
    requestLog(requestId, profile.clientType, `${mark} messages ${target} · ${mode} · ${parts.join(' · ')}`);
  };
  try {
    const adapter = provider.apiType === 'gemini' ? gemini : responsesTransport ? messagesResponses : openai;
    acquired = await withUpstream(provider, () => {
      attemptStarted = performance.now();
      return provider.apiType === 'anthropic'
        ? anthropic.callMessages(provider, outgoing, req.headers, ctx.signal, profile, directRaw)
        : adapter.callOpenAI(provider, outgoing, upstreamModel, ctx.signal, req.headers, profile);
    }, {
      signal: ctx.signal,
      onRetry: (attempt, why, ms) => requestLog(requestId, profile.clientType, `↻ messages ${target} · ${mode} · ${fmtMs(ms)} 后第 ${attempt} 次重试 · ${why}`),
    });
    headersMs = Date.now() - t0;
    const upstream = acquired.res;
    if (!upstream.ok && provider.apiType === 'anthropic') {
      const sample = createBodySample(64 * 1024);
      const headers = forwardEndToEndHeaders(upstream.headers);
      // Preserve the existing protection against replay after uncertain delivery.
      if (!isRetryableStatus(upstream.status) && upstream.status >= 500) headers['x-should-retry'] = 'false';
      res.writeHead(upstream.status, headers);
      const bytes = upstream.body
        ? await relayBody(upstream.body, res, ctx.signal, sample.push)
        : (res.end(), 0);
      finish({ status: upstream.status, mark: '✗', label: `上游 ${upstream.status}`, error: summarizeError(sample.text(), 800), extra: fmtBytes(bytes), ttfb: false });
      return;
    }
    if (!upstream.ok) {
      const rawText = await readResponseText(upstream, 64 * 1024, true);
      const text = redact(rawText);
      finish({ status: upstream.status, mark: '✗', label: `上游 ${upstream.status}`, error: text, ttfb: false });
      const headers = {};
      for (const key of ['retry-after', 'request-id', 'x-request-id']) { const value = upstream.headers.get(key); if (value) headers[key] = value; }
      if (upstream.headers.get('x-should-retry') === 'false' || (!isRetryableStatus(upstream.status) && upstream.status >= 500)) headers['x-should-retry'] = 'false';
      // HTML 错误页（如 Cloudflare 502）只转述标题，不把整页 HTML 塞给 Claude Code
      return errorResponse(res, upstream.status, `上游 ${provider.name} 返回 ${upstream.status}: ${summarizeError(text, 800)}`, 'api_error', headers);
    }
    const contentType = upstream.headers.get('content-type') ?? 'application/json';
    if (provider.apiType === 'anthropic') {
      const responseHeaders = forwardEndToEndHeaders(upstream.headers);
      res.writeHead(upstream.status, responseHeaders);
      if (contentType.includes('event-stream')) {
        const monitor = createSseMonitor((u) => recordStreamUsage(usage, u));
        const bytes = upstream.body
          ? await relayBody(upstream.body, res, ctx.signal, monitor.push, () => monitor.stopped || monitor.error)
          : (res.end(), 0);
        monitor.end();
        if (monitor.error) finish({ status: upstream.status, mark: '✗', label: `${upstream.status} 流内错误`, usageStatus: 502, error: `${monitor.error.type ?? 'error'}: ${monitor.error.message ?? ''}`, extra: fmtBytes(bytes) });
        else if (!monitor.stopped) finish({ status: upstream.status, mark: '⚠', label: `${upstream.status} 流未收尾`, usageStatus: 502, error: '上游没发 message_stop 就结束了', extra: fmtBytes(bytes) });
        else finish({ status: upstream.status, extra: fmtBytes(bytes) });
      } else {
        let parsedUsage;
        const sample = createBodySample(4 * 1024 * 1024);
        const bytes = upstream.body
          ? await relayBody(upstream.body, res, ctx.signal, sample.push)
          : (res.end(), 0);
        try { if (!sample.truncated) parsedUsage = JSON.parse(sample.text())?.usage; } catch { /* Usage observation must not affect passthrough. */ }
        finish({ status: upstream.status, reported: parsedUsage, extra: fmtBytes(bytes) });
      }
    } else if (body.stream) {
      let stream;
      let streamError;
      if (contentType.includes('event-stream')) {
        stream = openAIToAnthropicStream(responsesTransport ? messagesResponses.toChatStream(upstream.body) : upstream.body, route.alias, {
          onError: (error) => { streamError = error; },
          onUsage: (u) => recordStreamUsage(usage, u),
        });
      } else {
        const converted = await convertJsonResponse(upstream, route.alias, adapter);
        recordStreamUsage(usage, converted.usage);
        stream = anthropicJsonToStream(converted);
      }
      res.writeHead(200, { ...SSE_HEADERS, 'x-request-id': requestId });
      const bytes = await relayBody(stream, res, ctx.signal);
      // 转换器把上游中途的失败变成 SSE error 事件发给客户端；响应头已是 200，这里按失败记账
      if (streamError) finish({ status: 200, mark: '✗', label: '200 流内错误', usageStatus: 502, error: streamError.message, extra: fmtBytes(bytes) });
      else finish({ status: 200, extra: fmtBytes(bytes) });
    } else {
      const converted = await convertJsonResponse(upstream, route.alias, adapter);
      // Required wire fields are placeholders only; the ledger retains unreported usage.
      json(res, 200, { ...converted, usage: { input_tokens: 0, output_tokens: 0, ...converted.usage } });
      finish({ status: 200, reported: converted.usage });
    }
  } catch (e) {
    if (ctx.client.signal.aborted) {
      const item = finishUsage(usage, { status: 499, error: '客户端断开' });
      requestLog(requestId, profile.clientType, `⊘ messages ${target} · ${mode} · 客户端已断开，已取消上游 · ${fmtMs(Date.now() - t0)}${item?.usageSource === 'reported' ? ` · ${usageText(item)} · ${costText(item)}` : ''}`);
      return;
    }
    const code = networkErrorCode(e);
    const deadlineExpired = ctx.signal.aborted && ctx.signal.reason?.name === 'TimeoutError';
    const failure = deadlineExpired ? ctx.signal.reason : e;
    const phase = e.upstreamPhase ?? (acquired ? 'response-body' : 'unknown');
    const elapsedMs = e.upstreamElapsedMs ?? (acquired && Number.isFinite(attemptStarted) ? Math.round(performance.now() - attemptStarted) : undefined);
    const transport = e.upstreamTransport ?? (acquired ? (provider.proxy ? 'proxy' : 'direct') : undefined);
    const detail = `${failure.message}${code ? ` (${code})` : ''} [${phase}]${Number.isFinite(elapsedMs) ? ` ${elapsedMs}ms` : ''}${transport ? ` via ${transport}` : ''}`;
    const timeout = deadlineExpired || e.name === 'TimeoutError' || e.name === 'AbortError' || ['GATEWAY_CONNECT_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code);
    finish({ status: timeout ? 504 : 502, mark: '✗', label: timeout ? '504 上游超时' : '502 网关转发失败', error: `${failure.name}: ${detail}` });
    const headers = { 'x-upstream-phase': phase };
    if (Number.isFinite(elapsedMs)) headers['x-upstream-elapsed-ms'] = String(elapsedMs);
    if (ctx.signal.aborted || !isSafeToRetryNetworkError(e)) headers['x-should-retry'] = 'false';
    errorResponse(res, timeout ? 504 : 502, `${timeout ? '上游超时' : '网关转发失败'} (${provider.name}): ${detail}`, timeout ? 'timeout_error' : 'api_error', headers);
  } finally {
    await acquired?.res.body?.cancel().catch(() => {});
    acquired?.release();
    ctx.dispose();
  }
}

async function handleResponses(req, res, body, requestId, rawBody) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.model !== 'string' || !body.model.trim()) {
    return errorResponse(res, 400, 'Responses request requires model', 'invalid_request_error');
  }
  const route = resolveRoute(body.model);
  if (!route.provider) return errorResponse(res, 404, `模型 ${body.model} 没有匹配的 provider`, 'not_found_error');
  const { provider } = route;
  if (provider.requireKey !== false && !provider.apiKey) return errorResponse(res, 503, `provider ${provider.name} 的密钥未配置，请填入密钥后重启网关`, 'authentication_error', { 'x-should-retry': 'false' });
  const upstreamModel = targetFor(route);
  const profile = createRequestProfile(provider, upstreamModel, route.clientProfile, req.headers);
  const directResponses = provider.apiType === 'openai' && (profile.clientType === 'codex' || provider.messagesTransport === 'responses');
  let internalBody;
  if (!directResponses) {
    try { internalBody = responses.responsesToAnthropic(body); } catch (e) { return errorResponse(res, 400, e.message, 'invalid_request_error'); }
  }
  const upstreamProtocol = directResponses ? 'responses' : provider.apiType === 'anthropic' ? 'messages' : 'chat-completions';
  const protocolAdapter = directResponses ? 'direct' : 'responses-to-' + upstreamProtocol;
  const usage = beginUsage({ requestId, route: route.alias, provider: provider.name, model: upstreamModel, clientType: profile.clientType, inputProtocol: 'responses', upstreamProtocol, adapter: protocolAdapter, ...capturePricing(provider.name, upstreamModel), estimatedInputTokens: directResponses ? Math.max(1, Math.ceil(rawBody.length / 4)) : estimateInputTokens(internalBody) });
  const internalRequest = directResponses ? undefined : { ...internalBody, model: upstreamModel };
  const outgoing = directResponses
    ? adaptResponsesBodyForModelSeries(body, upstreamModel)
    : adaptBodyForModelSeries(internalRequest, upstreamModel);
  // 直通默认转发原始字节；只有系列适配改了内容才重新序列化
  const directRaw = outgoing === body ? rawBody : JSON.stringify(outgoing);
  const t0 = Date.now();
  const ctx = requestContext(res, provider.requestTimeoutMs);
  const target = route.alias === upstreamModel ? route.alias : `${route.alias} ⇒ ${upstreamModel}`;
  const seriesChanged = outgoing !== (directResponses ? body : internalRequest);
  const adapted = seriesChanged ? ` · [${modelSeries(upstreamModel)} 适配]` : '';
  const mode = `${directResponses ? 'direct' : 'adapter'}${adapted}`;
  requestLog(requestId, profile.clientType, `→ responses ${target} @${provider.name} · ${mode}`);
  let acquired;
  let headersMs;
  const finish = ({ status, mark = '←', label = String(status), usageStatus = status, reported, error, extra }) => {
    const item = finishUsage(usage, { status: usageStatus, usage: reported, error });
    const parts = [label, fmtMs(Date.now() - t0)];
    if (extra) parts.push(extra);
    if (error) parts.push(summarizeError(error));
    if (item?.usageSource === 'reported') parts.push(usageText(item), costText(item));
    else if (mark === '←') parts.push(`用量未上报（估算输入 ${fmtCount(usage.estimatedInputTokens)}）`);
    requestLog(requestId, profile.clientType, `${mark} responses ${target} · ${mode} · ${parts.join(' · ')}`);
  };
  try {
    const adapter = provider.apiType === 'gemini' ? gemini : openai;
    acquired = await withUpstream(provider, () => {
      if (directResponses) return openai.callResponses(provider, outgoing, upstreamModel, ctx.signal, req.headers, profile, directRaw);
      return provider.apiType === 'anthropic'
        ? anthropic.callMessages(provider, outgoing, req.headers, ctx.signal, profile)
        : adapter.callOpenAI(provider, outgoing, upstreamModel, ctx.signal, req.headers, profile);
    }, {
      signal: ctx.signal,
      onRetry: (attempt, why, ms) => requestLog(requestId, profile.clientType, `↻ responses ${target} · ${mode} · ${fmtMs(ms)} 后第 ${attempt} 次重试 · ${why}`),
    });
    headersMs = Date.now() - t0;
    const upstream = acquired.res;
    if (directResponses) {
      const monitor = createResponsesMonitor(upstream.headers.get('content-type') ?? '', (u) => recordStreamUsage(usage, u));
      res.writeHead(upstream.status, forwardEndToEndHeaders(upstream.headers));
      let bytes = 0;
      let terminalSent = false;
      try {
        if (upstream.body) {
          await relayBody(upstream.body, res, ctx.signal, (chunk) => {
            bytes += chunk.byteLength;
            monitor.push(chunk);
            if (monitor.terminal && !res.destroyed) terminalSent = true;
          }, () => monitor.terminal);
        } else res.end();
      } catch (e) {
        // Codex 读到 response.completed 就关连接，不等上游收尾（sub2api 实测晚 30~40ms 结束流）；
        // 终止事件已写给客户端时按正常结束记账，不算客户端取消
        if (!terminalSent) throw e;
        // A late upstream reset must not invalidate an already delivered terminal event.
        if (!res.destroyed && !res.writableEnded) res.end();
      }
      monitor.end();
      const failed = !upstream.ok || Boolean(monitor.error);
      finish({
        status: upstream.status,
        mark: failed ? '✗' : '←',
        label: !upstream.ok ? `上游 ${upstream.status}` : monitor.error ? `${upstream.status} Responses failure` : String(upstream.status),
        usageStatus: monitor.error ? 502 : upstream.status,
        error: monitor.error ?? (!upstream.ok ? `Upstream HTTP ${upstream.status}` : undefined),
        extra: fmtBytes(bytes),
      });
      return;
    }
    if (!upstream.ok) {
      const text = redact(await readResponseText(upstream, 64 * 1024, true));
      finish({ status: upstream.status, mark: '✗', label: `上游 ${upstream.status}`, error: text });
      const headers = {};
      for (const key of ['retry-after', 'request-id', 'x-request-id']) { const value = upstream.headers.get(key); if (value) headers[key] = value; }
      if (upstream.headers.get('x-should-retry') === 'false' || (!isRetryableStatus(upstream.status) && upstream.status >= 500)) headers['x-should-retry'] = 'false';
      return errorResponse(res, upstream.status, `上游 ${provider.name} 返回 ${upstream.status}: ${summarizeError(text, 800)}`, 'api_error', headers);
    }
    const contentType = upstream.headers.get('content-type') ?? 'application/json';
    if (body.stream) {
      let stream;
      if (provider.apiType === 'anthropic') {
        if (contentType.includes('event-stream')) {
          stream = responses.anthropicToResponsesStream(upstream.body, route.alias, { onUsage: (u) => recordStreamUsage(usage, u) });
        } else {
          const message = JSON.parse(await readResponseText(upstream));
          stream = responses.responsesJsonToStream(responses.anthropicToResponses(message, route.alias));
          recordStreamUsage(usage, message.usage);
        }
      } else if (contentType.includes('event-stream')) {
        const anthropicStream = openAIToAnthropicStream(upstream.body, route.alias, { onUsage: (u) => recordStreamUsage(usage, u) });
        stream = responses.anthropicToResponsesStream(anthropicStream, route.alias, { onUsage: (u) => recordStreamUsage(usage, u) });
      } else {
        const converted = await convertJsonResponse(upstream, route.alias, adapter);
        recordStreamUsage(usage, converted.usage);
        stream = responses.responsesJsonToStream(responses.anthropicToResponses(converted, route.alias));
      }
      res.writeHead(200, { ...responses.RESPONSES_SSE_HEADERS, 'x-request-id': requestId });
      const bytes = await relayBody(stream, res, ctx.signal);
      finish({ status: 200, extra: `${fmtBytes(bytes)} · 首字节 ${fmtMs(headersMs)}` });
    } else {
      let message;
      if (provider.apiType === 'anthropic') message = JSON.parse(await readResponseText(upstream));
      else message = await convertJsonResponse(upstream, route.alias, adapter);
      const result = responses.anthropicToResponses(message, route.alias);
      json(res, 200, result);
      finish({ status: 200, reported: message.usage });
    }
  } catch (e) {
    if (ctx.client.signal.aborted) {
      finish({ status: 499, mark: '⊘', error: '客户端断开' });
      return;
    }
    const code = networkErrorCode(e);
    const deadlineExpired = ctx.signal.aborted && ctx.signal.reason?.name === 'TimeoutError';
    const failure = deadlineExpired ? ctx.signal.reason : e;
    const timeout = deadlineExpired || e.name === 'TimeoutError' || e.name === 'AbortError' || ['GATEWAY_CONNECT_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code);
    finish({ status: timeout ? 504 : 502, mark: '✗', label: timeout ? '504 上游超时' : '502 网关转发失败', error: `${failure.name}: ${failure.message}` });
    errorResponse(res, timeout ? 504 : 502, `${timeout ? '上游超时' : '网关转发失败'} (${provider.name}): ${failure.message}`, timeout ? 'timeout_error' : 'api_error', { 'x-should-retry': 'false' });
  } finally {
    await acquired?.res.body?.cancel().catch(() => {});
    acquired?.release();
    ctx.dispose();
  }
}

async function countTokens(req, res, body, rawBody) {
  const route = resolveRoute(body.model);
  if (route.provider?.apiType === 'anthropic' && (route.provider.apiKey || route.provider.requireKey === false)) {
    const ctx = requestContext(res, Math.min(route.provider.requestTimeoutMs, 15000));
    let acquired;
    try {
      const model = targetFor(route);
      const payload = modelSeries(model) === 'gemini'
        ? JSON.stringify(adaptBodyForModelSeries({ ...body, model }, model))
        : (body.model === model ? rawBody : replaceResponseModel(rawBody, model));
      acquired = await withUpstream(route.provider, () => upstreamFetch(route.provider, `${route.provider.baseUrl}/v1/messages/count_tokens`, {
        method: 'POST', headers: anthropic.buildHeaders(route.provider, req.headers),
        body: payload, signal: ctx.signal,
      }), { signal: ctx.signal });
      if (acquired.res.ok) {
        const value = JSON.parse(await readResponseText(acquired.res, 64 * 1024));
        if (Number.isInteger(value.input_tokens) && value.input_tokens >= 0) return json(res, 200, value);
      }
    } catch { /* Some compatible upstreams do not implement token counting. */ } finally {
      await acquired?.res.body?.cancel().catch(() => {});
      acquired?.release(); ctx.dispose();
    }
  }
  const text = JSON.stringify({ messages: body.messages, system: body.system, tools: body.tools });
  return json(res, 200, { input_tokens: Math.max(1, Math.ceil(text.length / 4)) });
}
async function routeRequest(req, res) {
  const cfg = currentConfig();
  const path = new URL(req.url, 'http://localhost').pathname.replace(/\/+$/, '') || '/';
  if (req.method === 'GET' && (path === '/health' || path === '/')) {
    return json(res, 200, {
      status: 'ok', service: 'slizm-gateway', pid: process.pid, instanceId, startedAt: new Date(startedAt).toISOString(), pricingReload: true, configReload: true,
      transport: 'node-http-connect-v2', uptimeSec: Math.round((Date.now() - startedAt) / 1000), activeRequests: activeHttpRequests,
      routes: Object.fromEntries([...cfg.routes].map(([k, v]) => [k, `${v.provider}${v.model ? ` -> ${v.model}` : ''}`])),
      providers: [...cfg.providers.values()].map((p) => ({ name: p.name, apiType: p.apiType, baseUrl: p.baseUrl, key: p.apiKey ? '[已配置]' : '(未配置)' })),
    });
  }
  if (req.method === 'POST' && ['/v1/reload-pricing', '/v1/reload-config'].includes(path)) {
    const remote = req.socket.remoteAddress;
    const supplied = Buffer.from(String(req.headers['x-gateway-pricing-token'] ?? ''));
    const expected = Buffer.from(pricingControlToken);
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return errorResponse(res, 403, '计价重载仅允许本机管理凭据', 'authentication_error');
    }
    if (req.headers.origin) return errorResponse(res, 403, '不接受浏览器直接重载请求');
    if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return errorResponse(res, 415, 'Content-Type 必须为 application/json');
    try {
      const body = JSON.parse(await readBody(req, 4096));
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => k !== 'expectedRevision') ||
          (body.expectedRevision !== undefined && !/^[a-f0-9]{64}$/.test(body.expectedRevision))) {
        return errorResponse(res, 400, '无效的计价重载参数');
      }
      return json(res, 200, { ...runtimePricing.reload(body.expectedRevision), instanceId });
    } catch (error) { return errorResponse(res, error.statusCode ?? error.status ?? 400, error.message, 'invalid_request_error', { connection: 'close' }); }
  }
  if (!checkClientAuth(req)) return errorResponse(res, 401, '网关鉴权失败：客户端 token 不匹配', 'authentication_error');
  if (req.method === 'GET' && path === '/v1/pricing-status') return json(res, 200, { ...runtimePricing.status(), instanceId });
  if (req.method === 'GET' && path === '/v1/gate-stats') return json(res, 200, gateStats());
  if (req.method === 'GET' && (path === '/v1/usage' || path === '/v1/token-stats')) return json(res, 200, usageStats({ activeRequests: activeHttpRequests }));
  if (req.method === 'GET' && path === '/v1/models') {
    const data = [...cfg.routes].map(([alias, target]) => ({ id: alias, type: 'model', display_name: `${alias} (${target.provider}${target.model ? ` -> ${target.model}` : ''})`, created_at: new Date(startedAt).toISOString() }));
    return json(res, 200, { data, first_id: data[0]?.id ?? null, has_more: false, last_id: data.at(-1)?.id ?? null });
  }
  if (req.method === 'POST' && ['/v1/messages', '/v1/messages/count_tokens', '/v1/responses'].includes(path)) {
    let raw;
    try { raw = await readBody(req); } catch (e) { return errorResponse(res, e.status ?? 400, e.message, e.status === 413 ? 'request_too_large' : 'invalid_request_error', { connection: 'close' }); }
    let body;
    try { body = JSON.parse(raw); } catch { return errorResponse(res, 400, '请求体不是合法 JSON', 'invalid_request_error'); }
    if (path === '/v1/responses') {
      return handleResponses(req, res, body, res.requestId, raw);
    }
    if (!validBody(body)) return errorResponse(res, 400, '请求体必须含非空 model 和有效 messages；stream/max_tokens/tools 类型必须正确', 'invalid_request_error');
    return path.endsWith('/count_tokens') ? countTokens(req, res, body, raw) : handleMessages(req, res, body, res.requestId, raw);
  }
  return errorResponse(res, 404, `网关不支持的路由: ${req.method} ${path}`, 'not_found_error');
}
const server = http.createServer((req, res) => {
  // 请求 ID 一律由网关生成，不回显客户端带来的值：日志前缀统一，也不把任意客户端输入写进响应头
  const requestId = `gw_${randomUUID().slice(0, 8)}`;
  res.requestId = requestId;
  const tracked = req.method === 'POST';
  if (tracked) activeHttpRequests++;
  configContext.run({ config: cfg, capturePricing: runtimePricing.captureContext() }, () => routeRequest(req, res)).catch((e) => {
    console.error(`[${stamp()}] [${requestId}] 请求处理异常:`, redact(String(e?.stack ?? e)));
    errorResponse(res, 500, '网关内部错误，请查看已脱敏的服务日志', 'api_error', { 'x-should-retry': 'false' });
  }).finally(() => {
    if (tracked) activeHttpRequests--;
    // 兜底：处理完响应仍未 end（例如错误处理本身又出错）就断开，不让 Claude Code 一直挂着等
    if (!res.writableEnded) res.destroy();
  });
});
server.listen(cfg.server.port, cfg.server.host, () => {
  stopPricingWatch = runtimePricing.startWatching();
  try {
    removePricingControl = publishPricingControl({ configPath, port: server.address().port,
      host: server.address().address, instanceId, token: pricingControlToken });
  } catch (error) { print(null, `管理端计价重载凭据未发布（文件监听仍生效）: ${redact(error.message)}`, console.error); }
  print(null, `网关已启动 http://${cfg.server.host}:${server.address().port} · pid ${process.pid} · ${cfg.routes.size} 条路由 · node-http-connect-v2`);
  // 路由按 provider 汇总，一个 provider 一行
  const byProvider = new Map();
  for (const [alias, target] of cfg.routes) {
    const model = targetFor({ provider: cfg.providers.get(target.provider), targetModel: target.model ?? alias });
    if (!byProvider.has(target.provider)) byProvider.set(target.provider, []);
    byProvider.get(target.provider).push(alias === model ? alias : `${alias}⇒${model}`);
  }
  for (const [name, list] of byProvider) {
    const p = cfg.providers.get(name);
    print(null, `  ${name}（${p.apiType}${p.proxy ? '，经代理' : ''}）: ${list.join(', ')}`);
  }
  for (const missing of missingSecretRefs()) print(null, `密钥未配置: ${missing.provider} 需要 ${missing.name}`);
});
server.on('error', (e) => {
  print(null, e.code === 'EADDRINUSE' ? `端口 ${cfg.server.port} 已被占用` : `网关启动失败: ${e.message}`, console.error);
  process.exit(1);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  stopPricingWatch?.();
  removePricingControl?.();
  print(null, `收到 ${sig}，关闭网关…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});
process.on('unhandledRejection', (e) => console.error(`[${stamp()}] 未处理的异步异常:`, redact(String(e?.stack ?? e))));
process.on('exit', () => { stopPricingWatch?.(); removePricingControl?.(); });
// 未捕获异常仍按 Node 默认行为打印栈并退出；先补一行时间和 pid，err.log 里的崩溃栈才对得上时间和进程
process.on('uncaughtExceptionMonitor', (e, origin) => console.error(`[${stamp()}] 网关进程因未捕获异常退出 (pid ${process.pid}, ${origin}):`));
