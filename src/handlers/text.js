const { askAI } = require("../services/openrouter");
const {
  claimIncomingMessage,
  claimIncomingBotMessage,
  enqueueChatTask,
  sendAIResponse
} = require("../services/telegram");

const AI_ERROR_MESSAGE = "AI сейчас не ответил. Проверь OPENROUTER_API_KEY, модель или доступ к серверу.";

function getAIText(text, isBotMessage) {
  if (!text || !isBotMessage || !text.startsWith("/")) {
    return text;
  }

  return text.match(/^\/bot_chat(?:@\w+)?\s+([\s\S]+)$/i)?.[1]?.trim();
}

function registerTextHandler(bot, commands) {
  bot.on("message", async (msg) => {
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

    if (isBotMessage && !claimIncomingBotMessage(msg)) {
      return;
    }

    if (!isBotMessage && text && await commands.handleMenuButton(chatId, text)) {
      return;
    }

    await enqueueChatTask(chatId, async () => {
      try {
        await bot.sendChatAction(chatId, "typing");
        const aiReply = await askAI(chatId, aiText, msg.from);
        await sendAIResponse(chatId, aiReply, isBotMessage ? { voiceEnabled: false } : {});
      } catch (error) {
        const status = error.response?.status;
        const details = error.response?.data || error.message;

        console.error("AI error:", status, details);
        await bot.sendMessage(chatId, AI_ERROR_MESSAGE);
      }
    });
  });
}

module.exports = {
  registerTextHandler
};
