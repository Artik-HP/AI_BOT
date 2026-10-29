const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");
const { LabStore, id } = require("../../src/lab/store");
const { LabService } = require("../../src/lab/service");
const schema = require("../../src/lab/schemas");
const fixtures = require("../helpers/labFixtures");
const { LabTelegram } = require("../../src/lab/telegram");
const ctx = { chatId: 500, userId: 500 };
const other = { chatId: 501, userId: 501 };

function setup(t, complete) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lab-unit-"));
  const store = new LabStore(path.join(dir, "state.json"));
  const service = new LabService({ store, complete });
  t.after(() => store.close());
  return { service, store, dir };
}

test("lab: idea → plan → project survives reload and is private", async (t) => {
  let n = 0;
  const { service, store } = setup(t, async () => fixtures.completion(n++ ? fixtures.plan : fixtures.ideas));
  const ideas = await service.ideas(ctx, "i1", "JavaScript для магазина");
  const plan = await service.plan(ctx, "p1", ideas[0]);
  const project = service.saveProject(ctx, ideas[0], plan);
  store.close();
  assert.equal(service.get(ctx, "projects", project.id).plan.output, "120");
  assert.throws(() => service.get(other, "projects", project.id), /NOT_FOUND/);
  assert.throws(() => service.data({ chatId: 500, userId: 501 }), /PRIVATE_ONLY/);
});

test("lab store: second writer blocked; malformed primary recovered with original preserved", (t) => {
  const { store } = setup(t);
  store.change(ctx, (scope) => { scope.projects.push({ id: id(), title: "first" }); });
  store.change(ctx, (scope) => { scope.projects[0].title = "second"; });
  const second = new LabStore(store.filename);
  assert.throws(() => second.read(ctx), /LOCKED/);
  store.close();
  fs.writeFileSync(store.filename, "{broken");
  assert.equal(second.read(ctx).projects[0].title, "first");
  second.close();
  assert.ok(fs.readdirSync(path.dirname(store.filename)).some((file) => file.includes("corrupt-")));
});

test("lab store: no backup means safe refusal; failed publish preserves committed state", (t) => {
  const { store } = setup(t);
  fs.writeFileSync(store.filename, "broken");
  assert.throws(() => store.read(ctx));
  assert.equal(fs.readFileSync(store.filename, "utf8"), "broken");
  store.close(); fs.unlinkSync(store.filename);
  store.change(ctx, (scope) => { scope.projects.push({ id: id(), title: "keep" }); });
  const original = store.publish;
  store.publish = () => { throw new Error("DISK_FAILURE"); };
  assert.throws(() => store.change(ctx, (scope) => { scope.projects[0].title = "lost"; }), /DISK_FAILURE/);
  assert.equal(store.read(ctx).projects[0].title, "keep");
  store.publish = original;
});

test("lab store: limits and interrupted operation are enforced", (t) => {
  const { store } = setup(t);
  store.change(ctx, (scope) => { scope.operations.push({ id: id(), at: Date.now(), eventId: "x", status: "running" }); });
  store.close();
  assert.equal(store.read(ctx).operations[0].status, "unknown");
  assert.throws(() => store.change(ctx, (scope) => { scope.projects = Array.from({ length: 31 }, () => ({ id: id() })); }), /LIMIT/);
  assert.equal(store.read(ctx).projects.length, 0);
});

test("lab store: transient Windows EPERM retries publication once without repeating mutation", (t) => {
  const { store } = setup(t);
  store.read(ctx);
  const rename = fs.renameSync;
  let publications = 0;
  let mutations = 0;
  fs.renameSync = (...args) => {
    if (++publications === 1) throw Object.assign(new Error("reader holds file"), { code: "EPERM" });
    return rename(...args);
  };
  try {
    store.change(ctx, (scope) => { mutations++; scope.projects.push({ id: id(), title: "saved" }); });
    assert.equal(mutations, 1); assert.equal(publications, 2);
    assert.equal(store.read(ctx).projects[0].title, "saved");
  } finally { fs.renameSync = rename; }
});

test("lab experiments: exactly two calls, shared input, deterministic checks, duplicate rejected", async (t) => {
  const calls = [];
  const { service } = setup(t, async (messages, options) => { calls.push({ messages, options }); return fixtures.completion("400 ml"); });
  const spec = service.prepareExperiment({ task: "Товар", input: "400 ml", a: "Кратко", b: "Подробно", maxChars: 20, words: ["400"] });
  const exp = await service.experiment(ctx, "run1", spec);
  assert.equal(calls.length, 2); assert.equal(exp.status, "completed");
  assert.equal(calls[0].messages[1].content, calls[1].messages[1].content);
  assert.equal(exp.runs[0].checks.requiredWords[0].present, true);
  await assert.rejects(service.experiment(ctx, "run1", spec), /DUPLICATE/);
  assert.equal(calls.length, 2);
});

test("lab experiments: partial failure and confirmed retry only repeats failed B", async (t) => {
  let n = 0;
  const { service } = setup(t, async () => { if (++n === 2) throw Object.assign(new Error("fake"), { status: 429 }); return fixtures.completion("ok"); });
  const spec = service.prepareExperiment({ task: "t", input: "i", a: "A", b: "B" });
  const exp = await service.experiment(ctx, "run1", spec);
  assert.equal(exp.status, "partial");
  const retried = await service.experiment(ctx, "retry1", spec, exp.id);
  assert.equal(n, 3); assert.equal(retried.status, "completed");
});

test("lab experiments: cancel during A prevents B; no automatic replay after restart", async (t) => {
  let resolve;
  let calls = 0;
  const { service, store } = setup(t, () => { calls++; return new Promise((done) => { resolve = done; }); });
  const spec = service.prepareExperiment({ task: "t", input: "i", a: "A", b: "B" });
  const running = service.experiment(ctx, "run1", spec);
  assert.equal(service.cancel(ctx), true);
  resolve(fixtures.completion("A"));
  await assert.rejects(running, /CANCELLED/);
  assert.equal(calls, 1);
  store.close();
  assert.equal(service.data(ctx).experiments[0].runs[0].text, "A");
  assert.equal(service.data(ctx).experiments[0].runs[1].status, "planned");
  assert.equal(calls, 1);
});

test("lab requests: ambiguous timeout isn't retried and daily quota is durable", async (t) => {
  let calls = 0;
  const { service } = setup(t, async () => { calls++; throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }); });
  await assert.rejects(service.ideas(ctx, "i1", "idea"), /REQUEST_UNKNOWN/);
  assert.equal(calls, 1); assert.equal(service.data(ctx).operations[0].status, "unknown");
  service.store.change(ctx, (scope) => { scope.quota.used = 10000; });
  await assert.rejects(service.ideas(ctx, "i2", "idea"), /QUOTA/);
  assert.equal(calls, 1);
});

test("lab shutdown: hanging provider does not block ordinary chat flush or release active writer", async (t) => {
  let resolve;
  const { service, store } = setup(t, () => new Promise((done) => { resolve = done; }));
  const running = service.ideas(ctx, "shutdown-request", "idea");
  const lab = new LabTelegram({}, service);
  await lab.close(10);
  assert.equal(store.locked, true);
  assert.equal(service.active.size, 1);
  resolve(fixtures.completion(fixtures.ideas));
  await assert.rejects(running, /CANCELLED/);
  await lab.close();
  assert.equal(store.locked, false);
});

test("lab learning: wrong answer, yes, corrected answer, duplicate and restart", async (t) => {
  const { service, store } = setup(t, async () => { throw new Error("Should not call AI"); });
  const track = service.startTrack(ctx, "javascript", "beginner");
  assert.equal((await service.checkAnswer(ctx, "a1", track.id, "да")).status, "needs_work");
  assert.equal((await service.checkAnswer(ctx, "a2", track.id, "7")).status, "needs_work");
  assert.equal((await service.checkAnswer(ctx, "a3", track.id, "8")).status, "correct");
  await assert.rejects(service.checkAnswer(ctx, "a3", track.id, "8"), /DUPLICATE/);
  service.trackAction(ctx, track.id, "next"); store.close();
  const resumed = service.lesson(ctx, track.id);
  assert.equal(resumed.track.current, 1); assert.equal(resumed.track.solved.length, 1);
  assert.equal(resumed.track.attempts.length, 3);
});

test("lab learning: invalid AI review never advances progress; Python basic available", async (t) => {
  const { service } = setup(t, async () => fixtures.completion({ status: "correct", criteriaMet: false }));
  const track = service.startTrack(ctx, "python", "basic");
  await assert.rejects(service.checkAnswer(ctx, "code1", track.id, "print(3)"), /INVALID_REVIEW/);
  assert.equal(service.lesson(ctx, track.id).track.solved.length, 0);
  assert.throws(() => service.trackAction(ctx, track.id, "next"), /NOT_SOLVED/);
});

test("lab artifacts: owner, generated filename, hash, export and deletion backup", async (t) => {
  const { service, store } = setup(t, async () => fixtures.completion({ ...fixtures.artifact(), filename: "../../secret" }));
  const project = service.saveProject(ctx, fixtures.idea);
  const artifact = await service.artifact(ctx, "tool1", { kind: "html", request: "Calculator", projectId: project.id });
  assert.match(artifact.filename, /^lab-tool-[a-f0-9]+\.html$/);
  assert.equal(artifact.contentHash.length, 64);
  assert.throws(() => service.get(other, "artifacts", artifact.id), /NOT_FOUND/);
  assert.equal(JSON.parse(service.export(ctx, project.id)).artifacts.length, 1);
  service.deleteProject(ctx, project.id);
  assert.equal(service.data(ctx).artifacts.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(`${store.filename}.bak`)).scopes["500:500"].projects.length, 0);
  service.startTrack(ctx, "python", "beginner");
  assert.equal(JSON.parse(service.exportAll(ctx)).tracks.length, 1);
  const reserved = service.data(ctx).quota.used;
  service.clear(ctx);
  assert.equal(service.data(ctx).tracks.length, 0);
  assert.equal(service.data(ctx).quota.used, reserved);
  assert.equal(JSON.parse(fs.readFileSync(`${store.filename}.bak`)).scopes["500:500"].tracks.length, 0);
});

test("lab schema: truncated code, unknown kinds and unsafe runtime constructs rejected", () => {
  assert.throws(() => schema.artifactReply({ ...fixtures.completion(fixtures.artifact()), finishReason: "length" }, "html"), /INCOMPLETE/);
  assert.throws(() => schema.artifactReply(fixtures.completion(fixtures.artifact("node")), "html"), /INVALID/);
  assert.throws(() => schema.artifactReply(fixtures.completion({ ...fixtures.artifact("node"), code: 'require("child_process").exec("x")' }), "node"), /UNSUPPORTED/);
  assert.throws(() => schema.ideasReply(fixtures.completion({ ideas: [] })), /INVALID/);
});

test("lab controlled Node fixture: examples, invalid input, no source overwrites", (t) => {
  const { dir } = setup(t);
  const filename = path.join(dir, "controlled-tool.js");
  fs.writeFileSync(filename, fixtures.nodeCode);
  for (const [args, expected] of [[["100", "20"], "120"], [["50", "0"], "50"]]) {
    const result = spawnSync(process.execPath, [filename, ...args], { encoding: "utf8", cwd: dir });
    assert.equal(result.status, 0); assert.equal(result.stdout, expected);
  }
  assert.equal(spawnSync(process.execPath, [filename, "bad", "20"]).status, 1);
  assert.equal(fs.readFileSync(filename, "utf8"), fixtures.nodeCode);
});
