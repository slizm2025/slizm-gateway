import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { upstreamFetch } from '../src/upstream-fetch.js';
import { buildOpenAIHeaders, parseCompletion, toAnthropicResponse } from '../src/providers/openai.js';
import { buildHeaders, listModels } from '../src/providers/anthropic.js';
import { openAIToAnthropicStream } from '../src/stream.js';
import childProcess, { spawn } from 'node:child_process';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createSseDecoder } from '../src/sse.js';
import { buildSwitchboardLive, buildOverview } from '../src/admin/data.js';
import { restartGateway } from '../src/admin/lifecycle.js';

const incoming = {
  'user-agent': 'claude-cli/fixture', 'x-app': 'cli', 'x-stainless-timeout': '600',
  'x-claude-code-session-id': 'claude-session', authorization: 'Bearer downstream-secret',
};
const provider = { name: 'mixed', apiKey: 'upstream-secret', extraHeaders: {} };
const completion = (usage) => ({ choices: [{ index: 0, message: { content: 'ok' }, finish_reason: 'stop' }], ...(usage ? { usage } : {}) });
const sse = (values) => new Response(values.map((v) => `data: ${typeof v === 'string' ? v : JSON.stringify(v)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); return new Promise((r) => server.close(r)); });
  return `http://127.0.0.1:${server.address().port}`;
}

for (const model of ['gpt-6-sol', 'openai/gpt-5', 'chatgpt-4o-latest', 'o3', 'o4-mini', 'codex-mini-latest']) {
  test(`automatic Codex profile for final target ${model}`, () => {
    const headers = buildOpenAIHeaders(provider, incoming, { targetModel: model });
    assert.ok(headers.originator);
    assert.ok(!headers['user-agent'].includes('claude-cli'));
    assert.equal(headers['x-stainless-timeout'], undefined);
    assert.equal(headers.authorization, 'Bearer upstream-secret');
  });
}
for (const model of ['deepseek-chat', 'gemini-test', 'claude-test', 'my-gpt-proxy']) {
  test(`other model ${model} retains complete Claude client headers`, () => {
    const headers = buildOpenAIHeaders(provider, incoming, { targetModel: model });
    assert.equal(headers['user-agent'], incoming['user-agent']);
    assert.equal(headers['x-stainless-timeout'], '600');
    assert.equal(headers['x-claude-code-session-id'], 'claude-session');
    assert.equal(headers.originator, undefined);
  });
}
test('profile override precedence and shared installation identity', () => {
  const p = { ...provider, clientProfile: 'codex' };
  const a = buildOpenAIHeaders(p, incoming);
  const b = buildOpenAIHeaders(p, incoming);
  assert.equal(a['x-codex-installation-id'], b['x-codex-installation-id']);
  assert.notEqual(a['x-client-request-id'], b['x-client-request-id']);
  assert.equal(buildOpenAIHeaders(p, incoming, { clientProfile: 'claude' })['user-agent'], incoming['user-agent']);
  assert.equal(buildOpenAIHeaders(p, incoming, { clientProfile: 'auto', targetModel: 'deepseek-chat' }).originator, undefined);
});
test('Claude fingerprint obeys Connection exclusions on OpenAI routes', () => {
  const h = buildOpenAIHeaders(provider, { ...incoming, connection: 'user-agent, x-app' });
  assert.equal(h['user-agent'], undefined);
  assert.equal(h['x-app'], undefined);
});
test('configured header overrides remain limited to OpenAI adapters', () => {
  for (const clientProfile of ['codex', 'claude']) {
    const h = buildOpenAIHeaders({ ...provider, extraHeaders: { Authorization: 'Bearer replacement', 'User-Agent': 'configured' } }, incoming, { clientProfile });
    assert.equal(h.authorization, 'Bearer replacement');
    assert.equal(h['user-agent'], 'configured');
    assert.equal(h.Authorization, undefined);
  }
  const anthropicHeaders = buildHeaders({ ...provider, apiType: 'anthropic', extraHeaders: { 'User-Agent': 'configured' } }, incoming);
  assert.equal(anthropicHeaders['user-agent'], incoming['user-agent']);
});
test('Anthropic compatibility transport preserves the incoming client profile', () => {
  const h = buildHeaders(provider, incoming, { targetModel: 'gpt-6-sol' });
  assert.equal(h['user-agent'], incoming['user-agent']);
  assert.equal(h['x-app'], incoming['x-app']);
  assert.equal(h['x-stainless-timeout'], incoming['x-stainless-timeout']);
  assert.equal(h['x-claude-code-session-id'], incoming['x-claude-code-session-id']);
  assert.equal(h.originator, undefined);
  assert.equal(h.authorization, 'Bearer upstream-secret');
});
test('Anthropic model discovery uses one upstream credential', async (t) => {
  let headers;
  const baseUrl = await serve(t, (req, res) => { headers = req.headers; res.end('{"data":[{"id":"m"}]}'); });
  assert.deepEqual(await listModels({ ...provider, baseUrl, authStyle: 'auto' }), ['m']);
  assert.equal(headers.authorization, 'Bearer upstream-secret');
  assert.equal(headers['x-api-key'], undefined);
});
test('decodes stacked Content-Encoding in reverse order', async (t) => {
  const baseUrl = await serve(t, (_req, res) => {
    const body = zlib.brotliCompressSync(zlib.gzipSync(Buffer.from('decoded')));
    res.writeHead(200, { 'content-encoding': 'gzip, br', 'content-length': body.length }); res.end(body);
  });
  const r = await upstreamFetch({}, baseUrl);
  assert.equal(await r.text(), 'decoded');
  assert.equal(r.headers.get('content-encoding'), null);
  assert.equal(r.headers.get('content-length'), null);
});
test('unknown Content-Encoding fails without permitting replay', async (t) => {
  const url = await serve(t, (_req, res) => { res.setHeader('content-encoding', 'unsupported'); res.end('x'); });
  await assert.rejects(upstreamFetch({}, url), (e) => e.beforeSend === false && e.upstreamPhase === 'response-headers');
});
for (const [encoding, compress] of Object.entries({ gzip: zlib.gzipSync, deflate: zlib.deflateSync, br: zlib.brotliCompressSync, ...(zlib.zstdCompressSync ? { zstd: zlib.zstdCompressSync } : {}) })) {
  test(`decodes ${encoding} and destroys a corrupt decoder safely`, async (t) => {
    const baseUrl = await serve(t, (req, res) => { res.setHeader('content-encoding', encoding); res.end(req.url === '/bad' ? Buffer.from('not compressed') : compress(Buffer.from('ok'))); });
    assert.equal(await (await upstreamFetch({}, baseUrl)).text(), 'ok');
    const bad = await upstreamFetch({}, baseUrl + '/bad');
    await assert.rejects(bad.text());
  });
}
test('shared SSE decoder handles split CRLF, multibyte text and multiple data lines', () => {
  const payloads = [];
  const decoder = createSseDecoder((p) => payloads.push(p));
  const bytes = Buffer.from('data: {"value":\r\ndata: "\u4e2d\u6587"}\r\n\r\n');
  for (const byte of bytes) decoder.push(Uint8Array.of(byte));
  decoder.end();
  assert.deepEqual(payloads.map(JSON.parse), [{ value: '\u4e2d\u6587' }]);
});
test('valid usage before an oversized event in the same chunk is retained', async () => {
  const samples = [];
  const raw = 'data: {"choices":[{"index":0,"delta":{"content":"ok"}}],"usage":{"prompt_tokens":8}}\n\ndata: ' + 'x'.repeat(4 * 1024 * 1024 + 1);
  const text = await new Response(openAIToAnthropicStream(new Response(raw).body, 'm', { onUsage: (u) => samples.push(u) })).text();
  assert.equal(samples[0].input_tokens, 8);
  assert.ok(text.includes('event: error'));
  assert.ok(!text.includes('event: message_stop'));
});
test('DONE without finish_reason cannot authorize a partial tool call', async () => {
  const values = [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call', function: { name: 'exec', arguments: '{}' } }] } }] }, '[DONE]'];
  await assert.rejects(parseCompletion(sse(values)));
  const text = await new Response(openAIToAnthropicStream(sse(values).body, 'm')).text();
  assert.ok(text.includes('event: error'));
  assert.ok(!text.includes('event: message_stop'));
  assert.ok(!text.includes('"name":"exec"'));
});
test('buffered SSE selects choice zero, consistent with streaming', async () => {
  const r = await parseCompletion(sse([{ choices: [
    { index: 1, delta: { content: 'wrong' }, finish_reason: 'stop' },
    { index: 0, delta: { content: 'right' }, finish_reason: 'stop' },
  ] }, '[DONE]']));
  assert.equal(r.choices[0].message.content, 'right');
});
test('unreported usage stays absent for JSON and buffered SSE', async () => {
  assert.deepEqual(toAnthropicResponse(completion(), 'm').usage, {});
  const c = await parseCompletion(sse([{ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]']));
  assert.deepEqual(toAnthropicResponse(c, 'm').usage, {});
});
test('partial streaming usage does not erase already reported input/cache', async () => {
  const samples = [];
  const values = [
    { choices: [{ index: 0, delta: { content: 'ok' } }], usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 6 } } },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 2 } }, '[DONE]',
  ];
  await new Response(openAIToAnthropicStream(sse(values).body, 'm', { onUsage: (u) => samples.push(u) })).text();
  assert.deepEqual(samples.at(-1), { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 6 });
});
test('explicit proxy env must resolve instead of silently connecting directly', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gw-config-hardening-'));
  const before = process.env.GATEWAY_CONFIG;
  process.env.GATEWAY_CONFIG = join(dir, 'providers.json');
  t.after(async () => { if (before === undefined) delete process.env.GATEWAY_CONFIG; else process.env.GATEWAY_CONFIG = before; await rm(dir, { recursive: true, force: true }); });
  const base = { providers: [{ name: 'p', baseUrl: 'https://example.invalid', apiKey: 'fixture', proxy: 'env:GW_MISSING_PROXY_FOR_TEST_917' }], routes: {} };
  await writeFile(process.env.GATEWAY_CONFIG, JSON.stringify(base));
  assert.throws(loadConfig, /GW_MISSING_PROXY_FOR_TEST_917/);
  delete base.providers[0].proxy;
  base.providers[0].clientProfile = 'auto';
  base.providers[0].requireKey = false;
  await writeFile(process.env.GATEWAY_CONFIG, JSON.stringify(base));
  assert.equal(loadConfig().providers.get('p').requireKey, false);
});

test('gateway profile routing, retry identity and optional upstream authentication', { timeout: 15000 }, async (t) => {
  const seen = [];
  let releaseHang;
  const hangGate = new Promise((resolve) => { releaseHang = resolve; });
  let releaseCount;
  const countGate = new Promise((resolve) => { releaseCount = resolve; });
  const baseUrl = await serve(t, (req, res) => {
    let raw = '';
    req.on('data', (c) => raw += c);
    req.on('end', () => {
      const body = JSON.parse(raw);
      seen.push({ body, headers: req.headers, path: req.url });
      if (body.model === 'hang-active' && !req.url.endsWith('count_tokens')) {
        return hangGate.then(() => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ type: 'message', role: 'assistant', id: 'msg_hang', content: [{ type: 'text', text: 'ok' }], model: body.model, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
        });
      }
      if (body.model === 'count-active' && req.url.endsWith('count_tokens')) {
        return countGate.then(() => res.end('{"input_tokens":7}'));
      }
      if (body.model === 'gpt-retry' && seen.filter((x) => x.body.model === body.model).length === 1) {
        res.writeHead(429, { 'retry-after': '0' }); res.end('busy'); return;
      }
      res.setHeader('content-type', 'application/json');
      if (body.model === 'claude-cr') {
        res.setHeader('content-type', 'text/event-stream');
        res.end('data: {"type":"message_start",\rdata: "message":{"usage":{"input_tokens":11}}}\r\rdata: {"type":"message_delta","usage":{"output_tokens":3}}\r\rdata: {"type":"message_stop"}\r\r');
        return;
      }
      if (req.url.endsWith('count_tokens')) res.end('{"input_tokens":7}');
      else if (req.url.endsWith('/v1/messages')) res.end(JSON.stringify({ type: 'message', role: 'assistant', id: 'msg_x', content: [{ type: 'text', text: 'ok' }], model: body.model, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
      else res.end(JSON.stringify(completion()));
    });
  });
  const dir = await mkdtemp(join(tmpdir(), 'gw-profile-e2e-'));
  const path = join(dir, 'providers.json');
  await writeFile(path, JSON.stringify({ clientToken: 'client-fixture', providers: [
    { name: 'mixed', baseUrl, apiKey: 'key', apiType: 'openai', messagesTransport: 'chat-completions', models: { inner: 'gpt-retry' } },
    { name: 'anon', baseUrl, apiType: 'openai', messagesTransport: 'chat-completions', requireKey: false },
    { name: 'anth', baseUrl, apiKey: 'key', apiType: 'anthropic' },
    { name: 'gemini', baseUrl, apiKey: 'key', apiType: 'gemini' },
  ], routes: {
    alias: { provider: 'mixed', model: 'inner' }, deep: { provider: 'mixed', model: 'deepseek-test' },
    forced: { provider: 'mixed', model: 'gpt-test', clientProfile: 'claude' },
    anonymous: { provider: 'anon', model: 'test' }, anth: { provider: 'anth', model: 'gpt-test' },
    'hang-active': { provider: 'anth', model: 'hang-active' },
    'count-active': { provider: 'anth', model: 'count-active' },
    gemini: { provider: 'gemini', model: 'gemini-test' },
    cr: { provider: 'anth', model: 'claude-cr' },
  } }));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, GATEWAY_CONFIG: path, GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: '0', GATEWAY_USAGE_DIR: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let logs = '';
  child.stdout.on('data', (c) => logs += c); child.stderr.on('data', (c) => logs += c);
  t.after(async () => {
    if (child.exitCode === null) { const done = once(child, 'exit'); child.kill(); await done; }
    await rm(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 100 && !/http:\/\/127\.0\.0\.1:\d+/.test(logs); i++) {
    if (child.exitCode !== null) throw new Error(logs);
    await new Promise((r) => setTimeout(r, 25));
  }
  const gateway = /http:\/\/127\.0\.0\.1:\d+/.exec(logs)?.[0];
  assert.ok(gateway, logs);
  const send = async (model, endpoint = '/v1/messages') => {
    const response = await fetch(gateway + endpoint, { method: 'POST', headers: { ...incoming, authorization: 'Bearer client-fixture' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hello' }] }), signal: AbortSignal.timeout(5000) });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
  };
  const activeRequest = fetch(gateway + '/v1/messages', {
    method: 'POST', headers: { ...incoming, authorization: 'Bearer client-fixture' },
    body: JSON.stringify({ model: 'hang-active', messages: [{ role: 'user', content: 'hold' }] }),
  });
  for (let i = 0; i < 40; i++) {
    const stats = await (await fetch(gateway + '/v1/usage', { headers: { authorization: 'Bearer client-fixture' } })).json();
    if (stats.inflight?.some((item) => item.model === 'hang-active')) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const countRequest = fetch(gateway + '/v1/messages/count_tokens', {
    method: 'POST', headers: { ...incoming, authorization: 'Bearer client-fixture' },
    body: JSON.stringify({ model: 'count-active', messages: [{ role: 'user', content: 'count' }] }),
  });
  for (let i = 0; i < 40 && !seen.some((item) => item.body.model === 'count-active' && item.path.endsWith('count_tokens')); i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const concurrentStats = await (await fetch(gateway + '/v1/usage', { headers: { authorization: 'Bearer client-fixture' } })).json();
  assert.equal(concurrentStats.inflight.filter((item) => item.model === 'hang-active').length, 1);
  assert.ok(seen.some((item) => item.body.model === 'count-active' && item.path.endsWith('count_tokens')), 'token count must reach the upstream before sampling');
  assert.equal(concurrentStats.activeRequests, 2, 'HTTP activity must include inference and token counting for restart protection');
  assert.equal(concurrentStats.inflight.length, 1, 'token counting must not create inference topology or usage entries');
  const concurrentHealth = await (await fetch(gateway + '/health')).json();
  assert.equal(concurrentHealth.activeRequests, 2, 'health must expose HTTP activity, not just inference activity');
  releaseCount();
  releaseHang();
  await (await countRequest).json();
  await (await activeRequest).json();
  await send('alias');
  const attempts = seen.filter((r) => r.body.model === 'gpt-retry');
  assert.equal(attempts.length, 2);
  for (const key of ['user-agent', 'session-id', 'thread-id', 'x-client-request-id', 'x-codex-turn-metadata']) assert.equal(attempts[0].headers[key], attempts[1].headers[key]);
  assert.ok(attempts[0].headers.originator);
  await send('deep'); assert.equal(seen.at(-1).headers['x-stainless-timeout'], '600');
  await send('forced'); assert.equal(seen.at(-1).headers['user-agent'], incoming['user-agent']);
  await send('anonymous'); assert.equal(seen.at(-1).headers.authorization, undefined);
  await send('anth');
  assert.equal(seen.at(-1).headers['user-agent'], incoming['user-agent']);
  assert.equal(seen.at(-1).headers['x-app'], incoming['x-app']);
  assert.equal(seen.at(-1).headers['x-stainless-timeout'], incoming['x-stainless-timeout']);
  assert.equal(seen.at(-1).headers.originator, undefined);
  assert.equal(seen.at(-1).headers.authorization, 'Bearer key');
  await send('anth', '/v1/messages/count_tokens');
  assert.equal(seen.at(-1).headers['user-agent'], incoming['user-agent']);
  assert.equal(seen.at(-1).headers.originator, undefined);
  await send('gemini'); assert.equal(seen.at(-1).headers.originator, undefined);
  assert.equal(seen.at(-1).path, '/v1beta/openai/chat/completions');
  const cr = await fetch(gateway + '/v1/messages', { method: 'POST', headers: { authorization: 'Bearer client-fixture' }, body: JSON.stringify({ model: 'cr', stream: true, messages: [{ role: 'user', content: 'hello' }] }) });
  assert.ok((await cr.text()).includes('message_stop'));
  const stats = await (await fetch(gateway + '/v1/usage', { headers: { authorization: 'Bearer client-fixture' } })).json();
  assert.equal(stats.routes.alias.unreported, 1);
  assert.equal(stats.routes.cr.successes, 1);
  assert.equal(stats.routes.cr.reportedInputTokens, 11);
  assert.equal(stats.routes.cr.reportedOutputTokens, 3);
});

test('HTTP activity protects token counting and incomplete uploads without inventing switchboard traffic', { timeout: 15000 }, async (t) => {
  let releaseCount;
  let countArrived = false;
  let holdInference = false;
  const inferenceResponses = [];
  const finishInference = (res) => res.end(JSON.stringify({ type: 'message', role: 'assistant', id: 'msg_upload', content: [{ type: 'text', text: 'ok' }], model: 'test', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
  const countGate = new Promise((resolve) => { releaseCount = resolve; });
  const baseUrl = await serve(t, (req, res) => {
    req.resume();
    req.on('end', async () => {
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith('/count_tokens')) {
        countArrived = true;
        await countGate;
        res.end('{"input_tokens":7}');
      } else if (holdInference) {
        inferenceResponses.push(res);
      } else {
        finishInference(res);
      }
    });
  });
  const dir = await mkdtemp(join(tmpdir(), 'gw-http-activity-'));
  const configPath = join(dir, 'providers.json');
  const rawConfig = { clientToken: 'http-fixture', logRequests: false,
    providers: [{ name: 'anth', apiType: 'anthropic', baseUrl, apiKey: 'test-key' }],
    routes: { test: { provider: 'anth', model: 'test' } } };
  await writeFile(configPath, JSON.stringify(rawConfig));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, GATEWAY_CONFIG: configPath, GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: '0', GATEWAY_USAGE_DIR: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let logs = '';
  child.stdout.on('data', (c) => logs += c);
  child.stderr.on('data', (c) => logs += c);
  t.after(async () => {
    releaseCount();
    if (child.exitCode === null) { const done = once(child, 'exit'); child.kill(); await done; }
    await rm(dir, { recursive: true, force: true });
  });
  const waitFor = async (predicate, message) => {
    for (let i = 0; i < 80; i++) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(message);
  };
  await waitFor(() => /http:\/\/127\.0\.0\.1:\d+/.test(logs), logs || 'gateway did not start');
  const gateway = /http:\/\/127\.0\.0\.1:\d+/.exec(logs)[0];
  const headers = { ...incoming, authorization: 'Bearer http-fixture' };
  const health = async () => (await fetch(gateway + '/health', { signal: AbortSignal.timeout(2000) })).json();
  const stats = async () => (await fetch(gateway + '/v1/usage', { headers, signal: AbortSignal.timeout(2000) })).json();
  const savedEnv = Object.fromEntries(['GATEWAY_CONFIG', 'GATEWAY_HOST', 'GATEWAY_PORT'].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { GATEWAY_CONFIG: configPath, GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: new URL(gateway).port });
  // Guard against invoking a real restart even if the lifecycle check regresses.
  const execMock = t.mock.method(childProcess, 'execFile', () => assert.fail('busy gateway must not execute a restart command'));
  syncBuiltinESMExports();
  t.after(() => {
    execMock.mock.restore();
    syncBuiltinESMExports();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const cfg = loadConfig({ raw: rawConfig });
  const assertBusyWithoutTopology = async () => {
    const status = { ...await health(), online: true, stats: await stats() };
    assert.equal(status.activeRequests, 1, 'health must protect a non-inference HTTP request');
    assert.equal(status.stats.activeRequests, 1, 'usage must preserve the global HTTP activity contract');
    assert.equal(status.stats.inflight.length, 0);
    const live = await buildSwitchboardLive({ cfg, getGateway: async () => status });
    const overview = await buildOverview({ cfg, ledgerDir: null, getGateway: async () => status });
    assert.equal(live.activeRequests, 1);
    assert.equal(live.switchboardActiveRequests, 0);
    assert.equal(live.switchboardActive.length, 0);
    assert.equal(overview.gateway.activeRequests, 1);
    assert.equal(overview.switchboardActiveRequests, 0);
    await assert.rejects(restartGateway(), { statusCode: 409 });
    assert.equal(execMock.mock.callCount(), 0);
  };
  await t.test('upstream token counting remains protected but unbilled', async () => {
    const request = fetch(gateway + '/v1/messages/count_tokens', { method: 'POST', headers,
      body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'count' }] }), signal: AbortSignal.timeout(10000) });
    try {
      await waitFor(() => countArrived, 'token request did not arrive');
      await assertBusyWithoutTopology();
    } finally {
      releaseCount();
      assert.deepEqual(await (await request).json(), { input_tokens: 7 });
    }
    await waitFor(async () => (await health()).activeRequests === 0, 'token completion did not release HTTP activity');
    assert.equal((await stats()).totals.requests, 0, 'token counting must not add billed inference usage');
  });
  await t.test('a second inference from the same agent has its own live request and survives the first completion', async () => {
    const requests = [];
    const send = () => {
      const request = fetch(gateway + '/v1/messages', { method: 'POST', headers,
        body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hold' }] }), signal: AbortSignal.timeout(10000) });
      request.catch(() => {});
      requests.push(request);
    };
    holdInference = true;
    try {
      send();
      await waitFor(() => inferenceResponses.length === 1, 'first inference did not reach the upstream');
      const firstId = (await stats()).inflight[0].requestId;
      send();
      await waitFor(() => inferenceResponses.length === 2, 'second inference did not reach the upstream');
      const concurrent = await stats();
      assert.equal(concurrent.activeRequests, 2);
      assert.equal(concurrent.inflight.length, 2);
      assert.equal(new Set(concurrent.inflight.map((item) => item.requestId)).size, 2, 'same-agent requests require distinct identities');
      assert.ok(concurrent.inflight.every((item) => item.clientType === 'claude-code'));
      const live = await buildSwitchboardLive({ cfg, getGateway: async () => ({ ...await health(), online: true, stats: concurrent }) });
      assert.equal(live.switchboardActiveRequests, 2);
      assert.equal(live.switchboardActive.length, 2);
      finishInference(inferenceResponses[0]);
      assert.equal((await requests[0]).status, 200);
      await (await requests[0]).json();
      await waitFor(async () => (await stats()).activeRequests === 1, 'first inference did not release its activity');
      const remaining = await stats();
      assert.equal(remaining.inflight.length, 1);
      assert.notEqual(remaining.inflight[0].requestId, firstId, 'first completion must not remove the second request');
      await assert.rejects(restartGateway(), { statusCode: 409 });
      finishInference(inferenceResponses[1]);
      assert.equal((await requests[1]).status, 200);
      await (await requests[1]).json();
    } finally {
      holdInference = false;
      for (const res of inferenceResponses) if (!res.writableEnded) finishInference(res);
      await Promise.allSettled(requests.map(async (request) => (await request).body?.cancel()));
    }
    await waitFor(async () => (await health()).activeRequests === 0, 'second inference did not release HTTP activity');
    assert.equal((await stats()).inflight.length, 0);
  });
  const upload = () => {
    const body = JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'upload' }] });
    const request = http.request(gateway + '/v1/messages', { method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) } });
    const result = new Promise((resolve, reject) => {
      request.on('error', reject);
      request.on('response', (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
        res.on('error', reject);
      });
    });
    result.catch(() => {});
    t.after(() => request.destroy());
    request.write(body.slice(0, -1));
    return { request, result };
  };
  await t.test('an incomplete prompt upload blocks restart until it completes', async () => {
    const { request, result } = upload();
    try {
      await waitFor(async () => (await health()).activeRequests === 1, 'incomplete upload is missing from HTTP activity');
      await assertBusyWithoutTopology();
      request.end('}');
      assert.equal(await result, 200);
    } finally { request.destroy(); }
    await waitFor(async () => (await health()).activeRequests === 0, 'upload completion did not release HTTP activity');
  });
  await t.test('a cancelled prompt upload releases HTTP activity', async () => {
    const before = (await stats()).totals.requests;
    const { request, result } = upload();
    try {
      await waitFor(async () => (await health()).activeRequests === 1, 'cancelled upload was never tracked');
      await assertBusyWithoutTopology();
    } finally { request.destroy(); await result.catch(() => {}); }
    await waitFor(async () => (await health()).activeRequests === 0, 'upload cancellation leaked HTTP activity');
    assert.equal((await stats()).totals.requests, before, 'cancelled uploads must not become inference usage');
  });
});
