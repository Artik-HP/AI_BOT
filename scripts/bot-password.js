const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const { Writable } = require("stream");
const dotenv = require("dotenv");
const { hashPassword, HASH_PATTERN } = require("../src/services/auth");

const ACTIVE = "BOT_PASSWORD_HASH";
const LEGACY = "BOT_ACCESS_PASSWORD_HASH";
const LEGACY_PATTERN = /^scrypt:([a-f0-9]{32}):([a-f0-9]{64})$/;
const ASSIGNMENT = /^\s*(?:export\s+)?(BOT_PASSWORD_HASH|BOT_ACCESS_PASSWORD_HASH)\s*=/;

function inspectEnv(text, inherited = {}) {
  const values = dotenv.parse(text);
  const rows = { [ACTIVE]: [], [LEGACY]: [] };
  text.split(/\r?\n/).forEach((line, i) => {
    const match = line.match(ASSIGNMENT);
    if (match) rows[match[1]].push(i + 1);
  });
  const overridden = Object.hasOwn(inherited, ACTIVE);
  const effective = String(overridden ? inherited[ACTIVE] : values[ACTIVE] || "").trim();
  return { values, rows, overridden, valid: HASH_PATTERN.test(effective),
    overrideDiffers: overridden && effective !== String(values[ACTIVE] || "").trim() };
}

function replaceHash(text, hash) {
  if (!HASH_PATTERN.test(hash)) throw new Error("PASSWORD_HASH_INVALID");
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const bom = text.startsWith(String.fromCodePoint(0xfeff)) ? String.fromCodePoint(0xfeff) : "";
  const lines = text.slice(bom.length).split(/\r?\n/);
  const result = [];
  let inserted = false;
  for (const line of lines) {
    if (!ASSIGNMENT.test(line)) { result.push(line); continue; }
    // Do not leave the continuation of a quoted, multiline credential behind.
    const value = line.slice(line.indexOf("=") + 1).trim();
    if (["'", '"', "`"].includes(value[0]) && !value.slice(1).includes(value[0])) {
      throw new Error("PASSWORD_ENV_MULTILINE");
    }
    if (!inserted) { result.push(`${ACTIVE}=${hash}`); inserted = true; }
  }
  if (!inserted) {
    if (result.at(-1) === "") result.pop();
    result.push(`${ACTIVE}=${hash}`, "");
  }
  return bom + result.join(newline);
}

function saveHash(file, original, hash) {
  const target = fs.realpathSync(file);
  if (!fs.statSync(target).isFile()) throw new Error("PASSWORD_ENV_NOT_FILE");
  const updated = replaceHash(original, hash);
  if (fs.readFileSync(target, "utf8") !== original) throw new Error("PASSWORD_ENV_CHANGED");
  const suffix = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const backup = `${target}.before-password-${suffix}`;
  const temporary = `${target}.password-tmp-${suffix}`;
  fs.writeFileSync(backup, original, { flag: "wx", mode: 0o600 });
  try {
    fs.writeFileSync(temporary, updated, { flag: "wx", mode: 0o600 });
    if (fs.readFileSync(target, "utf8") !== original) throw new Error("PASSWORD_ENV_CHANGED");
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return backup;
}

function readHidden(prompt, input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !output.isTTY) return Promise.reject(new Error("PASSWORD_TTY_REQUIRED"));
  return new Promise((resolve, reject) => {
    const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const rl = readline.createInterface({ input, output: muted, terminal: true, historySize: 0 });
    output.write(prompt);
    rl.once("SIGINT", () => { rl.close(); });
    rl.once("close", () => { output.write("\n"); reject(new Error("PASSWORD_CANCELLED")); });
    rl.question("", (answer) => { resolve(answer); rl.close(); });
  });
}

async function main(args = process.argv.slice(2), { env = process.env, ask = readHidden, write = (s) => process.stdout.write(`${s}\n`) } = {}) {
  const [command, option, requestedFile, ...extra] = args;
  if (!["--check", "--set", "--migrate-legacy"].includes(command) ||
      (option && (option !== "--env" || !requestedFile)) || extra.length) {
    throw new Error("PASSWORD_USAGE");
  }
  const file = path.resolve(requestedFile || ".env");
  const original = fs.readFileSync(file, "utf8");
  const info = inspectEnv(original, env);
  write(`Файл настроек: ${file}`);
  if (command === "--check") {
    write(`${ACTIVE}: строк ${info.rows[ACTIVE].length}; формат в файле ${HASH_PATTERN.test(info.values[ACTIVE] || "") ? "КОРРЕКТЕН" : "НЕ НАСТРОЕН или НЕКОРРЕКТЕН"}`);
    write(`${LEGACY}: строк ${info.rows[LEGACY].length}; эта переменная ботом НЕ используется`);
    write(`Переменная ${ACTIVE} в окружении PowerShell/процесса: ${info.overridden ? "ЕСТЬ; она имеет приоритет над файлом" : "НЕТ"}`);
    if (info.overrideDiffers) write("ВНИМАНИЕ: значение в окружении отличается от файла.");
    write(`Проверка формата для нового запуска из этой папки: ${info.valid ? "PASS" : "FAIL"}`);
    if (info.rows[ACTIVE].length > 1) write("ВНИМАНИЕ: повторные строки; dotenv использует последнюю.");
    write("Проверка не подключается к Telegram и не читает настройки уже запущенного бота.");
    return info.valid && info.rows[ACTIVE].length <= 1 ? 0 : 1;
  }
  if (info.overridden) throw new Error("PASSWORD_ENV_OVERRIDE");
  let hash;
  if (command === "--migrate-legacy") {
    if (info.rows[ACTIVE].length || info.rows[LEGACY].length !== 1) throw new Error("PASSWORD_MIGRATION_AMBIGUOUS");
    const legacy = String(info.values[LEGACY] || "").match(LEGACY_PATTERN);
    if (!legacy) throw new Error("PASSWORD_LEGACY_INVALID");
    hash = `scrypt$16384$8$1$${legacy[1]}$${legacy[2]}`;
  } else {
    let password = await ask("Введите новый пароль (ввод скрыт): ");
    let confirmation = await ask("Повторите новый пароль (ввод скрыт): ");
    try {
      if (password !== confirmation) throw new Error("PASSWORD_MISMATCH");
      // The Telegram gate interprets a leading slash as a command.
      if (password.startsWith("/")) throw new Error("PASSWORD_COMMAND_PREFIX");
      hash = await hashPassword(password);
    } finally { password = ""; confirmation = ""; }
  }
  const backup = saveHash(file, original, hash);
  write(`${ACTIVE} сохранён. Старые и повторные строки пароля удалены.`);
  write(`Локальная резервная копия .env (содержит секреты): ${backup}`);
  write("Пароль и хеш не выводятся. Перезапустите единственный работающий экземпляр бота.");
  return 0;
}

const ERRORS = {
  PASSWORD_USAGE: "Используйте --check, --set или --migrate-legacy; при необходимости добавьте --env ПОЛНЫЙ_ПУТЬ.",
  PASSWORD_TTY_REQUIRED: "Для скрытого ввода запустите команду в обычном терминале VS Code/PowerShell.",
  PASSWORD_CANCELLED: "Ввод отменён. Файл не изменён.",
  PASSWORD_MISMATCH: "Пароли не совпадают. Файл не изменён.",
  AUTH_PASSWORD_LENGTH: "Пароль должен содержать от 6 до 256 символов. Файл не изменён.",
  PASSWORD_COMMAND_PREFIX: "Пароль не должен начинаться с /. Файл не изменён.",
  PASSWORD_ENV_OVERRIDE: "Сначала удалите BOT_PASSWORD_HASH из окружения этого терминала: Remove-Item Env:BOT_PASSWORD_HASH -ErrorAction SilentlyContinue. Файл не изменён.",
  PASSWORD_MIGRATION_AMBIGUOUS: "Автоперенос неоднозначен. Используйте --set для установки нового пароля.",
  PASSWORD_LEGACY_INVALID: "Старый хеш некорректен. Используйте --set.",
  PASSWORD_ENV_MULTILINE: "Найдена многострочная запись пароля. Исправьте её вручную; файл не изменён.",
  PASSWORD_ENV_CHANGED: "Файл изменился во время операции. Повторите проверку.",
  ENOENT: "Файл настроек не найден. Перейдите в каталог проекта или укажите --env ПОЛНЫЙ_ПУТЬ.",
  EACCES: "Нет доступа к файлу настроек. Проверьте права пользователя.",
  EPERM: "Файл настроек недоступен для замены. Закройте блокирующую программу и проверьте права."
};

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${ERRORS[error.code] || ERRORS[error.message] || "Операция не выполнена. Проверьте доступ к .env; секретные данные скрыты."}\n`);
    process.exitCode = 1;
  });
}

module.exports = { inspectEnv, replaceHash, saveHash, readHidden, main };
