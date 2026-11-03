// What the person reads when the model called functions and then answered with no text at all. These texts are for
// people and in Russian; the hints in hints.js are read by the model and stay separate. No second request is made to
// the model: the reply is built from the outcomes the engine has already seen.

const DONE = "Готово.";
const RETRY = "Попробуй ещё раз или скажи иначе.";

const REASONS = {
  looks_like_a_secret: "это похоже на пароль, ключ или номер карты, такое я не сохраняю.",
  storage_full: "хранилище заполнено, ничего не сохранено.",
  store_full: "хранилище заполнено, ничего не сохранено.",
  too_many_ideas: "в банке уже максимум идей, сначала удали ненужные (/ideas del код).",
  too_many_reminders: "напоминаний уже максимум, лишние можно отменить в /reminders.",
  too_many_reminders_in_chat: "в этом чате уже максимум напоминаний, лишние можно отменить в /reminders."
};

// A refusal stands unless a later call of the same function succeeded: the model fixed its arguments and tried again.
function unresolvedFailures(outcomes) {
  return outcomes.filter((outcome, index) => !outcome.ok &&
    !outcomes.slice(index + 1).some((later) => later.ok && later.name === outcome.name));
}

// `outcomes` is [{ name, ok, error }] in the order the calls ran.
function fallbackReply(outcomes = []) {
  const [failed] = unresolvedFailures(outcomes);

  if (!failed) {
    return DONE;
  }

  const reason = REASONS[failed.error];

  if (outcomes.some((outcome) => outcome.ok)) {
    return `Сделано не всё: ${reason || `одно из действий не выполнилось. ${RETRY}`}`;
  }

  return reason ? `Не получилось: ${reason}` : `Действие не выполнилось. ${RETRY}`;
}

module.exports = {
  DONE,
  fallbackReply
};
