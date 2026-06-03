const CONFIG = require("./config");
const { getSttModels } = require("./services/openrouter");
const {
  getBotToBotStatus,
  sendMessageToBot
} = require("./services/telegram");
const {
  MAX_HISTORY_MESSAGES,
  MAX_STORED_MESSAGES,
  getUserMemory,
  resetMemory,
  setTtsVoice,
  setVoiceEnabled,
  toggleVoiceEnabled
} = require("./services/memory");

let bot;

function onUserText(regexp, callback) {
  bot.onText(regexp, async (msg, match) => {
    if (msg.from?.is_bot) {
      return;
    }

    await callback(msg, match);
  });
}

const BUTTONS = {
  help: "Помощь",
  status: "Статус",
  voice: "Голосовые",
  voiceToggle: "Вкл/выкл голос",
  voiceChange: "Сменить голос",
  reset: "Очистить память",
  menu: "Меню"
};

const MAIN_KEYBOARD = {
  reply_markup: {
    keyboard: [
      [{ text: BUTTONS.help }, { text: BUTTONS.status }],
      [{ text: BUTTONS.voice }, { text: BUTTONS.reset }],
      [{ text: BUTTONS.voiceToggle }, { text: BUTTONS.voiceChange }],
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
      [
        { text: BUTTONS.voiceToggle, callback_data: "menu:voice_toggle" },
        { text: BUTTONS.voiceChange, callback_data: "menu:voice_picker" }
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
  { command: "voice_on", description: "Включить голосовые ответы бота" },
  { command: "voice_off", description: "Выключить голосовые ответы бота" },
  { command: "voice_toggle", description: "Переключить голосовые ответы" },
  { command: "voices", description: "Выбрать голос бота" },
  { command: "voice_set", description: "Изменить голос: /voice_set nova" },
  { command: "status", description: "Проверить модели и память" },
  { command: "account_help", description: "Список команд аккаунт-ассистента" },
  { command: "account_status", description: "Статус Telegram-ассистента аккаунта" },
  { command: "account_config", description: "Показать настройки аккаунт-ассистента" },
  { command: "account_pending", description: "Черновики ответов для аккаунта" },
  { command: "account_send", description: "Отправить черновик: /account_send id" },
  { command: "account_drop", description: "Отклонить черновик: /account_drop id" },
  { command: "account_reply", description: "Отправить свой текст: /account_reply id текст" },
  { command: "account_redraft", description: "Обновить draft AI: /account_redraft id" },
  { command: "account_message", description: "Написать от аккаунта: /account_message chatId текст" },
  { command: "account_mode", description: "Показать или сменить режим" },
  { command: "account_private", description: "Включить/выключить private-only" },
  { command: "account_allow", description: "Добавить разрешённый чат" },
  { command: "account_unallow", description: "Убрать разрешённый чат" },
  { command: "account_block", description: "Добавить заблокированный чат" },
  { command: "account_unblock", description: "Убрать заблокированный чат" },
  { command: "account_enable", description: "Включить аккаунт-ассистента" },
  { command: "account_disable", description: "Отключить аккаунт-ассистента" },
  { command: "bot_status", description: "Статус общения с другими ботами" },
  { command: "bot_send", description: "Написать целевому боту: /bot_send текст" },
  { command: "reset", description: "Очистить память этого чата" }
];

function initCommands(telegramBot) {
  bot = telegramBot;

  bot.setMyCommands(BOT_COMMANDS).catch((error) => {
    console.error("Telegram commands setup error:", error.message);
  });

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

  onUserText(/^\/voice_on(?:@\w+)?(?:\s|$)/, async (msg) => {
    await setVoiceMode(msg.chat.id, true);
  });

  onUserText(/^\/voice_off(?:@\w+)?(?:\s|$)/, async (msg) => {
    await setVoiceMode(msg.chat.id, false);
  });

  onUserText(/^\/voice_toggle(?:@\w+)?(?:\s|$)/, async (msg) => {
    await toggleVoiceMode(msg.chat.id);
  });

  onUserText(/^\/voices(?:@\w+)?(?:\s|$)/, async (msg) => {
    await sendVoicePicker(msg.chat.id);
  });

  onUserText(/^\/voice_set(?:@\w+)?(?:\s|$)/, async (msg) => {
    await setVoiceFromCommand(msg.chat.id, msg.text);
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
      "/voice_on - включить голос бота",
      "/voice_off - выключить голос бота",
      "/voice_toggle - переключить голос бота",
      "/voices - выбрать голос кнопками",
      "/voice_set nova - изменить голос командой",
      "/status - модели, память и лимиты",
      "/account_help - показать команды аккаунт-ассистента",
      "/account_status - статус ассистента аккаунта",
      "/account_config - настройки аккаунт-ассистента",
      "/account_pending - активные черновики ответов",
      "/account_send id - отправить черновик",
      "/account_drop id - отклонить черновик",
      "/account_reply id текст - отправить свой текст",
      "/account_redraft id - получить новый AI-черновик",
      "/account_message @username текст - отправить сообщение от аккаунта",
      "/account_mode approval|auto|dry-run - сменить режим",
      "/account_private true|false - личные чаты только/все",
      "/account_allow @username - добавить разрешённый чат",
      "/account_block @username - добавить заблокированный чат",
      "/account_enable - включить аккаунт-ассистента",
      "/account_disable - выключить аккаунт-ассистента",
      "/bot_status - статус общения с другими ботами",
      "/bot_send текст - написать целевому боту",
      "/bot_send @username текст - написать указанному боту",
      "/reset - очистить память этого чата",
      "",
      "Кнопки делают то же самое, только без ручного набора команд."
    ].join("\n"),
    MAIN_KEYBOARD
  );
}

async function sendVoiceHelp(chatId) {
  const memory = getUserMemory(chatId);

  await bot.sendMessage(
    chatId,
    [
      "Голосовые:",
      "1. Отправь обычное voice-сообщение в Telegram.",
      "2. Я скачаю аудио, расшифрую его и отвечу как на текст.",
      "3. Ответ бота можно озвучивать или оставлять текстом.",
      "",
      `Голос бота: ${memory.voiceEnabled ? "включен" : "выключен"}`,
      `Текущий голос: ${memory.ttsVoice || CONFIG.TTS_VOICE}`,
      "",
      "/voice_on - включить озвучку",
      "/voice_off - выключить озвучку",
      "/voice_toggle - переключить озвучку",
      "/voices - выбрать голос кнопками",
      "/voice_set nova - поставить голос командой",
      "",
      `Лимит файла: ${Math.round(CONFIG.MAX_AUDIO_BYTES / 1024 / 1024)} MB.`
    ].join("\n"),
    MAIN_KEYBOARD
  );
}

function buildVoiceSettingsText(memory) {
  return [
    "Голос бота:",
    `Озвучка: ${memory.voiceEnabled ? "включена" : "выключена"}`,
    `Голос: ${memory.ttsVoice || CONFIG.TTS_VOICE}`,
    "",
    "Команды:",
    "/voice_on - включить",
    "/voice_off - выключить",
    "/voice_toggle - переключить",
    "/voices - выбрать кнопками",
    "/voice_set nova - выбрать командой"
  ].join("\n");
}

function buildVoiceSettingsMenu(memory) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: memory.voiceEnabled ? "Выключить голос" : "Включить голос",
            callback_data: "menu:voice_toggle"
          }
        ],
        [{ text: "Сменить голос", callback_data: "menu:voice_picker" }],
        [{ text: "Назад в меню", callback_data: "menu:main" }]
      ]
    }
  };
}

function buildVoicePickerMenu() {
  const rows = CONFIG.TTS_VOICES.map((voice) => ([
    { text: voice, callback_data: `menu:set_voice:${voice}` }
  ]));

  rows.push([{ text: "Назад", callback_data: "menu:voice_settings" }]);

  return {
    reply_markup: {
      inline_keyboard: rows
    }
  };
}

function normalizeTtsVoice(voice) {
  const cleanVoice = String(voice || "").trim().toLowerCase();

  if (!/^[a-z0-9_-]{2,64}$/.test(cleanVoice)) {
    return null;
  }

  return cleanVoice;
}

function parseCommandArg(text) {
  return String(text || "").trim().split(/\s+/).slice(1).join(" ").trim();
}

async function sendVoiceSettings(chatId) {
  const memory = getUserMemory(chatId);
  await bot.sendMessage(chatId, buildVoiceSettingsText(memory), buildVoiceSettingsMenu(memory));
}

async function editVoiceSettings(chatId, messageId) {
  const memory = getUserMemory(chatId);
  await bot.editMessageText(buildVoiceSettingsText(memory), {
    chat_id: chatId,
    message_id: messageId,
    ...buildVoiceSettingsMenu(memory)
  });
}

async function sendVoicePicker(chatId) {
  await bot.sendMessage(
    chatId,
    `Выбери голос бота. Сейчас: ${getUserMemory(chatId).ttsVoice || CONFIG.TTS_VOICE}`,
    buildVoicePickerMenu()
  );
}

async function editVoicePicker(chatId, messageId) {
  await bot.editMessageText(
    `Выбери голос бота. Сейчас: ${getUserMemory(chatId).ttsVoice || CONFIG.TTS_VOICE}`,
    {
      chat_id: chatId,
      message_id: messageId,
      ...buildVoicePickerMenu()
    }
  );
}

async function setVoiceMode(chatId, enabled) {
  const memory = setVoiceEnabled(chatId, enabled);
  await bot.sendMessage(
    chatId,
    `Голос бота ${memory.voiceEnabled ? "включен" : "выключен"}.`,
    MAIN_KEYBOARD
  );
}

async function toggleVoiceMode(chatId) {
  const memory = toggleVoiceEnabled(chatId);
  await bot.sendMessage(
    chatId,
    `Голос бота ${memory.voiceEnabled ? "включен" : "выключен"}.`,
    MAIN_KEYBOARD
  );
}

async function setVoiceFromCommand(chatId, text) {
  const voice = normalizeTtsVoice(parseCommandArg(text));

  if (!voice) {
    await bot.sendMessage(
      chatId,
      `Напиши так: /voice_set nova\nДоступные: ${CONFIG.TTS_VOICES.join(", ")}`,
      MAIN_KEYBOARD
    );
    return;
  }

  await setBotVoice(chatId, voice);
}

async function setBotVoice(chatId, voice) {
  const memory = setTtsVoice(chatId, voice);
  await bot.sendMessage(
    chatId,
    [
      `Голос бота изменен: ${memory.ttsVoice}.`,
      memory.voiceEnabled ? "Озвучка включена." : "Озвучка сейчас выключена. Включить: /voice_on"
    ].join("\n"),
    MAIN_KEYBOARD
  );
}

async function sendStatus(chatId) {
  const memory = getUserMemory(chatId);
  const botToBot = getBotToBotStatus();

  await bot.sendMessage(
    chatId,
    [
      "Статус:",
      `AI-модель: ${CONFIG.MODEL}`,
      `STT-модели: ${getSttModels().join(", ")}`,
      `Audio fallback: ${CONFIG.AUDIO_FALLBACK_MODEL}`,
      `TTS model: ${CONFIG.TTS_MODEL}`,
      `TTS voice: ${memory.ttsVoice || CONFIG.TTS_VOICE}`,
      `Voice replies: ${memory.voiceEnabled ? "on" : "off"}`,
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
      `Лимит аудио: ${Math.round(CONFIG.MAX_AUDIO_BYTES / 1024 / 1024)} MB`
    ].join("\n"),
    MAIN_KEYBOARD
  );
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

async function sendBotMessageFromCommand(chatId, text) {
  if (!await ensureBotToBotOwner(chatId)) {
    return;
  }

  const status = getBotToBotStatus();
  const args = String(text || "").trim().split(/\s+/).slice(1).join(" ").trim();
  const explicitTarget = args.match(/^(@[a-z0-9_]{5,32})\s+([\s\S]+)$/i);
  const legacyTarget = args.match(/^([a-z0-9_]{5,32})\s+([\s\S]+)$/i);
  const knownLegacyTarget = legacyTarget && (
    legacyTarget[1].toLowerCase() === status.targetBotUsername ||
    status.allowBots.map((allowedBot) => String(allowedBot).replace(/^@/, "").toLowerCase())
      .includes(legacyTarget[1].toLowerCase())
  );
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
    await bot.sendMessage(chatId, "Используй: /bot_send текст или /bot_send @username текст");
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

  if (text === BUTTONS.voiceToggle) {
    await toggleVoiceMode(chatId);
    return true;
  }

  if (text === BUTTONS.voiceChange) {
    await sendVoicePicker(chatId);
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

  if (action === "voice_settings") {
    await editVoiceSettings(chatId, messageId);
    return;
  }

  if (action === "voice_toggle") {
    toggleVoiceEnabled(chatId);
    await editVoiceSettings(chatId, messageId);
    return;
  }

  if (action === "voice_picker") {
    await editVoicePicker(chatId, messageId);
    return;
  }

  if (action.startsWith("set_voice:")) {
    const voice = normalizeTtsVoice(action.slice("set_voice:".length));

    if (voice) {
      setTtsVoice(chatId, voice);
    }

    await editVoiceSettings(chatId, messageId);
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
  sendVoiceSettings,
  sendVoicePicker,
  sendStatus,
  sendBotToBotStatus,
  sendBotMessageFromCommand,
  resetChatMemory,
  handleMenuButton,
  handleInlineMenu,
  setVoiceMode,
  toggleVoiceMode,
  setVoiceFromCommand,
  setBotVoice
};
