const logger = require("../utils/logger");
const { safeHandler } = require("../utils/safe");
const { claimIncomingMessage } = require("../services/telegram");
const { admitMessage } = require("./guard");
const { answerWithAi } = require("./reply");

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
      else { lab.exit(msg); await commands.handleMenuButton(chatId, text, msg.from.id, msg); }
      return;
    }

    logger.message("in", { chatId, userId: msg.from?.id, username: msg.from?.username }, text);

    if (!isBotMessage && text && await commands.handleMenuButton(chatId, text, msg.from.id, msg)) {
      return;
    }

    await answerWithAi(bot, msg, aiText);
  }));
}

module.exports = {
  registerTextHandler
};
