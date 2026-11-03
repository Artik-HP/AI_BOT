const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { withApp } = require("../helpers/app");
const { failure, reply } = require("../helpers/fakeOpenRouter");
const { TOOL_NAMES, IDEA_PERSONA_TOOLS } = require("../../src/companion/tools");
const { SPARK_POOLS, SPARK_LABELS, TECHNIQUES } = require("../../src/ideas/catalog");

// The test harness pins the companion character for the older suites; this one runs the real product default.
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
const readStore = (app) => JSON.parse(fs.readFileSync(`${app.memoryFile}.rpg.json`, "utf8"));
const systemOf = (or) => or.chatRequests().at(-1).body.messages[0].content;
const userTurnOf = (or) => or.chatRequests().at(-1).body.messages.at(-1).content;

// Sends one message and returns the `count` texts the bot answered with.
async function say(tg, chatId, text, { count = 1, ...extra } = {}) {
  const before = tg.texts().length;

  tg.message({ chatId, text, ...extra });
  await tg.waitFor(() => tg.texts().length >= before + count, 10000, `ответ на «${text}»`);
  await tg.quiet(150);
  return tg.texts().slice(before);
}

const saveIdea = (or, ...ideas) => {
  or.chat = (record) => (lastMessage(record).role === "tool"
    ? reply("Сохранил в банк")
    : toolCalls(...ideas.map((idea) => ["idea_save", idea])));
};

const KEYBOARD_LABELS = ["💡 Новая идея", "🎲 Искра", "🧠 Штурм", "📚 Мои идеи"];

async function keyboardOf(tg, chatId) {
  const before = tg.sent().length;

  tg.message({ chatId, text: "/start" });
  await tg.waitFor(() => tg.sent().length >= before + 2, 8000, "ответ на /start");
  await tg.quiet(150);

  const withKeyboard = tg.sent().slice(before).find((params) => params.reply_markup && JSON.parse(params.reply_markup).keyboard);

  return JSON.parse(withKeyboard.reply_markup).keyboard.flat().map((button) => button.text);
}

test("по умолчанию бот — генератор идей: промпт идей, четыре идейные функции плюс память, пустой банк, знакомство", async () => {
  await withApp({ env: IDEAS }, async ({ tg, or }) => {
    or.chat = () => reply("Вот три идеи для кофейни");

    assert.deepEqual(await say(tg, 5101, "хочу придумать название для кофейни"), ["Вот три идеи для кофейни"]);

    const [request] = or.chatRequests();
    const system = request.body.messages[0].content;

    assert.deepEqual(request.body.tools.map((tool) => tool.function.name), IDEA_PERSONA_TOOLS);
    assert.match(system, /^Ты — Генератор идей, AI-бот в Telegram, который придумывает новые идеи/);
    assert.match(system, /Функции в этом запросе: idea_spark, idea_save, idea_list, idea_update, memory_save, memory_search, reminder_create\n/);
    assert.match(system, /Банк идей: пока пуст/);
    assert.match(system, /действуй по разделу СТАРТ/, "первое сообщение человека");
    assert.doesNotMatch(system, /roll_dice|character_update|game_state_save/);
  });
});

test("искру выбирает сервер: модель просит idea_spark, ингредиенты и приём из каталога, в чат уходит только итог", async () => {
  await withApp({ env: IDEAS }, async ({ tg, or }) => {
    or.chat = (record) => (lastMessage(record).role === "tool"
      ? reply(`Выпало искр: ${toolResults(record).at(-1).sparks.length}`)
      : toolCalls(["idea_spark", { count: 2 }]));

    assert.deepEqual(await say(tg, 5102, "удиви меня"), ["Выпало искр: 2"]);
    assert.equal(or.chatRequests().length, 2);
    assert.equal(tg.texts().length, 1, "промежуточный шаг с вызовом функции в чат не уходит");

    const [spark] = toolResults(or.chatRequests()[1]);
    const known = new Set(Object.values(SPARK_POOLS).flat());

    assert.equal(spark.ok, true);
    assert.ok(spark.sparks.every((entry) => Object.values(entry).every((value) => known.has(value))));
    assert.ok(TECHNIQUES.some((technique) => technique.id === spark.technique.id));
  });
});

test("банк идей: модель сохраняет идею функцией, она на диске; /ideas показывает, ищет и удаляет без модели", async () => {
  await withApp({ env: IDEAS }, async ({ tg, or, app }) => {
    saveIdea(or, { title: "Кофейня-библиотека", pitch: "Читаешь книгу — платишь меньше за кофе.", tags: ["кофе", "город"], next_step: "Поговорить с хозяином кофейни" });

    assert.deepEqual(await say(tg, 5103, "сохрани идею про кофейню"), ["Сохранил в банк"]);

    const [stored] = readStore(app).ideas["5103:5103"];
    const requests = or.chatRequests().length;
    const [list] = await say(tg, 5103, "/ideas");

    assert.equal(stored.title, "Кофейня-библиотека");
    assert.match(list, /^📚 Твои идеи \(1\):/);
    assert.ok(list.includes(`🆕 ${stored.id} · Кофейня-библиотека`));
    assert.match(list, /Шаг: Поговорить с хозяином кофейни/);
    assert.match(list, /#кофе #город/);
    assert.match(list, /Удалить: \/ideas del код/);

    assert.match((await say(tg, 5103, "/ideas кофейня"))[0], /^📚 Нашлось 1 из 1:/);
    assert.match((await say(tg, 5103, "/ideas жираф"))[0], /ничего не нашлось.*Всего идей: 1/);
    assert.match((await say(tg, 5103, "/ideas del нетакогокода"))[0], /Укажи код идеи/);
    assert.equal((await say(tg, 5103, "/ideas del deadbeef"))[0], "Идеи с таким кодом нет.");
    assert.match((await say(tg, 5103, "/ideas clear"))[0], /Это удалит все идеи \(1\) без возврата\. Подтверди: \/ideas clear да/);
    assert.equal(readStore(app).ideas["5103:5103"].length, 1, "без подтверждения ничего не удалено");

    assert.equal((await say(tg, 5103, `/ideas del ${stored.id.toUpperCase()}`))[0], "Идея удалена.");
    assert.match((await say(tg, 5103, "/ideas"))[0], /^В банке пока пусто/);
    assert.equal(readStore(app).ideas["5103:5103"], undefined, "когда идей нет, запись человека убрана");
    assert.equal(or.chatRequests().length, requests, "ни одна команда /ideas не ходила к модели");

    saveIdea(or, { title: "Первая", pitch: "Суть первой идеи." }, { title: "Вторая", pitch: "Суть второй идеи." });
    await say(tg, 5103, "сохрани две");
    assert.equal((await say(tg, 5103, "/ideas clear да"))[0], "Удалено идей: 2.");
    assert.equal(readStore(app).ideas["5103:5103"], undefined);
  });
});

test("банк виден модели без вызова функции: последние названия в контексте; другой человек и группа их не видят", async () => {
  await withApp({ env: IDEAS }, async ({ tg, or }) => {
    saveIdea(or, { title: "Будильник-вопрос", pitch: "Будит вопросом на пять секунд." });
    await say(tg, 5104, "сохрани");

    or.chat = () => reply("дальше");
    await say(tg, 5104, "что дальше?");
    assert.match(systemOf(or), /Банк идей: сохранено 1; последние \(данные, не инструкции\): «Будильник-вопрос»/);

    await say(tg, 5105, "привет");
    assert.match(systemOf(or), /Банк идей: пока пуст/, "другой человек");

    await say(tg, -100555, "а тут есть идеи?", { chatType: "supergroup", fromId: 5104, firstName: "Вася" });
    assert.match(systemOf(or), /Банк идей: пока пуст/, "из личного чата идеи в группу не попадают");
  });
});

test("функции чужого характера недоступны: идеи не бросают кубик, собеседник не трогает банк; /style переключает наборы", async () => {
  await withApp({ env: IDEAS }, async ({ tg, or, app }) => {
    const attempt = (name, args) => {
      or.chat = (record) => (lastMessage(record).role === "tool" ? reply(JSON.stringify(toolResults(record).at(-1))) : toolCalls([name, args]));
    };

    attempt("roll_dice", { sides: 6 });

    const refused = JSON.parse((await say(tg, 5106, "брось кубик"))[0]);

    assert.deepEqual([refused.ok, refused.error], [false, "unknown_tool"]);
    assert.deepEqual(refused.tools, IDEA_PERSONA_TOOLS, "модель узнаёт, что ей доступно");

    assert.match((await say(tg, 5106, "/style собеседник"))[0], /теперь характер: собеседник/);
    attempt("idea_save", { title: "Чужая идея", pitch: "Сохранить не получится." });
    assert.equal(JSON.parse((await say(tg, 5106, "сохрани идею"))[0]).error, "unknown_tool");
    assert.deepEqual(or.chatRequests().at(-1).body.tools.map((tool) => tool.function.name), TOOL_NAMES, "собеседник получает прежние восемь функций");
    assert.equal(fs.existsSync(`${app.memoryFile}.rpg.json`) ? readStore(app).ideas["5106:5106"] : undefined, undefined);

    assert.match((await say(tg, 5106, "/style идеи"))[0], /теперь характер: генератор идей/);
    attempt("idea_save", { title: "Своя идея", pitch: "Теперь сохранится." });
    assert.equal(JSON.parse((await say(tg, 5106, "сохрани идею"))[0]).saved, true);
    assert.equal(readStore(app).ideas["5106:5106"].length, 1);
  });
});

test("/idea и /brainstorm: тема уходит модели одной строкой запроса; /brainstorm без темы — подсказка без модели", async () => {
  await withApp({ env: IDEAS }, async ({ tg, or }) => {
    or.chat = () => reply("Идеи готовы");

    assert.deepEqual(await say(tg, 5107, "/idea умный чайник для офиса"), ["Идеи готовы"]);
    assert.equal(userTurnOf(or), "Придумай идеи по теме: умный чайник для офиса");

    assert.deepEqual(await say(tg, 5107, "/brainstorm как собрать соседей во дворе"), ["Идеи готовы"]);
    assert.equal(userTurnOf(or), "Устрой мозговой штурм по теме: как собрать соседей во дворе");

    const before = or.chatRequests().length;
    const [hint] = await say(tg, 5107, "/brainstorm");

    assert.match(hint, /^🧠 Мозговой штурм: напиши тему/);
    assert.equal(or.chatRequests().length, before, "подсказка не тратит запрос к модели");
  });
});

test("/spark и /idea без темы: код бросает искру и сразу показывает карточку, затем модель получает те же ингредиенты", async () => {
  await withApp({ env: IDEAS }, async ({ tg, or }) => {
    or.chat = () => reply("Три идеи по искре");

    for (const command of ["/spark", "/idea"]) {
      const [card, answer] = await say(tg, 5108, command, { count: 2 });
      const request = userTurnOf(or);

      assert.match(card, /^🎲 Искра\n[^\n]+: .+\n/);
      assert.match(card, /\nПриём «.+»: /);
      assert.equal(answer, "Три идеи по искре");
      assert.match(request, /Выпавшее уже показано человеку/);

      for (const line of card.split("\n").filter((entry) => /^[^\n«]+: /.test(entry) && !entry.startsWith("Приём"))) {
        assert.ok(request.includes(line), `в запрос к модели не попало «${line}»`);
      }
    }

    await say(tg, 5108, "/spark про дачу", { count: 2 });
    assert.match(userTurnOf(or), /\nТема: про дачу\n/);
  });
});

test("/techniques перечисляет все приёмы без модели; клавиатура и кнопки: идея, искра, штурм, мои идеи", async () => {
  await withApp({ env: IDEAS }, async ({ tg, or }) => {
    or.chat = () => reply("Ответ модели");

    const [techniques] = await say(tg, 5109, "/techniques");

    for (const { name } of TECHNIQUES) {
      assert.ok(techniques.includes(name), `в списке нет «${name}»`);
    }

    assert.equal(or.chatRequests().length, 0);

    const keyboard = await keyboardOf(tg, 5109);

    for (const label of KEYBOARD_LABELS) {
      assert.ok(keyboard.includes(label), `на клавиатуре нет «${label}»`);
    }

    assert.match((await say(tg, 5109, "🧠 Штурм"))[0], /^🧠 Мозговой штурм: напиши тему/);
    assert.match((await say(tg, 5109, "📚 Мои идеи"))[0], /^В банке пока пусто/);
    assert.equal(or.chatRequests().length, 0, "«Штурм» и «Мои идеи» к модели не ходят");

    for (const button of ["🎲 Искра", "💡 Новая идея"]) {
      const [card, answer] = await say(tg, 5109, button, { count: 2 });

      assert.match(card, /^🎲 Искра\n/, button);
      assert.equal(answer, "Ответ модели", button);
    }

    assert.equal(or.chatRequests().length, 2);
  });
});

test("модель недоступна: после /spark человек всё равно видит искру и получает нейтральное сообщение", async () => {
  await withApp({ env: IDEAS }, async ({ tg, or }) => {
    or.chat = () => failure(400, "bad request");

    const [card, error] = await say(tg, 5110, "/spark", { count: 2 });

    assert.match(card, /^🎲 Искра/);
    assert.match(error, /Не получилось получить ответ от ИИ/);
    assert.doesNotMatch(error, /bad request|400/);
  });
});

test("идеи переживают перезапуск бота: общий файл COMPANION_FILE", async () => {
  const shared = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aibot-ideas-")), "store.json");
  const env = { ...IDEAS, COMPANION_FILE: shared };

  await withApp({ env }, async ({ tg, or }) => {
    saveIdea(or, { title: "Переживёт перезапуск", pitch: "Лежит в файле на диске." });
    await say(tg, 5111, "сохрани");
  });

  assert.equal(JSON.parse(fs.readFileSync(shared, "utf8")).ideas["5111:5111"][0].title, "Переживёт перезапуск");

  await withApp({ env }, async ({ tg, or }) => {
    assert.match((await say(tg, 5111, "/ideas"))[0], /Переживёт перезапуск/);
    assert.equal(or.chatRequests().length, 0);
  });
});

test("COMPANION_TOOLS_ENABLED=false: у идей нет функций и банка — нет /ideas и кнопки, но /idea и /spark работают", async () => {
  await withApp({ env: { ...IDEAS, COMPANION_TOOLS_ENABLED: "false" } }, async ({ tg, or }) => {
    or.chat = () => reply("Идеи без функций");

    await tg.waitFor(() => tg.sent("setMyCommands").length >= 1, 6000, "меню команд");

    const commands = JSON.parse(tg.sent("setMyCommands")[0].commands).map((entry) => entry.command);

    assert.ok(["idea", "spark", "brainstorm", "techniques"].every((command) => commands.includes(command)));
    assert.ok(!commands.includes("ideas") && !commands.includes("reminders"), "команд, которым нечем работать, в меню нет");

    assert.deepEqual(await say(tg, 5112, "придумай что-нибудь"), ["Идеи без функций"]);

    const [request] = or.chatRequests();

    assert.equal(request.body.tools, undefined);
    assert.match(request.body.messages[0].content, /Функции в этом запросе: нет ни одной/);
    assert.doesNotMatch(request.body.messages[0].content, /Банк идей:/);

    const [card, answer] = await say(tg, 5112, "/spark", { count: 2 });

    assert.match(card, /^🎲 Искра/);
    assert.equal(answer, "Идеи без функций");

    const keyboard = await keyboardOf(tg, 5112);

    assert.ok(!keyboard.includes("📚 Мои идеи"));
    assert.ok(["💡 Новая идея", "🎲 Искра", "🧠 Штурм"].every((label) => keyboard.includes(label)));
  });
});

test("/style: три характера, по умолчанию помечены идеи; название по-русски в любом регистре", async () => {
  await withApp({ env: IDEAS }, async ({ tg, or }) => {
    or.chat = () => reply("ок");

    const [menu] = await say(tg, 5113, "/style");

    assert.match(menu, /^Сейчас: генератор идей\./);
    assert.match(menu, /\/style идеи - .*\(по умолчанию\)/);
    assert.match(menu, /\/style собеседник - /);
    assert.match(menu, /\/style классика - /);
    assert.doesNotMatch(menu, /собеседник - [^\n]*\(по умолчанию\)/);

    assert.match((await say(tg, 5113, "/status"))[0], /Характер: генератор идей/);
    assert.match((await say(tg, 5113, "/style классика"))[0], /теперь характер: классика/);
    assert.match((await say(tg, 5113, "/style Генератор Идей"))[0], /теперь характер: генератор идей/);
    assert.match((await say(tg, 5113, "/style робот"))[0], /Варианты: идеи, собеседник, классика\./);
  });
});

// The ingredients of a spark card ("Область: …" lines up to the empty line), keyed like the spark object.
const LABEL_KEYS = Object.fromEntries(Object.entries(SPARK_LABELS).map(([key, label]) => [label, key]));

function cardSpark(card) {
  const lines = card.split("\n").slice(1);

  return Object.fromEntries(lines.slice(0, lines.indexOf("")).map((line) => {
    const [label, ...value] = line.split(": ");

    return [LABEL_KEYS[label], value.join(": ")];
  }));
}

const REROLL_HINT = /перекину только это/;
const rerollAsked = (or, reroll) => {
  or.chat = (record) => (lastMessage(record).role === "tool"
    ? reply(JSON.stringify(toolResults(record).at(-1)))
    : toolCalls(["idea_spark", { reroll }]));
};

test("искру с карточки можно поменять в разговоре: модель перебрасывает только поворот, остальное и приём — с карточки", async () => {
  await withApp({ env: IDEAS }, async ({ tg, or }) => {
    or.chat = () => reply("Три идеи по искре");

    const [card] = await say(tg, 5114, "/spark", { count: 2 });
    const shown = cardSpark(card);

    assert.match(card, REROLL_HINT, "карточка подсказывает, что можно поменять часть");
    assert.ok(Object.keys(shown).length >= 2 && Object.values(shown).every(Boolean), card);

    rerollAsked(or, ["twist"]);

    const result = JSON.parse((await say(tg, 5114, "поменяй поворот"))[0]);
    const [spark] = result.sparks;

    assert.equal(result.ok, true);

    for (const [key, value] of Object.entries(shown)) {
      if (key !== "twist") {
        assert.equal(spark[key], value, `${key} должен остаться с карточки`);
      }
    }

    assert.ok(spark.twist && spark.twist !== shown.twist, "поворот новый");
    // A technique name may hold quotes of its own («Пять «почему»»), so the whole card line is compared.
    assert.ok(card.includes(`\nПриём «${result.technique.name}»: `), "приём прежний");
  });
});

test("подсказка «перекину только это» — только там, где модель правда умеет: у собеседника и без функций её нет", async () => {
  await withApp({ env: IDEAS }, async ({ tg, or }) => {
    or.chat = () => reply("ок");

    assert.match((await say(tg, 5115, "/spark", { count: 2 }))[0], REROLL_HINT);
    await say(tg, 5115, "/style собеседник");
    assert.doesNotMatch((await say(tg, 5115, "/spark", { count: 2 }))[0], REROLL_HINT);
  });

  await withApp({ env: { ...IDEAS, COMPANION_TOOLS_ENABLED: "false" } }, async ({ tg, or }) => {
    or.chat = () => reply("ок");

    assert.doesNotMatch((await say(tg, 5116, "/spark", { count: 2 }))[0], REROLL_HINT);
  });
});

test("/reset забывает и недавние искры: после очистки перебрасывать нечего, модель получает отказ с подсказкой", async () => {
  await withApp({ env: IDEAS }, async ({ tg, or }) => {
    or.chat = () => reply("ок");
    await say(tg, 5117, "/spark", { count: 2 });
    assert.match((await say(tg, 5117, "/reset"))[0], /Память этого чата очищена/);

    rerollAsked(or, ["twist"]);

    const result = JSON.parse((await say(tg, 5117, "поменяй поворот"))[0]);

    assert.deepEqual([result.ok, result.error], [false, "no_previous_spark"]);
    assert.match(result.hint, /idea_spark without reroll/);
  });
});

test("/ideas del понимает код, скопированный из списка с решёткой и в верхнем регистре", async () => {
  await withApp({ env: IDEAS }, async ({ tg, or, app }) => {
    saveIdea(or, { title: "Удалю по коду", pitch: "Код скопирую прямо из списка." });
    await say(tg, 5118, "сохрани");

    const [{ id }] = readStore(app).ideas["5118:5118"];

    assert.equal((await say(tg, 5118, `/ideas del #${id.toUpperCase()}`))[0], "Идея удалена.");
    assert.equal(readStore(app).ideas["5118:5118"], undefined);
  });
});
