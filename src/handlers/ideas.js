const logger = require("../utils/logger");
const { cutSafely, splitMessage } = require("../utils/text");
const { trySendMessage } = require("../utils/safe");
const { systemRng } = require("../companion/rules");
const { getStore } = require("../companion/store");
const { TECHNIQUES } = require("../ideas/catalog");
const bank = require("../ideas/bank");
const { BANK_ENABLED, IDEA_BUTTONS, IDEA_COMMANDS } = require("../ideas/commands");
const { sparkHistory } = require("../ideas/recent");
const { formatSpark, formatTechnique } = require("../ideas/spark");
const { getPersona } = require("../services/memory");
const { claimIncomingMessage } = require("../services/telegram");
const { answerWithAi } = require("./reply");

// Commands and keyboard buttons of the idea generator (their list is in src/ideas/commands.js). Most of them are a
// request to the model written by the bot (answerWithAi); /ideas and /techniques are answered by code alone, so
// they are instant and cost nothing.

const SHOWN_IDEAS = 10;
const PITCH_PREVIEW_CHARS = 140;

const BRAINSTORM_HINT = [
  "🧠 Мозговой штурм: напиши тему одним сообщением, и я возьму два приёма и выдам по несколько идей на каждый.",
  "Например: /brainstorm как собрать соседей во дворе.",
  "Нет темы? Жми «🎲 Искра»."
].join("\n");

const EMPTY_BANK = "В банке пока пусто. Придумаем что-нибудь: /idea или «🎲 Искра», а понравившееся попроси сохранить.";

const BANK_FOOTER = [
  "🆕 новая · 🔍 в работе · ✅ готово · 💤 отложена",
  "Найти: /ideas слово. Удалить: /ideas del код. Сменить статус или текст — попроси меня в разговоре."
].join("\n");

function kindForButton(text) {
  return Object.entries(IDEA_BUTTONS).find(([, label]) => label === text)?.[0] || null;
}

function argumentOf(text) {
  return String(text || "").replace(/^\/\w+(?:@\w+)?/, "").trim();
}

function renderTechniques() {
  return [
    "🛠 Приёмы, которыми я придумываю идеи:",
    "",
    ...TECHNIQUES.map((technique, index) => `${index + 1}. ${technique.name} — ${technique.how}`),
    "",
    "Назови приём в сообщении («примени аналогию») или просто назови тему: приём я подберу сам. А «🎲 Искра» выберет случайный."
  ].join("\n");
}

// Shown under the card only where the model can really change part of a spark: the ideas character with its functions.
const REROLL_HINT = "Не зацепило? Скажи «поменяй поворот» или «добавь, для кого», и я перекину только это. Или жми «🎲 Искра» ещё раз.";

function renderSparkCard(spark, technique, { rerollHint = false } = {}) {
  return ["🎲 Искра", formatSpark(spark), "", formatTechnique(technique), ...(rerollHint ? ["", REROLL_HINT] : [])].join("\n");
}

function canReroll(chatId) {
  return BANK_ENABLED && getPersona(chatId) === "ideas";
}

// The request the model receives after the card was shown: it must not retell the card.
function sparkRequest(topic, spark, technique) {
  return [
    "🎲 Искра для идеи.",
    topic ? `Тема: ${topic}` : null,
    formatSpark(spark),
    formatTechnique(technique),
    "Придумай три идеи, которые учитывают всё выпавшее. Выпавшее уже показано человеку: не пересказывай его, сразу переходи к идеям."
  ].filter(Boolean).join("\n");
}

function renderIdeas({ total, matched, ideas }, query = "") {
  if (!total) {
    return EMPTY_BANK;
  }

  if (!ideas.length) {
    return `По запросу «${query}» ничего не нашлось. Всего идей: ${total}. Показать все: /ideas`;
  }

  const items = ideas.map((idea) => [
    `${bank.STATUS_ICONS[idea.status]} ${idea.id} · ${idea.title}`,
    idea.pitch.length > PITCH_PREVIEW_CHARS ? `${cutSafely(idea.pitch, PITCH_PREVIEW_CHARS)}…` : idea.pitch,
    idea.next_step ? `Шаг: ${idea.next_step}` : null,
    idea.tags.length ? idea.tags.map((tag) => `#${tag}`).join(" ") : null
  ].filter(Boolean).join("\n"));

  return [
    query ? `📚 Нашлось ${matched} из ${total}:` : `📚 Твои идеи (${total}):`,
    "",
    items.join("\n\n"),
    matched > ideas.length ? `\nПоказаны ${ideas.length} из ${matched}. Сузить: /ideas слово.` : null,
    "",
    BANK_FOOTER
  ].filter((line) => line !== null).join("\n");
}

// `history` is shared with the model's idea_spark, so a spark shown on the card can later be changed in the talk.
function createIdeaCommands({ bot, keyboard, rng = systemRng, store = getStore, history = sparkHistory }) {
  // Long texts are cut into Telegram-sized messages; the keyboard rides on the last one.
  async function send(chatId, text) {
    const parts = splitMessage(text);

    for (const [index, part] of parts.entries()) {
      await trySendMessage(bot, chatId, part, index === parts.length - 1 ? keyboard : undefined);
    }
  }

  async function spark(msg, topic) {
    let drawn = null;

    try {
      drawn = history.draw(msg.chat.id, rng);
    } catch (error) {
      logger.error("Spark failed:", error);
    }

    if (!drawn?.ok) {
      await send(msg.chat.id, "Искра не загорелась. Попробуй ещё раз или просто назови тему.");
      return;
    }

    const [first] = drawn.sparks;

    await send(msg.chat.id, renderSparkCard(first, drawn.technique, { rerollHint: canReroll(msg.chat.id) }));
    await answerWithAi(bot, msg, sparkRequest(topic, first, drawn.technique));
  }

  async function showIdeas(msg, argument) {
    const chatId = msg.chat.id;
    const userId = msg.from?.id ?? chatId;
    const [word = "", ...rest] = argument.split(/\s+/);
    const tail = rest.join(" ").trim().toLowerCase();

    try {
      if (["del", "delete", "удалить"].includes(word.toLowerCase())) {
        const code = bank.normalizeId(tail);

        if (!code) {
          await send(chatId, "Укажи код идеи из списка, например: /ideas del a1b2c3d4");
        } else {
          await send(chatId, bank.removeFor(store(), chatId, userId, code) ? "Идея удалена." : "Идеи с таким кодом нет.");
        }
      } else if (["clear", "очистить"].includes(word.toLowerCase())) {
        const { total } = bank.listFor(store(), chatId, userId, { limit: 1 });

        if (!total) {
          await send(chatId, EMPTY_BANK);
        } else if (!["yes", "да"].includes(tail)) {
          await send(chatId, `Это удалит все идеи (${total}) без возврата. Подтверди: /ideas clear да`);
        } else {
          await send(chatId, `Удалено идей: ${bank.clearFor(store(), chatId, userId)}.`);
        }
      } else {
        await send(chatId, renderIdeas(bank.listFor(store(), chatId, userId, { query: argument, limit: SHOWN_IDEAS }), argument));
      }
    } catch (error) {
      logger.error("Idea bank command error:", error);
      await send(chatId, "Банк идей сейчас недоступен. Попробуй позже.");
    }
  }

  async function run(kind, msg, argument) {
    switch (kind) {
      case "idea":
        return argument ? answerWithAi(bot, msg, `Придумай идеи по теме: ${argument}`) : spark(msg, "");
      case "spark":
        return spark(msg, argument);
      case "brainstorm":
        return argument ? answerWithAi(bot, msg, `Устрой мозговой штурм по теме: ${argument}`) : send(msg.chat.id, BRAINSTORM_HINT);
      case "techniques":
        return send(msg.chat.id, renderTechniques());
      case "ideas":
        return showIdeas(msg, argument);
      default:
        return undefined;
    }
  }

  return {
    // A typed command is not seen by the text handler, so the duplicate-delivery check happens here.
    async command(kind, msg) {
      if (claimIncomingMessage(msg)) {
        await run(kind, msg, argumentOf(msg.text));
      }
    },
    // A keyboard button arrives as ordinary text: the text handler has already claimed and admitted it.
    async button(kind, msg) {
      await run(kind, msg, "");
    }
  };
}

module.exports = {
  BANK_ENABLED,
  IDEA_BUTTONS,
  IDEA_COMMANDS,
  BRAINSTORM_HINT,
  EMPTY_BANK,
  REROLL_HINT,
  kindForButton,
  argumentOf,
  renderTechniques,
  renderSparkCard,
  renderIdeas,
  createIdeaCommands
};
