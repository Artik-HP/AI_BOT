// Compatibility names point to one handler; they are not duplicated implementations.
const aliases = {
  ask: { id: "chat" },
  calc: { id: "calculator" },
  remind: { id: "reminder" },
  fact: { id: "trivia" },
  teach: { id: "learnjs" },
  game: { id: "menu", defaultArgs: "games" },
};
function resolve(id, args = "") {
  const alias = aliases[id];
  return alias
    ? { id: alias.id, args: args || alias.defaultArgs || "" }
    : { id, args };
}
module.exports = { aliases, resolve };
