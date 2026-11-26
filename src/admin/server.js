// Local Web Admin Backend for Slizm Gateway
import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, renameSync, chmodSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, env, loadConfig, redact } from '../config.js';
import { buildOverview, buildSwitchboardLive, readLogTail } from './data.js';
import { getSanitizedSettings, saveSettings } from './settings.js';
import { reloadGatewayPricing } from '../runtime-pricing.js';
import { createSubagentStore } from './subagents.js';
import { createSubagentModels } from './subagent-models.js';

const COOKIE_NAME = 'admin_session';
const MAX_BODY_BYTES = 256 * 1024; // 256 KB

function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return list;
  for (const cookie of cookieHeader.split(';')) {
    const idx = cookie.indexOf('=');
    if (idx === -1) continue;
    const name = cookie.slice(0, idx).trim();
    if (!name) continue;
    let value = cookie.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    try {
      list[name] = decodeURIComponent(value);
    } catch {
      list[name] = value;
    }
  }
  return list;
}

function jsonResponse(res, status, obj, headers = {}) {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function errorResponse(res, status, message) {
  jsonResponse(res, status, { error: redact(String(message)) });
}

function isLoopbackRemote(remoteAddress) {
  if (!remoteAddress) return false;
  return (
    remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress === '::ffff:127.0.0.1'
  );
}

function readJsonBody(req, res, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let limitExceeded = false;
    req.on('data', (chunk) => {
      if (limitExceeded) return;
      size += chunk.length;
      if (size > maxBytes) {
        limitExceeded = true;
        req.pause();
        const err = new Error(`请求体超过 ${Math.round(maxBytes / 1024)}KB 上限`);
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (limitExceeded) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        const error = new Error('请求体不是合法 JSON');
        error.statusCode = 400;
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

export function createAdminServer(options = {}) {
  const stateDir = options.stateDir ?? env('GATEWAY_WEB_STATE_DIR', join(ROOT, 'logs'));
  const instanceKey = createHash('sha256').update(resolve(stateDir)).digest('hex').slice(0, 16);
  const publicDir = options.publicDir ?? join(ROOT, 'src', 'admin', 'public');
  const configPath = options.configPath ?? env('GATEWAY_CONFIG', join(ROOT, 'providers.json'));
  const logDir = options.logDir !== undefined ? options.logDir : join(ROOT, 'logs');
  const ledgerDir = options.ledgerDir !== undefined ? options.ledgerDir : (env('GATEWAY_USAGE_DIR') ? (/^(0|off|false|no)$/i.test(env('GATEWAY_USAGE_DIR')) ? null : env('GATEWAY_USAGE_DIR')) : join(ROOT, 'logs'));
  const backupDir = options.backupDir ?? join(logDir, 'config-backups');
  const cookieTtlMs = options.cookieTtlMs ?? (12 * 3600 * 1000);
  const getGateway = options.getGateway;
  const sessionSecret = options.sessionSecret ?? randomBytes(32).toString('hex');
  const reloadPricing = options.reloadPricing ?? reloadGatewayPricing;
  const subagentModels = createSubagentModels({ configPath, cachePath: join(stateDir, 'subagent-model-checks.json'), ...options.subagentModelOptions });
  const subagents = createSubagentStore({
    claudeHome: options.claudeHome, codexHome: options.codexHome, backupDir,
    validateModel: subagentModels.validate,
  });
  const subagentData = async (tool) => ({ ...await subagents.get(tool), models: subagentModels.list(tool) });

  const sessions = new Map();

  const getRestartFn = () => {
    if (typeof options.restartGateway === 'function') {
      return options.restartGateway;
    }
    return async () => {
      const mod = await import('./lifecycle.js');
      return await mod.restartGateway();
    };
  };

  let restartInProgress = false;

  const server = http.createServer(async (req, res) => {
    try {
    if (!isLoopbackRemote(req.socket.remoteAddress)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Forbidden: loopback only');
      return;
    }

    const hostHeader = req.headers['host'] || '';
    const actualPort = server.address()?.port;
    if (actualPort) {
      const allowedHosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
      if (actualPort === 80) {
        allowedHosts.push('127.0.0.1', 'localhost');
      }
      if (!allowedHosts.includes(hostHeader.toLowerCase())) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Bad Request: Invalid Host header');
        return;
      }
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
    );

    let parsedUrl;
    try {
      parsedUrl = new URL(req.url, `http://${hostHeader || '127.0.0.1'}`);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Bad Request: Malformed URL');
      return;
    }
    const pathname = parsedUrl.pathname.replace(/\/+$/, '') || '/';
    const origin = req.headers['origin'];
    const expectedOrigin = `http://${hostHeader}`;

    if (req.method === 'GET' && pathname === '/health') {
      return jsonResponse(res, 200, {
        service: 'slizm-gateway-web',
        pid: process.pid,
        instanceKey,
      });
    }

    if (req.method === 'GET' && ['/', '/index.html', '/app.js', '/subagents.js', '/style.css'].includes(pathname)) {
      const fileName = pathname === '/' || pathname === '/index.html' ? 'index.html' : pathname.slice(1);
      const filePath = resolve(publicDir, fileName);
      if (!filePath.startsWith(resolve(publicDir)) || !existsSync(filePath)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      const ext = fileName.endsWith('.html') ? 'text/html; charset=utf-8' :
                  fileName.endsWith('.js') ? 'application/javascript; charset=utf-8' :
                  'text/css; charset=utf-8';
      const content = readFileSync(filePath);
      res.writeHead(200, {
        'content-type': ext,
        'content-length': content.length,
        'cache-control': 'no-cache',
      });
      res.end(content);
      return;
    }

    if (pathname.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');

      if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
        if (!origin || origin !== expectedOrigin) {
          return errorResponse(res, 403, 'Cross-origin request forbidden');
        }
      } else {
        if (origin && origin !== expectedOrigin) {
          return errorResponse(res, 403, 'Cross-origin request forbidden');
        }
      }

      if (req.method === 'POST' && pathname === '/api/session') {
        const contentType = req.headers['content-type'] || '';
        if (contentType && !contentType.toLowerCase().startsWith('application/json')) {
          return errorResponse(res, 415, 'Content-Type 必须是 application/json');
        }
        try {
          await readJsonBody(req, res, 16 * 1024);
        } catch (err) {
          return errorResponse(res, err.statusCode || 400, err.message);
        }
        const authHeader = req.headers['authorization'] || '';
        const match = authHeader.match(/^Bearer\s+([a-f0-9]+)$/i);
        const incomingToken = match ? match[1] : '';

        const tokenBuf = Buffer.from(incomingToken);
        const secretBuf = Buffer.from(sessionSecret);
        const localBootstrap = !authHeader &&
          contentType.toLowerCase().startsWith('application/json') &&
          (!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] === 'same-origin');
        const isValid = localBootstrap || (
          tokenBuf.length === secretBuf.length &&
          timingSafeEqual(tokenBuf, secretBuf)
        );

        if (!isValid) {
          return errorResponse(res, 401, 'Invalid bootstrap token');
        }

        const now = Date.now();
        for (const [key, exp] of sessions) {
          if (exp < now) sessions.delete(key);
        }
        const sessionToken = randomBytes(32).toString('hex');
        const expiresAt = now + cookieTtlMs;
        sessions.set(sessionToken, expiresAt);

        const cookieValue = `${COOKIE_NAME}=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.round(cookieTtlMs / 1000)}`;
        return jsonResponse(
          res,
          200,
          { ok: true, expiresAt: new Date(expiresAt).toISOString() },
          { 'set-cookie': cookieValue }
        );
      }

      const cookies = parseCookies(req.headers['cookie']);
      const currentToken = cookies[COOKIE_NAME];
      const now = Date.now();
      const sessionExpiry = currentToken ? sessions.get(currentToken) : null;
      if (!sessionExpiry || sessionExpiry < now) {
        if (currentToken) sessions.delete(currentToken);
        return errorResponse(res, 401, 'Unauthorized');
      }
      // 活跃会话自动滑动续期，避免控制台长开或重开后莫名失效
      if (sessionExpiry - now < cookieTtlMs / 2) {
        const renewedAt = now + cookieTtlMs;
        sessions.set(currentToken, renewedAt);
        res.setHeader(
          'set-cookie',
          `${COOKIE_NAME}=${currentToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.round(cookieTtlMs / 1000)}`
        );
      }

      if (pathname === '/api/subagents' || pathname.startsWith('/api/subagents/')) {
        try {
          if (req.method === 'GET' && pathname === '/api/subagents') {
            return jsonResponse(res, 200, await subagentData(parsedUrl.searchParams.get('tool') || 'claude'));
          }
          const match = /^\/api\/subagents\/(claude|codex)\/([^/]+)$/.exec(pathname);
          if (!match || !['PUT', 'DELETE', 'POST'].includes(req.method)) {
            return errorResponse(res, 404, 'Subagent endpoint not found');
          }
          if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
            return errorResponse(res, 415, 'Content-Type 必须是 application/json');
          }
          const [, tool, encodedId] = match;
          let id;
          try { id = decodeURIComponent(encodedId); } catch { return errorResponse(res, 400, '无效的代理 ID'); }
          const body = await readJsonBody(req, res, MAX_BODY_BYTES);
          if (id === 'check-models' && req.method === 'POST') {
            await subagentModels.check(tool);
          } else if (id === 'defaults' && req.method === 'PUT') {
            await subagents.saveDefaults(tool, body);
          } else if (!['defaults', 'check-models'].includes(id) && req.method === 'PUT') {
            await subagents.save(tool, id, body);
          } else if (!['defaults', 'check-models'].includes(id) && req.method === 'DELETE') {
            await subagents.restore(tool, id, body);
          } else return errorResponse(res, 405, '不支持此操作');
          return jsonResponse(res, 200, await subagentData(tool));
        } catch (error) {
          return errorResponse(res, error.statusCode || 500, error.message);
        }
      }

      if (req.method === 'GET' && pathname === '/api/overview') {
        const period = parsedUrl.searchParams.get('period') || 'today';
        const provider = parsedUrl.searchParams.get('provider') || undefined;
        try {
          const cfg = loadConfig({ configPath });
          const overview = await buildOverview({
            period,
            since: parsedUrl.searchParams.get('since') ?? undefined,
            until: parsedUrl.searchParams.get('until') ?? undefined,
            step: parsedUrl.searchParams.get('step') || 'auto',
            provider,
            cfg,
            ledgerDir,
            getGateway,
          });
          return jsonResponse(res, 200, overview);
        } catch (err) {
          if (err.statusCode === 400) return errorResponse(res, 400, err.message);
          return errorResponse(res, 500, `Failed to load overview: ${err.message}`);
        }
      }

      if (req.method === 'GET' && pathname === '/api/switchboard/live') {
        try {
          const cfg = loadConfig({ configPath });
          const provider = parsedUrl.searchParams.get('provider') || undefined;
          return jsonResponse(res, 200, await buildSwitchboardLive({ cfg, provider, getGateway }));
        } catch (err) {
          return errorResponse(res, 500, 'Failed to load switchboard: ' + err.message);
        }
      }

      if (req.method === 'GET' && pathname === '/api/logs') {
        try {
          loadConfig({ configPath });
        } catch {}
        const source = parsedUrl.searchParams.get('source') === 'err' ? 'err' : 'out';
        const limit = Math.min(200, Math.max(1, parseInt(parsedUrl.searchParams.get('limit') || '200', 10)));
        const q = (parsedUrl.searchParams.get('q') || '').toLowerCase();
        const errorsOnly = parsedUrl.searchParams.get('errors') === '1';

        const logFile = join(logDir, `gateway.${source}.log`);
        const { lines: tailLines, truncated } = readLogTail(logFile, 512 * 1024);

        let filtered = tailLines;
        if (q) {
          filtered = filtered.filter((line) => line.toLowerCase().includes(q));
        }
        if (errorsOnly) {
          filtered = filtered.filter((line) =>
            /[✗⚠]|\berror\b|\bfailed\b|\bexception\b|\b[45]\d{2}\b/i.test(line)
          );
        }

        const resultLines = filtered.slice(-limit);
        return jsonResponse(res, 200, {
          lines: resultLines,
          truncated,
        });
      }

      if (req.method === 'POST' && pathname === '/api/logs/clear') {
        try {
          const files = ['gateway.out.log', 'gateway.err.log'].map((name) => join(logDir, name));
          const cleared = [];
          for (const file of files) {
            if (!existsSync(file)) continue;
            const bytes = readFileSync(file).length;
            writeFileSync(file, '');
            cleared.push({ file: basename(file), bytes });
          }
          return jsonResponse(res, 200, { ok: true, cleared });
        } catch (err) {
          return errorResponse(res, 500, `Failed to clear logs: ${err.message}`);
        }
      }

      if (req.method === 'GET' && pathname === '/api/settings') {
        try {
          const settings = getSanitizedSettings(configPath);
          return jsonResponse(res, 200, settings);
        } catch (err) {
          return errorResponse(res, 500, `Failed to load settings: ${err.message}`);
        }
      }

      if (req.method === 'PUT' && pathname === '/api/settings') {
        const contentType = req.headers['content-type'] || '';
        if (!contentType.toLowerCase().startsWith('application/json')) {
          return errorResponse(res, 415, 'Content-Type 必须是 application/json');
        }
        let body;
        try {
          body = await readJsonBody(req, res, MAX_BODY_BYTES);
        } catch (err) {
          return errorResponse(res, err.statusCode || 400, err.message);
        }
        let saved;
        try {
          saved = saveSettings(body, { configPath, backupDir, logDir });
        } catch (err) {
          return errorResponse(res, err.statusCode || 400, err.message);
        }
        try {
          const reloadResult = await reloadPricing({ configPath, expectedRevision: saved.revision });
          return jsonResponse(res, 200, {
            ...saved,
            ...reloadResult,
            revision: saved.revision,
            reloadApplied: true,
            restartRequired: Boolean(reloadResult?.restartRequired ?? saved.restartRequired),
          });
        } catch (err) {
          return jsonResponse(res, 200, {
            ...saved,
            reloadApplied: false,
            reloadError: redact(String(err?.message || err)),
            restartRequired: true,
          });
        }
      }

      if (req.method === 'POST' && pathname === '/api/restart') {
        const contentType = req.headers['content-type'] || '';
        if (contentType && !contentType.toLowerCase().startsWith('application/json')) {
          return errorResponse(res, 415, 'Content-Type 必须是 application/json');
        }
        try {
          await readJsonBody(req, res, 16 * 1024);
        } catch (err) {
          return errorResponse(res, err.statusCode || 400, err.message);
        }
        if (restartInProgress) {
          return errorResponse(res, 409, '网关正在重启中，请勿重复操作');
        }
        restartInProgress = true;
        try {
          const restartFn = getRestartFn();
          const result = await restartFn();
          return jsonResponse(res, 200, result || { ok: true });
        } catch (err) {
          return errorResponse(res, err.statusCode || 500, err.message);
        } finally {
          restartInProgress = false;
        }
      }

      return errorResponse(res, 404, 'API endpoint not found');
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    } catch (unexpectedError) {
      if (!res.headersSent) {
        errorResponse(res, 500, `Internal Server Error: ${unexpectedError.message}`);
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  server.on('clientError', (err, socket) => {
    if (err?.code === 'ECONNRESET' || !socket.writable) return;
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return server;
}

const isDirectRun =
  process.argv[1] &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isDirectRun) {
  const configuredPort = env('GATEWAY_WEB_PORT');
  const port = configuredPort === undefined ? 48731 : Number(configuredPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('GATEWAY_WEB_PORT 必须是 0..65535 的整数');
  }
  const host = '127.0.0.1';
  const stateDir = env('GATEWAY_WEB_STATE_DIR', join(ROOT, 'logs'));
  const myInstanceKey = createHash('sha256').update(resolve(stateDir)).digest('hex').slice(0, 16);
  const sessionToken = randomBytes(32).toString('hex');
  const sessionFile = join(stateDir, 'web-session.json');

  const server = createAdminServer({
    port,
    host,
    stateDir,
    sessionSecret: sessionToken,
  });

  const cleanup = () => {
    try {
      if (existsSync(sessionFile)) {
        const state = JSON.parse(readFileSync(sessionFile, 'utf8'));
        if (state.pid === process.pid) {
          unlinkSync(sessionFile);
        }
      }
    } catch {}
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('unhandledRejection', (err) => {
    console.error(`[${new Date().toISOString()}] 管理 Web 未处理的异步异常:`, redact(String(err?.stack ?? err)));
  });
  process.on('uncaughtExceptionMonitor', (err, origin) => {
    console.error(`[${new Date().toISOString()}] 管理 Web 发生未捕获异常 (pid ${process.pid}, ${origin}):`, redact(String(err?.stack ?? err)));
  });

  server.once('listening', () => {
    const actualPort = server.address().port;
    mkdirSync(stateDir, { recursive: true });
    const dir = dirname(sessionFile);
    const tmpFile = join(dir, `.web-session.tmp-${process.pid}`);
    const payload = JSON.stringify({
      pid: process.pid,
      port: actualPort,
      token: sessionToken,
    }, null, 2) + '\n';

    try {
      writeFileSync(tmpFile, payload, { mode: 0o600 });
      try { chmodSync(tmpFile, 0o600); } catch {}
      renameSync(tmpFile, sessionFile);
      try { chmodSync(sessionFile, 0o600); } catch {}
    } finally {
      try { if (existsSync(tmpFile)) unlinkSync(tmpFile); } catch {}
    }

    console.log(`Slizm Gateway Web Admin running at http://${host}:${actualPort}/`);
  });
  let fallbackUsed = false;
  server.on('error', async (error) => {
    if (error.code === 'EADDRINUSE' && port > 0 && !fallbackUsed) {
      try {
        const res = await fetch(`http://${host}:${port}/health`, {
          signal: AbortSignal.timeout(1000),
          redirect: 'error',
        });
        const info = await res.json();
        if (
          res.ok &&
          info?.service === 'slizm-gateway-web' &&
          Number.isSafeInteger(info.pid) &&
          (!info.instanceKey || info.instanceKey === myInstanceKey)
        ) {
          console.log(`管理 Web 已在 http://${host}:${port}/ 运行中 (pid ${info.pid})，复用现有实例。`);
          return;
        }
      } catch {}
      if (configuredPort === undefined) {
        fallbackUsed = true;
        console.warn(`默认管理端口 ${port} 被占用，改用系统分配的空闲端口。`);
        server.listen(0, host);
        return;
      }
    }
    console.error(`管理 Web 启动失败: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, host);
}
