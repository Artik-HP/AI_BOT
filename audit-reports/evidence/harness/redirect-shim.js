"use strict";
// Preload shim (node --require) that lets the ORIGINAL, unmodified app code talk to local fakes:
//  * node-telegram-bot-api -> baseApiUrl = FAKE_TG_URL
//  * axios requests to https://openrouter.ai -> FAKE_OR_URL
const root = process.env.APP_ROOT || "/home/user/ai_bot";
const load = (id) => require(require.resolve(id, { paths: [root] }));

const resolvedTg = require.resolve("node-telegram-bot-api", { paths: [root] });
const Orig = load("node-telegram-bot-api");
class Patched extends Orig {
  constructor(token, opts = {}) {
    super(token, { ...opts, baseApiUrl: process.env.FAKE_TG_URL });
  }
}
require.cache[resolvedTg].exports = Patched;

const axios = load("axios");
axios.interceptors.request.use((cfg) => {
  if (typeof cfg.url === "string" && cfg.url.startsWith("https://openrouter.ai")) {
    cfg.url = cfg.url.replace("https://openrouter.ai", process.env.FAKE_OR_URL);
  }
  return cfg;
});
