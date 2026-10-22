const { processUserText } = require("../services/conversation");
const {
  claimIncomingMessage,
  claimIncomingBotMessage,
  getBotToBotReplyOptions,
  enqueueChatTask,
} = require("../services/telegram");

const AI_ERROR_MESSAGE =
  "AI сейчас не ответил. Проверь OPENROUTER_API_KEY, модель или доступ к серверу.";

function getAIText(text, isBotMessage) {
  if (!text || !isBotMessage || !text.startsWith("/")) {
    return text;
  }

  return text.match(/^\/bot_chat(?:@\w+)?\s+([\s\S]+)$/i)?.[1]?.trim();
}

function registerTextHandler(bot, commands) {
  bot.on("message", async (msg) => {
    console.log("Новое сообщение получено");

    const chatId = msg.chat.id;
    const text = msg.text?.trim();
    const isBotMessage = Boolean(msg.from?.is_bot);
    const aiText = getAIText(text, isBotMessage);

    if (!aiText || (!isBotMessage && aiText.startsWith("/"))) {
      return;
    }
    if (!(await require("../services/access").guardMessage(bot, msg))) return;
    if (!isBotMessage)
      require("../services/personalData").ensureHistory(
        require("../commandSystem/telegram").context(msg),
      );

    if (!claimIncomingMessage(msg)) {
      return;
    }

    if (isBotMessage && !claimIncomingBotMessage(msg)) {
      return;
    }

    await enqueueChatTask(chatId, async () => {
      try {
        if (isBotMessage && text.startsWith("/bot_chat")) {
          const { context } = require("../commandSystem/telegram");
          await require("../commandSystem/engine").execute(
            context(msg),
            "bot_chat",
            { args: aiText },
            `tg:${chatId}:${msg.message_id}`,
          );
          return;
        }
        if (
          !isBotMessage &&
          (await require("../commandSystem/telegram").handleCommandInput(
            bot,
            msg,
          ))
        )
          return;
        if (
          !isBotMessage &&
          text &&
          (await commands.handleMenuButton(chatId, text))
        )
          return;
        await processUserText(bot, chatId, aiText, msg.from, {
          memoryScope: isBotMessage
            ? String(chatId)
            : `t:${chatId}:${msg.from.id}`,
          interactive: !isBotMessage,
          replyOptions: isBotMessage ? getBotToBotReplyOptions(msg) : {},
        });
      } catch (error) {
        const status = error.response?.status;
        const details = require("../utils/errors").getErrorDetails(error);

        console.error("AI error:", status, details);
        await bot.sendMessage(chatId, AI_ERROR_MESSAGE).catch(() => {});
      }
    });
  });
}

module.exports = {
  registerTextHandler,
};
