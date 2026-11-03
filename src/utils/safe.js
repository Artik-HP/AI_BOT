const logger = require("./logger");

// Event emitters ignore the promises returned by async listeners, so a rejection inside a handler
// becomes an unhandled rejection and kills the process. Every handler must go through this wrapper.
function safeHandler(label, handler) {
  return async function safeWrapped(...args) {
    try {
      return await handler.apply(this, args);
    } catch (error) {
      logger.error(`${label} failed:`, error);
      return undefined;
    }
  };
}

// Sends an informational message; a blocked bot or a network error must never escape.
async function trySendMessage(bot, chatId, text, options) {
  try {
    return await bot.sendMessage(chatId, text, options);
  } catch (error) {
    logger.warn(`Could not send message to ${chatId}:`, error);
    return null;
  }
}

module.exports = {
  safeHandler,
  trySendMessage
};
