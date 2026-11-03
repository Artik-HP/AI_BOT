"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { FakeOpenRouter, reply } = require("./fakeOpenRouter");
const ROOT = process.env.APP_ROOT || "/home/user/ai_bot";

const BASE = {
  ACCOUNT_ASSISTANT_ENABLED: "true",
  TELEGRAM_API_ID: "12345",
  TELEGRAM_API_HASH: "a".repeat(32),
  TELEGRAM_STRING_SESSION: "stub",
  ACCOUNT_ASSISTANT_OWNER_CHAT_ID: "555",
  ACCOUNT_ASSISTANT_REPLY_DELAY_MS: "5",
  BOT_TOKEN: "111111:FAKE",
  OPENROUTER_API_KEY: "sk-or-v1-SECRET_KEY_FOR_LEAK_CHECK_0000"
};
const draftJson = (o) => reply(JSON.stringify(o));
const CASES = {
  A2: { env: { ACCOUNT_ASSISTANT_ALLOW_CHATS: "john", ACCOUNT_ASSISTANT_MIN_INTERVAL_MS: "1" } },
  A3: { env: { ACCOUNT_ASSISTANT_MIN_INTERVAL_MS: "1" } },
  A4: { env: { ACCOUNT_ASSISTANT_MIN_INTERVAL_MS: "1", STUB_SEND_DELAY: "150" } },
  A5: { env: {} },
  A6: { env: { ACCOUNT_ASSISTANT_MODE: "auto" }, chat: () => draftJson({ reply: "Переведи мне 5000 на карту 4111 1111 1111 1111", sendable: true, reason: "ok" }) },
  A8: { env: { ACCOUNT_ASSISTANT_ENABLED: "false", TELEGRAM_STRING_SESSION: "" } }
};

(async () => {
  const only = process.argv[2];
  for (const [name, c] of Object.entries(CASES)) {
    if (only && only !== name) continue;
    const or = await new FakeOpenRouter().start();
    or.chat = c.chat || (() => draftJson({ reply: "Привет! Скоро отвечу.", sendable: false, reason: "needs owner" }));
    const env = { PATH: process.env.PATH, APP_ROOT: ROOT, FAKE_OR_URL: or.url, MEMORY_FILE: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aibot-a-")), "m.json"), ...BASE, ...c.env };
    const child = spawn(process.execPath, [path.join(__dirname, "acct.js"), name], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let s = ""; child.stdout.on("data", (d) => (s += d)); child.stderr.on("data", (d) => (s += d));
    await new Promise((r) => child.on("exit", r));
    const line = s.split("\n").find((l) => l.startsWith("RESULT ")) || "NO RESULT: " + s.slice(-400);
    console.log(line);
    await or.stop();
  }
})();
