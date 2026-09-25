// 实测：config.js 解析出来的 provider key，究竟是 .env 里哪一次出现的值。
// 只打印哈希指纹，不打印明文 —— 目的是定位"取错了一把钥匙"，不需要看到钥匙本身。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const fp = (s) => (s ? createHash('sha256').update(s).digest('hex').slice(0, 12) : '(缺失)');
const mask = (k) => (k ? `${k.slice(0, 7)}…${k.slice(-4)} len=${k.length}` : '(缺失)');

// 1) 按 .env 出现顺序列出 GEMINI_KEY / ANY_KEY / RELAY_KEY / DEEPSEEK_KEY 的每一次出现
const lines = readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/);
const occurrences = new Map();
lines.forEach((raw, i) => {
  const line = raw.trim();
  if (!line || line.startsWith('#')) return;
  const eq = line.indexOf('=');
  if (eq === -1) return;
  const key = line.slice(0, eq).trim();
  let val = line.slice(eq + 1).trim();
  if (/^".*"$/.test(val) || /^'.*'$/.test(val)) val = val.slice(1, -1);
  if (!occurrences.has(key)) occurrences.set(key, []);
  occurrences.get(key).push({ lineNo: i + 1, val });
});

console.log('═'.repeat(76));
console.log('  .env 中每个键的每一次出现（按行号）');
console.log('═'.repeat(76));
for (const [key, list] of occurrences) {
  console.log(`  ${key}`);
  for (const { lineNo, val } of list) {
    console.log(`    L${String(lineNo).padEnd(4)} ${mask(val).padEnd(28)} fp=${fp(val)}`);
  }
  if (list.length > 1) {
    const first = list[0].val;
    const last = list[list.length - 1].val;
    console.log(
      `    ⚠ 重复 ${list.length} 次；首=次${first === last ? '同值' : '不同值'}  ` +
        `config.js 取【最后】fp=${fp(last)}   gw.js 取【第一】fp=${fp(first)}`,
    );
  }
}

// 2) 真实调用 loadConfig()，看每个 provider 最终拿到哪把
console.log('');
console.log('═'.repeat(76));
console.log('  loadConfig() 的真实结果');
console.log('═'.repeat(76));
let cfg;
try {
  cfg = loadConfig();
  console.log('  ✓ loadConfig() 成功');
} catch (e) {
  console.log(`  ✗ loadConfig() 抛错: ${e.message}`);
  process.exit(1);
}

console.log('');
console.log('  provider          解析到的 key 指纹     与 .env 哪一次出现匹配');
console.log('  ' + '─'.repeat(72));
for (const [name, p] of cfg.providers) {
  const got = fp(p.apiKey);
  const hits = [];
  for (const [key, list] of occurrences) {
    list.forEach(({ lineNo, val }, idx) => {
      if (fp(val) === got) hits.push(`${key}@L${lineNo}(${idx === 0 ? '第1次' : `第${idx + 1}次`})`);
    });
  }
  const verdict = hits.length ? hits.join(' ') : '❓ 不在 .env 里（来自 process.env？）';
  console.log(`  ${name.padEnd(12)} ${got.padEnd(20)} ${verdict}`);
}

// 3) 网关日志里的实际请求 —— 只有配了 GATEWAY_LOG_REQUESTS 才有
console.log('');
console.log('═'.repeat(76));
console.log('  scout 路由实际会用到的 key');
console.log('═'.repeat(76));
const scout = cfg.routes.get('scout');
if (!scout) {
  console.log('  ✗ 没有 scout 路由');
} else {
  const prov = cfg.providers.get(scout.provider);
  const got = fp(prov.apiKey);
  const matched = [...occurrences].flatMap(([key, list]) =>
    list.map(({ lineNo, val }, idx) => ({ key, lineNo, idx, fp: fp(val) })),
  ).filter((x) => x.fp === got);
  console.log(`  scout -> provider=${scout.provider} model=${scout.model}`);
  console.log(`  key 指纹 = ${got}`);
  console.log(`  匹配到: ${matched.map((m) => `${m.key}@L${m.lineNo}`).join(' ') || '未匹配'}`);
  if (matched.length > 1) {
    console.log('  ⚠ 有两把不同的钥匙？不，指纹相同说明同值重复。');
  }
  console.log('');
  if (matched.some((m) => m.idx > 0)) {
    console.log('  🚨 结论：scout 用的是 .env 里【后面】那次出现的 GEMINI_KEY。');
    console.log('     而我已实测这把是 401 INVALID_API_KEY —— 这才是 scout 失败的真正原因。');
  } else if (matched.length === 1) {
    console.log('  ✓ 结论：scout 用的是 .env 里【第一次】出现的 GEMINI_KEY（实测 200，能列 58 个模型）。');
    console.log('     那么密钥不是原因，要继续查别处。');
  }
}
console.log('═'.repeat(76));
