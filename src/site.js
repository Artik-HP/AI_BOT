const fs = require("fs");
const path = require("path");
const CONFIG = require("./config");
const logger = require("./utils/logger");
const { systemRng } = require("./companion/rules");
const { TECHNIQUES } = require("./ideas/catalog");
const { IDEA_COMMANDS } = require("./ideas/commands");
const { SHAPE_NAMES, drawSparks, shapeOf, labelOf, formatSpark, formatTechnique } = require("./ideas/spark");
const { encodeSpark } = require("./ideas/code");

// The public website: one landing page with a spark roller. It stays static and secret-free on purpose (public
// routes reveal nothing about people or configuration): the files of public/ are read once at start and served from
// memory, the page is filled in from the configuration (name, link to the bot) and from the same catalog and command
// list the bot uses, and the only dynamic route, GET /api/spark, rolls a spark with the bot's own generator. No AI
// is called and nothing is stored, so open access costs nothing. That is also why the site has no spark history:
// remembering what a visitor saw would tie sparks to people.

const PUBLIC_DIR = path.join(__dirname, "..", "public");

const ASSETS = {
  "/style.css": "text/css; charset=utf-8",
  "/app.js": "text/javascript; charset=utf-8",
  "/favicon.svg": "image/svg+xml"
};

// Everything the page needs comes from its own origin; nothing is inline. The page cannot be framed.
const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Opener-Policy": "same-origin"
};

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

function techniqueCards() {
  return TECHNIQUES
    .map(({ name, how }) => `<li class="card"><h3>${escapeHtml(name)}</h3><p>${escapeHtml(how)}</p></li>`)
    .join("\n          ");
}

function commandRows() {
  return IDEA_COMMANDS
    .map(({ command, description }) => `<li><code>/${escapeHtml(command)}</code><span>${escapeHtml(description)}</span></li>`)
    .join("\n          ");
}

// One pass over the template, so that a value containing "{{...}}" is never expanded a second time.
function renderPage(template, config = CONFIG) {
  const url = config.PUBLIC_BOT_URL ? escapeHtml(config.PUBLIC_BOT_URL) : "";
  const values = {
    PRODUCT_NAME: escapeHtml(config.PRODUCT_NAME),
    TELEGRAM_BUTTON: url
      ? `<a class="button primary" href="${url}" rel="noopener">Открыть в Telegram</a>`
      : '<p class="hint">Найди бота в Telegram и нажми Start.</p>',
    TELEGRAM_LINK: url ? `<a class="top-link" href="${url}" rel="noopener">Открыть в Telegram</a>` : "",
    TECHNIQUES: techniqueCards(),
    COMMANDS: commandRows()
  };

  return template.replace(/\{\{([A-Z_]+)\}\}/g, (token, key) => (Object.hasOwn(values, key) ? values[key] : token));
}

// The bot's address with ?start=spark_<код>, built by URL (never by gluing strings); null without PUBLIC_BOT_URL.
function botLink(botUrl, code) {
  if (!botUrl) {
    return null;
  }

  try {
    const url = new URL(botUrl);

    url.searchParams.set("start", `spark_${code}`);
    return url.toString();
  } catch {
    return null;
  }
}

// `text` is the card as the bot writes it, ready to copy; `shape` names which ingredients were drawn; `code` is the
// spark in short form (src/ideas/code.js) and `link` opens it in the bot.
function sparkPayload(rng, { shape, botUrl = "" } = {}) {
  const drawn = drawSparks(rng, { shape });

  if (!drawn.ok) {
    throw new Error(drawn.error);
  }

  const [spark] = drawn.sparks;
  const { id, name, how } = drawn.technique;
  const code = encodeSpark(spark, drawn.technique);
  const link = botLink(botUrl, code);

  return {
    shape: shapeOf(spark),
    ingredients: Object.entries(spark).map(([key, value]) => ({ key, label: labelOf(key), value })),
    technique: { id, name, how },
    text: [formatSpark(spark), formatTechnique(drawn.technique)].join("\n"),
    code,
    ...(link ? { link } : {})
  };
}

// ?shape=minimal and the like. Absent or empty means "let the generator choose"; anything else that is not a known
// shape (also a repeated parameter, which Express turns into a list) is refused.
function requestedShape(query) {
  const raw = query.shape;

  if (raw === undefined || raw === "") {
    return { ok: true, shape: undefined };
  }

  const shape = typeof raw === "string" ? raw.trim().toLowerCase() : "";

  return SHAPE_NAMES.includes(shape) ? { ok: true, shape } : { ok: false };
}

function send(res, type, body, cacheControl) {
  res.set(SECURITY_HEADERS);
  res.set("Content-Type", type);
  res.set("Cache-Control", cacheControl);
  res.send(body);
}

// If public/ cannot be read the Telegram bot must still run: the root page then falls back to a plain line.
function registerSite(app, { config = CONFIG, rng = systemRng } = {}) {
  let page = null;
  const assets = new Map();

  try {
    page = renderPage(fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8"), config);

    for (const [route, type] of Object.entries(ASSETS)) {
      assets.set(route, { type, body: fs.readFileSync(path.join(PUBLIC_DIR, route.slice(1))) });
    }
  } catch (error) {
    logger.error("The website files could not be read; the root page falls back to plain text:", error);
    page = null;
    assets.clear();
  }

  app.get("/", (req, res) => {
    if (!page) {
      res.send("Bot is alive");
      return;
    }

    send(res, "text/html; charset=utf-8", page, "no-cache");
  });

  for (const [route, asset] of assets) {
    app.get(route, (req, res) => send(res, asset.type, asset.body, "public, max-age=600"));
  }

  app.get("/api/spark", (req, res) => {
    try {
      res.set(SECURITY_HEADERS);
      res.set("Cache-Control", "no-store");

      const asked = requestedShape(req.query);

      if (!asked.ok) {
        res.status(400).json({ ok: false, error: "unknown_shape", shapes: SHAPE_NAMES });
        return;
      }

      res.json(sparkPayload(rng, { shape: asked.shape, botUrl: config.PUBLIC_BOT_URL }));
    } catch (error) {
      logger.error("Website spark failed:", error);
      res.status(503).json({ ok: false });
    }
  });
}

module.exports = {
  registerSite,
  renderPage,
  sparkPayload,
  escapeHtml
};
