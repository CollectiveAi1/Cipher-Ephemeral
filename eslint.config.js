import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "data/**"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-console": ["error", { allow: ["error"] }],
      // `x == null` is the idiomatic null-or-undefined check; everything else is strict.
      eqeqeq: ["error", "always", { null: "ignore" }],
      "object-shorthand": "error",
      "prefer-const": "error",
    },
  },
  {
    files: ["web/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat["recommended-latest"]],
  },
  {
    files: ["server/**/*.ts", "scripts/**/*.mjs"],
    rules: { "no-console": "off" },
  },
  {
    // Plain JS, so TypeScript is not there to vouch for Node's globals.
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
);
