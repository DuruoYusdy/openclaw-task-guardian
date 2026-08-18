import path from "node:path";

const SECRET_KEY = /(secret|token|password|passwd|authorization|cookie|api[-_]?key|credential)/i;

const BLOCK_PATTERNS = [
  /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+(?:\/|~|\$home)(?:\s|$)/i,
  /\bmkfs(?:\.|\s)/i,
  /\bformat\s+[a-z]:/i,
  /\bdd\s+if=.*\s+of=\/(?:dev|boot)/i,
  /\bshutdown\b|\breboot\b|\bhalt\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f[a-z]*d[a-z]*x/i,
  /\bdrop\s+database\b/i,
];

const APPROVAL_PATTERNS = [
  /\brm\s+-[a-z]*r/i,
  /\bremove-item\b[^\n]*(?:-recurse|-force)/i,
  /\bgit\s+push\b[^\n]*(?:--force|-f\b)/i,
  /\bdrop\s+table\b|\btruncate\s+table\b|\bdelete\s+from\b/i,
  /\b(?:deploy|publish|release)\b[^\n]*\bprod(?:uction)?\b/i,
  /\bkubectl\s+(?:delete|apply|replace|patch)\b/i,
  /\bterraform\s+(?:apply|destroy)\b/i,
];

function boundedStringify(value, limit = 32_000) {
  const seen = new WeakSet();
  const text = JSON.stringify(value, (key, item) => {
    if (SECRET_KEY.test(key)) return "[REDACTED]";
    if (item && typeof item === "object") {
      if (seen.has(item)) return "[CIRCULAR]";
      seen.add(item);
    }
    return item;
  });
  return (text ?? "").slice(0, limit);
}

function normalizePath(value) {
  const normalized = path.normalize(String(value)).replaceAll("\\", "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isWithin(candidate, root) {
  const value = normalizePath(candidate);
  const base = normalizePath(root);
  return value === base || value.startsWith(`${base}/`);
}

function protectedPath(event, config) {
  const paths = Array.isArray(event.derivedPaths) ? event.derivedPaths : [];
  for (const candidate of paths) {
    const value = typeof candidate === "string" ? candidate : candidate?.path;
    if (typeof value !== "string") continue;
    const match = config.protectedPaths.find((root) => isWithin(value, root));
    if (match) return { candidate: value, root: match };
  }
  return undefined;
}

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? "[REDACTED]" : redact(item)]),
  );
}

export function classifyToolCall(event, ctx, config) {
  if (event.toolName === "task_guardian") return { kind: "allow", reason: "guardian control tool" };

  if (config.deniedTools.includes(event.toolName)) {
    return { kind: "block", severity: "critical", reason: `Tool ${event.toolName} is denied by policy.` };
  }

  const serialized = boundedStringify(event.params);
  const catastrophic = BLOCK_PATTERNS.find((pattern) => pattern.test(serialized));
  if (catastrophic) {
    return { kind: "block", severity: "critical", reason: "Catastrophic command pattern is denied." };
  }

  const pathMatch = protectedPath(event, config);
  const riskyPattern = APPROVAL_PATTERNS.find((pattern) => pattern.test(serialized));
  const configuredApproval = config.approvalTools.includes(event.toolName);

  if (!pathMatch && !riskyPattern && !configuredApproval) {
    return { kind: "allow", reason: "No policy rule matched." };
  }

  const reason = pathMatch
    ? `Action targets protected path ${pathMatch.root}.`
    : configuredApproval
      ? `Tool ${event.toolName} requires approval by policy.`
      : "Risky side effect requires approval.";

  if (config.requireOwnerForRisky && ctx?.requester?.senderIsOwner !== true) {
    return {
      kind: "block",
      severity: "critical",
      reason: `Trusted owner identity is required. ${reason}`,
    };
  }

  return { kind: "approval", severity: pathMatch ? "critical" : "warning", reason };
}

export function toHookResult(decision, config, event) {
  if (config.mode === "monitor" || decision.kind === "allow") return undefined;
  if (decision.kind === "block") {
    return { block: true, blockReason: decision.reason };
  }
  return {
    requireApproval: {
      title: `Approve ${String(event.toolName).slice(0, 60)}`,
      description: decision.reason.slice(0, 512),
      severity: decision.severity,
      timeoutMs: 120_000,
      allowedDecisions: ["allow-once", "deny"],
    },
  };
}
