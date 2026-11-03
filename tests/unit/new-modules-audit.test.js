// Regression tests for the findings of audit-reports/AUDIT_NEW_MODULES_2026-11-03_13-28.md (N-02, N-04..N-08).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadFresh } = require("../helpers/freshModules");
const { createFakeBot } = require("../helpers/fakeBot");
const { TEST_PASSWORD, TEST_PASSWORD_HASH } = require("../helpers/authFixture");

const OWNER = "4242";
const hourAgo = () => new Date(Date.now() - 3600 * 1000);

function labStoreModule() {
  return loadFresh("lab/store", { LOG_LEVEL: "silent" });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aibot-audit-"));
}

// ---------------------------------------------------------------- N-02: a claim left by an earlier run of this PID

test("N-02: блокировка лаборатории, оставшаяся от прошлого запуска с тем же PID, снимается", (t) => {
  const { LabStore } = labStoreModule();
  const file = path.join(tempDir(), "lab.json");

  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, token: "previous-run" }));
  fs.utimesSync(`${file}.lock`, hourAgo(), hourAgo());

  const store = new LabStore(file);

  t.after(() => store.close());
  store.read({ chatId: 5, userId: 5 });
  assert.equal(store.locked, true, "новый процесс забрал хранилище");
});

test("N-02: свежая блокировка этого же процесса (второй экземпляр рядом) по-прежнему считается занятой", (t) => {
  const { LabStore } = labStoreModule();
  const file = path.join(tempDir(), "lab.json");
  const first = new LabStore(file);
  const second = new LabStore(file);

  t.after(() => { first.close(); second.close(); });
  first.read({ chatId: 5, userId: 5 });
  assert.throws(() => second.read({ chatId: 5, userId: 5 }), /LAB_STORE_LOCKED/);
});

test("N-02: блокировка живого чужого процесса не снимается, даже старая", (t) => {
  const { LabStore } = labStoreModule();
  const file = path.join(tempDir(), "lab.json");
  // процесс-родитель теста: жив и точно не этот процесс
  const foreignPid = process.ppid;

  assert.notEqual(foreignPid, process.pid);
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: foreignPid, token: "someone-else" }));
  fs.utimesSync(`${file}.lock`, hourAgo(), hourAgo());

  const store = new LabStore(file);

  t.after(() => store.close());
  assert.throws(() => store.read({ chatId: 5, userId: 5 }), /LAB_STORE_LOCKED/);
});

test("N-02: недоделанное восстановление (старый файл .recovery) не блокирует хранилище навсегда", (t) => {
  const { LabStore } = labStoreModule();
  const file = path.join(tempDir(), "lab.json");

  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, token: "previous-run" }));
  fs.writeFileSync(`${file}.lock.recovery`, "");
  for (const name of [`${file}.lock`, `${file}.lock.recovery`]) fs.utimesSync(name, hourAgo(), hourAgo());

  const store = new LabStore(file);

  t.after(() => store.close());
  store.read({ chatId: 5, userId: 5 });
  assert.equal(store.locked, true);
  assert.equal(fs.existsSync(`${file}.lock.recovery`), false, "служебный файл убран");
});

// ---------------------------------------------------------------- N-04 / N-05 / N-06: password gate limits

function authModule(env = {}) {
  return loadFresh("services/auth", { BOT_OWNER_CHAT_ID: OWNER, BOT_PASSWORD_HASH: TEST_PASSWORD_HASH, LOG_LEVEL: "silent", ...env });
}

test("N-04: 50 чужих неверных паролей не закрывают вход владельцу, а остальным закрывают", async () => {
  const { PasswordAuth } = authModule();
  const auth = new PasswordAuth({ hash: TEST_PASSWORD_HASH, maxFailures: 5, lockMs: 900000 });

  for (let user = 1; user <= 10; user += 1) {
    for (let i = 0; i < 5; i += 1) await auth.authenticate(String(1000 + user), `wrong-${i}`);
  }

  assert.equal((await auth.authenticate("5555", TEST_PASSWORD)).reason, "locked", "посторонний при исчерпанном общем лимите ждёт");
  assert.equal((await auth.authenticate(OWNER, TEST_PASSWORD)).ok, true, "владелец входит");
});

test("N-04: ошибки самого владельца ограничены его личным пределом и не закрывают вход остальным", async () => {
  const { PasswordAuth } = authModule();
  const auth = new PasswordAuth({ hash: TEST_PASSWORD_HASH, maxFailures: 3, lockMs: 900000 });

  for (let i = 0; i < 3; i += 1) assert.equal((await auth.authenticate(OWNER, `wrong-${i}`)).reason, "wrong");
  assert.equal((await auth.authenticate(OWNER, TEST_PASSWORD)).reason, "locked", "личный предел владельца действует");
  assert.equal(auth.globalFailures.length, 0, "его ошибки не расходуют общий предел");
  assert.equal((await auth.authenticate("777", TEST_PASSWORD)).ok, true);
});

test("N-05: два одновременных посторонних не занимают проверку паролей у владельца", async () => {
  const { PasswordAuth } = authModule();
  const auth = new PasswordAuth({ hash: TEST_PASSWORD_HASH });
  const strangers = [auth.authenticate("1001", "x-1"), auth.authenticate("1002", "x-2")];

  assert.equal((await auth.authenticate("1003", TEST_PASSWORD)).reason, "busy", "третьему постороннему места нет");
  assert.equal((await auth.authenticate(OWNER, TEST_PASSWORD)).ok, true, "у владельца своё место");
  await Promise.all(strangers);
});

test("N-06: прошедший или нечитаемый срок доступа - отказ, а не «вход выполнен» с мёртвой сессией", async () => {
  const { PasswordAuth } = authModule();

  for (const until of ["не-дата", new Date(Date.now() - 1000).toISOString()]) {
    const auth = new PasswordAuth({ hash: TEST_PASSWORD_HASH });

    auth.accountPolicy = async () => ({ allowed: true, until });
    assert.deepEqual(await auth.authenticate("42", TEST_PASSWORD), { ok: false, reason: "blocked" }, String(until));
    assert.equal(auth.authenticated("42"), false);
  }

  const auth = new PasswordAuth({ hash: TEST_PASSWORD_HASH, ttl: 3600 * 1000 });
  const inTwoMinutes = new Date(Date.now() + 120000);

  auth.accountPolicy = async () => ({ allowed: true, until: inTwoMinutes });
  assert.equal((await auth.authenticate("42", TEST_PASSWORD)).ok, true);
  assert.ok(auth.sessions.get("42").expires <= inTwoMinutes.getTime(), "сессия не длиннее срока доступа");
});

// ---------------------------------------------------------------- N-07 / N-08: accounts and database settings

test("N-07: ошибка БД попадает в лог (с редактированием), а переполнение подтверждений не выдаётся за сбой БД", async () => {
  const lines = [];
  // loadFresh builds a new module graph, so the logger to capture is the one loaded together with `accounts`
  const { registerAccounts } = loadFresh("accounts", { BOT_OWNER_CHAT_ID: "999", BOT_PASSWORD_HASH: TEST_PASSWORD_HASH, DATABASE_URL: "" });
  const logger = require("../../src/utils/logger");

  logger.setOutput({ error: (line) => lines.push(line) });

  try {
    const authInstance = require("../../src/services/auth").auth;
    const bot = createFakeBot();

    await authInstance.authenticate(999, TEST_PASSWORD);
    registerAccounts(bot, () => ({ users: async () => { throw new Error("password authentication failed for user bot"); }, allowed: async () => true }));

    await bot.text(999, "/users");
    assert.match(bot.lastText(), /Учёт пользователей недоступен/);
    assert.ok(lines.some((line) => /Product accounts command failed/.test(line) && /password authentication failed/.test(line)), "причина записана в лог");

    // 100 неподтверждённых изменений - и сто первое получает честный ответ
    for (let i = 0; i < 100; i += 1) await bot.text(999, `/access ${100 + i} blocked`);
    await bot.text(999, "/access 300 blocked");
    assert.match(bot.lastText(), /Слишком много неподтверждённых/);
  } finally {
    logger.setOutput({ error: (line) => console.error(line) });
  }
});

test("N-08: databaseUrlProblem называет причину отказа и не содержит адреса", () => {
  const { databaseUrlProblem } = loadFresh("database", { LOG_LEVEL: "silent" });

  assert.equal(databaseUrlProblem("postgres://bot:secret@127.0.0.1:5432/app"), null);
  assert.equal(databaseUrlProblem("postgresql://bot:secret@localhost/app"), null);
  assert.equal(databaseUrlProblem("postgres://bot:secret@db.example.com/app?sslmode=verify-full"), null);
  assert.equal(databaseUrlProblem("postgres://bot:secret@db.example.com/app"), "DATABASE_TLS_REQUIRED");
  assert.equal(databaseUrlProblem("postgres://bot:secret@db.example.com/app?sslmode=require"), "DATABASE_TLS_REQUIRED");
  assert.equal(databaseUrlProblem("mysql://bot:secret@127.0.0.1/app"), "DATABASE_URL_INVALID");
  assert.equal(databaseUrlProblem("это не адрес"), "DATABASE_URL_INVALID");
});

test("N-08: остановка не падает из-за неверного DATABASE_URL", async () => {
  const { registerAccounts } = loadFresh("accounts", {
    BOT_OWNER_CHAT_ID: "999", BOT_PASSWORD_HASH: TEST_PASSWORD_HASH, DATABASE_URL: "postgres://bot:secret@db.example.com/app", LOG_LEVEL: "silent"
  });
  const { getDatabase } = require("../../src/database");
  const accounts = registerAccounts(createFakeBot(), getDatabase);

  await assert.doesNotReject(accounts.close());
});
