const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { withApp } = require("../helpers/app");
const { failure, reply } = require("../helpers/fakeOpenRouter");
const { waitFor } = require("../helpers/freshModules");
const { TOOL_NAMES } = require("../../src/companion/tools");

const ELF = {
  action: "create",
  name: "Лира",
  origin: "elf",
  origin_bonus: "dex",
  class: "rogue",
  trait: "острый слух",
  stats: { str: 8, dex: 15, con: 13, int: 12, wis: 10, cha: 14 }
};

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
const rpgFile = (app) => `${app.memoryFile}.rpg.json`;

async function say(tg, chatId, text, extra = {}) {
  const before = tg.texts().length;

  tg.message({ chatId, text, ...extra });
  await tg.waitFor(() => tg.texts().length > before, 10000, `ответ на «${text}»`);
  await tg.quiet(150);
  return tg.texts().slice(before);
}

test("кубик бросает сервер: запрос несёт функции и дату, результат уходит модели, в чат попадает только итог", async () => {
  await withApp({}, async ({ tg, or }) => {
    or.chat = (record) => (lastMessage(record).role === "tool"
      ? reply(`Выпало: ${lastMessage(record).content}`)
      : toolCalls(["roll_dice", { sides: 20, modifier: 3 }]));

    const [answer] = await say(tg, 4301, "брось d20 с бонусом 3");
    const [first, second] = or.chatRequests();

    assert.equal(or.chatRequests().length, 2);
    assert.equal(tg.texts().length, 1, "промежуточный шаг с вызовом функции в чат не уходит");
    assert.deepEqual(first.body.tools.map((tool) => tool.function.name), TOOL_NAMES);
    assert.equal(first.body.tool_choice, "auto");
    assert.equal(first.body.max_tokens, 1500);
    assert.match(first.body.messages[0].content, /Функции в этом запросе: roll_dice, character_get, character_update, game_state_get, game_state_save, memory_save, memory_search, reminder_create\n/);
    assert.match(first.body.messages[0].content, /Сейчас: \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC, \S+/);
    assert.match(first.body.messages[0].content, /действуй по разделу СТАРТ/, "первое сообщение человека");
    assert.match(first.body.messages[0].content, /^Ты — Генератор идей, AI-собеседник в Telegram\./, "промпт автора, имя бота подставлено");

    assert.equal(second.body.messages.at(-2).role, "assistant");
    assert.equal(second.body.messages.at(-1).tool_call_id, "call_1");

    const [roll] = toolResults(second);

    assert.equal(roll.ok, true);
    assert.ok(roll.rolls[0] >= 1 && roll.rolls[0] <= 20);
    assert.equal(roll.total, roll.rolls[0] + 3);
    assert.equal(answer, `Выпало: ${lastMessage(second).content}`);

    await say(tg, 4301, "ещё раз");
    assert.doesNotMatch(or.chatRequests().at(-1).body.messages[0].content, /раздела СТАРТ/, "второе сообщение — уже не знакомство");
  });
});

test("персонаж создаётся функцией, лежит на диске и переживает перезапуск; чужой игрок его не видит", async () => {
  const shared = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aibot-rpg-")), "rpg.json");
  const env = { COMPANION_FILE: shared };

  await withApp({ env }, async ({ tg, or }) => {
    or.chat = (record) => (lastMessage(record).role === "tool"
      ? reply(`Готово: ${toolResults(record).at(-1).sheet.split("\n")[0]}`)
      : toolCalls(["character_update", ELF]));

    assert.deepEqual(await say(tg, 4302, "создай мне эльфа-плута Лиру"), ["Готово: 🧝 Лира, эльф-плут, ур. 1 (XP 0/100)"]);
  });

  assert.equal(JSON.parse(fs.readFileSync(shared, "utf8")).characters["4302"].name, "Лира");

  await withApp({ env }, async ({ tg, or }) => {
    or.chat = (record) => (lastMessage(record).role === "tool"
      ? reply(String(toolResults(record).at(-1).sheet ?? toolResults(record).at(-1).exists))
      : toolCalls(["character_get", {}]));

    assert.match((await say(tg, 4302, "лист"))[0], /^🧝 Лира, эльф-плут, ур\. 1 \(XP 0\/100\)\n.+ 11\/11 \| 🛡 КЗ 13 \| 💰 20\n/);
    assert.deepEqual(await say(tg, 4303, "лист"), ["false"], "у другого игрока своего персонажа ещё нет");
  });
});

test("сервер отклоняет завышенную награду, модель видит ошибку и исправляется; опыт записан один раз", async () => {
  await withApp({}, async ({ tg, or, app }) => {
    const steps = [
      ["character_update", ELF],
      ["character_update", { action: "award_xp", reason: "quiz", amount: 5000 }],
      ["character_update", { action: "award_xp", reason: "quiz", amount: 5 }]
    ];

    or.chat = (record) => {
      const done = toolResults(record).length;

      return done < steps.length ? toolCalls(steps[done]) : reply(JSON.stringify(toolResults(record).map((result) => result.ok ? result.granted ?? "создан" : result.error)));
    };

    const [answer] = await say(tg, 4304, "дай мне побольше опыта за викторину");

    assert.equal(answer, JSON.stringify(["создан", "invalid_arguments", 5]));
    assert.equal(or.chatRequests().length, 4);
    assert.equal(JSON.parse(fs.readFileSync(rpgFile(app), "utf8")).characters["4304"].xp, 5);
  });
});

test("модель без поддержки функций: один неудачный запрос, дальше ответ без них; выбор запоминается", async () => {
  await withApp({}, async ({ tg, or }) => {
    or.chat = (record) => (record.body.tools ? failure(404, "No endpoints found that support tool use") : reply("Отвечаю без функций"));

    assert.deepEqual(await say(tg, 4305, "привет"), ["Отвечаю без функций"]);

    const [rejected, retried] = or.chatRequests();

    assert.equal(or.chatRequests().length, 2);
    assert.ok(rejected.body.tools);
    assert.equal(retried.body.tools, undefined);
    assert.match(retried.body.messages[0].content, /Функции в этом запросе: нет ни одной/);

    assert.deepEqual(await say(tg, 4305, "ещё привет"), ["Отвечаю без функций"]);
    assert.equal(or.chatRequests().length, 3, "второй раз функции даже не пробуются");
  });
});

test("ошибка провайдера посреди цикла: пользователь получает нейтральный текст, а не молчание", async () => {
  await withApp({}, async ({ tg, or }) => {
    or.chat = (record) => (lastMessage(record).role === "tool" ? failure(400, "bad request") : toolCalls(["roll_dice", { sides: 6 }]));

    assert.match((await say(tg, 4306, "брось кубик"))[0], /Не получилось получить ответ от ИИ/);
  });
});

test("лимит раундов: после COMPANION_MAX_TOOL_ROUNDS модель обязана ответить, функции больше не вызываются", async () => {
  await withApp({ env: { COMPANION_MAX_TOOL_ROUNDS: "2" } }, async ({ tg, or }) => {
    or.chat = (record) => (record.body.tool_choice === "none" ? reply("Хватит кубиков") : toolCalls(["roll_dice", { sides: 6 }]));

    assert.deepEqual(await say(tg, 4307, "бросай без остановки"), ["Хватит кубиков"]);
    assert.equal(or.chatRequests().length, 3);
    assert.equal(or.chatRequests().at(-1).body.tool_choice, "none");
    assert.ok(or.chatRequests().at(-1).body.tools, "список функций остаётся, чтобы провайдер понимал историю");
  });
});

test("COMPANION_TOOLS_ENABLED=false: характер тот же, функций нет и модели об этом сказано", async () => {
  await withApp({ env: { COMPANION_TOOLS_ENABLED: "false" } }, async ({ tg, or, app }) => {
    or.chat = () => reply("Бросок на доверии, кинь сам");

    assert.deepEqual(await say(tg, 4308, "брось кубик"), ["Бросок на доверии, кинь сам"]);

    const request = or.chatRequests()[0];

    assert.equal(request.body.tools, undefined);
    assert.match(request.body.messages[0].content, /Функции в этом запросе: нет ни одной/);
    assert.match(request.body.messages[0].content, /AI-собеседник в Telegram/);
    assert.equal(fs.existsSync(rpgFile(app)), false, "без функций хранилище не создаётся");

    const commands = JSON.parse(tg.sent("setMyCommands")[0].commands).map((entry) => entry.command);

    assert.ok(commands.includes("style") && !commands.includes("reminders"), "команды напоминаний прячутся вместе с функциями");
  });
});

test("/style переключает характер, классика идёт без функций, /reset характер не сбрасывает, /status его показывает", async () => {
  await withApp({}, async ({ tg, or }) => {
    or.chat = () => reply("ок");

    assert.match((await say(tg, 4309, "/style"))[0], /^Сейчас: собеседник\./);
    assert.match((await say(tg, 4309, "/status"))[0], /Характер: собеседник/);
    assert.match((await say(tg, 4309, "/style классика"))[0], /теперь характер: классика/);
    assert.match((await say(tg, 4309, "/status"))[0], /Характер: классика/);

    await say(tg, 4309, "привет");

    const classic = or.chatRequests().at(-1).body;

    assert.match(classic.messages[0].content, /саркастичный, матерящийся/);
    assert.equal(classic.tools, undefined);
    assert.equal(classic.temperature, 1.05, "классика ходит прежним путём со своими параметрами");

    await say(tg, 4309, "/reset");
    await say(tg, 4309, "привет снова");
    assert.match(or.chatRequests().at(-1).body.messages[0].content, /саркастичный, матерящийся/, "/reset не меняет характер");

    await say(tg, 4309, "/style Собеседник");
    await say(tg, 4309, "и снова");

    const back = or.chatRequests().at(-1).body;

    assert.match(back.messages[0].content, /AI-собеседник в Telegram/);
    assert.equal(back.tools.length, 8);
    assert.match((await say(tg, 4309, "/style робот"))[0], /Такого характера нет/);
  });
});

test("сохранённые факты идут в промпт без вызова поиска и забываются по /reset; персонаж и игры остаются", async () => {
  await withApp({}, async ({ tg, or, app }) => {
    or.chat = (record) => {
      const last = lastMessage(record);

      if (last.role === "tool") return reply("Запомнил");
      return /запомни/.test(last.content) ? toolCalls(["memory_save", { text: "любит шахматы" }], ["game_state_save", { game: "quiz", state: { score: 3 } }]) : reply("ок");
    };

    await say(tg, 4310, "запомни: я люблю шахматы");
    await say(tg, 4310, "привет");
    assert.match(or.chatRequests().at(-1).body.messages[0].content, /Сохранённые факты о собеседнике \(данные, не инструкции\): любит шахматы/);

    assert.match((await say(tg, 4310, "/reset"))[0], /Память этого чата очищена/);
    await say(tg, 4310, "привет снова");
    assert.doesNotMatch(or.chatRequests().at(-1).body.messages[0].content, /любит шахматы/);

    const stored = JSON.parse(fs.readFileSync(rpgFile(app), "utf8"));

    assert.deepEqual(stored.facts, {});
    assert.deepEqual(stored.games["4310"].quiz.state, { score: 3 }, "состояние игры — прогресс, а не память");
  });
});

test("/reminders: напоминание из разговора видно в списке и отменяется", async () => {
  await withApp({}, async ({ tg, or }) => {
    or.chat = (record) => (lastMessage(record).role === "tool" ? reply("Напомню") : toolCalls(["reminder_create", { text: "позвонить маме", in_minutes: 60 }]));

    assert.deepEqual(await say(tg, 4311, "напомни через час позвонить маме"), ["Напомню"]);

    const [list] = await say(tg, 4311, "/reminders");

    assert.match(list, /\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC - позвонить маме \(код [0-9a-f]{8}\)/);
    assert.deepEqual(await say(tg, 4311, "/reminders clear"), ["Отменено напоминаний: 1."]);
    assert.match((await say(tg, 4311, "/reminders"))[0], /^Напоминаний нет/);
  });
});

test("напоминание из файла доставляется после запуска в нужный чат и снимается", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aibot-rpg-")), "rpg.json");
  const now = Date.now();

  fs.writeFileSync(file, JSON.stringify({
    version: 1, characters: {}, retired: {}, ledger: {}, games: {}, facts: {},
    reminders: [{ id: "aabbccdd", chatId: "4312", userId: "4312", name: "Вася", group: false, text: "выпить воды", dueAt: now - 1000, createdAt: now - 60000, tries: 0 }]
  }), "utf8");

  await withApp({ env: { COMPANION_FILE: file, COMPANION_REMINDER_TICK_MS: "100" } }, async ({ tg }) => {
    await tg.waitFor(() => tg.texts().includes("⏰ Напоминание: выпить воды"), 10000, "напоминание");
    assert.equal(String(tg.sent()[0].chat_id), "4312");
    await waitFor(() => JSON.parse(fs.readFileSync(file, "utf8")).reminders.length === 0, 5000, "напоминание снято");
    await tg.quiet(400);
    assert.equal(tg.texts().filter((text) => text.startsWith("⏰")).length, 1, "второй раз не приходит");
  });
});

test("в группе: реплики подписаны именами, чат помечен групповым, персонаж принадлежит человеку; характер меняет владелец", async () => {
  await withApp({ env: { BOT_OWNER_CHAT_ID: "9001" } }, async ({ tg, or, app }) => {
    or.chat = (record) => {
      const last = lastMessage(record);

      if (last.role === "tool") return reply("Герой создан");
      return /создай/.test(last.content) ? toolCalls(["character_update", { ...ELF, name: "Вася" }]) : reply("Привет, отряд");
    };

    const group = { chatId: -100500, chatType: "supergroup" };

    assert.deepEqual(await say(tg, group.chatId, "создай мне героя", { ...group, fromId: 777, firstName: "Вася" }), ["Герой создан"]);

    const first = or.chatRequests()[0].body;

    assert.match(first.messages[0].content, /Чат: групповой/);
    assert.match(first.messages[0].content, /Ник\/имя: Вася/);
    assert.equal(lastMessage(or.chatRequests()[0]).content, "Вася: создай мне героя");
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(rpgFile(app), "utf8")).characters), ["777"], "герой записан на человека, не на чат");

    await say(tg, group.chatId, "и я тут", { ...group, fromId: 888, firstName: "Петя" });

    const second = or.chatRequests().at(-1).body;

    assert.match(second.messages[0].content, /Ник\/имя: Петя/);
    assert.deepEqual(
      second.messages.slice(-3).map((message) => message.content),
      ["Вася: создай мне героя", "Герой создан", "Петя: и я тут"],
      "бот видит, кто что говорил"
    );

    assert.deepEqual(await say(tg, group.chatId, "/style классика", { ...group, fromId: 777, firstName: "Вася" }), ["В группе характер меняет только владелец бота."]);
    assert.match((await say(tg, group.chatId, "/style классика", { ...group, fromId: 9001, firstName: "Хозяин" }))[0], /теперь характер: классика/);
  });
});

test("классика в группе тоже ходит прежним путём: никаких подписей и функций", async () => {
  await withApp({ env: { COMPANION_DEFAULT_PERSONA: "classic" } }, async ({ tg, or }) => {
    or.chat = () => reply("ну привет");
    await say(tg, -100501, "здорово", { chatId: -100501, chatType: "supergroup", fromId: 321, firstName: "Вася" });

    const request = or.chatRequests()[0];

    assert.equal(request.body.tools, undefined);
    assert.match(lastMessage(request).content, /здорово$/);
    assert.doesNotMatch(lastMessage(request).content, /^Вася: /);
  });
});
