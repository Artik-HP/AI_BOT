const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { validateQuestion, parseModelReply, QUESTION_SCHEMA } = require("../src/services/interactiveQuestion");
const { readCompletionStream, chooseMode } = require("../src/services/openrouterInteractive");
const { renderQuestionKeyboard } = require("../src/services/interactiveState");
function question(changes = {}) {
  return { type: "interactive_question", question: "Как разместить бота?", selection_mode: "single", options: [{ id: "vps", label: "VPS", value: "Разместить на VPS" }, { id: "local", label: "Локально", value: "Запускать локально" }], allow_custom_input: true, ...changes };
}
test("unified schema validates all required fields and rejects unsafe/malformed data", () => {
  assert.equal(QUESTION_SCHEMA.additionalProperties, false);
  assert.ok(validateQuestion(question()));
  for (const change of [{ selection_mode: "invalid" }, { allow_custom_input: "true" }, { question: " " }, { options: [] }, { options: [{ id: "a", label: "a", value: "a" }, { id: "a", label: "b", value: "b" }] }, { extra: "data" }]) assert.equal(validateQuestion(question(change)), false);
  const poisoned = JSON.parse(JSON.stringify(question()).replace('"type":', '"__proto__":{"polluted":true},"type":'));
  assert.equal(validateQuestion(poisoned), false);
  assert.equal({}.polluted, undefined);
  const ambiguous = question();
  ambiguous.options.forEach((option) => { option.value = "true"; });
  assert.equal(validateQuestion(ambiguous), false);
});
test("plain text and code remain plain; protocol JSON is hidden and custom input remains available", () => {
  for (const text of ["Как прошёл день?", "Обычный ответ.", 'Пример:\n```json\n{"type":"interactive_question"}\n```']) assert.equal(parseModelReply(text), text);
  assert.equal(parseModelReply(JSON.stringify(question({ allow_custom_input: false }))).allow_custom_input, true);
  assert.equal(typeof parseModelReply('{"type":"interactive_question","question":'), "string");
  assert.ok(!parseModelReply('{"type":"interactive_question","question":').includes('"type"'));
  assert.equal(parseModelReply(JSON.stringify(question({ options: [] }))), "Как разместить бота?");
  assert.equal(parseModelReply('```json\n' + JSON.stringify(question()) + '\n```').type, "interactive_question");
  const prefaced = parseModelReply('Окей, давай определимся.\n\n' + JSON.stringify(question()));
  assert.equal(prefaced.type, "interactive_question");
  assert.match(prefaced.text, /Окей/);
  assert.equal(parseModelReply('Конечно!\n```json\n' + JSON.stringify(question()) + '\n```').type, "interactive_question");
});
test("dynamic paginated keyboards preserve full values and use small opaque callback data", () => {
  const q = question({ selection_mode: "multiple", options: Array.from({ length: 19 }, (_, i) => ({ id: `id${i}`, label: `${i}: ${"Очень длинный вариант 🙂".repeat(5)}`, value: `Ответ ${i}` })) });
  assert.ok(validateQuestion(q));
  const record = { id: "0123456789abcdef", question: q, status: "active", page: 2, selected: [12] };
  const markup = renderQuestionKeyboard(record);
  assert.ok(markup.inline_keyboard[0][0].text.startsWith("✅"));
  assert.ok(markup.inline_keyboard.flat().some((button) => button.text.includes("Подтвердить (1)")));
  for (const button of markup.inline_keyboard.flat()) assert.ok(Buffer.byteLength(button.callback_data) <= 64);
  record.status = "completed";
  assert.deepEqual(renderQuestionKeyboard(record), { inline_keyboard: [] });
});
test("displayed model text is literal and cannot execute JavaScript or HTML", () => {
  const content = '<script>globalThis.pwned=true</script> ${process.exit()}';
  const parsed = parseModelReply(JSON.stringify(question({ question: content })));
  assert.equal(parsed.question, content);
  assert.equal(globalThis.pwned, undefined);
});
test("capabilities select native schema, tool calling, or prompt fallback", () => {
  assert.equal(chooseMode(["structured_outputs", "tools"]), "schema");
  assert.equal(chooseMode(["tools"]), "tools");
  assert.equal(chooseMode(["response_format"]), "json");
  assert.equal(chooseMode([]), "prompt");
});
test("SSE accumulates fragmented UTF-8 JSON and only yields a completed response", async () => {
  const raw = JSON.stringify(question());
  const data = `: heartbeat\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: raw.slice(0, 35) } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: raw.slice(35) }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
  const bytes = Buffer.from(data);
  const response = await readCompletionStream(Readable.from(Array.from(bytes, (byte) => Buffer.from([byte]))));
  assert.ok(validateQuestion(parseModelReply(response.content)));
  const truncated = Readable.from([`data: ${JSON.stringify({ choices: [{ delta: { content: '{"type":"interactive_question"' } }] })}\n\n`]);
  await assert.rejects(readCompletionStream(truncated), /before completion/);
});
test("fragmented streamed tool calls are data, unknown tools and stream failures are rejected", async () => {
  const parts = [
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "show_interactive_question", arguments: '{"type":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"interactive_question"}' } }] }, finish_reason: "tool_calls" }] }
  ];
  const response = await readCompletionStream(Readable.from(parts.map((part) => `data: ${JSON.stringify(part)}\r\n\r\n`)));
  assert.equal(response.tool_calls[0].function.arguments, '{"type":"interactive_question"}');
  await assert.rejects(readCompletionStream(Readable.from(['data: {"error":{"message":"failed"}}\n\n'])), /error/);
  await assert.rejects(readCompletionStream(Readable.from(['data: {"choices":[{"finish_reason":"length"}]}\n\n'])), /truncated/);
});
