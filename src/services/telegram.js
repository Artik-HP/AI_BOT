const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const CONFIG = require("../config");
const logger = require("../utils/logger");
const { ApiError, toSafeError } = require("../utils/errors");
const { createKeyedQueue } = require("../utils/queue");
const { createTtlSet } = require("../utils/ttlSet");
const { TELEGRAM_MESSAGE_LIMIT, splitMessage } = require("../utils/text");
const { dedupeRepeatedReply } = require("./memory");

const processedMessages = createTtlSet(CONFIG.PROCESSED_MESSAGE_TTL_MS);
const repliedMessages = createTtlSet(CONFIG.DUPLICATE_REPLY_TTL_MS);
const botConversationWindows = new Map();
const enqueueChatTask = createKeyedQueue();
const TRUNCATION_NOTICE = "\n\n[ответ слишком длинный, остаток отброшен]";
const FILE_TOO_LARGE = "FILE_TOO_LARGE";
let bot;
let botIdentity;

function createTelegramBot() {
  bot = new TelegramBot(CONFIG.BOT_TOKEN, {
    polling: true,
    baseApiUrl: CONFIG.TELEGRAM_API_BASE_URL
  });

  bot.getMe()
    .then((identity) => {
      botIdentity = {
        id: String(identity.id),
        username: normalizeTelegramUsername(identity.username)
      };
    })
    .catch((error) => {
      logger.error("Telegram getMe error:", error);
    });

  return bot;
}

function getTelegramBot() {
  if (!bot) {
    throw new Error("Telegram bot has not been initialized");
  }

  return bot;
}

function getBotUsername() {
  return botIdentity?.username || null;
}

function claimIncomingMessage(msg) {
  if (!msg?.chat?.id || !msg?.message_id) {
    return true;
  }

  return processedMessages.claim(`${msg.chat.id}:${msg.message_id}`);
}

function normalizeTelegramUsername(username) {
  const cleanUsername = String(username || "").trim().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9_]{5,32}$/.test(cleanUsername) ? cleanUsername : null;
}

// "/help@some_other_bot" is a command for another bot sharing the group, not for this one.
// Until getMe() has answered the bot cannot tell, and accepts the command.
function isAddressedToThisBot(text) {
  const match = String(text || "").match(/^\/\w+@(\w+)/);

  if (!match || !botIdentity?.username) {
    return true;
  }

  return normalizeTelegramUsername(match[1]) === botIdentity.username;
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

  return new RegExp(`(^|\\W)@${botIdentity.username}(?=$|\\W)`, "i").test(String(msg.text || msg.caption || ""));
}

function pruneBotConversationWindows(now) {
  for (const [key, window] of botConversationWindows) {
    if (now - window.startedAt >= CONFIG.BOT_TO_BOT_WINDOW_MS) {
      botConversationWindows.delete(key);
    }
  }
}

// Gate for every message that comes from another bot (text, voice, photo alike).
// Returns true when the message may be processed.
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

  if (botConversationWindows.size > 200) {
    pruneBotConversationWindows(now);
  }

  if (!window || now - window.startedAt >= CONFIG.BOT_TO_BOT_WINDOW_MS) {
    window = { count: 0, startedAt: now };
    botConversationWindows.set(key, window);
  }

  if (window.count >= CONFIG.BOT_TO_BOT_MAX_TURNS) {
    logger.warn(`Bot-to-bot turn limit reached for ${key}`);
    return false;
  }

  if (
    window.lastAcceptedAt &&
    now - window.lastAcceptedAt < CONFIG.BOT_TO_BOT_MIN_INTERVAL_MS
  ) {
    logger.warn(`Bot-to-bot rate limit reached for ${key}`);
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

// Never sends more than MAX_REPLY_PARTS messages for one reply; the rest is dropped with a visible notice.
function limitReplyParts(parts) {
  if (parts.length <= CONFIG.MAX_REPLY_PARTS) {
    return parts;
  }

  const kept = parts.slice(0, CONFIG.MAX_REPLY_PARTS);
  const last = kept.length - 1;

  kept[last] = `${kept[last].slice(0, TELEGRAM_MESSAGE_LIMIT - TRUNCATION_NOTICE.length).trimEnd()}${TRUNCATION_NOTICE}`;
  return kept;
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

  const target = chatId || `@${cleanUsername}`;
  const outgoing = chatId ? prefixBotMention(cleanText, cleanUsername) : cleanText;
  let lastMessage = null;

  for (const part of limitReplyParts(splitMessage(outgoing))) {
    lastMessage = await getTelegramBot().sendMessage(target, part);
  }

  return lastMessage;
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

  if (!cleanReply) {
    return;
  }

  // The same incoming message must never be answered twice; different messages may well get equal answers.
  if (options.sourceMessageId && !repliedMessages.claim(`${chatId}:${options.sourceMessageId}`)) {
    return;
  }

  logger.message("out", { chatId }, cleanReply);
  await sendCleanTextMessage(chatId, cleanReply, options);
}

async function sendCleanTextMessage(chatId, cleanReply, options = {}) {
  const parts = limitReplyParts(splitMessage(prefixBotMention(cleanReply, options.targetUsername)));

  for (const [index, part] of parts.entries()) {
    await getTelegramBot().sendMessage(chatId, part, index === 0 ? buildSendMessageOptions(options) : {});
  }
}

async function sendAIResponse(chatId, reply, options = {}) {
  await sendAIMessage(chatId, reply, options);
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

// True when the file exceeds our limit or Telegram refuses to hand it to a bot.
function isFileTooLargeError(error) {
  return error?.code === FILE_TOO_LARGE || /file is too big/i.test(String(error?.message || ""));
}

// The download URL contains the bot token, so errors are converted before they leave this function.
async function downloadTelegramFile(fileId, options) {
  const { maxBytes, fileLabel } = getDownloadOptions(options);

  try {
    const fileLink = await getTelegramBot().getFileLink(fileId);
    const response = await axios.get(fileLink, {
      responseType: "arraybuffer",
      timeout: 60000,
      maxContentLength: maxBytes,
      maxBodyLength: maxBytes
    });
    const fileBuffer = Buffer.from(response.data);

    if (fileBuffer.length > maxBytes) {
      throw new ApiError(`${fileLabel} file is too large: ${fileBuffer.length} bytes`, { code: FILE_TOO_LARGE });
    }

    return fileBuffer;
  } catch (error) {
    if (/maxContentLength|maxBodyLength/.test(String(error?.message))) {
      throw new ApiError(`${fileLabel} file is too large (limit ${maxBytes} bytes)`, { code: FILE_TOO_LARGE });
    }

    throw toSafeError(error);
  }
}

// Gives running replies a chance to go out before the process stops.
async function waitForChatTasks(timeoutMs) {
  await Promise.race([
    enqueueChatTask.whenIdle(),
    new Promise((resolve) => setTimeout(resolve, timeoutMs).unref?.())
  ]);
}

module.exports = {
  createTelegramBot,
  getTelegramBot,
  getBotUsername,
  isAddressedToThisBot,
  claimIncomingMessage,
  claimIncomingBotMessage,
  getBotToBotReplyOptions,
  getBotToBotStatus,
  sendMessageToBot,
  sendAIMessage,
  sendAIResponse,
  enqueueChatTask,
  downloadTelegramFile,
  isFileTooLargeError,
  waitForChatTasks
};
