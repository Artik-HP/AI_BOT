const logger = require("./utils/logger");
let installed = false;
function installShutdown({
  servers = [],
  stopScheduler = () => {},
  bot,
  closeAccount = async () => {},
} = {}) {
  if (installed) return;
  installed = true;
  let stopping = false;
  async function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    stopScheduler();
    const force = setTimeout(() => process.exit(code), 10000);
    force.unref();
    try {
      await bot?.stopPolling?.().catch(() => {});
      await closeAccount();
      await Promise.all(
        servers
          .filter(Boolean)
          .map(
            (server) => new Promise((resolve) => server.close(() => resolve())),
          ),
      );
      require("./services/memory").saveMemory();
    } catch (error) {
      logger.error("shutdown_failure", { code: error.code || error.name });
    }
    clearTimeout(force);
    process.exit(code);
  }
  process.once("SIGINT", () => stop(0));
  process.once("SIGTERM", () => stop(0));
  process.on("unhandledRejection", (error) => {
    logger.error("unhandled_rejection", {
      code: error?.code || error?.name || "Error",
    });
    stop(1);
  });
  process.on("uncaughtException", (error) => {
    logger.error("uncaught_exception", {
      code: error?.code || error?.name || "Error",
    });
    stop(1);
  });
}
module.exports = { installShutdown };
