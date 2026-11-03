const fs = require("fs"), os = require("os"), path = require("path");
const R = require("path").resolve(__dirname, "..", "..", "..");
process.env.LOG_LEVEL = "silent";
const { CompanionStore, emptyData } = require(`${R}/src/companion/store`);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aibot-cost-"));

// Companion store filled to ~4.5 MB (cap 5 MB): ideas of many people
const store = new CompanionStore(path.join(dir, "rpg.json"), 5 * 1024 * 1024);
const data = emptyData();
for (let u = 0; u < 380; u += 1) {
  data.ideas[`${u}:${u}`] = Array.from({ length: 6 }, (_, i) => ({ id: String(i).padStart(8, "0"), title: "Идея " + i + " ".repeat(10), pitch: "п".repeat(560), tags: ["a", "b"], next: "н".repeat(180), status: "new", createdAt: 1, updatedAt: 1 }));
}
store.open(); store.publish(data); store.data = data;
const bytes = fs.statSync(path.join(dir, "rpg.json")).size;
const times = [];
for (let i = 0; i < 15; i += 1) {
  const t = process.hrtime.bigint();
  store.change((d) => { d.facts["1:1"] = [{ text: "факт " + i, at: i }]; return { ok: true }; });
  times.push(Number(process.hrtime.bigint() - t) / 1e6);
}
times.sort((a, b) => a - b);
console.log(`companion store ${(bytes / 1048576).toFixed(1)} MB: one tool call = ${times[7].toFixed(0)} ms median, ${times[14].toFixed(0)} ms worst (event loop is blocked for that long)`);

// Lab store ~8 MB
const { LabStore } = require(`${R}/src/lab/store`);
const labFile = path.join(dir, "lab.json");
const lab = new LabStore(labFile, 10 * 1024 * 1024);
const scopes = {};
for (let u = 1; u <= 30; u += 1) {
  const e = () => ({ id: require("crypto").randomBytes(12).toString("hex") });
  scopes[`${u}:${u}`] = { projects: [], experiments: [], tracks: [], operations: [], callbacks: [],
    artifacts: Array.from({ length: 30 }, () => ({ ...e(), kind: "html", code: "x".repeat(9000), projectId: null })) };
}
fs.writeFileSync(labFile, JSON.stringify({ version: 1, scopes }));
const labBytes = fs.statSync(labFile).size;
const lt = [];
for (let i = 0; i < 10; i += 1) {
  const t = process.hrtime.bigint();
  lab.change({ chatId: 1, userId: 1 }, (scope) => { scope.session = { active: true, trackId: null, n: i }; });
  lt.push(Number(process.hrtime.bigint() - t) / 1e6);
}
lt.sort((a, b) => a - b);
console.log(`lab store ${(labBytes / 1048576).toFixed(1)} MB: one button press = ${lt[5].toFixed(0)} ms median, ${lt[9].toFixed(0)} ms worst`);
lab.close();
