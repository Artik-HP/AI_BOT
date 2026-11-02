const CONFIG = require("../config");
const logger = require("../utils/logger");
const { ApiError } = require("../utils/errors");
const { sanitizeInline } = require("../utils/text");
const { checkContext } = require("../services/auth");
const { askAI, requestToolCompletion } = require("../services/openrouter");
const {
  MAX_HISTORY_MESSAGES,
  getUserMemory,
  remember,
  updatePersonalityMemory,
  getLastMessageByRole,
  buildSystemPrompt,
  buildReplyCorrectionMessage,
  isProbablySameReply
} = require("../services/memory");
const { resolvePersona, usesCompanionEngine } = require("./persona");
const { getStore } = require("./store");
const { withHint } = require("./hints");
const { fallbackReply } = require("./outcomes");
const { toolsFor, createToolContext, executeTool, recentFacts } = require("./tools");
const { digestFor } = require("../ideas/bank");

// One reply of an engine character (ideas or companion): the model may call that character's functions (ideas:
// spark, idea bank, memory, reminders; companion: dice, character, games, memory, reminders) a few times before it
// answers. Only the final text reaches the chat; tool results are data for the model.

const TOOL_BLOCK_MS = 10 * 60 * 1000;
const MAX_CALLS_PER_ROUND = 6;

// A model without tool support answers 404/400 "no endpoints support tool use". Remember that for a while
// instead of paying for one failed request per message.
const toolBlocks = new Map();

function toolsBlocked(model, now = Date.now()) {
  const until = toolBlocks.get(model);

  if (!until) {
    return false;
  }

  if (until <= now) {
    toolBlocks.delete(model);
    return false;
  }

  return true;
}

function resetToolBlocks() {
  toolBlocks.clear();
}

function isToolSupportError(error) {
  return [400, 404, 422].includes(error?.status) && /tool|function/i.test(String(error?.message || ""));
}

function loadFacts(chatId, userId) {
  try {
    return recentFacts(getStore(), chatId, userId);
  } catch (error) {
    logger.error("Companion facts unavailable:", error);
    return [];
  }
}

// What goes into the prompt without a tool call: the size of the person's idea bank and its latest titles.
function loadIdeaBank(chatId, userId) {
  try {
    return digestFor(getStore(), chatId, userId);
  } catch (error) {
    logger.error("Idea bank unavailable:", error);
    return null;
  }
}

async function runCompletion({ memory, history, currentTurn, turn, useTools, toolSet }) {
  const system = buildSystemPrompt(memory, {
    tools: useTools ? toolSet.names : [],
    speakerName: turn.name,
    isGroup: turn.isGroup,
    firstContact: turn.firstContact,
    facts: turn.facts,
    ideas: turn.ideas
  });
  const messages = [system, ...history, currentTurn];
  const context = createToolContext({ ...turn, allowed: toolSet.names });

  for (let round = 1; ; round += 1) {
    checkContext();

    const forceAnswer = round > CONFIG.COMPANION_MAX_TOOL_ROUNDS;
    const reply = await requestToolCompletion(messages, {
      tools: useTools ? toolSet.definitions : undefined,
      toolChoice: forceAnswer ? "none" : "auto"
    });

    if (!useTools || forceAnswer || !reply.toolCalls.length) {
      return { text: reply.text.trim(), system };
    }

    messages.push(reply.assistantMessage);

    for (const [index, call] of reply.toolCalls.entries()) {
      let result;

      if (index < MAX_CALLS_PER_ROUND) {
        result = executeTool(call.function.name, call.function.arguments, context);
        turn.executed += 1;
      } else {
        result = withHint({ ok: false, error: "too_many_calls_in_one_round", max: MAX_CALLS_PER_ROUND });
      }

      // Outcomes, not just a count: an empty final answer must not be read as "done" after a refusal.
      turn.outcomes.push({ name: call.function.name, ok: result?.ok !== false, error: result?.error });
      messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: JSON.stringify(result) });
    }

    turn.onRound?.();
  }
}

async function askCompanion(chatId, text, from, chat = {}) {
  checkContext();

  const memory = updatePersonalityMemory(chatId, text, from);
  const persona = resolvePersona(memory);
  const toolSet = toolsFor(persona);
  const name = sanitizeInline(from?.first_name || from?.username || "", 32);
  const isGroup = chat.type ? chat.type !== "private" : Number(chatId) < 0;
  const userId = String(from?.id ?? chatId);
  const history = memory.messages.slice(-MAX_HISTORY_MESSAGES);
  const previousReply = getLastMessageByRole(memory, "assistant");
  // In a group the model must tell people apart, so every line of theirs carries the speaker's name.
  const userContent = isGroup && name ? `${name}: ${text}` : text;
  const currentTurn = { role: "user", content: userContent };
  let useTools = CONFIG.COMPANION_TOOLS_ENABLED && !toolsBlocked(CONFIG.MODEL);
  const turn = {
    chatId,
    userId,
    name: name || memory.nickname || "",
    isGroup,
    firstContact: memory.messageCount <= 1,
    facts: useTools ? loadFacts(chatId, userId) : [],
    ideas: useTools && persona === "ideas" ? loadIdeaBank(chatId, userId) : null,
    executed: 0,
    outcomes: [],
    onRound: chat.onRound
  };
  let result;

  try {
    result = await runCompletion({ memory, history, currentTurn, turn, useTools, toolSet });
  } catch (error) {
    // Falling back is safe only while nothing has run: a tool call that already changed the state must not be replayed.
    if (!useTools || turn.executed > 0 || !isToolSupportError(error)) {
      throw error;
    }

    logger.warn("The model rejected tools; continuing without them for a while:", error);
    toolBlocks.set(CONFIG.MODEL, Date.now() + TOOL_BLOCK_MS);
    useTools = false;
    result = await runCompletion({ memory, history, currentTurn, turn, useTools, toolSet });
  }

  let reply = result.text;

  // Same guard as in the classic chat: one corrective retry when a long answer repeats the previous one verbatim.
  // After tool calls the answer is about new facts, so there is nothing to compare.
  if (reply && turn.executed === 0 && isProbablySameReply(reply, previousReply)) {
    const retried = await requestToolCompletion([
      result.system,
      buildReplyCorrectionMessage(text),
      ...history.filter((message) => message.role !== "assistant").slice(-6),
      currentTurn
    ], { tools: useTools ? toolSet.definitions : undefined, toolChoice: "none" });

    reply = retried.text.trim() || reply;
  }

  if (!reply) {
    if (!turn.executed) {
      throw new ApiError("OpenRouter вернул пустой ответ", { code: "EMPTY_REPLY" });
    }

    reply = fallbackReply(turn.outcomes);
  }

  checkContext();
  remember(chatId, { role: "user", content: userContent });
  remember(chatId, { role: "assistant", content: reply });
  return reply;
}

// The single entry for text and voice replies: the ideas and companion characters get tools, the classic one the old path.
// Other bots never get tools: they must not be able to farm XP or write into someone's character or idea bank.
function respond(chatId, text, from, chat = {}) {
  if (from?.is_bot || !usesCompanionEngine(resolvePersona(getUserMemory(chatId)))) {
    return askAI(chatId, text, from);
  }

  return askCompanion(chatId, text, from, chat);
}

module.exports = {
  respond,
  askCompanion,
  toolsBlocked,
  resetToolBlocks,
  isToolSupportError
};
