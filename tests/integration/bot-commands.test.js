const test = require("node:test");
const assert = require("node:assert/strict");
const { withApp } = require("../helpers/app");
const { reply } = require("../helpers/fakeOpenRouter");

const OWNER = 4100;
const USER = 4101;
const OWNER_ENV = { BOT_TO_BOT_OWNER_CHAT_ID: String(OWNER), ACCOUNT_ASSISTANT_OWNER_CHAT_ID: String(OWNER) };

// Sends one update and returns what the bot sent back in response (settles after a short quiet period).
async function ask(tg, send, { expectReply = true } = {}) {
  const before = tg.calls.length;

  send();

  if (expectReply) {
    await tg.waitFor(() => tg.calls.slice(before).some((call) => call.method === "sendMessage" || call.method === "editMessageText"), 6000, "ответ");
  }

  await tg.quiet(250);
  return tg.calls.slice(before).filter((call) => call.method === "sendMessage" || call.method === "editMessageText").map((call) => call.params);
}

const say = (tg, chatId, text, options = {}) => ask(tg, () => tg.message({ chatId, text }), options);

test("все команды владельца, кнопки и inline-меню отвечают", async () => {
  await withApp({ env: OWNER_ENV }, async ({ tg }) => {
    const expectations = [
      ["/start", /Я на месте/, 2],
      ["/menu", /Я на месте/, 2],
      ["/help", /^Команды:/, 1],
      ["/voice", /^Голосовые:/, 1],
      ["/status", /^Статус:/, 1],
      ["/reset", /Память этого чата очищена/, 1],
      ["/bot_status", /Общение с другими ботами/, 1],
      ["/account_help", /Account assistant команды/, 1],
      ["/account_status", /^Account assistant:/, 1],
      ["/account_config", /Account assistant конфигурация/, 1],
      ["/account_pending", /Активных черновиков нет/, 1],
      ["/account_mode", /Текущий режим: approval/, 1],
      ["/account_mode bogus", /Режим не изменён/, 1],
      ["/account_allow @x_user1", /Добавлено в allow-list: x_user1/, 1],
      ["/account_unallow @x_user1", /Удалено из allow-list: x_user1/, 1],
      ["/account_block @x_user2", /Добавлено в block-list: x_user2/, 1],
      ["/account_unblock @x_user2", /Удалено из block-list: x_user2/, 1],
      ["/account_disable", /Account assistant отключён/, 1],
      ["/account_send abc", /Draft not found/, 1],
      ["/account_drop abc", /Черновик не найден/, 1],
      ["/account_reply abc hi", /Draft not found/, 1],
      ["/account_redraft abc", /Draft not found/, 1],
      ["/account_message @someone hi", /Account client is not connected/, 1],
      ["Помощь", /^Команды:/, 1],
      ["Статус", /^Статус:/, 1],
      ["Голосовые", /^Голосовые:/, 1],
      ["Очистить память", /Память этого чата очищена/, 1],
      ["Меню", /Я на месте/, 2]
    ];

    for (const [text, pattern, count] of expectations) {
      const replies = await say(tg, OWNER, text);

      assert.ok(replies.length >= count, `${text}: ожидалось ${count} ответ(ов), пришло ${replies.length}`);
      assert.match(replies[0].text, pattern, text);
    }

    for (const [action, pattern] of [["help", /^Команды:/], ["voice", /^Голосовые:/], ["status", /^Статус:/], ["reset", /Память этого чата очищена/], ["main", /Панель управления/]]) {
      const replies = await ask(tg, () => tg.callback({ chatId: OWNER, data: `menu:${action}` }));

      assert.match(replies[0].text, pattern, `menu:${action}`);
    }

    assert.ok(tg.sent("answerCallbackQuery").length >= 5);
  });
});

test("обычному пользователю: публичные команды работают, служебные молчат или отказывают", async () => {
  await withApp({ env: OWNER_ENV }, async ({ tg }) => {
    assert.match((await say(tg, USER, "/help"))[0].text, /^Команды:/);
    assert.match((await say(tg, USER, "/status"))[0].text, /^Статус:/);

    for (const command of ["/account_help", "/account_status", "/account_config", "/account_mode auto", "/account_private false", "/account_allow @x_user1", "/account_enable"]) {
      assert.deepEqual(await say(tg, USER, command, { expectReply: false }), [], `${command} должна молчать для не-владельца`);
    }

    assert.match((await say(tg, USER, "/bot_status"))[0].text, /только владельцу/);
  });
});

test("не-владелец не видит служебных команд и внутренностей (F006, F028)", async () => {
  await withApp({ env: { ...OWNER_ENV, BOT_TO_BOT_CHAT_ID: "-1001234567890", BOT_TO_BOT_TARGET_BOT_USERNAME: "peer_test_bot" } }, async ({ tg }) => {
    const userHelp = (await say(tg, USER, "/help"))[0].text;
    const userStatus = (await say(tg, USER, "/status"))[0].text;
    const ownerHelp = (await say(tg, OWNER, "/help"))[0].text;
    const ownerStatus = (await say(tg, OWNER, "/status"))[0].text;

    assert.doesNotMatch(userHelp, /account_|bot_send/);
    assert.doesNotMatch(userStatus, /AI-модель|STT-модели|Bot-to-bot|1001234567890|peer_test_bot/);
    assert.match(userStatus, /Сообщений сохранено/);

    assert.match(ownerHelp, /Команды владельца:/);
    assert.match(ownerHelp, /\/account_unallow/);
    assert.match(ownerHelp, /\/account_unblock/);
    assert.match(ownerStatus, /AI-модель: openai\/gpt-4o-mini/);
    assert.match(ownerStatus, /Bot-to-bot target: @peer_test_bot/);
  });
});

test("меню команд Telegram: 6 публичных всем, полное - только в чате владельца (F028)", async () => {
  await withApp({ env: OWNER_ENV }, async ({ tg }) => {
    await tg.waitFor(() => tg.sent("setMyCommands").length >= 2, 6000, "две установки меню");

    const calls = tg.sent("setMyCommands").map((params) => ({ commands: JSON.parse(params.commands), scope: params.scope ? JSON.parse(params.scope) : null }));
    const publicMenu = calls.find((call) => !call.scope);
    const ownerMenu = calls.find((call) => call.scope);

    assert.deepEqual(publicMenu.commands.map((entry) => entry.command), ["start", "menu", "help", "voice", "status", "reset"]);
    assert.deepEqual(ownerMenu.scope, { type: "chat", chat_id: OWNER });
    assert.equal(ownerMenu.commands.length, 25);
    assert.ok(ownerMenu.commands.some((entry) => entry.command === "account_unblock"));
    assert.ok(ownerMenu.commands.every((entry) => entry.description.length <= 256 && /^[a-z0-9_]{1,32}$/.test(entry.command)));
  });
});

test("команда, адресованная другому боту, игнорируется; своя - выполняется (F024)", async () => {
  await withApp({ env: OWNER_ENV }, async ({ tg }) => {
    await tg.waitFor(() => tg.calls.some((call) => call.method === "getMe"), 4000, "getMe");
    await tg.quiet(400);

    const foreign = await ask(tg, () => tg.message({ chatId: -100888, fromId: USER, chatType: "supergroup", text: "/reset@some_other_bot" }), { expectReply: false });
    const mine = await ask(tg, () => tg.message({ chatId: -100888, fromId: USER, chatType: "supergroup", text: "/help@test_audit_bot" }));

    assert.deepEqual(foreign, []);
    assert.match(mine[0].text, /^Команды:/);
  });
});

test("список разрешённых: чужой получает один отказ в минуту и не тратит ИИ, свои и владелец проходят (F010)", async () => {
  await withApp({ env: { BOT_ALLOWED_USER_IDS: "111,222", BOT_TO_BOT_OWNER_CHAT_ID: "999" } }, async ({ tg, or }) => {
    or.chat = () => reply("ответ своим");

    tg.message({ chatId: 333, text: "привет, я чужой" });
    tg.message({ chatId: 333, text: "и ещё одно сообщение" });
    await tg.waitFor(() => tg.texts().length >= 1, 6000, "отказ");
    await tg.quiet(600);

    assert.equal(tg.texts().length, 1, "отказ не должен повторяться на каждое сообщение");
    assert.match(tg.texts()[0], /приватный/);
    assert.equal(or.chatRequests().length, 0);

    tg.message({ chatId: 111, text: "я свой" });
    tg.message({ chatId: 999, text: "я владелец" });
    await tg.waitFor(() => tg.texts().filter((text) => text === "ответ своим").length >= 2, 8000, "ответы своим");
    assert.equal(or.chatRequests().length, 2);
  });
});

test("лимит запросов на пользователя; владелец не ограничен (F010)", async () => {
  await withApp({ env: { RATE_LIMIT_MESSAGES: "3", BOT_TO_BOT_OWNER_CHAT_ID: "999" } }, async ({ tg, or }) => {
    let n = 0;

    or.chat = () => reply(`ответ ${++n}`);

    for (let i = 0; i < 5; i += 1) {
      tg.message({ chatId: 777, text: `сообщение ${i}` });
    }

    await tg.waitFor(() => tg.texts().some((text) => /Слишком часто/.test(text)) && or.chatRequests().length >= 3, 10000, "лимит");
    await tg.quiet(600);

    assert.equal(or.chatRequests().length, 3, "четвёртое и пятое не доходят до ИИ");
    assert.equal(tg.texts().filter((text) => /Слишком часто/.test(text)).length, 1, "предупреждение одно");

    const before = or.chatRequests().length;

    for (let i = 0; i < 5; i += 1) {
      tg.message({ chatId: 999, text: `владелец ${i}` });
    }

    await tg.waitFor(() => or.chatRequests().length >= before + 5, 10000, "владелец без лимита");
  });
});

test("сообщения от ботов при выключенном bot-to-bot игнорируются всех видов (F018)", async () => {
  await withApp({}, async ({ tg, or }) => {
    tg.addFile("bv", "voice/bv.oga", Buffer.alloc(3000, 2));
    tg.addFile("bp", "photos/bp.jpg", Buffer.from([0xff, 0xd8, 0xff, 1]));
    const bot = { fromId: 888, isBot: true, firstName: "OtherBot", username: "other_bot" };

    tg.message({ chatId: 4200, ...bot, text: "привет от бота" });
    tg.message({ chatId: 4200, ...bot, voice: { file_id: "bv", file_unique_id: "b", duration: 1, mime_type: "audio/ogg", file_size: 3000 } });
    tg.message({ chatId: 4200, ...bot, photo: [{ file_id: "bp", file_unique_id: "p", width: 10, height: 10, file_size: 100 }] });
    await tg.quiet(1500);

    assert.deepEqual(tg.texts(), []);
    assert.equal(or.requests.length, 0, "было: голос от бота расшифровывался и получал ответ");
    assert.equal(tg.sent("getFile").length, 0);
  });
});

test("bot-to-bot: ответы собеседнику с упоминанием, лимит ходов обрывает диалог", async () => {
  await withApp({
    env: {
      BOT_TO_BOT_ENABLED: "true",
      BOT_TO_BOT_OWNER_CHAT_ID: String(OWNER),
      BOT_TO_BOT_CHAT_ID: "-100777",
      BOT_TO_BOT_TARGET_BOT_USERNAME: "Peer_Test_Bot",
      BOT_TO_BOT_ALLOW_BOTS: "peer_test_bot",
      BOT_TO_BOT_MIN_INTERVAL_MS: "1",
      BOT_TO_BOT_MAX_TURNS: "3",
      BOT_TO_BOT_WINDOW_MS: "60000"
    }
  }, async ({ tg, or }) => {
    let n = 0;

    or.chat = () => reply(`уникальный ответ пиру номер ${++n}`);

    for (let i = 0; i < 6; i += 1) {
      tg.message({ chatId: -100777, fromId: 9001, isBot: true, firstName: "Peer", username: "peer_test_bot", chatType: "supergroup", text: `@test_audit_bot ход ${i}` });
      await tg.quiet(350);
    }

    await tg.quiet(800);

    assert.equal(tg.texts().length, 3, "после 3 ходов диалог обрывается");
    assert.ok(tg.texts().every((text) => text.startsWith("@peer_test_bot уникальный ответ пиру")));
    assert.equal(or.chatRequests().length, 3);
  });
});

test("/bot_send: многострочный текст не склеивается, цель по умолчанию подставляется (F032)", async () => {
  await withApp({
    env: {
      BOT_TO_BOT_ENABLED: "true",
      BOT_TO_BOT_OWNER_CHAT_ID: String(OWNER),
      BOT_TO_BOT_CHAT_ID: "-100777",
      BOT_TO_BOT_TARGET_BOT_USERNAME: "Peer_Test_Bot"
    }
  }, async ({ tg }) => {
    const replies = await say(tg, OWNER, "/bot_send строка1\nстрока2\n\nстрока4");

    assert.equal(replies[0].text, "@peer_test_bot строка1\nстрока2\n\nстрока4");
    assert.equal(String(replies[0].chat_id), "-100777");
    assert.match(replies[1].text, /Сообщение отправлено @peer_test_bot/);

    const explicit = await say(tg, OWNER, "/bot_send @peer_test_bot явная цель");
    assert.equal(explicit[0].text, "@peer_test_bot явная цель");

    const usage = await say(tg, OWNER, "/bot_send");
    assert.match(usage[0].text, /Используй: \/bot_send/);
  });
});

test("/bot_send без заданной цели объясняет, чего не хватает (F032)", async () => {
  await withApp({ env: { BOT_TO_BOT_ENABLED: "true", BOT_TO_BOT_OWNER_CHAT_ID: String(OWNER) } }, async ({ tg }) => {
    const replies = await say(tg, OWNER, "/bot_send привет всем");

    assert.match(replies[0].text, /Не задан целевой бот/);
    assert.match(replies[0].text, /BOT_TO_BOT_TARGET_BOT_USERNAME/);
  });
});

test("/account_enable без настроек не оставляет ассистента «включённым» (F027)", async () => {
  await withApp({ env: OWNER_ENV }, async ({ tg }) => {
    const enable = await say(tg, OWNER, "/account_enable");
    const status = await say(tg, OWNER, "/account_status");

    assert.match(enable[0].text, /Не удалось включить: Missing env: TELEGRAM_API_ID/);
    assert.match(status[0].text, /enabled: false/);
    assert.match(status[0].text, /connected: false/);
  });
});

test("/account_private: опечатка не меняет значение, а подсказывает формат (F016)", async () => {
  await withApp({ env: OWNER_ENV }, async ({ tg }) => {
    assert.match((await say(tg, OWNER, "/account_private"))[0].text, /privateOnly: true/);
    assert.match((await say(tg, OWNER, "/account_private ture"))[0].text, /Не понял «ture».*Значение не изменено/);
    assert.match((await say(tg, OWNER, "/account_private"))[0].text, /privateOnly: true/);
    assert.match((await say(tg, OWNER, "/account_private off"))[0].text, /Private-only установлен в false/);
    assert.match((await say(tg, OWNER, "/account_private"))[0].text, /privateOnly: false/);
  });
});
