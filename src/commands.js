const CONFIG = require("./config");
const crypto = require("crypto");
const { auth, withMessageAuth } = require("./services/auth");
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
  getPersona,
  getUserMemory,
  setPersona
} = require("./services/memory");
const lifecycle = require("./lifecycle");
const { formatTime } = require("./utils/time");
const { PERSONAS, parsePersonaName, personaLabel } = require("./companion/persona");
const { cancelDaily, cancelReminders, dailyOf, listReminders, setDaily } = require("./companion/reminders");
const { getStore } = require("./companion/store");
const { isOwner } = require("./services/access");
const { redact } = require("./utils/redact");
const { admitAuthenticated, admitCallback, admitMessage, messageAuthorized } = require("./handlers/guard");
const { IDEA_BUTTONS, IDEA_COMMANDS, dateStamp, kindForButton, createIdeaCommands, startSparkCode } = require("./handlers/ideas");
const { callbackMessage, registerActions } = require("./handlers/actions");
const { answerWithAi } = require("./handlers/reply");

let bot;
let ideaCommands;
const menuSessions = new Map();

function boundInlineMenu(chatId, userId, messageId = null) {
  for (const [key, item] of menuSessions) if (!auth.valid(item.lease)) menuSessions.delete(key);
  if (menuSessions.size >= 1000) menuSessions.delete(menuSessions.keys().next().value);
  const token = crypto.randomBytes(12).toString("hex");
  const entry = { chatId: String(chatId), userId: String(userId), lease: auth.capture(userId), messageId };
  menuSessions.set(token, entry);
  return { entry, options: { reply_markup: { inline_keyboard: INLINE_MENU.reply_markup.inline_keyboard.map((row) => row.map((button) =>
    ({ ...button, callback_data: `menu:${token}:${button.callback_data.slice(5)}` }))) } } };
}

// Registered in src/bot.js (src/lifecycle.js): after a logout or a block this person's inline menus stop working.
const lifecycleHooks = {
  revokeUser(userId) {
    for (const [token, entry] of menuSessions) {
      if (entry.userId === String(userId)) {
        menuSessions.delete(token);
      }
    }
  }
};

// The lab and other personal data exist only in a private chat with the person.
function isPrivateChat(chatId, userId, chatType = "private") {
  return chatType === "private" && String(chatId) === String(userId);
}

function onUserText(regexp, callback) {
  bot.onText(regexp, safeHandler(`Command ${regexp.source.slice(0, 24)}`, async (msg, match) => {
    if (msg.from?.is_bot || !isAddressedToThisBot(msg.text)) {
      return;
    }

    if (!await admitMessage(bot, msg)) {
      return;
    }

    await withMessageAuth(msg, () => callback(msg, match));
  }));
}

const BUTTONS = {
  ...IDEA_BUTTONS,
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
      [{ text: BUTTONS.idea }, { text: BUTTONS.spark }],
      [{ text: BUTTONS.brainstorm }, ...(BUTTONS.ideas ? [{ text: BUTTONS.ideas }] : [])],
      [{ text: BUTTONS.help }, { text: BUTTONS.status }],
      [{ text: BUTTONS.voice }, { text: BUTTONS.reset }],
      [{ text: BUTTONS.menu }],
      ...(CONFIG.AI_LAB_ENABLED ? [[{ text: BUTTONS.lab }]] : [])
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "Назови тему или нажми «🎲 Искра»"
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
  ...IDEA_COMMANDS,
  { command: "menu", description: "Показать кнопки", usage: "/menu - показать кнопки" },
  { command: "help", description: "Что умеет бот" },
  { command: "voice", description: "Как работают голосовые", usage: "/voice - как отправлять голосовые" },
  { command: "status", description: "Проверить память и лимиты", usage: "/status - память и лимиты" },
  { command: "reset", description: "Очистить память этого чата", usage: "/reset - очистить память этого чата" },
  { command: "style", description: "Характер бота: идеи, собеседник или классика", usage: "/style - характер бота (идеи, собеседник или классика)" },
  ...(CONFIG.COMPANION_TOOLS_ENABLED ? [
    { command: "reminders", description: "Мои напоминания", usage: "/reminders - мои напоминания, /reminders clear - отменить все" },
    { command: "daily", description: "Искра дня", usage: "/daily 09:00 - искра каждый день в это время (в личном чате), /daily off - выключить" }
  ] : []),
  { command: "login", description: "Войти по паролю", usage: "/login - войти заново" },
  { command: "logout", description: "Закрыть доступ", usage: "/logout - выйти и закрыть доступ" },
  { command: "me", description: "Мой доступ", usage: "/me - срок и статус доступа" },
  { command: "export", description: "Мои данные одним файлом", usage: "/export - мои данные одним файлом: идеи, факты, напоминания, лаборатория (только в личном чате)" },
  ...(CONFIG.AI_LAB_ENABLED ? [{ command: "lab", description: "AI-лаборатория", usage: "/lab - идеи, эксперименты, обучение и инструменты" }] : [])
];

const OWNER_COMMANDS = [
  { command: "users", description: "Пользователи продукта", usage: "/users - пользователи и доступ" },
  { command: "access", description: "Доступ: ID active|blocked [дни]", usage: "/access ID active|blocked [дни] - предварительный просмотр изменения доступа" },
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
  ideaCommands = createIdeaCommands({ bot, keyboard: MAIN_KEYBOARD });

  registerCommandMenus(bot);
  // Buttons under the spark card and under a reply with ideas (src/handlers/actions.js). A press under ideas is the
  // words a person would type, sent to the model through the usual pipeline.
  registerActions(bot, {
    spark: (query, entry) => ideaCommands.sparkButton(query, entry),
    ideas: (query, entry) => ({ run: () => answerWithAi(bot, callbackMessage(query), entry.data.text) }),
    daily: (query, entry) => ideaCommands.dailyButton(query, entry)
  });

  onUserText(/^\/start(?:@\w+)?(?:\s|$)/, async (msg) => {
    const chatId = msg.chat.id;
    await sendMainMenu(chatId, msg.from.id);

    // "Развить в Telegram" on the website opens t.me/<bot>?start=spark_<код>: the menu, then that very spark.
    const code = startSparkCode(msg.text);

    if (code) {
      await ideaCommands.sparkFromCode(msg, code);
    }
  });

  for (const { command } of IDEA_COMMANDS) {
    onUserText(new RegExp(`^/${command}(?:@\\w+)?(?:\\s|$)`), (msg) => ideaCommands.command(command, msg));
  }

  onUserText(/^\/help(?:@\w+)?(?:\s|$)/, async (msg) => {
    const chatId = msg.chat.id;
    return sendHelp(chatId);
  });

  onUserText(/^\/reset(?:@\w+)?(?:\s|$)/, async (msg) => {
    const chatId = msg.chat.id;
    return resetChatMemory(chatId);
  });

  onUserText(/^\/style(?:@\w+)?(?:\s|$)/, async (msg) => {
    await handleStyle(msg);
  });

  if (CONFIG.COMPANION_TOOLS_ENABLED) {
    onUserText(/^\/reminders(?:@\w+)?(?:\s|$)/, async (msg) => {
      await handleReminders(msg);
    });

    onUserText(/^\/daily(?:@\w+)?(?:\s|$)/, async (msg) => {
      await handleDaily(msg);
    });
  }

  onUserText(/^\/export(?:@\w+)?(?:\s|$)/, async (msg) => {
    await sendExport(msg);
  });

  onUserText(/^\/menu(?:@\w+)?(?:\s|$)/, async (msg) => {
    await sendMainMenu(msg.chat.id, msg.from.id);
  });

  onUserText(/^\/voice(?:@\w+)?(?:\s|$)/, async (msg) => {
    await sendVoiceHelp(msg.chat.id);
  });

  onUserText(/^\/status(?:@\w+)?(?:\s|$)/, async (msg) => {
    await sendStatus(msg.chat.id, { userId: msg.from.id, isPrivate: isPrivateChat(msg.chat.id, msg.from.id, msg.chat.type) });
  });

  onUserText(/^\/bot_status(?:@\w+)?(?:\s|$)/, async (msg) => {
    await sendBotToBotStatus(msg.chat.id, msg.from.id);
  });

  onUserText(/^\/bot_send(?:@\w+)?(?:\s|$)/, async (msg) => {
    await sendBotMessageFromCommand(msg.chat.id, msg.text, msg.from.id);
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

    const [, token, action] = data.split(":");
    const entry = menuSessions.get(token);
    if (!entry || !auth.valid(entry.lease) || entry.userId !== String(query.from.id) || entry.chatId !== String(chatId) || entry.messageId !== messageId) {
      await bot.answerCallbackQuery(query.id, { text: "Кнопка истекла. Открой /menu заново." }).catch(() => {});
      return;
    }

    try {
      await bot.answerCallbackQuery(query.id);
      await handleInlineMenu(chatId, messageId, action, query.from.id, query.message.chat.type);
    } catch (error) {
      logger.error("Inline menu error:", error);
      await bot.answerCallbackQuery(query.id, {
        text: "Не получилось выполнить кнопку. Попробуй ещё раз.",
        show_alert: false
      }).catch(() => {});
    }
  }));
}

async function sendMainMenu(chatId, userId = chatId) {
  await bot.sendMessage(
    chatId,
    [
      "Я на месте и полон идей. Назови тему, и я что-нибудь придумаю, или нажми «🎲 Искра», и я удивлю.",
      CONFIG.PRODUCT_NAME,
      "",
      "Можно писать текстом, отправлять голосовое или выбрать кнопку:"
    ].join("\n"),
    MAIN_KEYBOARD
  );

  const menu = boundInlineMenu(chatId, userId);
  const sent = await bot.sendMessage(chatId, "Панель управления:", menu.options);
  menu.entry.messageId = sent.message_id;
}

// After a password login: the menu, then the spark of a "/start spark_<код>" link the person came with. The password
// message is never passed on: the spark gets a message of its own with only the chat and the author, and a lease of
// the session that has just been opened. The login consumed the original message before the allow-list and the rate
// limit, so the spark is admitted by them here, like any message.
async function afterLogin(msg, payload = null) {
  await sendMainMenu(msg.chat.id, msg.from.id);

  const code = payload ? startSparkCode(`/start ${payload}`) : null;

  if (code) {
    const start = { message_id: `login:${crypto.randomBytes(6).toString("hex")}`, chat: msg.chat, from: msg.from, date: msg.date };

    if (await admitAuthenticated(bot, start)) {
      await ideaCommands.sparkFromCode(start, code);
    }
  }
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

// The chat's own lines first, unchanged; then the lines of the modules registered in src/lifecycle.js (idea bank,
// reminders, lab). A module that fails gives no line, and /status answers anyway.
async function sendStatus(chatId, { userId = chatId, isPrivate = isPrivateChat(chatId, userId) } = {}) {
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
    `Характер: ${personaLabel(getPersona(chatId))}`,
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

  const modules = await lifecycle.statusLines({ chatId: String(chatId), userId: String(userId), isPrivate });

  await bot.sendMessage(chatId, [...lines, ...modules.lines].join("\n"), MAIN_KEYBOARD);
}

function isBotToBotOwner(chatId, userId) {
  return (
    CONFIG.BOT_TO_BOT_OWNER_CHAT_ID &&
    /^\d+$/.test(String(chatId)) &&
    String(chatId) === String(CONFIG.BOT_TO_BOT_OWNER_CHAT_ID) &&
    String(userId) === String(CONFIG.BOT_TO_BOT_OWNER_CHAT_ID)
  );
}

async function ensureBotToBotOwner(chatId, userId) {
  if (!CONFIG.BOT_TO_BOT_OWNER_CHAT_ID) {
    await bot.sendMessage(chatId, "Укажи BOT_TO_BOT_OWNER_CHAT_ID в переменных окружения.");
    return false;
  }

  if (!isBotToBotOwner(chatId, userId)) {
    await bot.sendMessage(chatId, "Эта команда доступна только владельцу бота.");
    return false;
  }

  return true;
}

async function sendBotToBotStatus(chatId, userId = chatId) {
  if (!await ensureBotToBotOwner(chatId, userId)) {
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

async function sendBotMessageFromCommand(chatId, text, userId = chatId) {
  if (!await ensureBotToBotOwner(chatId, userId)) {
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

const STYLE_LINES = {
  ideas: "/style идеи - придумываю идеи: искры, приёмы, банк идей",
  companion: "/style собеседник - игры, RPG и мини-программы, без мата и 18+",
  classic: "/style классика - прежний острый характер: сарказм, мат, фарма и JavaScript"
};

async function handleStyle(msg) {
  const chatId = msg.chat.id;
  const argument = String(msg.text || "").replace(/^\/style(?:@\w+)?/i, "").trim();

  if (!argument) {
    await bot.sendMessage(chatId, [
      `Сейчас: ${personaLabel(getPersona(chatId))}.`,
      "",
      ...PERSONAS.map((persona) => `${STYLE_LINES[persona]}${persona === CONFIG.COMPANION_DEFAULT_PERSONA ? " (по умолчанию)" : ""}`)
    ].join("\n"), MAIN_KEYBOARD);
    return;
  }

  const next = parsePersonaName(argument);

  if (!next) {
    await bot.sendMessage(chatId, "Такого характера нет. Варианты: идеи, собеседник, классика.", MAIN_KEYBOARD);
    return;
  }

  if (msg.chat.type !== "private" && !isOwner(msg.from?.id)) {
    await bot.sendMessage(chatId, "В группе характер меняет только владелец бота.");
    return;
  }

  setPersona(chatId, next);
  await bot.sendMessage(chatId, `Готово, теперь характер: ${personaLabel(next)}.`, MAIN_KEYBOARD);
}

async function handleReminders(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id ?? chatId;
  const argument = String(msg.text || "").replace(/^\/reminders(?:@\w+)?/i, "").trim().toLowerCase();

  try {
    const store = getStore();
    const cancelOne = argument.match(/^(?:cancel|отмена)\s+([0-9a-f]{8})$/);

    if (argument === "clear" || argument === "очистить" || cancelOne) {
      const removed = cancelReminders(store, chatId, userId, cancelOne ? cancelOne[1] : null);

      await bot.sendMessage(chatId, removed ? `Отменено напоминаний: ${removed}.` : "Отменять нечего.");
      return;
    }

    const list = listReminders(store, chatId, userId);

    if (!list.length) {
      await bot.sendMessage(chatId, "Напоминаний нет. Попроси меня в разговоре: «напомни через час позвонить маме».");
      return;
    }

    await bot.sendMessage(chatId, [
      "Твои напоминания:",
      ...list.map((item) => `${formatTime(item.dueAt, CONFIG.BOT_TIMEZONE)} - ${item.text} (код ${item.id})${item.ideaId ? ` (идея ${item.ideaId})` : ""}`),
      "",
      "Отменить одно: /reminders cancel код. Отменить все: /reminders clear."
    ].join("\n"));
  } catch (error) {
    logger.error("Reminders command error:", error);
    await bot.sendMessage(chatId, "Напоминания сейчас недоступны. Попробуй позже.");
  }
}

const DAILY_TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

// "/daily 09:00" — a spark card without AI every day at that time (BOT_TIMEZONE, otherwise UTC, and the answer says
// which), with a button for the ideas; "/daily off" switches it off; "/daily" shows the state. Private chat only.
async function handleDaily(msg) {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const argument = String(msg.text || "").replace(/^\/daily(?:@\w+)?/i, "").trim().toLowerCase();
  const zone = CONFIG.BOT_TIMEZONE;
  const zoneNote = zone ? `по времени ${zone}` : "по UTC: часовой пояс бота не задан";

  if (!isPrivateChat(chatId, userId, msg.chat.type)) {
    await bot.sendMessage(chatId, "Искра дня приходит в личный диалог с ботом: включи её там командой /daily 09:00.");
    return;
  }

  try {
    const store = getStore();
    const time = argument.match(DAILY_TIME);

    if (["off", "выкл", "стоп", "stop"].includes(argument)) {
      await bot.sendMessage(chatId, cancelDaily(store, userId) ? "Искра дня выключена." : "Искра дня и так выключена. Включить: /daily 09:00.");
    } else if (time) {
      const entry = setDaily(store, { chatId, userId, time: `${time[1].padStart(2, "0")}:${time[2]}`, timeZone: zone }, Date.now());

      await bot.sendMessage(chatId, `Готово: каждый день в ${entry.time} (${zoneNote}) пришлю искру без AI, а идеи к ней — по кнопке. ` +
        `Первая: ${formatTime(entry.nextAt, zone)}. Выключить: /daily off.`);
    } else if (!argument) {
      const entry = dailyOf(store, userId);

      await bot.sendMessage(chatId, entry
        ? `Искра дня: каждый день в ${entry.time} (${entry.timeZone ? `по времени ${entry.timeZone}` : "по UTC"}). Следующая: ${formatTime(entry.nextAt, entry.timeZone)}. Выключить: /daily off.`
        : `Искра дня выключена. Включить: /daily 09:00 (${zoneNote}).`);
    } else {
      await bot.sendMessage(chatId, "Формат: /daily 09:00 (часы и минуты) или /daily off.");
    }
  } catch (error) {
    logger.error("Daily spark command error:", error);
    await bot.sendMessage(chatId, "Искра дня сейчас недоступна. Попробуй позже.");
  }
}

// The scheduler (src/companion/reminders.js) calls this at the time of a daily spark.
function deliverDaily(entry) {
  return ideaCommands.deliverDaily(entry);
}

// "My data": one JSON file with what the modules registered in src/lifecycle.js keep about this person (ideas, facts,
// reminders, lab), only in the private chat, without AI. The chat history (memory.json) is not part of it. The whole
// file goes through redact(): a configured secret that ended up in someone's text is masked.
async function sendExport(msg) {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);

  if (!isPrivateChat(chatId, userId, msg.chat.type)) {
    await bot.sendMessage(chatId, "Открой /export в личном диалоге с ботом: файл с твоими данными приходит только туда.");
    return;
  }

  const { data, failed } = await lifecycle.exportData({ userId });
  const file = { version: 1, exportedAt: new Date().toISOString(), userId, ...data, ...(failed.length ? { unavailable: failed } : {}) };

  if (!messageAuthorized(msg)) return;
  await bot.sendDocument(chatId, Buffer.from(redact(JSON.stringify(file, null, 2))), {}, { filename: `my-data-${dateStamp()}.json`, contentType: "application/json" });
}

// What /reset forgets is decided by the modules registered in src/lifecycle.js: the talk, the recent sparks and the
// saved facts. The character of the chat, game progress, ideas, reminders and the lab stay.
async function resetChatMemory(chatId) {
  await lifecycle.forgetChat(chatId);
  await bot.sendMessage(chatId, "Память этого чата очищена.", MAIN_KEYBOARD);
}

// `msg` is the whole incoming message: the idea buttons start a request to the model, which needs its author and chat.
async function handleMenuButton(chatId, text, userId = chatId, msg = null) {
  const ideaKind = kindForButton(text);

  if (ideaKind) {
    if (!msg || !ideaCommands) {
      return false;
    }

    await ideaCommands.button(ideaKind, msg);
    return true;
  }

  if (text === BUTTONS.menu) {
    await sendMainMenu(chatId, userId);
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
    await sendStatus(chatId, { userId, isPrivate: isPrivateChat(chatId, userId, msg?.chat?.type) });
    return true;
  }

  if (text === BUTTONS.reset) {
    await resetChatMemory(chatId);
    return true;
  }

  return false;
}

async function handleInlineMenu(chatId, messageId, action, userId = chatId, chatType = "private") {
  if (action === "main") {
    const menu = boundInlineMenu(chatId, userId, messageId);
    await bot.editMessageText("Панель управления:", {
      chat_id: chatId,
      message_id: messageId,
      ...menu.options
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
    await sendStatus(chatId, { userId, isPrivate: isPrivateChat(chatId, userId, chatType) });
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
  afterLogin,
  deliverDaily,
  sendHelp,
  sendVoiceHelp,
  sendStatus,
  sendBotToBotStatus,
  sendBotMessageFromCommand,
  resetChatMemory,
  handleMenuButton,
  handleInlineMenu,
  isPrivateChat,
  lifecycleHooks
};
