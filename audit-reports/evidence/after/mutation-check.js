#!/usr/bin/env node
// Mutation check: break one fix at a time in a throwaway copy of the project and make sure the test suite notices.
// A mutation that leaves the suite green means the fix is not protected by a test.
//
//   node audit-reports/evidence/after/mutation-check.js [--only M01,M05] [--jobs 3]
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const SUITE_TIMEOUT_MS = 240000;
const COPIED = ["src", "scripts", "tests", "index.js", "package.json", "eslint.config.mjs", ".env.example", ".gitignore"];

const MUTATIONS = [
  { id: "M01", finding: "F003", what: "safeHandler пробрасывает ошибку обработчика", file: "src/utils/safe.js", find: "      logger.error(`${label} failed:`, error);\n      return undefined;", replace: "      throw error;" },
  { id: "M02", finding: "F005", what: "системный промпт снова требует инструкций по веществам", file: "src/services/memory.js", find: "Не давай пошаговые инструкции", replace: "Давай пошаговые инструкции" },
  { id: "M03", finding: "F006", what: "/health/details открыт без токена", file: "src/bot.js", find: "return Boolean(expected) && crypto.timingSafeEqual(digest(supplied), digest(expected));", replace: "return true;" },
  { id: "M04", finding: "F007", what: "ошибки HTTP не очищаются от config/request", file: "src/utils/errors.js", find: "function toSafeError(error) {\n", replace: "function toSafeError(error) {\n  return error;\n" },
  { id: "M05", finding: "F009", what: "длинный ответ снова обрезается на 4096", file: "src/services/telegram.js", find: "splitMessage(prefixBotMention(cleanReply, options.targetUsername))", replace: "[prefixBotMention(cleanReply, options.targetUsername).slice(0, 4096)]" },
  { id: "M06", finding: "F010", what: "белый список пользователей не работает", file: "src/services/access.js", find: "function isUserAllowed(userId) {\n", replace: "function isUserAllowed(userId) {\n  return true;\n" },
  { id: "M07", finding: "F010", what: "лимит частоты не работает", file: "src/services/access.js", find: "function checkRateLimit(userId, now = Date.now()) {\n", replace: "function checkRateLimit(userId, now = Date.now()) {\n  return { ok: true };\n" },
  { id: "M08", finding: "F012", what: "проверка рисков авто-ответа отключена", file: "src/services/accountAssistant.js", find: "function findAutoSendRisk(text) {\n", replace: "function findAutoSendRisk(text) {\n  return null;\n" },
  { id: "M09", finding: "F013", what: "allow/block снова по отображаемому имени", file: "src/services/accountAssistant.js", find: "    profile.username,\n    profile.username ? `@${profile.username}` : \"\"\n  ].map", replace: "    profile.username,\n    profile.name,\n    profile.username ? `@${profile.username}` : \"\"\n  ].map" },
  { id: "M10", finding: "F014", what: "двойное подтверждение черновика снова отправляет дважды", file: "src/services/accountAssistant.js", find: "  if (draft.sending) {\n    throw createBusyError();\n  }\n\n  draft.sending = true;", replace: "  draft.sending = true;" },
  { id: "M11", finding: "F016", what: "опечатка в булевом значении снова означает false", file: "src/config.js", find: "return FALSE_VALUES.has(word) ? false : null;", replace: "return false;" },
  { id: "M12", finding: "F018", what: "голосовые сообщения обходят проверку доступа", file: "src/handlers/voice.js", find: "if (!await admitMessage(bot, msg)) {", replace: "if (!await Promise.resolve(true)) {" },
  { id: "M13", finding: "F018", what: "фото обходят проверку доступа", file: "src/handlers/photo.js", find: "if (!await admitMessage(bot, msg)) {", replace: "if (!await Promise.resolve(true)) {" },
  { id: "M14", finding: "F010", what: "текст обходит проверку доступа", file: "src/handlers/text.js", find: "if (!await admitMessage(bot, msg)) {", replace: "if (!await Promise.resolve(true)) {" },
  { id: "M15", finding: "F019", what: "ошибка запуска веб-сервера игнорируется", file: "src/bot.js", find: "    if (error) {\n      logger.error(`Web server could not start", replace: "    if (false) {\n      logger.error(`Web server could not start" },
  { id: "M16", finding: "F020", what: "память снова пишется синхронно на каждое сообщение", file: "src/services/memory.js", find: "function scheduleSave() {\n  dirty = true;\n", replace: "function scheduleSave() {\n  dirty = true;\n  saveMemory();\n" },
  { id: "M17", finding: "F021", what: "STT-каскад не останавливается на фатальных статусах", file: "src/services/openrouter.js", find: "const FATAL_STT_STATUSES = new Set([401, 402, 403, 413]);", replace: "const FATAL_STT_STATUSES = new Set([]);" },
  { id: "M18", finding: "F022", what: "«25MB» снова разбирается как NaN", file: "src/config.js", find: "const value = match ? Math.round(Number(match[1]) * BYTES_UNITS[(match[2] || \"b\").toLowerCase()]) : NaN;", replace: "const value = Number(raw);" },
  { id: "M19", finding: "F024", what: "бот отвечает на команды, адресованные другим ботам", file: "src/commands.js", find: "!isAddressedToThisBot(msg.text)", replace: "false" },
  { id: "M20", finding: "F024", what: "ассистент аккаунта принимает чужие адресованные команды", file: "src/services/accountAssistant.js", find: "!isAddressedToThisBot(msg.text) || !isOwnerActor", replace: "false || !isOwnerActor" },
  { id: "M21", finding: "F004", what: "userbot подчиняется любому постороннему", file: "scripts/userbot.js", find: "return Boolean(senderId) && allowedUserIds.includes(senderId);", replace: "return true;" },
  { id: "M22", finding: "F004", what: "userbot игнорирует команды владельца с его аккаунта", file: "scripts/userbot.js", find: "  if (message.out) {\n    return true;", replace: "  if (message.out) {\n    return false;" },
  { id: "M23", finding: "F031", what: "память не сбрасывается на диск при остановке", file: "src/bot.js", find: "    flushMemory();\n    process.exit(exitCode);", replace: "    process.exit(exitCode);" },
  { id: "M24", finding: "F031", what: "опрос Telegram не останавливается по-настоящему", file: "src/services/telegram.js", find: "    bot._polling._abort = true;\n", replace: "" },
  { id: "M25", finding: "F031", what: "повреждённая память не откладывается в карантин", file: "src/services/memory.js", find: "    quarantineCorruptFile(filePath);", replace: "" },
  { id: "M26", finding: "F008", what: "заглушки вида process.env.X принимаются как значения", file: "src/config.js", find: "return PLACEHOLDER_PATTERN.test(String(value ?? \"\"));", replace: "return false;" },
  { id: "M27", finding: "F032", what: "/bot_send теряет многострочный текст", file: "src/commands.js", find: "(@[a-z0-9_]{5,32})\\s+([\\s\\S]+)$/i);", replace: "(@[a-z0-9_]{5,32})\\s+(.+)$/i);" },
  { id: "M28", finding: "F015", what: "сообщения внутри окна троттлинга теряются", file: "src/services/accountAssistant.js", find: "  burst.items.push(entry);\n", replace: "  if (burst.items.length) {\n    return;\n  }\n\n  burst.items.push(entry);\n" },
  { id: "M29", finding: "F027", what: "неудачный /account_enable оставляет включённый флаг", file: "src/services/accountAssistant.js", find: "async function enableAccountAssistant(chatId) {\n", replace: "async function enableAccountAssistant(chatId) {\n  accountAssistantEnabled = true;\n" },
  { id: "M30", finding: "F029", what: "неподдерживаемые форматы изображений снова игнорируются молча", file: "src/handlers/photo.js", find: "function isUnsupportedImageDocument(msg) {\n", replace: "function isUnsupportedImageDocument(msg) {\n  return false;\n" },
  { id: "M31", finding: "F025", what: "просьба «зови меня X» игнорируется", file: "src/services/memory.js", find: "function extractRequestedNickname(text) {\n", replace: "function extractRequestedNickname(text) {\n  return null;\n" },
  { id: "M32", finding: "F017", what: "повторный запрос к модели на любое «похожее» сообщение", file: "src/services/memory.js", find: "function isProbablySameReply(reply, previousReply) {\n", replace: "function isProbablySameReply(reply, previousReply) {\n  return Boolean(reply && previousReply);\n" },
  { id: "M33", finding: "F040", what: "gramjs грузится при старте даже при выключенном ассистенте", file: "src/services/accountAssistant.js", find: "const { parseBoolean } = CONFIG;", replace: "const { parseBoolean } = CONFIG;\nrequire(\"telegram\");" },
  { id: "M34", finding: "F007", what: "логгер не вырезает секреты", file: "src/utils/redact.js", find: "function redact(text) {\n", replace: "function redact(text) {\n  return text;\n" },
  { id: "M36", finding: "S2-01", what: "getMe не повторяется после сбоя при старте", file: "src/services/telegram.js", find: "if (attempt >= IDENTITY_MAX_ATTEMPTS || currentBot !== bot) {", replace: "if (true) {" },
  { id: "M37", finding: "S2-02", what: "ошибки опроса пишутся в лог каждую секунду", file: "src/bot.js", find: "if (current - lastLoggedAt < POLLING_ERROR_LOG_INTERVAL_MS) {", replace: "if (false) {" },
  { id: "M38", finding: "S2-03", what: "разбор ответа модели снова квадратичный на длинной серии пробелов", file: "src/services/openrouter.js", find: "const cleanText = trimLineEnds(String(text || \"\").replace(/\\r\\n/g, \"\\n\")).trim();", replace: "const cleanText = String(text || \"\").replace(/\\r\\n/g, \"\\n\").replace(/[ \\t]+\\n/g, \"\\n\").trim();" },
  { id: "M35", finding: "F010", what: "лимит max_tokens снят", file: "src/services/openrouter.js", find: "max_tokens", replace: "max_tokens_disabled" }
];

function parseArgs(argv) {
  const args = { only: null, jobs: 3 };

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--only") {
      args.only = new Set(argv[++i].split(","));
    } else if (argv[i] === "--jobs") {
      args.jobs = Number(argv[++i]) || 3;
    }
  }

  return args;
}

function makeCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aibot-mut-"));

  for (const entry of COPIED) {
    fs.cpSync(path.join(ROOT, entry), path.join(dir, entry), { recursive: true });
  }

  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"), "dir");

  // The hygiene tests inspect `git ls-files`, so the copy needs to be a repository too.
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

function runSuite(cwd, env) {
  return new Promise((resolve) => {
    // A broken fix can leave a test file hanging (for example a polling loop that never stops),
    // so the whole process group is killed after SUITE_TIMEOUT_MS and counted as a failure.
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap"], { cwd, env: { ...process.env, ...env }, detached: true });
    let out = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }, SUITE_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : code, out: timedOut ? `${out}\nnot ok 0 - (набор тестов завис и был остановлен по таймауту)\n` : out });
    });
  });
}

function failingTests(output) {
  const names = [];

  for (const line of output.split("\n")) {
    const match = line.match(/^\s*not ok \d+ - (.+)$/);

    if (match) {
      names.push(match[1].trim());
    }
  }

  return names;
}

async function runMutation(mutation) {
  const dir = makeCopy();

  try {
    const target = path.join(dir, mutation.file);
    const source = fs.readFileSync(target, "utf8");
    const count = source.split(mutation.find).length - 1;

    if (count !== 1) {
      return { ...mutation, status: "NOT_APPLIED", note: `шаблон найден ${count} раз` };
    }

    fs.writeFileSync(target, source.replace(mutation.find, () => mutation.replace));

    const { code, out } = await runSuite(dir, {});
    const failed = failingTests(out);

    return { ...mutation, status: code === 0 ? "SURVIVED" : "KILLED", failed };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const queue = MUTATIONS.filter((mutation) => !args.only || args.only.has(mutation.id));
  const results = [];

  // Sanity: the unmodified copy must be green, otherwise "killed" proves nothing.
  const cleanDir = makeCopy();
  const clean = await runSuite(cleanDir, {});

  fs.rmSync(cleanDir, { recursive: true, force: true });

  if (clean.code !== 0) {
    console.error("Исходная копия не проходит тесты - проверка мутаций не имеет смысла.");
    console.error(failingTests(clean.out).join("\n"));
    process.exit(2);
  }

  console.log(`Исходная копия зелёная. Мутаций: ${queue.length}, параллельно: ${args.jobs}\n`);

  async function worker() {
    while (queue.length) {
      const mutation = queue.shift();
      const result = await runMutation(mutation);

      results.push(result);
      console.log(`${result.id} ${result.finding} ${result.status.padEnd(11)} ${result.what}${result.failed ? ` [падает тестов: ${result.failed.length}]` : ""}${result.note ? ` (${result.note})` : ""}`);
    }
  }

  await Promise.all(Array.from({ length: args.jobs }, worker));
  results.sort((a, b) => a.id.localeCompare(b.id));

  const killed = results.filter((result) => result.status === "KILLED").length;
  const survived = results.filter((result) => result.status === "SURVIVED");
  const notApplied = results.filter((result) => result.status === "NOT_APPLIED");

  console.log(`\nИтого: убито ${killed} из ${results.length}; выжило ${survived.length}; не применилось ${notApplied.length}`);
  fs.writeFileSync(path.join(__dirname, "mutation-results.json"), JSON.stringify(results.map(({ id, finding, what, status, failed, note }) => ({ id, finding, what, status, failed, note })), null, 2));
  process.exit(survived.length || notApplied.length ? 1 : 0);
}

main();
