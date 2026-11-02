const { SPARK_POOLS, SPARK_LABELS, TECHNIQUES } = require("./catalog");

// A spark is a handful of random ingredients (area, constraint, twist, audience) that an idea is built around.
// Randomness always comes from the injected `rng` ({ int(min, max) }, inclusive on both ends): the real one is
// crypto-based (companion/rules.js systemRng), tests pass a scripted one. Math.random is never used.

const MAX_ATTEMPTS_PER_SPARK = 8;
const NOTHING_AVOIDED = new Set();

// Which pool each ingredient is drawn from. Spelled out, not derived from the name, so that a renamed pool
// cannot silently drop an ingredient. The order of the keys is the order of the card lines.
const INGREDIENT_POOLS = {
  domain: "domains",
  constraint: "constraints",
  twist: "twists",
  audience: "audiences"
};

const INGREDIENTS = Object.keys(INGREDIENT_POOLS);

// The shapes a spark can take and how often each is drawn (weights, not percentages). `domain` always comes
// first: it is the anchor the other ingredients hang on, and it is the first line of the card. The usual shapes
// carry at most three conditions, because more of them start to contradict each other; "minimal" leaves the
// model the most room, "maximal" is the most concrete. The order inside a shape is the order of the card lines.
const SPARK_SHAPES = [
  { name: "classic", ingredients: ["domain", "constraint", "twist"], weight: 4 },
  { name: "audience_twist", ingredients: ["domain", "twist", "audience"], weight: 2 },
  { name: "audience_constraint", ingredients: ["domain", "constraint", "audience"], weight: 2 },
  { name: "minimal", ingredients: ["domain", "twist"], weight: 1 },
  { name: "maximal", ingredients: ["domain", "constraint", "twist", "audience"], weight: 1 }
];

const SHAPE_NAMES = SPARK_SHAPES.map((shape) => shape.name);
const CLASSIC = SPARK_SHAPES.find((shape) => shape.name === "classic");
const TOTAL_WEIGHT = SPARK_SHAPES.reduce((total, shape) => total + shape.weight, 0);

function pick(list, rng) {
  return list[rng.int(0, list.length - 1)];
}

// Prefers values that were not shown lately. Still exactly one rng call; when everything is avoided (a tiny pool),
// the whole pool is used, so avoiding never makes a spark impossible.
function pickFresh(list, rng, avoid = NOTHING_AVOIDED) {
  const fresh = avoid.size ? list.filter((value) => !avoid.has(value)) : list;

  return pick(fresh.length ? fresh : list, rng);
}

// One rng call picks the shape: the roll walks over the cumulative weights. If a broken rng answers outside
// its range, the classic shape is the safe answer.
function pickShape(rng) {
  let roll = rng.int(0, TOTAL_WEIGHT - 1);

  for (const shape of SPARK_SHAPES) {
    if (roll < shape.weight) {
      return shape;
    }

    roll -= shape.weight;
  }

  return CLASSIC;
}

function shapeNamed(name) {
  const shape = SPARK_SHAPES.find((entry) => entry.name === name);

  if (!shape) {
    throw new Error("UNKNOWN_SPARK_SHAPE");
  }

  return shape;
}

function hasPool(pools, ingredient) {
  const list = pools[INGREDIENT_POOLS[ingredient]];

  return Array.isArray(list) && list.length > 0;
}

// Draws a shape (or takes the one asked for, without an rng call), then one value per ingredient in the order of the
// shape, preferring values outside `avoid`. An ingredient whose pool is missing or empty is skipped; below two
// ingredients the classic shape is used instead. This guards against trimmed pools and is not the normal path. If
// even the classic shape cannot be built, it throws: a one-line "spark" is worse than none, and the callers
// (idea_spark, the card, the website) already turn an exception into a polite refusal.
function composeSpark(pools, rng, { shape, avoid = NOTHING_AVOIDED } = {}) {
  let ingredients = (shape ? shapeNamed(shape) : pickShape(rng)).ingredients.filter((ingredient) => hasPool(pools, ingredient));

  if (ingredients.length < 2) {
    ingredients = CLASSIC.ingredients.filter((ingredient) => hasPool(pools, ingredient));
  }

  if (ingredients.length < 2) {
    throw new Error("SPARK_POOLS_TOO_SMALL");
  }

  return Object.fromEntries(ingredients.map((ingredient) => [ingredient, pickFresh(pools[INGREDIENT_POOLS[ingredient]], rng, avoid)]));
}

// Redraws the named ingredients of a spark and keeps the others: "another twist, the rest is fine". A named
// ingredient the spark did not have is added ("add an audience"). A redrawn ingredient never comes back with its
// old value unless its pool has nothing else. One rng call per redrawn ingredient, in the order of the card lines.
function rerollSpark(spark, names, rng, { pools = SPARK_POOLS, avoid = NOTHING_AVOIDED } = {}) {
  const redraw = new Set(names.filter((ingredient) => hasPool(pools, ingredient)));
  const result = {};

  for (const ingredient of INGREDIENTS) {
    if (redraw.has(ingredient)) {
      result[ingredient] = pickFresh(pools[INGREDIENT_POOLS[ingredient]], rng, new Set([...avoid, spark[ingredient]]));
    } else if (Object.hasOwn(spark, ingredient)) {
      result[ingredient] = spark[ingredient];
    }
  }

  return result;
}

function sparkKey(spark) {
  return Object.entries(spark).map(([name, value]) => `${name}=${value}`).join("|");
}

// `count` sparks that differ from one another. Sparks of one answer also avoid each other's values, so three sparks
// do not share an area. The retries are bounded: a tiny pool or an unlucky rng must not loop forever.
function rollSparks(count, rng, { pools = SPARK_POOLS, compose = composeSpark, shape, avoid = NOTHING_AVOIDED } = {}) {
  const sparks = [];
  const seen = new Set();
  const used = new Set(avoid);

  for (let attempt = 0; sparks.length < count && attempt < count * MAX_ATTEMPTS_PER_SPARK; attempt += 1) {
    const spark = compose(pools, rng, { shape, avoid: used });
    const key = sparkKey(spark);

    if (!seen.has(key)) {
      seen.add(key);
      sparks.push(spark);

      for (const value of Object.values(spark)) {
        used.add(value);
      }
    }
  }

  return sparks;
}

// `avoid` holds technique ids shown lately; like ingredients, they are only a preference.
function pickTechnique(rng, techniques = TECHNIQUES, avoid = NOTHING_AVOIDED) {
  const fresh = avoid.size ? techniques.filter((technique) => !avoid.has(technique.id)) : techniques;

  return pick(fresh.length ? fresh : techniques, rng);
}

function techniqueById(id) {
  return TECHNIQUES.find((technique) => technique.id === id) || null;
}

const NOTHING_RECENT = { values: NOTHING_AVOIDED, techniques: NOTHING_AVOIDED, last: null, lastTechnique: null };

// Everything one answer needs: sparks and a technique, as { ok: true, sparks, technique } or { ok: false, error }.
// `recent` is what this chat was shown lately (src/ideas/recent.js); without it the draw is stateless, as on the
// website. A reroll keeps the technique of the spark it changes, unless another one is asked for. The rng is used for
// the sparks first and for the technique last.
function drawSparks(rng, { count = 1, shape, technique, reroll, recent = NOTHING_RECENT, pools = SPARK_POOLS } = {}) {
  let sparks;

  if (reroll?.length) {
    if (!recent.last) {
      return { ok: false, error: "no_previous_spark" };
    }

    sparks = [rerollSpark(recent.last, reroll, rng, { pools, avoid: recent.values })];
  } else {
    sparks = rollSparks(count, rng, { pools, shape, avoid: recent.values });
  }

  if (!sparks.length) {
    return { ok: false, error: "spark_unavailable" };
  }

  let chosen = technique ? techniqueById(technique) : null;

  if (technique && !chosen) {
    throw new Error("UNKNOWN_TECHNIQUE");
  }

  if (!chosen && reroll?.length) {
    chosen = techniqueById(recent.lastTechnique);
  }

  return { ok: true, sparks, technique: chosen || pickTechnique(rng, TECHNIQUES, recent.techniques) };
}

// The name of the shape a spark has, or null (a trimmed pool can produce a composition no shape lists).
function shapeOf(spark) {
  const keys = Object.keys(spark).join(",");

  return SPARK_SHAPES.find((shape) => shape.ingredients.join(",") === keys)?.name || null;
}

function labelOf(name) {
  return SPARK_LABELS[name] || name.charAt(0).toUpperCase() + name.slice(1);
}

// One "Область: библиотека" line per ingredient, in the order the composer produced them.
function formatSpark(spark) {
  return Object.entries(spark).map(([name, value]) => `${labelOf(name)}: ${value}`).join("\n");
}

function formatTechnique(technique) {
  return `Приём «${technique.name}»: ${technique.how}`;
}

module.exports = {
  INGREDIENT_POOLS,
  INGREDIENTS,
  SPARK_SHAPES,
  SHAPE_NAMES,
  composeSpark,
  rerollSpark,
  rollSparks,
  pickTechnique,
  techniqueById,
  drawSparks,
  shapeOf,
  labelOf,
  formatSpark,
  formatTechnique
};
