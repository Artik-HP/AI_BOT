// Starts the real bot (`node index.js`) as a child process against the fakes and gives tests a handle on it.
const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { FakeTelegram } = require("./fakeTelegram");
const { FakeOpenRouter, TEST_OPENROUTER_KEY } = require("./fakeOpenRouter");

const ROOT = process.env.APP_ROOT || path.join(__dirname, "..", "..");
const MAX_LAUNCH_ATTEMPTS = 4;
const LEGACY_SHIM = path.join(__dirname, "..", "..", "audit-reports", "evidence", "harness", "redirect-shim.js");

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// LEGACY_BASELINE=1 (with APP_ROOT=<pre-audit checkout>) runs the pre-audit code, which cannot be pointed
// at the fakes through environment variables, via the redirect shim from the audit evidence.
// It is how the audit proves that these tests fail on the old code.
async function launchApp({ tg, or, env = {}, entry = "index.js", legacy = process.env.LEGACY_BASELINE === "1", port }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aibot-it-"));
  const appPort = port || await freePort();
  const mergedEnv = {
    PATH: process.env.PATH,
    HOME: tmp,
    NODE_ENV: "test",
    APP_ROOT: ROOT,
    BOT_TOKEN: tg.token,
    OPENROUTER_API_KEY: TEST_OPENROUTER_KEY,
    PORT: String(appPort),
    MEMORY_FILE: path.join(tmp, "memory.json"),
    MEMORY_SAVE_DEBOUNCE_MS: "40",
    TELEGRAM_API_BASE_URL: tg.url,
    OPENROUTER_BASE_URL: or ? or.baseUrl : "",
    FAKE_TG_URL: tg.url,
    FAKE_OR_URL: or ? or.url : "",
    ...env
  };

  for (const [name, value] of Object.entries(mergedEnv)) {
    if (value === undefined) {
      delete mergedEnv[name];
    }
  }

  const args = [...(legacy ? ["--require", LEGACY_SHIM] : []), entry];
  const child = spawn(process.execPath, args, { cwd: ROOT, env: mergedEnv, stdio: ["ignore", "pipe", "pipe"] });
  const chunks = [];
  let exited = null;
  const exitPromise = new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      exited = { code, signal };
      resolve(exited);
    });
  });

  child.stdout.on("data", (data) => chunks.push(String(data)));
  child.stderr.on("data", (data) => chunks.push(String(data)));

  return {
    child,
    port: appPort,
    tmp,
    memoryFile: mergedEnv.MEMORY_FILE,
    output: () => chunks.join(""),
    exited: () => exited,
    exitPromise,
    async waitForOutput(pattern, timeoutMs = 8000) {
      const started = Date.now();

      while (Date.now() - started < timeoutMs) {
        if (pattern.test(chunks.join(""))) {
          return true;
        }

        if (exited) {
          return pattern.test(chunks.join(""));
        }

        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      return false;
    },
    async waitForExit(timeoutMs = 8000) {
      return Promise.race([
        exitPromise,
        new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))
      ]);
    },
    async stop() {
      if (!exited) {
        child.kill("SIGKILL");
      }

      await exitPromise;
    },
    async http(pathname, headers = {}) {
      const response = await fetch(`http://127.0.0.1:${appPort}${pathname}`, { headers });
      return { status: response.status, text: await response.text() };
    }
  };
}

async function waitReady(tg, app, timeoutMs = 10000) {
  await tg.waitFor(() => tg.pollCount() > 0 || app.exited(), timeoutMs, "bot polling");

  // The web server reports its fate (started / could not start) a moment after polling begins; wait for it, so that
  // a port lost to a parallel test is noticed here and not as a mysterious failure in the middle of the test body.
  await app.waitForOutput(/Web server (started|could not start)/, 5000);

  if (app.exited()) {
    throw new Error(`app exited early: ${JSON.stringify(app.exited())}\n${app.output()}`);
  }
}

// Runs `fn` with a started bot, a fake Telegram and a fake OpenRouter, and always cleans up.
async function withApp(options, fn) {
  const tg = await new FakeTelegram(options.telegram).start();
  const or = await new FakeOpenRouter().start();

  // Lets a test arrange the fakes (for example a failing getMe) before the bot process starts.
  options.setup?.({ tg, or });

  let app = null;

  try {
    // freePort() frees the port before the bot binds it, and tests run in parallel processes: now and then another
    // process grabs that very port in between. That is a property of the harness, not of the bot, so start again.
    for (let attempt = 1; ; attempt += 1) {
      app = await launchApp({ tg, or, env: options.env, legacy: options.legacy });

      try {
        await waitReady(tg, app);
        break;
      } catch (error) {
        const portTaken = /EADDRINUSE/.test(app.output());

        await app.stop().catch(() => {});

        if (!portTaken || attempt >= MAX_LAUNCH_ATTEMPTS) {
          app = null;
          throw error;
        }
      }
    }

    return await fn({ tg, or, app });
  } finally {
    await app?.stop().catch(() => {});
    await tg.stop().catch(() => {});
    await or.stop().catch(() => {});
  }
}

module.exports = {
  ROOT,
  freePort,
  launchApp,
  waitReady,
  withApp
};
