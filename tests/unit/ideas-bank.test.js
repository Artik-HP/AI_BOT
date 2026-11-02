process.env.LOG_LEVEL = "silent";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const R = require("../../src/companion/rules");
const { CompanionStore } = require("../../src/companion/store");
const { TOOL_NAMES, IDEA_PERSONA_TOOLS, toolsFor, createToolContext, executeTool, forgetChat } = require("../../src/companion/tools");
const { ERROR_HINTS } = require("../../src/companion/hints");
const bank = require("../../src/ideas/bank");
const { IDEA_TOOL_DEFINITIONS } = require("../../src/ideas/tools");
const { SPARK_POOLS, TECHNIQUES } = require("../../src/ideas/catalog");
const { fixedRng, createWorld } = require("../helpers/companionFixtures");

const call = (ctx, name, args) => executeTool(name, JSON.stringify(args), ctx);
const idea = (title, extra = {}) => ({ title, pitch: `Суть идеи «${title}» в паре слов.`, ...extra });
const titles = (result) => result.ideas.map((entry) => entry.title);

test("наборы функций: идеи — свои четыре плюс память и напоминания, собеседник — прежние восемь", () => {
  const ideas = toolsFor("ideas");
  const companion = toolsFor("companion");

  assert.deepEqual(ideas.names, ["idea_spark", "idea_save", "idea_list", "idea_update", "memory_save", "memory_search", "reminder_create"]);
  assert.deepEqual(ideas.names, IDEA_PERSONA_TOOLS);
  assert.deepEqual(ideas.definitions.map((tool) => tool.function.name), ideas.names);
  assert.deepEqual(companion.names, TOOL_NAMES);
  assert.deepEqual(companion.definitions.map((tool) => tool.function.name), TOOL_NAMES);

  for (const tool of [...ideas.definitions, ...companion.definitions]) {
    assert.equal(tool.type, "function");
    assert.equal(tool.function.parameters.type, "object");
    assert.ok(tool.function.description.length > 20, tool.function.name);
  }

  assert.ok(IDEA_TOOL_DEFINITIONS.every((tool) => !JSON.stringify(tool).match(/user_?id|chat_?id/i)), "идентификаторы людей и чатов модели не передаются");
});

test("набор функций — часть запроса: чужой характер недоступен, даже если модель выдумала вызов", () => {
  const world = createWorld();
  const forIdeas = world.ctxFor("1", "1", { allowed: new Set(IDEA_PERSONA_TOOLS) });
  const forCompanion = world.ctxFor("1", "1", { allowed: new Set(TOOL_NAMES) });
  const unrestricted = world.ctxFor("1", "1");

  for (const [name, args] of [["roll_dice", { sides: 6 }], ["character_get", {}], ["character_update", { action: "retire", confirm: true }], ["game_state_save", { game: "x", state: {} }]]) {
    const refused = call(forIdeas, name, args);

    assert.equal(refused.ok, false, name);
    assert.equal(refused.error, "unknown_tool", name);
    assert.deepEqual(refused.tools, IDEA_PERSONA_TOOLS, "модель видит, что ей доступно на самом деле");
  }

  assert.equal(call(forIdeas, "idea_save", idea("Своя идея")).ok, true);
  assert.equal(call(forIdeas, "memory_save", { text: "любит шахматы" }).ok, true, "общие функции работают");
  assert.equal(call(forCompanion, "idea_save", idea("Чужая идея")).error, "unknown_tool", "идеи не доступны собеседнику");
  assert.equal(call(forCompanion, "roll_dice", { sides: 6 }).ok, true);
  assert.equal(call(unrestricted, "roll_dice", { sides: 6 }).ok, true, "без списка ограничений нет (как в прежних тестах и вызовах)");
  assert.equal(world.store.view((data) => Object.keys(data.characters).length), 0, "отказ ничего не записал");
});

test("createToolContext: список разрешённых функций становится множеством; без него — null", () => {
  const world = createWorld();
  const base = { chatId: 1, userId: 2, store: world.store };

  assert.deepEqual([...createToolContext({ ...base, allowed: ["idea_save"] }).allowed], ["idea_save"]);
  assert.equal(createToolContext(base).allowed, null);
});

test("idea_spark: искры и приём от сервера; повторяемо при скриптованном генераторе; можно три", () => {
  const world = createWorld();
  const known = new Set(Object.values(SPARK_POOLS).flat());
  const ctx = world.ctxFor("1", "1", { rng: fixedRng([2, 5, 1, 7, 3, 3, 0]) });
  const one = call(ctx, "idea_spark", {});

  assert.equal(one.ok, true);
  assert.equal(one.sparks.length, 1);
  assert.deepEqual(Object.keys(one.technique), ["id", "name", "how"]);
  assert.ok(TECHNIQUES.some((technique) => technique.id === one.technique.id));
  assert.deepEqual(call(world.ctxFor("1", "1", { rng: fixedRng([2, 5, 1, 7, 3, 3, 0]) }), "idea_spark", {}), one, "тот же набор чисел — тот же результат");

  const three = call(world.ctxFor("1", "1", { rng: R.systemRng }), "idea_spark", { count: "3" });

  assert.equal(three.sparks.length, 3);
  assert.equal(new Set(three.sparks.map((spark) => JSON.stringify(spark))).size, 3, "искры в одном ответе разные");
  assert.ok(three.sparks.every((spark) => Object.values(spark).every((value) => known.has(value))));
});

test("idea_spark: мусорные аргументы отклоняются; сломанный генератор — ответ spark_unavailable, а не падение", () => {
  const world = createWorld();
  const ctx = world.ctxFor();

  for (const args of [{ count: 0 }, { count: 4 }, { count: "много" }, { count: 1.5 }, { nope: 1 }]) {
    assert.equal(call(ctx, "idea_spark", args).ok, false, JSON.stringify(args));
  }

  const broken = world.ctxFor("1", "1", { rng: { int() { throw new Error("rng is down"); } } });

  assert.deepEqual(call(broken, "idea_spark", {}), { ok: false, error: "spark_unavailable", hint: ERROR_HINTS.spark_unavailable }, "отказ с подсказкой и без подробностей сбоя");
});

test("idea_save: сохраняет и выдаёт код; то же название обновляет идею; теги чистятся; всё на диске", () => {
  const world = createWorld();
  const ctx = world.ctxFor("1", "1");
  const saved = call(ctx, "idea_save", idea("Кофейня-библиотека", { tags: ["#Кофе", "город", "кофе"], next_step: "Поговорить с хозяином кофейни" }));

  assert.equal(saved.ok, true);
  assert.match(saved.id, /^[0-9a-f]{8}$/);
  assert.deepEqual([saved.saved, saved.total], [true, 1]);

  world.clock.now += 5000;

  const again = call(ctx, "idea_save", { title: "кофейня-библиотека", pitch: "Новая суть идеи, уточнённая." });

  assert.deepEqual([again.id, again.updated, again.total], [saved.id, true, 1], "повтор не плодит дубликатов");

  const [stored] = call(ctx, "idea_list", {}).ideas;

  assert.deepEqual(stored, {
    id: saved.id,
    title: "Кофейня-библиотека",
    pitch: "Новая суть идеи, уточнённая.",
    tags: ["кофе", "город"],
    next_step: "Поговорить с хозяином кофейни",
    status: "new",
    saved: "2026-10-29"
  });

  const onDisk = JSON.parse(fs.readFileSync(world.file, "utf8"));

  assert.equal(onDisk.ideas["1:1"].length, 1, "запись на диске есть сразу после вызова");
});

test("idea_save: пароли, карты и ключи отклоняются, обычные слова про пароли и секреты — нет; отказ ничего не пишет", () => {
  const world = createWorld();
  const ctx = world.ctxFor();

  for (const pitch of [
    "Пароль: hunter2hunter2 и ещё что-то",
    "Оплата с карты 4111 1111 1111 1111 на сайте",
    "Ключ sk-abcdefghijklmnopqrstuvwxyz123456 для доступа",
    "Токен 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw для бота",
    "password=correcthorsebatterystaple"
  ]) {
    assert.equal(call(ctx, "idea_save", idea("Секрет", { pitch })).error, "looks_like_a_secret", pitch);
  }

  assert.equal(call(ctx, "idea_list", {}).total, 0);

  for (const [title, pitch] of [
    ["Менеджер паролей для бабушек", "Приложение, которое хранит пароли и подсказывает надёжные."],
    ["Ресторан с секретным меню", "Секретное блюдо открывается тем, кто назовёт кодовое слово."],
    ["Краудфандинг на 100 000 000 ₽", "Большой сбор на общий двор для всего района."]
  ]) {
    assert.equal(call(ctx, "idea_save", { title, pitch }).ok, true, title);
  }
});

test("idea_save: границы полей и лишние поля — invalid_arguments", () => {
  const world = createWorld();
  const ctx = world.ctxFor();
  const ok = idea("Нормальная");

  for (const args of [
    {}, { title: "Без сути" }, { pitch: "Нет названия у этой идеи" },
    { ...ok, title: "а" }, { ...ok, title: "я".repeat(81) },
    { ...ok, pitch: "мало" }, { ...ok, pitch: "я".repeat(601) },
    { ...ok, tags: ["1", "2", "3", "4", "5", "6"] }, { ...ok, tags: ["я".repeat(25)] }, { ...ok, tags: "1, 2, 3, 4, 5, 6" }, { ...ok, tags: 5 },
    { ...ok, next_step: "я".repeat(201) }, { ...ok, extra: "поле" }, { ...ok, user_id: "5" }
  ]) {
    assert.equal(call(ctx, "idea_save", args).error, "invalid_arguments", JSON.stringify(args).slice(0, 60));
  }

  assert.equal(call(ctx, "idea_save", { ...ok, title: "я".repeat(80), pitch: "я".repeat(600), tags: ["1", "2", "3", "4", "5"] }).ok, true, "ровно на пределе — можно");
  assert.equal(call(ctx, "idea_list", {}).total, 1, "отклонённое не сохранилось");
});

test("idea_list: новые сверху; запрос ищет по словам и основам слов; статус и лимит; чужие идеи не видны", () => {
  const world = createWorld();
  const ctx = world.ctxFor("1", "1");

  call(ctx, "idea_save", idea("Кофейня-библиотека", { tags: ["город"] }));
  world.clock.now += 1000;
  call(ctx, "idea_save", idea("Будильник-вопрос"));
  world.clock.now += 1000;
  call(ctx, "idea_save", idea("Книжный клуб в кофейне"));

  const all = call(ctx, "idea_list", {});

  assert.deepEqual(titles(all), ["Книжный клуб в кофейне", "Будильник-вопрос", "Кофейня-библиотека"]);
  assert.deepEqual([all.total, all.matched], [3, 3]);
  assert.deepEqual(titles(call(ctx, "idea_list", { query: "кофейня" })), ["Книжный клуб в кофейне", "Кофейня-библиотека"], "основа слова находит и «кофейне»");
  assert.deepEqual(titles(call(ctx, "idea_list", { query: "город" })), ["Кофейня-библиотека"], "ищет и по тегам");
  assert.deepEqual(call(ctx, "idea_list", { query: "жираф" }), { ok: true, total: 3, matched: 0, ideas: [], has_more: false });
  assert.equal(call(ctx, "idea_list", { limit: 1 }).ideas.length, 1);
  assert.equal(call(ctx, "idea_list", { limit: 1 }).matched, 3);

  const [alarm] = call(ctx, "idea_list", { query: "будильник" }).ideas;

  call(ctx, "idea_update", { id: alarm.id, status: "done" });
  assert.deepEqual(titles(call(ctx, "idea_list", { status: "done" })), ["Будильник-вопрос"]);

  assert.deepEqual(call(world.ctxFor("2", "1"), "idea_list", {}).ideas, [], "другой человек в том же чате");
  assert.deepEqual(call(world.ctxFor("1", "9"), "idea_list", {}).ideas, [], "тот же человек в другом чате");

  for (const args of [{ limit: 0 }, { limit: 21 }, { status: "bogus" }, { query: "" }]) {
    assert.equal(call(ctx, "idea_list", args).ok, false, JSON.stringify(args));
  }
});

test("idea_list: «ё» и «е» в поиске одно и то же — в обе стороны, в названии, сути и тегах (как при сохранении)", () => {
  const world = createWorld();
  const ctx = world.ctxFor("1", "1");
  const found = (query) => titles(call(ctx, "idea_list", { query }));

  call(ctx, "idea_save", idea("Ёлочная ярмарка во дворе"));
  call(ctx, "idea_save", idea("Еще одна лавка у метро"));
  call(ctx, "idea_save", { title: "Зимний рынок", pitch: "Продаём живые ёлки и горячий чай.", tags: ["ёлка"] });
  call(ctx, "idea_save", { title: "Обмен вещами", pitch: "Соседи меняются вещами раз в неделю.", tags: ["еженедельно"] });

  assert.deepEqual(found("елочная"), ["Ёлочная ярмарка во дворе"], "«е» находит «ё» в названии");
  assert.deepEqual(found("ЕЩЁ"), ["Еще одна лавка у метро"], "«ё» находит «е» в названии");
  assert.deepEqual(found("елки"), ["Зимний рынок"], "«е» находит «ё» в сути");
  assert.deepEqual(found("продаем"), ["Зимний рынок"], "и в начале слова");
  assert.deepEqual(found("елка"), ["Зимний рынок"], "«е» находит «ё» в теге");
  assert.deepEqual(found("ёженедельно"), ["Обмен вещами"], "«ё» находит «е» в теге");
  assert.deepEqual(found("ярмарка"), ["Ёлочная ярмарка во дворе"], "прежний поиск не изменился");
});

test("idea_update: статус, правка, очистка тегов, удаление; код без учёта регистра; чужой код не находится", () => {
  const world = createWorld();
  const ctx = world.ctxFor("1", "1");
  const first = call(ctx, "idea_save", idea("Первая", { tags: ["а", "б"] }));
  const second = call(ctx, "idea_save", idea("Вторая"));

  const exploring = call(ctx, "idea_update", { id: first.id.toUpperCase(), status: "exploring" });

  assert.deepEqual({ ...exploring, idea: undefined }, { ok: true, id: first.id, updated: true, idea: undefined });
  assert.equal(exploring.idea.status, "exploring", "ответ показывает идею уже после правки");
  assert.equal(call(ctx, "idea_list", { status: "exploring" }).ideas[0].id, first.id);

  call(ctx, "idea_update", { id: first.id, title: "Первая, переименованная", pitch: "Новая суть первой идеи.", next_step: "Позвонить другу", tags: [] });

  const [renamed] = call(ctx, "idea_list", { query: "переименованная" }).ideas;

  assert.deepEqual([renamed.title, renamed.pitch, renamed.next_step, renamed.tags], ["Первая, переименованная", "Новая суть первой идеи.", "Позвонить другу", []]);

  assert.equal(call(ctx, "idea_update", { id: first.id, title: "вторая" }).error, "title_taken", "название не должно совпасть с другой идеей");
  assert.equal(call(ctx, "idea_update", { id: first.id }).error, "nothing_to_change");
  assert.equal(call(ctx, "idea_update", { id: "zzzzzzzz", status: "done" }).error, "invalid_id");
  assert.equal(call(ctx, "idea_update", { id: "deadbeef", status: "done" }).error, "not_found");
  assert.equal(call(ctx, "idea_update", { id: first.id, status: "bogus" }).error, "invalid_arguments");
  assert.equal(call(ctx, "idea_update", { id: first.id, pitch: "пароль: hunter2hunter2 тут" }).error, "looks_like_a_secret");
  assert.equal(call(world.ctxFor("2", "1"), "idea_update", { id: second.id, status: "done" }).error, "not_found", "код чужой идеи не подходит");

  assert.deepEqual(call(ctx, "idea_update", { id: second.id, delete: true }), { ok: true, id: second.id, deleted: true });
  assert.deepEqual(titles(call(ctx, "idea_list", {})), ["Первая, переименованная"]);
  call(ctx, "idea_update", { id: first.id, delete: true });
  assert.deepEqual(world.store.view((data) => data.ideas), {}, "когда идей не осталось, запись человека убрана целиком");
});

test("лимиты банка: 200 идей на человека (правка существующей работает и на пределе), число людей ограничено", () => {
  const world = createWorld();
  const ctx = world.ctxFor("1", "1");

  world.store.change((data) => {
    data.ideas["1:1"] = Array.from({ length: bank.IDEA_LIMITS.perScope }, (_, index) => ({
      id: index.toString(16).padStart(8, "0"), title: `Идея ${index}`, pitch: "суть идеи", tags: [], next: "", status: "new", createdAt: 1, updatedAt: 1
    }));
    return { ok: true };
  });

  const refused = call(ctx, "idea_save", idea("Двести первая"));

  assert.deepEqual([refused.error, refused.max], ["too_many_ideas", 200]);
  assert.equal(call(ctx, "idea_save", { title: "Идея 5", pitch: "Обновлённая суть пятой идеи." }).updated, true);

  const saved = bank.IDEA_LIMITS.scopes;

  // «1:1» из заполненного выше уже занимает одну запись, поэтому лимит 2 пускает ровно одного нового человека.
  bank.IDEA_LIMITS.scopes = 2;

  try {
    assert.equal(call(world.ctxFor("7", "7"), "idea_save", idea("Первый человек")).ok, true);
    assert.equal(call(world.ctxFor("8", "8"), "idea_save", idea("Второй человек")).error, "store_full");
  } finally {
    bank.IDEA_LIMITS.scopes = saved;
  }
});

test("переполнение файла: отказ записи — ответ storage_full, прежние идеи целы", () => {
  const world = createWorld({ maxBytes: 4000 });
  const ctx = world.ctxFor("1", "1");

  assert.equal(call(ctx, "idea_save", idea("Первая")).ok, true);

  const result = call(ctx, "idea_save", idea("Огромная", { pitch: "я".repeat(600), next_step: "я".repeat(200), tags: ["а"] }));
  const more = [1, 2, 3, 4, 5, 6].map((n) => call(ctx, "idea_save", idea(`Ещё ${n}`, { pitch: "ю".repeat(600) })));
  const failed = [result, ...more].find((entry) => entry.ok === false);

  assert.equal(failed?.error, "storage_full");
  assert.equal(call(ctx, "idea_list", { query: "Первая" }).ideas[0].title, "Первая");
});

test("помощники для команд: список, удаление по коду, очистка, выжимка для промпта", () => {
  const world = createWorld();
  const ctx = world.ctxFor("1", "1");
  const ids = ["Раз", "Два", "Три", "Четыре", "Пять", "Шесть", "Семь"].map((title) => {
    world.clock.now += 1000;
    return call(ctx, "idea_save", idea(title)).id;
  });

  assert.deepEqual(bank.digestFor(world.store, "1", "1"), { total: 7, titles: ["Семь", "Шесть", "Пять", "Четыре", "Три"] });
  assert.deepEqual(bank.digestFor(world.store, "1", "2"), { total: 0, titles: [] });

  assert.equal(bank.removeFor(world.store, "1", "1", ids[0].toUpperCase()), true);
  assert.equal(bank.removeFor(world.store, "1", "1", ids[0]), false, "второй раз — уже нечего");
  assert.equal(bank.removeFor(world.store, "1", "2", ids[1]), false, "чужой код");
  assert.equal(bank.listFor(world.store, "1", "1", { limit: 3 }).ideas.length, 3);

  assert.equal(bank.clearFor(world.store, "1", "2"), 0);
  assert.equal(bank.clearFor(world.store, "1", "1"), 6);
  assert.equal(bank.clearFor(world.store, "1", "1"), 0);
  assert.deepEqual(world.store.view((data) => data.ideas), {});
});

test("идеи переживают перезапуск; файл старого образца без ключа ideas открывается и дополняется", () => {
  const world = createWorld();
  const ctx = world.ctxFor("1", "1");

  call(ctx, "idea_save", idea("Переживёт перезапуск"));
  assert.equal(bank.listFor(new CompanionStore(world.file), "1", "1").ideas[0].title, "Переживёт перезапуск");

  const oldFile = path.join(world.dir, "old.json");

  fs.writeFileSync(oldFile, JSON.stringify({
    version: 1, characters: {}, retired: {}, ledger: {}, games: {}, facts: { "1:1": [{ text: "любит шахматы", at: 1 }] }, reminders: []
  }));

  const store = new CompanionStore(oldFile);

  assert.deepEqual(store.view((data) => data.ideas), {}, "недостающий ключ заполнен пустым значением");
  assert.equal(call({ ...ctx, store }, "idea_save", idea("Первая в старом файле")).ok, true);

  const written = JSON.parse(fs.readFileSync(oldFile, "utf8"));

  assert.equal(written.ideas["1:1"].length, 1);
  assert.equal(written.facts["1:1"][0].text, "любит шахматы", "прежние данные на месте");
});

test("/reset забывает факты чата, но идеи не трогает: это то, что человек создал, а не память разговора", () => {
  const world = createWorld();
  const ctx = world.ctxFor("1", "1");

  call(ctx, "memory_save", { text: "любит шахматы" });
  call(ctx, "idea_save", idea("Шахматы для бабушек"));

  assert.equal(forgetChat(world.store, "1"), 1);
  assert.deepEqual(call(ctx, "memory_search", {}).facts, []);
  assert.equal(bank.listFor(world.store, "1", "1").total, 1);
});

test("идеи — личные в чате: названия попадают в выжимку только своего человека", () => {
  const world = createWorld();

  call(world.ctxFor("1", "-100"), "idea_save", idea("Идея Васи"));
  call(world.ctxFor("2", "-100"), "idea_save", idea("Идея Пети"));

  assert.deepEqual(bank.digestFor(world.store, "-100", "1").titles, ["Идея Васи"]);
  assert.deepEqual(bank.digestFor(world.store, "-100", "2").titles, ["Идея Пети"]);
  assert.deepEqual(bank.digestFor(world.store, "5", "1").titles, [], "из группы в личный чат идеи не переезжают");
});
