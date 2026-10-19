"use strict";
// End-to-end responsiveness and large-file comparison. Run it against any checkout:
//   node perf-compare.js                                   -> current working tree
//   APP_ROOT=/tmp/ai_bot_baseline LEGACY_BASELINE=1 node perf-compare.js   -> pre-audit code
const fs = require("fs");
const os = require("os");
const path = require("path");
const { withApp } = require("../../../tests/helpers/app");
const { reply } = require("../../../tests/helpers/fakeOpenRouter");

const MB = 1024 * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildMemoryFile(chats) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aibot-perf-"));
  const file = path.join(dir, "memory.json");
  const store = {};

  for (let chat = 0; chat < chats; chat += 1) {
    store[String(1000 + chat)] = {
      mood: "neutral", nickname: `u${chat}`, trust: 0, style: "talkative", personalNotes: [], messageCount: 300, lastSeen: null, summary: "",
      messages: Array.from({ length: 300 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `сообщение ${i} `.repeat(14).slice(0, 200) }))
    };
  }

  fs.writeFileSync(file, JSON.stringify(store, null, 2));
  return { file, sizeMb: +(fs.statSync(file).size / MB).toFixed(1) };
}

function peakRssMb(pid) {
  try {
    return Math.round(Number(fs.readFileSync(`/proc/${pid}/status`, "utf8").match(/VmHWM:\s+(\d+) kB/)[1]) / 1024);
  } catch {
    return null;
  }
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

async function responsiveness(chats) {
  const memory = buildMemoryFile(chats);

  return withApp({ env: { MEMORY_FILE: memory.file, RATE_LIMIT_MESSAGES: "1000" } }, async ({ tg, or, app }) => {
    or.chat = () => reply("ответ");
    await sleep(500);

    const latencies = [];
    let running = true;
    const poller = (async () => {
      while (running) {
        const started = process.hrtime.bigint();

        try {
          await app.http("/health");
        } catch {
          // a stalled or restarting server is recorded as a slow sample below
        }

        latencies.push(Number(process.hrtime.bigint() - started) / 1e6);
        await sleep(20);
      }
    })();

    const startedAt = Date.now();

    for (let i = 0; i < 30; i += 1) {
      tg.message({ chatId: 1000 + i, text: `вопрос ${i}` });
    }

    await tg.waitFor(() => tg.texts().length >= 30, 120000, "30 ответов");
    const totalMs = Date.now() - startedAt;

    running = false;
    await poller;
    latencies.sort((a, b) => a - b);

    return {
      scenario: `memory ${chats} chats (${memory.sizeMb} MB) + 30 concurrent messages`,
      totalMsFor30Replies: totalMs,
      healthSamples: latencies.length,
      healthLatencyMs: { p50: +percentile(latencies, 0.5).toFixed(1), p95: +percentile(latencies, 0.95).toFixed(1), max: +latencies[latencies.length - 1].toFixed(1) }
    };
  });
}

async function largeAudio(sizeMb) {
  return withApp({}, async ({ tg, or, app }) => {
    tg.addFile("big", "voice/big.oga", Buffer.alloc(sizeMb * MB, 9));
    or.stt = () => ({ status: 200, body: { text: "длинная запись" } });
    or.chat = () => reply("готово");

    const startedAt = Date.now();

    tg.message({ chatId: 1, voice: { file_id: "big", file_unique_id: "b", duration: 9, mime_type: "audio/ogg", file_size: sizeMb * MB } });
    await tg.waitFor(() => tg.texts().length >= 1, 60000, "reply");

    return { scenario: `voice ${sizeMb} MB end to end`, totalMs: Date.now() - startedAt, peakRssMb: peakRssMb(app.child.pid) };
  });
}

(async () => {
  const runs = [
    () => responsiveness(1),
    () => responsiveness(100),
    () => largeAudio(18)
  ];

  for (const run of runs) {
    try {
      console.log(JSON.stringify(await run()));
    } catch (error) {
      console.log(JSON.stringify({ error: String(error.message).slice(0, 200) }));
    }
  }

  process.exit(0);
})();
