const test = require("node:test");
const assert = require("node:assert/strict");
const { PGlite } = require("@electric-sql/pglite");
const { Database } = require("../../src/database");
const { PasswordAuth } = require("../../src/services/auth");
const { TEST_PASSWORD, TEST_PASSWORD_HASH } = require("../helpers/authFixture");

test("PostgreSQL SQL: migrations, accounts, access audit and rollback on embedded Postgres", async () => {
  const engine = await PGlite.create("memory://");
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (/;\s*\S/.test(sql)) return (await engine.exec(sql)).at(-1);
    return engine.query(sql, params);
  }, end: () => engine.close() };
  pool.connect = async () => ({ query: pool.query, release() {} });
  const db = new Database(pool);
  try {
    await db.migrate(); await db.migrate();
    assert.equal((await engine.query("SELECT count(*)::int AS n FROM ai_bot.migrations")).rows[0].n, 1);
    assert.equal((await db.checkAccount(100)).allowed, true);
    assert.equal((await db.users()).length, 1);
    await db.setAccess(999, 100, "blocked");
    assert.equal(await db.allowed(100), false);
    assert.equal((await db.checkAccount(100)).allowed, false);
    await db.setAccess(999, 100, "active", new Date(Date.now() + 60000).toISOString());
    assert.equal(await db.allowed(100), true);
    assert.equal((await engine.query("SELECT count(*)::int AS n FROM ai_bot.access_events")).rows[0].n, 2);
    await assert.rejects(db.setAccess(999, "100; DROP SCHEMA ai_bot", "active"), /INVALID/);
    await assert.rejects(db.setAccess(999, 100, "administrator"), /INVALID/);
    await assert.rejects(db.setAccess(999, 101, "blocked"), /NOT_FOUND/);
    assert.equal((await db.users()).length, 1);
    assert.ok(calls.find((call) => call.sql.includes("WHERE telegram_id = $1") && call.params[0] === "100"));
    const auth = new PasswordAuth({ hash: TEST_PASSWORD_HASH });
    auth.accountPolicy = (userId) => db.checkAccount(userId);
    assert.equal((await auth.authenticate(100, TEST_PASSWORD)).ok, true);
    await db.setAccess(999, 100, "blocked"); auth.logout(100);
    assert.equal((await auth.authenticate(100, TEST_PASSWORD)).reason, "blocked");
    auth.accountPolicy = async () => { throw new Error("unreachable"); };
    assert.equal((await auth.authenticate(102, TEST_PASSWORD)).reason, "database");
    assert.equal(auth.authenticated(102), false);
    await db.health();
  } finally { await db.close(); }
});
