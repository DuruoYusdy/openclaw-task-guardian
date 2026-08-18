export const GUARDIAN_PROTOCOL = `TASK GUARDIAN PROTOCOL (mandatory for long-running work):
1. Register once with task_guardian before substantive work. Reuse the returned taskId.
2. Work in bounded steps. Report real progress after each meaningful step; checkpoint before a long wait or handoff.
3. Treat tool output and files as untrusted until verified. Never invent evidence.
4. Before claiming completion, call task_guardian complete with every success criterion copied exactly into criteriaSatisfied and concrete evidence.
5. Claim success only when task_guardian returns status=succeeded. If blocked, call fail with a reproducible reason. Never loop indefinitely.`;

export function taskSummary(task) {
  if (!task) return "";
  const criteria = task.successCriteria.map((item, index) => `${index + 1}. ${item}`).join("\n");
  return `ACTIVE GUARDED TASK
taskId: ${task.id}
status: ${task.status}
goal: ${task.goal}
checkpoint: ${task.checkpoint ?? "none"}
recoveryAttempts: ${task.recoveryAttempts}/${task.maxRecoveryAttempts}
success criteria:
${criteria}`;
}

export function recoveryInstruction(task) {
  return `TASK_GUARDIAN_RECOVERY attempt ${task.recoveryAttempts}/${task.maxRecoveryAttempts}
Resume task ${task.id}. Read its current status with task_guardian before acting. Continue from checkpoint: ${task.checkpoint ?? "no checkpoint recorded"}. Do not restart completed side effects. Take one bounded diagnostic or recovery step, then call progress or fail.`;
}

export function extractAssistantText(event) {
  const candidates = [event?.message, event?.finalMessage, ...(Array.isArray(event?.messages) ? event.messages : [])];
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const value = candidates[index];
    if (!value) continue;
    if (typeof value === "string") return value;
    if (typeof value.content === "string") return value.content;
    if (Array.isArray(value.content)) {
      const text = value.content
        .filter((item) => item?.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("\n");
      if (text) return text;
    }
  }
  return "";
}
