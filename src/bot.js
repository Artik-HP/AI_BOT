const express = require("express");
const CONFIG = require("./config");
const logger = require("./utils/logger");

function start() {
  logger.info("Бот запущен");
  logger.info("BOT_TOKEN есть?", !!CONFIG.BOT_TOKEN);
  logger.info("ENV путь:", process.cwd());

  CONFIG.validateConfig();

  const { createTelegramBot } = require("./services/telegram");
  const commands = require("./commands");
  const { registerTextHandler } = require("./handlers/text");
  const { registerPhotoHandler } = require("./handlers/photo");
  const { registerVoiceHandler } = require("./handlers/voice");
  const { getSttModels } = require("./services/openrouter");
  const { getUserCount } = require("./services/memory");

  const app = express();

  logger.info("Bot token loaded:", Boolean(CONFIG.BOT_TOKEN));
  logger.info("OpenRouter key loaded:", Boolean(CONFIG.OPENROUTER_API_KEY));
  logger.info("Bot started");

  const bot = createTelegramBot();
  commands.initCommands(bot);
  registerVoiceHandler(bot);
  registerPhotoHandler(bot);
  registerTextHandler(bot, commands);

  bot.on("polling_error", (error) => {
    console.error("Telegram polling error:", error.message);
  });

  app.get("/", (req, res) => {
    res.send("Bot is alive");
  });

  app.get("/health", (req, res) => {
    res.json({
      ok: true,
      model: CONFIG.MODEL,
      sttModels: getSttModels(),
      audioFallbackModel: CONFIG.AUDIO_FALLBACK_MODEL,
      users: getUserCount()
    });
  });

  const server = app.listen(CONFIG.PORT, () => {
    console.log(`Web server started on port ${CONFIG.PORT}`);
  });

  return { app, bot, server };
}

module.exports = {
  start
};
