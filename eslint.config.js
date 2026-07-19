const tseslint = require("typescript-eslint");

module.exports = tseslint.config(
  {
    ignores: ["dist/", "coverage/", "docs/", "node_modules/", "*.js"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    rules: {
      // The library's public surface deliberately uses `unknown` + narrow
      // casts at adapter boundaries; blanket-banning assertions hurts here.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      // Tests intentionally cast through `never`/`unknown` to probe invalid
      // inputs and reach private internals.
      "@typescript-eslint/no-unsafe-function-type": "off",
    },
  }
);
