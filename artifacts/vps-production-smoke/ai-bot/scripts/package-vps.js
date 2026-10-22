const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const rootFiles = ["index.js", "response.js", "package.json", "package-lock.json", "README.md"];
const webFiles = new Set(["index.html", "style.css", "app.js", "product.js", "i18n.js", "locales.json"]);
const deployFiles = ["README.md", "install.sh", "bot.env.example", "ai-bot.service.example", "Caddyfile.example"];
const digest = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function assertDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Expected a real directory: " + directory);
}

// Deliberately independent of Git: tracked private files and untracked source
// changes must not turn a source transfer into a transfer of personal data.
function selectFiles(root = projectRoot) {
  assertDirectory(root);
  const files = [];
  function add(relative) {
    const stat = fs.lstatSync(path.join(root, relative));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Not a regular source file: " + relative);
    files.push(relative.replaceAll("\\", "/"));
  }
  function walk(relative, accept) {
    const directory = path.join(root, relative);
    assertDirectory(directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const next = path.posix.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Symlinks are not allowed in a VPS package: " + next);
      if (entry.name.startsWith(".") || ["node_modules", "data", "logs"].includes(entry.name)) continue;
      if (entry.isDirectory()) walk(next, accept);
      else if (entry.isFile() && accept(next)) add(next);
    }
  }
  for (const file of rootFiles) add(file);
  walk("src", (file) => file.endsWith(".js"));
  walk("scripts", (file) => file.endsWith(".js"));
  walk("public", (file) => webFiles.has(file.slice("public/".length)) ||
    /^public\/assets\/[a-zA-Z0-9_./-]+\.(?:png|jpe?g|webp|svg|ico|woff2?)$/.test(file));
  assertDirectory(path.join(root, "deploy"));
  assertDirectory(path.join(root, "deploy", "ubuntu"));
  for (const file of deployFiles) add("deploy/ubuntu/" + file);
  return files.sort();
}

function copySource(root, destination, files) {
  for (const file of files) {
    const target = path.join(destination, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let content = fs.readFileSync(path.join(root, file));
    if (!file.startsWith("public/assets/")) {
      content = Buffer.from(content.toString("utf8").replace(/^\uFEFF/, "").replaceAll("\r\n", "\n"));
    }
    fs.writeFileSync(target, content, { flag: "wx", mode: file.endsWith(".sh") ? 0o755 : 0o644 });
  }
}

function verifyBundle(root = projectRoot) {
  const manifestPath = path.join(root, "DEPLOY-MANIFEST.json");
  if (fs.lstatSync(manifestPath).isSymbolicLink()) throw new Error("Manifest must not be a symlink");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const expected = selectFiles(root);
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length !== expected.length) {
    throw new Error("Invalid deployment manifest");
  }
  for (const [index, file] of expected.entries()) {
    const entry = manifest.files[index];
    if (entry.path !== file || entry.sha256 !== digest(path.join(root, file))) {
      throw new Error("Deployment checksum mismatch: " + file);
    }
  }
  return manifest;
}

function stageBundle(destination, root = projectRoot) {
  const manifest = verifyBundle(root);
  assertDirectory(destination);
  if (fs.readdirSync(destination).length) throw new Error("Release destination must be empty");
  copySource(root, destination, manifest.files.map((file) => file.path));
  fs.copyFileSync(path.join(root, "DEPLOY-MANIFEST.json"), path.join(destination, "DEPLOY-MANIFEST.json"));
  verifyBundle(destination);
}

function removeStaging(staging, local) {
  const resolved = fs.realpathSync(staging);
  const parent = fs.realpathSync(local);
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith("vps-package-")) {
    throw new Error("Refusing to clean an unexpected staging path");
  }
  fs.rmSync(resolved, { recursive: true });
}

function createPackage(root = projectRoot) {
  const files = selectFiles(root);
  const local = path.join(root, ".local");
  const artifacts = path.join(root, "artifacts");
  for (const dir of [local, artifacts]) {
    fs.mkdirSync(dir, { recursive: true });
    assertDirectory(dir);
  }
  const output = path.join(artifacts, "vps");
  fs.mkdirSync(output, { recursive: true });
  assertDirectory(output);
  const staging = fs.mkdtempSync(path.join(local, "vps-package-"));
  const tag = new Date().toISOString().replaceAll(":", "-") + "-" + crypto.randomBytes(3).toString("hex");
  const archive = path.join(output, "ai-bot-vps-" + tag + ".tar.gz");
  try {
    const payload = path.join(staging, "ai-bot");
    fs.mkdirSync(payload);
    copySource(root, payload, files);
    const manifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      files: files.map((file) => ({ path: file, sha256: digest(path.join(payload, file)) })),
    };
    fs.writeFileSync(path.join(payload, "DEPLOY-MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");
    verifyBundle(payload);
    const result = spawnSync("tar", ["-czf", archive, "-C", staging, "ai-bot"], { encoding: "utf8" });
    if (result.error || result.status !== 0) throw new Error("tar failed; ensure tar is installed: " + (result.error?.code || result.stderr));
    const sha256 = digest(archive);
    fs.writeFileSync(archive + ".sha256", sha256 + "  " + path.basename(archive) + "\n", { flag: "wx" });
    return { archive, sha256, files: files.length };
  } finally {
    // Only remove the fresh staging directory created by this invocation.
    removeStaging(staging, local);
  }
}

if (require.main === module) {
  try {
    const [command, target, ...extra] = process.argv.slice(2);
    if (extra.length) throw new Error("Unexpected arguments");
    if (command === "--verify" && !target) {
      console.log("VPS package checksums OK: " + verifyBundle().files.length + " files");
    } else if (command === "--stage" && target) {
      stageBundle(path.resolve(target));
      console.log("VPS release staged");
    } else if (!command) {
      console.log(JSON.stringify(createPackage(), null, 2));
    } else throw new Error("Usage: node scripts/package-vps.js [--verify | --stage EMPTY_DIRECTORY]");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { selectFiles, createPackage, verifyBundle, stageBundle };
