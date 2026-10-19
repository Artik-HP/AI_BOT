const crypto = require("node:crypto");
const CONFIG = require("../config");
const { getStore } = require("../commandSystem/store");
const LOCKED_TEXT =
  "🔒 Доступ заблокирован. Для входа отправь /start и пароль в личном чате. После 10 минут бездействия потребуется повторный вход.";
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `scrypt:${salt}:${crypto.scryptSync(password, salt, 32).toString("hex")}`;
}
function verifyPassword(password, hash) {
  if (
    typeof password !== "string" ||
    password.length > 256 ||
    !/^scrypt:[a-f0-9]{32}:[a-f0-9]{64}$/.test(hash || "")
  )
    return false;
  const [, salt, digest] = hash.split(":");
  return crypto.timingSafeEqual(
    crypto.scryptSync(password, salt, 32),
    Buffer.from(digest, "hex"),
  );
}
class AccessGate {
  constructor(
    store,
    {
      hash = CONFIG.BOT_ACCESS_PASSWORD_HASH,
      idleMs = CONFIG.BOT_ACCESS_IDLE_MS,
      now = Date.now,
    } = {},
  ) {
    this.store = store;
    this.hash = hash;
    this.idleMs = idleMs;
    this.now = now;
    this.generation = crypto.randomUUID();
  }
  get enabled() {
    return Boolean(this.hash);
  }
  key(msg) {
    return `${msg?.transport==='userbot'?'u':'t'}:${msg?.chat?.id}:${msg?.from?.id}`;
  }
  authorized(msg, touch = true) {
    if (!this.enabled) return true;
    if (msg?.from?.is_bot) {
      const owner = CONFIG.BOT_TO_BOT_OWNER_CHAT_ID;
      return (
        Boolean(owner) &&
        this.authorized(
          { chat: { id: owner, type: "private" }, from: { id: owner } },
          false,
        )
      );
    }
    if (!msg?.chat?.id || !msg?.from?.id) return false;
    const key = "auth:" + this.key(msg),
      record = this.store.get(key, null);
    if (
      !record ||
      record.generation !== this.generation ||
      record.lastActive + this.idleMs <= this.now()
    )
      return false;
    if (touch) {
      record.lastActive = this.now();
      this.store.set(key, record);
    }
    return true;
  }
  login(msg, password) {
    if (
      msg?.chat?.type !== "private" ||
      msg.from?.is_bot ||
      String(msg.chat.id) !== String(msg.from?.id)
    )
      return {
        ok: false,
        text: "🔐 Вход с паролем доступен только в личном чате с ботом.",
      };
    const key = "auth-attempt:" + String(msg.from.id),
      rate = this.store.get(key, { count: 0, until: 0, started: this.now() });
    if (rate.until > this.now())
      return {
        ok: false,
        text: "Слишком много неверных попыток. Подожди минуту.",
      };
    if (this.now() - rate.started > 600000) {
      rate.count = 0;
      rate.started = this.now();
    }
    if (!verifyPassword(password, this.hash)) {
      this.lock(msg);
      rate.count++;
      if (rate.count >= 5) {
        rate.until = this.now() + 60000;
        rate.count = 0;
      }
      this.store.set(key, rate);
      return {
        ok: false,
        text: "🔒 Неверный пароль. Повтори /start с паролем.",
      };
    }
    this.store.set(key, { count: 0, until: 0, started: this.now() });
    this.store.set("auth:" + this.key(msg), {
      generation: this.generation,
      lastActive: this.now(),
    });
    return {
      ok: true,
      text: "🔓 Доступ открыт. Выбери раздел ниже. Автоблокировка — через 10 минут бездействия.",
    };
  }
  lock(msg) {
    this.store.set("auth:" + this.key(msg), null);
  }
  allowNotice(msg) {
    const key = "auth-notice:" + this.key(msg),
      last = this.store.get(key, 0);
    if (this.now() - last < 5000) return false;
    this.store.set(key, this.now());
    return true;
  }
}
let gate;
function getAccessGate() {
  if (!gate) {
    gate = new AccessGate(getStore());
    const saved = getStore().get("system:access-policy", null);
    if (saved?.hash) gate.hash = saved.hash;
    else if (gate.hash)
      getStore().set("system:access-policy", {
        hash: gate.hash,
        updatedAt: Date.now(),
      });
  }
  const current = getStore().get("system:access-policy", null);
  if (current?.hash && current.hash !== gate.hash) {
    gate.hash = current.hash;
    gate.generation = crypto.randomUUID();
  }
  return gate;
}
async function guardMessage(bot, msg) {
  if (getAccessGate().authorized(msg)) return true;
  if (getAccessGate().allowNotice(msg))
    await bot.sendMessage(msg.chat.id, LOCKED_TEXT).catch(() => {});
  return false;
}
async function guardCallback(bot, query) {
  const msg = { chat: query.message?.chat, from: query.from };
  if (getAccessGate().authorized(msg)) return true;
  await bot
    .answerCallbackQuery(query.id, {
      text: "🔒 Время доступа истекло. Войди через /start с паролем.",
      show_alert: true,
    })
    .catch(() => {});
  return false;
}
module.exports = {
  AccessGate,
  getAccessGate,
  hashPassword,
  verifyPassword,
  guardMessage,
  guardCallback,
  LOCKED_TEXT,
};
