const fs = require("node:fs");
const path = require("node:path");
function updateEnv(
  values,
  file = process.env.CONFIG_ENV_FILE || path.join(__dirname, "../../.env"),
) {
  let content = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  for (const [key, value] of Object.entries(values)) {
    if (
      !/^[A-Z][A-Z0-9_]+$/.test(key) ||
      typeof value !== "string" ||
      /[\r\n]/.test(value)
    )
      throw new Error("Invalid environment value");
    content = content.replace(
      new RegExp("^" + key + "=.*(?:\\r?\\n|$)", "gm"),
      "",
    );
    content = content.trimEnd() + `\n${key}=${JSON.stringify(value)}\n`;
  }
  const temp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(temp, content, { mode: 0o600 });
  fs.renameSync(temp, file);
  Object.assign(process.env, values);
  if (values.BOT_ACCESS_PASSWORD_HASH)
    require("../commandSystem/store")
      .getStore()
      .set("system:access-policy", {
        hash: values.BOT_ACCESS_PASSWORD_HASH,
        updatedAt: Date.now(),
      });
}
module.exports = { updateEnv };
