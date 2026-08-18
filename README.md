# OpenClaw Task Guardian

面向 OpenClaw 长程任务的监督与遵从插件。它把可靠性放在确定性代码层，而不是依赖模型“记住规则”：持久化任务状态、检查点、失联检测、有限恢复、完成验证、工具调用策略和审计均由插件执行。

## 能解决什么

- 长任务在 Gateway 或模型调用异常后保留状态与检查点。
- 任务长时间无有效进展时标记 `recovery_required`，通过下一轮注入与 Heartbeat 请求恢复。
- 模型必须通过 `task_guardian` 登记、汇报进展并提交完成证据。
- 完成前运行确定性检查（文件存在、大小、文本包含、JSON 指针值）。
- 在 `before_tool_call` 阶段拦截危险操作；高风险动作要求人工批准，缺少可信所有者身份时默认拒绝。
- 自然结束前检查任务状态，最多追加有限次数的纠偏轮次，避免无限自省循环。
- 追加 JSONL 审计记录；敏感参数不会写入日志。

## 安装

要求 OpenClaw `>= 2026.5.17` 和 Node.js `>= 22.22.3`。

```bash
openclaw plugins install git:DuruoYusdy/openclaw-task-guardian
openclaw plugins enable task-guardian
openclaw gateway restart
openclaw plugins inspect task-guardian --runtime --json
```

本地开发安装：

```bash
openclaw plugins install --link /absolute/path/to/openclaw-task-guardian
openclaw plugins enable task-guardian
openclaw gateway restart
```

## 推荐配置

在 `openclaw.json` 中启用对话访问和提示注入，否则工具策略与状态机仍能工作，但插件无法注入恢复上下文或执行结束纠偏。

```json5
{
  plugins: {
    entries: {
      "task-guardian": {
        enabled: true,
        hooks: {
          allowConversationAccess: true,
          allowPromptInjection: true,
          timeoutMs: 15000
        },
        config: {
          mode: "enforce",
          staleAfterMs: 300000,
          scanIntervalMs: 15000,
          maxRecoveryAttempts: 3,
          maxFinalizeRetries: 1,
          autoMonitorBackground: true,
          requireOwnerForRisky: true,
          protectedPaths: ["/srv/production", "C:\\production"],
          deniedTools: [],
          approvalTools: []
        }
      }
    }
  }
}
```

恢复通知依赖下一次会话轮次。建议为负责长任务的 agent 启用 OpenClaw Heartbeat；精确定时任务仍使用 Cron。插件不会私自创建第三方插件无权创建的调度任务。

## 弱模型使用协议

插件附带 `operate-long-task` skill。也可以直接要求 agent：

1. 调用 `task_guardian`，`action=register`，提交目标、成功标准与可执行检查。
2. 每完成一个有意义的步骤调用 `progress`；在长等待或切换执行者前调用 `checkpoint`。
3. 只在验证通过后调用 `complete`，并附证据。
4. 如果无法继续，调用 `fail`，说明可复现的阻塞原因；不能假装成功。
5. 只有工具返回 `succeeded` 后，才能向用户宣称任务完成。

示例注册参数：

```json
{
  "action": "register",
  "goal": "生成并验证日报",
  "successCriteria": ["report.md 存在", "包含 Summary 标题"],
  "checks": [
    { "kind": "file_exists", "path": "report.md" },
    { "kind": "file_contains", "path": "report.md", "value": "# Summary" }
  ]
}
```

人工可随时发送 `/guardian` 查看当前会话的活动任务，或 `/guardian <task-id>` 查看单个任务。

## 可靠性边界

Task Guardian 提供的是执行结构、恢复和策略层保证，不等于对任意自然语言目标的形式化证明。没有确定性检查的语义目标仍可能被模型错误理解；外部副作用仍需 OpenClaw sandbox、exec approval、渠道权限和最小权限凭据共同保护。插件对恢复次数和结束纠偏次数设硬上限，避免“为了稳定”制造无限循环。

详细设计见 [架构与失效模型](docs/ARCHITECTURE.md)，业界调研见 [调研报告](docs/INDUSTRY_RESEARCH.md)，生产运维见 [运行手册](docs/RUNBOOK.md)。

## 开发与测试

项目运行时无额外 npm 依赖；测试使用 Node.js 内置测试框架。

```bash
npm test
npm run check
```
