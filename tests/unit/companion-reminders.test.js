process.env.LOG_LEVEL = "silent";

const test = require("node:test");
const assert = require("node:assert/strict");
const { CompanionStore } = require("../../src/companion/store");
const { cancelReminders, createAccessCheck, createReminderScheduler, formatReminder, listReminders, setDaily, cancelDaily, dailyOf } = require("../../src/companion/reminders");
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

test("D4: асинхронная проверка допуска — «да» отправляет, «нет» снимает без отправки, сбой ждёт следующего такта", async () => {
  const world = createWorld();
  const { sent, send } = recorder();
  const warnings = [];
  let verdict = async () => { throw new Error("database is down"); };
  const scheduler = createReminderScheduler({ store: world.store, send, isAllowed: (userId) => verdict(userId), warn: (text) => warnings.push(text) });
  const reminders = () => world.store.view((data) => data.reminders);

  remind(world.ctxFor("9"), "дело", 1);
  remind(world.ctxFor("10"), "другое дело", 1);

  assert.equal(await scheduler.tick(START + 2 * MINUTE), 0);
  assert.equal(await scheduler.tick(START + 2 * MINUTE + 1000), 0);
  assert.deepEqual(sent, [], "пока база недоступна, ничего не уходит");
  assert.deepEqual(reminders().map((item) => item.tries), [0, 0], "напоминания ждут, попытки не тратятся");
  assert.equal(warnings.length, 1, "о недоступности базы — не чаще раза в минуту");
  assert.ok(warnings.every((text) => !text.includes("дело")), "текст напоминания в лог не попадает");

  verdict = async () => null;
  await scheduler.tick(START + 3 * MINUTE + 1000);
  assert.equal(warnings.length, 2, "«неизвестно» — то же, что сбой; через минуту — новая запись");
  assert.equal(reminders().length, 2);

  verdict = async (userId) => userId === "9";
  assert.equal(await scheduler.tick(START + 4 * MINUTE), 1);
  assert.deepEqual(sent, [["9", "⏰ Напоминание: дело"]]);
  assert.deepEqual(reminders(), [], "заблокированному не отправлено, напоминание снято");
});

test("D4: проверка допуска при доставке — allow-list, затем строка в учёте; нет строки — можно; сбой базы — неизвестно", async () => {
  const NOW = Date.UTC(2026, 10, 2, 12);
  const rows = {
    1: { status: "active", until: null },
    2: { status: "blocked", until: null },
    3: { status: "active", until: new Date(NOW - 1000).toISOString() },
    4: { status: "active", until: new Date(NOW + 60000).toISOString() }
  };
  const database = () => ({ account: async (userId) => rows[userId] || null });
  const check = createAccessCheck({ allowed: (userId) => userId !== "5", database, now: () => NOW });

  assert.deepEqual(await Promise.all(["1", "2", "3", "4", "5", "6"].map(check)), [true, false, false, true, false, true]);
  assert.equal(await createAccessCheck({ allowed: () => true, database: () => null })("2"), true, "без DATABASE_URL — как раньше");
  assert.equal(await createAccessCheck({ allowed: () => true, database: () => ({ account: async () => { throw new Error("down"); } }) })("1"), null);
  assert.equal(await createAccessCheck({ allowed: () => true, database: () => { throw new Error("DATABASE_URL_INVALID"); } })("1"), null);
});

test("Искра дня: в своё время и раз в сутки, переживает перезапуск без пачки пропущенных; «неизвестно» ждёт, заблокированному выключается", async () => {
  const world = createWorld();
  const delivered = [];
  let verdict = async () => true;
  const day = (date, hours, minutes = 0) => Date.UTC(2026, 0, date, hours, minutes);
  const make = (store) => createReminderScheduler({ store, send: async () => {}, deliverDaily: async (entry) => { delivered.push(entry.userId); }, isAllowed: (id) => verdict(id) });
  const scheduler = make(world.store);

  assert.equal(setDaily(world.store, { chatId: "9", userId: "9", time: "09:00", timeZone: "" }, day(15, 8)).nextAt, day(15, 9));
  assert.equal(await scheduler.tick(day(15, 8, 59)), 0);
  assert.equal(await scheduler.tick(day(15, 9)), 1);
  assert.equal(await scheduler.tick(day(15, 9, 30)), 0, "второй раз за день — нет");
  assert.equal(dailyOf(world.store, "9").nextAt, day(16, 9));

  // A new process: the entry is read back from the file.
  const reopened = new CompanionStore(world.file);
  const restarted = make(reopened);

  assert.equal(await restarted.tick(day(18, 10)), 1, "бот три дня молчал — одна искра, а не три");
  assert.equal(dailyOf(reopened, "9").nextAt, day(19, 9));
  assert.deepEqual(delivered, ["9", "9"]);

  verdict = async () => null;
  assert.equal(await restarted.tick(day(19, 9)), 0);
  assert.equal(dailyOf(reopened, "9").nextAt, day(19, 9), "база недоступна — запись ждёт");

  verdict = async () => false;
  await restarted.tick(day(19, 9, 1));
  assert.equal(dailyOf(reopened, "9"), null, "заблокированному искра выключена");
  assert.equal(cancelDaily(reopened, "9"), false);
});

test("Искра дня: сбой отправки — повтор через минуту, после трёх неудач — на следующий день; без deliverDaily записи не трогаются", async () => {
  const world = createWorld();
  let attempts = 0;
  const failing = createReminderScheduler({ store: world.store, send: async () => {}, deliverDaily: async () => { attempts += 1; throw new Error("blocked by the user"); } });
  const nine = Date.UTC(2026, 0, 15, 9, 0);

  setDaily(world.store, { chatId: "7", userId: "7", time: "09:00", timeZone: "Europe/Kyiv" }, Date.UTC(2026, 0, 15, 6, 0));
  assert.equal(dailyOf(world.store, "7").nextAt, Date.UTC(2026, 0, 15, 7, 0), "09:00 по Киеву зимой — 07:00 UTC");

  await createReminderScheduler({ store: world.store, send: async () => {} }).tick(nine);
  assert.equal(dailyOf(world.store, "7").nextAt, Date.UTC(2026, 0, 15, 7, 0), "планировщик без deliverDaily искру не трогает");

  await failing.tick(nine);
  assert.deepEqual([attempts, dailyOf(world.store, "7").nextAt, dailyOf(world.store, "7").tries], [1, nine + MINUTE, 1]);
  await failing.tick(nine + MINUTE);
  await failing.tick(nine + 2 * MINUTE);
  assert.equal(attempts, 3);
  assert.deepEqual([dailyOf(world.store, "7").nextAt, dailyOf(world.store, "7").tries], [Date.UTC(2026, 0, 16, 7, 0), 0]);
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
