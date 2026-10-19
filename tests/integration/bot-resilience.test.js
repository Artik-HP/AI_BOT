const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { FakeTelegram, TEST_BOT_TOKEN } = require("../helpers/fakeTelegram");
const { FakeOpenRouter, TEST_OPENROUTER_KEY, failure, reply } = require("../helpers/fakeOpenRouter");
const { launchApp, waitReady, withApp } = require("../helpers/app");
const { waitFor } = require("../helpers/freshModules");

const TOKEN_SECRET_PART = TEST_BOT_TOKEN.split(":")[1];
const BLOCKED = "Forbidden: bot was blocked by the user";

test("пользователь заблокировал бота: процесс жив, остальные получают ответы (F003, было: падение с кодом 1)", async () => {
  await withApp({}, async ({ tg, app }) => {
    tg.failNext("sendMessage", 403, BLOCKED);
    tg.message({ chatId: 5001, text: "/help" });
    await tg.waitFor(() => tg.sent().length >= 1, 8000, "попытка ответа");
    await tg.quiet(500);

    assert.equal(app.exited(), null, `процесс упал: ${app.output().slice(-400)}`);

    tg.clearFail("sendMessage");
    tg.message({ chatId: 5002, text: "/help" });
    await tg.waitFor(() => tg.texts().some((text) => text.startsWith("Команды:")), 8000, "ответ другому пользователю");
    assert.equal(app.exited(), null);
  });
});

test("ошибка ИИ и ещё ошибка Telegram внутри catch: процесс жив (F003)", async () => {
  await withApp({}, async ({ tg, or, app }) => {
    or.chat = () => failure(500, "upstream down");
    tg.failNext("sendMessage", 403, BLOCKED);
    tg.message({ chatId: 5003, text: "привет" });
    await tg.waitFor(() => or.chatRequests().length >= 2 && tg.sent().length >= 1, 10000, "ошибки");
    await tg.quiet(500);

    assert.equal(app.exited(), null, `процесс упал: ${app.output().slice(-400)}`);

    tg.clearFail("sendMessage");
    or.chat = () => reply("снова работаю");
    tg.message({ chatId: 5004, text: "ты тут?" });
    await tg.waitFor(() => tg.texts().includes("снова работаю"), 8000, "ответ после сбоя");
  });
});

test("в логах нет ни токена бота, ни ключа OpenRouter после сбоев (F003, F007)", async () => {
  await withApp({}, async ({ tg, or, app }) => {
    or.chat = () => failure(401, "invalid key");
    tg.failNext("sendMessage", 403, BLOCKED);
    tg.message({ chatId: 5005, text: "/help" });
    tg.message({ chatId: 5006, text: "привет" });
    await tg.waitFor(() => or.chatRequests().length >= 1 && tg.sent().length >= 2, 10000, "оба сбоя");
    await tg.quiet(500);

    const output = app.output();

    assert.ok(output.length > 0);
    assert.ok(!output.includes(TOKEN_SECRET_PART), "токен бота попал в лог");
    assert.ok(!output.includes(TEST_OPENROUTER_KEY), "ключ OpenRouter попал в лог");
    assert.ok(output.split("\n").length < 60, `лог раздут (${output.split("\n").length} строк): остался дамп объекта`);
  });
});

test("тексты сообщений по умолчанию не попадают в лог; LOG_MESSAGES=true включает их (F007)", async () => {
  await withApp({}, async ({ tg, or, app }) => {
    or.chat = () => reply("ответ-из-модели-XYZ");
    tg.message({ chatId: 5007, text: "секретная-фраза-пользователя-123" });
    await tg.waitFor(() => tg.texts().length >= 1, 8000, "ответ");
    await tg.quiet(300);

    assert.ok(!app.output().includes("секретная-фраза-пользователя-123"));
    assert.ok(!app.output().includes("ответ-из-модели-XYZ"));
  });

  await withApp({ env: { LOG_MESSAGES: "true" } }, async ({ tg, or, app }) => {
    or.chat = () => reply("ответ-из-модели-XYZ");
    tg.message({ chatId: 5008, text: "фраза-для-отладки-456" });
    await tg.waitFor(() => tg.texts().length >= 1, 8000, "ответ");

    assert.match(app.output(), /\[in\].*фраза-для-отладки-456/);
    assert.match(app.output(), /\[out\].*ответ-из-модели-XYZ/);
  });
});

test("ключ OpenRouter не светится в логе при ошибке запроса и при сбое STT (F007)", async () => {
  await withApp({}, async ({ tg, or, app }) => {
    tg.addFile("v-leak", "voice/leak.oga", Buffer.alloc(2000, 5));
    or.stt = () => failure(401, "invalid key");
    tg.message({ chatId: 5009, voice: { file_id: "v-leak", file_unique_id: "v", duration: 1, mime_type: "audio/ogg", file_size: 2000 } });
    await tg.waitFor(() => tg.texts().length >= 1, 8000, "ответ об ошибке");
    await tg.quiet(300);

    assert.ok(!app.output().includes(TEST_OPENROUTER_KEY));
    assert.ok(!app.output().includes(TOKEN_SECRET_PART));
    assert.match(app.output(), /Audio transcription error/);
  });
});

test("порт занят: понятная ошибка и ненулевой код выхода, без лживого «started» (F019)", async () => {
  const tgA = await new FakeTelegram().start();
  const tgB = await new FakeTelegram().start();
  const or = await new FakeOpenRouter().start();
  const first = await launchApp({ tg: tgA, or });

  try {
    await waitReady(tgA, first);

    const second = await launchApp({ tg: tgB, or, port: first.port });

    try {
      const exit = await second.waitForExit(10000);

      assert.ok(exit, `второй экземпляр должен завершиться: ${second.output().slice(-300)}`);
      assert.notEqual(exit.code, 0);
      assert.match(second.output(), /Web server could not start/);
      assert.match(second.output(), /EADDRINUSE/);
      assert.doesNotMatch(second.output(), /Web server started/);
    } finally {
      await second.stop();
    }
  } finally {
    await first.stop();
    await tgA.stop();
    await tgB.stop();
    await or.stop();
  }
});

test("SIGTERM: код 143, память сброшена на диск, опрос Telegram остановлен (F031)", async () => {
  await withApp({ env: { MEMORY_SAVE_DEBOUNCE_MS: "60000" } }, async ({ tg, or, app }) => {
    or.chat = () => reply("сохрани меня при остановке");
    tg.message({ chatId: 5010, text: "запомни" });
    await tg.waitFor(() => tg.texts().length >= 1, 8000, "ответ");
    assert.equal(fs.existsSync(app.memoryFile), false, "дебаунс ещё не сработал");

    const started = Date.now();
    app.child.kill("SIGTERM");
    const exit = await app.waitForExit(10000);

    assert.ok(exit, "процесс не завершился");
    assert.equal(exit.code, 143);
    assert.ok(Date.now() - started < 5000, "остановка должна быть быстрой, а не ждать длинный опрос");
    assert.deepEqual(
      JSON.parse(fs.readFileSync(app.memoryFile, "utf8"))["5010"].messages.map((message) => message.content),
      ["запомни", "сохрани меня при остановке"]
    );

    const polls = tg.pollCount();
    await tg.quiet(1200);
    assert.equal(tg.pollCount(), polls, "опрос должен быть остановлен");
  });
});

test("SIGTERM во время обработки: ответ ещё успевает уйти (F031)", async () => {
  await withApp({}, async ({ tg, or, app }) => {
    or.chat = () => ({ ...reply("успел ответить"), delayMs: 600 });
    tg.message({ chatId: 5011, text: "долгий вопрос" });
    await tg.waitFor(() => or.chatRequests().length >= 1, 8000, "запрос ушёл");
    app.child.kill("SIGTERM");
    await app.waitForExit(10000);

    assert.deepEqual(tg.texts(), ["успел ответить"]);
  });
});

test("заглушки из .env.example: бот отказывается стартовать и объясняет почему (F008)", async () => {
  const tg = await new FakeTelegram().start();
  const app = await launchApp({
    tg,
    env: {
      BOT_TOKEN: "process.env.BOT_TOKEN",
      OPENROUTER_API_KEY: "process.env.OPENROUTER_API_KEY",
      OPENROUTER_MODEL: "process.env.OPENROUTER_MODEL"
    }
  });

  try {
    const exit = await app.waitForExit(8000);

    assert.ok(exit, "процесс должен завершиться");
    assert.equal(exit.code, 1);
    assert.match(app.output(), /Некорректная конфигурация/);
    assert.match(app.output(), /BOT_TOKEN содержит заглушку/);
    assert.match(app.output(), /OPENROUTER_API_KEY содержит заглушку/);
    assert.equal(tg.pollCount(), 0, "опрос Telegram не должен начинаться");
    assert.doesNotMatch(app.output(), /at .*\.js:\d+/, "никаких стеков для обычной ошибки настройки");
  } finally {
    await app.stop();
    await tg.stop();
  }
});

test("MAX_AUDIO_BYTES=8MB понимается и показывается в справке (F022)", async () => {
  await withApp({ env: { MAX_AUDIO_BYTES: "8MB" } }, async ({ tg }) => {
    tg.message({ chatId: 5012, text: "/voice" });
    await tg.waitFor(() => tg.texts().length >= 1, 8000, "справка");

    assert.match(tg.texts()[0], /Лимит файла: 8 MB/);
  });
});

test("GET /health публично отдаёт только ok и uptime (F006)", async () => {
  await withApp({
    env: {
      ACCOUNT_ASSISTANT_ALLOW_CHATS: "@alice_friend,777000111",
      ACCOUNT_ASSISTANT_BLOCK_CHATS: "@spam_account,999000222",
      ACCOUNT_ASSISTANT_OWNER_CHAT_ID: "555",
      BOT_TO_BOT_CHAT_ID: "-1001234567890",
      BOT_TO_BOT_TARGET_BOT_USERNAME: "peer_test_bot"
    }
  }, async ({ app }) => {
    const root = await app.http("/");
    const health = await app.http("/health");
    const body = JSON.parse(health.text);

    assert.equal(root.text, "Bot is alive");
    assert.equal(health.status, 200);
    assert.deepEqual(Object.keys(body).sort(), ["ok", "uptimeSec"]);
    assert.equal(body.ok, true);

    for (const secret of ["alice_friend", "777000111", "spam_account", "999000222", "1001234567890", "peer_test_bot", "gpt-4o"]) {
      assert.ok(!health.text.includes(secret), `публичный /health раскрывает ${secret}`);
    }
  });
});

test("/health/details: выключен без HEALTH_TOKEN, закрыт токеном и без списков контактов (F006)", async () => {
  await withApp({}, async ({ app }) => {
    assert.equal((await app.http("/health/details")).status, 404);
  });

  await withApp({
    env: {
      HEALTH_TOKEN: "s3cret-health-token",
      ACCOUNT_ASSISTANT_ALLOW_CHATS: "@alice_friend,777000111",
      ACCOUNT_ASSISTANT_BLOCK_CHATS: "@spam_account"
    }
  }, async ({ app }) => {
    assert.equal((await app.http("/health/details")).status, 401);
    assert.equal((await app.http("/health/details", { "x-health-token": "wrong" })).status, 401);

    const ok = await app.http("/health/details", { authorization: "Bearer s3cret-health-token" });
    const body = JSON.parse(ok.text);

    assert.equal(ok.status, 200);
    assert.equal(body.model, "openai/gpt-4o-mini");
    assert.equal(body.accountAssistant.allowListSize, 2);
    assert.equal(body.accountAssistant.blockListSize, 1);
    assert.ok(!ok.text.includes("alice_friend"));
    assert.ok(!ok.text.includes("777000111"));
    assert.ok(!ok.text.includes("spam_account"));
    assert.equal((await app.http("/health/details", { "x-health-token": "s3cret-health-token" })).status, 200);
  });
});

test("повреждённый memory.json не затирается: уходит в .corrupt-*, бот стартует (F031)", async () => {
  const tg = await new FakeTelegram().start();
  const or = await new FakeOpenRouter().start();
  const app = await launchApp({ tg, or });

  try {
    await waitReady(tg, app);
    await app.stop();

    fs.writeFileSync(app.memoryFile, "{ обрыв", "utf8");

    const second = await launchApp({ tg, or, env: { MEMORY_FILE: app.memoryFile } });

    try {
      await waitFor(() => tg.pollCount() > 1, 8000, "второй запуск");
      const names = fs.readdirSync(app.tmp).filter((name) => name.includes(".corrupt-"));

      assert.equal(names.length, 1);
      assert.equal(fs.readFileSync(`${app.tmp}/${names[0]}`, "utf8"), "{ обрыв");
    } finally {
      await second.stop();
    }
  } finally {
    await app.stop();
    await tg.stop();
    await or.stop();
  }
});

test("getMe не ответил при старте: личность бота подтягивается повторной попыткой, чужие команды отсекаются", async () => {
  const healthToken = "details-token-for-test";

  await withApp({
    env: { HEALTH_TOKEN: healthToken },
    setup: ({ tg }) => tg.failNext("getMe", 500, "Internal Server Error", 1)
  }, async ({ tg, or, app }) => {
    or.chat = () => reply("ок");

    const identityLoaded = async () => {
      const response = await app.http("/health/details", { authorization: `Bearer ${healthToken}` });

      return JSON.parse(response.text).botToBot?.identityLoaded === true;
    };

    await waitFor(identityLoaded, 15000, "личность бота после повторного getMe");

    assert.equal(tg.calls.filter((call) => call.method === "getMe").length, 2, "один сбой и одна успешная повторная попытка");
    assert.match(app.output(), /Telegram getMe error \(попытка 1 из 8\)/);

    tg.message({ chatId: 5101, text: "/help@some_other_bot" });
    tg.message({ chatId: 5102, text: "/help@test_audit_bot" });
    await tg.waitFor(() => tg.texts().some((text) => text.startsWith("Команды:")), 8000, "ответ на свою команду");
    await tg.quiet(400);

    assert.equal(tg.texts().filter((text) => text.startsWith("Команды:")).length, 1, "команда чужому боту не выполнена");
  });
});
