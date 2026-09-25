// Claude Code 入站头的透传，以及 GPT 上游的 Codex 风格头部 profile。
// 默认只转发真实入站请求中存在的值；Codex profile 则按真实 Codex 抓包
// 生成动态请求 ID，不复用任何真实客户端凭据。
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { modelSeries } from '../model-series.js';

const INSTALLATION_ID = process.env.CODEX_INSTALLATION_ID || randomUUID();
const CLIENT_HEADERS = new Set([
  'user-agent',
  'accept',
  'accept-encoding',
  'x-app',
]);
const DROP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization',
  'proxy-authenticate', 'transfer-encoding', 'te', 'trailer', 'upgrade',
  'content-length', 'content-encoding', 'expect', 'authorization', 'x-api-key',
]);

export function forwardEndToEndHeaders(incoming = {}) {
  const entries = incoming instanceof Headers ? [...incoming] : Object.entries(incoming);
  const connection = entries.find(([k]) => k.toLowerCase() === 'connection')?.[1];
  const nominated = new Set(String(connection ?? '').toLowerCase().split(',').map((s) => s.trim()));
  return Object.fromEntries(entries.flatMap(([name, value]) => {
    const lower = name.toLowerCase();
    return value === undefined || DROP_HEADERS.has(lower) || nominated.has(lower) ? []
      : [[lower, Array.isArray(value) ? value.join(', ') : value]];
  }));
}

export function forwardClientHeaders(incoming = {}) {
  return Object.fromEntries(Object.entries(forwardEndToEndHeaders(incoming)).filter(([name, value]) =>
    value !== '' && (CLIENT_HEADERS.has(name) || /^(x-stainless-|x-claude-|anthropic-)/.test(name)),
  ));
}

export function withExtraHeaders(headers, extra = {}) {
  const merged = new Headers(headers);
  new Headers(extra).forEach((value, name) => merged.set(name, value));
  return Object.fromEntries(merged);
}

export function resolveClientProfile(provider, targetModel, override) {
  const profile = override ?? provider.clientProfile ?? 'auto';
  return profile === 'auto' ? (modelSeries(targetModel) === 'openai' ? 'codex' : 'claude') : profile;
}

// Construct once outside the retry loop; safe retries remain the same logical turn.
export function createRequestProfile(provider, targetModel, override) {
  const clientProfile = resolveClientProfile(provider, targetModel, override);
  return { clientProfile, targetModel, ...(clientProfile === 'codex'
    ? { codexContext: createCodexContext(targetModel, provider.codexReasoningEffort) } : {}) };
}

function codexArch() {
  return process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch;
}

// Header profile captured from Codex CLI 0.155.0-alpha.16.4 on Windows.
// IDs are generated per request; live Codex session IDs are never copied.
export function createCodexContext(model, reasoningEffort = 'high') {
  const sessionId = randomUUID();
  const turnId = randomUUID();
  const contextWindowId = randomUUID();
  const startedAt = Date.now();
  const installationId = INSTALLATION_ID;
  const windowId = sessionId + ':0';
  const metadata = {
    installation_id: installationId,
    session_id: sessionId,
    thread_id: sessionId,
    agent_name: '/root',
    turn_id: turnId,
    window_id: windowId,
    window_number: 0,
    context_window_id: contextWindowId,
    request_kind: 'turn',
    root_turn_id: turnId,
    thread_source: 'user',
    sandbox: 'none',
    sandbox_mode: 'danger-full-access',
    auto_review_enabled: false,
    node_repl_auto_review_required: false,
    node_repl_disabled: false,
    turn_started_at_unix_ms: startedAt,
    analytics_enabled: true,
    model,
    reasoning_effort: reasoningEffort,
  };
  return { sessionId, turnId, installationId, windowId, metadata };
}

export function buildCodexHeaders(provider, context) {
  const version = provider.codexVersion ?? '0.155.0-alpha.16.4';
  const originator = provider.codexOriginator ?? 'Codex Desktop';
  const platform = process.platform === 'win32' ? os.version() : process.platform + ' ' + os.release();
  const userAgent = originator + '/' + version + ' (' + platform + '; ' + codexArch() + ') dumb (codex_exec; ' + version + ')';
  return withExtraHeaders({
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...(provider.apiKey ? { authorization: 'Bearer ' + provider.apiKey } : {}),
    originator,
    'user-agent': userAgent,
    'x-codex-beta-features': provider.codexBetaFeatures ?? 'remote_compaction_v2',
    'x-codex-window-id': context.windowId,
    'x-codex-installation-id': context.installationId,
    'x-codex-turn-metadata': JSON.stringify(context.metadata),
    'x-client-request-id': context.sessionId,
    'session-id': context.sessionId,
    'thread-id': context.sessionId,
  }, provider.extraHeaders);
}
