const CONFIG = require("../config");
const logger = require("../utils/logger");
const { cutSafely, splitMessage } = require("../utils/text");
const { trySendMessage } = require("../utils/safe");
const { redact } = require("../utils/redact");
const { formatTime, localParts } = require("../utils/time");
const { toolsBlocked } = require("../companion/engine");
const { ideaReminders } = require("../companion/reminders");
const { systemRng } = require("../companion/rules");
const { getStore } = require("../companion/store");
const { TECHNIQUES } = require("../ideas/catalog");
const bank = require("../ideas/bank");
const { BANK_ENABLED, IDEA_BUTTONS, IDEA_COMMANDS } = require("../ideas/commands");
const { sparkHistory } = require("../ideas/recent");
const { INGREDIENTS, formatSpark, formatTechnique, labelOf, techniqueById } = require("../ideas/spark");
const { SPARK_CODE_PATTERN, decodeSpark } = require("../ideas/code");
const { actions, callbackMessage, clearKeyboard } = require("./actions");
const { withMessageAuth } = require("../services/auth");
const { getPersona } = require("../services/memory");
const { claimIncomingMessage, enqueueChatTask } = require("../services/telegram");
const { messageAuthorized } = require("./guard");
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
  "Найти: /ideas слово. Только одного статуса: /ideas в работе. Удалить: /ideas del код. Сменить статус или текст — попроси меня в разговоре.",
  ...(CONFIG.AI_LAB_ENABLED ? ["В лабораторию: /lab код — три варианта программы из идеи."] : [])
].join("\n");

// Statuses as people read and type them (/status, /ideas). Each name also parses back as a filter.
const STATUS_NAMES = { new: "новые", exploring: "в работе", done: "готово", parked: "отложены" };
const STATUS_WORDS = [
  ["в работе", "exploring"], ["новые", "new"], ["готово", "done"], ["готовые", "done"], ["отложены", "parked"], ["отложенные", "parked"],
  ...bank.IDEA_STATUSES.map((status) => [status, status])
];

// "/ideas [статус] [слова] [страница]": a leading status word filters, a trailing number is the page (so "/ideas 2"
// and "/ideas 2026" are pages, not searches), the words between are a search as before.
function parseIdeasArgument(argument) {
  let rest = String(argument || "").trim();
  const lower = rest.toLowerCase();
  const filter = STATUS_WORDS.find(([word]) => lower === word || lower.startsWith(`${word} `));

  if (filter) {
    rest = rest.slice(filter[0].length).trim();
  }

  const words = rest.split(/\s+/).filter(Boolean);
  const page = words.length && /^\d{1,6}$/.test(words.at(-1)) ? Math.max(1, Number(words.pop())) : 1;

  return { status: filter ? filter[1] : null, query: words.join(" "), page };
}

// The command that shows this list again on another page: what "Дальше" and "Первая" print.
function ideasCommand({ status, query }, page = 1) {
  return ["/ideas", status ? STATUS_NAMES[status] : null, query || null, page > 1 ? page : null].filter(Boolean).join(" ");
}

// "Банк идей: 5 (новые 2, в работе 1, готово 2)": statuses without ideas are left out.
function bankStatusLine({ total, counts }) {
  if (!total) {
    return "Банк идей: 0";
  }

  const parts = bank.IDEA_STATUSES.filter((status) => counts[status]).map((status) => `${STATUS_NAMES[status]} ${counts[status]}`);

  return `Банк идей: ${total} (${parts.join(", ")})`;
}

// Registered in src/bot.js (src/lifecycle.js) when the bank is on. /reset does not touch ideas: they are made by the person.
const lifecycleHooks = {
  statusLines: ({ chatId, userId }) => bankStatusLine(bank.countsFor(getStore(), chatId, userId)),
  exportData: ({ userId }) => bank.exportFor(getStore(), userId)
};

const STATUS_LABELS = { new: "новая", exploring: "в работе", done: "готово", parked: "отложена" };

// "/ideas export": the bank of this chat as a Markdown file, newest first.
function renderIdeasMarkdown(ideas, date) {
  return [`# Банк идей`, "", `Выгружено: ${date}. Идей: ${ideas.length}.`, ...ideas.flatMap((idea) => [
    "",
    `## ${idea.title}`,
    "",
    `- Статус: ${STATUS_LABELS[idea.status] || idea.status}`,
    `- Код: ${idea.id}`,
    `- Сохранена: ${idea.saved}`,
    "",
    idea.pitch,
    ...(idea.next_step ? ["", `Шаг: ${idea.next_step}`] : []),
    ...(idea.tags.length ? ["", `Теги: ${idea.tags.map((tag) => `#${tag}`).join(" ")}`] : [])
  ]), ""].join("\n");
}

// Today's date for file names: by BOT_TIMEZONE when it is set, otherwise UTC.
function dateStamp(now = Date.now()) {
  return CONFIG.BOT_TIMEZONE ? localParts(now, CONFIG.BOT_TIMEZONE).date : new Date(now).toISOString().slice(0, 10);
}

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
const SPARK_FAILED = "Искра не загорелась. Попробуй ещё раз или просто назови тему.";

function renderSparkCard(spark, technique, { rerollHint = false } = {}) {
  return ["🎲 Искра", formatSpark(spark), "", formatTechnique(technique), ...(rerollHint ? ["", REROLL_HINT] : [])].join("\n");
}

// Buttons under the card: "🔁" redraws one ingredient (not the area: it is the anchor), "➕ Для кого" adds the audience,
// "🌿 Проще" and "🎯 Конкретнее" draw a spark of two or four ingredients. The code redraws, not the model, so they work
// with any character. Each button remembers the card's spark and topic.
function sparkRows(spark, topic) {
  const card = { spark, topic };
  const swaps = INGREDIENTS.filter((name) => name !== "domain" && Object.hasOwn(spark, name))
    .map((name) => ({ text: `🔁 ${labelOf(name)}`, data: { ...card, reroll: name } }));

  if (!Object.hasOwn(spark, "audience")) {
    swaps.push({ text: `➕ ${labelOf("audience")}`, data: { ...card, reroll: "audience" } });
  }

  const rows = [];

  for (let index = 0; index < swaps.length; index += 2) {
    rows.push(swaps.slice(index, index + 2));
  }

  rows.push([{ text: "🌿 Проще", data: { ...card, shape: "minimal" } }, { text: "🎯 Конкретнее", data: { ...card, shape: "maximal" } }]);
  return rows;
}

function sameSpark(a, b) {
  return Boolean(a && b) && INGREDIENTS.every((name) => a[name] === b[name]);
}

// Also false while the provider refuses functions for this model (engine.js blocks them for ten minutes): the model
// could not reroll then, and the hint would promise what cannot happen.
function canReroll(chatId) {
  return BANK_ENABLED && getPersona(chatId) === "ideas" && !toolsBlocked(CONFIG.MODEL);
}

// The first word of /spark may ask for a shape, as the buttons of the website do; everything else is the topic. Only
// these exact words count ("конкретный план" stays a topic), and /idea has no such words: any word there is a topic.
const SHAPE_WORDS = { проще: "minimal", свободнее: "minimal", конкретнее: "maximal" };

// An argument that is exactly a spark code (src/ideas/code.js: a digit and seven more characters) is that spark.
function parseSparkArgument(argument) {
  const text = String(argument || "").trim();

  if (SPARK_CODE_PATTERN.test(text)) {
    return { code: text, shape: undefined, topic: "" };
  }

  const [first = "", ...rest] = text.split(/\s+/);
  const shape = SHAPE_WORDS[first.toLowerCase()];

  return shape ? { shape, topic: rest.join(" ") } : { shape: undefined, topic: text };
}

// "/start spark_<код>" (the website's "Развить в Telegram") → the code, or null for a /start without it.
function startSparkCode(text) {
  return String(text || "").match(/^\/start(?:@\w+)?\s+spark_(\S+)\s*$/)?.[1] || null;
}

const SPARK_CODE_REFUSALS = {
  spark_code_outdated: "Этот код искры от прежней версии бота: такой искры больше нет. Брось новую: /spark.",
  spark_code_invalid: "Код искры не подошёл: проверь, что он скопирован целиком. Новая искра: /spark."
};

// The daily spark (/daily): a card without AI; the ideas come only when the person presses the button.
function renderDailyCard(spark, technique) {
  return ["☀️ Искра дня", formatSpark(spark), "", formatTechnique(technique), "", "Идеи к ней — по кнопке. Выключить: /daily off."].join("\n");
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

// `result` is a page of bank.listIdeas(); `bankTotal` counts the whole bank, so that a status without ideas can be told
// from an empty bank. `reminders` maps an idea code to the time of its nearest reminder.
function renderIdeas(result, { query = "", status = null, page = 1, bankTotal = result.total, reminders = {} } = {}) {
  const { total, matched, ideas } = result;
  const name = status ? STATUS_NAMES[status] : "";

  if (!bankTotal) {
    return EMPTY_BANK;
  }

  if (!total) {
    return `Идей со статусом «${name}» нет. Всего идей: ${bankTotal}. Показать все: /ideas`;
  }

  if (!matched) {
    return `По запросу «${query}»${name ? ` (${name})` : ""} ничего не нашлось. Всего идей: ${total}. Показать все: /ideas`;
  }

  const pages = Math.ceil(matched / SHOWN_IDEAS);

  if (!ideas.length) {
    return `На странице ${page} ничего нет: всего страниц ${pages}. Первая: ${ideasCommand({ status, query })}`;
  }

  const pageNote = page > 1 ? ` · страница ${page} из ${pages}` : "";
  const header = query
    ? `📚 Нашлось ${matched} из ${total}${name ? ` (${name})` : ""}${pageNote}:`
    : `📚 Твои идеи${name ? ` — ${name}` : ""} (${total})${pageNote}:`;
  const from = (page - 1) * SHOWN_IDEAS + 1;
  const items = ideas.map((idea) => [
    `${bank.STATUS_ICONS[idea.status]} ${idea.id} · ${idea.title}`,
    idea.pitch.length > PITCH_PREVIEW_CHARS ? `${cutSafely(idea.pitch, PITCH_PREVIEW_CHARS)}…` : idea.pitch,
    idea.next_step ? `Шаг: ${idea.next_step}` : null,
    reminders[idea.id] ? `⏰ ${formatTime(reminders[idea.id], CONFIG.BOT_TIMEZONE)}` : null,
    idea.tags.length ? idea.tags.map((tag) => `#${tag}`).join(" ") : null
  ].filter(Boolean).join("\n"));

  return [
    header,
    "",
    items.join("\n\n"),
    result.has_more ? `\nПоказаны ${from}–${from + ideas.length - 1} из ${matched}. Дальше: ${ideasCommand({ status, query }, page + 1)}` : null,
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

  // The card and the request to the model are two tasks of the chat queue, queued back to back in one go: nothing
  // else of this chat can run between them, so a second spark cannot overtake the ideas for the first one, and the
  // spark drawn last is the one the person read last. With an idle queue the card still comes at once. A broken
  // generator leaves the request empty, and the model is not asked at all.
  // `expectLast` (a button press) is checked again inside the task: if another spark became the last one meanwhile,
  // nothing is drawn and the model is not asked. `fixed` (a spark code) is shown as it is and recorded in the chat's
  // history as its last spark, like a drawn one.
  function spark(msg, topic, { expectLast, fixed, ...options } = {}) {
    const chatId = msg.chat.id;
    let request = null;

    const card = enqueueChatTask(chatId, () => withMessageAuth(msg, async () => {
      if (!messageAuthorized(msg)) return;
      if (expectLast && !sameSpark(history.recent(chatId).last, expectLast)) return;

      let drawn = null;

      try {
        if (fixed) {
          history.record(chatId, [fixed.spark], fixed.technique);
          drawn = { ok: true, sparks: [fixed.spark], technique: fixed.technique };
        } else {
          drawn = history.draw(chatId, rng, options);
        }
      } catch (error) {
        logger.error("Spark failed:", error);
      }

      if (!drawn?.ok) {
        await send(chatId, SPARK_FAILED);
        return;
      }

      const [first] = drawn.sparks;
      const keyboard = actions.create({ chatId, userId: msg.from?.id ?? chatId, kind: "spark", rows: sparkRows(first, topic) });
      const sent = await trySendMessage(bot, chatId, renderSparkCard(first, drawn.technique, { rerollHint: canReroll(chatId) }), { reply_markup: keyboard.markup });

      if (sent) {
        keyboard.attach(sent.message_id);
        clearKeyboard(bot, chatId, keyboard.previousMessageId);
      }

      request = sparkRequest(topic, first, drawn.technique);
    }));
    const ideas = answerWithAi(bot, msg, () => request);

    return Promise.all([card, ideas]);
  }

  // A wrong or outdated code gets a hint; a random spark is never drawn in its place.
  async function sparkFromCode(msg, code) {
    const decoded = decodeSpark(code);

    if (!decoded.ok) {
      await send(msg.chat.id, SPARK_CODE_REFUSALS[decoded.error] || SPARK_CODE_REFUSALS.spark_code_invalid);
      return undefined;
    }

    return spark(msg, "", { fixed: decoded });
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
          const removed = bank.removeIdeaFor(store(), chatId, userId, code);
          const cancelled = removed.reminders_cancelled ? ` Отменено напоминаний о ней: ${removed.reminders_cancelled}.` : "";

          await send(chatId, removed.ok ? `Идея удалена.${cancelled}` : "Идеи с таким кодом нет.");
        }
      } else if (["export", "экспорт"].includes(word.toLowerCase()) && !tail) {
        const { ideas } = bank.listFor(store(), chatId, userId, { limit: bank.IDEA_LIMITS.perScope });

        if (!ideas.length) {
          await send(chatId, EMPTY_BANK);
        } else {
          const date = dateStamp();

          await bot.sendDocument(chatId, Buffer.from(redact(renderIdeasMarkdown(ideas, date))), {}, { filename: `ideas-${date}.md`, contentType: "text/markdown" });
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
        const { status, query, page } = parseIdeasArgument(argument);
        const result = bank.listFor(store(), chatId, userId, { query, status: status || undefined, limit: SHOWN_IDEAS, offset: (page - 1) * SHOWN_IDEAS });
        const bankTotal = status ? bank.countsFor(store(), chatId, userId).total : result.total;
        const reminders = result.ideas.length ? ideaReminders(store(), chatId, userId) : {};

        await send(chatId, renderIdeas(result, { query, status, page, bankTotal, reminders }));
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
      case "spark": {
        const { code, shape, topic } = parseSparkArgument(argument);

        return code ? sparkFromCode(msg, code) : spark(msg, topic, { shape });
      }
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
    },
    // "/start spark_<код>", directly or right after a password login.
    sparkFromCode,
    // Called by the reminder scheduler at the time of /daily. Throws when the card could not be sent, so that the
    // scheduler tries again. The spark becomes the chat's last one, so "поменяй поворот" works on it too.
    async deliverDaily({ chatId, userId }) {
      const drawn = history.draw(chatId, rng);

      if (!drawn.ok) {
        throw new Error(drawn.error);
      }

      const [first] = drawn.sparks;
      const keyboard = actions.create({ chatId, userId, kind: "daily", anySession: true,
        rows: [[{ text: "💡 Идеи к этой искре", data: { spark: first, technique: drawn.technique.id } }]] });
      const sent = await bot.sendMessage(chatId, renderDailyCard(first, drawn.technique), { reply_markup: keyboard.markup });

      keyboard.attach(sent.message_id);
      clearKeyboard(bot, chatId, keyboard.previousMessageId);
    },
    // The pressed spark becomes the chat's last one again inside the chat task, right before the model is asked, like a
    // spark code: a spark drawn after it (or the history expiring before the 24-hour button) must not be what
    // "поменяй поворот" changes then.
    dailyButton(query, entry) {
      const technique = techniqueById(entry.data.technique);

      if (!technique) {
        return { refuse: "Кнопка устарела" };
      }

      const msg = callbackMessage(query);
      const { spark: pressed } = entry.data;

      return { run: () => answerWithAi(bot, msg, () => {
        if (!messageAuthorized(msg)) return null;
        history.record(msg.chat.id, [pressed], technique);
        return sparkRequest("", pressed, technique);
      }) };
    },
    // A press under a spark card (src/handlers/actions.js). Only the spark that is still the chat's last one can be
    // changed: an older card would redraw something the person is no longer looking at.
    sparkButton(query, entry) {
      const { spark: shown, topic = "", reroll, shape } = entry.data;

      if (!sameSpark(history.recent(query.message.chat.id).last, shown)) {
        return { refuse: "Эта искра уже не последняя" };
      }

      return { run: () => spark(callbackMessage(query), topic, reroll ? { reroll: [reroll], expectLast: shown } : { shape, expectLast: shown }) };
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
  SPARK_FAILED,
  STATUS_NAMES,
  bankStatusLine,
  parseIdeasArgument,
  parseSparkArgument,
  startSparkCode,
  SPARK_CODE_REFUSALS,
  renderIdeasMarkdown,
  renderDailyCard,
  dateStamp,
  sparkRows,
  lifecycleHooks,
  kindForButton,
  argumentOf,
  renderTechniques,
  renderSparkCard,
  renderIdeas,
  createIdeaCommands
};
