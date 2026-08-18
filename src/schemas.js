const CHECK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "path"],
  properties: {
    kind: { type: "string", enum: ["file_exists", "min_file_bytes", "file_contains", "json_equals"] },
    path: { type: "string", minLength: 1 },
    value: {},
    pointer: { type: "string" },
  },
};

export const TASK_GUARDIAN_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: ["register", "progress", "checkpoint", "complete", "fail", "status", "list"],
    },
    taskId: { type: "string", minLength: 1 },
    goal: { type: "string", minLength: 1, maxLength: 4000 },
    successCriteria: {
      type: "array",
      minItems: 1,
      maxItems: 30,
      items: { type: "string", minLength: 1, maxLength: 2000 },
    },
    checks: { type: "array", maxItems: 32, items: CHECK_SCHEMA },
    idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
    deadlineAt: { type: "string" },
    maxRecoveryAttempts: { type: "integer", minimum: 0, maximum: 10 },
    summary: { type: "string", minLength: 1, maxLength: 8000 },
    evidence: {
      type: "array",
      maxItems: 50,
      items: { type: "string", minLength: 1, maxLength: 2000 },
    },
    criteriaSatisfied: {
      type: "array",
      maxItems: 30,
      items: { type: "string", minLength: 1, maxLength: 2000 },
    },
    reason: { type: "string", minLength: 1, maxLength: 4000 },
    activeOnly: { type: "boolean" },
  },
};
