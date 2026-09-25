// 模型价格配置与 token -> 美元换算。
// 配置价格的单位是 USD / 1,000,000 tokens。

const PRICE_FIELDS = ['input', 'cacheRead', 'cacheWrite', 'output'];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rate(value, fallback, label) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} 必须是大于等于 0 的数字`);
  return number;
}

/** 校验 JSON 中的 pricing，并转换成按模型 ID 索引的 Map。 */
export function normalizePricing(value = {}) {
  if (!isRecord(value)) throw new Error('pricing 必须是对象');
  const pricing = new Map();
  for (const [model, config] of Object.entries(value)) {
    if (!model.trim()) throw new Error('pricing 的模型名不能为空');
    if (!isRecord(config)) throw new Error(`pricing.${model} 必须是对象`);
    const input = rate(config.input, undefined, `pricing.${model}.input`);
    const output = rate(config.output, undefined, `pricing.${model}.output`);
    if (input === undefined || output === undefined) throw new Error(`pricing.${model} 必须配置 input 和 output`);
    pricing.set(model, {
      input,
      cacheRead: rate(config.cacheRead, 0, `pricing.${model}.cacheRead`),
      cacheWrite: rate(config.cacheWrite, 0, `pricing.${model}.cacheWrite`),
      output,
    });
  }
  return pricing;
}

export function pricingObject(pricing) {
  if (pricing instanceof Map) return Object.fromEntries(pricing);
  return isRecord(pricing) ? pricing : {};
}

function modelPrice(pricing, model) {
  const value = pricing instanceof Map ? pricing.get(model) : pricing?.[model];
  return isRecord(value) ? value : undefined;
}

/** 根据 Anthropic 语义的四类 token，返回美元金额；无法计价时返回 null。 */
export function calculateCostUsd(usage, pricing, model) {
  if (!usage || !model) return null;
  const price = modelPrice(pricing, model);
  if (!price) return null;
  const tokens = {
    input: Number(usage.input ?? usage.inputTokens) || 0,
    cacheRead: Number(usage.cacheRead ?? usage.cacheReadTokens) || 0,
    cacheWrite: Number(usage.cacheWrite ?? usage.cacheWriteTokens) || 0,
    output: Number(usage.output ?? usage.outputTokens) || 0,
  };
  return PRICE_FIELDS.reduce((sum, field) => sum + tokens[field] * Number(price[field] ?? 0), 0) / 1_000_000;
}
