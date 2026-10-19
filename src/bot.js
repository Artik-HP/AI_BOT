const crypto = require("crypto");
const express = require("express");
const CONFIG = require("./config");
const logger = require("./utils/logger");

const SHUTDOWN_TIMEOUT_MS = 15000;
const CHAT_TASKS_GRACE_MS = 8000;
const SIGNAL_EXIT_CODES = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129
};

let processHandlersRegistered = false;

function digest(value) {
  return crypto.createHash("sha256").update(String(value ?? "")).digest();
}

// Constant-time comparison, so the token cannot be guessed byte by byte from response times.
function tokensMatch(supplied, expected) {
  return Boolean(expected) && crypto.timingSafeEqual(digest(supplied), digest(expected));
}

function readHealthToken(req) {
  const bearer = String(req.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  return req.get("x-health-token") || (bearer ? bearer[1] : "");
}

// Public routes reveal nothing about people or configuration. Details are opt-in (HEALTH_TOKEN).
function createWebApp({ getDetails }) {
  const app = express();

  app.disable("x-powered-by");

  app.get("/", (req, res) => {
    res.send("Bot is alive");
  });

  app.get("/health", (req, res) => {
    res.json({ ok: true, uptimeSec: Math.round(process.uptime()) });
  });

  app.get("/health/details", (req, res) => {
    if (!CONFIG.HEALTH_TOKEN) {
      res.status(404).json({ ok: false });
      return;
    }

    if (!tokensMatch(readHealthToken(req), CONFIG.HEALTH_TOKEN)) {
      res.status(401).json({ ok: false });
      return;
    }

    res.json(getDetails());
  });

  return app;
}

function registerProcessHandlers(shutdown) {
  if (processHandlersRegistered) {
    return;
  }

  processHandlersRegistered = true;

  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled rejection:", reason);
  });

  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception:", error);
    shutdown(1, "uncaught exception");
  });

  for (const [signal, exitCode] of Object.entries(SIGNAL_EXIT_CODES)) {
    process.once(signal, () => shutdown(exitCode, signal));
  }
}

function start() {
  logger.info("Бот запущен");

  CONFIG.validateConfig();

  const { createTelegramBot, getBotToBotStatus, waitForChatTasks } = require("./services/telegram");
  const commands = require("./commands");
  const { registerTextHandler } = require("./handlers/text");
  const { registerPhotoHandler } = require("./handlers/photo");
  const { registerVoiceHandler } = require("./handlers/voice");
  const { getSttModels } = require("./services/openrouter");
  const { flushMemory, getUserCount } = require("./services/memory");
  const {
    getAccountAssistantStatus,
    startAccountAssistant,
    stopAccountAssistant
  } = require("./services/accountAssistant");

  if (!CONFIG.BOT_ALLOWED_USER_IDS.length) {
    logger.warn("BOT_ALLOWED_USER_IDS не задан: бот отвечает всем, кто ему напишет (лимит запросов на пользователя действует).");
  }

  const bot = createTelegramBot();
  commands.initCommands(bot);
  registerVoiceHandler(bot);
  registerPhotoHandler(bot);
  registerTextHandler(bot, commands);
  startAccountAssistant(bot).catch((error) => {
    logger.error("Account assistant start error:", error);
  });

  bot.on("polling_error", (error) => {
    logger.error("Telegram polling error:", error);
  });

  const app = createWebApp({
    getDetails: () => {
      const botToBot = getBotToBotStatus();
      const accountAssistant = getAccountAssistantStatus();

      return {
        ok: true,
        uptimeSec: Math.round(process.uptime()),
        model: CONFIG.MODEL,
        visionModel: CONFIG.VISION_MODEL,
        sttModels: getSttModels(),
        audioFallbackModel: CONFIG.AUDIO_FALLBACK_MODEL,
        users: getUserCount(),
        botToBot: {
          enabled: botToBot.enabled,
          identityLoaded: botToBot.identityLoaded,
          chatConfigured: Boolean(botToBot.chatId),
          targetConfigured: Boolean(botToBot.targetBotUsername),
          allowBots: botToBot.allowBots.length
        },
        accountAssistant: {
          enabled: accountAssistant.enabled,
          started: accountAssistant.started,
          connected: accountAssistant.connected,
          mode: accountAssistant.mode,
          effectiveMode: accountAssistant.effectiveMode,
          privateOnly: accountAssistant.privateOnly,
          pendingDrafts: accountAssistant.pendingDrafts,
          allowListSize: accountAssistant.allowListSize,
          blockListSize: accountAssistant.blockListSize
        }
      };
    }
  });

  let shuttingDown = false;
  let server;

  async function shutdown(exitCode = 0, reason = "") {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info(`Остановка${reason ? ` (${reason})` : ""}...`);

    // Whatever happens below, the process must end.
    setTimeout(() => process.exit(exitCode || 1), SHUTDOWN_TIMEOUT_MS).unref();

    try {
      await bot.stopPolling({ cancel: true, reason: "shutdown" });
      await waitForChatTasks(CHAT_TASKS_GRACE_MS);
      await stopAccountAssistant();

      if (server?.listening) {
        server.closeIdleConnections?.();
        await new Promise((resolve) => server.close(resolve));
      }
    } catch (error) {
      logger.error("Shutdown error:", error);
    }

    flushMemory();
    process.exit(exitCode);
  }

  server = app.listen(CONFIG.PORT, (error) => {
    if (error) {
      logger.error(`Web server could not start on port ${CONFIG.PORT}:`, error);
      shutdown(1, "web server failed");
      return;
    }

    logger.info(`Web server started on port ${server.address().port}`);
  });

  registerProcessHandlers(shutdown);

  return { app, bot, server, shutdown };
}

module.exports = {
  start,
  createWebApp,
  tokensMatch
};
