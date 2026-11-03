process.env.LOG_LEVEL = "silent";

const test = require("node:test");
const assert = require("node:assert/strict");
const { SPARK_POOLS, TECHNIQUES } = require("../../src/ideas/catalog");
const {
  INGREDIENT_POOLS,
  INGREDIENTS,
  SPARK_SHAPES,
  SHAPE_NAMES,
  composeSpark,
  rerollSpark,
  rollSparks,
  pickTechnique,
  drawSparks,
  shapeOf
} = require("../../src/ideas/spark");
const { RECENT_SPARKS, RECENT_TECHNIQUES, createSparkHistory } = require("../../src/ideas/recent");
const { systemRng } = require("../../src/companion/rules");
const { fixedRng } = require("../helpers/companionFixtures");

// Remembers every (min, max) the code asked the generator for, answering with the lowest value.
function recordingRng() {
  const calls = [];

  return { calls, int(min, max) { calls.push([min, max]); return min; } };
}

const valuesOf = (spark) => Object.values(spark);
const shared = (a, b) => valuesOf(a).filter((value) => valuesOf(b).includes(value));

test("форма по заказу: именно её состав и ни одного броска на выбор формы; неизвестная форма — ошибка", () => {
  for (const shape of SPARK_SHAPES) {
    const rng = recordingRng();
    const spark = composeSpark(SPARK_POOLS, rng, { shape: shape.name });

    assert.deepEqual(Object.keys(spark), shape.ingredients, shape.name);
    assert.deepEqual(rng.calls, shape.ingredients.map((ingredient) => [0, SPARK_POOLS[INGREDIENT_POOLS[ingredient]].length - 1]), `${shape.name}: только броски ингредиентов`);
  }

  assert.deepEqual(SHAPE_NAMES, SPARK_SHAPES.map((shape) => shape.name));
  assert.throws(() => composeSpark(SPARK_POOLS, systemRng, { shape: "bogus" }), /UNKNOWN_SPARK_SHAPE/);
});

test("«не повторять»: недавние значения не выпадают, пока есть другие; всё занято — искра всё равно есть; бросков столько же", () => {
  const domains = SPARK_POOLS.domains;
  const avoid = new Set(domains.slice(0, -3));
  const left = new Set(domains.slice(-3));

  for (let index = 0; index < 300; index += 1) {
    assert.ok(left.has(composeSpark(SPARK_POOLS, systemRng, { avoid }).domain), "выпала недавняя область");
  }

  const everything = new Set(Object.values(SPARK_POOLS).flat());
  const spark = composeSpark(SPARK_POOLS, systemRng, { avoid: everything });

  assert.ok(valuesOf(spark).every((value) => everything.has(value)), "пул целиком занят — значение берётся из него же");

  const plain = recordingRng();
  const avoiding = recordingRng();

  composeSpark(SPARK_POOLS, plain);
  composeSpark(SPARK_POOLS, avoiding, { avoid });
  assert.equal(avoiding.calls.length, plain.calls.length, "избегание не тратит лишних бросков");
});

test("несколько искр в одном ответе не делят ни одного значения: три искры — три разные области", () => {
  for (let index = 0; index < 200; index += 1) {
    const sparks = rollSparks(3, systemRng);

    assert.equal(sparks.length, 3);

    for (const [a, b] of [[0, 1], [0, 2], [1, 2]]) {
      assert.deepEqual(shared(sparks[a], sparks[b]), [], JSON.stringify(sparks));
    }
  }
});

test("rerollSpark: названное меняется и никогда не возвращается прежним, остальное как было; новый ингредиент встаёт на своё место", () => {
  const spark = { domain: SPARK_POOLS.domains[0], constraint: SPARK_POOLS.constraints[0], twist: SPARK_POOLS.twists[0] };

  for (let index = 0; index < 200; index += 1) {
    const next = rerollSpark(spark, ["twist"], systemRng);

    assert.deepEqual(Object.keys(next), ["domain", "constraint", "twist"]);
    assert.equal(next.domain, spark.domain);
    assert.equal(next.constraint, spark.constraint);
    assert.notEqual(next.twist, spark.twist, "тот же поворот вместо нового");
  }

  const widened = rerollSpark({ domain: spark.domain, twist: spark.twist }, ["audience", "constraint"], systemRng);

  assert.deepEqual(Object.keys(widened), ["domain", "constraint", "twist", "audience"], "порядок строк — как на карточке");
  assert.equal(widened.twist, spark.twist);

  const rng = recordingRng();

  rerollSpark(spark, ["domain", "twist"], rng);
  assert.deepEqual(rng.calls, [[0, SPARK_POOLS.domains.length - 2], [0, SPARK_POOLS.twists.length - 2]], "по броску на ингредиент, без прежнего значения в пуле");

  const { audiences, ...withoutAudiences } = SPARK_POOLS;

  assert.ok(audiences.length > 0);
  assert.deepEqual(rerollSpark(spark, ["audience"], systemRng, { pools: withoutAudiences }), spark, "пула нет — искра не меняется");
  assert.deepEqual(rerollSpark({ twist: "x" }, ["twist"], systemRng, { pools: { twists: ["x"] } }), { twist: "x" }, "в пуле одно значение — оно и остаётся");
});

test("pickTechnique: недавние приёмы не повторяются, пока есть другие; заняты все — приём всё равно выбирается", () => {
  const avoid = new Set(TECHNIQUES.slice(1).map((technique) => technique.id));

  for (let index = 0; index < 50; index += 1) {
    assert.equal(pickTechnique(systemRng, TECHNIQUES, avoid).id, TECHNIQUES[0].id);
  }

  assert.ok(TECHNIQUES.includes(pickTechnique(systemRng, TECHNIQUES, new Set(TECHNIQUES.map((technique) => technique.id)))));
  assert.equal(pickTechnique(fixedRng([3])), TECHNIQUES[3], "без списка — как раньше");
});

test("drawSparks: без истории — независимый бросок; приём по заказу; переброс без прошлой искры — отказ, а не случайная", () => {
  const plain = drawSparks(systemRng);

  assert.equal(plain.ok, true);
  assert.equal(plain.sparks.length, 1);
  assert.ok(TECHNIQUES.includes(plain.technique));
  assert.equal(drawSparks(systemRng, { count: 3 }).sparks.length, 3);
  assert.equal(drawSparks(systemRng, { technique: "analogy" }).technique.id, "analogy");
  assert.deepEqual(drawSparks(systemRng, { reroll: ["twist"] }), { ok: false, error: "no_previous_spark" });
  assert.throws(() => drawSparks(systemRng, { technique: "bogus" }), /UNKNOWN_TECHNIQUE/);
  assert.deepEqual(drawSparks(systemRng, { count: 0 }), { ok: false, error: "spark_unavailable" }, "ни одной искры — отказ, а не пустой успех");
  assert.throws(() => drawSparks(systemRng, { pools: { domains: ["x"] } }), /SPARK_POOLS_TOO_SMALL/, "сбой пулов уходит вызывающему, а он отвечает вежливо");
});

test("drawSparks: переброс оставляет приём прошлой искры, если другой не просили", () => {
  const last = { domain: SPARK_POOLS.domains[0], twist: SPARK_POOLS.twists[0] };
  const recent = { values: new Set(valuesOf(last)), techniques: new Set(["mashup"]), last, lastTechnique: "mashup" };
  const kept = drawSparks(systemRng, { reroll: ["twist"], recent });

  assert.equal(kept.technique.id, "mashup");
  assert.equal(kept.sparks[0].domain, last.domain);
  assert.notEqual(kept.sparks[0].twist, last.twist);
  assert.equal(drawSparks(systemRng, { reroll: ["twist"], recent, technique: "analogy" }).technique.id, "analogy");
});

test("shapeOf: каждая форма узнаётся по составу; состав, которого нет в таблице, — null", () => {
  for (const shape of SPARK_SHAPES) {
    assert.equal(shapeOf(composeSpark(SPARK_POOLS, systemRng, { shape: shape.name })), shape.name);
  }

  assert.equal(shapeOf({ domain: "a", audience: "b" }), null);
  assert.deepEqual(INGREDIENTS, Object.keys(INGREDIENT_POOLS));
});

test("история чата: новая искра не повторяет значения последних искр, приём — последних приёмов", () => {
  const history = createSparkHistory();
  const drawn = [];

  for (let index = 0; index < 60; index += 1) {
    const result = history.draw("chat", systemRng);

    assert.equal(result.ok, true);
    drawn.push(result);
  }

  for (const [index, { sparks: [spark], technique }] of drawn.entries()) {
    for (let back = 1; back <= Math.min(index, RECENT_SPARKS); back += 1) {
      assert.deepEqual(shared(spark, drawn[index - back].sparks[0]), [], `искра ${index} повторила искру ${index - back}`);
    }

    for (let back = 1; back <= Math.min(index, RECENT_TECHNIQUES); back += 1) {
      assert.notEqual(technique.id, drawn[index - back].technique.id, `приём ${index} повторил приём ${index - back}`);
    }
  }

  assert.equal(history.recent("other").values.size, 0, "другой чат ничего не знает о чужих искрах");
});

test("история чата: перебросить можно только одиночную искру; переброс сам становится последней искрой", () => {
  const history = createSparkHistory();

  assert.deepEqual(history.draw("chat", systemRng, { reroll: ["twist"] }), { ok: false, error: "no_previous_spark" });

  history.draw("chat", systemRng, { count: 3 });
  assert.equal(history.recent("chat").last, null, "после трёх искр неясно, какую менять");
  assert.equal(history.draw("chat", systemRng, { reroll: ["twist"] }).error, "no_previous_spark");

  const [first] = history.draw("chat", systemRng, { shape: "classic" }).sparks;
  const [second] = history.draw("chat", systemRng, { reroll: ["twist"] }).sparks;
  const [third] = history.draw("chat", systemRng, { reroll: ["domain"] }).sparks;

  assert.equal(second.domain, first.domain);
  assert.notEqual(second.twist, first.twist);
  assert.equal(third.twist, second.twist, "второй переброс меняет уже обновлённую искру");
  assert.notEqual(third.domain, second.domain);
  assert.deepEqual(history.recent("chat").last, third);

  history.forget("chat");
  assert.equal(history.recent("chat").last, null);
  assert.equal(history.recent("chat").values.size, 0);
});

test("история чата ограничена: молчаливый чат забывается по времени, лишние чаты вытесняются самые давние", () => {
  const clock = { now: 0 };
  const history = createSparkHistory({ maxChats: 3, ttlMs: 1000, now: () => clock.now });

  history.draw("a", systemRng);
  clock.now = 999;
  assert.ok(history.recent("a").last, "ещё помнит");
  clock.now = 1000;
  assert.equal(history.recent("a").last, null, "время вышло");

  for (const chat of ["a", "b", "c"]) {
    history.draw(chat, systemRng);
  }

  history.draw("a", systemRng);
  history.draw("d", systemRng);

  assert.equal(history.size, 3);
  assert.equal(history.recent("b").last, null, "вытеснен самый давний");
  assert.ok(["a", "c", "d"].every((chat) => history.recent(chat).last), "недавно активные на месте");
});
