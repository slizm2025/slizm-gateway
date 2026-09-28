import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createRuntimePricing,
  pricingChangeRequiresRestart,
  pricingControlPath,
  reloadGatewayPricing,
} from '../src/runtime-pricing.js';
import { ledgerFile } from '../src/usage.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLIENT_TOKEN = 'test-runtime-pricing-client-token';
const CODEX_HEADERS = {
  'user-agent': 'Codex Desktop/0.155.0-alpha.16.4 (Windows; x86_64) dumb (codex_exec; 0.155.0-alpha.16.4)',
  originator: 'Codex Desktop',
  'x-codex-installation-id': 'codex-installation',
  'x-codex-window-id': 'codex-window',
};

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function atomicWrite(targetPath, content) {
  const tmp = `${targetPath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, content);
  let lastErr;
  for (let i = 0; i < 20; i++) {
    try {
      await rename(tmp, targetPath);
      return;
    } catch (e) {
      lastErr = e;
      await wait(15);
    }
  }
  try { await rm(tmp, { force: true }); } catch {}
  throw lastErr;
}

test('createRuntimePricing: capture 不可变快照、精确 vs * 隔离、重置为默认倍率', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rt-pricing-unit-cap-'));
  const configPath = join(dir, 'config.json');

  try {
    const config1 = {
      pricing: {
        'claude-3-7-sonnet': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 },
      },
      providers: [
        {
          name: 'provider-exact',
          priceMultipliers: {
            'claude-3-7-sonnet': { input: 0.8, output: 0.8, cacheRead: 0.8, cacheWrite: 0.8 },
            '*': { input: 0.5, output: 0.5, cacheRead: 0.5, cacheWrite: 0.5 },
          },
        },
        {
          name: 'provider-wildcard',
          priceMultipliers: {
            '*': { input: 1.5, output: 1.5, cacheRead: 1.5, cacheWrite: 1.5 },
          },
        },
      ],
    };
    await writeFile(configPath, JSON.stringify(config1));

    const rt = createRuntimePricing({ configPath, initialContent: JSON.stringify(config1) });

    const exactCap = rt.capture('provider-exact', 'claude-3-7-sonnet');
    assert.equal(exactCap.priceMultiplier.input, 0.8);
    assert.equal(exactCap.priceMultiplier.output, 0.8);
    assert.equal(exactCap.pricing['claude-3-7-sonnet'].input, 3);
    assert.ok(Object.isFrozen(exactCap.priceMultiplier));
    assert.ok(Object.isFrozen(exactCap.pricing));

    assert.throws(() => { exactCap.priceMultiplier.input = 999; }, TypeError);
    assert.throws(() => { exactCap.pricing['claude-3-7-sonnet'].input = 999; }, TypeError);

    const wildcardOther = rt.capture('provider-exact', 'gpt-4o');
    assert.equal(wildcardOther.priceMultiplier.input, 0.5);

    const wildcardOnly = rt.capture('provider-wildcard', 'claude-3-7-sonnet');
    assert.equal(wildcardOnly.priceMultiplier.input, 1.5);

    // 重置为默认倍率：移除 provider-exact 的 priceMultipliers (resolveMultiplier 返回 null)
    const config2 = {
      pricing: config1.pricing,
      providers: [
        { name: 'provider-exact' },
        { name: 'provider-wildcard', priceMultipliers: { '*': { input: 1.5, output: 1.5, cacheRead: 1.5, cacheWrite: 1.5 } } },
      ],
    };
    await writeFile(configPath, JSON.stringify(config2));
    rt.reload();

    const resetCap = rt.capture('provider-exact', 'claude-3-7-sonnet');
    assert.equal(resetCap.priceMultiplier, null);
    // 旧快照仍保持原 0.8 倍率不可变
    assert.equal(exactCap.priceMultiplier.input, 0.8);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('createRuntimePricing: 基础价格全量候选校验与原子生效，无新旧混杂与抖动', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rt-pricing-unit-'));
  const configPath = join(dir, 'config.json');

  try {
    const config1 = {
      pricing: {
        'model-a': { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
        'model-b': { input: 10, output: 20, cacheRead: 1, cacheWrite: 10 },
      },
      providers: [{ name: 'p1' }],
    };
    await writeFile(configPath, JSON.stringify(config1));

    const rt = createRuntimePricing({ configPath, initialContent: JSON.stringify(config1) });
    const cap1 = rt.capture('p1', 'model-a');
    const rev1 = rt.status().pricingRevision;
    const eff1 = rt.status().effectiveAt;

    const config2 = {
      pricing: {
        'model-a': { input: 5, output: 10, cacheRead: 0.5, cacheWrite: 5 },
        'model-b': { input: 50, output: 100, cacheRead: 5, cacheWrite: 50 },
      },
      providers: [{ name: 'p1' }],
    };
    await writeFile(configPath, JSON.stringify(config2));

    rt.reload();
    const cap2A = rt.capture('p1', 'model-a');
    const cap2B = rt.capture('p1', 'model-b');
    const rev2 = rt.status().pricingRevision;
    const eff2 = rt.status().effectiveAt;

    assert.notEqual(rev1, rev2);
    assert.equal(cap2A.pricing['model-a'].input, 5);
    assert.equal(cap2B.pricing['model-b'].input, 50);
    assert.equal(cap1.pricing['model-a'].input, 1);
    assert.equal(cap1.pricing['model-b'].input, 10);

    // 重复 reload 相同配置不发生 pricingRevision / effectiveAt 抖动
    rt.reload();
    assert.equal(rt.status().pricingRevision, rev2);
    assert.equal(rt.status().effectiveAt, eff2);

    // 候选包含负数定价：整体抛错，候选绝不部分生效
    const configInvalid = {
      pricing: {
        'model-a': { input: 99, output: 99 },
        'model-b': { input: -1, output: 20 },
      },
      providers: [{ name: 'p1' }],
    };
    await writeFile(configPath, JSON.stringify(configInvalid));

    assert.throws(() => rt.reload());
    assert.equal(rt.status().pricingRevision, rev2);
    assert.equal(rt.capture('p1', 'model-a').pricing['model-a'].input, 5);
    assert.equal(rt.capture('p1', 'model-b').pricing['model-b'].input, 50);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('createRuntimePricing: startWatching 原子重命名、无效 JSON 保持与重命名/错误恢复', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rt-pricing-watch-'));
  const configPath = join(dir, 'config.json');

  const errors = [];
  try {
    const config1 = {
      pricing: { 'model-x': { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 } },
      providers: [{ name: 'p1' }],
    };
    await writeFile(configPath, JSON.stringify(config1));

    const rt = createRuntimePricing({
      configPath,
      initialContent: JSON.stringify(config1),
      onError: (err) => errors.push(err.message),
    });

    const stopWatching = rt.startWatching({ intervalMs: 30, debounceMs: 15 });

    try {
      // 1. 原子重命名生效新配置
      const config2 = {
        pricing: { 'model-x': { input: 8, output: 16, cacheRead: 0.8, cacheWrite: 8 } },
        providers: [{ name: 'p1' }],
      };
      await atomicWrite(configPath, JSON.stringify(config2));

      for (let i = 0; i < 50 && rt.capture('p1', 'model-x').pricing['model-x'].input !== 8; i++) {
        await wait(20);
      }
      assert.equal(rt.capture('p1', 'model-x').pricing['model-x'].input, 8);

      // 2. 原子重命名无效 JSON：轮询断言捕获错误并保留最后有效价格
      await atomicWrite(configPath, '{ invalid json content ...');

      for (let i = 0; i < 50 && errors.length === 0; i++) {
        await wait(20);
      }
      assert.ok(errors.length > 0);
      assert.equal(rt.capture('p1', 'model-x').pricing['model-x'].input, 8);

      // 3. 恢复为有效 JSON
      const config3 = {
        pricing: { 'model-x': { input: 20, output: 40, cacheRead: 2, cacheWrite: 20 } },
        providers: [{ name: 'p1' }],
      };
      await atomicWrite(configPath, JSON.stringify(config3));

      for (let i = 0; i < 50 && rt.capture('p1', 'model-x').pricing['model-x'].input !== 20; i++) {
        await wait(20);
      }
      assert.equal(rt.capture('p1', 'model-x').pricing['model-x'].input, 20);
    } finally {
      stopWatching();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pricingChangeRequiresRestart: 非计价变更 restartRequired 标志在后续纯计价保存中持续保留', () => {
  const base = {
    pricing: { m1: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
    providers: [{ name: 'p1', apiKey: 'key1' }],
    routes: { 'route-1': { provider: 'p1' } },
  };

  const nonPricingChanged = {
    pricing: { m1: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
    providers: [{ name: 'p1', apiKey: 'key2' }],
    routes: { 'route-1': { provider: 'p1' } },
  };
  assert.equal(pricingChangeRequiresRestart(base, nonPricingChanged), true);

  const pricingOnlyAfterNonPricing = {
    pricing: { m1: { input: 99, output: 199, cacheRead: 0, cacheWrite: 0 } },
    providers: [{ name: 'p1', apiKey: 'key2' }],
    routes: { 'route-1': { provider: 'p1' } },
  };
  assert.equal(pricingChangeRequiresRestart(base, pricingOnlyAfterNonPricing), true);
  assert.equal(pricingChangeRequiresRestart(nonPricingChanged, pricingOnlyAfterNonPricing), false);
});

test('端到端回归：网关子进程运行中更新计价、请求 A 在途/请求 B 计价生效、账本与版本快照、权限/冲突/PID隔离', async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), 'rt-pricing-e2e-'));
  const configPath = join(tempDir, 'providers.json');
  const ledgerDir = join(tempDir, 'logs');

  let requestAHangResolver;
  const requestAHangPromise = new Promise((resolve) => {
    requestAHangResolver = resolve;
  });

  const upstream = http.createServer((req, res) => {
    let bodyText = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { bodyText += c; });
    req.on('end', async () => {
      const parsed = bodyText ? JSON.parse(bodyText) : {};
      const isStream = parsed.stream === true;
      const isRequestA = bodyText.includes('in-flight-A');

      if (isRequestA) {
        await requestAHangPromise;
      }

      if (req.url === '/v1/messages' || req.url === '/messages') {
        const usage = {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 10,
        };
        if (isStream) {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
          res.write('event: message_start\ndata: ' + JSON.stringify({
            type: 'message_start',
            message: { id: 'msg_stream', type: 'message', role: 'assistant', model: parsed.model, usage: { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 } },
          }) + '\n\n');
          res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
          res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n');
          res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
          res.write('event: message_delta\ndata: ' + JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 50 },
          }) + '\n\n');
          res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
          res.end();
        } else {
          const resp = {
            id: 'msg_nonstream',
            type: 'message',
            role: 'assistant',
            model: parsed.model,
            content: [{ type: 'text', text: 'hello' }],
            usage,
          };
          const raw = JSON.stringify(resp);
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)) });
          res.end(raw);
        }
        return;
      }

      if (req.url === '/v1/responses' || req.url === '/responses') {
        const usage = {
          prompt_tokens: 130, // input(100) + cacheRead(20) + cacheWrite(10)
          completion_tokens: 50,
          prompt_tokens_details: {
            cached_tokens: 20,
            cache_write_tokens: 10,
          },
        };
        const resp = {
          id: 'resp_nonstream',
          object: 'response',
          status: 'completed',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'responses nonstream ok' }] }],
          usage,
        };
        const raw = JSON.stringify(resp);
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)) });
        res.end(raw);
        return;
      }

      res.writeHead(404).end();
    });
  });

  const upstreamPort = await listen(upstream);

  // 初始配置：
  // model-x: input=10, output=20, cacheRead=2, cacheWrite=5
  // provider-anthropic: 默认 1.0 倍率
  // provider-openai: multiplier=2.0 (clientProfile='codex', apiType='openai')
  const initialConfig = {
    clientToken: CLIENT_TOKEN,
    pricing: {
      'model-x': { input: 10, output: 20, cacheRead: 2, cacheWrite: 5 },
    },
    providers: [
      {
        name: 'provider-anthropic',
        apiType: 'anthropic',
        baseUrl: `http://127.0.0.1:${upstreamPort}`,
        apiKey: 'key-a',
      },
      {
        name: 'provider-openai',
        apiType: 'openai',
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        apiKey: 'key-b',
        clientProfile: 'codex',
        priceMultipliers: {
          'model-x': { input: 2.0, output: 2.0, cacheRead: 2.0, cacheWrite: 2.0 },
        },
      },
    ],
    routes: {
      'route-anthropic': { provider: 'provider-anthropic', model: 'model-x' },
      'route-openai': { provider: 'provider-openai', model: 'model-x' },
    },
  };

  await writeFile(configPath, JSON.stringify(initialConfig, null, 2));

  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      GATEWAY_CONFIG: configPath,
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: '0',
      GATEWAY_USAGE_DIR: ledgerDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let logs = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });

  const cleanup = async () => {
    requestAHangResolver?.();
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  };
  t.after(cleanup);

  for (let i = 0; i < 100 && !/http:\/\/127\.0\.0\.1:\d+/.test(logs); i++) {
    await wait(25);
  }
  const base = /http:\/\/127\.0\.0\.1:\d+/.exec(logs)?.[0];
  assert.ok(base, `网关未成功启动，日志: ${logs}`);

  const controlFile = pricingControlPath(configPath);
  for (let i = 0; i < 50; i++) {
    try {
      await readFile(controlFile, 'utf8');
      break;
    } catch {
      await wait(30);
    }
  }

  // 1. 发起请求 A (in-flight-A，流式 /v1/messages)，挂起在上游
  const reqAPromise = fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${CLIENT_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'route-anthropic',
      stream: true,
      messages: [{ role: 'user', content: 'in-flight-A message' }],
      max_tokens: 100,
    }),
  }).then(async (res) => {
    assert.equal(res.status, 200);
    return res.text();
  });

  // 确保请求 A 进入网关 inflight 状态
  let aInflight = false;
  for (let i = 0; i < 50; i++) {
    const usageRes = await fetch(`${base}/v1/usage`, {
      headers: { authorization: `Bearer ${CLIENT_TOKEN}` },
    });
    const usageData = await usageRes.json();
    if (usageData.inflight?.length > 0) {
      aInflight = true;
      break;
    }
    await wait(30);
  }
  assert.ok(aInflight, '请求 A 未能及时进入网关在途状态');

  const healthBefore = await (await fetch(`${base}/health`)).json();
  const pricingStatusBefore = await (await fetch(`${base}/v1/pricing-status`, {
    headers: { authorization: `Bearer ${CLIENT_TOKEN}` },
  })).json();

  assert.equal(pricingStatusBefore.restartRequired, false);

  // 2. 更新配置文件中的倍率与基础价格：
  // model-x: input 10 -> 20 (base price changed)
  // provider-anthropic: 增加倍率 3.0
  const updatedConfig = JSON.parse(JSON.stringify(initialConfig));
  updatedConfig.pricing['model-x'].input = 20;
  updatedConfig.providers[0].priceMultipliers = {
    'model-x': { input: 3.0, output: 3.0, cacheRead: 3.0, cacheWrite: 3.0 },
  };

  await writeFile(configPath, JSON.stringify(updatedConfig, null, 2));

  // 3. 测试鉴权失败：普通客户端 token 访问 POST /v1/reload-pricing 返回 403
  const unauthorizedReload = await fetch(`${base}/v1/reload-pricing`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${CLIENT_TOKEN}`,
      'x-gateway-pricing-token': 'wrong-or-client-token',
    },
    body: JSON.stringify({}),
  });
  assert.equal(unauthorizedReload.status, 403);

  // 4. 测试版本冲突：expectedRevision 传入错误 hash 返回 409
  const fakeRevision = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  await assert.rejects(
    () => reloadGatewayPricing({ configPath, expectedRevision: fakeRevision }),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, 'REVISION_CONFLICT');
      return true;
    }
  );

  // 5. 正确重载计价
  const reloadResult = await reloadGatewayPricing({ configPath });
  assert.equal(reloadResult.reloadApplied, true);

  const healthAfter = await (await fetch(`${base}/health`)).json();
  assert.equal(healthAfter.pid, healthBefore.pid);
  assert.equal(healthAfter.instanceId, healthBefore.instanceId);

  // 6. 发起请求 B (原生 /v1/responses 接口，附带 CODEX_HEADERS，验证 provider 隔离与 responses 计价)
  const resB = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: {
      ...CODEX_HEADERS,
      authorization: `Bearer ${CLIENT_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'route-openai',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'request B responses' }] }],
    }),
  });
  assert.equal(resB.status, 200);
  await resB.text();

  // 7. 发起请求 C (同 provider-anthropic，验证改价后新请求生效 3x 倍率与新基础单价 20)
  const resC = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${CLIENT_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'route-anthropic',
      messages: [{ role: 'user', content: 'request C' }],
      max_tokens: 100,
    }),
  });
  assert.equal(resC.status, 200);
  await resC.text();

  // 8. 释放请求 A 的 upstream 挂起
  requestAHangResolver();
  await reqAPromise;

  // 9. 校验账本中的快照、unitPrice 以及版本隔离
  const ledgerContent = await readFile(ledgerFile(ledgerDir), 'utf8');
  const records = ledgerContent.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(records.length, 3, '账本中应有请求 A、B、C 三条记录');

  const recA = records.find((r) => r.provider === 'provider-anthropic' && r.unitPrice?.input === 10);
  const recB = records.find((r) => r.provider === 'provider-openai');
  const recC = records.find((r) => r.provider === 'provider-anthropic' && r.unitPrice?.input === 20);

  assert.ok(recA, '应存在未重载前捕获的请求 A 记录');
  assert.ok(recB, '应存在 provider-openai 的请求 B 记录');
  assert.ok(recC, '应存在重载后新捕获的请求 C 记录');

  // 请求 A: 初始计价 model-x (input=10, output=20, cacheRead=2, cacheWrite=5), 默认倍率 1.0 (省略或全1)
  // usage: input=100, output=50, cacheRead=20, cacheWrite=10
  // baseCost: (100*10 + 50*20 + 20*2 + 10*5)/1e6 = 2090/1e6 = 0.00209
  // costUsd: 0.00209
  assert.equal(recA.unitPrice.input, 10);
  assert.equal(recA.priceMultiplier?.input ?? 1, 1.0);
  assert.ok(Math.abs(recA.baseCostUsd - 0.00209) < 1e-9);
  assert.ok(Math.abs(recA.costUsd - 0.00209) < 1e-9);
  assert.equal(recA.pricingRevision, pricingStatusBefore.pricingRevision);

  // 请求 B: provider-openai, multiplier=2.0 (未修改), 新基础单价 input=20
  // usage: input=100, output=50, cacheRead=20, cacheWrite=10
  // baseCost: (100*20 + 50*20 + 20*2 + 10*5)/1e6 = 3090/1e6 = 0.00309
  // costUsd: 3090 * 2 / 1e6 = 0.00618
  assert.equal(recB.unitPrice.input, 20);
  assert.equal(recB.priceMultiplier?.input, 2.0);
  assert.ok(Math.abs(recB.baseCostUsd - 0.00309) < 1e-9);
  assert.ok(Math.abs(recB.costUsd - 0.00618) < 1e-9);
  assert.notEqual(recB.pricingRevision, recA.pricingRevision);

  // 请求 C: provider-anthropic, 新倍率 3.0, 新基础单价 input=20
  // baseCost: 0.00309
  // costUsd: 0.00309 * 3 = 0.00927
  assert.equal(recC.unitPrice.input, 20);
  assert.equal(recC.priceMultiplier?.input, 3.0);
  assert.ok(Math.abs(recC.baseCostUsd - 0.00309) < 1e-9);
  assert.ok(Math.abs(recC.costUsd - 0.00927) < 1e-9);
  assert.equal(recC.pricingRevision, recB.pricingRevision);
});
