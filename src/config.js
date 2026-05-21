const path = require("path");

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
  MEMORY_FILE: path.join(__dirname, "..", "memory.json"),

  MAX_HISTORY_MESSAGES: 20,
  MAX_PERSONAL_NOTES: 12,
  PROCESSED_MESSAGE_TTL_MS: 10 * 60 * 1000,
  DUPLICATE_REPLY_TTL_MS: 15 * 1000
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
