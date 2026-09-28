// 回归测试：全局统一模型定价在多 provider 之间的生效、独立统计以及账本落盘。
// 测试点：
// 1. 同一模型在两个不同 provider 上使用相同的全局定价，产生完全一致的费用。
// 2. 独立按 provider 统计用量与费用（/v1/usage 各 provider 的 token 与 costUsd 相互隔离、独立累计）。
// 3. 全局 fallback：配置了定价的模型计算 costUsd，未配置定价的模型保留 null / unpricedRequests 计数。
// 4. 流式与非流式请求（含 /v1/messages 与 native /v1/responses 路径）端到端计价与 ledger 账本落盘校验。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateCostUsd, normalizePricing } from '../src/pricing.js';
import { ledgerFile } from '../src/usage.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLIENT_TOKEN = 'test-pricing-token';
const CODEX_HEADERS = {
  'user-agent': 'Codex Desktop/0.155.0-alpha.16.4 (Windows; x86_64) dumb (codex_exec; 0.155.0-alpha.16.4)',
  originator: 'Codex Desktop',
  'x-codex-installation-id': 'codex-installation',
  'x-codex-window-id': 'codex-window',
};

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

test('单位测试：全局 pricing 映射及同一模型跨 provider 计算费用一致', () => {
  const globalPricing = normalizePricing({
    'shared-model': { input: 10, cacheRead: 2.5, cacheWrite: 10, output: 30 },
  });

  const usageA = { input: 200, cacheRead: 150, cacheWrite: 0, output: 50 };
  const usageB = { input: 200, cacheRead: 150, cacheWrite: 0, output: 50 };

  const costA = calculateCostUsd(usageA, globalPricing, 'shared-model');
  const costB = calculateCostUsd(usageB, globalPricing, 'shared-model');

  assert.equal(typeof costA, 'number');
  assert.equal(costA, costB);
  // (200 * 10 + 150 * 2.5 + 50 * 30) / 1e6 = (2000 + 375 + 1500) / 1e6 = 3875 / 1e6 = 0.003875
  assert.ok(Math.abs(costA - 0.003875) < 1e-10);

  // 未定价模型返回 null
  assert.equal(calculateCostUsd(usageA, globalPricing, 'unpriced-model'), null);
});

test('端到端：同一模型跨两个 provider 定价一致、各 provider 独立统计、流式与非流式及 responses 账本校验', async (t) => {
  // 假上游统一返回确定性的 usage：
  // Anthropic 语义要求 input=200, cacheRead=150, output=50
  // - Anthropic 上游原生给出 input_tokens: 200, cache_read_input_tokens: 150, output_tokens: 50
  // - Responses / OpenAI 上游 prompt_tokens 为总输入（含缓存），因此 prompt_tokens: 350, cached_tokens: 150，
  //   换算后 input = 350 - 150 = 200, cacheRead = 150, completion_tokens: 50 -> output = 50。
  const upstream = http.createServer((req, res) => {
    let bodyText = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { bodyText += c; });
    req.on('end', () => {
      const parsed = bodyText ? JSON.parse(bodyText) : {};
      const isStream = parsed.stream === true;

      if (req.url === '/v1/responses') {
        const usage = { prompt_tokens: 350, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 150 } };
        if (isStream) {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
          const event1 = { type: 'response.output_item.added', item: { type: 'message', role: 'assistant', content: [] } };
          const event2 = {
            type: 'response.completed',
            response: {
              id: 'resp_1',
              status: 'completed',
              output: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'responses stream ok' }] }],
              usage,
            },
          };
          res.write(`data: ${JSON.stringify(event1)}\n\n`);
          res.write(`data: ${JSON.stringify(event2)}\n\n`);
          res.end('data: [DONE]\n\n');
        } else {
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
        }
        return;
      }

      // /v1/messages 接口上游 (Anthropic API 类型)
      if (isStream) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        send('message_start', {
          type: 'message_start',
          message: {
            id: 'msg_stream',
            type: 'message',
            role: 'assistant',
            model: parsed.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 200, cache_read_input_tokens: 150, cache_creation_input_tokens: 0, output_tokens: 1 },
          },
        });
        send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } });
        send('content_block_stop', { type: 'content_block_stop', index: 0 });
        send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 50 } });
        send('message_stop', { type: 'message_stop' });
        res.end();
      } else {
        const resp = {
          id: 'msg_nonstream',
          type: 'message',
          role: 'assistant',
          model: parsed.model,
          content: [{ type: 'text', text: 'messages nonstream ok' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 200, cache_read_input_tokens: 150, cache_creation_input_tokens: 0, output_tokens: 50 },
        };
        const raw = JSON.stringify(resp);
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)) });
        res.end(raw);
      }
    });
  });

  const upPort = await listen(upstream);
  const tempDir = await mkdtemp(join(tmpdir(), 'gw-pricing-test-'));
  const configPath = join(tempDir, 'providers.json');
  const ledgerDir = join(tempDir, 'ledger');

  // 配置说明：
  // 两个不同的 provider: provider-a (anthropic) 与 provider-b (openai)
  // 映射到同一个 target model: gpt-5
  // 全局定价配置 gpt-5，未配置 unpriced-model
  const configContent = {
    clientToken: CLIENT_TOKEN,
    pricing: {
      'gpt-5': {
        input: 10,
        cacheRead: 2.5,
        cacheWrite: 10,
        output: 30,
      },
    },
    providers: [
      {
        name: 'provider-a',
        apiType: 'anthropic',
        apiKey: 'key-a',
        baseUrl: `http://127.0.0.1:${upPort}`,
      },
      {
        name: 'provider-b',
        apiType: 'openai',
        apiKey: 'key-b',
        baseUrl: `http://127.0.0.1:${upPort}/v1`,
      },
    ],
    routes: {
      'route-a': { provider: 'provider-a', model: 'gpt-5' },
      'route-b': { provider: 'provider-b', model: 'gpt-5' },
      'route-b-resp': { provider: 'provider-b', model: 'gpt-5' },
      'route-unpriced': { provider: 'provider-a', model: 'unpriced-model' },
    },
  };
  await writeFile(configPath, JSON.stringify(configContent));

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
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });

  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  });

  for (let i = 0; i < 100 && !/http:\/\/127\.0\.0\.1:\d+/.test(logs); i++) {
    await wait(25);
  }
  const base = /http:\/\/127\.0\.0\.1:\d+/.exec(logs)?.[0];
  assert.ok(base, `网关未成功启动，日志: ${logs}`);

  const postMessages = async (route, stream = false) => {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CLIENT_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: route,
        messages: [{ role: 'user', content: 'test message' }],
        max_tokens: 100,
        stream,
      }),
    });
    assert.equal(res.status, 200);
    return res.text();
  };

  const postResponses = async (route, stream = false) => {
    const res = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: {
        ...CODEX_HEADERS,
        authorization: `Bearer ${CLIENT_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: route,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'test input' }] }],
        stream,
      }),
    });
    assert.equal(res.status, 200);
    return res.text();
  };

  await postMessages('route-a', false);
  await postMessages('route-a', true);
  await postResponses('route-b-resp', false);
  await postResponses('route-b-resp', true);
  await postMessages('route-unpriced', false);

  // 单次费用: (200*10 + 150*2.5 + 50*30) / 1e6 = 3875 / 1e6 = 0.003875
  const expectedSingleCost = 0.003875;

  const usageRes = await fetch(`${base}/v1/usage`, {
    headers: { authorization: `Bearer ${CLIENT_TOKEN}` },
  });
  assert.equal(usageRes.status, 200);
  const stats = await usageRes.json();

  const provA = stats.providers['provider-a'];
  const provB = stats.providers['provider-b'];
  assert.ok(provA, 'provider-a 统计应存在');
  assert.ok(provB, 'provider-b 统计应存在');

  assert.equal(provA.requests, 3);
  assert.equal(provA.pricedRequests, 2);
  assert.equal(provA.unpricedRequests, 1);
  assert.ok(Math.abs(provA.costUsd - expectedSingleCost * 2) < 1e-8);

  assert.equal(provB.requests, 2);
  assert.equal(provB.pricedRequests, 2);
  assert.equal(provB.unpricedRequests, 0);
  assert.ok(Math.abs(provB.costUsd - expectedSingleCost * 2) < 1e-8);

  assert.equal(stats.totals.requests, 5);
  assert.equal(stats.totals.pricedRequests, 4);
  assert.equal(stats.totals.unpricedRequests, 1);
  assert.ok(Math.abs(stats.totals.costUsd - expectedSingleCost * 4) < 1e-8);

  const ledgerContent = await readFile(ledgerFile(ledgerDir), 'utf8');
  const records = ledgerContent.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(records.length, 5);

  const pricedRecords = records.filter((r) => r.model === 'gpt-5');
  const unpricedRecords = records.filter((r) => r.model === 'unpriced-model');

  assert.equal(pricedRecords.length, 4);
  assert.equal(unpricedRecords.length, 1);

  for (const r of pricedRecords) {
    assert.equal(typeof r.costUsd, 'number');
    assert.ok(Math.abs(r.costUsd - expectedSingleCost) < 1e-8);
  }

  assert.equal(unpricedRecords[0].costUsd, null);
});

test('站点逐项倍率：精确模型优先于 *，baseCostUsd 为原价、costUsd 为倍率后', async () => {
  const previousUsageDir = process.env.GATEWAY_USAGE_DIR;
  process.env.GATEWAY_USAGE_DIR = 'off';
  try {
    const { normalizeMultipliers, resolveMultiplier } = await import('../src/pricing.js');
    const { beginUsage, finishUsage } = await import('../src/usage.js');
    const pricing = normalizePricing({ 'claude-opus-5-5': { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 20 } });
    const multipliers = normalizeMultipliers({
      '*': { input: 2 },
      'claude-opus-5-5': { input: 1.5, output: 0.5, cacheRead: 2 },
    });
    assert.deepEqual(multipliers['*'], { input: 2, cacheRead: 1, cacheWrite: 1, output: 1 });
    assert.deepEqual(resolveMultiplier(multipliers, 'other'), multipliers['*']);
    assert.equal(resolveMultiplier({ '*': { input: 1 } }, 'x'), null, '全为 1 视为原价');
    assert.throws(() => normalizeMultipliers({ m: { input: -1 } }), /大于等于 0/);

    const m = resolveMultiplier(multipliers, 'claude-opus-5-5');
    const entry = beginUsage({ requestId: 't', route: 'r', provider: 'p', model: 'claude-opus-5-5', pricing, priceMultiplier: m });
    const item = finishUsage(entry, { status: 200, usage: { input_tokens: 2, cache_read_input_tokens: 242456, cache_creation_input_tokens: 4822, output_tokens: 355 } });
    assert.ok(Math.abs(item.baseCostUsd - 0.1282004) < 1e-9);
    // 2*4*1.5 + 242456*0.4*2 + 4822*5*1 + 355*20*0.5
    assert.ok(Math.abs(item.costUsd - (12 + 193964.8 + 24110 + 3550) / 1e6) < 1e-9);
    assert.deepEqual(item.priceMultiplier, m);
  assert.deepEqual(item.unitPrice, { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 });
  } finally {
    if (previousUsageDir === undefined) delete process.env.GATEWAY_USAGE_DIR;
    else process.env.GATEWAY_USAGE_DIR = previousUsageDir;
  }
});

test('设置保存：pricing 与 provider.priceMultipliers 落盘，全 1 的倍率行被省略', async () => {
  const { saveSettings, getSanitizedSettings } = await import('../src/admin/settings.js');
  const dir = await mkdtemp(join(tmpdir(), 'gw-mult-settings-'));
  try {
    const configPath = join(dir, 'providers.json');
    await writeFile(configPath, JSON.stringify({
      providers: [{ name: 'a', apiType: 'anthropic', baseUrl: 'https://example.com', apiKey: 'sk-test-aaaaaaaaaaaa' }],
      routes: {},
    }));
    const current = getSanitizedSettings(configPath);
    assert.deepEqual(current.pricing, {});
    assert.deepEqual(current.providers[0].priceMultipliers, {});
    saveSettings({
      ...current,
      pricing: { m1: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } },
      providers: [{ ...current.providers[0], priceMultipliers: { m1: { input: 2, output: 3, cacheRead: 1, cacheWrite: 1 }, '*': { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } } }],
    }, { configPath, backupDir: join(dir, 'bak') });
    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(saved.pricing.m1, { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 2 });
    assert.deepEqual(saved.providers[0].priceMultipliers, { m1: { input: 2, cacheRead: 1, cacheWrite: 1, output: 3 } });
    assert.equal(saved.providers[0].apiKey, 'sk-test-aaaaaaaaaaaa');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('端到端：OpenAI 兼容与 native Responses 显式 cache_write_tokens 账本计费及无细节时不推断写入', async (t) => {
  // 覆盖场景：
  // 1. OpenAI 兼容接口 (/v1/messages -> /chat/completions) 上游显式返回 prompt_tokens_details.cache_write_tokens
  //    总输入 52420，写 52352，输出 13
  //    普通输入 = 52420 - 0 - 52352 = 68，cacheWrite = 52352
  //    单价 input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10, 倍率 0.3
  //    baseCostUsd = (68*2 + 0*0.2 + 52352*2.5 + 13*10) / 1e6 = 131146 / 1e6 = 0.131146
  //    costUsd = 0.131146 * 0.3 = 0.0393438
  // 2. Native Responses 接口 (/v1/responses) 上游显式返回 input_tokens_details.cache_write_tokens
  //    总输入 52420，写 52352，输出 13
  //    换算与账本结果同样精确匹配 0.0393438
  // 3. 上游无写入细节时 (prompt_tokens_details 缺省或没有 cache_write_tokens)，不推断写入 (cacheWriteTokens 为 0)
  const upstream = http.createServer((req, res) => {
    let bodyText = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { bodyText += c; });
    req.on('end', () => {
      const parsed = bodyText ? JSON.parse(bodyText) : {};

      if (req.url === '/v1/responses') {
        const withWrite = parsed.metadata?.write_details === true;
        const usage = withWrite
          ? {
              input_tokens: 52420,
              output_tokens: 13,
              input_tokens_details: {
                cached_tokens: 0,
                cache_write_tokens: 52352,
              },
            }
          : {
              input_tokens: 52420,
              output_tokens: 13,
            };
        const resp = {
          id: 'resp_cache_test',
          object: 'response',
          status: 'completed',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'responses cache ok' }] }],
          usage,
        };
        const raw = JSON.stringify(resp);
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)) });
        res.end(raw);
        return;
      }

      if (req.url === '/v1/chat/completions') {
        const lastMsg = parsed.messages?.[parsed.messages.length - 1]?.content ?? '';
        const withWrite = typeof lastMsg === 'string' && lastMsg.includes('with-write');
        const usage = withWrite
          ? {
              prompt_tokens: 52420,
              completion_tokens: 13,
              total_tokens: 52433,
              prompt_tokens_details: {
                cached_tokens: 0,
                cache_write_tokens: 52352,
              },
            }
          : {
              prompt_tokens: 52420,
              completion_tokens: 13,
              total_tokens: 52433,
            };
        const resp = {
          id: 'chatcmpl_cache_test',
          object: 'chat.completion',
          created: Date.now(),
          model: parsed.model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'chat completions cache ok' },
              finish_reason: 'stop',
            },
          ],
          usage,
        };
        const raw = JSON.stringify(resp);
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)) });
        res.end(raw);
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });

  const upPort = await listen(upstream);
  const tempDir = await mkdtemp(join(tmpdir(), 'gw-cache-write-pricing-test-'));
  const configPath = join(tempDir, 'providers.json');
  const ledgerDir = join(tempDir, 'ledger');

  const configContent = {
    clientToken: CLIENT_TOKEN,
    pricing: {
      'gpt-5': {
        input: 2,
        cacheRead: 0.2,
        cacheWrite: 2.5,
        output: 10,
      },
    },
    providers: [
      {
        name: 'provider-openai-compat',
        apiType: 'openai',
        apiKey: 'key-oai',
        baseUrl: `http://127.0.0.1:${upPort}/v1`,
        priceMultipliers: {
          '*': { input: 0.3, cacheRead: 0.3, cacheWrite: 0.3, output: 0.3 },
        },
      },
      {
        name: 'provider-native-responses',
        apiType: 'openai',
        apiKey: 'key-resp',
        baseUrl: `http://127.0.0.1:${upPort}/v1`,
        priceMultipliers: {
          'gpt-5': { input: 0.3, cacheRead: 0.3, cacheWrite: 0.3, output: 0.3 },
        },
      },
    ],
    routes: {
      'route-compat': { provider: 'provider-openai-compat', model: 'gpt-5' },
      'route-responses': { provider: 'provider-native-responses', model: 'gpt-5' },
    },
  };
  await writeFile(configPath, JSON.stringify(configContent));

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
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });

  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  });

  for (let i = 0; i < 100 && !/http:\/\/127\.0\.0\.1:\d+/.test(logs); i++) {
    await wait(25);
  }
  const base = /http:\/\/127\.0\.0\.1:\d+/.exec(logs)?.[0];
  assert.ok(base, `网关未成功启动，日志: ${logs}`);

  // 1. OpenAI 兼容接口，上游显式返回 prompt_tokens_details.cache_write_tokens
  const resCompatWrite = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${CLIENT_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'route-compat',
      messages: [{ role: 'user', content: 'test with-write message' }],
      max_tokens: 100,
    }),
  });
  assert.equal(resCompatWrite.status, 200);

  // 2. Native Responses 接口，上游显式返回 input_tokens_details.cache_write_tokens
  const resResponsesWrite = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: {
      ...CODEX_HEADERS,
      authorization: `Bearer ${CLIENT_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'route-responses',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'test responses input' }] }],
      metadata: { write_details: true },
    }),
  });
  assert.equal(resResponsesWrite.status, 200);

  // 3. OpenAI 兼容接口，上游无 cache_write 细节
  const resCompatNoWrite = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${CLIENT_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'route-compat',
      messages: [{ role: 'user', content: 'test without-write message' }],
      max_tokens: 100,
    }),
  });
  assert.equal(resCompatNoWrite.status, 200);

  // 4. Native Responses 接口，上游无 cache_write 细节
  const resResponsesNoWrite = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: {
      ...CODEX_HEADERS,
      authorization: `Bearer ${CLIENT_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'route-responses',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'test responses without-write' }] }],
    }),
  });
  assert.equal(resResponsesNoWrite.status, 200);

  // 校验账本落盘记录
  const ledgerContent = await readFile(ledgerFile(ledgerDir), 'utf8');
  const records = ledgerContent.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(records.length, 4);

  const [recCompatWrite, recRespWrite, recCompatNoWrite, recRespNoWrite] = records;

  const EXPECTED_BASE_COST = 0.131146;
  const EXPECTED_COST_USD = 0.0393438;

  // 验证 1: OpenAI 兼容显式写入细节
  assert.equal(recCompatWrite.inputTokens, 68, '普通输入应为 总输入(52420) - 读(0) - 写(52352) = 68');
  assert.equal(recCompatWrite.cacheReadTokens, 0);
  assert.equal(recCompatWrite.cacheWriteTokens, 52352);
  assert.equal(recCompatWrite.outputTokens, 13);
  assert.ok(Math.abs(recCompatWrite.baseCostUsd - EXPECTED_BASE_COST) < 1e-9);
  assert.ok(Math.abs(recCompatWrite.costUsd - EXPECTED_COST_USD) < 1e-9);

  // 验证 2: Native Responses 显式写入细节
  assert.equal(recRespWrite.inputTokens, 68, '普通输入应为 总输入(52420) - 读(0) - 写(52352) = 68');
  assert.equal(recRespWrite.cacheReadTokens, 0);
  assert.equal(recRespWrite.cacheWriteTokens, 52352);
  assert.equal(recRespWrite.outputTokens, 13);
  assert.ok(Math.abs(recRespWrite.baseCostUsd - EXPECTED_BASE_COST) < 1e-9);
  assert.ok(Math.abs(recRespWrite.costUsd - EXPECTED_COST_USD) < 1e-9);

  // 验证 3 & 4: 无写入细节时不推断写入
  assert.equal(recCompatNoWrite.inputTokens, 52420, '无写入细节时，总输入全作为普通输入');
  assert.equal(recCompatNoWrite.cacheReadTokens, 0);
  assert.equal(recCompatNoWrite.cacheWriteTokens, 0, '无写入细节时不应推断写入');
  assert.equal(recCompatNoWrite.outputTokens, 13);
  // (52420 * 2 + 13 * 10) / 1e6 = (104840 + 130) / 1e6 = 0.10497
  // costUsd = 0.10497 * 0.3 = 0.031491
  assert.ok(Math.abs(recCompatNoWrite.baseCostUsd - 0.10497) < 1e-9);
  assert.ok(Math.abs(recCompatNoWrite.costUsd - 0.031491) < 1e-9);

  assert.equal(recRespNoWrite.inputTokens, 52420, '无写入细节时，总输入全作为普通输入');
  assert.equal(recRespNoWrite.cacheReadTokens, 0);
  assert.equal(recRespNoWrite.cacheWriteTokens, 0, '无写入细节时不应推断写入');
  assert.equal(recRespNoWrite.outputTokens, 13);
  assert.ok(Math.abs(recRespNoWrite.baseCostUsd - 0.10497) < 1e-9);
  assert.ok(Math.abs(recRespNoWrite.costUsd - 0.031491) < 1e-9);
});
