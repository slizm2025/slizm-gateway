import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { join } from 'node:path';
import { ROOT } from '../src/config.js';

const script = readFileSync(join(ROOT, 'src', 'admin', 'public', 'app.js'), 'utf8');
const subagentsScript = readFileSync(join(ROOT, 'src', 'admin', 'public', 'subagents.js'), 'utf8');

function element() {
  const listeners = new Map();
  const descendants = new Map();
  const classes = new Set(['hidden']);
  const calls = [];
  return {
    listeners,
    calls,
    dataset: {},
    children: [],
    get innerHTML() { return ''; },
    set innerHTML(value) { if (value === '') this.children = []; },
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      toggle: (name, force) => (force ?? !classes.has(name)) ? classes.add(name) : classes.delete(name),
      contains: (name) => classes.has(name),
    },
    style: { setProperty(name, value) { this[name] = value; } },
    value: '',
    clientWidth: 600,
    clientHeight: 260,
    contains(node) { return this === node || this.children.some((child) => child.contains(node)); },
    offsetWidth: 118,
    parentElement: { clientHeight: 260 },
    addEventListener(name, callback) { listeners.set(name, callback); },
    querySelector(name) {
      if (!descendants.has(name)) descendants.set(name, element());
      return descendants.get(name);
    },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 600, height: 260 }; },
    getContext() {
      return {
        scale() {}, clearRect() {}, beginPath() {}, closePath() {}, fill() {}, stroke() {},
        setLineDash() {}, fillRect() {},
        moveTo(...args) { calls.push(['moveTo', ...args]); },
        lineTo(...args) { calls.push(['lineTo', ...args]); },
        arc(...args) { calls.push(['arc', ...args]); },
        fillText(...args) { calls.push(['fillText', ...args]); },
        measureText(text) { return { width: String(text).length * 7 }; },
        createLinearGradient() { return { addColorStop() {} }; },
      };
    },
    appendChild(child) { this.children.push(child); },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    add() {},
    setAttribute(name, value) {
      this[name] = value;
      if (name === 'class') this.className = value;
      if (name.startsWith('data-')) {
        const camel = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        this.dataset[camel] = String(value);
      }
    },
    getTotalLength() { return 100; },
    getAttribute(name) { return this[name] ?? null; },
    focus() { this.focused = true; },
    removeAttribute(name) { delete this[name]; },
  };
}

function costSummaryText(node) {
  return node?.children?.[0]?.children?.[0]?.children?.[0]?.textContent ?? node?.textContent;
}

function findByClass(node, className) {
  if (!node) return null;
  if (String(node.className || "").split(/\s+/).includes(className)) return node;
  for (const child of node.children || []) {
    const found = findByClass(child, className);
    if (found) return found;
  }
  return null;
}

function findContainerWithClass(node, className) {
  if (!node) return null;
  if ((node.children || []).length >= 6 && (node.children || []).some((child) => findByClass(child, className))) return node;
  for (const child of node.children || []) {
    const found = findContainerWithClass(child, className);
    if (found) return found;
  }
  return null;
}

async function renderPage(response, clock = Date, options = {}) {
  const enableRaf = Boolean(options.raf || options.manualRaf || options.animation || options.performance);
  let perfTime = options.initialPerfTime || 0;
  let nextRafId = 1;
  const rafCallbacks = new Map();

  const perfNow = options.perfNow || (() => perfTime);
  const requestAnimationFrame = options.requestAnimationFrame || ((callback) => {
    const id = nextRafId++;
    rafCallbacks.set(id, callback);
    return id;
  });
  const cancelAnimationFrame = options.cancelAnimationFrame || ((id) => {
    rafCallbacks.delete(id);
  });
  const stepRaf = (advanceMs = 16.67) => {
    perfTime += advanceMs;
    const callbacks = [...rafCallbacks.entries()];
    rafCallbacks.clear();
    for (const [, cb] of callbacks) {
      cb(perfTime);
    }
    return perfTime;
  };
  const windowListeners = new Map();
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const document = {
    readyState: 'complete',
    getElementById: get,
    querySelector: (selector) => get(selector),
    querySelectorAll: (selector) => selector === '.nav-tab'
      ? ['overview', 'usage', 'logs', 'settings', 'subagents'].map((view) => {
        const tab = get('tab-' + view);
        tab.dataset = { view };
        return tab;
      })
      : [],
    createElement: () => element(),
    createElementNS: () => element(),
    documentElement: element(),
    body: element(),
    addEventListener() {},
  };
  const preferences = new Map();
  const intervals = [];
  const context = {
    Date: clock,
    syncSwitchboardFlowRequests: () => {},
    ...(enableRaf ? {
      performance: { now: perfNow },
      requestAnimationFrame,
      cancelAnimationFrame,
    } : {}),
    document,
    window: {
      location: { hash: '', pathname: '/', search: '' },
      addEventListener(name, callback) { windowListeners.set(name, callback); },
      devicePixelRatio: 1,
      confirm: () => true,
      matchMedia: (query) => ({
        matches: query.includes('prefers-reduced-motion') ? Boolean(options.reducedMotion) : false,
        addEventListener() {},
        removeEventListener() {},
      }),
      localStorage: {
        getItem: (key) => preferences.get(key) ?? null,
        setItem: (key, value) => preferences.set(key, value),
      },
      ...(enableRaf ? {
        performance: { now: perfNow },
        requestAnimationFrame,
        cancelAnimationFrame,
      } : {}),
    },
    fetch: async (...args) => typeof response === 'function' ? response(...args) : response,
    URLSearchParams,
    Option: function Option(text, value) { this.text = text; this.value = value; },
    setInterval: (callback) => intervals.push(callback),
    clearInterval() {},
    setTimeout() {},
  };
  runInNewContext(subagentsScript, context, { filename: 'subagents.js' });
  runInNewContext(script, context, { filename: 'app.js' });
  await new Promise((resolve) => setImmediate(resolve));
  get.document = document;
  get.preferences = preferences;
  get.intervals = intervals;
  get.rafCallbacks = rafCallbacks;
  get.stepRaf = stepRaf;
  get.getPerfTime = () => perfTime;
  get.setPerfTime = (t) => { perfTime = t; };
  get.windowListeners = windowListeners;
  get.triggerResize = () => { windowListeners.get('resize')?.(); };
  return get;
}

test('a plain page URL establishes a same-origin session before loading data', async () => {
  const calls = [];
  await renderPage(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ gateway: { online: true }, total: {}, providers: [], models: [], recent: [], trend: [] }) };
  });
  assert.equal(calls[0].url, '/api/session');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.ok(calls.slice(1).some(({ url }) => url.startsWith('/api/overview')));
});

test('overview renders online status and gates restart while requests are active', async () => {
  let activeRequests = 2;
  const request = { requestId: 'req-overview', clientType: 'codex', provider: 'relay', model: 'actual', route: 'main', inputProtocol: 'responses', upstreamProtocol: 'responses', adapter: 'direct' };
  const get = await renderPage({
    ok: true,
    status: 200,
    json: async () => {
      const active = activeRequests ? [request] : [];
      return {
        gateway: { online: true, pid: 1234, uptimeSec: 60, activeRequests },
        switchboardActiveRequests: active.length,
        switchboardActive: active, switchboard: [],
        total: {}, providerNames: [], trend: [], inflight: active, providers: [], models: [], recent: [],
      };
    },
  });
  assert.equal(get('gw-status-badge').querySelector('.badge-text').textContent, '网关运行中');
  assert.equal(get('meta-pid').textContent, 1234);
  assert.equal(get('sb-active').textContent, '1');
  assert.equal(get('btn-open-restart').disabled, true);
  assert.match(get('btn-open-restart').title, /2 个在途请求/);

  activeRequests = 0;
  get('btn-refresh-overview').listeners.get('click')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(get('btn-open-restart').disabled, false);
  assert.equal(get('sb-active').textContent, '0');
});

test('an unauthenticated overview does not label the gateway offline', async () => {
  const get = await renderPage({ status: 401 });
  assert.equal(get('gw-status-badge').querySelector('.badge-text').textContent, '需要登录');
  assert.equal(get('auth-expired-banner').classList.contains('hidden'), false);
});

test('usage view shares filters and remains connected to overview polling', async () => {
  const get = await renderPage({
    ok: true,
    status: 200,
    json: async () => ({
      gateway: { online: true, activeRequests: 0 },
      total: {}, providerNames: [], trend: [], inflight: [], providers: [], models: [], recent: [],
    }),
  });
  get('tab-usage').listeners.get('click')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(get('view-usage').classList.contains('hidden'), false);
  assert.equal(get('view-overview').classList.contains('hidden'), true);
  assert.equal(get('overview-filters').classList.contains('hidden'), false);
  assert.equal(get('tab-usage')['aria-current'], 'page');
  assert.equal(get('current-view-title').textContent, '用量分析');
  get('tab-overview').listeners.get('click')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(get('view-overview').classList.contains('hidden'), false);
  assert.equal(get('view-usage').classList.contains('hidden'), true);
  assert.equal(get('current-view-title').textContent, '运行概览');
});

test('trend draws each point with readable axes and reveals exact value by pointer and keyboard', async () => {
  const trend = [
    { time: '2026-09-26T10:00:00.000Z', totalTokens: 1200, costUsd: 0.12 },
    { time: '2026-09-26T12:00:00.000Z', totalTokens: 4200, costUsd: 0.24 },
    { time: '2026-09-26T16:00:00.000Z', totalTokens: 1900, costUsd: 0.08 },
  ];
  const get = await renderPage({
    ok: true, status: 200,
    json: async () => ({ gateway: { online: true }, total: {}, providerNames: [], trend, inflight: [], providers: [], models: [], recent: [] }),
  });
  const canvas = get('trend-canvas');
  assert.equal(canvas.calls.filter(([type]) => type === 'arc').length, 3);
  assert.ok(canvas.calls.some(([type, text]) => type === 'fillText' && text === '4K'));
  assert.ok(canvas.calls.every(([, ...args]) => args.every((value) => typeof value !== 'number' || Number.isFinite(value))));
  assert.equal(get('trend-data-body').children.length, 3);
  assert.equal(get('trend-empty').classList.contains('hidden'), true);

  canvas.listeners.get('pointermove')({ clientX: 310, pointerType: 'mouse' });
  assert.equal(get('trend-tooltip').classList.contains('hidden'), false);
  assert.match(get('trend-tooltip-value').textContent, /4,200 Tokens/);
  assert.equal(get('trend-tooltip-adjusted').textContent, '倍率后 $0.240000');
  canvas.listeners.get('pointerleave')();
  assert.equal(get('trend-tooltip').classList.contains('hidden'), true);
  canvas.listeners.get('keydown')({ key: 'End', preventDefault() {} });
  assert.match(get('trend-tooltip-value').textContent, /1,900 Tokens/);
  assert.match(canvas['aria-label'], /1,900 Tokens/);
  assert.equal(get('trend-tooltip')['aria-hidden'], 'false');
});

test('cost trend distinguishes missing prices and a single point still shows its time', async () => {
  const trend = [{ time: '2026-09-26T12:00:00.000Z', totalTokens: 100, costUsd: null }];
  const get = await renderPage({
    ok: true, status: 200,
    json: async () => ({ gateway: { online: true }, total: {}, providerNames: [], trend, inflight: [], providers: [], models: [], recent: [] }),
  });
  const canvas = get('trend-canvas');
  assert.equal(canvas.calls.filter(([type]) => type === 'arc').length, 1);
  assert.ok(canvas.calls.some(([type, text]) => type === 'fillText' && String(text).includes(':')));
  const costButton = element();
  costButton.dataset = { metric: 'cost' };
  get('trend-metric-toggle').listeners.get('click')({ target: { closest: () => costButton } });
  assert.equal(get('trend-empty').textContent, '暂无已计价数据');
  assert.equal(get('trend-data-value-heading').textContent, '原价 (USD)');
  assert.equal(get('trend-data-body').children[0].children[1].textContent, '未计价');
  assert.equal(get('trend-data-adjusted-heading').classList.contains('hidden'), false);
  assert.equal(get('trend-tooltip').classList.contains('hidden'), true);
});

test('overview formats USD to six places and abbreviates token counts without changing exact trend readings', async () => {
  const trend = [{ time: '2026-09-26T12:00:00.000Z', totalTokens: 1234, baseCostUsd: 0.0000012, costUsd: 0.0000024 }];
  const get = await renderPage({
    ok: true, status: 200,
    json: async () => ({
      gateway: { online: true }, providerNames: [], trend,
      total: { baseCostUsd: 0.0000012, costUsd: 0.0000024, totalTokens: 1_000_000, input: 999_999,
        output: 2_345_678_901, cacheRead: 1234, cacheWrite: 0 },
      inflight: [{ requestId: 'req', estimatedInputTokens: 1500, outputTokens: 42 }],
      providers: [{ name: 'provider', input: 1234, output: 1_500_000,
        cacheRead: 2500, cacheWrite: 0, baseCostUsd: 0.0000012, costUsd: 0.0000024 }],
      models: [{ name: 'model', totalTokens: 2_000_000_000, input: 1000,
        output: 5, baseCostUsd: 0.0000012, costUsd: 0.0000024 }],
      recent: [{ time: trend[0].time, inputTokens: 1234, outputTokens: 5,
        cacheReadTokens: 1_200_000, baseCostUsd: 0.0000012, costUsd: 0.0000024 }],
    }),
  });
  assert.equal(costSummaryText(get('m-cost')), '$0.000001');
  assert.equal(get('m-tokens').textContent, '1M');
  assert.equal(get('m-input').textContent, '1M');
  assert.equal(get('m-output').textContent, '2.35B');
  assert.equal(get('m-cache').textContent, '1.23K / 0');
  assert.equal(get('#table-inflight tbody').children[0].children[5].textContent, '1.5K');
  assert.equal(get('#table-providers tbody').children[0].children[4].textContent, '1.5M');
  assert.equal(costSummaryText(get('#table-providers tbody').children[0].children[7].children[0]), '$0.000001');
  assert.equal(get('#table-models tbody').children[0].children[2].textContent, '2B');
  assert.equal(costSummaryText(get('#table-models tbody').children[0].children[6]), '$0.000001');
  assert.equal(get('#table-recent tbody').children[0].children[6].textContent, '1.23K / 5 / 1.2M');
  assert.equal(costSummaryText(get('#table-recent tbody').children[0].children[8]), '$0.000001');
  assert.equal(get('trend-data-body').children[0].children[1].textContent, '1.23K');

  const costButton = element();
  costButton.dataset = { metric: 'cost' };
  get('trend-metric-toggle').listeners.get('click')({ target: { closest: () => costButton } });
  assert.equal(get('trend-data-body').children[0].children[1].textContent, '$0.000001');
  assert.equal(get('trend-data-body').children[0].children[2].textContent, '$0.000002');
  assert.ok(get('trend-canvas').calls.some(([type, text]) => type === 'fillText' && text === '$0.000001'));
  get('trend-canvas').listeners.get('keydown')({ key: 'End', preventDefault() {} });
  assert.equal(get('trend-tooltip-value').textContent, '原价 $0.000001');
  assert.equal(get('trend-tooltip-adjusted').textContent, '倍率后 $0.000002');
});

test('TPS readings distinguish consumption from output means and render unavailable values', async () => {
  const get = await renderPage({
    ok: true, status: 200,
    json: async () => ({
      gateway: { online: true }, providerNames: [], trend: [], inflight: [],
      traffic: { tps: { current: 0, peak: 120.456, avg: 20 } },
      total: { avgOutputTokensPerSec: 55, outputTpsSamples: 2 },
      providers: [{ name: 'p', avgOutputTokensPerSec: 55, outputTpsSamples: 2 }],
      models: [{ name: 'm', avgOutputTokensPerSec: null, outputTpsSamples: 0 }],
      recent: [{ requestId: 'one', outputTokensPerSec: 100 }, { requestId: 'two', outputTokensPerSec: null }],
    }),
  });
  assert.equal(get('m-tps-current').textContent, '0.00 tok/s');
  assert.equal(get('m-tps-peak').textContent, '120.46 tok/s');
  assert.equal(get('m-tps-avg').textContent, '20.00 tok/s');
  assert.equal(get('m-output-tps').textContent, '55.00 tok/s');
  assert.equal(get('m-output-tps').title, '有效样本: 2');
  assert.equal(get('#table-providers tbody').children[0].children[9].textContent, '55.00 tok/s');
  assert.equal(get('#table-models tbody').children[0].children[8].textContent, '-');
  assert.equal(get('#table-recent tbody').children[0].children[9].textContent, '100.00 tok/s');
  assert.equal(get('#table-recent tbody').children[1].children[9].textContent, '-');
  const empty = await renderPage({ ok: true, status: 200, json: async () => ({ total: {}, recent: [], models: [], providers: [] }) });
  assert.equal(empty('m-tps-current').textContent, '-');
  assert.equal(empty('m-output-tps').textContent, '-');
  assert.equal(empty('#table-recent tbody').children[0].children[0].colSpan, 10);
});

test('cache hit rate uses the same input-context denominator for total, provider, and model', async () => {
  const usage = { input: 20, cacheRead: 70, cacheWrite: 10 };
  const get = await renderPage({
    ok: true, status: 200,
    json: async () => ({
      gateway: { online: true }, total: usage, providerNames: [], trend: [], inflight: [], recent: [],
      providers: [{ name: 'sample', ...usage }], models: [{ name: 'model', ...usage }],
    }),
  });
  assert.equal(get('m-cache-hit').textContent, '70.0%');
  assert.equal(get('#table-providers tbody').children[0].children[6].textContent, '70.0%');
  assert.equal(get('#table-models tbody').children[0].children[5].textContent, '70.0%');

  const empty = await renderPage({
    ok: true, status: 200,
    json: async () => ({ gateway: { online: true }, total: {}, providerNames: [], trend: [], inflight: [], providers: [], models: [], recent: [] }),
  });
  assert.equal(empty('m-cache-hit').textContent, '—');
  assert.equal(empty('#table-providers tbody').children[0].children[0].colSpan, 10);
  assert.equal(empty('#table-models tbody').children[0].children[0].colSpan, 9);
});

test('switchboard shows real provider usage and filters by clicking a line', async () => {
  const requests = [];
  const get = await renderPage(async (url) => {
    requests.push(url);
    const selected = new URL(url, 'http://localhost').searchParams.get('provider');
    const providers = [
      { name: 'site-a', requests: 3, errors: 1, costUsd: 0.002 },
      { name: 'site-b', requests: 1, errors: 0, costUsd: null },
    ].filter((provider) => !selected || provider.name === selected);
    return {
      ok: true, status: 200,
      json: async () => ({
        gateway: { online: true, activeRequests: 1, baseUrl: 'http://127.0.0.1:4000' },
        total: {}, providerNames: ['site-a', 'site-b'], trend: [],
        inflight: [{ provider: 'site-a' }], providers, models: [], recent: [],
      }),
    };
  });
  assert.equal(get('sb-active').textContent, '1');
  assert.match(get('sb-core-lamp').className, /is-live/);
  // 默认只列出正在被调用的上游；site-b 本时段有请求但当前空闲，收在“显示全部”里
  assert.equal(get('sb-lines').children.length, 1);
  const first = get('sb-lines').children[0].children[0];
  assert.equal(first['data-provider'], 'site-a');
  assert.equal(first.children[2].children[0].children[1].textContent, '75%');
  assert.match(renderedText(first.children[2].children[1]), /1 进行中/);
  const toggle = get('sb-upstream-toggle');
  assert.equal(toggle.hidden, false);
  toggle.listeners.get('click')();
  assert.equal(toggle['aria-pressed'], 'true');
  assert.equal(get('sb-lines').children.length, 2);
  assert.equal(get('sb-lines').children[1].children[0].children[2].children[0].children[1].textContent, '25%');
  get('sb-lines').listeners.get('click')({ target: { closest: () => first } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(requests.at(-1), /provider=site-a/);
  assert.equal(get('filter-provider').value, 'site-a');
  assert.equal(get('sb-lines').children.length, 1);
  get('sb-lines').listeners.get('click')({ target: { closest: () => get('sb-lines').children[0].children[0] } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.doesNotMatch(requests.at(-1), /provider=/);
  assert.equal(get('filter-provider').value, '');
  assert.equal(get('sb-lines').children.length, 2);
});

test('shared upstream model aggregates raw counts across agents instead of averaging rates', async () => {
  const route = { provider: 'relay', model: 'actual', inputProtocol: 'messages', upstreamProtocol: 'responses', adapter: 'messages-to-responses' };
  const active = [{ ...route, clientType: 'claude-code', route: 'alias-a' }, { ...route, clientType: 'codex', route: 'alias-b' }];
  const get = await renderPage({ ok: true, status: 200, json: async () => ({
    gateway: { online: true, activeRequests: 2 }, total: {}, providers: [], providerNames: ['relay'],
    models: [], recent: [], trend: [], inflight: active, switchboardActive: active, switchboardConfigured: active,
    switchboard: [
      { ...active[0], requests: 10, successes: 9, cancelled: 0, errors: 1, cacheRead: 90, cacheInput: 100, cacheHitRate: 0.9, successRate: 0.9 },
      { ...active[1], requests: 100, successes: 90, cancelled: 10, errors: 0, cacheRead: 10, cacheInput: 900, cacheHitRate: 10 / 900, successRate: 1 },
    ],
  }) });
  const models = findByClass(get('sb-lines'), 'sb-models');
  assert.equal(models.children.length, 1);
  const model = models.children[0];
  assert.equal(findByClass(model, 'sb-model-agents').children.length, 2);
  const metrics = findByClass(model, 'sb-model-metrics').children;
  assert.equal(metrics[0].children[1].textContent, '10.0%');
  assert.equal(metrics[1].children[1].textContent, '110');
  assert.equal(metrics[2].children[1].textContent, '99.0%');
  assert.match(metrics[0].className, /is-poor/);
  assert.match(metrics[1].className, /is-fair/);
  assert.match(metrics[2].className, /is-good/);
  assert.match(model.title, /alias-a, alias-b/);
});

test('switchboard shows agent and concrete upstream model for each route', async () => {
  const get = await renderPage({
    ok: true, status: 200,
    json: async () => ({
      gateway: { online: true, activeRequests: 1, baseUrl: 'http://127.0.0.1:4000' },
      providerNames: ['relay'], trend: [], providers: [], models: [], recent: [], inflight: [],
      switchboardActive: [{ clientType: 'claude-code', provider: 'relay', model: 'claude-sonnet-5' }],
      switchboard: [
        { clientType: 'claude-code', provider: 'relay', model: 'claude-sonnet-5', requests: 3, errors: 0, live: 1 },
        { clientType: 'codex', provider: 'relay', model: 'gpt-6-sol', requests: 1, errors: 0, live: 0 },
      ],
    }),
  });
  // 右侧按提供商分卡、按真实模型分行；默认只列出正在被调用的模型（gpt-6-sol 当前空闲）
  const rows = get('sb-lines').children;
  assert.equal(rows.length, 1);
  const [, body, calls] = rows[0].children[0].children;
  assert.equal(body.children[0].textContent, 'relay');
  const models = rows[0].children[1].children;
  assert.deepEqual(models.map((model) => findByClass(model, 'sb-model-name').textContent), ['claude-sonnet-5']);
  assert.match(models[0].className, /is-live/);
  assert.match(models[0].title, /claudecode → claude-sonnet-5/);
  assert.deepEqual(findByClass(models[0], 'sb-model-agents').children.map((dot) => dot.title), ['claudecode']);
  assert.equal(calls.children[0].children[0].textContent, '4 次');
  assert.match(renderedText(calls.children[1]), /1 进行中/);
  assert.equal(get('sb-upstream-count').textContent, '1');
});

test('switchboard aggregates requests and live count across models under same agent, defaults unknown, and toggles agent selection', async () => {
  let now = Date.now();
  class Clock extends Date { static now() { return now; } }
  let switchboard = [
    { clientType: 'claude-code', provider: 'relay-a', model: 'claude-sonnet-5', requests: 5, errors: 1, live: 2 },
    { clientType: 'claude-code', provider: 'relay-b', model: 'claude-haiku-4', requests: 3, errors: 0, live: 1 },
    { clientType: '', provider: '', model: '', requests: 2, errors: 0, live: 0 },
  ];
  let switchboardActive = [
    { clientType: 'claude-code', provider: 'relay-a', model: 'claude-sonnet-5' },
    { clientType: 'claude-code', provider: 'relay-a', model: 'claude-sonnet-5' },
    { clientType: 'claude-code', provider: 'relay-b', model: 'claude-haiku-4' },
  ];
  const get = await renderPage(async () => ({
    ok: true, status: 200,
    json: async () => ({
      gateway: { online: true, activeRequests: 3, baseUrl: 'http://127.0.0.1:4000' },
      providerNames: ['relay-a', 'relay-b'], trend: [], providers: [], models: [], recent: [], inflight: [],
      switchboardActive,
      switchboard,
    }),
  }), Clock);

  // Agent 聚合与排序：claude-code 拥有 live=3 requests=8，排在 unknown (live=0 requests=2) 前面
  const agentItems = get('sb-agents').children;
  assert.equal(agentItems.length, 2);
  assert.equal(get('sb-agents').classList.contains('hidden'), false);
  assert.equal(get('sb-agent-count').textContent, '2');
  // 上游计数 = 显示中的模型数；默认只显示正在被调用的
  assert.equal(get('sb-upstream-count').textContent, '2');

  const claudeAgent = agentItems[0];
  const unknownAgent = agentItems[1];
  assert.match(renderedText(claudeAgent), /claudecode/);
  assert.match(renderedText(claudeAgent), /8 次/);
  assert.match(renderedText(claudeAgent), /2 条上游/);
  assert.match(renderedText(claudeAgent), /3 进行中/);
  assert.match(renderedText(claudeAgent), /1 错误/);
  assert.match(claudeAgent.className, /is-live/);

  // unknown 默认值检查
  assert.match(renderedText(unknownAgent), /unknown/);
  assert.match(renderedText(unknownAgent), /2 次/);
  assert.match(renderedText(unknownAgent), /1 条上游/);
  assert.match(renderedText(unknownAgent), /当前空闲/);

  // 线路展示：默认只列出正在被调用的上游，live 优先降序
  let lineItems = get('sb-lines').children;
  assert.equal(lineItems.length, 2);
  assert.match(renderedText(lineItems[0]), /claude-sonnet-5/);
  assert.match(renderedText(lineItems[0]), /2 进行中/);
  assert.match(renderedText(lineItems[1]), /claude-haiku-4/);
  assert.match(renderedText(lineItems[1]), /1 进行中/);
  // “显示全部”后当前空闲的上游也列出
  get('sb-upstream-toggle').listeners.get('click')();
  lineItems = get('sb-lines').children;
  assert.equal(lineItems.length, 3);
  assert.match(renderedText(lineItems[2]), /unknown/);
  assert.equal(get('sb-upstream-count').textContent, '3');

  // 点击左侧 agent 切换 selectedAgent，触发高亮与 is-muted，不改变 providerFilter
  const claudeBtn = claudeAgent.children[0];
  claudeBtn.closest = (sel) => (sel === '.sb-agent-btn' ? claudeBtn : null);
  get('sb-agents').listeners.get('click')({ target: claudeBtn });

  assert.equal(claudeBtn.getAttribute('aria-pressed'), 'true');
  assert.match(unknownAgent.className, /is-muted/);
  assert.equal(get('filter-provider').value, '');
  assert.equal(lineItems[0].className.includes('is-muted'), false);
  assert.equal(lineItems[1].className.includes('is-muted'), false);
  assert.match(lineItems[2].className, /is-muted/);

  // 同模型不同 provider/agent 在刷新后正确原地更新结构并保留/更新标签
  switchboard = [
    { clientType: 'claude-code', provider: 'relay-a', model: 'claude-sonnet-5', requests: 10, errors: 0, live: 0 },
    { clientType: 'codex', provider: 'relay-b', model: 'claude-sonnet-5', requests: 4, errors: 0, live: 1 },
  ];
  switchboardActive = [{ clientType: 'codex', provider: 'relay-b', model: 'claude-sonnet-5' }];
  get('btn-refresh-overview').listeners.get('click')();
  await new Promise((resolve) => setImmediate(resolve));

  lineItems = get('sb-lines').children;
  assert.equal(lineItems.length, 2);
  // live 优先排序：codex (live=1) 排前面
  assert.match(renderedText(lineItems[0]), /relay-a/);
  assert.doesNotMatch(renderedText(lineItems[0]), /claudecode/);
  assert.match(findByClass(lineItems[1], 'sb-model').title, /codex → claude-sonnet-5/);
  assert.match(renderedText(lineItems[1]), /relay-b/);
  // 关掉“显示全部”：relay-a 当前没有调用，隐藏
  get('sb-upstream-toggle').listeners.get('click')();
  assert.equal(get('sb-lines').children.length, 1);
  assert.match(renderedText(get('sb-lines').children[0]), /relay-b/);

  // 空状态检查：没有 switchboard 且没有 providers 时，sb-agents 隐藏，sb-empty 显示
  switchboard = [];
  switchboardActive = [];
  now += 6000;
  get('btn-refresh-overview').listeners.get('click')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(get('sb-agents').classList.contains('hidden'), true);
  assert.equal(get('sb-empty').classList.contains('hidden'), false);
  assert.equal(get('sb-lines').classList.contains('hidden'), true);
  assert.equal(get('sb-agent-count').textContent, '0');
  assert.equal(get('sb-upstream-count').textContent, '0');
});
test('switchboard gives an empty-state action and distinguishes an offline gateway', async () => {
  const get = await renderPage(async (url) => ({
    ok: true, status: 200,
    json: async () => url === '/api/settings'
      ? { revision: 1, providers: [], routes: [] }
      : { gateway: { online: false, activeRequests: 0 }, total: {}, providerNames: [],
        trend: [], inflight: [], providers: [], models: [], recent: [] },
  }));
  assert.equal(get('sb-empty').classList.contains('hidden'), false);
  assert.equal(get('sb-lines').classList.contains('hidden'), true);
  assert.match(get('sb-core-lamp').className, /is-fault/);
  assert.equal(get('sb-core-state').textContent, '网关离线，请求无法转发');
  const action = element();
  action['data-goto'] = 'settings';
  get('sb-empty').listeners.get('click')({ target: { closest: () => action } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(get('view-settings').classList.contains('hidden'), false);
});

test('configured adapters retain DOM identity and order through idle, concurrent traffic and snapshot errors', async () => {
  const configured = [
    { route: 'original', provider: 'relay', model: 'actual', inputProtocol: 'messages', upstreamProtocol: 'responses', adapter: 'messages-to-responses' },
    { route: 'original', provider: 'relay', model: 'actual', inputProtocol: 'responses', upstreamProtocol: 'responses', adapter: 'direct' },
  ];
  let active = [];
  let unknown = false;
  const get = await renderPage({ ok: true, status: 200, json: async () => ({
    generatedAt: new Date().toISOString(), gateway: { online: true, activeRequests: active.length },
    online: true, activeRequests: active.length, liveUnknown: unknown,
    total: {}, providers: [], providerNames: ['relay'], models: [], recent: [], trend: [],
    switchboard: [], switchboardConfigured: configured, switchboardActive: active,
  }) });
  const host = get('sb-adapters');
  let nodes = [...host.children];
  assert.equal(nodes.length, 0);
  const refresh = async (expectedNode = null, expectedCount = 1) => {
    await get.intervals.at(-1)();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(host.children.length, expectedCount);
    if (expectedNode) assert.equal(host.children[0], expectedNode, 'adapter DOM node must be reused');
  };
  active = [{ ...configured[0], clientType: 'claude-code' }, { ...configured[0], clientType: 'deepseek-harness' }];
  await refresh();
  nodes = [...host.children];
  assert.equal(nodes.length, 1);
  const outerWires = get('sb-wires').children[0].children;
  const innerWires = get('sb-internal-wires').children[0].children;
  const outerKeys = outerWires.map((group) => group.getAttribute('data-edge-key'));
  assert.ok(outerKeys.filter((key) => key.startsWith('in ')).length >= 2, 'external canvas keeps one ingress per visible Agent');
  assert.equal(outerKeys.filter((key) => key.startsWith('out ')).length, 1, 'same upstream model uses one aggregated gateway egress');
  assert.ok(outerKeys.every((key) => /^(in|out) /.test(key)));
  assert.ok(outerWires.every((group) => !group.getAttribute('data-edge-key').includes('internal')),
    'external canvas must never connect adapter ports');
  assert.equal(innerWires.length, 2, 'internal canvas owns entry-to-adapter and adapter-to-exit lines');
  assert.ok(innerWires.every((group) => group.getAttribute('data-edge-key').startsWith('internal-')));
  const shared = innerWires.filter((group) => group.children.length === 3);
  assert.equal(shared.length, 2, 'both internal bus segments share two Agent colors');
  for (const group of shared) {
    assert.notEqual(group.children[1].style['--connection-color'], group.children[2].style['--connection-color']);
    assert.notEqual(group.children[1].getAttribute('data-flow-agent') || group.children[1].dataset?.flowAgent || group.children[1].style['--flow-from'], group.children[2].getAttribute('data-flow-agent') || group.children[2].dataset?.flowAgent || group.children[2].style['--flow-from']);
    assert.doesNotMatch(group.children[0].getAttribute('d'), /NaN|undefined/);
  }
  assert.equal(nodes[0].children[0].children[0].children[2].textContent, '2 个请求进行中');
  const disclosure = findByClass(nodes[0], 'sb-adapter-head');
  assert.equal(disclosure.getAttribute('aria-expanded'), 'false');
  const paths = findByClass(nodes[0], 'sb-paths').children;
  assert.equal(paths.length, 3, 'Messages supports three output protocols');
  assert.equal(paths.filter((path) => path.className.includes('is-configured-only')).length, 2);
  disclosure.listeners.get('click')();
  assert.equal(disclosure.getAttribute('aria-expanded'), 'true');
  assert.match(nodes[0].className, /is-open/);
  await refresh(nodes[0]);
  assert.equal(disclosure.getAttribute('aria-expanded'), 'true', 'adapter disclosure state must survive refresh');
  active = [{ ...configured[1], clientType: 'codex' }];
  await refresh();
  assert.equal(host.children.length, 1);
  assert.equal(host.children[0].children[1].children[1].textContent, 'codex 1');
  const switchedNode = host.children[0];
  active = [];
  await refresh(switchedNode);
  assert.ok(!switchedNode.className.includes('is-live'), 'waiting node is not active traffic');
  active = [{ ...configured[0], clientType: 'claude-code' }];
  await refresh();
  assert.equal(host.children[0], nodes[0], 'cached adapter DOM node must return when active again');
  unknown = true;
  await refresh();
  assert.ok(nodes.every((node) => node.children[0].children[0].children[2].textContent === '实时状态不可用'));
  const agentItem = get('sb-agents').children[0];
  assert.match(agentItem.className, /is-unknown/);
  assert.doesNotMatch(agentItem.className, /is-live/);
  assert.match(renderedText(agentItem), /状态未知/);
  assert.doesNotMatch(renderedText(agentItem), /进行中/);
  const lineItem = get('sb-lines').children[0];
  assert.match(lineItem.className, /is-unknown/);
  assert.doesNotMatch(lineItem.className, /is-live/);
  assert.match(renderedText(lineItem), /状态未知/);
  assert.doesNotMatch(renderedText(lineItem), /进行中/);
  const model = findByClass(get('sb-lines'), 'sb-model');
  assert.match(model.className, /is-unknown/);
  assert.doesNotMatch(model.className, /is-live/);
  assert.doesNotMatch(renderedText(model), /进行中/);
  assert.match(renderedText(model), /状态未知/);
  assert.ok(get('sb-wires').children[0].children.every((group) => group.children.length === 1), 'unknown external traffic must not animate');
  assert.ok(get('sb-internal-wires').children[0].children.every((group) => group.children.length === 1), 'unknown internal traffic must not animate');
});

test('live polling refreshes inflight rows and holds topology during a transient empty snapshot', async () => {
  const active = { requestId: 'gw-1', route: 'original', provider: 'relay', model: 'actual',
    clientType: 'codex', inputProtocol: 'responses', upstreamProtocol: 'responses', adapter: 'direct',
    elapsedMs: 1200, estimatedInputTokens: 100 };
  let live = [active];
  const configured = [{ ...active, requests: 0 }];
  const get = await renderPage(async (url) => {
    if (url === '/api/settings') return { ok: true, status: 200, json: async () => ({ revision: 1, providers: [], routes: [] }) };
    if (url.startsWith('/api/switchboard/live')) return {
      ok: true, status: 200,
      json: async () => ({ generatedAt: new Date().toISOString(), online: true, activeRequests: live.length,
        switchboardActive: live, inflight: live, switchboardConfigured: configured, liveUnknown: false }),
    };
    return {
      ok: true, status: 200,
      json: async () => ({ generatedAt: new Date().toISOString(), gateway: { online: true, activeRequests: live.length },
        total: {}, providerNames: [], trend: [], inflight: live, providers: [], models: [], recent: [],
        switchboard: [], switchboardActive: live, switchboardConfigured: configured }),
    };
  });
  const livePoll = get.intervals.at(-1);
  await livePoll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(get('inflight-count').textContent, 1);
  assert.equal(get('#table-inflight tbody').children.length, 1);
  assert.equal(get('sb-lines').children.length, 1);

  live = [{ ...active, elapsedMs: 0 }];
  await livePoll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(get('#table-inflight tbody').children[0].children[4].textContent, '0ms',
    'same requestId must not visually reset elapsed time');

  live = [];
  await livePoll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(get('inflight-count').textContent, 0, 'completed requests must leave the real inflight table');
  assert.equal(get('sb-lines').children.length, 1, 'topology remains visible during the short live gap');
});

test('waiting topology survives empty polls without counting traffic and expires', async () => {
  let now = Date.parse('2026-09-28T00:00:00Z');
  class Clock extends Date { static now() { return now; } }
  const request = { requestId: 'one', provider: 'relay', model: 'actual', route: 'original',
    clientType: 'codex', inputProtocol: 'responses', upstreamProtocol: 'responses', adapter: 'direct', elapsedMs: 1000 };
  let active = [request];
  const get = await renderPage(async () => ({ ok: true, status: 200, json: async () => ({
    sampledAt: new Date(now).toISOString(), generatedAt: new Date(now).toISOString(),
    online: true, activeRequests: active.length, gateway: { online: true, activeRequests: active.length },
    total: {}, providers: [], providerNames: [], models: [], recent: [], trend: [],
    inflight: active, switchboard: [], switchboardActive: active, switchboardConfigured: [request],
  }) }), Clock);
  const poll = get.intervals.at(-1);
  await poll();
  const adapter = get('sb-adapters').children[0];
  active = [];
  now += 1000;
  await poll();
  assert.equal(get('inflight-count').textContent, 0);
  assert.equal(get('sb-adapters').children[0], adapter);
  assert.ok(!adapter.className.includes('is-live'));
  now += 1000;
  await poll();
  assert.equal(get('sb-adapters').children[0], adapter, 'second empty poll must retain waiting topology');
  now += 6000;
  await poll();
  assert.equal(get('sb-adapters').children.length, 0, 'empty polls must not renew the hold');
});

test('retained topology becomes static idle after 5s, expires after 5 minutes, and show-all reveals configured-only rows', async () => {
  const base = Date.parse('2026-09-28T06:00:00.000Z');
  let browserNow = base;
  let sampledAt = base;
  class Clock extends Date { static now() { return browserNow; } }
  const request = { requestId: 'sticky-live', route: 'original', provider: 'relay', model: 'actual',
    clientType: 'codex', inputProtocol: 'responses', upstreamProtocol: 'responses', adapter: 'direct', elapsedMs: 1000 };
  const otherPath = { ...request, requestId: 'other-live', route: 'other', model: 'other-model', inputProtocol: 'messages', upstreamProtocol: 'responses', adapter: 'messages-to-responses' };
  const configured = [{ ...request }, { ...otherPath }];
  let active = [request];
  let retained = [];
  const get = await renderPage(async () => ({ ok: true, status: 200, json: async () => ({
    sampledAt: new Date(sampledAt).toISOString(), generatedAt: new Date(sampledAt).toISOString(),
    online: true, activeRequests: active.length, gateway: { online: true, activeRequests: active.length },
    total: {}, providers: [], providerNames: ['relay'], models: [], recent: [], trend: [], switchboard: [],
    inflight: active, switchboardActive: active, switchboardRetained: retained, switchboardConfigured: configured,
  }) }), Clock);
  const poll = get.intervals.at(-1);
  const adapterHost = get('sb-adapters');
  const lineHost = get('sb-lines');
  const liveAdapter = adapterHost.children[0];
  assert.match(liveAdapter.className, /is-live/);

  active = [];
  sampledAt += 1000;
  browserNow += 1000;
  const firstFinishedAt = new Date(sampledAt).toISOString();
  retained = [{ ...request, finishedAt: firstFinishedAt }];
  await poll();
  assert.equal(adapterHost.children[0], liveAdapter);
  assert.match(findByClass(liveAdapter, 'sb-path').className, /is-waiting/, '前 5 秒仍由原拓扑租约表达等待态');

  sampledAt += 5000;
  browserNow += 5000;
  await poll();
  assert.equal(adapterHost.children[0], liveAdapter);
  assert.match(findByClass(liveAdapter, 'sb-path').className, /is-idle/, '超过 5 秒变为静态空闲态');
  assert.match(lineHost.children[0].className, /is-retained/, '提供商线标记为 retained 态');

  sampledAt += 300000;
  browserNow += 300000;
  retained = [];
  await poll();
  assert.equal(adapterHost.children.length, 0, '超过 5 分钟且无流量后过期移除');

  get('sb-upstream-toggle').listeners.get('click')();
  assert.equal(adapterHost.children.length, 2, '开启全部后展示配置的全部 adapter');
  assert.ok(adapterHost.children.every((child) => child.className.includes('is-configured-only')));
});

test('request elapsed display is monotonic for one ID but starts fresh for the next step', async () => {
  let now = Date.parse('2026-09-28T00:00:00Z');
  class Clock extends Date { static now() { return now; } }
  let request = { requestId: 'one', provider: 'relay', model: 'actual', elapsedMs: 1000 };
  const get = await renderPage(async () => ({ ok: true, status: 200, json: async () => ({
    sampledAt: new Date(now).toISOString(), online: true, activeRequests: 1,
    gateway: { online: true, activeRequests: 1 }, total: {}, providers: [], providerNames: [],
    models: [], recent: [], trend: [], inflight: [request], switchboard: [], switchboardActive: [request],
  }) }), Clock);
  const elapsed = () => get('#table-inflight tbody').children[0].children[4].textContent;
  const poll = get.intervals.at(-1);
  now += 1000;
  request = { ...request, elapsedMs: 0 };
  await poll();
  assert.equal(elapsed(), '2.0s');
  now += 1000;
  await poll();
  assert.equal(elapsed(), '3.0s');
  request = { ...request, requestId: 'two', elapsedMs: 100 };
  now += 1000;
  await poll();
  assert.equal(elapsed(), '100ms');
});

test('waiting topology is cleared on instance changes, provider changes and offline samples', async () => {
  let now = Date.parse('2026-09-28T00:00:00Z');
  class Clock extends Date { static now() { return now; } }
  const request = { requestId: 'one', provider: 'relay', model: 'actual', clientType: 'codex',
    inputProtocol: 'responses', upstreamProtocol: 'responses', adapter: 'direct', elapsedMs: 1000 };
  let active = [request];
  let instanceId = 'first';
  let online = true;
  const get = await renderPage(async () => ({ ok: true, status: 200, json: async () => ({
    sampledAt: new Date(now).toISOString(), instanceId, online, activeRequests: active.length,
    gateway: { online, instanceId, activeRequests: active.length }, total: {}, providers: [], providerNames: [],
    models: [], recent: [], trend: [], inflight: active, switchboard: [], switchboardActive: active,
    switchboardConfigured: [request],
  }) }), Clock);
  const poll = get.intervals.at(-1);
  active = [];
  instanceId = 'second';
  now += 1000;
  await poll();
  assert.equal(get('sb-adapters').children.length, 0);
  active = [request];
  now += 1000;
  await poll();
  active = [];
  now += 1000;
  get('filter-provider').listeners.get('change')({ target: { value: 'other' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(get('sb-adapters').children.length, 0);
  active = [request];
  now += 1000;
  await poll();
  online = false;
  active = [];
  now += 1000;
  await poll();
  assert.equal(get('sb-adapters').children.length, 0);
  assert.equal(get('inflight-count').textContent, 0);
});

test('older live samples cannot revive a request already completed in overview', async () => {
  const request = { requestId: 'finished', provider: 'relay', model: 'actual', elapsedMs: 1000 };
  const get = await renderPage(async (url) => ({ ok: true, status: 200, json: async () => ({
    sampledAt: url.startsWith('/api/switchboard/live') ? '2026-09-28T00:00:01Z' : '2026-09-28T00:00:02Z',
    generatedAt: '2026-09-28T00:00:03Z', online: true,
    activeRequests: url.startsWith('/api/switchboard/live') ? 1 : 0,
    gateway: { online: true, activeRequests: 0 }, total: {}, providers: [], providerNames: [],
    models: [], recent: [], trend: [], inflight: url.startsWith('/api/switchboard/live') ? [request] : [], switchboard: [],
    switchboardActive: url.startsWith('/api/switchboard/live') ? [request] : [],
  }) }));
  await get.intervals.at(-1)();
  assert.equal(get('inflight-count').textContent, 0);
  assert.equal(get('btn-open-restart').disabled, false, 'stale live counts must not replace overview');
});

test('overview refresh keeps waiting topology and live errors do not revive completed requests', async () => {
  let now = Date.parse('2026-09-28T00:00:00Z');
  class Clock extends Date { static now() { return now; } }
  const request = { requestId: 'one', provider: 'relay', model: 'actual', clientType: 'codex',
    inputProtocol: 'responses', upstreamProtocol: 'responses', adapter: 'direct', elapsedMs: 1000 };
  let active = [request];
  let failLive = false;
  const get = await renderPage(async (url) => {
    if (failLive && url.startsWith('/api/switchboard/live')) throw new Error('network');
    return { ok: true, status: 200, json: async () => ({
      sampledAt: new Date(now).toISOString(), online: true, activeRequests: active.length,
      gateway: { online: true, activeRequests: active.length }, total: {}, providers: [], providerNames: [],
      models: [], recent: [], trend: [], inflight: active, switchboard: [], switchboardActive: active,
      switchboardConfigured: [request],
    }) };
  }, Clock);
  await get.intervals.at(-1)();
  const adapter = get('sb-adapters').children[0];
  active = [];
  now += 1000;
  get.intervals.at(-2)();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(get('inflight-count').textContent, 0);
  assert.equal(get('sb-adapters').children[0], adapter, 'overview must use the same waiting topology as live');
  failLive = true;
  await get.intervals.at(-1)();
  assert.equal(get('inflight-count').textContent, 0, 'network error must not resurrect the old live request');
});

test('theme and sidebar controls update attributes and persist preferences', async () => {
  const get = await renderPage({
    ok: true, status: 200,
    json: async () => ({ gateway: { online: true }, total: {}, providerNames: [], trend: [], inflight: [], providers: [], models: [], recent: [] }),
  });
  assert.equal(get.document.documentElement['data-theme'], 'light');
  assert.equal(get('theme-text').textContent, '跟随系统');
  get('btn-theme').listeners.get('click')();
  assert.equal(get.document.documentElement['data-theme'], 'light');
  assert.equal(get('theme-text').textContent, '浅色');
  get('btn-theme').listeners.get('click')();
  assert.equal(get.document.documentElement['data-theme'], 'dark');
  assert.equal(get('icon-theme').href, '#icon-moon');
  assert.equal(get.preferences.get('gateway-admin-theme'), 'dark');
  get('btn-collapse-sidebar').listeners.get('click')();
  assert.equal(get.document.body.classList.contains('sidebar-collapsed'), true);
  assert.equal(get('btn-collapse-sidebar')['aria-expanded'], 'false');
  assert.equal(get.preferences.get('gateway-admin-sidebar'), 'collapsed');
  get('btn-collapse-sidebar').listeners.get('click')();
  assert.equal(get('btn-collapse-sidebar')['aria-expanded'], 'true');
});

test('log follow highlights only newly arrived lines in the current filter', async () => {
  let lines = ['first', 'second'];
  const get = await renderPage(async (url) => ({
    ok: true, status: 200,
    json: async () => url.startsWith('/api/logs') ? { lines, truncated: false } :
      { gateway: { online: true }, total: {}, providerNames: [], trend: [], inflight: [], providers: [], models: [], recent: [] },
  }));
  get('tab-logs').listeners.get('click')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(get('logs-terminal').children.every((line) => !line.className.includes('log-line-new')));
  lines = ['first', 'second', 'third'];
  get('btn-refresh-logs').listeners.get('click')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(get('logs-terminal').children[2].className.includes('log-line-new'));
  assert.ok(!get('logs-terminal').children[1].className.includes('log-line-new'));
});

function renderedText(node) {
  return (node.textContent || '') + (node.children || []).map(renderedText).join('');
}

test('request log uses semantic colors without changing its text or interpreting HTML', async () => {
  const lines = [
    '[2026-09-26 23:51:36.073] [gw_1234] → responses gemini ⇒ gemini-flash ▼(·)▼ @site · direct · 输入≈2.6k',
    '[2026-09-26 23:51:40.073] [gw_1234] ← responses gemini ⇒ gemini-flash ▼(·)▼ · 200 · 4.9s · 836.6KB · 输入 2.6k · 缓存读 32.5k · 输出 40 · 费用 $0.004528',
    '[2026-09-26 23:51:42.073] [gw_5678] ✗ responses model ~(`)>< · HTTP 500 · <img src=x onerror=alert(1)>',
    '[2026-09-26 23:51:43.073] [gw_5678] ↻ responses model · 重试上游',
    '[2026-09-26 23:51:44.073] [gw_5678] ⊘ responses model · 已取消',
    'ordinary system message',
    '',
  ];
  const get = await renderPage(async (url) => ({
    ok: true, status: 200,
    json: async () => url.startsWith('/api/logs') ? { lines, truncated: false } :
      { gateway: { online: true }, total: {}, providerNames: [], trend: [], inflight: [], providers: [], models: [], recent: [] },
  }));
  get('tab-logs').listeners.get('click')();
  await new Promise((resolve) => setImmediate(resolve));
  const rows = get('logs-terminal').children;
  assert.equal(rows.length, lines.length);
  assert.deepEqual(rows.map(renderedText), lines);
  assert.match(rows[0].className, /log-line-start/);
  assert.ok(rows[0].children.some((child) => child.className === 'log-model'));
  assert.ok(rows[1].children.some((child) => child.className === 'log-cache'));
  assert.ok(rows[1].children.some((child) => child.className === 'log-cost'));
  assert.ok(rows[1].children.some((child) => child.textContent === '836.6KB' && child.className === 'log-detail'));
  assert.match(rows[2].className, /log-line-error/);
  assert.ok(rows[2].children.some((child) => child.className === 'log-client-deepseek'));
  assert.match(rows[3].className, /log-line-warning/);
  assert.match(rows[4].className, /log-line-cancel/);
  assert.equal(rows[5].className, 'log-line log-line-system');
  assert.equal(rows[2].children.some((child) => child.tagName === 'IMG'), false);
});

test('settings are read-only by default, edit only on demand, cancel dirty changes and save', async () => {
  let puts = 0;
  const settings = {
    revision: 1, logRequests: false, defaultRoute: 'main',
    providers: [{ name: 'site-a', apiType: 'openai', baseUrl: 'https://example.com',
      hasApiKey: true, models: { 'alias': 'actual-model' },
      priceMultipliers: { '*': { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } } }],
    routes: [{ alias: 'main', provider: 'site-a', model: 'alias', clientProfile: 'auto' }],
  };
  const get = await renderPage(async (url, options = {}) => ({
    ok: true, status: 200,
    json: async () => {
      if (url === '/api/settings' && options.method === 'PUT') {
        puts++;
        Object.assign(settings, JSON.parse(options.body), { revision: settings.revision + 1 });


        return { revision: settings.revision };
      }
      return url === '/api/settings' ? settings :
        { gateway: { online: true }, total: {}, providerNames: [], trend: [], inflight: [], providers: [], models: [], recent: [] };
    },
  }));
  get('tab-settings').listeners.get('click')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(get('settings-readonly').classList.contains('hidden'), false);
  assert.equal(get('settings-editor').classList.contains('hidden'), true);
  assert.equal(get('settings-provider-count').textContent, '1');
  assert.equal(get('settings-default-route').textContent, 'main');
  const provider = get('settings-providers-readonly').children[0];
  assert.match(renderedText(provider), /已配置/);
  assert.doesNotMatch(renderedText(provider), /secret-key/);

  get('btn-edit-settings').listeners.get('click')();
  assert.equal(get('settings-editor').classList.contains('hidden'), false);
  const multiplierPanel = findByClass(get('providers-list'), 'provider-multipliers');
  multiplierPanel.open = true;
  multiplierPanel.listeners.get('toggle')();
  get('btn-cancel-settings').listeners.get('click')();
  assert.equal(get('modal-unsaved').classList.contains('hidden'), true, '展开倍率配置不是未保存修改');
  get('btn-edit-settings').listeners.get('click')();
  const commonMultiplier = findByClass(get('providers-list'), 'multiplier-common-input');
  assert.ok(commonMultiplier, '倍率表应提供统一倍率输入框');
  commonMultiplier.value = '0.3';
  commonMultiplier.listeners.get('input')({ target: commonMultiplier });
  const multiplierRow = findContainerWithClass(get('providers-list'), 'multiplier-common-input');
  assert.deepEqual(
    (multiplierRow?.children || []).slice(2, 6).map((cell) => cell.children[0]?.value),
    ['0.3', '0.3', '0.3', '0.3'],
  );
  get('setting-log-requests').checked = true;
  get('setting-log-requests').listeners.get('change')({ target: get('setting-log-requests') });
  get('btn-cancel-settings').listeners.get('click')();
  assert.equal(get('modal-unsaved').classList.contains('hidden'), false);
  get('btn-unsaved-stay').listeners.get('click')();
  assert.equal(get('settings-editor').classList.contains('hidden'), false);
  get('btn-cancel-settings').listeners.get('click')();
  get('btn-unsaved-discard').listeners.get('click')();
  assert.equal(get('settings-readonly').classList.contains('hidden'), false);
  assert.equal(get('settings-log-requests').textContent, '已关闭');

  get('btn-edit-settings').listeners.get('click')();
  get('setting-log-requests').checked = true;
  get('setting-log-requests').listeners.get('change')({ target: get('setting-log-requests') });
  get('btn-save-settings').listeners.get('click')();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(puts, 1);
  assert.equal(get('settings-editor').classList.contains('hidden'), true);
  assert.equal(get('settings-log-requests').textContent, '已开启');
});

test('settings save feedback distinguishes unconfirmed reload and legacy partial reload', async () => {
  let reloadApplied = false;
  let restartRequired = false;
  let reloadError = 'daemon busy';
  const settings = {
    revision: 1, logRequests: false, defaultRoute: 'main',
    providers: [{ name: 'p1', apiType: 'openai', baseUrl: 'http://localhost', hasApiKey: true }],
    routes: [{ alias: 'main', provider: 'p1', model: 'm1', clientProfile: 'auto' }],
  };
  const get = await renderPage(async (url, options = {}) => {
    if (url === '/api/settings' && options.method === 'PUT') {
      return { ok: true, status: 200, json: async () => ({ revision: 2, reloadApplied, restartRequired, reloadError }) };
    }
    return { ok: true, status: 200, json: async () => url === '/api/settings' ? settings : ({ gateway: { online: true }, total: {}, providerNames: [], trend: [], inflight: [], providers: [], models: [], recent: [] }) };
  });

  get('tab-settings').listeners.get('click')();
  await new Promise((resolve) => setImmediate(resolve));
  get('btn-edit-settings').listeners.get('click')();
  get('settings-editor').listeners.get('input')();
  get('btn-save-settings').listeners.get('click')();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(get('restart-badge').classList.contains('hidden'), false);

  reloadApplied = true;
  restartRequired = true;
  get('btn-edit-settings').listeners.get('click')();
  get('settings-editor').listeners.get('input')();
  get('btn-save-settings').listeners.get('click')();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(get('restart-badge').classList.contains('hidden'), false);

  reloadApplied = true;
  restartRequired = false;
  get('btn-edit-settings').listeners.get('click')();
  get('settings-editor').listeners.get('input')();
  get('btn-save-settings').listeners.get('click')();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(get('restart-badge').classList.contains('hidden'), true);
});

test('expanded cost details survive refresh and auto-refresh can be paused', async () => {
  let fetches = 0;
  const get = await renderPage(async (url) => {
    if (url !== '/api/session') fetches++;
    return {
      ok: true, status: 200,
      json: async () => ({
        gateway: { online: true }, total: { baseCostUsd: 0.001, costUsd: 0.002 }, providerNames: [], trend: [], inflight: [],
        providers: [{ name: 'site-a', baseCostUsd: 0.001, costUsd: 0.002 }], models: [],
        recent: [{ requestId: 'req-1', time: '2026-09-26T12:00:00.000Z', baseCostUsd: 0.001, costUsd: 0.002 }],
      }),
    };
  });
  const details = () => get('#table-recent tbody').children[0].children[8].children[0];
  assert.equal(details().open, false);
  details().open = true;
  details().listeners.get('toggle')();
  const poll = get.intervals.at(-1);
  poll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetches, 2);
  assert.equal(details().open, true, '自动刷新后已展开的金额明细保持展开');
  const provider = get('#table-providers tbody').children[0].children[7].children[0].children[0];
  assert.equal(provider.open, false, '其它金额明细不受影响');

  get('btn-auto-refresh').listeners.get('click')();
  assert.equal(get('btn-auto-refresh')['aria-pressed'], 'false');
  assert.equal(get('icon-auto-refresh').href, '#icon-play');
  assert.equal(get('auto-refresh-state').textContent, '已暂停自动刷新');
  assert.equal(get.preferences.get('gateway-admin-auto-refresh'), 'off');
  poll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetches, 2, '暂停后轮询不再拉取');
  get('btn-auto-refresh').listeners.get('click')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetches, 3, '恢复时立即补一次刷新');
  assert.equal(get('btn-auto-refresh')['aria-pressed'], 'true');
});

test('settings items can be edited or added in place and the editor jumps to them', async () => {
  let body = null;
  const settings = {
    revision: 1, logRequests: false, defaultRoute: 'main',
    providers: [{ name: 'site-a', apiType: 'openai', baseUrl: 'https://example.com', hasApiKey: true, models: {} }],
    routes: [
      { alias: 'main', provider: 'site-a', model: 'm1', clientProfile: 'auto' },
      { alias: 'fast', provider: 'site-a', model: 'm2', clientProfile: 'auto' },
    ],
  };
  const get = await renderPage(async (url, options = {}) => ({
    ok: true, status: 200,
    json: async () => {
      if (url === '/api/settings' && options.method === 'PUT') {
        body = JSON.parse(options.body);
        return { revision: 2 };
      }
      return url === '/api/settings' ? settings :
        { gateway: { online: true }, total: {}, providerNames: [], trend: [], inflight: [], providers: [], models: [], recent: [] };
    },
  }));
  get('tab-settings').listeners.get('click')();
  await new Promise((resolve) => setImmediate(resolve));

  // 只读视图中第二条路由旁的“编辑”：直接进入编辑并定位到该行
  const target = element();
  target['data-settings-open'] = 'route:1';
  get('settings-readonly').listeners.get('click')({ target: { closest: () => target }, preventDefault() {} });
  assert.equal(get('settings-editor').classList.contains('hidden'), false);
  let rows = get('routes-tbody').children;
  assert.equal(rows.length, 2);
  assert.equal(rows[1].classList.contains('is-flash'), true);
  assert.equal(rows[0].classList.contains('is-flash'), false);
  assert.equal(get('settings-dirty-text').textContent, '尚未修改');

  // 分区末尾的“添加路由”：新行追加并获得焦点
  const add = element();
  add['data-add'] = 'route';
  get('settings-editor').listeners.get('click')({ target: { closest: () => add } });
  rows = get('routes-tbody').children;
  assert.equal(rows.length, 3);
  assert.equal(rows[2].classList.contains('is-flash'), true);
  assert.ok(findByClass(rows[2], 'form-input')?.focused || rows[2].children[0].children[0].focused, '新路由的首个输入框获得焦点');
  get('settings-editor').listeners.get('input')();
  assert.equal(get('settings-dirty-text').textContent, '有未保存的修改');
  assert.equal(get('settings-editor-bar').classList.contains('is-dirty'), true);

  // 搜索只保留命中的条目
  get('settings-filter').value = 'fast';
  get('settings-filter').listeners.get('input')({ stopPropagation() {} });
  rows = get('routes-tbody').children;
  assert.equal(rows[0].classList.contains('is-filtered-out'), true);
  assert.equal(rows[1].classList.contains('is-filtered-out'), false);

  // 界面状态字段（如展开状态 _open）不会提交到服务端
  const alias = rows[2].children[0].children[0];
  alias.value = 'new-alias';
  alias.listeners.get('input')({ target: alias });
  get('settings-filter').value = '';
  get('settings-filter').listeners.get('input')({ stopPropagation() {} });
  target['data-settings-open'] = 'provider:0';
  get('settings-readonly').listeners.get('click')({ target: { closest: () => target }, preventDefault() {} });
  get('btn-save-settings').listeners.get('click')();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(body, '保存时提交了设置');
  assert.deepEqual(body.routes.map((route) => route.alias), ['main', 'fast', 'new-alias']);
  assert.ok(body.providers.every((provider) => Object.keys(provider).every((key) => !key.startsWith('_'))));
});


test('clear logs button confirms then POSTs /api/logs/clear and refreshes', async () => {
  let cleared = false;
  let fetchedLogs = false;
  const get = await renderPage(async (url, options = {}) => {
    if (url === '/api/logs/clear' && options.method === 'POST') {
      cleared = true;
      return { ok: true, status: 200, json: async () => ({ ok: true, cleared: [{ bytes: 2048 }] }) };
    }
    if (String(url).startsWith('/api/logs')) {
      fetchedLogs = true;
      return { ok: true, status: 200, json: async () => ({ lines: [], truncated: false }) };
    }
    return { ok: true, status: 200, json: async () => ({ gateway: { online: true }, total: {}, providerNames: [], trend: [], inflight: [], providers: [], models: [], recent: [] }) };
  });

  get('tab-logs').listeners.get('click')();
  await new Promise((resolve) => setImmediate(resolve));
  get('btn-clear-logs').listeners.get('click')();
  assert.equal(get('modal-clear-logs').classList.contains('hidden'), false);

  get('btn-confirm-clear-logs').listeners.get('click')();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleared, true);
  assert.equal(fetchedLogs, true);
  assert.equal(get('modal-clear-logs').classList.contains('hidden'), true);
});

test('clear logs failure keeps the dialog open and shows the error banner', async () => {
  const get = await renderPage(async (url, options = {}) => {
    if (url === '/api/logs/clear' && options.method === 'POST') {
      return { ok: false, status: 500, json: async () => ({ error: '磁盘只读' }) };
    }
    return { ok: true, status: 200, json: async () => ({ gateway: { online: true }, total: {}, providerNames: [], trend: [], inflight: [], providers: [], models: [], recent: [] }) };
  });

  get('tab-logs').listeners.get('click')();
  await new Promise((resolve) => setImmediate(resolve));
  get('btn-clear-logs').listeners.get('click')();
  get('btn-confirm-clear-logs').listeners.get('click')();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(get('modal-clear-logs').classList.contains('hidden'), false);
  assert.equal(get('clear-logs-error-msg').classList.contains('hidden'), false);
  assert.match(get('clear-logs-error-msg').textContent, /磁盘只读/);
});

test('subagents tab switches view and fetches claude agent configuration', async () => {
  const calls = [];
  const get = await renderPage(async (url, options = {}) => {
    calls.push([options.method || 'GET', String(url)]);
    if (url.startsWith('/api/subagents?tool=claude')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          tool: 'claude',
          root: 'C:/Users/test/.claude/agents',
          agents: [
            { id: 'explore', name: 'Explore', description: '探索代码', model: 'fast', effort: null, tools: 'Read, Grep', sandbox: null, prompt: '原提示词', source: 'override', file: 'Explore.md', editable: true, revision: 'rev-1' }
          ],
          defaults: { model: 'fast', effort: null, revision: 'def-1', file: 'settings.json' },
          warnings: ['警告示例'],
          models: [
            { id: 'fast', provider: 'openai', targetModel: 'gpt-4o-mini', available: true, status: 'ok' }
          ]
        })
      };
    }
    return {
      ok: true, status: 200,
      json: async () => ({ gateway: { online: true }, total: {}, providerNames: [], trend: [], inflight: [], providers: [], models: [], recent: [] })
    };
  });
  get('tab-subagents').listeners.get('click')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(get('view-subagents').classList.contains('hidden'), false, '子代理视图显示');
  assert.equal(get('view-overview').classList.contains('hidden'), true, '概览隐藏');
  assert.ok(calls.some(([m, u]) => m === 'GET' && u.includes('/api/subagents?tool=claude')), '发起 claude 子代理配置请求');
  assert.equal(get('subagents-board').children.length, 1);
  assert.equal(get('sa-field-name').value, 'Explore');
  assert.equal(get('sa-editor-form').classList.contains('hidden'), false);
  assert.equal(get('subagents-warning-banner').classList.contains('hidden'), false);
});

test('subagents select and save unchecked or failed models without probing', async () => {
  for (const tool of ['claude', 'codex']) {
    const calls = [];
    const data = {
      tool, root: '/agents', warnings: [],
      agents: [{ id: 'custom', name: 'custom', description: 'Work', prompt: 'Work',
        model: null, effort: null, sandbox: null, tools: null, source: 'custom', editable: true, revision: 'rev-1' }],
      defaults: { model: null, effort: null, revision: 'def-1' },
      models: [
        { id: 'fresh', provider: 'relay', targetModel: 'fresh-model', available: true, status: 'unchecked' },
        { id: 'failed', provider: 'relay', targetModel: 'failed-model', available: true, status: 'failed', checkReason: 'HTTP 503' },
        { id: 'broken', provider: 'relay', targetModel: 'broken-model', available: false, status: 'unchecked', reason: 'Missing key' },
      ],
    };
    const get = await renderPage(async (url, options = {}) => {
      if (url.startsWith('/api/subagents')) {
        calls.push([options.method || 'GET', String(url), options.body]);
        if (options.method === 'PUT') {
          const body = JSON.parse(options.body);
          if (url.endsWith('/defaults')) data.defaults = { ...data.defaults, ...body };
          else data.agents[0] = { ...data.agents[0], ...body };
        }
        return { ok: true, status: 200, json: async () => data };
      }
      return { ok: true, status: 200, json: async () => ({ gateway: { online: true }, total: {}, providers: [], models: [], recent: [], trend: [] }) };
    });
    get('tab-subagents').listeners.get('click')();
    await new Promise(resolve => setImmediate(resolve));
    if (tool === 'codex') {
      get('tool-codex').listeners.get('click')();
      await new Promise(resolve => setImmediate(resolve));
    }
    for (const id of ['sa-field-model', 'subagents-cab-default-select']) {
      const choices = get(id).children;
      assert.equal(choices.find(option => option.value === 'fresh').disabled, false);
      assert.equal(choices.find(option => option.value === 'failed').disabled, false);
      assert.equal(choices.find(option => option.value === 'broken').disabled, true);
    }
    get('sa-field-model').value = 'fresh';
    get('sa-field-model').listeners.get('change')();
    get('btn-subagent-save').listeners.get('click')();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(data.agents[0].model, 'fresh');
    get('subagents-cab-default-select').listeners.get('change')({ target: { value: 'failed' } });
    get('btn-save-defaults').listeners.get('click')();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(data.defaults.model, 'failed');
    assert.equal(calls.filter(([method]) => method === 'PUT').length, 2);
    assert.ok(!calls.some(([, url]) => url.endsWith('/check-models')));
  }
});

test('subagents inspector edits drafts, switches tools, and confirms restore and privilege escalation', async () => {
  const calls = [];
  const get = await renderPage(async (url, options = {}) => {
    calls.push([options.method || 'GET', String(url)]);
    if (url.startsWith('/api/subagents?tool=claude')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          tool: 'claude',
          root: 'C:/Users/test/.claude/agents',
          agents: [
            { id: 'explore', name: 'Explore', description: '探索代码', model: 'fast', effort: null, tools: 'Read, Grep', sandbox: null, prompt: '原提示词', source: 'override', file: 'Explore.md', editable: true, revision: 'rev-1' }
          ],
          defaults: { model: 'fast', effort: null, revision: 'def-1', file: 'settings.json' },
          warnings: [],
          models: [
            { id: 'fast', provider: 'openai', targetModel: 'gpt-4o-mini', available: true, status: 'ok' }
          ]
        })
      };
    }
    if (url.startsWith('/api/subagents?tool=codex')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          tool: 'codex',
          root: 'C:/Users/test/.codex/agents',
          agents: [
            { id: 'worker', name: 'Worker', description: '执行任务', model: 'fast', effort: 'high', tools: null, sandbox: 'workspace-write', prompt: '执行提示词', source: 'override', file: 'worker.toml', editable: true, revision: 'rev-c1' }
          ],
          defaults: { model: 'fast', effort: 'medium', revision: 'def-c1', file: 'config.toml' },
          warnings: [],
          models: [
            { id: 'fast', provider: 'openai', targetModel: 'gpt-4o-mini', available: true, status: 'ok' }
          ]
        })
      };
    }
    return {
      ok: true, status: 200,
      json: async () => ({ gateway: { online: true }, total: {}, providerNames: [], trend: [], inflight: [], providers: [], models: [], recent: [] })
    };
  });

  // 1. 进入子代理页面
  get('tab-subagents').listeners.get('click')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(get('subagents-save-state-text').textContent, '配置已读取');
  get('sa-field-description').value = 'Edited draft';
  get('sa-field-description').listeners.get('input')();
  assert.equal(get('btn-subagent-save').disabled, false);
  assert.equal(get('subagents-save-state-text').textContent, '有未保存修改');
  get('btn-subagent-cancel').listeners.get('click')();
  assert.equal(get('sa-field-description').value, '探索代码');
  get('btn-mode-builtin').listeners.get('click')();
  assert.equal(get('modal-subagents-reset').classList.contains('hidden'), false);
  get('btn-subagents-reset-cancel').listeners.get('click')();

  // 2. 切换到 codex
  get('tool-codex').listeners.get('click')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(get('subagents-cab-effort-wrap').hidden, false, 'Codex 展示默认力度选项');
  get('sa-field-sandbox').value = 'danger-full-access';
  get('sa-field-sandbox').listeners.get('change')();
  get('btn-subagent-save').listeners.get('click')();
  assert.equal(get('modal-subagents-privilege').classList.contains('hidden'), false);
  assert.ok(!calls.some(([method]) => method === 'PUT'));
  get('btn-subagents-privilege-cancel').listeners.get('click')();
  get('btn-subagent-cancel').listeners.get('click')();

  // 3. 修改全局默认模型产生草稿
  get('subagents-cab-default-select').value = '';
  get('subagents-cab-default-select').listeners.get('change')({ target: { value: '' } });
  assert.equal(get('btn-save-defaults').disabled, false, '修改默认模型后保存默认按钮变为可用');
  assert.equal(get('subagents-save-state-text').textContent, '有未保存修改', '状态显示有未保存修改');
  assert.equal(get('btn-check-models').disabled, true);
  get('subagents-cab-default-select').listeners.get('change')({ target: { value: 'fast' } });

  // 4. 打开弹窗检测模型
  get('btn-check-models').listeners.get('click')();
  assert.equal(get('modal-subagents-check').classList.contains('hidden'), false, '弹出费用提示确认弹窗');
  get('btn-subagents-check-cancel').listeners.get('click')();
  assert.equal(get('modal-subagents-check').classList.contains('hidden'), true, '取消关闭弹窗');
});


function getAllWireGroups(get) {
  const outer = get('sb-wires').children[0]?.children || [];
  const inner = get('sb-internal-wires').children[0]?.children || [];
  return [...outer, ...inner];
}

function findWireGroupsByStage(get, stage) {
  const groups = getAllWireGroups(get);
  const prefixMap = {
    source: 'in ',
    ingress: 'internal-in ',
    egress: 'internal-out ',
    upstream: 'out ',
  };
  const prefix = prefixMap[stage] || stage;
  return groups.filter((g) => {
    const stageAttr = g.getAttribute('data-flow-stage');
    const key = g.getAttribute('data-edge-key') || '';
    if (key.includes('idle')) return false;
    if (stageAttr && stageAttr !== 'idle') return stageAttr === stage;
    return key.startsWith(prefix);
  });
}

function isPacketVisible(flowPath) {
  if (!flowPath) return false;
  const vis = flowPath.style?.visibility || flowPath.getAttribute('visibility') || '';
  if (vis === 'hidden') return false;
  const dash = flowPath.style?.['stroke-dasharray'] || flowPath.style?.strokeDasharray || flowPath.getAttribute('stroke-dasharray') || '';
  if (!dash || dash === 'none' || dash.startsWith('0 1000000')) return false;
  return true;
}

function stageHasVisiblePacket(get, stage, agentFilter = null) {
  const groups = findWireGroupsByStage(get, stage);
  return groups.some((g) => {
    const flows = g.children.slice(1);
    return flows.some((f) => {
      if (agentFilter) {
        const agent = f.dataset?.flowAgent || f.getAttribute('data-flow-agent');
        if (agent !== agentFilter) return false;
      }
      return isPacketVisible(f);
    });
  });
}

test('switchboard packet animation propagates along full link in sequential stages (source -> ingress -> egress -> upstream)', async () => {
  const request = {
    requestId: 'req-packet-1', route: 'main', provider: 'relay', model: 'actual',
    clientType: 'codex', inputProtocol: 'responses', upstreamProtocol: 'responses', adapter: 'direct', elapsedMs: 100
  };
  const configured = [{ ...request }];
  const active = [request];

  const get = await renderPage(async () => ({
    ok: true, status: 200, json: async () => ({
      online: true, activeRequests: active.length,
      gateway: { online: true, activeRequests: active.length },
      total: {}, providers: [], providerNames: ['relay'], models: [], recent: [], trend: [], switchboard: [],
      inflight: active, switchboardActive: active, switchboardRetained: [], switchboardConfigured: configured,
    })
  }), Date, { raf: true, initialPerfTime: 0 });

  const groups = getAllWireGroups(get);
  assert.ok(groups.length >= 4);
  for (const group of groups) {
    assert.ok(group.getAttribute('data-edge-key'));
    assert.match(group.children[0]?.className || '', /sb-wire/);
    for (const flow of group.children.slice(1)) {
      assert.match(flow.className || '', /sb-flow/);
      assert.ok(flow.dataset?.flowAgent || flow.getAttribute('data-flow-agent'));
      const offset = flow.getAttribute('stroke-dashoffset') ?? flow.style?.['stroke-dashoffset'] ?? flow.style?.strokeDashoffset;
      assert.equal(String(offset), '0');
    }
  }

  assert.equal(stageHasVisiblePacket(get, 'source'), false);
  assert.equal(stageHasVisiblePacket(get, 'ingress'), false);
  assert.equal(stageHasVisiblePacket(get, 'egress'), false);
  assert.equal(stageHasVisiblePacket(get, 'upstream'), false);

  get.stepRaf(200);
  assert.equal(stageHasVisiblePacket(get, 'source'), true);
  assert.equal(stageHasVisiblePacket(get, 'ingress'), false);
  assert.equal(stageHasVisiblePacket(get, 'egress'), false);
  assert.equal(stageHasVisiblePacket(get, 'upstream'), false);

  const sourceFlow = findWireGroupsByStage(get, 'source')[0].children[1];
  const dashStr = sourceFlow.style['stroke-dasharray'];
  const dashes = dashStr.split(/\s+/).map(Number);
  const trailingGap = dashes[dashes.length - 1];
  assert.ok(trailingGap >= 100);

  get.stepRaf(300); // 500ms
  assert.equal(stageHasVisiblePacket(get, 'ingress'), true);
  assert.equal(stageHasVisiblePacket(get, 'egress'), false);
  assert.equal(stageHasVisiblePacket(get, 'upstream'), false);

  get.stepRaf(400); // 900ms
  assert.equal(stageHasVisiblePacket(get, 'egress'), true);
  assert.equal(stageHasVisiblePacket(get, 'upstream'), false);

  get.stepRaf(400); // 1300ms
  assert.equal(stageHasVisiblePacket(get, 'upstream'), true);
});

test('switchboard packet timeline is preserved across same-id polling and resize, and restarts from source for new request id', async () => {
  let active = [{
    requestId: 'req-same-1', route: 'main', provider: 'relay', model: 'actual',
    clientType: 'codex', inputProtocol: 'responses', upstreamProtocol: 'responses', adapter: 'direct', elapsedMs: 100
  }];
  const configured = [{ ...active[0] }];

  const get = await renderPage(async () => ({
    ok: true, status: 200, json: async () => ({
      online: true, activeRequests: active.length,
      gateway: { online: true, activeRequests: active.length },
      total: {}, providers: [], providerNames: ['relay'], models: [], recent: [], trend: [], switchboard: [],
      inflight: active, switchboardActive: active, switchboardRetained: [], switchboardConfigured: configured,
    })
  }), Date, { raf: true, initialPerfTime: 0 });

  const poll = get.intervals.at(-1);

  get.stepRaf(500);
  assert.equal(stageHasVisiblePacket(get, 'ingress'), true);

  await poll();
  get.stepRaf(16);
  assert.equal(stageHasVisiblePacket(get, 'ingress'), true);

  get.triggerResize();
  get.stepRaf(16);
  assert.equal(stageHasVisiblePacket(get, 'ingress'), true);

  active = [{
    requestId: 'req-fresh-2', route: 'main', provider: 'relay', model: 'actual',
    clientType: 'codex', inputProtocol: 'responses', upstreamProtocol: 'responses', adapter: 'direct', elapsedMs: 50
  }];
  await poll();
  get.stepRaf(0);

  assert.equal(stageHasVisiblePacket(get, 'ingress'), false);
  assert.equal(stageHasVisiblePacket(get, 'egress'), false);
  assert.equal(stageHasVisiblePacket(get, 'upstream'), false);

  get.stepRaf(200);
  assert.equal(stageHasVisiblePacket(get, 'source'), true);
  assert.equal(stageHasVisiblePacket(get, 'upstream'), false);
});

test('switchboard multi-agent flows propagate independently, non-live states remain quiet, filters clear flows, and reduced motion disables raf loop', async () => {
  const reqA = {
    requestId: 'req-agent-a', route: 'route-a', provider: 'p-a', model: 'm-a',
    clientType: 'codex', inputProtocol: 'responses', upstreamProtocol: 'responses', adapter: 'direct', elapsedMs: 200
  };
  const reqB = {
    requestId: 'req-agent-b', route: 'route-b', provider: 'p-b', model: 'm-b',
    clientType: 'claude-code', inputProtocol: 'messages', upstreamProtocol: 'responses', adapter: 'messages-to-responses', elapsedMs: 10
  };
  let active = [reqA];
  let retained = [];
  let online = true;
  let unknown = false;
  let instanceId = 'inst-1';
  let filter = '';
  const configured = [{ ...reqA }, { ...reqB }];

  const get = await renderPage(async (url) => {
    const isLive = String(url).includes('/api/switchboard/live');
    const filteredActive = filter ? active.filter((r) => r.provider === filter) : active;
    const filteredRetained = filter ? retained.filter((r) => r.provider === filter) : retained;
    return {
      ok: true, status: 200, json: async () => ({
        online, instanceId, activeRequests: filteredActive.length, liveUnknown: unknown,
        gateway: { online, instanceId, activeRequests: filteredActive.length },
        total: {}, providers: [], providerNames: ['p-a', 'p-b'], models: [], recent: [], trend: [], switchboard: [],
        inflight: filteredActive, switchboardActive: filteredActive, switchboardRetained: filteredRetained, switchboardConfigured: configured,
      })
    };
  }, Date, { raf: true, initialPerfTime: 0 });

  const poll = get.intervals.at(-1);

  get.stepRaf(500);
  assert.equal(stageHasVisiblePacket(get, 'ingress', 'codex'), true);

  active = [reqA, reqB];
  await poll();

  get.stepRaf(200); // 700ms (reqA has run 700ms, reqB has run 200ms)
  assert.equal(stageHasVisiblePacket(get, 'ingress', 'codex'), true);
  assert.equal(stageHasVisiblePacket(get, 'source', 'claudecode'), true);
  assert.equal(stageHasVisiblePacket(get, 'upstream', 'claudecode'), false);

  active = [];
  retained = [{ ...reqA, finishedAt: new Date().toISOString() }];
  await poll();
  get.stepRaf(100);
  assert.equal(stageHasVisiblePacket(get, 'source'), false);
  assert.equal(stageHasVisiblePacket(get, 'upstream'), false);

  unknown = true;
  await poll();
  get.stepRaf(100);
  assert.equal(stageHasVisiblePacket(get, 'source'), false);

  unknown = false;
  online = false;
  await poll();
  get.stepRaf(100);
  assert.equal(stageHasVisiblePacket(get, 'source'), false);

  online = true;
  active = [reqA];
  await poll();
  get.stepRaf(500);
  assert.equal(stageHasVisiblePacket(get, 'ingress', 'codex'), true);

  filter = 'p-b';
  get('filter-provider').value = 'p-b';
  get('filter-provider').listeners.get('change')({ target: get('filter-provider') });
  await new Promise((resolve) => setImmediate(resolve));
  await poll();
  get.stepRaf(16);
  assert.equal(stageHasVisiblePacket(get, 'ingress', 'codex'), false);

  filter = '';
  get('filter-provider').value = '';
  get('filter-provider').listeners.get('change')({ target: get('filter-provider') });
  await new Promise((resolve) => setImmediate(resolve));
  await poll();
  get.stepRaf(500);
  assert.equal(stageHasVisiblePacket(get, 'ingress', 'codex'), true);

  instanceId = 'inst-2';
  await poll();
  get.stepRaf(0);
  assert.equal(stageHasVisiblePacket(get, 'ingress', 'codex'), false);

  get.stepRaf(500);
  assert.ok(get.rafCallbacks.size > 0);
  get('tab-logs').listeners.get('click')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(get.rafCallbacks.size, 0);

  const getReduced = await renderPage(async () => ({
    ok: true, status: 200, json: async () => ({
      online: true, activeRequests: 1,
      gateway: { online: true, activeRequests: 1 },
      total: {}, providers: [], providerNames: ['p-a'], models: [], recent: [], trend: [], switchboard: [],
      inflight: [reqA], switchboardActive: [reqA], switchboardRetained: [], switchboardConfigured: configured,
    })
  }), Date, { raf: true, reducedMotion: true });

  assert.equal(getReduced.rafCallbacks.size, 0);
});

test('a second request from the same agent creates its own adapter and upstream flow without resetting the first', async () => {
  const reqA = { requestId: 'same-agent-a', route: 'a', provider: 'p-a', model: 'm-a', clientType: 'codex', inputProtocol: 'responses', upstreamProtocol: 'responses', adapter: 'direct' };
  const reqB = { requestId: 'same-agent-b', route: 'b', provider: 'p-b', model: 'm-b', clientType: 'codex', inputProtocol: 'messages', upstreamProtocol: 'chat-completions', adapter: 'messages-to-chat-completions' };
  let active = [reqA];
  const get = await renderPage(async () => ({ ok: true, status: 200, json: async () => ({
    online: true, activeRequests: active.length, switchboardActiveRequests: active.length,
    gateway: { online: true, activeRequests: active.length },
    total: {}, providers: [], providerNames: ['p-a', 'p-b'], models: [], recent: [], trend: [], switchboard: [],
    inflight: active, switchboardActive: active, switchboardConfigured: [reqA, reqB],
  }) }), Date, { raf: true, initialPerfTime: 0 });
  const flow = (key) => getAllWireGroups(get).find((group) => group.getAttribute('data-edge-key') === key)?.children[1];
  const adapterKey = JSON.stringify([reqB.inputProtocol, reqB.upstreamProtocol, reqB.adapter]);
  const upstreamA = 'out ' + JSON.stringify([reqA.provider, reqA.model]);
  const upstreamB = 'out ' + JSON.stringify([reqB.provider, reqB.model]);
  get.stepRaf(1300);
  assert.equal(isPacketVisible(flow(upstreamA)), true);
  active = [reqA, reqB];
  await get.intervals.at(-1)();
  get.stepRaf(200);
  assert.equal(get('sb-active').textContent, '2');
  assert.ok(flow('internal-in ' + adapterKey), 'second adapter must exist');
  assert.ok(flow('internal-out ' + adapterKey), 'second adapter egress must exist');
  assert.ok(flow(upstreamB), 'second upstream must exist');
  assert.equal(isPacketVisible(flow(upstreamA)), true, 'first request clock must not reset');
  assert.equal(isPacketVisible(flow('internal-in ' + adapterKey)), false, 'second request must start at its source');
  assert.equal(isPacketVisible(flow(upstreamB)), false, 'second request must not instantly fill its upstream');
  get.stepRaf(300);
  assert.equal(isPacketVisible(flow('internal-in ' + adapterKey)), true);
  get.stepRaf(400);
  assert.equal(isPacketVisible(flow('internal-out ' + adapterKey)), true);
  assert.equal(isPacketVisible(flow(upstreamB)), false);
  get.stepRaf(400);
  assert.equal(isPacketVisible(flow(upstreamB)), true);
  active = [reqA];
  await get.intervals.at(-1)();
  get.stepRaf(0);
  assert.equal(get('sb-active').textContent, '1');
  assert.equal(isPacketVisible(flow(upstreamA)), true, 'second completion must not remove the first flow');
  assert.equal(isPacketVisible(flow(upstreamB)), false);
});

test('same-agent requests sharing a path retain separate clocks and finish independently', async () => {
  const reqA = { requestId: 'shared-a', route: 'main', provider: 'relay', model: 'actual', clientType: 'codex', inputProtocol: 'responses', upstreamProtocol: 'responses', adapter: 'direct' };
  const reqB = { ...reqA, requestId: 'shared-b' };
  let active = [reqA];
  const snapshot = (requests) => ({ online: true, activeRequests: requests.length, switchboardActiveRequests: requests.length,
    gateway: { online: true, activeRequests: requests.length },
    total: {}, providers: [], providerNames: ['relay'], models: [], recent: [], trend: [], switchboard: [],
    inflight: requests, switchboardActive: requests, switchboardConfigured: [reqA] });
  const get = await renderPage(async () => ({ ok: true, status: 200, json: async () => snapshot(active) }), Date, { raf: true, initialPerfTime: 0 });
  const control = await renderPage({ ok: true, status: 200, json: async () => snapshot([reqA]) }, Date, { raf: true, initialPerfTime: 0 });
  const source = () => findWireGroupsByStage(get, 'source')[0].children[1];
  get.stepRaf(900);
  const sourceNode = source();
  const firstDashes = sourceNode.style['stroke-dasharray'];
  active = [reqA, reqB];
  await get.intervals.at(-1)();
  get.stepRaf(0);
  assert.equal(get('sb-active').textContent, '2');
  assert.equal(source(), sourceNode, 'shared flow should retain DOM identity');
  assert.equal(source().style['stroke-dasharray'], firstDashes, 'adding B must preserve A clock');
  assert.equal(getAllWireGroups(get).filter((group) => group.children.slice(1).some((flow) => flow.dataset?.flowAgent === 'codex')).length, 4, 'same topology uses one active physical path');
  get.stepRaf(200);
  control.stepRaf(1100);
  assert.notEqual(source().style['stroke-dasharray'], findWireGroupsByStage(control, 'source')[0].children[1].style['stroke-dasharray'], 'B must contribute packets at its own phase');
  active = [reqB];
  await get.intervals.at(-1)();
  get.stepRaf(0);
  assert.equal(get('sb-active').textContent, '1');
  assert.equal(stageHasVisiblePacket(get, 'source'), true);
  assert.equal(stageHasVisiblePacket(get, 'ingress'), false, 'completed A packets must disappear');
  assert.equal(stageHasVisiblePacket(get, 'egress'), false);
  get.stepRaf(300);
  assert.equal(stageHasVisiblePacket(get, 'ingress'), true, 'B clock must survive A completion');
  get.stepRaf(800);
  assert.equal(stageHasVisiblePacket(get, 'upstream'), true);
  active = [];
  await get.intervals.at(-1)();
  get.stepRaf(0);
  assert.equal(get('sb-active').textContent, '0');
  assert.equal(stageHasVisiblePacket(get, 'source'), false);
  assert.equal(stageHasVisiblePacket(get, 'upstream'), false);
  assert.equal(get.rafCallbacks.size, 0);
});

test('filtered overview and live counts never enable restart while other providers have HTTP activity', async () => {
  const reqA = { requestId: 'filtered-a', route: 'a', provider: 'p-a', model: 'm-a', clientType: 'codex', inputProtocol: 'responses', upstreamProtocol: 'responses', adapter: 'direct' };
  const reqB = { ...reqA, requestId: 'filtered-b', route: 'b', provider: 'p-b', model: 'm-b' };
  let active = [reqA, reqB];
  const get = await renderPage(async (url) => {
    const provider = new URL(url, 'http://admin.test').searchParams.get('provider');
    const filtered = active.filter((item) => !provider || item.provider === provider);
    return { ok: true, status: 200, json: async () => ({
      online: true, activeRequests: active.length, switchboardActiveRequests: filtered.length,
      gateway: { online: true, activeRequests: active.length },
      total: {}, providers: [], providerNames: ['p-a', 'p-b'], models: [], recent: [], trend: [], switchboard: [],
      inflight: filtered, switchboardActive: filtered, switchboardConfigured: [reqA, reqB].filter((item) => !provider || item.provider === provider),
    }) };
  });
  assert.equal(get('sb-active').textContent, '2');
  get('filter-provider').value = 'p-a';
  get('filter-provider').listeners.get('change')({ target: get('filter-provider') });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(get('sb-active').textContent, '1');
  assert.equal(get('meta-active').textContent, 2);
  assert.equal(get('btn-open-restart').disabled, true);
  await get.intervals.at(-1)();
  assert.equal(get('sb-active').textContent, '1');
  assert.match(get('btn-open-restart').title, /2 个在途请求/);
  active = [reqB];
  await get.intervals.at(-1)();
  assert.equal(get('sb-active').textContent, '0');
  assert.equal(get('btn-open-restart').disabled, true);
  assert.match(get('btn-open-restart').title, /1 个在途请求/);
  get('btn-refresh-overview').listeners.get('click')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(get('sb-active').textContent, '0');
  assert.equal(get('meta-active').textContent, 1);
  assert.equal(get('btn-open-restart').disabled, true);
  active = [];
  await get.intervals.at(-1)();
  assert.equal(get('btn-open-restart').disabled, false);
});

test('apiFetch silently re-bootstraps same-origin session on 401 and retries without showing auth banner', async () => {
  let expiredOnce = false;
  let sessionCalls = 0;
  const get = await renderPage(async (url, options) => {
    if (url === '/api/session') {
      sessionCalls += 1;
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (url.startsWith('/api/overview') && expiredOnce) {
      expiredOnce = false;
      return { ok: false, status: 401, json: async () => ({ error: 'Unauthorized' }) };
    }
    return {
      ok: true, status: 200,
      json: async () => ({
        gateway: { online: true, pid: 4321, uptimeSec: 120, activeRequests: 0 },
        total: {}, providerNames: [], trend: [], inflight: [], providers: [], models: [], recent: [],
      }),
    };
  });
  assert.equal(sessionCalls, 1);
  assert.equal(get('auth-expired-banner').classList.contains('hidden'), true);

  expiredOnce = true;
  get('btn-refresh-overview').listeners.get('click')();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sessionCalls, 2, '401 must trigger a single silent /api/session refresh');
  assert.equal(get('auth-expired-banner').classList.contains('hidden'), true);
  assert.equal(get('gw-status-badge').querySelector('.badge-text').textContent, '网关运行中');
});
