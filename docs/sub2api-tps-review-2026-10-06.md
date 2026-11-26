# sub2api TPS 实现审查与本项目实现

审查日期：2026-10-06。上游固定版本：Wei-Shaw/sub2api，commit `b8dece9000c68815a5b867ca5a1e6f236e173905`。本次审查聚焦统计源码，不代表对整个上游项目的安全或性能审计。

## 审查发现

1. **同一项目有两种不同指标。** 运维 TPS 统计输入、输出和缓存 token 的消耗吞吐；模型统计的 `avg_tokens_per_sec` 是单次输出速率的算术平均。两者不能直接比较，也不能将运维 TPS 当成模型解码速度。这是口径风险，不是已证实的计算缺陷。
2. **输出 TPS 没有扣除首 token 等待。** SQL 使用 `output_tokens * 1000.0 / duration_ms`，而不是除以 `duration_ms - first_token_ms`。首 token 延迟作为另一个指标单独平均。端到端响应速度与首 token 后生成速度必须区别命名。
3. **平均方式不是总输出除以总耗时。** 上游逐请求求速率后执行 `AVG`，只包含输出和耗时均大于零的行。例如 100 token/1 秒和 100 token/10 秒，平均输出 TPS 是 55，不是 18.18。请求长度分布变化会改变均值，不能把它当作容量指标。
4. **实时吞吐仍来自用量记录的窗口查询。** 当前值为末 1 分钟 token / 60，峰值为自然分钟桶最大 token / 60。长请求的用量集中归入记录创建时段，实时推送也不是逐 token 采样。滑动 60 秒窗口可能跨两个自然分钟，因此当前值甚至可能大于“分钟峰值”。

## 上游证据

路径和行号均对应上述固定 commit：

| 位置 | 实现 |
| --- | --- |
| [ops_repo_openai_token_stats.go:37-53](https://github.com/Wei-Shaw/sub2api/blob/b8dece9000c68815a5b867ca5a1e6f236e173905/backend/internal/repository/ops_repo_openai_token_stats.go#L37-L53) | 按模型对有效输出速率求算术平均，保留两位小数；TTFT 单独平均 |
| [ops_repo_realtime_traffic.go:42-129](https://github.com/Wei-Shaw/sub2api/blob/b8dece9000c68815a5b867ca5a1e6f236e173905/backend/internal/repository/ops_repo_realtime_traffic.go#L42-L129) | SUM 四种 token、自然分钟分桶，平均值除以窗口秒数、峰值除以 60 |
| [ops_repo_dashboard.go:905-919](https://github.com/Wei-Shaw/sub2api/blob/b8dece9000c68815a5b867ca5a1e6f236e173905/backend/internal/repository/ops_repo_dashboard.go#L905-L919) | 当前 TPS 使用以 end 为右边界的末 1 分钟，固定除以 60 |
| [ops_metrics_collector.go:296-324](https://github.com/Wei-Shaw/sub2api/blob/b8dece9000c68815a5b867ca5a1e6f236e173905/backend/internal/service/ops_metrics_collector.go#L296-L324) | 后台采集器 tokenConsumed/windowSeconds，运维值保留一位小数 |
| [ops_metrics_collector.go:445-454](https://github.com/Wei-Shaw/sub2api/blob/b8dece9000c68815a5b867ca5a1e6f236e173905/backend/internal/service/ops_metrics_collector.go#L445-L454) | usage_logs 四种 token 求和，范围为 [start,end) |
| [ops_ws_handler.go:56-59](https://github.com/Wei-Shaw/sub2api/blob/b8dece9000c68815a5b867ca5a1e6f236e173905/backend/internal/handler/admin/ops_ws_handler.go#L56-L59) | 推送间隔 2 秒、缓存刷新间隔 5 秒、统计窗口 1 分钟 |
| [ops_ws_handler.go:253-280](https://github.com/Wei-Shaw/sub2api/blob/b8dece9000c68815a5b867ca5a1e6f236e173905/backend/internal/handler/admin/ops_ws_handler.go#L253-L280) | WebSocket qps_update 使用窗口 tokenConsumed/seconds |
| [openai_gateway_forward.go:39](https://github.com/Wei-Shaw/sub2api/blob/b8dece9000c68815a5b867ca5a1e6f236e173905/backend/internal/service/openai_gateway_forward.go#L39) | OpenAI Forward 入口记录 startTime |
| [openai_gateway_forward.go:1325-1326](https://github.com/Wei-Shaw/sub2api/blob/b8dece9000c68815a5b867ca5a1e6f236e173905/backend/internal/service/openai_gateway_forward.go#L1325-L1326) | 返回 Duration=time.Since(startTime)，FirstTokenMs 独立 |
| [openai_gateway_usage.go:335](https://github.com/Wei-Shaw/sub2api/blob/b8dece9000c68815a5b867ca5a1e6f236e173905/backend/internal/service/openai_gateway_usage.go#L335) | 从转发结果 Duration 取毫秒供账本使用 |
| [gateway_usage_billing.go:1240](https://github.com/Wei-Shaw/sub2api/blob/b8dece9000c68815a5b867ca5a1e6f236e173905/backend/internal/service/gateway_usage_billing.go#L1240) | Anthropic 计账路径记录创建时间使用 time.Now() |

调用关系：上游转发结果 → usage_logs → repository 窗口/模型聚合 → 运维 API 或 WebSocket → 前端格式化。TPS 不依赖前端自己数 SSE 帧，也不依赖 tokenizer 估算。

## 本项目落地

- `src/throughput.js`：共享纯函数，集中定义输出速率、有效样本平均及窗口吞吐。
- `src/usage.js`：`finishUsage` 合并最后一次真实 usage 后计算 `outputTokensPerSec`，写入月度 JSONL；按 provider/route/model/total 累计输出均值及样本数。重复结束不重复统计。
- `scripts/usage-report.js`：历史汇总复用相同函数。旧行无需新增字段即可由 outputTokens 和 durationMs 重算。
- `src/admin/data.js`：管理 API 按时间和 provider 筛选历史数据，返回吞吐、各维度平均输出速率及最近请求速率。
- 管理页：概览增加吞吐统计条，提供商/模型增加“平均输出 TPS”，最近请求增加“输出 TPS”。缺失输出速率显示 `-`，有效样本数放在读数提示中。

### API

`GET /v1/usage` 使用原有客户端鉴权，新增：

- `traffic`：本次运行最近 60 秒的消耗统计，包含 `since`、`until`、`windowSeconds`、`currentWindowSeconds`、`peakBucketSeconds`、`tokenConsumed` 和 `tps.current/peak/avg`。
- `totals/providers/routes/models`：新增 `avgOutputTokensPerSec`、`outputTpsSamples`。没有有效样本时均值为 null、样本数为零。
- `recent[]`：新增 `outputTokensPerSec`，原始计时和 token 字段仍保留。

`GET /api/overview` 使用原有管理会话鉴权，新增历史 `traffic`、全局/provider/model 输出均值及样本数，`recent[]` 返回重算后的单次速率。账本不可用时 traffic 为 null，不伪造零吞吐。运行内存统计重启清零；历史统计来自账本，重启不丢。

### 有意保留的差异

- 本项目的总耗时从 `beginUsage` 到 `finishUsage`，包括本地并发排队、退避重试、上游响应等待和转发。上游 OpenAI Duration 从 Forward 入口开始；两者公式一致，但起点不同，不能假设数值严格可比。
- 输出均值只纳入成功、无 error、明确上报正数输出且耗时为正的请求，避免失败/取消的部分用量污染成功响应速度。上游模型 SQL 本身只有输出和耗时大于零的判定。
- 消耗吞吐仍纳入取消/失败时已经上报的 token，因为它们属于真实用量；估算输入不参与统计。四项 token 已按项目原有 Anthropic 语义拆分，缓存不重复计入输入。
- 历史当前值限定在所选范围内末 60 秒，峰值限定所选范围的自然分钟桶，两者固定除以 60。短于 60 秒的交集不按局部时长放大。上游 queryCurrentRates 从 end 向前取完整 60 秒，可能越过筛选起点。
- 平均吞吐的分母是完整所选时段，包含空闲时间；未来结束时间截断至现在。“全部”从所选 provider 的最早记录开始。分钟峰值不是逐秒峰值。
- 内部速率不提前四舍五入，管理页展示两位小数。运行窗口独立于 recent 的 200 条限制，并按时间淘汰；超过 200 个已完成请求也不会漏算。
- 不新增外部依赖、数据库、TTFT 采集或 tokenizer，不修改上游响应字节及协议转换逻辑。新代码需重启对应进程才能启用，未自动重启用户正在运行的服务。

## 验证

`npm run test:tps` 覆盖公式、算术平均、取消/错误/未上报/非法值、四项 token 合计、窗口边界、空闲、零时段、旧账本、站点筛选、重复结束、流式最终用量及超过 200 条的运行窗口。UI 测试验证精度、单位、空值与新列。Messages/Responses 端到端测试验证真实转发产生的统计和流异常排除。全量回归入口是 `npm test`。
