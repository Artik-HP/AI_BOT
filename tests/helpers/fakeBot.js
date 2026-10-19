// In-memory stand-in for the control bot (node-telegram-bot-api) used by account-assistant tests.
function createFakeBot() {
  const textHandlers = [];
  const callbackHandlers = [];

  return {
    sent: [],
    edits: [],
    answers: [],
    onText(regexp, callback) {
      textHandlers.push([regexp, callback]);
    },
    on(event, callback) {
      if (event === "callback_query") {
        callbackHandlers.push(callback);
      }
    },
    async sendMessage(chatId, text, options) {
      this.sent.push({ chatId, text, options });
      return { message_id: this.sent.length, chat: { id: chatId } };
    },
    async editMessageText(text, options) {
      this.edits.push({ text, options });
      return true;
    },
    async answerCallbackQuery(id, options) {
      this.answers.push({ id, options });
      return true;
    },
    // Dispatches a chat message the way node-telegram-bot-api does: first matching regexp wins.
    async text(chatId, text, fromId = chatId) {
      for (const [regexp, callback] of textHandlers) {
        const match = regexp.exec(text);

        if (match) {
          await callback({ chat: { id: chatId }, from: { id: fromId }, text }, match);
          return true;
        }
      }

      return false;
    },
    async callback(chatId, data, fromId = chatId) {
      await Promise.all(callbackHandlers.map((callback) => callback({
        id: `q${Math.random()}`,
        data,
        from: { id: fromId },
        message: { chat: { id: chatId }, message_id: 1 }
      })));
    },
    lastText() {
      return this.sent.at(-1)?.text;
    }
  };
}

module.exports = {
  createFakeBot
};
