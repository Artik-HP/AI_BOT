const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { PassThrough } = require("stream");
const { spawnSync } = require("child_process");
const dotenv = require("dotenv");
const { inspectEnv, replaceHash, saveHash, readHidden, main } = require("../../scripts/bot-password");
const { PasswordAuth, HASH_PATTERN } = require("../../src/services/auth");
const { buildConfig } = require("../../src/config");
const { TEST_PASSWORD, TEST_PASSWORD_HASH } = require("../helpers/authFixture");

function fixture(t, text) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aibot-password-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, ".env");
  fs.writeFileSync(file, text);
  return { directory, file };
}

test("password CLI: legacy defaults convert to a hash accepted by the real verifier", async (t) => {
  const salt = "0123456789abcdef0123456789abcdef";
  const legacy = `scrypt:${salt}:${crypto.scryptSync(TEST_PASSWORD, salt, 32).toString("hex")}`;
  const original = `OTHER='keep $literal # data'\r\nBOT_ACCESS_PASSWORD_HASH=${legacy}\r\n`;
  const { file } = fixture(t, original);
  const messages = [];
  assert.equal(await main(["--migrate-legacy", "--env", file], { env: {}, write: (s) => messages.push(s) }), 0);
  const updated = fs.readFileSync(file, "utf8");
  const values = dotenv.parse(updated);
  const config = buildConfig(values, () => {});
  const verifier = new PasswordAuth({ hash: config.BOT_PASSWORD_HASH });
  assert.equal((await verifier.authenticate(1, TEST_PASSWORD)).ok, true);
  assert.equal((await verifier.authenticate(2, "wrong-password")).ok, false);
  assert.ok(updated.includes("OTHER='keep $literal # data'\r\n"));
  assert.equal(values.BOT_ACCESS_PASSWORD_HASH, undefined);
  assert.equal(HASH_PATTERN.test(values.BOT_PASSWORD_HASH), true);
  assert.ok(!messages.join("\n").includes(legacy));
  assert.ok(!messages.join("\n").includes(values.BOT_PASSWORD_HASH));
});

test("password CLI: set removes duplicates and JavaScript, preserves other settings and backup", async (t) => {
  const original = `OTHER=unchanged\r\nBOT_PASSWORD_HASH=${TEST_PASSWORD_HASH}\r\nBOT_ACCESS_PASSWORD_HASH=scrypt:'+s+\r\nexport BOT_PASSWORD_HASH=broken\r\nEND=value\r\n`;
  const { file, directory } = fixture(t, original);
  const password = "новый $ пароль 917";
  const messages = [];
  assert.equal(await main(["--set", "--env", file], { env: {}, ask: async () => password, write: (s) => messages.push(s) }), 0);
  const updated = fs.readFileSync(file, "utf8");
  const info = inspectEnv(updated);
  assert.equal(info.valid, true);
  assert.equal(info.rows.BOT_PASSWORD_HASH.length, 1);
  assert.equal(info.rows.BOT_ACCESS_PASSWORD_HASH.length, 0);
  assert.equal(updated.replace(/^BOT_PASSWORD_HASH=.*\r\n/m, ""), "OTHER=unchanged\r\nEND=value\r\n");
  const backup = fs.readdirSync(directory).find((name) => name.startsWith(".env.before-password-"));
  assert.equal(fs.readFileSync(path.join(directory, backup), "utf8"), original);
  const auth = new PasswordAuth({ hash: info.values.BOT_PASSWORD_HASH });
  assert.equal((await auth.authenticate(1, password)).ok, true);
  assert.equal((await auth.authenticate(2, TEST_PASSWORD)).ok, false);
  for (const secret of [password, info.values.BOT_PASSWORD_HASH, TEST_PASSWORD_HASH]) assert.ok(!messages.join("\n").includes(secret));
});

test("password CLI: mismatch, cancellation, short password and command prefix leave env unchanged", async (t) => {
  const original = "OTHER=unchanged\n";
  const { file, directory } = fixture(t, original);
  for (const [answers, code] of [
    [["new-password", "different"], "PASSWORD_MISMATCH"],
    [["tiny", "tiny"], "AUTH_PASSWORD_LENGTH"],
    [["/password", "/password"], "PASSWORD_COMMAND_PREFIX"]
  ]) {
    await assert.rejects(main(["--set", "--env", file], { env: {}, ask: async () => answers.shift(), write() {} }), { message: code });
  }
  await assert.rejects(main(["--set", "--env", file], { env: {}, ask: async () => { throw new Error("PASSWORD_CANCELLED"); }, write() {} }), { message: "PASSWORD_CANCELLED" });
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.deepEqual(fs.readdirSync(directory), [".env"]);
});

test("password CLI: inherited even empty value overrides dotenv and blocks password writes", async (t) => {
  const original = `BOT_PASSWORD_HASH=${TEST_PASSWORD_HASH}\n`;
  const { file } = fixture(t, original);
  const info = inspectEnv(original, { BOT_PASSWORD_HASH: "" });
  assert.equal(info.valid, false);
  assert.equal(info.overrideDiffers, true);
  assert.equal(await main(["--check", "--env", file], { env: { BOT_PASSWORD_HASH: "" }, write() {} }), 1);
  await assert.rejects(main(["--set", "--env", file], { env: { BOT_PASSWORD_HASH: "" }, write() {} }), { message: "PASSWORD_ENV_OVERRIDE" });
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("password CLI: ambiguous legacy migration never overwrites current password", async (t) => {
  const original = `BOT_PASSWORD_HASH=${TEST_PASSWORD_HASH}\nBOT_ACCESS_PASSWORD_HASH=broken\n`;
  const { file } = fixture(t, original);
  await assert.rejects(main(["--migrate-legacy", "--env", file], { env: {}, write() {} }), { message: "PASSWORD_MIGRATION_AMBIGUOUS" });
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("password CLI: changed file and multiline credential never get overwritten", (t) => {
  const { file } = fixture(t, "OTHER=newer\n");
  assert.throws(() => saveHash(file, "OTHER=older\n", TEST_PASSWORD_HASH), { message: "PASSWORD_ENV_CHANGED" });
  assert.equal(fs.readFileSync(file, "utf8"), "OTHER=newer\n");
  assert.throws(() => replaceHash('BOT_PASSWORD_HASH="multiline\nsecret"\n', TEST_PASSWORD_HASH), { message: "PASSWORD_ENV_MULTILINE" });
});

test("password CLI: supports BOM and preserves literal dollar signs in dotenv", () => {
  const bom = String.fromCodePoint(0xfeff);
  const updated = replaceHash(`${bom}BOT_PASSWORD_HASH=broken\r\nOTHER=$literal\r\n`, TEST_PASSWORD_HASH);
  assert.ok(updated.startsWith(bom));
  assert.equal(inspectEnv(updated).valid, true);
  assert.equal(dotenv.parse(updated).OTHER, "$literal");
  assert.equal(dotenv.parse(updated).BOT_PASSWORD_HASH, TEST_PASSWORD_HASH);
});

test("password CLI: read-only check uses cwd env, reports duplicate last-wins and never prints values", (t) => {
  const { directory, file } = fixture(t, `BOT_PASSWORD_HASH=not-a-hash\nBOT_PASSWORD_HASH=${TEST_PASSWORD_HASH}\n`);
  const cli = path.resolve(__dirname, "../../scripts/bot-password.js");
  const result = spawnSync(process.execPath, [cli, "--check"], { cwd: directory, env: { PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /строк 2/);
  assert.match(result.stdout, /последнюю/);
  assert.ok(result.stdout.includes(file));
  assert.ok(!`${result.stdout}${result.stderr}`.includes(TEST_PASSWORD_HASH));
});

test("password CLI: no terminal fails instead of accepting a password on the command line or pipe", async (t) => {
  const { directory } = fixture(t, "OTHER=keep\n");
  const cli = path.resolve(__dirname, "../../scripts/bot-password.js");
  const result = spawnSync(process.execPath, [cli, "--set"], { cwd: directory, env: { PATH: process.env.PATH }, input: TEST_PASSWORD, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(TEST_PASSWORD));
  assert.deepEqual(fs.readdirSync(directory), [".env"]);
});

test("password CLI: hidden prompt suppresses typed text and restores terminal on completion", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  let raw = false;
  input.setRawMode = (value) => { raw = value; };
  let displayed = "";
  output.on("data", (chunk) => { displayed += chunk; });
  const pending = readHidden("Hidden: ", input, output);
  assert.equal(raw, true);
  input.write(`${TEST_PASSWORD}\r`);
  assert.equal(await pending, TEST_PASSWORD);
  assert.equal(raw, false);
  assert.equal(displayed, "Hidden: \n");
});

test("password CLI: Ctrl+C cancels hidden entry and restores the terminal", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  let raw = false;
  input.setRawMode = (value) => { raw = value; };
  let displayed = "";
  output.on("data", (chunk) => { displayed += chunk; });
  const pending = readHidden("Hidden: ", input, output);
  const rejected = assert.rejects(pending, { message: "PASSWORD_CANCELLED" });
  input.write("partial-secret");
  input.write(String.fromCodePoint(3));
  await rejected;
  assert.equal(raw, false);
  assert.equal(displayed, "Hidden: \n");
});
