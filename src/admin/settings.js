// Admin settings management: read, redact, validate, optimistic lock, and atomic write.
import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync, mkdirSync, renameSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, basename } from 'node:path';
import { ROOT, loadConfig } from '../config.js';
import { normalizeMultipliers, normalizePricing, pricingObject } from '../pricing.js';
import { pricingChangeRequiresRestart } from '../runtime-pricing.js';

const DISALLOWED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function checkNoPrototypePollution(val, path = 'root') {
  if (val === null || typeof val !== 'object') return;
  if (Array.isArray(val)) {
    for (let i = 0; i < val.length; i++) {
      checkNoPrototypePollution(val[i], `${path}[${i}]`);
    }
    return;
  }
  for (const k of Object.keys(val)) {
    if (DISALLOWED_KEYS.has(k)) {
      throw new Error(`非法配置属性名: ${k} at ${path}`);
    }
    checkNoPrototypePollution(val[k], `${path}.${k}`);
  }
}

export function computeRevision(fileContent) {
  return createHash('sha256').update(fileContent, 'utf8').digest('hex');
}

export function readRawConfig(configPath) {
  const p = configPath || join(ROOT, 'providers.json');
  if (!existsSync(p)) {
    return { raw: { providers: [], routes: {} }, content: '{\n  "providers": [],\n  "routes": {}\n}\n' };
  }
  const content = readFileSync(p, 'utf8');
  let raw;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    throw new Error(`配置文件损坏或不是有效 JSON: ${p}`);
  }
  checkNoPrototypePollution(raw);
  return { raw, content };
}

export function getSanitizedSettings(configPath) {
  const { raw, content } = readRawConfig(configPath);
  const revision = computeRevision(content);

  const providers = (Array.isArray(raw.providers) ? raw.providers : []).map((p) => {
    const hasApiKey = Boolean(p.apiKey && typeof p.apiKey === 'string' && p.apiKey.trim());
    return {
      name: p.name ?? '',
      apiType: p.apiType ?? 'anthropic',
      baseUrl: p.baseUrl ?? '',
      clientProfile: p.clientProfile ?? 'auto',
      messagesTransport: p.messagesTransport ?? 'chat-completions',
      maxConcurrency: p.maxConcurrency ?? 3,
      maxAttempts: p.maxAttempts ?? 4,
      priceMultipliers: p.priceMultipliers && typeof p.priceMultipliers === 'object' && !Array.isArray(p.priceMultipliers) ? { ...p.priceMultipliers } : {},
      connectTimeoutMs: p.connectTimeoutMs ?? 30000,
      requestTimeoutMs: p.requestTimeoutMs ?? 600000,
      requireKey: p.requireKey !== false,
      hasApiKey,
      models: p.models && typeof p.models === 'object' && !Array.isArray(p.models) ? { ...p.models } : {},
    };
  });

  const routes = [];
  if (raw.routes && typeof raw.routes === 'object' && !Array.isArray(raw.routes)) {
    for (const [alias, target] of Object.entries(raw.routes)) {
      if (typeof target === 'string') {
        routes.push({ alias, provider: target, model: '', clientProfile: '' });
      } else if (target && typeof target === 'object') {
        routes.push({
          alias,
          provider: target.provider ?? '',
          model: target.model ?? '',
          clientProfile: target.clientProfile ?? '',
        });
      }
    }
  }

  const logRequests = typeof raw.logRequests === 'boolean'
    ? raw.logRequests
    : String(process.env.GATEWAY_LOG_REQUESTS ?? '1') !== '0';
  const defaultRoute = typeof raw.defaultRoute === 'string' ? raw.defaultRoute : null;

  return {
    revision,
    logRequests,
    defaultRoute,
    pricing: raw.pricing && typeof raw.pricing === 'object' && !Array.isArray(raw.pricing) ? { ...raw.pricing } : {},
    providers,
    routes,
  };
}

export function saveSettings(newSettings, options = {}) {
  const configPath = typeof options === 'string' ? options : options.configPath;
  const backupDir = (typeof options === 'object' && options.backupDir) ?
    options.backupDir :
    join(typeof options === 'object' && options.logDir ? options.logDir : join(ROOT, 'logs'), 'config-backups');

  if (!newSettings || typeof newSettings !== 'object') {
    throw new Error('配置数据必须是对象');
  }
  checkNoPrototypePollution(newSettings);

  const p = configPath || join(ROOT, 'providers.json');
  const { raw: existingRaw, content: existingContent } = readRawConfig(p);
  const currentRevision = computeRevision(existingContent);

  if (!newSettings.revision || typeof newSettings.revision !== 'string') {
    const err = new Error('缺少配置版本号 revision');
    err.statusCode = 400;
    throw err;
  }

  if (newSettings.revision !== currentRevision) {
    const err = new Error('配置已被修改，请刷新后重试');
    err.statusCode = 409;
    throw err;
  }

  if (!Array.isArray(newSettings.providers)) {
    throw new Error('providers 必须是数组');
  }
  if (!Array.isArray(newSettings.routes)) {
    throw new Error('routes 必须是数组');
  }

  const existingProviderMap = new Map();
  if (Array.isArray(existingRaw.providers)) {
    for (const ep of existingRaw.providers) {
      if (ep && typeof ep.name === 'string') {
        existingProviderMap.set(ep.name, ep);
      }
    }
  }

  const mergedProviders = [];
  const newProviderNames = new Set();

  for (const pInput of newSettings.providers) {
    if (!pInput || typeof pInput !== 'object') throw new Error('provider 必须是对象');
    checkNoPrototypePollution(pInput, 'provider');
    const name = String(pInput.name || '').trim();
    if (!name || name.length > 64) throw new Error(`无效的 provider 标识: ${name}`);
    if (DISALLOWED_KEYS.has(name.toLowerCase())) throw new Error(`非法的 provider 标识: ${name}`);
    if (newProviderNames.has(name)) throw new Error(`重复的 provider 标识: ${name}`);
    newProviderNames.add(name);

    const old = existingProviderMap.get(name) || {};
    const merged = { ...old };

    merged.name = name;
    if (pInput.apiType !== undefined) {
      if (!['anthropic', 'openai', 'gemini'].includes(pInput.apiType)) {
        throw new Error(`provider [${name}] 的 apiType 无效: ${pInput.apiType}`);
      }
      merged.apiType = pInput.apiType;
    }
    if (pInput.messagesTransport !== undefined) {
      if (!['chat-completions', 'responses'].includes(pInput.messagesTransport)) throw new Error('Invalid messagesTransport');
      merged.messagesTransport = pInput.messagesTransport;
    }
    if (pInput.baseUrl !== undefined) {
      if (typeof pInput.baseUrl !== 'string' || !pInput.baseUrl.trim()) {
        throw new Error(`provider [${name}] 的 baseUrl 必须是非空字符串`);
      }
      merged.baseUrl = pInput.baseUrl.trim();
    }
    if (pInput.clientProfile !== undefined) {
      if (!['auto', 'claude', 'codex'].includes(pInput.clientProfile)) {
        throw new Error(`provider [${name}] 的 clientProfile 无效: ${pInput.clientProfile}`);
      }
      merged.clientProfile = pInput.clientProfile;
    }
    if (pInput.maxConcurrency !== undefined) {
      const n = Number(pInput.maxConcurrency);
      if (!Number.isInteger(n) || n < 1 || n > 1000) {
        throw new Error(`provider [${name}] 的 maxConcurrency 必须是 1..1000 的整数`);
      }
      merged.maxConcurrency = n;
    }
    if (pInput.maxAttempts !== undefined) {
      const n = Number(pInput.maxAttempts);
      if (!Number.isInteger(n) || n < 1 || n > 20) {
        throw new Error(`provider [${name}] 的 maxAttempts 必须是 1..20 的整数`);
      }
      merged.maxAttempts = n;
    }
    if (pInput.priceMultipliers !== undefined) {
      // 逐项倍率：保留精确指定的全 1 覆盖项（当 '*' 非 1 时需借此恢复原价），仅清理无害的 '*' 全 1 默认项
      const normalized = normalizeMultipliers(pInput.priceMultipliers, `provider [${name}] 的 priceMultipliers`);
      const wildcard = normalized['*'];
      const wildcardIsAll1 = wildcard && Object.values(wildcard).every((v) => v === 1);
      if (wildcardIsAll1) delete normalized['*'];
      const wildcardNonUnit = Boolean(normalized['*'] && Object.values(normalized['*']).some((v) => v !== 1));
      for (const [model, m] of Object.entries(normalized)) {
        if (model !== '*' && Object.values(m).every((v) => v === 1) && !wildcardNonUnit) {
          delete normalized[model];
        }
      }
      if (Object.keys(normalized).length) merged.priceMultipliers = normalized;
      else delete merged.priceMultipliers;
    }
    if (pInput.connectTimeoutMs !== undefined) {
      const n = Number(pInput.connectTimeoutMs);
      if (!Number.isInteger(n) || n < 500 || n > 3600000) {
        throw new Error(`provider [${name}] 的 connectTimeoutMs 必须是 500..3600000 的整数`);
      }
      merged.connectTimeoutMs = n;
    }
    if (pInput.requestTimeoutMs !== undefined) {
      const n = Number(pInput.requestTimeoutMs);
      if (!Number.isInteger(n) || n < 1000 || n > 86400000) {
        throw new Error(`provider [${name}] 的 requestTimeoutMs 必须是 1000..86400000 的整数`);
      }
      merged.requestTimeoutMs = n;
    }
    if (pInput.requireKey !== undefined) merged.requireKey = Boolean(pInput.requireKey);
    if (pInput.models !== undefined && typeof pInput.models === 'object' && !Array.isArray(pInput.models)) {
      checkNoPrototypePollution(pInput.models, `${name}.models`);
      for (const [mk, mv] of Object.entries(pInput.models)) {
        if (typeof mv !== 'string' || !mv.trim()) throw new Error(`provider [${name}].models[${mk}] 必须是非空字符串`);
      }
      merged.models = { ...pInput.models };
    }

    if (pInput.apiKey !== undefined) {
      const trimmed = String(pInput.apiKey).trim();
      if (trimmed !== '') {
        merged.apiKey = trimmed;
      }
    }

    delete merged.hasApiKey;
    mergedProviders.push(merged);
  }

  const mergedRoutes = {};
  const routeAliases = new Set();
  for (const r of newSettings.routes) {
    if (!r || typeof r !== 'object') throw new Error('route 必须是对象');
    checkNoPrototypePollution(r, 'route');
    const alias = String(r.alias || '').trim();
    if (!alias || alias.length > 128) throw new Error(`无效的 route 别名: ${alias}`);
    if (DISALLOWED_KEYS.has(alias.toLowerCase())) throw new Error(`非法的 route 别名: ${alias}`);
    if (routeAliases.has(alias)) throw new Error(`重复的 route 别名: ${alias}`);
    routeAliases.add(alias);
    const provider = String(r.provider || '').trim();
    if (!provider || !newProviderNames.has(provider)) {
      throw new Error(`route [${alias}] 引用的 provider 不存在: ${provider}`);
    }

    const model = r.model ? String(r.model).trim() : undefined;
    const clientProfile = r.clientProfile ? String(r.clientProfile).trim() : undefined;

    if (!model && !clientProfile) {
      mergedRoutes[alias] = provider;
    } else {
      const target = { provider };
      if (model) target.model = model;
      if (clientProfile) {
        if (!['auto', 'claude', 'codex'].includes(clientProfile)) {
          throw new Error(`route [${alias}] 的 clientProfile 无效: ${clientProfile}`);
        }
        target.clientProfile = clientProfile;
      }
      mergedRoutes[alias] = target;
    }
  }

  let defaultRoute = null;
  if (newSettings.defaultRoute !== undefined && newSettings.defaultRoute !== null) {
    const def = String(newSettings.defaultRoute).trim();
    if (def) {
      if (!newProviderNames.has(def)) {
        throw new Error(`defaultRoute 引用的 provider 不存在: ${def}`);
      }
      defaultRoute = def;
    }
  }

  const mergedRaw = {
    ...existingRaw,
    providers: mergedProviders,
    routes: mergedRoutes,
  };

  if (defaultRoute) {
    mergedRaw.defaultRoute = defaultRoute;
  } else {
    delete mergedRaw.defaultRoute;
  }

  if (newSettings.pricing !== undefined) {
    mergedRaw.pricing = pricingObject(normalizePricing(newSettings.pricing));
  }

  if (typeof newSettings.logRequests === 'boolean') {
    mergedRaw.logRequests = newSettings.logRequests;
  }

  loadConfig({ raw: mergedRaw });

  const finalJson = JSON.stringify(mergedRaw, null, 2) + '\n';
  const newRevision = computeRevision(finalJson);

  const baseName = basename(p);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFileName = `${baseName}.${timestamp}.bak`;
  const backupPath = join(backupDir, backupFileName);

  const dir = dirname(p);
  const tmpPath = join(dir, `.${baseName}.tmp-${Date.now()}-${process.pid}`);

  try {
    if (existsSync(p)) {
      mkdirSync(backupDir, { recursive: true });
      copyFileSync(p, backupPath);
      try { chmodSync(backupPath, 0o600); } catch {}
    }
    writeFileSync(tmpPath, finalJson, { mode: 0o600 });
    try { chmodSync(tmpPath, 0o600); } catch {}
    renameSync(tmpPath, p);
    try { chmodSync(p, 0o600); } catch {}
  } catch (err) {
    throw new Error(`保存配置文件失败: ${err.message}`);
  } finally {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {}
  }

  return {
    revision: newRevision,
    restartRequired: pricingChangeRequiresRestart(existingRaw, mergedRaw),
  };
}
