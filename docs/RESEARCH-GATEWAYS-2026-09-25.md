# Claude Code 开源网关调研与借鉴建议

查询日期：2026-09-25（GitHub star 是该日期的快照，会持续变化）

## 结论先行

当前 `claude-gateway` 已经把最容易出事故的传输层问题处理得比较完整：Anthropic Messages 透传、OpenAI/Gemini 格式转换、流式 SSE、请求取消、连接阶段安全重试、并发闸门、密钥脱敏、token/cost 账本和本地诊断都有对应实现与离线回归。

最值得借鉴的不是再增加 provider 数量，而是把“固定路由”逐步升级为“可解释的可靠路由”:

1. **有序 fallback 与失败分类**：只在请求尚未产生不可逆副作用、或上游明确返回可安全重试的状态时切换目标；流已经开始输出后不换 provider。
2. **三层健康状态**：provider 级 circuit breaker、凭据/账号级 cooldown、provider+model 级 lockout，避免一个坏 key 或一个坏模型拖垮整个 provider。
3. **凭据池与可观测选择**：多 key 轮询/加权、单 key 失败冷却、当前选择原因进入日志；先支持静态 key pool，不急于做 OAuth 账号导入。
4. **动态路由配置与健康面板**：在保留 JSON 配置的前提下增加 `/admin` 或本地 UI，显示 resolved route、失败原因、p95、429/5xx、剩余冷却时间和 cost。
5. **标准化指标出口**：先提供 Prometheus 文本格式或 OpenTelemetry span/metric，避免仅依赖滚动日志和进程内 `/v1/usage`。

不建议直接照搬高 star 项目的“免费 provider 聚合、TLS stealth、身份伪装、重度 prompt 压缩、全量 OAuth 账号体系”。这些能力会明显扩大合规、隐私、兼容性和维护边界，而且与本项目“本机私有、多 provider、低依赖”的定位不完全一致。

## 当前项目基线

| 维度 | 当前状态 | 代码/证据 |
|---|---|---|
| 路由 | 请求模型名映射到单个 provider 和最终模型；支持 provider 内二次映射 | [`src/server.js`](../src/server.js#L21)、[`src/config.js`](../src/config.js#L126) |
| 协议 | Anthropic 原生透传；OpenAI/Gemini 兼容层转换为 Anthropic 响应 | [`src/server.js`](../src/server.js#L185)、`src/providers/` |
| 重试 | 429/503/529 和明确安全的连接阶段错误有限重试；请求送达后断连不重放 | [`src/limiter.js`](../src/limiter.js#L151) |
| 并发 | 每 provider 信号量，支持 `maxConcurrency` | [`src/limiter.js`](../src/limiter.js#L1) |
| 观测 | `/health`、`/v1/gate-stats`、`/v1/usage`、结构化单行日志、JSONL 用量账本 | [`src/server.js`](../src/server.js#L341)、[`src/usage.js`](../src/usage.js#L91) |
| 安全 | 本地回环监听、client token、密钥引用和日志脱敏、TLS 校验固定开启 | [`src/config.js`](../src/config.js#L85)、README 安全说明 |
| 验证 | `npm test`：109 个 Node 测试通过，专项测试 0 失败 | 2026-09-25 本地执行结果 |
| 主要缺口 | 无 fallback 链、熔断/cooldown、key pool、动态健康评分、Prometheus/Otel、管理 UI | 对照上述模块和配置 schema |

## 候选项目

### 1. OmniRoute

- 仓库：[diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute)
- GitHub star：**69,971**；fork：9,927；MIT；查询日期 2026-09-25。
- 定位：面向 Claude Code、Codex、Cursor、Cline 等客户端的多 provider AI Gateway。
- 可确认能力：多层 fallback、quota-aware routing、provider circuit breaker、connection cooldown、model lockout、per-session sticky routing、模型自动同步、usage/cost/latency analytics 和 dashboard。
- 最有价值的设计是把故障范围分开：provider 故障、单连接/单 key 故障、单模型故障分别处理，而不是一个全局“provider 不健康”开关。
- 适合借鉴：故障状态模型、冷却时间、模型锁定、健康/延迟统计、会话粘性。
- 不适合直接搬运：免费额度目录、数百 provider、复杂的压缩引擎和 OAuth/订阅导入。这会把本地网关变成 provider 运营平台。

来源：仓库 README、[`docs/guides/FEATURES.md`](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.51/docs/guides/FEATURES.md)、[`src/shared/utils/circuitBreaker.ts`](https://github.com/diegosouzapw/OmniRoute/blob/66f5b2aa0fbef72abb45397c3044a22389f2ff20/src/shared/utils/circuitBreaker.ts)、[`SECURITY.md`](https://github.com/diegosouzapw/OmniRoute/blob/66f5b2aa0fbef72abb45397c3044a22389f2ff20/SECURITY.md)。

### 2. LiteLLM

- 仓库：[BerriAI/litellm](https://github.com/BerriAI/litellm)
- GitHub star：**59,580**；fork：11,760；查询日期 2026-09-25。
- 定位：面向 100+ LLM 的通用 AI Gateway，提供统一 API、proxy server、virtual keys、spend tracking、guardrails、load balancing、logging 和 dashboard。
- 可确认能力：模型组/部署级 fallback、retry policy、weighted failover、tag filtering、虚拟 API key 的预算与模型限制、Prometheus 集成和部署级统计。
- 适合借鉴：把路由策略从 provider 名称提升为“model group + deployment”；把每次请求的 route decision、fallback 次数、deployment error 分类为一等指标；为未来多用户部署预留 virtual key/预算概念。
- 不适合直接搬运：LiteLLM 的 provider 覆盖面、配置面和数据库/管理面远超当前需求；引入其完整运行时会增加依赖、启动时间和升级风险。

来源：仓库 README、[`litellm/constants.py`](https://github.com/BerriAI/litellm/blob/3fa02ef9fcc287a8648c6d5bc998d9962915699e/litellm/constants.py)、[`integrations/prometheus.py`](https://github.com/BerriAI/litellm/blob/3fa02ef9fcc287a8648c6d5bc998d9962915699e/litellm/integrations/prometheus.py)、[`proxy/auth/user_api_key_auth.py`](https://github.com/BerriAI/litellm/blob/3fa02ef9fcc287a8648c6d5bc998d9962915699e/litellm/proxy/auth/user_api_key_auth.py)。

### 3. Claude Code Router（CCR）

- 仓库：[musistudio/claude-code-router](https://github.com/musistudio/claude-code-router)
- GitHub star：**37,418**；fork：3,145；MIT；查询日期 2026-09-25。
- 定位：Claude Code 及多个 coding agent 的本地 control plane，带 CLI、桌面端/管理 UI、provider preset、模型目录、路由规则和日志。
- 可确认能力：ordered fallback models、重试、credential pool、provider probing、model discovery、header/body 条件路由、request rewrite、agent profile、resolved route/token/latency/cost 日志。
- 适合借鉴：
  - 把 `routes` 扩展为带条件、重写和 fallback 的声明式规则；
  - 对 provider 做能力探测，而不是仅凭用户手填协议；
  - 在日志中同时记录“请求模型、解析后模型、provider、凭据、fallback 原因”；
  - 将已有 CLI 管理体验逐步演进为本地管理页面。
- 不适合直接搬运：Electron/桌面应用、多个 agent 的配置安装器、庞大的 provider preset 体系。当前网关先保持 Node 单进程和 JSON 配置更容易审计。

来源：仓库 README、[`packages/ui/src/pages/home/shared/providers.ts`](https://github.com/musistudio/claude-code-router/blob/main/packages/ui/src/pages/home/shared/providers.ts)。

### 4. 9router

- 仓库：[decolua/9router](https://github.com/decolua/9router)
- GitHub star：**29,769**；fork：5,606；MIT；查询日期 2026-09-25。
- 定位：面向 Claude Code/Codex/Cursor/Cline 等工具的多 provider 路由器，强调订阅、廉价和免费 provider 的级联、quota tracking、multi-account、自动 token refresh 和 RTK token saver。
- 适合借鉴：按“订阅/付费 API/廉价/免费”分层的路由概念，以及 quota 快照、key/account 轮换和“接近耗尽时提前切换”的用户体验。
- 风险：README 的“免费 provider”生态和账号自动刷新强依赖第三方服务条款及登录协议，不应成为当前网关的核心设计；RTK 压缩也可能破坏工具输出、缓存和调试复现。

来源：仓库 [README](https://github.com/decolua/9router/blob/master/README.md)。

### 5. Portkey Gateway

- 仓库：[Portkey-AI/gateway](https://github.com/Portkey-AI/gateway)
- GitHub star：**13,079**；fork：1,314；MIT；查询日期 2026-09-25。
- 定位：轻量但偏生产化的通用 AI Gateway。
- 可确认能力：fallback、自动重试、加权负载均衡、条件路由、细粒度 timeout、guardrails、virtual key/RBAC、cache、usage analytics，以及 MCP Gateway 的认证、访问控制和 tool-call observability。
- 适合借鉴：配置化 retry/fallback policy、按 key/provider 加权、统一 timeout 语义，以及把 MCP/tool 调用的身份、参数、响应、延迟纳入审计。
- 不适合直接搬运：企业级 RBAC、合规、guardrails 和托管控制台不属于当前本地单用户网关的第一阶段。

来源：仓库 [README](https://github.com/Portkey-AI/gateway/blob/main/README.md)。

### 6. claude-worker-proxy

- 仓库：[glidea/claude-worker-proxy](https://github.com/glidea/claude-worker-proxy)
- GitHub star：**275**；fork：131；MIT；查询日期 2026-09-25。
- 定位：Cloudflare Worker 上的轻量协议适配器，把 Gemini/OpenAI/Responses 转成 Claude 格式，支持流式、工具调用和一键部署。
- 适合借鉴：provider adapter 的极简边界、边缘部署选项、把“Claude Code 兼容入口”和“目标 provider 类型/地址”分离。
- 不适合直接搬运：URL 中携带目标 provider 地址和客户端 key 的模式不适合本项目的密钥治理；Worker 无法自然复用当前本地进程的连接阶段重试、账本和精细取消语义。

来源：仓库 [README](https://github.com/glidea/claude-worker-proxy/blob/main/README.md)。

## 借鉴点到当前代码的映射

### P0：先做可靠 fallback，但保持“不重复计费”原则

当前 `withUpstream()` 已经区分连接前失败和请求送达后的不确定失败。下一步应在它之上增加“候选目标列表”，而不是扩大可重试状态：

```text
resolveRoute(model)
  -> RoutePlan(primary, fallbacks, policy)
  -> chooseHealthyTarget()
  -> withUpstream(target, ...)
  -> record route decision / fallback reason
```

建议配置形态：

```json
{
  "routes": {
    "sonnet": {
      "targets": [
        { "provider": "claude", "model": "claude-sonnet-5", "weight": 100 },
        { "provider": "deepseek", "model": "deepseek-chat", "weight": 0 }
      ],
      "fallbackOn": ["connect", "429", "503", "529", "provider_circuit_open"],
      "fallbackDelayMs": 0
    }
  }
}
```

关键边界：响应头发出或流产生第一个有效事件后，禁止切到另一个 provider；`502/504` 仍默认不 fallback，除非明确判定为请求未送达。

### P0：三层健康状态

增加一个独立模块（例如 `src/health-state.js`），不要把状态塞进 `limiter.js`：

| 层级 | key | 触发 | 恢复 |
|---|---|---|---|
| Provider breaker | provider | 连续连接失败、429/503 风暴、TLS/代理失败 | 指数冷却后半开探测 |
| Credential cooldown | provider + credential | 401/403、key quota exhausted、账号级 429 | `Retry-After` 或固定冷却到期 |
| Model lockout | provider + credential + model | 模型不存在、模型级限额、模型能力不兼容 | 短冷却或配置变更 |

必须区分 401/403 与 429/503：前者通常不应重试同一凭据，后者可能只是容量抖动。`/v1/gate-stats` 可扩展 `openUntil`、`failureKind`、`consecutiveFailures`、`halfOpenProbe`。

### P1：静态 credential pool

当前 `provider.apiKey` 是单值。可先支持：

```json
{
  "name": "deepseek-pool",
  "apiType": "openai",
  "credentials": [
    { "id": "primary", "apiKey": "env:DEEPSEEK_KEY_1", "weight": 2 },
    { "id": "backup", "apiKey": "env:DEEPSEEK_KEY_2", "weight": 1 }
  ]
}
```

选择策略先做 `round_robin` 或 `weighted_round_robin`，失败后只冷却当前 credential。日志记录 credential id，不记录 key 内容。不要第一版就加入 OAuth refresh、浏览器登录或外部账号导入。

### P1：标准指标和可解释日志

保留现有 JSONL 账本，增加低基数的指标维度：

- `gateway_requests_total{route,provider,model,status_class}`
- `gateway_request_duration_ms{route,provider,model}`
- `gateway_upstream_attempts_total{provider,reason}`
- `gateway_fallback_total{from_provider,to_provider,reason}`
- `gateway_inflight_requests{provider}`
- `gateway_tokens_total{provider,model,direction}`
- `gateway_cost_usd_total{provider,model}`
- `gateway_circuit_state{provider}`

避免把 `request_id`、完整模型别名、用户 prompt 放进 Prometheus label。现有日志已经有请求 ID，可继续承载逐请求细节。

### P1：模型能力目录，而不是只列模型名

当前 `/v1/models` 只列本地路由。可以在不影响 Claude Code 兼容性的前提下，为内部 catalog 增加：

- `supportsVision`
- `supportsTools`
- `supportsStreaming`
- `supportsThinking`
- `contextWindow`
- `price`
- `lastCheckedAt`

路由匹配先按能力过滤，再按健康、延迟、价格排序。对外 `/v1/models` 仍可以只暴露 alias，避免把上游真实模型和 provider 信息泄露给不需要它的客户端。

### P2：本地管理 UI / 配置热校验

当前 JSON 配置和重启模型适合个人使用，但修改 provider/key/route 的反馈成本高。可先做只读页面：

- 当前配置摘要和密钥是否存在；
- provider 最近成功率、p50/p95、429/5xx；
- circuit/cooldown 状态；
- 最近 fallback 链和请求详情；
- 配置 dry-run 和 redacted export。

配置热加载应放在后面，并且必须做到“新配置完整校验成功后原子替换”；不要让运行中的请求看到半套配置。

## 暂不建议引入

1. **大规模 provider/免费额度目录**：维护成本和条款风险高，且与本项目的私有 key 路由目标不同。
2. **prompt 压缩**：会影响 Claude Code 工具结果、缓存命中、调试复现和模型行为；如要做，应先作为显式 opt-in adapter，并有黄金请求回放测试。
3. **TLS stealth/指纹伪装**：属于高风险兼容层，和正常的 `clientProfile` 头部适配不是一个层次；优先保证协议正确、TLS 校验和可审计性。
4. **完整桌面应用**：CCR 的 UI 思路值得借鉴，但先做本地只读/轻量管理页面，避免 Electron、原生依赖和自动更新成为主线负担。
5. **把 502/504 全部 fallback**：这会违反当前已经建立的计费安全假设，产生重复请求和重复扣费。

## 推荐实施顺序

### 第一阶段：可靠性内核

- 抽象 `RoutePlan` 和候选 target。
- 增加失败分类和 provider/model/credential 健康状态。
- fallback 只在 pre-send 或明确安全状态触发。
- 扩展 `gate-stats` 和现有专项测试。

### 第二阶段：key pool 与指标

- 静态 credential pool、round-robin、单 credential cooldown。
- 增加 Prometheus `/metrics`，并把 fallback/circuit 记录进 JSONL。
- 为每次 route decision 增加可脱敏的结构化字段。

### 第三阶段：能力目录与本地控制面

- 模型能力 catalog 和定期探测。
- 只读 dashboard、配置 dry-run、健康和成本视图。
- 在验证热加载原子性后，再考虑无损 reload。

## 参考项目对照表

| 项目 | Star 快照 | 最值得借鉴 | 与当前项目关系 |
|---|---:|---|---|
| OmniRoute | 69,971 | 三层故障隔离、quota/健康分析、会话粘性 | 重点参考可靠性状态机 |
| LiteLLM | 59,580 | model group、部署级 fallback、virtual key、Prometheus | 重点参考控制面和指标抽象 |
| Claude Code Router | 37,418 | 条件路由、ordered fallback、credential pool、route observability | 最贴近用户场景 |
| 9router | 29,769 | 分层路由、quota tracking、多账号轮换 | 只借鉴抽象，不引入免费生态 |
| Portkey Gateway | 13,079 | retry/fallback policy、weighted LB、timeout、MCP 审计 | 参考生产化策略配置 |
| claude-worker-proxy | 275 | 极简 Claude 兼容 adapter、边缘部署 | 参考 adapter 边界，不参考 key-in-URL |

## 调研限制

- Star、fork、提交时间都是动态数据；本文件只保留 2026-09-25 的快照。
- 项目 README 的功能描述不等于所有功能都经过同等程度的生产验证；本调研优先参考仓库源码、配置类型、测试/文档中的可核对内容。
- 未对这些项目做完整性能、协议兼容性或安全审计；本文件用于确定借鉴方向，不替代引入前的 PoC 和回归测试。
