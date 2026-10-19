const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const reporter = require("../helpers/githubReporter");

const ROOT = path.join(__dirname, "..", "..");

test("репортёр CI: упавший тест превращается в аннотацию с файлом, строкой и причиной", () => {
  const cause = new Error("expected 1\nactual 2");
  const error = Object.assign(new Error("test failed"), { cause });
  const line = reporter.formatAnnotation({
    name: "ответ приходит, это важно",
    file: path.join(ROOT, "tests", "integration", "bot-flow.test.js"),
    line: 42,
    details: { error }
  }, ROOT);

  assert.match(line, /^::error file=tests\/integration\/bot-flow\.test\.js,line=42,title=/);
  assert.match(line, /expected 1 \| actual 2\n$/, "переводы строк в сообщении не ломают команду");
  assert.equal(line.split("\n").length, 2, "одна команда - одна строка");
  assert.ok(!line.slice(0, line.indexOf("::", 2)).includes(",,"));
});

test("репортёр CI: спецсимволы экранируются, длинное сообщение обрезается, без причины есть текст по умолчанию", () => {
  assert.equal(reporter.escapeData("100%\r\nok"), "100%25%0D%0Aok");

  const line = reporter.formatAnnotation({ name: "а, б: в", details: { error: new Error("x".repeat(5000)) } }, ROOT);

  assert.match(line, /title=Тест упал%3A а%2C б%3A в::/);
  assert.ok(line.length < 1200);
  assert.match(reporter.formatAnnotation({ name: "n", details: {} }, ROOT), /::test failed\n$/);
});

test("репортёр CI: печатает аннотации только для упавших тестов и не больше десяти", async () => {
  const events = [{ type: "test:pass", data: { name: "ok" } }];

  for (let i = 0; i < 15; i += 1) {
    events.push({ type: "test:fail", data: { name: `bad ${i}`, details: { error: new Error(`boom ${i}`) } } });
  }

  const out = [];

  for await (const chunk of reporter((async function* () { yield* events; })())) {
    out.push(chunk);
  }

  assert.equal(out.length, 10);
  assert.ok(out.every((chunk) => chunk.startsWith("::error ")));
});
