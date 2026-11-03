process.env.LOG_LEVEL = "silent";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const userbot = require("../../scripts/userbot");

const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const settings = { session: "loaded-session", allowedUserIds: [], apiId: 12345 };

// Minimal event in the shape gramjs produces for a new message.
function makeEvent({ text, out = false, senderId = 900, chatId = 900 }) {
  const replies = [];

  return {
    replies,
    event: {
      message: {
        out,
        message: text,
        senderId,
        chatId,
        reply: async ({ message }) => {
          replies.push(message);
        }
      }
    }
  };
}

function makeClient({ connected = true } = {}) {
  return {
    connected,
    getMe: async () => ({ id: 1, username: "owner_user", firstName: "Owner", lastName: "Account" })
  };
}

async function run(text, options = {}, userSettings = settings) {
  const { event, replies } = makeEvent({ text, ...options });

  await userbot.handleIncomingMessage(makeClient(options.client), event, userSettings);
  return replies;
}

test("parseCommand: только точка как префикс, регистр имени не важен, аргументы сохраняют переводы строк", () => {
  assert.deepEqual(userbot.parseCommand(".ping"), { name: "ping", args: "" });
  assert.deepEqual(userbot.parseCommand("  .SAY привет\nмир  "), { name: "say", args: "привет\nмир" });
  assert.equal(userbot.parseCommand("/ping"), null, "слэш больше не префикс команд");
  assert.equal(userbot.parseCommand("просто текст .ping"), null);
  assert.equal(userbot.parseCommand(""), null);
  assert.equal(userbot.parseCommand(null), null);
  assert.equal(userbot.parseCommand(`${ZERO_WIDTH_SPACE}.ping`), null);
});

test("isAuthorized: свои исходящие и перечисленные ID, остальные нет (F004)", () => {
  assert.equal(userbot.isAuthorized({ out: true }), true);
  assert.equal(userbot.isAuthorized({ out: false, senderId: 900 }), false);
  assert.equal(userbot.isAuthorized({ out: false, senderId: 900 }, ["900"]), true);
  assert.equal(userbot.isAuthorized({ out: false, senderId: BigInt(901) }, ["901"]), true);
  assert.equal(userbot.isAuthorized({ out: false }, ["900"]), false);
});

test("посторонний не может вызвать ни одну команду и не узнаёт, что это userbot (F004, было: отвечал всем)", async () => {
  for (const text of [".ping", ".status", ".whoami", ".chatid", ".time", ".help", ".say привет всем", ".echo привет", "/echo через слэш", "а ты случайно не userbot?"]) {
    assert.deepEqual(await run(text), [], `${text} от постороннего не должна получать ответ`);
  }
});

test("посторонний в группе не может заставить аккаунт писать от имени владельца (F004)", async () => {
  assert.deepEqual(await run(".say спам в группе от имени владельца", { senderId: 901, chatId: -100500 }), []);
});

test("владелец управляет сам: его исходящие команды отвечают (F004, было: игнорировались)", async () => {
  assert.deepEqual(await run(".ping", { out: true }), ["pong"]);
  assert.deepEqual(await run(".say раз два", { out: true }), ["раз два"]);
  assert.deepEqual(await run(".echo эхо", { out: true }), ["эхо"]);
  assert.match((await run(".help", { out: true }))[0], /\.help.*\n\.ping.*\n\.say.*\n\.echo.*\n\.whoami.*\n\.status.*\n\.chatid.*\n\.time/s);
});

test("пользователь из USERBOT_ALLOWED_USER_IDS тоже может, остальные нет (F004)", async () => {
  const withAllowList = { ...settings, allowedUserIds: ["900"] };

  assert.deepEqual(await run(".ping", { senderId: 900 }, withAllowList), ["pong"]);
  assert.deepEqual(await run(".ping", { senderId: 901 }, withAllowList), []);
});

test(".say .say x не зацикливается: ответ не начинается с префикса команды", async () => {
  const [reply] = await run(".say .say .say привет", { out: true });

  assert.ok(reply.startsWith(ZERO_WIDTH_SPACE));
  assert.equal(userbot.parseCommand(reply), null, "собственный ответ не должен распознаваться как команда");
  assert.equal(await run(reply, { out: true }).then((replies) => replies.length), 0);
});

test(".say/.echo без аргумента подсказывают формат", async () => {
  assert.deepEqual(await run(".say", { out: true }), ["Использование: .say <текст>"]);
  assert.deepEqual(await run(".echo", { out: true }), ["Использование: .echo <текст>"]);
});

test(".status показывает реальное подключение и не раскрывает API ID (F026, F004)", async () => {
  const [connected] = await run(".status", { out: true });
  const [disconnected] = await run(".status", { out: true, client: { connected: false } });

  assert.match(connected, /Connected: yes/);
  assert.match(disconnected, /Connected: no/);
  assert.match(connected, /Session: loaded/);
  assert.match(connected, /Username: owner_user/);
  assert.doesNotMatch(connected, /12345|API ID/);
});

test(".whoami, .chatid, .time и неизвестная команда", async () => {
  assert.match((await run(".whoami", { out: true }))[0], /Я: Owner Account\nUsername: owner_user\nID: 1/);
  assert.deepEqual(await run(".chatid", { out: true, chatId: 4242 }), ["Chat ID: 4242"]);
  assert.match((await run(".time", { out: true }))[0], /^Текущее время: /);
  assert.deepEqual(await run(".nonexistent", { out: true }), []);
});

test("настройки: список разрешённых, булевы значения, обязательные переменные", () => {
  const warnings = [];
  const parsed = userbot.readSettings({
    TELEGRAM_API_ID: "12345",
    TELEGRAM_API_HASH: "abc",
    TELEGRAM_STRING_SESSION: "sess",
    USERBOT_ALLOWED_USER_IDS: "1, 2,abc",
    USERBOT_SEND_SELF: "yes"
  }, (message) => warnings.push(message));

  assert.deepEqual(parsed.allowedUserIds, ["1", "2"]);
  assert.equal(parsed.sendSelfOnStart, true);
  assert.equal(parsed.startMessage, "Userbot started.");
  assert.equal(warnings.length, 1);
  assert.doesNotThrow(() => userbot.validateSettings(parsed));

  const broken = userbot.readSettings({ TELEGRAM_API_ID: "my_id" }, () => {});

  assert.throws(() => userbot.validateSettings(broken), /TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_STRING_SESSION/);
});

test("startUserbot: подписка без фильтра incoming, обработчик различает владельца и чужого", async () => {
  const created = { newMessageOptions: null, handler: null, sent: [], disconnected: 0 };
  const originalLoad = Module._load;
  const listenersBefore = {
    unhandledRejection: process.listeners("unhandledRejection").slice(),
    SIGINT: process.listeners("SIGINT").slice(),
    SIGTERM: process.listeners("SIGTERM").slice()
  };

  class FakeClient {
    constructor() {
      this.connected = true;
    }

    addEventHandler(handler) {
      created.handler = handler;
    }

    async connect() {}

    async getMe() {
      return { id: 1, username: "owner_user", firstName: "Owner" };
    }

    async sendMessage(peer, options) {
      created.sent.push({ peer, ...options });
    }

    async disconnect() {
      created.disconnected += 1;
    }
  }

  class FakeNewMessage {
    constructor(options) {
      created.newMessageOptions = options;
    }
  }

  Module._load = function patchedLoad(request, ...rest) {
    if (request === "telegram") {
      return { TelegramClient: FakeClient };
    }

    if (request === "telegram/sessions") {
      return { StringSession: class StringSession {} };
    }

    if (request === "telegram/events") {
      return { NewMessage: FakeNewMessage };
    }

    return originalLoad.call(this, request, ...rest);
  };

  try {
    await userbot.startUserbot({
      TELEGRAM_API_ID: "12345",
      TELEGRAM_API_HASH: "hash",
      TELEGRAM_STRING_SESSION: "sess",
      USERBOT_SEND_SELF: "true",
      USERBOT_START_MESSAGE: "я запущен"
    });

    assert.deepEqual(created.newMessageOptions, {}, "без {incoming: true}: собственные сообщения владельца тоже события");
    assert.deepEqual(created.sent, [{ peer: "me", message: "я запущен" }]);

    const stranger = makeEvent({ text: ".status", out: false });
    const owner = makeEvent({ text: ".ping", out: true });

    await created.handler(stranger.event);
    await created.handler(owner.event);

    assert.deepEqual(stranger.replies, []);
    assert.deepEqual(owner.replies, ["pong"]);
  } finally {
    Module._load = originalLoad;

    for (const [event, before] of Object.entries(listenersBefore)) {
      for (const listener of process.listeners(event)) {
        if (!before.includes(listener)) {
          process.removeListener(event, listener);
        }
      }
    }
  }
});

test("startUserbot без настроек падает с понятной ошибкой до подключения", async () => {
  await assert.rejects(() => userbot.startUserbot({}), /Missing Telegram userbot configuration in \.env: TELEGRAM_API_ID/);
});
