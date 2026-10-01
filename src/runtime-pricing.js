// An optional synchronous commit switches validated gateway configuration with pricing.
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, watch } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { normalizePricing, normalizeMultipliers, resolveMultiplier } from './pricing.js';
import { env } from './config.js';

const hash = (text) => createHash('sha256').update(text).digest('hex');
const canonical = (value) => JSON.stringify(value, function (_key, v) {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]])) : v;
});
const problem = (message, code, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function checkKeys(value) {
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Unsafe configuration key');
    checkKeys(value[key]);
  }
}
function parse(content) {
  let raw;
  try { raw = JSON.parse(content); } catch { throw new Error('Pricing configuration is not valid JSON'); }
  checkKeys(raw);
  if (!isRecord(raw) || !Array.isArray(raw.providers)) throw new Error('Configuration providers must be an array');
  const multipliers = Object.create(null);
  for (const provider of raw.providers) {
    if (!isRecord(provider) || typeof provider.name !== 'string' || !provider.name.trim() || Object.hasOwn(multipliers, provider.name)) {
      throw new Error('Provider names must be nonempty and unique');
    }
    multipliers[provider.name] = normalizeMultipliers(provider.priceMultipliers, `${provider.name}.priceMultipliers`);
  }
  return { raw, pricing: Object.fromEntries(normalizePricing(raw.pricing ?? {})), multipliers };
}
function nonPricing(raw) {
  const { pricing, providers, ...rest } = raw;
  // The settings form materializes defaults and expands string routes when saving.
  // Compare their meaning, otherwise a pricing-only first save falsely needs restart.
  return {
    ...rest,
    logRequests: typeof raw.logRequests === 'boolean' ? raw.logRequests : String(env('GATEWAY_LOG_REQUESTS', '1')) !== '0',
    routes: Object.fromEntries(Object.entries(raw.routes ?? {}).map(([alias, target]) =>
      [alias, typeof target === 'string' ? { provider: target } : target])),
    providers: providers?.map(({ priceMultipliers, ...provider }) => ({
      apiType: 'anthropic', clientProfile: 'auto', messagesTransport: 'chat-completions',
      maxConcurrency: 3, maxAttempts: 4, connectTimeoutMs: 30000, requestTimeoutMs: 600000,
      requireKey: true, models: {}, ...provider,
    })),
  };
}
export function pricingChangeRequiresRestart(before, after) {
  return canonical(nonPricing(before)) !== canonical(nonPricing(after));
}

export function pricingControlPath(configPath) {
  const absolute = resolve(configPath);
  return join(dirname(absolute), 'logs', `pricing-runtime-${hash(absolute).slice(0, 16)}.json`);
}
export function publishPricingControl({ configPath, port, host, instanceId, token }) {
  const controlPath = pricingControlPath(configPath);
  const localHost = ['::', '::1'].includes(host) ? '[::1]' : '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '0.0.0.0', '::', '::1', '::ffff:127.0.0.1'].includes(host)) {
    throw new Error('Pricing control requires a gateway reachable on loopback');
  }
  const state = { pid: process.pid, instanceId, token, baseUrl: `http://${localHost}:${port}` };
  const temporary = `${controlPath}.${process.pid}.tmp`;
  mkdirSync(dirname(controlPath), { recursive: true });
  try {
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    renameSync(temporary, controlPath);
  } finally { try { unlinkSync(temporary); } catch {} }
  return () => {
    try {
      if (JSON.parse(readFileSync(controlPath, 'utf8')).instanceId === instanceId) unlinkSync(controlPath);
    } catch {}
  };
}

// The admin process must use the running address/credential, not edited settings.
export async function reloadGatewayPricing({ configPath, expectedRevision }) {
  let state;
  try { state = JSON.parse(readFileSync(pricingControlPath(configPath), 'utf8')); }
  catch { throw problem('运行中网关不支持配置热更新或尚未启动；首次部署需重启一次', 'UNSUPPORTED', 503); }
  let base;
  try { base = new URL(state.baseUrl); } catch { throw problem('Invalid pricing control state', 'OFFLINE', 503); }
  if (base.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(base.hostname) || !base.port ||
      base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
      !Number.isSafeInteger(state.pid) || state.pid <= 0 || typeof state.instanceId !== 'string' ||
      !/^[a-f0-9]{64}$/.test(state.token)) throw problem('Invalid pricing control state', 'OFFLINE', 503);
  try {
    const health = await fetch(new URL('/health', base), { signal: AbortSignal.timeout(2500), redirect: 'error' });
    const info = await health.json();
    if (!health.ok || info.service !== 'slizm-gateway' || info.pid !== state.pid || info.instanceId !== state.instanceId) {
      throw problem('Gateway instance changed; reload was not confirmed', 'OFFLINE', 503);
    }
    if (!info.pricingReload) throw problem('网关尚不支持热更新，首次部署需重启一次', 'UNSUPPORTED', 503);
    const response = await fetch(new URL(info.configReload ? '/v1/reload-config' : '/v1/reload-pricing', base), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json', 'x-gateway-pricing-token': state.token },
      body: JSON.stringify({ expectedRevision }),
    });
    const result = await response.json();
    if (!response.ok) throw problem(result.error?.message ?? 'Pricing reload failed', response.status === 409 ? 'REVISION_CONFLICT' : 'RELOAD_FAILED', response.status);
    if (result.instanceId !== state.instanceId || result.reloadApplied !== true ||
        (expectedRevision && result.revision !== expectedRevision)) throw problem('Pricing reload acknowledgement mismatch', 'REVISION_CONFLICT', 409);
    return result;
  } catch (error) {
    if (error.code && error.statusCode) throw error;
    throw problem('无法确认网关配置已生效；请检查网关状态并重试', 'OFFLINE', 503);
  }
}

export function createRuntimePricing({ configPath, initialContent, onError = () => {}, prepareConfig }) {
  const initial = parse(initialContent);
  const providerNames = Object.keys(initial.multipliers);
  let snapshot = freeze({ pricing: initial.pricing, multipliers: initial.multipliers });
  let pricingRevision = hash(canonical(snapshot));
  let revision = hash(initialContent);
  let effectiveAt = new Date().toISOString();
  let restartRequired = false;
  let lastReloadError = null;
  let lastAttempt = revision;
  let stopWatching;
  const status = () => ({ revision, pricingRevision, effectiveAt, restartRequired, lastReloadError });
  function reload(expectedRevision) {
    try {
      const content = readFileSync(configPath, 'utf8');
      const nextRevision = hash(content);
      if (expectedRevision !== undefined && expectedRevision !== nextRevision) {
        throw problem('Configuration changed after saving; refresh and retry', 'REVISION_CONFLICT', 409);
      }
      const next = parse(content);
      const commitConfig = prepareConfig?.(next.raw);
      // Legacy pricing-only consumers retain startup providers; full reload replaces them.
      const multipliers = prepareConfig ? next.multipliers : Object.fromEntries(providerNames.map((name) => [name,
        Object.hasOwn(next.multipliers, name) ? next.multipliers[name] : snapshot.multipliers[name],
      ]));
      const candidate = freeze({ pricing: next.pricing, multipliers });
      const nextPricingRevision = hash(canonical(candidate));
      commitConfig?.();
      if (nextPricingRevision !== pricingRevision) {
        snapshot = candidate;
        pricingRevision = nextPricingRevision;
        effectiveAt = new Date().toISOString();
      }
      if (prepareConfig && revision !== nextRevision) effectiveAt = new Date().toISOString();
      revision = nextRevision;
      restartRequired = !prepareConfig && pricingChangeRequiresRestart(initial.raw, next.raw);
      lastReloadError = null;
      lastAttempt = nextRevision;
      return { reloadApplied: true, ...status() };
    } catch (error) {
      lastReloadError = error.message;
      throw error;
    }
  }
  function startWatching({ intervalMs = 1000, debounceMs = 200 } = {}) {
    if (stopWatching) return stopWatching;
    let debounce;
    let watcher;
    let closed = false;
    const check = () => {
      if (closed) return;
      try {
        const nextHash = hash(readFileSync(configPath, 'utf8'));
        if (nextHash === lastAttempt && !lastReloadError) return;
        const previousError = lastReloadError;
        lastAttempt = nextHash;
        try { reload(); } catch (error) { if (previousError !== error.message) onError(error); }
      } catch {
        const error = new Error('Cannot read pricing configuration; retaining last valid pricing');
        if (lastReloadError !== error.message) onError(error);
        lastReloadError = error.message;
      }
    };
    try {
      watcher = watch(dirname(configPath), { persistent: false }, (_event, filename) => {
        if (filename && String(filename) !== basename(configPath)) return;
        clearTimeout(debounce);
        debounce = setTimeout(check, debounceMs);
        debounce.unref();
      });
      watcher.on('error', () => { watcher.close(); });
    } catch { /* Polling also handles atomic replacement and unavailable file watchers. */ }
    const timer = setInterval(check, intervalMs);
    timer.unref();
    stopWatching = () => { closed = true; clearTimeout(debounce); clearInterval(timer); watcher?.close(); };
    return stopWatching;
  }
  return {
    reload, status, startWatching,
    captureContext() {
      const current = snapshot;
      const currentRevision = pricingRevision;
      const currentEffectiveAt = effectiveAt;
      return (provider, model) => ({ pricing: current.pricing,
        priceMultiplier: freeze(resolveMultiplier(current.multipliers[provider], model)),
        pricingRevision: currentRevision, pricingEffectiveAt: currentEffectiveAt });
    },
    capture(provider, model) {
      return { pricing: snapshot.pricing,
        priceMultiplier: freeze(resolveMultiplier(snapshot.multipliers[provider], model)),
        pricingRevision, pricingEffectiveAt: effectiveAt };
    },
  };
}
