// Developer authoring tool: sends only public UI strings, never histories or configuration secrets.
const fs = require("node:fs"),
  path = require("node:path"),
  axios = require("axios");
require("dotenv").config({ quiet: true });
async function main() {
  const html = fs.readFileSync(
    path.join(__dirname, "../public/index.html"),
    "utf8",
  );
  const text = [...html.matchAll(/>([^<>]+)</g)].map((m) =>
    m[1].trim().replace(/\s+/g, " "),
  );
  const attributes = [
    ...html.matchAll(/(?:placeholder|aria-label)="([^"]+)"/g),
  ].map((m) => m[1]);
  const { registry, CATEGORIES } = require("../src/commandSystem/registry");
  const strings = [
    ...new Set(
      [
        ...text,
        ...attributes,
        ...[...registry.values()].flatMap((c) => [c.title, c.description]),
        ...Object.values(CATEGORIES),
        ...Object.values(require("../src/services/preferences").MODES),
        ...Object.values(require("../src/services/preferences").STYLES),
        "Все команды",
        "Избранное",
        "Недавние",
        "ТВОЯ КОМАНДА",
        "Результат",
        "Не удалось выполнить",
        "Запустить ↗",
        "Скопировано",
        "Код скопирован",
        "Ты",
        "Обычный чат",
        "Учитель",
        "Программист",
        "Креатив",
        "Настройки сохранены.",
        "Приложение работает",
        "Требуется ключ",
        "Настроен · ещё не проверен",
        "Подключение подтверждено",
        "Подключение недоступно",
        "Твои запросы",
        "Последние действия",
        "Название диалога",
        "Что нужно сделать?",
        "Выполняю…",
        "Открыть ↗",
        "Создать",
        "Диагностика",
        "Самопроверка кода",
        "Проверить AI",
        "Обновить",
        "✦ Здесь начинается новая идея. Задай вопрос или прикрепи текстовый документ.",
      ].filter((s) => s && /[А-Яа-яЁё]/.test(s)),
    ),
  ];
  if (!process.env.OPENROUTER_API_KEY)
    throw new Error("OpenRouter key required for authoring locales");
  const seen = new Set(),
    locales = { en: {}, uk: {} };
  for (let offset = 0; offset < strings.length; offset += 60) {
    const batch = strings
      .slice(offset, offset + 60)
      .map((source, i) => ({ id: offset + i, source }));
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        translations: {
          type: "array",
          minItems: batch.length,
          maxItems: batch.length,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "integer", enum: batch.map((x) => x.id) },
              en: { type: "string" },
              uk: { type: "string" },
            },
            required: ["id", "en", "uk"],
          },
        },
      },
      required: ["translations"],
    };
    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "openai/gpt-4o-mini",
        temperature: 0.1,
        max_tokens: 10000,
        response_format: {
          type: "json_schema",
          json_schema: { name: "ui_translations", strict: true, schema },
        },
        messages: [
          {
            role: "system",
            content:
              "Translate Russian UI strings to natural English and Ukrainian. Preserve emojis, URLs, commands and brands. Return exactly one translation per supplied id, all ids once, concise labels.",
          },
          { role: "user", content: JSON.stringify(batch) },
        ],
      },
      {
        headers: { Authorization: "Bearer " + process.env.OPENROUTER_API_KEY },
        timeout: 60000,
        maxContentLength: 2 * 1024 * 1024,
      },
    );
    const result = JSON.parse(response.data.choices[0].message.content);
    if (
      !Array.isArray(result.translations) ||
      result.translations.length !== batch.length
    )
      throw new Error("Translation batch count mismatch");
    for (const item of result.translations) {
      if (
        Object.keys(item).sort().join(",") !== "en,id,uk" ||
        !Number.isInteger(item.id) ||
        !batch.some((x) => x.id === item.id) ||
        seen.has(item.id) ||
        ["en", "uk"].some(
          (lang) =>
            typeof item[lang] !== "string" ||
            !item[lang].trim() ||
            item[lang].length > 1000,
        )
      )
        throw new Error("Invalid translation structure");
      seen.add(item.id);
      for (const lang of ["en", "uk"])
        locales[lang][strings[item.id]] = item[lang];
    }
    console.log(
      "Validated translation entries: " + seen.size + "/" + strings.length,
    );
  }
  fs.writeFileSync(
    path.join(__dirname, "../public/locales.json"),
    JSON.stringify(locales, null, 2),
  );
  console.log(
    "Validated interface translations saved: " +
      strings.length +
      " strings per language.",
  );
}
main().catch((error) => {
  console.error(
    "Locale authoring failed:",
    error.response?.status || error.code || error.message,
  );
  process.exitCode = 1;
});
