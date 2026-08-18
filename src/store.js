import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const INITIAL_STATE = Object.freeze({ schemaVersion: 1, revision: 0, tasks: {}, updatedAt: null });
const SENSITIVE = /(secret|token|password|passwd|authorization|cookie|api[-_]?key|credential)/i;

function clone(value) {
  return structuredClone(value);
}

function safeMetadata(value, depth = 0) {
  if (depth > 5) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => safeMetadata(item, depth + 1));
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? value.slice(0, 1000) : value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 50)
      .map(([key, item]) => [key, SENSITIVE.test(key) ? "[REDACTED]" : safeMetadata(item, depth + 1)]),
  );
}

export class JsonTaskStore {
  constructor(directory, { now = () => Date.now() } = {}) {
    this.directory = directory;
    this.statePath = path.join(directory, "state.json");
    this.auditPath = path.join(directory, "audit.jsonl");
    this.now = now;
    this.state = clone(INITIAL_STATE);
    this.queue = Promise.resolve();
    this.initialized = false;
    this.initPromise = undefined;
  }

  async init() {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await fs.mkdir(this.directory, { recursive: true });
        try {
          const parsed = JSON.parse(await fs.readFile(this.statePath, "utf8"));
          if (parsed?.schemaVersion !== 1 || typeof parsed.tasks !== "object") {
            throw new Error("Unsupported or corrupt task state schema.");
          }
          this.state = parsed;
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
          await this.#persist(this.state);
        }
        this.initialized = true;
      })();
    }
    try {
      await this.initPromise;
    } finally {
      if (this.initialized) this.initPromise = undefined;
    }
  }

  async read() {
    if (!this.initialized) await this.init();
    await this.queue;
    return clone(this.state);
  }

  async update(mutator) {
    if (!this.initialized) await this.init();
    const operation = async () => {
      const draft = clone(this.state);
      const result = await mutator(draft);
      draft.revision = (this.state.revision ?? 0) + 1;
      draft.updatedAt = new Date(this.now()).toISOString();
      await this.#persist(draft);
      this.state = draft;
      return clone(result);
    };
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async audit(type, metadata = {}) {
    if (!this.initialized) await this.init();
    const entry = JSON.stringify({
      at: new Date(this.now()).toISOString(),
      type,
      metadata: safeMetadata(metadata),
    });
    await fs.appendFile(this.auditPath, `${entry}\n`, { encoding: "utf8", mode: 0o600 });
  }

  async close() {
    await this.queue;
  }

  async #persist(state) {
    const tempPath = `${this.statePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const handle = await fs.open(tempPath, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(tempPath, this.statePath);
    } catch (error) {
      await fs.rm(tempPath, { force: true });
      throw error;
    }
  }
}

export { safeMetadata };
