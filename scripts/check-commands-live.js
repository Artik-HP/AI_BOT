// Read-only real integrations. No Telegram messages, polling, setMyCommands or production data writes.
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
require("dotenv").config({ quiet: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-live-"));
Object.assign(process.env, {
  MEMORY_FILE: path.join(dir, "memory.json"),
  COMMAND_DB_FILE: path.join(dir, "commands.sqlite"),
  INTERACTIVE_STATE_FILE: path.join(dir, "interactive.json"),
});
const CONFIG = require("../src/config");
const { execute, registry } = require("../src/commandSystem/engine");
const { getStore } = require("../src/commandSystem/store");
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({
      name,
      passed: false,
      error: error.response?.status
        ? `HTTP ${error.response.status}`
        : error.code || error.message.replace(/https?:\/\/\S+/g, "[URL]"),
    });
  }
  console.log(JSON.stringify(results.at(-1)));
}
async function main() {
  const only = process.argv.includes("--only")
    ? process.argv[process.argv.indexOf("--only") + 1].split(",")
    : null;
  const wanted = (name) => !only || only.includes(name);
  for (const c of registry.values())
    if (c.external === "OpenRouter" && wanted(c.id))
      await check(c.id, async () => {
        const response = await execute(
          {
            scope: "w:live:" + c.id,
            transport: "web",
            userId: "test",
            store: getStore(),
          },
          c.id,
          { args: c.example + "\nОтветь кратко, максимум 120 слов." },
        );
        if (
          response.error ||
          response.text.length < 10 ||
          /Не получилось подготовить|Не удалось/.test(response.text)
        )
          throw new Error(response.text);
      });
  if (wanted("weather"))
    await check("weather", async () => {
      const response = await execute(
        { scope: "w:live:weather", transport: "web", store: getStore() },
        "weather",
        { args: "Kyiv" },
      );
      if (response.error || !response.text.includes("°C"))
        throw new Error(response.text);
    });
  if (wanted("Telegram:getMe/getWebhookInfo"))
    await check("Telegram:getMe/getWebhookInfo", async () => {
      if (!CONFIG.BOT_TOKEN) throw new Error("BOT_TOKEN missing");
      const TelegramBot = require("node-telegram-bot-api"),
        bot = new TelegramBot(CONFIG.BOT_TOKEN, {
          polling: false,
          request: { timeout: 15000 },
        });
      const me = await bot.getMe();
      if (!me.is_bot) throw new Error("Bot identity invalid");
      await bot.getWebHookInfo();
    });
  if (wanted("TelegramAccount:authorization"))
    await check("TelegramAccount:authorization", async () => {
      if (
        !CONFIG.TELEGRAM_API_ID ||
        !CONFIG.TELEGRAM_API_HASH ||
        !CONFIG.TELEGRAM_STRING_SESSION
      )
        throw new Error("Account env missing");
      const { TelegramClient } = require("telegram"),
        { StringSession } = require("telegram/sessions");
      const client = new TelegramClient(
        new StringSession(CONFIG.TELEGRAM_STRING_SESSION),
        CONFIG.TELEGRAM_API_ID,
        CONFIG.TELEGRAM_API_HASH,
        { connectionRetries: 1, timeout: 10 },
      );
      client.setLogLevel("none");
      try {
        await client.connect();
        if (!(await client.checkAuthorization()))
          throw new Error("Account session unauthorized");
        await client.getMe();
      } finally {
        await client.disconnect().catch(() => {});
        await client.destroy().catch(() => {});
      }
    });
  if (process.env.LIVE_AUDIO_FILE && wanted("STT:real-audio"))
    await check("STT:real-audio", async () => {
      const transcript =
        await require("../src/services/openrouter").transcribeAudio(
          fs.readFileSync(process.env.LIVE_AUDIO_FILE),
          "wav",
        );
      if (!/42|forty.?two|сорок.?два/i.test(transcript))
        throw new Error("Transcription did not contain the fixture answer");
    });
  fs.mkdirSync(path.join(__dirname, "../docs"), { recursive: true });
  const output = path.join(__dirname, "../docs/command-live-results.json");
  const previous =
    only && fs.existsSync(output)
      ? JSON.parse(fs.readFileSync(output)).results
      : [];
  const combined = [
    ...previous.filter((r) => !results.some((n) => n.name === r.name)),
    ...results,
  ];
  fs.writeFileSync(
    output,
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        boundary:
          "Real AI commands, Open-Meteo and read-only Telegram/account authorization. No Telegram sends or user clicks. Isolated temporary history.",
        results: combined,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: results.filter((r) => r.passed).length,
      failed: results.filter((r) => !r.passed).length,
    }),
  );
  if (results.some((r) => !r.passed)) process.exitCode = 1;
}
main().catch((error) => {
  console.error("Live run stopped:", error.code || error.name);
  process.exitCode = 1;
});
