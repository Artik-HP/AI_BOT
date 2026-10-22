const fs = require("node:fs");
const path = require("node:path");
let dictionaries;
function dictionary(language) {
  if (!["en", "uk"].includes(language)) return {};
  if (!dictionaries) {
    const file = path.join(__dirname, "../../public/locales.json");
    dictionaries = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8"))
      : {};
  }
  return dictionaries[language] || {};
}
function translate(text, language) {
  const values = dictionary(language);
  return values[text] || text;
}
function commandMetadata(command, language) {
  return {
    ...command,
    title: translate(command.title, language),
    description: translate(command.description, language),
  };
}
module.exports = { dictionary, translate, commandMetadata };
