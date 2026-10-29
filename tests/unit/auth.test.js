const test = require("node:test");
const assert = require("node:assert/strict");
const { PasswordAuth, hashPassword } = require("../../src/services/auth");
const { TEST_PASSWORD, TEST_PASSWORD_HASH } = require("../helpers/authFixture");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadFresh } = require("../helpers/freshModules");
const { createFakeBot } = require("../helpers/fakeBot");

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

test("password auth: natural expiry and re-login never renew an old destructive lab button", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-lab-expiry-"));
  const { LabTelegram } = loadFresh("lab/telegram", { BOT_PASSWORD_HASH: TEST_PASSWORD_HASH, MEMORY_FILE: path.join(dir, "memory.json") });
  const { LabService } = require("../../src/lab/service");
  const { LabStore } = require("../../src/lab/store");
  const { auth } = require("../../src/services/auth");
  const { idea } = require("../helpers/labFixtures");
  let now = 1000; auth.now = () => now;
  const ctx = { chatId: 123, userId: 123 };
  const service = new LabService({ store: new LabStore(path.join(dir, "lab.json")) });
  const bot = createFakeBot(); const lab = new LabTelegram(bot, service);
  try {
    await auth.authenticate(123, TEST_PASSWORD);
    service.saveProject(ctx, idea);
    await lab.open({ chat: { id: 123, type: "private" }, from: { id: 123 } });
    const clear = service.data(ctx).callbacks.find((item) => item.action === "clear");
    await lab.callback({ from: { id: 123 }, message: { chat: { id: 123, type: "private" }, message_id: clear.messageId }, data: `lab:${clear.id}` });
    const confirm = service.data(ctx).callbacks.find((item) => item.action === "clear_confirm");
    now += auth.ttl + 1;
    assert.equal(auth.authenticated(123), false);
    await auth.authenticate(123, TEST_PASSWORD);
    await lab.callback({ from: { id: 123 }, message: { chat: { id: 123, type: "private" }, message_id: confirm.messageId }, data: `lab:${confirm.id}` });
    assert.equal(service.data(ctx).projects.length, 1);
    assert.ok(bot.sent.at(-1).text.includes("Это действие уже обработано"));
  } finally { await lab.close(); }
});
