const crypto = require("crypto");
const { promisify } = require("util");
const { AsyncLocalStorage } = require("async_hooks");
const CONFIG = require("../config");
const { isOwner, checkRateLimit, shouldSendNotice, buildNoticeText } = require("./access");
const scrypt = promisify(crypto.scrypt);
const HASH_PATTERN = /^scrypt\$16384\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{64}$/;
// The only /start payload kept across a login: a spark from the website. Its code is checked by the consumer.
const START_PAYLOAD = /^spark_[A-Za-z0-9_-]{1,32}$/;

function startPayloadOf(text) {
  const payload = String(text || "").match(/^\/start(?:@\w+)?\s+(\S+)\s*$/i)?.[1] || null;
  return payload && START_PAYLOAD.test(payload) ? payload : null;
}

async function hashPassword(password) {
  if (typeof password !== "string" || password.length < 6 || password.length > 256) throw new Error("AUTH_PASSWORD_LENGTH");
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt}$${derived.toString("hex")}`;
}

class PasswordAuth {
  constructor({ hash = CONFIG.BOT_PASSWORD_HASH, ttl = CONFIG.BOT_AUTH_SESSION_MS,
    maxFailures = CONFIG.BOT_AUTH_MAX_FAILURES, lockMs = CONFIG.BOT_AUTH_LOCK_MS, now = Date.now } = {}) {
    this.hash = hash;
    this.ttl = ttl;
    this.maxFailures = maxFailures;
    this.lockMs = lockMs;
    this.now = now;
    this.sessions = new Map();
    this.failures = new Map();
    this.globalFailures = [];
    this.pending = new Set();
    this.challenges = new Map();
    // What a /start link asked for (spark_<код>) while the person still had to log in: memory only, same deadline.
    this.startPayloads = new Map();
    this.epochs = new Map();
    this.secret = crypto.randomBytes(32);
    this.accountPolicy = null;
    // Called by every logout: /logout, /login, a block through /access and any later path. src/bot.js points it at
    // lifecycle.revokeUser, so all of them close the same sessions, buttons and menus.
    this.onRevoke = null;
  }

  configured() { return HASH_PATTERN.test(this.hash || ""); }
  validId(userId) { return /^\d{1,18}$/.test(String(userId || "")); }
  tag(value) { return crypto.createHmac("sha256", this.secret).update(value).digest("hex"); }
  capture(userId) {
    const session = this.sessions.get(String(userId));
    return session && session.expires > this.now() ? { userId: String(userId), generation: session.generation } : null;
  }
  valid(lease) {
    if (!lease) return false;
    const session = this.capture(lease.userId);
    return Boolean(session && session.generation === lease.generation);
  }
  authenticated(userId) { return this.validId(userId) && Boolean(this.capture(userId)); }
  logout(userId) {
    const key = String(userId);
    this.sessions.delete(key);
    this.challenges.delete(key);
    this.startPayloads.delete(key);
    if (this.pending.has(key)) this.epochs.set(key, null);
    // The session is closed first: a failing revocation hook must not keep access open.
    try {
      Promise.resolve(this.onRevoke?.(key)).catch(() => {});
    } catch {
      // lifecycle.revokeUser logs its own failures and never throws; a plain handler may.
    }
  }
  challenge(userId, payload = null) {
    if (!this.validId(userId)) return;
    this.prune();
    if (this.challenges.size >= 10000) return;
    const until = this.now() + 10 * 60000;
    this.challenges.set(String(userId), until);
    if (payload && START_PAYLOAD.test(payload)) this.startPayloads.set(String(userId), { payload, until });
    else this.startPayloads.delete(String(userId));
  }
  // Once, after a successful login; null when there was none or the challenge expired.
  takeStartPayload(userId) {
    const key = String(userId);
    const entry = this.startPayloads.get(key);
    this.startPayloads.delete(key);
    return entry && entry.until > this.now() ? entry.payload : null;
  }
  awaiting(userId) { return (this.challenges.get(String(userId)) || 0) > this.now(); }
  isCredentialText(text) {
    if (typeof text !== "string") return false;
    const normalized = text.trim();
    if (normalized.length > 256) return false;
    const tag = this.tag(normalized);
    return [...this.sessions.values()].some((session) => session.credentialTag === tag);
  }
  prune() {
    const now = this.now();
    for (const [key, session] of this.sessions) if (session.expires <= now) this.sessions.delete(key);
    for (const [key, until] of this.challenges) if (until <= now) this.challenges.delete(key);
    for (const [key, entry] of this.startPayloads) if (entry.until <= now) this.startPayloads.delete(key);
    for (const [key, value] of this.failures) if (value.until <= now) this.failures.delete(key);
    this.globalFailures = this.globalFailures.filter((at) => at > now - this.lockMs);
  }
  async authenticate(userId, password) {
    this.prune();
    const key = String(userId);
    if (!this.configured() || !this.validId(userId)) return { ok: false, reason: "unconfigured" };
    if (typeof password !== "string" || password.length > 256) return { ok: false, reason: "wrong" };
    // Strangers share a global budget of wrong guesses and two password checks at a time. The owner (whose Telegram id
    // cannot be forged) keeps a place of their own, otherwise ten throwaway accounts could keep the owner out for good.
    const owner = isOwner(key);
    if ((this.failures.get(key)?.count || 0) >= this.maxFailures || (!owner && this.globalFailures.length >= 50)) return { ok: false, reason: "locked" };
    if (this.pending.has(key) || this.pending.size >= (owner ? 4 : 2) || this.sessions.size >= 10000) return { ok: false, reason: "busy" };
    this.pending.add(key);
    const epoch = crypto.randomBytes(16).toString("hex");
    this.epochs.set(key, epoch);
    try {
      const [, , , , salt, expected] = this.hash.split("$");
      const value = await scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 });
      if (epoch !== this.epochs.get(key)) return { ok: false, reason: "revoked" };
      if (!crypto.timingSafeEqual(value, Buffer.from(expected, "hex"))) {
        const failure = this.failures.get(key) || { count: 0, until: this.now() + this.lockMs };
        failure.count++;
        if (this.failures.size < 10000) this.failures.set(key, failure);
        if (!owner) this.globalFailures.push(this.now());
        return { ok: false, reason: "wrong" };
      }
      let deadline = this.now() + this.ttl;
      if (this.accountPolicy) {
        let account;
        try { account = await this.accountPolicy(key); } catch { return { ok: false, reason: "database" }; }
        if (!account.allowed) return { ok: false, reason: "blocked" };
        if (account.until) {
          const until = new Date(account.until).getTime();
          if (!Number.isFinite(until) || until <= this.now()) return { ok: false, reason: "blocked" };
          deadline = Math.min(deadline, until);
        }
      }
      if (epoch !== this.epochs.get(key)) return { ok: false, reason: "revoked" };
      this.sessions.set(key, { generation: crypto.randomBytes(16).toString("hex"), expires: deadline, credentialTag: this.tag(password) });
      this.failures.delete(key);
      this.challenges.delete(key);
      return { ok: true };
    } finally { this.pending.delete(key); this.epochs.delete(key); }
  }
}

const auth = new PasswordAuth();
let onLogin = async () => {};
function setLoginHandler(handler) { onLogin = handler; }
function setRevokeHandler(handler) { auth.onRevoke = handler; }
const AUTH_LEASE = Symbol("authenticated-message");
const context = new AsyncLocalStorage();
function runWithLease(lease, task) { return context.run(lease, task); }
function withMessageAuth(msg, task) { return runWithLease(msg[AUTH_LEASE], task); }
function checkContext() {
  const lease = context.getStore();
  if (lease && !auth.valid(lease)) throw Object.assign(new Error("AUTH_REQUIRED"), { code: "AUTH_REQUIRED" });
}
function captureMessage(msg) {
  const userId = msg.from?.is_bot ? CONFIG.BOT_TO_BOT_OWNER_CHAT_ID : msg.from?.id;
  msg[AUTH_LEASE] = auth.capture(userId);
}
function messageAuthorized(msg) { return auth.valid(msg[AUTH_LEASE]); }

async function passwordGate(bot, msg) {
  const userId = msg.from?.id;
  if (!auth.validId(userId)) return false;
  if (msg.from?.is_bot) return auth.authenticated(CONFIG.BOT_TO_BOT_OWNER_CHAT_ID);
  if (auth.authenticated(userId)) {
    // Re-entered passwords are consumed before AI/history/message logging as well.
    if (auth.isCredentialText(msg.text) || auth.isCredentialText(msg.caption)) {
      await bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
      return false;
    }
    return true;
  }
  // The prompts below are replies too: a stranger must not be able to make the bot answer without limit.
  const limit = checkRateLimit(userId);
  if (!limit.ok) {
    if (shouldSendNotice(userId, "rate")) await bot.sendMessage(msg.chat.id, buildNoticeText({ reason: "rate", retryAfterSec: limit.retryAfterSec }));
    return false;
  }
  const privateChat = msg.chat?.type === "private" && String(msg.chat.id) === String(userId);
  if (!privateChat) {
    await bot.sendMessage(msg.chat.id, "🔐 Сначала войди через /start в личном диалоге с ботом.");
    return false;
  }
  if (!auth.configured()) {
    await bot.sendMessage(msg.chat.id, "🔒 Доступ закрыт. Администратор ещё не настроил пароль входа.");
    return false;
  }
  if (/^\/start(?:@\w+)?(?:\s|$)/i.test(msg.text || "")) {
    auth.challenge(userId, startPayloadOf(msg.text));
    await bot.sendMessage(msg.chat.id, "🔐 Введите пароль для доступа к боту.", { reply_markup: { remove_keyboard: true } });
    return false;
  }
  if (!auth.awaiting(userId) || typeof msg.text !== "string" || msg.text.startsWith("/")) {
    await bot.sendMessage(msg.chat.id, "🔐 Доступ по паролю. Отправь /start, чтобы войти.");
    return false;
  }
  const result = await auth.authenticate(userId, msg.text);
  await bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
  if (result.ok) {
    await bot.sendMessage(msg.chat.id, "✅ Вход выполнен. Доступ открыт до выхода, истечения сессии или перезапуска бота.");
    // The handler gets the deleted password message only for its chat and author, never its text or id.
    await onLogin(msg, auth.takeStartPayload(userId));
  } else {
    const response = result.reason === "database" ? "Учёт пользователей временно недоступен. Обратись к администратору." :
      result.reason === "blocked" ? "Доступ к этому аккаунту отключён или срок доступа истёк." :
      result.reason === "locked" ? "Слишком много попыток. Повтори вход позже." :
      result.reason === "busy" ? "Проверка уже выполняется. Подожди и повтори." : "Неверный пароль. Попробуй ещё раз.";
    await bot.sendMessage(msg.chat.id, response);
  }
  return false;
}

// What a logout revokes is not listed here: auth.logout() calls the revocation handler (setRevokeHandler).
function registerAuth(bot, onAuthenticated) {
  const { safeHandler } = require("../utils/safe");
  const { claimIncomingMessage, isAddressedToThisBot } = require("./telegram");
  setLoginHandler(onAuthenticated);
  bot.onText(/^\/(login|logout)(?:@\w+)?(?:\s|$)/i, safeHandler("Authentication command", async (msg, match) => {
    if (msg.from?.is_bot || !isAddressedToThisBot(msg.text) || !claimIncomingMessage(msg)) return;
    auth.logout(msg.from?.id);
    if (match[1].toLowerCase() === "logout") {
      await bot.sendMessage(msg.chat.id, "🔒 Вы вышли. Для входа отправь /start.", { reply_markup: { remove_keyboard: true } });
    } else await passwordGate(bot, { ...msg, text: "/start" });
  }));
}

module.exports = { auth, PasswordAuth, hashPassword, HASH_PATTERN, startPayloadOf, passwordGate, captureMessage, messageAuthorized, setLoginHandler, setRevokeHandler,
  registerAuth, runWithLease, withMessageAuth, checkContext };
