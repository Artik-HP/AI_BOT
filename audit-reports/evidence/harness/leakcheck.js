const { FakeTelegram } = require("./fakeTelegram");
const { FakeOpenRouter } = require("./fakeOpenRouter");
const { launchApp, waitReady } = require("./launch");
(async () => {
  const tg = await new FakeTelegram().start(), or = await new FakeOpenRouter().start();
  const app = await launchApp({ tg, or, env: {} });
  await waitReady(tg, app);
  tg.failNext("sendMessage", 403, "Forbidden: bot was blocked by the user");
  tg.message({ chatId: 77, text: "/help", firstName: "Тест" });
  await Promise.race([app.exitPromise, new Promise((r) => setTimeout(r, 4000))]);
  const out = app.output();
  console.log(JSON.stringify({
    exited: app.exited(),
    crashDumpContainsBotToken: out.includes("FAKE_TOKEN_FOR_TESTS"),
    crashDumpContainsRequestUrlWithBotPath: /\/bot[^\/\s']*FAKE_TOKEN_FOR_TESTS\/sendMessage/.test(out),
    crashDumpLines: out.split("\n").length
  }));
  await app.stop(); await tg.stop(); await or.stop();
})();
