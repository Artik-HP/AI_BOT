const test = require("node:test");
const assert = require("node:assert/strict");
const { buildConfig, isPlaceholder, parseBoolean, validateConfig } = require("../../src/config");

const VALID_TOKEN = "123456789:AAFakeTokenForTests_ABCDEFGHIJKLMNOPQ";
const VALID_KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";

function build(env = {}) {
  const warnings = [];
  const config = buildConfig(env, (message) => warnings.push(message));
  return { config, warnings };
}

test("buildConfig: значения по умолчанию без предупреждений", () => {
  const { config, warnings } = build();

  assert.deepEqual(warnings, []);
  assert.equal(config.MODEL, "openai/gpt-4o-mini");
  assert.equal(config.PORT, 12722);
  assert.equal(config.MAX_AUDIO_BYTES, 25 * 1024 * 1024);
  assert.equal(config.OPENROUTER_BASE_URL, "https://openrouter.ai/api/v1");
  assert.equal(config.TELEGRAM_API_BASE_URL, "https://api.telegram.org");
  assert.equal(config.ACCOUNT_ASSISTANT_MODE, "approval");
  assert.equal(config.ACCOUNT_ASSISTANT_PRIVATE_ONLY, true);
  assert.deepEqual(config.BOT_ALLOWED_USER_IDS, []);
});

test("буквально '25MB' больше не превращается в NaN и не отключает лимит (F022)", () => {
  const { config, warnings } = build({ MAX_AUDIO_BYTES: "25MB", MAX_IMAGE_BYTES: "512 KB" });

  assert.equal(config.MAX_AUDIO_BYTES, 25 * 1024 * 1024);
  assert.equal(config.MAX_IMAGE_BYTES, 512 * 1024);
  assert.deepEqual(warnings, []);
});

test("мусор в числовых переменных: предупреждение и значение по умолчанию (F022)", () => {
  const { config, warnings } = build({
    MAX_AUDIO_BYTES: "много",
    MAX_IMAGE_BYTES: "-5",
    PORT: "http",
    TELEGRAM_API_ID: "my_id",
    MAX_HISTORY_MESSAGES: "-5",
    RATE_LIMIT_MESSAGES: "1.5"
  });

  assert.equal(config.MAX_AUDIO_BYTES, 25 * 1024 * 1024);
  assert.equal(config.MAX_IMAGE_BYTES, 10 * 1024 * 1024);
  assert.equal(config.PORT, 12722);
  assert.equal(config.TELEGRAM_API_ID, 0);
  assert.equal(config.MAX_HISTORY_MESSAGES, 60);
  assert.equal(config.RATE_LIMIT_MESSAGES, 20);
  assert.equal(warnings.length, 6);
  assert.ok(Number.isFinite(config.MAX_AUDIO_BYTES));
});

test("PORT=0 допустим (случайный порт), 70000 - нет", () => {
  assert.equal(build({ PORT: "0" }).config.PORT, 0);
  assert.equal(build({ PORT: "70000" }).config.PORT, 12722);
});

test("булевы значения: опечатка не превращается в false (F016)", () => {
  assert.equal(build({ ACCOUNT_ASSISTANT_PRIVATE_ONLY: "off" }).config.ACCOUNT_ASSISTANT_PRIVATE_ONLY, false);
  assert.equal(build({ ACCOUNT_ASSISTANT_PRIVATE_ONLY: "yes" }).config.ACCOUNT_ASSISTANT_PRIVATE_ONLY, true);

  const typo = build({ ACCOUNT_ASSISTANT_PRIVATE_ONLY: "ture" });
  assert.equal(typo.config.ACCOUNT_ASSISTANT_PRIVATE_ONLY, true);
  assert.equal(typo.warnings.length, 1);

  assert.equal(parseBoolean("TRUE"), true);
  assert.equal(parseBoolean("нет"), null);
  assert.equal(parseBoolean(undefined), null);
});

test("режим ассистента проверяется по списку", () => {
  assert.equal(build({ ACCOUNT_ASSISTANT_MODE: "AUTO" }).config.ACCOUNT_ASSISTANT_MODE, "auto");
  const bad = build({ ACCOUNT_ASSISTANT_MODE: "yolo" });
  assert.equal(bad.config.ACCOUNT_ASSISTANT_MODE, "approval");
  assert.equal(bad.warnings.length, 1);
});

test("заглушки: распознаются и не принимаются как значения (F008)", () => {
  for (const value of ["process.env.BOT_TOKEN", "your_telegram_bot_token", "ваш_chat_id", "ваша_сессия", "<token>", "${BOT_TOKEN}", "changeme", "token_here"]) {
    assert.equal(isPlaceholder(value), true, value);
  }

  for (const value of [VALID_TOKEN, VALID_KEY, "openai/gpt-4o-mini", "-1001234567890", "http://localhost"]) {
    assert.equal(isPlaceholder(value), false, value);
  }

  const { config, warnings } = build({ OPENROUTER_MODEL: "process.env.OPENROUTER_MODEL" });
  assert.equal(config.MODEL, "openai/gpt-4o-mini");
  assert.equal(warnings.length, 1);
});

test("идентификаторы чатов: числа принимаются, заглушки игнорируются", () => {
  const { config, warnings } = build({
    ACCOUNT_ASSISTANT_OWNER_CHAT_ID: "ваш_chat_id",
    BOT_TO_BOT_OWNER_CHAT_ID: "4001",
    BOT_TO_BOT_CHAT_ID: "-1001234567890",
    BOT_ALLOWED_USER_IDS: "10, 20, abc, 30"
  });

  assert.equal(config.ACCOUNT_ASSISTANT_OWNER_CHAT_ID, undefined);
  assert.equal(config.BOT_TO_BOT_OWNER_CHAT_ID, "4001");
  assert.equal(config.BOT_TO_BOT_CHAT_ID, "-1001234567890");
  assert.deepEqual(config.BOT_ALLOWED_USER_IDS, ["10", "20", "30"]);
  assert.deepEqual(config.OWNER_CHAT_IDS, ["4001"]);
  assert.equal(warnings.length, 2);
});

test("цепочки резервных переменных владельца сохранены", () => {
  const { config } = build({ OWNER_CHAT_ID: "77" });

  assert.equal(config.BOT_TO_BOT_OWNER_CHAT_ID, "77");
  assert.equal(config.ACCOUNT_ASSISTANT_OWNER_CHAT_ID, "77");

  const both = build({ ACCOUNT_ASSISTANT_OWNER_CHAT_ID: "5", BOT_TO_BOT_OWNER_CHAT_ID: "6" }).config;
  assert.equal(both.BOT_TO_BOT_OWNER_CHAT_ID, "6");
  assert.equal(both.ACCOUNT_ASSISTANT_OWNER_CHAT_ID, "5");
  assert.deepEqual(both.OWNER_CHAT_IDS.sort(), ["5", "6"]);
});

test("URL-переменные: слэш в конце убирается, не-URL отвергается", () => {
  assert.equal(build({ OPENROUTER_BASE_URL: "http://127.0.0.1:9999/api/v1/" }).config.OPENROUTER_BASE_URL, "http://127.0.0.1:9999/api/v1");
  const bad = build({ TELEGRAM_API_BASE_URL: "ftp://x" });
  assert.equal(bad.config.TELEGRAM_API_BASE_URL, "https://api.telegram.org");
  assert.equal(bad.warnings.length, 1);
});

test("validateConfig: принимает корректные значения", () => {
  assert.doesNotThrow(() => validateConfig({ BOT_TOKEN: VALID_TOKEN, OPENROUTER_API_KEY: VALID_KEY }));
});

test("validateConfig: путь из README (cp .env.example .env) больше не проходит молча (F008)", () => {
  assert.throws(
    () => validateConfig({ BOT_TOKEN: "process.env.BOT_TOKEN", OPENROUTER_API_KEY: "process.env.OPENROUTER_API_KEY" }),
    (error) => /заглушк/.test(error.message) && /BOT_TOKEN/.test(error.message) && /OPENROUTER_API_KEY/.test(error.message)
  );
});

test("validateConfig: собирает все проблемы сразу", () => {
  assert.throws(
    () => validateConfig({ BOT_TOKEN: "", OPENROUTER_API_KEY: "" }),
    (error) => error.message.split("\n").length === 3
  );
  assert.throws(() => validateConfig({ BOT_TOKEN: "не-токен", OPENROUTER_API_KEY: VALID_KEY }), /неверный формат/);
  assert.throws(() => validateConfig({ BOT_TOKEN: VALID_TOKEN, OPENROUTER_API_KEY: "sk or key" }), /пробел/);
});
