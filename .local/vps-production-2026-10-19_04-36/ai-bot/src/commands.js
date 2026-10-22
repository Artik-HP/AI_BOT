const CONFIG = require("./config");
const { getSttModels } = require("./services/openrouter");
const {
  getBotToBotStatus,
  sendMessageToBot,
  invalidateInteractiveQuestions,
} = require("./services/telegram");
const {
  MAX_HISTORY_MESSAGES,
  MAX_STORED_MESSAGES,
  getUserMemory,
  resetMemory,
} = require("./services/memory");

let bot;

const BUTTONS = {
  help: "Помощь",
  status: "Статус",
  voice: "Голосовые",
  reset: "Очистить память",
  menu: "Меню",
};

const MAIN_KEYBOARD = {
  reply_markup: {
    keyboard: [
      [{ text: BUTTONS.help }, { text: BUTTONS.status }],
      [{ text: BUTTONS.voice }, { text: BUTTONS.reset }],
      [{ text: BUTTONS.menu }],
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "Напиши текст или отправь голосовое",
  },
};

const INLINE_MENU = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: BUTTONS.help, callback_data: "menu:help" },
        { text: BUTTONS.status, callback_data: "menu:status" },
      ],
      [
        { text: BUTTONS.voice, callback_data: "menu:voice" },
        { text: BUTTONS.reset, callback_data: "menu:reset" },
      ],
      [{ text: BUTTONS.menu, callback_data: "menu:main" }],
    ],
  },
};

const BOT_COMMANDS = [...require("./commandSystem/registry").registry.values()]
  .filter((command) => command.availability.telegram && !command.hidden)
  .map((command) => ({
    command: command.id,
    description: command.description,
  }));
function initCommands(telegramBot) {
  bot = telegramBot;
  require("./commandSystem/telegram").registerTelegram(bot);
  bot.on("callback_query", async (query) => {
    if (!query.data?.startsWith("menu:")) return;
    if (!(await require("./services/access").guardCallback(bot, query))) return;
    const chatId = query.message?.chat?.id;
    if (!chatId || query.from?.is_bot) return;
    await bot.answerCallbackQuery(query.id).catch(() => {});
    try {
      await handleInlineMenu(
        chatId,
        query.message.message_id,
        query.data.slice(5),
      );
    } catch (error) {
      console.error("Legacy menu:", error.code || error.name);
    }
  });
}
async function sendMainMenu(chatId) {
  return require("./commandSystem/telegram").runMessage(
    bot,
    { chat: { id: chatId, type: "private" }, from: { id: chatId } },
    "menu",
    "",
  );
}

async function sendHelp(chatId) {
  return require("./commandSystem/telegram").runMessage(
    bot,
    { chat: { id: chatId, type: "private" }, from: { id: chatId } },
    "help",
    "",
  );
}
async function sendVoiceHelp(chatId) {
  await bot.sendMessage(
    chatId,
    [
      "Голосовые:",
      "1. Отправь обычное voice-сообщение в Telegram.",
      "2. Я скачаю аудио, расшифрую его и отвечу как на текст.",
      "3. Ответ пришлю текстом.",
      "",
      `Лимит файла: ${Math.round(CONFIG.MAX_AUDIO_BYTES / 1024 / 1024)} MB.`,
    ].join("\n"),
    MAIN_KEYBOARD,
  );
}

async function sendStatus(chatId, options = {}) {
  const prefs = require("./services/preferences").getPreferences(
    options.scope || String(chatId),
  );
  const memory = getUserMemory(
    require("./services/preferences").threadKey(
      options.scope || String(chatId),
      prefs,
    ),
  );
  const botToBot = getBotToBotStatus();

  await bot.sendMessage(
    chatId,
    [
      "Статус:",
      `AI-модель: ${prefs.model}`,
      `STT-модели: ${getSttModels().join(", ")}`,
      `Audio fallback: ${CONFIG.AUDIO_FALLBACK_MODEL}`,
      `Сообщений сохранено: ${memory.messages.length}/${MAX_STORED_MESSAGES}`,
      `В запрос к AI идет последних сообщений: ${Math.min(memory.messages.length, MAX_HISTORY_MESSAGES)}/${MAX_HISTORY_MESSAGES}`,
      `Долгая память: ${memory.summary ? `${memory.summary.length} символов` : "пусто"}`,
      `Mood: ${memory.mood}`,
      `Trust: ${memory.trust}`,
      `Style: ${memory.style}`,
      `Nickname: ${memory.nickname || "-"}`,
      `Bot-to-bot: ${botToBot.enabled ? "on" : "off"}`,
      `Bot-to-bot chat: ${botToBot.chatId || "-"}`,
      `Bot-to-bot target: ${botToBot.targetBotUsername ? `@${botToBot.targetBotUsername}` : "-"}`,
      `Лимит аудио: ${Math.round(CONFIG.MAX_AUDIO_BYTES / 1024 / 1024)} MB`,
    ].join("\n"),
    MAIN_KEYBOARD,
  );
}

function isBotToBotOwner(msg) {
  return (
    CONFIG.BOT_TO_BOT_OWNER_CHAT_ID &&
    msg?.chat?.type === "private" &&
    String(msg.from?.id || "") === String(CONFIG.BOT_TO_BOT_OWNER_CHAT_ID) &&
    String(msg.chat?.id || "") === String(CONFIG.BOT_TO_BOT_OWNER_CHAT_ID)
  );
}

async function ensureBotToBotOwner(msg) {
  const chatId = msg.chat.id;
  if (!CONFIG.BOT_TO_BOT_OWNER_CHAT_ID) {
    await bot.sendMessage(
      chatId,
      "Укажи BOT_TO_BOT_OWNER_CHAT_ID в переменных окружения.",
    );
    return false;
  }

  if (!isBotToBotOwner(msg)) {
    await bot.sendMessage(
      chatId,
      "Эта команда доступна только владельцу бота.",
    );
    return false;
  }

  return true;
}

async function sendBotToBotStatus(chatId, ownerMessage) {
  if (!(await ensureBotToBotOwner(ownerMessage || { chat: { id: chatId } }))) {
    return;
  }

  const status = getBotToBotStatus();

  await bot.sendMessage(
    chatId,
    [
      "Общение с другими ботами:",
      `Режим: ${status.enabled ? "включен" : "выключен"}`,
      `Username этого бота: ${status.username ? `@${status.username}` : "загружается"}`,
      `Чат для диалога: ${status.chatId || "не задан"}`,
      `Целевой бот: ${status.targetBotUsername ? `@${status.targetBotUsername}` : "не задан"}`,
      `Разрешенные боты: ${status.allowBots.length ? status.allowBots.join(", ") : "все"}`,
      `Лимит ходов: ${status.maxTurns} за ${Math.round(status.windowMs / 1000)} сек.`,
      `Минимальная пауза между ходами: ${status.minIntervalMs} мс.`,
      "",
      "Для личных сообщений включи Bot-to-Bot Communication Mode в @BotFather у обоих ботов.",
      "Начать разговор: /bot_send текст или /bot_send @username текст",
    ].join("\n"),
  );
}

async function sendBotMessageFromCommand(chatId, text, ownerMessage) {
  if (!(await ensureBotToBotOwner(ownerMessage || { chat: { id: chatId } }))) {
    return;
  }

  const status = getBotToBotStatus();
  const args = String(text || "")
    .trim()
    .split(/\s+/)
    .slice(1)
    .join(" ")
    .trim();
  const explicitTarget = args.match(/^(@[a-z0-9_]{5,32})\s+([\s\S]+)$/i);
  const legacyTarget = args.match(/^([a-z0-9_]{5,32})\s+([\s\S]+)$/i);
  const knownLegacyTarget =
    legacyTarget &&
    (legacyTarget[1].toLowerCase() === status.targetBotUsername ||
      status.allowBots
        .map((allowedBot) => String(allowedBot).replace(/^@/, "").toLowerCase())
        .includes(legacyTarget[1].toLowerCase()));
  const username = explicitTarget
    ? explicitTarget[1].replace(/^@/, "")
    : knownLegacyTarget
      ? legacyTarget[1]
      : status.targetBotUsername;
  const message = explicitTarget
    ? explicitTarget[2].trim()
    : knownLegacyTarget
      ? legacyTarget[2].trim()
      : args;

  if (!username || !message) {
    await bot.sendMessage(
      chatId,
      "Используй: /bot_send текст или /bot_send @username текст",
    );
    return;
  }

  try {
    await sendMessageToBot(username, message);
    await bot.sendMessage(chatId, `Сообщение отправлено @${username}.`);
  } catch (error) {
    await bot.sendMessage(
      chatId,
      `Не отправил: ${error.response?.body?.description || error.message}`,
    );
  }
}

async function resetChatMemory(chatId) {
  await invalidateInteractiveQuestions(chatId).catch(() => {});
  resetMemory(chatId);

  await bot.sendMessage(chatId, "Память этого чата очищена.", MAIN_KEYBOARD);
}

async function handleMenuButton(chatId, text) {
  if (text === BUTTONS.menu) {
    await sendMainMenu(chatId);
    return true;
  }

  if (text === BUTTONS.help) {
    await sendHelp(chatId);
    return true;
  }

  if (text === BUTTONS.voice) {
    await sendVoiceHelp(chatId);
    return true;
  }

  if (text === BUTTONS.status) {
    await sendStatus(chatId);
    return true;
  }

  if (text === BUTTONS.reset) {
    await resetChatMemory(chatId);
    return true;
  }

  return false;
}

async function handleInlineMenu(chatId, messageId, action) {
  if (action === "main") {
    await bot.editMessageText("Панель управления:", {
      chat_id: chatId,
      message_id: messageId,
      ...INLINE_MENU,
    });
    return;
  }

  if (action === "help") {
    await sendHelp(chatId);
    return;
  }

  if (action === "voice") {
    await sendVoiceHelp(chatId);
    return;
  }

  if (action === "status") {
    await sendStatus(chatId);
    return;
  }

  if (action === "reset") {
    await resetChatMemory(chatId);
  }
}

module.exports = {
  initCommands,
  BUTTONS,
  MAIN_KEYBOARD,
  INLINE_MENU,
  BOT_COMMANDS,
  sendMainMenu,
  sendHelp,
  sendVoiceHelp,
  sendStatus,
  sendBotToBotStatus,
  sendBotMessageFromCommand,
  resetChatMemory,
  handleMenuButton,
  handleInlineMenu,
};
