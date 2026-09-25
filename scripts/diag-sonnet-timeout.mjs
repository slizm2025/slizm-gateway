// sonnet 非流式 90s TimeoutError 的定性实验。
// 已知事实：selftest 里 sonnet 流式 4250ms 通过，非流式却卡满 90s 被 abort。
// 两条假设：
//   H1 模型级问题 —— sonnet 这个模型在 relay 上非流式通道有问题
//   H2 通道级问题 —— relay 的非流式（非 stream）请求整体被挂住，与模型无关
// 判别手段：拿同 provider(relay) 的 haiku 做对照。
//   haiku 非流式快 → H1；haiku 非流式也卡 → H2（是 relay 的非流式通道）
// 另外给 sonnet 非流式放宽到 180s，区分"真挂死"和"只是慢"。
// 只读探测，不改文件，不打印 key。
import { loadConfig } from '../src/config.js';

const cfg = loadConfig();
const base = `http://${cfg.server.host}:${cfg.server.port}`;
const token = cfg.server.clientToken;

const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YEL = '\x1b[33m';
const OFF = '\x1b[0m';

async function call(alias, { stream = false, timeout = 180_000, prompt = '回复两个字：通了', maxTokens = 24 } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: alias,
        max_tokens: maxTokens,
        ...(stream ? { stream: true } : {}),
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(timeout),
    });
    const text = await res.text();
    const ms = Date.now() - t0;
    if (!res.ok) {
      return { alias, stream, ok: false, ms, status: res.status, body: text.replace(/\s+/g, ' ').slice(0, 260) };
    }
    if (stream) {
      const events = [...text.matchAll(/^event: (\w+)/gm)].map((m) => m[1]);
      return {
        alias, stream, ok: events.includes('message_start') && events.includes('message_stop'),
        ms, status: 200,
        body: `事件数=${events.length} blocks=${events.filter((e) => e === 'content_block_delta').length}`,
      };
    }
    const j = JSON.parse(text);
    const content = (j.content ?? []).map((b) => (b.type === 'text' ? b.text : `<${b.type}>`)).join('');
    return {
      alias, stream, ok: true, ms, status: 200,
      body: `"${content.slice(0, 50)}" in/out=${j.usage?.input_tokens}/${j.usage?.output_tokens}`,
    };
  } catch (e) {
    return { alias, stream, ok: false, ms: Date.now() - t0, status: e.name, body: e.message };
  }
}

function row(r) {
  const tag = r.ok ? `${GREEN}✓${OFF}` : `${RED}✗${OFF}`;
  const mode = r.stream ? 'stream  ' : 'non-strm';
  return `  ${tag} ${r.alias.padEnd(7)} ${mode} ${String(r.ms + 'ms').padEnd(9)} ${String(r.status).padEnd(9)} ${r.body}`;
}

console.log('═'.repeat(112));
const h = await (await fetch(`${base}/health`, { headers: { authorization: `Bearer ${token}` } })).json();
console.log(`  网关在线 uptime=${h.uptimeSec}s   ${DIM}routes=${JSON.stringify(h.routes)}${OFF}`);
for (const p of h.providers) console.log(`  ${DIM}${p.name.padEnd(10)} ${p.apiType.padEnd(10)} ${p.baseUrl}${OFF}`);
console.log('═'.repeat(112));

console.log('');
console.log('对照实验 — 同 provider(relay) 上的 haiku，非流式 vs 流式');
console.log('  haiku 非流式正常 → sonnet 是模型级问题');
console.log('  haiku 非流式也卡 → relay 的非流式通道是问题，跟模型无关');
console.log('─'.repeat(112));
for (const r of [
  await call('haiku'),
  await call('haiku', { stream: true }),
]) console.log(row(r));

console.log('');
console.log('sonnet — 流式（已知 4.2s 通过，做基线）与 超大 prompt 对照');
console.log('─'.repeat(112));
for (const r of [
  await call('sonnet', { stream: true }),
  await call('sonnet', { stream: true, prompt: '数到十' }),
]) console.log(row(r));

console.log('');
console.log(`  ${YEL}sonnet 非流式，超时放宽到 180s —— 区分"真挂死"与"只是慢"${OFF}`);
console.log('─'.repeat(112));
for (let i = 1; i <= 3; i += 1) {
  const r = await call('sonnet');
  console.log(row(r) + `   ${DIM}[第 ${i} 次]${OFF}`);
}

console.log('');
console.log('═'.repeat(112));
console.log('  判读：');
console.log('   · haiku 非流式快 + sonnet 非流式全卡 → relay 上 sonnet 模型非流式有问题；');
console.log('     临时方案：把 sonnet 路由改到别的 provider，或对 relay 强制流式。');
console.log('   · haiku 非流式也卡 → relay 的"非流式"通道整体有问题，与模型无关；');
console.log('     那就该在网关侧对 anthropic 上游非流式请求也走流式再聚合。');
console.log('   · sonnet 非流式 <180s 返回 → 只是慢，selftest 的 90s 上限太紧，调大即可。');
console.log('═'.repeat(112));
