import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { responsesToAnthropic, anthropicToResponses, anthropicToResponsesStream } from '../src/providers/responses.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLIENT_TOKEN = 'responses-client';
const ANTHROPIC_KEY = 'anthropic-upstream-key';
const OPENAI_KEY = 'openai-upstream-key';
const codexHeaders = {
  'user-agent': 'Codex Desktop/0.155.0-alpha.16.4 (Windows; x86_64) dumb (codex_exec; 0.155.0-alpha.16.4)',
  originator: 'Codex Desktop',
  'x-codex-installation-id': 'codex-installation',
  'x-codex-window-id': 'codex-window',
  'x-codex-turn-metadata': '{"model":"gpt-6-sol"}',
  'x-codex-custom': 'preserve-me',
  accept: 'text/event-stream',
};

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitForLog(getLogs, start, pattern) {
  for (let i = 0; i < 100; i++) {
    const match = getLogs().slice(start).split(/\r?\n/).find((line) => pattern.test(line));
    if (match) return match;
    await wait(20);
  }
  assert.match(getLogs().slice(start), pattern);
}
async function readBody(req) {
  let raw = '';
  req.setEncoding('utf8');
  for await (const chunk of req) raw += chunk;
  return { raw, body: raw ? JSON.parse(raw) : null };
}
function json(res, value) {
  const raw = JSON.stringify(value);
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)) });
  res.end(raw);
}
function anthropicText() {
  return { id: 'msg_anthropic', type: 'message', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'anthropic gateway ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 3 } };
}
function openAiText() {
  return { id: 'chatcmpl_text', choices: [{ index: 0, message: { role: 'assistant', content: 'openai gateway ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2 } };
}
function openAiTool() {
  return { id: 'chatcmpl_tool', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_weather', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 6, completion_tokens: 4 } };
}
function openAiStream(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  for (const frame of [
    { id: 'chatcmpl_stream', choices: [{ index: 0, delta: { role: 'assistant', content: 'stream ' }, finish_reason: null }] },
    { id: 'chatcmpl_stream', choices: [{ index: 0, delta: { content: 'gateway ok' }, finish_reason: null }] },
    { id: 'chatcmpl_stream', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { id: 'chatcmpl_stream', choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } },
  ]) res.write('data: ' + JSON.stringify(frame) + '\n\n');
  res.end('data: [DONE]\n\n');
}
function sseEvents(text) {
  return [...text.matchAll(/^event: ([^\r\n]+)\r?\ndata: (.+)$/gm)].map((match) => ({ event: match[1], data: JSON.parse(match[2]) }));
}

test('Responses request conversion preserves developer, tools and tool results', () => {
  const out = responsesToAnthropic({
    model: 'gpt-6-sol', instructions: 'system', input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'developer rule' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run it' }] },
      { type: 'function_call_output', call_id: 'call_1', output: 'done' },
    ],
    tools: [{ type: 'function', name: 'exec', description: 'execute', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } }],
  });
  assert.equal(out.system, 'system');
  assert.equal(out.messages[0].role, 'system');
  assert.equal(out.messages[1].content[0].text, 'run it');
  assert.equal(out.messages[2].content[0].type, 'tool_result');
  assert.equal(out.tools[0].name, 'exec');
});

test('Responses response conversion emits text and function-call output', () => {
  const out = anthropicToResponses({ id: 'msg_1', type: 'message', content: [{ type: 'text', text: 'hello' }, { type: 'tool_use', id: 'call_1', name: 'exec', input: { cmd: 'pwd' } }], usage: { input_tokens: 2, output_tokens: 3 } }, 'gpt-6-sol', 'resp_test');
  assert.equal(out.id, 'resp_test');
  assert.equal(out.output_text, 'hello');
  assert.equal(out.output[1].arguments, '{"cmd":"pwd"}');
  assert.deepEqual(out.usage, { input_tokens: 2, output_tokens: 3, total_tokens: 5 });
});

test('Responses JSON and SSE include cached input in total input and retain cache details', async () => {
  const usage = { input_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 10, output_tokens: 3 };
  const expected = { input_tokens: 110, output_tokens: 3, total_tokens: 113, input_tokens_details: { cached_tokens: 80, cache_write_tokens: 10 } };
  assert.deepEqual(anthropicToResponses({ content: [], usage }, 'test').usage, expected);
  const frames = [
    { type: 'message_start', message: { id: 'msg_cache', usage: { ...usage, output_tokens: 0 } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3, input_tokens: null, cache_read_input_tokens: null } },
    { type: 'message_stop' },
  ];
  const body = new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('')).body;
  const observed = [];
  const events = sseEvents(await new Response(anthropicToResponsesStream(body, 'test', { onUsage: value => observed.push(value) })).text());
  assert.deepEqual(observed[0], { ...usage, output_tokens: 0 });
  assert.deepEqual(events.find(event => event.event === 'response.completed').data.response.usage, expected);
});

test('reverse Responses usage carries cache_write_tokens only when writes are reported', () => {
  // 只上报读：只出 standard cached_tokens，不凭空补 cache_write_tokens
  assert.deepEqual(anthropicToResponses({ content: [], usage: { input_tokens: 5, cache_read_input_tokens: 7, output_tokens: 1 } }, 'test').usage, {
    input_tokens: 12, output_tokens: 1, total_tokens: 13, input_tokens_details: { cached_tokens: 7 },
  });
  // 只上报写：只出兼容 cache_write_tokens，不加 cached_tokens
  assert.deepEqual(anthropicToResponses({ content: [], usage: { input_tokens: 5, cache_creation_input_tokens: 9, output_tokens: 1 } }, 'test').usage, {
    input_tokens: 14, output_tokens: 1, total_tokens: 15, input_tokens_details: { cache_write_tokens: 9 },
  });
  // 显式零写入也保留兼容字段
  assert.deepEqual(anthropicToResponses({ content: [], usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } }, 'test').usage, {
    input_tokens: 5, output_tokens: 1, total_tokens: 6, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  });
  // 完全没有缓存来源：整个 details 缺省
  assert.deepEqual(anthropicToResponses({ content: [], usage: { input_tokens: 5, output_tokens: 1 } }, 'test').usage, {
    input_tokens: 5, output_tokens: 1, total_tokens: 6,
  });
});

test('Messages route uses configured Responses transport and converts back to Anthropic', async (t) => {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    const { body } = await readBody(req);
    seen.push({ path: req.url, body });
    if (req.url !== '/responses') { res.writeHead(404); return res.end(); }
    return json(res, { id: 'resp_messages', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'responses transport ok' }] }], usage: { input_tokens: 7, output_tokens: 3 } });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + upstream.address().port;
  const dir = await mkdtemp(join(tmpdir(), 'gateway-messages-responses-'));
  const config = join(dir, 'providers.json');
  await writeFile(config, JSON.stringify({
    clientToken: CLIENT_TOKEN,
    providers: [{ name: 'openai', apiType: 'openai', baseUrl, apiKey: OPENAI_KEY, messagesTransport: 'responses', models: {} }],
    routes: { 'claude-route': { provider: 'openai', model: 'real-responses-model' } },
  }));
  const gateway = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, GATEWAY_CONFIG: config, GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: '0', GATEWAY_USAGE_DIR: 'off' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let logs = '';
  gateway.stdout.on('data', (chunk) => { logs += chunk; });
  gateway.stderr.on('data', (chunk) => { logs += chunk; });
  t.after(async () => {
    if (gateway.exitCode === null) { gateway.kill(); await once(gateway, 'exit'); }
    upstream.closeAllConnections(); upstream.close();
    await rm(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 100 && !/http:\/\/127\.0\.0\.1:\d+/.test(logs); i++) await wait(25);
  const gatewayBase = /http:\/\/127\.0\.0\.1:\d+/.exec(logs)?.[0];
  assert.ok(gatewayBase, logs);
  const response = await fetch(gatewayBase + '/v1/messages', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + CLIENT_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-route', system: 'be brief', messages: [{ role: 'user', content: 'hello' }], max_tokens: 32 }),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.content[0].text, 'responses transport ok');
  assert.deepEqual(seen[0].body, { model: 'real-responses-model', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }], stream: false, max_output_tokens: 32, store: false, instructions: 'be brief' });
  assert.match(logs, /messages claude-route ⇒ real-responses-model .*adapter/);
});

test('Responses compatibility remains for unknown OpenAI clients and Codex Anthropic routes', async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    readBody(req).then(({ body }) => {
      seen.push({ path: req.url, headers: req.headers, body });
      if (req.url === '/v1/messages') return json(res, anthropicText());
      if (req.url !== '/chat/completions') { res.writeHead(404); return res.end(); }
      if (body.model === 'gpt-stream') return openAiStream(res);
      return json(res, body.tools?.length ? openAiTool() : openAiText());
    }).catch((error) => { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + upstream.address().port;
  const dir = await mkdtemp(join(tmpdir(), 'gateway-responses-'));
  const config = join(dir, 'providers.json');
  await writeFile(config, JSON.stringify({
    clientToken: CLIENT_TOKEN,
    providers: [
      // 这个用例只验证 chat semantics 的兼容路径，显式声明 chat，避免 auto 把 GPT 路由到 /responses
      { name: 'openai', apiType: 'openai', baseUrl, apiKey: OPENAI_KEY, messagesTransport: 'chat-completions', models: {} },
      { name: 'anthropic', apiType: 'anthropic', baseUrl, apiKey: ANTHROPIC_KEY, models: {} },
    ],
    routes: {
      'gpt-6-sol': { provider: 'openai', model: 'gpt-6-sol' },
      'gpt-stream': { provider: 'openai', model: 'gpt-stream' },
      'gpt-tool': { provider: 'openai', model: 'gpt-tool' },
      'claude-test': { provider: 'anthropic', model: 'claude-test' },
    },
  }));
  const gateway = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, GATEWAY_CONFIG: config, GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: '0', GATEWAY_USAGE_DIR: 'off' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let logs = '';
  gateway.stdout.on('data', (chunk) => { logs += chunk; });
  gateway.stderr.on('data', (chunk) => { logs += chunk; });
  t.after(async () => {
    if (gateway.exitCode === null) { gateway.kill(); await once(gateway, 'exit'); }
    upstream.closeAllConnections(); upstream.close();
    await rm(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 100 && !/http:\/\/127\.0\.0\.1:\d+/.test(logs); i++) await wait(25);
  const base = /http:\/\/127\.0\.0\.1:\d+/.exec(logs)?.[0];
  assert.ok(base, logs);
  const send = async (model, body) => {
    const response = await fetch(base + '/v1/responses', { method: 'POST', headers: { ...(model === 'claude-test' ? codexHeaders : { 'user-agent': 'compatibility-test', 'x-test-client': 'preserve-me' }), authorization: 'Bearer ' + CLIENT_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ model, ...body }) });
    return { response, text: await response.text() };
  };

  const textResult = await send('gpt-6-sol', { input: 'hello', stream: false });
  const textBody = JSON.parse(textResult.text);
  assert.equal(textResult.response.status, 200, textResult.text);
  assert.equal(textBody.output_text, 'openai gateway ok');
  const openAiRequest = [...seen].reverse().find((item) => item.path === '/chat/completions' && item.body.model === 'gpt-6-sol');
  assert.equal(openAiRequest.headers['user-agent'], 'compatibility-test');
  assert.equal(openAiRequest.headers['x-codex-installation-id'], undefined);
  assert.equal(openAiRequest.headers['x-test-client'], 'preserve-me');
  assert.equal(openAiRequest.headers.authorization, 'Bearer ' + OPENAI_KEY);
  assert.equal(openAiRequest.body.messages[0].content, 'hello');

  const anthropicResult = await send('claude-test', { input: 'hello anthropic', stream: false });
  const anthropicBody = JSON.parse(anthropicResult.text);
  assert.equal(anthropicResult.response.status, 200, anthropicResult.text);
  assert.equal(anthropicBody.output_text, 'anthropic gateway ok');
  const anthropicRequest = [...seen].reverse().find((item) => item.path === '/v1/messages');
  assert.equal(anthropicRequest.headers.originator, 'Codex Desktop');
  assert.equal(anthropicRequest.headers['x-codex-custom'], 'preserve-me');
  assert.equal(anthropicRequest.headers.authorization, 'Bearer ' + ANTHROPIC_KEY);
  assert.equal(anthropicRequest.body.messages[0].content[0].text, 'hello anthropic');

  const streamResult = await send('gpt-stream', { input: 'stream', stream: true });
  assert.equal(streamResult.response.status, 200, streamResult.text);
  assert.match(streamResult.response.headers.get('content-type') ?? '', /text\/event-stream/);
  const streamEvents = sseEvents(streamResult.text);
  assert.ok(streamEvents.some((item) => item.event === 'response.created'));
  assert.ok(streamEvents.some((item) => item.event === 'response.completed'));
  assert.equal(streamEvents.filter((item) => item.event === 'response.output_text.delta').map((item) => item.data.delta).join(''), 'stream gateway ok');

  const toolResult = await send('gpt-tool', { input: 'weather?', tools: [{ type: 'function', name: 'get_weather', description: 'weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }], tool_choice: { type: 'function', name: 'get_weather' } });
  const toolBody = JSON.parse(toolResult.text);
  assert.equal(toolResult.response.status, 200, toolResult.text);
  const functionCall = toolBody.output.find((item) => item.type === 'function_call');
  assert.equal(functionCall.call_id, 'call_weather');
  assert.equal(functionCall.name, 'get_weather');
  assert.equal(functionCall.arguments, '{"city":"Paris"}');
  const toolRequest = [...seen].reverse().find((item) => item.path === '/chat/completions' && item.body.model === 'gpt-tool');
  assert.equal(toolRequest.body.tools[0].function.name, 'get_weather');
  assert.deepEqual(toolRequest.body.tool_choice, { type: 'function', function: { name: 'get_weather' } });

  await wait(100);
  const lines = logs.split(/\r?\n/);
  for (const model of ['gpt-6-sol', 'claude-test', 'gpt-stream', 'gpt-tool']) {
    assert.ok(lines.some((l) => new RegExp(`→ responses ${model} .*· adapter$`).test(l)), `${model} 开始行应标 adapter\n${logs}`);
    assert.ok(lines.some((l) => new RegExp(`← responses ${model} .*· adapter · 200 `).test(l)), `${model} 结束行应标 adapter\n${logs}`);
  }
  assert.ok(!lines.some((l) => / responses \S+ ⇒ /.test(l)), '这些路由都没有映射\n' + logs);
});

test('Codex OpenAI /v1/responses uses lossless direct passthrough', async (t) => {
  const seen = [];
  const responseJson = {
    id: 'resp_direct_json',
    usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 70 }, output_tokens: 10 },
    object: 'response',
    model: 'gpt-6-sol',
    output: [{ type: 'message', id: 'msg_direct', role: 'assistant', content: [{ type: 'output_text', text: 'direct ok', annotations: [] }] }],
    output_text: 'direct ok',
    status: 'completed',
  };
  const responseSse = [
    'event: response.created\n',
    'data: {"type":"response.created","response":{"id":"resp_direct_stream","model":"gpt-6-sol"}}\n\n',
    'event: response.output_text.delta\n',
    'data: {"type":"response.output_text.delta","delta":"direct "}\n\n',
    'event: response.output_text.delta\n',
    'data: {"type":"response.output_text.delta","delta":"stream"}\n\n',
    'event: response.completed\n',
    'data: {"type":"response.completed","response":{"id":"resp_direct_stream","status":"completed"}}\n\n',
  ].join('');
  let releaseHeadersFixture;
  const upstream = http.createServer((req, res) => {
    readBody(req).then(({ raw, body }) => {
      seen.push({ path: req.url, headers: req.headers, raw, body });
      if (req.url !== '/v1/responses') {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'expected direct /v1/responses' }));
      }
      if (body.metadata?.error_fixture) {
        res.writeHead(400, { 'content-type': 'application/json', 'x-request-id': 'upstream-error-id' });
        return res.end('{ "error": { "message": "original error", "code": "original_code" } }');
      }
      if (body.metadata?.json_failure_fixture) {
        res.writeHead(200, { 'content-type': 'application/json', 'x-upstream-response': 'direct-json-failure' });
        return res.end('{ "id": "resp_failed_json", "object": "response", "status": "failed", "error": { "code": "server_error", "message": "original response failure" } }');
      }
      if (body.metadata?.sse_failure_fixture) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'x-upstream-response': 'direct-sse-failure' });
        return res.end('event: response.failed\ndata: {"type":"response.failed","response":{"id":"resp_failed_sse","status":"failed","error":{"code":"server_error","message":"original stream failure"}}}\n\n');
      }
      if (body.metadata?.linger_fixture) {
        // 与 sub2api 相同：发完 response.completed 后过一会儿才结束流
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'x-upstream-response': 'direct-linger' });
        res.write(responseSse);
        setTimeout(() => res.end(), 500);
        return;
      }
      if (body.metadata?.cancel_fixture) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'x-upstream-response': 'direct-cancel' });
        res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_cancel"}}\n\n');
        return;
      }
      if (body.metadata?.headers_fixture) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.flushHeaders();
        releaseHeadersFixture = () => res.end(responseSse);
        return;
      }
      if (body.metadata?.truncated_fixture) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        return res.end(responseSse.slice(0, responseSse.indexOf('event: response.completed')));
      }
      if (body.metadata?.reset_after_terminal_fixture) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(responseSse);
        setTimeout(() => res.destroy(), 50);
        return;
      }
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'x-upstream-response': 'direct-stream' });
        return res.end(responseSse);
      }
      return json(res, responseJson);
    }).catch((error) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + upstream.address().port;
  const dir = await mkdtemp(join(tmpdir(), 'gateway-responses-direct-'));
  const config = join(dir, 'providers.json');
  await writeFile(config, JSON.stringify({
    clientToken: CLIENT_TOKEN,
    providers: [{ name: 'openai', apiType: 'openai', baseUrl: baseUrl + '/v1', apiKey: OPENAI_KEY, models: {} }],
    routes: { 'codex-openai': { provider: 'openai', model: 'gpt-6-sol' }, 'gpt-6-sol': 'openai', 'codex-gemini': { provider: 'openai', model: 'gemini-test' } },
  }));
  const gateway = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, GATEWAY_CONFIG: config, GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: '0', GATEWAY_USAGE_DIR: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let logs = '';
  gateway.stdout.on('data', (chunk) => { logs += chunk; });
  gateway.stderr.on('data', (chunk) => { logs += chunk; });
  t.after(async () => {
    if (gateway.exitCode === null) { gateway.kill(); await once(gateway, 'exit'); }
    upstream.closeAllConnections(); upstream.close();
    await rm(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 100 && !/http:\/\/127\.0\.0\.1:\d+/.test(logs); i++) await wait(25);
  const base = /http:\/\/127\.0\.0\.1:\d+/.exec(logs)?.[0];
  assert.ok(base, logs);

  const originalBody = {
    model: 'codex-openai',
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Follow the tool contract.' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect this.' }, { type: 'input_image', image_url: 'https://example.test/image.png', detail: 'high' }] },
      { type: 'function_call', call_id: 'call_1', name: 'inspect', arguments: '{"path":"README.md"}' },
      { type: 'function_call_output', call_id: 'call_1', output: { ok: true, files: ['README.md'] } },
    ],
    instructions: [{ type: 'input_text', text: 'Keep the response concise.' }],
    tools: [{ type: 'function', name: 'inspect', description: 'Inspect a path.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }, strict: true }],
    reasoning: { effort: 'high', summary: 'auto' },
    previous_response_id: 'resp_owned_by_upstream',
    include: ['reasoning.encrypted_content'],
    metadata: { request_tag: 'direct-passthrough', nested: { keep: true } },
    parallel_tool_calls: false,
    unknown_gateway_field: { must_survive: ['unchanged'] },
    stream: false,
    max_output_tokens: 321,
  };
  const expectedBody = { ...originalBody, model: 'gpt-6-sol' };
  originalBody.input.push({ type: 'reasoning', id: 'rs_original', encrypted_content: 'opaque' });
  originalBody.tools.push({ type: 'custom', name: 'patch', format: { type: 'text' } });
  const send = async (body, signal) => fetch(base + '/v1/responses', {
    method: 'POST',
    headers: { ...codexHeaders, authorization: 'Bearer ' + CLIENT_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  const jsonResponse = await send(originalBody);
  const jsonText = await jsonResponse.text();
  assert.equal(jsonResponse.status, 200, jsonText);
  const jsonRequest = seen.at(-1);
  assert.equal(jsonRequest.path, '/v1/responses');
  assert.deepEqual(jsonRequest.body, expectedBody);
  assert.equal(jsonRequest.headers.authorization, 'Bearer ' + OPENAI_KEY);
  assert.equal(jsonRequest.headers.originator, 'Codex Desktop');
  assert.equal(jsonRequest.headers['x-codex-custom'], 'preserve-me');
  assert.deepEqual(JSON.parse(jsonText), responseJson);
  assert.equal(jsonText, JSON.stringify(responseJson));

  const streamBody = { ...originalBody, stream: true };
  const streamResponse = await send(streamBody);
  const streamText = await streamResponse.text();
  assert.equal(streamResponse.status, 200, streamText);
  assert.match(streamResponse.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.equal(streamText, responseSse);
  assert.equal(streamResponse.headers.get('x-upstream-response'), 'direct-stream');
  assert.deepEqual(seen.at(-1).body, { ...streamBody, model: 'gpt-6-sol' });

  for (const model of ['gpt-6-sol', 'codex-openai']) {
    const raw = '{\n "model" : "' + model + '", "big":9007199254740993, "value":1.20e+09, "nested":{"model":"untouched"}, "input":"hello"\n}'.replaceAll('\\n', '\n');
    const result = await fetch(base + '/v1/responses', {
      method: 'POST', headers: { ...codexHeaders, authorization: 'Bearer ' + CLIENT_TOKEN, 'content-type': 'application/json' }, body: raw,
    });
    assert.equal(result.status, 200, await result.text());
    assert.equal(seen.at(-1).raw, raw.replace('"' + model + '"', '"gpt-6-sol"'));
  }

  // Gemini 系列：Codex 身份句会被 Google 以 429 拒绝，直通前改写
  let logStart = logs.length;
  const codexIdentity = 'You are Codex, a coding agent based on GPT-5. Be concise.';
  const geminiResponse = await send({
    model: 'codex-gemini',
    instructions: codexIdentity,
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: codexIdentity }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: codexIdentity }] },
    ],
    metadata: { keep: true },
  });
  assert.equal(geminiResponse.status, 200, await geminiResponse.text());
  const geminiRequest = seen.at(-1).body;
  assert.equal(geminiRequest.model, 'gemini-test');
  assert.equal(geminiRequest.instructions, 'You are an AI coding agent. Be concise.');
  assert.equal(geminiRequest.input[0].content[0].text, 'You are an AI coding agent. Be concise.');
  assert.equal(geminiRequest.input[1].content[0].text, codexIdentity, '用户输入不改写');
  assert.deepEqual(geminiRequest.metadata, { keep: true });
  assert.match(await waitForLog(() => logs, logStart, /→ responses codex-gemini ⇒ gemini-test/), /@openai · direct · \[gemini 适配\]/);

  logStart = logs.length;
  const failure = await send({ model: 'codex-openai', metadata: { error_fixture: true } });
  assert.equal(failure.status, 400);
  assert.equal(failure.headers.get('x-request-id'), 'upstream-error-id');
  assert.equal(await failure.text(), '{ "error": { "message": "original error", "code": "original_code" } }');
  assert.match(await waitForLog(() => logs, logStart, /✗ responses codex-openai/), /上游 400/);

  logStart = logs.length;
  const jsonFailure = await send({ model: 'codex-openai', metadata: { json_failure_fixture: true } });
  const jsonFailureText = await jsonFailure.text();
  assert.equal(jsonFailure.status, 200);
  assert.equal(jsonFailure.headers.get('x-upstream-response'), 'direct-json-failure');
  assert.equal(jsonFailureText, '{ "id": "resp_failed_json", "object": "response", "status": "failed", "error": { "code": "server_error", "message": "original response failure" } }');
  assert.match(await waitForLog(() => logs, logStart, /✗ responses codex-openai/), /Responses failure/);

  logStart = logs.length;
  const sseFailure = await send({ model: 'codex-openai', stream: true, metadata: { sse_failure_fixture: true } });
  const sseFailureText = await sseFailure.text();
  assert.equal(sseFailure.status, 200);
  assert.equal(sseFailure.headers.get('x-upstream-response'), 'direct-sse-failure');
  assert.equal(sseFailureText, 'event: response.failed\ndata: {"type":"response.failed","response":{"id":"resp_failed_sse","status":"failed","error":{"code":"server_error","message":"original stream failure"}}}\n\n');
  assert.match(await waitForLog(() => logs, logStart, /✗ responses codex-openai/), /Responses failure/);

  logStart = logs.length;
  const cancel = new AbortController();
  const cancelResponse = await send({ model: 'codex-openai', stream: true, metadata: { cancel_fixture: true } }, cancel.signal);
  assert.equal(cancelResponse.status, 200);
  const cancelReader = cancelResponse.body.getReader();
  await cancelReader.read();
  cancel.abort();
  await cancelReader.read().catch(() => {});
  assert.match(await waitForLog(() => logs, logStart, /⊘ responses codex-openai/), /客户端断开/);

  // Codex 读到 response.completed 就断开，不等上游收尾：应记为正常完成
  logStart = logs.length;
  const linger = new AbortController();
  const lingerResponse = await send({ model: 'codex-openai', stream: true, metadata: { linger_fixture: true } }, linger.signal);
  assert.equal(lingerResponse.status, 200);
  const lingerReader = lingerResponse.body.getReader();
  const lingerDecoder = new TextDecoder();
  let lingerText = '';
  while (!lingerText.includes('"type":"response.completed"')) {
    const { done, value } = await lingerReader.read();
    assert.equal(done, false, '网关应先转发完整的 response.completed');
    lingerText += lingerDecoder.decode(value, { stream: true });
  }
  linger.abort();
  await lingerReader.read().catch(() => {});
  assert.match(await waitForLog(() => logs, logStart, /[←⊘✗] responses codex-openai/), /← responses codex-openai ⇒ gpt-6-sol .*· direct · 200 ·/);

  const lines = logs.split(/\r?\n/);
  assert.ok(lines.some((l) => /→ responses codex-openai ⇒ gpt-6-sol .*@openai · direct$/.test(l)), logs);
  assert.ok(lines.some((l) => /→ responses gpt-6-sol .*@openai · direct$/.test(l)), '无映射时只显示单一模型\n' + logs);
  assert.ok(!lines.some((l) => / responses gpt-6-sol ⇒ /.test(l)), logs);
  assert.ok(lines.some((l) => /← responses codex-gemini ⇒ gemini-test .*· direct · \[gemini 适配\] · /.test(l)), '结束行保留适配标记\n' + logs);

  const stats = await fetch(base + '/v1/usage', { headers: { authorization: 'Bearer ' + CLIENT_TOKEN } }).then((r) => r.json());
  assert.equal(stats.totals.cacheReadTokens, 280);
  const outputSamples = stats.recent.filter((row) => row.outputTokensPerSec !== null);
  assert.ok(outputSamples.length >= 2, 'native JSON and SSE both produce output TPS');
  for (const row of outputSamples) {
    assert.equal(row.outputTokensPerSec, row.outputTokens * 1000 / row.durationMs);
  }
  assert.equal(stats.totals.outputTpsSamples, outputSamples.length);

  await t.test('forwards SSE headers before the first body chunk', async () => {
    const start = logs.length;
    const pending = send({ model: 'codex-openai', stream: true, metadata: { headers_fixture: true } });
    let timer;
    try {
      const result = await Promise.race([pending, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('SSE headers stalled until body arrival')), 1500);
      })]);
      assert.equal(result.status, 200);
    } finally {
      clearTimeout(timer);
      releaseHeadersFixture?.();
      await pending.then((r) => r.text());
      await waitForLog(() => logs, start, /[←✗] responses codex-openai/);
    }
  });

  await t.test('HTTP EOF without a Responses terminal event is not recorded as success', async () => {
    const start = logs.length;
    const result = await send({ model: 'codex-openai', stream: true, metadata: { truncated_fixture: true } });
    await result.text();
    const line = await waitForLog(() => logs, start, /[←✗] responses codex-openai/);
    assert.match(line, /✗ responses/);
    const usage = await fetch(base + '/v1/usage', { headers: { authorization: 'Bearer ' + CLIENT_TOKEN } }).then((r) => r.json());
    assert.equal(usage.recent.at(-1).status, 502);
    assert.equal(usage.recent.at(-1).outputTokensPerSec, null);
  });

  await t.test('a transport reset after the terminal event does not break a completed response', async () => {
    const start = logs.length;
    const result = await send({ model: 'codex-openai', stream: true, metadata: { reset_after_terminal_fixture: true } });
    assert.equal(await result.text(), responseSse);
    assert.match(await waitForLog(() => logs, start, /[←✗] responses codex-openai/), /← responses/);
  });
});

test('Messages auto transport sends GPT to /responses and non-GPT or explicit chat to /chat/completions', async (t) => {
  const seen = [];
  const SESSION = 'claude-code-session-fixed';
  const upstream = http.createServer((req, res) => {
    readBody(req).then(({ body }) => {
      seen.push({ path: req.url, headers: req.headers, body });
      if (req.url === '/responses') {
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
          // 分段 usage：先报输入 100，终止事件只报 cached 80
          res.write('event: response.in_progress\ndata: ' + JSON.stringify({ type: 'response.in_progress', response: { usage: { input_tokens: 100 } } }) + '\n\n');
          res.write('event: response.output_text.delta\ndata: ' + JSON.stringify({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'streamed ok' }) + '\n\n');
          res.write('event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: { id: 'resp_stream', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'streamed ok' }] }], usage: { input_tokens_details: { cached_tokens: 80 } } } }) + '\n\n');
          return res.end();
        }
        return json(res, { id: 'resp_json', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'responses json ok' }] }], usage: { input_tokens: 5, output_tokens: 2 } });
      }
      if (req.url === '/chat/completions') return json(res, openAiText());
      res.writeHead(404);
      return res.end();
    }).catch((error) => { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + upstream.address().port;
  const dir = await mkdtemp(join(tmpdir(), 'gateway-messages-transport-'));
  const config = join(dir, 'providers.json');
  await writeFile(config, JSON.stringify({
    clientToken: CLIENT_TOKEN,
    providers: [
      { name: 'gpt-auto', apiType: 'openai', baseUrl, apiKey: OPENAI_KEY, models: {} },
      { name: 'gpt-chat', apiType: 'openai', baseUrl, apiKey: OPENAI_KEY, messagesTransport: 'chat-completions', models: {} },
      { name: 'nongpt-auto', apiType: 'openai', baseUrl, apiKey: OPENAI_KEY, models: {} },
    ],
    routes: {
      'claude-gpt': { provider: 'gpt-auto', model: 'gpt-6-sol' },
      'claude-gpt-chat': { provider: 'gpt-chat', model: 'gpt-6-sol' },
      'claude-nongpt': { provider: 'nongpt-auto', model: 'deepseek-chat' },
    },
  }));
  const gateway = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, GATEWAY_CONFIG: config, GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: '0', GATEWAY_USAGE_DIR: 'off' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let logs = '';
  gateway.stdout.on('data', (chunk) => { logs += chunk; });
  gateway.stderr.on('data', (chunk) => { logs += chunk; });
  t.after(async () => {
    if (gateway.exitCode === null) { gateway.kill(); await once(gateway, 'exit'); }
    upstream.closeAllConnections(); upstream.close();
    await rm(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 100 && !/http:\/\/127\.0\.0\.1:\d+/.test(logs); i++) await wait(25);
  const base = /http:\/\/127\.0\.0\.1:\d+/.exec(logs)?.[0];
  assert.ok(base, logs);
  const sendMessages = (body) => fetch(base + '/v1/messages', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + CLIENT_TOKEN, 'content-type': 'application/json', 'x-claude-code-session-id': SESSION },
    body: JSON.stringify(body),
  });
  const usageRow = async (match) => {
    for (let i = 0; i < 100; i++) {
      const stats = await fetch(base + '/v1/usage', { headers: { authorization: 'Bearer ' + CLIENT_TOKEN } }).then((r) => r.json());
      const row = stats.recent.find(match);
      if (row) return row;
      await wait(20);
    }
    assert.fail('usage row not found');
  };

  // 1. auto + GPT 非流式 → /responses：检查 instructions / input / tools / store:false / assistant output_text
  const jsonResponse = await sendMessages({
    model: 'claude-gpt', system: 'be brief', max_tokens: 32, stream: false,
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'prior' }, { type: 'tool_use', id: 'call_1', name: 'exec', input: { cmd: 'pwd' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'pwd-output' }] },
      { role: 'user', content: 'now what?' },
    ],
    tools: [{ name: 'exec', description: 'run', input_schema: { type: 'object', properties: { cmd: { type: 'string' } } } }],
  });
  const jsonBody = await jsonResponse.json();
  assert.equal(jsonResponse.status, 200, JSON.stringify(jsonBody));
  assert.equal(jsonBody.content[0].text, 'responses json ok');
  const jsonRequest = seen.find((item) => item.path === '/responses' && item.body.stream === false);
  assert.ok(jsonRequest, 'auto GPT 非流式应走 /responses');
  assert.equal(jsonRequest.body.model, 'gpt-6-sol');
  assert.equal(jsonRequest.body.instructions, 'be brief');
  assert.equal(jsonRequest.body.store, false);
  assert.equal(jsonRequest.body.max_output_tokens, 32);
  assert.equal(jsonRequest.body.tools[0].type, 'function');
  assert.deepEqual(jsonRequest.body.input, [
    { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    { role: 'assistant', content: [{ type: 'output_text', text: 'prior' }] },
    { type: 'function_call', call_id: 'call_1', name: 'exec', arguments: '{"cmd":"pwd"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'pwd-output' },
    { role: 'user', content: [{ type: 'input_text', text: 'now what?' }] },
  ]);
  assert.equal(jsonRequest.headers.originator, 'Codex Desktop', 'Claude Code + GPT 使用 codex 头 profile');
  assert.equal(typeof jsonRequest.body.prompt_cache_key, 'string');

  // 2. 同一固定 session 再发流式请求：session-id / prompt_cache_key 稳定，每轮 turn 请求 ID 变化
  const streamResponse = await sendMessages({ model: 'claude-gpt', system: 'be brief', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'stream please' }] });
  const streamText = await streamResponse.text();
  assert.equal(streamResponse.status, 200, streamText);
  assert.match(streamResponse.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.match(streamText, /streamed ok/);
  const streamRequest = seen.find((item) => item.path === '/responses' && item.body.stream === true);
  assert.ok(streamRequest, 'auto GPT 流式应走 /responses');
  assert.equal(streamRequest.headers['session-id'], jsonRequest.headers['session-id'], '同一会话 session-id 稳定');
  assert.equal(streamRequest.body.prompt_cache_key, jsonRequest.body.prompt_cache_key, '同一会话 prompt_cache_key 稳定');
  assert.equal(streamRequest.body.prompt_cache_key, streamRequest.headers['session-id']);
  assert.notEqual(streamRequest.headers['x-client-request-id'], jsonRequest.headers['x-client-request-id'], '每轮 turn 请求 ID 不同');

  // 分段 usage：in_progress 报 input 100，terminal 只报 cached 80 → 账本最终 input 20 / 缓存读 80
  const row = await usageRow((item) => item.route === 'claude-gpt' && item.cacheReadTokens === 80);
  assert.equal(row.inputTokens, 20);
  assert.equal(row.cacheReadTokens, 80);
  assert.equal(row.outputTokens, 0);
  assert.equal(row.upstreamProtocol, 'responses');
  assert.equal(row.adapter, 'messages-to-responses');

  // 3. 显式 chat 的 GPT 路由走 /chat/completions
  const chatResponse = await sendMessages({ model: 'claude-gpt-chat', max_tokens: 16, messages: [{ role: 'user', content: 'chat please' }] });
  const chatBody = await chatResponse.json();
  assert.equal(chatResponse.status, 200, JSON.stringify(chatBody));
  assert.equal(chatBody.content[0].text, 'openai gateway ok');
  assert.ok(seen.some((item) => item.path === '/chat/completions' && item.body.model === 'gpt-6-sol'), '显式 chat 的 GPT 路由应走 /chat/completions');

  // 4. auto + 非 GPT（deepseek-chat）走 /chat/completions
  const nongptResponse = await sendMessages({ model: 'claude-nongpt', max_tokens: 16, messages: [{ role: 'user', content: 'deepseek please' }] });
  assert.equal(nongptResponse.status, 200, await nongptResponse.text());
  assert.ok(seen.some((item) => item.path === '/chat/completions' && item.body.model === 'deepseek-chat'), 'auto 非 GPT 路由应走 /chat/completions');
});

test('native Codex Responses merges usage reported before a partial terminal event', async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    readBody(req).then(({ body }) => {
      seen.push({ path: req.url, body });
      if (req.url !== '/v1/responses') { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      // 终止事件前先报输入 100，response.completed 只带 cached 80
      res.write('event: response.created\ndata: ' + JSON.stringify({ type: 'response.created', response: { id: 'resp_seg' } }) + '\n\n');
      res.write('event: response.in_progress\ndata: ' + JSON.stringify({ type: 'response.in_progress', response: { id: 'resp_seg', usage: { input_tokens: 100 } } }) + '\n\n');
      res.write('event: response.output_text.delta\ndata: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'seg' }) + '\n\n');
      res.write('event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: { id: 'resp_seg', status: 'completed', usage: { input_tokens_details: { cached_tokens: 80 } } } }) + '\n\n');
      return res.end();
    }).catch((error) => { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + upstream.address().port;
  const dir = await mkdtemp(join(tmpdir(), 'gateway-responses-segment-'));
  const config = join(dir, 'providers.json');
  await writeFile(config, JSON.stringify({
    clientToken: CLIENT_TOKEN,
    providers: [{ name: 'openai', apiType: 'openai', baseUrl: baseUrl + '/v1', apiKey: OPENAI_KEY, models: {} }],
    routes: { 'codex-seg': { provider: 'openai', model: 'gpt-6-sol' } },
  }));
  const gateway = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, GATEWAY_CONFIG: config, GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: '0', GATEWAY_USAGE_DIR: 'off' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let logs = '';
  gateway.stdout.on('data', (chunk) => { logs += chunk; });
  gateway.stderr.on('data', (chunk) => { logs += chunk; });
  t.after(async () => {
    if (gateway.exitCode === null) { gateway.kill(); await once(gateway, 'exit'); }
    upstream.closeAllConnections(); upstream.close();
    await rm(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 100 && !/http:\/\/127\.0\.0\.1:\d+/.test(logs); i++) await wait(25);
  const base = /http:\/\/127\.0\.0\.1:\d+/.exec(logs)?.[0];
  assert.ok(base, logs);
  const response = await fetch(base + '/v1/responses', { method: 'POST', headers: { ...codexHeaders, authorization: 'Bearer ' + CLIENT_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'codex-seg', input: 'hello', stream: true }) });
  const streamText = await response.text();
  assert.equal(response.status, 200, streamText);
  assert.match(streamText, /response\.completed/);
  // createResponsesMonitor 逐段合并 usage：终止事件缺 input_tokens 时保留先到的 100，并与 cached 80 拆分成 input 20
  let row;
  for (let i = 0; i < 100 && !row; i++) {
    const stats = await fetch(base + '/v1/usage', { headers: { authorization: 'Bearer ' + CLIENT_TOKEN } }).then((r) => r.json());
    row = stats.recent.find((item) => item.route === 'codex-seg');
    if (!row) await wait(20);
  }
  assert.ok(row, '账本应记录该请求');
  assert.equal(row.inputTokens, 20);
  assert.equal(row.cacheReadTokens, 80);
  assert.equal(row.upstreamProtocol, 'responses');
  assert.equal(seen.at(-1).body.model, 'gpt-6-sol');
});
