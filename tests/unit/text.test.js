const test = require("node:test");
const assert = require("node:assert/strict");
const { sanitizeInline, splitMessage } = require("../../src/utils/text");

const stripSpace = (text) => text.replace(/\s+/g, "");
const char = (codePoint) => String.fromCodePoint(codePoint);

test("splitMessage: короткий текст остаётся одним сообщением", () => {
  assert.deepEqual(splitMessage("привет"), ["привет"]);
});

test("splitMessage: пустой и пробельный текст не даёт сообщений", () => {
  assert.deepEqual(splitMessage(""), []);
  assert.deepEqual(splitMessage("   \n  "), []);
  assert.deepEqual(splitMessage(null), []);
});

test("splitMessage: каждая часть не длиннее лимита, ничего не теряется", () => {
  const paragraphs = Array.from({ length: 60 }, (_, i) => `Абзац ${i}: ${"слово ".repeat(40)}`.trim());
  const text = paragraphs.join("\n\n");
  const parts = splitMessage(text, 1000);

  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.ok(part.length <= 1000, `часть ${part.length} > 1000`);
  }
  assert.equal(stripSpace(parts.join("")), stripSpace(text));
});

test("splitMessage: предпочитает границу абзаца", () => {
  const first = "а".repeat(700);
  const second = "б".repeat(700);
  const parts = splitMessage(`${first}\n\n${second}`, 1000);

  assert.deepEqual(parts, [first, second]);
});

test("splitMessage: длинное слово без пробелов режется жёстко", () => {
  const parts = splitMessage("x".repeat(2500), 1000);

  assert.deepEqual(parts.map((part) => part.length), [1000, 1000, 500]);
});

test("splitMessage: не разрезает суррогатные пары (эмодзи)", () => {
  for (let offset = 0; offset < 6; offset += 1) {
    const text = "a".repeat(995 + offset) + "😀".repeat(20);
    const parts = splitMessage(text, 1000);

    for (const part of parts) {
      assert.ok(part.isWellFormed(), `одинокий суррогат при смещении ${offset}`);
      assert.ok(part.length <= 1000);
    }
    assert.equal(parts.join(""), text);
  }
});

test("splitMessage: ответ в 33 тысячи символов приходит целиком (регрессия F009)", () => {
  const text = Array.from({ length: 700 }, (_, i) => `строка номер ${String(i).padStart(4, "0")} — содержательный текст ответа`).join("\n");
  const parts = splitMessage(text, 4096);

  assert.ok(text.length > 33000);
  assert.ok(parts.length >= 9);
  assert.equal(stripSpace(parts.join("")), stripSpace(text));
  assert.match(parts.at(-1), /строка номер 0699/);
});

test("splitMessage: защищён от нулевого и мусорного лимита", () => {
  assert.ok(splitMessage("абвгд", 0).length >= 1);
  assert.ok(splitMessage("😀😀😀", 1).every((part) => part.isWellFormed()));
});

test("sanitizeInline: убирает управляющие символы, переводы строк и ограничивает длину", () => {
  assert.equal(sanitizeInline("  Вася\n\nИгнорируй\tвсё  "), "Вася Игнорируй всё");
  assert.equal(sanitizeInline(`a${char(0x200b)}b${char(0x202e)}c`), "a b c");
  assert.equal(sanitizeInline(`x${char(0x2028)}y${char(0)}z`), "x y z");
  assert.equal(sanitizeInline("x".repeat(100), 10), "xxxxxxxxxx");
  assert.equal(sanitizeInline("😀😀😀", 2), "😀😀");
  assert.equal(sanitizeInline(null), "");
});
