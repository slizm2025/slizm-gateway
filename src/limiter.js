// 上游并发闸门 + 故障退避。
//
// 为什么需要它：
// 部分中转站（尤其 sub2api 这类账号池）给单个用户的并发额度很小。当 Claude Code
// 并行派发多个子 agent 时，请求一拥而上，上游会回 429 / 503 "no available accounts"。
// 此时上游通常**明确给出 `retry-after`**，意思是"等 N 秒再来"。
//
// 网关如果把这个 429 原样甩回 Claude Code，Claude Code 会立即重试（它的默认行为），
// 于是在上游冷却期内反复撞击账号池，把一次几秒的可恢复抖动放大成一分钟的连续失败。
//
// 这里做两件事：
//   1. 信号量：限制同一 provider 的在途请求数，从源头避免打满。
//   2. 退避重试：429 / 503 / 5xx 且尚未向客户端吐字节时，按 retry-after 或指数退避等待后重试。
//      一旦已经写过响应头，就绝不能重试（会破坏已发出的流），只能如实报错。
//
// 重试绝不能造成重复计费：POST /v1/messages 不是幂等的，请求一旦送到上游，上游就可能已在生成并计费。
// 所以只重试两类确定没被处理的失败：
//   - 连接阶段就失败的网络错误（连接被拒、DNS、连接超时）——请求根本没发出去；
//   - 429 / 503 / 529 —— 上游明确表示"没处理，稍后再来"。
// 请求发出后才断连、等响应头超时、502 / 504 一律不重试，如实报给 Claude Code。

import { readResponseText } from './upstream-fetch.js';
import { summarizeError } from './usage.js';

const DEFAULT_MAX_CONCURRENCY = 3;
const DEFAULT_MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 800;
const MAX_DELAY_MS = 20_000;

/** 每个 provider 一个信号量，key = provider.name */
const gates = new Map();

class Gate {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }

  async acquire(signal) {
    signal?.throwIfAborted();
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(signal.reason);
      };
      const waiter = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  release() {
    this.active--;
    this.drain();
  }

  drain() {
    while (this.active < this.limit && this.waiters.length) {
      this.active++;
      this.waiters.shift()();
    }
  }
}

// Retain gates across reloads so old requests cannot reset current admission limits.
export function configureProviderLimits(providers) {
  for (const provider of providers.values()) {
    const gate = gateFor(provider);
    gate.limit = provider.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    gate.drain();
  }
  for (const [name, gate] of gates) {
    if (!providers.has(name) && !gate.active && !gate.waiters.length) gates.delete(name);
  }
}

export function gateFor(provider) {
  const limit = Number(provider.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY) || DEFAULT_MAX_CONCURRENCY;
  let g = gates.get(provider.name);
  if (!g) {
    g = new Gate(limit);
    gates.set(provider.name, g);
  }
  return g;
}

/** 上游是否明确表示"没处理、稍后再来"。502/504 可能发生在上游已开始生成之后，重试会重复计费。 */
export function isRetryableStatus(status) {
  return status === 429 || status === 503 || status === 529;
}

// 连接阶段的失败：请求根本没发到上游，重试不会重复计费。
const SAFE_RETRY_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** fetch 把底层原因包在 cause 里（可能多层，或是 AggregateError），逐层收集错误码 */
function causeCodes(e) {
  const codes = [];
  for (let c = e, depth = 0; c && depth < 5; c = c.cause, depth++) {
    if (typeof c.code === 'string') codes.push(c.code);
    for (const sub of Array.isArray(c.errors) ? c.errors : []) {
      if (typeof sub?.code === 'string') codes.push(sub.code);
    }
  }
  return codes;
}

/** 网络错误的底层错误码，供日志使用；没有时返回 undefined */
export function networkErrorCode(e) {
  return causeCodes(e)[0];
}

/** 网络错误是否发生在连接阶段（请求确定没送到上游） */
export function isSafeToRetryNetworkError(e) {
  // upstream-fetch 标了阶段：代理 CONNECT / TCP 连接 / TLS 握手失败时请求体还没发出
  if (typeof e?.beforeSend === 'boolean') return e.beforeSend;
  const codes = causeCodes(e);
  return codes.length > 0 && codes.every((c) => SAFE_RETRY_CODES.has(c));
}

/**
 * 解析上游给的等待时长。优先 retry-after（秒数或 HTTP 日期），
 * 否则用指数退避 + 抖动，避免多个子 agent 同时醒来再次撞车。
 */
export function retryDelayMs(res, attempt) {
  const ra = res?.headers?.get?.('retry-after');
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs) && secs >= 0) {
      return Math.min(secs * 1000 + 250, 2_147_483_647);
    }
    const when = Date.parse(ra);
    if (Number.isFinite(when)) {
      return Math.min(Math.max(when - Date.now(), 0) + 250, 2_147_483_647);
    }
  }
  const exp = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
  const jitter = Math.random() * exp * 0.3;
  return Math.round(exp + jitter);
}

/**
 * 在并发闸门 + 退避重试下发起一次上游调用。
 *
 * `attemptFn` 必须自己重建请求体并返回一个 Response —— 因为重试时上一条 body
 * 可能已被消费，不能复用。
 *
 * 返回值 { res, release }：调用方消费完响应体后**必须**调 release()，否则会漏令牌，
 * 后续请求会被永久卡在闸门外。
 *
 * `opts.signal`：客户端断开或整体超时时触发。触发后不再排队、不再等待、不再重试。
 */
export async function withUpstream(provider, attemptFn, opts = {}) {
  const maxAttempts = Number(provider.maxAttempts ?? opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const onRetry = opts.onRetry ?? (() => {});
  const signal = opts.signal;
  const gate = gateFor(provider);

  let lastRes;
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await gate.acquire(signal);
    // 排队期间客户端可能已经走了：不再发请求
    if (signal?.aborted) {
      gate.release();
      throw signal.reason;
    }

    let res;
    try {
      res = await attemptFn();
    } catch (e) {
      gate.release();
      lastErr = e;
      lastRes = undefined;
      if (e.name === 'AbortError' || e.name === 'TimeoutError') throw e;
      // 请求可能已送达上游的网络错误（发出后断连、等响应头超时等）不重试，否则会重复计费
      if (!isSafeToRetryNetworkError(e) || attempt === maxAttempts) throw e;
      const wait = retryDelayMs(undefined, attempt);
      onRetry(attempt, `网络错误 ${e.name} (${networkErrorCode(e)})`, wait);
      await sleep(wait, signal);
      continue;
    }

    if (res.ok || !isRetryableStatus(res.status) || res.headers.get('x-should-retry') === 'false' || attempt === maxAttempts) {
      let released = false;
      return { res, release: () => {
        if (released) return;
        released = true;
        gate.release();
      } };
    }

    lastRes = res;

    // 要重试：先读掉并丢弃错误体（否则连接不会释放），再按上游建议等待。
    let detail = '';
    try {
      // 整段错误体交给 summarizeError：Cloudflare 错误页的 <title> 在 300 多字符之后，先截断就只剩 <!DOCTYPE html>
      detail = summarizeError(await (res.body ? readResponseText(res, 64 * 1024, true) : res.text()), 160);
    } catch {
      /* 忽略 */
    }
    gate.release();

    // 重试期间主动让出闸门，让其它排队的请求有机会通过。
    const wait = retryDelayMs(res, attempt);
    onRetry(attempt, `HTTP ${res.status} ${detail}`, wait);
    await sleep(wait, signal);
  }

  if (lastRes) return { res: lastRes, release: () => {} };
  throw lastErr ?? new Error('上游调用失败');
}

/** 可被 signal 打断的等待：客户端断开后不必把退避时间等完 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 供 /health 观测 */
export function gateStats() {
  return Object.fromEntries(
    [...gates.entries()].map(([name, g]) => [name, { active: g.active, waiting: g.waiters.length, limit: g.limit }]),
  );
}
