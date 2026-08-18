# 架构与失效模型

## 设计结论

OpenClaw 已经提供 Background Tasks、Task Flow、Cron/Heartbeat 与 typed plugin hooks。Task Guardian 不复制调度器，而是作为监督控制层：OpenClaw 继续拥有执行和任务事实，Guardian 保存更严格的目标契约、进展证据、恢复预算与策略审计。

```text
User goal
   │
   ▼
operate-long-task skill ──► task_guardian tool ──► atomic task snapshot + JSONL audit
   │                               │
   │                               ├─ deterministic completion verifiers
   │                               └─ bounded state transitions
   ▼
OpenClaw model/tool loop ──► typed hooks ──► policy gate / activity / finalize gate
   │
   ├─ Background Tasks / Task Flow (execution source of truth)
   ├─ Heartbeat (flexible recovery wake)
   └─ Cron (precise scheduled wake)
```

## 状态机

```text
registered ──progress──► running ──checkpoint──► checkpointed
    │                       │                         │
    │                       ├─stale + budget──► recovery_required
    │                       │                         │
    │                       ├─stale + exhausted► stalled
    │                       │
    └───────────────────────┴─verified complete──► succeeded
                             └─explicit failure───► failed
```

所有转移由代码验证。`complete` 必须有证据，且全部确定性检查通过。恢复次数和 finalize 纠偏次数都有硬上限。

## 持久化

- `state.json`：完整快照；同目录临时文件写入、`fsync`、原子替换。
- `audit.jsonl`：追加事件，只记录类别、任务/会话标识和裁剪后的安全元数据，不记录工具原始参数。
- 写入在进程内串行化，防止两个 hook 覆盖状态。
- 启动时重新读取快照；旧版本状态保留 `schemaVersion` 以便未来迁移。

## 遵从控制

1. **工具可见性**：插件声明 `contracts.tools`，避免运行时工具已注册但冷发现缺失。
2. **提示层**：短协议只描述模型必须做的动作，不承载安全边界。
3. **状态层**：任务 ID、状态转移、恢复预算和完成条件均由代码控制。
4. **策略层**：`before_tool_call` 识别 deny、protected path 和危险命令；强制模式 fail closed。
5. **验证层**：完成检查限制在工作区或显式允许根目录，抵抗 `../` 与符号链接越界。
6. **结束层**：活动任务不能直接自然结束；最多要求一次（可配置）纠偏，随后让宿主终止，防止无限循环。

## 失效场景

| 场景 | 处理 |
|---|---|
| 模型忘记更新进度 | `staleAfterMs` 后进入恢复状态，Heartbeat 注入最小恢复指令 |
| Gateway 崩溃/重启 | 原子快照保留；下一次扫描继续，内存中的 in-flight 标记自然消失 |
| 同一恢复重复投递 | 注入使用 `task-id + recovery-attempt` 幂等键 |
| 模型反复自省 | 恢复与 finalize 都有硬上限 |
| 模型声称完成但没有产物 | `complete` 失败，finalize gate 要求继续或明确失败 |
| 危险工具调用 | 硬拒绝或人工批准；没有可信 owner 时默认拒绝 |
| Hook 超时 | OpenClaw 的 policy hook 默认 fail closed；本插件 hook 不访问网络 |
| 审计泄密 | 不持久化原始参数；递归脱敏 secret/token/password/cookie 等键 |
| 检查路径越界 | 解析真实路径并验证属于允许根目录 |

## 为什么弱模型也能运行

弱模型只需学会一个工具和五个动作。复杂分支被折叠到状态机，成功判断尽量转为文件/JSON 检查，危险动作由 middleware 决策。模型质量影响计划效率与语义理解，但不再决定重试上限、是否越权、状态是否持久化或检查是否真的通过。
