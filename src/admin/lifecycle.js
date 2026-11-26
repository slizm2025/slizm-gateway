import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { ROOT, env, loadConfig, redact } from '../config.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stateDir = () => env('GATEWAY_WEB_STATE_DIR', join(ROOT, 'logs'));
const statePath = () => join(stateDir(), 'web-session.json');
const currentInstanceKey = () => createHash('sha256').update(resolve(stateDir())).digest('hex').slice(0, 16);

function configuredWebPort() {
  const raw = env('GATEWAY_WEB_PORT');
  if (raw === undefined) return 48731;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

function readState() {
  try {
    const state = JSON.parse(readFileSync(statePath(), 'utf8'));
    if (!Number.isSafeInteger(state.pid) || state.pid <= 0 ||
        !Number.isInteger(state.port) || state.port < 1 || state.port > 65535 ||
        !/^[a-f0-9]{64,}$/i.test(state.token)) return null;
    return state;
  } catch { return null; }
}

async function probePort(port, expectedPid = null) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1000), redirect: 'error',
    });
    const info = await response.json();
    if (!response.ok || info?.service !== 'slizm-gateway-web') return null;
    if (!Number.isSafeInteger(info.pid) || info.pid <= 0) return null;
    if (info.instanceKey && info.instanceKey !== currentInstanceKey()) return null;
    if (expectedPid !== null && info.pid !== expectedPid) return null;
    return { pid: info.pid, port };
  } catch { return null; }
}

async function probe(state) {
  if (!state) return false;
  return Boolean(await probePort(state.port, state.pid));
}

async function resolveLiveWeb() {
  const state = readState();
  if (state) {
    const verified = await probePort(state.port, state.pid);
    if (verified) return { ...verified, state, recovered: false };
  }
  const fallbackPort = configuredWebPort();
  const discovered = await probePort(fallbackPort);
  if (discovered) {
    return { ...discovered, state, recovered: true };
  }
  return { pid: null, port: null, state, recovered: false };
}

// 应用窗口：Chrome/Edge 的 --app 模式不显示地址栏和标签页，管理页看起来就是一个独立应用，
// 而不是浏览器里多出来的一个标签。找不到可用浏览器时返回 null，由调用方退回系统默认浏览器。
const WIN_APP_BROWSERS = [
  ['ProgramFiles', 'Google/Chrome/Application/chrome.exe'],
  ['ProgramFiles(x86)', 'Google/Chrome/Application/chrome.exe'],
  ['LOCALAPPDATA', 'Google/Chrome/Application/chrome.exe'],
  ['ProgramFiles(x86)', 'Microsoft/Edge/Application/msedge.exe'],
  ['ProgramFiles', 'Microsoft/Edge/Application/msedge.exe'],
];

const MAC_APP_BROWSERS = [
  'Google Chrome.app/Contents/MacOS/Google Chrome',
  'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'Brave Browser.app/Contents/MacOS/Brave Browser',
  'Chromium.app/Contents/MacOS/Chromium',
];

export function resolveAppBrowser(url, {
  platform = process.platform,
  mode = 'app',
  envVars = process.env,
  fileExists = existsSync,
} = {}) {
  if (mode !== 'app') return null;
  const appArgs = [`--app=${url}`, '--no-first-run', '--no-default-browser-check'];
  if (platform === 'win32') {
    for (const [base, relative] of WIN_APP_BROWSERS) {
      const baseDir = envVars[base];
      if (!baseDir) continue;
      const command = join(baseDir, relative);
      if (!fileExists(command)) continue;
      return { command, args: appArgs };
    }
    return null;
  }
  if (platform === 'darwin') {
    const appDirs = ['/Applications'];
    if (envVars.HOME) appDirs.push(posix.join(envVars.HOME, 'Applications'));
    for (const relative of MAC_APP_BROWSERS) {
      for (const appDir of appDirs) {
        const command = posix.join(appDir, relative);
        if (!fileExists(command)) continue;
        return { command, args: appArgs };
      }
    }
    return null;
  }
  return null;
}

function launchDetached(command, args) {
  const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export async function openBrowser(url) {
  const mode = String(env('GATEWAY_WEB_BROWSER', 'app')).trim().toLowerCase();
  if (mode === 'app') {
    const app = resolveAppBrowser(url, { mode });
    if (app) {
      try { return await launchDetached(app.command, app.args); } catch { /* 应用窗口失败时退回默认浏览器 */ }
    }
  }
  let command, args;
  if (process.platform === 'win32') {
    command = 'rundll32.exe';
    args = ['url.dll,FileProtocolHandler', url];
  } else if (process.platform === 'darwin') {
    command = 'open'; args = [url];
  } else {
    command = 'xdg-open'; args = [url];
  }
  return launchDetached(command, args);
}

export async function ensureWeb({ open = false } = {}) {
  const live = await resolveLiveWeb();
  let pid = live.pid;
  let port = live.port;
  let started = false;
  if (!pid) {
    mkdirSync(stateDir(), { recursive: true });
    const out = openSync(join(stateDir(), 'web.out.log'), 'a', 0o600);
    const err = openSync(join(stateDir(), 'web.err.log'), 'a', 0o600);
    let child;
    try {
      child = spawn(process.execPath, [join(ROOT, 'src', 'admin', 'server.js')], {
        cwd: ROOT, detached: true, stdio: ['ignore', out, err], windowsHide: true,
      });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve); child.once('error', reject);
      });
    } finally { closeSync(out); closeSync(err); }
    child.unref();
    let ready = false;
    for (let i = 0; i < 40; i++) {
      await sleep(150);
      const state = readState();
      if (state && await probe(state)) {
        pid = state.pid;
        port = state.port;
        ready = true;
        break;
      }
      if (child.exitCode !== null) break;
    }
    if (!ready) {
      if (child.exitCode === null) child.kill();
      throw new Error('管理 Web 启动失败，请检查 logs/web.err.log 和 GATEWAY_WEB_PORT 端口占用。');
    }
    started = true;
  }
  const url = `http://127.0.0.1:${port}/`;
  if (open) await openBrowser(url);
  return { url, pid, port, started };
}

export async function getWebStatus() {
  const live = await resolveLiveWeb();
  if (live.pid) {
    return {
      running: true,
      pid: live.pid,
      port: live.port,
      url: `http://127.0.0.1:${live.port}/`,
      stale: false,
    };
  }
  return {
    running: false,
    pid: null,
    port: null,
    url: null,
    stale: Boolean(live.state),
  };
}

export async function stopWeb() {
  const live = await resolveLiveWeb();
  if (!live.pid) {
    if (!live.state) return false;
    if (!processAlive(live.state.pid)) {
      rmSync(statePath(), { force: true });
      return false;
    }
    throw new Error('无法核验管理 Web 进程，未停止进程或删除凭据。');
  }
  process.kill(live.pid, 'SIGTERM');
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    if (!await probePort(live.port, live.pid)) {
      const current = readState();
      if (existsSync(statePath()) && (!current || current.pid === live.pid || !processAlive(current.pid))) {
        rmSync(statePath(), { force: true });
      }
      return true;
    }
  }
  throw new Error('管理 Web 未及时退出，请检查进程状态。');
}

let restarting = false;
export async function restartGateway() {
  if (restarting) throw Object.assign(new Error('网关正在重启。'), { statusCode: 409 });
  restarting = true;
  try {
    const cfg = loadConfig();
    const host = cfg.server.host === '::' ? '[::1]' :
      ['0.0.0.0', 'localhost'].includes(cfg.server.host) ? '127.0.0.1' : cfg.server.host;
    if (!['127.0.0.1', '[::1]', '::1'].includes(host)) {
      throw new Error('Web 重启仅支持本机网关监听地址。');
    }
    let info;
    try {
      const response = await fetch(`http://${host === '::1' ? '[::1]' : host}:${cfg.server.port}/health`, {
        signal: AbortSignal.timeout(2500), redirect: 'error',
      });
      info = await response.json();
    } catch { /* The CLI safely handles a stopped gateway and stale PID files. */ }
    if (info && info.service !== 'slizm-gateway') throw new Error('网关端口被其他服务占用。');
    if (info?.activeRequests > 0) {
      throw Object.assign(new Error(`仍有 ${info.activeRequests} 个请求处理中，请稍后重启。`), { statusCode: 409 });
    }
    await new Promise((resolve, reject) => {
      execFile(process.execPath, [join(ROOT, 'scripts', 'gw.js'), 'restart'], {
        cwd: ROOT, windowsHide: true, timeout: 30000, maxBuffer: 256 * 1024,
        env: { ...process.env, GATEWAY_WEB_ENABLED: '0', NO_COLOR: '1' },
      }, (error, stdout, stderr) => {
        if (error) reject(new Error(redact((stdout || stderr || '网关重启失败，请查看日志。').trim()).slice(0, 1200)));
        else resolve();
      });
    });
    return { ok: true };
  } finally { restarting = false; }
}
