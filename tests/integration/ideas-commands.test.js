const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { withApp } = require("../helpers/app");
const { reply } = require("../helpers/fakeOpenRouter");
const { emptyData } = require("../../src/companion/store");
const { IDEAS, callsThen, toolCalls, toolResults, readStore, userTurnOf, say } = require("../helpers/ideasChat");

const BASE = Date.UTC(2026, 10, 1, 9);

// A companion file with a ready idea bank: the bot opens the store lazily, so a file written before it starts is read
// as the person's bank. Idea n is n minutes newer than idea n - 1, so the newest-first order is known.
function seededBank(scope, statuses) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aibot-bank-")), "store.json");
  const ideas = statuses.map((status, index) => {
    const n = index + 1;

    return { id: String(n).padStart(8, "0"), title: `Идея ${n}`, pitch: `Суть идеи номер ${n}.`, tags: [], next: "", status, createdAt: BASE + n * 60000, updatedAt: BASE + n * 60000 };
  });

  fs.writeFileSync(file, JSON.stringify({ ...emptyData(), ideas: { [scope]: ideas } }));
  return file;
}

// Ideas 1-3 are being worked on, 4-5 are done, 6 is parked, 7-25 are new.
const STATUSES = [...Array(3).fill("exploring"), "done", "done", "parked", ...Array(19).fill("new")];
const shownTitles = (text) => [...text.matchAll(/ · (Идея \d+)/g)].map((match) => match[1]);
const range = (from, to) => Array.from({ length: Math.abs(to - from) + 1 }, (_, i) => `Идея ${from > to ? from - i : from + i}`);

test("U1: /ideas — страницы по 10, «Дальше: /ideas 2», фильтр по статусу словами и кодами, их сочетание", async () => {
  const file = seededBank("5401:5401", STATUSES);

  await withApp({ env: { ...IDEAS, COMPANION_FILE: file } }, async ({ tg, or }) => {
    const first = (await say(tg, 5401, "/ideas"))[0];

    assert.match(first, /^📚 Твои идеи \(25\):/);
    assert.deepEqual(shownTitles(first), range(25, 16));
    assert.match(first, /Показаны 1–10 из 25\. Дальше: \/ideas 2/);

    const third = (await say(tg, 5401, "/ideas 3"))[0];

    assert.match(third, /^📚 Твои идеи \(25\) · страница 3 из 3:/);
    assert.deepEqual(shownTitles(third), range(5, 1));
    assert.doesNotMatch(third, /Дальше/);

    const fresh = (await say(tg, 5401, "/ideas новые"))[0];

    assert.match(fresh, /^📚 Твои идеи — новые \(19\):/);
    assert.deepEqual(shownTitles(fresh), range(25, 16));
    assert.match(fresh, /Дальше: \/ideas новые 2/);
    assert.deepEqual(shownTitles((await say(tg, 5401, "/ideas новые 2"))[0]), range(15, 7));

    for (const [argument, expected] of [["в работе", range(3, 1)], ["exploring", range(3, 1)], ["готовые", range(5, 4)], ["готово", range(5, 4)],
      ["DONE", range(5, 4)], ["отложены", ["Идея 6"]], ["отложенные", ["Идея 6"]], ["parked", ["Идея 6"]], ["new 2", range(15, 7)]]) {
      const [text] = await say(tg, 5401, `/ideas ${argument}`);

      assert.deepEqual(shownTitles(text), expected, argument);
      assert.doesNotMatch(text, /Дальше/, argument);
    }

    assert.match((await say(tg, 5401, "/ideas в работе"))[0], /^📚 Твои идеи — в работе \(3\):/);
    assert.match((await say(tg, 5401, "/ideas 9"))[0], /^На странице 9 ничего нет: всего страниц 3\. Первая: \/ideas$/m);
    assert.match((await say(tg, 5401, "/ideas в работе 2"))[0], /^На странице 2 ничего нет: всего страниц 1\. Первая: \/ideas в работе$/m);

    const searched = (await say(tg, 5401, "/ideas идея 2"))[0];

    assert.match(searched, /^📚 Нашлось 25 из 25 · страница 2 из 3:/, "слова и страница вместе");
    assert.match(searched, /Дальше: \/ideas идея 3/);
    assert.match((await say(tg, 5401, "/ideas в работе номер"))[0], /^📚 Нашлось 3 из 3 \(в работе\):/);
    assert.match((await say(tg, 5401, "/ideas в работе номер 3"))[0], /^На странице 3 ничего нет/, "последнее число — всегда страница");
    assert.equal(or.chatRequests().length, 0, "/ideas не ходит к модели");
  });
});

test("U1: статус без идей и пустой банк — понятные ответы; прежний поиск словами не изменился", async () => {
  const file = seededBank("5402:5402", ["new", "new"]);

  await withApp({ env: { ...IDEAS, COMPANION_FILE: file } }, async ({ tg }) => {
    assert.equal((await say(tg, 5402, "/ideas готово"))[0], "Идей со статусом «готово» нет. Всего идей: 2. Показать все: /ideas");
    assert.match((await say(tg, 5402, "/ideas номер"))[0], /^📚 Нашлось 2 из 2:/, "поиск словами — как раньше");
    assert.match((await say(tg, 5402, "/ideas номер 2"))[0], /^На странице 2 ничего нет: всего страниц 1\. Первая: \/ideas номер$/m);
    assert.match((await say(tg, 5402, "/ideas 1"))[0], /^📚 Твои идеи \(2\):/, "страница 1 — то же, что без номера");
    assert.match((await say(tg, 5403, "/ideas в работе"))[0], /^В банке пока пусто/);
  });
});

test("U3: BOT_TIMEZONE — /reminders и /status показывают местное время с названием пояса; без пояса — прежний UTC", async () => {
  await withApp({ env: { ...IDEAS, BOT_TIMEZONE: "Europe/Kyiv" } }, async ({ tg, or }) => {
    callsThen(or, [["reminder_create", { text: "позвонить маме", in_minutes: 90 }]], "Напомню");
    await say(tg, 5405, "напомни через полтора часа");

    const [list] = await say(tg, 5405, "/reminders");

    assert.match(list, /\n\d{4}-\d{2}-\d{2} \d{2}:\d{2} Europe\/Kyiv - позвонить маме \(код [0-9a-f]{8}\)\n/);
    assert.match((await say(tg, 5405, "/status"))[0], /\nНапоминаний: 1, ближайшее \d{4}-\d{2}-\d{2} \d{2}:\d{2} Europe\/Kyiv\n/);
    assert.match(or.chatRequests()[0].body.messages[0].content, /\nСейчас: [^\n]+ UTC, [^\n;]+; по поясу бота Europe\/Kyiv \(UTC\+0[23]:00\): /);
  });
});

test("L1: модель сохраняет идею и ставит напоминание с её кодом — /reminders и /ideas показывают связь, удаление идеи снимает напоминание", async () => {
  await withApp({ env: IDEAS }, async ({ tg, or, app }) => {
    or.chat = (record) => {
      const results = toolResults(record);

      if (!results.length) return toolCalls(["idea_save", { title: "Кофейня-библиотека", pitch: "Читаешь книгу — платишь меньше за кофе.", next_step: "Поговорить с хозяином" }]);
      if (results.length === 1) return toolCalls(["reminder_create", { text: "сделать первый шаг", in_minutes: 120, idea_id: `#${results[0].id.toUpperCase()}` }]);
      return reply(JSON.stringify(results.at(-1)));
    };

    const created = JSON.parse((await say(tg, 5406, "сохрани и напомни через два часа"))[0]);
    const [{ id }] = readStore(app).ideas["5406:5406"];

    assert.deepEqual([created.ok, created.idea_id], [true, id]);
    assert.match((await say(tg, 5406, "/reminders"))[0], new RegExp(`UTC - сделать первый шаг \\(код [0-9a-f]{8}\\) \\(идея ${id}\\)\\n`));
    assert.match((await say(tg, 5406, "/ideas"))[0], /\nШаг: Поговорить с хозяином\n⏰ \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\n/);
    assert.equal((await say(tg, 5406, `/ideas del ${id}`))[0], "Идея удалена. Отменено напоминаний о ней: 1.");
    assert.match((await say(tg, 5406, "/reminders"))[0], /^Напоминаний нет/);
  });
});

test("U2: /spark понимает форму — «конкретнее» даёт четыре строки с «Для кого», «проще» и «свободнее» — две, остальное тема", async () => {
  await withApp({ env: IDEAS }, async ({ tg, or }) => {
    or.chat = () => reply("идеи");

    const ingredientLines = (card) => card.split("\n").slice(1, card.split("\n").indexOf(""));
    const [maximal] = await say(tg, 5404, "/spark конкретнее", { count: 2 });

    assert.equal(ingredientLines(maximal).length, 4, maximal);
    assert.ok(ingredientLines(maximal).some((line) => line.startsWith("Для кого: ")));
    assert.doesNotMatch(userTurnOf(or), /Тема:/, "слово формы — не тема");

    const [minimal] = await say(tg, 5404, "/spark проще кофейня", { count: 2 });

    assert.deepEqual(ingredientLines(minimal).map((line) => line.split(":")[0]), ["Область", "Поворот"]);
    assert.match(userTurnOf(or), /\nТема: кофейня\n/);

    const [free] = await say(tg, 5404, "/spark Свободнее", { count: 2 });

    assert.equal(ingredientLines(free).length, 2);

    await say(tg, 5404, "/idea проще");
    assert.equal(userTurnOf(or), "Придумай идеи по теме: проще", "у /idea любое слово — тема");

    await say(tg, 5404, "/spark конкретный план", { count: 2 });
    assert.match(userTurnOf(or), /\nТема: конкретный план\n/, "только точные слова формы");
  });
});
