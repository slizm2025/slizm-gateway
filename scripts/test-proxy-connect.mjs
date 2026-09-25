// Deterministic coverage for upstream-fetch without depending on Internet availability:
// HTTPS proxy CONNECT, failure phases (retry safety), and cancelling the tunnel after response headers.
// 本地自签证书仅用于测试（scripts/fixtures），因此关闭证书校验。
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.emitWarning = () => {};

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { upstreamFetch } from '../src/upstream-fetch.js';
import { isSafeToRetryNetworkError } from '../src/limiter.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const TLS_OPTS = { cert: readFileSync(join(FIX, 'test-cert.pem')), key: readFileSync(join(FIX, 'test-key.pem')) };

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS: ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL: ${name}\n  ${e.stack}`);
  }
}

// net.Server 没有 closeAllConnections，自己记录连接，关闭时逐个销毁，否则 close() 会一直等
const listen = (srv) => {
  srv.sockets = new Set();
  srv.on('connection', (c) => {
    srv.sockets.add(c);
    c.on('close', () => srv.sockets.delete(c));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
};
const close = (srv) =>
  new Promise((r) => {
    for (const c of srv.sockets ?? []) c.destroy();
    srv.close(() => r());
  });
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

/** 可控的 CONNECT 代理：mode 决定握手后的行为 */
async function makeProxy(onConnect) {
  const proxy = http.createServer();
  proxy.on('connect', onConnect);
  const port = await listen(proxy);
  return { proxy, url: `http://127.0.0.1:${port}` };
}

/** 把 CONNECT 隧道接到本地 TLS 服务 */
function tunnelTo(targetPort) {
  return (req, socket) => {
    const up = net.connect(targetPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  };
}

/** TLS 服务：握手完成、收到请求后在底层 TCP 上发 RST */
function tlsResetAfterRequest() {
  return net.createServer((raw) => {
    raw.on("error", () => {});
    const s = new tls.TLSSocket(raw, { isServer: true, ...TLS_OPTS });
    s.on("error", () => {});
    s.once("data", () => setTimeout(() => raw.resetAndDestroy(), 50));
  });
}

const opts = (extra = {}) => ({ method: 'POST', body: '{}', signal: AbortSignal.timeout(5000), ...extra });

await test('CONNECT 被拒 → proxy-connect，可安全重试；带代理鉴权', async () => {
  let connectRequest;
  const { proxy, url } = await makeProxy((req, socket) => {
    connectRequest = { method: req.method, url: req.url, headers: req.headers };
    socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
  });
  const authed = url.replace('http://', 'http://test-user:test-pass@');
  try {
    await assert.rejects(upstreamFetch({ proxy: authed }, 'https://upstream.invalid/v1/messages', opts()), (e) => {
      assert.equal(e.message, 'fetch failed');
      assert.equal(e.cause.code, 'ERR_PROXY_CONNECT');
      assert.equal(e.upstreamPhase, 'proxy-connect');
      assert.equal(isSafeToRetryNetworkError(e), true);
      return true;
    });
    assert.equal(connectRequest.method, 'CONNECT');
    assert.equal(connectRequest.url, 'upstream.invalid:443');
    assert.equal(connectRequest.headers['proxy-authorization'], `Basic ${Buffer.from('test-user:test-pass').toString('base64')}`);
  } finally {
    await close(proxy);
  }
});

await test('隧道建立后 TLS 握手被 reset → tls-handshake，可安全重试', async () => {
  const { proxy, url } = await makeProxy((req, socket) => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', () => socket.resetAndDestroy()); // 收到 ClientHello 就 RST
  });
  try {
    await assert.rejects(upstreamFetch({ proxy: url }, 'https://upstream.invalid/v1/messages', opts()), (e) => {
      assert.equal(e.upstreamPhase, 'tls-handshake');
      assert.equal(isSafeToRetryNetworkError(e), true);
      return true;
    });
  } finally {
    await close(proxy);
  }
});

await test('握手完成、请求已发出后被 reset → response-headers，不可重试（不会误标为 tls-handshake）', async () => {
  const target = tlsResetAfterRequest();
  const tport = await listen(target);
  const { proxy, url } = await makeProxy(tunnelTo(tport));
  try {
    await assert.rejects(upstreamFetch({ proxy: url }, `https://localhost:${tport}/v1/messages`, opts()), (e) => {
      assert.equal(e.upstreamPhase, 'response-headers');
      assert.equal(isSafeToRetryNetworkError(e), false);
      return true;
    });
  } finally {
    await close(proxy);
    await close(target);
  }
});

await test('经代理正常返回：响应体可读', async () => {
  const target = tls.createServer(TLS_OPTS, (s) =>
    s.once('data', () => s.end('HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok')),
  );
  const tport = await listen(target);
  const { proxy, url } = await makeProxy(tunnelTo(tport));
  try {
    const res = await upstreamFetch({ proxy: url }, `https://localhost:${tport}/v1/messages`, opts());
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
  } finally {
    await close(proxy);
    await close(target);
  }
});

await test('响应头之后客户端断开 → 立即销毁隧道（不等上游下一个 chunk）', async () => {
  let upstreamClosedAt;
  const target = tls.createServer(TLS_OPTS, (s) => {
    s.once('data', () => s.write('HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\n')); // 之后保持沉默
    s.on('close', () => (upstreamClosedAt = Date.now()));
    s.on('error', () => {});
  });
  const tport = await listen(target);
  const { proxy, url } = await makeProxy(tunnelTo(tport));
  const ac = new AbortController();
  try {
    const res = await upstreamFetch({ proxy: url }, `https://localhost:${tport}/v1/messages`, opts({ signal: ac.signal }));
    assert.equal(res.status, 200);
    await tick(100);
    const abortedAt = Date.now();
    ac.abort();
    for (let i = 0; i < 20 && !upstreamClosedAt; i++) await tick(50);
    assert.ok(upstreamClosedAt, '上游连接应被关闭');
    assert.ok(upstreamClosedAt - abortedAt < 1000, `关闭耗时 ${upstreamClosedAt - abortedAt}ms`);
  } finally {
    await close(proxy);
    await close(target);
  }
});

await test('直连：TLS 握手被 reset → tls-handshake，可安全重试', async () => {
  const srv = net.createServer((s) => s.once('data', () => s.resetAndDestroy()));
  const port = await listen(srv);
  try {
    await assert.rejects(upstreamFetch({}, `https://localhost:${port}/v1/messages`, opts()), (e) => {
      assert.equal(e.upstreamPhase, 'tls-handshake');
      assert.equal(isSafeToRetryNetworkError(e), true);
      return true;
    });
  } finally {
    await close(srv);
  }
});

await test('直连：连接被拒 → connect，可安全重试', async () => {
  const srv = net.createServer();
  const port = await listen(srv);
  await close(srv);
  await assert.rejects(upstreamFetch({}, `https://localhost:${port}/v1/messages`, opts()), (e) => {
    assert.equal(e.upstreamPhase, 'connect');
    assert.equal(isSafeToRetryNetworkError(e), true);
    return true;
  });
});

await test('直连：请求已发出后被 reset → response-headers，不可重试', async () => {
  const target = tlsResetAfterRequest();
  const port = await listen(target);
  try {
    await assert.rejects(upstreamFetch({}, `https://localhost:${port}/v1/messages`, opts()), (e) => {
      assert.equal(e.upstreamPhase, 'response-headers');
      assert.equal(isSafeToRetryNetworkError(e), false);
      return true;
    });
  } finally {
    await close(target);
  }
});

await test('CONNECT 必须使用隧道：上游域名只由代理解析', async () => {
  let connectHits = 0;
  const target = tls.createServer(TLS_OPTS, (s) => {
    s.on('error', () => {});
    s.once('data', () => s.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok'));
  });
  const tport = await listen(target);
  const forward = tunnelTo(tport);
  const { proxy, url } = await makeProxy((...args) => { connectHits++; forward(...args); });
  try {
    const res = await upstreamFetch({ proxy: url }, 'https://proxy-only.invalid/v1/messages', opts());
    assert.equal(await res.text(), 'ok');
    assert.equal(connectHits, 1);
  } finally {
    await close(proxy);
    await close(target);
  }
});

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
