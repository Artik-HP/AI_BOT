process.env.LOG_LEVEL = "silent";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const R = require("../../src/companion/rules");
const { TOOL_DEFINITIONS, TOOL_NAMES, executeTool, forgetChat, looksSecret, recentFacts } = require("../../src/companion/tools");
const { START, fixedRng, createWorld } = require("../helpers/companionFixtures");

const call = (ctx, name, args) => executeTool(name, JSON.stringify(args), ctx);

test("набор функций совпадает с тем, на что рассчитан промпт", () => {
  assert.deepEqual(TOOL_NAMES, [
    "roll_dice", "character_get", "character_update", "game_state_get", "game_state_save", "memory_save", "memory_search", "reminder_create"
  ]);
  assert.ok(TOOL_DEFINITIONS.every((tool) => tool.type === "function" && tool.function.parameters.type === "object"));
  assert.ok(TOOL_DEFINITIONS.every((tool) => !JSON.stringify(tool).match(/user_?id|chat_?id/i)), "идентификаторы людей и чатов модели не передаются");
});

test("roll_dice: кубик, модификатор, натуральные 20 и 1", () => {
  const world = createWorld();
  const roll = (rng, args) => call(world.ctxFor("1", "1", { rng: fixedRng(rng) }), "roll_dice", args);

  assert.deepEqual(roll([7], { sides: 20, modifier: 3 }), {
    ok: true, sides: 20, count: 1, mode: "normal", rolls: [7], kept: [7], modifier: 3, total: 10, natural: 7, critical: null
  });
  assert.equal(roll([20], { sides: 20 }).critical, "success");
  assert.equal(roll([1], { sides: 20 }).critical, "failure");
  assert.equal(roll([20], { sides: 6 }).critical, null, "критические только у d20");
});

test("roll_dice: преимущество берёт больший из двух, помеха — меньший, несколько кубиков суммируются", () => {
  const world = createWorld();
  const roll = (rng, args) => call(world.ctxFor("1", "1", { rng: fixedRng(rng) }), "roll_dice", args);

  assert.deepEqual([roll([4, 17], { sides: 20, mode: "advantage" }).rolls, roll([4, 17], { sides: 20, mode: "advantage" }).kept], [[4, 17], [17]]);
  assert.deepEqual(roll([4, 17], { sides: 20, mode: "disadvantage" }).kept, [4]);

  const damage = roll([2, 3, 4], { sides: 6, count: 3, modifier: -1 });

  assert.deepEqual([damage.total, damage.natural], [8, null]);
});

test("roll_dice: недопустимые параметры отклоняются, числа-строки принимаются", () => {
  const world = createWorld();
  const ctx = world.ctxFor();

  for (const args of [{ sides: 7 }, { sides: 20, count: 0 }, { sides: 20, count: 11 }, { sides: 20, modifier: 21 }, {}, { sides: 20, extra: 1 }, { sides: 20, count: 2, mode: "advantage" }, { sides: 20, mode: "lucky" }]) {
    assert.equal(call(ctx, "roll_dice", args).ok, false, JSON.stringify(args));
  }

  const lenient = call(world.ctxFor("1", "1", { rng: R.systemRng }), "roll_dice", { sides: "20", count: "2" });

  assert.equal(lenient.ok, true);
  assert.equal(lenient.rolls.length, 2);
});

test("roll_dice: настоящий генератор укладывается в границы и выдаёт все грани", () => {
  const ctx = createWorld().ctxFor("1", "1", { rng: R.systemRng });
  const faces = new Set();

  for (let index = 0; index < 600; index += 1) {
    const [value] = call(ctx, "roll_dice", { sides: 6 }).rolls;

    assert.ok(value >= 1 && value <= 6);
    faces.add(value);
  }

  assert.equal(faces.size, 6);
  assert.ok(call(ctx, "roll_dice", { sides: 100 }).rolls[0] <= 100);
});

test("executeTool не бросает исключений: мусорные имена и аргументы возвращают ok:false", () => {
  const ctx = createWorld().ctxFor();

  for (const [name, raw] of [
    ["nope", "{}"], ["__proto__", "{}"], ["constructor", "{}"], ["toString", "{}"],
    ["roll_dice", "{не json"], ["roll_dice", "[]"], ["roll_dice", "null"], ["roll_dice", "5"],
    ["roll_dice", `{"sides":20,"pad":"${"x".repeat(40000)}"}`],
    ["character_update", "{}"], ["character_get", "{\"user_id\":\"5\"}"], ["game_state_save", "{\"game\":5}"]
  ]) {
    assert.equal(executeTool(name, raw, ctx).ok, false, `${name} ${raw.slice(0, 24)}`);
  }

  assert.equal(executeTool("roll_dice", { sides: 20 }, ctx).ok, true, "уже разобранный объект тоже принимается");
  assert.equal(executeTool("roll_dice", "", ctx).error, "invalid_arguments", "пустая строка — это пустой объект, а sides обязателен");
});

test("сбой записи на диск превращается в ответ storage_error, а не в падение; данные остаются прежними", () => {
  const world = createWorld();
  const ctx = world.ctxFor();
  const original = fs.renameSync;

  assert.equal(call(ctx, "memory_save", { text: "первое" }).ok, true);
  fs.renameSync = () => {
    throw Object.assign(new Error("disk is gone"), { code: "EIO" });
  };

  try {
    assert.equal(call(ctx, "memory_save", { text: "второе" }).error, "storage_error");
  } finally {
    fs.renameSync = original;
  }

  assert.deepEqual(call(ctx, "memory_search", {}).facts, ["первое"], "неудавшаяся запись не просочилась в память");
  assert.equal(call(ctx, "memory_save", { text: "второе" }).ok, true, "после починки диска всё работает");
});

test("состояние игры: запись, чтение, перезапись целиком, список и удаление", () => {
  const world = createWorld();
  const ctx = world.ctxFor("1", "-100");
  const state = { room: 3, hp: 12, secret: "ключ под ковром" };

  assert.deepEqual(call(ctx, "game_state_get", { game: "dungeon" }), { ok: true, exists: false, game: "dungeon" });
  assert.equal(call(ctx, "game_state_save", { game: "Dungeon", state }).ok, true);

  const loaded = call(ctx, "game_state_get", { game: "dungeon" });

  assert.deepEqual([loaded.exists, loaded.state], [true, state]);
  call(ctx, "game_state_save", { game: "dungeon", state: { room: 4 } });
  assert.deepEqual(call(ctx, "game_state_get", { game: "dungeon" }).state, { room: 4 }, "состояние заменяется, а не сливается");
  call(ctx, "game_state_save", { game: "quiz", state: { score: 1 } });
  assert.deepEqual(call(ctx, "game_state_get", {}).games.map((entry) => entry.game).sort(), ["dungeon", "quiz"]);
  assert.equal(call(ctx, "game_state_save", { game: "dungeon", delete: true }).deleted, true);
  assert.equal(call(ctx, "game_state_save", { game: "dungeon", delete: true }).error, "not_found");
  assert.equal(call(ctx, "game_state_get", { game: "dungeon" }).exists, false);
});

test("состояние игры принадлежит чату: общее для группы, чужим чатам не видно", () => {
  const world = createWorld();
  const first = world.ctxFor("1", "-100");
  const teammate = world.ctxFor("2", "-100");
  const elsewhere = world.ctxFor("1", "-200");
  const privateChat = world.ctxFor("1", "1");

  call(first, "game_state_save", { game: "raid_boss", state: { hp: 900 } });
  assert.deepEqual(call(teammate, "game_state_get", { game: "raid_boss" }).state, { hp: 900 }, "участники одной группы играют в одно состояние");
  assert.equal(call(elsewhere, "game_state_get", { game: "raid_boss" }).exists, false);
  assert.equal(call(privateChat, "game_state_get", { game: "raid_boss" }).exists, false);
});

test("состояние игры: ограничения на ключ, размер, глубину и опасные ключи", () => {
  const ctx = createWorld().ctxFor("1", "-100");
  const save = (args) => call(ctx, "game_state_save", args);
  let deep = { leaf: true };

  for (let level = 0; level < 8; level += 1) {
    deep = { next: deep };
  }

  assert.equal(save({ game: "a b", state: {} }).error, "invalid_game_key");
  assert.equal(save({ game: "x/y", state: {} }).error, "invalid_game_key");
  assert.equal(save({ game: "g", state: [1, 2] }).ok, false);
  assert.equal(save({ game: "g" }).error, "state_must_be_an_object");
  assert.equal(save({ game: "g", state: { text: "я".repeat(R.LIMITS.gameStateBytes) } }).error, "state_too_large");
  assert.equal(save({ game: "g", state: deep }).error, "state_too_deep_or_has_forbidden_keys");
  assert.equal(executeTool("game_state_save", "{\"game\":\"g\",\"state\":{\"__proto__\":{\"x\":1}}}", ctx).error, "state_too_deep_or_has_forbidden_keys");
  assert.equal(save({ game: "ключ-1", state: { ok: 1 } }).ok, true, "русские буквы в ключе допустимы");
});

test("состояние игры: не больше 20 ключей на чат, существующий можно обновлять", () => {
  const ctx = createWorld().ctxFor("1", "-100");

  for (let index = 0; index < R.LIMITS.gamesPerChat; index += 1) {
    assert.equal(call(ctx, "game_state_save", { game: `g${index}`, state: { n: index } }).ok, true);
  }

  assert.equal(call(ctx, "game_state_save", { game: "extra", state: {} }).error, "too_many_games");
  assert.equal(call(ctx, "game_state_save", { game: "g0", state: { n: 99 } }).ok, true);
});

test("память: сохранение, поиск по основе слова, дубликаты, область — только этот человек в этом чате", () => {
  const world = createWorld();
  const me = world.ctxFor("1", "-100");
  const remember = (ctx, text) => call(ctx, "memory_save", { text });
  const recall = (ctx, query) => call(ctx, "memory_search", query === undefined ? {} : { query });

  assert.equal(remember(me, "Любит играть в шахматы").ok, true);
  assert.equal(remember(me, "Живёт в часовом поясе UTC+3").total, 2);
  assert.deepEqual(recall(me, "шахматах").facts, ["Любит играть в шахматы"]);
  assert.deepEqual(recall(me, "футбол").facts, []);
  assert.equal(recall(me).facts.length, 2);

  const duplicate = remember(me, "любит играть в ШАХМАТЫ");

  assert.deepEqual([duplicate.duplicate, duplicate.total], [true, 2]);
  assert.deepEqual(recall(world.ctxFor("2", "-100"), "шахматы").facts, [], "другой человек в том же чате");
  assert.deepEqual(recall(world.ctxFor("1", "1"), "шахматы").facts, [], "тот же человек в личном чате");
});

test("память: поиск не различает «ё» и «е», как и сохранение фактов", () => {
  const world = createWorld();
  const me = world.ctxFor("1", "1");

  call(me, "memory_save", { text: "Любит ёлочные игрушки" });
  call(me, "memory_save", { text: "Живет за городом" });

  assert.deepEqual(call(me, "memory_search", { query: "елочные" }).facts, ["Любит ёлочные игрушки"]);
  assert.deepEqual(call(me, "memory_search", { query: "живёт" }).facts, ["Живет за городом"]);
});

test("память: пароли, карты, документы и телефоны не сохраняются; обычные факты проходят", () => {
  const ctx = createWorld().ctxFor();

  for (const text of [
    "мой пароль qwerty123", "номер карты 4276 1234 5678 9012", "паспорт 4510 123456", "CVV 123",
    "api key sk-1234", "seed phrase: apple banana", "мой телефон +7 999 123 45 67", "ИНН 123"
  ]) {
    assert.equal(call(ctx, "memory_save", { text }).error, "looks_like_a_secret", text);
    assert.equal(looksSecret(text), true, text);
  }

  for (const text of ["день рождения 12 мая", "играет по пятницам в 20:00", "подругу зовут Инна", "любит детективы"]) {
    assert.equal(call(ctx, "memory_save", { text }).ok, true, text);
  }
});

test("память: не больше 40 фактов на человека, вытесняется самый старый", () => {
  const world = createWorld();
  const ctx = world.ctxFor();

  for (let index = 1; index <= R.LIMITS.factsPerScope + 5; index += 1) {
    world.clock.now += 1000;
    call(ctx, "memory_save", { text: `факт номер ${index}` });
  }

  const stored = world.store.view((data) => data.facts["100:100"].map((fact) => fact.text));

  assert.equal(stored.length, R.LIMITS.factsPerScope);
  assert.ok(!stored.includes("факт номер 1") && stored.includes("факт номер 45"));
  assert.equal(recentFacts(world.store, "100", "100", 3)[0], "факт номер 45", "в промпт идут самые свежие");
});

test("«очистить память» забывает факты этого чата и не трогает соседние", () => {
  const world = createWorld();

  call(world.ctxFor("1", "-100"), "memory_save", { text: "любит шахматы" });
  call(world.ctxFor("2", "-100"), "memory_save", { text: "любит футбол" });
  call(world.ctxFor("1", "-1001"), "memory_save", { text: "любит чай" });
  call(world.ctxFor("1", "1"), "character_get", {});
  assert.equal(forgetChat(world.store, "-100"), 2);
  assert.deepEqual(Object.keys(world.store.view((data) => data.facts)), ["-1001:1"], "чат -1001 не путается с -100");

  const before = fs.readFileSync(world.file);

  assert.equal(forgetChat(world.store, "-100"), 0);
  assert.ok(fs.readFileSync(world.file).equals(before), "нечего забывать — файл не переписывается");
});

test("напоминание: через N минут и на дату с часовым поясом; хранится с адресом и именем", () => {
  const world = createWorld();
  const ctx = world.ctxFor("1", "-5", { isGroup: true });
  const soon = call(ctx, "reminder_create", { text: "позвонить маме", in_minutes: 30 });
  const dated = call(ctx, "reminder_create", { text: "созвон", at: "2026-10-30T09:00:00+03:00" });

  assert.equal(soon.ok, true);
  assert.match(soon.id, /^[0-9a-f]{8}$/);
  assert.equal(soon.dueAtUtc, new Date(START + 30 * 60000).toISOString());
  assert.equal(dated.dueAtUtc, "2026-10-30T06:00:00.000Z");

  const [first] = world.store.view((data) => data.reminders);

  assert.deepEqual([first.chatId, first.userId, first.name, first.group, first.text], ["-5", "1", "Вася", true, "позвонить маме"]);
});

test("напоминание: нужно ровно одно из in_minutes и at; прошлое, слишком близкое и слишком далёкое время отклоняются", () => {
  const ctx = createWorld().ctxFor();
  const remind = (args) => call(ctx, "reminder_create", { text: "дело", ...args });

  assert.equal(remind({}).error, "give_exactly_one_of_in_minutes_or_at");
  assert.equal(remind({ in_minutes: 5, at: "2026-10-30T09:00:00Z" }).error, "give_exactly_one_of_in_minutes_or_at");
  assert.equal(remind({ at: "2026-10-30T09:00:00" }).error, "at_must_be_iso_8601_with_utc_offset", "без часового пояса время не принимается");
  assert.equal(remind({ at: "tomorrow 9am" }).error, "at_must_be_iso_8601_with_utc_offset");
  assert.equal(remind({ at: "2026-10-29T11:00:00Z" }).error, "time_is_in_the_past_or_too_soon");
  assert.equal(remind({ at: "2026-10-29T12:00:10Z" }).error, "time_is_in_the_past_or_too_soon");
  assert.equal(remind({ at: "2028-01-01T00:00:00Z" }).error, "too_far_ahead");
  assert.equal(remind({ in_minutes: 525600 }).ok, true, "ровно год — допустимо");
  assert.equal(remind({ in_minutes: 0 }).ok, false);
  assert.equal(call(ctx, "reminder_create", { text: "  ", in_minutes: 5 }).ok, false);
});

test("напоминание: не больше 10 на человека и 30 на чат, текст очищается", () => {
  const world = createWorld();

  for (let index = 0; index < R.LIMITS.remindersPerUser; index += 1) {
    assert.equal(call(world.ctxFor("1", "-5"), "reminder_create", { text: `дело ${index}`, in_minutes: 10 }).ok, true);
  }

  assert.equal(call(world.ctxFor("1", "-5"), "reminder_create", { text: "лишнее", in_minutes: 10 }).error, "too_many_reminders");

  for (const user of ["2", "3"]) {
    for (let index = 0; index < R.LIMITS.remindersPerUser; index += 1) {
      call(world.ctxFor(user, "-5"), "reminder_create", { text: `дело ${index}`, in_minutes: 10 });
    }
  }

  assert.equal(call(world.ctxFor("4", "-5"), "reminder_create", { text: "ещё", in_minutes: 10 }).error, "too_many_reminders_in_chat");
  assert.equal(call(world.ctxFor("4", "-6"), "reminder_create", { text: "в другом чате", in_minutes: 10 }).ok, true);

  const clean = createWorld();

  call(clean.ctxFor(), "reminder_create", { text: "купить\nхлеб\u0000", in_minutes: 5 });
  assert.equal(clean.store.view((data) => data.reminders[0].text), "купить хлеб");
});
