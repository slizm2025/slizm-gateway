// `node scripts/gw.js tokens` 的报表：汇总 logs/usage-YYYY-MM.jsonl 账本里的 token，用终端图表展示，并附上网关当前在途的请求。
// 账本由网关在每个请求结束时追加（见 src/usage.js），所以网关重启、甚至没在运行时都能看历史用量。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from '../src/config.js';
import { calculateCostUsd } from '../src/pricing.js';
import { usageLedgerDir } from '../src/usage.js';

// 颜色深度：NO_COLOR 关闭，FORCE_COLOR=1/2/3 强制 16 色 / 256 色 / 真彩色，否则看终端能力。
// 输出被管道或重定向（例如 Claude Code 的 Bash 工具）时不带颜色码。
function detectColorDepth() {
  if (process.env.NO_COLOR) return 1;
  const force = process.env.FORCE_COLOR;
  if (force) return { 0: 1, false: 1, 1: 4, true: 4, 2: 8, 3: 24 }[force] ?? 4;
  return process.stdout.isTTY ? (process.stdout.getColorDepth?.() ?? 4) : 1;
}
const DEPTH = detectColorDepth();
const COLOR = DEPTH > 1;

const C = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
};
const paint = (c, s) => (COLOR ? `${c}${s}${C.reset}` : String(s));
const WIDTH = Math.max(64, Math.min(process.stdout.columns || 80, 120) - 2);
const RULE = '─'.repeat(WIDTH);

// token 构成的四类，按固定顺序堆叠：颜色跟着类别走，不跟排名。
// 颜色是 dataviz 参考色板分类色 1–4 的深色档，已用 validate_palette.js 对深色终端（#0c0c0c、#1a1a19）和白底校验，全部通过。
// 不上色时（管道、NO_COLOR）改用疏密不同的方块区分。
export const PARTS = [
  { key: 'cacheRead', field: 'cacheReadTokens', label: '缓存读', hex: '#3987e5', basic: 34, glyph: '█' },
  { key: 'cacheWrite', field: 'cacheWriteTokens', label: '缓存写', hex: '#d95926', basic: 31, glyph: '▓' },
  { key: 'input', field: 'inputTokens', label: '输入', hex: '#199e70', basic: 36, glyph: '▒' },
  { key: 'output', field: 'outputTokens', label: '输出', hex: '#c98500', basic: 33, glyph: '░' },
];

const GROUPS = {
  model: { title: '上游 · 模型', key: (i) => `${i.provider} · ${i.model}` },
  route: { title: '路由', key: (i) => i.route },
  provider: { title: '上游', key: (i) => i.provider },
};

export const USAGE = 'node scripts/gw.js tokens [today | 12h | 7d | all] [--by model|route|provider] [-n 最近条数] [--table]';

// ── 格式化 ──────────────────────────────────────────────────────────────

/** 3 位有效数字的紧凑写法：950 / 1.23k / 45.6k / 789k / 4.56M */
export function fmtTokens(n) {
  n = Number(n) || 0;
  if (n < 1000) return String(Math.round(n));
  const [unit, size] = n >= 999_500_000 ? ['B', 1e9] : n >= 999_500 ? ['M', 1e6] : ['k', 1e3];
  const x = n / size;
  return `${x >= 99.95 ? x.toFixed(0) : x >= 9.995 ? x.toFixed(1) : x.toFixed(2)}${unit}`;
}

/** 坐标轴刻度去掉多余的 0：1M / 2.5M / 500k */
function fmtTick(n) {
  if (n < 1000) return String(n);
  const [unit, size] = n >= 1e9 ? ['B', 1e9] : n >= 1e6 ? ['M', 1e6] : ['k', 1e3];
  return `${Number((n / size).toFixed(2))}${unit}`;
}

export function fmtDuration(ms) {
  ms = Math.max(0, Math.round(Number(ms) || 0));
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`;
}

export function fmtUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  if (n === 0) return '$0.00';
  if (Math.abs(n) < 0.01) return `$${n.toFixed(6)}`;
  if (Math.abs(n) < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

const pad2 = (n) => String(n).padStart(2, '0');
function fmtClock(date, withDay) {
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  return withDay ? `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${time}` : time;
}

function fmtPercent(value, sum) {
  if (!value || !sum) return '-';
  const p = (value / sum) * 100;
  if (p < 0.1) return '<0.1%';
  return p >= 99.95 ? '100%' : `${p.toFixed(1)}%`;
}

// 中日韩文字、全角符号和 emoji 在终端里占两列，按字符数 padEnd 会让表格错位。
// 方块、制表符按一列算（Windows Terminal 默认这样显示）。
const WIDE_RANGES = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1faff],
];
const ANSI = /\u001b\[[0-9;]*m/g;

export function displayWidth(text) {
  let width = 0;
  for (const ch of String(text).replace(ANSI, '')) {
    const cp = ch.codePointAt(0);
    width += WIDE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi) ? 2 : 1;
  }
  return width;
}

function pad(text, width, alignRight) {
  const space = ' '.repeat(Math.max(0, width - displayWidth(text)));
  return alignRight ? space + text : text + space;
}

function truncate(text, width) {
  if (displayWidth(text) <= width) return text;
  let out = '';
  for (const ch of text) {
    if (displayWidth(out + ch) > width - 1) break;
    out += ch;
  }
  return `${out}…`;
}

/** columns: [{ title, right }]，rows: 字符串二维数组（可带颜色码） */
function table(columns, rows) {
  const widths = columns.map((c, i) => Math.max(displayWidth(c.title), ...rows.map((r) => displayWidth(r[i]))));
  const render = (cells) => `  ${cells.map((cell, i) => pad(cell, widths[i], columns[i].right)).join('  ')}`.trimEnd();
  return [paint(C.dim, render(columns.map((c) => c.title))), ...rows.map(render)];
}

// ── 图形 ────────────────────────────────────────────────────────────────

function partColor(part, depth) {
  const n = parseInt(part.hex.slice(1), 16);
  const rgb = [n >> 16, (n >> 8) & 255, n & 255];
  if (depth >= 24) return `\u001b[38;2;${rgb.join(';')}m`;
  if (depth >= 8) {
    const [r, g, b] = rgb.map((c) => Math.round((c / 255) * 5));
    return `\u001b[38;5;${16 + 36 * r + 6 * g + b}m`;
  }
  return `\u001b[${part.basic}m`;
}

function blocks(part, cells, color) {
  if (cells <= 0) return '';
  return color ? `${partColor(part, DEPTH)}${'█'.repeat(cells)}${C.reset}` : part.glyph.repeat(cells);
}

const swatch = (part, color) => blocks(part, 2, color);

/**
 * 把 cells 个格子按数值分给各段：最大余数法，保证总数不变。
 * 格子够分时每个非零段至少 1 格，小段不会消失（精确值见图例和 --table）。
 */
export function allocateCells(values, cells) {
  const total = values.reduce((a, b) => a + b, 0);
  if (!total || cells <= 0) return values.map(() => 0);
  const exact = values.map((v) => (v / total) * cells);
  const nonzero = values.filter((v) => v > 0).length;
  const out = exact.map((x, i) => (values[i] > 0 && nonzero <= cells ? Math.max(1, Math.floor(x)) : Math.floor(x)));
  let diff = cells - out.reduce((a, b) => a + b, 0);
  const byRemainder = values
    .map((v, i) => i)
    .filter((i) => values[i] > 0)
    .sort((a, b) => (exact[b] - Math.floor(exact[b])) - (exact[a] - Math.floor(exact[a])));
  for (let k = 0; diff > 0; k++, diff--) out[byRemainder[k % byRemainder.length]]++;
  for (; diff < 0; diff++) out[out.indexOf(Math.max(...out))]--;
  return out;
}

/** 按 PARTS 顺序堆叠的横条，values 与 PARTS 一一对应 */
export function stackedBar(values, cells, { color = COLOR } = {}) {
  const counts = allocateCells(values, cells);
  return PARTS.map((part, i) => blocks(part, counts[i], color)).join('');
}

/** 纵轴上限取整：1 / 2 / 2.5 / 5 × 10^n */
export function niceCeil(value) {
  if (!(value > 0)) return 1;
  const base = 10 ** Math.floor(Math.log10(value));
  const f = value / base;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * base;
}

const itemTotal = (item) => PARTS.reduce((sum, p) => sum + (Number(item[p.field]) || 0), 0);

/**
 * 按本地时间分桶：跨度 48 小时以内按小时，否则按天。
 * 桶数超过 maxBuckets 时几个单位并成一桶；按小时合并时只用能整除 24 的步长，保证刻度落在整点。
 */
export function bucketize(items, since, now = Date.now(), maxBuckets = 36) {
  if (!items.length) return [];
  const start = since > 0 ? since : Date.parse(items[0].time);
  // 留 1 分钟余量：`48h` 的起点在解析参数时就定了，出图时的 now 会晚几毫秒
  const hourly = now - start <= 48 * 3_600_000 + 60_000;
  const first = new Date(start);
  if (hourly) first.setMinutes(0, 0, 0);
  else first.setHours(0, 0, 0, 0);
  const units = Math.floor((now - first.getTime()) / (hourly ? 3_600_000 : 86_400_000)) + 1;
  const need = Math.ceil(units / maxBuckets);
  const group = hourly ? [1, 2, 3, 4, 6, 8, 12, 24].find((g) => g >= need) ?? 24 : Math.max(1, need);
  if (hourly) first.setHours(first.getHours() - (first.getHours() % group));

  const buckets = [];
  for (const d = first; d.getTime() <= now; hourly ? d.setHours(d.getHours() + group) : d.setDate(d.getDate() + group)) {
    buckets.push({ start: d.getTime(), hourly, group, value: 0, requests: 0 });
  }
  let b = 0;
  for (const item of items) {
    const t = Date.parse(item.time);
    if (!(t >= buckets[0].start)) continue;
    while (b + 1 < buckets.length && t >= buckets[b + 1].start) b++;
    buckets[b].value += itemTotal(item);
    buckets[b].requests++;
  }
  return buckets;
}

export function chartTitle(buckets) {
  const { hourly, group } = buckets[0];
  const unit = hourly ? (group === 1 ? '每小时' : `每 ${group} 小时`) : group === 1 ? '每天' : `每 ${group} 天`;
  return `${unit} token 合计`;
}

const EIGHTHS = ' ▁▂▃▄▅▆▇█';

/** 柱状趋势图：单一序列（token 合计），纵向用 1/8 格方块提高精度；返回文本行 */
export function renderColumnChart(buckets, { width = WIDTH, height = 6, color = COLOR } = {}) {
  const max = Math.max(0, ...buckets.map((b) => b.value));
  if (!max) return [];
  const top = niceCeil(max);
  const ticks = { [height - 1]: fmtTick(top) };
  if (height % 2 === 0) ticks[height / 2 - 1] = fmtTick(top / 2);
  const gutter = Math.max(...Object.values(ticks).map(displayWidth));
  const slot = Math.max(1, Math.min(4, Math.floor((width - gutter - 4) / buckets.length)));
  const col = slot > 1 ? slot - 1 : 1;
  const levels = buckets.map((b) => (b.value > 0 ? Math.max(1, Math.round((b.value / top) * height * 8)) : 0));
  const dim = (s) => (color ? `${C.dim}${s}${C.reset}` : s);

  const lines = [];
  for (let r = height - 1; r >= 0; r--) {
    const tick = ticks[r] ?? '';
    const cells = levels.map((lv) => EIGHTHS[Math.max(0, Math.min(8, lv - r * 8))].repeat(col) + ' '.repeat(slot - col)).join('');
    lines.push(`  ${dim(`${pad(tick, gutter, true)} ${tick ? '┤' : '│'}`)}${cells}`.trimEnd());
  }
  lines.push(`  ${dim(`${pad('0', gutter, true)} └${'─'.repeat(slot * buckets.length)}`)}`);

  // 横轴刻度：按小时对齐整点，按天从最新一天往回数，文字不重叠
  const labelOf = (b) => {
    const d = new Date(b.start);
    return b.hourly ? pad2(d.getHours()) : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  };
  const labelWidth = labelOf(buckets[0]).length;
  const { hourly, group } = buckets[0];
  let wanted;
  if (hourly) {
    const every = [1, 2, 3, 4, 6, 8, 12, 24].find((h) => h % group === 0 && (h / group) * slot >= labelWidth + 1) ?? 24;
    wanted = (b) => new Date(b.start).getHours() % every === 0;
  } else {
    const every = [1, 2, 3, 5, 7, 10, 14, 30].find((k) => k * slot >= labelWidth + 1) ?? 30;
    wanted = (b, i) => (buckets.length - 1 - i) % every === 0;
  }
  let axis = '';
  buckets.forEach((b, i) => {
    const pos = i * slot;
    if (!wanted(b, i) || pos < axis.length + (axis ? 1 : 0)) return;
    axis += ' '.repeat(pos - axis.length) + labelOf(b);
  });
  lines.push(`  ${' '.repeat(gutter + 2)}${dim(axis)}`);
  return lines;
}

// ── 账本读取与汇总 ────────────────────────────────────────────────────────

/** 解析时间范围；无法识别时返回 null */
export function parsePeriod(arg = 'today', now = new Date()) {
  const value = String(arg).toLowerCase();
  if (value === 'all') return { since: 0, label: '账本全部' };
  if (value === 'today') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { since: start.getTime(), label: `今天（${pad2(start.getMonth() + 1)}-${pad2(start.getDate())} 00:00 起）` };
  }
  const m = /^(\d+)([hd])$/.exec(value);
  if (!m || Number(m[1]) < 1) return null;
  const hours = Number(m[1]) * (m[2] === 'd' ? 24 : 1);
  return { since: now.getTime() - hours * 3_600_000, label: `最近 ${m[1]} ${m[2] === 'd' ? '天' : '小时'}` };
}

const monthOf = (time) => {
  const d = new Date(time);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
};

/** 读出 since 之后结束的请求（按时间升序）。账本按本地月份分文件，只读可能相关的月份 */
export function readLedger(dir, since = 0) {
  if (!dir || !existsSync(dir)) return [];
  const fromMonth = since > 0 ? monthOf(since) : '';
  const files = readdirSync(dir)
    .filter((f) => /^usage-\d{4}-\d{2}\.jsonl$/.test(f) && f.slice(6, 13) >= fromMonth)
    .sort();
  const items = [];
  for (const file of files) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let item;
      try { item = JSON.parse(line); } catch { continue; } // 进程被强杀时最后一行可能不完整
      if (Date.parse(item?.time) >= since) items.push(item);
    }
  }
  return items.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

function emptyRow() {
  return {
    requests: 0, errors: 0, cancelled: 0, unreported: 0,
    input: 0, cacheRead: 0, cacheWrite: 0, output: 0, durationMs: 0,
    costUsd: 0, pricedRequests: 0, unpricedRequests: 0,
  };
}

export const rowTotal = (r) => r.input + r.cacheRead + r.cacheWrite + r.output;

function itemCost(item, pricing) {
  if (Object.hasOwn(item, 'costUsd')) return item.costUsd === null ? null : Number(item.costUsd);
  if (item.usageSource !== 'reported') return null;
  return calculateCostUsd(item, pricing, item.model);
}

function addItem(row, item, pricing) {
  row.requests++;
  if (item.status === 499) row.cancelled++;
  else if (!(item.status >= 200 && item.status < 400)) row.errors++;
  if (item.usageSource !== 'reported') row.unreported++;
  for (const p of PARTS) row[p.key] += Number(item[p.field]) || 0;
  row.durationMs += Number(item.durationMs) || 0;
  const cost = itemCost(item, pricing);
  if (cost === null) {
    if (item.usageSource === 'reported') row.unpricedRequests++;
  } else {
    row.costUsd += cost;
    row.pricedRequests++;
  }
}

/** 总计 + 按维度分组，组按 token 合计降序 */
export function summarize(items, by = 'model', pricing) {
  const total = emptyRow();
  const groups = new Map();
  for (const item of items) {
    const key = GROUPS[by].key(item);
    if (!groups.has(key)) groups.set(key, emptyRow());
    addItem(total, item, pricing);
    addItem(groups.get(key), item, pricing);
  }
  const rows = [...groups.entries()].sort((a, b) => rowTotal(b[1]) - rowTotal(a[1]) || b[1].requests - a[1].requests);
  return { total, rows };
}

// ── 输出 ────────────────────────────────────────────────────────────────

function parseArgs(args) {
  const opts = { period: 'today', recent: 10, by: 'model', table: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-n' || args[i] === '--recent') opts.recent = Number(args[++i]);
    else if (args[i] === '--by') opts.by = String(args[++i]);
    else if (args[i] === '--table') opts.table = true;
    else opts.period = args[i];
  }
  const period = parsePeriod(opts.period);
  if (!period) return { error: `无法识别的时间范围: ${opts.period}` };
  if (!Number.isInteger(opts.recent) || opts.recent < 0) return { error: '-n 需要一个非负整数' };
  if (!Object.hasOwn(GROUPS, opts.by)) return { error: `--by 只支持 ${Object.keys(GROUPS).join(' / ')}` };
  return { ...opts, ...period };
}

const cacheHitRate = (r) => {
  const context = r.input + r.cacheRead + r.cacheWrite;
  return context ? `${Math.round((r.cacheRead / context) * 100)}%` : '-';
};
const cell = (n) => (n ? fmtTokens(n) : '-');
function costCell(row) {
  if (!row.pricedRequests && !row.unpricedRequests) return '-';
  if (!row.pricedRequests) return `未配置(${row.unpricedRequests})`;
  return row.unpricedRequests ? `${fmtUsd(row.costUsd)} +未配置${row.unpricedRequests}` : fmtUsd(row.costUsd);
}

function statusText(status) {
  if (status === 499) return paint(C.yellow, '取消');
  return paint(status >= 200 && status < 400 ? C.green : C.red, String(status));
}

async function fetchLive(base, token) {
  try {
    const health = await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) })).json();
    const res = await fetch(`${base}/v1/usage`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      await res.body?.cancel();
      return { health, status: res.status };
    }
    return { health, stats: await res.json() };
  } catch {
    return null;
  }
}

/** 总量构成：一根整宽的堆叠条 + 两列图例（数值与占比） */
function printComposition(total) {
  const values = PARTS.map((p) => total[p.key]);
  const sum = values.reduce((a, b) => a + b, 0);
  console.log(`  ${stackedBar(values, WIDTH - 2)}`);
  const entries = PARTS.map((part, i) => [part, cell(values[i]), fmtPercent(values[i], sum)]);
  const labelW = Math.max(...PARTS.map((p) => displayWidth(p.label)));
  const valueW = Math.max(...entries.map((e) => displayWidth(e[1])));
  const pctW = Math.max(...entries.map((e) => displayWidth(e[2])));
  const render = ([part, value, pct]) => `${swatch(part, COLOR)} ${pad(part.label, labelW)} ${pad(value, valueW, true)} ${pad(pct, pctW, true)}`;
  for (let i = 0; i < entries.length; i += 2) console.log(`  ${entries.slice(i, i + 2).map(render).join('      ')}`);
}

/** 分组对比：每组一根按构成堆叠的横条，长度按组内最大合计缩放 */
function printGroupBars(opts, rows) {
  const maxTotal = Math.max(0, ...rows.map(([, r]) => rowTotal(r)));
  const names = rows.map(([name]) => truncate(name, 30));
  const totals = rows.map(([, r]) => cell(rowTotal(r)));
  const counts = rows.map(([, r]) => `${r.requests} 次`);
  const nameW = Math.max(displayWidth(GROUPS[opts.by].title), ...names.map(displayWidth));
  const totalW = Math.max(...totals.map(displayWidth));
  const countW = Math.max(...counts.map(displayWidth));
  const failW = rows.some(([, r]) => r.errors) ? 5 : 0;
  const barW = Math.max(10, WIDTH - nameW - totalW - countW - failW - 8);
  console.log(`  ${paint(C.dim, GROUPS[opts.by].title)}`);
  rows.forEach(([, r], i) => {
    const t = rowTotal(r);
    const cells = t ? Math.max(1, Math.round((t / maxTotal) * barW)) : 0;
    const bar = stackedBar(PARTS.map((p) => r[p.key]), cells);
    const failed = r.errors ? `  ${paint(C.red, `✗ ${r.errors}`)}` : '';
    console.log(`  ${pad(names[i], nameW)}  ${pad(bar, barW)}  ${pad(totals[i], totalW, true)}  ${pad(counts[i], countW, true)}${failed}`.trimEnd());
  });
}

/** --table：同一份数据的完整数字表 */
function printTable(opts, rows) {
  const columns = [
    { title: GROUPS[opts.by].title }, { title: '请求', right: true }, { title: '失败', right: true },
    ...PARTS.map((p) => ({ title: p.label, right: true })),
    { title: '合计', right: true }, { title: '费用', right: true }, { title: '平均耗时', right: true },
  ];
  const body = rows.map(([name, r]) => [
    name, String(r.requests), r.errors ? paint(C.red, String(r.errors)) : '-',
    ...PARTS.map((p) => cell(r[p.key])), fmtTokens(rowTotal(r)), costCell(r), fmtDuration(r.durationMs / r.requests),
  ]);
  for (const line of table(columns, body)) console.log(line);
}

function printSummary(opts, items, dir, pricing) {
  const { total, rows } = summarize(items, opts.by, pricing);
  console.log(`  ${paint(C.cyan, 'Token 用量')} · ${opts.label}`);
  console.log(RULE);
  if (!total.requests) {
    console.log(paint(C.dim, dir ? '  这段时间账本里没有请求记录。' : '  账本未启用（GATEWAY_USAGE_DIR=off，或使用了自定义 GATEWAY_CONFIG）。'));
    return;
  }
  const price = costCell(total);
  const priceNote = total.unpricedRequests ? ` · 未配置价格 ${total.unpricedRequests} 条` : '';
  console.log(`  合计 ${paint(C.bold, fmtTokens(rowTotal(total)))} tokens    费用 ${paint(C.bold, price)}${priceNote}    缓存命中 ${cacheHitRate(total)}`);
  const counts = [`请求 ${total.requests}`];
  if (total.errors) counts.push(paint(C.red, `✗ 失败 ${total.errors}`));
  if (total.cancelled) counts.push(paint(C.yellow, `取消 ${total.cancelled}`));
  if (total.unreported) counts.push(paint(C.dim, `未上报 ${total.unreported}`));
  counts.push(`平均耗时 ${fmtDuration(total.durationMs / total.requests)}`);
  console.log(`  ${counts.join(' · ')}`);
  if (rowTotal(total)) {
    console.log('');
    printComposition(total);
    const buckets = bucketize(items, opts.since, Date.now(), Math.floor((WIDTH - 10) / 2));
    const chart = renderColumnChart(buckets);
    if (chart.length) {
      console.log('');
      console.log(`  ${paint(C.dim, chartTitle(buckets))}`);
      for (const line of chart) console.log(line);
    }
  }
  console.log(RULE);
  printGroupBars(opts, rows);
  if (opts.table) {
    console.log('');
    printTable(opts, rows);
  }
}

function printRecent(items, count, pricing) {
  const recent = count > 0 ? items.slice(-count).reverse() : [];
  if (!recent.length) return;
  console.log(RULE);
  const today = new Date().toDateString();
  const contextOf = (item) => (Number(item.inputTokens) || 0) + (Number(item.cacheReadTokens) || 0) + (Number(item.cacheWriteTokens) || 0);
  const maxContext = Math.max(0, ...recent.filter((i) => i.usageSource === 'reported').map(contextOf));
  const BAR = 12;
  const hasError = recent.some((i) => i.error);
  const rows = recent.map((item) => {
    const time = new Date(item.time);
    let context = '-';
    let output = '-';
    if (item.usageSource === 'reported') {
      const ctx = contextOf(item);
      const cells = ctx ? Math.max(1, Math.round((ctx / maxContext) * BAR)) : 0;
      context = `${pad('━'.repeat(cells), BAR)} ${pad(fmtTokens(ctx), 5, true)}`;
      output = fmtTokens(item.outputTokens);
    } else if (!item.error) {
      context = paint(C.dim, item.estimatedInputTokens ? `未上报 ~${fmtTokens(item.estimatedInputTokens)}` : '未上报');
    }
    const cost = itemCost(item, pricing);
    const row = [fmtClock(time, time.toDateString() !== today), item.route, statusText(item.status), fmtDuration(item.durationMs), context, output, cost === null ? (item.usageSource === 'reported' ? '未配置' : '-') : fmtUsd(cost)];
    if (hasError) row.push(item.error ? paint(C.red, item.error.slice(0, 60)) : '');
    return row;
  });
  console.log(`  最近 ${recent.length} 条  ${paint(C.dim, '上下文 = 输入 + 缓存读 + 缓存写，条长按这几条里最大的缩放')}`);
  const columns = [{ title: '时间' }, { title: '路由' }, { title: '状态' }, { title: '耗时', right: true }, { title: '上下文' }, { title: '输出', right: true }, { title: '费用', right: true }];
  if (hasError) columns.push({ title: '错误' });
  for (const line of table(columns, rows)) console.log(line);
}

function printLive(live) {
  console.log(RULE);
  if (!live) {
    console.log(paint(C.dim, '  网关未运行（以上是账本里的历史数据）。'));
    return;
  }
  const { health } = live;
  const head = `  网关运行中 · pid ${health.pid} · 已运行 ${fmtDuration((health.uptimeSec ?? 0) * 1000)}`;
  if (!live.stats) {
    const hint = live.status === 404 ? '进程是旧版本，没有 /v1/usage，重启网关后才开始记账' : `/v1/usage 返回 HTTP ${live.status}`;
    console.log(`${head} · ${paint(C.yellow, hint)}`);
    return;
  }
  const inflight = live.stats.inflight ?? [];
  console.log(`${head} · 在途 ${inflight.length}`);
  const rows = inflight
    .sort((a, b) => b.elapsedMs - a.elapsedMs)
    .map((r) => [
      r.requestId, r.route, `已 ${fmtDuration(r.elapsedMs)}`,
      r.contextTokens !== undefined ? `上下文 ${fmtTokens(r.contextTokens)}` : paint(C.dim, `估算输入 ~${fmtTokens(r.estimatedInputTokens)}`),
    ]);
  if (rows.length) for (const line of table([{ title: '请求' }, { title: '路由' }, { title: '耗时' }, { title: 'token' }], rows)) console.log(line);
}

export async function printUsageReport({ args = [], base, token, pricing }) {
  const opts = parseArgs(args);
  if (opts.error) {
    console.log(paint(C.red, opts.error));
    console.log(paint(C.dim, `用法: ${USAGE}`));
    process.exitCode = 1;
    return;
  }
  const dir = usageLedgerDir();
  const items = readLedger(dir, opts.since);
  const live = await fetchLive(base, token);
  console.log(RULE);
  printSummary(opts, items, dir, pricing);
  printRecent(items, opts.recent, pricing);
  printLive(live);
  console.log(RULE);
  if (dir) console.log(paint(C.dim, `  账本: ${(relative(ROOT, dir) || '.').replaceAll('\\', '/')}/usage-YYYY-MM.jsonl`));
  console.log(paint(C.dim, `  ${USAGE}`));
}
