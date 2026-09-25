// Shared configuration for the gateway and management CLI.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizePricing } from './pricing.js';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
function loadDotEnv(path) {
  const out = Object.create(null);
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}
const dotenv = loadDotEnv(join(ROOT, '.env'));
export function env(name, fallback = undefined) {
  const value = process.env[name] ?? dotenv[name];
  return value === undefined || value === '' ? fallback : value;
}
function readJson(path) {
  if (!existsSync(path)) throw new Error(`缺少网关配置: ${path}`);
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error(`网关配置不是合法 JSON: ${path}`); }
}
const missingSecrets = [];
const secrets = new Set();
function remember(value) {
  if (typeof value === 'string' && value.length >= 4) secrets.add(value);
  return value;
}
export function missingSecretRefs() { return [...missingSecrets]; }
export function resolveSecret(value, opts = {}) {
  if (!value) return undefined;
  if (typeof value !== 'string') throw new Error('密钥或环境变量引用必须是字符串');
  if (!value.startsWith('env:')) return remember(value);
  const name = value.slice(4);
  const resolved = env(name);
  if (!resolved) {
    if (!opts.optional) throw new Error(`配置引用了未设置的环境变量 ${name}`);
    missingSecrets.push({ provider: opts.label ?? '?', name });
    return undefined;
  }
  return remember(resolved);
}
export function redact(value) {
  if (typeof value !== 'string') return value;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) value = value.split(secret).join('[已隐藏]');
  return value
    .replace(/sk-[A-Za-z0-9_\-]{10,}/g, '[已隐藏]')
    .replace(/(Bearer\s+)[A-Za-z0-9_\-.]{8,}/gi, '$1[已隐藏]')
    .replace(/([?&](?:key|api_key|token)=)[^&\s]+/gi, '$1[已隐藏]')
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[已隐藏]@');
}
function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value;
}
function integer(value, fallback, label, max = Number.MAX_SAFE_INTEGER, min = 1) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${label} 必须是 ${min}..${max} 的整数`);
  return n;
}
function enumValue(value, fallback, allowed, label) {
  const out = value ?? fallback;
  if (!allowed.includes(out)) throw new Error(`${label} 必须是 ${allowed.join(' / ')}`);
  return out;
}
function urlValue(value, label, proxy = false) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${label} 必须是有效 URL`); }
  if (!(proxy ? ['http:'] : ['http:', 'https:']).includes(parsed.protocol)) throw new Error(`${label} 协议不支持`);
  if (parsed.search || parsed.hash || (!proxy && (parsed.username || parsed.password))) throw new Error(`${label} 不得带查询参数、片段或上游 URL 凭据`);
  if (proxy && parsed.pathname !== '/') throw new Error(`${label} 不得带路径`);
  return value.replace(/\/+$/, '');
}
export function loadConfig() {
  missingSecrets.length = 0;
  const cfg = record(readJson(env('GATEWAY_CONFIG', join(ROOT, 'providers.json'))), '配置');
  const server = {
    host: env('GATEWAY_HOST', '127.0.0.1'),
    port: integer(env('GATEWAY_PORT', '4000'), 4000, 'GATEWAY_PORT', 65535, 0),
    clientToken: remember(resolveSecret(cfg.clientToken) ?? 'sk-local-gateway'),
    logRequests: String(env('GATEWAY_LOG_REQUESTS', '1')) !== '0',
  };
  if (!Array.isArray(cfg.providers)) throw new Error('providers 必须是数组');
  const providers = new Map();
  for (const p of cfg.providers) {
    record(p, 'provider');
    if (typeof p.name !== 'string' || !p.name.trim() || providers.has(p.name)) throw new Error('provider name 必须非空且唯一');
    const models = record(p.models ?? {}, `${p.name}.models`);
    for (const value of Object.values(models)) if (typeof value !== 'string' || !value.trim()) throw new Error(`${p.name}.models 的值必须是非空字符串`);
    const extraHeaders = record(p.extraHeaders ?? {}, `${p.name}.extraHeaders`);
    try { new Headers(extraHeaders); } catch { throw new Error(`${p.name}.extraHeaders 包含无效请求头`); }
    for (const [k, v] of Object.entries(extraHeaders)) if (/authorization|api[-_]key|token|secret/i.test(k)) remember(String(v));
    const proxy = resolveSecret(p.proxy, { label: `${p.name}.proxy` });
    if (p.allowInsecureTls === true) throw new Error(`${p.name}: 不支持关闭 TLS 校验，请使用受信任证书或 NODE_EXTRA_CA_CERTS`);
    providers.set(p.name, {
      name: p.name,
      apiType: enumValue(p.apiType, 'anthropic', ['anthropic', 'openai', 'gemini'], `${p.name}.apiType`),
      clientProfile: enumValue(p.clientProfile, 'auto', ['auto', 'claude', 'codex'], `${p.name}.clientProfile`),
      baseUrl: urlValue(p.baseUrl, `${p.name}.baseUrl`),
      apiKey: resolveSecret(p.apiKey, { optional: p.requireKey === false, label: p.name }),
      requireKey: p.requireKey !== false,
      authStyle: enumValue(p.authStyle, 'auto', ['auto', 'bearer', 'x-api-key'], `${p.name}.authStyle`),
      extraHeaders, models,
      proxy: proxy ? urlValue(proxy, `${p.name}.proxy`, true) : undefined,
      keepAlive: p.keepAlive === true,
      forceStreamAccept: p.forceStreamAccept === true,
      maxConcurrency: integer(p.maxConcurrency, 3, `${p.name}.maxConcurrency`, 1000),
      maxAttempts: integer(p.maxAttempts, 4, `${p.name}.maxAttempts`, 20),
      connectTimeoutMs: integer(p.connectTimeoutMs, 30000, `${p.name}.connectTimeoutMs`, 2147483647),
      requestTimeoutMs: integer(p.requestTimeoutMs, 600000, `${p.name}.requestTimeoutMs`, 2147483647),
      codexVersion: p.codexVersion ?? env('CODEX_VERSION', '0.155.0-alpha.16.4'),
      codexOriginator: p.codexOriginator ?? 'Codex Desktop',
      codexBetaFeatures: p.codexBetaFeatures ?? 'remote_compaction_v2',
      codexReasoningEffort: p.codexReasoningEffort ?? 'high',
    });
  }
  const routes = new Map();
  for (const [alias, target] of Object.entries(record(cfg.routes ?? {}, 'routes'))) {
    if (typeof target !== 'string') record(target, `routes[${alias}]`);
    const provider = typeof target === 'string' ? target : target.provider;
    if (!providers.has(provider)) throw new Error(`routes[${alias}] 指向不存在的 provider`);
    const model = typeof target === 'string' ? undefined : target.model;
    if (model !== undefined && (typeof model !== 'string' || !model.trim())) throw new Error(`routes[${alias}].model 必须是非空字符串`);
    const profile = typeof target === 'string' ? undefined : target.clientProfile;
    const clientProfile = profile === undefined ? undefined : enumValue(profile, 'auto', ['auto', 'claude', 'codex'], `routes[${alias}].clientProfile`);
    routes.set(alias, { provider, model, clientProfile });
  }
  if (cfg.defaultRoute !== undefined && !providers.has(cfg.defaultRoute)) throw new Error('defaultRoute 指向不存在的 provider');
  return { server, providers, routes, pricing: normalizePricing(cfg.pricing ?? {}), defaultRoute: cfg.defaultRoute };
}
export function routeKeys(cfg) { return [...cfg.routes.keys()]; }
