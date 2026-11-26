// 上游请求出口：provider 配了 `proxy` 就显式建立 HTTP CONNECT 隧道，否则直连。
// 默认每个请求使用独立 socket，避免本地代理/NAT 清理 idle socket 后复用出 ECONNRESET。
// 网络错误带 upstreamPhase / beforeSend，limiter 据此判断能否安全重试。
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { Readable, pipeline } from 'node:stream';
import zlib from 'node:zlib';

const agents = new Map();

function agentFor(isHttps, keepAlive) {
  const key = `${isHttps ? 'https' : 'http'}|${keepAlive ? 'keep' : 'close'}`;
  let agent = agents.get(key);
  if (!agent) {
    const Agent = isHttps ? https.Agent : http.Agent;
    agent = new Agent({
      keepAlive,
      ...(isHttps && !keepAlive ? { maxCachedSessions: 0 } : {}),
    });
    agents.set(key, agent);
  }
  return agent;
}

const DECODERS = {
  gzip: () => zlib.createGunzip(),
  'x-gzip': () => zlib.createGunzip(),
  deflate: () => zlib.createInflate(),
  br: () => zlib.createBrotliDecompress(),
  ...(zlib.createZstdDecompress ? { zstd: () => zlib.createZstdDecompress() } : {}),
};

function decodeBody(inc) {
  const encodings = String(inc.headers['content-encoding'] ?? '').toLowerCase().split(',').map((s) => s.trim()).filter((s) => s && s !== 'identity');
  if (!encodings.length) return inc;
  if (encodings.some((s) => !Object.hasOwn(DECODERS, s))) throw new Error('上游使用了当前 Node 不支持的 Content-Encoding');
  const decoders = encodings.reverse().map((s) => DECODERS[s]());
  delete inc.headers['content-encoding'];
  delete inc.headers['content-length'];
  // pipeline propagates both decoder errors and consumer cancellation to every stage.
  const out = decoders.at(-1);
  pipeline(inc, ...decoders, () => {});
  return out;
}

function toHeaders(raw) {
  const h = new Headers();
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    for (const item of Array.isArray(v) ? v : [v]) h.append(k, item);
  }
  return h;
}

function normalizeHeaders(headers, keepAlive) {
  const out = Object.fromEntries(new Headers(headers ?? {}).entries());
  out['accept-encoding'] ??= 'gzip, deflate, br';
  // 头部与 Claude Code 直连一致（keep-alive）；是否真的复用 socket 由 agent 决定，默认用完即关
  out.connection = 'keep-alive';
  return out;
}

function proxyInfo(proxy) {
  const p = new URL(proxy);
  if (p.protocol !== 'http:') throw new Error(`仅支持 http 代理作为 CONNECT 出口: ${p.protocol}`);
  const auth = p.username || p.password
    ? `Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')}`
    : undefined;
  return { hostname: p.hostname, port: Number(p.port || 80), auth };
}

// 失败阶段：proxy-connect / connect / tls-handshake 时请求体还没写到上游，重试不会重复计费；
// response-headers 表示请求已发出、在等响应头，上游可能已开始生成计费，不能重试。
const PRE_SEND_PHASES = new Set(['proxy-connect', 'connect', 'tls-handshake']);

function wrapNetworkError(error, url, phase) {
  const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError';
  const wrapped = aborted ? new Error(error.message, { cause: error }) : new TypeError('fetch failed', { cause: error });
  if (aborted) wrapped.name = error.name;
  wrapped.upstreamUrl = url.origin;
  wrapped.upstreamPhase = phase;
  wrapped.beforeSend = !aborted && PRE_SEND_PHASES.has(phase);
  return wrapped;
}

// 等响应头可能长达数分钟且链路上完全无数据，开 TCP keepalive 防止被中间设备当作空闲连接掐断
function tuneSocket(socket) {
  socket.setKeepAlive?.(true, 15_000);
  socket.setNoDelay?.(true);
}

function responseFromIncoming(inc, method) {
  const nullBody = [204, 205, 304].includes(inc.statusCode) || method === 'HEAD';
  if (nullBody) inc.resume();
  const body = nullBody ? null : Readable.toWeb(decodeBody(inc), {
    strategy: { highWaterMark: 64 * 1024, size: (chunk) => chunk.byteLength },
  });
  return new Response(body, {
    status: inc.statusCode ?? 502,
    statusText: inc.statusMessage,
    headers: toHeaders(inc.headers),
  });
}

function receiveResponse(inc, method, resolve, reject) {
  try { resolve(responseFromIncoming(inc, method)); } catch (error) {
    inc.destroy();
    reject(error);
  }
}

function connectionDeadline(timeoutMs, fail) {
  const timer = setTimeout(() => {
    const error = new Error('上游建连超时（请求尚未发送）');
    error.code = 'GATEWAY_CONNECT_TIMEOUT';
    fail(error);
  }, timeoutMs);
  timer.unref();
  return () => clearTimeout(timer);
}

function requestDirect(url, init, keepAlive, connectTimeoutMs) {
  const isHttps = url.protocol === 'https:';
  const mod = isHttps ? https : http;
  const headers = normalizeHeaders(init.headers, keepAlive);
  const signal = init.signal;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    let settled = false;
    // 复用的 keep-alive socket 无法判断请求是否已送达，保守按 response-headers 处理
    let phase = 'response-headers';
    const settleResolve = (value) => { if (settled) return; settled = true; resolve(value); };
    const settleReject = (error) => { if (settled) return; settled = true; reject(error); };
    const req = mod.request(url, {
      method: init.method ?? 'GET',
      headers,
      agent: agentFor(isHttps, keepAlive),
      signal, // 响应头之后仍然有效：客户端断开会销毁 socket，响应体流随之结束
    });
    const stopDeadline = connectionDeadline(connectTimeoutMs, (error) => req.destroy(error));
    req.once('close', stopDeadline);
    req.once('socket', (socket) => {
      tuneSocket(socket);
      if (!socket.connecting) { stopDeadline(); return; }
      phase = 'connect';
      socket.once('connect', () => {
        phase = isHttps ? 'tls-handshake' : 'response-headers';
        if (!isHttps) stopDeadline();
      });
      if (isHttps) socket.once('secureConnect', () => { phase = 'response-headers'; stopDeadline(); });
    });
    req.once('response', (inc) => receiveResponse(inc, init.method, settleResolve,
      (error) => settleReject(wrapNetworkError(error, url, 'response-headers'))));
    // 用 on 而非 once：超时/取消销毁连接时可能连续触发多次 error，避免第二次成为未捕获异常拖垮进程
    req.on('error', (error) => {
      stopDeadline();
      settleReject(wrapNetworkError(signal?.aborted ? (signal.reason ?? error) : error, url, phase));
    });
    req.end(init.body);
  });
}

function requestViaProxy(proxy, url, init, keepAlive, connectTimeoutMs) {
  const info = proxyInfo(proxy);
  const signal = init.signal;
  const headers = normalizeHeaders(init.headers, keepAlive);

  if (url.protocol !== 'https:') {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      let settled = false;
      let phase = 'proxy-connect';
      const settleResolve = (value) => { if (settled) return; settled = true; resolve(value); };
      const settleReject = (error) => { if (settled) return; settled = true; reject(error); };
      const req = http.request({
        hostname: info.hostname,
        port: info.port,
        method: init.method ?? 'GET',
        path: url.href,
        headers: { ...headers, host: url.host, ...(info.auth ? { 'proxy-authorization': info.auth } : {}) },
        agent: agentFor(false, keepAlive),
        signal,
      });
      const stopDeadline = connectionDeadline(connectTimeoutMs, (error) => req.destroy(error));
      req.once('close', stopDeadline);
      req.once('socket', (socket) => {
        tuneSocket(socket);
        const connected = () => { phase = 'response-headers'; stopDeadline(); };
        if (!socket.connecting) connected();
        else socket.once('connect', connected);
      });
      req.once('response', (inc) => receiveResponse(inc, init.method, settleResolve,
        (error) => settleReject(wrapNetworkError(error, url, 'response-headers'))));
      req.on('error', (error) => {
        stopDeadline();
        settleReject(wrapNetworkError(signal?.aborted ? (signal.reason ?? error) : error, url, phase));
      });
      req.end(init.body);
    });
  }

  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    let settled = false;
    let phase = 'proxy-connect';
    let connectReq;
    let request;
    let rawSocket;
    let tlsSocket;
    const destroyAll = () => {
      connectReq?.destroy();
      request?.destroy();
      tlsSocket?.destroy();
      rawSocket?.destroy();
    };
    // 响应头到达后也保持监听：客户端断开要立刻销毁隧道，不能等上游吐下一个 chunk
    const onAbort = () => {
      if (settled) destroyAll();
      else fail(signal.reason ?? new Error('request aborted'));
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      stopDeadline();
      destroyAll();
      signal?.removeEventListener('abort', onAbort);
      reject(wrapNetworkError(signal?.aborted ? (signal.reason ?? error) : error, url, phase));
    };
    const stopDeadline = connectionDeadline(connectTimeoutMs, fail);
    signal?.addEventListener('abort', onAbort, { once: true });

    connectReq = http.request({
      hostname: info.hostname,
      port: info.port,
      method: 'CONNECT',
      path: `${url.hostname}:${url.port || 443}`,
      headers: {
        host: `${url.hostname}:${url.port || 443}`,
        ...(info.auth ? { 'proxy-authorization': info.auth } : {}),
      },
      agent: false,
    });
    connectReq.on('error', fail);
    connectReq.once('connect', (res, socket) => {
      rawSocket = socket;
      if (res.statusCode !== 200) {
        const error = new Error(`代理 CONNECT 返回 ${res.statusCode}`);
        error.code = 'ERR_PROXY_CONNECT';
        return fail(error);
      }
      tuneSocket(socket);
      phase = 'tls-handshake';
      tlsSocket = tls.connect({ socket, servername: url.hostname });
      // 整条隧道共用一个错误出口，阶段由 phase 决定；握手完成后不会再被误标为 tls-handshake
      socket.on('error', fail);
      tlsSocket.on('error', fail);
      tlsSocket.once('secureConnect', () => {
        stopDeadline();
        phase = 'response-headers';
        // agent:false creates a new Agent and ignores request-level createConnection.
        // Bind this request's private Agent to the already authenticated TLS tunnel.
        const tunnelAgent = new https.Agent({ keepAlive: false, maxCachedSessions: 0 });
        tunnelAgent.createConnection = () => tlsSocket;
        tlsSocket.once('close', () => tunnelAgent.destroy());
        request = https.request({
          hostname: url.hostname,
          port: Number(url.port || 443),
          path: `${url.pathname}${url.search}`,
          method: init.method ?? 'GET',
          headers,
          agent: tunnelAgent,
          servername: url.hostname,
        });
        request.on('error', fail);
        request.once('response', (inc) => {
          if (settled) return inc.destroy();
          inc.once('close', () => signal?.removeEventListener('abort', onAbort));
          receiveResponse(inc, init.method, (response) => { settled = true; resolve(response); }, fail);
        });
        request.end(init.body);
      });
    });
    connectReq.end();
  });
}

/** Read decoded bytes with a hard limit; cancelling releases the underlying socket. */
export async function readResponseText(response, maxBytes = 64 * 1024 * 1024, truncate = false) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > maxBytes) {
        if (!truncate) throw new Error('上游响应体超过缓冲上限');
        chunks.push(Buffer.from(value.subarray(0, maxBytes - size)));
        break;
      }
      size += value.byteLength;
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** 所有上游请求的统一出口。 */
export async function upstreamFetch(provider, url, init = {}) {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('不支持的上游 URL 协议');
  const keepAlive = provider?.keepAlive === true;
  const connectTimeoutMs = provider?.connectTimeoutMs ?? 30000;
  if (!Number.isSafeInteger(connectTimeoutMs) || connectTimeoutMs < 1 || connectTimeoutMs > 2147483647) throw new Error('connectTimeoutMs 必须是有效的正整数');
  const started = performance.now();
  try {
    return await (provider?.proxy
      ? requestViaProxy(provider.proxy, target, init, keepAlive, connectTimeoutMs)
      : requestDirect(target, init, keepAlive, connectTimeoutMs));
  } catch (error) {
    if (error && typeof error === 'object' && Object.isExtensible(error)) {
      error.upstreamElapsedMs = Math.round(performance.now() - started);
      error.upstreamTransport = provider?.proxy ? 'proxy' : 'direct';
    }
    throw error;
  }
}
