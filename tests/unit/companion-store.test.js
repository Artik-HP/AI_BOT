process.env.LOG_LEVEL = "silent";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { CompanionStore } = require("../../src/companion/store");
const { createWorld } = require("../helpers/companionFixtures");

const put = (store, key, value) => store.change((data) => {
  data.facts[key] = value;
  return { ok: true };
});

test("запись переживает перезапуск: новый экземпляр читает тот же файл", () => {
  const world = createWorld();

  put(world.store, "a", [{ text: "любит шахматы", at: 1 }]);

  const reopened = new CompanionStore(world.file);

  assert.deepEqual(reopened.view((data) => data.facts.a), [{ text: "любит шахматы", at: 1 }]);
  assert.deepEqual(fs.readdirSync(world.dir).filter((name) => name.endsWith(".tmp")), [], "временных файлов не остаётся");
});

test("отказ (ok: false) и исключение в изменении не оставляют следов ни в памяти, ни на диске", () => {
  const world = createWorld();

  put(world.store, "a", [{ text: "первое", at: 1 }]);

  const before = fs.readFileSync(world.file);
  const refused = world.store.change((data) => {
    data.facts.b = ["мусор"];
    return { ok: false, error: "nope" };
  });

  assert.equal(refused.error, "nope");
  assert.throws(() => world.store.change((data) => {
    data.facts.c = ["мусор"];
    throw new Error("boom");
  }), /boom/);

  assert.ok(fs.readFileSync(world.file).equals(before));
  assert.deepEqual(Object.keys(world.store.view((data) => data.facts)), ["a"]);
});

test("view отдаёт копию: правка результата не меняет хранилище", () => {
  const world = createWorld();

  put(world.store, "a", [{ text: "первое", at: 1 }]);

  const copy = world.store.view((data) => data.facts);

  copy.a.push({ text: "лишнее", at: 2 });
  copy.z = [];
  assert.deepEqual(Object.keys(world.store.view((data) => data.facts)), ["a"]);
  assert.equal(world.store.view((data) => data.facts.a.length), 1);
});

test("резервная копия обновляется при каждой записи и хранит предыдущее состояние", () => {
  const world = createWorld();

  put(world.store, "a", ["раз"]);
  assert.equal(fs.existsSync(`${world.file}.bak`), false, "до первой перезаписи копировать нечего");
  put(world.store, "a", ["два"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${world.file}.bak`, "utf8")).facts.a, ["раз"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(world.file, "utf8")).facts.a, ["два"]);
});

test("повреждённый файл + хорошая копия: берётся копия, испорченное сохраняется отдельно", () => {
  const world = createWorld();

  put(world.store, "a", ["раз"]);
  put(world.store, "a", ["два"]);
  fs.writeFileSync(world.file, "{ это не json", "utf8");

  const restored = new CompanionStore(world.file);

  assert.deepEqual(restored.view((data) => data.facts.a), ["раз"]);

  const quarantined = fs.readdirSync(world.dir).filter((name) => name.includes(".corrupt-"));

  assert.equal(quarantined.length, 1);
  assert.equal(fs.readFileSync(`${world.dir}/${quarantined[0]}`, "utf8"), "{ это не json");
});

test("оба файла повреждены: старт с пустого, оба сохранены как .corrupt-*, процесс не падает", () => {
  const world = createWorld();

  fs.writeFileSync(world.file, "обрывок {", "utf8");
  fs.writeFileSync(`${world.file}.bak`, JSON.stringify({ version: 99 }), "utf8");

  const store = new CompanionStore(world.file);

  assert.deepEqual(store.view((data) => Object.keys(data.characters)), []);
  assert.equal(fs.readdirSync(world.dir).filter((name) => name.includes(".corrupt-")).length, 2);
  put(store, "a", ["новое"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(world.file, "utf8")).facts.a, ["новое"]);
});

test("файл другой версии или формы считается повреждённым", () => {
  const world = createWorld();

  fs.writeFileSync(world.file, JSON.stringify({ version: 2, characters: {} }), "utf8");
  assert.deepEqual(new CompanionStore(world.file).view((data) => data.reminders), []);
  assert.equal(fs.readdirSync(world.dir).filter((name) => name.includes(".corrupt-")).length, 1);
});

test("старый файл без новых разделов открывается: недостающее заполняется пустым", () => {
  const world = createWorld();

  fs.writeFileSync(world.file, JSON.stringify({ version: 1, characters: { 7: { name: "Х" } } }), "utf8");

  const store = new CompanionStore(world.file);

  assert.equal(store.view((data) => data.characters[7].name), "Х");
  assert.deepEqual(store.view((data) => [data.games, data.facts, data.reminders, data.retired, data.ledger]), [{}, {}, [], {}, {}]);
});

test("лимит размера: запись, не влезающая в файл, отклоняется, данные остаются прежними", () => {
  const world = createWorld({ maxBytes: 400 });

  put(world.store, "a", ["короткое"]);
  assert.throws(() => put(world.store, "b", ["x".repeat(1000)]), /COMPANION_STORE_SIZE/);
  assert.deepEqual(Object.keys(world.store.view((data) => data.facts)), ["a"]);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(world.file, "utf8")).facts), ["a"]);
});
