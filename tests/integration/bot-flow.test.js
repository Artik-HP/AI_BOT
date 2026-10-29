const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { withApp } = require("../helpers/app");
const { failure, reply, TEST_OPENROUTER_KEY } = require("../helpers/fakeOpenRouter");
const { waitFor } = require("../helpers/freshModules");

const stripSpace = (text) => text.replace(/\s+/g, "");
const VOICE = (fileId, size = 5000) => ({ file_id: fileId, file_unique_id: fileId, duration: 2, mime_type: "audio/ogg", file_size: size });

test("текст -> ответ ИИ: ключ в заголовке, один запрос, ограничение длины генерации (F010)", async () => {
  await withApp({}, async ({ tg, or }) => {
    or.chat = () => reply("Привет! Всё норм.");
    tg.message({ chatId: 4001, text: "привет, как дела" });
    await tg.waitFor(() => tg.sent().length >= 1, 8000, "ответ");

    assert.equal(tg.texts()[0], "Привет! Всё норм.");
    assert.equal(or.chatRequests().length, 1);

    const request = or.chatRequests()[0];

    assert.equal(request.headers.authorization, `Bearer ${TEST_OPENROUTER_KEY}`);
    assert.equal(request.body.model, "openai/gpt-4o-mini");
    assert.equal(request.body.max_tokens, 1500);
  });
});

test("в модель уходит промпт с запретом опасных инструкций (F005)", async () => {
  await withApp({}, async ({ tg, or }) => {
    tg.message({ chatId: 4002, text: "расскажи про дофамин" });
    await tg.waitFor(() => or.chatRequests().length >= 1, 8000, "запрос к модели");

    const system = or.chatRequests()[0].body.messages[0].content;

    assert.match(system, /Не давай пошаговые инструкции по изготовлению веществ/);
    assert.doesNotMatch(system, /Должен давай/);
    assert.doesNotMatch(system, /выманить деньги/);
  });
});

test("длинный ответ в 33 тысячи символов приходит целиком несколькими сообщениями (F009, было: потеряно 88%)", async () => {
  await withApp({ env: { MAX_REPLY_PARTS: "20" } }, async ({ tg, or }) => {
    const long = Array.from({ length: 700 }, (_, i) => `строка номер ${String(i).padStart(4, "0")} — содержательный текст ответа`).join("\n");

    or.chat = () => reply(long);
    tg.message({ chatId: 4003, text: "дай длинный ответ" });
    await tg.waitFor(() => stripSpace(tg.texts().join("")).length >= stripSpace(long).length, 10000, "все части");

    assert.ok(long.length > 33000);
    assert.ok(tg.texts().length >= 9);
    assert.ok(tg.texts().every((text) => text.length <= 4096));
    assert.equal(stripSpace(tg.texts().join("")), stripSpace(long));
    assert.match(tg.texts().at(-1), /строка номер 0699/);
  });
});

test("сверхдлинный ответ ограничен MAX_REPLY_PARTS и честно помечен (F009)", async () => {
  await withApp({}, async ({ tg, or }) => {
    or.chat = () => reply(Array.from({ length: 2400 }, (_, i) => `строка ${i} с обычным текстом ответа`).join("\n"));
    tg.message({ chatId: 4004, text: "очень длинно" });
    await tg.waitFor(() => tg.texts().length >= 6, 10000, "шесть частей");
    await tg.quiet(500);

    assert.equal(tg.texts().length, 6);
    assert.match(tg.texts().at(-1), /ответ слишком длинный, остаток отброшен/);
    assert.ok(tg.texts().every((text) => text.length <= 4096));
  });
});

test("эмодзи на границе среза не портится (было: 😀 превращался в 🐀) (F009)", async () => {
  await withApp({}, async ({ tg, or }) => {
    or.chat = () => reply("a".repeat(4095) + "😀😀😀");
    tg.message({ chatId: 4005, text: "эмодзи" });
    await tg.waitFor(() => tg.texts().length >= 2, 8000, "две части");

    assert.equal(tg.texts().join(""), "a".repeat(4095) + "😀😀😀");
    assert.ok(!tg.texts().join("").includes(String.fromCodePoint(0x1f400)));
    assert.ok(tg.texts().every((text) => text.isWellFormed()));
  });
});

test("два одинаковых короткых ответа подряд доставляются оба, без лишних запросов (F017)", async () => {
  await withApp({}, async ({ tg, or }) => {
    or.chat = () => reply("ок, понял");
    tg.message({ chatId: 4006, text: "первое" });
    await tg.waitFor(() => tg.texts().length >= 1, 8000, "первый ответ");
    tg.message({ chatId: 4006, text: "второе, другое сообщение" });
    await tg.waitFor(() => tg.texts().length >= 2, 8000, "второй ответ");

    assert.deepEqual(tg.texts(), ["ок, понял", "ок, понял"]);
    assert.equal(or.chatRequests().length, 2, "было: 1 + 3 вызова, ответ терялся");
  });
});

test("модель повторила длинный ответ: один повтор запроса и ответ всё равно доставлен (F017)", async () => {
  await withApp({}, async ({ tg, or }) => {
    const answer = "Это длинный осмысленный ответ, который модель зачем-то повторяет слово в слово.";

    or.chat = () => reply(answer);
    tg.message({ chatId: 4007, text: "вопрос один" });
    await tg.waitFor(() => tg.texts().length >= 1, 8000, "первый ответ");
    tg.message({ chatId: 4007, text: "вопрос два" });
    await tg.waitFor(() => tg.texts().length >= 2, 8000, "второй ответ");

    assert.deepEqual(tg.texts(), [answer, answer]);
    assert.equal(or.chatRequests().length, 3, "1 + (запрос + один повтор), а не 1 + 3");
  });
});

test("сбой ИИ: пользователь получает нейтральный текст без имён переменных (F041)", async () => {
  await withApp({}, async ({ tg, or, app }) => {
    or.chat = () => failure(500, "upstream down");
    tg.message({ chatId: 4008, text: "привет" });
    await tg.waitFor(() => tg.texts().length >= 1, 10000, "сообщение об ошибке");

    assert.match(tg.texts()[0], /Не получилось получить ответ от ИИ/);
    assert.doesNotMatch(tg.texts()[0], /OPENROUTER|\.env|API_KEY/);
    assert.equal(or.chatRequests().length, 2, "временная ошибка 5xx: один повтор");
    assert.match(app.output(), /AI error:.*upstream down/);
  });
});

test("429 от провайдера: запрос повторяется и ответ приходит (модернизация)", async () => {
  await withApp({}, async ({ tg, or }) => {
    let calls = 0;

    or.chat = () => {
      calls += 1;
      return calls === 1 ? { status: 429, headers: { "retry-after": "0" }, body: { error: { message: "slow down" } } } : reply("со второго раза");
    };
    tg.message({ chatId: 4009, text: "привет" });
    await tg.waitFor(() => tg.texts().length >= 1, 10000, "ответ после повтора");

    assert.equal(tg.texts()[0], "со второго раза");
    assert.equal(or.chatRequests().length, 2);
  });
});

test("HTTP 200 с телом {error} - это ошибка, а не «пустой ответ» (F041)", async () => {
  await withApp({}, async ({ tg, or, app }) => {
    or.chat = () => ({ status: 200, body: { error: { message: "Provider returned error", code: 502 } } });
    tg.message({ chatId: 4010, text: "привет" });
    await tg.waitFor(() => tg.texts().length >= 1, 10000, "сообщение об ошибке");

    assert.match(app.output(), /Provider returned error/);
    assert.doesNotMatch(app.output(), /пустой ответ/);
  });
});

test("память пишется на диск отложенно и содержит диалог", async () => {
  await withApp({}, async ({ tg, or, app }) => {
    or.chat = () => reply("сохрани меня");
    tg.message({ chatId: 4011, text: "запомни это" });
    await tg.waitFor(() => tg.texts().length >= 1, 8000, "ответ");
    // Authentication may create the file before the debounced dialogue save finishes.
    await waitFor(() => {
      if (!fs.existsSync(app.memoryFile)) return false;
      const memory = JSON.parse(fs.readFileSync(app.memoryFile, "utf8"));
      return memory["4011"]?.messages?.length === 2;
    }, 4000, "сохранённый диалог в memory.json");

    const stored = JSON.parse(fs.readFileSync(app.memoryFile, "utf8"));

    assert.deepEqual(stored["4011"].messages.map((message) => message.content), ["запомни это", "сохрани меня"]);
  });
});

test("голос -> текст -> ответ: расшифровка доходит до модели", async () => {
  await withApp({}, async ({ tg, or }) => {
    tg.addFile("v-ok", "voice/ok.oga", Buffer.alloc(5000, 1));
    or.stt = () => ({ status: 200, body: { text: "расскажи про нейрохимию" } });
    or.chat = () => reply("Дофамин, серотонин и вся компания.");
    tg.message({ chatId: 4012, voice: VOICE("v-ok") });
    await tg.waitFor(() => tg.texts().length >= 1, 10000, "ответ на голос");

    assert.equal(tg.texts()[0], "Дофамин, серотонин и вся компания.");
    const lastUser = or.chatRequests()[0].body.messages.at(-1).content;

    assert.match(lastUser, /расскажи про нейрохимию/);
  });
});

test("голос: ошибка авторизации не размножается на 5 запросов с полным аудио (F021)", async () => {
  await withApp({}, async ({ tg, or }) => {
    tg.addFile("v-401", "voice/401.oga", Buffer.alloc(200000, 7));
    or.stt = () => failure(401, "invalid api key");
    or.chat = () => failure(401, "invalid api key");
    tg.message({ chatId: 4013, voice: VOICE("v-401", 200000) });
    await tg.waitFor(() => tg.texts().length >= 1, 10000, "сообщение об ошибке");

    assert.equal(or.sttRequests().length, 1, "было: 4 STT-запроса + 1 chat");
    assert.equal(or.chatRequests().length, 0);
    assert.match(tg.texts()[0], /Не получилось обработать голосовое/);
    assert.doesNotMatch(tg.texts()[0], /OPENROUTER/);
  });
});

test("голос: модель не найдена (404) - пробуется следующая, ответ приходит", async () => {
  await withApp({}, async ({ tg, or }) => {
    tg.addFile("v-404", "voice/404.oga", Buffer.alloc(3000, 3));
    or.stt = (request) => request.body.model === "openai/whisper-large-v3-turbo"
      ? failure(404, "no such model")
      : { status: 200, body: { text: "со второй модели" } };
    or.chat = () => reply("принято");
    tg.message({ chatId: 4014, voice: VOICE("v-404", 3000) });
    await tg.waitFor(() => tg.texts().length >= 1, 10000, "ответ");

    assert.equal(or.sttRequests().length, 2);
    assert.match(or.chatRequests()[0].body.messages.at(-1).content, /со второй модели/);
  });
});

test("голос больше лимита отклоняется до скачивания и расшифровки (F022)", async () => {
  await withApp({ env: { MAX_AUDIO_BYTES: "1MB" } }, async ({ tg, or }) => {
    tg.message({ chatId: 4015, voice: VOICE("v-big", 5 * 1024 * 1024) });
    await tg.waitFor(() => tg.texts().length >= 1, 8000, "отказ");

    assert.match(tg.texts()[0], /Файл слишком большой\. Лимит: 1 МБ/);
    assert.equal(tg.sent("getFile").length, 0);
    assert.equal(or.requests.length, 0);
  });
});

test("фото: берётся самый большой размер, картинка уходит в модель data-URL'ом", async () => {
  await withApp({}, async ({ tg, or }) => {
    tg.addFile("p-3", "photos/p3.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    or.chat = () => reply("Вижу кота.");
    tg.message({
      chatId: 4016,
      caption: "что тут?",
      photo: [
        { file_id: "p-1", file_unique_id: "a", width: 90, height: 90, file_size: 100 },
        { file_id: "p-3", file_unique_id: "c", width: 1280, height: 960, file_size: 900 }
      ]
    });
    await tg.waitFor(() => tg.texts().length >= 1, 10000, "ответ на фото");

    const parts = or.chatRequests()[0].body.messages.at(-1).content;
    const image = parts.find((part) => part.type === "image_url");

    assert.equal(tg.texts()[0], "Вижу кота.");
    assert.deepEqual(tg.sent("getFile").map((params) => params.file_id), ["p-3"]);
    assert.match(image.image_url.url, /^data:image\/jpeg;base64,/);
    assert.equal(or.chatRequests()[0].body.model, "openai/gpt-4o-mini");
  });
});

test("фото в неподдерживаемом формате (HEIC): понятный ответ вместо молчания (F029)", async () => {
  await withApp({}, async ({ tg, or }) => {
    tg.message({ chatId: 4017, document: { file_id: "h-1", file_unique_id: "h", file_name: "photo.heic", mime_type: "image/heic", file_size: 10 } });
    await tg.waitFor(() => tg.texts().length >= 1, 8000, "ответ про формат");

    assert.match(tg.texts()[0], /формат изображения не поддерживается/);
    assert.equal(or.requests.length, 0);
  });
});

test("слишком большое изображение отклоняется без скачивания (F022)", async () => {
  await withApp({}, async ({ tg, or }) => {
    tg.message({ chatId: 4018, photo: [{ file_id: "p-huge", file_unique_id: "x", width: 9000, height: 9000, file_size: 30 * 1024 * 1024 }] });
    await tg.waitFor(() => tg.texts().length >= 1, 8000, "отказ");

    assert.match(tg.texts()[0], /Изображение слишком большое\. Лимит: 10 МБ/);
    assert.equal(tg.sent("getFile").length, 0);
    assert.equal(or.requests.length, 0);
  });
});
