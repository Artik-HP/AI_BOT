const logger = require("./utils/logger");

// The one place where every module that keeps data of a person or a chat says what happens to it on /reset, on any
// logout or block, in /status and in /export. A module exports its hooks; src/bot.js registers them in start(), not
// on require, so that unit tests do not pile up global state. Hooks may be sync or async and run in the order of
// registration; a failing hook is logged without its message (it may carry someone's text) and does not stop the
// others. Callers get a result, never an exception.

const HOOKS = ["forgetChat", "revokeUser", "statusLines", "exportData"];
const modules = [];

// A repeated name or an unknown hook is a programming error: it throws at start, not at the first /reset.
function registerModule(name, hooks = {}) {
  if (typeof name !== "string" || !name) {
    throw new Error("LIFECYCLE_NAME_REQUIRED");
  }

  if (modules.some((entry) => entry.name === name)) {
    throw new Error(`LIFECYCLE_DUPLICATE_MODULE: ${name}`);
  }

  for (const [hook, handler] of Object.entries(hooks)) {
    if (!HOOKS.includes(hook)) {
      throw new Error(`LIFECYCLE_UNKNOWN_HOOK: ${name}.${hook}`);
    }

    if (typeof handler !== "function") {
      throw new Error(`LIFECYCLE_HOOK_NOT_A_FUNCTION: ${name}.${hook}`);
    }
  }

  modules.push({ name, hooks: { ...hooks } });
}

function describe(error) {
  const code = /^[A-Z0-9_]{1,40}$/.test(String(error?.code || "")) ? error.code : null;
  const reason = /^[A-Z][A-Z0-9_]{2,60}$/.test(String(error?.message || "")) ? error.message : null;

  return { name: error?.name || "Error", code, reason };
}

async function run(hook, argument) {
  const results = [];
  const failed = [];

  for (const { name, hooks } of modules) {
    if (!hooks[hook]) {
      continue;
    }

    try {
      results.push({ name, value: await hooks[hook](argument) });
    } catch (error) {
      failed.push(name);
      logger.error(`Lifecycle hook ${name}.${hook} failed:`, describe(error));
    }
  }

  return { results, failed };
}

// /reset: what the chat said and saw is forgotten (memory, recent sparks, saved facts).
async function forgetChat(chatId) {
  const { failed } = await run("forgetChat", chatId);

  return { failed };
}

// Any logout and any block: sessions, buttons and menus of this person stop working. Hooks must be idempotent.
async function revokeUser(userId) {
  const { failed } = await run("revokeUser", userId);

  return { failed };
}

// Extra lines for /status. A hook answers a line, a list of lines, or nothing.
async function statusLines(context) {
  const { results, failed } = await run("statusLines", context);
  const lines = results.flatMap(({ value }) => (Array.isArray(value) ? value : [value])).filter((line) => typeof line === "string" && line);

  return { lines, failed };
}

// /export: { [module]: data }; a module with nothing to give is left out.
async function exportData(context) {
  const { results, failed } = await run("exportData", context);
  const data = {};

  for (const { name, value } of results) {
    if (value !== undefined && value !== null) {
      data[name] = value;
    }
  }

  return { data, failed };
}

function moduleNames() {
  return modules.map((entry) => entry.name);
}

// Tests only.
function resetModules() {
  modules.length = 0;
}

module.exports = {
  HOOKS,
  registerModule,
  forgetChat,
  revokeUser,
  statusLines,
  exportData,
  moduleNames,
  resetModules
};
