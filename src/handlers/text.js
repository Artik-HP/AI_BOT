const logger = require("../utils/logger");
const { safeHandler, trySendMessage } = require("../utils/safe");
const { askAI } = require("../services/openrouter");
const {
  claimIncomingMessage,
  getBotToBotReplyOptions,
  enqueueChatTask,
  sendAIResponse
} = require("../services/telegram");
const { admitMessage, showTyping } = require("./guard");

const AI_ERROR_MESSAGE = "Не получилось получить ответ от ИИ. Попробуй ещё раз чуть позже.";

function getAIText(text, isBotMessage) {
  if (!text || !isBotMessage || !text.startsWith("/")) {
    return text;
  }

  return text.match(/^\/bot_chat(?:@\w+)?\s+([\s\S]+)$/i)?.[1]?.trim();
}

function registerTextHandler(bot, commands) {
  bot.on("message", safeHandler("Text message handler", async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text?.trim();
    const isBotMessage = Boolean(msg.from?.is_bot);
    const aiText = getAIText(text, isBotMessage);

    if (!aiText || (!isBotMessage && aiText.startsWith("/"))) {
      return;
    }

    if (!claimIncomingMessage(msg)) {
      return;
    }

    if (!await admitMessage(bot, msg)) {
      return;
    }

    logger.message("in", { chatId, userId: msg.from?.id, username: msg.from?.username }, text);

    if (!isBotMessage && text && await commands.handleMenuButton(chatId, text)) {
      return;
    }

    await enqueueChatTask(chatId, async () => {
      try {
        await showTyping(bot, chatId);
        const aiReply = await askAI(chatId, aiText, msg.from);
        await sendAIResponse(chatId, aiReply, {
          sourceMessageId: msg.message_id,
          ...(isBotMessage ? getBotToBotReplyOptions(msg) : {})
        });
      } catch (error) {
        logger.error("AI error:", error);
        await trySendMessage(bot, chatId, AI_ERROR_MESSAGE);
      }
    });
  }));
}

module.exports = {
  registerTextHandler
};
