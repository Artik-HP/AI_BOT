const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const SCAN_DIRS = ["src", "scripts", "tests"];
const SCAN_FILES = ["index.js"];

function listFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return listFiles(fullPath);
    }

    return /\.(js|mjs|json|md)$/.test(entry.name) ? [fullPath] : [];
  });
}

const files = [
  ...SCAN_DIRS.flatMap((directory) => listFiles(path.join(ROOT, directory))),
  ...SCAN_FILES.map((file) => path.join(ROOT, file))
];

test("в исходниках нет невидимых и bidi-символов (защита от Trojan Source и порчи регулярок)", () => {
  const offenders = [];

  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");

    for (const char of text) {
      const code = char.codePointAt(0);
      const invisible = (code >= 0x200b && code <= 0x200f) || (code >= 0x2028 && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069) || code === 0xfeff || code === 0xad;

      if (invisible) {
        offenders.push(`${path.relative(ROOT, file)}: U+${code.toString(16).toUpperCase()}`);
        break;
      }
    }
  }

  assert.deepEqual(offenders, []);
});

// Secrets and personal data (F001, F002) and, since the audit of the new modules, runtime state (N-12): databases with
// their -wal/-shm files, per-run config.env copies, and the generated directories that held them.
const SECRET_FILE = /(^|\/)(\.env|memory\.json(\..*)?|[^/]*\.session(-journal)?)$/;
const RUNTIME_STATE = /(^|\/)([^/]*\.sqlite(-shm|-wal|-journal)?|config\.env)$|^(data|\.local|artifacts)\//;

function trackedFiles() {
  return require("child_process")
    .execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

test("в репозитории нет отслеживаемых сессий, резервных копий памяти и .env (F001, F002)", () => {
  const tracked = trackedFiles();

  assert.deepEqual(tracked.filter((file) => SECRET_FILE.test(file)), []);
  assert.ok(tracked.includes(".env.example"));
});

test("в репозитории нет отслеживаемых баз, config.env и сгенерированных каталогов data/.local/artifacts (N-12)", () => {
  assert.deepEqual(trackedFiles().filter((file) => RUNTIME_STATE.test(file)), []);
});

test("шаблон рантайм-состояния узнаёт опасные пути и не трогает обычные файлы (N-12)", () => {
  for (const file of ["data/commands.sqlite", "data/commands.sqlite-wal", "x/y/state.sqlite-shm", ".local/vps/config.env", "config.env", "artifacts/vps/a.tar.gz", ".local/audit/src/a.js"]) {
    assert.match(file, RUNTIME_STATE, file);
  }

  for (const file of [".env.example", "src/config.js", "src/database.js", "tests/unit/config.test.js", "migrations/001_commercial_accounts.sql", "audit-reports/evidence/x.txt", "docs/data/readme.md"]) {
    assert.doesNotMatch(file, RUNTIME_STATE, file);
  }
});

test(".gitignore закрывает рантайм-состояние, чтобы его нельзя было добавить случайным git add -A (N-12)", () => {
  const ignored = (file) => {
    try {
      require("child_process").execFileSync("git", ["check-ignore", "-q", file], { cwd: ROOT });
      return true;
    } catch {
      return false;
    }
  };

  for (const file of ["data/commands.sqlite", "data/commands.sqlite-wal", "some/dir/state.sqlite-shm", ".local/a/config.env", "config.env", "artifacts/vps/a.tar.gz", ".local/x/y.js"]) {
    assert.ok(ignored(file), `${file} должен быть в .gitignore`);
  }

  assert.equal(ignored("src/config.js"), false);
  assert.equal(ignored(".env.example"), false);
});

test(".env.example не содержит заглушек вида process.env.X (F008)", () => {
  const example = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");

  assert.doesNotMatch(example, /process\.env\./);
});
