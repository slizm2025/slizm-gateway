import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenAIHeaders, buildResponsesHeaders } from '../src/providers/openai.js';
import { buildHeaders } from '../src/providers/anthropic.js';
import { detectClient, createRequestProfile } from '../src/providers/client-headers.js';

const provider = {
  name: 'fixture',
  apiKey: 'upstream-secret',
  extraHeaders: {},
  codexVersion: '0.155.0-alpha.16.4',
  codexOriginator: 'Codex Desktop',
};

const claudeCodeHeaders = {
  'user-agent': 'claude-cli/2.1.280 (external, cli)',
  accept: 'application/json',
  'accept-encoding': 'gzip, deflate, br',
  'x-app': 'cli',
  'x-stainless-package-version': 'fixture',
  'x-claude-code-session-id': 'claude-session',
  authorization: 'Bearer client-secret',
};

const codexHeaders = {
  'user-agent': 'Codex Desktop/0.155.0-alpha.16.4 (Windows; x86_64) dumb (codex_exec; 0.155.0-alpha.16.4)',
  originator: 'Codex Desktop',
  'x-codex-installation-id': 'codex-installation',
  'x-client-request-id': 'codex-request',
  'x-codex-window-id': 'codex-window',
  'x-codex-turn-metadata': '{"model":"gpt-6-sol"}',
  accept: 'text/event-stream',
};

// 真实 DeepSeek Harness 客户端（@deepseek-ai/dsh-llm 0.2.0-rc.2 +
// dsh-llm-deepseek 0.2.0-rc.2）的 Messages 请求头：
// attribution 的 User-Agent、每个请求都带的 x-deepseek-harness-user-id，
// 加上可由 api-key 或账户提供方提供的客户端凭据。
const deepSeekHarnessHeaders = {
  'user-agent': 'deepseek-harness/0.2.0-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)',
  'content-type': 'application/json',
  accept: 'text/event-stream',
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'mid-conversation-tool-changes-2026-07-01',
  'x-deepseek-harness-user-id': 'anonymous-user-fixture',
  'x-deepseek-harness-session-id': 'session-fixture',
  'x-api-key': 'harness-client-token',
};

test('Claude Code -> GPT keeps the existing Codex fingerprint behavior', () => {
  const headers = buildOpenAIHeaders(provider, claudeCodeHeaders, { targetModel: 'gpt-6-astra' });

  assert.equal(headers.originator, 'Codex Desktop');
  assert.match(headers['user-agent'], /^Codex Desktop\/0\.155\.0-alpha\.16\.4 \(/);
  assert.ok(headers['x-codex-installation-id']);
  assert.ok(headers['x-client-request-id']);
  assert.equal(headers['x-app'], undefined);
  assert.equal(headers['x-stainless-package-version'], undefined);
  assert.equal(headers['x-claude-code-session-id'], undefined);
  assert.equal(headers.authorization, 'Bearer upstream-secret');
});

test('Claude Code session affinity is stable, scoped and separate from request IDs', () => {
  const profile = (p = provider, model = 'gpt-test', incoming = claudeCodeHeaders) => createRequestProfile(p, model, undefined, incoming);
  const first = profile();
  const next = profile();
  assert.equal(first.codexContext.sessionId, next.codexContext.sessionId);
  assert.notEqual(first.codexContext.sessionId, claudeCodeHeaders['x-claude-code-session-id']);
  assert.notEqual(first.codexContext.turnId, next.codexContext.turnId);
  assert.equal(buildOpenAIHeaders(provider, claudeCodeHeaders, first)['x-client-request-id'], first.codexContext.turnId);
  assert.equal(buildOpenAIHeaders(provider, claudeCodeHeaders, first)['session-id'], first.codexContext.sessionId);
  for (const changed of [
    profile({ ...provider, name: 'other' }),
    profile(provider, 'gpt-other'),
    profile(provider, 'gpt-test', { ...claudeCodeHeaders, authorization: 'Bearer other' }),
    profile(provider, 'gpt-test', { ...claudeCodeHeaders, 'x-claude-code-session-id': 'other-session' }),
  ]) assert.notEqual(first.codexContext.sessionId, changed.codexContext.sessionId);
  const absent = { ...claudeCodeHeaders };
  delete absent['x-claude-code-session-id'];
  assert.notEqual(profile(provider, 'gpt-test', absent).codexContext.sessionId, profile(provider, 'gpt-test', absent).codexContext.sessionId);
});

test('a non-Claude client can target GPT without being forced into Codex', () => {
  const headers = buildOpenAIHeaders(
    provider,
    deepSeekHarnessHeaders,
    { targetModel: 'gpt-6-sol' },
  );

  assert.equal(headers['user-agent'], deepSeekHarnessHeaders['user-agent']);
  assert.equal(headers['x-deepseek-harness-user-id'], deepSeekHarnessHeaders['x-deepseek-harness-user-id']);
  assert.equal(headers.originator, undefined);
  assert.equal(headers['x-codex-installation-id'], undefined);
  assert.equal(headers.authorization, 'Bearer upstream-secret');
});

test('an explicit Codex provider profile does not replace an authentic Codex identity', () => {
  const headers = buildOpenAIHeaders(
    { ...provider, clientProfile: 'codex' },
    codexHeaders,
    { targetModel: 'gpt-6-sol' },
  );
  assert.equal(headers['user-agent'], codexHeaders['user-agent']);
  assert.equal(headers['x-codex-installation-id'], codexHeaders['x-codex-installation-id']);
  assert.equal(headers.originator, codexHeaders.originator);
});

test('ordinary pass-through providers preserve the original client fingerprint', () => {
  const headers = buildHeaders(
    { ...provider, apiType: 'anthropic' },
    codexHeaders,
    { targetModel: 'deepseek-chat', clientProfile: 'claude' },
  );

  for (const [name, value] of Object.entries(codexHeaders)) {
    assert.equal(headers[name], value, `header ${name} should pass through unchanged`);
  }
  assert.equal(headers.authorization, 'Bearer upstream-secret');
  assert.equal(headers['x-api-key'], undefined);
});

test('Codex and DeepSeek Harness fingerprints remain distinguishable through pass-through', () => {
  const cases = [
    ['Codex', codexHeaders, { originator: 'Codex Desktop', 'x-codex-installation-id': 'codex-installation' }],
    ['DeepSeek Harness', deepSeekHarnessHeaders, {
      'user-agent': deepSeekHarnessHeaders['user-agent'],
      'x-deepseek-harness-user-id': 'anonymous-user-fixture',
      'x-deepseek-harness-session-id': 'session-fixture',
      'anthropic-beta': 'mid-conversation-tool-changes-2026-07-01',
    }],
  ];

  for (const [name, incoming, markers] of cases) {
    const headers = buildHeaders(
      { ...provider, apiType: 'anthropic' },
      incoming,
      { targetModel: 'deepseek-chat', clientProfile: 'claude' },
    );

    for (const [header, value] of Object.entries(markers)) {
      assert.equal(headers[header], value, `${name} marker ${header} should remain observable`);
    }
    for (const [header, value] of Object.entries(incoming)) {
      if (header === 'x-api-key') continue; // 客户端凭据换成上游 key，不参与指纹
      assert.equal(headers[header], value, `${name} header ${header} should pass through unchanged`);
    }
  }
});

test('Anthropic transport preserves Claude Code headers for GPT target models', () => {
  const headers = buildHeaders(
    { ...provider, apiType: 'anthropic', clientProfile: 'auto' },
    claudeCodeHeaders,
    { targetModel: 'gpt-6-sol' },
  );
  assert.equal(headers['user-agent'], claudeCodeHeaders['user-agent']);
  assert.equal(headers['x-app'], claudeCodeHeaders['x-app']);
  assert.equal(headers['x-stainless-package-version'], claudeCodeHeaders['x-stainless-package-version']);
  assert.equal(headers['x-claude-code-session-id'], claudeCodeHeaders['x-claude-code-session-id']);
  assert.equal(headers.originator, undefined);
  assert.equal(headers.authorization, 'Bearer upstream-secret');
});

test('Native Responses passthrough preserves raw end-to-end headers, empty values, session/thread IDs, and rejects spoofing extraHeaders', () => {
  const incoming = {
    'user-agent': 'Codex Desktop/0.155.0-alpha.16.4 (Windows; x86_64) dumb (codex_exec; 0.155.0-alpha.16.4)',
    originator: 'Codex Desktop',
    'x-codex-installation-id': 'client-installation-id',
    'x-codex-window-id': 'client-window-id',
    'x-codex-turn-metadata': '{"model":"gpt-6-sol","custom":true}',
    'session-id': 'client-session-123',
    'thread-id': 'client-thread-456',
    'x-client-request-id': 'client-req-789',
    'x-empty-trace': '',
    authorization: 'Bearer gateway-client-token',
    'x-api-key': 'gateway-client-api-key',
    connection: 'close, x-hop-header',
    'x-hop-header': 'hop-value',
  };

  const maliciousOrRoutingProvider = {
    ...provider,
    apiKey: 'upstream-responses-secret',
    extraHeaders: {
      'user-agent': 'spoofed-ua',
      originator: 'spoofed-originator',
      'session-id': 'spoofed-session',
      'thread-id': 'spoofed-thread',
      'x-request-id': 'spoofed-req',
      'x-client-request-id': 'spoofed-client-req',
      'x-codex-turn-metadata': 'spoofed-metadata',
      'x-claude-code-session-id': 'spoofed-claude-session',
      'x-stainless-os': 'spoofed-os',
      authorization: 'Bearer spoofed-auth',
      'x-api-key': 'spoofed-key',
      'x-hop-header': 'spoofed-hop',
      connection: 'keep-alive',
      'x-upstream-region': 'us-east-1',
      'x-custom-routing-tag': 'route-a',
    },
  };

  const headers = buildResponsesHeaders(maliciousOrRoutingProvider, incoming);

  // 1. Raw end-to-end headers preserved as-is
  assert.equal(headers['user-agent'], incoming['user-agent']);
  assert.equal(headers.originator, 'Codex Desktop');
  assert.equal(headers['x-codex-installation-id'], 'client-installation-id');
  assert.equal(headers['x-codex-window-id'], 'client-window-id');
  assert.equal(headers['x-codex-turn-metadata'], incoming['x-codex-turn-metadata']);
  assert.equal(headers['session-id'], 'client-session-123');
  assert.equal(headers['thread-id'], 'client-thread-456');
  assert.equal(headers['x-client-request-id'], 'client-req-789');

  // 2. Empty raw header is preserved (forwardEndToEndHeaders preserves empty string, unlike forwardClientHeaders)
  assert.equal(headers['x-empty-trace'], '');

  // 3. Gateway auth removed and replaced with provider.apiKey Bearer token
  assert.equal(headers.authorization, 'Bearer upstream-responses-secret');
  assert.equal(headers['x-api-key'], undefined);

  // 4. Hop-by-hop headers removed (both drop-headers and nominated connection headers)
  assert.equal(headers.connection, undefined);
  assert.equal(headers['x-hop-header'], undefined);

  // 5. extraHeaders cannot forge/override fingerprint, identity, session or auth headers
  assert.equal(headers['x-request-id'], undefined);
  assert.equal(headers['x-claude-code-session-id'], undefined);
  assert.equal(headers['x-stainless-os'], undefined);

  // 6. Safe upstream auxiliary routing headers from extraHeaders are retained
  assert.equal(headers['x-upstream-region'], 'us-east-1');
  assert.equal(headers['x-custom-routing-tag'], 'route-a');
});

test('buildOpenAIHeaders existing logic and extraHeaders behavior remain intact', () => {
  const providerWithExtra = {
    ...provider,
    apiKey: 'key-123',
    extraHeaders: {
      'x-custom-extra': 'custom-value',
    },
  };

  const headers = buildOpenAIHeaders(providerWithExtra, deepSeekHarnessHeaders, { targetModel: 'gpt-6-sol' });
  assert.equal(headers['user-agent'], deepSeekHarnessHeaders['user-agent']);
  assert.equal(headers['x-custom-extra'], 'custom-value');
  assert.equal(headers.authorization, 'Bearer key-123');
});

// 识别矩阵：依据真实客户端实际发出的头，而不是猜想的字段。
test('detectClient identifies the shipped DeepSeek Harness fingerprint', () => {
  assert.equal(detectClient(deepSeekHarnessHeaders), 'deepseek-harness');
  // 账户登录的 DSH 客户端只带 x-dsh-auth-token，没有 x-api-key。
  const accountAuth = { ...deepSeekHarnessHeaders };
  delete accountAuth['x-api-key'];
  accountAuth['x-dsh-auth-token'] = 'account-token';
  assert.equal(detectClient(accountAuth), 'deepseek-harness');
  // User-Agent 允许白标改写：只有 x-deepseek-harness-* 头时仍必须识别为 DSH。
  assert.equal(
    detectClient({ ...deepSeekHarnessHeaders, 'user-agent': 'white-label-agent/1.2.3' }),
    'deepseek-harness',
  );
  // 只有 UA 的路径（llm-pi-ai 适配器不发 x-deepseek-harness-*）。
  assert.equal(detectClient({ 'user-agent': 'deepseek-harness/0.2.0-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)' }), 'deepseek-harness');
  // 历史日志里的空格写法。
  assert.equal(detectClient({ 'user-agent': 'DeepSeek Harness/1.0' }), 'deepseek-harness');
});

test('detectClient does not let Harness markers fall into other agents', () => {
  // DSH 同时带 Anthropic 风格的头，也不能被 CLI 启发式抢走。
  assert.equal(
    detectClient({ ...deepSeekHarnessHeaders, 'x-app': 'cli', 'x-stainless-package-version': '0.68.0' }),
    'deepseek-harness',
  );
  assert.equal(detectClient(claudeCodeHeaders), 'claude-code');
  assert.equal(detectClient(codexHeaders), 'codex');
  assert.equal(detectClient({ 'user-agent': 'DeepSeek/1.0' }), 'deepseek');
  assert.equal(detectClient({ 'x-deepseek-request-id': 'plain' }), 'deepseek');
  assert.equal(detectClient({ 'user-agent': 'ExampleClient/1.0' }), 'unknown');
  // 未经验证的 x-harness-* 前缀不再算作 DSH。
  assert.equal(detectClient({ 'x-harness-trace': 'other-tool' }), 'unknown');
});

test('the DSH account credential never reaches an upstream', () => {
  const incoming = {
    ...deepSeekHarnessHeaders,
    'x-dsh-auth-token': 'account-token',
    authorization: 'Bearer gateway-client-token',
  };
  for (const build of [
    () => buildHeaders({ ...provider, apiType: 'anthropic' }, incoming),
    () => buildOpenAIHeaders(provider, incoming, { targetModel: 'gpt-6-sol' }),
    () => buildResponsesHeaders(provider, incoming),
  ]) {
    const headers = build();
    assert.equal(headers['x-dsh-auth-token'], undefined);
    assert.equal(headers['x-api-key'], undefined);
  }
  // DSH 自己的请求头（含会话标识）仍按原样透传。
  const forwarded = buildHeaders({ ...provider, apiType: 'anthropic' }, incoming);
  assert.equal(forwarded['x-deepseek-harness-session-id'], 'session-fixture');
  assert.equal(forwarded.authorization, 'Bearer upstream-secret');
});

