const { describeError } = require("./errors");
const { redact } = require("./redact");

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99
};

let output = {
  info: (line) => console.log(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line)
};

function currentLevel() {
  const name = String(process.env.LOG_LEVEL || "info").trim().toLowerCase();
  return LEVELS[name] ?? LEVELS.info;
}

function messageLoggingEnabled() {
  return ["1", "true", "yes", "y", "on"].includes(
    String(process.env.LOG_MESSAGES || "").trim().toLowerCase()
  );
}

function formatArg(arg) {
  if (arg instanceof Error) {
    return describeError(arg);
  }

  if (typeof arg === "string") {
    return arg;
  }

  if (arg !== null && typeof arg === "object") {
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }

  return String(arg);
}

function write(level, channel, args) {
  if (LEVELS[level] < currentLevel()) {
    return;
  }

  const text = redact(args.map(formatArg).join(" "));
  output[channel](`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${text}`);
}

function debug(...args) {
  write("debug", "info", args);
}

function info(...args) {
  write("info", "info", args);
}

function warn(...args) {
  write("warn", "warn", args);
}

function error(...args) {
  write("error", "error", args);
}

// Message bodies are personal data, so they are logged only on explicit request (LOG_MESSAGES=true).
function message(direction, details, text) {
  if (!messageLoggingEnabled()) {
    return;
  }

  info(`[${direction}]`, details, text);
}

function setOutput(replacement) {
  output = { ...output, ...replacement };
}

module.exports = {
  debug,
  info,
  warn,
  error,
  message,
  setOutput
};
