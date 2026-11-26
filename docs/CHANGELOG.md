# 变更与排障记录

按时间倒序。每条写清：现象 → 根因（附证据） → 改动 → 验证。需要查本阶段逐步实施、遇到的问题和验证过程时，见 [2026-09-25 日志展示会话记录](SESSION-2026-09-25-LOG-DISPLAY.md)。

---

## 2026-11-08

### 启动后只保留一个应用窗口，不再常驻命令行黑框

**现象**：双击 `start.cmd` 后，除了管理页和控制面板，桌面上还长期留着一个标题为 `powershell.exe` 的 Windows Terminal 黑框。关掉它不影响服务，但每次启动都会再出现一个；管理页本身则是浏览器里多出来的一个标签页。

**根因**：
- `start.cmd` 用 `start "" powershell.exe … -WindowStyle Hidden -File scripts\control-panel.ps1 -AutoStart` 拉起 WinForms 面板。Windows 11 的默认终端是 Windows Terminal：控制台进程先交给 `OpenConsole.exe`，再由 `WindowsTerminal.exe` 显示成窗口，`-WindowStyle Hidden` 只对传统 conhost 生效，所以 WT 窗口一直留在桌面上，直到面板进程退出——而面板是常驻的。
- 证据：进程树里 `powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File …\scripts\control-panel.ps1 -AutoStart`（pid 28804）伴随 `conhost.exe`（pid 9120），默认终端交接出 `WindowsTerminal.exe`（pid 41444）的 `powershell.exe` 窗口；`EnumWindows` 枚举到的可见顶层窗口同时含「Slizm Gateway 控制台」和这个黑框。结束面板进程后，conhost / OpenConsole / WT 三个进程一起消失、窗口随之关闭，说明黑框就是面板的控制台宿主。
- 管理页用 `rundll32 url.dll,FileProtocolHandler` 打开，只能是默认浏览器里的一个标签页，做不成「一个应用页面」。

**改动**：
- 新增 `start.vbs`（纯 ASCII，由 wscript 托管，不产生控制台宿主进程）：解析 node（PATH → `%ProgramFiles%\nodejs` → `%ProgramFiles(x86)%\nodejs` → `%LOCALAPPDATA%\Programs\nodejs` → nvm-windows），把工作目录切到项目根，用隐藏窗口执行 `gw.js up`，stdout/stderr 覆盖写入 `logs/launcher.log`；退出码非 0 时弹窗给出英文提示和 UTF-8 日志尾部（`ADODB.Stream` 读取），不再静默失败。
- `start.cmd` 改为薄壳：`start "" wscript.exe //Nologo "%~dp0start.vbs"` 后立即 `exit /b 0`，不再拉起 PowerShell 与 WinForms 面板。
- `src/admin/lifecycle.js`：新增导出 `resolveAppBrowser()`，在 Windows 上按 Chrome → Edge 顺序查找浏览器，以 `--app=<管理页地址> --no-first-run --no-default-browser-check` 打开；`openBrowser()` 先走应用窗口，spawn 失败或设置 `GATEWAY_WEB_BROWSER=default` 时退回原来的默认浏览器方式。管理页因此是一个没有地址栏和标签栏的独立窗口，启动完成后桌面上只多出它。
- `scripts/control-panel.ps1` 与 `npm run panel` / `panel:start` 保留为可选控制面板，不再参与启动流程；README 相应改写启动入口说明。
- 重写 `scripts/test-launcher.mjs`：保留控制台编码、动词拼接、命令表和 `Complete-Command` 断言；新增 `start.cmd` 只转交 wscript、`start.vbs` 纯 ASCII 且以隐藏窗口等待 `gw.js up`、`logs/launcher.log`、`resolveAppBrowser` 的选择顺序与禁用场景；再用桩 `scripts/gw.js` 真跑一次 `start.vbs`（断言 argv、工作目录与日志），不复制 node_modules 也不占用真实端口。

**验证**：
- 本机（Windows 11，默认终端 Windows Terminal）双击 `start.vbs`：wscript 1.1 秒退出（退出码 0），`EnumWindows` 前后对比仅新增一个可见窗口「Slizm Gateway 控制台」，标题没有 ` - Google Chrome` 后缀（应用模式特征），`WindowsTerminal.exe` / `OpenConsole.exe` 一个都没有；`logs/launcher.log` 以 `✓ 一键启动完成 · Web http://127.0.0.1:48731/` 收尾。截图见 `screenshots/start-vbs-app-window.png`。
- `npm run test:launcher` 9 项通过，`npm run test:lifecycle` 3 项通过，`npm test` 退出码 0。首次整跑时 `test-anthropic-compat.mjs` 触发过一次 Windows libuv 断言崩溃（`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76`），该文件单跑 3 次和整套重跑均通过，与本次改动无关。

---

## 2026-10-31

### 网关停用后 `start.cmd` 起不来

**现象**：网关完全停止（没有 `logs/gateway.pid`、4100 端口未监听）时双击 `start.cmd`，控制窗口会弹出「操作失败：启动失败，进程 … 没能就绪」，端口始终没起来。网关已在运行时反而一切正常，因为 `-AutoStart` 看到服务齐全就不再执行启动命令，这条路径从未被走到。

**根因**：
- `scripts/control-panel.ps1` 的 `Start-GatewayCommand` 拼参数时写成 `$allArguments = @($script:GwScript) + $Arguments`，把 `$Kind`（命令动词）漏了，实际执行的是 `node scripts/gw.js --no-open`。证据：隔离副本启动后 `%TEMP%\slizm-gateway-panel-<pid>.out.log` 首行是 `未知命令: --no-open`，后面跟着 gw.js 帮助文本，端口未监听。
- 即使命令成功也会显示失败：Windows PowerShell 5.1 下 `Start-Process -RedirectStandardOutput … -RedirectStandardError … -PassThru`（不带 `-Wait`）拿不到退出码，`HasExited=True` 时 `.ExitCode` 仍是 `$null`（失败的 `node -e "process.exit(3)"` 同样是 `$null`），`Complete-Command` 里 `$exitCode -eq 0` 永远不成立。
- 修这个脚本时行内编辑丢掉了 UTF-8 BOM，PowerShell 5.1 会按 ANSI（CP936）解析无 BOM 的 `.ps1`，中文串变乱码并连带 6 个语法错误；已补回 BOM 并统一为 CRLF。

**改动**：
- `scripts/control-panel.ps1`：命令行改为 `@($script:GwScript, $Kind) + $Arguments`，动词回到 gw.js 前面；新增 `Test-CommandOutcome`，成功与否以 `status --json` 回读的真实服务状态判定（`down` 要求网关与 Web 都已停、`open` 要求 Web 在跑、其余要求网关就绪且 Web 就绪或已禁用），`Complete-Command` 不再依赖退出码；补上被引用却未定义的 `$script:L.Port`。
- 新增 `scripts/test-launcher.mjs`，并入 `npm test`，也可单独 `npm run test:launcher`：检查 `start.cmd` 的隐藏启动与 `-AutoStart`、控制台的 BOM/CRLF 与动词拼接、按钮动词都在 gw.js 命令表里、`Complete-Command` 不读 `ExitCode`；再用 PowerShell AST 取出那条拼接语句，在真实解释器里求值，断言生成 `gw.js up --no-open` 这类命令行。

**验证**：隔离副本（端口 4188、`GATEWAY_WEB_ENABLED=0`，用与 `start.cmd` 相同的命令行启动）修复前日志为 `未知命令: --no-open`、端口未监听；修复后消息依次为「正在处理，请稍候」「服务已启动」，4188 正常监听、写入 `logs/gateway.pid`、`/health` 返回全部路由。把 `$Kind` 从拼接里去掉再跑新测试，动词拼接与动态命令行两条失败、其余 4 条通过；恢复后 `npm test` 退出码 0。

---

## 2026-10-25

### Windows 一键控制台与统一服务生命周期

**现象**：启动和查看状态需要反复使用 `gw.js` 命令；现有 `start.cmd` 会保留命令行窗口，停止与重启也没有一个同时覆盖网关和管理 Web 的日常入口。

**改动**：
- 新增 `scripts/control-panel.ps1`：Windows 原生 WinForms 小窗口，显示网关/Web 的 PID、地址、在途请求、运行时间和源码更新提示，并提供启动、停止、重启、打开 Web、打开日志目录和刷新按钮。
- `start.cmd` 改为隐藏启动控制窗口并自动确保缺失服务就绪，不再需要命令行窗口。
- `gw.js` 新增 `up`、`down`、`open`、`status --json` 和 `restart --all`；`restart` 仍只重启网关，避免管理页重启自身。
- 管理 Web 生命周期增加可查询状态，并清理已经退出进程留下的过期会话文件。
- 新增 `scripts/test-gw-lifecycle.mjs`，使用隔离端口和临时目录验证双服务启动、幂等、重启、停止及 Web 禁用场景。
- 修正控制窗口把 CLI 帮助文本和 ANSI 颜色码当成错误摘要显示的问题；错误现在会清理控制码并压缩为一行，详细内容保留在悬浮提示中。源码更新时高亮重启按钮，有在途请求时禁用停止和重启，底部状态栏显示更明确的服务组合与请求状态。

**验证**：`npm run test:lifecycle` 3 项通过，包含重定向 CLI 输出不泄漏 ANSI 控制码；Windows PowerShell 5.1 下控制窗口可创建并保持响应，`start.cmd` 能隐藏启动窗口并创建控制台进程。

---

## 2026-10-07

### DSH 响应契约与 Responses 转换补强

**现象**：上一轮把 DSH 的识别与凭据理清后，继续按 DSH 客户端实际的解析口径核对「网关产出的东西 DSH 能不能吃下去」，发现两类可用性缺口：上游给出**没有内容块的正常完成**时，网关转换出的 Anthropic 流会被 DSH 判成失败；以及 `messagesTransport: "responses"` 的 provider 会**直接 400 掉每一条 DSH 请求**。

**根因（附证据）**：判据是 DSH 实际在跑的客户端代码，不是文档推测。
- 已安装的 `@deepseek-ai/dsh-llm-deepseek` 0.2.0-rc.2 用 `translate()` 校验响应：`message_stop` 时若「零内容块且 stop_reason 为 end_turn」，直接抛 `DeepSeek Messages returned no content`（`EMPTY_RESPONSE`）；`parseSse()` 还要求 `event:` 名等于 `data.type`（已核对 asar 内确实包含这些判定字符串）。Anthropic 协议本身保证至少一个内容块，而网关的 `openAIToAnthropicStream` 在上游只回 `finish_reason`、没有任何正文时会产出零块流。
- `src/providers/messages-to-responses.js` 的 `buildResponsesBody` 有三条会命中 DSH 请求形状的拒绝：顶层 `thinking.type !== 'disabled'`（DSH 的 `WireRequest` **必带** `thinking`）、助手历史里的带签名 `thinking` 块、system 角色的 `tool_addition` / `tool_removal` 控制块。任一条都会让整条请求 400，所以该 provider 上的 DSH 会话无法工作。
- 同时核对了路由与流的两处「疑似缺口」，结论是不需要改：`openAIChunks` 已保证至少出现一个选择块，因此 `message_start` 必然先于内容事件；只有 usage、没有任何 choice 的流会按既有约定转成显式 `error` 事件（DSH 的 `parseSse` 遇到它会抛 `providerError`，不会把半截流转成成功）。

**改动**：
- `src/stream.js`：转换流收尾前若从未打开过内容块，补一个空文本块（`content_block_start` + `content_block_stop`），与 Anthropic「至少一个内容块」的约定和 DSH 的 `EMPTY_RESPONSE` 判定对齐。
- `src/providers/messages-to-responses.js`：接受并忽略顶层 `thinking`（不擅自补 `reasoning.effort`，避免不支持推理的上游 400）；跳过助手历史里的 `thinking` 块；system 消息只跳过 `tool_addition` / `tool_removal` 控制块、保留其中的文本；工具结果里的内联图片按聊天补全适配器的口径降级为文字标记，而不是让整条请求失败。其它未知块、未知图片源、`stop_sequences` 仍然照旧拒绝。

**验证**：
- `scripts/test-dsh-agent.mjs` 新增一个按 DSH `parseSse`/`translate` 规则写的流契约校验器（event 名与 `data.type` 一致、`message_start` 唯一且最先、块索引合法不重复、delta 只属于已打开的块、`message_stop` 前块已关闭且有 stop_reason、`end_turn` 不能零块），并用它校验三条实际转换路径：逐字节透传、JSON 应答转 SSE、空完成补块；另加一条断言确认「没有 choice 的流」保持为单个 `error` 事件。
- `scripts/test-messages-to-responses.mjs` 新增 DSH 请求形状用例（顶层 thinking、system 控制块、带签名思考历史、工具结果内联图片），并补充既有拒绝用例（未知图片源、工具结果里的未知块仍需报错）。
- `npm test` 退出码 0（node:test 24x/24x 全绿）。

**未做**：网关仍没有 `/v1/chat/completions` 入口，`llm-pi-ai` 的 `api: openai-completions` 提供方指过来会 404；DSH 可改用 `api: anthropic-messages` 或 `openai-responses`（见 README 的入口对照表）。补这个入口需要新增「OpenAI Chat ⇄ Anthropic Messages」双向转换与流桥接，属于独立功能，本轮未实现。

### DeepSeek Harness 识别与转发按真实客户端重新对齐

**现象**：网关预留的 “DeepSeek Harness 客户端接口” 与真实客户端不符。日志里 DSH 请求显示的是普通 DeepSeek 图标 `~(·)><`，`scripts/gw.js logs` 解析这个图标只会命中 DeepSeek 的客户端身份，两者在日志里无法区分；账本里 `deepseek-harness` 这个客户端从未出现过。测试与文档使用的指纹字段（`deepseek-harness/1.0.0`、`x-client-name`、`x-client-version`、`x-harness-*`）在真实客户端上并不存在。

**根因（附证据）**：判据是猜的，不是抓的。
- 实际在用的客户端是 `@deepseek-ai/dsh-llm` 0.2.0-rc.2（随 DeepSeek Harness 桌面版 `resources/app.asar` 打包）。其 `lib/types/attribution.js` 每个请求发 `user-agent: deepseek-harness/0.2.0-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)`；`@deepseek-ai/dsh-llm-deepseek/lib/index.js` 在 `${messagesApiRoot(baseURL)}/messages` 上固定带 `anthropic-version: 2023-06-01`、`x-deepseek-harness-user-id`（必带）、可选的 `x-deepseek-harness-session-id` / `x-deepseek-harness-compact: 1`，凭据由提供方决定：`dsh-llm-deepseek-api-key` 发 `x-api-key`，`dsh-llm-deepseek-account` 发 `x-dsh-auth-token`。`llm-pi-ai` 只发 attribution 的 UA，另加 `authorization: Bearer`。
- 显示层早就为 DSH 预留了独立身份：`scripts/gw.js` 的 `CLIENT_MASCOTS['deepseek-harness']` 用 `⬢[DSH]⬢` 别名解析、名称写 `DeepSeek Harness`，而 `src/server.js` 的 `CLIENT_BADGES` 给 DSH 发的是和 DeepSeek 相同的 `~(·)><`，解析回来必然还是 `deepseek`。
- `x-dsh-auth-token` 不在 `DROP_HEADERS` 里：DSH 账户凭据会被原样转发给第三方上游。
- 网关上没有任何 DSH 流量的证据（`usage-2026-09.jsonl` / `usage-2026-10.jsonl` 中 `clientType` 为 `deepseek-harness` 的记录为 0），说明这条链路此前没有按真实客户端验证过。

**改动**：
- `src/providers/client-headers.js`：识别改为照抄真实指纹（UA 产品标识、`x-deepseek-harness` / `x-deepseek-harness-*`、`x-dsh-auth-token`、`x-client-name: deepseek-harness`），并把 DSH 判定提到 Claude Code / Codex 启发式之前，避免带 Anthropic 风格头的 DSH 请求被抢走；删掉未经验证的 `x-harness-*` 前缀；把 `x-dsh-auth-token` 加入 `DROP_HEADERS`，与 `authorization` / `x-api-key` 一样在转发前换成上游 key。
- `src/server.js`：`checkClientAuth` 接受 `x-dsh-auth-token`（DSH 账户提供方使用的客户端凭据头）；`CLIENT_BADGES['deepseek-harness']` 改为 `⬢[DSH]⬢`，与 `gw.js logs` 已预留的图标对齐。
- `scripts/gw.js`：DSH 的展示图标同改为 `⬢[DSH]⬢`，启动横幅补上 DeepSeek Harness。
- `src/providers/openai.js`：显式注明 DeepSeek 协议独有的 `tool_addition` / `tool_removal` 与 `thinking` 块在聊天补全里没有对应字段、只丢弃顺序信号，工具定义仍随 `tools` 传给上游。

**验证**：
- `scripts/test-client-routing.mjs`：fixture 换成真实 DSH 请求头，新增识别矩阵（UA 路径、仅有 `x-deepseek-harness-*` 的白标路径、账户凭据路径、带 `x-app: cli` 不被抢占、`x-harness-*` 不再算 DSH）和 “账户凭据不出上游” 断言。
- 新增 `scripts/test-dsh-agent.mjs`：本地模拟上游上跑完整链路——逐字节透传（含 `dsh_session_log` / `dsh_plugin_packages`）、上游 SSE 原样回传、客户端凭据换成上游 key、`x-dsh-auth-token` 永不出站、错误凭据仍 401、OpenAI 路由丢弃 DeepSeek 独有顶层字段且控制块不变成文本、日志出现 `⬢[DSH]⬢` 且账本 3/3 条记为 `deepseek-harness`。
- `scripts/test-logging.mjs` 的图标断言改为 `⬢[DSH]⬢`。
- `npm test` 退出码 0。测试全部使用本地模拟上游，未调用真实模型。

---

## 2026-09-26

### Codex 直通请求正常完成却记为 `⊘ 499 客户端断开`

**现象**：修复 gemini 后 Codex 可正常对话，但日志仍是 `⊘ responses gemini · 499 · 3.2s · 客户端断开 · 输入 16.0k · 输出 34`；gpt-6-luna / gpt-6-astra / deepseek-slizm 的直通请求也大量出现带完整用量的 499。

**根因**：Codex 读到 `response.completed` 就关闭连接，不等流结束；sub2api 在发出该事件后还要 30~40ms 才结束流（实测 gemini 42ms、luna 31ms）。网关在上游收尾前看到客户端关闭，按取消记账。

**证据**：`gw_7b3b1778` 的 Codex 会话记录在 09:41:34.552 写入完整回复并 `task_complete`，网关 ⊘ 在 34.540；sub2api 对同一请求记 200。

**改动**：`src/server.js` 直通路径的 Responses 监视器记录终止事件（`response.completed` / `incomplete` / `failed` / `error`）；终止事件已写给客户端后的断开按正常结束记账（`←` 200，或上游失败时 `✗`），之前的断开仍记 `⊘ 499` 并立即取消上游。

**验证**：`scripts/test-responses.mjs` 新增“发完 completed 后延迟 500ms 收尾、客户端读到 completed 即断开”用例，旧逻辑下复现 `⊘ 499`，修复后为 `← 200`；`npm test` 退出码 0（node:test 125/125）。

### Codex 调 gemini 无响应：Codex 身份句被 Google 拒绝

**现象**：Codex Desktop 选 `gemini`（sub2api `gemini-3.8-flash-high`）连发 "hi" 都失败：网关日志全是 `↻ responses gemini … HTTP 503 No available accounts`，偶尔 `429 All available accounts are currently rate-limited`。同一时段 Claude Code 走 `/v1/messages` 调 gemini 正常 200。

**根因**：与 2026-09-24 的 scout 问题同类。Codex 的 `instructions` 首行固定是 `You are Codex, a coding agent based on GPT-5.`，Google Antigravity 返回不带细节的 `429 RESOURCE_EXHAUSTED`，sub2api 把唯一可调度的号（account 33 `google-pro`）的 `antigravity:gemini` 冷却 59 秒，之后的重试在 20ms 内直接 503。Codex 走 `/v1/responses` 直通路径，此前不经过 `adaptBodyForModelSeries`，且身份句正则只认 Claude/Anthropic。

**证据**：
- sub2api `ops_error_logs`：Codex Desktop 对 gemini 的 `/v1/responses` 共 4×429、39×503、1×502，零成功；Google 侧均为无 `QUOTA_EXHAUSTED` 细节的裸 429。`usage_logs` 中 gemini 成功全部来自 `/v1/chat/completions`。
- 对照实验（同 key、同端点、仅身份句不同）：`You are an AI coding agent.` → 200；`You are Codex, a coding agent based on GPT-5.` → 429。

**改动**：
- `src/model-series.js`：身份句正则扩展到 Codex / ChatGPT / GPT / OpenAI，`GPT-5.1` 这类紧跟非空白的点不算句末；`rewriteIdentity` 兼容 Responses 的 `input_text` 块；新增 `adaptResponsesBodyForModelSeries`，gemini 系列改写 `instructions` 与 system/developer 输入，无改动时返回原对象。
- `src/server.js`：Codex 直通路径先做系列适配；仅在实际改写时重新序列化，其余请求仍原样转发原始字节。日志标 `[gemini 适配]`。

**验证**：`npm test` 退出码 0（新增单元与直通集成断言）。用临时网关实例回放失败会话的真实 Codex 内容（完整 base_instructions + developer 消息 + "hi"）→ 200。回放不含 Codex 的 tools 定义，工具 schema 兼容性需以实际 Codex 使用为准。

---

## 2026-09-25

### 终端日志展示：紧凑布局、请求筛选、详细与原始模式

**需求基线**：用户要求优化日志展示并继续实现。仅修改管理 CLI 的展示和对应测试、说明；不改变服务端日志格式、路由、密钥或请求处理。

**实现与追溯**：
- DOC-001（展示）：默认按日期分组，显示时间、状态、路由、8 位请求 ID 和详情；区分开始、成功、失败、警告、重试、取消。中文和长字段折行而非省略；不足 100 列使用窄屏布局，`--width` 支持 40..240 列。成功记录的首字节/总耗时、输入 token、缓存读写 token、输出 token 和费用分别使用青/蓝/品红/绿/黄突出，失败或上游异常整段突出；指标标签与数值保持同一折行单元。旧格式和未知记录保留正文，不推断状态。
- DOC-002（筛选）：`--id` 支持完整 ID / 8 位简写，`--route` 精确匹配；与 `-e`、`-f` 组合。先筛选再取 n 条，n 是匹配的非空源日志行数，限定 1..10000，检索范围为 stdout 末尾 2MB。非法参数和冲突模式非零退出。
- DOC-003（诊断与兼容）：`--detail` 保留完整行布局并转换旧 UTC 时间；`--raw` 只输出 stdout 原始行，不附加标题、颜色或 stderr，不转换时间及清理原文控制字符。原始模式不兼容 `--detail` / `--history`。普通视图清理终端控制序列，日志着色遵守 NO_COLOR / FORCE_COLOR。历史 stderr 继续默认折叠，当前或无法确认归属的错误仍保留，单列为进程级诊断、不参与请求筛选。
- DOC-004（持续跟随）：普通查看与跟随共享筛选、渲染逻辑；初始快照的字节位置、UTF-8 解码器和未完成行传入跟随阶段，避免丢失半行；每次增量读取最多 256KB，文件截短后重置。仍只跟随 stdout，未实现 stderr 实时跟随或全屏仪表盘。

**修改范围与影响审计**：`scripts/gw.js`、`scripts/test-logging.mjs`、`README.md`、本记录；无新增运行依赖。项目无 `.codegraph/`，以直接源码读取和调用点搜索完成编辑前后审计；保留启动失败诊断对 `tailLog` 的调用，以及其他管理命令、现有用量与价格功能。项目根目录未发现 Git 元数据，未执行 commit / push。

**验证**：
- 新增默认紧凑视图断言在旧实现上失败；实现后定向 CLI 回归 15/15（含父项）。覆盖状态、日期、精确筛选、筛选顺序、空结果、参数错误、60/100 列宽、原始输出、控制序列清理，以及详细/原始模式的持续筛选、UTF-8 分片、初始半行和文件截短。既有历史错误与日志轮转回归保留。
- 两个修改脚本的 `node --check` 通过；完整 `npm test` 退出码 0：node:test 109/109，limiter 41、CONNECT 9、断流 13，以及 Anthropic/Codex 兼容和退避检查通过。测试只使用本地模拟上游，未运行收费自检。
- 只读现场核验紧凑、60 列窄屏、详细、原始和历史模式。查看前后 stderr SHA-256 相同，PID / instanceId 未变化（本次核验 PID 44632，启动时间 2026-09-25T02:58:20.296Z）。当前请求的耗时、token 和费用信息保留；历史 ERR_HTTP_HEADERS_SENT 可通过 `--history` 查看。
- 管理 CLI 下次执行即生效，无需重启网关；已打开的日志跟随命令需退出后重开。本轮未改服务端源代码、生产日志或密钥，未主动重启服务。

### 模型指纹自动选择与第二轮边界审查

- 默认 profile 改为 `auto`，按最终模型系列选择 Codex / Claude，保留路由和 provider 显式覆盖；生成、计数、模型发现统一应用头部策略。
- Claude 指纹透传完整动态头前缀，剔除 Connection 指定头；Codex 重试复用请求上下文，installation ID 不再每次请求变化；配置头按大小写不敏感覆盖，避免重复 Authorization / User-Agent。
- 显式代理环境变量缺失时启动失败，杜绝静默直连；`requireKey:false` 真正允许无鉴权上游。Anthropic 模型发现不再默认同时发送两种鉴权。
- 解码按反向顺序处理叠加 Content-Encoding，通过 pipeline 统一错误/取消；未知编码失败标记为发送后不可重试。模型列表响应也有缓冲上限。
- 共用增量 SSE 分帧器，Anthropic 统计支持 CR/CRLF、多行 data、分片 UTF-8；OpenAI 仅有 `[DONE]` 而无 finish_reason 时不再输出成功或工具调用，非流式聚合统一选择 choice 0。
- 用量未上报不再记成上报零；分片 usage 保留已有输入/缓存。下游必要的零值占位不作为账本依据。
- 新增 `scripts/test-hardening.mjs` 并纳入 `npm test`。详细复现和剩余边界见 [补充审查](AUDIT-HARDENING.md)。未修改真实路由、密钥、代理地址，未调用收费上游。
- 最终完整 `npm test` 通过：node:test 104/104（新增 29 项）、limiter 41、CONNECT 9、断连 13，兼容和退避检查通过；42 个 JS/MJS 语法检查通过。本轮未重启常驻实例，运行时变更需重启生效。

### 默认折叠历史 stderr，避免每次查看日志重复显示旧崩溃栈

**现象与根因**：`gw.js logs` 每次都在最新成功流水后打印 `ERR_HTTP_HEADERS_SENT`。旧实现虽然根据文件修改时间和 `/health` 的启动时间标注了「历史记录」，但该分支仍无条件输出旧栈。文件追加当前错误后，直接取末 20 行还会把旧栈混入当前错误。此次修复的是日志展示，不把历史栈当作新发生的运行时故障。

**改动**：
- `scripts/gw.js`：默认及 `-e` 模式折叠已确认早于当前进程的 stderr，仅显示一行提示；`logs --history` 显式查看当前 `gateway.err.log` 末 20 行，包含历史记录。不会删除、清空或改写日志，也不自动展开归档文件。
- 当前记录支持 UTC ISO 与本地时间戳。从首条当前记录开始显示，并保留其后多行栈；记录时间优先于文件修改时间。stderr 改为复用末尾最多 2MB 的读取逻辑，不再整份读取。
- 仅在健康信息的 service、PID 和启动时间有效时判断历史归属。网关不可达、身份或时间信息无效，以及修改时间较新但没有可识别时间戳的错误，继续显示并标注「无法确认错误所属进程」，避免静默隐藏故障。
- CLI 帮助和 README 补充 `--history`。现有 `-f` 仍跟随 stdout，本次未扩展 stderr 的实时跟随。

**验证**：
- 在临时目录复制实际管理脚本、使用本机健康接口和固定日志时间，新增 5 个回归用例：默认与 `-e` 折叠、显式历史、混合新旧多行记录、无时间戳的新错误、健康信息不可确认。修复前其中 3 个失败，修复后全部通过；定向 CLI 测试共 11/11（含父项）。
- `node --check scripts/gw.js`、`node --check scripts/test-logging.mjs` 通过；完整 `npm test` 退出码 0：node:test 75/75（含父项）、limiter 41、proxy-connect 9、Anthropic 兼容、Codex、断流 13、重试检查均通过。仅使用本地模拟上游，未运行收费 selftest。
- 实际执行 `node scripts/gw.js logs 1` 不再出现旧 `ERR_HTTP_HEADERS_SENT` 栈；`logs 1 --history` 仍能查看。查看前后 stderr 的 SHA-256 相同，健康接口中的 instanceId 和 PID 均未变化（PID 42832，启动于本地 2026-09-25 09:48:31.320）。没有重启网关、修改密钥或调用真实推理上游。
- 此修复只改管理 CLI，下次重新执行日志命令即生效；已打开的 `logs -f` 可退出后重开，无需重启服务进程。

### 日志展示优化：每个请求一行开始、一行结束，本地时间，流里的错误看得见，`gw.js logs -e / -f`

**问题**（另一个会话审查时列出的 7 条，加上本次核对发现的）：
1. `log()` 靠 `startsWith('gw_')` 识别请求 ID。客户端自带 `x-request-id` 时，ID 会被当成普通文字打印，还会原样回显到响应头里。
2. 上游错误体原样写进日志：Cloudflare 502 的 HTML 把一条日志拆成十几行（gateway.out.log 第 4864～4892 行），同一段 HTML（最多 800 字）还原样返回给了 Claude Code。重试行先截到 160 字符再摘要，`<title>` 被截掉，只剩 `<!DOCTYPE html>`。
3. 「上游响应头 200 (耗时)」那一行删掉以后，首字节耗时（any 经常要 60～80s）就看不到了。
4. 时间戳是 UTC ISO，用户在 UTC+8。
5. `gateway.out.log` 从不轮转，`gw.js logs` 每次都把整个文件读进来。
6. Anthropic SSE 透传时，流里出现 `event: error`，或者没有 `message_stop` 就结束，日志照样写 "200 OK"，记账也算成功。openai 转换流中途失败时，先写一行「流式失败」，又写一行「200 OK 流式」。
7. `→` 行丢了 `[gemini 适配]` 标记；启动时每条路由占一行，一共 15 行。

**改动**：
- `src/server.js`：
  - 每行格式为 `[本地时间] [gw_xxxxxxxx] …`，时间精确到毫秒；内容里的换行折叠成空格。请求 ID 一律由网关生成，不再回显客户端带来的值。
  - 请求开始：`→ 路由 ⇒ 上游模型 @provider · 流式/非流式 · 输入≈估算值`。请求体被模型系列改写过时，加 `[gemini 适配]` 或 `[claude 适配]`。
  - 请求结束只写一行：`←` 成功，`✗` 失败，`⚠` 流未收尾，`⊘` 客户端取消。流式请求带「首字节 / 共」两个耗时和字节数；用量按上游上报的显示（输入 · 缓存读 · 缓存写 · 输出），上游没上报时写明是估算值。
  - 透传的 Anthropic SSE 会顺带扫描 `error` 事件和 `message_stop`；openai 转换流借用转换器的 `onError`。两种流内失败都按失败记账（status 502），日志写明原因。
  - 上游返回错误时只记 `summarizeError` 摘要（HTML 取 `<title>`，JSON 取 `error.message`），返回给 Claude Code 的错误信息也只带这段摘要。
  - 启动时一行总览，再按 provider 每个一行列出路由；stderr 里的异常行也改用本地时间。
- `src/limiter.js`：重试行的错误详情改成对整段错误体做 `summarizeError`。
- `scripts/gw.js`：
  - `logs [n] [-e] [-f]`：只读文件末尾 2MB；旧日志里的 UTC 时间显示成本地时间；时间和请求 ID 用暗色，正文按类型着色；`-e` 只看 ✗ ⚠ ↻（包括旧格式的错误行）；`-f` 持续跟随新写入的行，靠轮询文件大小实现，在 Windows 上比 fs.watch 可靠。
  - `start` 前把超过 10MB 的 `gateway.out.log` / `gateway.err.log` 移进 `logs/archive/`，每种只留最近 5 份。
- `scripts/test-retry.mjs`、`scripts/test-e2e-retry.mjs`：原来按「上游抖动」「上游错误」这几个字找日志，改成匹配新格式（`↻ … 次重试`、`✗ … · 上游 <状态码> ·`）。

新格式示例（取自测试里的真实输出）：
```
[2026-09-25 06:03:52.762] [gw_617ce4f2] → ok-alias ⇒ ok-sse @anth · 流式 · 输入≈12
[2026-09-25 06:03:52.780] [gw_617ce4f2] ← ok-alias · 200 · 首字节 13ms · 共 18ms · 782B · 输入 3 · 缓存读 1.2k · 输出 7
[2026-09-25 06:03:52.791] [gw_3414b80c] ✗ err-sse · 200 流内错误 · 首字节 5ms · 共 8ms · 618B · overloaded_error: Overloaded · 输入 3 · 缓存读 1.2k · 输出 1
[2026-09-25 06:03:52.811] [gw_fb84522c] ✗ cf-502 · 上游 502 · 4ms · 190515.xyz | 502: Bad gateway
[2026-09-25 06:02:57.531] [gw_acb7dee7] ↻ scout · 1.3s 后第 1 次重试 · HTTP 429 All available accounts exhausted
```

**验证**：
- 新增 `scripts/test-logging.mjs`（13 项，已并入 `npm test`）：用假上游起真实的 `server.js`，逐条核对六类请求（成功的流、流里带 error、没有 message_stop、Cloudflare HTML 502、gemini 适配、openai 流中途坏掉）各自写成一行、内容正确，`/v1/usage` 的成败计数也对。另外在复制出的目录里验证 `gw.js logs` 的本地时间换算、`-e`、`-f`，以及启动前的日志轮转。这份测试在改动前的代码上会失败。
- 在隔离副本里跑完整 `npm test`（固定端口换成 43xxx）：node:test 69/69、limiter 41、proxy-connect 9、anthropic-compat、codex、断流 13、retry 全部通过；`test-e2e-retry` 5/5。
- **要重启网关才生效**：当前运行的 pid 31592（05:31 启动）还是旧的日志格式。

### `gw.js tokens` 改为终端图形展示

**需求**：用户希望 token 用图形展示，不只是数字；明确只要终端，不要网页看板。

**改动**（只动了 `scripts/usage-report.js`，账本格式和 `/v1/usage` 都没变）：
- 总量构成：一根整宽的堆叠横条（缓存读 / 缓存写 / 输入 / 输出），图例两列，带数值和占比。
- 趋势：token 合计的柱状图，纵向用 1/8 格方块提高精度，纵轴上限取整（1 / 2 / 2.5 / 5 × 10ⁿ）。48 小时以内按小时，更长按天；桶数超过屏宽时合并，按小时合并只用能整除 24 的步长，保证刻度落在整点。只画合计一个序列，不上色，避免被误认成某个构成部分。
- 分组对比：每组一根按构成堆叠的横条，长度按最大组缩放，失败数带 `✗` 标记。原来的数字表挪到 `--table`。
- 最近请求：每条的上下文大小（输入 + 缓存读 + 缓存写）画成细条，旁边标数值。
- 颜色用 dataviz 参考色板分类色 1–4 的深色档（`#3987e5` `#d95926` `#199e70` `#c98500`），`validate_palette.js` 对深色终端 `#0c0c0c`、`#1a1a19` 和白底都全部通过。颜色深度按终端能力选真彩色、256 色或 16 色，遵守 `NO_COLOR` / `FORCE_COLOR`。不上色时用 `█ ▓ ▒ ░` 区分四类。
- 分格用最大余数法，总格数不变；格子够分时每个非零段至少 1 格，小段不会消失，精确值以图例和 `--table` 为准。中文按两列宽对齐。

**验证**：`test-usage.mjs` 新增图形用例：分格总数与最小 1 格、刻度取整、今天 / 48h / 7 天的分桶与对齐、柱状图逐行比对。端到端用例改为显式 `FORCE_COLOR=0`（Claude Code 的 Bash 环境带 `FORCE_COLOR=3`），并断言图形元素都在、没有颜色码。`test-usage` 9/9。`test-retry.mjs` 曾因同日日志改版的措辞变化失败（它按「上游抖动」数重试行，重试本身正常），日志会话已把它和 `test-e2e-retry.mjs` 改成匹配新格式；之后在真实目录复跑 `npm test` 全部通过（node:test 69/69、limiter 41、proxy-connect 9、anthropic-compat、codex、断流 13、retry），`test-e2e-retry` 5/5。用仿真账本在今天、12h、48h、7d、all 下都实际渲染看过；网关重启后的真实账本（44 条请求）也能正常出图。

### 审查 token 统计与 reasoning 转换：账本持久化、缓存口径统一、thinking 块修正

**问题**（审查下文「Token 用量统计、结构化彩色日志与 Reasoning 思考过程支持」的实现）：
1. 统计只存在内存里，网关一重启就清零（9-24 一小时内重启过两次），看不出"今天用了多少"；网关没在跑时 `gw.js tokens` 直接报错。
2. 缓存口径混在一起：Anthropic 的 `input_tokens` 不含缓存，OpenAI 的 `prompt_tokens` 含缓存命中；适配器还丢掉了 `prompt_tokens_details.cached_tokens`，gpt / deepseek 的缓存命中看不到，两类上游的「输入」加起来没有意义。缓存写入也没有展示。
3. `gw.js tokens` 的表格用 `padEnd` 对齐中文列名（请求数、状态、耗时），中文在终端里占两列，整张表错位。
4. 上游错误体先截到 160 字符再记账，而 Cloudflare 502 页的 `<title>` 在 300 多字符之后，错误摘要只剩 `<!DOCTYPE html> <!--[if lt IE 7]>…`。
5. reasoning → thinking 转换：
   - 先出正文、后出 reasoning 时，thinking 块始终不会关闭；reasoning、正文、reasoning 交替出现时，第二段写进了已关闭的块。两种情况都违反 Anthropic 流协议。
   - 转出来的 thinking 块没有签名，却会留在 Claude Code 的会话历史里。同一会话切回 Claude 路由时（例如 `/model` 从 `claude-sonnet-5`（实际走 gpt-6-sol）切到 opus），上游校验签名会返回 400。

**改动**：
- `src/usage.js`（重写，对 server.js 暴露的函数签名不变）：
  - 每个请求结束时，向 `logs/usage-YYYY-MM.jsonl`（按本地月份分文件）同步追加一行，网关被 `taskkill /F` 强停也不会丢已结束的记录。
  - 只累计上游真实上报的 token，中途断开时已收到的部分照样计入；499（按 Esc 取消）单独计数，不算失败。
  - 新增在途请求列表：流式请求收到 `message_start` 后即显示本次上下文大小。
  - 错误摘要压成一行（HTML 取 `<title>`，JSON 取 `error.message`）并脱敏。
  - 账本默认只在使用默认配置时写：离线测试都设了 `GATEWAY_CONFIG`，不会污染真实账本。`GATEWAY_USAGE_DIR` 可改目录，设为 `off` 关闭。
- `src/providers/openai.js`、`src/stream.js`：
  - 新增 `anthropicUsageFromOpenAI`，把 `prompt_tokens` 拆成未缓存输入 + `cache_read_input_tokens`，兼容 `prompt_tokens_details.cached_tokens` 和 DeepSeek 的 `prompt_cache_hit_tokens`，流式、非流式共用。两者之和不变，Claude Code 的上下文占用计算不受影响。SSE 聚合时保留缓存字段。
  - 流式转换改为同一时刻只开一个块，块类型切换时先关闭上一个。非流式也识别 `message.reasoning`（OpenRouter 等用这个字段）。
- `src/model-series.js`：新增 claude 系列（上游模型名含 `claude-`，包括 `anthropic/claude-*`、`us.anthropic.claude-*`）。发往该系列时去掉无签名的 thinking 块；只剩 thinking 的助手回合整条去掉；有签名的 thinking 和 `redacted_thinking` 原样保留。`/v1/messages` 与 `count_tokens` 两个出口都经过这里；其它系列不受影响，没有需要改的内容时返回同一个对象。
- `scripts/usage-report.js`（新）+ `gw.js tokens`：读账本出报表。时间范围支持 `today`（默认）/ `12h` / `7d` / `all`，另有 `--by model|route|provider` 分组和 `-n` 最近条数。按显示宽度对齐中文列；网关在运行时附上在途请求，是旧版进程时提示重启。
- `src/server.js` 只改了一行：上游错误体整段交给记账，由 `summarizeError` 取摘要。日志格式没有动，由另一个会话负责。

**验证**：新增 `scripts/test-usage.mjs`（8 项，已并入 `npm test`），覆盖 usage 换算、交替 reasoning 时的块协议、thinking 签名剥离、记账与账本、报表的时间范围 / 跨月 / 分组 / 中文列宽，外加一条端到端用例：起真实 `server.js`，用假上游跑 anthropic 和 openai 各一个流式请求，核对 `/v1/usage`、账本内容和 `gw.js tokens` 的输出。`npm test` 全绿（node:test 55、limiter 41、proxy-connect 9、anthropic-compat 5、codex、断流 13、retry）；`test-e2e-retry` 5/5。跑完测试后真实 `logs/` 下没有生成账本文件。**正在运行的 pid 43820 是旧代码，重启后才开始记账。**（后续：05:31 已重启为 pid 31592，账本开始记录。）

---

### `gw.js logs` 里的 `ERR_HTTP_HEADERS_SENT` 崩溃栈是 9-24 的旧记录；err.log 标注时间，崩溃栈补时间戳

**现象**：`node scripts/gw.js logs` 末尾总是显示 `ERR_HTTP_HEADERS_SENT` 崩溃栈（`json → errorResponse → handleMessages`），看起来像网关刚崩过。

**根因**：这是 9-24 14:13（本地时间）那次崩溃留下的栈，就是下文 9-24「上游断流时网关崩溃」已修复的问题。`err.log` 只追加不清空，Node 打印的崩溃栈不带时间，`gw.js logs` 又把它原样贴在最新流水后面。证据：
- 栈里的行号（`json` 56 行、`handleMessages` 234 行）和现在的 `server.js` 对不上；`err.log` 最后写入于 9-24 14:13，之后多次重启（pid 5936、pid 43820），stderr 再没有任何输出。
- 修复部署后（9-24 10:29Z 起）生产日志里有 55 次上游异常（多为 ECONNRESET），都正常返回了错误，网关没有崩。
- 正在运行的 pid 43820（9-25 03:32 启动）是带保护的版本：审查前快照（01:12、01:23）的 `json()` 已有 `headersSent` 保护，日志格式（「上游响应头」「完整转发」）也和运行进程的输出一致。

**改动**：
- `scripts/gw.js`：`logs` 给 err.log 标出最后写入时间，早于当前进程启动的内容标成「历史记录」、暗色显示，并去掉残留的 ANSI 颜色码；`start` 失败时只显示本次启动写入的 stderr，没有新输出就显示 out.log 末尾，不再把旧崩溃栈当成这次的失败原因。
- `src/server.js`（重启后生效）：进程因未捕获异常退出前，先写一行 `[时间] 网关进程因未捕获异常退出 (pid …)`；请求处理结束时响应还没 `end` 就断开连接，客户端不会一直挂到超时。

**验证**（临时目录副本 + 独立端口，不碰生产实例）：
- `test-disconnect`：当前代码（本次改动前）13/13、审查前快照 13/13 通过。
- 对照组：删掉 `json()` 的保护后只剩 11/13，复现了 `ERR_HTTP_HEADERS_SENT`，而且断流请求的客户端挂了 8 秒直到超时。说明这个测试能抓住该 bug，也说明新增的「未 end 就断开」兜底是必要的。
- 本次改动的运行验证（复制当前代码，独立端口）：新 `server.js` 的 `test-disconnect` 13/13；删掉 `json()` 保护、只留新兜底时，断流的客户端立即断开（上一轮挂了 8 秒），只剩「stderr 不含 ERR_HTTP_HEADERS_SENT」一项按设计失败（12/13）。用预加载脚本制造未捕获异常：stderr 第一行是 `[2026-09-24T21:07:02.721Z] 网关进程因未捕获异常退出 (pid 29008, uncaughtException):`，下面是 Node 原有的崩溃栈，退出码仍为 1。`gw.js logs` 实际输出把 err.log 标成「历史记录（最后写入 2026/9/24 14:13:41，早于当前进程 pid 43820 的启动时间 2026/9/25 03:32:01）」。
- 在隔离副本里跑完整 `npm test`（固定端口改成 44xxx，避免和另一个会话的测试冲突）：全部通过（node:test 55、limiter 41、proxy-connect 9、anthropic-compat、codex、断流 13、retry）。

**排障（同时发现）：auto 模式下 Bash 全被拦**。auto 模式下，非只读的 Bash 要先经安全分类器审核，`permissions.allow` 里的 `"Bash"` 不会跳过这一步。从网关日志看，分类器用非流式请求先调 `claude-sonnet-5`，失败后改调主模型（20:21:46、20:51:21 两次都是 sonnet 502 之后 14～17ms 就发出 `-any` 非流式请求）。当时两条路都断了：
- `claude-sonnet-5` 在网关里路由到 sub2api 的 gpt-6-sol。sub2api 上 gpt-6-sol 的账号池只有 account 3（apikey 类型，上游是一家 new-api 中转）。该上游从 9-25 03:57 CST（19:57Z）起对 gpt-6-sol 返回 503 `model_not_found：分组 … 下模型 gpt-6-sol 无可用渠道（distributor）`；sub2api 把这个号冷却后无号可切，回 502，被 Cloudflare 换成品牌 502 页（就是网关日志里那段 HTML），冷却期内则直接回 503。21:18Z 经网关实测已恢复（200）。
- `claude-opus-5-5-any` 的非流式请求：20:21Z 起 8/8 在约 4 秒内返回空体 520，同时段流式请求全部 200。这是 anyrouter 上游的问题；网关按约定不重试 520，并带 `x-should-retry: false`。截至 21:18Z 未复测。
- 临时解法：Shift+Tab 退出 auto 模式，回到 acceptEdits（`Bash` 在 allow 里，不经分类器）。

### Token 用量统计、结构化彩色日志与 Reasoning 思考过程支持

**需求与现象**：
1. 用户希望增加查看目前 Token 量的功能，并优化现有流水日志的展示，以便快速定位各 provider / 模型的消耗与请求状态。
2. 用户之前遇到 `502 网关转发失败 (openai): fetch failed (UND_ERR_SOCKET)` 报错，需要明确排障定位与根因保护。
3. 参考开源 Claude Code 路由器生态（如 `musistudio/claude-code-router`、`jianzhichun/permafrost`），针对 DeepSeek R1 / o1 / OpenAI 兼容推理模型的思考过程（`reasoning_content`）需要做规范的 Anthropic Thinking 转换。

**排查与根因**：
- **502 根因确证**：在网关 live 实时日志中捕获到：当请求 `claude-sonnet-5`（指向 `openai` -> `https://sub2api.190515.xyz/v1`）时，上游服务器自身直接返回了 Cloudflare 502 HTML（`<title>190515.xyz | 502: Bad gateway</title>`），而非本地网关代码错误。网关的 `isSafeToRetryNetworkError` 与 `x-should-retry: false` 机制正确保护了调用方，避免了已计费/已送达请求的无节制重试。
- **Token 观测缺失**：原生网关中途未聚合上游 SSE 与 JSON 响应体中的 usage 数据，Claude Code 频繁命中的 Prompt Cache（`cache_read_input_tokens`）也未单独分类。
- **日志无关联 ID**：在 Claude Code 多子 Agent 并行发起请求时，多条请求的 `→` 和 `←` 交织打印，缺少请求维度的短 ID 追踪。
- **Reasoning 内容丢弃**：流式转换器 `openAIToAnthropicStream` 过去仅判断 `delta.content`，上游吐出的 `delta.reasoning_content` 会被直接丢掉。

**改动**：
1. **Token 用量统计中心 (`src/usage.js` & `src/server.js`)**：
   - 内存级用量统计，支持按总量（totals）、Provider、Route 别名、Model 模型分别统计请求数、成功/失败数、真实输入/输出 Token、Prompt Cache 命中与写入 Token、保底估算 Token。
   - 内存保留最近 200 条请求的环形缓冲区（包含短 ID、耗时、状态码、精确 Token 消耗及错误摘要）。
   - 暴露鉴权接口 `GET /v1/usage`（别名 `/v1/token-stats`），支持客户端持 token 查询。
   - SSE 与 JSON 双向提取：非流式 JSON 取 `usage`；OpenAI SSE 启用 `stream_options: { include_usage: true }` 并通过回调捕获；Anthropic SSE 引入非阻塞轻量解析器扫描 `usage` 事件。
2. **日志优化与 CLI 看板 (`scripts/gw.js` & `src/server.js`)**：
   - 每个入站请求生成短 ID（`gw_<hex8>`），通过响应头 `x-request-id` 返回并在全链路日志中标记 `[gw_xxxxxxxx]`。
   - 结构化符号前缀：`→` 请求进、`← 200 OK` 正常响应（附耗时、字节数与 in/out/cache Token）、`✗` 异常失败、`↻` 退避重试。
   - CLI 增加 `node scripts/gw.js tokens`（别名 `usage`）：以终端表格呈现总览、Provider 统计表、Route 统计表与最近 10 条请求流水明细。
   - `node scripts/gw.js logs [n]` 增加终端 ANSI 彩色高亮（成功绿、重试黄、失败红、请求青）。
3. **Reasoning 思考内容兼容 (`src/stream.js` & `src/providers/openai.js`)**：
   - 流式转换支持提取 `delta.reasoning_content` / `delta.reasoning`，转换为 Anthropic 3.7 原生 `type: "thinking"` 内容块与 `thinking_delta` 流式事件，让 Claude Code 正常渲染思考折叠面板。
   - 非流式转换在 message.content 前注入思考内容块，完整支持 DeepSeek R1 / 推理模型。

**验证**：
- `node --test scripts/test-audit.mjs`：26 项离线端到端测试全数通过（包括鉴权 `GET /v1/usage` 校验、`x-request-id` 格式、`reasoning_content` 思考流式/非流式转换断言）。
- 完整测试套件 `npm test`（共 46 项断言 + limiter 41 项 + proxy 9 项 + anthropic 5 项 + codex + 断流 13 项 + retry 3 项）全绿通过。
- 所有 JS/MJS 语法检查通过。

---

### ECONNRESET 修正的审查修复：握手失败可重试、阶段标记准确、断开即取消

**问题**（审查 09-24 的"关闭复用 + 显式 CONNECT"修正）：
1. 代理 CONNECT / TLS 握手阶段的 reset（实测 anyrouter 握手约 5～10% 被 reset，走代理和直连都有）请求体还没发出，但 limiter 只按错误码判断，`ECONNRESET` 不在白名单 → 网关不重试，还带 `x-should-retry: false` 让 Claude Code 也不重试 → 用户直接看到 502。
2. 握手完成后 socket/tlsSocket 上的 error 监听器没换掉，请求已发出后的 reset 也被标成 `[tls-handshake]`；`proxy-connect-or-response-headers` 把可重试和不可重试两种情况混在一起。
3. `anthropic.js` 对流式请求强改 `accept: text/event-stream`，和"请求头与直连一致"的要求冲突。
4. 代理路径收到响应头后移除了 abort 监听，客户端断开后要等上游吐下一个 chunk 才取消。

**改动**：
- `upstream-fetch.js`：阶段拆成 `proxy-connect` / `connect` / `tls-handshake` / `response-headers`，错误带 `beforeSend`。整条隧道共用一个错误出口，由 `phase` 变量决定阶段。abort 监听保留到响应体结束，触发时销毁整条隧道。socket 开启 TCP keepalive（15s）和 noDelay。请求头固定发 `connection: keep-alive`（与直连一致），socket 是否复用仍由 agent 决定（默认用完即关，已验证 3 次请求建了 3 个连接、关了 3 个）。
- `limiter.js`：`isSafeToRetryNetworkError` 优先看 `beforeSend`，握手前的失败由网关重试，也不带 `x-should-retry: false`。
- `anthropic.js`：`accept` 原样透传；确有站点需要强制 SSE accept 时，在 provider 上开 `forceStreamAccept: true`（默认关）。

**验证**：`test-proxy-connect` 扩到 8 项（本地自签证书 `scripts/fixtures/`，覆盖代理/直连各阶段的 reset、重试判定、响应头后断开 1 秒内关闭上游）；`test-disconnect` 13、`test-limiter` 34、`test-e2e-retry` 5、`test-anthropic-compat`、`test-codex-openai-adapter` 全部通过。用假上游对比 `claude -p` 直连与经网关的请求头，19 个一致，只有 session-id 和 content-length 不同（请求体按日期、环境变化），都属预期。

## 2026-09-24

### anthropic 类上游请求头与 Claude Code 直连完全一致

**现象/动机**：排查 any 的 `UND_ERR_SOCKET` 时，要排除"网关转发的头和直连不一样"这个因素。

**差异（改前）**：`anthropic.js` 只按白名单转发约 10 个头，丢了 `x-claude-code-session-id`、`x-stainless-timeout`、`anthropic-dangerous-direct-browser-access`、`accept-encoding` 等；把 `accept` 强改成 `text/event-stream`；`authStyle: auto` 同时发 `x-api-key` 和 `authorization`（直连只发一种）。另外内置 fetch（undici）会私自补 `accept-language: *`、`sec-fetch-mode: cors`。

**改动**：
- `anthropic.js` `buildHeaders`：入站头**全量透传**，只去掉逐跳头（host/connection/content-length 等）和网关自己的鉴权；`auto` 鉴权沿用 Claude Code 用的形式（Bearer 或 x-api-key，只发一种）。`count_tokens` 也用同一函数。
- `upstream-fetch.js`：直连也走 `node:http`，不再用内置 fetch，所以不会被补额外的头。

**验证**：假上游记录原始头，分别让 `claude -p` 直连假上游、经网关打假上游，对比结果 19 个头完全一致。只有 `x-claude-code-session-id`（每次运行都不同）和 `content-length`（路由把模型名 `-any` 去掉，少 4 字节）不同，都属预期。`test-limiter` 34/34、`test-e2e-retry` 5/5 通过。

### any 路由频繁 `fetch failed (UND_ERR_SOCKET)` 但已扣费：支持按 provider 配置上游代理

**现象**：走网关用 `claude-opus-5-5-any`，anyrouter 已扣费，网关日志却是请求发出 10s～2min 后 `TypeError: fetch failed (UND_ERR_SOCKET)`（偶有 `ECONNRESET`），随后 Claude Code 自动重发，再扣一次。

**根因**：Node 内置 `fetch` **不读 `HTTPS_PROXY`**，网关对 anyrouter.top 是从国内直连的；Claude Code 直连 any 时走的是 `HTTPS_PROXY=127.0.0.1:7897`。长连接在生成途中被链路掐断，上游已开始计费、网关收不到响应头。只有 any 路由出错，同时段其他路由正常。网关自身对 `UND_ERR_SOCKET` 本就不重试（见下条 P1），日志里的重发来自 Claude Code 收到 502 后的 SDK 自动重试。

**改动**：
- 新增 `src/upstream-fetch.js`：`upstreamFetch(provider, url, init)`。provider 配了 `proxy` 就经 HTTP 代理（`https.Agent` 的 `proxyEnv`，Node 24.5+，零依赖）发出并包成 Web `Response`；自动解压 gzip/br/deflate/zstd，网络错误包成 `TypeError('fetch failed', { cause })`，与内置 fetch 行为对齐，limiter 的错误码判断照常工作。没配 `proxy` 的直连（后来也改走 node:http，见上条）。
- `providers.json` 每个 provider 可加 `"proxy": "http://127.0.0.1:7897"`（也支持 `env:NAME`）。目前**只给 `any` 配了**，sub2api / relay 仍直连。
- anthropic / openai / gemini 适配器和 `count_tokens` 出口全部改用 `upstreamFetch`。
- 请求可能已送达上游的网络错误（非连接阶段错误）返回 502 时带 `x-should-retry: false`，Anthropic SDK 据此不自动重发，避免重复扣费。

**验证**：`test-limiter` 34/34、`test-e2e-retry` 5/5 通过；代理指向无效端口时报 `ECONNREFUSED`，证明确实走了代理；gzip 响应能正确解压；abort 能取消请求。临时起在 4199 端口的网关经代理成功把请求送到 anyrouter（拿到 anyrouter 自己的 400/503 业务响应）。当时 anyrouter 对直连 curl 也全部返回 503，所以**还没观测到经代理的完整成功流**，重启网关后需再看一次日志。

### 上游断流时网关崩溃；Claude Code 放弃后上游仍在计费（已修复 P0 + P1）

**现象**：用 any 站点时，Claude Code 迟迟收不到回复（或报连接中断），中转站却照常扣费；网关有时自己退出。

**根因**（`logs/gateway.err.log` 里有两次相同的崩溃栈）：

1. **流式转发中途上游断开会让网关崩溃。** 响应头已发给 Claude Code 后上游断流（日志 `TypeError: terminated`），
   `handleMessages` 的 `catch` 仍调用 `errorResponse()` 写响应头 → `ERR_HTTP_HEADERS_SENT` → 未捕获 → 进程退出，
   **所有在途请求一起被切断**：上游照样生成计费，Claude Code 收到连接中断后自动重试，再计一次。
2. **客户端断开不会取消上游请求。** 上游 fetch 只挂了 `AbortSignal.timeout(600_000)`。Claude Code 放弃等待（Esc、超时重发）后，
   网关仍等上游最多 10 分钟，再把完整回复写进已断开的连接 —— 上游全额计费。
3. **网络错误一律重试。** `limiter.js` 对除超时外的任何异常都重试（最多 4 次）。若 `fetch failed` 发生在请求已送达上游之后，每次重试都重复计费。
4. **重启是硬杀。** `gw.js stop/restart` 用 `taskkill /T /F`，重启瞬间所有在途请求被切断。

另：Node 自带 `fetch` 默认最多等 **300 秒**响应头；any 实测出现过 182～298 秒才返回响应头。

**改动**：

- `src/server.js`
  - `json()`：响应头已发出时不再写头，直接断开连接，让 Claude Code 立即感知流中断（修 #1）。
  - 每个请求一个取消信号：Claude Code 断开（`res` 的 `close` 事件且响应未完成）即取消上游 fetch；
    上游信号 = `AbortSignal.any([客户端断开, 10 分钟超时])`，排队与重试等待也会被打断（修 #2）。日志记 `客户端已断开，已取消上游`。
  - 请求处理加兜底 `.catch`；进程级 `unhandledRejection` 只记日志不退出。
  - 异常日志带底层错误码；`UND_ERR_HEADERS_TIMEOUT` / `UND_ERR_BODY_TIMEOUT` 返回 504。
- `src/limiter.js`（修 #3）
  - 网络错误只在**连接阶段**失败时重试：`ECONNREFUSED`、`ENOTFOUND`、`EAI_AGAIN`、`ENETUNREACH`、`EHOSTUNREACH`、`UND_ERR_CONNECT_TIMEOUT`。
    发出后断连（`UND_ERR_SOCKET`、`ECONNRESET`）、等响应头超时、无错误码的异常一律不重试。
  - 状态码只重试 `429 / 503 / 529`；`502 / 504` 不再重试（可能发生在上游已开始生成之后）。
  - `withUpstream` 支持 `opts.signal`：排队中或退避等待中客户端断开，立即停止，不再发请求。

**验证**：

- `node scripts/test-disconnect.mjs`（新增，本机假上游 + 临时网关，13 项）：上游中途断流时网关不崩、同时进行的另一个流照常跑完；
  流式途中 / 等响应头期间 / openai 格式路径断开，上游都在 1.5 秒内被取消；请求送达后被重置不重试；连接被拒会重试。
- `node scripts/test-limiter.mjs` 34 项（新增 12 项）、`node scripts/test-e2e-retry.mjs` 5 项全部通过。

**未做（P2）**：平滑重启。`gw.js restart` 仍会切断在途请求；手动重启前先看 `/v1/gate-stats`，所有 `active` 为 0 再重启。
断开后中转站是否还按已生成部分计费由中转站决定，网关能做的是立即断开上游、不重复发起。

---

### gemini（scout）持续 429：Google 拒绝带 Claude 身份的 system prompt

**现象**：scout 子 agent（经 sub2api 调 `gemini-3.8-flash-high`）稳定失败：先 `429 All available accounts exhausted`，
随后几分钟全是 `503 No available accounts`，**同一账号池上的 dsh、GitHub Copilot 也一起不可用**。

**根因**：

- Google Antigravity 后端（`daily-cloudcode-pa.googleapis.com`）拒绝 system prompt 带 Claude Agent SDK 身份行的请求 ——
  子 agent 的 system prompt 首行固定是 `You are a Claude agent, built on Anthropic's Claude Agent SDK.` ——
  返回不带任何细节的 `429 RESOURCE_EXHAUSTED`。
- sub2api 收到后把该账号的 `antigravity:gemini`（**整个 gemini 家族**）冷却 59 秒；池里只有 2 个号，所以一个 scout 请求就能让全池 gemini 瘫痪，
  Claude Code 与网关的重试每过冷却期又撞一次，放大成几分钟的全面不可用。

**证据**（sub2api 服务器日志 + 数据库）：

- 同一账号在 00:05:14 刚成功返回 dsh 一个约 136KB 的请求，4 秒后对一个**只带 scout system prompt** 的 2KB 请求返回 429。
- 6 小时内所有 Google 429 都落在带这段 prompt 的请求上；dsh、Copilot 的大请求从未被拒。
- 与 UA、请求大小、tools、stream、`max_tokens` 无关（逐项对照均为 200）。

**改动**：

- 新增 `src/model-series.js`：**只对上游模型名匹配 `gemini-*` 的请求**，把 system（含 messages 里 `role: system` 的消息）中
  `You are …Claude/Anthropic….` 这类身份句改写为 `You are an AI coding agent.`。`server.js` 的 `/v1/messages` 与 `count_tokens`
  两个出口都经过它，日志标 `[gemini 适配]`。按**模型系列**而非 provider 判断：走哪个 provider 都生效，其他系列（claude/deepseek/gpt）原样不动。
- `src/providers/openai.js`：Claude Code 放进 messages 的 `role: system` 消息（mid-conversation system，如环境信息）改为**并回开头的 system**。
  以前会被降级成 user，变成"最后一条用户输入"。对所有 openai 类 provider 生效。

**验证**：同一请求改写前 429、改写后 200（回复 `SCOUT_OK`）；scout / coder 端到端通过；离线检查只有 `gemini-*` 被改写。

> 注意：在生产账号池上**每失败一次都会让全池 gemini 冷却 59 秒**，连累 dsh / Copilot。排查时优先看服务端日志和数据库，别在生产池上反复试探。

---

### 请求头统一透传 Claude Code 指纹

- `src/providers/client-headers.js`：把 Claude Code 真实发来的 `user-agent`、`accept`、`x-app`、`x-stainless-*` **原样转发给所有上游**，
  anthropic / openai / gemini 三个适配器共用，新增模型无需单独适配。网关**不再伪造** `claude-cli/*` UA（anthropic 适配器仍会补 `metadata.user_id`）。
- 对 gemini 无影响：sub2api 调 Google 时自己重建请求头，客户端头到不了 Google。
- 验证：sub2api 的 `usage_logs` 中 deepseek / gpt-6-sol 请求的 UA 已是 `claude-cli/2.1.280 (external, cli)`。
- `scripts/selftest.js` 改为自带 `CLAUDE_CODE_HEADERS`（`user-agent: claude-cli/…`、`x-app: cli`）。否则 UA 是 `node`，relay 会回 `403 claude_code_required`。
- 自检里 deepseek / gemini 回复为空但 output tokens > 0 属正常：`max_tokens: 24` 全被推理 token 用掉了。

---

## 2026-09-23

### 网关模式下 "opus isn't described by this version's model catalog" 告警（修法 B）

**现象**：网关模式启动 Claude Code 时出现上述告警，自动压缩按 200k 窗口处理；直连模式没有。

**根因**：`ANTHROPIC_DEFAULT_*_MODEL` 写的是网关别名（`opus` 等），不在 Claude Code 的模型目录里。

**改动**：

- `providers.json` 增加以**真实模型 ID** 为键的路由（`claude-opus-5-5`、`claude-sonnet-5`、`claude-haiku-4-5`），同时保留别名路由（子 agent frontmatter 在用）。
- `settings.json_gateway` 的 `ANTHROPIC_DEFAULT_*_MODEL` 改为真实 ID；`modelPicker` 增加带 `behavesAs` 的行。
- `gw.js mode gateway` 会用 `settings.json_gateway` **整份覆盖** `settings.json`，所以要改后者。
- 路由在进程启动时只读一次：**改完 `providers.json` 必须重启网关**。

### `[1m]` 与 1M 上下文（实测结论）

- `[1m]` 是**客户端开关**：Claude Code 发请求时去掉模型名里的后缀，并附加 `anthropic-beta: context-1m-2025-08-07`；网关透传 `anthropic-beta`，所以经网关 1M 仍有效。
- 写在 `ANTHROPIC_MODEL`、顶层 `model`、`ANTHROPIC_DEFAULT_OPUS_MODEL`（经 `opus` 别名解析时）上都生效（隔离环境实测）。
- 1m 头**按请求附加**：子 agent 用不带后缀的真实 ID 时不会带 1m 头，不会影响其他站点。
- 启动时 `ANTHROPIC_MODEL` 环境变量优先于顶层 `model`；设了它，`/model` 保存的默认值在新会话里不会生效。
- relay：长上下文（约 270k tokens）**不带** 1m 头也能用；带 1m 头会按 1M 档预扣费，余额不足直接 403。
- any：**必须**带 1m 头，否则 400 `请启用 1m 上下文`；专用路由 `claude-opus-5-5-any`，配 `ANTHROPIC_MODEL=claude-opus-5-5-any[1m]`。
- 子 agent 模型解析：frontmatter 写系列别名 `opus` 时会跟随主会话当前的 opus（包括 `-any[1m]`）；自定义名（`exec`、`deepseek`）原样发出；
  `CLAUDE_CODE_SUBAGENT_MODEL` 只作用于 frontmatter 没写 model 的 agent（如 general-purpose）。

---

## 排障速查

| 看什么 | 命令 / 位置 |
|---|---|
| 网关状态 / 路由表 | `node scripts/gw.js status` |
| 全路由自检 | `node scripts/gw.js test`（即 `scripts/selftest.js`） |
| 请求流水 | `logs/gateway.out.log`：`→` 发出、`←` 返回、`↻` 重试 |
| 网关崩溃栈 | `logs/gateway.err.log` |
| sub2api 服务器 | `ssh -p 22222 slizm@192.236.226.185`（容器 `sub2api`、`sub2api-postgres`、`sub2api-redis`） |
| 上游真实报错 | `docker logs --since 1h sub2api 2>&1 \| grep -E "Antigravity-Debug\|status=429\|model_rate_limited"` |
| 按客户端统计成败 | `docker exec sub2api-postgres psql -U sub2api -d sub2api`：成功在 `usage_logs`，失败在 `ops_error_logs`，都有 `user_agent` 列 |
