import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JsonTaskStore } from "../src/store.js";

test("store serializes concurrent writes and survives reload", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "guardian-store-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new JsonTaskStore(directory);
  await store.init();

  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      store.update((state) => {
        state.tasks[`task-${index}`] = { id: `task-${index}` };
      }),
    ),
  );
  const first = await store.read();
  assert.equal(Object.keys(first.tasks).length, 20);
  assert.equal(first.revision, 20);

  const reloaded = new JsonTaskStore(directory);
  await reloaded.init();
  assert.deepEqual(await reloaded.read(), first);
});

test("audit log redacts secret-shaped fields", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "guardian-audit-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new JsonTaskStore(directory);
  await store.audit("test", { token: "secret-value", nested: { password: "hidden", safe: "ok" } });
  const line = await fs.readFile(path.join(directory, "audit.jsonl"), "utf8");
  assert.doesNotMatch(line, /secret-value|hidden/);
  assert.match(line, /\[REDACTED\]/);
  assert.match(line, /"safe":"ok"/);
});
