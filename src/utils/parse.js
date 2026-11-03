const TRUE_VALUES = new Set(["1", "true", "yes", "y", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "n", "off"]);

// true / false for recognised words, null otherwise. A typo must not silently turn into "false".
function parseBoolean(value) {
  const word = String(value ?? "").trim().toLowerCase();

  if (TRUE_VALUES.has(word)) {
    return true;
  }

  return FALSE_VALUES.has(word) ? false : null;
}

module.exports = {
  parseBoolean
};
