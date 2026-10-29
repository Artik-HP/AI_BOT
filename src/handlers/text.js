const logger = require("../utils/logger");
const { safeHandler, trySendMessage } = require("../utils/safe");
const { askAI } = require("../services/openrouter");
const {
  claimIncomingMessage,
  getBotToBotReplyOptions,
  enqueueChatTask,
  sendAIResponse
} = require("../services/telegram");
const { admitMessage, showTyping, messageAuthorized } = require("./guard");
const { withMessageAuth } = require("../services/auth");

const AI_ERROR_MESSAGE = "Не получилось получить ответ от ИИ. Попробуй ещё раз чуть позже.";

function getAIText(text, isBotMessage) {
  if (!text || !isBotMessage || !text.startsWith("/")) {
    return text;
  }

  return text.match(/^\/bot_chat(?:@\w+)?\s+([\s\S]+)$/i)?.[1]?.trim();
}

function registerTextHandler(bot, commands, lab = null) {
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

    if (!isBotMessage && lab && (text === commands.BUTTONS.lab || lab.hasSession(msg))) {
      if (text === commands.BUTTONS.lab) await lab.open(msg);
      else if (!Object.values(commands.BUTTONS).includes(text)) await lab.handleText(msg);
      else { lab.exit(msg); await commands.handleMenuButton(chatId, text); }
      return;
    }

    logger.message("in", { chatId, userId: msg.from?.id, username: msg.from?.username }, text);

    if (!isBotMessage && text && await commands.handleMenuButton(chatId, text)) {
      return;
    }

    await enqueueChatTask(chatId, () => withMessageAuth(msg, async () => {
      try {
        if (!messageAuthorized(msg)) return;
        await showTyping(bot, chatId);
        const aiReply = await askAI(chatId, aiText, msg.from);
        if (!messageAuthorized(msg)) return;
        await sendAIResponse(chatId, aiReply, {
          sourceMessageId: msg.message_id,
          ...(isBotMessage ? getBotToBotReplyOptions(msg) : {})
        });
      } catch (error) {
        if (!messageAuthorized(msg)) return;
        logger.error("AI error:", error);
        await trySendMessage(bot, chatId, AI_ERROR_MESSAGE);
      }
    }));
  }));
}

module.exports = {
  registerTextHandler
};
