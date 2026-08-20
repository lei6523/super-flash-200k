# flash-200k

DSH agent preset 插件库：`super-flash-200k`。

在 flash-super（风神 Router）基础上加入 200k 上下文控制 + **Context Compiler**：

- 原文归档：完整原始对话/工具输出保留在 dsh session log，永不删除。
- 结构化记忆：memory cards / task_state / decision_log / artifact_index / compression_snapshot。
- 动态装配：`agent/pre-step` 每轮第一步注入 durable plugin user message，不塞 system prompt。
- 证据检索：`context_search`（BM25 + importance/recency + MMR）、`context_read` 可回查 `turn_N` / `seq_N` / `mem_id` 原文。
- 压缩审计：低置信度约束、缺证据约束、过期决策会进入 `Compression Audit`。
- URI 保护：`cc://` / `context://` / `archive://` 不会被 shell/file 工具当成本地路径。

## 目录

```
flash-200k/
├── super-flash-200k/        # dsh preset 本体
│   ├── agent.cordis.yml
│   ├── context-compiler.mjs
│   ├── context-compiler.README.md
│   ├── preset.yml
│   ├── router-bootstrap.mjs
│   └── router-core.mjs
└── install.sh
```

## 安装

```bash
./install.sh
```

脚本会把 `super-flash-200k/` 复制到：

```text
${DSH_HOME:-~/.dsh}/.agent-presets/super-flash-200k
```

如果目标已存在，脚本会先备份到 `super-flash-200k.bak-<时间戳>`，再写入新版本。

安装后重启 dsh web，在会话 preset 选择器里选：

```text
super-flash-200k (风神 · Flash · 200K)
```

## 主要配置

`agent.cordis.yml` 的 `context-compiler` 行：

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `injectMaxChars` | 12000 | 每轮注入快照的最大字符数 |
| `evidenceMaxChars` | 1600 | 单条原文证据摘录上限 |
| `softCompressAt` | 80000 | 软压缩快照阈值（estimated tokens） |
| `stateSnapshotAt` | 120000 | 状态快照阈值 |
| `strongCompressAt` | 160000 | 强压缩快照阈值 |
| `hardRebuildAt` | 185000 | 硬重建阈值 |
| `targetInputTokens` | 150000 | 目标输入预算参考值 |

## 模型可见工具

`context_search`、`context_read`、`context_pin`、`context_remember`、
`context_supersede`、`context_forget`、`context_report`。

## 状态文件

运行时自动生成：

```text
$DSH_HOME/context-compiler/sessions/<session-id>.json
$DSH_HOME/context-compiler/memory/<project-hash>.json
```

完整设计说明见 `super-flash-200k/context-compiler.README.md`。
