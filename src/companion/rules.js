const crypto = require("crypto");

// Game rules of the companion persona (a simplified D&D, see src/companion/prompt.md).
// Everything here is pure: no files, no clock, no network. The model proposes changes, this module decides.

const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"];
const ABILITY_LABELS = { str: "СИЛ", dex: "ЛОВ", con: "ВЫН", int: "ИНТ", wis: "МДР", cha: "ХАР" };

const ORIGINS = {
  human: { label: "человек", emoji: "🧑" },
  elf: { label: "эльф", emoji: "🧝" },
  dwarf: { label: "дварф", emoji: "🧔" },
  orc: { label: "орк", emoji: "💪" },
  halfling: { label: "полурослик", emoji: "🍀" }
};

const CLASSES = {
  warrior: "воин",
  rogue: "плут",
  mage: "маг",
  cleric: "жрец",
  ranger: "следопыт",
  bard: "бард",
  alchemist: "алхимик"
};

const RARITIES = ["common", "uncommon", "rare", "epic", "legendary"];
const ITEM_KINDS = ["weapon", "armor", "potion", "misc"];

const MAX_LEVEL = 20;
const MAX_STAT = 20;
const MAX_ITEMS = 20;
const START_GOLD = 20;
const START_ITEMS_MAX = 4;
const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];
const ABILITY_LEVELS = [3, 6, 10];
const CHOICE_EVERY = 4;
const POINTS_PER_STAT = 10;
const REAL_WORLD_STATS = ["str", "con", "int", "wis", "cha"];
const KNOCKOUT_GOLD_SHARE = 0.1;

// XP table from the prompt. Each call is checked against its row; `perDay` is a hard daily count.
const XP_RULES = {
  quiz: { min: 5, max: 5 },
  minigame: { min: 5, max: 15 },
  daily_task: { min: 20, max: 20, perDay: 1 },
  quest: { min: 25, max: 100 },
  combat: { min: 25, max: 100 },
  dungeon: { min: 100, max: 200 },
  real_world: { min: 10, max: 10, perDay: 3 }
};

const GOLD_EARN = {
  quest: { min: 10, max: 50 },
  loot: { min: 1, max: 100 },
  sale: { min: 1, max: 200 }
};

const GOLD_SPEND = {
  purchase: { min: 1, max: 500 },
  penalty: { min: 1, max: 500 }
};

const RARITY_MIN_LEVEL = { common: 1, uncommon: 1, rare: 3, epic: 8, legendary: 15 };
const BONUS_CAP = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 3 };
const ARMOR_CAP = { common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 5 };
const PURCHASABLE_RARITIES = ["common", "uncommon", "rare"];

// Storage ceilings. They keep one noisy chat or one runaway model from filling the disk.
const LIMITS = {
  characters: 5000,
  retiredPerUser: 5,
  gameChats: 2000,
  gamesPerChat: 20,
  gameStateBytes: 8192,
  gameStateDepth: 6,
  factScopes: 5000,
  factsPerScope: 40,
  factChars: 200,
  remindersPerUser: 10,
  remindersPerChat: 30,
  remindersTotal: 2000
};

const systemRng = {
  // Inclusive on both ends.
  int(min, max) {
    return crypto.randomInt(min, max + 1);
  }
};

function modifier(score) {
  return Math.floor((score - 10) / 2);
}

function formatModifier(value) {
  if (value > 0) {
    return `+${value}`;
  }

  return value < 0 ? `−${Math.abs(value)}` : "0";
}

function xpForNext(level) {
  return 100 * level;
}

function dayKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

// How much XP one character may earn per UTC day, as a function of level (1..20).
// Every call is already bounded by XP_RULES, but nothing limits how many calls happen in a day, so this
// number is what stops a generous (or talked-into-it) model from minting levels. Trade-offs to weigh:
// a flat cap is easy to reason about but, since level N needs 100 * N XP, it slows late levels more and more;
// a cap that grows with level keeps pace but lets a high-level farmer gain more per day.
// The gold cap is derived from this value (see dailyGoldCap). Tests only assume a positive integer.
// Deliberately read at the character's current level on every award, so the cap rises within the day as levels
// are gained: on day one a fresh character can reach level 4 (700 XP against the nominal 400). To make it a fixed
// daily budget instead, save the level in the ledger entry (dayLedger in characters.js) and use that.
function dailyXpCap(level) {
  return 300 + 100 * level;
}

function dailyGoldCap(level) {
  return Math.max(50, Math.ceil(dailyXpCap(level) / 2));
}

// 0 HP is a knockout, not death: the character wakes up in a tavern and loses part of the gold.
function knockoutOutcome(character) {
  return {
    goldLost: Math.floor(character.gold * KNOCKOUT_GOLD_SHARE),
    hp: Math.max(1, Math.floor(character.maxHp / 2))
  };
}

function armorBonus(character) {
  return character.items.reduce((best, item) => (item.kind === "armor" ? Math.max(best, item.armor || 0) : best), 0);
}

function armorClass(character) {
  return 10 + modifier(character.stats.dex) + armorBonus(character);
}

function itemCount(character) {
  return character.items.reduce((total, item) => total + item.qty, 0);
}

function isStandardArray(stats) {
  if (!stats || !ABILITIES.every((key) => Number.isInteger(stats[key]))) {
    return false;
  }

  const sorted = ABILITIES.map((key) => stats[key]).sort((a, b) => b - a);
  return sorted.every((value, index) => value === STANDARD_ARRAY[index]);
}

function shuffle(list, rng) {
  const copy = [...list];

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = rng.int(0, index);
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }

  return copy;
}

function randomStats(rng) {
  const values = shuffle(STANDARD_ARRAY, rng);
  return Object.fromEntries(ABILITIES.map((key, index) => [key, values[index]]));
}

// Adds XP and applies every level-up it pays for. The surplus carries over to the next level.
function gainXp(character, amount, rng) {
  const levelUps = [];

  if (character.level >= MAX_LEVEL) {
    return levelUps;
  }

  character.xp += amount;

  while (character.level < MAX_LEVEL && character.xp >= xpForNext(character.level)) {
    character.xp -= xpForNext(character.level);
    character.level += 1;

    const hpGain = Math.max(1, rng.int(1, 8) + modifier(character.stats.con));
    character.maxHp += hpGain;
    character.hp += hpGain;

    if (character.level % CHOICE_EVERY === 0) {
      character.pending.choices += 1;
    }

    if (ABILITY_LEVELS.includes(character.level)) {
      character.pending.abilities += 1;
    }

    levelUps.push({ level: character.level, hpGain });
  }

  if (character.level >= MAX_LEVEL) {
    character.xp = 0;
  }

  return levelUps;
}

function formatItem(item) {
  return `${item.name}${item.bonus ? ` +${item.bonus}` : ""}${item.qty > 1 ? ` ×${item.qty}` : ""}`;
}

// The four-line sheet from the prompt. The model is told to show it as is, so the numbers come from here.
function renderSheet(character) {
  const origin = ORIGINS[character.origin];
  const progress = character.level >= MAX_LEVEL ? "MAX" : `${character.xp}/${xpForNext(character.level)}`;
  const stats = ABILITIES
    .map((key) => `${ABILITY_LABELS[key]} ${character.stats[key]} (${formatModifier(modifier(character.stats[key]))})`)
    .join(" ");
  const bag = character.items.length ? character.items.map(formatItem).join(", ") : "пусто";

  return [
    `${origin.emoji} ${character.name}, ${origin.label}-${CLASSES[character.class]}, ур. ${character.level} (XP ${progress})`,
    `❤️ ${character.hp}/${character.maxHp} | 🛡 КЗ ${armorClass(character)} | 💰 ${character.gold}`,
    stats,
    `🎒 ${bag}`
  ].join("\n");
}

function characterView(character, ledger, now) {
  const today = ledger && ledger.day === dayKey(now) ? ledger : { xp: 0, gold: 0, uses: {} };

  return {
    name: character.name,
    origin: character.origin,
    class: character.class,
    trait: character.trait,
    hardcore: character.hardcore,
    level: character.level,
    xp: character.xp,
    xpToNext: character.level >= MAX_LEVEL ? null : xpForNext(character.level),
    hp: character.hp,
    maxHp: character.maxHp,
    armorClass: armorClass(character),
    gold: character.gold,
    stats: Object.fromEntries(ABILITIES.map((key) => [key, { score: character.stats[key], mod: modifier(character.stats[key]) }])),
    items: character.items,
    abilities: character.abilities,
    perks: character.perks,
    realWorldPoints: character.points,
    pending: character.pending,
    today: {
      xp: today.xp,
      xpCap: dailyXpCap(character.level),
      goldEarned: today.gold,
      goldCap: dailyGoldCap(character.level),
      dailyTaskDone: (today.uses.daily_task || 0) >= XP_RULES.daily_task.perDay,
      realWorldLeft: Math.max(0, XP_RULES.real_world.perDay - (today.uses.real_world || 0))
    }
  };
}

module.exports = {
  ABILITIES,
  ABILITY_LABELS,
  ORIGINS,
  CLASSES,
  RARITIES,
  ITEM_KINDS,
  MAX_LEVEL,
  MAX_STAT,
  MAX_ITEMS,
  START_GOLD,
  START_ITEMS_MAX,
  STANDARD_ARRAY,
  ABILITY_LEVELS,
  CHOICE_EVERY,
  POINTS_PER_STAT,
  REAL_WORLD_STATS,
  XP_RULES,
  GOLD_EARN,
  GOLD_SPEND,
  RARITY_MIN_LEVEL,
  BONUS_CAP,
  ARMOR_CAP,
  PURCHASABLE_RARITIES,
  LIMITS,
  systemRng,
  modifier,
  formatModifier,
  xpForNext,
  dayKey,
  dailyXpCap,
  dailyGoldCap,
  knockoutOutcome,
  armorClass,
  itemCount,
  isStandardArray,
  randomStats,
  gainXp,
  renderSheet,
  characterView
};
