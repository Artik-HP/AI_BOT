const crypto = require("crypto");
const { safeHandler } = require("../utils/safe");
const { auth, captureMessage } = require("../services/auth");
const { admitCallback } = require("./guard");

// Inline buttons under the bot's own answers: the spark card and a reply with ideas. A button carries only a random
// token ("act:<token>", far below Telegram's 64 bytes); what it does, for whom, in which chat and under which message
// lives here, in process memory, for a day. After a restart every old button answers "Кнопка устарела". A person has
// one live keyboard of each kind per chat: a new one retires the previous one, because an old "Развей 2" would now
// mean a different list. The main menu, the lab and the account assistant keep their own callbacks.

const PREFIX = "act:";
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TOKENS = 5000;
const STALE = "Кнопка устарела";
const NOT_YOURS = "Эта кнопка для того, кто задал вопрос.";

function createActionRegistry({ now = Date.now, ttlMs = TTL_MS, maxTokens = MAX_TOKENS } = {}) {
  const tokens = new Map();
  const keyboards = new Map();

  function retire(key) {
    const previous = keyboards.get(key);

    if (previous) {
      for (const token of previous.tokens) {
        tokens.delete(token);
      }

      keyboards.delete(key);
    }

    return previous || null;
  }

  // Expired tokens go first; above the cap the oldest ones are dropped (a Map keeps insertion order).
  function prune() {
    const at = now();

    for (const [token, entry] of tokens) {
      if (entry.expires <= at) {
        tokens.delete(token);
      }
    }

    while (tokens.size > maxTokens) {
      tokens.delete(tokens.keys().next().value);
    }

    // A retired token must not leave its keyboard (and message id) in memory forever.
    for (const [key, keyboard] of keyboards) {
      keyboard.tokens = keyboard.tokens.filter((token) => tokens.has(token));
      if (!keyboard.tokens.length) keyboards.delete(key);
    }
  }

  // `rows` is [[{ text, data }]]. The keyboard is bound to the message by attach(message_id) once it is sent;
  // `previousMessageId` is the message whose keyboard just died, so that its buttons can be taken off. A keyboard is
  // tied to the session it was shown in; `anySession` (the daily spark, sent while the person is usually not logged
  // in) only needs a valid login at the press, and a logout still retires it.
  function create({ chatId, userId, kind, rows, anySession = false }) {
    prune();
    const key = `${chatId}:${userId}:${kind}`;
    const previous = retire(key);
    const keyboard = { tokens: [], messageId: null };
    const lease = anySession ? null : auth.capture(userId);
    const expires = now() + ttlMs;
    const markup = {
      inline_keyboard: rows.map((row) => row.map(({ text, data }) => {
        const token = crypto.randomBytes(12).toString("base64url");

        tokens.set(token, { chatId: String(chatId), userId: String(userId), lease, anySession, kind, data, messageId: null, expires });
        keyboard.tokens.push(token);
        return { text, callback_data: `${PREFIX}${token}` };
      }))
    };

    keyboards.set(key, keyboard);
    prune();

    return {
      markup,
      previousMessageId: previous?.messageId ?? null,
      attach(messageId) {
        keyboard.messageId = messageId;

        for (const token of keyboard.tokens) {
          const entry = tokens.get(token);

          if (entry) {
            entry.messageId = messageId;
          }
        }
      }
    };
  }

  function resolve(data) {
    if (typeof data !== "string" || !data.startsWith(PREFIX)) {
      return null;
    }

    prune();
    return tokens.get(data.slice(PREFIX.length)) || null;
  }

  // Idempotent: a logout or a block of this person retires every button shown to them.
  function revokeUser(userId) {
    for (const [token, entry] of tokens) {
      if (entry.userId === String(userId)) {
        tokens.delete(token);
      }
    }

    for (const key of keyboards.keys()) {
      if (key.split(":")[1] === String(userId)) {
        keyboards.delete(key);
      }
    }
  }

  return {
    create,
    resolve,
    revokeUser,
    get size() {
      return tokens.size;
    }
  };
}

// The registry of the running bot.
const actions = createActionRegistry();

// "1️⃣" is a digit, U+FE0F and U+20E3 (src/ideas/prompt.md asks the model to number ideas so). Models sometimes drop
// the U+FE0F, so both spellings count. Ready strings and includes(), never a character class.
const KEYCAP = String.fromCodePoint(0x20e3);
const EMOJI_STYLE = String.fromCodePoint(0xfe0f);

function ideaMarkers(text) {
  const source = String(text || "");

  return ["1", "2", "3"].filter((digit) => source.includes(`${digit}${EMOJI_STYLE}${KEYCAP}`) || source.includes(`${digit}${KEYCAP}`));
}

// The keyboard under a reply with at least two numbered ideas: each button sends the model what a person would type.
function ideaReplyRows(text, { bankEnabled = false } = {}) {
  const found = ideaMarkers(text);

  if (found.length < 2) {
    return null;
  }

  return [
    found.map((n) => ({ text: `Развей ${n}`, data: { text: `развей ${n}` } })),
    ...(bankEnabled ? [found.map((n) => ({ text: `💾 ${n}`, data: { text: `сохрани идею ${n} в банк` } }))] : []),
    [{ text: "🔁 Ещё", data: { text: "ещё" } }, { text: "📊 Оцени", data: { text: "оцени эти идеи" } }]
  ];
}

// A press becomes an ordinary incoming message for the AI pipeline: its chat and author, a fresh lease of the presser
// and a message id of its own, so that the "one answer per message" guard never swallows the answer to a second press.
function callbackMessage(query) {
  const msg = {
    message_id: `cb:${query.id}`,
    chat: query.message.chat,
    from: query.from,
    date: Math.floor(Date.now() / 1000)
  };

  captureMessage(msg);
  return msg;
}

// Takes a dead keyboard off its old message; a failure (message too old, already edited) changes nothing.
function clearKeyboard(bot, chatId, messageId) {
  if (messageId) {
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }).catch(() => {});
  }
}

// `handlers` maps a kind to (query, entry) => ({ refuse: "toast" } | { run: async () => {} }). The refusal check
// runs before the callback is answered; the work runs after, so the button stops spinning at once.
function registerActions(bot, handlers, registry = actions) {
  bot.on("callback_query", safeHandler("Action button", async (query) => {
    if (!query.data?.startsWith(PREFIX)) {
      return;
    }

    if (!await admitCallback(bot, query)) {
      return;
    }

    const toast = (text) => bot.answerCallbackQuery(query.id, { text }).catch(() => {});
    const entry = registry.resolve(query.data);

    if (!entry || entry.chatId !== String(query.message?.chat?.id) || entry.messageId !== query.message?.message_id || !handlers[entry.kind]) {
      await toast(STALE);
      return;
    }

    if (entry.userId !== String(query.from?.id)) {
      await toast(NOT_YOURS);
      return;
    }

    if (!entry.anySession && !auth.valid(entry.lease)) {
      await toast(STALE);
      return;
    }

    const outcome = handlers[entry.kind](query, entry) || {};

    if (outcome.refuse) {
      await toast(outcome.refuse);
      return;
    }

    await bot.answerCallbackQuery(query.id).catch(() => {});
    await outcome.run?.();
  }));
}

module.exports = {
  PREFIX,
  STALE,
  NOT_YOURS,
  actions,
  createActionRegistry,
  ideaMarkers,
  ideaReplyRows,
  callbackMessage,
  clearKeyboard,
  registerActions,
  lifecycleHooks: {
    revokeUser: (userId) => actions.revokeUser(userId)
  }
};
