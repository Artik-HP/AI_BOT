const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const CONFIG = require("../config");
const { getErrorDetails } = require("../utils/errors");
const {
  dedupeRepeatedReply,
  normalizeForCompare
} = require("./memory");

const {
  PROCESSED_MESSAGE_TTL_MS,
  DUPLICATE_REPLY_TTL_MS
} = CONFIG;

const processedMessages = new Set();
const lastAiReplies = new Map();
const chatQueues = new Map();
const botConversationWindows = new Map();
let bot;
let botIdentity;

const TELEGRAM_MESSAGE_LIMIT = 4096;

function createTelegramBot() {
  bot = new TelegramBot(CONFIG.BOT_TOKEN, { polling: true });
  attachOutgoingMessageLogger(bot);

  if (typeof bot.getMe === "function") {
    bot.getMe()
      .then((identity) => {
        botIdentity = {
          id: String(identity.id),
          username: normalizeTelegramUsername(identity.username)
        };
      })
      .catch((error) => {
        console.error("Telegram getMe error:", getErrorDetails(error));
      });
  }

  return bot;
}

function formatOutgoingText(text) {
  if (typeof text === "string") {
    return text;
  }

  try {
    return JSON.stringify(text);
  } catch (error) {
    return String(text);
  }
}

function logOutgoingMessage(chatId, text) {
  console.log("================================");
  console.log("Ответ бота");
  console.log("Chat ID:", chatId);
  console.log("Текст:", formatOutgoingText(text));
  console.log("================================");
}

function attachOutgoingMessageLogger(telegramBot) {
  if (telegramBot.__outgoingMessageLoggerAttached) {
    return;
  }

  const originalSendMessage = telegramBot.sendMessage.bind(telegramBot);

  telegramBot.sendMessage = async (...args) => {
    const result = await originalSendMessage(...args);
    logOutgoingMessage(args[0], args[1]);
    return result;
  };

  telegramBot.__outgoingMessageLoggerAttached = true;
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

function normalizeTelegramUsername(username) {
  const cleanUsername = String(username || "").trim().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9_]{5,32}$/.test(cleanUsername) ? cleanUsername : null;
}

function isAllowedBotIdentity(identity = {}) {
  if (!CONFIG.BOT_TO_BOT_ALLOW_BOTS.length) {
    return true;
  }

  const id = String(identity.id || "").trim();
  const username = normalizeTelegramUsername(identity.username);

  return CONFIG.BOT_TO_BOT_ALLOW_BOTS.some((allowedBot) => {
    const allowedId = String(allowedBot || "").trim();
    const allowedUsername = normalizeTelegramUsername(allowedBot);
    return (id && allowedId === id) || (username && allowedUsername === username);
  });
}

function isConfiguredBotToBotChat(msg) {
  const configuredChatId = String(CONFIG.BOT_TO_BOT_CHAT_ID || "").trim();
  return !configuredChatId || String(msg.chat?.id || "") === configuredChatId;
}

function isBotIdentityMatch(identity = {}, expected) {
  const expectedRaw = String(expected || "").trim();

  if (!expectedRaw) {
    return false;
  }

  const id = String(identity.id || "").trim();
  const username = normalizeTelegramUsername(identity.username);
  const expectedUsername = normalizeTelegramUsername(expectedRaw);

  return Boolean(
    (id && id === expectedRaw) ||
    (username && expectedUsername && username === expectedUsername)
  );
}

function isConfiguredBotToBotPeerMessage(msg) {
  return Boolean(
    CONFIG.BOT_TO_BOT_CHAT_ID &&
    CONFIG.BOT_TO_BOT_TARGET_BOT_USERNAME &&
    isConfiguredBotToBotChat(msg) &&
    isBotIdentityMatch(msg.from, CONFIG.BOT_TO_BOT_TARGET_BOT_USERNAME)
  );
}

function isBotMessageDirectedAtThisBot(msg) {
  if (msg.chat?.type === "private") {
    return true;
  }

  const replyToId = String(msg.reply_to_message?.from?.id || "");

  if (botIdentity?.id && replyToId === botIdentity.id) {
    return true;
  }

  if (!botIdentity?.username) {
    return false;
  }

  return new RegExp(`(^|\\W)@${botIdentity.username}(?=$|\\W)`, "i").test(String(msg.text || ""));
}

function claimIncomingBotMessage(msg) {
  if (!msg.from?.is_bot) {
    return true;
  }

  const directedAtThisBot = isBotMessageDirectedAtThisBot(msg);
  const configuredPeerMessage = isConfiguredBotToBotPeerMessage(msg);

  if (
    !CONFIG.BOT_TO_BOT_ENABLED ||
    String(msg.from.id || "") === botIdentity?.id ||
    !isAllowedBotIdentity(msg.from) ||
    !isConfiguredBotToBotChat(msg) ||
    (!directedAtThisBot && !configuredPeerMessage)
  ) {
    return false;
  }

  const now = Date.now();
  const key = `${msg.chat?.id || "unknown"}:${msg.from.id || msg.from.username || "bot"}`;
  let window = botConversationWindows.get(key);

  if (!window || now - window.startedAt >= CONFIG.BOT_TO_BOT_WINDOW_MS) {
    window = { count: 0, startedAt: now };
    botConversationWindows.set(key, window);
    setTimeout(() => {
      if (botConversationWindows.get(key) === window) {
        botConversationWindows.delete(key);
      }
    }, CONFIG.BOT_TO_BOT_WINDOW_MS).unref?.();
  }

  if (window.count >= CONFIG.BOT_TO_BOT_MAX_TURNS) {
    console.warn(`Bot-to-bot turn limit reached for ${key}`);
    return false;
  }

  if (
    window.lastAcceptedAt &&
    now - window.lastAcceptedAt < CONFIG.BOT_TO_BOT_MIN_INTERVAL_MS
  ) {
    console.warn(`Bot-to-bot rate limit reached for ${key}`);
    return false;
  }

  window.count += 1;
  window.lastAcceptedAt = now;
  return true;
}

function getBotToBotStatus() {
  return {
    enabled: Boolean(CONFIG.BOT_TO_BOT_ENABLED),
    username: botIdentity?.username || null,
    identityLoaded: Boolean(botIdentity?.id),
    chatId: CONFIG.BOT_TO_BOT_CHAT_ID || null,
    targetBotUsername: normalizeTelegramUsername(CONFIG.BOT_TO_BOT_TARGET_BOT_USERNAME),
    allowBots: CONFIG.BOT_TO_BOT_ALLOW_BOTS,
    maxTurns: CONFIG.BOT_TO_BOT_MAX_TURNS,
    windowMs: CONFIG.BOT_TO_BOT_WINDOW_MS,
    minIntervalMs: CONFIG.BOT_TO_BOT_MIN_INTERVAL_MS,
    ownerChatIdConfigured: Boolean(CONFIG.BOT_TO_BOT_OWNER_CHAT_ID)
  };
}

async function sendMessageToBot(username, text) {
  if (!CONFIG.BOT_TO_BOT_ENABLED) {
    throw new Error("Bot-to-bot communication is disabled");
  }

  const cleanUsername = normalizeTelegramUsername(username);
  const cleanText = String(text || "").trim();
  const chatId = String(CONFIG.BOT_TO_BOT_CHAT_ID || "").trim();

  if (!cleanUsername) {
    throw new Error("Invalid Telegram bot username");
  }

  if (!cleanText) {
    throw new Error("Message text is empty");
  }

  if (!isAllowedBotIdentity({ username: cleanUsername })) {
    throw new Error(`@${cleanUsername} is not in BOT_TO_BOT_ALLOW_BOTS`);
  }

  if (chatId) {
    return getTelegramBot().sendMessage(
      chatId,
      prefixBotMention(cleanText, cleanUsername).slice(0, TELEGRAM_MESSAGE_LIMIT)
    );
  }

  return getTelegramBot().sendMessage(`@${cleanUsername}`, cleanText.slice(0, TELEGRAM_MESSAGE_LIMIT));
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

function prefixBotMention(text, username) {
  const cleanUsername = normalizeTelegramUsername(username);

  if (!cleanUsername) {
    return text;
  }

  const mentionPattern = new RegExp(`(^|\\s)@${cleanUsername}(?=$|\\s|[,.!?;:])`, "i");

  if (mentionPattern.test(text)) {
    return text;
  }

  return `@${cleanUsername} ${text}`;
}

function buildSendMessageOptions(options = {}) {
  const sendOptions = {};

  if (options.replyToMessageId) {
    sendOptions.reply_to_message_id = options.replyToMessageId;
    sendOptions.allow_sending_without_reply = true;
  }

  return sendOptions;
}

function getBotToBotReplyOptions(msg) {
  if (!msg.from?.is_bot) {
    return {};
  }

  return {
    replyToMessageId: msg.message_id,
    targetUsername: msg.from.username
  };
}

async function sendAIMessage(chatId, reply, options = {}) {
  const cleanReply = dedupeRepeatedReply(reply);

  if (!cleanReply || shouldSkipDuplicateReply(chatId, cleanReply)) {
    return;
  }

  await sendCleanTextMessage(chatId, cleanReply, options);
}

async function sendCleanTextMessage(chatId, cleanReply, options = {}) {
  const text = prefixBotMention(cleanReply, options.targetUsername).slice(0, TELEGRAM_MESSAGE_LIMIT);
  await bot.sendMessage(chatId, text, buildSendMessageOptions(options));
}

async function sendAIResponse(chatId, reply, options = {}) {
  await sendAIMessage(chatId, reply, options);
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
  claimIncomingBotMessage,
  getBotToBotReplyOptions,
  getBotToBotStatus,
  sendMessageToBot,
  sendAIMessage,
  sendAIResponse,
  enqueueChatTask,
  downloadTelegramFile
};
