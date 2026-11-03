const test = require("node:test");
const assert = require("node:assert/strict");
const { withApp } = require("../helpers/app");
const { reply } = require("../helpers/fakeOpenRouter");
const { SPARK_LABELS } = require("../../src/ideas/catalog");
const { IDEAS, callsThen, inlineKeyboard, say, userTurnOf } = require("../helpers/ideasChat");

const keycap = (digit) => `${digit}${String.fromCodePoint(0xfe0f)}${String.fromCodePoint(0x20e3)}`;
const IDEA_LIST = [1, 2, 3].map((n) => `${keycap(n)} Идея номер ${n}`).join("\n");
const LABEL_KEYS = Object.fromEntries(Object.entries(SPARK_LABELS).map(([key, label]) => [label, key]));

// The last message the bot sent with action buttons: its id, its text and its buttons.
function lastKeyboard(tg) {
  const call = tg.calls.filter((entry) => entry.method === "sendMessage" && inlineKeyboard(entry.params)?.flat().some((button) => button.callback_data?.startsWith("act:"))).at(-1);

  return call ? { messageId: call.messageId, text: call.params.text, buttons: inlineKeyboard(call.params).flat() } : null;
}

// Presses a button and returns the answer to the callback (with `text` when it is a toast).
async function press(tg, chatId, keyboard, label, extra = {}) {
  const button = keyboard.buttons.find((entry) => entry.text === label);

  assert.ok(button, `нет кнопки «${label}» среди ${keyboard.buttons.map((entry) => entry.text).join(", ")}`);

  const before = tg.sent("answerCallbackQuery").length;

  tg.callback({ chatId, data: button.callback_data, messageId: keyboard.messageId, ...extra });
  await tg.waitFor(() => tg.sent("answerCallbackQuery").length > before, 8000, `ответ на «${label}»`);
  return tg.sent("answerCallbackQuery").at(-1);
}

async function pressAndWait(tg, chatId, keyboard, label, count = 1) {
  const before = tg.texts().length;
  const answer = await press(tg, chatId, keyboard, label);

  await tg.waitFor(() => tg.texts().length >= before + count, 10000, `ответ бота на «${label}»`);
  await tg.quiet(150);
  return { answer, texts: tg.texts().slice(before) };
}

function cardSpark(card) {
  const lines = card.split("\n").slice(1);

  return Object.fromEntries(lines.slice(0, lines.indexOf("")).map((line) => {
    const [label, ...value] = line.split(": ");

    return [LABEL_KEYS[label], value.join(": ")];
  }));
}

test("кнопки под ответом с идеями: только при двух маркерах и у характера идей; нажатие — слова человека; второе нажатие тоже отвечено", async () => {
  await withApp({ env: IDEAS }, async ({ tg, or }) => {
    or.chat = () => reply(IDEA_LIST);
    await say(tg, 5601, "придумай про кофе");

    const keyboard = lastKeyboard(tg);

    assert.equal(keyboard.text, IDEA_LIST);
    assert.deepEqual(keyboard.buttons.map((button) => button.text), ["Развей 1", "Развей 2", "Развей 3", "💾 1", "💾 2", "💾 3", "🔁 Ещё", "📊 Оцени"]);

    or.chat = () => reply("развиваю");

    for (const [label, words] of [["Развей 2", "развей 2"], ["Развей 2", "развей 2"], ["💾 3", "сохрани идею 3 в банк"], ["🔁 Ещё", "ещё"], ["📊 Оцени", "оцени эти идеи"]]) {
      const { answer, texts } = await pressAndWait(tg, 5601, keyboard, label);

      assert.equal(answer.text, undefined, "без всплывающего отказа");
      assert.deepEqual(texts, ["развиваю"], label);
      assert.equal(userTurnOf(or), words);
    }

    or.chat = () => reply(`только ${keycap(1)} одна`);
    await say(tg, 5601, "одну идею");
    assert.equal(lastKeyboard(tg).messageId, keyboard.messageId, "с одним маркером кнопок нет");

    await say(tg, 5601, "/style собеседник");
    or.chat = () => reply(IDEA_LIST);
    await say(tg, 5601, "а теперь?");
    assert.equal(lastKeyboard(tg).messageId, keyboard.messageId, "у собеседника кнопок под ответом нет");
  });
});

test("голосовое идёт тем же конвейером: ответ с идеями на голосовое тоже получает кнопки", async () => {
  await withApp({ env: IDEAS }, async ({ tg, or }) => {
    tg.addFile("v-ideas", "voice/ideas.oga", Buffer.alloc(3000, 4));
    or.stt = () => ({ status: 200, body: { text: "придумай про чай" } });
    or.chat = () => reply(IDEA_LIST);
    tg.message({ chatId: 5607, voice: { file_id: "v-ideas", file_unique_id: "v-ideas", duration: 2, mime_type: "audio/ogg", file_size: 3000 } });
    await tg.waitFor(() => lastKeyboard(tg) !== null, 10000, "ответ на голосовое с кнопками");
    assert.equal(lastKeyboard(tg).text, IDEA_LIST);
    assert.ok(lastKeyboard(tg).buttons.some((button) => button.text === "Развей 3"));
  });
});

test("новая клавиатура гасит старую: «Кнопка устарела», без запроса к модели; кнопки старого сообщения снимаются", async () => {
  await withApp({ env: IDEAS }, async ({ tg, or }) => {
    or.chat = () => reply(IDEA_LIST);
    await say(tg, 5602, "первые идеи");

    const first = lastKeyboard(tg);

    await say(tg, 5602, "вторые идеи");

    const requests = or.chatRequests().length;

    assert.notEqual(lastKeyboard(tg).messageId, first.messageId);
    assert.equal((await press(tg, 5602, first, "Развей 1")).text, "Кнопка устарела");
    await tg.quiet(300);
    assert.equal(or.chatRequests().length, requests);
    assert.ok(tg.sent("editMessageReplyMarkup").some((params) => Number(params.message_id) === first.messageId));
  });
});

test("в группе кнопкой пользуется только автор запроса; после /logout кнопка не работает, после нового входа — устарела", async () => {
  await withApp({ env: IDEAS }, async ({ tg, or, app }) => {
    or.chat = () => reply(IDEA_LIST);
    await say(tg, -100601, "идеи для группы", { chatType: "supergroup", fromId: 5603, firstName: "Аня" });

    const keyboard = lastKeyboard(tg);
    const requests = or.chatRequests().length;

    assert.equal((await press(tg, -100601, keyboard, "Развей 1", { fromId: 5604, chatType: "supergroup" })).text, "Эта кнопка для того, кто задал вопрос.");
    await tg.quiet(300);
    assert.equal(or.chatRequests().length, requests);

    await say(tg, 5603, "/logout");
    assert.match((await press(tg, -100601, keyboard, "Развей 1", { fromId: 5603, chatType: "supergroup" })).text, /Сначала войди/);
    await app.authenticate(5603);
    assert.equal((await press(tg, -100601, keyboard, "Развей 1", { fromId: 5603, chatType: "supergroup" })).text, "Кнопка устарела");
    await tg.quiet(300);
    assert.equal(or.chatRequests().length, requests, "ни одного запроса к модели");
  });
});

test("кнопки карточки искры: «🔁 Поворот» меняет только поворот и сохраняет приём; «➕ Для кого» — у искры без аудитории", async () => {
  await withApp({ env: IDEAS }, async ({ tg, or }) => {
    or.chat = () => reply("идеи по искре");

    const [card] = await say(tg, 5605, "/spark конкретнее", { count: 2 });
    const keyboard = lastKeyboard(tg);

    assert.equal(keyboard.text, card);
    assert.deepEqual(keyboard.buttons.map((button) => button.text), ["🔁 Ограничение", "🔁 Поворот", "🔁 Для кого", "🌿 Проще", "🎯 Конкретнее"]);

    const { texts: [next, ideas] } = await pressAndWait(tg, 5605, keyboard, "🔁 Поворот", 2);
    const [before, after] = [cardSpark(card), cardSpark(next)];

    assert.equal(ideas, "идеи по искре");
    assert.deepEqual({ ...after, twist: undefined }, { ...before, twist: undefined }, "остальное с прежней карточки");
    assert.notEqual(after.twist, before.twist);
    assert.equal(next.match(/\nПриём «.+»: .+/)[0], card.match(/\nПриём «.+»: .+/)[0], "приём прежний");
    assert.ok(userTurnOf(or).includes(`Поворот: ${after.twist}`), "модель получила новую искру");
    assert.equal((await press(tg, 5605, keyboard, "🔁 Поворот")).text, "Кнопка устарела", "кнопки старой карточки погасли");

    await say(tg, 5605, "/spark проще", { count: 2 });
    assert.deepEqual(lastKeyboard(tg).buttons.map((button) => button.text), ["🔁 Поворот", "➕ Для кого", "🌿 Проще", "🎯 Конкретнее"]);

    const { texts: [grown] } = await pressAndWait(tg, 5605, lastKeyboard(tg), "➕ Для кого", 2);

    assert.deepEqual(Object.keys(cardSpark(grown)), ["domain", "twist", "audience"]);
  });
});

test("искра уже не последняя (модель бросила новую): нажатие — всплывающее сообщение и ни одного запроса к модели", async () => {
  await withApp({ env: IDEAS }, async ({ tg, or }) => {
    or.chat = () => reply("идеи");
    await say(tg, 5606, "/spark", { count: 2 });

    const keyboard = lastKeyboard(tg);

    callsThen(or, [["idea_spark", {}]], "новая искра от модели");
    await say(tg, 5606, "удиви меня");

    const requests = or.chatRequests().length;
    const sent = tg.texts().length;

    assert.equal((await press(tg, 5606, keyboard, "🎯 Конкретнее")).text, "Эта искра уже не последняя");
    await tg.quiet(400);
    assert.deepEqual([or.chatRequests().length, tg.texts().length], [requests, sent]);
  });
});
