const crypto = require("crypto");
const TEST_PASSWORD = "fixture-access-917";
const salt = "0123456789abcdef0123456789abcdef";
const key = crypto.scryptSync(TEST_PASSWORD, salt, 32, { N: 16384, r: 8, p: 1 }).toString("hex");
const TEST_PASSWORD_HASH = `scrypt$16384$8$1$${salt}$${key}`;
module.exports = { TEST_PASSWORD, TEST_PASSWORD_HASH };
