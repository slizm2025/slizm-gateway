// 网关的 token 用量记账。
// - 内存汇总：按上游 provider / 路由别名 / 上游模型累计，并列出在途请求，供 GET /v1/usage 查询；重启清零。
// - 账本：每个请求结束时向 logs/usage-YYYY-MM.jsonl（本地月份）追加一行，重启不丢；
//   `node scripts/gw.js tokens` 读账本出报表（scripts/usage-report.js）。
// token 一律按 Anthropic 语义记：输入不含缓存，缓存读 / 缓存写单列。OpenAI 类上游在适配器里已换算好。
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, env, redact } from './config.js';
import { calculateCostUsd, modelPrice } from './pricing.js';

const MAX_RECENT = 200;
const SWITCHBOARD_RETAINED_TTL_MS = 5 * 60 * 1000;
const startedAt = new Date().toISOString();
const totals = bucket();
const providers = new Map();
const routes = new Map();
const models = new Map();
const inflight = new Set();
const recent = [];
const switchboardRetained = new Map();

function switchboardTopologyKey(item) {
  return JSON.stringify([
    item.provider ?? null,
    item.model ?? null,
    item.clientType ?? null,
    item.inputProtocol ?? null,
    item.upstreamProtocol ?? null,
    item.adapter ?? null,
    item.route ?? null,
  ]);
}

function pruneSwitchboardRetained(nowMs) {
  for (const [key, item] of switchboardRetained) {
    if (nowMs - Date.parse(item.finishedAt) > SWITCHBOARD_RETAINED_TTL_MS) {
      switchboardRetained.delete(key);
    }
  }
}

function retainSwitchboardTopology(item) {
  const finishedAtMs = Date.parse(item.time);
  pruneSwitchboardRetained(finishedAtMs);
  const retained = {
    route: item.route,
    provider: item.provider,
    model: item.model,
    clientType: item.clientType,
    inputProtocol: item.inputProtocol,
    upstreamProtocol: item.upstreamProtocol,
    adapter: item.adapter,
    finishedAt: item.time,
  };
  const key = switchboardTopologyKey(retained);
  const previous = switchboardRetained.get(key);
  if (!previous || Date.parse(previous.finishedAt) < finishedAtMs) {
    switchboardRetained.set(key, retained);
  }
}

function bucket() {
  return {
    requests: 0,
    successes: 0,
    errors: 0,
    cancelled: 0,
    unreported: 0,
    reportedInputTokens: 0,
    reportedOutputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    baseCostUsd: 0,
    pricedRequests: 0,
    unpricedRequests: 0,
  };
}

function get(map, key) {
  if (!map.has(key)) map.set(key, bucket());
  return map.get(key);
}

function copyMap(map) {
  return Object.fromEntries([...map.entries()].map(([key, value]) => [key, { ...value }]));
}

// null 当作"没上报"：message_delta 里的空字段不能覆盖 message_start 已给出的值
function tokenCount(value) {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/** 取出 Anthropic 语义的四项 token；一项都没有时返回 null（上游没上报） */
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const out = {
    input: tokenCount(usage.input_tokens),
    output: tokenCount(usage.output_tokens),
    cacheRead: tokenCount(usage.cache_read_input_tokens),
    cacheWrite: tokenCount(usage.cache_creation_input_tokens),
  };
  return Object.values(out).some((v) => v !== undefined) ? out : null;
}

/** 错误摘要压成一行并脱敏：HTML 错误页取 <title>，JSON 取 error.message，其余折叠空白 */
export function summarizeError(value, max = 200) {
  let text = String(value ?? '');
  const title = /<title[^>]*>([^<]+)<\/title>/i.exec(text)?.[1];
  if (title) text = title;
  else if (/^\s*\{/.test(text)) {
    try {
      const body = JSON.parse(text);
      const message = body?.error?.message ?? body?.message ?? body?.error;
      if (typeof message === 'string') text = message;
    } catch { /* 被截断或不是 JSON，按原文处理 */ }
  }
  return redact(text.replace(/\s+/g, ' ').trim()).slice(0, max);
}

/**
 * 账本目录。显式 GATEWAY_USAGE_DIR 优先（设为 off 关闭）；未设置时，只有用默认配置运行的真实网关才记账——
 * 离线测试都用 GATEWAY_CONFIG 指向临时配置，这样假请求不会混进真实账本。
 */
export function usageLedgerDir() {
  const dir = env('GATEWAY_USAGE_DIR');
  if (dir) return /^(0|off|false|no)$/i.test(dir) ? null : dir;
  return env('GATEWAY_CONFIG') ? null : join(ROOT, 'logs');
}

/** 账本按本地月份分文件：usage-2026-09.jsonl */
export function ledgerFile(dir, date = new Date()) {
  return join(dir, `usage-${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}.jsonl`);
}

let preparedDir = null;
let ledgerFailed = false;
function appendLedger(item) {
  const dir = usageLedgerDir();
  if (!dir) return;
  try {
    if (preparedDir !== dir) {
      mkdirSync(dir, { recursive: true });
      preparedDir = dir;
    }
    // 同步追加：一行几百字节，写完即落盘，网关被 taskkill /F 强停也不丢已结束请求的记录
    appendFileSync(ledgerFile(dir), `${JSON.stringify(item)}\n`);
  } catch (e) {
    if (!ledgerFailed) console.error(`[${new Date().toISOString()}] 用量账本写入失败（后续同类错误不再提示）: ${redact(e.message)}`);
    ledgerFailed = true;
  }
}

export function estimateInputTokens(body) {
  const text = JSON.stringify({ messages: body?.messages, system: body?.system, tools: body?.tools });
  return Math.max(1, Math.ceil(text.length / 4));
}

export function beginUsage({ requestId, route, provider, model, clientType = 'unknown', inputProtocol, upstreamProtocol, adapter, pricing, priceMultiplier = null, pricingRevision, pricingEffectiveAt, estimatedInputTokens }) {
  const entry = {
    requestId,
    route,
    provider,
    model,
    clientType: clientType || 'unknown',
    inputProtocol, upstreamProtocol, adapter,
    pricing,
    priceMultiplier,
    pricingRevision,
    pricingEffectiveAt,
    requestStartedAt: new Date().toISOString(),
    startedAt: performance.now(),
    estimatedInputTokens: tokenCount(estimatedInputTokens) ?? 0,
    usage: null,
    result: null,
  };
  for (const target of [totals, get(providers, provider), get(routes, route), get(models, model)]) target.requests++;
  inflight.add(entry);
  return entry;
}

/** 流式响应的 usage 分几次到（message_start 带输入与缓存，message_delta 带最终输出），按字段合并 */
export function recordStreamUsage(entry, usage) {
  const u = normalizeUsage(usage);
  if (!entry || entry.result || !u) return;
  entry.usage ??= {};
  for (const [key, value] of Object.entries(u)) if (value !== undefined) entry.usage[key] = value;
}

/**
 * 结束记账并写入账本；重复调用返回第一次的结果。
 * 只累计上游真实上报的 token（中途断开时已收到的部分也算，上游同样会计费）；没上报时 usageSource 为 'none'。
 * status 499 表示客户端取消（如在 Claude Code 里按 Esc），单独计数，不算失败。
 */
export function finishUsage(entry, { status = 500, usage, error } = {}) {
  if (!entry) return undefined;
  if (entry.result) return entry.result;
  recordStreamUsage(entry, usage);
  inflight.delete(entry);
  const code = Number(status) || 500;
  const u = entry.usage;
  const item = {
    time: new Date().toISOString(),
    requestId: entry.requestId,
    route: entry.route,
    provider: entry.provider,
    model: entry.model,
    clientType: entry.clientType,
    inputProtocol: entry.inputProtocol,
    upstreamProtocol: entry.upstreamProtocol,
    adapter: entry.adapter,
    pricingRevision: entry.pricingRevision,
    pricingEffectiveAt: entry.pricingEffectiveAt,
    status: code,
    durationMs: Math.max(0, Math.round(performance.now() - entry.startedAt)),
    usageSource: u ? 'reported' : 'none',
    inputTokens: u?.input ?? 0,
    outputTokens: u?.output ?? 0,
    cacheReadTokens: u?.cacheRead ?? 0,
    cacheWriteTokens: u?.cacheWrite ?? 0,
    estimatedInputTokens: entry.estimatedInputTokens,
  };
  retainSwitchboardTopology(item);
  // baseCostUsd 为全局模型原价；costUsd 为按站点逐项倍率（输入/缓存读/缓存写/输出）计算的实际费用
  item.baseCostUsd = u ? calculateCostUsd(u, entry.pricing, entry.model) : null;
  if (entry.priceMultiplier) item.priceMultiplier = entry.priceMultiplier;
  // 记下当时的单价，管理页据此展示逐项计费过程；之后改价不影响已记账的明细
  const price = item.baseCostUsd === null ? undefined : modelPrice(entry.pricing, entry.model);
  if (price) item.unitPrice = { input: price.input, output: price.output, cacheRead: price.cacheRead, cacheWrite: price.cacheWrite };
  item.costUsd = u ? calculateCostUsd(u, entry.pricing, entry.model, entry.priceMultiplier) : null;
  if (error) item.error = summarizeError(error);
  entry.result = item;

  for (const target of [totals, get(providers, entry.provider), get(routes, entry.route), get(models, entry.model)]) {
    if (code === 499) target.cancelled++;
    else if (code >= 200 && code < 400) target.successes++;
    else target.errors++;
    if (!u) target.unreported++;
    target.reportedInputTokens += item.inputTokens;
    target.reportedOutputTokens += item.outputTokens;
    target.cacheReadTokens += item.cacheReadTokens;
    target.cacheWriteTokens += item.cacheWriteTokens;
    if (item.costUsd === null) target.unpricedRequests += u ? 1 : 0;
    else {
      target.costUsd += item.costUsd;
      target.baseCostUsd += item.baseCostUsd;
      target.pricedRequests++;
    }
  }
  recent.push(item);
  if (recent.length > MAX_RECENT) recent.shift();
  appendLedger(item);
  return item;
}

export function usageStats({ activeRequests = inflight.size } = {}) {
  const now = performance.now();
  const wallNow = Date.now();
  pruneSwitchboardRetained(wallNow);
  const dir = usageLedgerDir();
  return {
    startedAt,
    generatedAt: new Date(wallNow).toISOString(),
    activeRequests,
    ledger: dir ? ledgerFile(dir) : null,
    totals: { ...totals },
    providers: copyMap(providers),
    routes: copyMap(routes),
    models: copyMap(models),
    inflight: [...inflight].map((e) => ({
      requestId: e.requestId,
      route: e.route,
      provider: e.provider,
      model: e.model,
      clientType: e.clientType,
      inputProtocol: e.inputProtocol,
      upstreamProtocol: e.upstreamProtocol,
      adapter: e.adapter,
      requestStartedAt: e.requestStartedAt,
      pricingRevision: e.pricingRevision,
      pricingEffectiveAt: e.pricingEffectiveAt,
      elapsedMs: Math.round(now - e.startedAt),
      estimatedInputTokens: e.estimatedInputTokens,
      // 流式请求收到 message_start 后就知道本次上下文有多大
      contextTokens: e.usage ? (e.usage.input ?? 0) + (e.usage.cacheRead ?? 0) + (e.usage.cacheWrite ?? 0) : undefined,
      outputTokens: e.usage?.output,
    })),
    switchboardRetained: [...switchboardRetained.values()].map((item) => ({ ...item })),
    recent: recent.slice(),
  };
}
