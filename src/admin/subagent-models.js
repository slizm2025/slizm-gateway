import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig, redact, env, ROOT } from '../config.js';
import { createSseDecoder } from '../sse.js';

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function configuredSubagentModels(cfg, tool) {
  const aliases = new Set(cfg.routes.keys());
  for (const provider of cfg.providers.values()) {
    for (const alias of Object.keys(provider.models)) aliases.add(alias);
  }
  return [...aliases].map((id) => {
    const route = cfg.routes.get(id);
    const provider = route ? cfg.providers.get(route.provider)
      : [...cfg.providers.values()].find((p) => Object.hasOwn(p.models, id));
    const requested = route?.model ?? (route ? id : provider?.models[id]);
    const targetModel = provider && Object.hasOwn(provider.models, requested) ? provider.models[requested] : requested;
    let reason = !provider ? '提供商不存在' : provider.requireKey && !provider.apiKey ? '提供商缺少 API 密钥' : '';
    if (tool === 'claude' && ['opus', 'sonnet', 'haiku', 'inherit'].includes(id)) {
      reason = 'Claude Code 会自行解析此名称，请选择完整路由名';
    }
    return { id, provider: provider?.name ?? '', targetModel: targetModel ?? id, available: !reason, ...(reason ? { reason } : {}) };
  });
}

export function createSubagentModels({ configPath, cachePath, fetchImpl = fetch, timeoutMs = 60000, cacheTtlMs = 24 * 3600 * 1000, verifyGateway } = {}) {
  const results = new Map();
  const busy = new Set();
  if (cachePath) {
    try {
      if (statSync(cachePath).size <= 1024 * 1024) {
        const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
        for (const [key, value] of Object.entries(cached).slice(0, 512)) {
          if (/^[a-f0-9]{64}:/.test(key) && ['ok', 'failed'].includes(value?.status) && Number.isFinite(Date.parse(value.checkedAt))) {
            results.set(key, { status: value.status, checkedAt: value.checkedAt, ...(value.status === 'failed' ? { reason: String(value.reason || '检测失败').slice(0, 200) } : {}) });
          }
        }
      }
    } catch { /* Missing or damaged probe history is safely treated as unchecked. */ }
  }
  function persist() {
    if (!cachePath) return;
    const temp = cachePath + '.' + process.pid + '.tmp';
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(temp, JSON.stringify(Object.fromEntries(results)) + '\n', { mode: 0o600 });
      renameSync(temp, cachePath);
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
  }
  function snapshot(tool) {
    if (!['claude', 'codex'].includes(tool)) throw fail('未知 Agent 工具');
    const cfg = loadConfig({ configPath });
    // Credentials invalidate cached probes without leaving the hash.
    const signature = createHash('sha256').update(JSON.stringify({
      server: cfg.server, routes: [...cfg.routes], providers: [...cfg.providers], tool,
    })).digest('hex');
    return { cfg, signature, models: configuredSubagentModels(cfg, tool) };
  }
  function gatewayBase(cfg) {
    const host = ['0.0.0.0', '::', 'localhost'].includes(cfg.server.host) ? '127.0.0.1' : cfg.server.host;
    if (!['127.0.0.1', '::1'].includes(host)) throw fail('模型检测只允许连接本机网关');
    return 'http://' + (host === '::1' ? '[::1]' : host) + ':' + cfg.server.port;
  }
  async function verifyRunningConfig(cfg) {
    const base = gatewayBase(cfg);
    const health = await fetchImpl(base + '/health', { signal: AbortSignal.timeout(5000) });
    if (!health.ok || (await health.json()).service !== 'slizm-gateway') throw fail('未找到运行中的本机网关', 503);
    const response = await fetchImpl(base + '/v1/pricing-status', {
      signal: AbortSignal.timeout(5000), headers: { authorization: 'Bearer ' + cfg.server.clientToken },
    });
    if (!response.ok) throw fail('无法核实网关当前配置，请检查网关版本和认证', 409);
    const status = await response.json();
    const content = readFileSync(configPath || env('GATEWAY_CONFIG', join(ROOT, 'providers.json')), 'utf8');
    const revision = createHash('sha256').update(content).digest('hex');
    if (status.restartRequired || status.revision !== revision) {
      throw fail('网关尚未加载当前路由配置，请在空闲时重启网关后检测', 409);
    }
  }
  function list(tool) {
    const { signature, models } = snapshot(tool);
    return models.map((model) => {
      const cached = results.get(signature + ':' + model.id);
      const result = cached && Date.now() - Date.parse(cached.checkedAt) < cacheTtlMs ? cached : null;
      return { ...model, status: result?.status ?? 'unchecked',
        ...(result ? { checkedAt: result.checkedAt } : {}),
        ...(result?.reason ? { checkReason: result.reason } : {}),
      };
    });
  }
  function validate(tool, model) {
    if (model === null || model === undefined || (tool === 'claude' && model === 'inherit')) return;
    const candidate = list(tool).find((item) => item.id === model);
    if (!candidate?.available) throw fail(candidate?.reason || '模型不在可用网关路由中');
  }
  async function probe(cfg, tool, model) {
    const base = gatewayBase(cfg);
    const claude = tool === 'claude';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(base + (claude ? '/v1/messages' : '/v1/responses'), {
        method: 'POST', signal: controller.signal,
        headers: {
          'content-type': 'application/json', authorization: 'Bearer ' + cfg.server.clientToken,
          'user-agent': claude ? 'claude-cli/subagent-check' : 'Codex/subagent-check',
          ...(!claude ? { originator: 'Codex Desktop' } : {}),
          ...(claude ? { 'anthropic-version': '2023-06-01', 'x-app': 'cli' } : {}),
        },
        body: JSON.stringify(claude ? {
          model: model.id, max_tokens: 96, stream: true, messages: [{ role: 'user', content: 'Reply with OK only.' }],
        } : {
          model: model.id, max_output_tokens: 96, stream: true, store: false,
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply with OK only.' }] }],
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw fail('网关返回 HTTP ' + response.status);
      }
      if (!response.body) throw fail('网关没有返回响应体');
      const reader = response.body.getReader();
      const events = [];
      const decoder = createSseDecoder((payload) => {
        if (payload.trim() !== '[DONE]') events.push(JSON.parse(payload));
      });
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 1024 * 1024) throw fail('模型检测响应超过上限');
          decoder.push(value);
        }
        decoder.end();
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const capped = (event) => event.type === 'response.incomplete'
        && event.response?.incomplete_details?.reason === 'max_output_tokens'
        && event.response?.usage?.output_tokens > 0;
      if (events.some((event) => ['error', 'response.failed'].includes(event.type) || (event.type === 'response.incomplete' && !capped(event)))) {
        throw fail('模型返回错误或未完成响应');
      }
      if (!events.some((event) => event.type === (claude ? 'message_stop' : 'response.completed') || (!claude && capped(event)))) {
        throw fail('模型响应未正常结束');
      }
      return { status: 'ok', checkedAt: new Date().toISOString() };
    } catch (error) {
      return { status: 'failed', checkedAt: new Date().toISOString(), reason: controller.signal.aborted ? '模型检测超时' : redact(String(error.message)).slice(0, 200) };
    } finally {
      clearTimeout(timer);
    }
  }
  async function check(tool) {
    if (busy.has(tool)) throw fail('该工具的模型检测正在进行中', 409);
    const { cfg, signature, models } = snapshot(tool);
    busy.add(tool);
    try {
      await (verifyGateway || verifyRunningConfig)(cfg);
      const queue = models.filter((model) => model.available);
      async function run() {
        for (let model; (model = queue.shift());) {
          results.set(signature + ':' + model.id, await probe(cfg, tool, model));
        }
      }
      await Promise.all([run(), run()]);
      if (snapshot(tool).signature !== signature) throw fail('检测期间网关配置已改变，请重新检测', 409);
      if (results.size > 512) {
        for (const key of results.keys()) if (!key.startsWith(signature + ':')) results.delete(key);
      }
      persist();
      return list(tool);
    } finally {
      busy.delete(tool);
    }
  }
  return { list, validate, check };
}
