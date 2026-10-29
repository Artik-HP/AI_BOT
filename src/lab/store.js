const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const COLLECTIONS = ["projects", "experiments", "tracks", "artifacts", "operations", "callbacks"];
const STATES = new Set(["planned", "running", "completed", "partial", "error", "cancelled", "unknown"]);
const id = () => crypto.randomBytes(12).toString("hex");
const retrySleep = new Int32Array(new SharedArrayBuffer(4));

// Windows readers / scanners can briefly hold a file without share-delete access.
// Retry only filesystem publication, never the mutation callback or a paid AI request.
function retryIO(action) {
  for (let attempt = 0; ; attempt++) {
    try { return action(); }
    catch (error) {
      if (attempt >= 5 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
      Atomics.wait(retrySleep, 0, 0, 5 * (attempt + 1));
    }
  }
}

function validate(data) {
  if (!data || data.version !== 1 || !data.scopes || typeof data.scopes !== "object" || Array.isArray(data.scopes) ||
      Object.keys(data.scopes).length > 1000) {
    throw new Error("LAB_STORE_FORMAT");
  }
  for (const [key, scope] of Object.entries(data.scopes)) {
    if (!/^\d+:\d+$/.test(key) || !scope || !COLLECTIONS.every((name) => Array.isArray(scope[name]))) {
      throw new Error("LAB_STORE_FORMAT");
    }
    for (const name of COLLECTIONS) {
      const max = name === "callbacks" ? 300 : name === "operations" ? 500 : 30;
      if (scope[name].length > max || scope[name].some((item) => !item || !/^[a-f0-9]{24}$/.test(item.id))) {
        throw new Error("LAB_STORE_LIMIT");
      }
    }
    if (scope.operations.some((op) => !STATES.has(op.status)) ||
        scope.experiments.some((exp) => !STATES.has(exp.status) || !Array.isArray(exp.runs) || exp.runs.length !== 2) ||
        scope.tracks.some((track) => !Array.isArray(track.attempts) || track.attempts.length > 100)) {
      throw new Error("LAB_STORE_FORMAT");
    }
  }
  return data;
}

function scopeKey(ctx) {
  const key = `${ctx.chatId}:${ctx.userId}`;
  if (!/^\d+:\d+$/.test(key) || String(ctx.chatId) !== String(ctx.userId)) {
    throw new Error("LAB_PRIVATE_ONLY");
  }
  return key;
}

class LabStore {
  constructor(filename, maxBytes = 10 * 1024 * 1024) {
    this.filename = filename;
    this.maxBytes = maxBytes;
    this.token = id();
    this.data = null;
    this.locked = false;
  }

  acquire() {
    if (this.locked) return;
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    const lock = `${this.filename}.lock`;
    const create = () => {
      const fd = fs.openSync(lock, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token: this.token })); }
      finally { fs.closeSync(fd); }
      this.locked = true;
    };
    try { create(); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      // Serialise stale-owner recovery. Never remove a live or unverifiable owner's claim.
      const guard = `${lock}.recovery`;
      let fd;
      try {
        fd = fs.openSync(guard, "wx", 0o600);
        const owner = JSON.parse(fs.readFileSync(lock, "utf8"));
        if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error("LAB_STORE_LOCKED", { cause: error });
        try { process.kill(owner.pid, 0); throw new Error("LAB_STORE_LOCKED", { cause: error }); }
        catch (probe) { if (probe.code !== "ESRCH") throw probe; }
        fs.unlinkSync(lock);
        create();
      } catch (error) {
        throw new Error("LAB_STORE_LOCKED", { cause: error });
      } finally {
        if (fd !== undefined) { fs.closeSync(fd); fs.unlinkSync(guard); }
      }
    }
  }

  readFile(filename) {
    if (fs.statSync(filename).size > this.maxBytes) throw new Error("LAB_STORE_SIZE");
    return validate(JSON.parse(fs.readFileSync(filename, "utf8")));
  }

  open() {
    if (this.data) return;
    this.acquire();
    try {
      this.data = this.readFile(this.filename);
    } catch (error) {
      if (error.code === "ENOENT" && !fs.existsSync(`${this.filename}.bak`)) {
        this.data = { version: 1, scopes: {} };
      } else {
        // Keep the original intact if there is no verified recovery source.
        const recovered = this.readFile(`${this.filename}.bak`);
        if (fs.existsSync(this.filename)) fs.copyFileSync(this.filename, `${this.filename}.corrupt-${id()}`);
        this.publish(recovered, false);
        this.data = recovered;
      }
    }
    // An interrupted network request must never be replayed automatically.
    const recovered = structuredClone(this.data);
    let changed = false;
    for (const scope of Object.values(recovered.scopes)) {
      for (const op of scope.operations) {
        if (op.status === "running") { op.status = "unknown"; changed = true; }
      }
      for (const exp of scope.experiments) {
        for (const run of exp.runs) {
          if (run.status === "running") { run.status = "unknown"; changed = true; }
        }
        if (exp.status === "running") {
          exp.status = exp.runs.some((run) => run.status === "completed") ? "partial" : "unknown";
          changed = true;
        }
      }
    }
    if (changed) { this.publish(recovered); this.data = recovered; }
  }

  publish(data, backup = true) {
    validate(data);
    const json = JSON.stringify(data);
    if (Buffer.byteLength(json) > this.maxBytes) throw new Error("LAB_STORE_SIZE");
    const temp = `${this.filename}.${this.token}.tmp`;
    try {
      const fd = fs.openSync(temp, "w", 0o600);
      try { fs.writeFileSync(fd, json); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (backup && fs.existsSync(this.filename)) {
        this.readFile(this.filename);
        retryIO(() => fs.copyFileSync(this.filename, `${this.filename}.bak.tmp`));
        retryIO(() => fs.renameSync(`${this.filename}.bak.tmp`, `${this.filename}.bak`));
      }
      retryIO(() => fs.renameSync(temp, this.filename));
    } finally {
      retryIO(() => fs.rmSync(temp, { force: true }));
    }
  }

  read(ctx) {
    this.open();
    return structuredClone(this.data.scopes[scopeKey(ctx)] || this.empty());
  }

  empty() {
    return Object.fromEntries(COLLECTIONS.map((name) => [name, []]));
  }

  change(ctx, mutate) {
    this.open();
    const next = structuredClone(this.data);
    const key = scopeKey(ctx);
    const scope = next.scopes[key] ||= this.empty();
    const now = Date.now();
    scope.callbacks = scope.callbacks.filter((cb) => cb.expires > now).slice(-250);
    scope.operations = scope.operations.filter((op) => now - op.at < 7 * 86400000).slice(-499);
    const result = mutate(scope);
    this.publish(next);
    this.data = next;
    return structuredClone(result);
  }

  close() {
    if (this.locked) {
      const lock = `${this.filename}.lock`;
      if (JSON.parse(fs.readFileSync(lock, "utf8")).token === this.token) fs.unlinkSync(lock);
      this.locked = false;
    }
    this.data = null;
  }

  scrubBackup() {
    this.open();
    this.publish(this.data);
  }
}

module.exports = { LabStore, scopeKey, id, validate };
