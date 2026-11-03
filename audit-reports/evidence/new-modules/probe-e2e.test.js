const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const R = require("path").resolve(__dirname, "..", "..", "..");
const { withApp } = require(`${R}/tests/helpers/app`);
const { reply } = require(`${R}/tests/helpers/fakeOpenRouter`);

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "aibot-probe-"));

test("P1: a stranger without the password floods the bot - how many replies does he get?", async () => {
  await withApp({ authenticatedFixtures: false, env: { RATE_LIMIT_MESSAGES: "5", RATE_LIMIT_WINDOW_MS: "60000" } }, async ({ tg, or }) => {
    for (let i = 0; i < 60; i += 1) tg.message({ chatId: 31337, text: `спам ${i}` });
    await tg.quiet(2500);
    const replies = tg.sent().filter((p) => String(p.chat_id) === "31337").length;
    console.log(`P1: 60 messages from an unauthenticated stranger (RATE_LIMIT_MESSAGES=5/min) -> ${replies} bot replies, ${or.requests.length} OpenRouter requests`);
    assert.ok(replies > 5, "rate limit does not apply before the password gate");
  });
});

test("P2: corrupt lab store file - does NORMAL private chat still work?", async () => {
  const dir = tmpDir();
  const labFile = path.join(dir, "lab.json");
  fs.writeFileSync(labFile, "{ this is not json");
  await withApp({ env: { AI_LAB_FILE: labFile } }, async ({ tg, or, app }) => {
    or.chat = () => reply("обычный ответ на обычный вопрос");
    tg.message({ chatId: 4242, text: "привет, как дела?" });
    await tg.quiet(2500);
    const got = tg.texts().filter(Boolean);
    console.log("P2: replies to a normal message with a corrupt lab file ->", JSON.stringify(got), "| OpenRouter chat requests:", or.chatRequests().length);
    console.log("P2: log tail:", app.output().split("\n").filter((l) => /error|ERROR|Lab|lab/i.test(l)).slice(-3).join(" || ").slice(0, 300));
    assert.ok(got.includes("обычный ответ на обычный вопрос"), "normal chat must not depend on the lab store");
  });
});

test("P3: stale lab lock left by a previous container run (same PID as the new process)", async () => {
  const dir = tmpDir();
  const labFile = path.join(dir, "lab.json");
  // a valid empty store + a lock whose pid is alive (pid 1 always is) = what an unclean restart in Docker leaves behind
  fs.writeFileSync(labFile, JSON.stringify({ version: 1, scopes: {} }));
  fs.writeFileSync(`${labFile}.lock`, JSON.stringify({ pid: 1, token: "old-incarnation" }));
  await withApp({ env: { AI_LAB_FILE: labFile } }, async ({ tg, or }) => {
    or.chat = () => reply("обычный ответ");
    tg.message({ chatId: 4243, text: "привет" });
    await tg.quiet(2500);
    const got = tg.texts().filter(Boolean);
    console.log("P3: replies to a normal message with a stale lock ->", JSON.stringify(got));
    tg.message({ chatId: 4243, text: "/lab" });
    await tg.quiet(1500);
    console.log("P3: after /lab ->", JSON.stringify(tg.texts().filter(Boolean).slice(-1)));
    assert.ok(got.includes("обычный ответ"));
  });
});
