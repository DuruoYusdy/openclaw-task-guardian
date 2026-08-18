import test from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig, handlesAgent } from "../src/config.js";
import { classifyToolCall, redact, toHookResult } from "../src/policy.js";

test("configuration is bounded and agent-scoped", () => {
  const config = normalizeConfig({
    scanIntervalMs: 1,
    staleAfterMs: 999_999_999,
    allowedAgentIds: ["worker", "worker", ""],
  });
  assert.equal(config.scanIntervalMs, 5_000);
  assert.equal(config.staleAfterMs, 86_400_000);
  assert.deepEqual(config.allowedAgentIds, ["worker"]);
  assert.equal(handlesAgent(config, "worker"), true);
  assert.equal(handlesAgent(config, "other"), false);
});

test("catastrophic commands are blocked without model judgment", () => {
  const config = normalizeConfig({ mode: "enforce" });
  const event = { toolName: "exec", params: { command: "git reset --hard HEAD~1" } };
  const decision = classifyToolCall(event, { requester: { senderIsOwner: true } }, config);
  assert.equal(decision.kind, "block");
  assert.deepEqual(toHookResult(decision, config, event), {
    block: true,
    blockReason: "Catastrophic command pattern is denied.",
  });
});

test("risky commands require a trusted owner and one-shot approval", () => {
  const config = normalizeConfig({ mode: "enforce", requireOwnerForRisky: true });
  const event = { toolName: "exec", params: { command: "git push --force origin main" } };
  assert.equal(classifyToolCall(event, {}, config).kind, "block");

  const approved = classifyToolCall(event, { requester: { senderIsOwner: true } }, config);
  assert.equal(approved.kind, "approval");
  assert.deepEqual(toHookResult(approved, config, event).requireApproval.allowedDecisions, ["allow-once", "deny"]);
});

test("monitor mode records decisions but does not enforce them", () => {
  const config = normalizeConfig({ mode: "monitor", deniedTools: ["exec"] });
  const event = { toolName: "exec", params: {} };
  const decision = classifyToolCall(event, {}, config);
  assert.equal(decision.kind, "block");
  assert.equal(toHookResult(decision, config, event), undefined);
});

test("audit redaction removes nested secrets", () => {
  assert.deepEqual(redact({ token: "abc", nested: { apiKey: "def", safe: 1 } }), {
    token: "[REDACTED]",
    nested: { apiKey: "[REDACTED]", safe: 1 },
  });
});
