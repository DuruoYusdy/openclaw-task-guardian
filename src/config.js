const DEFAULTS = Object.freeze({
  mode: "enforce",
  storagePath: "~/.openclaw/task-guardian",
  scanIntervalMs: 15_000,
  staleAfterMs: 300_000,
  maxRecoveryAttempts: 3,
  maxFinalizeRetries: 1,
  injectProtocol: true,
  autoMonitorBackground: true,
  allowedAgentIds: [],
  deniedTools: [],
  approvalTools: [],
  protectedPaths: [],
  allowedVerificationRoots: [],
  requireOwnerForRisky: true,
});

function integer(value, fallback, min, max) {
  return Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function strings(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
}

export function normalizeConfig(raw = {}) {
  return Object.freeze({
    mode: raw.mode === "monitor" ? "monitor" : DEFAULTS.mode,
    storagePath:
      typeof raw.storagePath === "string" && raw.storagePath.trim()
        ? raw.storagePath.trim()
        : DEFAULTS.storagePath,
    scanIntervalMs: integer(raw.scanIntervalMs, DEFAULTS.scanIntervalMs, 5_000, 300_000),
    staleAfterMs: integer(raw.staleAfterMs, DEFAULTS.staleAfterMs, 30_000, 86_400_000),
    maxRecoveryAttempts: integer(raw.maxRecoveryAttempts, DEFAULTS.maxRecoveryAttempts, 0, 10),
    maxFinalizeRetries: integer(raw.maxFinalizeRetries, DEFAULTS.maxFinalizeRetries, 0, 3),
    injectProtocol: raw.injectProtocol !== false,
    autoMonitorBackground: raw.autoMonitorBackground !== false,
    allowedAgentIds: strings(raw.allowedAgentIds),
    deniedTools: strings(raw.deniedTools),
    approvalTools: strings(raw.approvalTools),
    protectedPaths: strings(raw.protectedPaths),
    allowedVerificationRoots: strings(raw.allowedVerificationRoots),
    requireOwnerForRisky: raw.requireOwnerForRisky !== false,
  });
}

export function handlesAgent(config, agentId) {
  return config.allowedAgentIds.length === 0 || (typeof agentId === "string" && config.allowedAgentIds.includes(agentId));
}

export { DEFAULTS };
