const CONFIG = require("../config");
const { createTtlSet } = require("../utils/ttlSet");

const NOTICE_INTERVAL_MS = 60 * 1000;
const PRUNE_EVERY_CHECKS = 500;

const hits = new Map();
const notices = createTtlSet(NOTICE_INTERVAL_MS);
let checksSincePrune = 0;

function isOwner(id) {
  return id != null && CONFIG.OWNER_CHAT_IDS.includes(String(id));
}

// Without BOT_ALLOWED_USER_IDS the bot stays open to everyone; owners are always allowed.
function isUserAllowed(userId) {
  if (!CONFIG.BOT_ALLOWED_USER_IDS.length) {
    return true;
  }

  return isOwner(userId) || CONFIG.BOT_ALLOWED_USER_IDS.includes(String(userId));
}

function pruneHits(now) {
  const windowStart = now - CONFIG.RATE_LIMIT_WINDOW_MS;

  for (const [key, timestamps] of hits) {
    if (!timestamps.some((timestamp) => timestamp > windowStart)) {
      hits.delete(key);
    }
  }
}

// Sliding window per user. Rejected attempts are not counted, so waiting always helps.
function checkRateLimit(userId, now = Date.now()) {
  if (isOwner(userId)) {
    return { ok: true };
  }

  const key = String(userId);
  const windowStart = now - CONFIG.RATE_LIMIT_WINDOW_MS;
  const recent = (hits.get(key) || []).filter((timestamp) => timestamp > windowStart);

  if (recent.length >= CONFIG.RATE_LIMIT_MESSAGES) {
    hits.set(key, recent);
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil((recent[0] + CONFIG.RATE_LIMIT_WINDOW_MS - now) / 1000))
    };
  }

  recent.push(now);
  hits.set(key, recent);
  checksSincePrune += 1;

  if (checksSincePrune >= PRUNE_EVERY_CHECKS) {
    checksSincePrune = 0;
    pruneHits(now);
  }

  return { ok: true };
}

function evaluateAccess(userId) {
  if (!isUserAllowed(userId)) {
    return { ok: false, reason: "forbidden" };
  }

  const limit = checkRateLimit(userId);

  return limit.ok
    ? { ok: true }
    : { ok: false, reason: "rate", retryAfterSec: limit.retryAfterSec };
}

// A refused user gets one explanation per minute, not one per message.
function shouldSendNotice(userId, reason) {
  return notices.claim(`${userId}:${reason}`);
}

function buildNoticeText(decision) {
  if (decision.reason === "forbidden") {
    return "Этот бот приватный: доступ только для приглашённых.";
  }

  return `Слишком часто. Подожди ${decision.retryAfterSec} с и напиши ещё раз.`;
}

module.exports = {
  isOwner,
  isUserAllowed,
  checkRateLimit,
  evaluateAccess,
  shouldSendNotice,
  buildNoticeText
};
