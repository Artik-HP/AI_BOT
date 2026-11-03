process.env.LOG_LEVEL = "silent";

const test = require("node:test");
const assert = require("node:assert/strict");
const lifecycle = require("../../src/lifecycle");

test.beforeEach(() => lifecycle.resetModules());

test("хуки идут в порядке регистрации, синхронные и асинхронные вперемешку; необязательные пропускаются", async () => {
  const calls = [];

  lifecycle.registerModule("first", { forgetChat: (chatId) => { calls.push(`first:${chatId}`); } });
  lifecycle.registerModule("silent", {});
  lifecycle.registerModule("second", {
    forgetChat: async (chatId) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      calls.push(`second:${chatId}`);
    }
  });
  lifecycle.registerModule("third", { forgetChat: (chatId) => { calls.push(`third:${chatId}`); } });

  assert.deepEqual(await lifecycle.forgetChat(42), { failed: [] });
  assert.deepEqual(calls, ["first:42", "second:42", "third:42"]);
});

test("ошибка хука не останавливает остальные и не выходит наружу: вызывающий получает список не справившихся", async () => {
  const calls = [];

  lifecycle.registerModule("broken", { revokeUser: () => { throw new Error("секретный текст сообщения"); } });
  lifecycle.registerModule("rejecting", { revokeUser: async () => { throw new Error("LAB_STORE_LOCKED"); } });
  lifecycle.registerModule("fine", { revokeUser: (userId) => { calls.push(userId); } });

  assert.deepEqual(await lifecycle.revokeUser(7), { failed: ["broken", "rejecting"] });
  assert.deepEqual(calls, [7]);
});

test("statusLines собирает строки модулей по порядку; модуль, который не ответил, просто не даёт строки", async () => {
  lifecycle.registerModule("bank", { statusLines: ({ userId }) => `Банк идей: ${userId}` });
  lifecycle.registerModule("none", { statusLines: () => null });
  lifecycle.registerModule("broken", { statusLines: () => { throw new Error("down"); } });
  lifecycle.registerModule("lab", { statusLines: async ({ isPrivate }) => (isPrivate ? ["Лаборатория: 1", "Ещё строка"] : []) });

  assert.deepEqual(await lifecycle.statusLines({ chatId: 1, userId: 1, isPrivate: true }), {
    lines: ["Банк идей: 1", "Лаборатория: 1", "Ещё строка"],
    failed: ["broken"]
  });
  assert.deepEqual((await lifecycle.statusLines({ chatId: -5, userId: 1, isPrivate: false })).lines, ["Банк идей: 1"]);
});

test("exportData — объект «модуль → данные»; модуль без данных не попадает в файл", async () => {
  lifecycle.registerModule("ideas", { exportData: async ({ userId }) => ({ owner: userId }) });
  lifecycle.registerModule("empty", { exportData: () => undefined });
  lifecycle.registerModule("broken", { exportData: () => { throw new Error("down"); } });

  assert.deepEqual(await lifecycle.exportData({ userId: 3 }), { data: { ideas: { owner: 3 } }, failed: ["broken"] });
});

test("повторное имя, неизвестный хук и не функция — ошибка программиста при старте; resetModules очищает реестр", async () => {
  lifecycle.registerModule("menu", { revokeUser() {} });

  assert.throws(() => lifecycle.registerModule("menu", {}), /LIFECYCLE_DUPLICATE_MODULE/);
  assert.throws(() => lifecycle.registerModule("typo", { revokeUsers() {} }), /LIFECYCLE_UNKNOWN_HOOK/);
  assert.throws(() => lifecycle.registerModule("wrong", { forgetChat: "not a function" }), /LIFECYCLE_HOOK_NOT_A_FUNCTION/);
  assert.throws(() => lifecycle.registerModule("", {}), /LIFECYCLE_NAME_REQUIRED/);
  assert.deepEqual(lifecycle.moduleNames(), ["menu"]);

  lifecycle.resetModules();
  assert.deepEqual(lifecycle.moduleNames(), []);
  assert.doesNotThrow(() => lifecycle.registerModule("menu", {}));
  assert.deepEqual(await lifecycle.revokeUser(1), { failed: [] });
});
