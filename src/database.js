const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");
const CONFIG = require("./config");
const logger = require("./utils/logger");

// "active", "blocked" or "expired" for an account row; null when there is no row at all. Blocking is an explicit
// record, so a person without a row is not blocked.
function accountState(account, now = Date.now()) {
  if (!account) return null;
  if (account.status !== "active") return "blocked";
  return account.until && new Date(account.until).getTime() <= now ? "expired" : "active";
}

class Database {
  constructor(pool) { this.pool = pool; }
  async migrate() {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(107146, 1)");
      await client.query("CREATE SCHEMA IF NOT EXISTS ai_bot");
      await client.query("CREATE TABLE IF NOT EXISTS ai_bot.migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
      const applied = await client.query("SELECT version FROM ai_bot.migrations WHERE version = 1");
      if (!applied.rows.length) {
        await client.query(fs.readFileSync(path.join(__dirname, "..", "migrations", "001_commercial_accounts.sql"), "utf8"));
        await client.query("INSERT INTO ai_bot.migrations(version) VALUES (1)");
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); }
  }
  async checkAccount(userId) {
    const result = await this.pool.query("INSERT INTO ai_bot.users(telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO UPDATE SET last_login_at = now() RETURNING status, access_until", [String(userId)]);
    const user = result.rows[0];
    return { allowed: user.status === "active" && (!user.access_until || new Date(user.access_until).getTime() > Date.now()), until: user.access_until };
  }
  // A plain read of the person's row: checkAccount() stamps last_login_at, so delivery checks and /me use this instead.
  async account(userId) {
    const result = await this.pool.query("SELECT status, access_until FROM ai_bot.users WHERE telegram_id = $1", [String(userId)]);
    const user = result.rows[0];
    return user ? { status: user.status, until: user.access_until ? new Date(user.access_until).toISOString() : null } : null;
  }
  async allowed(userId) {
    return accountState(await this.account(userId)) === "active";
  }
  async users() {
    return (await this.pool.query("SELECT telegram_id, status, access_until, created_at, last_login_at FROM ai_bot.users ORDER BY last_login_at DESC LIMIT 30")).rows;
  }
  async setAccess(actorId, userId, status, until = null) {
    if (!["active", "blocked"].includes(status) || !/^\d{1,18}$/.test(String(userId))) throw new Error("INVALID_ACCOUNT");
    if (until !== null && (!Number.isFinite(Date.parse(until)) || Date.parse(until) <= Date.now())) throw new Error("INVALID_EXPIRY");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query("UPDATE ai_bot.users SET status = $2, access_until = $3 WHERE telegram_id = $1 RETURNING telegram_id", [String(userId), status, until]);
      if (!result.rows.length) throw new Error("USER_NOT_FOUND");
      await client.query("INSERT INTO ai_bot.access_events(actor_id, user_id, action) VALUES ($1,$2,$3)", [String(actorId), String(userId), status]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); }
  }
  async health() { await this.pool.query("SELECT 1"); return true; }
  async close() { await this.pool.end(); }
}

// Why a DATABASE_URL would be refused, as a stable code (never the URL itself, it holds the password), or null.
function databaseUrlProblem(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return "DATABASE_URL_INVALID"; }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) return "DATABASE_URL_INVALID";
  if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) && parsed.searchParams.get("sslmode") !== "verify-full") {
    return "DATABASE_TLS_REQUIRED";
  }
  return null;
}

let singleton;
function getDatabase() {
  if (!CONFIG.DATABASE_URL) return null;
  if (!singleton) {
    const problem = databaseUrlProblem(CONFIG.DATABASE_URL);
    if (problem) throw new Error(problem);
    const pool = new Pool({ connectionString: CONFIG.DATABASE_URL, max: 5, connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000, statement_timeout: 5000, query_timeout: 6000, application_name: "ai-bot" });
    pool.on("error", () => logger.error("PostgreSQL connection unavailable"));
    singleton = new Database(pool);
  }
  return singleton;
}

module.exports = { Database, getDatabase, accountState, databaseUrlProblem };
