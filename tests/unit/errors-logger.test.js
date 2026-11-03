const test = require("node:test");
const assert = require("node:assert/strict");
const { ApiError, describeError, isTransientError, toSafeError } = require("../../src/utils/errors");
const { redact } = require("../../src/utils/redact");
const logger = require("../../src/utils/logger");

const TELEGRAM_TOKEN = "123456789:AAFakeTokenForTests_ABCDEFGHIJKLMNOPQ";
const OPENROUTER_KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";

// Shape of a real AxiosError: the secrets live in config.headers and config.data.
function makeAxiosError() {
  const error = new Error("Request failed with status code 401");
  error.name = "AxiosError";
  error.code = "ERR_BAD_REQUEST";
  error.config = {
    method: "post",
    url: "https://openrouter.ai/api/v1/chat/completions",
    headers: { Authorization: `Bearer ${OPENROUTER_KEY}` },
    data: JSON.stringify({ messages: [{ role: "user", content: "МОЁ-ЛИЧНОЕ-СООБЩЕНИЕ" }] })
  };
  error.response = { status: 401, data: { error: { message: "invalid key" } } };
  return error;
}

function withEnv(values, fn) {
  const saved = {};

  for (const [name, value] of Object.entries(values)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }

  try {
    return fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

test("redact: токен бота в URL, ключ OpenRouter, Bearer, длинная сессия", () => {
  const session = `1${"A".repeat(250)}`;
  const text = `GET https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage key=${OPENROUTER_KEY} Authorization: Bearer abcdef1234567890 s=${session}`;
  const result = redact(text);

  assert.ok(!result.includes(TELEGRAM_TOKEN.split(":")[1]));
  assert.ok(!result.includes(OPENROUTER_KEY));
  assert.ok(!result.includes("abcdef1234567890"));
  assert.ok(!result.includes("A".repeat(50)));
  assert.match(result, /bot\*\*\*\/sendMessage/);
});

test("redact: значения секретных переменных окружения маскируются где угодно", () => {
  withEnv({ OPENROUTER_API_KEY: "custom-secret-value-777", HEALTH_TOKEN: "health-secret-xyz" }, () => {
    const result = redact("ключ custom-secret-value-777 и health-secret-xyz в тексте");

    assert.equal(result, "ключ *** и *** в тексте");
  });
});

test("describeError: ошибка axios не раскрывает заголовки и тело запроса (регрессия F007)", () => {
  const description = describeError(makeAxiosError());

  assert.ok(!description.includes(OPENROUTER_KEY));
  assert.ok(!description.includes("Bearer"));
  assert.ok(!description.includes("МОЁ-ЛИЧНОЕ-СООБЩЕНИЕ"));
  assert.match(description, /status=401/);
  assert.match(description, /invalid key/);
  assert.match(description, /POST https:\/\/openrouter\.ai/);
});

test("describeError: ошибка Telegram с токеном в URL маскируется", () => {
  const error = new Error(`ETELEGRAM: 403 Forbidden: bot was blocked by the user`);
  error.name = "TelegramError";
  error.code = "ETELEGRAM";
  error.response = { request: { href: `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage` } };

  const description = describeError(error);

  assert.match(description, /bot was blocked by the user/);
  assert.ok(!description.includes("AAFakeTokenForTests"));
});

test("describeError: не падает на странных значениях и ограничивает длину", () => {
  assert.equal(describeError(null), "unknown error");
  assert.equal(describeError("просто строка"), "просто строка");
  assert.ok(describeError({ message: "x".repeat(5000) }).length <= 810);
  assert.equal(typeof describeError(Symbol.iterator.toString()), "string");
});

test("toSafeError: превращает AxiosError в ApiError без config/request/response", () => {
  const safe = toSafeError(makeAxiosError());

  assert.ok(safe instanceof ApiError);
  assert.equal(safe.status, 401);
  assert.equal(safe.code, "ERR_BAD_REQUEST");
  assert.equal(safe.config, undefined);
  assert.equal(safe.response, undefined);
  assert.equal(safe.cause, undefined);
  assert.ok(!JSON.stringify(Object.getOwnPropertyNames(safe)).includes("config"));
  assert.ok(!safe.message.includes(OPENROUTER_KEY));
});

test("isTransientError: сетевые и 5xx/429 ретраятся, 401/400 нет", () => {
  assert.equal(isTransientError({ response: { status: 503 } }), true);
  assert.equal(isTransientError({ status: 429 }), true);
  assert.equal(isTransientError({ code: "ECONNRESET" }), true);
  assert.equal(isTransientError({ response: { status: 401 } }), false);
  assert.equal(isTransientError({ response: { status: 400 } }), false);
  assert.equal(isTransientError(null), false);
});

test("logger: уровни, редактирование секретов и форматирование ошибок", () => {
  const lines = { info: [], warn: [], error: [] };
  logger.setOutput({
    info: (line) => lines.info.push(line),
    warn: (line) => lines.warn.push(line),
    error: (line) => lines.error.push(line)
  });

  try {
    withEnv({ LOG_LEVEL: "warn" }, () => {
      logger.info("не должно попасть");
      logger.debug("и это тоже");
      logger.warn("предупреждение", { a: 1 });
      logger.error("ошибка:", makeAxiosError());
    });

    assert.equal(lines.info.length, 0);
    assert.equal(lines.warn.length, 1);
    assert.match(lines.warn[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z WARN {2}предупреждение \{"a":1\}$/);
    assert.equal(lines.error.length, 1);
    assert.ok(!lines.error[0].includes(OPENROUTER_KEY));
    assert.ok(!lines.error[0].includes("МОЁ-ЛИЧНОЕ-СООБЩЕНИЕ"));

    withEnv({ LOG_LEVEL: "info", OPENROUTER_API_KEY: OPENROUTER_KEY }, () => {
      logger.info(`ключ ${OPENROUTER_KEY} в тексте`);
    });
    assert.ok(!lines.info[0].includes(OPENROUTER_KEY));
  } finally {
    logger.setOutput({
      info: (line) => console.log(line),
      warn: (line) => console.warn(line),
      error: (line) => console.error(line)
    });
  }
});

test("logger.message: тексты сообщений пишутся только при LOG_MESSAGES=true", () => {
  const lines = [];
  logger.setOutput({ info: (line) => lines.push(line) });

  try {
    withEnv({ LOG_MESSAGES: "" }, () => logger.message("in", { chat: 1 }, "секретный текст"));
    assert.equal(lines.length, 0);

    withEnv({ LOG_MESSAGES: "true" }, () => logger.message("in", { chat: 1 }, "секретный текст"));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /секретный текст/);
  } finally {
    logger.setOutput({ info: (line) => console.log(line) });
  }
});
