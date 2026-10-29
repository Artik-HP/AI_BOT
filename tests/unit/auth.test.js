const test = require("node:test");
const assert = require("node:assert/strict");
const { PasswordAuth, hashPassword } = require("../../src/services/auth");
const { TEST_PASSWORD, TEST_PASSWORD_HASH } = require("../helpers/authFixture");

test("password auth: missing/invalid config fails closed, salted hash never stores plaintext", async () => {
  assert.equal((await new PasswordAuth({ hash: "" }).authenticate(1, TEST_PASSWORD)).ok, false);
  const first = await hashPassword(TEST_PASSWORD);
  const second = await hashPassword(TEST_PASSWORD);
  assert.notEqual(first, second);
  assert.ok(!first.includes(TEST_PASSWORD));
  assert.equal((await new PasswordAuth({ hash: first }).authenticate(1, TEST_PASSWORD)).ok, true);
});

test("password auth: attempts lock out per actor; sessions expire and old generation never revives", async () => {
  let now = 1000;
  const auth = new PasswordAuth({ hash: TEST_PASSWORD_HASH, ttl: 100, maxFailures: 2, lockMs: 1000, now: () => now });
  assert.equal((await auth.authenticate(5, "wrong")).reason, "wrong");
  assert.equal((await auth.authenticate(5, "wrong")).reason, "wrong");
  assert.equal((await auth.authenticate(5, TEST_PASSWORD)).reason, "locked");
  now += 1001;
  assert.equal((await auth.authenticate(5, TEST_PASSWORD)).ok, true);
  const old = auth.capture(5);
  auth.logout(5);
  assert.equal((await auth.authenticate(5, TEST_PASSWORD)).ok, true);
  assert.equal(auth.valid(old), false);
  now += 101;
  assert.equal(auth.authenticated(5), false);
});

test("password auth: logout while verifier runs cannot create a new session afterward", async () => {
  const auth = new PasswordAuth({ hash: TEST_PASSWORD_HASH });
  const pending = auth.authenticate(9, TEST_PASSWORD);
  auth.logout(9);
  assert.equal((await pending).reason, "revoked");
  assert.equal(auth.authenticated(9), false);
});

test("password auth: bounded global guessing and hash concurrency", async () => {
  const auth = new PasswordAuth({ hash: TEST_PASSWORD_HASH });
  auth.globalFailures = Array(50).fill(Date.now());
  assert.equal((await auth.authenticate(22, TEST_PASSWORD)).reason, "locked");
  auth.globalFailures = [];
  const first = auth.authenticate(22, TEST_PASSWORD);
  assert.equal((await auth.authenticate(22, TEST_PASSWORD)).reason, "busy");
  assert.equal((await first).ok, true);
});
