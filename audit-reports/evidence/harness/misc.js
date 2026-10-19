"use strict";
// Unit-ish probes run in child processes (env isolation). Prints RESULT lines.
const { spawnSync, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { FakeOpenRouter, reply } = require("./fakeOpenRouter");
const ROOT = process.env.APP_ROOT || "/home/user/ai_bot";
const H = __dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const only = process.argv[2];
const out = (id, title, evidence) => console.log("RESULT " + JSON.stringify({ id, title, evidence }));
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "aibot-m-"));

function runNode(code, env = {}, { cwd = ROOT, args = [] } = {}) {
  const r = spawnSync(process.execPath, [...args, "-e", code], { cwd, env: { PATH: process.env.PATH, APP_ROOT: ROOT, ...env }, encoding: "utf8", timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}
const lastJson = (s) => { const l = s.trim().split("\n").filter((x) => x.startsWith("{")).pop(); return l ? JSON.parse(l) : { raw: s.slice(0, 300) }; };

async function main() {
  // M1 memory persistence cost
  if (!only || only === "M1") {
    const rows = [];
    for (const chats of [1, 20, 100, 300]) {
      const dir = tmpdir();
      const file = path.join(dir, "memory.json");
      const store = {};
      for (let c = 0; c < chats; c++) {
        store[String(1000 + c)] = {
          mood: "neutral", nickname: "u" + c, trust: 0, style: "talkative", personalNotes: [], messageCount: 300, lastSeen: null, summary: "",
          messages: Array.from({ length: 300 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: ("сообщение " + i + " ").repeat(14).slice(0, 200) }))
        };
      }
      fs.writeFileSync(file, JSON.stringify(store, null, 2));
      const sizeMB = (fs.statSync(file).size / 1e6).toFixed(1);
      const r = runNode(`
        const mem = require(process.env.APP_ROOT + "/src/services/memory");
        const t = [];
        for (let i = 0; i < 12; i++) { const s = process.hrtime.bigint(); mem.remember("1000", { role: "user", content: "x".repeat(200) }); t.push(Number(process.hrtime.bigint() - s) / 1e6); }
        t.sort((a,b)=>a-b);
        console.log(JSON.stringify({ medianMs: +t[6].toFixed(1), maxMs: +t[11].toFixed(1) }));
      `, { MEMORY_FILE: file });
      const j = lastJson(r.stdout);
      rows.push({ chats, fileMB: sizeMB, rememberMedianMs: j.medianMs, rememberMaxMs: j.maxMs, perUserMessageSavesBlockingMs: j.medianMs ? +(j.medianMs * 3).toFixed(0) : null });
    }
    out("M1", "saveMemory cost per remember() (sync full-store parse+copy+stringify+write); one AI message = 3 saves", rows);
  }

  // M2 nickname + mood heuristics
  if (!only || only === "M2") {
    const dir = tmpdir();
    const r = runNode(`
      const mem = require(process.env.APP_ROOT + "/src/services/memory");
      const res = {};
      mem.updatePersonalityMemory("n1", "привет", { first_name: "Вася" });
      const m = mem.updatePersonalityMemory("n1", "зови меня Артём", { first_name: "Вася" });
      res.nicknameAfterExplicitRequest = m.nickname;
      const probe = (t) => { const x = mem.updatePersonalityMemory("p" + Math.random(), t, {}); return x.mood; };
      res.moodFor = {
        "неплохо получилось (= 'not bad')": probe("неплохо получилось"),
        "сохрани данные в json": probe("сохрани данные в json"),
        "мемориал героям": probe("мемориал героям"),
        "кодекс чести": probe("кодекс чести"),
        "вещества в школьной химии": probe("вещества в школьной химии")
      };
      console.log(JSON.stringify(res));
    `, { MEMORY_FILE: path.join(dir, "m.json") });
    out("M2", "nickname override + keyword heuristics", lastJson(r.stdout));
  }

  // M3 .env.example round trip
  if (!only || only === "M3") {
    const dir = tmpdir();
    fs.copyFileSync(path.join(ROOT, ".env.example"), path.join(dir, ".env"));
    const r = runNode(`
      require(process.env.APP_ROOT + "/node_modules/dotenv").config({ path: ".env", quiet: true });
      const c = require(process.env.APP_ROOT + "/src/config");
      let validate = "passed (no error)";
      try { c.validateConfig(); } catch (e) { validate = "threw: " + e.message; }
      console.log(JSON.stringify({ validateConfig: validate, BOT_TOKEN_isLiteralPlaceholder: c.BOT_TOKEN === "process.env.BOT_TOKEN", MODEL_usedForRequests: c.MODEL }));
    `, { MEMORY_FILE: path.join(dir, "m.json") }, { cwd: dir });
    out("M3", "README step 1 (cp .env.example .env) then start", lastJson(r.stdout));
  }

  // M4 numeric env garbage
  if (!only || only === "M4") {
    const r = runNode(`
      const c = require(process.env.APP_ROOT + "/src/config");
      console.log(JSON.stringify({ MAX_AUDIO_BYTES: String(c.MAX_AUDIO_BYTES), MAX_IMAGE_BYTES: String(c.MAX_IMAGE_BYTES), PORT: c.PORT, TELEGRAM_API_ID: String(c.TELEGRAM_API_ID), MAX_HISTORY_MESSAGES: c.MAX_HISTORY_MESSAGES }));
    `, { MAX_AUDIO_BYTES: "25MB", MAX_IMAGE_BYTES: "ten", PORT: "http", TELEGRAM_API_ID: "my_id", MAX_HISTORY_MESSAGES: "-5", MEMORY_FILE: path.join(tmpdir(), "m.json") });
    const j = lastJson(r.stdout);
    out("M4", "env 'MAX_AUDIO_BYTES=25MB' etc.: NaN disables size guards", { ...j, sizeGuardActive: j.MAX_AUDIO_BYTES !== "NaN" });
  }

  // M5 axios error logging leak
  if (!only || only === "M5") {
    const or = await new FakeOpenRouter().start();
    or.chat = () => ({ status: 401, body: { error: { message: "invalid key" } } });
    const code = `
      const axios = require(process.env.APP_ROOT + "/node_modules/axios");
      (async () => {
        try {
          await axios.post(process.env.URL + "/api/v1/chat/completions",
            { messages: [{ role: "user", content: "MY-PRIVATE-MESSAGE-TEXT" }] },
            { headers: { Authorization: "Bearer sk-or-v1-SECRET_KEY_FOR_LEAK_CHECK_0000" } });
        } catch (e) { if (process.env.MODE === "unhandled") { Promise.reject(e); } else { console.error(e); } }
      })();
    `;
    const res = {};
    for (const mode of ["console.error(err)", "unhandled"]) {
      const r = await new Promise((resolve) => {
        const c = spawn(process.execPath, ["-e", code], { env: { PATH: process.env.PATH, APP_ROOT: ROOT, URL: or.url, MODE: mode === "unhandled" ? "unhandled" : "log" }, stdio: ["ignore", "pipe", "pipe"] });
        let s = ""; c.stdout.on("data", (d) => (s += d)); c.stderr.on("data", (d) => (s += d)); c.on("exit", () => resolve(s));
      });
      res[mode] = { apiKeyInLog: /sk-or-v1-SECRET_KEY/.test(r), userMessageInLog: /MY-PRIVATE-MESSAGE-TEXT/.test(r), authorizationHeaderLine: (r.match(/Authorization[^\n]{0,60}/) || [null])[0] && "present" };
    }
    await or.stop();
    out("M5", "what a raw AxiosError prints when logged (gramjs handler path / unhandledRejection)", res);
  }

  // M6 real gramjs API surface
  if (!only || only === "M6") {
    const r = runNode(`
      const { TelegramClient } = require(process.env.APP_ROOT + "/node_modules/telegram");
      const { StringSession } = require(process.env.APP_ROOT + "/node_modules/telegram/sessions");
      const c = new TelegramClient(new StringSession(""), 1, "a".repeat(32), {});
      console.log(JSON.stringify({ typeof_isConnected: typeof c.isConnected, typeof_connected: typeof c.connected, connectedValue: String(c.connected) }));
      process.exit(0);
    `);
    out("M6", "real gramjs: client.isConnected exists?", lastJson(r.stdout));
  }

  // M7 userbot authorization (stranger commands)
  if (!only || only === "M7") {
    const r = spawnSync(process.execPath, ["--require", path.join(H, "userbot-stub.js"), "scripts/userbot.js"], { cwd: ROOT, env: { PATH: process.env.PATH, TELEGRAM_API_ID: "12345", TELEGRAM_API_HASH: "a".repeat(32), TELEGRAM_STRING_SESSION: "stubsession", HOME: tmpdir() }, encoding: "utf8", timeout: 30000 });
    const events = r.stdout.split("\n").filter((l) => l.startsWith("EVENT ")).map((l) => JSON.parse(l.slice(6)));
    const builder = (r.stdout.split("\n").find((l) => l.startsWith("BUILDER ")) || "").slice(8);
    out("M7", "scripts/userbot.js: who can drive the owner's account?", { eventBuilderOptions: builder, events });
  }

  console.log("DONE");
}
main().catch((e) => { console.log("FATAL " + e.stack); process.exit(1); });
