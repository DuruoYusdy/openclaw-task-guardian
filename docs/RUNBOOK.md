# 运行手册

## 上线前

1. 运行 `npm test` 与 `npm run check`。
2. 执行 `openclaw plugins inspect task-guardian --runtime --json`，确认 manifest、tool contract 与 skill 可见。
3. 在测试 agent 上启用 Heartbeat，创建一个 1 分钟后故意停止更新的任务，确认进入 `recovery_required`。
4. 验证高风险命令触发审批，系统/cron 发起且无 owner 身份时被拒绝。
5. 检查 `state.json` 权限，仅 OpenClaw 服务账户可读写。

## 日常检查

- 聊天中使用 `/guardian`。
- 使用 OpenClaw 原生 `openclaw tasks audit` 检查 detached task/Task Flow。
- 查看 `<storagePath>/audit.jsonl`，重点关注 `policy_block`、`policy_approval`、`recovery_exhausted`。
- 不要把 audit 文件直接发送给模型；先做脱敏和最小范围筛选。

## 告警建议

- `recovery_required`：warning；等待下一次 Heartbeat。
- `stalled` 或 `recovery_exhausted`：error；人工检查 checkpoint 和 OpenClaw task ledger。
- `policy_block`：warning；若持续出现，检查 agent 是否被 prompt injection 或 skill 未加载。
- `completion_rejected`：warning；检查 verifier 路径与产物格式。

## 恢复步骤

1. `/guardian <task-id>` 获取 goal、checkpoint、lastProgressAt 和 recoveryAttempts。
2. 用 `openclaw tasks show <lookup>` 核对宿主执行记录。
3. 若 backing task 仍在运行，不要重复启动；等待 push 完成或取消原 task。
4. 若 backing task 已丢失，从 checkpoint 恢复，并使用原 task ID 调用 `progress`。
5. 恢复预算耗尽后必须人工决定继续、重建任务或标记失败。

## 升级与回滚

- 升级前备份 `state.json` 与 `audit.jsonl`。
- 新版本必须支持旧 `schemaVersion` 或提供迁移脚本。
- 回滚代码前确认新版本没有写入旧版本不能理解的 schema。
- 禁用插件不会删除状态目录；确认不再需要后再人工归档。
