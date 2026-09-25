// 端到端验证：网关真的会在上游 429/503 时退避重试，而不是把错误甩给 Claude Code。
// 起一个假上游（前 N 次返回 429 + retry-after，之后返回 200），
// 再起一个用临时配置指向它的网关，观察最终结果与重试日志。
import http from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TMP = process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, 'tmp') : ROOT;

const UP_PORT = 4998;
const GW_PORT = 4101;
const TOKEN = 'sk-e2e-test-token';

let fakeHits = 0;
const FAKE_FAILS = 2; // 前 2 次回 429，第 3 次成功

const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    fakeHits++;
    if (fakeHits <= FAKE_FAILS) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
      res.end(JSON.stringify({ error: { message: 'All available accounts exhausted', type: 'server_error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-fake',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: '重试成功' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      }),
    );
  });
});

await new Promise((r) => fake.listen(UP_PORT, '127.0.0.1', r));
console.log(`假上游已监听 :${UP_PORT}（前 ${FAKE_FAILS} 次返回 429 + retry-after: 1）`);

const cfgFile = join(TMP, 'e2e-providers.json');
writeFileSync(
  cfgFile,
  JSON.stringify(
    {
      clientToken: TOKEN,
      providers: [
        {
          name: 'fake',
          apiType: 'openai',
          baseUrl: `http://127.0.0.1:${UP_PORT}`,
          apiKey: 'sk-fake',
          authStyle: 'bearer',
          models: {},
          maxConcurrency: 2,
          maxAttempts: 4,
        },
      ],
      routes: { scout: { provider: 'fake', model: 'fake-model' } },
    },
    null,
    2,
  ),
);

const logFile = join(TMP, 'e2e-gateway.log');
const gw = spawn(process.execPath, [join(ROOT, 'src', 'server.js')], {
  cwd: ROOT,
  env: { ...process.env, GATEWAY_CONFIG: cfgFile, GATEWAY_PORT: String(GW_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let gwLog = '';
gw.stdout.on('data', (d) => (gwLog += d));
gw.stderr.on('data', (d) => (gwLog += d));

// 等网关就绪
let ready = false;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 250));
  try {
    const res = await fetch(`http://127.0.0.1:${GW_PORT}/health`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      ready = true;
      break;
    }
  } catch {
    /* 还没起来 */
  }
}

if (!ready) {
  console.log('✗ 测试网关没能启动');
  console.log(gwLog.slice(-800));
  gw.kill();
  fake.close();
  process.exit(1);
}

console.log('测试网关已就绪，发起请求…\n');
const t0 = Date.now();
let result;
try {
  const res = await fetch(`http://127.0.0.1:${GW_PORT}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'scout', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  result = { ok: res.ok, status: res.status, ms: Date.now() - t0, text };
} catch (e) {
  result = { ok: false, status: 0, ms: Date.now() - t0, text: `${e.name}: ${e.message}` };
}

await new Promise((r) => setTimeout(r, 400));
gw.kill();
fake.close();

const retryLines = gwLog.split(/\r?\n/).filter((l) => l.includes(' ↻ ') && l.includes('次重试'));
// 上游错误直传给客户端时会写一行 "✗ <路由> · 上游 <状态码> · …"
const errLines = gwLog.split(/\r?\n/).filter((l) => / ✗ .*· 上游 \d{3} ·/.test(l));

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

console.log('─'.repeat(70));
check(`客户端最终拿到 200（没被 429 甩脸）`, result.ok, `status=${result.status} ${result.text.slice(0, 100)}`);
check(`上游共被打 ${FAKE_FAILS + 1} 次（重试 ${FAKE_FAILS} 次）`, fakeHits === FAKE_FAILS + 1, `hits=${fakeHits}`);
check(`网关日志记录了 ${FAKE_FAILS} 次退避重试`, retryLines.length === FAKE_FAILS, `len=${retryLines.length}`);
check(`没有把 429 直传给客户端`, errLines.length === 0, `${errLines.length} 条上游错误日志`);
check(
  `遵守了 retry-after: 1（总耗时 ≥2s）`,
  result.ms >= 1900,
  `ms=${result.ms}`,
);
console.log('─'.repeat(70));
console.log('重试日志:');
for (const l of retryLines) console.log(`  ${l}`);
console.log('─'.repeat(70));
console.log(`  结果: ${pass} 通过, ${fail} 失败   总耗时 ${result.ms}ms`);
process.exit(fail ? 1 : 0);
