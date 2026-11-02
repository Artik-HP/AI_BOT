const test = require("node:test");
const assert = require("node:assert/strict");
const { withApp } = require("../helpers/app");
const { IDEAS, callsThen, say } = require("../helpers/ideasChat");

test("/status: прежние строки на месте, затем строки модулей — банк с разбивкой, напоминания, лаборатория только в личном чате", async () => {
  await withApp({ env: IDEAS }, async ({ tg, or }) => {
    callsThen(or, [
      ["idea_save", { title: "Первая", pitch: "Суть первой идеи." }],
      ["idea_save", { title: "Вторая", pitch: "Суть второй идеи." }],
      ["reminder_create", { text: "позвонить", in_minutes: 60 }]
    ], "Сохранил");
    await say(tg, 5301, "сохрани обе и напомни");

    const [status] = await say(tg, 5301, "/status");
    const lines = status.split("\n");

    assert.equal(lines[0], "Статус:");
    assert.match(status, /\nХарактер: генератор идей\nЛимит аудио: \d+ MB\n/, "прежние строки и их порядок не изменились");
    assert.deepEqual(lines.slice(-3).map((line) => line.replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/, "<время>")), [
      "Банк идей: 2 (новые 2)",
      "Напоминаний: 1, ближайшее <время> UTC",
      "Лаборатория: генераций сегодня 0 из 30, проектов 0"
    ]);

    const [group] = await say(tg, -100530, "/status", { chatType: "supergroup", fromId: 5301 });

    assert.match(group, /\nБанк идей: 0\nНапоминаний: 0$/, "в группе свои (пустые) банк и напоминания, без лаборатории");
    assert.doesNotMatch(group, /Лаборатория/);
  });
});

test("/status без функций и без лаборатории: строк модулей нет, ответ прежний", async () => {
  await withApp({ env: { ...IDEAS, COMPANION_TOOLS_ENABLED: "false", AI_LAB_ENABLED: "false" } }, async ({ tg }) => {
    const [status] = await say(tg, 5302, "/status");

    assert.match(status, /\nЛимит аудио: \d+ MB$/);
    assert.doesNotMatch(status, /Банк идей|Напоминаний|Лаборатория/);
  });
});
