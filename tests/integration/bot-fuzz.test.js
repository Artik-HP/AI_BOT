const test = require("node:test");
const assert = require("node:assert/strict");
const { withApp } = require("../helpers/app");
const { reply } = require("../helpers/fakeOpenRouter");

// Small deterministic PRNG, so a failure can be reproduced with the same seed.
function mulberry32(seed) {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;

    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NASTY_TEXTS = [
  "",
  " ",
  "\n\n\n",
  "\u0000\u0001\u0002 управляющие символы",
  "\ud83d одинокий суррогат",
  "😀".repeat(2100),
  "а".repeat(4096),
  "/",
  "/start@",
  "/help@" + "x".repeat(80),
  "/bot_send",
  "/bot_send @",
  "/account_mode ///",
  "@@@@ @@@",
  "<script>alert(1)</script>",
  "'; DROP TABLE users; --",
  "${process.env.BOT_TOKEN}",
  "{{constructor.constructor('return process')()}}",
  `RTL ${String.fromCodePoint(0x202e)} текст ${String.fromCodePoint(0x202c)}`,
  String.fromCodePoint(0x200b).repeat(3),
  "зови меня " + "я".repeat(300),
  "__proto__",
  "constructor"
];

const MEDIA_FIELDS = [
  { sticker: { file_id: "s", file_unique_id: "s", width: 1, height: 1, is_animated: false, is_video: false, type: "regular" } },
  { location: { latitude: 1, longitude: 2 } },
  { contact: { phone_number: "+1", first_name: "К" } },
  { document: { file_id: "d", file_unique_id: "d", file_name: "x.bin", mime_type: "application/octet-stream", file_size: 10 } },
  { document: { file_id: "d2", file_unique_id: "d2", mime_type: "image/heic", file_size: 10 } },
  { voice: { file_id: "missing-voice", file_unique_id: "v", duration: 1, file_size: 10 } },
  { photo: [] },
  { photo: [{ file_id: "missing-photo", file_unique_id: "p", width: 1, height: 1 }] },
  { new_chat_members: [{ id: 1, is_bot: false, first_name: "Н" }] },
  { left_chat_member: { id: 1, is_bot: false, first_name: "Н" } },
  { pinned_message: { message_id: 1, date: 1, chat: { id: 1, type: "group" } } },
  { forward_origin: { type: "hidden_user", date: 1, sender_user_name: "Скрытый" } },
  { poll: { id: "1", question: "?", options: [], total_voter_count: 0, is_closed: false, is_anonymous: true, type: "regular", allows_multiple_answers: false } },
  { caption: "подпись без медиа" },
  { entities: [{ type: "bold", offset: 0, length: 5 }, { type: "bot_command", offset: 0, length: 6 }] }
];

function pick(random, list) {
  return list[Math.floor(random() * list.length)];
}

// Updates in the shapes Telegram really sends: optional fields come and go, texts are hostile.
function sparseUpdate(random, seq) {
  const chatType = pick(random, ["private", "group", "supergroup", "channel"]);
  const chatId = chatType === "private" ? 7000 + Math.floor(random() * 5) : -100000 - Math.floor(random() * 5);
  const message = {
    message_id: seq,
    date: 1_700_000_000,
    chat: { id: chatId, type: chatType, ...(random() < 0.5 ? { title: "чат" } : {}) }
  };

  if (random() < 0.8) {
    message.from = { id: 8000 + Math.floor(random() * 5), is_bot: random() < 0.15, first_name: pick(random, ["А", "", "😀", "<b>x</b>", "Имя".repeat(40)]), ...(random() < 0.5 ? { username: "fuzz_user_name" } : {}) };
  }

  if (random() < 0.7) {
    message.text = pick(random, NASTY_TEXTS);
  }

  if (random() < 0.4) {
    Object.assign(message, pick(random, MEDIA_FIELDS));
  }

  if (random() < 0.2) {
    message.reply_to_message = { message_id: 1, date: 1, chat: message.chat, ...(random() < 0.5 ? { from: { id: 424242, is_bot: true, first_name: "Test" } } : {}) };
  }

  const kind = pick(random, ["message", "message", "message", "edited_message", "channel_post", "edited_channel_post"]);

  return { [kind]: message };
}

// Shapes Telegram never sends; the process still must not die.
function garbageUpdate(random, seq) {
  const junk = [null, 0, -1, 1.5, "строка", [], {}, [1, 2], true, "x".repeat(5000)];
  const message = { message_id: seq, date: pick(random, junk), chat: pick(random, [{ id: pick(random, junk), type: pick(random, junk) }, junk[0], junk[4]]) };

  for (const field of ["from", "text", "caption", "voice", "photo", "document", "entities", "reply_to_message"]) {
    if (random() < 0.5) {
      message[field] = pick(random, junk);
    }
  }

  return { message };
}

async function feed(tg, updates) {
  for (const update of updates) {
    tg.enqueue(update);
  }
}

test("фаззинг: 300 правдоподобных апдейтов с враждебными текстами не роняют бота и не вызывают ошибок обработчиков", async () => {
  await withApp({ env: { RATE_LIMIT_MESSAGES: "100000" } }, async ({ tg, or, app }) => {
    or.chat = () => reply("принято, это достаточно длинный ответ для проверки");

    const random = mulberry32(20261019);

    await feed(tg, Array.from({ length: 300 }, (_, index) => sparseUpdate(random, 100000 + index)));
    await tg.quiet(4000);

    const output = app.output();

    assert.equal(app.exited(), null, `процесс упал: ${output.slice(-500)}`);
    assert.ok(or.chatRequests().length > 20, `до обработчиков дошло слишком мало апдейтов (${or.chatRequests().length} запросов к ИИ)`);
    assert.doesNotMatch(output, /failed:|TypeError|ReferenceError|RangeError|Unhandled rejection/, `ошибка обработчика в логе:\n${output.slice(-800)}`);

    tg.message({ chatId: 7999, text: "а теперь обычное сообщение" });
    await tg.waitFor(() => tg.sent().some((params) => String(params.chat_id) === "7999"), 10000, "нормальный ответ после фаззинга");
  });
});

test("фаззинг: 200 апдейтов с заведомо неверными типами полей не роняют процесс", async () => {
  await withApp({ env: { RATE_LIMIT_MESSAGES: "100000" } }, async ({ tg, or, app }) => {
    or.chat = () => reply("принято, это достаточно длинный ответ для проверки");

    const random = mulberry32(424242);

    await feed(tg, Array.from({ length: 200 }, (_, index) => garbageUpdate(random, 200000 + index)));
    await tg.quiet(3000);

    assert.equal(app.exited(), null, `процесс упал: ${app.output().slice(-500)}`);

    tg.message({ chatId: 7998, text: "после мусора" });
    await tg.waitFor(() => tg.sent().some((params) => String(params.chat_id) === "7998"), 10000, "нормальный ответ после мусора");
  });
});
