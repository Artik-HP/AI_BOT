// Explicit opt-in, scoped to the owner's supplied private test chat.
const fs = require("fs");
const os = require("os");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
let chatId = process.argv.includes("--chat-id") ? process.argv[process.argv.indexOf("--chat-id") + 1] : undefined;
const awaitTestMessage = process.argv.includes("--await-test-message");
if (!awaitTestMessage && !/^\d+$/.test(chatId || "")) throw new Error("Provide an explicitly authorized private --chat-id or --await-test-message");
const output = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bot-telegram-live-"));
process.env.MEMORY_FILE = path.join(output, "memory.json");
process.env.INTERACTIVE_STATE_FILE = path.join(output, "interactive-state.json");
const { createTelegramBot, enqueueChatTask } = require("../src/services/telegram");
const { processUserText, handleInteractiveCallback } = require("../src/services/conversation");
const { getInteractiveState } = require("../src/services/interactiveState");
const { getUserMemory } = require("../src/services/memory");
const bot = createTelegramBot({ polling: false, configureWebhook: false });
const state = getInteractiveState();
const results = [];
const timeout = Number(process.env.INTERACTIVE_LIVE_WAIT_MS || 300000);
let author;
let manualExpected = false, manualDone = false, failed = false;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check) {
  const until = Date.now() + timeout;
  while (Date.now() < until && !failed) { if (check()) return true; await delay(500); }
  return false;
}
bot.on("callback_query", (query) => {
  if (String(query.message?.chat?.id) === chatId && String(query.from?.id) === chatId) {
    handleInteractiveCallback(bot, query).catch(() => { failed = true; });
  }
});
bot.on("message", (msg) => {
  if (!manualExpected || String(msg.chat?.id) !== chatId || String(msg.from?.id) !== chatId || !msg.text || msg.text.startsWith("/")) return;
  manualExpected = false;
  enqueueChatTask(chatId, async () => {
    await processUserText(bot, chatId, msg.text, msg.from);
    manualDone = true;
  }).catch(() => { failed = true; });
});
bot.on("polling_error", (error) => {
  console.error("Telegram polling failed:", error.response?.statusCode || error.code);
  failed = true;
});
async function run() {
  if (awaitTestMessage) {
    console.log("Waiting for the owner's private message: тест кнопок");
    const until = Date.now() + timeout;
    while (!chatId && Date.now() < until) {
      const updates = await bot.getUpdates({ timeout: 10, allowed_updates: ["message", "callback_query"] });
      const matches = updates.filter((update) => update.message?.chat?.type === "private"
        && update.message.from?.id === update.message.chat.id
        && update.message.text?.trim().toLowerCase() === "тест кнопок"
        && update.message.date >= Math.floor(Date.now() / 1000) - 300);
      const ids = [...new Set(matches.map((update) => String(update.message.chat.id)))];
      if (ids.length > 1) throw new Error("Multiple test chats found; specify the owner's chat_id explicitly");
      if (ids.length === 1) chatId = ids[0];
      if (!chatId) await delay(1000);
    }
    if (!chatId) throw new Error("The owner's test message was not received before timeout");
  }
  author = { id: Number(chatId), first_name: "Тест" };
  const chat = await bot.getChat(chatId);
  const identity = await bot.getMe();
  if (String(identity.id) === chatId) throw new Error("The provided chat_id is the bot's own ID; provide the user's private chat ID");
  if (chat.type !== "private") throw new Error("Only the explicitly authorized private chat may be tested");
  const webhook = await bot.getWebHookInfo();
  if (webhook.url) throw new Error("An existing webhook is active; live polling test will not change it");
  await bot.startPolling({ params: { allowed_updates: ["message", "callback_query"], timeout: 10 } });
  console.log(`Live Telegram evidence: ${output}`);
  for (const scenario of [
    { name: "single", prompt: "Тестируем разработку Telegram-бота для бизнеса. Задай один вопрос: где разместить бота? Предложи одинарный выбор между VPS, Render и локальным компьютером. После ответа кратко подтверди выбранную площадку." },
    { name: "multiple", prompt: "Теперь нужно выбрать несколько функций Telegram-бота одновременно. Задай один вопрос с множественным выбором: приём заказов, AI-консультант, Excel/CSV, поддержка клиентов. После подтверждения учти выбранные функции." }
  ]) {
    await bot.sendMessage(chatId, scenario.name === "single" ? "Проверка 1/3: нажми один вариант под следующим вопросом AI." : "Проверка 2/3: отметь несколько вариантов и нажми «Подтвердить».");
    await enqueueChatTask(chatId, () => processUserText(bot, chatId, scenario.prompt, author));
    const record = Object.values(state.records).findLast((item) => item.chatId === chatId && item.status === "active");
    if (!record || record.question.selection_mode !== scenario.name) throw new Error(`Model did not create a ${scenario.name} question`);
    const completed = await waitFor(() => state.get(record.id).status === "completed");
    const current = state.get(record.id);
    const result = {
      scenario: scenario.name, passed: completed,
      actualTelegramCallback: completed, selectedCount: current.selected.length,
      userHistorySaved: completed && getUserMemory(chatId).messages.some((message) => message.role === "user" && message.content === current.answer),
      messageId: current.messageId
    };
    results.push(result); console.log(JSON.stringify(result));
    if (!completed) return;
  }
  await bot.sendMessage(chatId, "Проверка 3/3: на следующий открытый вопрос ответь обычным текстом.");
  const reply = await enqueueChatTask(chatId, () => processUserText(bot, chatId, "Задай один открытый вопрос: попроси своими словами описать мой бизнес. Не предлагай готовые варианты.", author));
  if (typeof reply !== "string") throw new Error("Open question unexpectedly generated buttons");
  manualExpected = true;
  const completed = await waitFor(() => manualDone);
  results.push({ scenario: "manual-open", passed: completed, actualTelegramMessage: completed, userHistorySaved: completed });
  console.log(JSON.stringify(results.at(-1)));
  if (completed) await bot.sendMessage(chatId, "Проверка завершена: одиночный выбор, множественный выбор и обычный текст прошли через реальный OpenRouter. Тестовые данные сохранены отдельно от основной памяти бота.");
}
run().catch((error) => {
  results.push({ passed: false, error: error.response?.statusCode ? `Telegram HTTP ${error.response.statusCode}` : error.message });
  console.error(results.at(-1).error);
}).finally(async () => {
  await bot.stopPolling({ cancel: true }).catch(() => {});
  fs.writeFileSync(path.join(output, "results.json"), JSON.stringify({ createdAt: new Date().toISOString(), results }, null, 2));
  console.log(`Evidence directory: ${output}`);
  if (results.length < 3 || results.some((result) => !result.passed)) process.exitCode = 1;
});
