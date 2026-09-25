// 走真实网关（而不是直连上游）做受控测试，复现 scout 503。
// 重点放开 Claude Code 真实请求里才有、而简化测试里没有的字段：max_tokens、system、tool_choice。
const GW = process.env.GW_URL ?? 'http://127.0.0.1:4100';
const TOKEN = process.env.GW_TOKEN ?? 'sk-local-gateway-9f3a7c21';

const tools = [
  {
    name: 'Glob',
    description: 'Find files by glob pattern.',
    input_schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
  },
  {
    name: 'Grep',
    description: 'Search file contents.',
    input_schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
  },
  {
    name: 'Read',
    description: 'Read a file.',
    input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
  },
];

const cases = [
  ['基线: max_tokens=32  无 system 无 tools 非流式', { max: 32, system: false, tools: false, stream: false }],
  ['大 max_tokens=32000  无 system 无 tools 非流式', { max: 32000, system: false, tools: false, stream: false }],
  ['大 max_tokens=32000  带 system 无 tools 非流式', { max: 32000, system: true, tools: false, stream: false }],
  ['大 max_tokens=32000  带 system 带 tools 非流式', { max: 32000, system: true, tools: true, stream: false }],
  ['大 max_tokens=32000  带 system 带 tools 流式', { max: 32000, system: true, tools: true, stream: true }],
];

const SYSTEM = [
  {
    type: 'text',
    text: 'You are a codebase search specialist. Return file:line references, not code dumps.\n' + 'Rule: be precise. '.repeat(60),
    cache_control: { type: 'ephemeral' },
  },
];

console.log('═'.repeat(78));
console.log(`  经网关测试 — ${GW}  模型=scout`);
console.log('═'.repeat(78));

for (const [label, { max, system, tools: withTools, stream }] of cases) {
  const body = {
    model: 'scout',
    max_tokens: max,
    messages: [{ role: 'user', content: 'List the .js files under src in one line.' }],
  };
  if (system) body.system = SYSTEM;
  if (withTools) {
    body.tools = tools;
    body.tool_choice = { type: 'auto' };
  }
  if (stream) body.stream = true;

  const bytes = Buffer.byteLength(JSON.stringify(body));
  const t0 = Date.now();
  try {
    const res = await fetch(`${GW}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    const ms = Date.now() - t0;
    const text = await res.text();
    if (res.ok) {
      console.log(`  [OK]   ${label.padEnd(46)} ${String(bytes).padStart(6)}B  ${ms}ms`);
    } else {
      console.log(`  [FAIL] ${label.padEnd(46)} ${String(bytes).padStart(6)}B  ${ms}ms  HTTP ${res.status}  ${text.slice(0, 90).replace(/\s+/g, ' ')}`);
    }
  } catch (e) {
    console.log(`  [ERR]  ${label.padEnd(46)} ${String(bytes).padStart(6)}B  ${e.name}: ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 800));
}
