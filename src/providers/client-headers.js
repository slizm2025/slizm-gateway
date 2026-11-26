// Claude Code 入站头的透传，以及 GPT 上游的 Codex 风格头部 profile。
// 默认只转发真实入站请求中存在的值；Codex profile 则按真实 Codex 抓包
// 生成动态请求 ID，不复用任何真实客户端凭据。
import os from 'node:os';
import { randomUUID, createHmac } from 'node:crypto';
import { modelSeries } from '../model-series.js';

const INSTALLATION_ID = process.env.CODEX_INSTALLATION_ID || randomUUID();
const SESSION_SALT = randomUUID();
const DROP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization',
  'proxy-authenticate', 'transfer-encoding', 'te', 'trailer', 'upgrade',
  'content-length', 'content-encoding', 'expect', 'authorization', 'x-api-key',
  // DeepSeek Harness 的账户凭据只对 DeepSeek 账户平台有效，等同于客户端凭据，
  // 必须和 authorization / x-api-key 一样换成上游自己的 key，不能转发出去。
  'x-dsh-auth-token',
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
  // Preserve the actual client fingerprint as far as the transport allows.
  // Credentials and hop-by-hop headers were already removed by the helper.
  return Object.fromEntries(Object.entries(forwardEndToEndHeaders(incoming)).filter(([, value]) => value !== ''));
}

export function withExtraHeaders(headers, extra = {}) {
  const merged = new Headers(headers);
  new Headers(extra).forEach((value, name) => merged.set(name, value));
  return Object.fromEntries(merged);
}

function hasHeaderPrefix(incoming, prefix) {
  return [...new Headers(incoming).keys()].some((name) => name.startsWith(prefix));
}

// DeepSeek Harness 的请求指纹，取自实际在用的客户端
// (@deepseek-ai/dsh-llm 0.2.0-rc.2 / @deepseek-ai/dsh-llm-deepseek 0.2.0-rc.2)：
//   user-agent: deepseek-harness/<version> (+https://github.com/deepseek-ai/deepseek-harness)
//   x-deepseek-harness-user-id: <匿名用户 ID>      —— 每个 Messages 请求都带
//   x-deepseek-harness-session-id / x-deepseek-harness-compact: 1 —— 可选
//   x-api-key（dsh-llm-deepseek-api-key）或 x-dsh-auth-token（dsh-llm-deepseek-account）
// UA 的产品标识可以被白标部署改写，所以只把 UA 当作其中一条线索；
// dsh-llm-deepseek 自带的 x-deepseek-harness-* 头才是稳定指纹。
const HARNESS_USER_AGENT = /(?:^|[\s/])deepseek[-_ ]?harness(?:[/\s(]|$)/;
const CLAUDE_CODE_USER_AGENT = /(?:^|[\s/])claude(?:-code|-cli)?(?:[/\s]|$)/;
const CODEX_USER_AGENT = /(?:^|[\s/])codex(?:[/\s-]|$)/;

/** 置信度最高的 DeepSeek Harness 线索：只有该客户端的适配器会发出这些头。 */
function hasHarnessMarker(headers, incoming) {
  const nonEmpty = (name) => Boolean((headers.get(name) ?? '').trim());
  return hasHeaderPrefix(incoming, 'x-deepseek-harness-')
    || nonEmpty('x-deepseek-harness')
    || nonEmpty('x-dsh-auth-token')
    || headers.get('x-client-name')?.toLowerCase() === 'deepseek-harness';
}

/** Identify the calling agent from its original request headers. */
export function detectClient(incoming = {}) {
  const headers = new Headers(incoming);
  const ua = (headers.get('user-agent') ?? '').toLowerCase();
  const app = (headers.get('x-app') ?? '').toLowerCase();

  // DeepSeek Harness 先判：它的专属头不可能出现在 Claude Code / Codex 上，
  // 而它自己也可能同时带 Anthropic SDK 或 CLI 风格的头，不能被后面的通用规则抢走。
  if (HARNESS_USER_AGENT.test(ua) || hasHarnessMarker(headers, incoming)) return 'deepseek-harness';

  if (
    CLAUDE_CODE_USER_AGENT.test(ua)
    || headers.has('x-claude-code-session-id')
    || (app === 'cli' && (headers.has('anthropic-version') || hasHeaderPrefix(incoming, 'x-stainless-')))
  ) return 'claude-code';

  if (
    CODEX_USER_AGENT.test(ua)
    || headers.has('originator')
    || hasHeaderPrefix(incoming, 'x-codex-')
  ) return 'codex';

  if (/deepseek/.test(ua) || hasHeaderPrefix(incoming, 'x-deepseek-')) return 'deepseek';
  return 'unknown';
}

export function resolveClientProfile(provider, targetModel, override, incoming = {}) {
  const profile = override ?? provider.clientProfile ?? 'auto';
  const clientType = detectClient(incoming);
  // An explicit Codex profile is still useful for Claude Code and unknown
  // callers, but never replace an already-authentic Codex/DeepSeek identity.
  if (profile !== 'auto') return profile === 'codex' && clientType !== 'claude-code' && clientType !== 'unknown' ? 'claude' : profile;
  // This is the one intentional fingerprint change: Claude Code loses cache
  // efficiency when it calls GPT through a Claude-shaped upstream request.
  return clientType === 'claude-code' && modelSeries(targetModel) === 'openai' ? 'codex' : 'claude';
}

// Construct once outside the retry loop; safe retries remain the same logical turn.
export function createRequestProfile(provider, targetModel, override, incoming = {}) {
  const clientType = detectClient(incoming);
  const clientProfile = resolveClientProfile(provider, targetModel, override, incoming);
  const headers = new Headers(incoming);
  const clientSession = clientType === 'claude-code' ? headers.get('x-claude-code-session-id')?.trim() : undefined;
  const sessionId = clientSession ? createHmac('sha256', SESSION_SALT)
    .update(JSON.stringify([provider.name ?? '', targetModel, headers.get('authorization'), headers.get('x-api-key'), clientSession]))
    .digest('hex').slice(0, 32).replace(/^(\w{8})(\w{4})(\w{4})(\w{4})(\w{12})$/, '$1-$2-$3-$4-$5') : undefined;
  return { clientProfile, clientType, targetModel, ...(clientProfile === 'codex'
    ? { codexContext: createCodexContext(targetModel, provider.codexReasoningEffort, sessionId) } : {}) };
}

function codexArch() {
  return process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch;
}

// Header profile captured from Codex CLI 0.155.0-alpha.16.4 on Windows.
// Session affinity uses an opaque client-scoped ID; turn IDs remain independent.
export function createCodexContext(model, reasoningEffort = 'high', sessionId = randomUUID()) {
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
    'x-client-request-id': context.turnId,
    'session-id': context.sessionId,
    'thread-id': context.sessionId,
  }, provider.extraHeaders);
}
