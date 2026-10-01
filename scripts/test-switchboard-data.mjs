import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOverview, buildSwitchboardLive, configuredSwitchboard, fetchGatewayStatus } from '../src/admin/data.js';

test('switchboard retains exact routes, protocols, per-agent metrics and only inflight activity', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'switchboard-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cfg = {
    providers: new Map([['shared', { apiType: 'openai', messagesTransport: 'responses', models: { alias: 'real' } }], ['idle', { apiType: 'anthropic', models: {} }]]),
    routes: new Map([['original', { provider: 'shared', model: 'alias' }]]), pricing: new Map(),
  };
  const route = { clientType: 'claude-code', route: 'original', model: 'real', provider: 'shared', inputProtocol: 'messages', upstreamProtocol: 'responses', adapter: 'messages-to-responses' };
  const records = [
    { ...route, status: 200, usageSource: 'reported', inputTokens: 30, cacheReadTokens: 60, cacheWriteTokens: 10 },
    { ...route, status: 502 }, { ...route, status: 499 },
    { ...route, route: 'second-alias', status: 200 },
    { ...route, clientType: 'codex', inputProtocol: 'responses', adapter: 'direct', status: 200 },
    { clientType: 'deepseek-harness', provider: 'shared', model: 'real', route: 'original', status: 200 },
  ].map((item) => ({ time: new Date().toISOString(), ...item }));
  const now = new Date();
  const ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  await writeFile(join(dir, 'usage-' + ym + '.jsonl'), records.map((item) => JSON.stringify(item)).join('\n') + '\n');
  let inflight = [route, { ...route, clientType: 'codex', inputProtocol: 'responses', adapter: 'direct' }];
  const getGateway = async () => ({ online: true, activeRequests: inflight.length, stats: { inflight } });
  const overview = await buildOverview({ cfg, ledgerDir: dir, period: 'all', getGateway });
  const row = overview.switchboard.find((item) => item.clientType === 'claude-code' && item.route === 'original');
  assert.equal(row.requests, 3);
  assert.equal(row.live, 1);
  assert.equal(row.successRate, 0.5);
  assert.equal(row.cacheHitRate, 0.6);
  assert.equal(overview.switchboard.find((item) => item.clientType === 'deepseek-harness').inputProtocol, null);
  assert.equal(overview.switchboard.find((item) => item.clientType === 'codex').cacheHitRate, null);
  assert.equal(overview.switchboardActive.length, 2);
  assert.ok(overview.switchboardConfigured.some((item) => item.provider === 'idle'));
  assert.ok(overview.switchboardConfigured.some((item) => item.route === 'original' && item.model === 'real'));
  inflight = [];
  const live = await buildSwitchboardLive({ cfg, getGateway });
  assert.deepEqual(live.switchboardActive, []);
  assert.equal(live.liveUnknown, false);
  const unknown = await buildSwitchboardLive({ cfg, getGateway: async () => ({ online: true }) });
  assert.equal(unknown.liveUnknown, true);
});

test('configured adapter plans include native Responses before any client is active', () => {
  const cfg = { providers: new Map([
    ['responses', { apiType: 'openai', messagesTransport: 'responses', models: {} }],
    ['chat', { apiType: 'openai', messagesTransport: 'chat-completions', models: {} }],
    ['anthropic', { apiType: 'anthropic', models: {} }],
  ]), routes: new Map() };
  const plans = configuredSwitchboard(cfg);
  const adapters = (provider) => plans.filter((item) => item.provider === provider).map((item) => item.inputProtocol + ':' + item.upstreamProtocol + ':' + item.adapter);
  assert.deepEqual(adapters('responses'), ['messages:responses:messages-to-responses', 'responses:responses:direct']);
  assert.deepEqual(adapters('chat'), ['messages:chat-completions:messages-to-chat-completions', 'responses:responses:direct', 'responses:chat-completions:responses-to-chat-completions']);
  assert.deepEqual(adapters('anthropic'), ['messages:messages:direct', 'responses:messages:responses-to-messages']);
});

test('live and overview preserve gateway snapshot sampledAt, instanceId/startedAt, and prioritize stats.activeRequests', async () => {
  const cfg = {
    providers: new Map([['test-prov', { apiType: 'anthropic', models: {} }]]),
    routes: new Map(),
    pricing: new Map(),
  };
  const gwStats = {
    generatedAt: '2026-09-28T03:00:00.000Z',
    activeRequests: 2,
    inflight: [
      { requestId: 'req-1', provider: 'test-prov', requestStartedAt: '2026-09-28T02:59:50.000Z', elapsedMs: 10000 },
      { requestId: 'req-2', provider: 'test-prov', requestStartedAt: '2026-09-28T02:59:55.000Z', elapsedMs: 5000 },
    ],
    switchboardRetained: [
      { provider: 'test-prov', model: 'done-model', clientType: 'codex', inputProtocol: 'responses', upstreamProtocol: 'responses', adapter: 'direct', finishedAt: '2026-09-28T02:59:00.000Z' },
    ],
  };
  const getGateway = async () => ({
    online: true,
    pid: 12345,
    instanceId: 'inst-abc-123',
    startedAt: '2026-09-28T00:00:00.000Z',
    activeRequests: 999, // health stale count
    stats: gwStats,
  });

  const live = await buildSwitchboardLive({ cfg, getGateway });
  assert.equal(live.sampledAt, '2026-09-28T03:00:00.000Z', 'live.sampledAt 必须优先采用 gw.stats.generatedAt');
  assert.notEqual(live.sampledAt, live.generatedAt, 'sampledAt 不应被包装层生成的 generatedAt 覆盖');
  assert.equal(live.instanceId, 'inst-abc-123');
  assert.equal(live.startedAt, '2026-09-28T00:00:00.000Z');
  assert.equal(live.activeRequests, 2, 'activeRequests 应优先取 stats.activeRequests 而非 health 的旧值 999');
  assert.deepEqual(live.switchboardRetained, gwStats.switchboardRetained);

  const overview = await buildOverview({ cfg, ledgerDir: null, period: 'today', getGateway });
  assert.equal(overview.sampledAt, '2026-09-28T03:00:00.000Z', 'overview.sampledAt 必须优先采用 gw.stats.generatedAt');
  assert.notEqual(overview.sampledAt, overview.generatedAt);
  assert.equal(overview.gateway.instanceId, 'inst-abc-123');
  assert.equal(overview.gateway.startedAt, '2026-09-28T00:00:00.000Z');
  assert.equal(overview.gateway.activeRequests, 2, 'overview gateway activeRequests 应优先取 stats.activeRequests');
  assert.deepEqual(overview.switchboardRetained, gwStats.switchboardRetained, '两个端点透传同一份网关 sticky 拓扑');
});

test('provider 过滤与 live 载荷隔离：按 provider 过滤在途与配置，且无 stats 时优雅降级', async () => {
  const cfg = {
    providers: new Map([
      ['anthropic', { apiType: 'anthropic', models: { sonnet: 'claude-sonnet-4-6' } }],
      ['openai', { apiType: 'openai', messagesTransport: 'responses', models: { gpt: 'gpt-4o' } }],
    ]),
    routes: new Map([
      ['sonnet', { provider: 'anthropic', model: 'sonnet' }],
      ['gpt', { provider: 'openai', model: 'gpt' }],
    ]),
    pricing: new Map(),
  };

  const gwStats = {
    generatedAt: '2026-09-28T05:00:00.000Z',
    activeRequests: 2,
    inflight: [
      { requestId: 'req-ant', provider: 'anthropic', model: 'claude-sonnet-4-6', requestStartedAt: '2026-09-28T04:59:50.000Z', elapsedMs: 10000 },
      { requestId: 'req-oai', provider: 'openai', model: 'gpt-4o', requestStartedAt: '2026-09-28T04:59:55.000Z', elapsedMs: 5000 },
    ],
    switchboardRetained: [
      { provider: 'anthropic', model: 'claude-sonnet-4-6', finishedAt: '2026-09-28T04:58:00.000Z' },
      { provider: 'openai', model: 'gpt-4o', finishedAt: '2026-09-28T04:58:30.000Z' },
    ],
  };

  const getGateway = async () => ({
    online: true,
    instanceId: 'inst-filtered',
    startedAt: '2026-09-28T01:00:00.000Z',
    activeRequests: 2,
    stats: gwStats,
  });

  // 1. 指定 provider='anthropic' 时，仅保留该 provider 的在途与配置计划
  const liveAnt = await buildSwitchboardLive({ cfg, provider: 'anthropic', getGateway });
  assert.equal(liveAnt.switchboardActive.length, 1);
  assert.equal(liveAnt.switchboardActive[0].requestId, 'req-ant');
  assert.equal(liveAnt.switchboardActive[0].provider, 'anthropic');
  assert.equal(liveAnt.switchboardActiveRequests, 1, 'provider 过滤后的交换台活动数必须与 switchboardActive 一致');
  assert.ok(liveAnt.switchboardConfigured.every((item) => item.provider === 'anthropic'));
  assert.deepEqual(liveAnt.switchboardRetained.map((item) => item.provider), ['anthropic']);

  // 2. 指定 provider='openai' 时，仅保留 openai
  const liveOai = await buildSwitchboardLive({ cfg, provider: 'openai', getGateway });
  assert.equal(liveOai.switchboardActive.length, 1);
  assert.equal(liveOai.switchboardActive[0].requestId, 'req-oai');
  assert.equal(liveOai.switchboardActive[0].provider, 'openai');
  assert.ok(liveOai.switchboardConfigured.every((item) => item.provider === 'openai'));
  assert.deepEqual(liveOai.switchboardRetained.map((item) => item.provider), ['openai']);

  const offline = await buildSwitchboardLive({ cfg, getGateway: async () => ({ online: false, stats: gwStats }) });
  assert.deepEqual(offline.switchboardRetained, [], '离线网关不保留 sticky 拓扑');
});

test('真实 HTTP 服务下 fetchGatewayStatus 的健康与用量拉取优先级与回退', async () => {
  const http = await import('node:http');
  let statsAvailable = true;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        service: 'slizm-gateway',
        pid: 7788,
        instanceId: 'real-gw-instance-xyz',
        startedAt: '2026-09-28T02:00:00.000Z',
        uptimeSec: 3600,
        activeRequests: 99, // health 中的旧/粗略计数
      }));
    } else if (req.url === '/v1/usage') {
      if (!statsAvailable) {
        res.writeHead(500);
        res.end();
        return;
      }
      assert.equal(req.headers.authorization, 'Bearer test-token-abc');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        generatedAt: '2026-09-28T02:30:00.000Z',
        activeRequests: 4, // 权威 stats 中的精确活跃请求数
        inflight: [
          { requestId: 'real-1', provider: 'anthropic', model: 'claude-sonnet-4-6', requestStartedAt: '2026-09-28T02:29:50.000Z', elapsedMs: 10000 }
        ],
      }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const cfg = { server: { host: '127.0.0.1', port, clientToken: 'test-token-abc' } };

    // Case A: /health 与 /v1/usage 均正常返回，stats.activeRequests 优先覆盖 health.activeRequests
    const statusWithStats = await fetchGatewayStatus(cfg);
    assert.equal(statusWithStats.online, true);
    assert.equal(statusWithStats.pid, 7788);
    assert.equal(statusWithStats.instanceId, 'real-gw-instance-xyz');
    assert.equal(statusWithStats.startedAt, '2026-09-28T02:00:00.000Z');
    assert.equal(statusWithStats.activeRequests, 4, '有 stats 时 activeRequests 应取 4 而非 health 的 99');
    assert.equal(statusWithStats.stats.inflight.length, 1);

    // Case B: /v1/usage 失败时优雅降级回退到 health.activeRequests
    statsAvailable = false;
    const statusFallback = await fetchGatewayStatus(cfg);
    assert.equal(statusFallback.online, true);
    assert.equal(statusFallback.stats, null);
    assert.equal(statusFallback.activeRequests, 99, 'stats 获取失败时应降级回退到 health.activeRequests');
  } finally {
    server.close();
  }
});
