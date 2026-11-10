/** Copy the runtime into an application and verify builds. Single owner of both checks. */
import fs from "node:fs";
import path from "node:path";

const RUNTIME = new URL("../runtime/", import.meta.url).pathname;
const HEADER = "// Managed by agent-braille:";
const TARGET = "src/shared/stalker";
/** Where the copy lived before v2, while the bridge was window.__agent. */
const RETIRED = "src/shared/agent";
export const MARKER = fs.readFileSync(path.join(RUNTIME, "install.ts"), "utf8").match(/version: "([^"]+)"/)[1];

/** Differences between the runtime and the application's copy; with install, managed files are updated. */
export function syncRuntime(frontend, { install = false } = {}) {
  const problems = retireOldCopy(frontend, { install });
  for (const name of fs.readdirSync(RUNTIME).filter((file) => file.endsWith(".ts"))) {
    const source = fs.readFileSync(path.join(RUNTIME, name));
    const dest = path.join(frontend, TARGET, name);
    const exists = fs.existsSync(dest);
    if (exists && fs.readFileSync(dest).equals(source)) continue;
    if (install && (!exists || fs.readFileSync(dest, "utf8").startsWith(HEADER))) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, source);
    } else {
      problems.push(`${dest}: ${exists ? "differs from agent-braille" : "missing"}`);
    }
  }
  return problems;
}

/** Why the build does not match expectation; an absent build proves nothing and is a problem too. */
export function checkBuild(dist, expected) {
  const scripts = fs.existsSync(dist) ? fs.readdirSync(dist, { recursive: true }).filter((file) => String(file).endsWith(".js")) : [];
  if (!scripts.length) return [`${dist}: no build output`];
  const present = scripts.some((file) => fs.readFileSync(path.join(dist, file), "utf8").includes(MARKER));
  if (present === (expected === "enabled")) return [];
  return [`${dist}: window.stalker ${present ? "present though expected disabled" : "absent though expected enabled"}`];
}

/** Managed files left in the pre-v2 directory: install removes them, a check names them. */
function retireOldCopy(frontend, { install }) {
  const dir = path.join(frontend, RETIRED);
  if (!fs.existsSync(dir)) return [];
  const problems = [];
  for (const name of fs.readdirSync(dir).filter((file) => file.endsWith(".ts"))) {
    const old = path.join(dir, name);
    if (!fs.readFileSync(old, "utf8").startsWith(HEADER)) continue;
    if (install) fs.rmSync(old);
    else problems.push(`${old}: old copy from before window.stalker; braille install removes it, import from ${TARGET}`);
  }
  if (install && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  return problems;
}
