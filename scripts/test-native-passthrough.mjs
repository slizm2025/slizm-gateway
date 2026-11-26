import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root = fileURLToPath(new URL('../', import.meta.url));
const token = 'native-client-fixture';
const key = 'native-provider-fixture';
const identity = 'You are Codex, a coding agent based on GPT-5.';
const errorBody = JSON.stringify({ error: { message: 'x'.repeat(75000) + 'END' } });
const geoErrorBody = JSON.stringify({
  type: 'error',
  error: {
    message: 'User location is not supported for the API use.',
    type: 'request_forbidden',
    param: null,
    code: 'unsupported_country_region_territory',
  },
});
const adapterErrorBody = JSON.stringify({
  type: 'error',
  error: {
    message: 'Adapter upstream validation failed',
    type: 'invalid_request_error',
  },
});
const sseErrorBody = 'event: error\ndata: {"type":"error","error":{"message":"Upstream quota exceeded during generation"}}\n\n';
const sseFailedBody = 'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"message":"Country, region, or territory not supported"}}}\n\n';
const sseBody = ': keepalive\r\nevent: future_event\r\ndata: {"unknown":true}\r\n\r\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';

test('native forwarding preserves content and availability exceptions', async (t) => {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try { body = JSON.parse(raw); } catch { /* ignore */ }
    seen.push({ raw, body, headers: req.headers, path: req.url });
    if (body.case === 'responses_geo_error') {
      res.writeHead(400, {
        'content-type': 'application/json',
        'x-upstream-region': 'blocked-region',
        'request-id': 'req-geo-400',
      });
      return res.end(geoErrorBody);
    }
    if (body.case === 'adapter_error' || raw.includes('test-adapter')) {
      res.writeHead(400, {
        'content-type': 'application/json',
        'x-adapter-error': 'passthrough',
        'request-id': 'req-adapter-400',
      });
      return res.end(adapterErrorBody);
    }
    if (body.case === 'responses_sse_error') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-upstream-stream': 'error-event' });
      return res.end(sseErrorBody);
    }
    if (body.case === 'responses_sse_failed') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-upstream-stream': 'failed-event' });
      return res.end(sseFailedBody);
    }
    if (body.case === 'error' || body.case === 'unsafe') {
      res.writeHead(body.case === 'unsafe' ? 502 : 400, { 'content-type': 'application/json', 'x-upstream-detail': 'preserve', 'request-id': 'upstream-error' });
      return res.end(errorBody);
    }
    if (body.case === 'sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-upstream-detail': 'stream' });
      return res.end(sseBody);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url.endsWith('count_tokens') ? '{"input_tokens":7}' : '{ "id":"upstream", "usage":{"input_tokens":3,"output_tokens":1} }');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const dir = await mkdtemp(join(tmpdir(), 'native-passthrough-'));
  let child;
  let exit;
  t.after(async () => {
    if (child && child.exitCode === null) child.kill();
    if (exit) await exit;
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const baseUrl = 'http://127.0.0.1:' + upstream.address().port;
  const config = join(dir, 'providers.json');
  await writeFile(config, JSON.stringify({ clientToken: token, providers: [
    { name: 'anth', apiType: 'anthropic', baseUrl, apiKey: key },
    { name: 'oai', apiType: 'openai', baseUrl: baseUrl + '/v1', apiKey: key,
      extraHeaders: { 'user-agent': 'replacement', 'session-id': 'replacement', authorization: 'Bearer replacement', 'x-codex-added': 'fake', 'x-upstream-region': 'fallback', 'x-upstream-route': 'extra' } },
    { name: 'dead', apiType: 'anthropic', baseUrl: 'http://127.0.0.1:1', apiKey: 'sk-dead-key-1234567890abcdef' },
    { name: 'dead-oai', apiType: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-dead-key-1234567890abcdef' },
  ], routes: {
    alias: { provider: 'anth', model: 'claude-test' }, 'claude-test': 'anth',
    ag: { provider: 'anth', model: 'gemini-test' },
    codex: { provider: 'oai', model: 'gpt-test' }, cg: { provider: 'oai', model: 'gemini-test' },
    'unreach-msg': { provider: 'dead', model: 'claude-test' },
    'unreach-resp': { provider: 'dead-oai', model: 'gpt-test' },
  } }));
  let logs = '';
  child = spawn(process.execPath, [join(root, 'src/server.js')], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GATEWAY_CONFIG: config, GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: '0', GATEWAY_USAGE_DIR: 'off' },
  });
  exit = once(child, 'exit');
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  let base;
  for (let i = 0; i < 100; i++) {
    base = /http:\/\/127\.0\.0\.1:\d+/.exec(logs)?.[0];
    if (base) break;
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.ok(base, logs);
  const claudeHeaders = {
    'content-type': 'application/json', authorization: 'Bearer ' + token,
    'x-api-key': token, 'user-agent': 'claude-cli/fixture', 'x-app': 'cli',
    'anthropic-beta': 'fixture-beta', 'x-stainless-os': 'fixture-os',
    'x-claude-code-session-id': 'original-session',
  };
  const codexHeaders = {
    'content-type': 'application/json', authorization: 'Bearer ' + token,
    'user-agent': 'codex/fixture', originator: 'Codex', 'session-id': 'original-session',
    'thread-id': 'original-thread', 'x-codex-turn-metadata': '{"model":"client-model"}',
    'x-upstream-region': 'client-region',
  };
  // 连接被拒属于发送前失败，网关按既定策略最多重试 4 次（退避合计约 6.5 秒），
  // 因此诊断用例需要比普通用例更长的客户端时限。
  const send = (path, raw, headers = claudeHeaders, timeoutMs = 5000) => fetch(base + path, {
    method: 'POST', headers, body: raw, signal: AbortSignal.timeout(timeoutMs),
  });
  const waitForLog = async (pattern, fromIndex = 0, timeoutMs = 3000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const slice = logs.slice(fromIndex);
      if (pattern.test(slice)) return slice;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail('Timed out waiting for log pattern ' + pattern + ' in logs: ' + logs.slice(fromIndex));
  };
  await t.test('Anthropic body only changes routed model, including tool integers and thinking', async () => {
    for (const model of ['alias', 'claude-test']) {
      const raw = '{\n "system":"You are Claude.", "model" : "' + model + '", "max_tokens":100, "messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"keep","signature":"sig"},{"type":"tool_use","id":"call","name":"tool","input":{"n":9007199254740993,"v":1.20e+09,"model":"nested"}}]}],"tools":[{"name":"tool","input_schema":{"type":"object"}}],"metadata":{"user_id":"original"}\n}';
      const response = await send('/v1/messages', raw);
      assert.equal(response.status, 200, await response.text());
      const request = seen.at(-1);
      assert.equal(request.raw, raw.replace('"' + model + '"', '"claude-test"'));
      for (const name of ['user-agent', 'x-app', 'anthropic-beta', 'x-stainless-os', 'x-claude-code-session-id']) assert.equal(request.headers[name], claudeHeaders[name]);
      assert.equal(request.headers.authorization, 'Bearer ' + key);
      assert.equal(request.headers['x-api-key'], undefined);
    }
  });
  await t.test('errors remain complete and unsafe 5xx retain replay protection', async () => {
    for (const kind of ['error', 'unsafe']) {
      const response = await send('/v1/messages', JSON.stringify({ model: 'alias', case: kind, messages: [{ role: 'user', content: 'hi' }] }));
      assert.equal(response.status, kind === 'unsafe' ? 502 : 400);
      assert.equal(await response.text(), errorBody);
      assert.equal(response.headers.get('x-upstream-detail'), 'preserve');
      assert.equal(response.headers.get('request-id'), 'upstream-error');
      assert.equal(response.headers.get('x-request-id'), null);
      assert.equal(response.headers.get('x-should-retry'), kind === 'unsafe' ? 'false' : null);
    }
  });
  await t.test('SSE comments, unknown events and formatting remain unchanged', async () => {
    const response = await send('/v1/messages', JSON.stringify({ model: 'alias', case: 'sse', stream: true, messages: [{ role: 'user', content: 'hi' }] }));
    assert.equal(await response.text(), sseBody);
    assert.equal(response.headers.get('x-upstream-detail'), 'stream');
  });
  await t.test('Codex preserves raw body and identity while allowing auxiliary headers', async () => {
    const raw = '{ "instructions":"' + identity + '","model":"codex", "big":9007199254740993,"input":"hello", "reasoning":{"effort":"high"},"previous_response_id":"original" }';
    const response = await send('/v1/responses', raw, codexHeaders);
    assert.equal(response.status, 200, await response.text());
    const request = seen.at(-1);
    assert.equal(request.raw, raw.replace('"codex"', '"gpt-test"'));
    for (const name of ['user-agent', 'originator', 'session-id', 'thread-id', 'x-codex-turn-metadata', 'x-upstream-region']) assert.equal(request.headers[name], codexHeaders[name]);
    assert.equal(request.headers.authorization, 'Bearer ' + key);
    assert.equal(request.headers['x-codex-added'], undefined);
    assert.equal(request.headers['x-upstream-route'], 'extra');
  });
  await t.test('Gemini identity adaptation survives for both clients and token counting', async () => {
    for (const path of ['/v1/messages', '/v1/messages/count_tokens']) {
      const response = await send(path, JSON.stringify({ model: 'ag', system: identity, messages: [{ role: 'user', content: identity }] }));
      assert.equal(response.status, 200, await response.text());
      assert.equal(seen.at(-1).body.system, 'You are an AI coding agent.');
      assert.equal(seen.at(-1).body.messages[0].content, identity);
    }
    const response = await send('/v1/responses', JSON.stringify({ model: 'cg', instructions: identity, input: [{ role: 'developer', content: identity }, { role: 'user', content: identity }] }), codexHeaders);
    assert.equal(response.status, 200, await response.text());
    assert.equal(seen.at(-1).body.instructions, 'You are an AI coding agent.');
    assert.equal(seen.at(-1).body.input[0].content, 'You are an AI coding agent.');
    assert.equal(seen.at(-1).body.input[1].content, identity);
  });
  await t.test('Codex native /v1/responses preserves HTTP 400 status, headers, and body bytes, while logging real error message', async () => {
    const raw = JSON.stringify({ model: 'codex', case: 'responses_geo_error', input: 'test-geo' });
    const logStart = logs.length;
    const response = await send('/v1/responses', raw, codexHeaders);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('x-upstream-region'), 'blocked-region');
    assert.equal(response.headers.get('request-id'), 'req-geo-400');
    assert.equal(response.headers.get('content-type'), 'application/json');
    const text = await response.text();
    assert.equal(text, geoErrorBody);

    const newLogs = await waitForLog(/User location is not supported for the API use\./, logStart);
    assert.doesNotMatch(newLogs, /Upstream HTTP 400/);
  });

  await t.test('Codex native /v1/responses preserves SSE error event and logs real error message', async () => {
    const raw = JSON.stringify({ model: 'codex', case: 'responses_sse_error', stream: true, input: 'test-sse-err' });
    const logStart = logs.length;
    const response = await send('/v1/responses', raw, codexHeaders);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-upstream-stream'), 'error-event');
    const text = await response.text();
    assert.equal(text, sseErrorBody);

    const newLogs = await waitForLog(/Upstream quota exceeded during generation/, logStart);
    assert.doesNotMatch(newLogs, /Upstream Responses failure/);
  });

  await t.test('Codex native /v1/responses preserves SSE response.failed event and logs real error message from nested error', async () => {
    const raw = JSON.stringify({ model: 'codex', case: 'responses_sse_failed', stream: true, input: 'test-sse-failed' });
    const logStart = logs.length;
    const response = await send('/v1/responses', raw, codexHeaders);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-upstream-stream'), 'failed-event');
    const text = await response.text();
    assert.equal(text, sseFailedBody);

    const newLogs = await waitForLog(/Country, region, or territory not supported/, logStart);
    assert.doesNotMatch(newLogs, /Upstream Responses failure/);
  });

  await t.test('adapter /v1/messages preserves upstream HTTP 400 status, content-type, headers, and body bytes', async () => {
    // cg routes to oai provider with gemini-test, using adapter
    const raw = JSON.stringify({ model: 'cg', case: 'adapter_error', messages: [{ role: 'user', content: 'test-adapter-messages' }] });
    const response = await send('/v1/messages', raw, claudeHeaders);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.equal(response.headers.get('x-adapter-error'), 'passthrough');
    assert.equal(response.headers.get('request-id'), 'req-adapter-400');
    const text = await response.text();
    assert.equal(text, adapterErrorBody);
  });

  await t.test('adapter non-Codex /v1/responses preserves upstream HTTP 400 status, content-type, headers, and body bytes', async () => {
    // alias routes to anth provider (apiType: anthropic), using responses-to-messages adapter
    const raw = JSON.stringify({ model: 'alias', case: 'adapter_error', input: 'test-adapter-responses' });
    const response = await send('/v1/responses', raw, claudeHeaders);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.equal(response.headers.get('x-adapter-error'), 'passthrough');
    assert.equal(response.headers.get('request-id'), 'req-adapter-400');
    const text = await response.text();
    assert.equal(text, adapterErrorBody);
  });

  await t.test('handleMessages error diagnostics exposes cause chain while redacting secrets', async () => {
    const raw = JSON.stringify({ model: 'unreach-msg', messages: [{ role: 'user', content: 'hi' }] });
    const logStart = logs.length;
    const response = await send('/v1/messages', raw, claudeHeaders, 15000);
    assert.equal(response.status, 502);
    const data = await response.json();
    assert.equal(data.type, 'error');
    // 验证 cause 中的 connect / ECONNREFUSED 暴露在客户端消息中，且原始 fetch failed 未丢失
    assert.match(data.error.message, /fetch failed/);
    assert.match(data.error.message, /ECONNREFUSED/);
    assert.doesNotMatch(data.error.message, /sk-dead-key/);
    assert.doesNotMatch(data.error.message, /native-provider-fixture/);
    const newLogs = await waitForLog(/ECONNREFUSED/, logStart);
    assert.doesNotMatch(newLogs, /sk-dead-key/);
  });

  await t.test('handleResponses error diagnostics exposes cause chain while redacting secrets', async () => {
    const raw = JSON.stringify({ model: 'unreach-resp', input: 'test-unreach' });
    const logStart = logs.length;
    const response = await send('/v1/responses', raw, codexHeaders, 15000);
    assert.equal(response.status, 502);
    const data = await response.json();
    assert.equal(data.type, 'error');
    assert.match(data.error.message, /fetch failed/);
    assert.match(data.error.message, /ECONNREFUSED/);
    assert.doesNotMatch(data.error.message, /sk-dead-key/);
    assert.doesNotMatch(data.error.message, /native-provider-fixture/);
    const newLogs = await waitForLog(/ECONNREFUSED/, logStart);
    assert.doesNotMatch(newLogs, /sk-dead-key/);
  });
});
