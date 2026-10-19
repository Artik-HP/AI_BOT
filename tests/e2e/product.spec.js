const { test, expect } = require("@playwright/test");
test("chat retry after a completed failure uses a fresh key; uncertain transport retry keeps the key", async ({ page }) => {
  const keys = [];
  let outcome = "completed-error";
  await page.route("**/api/commands/chat", async (route) => {
    keys.push(route.request().headers()["idempotency-key"]);
    if (outcome === "network-error") return route.abort("failed");
    return route.fulfill({ json: { text: "Temporary AI failure", error: true, profile: { favorites: [], recent: [] } } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "💬 AI-чат", exact: true }).click();
  await page.locator("#chat-input").fill("Retry the same message");
  const send = page.getByRole("button", { name: "Отправить ↗", exact: true });
  await send.click();
  await expect(page.locator("#chat-error")).toHaveText("Temporary AI failure");
  await expect(send).toBeEnabled();
  await send.click();
  await expect.poll(() => keys.length).toBe(2);
  await expect(send).toBeEnabled();
  expect(keys[1]).not.toBe(keys[0]);
  outcome = "network-error";
  await send.click();
  await expect.poll(() => keys.length).toBe(3);
  await expect(send).toBeEnabled();
  await send.click();
  await expect.poll(() => keys.length).toBe(4);
  await expect(send).toBeEnabled();
  expect(keys[3]).toBe(keys[2]);
});

test("multiple-choice confirmation remains usable after a completed AI failure", async ({ page }) => {
  let attempts = 0;
  const keys = [];
  await page.route("**/api/commands/chat", (route) => route.fulfill({
    json: { text: "Choose options", buttons: [{ label: "Подтвердить (2)", command: "select", args: "question-nonce confirm" }], profile: { favorites: [], recent: [] } },
  }));
  await page.route("**/api/commands/select", (route) => {
    keys.push(route.request().headers()["idempotency-key"]);
    return route.fulfill({ json: ++attempts === 1
      ? { text: "Temporary choice failure", error: true, profile: { favorites: [], recent: [] } }
      : { text: "Selection received", buttons: [{ label: "Continue after retry", command: "chat", args: "Continue" }], profile: { favorites: [], recent: [] } },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "💬 AI-чат", exact: true }).click();
  await page.locator("#chat-input").fill("Give me choices");
  await page.getByRole("button", { name: "Отправить ↗", exact: true }).click();
  const confirm = page.locator("#chat-choices").getByRole("button", { name: "Подтвердить (2)", exact: true });
  await confirm.click();
  await expect(page.locator("#chat-error")).toHaveText("Temporary choice failure");
  await expect(confirm).toBeVisible();
  await confirm.click();
  await expect(page.locator("#chat-choices")).toContainText("Continue after retry");
  expect(attempts).toBe(2);
  expect(keys[1]).not.toBe(keys[0]);
});

for (const invalid of ["extension", "size", "removed"])
  test(`replacing an attachment with ${invalid} clears the previous document before sending`, async ({ page }) => {
    const submitted = [];
    await page.route("**/api/commands/chat", (route) => {
      submitted.push(route.request().postDataJSON().args);
      return route.fulfill({ json: { text: "Submitted", profile: { favorites: [], recent: [] } } });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "💬 AI-чат", exact: true }).click();
    const input = page.locator("#chat-document");
    await input.setInputFiles({ name: "old.txt", mimeType: "text/plain", buffer: Buffer.from("OLD_DOCUMENT_MARKER") });
    await expect(page.locator("#chat-file-name")).toHaveText("old.txt");
    await input.setInputFiles(invalid === "removed" ? [] : {
      name: invalid === "extension" ? "invalid.exe" : "oversized.txt",
      mimeType: "application/octet-stream",
      buffer: invalid === "size" ? Buffer.alloc(256 * 1024 + 1, 65) : Buffer.from("unsupported"),
    });
    await page.locator("#chat-input").fill("Only my new message");
    await page.getByRole("button", { name: "Отправить ↗", exact: true }).click();
    await expect.poll(() => submitted.length).toBe(1);
    expect(submitted[0]).toBe("Only my new message");
    await expect(page.locator("#chat-file-name")).toBeEmpty();
  });
test("late document read cannot restore an attachment after the user removed it", async ({ page }) => {
  const submitted = [];
  await page.route("**/api/commands/chat", (route) => {
    submitted.push(route.request().postDataJSON().args);
    return route.fulfill({ json: { text: "Submitted", profile: { favorites: [], recent: [] } } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "💬 AI-чат", exact: true }).click();
  await page.evaluate(() => {
    const original = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      return new Promise((resolve) => {
        window.finishDelayedAttachment = () => original.call(this).then(resolve);
      });
    };
  });
  const input = page.locator("#chat-document");
  await input.setInputFiles({ name: "slow.txt", mimeType: "text/plain", buffer: Buffer.from("DELAYED_DOCUMENT_MARKER") });
  await page.waitForFunction(() => typeof window.finishDelayedAttachment === "function");
  await input.setInputFiles([]);
  await page.evaluate(() => window.finishDelayedAttachment());
  await page.locator("#chat-input").fill("Send without attachment");
  await page.getByRole("button", { name: "Отправить ↗", exact: true }).click();
  await expect.poll(() => submitted.length).toBe(1);
  expect(submitted[0]).toBe("Send without attachment");
});

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
