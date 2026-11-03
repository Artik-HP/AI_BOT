const fs = require("fs"), os = require("os"), path = require("path");
const R = require("path").resolve(__dirname, "..", "..", "..");
process.env.LOG_LEVEL = "silent";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aibot-tf-"));
const { CompanionStore, validate } = require(`${R}/src/companion/store`);
const { executeTool, createToolContext, TOOL_DEFINITIONS } = require(`${R}/src/companion/tools`);
const { IDEA_TOOL_DEFINITIONS } = require(`${R}/src/ideas/tools`);
const names = [...TOOL_DEFINITIONS, ...IDEA_TOOL_DEFINITIONS].map((t) => t.function.name);

function rng(seed) { return () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const r = rng(20261103);
const pick = (a) => a[Math.floor(r() * a.length)];
const junkStrings = ["", " ", "a", "x".repeat(300), "😀".repeat(80), "__proto__", "constructor", "prototype", "{\"__proto__\":{\"polluted\":1}}", "-1", "1e9", "NaN", "null", "true", "\u0000", "../../etc/passwd", "'; DROP TABLE x;--", "<script>", "пароль: 12345678", "sk-or-v1-" + "a".repeat(40)];
const junkNumbers = [0, -1, 1, 2, 3, 99, 1e9, -1e9, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 2];
function junk(depth = 0) {
  const k = r();
  if (k < 0.25) return pick(junkStrings);
  if (k < 0.45) return pick(junkNumbers);
  if (k < 0.55) return pick([true, false, null, undefined]);
  if (depth > 5 || k < 0.7) return pick(junkStrings);
  if (k < 0.85) return Array.from({ length: Math.floor(r() * 6) }, () => junk(depth + 1));
  const o = {}; for (let i = 0; i < Math.floor(r() * 6); i += 1) o[pick(["__proto__", "constructor", "action", "name", "game", "state", "id", "text", "title", "pitch", "tags", "amount", "sides", "count", "reason", "stat", "at", "in_minutes", "query", "delete", "confirm", "class", "origin", "stats"])] = junk(depth + 1);
  return o;
}
let now = 1_800_000_000_000;
const store = new CompanionStore(path.join(dir, "rpg.json"), 5 * 1024 * 1024);
let thrown = 0, ok = 0, refused = 0, storeErrors = 0;
const started = Date.now();
for (let i = 0; i < 20000; i += 1) {
  const ctx = createToolContext({ chatId: pick([1, 2, -100500]), userId: pick([11, 12, 13]), name: "Тест", isGroup: r() < 0.3, store, now: () => (now += 1000) });
  const raw = r() < 0.5 ? JSON.stringify(junk()) : junk();
  try {
    const res = executeTool(pick([...names, "nope", "__proto__", "constructor"]), raw, ctx);
    if (res.ok) ok += 1; else { refused += 1; if (/storage_/.test(res.error)) storeErrors += 1; }
  } catch (e) { thrown += 1; if (thrown < 4) console.log("THROWN:", e && e.stack.split("\n").slice(0, 3).join(" | ")); }
}
const valid = (() => { try { validate(JSON.parse(fs.readFileSync(path.join(dir, "rpg.json"), "utf8"))); return true; } catch (e) { return "INVALID: " + e.message; } })();
console.log(JSON.stringify({ calls: 20000, ok, refused, thrown, storeErrors, storeFileValid: valid, polluted: ({}).polluted ?? null, objectProtoKeys: Object.keys(Object.prototype), ms: Date.now() - started, fileKB: Math.round(fs.statSync(path.join(dir, "rpg.json")).size / 1024) }));
