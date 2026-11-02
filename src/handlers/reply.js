const logger = require("../utils/logger");
const { trySendMessage } = require("../utils/safe");
const { respond } = require("../companion/engine");
const { getBotToBotReplyOptions, enqueueChatTask, sendAIResponse } = require("../services/telegram");
const { withMessageAuth } = require("../services/auth");
const { getPersona } = require("../services/memory");
const { BANK_ENABLED } = require("../ideas/commands");
const { actions, clearKeyboard, ideaReplyRows } = require("./actions");
const { showTyping, messageAuthorized } = require("./guard");

const AI_ERROR_MESSAGE = "Не получилось получить ответ от ИИ. Попробуй ещё раз чуть позже.";

// Buttons under a reply with ideas ("Развей 2", "💾 2", "🔁 Ещё", "📊 Оцени"): only for people, only in the ideas
// character, only when the reply numbers at least two ideas with 1️⃣ 2️⃣ 3️⃣. A press is answered as if the person had
// typed the words, through the same pipeline, so the model keeps deciding what "развей 2" means.
function ideasKeyboard(msg, reply) {
  if (msg.from?.is_bot || getPersona(msg.chat.id) !== "ideas") {
    return null;
  }

  const rows = ideaReplyRows(reply, { bankEnabled: BANK_ENABLED });

  return rows ? actions.create({ chatId: msg.chat.id, userId: msg.from?.id ?? msg.chat.id, kind: "ideas", rows }) : null;
}

// The one step shared by text, voice and the idea commands and buttons: ask the AI and deliver its answer. It runs
// inside a chat task (enqueueChatTask + withMessageAuth), refreshes the typing indicator on every tool round, and
// sends nothing if the person logged out while the model was thinking. Whatever is added to delivery is added here,
// so it works for every kind of message at once.
async function replyWithAi(bot, msg, aiText) {
  const chatId = msg.chat.id;
  const isBotMessage = Boolean(msg.from?.is_bot);

  try {
    if (!messageAuthorized(msg)) return;
    await showTyping(bot, chatId);
    const aiReply = await respond(chatId, aiText, msg.from, {
      type: msg.chat.type,
      // Tool rounds can outlast Telegram's typing indicator (about five seconds), so it is refreshed each round.
      onRound: () => showTyping(bot, chatId)
    });
    if (!messageAuthorized(msg)) return;
    const keyboard = ideasKeyboard(msg, aiReply);
    const sent = await sendAIResponse(chatId, aiReply, {
      sourceMessageId: msg.message_id,
      ...(isBotMessage ? getBotToBotReplyOptions(msg) : {}),
      ...(keyboard ? { replyMarkup: keyboard.markup } : {})
    });

    if (keyboard && sent) {
      keyboard.attach(sent.message_id);
      clearKeyboard(bot, chatId, keyboard.previousMessageId);
    }
  } catch (error) {
    if (!messageAuthorized(msg)) return;
    logger.error("AI error:", error);
    await trySendMessage(bot, chatId, AI_ERROR_MESSAGE);
  }
}

// Answers one incoming message with the AI. Replies are queued per chat (one after another inside a chat, different
// chats in parallel). `aiText` may be a function read when the task starts: a task queued right behind another one
// can then use what that one produced (the spark card), and an empty result means there is nothing to ask.
function answerWithAi(bot, msg, aiText) {
  return enqueueChatTask(msg.chat.id, () => withMessageAuth(msg, async () => {
    const text = typeof aiText === "function" ? aiText() : aiText;

    if (text) {
      await replyWithAi(bot, msg, text);
    }
  }));
}

module.exports = {
  AI_ERROR_MESSAGE,
  answerWithAi,
  replyWithAi
};
