import { spawn, execFile } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, env, loadConfig, redact } from '../config.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stateDir = () => env('GATEWAY_WEB_STATE_DIR', join(ROOT, 'logs'));
const statePath = () => join(stateDir(), 'web-session.json');

function readState() {
  try {
    const state = JSON.parse(readFileSync(statePath(), 'utf8'));
    if (!Number.isSafeInteger(state.pid) || state.pid <= 0 ||
        !Number.isInteger(state.port) || state.port < 1 || state.port > 65535 ||
        !/^[a-f0-9]{64,}$/i.test(state.token)) return null;
    return state;
  } catch { return null; }
}

async function probe(state) {
  if (!state) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/health`, {
      signal: AbortSignal.timeout(1000), redirect: 'error',
    });
    const info = await response.json();
    return response.ok && info.service === 'slizm-gateway-web' && info.pid === state.pid;
  } catch { return false; }
}

export async function openBrowser(url) {
  let command, args;
  if (process.platform === 'win32') {
    command = 'rundll32.exe';
    args = ['url.dll,FileProtocolHandler', url];
  } else if (process.platform === 'darwin') {
    command = 'open'; args = [url];
  } else {
    command = 'xdg-open'; args = [url];
  }
  const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', resolve);
  });
  child.unref();
}

export async function ensureWeb({ open = false } = {}) {
  let state = readState();
  if (!await probe(state)) {
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
      state = readState();
      if (await probe(state)) { ready = true; break; }
      if (child.exitCode !== null) break;
    }
    if (!ready) {
      if (child.exitCode === null) child.kill();
      throw new Error('管理 Web 启动失败，请检查 logs/web.err.log 和 GATEWAY_WEB_PORT 端口占用。');
    }
  }
  const url = `http://127.0.0.1:${state.port}/`;
  if (open) await openBrowser(`${url}#token=${state.token}`);
  return { url, pid: state.pid, port: state.port };
}

export async function stopWeb() {
  const state = readState();
  if (!state) return false;
  if (!await probe(state)) {
    throw new Error('无法核验管理 Web 进程，未停止进程或删除凭据。');
  }
  process.kill(state.pid, 'SIGTERM');
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    if (!await probe(state)) {
      if (readState()?.pid === state.pid && existsSync(statePath())) rmSync(statePath());
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
