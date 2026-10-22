const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  Module = require("node:module");
const { EventEmitter } = require("node:events");
const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), "orbit-command-tests-"),
);
Object.assign(process.env, {
  COMMAND_DB_FILE: path.join(directory, "commands.sqlite"),
  MEMORY_FILE: path.join(directory, "memory.json"),
  INTERACTIVE_STATE_FILE: path.join(directory, "interactive.json"),
  BOT_TOKEN: "test-only",
  OPENROUTER_API_KEY: "test-only",
  OPENROUTER_MODEL: "test/model",
  ACCOUNT_ASSISTANT_OWNER_CHAT_ID: "42",
  BOT_TO_BOT_OWNER_CHAT_ID: "42",
  BOT_TO_BOT_ENABLED: "true",
  BOT_TO_BOT_TARGET_BOT_USERNAME: "target_bot",
  TELEGRAM_API_ID: "123",
  TELEGRAM_API_HASH: "test-only",
  TELEGRAM_STRING_SESSION: "test-only",
});
class FakeBot extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.handlers = [];
    this.nextId = 0;
  }
  onText(re, fn) {
    this.handlers.push({ re, fn });
  }
  async getMe() {
    return { id: 100, username: "unit_bot" };
  }
  async setMyCommands(commands) {
    this.commands = commands;
  }
  async sendMessage(chatId, text, options = {}) {
    const m = {
      chat: { id: chatId },
      text,
      options,
      message_id: ++this.nextId,
    };
    this.sent.push(m);
    return m;
  }
  async sendChatAction() {}
  async sendPhoto(chatId, photo) {
    this.photo = photo;
    return { message_id: ++this.nextId };
  }
  async answerCallbackQuery() {}
  async editMessageReplyMarkup() {}
  async editMessageText(text,options) {this.edits ||= [];this.edits.push({text,options});return {message_id:options.message_id};}
}
class FakeAccount {
  constructor() {
    this.isConnected = false;
  }
  async connect() {
    this.isConnected = true;
  }
  async disconnect() {
    this.isConnected = false;
  }
  async checkAuthorization() {
    return true;
  }
  addEventHandler() {}
  async getInputEntity(value) {
    return value;
  }
  async sendMessage() {
    return { id: 1 };
  }
}
const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === "node-telegram-bot-api") return FakeBot;
  if (request === "telegram") return { TelegramClient: FakeAccount };
  if (request === "telegram/sessions") return { StringSession: class {} };
  if (request === "telegram/events") return { NewMessage: class {} };
  return originalLoad.call(this, request, ...args);
};
const telegram = require("../src/services/telegram"),
  bot = telegram.createTelegramBot({ polling: false });
const { getStore, CommandStore } = require("../src/commandSystem/store"),
  store = getStore();
store.set(
  "account:drafts",
  ["sendid", "dropid", "replyid", "redraftid"].map((id) => ({
    id,
    chatId: "88",
    incomingText: "Hello",
    reply: "Hi",
    reason: "unit",
    sendable: true,
    createdAt: new Date().toISOString(),
    noticeMessageId: 10,
  })),
);
const account = require("../src/services/accountAssistant");
Module._load = originalLoad;
const { registry, catalog } = require("../src/commandSystem/registry");
const {
  execute,
  tickReminders,
  validateResult,
} = require("../src/commandSystem/engine");
const tools = require("../src/commandSystem/tools");
require("../src/commands").initCommands(bot);
const msg = {
  chat: { id: 42, type: "private" },
  from: { id: 42 },
  message_id: 1,
};
const ctx = {
  scope: "t:42:42",
  transport: "telegram",
  chatId: 42,
  userId: 42,
  msg,
  store,
};
const web = { scope: "w:unit", transport: "web", userId: "unit", store };
const axios = require("axios");
axios.get = async () => ({
  data: {
    data: [{ id: "test/model", supported_parameters: ["structured_outputs"] }],
  },
});
axios.post = async () => ({
  data: {
    choices: [
      {
        message: {
          content: JSON.stringify({
            type: "text",
            text: "Реальный тестовый транспорт, не проверка живой модели.",
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
});
test.before(async () => {
  await account.startAccountAssistant(bot);
  await account.executeAccountCommand(msg, "account_enable", "");
});
const special = {
  account_send: "sendid",
  account_drop: "dropid",
  account_reply: "replyid My reply",
  account_redraft: "redraftid",
  account_message: "@target_user Hello",
  bot_send: "Hello",
  account_allow: "@target_user",
  account_unallow: "@target_user",
  account_block: "@target_user",
  account_unblock: "@target_user",
};
for (const c of registry.values()) {
  test(`registered command ${c.id}: metadata, valid launch, invalid schema`, async () => {
    assert.equal(c.id.length > 0, true);
    assert.ok(
      c.description &&
        c.icon &&
        c.category &&
        c.schema &&
        typeof c.handler === "function",
    );
    const context = c.availability.userbot
      ? {
          ...web,
          scope: "u:77:42",
          transport: "userbot",
          chatId: 77,
          client: {
            isConnected: true,
            getMe: async () => ({
              id: 42,
              firstName: "Unit",
              username: "unit",
            }),
          },
        }
      : c.owner || ["status", "reset", "voice", "lock"].includes(c.id)
        ? ctx
        : { ...web, scope: "w:test:" + c.id };
    if (c.id === "bot_chat")
      Object.assign(context, {
        transport: "telegram",
        chatId: 42,
        userId: 99,
        msg: { ...msg, from: { id: 99, is_bot: true, username: "target_bot" } },
      });
    let input = special[c.id] ?? c.example;
    if (c.id === "select") {
      context.store.set(context.scope + ":selection", {
        nonce: "test",
        question: {
          type: "interactive_question",
          question: "Pick",
          selection_mode: "multiple",
          allow_custom_input: true,
          options: [
            { id: "a", label: "A", value: "Option A" },
            { id: "b", label: "B", value: "Option B" },
          ],
        },
        selected: [],
      });
      input = "test 0";
    }
    if (c.id === "guess" || c.id === "riddle" || c.id === "challenge")
      input = "";
    if (c.id === "trivia" || c.id === "wouldyou") input = "";
    if (c.id === "weather")
      context.http = {
        get: async (url) =>
          url.includes("geocoding")
            ? {
                data: {
                  results: [{ name: "Kyiv", latitude: 50, longitude: 30 }],
                },
              }
            : {
                data: {
                  timezone: "Europe/Kyiv",
                  current: {
                    time: "2026-10-14T12:00",
                    temperature_2m: 10,
                    relative_humidity_2m: 70,
                    apparent_temperature: 8,
                    wind_speed_10m: 6,
                  },
                },
              },
      };
    if (c.id === "account_redraft")
      axios.post = async () => ({
        data: {
          choices: [
            {
              message: {
                content: '{"reply":"Updated","sendable":true,"reason":"safe"}',
              },
            },
          ],
        },
      });
    const output = await execute(
      context,
      c.id,
      { args: input },
      "valid:" + c.id,
    );
    assert.equal(output.error, undefined, `${c.id}: ${output.text}`);
    assert.ok(output.text || output.delivered);
    if (c.id === "account_redraft")
      axios.post = async () => ({
        data: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  type: "text",
                  text: "Тестовый ответ",
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
      });
    const invalid = await execute(
      context,
      c.id,
      { args: { execute: "unsafe" }, tool: "run" },
      "invalid:" + c.id,
    );
    assert.equal(invalid.error, true);
  });
}
test("legacy system commands, userbot aliases and hidden bot_chat contract are inventoried", () => {
  const old = [
    "start",
    "menu",
    "help",
    "voice",
    "status",
    "reset",
    "bot_status",
    "bot_send",
    "bot_chat",
    ...[
      "help",
      "status",
      "config",
      "pending",
      "send",
      "drop",
      "reply",
      "redraft",
      "message",
      "mode",
      "private",
      "allow",
      "unallow",
      "block",
      "unblock",
      "enable",
      "disable",
    ].map((n) => "account_" + n),
  ];
  for (const id of old) assert.ok(registry.has(id));
  for (const id of [
    "help",
    "ping",
    "say",
    "echo",
    "whoami",
    "status",
    "chatid",
    "time",
  ])
    assert.ok(registry.has("userbot_" + id));
  assert.ok(!catalog(web).some((c) => c.owner));
});
test("real utility calculations reject code, malformed arguments and nonfinite results", async () => {
  assert.equal(tools.calculate("2^3^2"), 512);
  assert.equal(tools.calculate("-2^2"), -4);
  assert.equal(tools.calculate("1e3 / 4"), 250);
  assert.equal(tools.calculate("(12+8)*3"), 60);
  for (const value of [
    "process.exit()",
    "1/0",
    "1e999",
    "1 2",
    "2(3)",
    "((1)",
    "9".repeat(600),
    "-".repeat(499) + "1",
  ])
    assert.throws(() => tools.calculate(value));
  assert.equal(tools.convert("32 f c"), "32 f = 0 c");
  assert.equal(tools.convert("10 km m"), "10 km = 10000 m");
  assert.throws(() => tools.convert("1 kg m"));
  assert.throws(() => tools.convert("-1 k c"));
  assert.equal(tools.base64("decode 0J/RgNC40LLQtdGC"), "Привет");
  assert.throws(() => tools.base64("decode !!!!"));
  assert.throws(() => tools.base64("decode /w=="));
  for (const [id, args] of [
    ["uuid", "0"],
    ["password", "7"],
    ["hash", "md5 hello"],
    ["json", "{bad}"],
    ["timestamp", "tomorrow"],
    ["time", "Mars/Nowhere"],
    ["random", "100 1"],
    ["decision", "only"],
    ["morse", "Привет"],
    ["reminder", "1m"],
    ["quiz", "science impossible"],
    ["account_private", "banana"],
  ])
    assert.equal(
      (await execute(id.startsWith("account") ? ctx : web, id, { args })).error,
      true,
      id,
    );
});
test("password has all character classes; QR is an actual PNG and hash matches crypto", async () => {
  const p = tools.password("32");
  assert.equal(p.length, 32);
  for (const re of [/[A-Z]/, /[a-z]/, /[0-9]/, /[!@#$%&*+_=-]/])
    assert.match(p, re);
  const qr = await tools.qr("Hello");
  assert.equal(
    Buffer.from(qr.split(",")[1], "base64").subarray(0, 8).toString("hex"),
    "89504e470d0a1a0a",
  );
  const output = await execute(web, "hash", { args: "sha256 Hello" });
  assert.equal(
    output.text,
    require("crypto").createHash("sha256").update("Hello").digest("hex"),
  );
});
test("quiz really scores all nine banks; stale answers and concurrent double clicks cannot advance twice", async () => {
  for (const topic of ["programming", "science", "geography"])
    for (const difficulty of ["easy", "medium", "hard"]) {
      const context = { ...web, scope: `w:quiz:${topic}:${difficulty}` };
      let output = await execute(context, "quiz", {
        args: topic + " " + difficulty,
      });
      for (let i = 0; i < 3; i++) {
        const state = store.get(context.scope + ":quiz");
        const button = output.buttons[state.questions[state.index][2]];
        output = await execute(context, "quiz", { args: button.args });
        assert.equal(output.error, undefined);
        if (i === 0) {
          const stale = await execute(context, "quiz", { args: button.args });
          assert.equal(stale.error, true);
        }
      }
      assert.match(output.text, /3\/3/);
    }
  const c = { ...web, scope: "w:quiz:race" };
  const first = await execute(c, "quiz", { args: "science easy" }),
    action = first.buttons[0];
  await Promise.all([
    execute(c, "quiz", { args: action.args }, "race1"),
    execute(c, "quiz", { args: action.args }, "race2"),
  ]);
  assert.equal(store.get(c.scope + ":quiz").index, 1);
});
test("guess, riddle, learning and challenge check user answers and finish", async () => {
  const c = { ...web, scope: "w:games" };
  await execute(c, "guess", { args: "" });
  const game = store.get(c.scope + ":guess");
  assert.match(
    (await execute(c, "guess", { args: String(game.number) })).text,
    /Угадал/,
  );
  await execute(c, "riddle", { args: "" });
  assert.ok((await execute(c, "riddle", { args: "hint" })).text);
  assert.match((await execute(c, "riddle", { args: "reveal" })).text, /Ответ/);
  await execute(c, "challenge", { args: "" });
  assert.match(
    (
      await execute(c, "challenge", {
        args: String(store.get(c.scope + ":challenge").answer),
      })
    ).text,
    /Верно/,
  );
  let output = await execute(c, "learnjs", { args: "" });
  for (let i = 0; i < 5; i++) {
    const g = store.get(c.scope + ":learnjs");
    output = await execute(c, "learnjs", {
      args: output.buttons[g.questions[g.index][2]].args,
    });
  }
  assert.match(output.text, /5\/5/);
});
test("notes and tasks persist across reopening, stay isolated, and duplicate requests do not add twice", async () => {
  const c = { ...web, scope: "w:persistence" };
  await Promise.all([
    execute(c, "notes", { args: "add Stored" }, "same"),
    execute(c, "notes", { args: "add Stored" }, "same"),
  ]);
  assert.equal(store.get(c.scope + ":notes").length, 1);
  const reopened = new CommandStore(process.env.COMMAND_DB_FILE);
  assert.equal(reopened.get(c.scope + ":notes")[0].text, "Stored");
  reopened.close();
  assert.match(
    (await execute({ ...c, scope: "w:other" }, "notes", { args: "" })).text,
    /Пока пусто/,
  );
  const note = store.get(c.scope + ":notes")[0];
  assert.equal(
    (
      await execute({ ...c, scope: "w:other" }, "notes", {
        args: "delete " + note.id,
      })
    ).error,
    true,
  );
  await execute(c, "todo", { args: "add Finish tests" });
  const task = store.get(c.scope + ":todo")[0];
  await execute(c, "todo", { args: "done " + task.id });
  assert.equal(store.get(c.scope + ":todo")[0].done, true);
});
test("favorites/recent and multi-step input prompts survive reopening", async () => {
  const c = { ...web, scope: "w:profile" };
  await execute(c, "favorite", { args: "quiz" });
  assert.match(
    (await execute(c, "favorites", { args: "" })).buttons[0].command,
    /quiz/,
  );
  await execute(c, "json", { args: "" });
  const reopened = new CommandStore(process.env.COMMAND_DB_FILE);
  assert.equal(reopened.get(c.scope + ":prompt").command, "json");
  assert.deepEqual(reopened.get(c.scope + ":profile").favorites, ["quiz"]);
  reopened.close();
});
test("scheduler persists, leases across connections, delivers once to inbox and retries failed Telegram", async () => {
  const c = { ...web, scope: "w:reminders" };
  const id = store.addReminder(c, "Due now", Date.now() - 1);
  const reopened = new CommandStore(process.env.COMMAND_DB_FILE);
  await tickReminders(reopened);
  await tickReminders(store);
  assert.equal(store.inbox(c.scope).filter((n) => n.id === id).length, 1);
  reopened.close();
  const tg = { ...ctx, scope: "t:42:42:reminder" },
    tid = store.addReminder(tg, "Telegram", Date.now() - 1);
  await tickReminders(store, {
    sendMessage: async () => {
      throw new Error("network");
    },
  });
  assert.equal(store.reminders(tg.scope)[0].attempts, 1);
  await tickReminders(
    store,
    { sendMessage: async () => {} },
    Date.now() + 120000,
  );
  assert.equal(store.inbox(tg.scope)[0].id, tid);
});
test("button data is opaque, durable, message bound, owner bound and single use", async () => {
  const { deliver } = require("../src/commandSystem/telegram");
  await deliver(bot, ctx, {
    text: "Test",
    buttons: [{ label: "UUID", command: "uuid", args: "1" }],
  });
  const sent = bot.sent.at(-1),
    data = sent.options.reply_markup.inline_keyboard[0][0].callback_data;
  assert.ok(Buffer.byteLength(data) <= 64);
  const id = data.slice(4);
  assert.throws(() => store.takeAction("t:42:99", sent.message_id, id));
  assert.throws(() => store.takeAction(ctx.scope, 999999, id));
  assert.equal(
    store.takeAction(ctx.scope, sent.message_id, id).command,
    "uuid",
  );
  assert.throws(() => store.takeAction(ctx.scope, sent.message_id, id));
  assert.throws(() =>
    validateResult(
      {
        text: "unsafe",
        buttons: [{ label: "run", command: "process.exit", args: "" }],
      },
      web,
    ),
  );
});
test("slash routing, command mention, callbacks and manual input use real handlers without duplicate execution", async () => {
  const { handleCommandInput } = require("../src/commandSystem/telegram");
  const command = bot.handlers.find((h) => h.re.test("/uuid 1"));
  let message = { ...msg, message_id: 700, text: "/uuid 1" };
  const before = bot.sent.length;
  await command.fn(message, message.text.match(command.re));
  assert.ok(bot.sent.length > before);
  await command.fn(message, message.text.match(command.re));
  assert.equal(bot.sent.length, before + 1);
  const callback = bot
    .listeners("callback_query")
    .find((fn) => fn.toString().includes("cmd:"));
  const sent = bot.sent.at(-1),
    data = sent.options.reply_markup.inline_keyboard[0][0].callback_data;
  await callback({
    id: "unit_callback",
    from: msg.from,
    message: { chat: msg.chat, message_id: sent.message_id },
    data,
  });
  assert.ok(bot.edits?.some(edit=>edit.options.message_id===sent.message_id));
  message = { ...msg, message_id: 701, text: "/notes" };
  await command.fn(message, message.text.match(command.re));
  await handleCommandInput(bot, {
    ...msg,
    message_id: 702,
    text: "add From button prompt",
  });
  assert.ok(
    store
      .get(ctx.scope + ":notes")
      .some((n) => n.text === "From button prompt"),
  );
});
test("account JSON validates exact types and unapproved drafts do not enter sent history", () => {
  const { parseAccountAssistantDraft } = require("../src/services/openrouter");
  assert.equal(
    parseAccountAssistantDraft('{"reply":"Hi","sendable":"true","reason":"x"}')
      .sendable,
    false,
  );
  assert.equal(
    parseAccountAssistantDraft('{"reply":{},"sendable":true,"reason":"x"}')
      .sendable,
    false,
  );
  assert.equal(
    parseAccountAssistantDraft(
      '{"reply":"Hi","sendable":true,"reason":"x","tool":"send"}',
    ).sendable,
    false,
  );
  assert.ok(
    !require("../src/services/memory")
      .getUserMemory("account:88")
      .messages.some((m) => m.content === "Updated"),
  );
});
test("weather validates real response fields and does not invent results after service errors", async () => {
  let calls = 0;
  const http = {
    get: async () =>
      ++calls === 1
        ? {
            data: {
              results: [
                {
                  name: "Kyiv",
                  country: "Ukraine",
                  latitude: 50.45,
                  longitude: 30.52,
                },
              ],
            },
          }
        : {
            data: {
              timezone: "Europe/Kyiv",
              current: {
                time: "2026-10-14T12:00",
                temperature_2m: 10,
                relative_humidity_2m: 70,
                apparent_temperature: 8,
                wind_speed_10m: 6,
              },
            },
          },
  };
  assert.match(await tools.weather("Kyiv", http), /10 °C/);
  const response = await execute(
    {
      ...web,
      http: {
        get: async () => {
          const e = new Error("token SECRET");
          e.response = { status: 429 };
          throw e;
        },
      },
    },
    "weather",
    { args: "Kyiv" },
  );
  assert.equal(response.error, true);
  assert.match(response.text, /Лимит/);
  assert.ok(!response.text.includes("SECRET"));
});
test("new multi-select AI scenarios toggle options, confirm every value and do not execute model actions", async () => {
  const c = { ...web, scope: "w:multiselect" },
    responses = [
      {
        type: "interactive_question",
        question: "Выбери занятия",
        selection_mode: "multiple",
        allow_custom_input: true,
        options: [
          { id: "a", label: "Почитать", value: "Почитать книгу" },
          { id: "b", label: "Погулять", value: "Погулять в парке" },
        ],
      },
      "Выбраны книга и прогулка.",
    ];
  let body;
  axios.post = async (url, input) => {
    body = input;
    return {
      data: {
        choices: [
          {
            message: {
              content:
                typeof responses[0] === "string"
                  ? responses.shift()
                  : JSON.stringify(responses.shift()),
            },
            finish_reason: "stop",
          },
        ],
      },
    };
  };
  let response = await execute(c, "brainstorm", { args: "Чем заняться?" });
  assert.equal(response.buttons[0].command, "select");
  response = await execute(c, "select", { args: response.buttons[0].args });
  response = await execute(c, "select", { args: response.buttons[1].args });
  const confirm = response.buttons.at(-1);
  response = await execute(c, "select", { args: confirm.args });
  assert.match(response.text, /книга/);
  assert.ok(body.messages.at(-1).content.includes("Почитать книгу"));
  assert.ok(body.messages.at(-1).content.includes("Погулять в парке"));
  assert.equal(
    (await execute(c, "select", { args: confirm.args })).error,
    true,
  );
});
test("full application starts an actual HTTP server with injected Telegram and shuts down cleanly", async () => {
  const app = require("../src/bot").start({ bot, port: 0, host: "127.0.0.1" });
  await new Promise((r) => app.server.once("listening", r));
  const url = "http://127.0.0.1:" + app.server.address().port;
  assert.deepEqual(await (await fetch(url + "/health")).json(), { ok: true });
  assert.match(await (await fetch(url + "/")).text(), /Orbit AI/);
  app.stopScheduler();
  await new Promise((r) => app.server.close(r));
});
