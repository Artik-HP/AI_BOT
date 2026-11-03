"use strict";
// Fake OpenRouter: /api/v1/chat/completions and /api/v1/audio/transcriptions with scriptable behaviour.
const http = require("http");

class FakeOpenRouter {
  constructor() {
    this.requests = []; // { path, headers, body, at }
    this.chat = () => ({ status: 200, body: { choices: [{ message: { role: "assistant", content: "ok" } }] } });
    this.stt = () => ({ status: 200, body: { text: "привет из голосового" } });
    this.server = null;
    this.url = null;
  }

  async start() {
    this.server = http.createServer((req, res) => this._handle(req, res).catch((e) => {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: String(e) } }));
    }));
    await new Promise((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${this.server.address().port}`;
    return this;
  }

  async stop() {
    await new Promise((r) => this.server.close(r));
    this.server.closeAllConnections?.();
  }

  of(path) {
    return this.requests.filter((r) => r.path === path);
  }

  async _handle(req, res) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = null;
    try { body = JSON.parse(raw); } catch { body = raw; }
    const rec = { path: new URL(req.url, "http://x").pathname, headers: req.headers, body, at: Date.now() };
    this.requests.push(rec);

    let result;
    if (rec.path.endsWith("/chat/completions")) result = await this.chat(rec);
    else if (rec.path.endsWith("/audio/transcriptions")) result = await this.stt(rec);
    else result = { status: 404, body: { error: { message: "not found" } } };

    if (result.delayMs) await new Promise((r) => setTimeout(r, result.delayMs));
    res.statusCode = result.status || 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result.body));
  }
}

function reply(content) {
  return { status: 200, body: { choices: [{ message: { role: "assistant", content } }] } };
}

module.exports = { FakeOpenRouter, reply };
