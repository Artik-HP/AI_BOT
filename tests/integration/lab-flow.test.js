const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { withApp, launchApp, waitReady } = require("../helpers/app");
const fixtures = require("../helpers/labFixtures");
const { callsThen } = require("../helpers/ideasChat");
const USER = 9800;
const ENV = { BOT_OWNER_CHAT_ID: String(USER) };
const ctxKey = `${USER}:${USER}`;
function state(app) {
  try { return JSON.parse(fs.readFileSync(`${app.memoryFile}.lab.json`, "utf8")).scopes[ctxKey]; }
  catch { return null; }
}
async function view(tg, app, send) {
  const before = state(app)?.view;
  send();
  try { await tg.waitFor(() => state(app)?.view && state(app).view !== before, 6000, "новый экран лаборатории"); }
  catch (error) { throw new Error(`${error.message}; operations=${JSON.stringify(state(app)?.operations)}; texts=${JSON.stringify(tg.texts().slice(-3))}; output=${app.output()}`, { cause: error }); }
}
async function say(tg, app, text) { return view(tg, app, () => tg.message({ chatId: USER, text })); }
function action(app, name, value) {
  const cb = state(app).callbacks.find((item) => item.action === name && (value === undefined || item.value === value));
  assert.ok(cb, `button ${name} ${value}`);
  return cb;
}
async function choose(tg, app, name, value) {
  const cb = action(app, name, value);
  return view(tg, app, () => tg.callback({ chatId: USER, data: `lab:${cb.id}`, messageId: cb.messageId }));
}
async function finish(tg, app) {
  try { await tg.waitFor(() => state(app)?.callbacks.some((cb) => cb.action !== "cancel"), 12000, "операция завершена"); }
  catch (error) {
    throw new Error(`${error.message}; operations=${JSON.stringify(state(app)?.operations)}; experiments=${JSON.stringify(state(app)?.experiments)}; texts=${JSON.stringify(tg.texts().slice(-2))}; output=${app.output()}`, { cause: error });
  }
}

test("lab Telegram: idea → plan → saved project → export → confirmed deletion, normal chat retained", async () => {
  await withApp({ env: ENV }, async ({ tg, or, app }) => {
    or.chat = (record) => fixtures.response(record.body.messages[0].content.includes('"ideas"') ? fixtures.ideas : fixtures.plan);
    await say(tg, app, "/lab");
    await choose(tg, app, "ideas");
    await say(tg, app, "Магазин, JavaScript, выходные"); await finish(tg, app);
    await choose(tg, app, "idea", 0);
    await choose(tg, app, "plan"); await finish(tg, app);
    await choose(tg, app, "save");
    assert.equal(state(app).projects.length, 1);
    const project = state(app).projects[0];
    assert.equal(project.plan.output, "120");
    const exportButton = action(app, "export");
    tg.callback({ chatId: USER, data: `lab:${exportButton.id}`, messageId: exportButton.messageId });
    await tg.waitFor(() => tg.sent("sendDocument").length === 1);
    const exported = JSON.parse(tg.sent("sendDocument")[0].document.content);
    assert.equal(exported.project.id, project.id);
    await choose(tg, app, "delete");
    assert.equal(state(app).projects.length, 1);
    await choose(tg, app, "delete_confirm");
    assert.equal(state(app).projects.length, 0);
    await choose(tg, app, "home");
    const exit = action(app, "exit");
    tg.callback({ chatId: USER, data: `lab:${exit.id}`, messageId: exit.messageId });
    await tg.waitFor(() => tg.texts().includes("Обычный чат включён."));
    or.chat = () => fixtures.response("обычный ответ");
    tg.message({ chatId: USER, text: "обычный вопрос" });
    await tg.waitFor(() => tg.texts().includes("обычный ответ"));
  });
});

test("lab Telegram: preview is free, exactly 2 provider calls, no private history, stale callbacks don't charge", async () => {
  await withApp({ env: ENV }, async ({ tg, or, app }) => {
    or.chat = () => fixtures.response("400 ml");
    tg.message({ chatId: USER, text: "PRIVATE_HISTORY_SENTINEL" });
    await tg.waitFor(() => tg.texts().length > 0);
    const baseline = or.chatRequests().length;
    await say(tg, app, "/lab"); await choose(tg, app, "experiments");
    await say(tg, app, JSON.stringify({ task: "Товар", input: "400 ml", a: "Кратко", b: "Преимущества", words: ["400"], maxChars: 100 }));
    assert.equal(or.chatRequests().length, baseline);
    const run = action(app, "experiment_run");
    await choose(tg, app, "experiment_run"); await finish(tg, app);
    assert.equal(or.chatRequests().length, baseline + 2);
    assert.equal(state(app).experiments[0].status, "completed");
    assert.equal(state(app).experiments[0].runs[0].usage.total_tokens, 30);
    assert.ok(or.chatRequests().slice(baseline).every((record) => !JSON.stringify(record.body).includes("PRIVATE_HISTORY_SENTINEL")));
    tg.callback({ chatId: USER, data: `lab:${run.id}`, messageId: run.messageId });
    await tg.quiet(300);
    assert.equal(or.chatRequests().length, baseline + 2);
  });
});

test("lab Telegram: B fails, explicit retry only repeats B", async () => {
  await withApp({ env: ENV }, async ({ tg, or, app }) => {
    let n = 0;
    or.chat = () => ++n === 2 ? { status: 429, body: { error: { code: 429, message: "limited" } } } : fixtures.response("ok");
    await say(tg, app, "/lab"); await choose(tg, app, "experiments");
    await say(tg, app, JSON.stringify({ task: "t", input: "i", a: "a", b: "b" }));
    await choose(tg, app, "experiment_run"); await finish(tg, app);
    assert.equal(n, 2); assert.equal(state(app).experiments[0].status, "partial");
    await choose(tg, app, "experiment_retry");
    await choose(tg, app, "experiment_run"); await finish(tg, app);
    assert.equal(n, 3); assert.equal(state(app).experiments[0].status, "completed");
  });
});

test("lab Telegram: conversational experiment wizard makes no request before confirmation", async () => {
  await withApp({ env: ENV }, async ({ tg, or, app }) => {
    or.chat = () => fixtures.response("описание");
    await say(tg, app, "/lab"); await choose(tg, app, "experiments");
    await say(tg, app, "Описание товара");
    await say(tg, app, "Термокружка 400 мл");
    await say(tg, app, "Краткий абзац");
    await say(tg, app, "Три преимущества");
    assert.equal(or.chatRequests().length, 0);
    await choose(tg, app, "experiment_run"); await finish(tg, app);
    assert.equal(or.chatRequests().length, 2);
    assert.equal(state(app).experiments[0].spec.b, "Три преимущества");
  });
});

test("lab Telegram: cancellation reaches running operation and prevents B", async () => {
  await withApp({ env: ENV }, async ({ tg, or, app }) => {
    or.chat = () => ({ ...fixtures.response("A"), delayMs: 600 });
    await say(tg, app, "/lab"); await choose(tg, app, "experiments");
    await say(tg, app, JSON.stringify({ task: "t", input: "i", a: "a", b: "b" }));
    await choose(tg, app, "experiment_run");
    await tg.waitFor(() => or.chatRequests().length === 1);
    await choose(tg, app, "cancel");
    await tg.waitFor(() => state(app).experiments[0].status === "cancelled");
    assert.equal(or.chatRequests().length, 1);
  });
});

test("lab Telegram: lesson, wrong/correct attempt, next lesson and two-process recovery", async () => {
  await withApp({ env: ENV }, async ({ tg, or, app }) => {
    await say(tg, app, "/lab"); await choose(tg, app, "learn");
    await choose(tg, app, "learn_goal", "javascript:beginner");
    await say(tg, app, "Хочу писать ботов"); await choose(tg, app, "track_create");
    const trackId = state(app).tracks[0].id;
    await say(tg, app, "7"); await finish(tg, app);
    assert.equal(state(app).tracks[0].solved.length, 0);
    await choose(tg, app, "track");
    await say(tg, app, "8"); await finish(tg, app);
    assert.equal(state(app).tracks[0].solved.length, 1);
    await choose(tg, app, "track"); await choose(tg, app, "next");
    assert.equal(state(app).tracks[0].current, 1);
    assert.equal(or.chatRequests().length, 0);
    await app.stop();
    const second = await launchApp({ tg, or, env: { ...ENV, MEMORY_FILE: app.memoryFile } });
    try {
      await waitReady(tg, second);
      await say(tg, second, "/lab"); await choose(tg, second, "projects"); await choose(tg, second, "track");
      assert.equal(state(second).tracks[0].id, trackId);
      assert.equal(state(second).tracks[0].current, 1);
      assert.equal(or.chatRequests().length, 0);
    } finally { await second.stop(); }
  });
});

test("lab Telegram: HTML and Node file delivery, malformed/truncated reply is not delivered", async () => {
  await withApp({ env: ENV }, async ({ tg, or, app }) => {
    or.chat = (record) => fixtures.response(fixtures.artifact(JSON.parse(record.body.messages[1].content).kind));
    await say(tg, app, "/lab");
    for (const kind of ["html", "node"]) {
      await choose(tg, app, "tools"); await choose(tg, app, "tool_kind", kind);
      await say(tg, app, "Себестоимость 100, наценка 20%, результат 120");
      const before = tg.sent("sendDocument").length;
      await choose(tg, app, "tool_generate"); await finish(tg, app);
      await tg.waitFor(() => tg.sent("sendDocument").length === before + 1);
      assert.match(tg.sent("sendDocument").at(-1).document.filename, kind === "html" ? /\.html$/ : /\.js$/);
      await choose(tg, app, "home");
    }
    const bad = fixtures.response(fixtures.artifact()); bad.body.choices[0].finish_reason = "length";
    or.chat = () => bad;
    await choose(tg, app, "tools"); await choose(tg, app, "tool_kind", "html"); await say(tg, app, "Инструмент");
    await choose(tg, app, "tool_generate");
    await tg.waitFor(() => tg.texts().some((text) => text.includes("Ответ модели не завершён")));
    assert.equal(tg.sent("sendDocument").length, 2);
    assert.equal(state(app).artifacts.length, 2);
  });
});

test("U6: план первой версии и примеры инструмента — читаемым текстом, без JSON; экспорт проекта по-прежнему JSON", async () => {
  await withApp({ env: ENV }, async ({ tg, or, app }) => {
    or.chat = (record) => {
      const system = record.body.messages[0].content;

      if (system.includes('"ideas"')) return fixtures.response(fixtures.ideas);
      return fixtures.response(system.includes("{kind,code") ? fixtures.artifact("html") : fixtures.plan);
    };
    await say(tg, app, "/lab");
    await choose(tg, app, "ideas");
    await say(tg, app, "Магазин, JavaScript, выходные"); await finish(tg, app);
    await choose(tg, app, "idea", 0);
    await choose(tg, app, "plan"); await finish(tg, app);

    const planScreen = tg.texts().filter((text) => text.includes("Калькулятор цены")).at(-1);

    assert.doesNotMatch(planScreen, /[{}]|"input"|"tasks"/, planScreen);
    assert.match(planScreen, /\nВход: 100,20\nОбработка: base\*\(1\+margin\/100\)\nРезультат: 120\nЗадачи:\n1\. Сделать форму\nКритерии приёмки:\n1\. 100\+20%=120\nДемо: Ввести 100,20$/);

    await choose(tg, app, "save");
    const exportButton = action(app, "export");
    tg.callback({ chatId: USER, data: `lab:${exportButton.id}`, messageId: exportButton.messageId });
    await tg.waitFor(() => tg.sent("sendDocument").length === 1);
    assert.equal(JSON.parse(tg.sent("sendDocument")[0].document.content).project.plan.output, "120", "экспорт не изменился");

    await choose(tg, app, "home"); await choose(tg, app, "tools"); await choose(tg, app, "tool_kind", "html");
    await say(tg, app, "Себестоимость 100, наценка 20%, результат 120");
    await choose(tg, app, "tool_generate"); await finish(tg, app);

    const toolScreen = tg.texts().filter((text) => text.startsWith("Файл сформирован")).at(-1);

    assert.match(toolScreen, /\nПримеры:\n100,20 → 120\n50,0 → 50\n/);
    assert.doesNotMatch(toolScreen, /\[\{|"input"/);
  });
});

const bankOf = (app) => {
  try { return JSON.parse(fs.readFileSync(`${app.memoryFile}.rpg.json`, "utf8")).ideas[ctxKey] || []; }
  catch { return []; }
};
const userRequest = (record) => record.body.messages.at(-1).content;

test("L2: «📚 В банк идей» без AI кладёт идею лаборатории в банк; /lab код — одна генерация только после кнопки", async () => {
  await withApp({ env: ENV }, async ({ tg, or, app }) => {
    or.chat = (record) => fixtures.response(record.body.messages[0].content.includes('"ideas"') ? fixtures.ideas : fixtures.plan);
    await say(tg, app, "/lab");
    await choose(tg, app, "ideas");
    await say(tg, app, "Магазин, JavaScript, выходные"); await finish(tg, app);
    await choose(tg, app, "idea", 0);

    const requests = or.chatRequests().length;

    await choose(tg, app, "to_bank");
    assert.equal(or.chatRequests().length, requests, "в банк — без запроса к модели");

    const [saved] = bankOf(app);

    assert.deepEqual([saved.title, saved.tags, saved.next], ["Калькулятор цены", ["лаборатория"], "Ввод"]);
    assert.equal(saved.pitch, "Рассчитать цену по себестоимости Результат: 120");
    assert.ok(tg.texts().at(-1).includes(`код ${saved.id}`), tg.texts().at(-1));

    await choose(tg, app, "idea_back");
    assert.match(tg.texts().at(-1), /^Калькулятор цены\n/, "назад к выбранной идее");

    tg.message({ chatId: USER, text: "/ideas" });
    await tg.waitFor(() => tg.texts().some((text) => text.startsWith("📚 Твои идеи (1)") && text.includes("Калькулятор цены")));
    assert.match(tg.texts().find((text) => text.startsWith("📚 Твои идеи (1)")), /\nВ лабораторию: \/lab код/);

    await say(tg, app, `/lab #${saved.id.toUpperCase()}`);
    assert.match(tg.texts().at(-1), /^Идея из банка: «Калькулятор цены»\n[\s\S]*Это 1 генерация лаборатории\.$/);
    assert.equal(or.chatRequests().length, requests, "показ идеи — без запроса");

    await choose(tg, app, "bank_ideas"); await finish(tg, app);
    assert.equal(or.chatRequests().length, requests + 1, "ровно одна генерация");
    assert.match(userRequest(or.chatRequests().at(-1)), /Идея: Калькулятор цены/);
    assert.equal(state(app).callbacks.filter((cb) => cb.action === "idea").length, 3, "дальше — обычный экран трёх идей");

    await say(tg, app, "/lab deadbeef");
    assert.match(tg.texts().at(-1), /^Идеи с кодом deadbeef нет в твоём банке/);
    await say(tg, app, "/lab что-то");
    assert.match(tg.texts().at(-1), /^Не понял код идеи/);
    assert.equal(or.chatRequests().length, requests + 1);
  });
});

test("L2: «🎲 Искра» на экране идей программ — бросает код, запрос к AI только после подтверждения и со значениями искры", async () => {
  await withApp({ env: ENV }, async ({ tg, or, app }) => {
    or.chat = () => fixtures.response(fixtures.ideas);
    await say(tg, app, "/lab");
    await choose(tg, app, "ideas");
    await choose(tg, app, "lab_spark");

    const card = tg.texts().at(-1);
    const values = card.split("\n").filter((line) => /^(Область|Ограничение|Поворот|Для кого): /.test(line));

    assert.match(card, /^🎲 Искра\nОбласть: /);
    assert.match(card, /Сделать три идеи программ вокруг этой искры\? 1 генерация\.$/);
    assert.ok(values.length >= 2);
    assert.equal(or.chatRequests().length, 0, "до подтверждения — ни одного запроса");

    await choose(tg, app, "spark_ideas"); await finish(tg, app);
    assert.equal(or.chatRequests().length, 1);

    for (const line of values) {
      assert.ok(userRequest(or.chatRequests()[0]).includes(line), `в запросе нет «${line}»`);
    }
  });
});

test("L2: без функций модели кнопки «В банк идей» нет; без лаборатории в /ideas нет подсказки про /lab", async () => {
  await withApp({ env: { ...ENV, COMPANION_TOOLS_ENABLED: "false" } }, async ({ tg, or, app }) => {
    or.chat = () => fixtures.response(fixtures.ideas);
    await say(tg, app, "/lab");
    await choose(tg, app, "ideas");
    await say(tg, app, "Магазин"); await finish(tg, app);
    await choose(tg, app, "idea", 0);
    assert.ok(!state(app).callbacks.some((cb) => cb.action === "to_bank"));
    assert.ok(state(app).callbacks.some((cb) => cb.action === "plan"), "остальные кнопки на месте");
  });

  await withApp({ env: { ...ENV, AI_LAB_ENABLED: "false", COMPANION_DEFAULT_PERSONA: undefined } }, async ({ tg, or }) => {
    callsThen(or, [["idea_save", { title: "Будильник-вопрос", pitch: "Будит вопросом на пять секунд." }]], "Сохранил");
    tg.message({ chatId: USER, text: "сохрани" });
    await tg.waitFor(() => tg.texts().includes("Сохранил"));
    tg.message({ chatId: USER, text: "/ideas" });
    await tg.waitFor(() => tg.texts().some((text) => text.startsWith("📚 Твои идеи (1)")));
    assert.ok(!tg.texts().at(-1).includes("/lab"), tg.texts().at(-1));
  });
});

test("lifecycle: /logout снимает сессию и кнопки лаборатории; после нового входа обычный текст идёт в чат, а не в лабораторию", async () => {
  await withApp({ env: ENV }, async ({ tg, or, app }) => {
    or.chat = () => fixtures.response("обычный ответ");
    await say(tg, app, "/lab");
    assert.equal(state(app).session.active, true);

    tg.message({ chatId: USER, text: "/logout" });
    await tg.waitFor(() => tg.texts().some((text) => text.includes("Вы вышли")));
    await tg.waitFor(() => state(app).session === null, 4000, "сессия лаборатории снята");
    assert.deepEqual([state(app).view, state(app).callbacks], [null, []]);

    await app.authenticate(USER);
    tg.message({ chatId: USER, text: "обычный вопрос" });
    await tg.waitFor(() => tg.texts().includes("обычный ответ"));
  });
});

test("lab Telegram: private ownership, foreign bot address, forged callback and disabled module", async () => {
  await withApp({ env: ENV }, async ({ tg, app }) => {
    await say(tg, app, "/lab");
    const cb = action(app, "learn");
    tg.callback({ chatId: USER, fromId: 9801, data: `lab:${cb.id}`, messageId: cb.messageId });
    await tg.quiet(150);
    assert.equal(state(app).tracks.length, 0);
    assert.equal(action(app, "learn").used, undefined);
    tg.message({ chatId: -10099, fromId: USER, chatType: "supergroup", text: "/lab" });
    await tg.waitFor(() => tg.texts().some((text) => text.includes("в личном диалоге")));
    const before = tg.texts().length;
    tg.message({ chatId: USER, text: "/lab@other_bot" }); await tg.quiet(200);
    assert.equal(tg.texts().length, before);
  });
  await withApp({ env: { ...ENV, AI_LAB_ENABLED: "false" } }, async ({ tg, or, app }) => {
    or.chat = () => fixtures.response("обычный чат");
    tg.message({ chatId: USER, text: "🔬 AI-лаборатория" });
    await tg.waitFor(() => tg.texts().includes("обычный чат"));
    assert.equal(state(app), null);
    assert.ok(!JSON.parse(tg.sent("setMyCommands")[0].commands).some((entry) => entry.command === "lab"));
  });
});
