const logger = require("../src/utils/logger");
const { buildConfig, parseBoolean } = require("../src/config");
const { safeHandler } = require("../src/utils/safe");

// A reply that starts with the command prefix would be parsed as a command again when the
// account sees its own message, and ".say .say x" would loop forever. A zero-width space breaks the prefix.
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);

function readSettings(env = process.env, warn = logger.warn) {
  const config = buildConfig(env, warn);

  return {
    apiId: config.TELEGRAM_API_ID,
    apiHash: config.TELEGRAM_API_HASH,
    session: config.TELEGRAM_STRING_SESSION,
    allowedUserIds: config.USERBOT_ALLOWED_USER_IDS,
    startMessage: env.USERBOT_START_MESSAGE || "Userbot started.",
    sendSelfOnStart: parseBoolean(env.USERBOT_SEND_SELF) === true
  };
}

function validateSettings(settings) {
  const missing = [];

  if (!Number.isFinite(settings.apiId) || settings.apiId <= 0) {
    missing.push("TELEGRAM_API_ID");
  }

  if (!settings.apiHash) {
    missing.push("TELEGRAM_API_HASH");
  }

  if (!settings.session) {
    missing.push("TELEGRAM_STRING_SESSION");
  }

  if (missing.length) {
    throw new Error(
      `Missing Telegram userbot configuration in .env: ${missing.join(", ")}. ` +
      "Установите TELEGRAM_API_ID, TELEGRAM_API_HASH и TELEGRAM_STRING_SESSION."
    );
  }
}

function normalizeText(text) {
  return String(text || "").trim();
}

function parseCommand(text) {
  const raw = normalizeText(text);
  const match = raw.match(/^\.(\w+)(?:\s+([\s\S]+))?$/);

  if (!match) {
    return null;
  }

  return {
    name: match[1].toLowerCase(),
    args: normalizeText(match[2] || "")
  };
}

// Commands act as the account owner, so they obey only the owner: messages the account sent itself
// (from any of the owner's devices) and, optionally, the explicitly listed user ids.
function isAuthorized(message, allowedUserIds = []) {
  if (message.out) {
    return true;
  }

  const senderId = message.senderId == null ? "" : String(message.senderId);
  return Boolean(senderId) && allowedUserIds.includes(senderId);
}

function neutralizeCommandPrefix(text) {
  return text.startsWith(".") ? `${ZERO_WIDTH_SPACE}${text}` : text;
}

function buildHelpText() {
  return [
    "Userbot команды:",
    ".help — показать это сообщение",
    ".ping — проверить связь",
    ".say <текст> — повторить текст",
    ".echo <текст> — дублировать текст",
    ".whoami — информация об аккаунте",
    ".status — состояние userbot",
    ".chatid — ID текущего чата",
    ".time — текущее время"
  ].join("\n");
}

function buildStatusText(me, client, settings) {
  return [
    "Userbot статус:",
    `Username: ${me.username || "<none>"}`,
    `Name: ${[me.firstName, me.lastName].filter(Boolean).join(" ") || "<unknown>"}`,
    `User ID: ${me.id?.toString() || "<unknown>"}`,
    `Session: ${settings.session ? "loaded" : "missing"}`,
    `Connected: ${client?.connected ? "yes" : "no"}`,
    `Environment: ${process.env.NODE_ENV || "development"}`
  ].join("\n");
}

async function safeReply(message, text) {
  if (!message) {
    return;
  }

  try {
    await message.reply({ message: text });
  } catch (error) {
    logger.error("Failed to reply:", error);
  }
}

async function safeSendSelf(client, text) {
  try {
    await client.sendMessage("me", { message: text });
  } catch (error) {
    logger.error("Failed to send self message:", error);
  }
}

async function handleCommand(client, event, command, settings) {
  const message = event.message;

  switch (command.name) {
    case "help":
      await safeReply(message, buildHelpText());
      break;

    case "ping":
      await safeReply(message, "pong");
      break;

    case "say":
    case "echo": {
      if (!command.args) {
        await safeReply(message, `Использование: .${command.name} <текст>`);
        return;
      }
      await safeReply(message, neutralizeCommandPrefix(command.args));
      break;
    }

    case "whoami": {
      const me = await client.getMe();
      const name = [me.firstName, me.lastName].filter(Boolean).join(" ") || "<unknown>";
      await safeReply(message, `Я: ${name}\nUsername: ${me.username || "<none>"}\nID: ${me.id?.toString() || "<unknown>"}`);
      break;
    }

    case "status": {
      const me = await client.getMe();
      await safeReply(message, buildStatusText(me, client, settings));
      break;
    }

    case "chatid": {
      await safeReply(message, `Chat ID: ${message.chatId || message.peerId?.chatId || "<unknown>"}`);
      break;
    }

    case "time": {
      await safeReply(message, `Текущее время: ${new Date().toLocaleString()}`);
      break;
    }

    default:
      logger.debug("Unknown userbot command:", command.name);
      break;
  }
}

// Strangers get no reaction at all: not even a hint that the account runs a userbot.
async function handleIncomingMessage(client, event, settings) {
  const message = event.message;

  if (!message) {
    return;
  }

  const command = parseCommand(message.message || message.text || message.rawText);

  if (!command || !isAuthorized(message, settings.allowedUserIds)) {
    return;
  }

  await handleCommand(client, event, command, settings);
}

async function startUserbot(env = process.env) {
  const settings = readSettings(env);

  validateSettings(settings);

  const { TelegramClient } = require("telegram");
  const { StringSession } = require("telegram/sessions");
  const { NewMessage } = require("telegram/events");

  const client = new TelegramClient(
    new StringSession(settings.session),
    settings.apiId,
    settings.apiHash,
    { connectionRetries: 5 }
  );

  // No `incoming` filter: the owner's own messages are commands too.
  client.addEventHandler(
    safeHandler("Userbot message handler", (event) => handleIncomingMessage(client, event, settings)),
    new NewMessage({})
  );

  process.on("unhandledRejection", (error) => {
    logger.error("Unhandled rejection:", error);
  });

  await client.connect();

  const me = await client.getMe();
  logger.info("Userbot connected as", me.username || `${me.firstName || ""} ${me.lastName || ""}`.trim());
  logger.info(settings.startMessage);
  logger.info(settings.allowedUserIds.length
    ? `Команды принимаются от аккаунта и от пользователей: ${settings.allowedUserIds.join(", ")}`
    : "Команды принимаются только от самого аккаунта (USERBOT_ALLOWED_USER_IDS не задан).");

  if (settings.sendSelfOnStart) {
    await safeSendSelf(client, settings.startMessage);
  }

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, async () => {
      logger.info("Stopping userbot...");
      await client.disconnect().catch(() => {});
      process.exit(0);
    });
  }

  return client;
}

module.exports = {
  readSettings,
  validateSettings,
  parseCommand,
  isAuthorized,
  neutralizeCommandPrefix,
  buildHelpText,
  buildStatusText,
  handleCommand,
  handleIncomingMessage,
  startUserbot
};

if (require.main === module) {
  require("dotenv").config();

  startUserbot().catch((error) => {
    logger.error("Userbot failed to start:", error);
    process.exit(1);
  });
}
