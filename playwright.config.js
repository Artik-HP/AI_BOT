const { defineConfig } = require("@playwright/test");
const os = require("node:os"),
  path = require("node:path"),
  fs = require("node:fs");
const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), "orbit-browser-tests-"),
);
module.exports = defineConfig({
  testDir: "./tests/e2e",
  timeout: 30000,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:12724",
    channel: "msedge",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node src/web.js",
    url: "http://127.0.0.1:12724/health",
    reuseExistingServer: false,
    env: {
      WEB_PORT: "12724",
      WEB_HOST: "127.0.0.1",
      WEB_ACCESS_TOKEN: "",
      OPENROUTER_API_KEY: "",
      BOT_ACCESS_PASSWORD_HASH: "",
      MEMORY_FILE: path.join(temporary, "memory.json"),
      COMMAND_DB_FILE: path.join(temporary, "commands.sqlite"),
    },
  },
});
