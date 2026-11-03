const crypto = require("crypto");
const CONFIG = require("../config");
const logger = require("../utils/logger");
const { formatTime, nextDailyMoment } = require("../utils/time");
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
const UNKNOWN_LOG_INTERVAL_MS = 60 * 1000;
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

// Runs inside store.change(): a refusal leaves the file untouched. `ideaId` ties the reminder to an idea of the same
// person in the same chat (the scope of the idea bank); an idea of anyone else is "not found", like a missing one.
function scheduleReminder(data, ctx, { text, in_minutes: inMinutes, at, ideaId = null }) {
  const now = ctx.now();
  const due = resolveDueAt({ in_minutes: inMinutes, at }, now);

  if (!due.ok) {
    return due;
  }

  if (ideaId && !(data.ideas[`${ctx.chatId}:${ctx.userId}`] || []).some((idea) => idea.id === ideaId)) {
    return fail("idea_not_found", { idea_id: ideaId });
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
    tries: 0,
    ...(ideaId ? { ideaId } : {})
  };

  data.reminders.push(reminder);
  return ok({ id: reminder.id, dueAtUtc: new Date(reminder.dueAt).toISOString(), pending: mine + 1, ...(ideaId ? { idea_id: ideaId } : {}) });
}

// `idea` is the idea the reminder is about, read at delivery time; when it is gone the reminder reads as a plain one.
function formatReminder(item, idea = null) {
  const head = item.group && item.name
    ? `⏰ ${item.name}, напоминание: ${item.text}`
    : `⏰ Напоминание: ${item.text}`;

  if (!idea) {
    return head;
  }

  return [head, `💡 «${idea.title}» (${idea.id})`, idea.next ? `Шаг: ${idea.next}` : null].filter(Boolean).join("\n");
}

function ideaOf(data, item) {
  return item.ideaId ? (data.ideas[`${item.chatId}:${item.userId}`] || []).find((idea) => idea.id === item.ideaId) || null : null;
}

function listReminders(store, chatId, userId) {
  return store.view((data) => data.reminders
    .filter((item) => item.chatId === String(chatId) && item.userId === String(userId))
    .sort((a, b) => a.dueAt - b.dueAt)
    .map(({ id, dueAt, text, ideaId }) => ({ id, dueAt, text, ...(ideaId ? { ideaId } : {}) })));
}

// The nearest pending reminder of each idea of this person in this chat: { [ideaId]: dueAt }, for /ideas.
function ideaReminders(store, chatId, userId) {
  return Object.fromEntries(listReminders(store, chatId, userId)
    .filter((item) => item.ideaId)
    .reverse()
    .map((item) => [item.ideaId, item.dueAt]));
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

// Whether a reminder may go out to this person now: the allow-list first, then the account database when there is one.
// Answers true, false, or null when it cannot be told (the database is down): blocking is an explicit record, so a
// person without a row is allowed.
function createAccessCheck({ allowed = isUserAllowed, database = () => require("../database").getDatabase(), now = Date.now } = {}) {
  return async (userId) => {
    if (!allowed(userId)) {
      return false;
    }

    try {
      const db = database();

      if (!db) {
        return true;
      }

      const { accountState } = require("../database");
      const state = accountState(await db.account(userId), now());

      return state === null || state === "active";
    } catch {
      return null;
    }
  };
}

// The daily spark (/daily): one entry per person in data.daily — { chatId, userId, time "HH:MM", timeZone, nextAt,
// tries } — in the same file as reminders, so it survives restarts. Only a private chat has one.
function setDaily(store, { chatId, userId, time, timeZone }, now) {
  const entry = { id: crypto.randomBytes(8).toString("hex"), chatId: String(chatId), userId: String(userId), time, timeZone: timeZone || "", nextAt: nextDailyMoment(time, timeZone, now), tries: 0, createdAt: now };

  store.change((data) => {
    data.daily[entry.userId] = entry;
    return ok();
  });

  return entry;
}

// True when there was one to switch off.
function cancelDaily(store, userId) {
  if (!store.view((data) => Boolean(data.daily[String(userId)]))) {
    return false;
  }

  store.change((data) => {
    delete data.daily[String(userId)];
    return ok();
  });
  return true;
}

function dailyOf(store, userId) {
  return store.view((data) => data.daily[String(userId)] || null);
}

// Registered in src/bot.js (src/lifecycle.js) when the functions are on. A logout keeps it, like reminders.
const dailyHooks = {
  statusLines: ({ userId, isPrivate }) => {
    const entry = isPrivate ? dailyOf(getStore(), userId) : null;

    return entry ? `Искра дня: в ${entry.time} ${entry.timeZone || "UTC"}` : null;
  },
  exportData: ({ userId }) => {
    const entry = dailyOf(getStore(), userId);

    return entry ? { time: entry.time, timeZone: entry.timeZone || "UTC", next: new Date(entry.nextAt).toISOString() } : undefined;
  }
};

// `isAllowed` may be async and answers true, false or "unknown" (anything else, or a throw). Unknown leaves the
// reminder for the next tick without spending a try. `deliverDaily(entry)` sends the daily spark card; without it the
// scheduler leaves daily entries alone.
function createReminderScheduler({ store, send, deliverDaily = null, isAllowed = () => true, now = Date.now, warn = (text) => logger.warn(text) }) {
  let running = false;
  let unknownLoggedAt = -Infinity;

  function noteUnknown(at) {
    if (at - unknownLoggedAt >= UNKNOWN_LOG_INTERVAL_MS) {
      unknownLoggedAt = at;
      warn("Reminder delivery postponed: the account database is unavailable.");
    }
  }

  // Old files have no id. Compare their schedule too, so both old and new records survive a reschedule during I/O.
  function sameDaily(current, expected) {
    return Boolean(current) && current.id === expected.id && current.createdAt === expected.createdAt &&
      current.nextAt === expected.nextAt && current.time === expected.time && current.timeZone === expected.timeZone;
  }

  // Only the delivered revision may be advanced or retried; a new subscription keeps its own state.
  function updateDaily(entry, next) {
    store.change((data) => {
      const userId = entry.userId;
      const current = data.daily[userId];

      if (sameDaily(current, entry)) {
        const value = next(current);

        if (value) {
          data.daily[userId] = value;
        } else {
          delete data.daily[userId];
        }
      }

      return ok();
    });
  }

  // After a delivery (or the last failed try) the entry moves to the next day; days missed while the bot was off are
  // not replayed one by one.
  async function tickDaily(at) {
    let delivered = 0;
    const due = store.view((data) => Object.values(data.daily).filter((entry) => entry.nextAt <= at).slice(0, MAX_PER_TICK));
    const tomorrow = (current) => ({ ...current, tries: 0, nextAt: nextDailyMoment(current.time, current.timeZone, at) });

    for (const entry of due) {
      const verdict = await admission(entry.userId);

      if (!store.view((data) => sameDaily(data.daily[entry.userId], entry))) continue;

      if (verdict === null) {
        noteUnknown(at);
        continue;
      }

      if (!verdict) {
        logger.info("A daily spark was switched off: the person no longer has access.");
        updateDaily(entry, () => null);
        continue;
      }

      try {
        await deliverDaily(entry);
        updateDaily(entry, tomorrow);
        delivered += 1;
      } catch (error) {
        logger.warn("Daily spark delivery failed:", error);
        updateDaily(entry, (current) => (current.tries + 1 >= MAX_TRIES ? tomorrow(current) : { ...current, tries: current.tries + 1, nextAt: at + RETRY_DELAY_MS }));
      }
    }

    return delivered;
  }

  async function admission(userId) {
    try {
      const verdict = await isAllowed(userId);

      return typeof verdict === "boolean" ? verdict : null;
    } catch {
      return null;
    }
  }

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
        const verdict = await admission(item.userId);

        // Cancellation (including deletion of its idea) may have happened while the database was answering.
        if (!store.view((data) => data.reminders.some((current) => current.id === item.id))) continue;

        if (verdict === null) {
          noteUnknown(at);
          continue;
        }

        if (!verdict) {
          logger.info(`Reminder ${item.id} dropped: the person no longer has access.`);
          drop(item.id);
          continue;
        }

        try {
          await send(item.chatId, formatReminder(item, store.view((data) => ideaOf(data, item))));
          drop(item.id);
          delivered += 1;
        } catch (error) {
          logger.warn("Reminder delivery failed:", error);
          retryLater(item.id, at);
        }
      }

      if (deliverDaily) {
        delivered += await tickDaily(at);
      }
    } finally {
      running = false;
    }

    return delivered;
  }

  return { tick };
}

// "Напоминаний: 2, ближайшее 2026-11-03 09:00 UTC" for /status (local time with BOT_TIMEZONE).
function reminderStatusLine(store, chatId, userId, timeZone = CONFIG.BOT_TIMEZONE) {
  const list = listReminders(store, chatId, userId);

  return list.length ? `Напоминаний: ${list.length}, ближайшее ${formatTime(list[0].dueAt, timeZone)}` : "Напоминаний: 0";
}

// Every pending reminder of one person, in all chats, for /export; undefined when there is none.
function remindersOf(store, userId) {
  const list = store.view((data) => data.reminders
    .filter((item) => item.userId === String(userId))
    .sort((a, b) => a.dueAt - b.dueAt)
    .map((item) => ({ id: item.id, chatId: item.chatId, text: item.text, due: new Date(item.dueAt).toISOString(), ...(item.ideaId ? { ideaId: item.ideaId } : {}) })));

  return list.length ? list : undefined;
}

// Registered in src/bot.js (src/lifecycle.js) when the functions are on. /reset and logout keep reminders: the person
// set them for this chat.
const lifecycleHooks = {
  statusLines: ({ chatId, userId }) => reminderStatusLine(getStore(), chatId, userId),
  exportData: ({ userId }) => remindersOf(getStore(), userId)
};

function startReminderScheduler(bot, { store = getStore(), tickMs = CONFIG.COMPANION_REMINDER_TICK_MS, deliverDaily = null } = {}) {
  const scheduler = createReminderScheduler({
    store,
    send: (chatId, text) => bot.sendMessage(chatId, text),
    deliverDaily,
    isAllowed: createAccessCheck()
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
  ideaReminders,
  listReminders,
  cancelReminders,
  setDaily,
  cancelDaily,
  dailyOf,
  dailyHooks,
  createAccessCheck,
  createReminderScheduler,
  lifecycleHooks,
  reminderStatusLine,
  remindersOf,
  startReminderScheduler
};
