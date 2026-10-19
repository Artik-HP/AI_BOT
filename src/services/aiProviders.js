const axios = require("axios");
const CONFIG = require("../config");
const { getStore } = require("../commandSystem/store");
const { userError } = require("./preferences");
function providerConfig(name = "openrouter") {
  if (name === "openrouter")
    return {
      id: name,
      base: "https://openrouter.ai/api/v1",
      key: CONFIG.OPENROUTER_API_KEY,
    };
  if (name !== "compatible") throw userError("Неизвестный провайдер.");
  const base = String(process.env.AI_COMPATIBLE_BASE_URL || "").replace(
    /\/$/,
    "",
  );
  if (!base)
    throw userError(
      "Настрой AI_COMPATIBLE_BASE_URL и AI_COMPATIBLE_API_KEY в .env.",
    );
  const url = new URL(base);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw userError(
      "AI_COMPATIBLE_BASE_URL должен быть HTTPS-адресом без учётных данных.",
    );
  return { id: name, base, key: process.env.AI_COMPATIBLE_API_KEY };
}
function headers(name) {
  const p = providerConfig(name);
  if (!p.key)
    throw userError(
      name === "openrouter"
        ? "Настрой OPENROUTER_API_KEY в .env."
        : "Настрой AI_COMPATIBLE_API_KEY в .env.",
    );
  return {
    Authorization: `Bearer ${p.key}`,
    "Content-Type": "application/json",
    "HTTP-Referer": process.env.APP_URL || "http://localhost",
    "X-Title": CONFIG.PRODUCT_NAME,
  };
}
function consumeBudget(scope, store = getStore(), now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10),
    minute = Math.floor(now / 60000);
  store.transaction(() => {
    const budgets = [
      {
        key: scope + ":ai-budget",
        daily: CONFIG.AI_DAILY_REQUEST_LIMIT,
        minute: CONFIG.AI_RATE_PER_MINUTE,
      },
      {
        key: "instance:ai-budget",
        daily: CONFIG.AI_INSTANCE_DAILY_REQUEST_LIMIT,
        minute: CONFIG.AI_INSTANCE_RATE_PER_MINUTE,
      },
    ];
    for (const limit of budgets) {
      const v = store.get(limit.key, { day, daily: 0, minute, count: 0 });
      if (v.day !== day) {
        v.day = day;
        v.daily = 0;
      }
      if (v.minute !== minute) {
        v.minute = minute;
        v.count = 0;
      }
      if (v.daily >= limit.daily)
        throw userError("Дневной лимит AI-запросов исчерпан. Попробуй завтра.");
      if (v.count >= limit.minute)
        throw userError(
          "Слишком много AI-запросов за минуту. Подожди немного.",
        );
      v.daily++;
      v.count++;
      store.set(limit.key, v);
    }
  });
}
async function compatibleCompletion(messages, options = {}) {
  if (options.budgetScope) consumeBudget(options.budgetScope);
  const p = providerConfig("compatible");
  const response = await axios.post(
    p.base + "/chat/completions",
    {
      model: options.model || CONFIG.MODEL,
      messages:
        options.interactive === false
          ? messages
          : [require("./interactiveQuestion").PROTOCOL_PROMPT, ...messages],
      temperature: 0.6,
      max_tokens: CONFIG.AI_MAX_OUTPUT_TOKENS,
    },
    {
      headers: headers("compatible"),
      timeout: 60000,
      maxContentLength: 256 * 1024,
    },
  );
  const raw = response.data?.choices?.[0]?.message?.content;
  if (typeof raw !== "string" || !raw.trim())
    throw new Error("Provider returned empty output");
  return options.interactive === false
    ? raw
    : require("./interactiveQuestion").parseModelReply(raw);
}
async function checkProvider(name = "openrouter") {
  const started = Date.now();
  try {
    const p = providerConfig(name);
    await axios.get(p.base + "/models", {
      headers: headers(name),
      timeout: 10000,
      maxContentLength: 4 * 1024 * 1024,
    });
    return {
      provider: name,
      status: "reachable",
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - started,
      boundary: "Проверен доступ к каталогу моделей; генерация не запускалась.",
    };
  } catch (error) {
    return {
      provider: name,
      status: "unavailable",
      checkedAt: new Date().toISOString(),
      code: error.response?.status || error.code || "CONFIGURATION",
      boundary: "Генерация не подтверждена.",
    };
  }
}
function publicConfig() {
  return {
    openrouter: { configured: Boolean(CONFIG.OPENROUTER_API_KEY) },
    compatible: {
      configured: Boolean(
        process.env.AI_COMPATIBLE_API_KEY && process.env.AI_COMPATIBLE_BASE_URL,
      ),
    },
  };
}
module.exports = {
  providerConfig,
  headers,
  consumeBudget,
  compatibleCompletion,
  checkProvider,
  publicConfig,
};
