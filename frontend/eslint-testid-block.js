// Add `testidBlock(["Button", "ActionIcon"])` to the eslint.config.js flat config (ESLint 9), listing the action
// components of your UI library. Native <button> and role-bearing tabs and menu items are always included.
import { testidRequiredGlobs } from "./testidScope.js";

// Only a bare `{...props}` passes: the testid is then set where the component is used.
const NO_SPREAD = ":not(:has(JSXAttribute[name.name='data-testid'])):not(:has(JSXSpreadAttribute[argument.type='Identifier']))";
const MEMBER = "JSXOpeningElement[name.type='JSXMemberExpression'][name.property.name=/^(Tab|Item)$/]";
const BAD_ID = "> JSXAttribute[name.name='data-testid'] > Literal[value!=/^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)+$/]";

export function testidBlock(components = []) {
  const ACTION = `JSXOpeningElement[name.name=/^(${["button", ...components].join("|")})$/]`;
  return {
    files: testidRequiredGlobs(),
    ignores: ["**/*.test.tsx"],
    rules: {
      "no-restricted-syntax": ["error",
        { selector: `${ACTION}${NO_SPREAD}`, message: "An action button needs data-testid=\"<screen>.<action>\"" },
        { selector: `${MEMBER}${NO_SPREAD}`, message: "A tab or menu item needs a data-testid" },
        { selector: `:matches(${ACTION}, ${MEMBER}) ${BAD_ID}`, message: "data-testid is <screen>.<action>: lowercase latin, digits, hyphens, dot-separated" },
      ],
    },
  };
}
