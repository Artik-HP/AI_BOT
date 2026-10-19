const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  Module = require("node:module");
const { EventEmitter } = require("node:events");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-access-")),
  password = "test-password-only",
  salt = crypto.randomBytes(16).toString("hex");
Object.assign(process.env, {
  BOT_ACCESS_PASSWORD_HASH: `scrypt:${salt}:${crypto.scryptSync(password, salt, 32).toString("hex")}`,
  BOT_ACCESS_IDLE_MS: "600000",
  COMMAND_DB_FILE: path.join(directory, "commands.sqlite"),
  MEMORY_FILE: path.join(directory, "memory.json"),
  INTERACTIVE_STATE_FILE: path.join(directory, "interactive.json"),
  BOT_TOKEN: "test-only",
  OPENROUTER_API_KEY: "test-only",
  ACCOUNT_ASSISTANT_ENABLED: "false",
});
class Bot extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.handlers = [];
    this.answers = [];
    this.deleted = [];
    this.next = 0;
  }
  onText(re, fn) {
    this.handlers.push({ re, fn });
  }
  async getMe() {
    return { id: 99, username: "access_test_bot" };
  }
  async setMyCommands() {}
  async sendMessage(chatId, text, options) {
    const m = { message_id: ++this.next, chat: { id: chatId }, text, options };
    this.sent.push(m);
    return m;
  }
  async sendChatAction() {}
  async answerCallbackQuery(id, options) {
    this.answers.push({ id, options });
  }
  async deleteMessage(chat, id) {
    this.deleted.push({ chat, id });
  }
  async editMessageText(text, options) {
    return { message_id: options.message_id };
  }
  async editMessageReplyMarkup() {}
}
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  return name === "node-telegram-bot-api"
    ? Bot
    : originalLoad.call(this, name, ...args);
};
const telegram = require("../src/services/telegram"),
  bot = telegram.createTelegramBot({ polling: false });
Module._load = originalLoad;
const {
    AccessGate,
    getAccessGate,
    verifyPassword,
  } = require("../src/services/access"),
  { getStore, CommandStore } = require("../src/commandSystem/store"),
  store = getStore();
const gate = getAccessGate();
let now = 1000000;
gate.now = () => now;
const owner = {
  chat: { id: 1, type: "private" },
  from: { id: 1 },
  message_id: 10,
};
require("../src/commands").initCommands(bot);
require("../src/handlers/text").registerTextHandler(
  bot,
  require("../src/commands"),
);
require("../src/handlers/voice").registerVoiceHandler(bot);
require("../src/handlers/photo").registerPhotoHandler(bot);
require("../src/services/conversation").registerInteractiveHandler(bot);
const account = require("../src/services/accountAssistant");
test.before(() => account.startAccountAssistant(bot));
async function slash(text, id = ++owner.message_id) {
  const msg = { ...owner, message_id: id, text };
  const h = bot.handlers.find((h) => h.re.test(text));
  await h.fn(msg, text.match(h.re));
}
test("password hash verifies in constant-time comparison, no plain password stored in hash", () => {
  assert.ok(verifyPassword(password, process.env.BOT_ACCESS_PASSWORD_HASH));
  assert.equal(
    verifyPassword("wrong", process.env.BOT_ACCESS_PASSWORD_HASH),
    false,
  );
  assert.ok(!process.env.BOT_ACCESS_PASSWORD_HASH.includes(password));
});
test("locked commands, text, voice, images and every callback family do not invoke AI", async () => {
  const axios = require("axios");
  let calls = 0;
  axios.post = async () => {
    calls++;
    throw new Error("Unexpected AI request");
  };
  await slash("/uuid 1");
  assert.match(bot.sent.at(-1).text, /заблокирован/);
  for (const payload of [
    { text: "Hello" },
    { voice: { file_id: "v" } },
    { photo: [{ file_id: "p", width: 10, height: 10 }] },
  ])
    for (const listener of bot.listeners("message"))
      await listener({ ...owner, message_id: ++owner.message_id, ...payload });
  for (const data of [
    "cmd:012345678901234567890123",
    "iq:0123456789abcdef:o:0",
    "menu:help",
    "account:send:id",
  ])
    for (const listener of bot.listeners("callback_query"))
      await listener({
        id: "cb" + data,
        from: owner.from,
        message: { chat: owner.chat, message_id: 1 },
        data,
      });
  assert.equal(calls, 0);
  assert.ok(bot.answers.some((a) => a.options?.show_alert));
  assert.equal(gate.authorized(owner, false), false);
});
test("login unlocks, removes password message and never records credentials in conversation or request data", async () => {
  await slash("/start " + password);
  assert.equal(gate.authorized(owner, false), true);
  assert.ok(bot.deleted.length);
  await slash("/uuid 1");
  assert.match(bot.sent.at(-1).text, /^[a-f0-9-]{36}$/);
  const requests = store.db.prepare("SELECT result FROM requests").all();
  assert.ok(!JSON.stringify(requests).includes(password));
  assert.ok(
    !JSON.stringify(
      require("../src/services/memory").getUserMemory("t:1:1"),
    ).includes(password),
  );
});
test("exact 10-minute inactivity limit, activity extends access, other user remains locked and restart locks again", () => {
  now += 599999;
  assert.ok(gate.authorized(owner));
  now += 599999;
  assert.ok(gate.authorized(owner, false));
  now++;
  assert.equal(gate.authorized(owner, false), false);
  gate.login(owner, password);
  assert.equal(gate.authorized({ ...owner, from: { id: 2 } }, false), false);
  const restarted = new AccessGate(store, {
    hash: gate.hash,
    now: () => now,
    idleMs: 600000,
  });
  assert.equal(restarted.authorized(owner, false), false);
});
test("wrong password revokes access, brute force is throttled and group login is refused", () => {
  gate.login(owner, password);
  gate.login(owner, "wrong");
  assert.equal(gate.authorized(owner, false), false);
  for (let i = 0; i < 4; i++) gate.login(owner, "wrong");
  assert.match(gate.login(owner, password).text, /минуту/);
  now += 60001;
  assert.ok(gate.login(owner, password).ok);
  assert.equal(
    gate.login({ ...owner, chat: { id: -100, type: "group" } }, password).ok,
    false,
  );
});
test("old buttons and commands remain denied after timeout; explicit lock works", async () => {
  now += 600001;
  await slash("/notes list");
  assert.match(bot.sent.at(-1).text, /заблокирован/);
  await slash("/start " + password);
  await slash("/lock");
  assert.equal(gate.authorized(owner, false), false);
});
test("local web login uses configured hash, requires auth and retains personal scope after logout/login", async () => {
  const app = require("../src/web").createWebApp({ store, accessToken: "" }),
    server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const url = "http://127.0.0.1:" + server.address().port;
  try {
    assert.equal((await fetch(url + "/api/session")).status, 401);
    const first = await fetch(url + "/api/session", {
        headers: { "X-Access-Token": password },
      }),
      cookie = first.headers.get("set-cookie").split(";")[0],
      csrf = (await first.json()).csrf;
    const headers = {
      Cookie: cookie,
      "X-CSRF-Token": csrf,
      "Content-Type": "application/json",
      "Idempotency-Key": "note",
    };
    await fetch(url + "/api/commands/notes", {
      method: "POST",
      headers,
      body: '{"args":"add Private note"}',
    });
    await fetch(url + "/api/logout", { method: "POST", headers, body: "{}" });
    assert.equal(
      (await fetch(url + "/api/commands", { headers: { Cookie: cookie } }))
        .status,
      401,
    );
    const second = await fetch(url + "/api/session", {
        headers: { Cookie: cookie, "X-Access-Token": password },
      }),
      nextCookie = second.headers.get("set-cookie").split(";")[0],
      nextCsrf = (await second.json()).csrf;
    const response = await fetch(url + "/api/commands/notes", {
      method: "POST",
      headers: {
        ...headers,
        Cookie: nextCookie,
        "X-CSRF-Token": nextCsrf,
        "Idempotency-Key": "read",
      },
      body: '{"args":"list"}',
    });
    assert.match((await response.json()).text, /Private note/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
test("auth sessions persist in DB but a new process generation cannot reuse an unlocked record", () => {
  gate.login(owner, password);
  const reopened = new CommandStore(process.env.COMMAND_DB_FILE),
    fresh = new AccessGate(reopened, {
      hash: gate.hash,
      now: () => now,
      idleMs: 600000,
    });
  assert.equal(fresh.authorized(owner, false), false);
  reopened.close();
});
