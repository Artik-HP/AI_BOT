require("dotenv").config();

const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const session = process.env.TELEGRAM_STRING_SESSION;

const client = new TelegramClient(
  new StringSession(session),
  apiId,
  apiHash,
  { connectionRetries: 5 }
);

async function main() {
  await client.connect();

  console.log("Userbot started");

  await client.sendMessage("me", {
    message: "тест"
  });

  client.addEventHandler(async (event) => {
    const message = event.message;
    const text = message.message || "";

    if (text === ".ping") {
      await message.reply({ message: "pong" });
    }

    if (text.startsWith(".say ")) {
      await message.reply({ message: text.slice(5) });
    }
  }, new NewMessage({}));

  await new Promise(() => {});
}

main().catch(console.error);