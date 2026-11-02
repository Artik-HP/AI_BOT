const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { buildConfig } = require("../../src/config");

function build(env = {}) {
  const warnings = [];
  const config = buildConfig(env, (message) => warnings.push(message));

  return { config, warnings };
}

test("настройки собеседника: значения по умолчанию без предупреждений", () => {
  const { config, warnings } = build({ MEMORY_FILE: path.join("data", "memory.json") });

  assert.deepEqual(warnings, []);
  assert.equal(config.COMPANION_DEFAULT_PERSONA, "ideas", "по умолчанию бот придумывает идеи");
  assert.equal(config.PRODUCT_NAME, "Генератор идей");
  assert.equal(config.PUBLIC_BOT_URL, "", "ссылка на бота для сайта по умолчанию не задана");
  assert.equal(config.COMPANION_TOOLS_ENABLED, true);
  assert.equal(config.COMPANION_MAX_TOOL_ROUNDS, 4);
  assert.equal(config.COMPANION_MAX_BYTES, 5 * 1024 * 1024);
  assert.equal(config.COMPANION_REMINDER_TICK_MS, 10000);
  assert.equal(config.COMPANION_NAME, config.PRODUCT_NAME, "имя бота по умолчанию — PRODUCT_NAME");
  assert.equal(config.COMPANION_FILE, `${path.resolve(path.join("data", "memory.json"))}.rpg.json`, "файл лежит рядом с памятью чата");
});

test("настройки собеседника: свои значения принимаются", () => {
  const { config, warnings } = build({
    COMPANION_DEFAULT_PERSONA: "Classic",
    COMPANION_NAME: "Бублик",
    COMPANION_TOOLS_ENABLED: "off",
    COMPANION_MAX_TOOL_ROUNDS: "2",
    COMPANION_FILE: path.join("custom", "rpg.json"),
    COMPANION_MAX_BYTES: "1MB",
    COMPANION_REMINDER_TICK_MS: "250"
  });

  assert.deepEqual(warnings, []);
  assert.equal(config.COMPANION_DEFAULT_PERSONA, "classic");
  assert.equal(config.COMPANION_NAME, "Бублик");
  assert.equal(config.COMPANION_TOOLS_ENABLED, false);
  assert.equal(config.COMPANION_MAX_TOOL_ROUNDS, 2);
  assert.equal(config.COMPANION_FILE, path.resolve(path.join("custom", "rpg.json")));
  assert.equal(config.COMPANION_MAX_BYTES, 1024 * 1024);
  assert.equal(config.COMPANION_REMINDER_TICK_MS, 250);
});

test("настройки собеседника: мусор даёт предупреждение и безопасное значение, а не молчаливую поломку", () => {
  const { config, warnings } = build({
    COMPANION_DEFAULT_PERSONA: "robot",
    COMPANION_TOOLS_ENABLED: "ture",
    COMPANION_MAX_TOOL_ROUNDS: "99",
    COMPANION_MAX_BYTES: "много",
    COMPANION_REMINDER_TICK_MS: "5",
    COMPANION_NAME: "your_name"
  });

  assert.equal(warnings.length, 6);
  assert.equal(config.COMPANION_DEFAULT_PERSONA, "ideas");
  assert.equal(config.COMPANION_TOOLS_ENABLED, true);
  assert.equal(config.COMPANION_MAX_TOOL_ROUNDS, 4);
  assert.equal(config.COMPANION_MAX_BYTES, 5 * 1024 * 1024);
  assert.equal(config.COMPANION_REMINDER_TICK_MS, 10000);
  assert.equal(config.COMPANION_NAME, config.PRODUCT_NAME);
});

test("характер по умолчанию: идеи, собеседник и классика принимаются; «собеседник» теперь нужно выбрать явно", () => {
  for (const persona of ["ideas", "companion", "classic"]) {
    const { config, warnings } = build({ COMPANION_DEFAULT_PERSONA: persona.toUpperCase() });

    assert.deepEqual(warnings, [], persona);
    assert.equal(config.COMPANION_DEFAULT_PERSONA, persona);
  }
});

test("PUBLIC_BOT_URL: ссылка на бота для сайта; только http(s), мусор даёт предупреждение и пустое значение", () => {
  const good = build({ PUBLIC_BOT_URL: "https://t.me/my_ideas_bot/" });
  const bad = build({ PUBLIC_BOT_URL: "javascript:alert(1)" });
  const notUrl = build({ PUBLIC_BOT_URL: "t.me/my_ideas_bot" });

  assert.equal(good.config.PUBLIC_BOT_URL, "https://t.me/my_ideas_bot", "хвостовой слэш убран");
  assert.deepEqual(good.warnings, []);

  for (const { config, warnings } of [bad, notUrl]) {
    assert.equal(config.PUBLIC_BOT_URL, "");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /PUBLIC_BOT_URL.*используется пусто/);
  }
});
