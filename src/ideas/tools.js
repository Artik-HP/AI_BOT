const logger = require("../utils/logger");
const { parseArgs } = require("../companion/args");
const { looksCredential } = require("../companion/secrets");
const bank = require("./bank");
const { TECHNIQUES } = require("./catalog");
const { INGREDIENTS, SHAPE_NAMES, drawSparks, formatSpark, labelOf } = require("./spark");

// The four functions of the "ideas" character, merged into the registry of companion/tools.js. Same rules as there:
// the model never says whose data it means (the owner is the person whose message is answered, ctx.userId, in this
// chat, ctx.chatId), every argument is checked against an explicit spec, and any problem comes back as { ok: false }.

const { IDEA_LIMITS, IDEA_STATUSES } = bank;

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error, extra = {}) => ({ ok: false, error, ...extra });
const invalid = (parsed) => fail("invalid_arguments", { detail: parsed.error });

// Models sometimes send a list as one string ("кофе, город" or "#кофе #город"): split it instead of refusing, then
// check it exactly like a list.
function listOrText(key, rule) {
  return {
    type: "custom",
    parse(raw) {
      const list = typeof raw === "string" ? raw.split(/[,;]|\s+(?=#)/).map((part) => part.trim()).filter(Boolean) : raw;
      const parsed = parseArgs({ [key]: list }, { [key]: rule });

      return parsed.ok ? { ok: true, value: parsed.value[key] } : parsed;
    }
  };
}

const TAGS_RULE = listOrText("tags", { type: "list", maxItems: IDEA_LIMITS.tags, item: { type: "string", min: 1, max: IDEA_LIMITS.tagChars } });

// An ingredient is named by its key ("twist") or by the word on the card ("поворот").
const INGREDIENT_RULE = {
  type: "custom",
  parse(raw) {
    const text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    const found = INGREDIENTS.find((ingredient) => ingredient === text || labelOf(ingredient).toLowerCase() === text);

    return found ? { ok: true, value: found } : { ok: false, error: `reroll items must be some of: ${INGREDIENTS.join(", ")}` };
  }
};

// A technique is named by its id ("analogy") or by its name ("Аналогия").
const TECHNIQUE_RULE = {
  type: "custom",
  parse(raw) {
    const text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    const found = TECHNIQUES.find((technique) => technique.id === text || technique.name.toLowerCase() === text);

    return found ? { ok: true, value: found.id } : { ok: false, error: `technique must be one of: ${TECHNIQUES.map((entry) => entry.id).join(", ")}` };
  }
};

const IDEA_TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "idea_spark",
      description: "Draw random creative seeds with the server's fair random generator. A spark combines two to four ingredients (area, constraint, twist, and sometimes the audience the idea is for) and comes with a thinking technique to apply. Use it when the person asks to be surprised, names no topic, is stuck, or your ideas start to look alike; never invent 'random' words yourself. Recent sparks of this chat are not repeated. When the person wants to change only part of the last spark ('another twist', 'add who it is for'), call it with reroll instead of drawing a new one. Build the ideas around the returned ingredients and show briefly what was drawn (cards holds the ready lines).",
      parameters: {
        type: "object",
        properties: {
          count: { type: "integer", minimum: 1, maximum: 3, description: "How many different sparks (default 1)" },
          shape: { type: "string", enum: SHAPE_NAMES, description: "Which ingredients: minimal (area and twist, the most freedom), classic, audience_twist, audience_constraint, maximal (all four, the most concrete). Omit to let the server choose" },
          technique: { type: "string", enum: TECHNIQUES.map((technique) => technique.id), description: "Use this technique instead of a random one, when the person asked for a specific one" },
          reroll: { type: "array", items: { type: "string", enum: INGREDIENTS }, maxItems: INGREDIENTS.length, description: "Redraw only these ingredients of the last single spark in this chat and keep the rest; an ingredient it did not have is added. Not combined with count or shape" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "idea_save",
      description: "Keep an idea in the person's idea bank. Call it only when the person asks to save it or agrees to your offer. Saving a title that is already in the bank updates that idea. Passwords, card numbers and keys are refused. Returns the idea's code.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short name of the idea, up to 80 characters" },
          pitch: { type: "string", description: "The idea in one to three sentences, up to 600 characters" },
          tags: { type: "array", items: { type: "string" }, maxItems: IDEA_LIMITS.tags, description: "Up to 5 short tags" },
          next_step: { type: "string", description: "The nearest concrete step, up to 200 characters" }
        },
        required: ["title", "pitch"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "idea_list",
      description: "Look through the person's saved ideas, newest first. With a query, the ideas that contain its words come first. Use it when the person asks what they already have, or before building on or repeating an earlier idea. has_more=true means there is a next page: call again with offset.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Words to look for in titles, pitches and tags" },
          status: { type: "string", enum: IDEA_STATUSES, description: "Only ideas with this status" },
          limit: { type: "integer", minimum: 1, maximum: IDEA_LIMITS.listMax, description: "How many to return (default 10)" },
          offset: { type: "integer", minimum: 0, maximum: IDEA_LIMITS.perScope, description: "How many to skip, for the next page (default 0)" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "idea_update",
      description: "Change a saved idea (title, pitch, tags, next step, status) or delete it with delete=true. The id is the 8-character code from idea_save or idea_list. Delete only after the person asked for it.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The idea's code" },
          title: { type: "string" },
          pitch: { type: "string" },
          tags: { type: "array", items: { type: "string" }, maxItems: IDEA_LIMITS.tags, description: "Replaces the tags; an empty list clears them" },
          next_step: { type: "string" },
          status: { type: "string", enum: IDEA_STATUSES, description: "new, exploring (being worked on), done, parked (set aside)" },
          delete: { type: "boolean" }
        },
        required: ["id"]
      }
    }
  }
];

const SPARK_SPEC = {
  count: { type: "int", min: 1, max: 3, default: 1 },
  shape: { type: "enum", values: SHAPE_NAMES },
  technique: TECHNIQUE_RULE,
  reroll: listOrText("reroll", { type: "list", minItems: 1, maxItems: INGREDIENTS.length, item: INGREDIENT_RULE })
};

// With a spark history in the context (the running bot: src/ideas/recent.js) the chat's recent sparks are avoided and
// a reroll can change the last one; without it (some tests) every draw is independent.
function ideaSpark(args, ctx) {
  const parsed = parseArgs(args, SPARK_SPEC);

  if (!parsed.ok) {
    return invalid(parsed);
  }

  const { count, shape, technique, reroll } = parsed.value;

  // A reroll changes one existing spark, so it has neither a number of sparks nor a shape of its own.
  if (reroll && (count !== 1 || shape)) {
    return fail("reroll_takes_no_count_or_shape");
  }

  const options = { count, shape, technique, reroll: reroll ? [...new Set(reroll)] : undefined };

  try {
    const drawn = ctx.sparks ? ctx.sparks.draw(ctx.chatId, ctx.rng, options) : drawSparks(ctx.rng, options);

    if (!drawn.ok) {
      return fail(drawn.error);
    }

    const { id, name, how } = drawn.technique;

    return ok({
      sparks: drawn.sparks,
      technique: { id, name, how },
      cards: drawn.sparks.map(formatSpark),
      ...(options.reroll ? { rerolled: options.reroll } : {})
    });
  } catch (error) {
    logger.error("Idea spark failed:", error);
    return fail("spark_unavailable");
  }
}

function cleanTags(tags) {
  return [...new Set(tags.map((tag) => tag.replace(/^#+/, "").trim().toLowerCase()).filter(Boolean))];
}

const SAVE_SPEC = {
  title: { type: "string", min: 2, max: IDEA_LIMITS.titleChars, required: true },
  pitch: { type: "string", min: 5, max: IDEA_LIMITS.pitchChars, required: true },
  tags: TAGS_RULE,
  next_step: { type: "string", min: 2, max: IDEA_LIMITS.nextChars }
};

function ideaSave(args, ctx) {
  const parsed = parseArgs(args, SAVE_SPEC);

  if (!parsed.ok) {
    return invalid(parsed);
  }

  const { title, pitch, tags = [], next_step: next = "" } = parsed.value;

  if (looksCredential([title, pitch, next, ...tags].join(" "))) {
    return fail("looks_like_a_secret", { hint: "Passwords, card numbers and keys are never saved." });
  }

  return ctx.store.change((data) => bank.addIdea(
    data,
    bank.scopeKey(ctx.chatId, ctx.userId),
    { title, pitch, tags: cleanTags(tags), next },
    ctx.now()
  ));
}

const LIST_SPEC = {
  query: { type: "string", min: 1, max: 100 },
  status: { type: "enum", values: IDEA_STATUSES },
  limit: { type: "int", min: 1, max: IDEA_LIMITS.listMax, default: 10 },
  offset: { type: "int", min: 0, max: IDEA_LIMITS.perScope, default: 0 }
};

function ideaList(args, ctx) {
  const parsed = parseArgs(args, LIST_SPEC);

  if (!parsed.ok) {
    return invalid(parsed);
  }

  return ok(ctx.store.view((data) => bank.listIdeas(data, bank.scopeKey(ctx.chatId, ctx.userId), parsed.value)));
}

// The id is checked after cleaning (bank.normalizeId), so a copied "#A1B2C3D4" is accepted.
const UPDATE_SPEC = {
  id: { type: "string", min: 1, max: 24, required: true },
  title: { type: "string", min: 2, max: IDEA_LIMITS.titleChars },
  pitch: { type: "string", min: 5, max: IDEA_LIMITS.pitchChars },
  tags: TAGS_RULE,
  next_step: { type: "string", min: 2, max: IDEA_LIMITS.nextChars },
  status: { type: "enum", values: IDEA_STATUSES },
  delete: { type: "bool", default: false }
};

function ideaUpdate(args, ctx) {
  const parsed = parseArgs(args, UPDATE_SPEC);

  if (!parsed.ok) {
    return invalid(parsed);
  }

  const { id, delete: remove, ...changes } = parsed.value;
  const code = bank.normalizeId(id);

  if (!code) {
    return fail("invalid_id", { hint: "The id is the 8-character code from idea_save or idea_list." });
  }

  if (!remove && !Object.keys(changes).length) {
    return fail("nothing_to_change");
  }

  if (changes.tags) {
    changes.tags = cleanTags(changes.tags);
  }

  if (!remove && looksCredential([changes.title, changes.pitch, changes.next_step, ...(changes.tags || [])].filter(Boolean).join(" "))) {
    return fail("looks_like_a_secret", { hint: "Passwords, card numbers and keys are never saved." });
  }

  return ctx.store.change((data) => bank.updateIdea(data, bank.scopeKey(ctx.chatId, ctx.userId), code, changes, remove, ctx.now()));
}

const IDEA_HANDLERS = {
  idea_spark: ideaSpark,
  idea_save: ideaSave,
  idea_list: ideaList,
  idea_update: ideaUpdate
};

module.exports = {
  IDEA_TOOL_DEFINITIONS,
  IDEA_HANDLERS
};
