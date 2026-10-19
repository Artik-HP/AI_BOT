const CONFIG = require("../config");
const { getStore } = require("../commandSystem/store");
const { getPreferences } = require("./preferences");
function record(
  scope,
  event,
  command = "",
  ok = true,
  duration = 0,
  code = "",
) {
  try {
    getStore()
      .db.prepare(
        "INSERT INTO events(scope,event,command,ok,duration,code,created) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        scope,
        event,
        command,
        ok ? 1 : 0,
        duration,
        String(code).slice(0, 40),
        Date.now(),
      );
  } catch {
    /* Diagnostics must not hide an operation result. */
  }
}
function snapshot(scope, store = getStore()) {
  const stats = store.db
    .prepare(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) AS errors, ROUND(AVG(duration)) AS averageMs FROM events WHERE scope=?",
    )
    .get(scope);
  const events = store.db
    .prepare(
      "SELECT event,command,ok,duration,code,created FROM events WHERE scope=? ORDER BY id DESC LIMIT 30",
    )
    .all(scope);
  return {
    product: CONFIG.PRODUCT_NAME,
    status: "running",
    uptimeSeconds: Math.floor(process.uptime()),
    database: "sqlite",
    preferences: getPreferences(scope, store),
    providers: require("./aiProviders").publicConfig(),
    providerChecks: store.get(scope + ":provider-checks", {}),
    stats: {
      total: stats.total,
      errors: stats.errors || 0,
      averageMs: stats.averageMs || 0,
    },
    events,
    budget: store.get(scope + ":ai-budget", { daily: 0, count: 0 }),
    limits: {
      daily: CONFIG.AI_DAILY_REQUEST_LIMIT,
      perMinute: CONFIG.AI_RATE_PER_MINUTE,
      maxOutputTokens: CONFIG.AI_MAX_OUTPUT_TOKENS,
    },
  };
}
module.exports = { record, snapshot };
