// 判定 relay 的 claude_code_required 到底在查什么。
// 变量只保留一个：system 提示词。请求头与 body 其余部分全部走网关同一条代码路径。
// 用法: node scripts/test-relay-admission.mjs [模型名]
import { loadConfig, redact } from '../src/config.js';
import * as anthropic from '../src/providers/anthropic.js';

const model = process.argv[2] ?? 'claude-opus-5-5';
const cfg = loadConfig();
const relay = cfg.providers.get('relay');

const CC_MARK = "You are Claude Code, Anthropic's official CLI for Claude.";

const CC_BETA =
  'claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14';

const incoming = {
  'anthropic-version': '2023-06-01',
  'anthropic-beta': CC_BETA,
  accept: 'application/json',
  'user-agent': 'claude-cli/2.1.251 (external, cli)',
  'x-app': 'cli',
};

const base = {
  model,
  max_tokens: 16,
  messages: [{ role: 'user', content: 'reply with the single word: ok' }],
  stream: false,
};

const variants = [
  ['A 无 system（基线）', { ...base }],
  ['B system 带 CC 标识', { ...base, system: CC_MARK }],
  [
    'C system 为块数组',
    {
      ...base,
      system: [
        { type: 'text', text: CC_MARK, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'You are an interactive CLI tool.' },
      ],
    },
  ],
];

console.log('═'.repeat(72));
console.log(`  目标: ${relay.baseUrl}   模型: ${model}`);
console.log(`  key : ${relay.apiKey ? '[已配置]' : '[未配置]'}`);
console.log('═'.repeat(72));

for (const [label, body] of variants) {
  const t0 = Date.now();
  try {
    const res = await anthropic.callMessages(relay, body, incoming, AbortSignal.timeout(90_000));
    const text = await res.text();
    const ms = Date.now() - t0;
    if (res.ok) {
      let note = '';
      try {
        note = JSON.parse(text).content?.[0]?.text?.slice(0, 60) ?? '';
      } catch {
        note = text.slice(0, 60);
      }
      console.log(`  [放行] ${label.padEnd(24)} ${ms}ms  ${note.replace(/\s+/g, ' ')}`);
    } else {
      let code = '';
      try {
        code = JSON.parse(text).error?.code ?? '';
      } catch {
        /* 保持空 */
      }
      console.log(`  [拦截] ${label.padEnd(24)} ${ms}ms  HTTP ${res.status} ${code}`);
    }
  } catch (e) {
    console.log(`  [异常] ${label.padEnd(24)} ${e.name}: ${redact(e.message)}`);
  }
}
