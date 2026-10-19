const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-audit-"));
Object.assign(process.env, {
  MEMORY_FILE: path.join(temporary, "memory.json"),
  COMMAND_DB_FILE: path.join(temporary, "commands.sqlite"),
  MEMORY_BACKEND: "sqlite",
  OPENROUTER_API_KEY: "",
  BOT_ACCESS_PASSWORD_HASH: "",
});
const { CommandStore } = require("../src/commandSystem/store");
const { execute, tickReminders } = require("../src/commandSystem/engine");
const axios = require("axios");

test("all 200 maximum-size notes and tasks remain accessible through bounded pages", async () => {
  const store = new CommandStore(":memory:");
  const ctx = { scope: "w:large-lists", transport: "web", store };
  try {
    for (const command of ["notes", "todo"]) {
      const items = Array.from({ length: 200 }, (_, i) => ({
        id: String(i).padStart(8, "0"),
        text: `entry-${i}:` + "я".repeat(1980),
        done: false,
      }));
      store.set(ctx.scope + ":" + command, items);
      const seen = new Set();
      let args = "list";
      for (let page = 0; page < 200; page++) {
        const reply = await execute(ctx, command, { args });
        assert.ok(!reply.error, `${command}: ${reply.text}`);
        assert.ok(reply.text.length <= 64000);
        for (const [, entry] of reply.text.matchAll(/entry-(\d+):/g)) {
          assert.ok(!seen.has(entry), `entry ${entry} repeated across pages`);
          seen.add(entry);
        }
        const next = reply.buttons.find((b) => /Далее/.test(b.label));
        if (!next) break;
        args = next.args;
      }
      assert.equal(seen.size, items.length);
      const invalid = await execute(ctx, command, { args: "list 0" });
      assert.equal(invalid.error, true);
      assert.equal(store.get(ctx.scope + ":" + command).length, 200);
    }
  } finally {
    store.close();
  }
});

test("maximum-size reminders are listed and cancellable without losing any entries", async () => {
  const store = new CommandStore(":memory:");
  const ctx = { scope: "w:large-reminders", transport: "web", store };
  try {
    for (let i = 0; i < 10; i++)
      store.addReminder(ctx, `reminder-${i}:` + "я".repeat(15900), Date.now() + 86400000);
    const seen = new Set();
    let args = "list";
    for (let page = 0; page < 10; page++) {
      const reply = await execute(ctx, "reminder", { args });
      assert.ok(!reply.error, reply.text);
      for (const [, entry] of reply.text.matchAll(/reminder-(\d+):/g)) {
        assert.ok(!seen.has(entry));
        seen.add(entry);
      }
      assert.ok(reply.buttons.some((b) => b.args.startsWith("cancel ")));
      const next = reply.buttons.find((b) => /Далее/.test(b.label));
      if (!next) break;
      args = next.args;
    }
    assert.equal(seen.size, 10);
    assert.equal(store.reminders(ctx.scope).length, 10);
  } finally {
    store.close();
  }
});

test("image analysis with memory disabled never restores old context during duplicate-reply correction", async () => {
  const CONFIG = require("../src/config");
  const prefs = require("../src/services/preferences");
  const memory = require("../src/services/memory");
  const scope = "w:image-memory-off";
  const previous = "Одинаковый ответ о картинке, сохранённый в прошлом диалоге.";
  const saved = memory.getUserMemory(scope);
  saved.summary = "HIDDEN_IMAGE_SUMMARY";
  saved.personalNotes = ["HIDDEN_IMAGE_PERSONAL_NOTE"];
  saved.messages = [{ role: "assistant", content: previous }];
  memory.saveMemory();
  prefs.savePreferences(scope, { memoryEnabled: false, mode: "teacher", instructions: "IMAGE_STYLE_MARKER" });
  const originalPost = axios.post;
  const originalKey = CONFIG.OPENROUTER_API_KEY;
  const requests = [];
  CONFIG.OPENROUTER_API_KEY = "synthetic-only";
  axios.post = async (_url, body) => {
    requests.push(body);
    return { data: { choices: [{ message: { content: requests.length === 1 ? previous : "Новый ответ." } }] } };
  };
  try {
    await require("../src/services/openrouter").askAIWithImage(scope, "Опиши изображение", { dataUrl: "data:image/png;base64,eA==" }, {}, { interactive: false });
    assert.ok(requests.length > 0);
    for (const request of requests) {
      const serialized = JSON.stringify(request.messages);
      assert.ok(!serialized.includes("HIDDEN_IMAGE_"), "disabled memory leaked into an image request");
      assert.ok(serialized.includes("IMAGE_STYLE_MARKER"));
      assert.ok(serialized.includes("Учитель"));
    }
  } finally {
    axios.post = originalPost;
    CONFIG.OPENROUTER_API_KEY = originalKey;
  }
});

test("image history limit and personal settings apply to every correction request", async () => {
  const CONFIG = require("../src/config");
  const prefs = require("../src/services/preferences");
  const memory = require("../src/services/memory");
  const scope = "w:image-history-limit";
  const previous = "Ответ о предыдущей картинке.";
  const saved = memory.getUserMemory(scope);
  saved.messages = [
    { role: "user", content: "OUTSIDE_IMAGE_HISTORY_LIMIT" },
    { role: "assistant", content: "Старый ответ" },
    { role: "user", content: "Последний вопрос" },
    { role: "assistant", content: previous },
  ];
  memory.saveMemory();
  prefs.savePreferences(scope, { historyLimit: 2, mode: "teacher", instructions: "IMAGE_RETRY_STYLE" });
  const originalPost = axios.post;
  const originalKey = CONFIG.OPENROUTER_API_KEY;
  const requests = [];
  CONFIG.OPENROUTER_API_KEY = "synthetic-only";
  axios.post = async (_url, body) => {
    requests.push(body);
    return { data: { choices: [{ message: { content: requests.length < 3 ? previous : "Самостоятельный анализ новой картинки." } }] } };
  };
  try {
    await require("../src/services/openrouter").askAIWithImage(scope, "Что изображено?", { dataUrl: "data:image/png;base64,eA==" }, {}, { interactive: false });
    assert.equal(requests.length, 3);
    for (const request of requests) {
      const serialized = JSON.stringify(request.messages);
      assert.ok(!serialized.includes("OUTSIDE_IMAGE_HISTORY_LIMIT"));
      assert.ok(serialized.includes("IMAGE_RETRY_STYLE"));
      assert.ok(serialized.includes("Учитель"));
    }
  } finally {
    axios.post = originalPost;
    CONFIG.OPENROUTER_API_KEY = originalKey;
  }
});

test("long Telegram reminders preserve Unicode and fit the actual message limit", async () => {
  const store = new CommandStore(":memory:");
  const ctx = { scope: "t:123:123", transport: "telegram", chatId: 123 };
  const text = "я😀".repeat(5000);
  const id = store.addReminder(ctx, text, Date.now() - 1000);
  const chunks = [];
  try {
    await tickReminders(store, {
      sendMessage: async (destination, chunk) => {
        assert.equal(destination, "123");
        assert.ok(chunk.length <= 4096, "Telegram rejects messages above 4096 UTF-16 units");
        assert.ok(!/[\uD800-\uDBFF]$/.test(chunk));
        chunks.push(chunk);
      },
    });
    assert.equal(store.db.prepare("SELECT status FROM reminders WHERE id=?").get(id).status, "delivered");
    assert.equal(chunks.join(""), `🔔 Напоминание\n${text}`);
    assert.equal(store.inbox(ctx.scope).length, 1);
  } finally {
    store.close();
  }
});

test("restart after partial reminder delivery retries only unsent chunks", async () => {
  const file = path.join(temporary, "reminder-restart.sqlite");
  let store = new CommandStore(file);
  const ctx = { scope: "t:456:456", transport: "telegram", chatId: 456 };
  const text = "😀".repeat(7000);
  const id = store.addReminder(ctx, text, Date.now() - 1000);
  const chunks = [];
  let calls = 0;
  const bot = {
    sendMessage: async (_destination, chunk) => {
      if (++calls === 2) throw Object.assign(new Error("temporary failure"), { code: "ETIMEDOUT" });
      assert.ok(chunk.length <= 4096);
      chunks.push(chunk);
    },
  };
  try {
    await tickReminders(store, bot);
    assert.equal(chunks.length, 1);
    assert.equal(store.db.prepare("SELECT status FROM reminders WHERE id=?").get(id).status, "pending");
    store.close();
    store = new CommandStore(file);
    await tickReminders(store, bot, Date.now() + 10 * 60000);
    assert.equal(store.db.prepare("SELECT status FROM reminders WHERE id=?").get(id).status, "delivered");
    assert.equal(chunks.join(""), `🔔 Напоминание\n${text}`);
    assert.equal(store.inbox(ctx.scope).length, 1);
  } finally {
    store.close();
  }
});

test("preference modes and styles reject inherited properties and non-string enum values", () => {
  const store = new CommandStore(":memory:");
  const prefs = require("../src/services/preferences");
  const scope = "w:invalid-preferences";
  try {
    const original = prefs.getPreferences(scope, store);
    for (const patch of [{ mode: "__proto__" }, { style: "constructor" }, { mode: ["teacher"] }, { style: ["concise"] }]) {
      assert.throws(() => prefs.savePreferences(scope, patch, store), (error) => error.userError === true);
      assert.deepEqual(prefs.getPreferences(scope, store), original);
    }
  } finally {
    store.close();
  }
});

test("active thread must be a string and belong to the user's visible conversation list", () => {
  const store = new CommandStore(":memory:");
  const prefs = require("../src/services/preferences");
  const personal = require("../src/services/personalData");
  const scope = "w:thread-validation";
  try {
    assert.throws(() => prefs.savePreferences(scope, { activeThread: ["main"] }, store));
    const other = personal.newThread("w:other-user", "Other user's conversation", store);
    assert.throws(() => prefs.savePreferences(scope, { activeThread: other.id }, store));
    assert.throws(() => prefs.savePreferences(scope, { activeThread: "abcdef123456" }, store));
    const own = personal.newThread(scope, "My conversation", store);
    assert.equal(prefs.getPreferences(scope, store).activeThread, own.id);
    prefs.savePreferences(scope, { activeThread: "main" }, store);
    prefs.savePreferences(scope, { activeThread: own.id }, store);
    assert.equal(prefs.getPreferences(scope, store).activeThread, own.id);
  } finally {
    store.close();
  }
});

test("reminder progress migration preserves reminders created with the previous SQLite schema", async () => {
  const { DatabaseSync } = require("node:sqlite");
  const file = path.join(temporary, "old-reminder-schema.sqlite");
  const old = new DatabaseSync(file);
  old.exec("CREATE TABLE reminders (id TEXT PRIMARY KEY, scope TEXT, transport TEXT, destination TEXT, text TEXT, due INTEGER, status TEXT DEFAULT 'pending', lease INTEGER DEFAULT 0, attempts INTEGER DEFAULT 0)");
  old.prepare("INSERT INTO reminders(id,scope,transport,destination,text,due) VALUES(?,?,?,?,?,?)").run("old-reminder", "w:migration", "web", "", "Keep my reminder", Date.now() - 1000);
  old.close();
  const store = new CommandStore(file);
  try {
    assert.equal(store.reminders("w:migration")[0].text, "Keep my reminder");
    await tickReminders(store);
    assert.equal(store.inbox("w:migration")[0].text, "Keep my reminder");
    assert.equal(store.db.prepare("SELECT sent_chunks FROM reminders WHERE id=?").get("old-reminder").sent_chunks, 0);
  } finally {
    store.close();
  }
});

test("reset clears only the active web conversation and preserves main and other user history", async () => {
  const store = new CommandStore(":memory:");
  const scope = "w:reset-active";
  const personal = require("../src/services/personalData");
  const prefs = require("../src/services/preferences");
  const memory = require("../src/services/memory");
  try {
    memory.rememberTurn(scope, "KEEP_MAIN_QUESTION", "KEEP_MAIN_ANSWER");
    memory.rememberTurn("w:reset-other", "KEEP_OTHER_QUESTION", "KEEP_OTHER_ANSWER");
    const thread = personal.newThread(scope, "Selected conversation", store);
    const activeKey = prefs.threadKey(scope, prefs.getPreferences(scope, store));
    memory.rememberTurn(activeKey, "CLEAR_SELECTED_QUESTION", "CLEAR_SELECTED_ANSWER");
    store.set(scope + ":aiQuestion", { question: "stale" });
    store.set(scope + ":selection", { selected: [0] });
    const result = await execute({ scope, transport: "web", store }, "reset", { args: "" });
    assert.ok(!result.error);
    assert.deepEqual(memory.getUserMemory(activeKey).messages, []);
    assert.equal(memory.getUserMemory(scope).messages[0].content, "KEEP_MAIN_QUESTION");
    assert.equal(memory.getUserMemory("w:reset-other").messages[0].content, "KEEP_OTHER_QUESTION");
    assert.equal(prefs.getPreferences(scope, store).activeThread, thread.id);
    assert.equal(store.get(scope + ":aiQuestion"), null);
    assert.equal(store.get(scope + ":selection"), null);
  } finally {
    store.close();
  }
});

test("switching or creating a conversation invalidates choices belonging to the previous thread", () => {
  const store = new CommandStore(":memory:");
  const prefs = require("../src/services/preferences");
  const personal = require("../src/services/personalData");
  const scope = "w:thread-choices";
  try {
    store.set(scope + ":aiQuestion", { question: "PRIVATE_PREVIOUS_THREAD_QUESTION" });
    store.set(scope + ":selection", { nonce: "old-choice", selected: [0] });
    personal.newThread(scope, "Fresh context", store);
    assert.equal(store.get(scope + ":aiQuestion"), null);
    assert.equal(store.get(scope + ":selection"), null);
    store.set(scope + ":aiQuestion", { question: "CURRENT_QUESTION" });
    store.set(scope + ":selection", { nonce: "current-choice", selected: [1] });
    prefs.savePreferences(scope, { style: "concise" }, store);
    assert.equal(store.get(scope + ":aiQuestion").question, "CURRENT_QUESTION");
    personal.useThread(scope, "main", store);
    assert.equal(store.get(scope + ":aiQuestion"), null);
    assert.equal(store.get(scope + ":selection"), null);
  } finally {
    store.close();
  }
});

test("all 100 valid multiple-choice options including long Unicode labels are reachable", async () => {
  const store = new CommandStore(":memory:");
  const scope = "w:maximum-options";
  const ctx = { scope, transport: "web", store };
  const nonce = "max-choices";
  const question = {
    type: "interactive_question", question: "Выбери подходящие варианты", selection_mode: "multiple", allow_custom_input: true,
    options: Array.from({ length: 100 }, (_, i) => ({ id: `o${i}`, label: `${i}:` + "😀".repeat(190), value: `Full answer ${i}` })),
  };
  assert.equal(require("../src/services/interactiveQuestion").validateQuestion(question), true);
  store.set(scope + ":selection", { nonce, question, selected: [] });
  try {
    const seen = new Set();
    let args = `${nonce} 0`;
    for (let page = 0; page < 100; page++) {
      const response = await execute(ctx, "select", { args });
      assert.ok(!response.error, response.text);
      assert.ok(response.buttons.length <= 100);
      for (const b of response.buttons) {
        assert.ok(b.label.length <= 200);
        const option = b.args.match(/^max-choices (\d+)$/);
        if (option) seen.add(Number(option[1]));
      }
      const next = response.buttons.find((b) => /Далее/.test(b.label));
      if (!next) break;
      args = next.args;
    }
    assert.equal(seen.size, 100);
    assert.deepEqual(store.get(scope + ":selection").selected, [0]);
  } finally {
    store.close();
  }
});

test("failed web multiple-choice confirmation retains answers for explicit retry", async () => {
  const { registry } = require("../src/commandSystem/registry");
  const store = new CommandStore(":memory:");
  const scope = "w:selection-failure";
  const ctx = { scope, transport: "web", store };
  const nonce = "retry-choices";
  const state = { nonce, selected: [0, 1], question: { options: [{ value: "Answer A" }, { value: "Answer B" }] } };
  store.set(scope + ":selection", state);
  const chat = registry.get("chat"), original = chat.handler;
  let calls = 0;
  chat.handler = async (_context, answer) => {
    assert.equal(answer, "Answer A\nAnswer B");
    if (++calls === 1) throw Object.assign(new Error("temporary provider failure"), { code: "ETIMEDOUT" });
    return { text: "Both answers were received" };
  };
  try {
    const failed = await execute(ctx, "select", { args: nonce + " confirm" });
    assert.equal(failed.error, true);
    assert.deepEqual(store.get(scope + ":selection"), state);
    const retried = await execute(ctx, "select", { args: nonce + " confirm" });
    assert.ok(!retried.error);
    assert.equal(calls, 2);
    assert.equal(store.get(scope + ":selection"), null);
  } finally {
    chat.handler = original;
    store.close();
  }
});
