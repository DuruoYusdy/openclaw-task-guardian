import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (name) => JSON.parse(await fs.readFile(path.join(root, name), "utf8"));
const manifest = await readJson("openclaw.plugin.json");
const pkg = await readJson("package.json");

assert.equal(manifest.id, "task-guardian");
assert.equal(manifest.configSchema?.additionalProperties, false);
assert.deepEqual(manifest.contracts?.tools, ["task_guardian"]);
assert.ok(manifest.skills?.includes("./skills"));
assert.equal(pkg.openclaw?.extensions?.[0], "./src/index.js");
assert.equal(pkg.openclaw?.runtimeExtensions?.length, pkg.openclaw?.extensions?.length);

const sourceDir = path.join(root, "src");
const sourceFiles = (await fs.readdir(sourceDir)).filter((name) => name.endsWith(".js"));
for (const file of sourceFiles) {
  const fullPath = path.join(sourceDir, file);
  const check = spawnSync(process.execPath, ["--check", fullPath], { encoding: "utf8" });
  assert.equal(check.status, 0, `${file} failed syntax check:\n${check.stderr}`);
}

const skill = await fs.readFile(path.join(root, "skills", "operate-long-task", "SKILL.md"), "utf8");
assert.ok(!skill.includes("TODO"), "Skill still contains TODO markers.");
assert.match(skill, /^---\r?\nname: operate-long-task\r?\n/m);

console.log(`Project checks passed (${sourceFiles.length} source files).`);
