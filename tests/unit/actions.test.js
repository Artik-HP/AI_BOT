process.env.LOG_LEVEL = "silent";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createActionRegistry, ideaMarkers, ideaReplyRows, PREFIX } = require("../../src/handlers/actions");

const row = (...labels) => labels.map((label) => ({ text: label, data: { label } }));
const tokensOf = (keyboard) => keyboard.markup.inline_keyboard.flat().map((button) => button.callback_data);

test("реестр кнопок: callback_data — act:<токен> не длиннее 64 байт; токен знает чат, человека, вид, данные и сообщение", () => {
  const registry = createActionRegistry();
  const keyboard = registry.create({ chatId: -100500, userId: 7, kind: "ideas", rows: [row("Развей 1", "Развей 2")] });
  const [first, second] = tokensOf(keyboard);

  assert.ok([first, second].every((data) => data.startsWith(PREFIX) && Buffer.byteLength(data) <= 64));
  assert.notEqual(first, second);
  assert.equal(registry.resolve(first).messageId, null, "до отправки сообщение неизвестно");

  keyboard.attach(321);

  assert.deepEqual({ ...registry.resolve(second), lease: undefined, expires: undefined },
    { chatId: "-100500", userId: "7", kind: "ideas", data: { label: "Развей 2" }, messageId: 321, anySession: false, lease: undefined, expires: undefined });
  assert.equal(registry.resolve("menu:abc"), null, "чужой префикс — не наш");
  assert.equal(registry.resolve(`${PREFIX}нет-такого`), null);
});

test("одна клавиатура каждого вида на человека в чате: новая гасит старую; другие виды, люди и чаты не трогаются", () => {
  const registry = createActionRegistry();
  const old = registry.create({ chatId: 1, userId: 1, kind: "ideas", rows: [row("a")] });

  old.attach(10);

  const spark = registry.create({ chatId: 1, userId: 1, kind: "spark", rows: [row("s")] });
  const other = registry.create({ chatId: 1, userId: 2, kind: "ideas", rows: [row("b")] });
  const elsewhere = registry.create({ chatId: 5, userId: 1, kind: "ideas", rows: [row("c")] });
  const fresh = registry.create({ chatId: 1, userId: 1, kind: "ideas", rows: [row("d")] });

  assert.equal(fresh.previousMessageId, 10, "старое сообщение известно, чтобы снять с него кнопки");
  assert.equal(registry.resolve(tokensOf(old)[0]), null);
  assert.ok([spark, other, elsewhere, fresh].every((keyboard) => registry.resolve(tokensOf(keyboard)[0])));
});

test("отзыв человека гасит все его кнопки; сутки жизни; общее число ограничено — вытесняются самые старые", () => {
  const clock = { now: 0 };
  const registry = createActionRegistry({ now: () => clock.now, ttlMs: 1000, maxTokens: 3 });
  const mine = registry.create({ chatId: 1, userId: 1, kind: "spark", rows: [row("a")] });
  const theirs = registry.create({ chatId: 1, userId: 2, kind: "spark", rows: [row("b")] });

  registry.revokeUser(1);
  registry.revokeUser(1);
  assert.equal(registry.resolve(tokensOf(mine)[0]), null);
  assert.ok(registry.resolve(tokensOf(theirs)[0]));

  clock.now = 1000;
  assert.equal(registry.resolve(tokensOf(theirs)[0]), null, "через сутки кнопка устарела");

  const many = registry.create({ chatId: 2, userId: 3, kind: "ideas", rows: [row("1", "2", "3", "4", "5")] });

  assert.equal(registry.size, 3);
  assert.equal(registry.resolve(tokensOf(many)[0]), null, "вытеснена самая старая");
  assert.ok(registry.resolve(tokensOf(many)[4]));
});

test("маркеры идей: 1️⃣ 2️⃣ 3️⃣ ищутся готовыми строками, и с U+FE0F, и без; меньше двух — кнопок нет", () => {
  const keycap = (digit, style = true) => `${digit}${style ? String.fromCodePoint(0xfe0f) : ""}${String.fromCodePoint(0x20e3)}`;

  assert.deepEqual(ideaMarkers(`${keycap(1)} Кофейня\n${keycap(2)} Библиотека\n${keycap(3)} Двор`), ["1", "2", "3"]);
  assert.deepEqual(ideaMarkers(`${keycap(1, false)} раз ${keycap(3, false)} три`), ["1", "3"]);
  assert.deepEqual(ideaMarkers("1. просто список 2. без эмодзи"), []);
  assert.equal(ideaReplyRows(`${keycap(2)} одна идея`, { bankEnabled: true }), null);

  const rows = ideaReplyRows(`${keycap(1)} a ${keycap(2)} b`, { bankEnabled: true });

  assert.deepEqual(rows.map((line) => line.map((button) => button.text)), [["Развей 1", "Развей 2"], ["💾 1", "💾 2"], ["🔁 Ещё", "📊 Оцени"]]);
  assert.deepEqual(rows.flat().map((button) => button.data.text), ["развей 1", "развей 2", "сохрани идею 1 в банк", "сохрани идею 2 в банк", "ещё", "оцени эти идеи"]);
  assert.deepEqual(ideaReplyRows(`${keycap(1)} a ${keycap(2)} b`).map((line) => line.length), [2, 2], "без банка — без «💾»");
});
