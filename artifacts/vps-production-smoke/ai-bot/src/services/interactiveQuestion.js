// This protocol is data only. No model-supplied tool name or code is executed.
const MAX_OPTIONS = 100; // resource limit, not a predefined set of answers
const MAX_RESPONSE_BYTES = 256 * 1024;
const optionSchema = {
  type: "object", additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1, maxLength: 64 },
    label: { type: "string", minLength: 1, maxLength: 200 },
    value: { type: "string", minLength: 1, maxLength: 1000, description: "A distinct complete user answer identifying this option, not a generic boolean shared by options." }
  }, required: ["id", "label", "value"]
};
const QUESTION_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    type: { type: "string", enum: ["interactive_question"] },
    question: { type: "string", minLength: 1, maxLength: 4000 },
    selection_mode: { type: "string", enum: ["single", "multiple"] },
    options: { type: "array", minItems: 2, maxItems: MAX_OPTIONS, items: optionSchema },
    allow_custom_input: { type: "boolean" },
    text: { type: "string", maxLength: 12000 }
  }, required: ["type", "question", "selection_mode", "options", "allow_custom_input"]
};
// A fixed root object is compatible with providers that disallow root anyOf.
const RESPONSE_SCHEMA = {
  ...QUESTION_SCHEMA,
  properties: {
    ...QUESTION_SCHEMA.properties,
    type: { type: "string", enum: ["text", "interactive_question"] },
    question: { type: "string", maxLength: 4000 },
    options: { type: "array", maxItems: MAX_OPTIONS, items: optionSchema }
  }, required: [...QUESTION_SCHEMA.required, "text"]
};
const PROTOCOL_PROMPT = {
  role: "system", content: [
    "UI protocol: use the user's language. Ordinary answers and open questions should remain ordinary text.",
    "When asking ONE question with concrete, useful answers, return ONLY an interactive_question JSON object.",
    "Choose dynamic options from the actual conversation, not a fixed template. Do not turn factual lists, code or open questions into choices.",
    "Use selection_mode=multiple if several answers may apply together; otherwise single.",
    "Shape: {\"type\":\"interactive_question\",\"text\":\"optional explanation\",\"question\":\"your question\",\"selection_mode\":\"single\",\"options\":[{\"id\":\"stable_id\",\"label\":\"short clear label\",\"value\":\"complete user answer\"}],\"allow_custom_input\":true}.",
    "Provide 2 or more distinct options as needed, each label preferably under 40 characters. IDs must be unique, using letters, digits, underscore or hyphen.",
    "Option labels and values must also be distinct. Each value must identify the actual answer, such as 'Приём заказов', never identical 'true' values for several different functions.",
    "Always allow custom input. Only ask one interactive question per turn; put any preceding explanation in text.",
    "If a JSON response format is enforced, an ordinary reply uses type=text, text=your answer, question='', selection_mode=single, options=[], allow_custom_input=true.",
    "A short user answer is an answer to your last question. Continue with the selected values and previous context."
  ].join("\n")
};

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function validString(value, max, nonempty = true) {
  return typeof value === "string" && (!nonempty || value.trim().length > 0) && Array.from(value).length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
}
function validateQuestion(value) {
  if (!plainObject(value)) return false;
  if (Object.keys(value).some((key) => !Object.hasOwn(QUESTION_SCHEMA.properties, key))) return false;
  if (!QUESTION_SCHEMA.required.every((key) => Object.hasOwn(value, key))) return false;
  if (value.type !== "interactive_question" || !validString(value.question, 4000)) return false;
  if (!["single", "multiple"].includes(value.selection_mode) || typeof value.allow_custom_input !== "boolean") return false;
  if (value.text !== undefined && !validString(value.text, 12000, false)) return false;
  if (!Array.isArray(value.options) || value.options.length < 2 || value.options.length > MAX_OPTIONS) return false;
  const ids = new Set();
  const values = new Set();
  const labels = new Set();
  return value.options.every((option) => {
    if (!plainObject(option) || Object.keys(option).length !== 3 || !["id", "label", "value"].every((key) => Object.hasOwn(option, key))) return false;
    if (!validString(option.id, 64) || !/^[a-zA-Z0-9_-]+$/.test(option.id) || ids.has(option.id)) return false;
    if (!validString(option.label, 200) || /[\r\n]/.test(option.label) || !validString(option.value, 1000)) return false;
    const value = option.value.trim().toLowerCase(), label = option.label.trim().toLowerCase();
    if (values.has(value) || labels.has(label)) return false;
    ids.add(option.id);
    values.add(value);
    labels.add(label);
    return true;
  });
}
function visibleText(reply, includeOptions = false) {
  if (typeof reply === "string") return reply;
  const explanation = reply.text?.trim() === reply.question?.trim() ? "" : reply.text?.trim();
  return [explanation, reply.question?.trim(), includeOptions ? reply.options.map((option) => option.label).join("\n") : ""].filter(Boolean).join("\n\n");
}
function historyText(reply) {
  if (typeof reply === "string") return reply;
  return `${visibleText(reply)}\nВарианты ответа (${reply.selection_mode}):\n${reply.options.map((option) => `${option.label}: ${option.value}`).join("\n")}`;
}
function parseModelReply(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) throw new Error("AI response is empty or exceeds the response size limit");
  const clean = raw.trim();
  const fenced = clean.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  let candidate = fenced ? fenced[1] : clean;
  let prefix = "";
  if (!candidate.startsWith("{")) {
    const brace = candidate.indexOf("{");
    const before = brace >= 0 ? candidate.slice(0, brace) : "";
    // Keep explanatory code samples as ordinary text; tolerate a model's short
    // conversational preface before the actual protocol object.
    if (brace >= 0 && !/(?:пример|example|схем|schema|код|code|формат|format)/i.test(before.replace(/```(?:json)?/gi, ""))) {
      prefix = before.replace(/```(?:json)?\s*$/i, "").trim();
      candidate = candidate.slice(brace).replace(/\s*```\s*$/, "");
    }
  }
  const protocolLike = /"type"\s*:\s*"(?:interactive_question|text)/.test(candidate)
    || /"(?:selection_mode|allow_custom_input)"\s*:/.test(candidate);
  if (!candidate.startsWith("{") || !protocolLike) return clean;
  try {
    const value = JSON.parse(candidate);
    if (validateQuestion(value)) return { ...value, text: [prefix, value.text].filter(Boolean).join("\n\n").slice(0, 12000), allow_custom_input: true };
    if (plainObject(value) && value.type === "text" && validString(value.text, 12000)) return value.text.trim();
    // Never leak protocol JSON; validated prose is sufficient for a manual reply.
    if (plainObject(value) && validString(value.question, 4000)) return value.question.trim();
  } catch {
    // Includes truncated structured output. It must not create a keyboard.
  }
  return "Не получилось подготовить варианты ответа. Напиши свой ответ текстом или попроси повторить вопрос.";
}

module.exports = { QUESTION_SCHEMA, RESPONSE_SCHEMA, PROTOCOL_PROMPT, MAX_RESPONSE_BYTES, validateQuestion, parseModelReply, visibleText, historyText };
