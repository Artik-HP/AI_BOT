const test = require("node:test");
const assert = require("node:assert/strict");
const { SPARK_POOLS, TECHNIQUES } = require("../../src/ideas/catalog");
const { SPARK_SHAPES, composeSpark, drawSparks } = require("../../src/ideas/spark");
const { SPARK_CODE_PATTERN, decodeSpark, encodeSpark, encodeIndexes } = require("../../src/ideas/code");
const { systemRng } = require("../../src/companion/rules");
const { fixedRng } = require("../helpers/companionFixtures");

test("код искры: короткий, только [A-Za-z0-9_-], начинается с цифры; разбор возвращает ту же искру с тем же порядком ключей и приёмом", () => {
  for (const shape of SPARK_SHAPES) {
    for (const seed of [0, 3, 99]) {
      const spark = composeSpark(SPARK_POOLS, fixedRng([seed, seed + 1, seed + 2, seed + 3]), { shape: shape.name });
      const technique = TECHNIQUES[seed % TECHNIQUES.length];
      const code = encodeSpark(spark, technique);

      assert.match(code, /^[0-9][A-Za-z0-9_-]{7}$/);
      assert.match(code, SPARK_CODE_PATTERN);

      const decoded = decodeSpark(code);

      assert.equal(decoded.ok, true, code);
      assert.deepEqual(Object.entries(decoded.spark), Object.entries(spark), `${shape.name}: ключи и порядок`);
      assert.equal(decoded.technique.id, technique.id);
    }
  }

  for (let index = 0; index < 200; index += 1) {
    const drawn = drawSparks(systemRng);
    const decoded = decodeSpark(encodeSpark(drawn.sparks[0], drawn.technique));

    assert.deepEqual([decoded.spark, decoded.technique.id], [drawn.sparks[0], drawn.technique.id]);
  }
});

test("границы: последние элементы пулов и последний приём кодируются; значение не из пула и неизвестный приём — ошибка кодирования", () => {
  const last = { domain: SPARK_POOLS.domains.at(-1), constraint: SPARK_POOLS.constraints.at(-1), twist: SPARK_POOLS.twists.at(-1), audience: SPARK_POOLS.audiences.at(-1) };
  const decoded = decodeSpark(encodeSpark(last, TECHNIQUES.at(-1)));

  assert.deepEqual([decoded.spark, decoded.technique.id], [last, TECHNIQUES.at(-1).id]);
  assert.throws(() => encodeSpark({ domain: "выдуманная область", twist: SPARK_POOLS.twists[0] }, TECHNIQUES[0]), /SPARK_CODE_UNKNOWN_VALUE/);
  assert.throws(() => encodeSpark({ domain: SPARK_POOLS.domains[0], twist: SPARK_POOLS.twists[0] }, { id: "nope" }), /SPARK_CODE_UNKNOWN_VALUE/);
});

test("мусор и порча: неверный формат, изменённый знак, без области, из одного ингредиента — честный отказ, а не другая искра", () => {
  const code = encodeSpark({ domain: SPARK_POOLS.domains[5], constraint: SPARK_POOLS.constraints[2], twist: SPARK_POOLS.twists[7] }, TECHNIQUES[3]);

  for (const garbage of ["", "abc", "кофейня", `${code}x`, code.slice(1), "spark_" + code, null, undefined, 12345678]) {
    assert.deepEqual(decodeSpark(garbage), { ok: false, error: "spark_code_invalid" }, String(garbage));
  }

  for (let position = 1; position < code.length; position += 1) {
    const swapped = code.slice(0, position) + (code[position] === "A" ? "B" : "A") + code.slice(position + 1);

    assert.equal(decodeSpark(swapped).ok, false, `изменён знак ${position}`);
  }

  assert.deepEqual(decodeSpark(encodeIndexes([0, 1, 1, 0], 0)), { ok: false, error: "spark_code_invalid" }, "области нет");
  assert.deepEqual(decodeSpark(encodeIndexes([1, 0, 0, 0], 0)), { ok: false, error: "spark_code_invalid" }, "один ингредиент");
  assert.equal(decodeSpark(encodeIndexes([1, 1, 0, 0], 0)).ok, true, "два ингредиента — можно");
});

test("правка каталога делает старые коды недействительными: «от прежней версии» или «неверный», но никогда другая искра", () => {
  const spark = { domain: SPARK_POOLS.domains[1], twist: SPARK_POOLS.twists[2] };
  const code = encodeSpark(spark, TECHNIQUES[0]);
  const catalogs = [
    { pools: { ...SPARK_POOLS, domains: [...SPARK_POOLS.domains, "новая область"] } },
    { pools: { ...SPARK_POOLS, twists: [...SPARK_POOLS.twists].reverse() } },
    { techniques: [...TECHNIQUES.slice(1), TECHNIQUES[0]] }
  ];

  for (const catalog of catalogs) {
    const decoded = decodeSpark(code, catalog);

    assert.equal(decoded.ok, false);
    assert.ok(["spark_code_outdated", "spark_code_invalid"].includes(decoded.error), decoded.error);
  }

  assert.equal(decodeSpark(code, { pools: { ...SPARK_POOLS } }).ok, true, "тот же каталог — тот же код");
});
