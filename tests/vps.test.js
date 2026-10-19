const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const dotenv = require("dotenv");
const { selectFiles, createPackage, verifyBundle, stageBundle } = require("../scripts/package-vps");
const { validateVpsEnv, initializeEnv, inspectEnvFile } = require("../scripts/check-vps");

const root = path.resolve(__dirname, "..");
const local = path.join(root, ".local");
fs.mkdirSync(local, { recursive: true });
const temporary = fs.mkdtempSync(path.join(local, "vps-tests-"));
test.after(() => {
  const resolved = fs.realpathSync(temporary);
  assert.equal(path.dirname(resolved), fs.realpathSync(local));
  assert.ok(path.basename(resolved).startsWith("vps-tests-"));
  fs.rmSync(resolved, { recursive: true });
});

function fixture(name) {
  const directory = path.join(temporary, name);
  fs.mkdirSync(directory);
  for (const file of selectFiles(root)) {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, file), target);
  }
  return directory;
}

function validEnv() {
  return {
    ...dotenv.parse(fs.readFileSync(path.join(root, "deploy/ubuntu/bot.env.example"))),
    BOT_TOKEN: "123456789:" + "t".repeat(35),
    BOT_ACCESS_PASSWORD_HASH: "scrypt:" + "a".repeat(32) + ":" + "b".repeat(64),
    WEB_ACCESS_TOKEN: "w".repeat(64),
    WEBHOOK_SECRET_TOKEN: "s".repeat(64),
  };
}

function tar(args) {
  const result = spawnSync("tar", args, { encoding: "utf8" });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("real VPS archive includes working source but excludes credentials, sessions and personal data", () => {
  const directory = fixture("archive");
  const privateFiles = [".env", ".env.production", "memory.json", "memory.json.bak", "userbot.session",
    "data/commands.sqlite", "data/commands.sqlite-wal", "interactive-state.json", ".git/config",
    "src/.env", "src/private.key", "scripts/userbot.session", "public/secret.json"];
  for (const file of privateFiles) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(path.join(directory, file), "PRIVATE_TEST_DATA");
  }
  fs.writeFileSync(path.join(directory, "src/uncommitted-feature.js"), "module.exports = 42;\r\n");
  const result = createPackage(directory);
  assert.equal(result.sha256, crypto.createHash("sha256").update(fs.readFileSync(result.archive)).digest("hex"));
  assert.ok(fs.readFileSync(result.archive + ".sha256", "utf8").startsWith(result.sha256 + "  "));
  const members = tar(["-tf", result.archive]).split(/\r?\n/);
  for (const file of privateFiles) assert.ok(!members.includes("ai-bot/" + file), file);
  assert.ok(members.includes("ai-bot/src/uncommitted-feature.js"));
  assert.ok(members.includes("ai-bot/deploy/ubuntu/bot.env.example"));
  assert.ok(!members.some((file) => file.includes("node_modules") || file.includes(".local")));
  const extracted = path.join(directory, ".local/extracted");
  fs.mkdirSync(extracted);
  tar(["-xzf", result.archive, "-C", extracted]);
  const payload = path.join(extracted, "ai-bot");
  assert.equal(verifyBundle(payload).files.length, result.files);
  assert.equal(fs.readFileSync(path.join(payload, "src/uncommitted-feature.js"), "utf8"), "module.exports = 42;\n");
  assert.ok(!fs.readFileSync(path.join(payload, "deploy/ubuntu/install.sh"), "utf8").includes("\r"));
  for (const file of privateFiles) assert.equal(fs.readFileSync(path.join(directory, file), "utf8"), "PRIVATE_TEST_DATA");
  const staged = path.join(directory, ".local/staged");
  fs.mkdirSync(staged);
  // Even extra private files added after extraction are not copied into a release.
  fs.writeFileSync(path.join(payload, ".env"), "PRIVATE_TEST_DATA");
  stageBundle(staged, payload);
  assert.equal(verifyBundle(staged).files.length, result.files);
  assert.ok(!fs.existsSync(path.join(staged, ".env")));
  assert.throws(() => stageBundle(staged, payload), /must be empty/);
  fs.appendFileSync(path.join(payload, "src/uncommitted-feature.js"), "\nthrow new Error('changed');\n");
  assert.throws(() => verifyBundle(payload), /checksum mismatch/);
});

test("packaging rejects linked source directories instead of following them", () => {
  const directory = fixture("symlink");
  const outside = path.join(temporary, "external-data");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.js"), "PRIVATE_TEST_DATA");
  fs.symlinkSync(outside, path.join(directory, "src/linked"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => selectFiles(directory), /Symlinks/);
});

test("env initialization creates distinct random secrets and refuses to overwrite an existing file", () => {
  const file = path.join(temporary, "generated.env");
  initializeEnv(file);
  const original = fs.readFileSync(file, "utf8"), env = dotenv.parse(original);
  assert.match(env.WEB_ACCESS_TOKEN, /^[a-f0-9]{64}$/);
  assert.match(env.WEBHOOK_SECRET_TOKEN, /^[a-f0-9]{64}$/);
  assert.notEqual(env.WEB_ACCESS_TOKEN, env.WEBHOOK_SECRET_TOKEN);
  assert.equal(env.BOT_TOKEN, "");
  assert.equal(env.OPENROUTER_API_KEY, "");
  assert.throws(() => initializeEnv(file), { code: "EEXIST" });
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.ok(validateVpsEnv(env).errors.length >= 2);
});

test("offline preflight accepts polling with no AI key and a correctly protected webhook profile", () => {
  const env = validEnv();
  const polling = validateVpsEnv(env);
  assert.deepEqual(polling.errors, []);
  assert.equal(polling.mode, "polling");
  assert.equal(polling.warnings.length, 1);
  const webhook = validateVpsEnv({ ...env, WEBHOOK_URL: "https://bot.unit.test", WEB_PUBLIC_URL: "https://bot.unit.test", WEB_SECURE_COOKIE: "true" });
  assert.deepEqual(webhook.errors, []);
  assert.equal(webhook.mode, "webhook");
});

test("preflight blocks unsafe paths, open listeners, placeholders and missing access gates without echoing secrets", () => {
  const env = validEnv();
  for (const override of [
    { HOST: "0.0.0.0" }, { WEB_HOST: "0.0.0.0" }, { PORT: "80" },
    { MEMORY_FILE: "./memory.json" }, { COMMAND_DB_FILE: "/opt/ai-bot/commands.sqlite" },
    { CONFIG_ENV_FILE: "/opt/ai-bot/.env" }, { MEMORY_BACKEND: "json" },
    { BOT_TOKEN: "process.env.BOT_TOKEN" }, { BOT_ACCESS_PASSWORD_HASH: "" },
    { WEB_ACCESS_TOKEN: "short" }, { OPENROUTER_API_KEY: "replace_me" },
  ]) {
    const result = validateVpsEnv({ ...env, ...override });
    assert.ok(result.errors.length, JSON.stringify(Object.keys(override)));
    assert.ok(!JSON.stringify(result).includes(env.BOT_TOKEN));
    assert.ok(!JSON.stringify(result).includes(env.WEB_ACCESS_TOKEN));
  }
});

test("preflight rejects broken webhook URLs, insecure cookies, different routes and reused secrets", () => {
  const env = { ...validEnv(), WEBHOOK_URL: "https://bot.unit.test", WEB_SECURE_COOKIE: "true" };
  for (const override of [
    { WEBHOOK_URL: "http://bot.unit.test" }, { WEBHOOK_URL: "https://bot.example.com" },
    { WEBHOOK_URL: "https://user:password@bot.unit.test" },
    { WEBHOOK_URL: "https://bot.unit.test/path" }, { WEBHOOK_URL: "https://bot.unit.test?token=private" },
    { WEB_SECURE_COOKIE: "false" }, { WEBHOOK_SECRET_TOKEN: "" },
    { WEBHOOK_SECRET_TOKEN: env.WEB_ACCESS_TOKEN }, { WEBHOOK_PATH: "/health" },
  ]) assert.ok(validateVpsEnv({ ...env, ...override }).errors.length);
});

test("preflight reads only the requested env, and CLI error output never contains its credential values", () => {
  const env = validEnv();
  const file = path.join(temporary, "valid.env");
  fs.writeFileSync(file, Object.entries(env).map(([key, value]) => key + "=" + value).join("\n"));
  assert.deepEqual(inspectEnvFile(file, "win32").errors, []);
  assert.throws(() => inspectEnvFile(path.join(temporary, "missing.env")), { code: "ENOENT" });
  const invalid = { ...env, BOT_TOKEN: "invalid-private-test-token" };
  fs.writeFileSync(file, Object.entries(invalid).map(([key, value]) => key + "=" + value).join("\n"));
  const result = spawnSync(process.execPath, [path.join(root, "scripts/check-vps.js"), "--env", file], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /BOT_TOKEN/);
  assert.ok(!result.stderr.includes(invalid.BOT_TOKEN));
  assert.ok(!result.stdout.includes(env.WEB_ACCESS_TOKEN));
});
