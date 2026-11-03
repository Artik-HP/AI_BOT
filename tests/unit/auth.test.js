const test = require("node:test");
const assert = require("node:assert/strict");
const { PasswordAuth, hashPassword, startPayloadOf } = require("../../src/services/auth");
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

test("D3: любой logout вызывает обработчик отзыва — ошибка обработчика не ломает выход; без обработчика — как раньше", async () => {
  const auth = new PasswordAuth({ hash: TEST_PASSWORD_HASH });

  await auth.authenticate(5, TEST_PASSWORD);
  assert.doesNotThrow(() => auth.logout(5), "без обработчика выход работает");

  const revoked = [];

  auth.onRevoke = (userId) => { revoked.push(userId); };
  await auth.authenticate(5, TEST_PASSWORD);
  auth.logout(5);
  auth.logout(6);
  assert.deepEqual(revoked, ["5", "6"], "и для того, кто не входил: отзыв идемпотентен");
  assert.equal(auth.authenticated(5), false);

  auth.onRevoke = () => { throw new Error("hook failed"); };
  await auth.authenticate(5, TEST_PASSWORD);
  assert.doesNotThrow(() => auth.logout(5));
  assert.equal(auth.authenticated(5), false, "сессия закрыта, даже если обработчик упал");

  auth.onRevoke = async () => { throw new Error("async hook failed"); };
  assert.doesNotThrow(() => auth.logout(5), "отклонённый промис не становится unhandledRejection");
  await new Promise((resolve) => setImmediate(resolve));
});

test("вход по ссылке: /start spark_<код> запоминается только в проверенном виде, на срок вызова на вход и один раз", () => {
  const clock = { now: 0 };
  const auth = new PasswordAuth({ hash: TEST_PASSWORD_HASH, now: () => clock.now });

  assert.deepEqual(["/start spark_9AbC-_12", "/start@test_bot spark_x", "/start other", "/start", "/start spark_a b", "/start spark_кофе"].map(startPayloadOf),
    ["spark_9AbC-_12", "spark_x", null, null, null, null]);

  auth.challenge(5, "spark_9AbC-_12");
  assert.equal(auth.takeStartPayload(5), "spark_9AbC-_12");
  assert.equal(auth.takeStartPayload(5), null, "один раз");

  auth.challenge(5, "spark_<script>");
  assert.equal(auth.takeStartPayload(5), null, "непроверенный формат не хранится");

  auth.challenge(5, "spark_late");
  clock.now += 10 * 60000 + 1;
  assert.equal(auth.takeStartPayload(5), null, "срок — как у вызова на вход");

  auth.challenge(5, "spark_gone");
  auth.logout(5);
  assert.equal(auth.takeStartPayload(5), null, "выход забывает нагрузку");

  auth.challenge(5, "spark_first");
  auth.challenge(5);
  assert.equal(auth.takeStartPayload(5), null, "новый /start без ссылки заменяет старую нагрузку");
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
