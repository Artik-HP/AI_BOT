import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "audit-reports/**", "coverage/**"] },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      ecmaVersion: 2023,
      globals: { ...globals.node }
    },
    rules: {
      "no-console": "error",
      "no-unused-vars": ["warn", { args: "after-used", caughtErrors: "none" }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error"
    }
  },
  {
    // The logger and the interactive session script write to the console on purpose.
    files: ["src/utils/logger.js", "scripts/create-telegram-session.js", "tests/**/*.js"],
    rules: { "no-console": "off" }
  }
];
