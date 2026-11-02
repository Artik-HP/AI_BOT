const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { withApp } = require("../helpers/app");
const { TEST_OPENROUTER_KEY } = require("../helpers/fakeOpenRouter");
const { emptyData } = require("../../src/companion/store");
const { IDEAS, say } = require("../helpers/ideasChat");

const ME = 5501;
const OTHER = 5502;
const GROUP = -100700;
const NOW = Date.now();

function idea(id, title, extra = {}) {
  return { id, title, pitch: `Суть идеи «${title}».`, tags: [], next: "", status: "new", createdAt: NOW, updatedAt: NOW, ...extra };
}

// The person keeps ideas in the private chat and in a group, a fact and a reminder; someone else keeps their own.
function seededStore() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aibot-export-")), "store.json");
  const reminder = (id, chatId, userId, text) => ({ id, chatId: String(chatId), userId: String(userId), name: "", group: chatId < 0, text, dueAt: NOW + 86400000, createdAt: NOW, tries: 0 });

  fs.writeFileSync(file, JSON.stringify({
    ...emptyData(),
    ideas: {
      [`${ME}:${ME}`]: [idea("00000001", "Кофейня-библиотека", { next: "Поговорить с хозяином", tags: ["кофе"] }), idea("00000002", "Ключ в тексте", { pitch: `Случайно вставил ${TEST_OPENROUTER_KEY} в идею.` })],
      [`${GROUP}:${ME}`]: [idea("00000003", "Идея из группы")],
      [`${OTHER}:${OTHER}`]: [idea("00000004", "Чужая личная идея")],
      [`${GROUP}:${OTHER}`]: [idea("00000005", "Чужая идея в группе")]
    },
    facts: { [`${ME}:${ME}`]: [{ text: "Любит кофе", at: NOW }], [`${OTHER}:${OTHER}`]: [{ text: "Чужой факт", at: NOW }] },
    reminders: [reminder("aaaaaaa1", ME, ME, "позвонить в кофейню"), reminder("aaaaaaa2", OTHER, OTHER, "чужое напоминание")]
  }));
  return file;
}

async function documentFrom(tg, send) {
  const before = tg.sent("sendDocument").length;

  send();
  await tg.waitFor(() => tg.sent("sendDocument").length > before, 8000, "файл");
  return tg.sent("sendDocument").at(-1).document;
}

test("L3: /export — один JSON с идеями всех чатов, фактами, напоминаниями; без чужих данных, переписки и ключа", async () => {
  await withApp({ env: { ...IDEAS, COMPANION_FILE: seededStore() } }, async ({ tg, or }) => {
    const document = await documentFrom(tg, () => tg.message({ chatId: ME, text: "/export" }));
    const content = JSON.parse(document.content);

    assert.match(document.filename, /^my-data-\d{4}-\d{2}-\d{2}\.json$/);
    assert.deepEqual(Object.keys(content.ideaBank).sort(), [String(GROUP), String(ME)]);
    assert.deepEqual(content.ideaBank[String(ME)].map((entry) => entry.title).sort(), ["Ключ в тексте", "Кофейня-библиотека"]);
    assert.equal(content.ideaBank[String(GROUP)][0].title, "Идея из группы");
    assert.deepEqual(content.facts, { [String(ME)]: [{ text: "Любит кофе", saved: new Date(NOW).toISOString().slice(0, 10) }] });
    assert.deepEqual(content.reminders.map((item) => item.text), ["позвонить в кофейню"]);
    assert.equal(content.userId, String(ME));
    assert.equal(content.lab, undefined, "лабораторию не открывали — раздела нет");
    assert.ok(!document.content.includes("Чужая") && !document.content.includes("Чужой") && !document.content.includes("чужое"), "чужих данных нет");
    assert.ok(!document.content.includes(TEST_OPENROUTER_KEY), "ключ из конфигурации замаскирован");
    assert.match(content.ideaBank[String(ME)].find((entry) => entry.title === "Ключ в тексте").pitch, /\*\*\*/);
    assert.equal(or.chatRequests().length, 0, "без AI");
  });
});

test("L3: /export в группе — подсказка открыть личный диалог, файла нет", async () => {
  await withApp({ env: IDEAS }, async ({ tg }) => {
    const [hint] = await say(tg, GROUP, "/export", { chatType: "supergroup", fromId: ME });

    assert.match(hint, /в личном диалоге/);
    assert.equal(tg.sent("sendDocument").length, 0);
  });
});

test("L3: /ideas export — банк этого чата в Markdown; идеи других чатов и людей не попадают; пустой банк — текст", async () => {
  await withApp({ env: { ...IDEAS, COMPANION_FILE: seededStore() } }, async ({ tg }) => {
    const document = await documentFrom(tg, () => tg.message({ chatId: ME, text: "/ideas export" }));

    assert.match(document.filename, /^ideas-\d{4}-\d{2}-\d{2}\.md$/);
    assert.match(document.content, /^# Банк идей\n\nВыгружено: \d{4}-\d{2}-\d{2}\. Идей: 2\.\n/);
    assert.match(document.content, /\n## Кофейня-библиотека\n\n- Статус: новая\n- Код: 00000001\n- Сохранена: \d{4}-\d{2}-\d{2}\n\nСуть идеи «Кофейня-библиотека»\.\n\nШаг: Поговорить с хозяином\n\nТеги: #кофе\n/);
    assert.ok(!document.content.includes("Идея из группы") && !document.content.includes("Чужая"), "только этот чат и этот человек");
    assert.ok(!document.content.includes(TEST_OPENROUTER_KEY));

    const groupFile = await documentFrom(tg, () => tg.message({ chatId: GROUP, fromId: ME, chatType: "supergroup", text: "/ideas export" }));

    assert.match(groupFile.content, /Идей: 1\./);
    assert.ok(groupFile.content.includes("Идея из группы") && !groupFile.content.includes("Чужая идея в группе"));
    assert.match((await say(tg, 5503, "/ideas export"))[0], /^В банке пока пусто/);
  });
});
