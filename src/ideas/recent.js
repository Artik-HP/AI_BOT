const { drawSparks } = require("./spark");

// What a chat was shown lately: so that the next spark does not repeat the last ones, and so that the model can redraw
// one ingredient of the last spark ("поменяй только поворот"). Kept in memory only, on purpose: after a restart the bot
// just forgets which sparks it threw, which costs nothing, and nothing about people is written anywhere. Bounded both
// in chats (the oldest is dropped) and in time (a chat silent for TTL_MS starts afresh).

const RECENT_SPARKS = 4;
const RECENT_TECHNIQUES = 3;
const MAX_CHATS = 5000;
const TTL_MS = 12 * 60 * 60 * 1000;

function createSparkHistory({ maxChats = MAX_CHATS, ttlMs = TTL_MS, now = Date.now } = {}) {
  const chats = new Map();

  function fresh(key) {
    const entry = chats.get(key);

    if (entry && now() - entry.at < ttlMs) {
      return entry;
    }

    chats.delete(key);
    return null;
  }

  // Plain data for drawSparks: values and technique ids to avoid, and the spark a reroll would change.
  function recent(chatId) {
    const entry = fresh(String(chatId));

    return {
      values: new Set(entry ? entry.sparks.flatMap((spark) => Object.values(spark)) : []),
      techniques: new Set(entry ? entry.techniques : []),
      last: entry?.last || null,
      lastTechnique: entry?.techniques.at(-1) || null
    };
  }

  // Only a single spark becomes "the last one": after three at once it is unclear which of them the person means.
  function record(chatId, sparks, technique) {
    const key = String(chatId);
    const entry = fresh(key) || { sparks: [], techniques: [] };

    // Re-inserting moves the chat to the end, so the map's first key is always the one used longest ago.
    chats.delete(key);
    chats.set(key, {
      sparks: [...entry.sparks, ...sparks].slice(-RECENT_SPARKS),
      techniques: [...entry.techniques, technique.id].slice(-RECENT_TECHNIQUES),
      last: sparks.length === 1 ? sparks[0] : null,
      at: now()
    });

    while (chats.size > maxChats) {
      chats.delete(chats.keys().next().value);
    }
  }

  // One draw for a chat: what it saw lately is avoided, and what it gets is remembered.
  function draw(chatId, rng, options = {}) {
    const result = drawSparks(rng, { ...options, recent: recent(chatId) });

    if (result.ok) {
      record(chatId, result.sparks, result.technique);
    }

    return result;
  }

  return {
    recent,
    record,
    draw,
    forget(chatId) {
      chats.delete(String(chatId));
    },
    get size() {
      return chats.size;
    }
  };
}

// The one history of the running bot: the spark card of /spark and the model's idea_spark share it, so the model can
// change a spark the person saw on the card.
const sparkHistory = createSparkHistory();

module.exports = {
  RECENT_SPARKS,
  RECENT_TECHNIQUES,
  createSparkHistory,
  sparkHistory
};
