const crypto = require("node:crypto");
const { integer, fail } = require("./tools");
const topics = {
  programming: "💻 Программирование",
  science: "🔬 Наука",
  geography: "🌍 География",
};
// Each difficulty has its own bank; correct index and explanation never come from the AI.
const bank = {
  programming: {
    easy: [
      [
        "Что возвращает typeof 42?",
        ["number", "string", "boolean"],
        0,
        "42 — числовой литерал.",
      ],
      [
        "Каким методом добавить элемент в массив?",
        ["pop", "push", "shift"],
        1,
        "push добавляет в конец.",
      ],
      [
        "Как объявить неизменяемую привязку?",
        ["var", "let", "const"],
        2,
        "const запрещает переприсваивание привязки.",
      ],
    ],
    medium: [
      [
        "typeof null равен…",
        ["null", "object", "undefined"],
        1,
        "Это историческая особенность JavaScript.",
      ],
      [
        "Что вернёт [1,2,3].slice(1)?",
        ["[2,3]", "[1]", "[1,2]"],
        0,
        "slice начинается с индекса 1.",
      ],
      [
        "Как дождаться всех Promise?",
        ["Promise.race", "Promise.all", "Promise.resolve"],
        1,
        "all ожидает весь набор; отклоняется при первом reject.",
      ],
    ],
    hard: [
      [
        "0.1 + 0.2 === 0.3?",
        ["true", "false", "Ошибка"],
        1,
        "IEEE 754 представляет эти дроби приближённо.",
      ],
      [
        "Порядок: синхронный код, Promise.then, setTimeout(0)?",
        [
          "sync → timer → promise",
          "promise → sync → timer",
          "sync → promise → timer",
        ],
        2,
        "Микрозадачи выполняются перед задачами таймера.",
      ],
      [
        "Сложность бинарного поиска?",
        ["O(n)", "O(log n)", "O(n²)"],
        1,
        "На каждом шаге диапазон делится пополам.",
      ],
    ],
  },
  science: {
    easy: [
      [
        "Химическая формула воды?",
        ["CO₂", "H₂O", "O₂"],
        1,
        "Два атома водорода и один кислорода.",
      ],
      [
        "Ближайшая к Солнцу планета?",
        ["Меркурий", "Венера", "Земля"],
        0,
        "Меркурий расположен ближе всего.",
      ],
      [
        "Чем растения поглощают свет?",
        ["Гемоглобином", "Хлорофиллом", "Кератином"],
        1,
        "Хлорофилл — фотосинтетический пигмент.",
      ],
    ],
    medium: [
      [
        "Единица электрического сопротивления?",
        ["Вольт", "Ампер", "Ом"],
        2,
        "Ом — единица сопротивления в СИ.",
      ],
      [
        "Что несёт отрицательный заряд?",
        ["Протон", "Электрон", "Нейтрон"],
        1,
        "Заряд электрона отрицателен.",
      ],
      [
        "Скорость света в вакууме примерно…",
        ["300 тыс. км/с", "300 км/с", "3 млн км/с"],
        0,
        "Точное значение: 299 792 458 м/с.",
      ],
    ],
    hard: [
      [
        "Энтропия изолированной системы самопроизвольно…",
        ["Убывает", "Не убывает", "Всегда равна нулю"],
        1,
        "Второй закон термодинамики: энтропия не убывает.",
      ],
      [
        "Изотопы одного элемента различаются числом…",
        ["Протонов", "Нейтронов", "Электронных оболочек"],
        1,
        "Число протонов определяет элемент.",
      ],
      [
        "pH нейтральной воды при 25°C?",
        ["0", "7", "14"],
        1,
        "При 25°C концентрации H⁺ и OH⁻ равны 10⁻⁷ моль/л.",
      ],
    ],
  },
  geography: {
    easy: [
      [
        "Столица Японии?",
        ["Киото", "Токио", "Осака"],
        1,
        "Токио — столица Японии.",
      ],
      [
        "Самый большой океан?",
        ["Тихий", "Атлантический", "Индийский"],
        0,
        "Тихий океан крупнейший по площади.",
      ],
      [
        "На каком материке Бразилия?",
        ["Африка", "Европа", "Южная Америка"],
        2,
        "Бразилия расположена в Южной Америке.",
      ],
    ],
    medium: [
      [
        "Столица Австралии?",
        ["Сидней", "Канберра", "Мельбурн"],
        1,
        "Канберра, а не крупнейший город Сидней.",
      ],
      [
        "Где расположены Анды?",
        ["Южная Америка", "Азия", "Европа"],
        0,
        "Анды тянутся вдоль западного побережья Южной Америки.",
      ],
      [
        "Какая страна не имеет выхода к морю?",
        ["Португалия", "Швейцария", "Норвегия"],
        1,
        "Швейцария окружена сушей.",
      ],
    ],
    hard: [
      [
        "Пролив между Европой и Африкой?",
        ["Берингов", "Гибралтарский", "Малаккский"],
        1,
        "Гибралтар соединяет Атлантику со Средиземным морем.",
      ],
      [
        "Самое глубокое озеро?",
        ["Байкал", "Виктория", "Титикака"],
        0,
        "Максимальная глубина Байкала — 1642 м.",
      ],
      [
        "Через сколько стран проходит экватор (включая острова)?",
        ["13", "7", "20"],
        0,
        "Экватор проходит через территории 13 стран.",
      ],
    ],
  },
};
const lessons = [
  [
    "const x = {a:1}; x.a = 2; — что произойдёт?",
    ["Ошибка", "a станет 2", "Объект удалится"],
    1,
    "const защищает привязку, а не содержимое объекта.",
  ],
  [
    "[1,2,3].map(x => x * 2) вернёт…",
    ["[2,4,6]", "6", "[1,2,3]"],
    0,
    "map создаёт новый массив результатов.",
  ],
  [
    "Чем сравнивать значение и тип?",
    ["=", "==", "==="],
    2,
    "=== сравнивает без преобразования типов.",
  ],
  [
    "Для обработки отклонённого Promise используют…",
    [".catch()", ".map()", ".push()"],
    0,
    "catch обрабатывает reject; в async можно использовать try/catch.",
  ],
  [
    "Как безопасно прочитать user?.name?",
    ["С optional chaining", "Через eval", "Через JSON.parse"],
    0,
    "?. возвращает undefined, если объект null или undefined.",
  ],
];
const riddles = [
  ["Что становится больше, если из него что-то вынуть?", "яма", "В земле."],
  ["У чего есть клавиши, но нет замков?", "пианино", "Музыкальный инструмент."],
  ["Что можно разбить, не касаясь?", "обещание", "Его дают словами."],
  [
    "Что принадлежит тебе, но другие используют чаще?",
    "имя",
    "Так тебя называют.",
  ],
];
function btn(label, command, args = "") {
  return { label, command, args };
}
function result(text, buttons = [], input) {
  return { text, buttons, ...(input ? { input } : {}) };
}
function nonce() {
  return crypto.randomBytes(5).toString("hex");
}
function shuffled(values) {
  const list = [...values];
  for (let i = list.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}
function questionResult(command, game, feedback = "") {
  const q = game.questions[game.index];
  return result(
    `${feedback}${feedback ? "\n\n" : ""}${command === "learnjs" ? "Урок" : "Вопрос"} ${game.index + 1}/${game.questions.length}\n${q[0]}\nБаллы: ${game.score}`,
    q[1].map((label, i) => btn(label, command, `answer ${game.nonce} ${i}`)),
  );
}
function quiz(context, args, learning = false) {
  const command = learning ? "learnjs" : "quiz",
    key = `${context.scope}:${command}`;
  const parts = args.split(/\s+/).filter(Boolean);
  if (parts[0] === "answer") {
    const game = context.store.get(key, null);
    if (
      !game ||
      game.nonce !== parts[1] ||
      game.index >= game.questions.length ||
      parts.length !== 3
    )
      fail("Этот вопрос уже закрыт. Начни новую игру.");
    const q = game.questions[game.index],
      answer = integer(parts[2], 0, q[1].length - 1),
      correct = answer === q[2];
    if (correct) game.score++;
    const feedback = `${correct ? "✅ Верно!" : "❌ Ответ: " + q[1][q[2]]}\n${q[3]}`;
    game.index++;
    game.nonce = nonce();
    context.store.set(key, game);
    return game.index === game.questions.length
      ? result(
          `${feedback}\n\n${learning ? "Курс завершён" : "Викторина завершена"}: ${game.score}/${game.questions.length}`,
          [btn("Ещё раз", command)],
        )
      : questionResult(command, game, feedback);
  }
  if (learning) {
    if (args && args !== "start")
      fail("Используй /learnjs или /learnjs start.");
    const game = { questions: lessons, index: 0, score: 0, nonce: nonce() };
    context.store.set(key, game);
    return questionResult(command, game);
  }
  if (!args)
    return result(
      "Выбери тему викторины:",
      Object.entries(topics)
        .map(([id, label]) => btn(label, "quiz", id))
        .concat(btn("🎲 Случайная тема", "quiz", "random")),
    );
  let topic = parts[0];
  if (topic === "random") topic = Object.keys(topics)[crypto.randomInt(3)];
  if (!topics[topic]) fail("Темы: programming, science, geography, random.");
  if (parts.length === 1)
    return result(
      `${topics[topic]} — выбери сложность:`,
      ["easy", "medium", "hard"].map((d, i) =>
        btn(["🟢 Легко", "🟡 Средне", "🔴 Сложно"][i], "quiz", `${topic} ${d}`),
      ),
    );
  if (parts.length !== 2 || !bank[topic][parts[1]])
    fail("Сложность: easy, medium, hard.");
  const game = {
    questions: shuffled(bank[topic][parts[1]]),
    index: 0,
    score: 0,
    nonce: nonce(),
  };
  context.store.set(key, game);
  return questionResult(command, game);
}
function guess(context, args) {
  const key = `${context.scope}:guess`;
  if (!args || args === "start") {
    context.store.set(key, { number: crypto.randomInt(1, 101), attempts: 0 });
    return result("Я загадал число от 1 до 100. Введи свою догадку.", [], {
      command: "guess",
      placeholder: "Число от 1 до 100",
    });
  }
  const n = integer(args, 1, 100),
    game = context.store.get(key, null);
  if (!game) fail("Сначала начни игру: /guess.");
  game.attempts++;
  if (n === game.number) {
    context.store.set(key, null);
    return result(`🎉 Угадал ${n} за ${game.attempts} попыток!`, [
      btn("Сыграть снова", "guess"),
    ]);
  }
  context.store.set(key, game);
  return result(
    `${n < game.number ? "Больше ↑" : "Меньше ↓"}\nПопыток: ${game.attempts}`,
    [],
    { command: "guess", placeholder: "Следующее число" },
  );
}
function riddle(context, args) {
  const key = `${context.scope}:riddle`;
  if (!args || args === "new") {
    const id = crypto.randomInt(riddles.length);
    context.store.set(key, { id });
    return result(
      riddles[id][0],
      [
        btn("💡 Подсказка", "riddle", "hint"),
        btn("Показать ответ", "riddle", "reveal"),
      ],
      { command: "riddle", placeholder: "Твой ответ" },
    );
  }
  const game = context.store.get(key, null);
  if (!game) fail("Сначала получи загадку: /riddle.");
  const q = riddles[game.id];
  if (args === "hint")
    return result(q[2], [btn("Показать ответ", "riddle", "reveal")], {
      command: "riddle",
      placeholder: "Твой ответ",
    });
  if (args === "reveal" || args.toLowerCase().replace(/[.!?]/g, "") === q[1]) {
    context.store.set(key, null);
    return result(`${args === "reveal" ? "Ответ" : "✅ Верно"}: ${q[1]}`, [
      btn("Новая загадка", "riddle", "new"),
    ]);
  }
  return result(
    "Пока неверно. Попробуй ещё.",
    [btn("💡 Подсказка", "riddle", "hint")],
    { command: "riddle", placeholder: "Твой ответ" },
  );
}
module.exports = {
  topics,
  bank,
  lessons,
  riddles,
  btn,
  result,
  quiz,
  guess,
  riddle,
};
