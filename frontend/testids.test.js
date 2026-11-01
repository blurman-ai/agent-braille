// @vitest-environment node
// Works with any bundler: reads sources from disk. Run with vitest or node --test after adapting the imports.
import fs from "node:fs";
import path from "node:path";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

import { SCREEN_NAMES, TESTID_AREAS, TESTID_REQUIRED_DIRS } from "./testidScope.js";

const AREAS = [...SCREEN_NAMES, ...TESTID_AREAS];
const ID_RE = new RegExp(`^(${AREAS.join("|")})\\.[a-z0-9]+(-[a-z0-9]+)*(\\.[a-z0-9-]+)*$`);
const PREFIX_RE = new RegExp(`^(${AREAS.join("|")})\\.([a-z0-9-]+\\.)*[a-z0-9-]*$`);

function sources(entry) {
  if (!fs.existsSync(entry)) return [];
  if (fs.statSync(entry).isFile()) return [entry];
  return fs.readdirSync(entry, { recursive: true }).map((file) => path.join(entry, String(file))).filter((file) => file.endsWith(".tsx") && !file.endsWith(".test.tsx"));
}

describe("action button testids", () => {
  it("follow <area>.<action>", () => {
    const bad = [];
    for (const file of TESTID_REQUIRED_DIRS.flatMap(sources)) {
      const source = fs.readFileSync(file, "utf8");
      for (const [, id] of source.matchAll(/data-testid="([^"]*)"/g)) if (!id.startsWith("screen.") && !ID_RE.test(id)) bad.push(`${file}: ${id}`);
      for (const [, id] of source.matchAll(/data-testid=\{`([^`$]*)\$\{/g)) if (!PREFIX_RE.test(id)) bad.push(`${file}: ${id}`);
    }
    expect(bad).toEqual([]);
  });

  it("control: the scheme rejects wrong names", () => {
    expect(ID_RE.test(`${AREAS[0]}.submit-answer`)).toBe(true);
    expect(ID_RE.test(`${AREAS[0]}.quickPresets`)).toBe(false);
    expect(ID_RE.test("nosuchscreen.ok")).toBe(false);
  });

  it("control: lint requires a testid on a button", async () => {
    const eslint = new ESLint({ cwd: path.dirname(new URL(import.meta.url).pathname) });
    const filePath = `${TESTID_REQUIRED_DIRS[0]}/__probe.tsx`;
    const count = async (jsx) => (await eslint.lintText(`export function P({ f }) {\n  return ${jsx};\n}\n`, { filePath }))[0].messages.filter((m) => m.ruleId === "no-restricted-syntax").length;
    expect(await count("<button onClick={f}>Ok</button>")).toBe(1);
    expect(await count(`<button data-testid="${AREAS[0]}.ok" onClick={f}>Ok</button>`)).toBe(0);
    expect(await count('<button data-testid="submit" onClick={f}>Ok</button>')).toBe(1);
  }, 60_000);
});
