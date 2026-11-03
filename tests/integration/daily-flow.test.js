const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { withApp } = require("../helpers/app");
const { reply } = require("../helpers/fakeOpenRouter");
const { emptyData } = require("../../src/companion/store");
const { IDEAS, inlineKeyboard, lastMessage, readStore, say, toolCalls, toolResults, userTurnOf } = require("../helpers/ideasChat");

const LABELS = { Область: "domain", Ограничение: "constraint", Поворот: "twist", "Для кого": "audience" };

// { domain: "…", twist: "…" } from the lines of a spark card.
function sparkOfCard(text) {
  return Object.fromEntries(text.split("\n").map((line) => line.match(/^(Область|Ограничение|Поворот|Для кого): (.+)$/)).filter(Boolean)
    .map(([, label, value]) => [LABELS[label], value]));
}

function dailyStore(chatId) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aibot-daily-")), "store.json");

  fs.writeFileSync(file, JSON.stringify({ ...emptyData(), daily: { [chatId]: { chatId: String(chatId), userId: String(chatId), time: "09:00", timeZone: "", nextAt: Date.now() - 1000, tries: 0, createdAt: 0 } } }));
  return file;
}

test("/daily: включить на время (ответ говорит, по какому поясу), посмотреть, выключить; в группе — подсказка; неверное время — формат", async () => {
  await withApp({ env: IDEAS }, async ({ tg, app }) => {
    const [on] = await say(tg, 5801, "/daily 9:30");

    assert.match(on, /^Готово: каждый день в 09:30 \(по UTC: часовой пояс бота не задан\) пришлю искру без AI, а идеи к ней — по кнопке\. Первая: \d{4}-\d{2}-\d{2} 09:30 UTC\./);
    assert.deepEqual([readStore(app).daily["5801"].time, readStore(app).daily["5801"].timeZone], ["09:30", ""]);
    assert.match((await say(tg, 5801, "/daily"))[0], /^Искра дня: каждый день в 09:30 \(по UTC\)\. Следующая: /);
    assert.match((await say(tg, 5801, "/status"))[0], /\nИскра дня: в 09:30 UTC/);

    await say(tg, 5801, "/daily 07:05");
    assert.equal(Object.keys(readStore(app).daily).length, 1, "одна на человека");

    assert.equal((await say(tg, 5801, "/daily off"))[0], "Искра дня выключена.");
    assert.equal(readStore(app).daily["5801"], undefined);
    assert.match((await say(tg, 5801, "/daily off"))[0], /^Искра дня и так выключена/);
    assert.match((await say(tg, 5801, "/daily 25:00"))[0], /^Формат: \/daily 09:00/);
    assert.match((await say(tg, -100801, "/daily 09:00", { chatType: "supergroup", fromId: 5801 }))[0], /личный диалог/);
  });

  await withApp({ env: { ...IDEAS, BOT_TIMEZONE: "Europe/Kyiv" } }, async ({ tg }) => {
    assert.match((await say(tg, 5802, "/daily 09:00"))[0], /\(по времени Europe\/Kyiv\).*Первая: \d{4}-\d{2}-\d{2} 09:00 Europe\/Kyiv\./);
  });
});

test("Искра дня приходит в срок картой без AI; «💡 Идеи к этой искре» — один запрос к модели с этой искрой; запись переносится на завтра", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aibot-daily-")), "store.json");

  fs.writeFileSync(file, JSON.stringify({ ...emptyData(), daily: { 5803: { chatId: "5803", userId: "5803", time: "09:00", timeZone: "", nextAt: Date.now() - 1000, tries: 0, createdAt: 0 } } }));

  await withApp({ env: { ...IDEAS, COMPANION_FILE: file, COMPANION_REMINDER_TICK_MS: "200" } }, async ({ tg, or }) => {
    await tg.waitFor(() => tg.texts().some((text) => text.startsWith("☀️ Искра дня")), 8000, "искра дня");

    const call = tg.calls.find((entry) => entry.method === "sendMessage" && String(entry.params.text).startsWith("☀️ Искра дня"));
    const [button] = inlineKeyboard(call.params).flat();
    const card = call.params.text;

    assert.equal(button.text, "💡 Идеи к этой искре");
    assert.equal(or.chatRequests().length, 0, "карта без AI");
    await tg.waitFor(() => JSON.parse(fs.readFileSync(file, "utf8")).daily["5803"].nextAt > Date.now(), 4000, "перенос на завтра");

    or.chat = () => reply("идеи к искре дня");
    tg.callback({ chatId: 5803, data: button.callback_data, messageId: call.messageId });
    await tg.waitFor(() => tg.texts().includes("идеи к искре дня"), 8000, "идеи по кнопке");

    assert.equal(or.chatRequests().length, 1);

    for (const line of card.split("\n").filter((entry) => /^(Область|Ограничение|Поворот|Для кого): /.test(entry))) {
      assert.ok(userTurnOf(or).includes(line), `в запросе нет «${line}»`);
    }
  });
});

test("«💡 Идеи к этой искре» под старой искрой дня делает её последней в чате: «поменяй …» меняет её, а не искру, брошенную позже", async () => {
  await withApp({ env: { ...IDEAS, COMPANION_FILE: dailyStore(5804), COMPANION_REMINDER_TICK_MS: "200" } }, async ({ tg, or }) => {
    await tg.waitFor(() => tg.texts().some((text) => text.startsWith("☀️ Искра дня")), 8000, "искра дня");

    const call = tg.calls.find((entry) => entry.method === "sendMessage" && String(entry.params.text).startsWith("☀️ Искра дня"));
    const [button] = inlineKeyboard(call.params).flat();
    const daily = sparkOfCard(call.params.text);
    const swapped = Object.keys(daily).find((name) => name !== "domain");

    or.chat = () => reply("идеи");
    const [later] = await say(tg, 5804, "/spark", { count: 2 });

    assert.notEqual(sparkOfCard(later).domain, daily.domain, "позже брошена другая искра");

    tg.callback({ chatId: 5804, data: button.callback_data, messageId: call.messageId });
    await tg.waitFor(() => or.chatRequests().length === 2, 8000, "идеи по кнопке искры дня");
    await tg.quiet(200);

    or.chat = (record) => (lastMessage(record).role === "tool" ? reply(JSON.stringify(toolResults(record).at(-1))) : toolCalls(["idea_spark", { reroll: [swapped] }]));

    const [rerolled] = JSON.parse((await say(tg, 5804, "поменяй это"))[0]).sparks;
    const { [swapped]: changed, ...kept } = rerolled;
    const { [swapped]: was, ...expected } = daily;

    assert.deepEqual(kept, expected, "переброшена искра дня, остальное от неё");
    assert.notEqual(changed, was);
  });
});
