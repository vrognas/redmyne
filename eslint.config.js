import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierRecommended from "eslint-plugin-prettier/recommended";

export default [
  // Apply to all TypeScript files
  {
    files: ["**/*.ts", "**/*.tsx"],
  },

  // Ignore build output and dependencies
  {
    ignores: ["out/", "dist/", "node_modules/", "*.js", "*.cjs", "*.mjs"],
  },

  // ESLint recommended rules
  js.configs.recommended,

  // TypeScript ESLint recommended rules
  ...tseslint.configs.recommended,

  // Custom rules matching previous .eslintrc
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      eqeqeq: "error",
      "prefer-const": "error",
      "no-console": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },

  // Prettier integration (must be last to override conflicting rules)
  prettierRecommended,
];
