import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdminServer } from '../src/admin/server.js';
import { calculateTrend, parsePeriodRange, resolveTrendStep, TREND_OTHER_KEY } from '../src/admin/data.js';
import { ROOT } from '../src/config.js';
import { computeRevision } from '../src/admin/settings.js';

async function createFixture() {
  const baseDir = await mkdtemp(join(tmpdir(), 'cg-admin-test-'));
  const configPath = join(baseDir, 'providers.json');
  const logDir = join(baseDir, 'logs');
  const ledgerDir = join(baseDir, 'ledger');
  const backupDir = join(baseDir, 'backups');
  const stateDir = join(baseDir, 'state');

  await mkdir(logDir, { recursive: true });
  await mkdir(ledgerDir, { recursive: true });
  await mkdir(backupDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  const initialConfig = {
    clientToken: 'fixture-client-token',
    customGlobalField: 'preserve-global-meta',
    nestedMeta: { keepThisToo: true },
    pricing: {
      'model-alpha': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    },
    providers: [
      {
        name: 'prov-a',
        apiType: 'anthropic',
        apiKey: 'sk-ant-secret123456789',
        baseUrl: 'https://api.anthropic.com',
        customProviderKey: 'preserve-provider-meta',
        models: { 'claude-3-opus': 'claude-3-opus-20240229' },
      },
      {
        name: 'prov-b',
        apiType: 'openai',
        apiKey: 'sk-openai-secret987654321',
        baseUrl: 'https://api.openai.com/v1',
      },
    ],
    routes: {
      default: 'prov-a',
      structured: { provider: 'prov-a', model: 'model-alpha' },
    },
  };

  await writeFile(configPath, JSON.stringify(initialConfig, null, 2) + '\n');

  return {
    baseDir,
    configPath,
    logDir,
    ledgerDir,
    backupDir,
    stateDir,
    initialConfig,
    async cleanup() {
      await rm(baseDir, { recursive: true, force: true });
    },
  };
}

function requestHttp(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text,
          json,
        });
      });
    });
    req.on('error', reject);
    if (body !== undefined) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

test('Host validation, origin check, bootstrap session, CSRF and secrets redaction', async (t) => {
  const fixture = await createFixture();
  t.after(async () => {
    await fixture.cleanup();
  });

  const sessionSecret = '11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff';
  const server = createAdminServer({
    configPath: fixture.configPath,
    logDir: fixture.logDir,
    ledgerDir: fixture.ledgerDir,
    backupDir: fixture.backupDir,
    stateDir: fixture.stateDir,
    sessionSecret,
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const origin = 'http://127.0.0.1:' + port;

  // 1. Invalid Host header rejected via raw http.request
  {
    const res = await requestHttp({
      host: '127.0.0.1',
      port,
      path: '/health',
      headers: { Host: 'evil.com' },
    });
    assert.equal(res.status, 400);
    assert.match(res.text, /Invalid Host/);
  }

  // 2. Health works with valid loopback host
  {
    const res = await requestHttp({
      host: '127.0.0.1',
      port,
      path: '/health',
      headers: { Host: '127.0.0.1:' + port },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json?.service, 'slizm-gateway-web');
  }

  // 3. /api/* without auth -> 401
  {
    const res = await requestHttp({
      host: '127.0.0.1',
      port,
      path: '/api/settings',
      headers: { Host: '127.0.0.1:' + port, Origin: origin },
    });
    assert.equal(res.status, 401);
  }

  // 4. /api/session bootstrap with wrong secret -> 401
  {
    const res = await requestHttp({
      host: '127.0.0.1',
      port,
      path: '/api/session',
      method: 'POST',
      headers: {
        Host: '127.0.0.1:' + port,
        Origin: origin,
        Authorization: 'Bearer wrongsecret123456789012345678901234567890123456789012345678901234',
      },
    });
    assert.equal(res.status, 401);
  }

  // 5. /api/session bootstrap with cross origin -> 403
  {
    const res = await requestHttp({
      host: '127.0.0.1',
      port,
      path: '/api/session',
      method: 'POST',
      headers: {
        Host: '127.0.0.1:' + port,
        Origin: 'http://malicious-site.com',
        Authorization: 'Bearer ' + sessionSecret,
      },
    });
    assert.equal(res.status, 403);
  }

  // 6. /api/session bootstrap valid -> receives session cookie
  let sessionCookie = '';
  {
    const res = await requestHttp({
      host: '127.0.0.1',
      port,
      path: '/api/session',
      method: 'POST',
      headers: {
        Host: '127.0.0.1:' + port,
        Origin: origin,
        Authorization: 'Bearer ' + sessionSecret,
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json?.ok, true);
    const setCookie = res.headers['set-cookie']?.[0] || res.headers['set-cookie'];
    assert.ok(setCookie, 'set-cookie header present');
    assert.match(setCookie, /admin_session=[a-f0-9]+;/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    sessionCookie = setCookie.split(';')[0];
  }

  // 7. Mutating request (PUT /api/settings) with invalid origin -> 403 CSRF rejection
  {
    const res = await requestHttp({
      host: '127.0.0.1',
      port,
      path: '/api/settings',
      method: 'PUT',
      headers: {
        Host: '127.0.0.1:' + port,
        Origin: 'http://attacker.com',
        Cookie: sessionCookie,
        'Content-Type': 'application/json',
      },
    }, {});
    assert.equal(res.status, 403);
    assert.match(res.json?.error, /Cross-origin request forbidden/);
  }

  // 8. GET /api/settings with wrong origin -> 403
  {
    const res = await requestHttp({
      host: '127.0.0.1',
      port,
      path: '/api/settings',
      headers: {
        Host: '127.0.0.1:' + port,
        Origin: 'http://attacker.com',
        Cookie: sessionCookie,
      },
    });
    assert.equal(res.status, 403);
  }

  // 9. Authenticated GET /api/settings never exposes apiKey or clientToken
  {
    const res = await requestHttp({
      host: '127.0.0.1',
      port,
      path: '/api/settings',
      headers: {
        Host: '127.0.0.1:' + port,
        Origin: origin,
        Cookie: sessionCookie,
      },
    });
    assert.equal(res.status, 200);
    assert.ok(res.json.revision, 'revision should be present');
    assert.equal(res.json.providers.length, 2);

    const provA = res.json.providers.find((p) => p.name === 'prov-a');
    assert.ok(provA);
    assert.equal(provA.hasApiKey, true);
    assert.equal(provA.apiKey, undefined, 'apiKey must never be exposed');
    assert.equal(res.json.clientToken, undefined, 'clientToken must never be exposed');

    const bodyStr = JSON.stringify(res.json);
    assert.ok(!bodyStr.includes('sk-ant-secret123456789'), 'plain apiKey must not appear in settings output');
    assert.ok(!bodyStr.includes('sk-openai-secret987654321'), 'plain apiKey must not appear in settings output');
    assert.ok(!bodyStr.includes('fixture-client-token'), 'clientToken must not appear in settings output');
  }
});

test('Log cleanup truncates both gateway log files and requires an authenticated same-origin request', async (t) => {
  const fixture = await createFixture();
  t.after(async () => fixture.cleanup());

  await writeFile(join(fixture.logDir, 'gateway.out.log'), 'out-line\n');
  await writeFile(join(fixture.logDir, 'gateway.err.log'), 'err-line\n');
  const sessionSecret = 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdef';
  const server = createAdminServer({
    configPath: fixture.configPath,
    logDir: fixture.logDir,
    ledgerDir: fixture.ledgerDir,
    backupDir: fixture.backupDir,
    stateDir: fixture.stateDir,
    sessionSecret,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;

  const unauthenticated = await requestHttp({
    host: '127.0.0.1', port, path: '/api/logs/clear', method: 'POST',
    headers: { Host: `127.0.0.1:${port}`, Origin: origin },
  });
  assert.equal(unauthenticated.status, 401);

  const session = await requestHttp({
    host: '127.0.0.1', port, path: '/api/session', method: 'POST',
    headers: { Host: `127.0.0.1:${port}`, Origin: origin, Authorization: `Bearer ${sessionSecret}` },
  });
  const cookie = (session.headers['set-cookie']?.[0] || session.headers['set-cookie']).split(';')[0];

  const wrongOrigin = await requestHttp({
    host: '127.0.0.1', port, path: '/api/logs/clear', method: 'POST',
    headers: { Host: `127.0.0.1:${port}`, Origin: 'http://evil.test', Cookie: cookie },
  });
  assert.equal(wrongOrigin.status, 403);

  const cleared = await requestHttp({
    host: '127.0.0.1', port, path: '/api/logs/clear', method: 'POST',
    headers: { Host: `127.0.0.1:${port}`, Origin: origin, Cookie: cookie },
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.ok, true);
  assert.equal(await readFile(join(fixture.logDir, 'gateway.out.log'), 'utf8'), '');
  assert.equal(await readFile(join(fixture.logDir, 'gateway.err.log'), 'utf8'), '');
});

test('Settings save preserves unknown fields/keys, handles stale revision, validation and atomic save', async (t) => {
  const fixture = await createFixture();
  t.after(async () => {
    await fixture.cleanup();
  });

  const sessionSecret = '223344556677889900aabbccddeeff0011223344556677889900aabbccddeeff';
  const server = createAdminServer({
    configPath: fixture.configPath,
    logDir: fixture.logDir,
    ledgerDir: fixture.ledgerDir,
    backupDir: fixture.backupDir,
    stateDir: fixture.stateDir,
    sessionSecret,
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const origin = 'http://127.0.0.1:' + port;

  const sessionRes = await requestHttp({
    host: '127.0.0.1',
    port,
    path: '/api/session',
    method: 'POST',
    headers: {
      Host: '127.0.0.1:' + port,
      Origin: origin,
      Authorization: 'Bearer ' + sessionSecret,
    },
  });
  const cookie = (sessionRes.headers['set-cookie']?.[0] || sessionRes.headers['set-cookie']).split(';')[0];

  const getSettingsRes = await requestHttp({
    host: '127.0.0.1',
    port,
    path: '/api/settings',
    headers: { Host: '127.0.0.1:' + port, Origin: origin, Cookie: cookie },
  });
  assert.equal(getSettingsRes.status, 200);
  const currentSettings = getSettingsRes.json;

  // 1. Conflict on stale revision
  {
    const stalePayload = {
      ...currentSettings,
      revision: 'stale-deadbeef-revision',
    };
    const res = await requestHttp({
      host: '127.0.0.1',
      port,
      path: '/api/settings',
      method: 'PUT',
      headers: {
        Host: '127.0.0.1:' + port,
        Origin: origin,
        Cookie: cookie,
        'Content-Type': 'application/json',
      },
    }, stalePayload);
    assert.equal(res.status, 409);
    assert.match(res.json?.error, /配置已被修改/);
  }

  // 2. Validation error: duplicate provider name
  {
    const invalidPayload = {
      ...currentSettings,
      providers: [
        { name: 'dup', apiType: 'anthropic', baseUrl: 'https://api.anthropic.com' },
        { name: 'dup', apiType: 'openai', baseUrl: 'https://api.openai.com' },
      ],
      routes: [],
    };
    const res = await requestHttp({
      host: '127.0.0.1',
      port,
      path: '/api/settings',
      method: 'PUT',
      headers: {
        Host: '127.0.0.1:' + port,
        Origin: origin,
        Cookie: cookie,
        'Content-Type': 'application/json',
      },
    }, invalidPayload);
    assert.equal(res.status, 400);
    assert.match(res.json?.error, /重复的 provider/);
  }

  // 3. Validation error: route referencing nonexistent provider
  {
    const invalidPayload = {
      ...currentSettings,
      providers: [{ name: 'valid-prov', apiType: 'anthropic', baseUrl: 'https://api.anthropic.com' }],
      routes: [{ alias: 'route1', provider: 'missing-prov' }],
    };
    const res = await requestHttp({
      host: '127.0.0.1',
      port,
      path: '/api/settings',
      method: 'PUT',
      headers: {
        Host: '127.0.0.1:' + port,
        Origin: origin,
        Cookie: cookie,
        'Content-Type': 'application/json',
      },
    }, invalidPayload);
    assert.equal(res.status, 400);
    assert.match(res.json?.error, /不存在/);
  }

  // 4. Validation error: prototype pollution
  {
    const pollutionPayload = {
      revision: currentSettings.revision,
      constructor: {},
      providers: [],
      routes: [],
    };
    const res = await requestHttp({
      host: '127.0.0.1',
      port,
      path: '/api/settings',
      method: 'PUT',
      headers: {
        Host: '127.0.0.1:' + port,
        Origin: origin,
        Cookie: cookie,
        'Content-Type': 'application/json',
      },
    }, pollutionPayload);
    assert.equal(res.status, 400);
    assert.match(res.json?.error, /非法配置属性名/);
  }

  // 5. Successful atomic save preserving unknown top-level and provider keys, omitting new key to keep old key
  {
    const updatedPayload = {
      revision: currentSettings.revision,
      logRequests: false,
      defaultRoute: 'prov-a',
      providers: [
        {
          name: 'prov-a',
          apiType: 'anthropic',
          baseUrl: 'https://api.anthropic.com/v2',
          // Notice: apiKey omitted -> should preserve existing sk-ant-secret123456789
        },
        {
          name: 'prov-c',
          apiType: 'openai',
          apiKey: 'sk-openai-new-prov-c',
          baseUrl: 'https://api.openai.com/v1',
        },
      ],
      routes: [
        { alias: 'fast', provider: 'prov-c' },
        { alias: 'smart', provider: 'prov-a', model: 'claude-3-opus' },
      ],
    };

    const res = await requestHttp({
      host: '127.0.0.1',
      port,
      path: '/api/settings',
      method: 'PUT',
      headers: {
        Host: '127.0.0.1:' + port,
        Origin: origin,
        Cookie: cookie,
        'Content-Type': 'application/json',
      },
    }, updatedPayload);
    assert.equal(res.status, 200);
    assert.ok(res.json.revision);
    assert.equal(res.json.restartRequired, true);

    // Verify on disk atomic write and field preservation
    const savedDiskJson = JSON.parse(await readFile(fixture.configPath, 'utf8'));
    // Unknown top-level fields preserved
    assert.equal(savedDiskJson.clientToken, 'fixture-client-token');
    assert.equal(savedDiskJson.customGlobalField, 'preserve-global-meta');
    assert.deepEqual(savedDiskJson.nestedMeta, { keepThisToo: true });
    assert.deepEqual(savedDiskJson.pricing, fixture.initialConfig.pricing);

    // Prov-a retained secret and unknown field
    const savedProvA = savedDiskJson.providers.find((p) => p.name === 'prov-a');
    assert.ok(savedProvA);
    assert.equal(savedProvA.apiKey, 'sk-ant-secret123456789', 'existing apiKey preserved when not overridden');
    assert.equal(savedProvA.customProviderKey, 'preserve-provider-meta', 'unknown provider property preserved');
    assert.equal(savedProvA.baseUrl, 'https://api.anthropic.com/v2');

    // Prov-c created
    const savedProvC = savedDiskJson.providers.find((p) => p.name === 'prov-c');
    assert.ok(savedProvC);
    assert.equal(savedProvC.apiKey, 'sk-openai-new-prov-c');

    // Routes saved correctly
    assert.equal(savedDiskJson.routes.fast, 'prov-c');
    assert.deepEqual(savedDiskJson.routes.smart, { provider: 'prov-a', model: 'claude-3-opus' });
    assert.equal(savedDiskJson.defaultRoute, 'prov-a');
    assert.equal(savedDiskJson.logRequests, false);
  }
});

test('Ledger and overview data: provider filtering, global pricing and missing values', async (t) => {
  const fixture = await createFixture();
  t.after(async () => {
    await fixture.cleanup();
  });

  // Write usage ledger for the current month
  const now = new Date();
  const ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const ledgerPath = join(fixture.ledgerDir, 'usage-' + ym + '.jsonl');

  const records = [
    {
      time: now.toISOString(),
      provider: 'prov-a',
      model: 'model-alpha',
      route: 'structured',
      status: 200,
      usageSource: 'reported',
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 100,
      cacheWriteTokens: 200,
      durationMs: 450,
    },
    {
      time: now.toISOString(),
      provider: 'prov-unlisted',
      model: 'unknown-model-unpriced',
      route: 'unmapped',
      status: 500,
      usageSource: 'reported',
      inputTokens: 200,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      durationMs: 120,
    },
    {
      time: now.toISOString(),
      provider: 'prov-a',
      model: 'model-alpha',
      route: 'structured',
      status: 499,
      usageSource: 'unreported',
      durationMs: 2000,
    },
  ];

  await writeFile(
    ledgerPath,
    records.map((r) => JSON.stringify(r)).join('\n') + '\n'
  );

  const mockGatewayStatus = {
    online: true,
    pid: 7777,
    uptimeSec: 3600,
    activeRequests: 2,
    baseUrl: 'http://127.0.0.1:4000',
    stats: {
      inflight: [
        { provider: 'prov-a', model: 'model-alpha', elapsedMs: 500 },
        { provider: 'prov-b', model: 'gpt-4', elapsedMs: 300 },
      ],
    },
  };

  const sessionSecret = '3344556677889900aabbccddeeff0011223344556677889900aabbccddeeff00';
  const server = createAdminServer({
    configPath: fixture.configPath,
    logDir: fixture.logDir,
    ledgerDir: fixture.ledgerDir,
    backupDir: fixture.backupDir,
    stateDir: fixture.stateDir,
    sessionSecret,
    getGateway: async () => mockGatewayStatus,
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const origin = 'http://127.0.0.1:' + port;

  const sessionRes = await requestHttp({
    host: '127.0.0.1',
    port,
    path: '/api/session',
    method: 'POST',
    headers: {
      Host: '127.0.0.1:' + port,
      Origin: origin,
      Authorization: 'Bearer ' + sessionSecret,
    },
  });
  const cookie = (sessionRes.headers['set-cookie']?.[0] || sessionRes.headers['set-cookie']).split(';')[0];

  // 1. Overview for all providers
  {
    const res = await requestHttp({
      host: '127.0.0.1',
      port,
      path: '/api/overview?period=all',
      headers: { Host: '127.0.0.1:' + port, Origin: origin, Cookie: cookie },
    });
    assert.equal(res.status, 200);
    const data = res.json;

    assert.equal(data.gateway.online, true);
    assert.equal(data.gateway.pid, 7777);
    assert.equal(data.total.requests, 3);
    assert.equal(data.total.errors, 1);
    assert.equal(data.total.cancelled, 1);
    assert.equal(data.total.unreported, 1);
    assert.equal(data.total.pricedRequests, 1);
    assert.equal(data.total.unpricedRequests, 1);
    assert.ok(data.total.costUsd > 0);

    // Verify prov-unlisted appears in providers list even if not in configured providers
    const unlistedProv = data.providers.find((p) => p.name === 'prov-unlisted');
    assert.ok(unlistedProv, 'unlisted provider from ledger should appear');
    assert.equal(unlistedProv.requests, 1);
    assert.equal(unlistedProv.unpricedRequests, 1);
    assert.equal(unlistedProv.costUsd, 0);

    // Verify inflight includes both
    assert.equal(data.inflight.length, 2);
  }

  // 2. Overview filtered by provider=prov-a
  {
    const res = await requestHttp({
      host: '127.0.0.1',
      port,
      path: '/api/overview?period=all&provider=prov-a',
      headers: { Host: '127.0.0.1:' + port, Origin: origin, Cookie: cookie },
    });
    assert.equal(res.status, 200);
    const data = res.json;

    assert.equal(data.total.requests, 2);
    assert.equal(data.total.cancelled, 1);
    assert.equal(data.providers.length, 1);
    assert.equal(data.providers[0].name, 'prov-a');
    // inflight filtered
    assert.equal(data.inflight.length, 1);
    assert.equal(data.inflight[0].provider, 'prov-a');
  }

  // 3. 自定义时间段（精确到分钟）：按分钟分桶，并带模型细分与缓存读写
  {
    const since = now.getTime() - 10 * 60_000;
    const until = now.getTime() + 60_000;
    const res = await requestHttp({
      host: '127.0.0.1',
      port,
      path: `/api/overview?period=custom&since=${since}&until=${until}`,
      headers: { Host: '127.0.0.1:' + port, Origin: origin, Cookie: cookie },
    });
    assert.equal(res.status, 200);
    const data = res.json;
    assert.equal(data.total.requests, 3);
    assert.deepEqual([data.range.period, data.range.since, data.range.until], ['custom', since, until]);
    assert.equal(data.trendStep.key, '1m');
    assert.equal(data.trend.reduce((sum, point) => sum + point.requests, 0), 3);
    assert.deepEqual(data.trendModels.map((m) => m.key).sort(), ['prov-a · model-alpha', 'prov-unlisted · unknown-model-unpriced']);
    const bucket = data.trend.find((point) => point.requests === 3);
    assert.equal(bucket.cacheRead, 100);
    assert.equal(bucket.input, 1200);
    assert.equal(bucket.models.reduce((sum, m) => sum + m.totalTokens, 0), bucket.totalTokens);
  }

  // 4. 自定义时间段不合法时返回 400，而不是按“今天”静默处理
  {
    const res = await requestHttp({
      host: '127.0.0.1',
      port,
      path: `/api/overview?period=custom&since=${now.getTime()}&until=${now.getTime() - 60_000}`,
      headers: { Host: '127.0.0.1:' + port, Origin: origin, Cookie: cookie },
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /结束时间需晚于开始时间/);
  }
});

test('Time ranges accept minute/hour/day presets, yesterday and validated custom ranges', () => {
  const now = new Date(2026, 8, 27, 14, 5, 30).getTime();
  const quarter = parsePeriodRange('15m', { now });
  assert.deepEqual([quarter.period, quarter.since, quarter.until, quarter.label], ['15m', now - 15 * 60_000, now, '最近 15 分钟']);
  assert.equal(parsePeriodRange('6h', { now }).since, now - 6 * 3_600_000);
  const yesterday = parsePeriodRange('yesterday', { now });
  assert.equal(yesterday.since, new Date(2026, 8, 26).getTime());
  assert.equal(yesterday.until, new Date(2026, 8, 27).getTime() - 1);
  assert.equal(parsePeriodRange('bogus', { now }).period, 'today');
  assert.equal(parsePeriodRange('0m', { now }).period, 'today');

  const since = new Date(2026, 8, 27, 14, 0).getTime();
  const custom = parsePeriodRange('custom', { since: String(since), until: String(since + 30 * 60_000), now });
  assert.deepEqual([custom.since, custom.until, custom.end, custom.label], [since, since + 30 * 60_000 - 1, since + 30 * 60_000, '09-27 14:00 – 14:30']);
  assert.equal(parsePeriodRange('custom', { since: new Date(since).toISOString(), until: since + 60_000, now }).since, since);
  for (const [a, b] of [[since, since], [since, since + 30_000], ['abc', since], [-5, since], [since, '']]) {
    assert.throws(() => parsePeriodRange('custom', { since: a, until: b, now }), (error) => error.statusCode === 400);
  }
});

test('Trend picks finer buckets for short ranges, caps explicit steps and splits usage by model', () => {
  const minute = 60_000;
  const hour = 60 * minute;
  const now = new Date(2026, 8, 27, 14, 0).getTime();
  assert.equal(resolveTrendStep('auto', now - 15 * minute, now).key, '1m');
  assert.equal(resolveTrendStep('auto', now - hour, now).key, '1m');
  assert.equal(resolveTrendStep('auto', now - 6 * hour, now).key, '10m');
  assert.equal(resolveTrendStep('auto', now - 24 * hour, now).key, '30m');
  assert.equal(resolveTrendStep('auto', now - 7 * 24 * hour, now).key, '3h');
  assert.equal(resolveTrendStep('auto', now - 30 * 24 * hour, now).key, '1d');
  const capped = resolveTrendStep('1m', now - 7 * 24 * hour, now);
  assert.equal(capped.adjusted, true);
  assert.ok(7 * 24 * hour / capped.ms <= 360, '手动粒度放大到点数上限以内');

  // 8 个模型：前 6 个单独成带，其余 2 个并入“其他”
  const items = Array.from({ length: 40 }, (_, i) => ({
    time: new Date(now - 50 * minute + i * minute).toISOString(),
    provider: 'relay', model: 'model-' + (i % 8), usageSource: 'reported',
    inputTokens: 100 * (8 - (i % 8)), outputTokens: 10, cacheReadTokens: 30, cacheWriteTokens: 5,
    costUsd: 0.002, baseCostUsd: 0.001,
  }));
  const { points, step, models } = calculateTrend(items, now - hour, now, { step: '15m' });
  assert.equal(step.key, '15m');
  assert.deepEqual(points.map((p) => new Date(p.time).getMinutes()), [0, 15, 30, 45, 0]);
  assert.equal(points[0].end, points[1].time);
  assert.equal(models.length, 7);
  assert.equal(models[0].key, 'relay · model-0');
  assert.equal(models.at(-1).key, TREND_OTHER_KEY);
  assert.equal(models.at(-1).count, 2);
  for (const point of points) {
    assert.equal(point.models.reduce((sum, m) => sum + m.totalTokens, 0), point.totalTokens);
    assert.equal(point.models.reduce((sum, m) => sum + m.requests, 0), point.requests);
  }
  const busy = points.find((p) => p.requests > 0);
  assert.equal(busy.cacheRead, busy.requests * 30);
  assert.ok(Math.abs(busy.baseCostUsd - busy.requests * 0.001) < 1e-12);
  assert.deepEqual(calculateTrend([], now - hour, now).points, []);
});

test('Trend keeps original and multiplier-adjusted costs separately', () => {
  const pricing = new Map([
    ['model-alpha', { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 }],
  ]);
  const since = Date.parse('2026-09-27T10:00:00.000Z');
  const until = Date.parse('2026-09-27T10:59:59.000Z');
  const { points: trend } = calculateTrend([
    {
      time: '2026-09-27T10:10:00.000Z', model: 'model-alpha', usageSource: 'reported',
      inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0,
      baseCostUsd: 0.012, costUsd: 0.036,
    },
    {
      time: '2026-09-27T10:20:00.000Z', model: 'model-alpha', usageSource: 'reported',
      inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0,
      costUsd: 0.004,
    },
    {
      time: '2026-09-27T10:30:00.000Z', model: 'model-alpha', usageSource: 'reported',
      inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0,
      costUsd: null,
    },
  ], since, until, { step: '1h', pricing });

  assert.equal(trend.length, 1);
  assert.ok(Math.abs(trend[0].baseCostUsd - 0.016) < 1e-12);
  assert.ok(Math.abs(trend[0].costUsd - 0.04) < 1e-12);
});

test('Restart lock with injectable mock restart function', async (t) => {
  const fixture = await createFixture();
  t.after(async () => {
    await fixture.cleanup();
  });

  let resolveRestart;
  let restartCount = 0;
  const restartPromise = new Promise((resolve) => {
    resolveRestart = resolve;
  });

  const mockRestartGateway = async () => {
    restartCount++;
    await restartPromise;
    return { ok: true, simulated: true };
  };

  const sessionSecret = '44556677889900aabbccddeeff0011223344556677889900aabbccddeeff0011';
  const server = createAdminServer({
    configPath: fixture.configPath,
    logDir: fixture.logDir,
    ledgerDir: fixture.ledgerDir,
    backupDir: fixture.backupDir,
    stateDir: fixture.stateDir,
    sessionSecret,
    restartGateway: mockRestartGateway,
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const origin = 'http://127.0.0.1:' + port;

  const sessionRes = await requestHttp({
    host: '127.0.0.1',
    port,
    path: '/api/session',
    method: 'POST',
    headers: {
      Host: '127.0.0.1:' + port,
      Origin: origin,
      Authorization: 'Bearer ' + sessionSecret,
    },
  });
  const cookie = (sessionRes.headers['set-cookie']?.[0] || sessionRes.headers['set-cookie']).split(';')[0];

  // Initiate first restart (in flight)
  const firstReqPromise = requestHttp({
    host: '127.0.0.1',
    port,
    path: '/api/restart',
    method: 'POST',
    headers: {
      Host: '127.0.0.1:' + port,
      Origin: origin,
      Cookie: cookie,
    },
  });

  // Second restart while first is in-flight -> 409 Conflict
  const secondRes = await requestHttp({
    host: '127.0.0.1',
    port,
    path: '/api/restart',
    method: 'POST',
    headers: {
      Host: '127.0.0.1:' + port,
      Origin: origin,
      Cookie: cookie,
    },
  });

  assert.equal(secondRes.status, 409);
  assert.match(secondRes.json?.error, /正在重启中/);

  // Release first restart
  resolveRestart();
  const firstRes = await firstReqPromise;
  assert.equal(firstRes.status, 200);
  assert.equal(firstRes.json?.simulated, true);
  assert.equal(restartCount, 1);
});

test('Default port fallback using isolated child process', async (t) => {
  const fixture = await createFixture();
  t.after(async () => {
    await fixture.cleanup();
  });

  const defaultPort = 48731;
  // If port 48731 is already in use by an external service or already bound,
  // the child process will encounter EADDRINUSE and fall back to port 0.
  // If it is NOT in use, we bind a blocker server to trigger the fallback.
  let blocker = null;
  let blockerListening = false;
  try {
    blocker = http.createServer((req, res) => res.end('blocked'));
    await new Promise((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(defaultPort, '127.0.0.1', () => {
        blockerListening = true;
        resolve();
      });
    });
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      // Port is already occupied, which will naturally trigger fallback for the child process.
      blocker = null;
    } else {
      t.skip('Default port 48731 cannot be tested: ' + err.message);
      return;
    }
  }

  t.after(async () => {
    if (blockerListening && blocker) {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  const child = spawn(process.execPath, [join(ROOT, 'src', 'admin', 'server.js')], {
    env: {
      ...process.env,
      GATEWAY_WEB_PORT: undefined,
      GATEWAY_WEB_STATE_DIR: fixture.stateDir,
      GATEWAY_CONFIG: fixture.configPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(() => {
    if (child.exitCode === null) {
      child.kill();
    }
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  // Wait for session file written with fallback port
  const sessionFile = join(fixture.stateDir, 'web-session.json');
  let sessionData = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      const raw = await readFile(sessionFile, 'utf8');
      sessionData = JSON.parse(raw);
      if (sessionData && sessionData.port && sessionData.port !== defaultPort) {
        break;
      }
    } catch {}
  }

  assert.ok(sessionData, 'session file should be created by child process');
  assert.notEqual(sessionData.port, defaultPort, 'child process must fallback to an ephemeral port');
  assert.ok(sessionData.port > 0, 'fallback port must be positive');
  assert.equal(sessionData.pid, child.pid, 'PID in session file matches child PID');
  assert.match(stderr, /默认管理端口 48731 被占用/);
});

test('Settings PUT hot reload pricing: success, mixed with pending restart, and reload failure', async (t) => {
  const fixture = await createFixture();
  t.after(async () => {
    await fixture.cleanup();
  });

  const sessionSecret = '11223344556677889900aabbccddeeff0011223344556677889900aabbccddeeff';
  let reloadCalls = [];
  let reloadMock = async (opts) => {
    reloadCalls.push(opts);
    return { reloadApplied: true, restartRequired: false, pricingRevision: 'p-rev-123', effectiveAt: new Date().toISOString() };
  };

  const server = createAdminServer({
    configPath: fixture.configPath,
    logDir: fixture.logDir,
    ledgerDir: fixture.ledgerDir,
    backupDir: fixture.backupDir,
    stateDir: fixture.stateDir,
    sessionSecret,
    reloadPricing: (opts) => reloadMock(opts),
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const origin = 'http://127.0.0.1:' + port;
  const sessionRes = await requestHttp({
    host: '127.0.0.1',
    port,
    path: '/api/session',
    method: 'POST',
    headers: {
      Host: '127.0.0.1:' + port,
      Origin: origin,
      Authorization: 'Bearer ' + sessionSecret,
    },
  });
  const cookie = (sessionRes.headers['set-cookie']?.[0] || sessionRes.headers['set-cookie']).split(';')[0];

  // 1. Success hot-only pricing save
  const getSettings1 = await requestHttp({
    host: '127.0.0.1',
    port,
    path: '/api/settings',
    headers: { Host: '127.0.0.1:' + port, Origin: origin, Cookie: cookie },
  });
  const payload1 = {
    ...getSettings1.json,
    pricing: { ...getSettings1.json.pricing, 'new-hot-model': { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 } },
  };
  const res1 = await requestHttp({
    host: '127.0.0.1',
    port,
    path: '/api/settings',
    method: 'PUT',
    headers: { Host: '127.0.0.1:' + port, Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
  }, payload1);
  assert.equal(res1.status, 200);
  assert.equal(res1.json.reloadApplied, true);
  assert.equal(res1.json.restartRequired, false);
  assert.equal(reloadCalls.length, 1);
  assert.equal(reloadCalls[0].expectedRevision, res1.json.revision);

  // 2. Mixed changes (pricing + nonpricing change) -> reloadApplied=true, restartRequired=true
  reloadMock = async (opts) => {
    reloadCalls.push(opts);
    return { reloadApplied: true, restartRequired: true, pricingRevision: 'p-rev-456', effectiveAt: new Date().toISOString() };
  };
  const payload2 = {
    ...payload1,
    revision: res1.json.revision,
    logRequests: !payload1.logRequests,
    pricing: { ...payload1.pricing, 'new-hot-model': { input: 3, output: 12, cacheRead: 0.3, cacheWrite: 3.5 } },
  };
  const res2 = await requestHttp({
    host: '127.0.0.1',
    port,
    path: '/api/settings',
    method: 'PUT',
    headers: { Host: '127.0.0.1:' + port, Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
  }, payload2);
  assert.equal(res2.status, 200);
  assert.equal(res2.json.reloadApplied, true);
  assert.equal(res2.json.restartRequired, true);

  // 3. Reload failure -> preserve disk save, reloadApplied=false, reloadError safe string, restartRequired=true
  reloadMock = async () => {
    throw new Error('Gateway loopback socket timeout');
  };
  const payload3 = {
    ...payload2,
    revision: res2.json.revision,
    pricing: { ...payload2.pricing, 'new-hot-model': { input: 4, output: 16, cacheRead: 0.4, cacheWrite: 4.5 } },
  };
  const res3 = await requestHttp({
    host: '127.0.0.1',
    port,
    path: '/api/settings',
    method: 'PUT',
    headers: { Host: '127.0.0.1:' + port, Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
  }, payload3);
  assert.equal(res3.status, 200);
  assert.equal(res3.json.reloadApplied, false);
  assert.match(res3.json.reloadError, /timeout/i);
  assert.equal(res3.json.restartRequired, true);
  // Disk was updated despite reload failure
  const diskContent = JSON.parse(await readFile(fixture.configPath, 'utf8'));
  assert.equal(diskContent.pricing['new-hot-model'].input, 4);
});

test('Settings preserves exact all-1 priceMultipliers when wildcard multiplier is not 1', async (t) => {
  const fixture = await createFixture();
  t.after(async () => {
    await fixture.cleanup();
  });

  const sessionSecret = '3344556677889900aabbccddeeff0011223344556677889900aabbccddeeff00';
  const server = createAdminServer({
    configPath: fixture.configPath,
    logDir: fixture.logDir,
    ledgerDir: fixture.ledgerDir,
    backupDir: fixture.backupDir,
    stateDir: fixture.stateDir,
    sessionSecret,
    reloadPricing: async () => ({ reloadApplied: true, restartRequired: false }),
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const origin = 'http://127.0.0.1:' + port;
  const sessionRes = await requestHttp({
    host: '127.0.0.1',
    port,
    path: '/api/session',
    method: 'POST',
    headers: {
      Host: '127.0.0.1:' + port,
      Origin: origin,
      Authorization: 'Bearer ' + sessionSecret,
    },
  });
  const cookie = (sessionRes.headers['set-cookie']?.[0] || sessionRes.headers['set-cookie']).split(';')[0];

  const getSettings = await requestHttp({
    host: '127.0.0.1',
    port,
    path: '/api/settings',
    headers: { Host: '127.0.0.1:' + port, Origin: origin, Cookie: cookie },
  });
  const current = getSettings.json;
  const updatedProviders = current.providers.map((p) => {
    if (p.name === 'prov-a') {
      return {
        ...p,
        priceMultipliers: {
          '*': { input: 1.5, output: 1.5, cacheRead: 1.5, cacheWrite: 1.5 },
          'claude-exact-exempt': { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
        },
      };
    }
    return p;
  });

  const res = await requestHttp({
    host: '127.0.0.1',
    port,
    path: '/api/settings',
    method: 'PUT',
    headers: { Host: '127.0.0.1:' + port, Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
  }, { ...current, providers: updatedProviders });
  assert.equal(res.status, 200);

  const diskContent = JSON.parse(await readFile(fixture.configPath, 'utf8'));
  const provA = diskContent.providers.find((p) => p.name === 'prov-a');
  assert.ok(provA.priceMultipliers['claude-exact-exempt'], 'Exact all-1 multiplier must be preserved on disk when wildcard is non-1');
  assert.equal(provA.priceMultipliers['claude-exact-exempt'].input, 1);
});
