# GitHub Claude Code / Anthropic API 网关项目研究

**查询日期：** 2026-09-25  
**范围：** GitHub 上与 Claude Code、Anthropic Messages API、LLM API 网关、代理、聚合和路由直接相关的开源项目。  
**来源约束：** 只使用项目自己的 GitHub 仓库、README、源码、官方文档、release 或 issue；未使用第三方榜单、博客或测评作为事实来源。

## 结论摘要

1. **最值得直接借鉴的是 Claude Code Router（CCR）和 Bifrost。** CCR 的优势是把 Claude Code 的 agent/profile、模型路由、请求日志和本地控制面放在同一套产品里；Bifrost 的优势是把 provider/key/session affinity/fallback 的路由语义拆得很清楚，并且专门处理 Claude Code 的 session header 与 Anthropic 特性透传。
2. **LiteLLM 是最完整的通用网关参考实现。** 它覆盖 provider 适配、Anthropic Messages、认证、限流、预算、成本、路由、fallback、缓存和可观测性，但体量与复杂度远超当前本地网关，适合借鉴边界和模块划分，不适合直接移植。
3. **Portkey Gateway 适合参考轻量网关的配置和中间件形态。** 它的 route/fallback/retry/load-balance/guardrail 组合清晰，但仓库 README 同时强调 hosted/enterprise 产品，且 GitHub release 相对不频繁，应谨慎评估其当前开源分支的维护节奏。
4. **New API 适合参考“多渠道管理 + 统一协议转换 + 管理面”。** 它对 Anthropic/Responses/Claude tool result 等兼容细节投入较深，但 AGPLv3、功能面很宽、管理与计费色彩明显，不适合直接作为本地 Claude Code 网关的最小内核。
5. **Helicone 更适合作为可观测性和 provider attempt/fallback 的参考。** 它的核心价值不是本地透明代理，而是 gateway + logging + cost/latency/trace 平台；其最新 GitHub release 页面显示的版本停留在 2025-08-21，需把维护活跃度作为引入风险。
6. **9Router 与 Claude Code 的直接相关性很高，但不建议作为当前网关的上游实现模板。** README 把订阅账号、免费额度、OAuth/token refresh、跨产品 provider 聚合和 token 压缩揉在一起；这对个人工具很有吸引力，但对需要授权边界、可审计和稳定协议语义的本地网关，风险显著更高。

## 项目总览

| 项目 | GitHub stars（2026-09-25 快照） | 直接相关性 | 适合借鉴 | 主要不适合之处 |
| --- | ---: | --- | --- | --- |
| [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router) | **37,418** | Claude Code 专用控制面与多 provider 路由 | agent/profile 管理、可编译路由规则、fallback、请求日志、插件化 | 产品范围已扩展到多个 agent、桌面端和工具编排，复杂度较高 |
| [decolua/9router](https://github.com/decolua/9router) | **29,769** | 直接面向 Claude Code/Codex/Cursor 等 coding agent | 本地统一 endpoint、组合 fallback、账户轮换、token 压缩 | 强依赖订阅/免费 provider 与 OAuth，授权边界和协议稳定性不适合作为企业内核 |
| [BerriAI/litellm](https://github.com/BerriAI/litellm) | **59,580** | 通用 LLM 网关，原生覆盖 Anthropic Messages | provider adapter、统一错误、认证/预算/限流、router/fallback、可观测性 | 超大代码库，依赖 Redis/Postgres 等基础设施，直接移植成本高 |
| [Portkey-AI/gateway](https://github.com/Portkey-AI/gateway) | **13,079** | 通用多 provider 网关，含 Anthropic provider | 配置驱动路由、weighted provider、重试/fallback、guardrail/middleware | 业务/企业产品耦合明显；README 的 provider 数量和性能数字不应直接视为验证结果 |
| [maximhq/bifrost](https://github.com/maximhq/bifrost) | **8,335** | 通用高性能网关，近期显式关注 Claude Code | session affinity、provider/key fallback、Anthropic passthrough、路由测试 | Go 代码库和企业功能面很大；默认分支为 dev，引入前应固定 release/commit |
| [QuantumNous/new-api](https://github.com/QuantumNous/new-api) | **48,865** | 多模型聚合/分发，原生 Claude-compatible API | 渠道适配器、模型映射、协议转换、Claude tool/media 兼容、管理面 | AGPLv3；计费、配额、用户和公共分发能力超出本项目最小需求 |
| [Helicone/helicone](https://github.com/Helicone/helicone) | **6,176** | AI gateway + LLM observability，支持 Anthropic | attempt builder、BYOK/PTB 优先级、成本/延迟/trace 数据模型 | 自托管由多个服务组成，核心价值偏 observability，不是轻量本地代理 |

> **Star 数据说明：** 数值来自 2026-09-25 查询时 GitHub REST GET /repos/{owner}/{repo} 返回的 stargazers_count。GitHub star 会持续变化，本文数字是查询快照，不是历史永久值。

## 1. Claude Code Router（CCR）

- **仓库：** [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router)
- **Star：** 37,418；MIT；TypeScript；默认分支 main。
- **维护信号：** 查询日仓库 API 的 pushed_at 为 2026-09-20；最新 release 为 [v3.1.1](https://github.com/musistudio/claude-code-router/releases/tag/v3.1.1)，发布于 2026-09-16。

### 核心能力

CCR 将 Claude Code、Codex、Grok CLI、Kimi CLI、OpenCode 等 agent 接到一个本地 endpoint，并在其后管理 provider、model、account、route、fallback、tool 和日志。README 明确列出 Anthropic Messages、OpenAI Chat/Responses、Gemini 等协议，并支持 retries、credential pools、key rotation、ordered fallback、Fusion/MCP/ToolHub 与请求日志。

源码结构显示其不是一个简单的反向代理：packages/core 内有 config、routing、gateway runtime、MCP、observability 和 provider 相关模块；默认配置中同时定义 Claude Code/Codex agent profile、provider 列表、router fallback 和多个 upstream proxy target。

config-compiler.ts 将规则编译为带 diagnostics 的配置，验证 model/provider 是否已配置、rewrite 是否有效、script rule API/language 是否受支持，并把 profile routing 与普通 router rule 分开编译。fallback 支持 off、retry、model chain 等模式，并限制 retry 次数。

### 适合借鉴

- **本地控制面边界：** 把 agent profile、provider、model alias、route rule、fallback 与请求日志放在同一配置模型里，适合当前项目继续保持“一个本地 endpoint”。
- **路由配置先编译再执行：** 用 ModelRegistry、diagnostics 和 active/inactive 状态，在请求前暴露配置错误，避免把错误拖到真实上游请求阶段。
- **配置级 fallback 语义：** 把 fallback mode、model chain、retryCount 建模为显式配置，而不是在 HTTP handler 里散落 if/else。
- **扩展点：** router plugin、request transform、upstream header sanitizer 等边界值得参考，尤其适合把 provider-specific 逻辑隔离。

### 明显不适合直接照搬

- CCR 已经是桌面端/多 agent 控制产品，packages/electron、UI、MCP、bot 和多种 agent profile 会显著扩大维护面；当前网关只需要本地 Claude Code 多 provider 转发，不应复制整个产品层。
- CCR 的 provider/agent 兼容范围变化快，不能把其每个 preset 或 header 行为当作 Anthropic/Claude Code 的稳定协议；应只吸收明确可验证的 route、retry、日志和 header sanitation 设计。
- CCR 的默认路由 fallback 是关闭的，说明 fallback 不是“越多越好”的默认行为；本项目应继续按错误可重试性和重复计费风险谨慎开启。

### 关键来源

- [README](https://github.com/musistudio/claude-code-router/blob/main/README.md)
- [默认配置](https://github.com/musistudio/claude-code-router/blob/main/packages/core/src/config/default-config.ts)
- [路由配置编译器](https://github.com/musistudio/claude-code-router/blob/main/packages/core/src/routing/config-compiler.ts)
- [路由执行计划搜索结果](https://github.com/musistudio/claude-code-router/blob/75e9e750c134acc389eab00bc131c6cd625ba614/packages/core/src/routing/execution-plan.ts)
- [最新 release v3.1.1](https://github.com/musistudio/claude-code-router/releases/tag/v3.1.1)
- [GitHub API 仓库快照](https://api.github.com/repos/musistudio/claude-code-router)

## 2. 9Router

- **仓库：** [decolua/9router](https://github.com/decolua/9router)
- **Star：** 29,769；MIT；JavaScript；默认分支 master。
- **维护信号：** 查询日仓库 API 的 pushed_at 为 2026-09-23。

### 核心能力

9Router 直接面向 Claude Code、Codex、Cursor、Cline、Copilot 等 coding tools，提供本地 http://localhost:20128/v1 endpoint。README 描述了三层 provider 组合：订阅层、低价层、免费层；支持 auto fallback、multi-account round-robin、quota tracking、OAuth token refresh、OpenAI/Claude format translation 和 RTK tool-result token compression。

### 适合借鉴

- **面向 coding agent 的产品入口：** endpoint、dashboard、API key、model combo 和 fallback chain 对 Claude Code 使用场景很直观。
- **组合模型链：** primary -> cheap -> free 的显式链条适合借鉴为“路由候选序列”，但候选的合法性、计费和错误分类必须由本项目自己控制。
- **token/上下文成本视角：** tool result 压缩、usage dashboard 和 fallback 可观测性提示了 coding agent 网关不能只记录 HTTP status，还要记录 token、模型、上下文和实际路由。

### 明显不适合直接照搬

- README 把 Claude Code/Codex/Copilot 等订阅产品、免费额度 provider、OAuth 账号和 token refresh 放在同一聚合层；这类实现的账号授权、服务条款、上游身份和长期稳定性风险明显高于“用户自带 API key 的正规代理”。
- “免费”“永不中断”“20-40% token savings”等定位是产品宣传，不是本文独立验证的性能或可用性结论。
- README 明确提到该 repository package 为 private、source/Docker execution 是 local development path；因此不能仅凭 README 将其视为一个已经验证完备的通用开源 gateway 内核。
- 它的核心价值包含 provider 账号整合和 token 省钱策略，与当前项目的安全边界不同；只建议参考 endpoint/model-combo/fallback 的交互形态。

### 关键来源

- [README](https://github.com/decolua/9router/blob/master/README.md)
- [GitHub API 仓库快照](https://api.github.com/repos/decolua/9router)

## 3. LiteLLM

- **仓库：** [BerriAI/litellm](https://github.com/BerriAI/litellm)
- **Star：** 59,580；仓库许可证字段为 Other，需按其 LICENSE/商业条款核对具体使用方式；Python/Rust；默认分支 main。
- **维护信号：** 查询日仓库 API 的 pushed_at 为 2026-09-25；最新 release 为 [v1.102.1](https://github.com/BerriAI/litellm/releases/tag/v1.102.1)，发布于 2026-09-23。

### 核心能力

LiteLLM 同时提供 Python SDK 和 AI Gateway/Proxy。README 声称用统一接口覆盖 100+ provider，并列出 Anthropic、Bedrock、Gemini、Azure 等；gateway 侧包含 virtual keys、spend tracking、guardrails、load balancing 和 admin dashboard。架构文档把入口、认证、Redis、hooks、router、provider transformation、cost calculation、日志和 Postgres 写入拆开，并明确 /v1/messages 是 Anthropic Messages endpoint。

源码搜索结果显示 Anthropic Messages 有独立的 endpoint、transformation、streaming iterator 和 passthrough 路径；同时存在对 SSE、provider response headers、stream model restamp 和 agentic streaming 的专门处理。

### 适合借鉴

- **清晰的 gateway/SDK 双层：** proxy 负责 auth/rate-limit/budget/routing，SDK/provider handler 负责协议转换和流式消费。这是当前项目继续扩展 provider 时最值得参考的边界。
- **provider transformation 与 passthrough 并存：** 对 Anthropic Messages，不能所有请求都强行转成 OpenAI；应保留 direct/passthrough 路径，同时对需要转换的 provider 使用专门 adapter。
- **路由与可观测性解耦：** router、cost calculator、logging hooks、DB writer 分离，便于分别验证请求是否成功、上游实际 usage 和成本是否可信。
- **流式协议细节：** SSE frame、provider headers、message model restamp、stream error/cache 等都是 Claude Code 网关的高风险边界，可按场景增加回归测试。

### 明显不适合直接照搬

- LiteLLM 是大型平台而不是小型本地代理，代码库和 provider surface 极大；直接移植会把当前项目引入不必要的依赖、配置和升级负担。
- 架构图依赖 Redis、Postgres、异步 spend writer 等组件；当前项目保持单机、低依赖和回环监听，不能默认采用同样的部署形态。
- LiteLLM 的统一 OpenAI 体验与 Claude Code 的原生 Anthropic headers/body/SSE 兼容之间存在张力；“统一 API”不能替代逐字段验证。
- 仓库 license 字段不是 MIT/Apache，实际使用前必须按仓库 LICENSE 和当前版本条款做法律核对。

### 关键来源

- [README](https://github.com/BerriAI/litellm/blob/main/README.md)
- [架构说明](https://github.com/BerriAI/litellm/blob/main/ARCHITECTURE.md)
- [Anthropic Messages endpoint 目录](https://github.com/BerriAI/litellm/tree/main/litellm/proxy/anthropic_endpoints)
- [Anthropic streaming passthrough](https://github.com/BerriAI/litellm/blob/main/litellm/llms/anthropic/experimental_pass_through/messages/streaming_iterator.py)
- [最新 release v1.102.1](https://github.com/BerriAI/litellm/releases/tag/v1.102.1)
- [GitHub API 仓库快照](https://api.github.com/repos/BerriAI/litellm)

## 4. Portkey AI Gateway

- **仓库：** [Portkey-AI/gateway](https://github.com/Portkey-AI/gateway)
- **Star：** 13,079；MIT；TypeScript；默认分支 main。
- **维护信号：** 查询日仓库 API 的 pushed_at 为 2026-05-25；GitHub latest release 为 [v1.15.2](https://github.com/Portkey-AI/gateway/releases/tag/v1.15.2)，发布于 2026-01-12。README 另提示 Gateway 2.0 正在把 enterprise gateway 合并到开源 pre-release 分支，版本线需要特别确认。

### 核心能力

Portkey Gateway 是 Node/TypeScript 网关，README 将其定位为一个 API 路由层，覆盖多 provider、自动 retries/fallbacks、load balancing、conditional routing、guardrails、多模态和 MCP Gateway。README 的本地启动方式是 npx @portkey-ai/gateway，默认暴露 http://localhost:8787/v1 和 console。

源码 src/providers/anthropic 单独包含 api.ts、messages.ts、chatComplete.ts、complete.ts、类型和工具函数；handlerUtils.ts 负责 request body/header 构造，并通过 ProviderContext 获取 provider headers。该文件还实现 weighted provider selection，并把 retry handler、conditional router、cache、hooks、logs、request/response service 组合到 handler 流程。

### 适合借鉴

- **轻量 handler 分层：** RequestContext、ProviderContext、ResponseService、ConditionalRouter 和 retryHandler 的职责边界适合参考当前 Node 网关。
- **weighted provider selection：** 对同一模型的多个 key/provider 做概率或权重选择，比在业务代码中硬编码轮换更容易扩展。
- **header/body 构造集中化：** 代理头、provider header、forward header、content type、multipart 和 stream body 在一个明确边界处理，适合减少跨 provider header 泄漏。
- **配置型 reliability：** retry、fallback、load balancing、conditional route 和 guardrail 可组合，适合提炼成当前项目的独立路由策略层。

### 明显不适合直接照搬

- README 同时服务开源 gateway、hosted gateway 和 enterprise 产品；“1600+ models”“<1ms”“10B tokens/day”等是项目自述，不应当作为当前项目的性能或规模基线。
- 查询日仓库最后 push 在 2026-05-25，但 latest release 在 2026-01-12，且 README 提到 2.0 pre-release；应固定 commit/release 评估，不能只跟随 main。
- 其 Cloudflare/Node 多部署与企业 guardrail 组合不适合当前本地单进程网关的最小目标。

### 关键来源

- [README](https://github.com/Portkey-AI/gateway/blob/main/README.md)
- [handlerUtils.ts](https://github.com/Portkey-AI/gateway/blob/main/src/handlers/handlerUtils.ts)
- [Anthropic provider implementation](https://github.com/Portkey-AI/gateway/tree/main/src/providers/anthropic)
- [最新 release v1.15.2](https://github.com/Portkey-AI/gateway/releases/tag/v1.15.2)
- [GitHub API 仓库快照](https://api.github.com/repos/Portkey-AI/gateway)

## 5. Bifrost

- **仓库：** [maximhq/bifrost](https://github.com/maximhq/bifrost)
- **Star：** 8,335；Apache-2.0；Go；默认分支 dev。
- **维护信号：** 查询日仓库 API 的 pushed_at 为 2026-09-25；latest release API 返回 [ent-v2.2.3-base](https://github.com/maximhq/bifrost/releases/tag/ent-v2.2.3-base)，发布于 2026-09-24。该 release 名称包含 ent/base，使用前应确认 OSS 发行物和 enterprise base 的边界。

### 核心能力

Bifrost 将 23+ provider 统一为 OpenAI-compatible API，同时保留 Anthropic、Bedrock、Vertex 等 drop-in 路径。README 列出 automatic fallback、load balancing、semantic caching、MCP、governance、budget、Prometheus/tracing/logging，以及 OpenAI/Anthropic/Bedrock/GenAI SDK integration。

它的官方源码搜索结果对当前场景尤其有价值：session affinity 使用 Claude Code、Codex CLI 或 OpenCode 已发送的 session header；先由 routing engine 生成 provider/key chain，再把上次成功服务该 session 的 provider/key 移到前面；fallback 失败后会重新绑定成功的 route。release/changelog 还专门记录 Claude Code auto-mode 的 safeguards、safeguard_results、beta headers 和未知 Anthropic SSE event 的 passthrough 规则。

### 适合借鉴

- **session affinity 独立于普通路由：** 先完成 route selection，再在不违反 route exclusion 的前提下做 session reorder；这是 coding agent 保持 prompt cache、rate-limit bucket 和会话行为稳定的好模型。
- **provider 与 key 两级路由：** provider fallback 和 key pool/load balancing 分开处理，适合当前项目从“provider 轮换”扩展到“同 provider 多 key”。
- **失败后再绑定：** session binding 只在请求实际成功服务后更新，失败跟随的 binding 会被丢弃；这比在尝试开始时绑定更不容易污染后续会话。
- **Claude Code 特性按 provider 能力过滤：** direct Anthropic 才透传 safeguards/beta/unknown SSE，其他 provider 则剥离或转换；这比无条件复制 header 更安全。

### 明显不适合直接照搬

- Bifrost 的性能、cluster、enterprise governance 和 provider 数量带来很大的系统边界；当前项目更需要正确的 Claude streaming/usage/error semantics，而不是完整企业控制面。
- 默认分支是 dev，release 命名包含 enterprise base；应把源码 commit、OSS license、可部署 artifact 和企业功能边界锁定后再评估。
- Go SDK/core 的并发与插件设计不能直接映射到当前 Node 运行时；更适合迁移 routing semantics 和测试思想，而不是迁移代码结构。

### 关键来源

- [README](https://github.com/maximhq/bifrost/blob/dev/README.md)
- [Session affinity 官方文档](https://github.com/maximhq/bifrost/blob/dev/docs/providers/session-affinity.mdx)
- [Provider routing 官方文档](https://github.com/maximhq/bifrost/blob/dev/docs/providers/provider-routing.mdx)
- [Routing rules 官方文档](https://github.com/maximhq/bifrost/blob/dev/docs/providers/routing-rules.mdx)
- [Anthropic provider utils](https://github.com/maximhq/bifrost/blob/dev/core/providers/anthropic/utils.go)
- [Claude Code auto-mode release/changelog](https://github.com/maximhq/bifrost/blob/dev/docs/changelogs/v2.2.2.mdx)
- [最新 release ent-v2.2.3-base](https://github.com/maximhq/bifrost/releases/tag/ent-v2.2.3-base)
- [GitHub API 仓库快照](https://api.github.com/repos/maximhq/bifrost)

## 6. New API

- **仓库：** [QuantumNous/new-api](https://github.com/QuantumNous/new-api)
- **Star：** 48,865；AGPL-3.0；Go；默认分支 main。
- **维护信号：** 查询日仓库 API 的 pushed_at 为 2026-09-23；最新 release 为 [v1.0.0-rc.40](https://github.com/QuantumNous/new-api/releases/tag/v1.0.0-rc.40)，发布于 2026-09-21。

### 核心能力

New API 将 upstream model services 接入统一 API，为应用、agent 和团队提供模型访问、路由、权限、usage/cost 与 web console。README 明确支持 OpenAI Chat Completions/Responses、Anthropic Messages、Gemini、Azure OpenAI、Bedrock 等，并支持 model mappings、channel priorities/weights、retries、channel affinity 和 multiple upstream keys。

源码结构把 relay/ 作为 upstream adapters/request routing 层；其中有独立 claude_handler.go、Responses/Chat 转换、WebSocket、channel adapter 以及大量 provider channel。Claude handler 的实现包含 model mapping、reasoning suffix、system prompt 注入、Claude-to-Responses 转换、pass-through body、参数覆盖、stream detection、status mapping、response adapter 和 quota accounting。

最新 release 还修复/强化了 Claude 与 Responses tool result 图片的保真转发，说明它对跨协议工具和多媒体兼容有较多实际处理。

### 适合借鉴

- **协议适配器目录：** relay/claude_handler.go、relay/channel/、relaykit 的分层适合参考“入站协议 -> 路由/渠道 -> 出站协议 -> 响应转换”的组织方式。
- **pass-through 与转换双路径：** 对兼容上游可以保留原 body；对不兼容上游再做转换，避免所有请求都经过不必要的重写。
- **Claude tool/media 回归点：** system prompt、reasoning、tool result image、SSE/WebSocket、status mapping 都值得纳入当前项目的 provider contract tests。
- **channel priority/weight/affinity：** 这些管理语义可以作为未来 provider pool 设计的参考，但应压缩到当前本地配置模型。

### 明显不适合直接照搬

- AGPLv3 会对分发和修改后的服务边界产生重要影响；当前项目若借鉴代码而非抽象思想，必须先做许可证审查。
- New API 是面向公共/团队分发的完整管理系统，含用户、渠道、配额、计费、任务插件和 web console；它不是当前本地回环网关所需的最小运行时。
- 多种协议和 provider 的转换矩阵会放大回归面；当前项目应优先保证原生 Anthropic path 的字节/事件语义，再逐步增加兼容转换。

### 关键来源

- [README](https://github.com/QuantumNous/new-api/blob/main/README.md)
- [Claude relay handler](https://github.com/QuantumNous/new-api/blob/main/relay/claude_handler.go)
- [Relay/channel adapter](https://github.com/QuantumNous/new-api/blob/main/relay/channel/adapter.go)
- [Relay directory](https://github.com/QuantumNous/new-api/tree/main/relay)
- [v1.0.0-rc.40 release](https://github.com/QuantumNous/new-api/releases/tag/v1.0.0-rc.40)
- [GitHub API 仓库快照](https://api.github.com/repos/QuantumNous/new-api)

## 7. Helicone

- **仓库：** [Helicone/helicone](https://github.com/Helicone/helicone)
- **Star：** 6,176；Apache-2.0；TypeScript；默认分支 main。
- **维护信号：** 查询日仓库 API 的 pushed_at 为 2026-09-16；GitHub latest release 页面显示 [v2025.08.21-1](https://github.com/Helicone/helicone/releases/tag/v2025.08.21-1)，发布于 2025-08-21；这与仓库近期 push 并不等价，说明 release cadence 需要单独关注。

### 核心能力

Helicone 将 AI Gateway 与 LLM observability 合在一起：README 描述 100+ model、intelligent routing、automatic fallbacks、cost/latency/session/trace、prompt management、playground 和 self-hosting。架构由 Web、Worker、Jawn、Supabase、ClickHouse、Minio 等多个服务组成。

其 gateway 源码的 AttemptBuilder 将 model string 解析为 provider/model，按 provider registry 构造 attempts，并区分 BYOK 与 PTB，最后按 provider priority 排序；这说明它把“候选 provider/key attempt”作为一等对象，而不是在一次请求中只选一个 provider。

### 适合借鉴

- **attempt-first 路由模型：** 先构造候选 attempt，再统一排序/执行/记录，适合未来加入 provider key pool、fallback、BYOK 优先和显式 provider route。
- **路由与追踪关联：** attempt builder 直接创建 trace span，路由过程有 provider/model/attempt 维度，适合当前项目强化 request id、resolved route、latency、usage 和 cost 的关联。
- **BYOK/PTB 优先级分层：** 即使当前项目只做 BYOK，也可借鉴“不同凭据来源有明确优先级和审计记录”的思路。

### 明显不适合直接照搬

- Helicone 的中心价值是 observability platform，而不是单机透明代理；完整自托管需要数据库、对象存储、多个服务和 web platform。
- 其 gateway 以 OpenAI-compatible entrypoint 和 hosted API 体验为主，Claude Code 原生 Anthropic headers/SSE/特殊字段的优先级不如 CCR/Bifrost。
- release 页面最新版本明显早于查询日，虽然仓库仍有 push，但不应只凭 star 或 README 选择为核心依赖。

### 关键来源

- [README](https://github.com/Helicone/helicone/blob/main/README.md)
- [AttemptBuilder.ts](https://github.com/Helicone/helicone/blob/main/worker/src/lib/ai-gateway/AttemptBuilder.ts)
- [Self-hosting / architecture section in README](https://github.com/Helicone/helicone/blob/main/README.md#self-hosting-open-source-llm-observability)
- [latest release](https://github.com/Helicone/helicone/releases/latest)
- [GitHub API 仓库快照](https://api.github.com/repos/Helicone/helicone)

## 对当前 claude-gateway 的建议优先级

### P0：保持并强化当前本地网关的原生 Claude path

- 保持 Anthropic Messages 原生请求/响应/SSE，不把 Claude Code 请求默认改写成 OpenAI Chat Completions。
- 继续把 header sanitation、provider auth、stream error、usage、cost 和 retryability 作为独立 contract；这是 CCR、LiteLLM、Portkey、Bifrost 和 New API 都反复暴露的共同难点。
- 对 fallback 维持“只对明确可重试错误执行”的策略，避免流式响应已开始或可能已计费时盲目重放。

### P1：借鉴 Bifrost/CCR 的路由语义

- 引入显式 route chain 概念：primary、fallbacks、key pool 和 resolved route 分离。
- 在请求成功后再写入 session/provider/key affinity；失败的尝试不能污染后续会话。
- 将路由配置先编译、校验并生成 diagnostics，再允许请求执行。
- 为 direct Anthropic 与兼容 provider 分别定义 header/body/SSE capability，不做全局无条件透传。

### P2：按需吸收 LiteLLM/New API/Helicone 的平台能力

- provider adapter 继续独立化，必要时支持 pass-through 与 conversion 两条路径。
- 增加 attempt-level usage/cost/latency 账本，区分“请求失败但已上报 usage”和“未收到 usage”。
- 只有在出现真实团队/多租户需求后，再考虑 virtual keys、管理 UI、Redis/Postgres、复杂 quota/billing 或完整 observability platform。

## 未纳入的项目

- **TensorZero：** GitHub API 查询时仓库标记为 archived，虽然 star 仍高，但不符合“当前可持续借鉴”的筛选条件。
- **普通 Anthropic proxy/账号转换项目：** 多数 star、维护信号或源码质量不足，且常把第三方账号/订阅转发与正规 API gateway 混在一起，不纳入高质量候选。
- **One API 原仓库：** 作为 New API 的历史基础仍有参考价值，但当前活跃度、协议覆盖和 Claude Code 相关性不如 QuantumNous/new-api，避免重复纳入。

## 查询记录

本笔记中的 GitHub 仓库元数据（stars、default branch、license、pushed_at、latest release）均在 **2026-09-25** 通过项目自己的 GitHub REST API 查询；能力与适合借鉴点来自各仓库在对应分支/文件链接中的 README、源码、官方文档和 release。由于 star、默认分支和 release 会变化，后续复查应重新获取 API 快照。
