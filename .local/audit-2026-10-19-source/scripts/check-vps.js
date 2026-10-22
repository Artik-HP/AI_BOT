const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const dotenv = require("dotenv");

const statePaths = {
  MEMORY_FILE: "/var/lib/ai-bot/memory.json",
  COMMAND_DB_FILE: "/var/lib/ai-bot/commands.sqlite",
  INTERACTIVE_STATE_FILE: "/var/lib/ai-bot/interactive-state.json",
  CONFIG_ENV_FILE: "/var/lib/ai-bot/config/.env",
};

function validateVpsEnv(env) {
  const errors = [], warnings = [];
  const check = (ok, message) => { if (!ok) errors.push(message); };
  check(env.NODE_ENV === "production", "NODE_ENV must be production");
  check(/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(env.BOT_TOKEN || ""), "BOT_TOKEN is missing or has an invalid format");
  check(/^scrypt:[a-f0-9]{32}:[a-f0-9]{64}$/.test(env.BOT_ACCESS_PASSWORD_HASH || ""), "Set a bot password using scripts/setup.js");
  check(env.HOST === "127.0.0.1" && env.WEB_HOST === "127.0.0.1", "HOST and WEB_HOST must be 127.0.0.1 for this VPS profile");
  check(env.PORT === "12722" && env.WEB_PORT === "12723", "Keep PORT=12722 and WEB_PORT=12723 in this VPS profile");
  check(/^[A-Za-z0-9_-]{32,256}$/.test(env.WEB_ACCESS_TOKEN || "") && env.WEB_ACCESS_TOKEN !== env.BOT_TOKEN, "WEB_ACCESS_TOKEN must be an independent random secret (32-256 characters)");
  check(env.MEMORY_BACKEND === "sqlite", "MEMORY_BACKEND must be sqlite");
  for (const [key, value] of Object.entries(statePaths)) check(env[key] === value, key + " must point to " + value);
  check(["true", "false"].includes(env.WEB_SECURE_COOKIE), "WEB_SECURE_COOKIE must be true or false");
  for (const key of ["BOT_TOKEN", "OPENROUTER_API_KEY", "WEB_ACCESS_TOKEN", "WEBHOOK_SECRET_TOKEN"]) {
    check(!/(?:process\.env\.|change.?me|replace.?me|your[_-]|example)/i.test(env[key] || ""), key + " contains a placeholder");
  }
  for (const key of ["WEBHOOK_URL", "WEB_PUBLIC_URL"]) {
    if (!env[key]) continue;
    let valid = false;
    try {
      const url = new URL(env[key]);
      valid = url.protocol === "https:" && !url.username && !url.password &&
        !url.search && !url.hash && url.pathname === "/" &&
        (!url.port || url.port === "443") &&
        !/(^|\.)(localhost|example\.(com|org|net))$/.test(url.hostname);
    } catch { /* Report the field, never its potentially secret contents. */ }
    check(valid, key + " must be your HTTPS origin without credentials, path or query");
    check(env.WEB_SECURE_COOKIE === "true", "Enable WEB_SECURE_COOKIE=true for HTTPS access");
  }
  if (env.WEBHOOK_URL) {
    check(env.WEBHOOK_PATH === "/telegram-webhook", "WEBHOOK_PATH must match the Caddy route /telegram-webhook");
    check(/^[A-Za-z0-9_-]{32,256}$/.test(env.WEBHOOK_SECRET_TOKEN || ""), "Generate WEBHOOK_SECRET_TOKEN (32-256 allowed characters)");
    check(env.WEBHOOK_SECRET_TOKEN !== env.WEB_ACCESS_TOKEN, "Use separate webhook and web access secrets");
  }
  if (!env.OPENROUTER_API_KEY) warnings.push("OPENROUTER_API_KEY is empty; AI commands will be unavailable");
  if (env.ACCOUNT_ASSISTANT_ENABLED !== "false" || env.BOT_TO_BOT_ENABLED !== "false") {
    warnings.push("Optional Telegram account/bot integrations need their own credentials and verification");
  }
  return { errors, warnings, mode: env.WEBHOOK_URL ? "webhook" : "polling" };
}

function initializeEnv(file) {
  const template = fs.readFileSync(path.join(__dirname, "../deploy/ubuntu/bot.env.example"), "utf8").replaceAll("\r\n", "\n");
  const content = template.replace(/^WEB_ACCESS_TOKEN=$/m, "WEB_ACCESS_TOKEN=" + crypto.randomBytes(32).toString("hex"))
    .replace(/^WEBHOOK_SECRET_TOKEN=$/m, "WEBHOOK_SECRET_TOKEN=" + crypto.randomBytes(32).toString("hex"));
  fs.writeFileSync(file, content, { mode: 0o600, flag: "wx" });
}

function inspectEnvFile(file, platform = process.platform) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Config must be a regular file");
  const env = dotenv.parse(fs.readFileSync(file));
  const result = validateVpsEnv(env);
  if (platform === "linux") {
    if (stat.mode & 0o077) result.errors.push("Config permissions must be 600");
    // Atomic writes of settings need write access to the directory, not just .env.
    for (const directory of new Set(Object.values(statePaths).map((value) => path.dirname(value)))) {
      try { fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK); }
      catch { result.errors.push("Service cannot write its state directory: " + directory); }
    }
  }
  return result;
}

if (require.main === module) {
  try {
    const [command, file, ...extra] = process.argv.slice(2);
    if (!["--env", "--init"].includes(command) || !file || extra.length) throw new Error("Usage: node scripts/check-vps.js --env FILE | --init NEW_FILE");
    if (command === "--init") {
      initializeEnv(file);
      console.log("VPS config created. Fill Telegram token, AI key and bot password on the server.");
    } else {
      const [major, minor] = process.versions.node.split(".").map(Number);
      if (major < 22 || (major === 22 && minor < 13)) throw new Error("Node.js >=22.13 is required; use Node.js 24 LTS");
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(":memory:");
      db.exec("CREATE TABLE check_sqlite (value INTEGER)");
      db.close();
      const result = inspectEnvFile(file);
      for (const warning of result.warnings) console.warn("WARN: " + warning);
      for (const error of result.errors) console.error("FAIL: " + error);
      if (result.errors.length) process.exitCode = 1;
      else console.log("VPS config OK (" + result.mode + "). No external API requests were made.");
    }
  } catch (error) {
    // No stack, environment values, or HTTP client objects in operator output.
    console.error("VPS check failed: " + (error.code || error.message));
    process.exitCode = 1;
  }
}

module.exports = { validateVpsEnv, initializeEnv, inspectEnvFile };
