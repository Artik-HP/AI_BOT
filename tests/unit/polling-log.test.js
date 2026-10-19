const test = require("node:test");
const assert = require("node:assert/strict");
const logger = require("../../src/utils/logger");
const { createPollingErrorLogger } = require("../../src/bot");

function captureErrors(fn) {
  const lines = [];

  logger.setOutput({ error: (line) => lines.push(line) });

  try {
    fn();
  } finally {
    logger.setOutput({ error: (line) => console.error(line) });
  }

  return lines;
}

const networkError = () => Object.assign(new Error("EFATAL: connect ECONNREFUSED 127.0.0.1:1"), { code: "EFATAL" });

test("ошибки опроса: серия одинаковых сбоев пишется в лог один раз за интервал, с счётчиком пропущенных", () => {
  let time = 1_000_000;
  const logPollingError = createPollingErrorLogger(() => time);

  const lines = captureErrors(() => {
    for (let i = 0; i < 50; i += 1) {
      time += 1000;
      logPollingError(networkError());
    }
  });

  // 50 секунд сбоев: окно ещё не закрылось - только первая запись
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Telegram polling error/);
  assert.doesNotMatch(lines[0], /и ещё/);

  const later = captureErrors(() => {
    time += 20_000;
    logPollingError(networkError());
  });

  assert.equal(later.length, 1);
  assert.match(later[0], /и ещё 49 таких же/, "после паузы сообщается, сколько записей было пропущено");
});

test("ошибки опроса: 409 и 401 получают понятную подсказку", () => {
  let time = 1_000_000;
  const logPollingError = createPollingErrorLogger(() => time);

  const conflict = captureErrors(() => logPollingError(new Error("ETELEGRAM: 409 Conflict: terminated by other getUpdates request")));
  time += 120_000;
  const unauthorized = captureErrors(() => logPollingError(new Error("ETELEGRAM: 401 Unauthorized")));

  assert.match(conflict[0], /другой экземпляр бота/);
  assert.match(unauthorized[0], /отклонил BOT_TOKEN/);
});

test("ошибки опроса: другая ошибка внутри окна подавления пишется сразу, со счётчиком пропущенных предыдущей (ревью Codex, P2)", () => {
  let time = 1_000_000;
  const logPollingError = createPollingErrorLogger(() => time);

  const lines = captureErrors(() => {
    for (let i = 0; i < 5; i += 1) {
      time += 1000;
      logPollingError(networkError());
    }

    time += 1000;
    logPollingError(new Error("ETELEGRAM: 409 Conflict: terminated by other getUpdates request"));
    time += 1000;
    logPollingError(new Error("ETELEGRAM: 409 Conflict: terminated by other getUpdates request"));
    time += 1000;
    logPollingError(networkError());
  });

  assert.equal(lines.length, 3, "сеть (1-я), 409 (смена вида), сеть снова (смена вида); повтор 409 подавлен");
  assert.match(lines[1], /до этого пропущено 4 повторов предыдущей ошибки/);
  assert.match(lines[1], /другой экземпляр бота/, "подсказка про 409 не потеряна");
  assert.match(lines[2], /до этого пропущено 1 повторов/);
});
