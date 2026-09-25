// 核心实验：直接 POST sub2api，逐个试探模型名，看 503 到底是"账号池"还是"模型名不对"。
// 这是被中断的那半个探测的续做。key 从 .env 读，不打印明文。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BASE = 'https://sub2api.190515.xyz/v1';

function readKey(name, nth = 0) {
  const out = [];
  for (const raw of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    if (line.slice(0, eq).trim() === name) {
      let v = line.slice(eq + 1).trim();
      if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
      out.push(v);
    }
  }
  return out[nth] ?? null;
}

const GEM = readKey('GEMINI_KEY');
const DS = readKey('DEEPSEEK_KEY');

// 关键：把每个候选往返 2 次，区分"瞬时抖动"和"稳定失败"
async function tryChat(key, model, { stream = false, note = '' } = {}) {
  const body = {
    model,
    messages: [{ role: 'user', content: 'reply with the single word: ok' }],
    max_tokens: 24,
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  };
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const text = await res.text();
    const ms = Date.now() - t0;
    const ra = res.headers.get('retry-after') ?? '-';
    let summary = text.replace(/\s+/g, ' ').slice(0, 160);
    if (res.ok) {
      if (stream) {
        const first = text.split(/\r?\n/).find((l) => l.startsWith('data:')) ?? '';
        summary = `SSE 首帧: ${first.slice(0, 90)}`;
      } else {
        try {
          const j = JSON.parse(text);
          const c = j.choices?.[0]?.message?.content ?? '';
          const mdl = j.model ?? '?';
          summary = `content="${String(c).slice(0, 40)}" resp_model=${mdl} usage=${JSON.stringify(j.usage ?? {})}`;
        } catch {
          /* 保持原文 */
        }
      }
    }
    return { status: res.status, ms, ra, summary, retryAfterHeader: ra, note };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, ra: '-', summary: `${e.name}: ${e.message}`, note };
  }
}

function row(r) {
  const tag =
    r.status === 200 ? '\x1b[32m200 ✓\x1b[0m'
    : r.status === 0 ? '\x1b[31mERR\x1b[0m'
    : `\x1b[31m${r.status}\x1b[0m`;
  const raStr = r.retryAfterHeader && r.retryAfterHeader !== '-' ? ` retry-after=${r.retryAfterHeader}` : '';
  return `  ${tag.padEnd(18)} ${String(r.ms).padStart(6)}ms${raStr.padEnd(18)}  ${r.summary}`;
}

console.log('═'.repeat(100));
console.log('  A. gemini 候选模型名（我们当前发的是 gemini-3.8-flash-high，在 models 列表里）');
console.log('═'.repeat(100));
const gemCandidates = [
  'gemini-3.8-flash-high',
  'gemini-3.8-flash',
  'gemini-3.7-flash-high',
  'gemini-3.6-flash-high',
  'gemini-3-flash',
  'gemini-2.5-flash',
];
const gemResults = [];
for (const m of gemCandidates) {
  const r = await tryChat(GEM, m);
  gemResults.push({ m, r });
  console.log(`  model=${m.padEnd(24)}`);
  console.log(row(r));
  // 同一模型立刻再打一次，区分瞬时 vs 稳定
  const r2 = await tryChat(GEM, m);
  console.log(`    ↳ 复测 ` + row(r2).trim());
  console.log('');
}

console.log('═'.repeat(100));
console.log('  B. deepseek 候选模型名（exec 路由）');
console.log('═'.repeat(100));
const dsCandidates = ['deepseek-v4.1-flash-0910', 'deepseek-v4-flash', 'deepseek-v4-pro'];
for (const m of dsCandidates) {
  const r = await tryChat(DS, m);
  console.log(`  model=${m.padEnd(24)}`);
  console.log(row(r));
  console.log('');
}

console.log('═'.repeat(100));
console.log('  C. 流式 + stream_options（我们真实网关发的就是这个形状）');
console.log('═'.repeat(100));
for (const m of ['gemini-3.8-flash-high', 'deepseek-v4.1-flash-0910']) {
  const key = m.startsWith('gemini') ? GEM : DS;
  const r = await tryChat(key, m, { stream: true, note: 'stream' });
  console.log(`  model=${m.padEnd(24)} stream=true`);
  console.log(row(r));
  console.log('');
}

console.log('═'.repeat(100));
console.log('  裁决');
console.log('═'.repeat(100));
const ok200 = [...gemResults, ...dsCandidates].filter((x) => (x.r ?? x).status === 200).length;
const allGem = gemResults.map((x) => x.r.status);
console.log(`  gemini 各模型状态: ${gemResults.map((x) => `${x.m}=${x.r.status}`).join('  ')}`);
console.log(`  200 的数量（含 deepseek）: ${ok200}`);
console.log('');
if (allGem.every((s) => s === 503)) {
  console.log('  → 所有 gemini 模型名都 503 ⇒ 与链路/格式无关，是账号层面');
} else if (allGem.some((s) => s === 200) && allGem.some((s) => s === 503)) {
  console.log('  → 部分模型名可用、部分 503 ⇒ 模型名/池子映射问题，改 routes 的 model 即可');
} else if (allGem.some((s) => s === 200)) {
  console.log('  → 全绿 ⇒ 之前的 503 是瞬时并发抖动，limiter 应该能吸收');
} else {
  console.log('  → 非 503 的其他错误，看上面每一行的 body');
}
console.log('═'.repeat(100));
