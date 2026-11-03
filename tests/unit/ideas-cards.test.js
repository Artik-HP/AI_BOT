process.env.LOG_LEVEL = "silent";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadFresh } = require("../helpers/freshModules");
const { createFakeBot } = require("../helpers/fakeBot");
const { TEST_PASSWORD, TEST_PASSWORD_HASH } = require("../helpers/authFixture");

// The idea commands in-process, against a fake bot: no Telegram, and the model's address is a closed port, so any
// request to it would end as a second message with the AI error.
async function loadIdeaCommands(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aibot-cards-"));
  const handlers = loadFresh("handlers/ideas", {
    BOT_PASSWORD_HASH: TEST_PASSWORD_HASH,
    MEMORY_FILE: path.join(dir, "memory.json"),
    OPENROUTER_BASE_URL: "http://127.0.0.1:9/api/v1",
    COMPANION_DEFAULT_PERSONA: undefined,
    ...env
  });
  const auth = require("../../src/services/auth");

  return { handlers, auth, dir };
}

let nextMessageId = 1;

async function signedMessage(auth, userId, text, chat = { id: userId, type: "private" }) {
  if (!auth.auth.authenticated(userId)) {
    assert.equal((await auth.auth.authenticate(userId, TEST_PASSWORD)).ok, true);
  }

  const msg = { message_id: nextMessageId++, chat, from: { id: userId, first_name: "Тест" }, text };

  auth.captureMessage(msg);
  return msg;
}

test("D5: сбой генератора — прежний текст «Искра не загорелась», и к модели ни одного запроса", async () => {
  const { handlers, auth } = await loadIdeaCommands();
  const bot = createFakeBot();

  for (const history of [{ draw() { throw new Error("broken"); } }, { draw: () => ({ ok: false, error: "spark_unavailable" }) }]) {
    const commands = handlers.createIdeaCommands({ bot, history });

    bot.sent.length = 0;
    await commands.command("spark", await signedMessage(auth, 701, "/spark"));
    assert.deepEqual(bot.sent.map((entry) => entry.text), [handlers.SPARK_FAILED]);
  }
});

test("D5: человек вышел до броска — карточки нет, искра не записана в историю", async () => {
  const { handlers, auth } = await loadIdeaCommands();
  const bot = createFakeBot();
  let draws = 0;
  const commands = handlers.createIdeaCommands({ bot, history: { draw() { draws += 1; return { ok: false }; } } });
  const msg = await signedMessage(auth, 702, "/spark");

  auth.auth.logout(702);
  await commands.command("spark", msg);
  assert.deepEqual([bot.sent.length, draws], [0, 0]);
});
