const MINUTE_MS = 60_000;

function tokens(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** End-to-end output rate, including queueing, retries and first-token latency. */
export function outputTokensPerSecond(item) {
  if (item.usageSource !== 'reported' || !(item.status >= 200 && item.status < 400) || item.error) return null;
  const output = tokens(item.outputTokens);
  const duration = item.durationMs;
  if (!output || !Number.isFinite(duration) || duration <= 0) return null;
  const rate = output * 1000 / duration;
  return Number.isFinite(rate) ? rate : null;
}

export function emptyOutputRate() {
  return { avgOutputTokensPerSec: null, outputTpsSamples: 0 };
}

export function addOutputRate(target, item) {
  const rate = outputTokensPerSecond(item);
  if (rate === null) return;
  const previous = target.avgOutputTokensPerSec ?? 0;
  target.outputTpsSamples++;
  target.avgOutputTokensPerSec = previous + (rate - previous) / target.outputTpsSamples;
}

/** Completion-time accounting; current and calendar-minute peak use a fixed 60s divisor. */
export function calculateTraffic(items, { since, until }) {
  const windowSeconds = Math.max(0, (until - since) / 1000);
  const minutes = new Map();
  let tokenConsumed = 0;
  let currentTokens = 0;
  if (Number.isFinite(windowSeconds) && windowSeconds > 0) {
    for (const item of items) {
      const time = Date.parse(item.time);
      if (!(time >= since && time < until) || item.usageSource !== 'reported') continue;
      const count = tokens(item.inputTokens) + tokens(item.outputTokens)
        + tokens(item.cacheReadTokens) + tokens(item.cacheWriteTokens);
      tokenConsumed += count;
      if (time >= until - MINUTE_MS) currentTokens += count;
      const minute = Math.floor(time / MINUTE_MS);
      minutes.set(minute, (minutes.get(minute) ?? 0) + count);
    }
  }
  let peakTokens = 0;
  for (const count of minutes.values()) peakTokens = Math.max(peakTokens, count);
  return {
    since: new Date(since).toISOString(),
    until: new Date(until).toISOString(),
    windowSeconds,
    currentWindowSeconds: 60,
    peakBucketSeconds: 60,
    tokenConsumed,
    tps: {
      current: currentTokens / 60,
      peak: peakTokens / 60,
      avg: windowSeconds > 0 ? tokenConsumed / windowSeconds : 0,
    },
  };
}
