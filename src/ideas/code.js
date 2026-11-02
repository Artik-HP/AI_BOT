const crypto = require("crypto");
const { SPARK_POOLS, TECHNIQUES } = require("./catalog");
const { INGREDIENTS, INGREDIENT_POOLS } = require("./spark");

// A spark as a short code, so that a spark rolled on the website can be continued in Telegram (/spark <код>,
// t.me/bot?start=spark_<код>). The code is the place of every ingredient in its pool (0: the ingredient is absent),
// the place of the technique, and a check that depends on the catalog itself: after the pools or techniques change,
// an old code is refused ("от прежней версии"), never read as a different spark. Format: one digit of the catalog's
// version, five characters of indexes, two of the check — eight characters of [0-9A-Za-z_-], which Telegram accepts
// in a start parameter.

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
const BODY_LENGTH = 5;
const SPARK_CODE_PATTERN = /^[0-9][A-Za-z0-9_-]{7}$/;

function fingerprint(pools, techniques) {
  const catalog = { pools: INGREDIENTS.map((name) => pools[INGREDIENT_POOLS[name]] || []), techniques: techniques.map((entry) => entry.id) };

  return crypto.createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
}

function versionOf(print) {
  return String(parseInt(print.slice(0, 2), 16) % 10);
}

function checkOf(print, body) {
  const hash = crypto.createHash("sha256").update(`${print}:${body}`).digest();
  const bits = (hash[0] << 4) | (hash[1] >> 4);

  return ALPHABET[bits >> 6] + ALPHABET[bits & 63];
}

// Mixed radix: one digit per ingredient (pool size + 1, because 0 means "absent") and one for the technique.
function radixes(pools, techniques) {
  return [...INGREDIENTS.map((name) => (pools[INGREDIENT_POOLS[name]] || []).length + 1), techniques.length];
}

// Exported for tests: builds a code from raw indexes (1-based for ingredients, 0 for absent).
function encodeIndexes(indexes, techniqueIndex, { pools = SPARK_POOLS, techniques = TECHNIQUES } = {}) {
  const sizes = radixes(pools, techniques);
  const digits = [...indexes, techniqueIndex];
  let value = 0;

  for (const [position, digit] of digits.entries()) {
    value = value * sizes[position] + digit;
  }

  let body = "";

  for (let position = 0; position < BODY_LENGTH; position += 1) {
    body = ALPHABET[value % 64] + body;
    value = Math.floor(value / 64);
  }

  if (value) {
    throw new Error("SPARK_CODE_TOO_LARGE");
  }

  const print = fingerprint(pools, techniques);

  return `${versionOf(print)}${body}${checkOf(print, body)}`;
}

function encodeSpark(spark, technique, { pools = SPARK_POOLS, techniques = TECHNIQUES } = {}) {
  const indexes = INGREDIENTS.map((name) => {
    if (!Object.hasOwn(spark, name)) {
      return 0;
    }

    const place = (pools[INGREDIENT_POOLS[name]] || []).indexOf(spark[name]);

    if (place < 0) {
      throw new Error("SPARK_CODE_UNKNOWN_VALUE");
    }

    return place + 1;
  });
  const techniqueIndex = techniques.findIndex((entry) => entry.id === technique?.id);

  if (techniqueIndex < 0) {
    throw new Error("SPARK_CODE_UNKNOWN_VALUE");
  }

  return encodeIndexes(indexes, techniqueIndex, { pools, techniques });
}

const INVALID = { ok: false, error: "spark_code_invalid" };

// { ok: true, spark, technique } or { ok: false, error: "spark_code_invalid" | "spark_code_outdated" }. Checked:
// the format, the catalog version, the check, the ranges, an area present and at least two ingredients.
function decodeSpark(code, { pools = SPARK_POOLS, techniques = TECHNIQUES } = {}) {
  if (typeof code !== "string" || !SPARK_CODE_PATTERN.test(code)) {
    return INVALID;
  }

  const print = fingerprint(pools, techniques);
  const body = code.slice(1, 1 + BODY_LENGTH);

  if (code[0] !== versionOf(print)) {
    return { ok: false, error: "spark_code_outdated" };
  }

  if (code.slice(1 + BODY_LENGTH) !== checkOf(print, body)) {
    return INVALID;
  }

  let value = 0;

  for (const char of body) {
    value = value * 64 + ALPHABET.indexOf(char);
  }

  const sizes = radixes(pools, techniques);
  const digits = [];

  for (let position = sizes.length - 1; position >= 0; position -= 1) {
    digits.unshift(value % sizes[position]);
    value = Math.floor(value / sizes[position]);
  }

  if (value) {
    return INVALID;
  }

  const techniqueIndex = digits.pop();
  const spark = {};

  for (const [position, name] of INGREDIENTS.entries()) {
    if (digits[position]) {
      spark[name] = pools[INGREDIENT_POOLS[name]][digits[position] - 1];
    }
  }

  if (!spark.domain || Object.keys(spark).length < 2 || !techniques[techniqueIndex]) {
    return INVALID;
  }

  return { ok: true, spark, technique: techniques[techniqueIndex] };
}

module.exports = {
  SPARK_CODE_PATTERN,
  encodeSpark,
  encodeIndexes,
  decodeSpark
};
