const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { FakeOpenRouter } = require("../helpers/fakeOpenRouter");
const { loadFresh } = require("../helpers/freshModules");
const fixtures = require("../helpers/labFixtures");

test("lab provider: real HTTP metadata, missing usage, bounded parameters, sanitized non-retried errors", async () => {
  const or = await new FakeOpenRouter().start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lab-provider-"));
  try {
    const { requestLabCompletion } = loadFresh("services/openrouter.js", { OPENROUTER_BASE_URL: or.baseUrl,
      MEMORY_FILE: path.join(dir, "memory.json"), AI_LAB_TIMEOUT_MS: "100", AI_LAB_MODEL: "test/model", AI_LAB_MAX_TOKENS: "256" });
    or.chat = () => fixtures.response("ok");
    const result = await requestLabCompletion([{ role: "user", content: "test" }], { temperature: 0 });
    assert.equal(result.usage.total_tokens, 30); assert.equal(result.usage.cost, undefined);
    assert.equal(result.model, "fake-lab");
    assert.equal(or.chatRequests()[0].body.temperature, 0);
    assert.equal(or.chatRequests()[0].body.max_tokens, 256);
    assert.equal(or.chatRequests()[0].body.model, "test/model");
    or.chat = () => ({ status: 200, body: { choices: [{ finish_reason: "stop", message: { content: "no usage" } }] } });
    assert.deepEqual((await requestLabCompletion([])).usage, {});
    for (const status of [401, 402, 429, 500, 503]) {
      const before = or.chatRequests().length;
      or.chat = () => ({ status, body: { error: { code: status, message: "PRIVATE_ECHO_AND_SECRET" } } });
      await assert.rejects(requestLabCompletion([]), (error) => {
        assert.equal(error.name, "ApiError"); assert.equal(error.status, status);
        assert.ok(!JSON.stringify(error).includes("PRIVATE_ECHO"));
        assert.equal(error.config, undefined); return true;
      });
      assert.equal(or.chatRequests().length, before + 1);
    }
    or.chat = () => ({ status: 200, body: { error: { code: 502, message: "PRIVATE_ECHO" } } });
    await assert.rejects(requestLabCompletion([]), (error) => error.status === 502 && !JSON.stringify(error).includes("PRIVATE_ECHO"));
    or.chat = () => fixtures.response("");
    await assert.rejects(requestLabCompletion([]), (error) => error.code === "INVALID_REPLY");
    const before = or.chatRequests().length;
    or.chat = () => ({ ...fixtures.response("late"), delayMs: 300 });
    await assert.rejects(requestLabCompletion([]), (error) => error.code === "ECONNABORTED");
    assert.equal(or.chatRequests().length, before + 1);
  } finally { await or.stop(); }
});
