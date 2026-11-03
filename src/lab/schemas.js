function text(value, max = 4000) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("LAB_INVALID_DATA");
  return value.trim();
}

function list(value, min = 1, max = 5) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error("LAB_INVALID_DATA");
  return value.map((item) => text(item, 1500));
}

function jsonReply(reply) {
  if (reply.finishReason !== "stop") throw new Error("LAB_INCOMPLETE_REPLY");
  let raw = reply.text.trim();
  if (raw.startsWith("```json\n") && raw.endsWith("```")) raw = raw.slice(8, -3).trim();
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("LAB_INVALID_DATA");
  return value;
}

function ideasReply(reply) {
  const value = jsonReply(reply);
  if (!Array.isArray(value.ideas) || value.ideas.length !== 3) throw new Error("LAB_INVALID_DATA");
  const ideas = value.ideas.map((idea) => ({ title: text(idea.title, 120), problem: text(idea.problem),
    audience: text(idea.audience), input: text(idea.input), output: text(idea.output), mvp: list(idea.mvp, 3, 5),
    stack: text(idea.stack), effort: text(idea.effort), validation: text(idea.validation),
    limitations: text(idea.limitations), monetization: text(idea.monetization) }));
  if (new Set(ideas.map((idea) => idea.title.toLowerCase())).size !== 3) throw new Error("LAB_INVALID_DATA");
  return ideas;
}

function planReply(reply) {
  const value = jsonReply(reply);
  return { input: text(value.input), processing: text(value.processing), output: text(value.output),
    tasks: list(value.tasks), acceptance: list(value.acceptance), demo: text(value.demo) };
}

function artifactReply(reply, kind) {
  const value = jsonReply(reply);
  if (value.kind !== kind || !["html", "node"].includes(kind)) throw new Error("LAB_INVALID_DATA");
  const code = text(value.code, 48000);
  if (kind === "html" && (!/<!doctype html>/i.test(code) || !/<\/html>\s*$/i.test(code))) {
    throw new Error("LAB_INVALID_HTML");
  }
  // Conservative static checks, never presented as proof that arbitrary code is safe.
  if (/child_process|\beval\s*\(|new\s+Function|require\s*\(\s*['"](?:node:)?vm/.test(code) ||
      /https?:\/\/|\bfetch\s*\(|XMLHttpRequest|WebSocket|<iframe\b/i.test(code)) {
    throw new Error("LAB_UNSUPPORTED_CODE");
  }
  if (!Array.isArray(value.examples) || value.examples.length < 2 || value.examples.length > 5) throw new Error("LAB_INVALID_DATA");
  return { kind, code, instructions: text(value.instructions, 6000),
    examples: value.examples.map((example) => ({ input: text(example.input), output: text(example.output) })),
    validation: text(value.validation), validationStatus: "format_checked_not_executed" };
}

function reviewReply(reply, attemptId, lessonId) {
  const value = jsonReply(reply);
  if (value.attemptId !== attemptId || value.lessonId !== lessonId ||
      !["correct", "needs_work", "uncertain"].includes(value.status) ||
      typeof value.criteriaMet !== "boolean" || (value.status === "correct") !== value.criteriaMet) {
    throw new Error("LAB_INVALID_REVIEW");
  }
  return { status: value.status, explanation: text(value.explanation), recommendations: text(value.recommendations) };
}

function compare(textValue, criteria) {
  const result = { characters: textValue.length };
  if (criteria.maxChars) result.withinLength = textValue.length <= criteria.maxChars;
  if (criteria.words?.length) result.requiredWords = criteria.words.map((word) => ({ word,
    present: textValue.toLowerCase().includes(word.toLowerCase()) }));
  if (criteria.json) {
    try { JSON.parse(textValue); result.validJSON = true; } catch { result.validJSON = false; }
  }
  return result;
}

module.exports = { text, list, jsonReply, ideasReply, planReply, artifactReply, reviewReply, compare };
