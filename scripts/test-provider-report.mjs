import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizePricing } from '../src/pricing.js';
import {
  parseArgs,
  summarize,
  printUsageReport,
} from './usage-report.js';

async function captureConsole(fn) {
  const lines = [];
  const origLog = console.log;
  console.log = (...args) => {
    lines.push(args.join(' '));
  };
  try {
    await fn();
    return lines.join('\n');
  } finally {
    console.log = origLog;
  }
}

test('parseArgs: --provider 参数解析、缺失参数与未知选项防御', () => {
  // 正常解析 --provider
  const parsed = parseArgs(['today', '--provider', 'anthropic', '--by', 'model', '-n', '5', '--table']);
  assert.equal(parsed.provider, 'anthropic');
  assert.equal(parsed.period, 'today');
  assert.equal(parsed.by, 'model');
  assert.equal(parsed.recent, 5);
  assert.equal(parsed.table, true);
  assert.equal(parsed.error, undefined);

  // 缺失 provider 名称
  const missingVal = parseArgs(['--provider']);
  assert.ok(missingVal.error, '缺失 --provider 参数值时应返回错误');

  // 未知选项防御
  const unknownFlag = parseArgs(['--unknown-flag']);
  assert.ok(unknownFlag.error, '未知 flag 应报错');
  assert.ok(parseArgs(['--provider', '--table']).error);
  assert.ok(parseArgs(['--by']).error);
  assert.ok(parseArgs(['all', 'today']).error);
});

test('summarize: 全局 pricing 计费与权威 costUsd 保持', () => {
  const pricing = normalizePricing({
    'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 3.75 },
  });

  const items = [
    // 遗留记录：无 costUsd，使用 global pricing 计算
    {
      time: '2026-09-26T10:00:00.000Z',
      route: 'gpt',
      provider: 'openai',
      model: 'gpt-4o',
      status: 200,
      durationMs: 500,
      usageSource: 'reported',
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    // 已记录 costUsd（权威值）
    {
      time: '2026-09-26T10:05:00.000Z',
      route: 'gpt',
      provider: 'openai',
      model: 'gpt-4o',
      status: 200,
      durationMs: 600,
      usageSource: 'reported',
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.1234,
    },
    // 未上报 usageSource: 'none'
    {
      time: '2026-09-26T10:10:00.000Z',
      route: 'gpt',
      provider: 'openai',
      model: 'gpt-4o',
      status: 502,
      durationMs: 200,
      usageSource: 'none',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  ];

  const { total, rows } = summarize(items, 'model', pricing);
  assert.equal(total.requests, 3);
  assert.equal(total.unreported, 1);
  // 第 1 条费用: 1000 * 2.5 / 1e6 + 500 * 10 / 1e6 = 0.0025 + 0.005 = 0.0075
  // 第 2 条权威费用: 0.1234
  // 总额应约为 0.1309
  assert.ok(Math.abs(total.costUsd - 0.1309) < 1e-6);
  assert.equal(rows.length, 1);
  assert.equal(rows[0][0], 'openai · gpt-4o');
  const unpriced = summarize([{ ...items[0], costUsd: null }], 'provider', pricing);
  assert.equal(unpriced.total.pricedRequests, 0);
  assert.equal(unpriced.total.unpricedRequests, 1);
});

test('summarize retains sub-micro dollar amounts until after aggregation', () => {
  const pricing = normalizePricing({ tiny: { input: 0.4, output: 0 } });
  const item = {
    time: '2026-09-26T10:00:00.000Z', route: 'tiny', provider: 'sample', model: 'tiny',
    status: 200, durationMs: 10, usageSource: 'reported',
    inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  };
  const { total, rows } = summarize([item, item], 'provider', pricing);
  assert.ok(Math.abs(total.costUsd - 0.0000008) < 1e-15);
  assert.ok(Math.abs(rows[0][1].costUsd - 0.0000008) < 1e-15);
  assert.equal(total.pricedRequests, 2);
});

test('printUsageReport: 站点消耗 (Provider Overview) 与 0 用量站点展示', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gw-provider-report-'));
  const prevEnv = process.env.GATEWAY_USAGE_DIR;
  process.env.GATEWAY_USAGE_DIR = dir;
  t.after(async () => {
    if (prevEnv === undefined) delete process.env.GATEWAY_USAGE_DIR;
    else process.env.GATEWAY_USAGE_DIR = prevEnv;
    await rm(dir, { recursive: true, force: true });
  });

  const now = new Date();
  const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const ledgerPath = join(dir, `usage-${monthStr}.jsonl`);

  const ledgerEntries = [
    {
      time: now.toISOString(),
      requestId: 'req_1',
      route: 'opus',
      provider: 'active_p1',
      model: 'claude-3-opus',
      status: 200,
      durationMs: 1200,
      usageSource: 'reported',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 20,
      costUsd: 0.05,
    },
    {
      time: now.toISOString(),
      requestId: 'req_2',
      route: 'legacy_route',
      provider: 'removed_historical_p',
      model: 'old-model',
      status: 200,
      durationMs: 800,
      usageSource: 'none',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: null,
    },
  ];

  await writeFile(ledgerPath, ledgerEntries.map((e) => JSON.stringify(e)).join('\n') + '\n');

  // 配置的 providers Map（包含 active_p1 以及 0 请求的 zero_req_p）
  const configuredProviders = new Map([
    ['active_p1', { name: 'active_p1' }],
    ['zero_req_p', { name: 'zero_req_p' }],
  ]);

  const pricing = normalizePricing({});

  // 1. 无过滤：应包含 active_p1, removed_historical_p 以及 0 请求的 zero_req_p
  {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => ({
      ok: true,
      json: async () => url.endsWith('/health') ? { pid: 42, uptimeSec: 60 } : {
        providers: { active_p1: {}, live_only: {} },
        inflight: [
          { requestId: 'active_request', provider: 'active_p1', route: 'opus', elapsedMs: 1, estimatedInputTokens: 10 },
          { requestId: 'other_request', provider: 'live_only', route: 'other_route', elapsedMs: 1, estimatedInputTokens: 10 },
        ],
      },
    });
    t.after(() => {
      globalThis.fetch = origFetch;
    });

    const origLog = console.log;
    const lines = [];
    console.log = (...args) => lines.push(args.join(' '));
    try {
      await printUsageReport({
        args: ['today'],
        base: 'http://127.0.0.1:9999',
        token: 'test',
        pricing,
        providers: configuredProviders,
      });
    } finally {
      console.log = origLog;
    }

    const output = lines.join('\n');
    assert.ok(output.includes('站点消耗'), '必须包含【站点消耗】概览标题');
    assert.ok(output.includes('Tokens'), '概览表头必须包含 Tokens');
    assert.ok(output.includes('费用 (USD)'), '概览表头必须包含 费用 (USD)');
    assert.ok(output.includes('active_p1'), '概览包含活跃站点');
    assert.ok(output.includes('zero_req_p'), '概览包含已配置但 0 用量的站点');
    assert.ok(output.includes('removed_historical_p'), '概览包含历史已移除的站点');
    assert.ok(output.includes('$0.00'), '0 用量站点显示 $0.00');
  }

  // 2. --provider active_p1 过滤
  {
    const origLog = console.log;
    const lines = [];
    console.log = (...args) => lines.push(args.join(' '));
    try {
      await printUsageReport({
        args: ['today', '--provider', 'active_p1'],
        base: 'http://127.0.0.1:9999',
        token: 'test',
        pricing,
        providers: configuredProviders,
      });
    } finally {
      console.log = origLog;
    }

    const output = lines.join('\n');
    assert.ok(output.includes('active_p1'));
    assert.ok(!output.includes('removed_historical_p'), '过滤后不应显示其他 provider');
    assert.ok(!output.includes('other_request'));
    assert.ok(!output.includes('zero_req_p'));
    assert.ok(output.includes('active_request'));
    assert.match(output, /在途 1/);
    assert.match(output, /合计 180 tokens/);
  }

  const liveOnly = await captureConsole(() => printUsageReport({
    args: ['all', '--provider', 'live_only'], base: 'http://127.0.0.1:9999', token: 'test', pricing, providers: configuredProviders,
  }));
  assert.match(liveOnly, /other_request/);
  assert.ok(!liveOnly.includes('active_request'));
  assert.match(liveOnly, /live_only\s+0\s+0\s+\$0\.00/);

  // 3. 未知 provider 过滤报错
  {
    const origLog = console.log;
    const lines = [];
    console.log = (...args) => lines.push(args.join(' '));
    const origCode = process.exitCode;
    try {
      await printUsageReport({
        args: ['today', '--provider', 'non_existent_provider'],
        base: 'http://127.0.0.1:9999',
        token: 'test',
        pricing,
        providers: configuredProviders,
      });
      assert.equal(process.exitCode, 1, '未知 provider 应将 exitCode 设为 1');
    } finally {
      console.log = origLog;
      process.exitCode = origCode;
    }

    const output = lines.join('\n');
    assert.ok(/未知|不存在|valid|known/i.test(output), '应输出未知 provider 的错误提示');
  }
});
