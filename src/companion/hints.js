// A refused function call is read by the model, not by a person, so every refusal should say what to do next: fix
// the arguments and call again, look something up first, or stop and tell the person (and never claim success).
// A function that knows better passes its own `hint`, which is kept; this table covers the rest. The RPG rules
// (characters.js) answer with the numbers that were broken (min, max, cap, gold) and are not repeated here.

const ERROR_HINTS = {
  // Any function.
  unknown_tool: "Call only the functions listed in tools.",
  invalid_json: "Send the arguments as one JSON object, for example {\"count\": 1}.",
  invalid_arguments: "Fix the field named in detail and call again.",
  storage_full: "Storage is full and nothing was saved. Tell the person; do not retry.",
  storage_error: "Saving failed and nothing was changed. Tell the person; do not say it worked.",
  store_full: "The bot's storage has no room for one more person or chat, so nothing was saved. Tell the person.",
  looks_like_a_secret: "Passwords, card numbers, keys and documents are never saved. Do not retry with the same text.",
  not_found: "Look the code up first (idea_list, game_state_get) and use one from that answer.",
  too_many_calls_in_one_round: "Make fewer calls at once; repeat the rest in the next round if they are still needed.",

  // Ideas.
  spark_unavailable: "The spark generator failed. Offer ideas without a spark and do not invent random words.",
  no_previous_spark: "This chat has no recent single spark to change. Call idea_spark without reroll.",
  reroll_takes_no_count_or_shape: "Call idea_spark either with reroll alone, or with count or shape and no reroll.",
  invalid_id: "The id is the 8-character code from idea_save or idea_list.",
  nothing_to_change: "Pass at least one field to change, or delete=true.",
  title_taken: "Another idea already has this title (its id is given). Choose another title or change that idea.",
  too_many_ideas: "Ask the person which ideas to delete or mark as done.",

  // Dice and games.
  mode_needs_count_1: "Advantage and disadvantage roll one die twice: pass count=1.",
  invalid_game_key: "Use letters, digits, _ and - (up to 40).",
  state_must_be_an_object: "Pass state as a JSON object, for example {\"room\": 3}.",
  state_too_deep_or_has_forbidden_keys: "Make the state flatter (at most maxDepth levels) and drop keys like __proto__.",
  state_too_large: "Keep only what the game needs next, so that the state fits into max bytes.",
  too_many_games: "This chat keeps too many games. Ask the person which one to delete (game_state_save with delete=true).",

  // Reminders.
  give_exactly_one_of_in_minutes_or_at: "Pass either in_minutes or at: exactly one of them.",
  at_must_be_iso_8601_with_utc_offset: "Write at like example, with the person's UTC offset; if their timezone is unknown, use in_minutes.",
  time_is_in_the_past_or_too_soon: "Choose a moment at least minSeconds from now.",
  too_far_ahead: "A reminder can be at most maxDays ahead.",
  too_many_reminders: "The person has the most pending reminders allowed. They can see and cancel them with /reminders.",
  too_many_reminders_in_chat: "This chat has the most pending reminders allowed. They can be seen and cancelled with /reminders.",
  idea_not_found: "No such idea of this person here: take the id from idea_save or idea_list, or create the reminder without idea_id."
};

// Adds the table's hint to a refusal that has none. Successes and unknown codes pass through untouched.
function withHint(result) {
  if (!result || result.ok !== false || result.hint || !Object.hasOwn(ERROR_HINTS, result.error)) {
    return result;
  }

  return { ...result, hint: ERROR_HINTS[result.error] };
}

module.exports = {
  ERROR_HINTS,
  withHint
};
