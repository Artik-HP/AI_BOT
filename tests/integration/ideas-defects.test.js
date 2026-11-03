const test = require("node:test");
const assert = require("node:assert/strict");
const { withApp } = require("../helpers/app");
const { failure, reply } = require("../helpers/fakeOpenRouter");
const { SPARK_LABELS } = require("../../src/ideas/catalog");
const { IDEAS, toolCalls, toolResults, lastMessage, callsThen, say } = require("../helpers/ideasChat");

const LABEL_KEYS = Object.fromEntries(Object.entries(SPARK_LABELS).map(([key, label]) => [label, key]));

// The ingredients of a spark card ("Область: …" lines up to the empty line), keyed like the spark object.
function cardSpark(card) {
  const lines = card.split("\n").slice(1);

  return Object.fromEntries(lines.slice(0, lines.indexOf("")).map((line) => {
    const [label, ...value] = line.split(": ");

    return [LABEL_KEYS[label], value.join(": ")];
  }));
}

const SECRET_IDEA = { title: "Доступ к почте", pitch: "password: hunter2secret" };
const GOOD_IDEA = { title: "Кофейня-библиотека", pitch: "Читаешь книгу — платишь меньше за кофе." };

test("D1: функция отказала, модель промолчала — человек читает честную фразу, а не «Готово.»", async () => {
  await withApp({ env: IDEAS }, async ({ tg, or }) => {
    callsThen(or, [["idea_save", SECRET_IDEA]], "");
    assert.deepEqual(await say(tg, 5201, "сохрани доступ"), ["Не получилось: это похоже на пароль, ключ или номер карты, такое я не сохраняю."]);

    callsThen(or, [["idea_save", GOOD_IDEA]], "");
    assert.deepEqual(await say(tg, 5201, "сохрани кофейню"), ["Готово."], "успешный вызов и пустой текст — как раньше");

    // The model fixed its own mistake: the later successful call of the same function cancels the refusal.
    or.chat = (record) => {
      const rounds = record.body.messages.filter((message) => message.role === "tool").length;

      if (rounds === 0) return toolCalls(["idea_save", SECRET_IDEA]);
      return rounds === 1 ? toolCalls(["idea_save", { ...GOOD_IDEA, title: "Почта без паролей" }]) : reply("");
    };
    assert.deepEqual(await say(tg, 5201, "сохрани ещё раз"), ["Готово."]);

    callsThen(or, [["idea_save", { ...GOOD_IDEA, title: "Третья" }], ["memory_save", { text: "мой пароль 123456" }]], "");
    assert.deepEqual(await say(tg, 5201, "сохрани и запомни"), ["Сделано не всё: это похоже на пароль, ключ или номер карты, такое я не сохраняю."]);

    callsThen(or, [["idea_update", { id: "deadbeef", status: "done" }]], "");
    assert.deepEqual(await say(tg, 5201, "отметь готовой"), ["Действие не выполнилось. Попробуй ещё раз или скажи иначе."]);
  });
});

test("D5: карточка искры встаёт в очередь чата — при медленной модели порядок «карточка 1, идеи 1, карточка 2, идеи 2»", async () => {
  await withApp({ env: IDEAS }, async ({ tg, or }) => {
    let answered = 0;

    or.chat = () => {
      answered += 1;
      return answered === 1 ? { ...reply("идеи 1"), delayMs: 900 } : reply(`идеи ${answered}`);
    };

    const before = tg.texts().length;

    tg.message({ chatId: 5202, text: "🎲 Искра" });
    tg.message({ chatId: 5202, text: "🎲 Искра" });
    await tg.waitFor(() => tg.texts().length >= before + 4, 10000, "две карточки и два ответа");
    await tg.quiet(150);

    const texts = tg.texts().slice(before);

    assert.match(texts[0], /^🎲 Искра\n/);
    assert.equal(texts[1], "идеи 1", JSON.stringify(texts));
    assert.match(texts[2], /^🎲 Искра\n/);
    assert.equal(texts[3], "идеи 2");
    assert.match(or.chatRequests()[1].body.messages.at(-1).content, new RegExp(Object.entries(cardSpark(texts[2]))
      .map(([key, value]) => `${SPARK_LABELS[key]}: ${value}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\n")), "второй запрос — о второй карточке");

    // "Change the twist" now refers to the card the person saw last: card 2.
    or.chat = (record) => (lastMessage(record).role === "tool" ? reply(JSON.stringify(toolResults(record).at(-1))) : toolCalls(["idea_spark", { reroll: ["twist"] }]));

    const [spark] = JSON.parse((await say(tg, 5202, "поменяй поворот"))[0]).sparks;
    const shown = cardSpark(texts[2]);

    for (const [key, value] of Object.entries(shown)) {
      if (key !== "twist") assert.equal(spark[key], value, `${key} — с карточки 2`);
    }
  });
});

test("D6: подсказка «перекину только это» не обещает невозможного, пока функции модели заблокированы", async () => {
  await withApp({ env: IDEAS }, async ({ tg, or }) => {
    or.chat = (record) => (record.body.tools ? failure(400, "No endpoints found that support tool use") : reply("ок без функций"));

    assert.deepEqual(await say(tg, 5203, "привет"), ["ок без функций"]);

    const [card] = await say(tg, 5203, "/spark", { count: 2 });

    assert.match(card, /^🎲 Искра\n/);
    assert.doesNotMatch(card, /перекину только это/);
  });
});
