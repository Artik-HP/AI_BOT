const path = require("path");

function readPositiveNumber(name, fallback) {
  const rawValue = process.env[name];
  const value =
    rawValue == null || String(rawValue).trim() === "" ? NaN : Number(rawValue);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readPort() {
  const value = readPositiveNumber("PORT", 12722);
  return Number.isInteger(value) && value <= 65535 ? value : 12722;
}

function readByteLimit(name, fallback) {
  return Math.max(1, Math.floor(readPositiveNumber(name, fallback)));
}

function readBoolean(name, fallback = false) {
  const value = process.env[name];

  if (value == null || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "y", "on"].includes(
    String(value).trim().toLowerCase(),
  );
}

function readList(name) {
  return String(process.env[name] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

const CONFIG = {
  BOT_ACCESS_PASSWORD_HASH: process.env.BOT_ACCESS_PASSWORD_HASH || "",
  BOT_ACCESS_IDLE_MS: readPositiveNumber("BOT_ACCESS_IDLE_MS", 600000),
  WEB_PUBLIC_URL: process.env.WEB_PUBLIC_URL || "",
  PRODUCT_NAME: process.env.PRODUCT_NAME || "Orbit AI",
  PRODUCT_TAGLINE:
    process.env.PRODUCT_TAGLINE ||
    "Твой помощник для идей, знаний и повседневных задач",
  AI_MAX_OUTPUT_TOKENS: Math.floor(
    readPositiveNumber("AI_MAX_OUTPUT_TOKENS", 1800),
  ),
  AI_DAILY_REQUEST_LIMIT: Math.floor(
    readPositiveNumber("AI_DAILY_REQUEST_LIMIT", 100),
  ),
  AI_RATE_PER_MINUTE: Math.floor(readPositiveNumber("AI_RATE_PER_MINUTE", 12)),
  AI_INSTANCE_DAILY_REQUEST_LIMIT: Math.floor(
    readPositiveNumber("AI_INSTANCE_DAILY_REQUEST_LIMIT", 1000),
  ),
  AI_INSTANCE_RATE_PER_MINUTE: Math.floor(
    readPositiveNumber("AI_INSTANCE_RATE_PER_MINUTE", 60),
  ),
  MODEL: process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini",

  STT_MODEL:
    process.env.OPENROUTER_STT_MODEL || "openai/whisper-large-v3-turbo",

  AUDIO_FALLBACK_MODEL:
    process.env.OPENROUTER_AUDIO_MODEL || "thedrummer/cydonia-24b-v4.1",

  VISION_MODEL: process.env.OPENROUTER_VISION_MODEL || "openai/gpt-4o-mini",

  OPENROUTER_STREAM: readBoolean("OPENROUTER_STREAM", false),
  INTERACTIVE_STATE_FILE: process.env.INTERACTIVE_STATE_FILE
    ? path.resolve(process.env.INTERACTIVE_STATE_FILE)
    : path.join(
        path.dirname(
          process.env.MEMORY_FILE
            ? path.resolve(process.env.MEMORY_FILE)
            : path.join(__dirname, "..", "memory.json"),
        ),
        "interactive-state.json",
      ),
  INTERACTIVE_QUESTION_TTL_MS: readPositiveNumber(
    "INTERACTIVE_QUESTION_TTL_MS",
    24 * 60 * 60 * 1000,
  ),

  BOT_TOKEN: process.env.BOT_TOKEN,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  HOST: String(process.env.HOST || "0.0.0.0").trim() || "0.0.0.0",
  PORT: readPort(),
  STT_LANGUAGE: process.env.OPENROUTER_STT_LANGUAGE,
  MAX_AUDIO_BYTES: readByteLimit("MAX_AUDIO_BYTES", 25 * 1024 * 1024),
  MAX_IMAGE_BYTES: readByteLimit("MAX_IMAGE_BYTES", 10 * 1024 * 1024),
  MEMORY_FILE: process.env.MEMORY_FILE
    ? path.resolve(process.env.MEMORY_FILE)
    : path.join(__dirname, "..", "memory.json"),

  MAX_HISTORY_MESSAGES: readPositiveNumber("MAX_HISTORY_MESSAGES", 60),
  MAX_STORED_MESSAGES: readPositiveNumber("MAX_STORED_MESSAGES", 300),
  MAX_MEMORY_SUMMARY_CHARS: readPositiveNumber(
    "MAX_MEMORY_SUMMARY_CHARS",
    6000,
  ),
  MAX_MESSAGE_CONTENT_CHARS: readPositiveNumber(
    "MAX_MESSAGE_CONTENT_CHARS",
    4000,
  ),
  MAX_PERSONAL_NOTES: 12,
  PROCESSED_MESSAGE_TTL_MS: 10 * 60 * 1000,
  DUPLICATE_REPLY_TTL_MS: 15 * 1000,

  BOT_TO_BOT_ENABLED: readBoolean("BOT_TO_BOT_ENABLED", false),
  BOT_TO_BOT_OWNER_CHAT_ID:
    process.env.BOT_TO_BOT_OWNER_CHAT_ID ||
    process.env.BOT_OWNER_CHAT_ID ||
    process.env.OWNER_CHAT_ID ||
    process.env.ACCOUNT_ASSISTANT_OWNER_CHAT_ID,
  BOT_TO_BOT_CHAT_ID: process.env.BOT_TO_BOT_CHAT_ID || process.env.CHAT_ID,
  BOT_TO_BOT_TARGET_BOT_USERNAME:
    process.env.BOT_TO_BOT_TARGET_BOT_USERNAME ||
    process.env.BOT_TO_BOT_TARGET_USERNAME ||
    "",
  BOT_TO_BOT_ALLOW_BOTS: readList("BOT_TO_BOT_ALLOW_BOTS"),
  BOT_TO_BOT_MAX_TURNS: readPositiveNumber("BOT_TO_BOT_MAX_TURNS", 6),
  BOT_TO_BOT_WINDOW_MS: readPositiveNumber(
    "BOT_TO_BOT_WINDOW_MS",
    2 * 60 * 1000,
  ),
  BOT_TO_BOT_MIN_INTERVAL_MS: readPositiveNumber(
    "BOT_TO_BOT_MIN_INTERVAL_MS",
    2000,
  ),

  ACCOUNT_ASSISTANT_ENABLED: readBoolean("ACCOUNT_ASSISTANT_ENABLED", false),
  ACCOUNT_ASSISTANT_MODE: process.env.ACCOUNT_ASSISTANT_MODE || "approval",
  ACCOUNT_ASSISTANT_OWNER_CHAT_ID:
    process.env.ACCOUNT_ASSISTANT_OWNER_CHAT_ID ||
    process.env.BOT_OWNER_CHAT_ID ||
    process.env.OWNER_CHAT_ID,
  ACCOUNT_ASSISTANT_PRIVATE_ONLY: readBoolean(
    "ACCOUNT_ASSISTANT_PRIVATE_ONLY",
    true,
  ),
  ACCOUNT_ASSISTANT_ALLOW_CHATS: readList("ACCOUNT_ASSISTANT_ALLOW_CHATS"),
  ACCOUNT_ASSISTANT_BLOCK_CHATS: readList("ACCOUNT_ASSISTANT_BLOCK_CHATS"),
  ACCOUNT_ASSISTANT_REPLY_DELAY_MS: readPositiveNumber(
    "ACCOUNT_ASSISTANT_REPLY_DELAY_MS",
    1200,
  ),
  ACCOUNT_ASSISTANT_MIN_INTERVAL_MS: readPositiveNumber(
    "ACCOUNT_ASSISTANT_MIN_INTERVAL_MS",
    30000,
  ),
  ACCOUNT_ASSISTANT_DRAFT_TTL_MS: readPositiveNumber(
    "ACCOUNT_ASSISTANT_DRAFT_TTL_MS",
    30 * 60 * 1000,
  ),
  ACCOUNT_ASSISTANT_MAX_TEXT_CHARS: readPositiveNumber(
    "ACCOUNT_ASSISTANT_MAX_TEXT_CHARS",
    1200,
  ),
  ACCOUNT_ASSISTANT_PROMPT: process.env.ACCOUNT_ASSISTANT_PROMPT || "",
  TELEGRAM_API_ID: Number(process.env.TELEGRAM_API_ID || 0),
  TELEGRAM_API_HASH: process.env.TELEGRAM_API_HASH,
  TELEGRAM_STRING_SESSION: process.env.TELEGRAM_STRING_SESSION,

  WEBHOOK_URL: String(process.env.WEBHOOK_URL || "")
    .trim()
    .replace(/\/+$/, ""),
  WEBHOOK_PATH: process.env.WEBHOOK_PATH || "/telegram-webhook",
  WEBHOOK_SECRET_TOKEN: process.env.WEBHOOK_SECRET_TOKEN || "",
};

function validateConfig(options = {}) {
  if (
    CONFIG.BOT_ACCESS_PASSWORD_HASH &&
    !/^scrypt:[a-f0-9]{32}:[a-f0-9]{64}$/.test(CONFIG.BOT_ACCESS_PASSWORD_HASH)
  )
    throw new Error(
      "Некорректный BOT_ACCESS_PASSWORD_HASH. Выполни npm run setup.",
    );
  if (CONFIG.WEB_PUBLIC_URL) {
    const url = new URL(CONFIG.WEB_PUBLIC_URL);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error(
        "WEB_PUBLIC_URL должен быть публичным HTTPS-адресом без учётных данных.",
      );
  }
  if (options.telegram !== false && !CONFIG.BOT_TOKEN) {
    throw new Error("BOT_TOKEN не найден в .env");
  }

  if (CONFIG.WEBHOOK_URL) {
    let webhookUrl;

    try {
      webhookUrl = new URL(CONFIG.WEBHOOK_URL);
    } catch {
      throw new Error(
        "WEBHOOK_URL должен быть полным HTTPS URL, например https://bot.example.com",
      );
    }

    if (
      webhookUrl.protocol !== "https:" ||
      !webhookUrl.hostname ||
      (webhookUrl.pathname !== "" && webhookUrl.pathname !== "/") ||
      webhookUrl.username ||
      webhookUrl.password ||
      webhookUrl.search ||
      webhookUrl.hash
    ) {
      throw new Error(
        "WEBHOOK_URL должен быть HTTPS URL без логина, пароля, query и hash",
      );
    }

    if (!/^\/[A-Za-z0-9_/-]*$/.test(CONFIG.WEBHOOK_PATH)) {
      throw new Error(
        "WEBHOOK_PATH должен начинаться с / и содержать только буквы, цифры, /, _ или -",
      );
    }

    if (!/^[A-Za-z0-9_-]{1,256}$/.test(CONFIG.WEBHOOK_SECRET_TOKEN)) {
      throw new Error(
        "Для webhook задайте WEBHOOK_SECRET_TOKEN длиной 1–256 символов: буквы, цифры, _ или -",
      );
    }
  }
}

module.exports = {
  ...CONFIG,
  validateConfig,
};
