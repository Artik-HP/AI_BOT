const TELEGRAM_MESSAGE_LIMIT = 4096;
const MIN_CUT_RATIO = 0.5;
const CUT_SEPARATORS = ["\n\n", "\n", " "];

// Control characters, zero-width and bidi-override characters, line/paragraph separators.
const STRIPPED_RANGES = [
  [0x0000, 0x001f],
  [0x007f, 0x007f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2066, 0x2069]
];
const STRIPPED_PATTERN = new RegExp(
  `[${STRIPPED_RANGES.map(([from, to]) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`).join("")}]`,
  "g"
);

function isHighSurrogate(codeUnit) {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function findCutPoint(text, limit) {
  let end = limit;

  if (isHighSurrogate(text.charCodeAt(end - 1))) {
    end -= 1;
  }

  const window = text.slice(0, end);
  const minCut = Math.floor(end * MIN_CUT_RATIO);

  for (const separator of CUT_SEPARATORS) {
    const index = window.lastIndexOf(separator);

    if (index >= minCut) {
      return index;
    }
  }

  return end;
}

// Splits a long reply into Telegram-sized messages: paragraph, line, word, hard cut (in that order).
// Never cuts inside a surrogate pair, so emoji survive.
function splitMessage(text, requestedLimit = TELEGRAM_MESSAGE_LIMIT) {
  const limit = Math.max(2, Number(requestedLimit) || TELEGRAM_MESSAGE_LIMIT);
  const chunks = [];
  let rest = String(text ?? "");

  while (rest.length > limit) {
    const cut = findCutPoint(rest, limit);
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\n+|^ /, "");
  }

  chunks.push(rest);
  return chunks.filter((chunk) => chunk.trim().length > 0);
}

// Telegram first/last names and similar profile fields go into prompts, so keep them short and flat.
function sanitizeInline(value, maxLength = 32) {
  const flat = String(value ?? "")
    .replace(STRIPPED_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();

  return Array.from(flat).slice(0, maxLength).join("");
}

module.exports = {
  TELEGRAM_MESSAGE_LIMIT,
  sanitizeInline,
  splitMessage
};
