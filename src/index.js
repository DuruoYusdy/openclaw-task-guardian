import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeConfig, handlesAgent } from "./config.js";
import { TaskGuardian } from "./guardian.js";
import { classifyToolCall, toHookResult } from "./policy.js";
import { GUARDIAN_PROTOCOL, recoveryInstruction, taskSummary } from "./protocol.js";
import { TASK_GUARDIAN_PARAMETERS } from "./schemas.js";
import { JsonTaskStore } from "./store.js";

function sessionKeyFrom(value) {
  return value?.sessionKey ?? value?.session?.key ?? value?.session?.sessionKey;
}

function workspaceFrom(value) {
  return value?.workspaceDir ?? value?.workspaceRoot ?? value?.cwd;
}

function result(taskOrTasks, ok = true) {
  const details = Array.isArray(taskOrTasks)
    ? { ok, tasks: taskOrTasks }
    : { ok, task: taskOrTasks, status: taskOrTasks?.status };
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
  };
}

function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: `Task Guardian rejected the action: ${message}` }],
    details: { ok: false, error: message },
  };
}

function safeGoal(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 4000) : fallback;
}

export default definePluginEntry({
  id: "task-guardian",
  name: "Task Guardian",
  description: "Deterministic supervision, recovery, verification, and policy for long-running tasks.",
  register(api) {
    const rawConfig = api.pluginConfig ?? {};
    const normalized = normalizeConfig(rawConfig);
    const config = Object.freeze({
      ...normalized,
      storagePath: api.resolvePath(normalized.storagePath),
      protectedPaths: normalized.protectedPaths.map((item) => api.resolvePath(item)),
      allowedVerificationRoots: normalized.allowedVerificationRoots.map((item) => api.resolvePath(item)),
    });
    const store = new JsonTaskStore(config.storagePath);
    const guardian = new TaskGuardian(store, config, {
      allowedVerificationRoots: config.allowedVerificationRoots,
    });
    let scanTimer;
    let scanRunning = false;

    const scan = async () => {
      if (scanRunning) return;
      scanRunning = true;
      try {
        const transitions = await guardian.scanStale();
        for (const transition of transitions) {
          if (transition.type !== "recovery_required" || !transition.task.sessionKey) continue;
          const injection = await api.session.workflow.enqueueNextTurnInjection({
            sessionKey: transition.task.sessionKey,
            text: recoveryInstruction(transition.task),
            idempotencyKey: `task-guardian:${transition.task.id}:recovery:${transition.task.recoveryAttempts}`,
            placement: "append",
            ttlMs: 24 * 60 * 60 * 1000,
          });
          if (!injection?.enqueued) {
            api.logger.warn(`Task Guardian could not queue recovery context for ${transition.task.id}.`);
          }
        }
      } catch (error) {
        api.logger.error(`Task Guardian scan failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        scanRunning = false;
      }
    };

    api.registerTool(
      (toolContext) => ({
        name: "task_guardian",
        label: "Task Guardian",
        description:
          "Mandatory control tool for long-running work. Register once, report progress/checkpoints, and call complete only with exact criteria and evidence. Never claim success unless this tool returns status=succeeded.",
        parameters: TASK_GUARDIAN_PARAMETERS,
        async execute(_toolCallId, params) {
          const context = {
            sessionKey: sessionKeyFrom(toolContext),
            agentId: toolContext?.agentId,
            workspaceRoot: workspaceFrom(toolContext),
          };
          try {
            switch (params.action) {
              case "register":
                return result(await guardian.registerTask(params, context));
              case "progress":
                return result(await guardian.progress(params.taskId, params));
              case "checkpoint":
                return result(await guardian.checkpoint(params.taskId, params));
              case "complete":
                return result(await guardian.complete(params.taskId, params));
              case "fail":
                return result(await guardian.fail(params.taskId, params));
              case "status":
                return result(await guardian.getTask(params.taskId));
              case "list":
                return result(await guardian.listTasks({ sessionKey: context.sessionKey, activeOnly: params.activeOnly === true }));
              default:
                throw new Error(`Unsupported action: ${params.action}`);
            }
          } catch (error) {
            return errorResult(error);
          }
        },
      }),
      { name: "task_guardian" },
    );

    api.registerCommand({
      name: "guardian",
      description: "Show guarded long-running tasks for this session or one task by ID.",
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx) => {
        try {
          const taskId = typeof ctx.args === "string" ? ctx.args.trim() : "";
          const data = taskId
            ? await guardian.getTask(taskId)
            : await guardian.listTasks({ sessionKey: sessionKeyFrom(ctx), activeOnly: false });
          return { text: `Task Guardian\n${JSON.stringify(data, null, 2)}` };
        } catch (error) {
          return { text: `Task Guardian error: ${error instanceof Error ? error.message : String(error)}` };
        }
      },
    });

    api.on("gateway_start", async () => {
      await store.init();
      await scan();
      scanTimer = setInterval(() => void scan(), config.scanIntervalMs);
      scanTimer.unref?.();
      api.logger.info(`Task Guardian started in ${config.mode} mode.`);
    });

    api.on("gateway_stop", async () => {
      if (scanTimer) clearInterval(scanTimer);
      scanTimer = undefined;
      await store.close();
    });

    api.on(
      "before_tool_call",
      async (event, ctx) => {
        if (!handlesAgent(config, ctx?.agentId)) return;
        const decision = classifyToolCall(event, ctx, config);
        if (decision.kind !== "allow") {
          await store.audit(decision.kind === "block" ? "policy_block" : "policy_approval", {
            toolName: event.toolName,
            agentId: ctx?.agentId,
            sessionKey: ctx?.sessionKey,
            reason: decision.reason,
          });
        }
        await guardian.markActivity(ctx?.sessionKey, `tool-start:${event.toolName}`);
        return toHookResult(decision, config, event);
      },
      { priority: 100, timeoutMs: 10_000 },
    );

    api.on("after_tool_call", async (event, ctx) => {
      if (!handlesAgent(config, ctx?.agentId)) return;
      const failed = Boolean(event?.error) || event?.success === false;
      await guardian.markActivity(ctx?.sessionKey, `tool-end:${event.toolName}`, { progress: !failed });
    });

    api.on("before_prompt_build", async (_event, ctx) => {
      if (!config.injectProtocol || !handlesAgent(config, ctx?.agentId)) return;
      const task = await guardian.findActiveForSession(ctx?.sessionKey);
      return { appendSystemContext: task ? `${GUARDIAN_PROTOCOL}\n\n${taskSummary(task)}` : GUARDIAN_PROTOCOL };
    });

    api.on("heartbeat_prompt_contribution", async (_event, ctx) => {
      if (!handlesAgent(config, ctx?.agentId)) return;
      const tasks = await guardian.listTasks({ sessionKey: ctx?.sessionKey, activeOnly: true });
      if (tasks.length === 0) return;
      return {
        appendContext: `${GUARDIAN_PROTOCOL}\n\n${tasks.slice(0, 5).map(taskSummary).join("\n\n")}`,
      };
    });

    api.on("before_agent_run", async (event, ctx) => {
      if (!config.autoMonitorBackground || !handlesAgent(config, ctx?.agentId) || !ctx?.jobId) return;
      await guardian.ensureBackgroundTask({
        externalKey: `cron:${ctx.jobId}:${ctx.runId ?? "current"}`,
        goal: safeGoal(event?.prompt, `Run OpenClaw automation job ${ctx.jobId}`),
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
        workspaceRoot: workspaceFrom(ctx),
      });
    });

    api.on("before_agent_finalize", async (_event, ctx) => {
      if (!handlesAgent(config, ctx?.agentId)) return;
      const task = await guardian.findActiveForSession(ctx?.sessionKey);
      if (!task || config.maxFinalizeRetries === 0) return;
      await store.audit("finalize_revision_requested", { taskId: task.id, sessionKey: task.sessionKey, status: task.status });
      return {
        action: "revise",
        reason: `Guarded task ${task.id} is still ${task.status}; completion has not been verified.`,
        retry: {
          instruction: `Use task_guardian now. If the goal is complete, submit exact criteriaSatisfied and evidence. Otherwise report progress or fail explicitly. Do not claim completion while status is ${task.status}.`,
          idempotencyKey: `task-guardian:finalize:${task.id}`,
          maxAttempts: config.maxFinalizeRetries,
        },
      };
    });

    api.on("subagent_spawned", async (event, ctx) => {
      if (!config.autoMonitorBackground || !handlesAgent(config, ctx?.agentId)) return;
      const target = event.childSessionKey ?? event.targetSessionKey;
      if (!target) return;
      await guardian.ensureBackgroundTask({
        externalKey: `subagent:${target}`,
        goal: safeGoal(event.task ?? event.prompt, `Monitor delegated task ${target}`),
        sessionKey: target,
        agentId: ctx?.agentId,
        workspaceRoot: workspaceFrom(ctx),
      });
    });

    api.on("subagent_ended", async (event) => {
      if (!config.autoMonitorBackground || !event.targetSessionKey) return;
      await guardian.settleExternal(
        `subagent:${event.targetSessionKey}`,
        event.outcome ?? event.reason,
        safeGoal(event.error, `Subagent ended: ${event.outcome ?? event.reason ?? "unknown"}`),
      );
    });

    api.on("cron_changed", async (event) => {
      if (!config.autoMonitorBackground || !event?.job?.id) return;
      const runId = event.runId ?? event.job?.state?.lastRunId ?? "current";
      const externalKey = `cron:${event.job.id}:${runId}`;
      if (event.reason === "started") {
        await guardian.ensureBackgroundTask({
          externalKey,
          goal: `Monitor OpenClaw cron job ${event.job.id}`,
          sessionKey: event.sessionKey,
          agentId: event.agentId,
        });
      } else if (event.reason === "finished") {
        const activeCronTask = (await guardian.listTasks({ activeOnly: true })).find(
          (task) => task.externalKey === externalKey || task.externalKey?.startsWith(`cron:${event.job.id}:`),
        );
        if (!activeCronTask) return;
        await guardian.settleExternal(
          activeCronTask.externalKey,
          event.job?.state?.lastRunStatus ?? event.status,
          safeGoal(event.job?.state?.lastError, `Cron job ${event.job.id} finished`),
        );
      }
    });

    api.on("agent_end", async (_event, ctx) => {
      if (!handlesAgent(config, ctx?.agentId)) return;
      await guardian.markActivity(ctx?.sessionKey, "agent-end");
    });
  },
});
