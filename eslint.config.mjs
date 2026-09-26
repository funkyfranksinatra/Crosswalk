// Rules-of-hooks only: a hook after an early return took /catalog/gudid to the error boundary
// the first time an import appeared (React #310). Everything else is left to tsc and the tests.
import parser from "@typescript-eslint/parser";
import hooks from "eslint-plugin-react-hooks";

export default [
  { ignores: ["src/generated/**"] },
  {
    files: ["src/**/*.tsx", "src/**/*.ts"],
    linterOptions: { reportUnusedDisableDirectives: "off" },
    languageOptions: { parser, parserOptions: { ecmaFeatures: { jsx: true }, sourceType: "module" } },
    plugins: { "react-hooks": hooks },
    rules: { "react-hooks/rules-of-hooks": "error" },
  },
];
