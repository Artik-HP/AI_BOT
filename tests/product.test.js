const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  http = require("node:http");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-product-"));
Object.assign(process.env, {
  MEMORY_FILE: path.join(temp, "legacy-memory.json"),
  MEMORY_BACKEND: "sqlite",
  COMMAND_DB_FILE: path.join(temp, "commands.sqlite"),
  CONFIG_ENV_FILE: path.join(temp, ".env"),
  OPENROUTER_API_KEY: "test-only",
  OPENROUTER_MODEL: "test/one",
  OPENROUTER_VISION_MODEL: "test/two",
  AI_MODELS: "test/one,test/two",
  AI_COMPATIBLE_BASE_URL: "https://compatible.test/v1",
  AI_COMPATIBLE_API_KEY: "test-compatible",
});
fs.writeFileSync(
  process.env.MEMORY_FILE,
  JSON.stringify({
    42: { messages: [{ role: "user", content: "legacy private note" }] },
    99: { messages: [{ role: "user", content: "other user must survive" }] },
  }),
);
fs.copyFileSync(process.env.MEMORY_FILE, process.env.MEMORY_FILE + ".bak");
const { getStore, CommandStore } = require("../src/commandSystem/store"),
  store = getStore();
const pref = require("../src/services/preferences"),
  personal = require("../src/services/personalData"),
  memory = require("../src/services/memory"),
  { execute } = require("../src/commandSystem/engine");
const axios = require("axios");
let captured = [],
  serial = 0;
axios.get = async () => ({
  data: {
    data: [
      { id: "test/one", supported_parameters: ["structured_outputs"] },
      { id: "test/two", supported_parameters: ["structured_outputs"] },
    ],
  },
});
axios.post = async (url, body) => {
  captured.push({ url, body });
  return {
    data: {
      choices: [
        {
          message: {
            content: JSON.stringify({
              type: "text",
              text: "Ответ тестового транспорта " + ++serial,
              question: "",
              selection_mode: "single",
              options: [],
              allow_custom_input: true,
            }),
          },
          finish_reason: "stop",
        },
      ],
    },
  };
};
const ctx = { scope: "w:product", transport: "web", userId: "product", store };
test("personal model, style, mode, instructions and history limit reach the actual completion request", async () => {
  pref.savePreferences(
    ctx.scope,
    {
      model: "test/two",
      style: "concise",
      mode: "teacher",
      instructions: "Используй бытовые примеры",
      historyLimit: 8,
    },
    store,
  );
  await execute(ctx, "chat", { args: "Что такое DNS?" });
  const body = captured.at(-1).body;
  assert.equal(body.model, "test/two");
  assert.ok(body.messages[0].content.includes("Используй бытовые примеры"));
  assert.ok(body.messages[0].content.includes("Учитель"));
  assert.equal(body.max_tokens, require("../src/config").AI_MAX_OUTPUT_TOKENS);
  const reopened = new CommandStore(process.env.COMMAND_DB_FILE);
  assert.equal(pref.getPreferences(ctx.scope, reopened).model, "test/two");
  reopened.close();
});
test("separate conversations retain context, can be resumed and are isolated from another user", async () => {
  const first = personal.newThread(ctx.scope, "JavaScript", store);
  await execute(ctx, "chat", { args: "FIRST_THREAD_MARKER" });
  const second = personal.newThread(ctx.scope, "Отдых", store);
  await execute(ctx, "chat", { args: "SECOND_THREAD_MARKER" });
  assert.ok(
    !JSON.stringify(captured.at(-1).body.messages).includes(
      "FIRST_THREAD_MARKER",
    ),
  );
  personal.useThread(ctx.scope, first.id, store);
  await execute(ctx, "chat", { args: "Продолжим первый" });
  assert.ok(
    JSON.stringify(captured.at(-1).body.messages).includes(
      "FIRST_THREAD_MARKER",
    ),
  );
  assert.ok(
    !JSON.stringify(captured.at(-1).body.messages).includes(
      "SECOND_THREAD_MARKER",
    ),
  );
  assert.throws(() => personal.useThread("w:other", second.id, store));
  assert.equal(
    personal
      .history(ctx.scope, "FIRST_THREAD_MARKER", store)
      .find((t) => t.id === first.id).messages.length,
    1,
  );
});
test("turning memory off omits exact history, summaries and profile notes from the request", async () => {
  const c = { ...ctx, scope: "w:memory-off" };
  const m = memory.getUserMemory(c.scope);
  m.summary = "SHOULD_NOT_APPEAR";
  m.personalNotes = ["PRIVATE_MEMORY_NOTE"];
  memory.rememberTurn(c.scope, "OLD_TOPIC", "OLD_REPLY");
  pref.savePreferences(c.scope, { memoryEnabled: false }, store);
  await execute(c, "chat", { args: "CURRENT_ONLY" });
  const body = JSON.stringify(captured.at(-1).body.messages);
  assert.ok(!body.includes("OLD_TOPIC"));
  assert.ok(!body.includes("SHOULD_NOT_APPEAR"));
  assert.ok(!body.includes("PRIVATE_MEMORY_NOTE"));
  assert.ok(body.includes("CURRENT_ONLY"));
});
test("SQLite persistence does not overwrite legacy files and reads changes from another connection", () => {
  const before = fs.readFileSync(process.env.MEMORY_FILE, "utf8");
  memory.rememberTurn("w:persist", "Stored", "Answer");
  assert.equal(fs.readFileSync(process.env.MEMORY_FILE, "utf8"), before);
  const reopened = new CommandStore(process.env.COMMAND_DB_FILE);
  const value = reopened.get("conversation:w:persist");
  assert.equal(value.messages[0].content, "Stored");
  value.messages.push({ role: "user", content: "External update" });
  reopened.set("conversation:w:persist", value);
  assert.equal(
    memory.getUserMemory("w:persist").messages.at(-1).content,
    "External update",
  );
  reopened.close();
});
test("AI-compatible provider uses configured HTTPS endpoint, bounded output and structured response validation", async () => {
  const c = { ...ctx, scope: "w:compatible" };
  pref.savePreferences(c.scope, { provider: "compatible" }, store);
  await execute(c, "explain", { args: "Promise" });
  assert.equal(
    captured.at(-1).url,
    "https://compatible.test/v1/chat/completions",
  );
  assert.ok(
    captured
      .at(-1)
      .body.messages.some((m) => m.content.includes("UI protocol")),
  );
  const old = process.env.AI_COMPATIBLE_BASE_URL;
  process.env.AI_COMPATIBLE_BASE_URL = "http://localhost:9999";
  assert.throws(
    () => require("../src/services/aiProviders").providerConfig("compatible"),
    /HTTPS/,
  );
  process.env.AI_COMPATIBLE_BASE_URL = old;
});
test("rate and daily AI budgets persist, reject excess work and do not leak provider keys", () => {
  const {
      consumeBudget,
      publicConfig,
    } = require("../src/services/aiProviders"),
    config = require("../src/config"),
    scope = "w:quota",
    old = config.AI_RATE_PER_MINUTE;
  config.AI_RATE_PER_MINUTE = 2;
  consumeBudget(scope, store, 1000000);
  consumeBudget(scope, store, 1000000);
  assert.throws(() => consumeBudget(scope, store, 1000000), /минуту/);
  config.AI_RATE_PER_MINUTE = old;
  assert.ok(!JSON.stringify(publicConfig()).includes("test-compatible"));
  assert.ok(
    !JSON.stringify(
      require("../src/services/diagnostics").snapshot(ctx.scope, store),
    ).includes("test-only"),
  );
});
test("export and confirmed deletion affect only the selected user, including legacy import and backup", async () => {
  const c = { ...ctx, scope: "t:42:42", transport: "web" };
  personal.ensureHistory({
    ...c,
    transport: "telegram",
    chatId: 42,
    userId: 42,
    msg: { chat: { type: "private" } },
  });
  await execute(c, "notes", { args: "add DELETE_ONLY_THIS" });
  store.set("w:unrelated:notes", [{ text: "KEEP_OTHER_USER" }]);
  const exported = JSON.parse(personal.exportData(c.scope, store));
  assert.ok(JSON.stringify(exported).includes("legacy private note"));
  assert.ok(!JSON.stringify(exported).includes("KEEP_OTHER_USER"));
  const confirmation = await execute(c, "delete_data", { args: "" });
  assert.ok(store.get(c.scope + ":notes").length);
  await execute(c, "delete_data", { args: confirmation.buttons[0].args });
  assert.deepEqual(store.get(c.scope + ":notes", []), []);
  assert.equal(store.get("w:unrelated:notes")[0].text, "KEEP_OTHER_USER");
  for (const file of [
    process.env.MEMORY_FILE,
    process.env.MEMORY_FILE + ".bak",
  ]) {
    const data = JSON.parse(fs.readFileSync(file));
    assert.equal(data["42"], undefined);
    assert.ok(data["99"]);
  }
});
test("habits do not count duplicate daily marks and flashcards save, reveal and record review", async () => {
  const c = { ...ctx, scope: "w:learning" };
  await execute(c, "habits", { args: "add Читать" });
  const habit = store.get(c.scope + ":habits")[0];
  await execute(c, "habits", { args: "check " + habit.id });
  await execute(c, "habits", { args: "check " + habit.id });
  assert.equal(store.get(c.scope + ":habits")[0].days.length, 1);
  await execute(c, "flashcards", { args: "add Вопрос | Ответ" });
  const card = store.get(c.scope + ":flashcards")[0];
  assert.equal(
    (await execute(c, "flashcards", { args: "reveal " + card.id })).text,
    "Ответ",
  );
  await execute(c, "flashcards", { args: "done " + card.id });
  assert.equal(store.get(c.scope + ":flashcards")[0].reviews, 1);
});
test("document decoder rejects binary, invalid UTF-8 and oversized input; aliases share handlers", async () => {
  const { decodeText } = require("../src/handlers/document");
  assert.equal(decodeText(Buffer.from("Привет")), "Привет");
  for (const buf of [
    Buffer.from([255]),
    Buffer.from("A\0B"),
    Buffer.alloc(256 * 1024 + 1),
    Buffer.from("x".repeat(12001)),
  ])
    assert.throws(() => decodeText(buf));
  assert.equal((await execute(ctx, "calc", { args: "2+3" })).text, "5");
  assert.ok(
    (await execute(ctx, "game", { args: "" })).buttons.some(
      (b) => b.command === "quiz",
    ),
  );
});
test("local listener reuses only matching healthy instance and occupied foreign port reports a clear error", async () => {
  const app = require("../src/web").createWebApp({ store, accessToken: "" }),
    life = require("../src/serverLifecycle"),
    one = life.listen(app, { port: 0 });
  const ready = await one.ready,
    port = ready.server.address().port;
  const duplicate = life.listen(app, { port });
  assert.equal((await duplicate.ready).reused, true);
  await new Promise((r) => ready.server.close(r));
  const foreign = http
    .createServer((req, res) => res.end("foreign"))
    .listen(0, "127.0.0.1");
  await new Promise((r) => foreign.once("listening", r));
  const collision = life.listen(app, { port: foreign.address().port });
  await assert.rejects(collision.ready, /занят другой программой/);
  await new Promise((r) => foreign.close(r));
});
