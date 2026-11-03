require("dotenv").config({ quiet: true });

const logger = require("./src/utils/logger");
const { start } = require("./src/bot");

try {
  start();
} catch (error) {
  logger.error(error.message);
  logger.debug(error.stack);
  process.exit(1);
}
