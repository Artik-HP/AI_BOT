process.env.LOG_LEVEL = "silent";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { ERROR_HINTS, withHint } = require("../../src/companion/hints");
const { IDEA_PERSONA_TOOLS, executeTool } = require("../../src/companion/tools");
const { comparableText } = require("../../src/utils/text");
const { createWorld } = require("../helpers/companionFixtures");

const SRC = path.join(__dirname, "..", "..", "src");
const call = (ctx, name, args) => executeTool(name, JSON.stringify(args), ctx);

// Codes that never reach the model: "/ideas clear" on an empty bank is answered by the bot itself.
const NOT_FOR_THE_MODEL = new Set(["empty"]);

test("у каждого отказа функций идей, кубика, игр, памяти и напоминаний есть подсказка модели", () => {
  const files = ["ideas/tools.js", "ideas/bank.js", "ideas/spark.js", "companion/tools.js", "companion/reminders.js", "companion/engine.js"];
  const codes = new Set();

  for (const file of files) {
    const source = fs.readFileSync(path.join(SRC, file), "utf8");

    for (const [, code] of source.matchAll(/(?:fail\(|error: )"([a-z0-9_]+)"/g)) {
      codes.add(code);
    }
  }

  assert.ok(codes.size >= 25, `нашлось всего ${codes.size} кодов: поиск по исходникам сломан`);

  const missing = [...codes].filter((code) => !NOT_FOR_THE_MODEL.has(code) && !Object.hasOwn(ERROR_HINTS, code));

  assert.deepEqual(missing, [], "у новых кодов отказа нет подсказки в companion/hints.js");

  for (const [code, hint] of Object.entries(ERROR_HINTS)) {
    assert.ok(hint.length > 10 && hint.length <= 140 && !hint.includes("\n"), `${code}: подсказка — одна короткая строка`);
  }
});

test("withHint: успех и незнакомый код не трогает, своя подсказка функции важнее таблицы, исходный объект не меняется", () => {
  const success = { ok: true, saved: true };
  const own = { ok: false, error: "invalid_id", hint: "своя" };
  const plain = { ok: false, error: "not_found", id: "x" };

  assert.equal(withHint(success), success);
  assert.equal(withHint(own), own);
  assert.deepEqual(withHint({ ok: false, error: "daily_xp_cap_reached", cap: 300 }), { ok: false, error: "daily_xp_cap_reached", cap: 300 });
  assert.deepEqual(withHint(plain), { ok: false, error: "not_found", id: "x", hint: ERROR_HINTS.not_found });
  assert.equal(plain.hint, undefined, "исходный ответ не изменён");
  assert.equal(withHint(undefined), undefined);
});

test("аргументы: null и пустая строка — без аргументов; JSON, завёрнутый в строку ещё раз, разворачивается один раз", () => {
  const world = createWorld();
  const ctx = world.ctxFor();

  for (const raw of ["null", "", "  ", undefined, null]) {
    assert.equal(executeTool("idea_list", raw, ctx).ok, true, JSON.stringify(raw));
  }

  assert.equal(executeTool("idea_save", JSON.stringify(JSON.stringify({ title: "Обёрнутая", pitch: "Аргументы пришли строкой в строке." })), ctx).saved, true);
  assert.equal(executeTool("idea_list", JSON.stringify("просто строка"), ctx).error, "invalid_arguments", "строка без объекта внутри — отказ");
  assert.equal(executeTool("idea_list", JSON.stringify(JSON.stringify(JSON.stringify({}))), ctx).error, "invalid_arguments", "разворачивается только один уровень");
  assert.equal(executeTool("idea_list", "[1, 2]", ctx).error, "invalid_arguments");
  assert.equal(executeTool("idea_list", "{ bad json", ctx).error, "invalid_json");
  assert.equal(executeTool("idea_list", "\"{ bad json\"", ctx).error, "invalid_json");
});

test("все отказы общего слоя приходят с подсказкой: незнакомая функция, плохой JSON, сбой и переполнение хранилища", () => {
  const world = createWorld();
  const ideas = world.ctxFor("1", "1", { allowed: new Set(IDEA_PERSONA_TOOLS) });
  const unknown = call(ideas, "roll_dice", { sides: 6 });

  assert.deepEqual([unknown.error, unknown.hint], ["unknown_tool", ERROR_HINTS.unknown_tool]);
  assert.ok(executeTool("idea_list", "{", ideas).hint, "invalid_json объясняет, каким должен быть ответ");

  const broken = world.ctxFor("1", "1", { store: { view() { throw new Error("disk"); }, change() { throw new Error("disk"); } } });

  assert.deepEqual(call(broken, "idea_list", {}), { ok: false, error: "storage_error", hint: ERROR_HINTS.storage_error });

  const full = world.ctxFor("1", "1", { store: { change() { throw new Error("COMPANION_STORE_SIZE"); } } });

  assert.deepEqual(call(full, "memory_save", { text: "любит чай" }), { ok: false, error: "storage_full", hint: ERROR_HINTS.storage_full });
  assert.equal(call(world.ctxFor(), "roll_dice", { sides: 20, count: 2, mode: "advantage" }).hint, ERROR_HINTS.mode_needs_count_1);
  assert.equal(call(world.ctxFor(), "reminder_create", { text: "позвонить" }).hint, ERROR_HINTS.give_exactly_one_of_in_minutes_or_at);
});

test("memory_save: один и тот же факт с другой точкой, регистром или «ё» не записывается дважды", () => {
  const world = createWorld();
  const ctx = world.ctxFor();

  assert.equal(call(ctx, "memory_save", { text: "Любит кофе" }).duplicate, undefined);

  for (const text of ["любит кофе.", "ЛЮБИТ  КОФЕ!", "любит, кофе"]) {
    const result = call(ctx, "memory_save", { text });

    assert.deepEqual([result.duplicate, result.total], [true, 1], text);
  }

  assert.equal(call(ctx, "memory_save", { text: "любит чай" }).total, 2, "другой факт — отдельная запись");
  assert.deepEqual(["Ёлка-палка", "елка палка", "!!", "??"].map(comparableText), ["елка палка", "елка палка", "!!", "??"]);
});
