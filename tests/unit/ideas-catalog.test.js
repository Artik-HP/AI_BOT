process.env.LOG_LEVEL = "silent";

const test = require("node:test");
const assert = require("node:assert/strict");
const { SPARK_POOLS, SPARK_LABELS, TECHNIQUES } = require("../../src/ideas/catalog");
const { INGREDIENT_POOLS, SPARK_SHAPES, composeSpark, rollSparks, pickTechnique, labelOf, formatSpark, formatTechnique } = require("../../src/ideas/spark");
const { systemRng } = require("../../src/companion/rules");
const { fixedRng } = require("../helpers/companionFixtures");

const MARKUP = /[*_#`<>]/;

test("каталог: каждая запись — одна короткая строка без разметки и без повторов", () => {
  for (const [pool, values] of Object.entries(SPARK_POOLS)) {
    assert.ok(values.length >= 15, `в пуле ${pool} слишком мало записей`);

    for (const value of values) {
      assert.equal(typeof value, "string");
      assert.equal(value, value.trim(), `${pool}: пробелы по краям «${value}»`);
      assert.ok(value.length >= 3 && value.length <= 80, `${pool}: длина «${value}»`);
      assert.doesNotMatch(value, /[\n\r\t]/, `${pool}: перевод строки в «${value}»`);
      assert.doesNotMatch(value, MARKUP, `${pool}: разметка в «${value}»`);
    }

    assert.equal(new Set(values.map((value) => value.toLowerCase())).size, values.length, `${pool}: есть повторы`);
  }
});

test("приёмы: уникальные id и названия, имя и описание — одна строка без разметки", () => {
  assert.equal(TECHNIQUES.length, 12);
  assert.equal(new Set(TECHNIQUES.map((technique) => technique.id)).size, TECHNIQUES.length);
  assert.equal(new Set(TECHNIQUES.map((technique) => technique.name)).size, TECHNIQUES.length);

  for (const { id, name, how } of TECHNIQUES) {
    assert.match(id, /^[a-z_]+$/);
    assert.ok(name.length >= 3 && name.length <= 40, name);
    assert.ok(how.length >= 40 && how.length <= 300, `${name}: описание ${how.length} знаков`);

    for (const text of [name, how]) {
      assert.doesNotMatch(text, /[\n\r\t]/, name);
      assert.doesNotMatch(text, MARKUP, name);
    }
  }
});

test("подписи ингредиентов: у известных ключей русские, у неизвестного — ключ с заглавной", () => {
  assert.deepEqual(Object.keys(SPARK_LABELS), ["domain", "constraint", "twist", "audience"]);
  assert.equal(labelOf("domain"), "Область");
  assert.equal(labelOf("audience"), "Для кого");
  assert.equal(labelOf("mood"), "Mood");
});

// These four tests are the contract of composeSpark: whoever rewrites it (see the comment above it in
// src/ideas/spark.js) may choose any ingredients, but must keep to this.
test("composeSpark: хотя бы два ингредиента, все значения из пулов", () => {
  const known = new Set(Object.values(SPARK_POOLS).flat());

  for (const rng of [fixedRng([0]), fixedRng([3, 1, 4, 1, 5, 9, 2]), systemRng]) {
    const spark = composeSpark(SPARK_POOLS, rng);

    assert.ok(Object.keys(spark).length >= 2, "одной искре нужно минимум два ингредиента");

    for (const [name, value] of Object.entries(spark)) {
      assert.ok(known.has(value), `${name}: «${value}» нет ни в одном пуле`);
    }
  }
});

test("composeSpark: тот же набор чисел даёт ту же искру, другие числа — другую (генератор действительно используется)", () => {
  const roll = (numbers) => composeSpark(SPARK_POOLS, fixedRng(numbers));

  assert.deepEqual(roll([5, 7, 3, 1, 2, 8]), roll([5, 7, 3, 1, 2, 8]));
  assert.notDeepEqual(roll([0]), roll([9]), "искра не зависит от генератора");
});

test("rollSparks: ровно столько разных искр, сколько просили; по умолчанию — настоящий генератор", () => {
  const sparks = rollSparks(3, systemRng);
  const keys = new Set(sparks.map((spark) => JSON.stringify(spark)));

  assert.equal(sparks.length, 3);
  assert.equal(keys.size, 3, "искры не повторяются");
  assert.deepEqual(rollSparks(0, systemRng), []);
});

test("rollSparks: повторы отбрасываются, число попыток ограничено — маленький пул не зацикливает", () => {
  let calls = 0;
  const same = () => {
    calls += 1;
    return { domain: "кофейня", twist: "игра" };
  };
  const sparks = rollSparks(3, fixedRng([0]), { compose: same });

  assert.equal(sparks.length, 1, "одинаковые искры сворачиваются в одну");
  assert.ok(calls <= 3 * 8, `${calls} попыток — слишком много`);
});

test("искры разнообразны: за 200 бросков настоящего генератора набирается не меньше 100 разных", () => {
  const seen = new Set();

  for (let index = 0; index < 200; index += 1) {
    seen.add(JSON.stringify(rollSparks(1, systemRng)[0]));
  }

  assert.ok(seen.size >= 100, `различных искр: ${seen.size}`);
});

test("pickTechnique: берёт приём через генератор; настоящий выдаёт все приёмы", () => {
  assert.deepEqual(pickTechnique(fixedRng([4])), TECHNIQUES[4]);
  assert.deepEqual(pickTechnique(fixedRng([0])), TECHNIQUES[0]);
  assert.deepEqual(pickTechnique(fixedRng([999])), TECHNIQUES.at(-1), "число за границей берётся по краю");

  const seen = new Set();

  for (let index = 0; index < 600; index += 1) {
    seen.add(pickTechnique(systemRng).id);
  }

  assert.equal(seen.size, TECHNIQUES.length);
});

test("текст искры: строка на ингредиент в порядке композитора, приём — одной строкой", () => {
  assert.equal(
    formatSpark({ domain: "кофейня", twist: "сделать это игрой", mood: "грусть" }),
    "Область: кофейня\nПоворот: сделать это игрой\nMood: грусть"
  );
  assert.equal(formatTechnique({ name: "SCAMPER", how: "Пройдись по глаголам." }), "Приём «SCAMPER»: Пройдись по глаголам.");
});

// --- Формы искры (SPARK_SHAPES в src/ideas/spark.js) ---
// Форму выбирает первый вызов генератора, поэтому скриптованный генератор, который первым отвечает `first`, а
// дальше нулём, выбирает ровно одну форму и берёт первый элемент каждого пула.

const TOTAL_WEIGHT = SPARK_SHAPES.reduce((total, shape) => total + shape.weight, 0);

function firstThen(first, rest = 0) {
  let calls = 0;

  return {
    int(min, max) {
      const value = calls === 0 ? first : rest;

      calls += 1;
      return Math.min(max, Math.max(min, value));
    }
  };
}

// С какого броска начинается каждая форма: формы выложены одна за другой по весам.
const ROLL_START = new Map();
let offset = 0;

for (const shape of SPARK_SHAPES) {
  ROLL_START.set(shape, offset);
  offset += shape.weight;
}

const shapeOf = (spark) => SPARK_SHAPES.find((shape) => shape.ingredients.join() === Object.keys(spark).join());
const poolOf = (ingredient) => SPARK_POOLS[INGREDIENT_POOLS[ingredient]];

test("формы искры: у каждой имя, вес и состав; имена и составы не повторяются; классика на месте", () => {
  assert.ok(SPARK_SHAPES.length >= 2);
  assert.equal(new Set(SPARK_SHAPES.map((shape) => shape.name)).size, SPARK_SHAPES.length);
  assert.equal(new Set(SPARK_SHAPES.map((shape) => shape.ingredients.join())).size, SPARK_SHAPES.length, "две формы с одним составом по искре не различить");
  assert.deepEqual(SPARK_SHAPES.find((shape) => shape.name === "classic")?.ingredients, ["domain", "constraint", "twist"], "классика — запасная форма и прежний вид искры");

  for (const { name, ingredients, weight } of SPARK_SHAPES) {
    assert.match(name, /^[a-z_]+$/);
    assert.ok(Number.isInteger(weight) && weight > 0, `${name}: вес ${weight}`);
    assert.ok(ingredients.length >= 2, `${name}: меньше двух ингредиентов`);
    assert.equal(new Set(ingredients).size, ingredients.length, `${name}: ингредиент повторяется`);
    assert.equal(ingredients[0], "domain", `${name}: область — якорь и стоит первой`);
  }
});

test("ингредиенты форм: у каждого есть подпись и непустой пул; пулов-сирот и мёртвых привязок нет", () => {
  const used = new Set(SPARK_SHAPES.flatMap((shape) => shape.ingredients));

  for (const ingredient of used) {
    assert.ok(Object.hasOwn(SPARK_LABELS, ingredient), `нет подписи для «${ingredient}» в SPARK_LABELS`);
    assert.ok(Object.hasOwn(INGREDIENT_POOLS, ingredient), `не указан пул для «${ingredient}» в INGREDIENT_POOLS`);
    assert.ok(Array.isArray(poolOf(ingredient)) && poolOf(ingredient).length > 0, `пул «${INGREDIENT_POOLS[ingredient]}» пуст или его нет в SPARK_POOLS`);
  }

  for (const pool of Object.keys(SPARK_POOLS)) {
    assert.ok(Object.values(INGREDIENT_POOLS).includes(pool), `пул «${pool}» не привязан ни к одному ингредиенту`);
  }

  for (const ingredient of Object.keys(INGREDIENT_POOLS)) {
    assert.ok(used.has(ingredient), `ингредиент «${ingredient}» не входит ни в одну форму`);
  }
});

test("каждая форма достижима: скриптованный бросок выбирает именно её; ключи — по составу и порядку формы", () => {
  for (const shape of SPARK_SHAPES) {
    const first = ROLL_START.get(shape);

    for (const roll of [first, first + shape.weight - 1]) {
      const spark = composeSpark(SPARK_POOLS, firstThen(roll));

      assert.deepEqual(Object.keys(spark), shape.ingredients, `${shape.name}: бросок ${roll}`);
      assert.deepEqual(Object.values(spark), shape.ingredients.map((ingredient) => poolOf(ingredient)[0]), `${shape.name}: после выбора формы берётся первый элемент каждого пула`);
    }
  }
});

test("порядок обращений к генератору: один бросок на форму (0 … сумма весов − 1), затем по одному на ингредиент в порядке формы", () => {
  for (const shape of SPARK_SHAPES) {
    const calls = [];
    const recorder = {
      int(min, max) {
        calls.push([min, max]);
        return calls.length === 1 ? ROLL_START.get(shape) : 0;
      }
    };

    composeSpark(SPARK_POOLS, recorder);

    assert.deepEqual(calls[0], [0, TOTAL_WEIGHT - 1], `${shape.name}: выбор формы`);
    assert.deepEqual(calls.slice(1), shape.ingredients.map((ingredient) => [0, poolOf(ingredient).length - 1]), `${shape.name}: по одному вызову на ингредиент`);
  }
});

test("область есть в каждой искре и всегда стоит первой — и в данных, и в тексте карточки", () => {
  const sparks = [
    ...Array.from({ length: TOTAL_WEIGHT }, (_, roll) => composeSpark(SPARK_POOLS, firstThen(roll))),
    ...Array.from({ length: 500 }, () => composeSpark(SPARK_POOLS, systemRng))
  ];

  for (const spark of sparks) {
    assert.equal(Object.keys(spark)[0], "domain");
    assert.match(formatSpark(spark), /^Область: [^\n]+/);
  }
});

test("веса: на 2000 бросков настоящего генератора встречаются все формы, самая весомая — чаще самой лёгкой", () => {
  const counts = new Map(SPARK_SHAPES.map((shape) => [shape, 0]));

  for (let index = 0; index < 2000; index += 1) {
    const spark = composeSpark(SPARK_POOLS, systemRng);
    const shape = shapeOf(spark);

    assert.ok(shape, `искра ${Object.keys(spark).join("+")} не соответствует ни одной форме`);
    counts.set(shape, counts.get(shape) + 1);
  }

  for (const [shape, count] of counts) {
    assert.ok(count > 0, `форма ${shape.name} за 2000 бросков не выпала ни разу`);
  }

  const heaviest = SPARK_SHAPES.reduce((best, shape) => (shape.weight > best.weight ? shape : best));
  const lightest = Math.min(...SPARK_SHAPES.map((shape) => shape.weight));

  for (const shape of SPARK_SHAPES.filter((entry) => entry.weight === lightest)) {
    assert.ok(counts.get(heaviest) > counts.get(shape), `${heaviest.name} (${counts.get(heaviest)}) должна встречаться чаще, чем ${shape.name} (${counts.get(shape)})`);
  }
});

test("урезанные пулы: без аудиторий искра остаётся из двух-трёх ингредиентов; пустой пул равен отсутствующему", () => {
  const without = Object.fromEntries(Object.entries(SPARK_POOLS).filter(([name]) => name !== "audiences"));
  const empty = { ...SPARK_POOLS, audiences: [] };

  for (const pools of [without, empty]) {
    const sparks = [
      ...Array.from({ length: TOTAL_WEIGHT }, (_, roll) => composeSpark(pools, firstThen(roll))),
      ...Array.from({ length: 300 }, () => composeSpark(pools, systemRng))
    ];

    for (const spark of sparks) {
      const keys = Object.keys(spark);

      assert.ok(keys.length >= 2 && keys.length <= 3, `ингредиенты: ${keys.join("+")}`);
      assert.equal(keys[0], "domain");
      assert.ok(!keys.includes("audience"), "ингредиента без пула в искре быть не должно");
    }
  }
});

test("пулы, из которых не собрать и двух ингредиентов, дают ошибку, а не искру из одного", () => {
  for (const pools of [{}, { domains: ["кофейня"] }, { domains: ["кофейня"], constraints: [], twists: [], audiences: [] }]) {
    for (const rng of [systemRng, firstThen(0), firstThen(9)]) {
      assert.throws(() => composeSpark(pools, rng), /SPARK_POOLS_TOO_SMALL/);
    }
  }
});

test("composeSpark: без пула областей искра отклоняется, даже если остальные ингредиенты доступны", () => {
  const withoutDomain = Object.fromEntries(Object.entries(SPARK_POOLS).filter(([name]) => name !== "domains"));

  for (const pools of [withoutDomain, { ...SPARK_POOLS, domains: [] }]) {
    for (const shape of SPARK_SHAPES) {
      assert.throws(() => composeSpark(pools, firstThen(0), { shape: shape.name }), /SPARK_POOLS_TOO_SMALL/, shape.name);
    }
    assert.throws(() => composeSpark(pools, firstThen(0)), /SPARK_POOLS_TOO_SMALL/);
  }
});

test("карточка из четырёх ингредиентов: подписи в порядке формы, «Для кого» среди них", () => {
  const widest = SPARK_SHAPES.reduce((best, shape) => (shape.ingredients.length > best.ingredients.length ? shape : best));
  const lines = formatSpark(composeSpark(SPARK_POOLS, firstThen(ROLL_START.get(widest)))).split("\n");

  assert.equal(lines.length, 4);
  assert.deepEqual(lines.map((line) => line.split(": ")[0]), widest.ingredients.map((ingredient) => labelOf(ingredient)));
  assert.ok(lines.some((line) => line.startsWith("Для кого: ")));
});
