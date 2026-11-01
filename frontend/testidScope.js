// Plain JS: read by both eslint.config.js and vitest.

/** Screen names, one per router page; the second part of `data-testid="screen.<name>"`. */
export const SCREEN_NAMES = ["people", "settings"];

/** Testid areas that are not screens: components shown on several screens. */
export const TESTID_AREAS = ["nav"];

/** Directories and files where every action button must carry a data-testid. Grows screen by screen. */
export const TESTID_REQUIRED_DIRS = ["src/pages"];

/** eslint `files` patterns: a directory means all its .tsx, a file means itself. */
export function testidRequiredGlobs() {
  return TESTID_REQUIRED_DIRS.map((p) => (p.endsWith(".tsx") ? p : `${p}/**/*.tsx`));
}
