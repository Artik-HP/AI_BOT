const crypto = require("node:crypto");
const { getStore } = require("../commandSystem/store");
const {
  getPreferences,
  savePreferences,
  threadKey,
  userError,
} = require("./preferences");
function ensureHistory(context) {
  if (
    context.transport !== "telegram" ||
    context.msg?.chat?.type !== "private" ||
    String(context.chatId) !== String(context.userId) ||
    context.store.get(context.scope + ":migrated", false)
  )
    return;
  const memory = require("./memory"),
    legacy = memory.getUserMemory(context.chatId),
    current = memory.getUserMemory(context.scope);
  if (!current.messages.length && legacy.messages.length) {
    Object.assign(current, structuredClone(legacy));
    memory.saveMemory();
  }
  context.store.set(context.scope + ":migrated", true);
}
function threads(scope, store = getStore()) {
  return store.get(scope + ":threads", [
    {
      id: "main",
      title: "Основной диалог",
      createdAt: new Date().toISOString(),
    },
  ]);
}
function newThread(scope, title, store = getStore()) {
  if (typeof title !== "string" || !title.trim() || title.length > 80)
    throw userError("Название диалога: от 1 до 80 символов.");
  const all = threads(scope, store);
  if (all.length >= 30) throw userError("Лимит: 30 диалогов.");
  const record = {
    id: crypto.randomBytes(6).toString("hex"),
    title: title.trim(),
    createdAt: new Date().toISOString(),
  };
  store.set(scope + ":threads", [...all, record]);
  savePreferences(scope, { activeThread: record.id }, store);
  return record;
}
function useThread(scope, id, store = getStore()) {
  if (!threads(scope, store).some((t) => t.id === id))
    throw userError("Диалог не найден в твоей истории.");
  savePreferences(scope, { activeThread: id }, store);
}
function history(scope, query = "", store = getStore()) {
  const memory = require("./memory");
  return threads(scope, store).map((t) => ({
    ...t,
    messages: memory
      .getUserMemory(t.id === "main" ? scope : `${scope}:thread:${t.id}`)
      .messages.filter(
        (m) => !query || m.content.toLowerCase().includes(query.toLowerCase()),
      ),
  }));
}
function clearCurrent(scope, store = getStore()) {
  require("./memory").resetMemory(
    threadKey(scope, getPreferences(scope, store)),
  );
  store.set(scope + ":aiQuestion", null);
  store.set(scope + ":selection", null);
}
function exportData(scope, store = getStore()) {
  return JSON.stringify(
    {
      version: 1,
      exportedAt: new Date().toISOString(),
      preferences: getPreferences(scope, store),
      conversations: history(scope, "", store),
      notes: store.get(scope + ":notes", []),
      tasks: store.get(scope + ":todo", []),
      habits: store.get(scope + ":habits", []),
      flashcards: store.get(scope + ":flashcards", []),
      reminders: store.reminders(scope),
      notifications: store.inbox(scope),
    },
    null,
    2,
  );
}
function deleteData(scope, store = getStore()) {
  const memory = require("./memory");
  for (const t of threads(scope, store))
    memory.resetMemory(t.id === "main" ? scope : `${scope}:thread:${t.id}`);
  const imported=[scope,...threads(scope,store).filter(t=>t.id!=='main').map(t=>`${scope}:thread:${t.id}`)];
  const privateMatch=scope.match(/^t:(\d+):\1$/);if(privateMatch)imported.push(privateMatch[1]);
  memory.purgeImportedScopes(imported);
  store.transaction(() => {
    store.db
      .prepare("DELETE FROM state WHERE scope=? OR substr(scope,1,?)=?")
      .run(scope, scope.length + 1, scope + ":");
    for (const table of ["requests", "actions", "reminders", "inbox", "events"])
      store.db.prepare(`DELETE FROM ${table} WHERE scope=?`).run(scope);
  });
}
module.exports = {
  threads,
  newThread,
  useThread,
  history,
  clearCurrent,
  exportData,
  deleteData,
  ensureHistory,
};
