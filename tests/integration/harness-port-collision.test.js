const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");
const { withApp } = require("../helpers/app");
const { reply } = require("../helpers/fakeOpenRouter");

// Тесты идут параллельно в разных процессах, а порт для бота сначала резервируется (freePort), потом освобождается
// и лишь затем занимается самим ботом. Иногда чужой процесс успевает перехватить его: так плавающе падал CI на Node 24
// ("EADDRINUSE"). Этот тест воспроизводит столкновение принудительно и проверяет, что стенд перезапускает бота на другом порту.
test("стенд: если порт, выданный боту, уже занят, бот запускается заново на другом", async () => {
  const blocker = net.createServer();

  await new Promise((resolve) => blocker.listen(0, "0.0.0.0", resolve));

  const takenPort = blocker.address().port;
  const realCreateServer = net.createServer;
  let reservations = 0;

  // первое резервирование порта "выдаёт" заведомо занятый порт, дальше - настоящее поведение
  net.createServer = (...args) => {
    reservations += 1;

    if (reservations > 1) {
      return realCreateServer(...args);
    }

    return { listen: (port, host, callback) => callback(), address: () => ({ port: takenPort }), close: (callback) => callback() };
  };

  try {
    await withApp({}, async ({ tg, or, app }) => {
      or.chat = () => reply("работаю после повторного запуска");
      tg.message({ chatId: 777, text: "привет" });
      await tg.waitFor(() => tg.texts().length >= 1, 8000, "ответ");

      assert.equal(tg.texts()[0], "работаю после повторного запуска");
      assert.notEqual(app.port, takenPort, "бот должен был переехать на другой порт");
      assert.equal(reservations, 2, "одна неудачная попытка и одна успешная");
    });
  } finally {
    net.createServer = realCreateServer;
    blocker.close();
  }
});
