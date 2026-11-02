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

// Cuts to at most `maxLength` UTF-16 units without leaving half of a surrogate pair (an emoji) at the end.
function cutSafely(text, maxLength) {
  const source = String(text ?? "");

  if (source.length <= maxLength) {
    return source;
  }

  const cut = source.charCodeAt(maxLength - 1) >= 0xd800 && source.charCodeAt(maxLength - 1) <= 0xdbff
    ? maxLength - 1
    : maxLength;

  return source.slice(0, Math.max(0, cut));
}

// Telegram first/last names and similar profile fields go into prompts, so keep them short and flat.
function sanitizeInline(value, maxLength = 32) {
  const flat = String(value ?? "")
    .replace(STRIPPED_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();

  return Array.from(flat).slice(0, maxLength).join("");
}

// The form two short texts are compared in, so that "Любит кофе." and "любит  кофе" or "Ёлка-палка" and "елка палка"
// count as the same: lower case, "ё" as "е", any run of non-letters and non-digits as one space. A text of
// punctuation alone keeps itself, so that "!!" and "??" stay different.
function comparableText(value) {
  const source = String(value ?? "").toLowerCase();
  const key = source.replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

  return key || source;
}

// The form a searched text is compared in: lower case, "ё" as "е". Saving already compares titles and facts through
// comparableText, so searching must not tell "ёлка" from "елка" either.
function searchText(value) {
  return String(value ?? "").toLowerCase().replace(/ё/g, "е");
}

// The words of a search query: letters and digits from two characters on. Russian endings vary ("кофейня",
// "кофейни"), so a word longer than five characters is looked up by its stem without the last two. No morphology.
function searchTokens(query) {
  return searchText(query).match(/[\p{L}\p{N}]{2,}/gu)?.map((word) => (word.length > 5 ? word.slice(0, word.length - 2) : word)) || [];
}

// Removes trailing spaces and tabs from every line. The obvious /[ \t]+\n/g is quadratic on a long run of
// spaces (a megabyte of them freezes the process for minutes), this version is linear.
function trimLineEnds(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => {
      let end = line.length;

      while (end > 0 && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) {
        end -= 1;
      }

      return end === line.length ? line : line.slice(0, end);
    })
    .join("\n");
}

module.exports = {
  TELEGRAM_MESSAGE_LIMIT,
  sanitizeInline,
  splitMessage,
  cutSafely,
  comparableText,
  searchText,
  searchTokens,
  trimLineEnds
};
