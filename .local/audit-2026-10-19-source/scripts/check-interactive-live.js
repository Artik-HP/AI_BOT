// Real OpenRouter verification. Never use the user's chat history for test data.
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert/strict");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
const output = process.env.INTERACTIVE_LIVE_OUTPUT_DIR
  ? path.resolve(process.env.INTERACTIVE_LIVE_OUTPUT_DIR)
  : fs.mkdtempSync(path.join(os.tmpdir(), "ai-bot-interactive-live-"));
fs.mkdirSync(output, { recursive: true });
process.env.MEMORY_FILE = path.join(output, "memory.json");
process.env.INTERACTIVE_STATE_FILE = path.join(output, "interactive-state.json");
const CONFIG = require("../src/config");
const { askAI, askAIWithImage } = require("../src/services/openrouter");
const { validateQuestion, visibleText } = require("../src/services/interactiveQuestion");
const { InteractiveState, renderQuestionKeyboard } = require("../src/services/interactiveState");
const { getModelCapabilities, chooseMode } = require("../src/services/openrouterInteractive");
const scenarios = [
  { name: "hosting-single", selection: "single", prompt: "Хочу создать Telegram-бота для бизнеса. Сейчас нужно выбрать одну площадку размещения: VPS, локальный компьютер или Render. Задай один вопрос о размещении с готовыми вариантами, чтобы я выбрал один." },
  { name: "features-multiple", selection: "multiple", prompt: "Делаем Telegram-бота для бизнеса. Нужно выбрать несколько функций одновременно: приём заказов, AI-консультант, поддержка клиентов, работа с Excel. Задай один вопрос с множественным выбором нужных функций." },
  { name: "open-question", selection: null, prompt: "Помоги разобраться с моим проектом. Сначала задай только один открытый вопрос: попроси меня описать своими словами, как сейчас устроен мой бизнес. Готовые варианты не нужны." }
];
const results = [];
const models = [...new Set([CONFIG.MODEL, CONFIG.VISION_MODEL])];
const mediaOnly = process.argv.includes("--media-only");
const state = new InteractiveState();
async function run() {
  if (!CONFIG.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is missing");
  let chat = -900000;
  for (const model of mediaOnly ? [] : models) {
    const parameters = await getModelCapabilities(model);
    for (const scenario of scenarios) {
      chat--;
      const result = { model, scenario: scenario.name, transport: chooseMode(parameters), stream: false, passed: false };
      try {
        const reply = await askAI(chat, scenario.prompt, { id: 1, first_name: "Integration test" }, { model });
        if (scenario.selection) {
          assert.ok(validateQuestion(reply), "model did not return a valid interactive question");
          assert.equal(reply.selection_mode, scenario.selection);
          const record = state.create(chat, 1, reply);
          state.update(record.id, { messageId: 1 });
          const markup = renderQuestionKeyboard(record);
          assert.ok(markup.inline_keyboard.length > 0);
          const selected = scenario.selection === "multiple" ? [0, 1] : [0];
          const answer = selected.map((i) => reply.options[i].value).join("\n");
          state.update(record.id, { selected, answer, status: "processing" });
          const continuation = await askAI(chat, answer, { id: 1 }, { model, turnId: record.id, selectionQuestion: reply, selectionLabels: selected.map((i) => reply.options[i].label) });
          assert.ok(visibleText(continuation).trim());
          assert.ok(!visibleText(continuation).startsWith("Не получилось подготовить варианты ответа."), "model continuation fell back after malformed data");
          state.update(record.id, { status: "completed", reply: continuation });
          const memory = JSON.parse(fs.readFileSync(process.env.MEMORY_FILE, "utf8"));
          assert.equal(memory[chat].messages.filter((message) => message.role === "user" && message.content === answer).length, 1);
          assert.ok(memory[chat].messages.some((message) => message.role === "assistant" && message.content.includes(reply.question)));
          result.optionCount = reply.options.length;
          result.continuedInteractively = validateQuestion(continuation);
          result.continuation = visibleText(continuation).slice(0, 200);
        } else {
          assert.equal(typeof reply, "string", "open question must not force a keyboard");
          assert.ok(reply.trim());
        }
        result.passed = true;
      } catch (error) {
        result.error = error.response?.status ? `HTTP ${error.response.status}` : error.message;
      }
      results.push(result);
      console.log(JSON.stringify(result));
    }
  }
  // Exercise actual native tool calling and both kinds of fragmented SSE transport.
  for (const entry of mediaOnly ? [] : [
    { model: CONFIG.VISION_MODEL, mode: "tools", stream: false },
    { model: CONFIG.VISION_MODEL, mode: "tools", stream: true },
    { model: CONFIG.VISION_MODEL, mode: "schema", stream: true },
    { model: CONFIG.MODEL, mode: "json", stream: true },
    { model: CONFIG.VISION_MODEL, mode: "prompt", stream: true }
  ]) {
    const result = { ...entry, scenario: "transport-single", passed: false };
    try {
      const reply = await askAI(--chat, scenarios[0].prompt, { id: 1 }, entry);
      assert.ok(validateQuestion(reply), "transport did not produce a valid question");
      result.passed = true;
      result.optionCount = reply.options.length;
    } catch (error) { result.error = error.response?.status ? `HTTP ${error.response.status}` : error.message; }
    results.push(result);
    console.log(JSON.stringify(result));
  }
  const imageResult = { model: CONFIG.VISION_MODEL, scenario: "real-image-question", passed: false };
  try {
    // A small deterministic PNG fixture is sent to the real vision endpoint.
    const zlib = require("zlib");
    function crc32(bytes) {
      let crc = 0xffffffff;
      for (const byte of bytes) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      }
      return (crc ^ 0xffffffff) >>> 0;
    }
    function chunk(type, data) {
      const body = Buffer.concat([Buffer.from(type), data]);
      const size = Buffer.alloc(4), crc = Buffer.alloc(4);
      size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body));
      return Buffer.concat([size, body, crc]);
    }
    const header = Buffer.alloc(13); header.writeUInt32BE(32, 0); header.writeUInt32BE(32, 4); header[8] = 8; header[9] = 2;
    const pixels = Buffer.alloc(32 * (1 + 32 * 3));
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) { const i = y * 97 + 1 + x * 3; pixels[i] = 30; pixels[i + 1] = 90; pixels[i + 2] = 230; }
    const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
    const id = --chat;
    const reply = await askAIWithImage(id, "Посмотри на цвет на изображении. Задай один вопрос с выбором: оставить такой цвет логотипа или выбрать другой цвет? Предложи конкретные кнопки.", { dataUrl: `data:image/png;base64,${png.toString("base64")}` }, { id: 1 });
    assert.ok(validateQuestion(reply));
    const answer = reply.options[0].value;
    const continuation = await askAI(id, answer, { id: 1 }, { model: CONFIG.VISION_MODEL, selectionQuestion: reply });
    assert.ok(visibleText(continuation).trim());
    imageResult.passed = true;
    imageResult.optionCount = reply.options.length;
  } catch (error) { imageResult.error = error.response?.status ? `HTTP ${error.response.status}` : error.message; }
  results.push(imageResult); console.log(JSON.stringify(imageResult));
  fs.writeFileSync(path.join(output, "results.json"), JSON.stringify({ createdAt: new Date().toISOString(), boundary: "Real OpenRouter, schema validation, keyboard generation and isolated persistent history; Telegram delivery/clicks require a separate live test.", results }, null, 2));
  console.log(`Evidence directory: ${output}`);
  if (results.some((result) => !result.passed)) process.exitCode = 1;
}
run().catch((error) => { console.error(error.response?.status ? `HTTP ${error.response.status}` : error.message); process.exitCode = 1; });
