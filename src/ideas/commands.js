const CONFIG = require("../config");

// What the idea generator adds to the bot's menu: its commands and keyboard buttons. Plain data, so that both the
// Telegram side (src/handlers/ideas.js, src/commands.js) and the website (src/site.js) list the same things.
// The idea bank lives in the companion store, so it goes away together with the model's functions
// (COMPANION_TOOLS_ENABLED=false): nobody could fill it.

const BANK_ENABLED = CONFIG.COMPANION_TOOLS_ENABLED;

const IDEA_BUTTONS = {
  idea: "💡 Новая идея",
  spark: "🎲 Искра",
  brainstorm: "🧠 Штурм",
  ...(BANK_ENABLED ? { ideas: "📚 Мои идеи" } : {})
};

// One definition per command: the Telegram menu, /help and the website are generated from it.
const IDEA_COMMANDS = [
  { command: "idea", description: "Придумать идеи по теме", usage: "/idea тема - придумать идеи (без темы - случайная искра)" },
  { command: "spark", description: "Случайная искра для идеи", usage: "/spark [проще|конкретнее] [тема] - случайная искра: область и одно-три условия, плюс приём" },
  { command: "brainstorm", description: "Мозговой штурм по теме", usage: "/brainstorm тема - мозговой штурм: два приёма и много идей" },
  ...(BANK_ENABLED
    ? [{
      command: "ideas",
      description: "Мои сохранённые идеи",
      usage: "/ideas [статус] [слово] [страница] - мои идеи (например /ideas в работе, /ideas кофе, /ideas 2), /ideas export - файлом, /ideas del код - удалить, /ideas clear - очистить все"
    }]
    : []),
  { command: "techniques", description: "Приёмы придумывания идей", usage: "/techniques - приёмы, которыми я придумываю идеи" }
];

module.exports = {
  BANK_ENABLED,
  IDEA_BUTTONS,
  IDEA_COMMANDS
};
