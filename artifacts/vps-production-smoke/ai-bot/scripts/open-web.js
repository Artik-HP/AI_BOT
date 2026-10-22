const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
require("dotenv").config({
  path: path.join(__dirname, "../.env"),
  quiet: true,
});
const { health } = require("../src/serverLifecycle");
async function ensureWeb({ port = 12723, timeout = 12000 } = {}) {
  if (await health(port)) return `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    [path.join(__dirname, "../src/web.js")],
    {
      cwd: path.join(__dirname, ".."),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, WEB_PORT: String(port), WEB_HOST: "127.0.0.1" },
    },
  );
  child.unref();
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await health(port)) return `http://127.0.0.1:${port}`;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `Веб-интерфейс не запустился на порту ${port}. Запусти npm run web, чтобы увидеть причину.`,
  );
}
async function main() {
  const url = await ensureWeb();
  if (process.argv.includes("--no-browser"))
    return console.log("Веб-интерфейс готов: " + url);
  const command =
      process.platform === "win32"
        ? "rundll32.exe"
        : process.platform === "darwin"
          ? "open"
          : "xdg-open",
    args =
      process.platform === "win32"
        ? ["url.dll,FileProtocolHandler", url]
        : [url];
  execFile(command, args, { windowsHide: true }, (error) => {
    if (error) console.error("Открой в браузере: " + url);
  });
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { ensureWeb };
