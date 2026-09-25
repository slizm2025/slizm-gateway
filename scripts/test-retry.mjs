// 端到端验证退避重试：起一个"前 2 次返回 429"的假上游 + 一个指向它的网关实例，
// 然后发一个请求，检查——
//   1. 最终是否拿到 200（说明重试成功）
//   2. 总耗时是否 >= 上游要求的 retry-after 总和（说明真的等了，而不是立即重试）
//   3. 网关日志里是否出现 2 条 "↻ … 后第 N 次重试"
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MOCK_PORT = 4198;
const GW_PORT = 4102;
const FAIL_TIMES = 2;
const RETRY_AFTER = 1; // 秒
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const dir = mkdtempSync(join(tmpdir(), 'gw-retry-'));
const cfgPath = join(dir, 'providers.json');
writeFileSync(
  cfgPath,
  JSON.stringify({
    clientToken: 'sk-retry-test',
    defaultRoute: 'mock',
    providers: [
      { name: 'mock', apiType: 'openai', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'sk-mock-not-a-real-key', authStyle: 'bearer', maxConcurrency: 4, maxAttempts: 5 },
    ],
    routes: { scout: { provider: 'mock', model: 'mock-model' } },
  }),
  'utf8',
);

const logs = [];
const mock = spawn(process.execPath, [join(ROOT, 'scripts', 'mock-upstream.mjs'), String(MOCK_PORT), String(FAIL_TIMES), String(RETRY_AFTER)], { stdio: ['ignore', 'pipe', 'pipe'] });
mock.stderr.on('data', (d) => process.stderr.write(d));

const gw = spawn(process.execPath, [join(ROOT, 'src', 'server.js')], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GATEWAY_CONFIG: cfgPath, GATEWAY_PORT: String(GW_PORT), GATEWAY_HOST: '127.0.0.1' },
});
gw.stdout.on('data', (d) => logs.push(String(d)));
gw.stderr.on('data', (d) => logs.push(String(d)));

await new Promise((r) => setTimeout(r, 1500));

console.log('═'.repeat(72));
console.log(`  退避重试验证：上游前 ${FAIL_TIMES} 次返回 429 (retry-after=${RETRY_AFTER}s)`);
console.log('═'.repeat(72));

const t0 = Date.now();
let status = 0;
let text = '';
try {
  const res = await fetch(`http://127.0.0.1:${GW_PORT}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-retry-test', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'scout', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] }),
    signal: AbortSignal.timeout(60_000),
  });
  status = res.status;
  text = (await res.text()).slice(0, 160);
} catch (e) {
  text = `${e.name}: ${e.message}`;
}
const elapsed = Date.now() - t0;

await new Promise((r) => setTimeout(r, 400));
mock.kill();
gw.kill();

const all = logs.join('');
const isRetryLine = (l) => l.includes(' ↻ ') && l.includes('次重试');
const retryLines = all.split('\n').filter(isRetryLine).length;
const expectedMinWait = FAIL_TIMES * RETRY_AFTER * 1000;

console.log(`\n  最终状态: HTTP ${status}`);
console.log(`  响应: ${text.replace(/\s+/g, ' ')}`);
console.log(`  总耗时: ${elapsed}ms（上游要求至少等 ${expectedMinWait}ms）`);
console.log(`  网关重试日志条数: ${retryLines}（期望 ${FAIL_TIMES}）`);

console.log('\n  ── 判定 ──');
const checks = [
  ['最终拿到 200', status === 200],
  [`耗时不小于 ${expectedMinWait}ms（真的按 retry-after 等了）`, elapsed >= expectedMinWait],
  [`重试了 ${FAIL_TIMES} 次`, retryLines === FAIL_TIMES],
];
for (const [label, pass] of checks) console.log(`  ${pass ? '✓' : '✗'} ${label}`);
const allPass = checks.every(([, p]) => p);

if (retryLines) {
  console.log('\n  ── 网关重试日志 ──');
  for (const line of all.split('\n').filter(isRetryLine)) console.log('  ' + line.trim());
}
console.log(`\n  ${allPass ? '✓ 退避重试工作正常' : '✗ 退避重试有问题'}`);
process.exit(allPass ? 0 : 1);
