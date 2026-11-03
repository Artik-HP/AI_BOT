// End-to-end regression tests for audit-reports/AUDIT_NEW_MODULES_2026-11-03_13-28.md (N-01, N-03, N-08).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { withApp } = require("../helpers/app");
const { reply } = require("../helpers/fakeOpenRouter");

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "aibot-nm-"));

// ---------------------------------------------------------------- N-01: the lab must never take ordinary chat down

test("N-01: битый файл лаборатории без копии не мешает обычному чату, /logout и /login", async () => {
  const labFile = path.join(tempDir(), "lab.json");

  fs.writeFileSync(labFile, "{ это не json");

  await withApp({ env: { AI_LAB_FILE: labFile } }, async ({ tg, or }) => {
    or.chat = () => reply("обычный ответ на обычный вопрос");

    tg.message({ chatId: 4242, text: "привет, как дела?" });
    await tg.waitFor(() => tg.texts().includes("обычный ответ на обычный вопрос"), 8000, "ответ при битом файле лаборатории");

    tg.message({ chatId: 4242, text: "/logout" });
    await tg.waitFor(() => tg.texts().some((text) => /Вы вышли/.test(text)), 8000, "подтверждение выхода");

    tg.message({ chatId: 4242, text: "/login" });
    await tg.waitFor(() => tg.texts().some((text) => /Введите пароль/.test(text)), 8000, "приглашение ко входу");
  });
});

test("N-01: занятая чужим процессом блокировка лаборатории отключает только лабораторию", async () => {
  const labFile = path.join(tempDir(), "lab.json");

  fs.writeFileSync(labFile, JSON.stringify({ version: 1, scopes: {} }));
  // процесс теста жив и не является ботом: для бота это чужая живая блокировка, снимать её нельзя
  fs.writeFileSync(`${labFile}.lock`, JSON.stringify({ pid: process.pid, token: "held-by-the-test-process" }));

  await withApp({ env: { AI_LAB_FILE: labFile } }, async ({ tg, or, app }) => {
    or.chat = () => reply("обычный ответ");

    for (let i = 0; i < 3; i += 1) tg.message({ chatId: 4243, text: `вопрос ${i}` });
    await tg.waitFor(() => tg.texts().filter((text) => text === "обычный ответ").length >= 3, 8000, "три обычных ответа");

    tg.message({ chatId: 4243, text: "/lab" });
    await tg.waitFor(() => tg.texts().some((text) => /Хранилище лаборатории занято/.test(text)), 8000, "честное сообщение лаборатории");

    const warnings = app.output().split("\n").filter((line) => /The lab store is unavailable/.test(line));

    assert.equal(warnings.length, 1, "поток сообщений не превращается в поток строк лога");
  });
});

// ---------------------------------------------------------------- N-03: strangers are answered within the same limit

test("N-03: посторонний без пароля получает не больше ответов, чем разрешает лимит, и одно объяснение", async () => {
  await withApp({ authenticatedFixtures: false, env: { RATE_LIMIT_MESSAGES: "5", RATE_LIMIT_WINDOW_MS: "60000" } }, async ({ tg, or }) => {
    for (let i = 0; i < 60; i += 1) tg.message({ chatId: 31337, text: `спам ${i}` });
    await tg.quiet(2500);

    const replies = tg.sent().filter((params) => String(params.chat_id) === "31337").map((params) => params.text);

    assert.equal(replies.length, 6, "5 ответов по лимиту и одно «слишком часто»");
    assert.equal(replies.filter((text) => /Слишком часто/.test(text)).length, 1);
    assert.equal(or.requests.length, 0);
  });
});

test("N-03: владелец не ограничен этим лимитом ещё до входа", async () => {
  await withApp({ authenticatedFixtures: false, env: { BOT_OWNER_CHAT_ID: "5151", RATE_LIMIT_MESSAGES: "5" } }, async ({ tg }) => {
    for (let i = 0; i < 12; i += 1) tg.message({ chatId: 5151, text: `привет ${i}` });
    await tg.waitFor(() => tg.sent().filter((params) => String(params.chat_id) === "5151").length >= 12, 8000, "12 ответов владельцу");
    assert.ok(!tg.texts().some((text) => /Слишком часто/.test(text)));
  });
});

// ---------------------------------------------------------------- N-08: a refused database setting is announced at start

test("N-08: неверный DATABASE_URL назван в логе при старте, без пароля из адреса", async () => {
  await withApp({ env: { DATABASE_URL: "postgres://bot:very-secret-pass@db.example.com/app" } }, async ({ app }) => {
    assert.ok(await app.waitForOutput(/DATABASE_URL отклонён \(DATABASE_TLS_REQUIRED\)/, 8000));
    assert.ok(!app.output().includes("very-secret-pass"));
  });
});
