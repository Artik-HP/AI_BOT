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

function buildStatusText(me, client) {
  return [
    "Userbot статус:",
    `Username: ${me.username || "<none>"}`,
    `Name: ${[me.firstName, me.lastName].filter(Boolean).join(" ") || "<unknown>"}`,
    `User ID: ${me.id?.toString() || "<unknown>"}`,
    `Session: ${session ? "loaded" : "missing"}`,
    `Telegram API ID: ${apiId}`,
    `Connected: ${client?.isConnected ? "yes" : "no"}`,
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

  switch (command.name) {
    case "help":
      await safeReply(message, buildHelpText());
      break;

    case "ping":
      await safeReply(message, "pong");
      break;

    case "say": {
      if (!command.args) {
        await safeReply(message, "Использование: .say <текст>");
        return;
      }
      await safeReply(message, command.args);
      break;
    }

    case "echo": {
      if (!command.args) {
        await safeReply(message, "Использование: .echo <текст>");
        return;
      }
      await safeReply(message, command.args);
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
      await safeReply(message, buildStatusText(me, client));
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
      console.log("Unknown command:", command.name);
      break;
  }
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

  client.addEventHandler((event) => handleIncomingMessage(client, event), new NewMessage({ incoming: true }));

  await client.connect();

  const me = await client.getMe();
  console.log("Userbot connected as", me.username || `${me.firstName || ""} ${me.lastName || ""}`.trim());
  console.log(startMessage);

  if (sendSelfOnStart) {
    await safeSendSelf(client, startMessage);
  }

  process.on("SIGINT", async () => {
    console.log("Stopping userbot...");
    await client.disconnect();
    process.exit(0);
  });

  process.on("unhandledRejection", (error) => {
    console.error("Unhandled rejection:", error);
  });
}

startUserbot().catch((error) => {
  console.error("Userbot failed to start:", error.message || error);
  process.exit(1);
});