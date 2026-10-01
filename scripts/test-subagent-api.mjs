import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createAdminServer } from '../src/admin/server.js';
import { configuredSubagentModels, createSubagentModels } from '../src/admin/subagent-models.js';

test('management markup contains every statically referenced element and the subagent navigation', async () => {
  const script = await readFile(new URL('../src/admin/public/app.js', import.meta.url), 'utf8');
  const subagentsScript = await readFile(new URL('../src/admin/public/subagents.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../src/admin/public/index.html', import.meta.url), 'utf8');
  const referenced = [...new Set([
    ...script.matchAll(/\$\("([^"]+)"\)/g),
    ...subagentsScript.matchAll(/\$\("([^"]+)"\)/g),
  ].map((m) => m[1]))];
  const present = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  assert.deepEqual(referenced.filter((id) => !present.has(id)), []);
  assert.ok(present.has('tab-subagents'));
  assert.ok(present.has('view-subagents'));
});

async function fixture(t, fetchImpl) {
  const root = await mkdtemp(join(tmpdir(), 'gw-subagent-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, 'providers.json');
  await writeFile(configPath, JSON.stringify({ providers: [{ name: 'test', apiType: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'secret-not-for-browser', models: { mapped: 'target' } }], routes: { fast: { provider: 'test', model: 'target' } } }));
  const claudeHome = join(root, 'claude');
  const codexHome = join(root, 'codex');
  await mkdir(join(claudeHome, 'agents'), { recursive: true });
  await mkdir(join(codexHome, 'agents'), { recursive: true });
  await writeFile(join(claudeHome, 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Review\nmodel: fast\n---\nReview carefully.\n');
  return { root, configPath, claudeHome, codexHome, fetchImpl };
}

test('model candidates follow explicit routes before provider maps and do not invent fallback models', () => {
  const a = { name: 'a', requireKey: true, apiKey: 'key', models: { fast: 'wrong', mapped: 'first', first: 'final' } };
  const b = { name: 'b', requireKey: true, models: { missing: 'missing' } };
  const cfg = { providers: new Map([['a', a], ['b', b]]), routes: new Map([['fast', { provider: 'a', model: 'right' }], ['opus', { provider: 'a' }]]), defaultRoute: 'a' };
  const rows = configuredSubagentModels(cfg, 'claude');
  assert.equal(rows.find((r) => r.id === 'fast').targetModel, 'right');
  assert.equal(rows.find((r) => r.id === 'mapped').targetModel, 'final');
  assert.equal(rows.find((r) => r.id === 'opus').available, false);
  assert.equal(rows.find((r) => r.id === 'missing').available, false);
  assert.equal(rows.some((r) => r.id === 'random'), false);
  assert.equal(configuredSubagentModels(cfg, 'codex').find((r) => r.id === 'opus').available, true);
});

test('model checks use each client protocol, cache failures, and invalidate on configuration edits', async (t) => {
  const f = await fixture(t);
  const calls = [];
  let failed = false;
  const models = createSubagentModels({ configPath: f.configPath, verifyGateway: async () => {}, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (failed) return new Response('denied', { status: 403 });
    const type = url.endsWith('/responses') ? 'response.completed' : 'message_stop';
    return new Response('data: ' + JSON.stringify({ type }) + '\n\n');
  } });
  assert.equal(models.list('claude')[0].status, 'unchecked');
  assert.equal(models.list('claude')[0].available, false);
  assert.equal((await models.check('claude'))[0].status, 'ok');
  assert.equal(JSON.parse(calls[0].options.body).stream, true);
  assert.ok(calls[0].url.endsWith('/v1/messages'));
  assert.equal((await models.check('codex'))[0].status, 'ok');
  assert.ok(calls.some((call) => call.url.endsWith('/v1/responses')));
  failed = true;
  assert.equal((await models.check('codex'))[0].available, false);
  assert.throws(() => models.validate('codex', 'fast'), /HTTP 403/);
  assert.doesNotThrow(() => models.validate('claude', 'inherit'));
  assert.throws(() => models.validate('codex', 'inherit'));
  const config = JSON.parse(await readFile(f.configPath, 'utf8'));
  config.routes.fast.model = 'new-target';
  await writeFile(f.configPath, JSON.stringify(config));
  assert.equal(models.list('codex')[0].status, 'unchecked');
  assert.ok(!JSON.stringify(models.list('codex')).includes('secret-not-for-browser'));
});

test('model checks reject truncated streams and incomplete response events', async (t) => {
  const f = await fixture(t);
  for (const body of ['data: {"type":"response.created"}\n\n', 'data: {"type":"response.incomplete"}\n\n', 'data: {"type":"response.completed"}']) {
    const models = createSubagentModels({ configPath: f.configPath, verifyGateway: async () => {}, fetchImpl: async () => new Response(body) });
    assert.equal((await models.check('codex'))[0].available, false);
  }
  const capped = createSubagentModels({ configPath: f.configPath, verifyGateway: async () => {}, fetchImpl: async () => new Response('data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"},"usage":{"output_tokens":96}}}\n\n') });
  assert.equal((await capped.check('codex'))[0].status, 'ok');
});

test('model probe history survives service restart and expires without another paid request', async (t) => {
  const f = await fixture(t);
  const cachePath = join(f.root, 'checks.json');
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response('data: {"type":"message_stop"}\n\n'); };
  const first = createSubagentModels({ configPath: f.configPath, verifyGateway: async () => {}, cachePath, fetchImpl });
  await first.check('claude');
  const checkedCalls = calls;
  const second = createSubagentModels({ configPath: f.configPath, verifyGateway: async () => {}, cachePath, fetchImpl });
  assert.equal(second.list('claude')[0].available, true);
  assert.equal(calls, checkedCalls);
  assert.ok(!(await readFile(cachePath, 'utf8')).includes('secret-not-for-browser'));
  const expired = createSubagentModels({ configPath: f.configPath, verifyGateway: async () => {}, cachePath, fetchImpl, cacheTtlMs: -1 });
  assert.equal(expired.list('claude')[0].available, false);
  assert.equal(expired.list('claude')[0].status, 'unchecked');
});

test('model detection rejects an old running route configuration before any paid request', async (t) => {
  const f = await fixture(t);
  let paid = 0;
  let restartRequired = true;
  const revision = createHash('sha256').update(await readFile(f.configPath, 'utf8')).digest('hex');
  const models = createSubagentModels({ configPath: f.configPath, fetchImpl: async (url) => {
    if (url.endsWith('/health')) return Response.json({ service: 'slizm-gateway' });
    if (url.endsWith('/pricing-status')) return Response.json({ revision, restartRequired });
    paid++;
    return new Response('data: {"type":"message_stop"}\n\n');
  } });
  await assert.rejects(models.check('claude'), { statusCode: 409 });
  assert.equal(paid, 0);
  restartRequired = false;
  assert.equal((await models.check('claude'))[0].status, 'ok');
  assert.ok(paid > 0);
});

test('subagent API requires session and same origin, saves real files, and rejects stale or unsafe writes', async (t) => {
  const f = await fixture(t);
  const secret = 'a'.repeat(64);
  const server = createAdminServer({ ...f, backupDir: join(f.root, 'backups'), stateDir: f.root, logDir: f.root, ledgerDir: null, sessionSecret: secret,
    subagentModelOptions: { verifyGateway: async () => {}, fetchImpl: async () => new Response('data: {"type":"message_stop"}\n\n') },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(origin + '/api/subagents')).status, 401);
  const session = await fetch(origin + '/api/session', { method: 'POST', headers: { origin, authorization: 'Bearer ' + secret, 'content-type': 'application/json' }, body: '{}' });
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const request = (path, method = 'GET', body, requestOrigin = origin) => fetch(origin + path, { method, headers: { cookie, origin: requestOrigin, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await (await request('/api/subagents?tool=claude')).json();
  const agent = data.agents.find((entry) => entry.name === 'reviewer');
  assert.ok(agent);
  assert.ok(!JSON.stringify(data).includes('secret-not-for-browser'));
  const path = '/api/subagents/claude/' + encodeURIComponent(agent.id);
  const body = { ...agent, description: 'Updated description' };
  assert.equal((await request(path, 'PUT', body, 'http://evil.test')).status, 403);
  assert.equal((await request(path, 'PUT', { ...body, revision: 'stale' })).status, 409);
  const saved = await request(path, 'PUT', body);
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.match(await readFile(join(f.claudeHome, 'agents', 'reviewer.md'), 'utf8'), /Updated description/);
  assert.notEqual((await saved.json()).agents.find((a) => a.id === agent.id).revision, agent.revision);
  const unsafe = await request('/api/subagents/claude/..%5Coutside', 'PUT', body);
  assert.ok([400, 404].includes(unsafe.status));
  assert.equal((await request('/api/subagents?tool=other')).status, 400);
  assert.equal((await request('/api/subagents/claude/check-models', 'POST', {})).status, 200);
  const defaults = await request('/api/subagents/claude/defaults', 'PUT', { revision: data.defaults.revision, model: 'fast', effort: null });
  assert.equal(defaults.status, 200, await defaults.clone().text());
  assert.equal(JSON.parse(await readFile(join(f.claudeHome, 'settings.json'), 'utf8')).env.CLAUDE_CODE_SUBAGENT_MODEL, 'fast');
});
