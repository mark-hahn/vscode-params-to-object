const path = require("node:path");
/* @type {import('eslint').Linter.FlatConfig[]} */
module.exports = [
  {
    // ✅ only lint files under src/
    files: ["src/**/*.{js,jsx,ts,tsx,vue}"],
    // (still ignore the usual)
    ignores: ["dist/**", "node_modules/**"],

    languageOptions: {
      parser: require("vue-eslint-parser"),
      parserOptions: {
        parser: require("@typescript-eslint/parser"),
        ecmaVersion: "latest",
        sourceType: "module",
        extraFileExtensions: [".vue"],
        tsconfigRootDir: __dirname,
        projectService: true,
        project: [path.join(__dirname, "tsconfig.eslint.json")]
      }
    },

    plugins: {
      "@typescript-eslint": require("@typescript-eslint/eslint-plugin"),
      vue: require("eslint-plugin-vue")
    },

    rules: {
      // add alongside your other rules
      "no-restricted-syntax": [
        "error",
        {
          // ❌ Flag any `await` that is NOT inside an async function
          // This will flag top-level awaits as well use...
          // /* eslint-disable no-restricted-syntax */
          // await example();
          // /* eslint-enable no-restricted-syntax */
          "selector":
            "AwaitExpression:not(FunctionDeclaration[async=true] *):not(FunctionExpression[async=true] *):not(ArrowFunctionExpression[async=true] *)",
          "message": "Use await only inside an async function (or make the function async)."
        }
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/require-await": "warn"
    }
  }
];
