const SECRET_ENV_NAMES = [
  "BOT_TOKEN",
  "OPENROUTER_API_KEY",
  "TELEGRAM_API_HASH",
  "TELEGRAM_STRING_SESSION",
  "HEALTH_TOKEN"
];

const MIN_SECRET_LENGTH = 6;

const SECRET_PATTERNS = [
  [/bot\d{5,}:[A-Za-z0-9_-]{20,}/g, "bot***"],
  [/\b\d{5,}:[A-Za-z0-9_-]{30,}\b/g, "***:***"],
  [/sk-or-[A-Za-z0-9_-]{10,}/g, "sk-or-***"],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer ***"],
  [/\b1[A-Za-z0-9+/=_-]{200,}/g, "***session***"]
];

function redact(text) {
  let result = String(text);

  for (const name of SECRET_ENV_NAMES) {
    const value = process.env[name];

    if (value && value.length >= MIN_SECRET_LENGTH) {
      result = result.split(value).join("***");
    }
  }

  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }

  return result;
}

module.exports = {
  redact
};
