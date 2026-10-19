const js = require("@eslint/js");
const globals = require("globals");
module.exports = [
  {
    ignores: [
      "node_modules/**",
      "data/**",
      "docs/**",
      "test-results/**",
      "public/assets/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.cjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: globals.node,
    },
    rules: {
      "no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          caughtErrors: "none",
          ignoreRestSiblings: true,
        },
      ],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-control-regex": "off",
    },
  },
  {
    files: ["public/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        ...globals.browser,
        DOMPurify: "readonly",
        marked: "readonly",
      },
    },
  },
  { files: ["tests/e2e/*.js"], languageOptions: { globals: globals.browser } },
];
