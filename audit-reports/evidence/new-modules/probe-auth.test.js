// Audit probes for PasswordAuth (unit level, no network).
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const R = require("path").resolve(__dirname, "..", "..", "..");
const { PasswordAuth, hashPassword } = require(`${R}/src/services/auth`);

async function make(opts = {}) {
  const hash = await hashPassword("correct-horse-battery");
  return new PasswordAuth({ hash, ttl: 60000, maxFailures: 5, lockMs: 900000, ...opts });
}

test("P4a: 10 strangers x 5 wrong guesses lock the REAL owner out (global limit 50)", async () => {
  const auth = await make();
  for (let user = 1; user <= 10; user += 1) {
    for (let i = 0; i < 5; i += 1) await auth.authenticate(String(1000 + user), "wrong-guess-" + i);
  }
  const owner = await auth.authenticate("42", "correct-horse-battery");
  console.log("owner login after 50 foreign failures ->", JSON.stringify(owner));
  assert.equal(owner.ok, false);
});

test("P4b: two concurrent strangers keep every scrypt slot busy for the owner", async () => {
  const auth = await make();
  const slow = [auth.authenticate("1001", "x-1"), auth.authenticate("1002", "x-2")];
  const owner = await auth.authenticate("42", "correct-horse-battery");
  console.log("owner login while 2 strangers are being checked ->", JSON.stringify(owner));
  await Promise.all(slow);
  assert.equal(owner.reason, "busy");
});

test("P5: invalid access_until yields a session that is 'logged in' but already dead", async () => {
  const auth = await make();
  auth.accountPolicy = async () => ({ allowed: true, until: "not-a-date" });
  const result = await auth.authenticate("42", "correct-horse-battery");
  console.log("authenticate ->", JSON.stringify(result), "| authenticated() right after:", auth.authenticated("42"));
  assert.equal(result.ok, true);
  assert.equal(auth.authenticated("42"), false);
});

test("P6: failures map full (10000) -> new wrong guesses are not counted per user", async () => {
  const auth = await make();
  for (let i = 0; i < 10000; i += 1) auth.failures.set(String(5000000 + i), { count: 1, until: Date.now() + 900000 });
  for (let i = 0; i < 20; i += 1) await auth.authenticate("777", "guess-" + i);
  console.log("failures recorded for user 777:", auth.failures.get("777")?.count ?? "none", "| global failures:", auth.globalFailures.length);
  // 20 guesses by one user: per-user lock should have stopped him at 5
  assert.ok((auth.failures.get("777")?.count ?? 0) < 5, "per-user counter is not recorded when the map is full");
});
