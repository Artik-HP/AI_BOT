// Shared pieces of the companion tests: a throw-away store, a controllable clock and a scripted dice.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { CompanionStore } = require("../../src/companion/store");

const START = Date.UTC(2026, 9, 29, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

// Returns the scripted numbers in turn, clamped into the range the caller asked for.
function fixedRng(values) {
  let index = 0;

  return {
    int(min, max) {
      const value = values[index % values.length];

      index += 1;
      return Math.min(max, Math.max(min, value));
    }
  };
}

function createWorld({ maxBytes } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aibot-companion-"));
  const file = path.join(dir, "rpg.json");
  const clock = { now: START };
  const store = new CompanionStore(file, maxBytes);
  const ctxFor = (userId = "100", chatId = userId, extra = {}) => ({
    store,
    chatId: String(chatId),
    userId: String(userId),
    name: "Вася",
    isGroup: false,
    now: () => clock.now,
    rng: fixedRng([5]),
    ...extra
  });

  return { dir, file, store, clock, ctxFor };
}

// Edits a stored character directly, to set up a situation without replaying hundreds of calls.
function patchCharacter(world, userId, mutate) {
  world.store.change((data) => {
    mutate(data.characters[userId], data);
    return { ok: true };
  });
}

const CREATE_ELF = {
  action: "create",
  name: "Лира",
  origin: "elf",
  origin_bonus: "dex",
  class: "rogue",
  trait: "острый слух",
  stats: { str: 8, dex: 15, con: 13, int: 12, wis: 10, cha: 14 }
};

module.exports = { START, DAY, fixedRng, createWorld, patchCharacter, CREATE_ELF };
