# slizm-gateway

Claude Code 多 provider 网关

让 Claude Code 在**同一个会话**里同时使用多个 provider、多套 API key。

改动历史与排障记录见 [docs/CHANGELOG.md](docs/CHANGELOG.md)。[2026-09-25 日志展示会话记录](docs/SESSION-2026-09-25-LOG-DISPLAY.md) 保存本阶段的需求、修改步骤、调试偏差和验证流程。其他审查证据见 [docs/AUDIT-HARDENING.md](docs/AUDIT-HARDENING.md)、[docs/AUDIT.md](docs/AUDIT.md)，安全检查范围见 [docs/walkthrough.md](docs/walkthrough.md)。

## 离线回归与排障

```bash
npm test                    # 仅本地模拟上游，不调用收费模型
node scripts/gw.js status   # 查看 PID、transport 和源码更新提示
```

`npm run selftest` / `node scripts/gw.js test` 与上述离线测试不同：会向配置的真实模型发送请求，可能产生费用。历史 `diag-*`、`probe-*` 实验脚本也可能调用真实上游，不纳入离线测试入口。

- `fetch failed` 表示传输失败，不等于模型或密钥必然错误。日志中的 `connect` / `proxy-connect` / `tls-handshake` 表示生成请求尚未发出；`response-headers` 表示可能已送达。
- 默认不复用跨请求 socket；HTTPS 代理通过 CONNECT 隧道转发。发送后断连、502/504 和响应超时不盲目重放，以降低重复计费风险。
- 每个 provider 可配置 `connectTimeoutMs`（默认30000），仅限制TCP/CONNECT/TLS建连；连接就绪后停止计时，不误切正常生成。`requestTimeoutMs`（默认600000）限制排队、重试和响应消费的总时长。`maxConcurrency` 必须为1..1000整数，`maxAttempts` 必须为1..20整数。
- 保留429/503/529的有限重试；尊重 `Retry-After` 及 `x-should-retry:false`。503不从协议层保证未计费，特殊上游可设 `maxAttempts:1`。
- `/health` 含运行实例PID、启动时间和传输版本，但只代表本地进程可用。源码修改后应在请求完成后重启；管理器拒绝停止无法核验身份的旧版进程，旧实例需核对命令行后手动迁移。
- 流式错误不再产生成功 `message_stop`；为正确拼接分片工具名称，OpenAI工具块在完整收到后输出，普通文本保持增量输出。
- 生产TLS校验始终开启，`allowInsecureTls:true` 现在报配置错误而非被静默忽略。可信自签CA应通过 `NODE_EXTRA_CA_CERTS` 配置。
- 环境变量优先于 `.env`；密钥、路由等运行配置变更仍需要重启，模型价格与 provider 倍率支持热更新。

## 本地管理 Web

```bash
node scripts/gw.js start          # 启动网关，同时启动独立管理 Web
node scripts/gw.js web            # 打开浏览器并登录管理页面
node scripts/gw.js web --no-open  # 仅启动 Web，不打开浏览器
node scripts/gw.js web --stop     # 仅停止 Web，不影响网关
```

双击 `start.cmd` 会在网关启动成功后打开管理页面。默认地址为 `http://127.0.0.1:48731/`；默认端口被占用时会自动选一个空闲本地端口，启动命令会显示实际地址。管理服务固定只监听本机，可用 `GATEWAY_WEB_PORT` 指定端口（显式指定端口被占用时报错，不自动改用其他端口）。设置 `GATEWAY_WEB_ENABLED=0` 可禁止 `start` 自动启动 Web，仍可单独执行 `web` 命令。直接运行 `src/server.js` 或使用已有 pm2 启动方式时，需另行执行 `web` 命令。

- **运行概览**：网关状态、在途请求、历史趋势、请求明细，以及各 provider 和模型的 tokens / USD 消耗。可按时间和站点筛选，网关停止时仍可查看历史账本。费用使用统一模型 API 单价，不是站点账户余额；未上报用量和缺失价格单独标记。
- **请求日志**：stdout / stderr 切换、关键词和异常筛选、暂停刷新，以及下载当前可见日志。读取文件末尾的有界窗口，不加载无限增长的整份日志。
- **基础设置**：Provider 新增、编辑、删除、API Key 更新、模型映射、路由、默认站点、并发数、重试次数、超时和请求日志开关。已有 API Key 不回显，留空保留原值；模型价格（原价）与各站点的逐项价格倍率也可在此编辑；未展示的代理和请求头保持不变。
- **保存与生效**：保存前校验完整配置并备份，使用版本校验防止覆盖其他窗口或手动编辑。模型价格与 provider 倍率保存后主动通知网关热更新，并显示是否已确认生效；其他修改仍需重启。保存不自动重启，有在途请求时拒绝重启。JSON 顶层 `logRequests`（布尔值）存在时优先于 `GATEWAY_LOG_REQUESTS`，未设置时保留原有环境变量行为。
- **本机认证**：`web` 命令使用 URL fragment 完成本地登录，页面随即移除凭据并使用 HttpOnly 会话 cookie。管理 API 校验 Host、Origin 和会话，不向浏览器返回上游密钥。登录失效时重新执行 `node scripts/gw.js web`。不要分享 `logs/web-session.json`，它包含管理页面的本地登录凭据。

管理 Web 与网关进程独立，重启或停止网关后页面仍然可用。Web 自身的输出在 `logs/web.out.log` / `logs/web.err.log`；更新管理 Web 源码后执行 `web --stop` 再执行 `web`，不会中断模型请求。

## 命令行日志

```bash
node scripts/gw.js logs                         # 默认紧凑视图，最近 40 条匹配行
node scripts/gw.js logs 80 -e                   # 异常、警告和重试
node scripts/gw.js logs --id 08549408            # 精确请求 ID；也可写 gw_08549408
node scripts/gw.js logs --route gemini -f        # 精确路由筛选并持续跟随 stdout
node scripts/gw.js logs --detail                # 完整时间戳、请求 ID 和正文
node scripts/gw.js logs --width 60              # 窄屏布局；可指定 40..240 列
node scripts/gw.js logs --raw                   # 仅输出 stdout 原始行，无标题和附加着色
node scripts/gw.js logs --history               # 同时查看当前 stderr 文件末 20 行（包含历史）
```

- **紧凑展示**：按日期分组，列出时间、状态、路由、8 位请求 ID 和详情。状态明确区分开始、成功、失败、警告、重试和取消；流内错误即使 HTTP 为 200 也显示失败。成功记录会用颜色突出首字节/总耗时（青色）、输入 token（蓝色）、缓存读写 token（品红色）、输出 token（绿色）和费用（黄色），失败或上游异常整段醒目显示；无颜色终端仍保持相同文本。长字段折行，指标标签与数值不会拆开，不省略错误原因、耗时或用量。宽度不足 100 列时改为上下两层布局；旧格式或未知记录保留正文，不猜测状态。
- **筛选规则**：`--id`、`--route`、`-e` 可组合，先筛选再取最后 n 条，范围为 stdout 文件末尾最多 2MB。n 是匹配的非空原始行数（1..10000），不是请求数或折行后的屏幕行数。支持 `--id=...` / `--route=...`；参数缺值、未知选项或冲突模式会报错。
- **详细与原始模式**：`--detail` 保留完整行布局，旧 UTC 时间转换为本地时间；`--raw` 不转换时间、不附加标题或 stderr，也不清理原文中的控制字符，适合重定向到可信文件。`--raw` 不可与 `--detail` 或 `--history` 同用。普通视图清理终端控制序列；日志着色遵守 `NO_COLOR` / `FORCE_COLOR`，非 TTY 默认不着色。
- **持续跟随**：`-f` / `--follow` 复用相同筛选和展示模式，Ctrl+C 退出；保留初始未完成行和 UTF-8 分片，文件截短后从头继续。目前只跟随 stdout，不实时追踪 stderr；不是全屏仪表盘。

默认折叠只影响已确认属于旧进程的 stderr，不删除或清空原始日志。识别到当前进程的时间戳时，从该记录开始展示并保留后续多行错误栈；健康信息不可确认或新错误没有可识别的时间戳时，保留错误线索并提示无法确认归属。stderr 单列为进程级诊断，不参与请求 ID 或路由筛选。`--history` 不自动读取 `logs/archive/`。

日志展示由管理脚本负责，下次执行命令即生效，无需重启网关；已打开的 `logs -f` 可退出后重开。

## 要解决的问题

Claude Code 的 `ANTHROPIC_BASE_URL` 和凭据是**会话级单例**——所有模型、所有子代理都走同一个端点。
所以"用 Claude 做规划、DeepSeek 做执行、Gemini 做搜索"无法在原生配置里表达。

本网关把这层能力挪到本地进程：Claude Code 只看见一个端点，网关按**模型名**把请求分发到不同上游，
用各自的 key 鉴权，并在必要时做 Anthropic ↔ OpenAI 格式互转。

```
Claude Code ──► 本地网关 (127.0.0.1:4000) ──┬──► Claude / 中转    key_A
  只认一个端点                               ├──► DeepSeek         key_B
  只带一个 token                             └──► Gemini           key_C
```

## 快速开始

### 1. 准备凭据

编辑 `.env`（已被 `.gitignore` 排除）：

```
RELAY_KEY=你的中转站token
DEEPSEEK_KEY=你的deepseek key
GEMINI_KEY=你的gemini key
```

### 2. 配置 provider 与路由

```bash
cp providers.example.json providers.json
```

要点：

- 每个 provider 有独立的 `baseUrl` 和 `apiKey`（`apiKey` 写 `env:NAME` 从环境变量读，或直接写字面量）
- `apiType` 三选一：
  - `anthropic` — Anthropic 原生或兼容中转，**只做透传**，最快最安全
  - `openai` — OpenAI 兼容上游，走格式转换（DeepSeek/GLM/Kimi/Qwen/OpenAI）
  - `gemini` — Google Gemini
- `routes` 把 Claude Code 请求的模型名映射到 `{ provider, model }`
- `models` 字段可做二次映射：别名 → 上游真实模型 ID
- `pricing` 按最终模型名配置官方 API 价格，单位是 **美元 / 1,000,000 tokens**；字段为 `input`、`cacheRead`、`cacheWrite`、`output`

`providers.json` 已预置当前路由中常用模型的官方价格。需要覆盖价格时直接修改对应模型，例如：

```json
{
  "pricing": {
    "claude-opus-5-5": { "input": 4, "cacheRead": 0.4, "cacheWrite": 5, "output": 20 }
  }
}
```

价格按最终上游模型 ID 匹配，也可以在管理页「基础设置 → 模型价格」中编辑；修改后支持热更新，无需重启网关。

顶层 `pricing` 是各模型的原价。不同站点可以在 provider 上配置 `priceMultipliers`，对输入、输出、缓存读、缓存写分别设置倍率；模型 ID 精确匹配优先，`*` 是该站点其余模型的默认倍率，未设置的项按 1 计算：

管理页的站点倍率表同时提供「统一倍率」输入框，填写后会同步修改输入、输出、缓存读、缓存写四项；需要差异化计费时仍可逐项调整。

```json
{
  "name": "any",
  "priceMultipliers": {
    "*": { "input": 1.2, "output": 1.2 },
    "claude-opus-5-5": { "input": 1, "output": 1, "cacheRead": 0.5, "cacheWrite": 1 }
  }
}
```

账本每条记录同时保存 `baseCostUsd`（原价）、`priceMultiplier`（本次生效的倍率，原价时省略）和 `costUsd`（倍率后）。管理页的费用列默认显示原价，展开后可查看倍率后的金额和计费明细；趋势金额图也以原价绘制，悬浮时同时显示倍率后金额。这些金额按配置的单价和倍率计算，不代表站点账户余额或实际扣款。

### 计价热更新

- 管理页保存后，网关校验磁盘上的目标版本，原子替换全局单价和各 provider 倍率。确认成功后的新请求立即使用新计价；无须等待其他用户完成请求，也不会清空用量统计或重置并发队列。
- 每次请求在进入 `beginUsage()` 时锁定单价、倍率和计价版本，包括已进入并发排队的请求。流式响应、重试与请求结束记账均沿用这份快照，不会中途改价。账本新增 `pricingRevision`、`pricingEffectiveAt`，已完成账目不追溯重算。
- 直接编辑 `providers.json` 也支持：目录监听约 200ms 防抖，另有 1 秒轮询兜底（受事件循环负载影响）。解析或计价校验失败时保留上一份有效计价，文件修复后自动恢复。手动编辑应使用临时文件加重命名，避免加载尚未完成的编辑内容。
- 仅 `pricing` 和 `providers[].priceMultipliers` 热更新；地址、密钥、模型映射、路由、超时及并发限制保持启动配置。混合修改时计价可先应用，其余仍提示待重启；provider 新增或更名也必须重启。
- `GET /v1/pricing-status`（普通网关鉴权）可核对运行版本、生效时间、错误和待重启状态。`POST /v1/reload-pricing` 仅允许本机专用管理凭据，普通客户端 token 无权触发；管理端自动通过配置文件同目录下 `logs/pricing-runtime-*.json` 中的实例凭据调用，凭据不能提交或分享。
- 保存成功但网关离线、版本冲突或不支持热更新时，界面明确提示“已保存但未确认生效”，不会自动重启或回滚配置。首次部署此功能仍需在空闲时重启一次网关，并重新启动管理 Web 加载新代码；旧进程不会因为源码修改自动获得新能力。

### 3. 启动

```bash
node src/server.js
# 或双击 start.cmd
```

后台常驻（你已装 pm2）：

```bash
pm2 start src/server.js --name slizm-gateway
pm2 save
```

### 4. 自检

```bash
node scripts/selftest.js
```

逐个路由发真实请求，验证连通性 + 流式事件序列完整性。

### 5. 让 Claude Code 指向网关

**不要直接改主配置**，先用独立配置目录验证：

```bash
# 建一个隔离的配置目录
mkdir -p ~/.claude-gateway-test
cp ~/.claude/settings.json ~/.claude-gateway-test/settings.json
```

然后编辑该文件，只改 `env` 段：

```json
"ANTHROPIC_BASE_URL": "http://127.0.0.1:4000",
"ANTHROPIC_AUTH_TOKEN": "sk-local-gateway-change-me",
"ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-5-5",
"ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-5",
"ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5",
"CLAUDE_CODE_SUBAGENT_MODEL": "claude-opus-5-5"
```

`ANTHROPIC_DEFAULT_*_MODEL` 必须写 Claude Code 模型目录里的**真实 ID**，并在 `routes` 里配同名路由。
写 `plan`、`exec` 这类别名会触发 `isn't described by this version's model catalog` 告警，自动压缩也会按 200k 窗口处理。

启动：

```bash
CLAUDE_CONFIG_DIR=~/.claude-gateway-test claude
```

验证无误后，再把这几行搬进主配置。

## 按角色分配模型

在 `~/.claude/agents/` 下建子代理，用 frontmatter 的 `model:` 钉死档位：

```markdown
---
name: architect
description: 规划与架构设计，只输出方案不写实现
tools: Read, Grep, Glob
model: plan
---

你负责规划。分析需求、拆解任务、给出实现路径和文件清单。不要写实现代码。
```

```markdown
---
name: coder
description: 按既定方案执行编码
tools: Read, Edit, Write, Bash
model: exec
---

你负责执行。严格按 architect 的方案实现，不自行改变架构决策。
```

```markdown
---
name: scout
description: 代码库搜索与信息收集
tools: Read, Grep, Glob
model: scout
---

你负责搜索。快速定位文件、符号和调用关系，返回结论和文件:行号。
```

于是 `plan` = Claude、`exec` = DeepSeek、`scout` = Gemini，一个会话里三套 key 同时生效。

### 模型解析优先级（官方文档顺序）

```
1. 单次调用的 model 参数
2. 子代理定义里的 model frontmatter
3. CLAUDE_CODE_SUBAGENT_MODEL 环境变量
4. 主对话的模型
```

**注意**：`CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` 会无视 frontmatter 强制统一模型。
要做角色分派，**不要设这个变量**。

## 两个必须注意的坑

**1. 模型名分两种场景。**

- 子代理 frontmatter 的 `model:` 可以写自定义名（如 `exec`、`deepseek`），Claude Code 会**原样发给网关**（实测），前提是 `routes` 里注册过。
  例外是系列别名 `opus`：它会跟随主会话当前使用的 opus 模型。
- `ANTHROPIC_DEFAULT_*_MODEL` 必须写模型目录里的真实 ID（如 `claude-opus-5-5`），写别名会触发 catalog 告警。

**2. `ANTHROPIC_BASE_URL` 结尾不能带 `/v1`。**
Claude Code 自己会补 `/v1/messages`，多写就是 `/v1/v1/messages`，直接 404。

## 已知限制

| 限制 | 说明 |
|---|---|
| 图片/视觉输入 | 非 Anthropic 上游会被降级为文字标记，不会报错但看不到图 |
| MCP 工具 | 走非 Anthropic 上游时可能不可用；你有 CodeGraph MCP，注意子代理的 `tools` 声明 |
| Prompt cache | 跨 provider 缓存独立，切换即失效 |
| 计费 | 网关按上游上报的 usage 记 token 账，并按 `pricing` 中的官方 API 单价计算美元金额；金额仅反映配置的模型价格 |
| 推理过程 | OpenAI 类上游的 `reasoning_content` 会转成 thinking 块显示在 Claude Code 里，但没有 Anthropic 签名；同一会话切回 Claude 系列时，网关会先去掉这些无签名的 thinking 块，否则上游会 400 |

## Token 用量

```bash
node scripts/gw.js tokens            # 今天（本地时间 00:00 起）
node scripts/gw.js tokens 12h        # 最近 12 小时；7d = 最近 7 天；all = 账本全部
node scripts/gw.js tokens 7d --by route -n 20   # 按路由分组，显示最近 20 条
node scripts/gw.js tokens --table    # 图下面再附一张完整的数字表
node scripts/gw.js tokens all --by provider   # 按站点查看全部历史消耗
node scripts/gw.js tokens 7d --provider relay --table   # 只查看 relay 站点
```

报表是终端图形：
- **站点总览**：默认列出各 provider 的请求数、tokens 合计与美元费用；配置中的无用量站点和账本中的历史站点都会展示。站点按 provider 名称区分，不自动合并同域名配置。
- **总量构成**：一根堆叠横条（缓存读 / 缓存写 / 输入 / 输出），下面的图例带数值和占比。
- **趋势**：柱状图，展示 token 合计随时间的变化。48 小时以内按小时，更长按天；桶太多时自动合并。
- **分组对比**：每个模型（或路由、上游）一根按构成堆叠的横条，按用量排序。
- **最近请求**：每条的上下文大小（输入 + 缓存读 + 缓存写）画成细条，并显示该请求费用。

颜色取自经过色盲安全校验的色板。输出被管道或重定向时不上色，改用 `█ ▓ ▒ ░` 四种疏密不同的方块区分，`NO_COLOR=1` 或 `FORCE_COLOR=0` 效果相同。很小的部分至少画 1 格，免得看不见，精确数值以图例和 `--table` 为准。

- 每个请求结束时，网关向 `logs/usage-YYYY-MM.jsonl`（按本地月份分文件）追加一行：路由、上游、模型、状态、耗时、输入 / 缓存读 / 缓存写 / 输出四项 token，以及 `costUsd`。网关重启不丢，没在运行时也能查。
- token 一律按 Anthropic 语义统计：「输入」不含缓存。OpenAI 类上游的 `prompt_tokens` 含缓存命中，网关会拆成未缓存输入 + `cache_read_input_tokens`（两者之和不变，Claude Code 的上下文占用计算不受影响）。
- 只统计上游真实上报的数；请求中途断开时，已收到的 usage 照样计入（上游同样计费）。没有上报的请求标为「未上报」，只显示估算输入。
- 汇总和 `--table` 会显示美元费用；模型未配置价格时显示「未配置」，不会伪造为 `$0`。已保存的 `costUsd`（包括无法计价的 `null`）不随配置变化；旧账本没有 `costUsd` 时，报表按当前全局 `pricing` 兼容计算。
- `--provider` 按配置中的 provider 名称精确筛选，同时作用于总览、趋势、模型/路由分组、最近记录与在途请求；时间范围仍由 `today`、`12h`、`7d`、`all` 控制。
- 状态 499 表示客户端取消（在 Claude Code 里按 Esc），单独计数，不算失败。
- 报表末尾列出网关当前在途的请求；流式请求收到 `message_start` 后会显示本次上下文大小。
- 原始数据：`GET /v1/usage`（需客户端 token）返回本次启动以来的内存汇总、在途请求和最近 200 条。
- `GATEWAY_USAGE_DIR` 可改账本目录，设为 `off` 关闭。设置了自定义 `GATEWAY_CONFIG`（离线测试都会设）且没设 `GATEWAY_USAGE_DIR` 时不记账，避免测试数据混进真实账本。

## 按客户端选择客户端指纹

公共策略在 `src/providers/client-headers.js`。默认 `clientProfile: "auto"` 会先分析入站请求，再决定是否需要 profile 改写：

- `claude-cli/*`、`claude-code/*`、`x-claude-code-session-id`，或带有 Anthropic/Stainless 头的 `x-app: cli` 识别为 Claude Code。
- `Codex ...`、`originator` 或 `x-codex-*` 识别为 Codex。
- `deepseek-harness ...`、`x-deepseek-harness-*`、`x-harness-*` 或 `x-client-name: deepseek-harness` 识别为 DeepSeek Harness；其它带 `deepseek` 标识的请求识别为 DeepSeek。
- 默认情况下保留实际入站客户端指纹，包括自定义 `x-*` 头；仅删除客户端凭据、固定逐跳头、`Connection` 指定的逐跳头和需重新计算的长度/编码头，再设置上游鉴权。
- 唯一的自动改写特例是：**识别为 Claude Code 且最终上游模型属于 GPT/OpenAI 系列时**，生成既有 Codex 风格头，以保持 GPT 的缓存行为。Codex、DeepSeek Harness 和未知客户端不会因为目标模型名是 `gpt-*` 就被伪装成 Codex。
- 覆盖优先级为路由 `clientProfile` > provider `clientProfile` > 客户端识别。支持 `auto` / `claude` / `codex`；显式 `codex` 对 Claude Code 和未知客户端仍会生成 Codex profile，但已识别的 Codex/DeepSeek Harness 会优先保留自身入站指纹。
- Codex 请求不会混入 Claude 身份头；同一逻辑请求的重试复用 session/turn/request ID，独立请求使用新上下文，installation ID 在本进程内稳定。可用 `CODEX_INSTALLATION_ID` 固定跨重启标识。
- `codexVersion`、`codexOriginator`、`codexBetaFeatures` 继续可配置；沿用项目既有抓包模板，不宣称与未来或所有版本官方客户端完全一致。这里只调整 HTTP 头，不把 Chat Completions 变成 Responses API，不借用真实客户端凭据，也不保证通过上游客户端身份限制。
- Claude profile 只透传真实入站值，不为普通脚本凭空补造 Claude Code UA；OpenAI 兼容 adapter 也会透传被识别客户端的原始自定义头。

### 原生 Codex 接入

网关提供 `POST /v1/responses` 入口，并按客户端与 provider 分流：

- **Codex + `apiType: "openai"`**：直接请求该 provider 的 `baseUrl + /responses`，不经过 Anthropic 或 Chat Completions 转换。`baseUrl` 应是上游 API 前缀，例如 `https://example.com/v1`。上游必须支持 Responses API；不支持时原样返回上游错误，不自动降级。
- 非 Gemini 直通请求体只按路由替换顶层 `model`。`input`、`instructions`、tools、reasoning、未知字段和 `previous_response_id` 均保留，后者由上游处理。模型无需映射时直接使用原始 JSON；映射时也只替换 model 字符串。
- provider 和 API key 由路由选择；客户端网关凭据不会发给上游。保留原始 Codex 身份头，不生成新的 Codex 指纹。原生 Responses 的 `extraHeaders` 只补充非身份、非鉴权、非逐跳的辅助头，不能覆盖客户端已有头；协议转换路径保持原来的覆盖行为。逐跳头、Host、长度及压缩编码属于传输层处理，不承诺 HTTP 报文字节完全相同。
- Gemini 是明确例外：为兼容上游身份词检查，保留对 Codex instructions、Claude system 及 system/developer 消息身份句的适配，不修改普通用户消息。Claude Code + Anthropic 协议的非 Gemini 请求也保留原始 JSON，仅在需要时替换顶层 model。
- 可用性优先：保留并发控制、有限退避重试及 token 计数兼容回退。最终 Anthropic 错误正文完整转发，日志仅采样有上限的副本；不可安全重试的 5xx 仍附带原有的 `x-should-retry: false` 保护。Gemini 计数请求沿用身份句适配。这些保证不代表上游无法从 TLS、连接或时序识别代理。
- 上游 JSON、错误响应及 SSE 的响应体原样转发，不重新生成 ID 或事件，不把响应 model 改回别名。压缩响应按现有传输层解压后转发；usage 仅旁路读取用于记账。
- 其它客户端或 Anthropic/Gemini provider 继续走兼容转换：支持文本、developer 指令和基础 function tools，但不保证无损；兼容路径的 `previous_response_id` 仅保存在当前网关进程中。
- Claude Code 调用 GPT 时沿用既有 Codex 指纹特殊逻辑，此次直通功能不改变它。

这些规则同时用于生成、Anthropic token 计数及各适配器的模型发现；模型发现没有目标模型时使用 provider 的显式 profile 或默认 Claude profile。公开 `/v1/models` 仍只列本地路由。

配置 `proxy: "env:GATEWAY_PROXY"` 后，该环境变量缺失会在启动时失败，**不会悄悄改走直连**。`requireKey: false` 可用于明确无需凭据的上游，未配置 key 时不发送 `Bearer undefined`。

响应支持 gzip、deflate、br 及当前 Node 提供的 zstd 解压，并支持叠加编码；运行时不支持的编码会明确失败且禁止自动重放。解压错误或取消会关闭整条解码链和上游连接。

验证命令：

```bash
node --test scripts/test-hardening.mjs
npm test
```

## 安全说明

- `.env` 与 `providers.json` 已被 `.gitignore` 排除，**不要提交**
- 日志和错误信息统一过 `redact()`，key 不会打印到终端
- 网关是本地服务，只监听 `127.0.0.1`；**不要改成 `0.0.0.0`**，那等于把上游 key 暴露到局域网
- 客户端 token（`clientToken`）只是防止本机其他进程误用，不是强鉴权。真正的密钥保护靠"只监听回环地址"
