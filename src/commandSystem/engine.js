const crypto = require("node:crypto");
const { registry, accessible, profile } = require("./registry");
const { getStore } = require("./store");
const queues = new Map();
function enqueue(scope, fn) {
  const previous = queues.get(scope) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(fn)
    .finally(() => {
      if (queues.get(scope) === next) queues.delete(scope);
    });
  queues.set(scope, next);
  return next;
}
function validateInput(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => k !== "args") ||
    typeof input.args !== "string" ||
    input.args.length > 16000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.args)
  )
    throw new Error("Ожидается объект {args: текст}, максимум 16000 символов.");
  return input.args.trim();
}
function validateResult(value, context) {
  if (
    value.links &&
    (!Array.isArray(value.links) ||
      value.links.length > 2 ||
      value.links.some(
        (link) =>
          typeof link.label !== "string" ||
          link.label.length > 60 ||
          link.url !== require("../config").WEB_PUBLIC_URL ||
          !/^https:\/\//.test(link.url),
      ))
  )
    throw new Error("Invalid navigation link");
  if (value.download && value.download !== "personal-data")
    throw new Error("Invalid download");
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.text !== "string" ||
    value.text.length > 64000 ||
    (!value.text && !value.delivered)
  )
    throw new Error("Invalid command result");
  if (
    value.image &&
    (typeof value.image !== "string" ||
      !value.image.startsWith("data:image/png;base64,") ||
      value.image.length > 2 * 1024 * 1024)
  )
    throw new Error("Invalid image");
  if (
    value.buttons &&
    (!Array.isArray(value.buttons) ||
      value.buttons.length > 100 ||
      value.buttons.some(
        (b) =>
          typeof b.label !== "string" ||
          !b.label ||
          b.label.length > 200 ||
          !registry.has(b.command) ||
          !accessible(registry.get(b.command), context) ||
          typeof b.args !== "string" ||
          b.args.length > 16000,
      ))
  )
    throw new Error("Invalid command actions");
  if (
    value.input &&
    (!registry.has(value.input.command) ||
      !accessible(registry.get(value.input.command), context) ||
      typeof value.input.placeholder !== "string")
  )
    throw new Error("Invalid input prompt");
  return {
    text: value.text,
    ...(value.links ? { links: value.links } : {}),
    ...(value.download ? { download: value.download } : {}),
    ...(value.buttons ? { buttons: value.buttons } : {}),
    ...(value.input ? { input: value.input } : {}),
    ...(value.image ? { image: value.image } : {}),
    ...(value.delivered ? { delivered: true } : {}),
    ...(value.error ? { error: true } : {}),
  };
}
function friendly(error) {
  if (error.userError) return error.message;
  if (error.response?.status === 401 || error.response?.status === 403)
    return "Внешний сервис отклонил доступ. Проверь API-ключ и права доступа.";
  if (error.response?.status === 429)
    return "Лимит внешнего сервиса исчерпан. Повтори запрос позже.";
  if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT")
    return "Сервис не ответил вовремя. Повтори запрос позже.";
  return "Команда не выполнена. Проверь подключение, настройки сервиса и повтори запрос. Данные операции не скрываются за выдуманным ответом.";
}
async function execute(
  context,
  id,
  input = { args: "" },
  requestId = crypto.randomUUID(),
) {
  if (typeof input?.args === "string") {
    const resolved = require("./aliases").resolve(id, input.args);
    id = resolved.id;
    input = { ...input, args: resolved.args };
  }
  context = { ...context, store: context.store || getStore() };
  if (
    context.transport === "telegram" &&
    !require("../services/access").getAccessGate().authorized(context.msg)
  )
    return { text: require("../services/access").LOCKED_TEXT, error: true };
  require("../services/personalData").ensureHistory(context);
  if (
    !/^[A-Za-z0-9:_-]{1,100}$/.test(requestId) ||
    !context.scope ||
    context.scope.length > 150
  )
    return {
      text: "Некорректная сессия или идентификатор запроса.",
      error: true,
    };
  const command = registry.get(id);
  if (!command || !accessible(command, context))
    return {
      text: "Команда не найдена или недоступна в этой сессии. Открой /help.",
      error: true,
    };
  let args;
  try {
    args = validateInput(input);
  } catch (error) {
    return { text: error.message, error: true };
  }
  return enqueue(context.scope, async () => {
    const previous = context.store.claim(context.scope, requestId);
    if (previous)
      return (
        previous.result || {
          text: "Этот запрос уже обрабатывался. После сбоя запусти команду заново; отправка автоматически не повторяется.",
          error: true,
        }
      );
    const started = Date.now();
    let response;
    try {
      if (id !== "select")
        context.store.set(context.scope + ":selection", null);
      response = validateResult(
        await command.handler(context, args, command),
        context,
      );
      if (
        !command.hidden &&
        ![
          "menu",
          "start",
          "help",
          "favorites",
          "favorite",
          "recent",
          "search",
        ].includes(id)
      )
        context.store.update(
          context.scope + ":profile",
          (p) => ({
            ...p,
            recent: [id, ...p.recent.filter((v) => v !== id)].slice(0, 20),
          }),
          { favorites: [], recent: [] },
        );
      if (!response.error)
        context.store.set(context.scope + ":prompt", response.input || null);
    } catch (error) {
      response = { text: friendly(error), error: true };
      console.error(
        JSON.stringify({
          event: "command_error",
          command: id,
          code: error.code || error.response?.status || error.name,
        }),
      );
    }
    context.store.finish(
      context.scope,
      requestId,
      id === "password"
        ? {
            text: "Пароль уже был сгенерирован. Запусти новую команду, чтобы создать другой.",
          }
        : response,
    );
    require("../services/diagnostics").record(
      context.scope,
      "command",
      id,
      !response.error,
      Date.now() - started,
      response.error ? "COMMAND_ERROR" : "",
    );
    console.log(
      JSON.stringify({
        event: "command_result",
        command: id,
        ok: !response.error,
        durationMs: Date.now() - started,
      }),
    );
    return response;
  });
}
async function tickReminders(store = getStore(), bot, now = Date.now()) {
  for (const row of store.due(now, Boolean(bot))) {
    try {
      if (row.transport === "telegram") {
        const [,chatId,userId]=row.scope.split(':');
        if(!require('../services/access').getAccessGate().authorized({chat:{id:chatId,type:'private'},from:{id:userId}},false)){store.db.prepare("UPDATE reminders SET status='pending',due=?,attempts=? WHERE id=?").run(now+60000,row.attempts,row.id);continue;}
        if (!bot) throw new Error("Telegram unavailable");
        const chunks = require("../services/telegram").splitTelegramMessage(`🔔 Напоминание\n${row.text}`);
        for (let index = row.sent_chunks || 0; index < chunks.length; index++) {
          await bot.sendMessage(row.destination, chunks[index]);
          store.reminderProgress(row.id, index + 1);
        }
      }
      store.delivered(row);
    } catch (error) {
      store.retry(row);
      console.error(
        JSON.stringify({
          event: "reminder_delivery_error",
          code: error.code || error.name,
        }),
      );
    }
  }
}
function startScheduler(store, bot) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await tickReminders(store, bot);
      store.prune();
    } catch (error) {
      console.error("Scheduler unavailable:", error.code || error.name);
    } finally {
      busy = false;
    }
  };
  const interval = setInterval(tick, 1000);
  interval.unref();
  tick();
  return () => clearInterval(interval);
}
module.exports = {
  execute,
  validateInput,
  validateResult,
  enqueue,
  tickReminders,
  startScheduler,
  registry,
  profile,
};
