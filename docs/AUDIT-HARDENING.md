# 网关补充审查与加固

日期：2026-09-25。本记录描述本轮实际检查和修改，不覆盖前一轮 AUDIT.md 的历史证据。

## 范围与方法

检查运行时配置、路由、三种适配器、统一传输、并发/重试、SSE、用量、进程管理和离线测试入口。先添加本机假上游回归再修改实现：最初 21 项测试均失败，修复后通过，随后增加端到端和压缩/头部测试。没有调用收费 selftest、probe 或诊断模型。

目录不是 Git 仓库，也没有 CodeGraph 索引。未修改真实 providers.json、.env 或 Claude Code 配置。审查期间管理 CLI 存在外部修改：首轮日志用例失败，读取更新后的脚本再次验证 19 项通过；保留该修改，不把它记为本轮实现。

## 发现与处理

| 优先级 | 发现 | 修复与证据 |
|---|---|---|
| P1 | 配置了 env 代理但变量缺失会自动直连 | 配置解析改为 fail-closed；缺失变量用例启动前报错 |
| P1 | `[DONE]` 被当作完成证明，即使工具流没有 finish_reason | 流式和非流式都要求 choice 0 的完成原因；不完整工具流只报错，不产生可执行 tool_use 或 message_stop |
| P1 | 叠加压缩返回原始压缩字节，下游可能收到损坏 JSON/SSE | 逆序 pipeline 解码；未知编码明确失败，标记 response-headers / beforeSend=false；测试覆盖四种运行时支持的编码、坏数据和叠加编码 |
| P2 | 指纹依赖手填配置，混合 provider、新模型、Anthropic 兼容 GPT 等路径不一致 | 默认按二次映射后的目标模型自动选择；保留显式覆盖；生成、计数、发现统一策略 |
| P2 | Codex installation ID 每请求变化，重试也重新生成逻辑请求身份 | installation ID 进程稳定；请求上下文在重试循环外建立；假上游两次请求头逐项相等 |
| P2 | OpenAI/Gemini Claude 头白名单遗漏 timeout/session 等字段，不处理 Connection 指定头 | 共用端到端过滤和动态客户端头前缀；Codex 与 Claude 头不混用 |
| P2 | 大小写不同的 extraHeaders 与默认头并存，被 Headers 合并为逗号连接值 | 以 Headers.set 语义统一覆盖；两种协议、两种 profile 回归 |
| P2 | Anthropic 模型发现默认发双鉴权，requireKey:false 仍在入口被拒绝 | 复用统一鉴权生成器；无 key 且明确可选时不生成鉴权；模型发现读取限制 4MiB |
| P2 | 未上报 usage 伪装为上报零；仅含 output 的后续 usage 清零输入/缓存 | 空 usage 保持未上报；先合并原始 usage 再换算；对外协议零值与账本来源分离 |
| P2 | 缓冲 SSE 取 choices[0]，流式却选 index=0；原生 SSE 统计只认单行 LF | choice 统一；共用有界 UTF-8/CR/CRLF/多行 data 解析，空 data 行也计入事件上限 |

## 验证

`scripts/test-hardening.mjs` 包括：自动识别六类 OpenAI 命名、四类非 OpenAI 命名、显式覆盖、身份生命周期、逐跳头、大小写覆盖、单鉴权、叠加解码、未知编码、四种解码错误、UTF-8/换行、缺失完成原因、choice 选择、未上报/分片 usage、缺失代理，以及网关级别名二次映射/429 重试/可选鉴权/计数/Gemini 路径/原生 SSE 账本。

最终 `npm test` 退出码 0：node:test 104/104（含本轮新增 29 项），limiter 41/41，CONNECT 9/9，断开取消 13/13，Anthropic 兼容、Codex 适配和 HTTP 退避检查均通过。42 个 JS/MJS 文件逐个 `node --check` 通过。计数采用各脚本自己的断言/用例口径，不相加为独立缺陷数。

原有用量、日志和管理测试全部保留在 npm test；旧固定端口脚本仍顺序运行。新端到端测试使用系统分配端口和临时配置，子进程退出后清理。最后只读健康核验中常驻实例 PID 42832、启动时间 2026-09-25T01:48:31.320Z、activeRequests=0，真实配置仍为 6 个 provider / 15 条路由。该进程尚未加载本轮运行时修改。

## 剩余边界

- 不把本地故障注入通过等同于 anyrouter 或其他真实上游网络长期稳定。发送后断开仍不自动重放，也无法撤销上游已发生的计费。
- 保留原项目 429/503/529 的有限状态重试约定；503 本身不能证明上游尚未计费。不信任该上游的计费语义时使用 maxAttempts:1；不要把所有 reset 都改为可重试。
- Codex 是既有头部模板的兼容 profile，不是官方身份认证或 TLS/HTTP2 指纹。没有改成 Responses 协议，没有更新模板版本来冒充最新客户端；未知自定义模型名须显式设置 profile。
- Claude 头来自真实客户端，普通脚本无 Claude UA 时不会生成该 UA。extraHeaders 是可信管理员覆盖，仍可显式改变身份或鉴权。
- HTTPS CONNECT 每请求使用私有隧道 Agent；keepAlive:true 只在直连和 HTTP 正向代理路径复用 socket，不代表 HTTPS 隧道池。本轮未新增隧道池。
- zstd 取决于 Node 的解码器能力；不支持时明确失败而非返回乱码。解码链背压不等于整个进程的硬内存上限。
- Anthropic SSE 仍按原字节转发，新增解析用于记账与错误标记，不会向客户端伪造成功事件。非流式请求被上游强制返回原生 Anthropic SSE 的既有透传行为未改变。
- 非 Anthropic 图片仍为文字占位；MCP、视觉、任意厂商新块类型未扩展。这里只审查和加固已有功能。
- 管理器停止前的空闲检查仍是快照，未实现原子排空；无需费用的 /health 只说明本地服务存活。本轮没有重启常驻网关，运行时修改需要重启后生效。
