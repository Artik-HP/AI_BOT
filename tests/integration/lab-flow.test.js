const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { withApp, launchApp, waitReady } = require("../helpers/app");
const fixtures = require("../helpers/labFixtures");
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
