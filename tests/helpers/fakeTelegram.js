// A small fake of the Telegram Bot API (HTTP): enough for node-telegram-bot-api polling,
// sendMessage and friends, file downloads and controllable failures such as "403 bot was blocked".
const http = require("http");

const TEST_BOT_TOKEN = "123456789:AAFakeTokenForTests_ABCDEFGHIJKLMNOPQ";

class FakeTelegram {
  constructor({ token = TEST_BOT_TOKEN, botId = 424242, botUsername = "test_audit_bot" } = {}) {
    this.token = token;
    this.botId = botId;
    this.botUsername = botUsername;
    this.queue = [];
    this.updateSeq = 1000;
    this.msgSeq = 5000;
    this.calls = [];
    this.fail = new Map();
    this.files = new Map();
    this.waiters = new Set();
    this.server = null;
    this.url = null;
  }

  async start() {
    this.server = http.createServer((req, res) => this.handle(req, res).catch((error) => {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error_code: 500, description: String(error) }));
    }));
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${this.server.address().port}`;
    return this;
  }

  async stop() {
    for (const wake of this.waiters) {
      wake();
    }

    await new Promise((resolve) => this.server.close(resolve));
    this.server.closeAllConnections?.();
  }

  sent(method = "sendMessage") {
    return this.calls.filter((call) => call.method === method).map((call) => call.params);
  }

  texts() {
    return this.sent().map((params) => params.text);
  }

  pollCount() {
    return this.calls.filter((call) => call.method === "getUpdates").length;
  }

  failNext(method, code, description, times = Infinity) {
    this.fail.set(method, { code, description, times });
  }

  clearFail(method) {
    this.fail.delete(method);
  }

  addFile(fileId, filePath, bytes) {
    this.files.set(fileId, { path: filePath, bytes });
  }

  enqueue(update) {
    update.update_id = update.update_id || ++this.updateSeq;
    this.queue.push(update);

    for (const wake of this.waiters) {
      wake();
    }
  }

  message({ chatId, fromId = chatId, text, chatType = "private", firstName = "Tester", username = "tester_user", isBot = false, ...extra }) {
    const msg = {
      message_id: ++this.msgSeq,
      from: { id: fromId, is_bot: isBot, first_name: firstName, username },
      chat: { id: chatId, type: chatType, first_name: firstName },
      date: Math.floor(Date.now() / 1000),
      ...extra
    };

    if (text !== undefined) {
      msg.text = text;
    }

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
      if (predicate()) {
        return true;
      }

      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    throw new Error(`timeout waiting for ${label}`);
  }

  // Resolves after `ms` of silence: used to assert that the bot did NOT answer.
  async quiet(ms = 700) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async handle(req, res) {
    const url = new URL(req.url, "http://x");
    const fileMatch = url.pathname.match(/^\/file\/bot([^/]+)\/(.+)$/);

    if (fileMatch) {
      const entry = [...this.files.values()].find((file) => file.path === fileMatch[2]);
      this.calls.push({ method: "FILE_DOWNLOAD", params: { path: fileMatch[2] }, at: Date.now() });

      if (!entry) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }

      res.setHeader("content-type", "application/octet-stream");
      res.end(entry.bytes);
      return;
    }

    const match = url.pathname.match(/^\/bot([^/]+)\/([A-Za-z]+)$/);

    if (!match) {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error_code: 404, description: "Not Found" }));
      return;
    }

    const chunks = [];

    for await (const chunk of req) {
      chunks.push(chunk);
    }

    const raw = Buffer.concat(chunks).toString("utf8");
    const params = {};

    for (const [key, value] of url.searchParams) {
      params[key] = value;
    }

    const contentType = req.headers["content-type"] || "";

    if (raw && contentType.includes("json")) {
      try {
        Object.assign(params, JSON.parse(raw));
      } catch {
        // ignore malformed JSON
      }
    } else if (raw && contentType.includes("urlencoded")) {
      for (const [key, value] of new URLSearchParams(raw)) {
        params[key] = value;
      }
    }

    const method = match[2];
    this.calls.push({ method, params: method === "getUpdates" ? { offset: params.offset } : params, at: Date.now() });

    const send = (body, status = 200) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    };

    const failure = this.fail.get(method);

    if (failure && failure.times > 0) {
      failure.times -= 1;
      send({ ok: false, error_code: failure.code, description: failure.description }, failure.code);
      return;
    }

    switch (method) {
      case "getMe":
        send({ ok: true, result: { id: this.botId, is_bot: true, first_name: "Test", username: this.botUsername } });
        return;
      case "getUpdates": {
        const offset = Number(params.offset || 0);
        const pick = () => this.queue.filter((update) => update.update_id >= offset);

        if (pick().length) {
          send({ ok: true, result: pick() });
          return;
        }

        await new Promise((resolve) => {
          const done = () => {
            clearTimeout(timer);
            this.waiters.delete(done);
            resolve();
          };
          const timer = setTimeout(done, 600);

          this.waiters.add(done);
          req.on("close", done);
        });
        send({ ok: true, result: pick() });
        return;
      }
      case "sendMessage":
        send({
          ok: true,
          result: {
            message_id: ++this.msgSeq,
            from: { id: this.botId, is_bot: true, username: this.botUsername },
            chat: { id: Number(params.chat_id) || params.chat_id, type: "private" },
            date: Math.floor(Date.now() / 1000),
            text: params.text
          }
        });
        return;
      case "editMessageText":
        send({ ok: true, result: { message_id: Number(params.message_id) || 1, chat: { id: Number(params.chat_id), type: "private" }, date: 1, text: params.text } });
        return;
      case "getFile": {
        const file = this.files.get(params.file_id);

        if (!file) {
          send({ ok: false, error_code: 400, description: "Bad Request: invalid file_id" }, 400);
          return;
        }

        send({ ok: true, result: { file_id: params.file_id, file_unique_id: "u", file_size: file.bytes.length, file_path: file.path } });
        return;
      }
      default:
        send({ ok: true, result: true });
    }
  }
}

module.exports = {
  FakeTelegram,
  TEST_BOT_TOKEN
};
