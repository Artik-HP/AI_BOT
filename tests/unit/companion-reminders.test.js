process.env.LOG_LEVEL = "silent";

const test = require("node:test");
const assert = require("node:assert/strict");
const { CompanionStore } = require("../../src/companion/store");
const { cancelReminders, createReminderScheduler, formatReminder, listReminders } = require("../../src/companion/reminders");
const { executeTool } = require("../../src/companion/tools");
const { START, createWorld } = require("../helpers/companionFixtures");

const MINUTE = 60000;
const remind = (ctx, text, minutes) => executeTool("reminder_create", { text, in_minutes: minutes }, ctx);

function recorder() {
  const sent = [];
  return { sent, send: async (chatId, text) => { sent.push([chatId, text]); } };
}

test("планировщик отправляет только наступившие напоминания и только один раз", async () => {
  const world = createWorld();
  const ctx = world.ctxFor("1", "1");
  const { sent, send } = recorder();
  const scheduler = createReminderScheduler({ store: world.store, send });

  remind(ctx, "выпить воды", 5);
  remind(ctx, "позвонить маме", 60);

  assert.equal(await scheduler.tick(START + 4 * MINUTE), 0);
  assert.equal(await scheduler.tick(START + 6 * MINUTE), 1);
  assert.deepEqual(sent, [["1", "⏰ Напоминание: выпить воды"]]);
  assert.equal(await scheduler.tick(START + 6 * MINUTE), 0, "повторно не отправляется");
  assert.equal(await scheduler.tick(START + 61 * MINUTE), 1);
  assert.equal(sent.length, 2);
  assert.deepEqual(world.store.view((data) => data.reminders), []);
});

test("в группе напоминание обращается по имени", async () => {
  const world = createWorld();
  const { sent, send } = recorder();

  remind(world.ctxFor("7", "-5", { isGroup: true }), "созвон", 1);
  await createReminderScheduler({ store: world.store, send }).tick(START + 2 * MINUTE);
  assert.deepEqual(sent, [["-5", "⏰ Вася, напоминание: созвон"]]);
  assert.equal(formatReminder({ group: false, name: "Вася", text: "дело" }), "⏰ Напоминание: дело");
});

test("сбой отправки: до трёх попыток с паузой в минуту, затем напоминание снимается", async () => {
  const world = createWorld();
  let attempts = 0;
  const scheduler = createReminderScheduler({
    store: world.store,
    send: async () => {
      attempts += 1;
      throw new Error("bot was blocked by the user");
    }
  });
  const due = START + 2 * MINUTE;

  remind(world.ctxFor(), "дело", 1);
  assert.equal(await scheduler.tick(due), 0);
  assert.equal(world.store.view((data) => data.reminders[0].tries), 1);
  assert.equal(world.store.view((data) => data.reminders[0].dueAt), due + MINUTE);
  assert.equal(await scheduler.tick(due + 30000), 0);
  assert.equal(attempts, 1, "до истечения паузы повтора нет");
  await scheduler.tick(due + MINUTE);
  await scheduler.tick(due + 2 * MINUTE);
  assert.equal(attempts, 3);
  assert.deepEqual(world.store.view((data) => data.reminders), [], "после третьей неудачи напоминание снято");
});

test("человек, которому доступ закрыт, ничего не получает, напоминание снимается", async () => {
  const world = createWorld();
  const { sent, send } = recorder();

  remind(world.ctxFor("9"), "дело", 1);
  await createReminderScheduler({ store: world.store, send, isAllowed: () => false }).tick(START + 2 * MINUTE);
  assert.deepEqual(sent, []);
  assert.deepEqual(world.store.view((data) => data.reminders), []);
});

test("напоминания переживают перезапуск: новый процесс читает файл и доставляет", async () => {
  const world = createWorld();
  const { sent, send } = recorder();

  remind(world.ctxFor("5"), "после перезапуска", 10);

  const reopened = new CompanionStore(world.file);

  await createReminderScheduler({ store: reopened, send }).tick(START + 11 * MINUTE);
  assert.deepEqual(sent, [["5", "⏰ Напоминание: после перезапуска"]]);
});

test("два тика одновременно не отправляют одно и то же дважды", async () => {
  const world = createWorld();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const sent = [];
  const scheduler = createReminderScheduler({ store: world.store, send: async (chatId, text) => { await gate; sent.push([chatId, text]); } });

  remind(world.ctxFor("5"), "дело", 1);

  const first = scheduler.tick(START + 2 * MINUTE);
  const second = await scheduler.tick(START + 2 * MINUTE);

  release();
  assert.equal(second, 0);
  assert.equal(await first, 1);
  assert.equal(sent.length, 1);
});

test("список и отмена: только свои напоминания в этом чате", () => {
  const world = createWorld();
  const mine = world.ctxFor("1", "-5");

  remind(mine, "позже", 30);
  const early = remind(mine, "скоро", 5);

  remind(mine, "ещё позже", 90);
  remind(world.ctxFor("2", "-5"), "чужое", 5);
  remind(world.ctxFor("1", "-6"), "в другом чате", 5);

  assert.deepEqual(listReminders(world.store, "-5", "1").map((item) => item.text), ["скоро", "позже", "ещё позже"]);
  assert.equal(cancelReminders(world.store, "-5", "1", "ffffffff"), 0);
  assert.equal(cancelReminders(world.store, "-5", "1", early.id), 1);
  assert.equal(cancelReminders(world.store, "-5", "1"), 2);
  assert.deepEqual(listReminders(world.store, "-5", "2").map((item) => item.text), ["чужое"]);
  assert.deepEqual(listReminders(world.store, "-6", "1").map((item) => item.text), ["в другом чате"]);
});
