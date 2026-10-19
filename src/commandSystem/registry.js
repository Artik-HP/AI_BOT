const crypto = require("node:crypto");
const CONFIG = require("../config");
const tools = require("./tools");
const { result, btn, quiz, guess, riddle } = require("./games");
const {
  validateQuestion,
  visibleText,
} = require("../services/interactiveQuestion");

const CATEGORIES = {
  system: "🏠 Главное",
  ai: "✨ AI и идеи",
  games: "🎮 Игры",
  tools: "🛠 Инструменты",
  code: "💻 Код и обучение",
  daily: "🌿 На каждый день",
  account: "🔐 Аккаунт",
  userbot: "📡 Userbot",
};
const registry = new Map();
function register(
  id,
  title,
  description,
  category,
  icon,
  example,
  handler,
  extra = {},
) {
  if (registry.has(id) || !/^[a-z][a-z0-9_]{0,31}$/.test(id))
    throw new Error("Invalid or duplicate command: " + id);
  registry.set(id, {
    id,
    title,
    description,
    category,
    icon,
    example,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { args: { type: "string", maxLength: 16000 } },
      required: ["args"],
    },
    availability: { telegram: true, web: true, userbot: false },
    handler,
    ...extra,
  });
}
function requireArgs(command, args, buttons = []) {
  return args
    ? null
    : result(
        `${command.description}\nПример: /${command.id} ${command.example}`,
        buttons,
        { command: command.id, placeholder: command.example },
      );
}
function profile(context) {
  return context.store.get(context.scope + ":profile", {
    favorites: [],
    recent: [],
  });
}
function listPage(items, args, pageSize, command) {
  const match = args.match(/^(?:list(?:\s+([1-9]\d*))?)?$/);
  if (!match) tools.fail(`Используй /${command} list или /${command} list НОМЕР.`);
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = tools.integer(match[1] || "1", 1, pages);
  return {
    items: items.slice((page - 1) * pageSize, page * pageSize),
    footer: pages > 1 ? `\n\nСтраница ${page} из ${pages} · Всего: ${items.length}` : "",
    buttons: [
      ...(page > 1 ? [btn("← Назад", command, "list " + (page - 1))] : []),
      ...(page < pages ? [btn("Далее →", command, "list " + (page + 1))] : []),
    ],
  };
}
function accessible(c, context) {
  if (c.botOnly && !context.msg?.from?.is_bot) return false;
  return (
    c.availability[context.transport] &&
    (!c.owner ||
      (context.transport === "telegram" &&
        context.msg?.chat?.type === "private" &&
        String(context.userId) ===
          String(
            c.owner === "account"
              ? CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID
              : CONFIG.BOT_TO_BOT_OWNER_CHAT_ID,
          ) &&
        String(context.chatId) === String(context.userId)))
  );
}
function catalog(context) {
  const language=require('../services/preferences').getPreferences(context.scope,context.store).language;
  return [...registry.values()]
    .filter((c) => !c.hidden && accessible(c, context))
    .map(({ handler, ...c }) => require('../services/i18n').commandMetadata(c,language));
}
function commandList(context, mode, query = "") {
  if (
    !["favorites", "recent", "search", ...Object.keys(CATEGORIES)].includes(
      mode,
    )
  )
    tools.fail("Неизвестный раздел меню. Используй /menu.");
  const p = profile(context),
    all = catalog(context);
  let list = all.filter((c) => c.category !== "userbot");
  if (mode === "favorites")
    list = list.filter((c) => p.favorites.includes(c.id));
  else if (mode === "recent")
    list = p.recent.map((id) => list.find((c) => c.id === id)).filter(Boolean);
  else if (mode === "search")
    list = list.filter((c) =>
      `${c.id} ${c.title} ${c.description}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    );
  else if (mode && CATEGORIES[mode])
    list = list.filter((c) => c.category === mode);
  return result(
    `${mode === "favorites" ? "⭐ Избранное" : mode === "recent" ? "🕘 Недавние" : mode === "search" ? `🔎 Поиск: ${query}` : CATEGORIES[mode] || "Команды"}\n${list.length ? "Выбери команду:" : "Пока пусто."}`,
    list
      .slice(0, 70)
      .map((c) => btn(`${c.icon} ${c.title}`, c.id))
      .concat(btn("🏠 Главное меню", "menu")),
  );
}
function main(context) {
  return result(
    `✦ ${CONFIG.PRODUCT_NAME}\n${CONFIG.PRODUCT_TAGLINE}\n\nВыбери раздел:`,
    Object.entries(CATEGORIES)
      .filter(
        ([id]) =>
          id !== "userbot" &&
          (id !== "account" ||
            catalog(context).some((c) => c.category === "account")),
      )
      .map(([id, label]) => btn(label, "menu", id))
      .concat([
        btn("⭐ Избранное", "favorites"),
        btn("🕘 Недавние", "recent"),
        btn("🔎 Найти команду", "search"),
        btn("🌐 ВЕБ-ИНТЕРФЕЙС", "web"),
        btn("⚙ Мои настройки", "settings"),
      ]),
  );
}
register("start", "Начать", "Открыть главное меню", "system", "👋", "", (ctx) =>
  main(ctx),
);
register(
  "menu",
  "Меню",
  "Категории команд и быстрый запуск",
  "system",
  "🏠",
  "tools",
  (ctx, args) => (args ? commandList(ctx, args) : main(ctx)),
);
register(
  "help",
  "Помощь",
  "Полный список доступных команд",
  "system",
  "❔",
  "",
  (ctx) =>
    result(
      "Команды:\n" +
        catalog(ctx)
          .map((c) => `/${c.id} — ${c.description}`)
          .join("\n"),
    ),
);
register(
  "bot_chat",
  "Входящий диалог ботов",
  "Скрытый входящий запрос доверенного бота",
  "system",
  "🤖",
  "Привет",
  async (ctx, args) => {
    if (!args) tools.fail("Нужен текст сообщения.");
    await require("../services/conversation").processUserText(
      require("../services/telegram").getTelegramBot(),
      ctx.chatId,
      args,
      ctx.msg.from,
      {
        interactive: false,
        replyOptions: require("../services/telegram").getBotToBotReplyOptions(
          ctx.msg,
        ),
      },
    );
    return { text: "", delivered: true };
  },
  {
    hidden: true,
    botOnly: true,
    availability: { telegram: true, web: false, userbot: false },
    external: "OpenRouter / Telegram",
  },
);
register(
  "favorites",
  "Избранное",
  "Запуск любимых команд",
  "system",
  "⭐",
  "",
  (ctx) => commandList(ctx, "favorites"),
);
register(
  "recent",
  "Недавние",
  "Последние использованные команды",
  "system",
  "🕘",
  "",
  (ctx) => commandList(ctx, "recent"),
);
register(
  "search",
  "Поиск",
  "Найти команду по названию или описанию",
  "system",
  "🔎",
  "погода",
  (ctx, args, c) => requireArgs(c, args) || commandList(ctx, "search", args),
);
register(
  "favorite",
  "В избранное",
  "Добавить или убрать команду из избранного",
  "system",
  "🌟",
  "quiz",
  (ctx, args) => {
    const c = registry.get(args.replace(/^\//, ""));
    if (!c || !accessible(c, ctx))
      tools.fail("Укажи доступную команду, например quiz.");
    const p = ctx.store.update(
      ctx.scope + ":profile",
      (value) => {
        value.favorites = value.favorites.includes(c.id)
          ? value.favorites.filter((id) => id !== c.id)
          : [...value.favorites, c.id];
        return value;
      },
      { favorites: [], recent: [] },
    );
    return result(
      `${p.favorites.includes(c.id) ? "Добавлено в" : "Удалено из"} избранного: ${c.title}`,
      [btn("Открыть избранное", "favorites")],
    );
  },
);
for (const [id, title, desc, icon] of [
  ["status", "Статус", "Модели, память и лимиты", "📊"],
  ["voice", "Голосовые", "Как отправить голосовое или аудиофайл", "🎙"],
  ["reset", "Очистить память", "Очистить память текущего диалога", "🧹"],
]) {
  register(id, title, desc, "system", icon, "", async (ctx) => {
    if (ctx.transport === "telegram") {
      const legacy = require("../commands");
      await {
        status: legacy.sendStatus,
        voice: legacy.sendVoiceHelp,
        reset: legacy.resetChatMemory,
      }[id](ctx.chatId, { scope: ctx.scope, store: ctx.store });
      return { text: "", delivered: true };
    }
    if (id === "voice")
      return result(
        "Голосовые, аудиофайлы и изображения доступны в Telegram. Отправь файл боту — он обработает его через OpenRouter.",
      );
    const memory = require("../services/memory");
    if (id === "reset") {
      require("../services/personalData").clearCurrent(ctx.scope, ctx.store);
      return result(
        "Память этого веб-диалога очищена. Заметки и задачи сохранены.",
      );
    }
    const m = memory.getUserMemory(ctx.scope);
    return result(
      `AI: ${CONFIG.MODEL}\nOpenRouter: ${CONFIG.OPENROUTER_API_KEY ? "ключ настроен (доступ не проверен)" : "ключ не настроен"}\nСообщений в памяти: ${m.messages.length}\nХранилище команд: SQLite`,
    );
  });
}

const aiSpecs = [
  [
    "rewrite",
    "Переписать текст",
    "Отредактировать текст в выбранном стиле",
    "✍",
    "Дружелюбно: Ваш запрос принят",
    "Перепиши предоставленный текст в запрошенном стиле. Сохрани смысл и факты; не выдумывай детали.",
  ],
  [
    "plan",
    "Пошаговый план",
    "Превратить цель в конкретные шаги",
    "🪜",
    "Выучить основы JavaScript за месяц",
    "Составь реалистичный план с шагами, сроками, проверкой прогресса и первым действием.",
  ],
  [
    "prompt",
    "Мастер промптов",
    "Создать или улучшить инструкцию для AI",
    "✦",
    "Промпт для изучения английского",
    "Создай ясный промпт с целью, контекстом, ограничениями и форматом ответа. Не используй обходы защит и скрытых инструкций.",
  ],
  [
    "analyze",
    "Анализ текста",
    "Аргументы, предположения и слабые места текста",
    "🔍",
    "Разберите: все приложения должны быть написаны на одном языке",
    "Проанализируй только предоставленный текст: основные тезисы, аргументы, допущения и логические пробелы. Отделяй выводы от фактов.",
  ],
  [
    "sql",
    "Помощник SQL",
    "Составить и объяснить SQL без выполнения",
    "🗃",
    "PostgreSQL: пользователи с более чем 3 сообщениями",
    "Помоги составить SQL. Уточняй схему при недостатке данных. Не выполняй запросы. Отмечай опасные DELETE/UPDATE и предлагай сначала SELECT-проверку.",
  ],
  [
    "debate",
    "Дискуссия",
    "Разобрать тему с аргументами разных сторон",
    "🎙",
    "Нужны ли домашние задания?",
    "Проведи уважительную интеллектуальную дискуссию: сильные аргументы обеих сторон, уточняющий вопрос и проверяемые предположения. Не выдумывай источники.",
  ],
  [
    "roleplay",
    "Ролевой диалог",
    "Тренировка общения в выбранной ситуации",
    "🎭",
    "Собеседование на junior JavaScript",
    "Проведи ролевую тренировку в выбранной ситуации. Обозначь, что это симуляция, задавай по одному вопросу и давай полезную обратную связь.",
  ],
  [
    "chat",
    "Диалог",
    "Продолжить диалог с AI",
    "💬",
    "Привет!",
    "Ответь на сообщение пользователя.",
  ],
  [
    "explain",
    "Объяснить",
    "Объяснить сложную тему с понятными примерами",
    "🧠",
    "Как работает DNS?",
    "Объясни тему простыми словами, затем дай пример и одну проверку понимания.",
  ],
  [
    "translate",
    "Перевод",
    "Определить язык и перевести текст",
    "🌐",
    "на английский: Привет, мир",
    "Определи исходный язык, переведи на запрошенный язык; если язык назначения не указан, уточни его. Не меняй смысл.",
  ],
  [
    "summarize",
    "Краткий пересказ",
    "Выделить главное в большом тексте",
    "📝",
    "Текст для пересказа",
    "Сделай краткий пересказ и выдели главные тезисы. Не добавляй новые факты.",
  ],
  [
    "ideas",
    "Необычные идеи",
    "Придумать разнообразные идеи на выбранную тему",
    "💡",
    "Что сделать в дождливый выходной?",
    "Предложи 7 разных необычных, выполнимых идей с первым шагом для каждой.",
  ],
  [
    "brainstorm",
    "Мозговой штурм",
    "Развить идею через вопросы и варианты",
    "🌪",
    "Придумать домашнюю игру",
    "Проведи пошаговый мозговой штурм. Сначала задай один конкретный вопрос с вариантами, затем развивай ответы.",
  ],
  [
    "compare",
    "Сравнение",
    "Сравнить варианты по явным критериям",
    "⚖",
    "Node.js и Python для небольшого API",
    "Сравни указанные варианты по практическим критериям, объясни компромиссы и условия выбора.",
  ],
  [
    "joke",
    "Шутка",
    "Придумать шутку на выбранную тему",
    "😄",
    "о программистах",
    "Придумай короткую оригинальную доброжелательную шутку.",
  ],
  [
    "story",
    "История с выбором",
    "Интерактивная история, которую направляет пользователь",
    "📖",
    "Космический детектив",
    "Начни или продолжи интерактивную историю. Заверши одним вопросом о следующем действии с 2–4 вариантами.",
  ],
  [
    "code",
    "Пример кода",
    "Генерация примера кода с объяснением",
    "⌨",
    "JS: debounce",
    "Дай пример кода и объясни его. Код является текстом и не выполняется.",
  ],
  [
    "debug",
    "Найти ошибку",
    "Разобрать ошибку и предложить исправление",
    "🐛",
    "JS: const a = null; a.name",
    "Найди ошибки в предоставленном коде, объясни причину и предложи исправление. Не заявляй, что код был выполнен.",
  ],
  [
    "refactor",
    "Рефакторинг",
    "Улучшить код с сохранением поведения",
    "♻",
    "JS: function add(a,b){return a+b}",
    "Предложи улучшение кода с сохранением поведения. Объясни изменения и проверки.",
  ],
  [
    "review",
    "Проверка кода",
    "Анализ качества, рисков и читаемости кода",
    "🔬",
    "JS: function div(a,b){return a/b}",
    "Проведи обзор кода. Сначала конкретные ошибки, затем улучшения. Не выдавай догадки за подтверждённые дефекты.",
  ],
  [
    "regex",
    "Помощник regex",
    "Составить регулярное выражение и примеры",
    "🔎",
    "Найти даты YYYY-MM-DD",
    "Предложи регулярное выражение, объясни ограничения и примеры совпадений. Не выполняй выражение пользователя.",
  ],
  [
    "algorithm",
    "Алгоритмы",
    "Объяснить алгоритм с кодом и сложностью",
    "🧩",
    "Бинарный поиск",
    "Объясни алгоритм, покажи пример JavaScript, разберись со сложностью и крайними случаями.",
  ],
];
for (const [id, title, desc, icon, example, instruction] of aiSpecs)
  register(
    id,
    title,
    desc,
    [
      "code",
      "debug",
      "refactor",
      "review",
      "regex",
      "algorithm",
      "sql",
    ].includes(id)
      ? "code"
      : "ai",
    icon,
    example,
    async (ctx, args, c) => {
      if (!args && !["joke"].includes(id)) return requireArgs(c, args);
      require("../services/aiProviders").headers(
        require("../services/preferences").getPreferences(ctx.scope, ctx.store)
          .provider,
      );
      const previous = ctx.store.get(ctx.scope + ":aiQuestion", null);
      const reply = await require("../services/openrouter").askAI(
        ctx.scope,
        id === "chat" ? args : `${instruction}\n\n${args || "На любую тему"}`,
        { id: ctx.userId },
        previous && id === "chat"
          ? {
              selectionQuestion: previous,
              selectionLabels: previous.options
                .filter((o) => o.value === args)
                .map((o) => o.label),
            }
          : {},
      );
      ctx.store.set(
        ctx.scope + ":aiQuestion",
        validateQuestion(reply) ? reply : null,
      );
      if (validateQuestion(reply) && reply.selection_mode === "multiple") {
        const state = {
          nonce: crypto.randomBytes(5).toString("hex"),
          question: reply,
          selected: [],
        };
        ctx.store.set(ctx.scope + ":selection", state);
        return multiResult(state);
      }
      return validateQuestion(reply)
        ? result(
            visibleText(reply),
            reply.options.map((o) => btn(choiceLabel(o.label), "chat", o.value)),
            { command: "chat", placeholder: "Свой вариант" },
          )
        : result(reply);
    },
    { external: "OpenRouter" },
  );
function choiceLabel(label) {
  if (label.length <= 200) return label;
  let shortened = "";
  for (const character of label) {
    if (shortened.length + character.length > 199) break;
    shortened += character;
  }
  return shortened + "…";
}
const CHOICE_PAGE_SIZE = 6;
function multiResult(state) {
  const page = state.page || 0;
  const pages = Math.ceil(state.question.options.length / CHOICE_PAGE_SIZE);
  const start = page * CHOICE_PAGE_SIZE;
  return result(
    visibleText(state.question) + (pages > 1 ? `\n\nСтраница ${page + 1} из ${pages}` : ""),
    state.question.options
      .slice(start, start + CHOICE_PAGE_SIZE)
      .map((o, offset) =>
        btn(
          choiceLabel(`${state.selected.includes(start + offset) ? "✅" : "▫"} ${o.label}`),
          "select",
          `${state.nonce} ${start + offset}`,
        ),
      )
      .concat(
        page > 0 ? [btn("← Назад", "select", `${state.nonce} page:${page - 1}`)] : [],
        page + 1 < pages ? [btn("Далее →", "select", `${state.nonce} page:${page + 1}`)] : [],
      )
      .concat(
        btn(
          `Подтвердить (${state.selected.length})`,
          "select",
          `${state.nonce} confirm`,
        ),
      ),
    { command: "chat", placeholder: "Свой ответ" },
  );
}
register(
  "select",
  "Выбор вариантов",
  "Подтверждение нескольких ответов AI",
  "system",
  "✓",
  "",
  async (ctx, args) => {
    const [token, action, ...extra] = args.split(" "),
      state = ctx.store.get(ctx.scope + ":selection", null);
    if (!state || token !== state.nonce || extra.length)
      tools.fail("Этот выбор устарел. Продолжи диалог.");
    if (action === "confirm") {
      if (!state.selected.length) tools.fail("Выбери хотя бы один вариант.");
      const response = await registry
        .get("chat")
        .handler(
          ctx,
          state.selected.map((i) => state.question.options[i].value).join("\n"),
          registry.get("chat"),
        );
      if (!response.error && ctx.store.get(ctx.scope + ":selection", null)?.nonce === state.nonce)
        ctx.store.set(ctx.scope + ":selection", null);
      return response;
    }
    if (action?.startsWith("page:")) {
      state.page = tools.integer(action.slice(5), 0, Math.ceil(state.question.options.length / CHOICE_PAGE_SIZE) - 1);
      ctx.store.set(ctx.scope + ":selection", state);
      return multiResult(state);
    }
    const index = tools.integer(action, 0, state.question.options.length - 1);
    state.selected = state.selected.includes(index)
      ? state.selected.filter((i) => i !== index)
      : [...state.selected, index].sort((a, b) => a - b);
    ctx.store.set(ctx.scope + ":selection", state);
    return multiResult(state);
  },
  { hidden: true },
);

register(
  "quiz",
  "Викторина",
  "Три темы, три сложности, ответы и баллы",
  "games",
  "🧠",
  "science easy",
  (ctx, args) => ctx.store.transaction(() => quiz(ctx, args)),
);
register(
  "learnjs",
  "Учить JavaScript",
  "Пять интерактивных уроков с проверкой ответа",
  "code",
  "📚",
  "start",
  (ctx, args) => ctx.store.transaction(() => quiz(ctx, args, true)),
);
register(
  "guess",
  "Угадай число",
  "Игра от 1 до 100 с подсказками",
  "games",
  "🎯",
  "50",
  (ctx, args) => ctx.store.transaction(() => guess(ctx, args)),
);
register(
  "riddle",
  "Загадки",
  "Загадки с подсказкой и проверкой ответа",
  "games",
  "🗝",
  "hint",
  (ctx, args) => ctx.store.transaction(() => riddle(ctx, args)),
);
const facts = [
  "Осьминоги имеют три сердца. Два снабжают жабры, третье — тело.",
  "Венера вращается вокруг оси медленнее, чем совершает оборот вокруг Солнца.",
  "Свету от Солнца требуется около 8 минут 20 секунд, чтобы достичь Земли.",
  "UUID версии 4 содержит 122 случайных бита; остальные биты задают версию и вариант.",
];
register(
  "trivia",
  "Любопытный факт",
  "Факт из локальной подборки с объяснением",
  "games",
  "🔭",
  "",
  (ctx, args) => {
    if (args) tools.fail("Эта команда не требует аргументов.");
    return result(facts[crypto.randomInt(facts.length)], [
      btn("Ещё факт", "trivia"),
    ]);
  },
);
const dilemmas = [
  ["Понимать все языки", "Играть на любом инструменте"],
  ["Жить неделю в космосе", "Исследовать океан неделю"],
  ["Видеть прошлое города", "Видеть его через 100 лет"],
];
register(
  "wouldyou",
  "Что выберешь?",
  "Необычные дилеммы с фиксацией выбора",
  "games",
  "🤔",
  "",
  (ctx, args) => {
    if (args) {
      const m = args.match(/^(\d) ([01])$/);
      if (!m || !dilemmas[+m[1]])
        tools.fail("Выбери один из вариантов кнопкой.");
      return result(
        `Твой выбор: ${dilemmas[+m[1]][+m[2]]}\nОбъясни другу, почему именно этот вариант!`,
        [btn("Новая дилемма", "wouldyou")],
      );
    }
    const i = crypto.randomInt(dilemmas.length);
    return result(
      "Что выберешь?",
      dilemmas[i].map((v, j) => btn(v, "wouldyou", `${i} ${j}`)),
    );
  },
);
register(
  "challenge",
  "Испытание ума",
  "Случайная арифметическая задача с проверкой",
  "games",
  "⚡",
  "",
  (ctx, args) => {
    const key = ctx.scope + ":challenge";
    if (!args || args === "daily") {
      const a = crypto.randomInt(12, 99),
        b = crypto.randomInt(2, 12);
      const today = new Intl.DateTimeFormat("en-CA", {
        timeZone: process.env.DEFAULT_TIMEZONE || "Europe/Kyiv",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
      const daily =
        args === "daily"
          ? ctx.store.get(ctx.scope + ":daily-challenge", null)
          : null;
      if (daily?.day === today) {
        ctx.store.set(key, { answer: daily.a * daily.b });
        return result(`Задание дня ${today}: ${daily.a} × ${daily.b}`, [], {
          command: "challenge",
          placeholder: "Ответ числом",
        });
      }
      if (args === "daily")
        ctx.store.set(ctx.scope + ":daily-challenge", { day: today, a, b });
      ctx.store.set(key, { answer: a * b });
      return result(`Вычисли без калькулятора: ${a} × ${b}`, [], {
        command: "challenge",
        placeholder: "Ответ числом",
      });
    }
    const value = ctx.store.get(key, null);
    if (!value) tools.fail("Сначала запусти /challenge.");
    const n = tools.integer(args, -1000000, 1000000);
    if (n !== value.answer)
      return result("Пока неверно. Попробуй ещё.", [], {
        command: "challenge",
        placeholder: "Ответ",
      });
    ctx.store.set(key, null);
    return result("✅ Верно!", [btn("Следующее испытание", "challenge")]);
  },
);

for (const [id, title, desc, icon, example, handler] of [
  [
    "password",
    "Пароль",
    "Криптографически случайный пароль",
    "🔑",
    "20",
    tools.password,
  ],
  [
    "uuid",
    "UUID",
    "Случайные UUID версии 4",
    "🆔",
    "3",
    (a) =>
      Array.from({ length: tools.integer(a || "1", 1, 20) }, () =>
        crypto.randomUUID(),
      ).join("\n"),
  ],
  [
    "hash",
    "Хеш текста",
    "SHA-256 или SHA-512 от текста",
    "🔏",
    "sha256 Привет",
    (a) => {
      const m = a.match(/^(sha256|sha512)\s+([\s\S]+)$/);
      if (!m) tools.fail("Используй sha256 текст или sha512 текст.");
      return crypto.createHash(m[1]).update(m[2], "utf8").digest("hex");
    },
  ],
  [
    "base64",
    "Base64",
    "Кодирование и декодирование UTF-8",
    "📦",
    "encode Привет",
    tools.base64,
  ],
  [
    "json",
    "Формат JSON",
    "Проверить JSON и красиво отформатировать",
    "🧾",
    '{"name":"Alex","active":true}',
    (a) => {
      try {
        return JSON.stringify(JSON.parse(a), null, 2);
      } catch {
        tools.fail("Некорректный JSON. Проверь кавычки, запятые и скобки.");
      }
    },
  ],
  [
    "timestamp",
    "Unix-время",
    "Преобразование Unix и ISO 8601",
    "⏱",
    "1700000000",
    tools.timestamp,
  ],
  [
    "calculator",
    "Калькулятор",
    "Безопасные арифметические выражения",
    "🧮",
    "(12 + 8) * 3",
    (a) => String(tools.calculate(a)),
  ],
  [
    "convert",
    "Единицы",
    "Длина, масса, объём, время и температура",
    "📏",
    "10 km m",
    tools.convert,
  ],
  [
    "morse",
    "Азбука Морзе",
    "Кодирование латинского текста в Морзе",
    "📻",
    "SOS",
    (a) => {
      const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
        codes = [
          ".-",
          "-...",
          "-.-.",
          "-..",
          ".",
          "..-.",
          "--.",
          "....",
          "..",
          ".---",
          "-.-",
          ".-..",
          "--",
          "-.",
          "---",
          ".--.",
          "--.-",
          ".-.",
          "...",
          "-",
          "..-",
          "...-",
          ".--",
          "-..-",
          "-.--",
          "--..",
          "-----",
          ".----",
          "..---",
          "...--",
          "....-",
          ".....",
          "-....",
          "--...",
          "---..",
          "----.",
        ];
      if (/[^a-z0-9\s]/i.test(a))
        tools.fail("Используй латинские буквы, цифры и пробелы.");
      return a
        .toUpperCase()
        .split("")
        .map((c) => (/\s/.test(c) ? "/" : codes[letters.indexOf(c)]))
        .join(" ");
    },
  ],
  [
    "wordstats",
    "Статистика текста",
    "Символы, слова, строки и время чтения",
    "🔤",
    "Текст для анализа",
    (a) => {
      const words = a.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || [];
      return `Символов: ${Array.from(a).length}\nСлов: ${words.length}\nСтрок: ${a.split("\n").length}\nЧтение: ~${Math.max(1, Math.ceil(words.length / 200))} мин`;
    },
  ],
])
  register(id, title, desc, "tools", icon, example, (ctx, args, c) => {
    const prompt = ["password", "uuid", "timestamp"].includes(id)
      ? null
      : requireArgs(c, args);
    return prompt || result(handler(args));
  });
register(
  "qr",
  "QR-код",
  "Создать PNG с QR-кодом текста или ссылки",
  "tools",
  "▦",
  "https://example.com",
  async (ctx, args, c) =>
    requireArgs(c, args) || {
      text: "QR-код готов.",
      image: await tools.qr(args),
    },
);
register(
  "random",
  "Случайное число",
  "Криптографически случайное целое в диапазоне",
  "daily",
  "🎲",
  "1 100",
  (ctx, args) => {
    const p = (args || "1 100").split(/\s+/);
    if (p.length !== 2) tools.fail("Укажи минимум и максимум, например 1 100.");
    const a = tools.integer(p[0], -1000000000, 1000000000),
      b = tools.integer(p[1], -1000000000, 1000000000);
    if (a > b) tools.fail("Минимум больше максимума.");
    return result(String(crypto.randomInt(a, b + 1)));
  },
);
register(
  "decision",
  "Выбрать вариант",
  "Случайный выбор из твоих вариантов",
  "daily",
  "🧭",
  "кино | прогулка | книга",
  (ctx, args, c) => {
    const prompt = requireArgs(c, args);
    if (prompt) return prompt;
    const values = args.split("|").map((v) => v.trim());
    if (values.length < 2 || values.length > 30 || values.some((v) => !v))
      tools.fail("Укажи 2–30 непустых вариантов через |.");
    return result(`Выбираю: ${values[crypto.randomInt(values.length)]}`);
  },
);
register(
  "time",
  "Мировое время",
  "Текущее время в часовом поясе IANA",
  "daily",
  "🌍",
  "Europe/Kyiv",
  (ctx, args) => {
    try {
      return result(
        new Intl.DateTimeFormat("ru-RU", {
          timeZone: args || "Europe/Kyiv",
          dateStyle: "full",
          timeStyle: "long",
        }).format(new Date()),
      );
    } catch {
      tools.fail(
        "Неизвестный часовой пояс. Пример: Europe/Kyiv, Asia/Tokyo, America/New_York.",
      );
    }
  },
);
register(
  "weather",
  "Погода",
  "Текущая погода из Open-Meteo по городу",
  "daily",
  "🌤",
  "Kyiv",
  async (ctx, args, c) =>
    requireArgs(c, args, [
      btn("Киев", "weather", "Kyiv"),
      btn("Львов", "weather", "Lviv"),
    ]) || result(await tools.weather(args, ctx.http)),
  { external: "Open-Meteo" },
);

for (const id of ["notes", "todo"])
  register(
    id,
    id === "notes" ? "Заметки" : "Мои задачи",
    id === "notes"
      ? "Сохранять и удалять личные заметки"
      : "Добавлять задачи и отмечать выполнение",
    "daily",
    id === "notes" ? "🗒" : "☑",
    "add " + (id === "notes" ? "Идея для выходного" : "Прочитать книгу"),
    (ctx, args) =>
      ctx.store.transaction(() => {
        const key = ctx.scope + ":" + id,
          items = ctx.store.get(key, []),
          m = args.match(/^(add|delete|done)\s+([\s\S]+)$/);
        if (!args || /^list(?:\s|$)/.test(args)) {
          const page = listPage(items, args, 10, id);
          return result(
            (items.length
              ? page.items
                  .map((v) => `${v.id} ${v.done ? "✅" : "▫"} ${v.text}`)
                  .join("\n")
              : "Пока пусто.") + page.footer,
            [...page.items.flatMap((v) => [
                ...(id === "todo" && !v.done
                  ? [btn(`✓ ${v.text.slice(0, 30)}`, id, "done " + v.id)]
                  : []),
                btn(`Удалить ${v.id}`, id, "delete " + v.id),
              ]), ...page.buttons],
            {
              command: id,
              placeholder:
                "add " + (id === "notes" ? "текст заметки" : "новая задача"),
            },
          );
        }
        if (!m || (id === "notes" && m[1] === "done"))
          tools.fail(
            `Используй /${id} add текст, /${id} list, /${id} delete ID${id === "todo" ? `, /todo done ID` : ""}.`,
          );
        if (m[1] === "add") {
          if (items.length >= 200 || m[2].length > 2000)
            tools.fail("Лимит: 200 записей по 2000 символов.");
          const item = {
            id: crypto.randomBytes(4).toString("hex"),
            text: m[2],
            done: false,
          };
          items.push(item);
          ctx.store.set(key, items);
          return result(`Сохранено: ${item.id}\n${item.text}`, [
            btn("Показать список", id),
          ]);
        }
        const item = items.find((v) => v.id === m[2]);
        if (!item) tools.fail("Запись не найдена в твоём списке.");
        if (m[1] === "done") item.done = true;
        ctx.store.set(
          key,
          m[1] === "delete" ? items.filter((v) => v !== item) : items,
        );
        return result(
          m[1] === "done" ? "Задача выполнена." : "Запись удалена.",
          [btn("Показать список", id)],
        );
      }),
  );
for (const id of ["reminder", "timer"])
  register(
    id,
    id === "timer" ? "Таймер" : "Напоминания",
    id === "timer"
      ? "Таймер с уведомлением"
      : "Сохранять напоминания с реальным планировщиком",
    "daily",
    id === "timer" ? "⏲" : "🔔",
    id === "timer" ? "5m" : "10m Выпить воды",
    (ctx, args, c) => {
      if (!args)
        return requireArgs(c, args, [
          btn("5 минут", id, id === "timer" ? "5m" : "5m Сделать перерыв"),
          btn("Список", "reminder", "list"),
        ]);
      if (/^list(?:\s|$)/.test(args)) {
        const rows = ctx.store.reminders(ctx.scope);
        const page = listPage(rows, args, 3, id);
        return result(
          (rows.length
            ? page.items
                .map(
                  (v) =>
                    `${v.id}: ${v.text} — ${new Date(v.due).toISOString()} (${v.status})`,
                )
                .join("\n")
            : "Активных напоминаний нет.") + page.footer,
          [...page.items.map((v) =>
            btn("Отменить " + v.id, "reminder", "cancel " + v.id),
          ), ...page.buttons],
        );
      }
      if (args.startsWith("cancel ")) {
        if (!ctx.store.cancelReminder(ctx.scope, args.slice(7)))
          tools.fail("Напоминание не найдено или уже отправляется.");
        return result("Напоминание отменено.");
      }
      const m = args.match(/^(\d+[smhd])(?:\s+([\s\S]+))?$/);
      if (!m || (id === "reminder" && !m[2]))
        tools.fail(`Пример: /${id} ${c.example}`);
      const due = Date.now() + tools.duration(m[1]),
        text = m[2] || "⏲ Таймер завершён!";
      if (ctx.store.reminders(ctx.scope).length >= 100)
        tools.fail("Лимит: 100 активных напоминаний.");
      const key = ctx.store.addReminder(ctx, text, due);
      return result(
        `Установлено: ${key}\n${new Date(due).toISOString()}\n${text}\n${ctx.transport === "web" ? "Уведомление появится в веб-панели." : "Уведомление придёт в этот Telegram-чат."}`,
        [btn("Активные напоминания", "reminder", "list")],
      );
    },
  );

const legacyAccount = [
  ["help", "Помощь аккаунта", ""],
  ["status", "Статус аккаунта", ""],
  ["config", "Настройки аккаунта", ""],
  ["pending", "Черновики", ""],
  ["send", "Отправить черновик", "ID"],
  ["drop", "Отклонить черновик", "ID"],
  ["reply", "Свой ответ", "ID текст"],
  ["redraft", "Обновить черновик", "ID"],
  ["message", "Написать от аккаунта", "@username текст"],
  ["mode", "Режим ассистента", "approval"],
  ["private", "Только личные чаты", "true"],
  ["allow", "Разрешить чат", "@username"],
  ["unallow", "Убрать разрешение", "@username"],
  ["block", "Заблокировать чат", "@username"],
  ["unblock", "Снять блокировку", "@username"],
  ["enable", "Включить ассистента", ""],
  ["disable", "Отключить ассистента", ""],
];
for (const [name, title, example] of legacyAccount)
  register(
    "account_" + name,
    title,
    "Управление ассистентом: " + title.toLowerCase(),
    "account",
    "🔐",
    example,
    async (ctx, args, c) => {
      if (example && !args && !["mode", "private"].includes(name))
        return requireArgs(c, args);
      await require("../services/accountAssistant").executeAccountCommand(
        ctx.msg,
        c.id,
        args,
      );
      return { text: "", delivered: true };
    },
    {
      owner: "account",
      availability: { telegram: true, web: false, userbot: false },
      external: ["enable", "send", "reply", "message", "redraft"].includes(name)
        ? "Telegram Account / OpenRouter"
        : undefined,
    },
  );
for (const [id, title, example] of [
  ["bot_status", "Связь с ботами", ""],
  ["bot_send", "Написать боту", "@username текст"],
])
  register(
    id,
    title,
    "Общение с другим Telegram-ботом",
    "account",
    "🤖",
    example,
    async (ctx, args, c) => {
      if (id === "bot_send" && !args) return requireArgs(c, args);
      const legacy = require("../commands");
      if (id === "bot_status")
        await legacy.sendBotToBotStatus(ctx.chatId, ctx.msg);
      else
        await legacy.sendBotMessageFromCommand(
          ctx.chatId,
          "/bot_send " + args,
          ctx.msg,
        );
      return { text: "", delivered: true };
    },
    {
      owner: "bot",
      availability: { telegram: true, web: false, userbot: false },
      external: "Telegram",
    },
  );

require("./productCommands").registerProductCommands(register, result, btn);
require("./userbot").registerUserbot(register);
module.exports = {
  CATEGORIES,
  registry,
  register,
  catalog,
  accessible,
  profile,
  result,
  btn,
};
