// 验证 limiter：并发闸门 + 429/503 退避重试。
// 用假上游注入故障，不碰真实网络。
import { withUpstream, retryDelayMs, isRetryableStatus, gateStats } from '../src/limiter.js';

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

const mkRes = (status, { retryAfter, body = '{}' } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? (retryAfter ?? null) : null) },
  text: async () => body,
});

console.log('─'.repeat(70));
console.log('  1. isRetryableStatus');
console.log('─'.repeat(70));
check('429 可重试', isRetryableStatus(429));
check('503 可重试', isRetryableStatus(503));
check('529 可重试', isRetryableStatus(529));
check('502/504 不重试（上游可能已在生成，重试会重复计费）', !isRetryableStatus(502) && !isRetryableStatus(504));
check('401 不重试', !isRetryableStatus(401));
check('400 不重试', !isRetryableStatus(400));

console.log('─'.repeat(70));
console.log('  2. retryDelayMs 尊重上游 retry-after');
console.log('─'.repeat(70));
check('retry-after: 2 → 2250ms', retryDelayMs(mkRes(429, { retryAfter: '2' }), 1) === 2250, String(retryDelayMs(mkRes(429, { retryAfter: '2' }), 1)));
check('retry-after 不缩短上游冷却期', retryDelayMs(mkRes(429, { retryAfter: '9999' }), 1) === 9999250);
const noHeader = retryDelayMs(mkRes(503), 1);
check('无 header → 指数退避 800~1040ms', noHeader >= 800 && noHeader <= 1040, String(noHeader));
check('无 header 时退避随次数增长', retryDelayMs(mkRes(503), 3) > retryDelayMs(mkRes(503), 1));

console.log('─'.repeat(70));
console.log('  3. 429 后重试成功（模拟真实 scout 抖动）');
console.log('─'.repeat(70));
{
  const provider = { name: 'fake-a', maxConcurrency: 2, maxAttempts: 4 };
  let n = 0;
  const retries = [];
  const { res, release } = await withUpstream(
    provider,
    async () => {
      n++;
      return n < 3 ? mkRes(503, { retryAfter: '0.05' }) : mkRes(200);
    },
    { onRetry: (a, why, w) => retries.push({ a, w }) },
  );
  release();
  check('连续 2 次 503 后第 3 次成功', res.ok && n === 3, `ok=${res.ok} n=${n}`);
  check('记录了 2 次重试', retries.length === 2, `len=${retries.length}`);
}

console.log('─'.repeat(70));
console.log('  4. 超出 maxAttempts 后如实返回错误（不无限重试）');
console.log('─'.repeat(70));
{
  const provider = { name: 'fake-b', maxConcurrency: 2, maxAttempts: 3 };
  let n = 0;
  const { res, release } = await withUpstream(provider, async () => {
    n++;
    return mkRes(503, { retryAfter: '0.05' });
  });
  release();
  check('恰好尝试 3 次', n === 3, `n=${n}`);
  check('最终如实返回 503', res.status === 503);
}

console.log('─'.repeat(70));
console.log('  5. 不可重试的错误立即返回（不浪费时间）');
console.log('─'.repeat(70));
{
  const provider = { name: 'fake-c', maxConcurrency: 2, maxAttempts: 5 };
  let n = 0;
  const { res, release } = await withUpstream(provider, async () => {
    n++;
    return mkRes(401, { body: '{"error":"bad key"}' });
  });
  release();
  check('401 只尝试 1 次', n === 1, `n=${n}`);
}

console.log('─'.repeat(70));
console.log('  6. 并发闸门：8 个请求在 limit=2 下不会同时在场');
console.log('─'.repeat(70));
{
  const provider = { name: 'fake-d', maxConcurrency: 2, maxAttempts: 1 };
  let inFlight = 0;
  let peak = 0;
  const tasks = Array.from({ length: 8 }, async () => {
    const { res, release } = await withUpstream(provider, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 60));
      inFlight--;
      return mkRes(200);
    });
    release();
    return res.ok;
  });
  const results = await Promise.all(tasks);
  const stats = gateStats()['fake-d'];
  check('峰值并发 ≤ 2', peak <= 2, `peak=${peak}`);
  check('8 个全部成功', results.every(Boolean), `ok=${results.filter(Boolean).length}/8`);
  check('令牌全部归还（active=0, waiting=0）', stats.active === 0 && stats.waiting === 0, JSON.stringify(stats));
}

console.log('─'.repeat(70));
console.log('  7. 重试失败时令牌不泄漏（闸门不会被占死）');
console.log('─'.repeat(70));
{
  const provider = { name: 'fake-e', maxConcurrency: 1, maxAttempts: 2 };
  // 先打 4 个必失败的请求，全部耗尽重试
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      const { release } = await withUpstream(provider, async () => mkRes(503, { retryAfter: '0.01' }));
      release();
    }),
  );
  const stats = gateStats()['fake-e'];
  check('失败重试后 active=0', stats.active === 0, JSON.stringify(stats));

  // 闸门若泄漏，这里会永久挂起 —— 用超时判定
  const ok = await Promise.race([
    (async () => {
      const { res, release } = await withUpstream(provider, async () => mkRes(200));
      release();
      return res.ok;
    })(),
    new Promise((r) => setTimeout(() => r('TIMEOUT'), 3000)),
  ]);
  check('闸门未被占死，后续请求仍可通过', ok === true, String(ok));
}

console.log('─'.repeat(70));
console.log('  8. 网络错误：只重试"确定没送达上游"的（避免重复计费）');
console.log('─'.repeat(70));
const fetchFailed = (code) =>
  Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
{
  const provider = { name: 'fake-f', maxConcurrency: 2, maxAttempts: 4 };
  let n = 0;
  const { res, release } = await withUpstream(provider, async () => {
    n++;
    if (n === 1) throw fetchFailed('ECONNREFUSED');
    return mkRes(200);
  });
  release();
  check('连接被拒（请求没发出）→ 重试成功', res.ok && n === 2, `ok=${res.ok} n=${n}`);
}
for (const [label, err] of [
  ['发出后连接被关（UND_ERR_SOCKET）', fetchFailed('UND_ERR_SOCKET')],
  ['等响应头超时（UND_ERR_HEADERS_TIMEOUT）', fetchFailed('UND_ERR_HEADERS_TIMEOUT')],
  ['无错误码的 socket hang up', Object.assign(new Error('socket hang up'), { name: 'TypeError' })],
]) {
  const provider = { name: `fake-f-${label}`, maxConcurrency: 2, maxAttempts: 4 };
  let n = 0;
  try {
    await withUpstream(provider, async () => {
      n++;
      throw err;
    });
    check(`${label} → 应当直接抛出`, false);
  } catch {
    check(`${label} → 不重试，只尝试 1 次`, n === 1, `n=${n}`);
  }
  check(`${label} → 令牌已归还`, gateStats()[provider.name].active === 0, JSON.stringify(gateStats()[provider.name]));
}

console.log('─'.repeat(70));
console.log('  9. 超时不重试（避免叠加放大延迟）');
console.log('─'.repeat(70));
{
  const provider = { name: 'fake-g', maxConcurrency: 2, maxAttempts: 4 };
  let n = 0;
  try {
    await withUpstream(provider, async () => {
      n++;
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    });
    check('应当抛出 TimeoutError', false);
  } catch (e) {
    check('TimeoutError 立即上抛，只尝试 1 次', n === 1 && e.name === 'TimeoutError', `n=${n} name=${e.name}`);
  }
  const stats = gateStats()['fake-g'];
  check('超时后令牌已归还', stats.active === 0, JSON.stringify(stats));
}

console.log('─'.repeat(70));
console.log('  10. 客户端断开：退避等待立即中止');
console.log('─'.repeat(70));
{
  const provider = { name: 'fake-h', maxConcurrency: 2, maxAttempts: 4 };
  const ac = new AbortController();
  let n = 0;
  const t0 = Date.now();
  setTimeout(() => ac.abort(), 100);
  try {
    await withUpstream(
      provider,
      async () => {
        n++;
        return mkRes(503, { retryAfter: '5' }); // 本该等 5 秒再重试
      },
      { signal: ac.signal },
    );
    check('应当因断开而抛出', false);
  } catch (e) {
    const ms = Date.now() - t0;
    check('断开后 1 秒内中止，不再等满 5 秒', ms < 1000 && e.name === 'AbortError', `ms=${ms} name=${e.name}`);
    check('断开后没有再发请求', n === 1, `n=${n}`);
  }
  check('中止后令牌已归还', gateStats()['fake-h'].active === 0, JSON.stringify(gateStats()['fake-h']));
}

console.log('─'.repeat(70));
console.log('  11. 客户端断开：排队中的请求不再发出');
console.log('─'.repeat(70));
{
  const provider = { name: 'fake-i', maxConcurrency: 1, maxAttempts: 1 };
  const first = withUpstream(provider, async () => {
    await new Promise((r) => setTimeout(r, 300));
    return mkRes(200);
  });
  const ac = new AbortController();
  let n2 = 0;
  const second = withUpstream(
    provider,
    async () => {
      n2++;
      return mkRes(200);
    },
    { signal: ac.signal },
  );
  second.catch(() => {}); // 取消会立即拒绝，先注册处理器，再等第一个请求。
  setTimeout(() => ac.abort(), 50); // 第二个还在排队时客户端走了
  const { release } = await first;
  release();
  try {
    await second;
    check('排队中断开 → 应当抛出', false);
  } catch (e) {
    check('排队中断开 → 不向上游发请求', n2 === 0 && e.name === 'AbortError', `n2=${n2} name=${e.name}`);
  }
  check('令牌全部归还', gateStats()['fake-i'].active === 0 && gateStats()['fake-i'].waiting === 0, JSON.stringify(gateStats()['fake-i']));
}

console.log('─'.repeat(70));
console.log('  12. 排队取消立即移除等待者，不依赖前序请求结束');
{
  const provider = { name: 'cancel-queued', maxConcurrency: 1, maxAttempts: 1 };
  const first = await withUpstream(provider, async () => mkRes(200));
  const ac = new AbortController();
  let sent = false;
  const second = withUpstream(provider, async () => { sent = true; return mkRes(200); }, { signal: ac.signal });
  const settled = second.then(() => false, (e) => e.name === 'AbortError');
  ac.abort();
  await new Promise((resolve) => setImmediate(resolve));
  check('取消后队列立即清空', gateStats()[provider.name].waiting === 0);
  let finished = false;
  settled.then(() => { finished = true; });
  await new Promise((resolve) => setImmediate(resolve));
  check('前序请求仍占用令牌时取消已完成', finished);
  first.release();
  check('取消请求未发出', await settled && !sent);
}

console.log('  13. 令牌交接保留队列优先级，不超卖');
{
  const provider = { name: 'handoff-race', maxConcurrency: 1, maxAttempts: 1 };
  const first = await withUpstream(provider, async () => mkRes(200));
  const order = [];
  const second = withUpstream(provider, async () => { order.push('second'); return mkRes(200); });
  first.release();
  const third = withUpstream(provider, async () => { order.push('third'); return mkRes(200); });
  const held = await second;
  check('交接期间 active 不超过 limit', gateStats()[provider.name].active === 1);
  check('新请求不抢占排队者', order.join(',') === 'second');
  held.release();
  (await third).release();
  check('交接后令牌归零', gateStats()[provider.name].active === 0);
}

console.log('  14. release 可重复调用且不会产生负令牌');
{
  const provider = { name: 'idempotent-release', maxConcurrency: 1, maxAttempts: 1 };
  const result = await withUpstream(provider, async () => mkRes(200));
  result.release();
  result.release();
  check('重复释放仍保持 active=0', gateStats()[provider.name].active === 0);
}

console.log('═'.repeat(70));
console.log(`  结果: ${pass} 通过, ${fail} 失败`);
console.log('═'.repeat(70));
process.exit(fail ? 1 : 0);
