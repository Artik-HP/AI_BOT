const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const CONFIG = require("../config");
const { getErrorDetails } = require("../utils/errors");
const {
  dedupeRepeatedReply,
  getUserMemory,
  normalizeForCompare
} = require("./memory");
const { synthesizeSpeech } = require("./openrouter");

const {
  PROCESSED_MESSAGE_TTL_MS,
  DUPLICATE_REPLY_TTL_MS
} = CONFIG;

const processedMessages = new Set();
const lastAiReplies = new Map();
const chatQueues = new Map();
let bot;

const TELEGRAM_CAPTION_LIMIT = 1024;

function createTelegramBot() {
  bot = new TelegramBot(CONFIG.BOT_TOKEN, { polling: true });
  return bot;
}

function getTelegramBot() {
  if (!bot) {
    throw new Error("Telegram bot has not been initialized");
  }

  return bot;
}

function claimIncomingMessage(msg) {
  if (!msg?.chat?.id || !msg?.message_id) {
    return true;
  }

  const key = `${msg.chat.id}:${msg.message_id}`;

  if (processedMessages.has(key)) {
    return false;
  }

  processedMessages.add(key);
  setTimeout(() => processedMessages.delete(key), PROCESSED_MESSAGE_TTL_MS).unref?.();
  return true;
}

function shouldSkipDuplicateReply(chatId, reply) {
  const now = Date.now();
  const normalized = normalizeForCompare(reply);
  const previous = lastAiReplies.get(String(chatId));

  lastAiReplies.set(String(chatId), {
    normalized,
    time: now
  });

  return Boolean(
    previous &&
    previous.normalized === normalized &&
    now - previous.time < DUPLICATE_REPLY_TTL_MS
  );
}

async function sendAIMessage(chatId, reply) {
  const cleanReply = dedupeRepeatedReply(reply);

  if (!cleanReply || shouldSkipDuplicateReply(chatId, cleanReply)) {
    return;
  }

  await sendCleanTextMessage(chatId, cleanReply);
}

function shouldSendVoiceReply(options = {}) {
  return options.voiceEnabled !== false;
}

function getAudioFileOptions() {
  const format = String(CONFIG.TTS_FORMAT || "mp3").toLowerCase();
  const contentType = {
    mp3: "audio/mpeg",
    pcm: "audio/pcm"
  }[format] || "application/octet-stream";

  return {
    filename: `reply.${format}`,
    contentType
  };
}

function buildAudioCaption(text) {
  const cleanText = String(text || "").trim();

  if (cleanText.length <= TELEGRAM_CAPTION_LIMIT) {
    return cleanText;
  }

  return `${cleanText.slice(0, TELEGRAM_CAPTION_LIMIT - 3).trim()}...`;
}

async function sendCleanTextMessage(chatId, cleanReply) {
  await bot.sendMessage(chatId, cleanReply);
}

async function sendAIVoiceMessage(chatId, reply) {
  const cleanReply = dedupeRepeatedReply(reply);

  if (!cleanReply || shouldSkipDuplicateReply(chatId, cleanReply)) {
    return;
  }

  try {
    await bot.sendChatAction(chatId, "upload_audio");
    const memory = getUserMemory(chatId);
    const audioBuffer = await synthesizeSpeech(cleanReply, {
      voice: memory.ttsVoice || CONFIG.TTS_VOICE
    });

    await bot.sendAudio(
      chatId,
      audioBuffer,
      {
        caption: buildAudioCaption(cleanReply),
        title: "AI reply"
      },
      getAudioFileOptions()
    );
  } catch (error) {
    const status = error.response?.status;
    const details = getErrorDetails(error);

    console.error("TTS send error:", status, details);
    await sendCleanTextMessage(chatId, cleanReply);
  }
}

async function sendAIResponse(chatId, reply, options = {}) {
  const memory = getUserMemory(chatId);

  if (shouldSendVoiceReply({ ...options, voiceEnabled: memory.voiceEnabled })) {
    await sendAIVoiceMessage(chatId, reply);
    return;
  }

  await sendAIMessage(chatId, reply);
}


function enqueueChatTask(chatId, task) {
  const key = String(chatId);
  const previous = chatQueues.get(key) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(task)
    .finally(() => {
      if (chatQueues.get(key) === next) {
        chatQueues.delete(key);
      }
    });

  chatQueues.set(key, next);
  return next;
}

function getDownloadOptions(options) {
  if (typeof options === "number") {
    return {
      maxBytes: options,
      fileLabel: "File"
    };
  }

  return {
    maxBytes: Number(options?.maxBytes || CONFIG.MAX_AUDIO_BYTES),
    fileLabel: options?.fileLabel || "File"
  };
}

async function downloadTelegramFile(fileId, options) {
  const { maxBytes, fileLabel } = getDownloadOptions(options);
  const fileLink = await bot.getFileLink(fileId);
  const response = await axios.get(fileLink, {
    responseType: "arraybuffer",
    timeout: 60000,
    maxContentLength: maxBytes,
    maxBodyLength: maxBytes
  });

  const fileBuffer = Buffer.from(response.data);

  if (fileBuffer.length > maxBytes) {
    throw new Error(`${fileLabel} file is too large: ${fileBuffer.length} bytes`);
  }

  return fileBuffer;
}

module.exports = {
  createTelegramBot,
  getTelegramBot,
  claimIncomingMessage,
  sendAIMessage,
  sendAIVoiceMessage,
  sendAIResponse,
  enqueueChatTask,
  downloadTelegramFile
};
