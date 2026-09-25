// 回归测试：Claude Code 入站请求命中 openai provider 时，
// 上游仍收到 Chat Completions 请求体，但请求头使用真实 Codex 风格；
// OpenAI 完成结果仍能转换成 Claude Code 的 Anthropic message。
import assert from 'node:assert/strict';
import http from 'node:http';
import { callOpenAI, buildOpenAIBody, toAnthropicResponse } from '../src/providers/openai.js';

const port = 4218;
const seen = { method: null, url: null, headers: null, body: null };

const upstream = http.createServer((req, res) => {
  seen.method = req.method;
  seen.url = req.url;
  seen.headers = req.headers;
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    seen.body = JSON.parse(raw);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-codex-adapter-test',
        choices: [{ index: 0, message: { role: 'assistant', content: '适配成功' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 7 },
      }),
    );
  });
});

await new Promise((resolve) => upstream.listen(port, '127.0.0.1', resolve));

try {
  const provider = {
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'sk-test-openai',
    codexVersion: '0.155.0-alpha.16.4',
    codexOriginator: 'Codex Desktop',
    codexBetaFeatures: 'remote_compaction_v2',
    codexReasoningEffort: 'high',
    extraHeaders: {},
  };
  const claudeBody = {
    model: 'gpt-6-sol',
    max_tokens: 64,
    stream: false,
    system: 'You are concise.',
    messages: [{ role: 'user', content: 'hello' }],
  };

  const response = await callOpenAI(
    provider,
    claudeBody,
    'gpt-6-sol',
    AbortSignal.timeout(3000),
    {
      'user-agent': 'claude-code-test',
      'x-app': 'claude-code',
      'x-stainless-package-version': 'should-not-leak',
    },
    { clientProfile: 'codex' },
  );
  const openaiResult = await response.json();
  const anthropicResult = toAnthropicResponse(openaiResult, 'gpt-6-sol');

  assert.equal(seen.method, 'POST');
  assert.equal(seen.url, '/chat/completions');
  assert.equal(seen.headers.authorization, 'Bearer sk-test-openai');
  assert.equal(seen.headers.originator, 'Codex Desktop');
  assert.match(seen.headers['user-agent'], /^Codex Desktop\/0\.155\.0-alpha\.16\.4 \(/);
  assert.match(seen.headers['user-agent'], /dumb \(codex_exec; 0\.155\.0-alpha\.16\.4\)$/);
  assert.equal(seen.headers.accept, 'text/event-stream');
  assert.ok(seen.headers['x-codex-beta-features']);
  assert.ok(seen.headers['x-codex-window-id']);
  assert.ok(seen.headers['x-codex-installation-id']);
  assert.ok(seen.headers['x-codex-turn-metadata']);
  assert.ok(seen.headers['x-client-request-id']);
  assert.ok(seen.headers['session-id']);
  assert.ok(seen.headers['thread-id']);
  assert.equal(seen.headers['x-app'], undefined);
  assert.equal(seen.headers['x-stainless-package-version'], undefined);
  assert.deepEqual(seen.body, buildOpenAIBody(claudeBody, 'gpt-6-sol'));
  assert.equal(anthropicResult.type, 'message');
  assert.equal(anthropicResult.role, 'assistant');
  assert.equal(anthropicResult.content[0].text, '适配成功');
  assert.equal(anthropicResult.stop_reason, 'end_turn');
  assert.deepEqual(anthropicResult.usage, { input_tokens: 5, output_tokens: 7 });

  console.log('✓ Codex 请求头、Chat Completions 请求体、Claude Code 返回转换均通过');
} finally {
  upstream.close();
}
