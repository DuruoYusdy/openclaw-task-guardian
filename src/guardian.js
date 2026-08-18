import crypto from "node:crypto";
import { runChecks } from "./verifier.js";

const ACTIVE = new Set(["registered", "running", "checkpointed", "recovery_required"]);
const TERMINAL = new Set(["succeeded", "failed", "stalled", "cancelled"]);
const MAX_EVIDENCE = 50;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function iso(now) {
  return new Date(now).toISOString();
}

function boundedStrings(value, limit = 50) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item.trim()).slice(0, limit).map((item) => item.trim().slice(0, 2000));
}

function fingerprint(sessionKey, goal, idempotencyKey) {
  return crypto.createHash("sha256").update(`${sessionKey ?? "unbound"}\0${idempotencyKey ?? goal}`).digest("hex").slice(0, 24);
}

function publicTask(task) {
  return structuredClone(task);
}

function requireTask(state, taskId) {
  const task = state.tasks[taskId];
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  return task;
}

function requireActive(task) {
  if (!ACTIVE.has(task.status)) throw new Error(`Task ${task.id} is terminal (${task.status}).`);
}

export class TaskGuardian {
  constructor(store, config, { now = () => Date.now(), allowedVerificationRoots = [] } = {}) {
    this.store = store;
    this.config = config;
    this.now = now;
    this.allowedVerificationRoots = allowedVerificationRoots;
  }

  async registerTask(params, context = {}) {
    const goal = typeof params.goal === "string" ? params.goal.trim() : "";
    if (!goal) throw new Error("register requires a non-empty goal.");
    const successCriteria = boundedStrings(params.successCriteria, 30);
    if (successCriteria.length === 0) throw new Error("register requires at least one success criterion.");
    const checks = Array.isArray(params.checks) ? params.checks.slice(0, 32) : [];
    const taskFingerprint = fingerprint(context.sessionKey, goal, params.idempotencyKey);
    const now = this.now();

    const task = await this.store.update((state) => {
      const existing = Object.values(state.tasks).find(
        (item) => item.fingerprint === taskFingerprint && ACTIVE.has(item.status),
      );
      if (existing) return existing;

      const id = crypto.randomUUID();
      const created = {
        id,
        fingerprint: taskFingerprint,
        externalKey: context.externalKey,
        goal: goal.slice(0, 4000),
        successCriteria,
        checks,
        status: "registered",
        sessionKey: context.sessionKey,
        agentId: context.agentId,
        workspaceRoot: context.workspaceRoot,
        createdAt: iso(now),
        updatedAt: iso(now),
        lastActivityAt: iso(now),
        lastProgressAt: iso(now),
        deadlineAt: typeof params.deadlineAt === "string" ? params.deadlineAt : undefined,
        recoveryAttempts: 0,
        maxRecoveryAttempts: Number.isInteger(params.maxRecoveryAttempts)
          ? Math.min(10, Math.max(0, params.maxRecoveryAttempts))
          : this.config.maxRecoveryAttempts,
        checkpoint: undefined,
        evidence: [],
        history: [{ at: iso(now), from: null, to: "registered", reason: "registered" }],
      };
      state.tasks[id] = created;
      return created;
    });
    await this.store.audit("task_registered", { taskId: task.id, sessionKey: task.sessionKey, goal: task.goal });
    return publicTask(task);
  }

  async ensureBackgroundTask({ externalKey, goal, sessionKey, agentId, workspaceRoot }) {
    const state = await this.store.read();
    const existing = Object.values(state.tasks).find((task) => task.externalKey === externalKey && ACTIVE.has(task.status));
    if (existing) return publicTask(existing);
    return this.registerTask(
      {
        goal: goal || `Monitor OpenClaw background task ${externalKey}`,
        successCriteria: ["The backing OpenClaw task reaches a terminal state and its outcome is recorded."],
        idempotencyKey: externalKey,
      },
      { externalKey, sessionKey, agentId, workspaceRoot },
    );
  }

  async progress(taskId, params) {
    const summary = typeof params.summary === "string" ? params.summary.trim() : "";
    if (!summary) throw new Error("progress requires a non-empty summary.");
    const now = this.now();
    const task = await this.store.update((state) => {
      const current = requireTask(state, taskId);
      requireActive(current);
      const from = current.status;
      current.status = "running";
      current.updatedAt = iso(now);
      current.lastActivityAt = iso(now);
      current.lastProgressAt = iso(now);
      current.lastProgressSummary = summary.slice(0, 4000);
      current.evidence = [...current.evidence, ...boundedStrings(params.evidence)].slice(-MAX_EVIDENCE);
      current.history.push({ at: iso(now), from, to: "running", reason: "progress" });
      return current;
    });
    await this.store.audit("task_progress", { taskId, summary });
    return publicTask(task);
  }

  async checkpoint(taskId, params) {
    const summary = typeof params.summary === "string" ? params.summary.trim() : "";
    if (!summary) throw new Error("checkpoint requires a non-empty summary.");
    const now = this.now();
    const task = await this.store.update((state) => {
      const current = requireTask(state, taskId);
      requireActive(current);
      const from = current.status;
      current.status = "checkpointed";
      current.checkpoint = summary.slice(0, 8000);
      current.updatedAt = iso(now);
      current.lastActivityAt = iso(now);
      current.lastProgressAt = iso(now);
      current.evidence = [...current.evidence, ...boundedStrings(params.evidence)].slice(-MAX_EVIDENCE);
      current.history.push({ at: iso(now), from, to: "checkpointed", reason: "checkpoint" });
      return current;
    });
    await this.store.audit("task_checkpoint", { taskId, summary });
    return publicTask(task);
  }

  async complete(taskId, params) {
    const snapshot = await this.getTask(taskId);
    requireActive(snapshot);
    const evidence = [...snapshot.evidence, ...boundedStrings(params.evidence)].slice(-MAX_EVIDENCE);
    if (evidence.length === 0) throw new Error("complete requires non-empty evidence.");

    const satisfied = new Set(boundedStrings(params.criteriaSatisfied, 30));
    const missing = snapshot.successCriteria.filter((criterion) => !satisfied.has(criterion));
    if (missing.length > 0) throw new Error(`Unsatisfied success criteria: ${missing.join(" | ")}`);

    const checkResults = await runChecks(snapshot.checks, {
      workspaceRoot: snapshot.workspaceRoot,
      allowedRoots: this.allowedVerificationRoots,
    });
    const failedChecks = checkResults.filter((result) => !result.passed);
    if (failedChecks.length > 0) {
      await this.store.audit("completion_rejected", { taskId, failedChecks });
      throw new Error(`Completion checks failed: ${failedChecks.map((item) => `${item.kind}:${item.path}`).join(", ")}`);
    }

    const now = this.now();
    const task = await this.store.update((state) => {
      const current = requireTask(state, taskId);
      requireActive(current);
      const from = current.status;
      current.status = "succeeded";
      current.evidence = evidence;
      current.checkResults = checkResults;
      current.completedAt = iso(now);
      current.updatedAt = iso(now);
      current.history.push({ at: iso(now), from, to: "succeeded", reason: "verified completion" });
      return current;
    });
    await this.store.audit("task_succeeded", { taskId, evidenceCount: evidence.length, checkResults });
    return publicTask(task);
  }

  async fail(taskId, params) {
    const reason = typeof params.reason === "string" ? params.reason.trim() : "";
    if (!reason) throw new Error("fail requires a non-empty reason.");
    return this.#terminal(taskId, "failed", reason);
  }

  async settleExternal(externalKey, outcome, reason = "OpenClaw backing task ended") {
    const state = await this.store.read();
    const task = Object.values(state.tasks).find((item) => item.externalKey === externalKey && ACTIVE.has(item.status));
    if (!task) return undefined;
    if (outcome === "ok" || outcome === "succeeded" || outcome === "success") {
      const now = this.now();
      const settled = await this.store.update((draft) => {
        const current = requireTask(draft, task.id);
        if (!ACTIVE.has(current.status)) return current;
        const from = current.status;
        current.status = "succeeded";
        current.completedAt = iso(now);
        current.updatedAt = iso(now);
        current.evidence = [...current.evidence, reason].slice(-MAX_EVIDENCE);
        current.history.push({ at: iso(now), from, to: "succeeded", reason });
        return current;
      });
      await this.store.audit("background_succeeded", { taskId: task.id, externalKey });
      return settled;
    }
    return this.#terminal(task.id, outcome === "cancelled" || outcome === "killed" ? "cancelled" : "failed", reason);
  }

  async markActivity(sessionKey, kind, { progress = false } = {}) {
    if (!sessionKey) return [];
    const now = this.now();
    return this.store.update((state) => {
      const changed = [];
      for (const task of Object.values(state.tasks)) {
        if (task.sessionKey !== sessionKey || !ACTIVE.has(task.status)) continue;
        task.lastActivityAt = iso(now);
        task.updatedAt = iso(now);
        if (progress) task.lastProgressAt = iso(now);
        task.lastActivityKind = kind;
        changed.push(task.id);
      }
      return changed;
    });
  }

  async scanStale() {
    const now = this.now();
    const transitions = await this.store.update((state) => {
      const changed = [];
      for (const [id, task] of Object.entries(state.tasks)) {
        if (TERMINAL.has(task.status)) {
          const terminalAt = Date.parse(task.completedAt ?? task.updatedAt ?? task.createdAt);
          if (Number.isFinite(terminalAt) && now - terminalAt > RETENTION_MS) delete state.tasks[id];
          continue;
        }
        const baseline = Date.parse(task.lastProgressAt ?? task.lastActivityAt ?? task.createdAt);
        const recoveryBaseline = Date.parse(task.recoveryIssuedAt ?? "");
        const staleFrom = task.status === "recovery_required" && Number.isFinite(recoveryBaseline) ? recoveryBaseline : baseline;
        if (!Number.isFinite(staleFrom) || now - staleFrom < this.config.staleAfterMs) continue;

        const from = task.status;
        if (task.recoveryAttempts < task.maxRecoveryAttempts) {
          task.status = "recovery_required";
          task.recoveryAttempts += 1;
          task.recoveryIssuedAt = iso(now);
          task.updatedAt = iso(now);
          task.history.push({ at: iso(now), from, to: "recovery_required", reason: "stale" });
          changed.push({ task: publicTask(task), type: "recovery_required" });
        } else {
          task.status = "stalled";
          task.completedAt = iso(now);
          task.updatedAt = iso(now);
          task.history.push({ at: iso(now), from, to: "stalled", reason: "recovery budget exhausted" });
          changed.push({ task: publicTask(task), type: "recovery_exhausted" });
        }
      }
      return changed;
    });
    for (const transition of transitions) {
      await this.store.audit(transition.type, {
        taskId: transition.task.id,
        sessionKey: transition.task.sessionKey,
        recoveryAttempts: transition.task.recoveryAttempts,
      });
    }
    return transitions;
  }

  async getTask(taskId) {
    const state = await this.store.read();
    return publicTask(requireTask(state, taskId));
  }

  async listTasks({ sessionKey, activeOnly = false } = {}) {
    const state = await this.store.read();
    return Object.values(state.tasks)
      .filter((task) => (!sessionKey || task.sessionKey === sessionKey) && (!activeOnly || ACTIVE.has(task.status)))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .map(publicTask);
  }

  async findActiveForSession(sessionKey) {
    const tasks = await this.listTasks({ sessionKey, activeOnly: true });
    return tasks[0];
  }

  async #terminal(taskId, status, reason) {
    const now = this.now();
    const task = await this.store.update((state) => {
      const current = requireTask(state, taskId);
      requireActive(current);
      const from = current.status;
      current.status = status;
      current.terminalReason = reason.slice(0, 4000);
      current.completedAt = iso(now);
      current.updatedAt = iso(now);
      current.history.push({ at: iso(now), from, to: status, reason: current.terminalReason });
      return current;
    });
    await this.store.audit(`task_${status}`, { taskId, reason });
    return publicTask(task);
  }
}

export { ACTIVE, TERMINAL };
