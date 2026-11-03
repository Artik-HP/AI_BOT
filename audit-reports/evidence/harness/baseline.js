"use strict";
// BASELINE evidence run against the ORIGINAL code (before any fix). Output: JSON lines to stdout.
const { FakeTelegram } = require("./fakeTelegram");
const { FakeOpenRouter, reply } = require("./fakeOpenRouter");
const { launchApp, waitReady } = require("./launch");

const results = [];
const only = process.argv[2];

async function withApp(opts, fn) {
  const tg = await new FakeTelegram().start();
  const or = await new FakeOpenRouter().start();
  const app = await launchApp({ tg, or, env: opts.env || {} });
  try {
    await waitReady(tg, app);
    return await fn({ tg, or, app });
  } finally {
    await app.stop().catch(() => {});
    await tg.stop().catch(() => {});
    await or.stop().catch(() => {});
  }
}

async function scenario(id, title, fn) {
  if (only && only !== id) return;
  const t0 = Date.now();
  try {
    const evidence = await fn();
    results.push({ id, title, ok: true, ms: Date.now() - t0, evidence });
  } catch (e) {
    results.push({ id, title, ok: false, ms: Date.now() - t0, error: String(e && e.stack || e).slice(0, 600) });
  }
  console.log("RESULT " + JSON.stringify(results[results.length - 1]));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const firstLine = (t) => String(t || "").split("\n")[0].slice(0, 70);

(async () => {
  // ---------------------------------------------------------------- S1
  await scenario("S1", "Smoke + / + /health (info disclosure)", () => withApp({
    env: {
      ACCOUNT_ASSISTANT_ALLOW_CHATS: "@alice_friend,777000111",
      ACCOUNT_ASSISTANT_BLOCK_CHATS: "@spam_account,999000222",
      ACCOUNT_ASSISTANT_OWNER_CHAT_ID: "555",
      BOT_TO_BOT_CHAT_ID: "-1001234567890",
      BOT_TO_BOT_TARGET_BOT_USERNAME: "peer_test_bot"
    }
  }, async ({ tg, app }) => {
    await tg.waitFor(() => tg.calls.some((c) => c.method === "setMyCommands"), 5000, "setMyCommands");
    const root = await app.httpGet("/");
    const health = await app.httpGet("/health");
    const h = JSON.parse(health.text);
    const cmds = JSON.parse(tg.calls.find((c) => c.method === "setMyCommands").params.commands);
    return {
      rootStatus: root.status, rootBody: root.text,
      healthStatus: health.status, healthAuthRequired: false,
      healthKeys: Object.keys(h),
      leaks: {
        allowList: h.accountAssistant && h.accountAssistant.allowList,
        blockList: h.accountAssistant && h.accountAssistant.blockList,
        botToBotChatId: h.botToBot && h.botToBot.chatId,
        botToBotTarget: h.botToBot && h.botToBot.targetBotUsername,
        botUsername: h.botToBot && h.botToBot.username,
        users: h.users, model: h.model
      },
      menuCommandsRegistered: cmds.length
    };
  }));

  // ---------------------------------------------------------------- S2
  await scenario("S2", "Text -> AI reply + what is sent to the model", () => withApp({}, async ({ tg, or }) => {
    or.chat = () => reply("Привет! Всё норм.");
    tg.message({ chatId: 4001, text: "привет, как дела" });
    await tg.waitFor(() => tg.sent().length >= 1, 8000, "AI reply");
    const req = or.of("/api/v1/chat/completions")[0];
    const sys = req.body.messages[0].content;
    const lines = sys.split("\n");
    const pick = (re) => lines.filter((l) => re.test(l));
    return {
      replyText: tg.sent()[0].text,
      orRequestsForOneUserMessage: or.of("/api/v1/chat/completions").length,
      authHeaderPresent: /^Bearer /.test(req.headers.authorization || ""),
      hasMaxTokens: "max_tokens" in req.body,
      temperature: req.body.temperature,
      model: req.body.model,
      promptLinesImperativeHarm: pick(/Должен давай пошаговые/),
      promptLinesFraud: pick(/выманить деньги/),
      promptLinesDrugRecommend: pick(/советуй интересные таблетки/)
    };
  }));

  // ---------------------------------------------------------------- S3
  await scenario("S3", "Long AI reply (> 4096) is truncated silently", () => withApp({}, async ({ tg, or }) => {
    const long = Array.from({ length: 700 }, (_, i) => `строка номер ${String(i).padStart(4, "0")} — содержательный текст ответа`).join("\n");
    or.chat = () => reply(long);
    tg.message({ chatId: 4002, text: "дай длинный ответ" });
    await tg.waitFor(() => tg.sent().length >= 1, 8000, "long reply");
    await sleep(500);
    const sent = tg.sent();
    const delivered = sent.map((s) => s.text).join("");
    return { aiReplyChars: long.length, messagesSent: sent.length, firstMessageChars: sent[0].text.length, deliveredChars: delivered.length, lostChars: long.length - delivered.length, lastDeliveredLine: sent[sent.length - 1].text.split("\n").pop().slice(0, 60), lastLineOfAiReply: long.split("\n").pop().slice(0, 60) };
  }));

  // ---------------------------------------------------------------- S3b emoji cut
  await scenario("S3b", "Truncation can cut a surrogate pair in half", () => withApp({}, async ({ tg, or }) => {
    or.chat = () => reply("a".repeat(4095) + "😀😀😀");
    tg.message({ chatId: 4003, text: "эмодзи" });
    await tg.waitFor(() => tg.sent().length >= 1, 8000, "emoji reply");
    const t = tg.sent()[0].text;
    const last = t.charCodeAt(t.length - 1);
    return { sentChars: t.length, endsWithLoneHighSurrogate: last >= 0xd800 && last <= 0xdbff, wellFormed: t.isWellFormed ? t.isWellFormed() : "n/a" };
  }));

  // ---------------------------------------------------------------- S4
  await scenario("S4", "Identical consecutive AI replies are dropped silently + 3x API cost", () => withApp({}, async ({ tg, or }) => {
    or.chat = () => reply("ок, понял");
    tg.message({ chatId: 4004, text: "первое" });
    await tg.waitFor(() => tg.sent().length >= 1, 8000, "first reply");
    const afterFirst = or.of("/api/v1/chat/completions").length;
    tg.message({ chatId: 4004, text: "второе, другое сообщение" });
    await sleep(2500);
    return { repliesDelivered: tg.sent().length, secondUserMessageGotAnswer: tg.sent().length >= 2, orCallsForFirst: afterFirst, orCallsForSecond: or.of("/api/v1/chat/completions").length - afterFirst };
  }));

  // ---------------------------------------------------------------- S5a
  await scenario("S5a", "Command handler: blocked-bot error (403) crashes the process", () => withApp({}, async ({ tg, app }) => {
    tg.failNext("sendMessage", 403, "Forbidden: bot was blocked by the user");
    tg.message({ chatId: 4005, text: "/help" });
    await Promise.race([app.exitPromise, sleep(4000)]);
    return { processExited: Boolean(app.exited()), exit: app.exited(), tail: app.output().split("\n").filter((l) => /ETELEGRAM|Unhandled|unhandled|blocked/i.test(l)).slice(-3) };
  }));

  // ---------------------------------------------------------------- S5b
  await scenario("S5b", "Text handler: AI error + sendMessage 403 inside catch crashes the process", () => withApp({}, async ({ tg, or, app }) => {
    or.chat = () => ({ status: 500, body: { error: { message: "upstream down" } } });
    tg.failNext("sendMessage", 403, "Forbidden: bot was blocked by the user");
    tg.message({ chatId: 4006, text: "привет" });
    await Promise.race([app.exitPromise, sleep(4000)]);
    return { processExited: Boolean(app.exited()), exit: app.exited(), tail: app.output().split("\n").filter((l) => /ETELEGRAM|Unhandled|unhandled|blocked/i.test(l)).slice(-3) };
  }));

  // ---------------------------------------------------------------- S6
  await scenario("S6", "Voice: auth failure fans out to 6 requests with full audio payload", () => withApp({}, async ({ tg, or }) => {
    const audio = Buffer.alloc(200000, 7);
    tg.addFile("v1", "voice/v1.oga", audio);
    or.stt = () => ({ status: 401, body: { error: { message: "invalid api key" } } });
    or.chat = () => ({ status: 401, body: { error: { message: "invalid api key" } } });
    tg.message({ chatId: 4007, text: undefined, voice: { file_id: "v1", file_unique_id: "u1", duration: 4, mime_type: "audio/ogg", file_size: audio.length } });
    await tg.waitFor(() => tg.sent().length >= 1, 15000, "voice error reply");
    return { sttRequests: or.of("/api/v1/audio/transcriptions").length, chatFallbackRequests: or.of("/api/v1/chat/completions").length, totalRequests: or.requests.length, sttModelsTried: or.of("/api/v1/audio/transcriptions").map((r) => r.body.model), userSaw: firstLine(tg.sent()[0].text) };
  }));

  // ---------------------------------------------------------------- S7
  await scenario("S7", "Voice happy path (download -> STT -> AI -> reply)", () => withApp({}, async ({ tg, or }) => {
    tg.addFile("v2", "voice/v2.oga", Buffer.alloc(5000, 1));
    or.stt = () => ({ status: 200, body: { text: "расскажи про нейрохимию" } });
    or.chat = () => reply("Дофамин, серотонин и вся компания.");
    tg.message({ chatId: 4008, voice: { file_id: "v2", file_unique_id: "u2", duration: 2, mime_type: "audio/ogg", file_size: 5000 } });
    await tg.waitFor(() => tg.sent().length >= 1, 10000, "voice reply");
    const chat = or.of("/api/v1/chat/completions")[0];
    const lastUser = chat.body.messages[chat.body.messages.length - 1].content;
    return { reply: tg.sent()[0].text, transcriptReachedModel: /нейрохимию/.test(lastUser), sttCalls: or.of("/api/v1/audio/transcriptions").length };
  }));

  // ---------------------------------------------------------------- S8
  await scenario("S8", "Photo happy path + unsupported image document ignored silently", () => withApp({}, async ({ tg, or }) => {
    tg.addFile("p3", "photos/p3.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    or.chat = () => reply("Вижу кота.");
    tg.message({ chatId: 4009, photo: [{ file_id: "p1", file_unique_id: "a", width: 90, height: 90, file_size: 100 }, { file_id: "p3", file_unique_id: "c", width: 1280, height: 960, file_size: 900 }], caption: "что тут?" });
    await tg.waitFor(() => tg.sent().length >= 1, 10000, "photo reply");
    const req = or.of("/api/v1/chat/completions")[0];
    const parts = req.body.messages[req.body.messages.length - 1].content;
    const img = parts.find((p) => p.type === "image_url");
    const used = tg.calls.filter((c) => c.method === "getFile").map((c) => c.params.file_id);
    const beforeOr = or.requests.length, beforeSent = tg.sent().length;
    tg.addFile("h1", "documents/h1.heic", Buffer.alloc(10, 1));
    tg.message({ chatId: 4009, document: { file_id: "h1", file_unique_id: "h", file_name: "photo.heic", mime_type: "image/heic", file_size: 10 } });
    await sleep(1500);
    return { reply: tg.sent()[0].text, largestPhotoRequested: used, dataUrlPrefix: img && img.image_url.url.slice(0, 23), heicDocGotAnyReply: tg.sent().length > beforeSent, heicTriggeredOrCalls: or.requests.length - beforeOr };
  }));

  // ---------------------------------------------------------------- S9
  await scenario("S9", "Command + button + callback inventory (owner & non-owner)", () => withApp({
    env: { BOT_TO_BOT_OWNER_CHAT_ID: "4010", ACCOUNT_ASSISTANT_OWNER_CHAT_ID: "4010" }
  }, async ({ tg }) => {
    const rows = [];
    async function trigger(label, chatId, send) {
      const before = tg.calls.length;
      send();
      await sleep(900);
      const delta = tg.calls.slice(before).filter((c) => !["getUpdates", "sendChatAction"].includes(c.method));
      const msgs = delta.filter((c) => c.method === "sendMessage" || c.method === "editMessageText");
      rows.push({ who: chatId === 4010 ? "owner" : "user", label, replies: msgs.length, first: msgs.length ? firstLine(msgs[0].params.text) : "(no reply)", other: delta.filter((c) => !["sendMessage", "editMessageText"].includes(c.method)).map((c) => c.method) });
    }
    const O = 4010, U = 4011;
    const text = (chatId, label, t) => trigger(label, chatId, () => tg.message({ chatId, text: t }));
    for (const t of ["/start", "/menu", "/help", "/voice", "/status", "/reset", "/bot_status", "/bot_send", "/bot_send hello there"]) await text(O, t, t);
    for (const b of ["Помощь", "Статус", "Голосовые", "Очистить память", "Меню"]) await text(O, `button:${b}`, b);
    for (const a of ["main", "help", "voice", "status", "reset"]) await trigger(`callback menu:${a}`, O, () => tg.callback({ chatId: O, data: `menu:${a}` }));
    for (const t of ["/account_help", "/account_status", "/account_config", "/account_pending", "/account_mode", "/account_mode bogus", "/account_private", "/account_allow @x_user1", "/account_unallow @x_user1", "/account_block @x_user2", "/account_unblock @x_user2", "/account_disable", "/account_enable", "/account_send abc", "/account_drop abc", "/account_reply abc hi", "/account_redraft abc", "/account_message @someone hi"]) await text(O, t, t);
    for (const t of ["/account_help", "/account_status", "/bot_status"]) await text(U, t, t);
    return rows;
  }));

  // ---------------------------------------------------------------- S10
  await scenario("S10", "/account_private with a typo silently disables the private-only safety", () => withApp({
    env: { ACCOUNT_ASSISTANT_OWNER_CHAT_ID: "4012" }
  }, async ({ tg }) => {
    const ask = async (t) => { const n = tg.sent().length; tg.message({ chatId: 4012, text: t }); await tg.waitFor(() => tg.sent().length > n, 4000, t).catch(() => {}); return tg.sent().slice(n).map((s) => s.text).join(" | "); };
    const before = await ask("/account_private");
    const typo = await ask("/account_private ture");
    const after = await ask("/account_private");
    return { before, afterTypoCommandReply: typo, after };
  }));

  // ---------------------------------------------------------------- S11
  await scenario("S11", "Bot senders: text is gated, voice/photo are NOT", () => withApp({}, async ({ tg, or }) => {
    or.chat = () => reply("ответ боту");
    tg.addFile("bv", "voice/bv.oga", Buffer.alloc(3000, 2));
    or.stt = () => ({ status: 200, body: { text: "голос от бота" } });
    tg.message({ chatId: 4013, fromId: 888, isBot: true, firstName: "OtherBot", username: "other_bot", text: "привет от бота" });
    await sleep(1200);
    const textFromBotReplied = tg.sent().length > 0;
    tg.message({ chatId: 4013, fromId: 888, isBot: true, firstName: "OtherBot", username: "other_bot", voice: { file_id: "bv", file_unique_id: "b", duration: 1, mime_type: "audio/ogg", file_size: 3000 } });
    await sleep(2500);
    return { botToBotEnabled: false, textFromBotReplied, voiceFromBotReplied: tg.sent().length > 0, orChatCalls: or.of("/api/v1/chat/completions").length, sttCalls: or.of("/api/v1/audio/transcriptions").length };
  }));

  // ---------------------------------------------------------------- S14
  await scenario("S14", "Port already in use: startup message is misleading / process state", async () => {
    const tgA = await new FakeTelegram().start(), tgB = await new FakeTelegram().start();
    const orA = await new FakeOpenRouter().start();
    const a = await launchApp({ tg: tgA, or: orA, env: {} });
    await waitReady(tgA, a);
    const b = await launchApp({ tg: tgB, or: orA, env: { PORT: String(a.port) } });
    await sleep(2500);
    const out = b.output();
    const res = { secondInstanceExited: Boolean(b.exited()), exit: b.exited(), printedWebServerStarted: /Web server started/.test(out), printedAddrInUse: /EADDRINUSE/.test(out), stillPollingTelegram: tgB.calls.some((c) => c.method === "getUpdates") };
    await b.stop(); await a.stop(); await tgA.stop(); await tgB.stop(); await orA.stop();
    return res;
  });

  // ---------------------------------------------------------------- S15 graceful shutdown
  await scenario("S15", "SIGTERM: process exit code / memory flush", () => withApp({}, async ({ tg, or, app }) => {
    or.chat = () => reply("сохрани меня");
    tg.message({ chatId: 4014, text: "запомни" });
    await tg.waitFor(() => tg.sent().length >= 1, 8000, "reply");
    app.child.kill("SIGTERM");
    await Promise.race([app.exitPromise, sleep(4000)]);
    const fs = require("fs");
    return { exit: app.exited(), memoryFileExists: fs.existsSync(app.memoryFile), pollingStoppedBeforeExit: /stopPolling|Stopping/.test(app.output()) };
  }));

  console.log("DONE " + JSON.stringify({ total: results.length, failedToRun: results.filter((r) => !r.ok).map((r) => r.id) }));
  process.exit(0);
})();
