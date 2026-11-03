const test = require("node:test");
const assert = require("node:assert/strict");
const { withApp, launchApp } = require("../helpers/app");
const { reply } = require("../helpers/fakeOpenRouter");

// Windows permits socket sharing in cases where Linux rejects the bind. Inject the failed
// launch deterministically, then start a real bot and verify that it answers after recovery.
test("стенд: EADDRINUSE приводит к повторному запуску, следующий настоящий бот отвечает", async () => {
  let attempts = 0;
  await withApp({ launch: async (options) => {
    if (++attempts > 1) return launchApp(options);
    return { output: () => "Web server could not start EADDRINUSE", exited: () => ({ code: 1 }),
      waitForOutput: async () => true, stop: async () => {} };
  } }, async ({ tg, or }) => {
    or.chat = () => reply("работаю после повторного запуска");
    tg.message({ chatId: 777, text: "привет" });
    await tg.waitFor(() => tg.texts().length >= 1, 8000, "ответ");
    assert.equal(tg.texts()[0], "работаю после повторного запуска");
    assert.equal(attempts, 2);
  });
});
