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
import { anthropicUsageFromOpenAI, mergeOpenAIUsage, toAnthropicResponse, parseCompletion } from '../src/providers/openai.js';
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

test('OpenAI usage 换算成 Anthropic 语义：缓存读取与写入从总输入拆出', () => {
  assert.deepEqual(anthropicUsageFromOpenAI({ prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 80 } }), { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 80 });
  assert.deepEqual(anthropicUsageFromOpenAI({ prompt_tokens: 50, completion_tokens: 1, prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 20 }), { input_tokens: 20, output_tokens: 1, cache_read_input_tokens: 30 });
  assert.deepEqual(anthropicUsageFromOpenAI({ prompt_tokens: 52420, completion_tokens: 13, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 52352 } }), { input_tokens: 68, output_tokens: 13, cache_read_input_tokens: 0, cache_creation_input_tokens: 52352 });
  assert.deepEqual(anthropicUsageFromOpenAI({ input_tokens: 100, output_tokens: 3, input_tokens_details: { cached_tokens: 30, cache_write_tokens: 60 } }), { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 30, cache_creation_input_tokens: 60 });
  assert.deepEqual(anthropicUsageFromOpenAI({ input_tokens: 100, output_tokens: 3, input_tokens_details: { cached_tokens: 30, cache_creation_tokens: 60 } }), { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 30, cache_creation_input_tokens: 60 });
  assert.deepEqual(anthropicUsageFromOpenAI({ input_tokens: 100, output_tokens: 3, cached_tokens: 30, cache_write_tokens: 60 }), { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 30, cache_creation_input_tokens: 60 });
  assert.deepEqual(anthropicUsageFromOpenAI({ prompt_tokens: 100, completion_tokens: 3, prompt_tokens_details: { cache_write_tokens: 60, cache_creation_tokens: 60 }, cache_creation_input_tokens: 60 }), { input_tokens: 40, output_tokens: 3, cache_creation_input_tokens: 60 });
  assert.deepEqual(anthropicUsageFromOpenAI({ input_tokens: 100, output_tokens: 3, cache_write_tokens: 60 }), { input_tokens: 40, output_tokens: 3, cache_creation_input_tokens: 60 });
  assert.deepEqual(anthropicUsageFromOpenAI({ input_tokens: 10, output_tokens: 1, input_tokens_details: { cached_tokens: 8, cache_write_tokens: 99 } }), { input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 8, cache_creation_input_tokens: 2 });
  assert.deepEqual(anthropicUsageFromOpenAI({ prompt_tokens: 52420, completion_tokens: 13, prompt_cache_miss_tokens: 52352 }), { input_tokens: 52420, output_tokens: 13 });
  assert.deepEqual(anthropicUsageFromOpenAI({ prompt_tokens: 5, completion_tokens: 7 }), { input_tokens: 5, output_tokens: 7 });
  assert.deepEqual(anthropicUsageFromOpenAI(undefined), {});
});

test('OpenAI usage 缓存别名：零与非法值不遮蔽后续正值，非零取优先级高者且不累加', () => {
  // 高位别名上报 0 时，低位的正值仍然生效（零遮蔽）
  assert.deepEqual(anthropicUsageFromOpenAI({ prompt_tokens: 100, completion_tokens: 1, cached_tokens: 0, cache_read_tokens: 40 }), { input_tokens: 60, output_tokens: 1, cache_read_input_tokens: 40 });
  // 非法值（负数 / 小数 / 非数字）同样不遮蔽后续正值
  assert.deepEqual(anthropicUsageFromOpenAI({ prompt_tokens: 100, completion_tokens: 1, cached_tokens: -5, cache_read_tokens: 40 }), { input_tokens: 60, output_tokens: 1, cache_read_input_tokens: 40 });
  assert.deepEqual(anthropicUsageFromOpenAI({ prompt_tokens: 100, completion_tokens: 1, input_tokens_details: { cached_tokens: 1.5 }, cache_read_input_tokens: 40 }), { input_tokens: 60, output_tokens: 1, cache_read_input_tokens: 40 });
  assert.deepEqual(anthropicUsageFromOpenAI({ prompt_tokens: 100, completion_tokens: 1, input_tokens_details: { cache_write_tokens: 'x' }, cache_write_tokens: 25 }), { input_tokens: 75, output_tokens: 1, cache_creation_input_tokens: 25 });
  // 多个非零别名同时存在：只取优先级最高者，不累加
  assert.deepEqual(anthropicUsageFromOpenAI({ prompt_tokens: 100, completion_tokens: 1, cached_tokens: 30, cache_read_tokens: 20 }), { input_tokens: 70, output_tokens: 1, cache_read_input_tokens: 30 });
  assert.deepEqual(anthropicUsageFromOpenAI({ prompt_tokens: 100, completion_tokens: 1, input_tokens_details: { cached_tokens: 30 }, prompt_tokens_details: { cached_tokens: 20 } }), { input_tokens: 70, output_tokens: 1, cache_read_input_tokens: 30 });
  // 全部别名都是 0：视为明确上报零，输出零缓存字段；完全没有缓存字段时不输出
  assert.deepEqual(anthropicUsageFromOpenAI({ prompt_tokens: 100, completion_tokens: 1, cached_tokens: 0 }), { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 0 });
  assert.deepEqual(anthropicUsageFromOpenAI({ prompt_tokens: 100, completion_tokens: 1 }), { input_tokens: 100, output_tokens: 1 });
});

test('OpenAI usage 只有输出或只有缓存时不编造总量', () => {
  // 只有输出：不凭空生成 input_tokens = 0
  assert.deepEqual(anthropicUsageFromOpenAI({ completion_tokens: 5 }), { output_tokens: 5 });
  assert.deepEqual(anthropicUsageFromOpenAI({ output_tokens: 0 }), { output_tokens: 0 });
  // 只有缓存：保留合法缓存读写，但不编造输入 / 输出总量
  assert.deepEqual(anthropicUsageFromOpenAI({ cache_read_tokens: 30 }), { cache_read_input_tokens: 30 });
  assert.deepEqual(anthropicUsageFromOpenAI({ cached_tokens: 0 }), { cache_read_input_tokens: 0 });
  for (const cached_tokens of [false, true, '', ' ', [], {}]) {
    assert.deepEqual(anthropicUsageFromOpenAI({ cached_tokens }), {});
  }
  assert.deepEqual(anthropicUsageFromOpenAI({ prompt_cache_miss_tokens: 20 }), {});
  assert.deepEqual(anthropicUsageFromOpenAI({}), {});
});

test('OpenAI 分段 usage 合并：只覆盖非空字段，details 逐字段浅合并，显式 0 覆盖', () => {
  // details 分段嵌套：后到的分段不丢先到的缓存字段
  assert.deepEqual(mergeOpenAIUsage(
    { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 } },
    { completion_tokens: 5, prompt_tokens_details: { cache_write_tokens: 10 } },
  ), { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 10 } });
  // null / undefined 不覆盖已有值
  assert.deepEqual(mergeOpenAIUsage(
    { input_tokens: 20, cache_read_input_tokens: 5 },
    { input_tokens: null, cache_read_input_tokens: undefined, output_tokens: 3 },
  ), { input_tokens: 20, cache_read_input_tokens: 5, output_tokens: 3 });
  // 显式 0 覆盖旧正值，且不修改入参
  const prev = { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 } };
  assert.deepEqual(mergeOpenAIUsage(prev, { prompt_tokens_details: { cached_tokens: 0 }, completion_tokens: 0 }), { prompt_tokens: 100, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } });
  assert.deepEqual(prev, { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 } });
  assert.deepEqual(mergeOpenAIUsage(undefined, { input_tokens_details: { cached_tokens: 3 } }), { input_tokens_details: { cached_tokens: 3 } });
});

test('流式 usage 分段：只带输出的片段不覆盖输入，显式零缓存覆盖旧正值', async () => {
  const usages = [];
  const list = events(await new Response(openAIToAnthropicStream(sseBody([
    chunk({ content: 'ok' }),
    chunk({}, 'stop'),
    { id: 'up', choices: [], usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 } } },
    { id: 'up', choices: [], usage: { completion_tokens: 9 } },
    '[DONE]',
  ]), 'alias', { onUsage: (u) => usages.push(u) })).text());
  const final = list.find((e) => e.type === 'message_delta');
  assert.deepEqual(final.usage, { input_tokens: 20, output_tokens: 9, cache_read_input_tokens: 80 });
  assert.deepEqual(usages.at(-1), final.usage);

  const override = events(await new Response(openAIToAnthropicStream(sseBody([
    chunk({ content: 'ok' }),
    chunk({}, 'stop'),
    { id: 'up', choices: [], usage: { prompt_tokens: 100, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 80 } } },
    { id: 'up', choices: [], usage: { completion_tokens: 9, prompt_tokens_details: { cached_tokens: 0 } } },
    '[DONE]',
  ]), 'alias')).text());
  assert.deepEqual(override.find((e) => e.type === 'message_delta').usage, { input_tokens: 100, output_tokens: 9, cache_read_input_tokens: 0 });
});

test('嵌套 usage 分段不会把账本 80% 命中率稀释为 44.4%', async (t) => {
  const previous = process.env.GATEWAY_USAGE_DIR;
  process.env.GATEWAY_USAGE_DIR = 'off';
  t.after(() => {
    if (previous === undefined) delete process.env.GATEWAY_USAGE_DIR;
    else process.env.GATEWAY_USAGE_DIR = previous;
  });
  const entry = beginUsage({ requestId: 'nested-cache-regression', route: 'fixture', provider: 'fixture', model: 'fixture' });
  const payloads = [
    chunk({ content: 'ok' }),
    chunk({}, 'stop'),
    { choices: [], usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 } } },
    { choices: [], usage: { prompt_tokens: null, completion_tokens: 2, prompt_tokens_details: { cached_tokens: null, reasoning_tokens: 0 } } },
    '[DONE]',
  ];
  await new Response(openAIToAnthropicStream(sseBody(payloads), 'fixture', { onUsage: value => recordStreamUsage(entry, value) })).text();
  const result = finishUsage(entry, { status: 200 });
  assert.equal(result.inputTokens, 20);
  assert.equal(result.cacheReadTokens, 80);
  assert.equal(result.cacheReadTokens / (result.inputTokens + result.cacheReadTokens), 0.8);
  const merged = await parseCompletion(new Response(sseText(payloads), { headers: { 'content-type': 'text/event-stream' } }));
  assert.deepEqual(anthropicUsageFromOpenAI(merged.usage), { input_tokens: 20, output_tokens: 2, cache_read_input_tokens: 80 });
});

test('模型价格按每百万 token 计算美元费用', () => {
  const pricing = normalizePricing({ opus: { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 } });
  assert.ok(Math.abs(calculateCostUsd({ input: 3, cacheRead: 1000, cacheWrite: 100, output: 50 }, pricing, 'opus') - 0.001712) < 1e-12);
  assert.equal(calculateCostUsd({ input: 1 }, pricing, 'missing'), null);
  assert.equal(fmtUsd(0.001712), '$0.001712');
  assert.equal(fmtUsd(0), '$0.000000');
  assert.equal(fmtUsd(1.25), '$1.250000');
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
  assert.deepEqual([950, 1234, 12345, 123456, 999_999, 4_560_000].map(fmtTokens), ['950', '1.23K', '12.3K', '123K', '1.00M', '4.56M']);
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
    req.on('end', async () => {
      const body = JSON.parse(raw);
      await new Promise((resolve) => setTimeout(resolve, 10));
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
      { name: 'oai', apiType: 'openai', messagesTransport: 'chat-completions', apiKey: 'fake-openai-key', baseUrl: `http://127.0.0.1:${upPort}` },
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
  assert.deepEqual(observed.messages[1].content, [
    { type: 'thinking', thinking: '想一想', signature: '' },
    { type: 'text', text: '答案' },
  ], 'Anthropic 上游应收到原始 thinking 内容');

  const stats = await (await fetch(`${base}/v1/usage`, { headers: { authorization: 'Bearer usage-client' } })).json();
  assert.equal(stats.inflight.length, 0);
  assert.equal(stats.totals.cacheReadTokens, 3800);
  assert.equal(stats.models['claude-opus-5-5'].reportedOutputTokens, 42);
  assert.equal(stats.models['gpt-6-sol'].reportedInputTokens, 100);
  assert.equal(stats.traffic.tokenConsumed, 4177);
  assert.equal(stats.traffic.tps.current, 4177 / 60);
  assert.equal(stats.totals.outputTpsSamples, 2);

  const ledger = (await readFile(ledgerFile(join(dir, 'ledger')), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  for (const row of ledger) {
    assert.ok(row.durationMs > 0);
    assert.equal(row.outputTokensPerSec, row.outputTokens * 1000 / row.durationMs);
    assert.equal(stats.models[row.model].avgOutputTokensPerSec, row.outputTokensPerSec);
  }
  const expectedMean = (ledger[0].outputTokensPerSec + ledger[1].outputTokensPerSec) / 2;
  assert.ok(Math.abs(stats.totals.avgOutputTokensPerSec - expectedMean) <= Number.EPSILON * Math.max(1, expectedMean) * 4);
  assert.deepEqual(
    ledger.map((l) => [l.route, l.inputTokens, l.cacheReadTokens, l.cacheWriteTokens, l.outputTokens]),
    [['sol', 100, 800, 0, 30], ['opus', 5, 3000, 200, 42]],
  );

  // 这个环境可能继承了 FORCE_COLOR（Claude Code 的 Bash 工具就设了 3），显式关掉颜色，按方块断言
  const { stdout } = await exec(process.execPath, ['scripts/gw.js', 'tokens', 'all'], { cwd: root, env: { ...env, FORCE_COLOR: '0' }, timeout: 15000, windowsHide: true });
  assert.match(stdout, /anth · claude-opus-5-5 +█+▓?▒?░?/, stdout);
  assert.match(stdout, /oai · gpt-6-sol/);
  assert.match(stdout, /合计 4\.18K tokens/, stdout);
  assert.match(stdout, /^ {2}█{10,}/m, '总量构成条');
  assert.match(stdout, /██ 缓存读 +3\.80K/, stdout);
  assert.match(stdout, /每小时 token 合计/);
  assert.match(stdout, /在途 0/, stdout);
  assert.ok(!stdout.includes('\u001b['), '关掉颜色后不应有颜色码');
});

test('在途请求：requestStartedAt 稳定 ISO 格式，elapsedMs 单调递增且不倒退', async () => {
  const req = beginUsage({
    requestId: 'gw_inflight_timing',
    route: 'sonnet',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    estimatedInputTokens: 500,
  });

  const stats1 = usageStats();
  const entry1 = stats1.inflight.find((r) => r.requestId === 'gw_inflight_timing');
  assert.ok(entry1, '初次采集能找到在途请求');
  assert.equal(typeof entry1.requestStartedAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(entry1.requestStartedAt)), 'requestStartedAt 应为合法 ISO 时间');
  assert.ok(entry1.elapsedMs >= 0, '初次 elapsedMs 应大于等于 0');

  // 等待一段时间再采集
  await new Promise((resolve) => setTimeout(resolve, 30));

  const stats2 = usageStats();
  const entry2 = stats2.inflight.find((r) => r.requestId === 'gw_inflight_timing');
  assert.equal(entry2.requestStartedAt, entry1.requestStartedAt, '多次采集 requestStartedAt 必须保持稳定一致');
  assert.ok(entry2.elapsedMs >= entry1.elapsedMs, 'elapsedMs 必须随时间递增，不可倒退');

  finishUsage(req, { status: 200 });
  const stats3 = usageStats();
  assert.equal(stats3.inflight.some((r) => r.requestId === 'gw_inflight_timing'), false);
});

test('模型请求生命周期：逐阶段更新（开始->输入/上下文->输出阶段->完成/取消）与在途清除', async () => {
  // 1. 成功请求的生命周期与阶段推进
  const req = beginUsage({
    requestId: 'lifecycle-req-1',
    route: 'sonnet',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    estimatedInputTokens: 300,
  });

  let snap = usageStats();
  let inflightItem = snap.inflight.find((r) => r.requestId === 'lifecycle-req-1');
  assert.ok(inflightItem, '请求开始后进入 inflight 集合');
  assert.equal(inflightItem.estimatedInputTokens, 300);
  assert.equal(inflightItem.contextTokens, undefined, '初始尚未收到 usage 报文时 contextTokens 为空');
  assert.equal(inflightItem.outputTokens, undefined, '初始 outputTokens 为空');

  // 阶段推进：收到 message_start 报文（输入与缓存 token 确定）
  recordStreamUsage(req, { input_tokens: 150, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 });
  snap = usageStats();
  inflightItem = snap.inflight.find((r) => r.requestId === 'lifecycle-req-1');
  assert.equal(inflightItem.contextTokens, 250, '收到输入及缓存后 contextTokens 为 input + cacheRead + cacheWrite');
  assert.equal(inflightItem.outputTokens, undefined, '此时尚未产生输出');

  // 阶段推进：收到 message_delta 报文（输出 token 上报）
  recordStreamUsage(req, { output_tokens: 65 });
  snap = usageStats();
  inflightItem = snap.inflight.find((r) => r.requestId === 'lifecycle-req-1');
  assert.equal(inflightItem.contextTokens, 250);
  assert.equal(inflightItem.outputTokens, 65, '收到 delta 报文后 outputTokens 得到更新');

  // 正常结束 (200 OK)
  const finishRes = finishUsage(req, { status: 200 });
  assert.equal(finishRes.status, 200);
  assert.equal(finishRes.usageSource, 'reported');
  assert.equal(finishRes.inputTokens, 150);
  assert.equal(finishRes.outputTokens, 65);
  assert.equal(finishRes.cacheReadTokens, 80);
  assert.equal(finishRes.cacheWriteTokens, 20);
  assert.equal(usageStats().inflight.some((r) => r.requestId === 'lifecycle-req-1'), false, '请求结束后从 inflight 集合移除');

  // 2. 客户端中断取消请求（499）
  const cancelReq = beginUsage({
    requestId: 'lifecycle-req-cancel',
    route: 'opus',
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    estimatedInputTokens: 120,
  });
  recordStreamUsage(cancelReq, { input_tokens: 100, cache_read_input_tokens: 30 });
  const cancelRes = finishUsage(cancelReq, { status: 499, error: 'Client closed request' });
  assert.equal(cancelRes.status, 499);
  assert.equal(cancelRes.inputTokens, 100);
  assert.equal(cancelRes.cacheReadTokens, 30);
  assert.equal(usageStats().inflight.some((r) => r.requestId === 'lifecycle-req-cancel'), false, '取消后从 inflight 集合移除');
});

test('交换台已结束拓扑：从 finish 精确保留 5 分钟，独立于 recent 且不泄露记账字段', () => {
  const RealDate = globalThis.Date;
  const previousUsageDir = process.env.GATEWAY_USAGE_DIR;
  let now = RealDate.parse('2026-09-28T08:00:00.000Z');
  class Clock extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  globalThis.Date = Clock;
  process.env.GATEWAY_USAGE_DIR = 'off';
  const path = (extra = {}) => ({
    route: 'sticky-route', provider: 'sticky-provider', model: 'sticky-model', clientType: 'codex',
    inputProtocol: 'responses', upstreamProtocol: 'responses', adapter: 'direct', ...extra,
  });
  try {
    const long = beginUsage({ requestId: 'sticky-long', ...path() });
    now += 10 * 60 * 1000;
    const longDone = finishUsage(long, { status: 502, error: 'secret error', usage: { input_tokens: 7 } });
    let retained = usageStats().switchboardRetained.find((item) => item.route === 'sticky-route');
    assert.equal(retained.finishedAt, longDone.time, '长请求从结束时刻而不是开始时刻起算');
    assert.deepEqual(Object.keys(retained).sort(), [
      'adapter', 'clientType', 'finishedAt', 'inputProtocol', 'model', 'provider', 'route', 'upstreamProtocol',
    ]);
    for (const forbidden of ['requestId', 'status', 'error', 'inputTokens', 'outputTokens', 'durationMs', 'usageSource']) {
      assert.equal(Object.hasOwn(retained, forbidden), false, `sticky 元数据不得包含 ${forbidden}`);
    }

    now += 300000;
    assert.ok(usageStats().switchboardRetained.some((item) => item.route === 'sticky-route'), '正好 300000ms 仍保留');
    assert.equal(finishUsage(long, { status: 200 }), longDone, '重复 finish 返回原结果');
    now += 1;
    assert.equal(usageStats().switchboardRetained.some((item) => item.route === 'sticky-route'), false, '300001ms 才过期，重复 finish 不续期');

    now += 1000;
    const renewed = finishUsage(beginUsage({ requestId: 'sticky-renewed', ...path() }), { status: 200 });
    retained = usageStats().switchboardRetained.find((item) => item.route === 'sticky-route');
    assert.equal(retained.finishedAt, renewed.time, '同一路径再次完成会续期到最新 finish');

    const short = finishUsage(beginUsage({ requestId: 'sticky-short', ...path({ route: 'short-route' }) }), { status: 200 });
    assert.ok(usageStats().switchboardRetained.some((item) => item.finishedAt === short.time && item.route === 'short-route'), '未被轮询捕获的短请求也会保留');

    for (let i = 0; i < 201; i++) {
      finishUsage(beginUsage({ requestId: `flush-${i}`, ...path({ route: `flush-route-${i}` }) }), { status: 200 });
    }
    let stats = usageStats();
    assert.equal(stats.recent.some((item) => item.requestId === 'sticky-short'), false, '短请求已被 MAX_RECENT 冲刷');
    assert.ok(stats.switchboardRetained.some((item) => item.route === 'short-route'), 'sticky 缓存不依赖 MAX_RECENT');

    const concurrentA = beginUsage({ requestId: 'concurrent-a', ...path({ route: 'concurrent-a', model: 'model-a' }) });
    const concurrentB = beginUsage({ requestId: 'concurrent-b', ...path({ route: 'concurrent-b', model: 'model-b' }) });
    finishUsage(concurrentA, { status: 200 });
    finishUsage(concurrentB, { status: 200 });
    stats = usageStats();
    assert.ok(stats.switchboardRetained.some((item) => item.route === 'concurrent-a'));
    assert.ok(stats.switchboardRetained.some((item) => item.route === 'concurrent-b'), '并发不同路径独立保留');
  } finally {
    now += 300001;
    usageStats();
    globalThis.Date = RealDate;
    if (previousUsageDir === undefined) delete process.env.GATEWAY_USAGE_DIR;
    else process.env.GATEWAY_USAGE_DIR = previousUsageDir;
  }
});
