const path = require("path");

const SRC = path.join(__dirname, "..", "..", "src");

// Config is read once when a module is first required, so tests that need different environment
// variables load the modules from scratch with the variables set (and restore them afterwards).
function loadFresh(relativePath, env = {}) {
  const saved = {};

  for (const [name, value] of Object.entries(env)) {
    saved[name] = process.env[name];

    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC)) {
      delete require.cache[key];
    }
  }

  try {
    return require(path.join(SRC, relativePath));
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

async function waitFor(predicate, timeoutMs = 3000, label = "condition") {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (await predicate()) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 15));
  }

  throw new Error(`timeout waiting for ${label}`);
}

module.exports = {
  loadFresh,
  waitFor
};
