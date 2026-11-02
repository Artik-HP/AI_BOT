process.env.LOG_LEVEL = "silent";

const test = require("node:test");
const assert = require("node:assert/strict");
const { executeTool } = require("../../src/companion/tools");
const { ERROR_HINTS } = require("../../src/companion/hints");
const { createReminderScheduler, formatReminder, listReminders } = require("../../src/companion/reminders");
const bank = require("../../src/ideas/bank");
const { START, createWorld } = require("../helpers/companionFixtures");

const MINUTE = 60000;
const call = (ctx, name, args) => executeTool(name, JSON.stringify(args), ctx);
const reminders = (world) => world.store.view((data) => data.reminders);
const COFFEE = { title: "Кофейня-библиотека", pitch: "Читаешь книгу — платишь меньше за кофе.", next_step: "Поговорить с хозяином кофейни" };

test("L1: reminder_create с idea_id — код в любом виде; чужая, несуществующая и мусорная идея — idea_not_found с подсказкой, без следов", () => {
  const world = createWorld();
  const me = world.ctxFor("1", "1");
  const { id } = call(me, "idea_save", COFFEE);

  for (const raw of [id, `#${id.toUpperCase()}`, `${id}.`]) {
    const result = call(me, "reminder_create", { text: "сделать первый шаг", in_minutes: 60, idea_id: raw });

    assert.deepEqual([result.ok, result.idea_id], [true, id], raw);
  }

  assert.deepEqual(reminders(world).map((item) => item.ideaId), [id, id, id]);

  for (const [ctx, raw, label] of [[world.ctxFor("2", "1"), id, "другой человек"], [world.ctxFor("1", "9"), id, "другой чат"], [me, "deadbeef", "нет такой"], [me, "кофейня", "не код"]]) {
    const refused = call(ctx, "reminder_create", { text: "не выйдет", in_minutes: 60, idea_id: raw });

    assert.deepEqual([refused.ok, refused.error, refused.hint], [false, "idea_not_found", ERROR_HINTS.idea_not_found], label);
  }

  assert.equal(reminders(world).length, 3, "отказы ничего не записали");

  const plain = call(me, "reminder_create", { text: "без идеи", in_minutes: 30 });

  assert.equal(plain.idea_id, undefined);
  assert.equal(Object.hasOwn(reminders(world).at(-1), "ideaId"), false, "старые записи без поля — как раньше");
});

test("L1: удаление идеи атомарно снимает её напоминания (функция, /ideas del, /ideas clear); статус done их не трогает", () => {
  const world = createWorld();
  const me = world.ctxFor("1", "1");
  const first = call(me, "idea_save", COFFEE).id;
  const second = call(me, "idea_save", { title: "Будильник-вопрос", pitch: "Будит вопросом на пять секунд." }).id;
  const third = call(me, "idea_save", { title: "Обмен книгами", pitch: "Полка во дворе для обмена книгами." }).id;

  call(me, "reminder_create", { text: "шаг 1", in_minutes: 60, idea_id: first });
  call(me, "reminder_create", { text: "шаг 2", in_minutes: 60, idea_id: second });
  call(me, "reminder_create", { text: "шаг 3", in_minutes: 60, idea_id: third });
  call(me, "reminder_create", { text: "просто дело", in_minutes: 60 });
  call(world.ctxFor("2", "1"), "reminder_create", { text: "чужое", in_minutes: 60 });

  assert.equal(call(me, "idea_update", { id: first, status: "done" }).ok, true);
  assert.equal(reminders(world).length, 5, "готовая идея напоминания не теряет");

  const deleted = call(me, "idea_update", { id: first, delete: true });

  assert.deepEqual(deleted, { ok: true, id: first, deleted: true, reminders_cancelled: 1 });
  assert.deepEqual(reminders(world).map((item) => item.text), ["шаг 2", "шаг 3", "просто дело", "чужое"]);

  assert.deepEqual(bank.removeIdeaFor(world.store, "1", "1", second), { ok: true, id: second, deleted: true, reminders_cancelled: 1 });
  assert.deepEqual(reminders(world).map((item) => item.text), ["шаг 3", "просто дело", "чужое"]);

  assert.equal(bank.clearFor(world.store, "1", "1"), 1);
  assert.deepEqual(reminders(world).map((item) => item.text), ["просто дело", "чужое"], "очистка банка снимает напоминания о его идеях");
});

test("L1: отказ записи при удалении не оставляет следов — ни идея, ни её напоминание не пропадают", () => {
  const world = createWorld();
  const me = world.ctxFor("1", "1");
  const { id } = call(me, "idea_save", COFFEE);

  call(me, "reminder_create", { text: "шаг", in_minutes: 60, idea_id: id });
  world.store.maxBytes = 10;

  assert.equal(call(me, "idea_update", { id, delete: true }).error, "storage_full");
  world.store.maxBytes = 5 * 1024 * 1024;
  assert.equal(bank.listFor(world.store, "1", "1").total, 1);
  assert.equal(reminders(world).length, 1);
});

test("L1: доставка — «💡 «название» (код)» и «Шаг: …», пока идея есть; без шага — только название; идеи нет — обычное напоминание", async () => {
  const world = createWorld();
  const me = world.ctxFor("1", "1");
  const sent = [];
  const scheduler = createReminderScheduler({ store: world.store, send: async (chatId, text) => { sent.push(text); } });
  const withStep = call(me, "idea_save", COFFEE).id;
  const noStep = call(me, "idea_save", { title: "Будильник-вопрос", pitch: "Будит вопросом на пять секунд." }).id;

  call(me, "reminder_create", { text: "сделать первый шаг", in_minutes: 1, idea_id: withStep });
  call(me, "reminder_create", { text: "подумать", in_minutes: 2, idea_id: noStep });
  world.store.change((data) => {
    data.reminders.push({ id: "abcdef12", chatId: "1", userId: "1", name: "Вася", group: false, text: "об ушедшей идее", dueAt: START + 3 * MINUTE, createdAt: START, tries: 0, ideaId: "0badc0de" });
    return { ok: true };
  });

  assert.equal(await scheduler.tick(START + 4 * MINUTE), 3);
  assert.deepEqual(sent, [
    `⏰ Напоминание: сделать первый шаг\n💡 «Кофейня-библиотека» (${withStep})\nШаг: Поговорить с хозяином кофейни`,
    `⏰ Напоминание: подумать\n💡 «Будильник-вопрос» (${noStep})`,
    "⏰ Напоминание: об ушедшей идее"
  ]);
  assert.equal(formatReminder({ group: false, text: "дело" }, null), "⏰ Напоминание: дело");
  assert.deepEqual(listReminders(world.store, "1", "1"), []);
});
