require("dotenv").config();

const readline = require("readline");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

const apiId = Number(process.env.TELEGRAM_API_ID || 0);
const apiHash = process.env.TELEGRAM_API_HASH;

if (!Number.isFinite(apiId) || apiId <= 0 || !apiHash) {
  console.error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env first.");
  process.exit(1);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function main() {
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 5
  });

  await client.start({
    phoneNumber: () => ask("Telegram phone number (+380...): "),
    phoneCode: () => ask("Telegram login code: "),
    password: () => ask("Two-step password, if enabled: "),
    onError: (error) => console.error("Telegram auth error:", error.message)
  });

  const session = client.session.save();
  console.log("");
  console.log("Copy this line into .env:");
  console.log(`TELEGRAM_STRING_SESSION=${session}`);
  console.log("");
  console.log("Keep this value private. It gives access to the Telegram account session.");

  await client.disconnect();
}

main()
  .catch((error) => {
    console.error("Could not create Telegram session:", error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    rl.close();
  });
