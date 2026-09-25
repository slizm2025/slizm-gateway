// 并发测试：真实子 agent 是并行派发的，而之前所有测试都是串行的。
// 假设：下游账号池并发额度极小，串行过、并行就 503。
const GW = 'http://127.0.0.1:4100';
const TOKEN = 'sk-local-gateway-9f3a7c21';

const tools = [
  { name: 'Grep', description: 'Search file contents.', input_schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
  { name: 'Read', description: 'Read a file.', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
];

async function one(model, i) {
  const body = {
    model,
    max_tokens: 2000,
    system: [{ type: 'text', text: 'You are a codebase search specialist. Be terse.' }],
    messages: [{ role: 'user', content: `Call ${i}: name one file under src/.` }],
    tools,
    stream: false,
  };
  const t0 = Date.now();
  try {
    const res = await fetch(`${GW}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, ms: Date.now() - t0, text: text.slice(0, 120).replace(/\s+/g, ' ') };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, text: `${e.name}: ${e.message}` };
  }
}

for (const [model, n] of [['scout', 2], ['scout', 4], ['exec', 4]]) {
  console.log('─'.repeat(76));
  console.log(`  ${model}  并发 ${n}`);
  console.log('─'.repeat(76));
  const results = await Promise.all(Array.from({ length: n }, (_, i) => one(model, i)));
  results.forEach((r, i) => {
    const tag = r.ok ? '[OK]  ' : '[FAIL]';
    console.log(`  ${tag} #${i + 1}  HTTP ${String(r.status).padStart(3)}  ${String(r.ms).padStart(6)}ms  ${r.text}`);
  });
  const ok = results.filter((r) => r.ok).length;
  console.log(`  → ${ok}/${n} 成功`);
  await new Promise((r) => setTimeout(r, 3000));
}
