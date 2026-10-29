require("dotenv").config({ quiet: true });
const logger = require("../src/utils/logger");
const { getDatabase } = require("../src/database");

async function main() {
  let db;
  try {
    db = getDatabase();
    if (!db) throw new Error("DATABASE_URL_MISSING");
    if (process.argv[2] === "migrate") await db.migrate();
    else if (process.argv[2] === "check") await db.health();
    else throw new Error("DATABASE_COMMAND_INVALID");
    logger.info("PostgreSQL operation completed", { operation: process.argv[2] });
  } catch (error) {
    logger.error("PostgreSQL operation failed", { code: /^[A-Z0-9_]+$/.test(error.code || "") ? error.code : "DB_SETUP_REQUIRED" });
    process.exitCode = 1;
  } finally { await db?.close().catch(() => {}); }
}
main();
