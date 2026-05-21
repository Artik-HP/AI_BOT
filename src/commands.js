const CONFIG = require("./config");
const { getSttModels } = require("./services/openrouter");
const {
  MAX_HISTORY_MESSAGES,
  getUserMemory,
  resetMemory
} = require("./services/memory");

let bot;

const BUTTONS = {
  help: "Помощь",
  status: "Статус",
  voice: "Голосовые",
  reset: "Очистить память",
  menu: "Меню"
};

const MAIN_KEYBOARD = {
  reply_markup: {
    keyboard: [
      [{ text: BUTTONS.help }, { text: BUTTONS.status }],
      [{ text: BUTTONS.voice }, { text: BUTTONS.reset }],
      [{ text: BUTTONS.menu }]
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

const BOT_COMMANDS = [
  { command: "start", description: "Запустить бота и показать меню" },
  { command: "menu", description: "Показать красивые кнопки" },
  { command: "help", description: "Что умеет бот" },
  { command: "voice", description: "Как работают голосовые" },
  { command: "status", description: "Проверить модели и память" },
  { command: "reset", description: "Очистить память этого чата" }
];

function initCommands(telegramBot) {
  bot = telegramBot;

  bot.setMyCommands(BOT_COMMANDS).catch((error) => {
    console.error("Telegram commands setup error:", error.message);
  });

  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    return sendMainMenu(chatId);
  });

  bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    return sendHelp(chatId);
  });

  bot.onText(/\/reset/, async (msg) => {
    const chatId = msg.chat.id;
    return resetChatMemory(chatId);
  });

  bot.onText(/\/menu/, async (msg) => {
    await sendMainMenu(msg.chat.id);
  });

  bot.onText(/\/voice/, async (msg) => {
    await sendVoiceHelp(msg.chat.id);
  });

  bot.onText(/\/status/, async (msg) => {
    await sendStatus(msg.chat.id);
  });

  bot.on("callback_query", async (query) => {
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const data = query.data || "";

    if (!chatId || !messageId || !data.startsWith("menu:")) {
      return;
    }

    try {
      await bot.answerCallbackQuery(query.id);
      await handleInlineMenu(chatId, messageId, data.slice("menu:".length));
    } catch (error) {
      console.error("Inline menu error:", error.response?.data || error.message);
      await bot.answerCallbackQuery(query.id, {
        text: "Не вышло выполнить кнопку. Проверь консоль.",
        show_alert: false
      }).catch(() => {});
    }
  });
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
  await bot.sendMessage(
    chatId,
    [
      "Команды:",
      "/menu - показать кнопки",
      "/voice - как отправлять голосовые",
      "/status - модели, память и лимиты",
      "/reset - очистить память этого чата",
      "",
      "Кнопки делают то же самое, только без ручного набора команд."
    ].join("\n"),
    MAIN_KEYBOARD
  );
}

async function sendVoiceHelp(chatId) {
  await bot.sendMessage(
    chatId,
    [
      "Голосовые:",
      "1. Отправь обычное voice-сообщение в Telegram.",
      "2. Я скачаю аудио, расшифрую его и отвечу как на текст.",
      "3. Если Telegram или OpenRouter споткнутся, причина будет в консоли.",
      "",
      `Лимит файла: ${Math.round(CONFIG.MAX_AUDIO_BYTES / 1024 / 1024)} MB.`
    ].join("\n"),
    MAIN_KEYBOARD
  );
}

async function sendStatus(chatId) {
  const memory = getUserMemory(chatId);

  await bot.sendMessage(
    chatId,
    [
      "Статус:",
      `AI-модель: ${CONFIG.MODEL}`,
      `STT-модели: ${getSttModels().join(", ")}`,
      `Audio fallback: ${CONFIG.AUDIO_FALLBACK_MODEL}`,
      `Сообщений в памяти чата: ${memory.messages.length}/${MAX_HISTORY_MESSAGES}`,
      `Mood: ${memory.mood}`,
      `Trust: ${memory.trust}`,
      `Style: ${memory.style}`,
      `Nickname: ${memory.nickname || "-"}`,
      `Лимит аудио: ${Math.round(CONFIG.MAX_AUDIO_BYTES / 1024 / 1024)} MB`
    ].join("\n"),
    MAIN_KEYBOARD
  );
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
  sendMainMenu,
  sendHelp,
  sendVoiceHelp,
  sendStatus,
  resetChatMemory,
  handleMenuButton,
  handleInlineMenu
};
