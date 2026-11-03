process.env.LOG_LEVEL = "silent";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const util = require("util");
const { FakeOpenRouter, TEST_OPENROUTER_KEY, failure, reply } = require("../helpers/fakeOpenRouter");
const { FakeTelegram, TEST_BOT_TOKEN } = require("../helpers/fakeTelegram");
const { loadFresh } = require("../helpers/freshModules");

const TOKEN_SECRET = TEST_BOT_TOKEN.split(":")[1];
const PRIVATE_TEXT = "МОЁ-ЛИЧНОЕ-СООБЩЕНИЕ-КОТОРОЕ-НЕЛЬЗЯ-ЛОГИРОВАТЬ";

// What any logger (ours, gramjs's console.error, Node's unhandled-rejection dump) would print for the error.
const dump = (error) => util.inspect(error, { depth: 25, showHidden: true });

async function withOpenRouter(fn) {
  const or = await new FakeOpenRouter().start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aibot-svc-"));
  const openrouter = loadFresh("services/openrouter", {
    OPENROUTER_BASE_URL: or.baseUrl,
    OPENROUTER_API_KEY: TEST_OPENROUTER_KEY,
    MEMORY_FILE: path.join(dir, "memory.json"),
    MEMORY_SAVE_DEBOUNCE_MS: "60000",
    LOG_LEVEL: "silent"
  });

  try {
    return await fn({ or, openrouter });
  } finally {
    await or.stop();
  }
}

test("ошибка запроса к OpenRouter не несёт ключа, заголовков и текста диалога ни в каком виде (F007)", async () => {
  await withOpenRouter(async ({ or, openrouter }) => {
    or.chat = () => failure(401, "invalid key");

    const error = await openrouter.requestAICompletion([{ role: "user", content: PRIVATE_TEXT }]).catch((caught) => caught);

    assert.equal(error.name, "ApiError");
    assert.equal(error.status, 401);
    assert.equal(error.config, undefined);
    assert.equal(error.request, undefined);
    assert.equal(error.response, undefined);
    assert.ok(!dump(error).includes(TEST_OPENROUTER_KEY), "ключ OpenRouter в дампе ошибки");
    assert.ok(!dump(error).includes("Bearer"));
    assert.ok(!dump(error).includes(PRIVATE_TEXT), "текст диалога в дампе ошибки");
    assert.match(error.message, /invalid key/);
  });
});

test("временная ошибка повторяется один раз, постоянная - ни разу", async () => {
  await withOpenRouter(async ({ or, openrouter }) => {
    let calls = 0;

    or.chat = () => (++calls === 1 ? failure(503, "busy") : reply("получилось"));
    assert.equal(await openrouter.requestAICompletion([{ role: "user", content: "привет" }]), "получилось");
    assert.equal(or.chatRequests().length, 2);

    or.requests.length = 0;
    or.chat = () => failure(503, "still busy");
    await assert.rejects(openrouter.requestAICompletion([{ role: "user", content: "привет" }]), /still busy/);
    assert.equal(or.chatRequests().length, 2, "ровно один повтор");

    or.requests.length = 0;
    or.chat = () => failure(400, "bad request");
    await assert.rejects(openrouter.requestAICompletion([{ role: "user", content: "привет" }]), /bad request/);
    assert.equal(or.chatRequests().length, 1, "400 не лечится повтором");
  });
});

test("содержимое ответа-массива и пустое содержимое обрабатываются", async () => {
  await withOpenRouter(async ({ or, openrouter }) => {
    or.chat = () => ({ status: 200, body: { choices: [{ message: { content: [{ type: "text", text: "часть один, " }, { type: "text", text: "часть два" }] } }] } });
    assert.equal(await openrouter.requestAICompletion([{ role: "user", content: "x" }]), "часть один, часть два");

    or.chat = () => ({ status: 200, body: { choices: [{ message: { content: null } }] } });
    assert.equal(await openrouter.requestAICompletion([{ role: "user", content: "x" }]), "");

    or.chat = () => ({ status: 200, body: {} });
    assert.equal(await openrouter.requestAICompletion([{ role: "user", content: "x" }]), "");
  });
});

test("ошибки расшифровки голоса не содержат ключа и текста; список по моделям сохранён (F007)", async () => {
  await withOpenRouter(async ({ or, openrouter }) => {
    or.stt = () => failure(404, "no such model");
    or.chat = () => failure(404, "no such model");

    const error = await openrouter.transcribeAudio(Buffer.from("аудио"), "ogg").catch((caught) => caught);

    assert.equal(error.transcriptionErrors.length, 5, "4 STT-модели и chat-fallback");
    assert.ok(!dump(error).includes(TEST_OPENROUTER_KEY));
    assert.ok(!JSON.stringify(error.transcriptionErrors).includes(TEST_OPENROUTER_KEY));
  });
});

test("парсер черновиков ассистента: JSON, JSON в блоке кода и простой текст", () => {
  const { parseAccountAssistantDraft } = loadFresh("services/openrouter", {
    OPENROUTER_API_KEY: TEST_OPENROUTER_KEY,
    MEMORY_FILE: path.join(os.tmpdir(), "aibot-parse.json"),
    LOG_LEVEL: "silent"
  });

  assert.deepEqual(parseAccountAssistantDraft('{"reply":"ок","sendable":true,"reason":"r"}'), { reply: "ок", sendable: true, reason: "r" });
  assert.deepEqual(parseAccountAssistantDraft('```json\n{"reply":"ок","sendable":"true"}\n```'), { reply: "ок", sendable: true, reason: "model returned structured draft" });
  assert.equal(parseAccountAssistantDraft('{"reply":"","sendable":true}').sendable, false, "пустой ответ не может быть sendable");
  assert.deepEqual(parseAccountAssistantDraft("просто текст"), { reply: "просто текст", sendable: false, reason: "model returned plain text, owner approval required" });
  assert.equal(parseAccountAssistantDraft("{ сломанный json").sendable, false);
});

test("разбор черновика не зависает на огромной пробельной серии в ответе модели", () => {
  const { parseAccountAssistantDraft } = loadFresh("services/openrouter", {
    OPENROUTER_API_KEY: TEST_OPENROUTER_KEY,
    MEMORY_FILE: path.join(os.tmpdir(), "aibot-parse-big.json"),
    LOG_LEVEL: "silent"
  });
  const started = Date.now();

  assert.equal(parseAccountAssistantDraft(" ".repeat(1_000_000)).reply, "");
  assert.equal(parseAccountAssistantDraft(`слово${" ".repeat(1_000_000)}ещё`).sendable, false);
  assert.ok(Date.now() - started < 3000, `разбор занял ${Date.now() - started} мс`);
});

test("ошибки скачивания файла не содержат токена бота (адрес файла его включает) (F007)", async () => {
  const tg = await new FakeTelegram().start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aibot-svc-"));
  const telegram = loadFresh("services/telegram", {
    BOT_TOKEN: tg.token,
    TELEGRAM_API_BASE_URL: tg.url,
    OPENROUTER_API_KEY: TEST_OPENROUTER_KEY,
    MEMORY_FILE: path.join(dir, "memory.json"),
    MEMORY_SAVE_DEBOUNCE_MS: "60000",
    LOG_LEVEL: "silent"
  });
  const bot = telegram.createTelegramBot();

  try {
    tg.addFile("known", "voice/known.oga", Buffer.from("данные"));

    const unknownFile = await telegram.downloadTelegramFile("no-such-file").catch((caught) => caught);
    assert.ok(unknownFile instanceof Error);
    assert.ok(!dump(unknownFile).includes(TOKEN_SECRET), "токен в ошибке getFile");

    tg.failNext("FILE_DOWNLOAD", 404, "not found");
    const failedDownload = await telegram.downloadTelegramFile("known").catch((caught) => caught);
    assert.ok(failedDownload instanceof Error);
    assert.equal(failedDownload.name, "ApiError");
    assert.ok(!dump(failedDownload).includes(TOKEN_SECRET), "токен в ошибке скачивания");
    assert.equal(failedDownload.config, undefined);

    tg.clearFail("FILE_DOWNLOAD");
    assert.equal((await telegram.downloadTelegramFile("known")).toString(), "данные");

    const tooBig = await telegram.downloadTelegramFile("known", { maxBytes: 3, fileLabel: "Audio" }).catch((caught) => caught);
    assert.equal(telegram.isFileTooLargeError(tooBig), true);
    assert.match(tooBig.message, /Audio file is too large/);
  } finally {
    await telegram.stopTelegramPolling(bot);
    await tg.stop();
  }
});

test("разбиение ответа: части уходят по порядку, к первой привязан reply, упоминание бота только в первой", async () => {
  const tg = await new FakeTelegram().start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aibot-svc-"));
  const telegram = loadFresh("services/telegram", {
    BOT_TOKEN: tg.token,
    TELEGRAM_API_BASE_URL: tg.url,
    OPENROUTER_API_KEY: TEST_OPENROUTER_KEY,
    MEMORY_FILE: path.join(dir, "memory.json"),
    MEMORY_SAVE_DEBOUNCE_MS: "60000",
    MAX_REPLY_PARTS: "10",
    LOG_LEVEL: "silent"
  });
  const bot = telegram.createTelegramBot();

  try {
    const long = Array.from({ length: 300 }, (_, i) => `строка ${i} ответа`).join("\n");

    await telegram.sendAIResponse(777, long, { replyToMessageId: 41, targetUsername: "peer_test_bot", sourceMessageId: 41 });

    const sent = tg.sent();

    assert.ok(sent.length >= 2);
    assert.ok(sent[0].text.startsWith("@peer_test_bot строка 0 ответа"));
    assert.equal(Number(sent[0].reply_to_message_id), 41);
    assert.ok(sent.slice(1).every((params) => !params.reply_to_message_id && !params.text.startsWith("@peer_test_bot")));

    await telegram.sendAIResponse(777, "второй раз тот же исходный id", { sourceMessageId: 41 });
    assert.equal(tg.sent().length, sent.length, "на одно входящее сообщение отвечаем один раз");
  } finally {
    await telegram.stopTelegramPolling(bot);
    await tg.stop();
  }
});

test("остановка опроса настоящая: после неё нет новых getUpdates и сообщения не обрабатываются (F031)", async () => {
  const tg = await new FakeTelegram().start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aibot-svc-"));
  const telegram = loadFresh("services/telegram", {
    BOT_TOKEN: tg.token,
    TELEGRAM_API_BASE_URL: tg.url,
    OPENROUTER_API_KEY: TEST_OPENROUTER_KEY,
    MEMORY_FILE: path.join(dir, "memory.json"),
    MEMORY_SAVE_DEBOUNCE_MS: "60000",
    LOG_LEVEL: "silent"
  });
  const bot = telegram.createTelegramBot();
  const seen = [];

  bot.on("message", (msg) => seen.push(msg.text));

  try {
    await tg.waitFor(() => tg.pollCount() >= 2, 5000, "начало опроса");

    const started = Date.now();

    await telegram.stopTelegramPolling(bot);

    const stopMs = Date.now() - started;
    const pollsAtStop = tg.pollCount();

    assert.ok(stopMs < 300, `остановка заняла ${stopMs} мс`);
    assert.equal(bot.isPolling(), false);

    tg.message({ chatId: 4242, text: "после остановки" });
    await tg.quiet(1500);

    assert.equal(tg.pollCount(), pollsAtStop, "опрос продолжился после остановки");
    assert.deepEqual(seen, [], "сообщение после остановки не должно дойти до обработчика");
  } finally {
    await tg.stop();
  }
});

test("уведомление об обрезке не разрезает эмодзи на границе (ревью Codex, P2)", async () => {
  const tg = await new FakeTelegram().start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aibot-svc-"));
  const telegram = loadFresh("services/telegram", {
    BOT_TOKEN: tg.token,
    TELEGRAM_API_BASE_URL: tg.url,
    OPENROUTER_API_KEY: TEST_OPENROUTER_KEY,
    MEMORY_FILE: path.join(dir, "memory.json"),
    MEMORY_SAVE_DEBOUNCE_MS: "60000",
    MAX_REPLY_PARTS: "1",
    LOG_LEVEL: "silent"
  });
  const bot = telegram.createTelegramBot();
  const notice = "\n\n[ответ слишком длинный, остаток отброшен]";
  const handedToLibrary = [];

  // Проверяем то, что код отдаёт библиотеке: по дороге через HTTP кодировщик форм сам "чинит" одинокий суррогат,
  // и на стороне сервера нарушение уже не видно.
  bot.sendMessage = async (chatId, text) => {
    handedToLibrary.push(text);
    return { message_id: 1 };
  };

  try {
    // эмодзи занимает позиции L-1 и L, где L - место, на котором ставится уведомление
    const boundary = 4096 - notice.length;
    const reply = `${"а".repeat(boundary - 1)}${String.fromCodePoint(0x1f600)}${"б".repeat(6000)}`;

    await telegram.sendAIResponse(778, reply);

    assert.equal(handedToLibrary.length, 1);
    assert.ok(handedToLibrary[0].endsWith(notice.trim()));
    assert.ok(handedToLibrary[0].isWellFormed(), "в тексте осталась половина эмодзи");
    assert.ok(handedToLibrary[0].length <= 4096);
  } finally {
    await telegram.stopTelegramPolling(bot);
    await tg.stop();
  }
});
