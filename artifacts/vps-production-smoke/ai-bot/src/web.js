if (require.main === module) require("dotenv").config({ quiet: true });
const express = require("express");
const path = require("node:path");
const crypto = require("node:crypto");
const { getStore } = require("./commandSystem/store");
const { execute, startScheduler } = require("./commandSystem/engine");
const { catalog, CATEGORIES, profile } = require("./commandSystem/registry");
const CONFIG = require("./config");
function sameSecret(a, b) {
  const x = crypto.createHash("sha256").update(a).digest(),
    y = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(x, y);
}
function mountWeb(
  app,
  { store = getStore(), accessToken = process.env.WEB_ACCESS_TOKEN || "" } = {},
) {
  const attempts = new Map();
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    next();
  });
  app.get("/api/public-info", (req, res) =>
    res.json({
      name: CONFIG.PRODUCT_NAME,
      tagline: CONFIG.PRODUCT_TAGLINE,
      accent: /^#[a-f0-9]{6}$/i.test(process.env.PRODUCT_ACCENT || "")
        ? process.env.PRODUCT_ACCENT
        : "#b9a2ff",
      logo: /^\/assets\/[a-zA-Z0-9_.-]+\.(png|webp|svg)$/.test(
        process.env.PRODUCT_LOGO || "",
      )
        ? process.env.PRODUCT_LOGO
        : null,
    }),
  );
  app.use("/api", express.json({ limit: "40kb" }));
  app.use("/api", (req, res, next) => {
    const host = req.hostname;
    const loopback =
      ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
        req.socket.remoteAddress,
      ) && ["localhost", "127.0.0.1", "[::1]"].includes(host);
    if (!accessToken && !loopback)
      return res
        .status(403)
        .json({ error: "Для удалённой веб-панели настрой WEB_ACCESS_TOKEN." });
    if (req.method !== "GET" && req.get("Origin")) {
      try {
        if (new URL(req.get("Origin")).host !== req.get("Host"))
          return res
            .status(403)
            .json({ error: "Недопустимый источник запроса." });
      } catch {
        return res
          .status(403)
          .json({ error: "Недопустимый источник запроса." });
      }
    }
    const cookie = String(req.get("Cookie") || "").match(
      /(?:^|;\s*)orbit_session=([a-f0-9]{64})(?:;|$)/,
    )?.[1];
    const session =
      cookie &&
      store.get(
        "websession:" +
          crypto.createHash("sha256").update(cookie).digest("hex"),
        null,
      );
    const authVersion = crypto
      .createHash("sha256")
      .update(
        accessToken ||
          require("./services/access").getAccessGate().hash ||
          "local-only",
      )
      .digest("hex");
    req.webSession =
      session &&
      session.expires > Date.now() &&
      session.authVersion === authVersion
        ? session
        : null;
    req.authVersion = authVersion;
    req.previousWebSession = session;
    req.webSessionKey =
      cookie &&
      "websession:" + crypto.createHash("sha256").update(cookie).digest("hex");
    if (req.path === "/session" && req.method === "GET") return next();
    if (!req.webSession)
      return res.status(401).json({ error: "Открой сессию веб-панели." });
    if (
      req.method !== "GET" &&
      !sameSecret(String(req.get("X-CSRF-Token") || ""), req.webSession.csrf)
    )
      return res
        .status(403)
        .json({ error: "Сессия обновилась. Перезагрузи страницу." });
    const rate = attempts.get(req.webSession.scope) || {
      time: Date.now(),
      count: 0,
    };
    if (Date.now() - rate.time > 60000) {
      rate.time = Date.now();
      rate.count = 0;
    }
    if (++rate.count > 80)
      return res
        .status(429)
        .json({ error: "Слишком много запросов. Подожди минуту." });
    attempts.set(req.webSession.scope, rate);
    if (attempts.size > 5000) attempts.clear();
    req.commandContext = {
      scope: req.webSession.scope,
      transport: "web",
      userId: req.webSession.scope,
      store,
    };
    next();
  });
  app.get("/api/session", (req, res) => {
    if (
      !req.webSession &&
      (accessToken || require("./services/access").getAccessGate().enabled)
    ) {
      const peer = req.socket.remoteAddress,
        rate = attempts.get("login:" + peer) || { time: Date.now(), count: 0 };
      if (Date.now() - rate.time > 60000) {
        rate.time = Date.now();
        rate.count = 0;
      }
      attempts.set("login:" + peer, rate);
      if (++rate.count > 15)
        return res
          .status(429)
          .json({ error: "Слишком много попыток входа. Подожди минуту." });
      const credential = String(req.get("X-Access-Token") || "");
      if (
        !(accessToken
          ? sameSecret(credential, accessToken)
          : require("./services/access").verifyPassword(
              credential,
              require("./services/access").getAccessGate().hash,
            ))
      )
        return res
          .status(401)
          .json({ error: "Введи WEB_ACCESS_TOKEN, настроенный на сервере." });
    }
    let session = req.webSession;
    if (!session) {
      const token = crypto.randomBytes(32).toString("hex");
      session = {
        scope: req.previousWebSession?.scope || "w:" + crypto.randomUUID(),
        csrf: crypto.randomBytes(24).toString("hex"),
        authVersion: req.authVersion,
        expires: Date.now() + 30 * 86400000,
      };
      store.set(
        "websession:" + crypto.createHash("sha256").update(token).digest("hex"),
        session,
      );
      res.cookie("orbit_session", token, {
        httpOnly: true,
        sameSite: "strict",
        secure: req.secure || process.env.WEB_SECURE_COOKIE === "true",
        maxAge: 30 * 86400000,
        path: "/",
      });
    }
    res.json({ csrf: session.csrf });
  });
  app.post("/api/logout", (req, res) => {
    req.webSession.expires = 0;
    store.set(req.webSessionKey, req.webSession);
    res.json({ ok: true });
  });
  app.get("/api/preferences", (req, res) =>
    res.json({
      preferences: require("./services/preferences").getPreferences(
        req.commandContext.scope,
        store,
      ),
      models: require("./services/preferences").models(),
      modes: require("./services/preferences").MODES,
      styles: require("./services/preferences").STYLES,
      providers: require("./services/aiProviders").publicConfig(),
    }),
  );
  app.post("/api/preferences", (req, res) =>
    res.json({
      preferences: require("./services/preferences").savePreferences(
        req.commandContext.scope,
        req.body,
        store,
      ),
    }),
  );
  app.get("/api/history", (req, res) =>
    res.json({
      conversations: require("./services/personalData").history(
        req.commandContext.scope,
        String(req.query.q || "").slice(0, 100),
        store,
      ),
      active: require("./services/preferences").getPreferences(
        req.commandContext.scope,
        store,
      ).activeThread,
    }),
  );
  app.get("/api/diagnostics", (req, res) =>
    res.json(
      require("./services/diagnostics").snapshot(
        req.commandContext.scope,
        store,
      ),
    ),
  );
  app.post("/api/provider-check", async (req, res) => {
    const provider = require("./services/preferences").getPreferences(
      req.commandContext.scope,
      store,
    ).provider;
    const checked = await require("./services/aiProviders").checkProvider(
      provider,
    );
    store.set(req.commandContext.scope + ":provider-checks", {
      [provider]: checked,
    });
    res.json(checked);
  });
  app.post("/api/admin/provider-key", (req, res) => {
    if (
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
        req.socket.remoteAddress,
      ) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(req.hostname)
    )
      return res.status(403).json({
        error: "Ключи меняются только в локальной защищённой панели.",
      });
    const { provider, key } = req.body || {};
    if (
      !["openrouter", "compatible"].includes(provider) ||
      typeof key !== "string" ||
      key.length < 8 ||
      key.length > 512 ||
      /[\r\n\u0000-\u001f]/.test(key)
    )
      return res
        .status(400)
        .json({ error: "Некорректный провайдер или ключ." });
    const name =
      provider === "openrouter"
        ? "OPENROUTER_API_KEY"
        : "AI_COMPATIBLE_API_KEY";
    require("./services/envSettings").updateEnv({ [name]: key });
    if (provider === "openrouter") CONFIG.OPENROUTER_API_KEY = key;
    res.json({ ok: true, configured: true });
  });
  app.get("/api/export", (req, res) => {
    res.set(
      "Content-Disposition",
      'attachment; filename="orbit-personal-data.json"',
    );
    res
      .type("application/json")
      .send(
        require("./services/personalData").exportData(
          req.commandContext.scope,
          store,
        ),
      );
  });
  app.get("/api/commands", (req, res) =>
    res.json({
      commands: catalog(req.commandContext),
      categories: Object.fromEntries(
        Object.entries(CATEGORIES).map(([id, label]) => [
          id,
          require("./services/i18n").translate(
            label,
            require("./services/preferences").getPreferences(
              req.commandContext.scope,
              store,
            ).language,
          ),
        ]),
      ),
      profile: profile(req.commandContext),
    }),
  );
  app.post("/api/commands/:id", async (req, res) => {
    if (!req.is("application/json"))
      return res.status(415).json({ error: "Требуется application/json." });
    const requestId = String(req.get("Idempotency-Key") || "");
    if (!requestId)
      return res.status(400).json({ error: "Требуется Idempotency-Key." });
    const response = await execute(
      req.commandContext,
      req.params.id,
      req.body,
      requestId,
    );
    res.json({ ...response, profile: profile(req.commandContext) });
  });
  app.get("/api/notifications", (req, res) =>
    res.json({ notifications: store.inbox(req.commandContext.scope) }),
  );
  app.get("/health", (req, res) => {
    res.set("X-Orbit-Instance", require("./serverLifecycle").instanceId());
    res.json({ ok: true });
  });
  app.get("/vendor/marked.js", (req, res) =>
    res.sendFile(
      path.join(__dirname, "../node_modules/marked/lib/marked.umd.js"),
    ),
  );
  app.get("/vendor/purify.js", (req, res) =>
    res.sendFile(
      path.join(__dirname, "../node_modules/dompurify/dist/purify.min.js"),
    ),
  );
  app.use(
    express.static(path.join(__dirname, "../public"), {
      index: "index.html",
      etag: false,
    }),
  );
  app.use((error, req, res, _next) => {
    console.error("Web request failed:", error.code || error.name);
    res
      .status(error.status === 413 ? 413 : 400)
      .json({ error: "Запрос не обработан. Проверь формат и размер данных." });
  });
  return app;
}
function createWebApp(options = {}) {
  return mountWeb(express(), options);
}
if (require.main === module) {
  CONFIG.validateConfig({ telegram: false });
  const store = getStore(),
    app = createWebApp({ store });
  const host = process.env.WEB_HOST || "127.0.0.1",
    port = Number(process.env.WEB_PORT || 12723);
  const started = require("./serverLifecycle").listen(app, { port, host });
  started.ready
    .then((result) => {
      console.log(
        result.reused
          ? "Веб-интерфейс уже запущен: " + result.url
          : CONFIG.PRODUCT_NAME + ": " + result.url,
      );
      if (result.reused) return;
      const stop = startScheduler(store);
      require("./runtime").installShutdown({
        servers: [result.server],
        stopScheduler: stop,
      });
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
module.exports = { mountWeb, createWebApp, sameSecret };
