const fs = require("node:fs");
const path = require("node:path");
require("dotenv").config({ quiet: true });
const root = path.resolve(__dirname, "..");
const temporary = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "ai-bot-audit-services-"));
process.env.MEMORY_FILE = path.join(temporary, "memory.json");
process.env.COMMAND_DB_FILE = path.join(temporary, "commands.sqlite");
const CONFIG = require(path.join(root, "src/config"));
async function check(name, fn) {
  try { return { name, status: "PASS", ...(await fn()) }; }
  catch (error) { return { name, status: "FAIL", code: error.response?.statusCode || error.response?.status || error.code || error.name }; }
}
async function main() {
  const results = await Promise.all([
    check("Open-Meteo: real weather", async () => {
      const text = await require(path.join(root, "src/commandSystem/tools")).weather("Kyiv");
      if (!text.includes("°C") || !text.includes("Open-Meteo")) throw new Error("Incomplete weather output");
      return { boundary: "Two real HTTP requests; no personal data or AI generation" };
    }),
    check("Telegram: getMe/getWebhookInfo", async () => {
      if (!CONFIG.BOT_TOKEN) throw Object.assign(new Error("not configured"), { code: "NOT_CONFIGURED" });
      const TelegramBot = require("node-telegram-bot-api");
      const bot = new TelegramBot(CONFIG.BOT_TOKEN, { polling: false, request: { timeout: 15000 } });
      const me = await bot.getMe();
      if (!me.is_bot) throw new Error("Invalid bot identity");
      const webhook = await bot.getWebHookInfo();
      return { identityIsBot: true, webhookConfigured: Boolean(webhook.url), pendingUpdates: webhook.pending_update_count, webhookHasLastError: Boolean(webhook.last_error_message), boundary: "Read-only; no polling, sends, command registration or webhook changes" };
    }),
    check("OpenRouter: model catalog", async () => {
      const result = await require(path.join(root, "src/services/aiProviders")).checkProvider("openrouter");
      if (result.status !== "reachable") throw Object.assign(new Error("provider unavailable"), { code: result.code });
      return { boundary: "Real authenticated model catalog; generation verified separately" };
    }),
  ]);
  const output = { checkedAt: new Date().toISOString(), results };
  fs.writeFileSync(path.join(__dirname, "audit-live-2026-10-19", "read-only-services.json"), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
  if (results.some((result) => result.status !== "PASS")) process.exitCode = 1;
}
main().catch((error) => { console.error(error.code || error.name); process.exitCode = 1; });
