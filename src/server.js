// Local Anthropic Messages gateway with provider routing and safe retries.
import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { loadConfig, redact, missingSecretRefs } from './config.js';
import { upstreamFetch, readResponseText } from './upstream-fetch.js';
import * as anthropic from './providers/anthropic.js';
import * as openai from './providers/openai.js';
import * as gemini from './providers/gemini.js';
import { openAIToAnthropicStream, anthropicJsonToStream, convertJsonResponse, SSE_HEADERS } from './stream.js';
import { withUpstream, gateStats, networkErrorCode, isSafeToRetryNetworkError, isRetryableStatus } from './limiter.js';
import { modelSeries, adaptBodyForModelSeries } from './model-series.js';
import { createRequestProfile } from './providers/client-headers.js';
import { createSseDecoder } from './sse.js';
import { beginUsage, finishUsage, recordStreamUsage, estimateInputTokens, usageStats, summarizeError } from './usage.js';

const cfg = loadConfig();
const startedAt = Date.now();
const instanceId = randomUUID();
let activeRequests = 0;

function resolveRoute(requestedModel) {
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
const fmtCount = (n) => (n < 1000 ? String(n) : n < 999_950 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1e6).toFixed(2)}M`);
const fmtBytes = (b) => (b < 1024 ? `${b}B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)}KB` : `${(b / 1024 / 1024).toFixed(1)}MB`);
function fmtUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '未配置';
  if (n === 0) return '$0.00';
  if (Math.abs(n) < 0.01) return `$${n.toFixed(6)}`;
  if (Math.abs(n) < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}
/** 上游上报的用量 → "输入 3 · 缓存读 185.2k · 输出 1.2k"，缓存为 0 时省略 */
function usageText(item) {
  const parts = [`输入 ${fmtCount(item.inputTokens)}`];
  if (item.cacheReadTokens) parts.push(`缓存读 ${fmtCount(item.cacheReadTokens)}`);
  if (item.cacheWriteTokens) parts.push(`缓存写 ${fmtCount(item.cacheWriteTokens)}`);
  parts.push(`输出 ${fmtCount(item.outputTokens)}`);
  return parts.join(' · ');
}
function costText(item) {
  return `费用 ${item?.costUsd === null || item?.costUsd === undefined ? '未配置' : fmtUsd(item.costUsd)}`;
}
/** 一条日志只占一行：[本地时间] [请求 ID] 内容。内容脱敏，换行折叠成空格 */
function print(requestId, message, write = console.log) {
  write(`[${stamp()}]${requestId ? ` [${requestId}]` : ''} ${redact(String(message)).replace(/\s*[\r\n]+\s*/g, ' ')}`);
}
function log(requestId, message) {
  if (cfg.server.logRequests) print(requestId, message);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > 64 * 1024 * 1024) {
        failed = true; chunks = [];
        reject(Object.assign(new Error('请求体超过 64MiB 上限'), { status: 413 }));
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
  const expected = Buffer.from(cfg.server.clientToken);
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

async function relayBody(body, res, signal, onChunk) {
  if (!body) throw new Error('上游缺少响应体');
  const reader = body.getReader();
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      if (res.destroyed) throw new DOMException('客户端已断开', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      try { onChunk?.(value); } catch { /* 统计出错不能影响转发 */ }
      if (!res.write(value)) {
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
async function handleMessages(req, res, body, requestId) {
  const route = resolveRoute(body.model);
  if (!route.provider) return errorResponse(res, 404, `模型 ${body.model} 没有匹配的 provider`, 'not_found_error');
  const { provider } = route;
  if (provider.requireKey !== false && !provider.apiKey) return errorResponse(res, 503, `provider ${provider.name} 的密钥未配置，请填入密钥后重启网关`, 'authentication_error', { 'x-should-retry': 'false' });
  const upstreamModel = targetFor(route);
  const profile = createRequestProfile(provider, upstreamModel, route.clientProfile);
  const usage = beginUsage({ requestId, route: route.alias, provider: provider.name, model: upstreamModel, pricing: cfg.pricing, estimatedInputTokens: estimateInputTokens(body) });
  const requested = { ...body, model: upstreamModel };
  const outgoing = adaptBodyForModelSeries(requested, upstreamModel);
  const t0 = Date.now();
  const ctx = requestContext(res, provider.requestTimeoutMs);
  const target = route.alias === upstreamModel ? route.alias : `${route.alias} ⇒ ${upstreamModel}`;
  const adapted = outgoing === requested ? '' : ` · [${modelSeries(upstreamModel)} 适配]`;
  log(requestId, `→ ${target} @${provider.name} · ${body.stream ? '流式' : '非流式'} · 输入≈${fmtCount(usage.estimatedInputTokens)}${adapted}`);
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
    log(requestId, `${mark} ${route.alias} · ${parts.join(' · ')}`);
  };
  try {
    const adapter = provider.apiType === 'gemini' ? gemini : openai;
    acquired = await withUpstream(provider, () => {
      attemptStarted = performance.now();
      return provider.apiType === 'anthropic'
        ? anthropic.callMessages(provider, outgoing, req.headers, ctx.signal, profile)
        : adapter.callOpenAI(provider, outgoing, upstreamModel, ctx.signal, req.headers, profile);
    }, {
      signal: ctx.signal,
      onRetry: (attempt, why, ms) => log(requestId, `↻ ${route.alias} · ${fmtMs(ms)} 后第 ${attempt} 次重试 · ${why}`),
    });
    headersMs = Date.now() - t0;
    const upstream = acquired.res;
    if (!upstream.ok) {
      const text = redact(await readResponseText(upstream, 64 * 1024, true));
      finish({ status: upstream.status, mark: '✗', label: `上游 ${upstream.status}`, error: text, ttfb: false });
      const headers = {};
      for (const key of ['retry-after', 'request-id', 'x-request-id']) { const value = upstream.headers.get(key); if (value) headers[key] = value; }
      if (upstream.headers.get('x-should-retry') === 'false' || (!isRetryableStatus(upstream.status) && upstream.status >= 500)) headers['x-should-retry'] = 'false';
      if (provider.apiType === 'anthropic' && upstream.headers.get('content-type')?.includes('json')) {
        try { return json(res, upstream.status, JSON.parse(text), headers); } catch { /* Return a bounded gateway error instead. */ }
      }
      // HTML 错误页（如 Cloudflare 502）只转述标题，不把整页 HTML 塞给 Claude Code
      return errorResponse(res, upstream.status, `上游 ${provider.name} 返回 ${upstream.status}: ${summarizeError(text, 800)}`, 'api_error', headers);
    }
    const contentType = upstream.headers.get('content-type') ?? 'application/json';
    if (provider.apiType === 'anthropic') {
      if (body.stream && !contentType.includes('event-stream')) {
        const message = JSON.parse(await readResponseText(upstream));
        const stream = anthropicJsonToStream(message);
        res.writeHead(200, { ...SSE_HEADERS, 'x-request-id': requestId });
        const bytes = await relayBody(stream, res, ctx.signal);
        finish({ status: 200, reported: message.usage, extra: `${fmtBytes(bytes)} · 上游回的是 JSON，已转成 SSE` });
      } else if (contentType.includes('event-stream')) {
        res.writeHead(upstream.status, { ...SSE_HEADERS, 'x-request-id': requestId });
        const monitor = createSseMonitor((u) => recordStreamUsage(usage, u));
        let bytes = 0;
        if (upstream.body) bytes = await relayBody(upstream.body, res, ctx.signal, monitor.push); else res.end();
        monitor.end();
        // 响应头已经是 200：流里的 error 事件、没有 message_stop 就结束，都只能在这里发现，按失败记账
        if (monitor.error) finish({ status: upstream.status, mark: '✗', label: `${upstream.status} 流内错误`, usageStatus: 502, error: `${monitor.error.type ?? 'error'}: ${monitor.error.message ?? ''}`, extra: fmtBytes(bytes) });
        else if (!monitor.stopped) finish({ status: upstream.status, mark: '⚠', label: `${upstream.status} 流未收尾`, usageStatus: 502, error: '上游没发 message_stop 就结束了', extra: fmtBytes(bytes) });
        else finish({ status: upstream.status, extra: fmtBytes(bytes) });
      } else {
        const text = await readResponseText(upstream);
        let parsed;
        try { parsed = JSON.parse(text); } catch {}
        res.writeHead(upstream.status, { 'content-type': contentType, 'x-request-id': requestId });
        res.end(text);
        finish({ status: upstream.status, reported: parsed?.usage });
      }
    } else if (body.stream) {
      let stream;
      let streamError;
      if (contentType.includes('event-stream')) {
        stream = openAIToAnthropicStream(upstream.body, route.alias, {
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
      log(requestId, `⊘ ${route.alias} · 客户端已断开，已取消上游 · ${fmtMs(Date.now() - t0)}${item?.usageSource === 'reported' ? ` · ${usageText(item)} · ${costText(item)}` : ''}`);
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

async function countTokens(req, res, body) {
  const route = resolveRoute(body.model);
  if (route.provider?.apiType === 'anthropic' && (route.provider.apiKey || route.provider.requireKey === false)) {
    const ctx = requestContext(res, Math.min(route.provider.requestTimeoutMs, 15000));
    let acquired;
    try {
      const model = targetFor(route);
      const profile = createRequestProfile(route.provider, model, route.clientProfile);
      acquired = await withUpstream(route.provider, () => upstreamFetch(route.provider, `${route.provider.baseUrl}/v1/messages/count_tokens`, {
        method: 'POST', headers: anthropic.buildHeaders(route.provider, req.headers, profile),
        body: JSON.stringify(adaptBodyForModelSeries({ ...body, model }, model)), signal: ctx.signal,
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
  const path = new URL(req.url, 'http://localhost').pathname.replace(/\/+$/, '') || '/';
  if (req.method === 'GET' && (path === '/health' || path === '/')) {
    return json(res, 200, {
      status: 'ok', service: 'claude-gateway', pid: process.pid, instanceId, startedAt: new Date(startedAt).toISOString(),
      transport: 'node-http-connect-v2', uptimeSec: Math.round((Date.now() - startedAt) / 1000), activeRequests,
      routes: Object.fromEntries([...cfg.routes].map(([k, v]) => [k, `${v.provider}${v.model ? ` -> ${v.model}` : ''}`])),
      providers: [...cfg.providers.values()].map((p) => ({ name: p.name, apiType: p.apiType, baseUrl: p.baseUrl, key: p.apiKey ? '[已配置]' : '(未配置)' })),
    });
  }
  if (!checkClientAuth(req)) return errorResponse(res, 401, '网关鉴权失败：客户端 token 不匹配', 'authentication_error');
  if (req.method === 'GET' && path === '/v1/gate-stats') return json(res, 200, gateStats());
  if (req.method === 'GET' && (path === '/v1/usage' || path === '/v1/token-stats')) return json(res, 200, usageStats({ activeRequests }));
  if (req.method === 'GET' && path === '/v1/models') {
    const data = [...cfg.routes].map(([alias, target]) => ({ id: alias, type: 'model', display_name: `${alias} (${target.provider}${target.model ? ` -> ${target.model}` : ''})`, created_at: new Date(startedAt).toISOString() }));
    return json(res, 200, { data, first_id: data[0]?.id ?? null, has_more: false, last_id: data.at(-1)?.id ?? null });
  }
  if (req.method === 'POST' && ['/v1/messages', '/v1/messages/count_tokens'].includes(path)) {
    let raw;
    try { raw = await readBody(req); } catch (e) { return errorResponse(res, e.status ?? 400, e.message, e.status === 413 ? 'request_too_large' : 'invalid_request_error', { connection: 'close' }); }
    let body;
    try { body = JSON.parse(raw); } catch { return errorResponse(res, 400, '请求体不是合法 JSON', 'invalid_request_error'); }
    if (!validBody(body)) return errorResponse(res, 400, '请求体必须含非空 model 和有效 messages；stream/max_tokens/tools 类型必须正确', 'invalid_request_error');
    return path.endsWith('/count_tokens') ? countTokens(req, res, body) : handleMessages(req, res, body, res.requestId);
  }
  return errorResponse(res, 404, `网关不支持的路由: ${req.method} ${path}`, 'not_found_error');
}
const server = http.createServer((req, res) => {
  // 请求 ID 一律由网关生成，不回显客户端带来的值：日志前缀统一，也不把任意客户端输入写进响应头
  const requestId = `gw_${randomUUID().slice(0, 8)}`;
  res.requestId = requestId;
  const tracked = req.method === 'POST';
  if (tracked) activeRequests++;
  routeRequest(req, res).catch((e) => {
    console.error(`[${stamp()}] [${requestId}] 请求处理异常:`, redact(String(e?.stack ?? e)));
    errorResponse(res, 500, '网关内部错误，请查看已脱敏的服务日志', 'api_error', { 'x-should-retry': 'false' });
  }).finally(() => {
    if (tracked) activeRequests--;
    // 兜底：处理完响应仍未 end（例如错误处理本身又出错）就断开，不让 Claude Code 一直挂着等
    if (!res.writableEnded) res.destroy();
  });
});
server.listen(cfg.server.port, cfg.server.host, () => {
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
  print(null, `收到 ${sig}，关闭网关…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});
process.on('unhandledRejection', (e) => console.error(`[${stamp()}] 未处理的异步异常:`, redact(String(e?.stack ?? e))));
// 未捕获异常仍按 Node 默认行为打印栈并退出；先补一行时间和 pid，err.log 里的崩溃栈才对得上时间和进程
process.on('uncaughtExceptionMonitor', (e, origin) => console.error(`[${stamp()}] 网关进程因未捕获异常退出 (pid ${process.pid}, ${origin}):`));
