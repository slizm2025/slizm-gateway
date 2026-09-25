// Read-only model-list probe using the same transport as the gateway.
// Usage: node scripts/probe.js <providerName> [filter]
import { loadConfig, redact } from '../src/config.js';
import { upstreamFetch, readResponseText } from '../src/upstream-fetch.js';
import { buildHeaders } from '../src/providers/anthropic.js';
import { buildOpenAIHeaders } from '../src/providers/openai.js';
import { normalizeBaseUrl } from '../src/providers/gemini.js';

try {
  const [name, filter] = process.argv.slice(2);
  const cfg = loadConfig();
  const provider = cfg.providers.get(name);
  if (!provider) throw new Error(`provider 不存在；可用: ${[...cfg.providers.keys()].join(', ')}`);
  if (!provider.apiKey) throw new Error(`provider ${name} 未配置密钥`);
  const base = provider.apiType === 'gemini' ? normalizeBaseUrl(provider.baseUrl) : provider.baseUrl;
  const url = `${base}${provider.apiType === 'anthropic' ? '/v1' : ''}/models`;
  console.log(`provider=${provider.name} apiType=${provider.apiType} key=[已配置] proxy=${Boolean(provider.proxy)}`);
  const response = await upstreamFetch(provider, url, {
    headers: provider.apiType === 'anthropic' ? buildHeaders(provider) : buildOpenAIHeaders(provider),
    signal: AbortSignal.timeout(30000),
  });
  const text = await readResponseText(response, 4 * 1024 * 1024);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('模型列表不是合法 JSON'); }
  const ids = (value.data ?? value.models ?? []).map((m) => m.id ?? m.name).filter(Boolean);
  const filtered = filter ? ids.filter((id) => id.toLowerCase().includes(filter.toLowerCase())) : ids;
  console.log(`模型总数=${ids.length} 匹配=${filtered.length}`);
  for (const id of filtered) console.log(redact(id));
} catch (e) {
  console.error(redact(e.message));
  process.exitCode = 1;
}
