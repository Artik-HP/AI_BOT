const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-web-test-"));
process.env.MEMORY_FILE = path.join(dir, "memory.json");
process.env.COMMAND_DB_FILE = path.join(dir, "commands.sqlite");
const { CommandStore } = require("../src/commandSystem/store"),
  { createWebApp } = require("../src/web");
const store = new CommandStore(process.env.COMMAND_DB_FILE);
let server, base;
test.before(async () => {
  server = createWebApp({ store, accessToken: "unit-access" }).listen(
    0,
    "127.0.0.1",
  );
  await new Promise((r) => server.once("listening", r));
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => {
  server.close();
  store.close();
});
async function session() {
  const r = await fetch(base + "/api/session", {
    headers: { "X-Access-Token": "unit-access" },
  });
  return {
    cookie: r.headers.get("set-cookie").split(";")[0],
    csrf: (await r.json()).csrf,
  };
}
async function run(s, id, args, key = require("crypto").randomUUID()) {
  return fetch(base + "/api/commands/" + id, {
    method: "POST",
    headers: {
      Cookie: s.cookie,
      "Content-Type": "application/json",
      "X-CSRF-Token": s.csrf,
      "Idempotency-Key": key,
    },
    body: JSON.stringify({ args }),
  });
}
test("actual HTTP serves UI, health and authenticated catalog; owner tools are unavailable", async () => {
  assert.equal((await fetch(base + "/")).status, 200);
  assert.deepEqual(await (await fetch(base + "/health")).json(), { ok: true });
  assert.equal((await fetch(base + "/api/commands")).status, 401);
  assert.equal((await fetch(base + "/api/session")).status, 401);
  const s = await session();
  const list = await (
    await fetch(base + "/api/commands", { headers: { Cookie: s.cookie } })
  ).json();
  assert.ok(list.commands.some((c) => c.id === "quiz"));
  assert.ok(!list.commands.some((c) => c.owner));
});
test("HTTP command execution validates CSRF, origin, schema, request key and errors", async () => {
  const s = await session();
  assert.equal(
    (
      await fetch(base + "/api/commands/uuid", {
        method: "POST",
        headers: { Cookie: s.cookie, "Content-Type": "application/json" },
        body: '{"args":"1"}',
      })
    ).status,
    403,
  );
  const headers = {
    Cookie: s.cookie,
    "Content-Type": "application/json",
    "X-CSRF-Token": s.csrf,
    "Idempotency-Key": "test",
  };
  assert.equal(
    (
      await fetch(base + "/api/commands/uuid", {
        method: "POST",
        headers: { ...headers, Origin: "https://evil.example" },
        body: '{"args":"1"}',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(base + "/api/commands/uuid", {
        method: "POST",
        headers: { ...headers, Origin: "not a URL" },
        body: '{"args":"1"}',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(base + "/api/commands/uuid", {
        method: "POST",
        headers: {
          Cookie: s.cookie,
          "Content-Type": "application/json",
          "X-CSRF-Token": s.csrf,
        },
        body: '{"args":"1"}',
      })
    ).status,
    400,
  );
  assert.match(
    (await (await run(s, "calculator", "2*(3+4)")).json()).text,
    /14/,
  );
  assert.equal(
    (await (await run(s, "calculator", "process.exit()")).json()).error,
    true,
  );
  assert.equal(
    (await (await run(s, "account_message", "@anyuser Hello")).json()).error,
    true,
  );
  const invalid = await fetch(base + "/api/commands/uuid", {
    method: "POST",
    headers,
    body: '{"args":{"code":"evil"}}',
  });
  assert.equal((await invalid.json()).error, true);
});
test("two actual HTTP sessions cannot see or change each other’s notes; retry does not duplicate", async () => {
  const a = await session(),
    b = await session();
  await run(a, "notes", "add Isolated", "same-operation");
  await run(a, "notes", "add Isolated", "same-operation");
  const own = await (await run(a, "notes", "list")).json(),
    other = await (await run(b, "notes", "list")).json();
  assert.match(own.text, /Isolated/);
  assert.ok(!other.text.includes("Isolated"));
  assert.equal(own.text.split("Isolated").length, 2);
});
test("without an AI key the API reports configuration and local tools remain usable", async () => {
  const s = await session();
  const ai = await (await run(s, "explain", "DNS")).json();
  assert.equal(ai.error, true);
  assert.match(ai.text, /OPENROUTER_API_KEY/);
  assert.ok(
    (await (await run(s, "uuid", "1")).json()).text.match(/^[a-f0-9-]{36}$/),
  );
});
