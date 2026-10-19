const express = require("express");
const CONFIG = require("./config");
const logger = require("./utils/logger");

function start(options = {}) {
  logger.info("Бот запущен");
  logger.info("BOT_TOKEN есть?", !!CONFIG.BOT_TOKEN);
  logger.info("ENV путь:", process.cwd());

  CONFIG.validateConfig();

  const {
    createTelegramBot,
    verifyWebhookSecret,
  } = require("./services/telegram");
  const commands = require("./commands");
  const { registerTextHandler } = require("./handlers/text");
  const { registerInteractiveHandler } = require("./services/conversation");
  const { registerPhotoHandler } = require("./handlers/photo");
  const { registerVoiceHandler } = require("./handlers/voice");
  const { startAccountAssistant } = require("./services/accountAssistant");

  const app = express();

  logger.info("Bot token loaded:", Boolean(CONFIG.BOT_TOKEN));
  logger.info("OpenRouter key loaded:", Boolean(CONFIG.OPENROUTER_API_KEY));
  logger.info("Bot started");

  const bot = options.bot || createTelegramBot();
  commands.initCommands(bot);
  registerVoiceHandler(bot);
  registerPhotoHandler(bot);
  require("./handlers/document").registerDocumentHandler(bot);
  registerTextHandler(bot, commands);
  registerInteractiveHandler(bot);
  startAccountAssistant(bot).catch((error) => {
    logger.error("Account assistant start error:", error.message);
  });
  const commandStore = require("./commandSystem/store").getStore();
  const stopScheduler = require("./commandSystem/engine").startScheduler(
    commandStore,
    bot,
  );

  if (CONFIG.WEBHOOK_URL) {
    app.post(
      CONFIG.WEBHOOK_PATH,
      verifyWebhookSecret,
      express.json({ limit: "1mb" }),
      (req, res) => {
        bot.processUpdate(req.body);
        res.sendStatus(200);
      },
    );
  } else {
    bot.on("polling_error", (error) => {
      console.error("Telegram polling error:", error.message);
    });
  }

  require("./web").mountWeb(app, { store: commandStore });

  app.get("/health", (req, res) => {
    res.json({ ok: true });
  });

  const port = options.port ?? CONFIG.PORT;
  const host = options.host || CONFIG.HOST;
  const server = app.listen(port, host, () => {
    console.log(`Web server started on ${host}:${server.address().port}`);
  });
  let localServer;
  if (
    options.localWeb !== false &&
    options.port === undefined &&
    port !== 12723
  ) {
    const local = require("./serverLifecycle").listen(app, {
      port: 12723,
      host: "127.0.0.1",
    });
    localServer = local.server;
    local.ready
      .then((result) =>
        logger.info(
          result.reused ? "local_web_already_running" : "local_web_ready",
          { port: 12723 },
        ),
      )
      .catch((error) =>
        logger.error("local_web_failed", { code: error.code, port: 12723 }),
      );
  }
  if (!options.bot)
    require("./runtime").installShutdown({
      servers: [server, localServer],
      stopScheduler,
      bot,
      closeAccount: require("./services/accountAssistant").stopAccountAssistant,
    });
  server.on("error", (error) => {
    logger.error(
      `Web server failed on ${CONFIG.HOST}:${CONFIG.PORT}:`,
      error.message,
    );
  });

  return { app, bot, server, stopScheduler };
}

module.exports = {
  start,
};
