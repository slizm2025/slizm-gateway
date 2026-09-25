// 日志展示的端到端检查（本机假上游 + 临时端口，不碰真实上游和真实日志）：
// 1. 起真实 server.js：每个请求在 stdout 各写一行，本地时间、请求 ID、首字节、用量、费用、流内错误 / 未收尾、HTML 错误摘要、系列适配标记都对；
// 2. 在复制出的目录里跑 gw.js：旧 UTC 时间显示成本地时间、-e 只看异常、-f 跟随新行、start 前轮转超过 10MB 的日志。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const strip = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STAMP = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] /;
// Cloudflare 品牌错误页的样子：多行 HTML，<title> 在 300 多字符之后
const CF_502 = `<!DOCTYPE html>\n<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->\n<!-- ${'x'.repeat(300)} -->\n<head>\n<title>190515.xyz | 502: Bad gateway</title>\n</head>\n<body>Bad gateway</body>\n</html>`;

async function freePort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

function localStamp(iso) {
  const d = new Date(iso);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

test('server.js：每个请求的日志各占一行，内容准确', async (t) => {
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const model = JSON.parse(raw || '{}').model;
      const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (req.url.endsWith('/chat/completions')) {
        // openai 流中途坏掉：先给一段正常 delta，再给一行不合法的 JSON
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: { content: 'hi' } }] })}\n\n`);
        return res.end('data: {broken\n\n');
      }
      if (model === 'cf-502') {
        res.writeHead(502, { 'content-type': 'text/html' });
        return res.end(CF_502);
      }
      if (model === 'gemini-x') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id: 'm1', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      sse('message_start', { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 1200 } } });
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      // 正文里出现 message_stop / "error" / "usage" 字样，不能被当成事件
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'message_stop "error" "usage"' } });
      if (model === 'err-sse') {
        sse('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
        return res.end();
      }
      if (model === 'cut-sse') return res.end();
      sse('content_block_stop', { type: 'content_block_stop', index: 0 });
      sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } });
      sse('message_stop', { type: 'message_stop' });
      res.end();
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upBase = `http://127.0.0.1:${upstream.address().port}`;
  const dir = await mkdtemp(join(tmpdir(), 'gw-logging-'));
  const config = join(dir, 'providers.json');
  await writeFile(config, JSON.stringify({
    clientToken: 'logging-client',
    providers: [
      { name: 'anth', apiType: 'anthropic', baseUrl: upBase, apiKey: 'sk-logging-fixture-key', maxAttempts: 1 },
      { name: 'oai', apiType: 'openai', baseUrl: upBase, apiKey: 'sk-logging-fixture-key', authStyle: 'bearer', maxAttempts: 1 },
    ],
    routes: {
      'ok-alias': { provider: 'anth', model: 'ok-sse' },
      'err-sse': 'anth',
      'cut-sse': 'anth',
      'cf-502': 'anth',
      'gemini-x': 'anth',
      'oai-broken': { provider: 'oai', model: 'gpt-x' },
    },
    pricing: {
      'ok-sse': { input: 1, cacheRead: 0.5, cacheWrite: 0, output: 2 },
    },
  }));
  const port = await freePort();
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: { ...process.env, GATEWAY_CONFIG: config, GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: String(port), GATEWAY_LOG_REQUESTS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  t.after(async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { ready = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(300) })).ok; } catch { await sleep(50); }
  }
  assert.ok(ready, out + err);
  const post = (model, { stream = true, headers = {}, system } = {}) => fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer logging-client', 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model, max_tokens: 16, stream, ...(system ? { system } : {}), messages: [{ role: 'user', content: 'hi' }] }),
    signal: AbortSignal.timeout(5000),
  });

  const ok = await post('ok-alias', { headers: { 'x-request-id': 'client-supplied-id' } });
  assert.ok((await ok.text()).includes('message_stop'));
  assert.match(ok.headers.get('x-request-id'), /^gw_[0-9a-f]{8}$/);
  await (await post('err-sse')).text();
  await (await post('cut-sse')).text();
  const cf = await post('cf-502', { stream: false });
  const cfBody = await cf.text();
  assert.equal(cf.status, 502);
  assert.ok(cfBody.includes('190515.xyz | 502: Bad gateway') && !cfBody.includes('DOCTYPE'), cfBody);
  assert.equal((await post('gemini-x', { stream: false, system: "You are Claude Code, Anthropic's official CLI." })).status, 200);
  assert.ok((await (await post('oai-broken')).text()).includes('event: error'));
  const usage = await (await fetch(`${base}/v1/usage`, { headers: { authorization: 'Bearer logging-client' } })).json();
  await sleep(100);

  const lines = out.split(/\r?\n/).filter(Boolean);
  const find = (...parts) => lines.find((l) => parts.every((p) => l.includes(p)));
  await t.test('每行都以本地时间开头，HTML 错误页没有把一条日志拆成多行', () => {
    for (const line of lines) assert.match(line, STAMP, line);
    assert.ok(!out.includes('DOCTYPE') && !out.includes('<head>'), out);
  });
  await t.test('启动时一个 provider 一行', () => {
    assert.ok(find('网关已启动', `:${port}`, '6 条路由'), out);
    assert.ok(find('anth（anthropic）', 'ok-alias⇒ok-sse', 'err-sse'), out);
    assert.ok(find('oai（openai）', 'oai-broken⇒gpt-x'), out);
  });
  await t.test('请求 ID 由网关生成，不回显客户端带来的值', () => {
    assert.ok(!out.includes('client-supplied-id'), out);
    assert.match(find('→ ok-alias ⇒ ok-sse @anth · 流式') ?? '', /\] \[gw_[0-9a-f]{8}\] → /);
  });
  await t.test('成功的流式请求：首字节、总耗时、字节数和上游上报的用量', () => {
    const done = find('← ok-alias · 200 · 首字节');
    assert.ok(done, out);
    for (const part of ['· 共 ', 'B · ', '输入 3', '缓存读 1.2k', '输出 7', '费用 $0.000617']) assert.ok(done.includes(part), done);
  });
  await t.test('流里的 error 事件、没有 message_stop 就结束，都不算成功', () => {
    assert.ok(find('✗ err-sse · 200 流内错误', 'overloaded_error: Overloaded'), out);
    assert.ok(find('⚠ cut-sse · 200 流未收尾'), out);
    assert.ok(find('✗ oai-broken · 200 流内错误'), out);
    assert.equal(usage.routes['ok-alias'].successes, 1);
    for (const route of ['err-sse', 'cut-sse', 'oai-broken']) assert.equal(usage.routes[route].errors, 1, route);
  });
  await t.test('上游 HTML 错误页只记标题', () => {
    assert.ok(find('✗ cf-502 · 上游 502', '190515.xyz | 502: Bad gateway'), out);
  });
  await t.test('按模型系列改写过请求体时标出来', () => {
    assert.ok(find('→ gemini-x @anth · 非流式', '[gemini 适配]'), out);
    assert.ok(!find('→ ok-alias', '适配]'), out);
  });
});

test('gw.js logs：本地时间、只看异常、持续跟随；start 前轮转大日志', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gw-logs-cli-'));
  const gateway = join(dir, 'claude-gateway');
  await mkdir(join(gateway, 'scripts'), { recursive: true });
  await mkdir(join(gateway, 'logs'), { recursive: true });
  await cp(join(root, 'src'), join(gateway, 'src'), { recursive: true });
  await cp(join(root, 'scripts', 'gw.js'), join(gateway, 'scripts', 'gw.js'));
  await writeFile(join(gateway, 'package.json'), '{"type":"module"}');
  const port = await freePort();
  const config = join(gateway, 'providers.json');
  await writeFile(config, JSON.stringify({ clientToken: 'cli-client', providers: [{ name: 'p', apiType: 'openai', apiKey: 'fixture-key', baseUrl: 'http://127.0.0.1:1' }], routes: { fixture: 'p' } }));
  const env = { ...process.env, GATEWAY_PORT: String(port), GATEWAY_HOST: '127.0.0.1', GATEWAY_CONFIG: config };
  const gw = (...args) => exec(process.execPath, ['scripts/gw.js', ...args], { cwd: gateway, env, timeout: 15000, windowsHide: true }).then((r) => strip(r.stdout));
  const outLog = join(gateway, 'logs', 'gateway.out.log');
  let running = false;
  t.after(async () => {
    if (running) { try { await gw('stop'); } catch { /* 已经停了 */ } }
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(outLog, [
    '[2026-09-24T19:56:51.981Z] ← claude-opus-5-5-any 上游响应头 200 (7244ms, content-type=text/event-stream)',
    '[2026-09-24T19:57:40.617Z] ← claude-sonnet-5 上游错误 502: <!DOCTYPE html>',
    '<head>',
    '[2026-09-25 05:04:03.128] [gw_1a2b3c4d] → x @p · 流式 · 输入≈10',
    '[2026-09-25 05:04:04.000] [gw_1a2b3c4d] ✗ x · 上游 502 · 1.0s · boom',
    '',
  ].join('\n'));

  await t.test('旧日志的 UTC 时间显示成本地时间', async () => {
    const shown = await gw('logs', '10');
    assert.ok(shown.includes(`[${localStamp('2026-09-24T19:56:51.981Z')}] ← claude-opus-5-5-any`), shown);
    assert.ok(!shown.includes('2026-09-24T19:56:51.981Z'), shown);
  });
  await t.test('n 只取最后几行；-e 只留 ✗ ⚠ ↻ 和旧格式的错误行', async () => {
    const last = (await gw('logs', '1', '--detail')).split('\n').filter((l) => l.startsWith('['));
    assert.equal(last.length, 1, last.join('\n'));
    assert.ok(last[0].includes('✗ x · 上游 502'), last[0]);
    const problems = await gw('logs', '10', '-e', '--detail');
    assert.ok(problems.includes('上游错误 502') && problems.includes('✗ x · 上游 502'), problems);
    assert.ok(!problems.includes('→ x @p') && !problems.includes('上游响应头') && !problems.includes('<head>'), problems);
  });
  await t.test('-f 持续输出新写入的行', async () => {
    const child = spawn(process.execPath, ['scripts/gw.js', 'logs', '1', '-f'], { cwd: gateway, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let seen = '';
    child.stdout.on('data', (c) => { seen += strip(String(c)); });
    try {
      for (let i = 0; i < 60 && !seen.includes('持续跟随'); i++) await sleep(50);
      await appendFile(outLog, '[2026-09-25 05:04:05.000] [gw_1a2b3c4d] ← x · 200 · 1.0s\n');
      for (let i = 0; i < 60 && !seen.includes('← 成功'); i++) await sleep(50);
      assert.match(seen, /05:04:05\.000\s+← 成功\s+x\s+1a2b3c4d\s+200 · 1\.0s/);
    } finally {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });
  await t.test('紧凑布局、精确筛选、原始输出与终端安全', async () => {
    const original = await readFile(outLog, 'utf8');
    const fixture = [
      '[2026-09-25 09:52:20.000] [gw_11111111] → gemini ⇒ model @p · 流式 · 输入≈54000',
      '[2026-09-25 09:52:25.814] [gw_11111111] ← gemini · 200 · 首字节 5.2s · 共 5.4s · 输入 54.1k · 缓存读 1.2k · 输出 36 · 费用 $0.000617',
      '[2026-09-25 09:52:26.000] [gw_22222222] ✗ gemini-pro · 200 流内错误 · overloaded_error: boom',
      '[2026-09-25 09:52:27.000] [gw_33333333] ↻ 中文路由 · 1.3s 后第 1 次重试 · HTTP 429',
      '[2026-09-25 09:52:28.000] [gw_44444444] ⊘ gemini · 客户端已断开',
      '[2026-09-26 00:00:00.001] [gw_55555555] ⚠ 中文超长路由名字用于验证窄屏展示 · 200 流未收尾 · 尾部诊断不可丢失',
    ].join('\n') + '\n';
    try {
      await writeFile(outLog, fixture);
      const shown = await gw('logs', '10');
      for (const label of ['紧凑', '时间', '状态', '路由', '请求 ID', '2026-09-25', '2026-09-26', '成功', '失败', '警告', '重试', '取消', '54.1k', '5.2s', '流内错误', '尾部诊断不可丢失']) assert.ok(shown.includes(label), label + '\n' + shown);
      const colored = await exec(process.execPath, ['scripts/gw.js', 'logs', '10'], { cwd: gateway, env: { ...env, FORCE_COLOR: '1', NO_COLOR: undefined }, timeout: 15000 });
      assert.match(colored.stdout, /\u001b\[34m输入 54\.1k\u001b\[0m/);
      assert.match(colored.stdout, /\u001b\[35m缓存读 1\.2k\u001b\[0m/);
      assert.match(colored.stdout, /\u001b\[32m输出 36\u001b\[0m/);
      assert.match(colored.stdout, /\u001b\[33m费用 \$0\.000617\u001b\[0m/);
      const noColor = await exec(process.execPath, ['scripts/gw.js', 'logs', '10'], { cwd: gateway, env: { ...env, FORCE_COLOR: '1', NO_COLOR: '1' }, timeout: 15000 });
      assert.equal(noColor.stdout.includes('\u001b['), false);
      const request = await gw('logs', '--id', '11111111', '1');
      assert.ok(request.includes('54.1k') && !request.includes('输入≈') && !request.includes('boom'), request);
      const route = await gw('logs', '--route', 'gemini', '10', '--detail');
      assert.ok(route.includes('54.1k') && route.includes('客户端已断开') && !route.includes('gemini-pro'), route);
      const errors = await gw('logs', '-e', '--id=gw_22222222', '--route=gemini-pro');
      assert.ok(errors.includes('失败') && errors.includes('200 流内错误') && !errors.includes('54.1k'), errors);
      assert.ok((await gw('logs', '--route', 'absent')).includes('没有匹配的日志'));
      assert.ok((await gw('logs', '10', '--detail')).includes(fixture.split('\n')[1]));
      const raw = await exec(process.execPath, ['scripts/gw.js', 'logs', '10', '--raw'], { cwd: gateway, env, timeout: 15000 });
      assert.equal(raw.stdout.replace(/\r\n/g, '\n'), fixture);
      assert.equal(await gw('logs', '--raw', '--id', 'abcdef12'), '');
      const narrow = await gw('logs', '10', '--width', '60');
      assert.ok(narrow.includes('窄屏') && narrow.includes('尾部诊断不可丢失') && narrow.includes('中文超长路由名字用于验证窄屏展示'), narrow);
      const wide = await gw('logs', '10', '--width', '100');
      for (const [output, width] of [[narrow, 60], [wide, 100]]) {
        for (const line of output.split('\n')) {
          const actual = [...line].reduce((sum, ch) => sum + (/[^\x00-\xff]/u.test(ch) && !/[·←→✓✗⚠↻⊘≈…─]/u.test(ch) ? 2 : 1), 0);
          assert.ok(actual <= width, 'overflow: ' + actual + ' ' + line);
        }
      }
      for (const args of [['--id'], ['--id', 'abc'], ['--width', 'NaN'], ['0'], ['--route', ''], ['--wat'], ['--raw', '--detail'], ['--raw', '--history']]) {
        await assert.rejects(exec(process.execPath, ['scripts/gw.js', 'logs', ...args], { cwd: gateway, env, timeout: 15000 }), (e) => e.code === 1 && /参数/.test(e.stdout + e.stderr));
      }
      await appendFile(outLog, '[2026-09-26 00:00:01.000] [gw_66666666] ✗ x · \u001b]0;bad-title\u0007oops\u001b[2J\n');
      const safe = await exec(process.execPath, ['scripts/gw.js', 'logs', '1', '--detail'], { cwd: gateway, env: { ...env, NO_COLOR: '1', FORCE_COLOR: '0' }, timeout: 15000 });
      assert.ok(!safe.stdout.includes('\u001b') && !safe.stdout.includes('bad-title') && safe.stdout.includes('oops'), safe.stdout);
    } finally { await writeFile(outLog, original); }
  });
  await t.test('持续跟随复用筛选与模式，不丢初始 UTF-8 半行', async (t) => {
    const original = await readFile(outLog, 'utf8');
    const lf = String.fromCharCode(10);
    try {
      for (const mode of ['--detail', '--raw']) await t.test(mode, async () => {
        const ready = '[2026-09-25 10:00:00.000] [gw_77777777] ✗ flow · READY';
        const complete = '[2026-09-25 10:00:01.000] [gw_77777777] ✗ flow · 中文分片完成';
        const final = '[2026-09-25 10:00:05.000] [gw_77777777] ↻ flow · END_MARKER';
        const bytes = Buffer.from(complete + lf);
        const split = bytes.indexOf(Buffer.from('中')) + 1;
        await writeFile(outLog, Buffer.concat([Buffer.from(ready + lf), bytes.subarray(0, split)]));
        const child = spawn(process.execPath, ['scripts/gw.js', 'logs', '10', '-f', '-e', '--id=77777777', '--route=flow', mode], { cwd: gateway, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let seen = '', errors = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (c) => { seen += strip(c); });
        child.stderr.on('data', (c) => { errors += String(c); });
        const waitFor = async (text) => {
          for (let i = 0; i < 100 && !seen.includes(text) && child.exitCode === null; i++) await sleep(50);
          assert.ok(seen.includes(text), seen + errors);
        };
        try {
          await waitFor('READY');
          assert.ok(!seen.includes('中文') && !seen.includes('10:00:01'), seen);
          await appendFile(outLog, bytes.subarray(split));
          await appendFile(outLog, [
            '[2026-09-25 10:00:02.000] [gw_88888888] ✗ flow · WRONG_ID',
            '[2026-09-25 10:00:03.000] [gw_77777777] ✗ flow-extra · WRONG_ROUTE',
            '[2026-09-25 10:00:04.000] [gw_77777777] ← flow · WRONG_STATUS',
            final, '',
          ].join(lf));
          await waitFor('END_MARKER');
          assert.ok(seen.includes(complete) && !seen.includes('WRONG_') && !seen.includes('�'), seen);
          assert.equal(seen.split('中文分片完成').length - 1, 1);
          if (mode === '--raw') assert.equal(seen, [ready, complete, final, ''].join(lf));
          await writeFile(outLog, '[2026-09-25 10:00:06.000] [gw_77777777] ✗ flow · AFTER_TRUNCATE' + lf);
          await waitFor('AFTER_TRUNCATE');
          if (mode === '--raw') assert.ok(!seen.includes('──'), seen);
        } finally {
          if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit'); child.kill(); await exited;
          }
        }
      });
    } finally { await writeFile(outLog, original); }
  });
  await t.test('stderr 历史记录与当前错误的展示边界', async (t) => {
    const errLog = join(gateway, 'logs', 'gateway.err.log');
    const oldDate = new Date('2026-09-24T06:13:41.000Z');
    const startedAt = '2026-09-25T01:48:31.000Z';
    const currentDate = new Date('2026-09-25T01:52:25.814Z');
    const legacy = 'Error [ERR_HTTP_HEADERS_SENT]: Cannot write headers after they are sent to the client\n    at ServerResponse.writeHead (node:_http_server:356:11)\nNode.js v24.14.0\n';
    const current = `[${localStamp(currentDate.toISOString())}] 当前进程错误: CURRENT_FIXTURE_ERROR\n    at currentFixture (fixture.js:1:1)\n`;
    let healthInfo = { service: 'claude-gateway', pid: 12345, startedAt };
    let healthStatus = 200;
    const mock = http.createServer((req, res) => {
      res.writeHead(healthStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify(healthInfo));
    });
    await new Promise((r) => mock.listen(port, '127.0.0.1', r));
    t.after(async () => {
      mock.closeAllConnections();
      await new Promise((r) => mock.close(r));
      await rm(errLog, { force: true });
    });
    const seed = async (text, date) => {
      await writeFile(errLog, text);
      await utimes(errLog, date, date);
    };

    await t.test('默认和 -e 不重复打印早于当前进程的旧崩溃栈', async () => {
      await seed(legacy, oldDate);
      for (const args of [[], ['-e']]) {
        const shown = await gw('logs', '1', ...args);
        assert.ok(!shown.includes('ERR_HTTP_HEADERS_SENT'), shown);
        assert.ok(!shown.includes('ServerResponse.writeHead'), shown);
        assert.ok(shown.includes('--history'), shown);
      }
      assert.equal(await readFile(errLog, 'utf8'), legacy, '查看日志不得清空历史证据');
    });
    await t.test('--history 显式显示历史崩溃栈并标注历史', async () => {
      const shown = await gw('logs', '1', '--history');
      assert.ok(shown.includes('ERR_HTTP_HEADERS_SENT') && shown.includes('历史记录'), shown);
    });
    await t.test('追加当前错误后只显示当前多行错误，历史仍可查看', async () => {
      await seed(legacy + current, currentDate);
      const shown = await gw('logs', '1');
      assert.ok(shown.includes('CURRENT_FIXTURE_ERROR') && shown.includes('at currentFixture'), shown);
      assert.ok(!shown.includes('ERR_HTTP_HEADERS_SENT'), shown);
      const history = await gw('logs', '1', '--history');
      assert.ok(history.includes('CURRENT_FIXTURE_ERROR') && history.includes('ERR_HTTP_HEADERS_SENT'), history);
    });
    await t.test('修改时间较新但无时间戳的错误不能静默隐藏', async () => {
      await seed(legacy, currentDate);
      assert.ok((await gw('logs', '1')).includes('ERR_HTTP_HEADERS_SENT'));
    });
    await t.test('无法确认网关实例或启动时间时保留错误线索', async () => {
      await seed(legacy, oldDate);
      for (const info of [null, { service: 'claude-gateway', startedAt: 'invalid' }, { service: 'other-service', startedAt }]) {
        healthInfo = info;
        healthStatus = info === null ? 503 : 200;
        const shown = await gw('logs', '1');
        assert.ok(shown.includes('ERR_HTTP_HEADERS_SENT'), shown);
        assert.ok(shown.includes('无法确认'), shown);
      }
    });
  });
  await t.test('start 前把超过 10MB 的日志移进 logs/archive/', async () => {
    await writeFile(outLog, `${'x'.repeat(1023)}\n`.repeat(11 * 1024));
    await gw('start');
    running = true;
    const archived = await readdir(join(gateway, 'logs', 'archive'));
    assert.equal(archived.filter((f) => /^gateway\.out\.\d{8}-\d{6}\.log$/.test(f)).length, 1, archived.join(','));
    // 新文件里只有新进程的输出，第一行就是带本地时间的启动行
    let fresh = '';
    for (let i = 0; i < 40 && !fresh.includes('网关已启动'); i++) { fresh = await readFile(outLog, 'utf8'); await sleep(50); }
    assert.ok((await stat(outLog)).size < 64 * 1024);
    assert.match(fresh.split('\n')[0], /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] 网关已启动 /);
    await gw('stop');
    running = false;
  });
});
