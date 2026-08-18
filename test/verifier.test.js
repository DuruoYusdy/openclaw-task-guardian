import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runChecks, resolveVerifiedPath } from "../src/verifier.js";

test("verifiers inspect files and structured JSON deterministically", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "guardian-verify-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "report.md"), "# Summary\nready\n", "utf8");
  await fs.writeFile(path.join(root, "result.json"), JSON.stringify({ output: { status: "ready" } }), "utf8");

  const results = await runChecks(
    [
      { kind: "file_exists", path: "report.md" },
      { kind: "min_file_bytes", path: "report.md", value: 5 },
      { kind: "file_contains", path: "report.md", value: "# Summary" },
      { kind: "json_equals", path: "result.json", pointer: "/output/status", value: "ready" },
    ],
    { workspaceRoot: root, allowedRoots: [] },
  );
  assert.equal(results.every((item) => item.passed), true);
});

test("verification paths cannot escape the workspace", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "guardian-root-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "guardian-outside-"));
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })]));
  await fs.writeFile(path.join(outside, "secret.txt"), "nope", "utf8");
  await assert.rejects(
    resolveVerifiedPath(path.join(outside, "secret.txt"), root, []),
    /escapes allowed roots/,
  );
});
