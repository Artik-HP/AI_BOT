process.env.LOG_LEVEL = "silent";

const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../../src/companion/rules");
const { ERROR_HINTS } = require("../../src/companion/hints");
const { executeTool } = require("../../src/companion/tools");
const bank = require("../../src/ideas/bank");
const { TECHNIQUES } = require("../../src/ideas/catalog");
const { createSparkHistory } = require("../../src/ideas/recent");
const { SPARK_SHAPES, formatSpark } = require("../../src/ideas/spark");
const { IDEA_TOOL_DEFINITIONS } = require("../../src/ideas/tools");
const { createWorld } = require("../helpers/companionFixtures");

const call = (ctx, name, args) => executeTool(name, JSON.stringify(args), ctx);
const idea = (title, extra = {}) => ({ title, pitch: `Суть идеи «${title}» в паре слов.`, ...extra });
const titles = (result) => result.ideas.map((entry) => entry.title);
// A context of the running bot: real generator, its own spark history.
const liveCtx = (world, chatId = "1") => world.ctxFor(chatId, chatId, { rng: R.systemRng, sparks: createSparkHistory() });

test("idea_spark: описание функции перечисляет формы, приёмы и ингредиенты из кода, а не из головы", () => {
  const { properties } = IDEA_TOOL_DEFINITIONS.find((tool) => tool.function.name === "idea_spark").function.parameters;

  assert.deepEqual(properties.shape.enum, SPARK_SHAPES.map((shape) => shape.name));
  assert.deepEqual(properties.technique.enum, TECHNIQUES.map((technique) => technique.id));
  assert.deepEqual(properties.reroll.items.enum, ["domain", "constraint", "twist", "audience"]);
});

test("idea_spark: форма по заказу; неизвестная форма — invalid_arguments с подсказкой", () => {
  const world = createWorld();
  const ctx = liveCtx(world);

  for (const shape of SPARK_SHAPES) {
    const result = call(ctx, "idea_spark", { shape: shape.name.toUpperCase() });

    assert.equal(result.ok, true, shape.name);
    assert.deepEqual(Object.keys(result.sparks[0]), shape.ingredients, shape.name);
  }

  const refused = call(ctx, "idea_spark", { shape: "огромная" });

  assert.equal(refused.error, "invalid_arguments");
  assert.match(refused.detail, /shape must be one of: classic/);
  assert.equal(refused.hint, ERROR_HINTS.invalid_arguments);
});

test("idea_spark: приём по id или по названию в любом регистре; карточки — те же строки, что видит человек", () => {
  const world = createWorld();
  const ctx = liveCtx(world);

  assert.equal(call(ctx, "idea_spark", { technique: "analogy" }).technique.id, "analogy");
  assert.equal(call(ctx, "idea_spark", { technique: "  АНАЛОГИЯ " }).technique.id, "analogy");
  assert.equal(call(ctx, "idea_spark", { technique: "Пять «почему»" }).technique.id, "five_whys");
  assert.equal(call(ctx, "idea_spark", { technique: "телепатия" }).error, "invalid_arguments");

  const three = call(ctx, "idea_spark", { count: 3 });

  assert.deepEqual(three.cards, three.sparks.map(formatSpark));
  assert.ok(three.cards.every((card) => /^Область: .+/.test(card)));
});

test("idea_spark reroll: меняется только названное, приём прежний; можно назвать ингредиент словом с карточки", () => {
  const world = createWorld();
  const ctx = liveCtx(world);
  const first = call(ctx, "idea_spark", { shape: "classic" });
  const second = call(ctx, "idea_spark", { reroll: ["twist"] });

  assert.equal(second.ok, true);
  assert.deepEqual(second.rerolled, ["twist"]);
  assert.equal(second.sparks[0].domain, first.sparks[0].domain);
  assert.equal(second.sparks[0].constraint, first.sparks[0].constraint);
  assert.notEqual(second.sparks[0].twist, first.sparks[0].twist);
  assert.deepEqual(second.technique, first.technique, "приём остался тем же");

  const third = call(ctx, "idea_spark", { reroll: "для кого" });

  assert.deepEqual(Object.keys(third.sparks[0]), ["domain", "constraint", "twist", "audience"], "добавить «для кого» тоже можно");
  assert.equal(third.sparks[0].twist, second.sparks[0].twist);
  assert.equal(call(ctx, "idea_spark", { reroll: ["Поворот", "twist"] }).rerolled.length, 1, "повторы в списке схлопываются");
});

test("idea_spark reroll: без прошлой искры, вместе с count или shape, с неизвестным ингредиентом — понятный отказ", () => {
  const world = createWorld();
  const fresh = liveCtx(world, "2");
  const none = call(fresh, "idea_spark", { reroll: ["twist"] });

  assert.deepEqual(none, { ok: false, error: "no_previous_spark", hint: ERROR_HINTS.no_previous_spark });
  assert.equal(call(world.ctxFor(), "idea_spark", { reroll: ["twist"] }).error, "no_previous_spark", "без истории перебросить нечего");

  call(fresh, "idea_spark", {});

  assert.equal(call(fresh, "idea_spark", { reroll: ["twist"], count: 2 }).error, "reroll_takes_no_count_or_shape");
  assert.equal(call(fresh, "idea_spark", { reroll: ["twist"], shape: "minimal" }).error, "reroll_takes_no_count_or_shape");
  assert.equal(call(fresh, "idea_spark", { reroll: ["twist"], count: 1 }).ok, true, "count=1 не мешает");
  assert.equal(call(fresh, "idea_spark", { reroll: ["цвет"] }).error, "invalid_arguments");
  assert.equal(call(fresh, "idea_spark", { reroll: [] }).error, "invalid_arguments");
});

test("idea_spark: искры одного чата не повторяют друг друга, разные чаты друг другу не мешают", () => {
  const world = createWorld();
  const history = createSparkHistory();
  const ctxA = world.ctxFor("1", "1", { rng: R.systemRng, sparks: history });
  const ctxB = world.ctxFor("2", "2", { rng: R.systemRng, sparks: history });
  const first = call(ctxA, "idea_spark", {});
  const second = call(ctxA, "idea_spark", {});

  assert.deepEqual(Object.values(second.sparks[0]).filter((value) => Object.values(first.sparks[0]).includes(value)), []);
  assert.notEqual(second.technique.id, first.technique.id);
  assert.equal(history.recent("2").values.size, 0);
  call(ctxB, "idea_spark", {});
  assert.equal(history.recent("2").values.size > 0, true);
});

test("idea_save: теги строкой через запятую или решётками — список; похожее название обновляет ту же идею", () => {
  const world = createWorld();
  const ctx = world.ctxFor();
  const saved = call(ctx, "idea_save", idea("Кофейня-библиотека", { tags: "кофе, город" }));

  assert.equal(saved.saved, true);
  assert.deepEqual(saved.idea.tags, ["кофе", "город"], "ответ показывает, что сохранилось");
  assert.deepEqual(call(ctx, "idea_save", idea("Другая", { tags: "#кофе #Город" })).idea.tags, ["кофе", "город"]);

  const again = call(ctx, "idea_save", idea("кофейня — библиотека!", { pitch: "Новая суть той же идеи." }));

  assert.deepEqual([again.updated, again.id, again.total], [true, saved.id, 2], "дубль не появился");
  assert.equal(again.idea.title, "Кофейня-библиотека", "название осталось прежним");
  assert.equal(call(ctx, "idea_save", idea("Ёлка на балконе")).saved, true);
  assert.equal(call(ctx, "idea_save", idea("елка на балконе")).updated, true, "ё и е — одно название");
});

test("idea_update: код с решёткой, пробелами и точкой понимается; похожее чужое название — title_taken", () => {
  const world = createWorld();
  const ctx = world.ctxFor();
  const first = call(ctx, "idea_save", idea("Первая"));
  const second = call(ctx, "idea_save", idea("Вторая идея"));

  for (const id of [`#${first.id.toUpperCase()}`, ` ${first.id} `, `${first.id}.`, `№${first.id}`]) {
    assert.equal(call(ctx, "idea_update", { id, status: "parked" }).ok, true, JSON.stringify(id));
  }

  const clash = call(ctx, "idea_update", { id: first.id, title: "ВТОРАЯ  идея!" });

  assert.deepEqual([clash.error, clash.id], ["title_taken", second.id]);
  assert.equal(clash.hint, ERROR_HINTS.title_taken);
  assert.equal(call(ctx, "idea_update", { id: "#12345", status: "done" }).error, "invalid_id");

  const missing = call(ctx, "idea_update", { id: "deadbeef", status: "done" });

  assert.equal(missing.hint, ERROR_HINTS.not_found, "модель знает, что делать дальше");
  assert.deepEqual(["a1b2c3d4", "#A1B2C3D4.", "nope", "", null].map(bank.normalizeId), ["a1b2c3d4", "a1b2c3d4", null, null, null]);
});

test("idea_list: листание — offset и has_more; за последней страницей пусто; отрицательный offset отклоняется", () => {
  const world = createWorld();
  const ctx = world.ctxFor();

  for (const title of ["Один", "Два", "Три", "Четыре", "Пять"]) {
    call(ctx, "idea_save", idea(title));
    world.clock.now += 1000;
  }

  const first = call(ctx, "idea_list", { limit: 2 });
  const second = call(ctx, "idea_list", { limit: 2, offset: 2 });
  const last = call(ctx, "idea_list", { limit: 2, offset: 4 });

  assert.deepEqual([titles(first), first.has_more, first.offset], [["Пять", "Четыре"], true, undefined]);
  assert.deepEqual([titles(second), second.has_more, second.offset], [["Три", "Два"], true, 2]);
  assert.deepEqual([titles(last), last.has_more], [["Один"], false]);
  assert.deepEqual([titles(call(ctx, "idea_list", { offset: 50 })), call(ctx, "idea_list", { offset: 50 }).matched], [[], 5]);
  assert.equal(call(ctx, "idea_list", { offset: -1 }).error, "invalid_arguments");
  assert.equal(call(ctx, "idea_list", { offset: 201 }).error, "invalid_arguments");
});
