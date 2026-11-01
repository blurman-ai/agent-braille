// Minimal flat config that parses JSX and enables the guard; merge the block into your own config.
import { testidBlock } from "./eslint-testid-block.js";

export default [
  { files: ["**/*.tsx"], languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } } },
  testidBlock(["Button"]),
];
