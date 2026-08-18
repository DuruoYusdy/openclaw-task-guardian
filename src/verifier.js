import fs from "node:fs/promises";
import path from "node:path";

const MAX_TEXT_VERIFY_BYTES = 10 * 1024 * 1024;

function comparable(value) {
  const normalized = path.resolve(value).replaceAll("\\", "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function within(candidate, root) {
  const value = comparable(candidate);
  const base = comparable(root);
  return value === base || value.startsWith(`${base}/`);
}

async function realOrResolved(value) {
  try {
    return await fs.realpath(value);
  } catch {
    return path.resolve(value);
  }
}

export async function resolveVerifiedPath(requestedPath, workspaceRoot, extraRoots = []) {
  if (typeof requestedPath !== "string" || !requestedPath.trim()) throw new Error("Verifier path is required.");
  if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) {
    throw new Error("Workspace root is unavailable; file verification fails closed.");
  }

  const candidate = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(workspaceRoot, requestedPath);
  const realCandidate = await realOrResolved(candidate);
  const roots = await Promise.all([workspaceRoot, ...extraRoots].map(realOrResolved));
  if (!roots.some((root) => within(realCandidate, root))) {
    throw new Error(`Verifier path escapes allowed roots: ${requestedPath}`);
  }
  return realCandidate;
}

function jsonPointer(document, pointer) {
  if (pointer === "") return document;
  if (typeof pointer !== "string" || !pointer.startsWith("/")) {
    throw new Error("json_equals requires an RFC 6901 pointer beginning with '/'.");
  }
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((current, segment) => current?.[segment], document);
}

async function runOne(check, options) {
  const filePath = await resolveVerifiedPath(check.path, options.workspaceRoot, options.allowedRoots);
  try {
    if (check.kind === "file_exists") {
      await fs.access(filePath);
      return { passed: true, kind: check.kind, path: check.path };
    }
    if (check.kind === "min_file_bytes") {
      const stat = await fs.stat(filePath);
      const expected = Number(check.value);
      return { passed: stat.isFile() && Number.isFinite(expected) && expected >= 0 && stat.size >= expected, kind: check.kind, path: check.path, actual: stat.size, expected };
    }
    if (check.kind === "file_contains") {
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_TEXT_VERIFY_BYTES) throw new Error("Text verifier file exceeds 10 MiB limit.");
      const text = await fs.readFile(filePath, "utf8");
      const expected = String(check.value ?? "");
      return { passed: expected.length > 0 && text.includes(expected), kind: check.kind, path: check.path, expected };
    }
    if (check.kind === "json_equals") {
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_TEXT_VERIFY_BYTES) throw new Error("JSON verifier file exceeds 10 MiB limit.");
      const document = JSON.parse(await fs.readFile(filePath, "utf8"));
      const actual = jsonPointer(document, check.pointer ?? "");
      return {
        passed: JSON.stringify(actual) === JSON.stringify(check.value),
        kind: check.kind,
        path: check.path,
        pointer: check.pointer ?? "",
        actual,
        expected: check.value,
      };
    }
    return { passed: false, kind: String(check.kind), path: check.path, error: "Unsupported verifier kind." };
  } catch (error) {
    return { passed: false, kind: String(check.kind), path: check.path, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function runChecks(checks, options) {
  if (!Array.isArray(checks) || checks.length === 0) return [];
  const results = [];
  for (const check of checks.slice(0, 32)) results.push(await runOne(check, options));
  return results;
}
