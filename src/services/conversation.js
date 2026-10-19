const { askAI } = require("./openrouter");
const { rememberTurn } = require("./memory");
const { historyText } = require("./interactiveQuestion");
const { getInteractiveState, CALLBACK_PREFIX } = require("./interactiveState");
const {
  enqueueChatTask,
  sendAIResponse,
  invalidateInteractiveQuestions,
  refreshInteractiveKeyboard,
  splitTelegramMessage,
} = require("./telegram");

async function processUserText(bot, chatId, text, from, options = {}) {
  await invalidateInteractiveQuestions(chatId).catch((error) => {
    console.error("Interactive state unavailable:", error.code || error.name);
  });
  await bot.sendChatAction(chatId, "typing").catch(() => {});
  const memoryScope = options.memoryScope || chatId;
  const reply = await askAI(memoryScope, text, from, options);
  await sendAIResponse(chatId, reply, {
    ...options.replyOptions,
    model: options.model,
    memoryScope,
    answerUserId: from?.is_bot ? undefined : from?.id,
  });
  return reply;
}

async function submitSelection(bot, record, from) {
  const state = getInteractiveState();
  // Claim synchronously and durably before the first network await.
  const current = state.get(record.id);
  if (!["active", "failed", "generated"].includes(current.status)) return;
  const values = current.selected.map(
    (index) => current.question.options[index].value,
  );
  const answer =
    current.answer ||
    (current.question.selection_mode === "single"
      ? values[0]
      : values.join("\n"));
  if (!answer) return;
  state.update(record.id, {
    status: "processing",
    answer,
    attempts: (current.attempts || 0) + 1,
  });
  await invalidateInteractiveQuestions(
    record.chatId,
    [record.id, current.delivery?.questionId].filter(Boolean),
  );
  await refreshInteractiveKeyboard(state.get(record.id)).catch(() => {});
  try {
    // Telegram bots cannot post a message as a human. This is a visible confirmation;
    // persistent AI history records the answer with role=user.
    if (!state.get(record.id).confirmationSent) {
      const chunks = splitTelegramMessage(`Твой ответ:\n${answer}`);
      for (let index = state.get(record.id).confirmationChunksSent || 0; index < chunks.length; index++) {
        await bot.sendMessage(record.chatId, chunks[index]);
        state.update(record.id, { confirmationChunksSent: index + 1 });
      }
      state.update(record.id, { confirmationSent: true });
    }
    await bot.sendChatAction(record.chatId, "typing").catch(() => {});
    let reply = state.get(record.id).reply;
    if (!reply) {
      reply = await askAI(record.memoryScope || record.chatId, answer, from, {
        turnId: record.id,
        model: record.model,
        selectionQuestion: record.question,
        selectionLabels: current.selected.map(
          (index) => current.question.options[index].label,
        ),
        onReplyReady: (generated) =>
          state.update(record.id, { reply: generated, status: "generated" }),
      });
    } else {
      // On delivery retry, reuse the cached completion and idempotently commit history.
      rememberTurn(
        record.memoryScope || record.chatId,
        answer,
        historyText(reply),
        record.id,
      );
    }
    await sendAIResponse(record.chatId, reply, {
      model: record.model,
      memoryScope: record.memoryScope,
      answerUserId: from.id,
      interactionId: record.id,
    });
    state.update(record.id, { status: "completed" });
    await refreshInteractiveKeyboard(state.get(record.id)).catch(() => {});
  } catch (error) {
    state.update(record.id, { status: "failed" });
    await refreshInteractiveKeyboard(state.get(record.id)).catch(() => {});
    await bot
      .sendMessage(
        record.chatId,
        "Не удалось отправить ответ или получить продолжение. Нажми «Повторить отправку» под вопросом либо напиши ответ текстом.",
      )
      .catch(() => {});
    console.error(
      "Interactive reply failed:",
      error.response?.status || error.code || error.name,
    );
  }
}

async function handleInteractiveCallback(bot, query) {
  if (!query.data?.startsWith(CALLBACK_PREFIX)) return false;
  if (!(await require("./access").guardCallback(bot, query))) return true;
  try {
    const state = getInteractiveState();
    const initial = state.resolve(query);
    const expectedAttempt = initial.record?.attempts || 0;
    await bot
      .answerCallbackQuery(
        query.id,
        initial.error ? { text: initial.error } : {},
      )
      .catch(() => {});
    if (initial.error) return true;
    await enqueueChatTask(initial.record.chatId, async () => {
      const resolved = state.resolve(query);
      if (resolved.error) return;
      const { record, action, index } = resolved;
      if (record.seenCallbacks?.includes(query.id)) return;
      if ((record.attempts || 0) !== expectedAttempt) return;
      state.update(record.id, {
        seenCallbacks: [...(record.seenCallbacks || []), query.id].slice(-200),
      });
      if (action === "s") {
        if (!["active", "failed"].includes(record.status)) return;
        state.update(record.id, { status: "manual" });
        await refreshInteractiveKeyboard(state.get(record.id)).catch(() => {});
        await bot.sendMessage(
          record.chatId,
          "Напиши свой ответ обычным сообщением.",
        );
      } else if (action === "p" && record.status === "active") {
        state.update(record.id, { page: index });
        await refreshInteractiveKeyboard(state.get(record.id));
      } else if (action === "o" && record.status === "active") {
        if (record.question.selection_mode === "multiple") {
          const selected = record.selected.includes(index)
            ? record.selected.filter((value) => value !== index)
            : [...record.selected, index].sort((a, b) => a - b);
          state.update(record.id, { selected });
          await refreshInteractiveKeyboard(state.get(record.id));
        } else {
          state.update(record.id, { selected: [index] });
          await submitSelection(bot, state.get(record.id), query.from);
        }
      } else if (action === "c" && record.status === "active") {
        if (!record.selected.length) {
          await bot.sendMessage(
            record.chatId,
            "Сначала выбери хотя бы один вариант.",
          );
        } else await submitSelection(bot, record, query.from);
      } else if (action === "r" && record.status === "failed") {
        await submitSelection(bot, record, query.from);
      }
    });
  } catch (error) {
    console.error("Interactive button failed:", error.code || error.name);
    if (query.message?.chat?.id)
      await bot
        .sendMessage(
          query.message.chat.id,
          "Не удалось обработать кнопку. Попробуй ещё раз или напиши ответ текстом.",
        )
        .catch(() => {});
  }
  return true;
}
function registerInteractiveHandler(bot) {
  bot.on("callback_query", (query) => handleInteractiveCallback(bot, query));
}
module.exports = {
  processUserText,
  submitSelection,
  handleInteractiveCallback,
  registerInteractiveHandler,
};
