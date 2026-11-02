const { parseArgs, toInteger } = require("./args");
const R = require("./rules");

// Every change to a character goes through here. The model names an action and its inputs; the numbers that
// follow from them (modifiers, HP, level-ups, caps) are computed by the rules, and anything outside the rules
// is refused with a machine-readable error the model can read and correct itself.

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

function noCharacter() {
  return fail("no_character", { hint: "The player has no character yet. Offer to create one (name, origin, class) first." });
}

function parseStats(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "stats must be an object with str, dex, con, int, wis, cha" };
  }

  if (Object.keys(raw).length !== R.ABILITIES.length || !R.ABILITIES.every((key) => Object.hasOwn(raw, key))) {
    return { ok: false, error: "stats must contain exactly str, dex, con, int, wis, cha" };
  }

  const value = {};

  for (const key of R.ABILITIES) {
    const number = toInteger(raw[key]);

    if (number === null) {
      return { ok: false, error: `stats.${key} must be an integer` };
    }

    value[key] = number;
  }

  return { ok: true, value };
}

const SPECS = {
  create: {
    name: { type: "string", min: 1, max: 24, required: true },
    origin: { type: "enum", values: Object.keys(R.ORIGINS), required: true },
    origin_bonus: { type: "enum", values: R.ABILITIES, required: true },
    class: { type: "enum", values: Object.keys(R.CLASSES), required: true },
    trait: { type: "string", min: 1, max: 80 },
    stats: { type: "custom", parse: parseStats },
    random_stats: { type: "bool" },
    hardcore: { type: "bool", default: false }
  },
  award_xp: {
    reason: { type: "enum", values: Object.keys(R.XP_RULES), required: true },
    amount: { type: "int", min: 1, max: 200, required: true },
    stat: { type: "enum", values: R.REAL_WORLD_STATS }
  },
  change_hp: {
    cause: { type: "enum", values: ["damage", "heal", "rest"], required: true },
    amount: { type: "int", min: 1, max: 500 }
  },
  change_gold: {
    reason: { type: "enum", values: [...Object.keys(R.GOLD_EARN), ...Object.keys(R.GOLD_SPEND)], required: true },
    amount: { type: "int", min: 1, max: 500, required: true }
  },
  add_item: {
    name: { type: "string", min: 1, max: 40, required: true },
    source: { type: "enum", values: ["loot", "quest", "purchase", "craft", "start"], required: true },
    rarity: { type: "enum", values: R.RARITIES, default: "common" },
    kind: { type: "enum", values: R.ITEM_KINDS, default: "misc" },
    qty: { type: "int", min: 1, max: 20, default: 1 },
    bonus: { type: "int", min: 0, max: 3, default: 0 },
    armor: { type: "int", min: 0, max: 5, default: 0 },
    price: { type: "int", min: 1, max: 2000 }
  },
  remove_item: {
    name: { type: "string", min: 1, max: 40, required: true },
    reason: { type: "enum", values: ["use", "sale", "lost"], required: true },
    qty: { type: "int", min: 1, max: 20, default: 1 }
  },
  level_choice: {
    stats_up: { type: "list", minItems: 2, maxItems: 2, item: { type: "enum", values: R.ABILITIES } },
    perk: { type: "string", min: 1, max: 100 }
  },
  add_ability: {
    name: { type: "string", min: 1, max: 40, required: true },
    text: { type: "string", min: 1, max: 120, required: true }
  },
  retire: {
    confirm: { type: "bool", required: true }
  }
};

function dayLedger(data, userId, now) {
  const day = R.dayKey(now);
  const current = data.ledger[userId];

  if (current && current.day === day) {
    return current;
  }

  data.ledger[userId] = { day, xp: 0, gold: 0, uses: {} };
  return data.ledger[userId];
}

function brief(character) {
  return {
    level: character.level,
    xp: character.xp,
    xpToNext: character.level >= R.MAX_LEVEL ? null : R.xpForNext(character.level),
    hp: character.hp,
    maxHp: character.maxHp,
    gold: character.gold,
    pending: { ...character.pending }
  };
}

function withSheet(character, extra) {
  return ok({ ...extra, state: brief(character), sheet: R.renderSheet(character) });
}

function retire(data, userId, character, now, fallen) {
  const list = data.retired[userId] ||= [];

  list.push({ ...character, fallen, retiredAt: now });

  while (list.length > R.LIMITS.retiredPerUser) {
    list.shift();
  }

  delete data.characters[userId];
}

function itemKey(item) {
  return [item.name.toLowerCase(), item.rarity, item.kind, item.bonus, item.armor].join("|");
}

const HANDLERS = {
  create(data, ctx, a) {
    if (data.characters[ctx.userId]) {
      return fail("character_exists", { hint: "One character per player. Use action retire, after the player confirms, to start over." });
    }

    if (Object.keys(data.characters).length >= R.LIMITS.characters) {
      return fail("store_full");
    }

    if (a.random_stats && a.stats) {
      return fail("give_stats_or_random_stats");
    }

    let stats;

    if (a.random_stats) {
      stats = R.randomStats(ctx.rng);
    } else if (a.stats) {
      if (!R.isStandardArray(a.stats)) {
        return fail("stats_must_be_standard_array", { values: R.STANDARD_ARRAY });
      }

      stats = { ...a.stats };
    } else {
      return fail("stats_required", { values: R.STANDARD_ARRAY, hint: "Assign 15, 14, 13, 12, 10, 8 to the six abilities, or pass random_stats=true." });
    }

    stats[a.origin_bonus] += 1;

    const now = ctx.now();
    const maxHp = 10 + R.modifier(stats.con);
    const character = {
      name: a.name,
      origin: a.origin,
      trait: a.trait || "",
      class: a.class,
      level: 1,
      xp: 0,
      stats,
      hp: maxHp,
      maxHp,
      gold: R.START_GOLD,
      items: [],
      abilities: [],
      perks: [],
      points: Object.fromEntries(R.REAL_WORLD_STATS.map((key) => [key, 0])),
      pending: { choices: 0, abilities: 0 },
      hardcore: a.hardcore,
      createdAt: now,
      updatedAt: now
    };

    data.characters[ctx.userId] = character;
    return withSheet(character, { action: "create", startGold: R.START_GOLD, startItemsAllowed: R.START_ITEMS_MAX });
  },

  award_xp(data, ctx, a) {
    const character = data.characters[ctx.userId];

    if (!character) {
      return noCharacter();
    }

    const rule = R.XP_RULES[a.reason];

    if (a.amount < rule.min || a.amount > rule.max) {
      return fail("amount_out_of_range", { reason: a.reason, min: rule.min, max: rule.max });
    }

    if (a.reason === "real_world" && !a.stat) {
      return fail("stat_required", { allowed: R.REAL_WORLD_STATS });
    }

    if (a.reason !== "real_world" && a.stat) {
      return fail("stat_only_for_real_world");
    }

    const now = ctx.now();
    const day = dayLedger(data, ctx.userId, now);
    const used = day.uses[a.reason] || 0;

    if (rule.perDay && used >= rule.perDay) {
      return fail("daily_limit_reached", { reason: a.reason, limit: rule.perDay });
    }

    const atMaxLevel = character.level >= R.MAX_LEVEL;
    const cap = R.dailyXpCap(character.level);
    const granted = atMaxLevel ? 0 : Math.max(0, Math.min(a.amount, cap - day.xp));

    // The real-world point is the reward of the deed itself, so it survives an exhausted XP allowance.
    if (granted === 0 && !atMaxLevel && a.reason !== "real_world") {
      return fail("daily_xp_cap_reached", { cap });
    }

    day.xp += granted;
    day.uses[a.reason] = used + 1;

    const levelUps = granted ? R.gainXp(character, granted, ctx.rng) : [];
    let statIncrease = null;

    if (a.reason === "real_world") {
      character.points[a.stat] += 1;

      if (character.points[a.stat] >= R.POINTS_PER_STAT) {
        character.points[a.stat] = 0;

        if (character.stats[a.stat] < R.MAX_STAT) {
          character.stats[a.stat] += 1;
          statIncrease = a.stat;
        }
      }
    }

    character.updatedAt = now;
    return withSheet(character, {
      action: "award_xp",
      reason: a.reason,
      requested: a.amount,
      granted,
      capped: granted < a.amount,
      maxLevel: atMaxLevel,
      levelUps,
      statIncrease,
      realWorldPoints: a.reason === "real_world" ? { stat: a.stat, points: character.points[a.stat], per: R.POINTS_PER_STAT } : undefined
    });
  },

  change_hp(data, ctx, a) {
    const character = data.characters[ctx.userId];

    if (!character) {
      return noCharacter();
    }

    const now = ctx.now();
    character.updatedAt = now;

    if (a.cause === "rest") {
      if (a.amount) {
        return fail("amount_not_allowed_for_rest");
      }

      character.hp = character.maxHp;
      return withSheet(character, { action: "change_hp", cause: "rest" });
    }

    if (!a.amount) {
      return fail("amount_required");
    }

    if (a.cause === "heal") {
      const before = character.hp;

      character.hp = Math.min(character.maxHp, character.hp + a.amount);
      return withSheet(character, { action: "change_hp", cause: "heal", healed: character.hp - before });
    }

    character.hp -= a.amount;

    if (character.hp > 0) {
      return withSheet(character, { action: "change_hp", cause: "damage", damage: a.amount });
    }

    if (character.hardcore) {
      character.hp = 0;
      const sheet = R.renderSheet(character);

      retire(data, ctx.userId, character, now, true);
      return ok({ action: "change_hp", cause: "damage", damage: a.amount, dead: true, sheet });
    }

    const outcome = R.knockoutOutcome(character);
    const goldLost = Math.min(character.gold, Math.max(0, outcome.goldLost));

    character.gold -= goldLost;
    character.hp = Math.max(1, Math.min(character.maxHp, outcome.hp));
    return withSheet(character, { action: "change_hp", cause: "damage", damage: a.amount, knockout: true, goldLost });
  },

  change_gold(data, ctx, a) {
    const character = data.characters[ctx.userId];

    if (!character) {
      return noCharacter();
    }

    const now = ctx.now();
    const earn = R.GOLD_EARN[a.reason];
    const spend = R.GOLD_SPEND[a.reason];
    const range = earn || spend;

    if (a.amount < range.min || a.amount > range.max) {
      return fail("amount_out_of_range", { reason: a.reason, min: range.min, max: range.max });
    }

    if (earn) {
      const day = dayLedger(data, ctx.userId, now);
      const cap = R.dailyGoldCap(character.level);
      const granted = Math.max(0, Math.min(a.amount, cap - day.gold));

      if (granted === 0) {
        return fail("daily_gold_cap_reached", { cap });
      }

      day.gold += granted;
      character.gold += granted;
      character.updatedAt = now;
      return withSheet(character, { action: "change_gold", reason: a.reason, requested: a.amount, delta: granted, capped: granted < a.amount });
    }

    if (a.reason === "purchase" && a.amount > character.gold) {
      return fail("not_enough_gold", { gold: character.gold, cost: a.amount });
    }

    const spent = Math.min(a.amount, character.gold);

    character.gold -= spent;
    character.updatedAt = now;
    return withSheet(character, { action: "change_gold", reason: a.reason, requested: a.amount, delta: -spent });
  },

  add_item(data, ctx, a) {
    const character = data.characters[ctx.userId];

    if (!character) {
      return noCharacter();
    }

    if (R.RARITY_MIN_LEVEL[a.rarity] > character.level) {
      return fail("rarity_too_high_for_level", { rarity: a.rarity, minLevel: R.RARITY_MIN_LEVEL[a.rarity] });
    }

    if (a.bonus > R.BONUS_CAP[a.rarity]) {
      return fail("bonus_too_high_for_rarity", { rarity: a.rarity, max: R.BONUS_CAP[a.rarity] });
    }

    if (a.kind === "armor") {
      if (a.armor > R.ARMOR_CAP[a.rarity]) {
        return fail("armor_too_high_for_rarity", { rarity: a.rarity, max: R.ARMOR_CAP[a.rarity] });
      }
    } else if (a.armor) {
      return fail("armor_only_for_armor_items");
    }

    if (a.source === "purchase") {
      if (!R.PURCHASABLE_RARITIES.includes(a.rarity)) {
        return fail("not_for_sale", { rarity: a.rarity });
      }

      if (!a.price) {
        return fail("price_required_for_purchase");
      }
    } else if (a.price) {
      return fail("price_only_for_purchase");
    }

    if (a.source === "start") {
      if (character.level !== 1 || character.xp !== 0 || a.rarity !== "common") {
        return fail("start_items_are_plain_and_only_at_level_1");
      }

      if (R.itemCount(character) + a.qty > R.START_ITEMS_MAX) {
        return fail("start_kit_full", { max: R.START_ITEMS_MAX });
      }
    }

    if (R.itemCount(character) + a.qty > R.MAX_ITEMS) {
      return fail("backpack_full", { max: R.MAX_ITEMS });
    }

    const cost = a.source === "purchase" ? a.price * a.qty : 0;

    if (cost > character.gold) {
      return fail("not_enough_gold", { gold: character.gold, cost });
    }

    const item = { name: a.name, rarity: a.rarity, kind: a.kind, qty: a.qty, bonus: a.bonus, armor: a.armor };
    const stack = character.items.find((existing) => itemKey(existing) === itemKey(item));

    if (stack) {
      stack.qty += a.qty;
    } else {
      character.items.push(item);
    }

    character.gold -= cost;
    character.updatedAt = ctx.now();
    return withSheet(character, { action: "add_item", added: { name: a.name, qty: a.qty }, goldSpent: cost });
  },

  remove_item(data, ctx, a) {
    const character = data.characters[ctx.userId];

    if (!character) {
      return noCharacter();
    }

    const needle = a.name.toLowerCase();
    const stack = character.items.find((item) => item.name.toLowerCase() === needle);

    if (!stack) {
      return fail("item_not_found", { items: character.items.map((item) => item.name) });
    }

    if (stack.qty < a.qty) {
      return fail("not_enough_items", { have: stack.qty });
    }

    stack.qty -= a.qty;

    if (stack.qty === 0) {
      character.items.splice(character.items.indexOf(stack), 1);
    }

    character.updatedAt = ctx.now();
    return withSheet(character, { action: "remove_item", removed: { name: stack.name, qty: a.qty }, reason: a.reason });
  },

  level_choice(data, ctx, a) {
    const character = data.characters[ctx.userId];

    if (!character) {
      return noCharacter();
    }

    if (!character.pending.choices) {
      return fail("no_choice_pending");
    }

    if (Boolean(a.stats_up) === Boolean(a.perk)) {
      return fail("give_exactly_one_of_stats_up_or_perk");
    }

    if (a.stats_up) {
      if (new Set(a.stats_up).size !== 2) {
        return fail("two_different_stats_required");
      }

      const capped = a.stats_up.find((key) => character.stats[key] >= R.MAX_STAT);

      if (capped) {
        return fail("stat_at_cap", { stat: capped, max: R.MAX_STAT });
      }

      for (const key of a.stats_up) {
        character.stats[key] += 1;
      }
    } else {
      character.perks.push({ text: a.perk, level: character.level });
    }

    character.pending.choices -= 1;
    character.updatedAt = ctx.now();
    return withSheet(character, { action: "level_choice", chose: a.stats_up ? { stats_up: a.stats_up } : { perk: a.perk } });
  },

  add_ability(data, ctx, a) {
    const character = data.characters[ctx.userId];

    if (!character) {
      return noCharacter();
    }

    if (!character.pending.abilities) {
      return fail("no_ability_pending", { levels: R.ABILITY_LEVELS });
    }

    character.abilities.push({ name: a.name, text: a.text, level: character.level });
    character.pending.abilities -= 1;
    character.updatedAt = ctx.now();
    return withSheet(character, { action: "add_ability", added: { name: a.name } });
  },

  retire(data, ctx, a) {
    const character = data.characters[ctx.userId];

    if (!character) {
      return noCharacter();
    }

    if (a.confirm !== true) {
      return fail("confirmation_required", { hint: "Ask the player first; pass confirm=true only after an explicit yes." });
    }

    const sheet = R.renderSheet(character);

    retire(data, ctx.userId, character, ctx.now(), false);
    return ok({ action: "retire", retired: sheet });
  }
};

function updateCharacter(ctx, rawArgs) {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return fail("invalid_arguments", { detail: "arguments must be a JSON object" });
  }

  const { action, ...rest } = rawArgs;
  const name = typeof action === "string" ? action.trim().toLowerCase() : "";

  if (!Object.hasOwn(SPECS, name)) {
    return fail("unknown_action", { actions: Object.keys(SPECS) });
  }

  const parsed = parseArgs(rest, SPECS[name]);

  if (!parsed.ok) {
    return fail("invalid_arguments", { action: name, detail: parsed.error });
  }

  return ctx.store.change((data) => HANDLERS[name](data, ctx, parsed.value));
}

function getCharacter(ctx) {
  return ctx.store.view((data) => {
    const character = data.characters[ctx.userId];

    if (!character) {
      return {
        ok: true,
        exists: false,
        hint: "No character yet. Offer to create one: name, origin, class, and the 15/14/13/12/10/8 ability spread."
      };
    }

    return {
      ok: true,
      exists: true,
      sheet: R.renderSheet(character),
      character: R.characterView(character, data.ledger[ctx.userId], ctx.now())
    };
  });
}

module.exports = {
  SPECS,
  updateCharacter,
  getCharacter
};
