const logger = require("../utils/logger");
const { comparableText, sanitizeInline, searchText, searchTokens } = require("../utils/text");
const { parseArgs } = require("./args");
const R = require("./rules");
const { SPECS, updateCharacter, getCharacter } = require("./characters");
const { withHint } = require("./hints");
const { scheduleReminder } = require("./reminders");
const { looksSecret } = require("./secrets");
const { getStore } = require("./store");
const bank = require("../ideas/bank");
const { IDEA_TOOL_DEFINITIONS, IDEA_HANDLERS } = require("../ideas/tools");
const { sparkHistory } = require("../ideas/recent");

// The eight functions prompt.md is written for, plus the four of the ideas character (src/ideas/tools.js).
// The model never passes whose data it means: the owner is the person whose Telegram message is being answered
// (ctx.userId), and shared state is scoped to this chat (ctx.chatId).

// Larger than the biggest legitimate payload (a game state of 8 KB, possibly with every Cyrillic letter
// written as a \uXXXX escape), but small enough that a runaway reply cannot be parsed into memory.
const MAX_ARGUMENT_CHARS = 32768;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const GAME_KEY = /^[\p{L}\p{N}_-]{1,40}$/u;
const DICE_SIDES = [4, 6, 8, 10, 12, 20, 100];

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

const REASONS = [...new Set([
  ...Object.keys(R.XP_RULES), ...Object.keys(R.GOLD_EARN), ...Object.keys(R.GOLD_SPEND), "use", "lost"
])];

const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "roll_dice",
      description: "Roll dice with the server's fair random generator. Use it for every random outcome (checks, attacks, damage, initiative, loot, random picks); never invent a number. Returns every die, the kept dice and the total including the modifier.",
      parameters: {
        type: "object",
        properties: {
          sides: { type: "integer", enum: DICE_SIDES, description: "Die size" },
          count: { type: "integer", minimum: 1, maximum: 10, description: "How many dice (default 1)" },
          modifier: { type: "integer", minimum: -20, maximum: 20, description: "Added once to the total (default 0)" },
          mode: { type: "string", enum: ["normal", "advantage", "disadvantage"], description: "With one die: roll twice and keep the higher (advantage) or the lower (disadvantage)" }
        },
        required: ["sides"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "character_get",
      description: "Read the current player's character sheet with today's XP and gold limits. The player is identified by the system; never pass an id.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "character_update",
      description: "Change the current player's character. The server checks every change against the game rules, computes modifiers, HP and level-ups itself and refuses anything outside the rules, so never announce a reward before the call succeeded. Actions: create; award_xp (reason, amount, stat for real_world); change_hp (cause damage|heal|rest, amount); change_gold (reason, amount); add_item; remove_item; level_choice (when a choice is pending); add_ability (when an ability is pending); retire (only after the player confirmed).",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: Object.keys(SPECS) },
          name: { type: "string", description: "create: character name; add_item/remove_item: item name; add_ability: ability name" },
          origin: { type: "string", enum: Object.keys(R.ORIGINS), description: "create" },
          origin_bonus: { type: "string", enum: R.ABILITIES, description: "create: the ability that gets the origin's +1" },
          class: { type: "string", enum: Object.keys(R.CLASSES), description: "create" },
          trait: { type: "string", description: "create: the origin's roleplay trait" },
          stats: {
            type: "object",
            description: "create: str, dex, con, int, wis, cha as a permutation of 15, 14, 13, 12, 10, 8",
            properties: Object.fromEntries(R.ABILITIES.map((key) => [key, { type: "integer" }]))
          },
          random_stats: { type: "boolean", description: "create: let the server assign 15, 14, 13, 12, 10, 8 at random" },
          hardcore: { type: "boolean", description: "create: permanent death; only if the player asked for it" },
          reason: { type: "string", enum: REASONS, description: "award_xp: quiz, minigame, daily_task, quest, combat, dungeon, real_world. change_gold: quest, loot, sale (earn); purchase, penalty (spend). remove_item: use, sale, lost" },
          amount: { type: "integer", minimum: 1, description: "award_xp, change_hp, change_gold: a positive amount" },
          stat: { type: "string", enum: R.REAL_WORLD_STATS, description: "award_xp real_world: str/con workout, int study, wis walk/meditation/sleep, cha meeting people" },
          cause: { type: "string", enum: ["damage", "heal", "rest"], description: "change_hp" },
          source: { type: "string", enum: ["loot", "quest", "purchase", "craft", "start"], description: "add_item" },
          rarity: { type: "string", enum: R.RARITIES, description: "add_item (default common)" },
          kind: { type: "string", enum: R.ITEM_KINDS, description: "add_item (default misc)" },
          qty: { type: "integer", minimum: 1, description: "add_item / remove_item (default 1)" },
          bonus: { type: "integer", minimum: 0, maximum: 3, description: "add_item: enchantment, limited by rarity" },
          armor: { type: "integer", minimum: 0, maximum: 5, description: "add_item with kind armor: armor class bonus, limited by rarity" },
          price: { type: "integer", minimum: 1, description: "add_item with source purchase: price per unit, taken from the player's gold" },
          stats_up: { type: "array", items: { type: "string", enum: R.ABILITIES }, description: "level_choice: two different abilities, +1 each" },
          perk: { type: "string", description: "level_choice: a short funny perk instead of the stat points" },
          text: { type: "string", description: "add_ability: what it does" },
          confirm: { type: "boolean", description: "retire: true only after an explicit yes from the player" }
        },
        required: ["action"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "game_state_get",
      description: "Read the saved state of one game or mini-program in this chat, or list the saved ones when 'game' is omitted. The state is shared by everyone in the chat.",
      parameters: {
        type: "object",
        properties: { game: { type: "string", description: "Short key such as dungeon, quiz, raid_boss, tamagotchi" } }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "game_state_save",
      description: "Save the state of a game or mini-program in this chat (replaces the previous state under that key). Compact JSON, under 8 KB. Also use it to lock a hidden answer (detective, 20 questions) before the game starts. delete=true removes the key.",
      parameters: {
        type: "object",
        properties: {
          game: { type: "string", description: "Short key, letters, digits, _ and -" },
          state: { type: "object", description: "The whole state to keep" },
          delete: { type: "boolean" }
        },
        required: ["game"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "memory_save",
      description: "Remember one durable fact about the person talking: name, interests, favourite games, difficulty, timezone. Passwords, card numbers and documents are refused.",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "One short fact" } },
        required: ["text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "memory_search",
      description: "Look up saved facts about the person talking. An empty query returns the latest facts.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "reminder_create",
      description: "Send the person a message later in this chat. Give in_minutes, or at as ISO 8601 with a UTC offset (only when their timezone is known). At most 10 pending reminders per person.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "What to remind about" },
          in_minutes: { type: "integer", minimum: 1, maximum: 525600 },
          at: { type: "string", description: "For example 2026-10-30T09:00:00+03:00" },
          idea_id: { type: "string", description: "Optional: the 8-character code of a saved idea this reminder is about (from idea_save or idea_list). The reminder then shows the idea and its next step, and goes away if the idea is deleted" }
        },
        required: ["text"]
      }
    }
  }
];

const TOOL_NAMES = TOOL_DEFINITIONS.map((tool) => tool.function.name);

// Which functions each character gets. "companion" keeps the eight it was written for; "ideas" gets its own four
// plus the generic memory and reminders. The list is part of the request, and executeTool refuses anything outside
// it, so a chat of one character cannot reach the functions of another even if the model invents the call.
const IDEA_PERSONA_TOOLS = ["idea_spark", "idea_save", "idea_list", "idea_update", "memory_save", "memory_search", "reminder_create"];
const ALL_DEFINITIONS = [...TOOL_DEFINITIONS, ...IDEA_TOOL_DEFINITIONS];

function toolsFor(persona) {
  const names = persona === "ideas" ? IDEA_PERSONA_TOOLS : TOOL_NAMES;

  return { names, definitions: names.map((name) => ALL_DEFINITIONS.find((tool) => tool.function.name === name)) };
}

// `sparks` is the spark history of the chat (src/ideas/recent.js): the running bot shares one with the /spark card.
function createToolContext({ chatId, userId, name = "", isGroup = false, store = getStore(), now = Date.now, rng = R.systemRng, allowed = null, sparks = sparkHistory }) {
  return {
    store,
    chatId: String(chatId),
    userId: String(userId),
    name: sanitizeInline(name, 32),
    isGroup: Boolean(isGroup),
    now,
    rng,
    allowed: allowed ? new Set(allowed) : null,
    sparks
  };
}

function invalid(parsed) {
  return fail("invalid_arguments", { detail: parsed.error });
}

const DICE_SPEC = {
  sides: { type: "enum", values: DICE_SIDES, required: true },
  count: { type: "int", min: 1, max: 10, default: 1 },
  modifier: { type: "int", min: -20, max: 20, default: 0 },
  mode: { type: "enum", values: ["normal", "advantage", "disadvantage"], default: "normal" }
};

function rollDice(args, ctx) {
  const parsed = parseArgs(args, DICE_SPEC);

  if (!parsed.ok) {
    return invalid(parsed);
  }

  const { sides, count, modifier, mode } = parsed.value;

  if (mode !== "normal" && count !== 1) {
    return fail("mode_needs_count_1");
  }

  const rolls = Array.from({ length: mode === "normal" ? count : 2 }, () => ctx.rng.int(1, sides));
  let kept = rolls;

  if (mode === "advantage") {
    kept = [Math.max(...rolls)];
  } else if (mode === "disadvantage") {
    kept = [Math.min(...rolls)];
  }

  const natural = kept.length === 1 ? kept[0] : null;
  let critical = null;

  if (sides === 20 && natural === 20) {
    critical = "success";
  } else if (sides === 20 && natural === 1) {
    critical = "failure";
  }

  return ok({
    sides,
    count,
    mode,
    rolls,
    kept,
    modifier,
    total: kept.reduce((sum, value) => sum + value, 0) + modifier,
    natural,
    critical
  });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stateIsSafe(value, depth = 0) {
  if (depth > R.LIMITS.gameStateDepth) {
    return false;
  }

  if (value && typeof value === "object") {
    return Object.entries(value).every(([key, child]) => !FORBIDDEN_KEYS.has(key) && stateIsSafe(child, depth + 1));
  }

  return true;
}

const GAME_GET_SPEC = { game: { type: "string", min: 1, max: 40 } };
const GAME_SAVE_SPEC = {
  game: { type: "string", min: 1, max: 40, required: true },
  state: { type: "object" },
  delete: { type: "bool", default: false }
};

function gameKey(raw) {
  const key = raw.toLowerCase();
  return GAME_KEY.test(key) ? key : null;
}

function gameStateGet(args, ctx) {
  const parsed = parseArgs(args, GAME_GET_SPEC);

  if (!parsed.ok) {
    return invalid(parsed);
  }

  const key = parsed.value.game === undefined ? undefined : gameKey(parsed.value.game);

  if (parsed.value.game !== undefined && !key) {
    return fail("invalid_game_key", { hint: "Use letters, digits, _ and - (up to 40)." });
  }

  return ctx.store.view((data) => {
    const chat = data.games[ctx.chatId] || {};

    if (!key) {
      return ok({ games: Object.entries(chat).map(([game, entry]) => ({ game, updatedAt: entry.updatedAt })) });
    }

    return chat[key]
      ? ok({ exists: true, game: key, state: chat[key].state, updatedAt: chat[key].updatedAt })
      : ok({ exists: false, game: key });
  });
}

function gameStateSave(args, ctx) {
  const parsed = parseArgs(args, GAME_SAVE_SPEC);

  if (!parsed.ok) {
    return invalid(parsed);
  }

  const key = gameKey(parsed.value.game);

  if (!key) {
    return fail("invalid_game_key", { hint: "Use letters, digits, _ and - (up to 40)." });
  }

  const { state, delete: remove } = parsed.value;

  if (!remove) {
    if (!isPlainObject(state)) {
      return fail("state_must_be_an_object");
    }

    if (!stateIsSafe(state)) {
      return fail("state_too_deep_or_has_forbidden_keys", { maxDepth: R.LIMITS.gameStateDepth });
    }

    const bytes = Buffer.byteLength(JSON.stringify(state));

    if (bytes > R.LIMITS.gameStateBytes) {
      return fail("state_too_large", { bytes, max: R.LIMITS.gameStateBytes });
    }
  }

  return ctx.store.change((data) => {
    const known = Boolean(data.games[ctx.chatId]);
    const chat = data.games[ctx.chatId] ||= {};

    if (remove) {
      if (!chat[key]) {
        return fail("not_found", { game: key });
      }

      delete chat[key];

      if (!Object.keys(chat).length) {
        delete data.games[ctx.chatId];
      }

      return ok({ game: key, deleted: true });
    }

    if (!known && Object.keys(data.games).length >= R.LIMITS.gameChats) {
      return fail("store_full");
    }

    if (!chat[key] && Object.keys(chat).length >= R.LIMITS.gamesPerChat) {
      return fail("too_many_games", { max: R.LIMITS.gamesPerChat });
    }

    chat[key] = { state, updatedAt: ctx.now() };
    return ok({ game: key, saved: true });
  });
}

const FACT_SPEC = { text: { type: "string", min: 2, max: R.LIMITS.factChars, required: true } };
const SEARCH_SPEC = { query: { type: "string", min: 1, max: 100 } };

function factScope(ctx) {
  return `${ctx.chatId}:${ctx.userId}`;
}

function memorySave(args, ctx) {
  const parsed = parseArgs(args, FACT_SPEC);

  if (!parsed.ok) {
    return invalid(parsed);
  }

  const { text } = parsed.value;

  if (looksSecret(text)) {
    return fail("looks_like_a_secret", { hint: "Passwords, card numbers and documents are never saved." });
  }

  return ctx.store.change((data) => {
    const key = factScope(ctx);

    if (!data.facts[key] && Object.keys(data.facts).length >= R.LIMITS.factScopes) {
      return fail("store_full");
    }

    const list = data.facts[key] ||= [];
    // "Любит кофе." and "любит кофе" are one fact, not two.
    const known = list.find((fact) => comparableText(fact.text) === comparableText(text));
    const now = ctx.now();

    if (known) {
      known.at = now;
      return ok({ saved: true, duplicate: true, total: list.length });
    }

    list.push({ text, at: now });

    if (list.length > R.LIMITS.factsPerScope) {
      list.sort((a, b) => a.at - b.at).splice(0, list.length - R.LIMITS.factsPerScope);
    }

    return ok({ saved: true, total: list.length });
  });
}

// The same tokens and normalization as the idea bank (utils/text.js): stems of longer words, "ё" as "е".
function memorySearch(args, ctx) {
  const parsed = parseArgs(args, SEARCH_SPEC);

  if (!parsed.ok) {
    return invalid(parsed);
  }

  const tokens = searchTokens(parsed.value.query);

  return ctx.store.view((data) => {
    const list = data.facts[factScope(ctx)] || [];
    const scored = list.map((fact) => ({
      fact,
      score: tokens.filter((token) => searchText(fact.text).includes(token)).length
    }));
    const hits = tokens.length ? scored.filter((entry) => entry.score > 0) : scored;

    hits.sort((a, b) => b.score - a.score || b.fact.at - a.fact.at);
    return ok({ facts: hits.slice(0, 10).map((entry) => entry.fact.text), total: list.length });
  });
}

// What goes into the prompt without a tool call: the latest facts about this person in this chat.
function recentFacts(store, chatId, userId, limit = 8) {
  return store.view((data) => (data.facts[`${chatId}:${userId}`] || [])
    .slice()
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map((fact) => fact.text));
}

// "Clear memory" forgets what was saved about people in this chat. Characters and games are progress, not memory.
function forgetChat(store, chatId) {
  const prefix = `${chatId}:`;

  if (!store.view((data) => Object.keys(data.facts).some((key) => key.startsWith(prefix)))) {
    return 0;
  }

  return store.change((data) => {
    let removed = 0;

    for (const key of Object.keys(data.facts)) {
      if (key.startsWith(prefix)) {
        delete data.facts[key];
        removed += 1;
      }
    }

    return ok({ removed });
  }).removed;
}

// Every saved fact about one person, in all chats, for /export: { [chatId]: [{ text, saved }] } or undefined.
function factsOf(store, userId) {
  return store.view((data) => {
    const chats = {};

    for (const [scope, list] of Object.entries(data.facts)) {
      const chatId = bank.chatOfScope(scope, userId);

      if (chatId !== null && list.length) {
        chats[chatId] = list.map((fact) => ({ text: fact.text, saved: new Date(fact.at).toISOString().slice(0, 10) }));
      }
    }

    return Object.keys(chats).length ? chats : undefined;
  });
}

// Registered in src/bot.js (src/lifecycle.js) when the functions are on: /reset forgets the facts saved in the chat,
// /export lists them.
const lifecycleHooks = {
  forgetChat: (chatId) => {
    forgetChat(getStore(), chatId);
  },
  exportData: ({ userId }) => factsOf(getStore(), userId)
};

const REMINDER_SPEC = {
  text: { type: "string", min: 1, max: 200, required: true },
  in_minutes: { type: "int", min: 1, max: 525600 },
  at: { type: "string", min: 10, max: 40 },
  idea_id: { type: "string", min: 1, max: 24 }
};

// The idea code is cleaned like everywhere in the bank ("#A1B2C3D4", "a1b2c3d4."); something that is no code at all
// is looked up as is and simply not found.
function reminderCreate(args, ctx) {
  const parsed = parseArgs(args, REMINDER_SPEC);

  if (!parsed.ok) {
    return invalid(parsed);
  }

  const { idea_id: rawIdea, ...request } = parsed.value;
  const ideaId = rawIdea === undefined ? null : bank.normalizeId(rawIdea) || rawIdea;

  return ctx.store.change((data) => scheduleReminder(data, ctx, { ...request, ideaId }));
}

const HANDLERS = {
  roll_dice: rollDice,
  character_get: (args, ctx) => (Object.keys(args || {}).length ? fail("invalid_arguments", { detail: "character_get takes no arguments" }) : getCharacter(ctx)),
  character_update: (args, ctx) => updateCharacter(ctx, args),
  game_state_get: gameStateGet,
  game_state_save: gameStateSave,
  memory_save: memorySave,
  memory_search: memorySearch,
  reminder_create: reminderCreate,
  ...IDEA_HANDLERS
};

// Models differ in how they send arguments. "null" means none. Some wrap the JSON object once more into a JSON
// string ("\"{\\\"count\\\":2}\""): one such level is unwrapped, and anything else that is not an object is left for
// parseArgs to refuse.
function parseToolArguments(raw) {
  if (raw && typeof raw === "object") {
    return raw;
  }

  const text = String(raw ?? "").trim();

  if (text.length > MAX_ARGUMENT_CHARS) {
    throw new Error("ARGUMENTS_TOO_LARGE");
  }

  const value = text ? JSON.parse(text) : {};

  if (typeof value === "string" && value.trim().startsWith("{")) {
    return JSON.parse(value);
  }

  return value ?? {};
}

// Never throws: whatever goes wrong comes back as { ok: false, error, hint }, which the model can read and recover
// from. The hint (companion/hints.js) says what to do next when the function did not say it itself.
function executeTool(name, rawArguments, ctx) {
  if (!Object.hasOwn(HANDLERS, name) || (ctx.allowed && !ctx.allowed.has(name))) {
    return withHint(fail("unknown_tool", { tools: ctx.allowed ? [...ctx.allowed] : TOOL_NAMES }));
  }

  let args;

  try {
    args = parseToolArguments(rawArguments);
  } catch {
    return fail("invalid_json", { hint: "arguments must be one valid JSON object" });
  }

  try {
    const result = HANDLERS[name](args, ctx);

    logger.debug("Companion tool:", name, result.ok ? "ok" : result.error);
    return withHint(result);
  } catch (error) {
    logger.error("Companion tool failed:", name, error);
    return withHint(fail(error?.message === "COMPANION_STORE_SIZE" ? "storage_full" : "storage_error"));
  }
}

module.exports = {
  TOOL_DEFINITIONS,
  TOOL_NAMES,
  IDEA_PERSONA_TOOLS,
  toolsFor,
  createToolContext,
  executeTool,
  recentFacts,
  forgetChat,
  factsOf,
  lifecycleHooks,
  looksSecret
};
