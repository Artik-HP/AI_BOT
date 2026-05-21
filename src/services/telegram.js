const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const CONFIG = require("../config");
const { dedupeRepeatedReply, normalizeForCompare } = require("./memory");

const {
  PROCESSED_MESSAGE_TTL_MS,
  DUPLICATE_REPLY_TTL_MS
} = CONFIG;

const processedMessages = new Set();
const lastAiReplies = new Map();
const chatQueues = new Map();
let bot;

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

  await bot.sendMessage(chatId, cleanReply);
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

module.exports = {
  createTelegramBot,
  getTelegramBot,
  claimIncomingMessage,
  sendAIMessage,
  enqueueChatTask,
  downloadTelegramFile
};
