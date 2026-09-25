// 把 anthropic 适配器实际发出的请求原样打给本地抓包服务器，用于核对请求头。
// 用法: node scripts/dump-headers.mjs [抓包地址]   默认 http://127.0.0.1:4199
import * as anthropic from '../src/providers/anthropic.js';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:4199';

const provider = {
  name: 'probe',
  apiType: 'anthropic',
  baseUrl,
  apiKey: 'probe-key-not-real',
  authStyle: 'auto',
  extraHeaders: {},
  models: {},
};

// 模拟 Claude Code 发来的请求头（取自真实 CLI 流量）
const incoming = {
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14',
  accept: 'application/json',
  'user-agent': 'claude-cli/2.1.251 (external, cli)',
  'x-app': 'cli',
  'x-stainless-lang': 'js',
  'x-stainless-package-version': '0.68.0',
  'x-stainless-runtime': 'node',
  'x-stainless-runtime-version': 'v22.14.0',
};

const body = {
  model: 'claude-opus-5-5',
  max_tokens: 32,
  messages: [{ role: 'user', content: 'ping' }],
  stream: false,
};

const res = await anthropic.callMessages(provider, body, incoming, AbortSignal.timeout(10_000));
console.log('上游响应状态:', res.status, await res.text());
