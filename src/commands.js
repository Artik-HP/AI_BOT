const CONFIG = require("./config");
const logger = require("./utils/logger");
const { safeHandler } = require("./utils/safe");
const { getSttModels } = require("./services/openrouter");
const {
  getBotToBotStatus,
  isAddressedToThisBot,
  sendMessageToBot
} = require("./services/telegram");
const {
  MAX_HISTORY_MESSAGES,
  MAX_STORED_MESSAGES,
  getUserMemory,
  resetMemory
} = require("./services/memory");
const { isOwner } = require("./services/access");
const { admitCallback, admitMessage } = require("./handlers/guard");

let bot;

function onUserText(regexp, callback) {
  bot.onText(regexp, safeHandler(`Command ${regexp.source.slice(0, 24)}`, async (msg, match) => {
    if (msg.from?.is_bot || !isAddressedToThisBot(msg.text)) {
      return;
    }

    if (!await admitMessage(bot, msg)) {
      return;
    }

    await callback(msg, match);
  }));
}

const BUTTONS = {
  help: "Помощь",
  status: "Статус",
  voice: "Голосовые",
  reset: "Очистить память",
  menu: "Меню",
  lab: "🔬 AI-лаборатория"
};

const MAIN_KEYBOARD = {
  reply_markup: {
    keyboard: [
      [{ text: BUTTONS.help }, { text: BUTTONS.status }],
      [{ text: BUTTONS.voice }, { text: BUTTONS.reset }],
      [{ text: BUTTONS.menu }],
      ...(CONFIG.AI_LAB_ENABLED ? [[{ text: BUTTONS.lab }]] : [])
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "Напиши текст или отправь голосовое"
  }
};

const INLINE_MENU = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: BUTTONS.help, callback_data: "menu:help" },
        { text: BUTTONS.status, callback_data: "menu:status" }
      ],
      [
        { text: BUTTONS.voice, callback_data: "menu:voice" },
        { text: BUTTONS.reset, callback_data: "menu:reset" }
      ],
      [{ text: BUTTONS.menu, callback_data: "menu:main" }]
    ]
  }
};

// Every command has one definition: the Telegram menu and /help are generated from it.
const PUBLIC_COMMANDS = [
  { command: "start", description: "Запустить бота и показать меню" },
  { command: "menu", description: "Показать кнопки", usage: "/menu - показать кнопки" },
  { command: "help", description: "Что умеет бот" },
  { command: "voice", description: "Как работают голосовые", usage: "/voice - как отправлять голосовые" },
  { command: "status", description: "Проверить память и лимиты", usage: "/status - память и лимиты" },
  { command: "reset", description: "Очистить память этого чата", usage: "/reset - очистить память этого чата" },
  ...(CONFIG.AI_LAB_ENABLED ? [{ command: "lab", description: "AI-лаборатория", usage: "/lab - идеи, эксперименты, обучение и инструменты" }] : [])
];

const OWNER_COMMANDS = [
  { command: "account_help", description: "Список команд аккаунт-ассистента", usage: "/account_help - показать команды аккаунт-ассистента" },
  { command: "account_status", description: "Статус Telegram-ассистента аккаунта", usage: "/account_status - статус ассистента аккаунта" },
  { command: "account_config", description: "Показать настройки аккаунт-ассистента", usage: "/account_config - настройки аккаунт-ассистента" },
  { command: "account_pending", description: "Черновики ответов для аккаунта", usage: "/account_pending - активные черновики ответов" },
  { command: "account_send", description: "Отправить черновик: /account_send id", usage: "/account_send id - отправить черновик" },
  { command: "account_drop", description: "Отклонить черновик: /account_drop id", usage: "/account_drop id - отклонить черновик" },
  { command: "account_reply", description: "Отправить свой текст: /account_reply id текст", usage: "/account_reply id текст - отправить свой текст" },
  { command: "account_redraft", description: "Обновить draft AI: /account_redraft id", usage: "/account_redraft id - получить новый AI-черновик" },
  { command: "account_message", description: "Написать от аккаунта: /account_message chatId|@username текст", usage: "/account_message @username текст - отправить сообщение от аккаунта" },
  { command: "account_mode", description: "Показать или сменить режим", usage: "/account_mode approval|auto|dry-run - сменить режим" },
  { command: "account_private", description: "Включить/выключить private-only", usage: "/account_private true|false - личные чаты только/все" },
  { command: "account_allow", description: "Добавить разрешённый чат", usage: "/account_allow @username - добавить разрешённый чат" },
  { command: "account_unallow", description: "Убрать разрешённый чат", usage: "/account_unallow @username - убрать разрешённый чат" },
  { command: "account_block", description: "Добавить заблокированный чат", usage: "/account_block @username - добавить заблокированный чат" },
  { command: "account_unblock", description: "Убрать заблокированный чат", usage: "/account_unblock @username - убрать заблокированный чат" },
  { command: "account_enable", description: "Включить аккаунт-ассистента", usage: "/account_enable - включить аккаунт-ассистента" },
  { command: "account_disable", description: "Отключить аккаунт-ассистента", usage: "/account_disable - выключить аккаунт-ассистента" },
  { command: "bot_status", description: "Статус общения с другими ботами", usage: "/bot_status - статус общения с другими ботами" },
  { command: "bot_send", description: "Написать целевому боту: /bot_send текст", usage: "/bot_send текст или /bot_send @username текст - написать боту" }
];

const BOT_COMMANDS = [...PUBLIC_COMMANDS, ...OWNER_COMMANDS];

function toMenuEntry({ command, description }) {
  return { command, description };
}

// Everyone sees the public commands; the owner's chat additionally gets the admin ones.
function registerCommandMenus(telegramBot) {
  telegramBot.setMyCommands(PUBLIC_COMMANDS.map(toMenuEntry)).catch((error) => {
    logger.error("Telegram commands setup error:", error);
  });

  for (const ownerId of CONFIG.OWNER_CHAT_IDS) {
    telegramBot.setMyCommands(BOT_COMMANDS.map(toMenuEntry), {
      scope: { type: "chat", chat_id: Number(ownerId) }
    }).catch((error) => {
      logger.error("Telegram owner commands setup error:", error);
    });
  }
}

function initCommands(telegramBot) {
  bot = telegramBot;

  registerCommandMenus(bot);

  onUserText(/^\/start(?:@\w+)?(?:\s|$)/, async (msg) => {
    const chatId = msg.chat.id;
    return sendMainMenu(chatId);
  });

  onUserText(/^\/help(?:@\w+)?(?:\s|$)/, async (msg) => {
    const chatId = msg.chat.id;
    return sendHelp(chatId);
  });

  onUserText(/^\/reset(?:@\w+)?(?:\s|$)/, async (msg) => {
    const chatId = msg.chat.id;
    return resetChatMemory(chatId);
  });

  onUserText(/^\/menu(?:@\w+)?(?:\s|$)/, async (msg) => {
    await sendMainMenu(msg.chat.id);
  });

  onUserText(/^\/voice(?:@\w+)?(?:\s|$)/, async (msg) => {
    await sendVoiceHelp(msg.chat.id);
  });

  onUserText(/^\/status(?:@\w+)?(?:\s|$)/, async (msg) => {
    await sendStatus(msg.chat.id);
  });

  onUserText(/^\/bot_status(?:@\w+)?(?:\s|$)/, async (msg) => {
    await sendBotToBotStatus(msg.chat.id);
  });

  onUserText(/^\/bot_send(?:@\w+)?(?:\s|$)/, async (msg) => {
    await sendBotMessageFromCommand(msg.chat.id, msg.text);
  });

  bot.on("callback_query", safeHandler("Menu callback", async (query) => {
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const data = query.data || "";

    if (!chatId || !messageId || !data.startsWith("menu:")) {
      return;
    }

    if (!await admitCallback(bot, query)) {
      return;
    }

    try {
      await bot.answerCallbackQuery(query.id);
      await handleInlineMenu(chatId, messageId, data.slice("menu:".length));
    } catch (error) {
      logger.error("Inline menu error:", error);
      await bot.answerCallbackQuery(query.id, {
        text: "Не получилось выполнить кнопку. Попробуй ещё раз.",
        show_alert: false
      }).catch(() => {});
    }
  }));
}

async function sendMainMenu(chatId) {
  await bot.sendMessage(
    chatId,
    [
      "Я на месте. Кнопки снизу, голосовые тоже слушаю.",
      "",
      "Можешь просто писать текстом, отправлять voice или выбрать команду:"
    ].join("\n"),
    MAIN_KEYBOARD
  );

  await bot.sendMessage(chatId, "Панель управления:", INLINE_MENU);
}

async function sendHelp(chatId) {
  const lines = [
    "Команды:",
    ...PUBLIC_COMMANDS.filter((entry) => entry.usage).map((entry) => entry.usage)
  ];

  if (isOwner(chatId)) {
    lines.push("", "Команды владельца:", ...OWNER_COMMANDS.map((entry) => entry.usage));
  }

  lines.push("", "Кнопки делают то же самое, только без ручного набора команд.");

  await bot.sendMessage(chatId, lines.join("\n"), MAIN_KEYBOARD);
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
      `Лимит файла: ${Math.round(CONFIG.MAX_AUDIO_BYTES / 1024 / 1024)} MB (Telegram отдаёт ботам файлы до 20 MB).`
    ].join("\n"),
    MAIN_KEYBOARD
  );
}

async function sendStatus(chatId) {
  const memory = getUserMemory(chatId);
  const lines = [
    "Статус:",
    `Сообщений сохранено: ${memory.messages.length}/${MAX_STORED_MESSAGES}`,
    `В запрос к AI идет последних сообщений: ${Math.min(memory.messages.length, MAX_HISTORY_MESSAGES)}/${MAX_HISTORY_MESSAGES}`,
    `Долгая память: ${memory.summary ? `${memory.summary.length} символов` : "пусто"}`,
    `Mood: ${memory.mood}`,
    `Trust: ${memory.trust}`,
    `Style: ${memory.style}`,
    `Nickname: ${memory.nickname || "-"}`,
    `Лимит аудио: ${Math.round(CONFIG.MAX_AUDIO_BYTES / 1024 / 1024)} MB`
  ];

  if (isOwner(chatId)) {
    const botToBot = getBotToBotStatus();

    lines.splice(
      1,
      0,
      `AI-модель: ${CONFIG.MODEL}`,
      `STT-модели: ${getSttModels().join(", ")}`,
      `Audio fallback: ${CONFIG.AUDIO_FALLBACK_MODEL}`
    );
    lines.splice(
      -1,
      0,
      `Bot-to-bot: ${botToBot.enabled ? "on" : "off"}`,
      `Bot-to-bot chat: ${botToBot.chatId || "-"}`,
      `Bot-to-bot target: ${botToBot.targetBotUsername ? `@${botToBot.targetBotUsername}` : "-"}`
    );
  }

  await bot.sendMessage(chatId, lines.join("\n"), MAIN_KEYBOARD);
}

function isBotToBotOwner(chatId) {
  return (
    CONFIG.BOT_TO_BOT_OWNER_CHAT_ID &&
    String(chatId) === String(CONFIG.BOT_TO_BOT_OWNER_CHAT_ID)
  );
}

async function ensureBotToBotOwner(chatId) {
  if (!CONFIG.BOT_TO_BOT_OWNER_CHAT_ID) {
    await bot.sendMessage(chatId, "Укажи BOT_TO_BOT_OWNER_CHAT_ID в переменных окружения.");
    return false;
  }

  if (!isBotToBotOwner(chatId)) {
    await bot.sendMessage(chatId, "Эта команда доступна только владельцу бота.");
    return false;
  }

  return true;
}

async function sendBotToBotStatus(chatId) {
  if (!await ensureBotToBotOwner(chatId)) {
    return;
  }

  const status = getBotToBotStatus();

  await bot.sendMessage(chatId, [
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
    "Начать разговор: /bot_send текст или /bot_send @username текст"
  ].join("\n"));
}

// Takes the text after the command as is, so line breaks in the message survive.
function parseBotSendArguments(text, status) {
  const args = String(text || "").replace(/^\/bot_send(?:@\w+)?[ \t]*/i, "").trim();
  const explicitTarget = args.match(/^(@[a-z0-9_]{5,32})\s+([\s\S]+)$/i);
  const legacyTarget = args.match(/^([a-z0-9_]{5,32})\s+([\s\S]+)$/i);
  const knownLegacyTarget = legacyTarget && (
    legacyTarget[1].toLowerCase() === status.targetBotUsername ||
    status.allowBots.map((allowedBot) => String(allowedBot).replace(/^@/, "").toLowerCase())
      .includes(legacyTarget[1].toLowerCase())
  );

  if (explicitTarget) {
    return { username: explicitTarget[1].replace(/^@/, ""), message: explicitTarget[2].trim() };
  }

  if (knownLegacyTarget) {
    return { username: legacyTarget[1], message: legacyTarget[2].trim() };
  }

  return { username: status.targetBotUsername, message: args };
}

async function sendBotMessageFromCommand(chatId, text) {
  if (!await ensureBotToBotOwner(chatId)) {
    return;
  }

  const { username, message } = parseBotSendArguments(text, getBotToBotStatus());

  if (!message) {
    await bot.sendMessage(chatId, "Используй: /bot_send текст или /bot_send @username текст");
    return;
  }

  if (!username) {
    await bot.sendMessage(chatId, "Не задан целевой бот: укажи @username в команде или BOT_TO_BOT_TARGET_BOT_USERNAME в настройках.");
    return;
  }

  try {
    await sendMessageToBot(username, message);
    await bot.sendMessage(chatId, `Сообщение отправлено @${username}.`);
  } catch (error) {
    await bot.sendMessage(chatId, `Не отправил: ${error.response?.body?.description || error.message}`);
  }
}

async function resetChatMemory(chatId) {
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
      ...INLINE_MENU
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
  PUBLIC_COMMANDS,
  OWNER_COMMANDS,
  sendMainMenu,
  sendHelp,
  sendVoiceHelp,
  sendStatus,
  sendBotToBotStatus,
  sendBotMessageFromCommand,
  resetChatMemory,
  handleMenuButton,
  handleInlineMenu
};
