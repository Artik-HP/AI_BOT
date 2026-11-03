const test = require("node:test");
const assert = require("node:assert/strict");
const { createKeyedQueue } = require("../../src/utils/queue");
const { createTtlSet } = require("../../src/utils/ttlSet");
const { safeHandler, trySendMessage } = require("../../src/utils/safe");
const logger = require("../../src/utils/logger");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("createKeyedQueue: задачи одного ключа идут по порядку, разных - параллельно", async () => {
  const enqueue = createKeyedQueue();
  const events = [];

  const a1 = enqueue("a", async () => { await sleep(40); events.push("a1"); });
  const a2 = enqueue("a", async () => { events.push("a2"); });
  const b1 = enqueue("b", async () => { events.push("b1"); });

  await Promise.all([a1, a2, b1]);

  assert.deepEqual(events, ["b1", "a1", "a2"]);
});

test("createKeyedQueue: упавшая задача не блокирует очередь", async () => {
  const enqueue = createKeyedQueue();
  const events = [];

  const failing = enqueue("k", async () => { throw new Error("boom"); });
  const next = enqueue("k", async () => { events.push("after"); });

  await assert.rejects(failing, /boom/);
  await next;
  assert.deepEqual(events, ["after"]);
});

test("createTtlSet: claim, истечение срока и лимит размера", async () => {
  const set = createTtlSet(40, { maxSize: 3 });

  assert.equal(set.claim("x"), true);
  assert.equal(set.claim("x"), false);
  assert.equal(set.has("x"), true);

  await sleep(60);
  assert.equal(set.has("x"), false);
  assert.equal(set.claim("x"), true);

  set.add("a");
  set.add("b");
  set.add("c");
  assert.equal(set.size, 3);
  assert.equal(set.has("x"), false, "самая старая запись вытеснена");
});

test("safeHandler: ошибка обработчика логируется и не выбрасывается", async () => {
  const lines = [];
  logger.setOutput({ error: (line) => lines.push(line) });

  try {
    const wrapped = safeHandler("тест", async () => { throw new Error("сломалось"); });

    assert.equal(await wrapped(), undefined);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /тест failed:.*сломалось/);

    const ok = safeHandler("ок", async (a, b) => a + b);
    assert.equal(await ok(2, 3), 5);
  } finally {
    logger.setOutput({ error: (line) => console.error(line) });
  }
});

test("trySendMessage: заблокированный бот не роняет вызывающего", async () => {
  const lines = [];
  logger.setOutput({ warn: (line) => lines.push(line) });

  try {
    const bot = { sendMessage: async () => { throw new Error("ETELEGRAM: 403 Forbidden: bot was blocked by the user"); } };

    assert.equal(await trySendMessage(bot, 123, "привет"), null);
    assert.match(lines[0], /Could not send message to 123/);

    const good = { sendMessage: async (chatId, text) => ({ chatId, text }) };
    assert.deepEqual(await trySendMessage(good, 1, "ок"), { chatId: 1, text: "ок" });
  } finally {
    logger.setOutput({ warn: (line) => console.warn(line) });
  }
});
