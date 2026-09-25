// 两个遗留失败的定性实验：
//   (1) opus 400 "1m 上下文已经全量可用，请启用 1m 上下文后重试"
//       → 假设：上游是"认模型名 + 要求 beta 头"，而我们的 adaptor 没注入这个头。
//         验证手段：走本地网关，显式带上 anthropic-beta，看 400 是否消失。
//         （anthropic.js 的 FORWARD_HEADERS 会原样透传 anthropic-beta，所以这招不需要改代码）
//   (2) sonnet 非流式 90s 超时，但流式 4.2s 通过
//       → 假设：relay 的非流式通道被挂住，或模型级限流。
//         判别手段：同 provider(relay) 的 haiku 非流式做对照。
//         haiku 快 → 是 sonnet 这个模型的问题；haiku 也慢 → 是 relay 非流式通道的问题。
// 只读探测，不改任何文件，不打印 key。
import { loadConfig } from '../src/config.js';

const cfg = loadConfig();
const base = `http://${cfg.server.host}:${cfg.server.port}`;
const token = cfg.server.clientToken;

const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YEL = '\x1b[33m';
const OFF = '\x1b[0m';

async function call(alias, { stream = false, beta = null, timeout = 150_000, prompt = '回复两个字：通了' } = {}) {
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    'anthropic-version': '2023-06-01',
  };
  if (beta) headers['anthropic-beta'] = beta;

  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: alias,
        max_tokens: 24,
        ...(stream ? { stream: true } : {}),
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(timeout),
    });
    const text = await res.text();
    const ms = Date.now() - t0;
    if (!res.ok) {
      return { alias, stream, beta, ok: false, ms, status: res.status, body: text.replace(/\s+/g, ' ').slice(0, 300) };
    }
    if (stream) {
      const events = [...text.matchAll(/^event: (\w+)/gm)].map((m) => m[1]);
      return {
        alias, stream, beta, ok: events.includes('message_start') && events.includes('message_stop'),
        ms, status: 200,
        body: `事件数=${events.length} blocks=${events.filter((e) => e === 'content_block_delta').length}`,
      };
    }
    const j = JSON.parse(text);
    const content = (j.content ?? []).map((b) => (b.type === 'text' ? b.text : `<${b.type}>`)).join('');
    return {
      alias, stream, beta, ok: true, ms, status: 200,
      body: `"${content.slice(0, 50)}" in/out=${j.usage?.input_tokens}/${j.usage?.output_tokens}`,
    };
  } catch (e) {
    return { alias, stream, beta, ok: false, ms: Date.now() - t0, status: e.name, body: e.message };
  }
}

function row(r) {
  const tag = r.ok ? `${GREEN}✓${OFF}` : `${RED}✗${OFF}`;
  const betaTag = r.beta ? `${YEL} +beta${OFF}` : '      ';
  const mode = r.stream ? 'stream  ' : 'non-strm';
  const st = String(r.status).padEnd(9);
  return `  ${tag} ${r.alias.padEnd(7)} ${mode} ${betaTag} ${String(r.ms + 'ms').padEnd(9)} ${st} ${r.body}`;
}

console.log('═'.repeat(110));
const h = await (await fetch(`${base}/health`, { headers: { authorization: `Bearer ${token}` } })).json();
console.log(`  网关在线 uptime=${h.uptimeSec}s`);
for (const p of h.providers) console.log(`  ${DIM}${p.name.padEnd(10)} ${p.apiType.padEnd(10)} ${p.baseUrl}${OFF}`);
console.log(`  ${DIM}routes: ${JSON.stringify(h.routes)}${OFF}`);
console.log('═'.repeat(110));

// ── 实验 1：opus 的 1M 上下文 ──────────────────────────────────────────────
console.log('');
console.log('实验 1 — opus (provider=any / anyrouter.top, model=claude-opus-5-5[1M])');
console.log('  变量：是否携带 anthropic-beta: context-1m-2025-08-07');
console.log('─'.repeat(110));
const BETA = 'context-1m-2025-08-07';
for (const r of [
  await call('opus', { beta: null }),
  await call('opus', { beta: BETA }),
  await call('opus', { stream: true, beta: null }),
  await call('opus', { stream: true, beta: BETA }),
]) console.log(row(r));

// ── 实验 2：sonnet 非流式超时 ───────────────────────────────────────────────
console.log('');
console.log('实验 2 — sonnet 非流式超时定性（对照：同 provider 的 haiku）');
console.log('  relay 上的 haiku 若正常 → 问题在 sonnet 这个模型；haiku 也慢 → relay 非流式通道问题');
console.log('─'.repeat(110));
for (const r of [
  await call('sonnet', { stream: true }),
  await call('haiku'),
  await call('haiku', { stream: true }),
]) console.log(row(r));
console.log(`  ${DIM}…现在测 sonnet 非流式（给到 150s，看是"真挂死"还是"只是慢"）${OFF}`);
for (const r of [await call('sonnet'), await call('sonnet')]) console.log(row(r));

console.log('');
console.log('═'.repeat(110));
