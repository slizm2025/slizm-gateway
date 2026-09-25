import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { buildOpenAIBody, parseCompletion } from '../src/providers/openai.js';
import { openAIToAnthropicStream } from '../src/stream.js';
import { retryDelayMs, withUpstream, gateStats } from '../src/limiter.js';
import { upstreamFetch } from '../src/upstream-fetch.js';

const wire = (data) => new Response(data, { headers: { 'content-type': 'text/event-stream' } });
const chunk = (delta, finish_reason = null) => JSON.stringify({ id: 'up-1', choices: [{ index: 0, delta, finish_reason }] });
const readStream = (text) => new Response(openAIToAnthropicStream(wire(text).body, 'alias')).text();

test('tool results preserve accompanying user text', () => {
  const out = buildOpenAIBody({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'done' }, { type: 'text', text: 'next instruction' }] }] }, 'm');
  assert.deepEqual(out.messages, [{ role: 'tool', tool_call_id: 'x', content: 'done' }, { role: 'user', content: 'next instruction' }]);
});

for (const [name, text] of [
  ['truncated', `data: ${chunk({ content: 'partial' })}\n\n`],
  ['upstream error', 'data: {"error":{"message":"quota"}}\n\n'],
  ['malformed', 'data: {oops}\n\ndata: [DONE]\n\n'],
]) {
  test(`stream rejects ${name} instead of fabricating message_stop`, async () => {
    const textOut = await readStream(text);
    assert.ok(textOut.includes('event: error'), textOut);
    assert.ok(!textOut.includes('event: message_stop'), textOut);
  });
  test(`nonstream SSE rejects ${name}`, async () => {
    await assert.rejects(parseCompletion(wire(text)));
  });
}

test('SSE frames support multiline data and CR line endings', async () => {
  const data = 'data: {"choices":\rdata: [{"index":0,"delta":{"content":"你好"},"finish_reason":"stop"}]}\r\rdata: [DONE]\r\r';
  const out = await readStream(data);
  assert.ok(out.includes('你好'), out);
  assert.ok(out.includes('event: message_stop'));
  assert.equal((await parseCompletion(wire(data))).choices[0].message.content, '你好');
});

test('tool fragments keep full name and unique block indexes', async () => {
  const payloads = [chunk({ tool_calls: [{ index: 0, id: 'call-x', function: { name: 'get_', arguments: '' } }] }), chunk({ tool_calls: [{ index: 0, function: { name: 'weather', arguments: '{"city":"X"}' } }] }, 'tool_calls'), '[DONE]'];
  const out = await readStream(payloads.map((p) => `data: ${p}\n\n`).join(''));
  assert.ok(out.includes('get_weather'), out);
  assert.ok(out.includes('call-x'));
});

test('reasoning_content delta is converted to thinking block in stream and completion', async () => {
  const streamPayloads = [
    `data: ${chunk({ reasoning_content: 'thinking step 1' })}\n\n`,
    `data: ${chunk({ reasoning_content: ' and 2' })}\n\n`,
    `data: ${chunk({ content: 'final answer' }, 'stop')}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
  const out = await readStream(streamPayloads);
  assert.ok(out.includes('"type":"thinking"'), out);
  assert.ok(out.includes('thinking step 1'), out);
  assert.ok(out.includes('final answer'), out);

  const nonStreamData = wire(streamPayloads);
  const parsed = await parseCompletion(nonStreamData);
  assert.equal(parsed.choices[0].message.reasoning_content, 'thinking step 1 and 2');
  assert.equal(parsed.choices[0].message.content, 'final answer');
});

test('retry-after is not shortened to twenty seconds', () => {
  assert.ok(retryDelayMs(new Response('', { status: 429, headers: { 'retry-after': '60' } }), 1) >= 60000);
});

test('nonretryable error holds its concurrency token until body consumed', async () => {
  const p = { name: 'audit-error-body', maxConcurrency: 1, maxAttempts: 1 };
  const first = await withUpstream(p, async () => new Response('error', { status: 400 }));
  try { assert.equal(gateStats()[p.name].active, 1); } finally { first.release(); }
  assert.equal(gateStats()[p.name].active, 0);
});

test('explicit upstream retry refusal prevents replay', async () => {
  let hits = 0;
  const result = await withUpstream({ name: 'explicit-no-retry', maxAttempts: 2 }, async () => {
    hits++;
    return new Response('do not replay', { status: 503, headers: { 'x-should-retry': 'false', 'retry-after': '0' } });
  });
  result.release();
  assert.equal(hits, 1);
});

test('incomplete final SSE frame is not a successful completion', async () => {
  const out = await readStream(`data: ${chunk({ content: 'partial' }, 'stop')}`);
  assert.ok(out.includes('event: error'));
  assert.ok(!out.includes('event: message_stop'));
});

test('upstream 205 response does not crash the request listener', async (t) => {
  const srv = http.createServer((req, res) => { res.writeHead(205); res.end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => { srv.closeAllConnections(); srv.close(); });
  const res = await upstreamFetch({}, `http://127.0.0.1:${srv.address().port}`, { signal: AbortSignal.timeout(2000) });
  assert.equal(res.status, 205);
  assert.equal(await res.text(), '');
});

test('gateway end-to-end audit', async (t) => {
  const secret = 'fake-provider-secret-audit-123';
  let observed;
  const hits = new Map();
  const stalledSockets = new Set();
  const stalledTls = net.createServer((socket) => {
    stalledSockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => stalledSockets.delete(socket));
    socket.resume();
  });
  await new Promise((r) => stalledTls.listen(0, '127.0.0.1', r));
  t.after(async () => {
    for (const socket of stalledSockets) socket.destroy();
    await new Promise((r) => stalledTls.close(r));
  });
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => raw += c);
    req.on('end', () => {
      const body = JSON.parse(raw);
      observed = body;
      hits.set(body.model, (hits.get(body.model) ?? 0) + 1);
      if (body.model === 'header-stall') return;
      if (body.model === 'body-stall') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"choices":[');
        return;
      }
      if (body.model === 'reset') return req.socket.destroy();
      if (body.model === 'bad') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: secret } })); }
      if (req.url.endsWith('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"input_tokens":7}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', choices: [{ message: { content: 'json fallback' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3 } }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const dir = await mkdtemp(join(tmpdir(), 'gw-audit-'));
  const config = join(dir, 'providers.json');
  await writeFile(config, JSON.stringify({ clientToken: 'audit-client', providers: [
    { name: 'oai', apiType: 'openai', apiKey: secret, baseUrl: `http://127.0.0.1:${upstream.address().port}`, maxAttempts: 1 },
    { name: 'anth', apiType: 'anthropic', apiKey: secret, baseUrl: `http://127.0.0.1:${upstream.address().port}`, models: { mapped: 'actual' } },
    { name: 'tls-timeout', apiType: 'openai', apiKey: secret, baseUrl: `https://127.0.0.1:${stalledTls.address().port}`, connectTimeoutMs: 250, requestTimeoutMs: 5000, maxAttempts: 1 },
    { name: 'deadline', apiType: 'openai', apiKey: secret, baseUrl: `http://127.0.0.1:${upstream.address().port}`, requestTimeoutMs: 500, maxAttempts: 3 },
  ], routes: { test: { provider: 'oai', model: 'test' }, reset: { provider: 'oai', model: 'reset' }, bad: { provider: 'oai', model: 'bad' }, count: { provider: 'anth', model: 'mapped' }, 'tls-stall': { provider: 'tls-timeout' }, 'header-stall': { provider: 'deadline' }, 'body-stall': { provider: 'deadline' } } }));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const reservation = http.createServer();
  await new Promise((r) => reservation.listen(0, '127.0.0.1', r));
  const port = reservation.address().port;
  await new Promise((r) => reservation.close(r));
  const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env: { ...process.env, GATEWAY_CONFIG: config, GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let logs = '';
  child.stdout.on('data', (c) => logs += c);
  child.stderr.on('data', (c) => logs += c);
  t.after(async () => {
    if (child.exitCode === null) { const done = once(child, 'exit'); child.kill(); await done; }
    upstream.closeAllConnections(); await new Promise((r) => upstream.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let n = 0; n < 100; n++) {
    try { ready = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(200) })).ok; } catch {}
    if (ready) break;
    if (child.exitCode !== null) throw new Error(logs);
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.ok(ready, logs);
  const post = (body, path = '/v1/messages') => fetch(base + path, { method: 'POST', headers: { authorization: 'Bearer audit-client', 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
  await t.test('invalid body is 400, not internal 500', async () => {
    for (const body of [null, [], {}, { model: 'test', messages: [null] }]) { const r = await post(body); await r.text(); assert.equal(r.status, 400); }
  });
  await t.test('JSON response to streaming OpenAI request is converted', async () => {
    const r = await post({ model: 'test', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const text = await r.text(); assert.equal(r.status, 200); assert.ok(text.includes('json fallback'), text); assert.ok(text.includes('message_stop'));
    assert.match(r.headers.get('x-request-id'), /^gw_[0-9a-f]{8}$/);
  });
  await t.test('usage endpoint reports provider and route token totals', async () => {
    const r = await fetch(`${base}/v1/usage`, { headers: { authorization: 'Bearer audit-client' } });
    assert.equal(r.status, 200);
    const usage = await r.json();
    assert.equal(usage.activeRequests, 0);
    assert.ok(usage.totals.requests >= 1, JSON.stringify(usage));
    assert.ok(usage.totals.reportedInputTokens >= 2, JSON.stringify(usage));
    assert.ok(usage.totals.reportedOutputTokens >= 3, JSON.stringify(usage));
    assert.ok(usage.providers.oai.reportedInputTokens >= 2, JSON.stringify(usage));
    assert.ok(usage.routes.test.reportedOutputTokens >= 3, JSON.stringify(usage));
    assert.equal(usage.models.test.requests >= 1, true);
    const denied = await fetch(`${base}/v1/usage`);
    assert.equal(denied.status, 401);
    await denied.text();
  });
  await t.test('uncertain delivery forbids automatic SDK replay', async () => {
    const r = await post({ model: 'reset', messages: [{ role: 'user', content: 'hi' }] });
    const text = await r.text();
    assert.equal(r.status, 502); assert.equal(r.headers.get('x-should-retry'), 'false');
    assert.equal(r.headers.get('x-upstream-phase'), 'response-headers');
    assert.match(r.headers.get('x-upstream-elapsed-ms'), /^\d+$/);
    assert.ok(text.includes('via direct'));
    assert.equal(hits.get('reset'), 1);
  });
  await t.test('TLS connection deadline reports 504 with pre-send diagnostics', async () => {
    const r = await post({ model: 'tls-stall', messages: [{ role: 'user', content: 'hi' }] });
    const value = await r.json();
    assert.equal(r.status, 504);
    assert.equal(value.error.type, 'timeout_error');
    assert.ok(value.error.message.includes('GATEWAY_CONNECT_TIMEOUT'));
    assert.equal(r.headers.get('x-upstream-phase'), 'tls-handshake');
    assert.match(r.headers.get('x-upstream-elapsed-ms'), /^\d+$/);
  });
  for (const [model, phase] of [['header-stall', 'response-headers'], ['body-stall', 'response-body']]) {
    await t.test(`${model} deadline reports 504 without replay`, async () => {
      const r = await post({ model, messages: [{ role: 'user', content: 'hi' }] });
      const value = await r.json();
      assert.equal(r.status, 504);
      assert.equal(value.error.type, 'timeout_error');
      assert.equal(r.headers.get('x-should-retry'), 'false');
      assert.equal(r.headers.get('x-upstream-phase'), phase);
      assert.match(r.headers.get('x-upstream-elapsed-ms'), /^\d+$/);
      assert.equal(hits.get(model), 1);
      const gates = await (await fetch(base + '/v1/gate-stats', { headers: { authorization: 'Bearer audit-client' } })).json();
      assert.equal(gates.deadline.active, 0);
      assert.equal(gates.deadline.waiting, 0);
    });
  }
  await t.test('provider secrets are redacted in errors and health', async () => {
    const r = await post({ model: 'bad', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 401); assert.ok(!(await r.text()).includes(secret));
    assert.ok(!(await (await fetch(`${base}/health`)).text()).includes(secret.slice(0, 6)));
  });
  await t.test('count_tokens resolves provider model mappings', async () => {
    const r = await post({ model: 'count', messages: [{ role: 'user', content: 'hi' }] }, '/v1/messages/count_tokens');
    assert.equal((await r.json()).input_tokens, 7); assert.equal(observed.model, 'actual');
  });
  await t.test('model listing and authentication stay available', async () => {
    assert.equal((await fetch(`${base}/v1/models`)).status, 401);
    const r = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer audit-client' } });
    assert.equal((await r.json()).data.length, 7);
  });
});
