import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "host/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // ExtendScript host scripts are ES3; the driver layer is not.
      "@typescript-eslint/no-unsafe-assignment": "off",
    },
  },
  {
    // The plain-JavaScript runner scripts are not part of the TypeScript
    // project, so the type-aware rules cannot run on them.
    files: ["scripts/**/*.mjs", "test/**/*.mjs"],
    rules: tseslint.configs.disableTypeChecked.rules,
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: false,
      },
    },
  },
);
