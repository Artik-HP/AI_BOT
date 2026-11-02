const crypto = require("crypto");
const CONFIG = require("../config");
const logger = require("../utils/logger");
const { isUserAllowed } = require("../services/access");
const { getStore } = require("./store");
const { LIMITS } = require("./rules");

// Reminders live in the companion store, so they survive restarts. A single timer scans the (small) list;
// delivery is at-least-once: the entry is removed only after Telegram accepted the message.

const MIN_LEAD_MS = 30 * 1000;
const MAX_LEAD_MS = 366 * 24 * 60 * 60 * 1000;
const MAX_PER_TICK = 20;
const MAX_TRIES = 3;
const RETRY_DELAY_MS = 60 * 1000;
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

function resolveDueAt({ in_minutes: inMinutes, at }, now) {
  if (Boolean(inMinutes) === Boolean(at)) {
    return fail("give_exactly_one_of_in_minutes_or_at");
  }

  const dueAt = inMinutes ? now + inMinutes * 60 * 1000 : (ISO_WITH_OFFSET.test(at) ? Date.parse(at) : NaN);

  if (!Number.isFinite(dueAt)) {
    return fail("at_must_be_iso_8601_with_utc_offset", { example: "2026-10-30T09:00:00+03:00" });
  }

  if (dueAt < now + MIN_LEAD_MS) {
    return fail("time_is_in_the_past_or_too_soon", { minSeconds: MIN_LEAD_MS / 1000 });
  }

  if (dueAt > now + MAX_LEAD_MS) {
    return fail("too_far_ahead", { maxDays: 366 });
  }

  return ok({ dueAt });
}

// Runs inside store.change(): a refusal leaves the file untouched.
function scheduleReminder(data, ctx, { text, in_minutes: inMinutes, at }) {
  const now = ctx.now();
  const due = resolveDueAt({ in_minutes: inMinutes, at }, now);

  if (!due.ok) {
    return due;
  }

  const mine = data.reminders.filter((item) => item.userId === ctx.userId).length;
  const inChat = data.reminders.filter((item) => item.chatId === ctx.chatId).length;

  if (mine >= LIMITS.remindersPerUser) {
    return fail("too_many_reminders", { max: LIMITS.remindersPerUser });
  }

  if (inChat >= LIMITS.remindersPerChat || data.reminders.length >= LIMITS.remindersTotal) {
    return fail("too_many_reminders_in_chat", { max: LIMITS.remindersPerChat });
  }

  const reminder = {
    id: crypto.randomBytes(4).toString("hex"),
    chatId: ctx.chatId,
    userId: ctx.userId,
    name: ctx.name,
    group: ctx.isGroup,
    text,
    dueAt: due.dueAt,
    createdAt: now,
    tries: 0
  };

  data.reminders.push(reminder);
  return ok({ id: reminder.id, dueAtUtc: new Date(reminder.dueAt).toISOString(), pending: mine + 1 });
}

function formatReminder(item) {
  return item.group && item.name
    ? `⏰ ${item.name}, напоминание: ${item.text}`
    : `⏰ Напоминание: ${item.text}`;
}

function listReminders(store, chatId, userId) {
  return store.view((data) => data.reminders
    .filter((item) => item.chatId === String(chatId) && item.userId === String(userId))
    .sort((a, b) => a.dueAt - b.dueAt)
    .map(({ id, dueAt, text }) => ({ id, dueAt, text })));
}

// `id` null cancels every reminder of this person in this chat. Returns how many were removed.
function cancelReminders(store, chatId, userId, id = null) {
  const result = store.change((data) => {
    const before = data.reminders.length;

    data.reminders = data.reminders.filter((item) => !(
      item.chatId === String(chatId) && item.userId === String(userId) && (id === null || item.id === id)
    ));
    return ok({ removed: before - data.reminders.length });
  });

  return result.removed;
}

function createReminderScheduler({ store, send, isAllowed = () => true, now = Date.now }) {
  let running = false;

  function drop(id) {
    store.change((data) => {
      data.reminders = data.reminders.filter((item) => item.id !== id);
      return ok();
    });
  }

  function retryLater(id, at) {
    store.change((data) => {
      const item = data.reminders.find((entry) => entry.id === id);

      if (!item) {
        return ok();
      }

      item.tries += 1;

      if (item.tries >= MAX_TRIES) {
        data.reminders = data.reminders.filter((entry) => entry.id !== id);
      } else {
        item.dueAt = at + RETRY_DELAY_MS;
      }

      return ok();
    });
  }

  // Delivers what is due. Returns the number of reminders sent.
  async function tick(at = now()) {
    if (running) {
      return 0;
    }

    running = true;
    let delivered = 0;

    try {
      const due = store.view((data) => data.reminders.filter((item) => item.dueAt <= at).slice(0, MAX_PER_TICK));

      for (const item of due) {
        if (!isAllowed(item.userId)) {
          drop(item.id);
          continue;
        }

        try {
          await send(item.chatId, formatReminder(item));
          drop(item.id);
          delivered += 1;
        } catch (error) {
          logger.warn("Reminder delivery failed:", error);
          retryLater(item.id, at);
        }
      }
    } finally {
      running = false;
    }

    return delivered;
  }

  return { tick };
}

function startReminderScheduler(bot, { store = getStore(), tickMs = CONFIG.COMPANION_REMINDER_TICK_MS } = {}) {
  const scheduler = createReminderScheduler({
    store,
    send: (chatId, text) => bot.sendMessage(chatId, text),
    isAllowed: isUserAllowed
  });
  const run = () => scheduler.tick().catch((error) => logger.error("Reminder scheduler error:", error));
  const timer = setInterval(run, tickMs);

  timer.unref();
  run();

  return {
    tick: scheduler.tick,
    stop() {
      clearInterval(timer);
    }
  };
}

module.exports = {
  MIN_LEAD_MS,
  MAX_LEAD_MS,
  resolveDueAt,
  scheduleReminder,
  formatReminder,
  listReminders,
  cancelReminders,
  createReminderScheduler,
  startReminderScheduler
};
