const { FakeTelegram } = require("./fakeTelegram");
const { FakeOpenRouter, reply } = require("./fakeOpenRouter");
const { launchApp, waitReady } = require("./launch");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const tg = await new FakeTelegram().start(), or = await new FakeOpenRouter().start();
  or.chat = () => reply("ответ пиру");
  const app = await launchApp({ tg, or, env: {
    BOT_TO_BOT_ENABLED: "true", BOT_TO_BOT_OWNER_CHAT_ID: "4100", BOT_TO_BOT_CHAT_ID: "-100777",
    BOT_TO_BOT_TARGET_BOT_USERNAME: "Peer_Test_Bot", BOT_TO_BOT_ALLOW_BOTS: "peer_test_bot",
    BOT_TO_BOT_MIN_INTERVAL_MS: "1", BOT_TO_BOT_MAX_TURNS: "3", BOT_TO_BOT_WINDOW_MS: "60000" } });
  await waitReady(tg, app);
  const res = {};
  // 1) outbound via /bot_send (target configured with upper-case letters like README example)
  tg.message({ chatId: 4100, text: "/bot_send привет, как дела" });
  await sleep(1200);
  const s1 = tg.sent();
  res.botSendCommandReplies = s1.map((s) => ({ chat: String(s.chat_id), text: s.text.slice(0, 60) }));
  // 2) explicit @username form and legacy first-word form
  tg.message({ chatId: 4100, text: "/bot_send peer_test_bot второй вариант" });
  await sleep(900);
  res.legacyFirstWordForm = tg.sent().slice(s1.length).map((s) => ({ chat: String(s.chat_id), text: s.text.slice(0, 60) }));
  // 3) multi-line message keeps its newlines?
  const n3 = tg.sent().length;
  tg.message({ chatId: 4100, text: "/bot_send строка1\nстрока2\n\nстрока4" });
  await sleep(900);
  const out3 = tg.sent().slice(n3)[0];
  res.multilinePreserved = out3 ? out3.text.includes("\n") : null;
  res.multilineSentText = out3 ? JSON.stringify(out3.text) : null;
  // 4) inbound from peer in the configured chat: loop guard (max 3 turns)
  const nIn = tg.sent().length;
  for (let i = 0; i < 6; i++) { tg.message({ chatId: -100777, fromId: 9001, isBot: true, firstName: "Peer", username: "peer_test_bot", chatType: "supergroup", text: `@test_audit_bot ход ${i}` }); await sleep(450); }
  await sleep(800);
  res.inboundPeerMessages = 6;
  res.repliesToPeer = tg.sent().length - nIn;
  res.orCalls = or.of("/api/v1/chat/completions").length;
  // 5) commands addressed to ANOTHER bot in a group
  const n5 = tg.sent().length;
  tg.message({ chatId: -100888, fromId: 4101, chatType: "supergroup", text: "/help@some_other_bot" });
  await sleep(900);
  res.commandForOtherBotAnswered = tg.sent().length > n5;
  console.log("RESULT " + JSON.stringify(res, null, 1));
  await app.stop(); await tg.stop(); await or.stop(); process.exit(0);
})();
