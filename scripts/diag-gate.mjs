// 验证并发闸门确实在限流：打 8 个并发请求，同时轮询 gate-stats，
// 观察 active 峰值是否被压在 maxConcurrency（默认 3）以内。
const GW = process.env.GW_URL ?? 'http://127.0.0.1:4101';
const TOKEN = process.env.GW_TOKEN ?? 'sk-local-gateway-9f3a7c21';

const body = {
  model: 'scout',
  max_tokens: 1500,
  messages: [{ role: 'user', content: 'Name one file under src/ in one short line.' }],
  tools: [
    { name: 'Grep', description: 'Search file contents.', input_schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
  ],
  stream: false,
};

async function one(i) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${GW}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    await res.text();
    return { i, ok: res.ok, status: res.status, ms: Date.now() - t0 };
  } catch (e) {
    return { i, ok: false, status: 0, ms: Date.now() - t0, err: e.name };
  }
}

const samples = [];
let polling = true;
const poller = (async () => {
  while (polling) {
    try {
      const r = await fetch(`${GW}/v1/gate-stats`, { headers: { authorization: `Bearer ${TOKEN}` } });
      const j = await r.json();
      const g = j.gemini;
      if (g) samples.push({ active: g.active, waiting: g.waiting });
    } catch {
      /* 忽略 */
    }
    await new Promise((r) => setTimeout(r, 120));
  }
})();

const t0 = Date.now();
const results = await Promise.all(Array.from({ length: 8 }, (_, i) => one(i + 1)));
polling = false;
await poller;

console.log('═'.repeat(72));
console.log('  8 并发请求经闸门结果');
console.log('═'.repeat(72));
for (const r of results.sort((a, b) => a.i - b.i)) {
  console.log(`  #${r.i}  ${r.ok ? '[OK]  ' : '[FAIL]'} HTTP ${String(r.status).padStart(3)}  ${String(r.ms).padStart(7)}ms ${r.err ?? ''}`);
}
const ok = results.filter((r) => r.ok).length;
console.log(`\n  → ${ok}/8 成功，总耗时 ${Date.now() - t0}ms`);

const peakActive = Math.max(0, ...samples.map((s) => s.active));
const peakWaiting = Math.max(0, ...samples.map((s) => s.waiting));
console.log(`\n  gemini 闸门：峰值 active=${peakActive}（上限 3），峰值 waiting=${peakWaiting}`);
console.log(`  采样 ${samples.length} 次`);
if (peakActive <= 3) console.log('  ✓ 闸门生效：在途请求从未超过 3');
else console.log(`  ✗ 闸门未生效：在途请求达到 ${peakActive}`);
