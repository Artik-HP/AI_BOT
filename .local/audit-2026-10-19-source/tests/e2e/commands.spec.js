const { test, expect } = require("@playwright/test");
test("dynamic multiple-choice UI submits hidden select actions (protocol fixture)", async ({
  page,
}) => {
  const profile = { favorites: [], recent: [] };
  await page.route("**/api/commands/brainstorm", (route) =>
    route.fulfill({
      json: {
        text: "Выбери несколько занятий",
        buttons: [
          { label: "▫ Книга", command: "select", args: "fixture 0" },
          {
            label: "Подтвердить (0)",
            command: "select",
            args: "fixture confirm",
          },
        ],
        profile,
      },
    }),
  );
  let selections = 0;
  await page.route("**/api/commands/select", (route) => {
    selections++;
    return route.fulfill({
      json:
        selections === 1
          ? {
              text: "Выбери несколько занятий",
              buttons: [
                { label: "✅ Книга", command: "select", args: "fixture 0" },
                {
                  label: "Подтвердить (1)",
                  command: "select",
                  args: "fixture confirm",
                },
              ],
              profile,
            }
          : { text: "Книга выбрана. Продолжаем.", profile },
    });
  });
  await page.goto("/");
  await page.getByRole("searchbox").fill("brainstorm");
  await page.getByRole("button", { name: "Открыть Мозговой штурм" }).click();
  await page.locator("#arguments").fill("Выходные");
  await page.getByRole("button", { name: "Запустить ↗", exact: true }).click();
  await page
    .locator("#result-buttons")
    .getByRole("button", { name: "▫ Книга" })
    .click();
  await page
    .locator("#result-buttons")
    .getByRole("button", { name: "Подтвердить (1)" })
    .click();
  await expect(page.locator("#result-text")).toHaveText(
    "Книга выбрана. Продолжаем.",
  );
  expect(selections).toBe(2);
});
test("calculator, schema errors, favorites, search, themes and reload persist through the real web API", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator(".card")).not.toHaveCount(0);
  await page.getByRole("searchbox").fill("calculator");
  await expect(page.locator(".card")).toHaveCount(1);
  await page.getByRole("button", { name: "Избранное: Калькулятор" }).click();
  await page
    .getByRole("button", { name: "Открыть Калькулятор", exact: true })
    .click();
  await page.locator("#arguments").fill("(12+8)*3");
  await page.getByRole("button", { name: "Запустить ↗", exact: true }).click();
  await expect(page.locator("#result-text")).toHaveText("60");
  await page.locator("#arguments").fill("process.exit()");
  await page.getByRole("button", { name: "Запустить ↗", exact: true }).click();
  await expect(page.locator("#result-status")).toHaveText(
    "Не удалось выполнить",
  );
  await page.getByRole("button", { name: "Закрыть команду" }).click();
  await page.getByRole("button", { name: "Избранное", exact: true }).click();
  await expect(page.locator(".card")).toHaveCount(1);
  await page.getByRole("button", { name: "Переключить тему" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Избранное", exact: true }).click();
  await expect(page.locator(".card")).toHaveCount(1);
  expect(errors).toEqual([]);
});
test("quiz topic → difficulty → answers → actual score, then learning and guessing", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Попробовать викторину ↗" }).click();
  await page
    .locator("#result-buttons")
    .getByRole("button", { name: "🔬 Наука", exact: true })
    .click();
  await page
    .locator("#result-buttons")
    .getByRole("button", { name: "🟢 Легко", exact: true })
    .click();
  for (let i = 0; i < 3; i++) {
    await expect(page.locator("#result-text")).toContainText(
      "Вопрос " + (i + 1) + "/3",
    );
    await page.locator("#result-buttons button").first().click();
  }
  await expect(page.locator("#result-text")).toContainText(
    "Викторина завершена",
  );
  await page
    .getByRole("button", { name: "Главное меню", exact: false })
    .last()
    .click();
  await page.getByRole("searchbox").fill("guess");
  await page.getByRole("button", { name: "Открыть Угадай число" }).click();
  await page.getByRole("button", { name: "Запустить ↗", exact: true }).click();
  await expect(page.locator("#result-text")).toContainText("Я загадал число");
  await page.locator("#arguments").fill("50");
  await page.getByRole("button", { name: "Запустить ↗", exact: true }).click();
  await expect(page.locator("#result-text")).toContainText(/Попыток|Угадал/);
});
test("notes, tasks, actual QR image, reminder scheduler and safe HTML rendering", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("searchbox").fill("notes");
  await page.getByRole("button", { name: "Открыть Заметки" }).click();
  await page.locator("#arguments").fill("add <img src=x onerror=alert(1)>");
  await page.getByRole("button", { name: "Запустить ↗", exact: true }).click();
  await expect(page.locator("#result-text")).toContainText("<img");
  expect(await page.locator("#result-text img").count()).toBe(0);
  await page
    .locator("#result-buttons")
    .getByRole("button", { name: "Показать список" })
    .click();
  await expect(page.locator("#result-text")).toContainText("onerror");
  await page.getByRole("button", { name: "Закрыть команду" }).click();
  await page.reload();
  await page.getByRole("searchbox").fill("qr");
  await page.getByRole("button", { name: "Открыть QR-код" }).click();
  await page.locator("#arguments").fill("https://example.com");
  await page.getByRole("button", { name: "Запустить ↗", exact: true }).click();
  await expect(page.locator("#result-image")).toBeVisible();
  await expect(page.locator("#result-image")).toHaveJSProperty(
    "naturalWidth",
    512,
  );
  await page.getByRole("button", { name: "Закрыть команду" }).click();
  await page.getByRole("searchbox").fill("timer");
  await page.getByRole("button", { name: "Открыть Таймер" }).click();
  await page.locator("#arguments").fill("1s Browser timer fired");
  await page.getByRole("button", { name: "Запустить ↗", exact: true }).click();
  await expect(page.locator("#result-text")).toContainText("Установлено");
  await page.getByRole("button", { name: "Закрыть команду" }).click();
  await expect(page.locator("#notifications")).toContainText(
    "Browser timer fired",
    { timeout: 20000 },
  );
});
for (const width of [320, 390, 768, 1024, 1440])
  test(`responsive ${width}px, keyboard focus, no horizontal overflow`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.locator(".card")).not.toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.keyboard.press("/");
    await expect(page.getByRole("searchbox")).toBeFocused();
    await page.getByRole("searchbox").fill("json");
    await page.getByRole("button", { name: "Открыть Формат JSON" }).click();
    await page
      .locator("#arguments")
      .fill('{"long":"' + "word ".repeat(50) + '"}');
    await page
      .getByRole("button", { name: "Запустить ↗", exact: true })
      .click();
    await expect(page.locator("#result-status")).toHaveText("Результат");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if (width === 1440)
      await page.screenshot({
        path: "test-results/orbit-desktop.png",
        fullPage: true,
      });
    if (width === 390)
      await page.screenshot({
        path: "test-results/orbit-mobile.png",
        fullPage: true,
      });
  });
