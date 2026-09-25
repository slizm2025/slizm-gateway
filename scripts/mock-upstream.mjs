// 模拟一个"账号池被占满"的上游：前 N 次请求回 429 + retry-after，之后成功。
// 用来验证网关的退避重试是否真的按上游要求等待，而不是立即把 429 甩给 Claude Code。
import http from 'node:http';

const PORT = Number(process.argv[2] ?? 4198);
const FAIL_TIMES = Number(process.argv[3] ?? 2);
const RETRY_AFTER = Number(process.argv[4] ?? 1); // 秒

let hits = 0;
const seen = [];

const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    hits++;
    const t = new Date().toISOString().slice(11, 23);
    if (hits <= FAIL_TIMES) {
      seen.push({ hit: hits, at: t, result: `429 retry-after:${RETRY_AFTER}` });
      console.error(`  [mock] 第 ${hits} 次 → 429 (retry-after: ${RETRY_AFTER}s) @${t}`);
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(RETRY_AFTER) });
      res.end(JSON.stringify({ error: { message: 'All available accounts exhausted', type: 'server_error' } }));
      return;
    }
    seen.push({ hit: hits, at: t, result: '200 OK' });
    console.error(`  [mock] 第 ${hits} 次 → 200 OK @${t}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'mock-1',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'mock ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
  });
});

srv.listen(PORT, '127.0.0.1', () => console.error(`[mock] 上游已起 on ${PORT}, 前 ${FAIL_TIMES} 次返回 429`));

process.on('SIGTERM', () => {
  console.error('[mock] 收到的请求序列:', JSON.stringify(seen));
  process.exit(0);
});
