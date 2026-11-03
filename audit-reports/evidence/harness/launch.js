"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

const ROOT = process.env.APP_ROOT || "/home/user/ai_bot";
const SHIM = path.join(__dirname, "redirect-shim.js");

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// Launch `node index.js` of the app with fakes wired in. Returns a handle.
async function launchApp({ tg, or, env = {}, entry = "index.js", shim = true, extraArgs = [] }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aibot-"));
  const port = await freePort();
  const mergedEnv = {
    PATH: process.env.PATH,
    HOME: tmp,
    NODE_ENV: "test",
    BOT_TOKEN: tg.token,
    OPENROUTER_API_KEY: "sk-or-v1-SECRET_KEY_FOR_LEAK_CHECK_0000",
    PORT: String(port),
    MEMORY_FILE: path.join(tmp, "memory.json"),
    APP_ROOT: ROOT,
    FAKE_TG_URL: tg.url,
    FAKE_OR_URL: or ? or.url : "",
    ...env
  };
  const args = [...(shim ? ["--require", SHIM] : []), ...extraArgs, entry];
  const child = spawn(process.execPath, args, { cwd: ROOT, env: mergedEnv, stdio: ["ignore", "pipe", "pipe"] });
  const out = [];
  let exited = null;
  const exitPromise = new Promise((resolve) => child.on("exit", (code, signal) => { exited = { code, signal }; resolve(exited); }));
  child.stdout.on("data", (d) => out.push(String(d)));
  child.stderr.on("data", (d) => out.push(String(d)));

  const handle = {
    child, port, tmp,
    memoryFile: mergedEnv.MEMORY_FILE,
    output: () => out.join(""),
    exited: () => exited,
    exitPromise,
    async waitForOutput(re, timeoutMs = 8000) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (re.test(out.join(""))) return true;
        if (exited) return re.test(out.join(""));
        await new Promise((r) => setTimeout(r, 25));
      }
      return false;
    },
    async stop() {
      if (!exited) child.kill("SIGKILL");
      await exitPromise;
    },
    async httpGet(p) {
      const res = await fetch(`http://127.0.0.1:${port}${p}`);
      return { status: res.status, text: await res.text() };
    }
  };
  return handle;
}

// Wait until the bot has polled at least once (it is "ready").
async function waitReady(tg, app, timeoutMs = 10000) {
  await tg.waitFor(() => tg.calls.some((c) => c.method === "getUpdates") || app.exited(), timeoutMs, "bot polling");
  if (app.exited()) throw new Error(`app exited early: ${JSON.stringify(app.exited())}\n${app.output()}`);
}

module.exports = { launchApp, waitReady, freePort, ROOT };
