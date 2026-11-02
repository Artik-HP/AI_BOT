const crypto = require("crypto");
const { comparableText, searchText, searchTokens } = require("../utils/text");

// The idea bank: ideas a person decided to keep. They live in the companion store (src/companion/store.js) under
// data.ideas["<chatId>:<userId>"], exactly like saved facts: private to the person in that chat, so ideas from a
// one-to-one chat never surface in a group. The mutating functions take the plain data object and are meant to run
// inside store.change(), where a result with ok:false discards the whole copy. Nothing here touches disk or the
// clock on its own: `now` is passed in.

const IDEA_LIMITS = {
  scopes: 5000,
  perScope: 200,
  titleChars: 80,
  pitchChars: 600,
  nextChars: 200,
  tags: 5,
  tagChars: 24,
  listMax: 20,
  promptTitles: 5
};

const IDEA_STATUSES = ["new", "exploring", "done", "parked"];
const STATUS_ICONS = { new: "🆕", exploring: "🔍", done: "✅", parked: "💤" };
const ID_PATTERN = /^[0-9a-f]{8}$/;

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

function scopeKey(chatId, userId) {
  return `${chatId}:${userId}`;
}

// "#A1B2C3D4", "a1b2c3d4." and " a1b2c3d4 " are the same code: people and models copy it with the list's decoration.
// Returns the bare code or null.
function normalizeId(raw) {
  const code = String(raw ?? "").toLowerCase().replace(/^[#№\s]+/, "").replace(/[\s.,;:!?)]+$/, "");

  return ID_PATTERN.test(code) ? code : null;
}

// "Кофейня-библиотека", "кофейня библиотека" and "Кофейня — библиотека!" name one idea.
function titleKey(title) {
  return comparableText(title);
}

function newId(list) {
  let id;

  do {
    id = crypto.randomBytes(4).toString("hex");
  } while (list.some((idea) => idea.id === id));

  return id;
}

// The query and the idea are normalized by one rule (utils/text.js), so "елка" finds "ёлка" and the other way round.
function score(idea, tokens) {
  const haystack = searchText(`${idea.title} ${idea.pitch} ${idea.tags.join(" ")}`);
  return tokens.filter((token) => haystack.includes(token)).length;
}

// The shape the model (and the /ideas command) sees: no internals, dates as plain days.
function describeIdea(idea) {
  return {
    id: idea.id,
    title: idea.title,
    pitch: idea.pitch,
    tags: idea.tags,
    next_step: idea.next || null,
    status: idea.status,
    saved: new Date(idea.updatedAt).toISOString().slice(0, 10)
  };
}

// Saving a title that is already in the bank (up to case, "ё" and punctuation) updates that idea instead of piling up
// near-duplicates. The answer carries the idea as stored, so the model can confirm exactly what was kept.
function addIdea(data, scope, { title, pitch, tags = [], next = "" }, now) {
  if (!data.ideas[scope] && Object.keys(data.ideas).length >= IDEA_LIMITS.scopes) {
    return fail("store_full");
  }

  const list = data.ideas[scope] ||= [];
  const same = list.find((idea) => titleKey(idea.title) === titleKey(title));

  if (same) {
    same.pitch = pitch;
    same.tags = tags.length ? tags : same.tags;
    same.next = next || same.next;
    same.updatedAt = now;
    return ok({ id: same.id, updated: true, total: list.length, idea: describeIdea(same) });
  }

  if (list.length >= IDEA_LIMITS.perScope) {
    return fail("too_many_ideas", { max: IDEA_LIMITS.perScope, hint: "Ask the person which ideas to delete or mark as done." });
  }

  const idea = { id: newId(list), title, pitch, tags, next, status: "new", createdAt: now, updatedAt: now };

  list.push(idea);
  return ok({ id: idea.id, saved: true, total: list.length, idea: describeIdea(idea) });
}

// Reminders tied to ideas that are being deleted go with them, inside the same store.change(): a refused write keeps
// both the idea and its reminders. Returns how many were cancelled.
function cancelIdeaReminders(data, scope, ids) {
  if (!Array.isArray(data.reminders)) {
    return 0;
  }

  const before = data.reminders.length;

  data.reminders = data.reminders.filter((item) => !(item.ideaId && ids.includes(item.ideaId) && `${item.chatId}:${item.userId}` === scope));
  return before - data.reminders.length;
}

function updateIdea(data, scope, id, changes, remove, now) {
  const list = data.ideas[scope] || [];
  const idea = list.find((entry) => entry.id === id);

  if (!idea) {
    return fail("not_found", { id });
  }

  if (remove) {
    data.ideas[scope] = list.filter((entry) => entry !== idea);

    if (!data.ideas[scope].length) {
      delete data.ideas[scope];
    }

    const cancelled = cancelIdeaReminders(data, scope, [id]);

    return ok({ id, deleted: true, ...(cancelled ? { reminders_cancelled: cancelled } : {}) });
  }

  const clash = changes.title && list.find((entry) => entry !== idea && titleKey(entry.title) === titleKey(changes.title));

  if (clash) {
    return fail("title_taken", { id: clash.id });
  }

  for (const [field, value] of Object.entries(changes)) {
    idea[field === "next_step" ? "next" : field] = value;
  }

  idea.updatedAt = now;
  return ok({ id, updated: true, idea: describeIdea(idea) });
}

// Newest first. With a query, ideas are ranked by how many of its words they contain and others are left out.
// `offset` pages through a long bank; `has_more` says whether a next page exists.
function listIdeas(data, scope, { query, status, limit = 10, offset = 0 } = {}) {
  const tokens = searchTokens(query);
  let ideas = (data.ideas[scope] || []).filter((idea) => !status || idea.status === status);
  const total = ideas.length;

  if (tokens.length) {
    ideas = ideas
      .map((idea) => ({ idea, hits: score(idea, tokens) }))
      .filter((entry) => entry.hits > 0)
      .sort((a, b) => b.hits - a.hits || b.idea.updatedAt - a.idea.updatedAt)
      .map((entry) => entry.idea);
  } else {
    ideas = ideas.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  return {
    total,
    matched: ideas.length,
    ideas: ideas.slice(offset, offset + limit).map(describeIdea),
    ...(offset ? { offset } : {}),
    has_more: offset + limit < ideas.length
  };
}

function listFor(store, chatId, userId, options = {}) {
  return store.view((data) => listIdeas(data, scopeKey(chatId, userId), options));
}

// Used by "/ideas del код": the whole answer, with reminders_cancelled when the idea had reminders.
function removeIdeaFor(store, chatId, userId, id) {
  return store.change((data) => updateIdea(data, scopeKey(chatId, userId), id.toLowerCase(), {}, true, 0));
}

// True when something was removed.
function removeFor(store, chatId, userId, id) {
  return removeIdeaFor(store, chatId, userId, id).ok;
}

// Used by "/ideas clear". Returns how many ideas were removed; their reminders go too.
function clearFor(store, chatId, userId) {
  const result = store.change((data) => {
    const scope = scopeKey(chatId, userId);
    const list = data.ideas[scope] || [];

    if (!list.length) {
      return fail("empty");
    }

    delete data.ideas[scope];
    cancelIdeaReminders(data, scope, list.map((idea) => idea.id));
    return ok({ removed: list.length });
  });

  return result.ok ? result.removed : 0;
}

// How many ideas the person keeps in this chat, in total and per status: for /status.
function countsFor(store, chatId, userId) {
  return store.view((data) => {
    const list = data.ideas[scopeKey(chatId, userId)] || [];
    const counts = Object.fromEntries(IDEA_STATUSES.map((status) => [status, 0]));

    for (const idea of list) {
      counts[idea.status] = (counts[idea.status] || 0) + 1;
    }

    return { total: list.length, counts };
  });
}

// The chat id of a "<chatId>:<userId>" scope when it belongs to `userId`, or null. Chat ids may be negative (groups).
function chatOfScope(scope, userId) {
  const split = scope.lastIndexOf(":");

  return split > 0 && scope.slice(split + 1) === String(userId) ? scope.slice(0, split) : null;
}

// Every idea of one person, in all chats, for /export: { [chatId]: [idea, …] }, or undefined when there is none.
function exportFor(store, userId) {
  return store.view((data) => {
    const chats = {};

    for (const [scope, list] of Object.entries(data.ideas)) {
      const chatId = chatOfScope(scope, userId);

      if (chatId !== null && list.length) {
        chats[chatId] = list.slice().sort((a, b) => b.updatedAt - a.updatedAt).map(describeIdea);
      }
    }

    return Object.keys(chats).length ? chats : undefined;
  });
}

// What goes into the prompt without a tool call: how many ideas there are and the latest titles.
function digestFor(store, chatId, userId, limit = IDEA_LIMITS.promptTitles) {
  return store.view((data) => {
    const list = data.ideas[scopeKey(chatId, userId)] || [];

    return {
      total: list.length,
      titles: list.slice().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit).map((idea) => idea.title)
    };
  });
}

module.exports = {
  IDEA_LIMITS,
  IDEA_STATUSES,
  STATUS_ICONS,
  ID_PATTERN,
  scopeKey,
  normalizeId,
  titleKey,
  describeIdea,
  addIdea,
  updateIdea,
  listIdeas,
  listFor,
  removeIdeaFor,
  removeFor,
  clearFor,
  countsFor,
  chatOfScope,
  exportFor,
  digestFor
};
