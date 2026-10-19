const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const root = path.join(__dirname, "..");
function check(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) check(file);
    else if (file.endsWith(".js")) {
      const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
      if (result.status !== 0) { process.stderr.write(result.stderr); process.exitCode = 1; }
    }
  }
}
for (const dir of ["src", "scripts", "tests", "public"]) if (fs.existsSync(path.join(root, dir))) check(path.join(root, dir));
const result = spawnSync(process.execPath, ["--check", path.join(root, "index.js")], { encoding: "utf8" });
if (result.status !== 0) { process.stderr.write(result.stderr); process.exitCode = 1; }
if (!process.exitCode) console.log("JavaScript syntax checks passed.");
