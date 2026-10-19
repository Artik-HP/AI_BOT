// Capture the actual local UI. No command is run and no external messages are sent.
const { chromium } = require("@playwright/test");
const fs = require("node:fs"),
  path = require("node:path");
async function main() {
  const output = path.join(__dirname, "../docs/screenshots");
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: "msedge" }),
    page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(process.env.PREVIEW_URL || "http://127.0.0.1:12723/");
  await page.locator(".card").first().waitFor();
  await page.screenshot({ path: path.join(output, "commands-desktop.png") });
  await page.locator("#theme").click();
  await page.screenshot({ path: path.join(output, "commands-light.png") });
  await page.locator("#theme").click();
  await page.setViewportSize({ width: 390, height: 950 });
  await page.screenshot({ path: path.join(output, "commands-mobile.png") });
  if (errors.length) throw new Error(errors.join("\n"));
  await browser.close();
  console.log(
    "Desktop, light theme and mobile captures saved; no browser errors.",
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
