const fs = require("fs");
const path = require("path");
const CONFIG = require("../config");
const logger = require("../utils/logger");
const { writeFileAtomic } = require("../utils/atomicFile");

// One JSON file for everything the companion personas keep: characters, game states, saved facts, ideas, reminders.
// It is separate from memory.json on purpose: a chat reset must not erase progress, and a corrupt chat history
// must not take the characters with it. Single process, synchronous writes: a successful tool call is on disk.

const VERSION = 1;
const MAP_KEYS = ["characters", "retired", "ledger", "games", "facts", "ideas", "daily"];

// `ideas` and `daily` (the daily spark, one entry per person) were added after the first release; a file written
// without them still opens, because validate() fills missing keys from this object, so no version bump or migration.
function emptyData() {
  return { version: VERSION, characters: {}, retired: {}, ledger: {}, games: {}, facts: {}, ideas: {}, daily: {}, reminders: [] };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Structural check only. Per-record limits are enforced where records are created, so that a store written
// under older (or hand-edited) limits still opens instead of being thrown away.
function validate(data) {
  if (!isPlainObject(data) || data.version !== VERSION) {
    throw new Error("COMPANION_STORE_FORMAT");
  }

  const normalized = { ...emptyData(), ...data };

  if (!MAP_KEYS.every((key) => isPlainObject(normalized[key])) || !Array.isArray(normalized.reminders)) {
    throw new Error("COMPANION_STORE_FORMAT");
  }

  return normalized;
}

function quarantine(filename) {
  const target = `${filename}.corrupt-${Date.now()}`;

  try {
    fs.renameSync(filename, target);
    logger.error(`Companion store file is unreadable and was moved to ${target}`);
  } catch (error) {
    logger.error("Could not move the unreadable companion store aside:", error);
  }
}

class CompanionStore {
  constructor(filename, maxBytes = 5 * 1024 * 1024) {
    this.filename = filename;
    this.maxBytes = maxBytes;
    this.data = null;
  }

  tryRead(filename, label) {
    if (!fs.existsSync(filename)) {
      return null;
    }

    try {
      return validate(JSON.parse(fs.readFileSync(filename, "utf8")));
    } catch (error) {
      logger.error(`Companion store load error from ${label}:`, error);
      quarantine(filename);
      return null;
    }
  }

  open() {
    if (this.data) {
      return;
    }

    fs.mkdirSync(path.dirname(this.filename), { recursive: true });

    const primary = this.tryRead(this.filename, "primary file");

    if (primary) {
      this.data = primary;
      return;
    }

    const backup = this.tryRead(`${this.filename}.bak`, "backup file");

    if (backup) {
      logger.warn("Companion store restored from the backup file.");
      this.data = backup;
      return;
    }

    this.data = emptyData();
  }

  // Runs `read` on the live data and returns a copy of whatever it returns, so callers cannot edit the store by accident.
  view(read) {
    this.open();
    return structuredClone(read(this.data));
  }

  // Runs `mutate` on a copy. A result with `ok: false` (or a throw) discards the copy: refused requests leave no trace.
  // Otherwise the copy is written to disk first and becomes the live data only after the write succeeded.
  change(mutate) {
    this.open();

    const next = structuredClone(this.data);
    const result = mutate(next);

    if (result && result.ok === false) {
      return result;
    }

    this.publish(next);
    this.data = next;
    return result;
  }

  publish(data) {
    const json = JSON.stringify(validate(data));

    if (Buffer.byteLength(json) > this.maxBytes) {
      throw new Error("COMPANION_STORE_SIZE");
    }

    writeFileAtomic(this.filename, json, {
      canBackup: (filename) => {
        try {
          validate(JSON.parse(fs.readFileSync(filename, "utf8")));
          return true;
        } catch {
          return false;
        }
      }
    });
  }

  close() {
    this.data = null;
  }
}

let shared = null;

function getStore() {
  shared ||= new CompanionStore(CONFIG.COMPANION_FILE, CONFIG.COMPANION_MAX_BYTES);
  return shared;
}

module.exports = {
  CompanionStore,
  getStore,
  emptyData,
  validate
};
