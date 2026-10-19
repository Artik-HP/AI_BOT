"use strict";
// S3b: a reply whose 4096-char cut lands in the middle of an emoji (surrogate pair).
const { FakeTelegram } = require("./fakeTelegram");
const { FakeOpenRouter, reply } = require("./fakeOpenRouter");
const { launchApp, waitReady } = require("./launch");
(async () => {
  const tg = await new FakeTelegram().start(), or = await new FakeOpenRouter().start();
  or.chat = () => reply("a".repeat(4095) + "😀😀😀");
  const app = await launchApp({ tg, or, env: {} });
  await waitReady(tg, app);
  tg.message({ chatId: 1, text: "эмодзи" });
  await tg.waitFor(() => tg.sent().length >= 1, 8000, "reply");
  const t = tg.sent()[0].text;
  const tail = [...t.slice(-3)].map((c) => "U+" + c.codePointAt(0).toString(16).toUpperCase());
  console.log("RESULT " + JSON.stringify({
    id: "S3b-detail", utf16Length: t.length, codePoints: [...t].length, lastCodePoints: tail,
    sentEmoji_U1F600: "U+1F600", originalEmojiSurvivedWhole: t.endsWith("😀"), endsWithU1F400_rat: t.endsWith("\u{1F400}")
  }));
  await app.stop(); await tg.stop(); await or.stop(); process.exit(0);
})();
