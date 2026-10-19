const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { withApp } = require("../helpers/app");
const { failure, reply } = require("../helpers/fakeOpenRouter");

const MB = 1024 * 1024;
const voice = (fileId, size) => ({ file_id: fileId, file_unique_id: fileId, duration: 5, mime_type: "audio/ogg", ...(size === undefined ? {} : { file_size: size }) });

// Peak resident memory of the bot process (Linux only; null elsewhere).
function peakRssMb(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    return Math.round(Number(status.match(/VmHWM:\s+(\d+) kB/)[1]) / 1024);
  } catch {
    return null;
  }
}

let rawMessageSeq = 90000;

function rawMessage(tg, message) {
  tg.enqueue({ message: { message_id: ++rawMessageSeq, date: Math.floor(Date.now() / 1000), ...message } });
}

test("голос 18 МБ проходит весь путь: скачивание, base64, расшифровка, ответ; память в разумных пределах", async () => {
  await withApp({}, async ({ tg, or, app }) => {
    tg.addFile("v-18", "voice/big.oga", Buffer.alloc(18 * MB, 9));
    or.stt = () => ({ status: 200, body: { text: "длинная запись на восемнадцать мегабайт" } });
    or.chat = () => reply("прослушала целиком");
    tg.message({ chatId: 8001, voice: voice("v-18", 18 * MB) });
    await tg.waitFor(() => tg.texts().length >= 1, 30000, "ответ на большое аудио");

    const sttBody = or.sttRequests()[0].body;
    const peak = peakRssMb(app.child.pid);

    assert.equal(tg.texts()[0], "прослушала целиком");
    assert.equal(Buffer.from(sttBody.input_audio.data, "base64").length, 18 * MB, "аудио дошло до STT без потерь");
    if (peak !== null) {
      assert.ok(peak < 700, `пик памяти ${peak} МБ слишком велик для файла 18 МБ`);
    }
  });
});

test("лимит соблюдается, даже если Telegram не прислал размер файла (проверка при скачивании)", async () => {
  await withApp({ env: { MAX_AUDIO_BYTES: String(MB) } }, async ({ tg, or, app }) => {
    tg.addFile("v-lie", "voice/lie.oga", Buffer.alloc(3 * MB, 1));
    tg.message({ chatId: 8002, voice: voice("v-lie") });
    await tg.waitFor(() => tg.texts().length >= 1, 15000, "отказ");

    assert.match(tg.texts()[0], /Файл слишком большой\. Лимит: 1 МБ/);
    assert.equal(or.requests.length, 0, "в OpenRouter ничего не ушло");
    assert.equal(app.exited(), null);
  });
});

test("лимит соблюдается, даже если размер в метаданных занижен", async () => {
  await withApp({ env: { MAX_AUDIO_BYTES: String(MB) } }, async ({ tg, or }) => {
    tg.addFile("v-lie2", "voice/lie2.oga", Buffer.alloc(3 * MB, 1));
    tg.message({ chatId: 8003, voice: voice("v-lie2", 1000) });
    await tg.waitFor(() => tg.texts().length >= 1, 15000, "отказ");

    assert.match(tg.texts()[0], /Файл слишком большой/);
    assert.equal(or.requests.length, 0);
  });
});

test("фото 9 МБ (почти лимит) уходит в модель и получает ответ", async () => {
  await withApp({}, async ({ tg, or, app }) => {
    tg.addFile("p-9", "photos/big.jpg", Buffer.alloc(9 * MB, 7));
    or.chat = () => reply("огромное фото разобрано");
    tg.message({ chatId: 8004, photo: [{ file_id: "p-9", file_unique_id: "p", width: 8000, height: 6000, file_size: 9 * MB }] });
    await tg.waitFor(() => tg.texts().length >= 1, 30000, "ответ на фото");

    const image = or.chatRequests()[0].body.messages.at(-1).content.find((part) => part.type === "image_url");
    const peak = peakRssMb(app.child.pid);

    assert.equal(tg.texts()[0], "огромное фото разобрано");
    assert.ok(image.image_url.url.length > 12 * MB);
    if (peak !== null) {
      assert.ok(peak < 700, `пик памяти ${peak} МБ слишком велик для фото 9 МБ`);
    }
  });
});

test("странные апдейты не роняют бота и не вызывают ответов; потом бот работает как обычно", async () => {
  await withApp({}, async ({ tg, or, app }) => {
    or.chat = () => reply("я жив");

    tg.enqueue({ edited_message: { message_id: 1, date: 1, chat: { id: 8010, type: "private" }, from: { id: 8010, is_bot: false, first_name: "A" }, text: "правка" } });
    tg.enqueue({ channel_post: { message_id: 2, date: 1, chat: { id: -100500, type: "channel", title: "канал" }, text: "пост" } });
    tg.enqueue({ inline_query: { id: "iq1", from: { id: 8010, is_bot: false, first_name: "A" }, query: "что-то", offset: "" } });
    tg.message({ chatId: 8010, text: "   " });
    tg.message({ chatId: 8010, text: "\n\n" });
    tg.message({ chatId: 8010, sticker: { file_id: "st", file_unique_id: "st", width: 1, height: 1, is_animated: false, is_video: false, type: "regular" } });
    tg.message({ chatId: 8010, location: { latitude: 1, longitude: 2 } });
    tg.message({ chatId: 8010, contact: { phone_number: "+1000000000", first_name: "Контакт" } });
    tg.message({ chatId: 8010, document: { file_id: "d-pdf", file_unique_id: "d", file_name: "doc.pdf", mime_type: "application/pdf", file_size: 100 } });
    tg.message({ chatId: 8010, text: "/" });
    tg.message({ chatId: 8010, text: "/@" });
    tg.message({ chatId: 8010, text: "/start@" });
    await tg.quiet(1500);

    assert.equal(app.exited(), null, `процесс упал: ${app.output().slice(-300)}`);
    assert.equal(or.requests.length, 0, "ни одно из странных сообщений не должно стоить запроса к ИИ");

    tg.message({ chatId: 8010, text: "а теперь нормальное сообщение" });
    await tg.waitFor(() => tg.texts().includes("я жив"), 8000, "нормальный ответ");
  });
});

test("сообщение без отправителя (анонимный админ) обрабатывается", async () => {
  await withApp({}, async ({ tg, or }) => {
    or.chat = () => reply("ответила анониму");
    rawMessage(tg, { chat: { id: -100999, type: "supergroup", title: "группа" }, text: "привет от анонимного админа" });
    await tg.waitFor(() => tg.texts().length >= 1, 8000, "ответ");

    assert.equal(tg.texts()[0], "ответила анониму");
  });
});

test("сообщение длиной 4096 символов (максимум Telegram) доходит до модели целиком", async () => {
  await withApp({}, async ({ tg, or }) => {
    const text = "слово ".repeat(682).trim().padEnd(4096, "я");

    or.chat = () => reply("прочитала всё");
    tg.message({ chatId: 8011, text });
    await tg.waitFor(() => tg.texts().length >= 1, 8000, "ответ");

    assert.equal(text.length, 4096);
    assert.ok(or.chatRequests()[0].body.messages.at(-1).content.endsWith(text.slice(-200)));
  });
});

test("пустой ответ модели не отправляется пустым сообщением и не роняет бота", async () => {
  await withApp({}, async ({ tg, or, app }) => {
    or.chat = () => reply("   ");
    tg.message({ chatId: 8012, text: "скажи что-нибудь" });
    await tg.waitFor(() => tg.texts().length >= 1, 8000, "сообщение об ошибке");

    assert.match(tg.texts()[0], /Не получилось получить ответ/);
    assert.equal(app.exited(), null);
  });
});

test("40 чатов по 3 сообщения одновременно: все ответы на месте и в правильном порядке внутри чата", async () => {
  await withApp({}, async ({ tg, or, app }) => {
    or.chat = async (request) => {
      const tag = /MSG-(\d+)-(\d+)/.exec(request.body.messages.at(-1).content);

      return { ...reply(`ответ ${tag[1]}-${tag[2]}`), delayMs: 30 };
    };

    for (let seq = 1; seq <= 3; seq += 1) {
      for (let chat = 1; chat <= 40; chat += 1) {
        tg.message({ chatId: 9000 + chat, text: `MSG-${chat}-${seq}` });
      }
    }

    await tg.waitFor(() => tg.texts().length >= 120, 40000, "120 ответов");
    await tg.quiet(500);

    const byChat = new Map();

    for (const params of tg.sent()) {
      byChat.set(String(params.chat_id), [...(byChat.get(String(params.chat_id)) || []), params.text]);
    }

    assert.equal(tg.texts().length, 120, "ни потерь, ни дублей");
    assert.equal(byChat.size, 40);

    for (let chat = 1; chat <= 40; chat += 1) {
      assert.deepEqual(byChat.get(String(9000 + chat)), [`ответ ${chat}-1`, `ответ ${chat}-2`, `ответ ${chat}-3`], `порядок в чате ${chat}`);
    }

    app.child.kill("SIGTERM");
    await app.waitForExit(10000);

    const stored = JSON.parse(fs.readFileSync(app.memoryFile, "utf8"));

    assert.equal(Object.keys(stored).length, 40);
    assert.ok(Object.values(stored).every((chat) => chat.messages.length === 6));
  });
});

test("лимит истории: после 40 сообщений в чате в модель уходит не больше MAX_HISTORY_MESSAGES", async () => {
  await withApp({ env: { MAX_HISTORY_MESSAGES: "10", MAX_STORED_MESSAGES: "20", RATE_LIMIT_MESSAGES: "1000" } }, async ({ tg, or }) => {
    or.chat = () => reply("ок, это ответ достаточной длины, чтобы не считаться коротким");

    for (let i = 0; i < 40; i += 1) {
      tg.message({ chatId: 8013, text: `сообщение номер ${i}` });
    }

    await tg.waitFor(() => tg.texts().length >= 40, 40000, "все ответы");

    const lastRequest = or.chatRequests().at(-1).body.messages;

    // системный промпт + не больше 10 сообщений истории + текущий вопрос
    assert.ok(lastRequest.length <= 12, `в запросе ${lastRequest.length} сообщений`);
  });
});

test("временный сбой ИИ на одном чате не мешает остальным", async () => {
  await withApp({}, async ({ tg, or }) => {
    or.chat = (request) => /ПЛОХОЙ/.test(request.body.messages.at(-1).content) ? failure(400, "bad request") : reply("нормально");

    tg.message({ chatId: 8014, text: "ПЛОХОЙ запрос" });
    tg.message({ chatId: 8015, text: "хороший запрос" });
    await tg.waitFor(() => tg.texts().length >= 2, 10000, "оба ответа");

    assert.ok(tg.texts().includes("нормально"));
    assert.ok(tg.texts().some((text) => /Не получилось получить ответ/.test(text)));
  });
});
