const axios = require("axios");
const { StringDecoder } = require("string_decoder");
const CONFIG = require("../config");
const { RESPONSE_SCHEMA, QUESTION_SCHEMA, PROTOCOL_PROMPT, MAX_RESPONSE_BYTES, parseModelReply } = require("./interactiveQuestion");

let catalog;
let catalogUntil = 0;
let catalogRequest;
async function getModelCapabilities(model) {
  if (!catalog || Date.now() >= catalogUntil) {
    if (!catalogRequest) {
      catalogRequest = axios.get("https://openrouter.ai/api/v1/models", { timeout: 10000 })
        .then(({ data }) => {
          catalog = new Map((data.data || []).map((item) => [item.id, item.supported_parameters || []]));
          catalogUntil = Date.now() + 60 * 60 * 1000;
        }).catch(() => {
          catalog = new Map();
          catalogUntil = Date.now() + 60000;
        }).finally(() => { catalogRequest = null; });
    }
    await catalogRequest;
  }
  return catalog.get(model) || [];
}
function chooseMode(parameters) {
  if (parameters.includes("structured_outputs")) return "schema";
  if (parameters.includes("tools")) return "tools";
  if (parameters.includes("response_format")) return "json";
  return "prompt";
}
function extractMessage(message) {
  const calls = message?.tool_calls || [];
  if (calls.length) {
    if (calls.length !== 1 || calls[0].function?.name !== "show_interactive_question") throw new Error("Unexpected model tool response");
    return calls[0].function.arguments;
  }
  return message?.content || "";
}
async function readCompletionStream(stream) {
  const decoder = new StringDecoder("utf8");
  let buffer = "", content = "", bytes = 0, finished = false;
  const calls = new Map();
  function event(block) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    const chunk = JSON.parse(data);
    if (chunk.error) throw new Error("OpenRouter stream returned an error");
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) {
      if (!["stop", "tool_calls"].includes(choice.finish_reason)) throw new Error("OpenRouter stream was interrupted or truncated");
      finished = true;
    }
    content += choice.delta?.content || "";
    for (const call of choice.delta?.tool_calls || []) {
      const current = calls.get(call.index) || { function: { name: "", arguments: "" } };
      current.function.name += call.function?.name || "";
      current.function.arguments += call.function?.arguments || "";
      calls.set(call.index, current);
    }
  }
  for await (const chunk of stream) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_RESPONSE_BYTES) throw new Error("OpenRouter stream exceeds the size limit");
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let match;
    while ((match = buffer.match(/\r?\n\r?\n/))) {
      event(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
    }
  }
  buffer += decoder.end();
  if (buffer.trim()) event(buffer);
  if (!finished) throw new Error("OpenRouter stream ended before completion");
  return { content, tool_calls: [...calls.values()] };
}
function isCapabilityError(error) {
  const status = error.response?.status;
  return [400, 404, 422].includes(status) && /(?:schema|structured|response_format|tool|parameter|endpoint|provider)/i.test(JSON.stringify(error.response?.data || {}));
}
async function requestInteractiveCompletion(messages, options = {}) {
  const model = options.model || CONFIG.MODEL;
  const parameters = await getModelCapabilities(model);
  const mode = options.mode || chooseMode(parameters);
  const stream = options.stream ?? CONFIG.OPENROUTER_STREAM;
  const sampling = options.selectionQuestion
    ? { temperature: 0.35, top_p: 0.9, frequency_penalty: 0.2, presence_penalty: 0 }
    : { temperature: 1.05, top_p: 0.92, frequency_penalty: 0.45, presence_penalty: 0.35 };
  const body = {
    max_tokens: CONFIG.AI_MAX_OUTPUT_TOKENS,
    model, messages: [{ role: "system", content: [...messages.filter((message) => message.role === "system").map((message) => message.content), PROTOCOL_PROMPT.content].join("\n\n") }, ...messages.filter((message) => message.role !== "system")],
    ...Object.fromEntries(Object.entries(sampling).filter(([key]) => !parameters.length || parameters.includes(key))),
    stream: Boolean(stream)
  };
  if (mode === "schema") {
    body.response_format = { type: "json_schema", json_schema: { name: "chat_response", strict: true, schema: RESPONSE_SCHEMA } };
    body.provider = { require_parameters: true };
  } else if (mode === "tools") {
    body.tools = [{ type: "function", function: { name: "show_interactive_question", description: "Present a question with concrete answer choices; this only renders UI and executes no action.", parameters: QUESTION_SCHEMA } }];
    body.tool_choice = "auto";
    body.provider = { require_parameters: true };
  } else if (mode === "json") {
    body.response_format = { type: "json_object" };
    body.provider = { require_parameters: true };
  }
  try {
    if(options.budgetScope)require('./aiProviders').consumeBudget(options.budgetScope);
    const response = await axios.post("https://openrouter.ai/api/v1/chat/completions", body, {
      headers: {
        Authorization: `Bearer ${CONFIG.OPENROUTER_API_KEY}`, "Content-Type": "application/json",
        "HTTP-Referer": process.env.APP_URL || "http://localhost", "X-Title": "AI Telegram Bot"
      }, timeout: options.timeout || 60000, maxContentLength: MAX_RESPONSE_BYTES,
      ...(stream ? { responseType: "stream" } : {})
    });
    const message = stream ? await readCompletionStream(response.data) : response.data?.choices?.[0]?.message;
    const finish = !stream && response.data?.choices?.[0]?.finish_reason;
    if (finish && !["stop", "tool_calls"].includes(finish)) throw new Error("OpenRouter response was truncated");
    const parsed = parseModelReply(extractMessage(message));
    if (!parsed) throw new Error("OpenRouter returned an empty response");
    const raw = extractMessage(message);
    const emptyObject = /^\s*(?:\{\s*\}|\[\s*\])\s*$/.test(raw);
    const malformedQuestion = /"type"\s*:\s*"interactive_question/.test(raw) && typeof parsed === "string";
    if ((emptyObject || malformedQuestion || parsed.startsWith?.("Не получилось подготовить варианты ответа.")) && !options.repairAttempt) {
      return requestInteractiveCompletion([
        ...messages,
        { role: "system", content: "Your previous UI response was malformed. Generate a fresh response to the current user message. Either return a valid interactive_question with at least two valid options and all required fields, or an ordinary text reply. Never emit a partial object or an empty interactive_question." }
      ], { ...options, repairAttempt: true });
    }
    if (emptyObject) throw new Error('OpenRouter returned an empty structured object after repair');
    return parsed;
  } catch (error) {
    if (mode !== "prompt" && isCapabilityError(error)) {
      return requestInteractiveCompletion(messages, { ...options, mode: "prompt" });
    }
    throw error;
  }
}
module.exports = { getModelCapabilities, chooseMode, readCompletionStream, requestInteractiveCompletion };
