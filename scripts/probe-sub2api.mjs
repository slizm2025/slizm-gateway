// 直接探测 sub2api：它到底认哪些 model 名字。
// 假设检验：账号池是按"模型名"分组的，我们发过去的名字池子是空的，
// 所以回 "No available accounts" —— 而不是"没有账号可用"的字面意思。
// 本脚本自己从 .env 读 key，不经过命令行参数，不打印 key。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BASE = 'https://sub2api.190515.xyz/v1';

function readKey(name) {
  const text = readFileSync(join(ROOT, '.env'), 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    if (line.slice(0, eq).trim() === name) {
      let v = line.slice(eq + 1).trim();
      if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
      return v;
    }
  }
  return null;
}

// .env 里有注释说 "4) any 档位" 但键名被写成了 GEMINI_KEY —— 所以出现两次。
// readKey 返回第一个匹配，即 gemini 那把。先把所有出现都列出来，避免又踩一次这个坑。
function allKeys(name) {
  const out = [];
  const text = readFileSync(join(ROOT, '.env'), 'utf8');
  for (const raw of text.split(/\r?\n/)) {
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
  return out;
}

const mask = (k) => (k ? `${k.slice(0, 7)}…${k.slice(-4)} (len ${k.length})` : '(缺失)');

const gemKeys = allKeys('GEMINI_KEY');
const dsKey = readKey('DEEPSEEK_KEY');

console.log('─'.repeat(72));
console.log('  .env 里的键（脱敏）');
console.log('─'.repeat(72));
console.log(`  GEMINI_KEY   出现 ${gemKeys.length} 次: ${gemKeys.map((k, i) => `[${i}] ${mask(k)}`).join('  ')}`);
console.log(`  DEEPSEEK_KEY          : ${mask(dsKey)}`);

const geminiKey = gemKeys[0];
const anyKey = gemKeys[1];

async function getModels(label, key) {
  console.log('');
  console.log('─'.repeat(72));
  console.log(`  GET /v1/models  —  ${label}`);
  console.log('─'.repeat(72));
  if (!key) {
    console.log('  跳过：没有 key');
    return [];
  }
  try {
    const res = await fetch(`${BASE}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    console.log(`  HTTP ${res.status}   content-type: ${res.headers.get('content-type')}`);
    if (!res.ok) {
      console.log(`  body: ${text.slice(0, 400)}`);
      return [];
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      console.log(`  非 JSON: ${text.slice(0, 300)}`);
      return [];
    }
    const ids = (json.data ?? []).map((m) => m.id).filter(Boolean);
    console.log(`  共 ${ids.length} 个模型：`);
    for (const id of ids) console.log(`    ${id}`);
    return ids;
  } catch (e) {
    console.log(`  网络故障: ${e.name}: ${e.message}`);
    return [];
  }
}

async function tryChat(label, key, model, extraBody = {}) {
  console.log('');
  console.log('─'.repeat(72));
  console.log(`  POST /v1/chat/completions  —  ${label}  model=${model}`);
  if (Object.keys(extraBody).length) console.log(`  extra: ${JSON.stringify(extraBody)}`);
  console.log('─'.repeat(72));
  if (!key) {
    console.log('  跳过：没有 key');
    return;
  }
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'say ok' }],
        max_tokens: 16,
        ...extraBody,
      }),
      signal: AbortSignal.timeout(45000),
    });
    const text = await res.text();
    const ms = Date.now() - t0;
    console.log(`  HTTP ${res.status}   ${ms}ms`);
    const ra = res.headers.get('retry-after');
    if (ra) console.log(`  retry-after: ${ra}`);
    // 只打印前 300 字符，避免回显敏感内容
    console.log(`  body: ${text.slice(0, 300)}`);
  } catch (e) {
    console.log(`  ${Date.now() - t0}ms  网络故障: ${e.name}: ${e.message}`);
  }
}

const gemModels = await getModels('GEMINI_KEY', geminiKey);
const dsModels = await getModels('DEEPSEEK_KEY', dsKey);
if (anyKey && anyKey !== geminiKey) {
  const anyModels = await getModels('any 那把 key（.env 里第二个 GEMINI_KEY）', anyKey);
  if (anyModels.length) gemModels.push(...anyModels);
}

console.log('');
console.log('═'.repeat(72));
console.log('  逐个模型名试探（核心实验）');
console.log('═'.repeat(72));

// 候选：我们当前发的 + models 列表里所有像 gemini 的
const candidates = new Set(['gemini-3.8-flash-high']);
for (const id of gemModels) {
  if (/gemini/i.test(id)) candidates.add(id);
}
for (const m of [...candidates].slice(0, 8)) {
  await tryChat('GEMINI_KEY', geminiKey, m);
}

if (dsModels.length) {
  const dsCand = new Set(['deepseek-v4.1-flash-0910']);
  for (const id of dsModels) if (/deepseek/i.test(id)) dsCand.add(id);
  for (const m of [...dsCand].slice(0, 5)) {
    await tryChat('DEEPSEEK_KEY', dsKey, m);
  }
}

console.log('');
console.log('═'.repeat(72));
console.log('  结论看这里：');
console.log('   · 若某个模型名回 200，而 gemini-3.8-flash-high 回 503');
console.log('     → 是模型名/池子映射问题，改 routes 里的 model 即可');
console.log('   · 若所有模型名都回 503');
console.log('     → 是账号层面的问题（余额/并发/被封），与链路无关');
console.log('   · 若回 400/404');
console.log('     → 才是"格式/路径不对"，那才轮到查 adapter');
console.log('═'.repeat(72));
