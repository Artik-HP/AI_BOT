// Fake OpenRouter: /api/v1/chat/completions and /api/v1/audio/transcriptions with scriptable behaviour.
const http = require("http");

const TEST_OPENROUTER_KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";

function reply(content) {
  return { status: 200, body: { choices: [{ message: { role: "assistant", content } }] } };
}

function failure(status, message) {
  return { status, body: { error: { message, code: status } } };
}

class FakeOpenRouter {
  constructor() {
    this.requests = [];
    this.chat = () => reply("ok");
    this.stt = () => ({ status: 200, body: { text: "привет из голосового" } });
    this.server = null;
    this.url = null;
  }

  get baseUrl() {
    return `${this.url}/api/v1`;
  }

  async start() {
    this.server = http.createServer((req, res) => this.handle(req, res).catch((error) => {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: String(error) } }));
    }));
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${this.server.address().port}`;
    return this;
  }

  async stop() {
    const closed = new Promise((resolve) => this.server.close(resolve));

    this.server.closeAllConnections?.();
    await closed;
  }

  of(pathname) {
    return this.requests.filter((request) => request.path === pathname);
  }

  chatRequests() {
    return this.of("/api/v1/chat/completions");
  }

  sttRequests() {
    return this.of("/api/v1/audio/transcriptions");
  }

  async handle(req, res) {
    const chunks = [];

    for await (const chunk of req) {
      chunks.push(chunk);
    }

    const raw = Buffer.concat(chunks).toString("utf8");
    let body;

    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }

    const record = { path: new URL(req.url, "http://x").pathname, headers: req.headers, body, at: Date.now() };
    this.requests.push(record);

    let result;

    if (record.path.endsWith("/chat/completions")) {
      result = await this.chat(record);
    } else if (record.path.endsWith("/audio/transcriptions")) {
      result = await this.stt(record);
    } else {
      result = failure(404, "not found");
    }

    if (result.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, result.delayMs));
    }

    res.statusCode = result.status || 200;
    res.setHeader("content-type", "application/json");

    for (const [name, value] of Object.entries(result.headers || {})) {
      res.setHeader(name, value);
    }

    res.end(JSON.stringify(result.body));
  }
}

module.exports = {
  FakeOpenRouter,
  TEST_OPENROUTER_KEY,
  failure,
  reply
};
