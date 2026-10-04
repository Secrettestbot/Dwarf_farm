// ESLint flat config. Pragmatic baseline: the recommended JS +
// typescript-eslint rule sets, unmodified except for the tweaks below
// (no-unused-vars honours the `_` prefix; no-console is tightened;
// Math.random is banned inside src/sim).
// Type-aware linting is intentionally off — `tsc -b` already does the
// type checking, and type-aware rules would roughly triple lint time.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.worker },
    },
    rules: {
      // tsc's noUnusedLocals/noUnusedParameters already enforce this;
      // keep the lint rule as a warning-free mirror that honours the
      // `_`-prefix convention used for intentionally unused params.
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
      }],
      // Stray logging in a 60fps loop is a perf and noise hazard; the
      // few deliberate console calls carry an eslint-disable comment
      // saying why.
      "no-console": "error",
    },
  },
  {
    // The simulation must stay deterministic: every random draw goes
    // through the seeded RNG in src/sim/rng.ts.
    files: ["src/sim/**/*.ts"],
    ignores: ["src/sim/**/*.test.ts"],
    rules: {
      "no-restricted-properties": ["error", {
        object: "Math",
        property: "random",
        message: "Use the seeded RNG (src/sim/rng.ts) — the sim must be deterministic.",
      }],
    },
  },
  {
    files: ["scripts/**/*.ts", "*.config.ts", "*.config.js"],
    languageOptions: { globals: { ...globals.node } },
    rules: { "no-console": "off" },
  },
);
