const path = require("path");

function readPositiveNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readBoolean(name, fallback = false) {
  const value = process.env[name];

  if (value == null || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "y", "on"].includes(String(value).trim().toLowerCase());
}

function readList(name) {
  return String(process.env[name] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

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

  VISION_MODEL:
    process.env.OPENROUTER_VISION_MODEL ||
    "openai/gpt-4o-mini",

  TTS_MODEL:
    process.env.OPENROUTER_TTS_MODEL ||
    "openai/gpt-4o-mini-tts-2025-12-15",

  TTS_VOICE: process.env.OPENROUTER_TTS_VOICE || "nova",
  TTS_VOICES: (process.env.OPENROUTER_TTS_VOICES || "alloy,echo,fable,onyx,nova,shimmer")
    .split(",")
    .map((voice) => voice.trim())
    .filter(Boolean),
  TTS_FORMAT: process.env.OPENROUTER_TTS_FORMAT || "mp3",
  TTS_SPEED: Number(process.env.OPENROUTER_TTS_SPEED || 1),
  TTS_MAX_CHARS: Number(process.env.TTS_MAX_CHARS || 3500),
  VOICE_REPLY_MODE: process.env.VOICE_REPLY_MODE || "always",

  BOT_TOKEN: process.env.BOT_TOKEN,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  PORT: process.env.PORT || 12722,
  STT_LANGUAGE: process.env.OPENROUTER_STT_LANGUAGE,
  MAX_AUDIO_BYTES: Number(process.env.MAX_AUDIO_BYTES || 25 * 1024 * 1024),
  MAX_IMAGE_BYTES: Number(process.env.MAX_IMAGE_BYTES || 10 * 1024 * 1024),
  MEMORY_FILE: process.env.MEMORY_FILE
    ? path.resolve(process.env.MEMORY_FILE)
    : path.join(__dirname, "..", "memory.json"),

  MAX_HISTORY_MESSAGES: readPositiveNumber("MAX_HISTORY_MESSAGES", 60),
  MAX_STORED_MESSAGES: readPositiveNumber("MAX_STORED_MESSAGES", 300),
  MAX_MEMORY_SUMMARY_CHARS: readPositiveNumber("MAX_MEMORY_SUMMARY_CHARS", 6000),
  MAX_MESSAGE_CONTENT_CHARS: readPositiveNumber("MAX_MESSAGE_CONTENT_CHARS", 4000),
  MAX_PERSONAL_NOTES: 12,
  PROCESSED_MESSAGE_TTL_MS: 10 * 60 * 1000,
  DUPLICATE_REPLY_TTL_MS: 15 * 1000,

  ACCOUNT_ASSISTANT_ENABLED: readBoolean("ACCOUNT_ASSISTANT_ENABLED", false),
  ACCOUNT_ASSISTANT_MODE: process.env.ACCOUNT_ASSISTANT_MODE || "approval",
  ACCOUNT_ASSISTANT_OWNER_CHAT_ID:
    process.env.ACCOUNT_ASSISTANT_OWNER_CHAT_ID ||
    process.env.BOT_OWNER_CHAT_ID ||
    process.env.OWNER_CHAT_ID,
  ACCOUNT_ASSISTANT_PRIVATE_ONLY: readBoolean("ACCOUNT_ASSISTANT_PRIVATE_ONLY", true),
  ACCOUNT_ASSISTANT_ALLOW_CHATS: readList("ACCOUNT_ASSISTANT_ALLOW_CHATS"),
  ACCOUNT_ASSISTANT_BLOCK_CHATS: readList("ACCOUNT_ASSISTANT_BLOCK_CHATS"),
  ACCOUNT_ASSISTANT_REPLY_DELAY_MS: readPositiveNumber("ACCOUNT_ASSISTANT_REPLY_DELAY_MS", 1200),
  ACCOUNT_ASSISTANT_MIN_INTERVAL_MS: readPositiveNumber("ACCOUNT_ASSISTANT_MIN_INTERVAL_MS", 30000),
  ACCOUNT_ASSISTANT_DRAFT_TTL_MS: readPositiveNumber("ACCOUNT_ASSISTANT_DRAFT_TTL_MS", 30 * 60 * 1000),
  ACCOUNT_ASSISTANT_MAX_TEXT_CHARS: readPositiveNumber("ACCOUNT_ASSISTANT_MAX_TEXT_CHARS", 1200),
  ACCOUNT_ASSISTANT_PROMPT: process.env.ACCOUNT_ASSISTANT_PROMPT || "",
  TELEGRAM_API_ID: Number(process.env.TELEGRAM_API_ID || 0),
  TELEGRAM_API_HASH: process.env.TELEGRAM_API_HASH,
  TELEGRAM_STRING_SESSION: process.env.TELEGRAM_STRING_SESSION
};

function validateConfig() {
  if (!CONFIG.BOT_TOKEN) {
    throw new Error("BOT_TOKEN не найден в .env");
  }

  if (!CONFIG.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY не найден в .env");
  }
}

module.exports = {
  ...CONFIG,
  validateConfig
};
