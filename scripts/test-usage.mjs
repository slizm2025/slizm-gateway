// token 记账、用量报表，以及 reasoning → thinking 转换的回归测试（只用本机假上游，不调用收费模型）。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { anthropicUsageFromOpenAI, toAnthropicResponse, parseCompletion } from '../src/providers/openai.js';
import { openAIToAnthropicStream } from '../src/stream.js';
import { adaptBodyForModelSeries, modelSeries } from '../src/model-series.js';
import { beginUsage, recordStreamUsage, finishUsage, usageStats, summarizeError, ledgerFile } from '../src/usage.js';
import { normalizePricing, calculateCostUsd } from '../src/pricing.js';
import { parsePeriod, readLedger, summarize, rowTotal, displayWidth, fmtTokens, fmtUsd, allocateCells, stackedBar, niceCeil, bucketize, chartTitle, renderColumnChart } from './usage-report.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);
const chunk = (delta, finish_reason = null) => ({ id: 'up', choices: [{ index: 0, delta, finish_reason }] });
const sseText = (payloads) => payloads.map((p) => `data: ${typeof p === 'string' ? p : JSON.stringify(p)}\n\n`).join('');
const sseBody = (payloads) => new Response(sseText(payloads)).body;

/** Anthropic SSE 文本 → 事件对象数组 */
function events(text) {
  return text.split('\n\n').filter((frame) => frame.trim()).map((frame) => JSON.parse(frame.split('\n').find((l) => l.startsWith('data: ')).slice(6)));
}

/** 内容块协议：同一时刻最多一个打开的块，delta 只写给打开的块，流结束时全部关闭 */
function assertBlockProtocol(list) {
  let open = null;
  const blocks = [];
  for (const e of list) {
    if (e.type === 'content_block_start') {
      assert.equal(open, null, `块 ${e.index} 开始时块 ${open} 仍未关闭`);
      open = e.index;
      blocks[e.index] = { type: e.content_block.type, text: '' };
    } else if (e.type === 'content_block_delta') {
      assert.equal(e.index, open, `delta 写给了未打开的块 ${e.index}`);
      blocks[e.index].text += e.delta.thinking ?? e.delta.text ?? e.delta.partial_json ?? '';
    } else if (e.type === 'content_block_stop') {
      assert.equal(e.index, open, `关闭了未打开的块 ${e.index}`);
      open = null;
    }
  }
  assert.equal(open, null, '流结束时仍有未关闭的块');
  return blocks;
}

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server.address().port;
}

test('OpenAI usage 换算成 Anthropic 语义：缓存命中从输入里拆出', () => {
  assert.deepEqual(anthropicUsageFromOpenAI({ prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 80 } }), { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 80 });
  assert.deepEqual(anthropicUsageFromOpenAI({ prompt_tokens: 50, completion_tokens: 1, prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 20 }), { input_tokens: 20, output_tokens: 1, cache_read_input_tokens: 30 });
  assert.deepEqual(anthropicUsageFromOpenAI({ prompt_tokens: 5, completion_tokens: 7 }), { input_tokens: 5, output_tokens: 7 });
  assert.deepEqual(anthropicUsageFromOpenAI(undefined), {});
});

test('模型价格按每百万 token 计算美元费用', () => {
  const pricing = normalizePricing({ opus: { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 } });
  assert.ok(Math.abs(calculateCostUsd({ input: 3, cacheRead: 1000, cacheWrite: 100, output: 50 }, pricing, 'opus') - 0.001712) < 1e-12);
  assert.equal(calculateCostUsd({ input: 1 }, pricing, 'missing'), null);
  assert.equal(fmtUsd(0.001712), '$0.001712');
  assert.throws(() => normalizePricing({ opus: { input: -1, output: 2 } }), /大于等于 0/);
});

test('reasoning 与正文交替输出时，每个块都完整开关', async () => {
  const usages = [];
  const stream = openAIToAnthropicStream(sseBody([
    chunk({ content: '先说结论' }),
    chunk({ reasoning_content: '再想想' }),
    chunk({ content: '，补充说明' }),
    chunk({}, 'stop'),
    { id: 'up', choices: [], usage: { prompt_tokens: 100, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 80 } } },
    '[DONE]',
  ]), 'alias', { onUsage: (u) => usages.push(u) });
  const list = events(await new Response(stream).text());
  const blocks = assertBlockProtocol(list);
  assert.deepEqual(blocks.map((b) => [b.type, b.text]), [['text', '先说结论'], ['thinking', '再想想'], ['text', '，补充说明']]);
  const final = list.find((e) => e.type === 'message_delta');
  assert.deepEqual(final.usage, { input_tokens: 20, output_tokens: 9, cache_read_input_tokens: 80 });
  assert.deepEqual(usages.at(-1), final.usage);
  assert.equal(list.at(-1).type, 'message_stop');
});

test('思考后直接调用工具时先关闭思考块', async () => {
  const list = events(await new Response(openAIToAnthropicStream(sseBody([
    chunk({ reasoning_content: '需要查天气' }),
    chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'weather', arguments: '{"city":"X"}' } }] }, 'tool_calls'),
    '[DONE]',
  ]), 'alias')).text());
  assert.deepEqual(assertBlockProtocol(list).map((b) => b.type), ['thinking', 'tool_use']);
});

test('非流式：reasoning 字段与缓存命中都能换算，SSE 聚合保留缓存字段', async () => {
  const out = toAnthropicResponse({ id: 'x', choices: [{ message: { reasoning: '想法', content: '答案' }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 2, prompt_cache_hit_tokens: 30 } }, 'm');
  assert.deepEqual(out.content.map((b) => b.type), ['thinking', 'text']);
  assert.deepEqual(out.usage, { input_tokens: 20, output_tokens: 2, cache_read_input_tokens: 30 });
  const merged = await parseCompletion(new Response(sseText([
    chunk({ content: 'ok' }, 'stop'),
    { id: 'up', choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 6 } } },
    '[DONE]',
  ]), { headers: { 'content-type': 'text/event-stream' } }));
  assert.deepEqual(toAnthropicResponse(merged, 'm').usage, { input_tokens: 4, output_tokens: 1, cache_read_input_tokens: 6 });
});

test('发往 Claude 系列时去掉无签名的 thinking，其余原样保留', () => {
  const signed = { role: 'assistant', content: [{ type: 'thinking', thinking: 'a', signature: 'sig' }, { type: 'redacted_thinking', data: 'x' }, { type: 'text', text: 'ok' }] };
  const body = { model: 'x', messages: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'gpt 的推理', signature: '' }, { type: 'text', text: '回答' }] },
    { role: 'user', content: 'next' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '只有推理' }] },
    { role: 'user', content: 'again' },
    signed,
  ] };
  const out = adaptBodyForModelSeries(body, 'claude-opus-5-5');
  assert.deepEqual(out.messages.map((m) => m.role), ['user', 'assistant', 'user', 'user', 'assistant']);
  assert.deepEqual(out.messages[1].content, [{ type: 'text', text: '回答' }]);
  assert.equal(out.messages[4], signed);
  assert.equal(body.messages[1].content.length, 2, '不能改动原请求体');
  assert.equal(adaptBodyForModelSeries(body, 'gpt-6-sol'), body, '其他系列原样返回');
  const clean = { messages: [body.messages[0], signed] };
  assert.equal(adaptBodyForModelSeries(clean, 'claude-opus-5-5'), clean, '没有要改的内容时返回同一个对象');
  assert.equal(modelSeries('anthropic/claude-sonnet-5'), 'claude');
  assert.equal(modelSeries('us.anthropic.claude-opus-5-5'), 'claude');
  assert.equal(modelSeries('gemini-3.8-flash-high'), 'gemini');
  assert.equal(modelSeries('deepseek-v4.1-flash-0910'), null);
});

test('记账：合并流式 usage、区分取消与失败、写入账本', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gw-usage-'));
  const previous = process.env.GATEWAY_USAGE_DIR;
  process.env.GATEWAY_USAGE_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.GATEWAY_USAGE_DIR;
    else process.env.GATEWAY_USAGE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const before = usageStats().totals;

  const pricing = normalizePricing({ 'claude-opus-5-5': { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 } });
  const ok = beginUsage({ requestId: 'gw_ok', route: 'opus', provider: 'relay', model: 'claude-opus-5-5', pricing, estimatedInputTokens: 1200 });
  recordStreamUsage(ok, { input_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 1 });
  assert.equal(usageStats().inflight.find((r) => r.requestId === 'gw_ok').contextTokens, 1103);
  recordStreamUsage(ok, { output_tokens: 50, input_tokens: null });
  const done = finishUsage(ok, { status: 200 });
  assert.equal(finishUsage(ok, { status: 500 }), done, '重复结束返回第一次的结果');
  assert.deepEqual([done.inputTokens, done.cacheWriteTokens, done.cacheReadTokens, done.outputTokens, done.usageSource], [3, 100, 1000, 50, 'reported']);
  assert.ok(Math.abs(done.costUsd - 0.001712) < 1e-12);

  const html = '<!DOCTYPE html>\n<html>\n<head>\n<title>190515.xyz | 502: Bad gateway</title>';
  const failed = finishUsage(beginUsage({ requestId: 'gw_bad', route: 'sonnet', provider: 'openai', model: 'gpt-6-sol', estimatedInputTokens: 10 }), { status: 502, error: html });
  assert.equal(failed.usageSource, 'none');
  assert.equal(failed.error, '190515.xyz | 502: Bad gateway');
  finishUsage(beginUsage({ requestId: 'gw_esc', route: 'opus', provider: 'relay', model: 'claude-opus-5-5' }), { status: 499, error: '客户端断开' });

  const after = usageStats();
  assert.equal(after.inflight.length, 0);
  assert.equal(after.totals.requests - before.requests, 3);
  assert.equal(after.totals.successes - before.successes, 1);
  assert.equal(after.totals.errors - before.errors, 1);
  assert.equal(after.totals.cancelled - before.cancelled, 1);
  assert.equal(after.totals.cacheReadTokens - before.cacheReadTokens, 1000);
  const lines = (await readFile(ledgerFile(dir), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.requestId, l.status, l.cacheReadTokens]), [['gw_ok', 200, 1000], ['gw_bad', 502, 0], ['gw_esc', 499, 0]]);
  assert.equal(lines[0].costUsd, done.costUsd);

  assert.equal(summarizeError('{"error":{"message":"渠道暂时不可用","type":"x"}}'), '渠道暂时不可用');
  assert.ok(summarizeError('key sk-abcdefghijklmnopqrst leaked').includes('[已隐藏]'));
});

test('报表：时间范围、跨月账本、分组汇总与中文列宽', async (t) => {
  const now = new Date(2026, 8, 25, 10, 0, 0);
  const today = parsePeriod('today', now);
  assert.equal(today.since, new Date(2026, 8, 25).getTime());
  assert.equal(parsePeriod('12h', now).since, now.getTime() - 12 * 3_600_000);
  assert.equal(parsePeriod('7d', now).since, now.getTime() - 7 * 86_400_000);
  assert.equal(parsePeriod('all', now).since, 0);
  for (const bad of ['0d', 'week', '-1d']) assert.equal(parsePeriod(bad, now), null);

  const dir = await mkdtemp(join(tmpdir(), 'gw-report-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const item = (time, extra = {}) => JSON.stringify({
    time: time.toISOString(), route: 'opus', provider: 'relay', model: 'claude-opus-5-5', status: 200, durationMs: 1000,
    usageSource: 'reported', inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, ...extra,
  });
  const failed = { route: 'sonnet', provider: 'openai', model: 'gpt-6-sol', status: 502, usageSource: 'none', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  await writeFile(join(dir, 'usage-2026-08.jsonl'), `${item(new Date(2026, 7, 31, 23, 0))}\n`);
  await writeFile(join(dir, 'usage-2026-09.jsonl'), `${item(new Date(2026, 8, 24, 9, 0))}\n${item(new Date(2026, 8, 25, 9, 0), failed)}\n{broken\n`);
  await writeFile(join(dir, 'notes.txt'), 'ignored');
  assert.equal(readLedger(dir, 0).length, 3);
  assert.equal(readLedger(dir, today.since).length, 1);
  assert.equal(readLedger(dir, new Date(2026, 8, 1).getTime()).length, 2);
  assert.deepEqual(readLedger(join(dir, 'missing'), 0), []);

  const { total, rows } = summarize(readLedger(dir, 0), 'model');
  assert.deepEqual([total.requests, total.errors, total.unreported, rowTotal(total)], [3, 1, 1, 20]);
  assert.deepEqual(rows.map(([name]) => name), ['relay · claude-opus-5-5', 'openai · gpt-6-sol']);
  assert.deepEqual(summarize(readLedger(dir, 0), 'route').rows.map(([name]) => name), ['opus', 'sonnet']);

  assert.equal(displayWidth('请求'), 4);
  assert.equal(displayWidth('\u001b[31m失败\u001b[0m 3'), 6);
  assert.deepEqual([950, 1234, 12345, 123456, 999_999, 4_560_000].map(fmtTokens), ['950', '1.23k', '12.3k', '123k', '1.00M', '4.56M']);
});

test('图形：堆叠条按数值分格，柱状图按时间分桶、刻度取整', () => {
  // 最大余数法：总格数不变；格子够分时每个非零段至少 1 格
  assert.deepEqual(allocateCells([990, 5, 3, 2], 10), [7, 1, 1, 1]);
  assert.deepEqual(allocateCells([50, 50, 0, 0], 3), [2, 1, 0, 0]);
  assert.deepEqual(allocateCells([1, 1, 1, 1], 2), [1, 1, 0, 0]);
  assert.deepEqual(allocateCells([0, 0, 0, 0], 5), [0, 0, 0, 0]);
  for (const [values, cells] of [[[3, 7, 11, 13], 17], [[1e6, 1, 1, 1], 40], [[5, 0, 0, 5], 1]]) {
    assert.equal(allocateCells(values, cells).reduce((a, b) => a + b, 0), cells);
  }
  assert.equal(stackedBar([990, 5, 3, 2], 10, { color: false }), '███████▓▒░');
  assert.deepEqual([0, 7, 10, 11, 180, 240, 999, 1001, 3e5, 7.2e6].map(niceCeil), [1, 10, 10, 20, 200, 250, 1000, 2000, 5e5, 1e7]);

  const at = (day, hour, minute = 0) => new Date(2026, 8, day, hour, minute).getTime();
  const item = (time, tokens) => ({ time: new Date(time).toISOString(), inputTokens: tokens, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
  const today = bucketize([item(at(25, 1, 10), 5), item(at(25, 1, 50), 7), item(at(25, 3), 1)], at(25, 0), at(25, 3, 30));
  assert.deepEqual(today.map((b) => [new Date(b.start).getHours(), b.value, b.requests]), [[0, 0, 0], [1, 12, 2], [2, 0, 0], [3, 1, 1]]);
  assert.equal(chartTitle(today), '每小时 token 合计');
  // `48h` 出图时 now 会比解析参数时晚一点，仍按小时；49 个小时并成 2 小时一桶，起点对齐偶数整点
  const twoDays = bucketize([item(at(23, 5, 30), 1)], at(23, 5, 30), at(25, 5, 30) + 5, 36);
  assert.equal(chartTitle(twoDays), '每 2 小时 token 合计');
  assert.ok(twoDays.every((b) => new Date(b.start).getHours() % 2 === 0));
  const week = bucketize([item(at(19, 12), 3), item(at(25, 1), 4)], at(18, 5), at(25, 5));
  assert.deepEqual([week.length, week[1].value, week.at(-1).value, chartTitle(week)], [8, 3, 4, '每天 token 合计']);
  assert.deepEqual(bucketize([], 0, at(25, 5)), []);

  const lines = renderColumnChart(today, { width: 40, height: 4, color: false });
  assert.deepEqual(lines, [
    '  20 ┤',
    '     │    ▃▃▃',
    '  10 ┤    ███',
    '     │    ███     ▂▂▂',
    `   0 └${'─'.repeat(16)}`,
    '      00  01  02  03',
  ]);
  assert.deepEqual(renderColumnChart([{ ...today[0] }], { color: false }), [], '全是 0 时不画图');
});

test('端到端：经网关的请求写入账本，/v1/usage 与 gw.js tokens 都能看到', async (t) => {
  let observed;
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => raw += c);
    req.on('end', () => {
      const body = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (req.url === '/v1/messages') {
        observed = body;
        const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        send('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, cache_creation_input_tokens: 200, cache_read_input_tokens: 3000, output_tokens: 1 } } });
        send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } });
        send('content_block_stop', { type: 'content_block_stop', index: 0 });
        send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 42 } });
        send('message_stop', { type: 'message_stop' });
      } else {
        res.write(sseText([
          chunk({ reasoning_content: '想一想' }),
          chunk({ content: '答案' }, 'stop'),
          { id: 'up', choices: [], usage: { prompt_tokens: 900, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 800 } } },
          '[DONE]',
        ]));
      }
      res.end();
    });
  });
  const upPort = await listen(upstream);
  const dir = await mkdtemp(join(tmpdir(), 'gw-usage-e2e-'));
  const config = join(dir, 'providers.json');
  await writeFile(config, JSON.stringify({
    clientToken: 'usage-client',
    providers: [
      { name: 'anth', apiType: 'anthropic', apiKey: 'fake-anthropic-key', baseUrl: `http://127.0.0.1:${upPort}` },
      { name: 'oai', apiType: 'openai', apiKey: 'fake-openai-key', baseUrl: `http://127.0.0.1:${upPort}` },
    ],
    routes: { opus: { provider: 'anth', model: 'claude-opus-5-5' }, sol: { provider: 'oai', model: 'gpt-6-sol' } },
  }));
  const reservation = http.createServer();
  const port = await listen(reservation);
  await new Promise((r) => reservation.close(r));
  const env = { ...process.env, GATEWAY_CONFIG: config, GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: String(port), GATEWAY_USAGE_DIR: join(dir, 'ledger') };
  const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let logs = '';
  child.stdout.on('data', (c) => logs += c);
  child.stderr.on('data', (c) => logs += c);
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let n = 0; n < 100 && !ready; n++) {
    try { ready = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(200) })).ok; } catch { await new Promise((r) => setTimeout(r, 30)); }
    if (child.exitCode !== null) break;
  }
  assert.ok(ready, logs);
  const post = (body) => fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer usage-client', 'content-type': 'application/json' },
    body: JSON.stringify({ stream: true, max_tokens: 64, ...body }),
  });

  const sol = events(await (await post({ model: 'sol', messages: [{ role: 'user', content: 'hi' }] })).text());
  assert.deepEqual(assertBlockProtocol(sol).map((b) => b.type), ['thinking', 'text']);
  assert.deepEqual(sol.find((e) => e.type === 'message_delta').usage, { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 800 });

  const opus = await post({ model: 'opus', messages: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '想一想', signature: '' }, { type: 'text', text: '答案' }] },
    { role: 'user', content: '继续' },
  ] });
  assert.ok((await opus.text()).includes('message_stop'));
  assert.deepEqual(observed.messages[1].content, [{ type: 'text', text: '答案' }], 'Claude 上游不应收到无签名的 thinking');

  const stats = await (await fetch(`${base}/v1/usage`, { headers: { authorization: 'Bearer usage-client' } })).json();
  assert.equal(stats.inflight.length, 0);
  assert.equal(stats.totals.cacheReadTokens, 3800);
  assert.equal(stats.models['claude-opus-5-5'].reportedOutputTokens, 42);
  assert.equal(stats.models['gpt-6-sol'].reportedInputTokens, 100);

  const ledger = (await readFile(ledgerFile(join(dir, 'ledger')), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(
    ledger.map((l) => [l.route, l.inputTokens, l.cacheReadTokens, l.cacheWriteTokens, l.outputTokens]),
    [['sol', 100, 800, 0, 30], ['opus', 5, 3000, 200, 42]],
  );

  // 这个环境可能继承了 FORCE_COLOR（Claude Code 的 Bash 工具就设了 3），显式关掉颜色，按方块断言
  const { stdout } = await exec(process.execPath, ['scripts/gw.js', 'tokens', 'all'], { cwd: root, env: { ...env, FORCE_COLOR: '0' }, timeout: 15000, windowsHide: true });
  assert.match(stdout, /anth · claude-opus-5-5 +█+▓?▒?░?/, stdout);
  assert.match(stdout, /oai · gpt-6-sol/);
  assert.match(stdout, /合计 4\.18k tokens/, stdout);
  assert.match(stdout, /^ {2}█{10,}/m, '总量构成条');
  assert.match(stdout, /██ 缓存读 +3\.80k/, stdout);
  assert.match(stdout, /每小时 token 合计/);
  assert.match(stdout, /在途 0/, stdout);
  assert.ok(!stdout.includes('\u001b['), '关掉颜色后不应有颜色码');
});
