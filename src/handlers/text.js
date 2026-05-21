const { askAI } = require("../services/openrouter");
const {
  claimIncomingMessage,
  enqueueChatTask,
  sendAIResponse
} = require("../services/telegram");

const AI_ERROR_MESSAGE = "AI сейчас не ответил. Проверь OPENROUTER_API_KEY, модель или доступ к серверу.";

function registerTextHandler(bot, commands) {
  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text?.trim();

    if (text && await commands.handleMenuButton(chatId, text)) {
      return;
    }

    if (!text || text.startsWith("/")) {
      return;
    }

    if (!claimIncomingMessage(msg)) {
      return;
    }

    await enqueueChatTask(chatId, async () => {
      try {
        await bot.sendChatAction(chatId, "typing");
        const aiReply = await askAI(chatId, text, msg.from);
        await sendAIResponse(chatId, aiReply);
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
