const { evaluateAccess, shouldSendNotice, buildNoticeText } = require("../services/access");
const { claimIncomingBotMessage } = require("../services/telegram");
const { trySendMessage } = require("../utils/safe");
const { auth, passwordGate, captureMessage, messageAuthorized } = require("../services/auth");

// One admission check for every kind of incoming message (text, command, voice, photo).
// Other bots are limited by the bot-to-bot rules, people by the allow-list and the rate limit.
async function admitMessage(bot, msg) {
  if (!await passwordGate(bot, msg)) return false;
  captureMessage(msg);
  if (msg.from?.is_bot) {
    return claimIncomingBotMessage(msg);
  }

  const userId = msg.from?.id ?? msg.chat?.id;
  const decision = evaluateAccess(userId);

  if (decision.ok) {
    return true;
  }

  if (msg.chat?.id && shouldSendNotice(userId, decision.reason)) {
    await trySendMessage(bot, msg.chat.id, buildNoticeText(decision));
  }

  return false;
}

// Same check for button presses; the answer is shown as a small toast instead of a message.
async function admitCallback(bot, query) {
  if (!auth.authenticated(query.from?.id)) {
    await bot.answerCallbackQuery(query.id, { text: "🔐 Сначала войди через /start в личном диалоге.", show_alert: true }).catch(() => {});
    return false;
  }
  const decision = evaluateAccess(query.from?.id);

  if (decision.ok) {
    return true;
  }

  await bot.answerCallbackQuery(query.id, {
    text: buildNoticeText(decision),
    show_alert: false
  }).catch(() => {});

  return false;
}

// Typing indicator is cosmetic: failing to show it must not fail the reply.
function showTyping(bot, chatId) {
  return bot.sendChatAction(chatId, "typing").catch(() => {});
}

module.exports = {
  messageAuthorized,
  admitMessage,
  admitCallback,
  showTyping
};
