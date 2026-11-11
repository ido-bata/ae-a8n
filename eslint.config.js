import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // `test/fixtures/**` is a separate-process fixture, not part of the TS project.
  { ignores: ["dist/**", "coverage/**", "host/**", "test/fixtures/**"] },
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
);
