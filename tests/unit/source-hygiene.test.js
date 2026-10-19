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

test("в репозитории нет отслеживаемых сессий, резервных копий памяти и .env (F001, F002)", () => {
  const tracked = require("child_process")
    .execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const forbidden = tracked.filter((file) => /(^|\/)(\.env|memory\.json(\..*)?|[^/]*\.session(-journal)?)$/.test(file));

  assert.deepEqual(forbidden, []);
  assert.ok(tracked.includes(".env.example"));
});

test(".env.example не содержит заглушек вида process.env.X (F008)", () => {
  const example = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");

  assert.doesNotMatch(example, /process\.env\./);
});
