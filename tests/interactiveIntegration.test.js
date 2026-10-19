const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bot-buttons-test-"));
process.env.MEMORY_FILE = path.join(temp, "memory.json");
process.env.INTERACTIVE_STATE_FILE = path.join(temp, "interactive-state.json");
process.env.BOT_TOKEN = "test-only";
process.env.OPENROUTER_API_KEY = "test-only";
process.env.OPENROUTER_MODEL = "test/model";
class FakeTelegram extends EventEmitter {
  constructor() { super(); this.sent = []; this.edits = []; this.nextId = 1; this.failSend = false; }
  async getMe() { return { id: 999, username: "test_bot" }; }
  async getFileLink() { return "https://files.test/input"; }
  async sendMessage(chatId, text, options = {}) {
    assert.ok(text.length <= 4096, "Telegram rejects messages longer than 4096 UTF-16 units");
    if (this.failSend) { this.failSend = false; throw new Error("network failure"); }
    if (this.failAfterMessages === 0) { this.failAfterMessages = undefined; throw new Error("partial delivery failure"); }
    if (this.failAfterMessages > 0) this.failAfterMessages--;
    const message = { message_id: this.nextId++, chat: { id: chatId }, text, options };
    this.sent.push(message); return message;
  }
  async sendChatAction() {}
  async answerCallbackQuery() {}
  async editMessageReplyMarkup(markup, options) { this.edits.push({ markup, options }); }
  async setMyCommands() {}
  onText(regexp, callback) { this.commandHandlers ||= []; this.commandHandlers.push({ regexp, callback }); }
}
const originalLoad = Module._load;
Module._load = function (request, ...args) { return request === "node-telegram-bot-api" ? FakeTelegram : originalLoad.call(this, request, ...args); };
const telegram = require("../src/services/telegram");
Module._load = originalLoad;
const bot = telegram.createTelegramBot();
const axios = require("axios");
const requests = [];
let responses = [];
let catalogParameters = ["structured_outputs", "tools", "temperature", "top_p", "frequency_penalty", "presence_penalty"];
axios.get = async (url) => url === "https://files.test/input"
  ? { data: Buffer.from("test-media-bytes") }
  : { data: { data: [{ id: "test/model", supported_parameters: catalogParameters }] } };
axios.post = async (url, body) => {
  requests.push(body);
  const response = responses.shift();
  if (response instanceof Error) throw response;
  if (typeof response === "function") return response(body);
  assert.notEqual(response, undefined, "unexpected extra AI request");
  return { data: { choices: [{ message: { content: typeof response === "string" ? response : JSON.stringify(response) }, finish_reason: "stop" }] } };
};
const { processUserText, handleInteractiveCallback } = require("../src/services/conversation");
const { getInteractiveState, InteractiveState } = require("../src/services/interactiveState");
const { getUserMemory } = require("../src/services/memory");
const { requestInteractiveCompletion } = require("../src/services/openrouterInteractive");
const { historyText } = require("../src/services/interactiveQuestion");
const state = getInteractiveState();
const author = { id: 42, first_name: "Test" };
let queryId = 0;
function question(mode = "single", text = "Где разместить?") {
  return { type: "interactive_question", question: text, selection_mode: mode, allow_custom_input: true, options: [{ id: "vps", label: "VPS", value: "Разместить бота на VPS" }, { id: "local", label: "Локально", value: "Запускать бота локально" }] };
}
function active(chatId) { return Object.values(state.records).findLast((record) => record.chatId === String(chatId) && record.status === "active"); }
function query(record, action, index, from = author) { return { id: String(++queryId), from, message: { chat: { id: Number(record.chatId) }, message_id: record.messageId }, data: `iq:${record.id}:${action}${index === undefined ? "" : `:${index}`}` }; }
test("single choice uses value, context and persistent user history; second question gets its own buttons", async () => {
  const databaseQuestion = question("single", "Какую базу данных использовать?");
  databaseQuestion.options = [{ id: "postgres", label: "PostgreSQL", value: "Использовать PostgreSQL" }, { id: "sqlite", label: "SQLite", value: "Использовать SQLite" }];
  responses = [question(), databaseQuestion];
  await processUserText(bot, 100, "Помоги создать бота", author);
  const first = active(100), click = query(first, "o", 0);
  const before = requests.length;
  await Promise.all([handleInteractiveCallback(bot, click), handleInteractiveCallback(bot, click)]);
  assert.equal(requests.length, before + 1);
  assert.equal(state.get(first.id).status, "completed");
  assert.match(requests.at(-1).messages.at(-1).content, /Разместить бота на VPS/);
  assert.ok(requests.at(-1).messages.some((message) => message.content === historyText(question())));
  const users = getUserMemory(100).messages.filter((message) => message.role === "user");
  assert.equal(users.at(-1).content, "Разместить бота на VPS");
  assert.equal(users.length, 2);
  assert.notEqual(active(100).id, first.id);
  const saved = JSON.parse(fs.readFileSync(process.env.MEMORY_FILE));
  assert.equal(saved[100].messages.filter((message) => message.content === "Разместить бота на VPS").length, 1);
});
test("multiple choice only sends selected values after confirmation and highlights selection", async () => {
  responses = [question("multiple"), "Продолжаем с обеими площадками."];
  await processUserText(bot, 101, "Хочу несколько сред", author);
  const record = active(101), before = requests.length;
  const firstTap = query(record, "o", 0);
  await handleInteractiveCallback(bot, firstTap);
  await handleInteractiveCallback(bot, firstTap);
  await handleInteractiveCallback(bot, query(record, "o", 1));
  assert.equal(requests.length, before);
  assert.deepEqual(state.get(record.id).selected, [0, 1]);
  assert.ok(bot.edits.at(-1).markup.inline_keyboard[0][0].text.startsWith("✅"));
  const confirm = query(record, "c");
  await Promise.all([handleInteractiveCallback(bot, confirm), handleInteractiveCallback(bot, query(record, "c"))]);
  assert.equal(requests.length, before + 1);
  assert.equal(getUserMemory(101).messages.at(-2).content, "Разместить бота на VPS\nЗапускать бота локально");
});
test("failed AI request can be retried explicitly; two rapid retries never trigger a third request", async () => {
  responses = [question(), new Error("AI unavailable"), new Error("AI unavailable again")];
  await processUserText(bot, 102, "Выберем сервер", author);
  const record = active(102);
  await handleInteractiveCallback(bot, query(record, "o", 0));
  assert.equal(state.get(record.id).status, "failed");
  const before = requests.length;
  await Promise.all([handleInteractiveCallback(bot, query(record, "r")), handleInteractiveCallback(bot, query(record, "r"))]);
  assert.equal(requests.length, before + 1);
  responses = ["VPS выбран, продолжим."];
  await handleInteractiveCallback(bot, query(record, "r"));
  assert.equal(state.get(record.id).status, "completed");
  assert.equal(getUserMemory(102).messages.filter((message) => message.content === "Разместить бота на VPS").length, 1);
});
test("Telegram delivery retry reuses generated answer and does not duplicate history", async () => {
  responses = [question(), () => { bot.failSend = true; return { data: { choices: [{ message: { content: "Готово, VPS выбран." }, finish_reason: "stop" }] } }; }];
  await processUserText(bot, 103, "Размещение", author);
  const record = active(103);
  await handleInteractiveCallback(bot, query(record, "o", 0));
  assert.equal(state.get(record.id).status, "failed");
  const before = requests.length;
  await handleInteractiveCallback(bot, query(record, "r"));
  assert.equal(requests.length, before);
  assert.equal(state.get(record.id).status, "completed");
  assert.equal(getUserMemory(103).messages.filter((message) => message.content === "Разместить бота на VPS").length, 1);
});
test("restart preserves completed questions, selection and failed delivery; loading never submits anything", () => {
  const before = requests.length;
  const restored = new InteractiveState(process.env.INTERACTIVE_STATE_FILE);
  const record = Object.values(restored.records).find((record) => record.chatId === "100" && record.status === "completed");
  assert.deepEqual(record.selected, [0]);
  assert.ok(restored.resolve(query(record, "o", 0)).error);
  assert.equal(requests.length, before);
});
test("ownership, message binding and chat isolation reject forged callback data", async () => {
  responses = [question()];
  await processUserText(bot, 104, "Нужны кнопки", author);
  const record = active(104), before = requests.length;
  await handleInteractiveCallback(bot, query(record, "o", 0, { id: 43 }));
  const wrongChat = query(record, "o", 0); wrongChat.message.chat.id = 105;
  await handleInteractiveCallback(bot, wrongChat);
  const wrongMessage = query(record, "o", 0); wrongMessage.message.message_id++;
  await handleInteractiveCallback(bot, wrongMessage);
  assert.equal(requests.length, before);
  assert.deepEqual(state.get(record.id).selected, []);
});
test("manual text expires old controls; open questions have no keyboard; menu labels selected via callbacks are AI answers", async () => {
  const q = question(); q.options[0] = { id: "help", label: "Помощь", value: "Помощь" };
  responses = [q, "Как прошёл день?"];
  await processUserText(bot, 106, "Вопрос", author);
  const old = active(106);
  await processUserText(bot, 106, "Отвечаю сам", author);
  assert.equal(state.get(old.id).status, "expired");
  assert.equal(bot.sent.at(-1).options.reply_markup, undefined);
  assert.equal(getUserMemory(106).messages.at(-2).content, "Отвечаю сам");
  responses = [q, "Помощь учтена."];
  await processUserText(bot, 107, "Вопрос", author);
  await handleInteractiveCallback(bot, query(active(107), "o", 0));
  assert.equal(getUserMemory(107).messages.at(-2).content, "Помощь");
});
test("model transport supports tool calling, rejects arbitrary tools, and falls back when native parameters fail", async () => {
  const messages = [{ role: "system", content: "Test" }, { role: "user", content: "Pick" }];
  responses = [() => ({ data: { choices: [{ message: { tool_calls: [{ function: { name: "show_interactive_question", arguments: JSON.stringify(question()) } }] }, finish_reason: "tool_calls" }] } })];
  assert.equal((await requestInteractiveCompletion(messages, { mode: "tools" })).type, "interactive_question");
  assert.equal(requests.at(-1).tools[0].function.name, "show_interactive_question");
  const unsupported = new Error("unsupported"); unsupported.response = { status: 400, data: { error: "structured outputs unsupported" } };
  responses = [unsupported, question()];
  assert.equal((await requestInteractiveCompletion(messages, { mode: "schema" })).type, "interactive_question");
  assert.equal(requests.at(-1).response_format, undefined);
  responses = [() => ({ data: { choices: [{ message: { tool_calls: [{ function: { name: "eval", arguments: "process.exit()" } }] }, finish_reason: "tool_calls" }] } })];
  await assert.rejects(requestInteractiveCompletion(messages, { mode: "tools" }), /Unexpected/);
});
test("voice/photo utilities, Unicode splitting, ordinary commands and bot-to-bot settings still work", async () => {
  const voice = require("../src/handlers/voice");
  const photo = require("../src/handlers/photo");
  assert.equal(voice.getAudioMessage({ voice: { file_id: "v" } }).format, "ogg");
  assert.equal(photo.getImageMessage({ photo: [{ file_id: "small", width: 1, height: 1 }, { file_id: "big", width: 10, height: 10 }] }).fileId, "big");
  const text = "🙂".repeat(5000);
  const chunks = telegram.splitTelegramMessage(text);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every((chunk) => chunk.length <= 4096 && !/[\ud800-\udbff]$/.test(chunk)));
  const commands = require("../src/commands");
  commands.initCommands(bot);
  await commands.handleMenuButton(108, "Помощь");
  assert.match(bot.sent.at(-1).text, /Команды/);
  assert.equal(telegram.getBotToBotStatus().enabled, false);
});
test("real voice and photo handlers deliver dynamic questions through the shared conversation pipeline", async () => {
  const voice = require("../src/handlers/voice");
  const photo = require("../src/handlers/photo");
  responses = [() => ({ data: { text: "Помоги выбрать функции бота" } }), question("multiple")];
  await voice.handleAudioMessage(bot, 109, { from: author }, { fileId: "v", format: "ogg" });
  assert.equal(active(109).question.selection_mode, "multiple");
  assert.ok(bot.sent.at(-1).options.reply_markup);
  responses = [question()];
  await photo.handleImageMessage(bot, 110, { from: author, caption: "Выбери вариант" }, { fileId: "p", mimeType: "image/png" });
  assert.ok(active(110));
  const imageTurn = requests.at(-1).messages.at(-1);
  assert.ok(imageTurn.content.some((part) => part.type === "image_url" && part.image_url.url.startsWith("data:image/png;base64,")));
});
test("account drafts retain their existing JSON format without UI protocol parameters", async () => {
  const { draftAccountReply } = require("../src/services/openrouter");
  responses = [JSON.stringify({ reply: "Спасибо, посмотрю.", sendable: true, reason: "neutral" })];
  const draft = await draftAccountReply(111, "Посмотри сообщение", author);
  assert.equal(draft.reply, "Спасибо, посмотрю.");
  assert.equal(draft.sendable, true);
  assert.equal(requests.at(-1).response_format, undefined);
  assert.equal(requests.at(-1).tools, undefined);
});
test("text handler preserves menu commands and bot-to-bot request and reply contracts", async () => {
  const CONFIG = require("../src/config");
  const { registerTextHandler } = require("../src/handlers/text");
  registerTextHandler(bot, { handleMenuButton: async (chat, text) => text === "Помощь" });
  const listener = bot.listeners("message").at(-1);
  const before = requests.length;
  await listener({ chat: { id: 112, type: "private" }, from: author, message_id: 500, text: "Помощь" });
  await listener({ chat: { id: 112, type: "private" }, from: author, message_id: 501, text: "/status" });
  assert.equal(requests.length, before);
  CONFIG.BOT_TO_BOT_ENABLED = true;
  responses = ["Ответ другому боту."];
  await listener({ chat: { id: 113, type: "private" }, from: { id: 1000, is_bot: true, username: "other_bot" }, message_id: 502, text: "/bot_chat привет" });
  assert.equal(requests.at(-1).response_format, undefined);
  assert.match(bot.sent.at(-1).text, /@other_bot/);
  assert.equal(bot.sent.at(-1).options.reply_to_message_id, 502);
  assert.equal(bot.sent.at(-1).options.reply_markup, undefined);
  CONFIG.BOT_TO_BOT_ENABLED = false;
});
test("an already answered selection is corrected without changing the chosen values", async () => {
  responses = [question(), question(), "VPS подтверждён. Теперь настраиваем сервер."];
  await processUserText(bot, 114, "Где разместить?", author);
  const record = active(114);
  await handleInteractiveCallback(bot, query(record, "o", 0));
  assert.equal(state.get(record.id).status, "completed");
  assert.equal(getUserMemory(114).messages.at(-2).content, "Разместить бота на VPS");
  assert.ok(requests.at(-1).messages[0].content.includes("Accept this answer"));
});
test("restart recovers generated replies without automatic requests or duplicate history", () => {
  const record = active(104);
  state.update(record.id, { status: "generated", reply: "Сохранённый ответ", answer: "Выбор", selected: [0] });
  const before = requests.length;
  const restored = new InteractiveState(process.env.INTERACTIVE_STATE_FILE);
  assert.equal(restored.get(record.id).status, "failed");
  assert.equal(restored.get(record.id).reply, "Сохранённый ответ");
  assert.equal(requests.length, before);
});
test("a question retains its selected model when a button submits the next turn", async () => {
  responses = [question(), "Продолжаем на той же модели."];
  await processUserText(bot, 115, "Выбор сервера", author, { model: "test/other-model" });
  const record = active(115);
  assert.equal(record.model, "test/other-model");
  await handleInteractiveCallback(bot, query(record, "o", 0));
  assert.equal(requests.at(-1).model, "test/other-model");
  assert.equal(state.get(record.id).status, "completed");
});
test("malformed native questions get one repair attempt and never leak protocol JSON", async () => {
  const messages = [{ role: "system", content: "Test" }, { role: "user", content: "Pick" }];
  responses = ['{"type":"interactive_question","question":', question()];
  assert.equal((await requestInteractiveCompletion(messages, { mode: "schema" })).type, "interactive_question");
  responses = ['{"type":"interactive_question","question":', '{"type":"interactive_question","question":'];
  const fallback = await requestInteractiveCompletion(messages, { mode: "schema" });
  assert.equal(typeof fallback, "string");
  assert.ok(!fallback.includes('"type"'));
});
test('empty model objects get one repair; repeated empty objects report failure', async () => {
  const messages=[{role:'user',content:'Review this code'}];
  responses=['{}','Useful answer'];
  assert.equal(await requestInteractiveCompletion(messages),'Useful answer');
  responses=['{}','{}'];
  await assert.rejects(requestInteractiveCompletion(messages),/empty structured object/);
});
test("partial Telegram delivery retries only unsent chunks of the cached completion", async () => {
  const reply = Array.from({ length: 800 }, (_, i) => `элемент${i}`).join(" ");
  responses = [question(), () => {
    bot.failAfterMessages = 1;
    return { data: { choices: [{ message: { content: reply }, finish_reason: "stop" }] } };
  }];
  await processUserText(bot, 116, "Вопрос перед длинным ответом", author);
  const record = active(116);
  await handleInteractiveCallback(bot, query(record, "o", 0));
  assert.equal(state.get(record.id).status, "failed");
  assert.equal(state.get(record.id).delivery.chunksSent, 1);
  const before = requests.length;
  await handleInteractiveCallback(bot, query(record, "r"));
  assert.equal(requests.length, before);
  assert.equal(state.get(record.id).status, "completed");
  const delivered = bot.sent.filter((message) => String(message.chat.id) === "116" && message.text.startsWith("элемент"));
  assert.equal(delivered.map((message) => message.text).join(""), reply);
});
test("custom-input controls do not call AI and expired questions cannot be submitted", async () => {
  responses = [question()];
  await processUserText(bot, 117, "Хочу свой вариант", author);
  const record = active(117), before = requests.length;
  await handleInteractiveCallback(bot, query(record, "s"));
  assert.equal(requests.length, before);
  assert.equal(state.get(record.id).status, "manual");
  responses = ["Свой вариант принят."];
  await processUserText(bot, 117, "Мой собственный ответ", author);
  assert.equal(getUserMemory(117).messages.at(-2).content, "Мой собственный ответ");
  responses = [question()];
  await processUserText(bot, 118, "Вопрос с истёкшим сроком", author);
  const expired = active(118);
  state.update(expired.id, { expiresAt: Date.now() - 1 });
  const count = requests.length;
  await handleInteractiveCallback(bot, query(expired, "o", 0));
  assert.equal(requests.length, count);
});
test("large multiple selections preserve every value in saved and reloaded history", async () => {
  const q = question("multiple");
  q.options = Array.from({ length: 6 }, (_, i) => ({ id: `f${i}`, label: `Функция ${i}`, value: `Функция ${i}: ${"деталь".repeat(120)}` }));
  responses = [q, "Все выбранные функции учтены."];
  await processUserText(bot, 119, "Выберем все нужные функции", author);
  const record = active(119);
  state.update(record.id, { selected: [0, 1, 2, 3, 4, 5] });
  await handleInteractiveCallback(bot, query(record, "c"));
  const answer = q.options.map((option) => option.value).join("\n");
  assert.ok(answer.length > 4000);
  assert.equal(getUserMemory(119).messages.at(-2).content, answer);
  assert.equal(require("../src/services/memory").loadMemory()[119].messages.at(-2).content, answer);
  assert.ok(requests.at(-1).messages.every((message) => message.interactive === undefined));
});

test("partial long confirmation resumes after restart and does not repeat successful chunks or AI requests", async () => {
  const q = question("multiple");
  q.options = Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, label: `Пункт ${i}`, value: `Пункт ${i}: ${"описание".repeat(100)}` }));
  responses = [q, "Выбор успешно обработан после повтора."];
  await processUserText(bot, 120, "Выберем все пункты", author);
  const record = active(120);
  state.update(record.id, { selected: q.options.map((_, i) => i) });
  const before = requests.length, sentBefore = bot.sent.length;
  bot.failAfterMessages = 1;
  await handleInteractiveCallback(bot, query(record, "c"));
  assert.equal(state.get(record.id).status, "failed");
  assert.equal(requests.length, before);
  state.records = new InteractiveState().records;
  await handleInteractiveCallback(bot, query(record, "r"));
  assert.equal(state.get(record.id).status, "completed");
  assert.equal(requests.length, before + 1);
  const confirmation = bot.sent.slice(sentBefore)
    .filter((message) => String(message.chat.id) === "120" && !message.text.startsWith("Не удалось") && message.text !== "Выбор успешно обработан после повтора.")
    .map((message) => message.text).join("");
  assert.equal(confirmation, "Твой ответ:\n" + q.options.map((option) => option.value).join("\n"));
});
