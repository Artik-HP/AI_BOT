require("dotenv").config();

const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const session = process.env.TELEGRAM_STRING_SESSION;
const startMessage = process.env.USERBOT_START_MESSAGE || "Userbot started.";
const sendSelfOnStart = process.env.USERBOT_SEND_SELF === "true";

function validateEnv() {
  const missing = [];

  if (!Number.isFinite(apiId) || apiId <= 0) {
    missing.push("TELEGRAM_API_ID");
  }

  if (!apiHash) {
    missing.push("TELEGRAM_API_HASH");
  }

  if (!session) {
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
  const match = raw.match(/^[./](\w+)(?:\s+([\s\S]+))?$/);

  if (!match) {
    return null;
  }

  return {
    name: match[1].toLowerCase(),
    args: normalizeText(match[2] || "")
  };
}

async function safeReply(message, text) {
  if (!message) {
    return;
  }

  try {
    await message.reply({ message: text });
  } catch (error) {
    console.error("Failed to reply:", error.message || error);
  }
}

async function safeSendSelf(client, text) {
  try {
    await client.sendMessage("me", { message: text });
  } catch (error) {
    console.error("Failed to send self message:", error.message || error);
  }
}

async function handleCommand(client, event, command) {
  const message = event.message;
  const chatId = String(message.chatId || message.peerId?.chatId || 'unknown');
  const userId = String(message.senderId || 'unknown');
  const response = await require('../src/commandSystem/engine').execute({
    scope: `u:${chatId}:${userId}`, transport: 'userbot', chatId, userId, client
  }, 'userbot_' + command.name, {args:command.args}, `u:${chatId}:${message.id}`);
  for (const chunk of require('../src/services/telegram').splitTelegramMessage(response.text)) await safeReply(message,chunk);
}
async function handleIncomingMessage(client, event) {
  const message = event.message;

  if (!message || message.out) {
    return;
  }

  const text = normalizeText(message.message || message.text || message.rawText);

  if (!text) {
    return;
  }

  const command = parseCommand(text);

  if (command) {
    await handleCommand(client, event, command);
    return;
  }

  if (text.toLowerCase().includes("userbot")) {
    await safeReply(message, "Я работаю как userbot. Напиши .help для списка команд.");
  }
}

async function startUserbot() {
  validateEnv();

  const client = new TelegramClient(
    new StringSession(session),
    apiId,
    apiHash,
    { connectionRetries: 5 }
  );

  client.addEventHandler((event) => {
    handleIncomingMessage(client, event).catch((error) => {
      console.error("Userbot message handler error:", error.message || error);
    });
  }, new NewMessage({ incoming: true }));

  await client.connect();

  const me = await client.getMe();
  console.log("Userbot connected as", me.username || `${me.firstName || ""} ${me.lastName || ""}`.trim());
  console.log(startMessage);

  if (sendSelfOnStart) {
    await safeSendSelf(client, startMessage);
  }

  const shutdown = async () => {
    console.log("Stopping userbot...");
    await client.disconnect().catch((error) => {
      console.error("Failed to disconnect userbot:", error.message || error);
    });
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  process.on("unhandledRejection", (error) => {
    console.error("Unhandled rejection:", error);
  });
}

if (require.main === module) startUserbot().catch((error) => {
  console.error("Userbot failed to start:", error.message || error);
  process.exit(1);
});

module.exports = { parseCommand, handleCommand, handleIncomingMessage, startUserbot };
