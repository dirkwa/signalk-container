import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier/flat";
import globals from "globals";

// ESLint v9.10+ loads this TS config via the `jiti` peer dep at lint
// time — there is no separate compile step. We keep the file at the
// project root (outside `tsconfig.json`'s `include: ["src"]`) so
// `tsc -p tsconfig.json` doesn't emit it into `dist/`.

export default defineConfig([
  globalIgnores(["dist", "public", "node_modules", "src/configpanel"]),

  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended, prettier],
    languageOptions: {
      parser: tseslint.parser,
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "error",
    },
  },
]);
