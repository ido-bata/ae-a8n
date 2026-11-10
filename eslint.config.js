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
  {
    // The plain-JavaScript runner scripts are not part of the TypeScript
    // project, so the type-aware rules cannot run on them.
    files: ["scripts/**/*.mjs", "test/**/*.mjs"],
    rules: tseslint.configs.disableTypeChecked.rules,
    languageOptions: {
      // The Node globals these scripts use. Listed by hand rather than pulled
      // from a package, so the lint setup stays dependency-free.
      globals: {
        Buffer: "readonly",
        URL: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        clearInterval: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        exports: "writable",
        module: "writable",
        process: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
      },
      parserOptions: {
        projectService: false,
        project: false,
      },
    },
  },
);
