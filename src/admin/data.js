// Admin data provider for overview and logs
import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import { join } from 'node:path';
import { ROOT, redact, loadConfig } from '../config.js';
import { readLedger, summarize, parsePeriod } from '../../scripts/usage-report.js';
import { usageLedgerDir } from '../usage.js';
import { calculateCostUsd } from '../pricing.js';

export function stripAnsi(str) {
  return typeof str === 'string' ? stripVTControlCharacters(str) : '';
}

export function readLogTail(filePath, maxBytes = 512 * 1024) {
  if (!existsSync(filePath)) return { lines: [], truncated: false };
  let fd;
  try {
    const stat = statSync(filePath);
    const size = stat.size;
    if (size === 0) return { lines: [], truncated: false };
    const bytesToRead = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(bytesToRead);
    fd = openSync(filePath, 'r');
    readSync(fd, buffer, 0, bytesToRead, size - bytesToRead);
    const text = buffer.toString('utf8');
    const rawLines = text.split(/\r?\n/);
    const truncated = size > maxBytes;
    if (truncated) {
      rawLines.shift();
    }
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
      rawLines.pop();
    }
    return {
      lines: rawLines.map((line) => redact(stripAnsi(line))),
      truncated,
    };
  } catch {
    return { lines: [], truncated: false };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

function isAllowedLocalHost(host) {
  const raw = String(host || '').trim().toLowerCase();
  return raw === '127.0.0.1' || raw === 'localhost' || raw === '::1' || raw === '[::1]' || raw === '0.0.0.0' || raw === '::';
}

function resolveLocalBaseUrl(host, port) {
  const raw = String(host || '127.0.0.1').trim().toLowerCase();
  if (raw === '::' || raw === '::1' || raw === '[::1]') {
    return `http://[::1]:${port}`;
  }
  if (raw === '0.0.0.0' || raw === '127.0.0.1' || raw === 'localhost') {
    return `http://127.0.0.1:${port}`;
  }
  return null;
}

export async function fetchGatewayStatus(cfg, customGetGateway) {
  if (typeof customGetGateway === 'function') {
    try {
      return await customGetGateway();
    } catch {
      return { online: false, baseUrl: `http://${cfg?.server?.host || '127.0.0.1'}:${cfg?.server?.port || 4000}` };
    }
  }
  const host = cfg?.server?.host ?? '127.0.0.1';
  const port = cfg?.server?.port ?? 4000;
  const baseUrl = resolveLocalBaseUrl(host, port);
  if (!baseUrl) {
    return { online: false, baseUrl: `http://${host}:${port}` };
  }
  try {
    const healthRes = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(2000),
      redirect: 'error',
    });
    if (!healthRes.ok) return { online: false, baseUrl };
    const health = await healthRes.json();
    if (health?.service !== 'slizm-gateway') {
      return { online: false, baseUrl };
    }
    let stats = null;
    try {
      const statsRes = await fetch(`${baseUrl}/v1/usage`, {
        headers: { authorization: `Bearer ${cfg?.server?.clientToken}` },
        signal: AbortSignal.timeout(3000),
        redirect: 'error',
      });
      if (statsRes.ok) {
        stats = await statsRes.json();
      }
    } catch {}
    return {
      online: true,
      pid: health.pid,
      instanceId: health.instanceId ?? null,
      startedAt: health.startedAt ?? null,
      uptimeSec: health.uptimeSec,
      activeRequests: stats?.activeRequests ?? health.activeRequests ?? 0,
      baseUrl,
      stats,
    };
  } catch {
    return { online: false, baseUrl };
  }
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const PERIOD_UNITS = { m: [MINUTE_MS, '分钟'], h: [HOUR_MS, '小时'], d: [DAY_MS, '天'] };
const MAX_PERIOD_MS = 3660 * DAY_MS;
const pad2 = (n) => String(n).padStart(2, '0');

function rangeError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

// 毫秒时间戳或 ISO 日期字符串，其它写法一律视为无效
function parseTimeParam(value) {
  const text = String(value ?? '').trim();
  if (/^\d+$/.test(text)) return Number(text);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? Date.parse(text) : NaN;
}

function formatRangeLabel(start, end) {
  const a = new Date(start);
  const b = new Date(end);
  const day = (d) => `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const clock = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return `${day(a)} ${clock(a)} – ${a.toDateString() === b.toDateString() ? '' : day(b) + ' '}${clock(b)}`;
}

/**
 * 时间范围：today | yesterday | all | N 分钟/小时/天（如 15m、6h、7d）| custom（since/until，毫秒或 ISO）。
 * since/until 都是闭区间端点，用于筛选账本；end 是展示用的结束时刻（自定义范围的 until 参数本身，不含该时刻）。
 * 无法识别的 period 按“今天”处理；自定义范围不合法时抛出 statusCode=400 的错误。
 */
export function parsePeriodRange(period = 'today', { since, until, now = Date.now() } = {}) {
  const p = String(period || 'today').toLowerCase();
  if (p === 'custom') {
    const start = parseTimeParam(since);
    const end = parseTimeParam(until);
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw rangeError('自定义时间范围需要有效的开始和结束时间');
    if (start < 0 || end - start < MINUTE_MS) throw rangeError('结束时间需晚于开始时间至少 1 分钟');
    return { period: 'custom', since: start, until: end - 1, end, label: formatRangeLabel(start, end) };
  }
  if (p === 'all') return { period: 'all', since: 0, until: now, end: now, label: '全部' };
  if (p === 'yesterday') {
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - 1);
    return {
      period: 'yesterday', since: start.getTime(), until: today.getTime() - 1, end: today.getTime(),
      label: `昨天（${pad2(start.getMonth() + 1)}-${pad2(start.getDate())}）`,
    };
  }
  const m = /^(\d+)([mhd])$/.exec(p);
  if (m) {
    const [unitMs, unitLabel] = PERIOD_UNITS[m[2]];
    const n = Number(m[1]);
    if (n >= 1 && n * unitMs <= MAX_PERIOD_MS) {
      return { period: `${n}${m[2]}`, since: now - n * unitMs, until: now, end: now, label: `最近 ${n} ${unitLabel}` };
    }
  }
  const today = parsePeriod('today', new Date(now));
  return { period: 'today', since: today.since, until: now, end: now, label: today.label };
}

function itemCost(item, pricing) {
  if (Object.hasOwn(item, 'costUsd')) return item.costUsd === null ? null : Number(item.costUsd);
  if (item.usageSource !== 'reported') return null;
  return calculateCostUsd(item, pricing, item.model);
}

function itemBaseCost(item, cost) {
  // 旧账本没有原价字段：已落盘的 costUsd 是唯一可信金额，未落盘时按全局原价兼容计算。
  return item.baseCostUsd == null ? cost : Number(item.baseCostUsd);
}

// 趋势粒度。自动模式从小到大取第一个点数不超过 TREND_AUTO_BINS 的步长（半个月左右的范围跳过 12 小时，直接按天）；
// 手动指定的步长点数超过 TREND_MAX_BINS 时放大到最近的可用步长。分钟与小时步长都能整除上一级，分桶落在整点。
const TREND_STEPS = [
  ['1m', MINUTE_MS], ['2m', 2 * MINUTE_MS], ['5m', 5 * MINUTE_MS], ['10m', 10 * MINUTE_MS],
  ['15m', 15 * MINUTE_MS], ['30m', 30 * MINUTE_MS], ['1h', HOUR_MS], ['2h', 2 * HOUR_MS],
  ['3h', 3 * HOUR_MS], ['6h', 6 * HOUR_MS], ['12h', 12 * HOUR_MS], ['1d', DAY_MS],
  ['2d', 2 * DAY_MS], ['3d', 3 * DAY_MS], ['7d', 7 * DAY_MS], ['14d', 14 * DAY_MS], ['30d', 30 * DAY_MS],
];
const TREND_AUTO_SKIP = new Set(['12h']);
export const TREND_AUTO_BINS = 60;
export const TREND_MAX_BINS = 360;
export const TREND_TOP_MODELS = 6;
export const TREND_OTHER_KEY = '__other__';

function trendStep(ms) {
  const [size, unit] = ms % DAY_MS === 0 ? [ms / DAY_MS, 'd'] : ms % HOUR_MS === 0 ? [ms / HOUR_MS, 'h'] : [ms / MINUTE_MS, 'm'];
  return { key: `${size}${unit}`, ms, size, unit, label: `${size} ${PERIOD_UNITS[unit][1]}` };
}

export function resolveTrendStep(requested = 'auto', start, end) {
  const span = Math.max(0, end - start);
  // 取整而非向上取整：范围端点晚几毫秒不应把 1 小时的 60 个点挤成 61 个而换成更粗的粒度
  const bins = (ms) => Math.round(span / ms);
  const key = String(requested || 'auto').toLowerCase();
  const wanted = TREND_STEPS.find(([name]) => name === key);
  if (wanted) {
    const fit = TREND_STEPS.find(([, ms]) => ms >= wanted[1] && bins(ms) <= TREND_MAX_BINS);
    const ms = fit ? fit[1] : Math.ceil(span / TREND_MAX_BINS / DAY_MS) * DAY_MS;
    return { ...trendStep(ms), auto: false, requested: wanted[0], adjusted: ms !== wanted[1] };
  }
  const fit = TREND_STEPS.find(([name, ms]) => !TREND_AUTO_SKIP.has(name) && bins(ms) <= TREND_AUTO_BINS);
  const ms = fit ? fit[1] : Math.max(1, Math.ceil(span / TREND_AUTO_BINS / DAY_MS)) * DAY_MS;
  return { ...trendStep(ms), auto: true, requested: 'auto', adjusted: false };
}

function alignTrendStart(time, step) {
  const d = new Date(time);
  if (step.unit === 'd') d.setHours(0, 0, 0, 0);
  else if (step.unit === 'h') {
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() - (d.getHours() % step.size));
  } else {
    d.setSeconds(0, 0);
    d.setMinutes(d.getMinutes() - (d.getMinutes() % step.size));
  }
  return d;
}

// 按本地时间前进一步（跨夏令时也保持在整点上）
function advanceTrend(d, step) {
  if (step.unit === 'd') d.setDate(d.getDate() + step.size);
  else if (step.unit === 'h') d.setHours(d.getHours() + step.size);
  else d.setMinutes(d.getMinutes() + step.size);
  return d;
}

function emptyTrendRow() {
  return { totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, costUsd: 0, baseCostUsd: 0, hasCost: false };
}

function addTrendRow(target, source) {
  for (const field of ['totalTokens', 'input', 'output', 'cacheRead', 'cacheWrite', 'requests', 'costUsd', 'baseCostUsd']) {
    target[field] += source[field];
  }
  target.hasCost ||= source.hasCost;
}

function finishTrendRow({ hasCost, costUsd, baseCostUsd, ...row }) {
  return { ...row, costUsd: hasCost ? costUsd : null, baseCostUsd: hasCost ? baseCostUsd : null };
}

/**
 * 趋势分桶：每个桶给出合计、缓存读写（算命中率）与按“上游 · 模型”的细分。
 * 细分只保留用量最大的 topModels 个，其余并入 TREND_OTHER_KEY；返回 { points, step, models }。
 */
export function calculateTrend(items, since, until = Date.now(), options = {}, legacyPricing) {
  const legacy = typeof options === 'number';
  const { step = legacy ? '1h' : 'auto', pricing = legacy ? legacyPricing : undefined, topModels = TREND_TOP_MODELS } = legacy ? {} : (options || {});
  const list = items || [];
  const lastItem = list.length ? Date.parse(list[list.length - 1].time) : 0;
  // 自定义范围可能延伸到未来：趋势只画到现在（或最后一条记录）为止
  const end = Math.max(Math.min(until > 0 ? until : Date.now(), Date.now()), lastItem || 0);
  const start = since > 0 ? since : (list.length ? Date.parse(list[0].time) : end);
  const resolved = resolveTrendStep(step, start, Math.max(start, end));
  if (!list.length) return legacy ? [] : { points: [], step: resolved, models: [] };

  const buckets = [];
  const cursor = alignTrendStart(start, resolved);
  do {
    buckets.push({ start: cursor.getTime(), total: emptyTrendRow(), models: new Map() });
    advanceTrend(cursor, resolved);
  } while (cursor.getTime() <= end && buckets.length < TREND_MAX_BINS * 2);
  const lastEnd = cursor.getTime();

  const totals = new Map();
  let b = 0;
  for (const item of list) {
    const t = Date.parse(item.time);
    if (!(t >= buckets[0].start)) continue;
    while (b + 1 < buckets.length && t >= buckets[b + 1].start) b++;
    const row = emptyTrendRow();
    row.input = Number(item.inputTokens) || 0;
    row.output = Number(item.outputTokens) || 0;
    row.cacheRead = Number(item.cacheReadTokens) || 0;
    row.cacheWrite = Number(item.cacheWriteTokens) || 0;
    row.totalTokens = row.input + row.output + row.cacheRead + row.cacheWrite;
    row.requests = 1;
    const cost = itemCost(item, pricing);
    if (cost !== null && cost !== undefined) {
      row.costUsd = cost;
      row.baseCostUsd = itemBaseCost(item, cost);
      row.hasCost = true;
    }
    const key = `${item.provider || 'unknown'} · ${item.model || 'unknown'}`;
    addTrendRow(buckets[b].total, row);
    if (!buckets[b].models.has(key)) buckets[b].models.set(key, emptyTrendRow());
    addTrendRow(buckets[b].models.get(key), row);
    if (!totals.has(key)) totals.set(key, { provider: item.provider || 'unknown', model: item.model || 'unknown', row: emptyTrendRow() });
    addTrendRow(totals.get(key).row, row);
  }

  // 用量从大到小排名；只多出一个时直接列出，不必合并成“其他”
  const ranked = [...totals.entries()]
    .sort(([ka, a], [kb, b]) => b.row.totalTokens - a.row.totalTokens || b.row.requests - a.row.requests || ka.localeCompare(kb));
  const keep = ranked.length > topModels + 1 ? ranked.slice(0, topModels) : ranked;
  const kept = new Set(keep.map(([key]) => key));
  const models = keep.map(([key, info]) => ({ key, provider: info.provider, model: info.model, ...finishTrendRow(info.row) }));
  if (keep.length < ranked.length) {
    const other = emptyTrendRow();
    ranked.slice(keep.length).forEach(([, info]) => addTrendRow(other, info.row));
    models.push({ key: TREND_OTHER_KEY, other: true, count: ranked.length - keep.length, provider: null, model: null, ...finishTrendRow(other) });
  }

  const points = buckets.map((bucket, index) => {
    const entries = [];
    let other = null;
    for (const [key, row] of bucket.models) {
      if (kept.has(key)) entries.push({ key, row });
      else addTrendRow(other ||= emptyTrendRow(), row);
    }
    entries.sort((x, y) => models.findIndex((m) => m.key === x.key) - models.findIndex((m) => m.key === y.key));
    if (other) entries.push({ key: TREND_OTHER_KEY, row: other });
    return {
      time: new Date(bucket.start).toISOString(),
      end: new Date(buckets[index + 1]?.start ?? lastEnd).toISOString(),
      ...finishTrendRow(bucket.total),
      models: entries.map(({ key, row }) => ({ key, ...finishTrendRow(row) })),
    };
  });
  return legacy ? points : { points, step: resolved, models };
}

export function emptyTotals(name = '') {
  return {
    name,
    requests: 0,
    errors: 0,
    cancelled: 0,
    unreported: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0,
    baseCostUsd: 0,
    pricedRequests: 0,
    unpricedRequests: 0,
    totalTokens: 0,
  };
}

function buildSwitchboardRows(items, inflight, providerFilter) {
  const rows = new Map();
  const add = (item, live = false) => {
    if (providerFilter && item.provider !== providerFilter) return;
    const clientType = item.clientType || 'unknown';
    const provider = item.provider || 'unknown';
    const model = item.model || 'unknown';
    const key = [clientType, item.route || '', provider, model, item.inputProtocol || '', item.upstreamProtocol || '', item.adapter || ''].join('\u0001');
    let row = rows.get(key);
    if (!row) {
      row = { clientType, provider, model, route: item.route || '', inputProtocol: item.inputProtocol || null, upstreamProtocol: item.upstreamProtocol || null, adapter: item.adapter || null, requests: 0, successes: 0, errors: 0, cancelled: 0, live: 0, cacheRead: 0, cacheInput: 0, reported: 0, costUsd: 0, baseCostUsd: 0, hasCost: false, durationMs: 0, timed: 0 };
      rows.set(key, row);
    }
    if (live) {
      row.live++;
      return;
    }
    row.requests++;
    if (Number(item.status) === 499) row.cancelled++;
    else if (Number(item.status) >= 200 && Number(item.status) < 400) row.successes++;
    else row.errors++;
    if (item.usageSource === 'reported') {
      row.reported++;
      row.cacheRead += Number(item.cacheReadTokens) || 0;
      row.cacheInput += (Number(item.inputTokens) || 0) + (Number(item.cacheReadTokens) || 0) + (Number(item.cacheWriteTokens) || 0);
    }
    const durationMs = item.durationMs == null ? NaN : Number(item.durationMs);
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      row.durationMs += durationMs;
      row.timed++;
    }
    if (item.costUsd !== null && item.costUsd !== undefined) {
      row.costUsd += Number(item.costUsd) || 0;
      row.baseCostUsd += Number(item.baseCostUsd ?? item.costUsd) || 0;
      row.hasCost = true;
    }
  };
  for (const item of items) add(item);
  for (const item of inflight) add(item, true);
  return [...rows.values()]
    .map(({ durationMs, timed, ...row }) => ({
      ...row,
      costUsd: row.hasCost ? row.costUsd : null,
      baseCostUsd: row.hasCost ? row.baseCostUsd : null,
      avgDurationMs: timed ? Math.round(durationMs / timed) : null,
      cacheHitRate: row.cacheInput ? row.cacheRead / row.cacheInput : null,
      successRate: row.requests - row.cancelled ? row.successes / (row.requests - row.cancelled) : null,
    }))
    .sort((a, b) => (b.requests + b.live) - (a.requests + a.live) || a.clientType.localeCompare(b.clientType) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}
export function configuredSwitchboard(cfg, providerFilter) {
  const configured = [];
  const addPlans = (route, name, model, provider) => {
    const messagesOutput = provider.apiType === 'anthropic' ? 'messages'
      : provider.apiType === 'openai' && provider.messagesTransport === 'responses' ? 'responses' : 'chat-completions';
    const outputs = provider.apiType === 'openai'
      ? provider.messagesTransport === 'responses' ? ['responses'] : ['responses', 'chat-completions']
      : [messagesOutput];
    const add = (inputProtocol, upstreamProtocol) => configured.push({
      route, provider: name, model, inputProtocol, upstreamProtocol,
      adapter: inputProtocol === upstreamProtocol ? 'direct' : inputProtocol + '-to-' + upstreamProtocol,
    });
    add('messages', messagesOutput);
    // OpenAI Codex clients use native Responses; other clients use the configured adapter.
    outputs.forEach((output) => add('responses', output));
  };
  const routes = new Map(cfg?.routes ?? []);
  for (const [name, provider] of cfg?.providers ?? []) {
    for (const alias of Object.keys(provider.models ?? {})) {
      if (!routes.has(alias)) routes.set(alias, { provider: name, model: provider.models[alias] });
    }
  }
  for (const [route, target] of routes) {
    if (providerFilter && target.provider !== providerFilter) continue;
    const provider = cfg.providers.get(target.provider);
    if (!provider) continue;
    const model = provider.models?.[target.model ?? route] ?? target.model ?? route;
    addPlans(route, target.provider, model, provider);
  }
  for (const [name, provider] of cfg?.providers ?? []) {
    if ((!providerFilter || name === providerFilter) && !configured.some((row) => row.provider === name)) {
      addPlans('', name, '', provider);
    }
  }
  return configured;
}

export async function buildSwitchboardLive({ cfg, provider, getGateway }) {
  const gw = await fetchGatewayStatus(cfg, getGateway);
  const sampledAt = gw.stats?.generatedAt ?? new Date().toISOString();
  const switchboardActive = (gw.stats?.inflight ?? []).filter((item) => !provider || item.provider === provider);
  const res = {
    generatedAt: new Date().toISOString(),
    sampledAt,
    online: Boolean(gw.online),
    liveUnknown: !Array.isArray(gw.stats?.inflight),
    activeRequests: gw.stats?.activeRequests ?? gw.activeRequests ?? 0,
    switchboardActive,
    switchboardConfigured: configuredSwitchboard(cfg, provider),
  };
  if (gw.instanceId) res.instanceId = gw.instanceId;
  if (gw.startedAt) res.startedAt = gw.startedAt;
  return res;
}

export async function buildOverview({
  period = 'today',
  since,
  until,
  step = 'auto',
  provider,
  cfg,
  ledgerDir,
  getGateway,
}) {
  const dir = ledgerDir === null ? null : (ledgerDir !== undefined ? ledgerDir : usageLedgerDir());
  const ledgerEnabled = Boolean(dir && existsSync(dir));
  const range = parsePeriodRange(period, { since, until });
  const allHistory = ledgerEnabled ? readLedger(dir, 0) : [];

  const configuredProviderNames = cfg?.providers ? [...cfg.providers.keys()] : [];
  const historicalProviderNames = [...new Set(allHistory.map((item) => item.provider).filter(Boolean))];
  const allProviderNames = [...new Set([...configuredProviderNames, ...historicalProviderNames])].sort();

  const filtered = allHistory.filter((item) => {
    const t = Date.parse(item.time);
    if (range.since > 0 && t < range.since) return false;
    if (range.until && t > range.until) return false;
    if (provider && item.provider !== provider) return false;
    return true;
  });

  const pricing = cfg?.pricing;
  const summaryByProvider = summarize(filtered, 'provider', pricing);
  const summaryByModel = summarize(filtered, 'model', pricing);

  const rowToItem = (name, row) => ({
    name,
    requests: row.requests,
    errors: row.errors,
    cancelled: row.cancelled,
    unreported: row.unreported,
    input: row.input,
    output: row.output,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
    costUsd: row.costUsd,
    baseCostUsd: row.baseCostUsd,
    pricedRequests: row.pricedRequests,
    unpricedRequests: row.unpricedRequests,
    totalTokens: (row.input || 0) + (row.output || 0) + (row.cacheRead || 0) + (row.cacheWrite || 0),
  });

  const providersMap = new Map();
  for (const name of (provider ? [provider] : allProviderNames)) {
    providersMap.set(name, emptyTotals(name));
  }
  for (const [name, row] of summaryByProvider.rows) {
    if (!provider || name === provider) {
      providersMap.set(name, rowToItem(name, row));
    }
  }
  const providers = [...providersMap.values()].map((row) => ({ ...row, priceMultipliers: cfg?.providers?.get(row.name)?.priceMultipliers ?? {} }));

  const models = summaryByModel.rows.map(([name, row]) => rowToItem(name, row));

  const tot = summaryByProvider.total;
  const total = {
    requests: tot.requests,
    errors: tot.errors,
    cancelled: tot.cancelled,
    unreported: tot.unreported,
    input: tot.input,
    output: tot.output,
    cacheRead: tot.cacheRead,
    cacheWrite: tot.cacheWrite,
    costUsd: tot.costUsd,
    baseCostUsd: tot.baseCostUsd,
    pricedRequests: tot.pricedRequests,
    unpricedRequests: tot.unpricedRequests,
    totalTokens: (tot.input || 0) + (tot.output || 0) + (tot.cacheRead || 0) + (tot.cacheWrite || 0),
  };

  const trend = calculateTrend(filtered, range.since, range.until, { step, pricing });
  const recent = filtered.slice(-100).reverse();

  const gw = await fetchGatewayStatus(cfg, getGateway);
  const inflight = (gw?.stats?.inflight ?? []).filter((r) => !provider || r.provider === provider);
  const switchboard = buildSwitchboardRows(filtered, inflight, provider);
  const switchboardConfigured = configuredSwitchboard(cfg, provider);

  const sampledAt = gw.stats?.generatedAt ?? new Date().toISOString();
  const gatewayInfo = {
    online: Boolean(gw.online),
    pid: gw.pid,
    uptimeSec: gw.uptimeSec,
    activeRequests: gw.stats?.activeRequests ?? gw.activeRequests ?? 0,
    baseUrl: gw.baseUrl,
  };
  if (gw.instanceId) gatewayInfo.instanceId = gw.instanceId;
  if (gw.startedAt) gatewayInfo.startedAt = gw.startedAt;

  return {
    generatedAt: new Date().toISOString(),
    sampledAt,
    gateway: gatewayInfo,
    total,
    providers,
    models,
    // range.since/until：实际统计的起止（毫秒，until 为结束时刻）；“全部”从第一条记录算起
    range: {
      period: range.period,
      since: range.since > 0 ? range.since : (filtered.length ? Date.parse(filtered[0].time) : null),
      until: range.end,
      label: range.label,
    },
    trend: trend.points,
    trendStep: trend.step,
    trendModels: trend.models,
    recent,
    inflight,
    switchboard,
    switchboardActive: inflight,
    liveUnknown: !Array.isArray(gw.stats?.inflight),
    switchboardConfigured,
    providerNames: allProviderNames,
    ledgerEnabled,
  };
}
