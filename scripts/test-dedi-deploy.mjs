import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, isWeakClientToken } from '../src/config.js';
import { buildHeaders } from '../src/providers/anthropic.js';
import { buildOpenAIHeaders, buildResponsesHeaders } from '../src/providers/openai.js';
import { hasProxyForwardingHeaders } from '../src/providers/client-headers.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const STRONG_TOKEN = 'sk-dedi-strong-token-0123456789abcdef';

test('reverse-proxy and CDN headers are stripped before reaching any upstream protocol', () => {
  const incoming = {
    'user-agent': 'claude-cli/2.1.0',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'prompt-caching-2024-07-31',
    'x-claude-code-session-id': 'sess-123',
    'x-deepseek-harness-user-id': 'dsh-u1',
    'x-forwarded-for': '203.0.113.10',
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'gw.example.com',
    'x-real-ip': '203.0.113.10',
    'true-client-ip': '203.0.113.10',
    forwarded: 'for=203.0.113.10;proto=https',
    via: '1.1 caddy',
    'cf-connecting-ip': '203.0.113.10',
    'cf-ray': '8f1234567890abcd-LAX',
    'cf-ipcountry': 'US',
    'cdn-loop': 'cloudflare; loops=1',
    authorization: `Bearer ${STRONG_TOKEN}`,
  };
  assert.equal(hasProxyForwardingHeaders(incoming), true);
  assert.equal(hasProxyForwardingHeaders({ 'user-agent': 'claude-cli/2.1.0' }), false);

  const provider = { name: 'p', apiKey: 'upstream-secret', authStyle: 'bearer', extraHeaders: {} };
  const strippedKeys = [
    'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip',
    'true-client-ip', 'forwarded', 'via', 'cf-connecting-ip', 'cf-ray', 'cf-ipcountry', 'cdn-loop',
  ];

  for (const headers of [
    buildHeaders(provider, incoming),
    buildOpenAIHeaders(provider, incoming, { targetModel: 'deepseek-chat' }),
    buildResponsesHeaders(provider, incoming),
  ]) {
    for (const key of strippedKeys) {
      assert.equal(headers[key], undefined, `expected ${key} to be stripped`);
    }
    assert.equal(headers.authorization, 'Bearer upstream-secret');
    assert.equal(headers['user-agent'], 'claude-cli/2.1.0');
    assert.equal(headers['anthropic-beta'], 'prompt-caching-2024-07-31');
    assert.equal(headers['x-deepseek-harness-user-id'], 'dsh-u1');
  }
});

test('strong clientToken enforcement applies on non-loopback host or GATEWAY_REQUIRE_STRONG_TOKEN=1', (t) => {
  const saved = {
    GATEWAY_HOST: process.env.GATEWAY_HOST,
    GATEWAY_CLIENT_TOKEN: process.env.GATEWAY_CLIENT_TOKEN,
    GATEWAY_REQUIRE_STRONG_TOKEN: process.env.GATEWAY_REQUIRE_STRONG_TOKEN,
  };
  t.after(() => {
    for (const [key, val] of Object.entries(saved)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  const baseRaw = {
    providers: [{ name: 'p', apiType: 'anthropic', baseUrl: 'https://example.invalid', apiKey: 'k' }],
    routes: {},
  };

  assert.equal(isWeakClientToken(''), true);
  assert.equal(isWeakClientToken('sk-local-gateway'), true);
  assert.equal(isWeakClientToken('sk-local-gateway-change-me'), true);
  assert.equal(isWeakClientToken('short-token'), true);
  assert.equal(isWeakClientToken(STRONG_TOKEN), false);

  // Local default remains backward-compatible for unit tests / localhost development.
  process.env.GATEWAY_HOST = '127.0.0.1';
  process.env.GATEWAY_CLIENT_TOKEN = '';
  process.env.GATEWAY_REQUIRE_STRONG_TOKEN = '0';
  assert.equal(loadConfig({ raw: baseRaw }).server.clientToken, 'sk-local-gateway');

  // Strict mode rejects missing, placeholder, and short tokens.
  process.env.GATEWAY_REQUIRE_STRONG_TOKEN = '1';
  assert.throws(() => loadConfig({ raw: baseRaw }), /clientToken/);
  assert.throws(() => loadConfig({ raw: { ...baseRaw, clientToken: 'sk-local-gateway-change-me' } }), /clientToken/);
  assert.throws(() => loadConfig({ raw: { ...baseRaw, clientToken: 'too-short' } }), /clientToken/);
  assert.equal(loadConfig({ raw: { ...baseRaw, clientToken: STRONG_TOKEN } }).server.clientToken, STRONG_TOKEN);

  // GATEWAY_CLIENT_TOKEN env fallback satisfies strong token requirement.
  process.env.GATEWAY_CLIENT_TOKEN = STRONG_TOKEN;
  assert.equal(loadConfig({ raw: baseRaw }).server.clientToken, STRONG_TOKEN);

  // Non-loopback host automatically enforces strong token even without GATEWAY_REQUIRE_STRONG_TOKEN.
  process.env.GATEWAY_REQUIRE_STRONG_TOKEN = '0';
  process.env.GATEWAY_CLIENT_TOKEN = '';
  process.env.GATEWAY_HOST = '0.0.0.0';
  assert.throws(() => loadConfig({ raw: baseRaw }), /clientToken/);
  assert.equal(loadConfig({ raw: { ...baseRaw, clientToken: STRONG_TOKEN } }).server.host, '0.0.0.0');
});

test('proxied /health hides internal topology, SSE disables proxy buffering, and shutdown drains in-flight requests', { timeout: 15000 }, async (t) => {
  let seenUpstreamHeaders = null;
  let releaseHold;
  const holdGate = new Promise((resolve) => { releaseHold = resolve; });
  let holdArrived = false;

  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      seenUpstreamHeaders = req.headers;
      const body = JSON.parse(raw);
      if (body.model === 'hold-drain') {
        holdArrived = true;
        await holdGate;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'msg_drain', type: 'message', role: 'assistant', model: body.model,
          content: [{ type: 'text', text: 'drained-ok' }], stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }));
        return;
      }
      if (body.model === 'sse-native') {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        res.end(
          'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":2}}}\n\n' +
          'data: {"type":"message_delta","usage":{"output_tokens":3}}\n\n' +
          'data: {"type":"message_stop"}\n\n'
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', choices: [{ index: 0, message: { content: 'ok' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  t.after(async () => {
    releaseHold();
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(r));
  });

  const dir = await mkdtemp(join(tmpdir(), 'gw-dedi-deploy-'));
  const configPath = join(dir, 'providers.json');
  await writeFile(configPath, JSON.stringify({
    clientToken: STRONG_TOKEN,
    logRequests: false,
    providers: [
      { name: 'anth', apiType: 'anthropic', baseUrl: `http://127.0.0.1:${upstream.address().port}`, apiKey: 'up-key' },
      { name: 'oai', apiType: 'openai', baseUrl: `http://127.0.0.1:${upstream.address().port}`, apiKey: 'up-key' },
    ],
    routes: {
      'sse-native': { provider: 'anth', model: 'sse-native' },
      'sse-adapted': { provider: 'oai', model: 'sse-adapted' },
      'hold-drain': { provider: 'anth', model: 'hold-drain' },
    },
  }));

  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      GATEWAY_CONFIG: configPath,
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: '0',
      GATEWAY_USAGE_DIR: 'off',
      GATEWAY_REQUIRE_STRONG_TOKEN: '1',
      GATEWAY_SHUTDOWN_TIMEOUT_MS: '5000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let logs = '';
  child.stdout.on('data', (c) => { logs += c; });
  child.stderr.on('data', (c) => { logs += c; });
  t.after(async () => {
    releaseHold();
    if (child.exitCode === null) {
      const done = once(child, 'exit');
      child.kill();
      await done;
    }
    await rm(dir, { recursive: true, force: true });
  });

  for (let i = 0; i < 100 && !/http:\/\/127\.0\.0\.1:\d+/.test(logs); i++) {
    if (child.exitCode !== null) throw new Error(logs);
    await new Promise((r) => setTimeout(r, 25));
  }
  const base = /http:\/\/127\.0\.0\.1:\d+/.exec(logs)?.[0];
  assert.ok(base, logs);
  const port = Number(new URL(base).port);

  const rawGet = (path, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end();
  });

  // 1. Direct local /health keeps full details for local CLI / Admin Web.
  const localHealth = await rawGet('/health', { host: `127.0.0.1:${port}` });
  assert.equal(localHealth.status, 200);
  assert.equal(localHealth.json.service, 'slizm-gateway');
  assert.ok(Array.isArray(localHealth.json.providers));
  assert.ok(localHealth.json.routes['sse-native']);

  // 2. Proxied /health (X-Forwarded-For or public Host) returns minimal {"status":"ok"} only.
  for (const headers of [
    { host: `127.0.0.1:${port}`, 'x-forwarded-for': '203.0.113.5' },
    { host: 'gw.example.com' },
    { host: 'gw.example.com', 'cf-ray': '12345-SJC' },
  ]) {
    const proxiedHealth = await rawGet('/health', headers);
    assert.equal(proxiedHealth.status, 200);
    assert.deepEqual(proxiedHealth.json, { status: 'ok' });

    const proxiedRoot = await rawGet('/', headers);
    assert.equal(proxiedRoot.status, 404);
  }

  // 3. Authenticated proxied /health still returns full operational details.
  const authedProxiedHealth = await rawGet('/health', {
    host: 'gw.example.com',
    'x-forwarded-for': '203.0.113.5',
    authorization: `Bearer ${STRONG_TOKEN}`,
  });
  assert.equal(authedProxiedHealth.status, 200);
  assert.equal(authedProxiedHealth.json.service, 'slizm-gateway');

  // 4. Native and adapted SSE responses both set x-accel-buffering: no, and strip proxy headers to upstream.
  const sseNative = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${STRONG_TOKEN}`,
      'x-forwarded-for': '203.0.113.5',
      'cdn-loop': 'cloudflare',
      'cf-ray': '99999-LAX',
    },
    body: JSON.stringify({ model: 'sse-native', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(sseNative.status, 200);
  assert.equal(sseNative.headers.get('x-accel-buffering'), 'no');
  assert.ok((await sseNative.text()).includes('message_stop'));
  assert.equal(seenUpstreamHeaders['x-forwarded-for'], undefined);
  assert.equal(seenUpstreamHeaders['cdn-loop'], undefined);
  assert.equal(seenUpstreamHeaders['cf-ray'], undefined);

  const sseAdapted = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${STRONG_TOKEN}` },
    body: JSON.stringify({ model: 'sse-adapted', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(sseAdapted.status, 200);
  assert.equal(sseAdapted.headers.get('x-accel-buffering'), 'no');
  assert.ok((await sseAdapted.text()).includes('message_stop'));

  // 5. Graceful shutdown drains in-flight request on POSIX (Windows SIGTERM terminates immediately).
  if (process.platform !== 'win32') {
    const inflight = fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${STRONG_TOKEN}` },
      body: JSON.stringify({ model: 'hold-drain', messages: [{ role: 'user', content: 'wait' }] }),
    });
    for (let i = 0; i < 60 && !holdArrived; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(holdArrived, true);
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(child.exitCode, null, 'gateway should wait for in-flight request before exiting');
    releaseHold();
    const drainRes = await inflight;
    assert.equal(drainRes.status, 200);
    assert.ok((await drainRes.text()).includes('drained-ok'));
    const [code] = await exited;
    assert.equal(code, 0);
  }
});
