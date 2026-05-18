require("dotenv").config();
const { injectSpeedInsights } = require("@vercel/speed-insights");
console.log("BOT_TOKEN есть?", !!process.env.BOT_TOKEN);
console.log("ENV путь:", process.cwd());

const fs = require("fs");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

// Initialize Vercel Speed Insights
injectSpeedInsights();
console.log("Бот запущен");

// 1. System prompt
const express = require("express");

const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const PORT = process.env.PORT || 3000;
const MODEL = process.env.OPENROUTER_MODEL || "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free";
const STT_MODEL = process.env.OPENROUTER_STT_MODEL || "openai/whisper-large-v3";
const AUDIO_FALLBACK_MODEL = process.env.OPENROUTER_AUDIO_MODEL || "openai/gpt-4o-audio-preview";
const STT_LANGUAGE = process.env.OPENROUTER_STT_LANGUAGE;
const MAX_AUDIO_BYTES = Number(process.env.MAX_AUDIO_BYTES || 25 * 1024 * 1024);
const MEMORY_FILE = path.join(__dirname, "memory.json");
const MAX_HISTORY_MESSAGES = 24;

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

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN не найден в .env");
}

if (!OPENROUTER_API_KEY) {
  throw new Error("OPENROUTER_API_KEY не найден в .env");
}

const systemPrompt = {
  role: "system",
  content: [
    "Ты живой, умный AI-психотерапевт и наркоман с хорошей памятью контекста.",
    "Отвечай естественно, по-человечески, без канцелярита и лишней воды.",
    "Можно использовать злой сарказм и иронию.",
    "Если человек пишет о тяжелых эмоциях, отвечай спокойно, бережно и без фальшивой мотивации.",
    "Не поощряй опасное употребление веществ, самоповреждение или рискованные действия.",
    "Помни предыдущие сообщения в этом чате и опирайся на них в ответах."
  ].join("\n")
};

const app = express();
let chats = loadMemory();

console.log("Bot token loaded:", Boolean(BOT_TOKEN));
console.log("OpenRouter key loaded:", Boolean(OPENROUTER_API_KEY));
console.log("Bot started");

registerBotCommands();

function loadMemory() {
  try {
    if (!fs.existsSync(MEMORY_FILE)) {
      return {};
    }

    const raw = fs.readFileSync(MEMORY_FILE, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    console.error("Memory load error:", error.message);
    return {};
  }
}

function saveMemory() {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(chats, null, 2), "utf8");
  } catch (error) {
    console.error("Memory save error:", error.message);
  }
}

function getChatHistory(chatId) {
  const key = String(chatId);

  if (!Array.isArray(chats[key])) {
    chats[key] = [];
  }

  return chats[key];
}

function remember(chatId, message) {
  const history = getChatHistory(chatId);
  history.push(message);

  if (history.length > MAX_HISTORY_MESSAGES) {
    chats[String(chatId)] = history.slice(-MAX_HISTORY_MESSAGES);
  }

  saveMemory();
}

function registerBotCommands() {
  bot.setMyCommands(BOT_COMMANDS).catch((error) => {
    console.error("Telegram commands setup error:", error.message);
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
      `Лимит файла: ${Math.round(MAX_AUDIO_BYTES / 1024 / 1024)} MB.`
    ].join("\n"),
    MAIN_KEYBOARD
  );
}

async function sendStatus(chatId) {
  const history = getChatHistory(chatId);

  await bot.sendMessage(
    chatId,
    [
      "Статус:",
      `AI-модель: ${MODEL}`,
      `STT-модели: ${getSttModels().join(", ")}`,
      `Audio fallback: ${AUDIO_FALLBACK_MODEL}`,
      `Сообщений в памяти чата: ${history.length}/${MAX_HISTORY_MESSAGES}`,
      `Лимит аудио: ${Math.round(MAX_AUDIO_BYTES / 1024 / 1024)} MB`
    ].join("\n"),
    MAIN_KEYBOARD
  );
}

async function resetChatMemory(chatId) {
  chats[String(chatId)] = [];
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

async function askAI(chatId, text) {
  remember(chatId, {
    role: "user",
    content: text
  });

  const messages = [
    systemPrompt,
    ...getChatHistory(chatId)
  ];

  const response = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: MODEL,
      messages,
      temperature: 0.9,
      top_p: 0.95
    },
    {
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
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
    maxContentLength: MAX_AUDIO_BYTES,
    maxBodyLength: MAX_AUDIO_BYTES
  });

  const audioBuffer = Buffer.from(response.data);

  if (audioBuffer.length > MAX_AUDIO_BYTES) {
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
    console.warn("Trying audio chat fallback:", AUDIO_FALLBACK_MODEL);
    return await transcribeWithAudioChat(audioBuffer, format);
  } catch (error) {
    errors.push({ model: AUDIO_FALLBACK_MODEL, error });
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
    STT_MODEL,
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
      ...(STT_LANGUAGE ? { language: STT_LANGUAGE } : {}),
      temperature: 0
    },
    {
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
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
      model: AUDIO_FALLBACK_MODEL,
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
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
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

  const aiReply = await askAI(chatId, userText);
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

  chats[String(chatId)] = [];
  saveMemory();

  await bot.sendMessage(chatId, "Память этого чата очищена.");
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
const bot = new TelegramBot(BOT_TOKEN, {
  polling: true
});
    return;
  }

  if (!text || text.startsWith("/")) {
    return;
  }

  try {
    await bot.sendChatAction(chatId, "typing");
    const aiReply = await askAI(chatId, text);
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
    model: MODEL,
    sttModels: getSttModels(),
    audioFallbackModel: AUDIO_FALLBACK_MODEL,
    chats: Object.keys(chats).length
  });
});

function getErrorDetails(error) {
  return error.response?.data || error.message;
}

app.listen(PORT, () => {
  console.log(`Web server started on port ${PORT}`);
});
