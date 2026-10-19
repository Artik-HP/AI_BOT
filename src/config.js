const path = require("path");
const logger = require("./utils/logger");

const TRUE_VALUES = new Set(["1", "true", "yes", "y", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "n", "off"]);
const ACCOUNT_ASSISTANT_MODES = ["approval", "auto", "dry-run"];
const BOT_TOKEN_PATTERN = /^\d{5,}:[\w-]{20,}$/;
const CHAT_ID_PATTERN = /^-?\d+$/;
const BYTES_PATTERN = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i;
const BYTES_UNITS = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
const PLACEHOLDER_PATTERN =
  /process\.env\.|^\s*(?:your|ваш\p{L}*|твой|example|changeme|change_me|todo|xxx+)[\p{L}\p{N}_\s.-]*$|^<.*>$|^\$\{.*\}$|_here$/iu;

// Values copied from .env.example or docs without being filled in ("process.env.BOT_TOKEN", "your_token", ...).
function isPlaceholder(value) {
  return PLACEHOLDER_PATTERN.test(String(value ?? ""));
}

// true / false for recognised words, null otherwise. A typo must not silently turn into "false".
function parseBoolean(value) {
  const word = String(value ?? "").trim().toLowerCase();

  if (TRUE_VALUES.has(word)) {
    return true;
  }

  return FALSE_VALUES.has(word) ? false : null;
}

function clean(env, name) {
  return env[name] == null ? "" : String(env[name]).trim();
}

function readString(env, name, fallback, warn) {
  const value = clean(env, name);

  if (!value) {
    return fallback;
  }

  if (isPlaceholder(value)) {
    warn(`${name}: значение «${value}» похоже на заглушку, используется ${fallback || "пусто"}`);
    return fallback;
  }

  return value;
}

function readNumber(env, name, fallback, warn, { min = 0, max = Infinity, integer = false } = {}) {
  const raw = clean(env, name);

  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  const valid = Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value));

  if (!valid) {
    warn(`${name}: «${raw}» не подходит, используется ${fallback}`);
    return fallback;
  }

  return value;
}

// Accepts plain numbers and suffixes: 26214400, 25MB, 512KB, 1.5GB.
function readBytes(env, name, fallback, warn) {
  const raw = clean(env, name);

  if (!raw) {
    return fallback;
  }

  const match = raw.match(BYTES_PATTERN);
  const value = match ? Math.round(Number(match[1]) * BYTES_UNITS[(match[2] || "b").toLowerCase()]) : NaN;

  if (!Number.isFinite(value) || value <= 0) {
    warn(`${name}: «${raw}» не подходит (ожидается число байт или вид 25MB), используется ${fallback}`);
    return fallback;
  }

  return value;
}

function readBoolean(env, name, fallback, warn) {
  const raw = clean(env, name);

  if (!raw) {
    return fallback;
  }

  const value = parseBoolean(raw);

  if (value === null) {
    warn(`${name}: «${raw}» не распознано как true/false, используется ${fallback}`);
    return fallback;
  }

  return value;
}

function readList(env, name) {
  return clean(env, name)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function readIdList(env, name, warn) {
  return readList(env, name).filter((value) => {
    if (CHAT_ID_PATTERN.test(value)) {
      return true;
    }

    warn(`${name}: «${value}» не числовой ID и пропущен`);
    return false;
  });
}

function readChatId(env, names, warn) {
  for (const name of names) {
    const value = clean(env, name);

    if (!value) {
      continue;
    }

    if (CHAT_ID_PATTERN.test(value)) {
      return value;
    }

    warn(`${name}: «${value}» не числовой ID, пропущен`);
  }

  return undefined;
}

function readEnum(env, name, allowed, fallback, warn) {
  const value = clean(env, name).toLowerCase();

  if (!value) {
    return fallback;
  }

  if (!allowed.includes(value)) {
    warn(`${name}: «${value}» не из списка (${allowed.join(", ")}), используется ${fallback}`);
    return fallback;
  }

  return value;
}

function readUrl(env, name, fallback, warn) {
  const raw = clean(env, name);

  if (!raw) {
    return fallback;
  }

  try {
    const url = new URL(raw);

    if (!/^https?:$/.test(url.protocol)) {
      throw new Error("unsupported protocol");
    }

    return raw.replace(/\/+$/, "");
  } catch {
    warn(`${name}: «${raw}» не URL (нужен http:// или https://), используется ${fallback}`);
    return fallback;
  }
}

function buildConfig(env = process.env, warn = logger.warn) {
  const owner = {
    botToBot: readChatId(env, ["BOT_TO_BOT_OWNER_CHAT_ID"], warn),
    accountAssistant: readChatId(env, ["ACCOUNT_ASSISTANT_OWNER_CHAT_ID"], warn),
    generic: readChatId(env, ["BOT_OWNER_CHAT_ID"], warn),
    legacy: readChatId(env, ["OWNER_CHAT_ID"], warn)
  };

  return {
    MODEL: readString(env, "OPENROUTER_MODEL", "openai/gpt-4o-mini", warn),
    STT_MODEL: readString(env, "OPENROUTER_STT_MODEL", "openai/whisper-large-v3-turbo", warn),
    AUDIO_FALLBACK_MODEL: readString(env, "OPENROUTER_AUDIO_MODEL", "thedrummer/cydonia-24b-v4.1", warn),
    VISION_MODEL: readString(env, "OPENROUTER_VISION_MODEL", "openai/gpt-4o-mini", warn),
    OPENROUTER_BASE_URL: readUrl(env, "OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1", warn),
    OPENROUTER_MAX_TOKENS: readNumber(env, "OPENROUTER_MAX_TOKENS", 1500, warn, { min: 16, integer: true }),
    APP_URL: readString(env, "APP_URL", "http://localhost", warn),
    TELEGRAM_API_BASE_URL: readUrl(env, "TELEGRAM_API_BASE_URL", "https://api.telegram.org", warn),

    BOT_TOKEN: clean(env, "BOT_TOKEN"),
    OPENROUTER_API_KEY: clean(env, "OPENROUTER_API_KEY"),
    PORT: readNumber(env, "PORT", 12722, warn, { min: 0, max: 65535, integer: true }),
    HEALTH_TOKEN: clean(env, "HEALTH_TOKEN"),
    STT_LANGUAGE: readString(env, "OPENROUTER_STT_LANGUAGE", undefined, warn),
    MAX_AUDIO_BYTES: readBytes(env, "MAX_AUDIO_BYTES", 25 * 1024 * 1024, warn),
    MAX_IMAGE_BYTES: readBytes(env, "MAX_IMAGE_BYTES", 10 * 1024 * 1024, warn),
    MEMORY_FILE: env.MEMORY_FILE
      ? path.resolve(env.MEMORY_FILE)
      : path.join(__dirname, "..", "memory.json"),

    MAX_HISTORY_MESSAGES: readNumber(env, "MAX_HISTORY_MESSAGES", 60, warn, { min: 1, integer: true }),
    MAX_STORED_MESSAGES: readNumber(env, "MAX_STORED_MESSAGES", 300, warn, { min: 1, integer: true }),
    MAX_MEMORY_SUMMARY_CHARS: readNumber(env, "MAX_MEMORY_SUMMARY_CHARS", 6000, warn, { min: 100, integer: true }),
    MAX_MESSAGE_CONTENT_CHARS: readNumber(env, "MAX_MESSAGE_CONTENT_CHARS", 4000, warn, { min: 100, integer: true }),
    MAX_PERSONAL_NOTES: 12,
    MEMORY_SAVE_DEBOUNCE_MS: readNumber(env, "MEMORY_SAVE_DEBOUNCE_MS", 1000, warn, { min: 0, integer: true }),
    MEMORY_BACKUP_INTERVAL_MS: readNumber(env, "MEMORY_BACKUP_INTERVAL_MS", 5 * 60 * 1000, warn, { min: 0, integer: true }),
    PROCESSED_MESSAGE_TTL_MS: 10 * 60 * 1000,
    DUPLICATE_REPLY_TTL_MS: 15 * 1000,
    MAX_REPLY_PARTS: readNumber(env, "MAX_REPLY_PARTS", 6, warn, { min: 1, integer: true }),

    OWNER_CHAT_IDS: [...new Set(Object.values(owner).filter(Boolean))],
    BOT_ALLOWED_USER_IDS: readIdList(env, "BOT_ALLOWED_USER_IDS", warn),
    RATE_LIMIT_MESSAGES: readNumber(env, "RATE_LIMIT_MESSAGES", 20, warn, { min: 1, integer: true }),
    RATE_LIMIT_WINDOW_MS: readNumber(env, "RATE_LIMIT_WINDOW_MS", 60 * 1000, warn, { min: 1000, integer: true }),

    BOT_TO_BOT_ENABLED: readBoolean(env, "BOT_TO_BOT_ENABLED", false, warn),
    BOT_TO_BOT_OWNER_CHAT_ID: owner.botToBot || owner.generic || owner.legacy || owner.accountAssistant,
    BOT_TO_BOT_CHAT_ID: readChatId(env, ["BOT_TO_BOT_CHAT_ID", "CHAT_ID"], warn),
    BOT_TO_BOT_TARGET_BOT_USERNAME:
      readString(env, "BOT_TO_BOT_TARGET_BOT_USERNAME", "", warn) ||
      readString(env, "BOT_TO_BOT_TARGET_USERNAME", "", warn),
    BOT_TO_BOT_ALLOW_BOTS: readList(env, "BOT_TO_BOT_ALLOW_BOTS"),
    BOT_TO_BOT_MAX_TURNS: readNumber(env, "BOT_TO_BOT_MAX_TURNS", 6, warn, { min: 1, integer: true }),
    BOT_TO_BOT_WINDOW_MS: readNumber(env, "BOT_TO_BOT_WINDOW_MS", 2 * 60 * 1000, warn, { min: 1, integer: true }),
    BOT_TO_BOT_MIN_INTERVAL_MS: readNumber(env, "BOT_TO_BOT_MIN_INTERVAL_MS", 2000, warn, { min: 0, integer: true }),

    ACCOUNT_ASSISTANT_ENABLED: readBoolean(env, "ACCOUNT_ASSISTANT_ENABLED", false, warn),
    ACCOUNT_ASSISTANT_MODE: readEnum(env, "ACCOUNT_ASSISTANT_MODE", ACCOUNT_ASSISTANT_MODES, "approval", warn),
    ACCOUNT_ASSISTANT_AUTO_ALLOW_ANY: readBoolean(env, "ACCOUNT_ASSISTANT_AUTO_ALLOW_ANY", false, warn),
    ACCOUNT_ASSISTANT_OWNER_CHAT_ID: owner.accountAssistant || owner.generic || owner.legacy,
    ACCOUNT_ASSISTANT_PRIVATE_ONLY: readBoolean(env, "ACCOUNT_ASSISTANT_PRIVATE_ONLY", true, warn),
    ACCOUNT_ASSISTANT_ALLOW_CHATS: readList(env, "ACCOUNT_ASSISTANT_ALLOW_CHATS"),
    ACCOUNT_ASSISTANT_BLOCK_CHATS: readList(env, "ACCOUNT_ASSISTANT_BLOCK_CHATS"),
    ACCOUNT_ASSISTANT_REPLY_DELAY_MS: readNumber(env, "ACCOUNT_ASSISTANT_REPLY_DELAY_MS", 1200, warn, { min: 0, integer: true }),
    ACCOUNT_ASSISTANT_MIN_INTERVAL_MS: readNumber(env, "ACCOUNT_ASSISTANT_MIN_INTERVAL_MS", 30000, warn, { min: 0, integer: true }),
    ACCOUNT_ASSISTANT_DRAFT_TTL_MS: readNumber(env, "ACCOUNT_ASSISTANT_DRAFT_TTL_MS", 30 * 60 * 1000, warn, { min: 1000, integer: true }),
    ACCOUNT_ASSISTANT_MAX_TEXT_CHARS: readNumber(env, "ACCOUNT_ASSISTANT_MAX_TEXT_CHARS", 1200, warn, { min: 50, integer: true }),
    ACCOUNT_ASSISTANT_PROMPT: clean(env, "ACCOUNT_ASSISTANT_PROMPT"),

    TELEGRAM_API_ID: readNumber(env, "TELEGRAM_API_ID", 0, warn, { min: 1, integer: true }),
    TELEGRAM_API_HASH: clean(env, "TELEGRAM_API_HASH"),
    TELEGRAM_STRING_SESSION: clean(env, "TELEGRAM_STRING_SESSION"),
    USERBOT_ALLOWED_USER_IDS: readIdList(env, "USERBOT_ALLOWED_USER_IDS", warn)
  };
}

const CONFIG = buildConfig();

function validateConfig(config = CONFIG) {
  const problems = [];

  if (!config.BOT_TOKEN) {
    problems.push("BOT_TOKEN не задан (токен выдаёт @BotFather)");
  } else if (isPlaceholder(config.BOT_TOKEN)) {
    problems.push(`BOT_TOKEN содержит заглушку «${config.BOT_TOKEN}», а не токен`);
  } else if (!BOT_TOKEN_PATTERN.test(config.BOT_TOKEN)) {
    problems.push("BOT_TOKEN имеет неверный формат (ожидается вид 123456789:AAH...)");
  }

  if (!config.OPENROUTER_API_KEY) {
    problems.push("OPENROUTER_API_KEY не задан (ключ создаётся на openrouter.ai/keys)");
  } else if (isPlaceholder(config.OPENROUTER_API_KEY)) {
    problems.push(`OPENROUTER_API_KEY содержит заглушку «${config.OPENROUTER_API_KEY}», а не ключ`);
  } else if (/\s/.test(config.OPENROUTER_API_KEY)) {
    problems.push("OPENROUTER_API_KEY содержит пробелы или переводы строк");
  }

  if (problems.length) {
    throw new Error(`Некорректная конфигурация (.env):\n- ${problems.join("\n- ")}`);
  }
}

module.exports = {
  ...CONFIG,
  validateConfig,
  buildConfig,
  isPlaceholder,
  parseBoolean
};
