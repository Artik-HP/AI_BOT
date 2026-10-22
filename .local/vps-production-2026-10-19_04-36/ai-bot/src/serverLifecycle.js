const http = require("node:http");
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const loadedVersion = crypto.createHash("sha256");
for (const file of [
  "web.js",
  "commandSystem/registry.js",
  "services/access.js",
])
  loadedVersion.update(fs.readFileSync(path.join(__dirname, file)));
const version = loadedVersion.digest("hex");
function instanceId() {
  return crypto
    .createHash("sha256")
    .update(
      path.resolve(
        process.env.COMMAND_DB_FILE ||
          (process.env.MEMORY_FILE
            ? path.join(
                path.dirname(path.resolve(process.env.MEMORY_FILE)),
                "commands.sqlite",
              )
            : path.join(__dirname, "../data/commands.sqlite")),
      ),
    )
    .update(version)
    .digest("hex")
    .slice(0, 16);
}
async function health(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: host, port, path: "/health", timeout: 1500 },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
          if (body.length > 2048) req.destroy();
        });
        res.on("end", () => {
          try {
            resolve(
              res.statusCode === 200 &&
                JSON.parse(body).ok &&
                res.headers["x-orbit-instance"] === instanceId(),
            );
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}
function listen(app, { port = 12723, host = "127.0.0.1" } = {}) {
  const server = app.listen(port, host);
  const ready = new Promise((resolve, reject) => {
    server.once("listening", () =>
      resolve({
        server,
        reused: false,
        url: `http://${host}:${server.address().port}`,
      }),
    );
    server.once("error", async (error) => {
      if (error.code === "EADDRINUSE" && (await health(port, host)))
        return resolve({
          server: null,
          reused: true,
          url: `http://${host}:${port}`,
        });
      const failure = new Error(
        error.code === "EADDRINUSE"
          ? `Порт ${port} занят другой программой. Останови её или настрой WEB_PORT.`
          : error.code === "EACCES"
            ? `Нет разрешения на порт ${port}.`
            : "Не удалось запустить веб-сервер.",
      );
      failure.code = error.code;
      reject(failure);
    });
  });
  return { server, ready };
}
module.exports = { listen, health, instanceId };
