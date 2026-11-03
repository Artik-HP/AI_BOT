"use strict";
// Minimal fake of the Telegram Bot API (HTTP). Enough for node-telegram-bot-api polling,
// sendMessage & friends, file download. Used only to exercise the bot without the internet.
const http = require("http");

class FakeTelegram {
  constructor({ token = "111111:FAKE_TOKEN_FOR_TESTS", botId = 424242, botUsername = "test_audit_bot" } = {}) {
    this.token = token;
    this.botId = botId;
    this.botUsername = botUsername;
    this.queue = [];
    this.updateSeq = 1000;
    this.msgSeq = 5000;
    this.calls = []; // every API call: { method, params, at }
    this.fail = new Map(); // method -> { code, description, times }
    this.files = new Map(); // file_id -> { path, bytes }
    this.waiters = new Set();
    this.server = null;
    this.url = null;
  }

  async start() {
    this.server = http.createServer((req, res) => this._handle(req, res).catch((e) => {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error_code: 500, description: String(e) }));
    }));
    await new Promise((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${this.server.address().port}`;
    return this;
  }

  async stop() {
    for (const w of this.waiters) w();
    await new Promise((r) => this.server.close(r));
    this.server.closeAllConnections?.();
  }

  // ---- test API ----
  sent(method = "sendMessage") {
    return this.calls.filter((c) => c.method === method).map((c) => c.params);
  }
  failNext(method, code, description, times = Infinity) {
    this.fail.set(method, { code, description, times });
  }
  clearFail(method) {
    this.fail.delete(method);
  }
  addFile(fileId, path, bytes) {
    this.files.set(fileId, { path, bytes });
  }
  enqueue(update) {
    update.update_id = update.update_id || ++this.updateSeq;
    this.queue.push(update);
    for (const w of this.waiters) w();
  }
  message({ chatId, fromId = chatId, text, chatType = "private", firstName = "Tester", username = "tester_user", isBot = false, ...extra }) {
    const msg = {
      message_id: ++this.msgSeq,
      from: { id: fromId, is_bot: isBot, first_name: firstName, username },
      chat: { id: chatId, type: chatType, first_name: firstName },
      date: Math.floor(Date.now() / 1000),
      ...extra
    };
    if (text !== undefined) msg.text = text;
    this.enqueue({ message: msg });
    return msg;
  }
  callback({ chatId, fromId = chatId, data, messageId = ++this.msgSeq }) {
    this.enqueue({
      callback_query: {
        id: `cb${++this.msgSeq}`,
        from: { id: fromId, is_bot: false, first_name: "Tester" },
        message: { message_id: messageId, chat: { id: chatId, type: "private" }, date: Math.floor(Date.now() / 1000), text: "x" },
        chat_instance: "ci",
        data
      }
    });
  }
  async waitFor(predicate, timeoutMs = 8000, label = "condition") {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (predicate()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timeout waiting for ${label}`);
  }

  // ---- HTTP ----
  async _handle(req, res) {
    const url = new URL(req.url, "http://x");
    const fileMatch = url.pathname.match(/^\/file\/bot([^/]+)\/(.+)$/);

    if (fileMatch) {
      const entry = [...this.files.values()].find((f) => f.path === fileMatch[2]);
      this.calls.push({ method: "FILE_DOWNLOAD", params: { path: fileMatch[2] }, at: Date.now() });
      if (!entry) { res.statusCode = 404; return res.end("not found"); }
      res.setHeader("content-type", "application/octet-stream");
      return res.end(entry.bytes);
    }

    const m = url.pathname.match(/^\/bot([^/]+)\/([A-Za-z]+)$/);
    if (!m) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error_code: 404, description: "Not Found" })); }

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    const params = {};
    for (const [k, v] of url.searchParams) params[k] = v;
    const ct = req.headers["content-type"] || "";
    if (raw && ct.includes("json")) {
      try { Object.assign(params, JSON.parse(raw)); } catch { /* ignore */ }
    } else if (raw && ct.includes("urlencoded")) {
      for (const [k, v] of new URLSearchParams(raw)) params[k] = v;
    }
    const method = m[2];
    if (method !== "getUpdates") this.calls.push({ method, params, at: Date.now() });
    else this.calls.push({ method: "getUpdates", params: { offset: params.offset }, at: Date.now() });

    const send = (obj, status = 200) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(obj));
    };

    const failure = this.fail.get(method);
    if (failure && failure.times > 0) {
      failure.times -= 1;
      return send({ ok: false, error_code: failure.code, description: failure.description }, failure.code);
    }

    switch (method) {
      case "getMe":
        return send({ ok: true, result: { id: this.botId, is_bot: true, first_name: "Test", username: this.botUsername } });
      case "getUpdates": {
        const offset = Number(params.offset || 0);
        const pick = () => this.queue.filter((u) => u.update_id >= offset);
        if (pick().length) return send({ ok: true, result: pick() });
        await new Promise((resolve) => {
          const done = () => { clearTimeout(t); this.waiters.delete(done); resolve(); };
          const t = setTimeout(done, 700);
          this.waiters.add(done);
          req.on("close", done);
        });
        return send({ ok: true, result: pick() });
      }
      case "sendMessage": {
        const text = params.text;
        return send({
          ok: true,
          result: {
            message_id: ++this.msgSeq,
            from: { id: this.botId, is_bot: true, username: this.botUsername },
            chat: { id: Number(params.chat_id) || params.chat_id, type: "private" },
            date: Math.floor(Date.now() / 1000),
            text
          }
        });
      }
      case "editMessageText":
        return send({ ok: true, result: { message_id: Number(params.message_id) || 1, chat: { id: Number(params.chat_id), type: "private" }, date: 1, text: params.text } });
      case "getFile": {
        const f = this.files.get(params.file_id);
        if (!f) return send({ ok: false, error_code: 400, description: "Bad Request: invalid file_id" }, 400);
        return send({ ok: true, result: { file_id: params.file_id, file_unique_id: "u", file_size: f.bytes.length, file_path: f.path } });
      }
      default:
        return send({ ok: true, result: true });
    }
  }
}

module.exports = { FakeTelegram };
