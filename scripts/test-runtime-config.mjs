import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reloadGatewayPricing } from '../src/runtime-pricing.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

test('端到端回归：网关全量配置热更新（路由、新增/删除provider、默认路由、模型映射、token变更、在途请求隔离与无效配置回退）', { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rt-config-e2e-'));
  const configPath = join(dir, 'providers.json');
  const ledgerDir = join(dir, 'logs');

  let requestAHangResolver;
  const requestAHangPromise = new Promise((resolve) => {
    requestAHangResolver = resolve;
  });

  const upstreamRequests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    let parsedBody;
    try { parsedBody = JSON.parse(rawBody); } catch {}

    const record = {
      path: req.url,
      method: req.method,
      headers: req.headers,
      body: parsedBody,
      time: Date.now(),
    };
    upstreamRequests.push(record);

    if (parsedBody?.messages?.[0]?.content === 'hang-in-flight') {
      await requestAHangPromise;
    }

    if (req.url === '/v1/messages') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_' + Date.now(),
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'response from upstream' }],
        model: parsedBody?.model || 'test-model',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 20 },
      }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  const upstreamPort = await listen(upstream);
  const upstreamBase = 'http://127.0.0.1:' + upstreamPort;

  const initialToken = 'client-token-v1';
  const initialConfig = {
    clientToken: initialToken,
    logRequests: true,
    defaultRoute: 'provider-initial',
    pricing: {
      'test-model': { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
    },
    routes: {
      'custom-route-a': 'provider-initial',
      'mapped-route': { provider: 'provider-initial', model: 'internal-v1' },
    },
    providers: [
      {
        name: 'provider-initial',
        apiType: 'anthropic',
        baseUrl: upstreamBase,
        apiKey: 'key-initial-v1',
        models: {
          'alias-m1': 'real-m1-v1',
        },
      },
      {
        name: 'provider-to-remove',
        apiType: 'anthropic',
        baseUrl: upstreamBase,
        apiKey: 'key-to-remove',
        models: {},
      },
    ],
  };

  await writeFile(configPath, JSON.stringify(initialConfig, null, 2));

  const child = spawn(process.execPath, [join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      GATEWAY_CONFIG: configPath,
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: '0',
      GATEWAY_USAGE_DIR: ledgerDir,
      NODE_ENV: 'test',
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
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(dir, { recursive: true, force: true });
  };
  t.after(cleanup);

  for (let i = 0; i < 100 && !/http:\/\/127\.0\.0\.1:\d+/.test(logs); i++) {
    await wait(25);
  }
  const gatewayBase = /http:\/\/127\.0\.0\.1:\d+/.exec(logs)?.[0];
  assert.ok(gatewayBase, '网关子进程应当在超时内启动并打印监听端口，日志: ' + logs);

  const health1 = await (await fetch(gatewayBase + '/health')).json();
  assert.equal(health1.status, 'ok');
  const pid = health1.pid;
  assert.equal(typeof pid, 'number');

  // 1. 发起在途请求 A（访问 provider-to-remove），该请求在上游挂起等待
  let reqAFinished = false;
  const reqAPromise = fetch(gatewayBase + '/v1/messages', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + initialToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'provider-to-remove',
      messages: [{ role: 'user', content: 'hang-in-flight' }],
      max_tokens: 50,
    }),
  }).then(async (res) => {
    reqAFinished = true;
    return { status: res.status, body: await res.json() };
  });

  // 等待请求 A 到达上游并处于挂起状态
  for (let i = 0; i < 50; i++) {
    if (upstreamRequests.length > 0) break;
    await wait(30);
  }
  assert.equal(upstreamRequests.length, 1, '请求 A 应已到达上游并在等待中，当前日志: ' + logs);
  assert.equal(reqAFinished, false, '请求 A 不应提前完成');

  // 2. 准备更新后的全量配置：
  // - 变更 clientToken 为 client-token-v2
  // - 变更 provider-initial 的 apiKey 为 key-initial-v2
  // - 变更 defaultRoute 为 provider-added
  // - 变更 models 映射：alias-m1 -> real-m1-v2
  // - 新增 routes: custom-route-b -> provider-added
  // - 删除 routes: custom-route-a
  // - 变更 mapped-route: model 改为 internal-v2
  // - 新增 provider-added
  // - 删除 provider-to-remove
  // - 调整基础 pricing
  const newToken = 'client-token-v2';
  const updatedConfig = {
    clientToken: newToken,
    logRequests: true,
    defaultRoute: 'provider-added',
    pricing: {
      'test-model': { input: 10, output: 20, cacheRead: 1, cacheWrite: 5 },
    },
    routes: {
      'custom-route-b': 'provider-added',
      'mapped-route': { provider: 'provider-initial', model: 'internal-v2' },
    },
    providers: [
      {
        name: 'provider-initial',
        apiType: 'anthropic',
        baseUrl: upstreamBase,
        apiKey: 'key-initial-v2',
        models: {
          'alias-m1': 'real-m1-v2',
        },
      },
      {
        name: 'provider-added',
        apiType: 'anthropic',
        baseUrl: upstreamBase,
        apiKey: 'key-added-v1',
        models: {},
      },
    ],
  };

  await writeFile(configPath, JSON.stringify(updatedConfig, null, 2));

  // 3. 调用 reloadGatewayPricing 热重载配置
  const reloadResult = await reloadGatewayPricing({ configPath });
  assert.equal(reloadResult.reloadApplied, true, 'reloadApplied 必须为 true');
  assert.equal(reloadResult.restartRequired, false, '全量热更新后 restartRequired 必须为 false');

  // 验证 PID 不变，服务持续可用
  const health2 = await (await fetch(gatewayBase + '/health')).json();
  assert.equal(health2.pid, pid, '热重载后网关进程 PID 必须保持不变');

  // 4. 验证 clientToken 即时变更生效
  // 旧 token 访问应返回 401
  const resOldToken = await fetch(gatewayBase + '/v1/messages', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + initialToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'custom-route-b',
      messages: [{ role: 'user', content: 'test token' }],
      max_tokens: 50,
    }),
  });
  assert.equal(resOldToken.status, 401, '旧 clientToken 应立即失效返回 401');

  // 新 token 访问有效
  const resNewToken = await fetch(gatewayBase + '/v1/messages', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + newToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'custom-route-b',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 50,
    }),
  });
  assert.equal(resNewToken.status, 200, '新 clientToken 应立即生效');

  // 5. 验证路由即时变更与新增 provider
  // custom-route-b 应该转发给 provider-added，且附带 key-added-v1
  const reqB = upstreamRequests[upstreamRequests.length - 1];
  assert.equal(reqB.headers['authorization'], 'Bearer key-added-v1', '新增 provider 凭据及路由应即时生效');

  // 验证 custom-route-a（已被移除）按 defaultRoute (provider-added) 处理
  await fetch(gatewayBase + '/v1/messages', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + newToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'custom-route-a',
      messages: [{ role: 'user', content: 'fallback default' }],
      max_tokens: 50,
    }),
  });
  const reqFallback = upstreamRequests[upstreamRequests.length - 1];
  assert.equal(reqFallback.headers['authorization'], 'Bearer key-added-v1', '未定义/已删除路由应回退到新的默认路由');

  // 6. 验证模型映射与 API key 变更
  // mapped-route model 变成了 internal-v2，provider-initial 的 apiKey 变成了 key-initial-v2
  await fetch(gatewayBase + '/v1/messages', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + newToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'mapped-route',
      messages: [{ role: 'user', content: 'test mapped route' }],
      max_tokens: 50,
    }),
  });
  const reqMapped = upstreamRequests[upstreamRequests.length - 1];
  assert.equal(reqMapped.body.model, 'internal-v2', '路由模型映射应即时更新为 internal-v2');
  assert.equal(reqMapped.headers['authorization'], 'Bearer key-initial-v2', 'provider apiKey 应即时更新');

  // alias-m1 变成了 real-m1-v2
  await fetch(gatewayBase + '/v1/messages', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + newToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'alias-m1',
      messages: [{ role: 'user', content: 'test alias' }],
      max_tokens: 50,
    }),
  });
  const reqAlias = upstreamRequests[upstreamRequests.length - 1];
  assert.equal(reqAlias.body.model, 'real-m1-v2', 'provider.models 别名映射应即时更新为 real-m1-v2');

  // 7. 释放请求 A 并验证在途请求正常结束（基于请求开始时快照运行，不受热重载影响）
  assert.equal(reqAFinished, false, '请求 A 在重载及后续多次请求后仍应在途挂起');
  requestAHangResolver();
  const resA = await reqAPromise;
  assert.equal(resA.status, 200, '挂起的在途请求 A 应当在释放后成功完成响应');

  // 8. 验证无效配置重载失败（有效 providers/pricing 但 routes 引用不存在的 provider，同时改动 pricing）
  // 覆盖 prepareConfig 的全量校验，验证重载失败后 pricing-status 的 revision 与 pricingRevision 保持不变
  const pricingStatusBeforeFailed = await (await fetch(gatewayBase + '/v1/pricing-status', {
    headers: { authorization: 'Bearer ' + newToken },
  })).json();

  const invalidConfigWithBadRoute = {
    ...updatedConfig,
    pricing: {
      'test-model': { input: 999, output: 999, cacheRead: 999, cacheWrite: 999 },
    },
    routes: {
      'broken-route': 'non-existent-provider',
    },
  };
  await writeFile(configPath, JSON.stringify(invalidConfigWithBadRoute, null, 2));

  await assert.rejects(
    () => reloadGatewayPricing({ configPath }),
    (err) => {
      assert.ok(err, '非法路由配置应触发重载失败抛错');
      return true;
    }
  );

  const pricingStatusAfterFailed = await (await fetch(gatewayBase + '/v1/pricing-status', {
    headers: { authorization: 'Bearer ' + newToken },
  })).json();

  assert.equal(pricingStatusAfterFailed.revision, pricingStatusBeforeFailed.revision, '配置校验失败后 revision 必须保持不变');
  assert.equal(pricingStatusAfterFailed.pricingRevision, pricingStatusBeforeFailed.pricingRevision, '配置校验失败后 pricingRevision 必须保持不变');

  // 验证旧配置（newToken）仍能正常鉴权和提供服务
  const resAfterFailedReload = await fetch(gatewayBase + '/v1/messages', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + newToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'custom-route-b',
      messages: [{ role: 'user', content: 'still alive' }],
      max_tokens: 50,
    }),
  });
  assert.equal(resAfterFailedReload.status, 200, '重载失败后应保留旧配置继续正常工作');

  const health3 = await (await fetch(gatewayBase + '/health')).json();
  assert.equal(health3.pid, pid, '重载失败后 PID 保持不变');
});