# 网关实现审查与优化

日期：2026-09-25（本机日期；部分日志使用 UTC，显示 2026-09-24）。

## 结论与证据边界

已检查全部运行时模块、管理入口、自检与模型探针，并对断连、协议转换和资源生命周期进行了本地故障注入。没有发送收费推理请求，没有更改真实密钥、provider 路由或 Claude Code 主配置。

1. **确认的缺陷：CONNECT 后绕过隧道。** 原实现给 `https.request` 同时传 `agent:false` 和请求级 `createConnection`，后者未让请求使用已经建立的 TLS 隧道。已有测试把目标设为本机可直接连接地址，掩盖了这一问题。新增“只能由代理解析的域名”测试修复前失败，修复后通过。现在私有 Agent 绑定已经认证的 TLS socket。
2. **确认的部署问题：磁盘代码没有加载进常驻进程。** 检查时 PID 24776 启动于本机 2026-09-24 23:44:37，而传输层及并发控制在之后修改。新增健康信息和管理状态提示，帮助识别旧进程。
3. **不能认定历史 OpenAI 断连已彻底根治。** 当前 `openai` provider 没有配置代理；因此 CONNECT 缺陷不能直接解释其历史 `UND_ERR_SOCKET`。历史日志不足以区分上游主动关闭、链路设备、旧连接复用或运行时版本。现有本地测试证明“发送后断连不重放、不拖垮进程、取消可传播”，不证明真实上游永不掉线。
4. **没有用盲目重试隐藏 502。** 发送后断连、等待响应超时、502/504 继续保守失败；响应头带 `x-should-retry:false`，流中途失败不会伪装为成功。发送前错误和有限的 429/503/529 保留重试，并尊重上游显式禁止重试。

## 功能审查矩阵

| 功能 | 审查/优化结果 | 验证与边界 |
|---|---|---|
| 配置与环境变量 | 管理器与服务统一使用环境变量优先于 dotenv；校验 provider 唯一性、URL、API 类型、并发、次数、超时、默认路由 | 真实 6 providers / 15 routes 可加载；非法值在启动时失败 |
| 路由和二次模型映射 | 保留精确路由→provider 映射→默认 provider 顺序；映射仅查自身键；计数与生成应用相同目标模型 | 本地生成、模型列表和计数映射测试 |
| Anthropic 透传 | 保留原客户端版本/beta/其他端到端头，替换鉴权；去除固定及 Connection 指定的逐跳头 | 原始 Accept、JSON→SSE 兼容、断流和客户端取消测试 |
| OpenAI 适配 | 工具结果不再吞掉同条用户消息中的文字；JSON 响应到 stream 请求自动转 SSE；校验完成对象 | 混合消息、Codex、JSON/SSE、畸形响应测试 |
| 工具调用 | 流式分片名称/参数正确拼接；block index 唯一 | 工具块等拼接完整后发送，文字仍增量发送；不承诺工具参数逐 token 到达 |
| Gemini | 保留 OpenAI 兼容 URL 与系列身份适配，复用统一 SSE 聚合器 | 本地 URL/系列/非流式 SSE 测试；未验证远程 Google 服务 |
| 客户端头与 Codex profile | 保留原 profile 配置及动态请求 ID；没有改成 Responses API | 原 Codex 适配器回归通过；profile 仍为既有兼容行为，不代表客户端身份认证 |
| SSE 解析 | 共用 UTF-8 分帧；支持 LF/CRLF/CR、多行 data；上游错误、畸形 JSON、缺失完成标记和不完整尾帧不再产生成功结束 | 流式/非流式故障注入均通过 |
| 直连与 CONNECT | 默认保留每请求独立 socket/TCP keepalive；修复真实代理隧道使用与异常接收保护；205 无体响应不会抛未捕获异常 | CONNECT、TLS 阶段、代理认证、reset、取消与205测试 |
| 解压与背压 | gzip 解码流取消会销毁原上游；写下游遇背压等待 drain；转换流按拉取生产；toWeb 按字节设置64KiB队列阈值 | 慢消费者不读时上游 pull≤3；gzip 取消关闭真实连接。这不是全进程内存上限或吞吐跑分 |
| 缓冲限制 | JSON 整包默认64MiB；错误体64KiB；单SSE事件和单工具参数有字符数上限；非流式SSE累计64Mi字符上限 | 超限取消而非默默伪装成功；中文/JS字符串内存不等同字节数 |
| 并发闸门 | 令牌直到成功或错误响应体被消费/取消后释放；原队列取消、公平交接、幂等release保留 | 41项 limiter 检查 |
| 退避与超时 | 不再把60秒Retry-After压成20秒；整体请求期限可由requestTimeoutMs调整；显式禁止重试优先 | 安全连接错误、发送后reset、冷却期、排队取消测试 |
| token计数 | Anthropic计数也受并发/取消限制；使用二次模型映射；失败估算包含tools | 仍是字符近似，不是各模型官方tokenizer |
| 鉴权和错误 | 客户端鉴权采用等长定时安全比较；非法JSON/结构返回400；健康接口不再暴露密钥前缀；已知密钥脱敏 | 错误反射、health、未授权模型列表测试 |
| 健康/观测 | health增加pid、instanceId、startedAt、transport、activeRequests；gate-stats保持鉴权；日志开关生效 | health只表示进程活着，不等价于全部上游可用 |
| start/stop/restart/status | 修正环境优先级；启动校验健康服务和PID，关闭父进程日志FD；停止拒绝无法验证/仍忙的进程；提示源码比进程新 | 在复制项目与临时端口上测试，不触碰真实设置 |
| 配置模式切换 | 先验证，临时文件加rename替换；恢复有效直连备份；保留当前网关配置 | 在临时目录测试破损文件、坏备份、往返切换；未切换用户真实模式 |
| 自检/模型探针 | 新增npm test离线入口；模型探针使用同一传输、鉴权和路径规则且不显示key前缀 | selftest仍会调用真实路由并产生费用，本次未运行 |
| 历史诊断脚本 | 已定位其入口与网络/写入行为；未批量执行旧diag/probe实验脚本 | 部分仍使用直接fetch、固定端口或实验指纹，不能作为生产传输链路验证，不计入自动回归入口 |

## 已执行验证

环境：Windows，Node v24.14.0。

- 新CONNECT测试：修复前8通过/1失败，修复后9通过。
- 第一批审查回归：修复前19项中2通过/17失败（包括聚合父项），修复后全部通过。
- 补充显式no-retry测试：修复前1失败，修复后通过。
- 当前审查、运行管理及补充测试：45项通过。上一轮11项补充测试覆盖TLS/CONNECT建连期限、生成阶段不受建连期限干扰、发送后reset诊断和工具参数校验；该批次修复前2通过/9失败，修复后11项全通过。
- 本轮新增3项端到端测试，覆盖TLS建连超时、等待响应头超时、读取响应体超时。复现了等待响应头超时丢失阶段、响应体超时误报502两项失败；修复后审查测试24项全部通过。发送后的两个停滞场景均确认只向上游发送1次，结束后并发闸门active=0、waiting=0。
- `npm test` 完整离线入口：新45项 + limiter41项 + CONNECT9项 + Anthropic兼容5项 + Codex适配器 + 断流13项 + HTTP重试3项，全部通过。各脚本计数口径不同，不把它们合称独立漏洞数量。
- 超时排障：在尚未发送下游响应头时，建连及整体请求截止时间超时返回504、`timeout_error`；发送后reset仍返回502。错误响应包含 `x-upstream-phase`，有可测时长时包含 `x-upstream-elapsed-ms`；日志补充direct/proxy路径。整体期限耗尽或发送状态不明时保留 `x-should-retry:false`。SSE已开始后不能改写HTTP状态，仍按流式错误/断开语义处理。
- 计时口径：响应头前的耗时来自本次transport尝试；响应体阶段从当前尝试开始计时。不把这些数字当作含排队和全部重试的总耗时；无可靠阶段证据时仍显示unknown。
- 新增 `connectTimeoutMs`（默认30000）：仅限制建立TCP/CONNECT/TLS的阶段，连接就绪后停止计时，保留原整体请求期限。工具参数必须为合法JSON对象，损坏的参数不再替换成 `_raw` 后作为工具调用输出。
- 全部JS/MJS语法检查通过。
- 测试上游均本机模拟，不包含真实付费provider可用性、长时压测或所有Node版本兼容认证。

## Verification Plan 与安全检查

新代码先建立失败测试，后修复并复跑；检查鉴权、TLS、密钥脱敏、连接取消、并发令牌、缓冲和文件替换。SecureCoder sidecar不存在且API环境变量为空，依技能规则跳过自动扫描；**不能称自动扫描通过或零漏洞**。人工安全检查与剩余风险见 [安全记录](walkthrough.md)。

## 明确保留的限制

- 非Anthropic图片仍按现有行为降级，未新增视觉、Responses API、原生MCP、模型账单或跨provider缓存。
- Anthropic原生SSE按字节透传，不新增事件级完整性检查。非流式请求收到原生Anthropic SSE仍由客户端决定如何处理。
- 503并不从协议上保证从未处理；当前重试策略延续项目约定。若某上游计费语义不同，应设maxAttempts=1。
- 本地健康接口仍公开路由/上游地址；默认token兼容行为仍在。不要公开到局域网或公网。
- 同步日志尾读取、旧测试固定端口、历史诊断脚本重复与并发管理器启动竞态尚未全面重构。测试入口顺序运行固定端口旧测试。
- 原allowInsecureTls字段没有实际生效；现在显式拒绝true，不默默关闭验证。自签测试关闭校验仅在独立测试进程；生产未降低TLS安全性。
- stop的忙闲检查是快照，不是跨进程原子排空；重启应避开持续产生新请求的客户端。

## 备份与恢复

目录当时不是 Git 仓库。修改前源码快照位于本机临时目录 `C:\Users\33231\AppData\Local\Temp\claude-gateway-audit-20260925-012309`（旧项目名历史路径），不含真实 `.env` / provider 配置。快照在新增第一条 CONNECT 回归之后、生产源码修改之前建立。恢复时仅覆盖本次改动的源码、脚本和文档，保留密钥、路由与日志；确认没有在途请求后重启。

## 运行实例

已完成部署：先核对旧进程 PID 5936 及 4100 端口归属，确认所有 provider 闸门 active=0、waiting=0 后停止旧实例。新实例 PID 43820 于 2026-09-24T19:32:01.591Z 启动，继续监听 127.0.0.1:4100。健康核验记录中的 `service=claude-gateway` 是当时的旧服务标识，当前标识为 `service=slizm-gateway`；transport=node-http-connect-v2、activeRequests=0，原有 15 条路由保留；未授权模型列表返回 401，非法 JSON 请求返回 400。未发送真实付费推理请求，因此该验证不等同于远程上游推理链路的长期稳定性认证。

## 已查阅的开源参考

根据用户随后要求，优先完成原始修复，不继续扩大调研。已通过GitHub API查阅以下固定提交源码，主要用于核对重试边界、头部过滤、流式终止与资源生命周期；没有直接复制其实现，也没有引入跨模型自动fallback。

- [Claude Code Router重试策略](https://github.com/musistudio/claude-code-router/blob/75e9e750c134acc389eab00bc131c6cd625ba614/packages/core/src/gateway/upstream/retry-policy.ts)：状态重试与Retry-After处理。本站保留更保守的发送后不重试约定，不照搬其时间封顶。
- [Claude Code Router头部清理](https://github.com/musistudio/claude-code-router/blob/75e9e750c134acc389eab00bc131c6cd625ba614/packages/core/src/gateway/core-runtime/upstream-header-sanitizer.ts)：逐跳头、鉴权及代理元数据的清理边界。
- [CLIProxyAPI流式终止测试](https://github.com/router-for-me/CLIProxyAPI/blob/c404af96ebacedf8168b3c2bdbf4449a21cd1c1e/internal/runtime/executor/claude_executor_stream_terminal_test.go)：区分终止事件已收到与随后连接关闭。这里只作为审查参考，未新增Anthropic原生流事件级解析。
- [CLIProxyAPI传输缓存](https://github.com/router-for-me/CLIProxyAPI/blob/c404af96ebacedf8168b3c2bdbf4449a21cd1c1e/internal/runtime/executor/helps/transport_cache.go)：有界缓存及空闲连接回收。本站未照搬缓存架构，保留默认关闭跨请求socket复用。
