const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { withApp } = require("../helpers/app");
const { reply } = require("../helpers/fakeOpenRouter");
const { TEST_PASSWORD } = require("../helpers/authFixture");
const { SPARK_POOLS, TECHNIQUES } = require("../../src/ideas/catalog");
const { encodeSpark } = require("../../src/ideas/code");
const { IDEAS, lastMessage, toolCalls, toolResults, say, userTurnOf } = require("../helpers/ideasChat");

const SPARK = { domain: SPARK_POOLS.domains[3], constraint: SPARK_POOLS.constraints[4], twist: SPARK_POOLS.twists[5] };
const TECHNIQUE = TECHNIQUES[2];
const CODE = encodeSpark(SPARK, TECHNIQUE);
const CARD = `🎲 Искра\nОбласть: ${SPARK.domain}\nОграничение: ${SPARK.constraint}\nПоворот: ${SPARK.twist}\n\nПриём «${TECHNIQUE.name}»: ${TECHNIQUE.how}`;

test("/spark <код>: именно эта искра и приём, записана последней (переброс меняет её), затем идеи; неверный код — подсказка", async () => {
  await withApp({ env: IDEAS }, async ({ tg, or }) => {
    or.chat = () => reply("идеи по коду");

    const [card, ideas] = await say(tg, 5701, `/spark ${CODE}`, { count: 2 });

    assert.ok(card.startsWith(CARD), card);
    assert.equal(ideas, "идеи по коду");
    assert.ok(userTurnOf(or).includes(`Область: ${SPARK.domain}\nОграничение: ${SPARK.constraint}\nПоворот: ${SPARK.twist}`));

    or.chat = (record) => (lastMessage(record).role === "tool" ? reply(JSON.stringify(toolResults(record).at(-1))) : toolCalls(["idea_spark", { reroll: ["twist"] }]));

    const [rerolled] = JSON.parse((await say(tg, 5701, "поменяй поворот"))[0]).sparks;

    assert.deepEqual([rerolled.domain, rerolled.constraint], [SPARK.domain, SPARK.constraint], "искра из кода — последняя в истории чата");
    assert.notEqual(rerolled.twist, SPARK.twist);

    const requests = or.chatRequests().length;
    const broken = `${CODE.slice(0, 7)}${CODE[7] === "A" ? "B" : "A"}`;

    assert.deepEqual(await say(tg, 5701, `/spark ${broken}`), ["Код искры не подошёл: проверь, что он скопирован целиком. Новая искра: /spark."]);
    assert.equal(or.chatRequests().length, requests, "случайная искра вместо кода не бросается, модель не спрашивается");
  });
});

test("/start spark_<код> у вошедшего: меню, затем та же карточка и идеи", async () => {
  await withApp({ env: IDEAS }, async ({ tg, or }) => {
    or.chat = () => reply("идеи со ссылки");

    const texts = await say(tg, 5702, `/start spark_${CODE}`, { count: 4 });

    assert.match(texts[0], /^Я на месте и полон идей/);
    assert.equal(texts[1], "Панель управления:");
    assert.ok(texts[2].startsWith(CARD));
    assert.equal(texts[3], "идеи со ссылки");
  });
});

test("/start spark_<код> через вход по паролю: после входа — меню и карточка; пароль не попадает ни в модель, ни в лог, ни в историю", async () => {
  await withApp({ authenticatedFixtures: false, env: { ...IDEAS, LOG_MESSAGES: "true", MEMORY_SAVE_DEBOUNCE_MS: "10" } }, async ({ tg, or, app }) => {
    or.chat = () => reply("идеи после входа");

    assert.deepEqual(await say(tg, 5703, `/start spark_${CODE}`), ["🔐 Введите пароль для доступа к боту."]);
    assert.equal(or.chatRequests().length, 0);

    const before = tg.texts().length;
    const password = tg.message({ chatId: 5703, text: TEST_PASSWORD });

    await tg.waitFor(() => tg.texts().length >= before + 5, 10000, "вход, меню, карточка и идеи");
    await tg.quiet(200);

    const texts = tg.texts().slice(before);

    assert.match(texts[0], /^✅ Вход выполнен/);
    assert.match(texts[1], /^Я на месте и полон идей/);
    assert.ok(texts[3].startsWith(CARD), texts[3]);
    assert.equal(texts[4], "идеи после входа");
    assert.ok(tg.sent("deleteMessage").some((params) => Number(params.message_id) === password.message_id), "сообщение с паролем удалено");
    assert.ok(!JSON.stringify(or.requests).includes(TEST_PASSWORD), "пароля нет в запросе к модели");
    await tg.waitFor(() => fs.existsSync(app.memoryFile));
    assert.ok(!fs.readFileSync(app.memoryFile, "utf8").includes(TEST_PASSWORD), "пароля нет в истории");
    assert.ok(!app.output().includes(TEST_PASSWORD), "пароля нет в логе");
  });
});

test("/start spark_<код> через вход: человек не из BOT_ALLOWED_USER_IDS получает отказ доступа, а не карточку и ответ модели", async () => {
  await withApp({ authenticatedFixtures: false, env: { ...IDEAS, BOT_ALLOWED_USER_IDS: "1" } }, async ({ tg, or }) => {
    or.chat = () => reply("идеи в обход допуска");
    await say(tg, 5705, `/start spark_${CODE}`);

    const before = tg.texts().length;

    tg.message({ chatId: 5705, text: TEST_PASSWORD });
    await tg.waitFor(() => tg.texts().includes("Этот бот приватный: доступ только для приглашённых."), 10000, "отказ доступа после входа");
    await tg.quiet(300);

    assert.ok(!tg.texts().slice(before).some((text) => text.startsWith("🎲 Искра")), "карточка не отправлена");
    assert.equal(or.chatRequests().length, 0, "модель не спрашивается");
  });
});

test("/start spark_<код> через вход считается в лимит сообщений: повторный вход не даёт лишний ответ модели", async () => {
  await withApp({ authenticatedFixtures: false, env: { ...IDEAS, RATE_LIMIT_MESSAGES: "1" } }, async ({ tg, or }) => {
    or.chat = () => reply("идеи по ссылке");

    for (let round = 0; round < 2; round += 1) {
      await say(tg, 5706, `/start spark_${CODE}`);

      const before = tg.texts().length;

      tg.message({ chatId: 5706, text: TEST_PASSWORD });
      await tg.waitFor(() => tg.texts().length >= before + 4, 10000, `вход ${round + 1}`);
      await tg.quiet(300);
      if (!round) await say(tg, 5706, "/logout");
    }

    assert.equal(or.chatRequests().length, 1, "вторая искра после выхода и входа упирается в лимит");
    assert.match(tg.texts().at(-1), /^Слишком часто/);
  });
});

test("/start spark_<мусор> через вход: после входа меню и подсказка, искра не бросается и модель не спрашивается", async () => {
  await withApp({ authenticatedFixtures: false, env: IDEAS }, async ({ tg, or }) => {
    await say(tg, 5704, "/start spark_zzzz");

    const before = tg.texts().length;

    tg.message({ chatId: 5704, text: TEST_PASSWORD });
    await tg.waitFor(() => tg.texts().length >= before + 4, 10000, "вход, меню и подсказка");
    await tg.quiet(300);

    assert.equal(tg.texts().at(-1), "Код искры не подошёл: проверь, что он скопирован целиком. Новая искра: /spark.");
    assert.ok(!tg.texts().some((text) => text.startsWith("🎲 Искра")));
    assert.equal(or.chatRequests().length, 0);
  });
});
