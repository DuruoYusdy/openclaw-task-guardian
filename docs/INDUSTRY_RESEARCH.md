# 业界调研：是否用插件/中间件保障长程 Agent

结论：**会用，但成熟方案通常不只靠插件。** 插件或 middleware 适合做拦截、策略、遥测和提示注入；真正的长程可靠性依赖外部化状态、持久工作流、幂等副作用、检查点和人工批准。Task Guardian 采用这一分层，而不是宣称一个 prompt 插件就能“保证”所有任务。

## OpenClaw 生态

- OpenClaw 官方 typed plugin hooks 明确支持 `before_tool_call` 拦截/改写/审批、`before_agent_finalize` 追加有限纠偏、Heartbeat 注入和 Gateway 生命周期。这证明插件是官方认可的控制面。[Plugin hooks](https://docs.openclaw.ai/plugins/hooks)
- OpenClaw Background Tasks 是 detached work 的活动账本，不是调度器；官方建议由 Cron/Heartbeat 决定运行时机，并强调完成通知应以 push 为主。[Background tasks](https://docs.openclaw.ai/automation/tasks)
- Task Flow 是原生的持久多步编排状态；Plugin SDK 暴露 task view/managed flow API，但第三方插件不应重造调度器。[Plugin runtime helpers](https://docs.openclaw.ai/plugins/sdk-runtime)
- 社区已经有 OpenClaw observability plugin，说明用插件汇出运行遥测是现实做法；但单纯可观测并不能提供恢复或策略保证。[openclaw-observability-plugin](https://github.com/henrikrexed/openclaw-observability-plugin)

## 主流 Agent/工作流体系

- LangGraph 用 checkpoint 保存图状态，`interrupt()` 可暂停数小时或数天并恢复，人工审批也建立在持久状态上。这是“外部化状态 + 可恢复中断”的代表。[LangGraph human-in-the-loop](https://github.com/langchain-ai/langgraphjs/blob/main/docs/docs/agents/human-in-the-loop.md)
- Temporal 将 agent loop 放进 durable workflow，把模型与工具调用作为 activities，获得重试、进程重启恢复、signal 与长时间等待能力。它解决的是执行骨架，而不是提示词。[Temporal OpenAI Agents integration](https://github.com/temporalio/documentation/blob/main/docs/develop/typescript/integrations/openai-agents.mdx)
- OpenAI Agents SDK 官方文档把 Dapr、Temporal、Restate 列为 durable execution 集成，适用于长等待、重试、进程重启和 human-in-the-loop。[OpenAI Agents SDK: running agents](https://openai.github.io/openai-agents-python/running_agents/)
- LlamaFirewall 将 prompt injection、agent alignment 和代码安全放在独立 guardrail 层，说明安全/遵从需要模型之外的运行时检查。[LlamaFirewall paper](https://arxiv.org/abs/2505.03574)

## 对本项目的直接启示

| 业界模式 | Task Guardian 采用方式 |
|---|---|
| Plugin middleware | typed hooks 拦截工具、注入恢复上下文、结束前检查 |
| Durable state | 原子快照 + append-only 审计 |
| Checkpoint/resume | 显式 checkpoint、stale 检测、幂等恢复注入 |
| Workflow retries | 有界 recovery budget，不无限重试 |
| Human-in-the-loop | 高风险工具调用 requireApproval |
| Runtime guardrails | deny/approval/protected-path 均由代码判定 |
| Deterministic validation | 文件、文本、JSON 检查后才能成功 |
| Observability | 状态查询、`/guardian`、审计日志 |

## 不采用的做法

- 不使用“每 N 秒让模型自检”的无限轮询：昂贵、容易制造重复副作用，也与 OpenClaw 的 push-driven task 完成模型冲突。
- 不把原始 prompt、工具参数或密钥写入审计。
- 不让第三方插件越权创建宿主专属 scheduled turns；使用 Heartbeat/Cron 作为官方唤醒面。
- 不用第二个 LLM 作为唯一合规裁判；模型裁判可选，但确定性规则必须先行。

## 适用边界

若任务需要跨服务的严格 exactly-once、副作用补偿、数周等待或多 worker 容灾，应把 Temporal、Dapr、Restate 或同类 durable workflow 作为执行层，Task Guardian 保留为 OpenClaw 入口的策略与可观测插件。单机 OpenClaw 场景下，本项目的文件持久化与原生 Task Flow 已足够轻量。
