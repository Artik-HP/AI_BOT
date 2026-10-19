const { execute } = require("./engine");
const { registry } = require("./registry");
const { getStore } = require("./store");
const {
  splitTelegramMessage,
  claimIncomingMessage,
  enqueueChatTask,
  invalidateInteractiveQuestions,
} = require("../services/telegram");
const CONFIG = require("../config");
function context(msg, store = getStore()) {
  return {
    scope: `t:${msg.chat.id}:${msg.from.id}`,
    transport: "telegram",
    chatId: msg.chat.id,
    userId: msg.from.id,
    msg,
    store,
  };
}
async function deliver(bot, ctx, response) {
  if (response.delivered) return;
  const buttons = [...(response.buttons || [])];
  if (
    ctx.transport === "telegram" &&
    !["lock", "start"].includes(ctx.commandId) &&
    !buttons.some((b) => b.command === "cancel")
  )
    buttons.push({ label: "✕ Отмена", command: "cancel", args: "" });
  if (!buttons.some((b) => b.command === "menu" && !b.args))
    buttons.push({ label: "🏠 Главное меню", command: "menu", args: "" });
  const ids = [];
  const rows = buttons.map((b) => {
    const id = ctx.store.action(ctx.scope, 0, {
      command: b.command,
      args: b.args,
    });
    ids.push(id);
    return [
      {
        text: Array.from(b.label).slice(0, 50).join(""),
        callback_data: "cmd:" + id,
      },
    ];
  });
  for (const link of response.links || [])
    rows.push([{ text: link.label, url: link.url }]);
  let sent;
  const chunks = splitTelegramMessage(response.text);
  for (const [index, chunk] of chunks.entries()) {
    const options =
      index === chunks.length - 1
        ? { reply_markup: { inline_keyboard: rows } }
        : {};
    const canEdit =
      ctx.messageId && chunks.length === 1 && ctx.commandId !== "start";
    if (canEdit) {
      try {
        sent = await bot.editMessageText(chunk, {
          chat_id: ctx.chatId,
          message_id: ctx.messageId,
          ...options,
        });
        if (!sent?.message_id) sent = { message_id: ctx.messageId };
      } catch {
        sent = await bot.sendMessage(ctx.chatId, chunk, options);
      }
    } else
      sent = await bot.sendMessage(
        ctx.chatId,
        chunk,
        index === chunks.length - 1
          ? { reply_markup: { inline_keyboard: rows } }
          : {},
      );
  }
  if (response.download)
    await bot.sendDocument(
      ctx.chatId,
      Buffer.from(
        require("../services/personalData").exportData(ctx.scope, ctx.store),
      ),
      { caption: "Твои данные в JSON" },
      { filename: "orbit-personal-data.json", contentType: "application/json" },
    );
  if (sent)
    ctx.store.transaction(() => {
      for (const id of ids)
        ctx.store.db
          .prepare("UPDATE actions SET message=? WHERE id=?")
          .run(String(sent.message_id), id);
    });
  if (response.image)
    await bot.sendPhoto(
      ctx.chatId,
      Buffer.from(response.image.split(",")[1], "base64"),
      { caption: "QR-код" },
      { filename: "qr.png", contentType: "image/png" },
    );
}
async function runMessage(bot, msg, id, args, requestId) {
  const access = require("../services/access");
  if (id === "start" && access.getAccessGate().enabled) {
    const login = access.getAccessGate().login(msg, args);
    if (args)
      await bot.deleteMessage?.(msg.chat.id, msg.message_id).catch(() => {});
    await bot.sendMessage(msg.chat.id, login.text);
    if (!login.ok) return { text: login.text, error: true };
    args = "";
  } else if (!(await access.guardMessage(bot, msg)))
    return { text: access.LOCKED_TEXT, error: true };
  const ctx = context(msg);
  ctx.commandId = id;
  ctx.messageId = msg.callbackMessageId;
  await invalidateInteractiveQuestions(ctx.chatId).catch(() => {});
  if (id === "start")
    await bot.sendMessage(
      ctx.chatId,
      `✦ ${CONFIG.PRODUCT_NAME}\n${CONFIG.PRODUCT_TAGLINE}\n\nВыбирай инструменты, учись, играй или просто напиши вопрос.`,
      {
        reply_markup: {
          keyboard: [
            [{ text: "🏠 Меню" }, { text: "⭐ Избранное" }],
            [{ text: "🕘 Недавние" }, { text: "🔎 Поиск" }],
            [{ text: "🌐 ВЕБ-ИНТЕРФЕЙС" }, { text: "⚙ Настройки" }],
            [{ text: "✕ Отмена" }, { text: "🔒 Заблокировать" }],
          ],
          resize_keyboard: true,
          is_persistent: true,
        },
      },
    );
  await bot.sendChatAction?.(ctx.chatId, "typing").catch(() => {});
  const response = await execute(ctx, id, { args }, requestId);
  await deliver(bot, ctx, response);
  return response;
}
async function handleCommandInput(bot, msg) {
  if (msg.from?.is_bot || !msg.text || msg.text.startsWith("/")) return false;
  const ctx = context(msg),
    text = msg.text.trim();
  const labels = {
    "🏠 Меню": "menu",
    Меню: "menu",
    "⭐ Избранное": "favorites",
    "🕘 Недавние": "recent",
    "🔎 Поиск": "search",
    Помощь: "help",
    Статус: "status",
    Голосовые: "voice",
    "Очистить память": "reset",
    "🌐 ВЕБ-ИНТЕРФЕЙС": "web",
    "⚙ Настройки": "settings",
    "✕ Отмена": "cancel",
    "🔒 Заблокировать": "lock",
  };
  const id = labels[text],
    prompt = ctx.store.get(ctx.scope + ":prompt", null);
  if (!id && !prompt) return false;
  await runMessage(
    bot,
    msg,
    id || prompt.command,
    id ? "" : text,
    `tg:${msg.chat.id}:${msg.message_id}`,
  );
  return true;
}
function registerTelegram(bot) {
  if (bot.__commandSystem) return;
  bot.__commandSystem = true;
  const all = [...registry.values()]
    .filter((c) => c.availability.telegram && !c.hidden)
    .slice(0, 100)
    .map((c) => ({ command: c.id, description: c.description.slice(0, 256) }));
  for(const [alias,target] of Object.entries(require('./aliases').aliases))all.push({command:alias,description:registry.get(target.id).description});
  bot
    .setMyCommands(
      all.filter(
        (c) =>
          !c.command.startsWith("account_") && !c.command.startsWith("bot_"),
      ),
    )
    .catch((e) => console.error("Telegram command setup:", e.code || e.name));
  if (CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID)
    bot
      .setMyCommands(all, {
        scope: {
          type: "chat",
          chat_id: CONFIG.ACCOUNT_ASSISTANT_OWNER_CHAT_ID,
        },
      })
      .catch((e) => console.error("Owner command setup:", e.code || e.name));
  bot.onText(
    /^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i,
    async (msg, match) => {
      if (msg.from?.is_bot) return;
      try {
        const identity = require("../services/telegram").getBotToBotStatus()
          .username;
        if (match[2] && (!identity || match[2].toLowerCase() !== identity))
          return;
        if (!claimIncomingMessage(msg)) return;
        await enqueueChatTask(msg.chat.id, () =>
          runMessage(
            bot,
            msg,
            match[1].toLowerCase(),
            (match[3] || "").trim(),
            `tg:${msg.chat.id}:${msg.message_id}`,
          ),
        );
      } catch (error) {
        console.error("Telegram command delivery:", error.code || error.name);
        await bot
          .sendMessage(
            msg.chat.id,
            "Не удалось обработать команду или отправить результат. Попробуй ещё раз.",
          )
          .catch(() => {});
      }
    },
  );
  bot.on("callback_query", async (query) => {
    if (!query.data?.startsWith("cmd:")) return;
    if (!(await require("../services/access").guardCallback(bot, query)))
      return;
    const msg = {
      chat: query.message?.chat,
      from: query.from,
      message_id: query.message?.message_id,
      callbackMessageId: query.message?.message_id,
    };
    if (!msg.chat || !msg.from) return;
    await bot
      .answerCallbackQuery(query.id, { text: "Обрабатываю…" })
      .catch(() => {});
    try {
      const ctx = context(msg);
      const action = ctx.store.takeAction(
        ctx.scope,
        msg.message_id,
        query.data.slice(4),
      );
      await enqueueChatTask(msg.chat.id, () =>
        runMessage(bot, msg, action.command, action.args, "cb:" + query.id),
      );
    } catch (error) {
      console.error("Command button:", error.code || error.name);
      await bot
        .sendMessage(
          msg.chat.id,
          "Кнопка уже использована, устарела или принадлежит другому пользователю. Открой /menu.",
        )
        .catch(() => {});
    }
  });
}
module.exports = {
  context,
  registerTelegram,
  handleCommandInput,
  deliver,
  runMessage,
};
