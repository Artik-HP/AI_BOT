// Shared pieces of the integration tests that talk to the ideas character through the real bot process.
const fs = require("fs");
const { reply } = require("./fakeOpenRouter");

// The harness pins the companion character for the older suites; these tests run the real product default.
const IDEAS = { COMPANION_DEFAULT_PERSONA: undefined };

// An OpenRouter answer that asks for tool calls instead of giving text.
const toolCalls = (...calls) => ({
  status: 200,
  body: {
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: calls.map(([name, args], index) => ({
          id: `call_${index + 1}`, type: "function", function: { name, arguments: JSON.stringify(args) }
        }))
      }
    }]
  }
});

const lastMessage = (record) => record.body.messages.at(-1);
const toolResults = (record) => record.body.messages.filter((message) => message.role === "tool").map((message) => JSON.parse(message.content));
const userTurnOf = (or) => or.chatRequests().at(-1).body.messages.at(-1).content;
const readStore = (app) => JSON.parse(fs.readFileSync(`${app.memoryFile}.rpg.json`, "utf8"));

// The model calls the given functions once, then answers with `text` (an empty text is a valid answer too).
function callsThen(or, calls, text = "ok") {
  or.chat = (record) => (lastMessage(record).role === "tool" ? reply(text) : toolCalls(...calls));
}

// Sends one message and returns the `count` texts the bot answered with.
async function say(tg, chatId, text, { count = 1, ...extra } = {}) {
  const before = tg.texts().length;

  tg.message({ chatId, text, ...extra });
  await tg.waitFor(() => tg.texts().length >= before + count, 10000, `ответ на «${text}»`);
  await tg.quiet(150);
  return tg.texts().slice(before);
}

// The inline keyboard of a sent message, as rows of { text, callback_data }.
function inlineKeyboard(params) {
  const markup = typeof params?.reply_markup === "string" ? JSON.parse(params.reply_markup) : params?.reply_markup;

  return markup?.inline_keyboard || null;
}

module.exports = {
  IDEAS,
  toolCalls,
  lastMessage,
  toolResults,
  userTurnOf,
  readStore,
  callsThen,
  say,
  inlineKeyboard
};
