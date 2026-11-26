import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addOutputRate, calculateTraffic, emptyOutputRate, outputTokensPerSecond } from '../src/throughput.js';
import { beginUsage, finishUsage, recordStreamUsage, usageStats, ledgerFile } from '../src/usage.js';
import { buildOverview } from '../src/admin/data.js';
import { summarize } from './usage-report.js';

const item = (extra = {}) => ({
  time: '2026-10-05T00:00:00.000Z', provider: 'p', model: 'm', route: 'r',
  status: 200, usageSource: 'reported', durationMs: 1000,
  inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 60,
  ...extra,
});
const start = Date.parse('2026-10-05T00:00:00.000Z');
const at = (ms, extra = {}) => item({ time: new Date(start + ms).toISOString(), ...extra });

test('output TPS uses reported output / total duration, not first-token subtraction', () => {
  assert.equal(outputTokensPerSecond(item({ outputTokens: 100, durationMs: 4000, firstTokenMs: 3000 })), 25);
  for (const durationMs of [undefined, null, 0, -1, NaN, Infinity, '1000']) {
    assert.equal(outputTokensPerSecond(item({ durationMs })), null);
  }
  for (const outputTokens of [undefined, null, 0, -1, NaN, Infinity, '20']) {
    assert.equal(outputTokensPerSecond(item({ outputTokens })), null);
  }
  for (const extra of [{ status: 499 }, { status: 502 }, { error: 'stream failed' }, { usageSource: 'none' }]) {
    assert.equal(outputTokensPerSecond(item(extra)), null);
  }
});

test('output TPS aggregates arithmetic sample means and excludes unavailable values', () => {
  const samples = [item({ outputTokens: 100 }), item({ outputTokens: 100, durationMs: 10000 }), item({ status: 499 }), item({ outputTokens: 0 })];
  const rate = emptyOutputRate();
  for (const sample of samples) addOutputRate(rate, sample);
  assert.deepEqual(rate, { avgOutputTokensPerSec: 55, outputTpsSamples: 2 });
  const summary = summarize(samples, 'provider');
  assert.equal(summary.total.avgOutputTokensPerSec, 55);
  assert.equal(summary.rows[0][1].outputTpsSamples, 2);
  assert.deepEqual(emptyOutputRate(), { avgOutputTokensPerSec: null, outputTpsSamples: 0 });
});

test('traffic TPS counts input/output/cache once, uses wall time and half-open ranges', () => {
  const samples = [at(0), at(59000, { inputTokens: 70 }), at(60000, { inputTokens: 0, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    at(-1), at(120000), at(90000, { usageSource: 'none', estimatedInputTokens: 9000 }), at(10000, { inputTokens: -1, outputTokens: NaN, cacheReadTokens: Infinity, cacheWriteTokens: '500' })];
  const result = calculateTraffic(samples, { since: start, until: start + 120000 });
  assert.equal(result.tokenConsumed, 360);
  assert.equal(result.windowSeconds, 120);
  assert.deepEqual(result.tps, { current: 1, peak: 5, avg: 3 });
  const idle = calculateTraffic(samples.slice(0, 3), { since: start, until: start + 240000 });
  assert.deepEqual(idle.tps, { current: 0, peak: 5, avg: 1.5 });
});

test('short, empty and zero-length windows do not invent output or divide by zero', () => {
  const result = calculateTraffic([at(0)], { since: start, until: start + 30000 });
  assert.deepEqual(result.tps, { current: 2, peak: 2, avg: 4 });
  assert.deepEqual(calculateTraffic([], { since: start, until: start + 60000 }).tps, { current: 0, peak: 0, avg: 0 });
  assert.deepEqual(calculateTraffic([at(0)], { since: start, until: start }).tps, { current: 0, peak: 0, avg: 0 });
});

test('ledger and runtime TPS merge final stream usage, remain idempotent and exclude failures from output means', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gw-tps-ledger-'));
  const previous = process.env.GATEWAY_USAGE_DIR;
  process.env.GATEWAY_USAGE_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.GATEWAY_USAGE_DIR;
    else process.env.GATEWAY_USAGE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  const begin = () => beginUsage({ requestId: 'tps-' + clock, route: 'tps-r', provider: 'tps-p', model: 'tps-m' });
  const first = begin();
  recordStreamUsage(first, { input_tokens: 10, output_tokens: 1 });
  recordStreamUsage(first, { output_tokens: 100 });
  clock = 1000;
  const completed = finishUsage(first, { status: 200 });
  assert.equal(completed.outputTokensPerSec, 100);
  assert.equal(finishUsage(first, { status: 499 }), completed);
  const second = begin();
  clock = 11000;
  assert.equal(finishUsage(second, { status: 200, usage: { output_tokens: 100 } }).outputTokensPerSec, 10);
  const cancelled = begin();
  clock = 12000;
  assert.equal(finishUsage(cancelled, { status: 499, usage: { output_tokens: 50 } }).outputTokensPerSec, null);
  finishUsage(begin(), { status: 200 });
  const stats = usageStats();
  assert.equal(stats.providers['tps-p'].avgOutputTokensPerSec, 55);
  assert.equal(stats.providers['tps-p'].outputTpsSamples, 2);
  assert.equal(stats.models['tps-m'].avgOutputTokensPerSec, 55);
  assert.equal(stats.routes['tps-r'].avgOutputTokensPerSec, 55);
  assert.ok(stats.traffic.tokenConsumed >= 260, 'cancelled reported tokens still contribute to actual consumption');
  assert.equal(stats.traffic.windowSeconds, 60);
  const ledger = (await readFile(ledgerFile(dir), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(ledger.map((row) => row.outputTokensPerSec), [100, 10, null, null]);
});

test('runtime traffic retains the full 60s window independently of the 200-row recent limit', () => {
  const previous = process.env.GATEWAY_USAGE_DIR;
  process.env.GATEWAY_USAGE_DIR = 'off';
  try {
    const before = usageStats().traffic.tokenConsumed;
    for (let i = 0; i < 250; i++) {
      const entry = beginUsage({ requestId: 'burst-' + i, provider: 'burst-p', model: 'burst-m', route: 'burst-r' });
      finishUsage(entry, { status: 200, usage: { input_tokens: 1, output_tokens: 1 } });
    }
    const stats = usageStats();
    assert.equal(stats.recent.length, 200);
    assert.equal(stats.traffic.tokenConsumed - before, 500);
  } finally {
    if (previous === undefined) delete process.env.GATEWAY_USAGE_DIR;
    else process.env.GATEWAY_USAGE_DIR = previous;
  }
});

test('runtime current TPS returns to zero after 60 seconds without erasing lifetime totals', (t) => {
  const before = usageStats();
  const now = Date.now();
  assert.ok(before.traffic.tokenConsumed > 0);
  t.mock.method(Date, 'now', () => now + 61_000);
  const idle = usageStats();
  assert.deepEqual(idle.traffic.tps, { current: 0, peak: 0, avg: 0 });
  assert.equal(idle.totals.reportedOutputTokens, before.totals.reportedOutputTokens);
  assert.equal(idle.recent.length, before.recent.length);
});

test('overview recomputes legacy output TPS and scopes traffic to time and provider filters', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gw-tps-overview-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const samples = [at(0), at(60000, { provider: 'other' }), at(119999, { provider: 'other' }), at(120000)];
  await writeFile(ledgerFile(dir, new Date(start)), samples.map((row) => JSON.stringify(row)).join('\n'));
  const args = { period: 'custom', since: start, until: start + 120000, ledgerDir: dir, getGateway: async () => ({ online: false }) };
  const result = await buildOverview(args);
  assert.equal(result.total.requests, 3, 'the final millisecond is included but until is exclusive');
  assert.equal(result.total.avgOutputTokensPerSec, 20);
  assert.equal(result.total.outputTpsSamples, 3);
  assert.equal(result.recent[0].outputTokensPerSec, 20);
  assert.deepEqual(result.traffic.tps, { current: 4, peak: 4, avg: 3 });
  const filtered = await buildOverview({ ...args, provider: 'p' });
  assert.equal(filtered.total.requests, 1);
  assert.deepEqual(filtered.traffic.tps, { current: 0, peak: 2, avg: 1 });
  const disabled = await buildOverview({ ...args, ledgerDir: null });
  assert.equal(disabled.traffic, null);
  assert.equal(disabled.total.avgOutputTokensPerSec, null);
});
