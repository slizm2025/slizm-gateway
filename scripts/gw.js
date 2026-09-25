#!/usr/bin/env node
// 网关统一管理入口：start / stop / restart / status / logs / test / health
// 目的：把"起一个后台 node 进程"封装成一条命令，并管住 PID、日志、端口占用。
// 用法:  node scripts/gw.js <命令>
import { spawn, execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
  statSync,
  closeSync,
  renameSync,
  readSync,
} from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';
import { env, loadConfig } from '../src/config.js';
import { createConnection } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LOGS = join(ROOT, 'logs');
const PID_FILE = join(LOGS, 'gateway.pid');
const OUT_LOG = join(LOGS, 'gateway.out.log');
const ERR_LOG = join(LOGS, 'gateway.err.log');

mkdirSync(LOGS, { recursive: true });

const C = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  magenta: '\u001b[35m',
  cyan: '\u001b[36m',
};
const paint = (c, s) => `${c}${s}${C.reset}`;

const readEnvValue = env;

function atomicWrite(path, content) {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, content, { flag: 'wx', mode: 0o600 });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

const HOST = readEnvValue('GATEWAY_HOST', '127.0.0.1');
const PORT = Number(readEnvValue('GATEWAY_PORT', '4000'));
const BASE = `http://${HOST}:${PORT}`;

/** 读取 pid 文件并确认进程还活着 */
function readPid() {
  if (!existsSync(PID_FILE)) return null;
  const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0); // 信号 0 = 只探测存活，不真的杀
    return pid;
  } catch {
    return null;
  }
}

/** 端口是否已被监听（用于识别"非本管理器启动"的实例） */
function portInUse(host, port, timeout = 800) {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

async function health() {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const ARCHIVE = join(LOGS, 'archive');
const ROTATE_BYTES = 10 * 1024 * 1024;

/** 启动前轮转：超过 10MB 的日志移进 logs/archive/，每种只留最近 5 份 */
function rotateIfLarge(path) {
  try {
    if (!existsSync(path) || statSync(path).size < ROTATE_BYTES) return;
    mkdirSync(ARCHIVE, { recursive: true });
    const name = basename(path, '.log');
    renameSync(path, join(ARCHIVE, `${name}.${stamp()}.log`));
    const old = readdirSync(ARCHIVE).filter((f) => f.startsWith(`${name}.`)).sort().reverse().slice(5);
    for (const f of old) rmSync(join(ARCHIVE, f), { force: true });
    console.log(paint(C.dim, `  已轮转 ${basename(path)} → logs/archive/`));
  } catch (e) {
    console.log(paint(C.yellow, `日志轮转失败，不影响启动: ${e.message}`));
  }
}

async function cmdStart() {
  const existing = readPid();
  if (existing) {
    console.log(paint(C.yellow, `网关已在运行 (pid ${existing})`));
    return cmdStatus();
  }
  if (await portInUse(HOST, PORT)) {
    console.log(
      paint(C.red, `端口 ${PORT} 已被占用，但不是本管理器启动的进程。`),
    );
    console.log(paint(C.dim, `  先找出占用者: netstat -ano | findstr :${PORT}`));
    process.exitCode = 1;
    return;
  }

  // 旧进程已经退出，没有人在写日志，这时轮转最安全
  rotateIfLarge(OUT_LOG);
  rotateIfLarge(ERR_LOG);
  const spawnedAt = Date.now();
  const out = openSync(OUT_LOG, 'a');
  const err = openSync(ERR_LOG, 'a');
  let child;
  try {
    child = spawn(process.execPath, [join(ROOT, 'src', 'server.js')], {
      cwd: ROOT, detached: true, stdio: ['ignore', out, err], windowsHide: true,
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  } finally {
    closeSync(out); closeSync(err);
  }
  child.unref();
  atomicWrite(PID_FILE, String(child.pid));

  // 等它真正开始监听，而不是盲目 sleep
  let up = null;
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    const info = await health();
    if (info?.service === 'slizm-gateway' && info.pid === child.pid) { up = info; break; }
    if (child.exitCode !== null) break;
  }

  if (!up) {
    if (child.exitCode === null) child.kill();
    if (readPid() === child.pid || child.exitCode !== null) rmSync(PID_FILE, { force: true });
    // 只展示这次启动产生的 stderr，别把 err.log 里以前的崩溃栈当成这次的失败原因
    const fresh = existsSync(ERR_LOG) && statSync(ERR_LOG).mtimeMs >= spawnedAt;
    console.log(paint(C.red, `启动失败，进程 ${child.pid} 没能就绪。${fresh ? '错误输出：' : 'err.log 没有新输出，out.log 末尾：'}`));
    console.log(paint(C.dim, tailLog(fresh ? ERR_LOG : OUT_LOG, 15)));
    process.exitCode = 1;
    return;
  }
  console.log(paint(C.green, `✓ 网关已启动 (pid ${child.pid})  ${BASE}`));
  console.log(paint(C.dim, `  日志: logs/gateway.out.log   管理: node scripts/gw.js status`));
}

function stopTree(pid) {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return false;
    }
  }
  return true;
}

async function cmdStop() {
  const pid = readPid();
  if (!pid) {
    if (existsSync(PID_FILE)) rmSync(PID_FILE, { force: true });
    if (await portInUse(HOST, PORT)) {
      console.log(
        paint(C.yellow, `没有记录在案的 pid，但端口 ${PORT} 仍在监听（可能是别的方式启动的）。`),
      );
      console.log(paint(C.dim, `  netstat -ano | findstr :${PORT}  然后 taskkill /PID <pid> /F`));
      return;
    }
    console.log(paint(C.dim, '网关本来就没在运行。'));
    return;
  }
  const info = await health();
  if (info?.service !== 'slizm-gateway' || info.pid !== pid) {
    console.log(paint(C.red, `拒绝停止：无法验证 pid ${pid} 属于当前网关。请检查进程命令行，旧版进程需手动停止。`));
    process.exitCode = 1;
    return;
  }
  if (info.activeRequests > 0) {
    console.log(paint(C.red, `网关仍有 ${info.activeRequests} 个在途请求，请结束后再停止。`));
    process.exitCode = 1;
    return;
  }
  const ok = stopTree(pid);
  if (ok) {
    rmSync(PID_FILE, { force: true });
    console.log(paint(C.green, `✓ 已停止 (pid ${pid})`));
  } else {
    process.exitCode = 1;
    console.log(paint(C.red, `停止失败，保留 pid ${pid} 供后续排查`));
  }
}

async function cmdRestart() {
  await cmdStop();
  if (process.exitCode) return;
  for (let n = 0; n < 40 && await portInUse(HOST, PORT); n++) await new Promise((r) => setTimeout(r, 100));
  await cmdStart();
}

async function cmdStatus() {
  const pid = readPid();
  const info = await health();
  const line = '─'.repeat(64);
  console.log(line);
  if (!info) {
    console.log(`  状态: ${paint(C.red, '未运行')}${pid ? paint(C.dim, ` (pid ${pid} 存在但 /health 不通)`) : ''}`);
    console.log(line);
    process.exitCode = 1;
    return;
  }
  console.log(`  状态: ${paint(C.green, '运行中')}  pid ${pid ?? '未知'}  已运行 ${info.uptimeSec}s`);
  console.log(`  地址: ${BASE}`);
  console.log(`  传输: ${info.transport ?? '旧版（无版本标记）'}`);
  const sourceFiles = readdirSync(join(ROOT, 'src'), { recursive: true }).filter((p) => p.endsWith('.js'));
  const changed = sourceFiles.some((p) => statSync(join(ROOT, 'src', p)).mtimeMs > Date.parse(info.startedAt ?? '') + 1000);
  if (!info.startedAt || changed) console.log(paint(C.yellow, '  ⚠ 源码可能比运行进程更新，请在请求完成后重启网关。'));
  console.log(line);
  console.log('  模型路由:');
  for (const [alias, target] of Object.entries(info.routes ?? {})) {
    console.log(`    ${alias.padEnd(10)} -> ${target}`);
  }
  console.log(line);
  console.log('  provider:');
  for (const p of info.providers ?? []) {
    console.log(`    ${String(p.name).padEnd(12)} ${String(p.apiType).padEnd(10)} ${p.baseUrl}`);
  }
  console.log(line);
}

const PROBLEM = / ✗ | ⚠ | ↻ | 异常: | 上游错误 | 流式失败| 上游抖动/;
const LINE_COLORS = [
  [/ ✗ | 异常: | 上游错误 | 流式失败/, C.red],
  [/ ⚠ | ↻ | 上游抖动/, C.yellow],
  [/ ⊘ | 客户端已断开/, C.dim],
  [/ ← /, C.green],
  [/ → /, C.cyan],
];
const isProblemLine = (line) => PROBLEM.test(line);

/** 旧日志的时间是 UTC ISO（2026-09-24T19:56:51.981Z），显示时统一换成本地时间 */
function localTime(line) {
  const m = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\]/.exec(line);
  if (!m) return line;
  const d = new Date(m[1]);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `[${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}]${line.slice(m[0].length)}`;
}

// 展示层不修改磁盘日志；原始模式明确跳过格式转换。
const cleanLogText = (text) => stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\t/g, '    ');
function logPaint(color, text) {
  const enabled = !Object.hasOwn(process.env, 'NO_COLOR') && (process.env.FORCE_COLOR
    ? process.env.FORCE_COLOR !== '0'
    : process.stdout.isTTY);
  return enabled ? paint(color, text) : text;
}

function parseLogOptions(args) {
  const options = { n: 40, width: Math.max(40, Math.min(240, process.stdout.columns || 120)), mode: 'compact', follow: false, errors: false, history: false };
  let hasCount = false;
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (/^\d+$/.test(arg)) {
      if (hasCount || !Number.isSafeInteger(Number(arg)) || Number(arg) < 1 || Number(arg) > 10000) throw new Error('行数必须是 1..10000 的整数，且只能指定一次');
      options.n = Number(arg); hasCount = true; continue;
    }
    if (['-f', '--follow'].includes(arg)) { options.follow = true; continue; }
    if (['-e', '--errors'].includes(arg)) { options.errors = true; continue; }
    if (arg === '--history') { options.history = true; continue; }
    if (['--detail', '--raw'].includes(arg)) {
      if (options.mode !== 'compact' && options.mode !== arg.slice(2)) throw new Error('--detail 与 --raw 不能同时使用');
      options.mode = arg.slice(2); continue;
    }
    const match = /^(--id|--route|--width)(?:=(.*))?$/.exec(arg);
    if (!match) throw new Error(`未知选项 ${cleanLogText(arg)}`);
    const key = match[1].slice(2);
    const value = match[2] ?? args[++i];
    if (!value || value.startsWith('--') || seen.has(key)) throw new Error(`${match[1]} 需要一个非空值，且只能指定一次`);
    seen.add(key);
    if (key === 'id') {
      if (!/^(?:gw_)?[a-f0-9]{8}$/i.test(value)) throw new Error('--id 需要 gw_ 加 8 位十六进制 ID，或其 8 位简写');
      options.id = 'gw_' + value.replace(/^gw_/i, '').toLowerCase();
    } else if (key === 'width') {
      if (!/^\d+$/.test(value) || Number(value) < 40 || Number(value) > 240) throw new Error('--width 必须是 40..240 的整数');
      options.width = Number(value);
    } else {
      if (/\s|[\x00-\x1f\x7f-\x9f]/.test(value)) throw new Error('--route 不允许空白或控制字符');
      options.route = value;
    }
  }
  if (options.mode === 'raw' && options.history) throw new Error('--raw 仅输出 stdout，不能与 --history 同用');
  return options;
}

function parseLogLine(raw) {
  const line = localTime(cleanLogText(raw));
  const match = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3})\](?: \[(gw_[a-f0-9]{8})\])? (.*)$/i.exec(line);
  const body = match?.[4] ?? line;
  const event = /^([→←✗⚠↻⊘]) (\S+)(?: (.*))?$/.exec(body);
  return { line, date: match?.[1], time: match?.[2], id: match?.[3]?.toLowerCase(), body, icon: event?.[1], route: event?.[2], detail: (event?.[3] ?? '').replace(/^· /, '') };
}
function matchesLog(raw, options) {
  const entry = parseLogLine(raw);
  return (!options.errors || isProblemLine(entry.line))
    && (!options.id || entry.id === options.id)
    && (!options.route || entry.route === options.route);
}

const logSegments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function charWidth(text) {
  if (/^\p{Mark}+$/u.test(text)) return 0;
  if (/\p{Extended_Pictographic}/u.test(text) && !/^[←→✓✗⚠↻⊘]$/u.test(text)) return 2;
  const cp = text.codePointAt(0);
  return cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe10 && cp <= 0xfe19) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff01 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || cp >= 0x20000) ? 2 : 1;
}
function logWidth(text) { return [...logSegments.segment(text)].reduce((n, { segment }) => n + charWidth(segment), 0); }
function logPad(text, width) { return text + ' '.repeat(Math.max(0, width - logWidth(text))); }
function wrapLog(text, width) {
  const lines = []; let line = '';
  // 指标标签和数值保持在一起，避免“费用”与金额分到两行。
  for (const token of text.match(/(?:首字节|共|输入|缓存读|缓存写|输出|费用)\s+\S+\s*|\S+\s*|\s+/gu) ?? []) {
    if (line && logWidth(line + token.trimEnd()) > width) {
      lines.push(line.trimEnd()); line = '';
    }
    for (const { segment } of logSegments.segment(token)) {
      if (logWidth(line) + charWidth(segment) > width) {
        lines.push(line.trimEnd()); line = '';
      }
      if (line || segment.trim()) line += segment;
    }
  }
  if (line || !lines.length) lines.push(line.trimEnd());
  return lines;
}
function formatLogLine(raw) {
  const { line } = parseLogLine(raw);
  const color = LINE_COLORS.find(([re]) => re.test(line))?.[1];
  const m = /^(\[[^\]]*\](?: \[gw_[^\]]*\])?)(.*)$/.exec(line);
  if (!m) return color ? logPaint(color, line) : line;
  return logPaint(C.dim, m[1]) + (color ? logPaint(color, m[2]) : m[2]);
}

// 紧凑视图里把用户最常查的指标从长详情中提出来；不改变源日志文本。
function highlightLogDetail(text, stateColor) {
  if (!text) return text;
  if (stateColor === C.red || stateColor === C.yellow && /错误|未收尾|上游|HTTP \d{3}/.test(text)) {
    return logPaint(stateColor, text);
  }
  const metric = /(?:首字节|共)\s+[^ ·]+|(?:输入|缓存读|缓存写|输出)\s+[^ ·]+|费用\s+\$[^ ·]+/gu;
  let result = '';
  let last = 0;
  for (const match of text.matchAll(metric)) {
    result += text.slice(last, match.index);
    const color = /费用/.test(match[0])
      ? C.yellow
      : /(?:首字节|共)/.test(match[0])
        ? C.cyan
        : /输入/.test(match[0])
          ? C.blue
          : /缓存读|缓存写/.test(match[0])
            ? C.magenta
            : C.green;
    result += logPaint(color, match[0]);
    last = match.index + match[0].length;
  }
  return result + text.slice(last);
}
function createLogRenderer(options) {
  let date;
  const states = { '→': ['开始', C.cyan], '←': ['成功', C.green], '✗': ['失败', C.red], '⚠': ['警告', C.yellow], '↻': ['重试', C.yellow], '⊘': ['取消', C.dim] };
  return (raw) => {
    if (options.mode === 'raw') return raw;
    if (options.mode === 'detail') return formatLogLine(raw);
    const entry = parseLogLine(raw);
    // 旧格式、启动信息和未知记录保留正文，不强行推断请求结果。
    if (!entry.id || !states[entry.icon]) return wrapLog(entry.line, options.width).join('\n');
    const [name, color] = states[entry.icon];
    const prefix = entry.date !== date ? logPaint(C.dim, `── ${entry.date} ──`) + '\n' : '';
    date = entry.date;
    const state = entry.icon + ' ' + name;
    if (options.width < 100) {
      const head = `${entry.time}  ${state}  ${entry.id.slice(3)}`;
      const detail = `${entry.route} · ${entry.detail}`;
      return prefix + logPaint(color, head) + '\n' + wrapLog(detail, options.width - 2).map((part, i) => '  ' + (i === 0 ? logPaint(C.cyan, entry.route) + (entry.detail ? ' · ' : '') + highlightLogDetail(part.slice(entry.route.length + (entry.detail ? 3 : 0)), color) : highlightLogDetail(part, color))).join('\n');
    }
    const routes = wrapLog(entry.route, 18);
    const details = wrapLog(entry.detail, options.width - 52);
    const rows = [];
    for (let i = 0; i < Math.max(routes.length, details.length); i++) {
      const detail = details[i] ?? '';
      rows.push(logPaint(C.dim, logPad(i ? '' : entry.time, 12)) + '  ' + logPaint(color, logPad(i ? '' : state, 6)) + '  ' + logPaint(C.cyan, logPad(routes[i] ?? '', 18)) + '  ' + logPaint(C.dim, logPad(i ? '' : entry.id.slice(3), 8)) + '  ' + highlightLogDetail(detail, color));
    }
    return prefix + rows.join('\n');
  };
}

/** 只读文件末尾（默认 2MB）：日志再大，gw.js logs 也不用整份读进内存 */
function readTail(path, maxBytes = 2 * 1024 * 1024, end = statSync(path).size, decoder) {
  const start = Math.max(0, end - maxBytes);
  const buf = Buffer.alloc(end - start);
  const fd = openSync(path, 'r');
  let length = 0;
  try {
    while (length < buf.length) {
      const count = readSync(fd, buf, length, buf.length - length, start + length);
      if (!count) break;
      length += count;
    }
  } finally { closeSync(fd); }
  const bytes = buf.subarray(0, length);
  const text = decoder ? decoder.write(bytes) : bytes.toString('utf8');
  return start > 0 ? (text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '') : text;
}

function tailLog(path, n = 40, format = false, filter = undefined) {
  if (!existsSync(path)) return '(暂无日志)';
  let lines = readTail(path).split(/\r?\n/).filter(Boolean);
  if (filter) lines = lines.filter(filter);
  const selected = lines.slice(-n);
  return format ? selected.map(formatLogLine).join('\n') : selected.join('\n');
}

/** 持续输出新写入的行，Ctrl+C 退出。轮询文件大小，在 Windows 上比 fs.watch 可靠 */
async function followLog(path, options, render, offset, decoder, pending) {
  if (options.mode !== 'raw') console.log(logPaint(C.dim, '── 持续跟随新日志（stdout），Ctrl+C 退出 ──'));
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    let size;
    try { size = statSync(path).size; } catch { continue; }
    if (size < offset) {
      offset = 0; pending = ''; decoder = new StringDecoder('utf8');
      if (options.mode !== 'raw') console.log(logPaint(C.dim, '── 日志已截短，从文件开头继续 ──'));
    }
    if (size === offset) continue;
    const buf = Buffer.alloc(Math.min(size - offset, 256 * 1024));
    let count;
    try {
      const fd = openSync(path, 'r');
      try { count = readSync(fd, buf, 0, buf.length, offset); } finally { closeSync(fd); }
    } catch { continue; }
    offset += count;
    const lines = (pending + decoder.write(buf.subarray(0, count))).split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) if (line && matchesLog(line, options)) console.log(render(line));
  }
}

async function cmdLogs() {
  let options;
  try { options = parseLogOptions(process.argv.slice(3)); } catch (e) {
    console.error(`日志参数错误：${e.message}`);
    process.exitCode = 1; return;
  }
  const follow = options.follow;
  const filter = (line) => matchesLog(line, options);
  const render = createLogRenderer(options);
  const offset = existsSync(OUT_LOG) ? statSync(OUT_LOG).size : 0;
  const decoder = new StringDecoder('utf8');
  const initial = offset ? readTail(OUT_LOG, 2 * 1024 * 1024, offset, decoder) : '';
  const lines = initial.split(/\r?\n/);
  const pending = follow ? lines.pop() ?? '' : '';
  const selected = lines.filter((line) => line && filter(line)).slice(-options.n);
  if (options.mode !== 'raw') {
    const mode = options.mode === 'detail' ? '详细' : options.width < 100 ? '紧凑 · 窄屏' : '紧凑';
    console.log(logPaint(C.dim, wrapLog(`── 请求日志 · ${mode} · 最近 ${options.n} 条（末尾 2MB）──`, options.width).join('\n')));
    if (options.id || options.route || options.errors) console.log(logPaint(C.dim, wrapLog(`筛选：${[options.id, options.route, options.errors ? '异常 / 警告 / 重试' : ''].filter(Boolean).join(' · ')}`, options.width).join('\n')));
    if (options.mode === 'compact') console.log(logPaint(C.dim, options.width < 100
      ? wrapLog('时间 / 状态 / 请求 ID / 路由 / 详情', options.width).join('\n')
      : `${logPad('时间', 12)}  ${logPad('状态', 6)}  ${logPad('路由', 18)}  ${logPad('请求 ID', 8)}  详情`));
    if (!selected.length) console.log('(没有匹配的日志)');
  }
  for (const line of selected) console.log(render(line));
  if (options.mode !== 'raw' && existsSync(ERR_LOG) && statSync(ERR_LOG).size > 0) {
    const includeHistory = options.history;
    const info = await health();
    const startedMs = info?.service === 'slizm-gateway' && Number.isInteger(info.pid) && info.pid > 0 && typeof info.startedAt === 'string'
      ? Date.parse(info.startedAt) : NaN;
    const written = statSync(ERR_LOG).mtime;
    const lines = cleanLogText(readTail(ERR_LOG)).split(/\r?\n/).filter(Boolean);
    // 记录首行支持 UTC / 本地时间；后续无时间戳的栈行随整条记录保留。
    const firstCurrent = Number.isFinite(startedMs) ? lines.findIndex((line) => {
      const match = /^\[(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}\.\d{3}Z| \d{2}:\d{2}:\d{2}\.\d{3}))\]/.exec(line);
      return match !== null && Date.parse(match[1].replace(' ', 'T')) >= startedMs;
    }) : -1;
    const stale = Number.isFinite(startedMs) && firstCurrent < 0 && written.getTime() < startedMs;
    if (lines.length && stale && !includeHistory) {
      console.log(logPaint(C.dim, '── 已折叠历史错误日志；查看旧栈：node scripts/gw.js logs --history ──'));
    } else if (lines.length) {
      const selected = !includeHistory && firstCurrent >= 0 ? lines.slice(firstCurrent) : lines;
      const label = includeHistory
        ? (stale ? '历史记录' : '含历史记录')
        : firstCurrent >= 0 ? `当前进程 pid ${info.pid}` : '无法确认错误所属进程，保留错误线索';
      console.log(logPaint(stale ? C.dim : C.yellow, `\n── logs/gateway.err.log · 进程级（不参与请求筛选） · ${label}（最后写入 ${written.toLocaleString()}）──`));
      console.log(selected.slice(-20).map(localTime).join('\n'));
    }
  }
  if (follow) await followLog(OUT_LOG, options, render, offset, decoder, pending);
}

async function cmdTokens() {
  // 报表逻辑在 usage-report.js：读 logs/usage-YYYY-MM.jsonl 账本，网关没在跑也能看历史用量
  const { printUsageReport } = await import('./usage-report.js');
  let token = 'sk-local-gateway';
  let pricing;
  try {
    const cfg = loadConfig();
    token = cfg.server.clientToken;
    pricing = cfg.pricing;
  } catch {}
  await printUsageReport({ args: process.argv.slice(3), base: BASE, token, pricing });
}

function cmdTest() {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'selftest.js')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
}

// ── settings.json 模式切换 ──────────────────────────────────────────────
// Claude Code 的 env 只在启动时读一次，所以"换配置"必须配合重启 Claude Code。
// 直接手改/手改名很容易留下一个半残的 settings.json，导致 Claude Code 起不来。
// 这里做成事务：先备份 → 校验两份 JSON → 原子替换 → 报告结果。
const CLAUDE_DIR = dirname(ROOT); // claude-gateway 的上一层就是 ~/.claude
const SETTINGS_ACTIVE = join(CLAUDE_DIR, 'settings.json');
const SETTINGS_GATEWAY = join(CLAUDE_DIR, 'settings.json_gateway');

/** 从 settings.json 里读出 ANTHROPIC_BASE_URL，用来判断当前是哪种模式 */
function readMode(path) {
  if (!existsSync(path)) return { kind: 'missing' };
  let json;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return { kind: 'invalid', error: e.message };
  }
  const base = json.env?.ANTHROPIC_BASE_URL ?? '';
  if (base) {
    let url;
    try { url = new URL(base); } catch { return { kind: 'invalid', error: 'ANTHROPIC_BASE_URL 不是有效 URL' }; }
    if (!['http:', 'https:'].includes(url.protocol)) return { kind: 'invalid', error: '不支持的 URL 协议' };
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return { kind: 'gateway', base, json };
    return { kind: 'direct', base, json };
  }
  return { kind: 'unknown', base, json };
}

async function cmdMode() {
  const want = (process.argv[3] ?? '').toLowerCase();
  const active = readMode(SETTINGS_ACTIVE);
  const stashed = readMode(SETTINGS_GATEWAY);

  const label = (m) =>
    m.kind === 'gateway'
      ? paint(C.green, '网关模式')
      : m.kind === 'direct'
        ? paint(C.cyan, '直连模式')
        : paint(C.red, `无法识别 (${m.kind})`);

  if (!want || want === 'status') {
    const line = '─'.repeat(64);
    console.log(line);
    console.log(`  settings.json           ${label(active)}  ${paint(C.dim, active.base ?? '')}`);
    console.log(`  settings.json_gateway   ${label(stashed)}  ${paint(C.dim, stashed.base ?? '')}`);
    console.log(line);
    console.log(paint(C.dim, '  切换: node scripts/gw.js mode gateway'));
    console.log(paint(C.dim, '        node scripts/gw.js mode direct'));
    console.log(paint(C.dim, '  切换后必须重启 Claude Code —— env 只在启动时读一次。'));
    return;
  }

  if (want !== 'gateway' && want !== 'direct') {
    console.log(paint(C.red, `未知模式: ${want}（可选 gateway | direct）`));
    process.exitCode = 1;
    return;
  }

  if (active.kind === want) {
    console.log(paint(C.yellow, `已经是${want === 'gateway' ? '网关' : '直连'}模式，无需切换。`));
    return;
  }

  // 要切到的那份配置必须真实可用，否则切过去就是把自己锁在门外。
  if (!existsSync(SETTINGS_GATEWAY) && want === 'gateway') {
    console.log(paint(C.red, `找不到 ${SETTINGS_GATEWAY}，无法切到网关模式。`));
    process.exitCode = 1;
    return;
  }
  if (active.kind === 'invalid' || active.kind === 'missing' || (want === 'gateway' && stashed.kind !== 'gateway')) {
    console.log(paint(C.red, '拒绝切换：当前配置无效，或目标文件不是有效网关配置。'));
    process.exitCode = 1;
    return;
  }

  if (want === 'gateway') {
    // 当前 active 是直连版：把它留成备份，再用网关版覆盖。
    const backup = `${SETTINGS_ACTIVE}.direct-backup-${stamp()}`;
    writeFileSync(backup, readFileSync(SETTINGS_ACTIVE), { flag: 'wx', mode: 0o600 });
    atomicWrite(SETTINGS_ACTIVE, readFileSync(SETTINGS_GATEWAY));
    console.log(paint(C.green, '✓ 已切到网关模式'));
    console.log(paint(C.dim, `  原直连配置备份: ${basename(backup)}`));
  } else {
    // 切回直连：找最近一次直连备份；没有就把当前网关版另存，并明确告知。
    const backups = readdirSync(CLAUDE_DIR)
      .filter((f) => f.startsWith('settings.json.direct-backup-'))
      .sort()
      .reverse();
    if (!backups.length) {
      console.log(
        paint(C.red, '没有找到直连配置的备份。请手动把 settings.json 改回直连（API key 不在网关配置里）。'),
      );
      process.exitCode = 1;
      return;
    }
    const backup = backups.find((name) => readMode(join(CLAUDE_DIR, name)).kind === 'direct');
    if (!backup) {
      console.log(paint(C.red, '没有有效的直连备份，未修改当前配置。'));
      process.exitCode = 1;
      return;
    }
    if (active.kind === 'gateway') atomicWrite(SETTINGS_GATEWAY, readFileSync(SETTINGS_ACTIVE));
    atomicWrite(SETTINGS_ACTIVE, readFileSync(join(CLAUDE_DIR, backup)));
    console.log(paint(C.green, `✓ 已切回直连模式（用备份 ${backup}）`));
  }

  // 切完立刻校验，确保没有写出一个坏文件。
  const after = readMode(SETTINGS_ACTIVE);
  console.log(
    `  当前: ${label(after)}  ${paint(C.dim, after.base ?? '')}`,
  );
  console.log('');
  console.log(paint(C.yellow, '  ⚠ 必须重启 Claude Code 才会生效（env 只在启动时读取一次）。'));
  if (want === 'gateway') {
    const up = await health();
    console.log(
      up
        ? paint(C.green, `  ✓ 网关正在运行，重启后即可用 (${BASE})`)
        : paint(C.red, `  ✗ 网关没在运行！先执行: node scripts/gw.js start`),
    );
  }
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function cmdHealth() {
  const info = await health();
  if (!info) {
    console.log(paint(C.red, '不可达'));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(info, null, 2));
}

function cmdHelp() {
  const logHint = existsSync(OUT_LOG)
    ? ` (最后写入 ${statSync(OUT_LOG).mtime.toLocaleString()})`
    : '';
  console.log(`
  网关管理 — ${paint(C.cyan, BASE)}

    node scripts/gw.js start      后台启动（幂等，已在跑则只报告）
    node scripts/gw.js stop       停止
    node scripts/gw.js restart    重启
    node scripts/gw.js status     状态 + 路由表
    node scripts/gw.js tokens [today|12h|7d|all]   token 用量报表，默认今天（别名 usage，更多参数见报表末行）
    node scripts/gw.js health     原始 /health JSON
    node scripts/gw.js logs [n] [-e] [-f]   紧凑视图，默认 40 条匹配行；-e 异常，-f 跟随 stdout${logHint}
    node scripts/gw.js logs --id <ID>       精确筛选请求，支持 gw_ 前缀或 8 位简写
    node scripts/gw.js logs --route <别名>  精确筛选路由，可与 --id / -e / -f 组合
    node scripts/gw.js logs --detail        完整时间戳和正文，不使用紧凑列布局
    node scripts/gw.js logs --raw           仅输出 stdout 原始行，无标题；不可与 --detail / --history 同用
    node scripts/gw.js logs --width <列数>  展示宽度 40..240；不足 100 列使用窄屏布局
    node scripts/gw.js logs --history     同时查看历史 stderr（默认折叠已确认的旧进程错误）
    node scripts/gw.js test       跑全路由自检
    node scripts/gw.js mode       查看当前是网关模式还是直连模式
    node scripts/gw.js mode gateway   切到网关模式（自动备份原配置）
    node scripts/gw.js mode direct    切回直连模式

  ${paint(C.dim, 'mode 切换后必须重启 Claude Code，env 只在启动时读取一次。')}
`);
}

const cmd = (process.argv[2] ?? 'help').toLowerCase();
const table = {
  start: cmdStart,
  stop: cmdStop,
  restart: cmdRestart,
  status: cmdStatus,
  tokens: cmdTokens,
  usage: cmdTokens,
  health: cmdHealth,
  logs: cmdLogs,
  test: cmdTest,
  mode: cmdMode,
  help: cmdHelp,
  '': cmdHelp,
};

if (!table[cmd]) {
  console.log(paint(C.red, `未知命令: ${cmd}`));
  cmdHelp();
  process.exitCode = 1;
} else {
  await table[cmd]();
}
