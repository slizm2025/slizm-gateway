import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const protectedPorts = new Set([4000, 4100, 48731]);

async function reservePorts(count) {
  const servers = [];
  try {
    for (let i = 0; i < count; i += 1) {
      const server = createServer();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      servers.push(server);
    }
    return servers.map((server) => server.address().port);
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}

async function isolatedPorts() {
  for (;;) {
    const ports = await reservePorts(2);
    if (ports.every((port) => !protectedPorts.has(port))) return ports;
  }
}

async function runCli(fixture, args, { allowFailure = false, timeout = 45_000 } = {}) {
  const command = [join(fixture.gatewayDir, 'scripts', 'gw.js'), ...args].join(' ');
  try {
    return await execFileAsync(process.execPath, [join(fixture.gatewayDir, 'scripts', 'gw.js'), ...args], {
      cwd: fixture.gatewayDir,
      env: fixture.env,
      timeout,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    if (allowFailure) {
      return {
        code: typeof error.code === 'number' ? error.code : 1,
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? '',
      };
    }
    error.message += `\ncommand: node ${command}\nstdout:\n${error.stdout ?? ''}\nstderr:\n${error.stderr ?? ''}`;
    throw error;
  }
}

async function status(fixture) {
  const result = await runCli(fixture, ['status', '--json'], { allowFailure: true });
  try {
    return JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error(
      `status --json did not emit a JSON document (exit ${result.code})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      { cause: error },
    );
  }
}

function service(statusValue, name) {
  const value = statusValue[name];
  assert.ok(value && typeof value === 'object', `status.${name} must be an object`);
  assert.equal(typeof value.running, 'boolean', `status.${name}.running must be boolean`);
  assert.ok(Object.hasOwn(value, 'pid'), `status.${name}.pid must be present`);
  assert.ok(Object.hasOwn(value, 'url'), `status.${name}.url must be present`);
  return value;
}

function assertRunning(statusValue, name, expectedPort) {
  const value = service(statusValue, name);
  assert.equal(value.running, true, `status.${name} should be running`);
  assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0, `status.${name}.pid should be a live PID`);
  assert.equal(typeof value.url, 'string', `status.${name}.url should be a string while running`);
  assert.equal(new URL(value.url).port, String(expectedPort), `status.${name}.url should use the isolated port`);
  return value;
}

function assertStopped(statusValue, name) {
  const value = service(statusValue, name);
  assert.equal(value.running, false, `status.${name} should be stopped`);
  return value;
}

async function readPidFile(path) {
  try {
    const raw = await readFile(path, 'utf8');
    try {
      const value = JSON.parse(raw);
      if (Number.isSafeInteger(value?.pid) && value.pid > 0) return value.pid;
    } catch {}
    const pid = Number(raw.trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function cleanupFixture(fixture) {
  await runCli(fixture, ['down'], { allowFailure: true, timeout: 20_000 }).catch(() => {});

  const managedPids = new Set([
    await readPidFile(join(fixture.gatewayDir, 'logs', 'gateway.pid')),
    await readPidFile(join(fixture.webStateDir, 'web-session.json')),
  ].filter(Boolean));
  for (const pid of managedPids) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  for (let i = 0; i < 20; i += 1) {
    const alive = [...managedPids].some((pid) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    });
    if (!alive) break;
    await delay(100);
  }
  for (const pid of managedPids) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  await rm(fixture.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function createFixture(t, { webEnabled = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'gw-lifecycle-'));
  const gatewayDir = join(dir, 'slizm-gateway');
  const webStateDir = join(dir, 'web-state');
  const claudeConfigDir = join(dir, 'claude-config');
  const fixture = {
    dir,
    gatewayDir,
    webStateDir,
    env: null,
  };
  t.after(() => cleanupFixture(fixture));

  await mkdir(join(gatewayDir, 'scripts'), { recursive: true });
  await mkdir(webStateDir, { recursive: true });
  await mkdir(claudeConfigDir, { recursive: true });
  await cp(join(root, 'src'), join(gatewayDir, 'src'), { recursive: true });
  await cp(join(root, 'scripts', 'gw.js'), join(gatewayDir, 'scripts', 'gw.js'));
  await cp(join(root, 'scripts', 'usage-report.js'), join(gatewayDir, 'scripts', 'usage-report.js'));
  await cp(join(root, 'node_modules'), join(gatewayDir, 'node_modules'), { recursive: true });
  await writeFile(join(gatewayDir, 'package.json'), '{"type":"module"}\n');

  const configPath = join(gatewayDir, 'providers.json');
  await writeFile(configPath, JSON.stringify({
    clientToken: 'fixture-client-token',
    providers: [{
      name: 'fixture',
      apiType: 'openai',
      apiKey: 'fixture-key',
      baseUrl: 'http://127.0.0.1:1',
    }],
    routes: { fixture: 'fixture' },
  }));

  const [gatewayPort, webPort] = await isolatedPorts();
  fixture.env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    GATEWAY_CONFIG: configPath,
    GATEWAY_HOST: '127.0.0.1',
    GATEWAY_PORT: String(gatewayPort),
    GATEWAY_USAGE_DIR: 'off',
    GATEWAY_WEB_ENABLED: webEnabled ? '1' : '0',
    GATEWAY_WEB_PORT: String(webPort),
    GATEWAY_WEB_STATE_DIR: webStateDir,
    NO_COLOR: '1',
  };
  fixture.gatewayPort = gatewayPort;
  fixture.webPort = webPort;
  fixture.run = (args, options) => runCli(fixture, args, options);
  fixture.status = () => status(fixture);
  return fixture;
}

test('up, status, restart and down manage the gateway and Web lifecycle', { timeout: 120_000 }, async (t) => {
  const fixture = await createFixture(t);

  const initial = await fixture.status();
  assertStopped(initial, 'gateway');
  assertStopped(initial, 'web');

  await fixture.run(['up', '--no-open']);
  const started = await fixture.status();
  const gatewayBefore = assertRunning(started, 'gateway', fixture.gatewayPort);
  const webBefore = assertRunning(started, 'web', fixture.webPort);

  await fixture.run(['up', '--no-open']);
  const repeated = await fixture.status();
  assert.equal(assertRunning(repeated, 'gateway', fixture.gatewayPort).pid, gatewayBefore.pid);
  assert.equal(assertRunning(repeated, 'web', fixture.webPort).pid, webBefore.pid);

  await fixture.run(['restart', '--all']);
  const restarted = await fixture.status();
  const gatewayAfter = assertRunning(restarted, 'gateway', fixture.gatewayPort);
  const webAfter = assertRunning(restarted, 'web', fixture.webPort);
  assert.notEqual(gatewayAfter.pid, gatewayBefore.pid, 'restart --all should replace the gateway process');
  assert.notEqual(webAfter.pid, webBefore.pid, 'restart --all should replace the Web process');

  await fixture.run(['down']);
  const stopped = await fixture.status();
  assertStopped(stopped, 'gateway');
  assertStopped(stopped, 'web');
});

test('up starts only the gateway when Web is disabled', { timeout: 90_000 }, async (t) => {
  const fixture = await createFixture(t, { webEnabled: false });

  await fixture.run(['up', '--no-open']);
  const started = await fixture.status();
  assertRunning(started, 'gateway', fixture.gatewayPort);
  assertStopped(started, 'web');

  await fixture.run(['down']);
  const stopped = await fixture.status();
  assertStopped(stopped, 'gateway');
  assertStopped(stopped, 'web');
});

test('redirected help output does not leak ANSI color controls', { timeout: 90_000 }, async (t) => {
  const fixture = await createFixture(t);
  fixture.env = { ...fixture.env, NO_COLOR: '', FORCE_COLOR: '' };

  const result = await fixture.run(['unknown-command'], { allowFailure: true });
  const output = `${result.stdout}${result.stderr}`;

  assert.notEqual(result.code, 0);
  assert.match(output, /网关管理/);
  assert.doesNotMatch(output, /\x1b\[/);
});

test('stale or missing web-session.json still recognizes, reuses, and stops the running Web server', { timeout: 120_000 }, async (t) => {
  const fixture = await createFixture(t);
  const sessionFile = join(fixture.webStateDir, 'web-session.json');

  await fixture.run(['up', '--no-open']);
  const started = await fixture.status();
  const webBefore = assertRunning(started, 'web', fixture.webPort);

  // Overwrite web-session.json with a stale dead PID & bogus port.
  await writeFile(sessionFile, JSON.stringify({
    pid: 999999,
    port: 65500,
    token: '0'.repeat(64),
  }));

  const recoveredStatus = await fixture.status();
  const webRecovered = assertRunning(recoveredStatus, 'web', fixture.webPort);
  assert.equal(webRecovered.pid, webBefore.pid);
  assert.equal(webRecovered.stale, false);

  // Calling up --no-open must reuse the live Web server instead of spawning a duplicate.
  await fixture.run(['up', '--no-open']);
  const afterUp = await fixture.status();
  assert.equal(assertRunning(afterUp, 'web', fixture.webPort).pid, webBefore.pid);

  // Even if web-session.json is deleted completely, down still stops the live Web server.
  await rm(sessionFile, { force: true });
  await fixture.run(['down']);
  const stopped = await fixture.status();
  assertStopped(stopped, 'gateway');
  assertStopped(stopped, 'web');
});

test('autostart on, status and off manage an ASCII background VBS script cleanly', { timeout: 90_000 }, async (t) => {
  const fixture = await createFixture(t);
  const autostartDir = join(fixture.dir, 'startup');
  fixture.env = { ...fixture.env, GATEWAY_AUTOSTART_DIR: autostartDir };

  const before = await fixture.run(['autostart', 'status']);
  assert.match(before.stdout, /未开启/);

  await fixture.run(['autostart', 'on']);
  const vbsPath = join(autostartDir, 'SlizmGateway.vbs');
  const raw = await readFile(vbsPath);
  assert.ok(![...raw].some((byte) => byte > 0x7f), 'autostart VBS must stay ASCII-only');
  const text = raw.toString('utf8');
  assert.match(text, /up --no-open/);
  assert.match(text, /, 0, True/);

  const enabled = await fixture.run(['autostart', 'status']);
  assert.match(enabled.stdout, /已开启/);

  await fixture.run(['autostart', 'off']);
  const after = await fixture.run(['autostart', 'status']);
  assert.match(after.stdout, /未开启/);
});
