import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { upstreamFetch } from '../src/upstream-fetch.js';
import { isSafeToRetryNetworkError } from '../src/limiter.js';
import { toAnthropicResponse } from '../src/providers/openai.js';
import { openAIToAnthropicStream } from '../src/stream.js';

async function fixture(t, server) {
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('error', () => {}); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { for (const s of sockets) s.destroy(); return new Promise((r) => server.close(r)); });
  return server.address().port;
}

for (const mode of ['TLS', 'CONNECT']) {
  test(`${mode} stall has a pre-send connection deadline`, { timeout: 4000 }, async (t) => {
    const server = mode === 'TLS' ? net.createServer((s) => s.resume()) : http.createServer();
    if (mode === 'CONNECT') server.on('connect', (_req, socket) => socket.resume());
    const port = await fixture(t, server);
    const provider = { connectTimeoutMs: 80, ...(mode === 'CONNECT' ? { proxy: `http://127.0.0.1:${port}` } : {}) };
    const target = mode === 'CONNECT' ? 'https://proxy-only.invalid/v1/messages' : `https://localhost:${port}/v1/messages`;
    await assert.rejects(upstreamFetch(provider, target, { method: 'POST', body: '{}', signal: AbortSignal.timeout(2000) }), (e) => {
      assert.equal(e.cause?.code, 'GATEWAY_CONNECT_TIMEOUT');
      assert.equal(e.upstreamPhase, mode === 'TLS' ? 'tls-handshake' : 'proxy-connect');
      assert.equal(isSafeToRetryNetworkError(e), true);
      assert.ok(e.upstreamElapsedMs >= 0);
      return true;
    });
  });
}

test('connect deadline stops at connection and does not cut off generation', async (t) => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const timer = setTimeout(() => res.end('complete'), 160);
      res.on('close', () => clearTimeout(timer));
    });
  });
  const port = await fixture(t, server);
  const response = await upstreamFetch({ connectTimeoutMs: 80 }, `http://127.0.0.1:${port}`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(2000) });
  assert.equal(await response.text(), 'complete');
});

test('sent request reset reports phase and duration without replay permission', async (t) => {
  const server = http.createServer((req) => { req.resume(); req.on('end', () => req.socket.destroy()); });
  const port = await fixture(t, server);
  await assert.rejects(upstreamFetch({}, `http://127.0.0.1:${port}`, { method: 'POST', body: '{}' }), (e) => {
    assert.equal(e.upstreamPhase, 'response-headers');
    assert.equal(isSafeToRetryNetworkError(e), false);
    assert.equal(typeof e.upstreamElapsedMs, 'number');
    return true;
  });
});

for (const input of ['{invalid', '[]', 'null', '42', '"text"']) {
  test(`JSON tool rejects invalid object input ${input}`, () => {
    assert.throws(() => toAnthropicResponse({ choices: [{ message: { tool_calls: [{ id: 'call1', function: { name: 'execute', arguments: input } }] }, finish_reason: 'tool_calls' }] }, 'm'));
  });
}

test('stream rejects corrupt tool arguments and reports the error once', async () => {
  const values = [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call1', function: { name: 'execute', arguments: '{broken' } }] }, finish_reason: 'tool_calls' }] },
    '[DONE]',
  ];
  const body = new Response(values.map((v) => `data: ${typeof v === 'string' ? v : JSON.stringify(v)}\n\n`).join('')).body;
  const errors = [];
  const text = await new Response(openAIToAnthropicStream(body, 'm', { onError: (e) => errors.push(e) })).text();
  assert.ok(text.includes('event: error'));
  assert.ok(!text.includes('event: message_stop'));
  assert.ok(!text.includes('event: content_block_start'));
  assert.equal(errors.length, 1);
});

test('valid empty tool arguments still become an object', () => {
  const out = toAnthropicResponse({ choices: [{ message: { tool_calls: [{ id: 'call1', function: { name: 'execute', arguments: '' } }] }, finish_reason: 'tool_calls' }] }, 'm');
  assert.deepEqual(out.content[0].input, {});
});
