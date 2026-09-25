// 回归测试：Claude Code 的 Accept 通常是 application/json，但 stream=true 仍必须返回 SSE。
// 假上游故意忽略 stream=true 返回完整 Anthropic JSON，网关应兼容转换为事件流。
import http from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const UP_PORT = 4196;
const GW_PORT = 4197;
const TOKEN = 'sk-anthropic-compat-test';
const cfgFile = join(ROOT, 'anthropic-compat-providers.json');

let upstreamAccept = null;
const upstream = http.createServer((req, res) => {
  upstreamAccept = req.headers.accept;
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'msg-fake',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: '兼容成功' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 2, output_tokens: 3 },
      }),
    );
  });
});

await new Promise((resolve) => upstream.listen(UP_PORT, '127.0.0.1', resolve));
writeFileSync(
  cfgFile,
  JSON.stringify({
    clientToken: TOKEN,
    providers: [{ name: 'fake-anthropic', apiType: 'anthropic', baseUrl: `http://127.0.0.1:${UP_PORT}`, apiKey: 'sk-fake' }],
    routes: { any: { provider: 'fake-anthropic', model: 'claude-opus-5-5' } },
  }),
);

const gateway = spawn(process.execPath, [join(ROOT, 'src', 'server.js')], {
  cwd: ROOT,
  env: { ...process.env, GATEWAY_CONFIG: cfgFile, GATEWAY_PORT: String(GW_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let logs = '';
gateway.stdout.on('data', (chunk) => (logs += chunk));
gateway.stderr.on('data', (chunk) => (logs += chunk));

let ready = false;
for (let i = 0; i < 40; i++) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  try {
    const health = await fetch(`http://127.0.0.1:${GW_PORT}/health`, { signal: AbortSignal.timeout(500) });
    if (health.ok) {
      ready = true;
      break;
    }
  } catch {
    /* 等待启动 */
  }
}

let result = { ok: false, status: 0, contentType: '', text: '' };
if (ready) {
  const response = await fetch(`http://127.0.0.1:${GW_PORT}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: 'any', max_tokens: 8, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  result = {
    ok: response.ok,
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    text: await response.text(),
  };
}

upstream.closeAllConnections();
upstream.close();
gateway.kill();
await new Promise((resolve) => setTimeout(resolve, 100));
try {
  unlinkSync(cfgFile);
} catch {
  /* 测试失败时保留不了也不影响判定 */
}

const events = [...result.text.matchAll(/^event: ([^\r\n]+)/gm)].map((match) => match[1]);
const pass = [
  ['网关启动', ready, logs.slice(-500)],
  // 默认原样透传 Claude Code 的 accept（与直连一致）；上游回 JSON 时由网关转成 SSE
  ['上游收到原样 Accept', upstreamAccept === 'application/json', `actual=${upstreamAccept}`],
  ['客户端收到 SSE content-type', result.contentType.includes('text/event-stream'), `actual=${result.contentType}`],
  ['包含完整 Anthropic 事件序列', events.includes('message_start') && events.includes('content_block_delta') && events.includes('message_stop'), events.join(',')],
  ['包含上游文本', result.text.includes('兼容成功'), result.text.slice(0, 300)],
];

let failed = 0;
for (const [name, ok, detail] of pass) {
  console.log(`${ok ? '\x1b[32m✓' : '\x1b[31m✗'}\x1b[0m ${name}${ok ? '' : ` (${detail})`}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
