// 链路自检：逐个路由发送一个最小请求，验证是否能打通上游并拿到合法响应。
// 用法: node scripts/selftest.js [baseUrl] [clientToken]
//   node scripts/selftest.js                       # 用 .env 里的 GATEWAY_PORT
//   node scripts/selftest.js http://127.0.0.1:4100 sk-local-gateway-test
import { loadConfig, redact } from '../src/config.js';

const args = process.argv.slice(2);
let base = args[0];
const token = args[1];

let cfg;
try {
  cfg = loadConfig();
} catch (e) {
  console.error('配置加载失败:', e.message);
  process.exit(1);
}
base = base ?? `http://${cfg.server.host}:${cfg.server.port}`;

const clientToken = token ?? cfg.server.clientToken;
const only = process.env.SELFTEST_ONLY;

// 自检扮演网关的下游 Claude Code：网关只透传真实客户端头、不再伪造，
// 所以这里必须自带 Claude Code 指纹，否则 relay 这类"仅限 Claude Code"的渠道会 403。
const CLAUDE_CODE_HEADERS = {
  'content-type': 'application/json',
  authorization: `Bearer ${clientToken}`,
  'anthropic-version': '2023-06-01',
  'user-agent': 'claude-cli/2.1.280 (external, cli)',
  'x-app': 'cli',
};

function line(s = '') {
  console.log(s);
}

async function health() {
  const res = await fetch(`${base}/health`, {
    headers: { authorization: `Bearer ${clientToken}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`/health 返回 ${res.status}`);
  return res.json();
}

async function tryRoute(alias) {
  const body = {
    model: alias,
    max_tokens: 24,
    messages: [{ role: 'user', content: '回复两个字：通了' }],
  };
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: CLAUDE_CODE_HEADERS,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    const text = await res.text();
    const ms = Date.now() - t0;
    if (!res.ok) {
      return { alias, ok: false, ms, detail: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    const j = JSON.parse(text);
    const content = (j.content ?? [])
      .map((b) => (b.type === 'text' ? b.text : `<${b.type}>`))
      .join('');
    return {
      alias,
      ok: true,
      ms,
      detail: `${content.slice(0, 60)} | tokens in/out=${j.usage?.input_tokens}/${j.usage?.output_tokens}`,
    };
  } catch (e) {
    return { alias, ok: false, ms: Date.now() - t0, detail: `${e.name}: ${e.message}` };
  }
}

async function tryStream(alias) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: CLAUDE_CODE_HEADERS,
      body: JSON.stringify({
        model: alias,
        max_tokens: 24,
        stream: true,
        messages: [{ role: 'user', content: '数到三' }],
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const text = await res.text();
    const events = [...text.matchAll(/^event: (\w+)/gm)].map((m) => m[1]);
    const hasStart = events.includes('message_start');
    const hasStop = events.includes('message_stop');
    const deltas = events.filter((e) => e === 'content_block_delta').length;
    return {
      ok: hasStart && hasStop,
      ms: Date.now() - t0,
      detail: `事件数=${events.length} blocks=${deltas} start=${hasStart} stop=${hasStop}`,
    };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, detail: `${e.name}: ${e.message}` };
  }
}

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

line('═'.repeat(72));
line('  网关链路自检');
line('═'.repeat(72));

let h;
try {
  h = await health();
  line(`${GREEN}✓${OFF} /health 可达  运行 ${h.uptimeSec}s`);
  line(`${DIM}  路由: ${JSON.stringify(h.routes)}${OFF}`);
  line(`${DIM}  provider:${OFF}`);
  for (const p of h.providers) {
    line(`${DIM}    ${p.name.padEnd(12)} ${p.apiType.padEnd(10)} ${p.baseUrl}  key=${p.key}${OFF}`);
  }
} catch (e) {
  line(`${RED}✗${OFF} /health 不可达: ${e.message}`);
  line(`${DIM}  网关没在跑？先执行: node src/server.js${OFF}`);
  process.exit(1);
}

line();
line('─'.repeat(72));
line('  逐路由测试（非流式）');
line('─'.repeat(72));

const aliases = only ? [only] : [...cfg.routes.keys()];
let pass = 0;
let fail = 0;
for (const alias of aliases) {
  const r = await tryRoute(alias);
  if (r.ok) {
    pass += 1;
    line(`${GREEN}✓${OFF} ${alias.padEnd(10)} ${String(r.ms + 'ms').padEnd(8)} ${r.detail}`);
  } else {
    fail += 1;
    line(`${RED}✗${OFF} ${alias.padEnd(10)} ${String(r.ms + 'ms').padEnd(8)} ${redact(r.detail)}`);
  }
}

line();
line('─'.repeat(72));
line('  流式转换测试（Anthropic SSE 事件序列是否完整）');
line('─'.repeat(72));
for (const alias of only ? [only] : [...cfg.routes.keys()]) {
  const r = await tryStream(alias);
  if (r.ok) {
    pass += 1;
    line(`${GREEN}✓${OFF} ${alias.padEnd(10)} ${String(r.ms + 'ms').padEnd(8)} ${r.detail}`);
  } else {
    fail += 1;
    line(`${RED}✗${OFF} ${alias.padEnd(10)} ${String(r.ms + 'ms').padEnd(8)} ${redact(r.detail)}`);
  }
}

line();
line('═'.repeat(72));
line(`  结果: ${pass} 通过, ${fail} 失败`);
line('═'.repeat(72));
process.exit(fail === 0 ? 0 : 1);
