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
- 环境变量优先于 `.env`；配置、密钥及路由变更仍需要重启。

## 查看日志

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
    "claude-opus-5-5": { "input": 4, "cacheRead": 0.2, "cacheWrite": 5, "output": 20 }
  }
}
```

价格按最终上游模型 ID 匹配，修改 `providers.json` 后需要重启网关。

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
```

报表是终端图形：
- **总量构成**：一根堆叠横条（缓存读 / 缓存写 / 输入 / 输出），下面的图例带数值和占比。
- **趋势**：柱状图，展示 token 合计随时间的变化。48 小时以内按小时，更长按天；桶太多时自动合并。
- **分组对比**：每个模型（或路由、上游）一根按构成堆叠的横条，按用量排序。
- **最近请求**：每条的上下文大小（输入 + 缓存读 + 缓存写）画成细条，并显示该请求费用。

颜色取自经过色盲安全校验的色板。输出被管道或重定向时不上色，改用 `█ ▓ ▒ ░` 四种疏密不同的方块区分，`NO_COLOR=1` 或 `FORCE_COLOR=0` 效果相同。很小的部分至少画 1 格，免得看不见，精确数值以图例和 `--table` 为准。

- 每个请求结束时，网关向 `logs/usage-YYYY-MM.jsonl`（按本地月份分文件）追加一行：路由、上游、模型、状态、耗时、输入 / 缓存读 / 缓存写 / 输出四项 token，以及 `costUsd`。网关重启不丢，没在运行时也能查。
- token 一律按 Anthropic 语义统计：「输入」不含缓存。OpenAI 类上游的 `prompt_tokens` 含缓存命中，网关会拆成未缓存输入 + `cache_read_input_tokens`（两者之和不变，Claude Code 的上下文占用计算不受影响）。
- 只统计上游真实上报的数；请求中途断开时，已收到的 usage 照样计入（上游同样计费）。没有上报的请求标为「未上报」，只显示估算输入。
- 汇总和 `--table` 会显示美元费用；模型未配置价格时显示「未配置」，不会伪造为 `$0`。旧账本没有 `costUsd` 时，报表会按当前 `pricing` 兼容计算。
- 状态 499 表示客户端取消（在 Claude Code 里按 Esc），单独计数，不算失败。
- 报表末尾列出网关当前在途的请求；流式请求收到 `message_start` 后会显示本次上下文大小。
- 原始数据：`GET /v1/usage`（需客户端 token）返回本次启动以来的内存汇总、在途请求和最近 200 条。
- `GATEWAY_USAGE_DIR` 可改账本目录，设为 `off` 关闭。设置了自定义 `GATEWAY_CONFIG`（离线测试都会设）且没设 `GATEWAY_USAGE_DIR` 时不记账，避免测试数据混进真实账本。

## 按目标模型选择客户端指纹

公共策略在 `src/providers/client-headers.js`。默认 `clientProfile: "auto"`，根据**最终上游模型名**判断，不根据路由别名或 `apiType: "openai"` 判断。后者也包含 DeepSeek、Gemini 等兼容 API。

- `gpt-*`、`chatgpt-*`、`o数字` / `o数字-*`、`codex-*` 及相应的命名空间前缀（如 `openai/gpt-*`）使用 Codex 风格头。
- 其他模型保留真实入站 Claude Code 头，包括 `user-agent`、`accept`、`accept-encoding`、`x-app`、`x-stainless-*`、`x-claude-*`、`anthropic-*`。Anthropic 透传路径还保留其他端到端头。
- 所有路径删除客户端凭据、固定逐跳头、`Connection` 指定的逐跳头和需重新计算的长度/编码头，再设置上游鉴权。`extraHeaders` 最后按大小写不敏感的方式覆盖。
- 覆盖优先级为路由 `clientProfile` > provider `clientProfile` > 自动判断。支持 `auto` / `claude` / `codex`。不能从自定义模型名判断系列时可显式配置；路由设 `auto` 可覆盖 provider 的固定指纹。
- Codex 请求不会混入 Claude 身份头；同一逻辑请求的重试复用 session/turn/request ID，独立请求使用新上下文，installation ID 在本进程内稳定。可用 `CODEX_INSTALLATION_ID` 固定跨重启标识。
- `codexVersion`、`codexOriginator`、`codexBetaFeatures` 继续可配置；沿用项目既有抓包模板，不宣称与未来或所有版本官方客户端完全一致。这里只调整 HTTP 头，不把 Chat Completions 变成 Responses API，不借用真实客户端凭据，也不保证通过上游客户端身份限制。
- Claude profile 只透传真实入站值，不为普通脚本凭空补造 Claude Code UA。

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
