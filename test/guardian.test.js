import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeConfig } from "../src/config.js";
import { TaskGuardian } from "../src/guardian.js";
import { JsonTaskStore } from "../src/store.js";

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "guardian-task-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let clock = Date.parse("2026-08-19T00:00:00.000Z");
  const now = () => clock;
  const config = normalizeConfig({ staleAfterMs: 30_000, maxRecoveryAttempts: 2, ...overrides });
  const store = new JsonTaskStore(path.join(root, ".state"), { now });
  const guardian = new TaskGuardian(store, config, { now });
  await store.init();
  return { root, store, guardian, advance(ms) { clock += ms; } };
}

test("registration is idempotent for the same session and key", async (t) => {
  const { root, guardian } = await fixture(t);
  const params = {
    goal: "Build report",
    successCriteria: ["report exists"],
    idempotencyKey: "report-v1",
  };
  const first = await guardian.registerTask(params, { sessionKey: "s1", workspaceRoot: root });
  const second = await guardian.registerTask(params, { sessionKey: "s1", workspaceRoot: root });
  assert.equal(first.id, second.id);
  assert.equal((await guardian.listTasks()).length, 1);
});

test("completion requires exact criteria, evidence, and passing checks", async (t) => {
  const { root, guardian } = await fixture(t);
  const task = await guardian.registerTask(
    {
      goal: "Build report",
      successCriteria: ["report exists", "report has summary"],
      checks: [
        { kind: "file_exists", path: "report.md" },
        { kind: "file_contains", path: "report.md", value: "# Summary" },
      ],
    },
    { sessionKey: "s1", workspaceRoot: root },
  );

  await assert.rejects(
    guardian.complete(task.id, { criteriaSatisfied: task.successCriteria, evidence: ["report.md"] }),
    /Completion checks failed/,
  );
  await fs.writeFile(path.join(root, "report.md"), "# Summary\nDone\n", "utf8");
  await assert.rejects(
    guardian.complete(task.id, { criteriaSatisfied: ["report exists"], evidence: ["report.md"] }),
    /Unsatisfied success criteria/,
  );

  const completed = await guardian.complete(task.id, {
    criteriaSatisfied: task.successCriteria,
    evidence: ["report.md contains # Summary"],
  });
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.checkResults.every((item) => item.passed), true);
});

test("stale tasks use a bounded recovery budget", async (t) => {
  const { root, guardian, advance } = await fixture(t, { maxRecoveryAttempts: 2 });
  const task = await guardian.registerTask(
    { goal: "Wait safely", successCriteria: ["backing task ends"] },
    { sessionKey: "s1", workspaceRoot: root },
  );

  advance(31_000);
  let transitions = await guardian.scanStale();
  assert.equal(transitions[0].type, "recovery_required");
  assert.equal(transitions[0].task.recoveryAttempts, 1);

  advance(31_000);
  transitions = await guardian.scanStale();
  assert.equal(transitions[0].type, "recovery_required");
  assert.equal(transitions[0].task.recoveryAttempts, 2);

  advance(31_000);
  transitions = await guardian.scanStale();
  assert.equal(transitions[0].type, "recovery_exhausted");
  assert.equal((await guardian.getTask(task.id)).status, "stalled");
});
