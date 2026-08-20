# context-compiler (super-flash-200k)

结构化工作记忆 / 上下文编译器插件。它不替代 dsh 的 session log：
**session log 永远保留原始对话、工具输出和错误**，插件只在其旁边维护
一份可检索、可审计、可恢复的编译状态。

## 数据

状态文件（运行时自动创建）：

- `$DSH_HOME/context-compiler/sessions/<session-id>.json`
- `$DSH_HOME/context-compiler/memory/<project-hash>.json`

每个 session 状态包含：

| 结构 | 内容 |
| --- | --- |
| `raw_log` | 原始事件的证据指针 + 摘要摘录；完整原文仍在 session log |
| `cards` | 原子 memory card：goal/constraint/preference/decision/todo/artifact/failure/fact/warning |
| `task_state` | goal、current_request、unresolved、blockers、last_action |
| `decision_log` | 决策 + 状态 |
| `artifact_index` | 文件/命令结果索引 |
| `snapshots` | 阈值触发的上下文快照 |
| `forgotten` | 被 context_forget 明确删除的 id（防止复活） |

## 事件流水线

1. `session/event`：捕获 user / assistant / tool result / todo 事件。
2. `turn/end`：增量抽取、去重、评分、更新 task_state。
3. `agent/pre-step`：每轮第一步注入 durable plugin user message
   （`source.kind = context-compiler`），不注入 system prompt。
4. 阈值：`softCompressAt=80000`、`stateSnapshotAt=120000`、
   `strongCompressAt=160000`、`hardRebuildAt=185000`（estimated tokens），
   达到后持久化 `compression_snapshot`。
5. `tools/pre-execute`：拒绝把 `cc://` / `context://` / `archive://`
   当成本地路径传给 shell/file 工具。

## 工具

- `context_search(query)` — BM25 + importance/recency boost + MMR 去重
- `context_read(id)` — 读 mem_/dec_/snap_/raw_seq_，或 turn_N / seq_N 原文
- `context_pin(id)` — 固定高优先级
- `context_remember(content, kind, scope)` — 显式写卡
- `context_supersede(old_id, new_content)` — 旧卡 superseded，可选写新卡
- `context_forget(id)` — 明确删除
- `context_report()` — 展示当前上下文包组成与审计结果

## 失真审计

每次生成 context package 时做确定性检查：

- 是否有活动 goal / 当前请求
- constraint/failure/decision 是否低置信度
- constraint 是否缺少证据指针
- decision 是否为过期状态

警告会出现在快照的 `Compression Audit` section 和 `context_report` 中。

## 当前版本边界（v1）

- 抽取是规则式（关键词 + 错误模式 + todo/write），不额外调用模型。
- 检索是词法混合（BM25 + importance + recency + MMR），未接 embedding。
- 审计是确定性规则，不是 LLM 自检。
- `raw_log` 侧车索引保留最近 400 条证据；原始 session log 不受影响。
- 项目/user/global 记忆通过 `context_remember(scope=...)` 写盘并在新会话导入。

修改 `agent.cordis.yml` 后需要重启 dsh web 才会重新加载 preset 模块。
