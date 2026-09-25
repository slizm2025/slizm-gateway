// 定位 scout 路由 503 的受控测试。
// 变量逐个放开：请求大小 -> tools -> stream，找出触发"no available accounts"的条件。
import { loadConfig } from '../src/config.js';
import * as openai from '../src/providers/openai.js';

const cfg = loadConfig();
const p = cfg.providers.get('gemini');
const MODEL = 'gemini-3.8-flash-high';

const filler = 'The quick brown fox jumps over the lazy dog. '.repeat(1);

// 造一个像样的工具定义（贴近真实子 agent 请求）
const tools = [
  {
    name: 'Glob',
    description: 'Find files by glob pattern in the repository.',
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string' }, path: { type: 'string' } },
      required: ['pattern'],
    },
  },
  {
    name: 'Grep',
    description: 'Search file contents with a regular expression.',
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string' }, glob: { type: 'string' } },
      required: ['pattern'],
    },
  },
  {
    name: 'Read',
    description: 'Read a file from the local filesystem.',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' } },
      required: ['file_path'],
    },
  },
];

const cases = [
  ['小请求 / 无 tools / 非流式', { pad: 0, tools: false, stream: false }],
  ['大请求 / 无 tools / 非流式', { pad: 400, tools: false, stream: false }],
  ['小请求 / 带 tools / 非流式', { pad: 0, tools: true, stream: false }],
  ['大请求 / 带 tools / 非流式', { pad: 400, tools: true, stream: false }],
  ['小请求 / 带 tools / 流式', { pad: 0, tools: true, stream: true }],
  ['大请求 / 带 tools / 流式', { pad: 400, tools: true, stream: true }],
];

const one = (pad) => [{ type: 'text', text: filler + 'x'.repeat(pad) }];

console.log('═'.repeat(74));
console.log(`  受控测试 — provider=gemini  模型=${MODEL}`);
console.log('═'.repeat(74));

for (const [label, { pad, tools: withTools, stream }] of cases) {
  const body = {
    model: MODEL,
    max_tokens: 32,
    messages: [{ role: 'user', content: one(pad) }],
    stream,
  };
  if (withTools) body.tools = tools;

  const payload = openai.buildOpenAIBody(body, MODEL);
  const bytes = Buffer.byteLength(JSON.stringify(payload));
  const t0 = Date.now();

  try {
    const res = await fetch(`${p.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: openai.buildOpenAIHeaders(p),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60_000),
    });
    const ms = Date.now() - t0;
    if (res.ok) {
      await res.text(); // 消费掉，避免连接悬挂
      console.log(`  [OK]   ${label.padEnd(30)} ${String(bytes).padStart(6)}B  ${ms}ms`);
    } else {
      const t = (await res.text()).slice(0, 110).replace(/\s+/g, ' ');
      console.log(`  [FAIL] ${label.padEnd(30)} ${String(bytes).padStart(6)}B  ${ms}ms  HTTP ${res.status}  ${t}`);
    }
  } catch (e) {
    console.log(`  [ERR]  ${label.padEnd(30)} ${String(bytes).padStart(6)}B  ${e.name}: ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 700)); // 别把上游打爆
}
