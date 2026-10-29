const crypto = require("crypto");
const CONFIG = require("./config");
const { auth } = require("./services/auth");
const { getDatabase } = require("./database");
const { isOwner } = require("./services/access");
const { admitMessage, admitCallback, messageAuthorized } = require("./handlers/guard");
const { isAddressedToThisBot } = require("./services/telegram");
const { safeHandler } = require("./utils/safe");

function registerAccounts(bot) {
  const confirmations = new Map();
  async function run(chatId, task) {
    try {
      const db = getDatabase();
      if (!db) { await bot.sendMessage(chatId, "PostgreSQL ещё не подключена. Учёт пользователей появится после настройки базы."); return; }
      await task(db);
    } catch { await bot.sendMessage(chatId, "Учёт пользователей недоступен. Администратору нужно проверить подключение и миграции PostgreSQL."); }
  }
  bot.onText(/^\/(me|users|access)(?:@\w+)?(?:\s|$)/i, safeHandler("Product accounts command", async (msg, match) => {
    if (msg.from?.is_bot || !isAddressedToThisBot(msg.text)) return;
    const command = match[1].toLowerCase();
    if (command !== "me" && (!isOwner(msg.from?.id) || String(msg.chat.id) !== String(msg.from?.id))) return;
    if (!await admitMessage(bot, msg)) return;
    await run(msg.chat.id, async (db) => {
      if (command === "me") {
        const allowed = await db.allowed(msg.from.id);
        if (!messageAuthorized(msg)) return;
        await bot.sendMessage(msg.chat.id, `Мой доступ: ${allowed ? "активен" : "отключён или истёк"}.\nСессия ограничена по времени. /logout — выйти.`);
      } else if (command === "users") {
        const users = await db.users();
        if (!messageAuthorized(msg)) return;
        await bot.sendMessage(msg.chat.id, "Пользователи (последние 30):\n" + (users.map((user) =>
          `${user.telegram_id}: ${user.status}; до ${user.access_until ? new Date(user.access_until).toISOString() : "без срока"}`).join("\n") || "Пока нет пользователей."));
      } else {
        const args = msg.text.match(/^\/access(?:@\w+)?\s+(\d{1,18})\s+(active|blocked)(?:\s+(\d{1,3}))?\s*$/i);
        if (!args || args[3] && (Number(args[3]) < 1 || Number(args[3]) > 365)) {
          await bot.sendMessage(msg.chat.id, "Формат: /access ID active|blocked [дни от 1 до 365]. Сначала будет показано подтверждение."); return;
        }
        if (args[1] === String(msg.from.id)) { await bot.sendMessage(msg.chat.id, "Свой доступ этой командой изменять нельзя."); return; }
        const token = crypto.randomBytes(16).toString("hex");
        for (const [key, value] of confirmations) if (value.expires < Date.now()) confirmations.delete(key);
        if (confirmations.size >= 100) throw new Error("CONFIRMATION_LIMIT");
        const until = args[3] ? new Date(Date.now() + Number(args[3]) * 86400000).toISOString() : null;
        const sent = await bot.sendMessage(msg.chat.id, `Изменить доступ пользователя ${args[1]}: ${args[2]}, срок ${until || "без ограничения"}?`,
          { reply_markup: { inline_keyboard: [[{ text: "Подтвердить изменение доступа", callback_data: `access:${token}` }]] } });
        confirmations.set(token, { actor: String(msg.from.id), userId: args[1], status: args[2].toLowerCase(), until,
          messageId: sent.message_id, lease: auth.capture(msg.from.id), expires: Date.now() + 5 * 60000 });
      }
    });
  }));
  bot.on("callback_query", safeHandler("Product access callback", async (query) => {
    if (!query.data?.startsWith("access:")) return;
    if (!await admitCallback(bot, query)) return;
    const token = query.data.slice(7);
    const item = confirmations.get(token);
    if (!item || !isOwner(query.from?.id) || item.actor !== String(query.from.id) || String(query.message?.chat?.id) !== item.actor ||
      query.message.message_id !== item.messageId || item.expires < Date.now() || !auth.valid(item.lease)) {
      await bot.answerCallbackQuery(query.id, { text: "Подтверждение недоступно или истекло." }).catch(() => {}); return;
    }
    confirmations.delete(token);
    await bot.answerCallbackQuery(query.id).catch(() => {});
    await run(query.message.chat.id, async (db) => {
      await db.setAccess(item.actor, item.userId, item.status, item.until);
      auth.logout(item.userId);
      if (auth.valid(item.lease)) await bot.sendMessage(query.message.chat.id, "Доступ обновлён. Старая сессия пользователя закрыта; следующий вход проверит новый статус.");
    });
  }));
  return { close: async () => { if (CONFIG.DATABASE_URL) await getDatabase()?.close(); } };
}

module.exports = { registerAccounts };
