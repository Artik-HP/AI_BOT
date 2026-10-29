// Explicit discovery excludes archived application copies and works on Node 20 / Windows.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const root = path.join(__dirname, "..");
const files = ["unit", "integration"].flatMap((dir) => fs.readdirSync(path.join(root, "tests", dir))
  .filter((file) => file.endsWith(".test.js")).map((file) => path.join(root, "tests", dir, file)));
const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
