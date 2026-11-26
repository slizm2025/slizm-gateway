// DeepSeek Harness 客户端接入的离线回归：识别、鉴权、转发都在本地模拟上游上验证。
// 请求头与请求体照抄实际在用的 dsh-llm-deepseek 适配器（@deepseek-ai/dsh-llm 0.2.0-rc.2）。
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root = fileURLToPath(new URL('../', import.meta.url));
const token = 'dsh-client-fixture-token';
const accountToken = 'dsh-account-fixture-token';
const key = 'dsh-provider-fixture-key';

const harnessUserAgent = 'deepseek-harness/0.2.0-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)';
const harnessBeta = 'mid-conversation-tool-changes-2026-07-01,files-api-2025-04-14';
const anthropicSse = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":3,"output_tokens":0}}}',
  '', '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
  '', '',
  'event: message_delta',
  'data: {"type":"message_delta","usage":{"output_tokens":1}}',
  '', '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '', '',
].join('\n');

// 与 dsh-llm-deepseek 的序列化结果同形：顶层 system、必带 thinking 开关、
// 中途工具启停用 system 角色的 tool_addition/tool_removal 块表达，
// 另带官方 DeepSeek 请求的 dsh_session_log / dsh_plugin_packages 扩展字段。
const dshMessagesBody = (model) => ({
  model,
  stream: true,
  max_tokens: 1024,
  system: 'You are a coding agent.',
  thinking: { type: 'enabled' },
  output_config: { effort: 'high' },
  dsh_session_log: { version: 1, afterSeq: -1, events: [{ seq: 0 }] },
  dsh_plugin_packages: { version: 1, packages: [{ name: 'dsh-base', version: '0.2.0-rc.2' }] },
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'system', content: [{ type: 'tool_addition', tool: { type: 'tool_reference', name: 'search' } }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'private-reasoning', signature: 'sig' }, { type: 'text', text: 'ok' }] },
  ],
  tools: [{ name: 'search', description: 'search', input_schema: { type: 'object' }, defer_loading: true }],
});

// DeepSeek Harness 客户端消费 Anthropic SSE 的硬性要求，逐条对应
// dsh-llm-deepseek 的 parseSse()（event 名必须等于 data.type）与 translate()
//（message_start 唯一且最先、块索引合法且不重复、delta 只属于已打开的块、
//  message_stop 前所有块已关闭且已有 stop_reason、end_turn 不能零内容块）。
const ALLOWED_BLOCK_TYPES = ['text', 'thinking', 'tool_use'];
const ALLOWED_STOP_REASONS = ['end_turn', 'stop_sequence', 'tool_use', 'max_tokens'];
function assertDshStreamContract(text) {
  const frames = text.split('\n\n').filter((frame) => frame.trim()).map((frame) => {
    const lines = frame.split('\n');
    const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
    const data = JSON.parse(lines.find((line) => line.startsWith('data: ')).slice(6));
    return { event, data };
  });
  assert.ok(frames.length, '没有产出任何 SSE 帧');
  assert.equal(frames[0].data.type, 'message_start', '第一个事件必须是 message_start');
  assert.equal(frames.filter((frame) => frame.data.type === 'message_start').length, 1, 'message_start 只能出现一次');
  assert.equal(frames.at(-1).data.type, 'message_stop', '最后一个事件必须是 message_stop');
  const open = new Set();
  const seen = new Set();
  let blocks = 0;
  let stopReason;
  for (const { event, data } of frames) {
    assert.equal(event, data.type, `SSE event 名必须等于 data.type: ${event} vs ${data.type}`);
    if (data.type === 'message_start') continue;
    if (data.type === 'content_block_start') {
      assert.ok(Number.isSafeInteger(data.index) && data.index >= 0, `非法块索引 ${data.index}`);
      assert.ok(!seen.has(data.index), `块索引重复 ${data.index}`);
      seen.add(data.index);
      open.add(data.index);
      assert.ok(ALLOWED_BLOCK_TYPES.includes(data.content_block?.type), `不支持的块类型 ${data.content_block?.type}`);
      blocks += 1;
    } else if (data.type === 'content_block_delta' || data.type === 'content_block_stop') {
      assert.ok(open.has(data.index), `块 ${data.index} 未打开或已关闭`);
      if (data.type === 'content_block_stop') open.delete(data.index);
    } else if (data.type === 'message_delta') {
      stopReason = data.delta?.stop_reason;
      assert.ok(ALLOWED_STOP_REASONS.includes(stopReason), `不支持的 stop_reason ${stopReason}`);
    } else if (data.type === 'message_stop') {
      assert.equal(open.size, 0, 'message_stop 时仍有未关闭的块');
      assert.ok(stopReason, 'message_stop 前必须有 stop_reason');
      if (stopReason === 'end_turn') assert.ok(blocks > 0, 'end_turn 不能零内容块（DSH 会按 EMPTY_RESPONSE 报错）');
    } else {
      assert.fail(`DSH 未预期的块类型 ${data.type}`);
    }
  }
  return frames;
}

test('DeepSeek Harness requests are identified, authenticated and forwarded', async (t) => {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try { body = JSON.parse(raw); } catch { /* ignore */ }
    seen.push({ raw, body, headers: req.headers, path: req.url });
    if (req.url.endsWith('/v1/messages')) {
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        return res.end(anthropicSse);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'msg_upstream', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 3, output_tokens: 1 } }));
    }
    if (body.model === 'gpt-empty') {
      // 有响应但没有内容：真实 Anthropic 会回一个空文本块，DSH 也要求至少一个块。
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end('data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'
        + 'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
    }
    if (body.model === 'gpt-usage') {
      // 只有 usage 块、没有任何 choices：网关仍必须先发 message_start。
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end('data: {"id":"c2","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\n');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'chatcmpl_upstream', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const dir = await mkdtemp(join(tmpdir(), 'dsh-agent-'));
  const usageDir = join(dir, 'usage');
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
  await writeFile(config, JSON.stringify({
    clientToken: token,
    providers: [
      { name: 'anth', apiType: 'anthropic', baseUrl, apiKey: key },
      { name: 'oai', apiType: 'openai', messagesTransport: 'chat-completions', baseUrl: baseUrl + '/v1', apiKey: key },
    ],
    routes: {
      'dsh-anthropic': { provider: 'anth', model: 'deepseek-flash' },
      'dsh-openai': { provider: 'oai', model: 'gpt-test' },
      'dsh-gemini': { provider: 'oai', model: 'gemini-4-hydrogen-high' },
      'dsh-empty': { provider: 'oai', model: 'gpt-empty' },
      'dsh-usage': { provider: 'oai', model: 'gpt-usage' },
    },
  }));
  let logs = '';
  child = spawn(process.execPath, [join(root, 'src/server.js')], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GATEWAY_CONFIG: config, GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: '0', GATEWAY_USAGE_DIR: usageDir, GATEWAY_WEB_ENABLED: '0' },
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

  const harnessHeaders = (extra = {}) => ({
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': harnessBeta,
    'user-agent': harnessUserAgent,
    'x-deepseek-harness-user-id': 'anonymous-user-fixture',
    'x-deepseek-harness-session-id': 'session-fixture',
    'x-deepseek-harness-compact': '1',
    'x-api-key': token,
    ...extra,
  });
  const post = (path, raw, headers) => fetch(base + path, { method: 'POST', headers, body: raw, signal: AbortSignal.timeout(5000) });

  await t.test('native Messages passthrough keeps the Harness fingerprint and swaps only credentials', async () => {
    const raw = JSON.stringify(dshMessagesBody('dsh-anthropic'));
    const response = await post('/v1/messages', raw, harnessHeaders());
    const text = await response.text();
    assert.equal(response.status, 200, text);
    // 上游 SSE 原样回到客户端
    assert.equal(text, anthropicSse);
    const request = seen.at(-1);
    assert.equal(request.path, '/v1/messages');
    // 请求体逐字节透传，只替换顶层 model
    assert.equal(request.raw, raw.replace('"dsh-anthropic"', '"deepseek-flash"'));
    assert.equal(request.headers['user-agent'], harnessUserAgent);
    assert.equal(request.headers['x-deepseek-harness-user-id'], 'anonymous-user-fixture');
    assert.equal(request.headers['x-deepseek-harness-session-id'], 'session-fixture');
    assert.equal(request.headers['x-deepseek-harness-compact'], '1');
    assert.equal(request.headers['anthropic-beta'], harnessBeta);
    assert.equal(request.headers['anthropic-version'], '2023-06-01');
    // 客户端凭据换成上游 key（沿用入站的 x-api-key 鉴权风格），客户端 token 不出现给上游
    assert.equal(request.headers['x-api-key'], key);
    assert.equal(request.headers.authorization, undefined);
    assert.ok(!request.raw.includes(token));
    // DSH 官方 API 扩展字段原样交给 Anthropic 上游
    assert.deepEqual(request.body.dsh_plugin_packages, { version: 1, packages: [{ name: 'dsh-base', version: '0.2.0-rc.2' }] });
    assert.ok(request.body.dsh_session_log);
  });

  await t.test('the account client credential authenticates and never reaches the upstream', async () => {
    const headers = harnessHeaders();
    delete headers['x-api-key'];
    headers['x-dsh-auth-token'] = token;
    const response = await post('/v1/messages', JSON.stringify(dshMessagesBody('dsh-anthropic')), headers);
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const request = seen.at(-1);
    assert.equal(request.headers['x-dsh-auth-token'], undefined);
    assert.equal(request.headers.authorization, 'Bearer ' + key);
  });

  await t.test('an unrelated credential is still rejected', async () => {
    const headers = harnessHeaders({ 'x-dsh-auth-token': accountToken });
    delete headers['x-api-key'];
    const response = await post('/v1/messages', JSON.stringify(dshMessagesBody('dsh-anthropic')), headers);
    assert.equal(response.status, 401);
    await response.text();
  });

  await t.test('the OpenAI adapter drops DeepSeek-only fields without corrupting messages', async () => {
    const response = await post('/v1/messages', JSON.stringify(dshMessagesBody('dsh-openai')), harnessHeaders());
    const text = await response.text();
    assert.equal(response.status, 200, text);
    // 上游用 JSON（不是 SSE）作答时走 anthropicJsonToStream，同样要满足 DSH 契约
    assertDshStreamContract(text);
    const request = seen.at(-1);
    assert.equal(request.path, '/v1/chat/completions');
    assert.equal(request.body.model, 'gpt-test');
    // 顶层 DeepSeek 扩展字段不能漏给聊天补全上游
    assert.equal(request.body.dsh_session_log, undefined);
    assert.equal(request.body.dsh_plugin_packages, undefined);
    assert.equal(request.body.output_config, undefined);
    assert.equal(request.body.thinking, undefined);
    // 工具仍被声明；tool_addition / thinking 控制块不能变成文本
    assert.deepEqual(request.body.tools.map((tool) => tool.function.name), ['search']);
    const messages = JSON.stringify(request.body.messages);
    for (const leak of ['tool_addition', 'tool_removal', 'private-reasoning', 'dsh_session_log']) assert.ok(!messages.includes(leak), messages);
    assert.equal(request.headers['user-agent'], harnessUserAgent);
    assert.equal(request.headers.authorization, 'Bearer ' + key);
    assert.equal(request.headers['x-api-key'], undefined);
  });

  await t.test('Gemini routes rewrite DeepSeek Harness system signatures while preserving user content and non-Gemini routes', async () => {
    const dshSystemPrompt = [
      'You are an AI agent powered by DeepSeek Harness.',
      'The DeepSeek Harness implementation checkout is at D:\\project\\dsh\\deepseek-harness.',
      'You are interacting with the user through the DeepSeek Harness Web GUI at http://127.0.0.1:3000. The browser provides no implicit DOM, route, or screenshot context.',
    ].join('\n\n');
    const body = {
      ...dshMessagesBody('dsh-gemini'),
      system: dshSystemPrompt,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Mention DeepSeek Harness here.' }] },
        { role: 'system', content: [{ type: 'tool_addition', tool: { type: 'tool_reference', name: 'search' } }, { type: 'text', text: 'DeepSeek Harness extra rule.' }] },
      ],
    };
    const response = await post('/v1/messages', JSON.stringify(body), harnessHeaders());
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assertDshStreamContract(text);
    const request = seen.at(-1);
    assert.equal(request.path, '/v1/chat/completions');
    assert.equal(request.body.model, 'gemini-4-hydrogen-high');
    const sysMsg = request.body.messages.find((m) => m.role === 'system');
    assert.ok(sysMsg, 'system message should be present');
    assert.ok(!/DeepSeek\s+Harness/i.test(sysMsg.content), sysMsg.content);
    assert.ok(sysMsg.content.startsWith('You are an AI coding agent.'), sysMsg.content);
    assert.ok(sysMsg.content.includes('The Agent Harness implementation checkout is at D:\\project\\dsh\\deepseek-harness.'), sysMsg.content);
    assert.ok(sysMsg.content.includes('You are interacting with the user through the Agent Harness Web GUI at http://127.0.0.1:3000. No browser DOM, route, or screenshot state is attached automatically.'), sysMsg.content);
    assert.ok(!/The browser provides no implicit DOM, route, or screenshot context\./i.test(sysMsg.content), sysMsg.content);
    assert.ok(sysMsg.content.includes('Agent Harness extra rule.'), sysMsg.content);
    const userMsg = request.body.messages.find((m) => m.role === 'user');
    assert.equal(userMsg.content, 'Mention DeepSeek Harness here.');
  });

  await t.test('converted streams satisfy the DSH Anthropic-SSE contract when upstream completes without content', async () => {
    const empty = await post('/v1/messages', JSON.stringify(dshMessagesBody('dsh-empty')), harnessHeaders());
    const emptyText = await empty.text();
    assert.equal(empty.status, 200, emptyText);
    const frames = assertDshStreamContract(emptyText);
    const blocks = frames.filter((frame) => frame.data.type === 'content_block_start');
    assert.deepEqual(blocks.map((frame) => frame.data.content_block.type), ['text']);
    assert.equal(blocks[0].data.content_block.text, '');
    assert.equal(frames.find((frame) => frame.data.type === 'message_delta').data.delta.stop_reason, 'end_turn');
  });

  await t.test('a stream without any choice chunk stays an explicit error event, not a malformed success', async () => {
    const usageOnly = await post('/v1/messages', JSON.stringify(dshMessagesBody('dsh-usage')), harnessHeaders());
    const text = await usageOnly.text();
    assert.equal(usageOnly.status, 200, text);
    const frames = text.split('\n\n').filter((frame) => frame.trim()).map((frame) => {
      const lines = frame.split('\n');
      return { event: lines.find((line) => line.startsWith('event: '))?.slice(7), data: JSON.parse(lines.find((line) => line.startsWith('data: ')).slice(6)) };
    });
    // DSH 的 parseSse 遇到 type=error 会抛出 providerError，不会把半截流转成成功消息
    assert.equal(frames.length, 1, text);
    assert.equal(frames[0].event, 'error');
    assert.equal(frames[0].data.type, 'error');
  });

  await t.test('logs and the usage ledger both name DeepSeek Harness', async () => {
    const ledger = join(usageDir, `usage-${new Date().toISOString().slice(0, 7)}.jsonl`);
    let lines = [];
    for (let i = 0; i < 100 && lines.length < 6; i++) {
      try { lines = readFileSync(ledger, 'utf8').trim().split('\n').map((line) => JSON.parse(line)); } catch { lines = []; }
      if (lines.length >= 6) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // 6 次成功请求各一条；401 不记账
    assert.equal(lines.length, 6, JSON.stringify(lines));
    for (const item of lines) assert.equal(item.clientType, 'deepseek-harness', JSON.stringify(item));
    assert.ok(logs.includes('⬢[DSH]⬢'), logs);
    assert.ok(!logs.includes('~(·)><'), logs);
  });
});
