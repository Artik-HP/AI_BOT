const crypto = require("crypto");
const { comparableText } = require("../utils/text");

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

// Russian endings vary ("кофейня", "кофейни"), so longer words are compared by their stem.
function searchTokens(query) {
  return (query || "").toLowerCase().match(/[\p{L}\p{N}]{2,}/gu)?.map((word) => (word.length > 5 ? word.slice(0, word.length - 2) : word)) || [];
}

function score(idea, tokens) {
  const haystack = `${idea.title} ${idea.pitch} ${idea.tags.join(" ")}`.toLowerCase();
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

    return ok({ id, deleted: true });
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

// Used by "/ideas del код". True when something was removed.
function removeFor(store, chatId, userId, id) {
  return store.change((data) => updateIdea(data, scopeKey(chatId, userId), id.toLowerCase(), {}, true, 0)).ok;
}

// Used by "/ideas clear". Returns how many ideas were removed.
function clearFor(store, chatId, userId) {
  const result = store.change((data) => {
    const removed = (data.ideas[scopeKey(chatId, userId)] || []).length;

    if (!removed) {
      return fail("empty");
    }

    delete data.ideas[scopeKey(chatId, userId)];
    return ok({ removed });
  });

  return result.ok ? result.removed : 0;
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
  removeFor,
  clearFor,
  digestFor
};
