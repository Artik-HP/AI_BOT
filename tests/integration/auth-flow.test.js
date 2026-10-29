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
    tg.message({ chatId: USER, text: `   ${TEST_PASSWORD}   ` });
    tg.message({ chatId: USER, text: `${TEST_PASSWORD}${" ".repeat(300)}` });
    tg.message({ chatId: USER, caption: ` ${TEST_PASSWORD} `, photo: [{ file_id: "no-download", width: 1, height: 1 }] });
    await tg.quiet(200);
    assert.equal(or.requests.length, 0);
    assert.equal(tg.sent("getFile").length, 0);
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
  await withApp({ authenticatedFixtures: false, env: { BOT_OWNER_CHAT_ID: String(USER) } }, async ({ tg, or, app }) => {
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
    assert.ok(!fs.existsSync(app.memoryFile) || !fs.readFileSync(app.memoryFile, "utf8").includes("PROTECTED_SLOW_RESULT"));
  });
});

test("auth gate: logout stops retry and revoked successful responses never enter history", async () => {
  await withApp({ authenticatedFixtures: false, env: { BOT_OWNER_CHAT_ID: String(USER), MEMORY_SAVE_DEBOUNCE_MS: "10" } }, async ({ tg, or, app }) => {
    await login(tg);
    or.chat = () => ({ status: 503, body: { error: { code: 503, message: "try later" } }, delayMs: 250 });
    tg.message({ chatId: USER, text: "REVOKED_EXCHANGE" });
    await tg.waitFor(() => or.chatRequests().length === 1);
    await send(tg, "/logout");
    await tg.quiet(1200);
    assert.equal(or.chatRequests().length, 1);
    assert.ok(!fs.existsSync(app.memoryFile) || !fs.readFileSync(app.memoryFile, "utf8").includes("REVOKED_EXCHANGE"));
  });
});

test("auth gate: old main-menu callbacks are rejected after re-login", async () => {
  await withApp({ authenticatedFixtures: false }, async ({ tg }) => {
    await login(tg);
    const old = tg.calls.filter((item) => item.method === "sendMessage" && item.params.reply_markup && JSON.parse(item.params.reply_markup).inline_keyboard).at(-1);
    const reset = JSON.parse(old.params.reply_markup).inline_keyboard.flat().find((item) => item.callback_data.endsWith(":reset"));
    await send(tg, "/logout"); await login(tg);
    const before = tg.texts().length;
    tg.callback({ chatId: USER, data: reset.callback_data, messageId: old.messageId });
    await tg.quiet(200);
    assert.ok(!tg.texts().slice(before).some((text) => text.includes("Память этого чата очищена")));
    assert.ok(tg.sent("answerCallbackQuery").some((item) => item.text?.includes("Кнопка истекла")));
  });
});

test("auth gate: logout prevents all later STT fallback requests", async () => {
  await withApp({ authenticatedFixtures: false }, async ({ tg, or }) => {
    await login(tg);
    tg.addFile("auth-voice", "voice/auth.oga", Buffer.alloc(100, 1));
    let release;
    or.stt = async () => {
      await new Promise((resolve) => { release = resolve; });
      return { status: 404, body: { error: { code: 404, message: "model missing" } } };
    };
    tg.message({ chatId: USER, voice: { file_id: "auth-voice", file_size: 100, duration: 1, mime_type: "audio/ogg" } });
    await tg.waitFor(() => or.sttRequests().length === 1);
    await send(tg, "/logout");
    release();
    await tg.quiet(700);
    assert.equal(or.sttRequests().length, 1);
    assert.equal(or.chatRequests().length, 0);
  });
});

test("auth roles: a configured group cannot grant bot-to-bot owner powers to a member", async () => {
  await withApp({ authenticatedFixtures: false, env: { BOT_TO_BOT_OWNER_CHAT_ID: "-1007", BOT_TO_BOT_ENABLED: "true", BOT_TO_BOT_CHAT_ID: "-1008", BOT_TO_BOT_TARGET_BOT_USERNAME: "peer_test_bot" } }, async ({ tg }) => {
    await login(tg);
    const before = tg.calls.length;
    tg.message({ chatId: -1007, fromId: USER, chatType: "supergroup", text: "/bot_send попытка отправки" });
    await tg.waitFor(() => tg.calls.slice(before).some((call) => call.method === "sendMessage"));
    assert.ok(!tg.calls.slice(before).some((call) => call.method === "sendMessage" && String(call.params.chat_id) === "-1008"));
  });
});
