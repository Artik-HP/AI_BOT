// Burst of 30 concurrent messages with a prefilled memory file of N chats (default 1).
//   node perf-burst.js 100
//   APP_ROOT=/tmp/ai_bot_baseline LEGACY_BASELINE=1 node perf-burst.js 100   # pre-audit code
const fs = require("fs"), os = require("os"), path = require("path");
const { withApp } = require("../../../tests/helpers/app");
const { reply } = require("../../../tests/helpers/fakeOpenRouter");
const chats = Number(process.argv[2] || 1);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aibot-dbg-")); const file = path.join(dir, "memory.json");
const store = {}; for (let c = 0; c < chats; c++) store[String(1000 + c)] = { mood: "neutral", nickname: "u" + c, trust: 0, style: "talkative", personalNotes: [], messageCount: 300, lastSeen: null, summary: "", messages: Array.from({ length: 300 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `сообщение ${i} `.repeat(14).slice(0, 200) })) };
fs.writeFileSync(file, JSON.stringify(store, null, 2));
(async () => {
  await withApp({ env: { MEMORY_FILE: file } }, async ({ tg, or, app }) => {
    or.chat = () => reply("ответ");
    for (let i = 0; i < 30; i += 1) tg.message({ chatId: 1000 + i, text: `вопрос ${i}` });
    const t0 = Date.now();
    try { await tg.waitFor(() => tg.texts().length >= 30, 40000, "30 ответов"); console.log(`memory ${chats} chats: delivered all 30 in`, Date.now() - t0, "ms"); }
    catch (e) { console.log(`memory ${chats} chats: TIMEOUT; delivered:`, tg.texts().length, "| OR requests:", or.chatRequests().length, "| exited:", JSON.stringify(app.exited())); }
    const out = app.output(); const err = out.split("\n").filter(l => /error|Error|ERR|rror:/.test(l)).slice(0, 4); if (err.length) console.log("errors in app output:", err.join(" || ").slice(0, 400));
  });
  process.exit(0);
})();
