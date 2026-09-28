import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, cp, mkdir, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { upstreamFetch, readResponseText } from '../src/upstream-fetch.js';
import { openAIToAnthropicStream } from '../src/stream.js';
import { buildHeaders } from '../src/providers/anthropic.js';
import { adaptBodyForModelSeries, adaptResponsesBodyForModelSeries } from '../src/model-series.js';
import { parseCompletion as geminiCompletion, normalizeBaseUrl } from '../src/providers/gemini.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const tick = () => new Promise((r) => setImmediate(r));

test('client cancellation propagates without a further upstream chunk', async () => {
  let cancelled = false;
  const source = new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n')); },
    cancel() { cancelled = true; },
  });
  const reader = openAIToAnthropicStream(source, 'm').getReader();
  await reader.read();
  await reader.cancel();
  assert.ok(cancelled);
});

test('slow consumers bound upstream pulls', async () => {
  let pulls = 0;
  const source = new ReadableStream({ pull(c) {
    pulls++;
    c.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n'));
  } });
  const output = openAIToAnthropicStream(source, 'm');
  for (let i = 0; i < 10; i++) await tick();
  assert.ok(pulls <= 3, `pulled ${pulls} chunks without a downstream reader`);
  await output.cancel();
});

test('cancelling a decoded gzip body closes the real upstream', async (t) => {
  let closeResolve;
  const closed = new Promise((r) => closeResolve = r);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-encoding': 'gzip' });
    const gzip = zlib.createGzip();
    gzip.pipe(res);
    gzip.write('some data');
    gzip.flush();
    res.once('close', () => { gzip.destroy(); closeResolve(); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await upstreamFetch({}, `http://127.0.0.1:${server.address().port}`, { signal: AbortSignal.timeout(3000) });
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  let timer;
  try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('upstream remained open')), 1500); })]); } finally { clearTimeout(timer); }
});

test('oversized response fails and cancels instead of silently truncating', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(200)); }, cancel() { cancelled = true; } }));
  await assert.rejects(readResponseText(response, 100), /上限/);
  assert.ok(cancelled);
});

test('hop-by-hop headers and downstream credentials never reach Anthropic', () => {
  const headers = buildHeaders({ apiKey: 'upstream-key', authStyle: 'bearer' }, {
    Connection: 'x-private', 'X-Private': 'local', Authorization: 'Bearer client-secret',
    'X-Api-Key': 'local-secret', 'Content-Encoding': 'gzip', 'anthropic-beta': 'test-beta',
  });
  assert.equal(headers.authorization, 'Bearer upstream-key');
  assert.equal(headers['x-api-key'], undefined);
  assert.equal(headers['x-private'], undefined);
  assert.equal(headers['content-encoding'], undefined);
  assert.equal(headers['anthropic-beta'], 'test-beta');
});

test('Gemini URLs, series adaptation and SSE aggregation remain compatible', async () => {
  assert.equal(normalizeBaseUrl('https://example.invalid/v1beta/'), 'https://example.invalid/v1beta/openai');
  const body = { system: 'You are a Claude agent.', messages: [{ role: 'user', content: 'You are Claude.' }] };
  const rewritten = adaptBodyForModelSeries(body, 'gemini-test');
  assert.equal(rewritten.system, 'You are an AI coding agent.');
  assert.equal(rewritten.messages[0].content, body.messages[0].content);
  assert.equal(body.system, 'You are a Claude agent.');
  for (const [input, expected] of [
    ['You are Codex, a coding agent based on GPT-5. You share a workspace.', 'You are an AI coding agent. You share a workspace.'],
    ['You are ChatGPT, built on GPT-5.1-codex.\nNext line.', 'You are an AI coding agent.\nNext line.'],
    ['You are clumsy in the git console. Codex is fine.', 'You are clumsy in the git console. Codex is fine.'],
  ]) assert.equal(adaptBodyForModelSeries({ system: input }, 'gemini-test').system, expected);
  const codexBody = { instructions: 'You are Codex, based on GPT-5.', input: [{ role: 'developer', content: [{ type: 'input_text', text: 'You are Codex.' }] }, { role: 'user', content: 'You are Codex.' }] };
  const codexOut = adaptResponsesBodyForModelSeries(codexBody, 'gemini-test');
  assert.equal(codexOut.instructions, 'You are an AI coding agent.');
  assert.equal(codexOut.input[0].content[0].text, 'You are an AI coding agent.');
  assert.equal(codexOut.input[1].content, 'You are Codex.');
  assert.equal(adaptResponsesBodyForModelSeries(codexBody, 'gpt-6-sol'), codexBody, '其他系列原样返回');
  const plain = { instructions: 'Be concise.', input: 'hi' };
  assert.equal(adaptResponsesBodyForModelSeries(plain, 'gemini-test'), plain, '没有身份句时返回同一个对象');
  const response = new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  assert.equal((await geminiCompletion(response)).choices[0].message.content, 'ok');
});

test('isolated configuration and management commands', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gw-management-'));
  const gateway = join(dir, 'claude-gateway');
  await mkdir(join(gateway, 'scripts'), { recursive: true });
  await cp(join(root, 'src'), join(gateway, 'src'), { recursive: true });
  await cp(join(root, 'scripts', 'gw.js'), join(gateway, 'scripts', 'gw.js'));
  await writeFile(join(gateway, 'package.json'), '{"type":"module"}');
  const reservation = http.createServer();
  await new Promise((r) => reservation.listen(0, '127.0.0.1', r));
  const port = reservation.address().port;
  await new Promise((r) => reservation.close(r));
  const cfgPath = join(gateway, 'providers.json');
  const cfg = { clientToken: 'fixture-client-token', providers: [{ name: 'p', apiType: 'openai', apiKey: 'fixture-key', baseUrl: 'http://127.0.0.1:1' }], routes: { fixture: 'p' } };
  await writeFile(cfgPath, JSON.stringify(cfg));
  await writeFile(join(gateway, '.env'), 'GATEWAY_PORT=1\n');
  const env = { ...process.env, GATEWAY_PORT: String(port), GATEWAY_HOST: '127.0.0.1', GATEWAY_CONFIG: cfgPath, GATEWAY_WEB_ENABLED: '0' };
  const run = (...args) => exec(process.execPath, args, { cwd: gateway, env, timeout: 15000, windowsHide: true });
  let running = false;
  t.after(async () => {
    if (running) { try { await run('scripts/gw.js', 'stop'); } catch {} }
    await rm(dir, { recursive: true, force: true });
  });
  await t.test('invalid concurrency, attempts, API types and routes fail at load', async () => {
    for (const change of [{ maxConcurrency: 0 }, { maxConcurrency: -1 }, { maxAttempts: 1.5 }, { apiType: 'typo' }, { baseUrl: 'file:///tmp/x' }]) {
      await writeFile(cfgPath, JSON.stringify({ ...cfg, providers: [{ ...cfg.providers[0], ...change }] }));
      await assert.rejects(run('--input-type=module', '-e', "import {loadConfig} from './src/config.js'; loadConfig();"));
    }
    await writeFile(cfgPath, JSON.stringify({ ...cfg, defaultRoute: 'missing' }));
    await assert.rejects(run('--input-type=module', '-e', "import {loadConfig} from './src/config.js'; loadConfig();"));
    await writeFile(cfgPath, JSON.stringify(cfg));
  });
  await t.test('manager and server agree environment overrides dotenv', async () => {
    const result = await run('scripts/gw.js', 'start');
    running = true;
    assert.ok(result.stdout.includes(`:${port}`), result.stdout);
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.service, 'slizm-gateway');
    assert.equal(health.transport, 'node-http-connect-v2');
    assert.equal(Number(await readFile(join(gateway, 'logs/gateway.pid'), 'utf8')), health.pid);
    const again = await run('scripts/gw.js', 'start');
    assert.ok(again.stdout.includes('已在运行'));
    await run('scripts/gw.js', 'stop');
    running = false;
  });
  await t.test('mode changes validate destination and preserve valid direct backup', async () => {
    const settings = join(dir, 'settings.json');
    const stashed = join(dir, 'settings.json_gateway');
    const direct = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://example.invalid' }, preserve: 1 });
    const local = JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` }, preserve: 2 });
    await writeFile(settings, direct);
    await writeFile(stashed, '{broken');
    await assert.rejects(run('scripts/gw.js', 'mode', 'gateway'));
    assert.equal(await readFile(settings, 'utf8'), direct);
    await writeFile(stashed, local);
    await run('scripts/gw.js', 'mode', 'gateway');
    assert.equal(await readFile(settings, 'utf8'), local);
    await writeFile(join(dir, 'settings.json.direct-backup-99999999-999999'), '{broken');
    await run('scripts/gw.js', 'mode', 'direct');
    assert.equal(await readFile(settings, 'utf8'), direct);
    assert.equal(await readFile(stashed, 'utf8'), local);
    assert.ok(!(await readdir(dir)).some((p) => p.endsWith('.tmp')));
  });
});
