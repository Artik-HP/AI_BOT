process.env.LOG_LEVEL = "silent";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { registerSite, renderPage, sparkPayload, escapeHtml } = require("../../src/site");
const { SPARK_POOLS, TECHNIQUES } = require("../../src/ideas/catalog");
const { IDEA_COMMANDS } = require("../../src/ideas/commands");
const { SPARK_SHAPES, SHAPE_NAMES, labelOf } = require("../../src/ideas/spark");
const { fixedRng } = require("../helpers/companionFixtures");

const PUBLIC_DIR = path.join(__dirname, "..", "..", "public");
const TEMPLATE = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
const CONFIG = { PRODUCT_NAME: "Бублик", PUBLIC_BOT_URL: "https://t.me/bublik_ideas_bot" };

// A real Express app on a free port, with only the site registered.
async function serve(options = {}, prepare = () => {}) {
  const app = express();

  prepare();
  registerSite(app, { config: CONFIG, ...options });

  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    get: (route) => fetch(base + route),
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    })
  };
}

test("страница: имя и ссылка подставляются экранированными; не остаётся ни одного шаблона", () => {
  const html = renderPage(TEMPLATE, { PRODUCT_NAME: '<b>"Бублик" & Ко</b>', PUBLIC_BOT_URL: 'https://t.me/x?a=1&b="2"' });

  assert.doesNotMatch(html, /\{\{/);
  assert.ok(html.includes("<title>&lt;b&gt;&quot;Бублик&quot; &amp; Ко&lt;/b&gt; — бот, который придумывает идеи</title>"));
  assert.ok(!html.includes('<b>"Бублик"'), "имя не попало на страницу как разметка");
  assert.ok(html.includes('href="https://t.me/x?a=1&amp;b=&quot;2&quot;"'), "ссылка экранирована и не вырывается из атрибута");
  assert.equal(html.split('class="button primary" href=').length - 1, 1, "кнопка Telegram в первом экране одна");
});

test("страница без ссылки на бота: вместо кнопки подсказка, ссылки в шапке нет", () => {
  const html = renderPage(TEMPLATE, { PRODUCT_NAME: "Бублик", PUBLIC_BOT_URL: "" });

  assert.doesNotMatch(html, /class="top-link"|Открыть в Telegram/);
  assert.match(html, /Найди бота в Telegram и нажми Start\./);
});

test("страница: значение, похожее на шаблон, не раскрывается второй раз", () => {
  const html = renderPage(TEMPLATE, { PRODUCT_NAME: "{{COMMANDS}}", PUBLIC_BOT_URL: "" });

  assert.equal(html.split("<code>/").length - 1, IDEA_COMMANDS.length, "команды перечислены один раз");
  assert.ok(html.includes("<title>{{COMMANDS}} —"), "имя осталось буквальным текстом");
});

test("страница показывает все приёмы каталога и все команды бота — теми же словами, что и бот", () => {
  const html = renderPage(TEMPLATE, CONFIG);

  for (const { name, how } of TECHNIQUES) {
    assert.ok(html.includes(`<h3>${escapeHtml(name)}</h3><p>${escapeHtml(how)}</p>`), `нет приёма «${name}»`);
  }

  for (const { command, description } of IDEA_COMMANDS) {
    assert.ok(html.includes(`<code>/${command}</code><span>${escapeHtml(description)}</span>`), `нет команды /${command}`);
  }
});

test("файлы сайта: без инлайновых стилей и скриптов и без внешних адресов — их запретит CSP", () => {
  const js = fs.readFileSync(path.join(PUBLIC_DIR, "app.js"), "utf8");
  const css = fs.readFileSync(path.join(PUBLIC_DIR, "style.css"), "utf8");

  assert.doesNotMatch(TEMPLATE, /\sstyle\s*=|<style\b|\son\w+\s*=|<script(?![^>]*\bsrc=)/i);
  assert.doesNotMatch(TEMPLATE, /(?:src|href)="https?:\/\//i, "внешних ресурсов нет (адрес бота подставляется отдельно)");
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function|document\.write/, "текст из ответа сервера вставляется только как текст");
  assert.doesNotMatch(css, /@import|url\(\s*["']?https?:/i);
});

test("маршруты: страница с заголовками безопасности, ассеты правильных типов, закрытое остальное", async () => {
  const site = await serve();

  try {
    const root = await site.get("/");
    const html = await root.text();

    assert.equal(root.status, 200);
    assert.match(root.headers.get("content-type"), /^text\/html; charset=utf-8/);
    assert.match(root.headers.get("content-security-policy"), /default-src 'none'.*frame-ancestors 'none'/);
    assert.doesNotMatch(root.headers.get("content-security-policy"), /unsafe-inline|unsafe-eval/);
    assert.equal(root.headers.get("x-content-type-options"), "nosniff");
    assert.equal(root.headers.get("referrer-policy"), "no-referrer");
    assert.equal(root.headers.get("cache-control"), "no-cache");
    assert.match(html, /<title>Бублик — бот, который придумывает идеи<\/title>/);

    for (const [route, type] of [["/style.css", /^text\/css/], ["/app.js", /^text\/javascript/], ["/favicon.svg", /^image\/svg\+xml/]]) {
      const asset = await site.get(route);

      assert.equal(asset.status, 200, route);
      assert.match(asset.headers.get("content-type"), type, route);
      assert.equal(asset.headers.get("x-content-type-options"), "nosniff", route);
      assert.equal(Buffer.from(await asset.arrayBuffer()).compare(fs.readFileSync(path.join(PUBLIC_DIR, route.slice(1)))), 0, `${route} отдаётся без изменений`);
    }

    for (const route of ["/nope", "/index.html", "/public/index.html", "/..%2fpackage.json", "/src/config.js", "/.env", "/memory.json", "/package.json"]) {
      assert.equal((await site.get(route)).status, 404, `${route} не должен отдаваться`);
    }
  } finally {
    await site.close();
  }
});

test("/api/spark: ингредиенты и приём из каталога, не кэшируется; скриптованный генератор даёт повторяемый ответ", async () => {
  const known = new Set(Object.values(SPARK_POOLS).flat());
  const site = await serve();

  try {
    const response = await site.get("/api/spark");
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^application\/json/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.ok(payload.ingredients.length >= 2);

    for (const { key, label, value } of payload.ingredients) {
      assert.ok([key, label, value].every((text) => typeof text === "string" && text), JSON.stringify({ key, label, value }));
      assert.ok(known.has(value), `«${value}» нет в каталоге`);
    }

    assert.ok(TECHNIQUES.some((technique) => technique.id === payload.technique.id && technique.name === payload.technique.name));

    const seen = new Set();

    for (let index = 0; index < 20; index += 1) {
      seen.add(JSON.stringify(await (await site.get("/api/spark")).json()));
    }

    assert.ok(seen.size > 10, "искры на сайте разные");
  } finally {
    await site.close();
  }

  assert.deepEqual(sparkPayload(fixedRng([1, 2, 3, 4])), sparkPayload(fixedRng([1, 2, 3, 4])));

  for (const { key, label } of sparkPayload(fixedRng([0, 0, 0, 0])).ingredients) {
    assert.equal(label, labelOf(key), "подпись берётся из тех же названий, что и в боте");
  }
});

test("/api/spark?shape=…: форма по заказу в любом регистре; пустой параметр — любая форма; готовый текст карточки", async () => {
  const site = await serve();

  try {
    for (const shape of SPARK_SHAPES) {
      const payload = await (await site.get(`/api/spark?shape=${shape.name.toUpperCase()}`)).json();

      assert.equal(payload.shape, shape.name);
      assert.deepEqual(payload.ingredients.map((entry) => entry.key), shape.ingredients);
      assert.equal(payload.text, [...payload.ingredients.map(({ label, value }) => `${label}: ${value}`), `Приём «${payload.technique.name}»: ${payload.technique.how}`].join("\n"));
    }

    const any = await site.get("/api/spark?shape=");

    assert.equal(any.status, 200);
    assert.ok(SHAPE_NAMES.includes((await any.json()).shape));
    assert.equal((await site.get("/api/spark?other=1")).status, 200, "незнакомые параметры не мешают");
  } finally {
    await site.close();
  }
});

test("/api/spark: неизвестная или повторённая форма — 400 со списком форм, без броска", async () => {
  let rolled = 0;
  const site = await serve({ rng: { int(min) { rolled += 1; return min; } } });

  try {
    for (const query of ["?shape=bogus", "?shape=classic&shape=minimal", "?shape=%3Cscript%3E"]) {
      const response = await site.get(`/api/spark${query}`);

      assert.equal(response.status, 400, query);
      assert.equal(response.headers.get("cache-control"), "no-store", query);
      assert.match(response.headers.get("content-security-policy"), /default-src 'none'/, query);
      assert.deepEqual(await response.json(), { ok: false, error: "unknown_shape", shapes: SHAPE_NAMES }, query);
    }

    assert.equal(rolled, 0, "на плохой запрос генератор не тратится");
  } finally {
    await site.close();
  }
});

test("переключатель формы на странице: только известные формы, по умолчанию «Любая», без JavaScript в разметке", () => {
  const html = renderPage(TEMPLATE, CONFIG);
  const shapes = [...html.matchAll(/data-shape="([^"]*)"/g)].map((match) => match[1]);
  const pressed = [...html.matchAll(/data-shape="([^"]*)" aria-pressed="true"/g)].map((match) => match[1]);

  assert.ok(shapes.length >= 2);
  assert.ok(shapes.every((shape) => shape === "" || SHAPE_NAMES.includes(shape)), shapes.join(", "));
  assert.deepEqual(pressed, [""], "выбрана ровно одна кнопка — «любая форма»");
});

test("/api/spark: сбой генератора — 503 без подробностей, а не падение и не стек", async () => {
  const site = await serve({ rng: { int() { throw new Error("secret internal detail"); } } });

  try {
    const response = await site.get("/api/spark");

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false });
  } finally {
    await site.close();
  }
});

test("если файлы сайта недоступны: / отвечает прежней строкой, остальные маршруты не ломаются", async () => {
  const original = fs.readFileSync;
  const site = await serve({}, () => {
    fs.readFileSync = (file, ...rest) => {
      if (String(file).endsWith("index.html")) {
        throw new Error("ENOENT: simulated");
      }

      return original(file, ...rest);
    };
  });

  fs.readFileSync = original;

  try {
    const root = await site.get("/");

    assert.equal(await root.text(), "Bot is alive");
    assert.equal((await site.get("/style.css")).status, 404, "без страницы нет и её ассетов");
    assert.equal((await site.get("/api/spark")).status, 200);
  } finally {
    await site.close();
  }
});
