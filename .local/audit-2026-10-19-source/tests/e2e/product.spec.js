const { test, expect } = require("@playwright/test");
test("interface language switches to English/Ukrainian and keeps command handlers and user data", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "⚙ Настройки", exact: true }).click();
  await page.locator("#setting-language").selectOption("en");
  await page
    .getByRole("button", { name: "Сохранить настройки", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("#settings-view h1")).toContainText("Personal");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.locator('[data-view="tools"]').click();
  await page.getByRole("searchbox").fill("calculator");
  await expect(page.locator(".card h3")).toHaveText("Calculator");
  await page.locator('[data-view="settings"]').click();
  await page.locator("#setting-language").selectOption("uk");
  await page.locator('#preferences-form button[type="submit"]').click();
  await expect(page.locator("html")).toHaveAttribute("lang", "uk");
  await expect(page.locator("#settings-view h1")).toContainText("Особист");
});
test("dashboard, diagnostics and preferences use real API, save and survive reload", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator(".card").first()).toBeVisible();
  await page.getByRole("button", { name: "◈ Панель", exact: true }).click();
  await expect(page.locator("#metrics .metric")).toHaveCount(4);
  await expect(page.locator("#metrics")).toContainText("Требуется ключ");
  await page.getByRole("button", { name: "⚙ Настройки", exact: true }).click();
  await page.locator("#setting-mode").selectOption("teacher");
  await page.locator("#setting-style").selectOption("concise");
  await page.locator("#setting-instructions").fill("Ответы с примерами");
  await page
    .getByRole("button", { name: "Сохранить настройки", exact: true })
    .click();
  await expect(page.locator("#settings-status")).toHaveText(
    "Настройки сохранены.",
  );
  await page.reload();
  await page.getByRole("button", { name: "⚙ Настройки", exact: true }).click();
  await expect(page.locator("#setting-mode")).toHaveValue("teacher");
  await expect(page.locator("#setting-instructions")).toHaveValue(
    "Ответы с примерами",
  );
  await page
    .getByRole("button", { name: "🩺 Диагностика", exact: true })
    .click();
  await expect(page.locator("#diagnostic-status")).toContainText("SQLite");
  await page.getByRole("button", { name: "Проверить AI", exact: true }).click();
  await expect(page.locator("#diagnostic-status")).toContainText(
    "Подключение недоступно",
  );
  expect(errors).toEqual([]);
});
test("chat creates/resumes conversations, reports missing key, accepts bounded text file and exports data", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "💬 AI-чат", exact: true }).click();
  await expect(page.locator("#conversations")).toContainText("Основной диалог");
  await page
    .getByRole("button", { name: "＋ Новый диалог", exact: true })
    .click();
  await page.locator("#new-thread-name").fill("Моя тема");
  await page.getByRole("button", { name: "Создать", exact: true }).click();
  await expect(page.locator("#conversations")).toContainText("Моя тема");
  await page.locator("#chat-input").fill("Hello");
  await page.getByRole("button", { name: "Отправить ↗", exact: true }).click();
  await expect(page.locator("#chat-error")).toContainText("OPENROUTER_API_KEY");
  await page.locator("#chat-document").setInputFiles({
    name: "sample.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Текст документа"),
  });
  await expect(page.locator("#chat-file-name")).toHaveText("sample.txt");
  await page.getByRole("button", { name: "⚙ Настройки", exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Скачать мои данные в JSON" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("orbit-personal-data.json");
});
test("chat Markdown, copy controls and hostile HTML are sanitized (protocol fixture)", async ({
  page,
}) => {
  let answered = false;
  await page.route("**/api/commands/chat", (route) => {
    answered = true;
    return route.fulfill({
      json: { text: "Done", profile: { favorites: [], recent: [] } },
    });
  });
  await page.route("**/api/history?*", (route) =>
    route.fulfill({
      json: {
        active: "main",
        conversations: [
          {
            id: "main",
            title: "Основной диалог",
            messages: answered
              ? [
                  { role: "user", content: "Question" },
                  {
                    role: "assistant",
                    content:
                      '## Ответ\n```js\nconst a = 1;\n```\n<script>window.pwned=true</script><img src=x onerror="window.pwned=true">',
                  },
                ]
              : [],
          },
        ],
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "💬 AI-чат", exact: true }).click();
  await page.locator("#chat-input").fill("Question");
  await page.getByRole("button", { name: "Отправить ↗", exact: true }).click();
  await expect(page.locator("#messages h2")).toHaveText("Ответ");
  await expect(page.locator("#messages code")).toContainText("const a = 1;");
  await expect(
    page.getByRole("button", { name: "Скопировать код" }),
  ).toBeVisible();
  expect(await page.locator("#messages script,#messages img").count()).toBe(0);
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
});
for (const width of [320, 768, 1440])
  test(`new product views fit ${width}px without overflow`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    for (const title of [
      "◈ Панель",
      "💬 AI-чат",
      "⚙ Настройки",
      "🩺 Диагностика",
    ]) {
      await page.getByRole("button", { name: title, exact: true }).click();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
  });
