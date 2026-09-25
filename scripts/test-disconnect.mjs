// 端到端验证"中转扣了费、Claude Code 却收不到"的几条修复：
//   1. 上游中途断流不再拖垮网关，同时进行的其他请求照常完成；
//   2. Claude Code 断开（流式途中 / 等响应头期间）时立即取消上游请求；
//   3. 请求送达上游后才出的网络错误不重试（避免重复计费），连接阶段的失败仍会重试。
// 起一个假上游 + 一个指向它的临时网关，全部在本机，不碰真实上游、不花钱。
import http from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const UP_PORT = 4997;
const DEAD_PORT = 4996; // 没有进程监听：模拟连接被拒
const GW_PORT = 4102;
const TOKEN = 'sk-disconnect-test';
const GW = `http://127.0.0.1:${GW_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 假上游：按请求体里的 model 决定行为 ──
const hits = {};
const closedEarly = {}; // model -> 上游连接在响应完成前被关闭的时刻
const upstream = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let model = '';
    try {
      model = JSON.parse(raw).model;
    } catch {
      /* 忽略 */
    }
    hits[model] = (hits[model] ?? 0) + 1;
    let finished = false;
    res.on('close', () => {
      if (!finished) closedEarly[model] = Date.now();
    });

    if (model === 'reset') return req.socket.destroy(); // 收下请求后直接断开，不给响应
    if (model === 'hang') return; // 迟迟不回响应头（模拟 any 要等 4~5 分钟）

    if (req.url.endsWith('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const t = setInterval(() => {
        res.write(`data: ${JSON.stringify({ id: 'c', choices: [{ index: 0, delta: { content: '字' } }] })}\n\n`);
      }, 150);
      res.on('close', () => clearInterval(t));
      return;
    }

    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    sse('message_start', {
      type: 'message_start',
      message: { id: 'msg', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } },
    });
    if (model === 'drop') return setTimeout(() => req.socket.destroy(), 100); // 流到一半断开
    const total = model === 'steady' ? 12 : 1000; // steady 约 1.8 秒后正常结束；slow 一直流
    let i = 0;
    const t = setInterval(() => {
      if (++i >= total) {
        clearInterval(t);
        sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
        sse('message_stop', { type: 'message_stop' });
        finished = true;
        res.end();
        return;
      }
      sse('ping', { type: 'ping' });
    }, 150);
    res.on('close', () => clearInterval(t));
  });
});
await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r));

// ── 临时网关 ──
const dir = mkdtempSync(join(tmpdir(), 'gw-disconnect-'));
const cfgFile = join(dir, 'providers.json');
writeFileSync(
  cfgFile,
  JSON.stringify({
    clientToken: TOKEN,
    providers: [
      { name: 'anth', apiType: 'anthropic', baseUrl: `http://127.0.0.1:${UP_PORT}`, apiKey: 'sk-fake', maxConcurrency: 8, maxAttempts: 3 },
      { name: 'oai', apiType: 'openai', baseUrl: `http://127.0.0.1:${UP_PORT}`, apiKey: 'sk-fake', authStyle: 'bearer', maxConcurrency: 8, maxAttempts: 3 },
      { name: 'dead', apiType: 'anthropic', baseUrl: `http://127.0.0.1:${DEAD_PORT}`, apiKey: 'sk-fake', maxAttempts: 2 },
    ],
    routes: {
      steady: { provider: 'anth', model: 'steady' },
      drop: { provider: 'anth', model: 'drop' },
      slow: { provider: 'anth', model: 'slow' },
      hang: { provider: 'anth', model: 'hang' },
      reset: { provider: 'anth', model: 'reset' },
      'oai-slow': { provider: 'oai', model: 'oai-slow' },
      refused: { provider: 'dead', model: 'refused' },
    },
  }),
);

const gw = spawn(process.execPath, [join(ROOT, 'src', 'server.js')], {
  cwd: ROOT,
  env: { ...process.env, GATEWAY_CONFIG: cfgFile, GATEWAY_PORT: String(GW_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let gwOut = '';
let gwErr = '';
let exited = false;
gw.stdout.on('data', (d) => (gwOut += d));
gw.stderr.on('data', (d) => (gwErr += d));
gw.on('exit', () => (exited = true));

function cleanup() {
  gw.kill();
  upstream.closeAllConnections();
  upstream.close();
  rmSync(dir, { recursive: true, force: true });
}

let ready = false;
for (let i = 0; i < 40 && !ready; i++) {
  await sleep(250);
  try {
    ready = (await fetch(`${GW}/health`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    /* 还没起来 */
  }
}
if (!ready) {
  console.log('✗ 测试网关没能启动');
  console.log((gwOut + gwErr).slice(-800));
  cleanup();
  process.exit(1);
}

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}  ${extra}`);
  }
};

const HEADERS = {
  'content-type': 'application/json',
  authorization: `Bearer ${TOKEN}`,
  'anthropic-version': '2023-06-01',
  'user-agent': 'claude-cli/test (external, cli)',
};
const post = (model, signal) =>
  fetch(`${GW}/v1/messages`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ model, max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    signal,
  });

/** 发起流式请求，收到第一段数据后断开，返回断开时刻 */
async function disconnectAfterFirstChunk(model) {
  const ac = new AbortController();
  const res = await post(model, ac.signal);
  await res.body.getReader().read();
  const t = Date.now();
  ac.abort();
  return t;
}

console.log('─'.repeat(70));
console.log('  1. 上游中途断流：网关不崩，其他请求不受牵连');
console.log('─'.repeat(70));
{
  const steady = post('steady', AbortSignal.timeout(10_000)).then((r) => r.text());
  await sleep(200);
  const t0 = Date.now();
  let outcome = 'completed';
  try {
    await (await post('drop', AbortSignal.timeout(8000))).text();
  } catch (e) {
    outcome = `${e.name}: ${e.cause?.code ?? e.message}`;
  }
  const ms = Date.now() - t0;
  let steadyText = '';
  try {
    steadyText = await steady;
  } catch (e) {
    steadyText = `ERR ${e.message}`;
  }
  check('断流的请求：客户端立即收到连接中断，不会挂起', ms < 5000 && outcome !== 'completed', `ms=${ms} ${outcome}`);
  check('同时进行的另一个流照常跑完（没被一起切断）', steadyText.includes('message_stop'), steadyText.slice(-80));
  check('网关进程没有崩溃', !exited && !gwErr.includes('ERR_HTTP_HEADERS_SENT'), gwErr.slice(0, 200));
  check('断流的请求没有被重试（上游只收到 1 次）', hits.drop === 1, `hits=${hits.drop}`);
  const after = await (await post('steady', AbortSignal.timeout(10_000))).text();
  check('之后的新请求正常完成', after.includes('message_stop'), after.slice(-80));
}

console.log('─'.repeat(70));
console.log('  2. Claude Code 断开：立即取消上游，不让它继续生成计费');
console.log('─'.repeat(70));
{
  const tAbort = await disconnectAfterFirstChunk('slow');
  await sleep(1500);
  const ms = closedEarly.slow ? closedEarly.slow - tAbort : Infinity;
  check('流式途中断开 → 1.5 秒内取消上游', ms < 1500, `ms=${ms}`);
}
{
  const ac = new AbortController();
  const pending = post('hang', ac.signal).catch(() => {});
  await sleep(500);
  const tAbort = Date.now();
  ac.abort();
  await pending;
  await sleep(1500);
  const ms = closedEarly.hang ? closedEarly.hang - tAbort : Infinity;
  check('等响应头期间断开（any 慢响应场景）→ 1.5 秒内取消上游', ms < 1500, `ms=${ms}`);
}
{
  const tAbort = await disconnectAfterFirstChunk('oai-slow');
  await sleep(1500);
  const ms = closedEarly['oai-slow'] ? closedEarly['oai-slow'] - tAbort : Infinity;
  check('openai 格式路径断开 → 1.5 秒内取消上游', ms < 1500, `ms=${ms}`);
}
const goneLines = gwOut.split(/\r?\n/).filter((l) => l.includes('客户端已断开'));
check('网关日志记录了这 3 次"客户端已断开"', goneLines.length >= 3, `len=${goneLines.length}`);

console.log('─'.repeat(70));
console.log('  3. 重试只在确定没送达上游时进行');
console.log('─'.repeat(70));
{
  const res = await post('reset', AbortSignal.timeout(8000));
  const text = await res.text();
  check('请求送达后连接被重置 → 如实返回 502', res.status === 502, `status=${res.status} ${text.slice(0, 120)}`);
  check('没有重试（上游只收到 1 次，不会重复计费）', hits.reset === 1, `hits=${hits.reset}`);
}
{
  const res = await post('refused', AbortSignal.timeout(20_000));
  await res.text();
  const lines = gwOut.split(/\r?\n/).filter((l) => l.includes('refused'));
  check('连接被拒（请求根本没发出）→ 会重试', lines.some((l) => l.includes('↻') && l.includes('ECONNREFUSED')), lines.join(' | ').slice(0, 240));
  check('重试用完后返回 502', res.status === 502, `status=${res.status}`);
}

cleanup();
console.log('═'.repeat(70));
console.log(`  结果: ${pass} 通过, ${fail} 失败`);
console.log('═'.repeat(70));
process.exit(fail ? 1 : 0);
