const { sanitizeInline } = require("../utils/text");

// Arguments of a tool call are written by the model, which reads untrusted chat text.
// Every field is checked against an explicit rule; a field nobody declared is an error, not an extra.

const INTEGER_TEXT = /^[+-]?\d+$/;

function reject(error) {
  return { ok: false, error };
}

// Models often send numbers as strings ("5"); accept those, but nothing fractional or out of range.
function toInteger(raw) {
  const number = typeof raw === "string" && INTEGER_TEXT.test(raw.trim()) ? Number(raw.trim()) : raw;
  return Number.isSafeInteger(number) ? number : null;
}

function describeRange(rule) {
  return `${rule.min ?? "-inf"}..${rule.max ?? "inf"}`;
}

function parseOne(key, raw, rule) {
  switch (rule.type) {
    case "int": {
      const number = toInteger(raw);

      if (number === null || number < (rule.min ?? -Infinity) || number > (rule.max ?? Infinity)) {
        return reject(`${key} must be an integer in ${describeRange(rule)}`);
      }

      return { ok: true, value: number };
    }

    case "enum": {
      const candidate = typeof raw === "string" ? raw.trim().toLowerCase() : raw;
      const match = rule.values.find((value) => value === candidate || String(value) === String(candidate));

      if (match === undefined) {
        return reject(`${key} must be one of: ${rule.values.join(", ")}`);
      }

      return { ok: true, value: match };
    }

    case "string": {
      if (typeof raw !== "string") {
        return reject(`${key} must be a string`);
      }

      const max = rule.max ?? 100;
      // Reading one character more than allowed tells "too long" from "exactly at the limit".
      const clean = sanitizeInline(raw, max + 1);
      const length = Array.from(clean).length;

      if (length < (rule.min ?? 1)) {
        return reject(`${key} must not be empty`);
      }

      if (length > max) {
        return reject(`${key} is too long (max ${max} characters)`);
      }

      return { ok: true, value: clean };
    }

    case "bool": {
      if (typeof raw === "boolean") {
        return { ok: true, value: raw };
      }

      if (raw === "true" || raw === "false") {
        return { ok: true, value: raw === "true" };
      }

      return reject(`${key} must be true or false`);
    }

    case "object": {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return reject(`${key} must be an object`);
      }

      return { ok: true, value: raw };
    }

    case "list": {
      if (!Array.isArray(raw) || raw.length < (rule.minItems ?? 0) || raw.length > (rule.maxItems ?? 50)) {
        return reject(`${key} must be a list of ${rule.minItems ?? 0}..${rule.maxItems ?? 50} items`);
      }

      const items = [];

      for (const entry of raw) {
        const parsed = parseOne(key, entry, rule.item);

        if (!parsed.ok) {
          return parsed;
        }

        items.push(parsed.value);
      }

      return { ok: true, value: items };
    }

    case "custom":
      return rule.parse(raw);

    default:
      return reject(`${key}: unsupported rule`);
  }
}

// Returns { ok: true, value } with defaults applied, or { ok: false, error }.
// null/undefined count as "not given"; an unknown key is rejected unless it carries no value at all.
function parseArgs(args, spec) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return reject("arguments must be a JSON object");
  }

  for (const [key, raw] of Object.entries(args)) {
    if (!Object.hasOwn(spec, key) && raw !== null && raw !== undefined && raw !== "") {
      return reject(`unknown field: ${key}`);
    }
  }

  const value = {};

  for (const [key, rule] of Object.entries(spec)) {
    const raw = Object.hasOwn(args, key) ? args[key] : undefined;

    if (raw === undefined || raw === null) {
      if (rule.required) {
        return reject(`missing field: ${key}`);
      }

      if (Object.hasOwn(rule, "default")) {
        value[key] = rule.default;
      }

      continue;
    }

    const parsed = parseOne(key, raw, rule);

    if (!parsed.ok) {
      return parsed;
    }

    value[key] = parsed.value;
  }

  return { ok: true, value };
}

module.exports = {
  parseArgs,
  toInteger
};
