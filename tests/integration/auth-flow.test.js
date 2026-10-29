const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { withApp } = require("../helpers/app");
const { TEST_PASSWORD } = require("../helpers/authFixture");
const { reply } = require("../helpers/fakeOpenRouter");
const USER = 7777;

async function send(tg, text, chatId = USER) {
  const before = tg.texts().length;
  tg.message({ chatId, text });
  await tg.waitFor(() => tg.texts().length > before, 5000, "authentication reply");
  await tg.quiet(60);
  return tg.texts().slice(before);
}

async function login(tg) {
  assert.match((await send(tg, "/start"))[0], /Введите пароль/);
  assert.ok((await send(tg, TEST_PASSWORD)).some((text) => /Вход выполнен/.test(text)));
}

test("auth gate: no hash and empty allow-list fail closed for owner, AI, media and all callbacks", async () => {
  await withApp({ authenticatedFixtures: false, env: { BOT_PASSWORD_HASH: "", BOT_OWNER_CHAT_ID: String(USER) } }, async ({ tg, or }) => {
    assert.match((await send(tg, "/start"))[0], /Доступ закрыт/);
    for (const text of ["/status", "/reset", "/lab", "/account_help", "привет"]) await send(tg, text);
    tg.message({ chatId: USER, voice: { file_id: "secret", file_size: 100, duration: 1 } });
    tg.message({ chatId: USER, photo: [{ file_id: "secret", width: 100, height: 100 }] });
    for (const data of ["menu:reset", "lab:forged", "account:send:forged"]) tg.callback({ chatId: USER, data });
    await tg.quiet(300);
    assert.equal(or.requests.length, 0);
    assert.equal(tg.sent("getFile").length, 0);
    assert.ok(!tg.texts().some((text) => /Память этого чата очищена|Я на месте/.test(text)));
  });
});

test("auth gate: password only in private challenge, no AI/log/history leak, logout revokes access", async () => {
  await withApp({ authenticatedFixtures: false, env: { LOG_MESSAGES: "true", MEMORY_SAVE_DEBOUNCE_MS: "10" } }, async ({ tg, or, app }) => {
    or.chat = () => reply("обычный ответ");
    await send(tg, TEST_PASSWORD);
    assert.equal(or.requests.length, 0);
    tg.message({ chatId: -1007, fromId: USER, chatType: "supergroup", text: TEST_PASSWORD });
    await tg.quiet(150);
    assert.equal(or.requests.length, 0);
    await send(tg, "/start");
    assert.match((await send(tg, "wrong-password"))[0], /Неверный пароль/);
    assert.ok((await send(tg, TEST_PASSWORD)).some((text) => /Вход выполнен/.test(text)));
    await send(tg, "новый вопрос");
    await tg.waitFor(() => fs.existsSync(app.memoryFile));
    assert.equal(or.chatRequests().length, 1);
    assert.ok(!JSON.stringify(or.requests).includes(TEST_PASSWORD));
    assert.ok(!fs.readFileSync(app.memoryFile, "utf8").includes(TEST_PASSWORD));
    assert.ok(!app.output().includes(TEST_PASSWORD));
    await send(tg, "/logout");
    await send(tg, "запрещённый вопрос");
    assert.equal(or.chatRequests().length, 1);
  });
});

test("auth gate: pending requests and responses stay revoked even after re-login", async () => {
  await withApp({ authenticatedFixtures: false, env: { BOT_OWNER_CHAT_ID: String(USER) } }, async ({ tg, or }) => {
    await login(tg);
    or.chat = () => ({ ...reply("PROTECTED_SLOW_RESULT"), delayMs: 1000 });
    tg.message({ chatId: USER, text: "slow A" });
    await tg.waitFor(() => or.chatRequests().length === 1);
    tg.message({ chatId: USER, text: "queued B" });
    await tg.quiet(60);
    await send(tg, "/logout");
    await login(tg);
    await tg.quiet(1300);
    assert.equal(or.chatRequests().length, 1);
    assert.ok(!tg.texts().includes("PROTECTED_SLOW_RESULT"));
  });
});
