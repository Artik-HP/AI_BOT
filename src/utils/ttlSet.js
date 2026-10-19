// A set whose entries expire after ttlMs. Expiry is checked lazily, so there is no timer per entry.
// Every entry gets the same TTL, therefore insertion order is also expiry order.
function createTtlSet(ttlMs, { maxSize = 10000 } = {}) {
  const entries = new Map();

  function prune(now) {
    for (const [key, expiresAt] of entries) {
      if (expiresAt > now) {
        break;
      }

      entries.delete(key);
    }
  }

  function has(key) {
    prune(Date.now());
    return entries.has(key);
  }

  function add(key) {
    const now = Date.now();

    prune(now);
    entries.delete(key);
    entries.set(key, now + ttlMs);

    if (entries.size > maxSize) {
      entries.delete(entries.keys().next().value);
    }
  }

  // Returns false when the key is already present (and still fresh).
  function claim(key) {
    if (has(key)) {
      return false;
    }

    add(key);
    return true;
  }

  return {
    has,
    add,
    claim,
    get size() {
      prune(Date.now());
      return entries.size;
    }
  };
}

module.exports = {
  createTtlSet
};
