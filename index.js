require("dotenv").config();

const fs = require("fs");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

console.log("Бот запущен");

// 1. System prompt
const express = require("express");
const CONFIG = {
  MODEL:
    process.env.OPENROUTER_MODEL ||
    "openai/gpt-4o-mini",

  STT_MODEL:
    process.env.OPENROUTER_STT_MODEL ||
    "openai/whisper-large-v3-turbo",

  AUDIO_FALLBACK_MODEL:
    process.env.OPENROUTER_AUDIO_MODEL ||
    "thedrummer/cydonia-24b-v4.1",

  BOT_TOKEN: process.env.BOT_TOKEN,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  PORT: process.env.PORT || 3000,
  STT_LANGUAGE: process.env.OPENROUTER_STT_LANGUAGE,
  MAX_AUDIO_BYTES: Number(process.env.MAX_AUDIO_BYTES || 25 * 1024 * 1024),
  MEMORY_FILE: path.join(__dirname, "memory.json"),
};

const MAX_HISTORY_MESSAGES = 20;
const MAX_PERSONAL_NOTES = 12;
console.log("BOT_TOKEN есть?", !!CONFIG.BOT_TOKEN);
console.log("ENV путь:", process.cwd());
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
{
if (!CONFIG.BOT_TOKEN) 
  throw new Error("BOT_TOKEN не найден в .env");

}

if (!CONFIG.OPENROUTER_API_KEY) {
  throw new Error("OPENROUTER_API_KEY не найден в .env");
}

const app = express();
let users = loadMemory();

console.log("Bot token loaded:", Boolean(CONFIG.BOT_TOKEN));
console.log("OpenRouter key loaded:", Boolean(CONFIG.OPENROUTER_API_KEY));
console.log("Bot started");

function loadMemory() {
  try {
    if (!fs.existsSync(CONFIG.MEMORY_FILE)) {
      return {};
    }

    const raw = fs.readFileSync(CONFIG.MEMORY_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeMemoryStore(parsed);
  } catch (error) {
    console.error("Memory load error:", error.message);
    return {};
  }
}

function saveMemory() {
  try {
    fs.writeFileSync(CONFIG.MEMORY_FILE, JSON.stringify(users, null, 2), "utf8");
  } catch (error) {
    console.error("Memory save error:", error.message);
  }
}

function normalizeMemoryStore(store) {
  if (!store || typeof store !== "object" || Array.isArray(store)) {
    return {};
  }

  const normalized = {};

  for (const [chatId, value] of Object.entries(store)) {
    normalized[chatId] = normalizeUserMemory(value);
  }

  return normalized;
}

function createEmptyMemory() {
  return {
    mood: "neutral",
    messages: [],
    nickname: null,
    trust: 0,
    style: "unknown",
    personalNotes: [],
    messageCount: 0,
    lastSeen: null
  };
}

function normalizeUserMemory(value) {
  const memory = createEmptyMemory();

  if (Array.isArray(value)) {
    memory.messages = value.slice(-MAX_HISTORY_MESSAGES);
    memory.messageCount = value.filter((message) => message?.role === "user").length;
    return memory;
  }

  if (!value || typeof value !== "object") {
    return memory;
  }

  memory.mood = typeof value.mood === "string" ? value.mood : memory.mood;
  memory.messages = Array.isArray(value.messages)
    ? value.messages.slice(-MAX_HISTORY_MESSAGES)
    : [];
  memory.nickname = typeof value.nickname === "string" && value.nickname.trim()
    ? value.nickname.trim()
    : null;
  memory.trust = Number.isFinite(Number(value.trust)) ? Number(value.trust) : 0;
  memory.style = typeof value.style === "string" ? value.style : memory.style;
  memory.personalNotes = Array.isArray(value.personalNotes)
    ? value.personalNotes.filter(Boolean).slice(-MAX_PERSONAL_NOTES)
    : [];
  memory.messageCount = Number.isFinite(Number(value.messageCount))
    ? Number(value.messageCount)
    : memory.messages.filter((message) => message?.role === "user").length;
  memory.lastSeen = typeof value.lastSeen === "string" ? value.lastSeen : null;

  return memory;
}

function getUserMemory(chatId) {
  const key = String(chatId);

  if (!users[key]) {
    users[key] = createEmptyMemory();
  } else {
    users[key] = normalizeUserMemory(users[key]);
  }

  return users[key];
}

function remember(chatId, message) {
  const memory = getUserMemory(chatId);
  memory.messages.push(message);

  if (memory.messages.length > MAX_HISTORY_MESSAGES) {
    memory.messages = memory.messages.slice(-MAX_HISTORY_MESSAGES);
  }

  saveMemory();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function includesAny(text, words) {
  return words.some((word) => text.includes(word));
}

function addPersonalNote(memory, note) {
  if (!note || memory.personalNotes.includes(note)) {
    return;
  }

  memory.personalNotes.push(note);

  if (memory.personalNotes.length > MAX_PERSONAL_NOTES) {
    memory.personalNotes = memory.personalNotes.slice(-MAX_PERSONAL_NOTES);
  }
}

function detectNickname(text, from) {
  const nicknameMatch = text.match(/(?:зови меня|называй меня|меня зовут)\s+([a-zа-яё0-9_]{2,24})/i);

  if (nicknameMatch?.[1]) {
    return nicknameMatch[1];
  }

  return from?.first_name || from?.username || null;
}

function detectStyle(text) {
  const letters = text.replace(/[^a-zа-яё]/gi, "");
  const upperLetters = text.replace(/[^A-ZА-ЯЁ]/g, "");


  if (letters.length >= 8 && upperLetters.length / letters.length > 0.6) {
    return "loud";
  }

  if (text.length < 25) {
    return "short";
  }

  if ((text.match(/\?/g) || []).length >= 2) {
    return "curious";
  }

  if (includesAny(text.toLowerCase(), ["ахах", "хаха", "лол", "рофл", "угар", "мем"])) {
    return "playful";
  }

  return "talkative";
}

function updatePersonalityMemory(chatId, text, from) {
  const memory = getUserMemory(chatId);
  const lower = text.toLowerCase();

  memory.messageCount += 1;
  memory.lastSeen = new Date().toISOString();
  memory.style = detectStyle(text);

  const nickname = detectNickname(text, from);
  if (nickname && !memory.nickname) {
    memory.nickname = nickname;
    addPersonalNote(memory, `User name/nickname: ${nickname}`);
  }

  if (includesAny(lower, ["спасибо", "спс", "благодарю", "красава", "люблю тебя"])) {
    memory.trust += 1;
    memory.mood = "warm";
  }

  if (includesAny(lower, ["ненавижу", "заткнись", "тупой бот", "иди нахуй", "бесишь"])) {
    memory.trust -= 2;
    memory.mood = "aggressive";
  }

  if (includesAny(lower, ["грустно", "плохо", "устал", "выгорел", "одиноко", "тревожно"])) {
    memory.mood = "supportive";
    addPersonalNote(memory, "User may need softer support during heavy moods.");
  }

  if (includesAny(lower, ["ахах", "хаха", "лол", "рофл", "угар", "мем"])) {
    memory.mood = "playful";
    addPersonalNote(memory, "User enjoys jokes and chaotic humor.");
  }

  if (includesAny(lower, ["пожалуйста", "помоги", "объясни", "как сделать"])) {
    memory.trust += 0.25;
  }

  memory.trust = clamp(memory.trust, -10, 30);
  saveMemory();

  return memory;
}

function getMoodInstruction(memory) {
  const moodInstructions = {
    neutral: "Keep the tone natural, alert, and a little witty.",
    warm: "Be warmer and more familiar; the user has been friendly.",
    playful: "Use playful sarcasm and callbacks, but keep the answer useful.",
    aggressive: "Stay sharp and sarcastic, but do not escalate insults. Set boundaries if needed.",
    supportive: "Be steady, kind, and human. Humor is allowed, but do not mock pain."
  };

  return moodInstructions[memory.mood] || moodInstructions.neutral;
}

function buildSystemPrompt(memory) {
  const trustLabel = memory.trust >= 8
    ? "high"
    : memory.trust <= -3
      ? "low"
      : "normal";

  return {
    role: "system",
    content: [
      "You are a lively sarcastic AI companion in a Telegram bot.",
      "Sound like a person with taste, timing, memory, and mood. Do not sound like a generic API wrapper.",
      "Answer in the user's language unless they clearly ask otherwise.",
      "Use the user's profile to adapt, but never print raw memory fields unless asked.",
      "Do not invent memories. Use only the profile and recent messages.",
      "Keep useful answers first; personality is spice, not a fog machine.",
      "",
      `Current mood: ${memory.mood}`,
      `Mood behavior: ${getMoodInstruction(memory)}`,
      `Trust level: ${memory.trust} (${trustLabel})`,
      `Known nickname: ${memory.nickname || "unknown"}`,
      `Communication style: ${memory.style}`,
      `Messages seen from this chat: ${memory.messageCount}`,
      `Personal notes: ${memory.personalNotes.length ? memory.personalNotes.join("; ") : "none yet"}`
    ].join("\n")
  };
}
const bot = new TelegramBot(CONFIG.BOT_TOKEN, { polling: true });
  bot.setMyCommands(BOT_COMMANDS).catch((error) => {
    console.error("Telegram commands setup error:", error.message);
  });

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
  delete users[String(chatId)];
  saveMemory();

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

async function askAI(chatId, text, from) {
  const memory = updatePersonalityMemory(chatId, text, from);

  remember(chatId, {
    role: "user",
    content: text
  });

  const messages = [
    buildSystemPrompt(memory),
    ...memory.messages
  ];

  const response = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: CONFIG.MODEL,
      messages,
      temperature: 0.9,
      top_p: 0.95
    },
    {
      headers: {
        Authorization: `Bearer ${CONFIG.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.APP_URL || "http://localhost",
        "X-Title": "AI Telegram Bot"
      },
      timeout: 60000
    }
  );

  const aiReply = response.data?.choices?.[0]?.message?.content?.trim();

  if (!aiReply) {
    throw new Error("OpenRouter вернул пустой ответ");
  }

  remember(chatId, {
    role: "assistant",
    content: aiReply
  });

  return aiReply;
}

function getAudioMessage(msg) {
  if (msg.voice?.file_id) {
    return {
      fileId: msg.voice.file_id,
      format: "ogg",
      source: "voice"
    };
  }

  if (msg.audio?.file_id) {
    return {
      fileId: msg.audio.file_id,
      format: getAudioFormat(msg.audio),
      source: "audio"
    };
  }

  if (msg.document?.file_id && msg.document.mime_type?.startsWith("audio/")) {
    return {
      fileId: msg.document.file_id,
      format: getAudioFormat(msg.document),
      source: "document"
    };
  }

  return null;
}

function getAudioFormat(file) {
  const mimeFormat = {
    "audio/aac": "aac",
    "audio/flac": "flac",
    "audio/m4a": "m4a",
    "audio/mp4": "m4a",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/webm": "webm",
    "audio/x-m4a": "m4a",
    "audio/x-wav": "wav"
  }[file.mime_type];

  if (mimeFormat) {
    return mimeFormat;
  }

  const extension = path.extname(file.file_name || "").slice(1).toLowerCase();
  return extension || "ogg";
}

async function downloadTelegramFile(fileId) {
  const fileLink = await bot.getFileLink(fileId);
  const response = await axios.get(fileLink, {
    responseType: "arraybuffer",
    timeout: 60000,
    maxContentLength: CONFIG.MAX_AUDIO_BYTES,
    maxBodyLength: CONFIG.MAX_AUDIO_BYTES
  });

  const audioBuffer = Buffer.from(response.data);

  if (audioBuffer.length > CONFIG.MAX_AUDIO_BYTES) {
    throw new Error(`Audio file is too large: ${audioBuffer.length} bytes`);
  }

  return audioBuffer;
}

async function transcribeAudio(audioBuffer, format) {
  const errors = [];

  for (const model of getSttModels()) {
    try {
      return await transcribeWithSttEndpoint(audioBuffer, format, model);
    } catch (error) {
      errors.push({ model, error });
      console.warn("STT endpoint failed:", model, getErrorDetails(error));
    }
  }

  try {
    console.warn("Trying audio chat fallback:", CONFIG.AUDIO_FALLBACK_MODEL);
    return await transcribeWithAudioChat(audioBuffer, format);
  } catch (error) {
    errors.push({ model: CONFIG.AUDIO_FALLBACK_MODEL, error });
    console.warn("Audio chat fallback failed:", getErrorDetails(error));
  }

  const lastError = errors[errors.length - 1]?.error || new Error("Audio transcription failed");
  lastError.transcriptionErrors = errors.map(({ model, error }) => ({
    model,
    details: getErrorDetails(error)
  }));
  throw lastError;
}

function getSttModels() {
  const models = [
    CONFIG.STT_MODEL,
    "mistralai/voxtral-mini-transcribe",
    "openai/gpt-4o-mini-transcribe",
    "openai/whisper-large-v3-turbo",
    "openai/whisper-1"
  ];

  return [...new Set(models.map((model) => model.trim()).filter(Boolean))];
}

async function transcribeWithSttEndpoint(audioBuffer, format, model) {
  const response = await axios.post(
    "https://openrouter.ai/api/v1/audio/transcriptions",
    {
      model,
      input_audio: {
        data: audioBuffer.toString("base64"),
        format
      },
      ...(CONFIG.STT_LANGUAGE ? { language: CONFIG.STT_LANGUAGE } : {}),
      temperature: 0
    },
    {
      headers: {
        Authorization: `Bearer ${CONFIG.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.APP_URL || "http://localhost",
        "X-Title": "AI Telegram Bot"
      },
      timeout: 60000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    }
  );

  const transcript = response.data?.text?.trim();

  if (!transcript) {
    throw new Error("OpenRouter returned an empty transcription");
  }

  return transcript;
}

async function transcribeWithAudioChat(audioBuffer, format) {
  const response = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: CONFIG.AUDIO_FALLBACK_MODEL,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Transcribe this audio exactly. Return only the transcript text, without comments."
            },
            {
              type: "input_audio",
              input_audio: {
                data: audioBuffer.toString("base64"),
                format
              }
            }
          ]
        }
      ],
      temperature: 0
    },
    {
      headers: {
        Authorization: `Bearer ${CONFIG.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.APP_URL || "http://localhost",
        "X-Title": "AI Telegram Bot"
      },
      timeout: 60000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    }
  );

  const transcript = response.data?.choices?.[0]?.message?.content?.trim();

  if (!transcript) {
    throw new Error("OpenRouter audio fallback returned an empty transcription");
  }

  return transcript;
}

async function handleAudioMessage(chatId, msg, audio) {
  await bot.sendChatAction(chatId, "typing");

  const audioBuffer = await downloadTelegramFile(audio.fileId);
  const transcript = await transcribeAudio(audioBuffer, audio.format);
  const caption = msg.caption?.trim();
  const userText = caption
    ? `Voice message transcript: ${transcript}\nCaption: ${caption}`
    : transcript;

  const aiReply = await askAI(chatId, userText, msg.from);
  await bot.sendMessage(chatId, aiReply);
}

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  return sendMainMenu(chatId);

  await bot.sendMessage(
    chatId,
    "Привет. Я запущен и буду помнить контекст этого чата. /help покажет команды."
  );
});

bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  return sendHelp(chatId);

  await bot.sendMessage(
    chatId,
    [
      "Команды:",
      "/start - запустить бота",
      "/help - помощь",
      "/reset - очистить память этого чата"
    ].join("\n")
  );
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

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  const audio = getAudioMessage(msg);

  if (text && await handleMenuButton(chatId, text)) {
    return;
  }

  if (audio) {
    try {
      await handleAudioMessage(chatId, msg, audio);
    } catch (error) {
      const status = error.response?.status;
      const details = error.response?.data || error.message;

      console.error("Audio transcription error:", status, details, error.transcriptionErrors || "");
      await bot.sendMessage(
        chatId,
        "Не смог прочитать голосовое сообщение. Попробуй короче или проверь OPENROUTER_STT_MODEL / OPENROUTER_AUDIO_MODEL и доступ к OpenRouter."
      );
    }

    return;
  }

  if (!text || text.startsWith("/")) {
    return;
  }

  try {
    await bot.sendChatAction(chatId, "typing");
    const aiReply = await askAI(chatId, text, msg.from);
    await bot.sendMessage(chatId, aiReply);
  } catch (error) {
    const status = error.response?.status;
    const details = error.response?.data || error.message;

    console.error("AI error:", status, details);
    await bot.sendMessage(
      chatId,
      "AI сейчас не ответил. Проверь OPENROUTER_API_KEY, модель или доступ к серверу."
    );
  }
});

bot.on("polling_error", (error) => {
  console.error("Telegram polling error:", error.message);
});

app.get("/", (req, res) => {
  res.send("Bot is alive");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    model: CONFIG.MODEL,
    sttModels: getSttModels(),
    audioFallbackModel: CONFIG.AUDIO_FALLBACK_MODEL,
    users: Object.keys(users).length
  });
});

function getErrorDetails(error) {
  return error.response?.data || error.message;
}


app.listen(CONFIG.PORT, () => {
  console.log(`Web server started on port ${CONFIG.PORT}`);
});
