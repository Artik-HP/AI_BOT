const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto");

class CommandStore {
  constructor(
    file = process.env.COMMAND_DB_FILE ||
      (process.env.MEMORY_FILE
        ? path.join(
            path.dirname(path.resolve(process.env.MEMORY_FILE)),
            "commands.sqlite",
          )
        : path.join(__dirname, "../../data/commands.sqlite")),
  ) {
    if (file !== ":memory:")
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS state (scope TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (scope TEXT, id TEXT, status TEXT, result TEXT, created INTEGER, PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY, scope TEXT, message TEXT, value TEXT, expires INTEGER, used INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS reminders (id TEXT PRIMARY KEY, scope TEXT, transport TEXT, destination TEXT, text TEXT,
        due INTEGER, status TEXT DEFAULT 'pending', lease INTEGER DEFAULT 0, attempts INTEGER DEFAULT 0);
      CREATE INDEX IF NOT EXISTS reminders_due ON reminders(status,due);
      CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, scope TEXT, text TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT,event TEXT,command TEXT,ok INTEGER,duration INTEGER,code TEXT,created INTEGER);
      CREATE INDEX IF NOT EXISTS events_scope ON events(scope,created);`);
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  get(scope, fallback = {}) {
    const row = this.db
      .prepare("SELECT value FROM state WHERE scope=?")
      .get(scope);
    return row ? JSON.parse(row.value) : structuredClone(fallback);
  }
  set(scope, value) {
    this.db
      .prepare(
        "INSERT INTO state VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET value=excluded.value",
      )
      .run(scope, JSON.stringify(value));
    return value;
  }
  update(scope, fn, fallback = {}) {
    return this.transaction(() =>
      this.set(scope, fn(this.get(scope, fallback))),
    );
  }
  claim(scope, id) {
    return this.transaction(() => {
      const previous = this.db
        .prepare("SELECT * FROM requests WHERE scope=? AND id=?")
        .get(scope, id);
      if (previous)
        return {
          status: previous.status,
          result: previous.result && JSON.parse(previous.result),
        };
      this.db
        .prepare("INSERT INTO requests VALUES (?,?,?,NULL,?)")
        .run(scope, id, "processing", Date.now());
      return null;
    });
  }
  finish(scope, id, result) {
    this.db
      .prepare("UPDATE requests SET status=?,result=? WHERE scope=? AND id=?")
      .run("completed", JSON.stringify(result), scope, id);
  }
  action(scope, message, value) {
    const id = crypto.randomBytes(12).toString("hex");
    this.db
      .prepare(
        "INSERT INTO actions(id,scope,message,value,expires) VALUES(?,?,?,?,?)",
      )
      .run(
        id,
        scope,
        String(message),
        JSON.stringify(value),
        Date.now() + 86400000,
      );
    return id;
  }
  takeAction(scope, message, id) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM actions WHERE id=?").get(id);
      if (
        !row ||
        row.scope !== scope ||
        row.message !== String(message) ||
        row.used ||
        row.expires < Date.now()
      )
        throw new Error(
          "Кнопка устарела или принадлежит другому пользователю. Открой меню заново.",
        );
      this.db.prepare("UPDATE actions SET used=1 WHERE id=?").run(id);
      return JSON.parse(row.value);
    });
  }
  addReminder(context, text, due) {
    const id = crypto.randomBytes(4).toString("hex");
    this.db
      .prepare(
        "INSERT INTO reminders(id,scope,transport,destination,text,due) VALUES(?,?,?,?,?,?)",
      )
      .run(
        id,
        context.scope,
        context.transport,
        String(context.chatId || ""),
        text,
        due,
      );
    return id;
  }
  reminders(scope) {
    return this.db
      .prepare(
        "SELECT id,text,due,status,attempts FROM reminders WHERE scope=? AND status IN ('pending','sending','failed') ORDER BY due",
      )
      .all(scope);
  }
  cancelReminder(scope, id) {
    return this.db
      .prepare(
        "UPDATE reminders SET status='cancelled' WHERE scope=? AND id=? AND status IN ('pending','failed')",
      )
      .run(scope, id).changes;
  }
  due(now, telegram = true) {
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          "SELECT * FROM reminders WHERE ((status='pending' AND due<=?) OR (status='sending' AND lease<?)) AND (?=1 OR transport='web') ORDER BY due LIMIT 20",
        )
        .all(now, now, telegram ? 1 : 0);
      for (const row of rows)
        this.db
          .prepare(
            "UPDATE reminders SET status='sending',lease=?,attempts=attempts+1 WHERE id=?",
          )
          .run(now + 90000, row.id);
      return rows;
    });
  }
  delivered(row) {
    this.transaction(() => {
      this.db
        .prepare("INSERT OR IGNORE INTO inbox VALUES(?,?,?,?)")
        .run(row.id, row.scope, row.text, Date.now());
      this.db
        .prepare("UPDATE reminders SET status='delivered' WHERE id=?")
        .run(row.id);
    });
  }
  retry(row) {
    this.db
      .prepare("UPDATE reminders SET status=?,due=? WHERE id=?")
      .run(
        row.attempts >= 4 ? "failed" : "pending",
        Date.now() + 60000 * (row.attempts + 1),
        row.id,
      );
  }
  inbox(scope) {
    return this.db
      .prepare(
        "SELECT id,text,created FROM inbox WHERE scope=? ORDER BY created DESC LIMIT 50",
      )
      .all(scope);
  }
  prune() {
    this.db
      .prepare("DELETE FROM events WHERE created<?")
      .run(Date.now() - 30 * 86400000);
    this.db.prepare("DELETE FROM actions WHERE expires<?").run(Date.now());
    this.db
      .prepare("DELETE FROM requests WHERE created<? AND status='completed'")
      .run(Date.now() - 7 * 86400000);
  }
  close() {
    this.db.close();
  }
}
let instance;
function getStore() {
  return (instance ||= new CommandStore());
}
module.exports = { CommandStore, getStore };
