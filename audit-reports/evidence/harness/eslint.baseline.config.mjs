import js from "@eslint/js";
import globals from "globals";
export default [
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: { sourceType: "commonjs", ecmaVersion: 2023, globals: { ...globals.node } },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["warn", { args: "after-used", caughtErrors: "none" }],
      "no-unreachable": "error",
      "no-dupe-keys": "error",
      "no-empty": "warn",
      "eqeqeq": ["warn", "always", { null: "ignore" }],
      "no-prototype-builtins": "warn",
      "require-atomic-updates": "off"
    }
  }
];
