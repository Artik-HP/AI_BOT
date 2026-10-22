const readline = require("node:readline");
const path = require("node:path");
require("dotenv").config({
  path: path.join(__dirname, "../.env"),
  quiet: true,
});
const { updateEnv } = require("../src/services/envSettings");
const { hashPassword } = require("../src/services/access");
const { Writable } = require("node:stream");
const output = new Writable({
  write(chunk, encoding, callback) {
    if (!output.muted) process.stdout.write(chunk);
    callback();
  },
});
const rl = readline.createInterface({
  input: process.stdin,
  output,
  terminal: process.stdin.isTTY,
});
function question(label, secret = false) {
  return new Promise((resolve) => {
    process.stdout.write(label);
    output.muted = secret;
    rl.question("", (value) => {
      output.muted = false;
      if (secret) process.stdout.write("\n");
      resolve(value.trim());
    });
  });
}
async function main() {
  console.log(
    "Настройка Orbit AI. Пустой ответ сохраняет текущую настройку. Секреты не отображаются.",
  );
  const name = await question("Название продукта: "),
    token = await question("Telegram Bot Token: ", true),
    key = await question("OpenRouter API key: ", true),
    password = await question("Пароль доступа к боту: ", true),
    model = await question("Основная AI-модель (provider/model): ");
  const values = {};
  if (name) values.PRODUCT_NAME = name;
  if (token) values.BOT_TOKEN = token;
  if (key) values.OPENROUTER_API_KEY = key;
  if (model) values.OPENROUTER_MODEL = model;
  if (password) values.BOT_ACCESS_PASSWORD_HASH = hashPassword(password);
  if (!password && !process.env.BOT_ACCESS_PASSWORD_HASH)
    throw new Error("Для защищённого экземпляра укажи пароль.");
  values.BOT_ACCESS_IDLE_MS = "600000";
  values.MEMORY_BACKEND='sqlite';
  updateEnv(values);
  console.log(
    "Настройки сохранены. Веб: npm run open:web. Telegram: npm start.",
  );
  rl.close();
}
main().catch((error) => {
  console.error(error.message);
  rl.close();
  process.exitCode = 1;
});
