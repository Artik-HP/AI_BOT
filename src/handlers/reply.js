const logger = require("../utils/logger");
const { trySendMessage } = require("../utils/safe");
const { respond } = require("../companion/engine");
const { getBotToBotReplyOptions, enqueueChatTask, sendAIResponse } = require("../services/telegram");
const { withMessageAuth } = require("../services/auth");
const { showTyping, messageAuthorized } = require("./guard");

const AI_ERROR_MESSAGE = "Не получилось получить ответ от ИИ. Попробуй ещё раз чуть позже.";

// Answers one incoming message with the AI. Replies are queued per chat (one after another inside a chat, different
// chats in parallel), the typing indicator is refreshed on every tool round, and nothing is sent if the person
// logged out while the model was thinking. Shared by the text handler and by the idea commands and buttons, which
// turn a command into a request to the model.
function answerWithAi(bot, msg, aiText) {
  const chatId = msg.chat.id;
  const isBotMessage = Boolean(msg.from?.is_bot);

  return enqueueChatTask(chatId, () => withMessageAuth(msg, async () => {
    try {
      if (!messageAuthorized(msg)) return;
      await showTyping(bot, chatId);
      const aiReply = await respond(chatId, aiText, msg.from, {
        type: msg.chat.type,
        // Tool rounds can outlast Telegram's typing indicator (about five seconds), so it is refreshed each round.
        onRound: () => showTyping(bot, chatId)
      });
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
}

module.exports = {
  AI_ERROR_MESSAGE,
  answerWithAi
};
