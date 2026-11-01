#!/usr/bin/env node
/**
 * agent-braille command line.
 *
 *   braille check <dir>                       validate every scenario in a directory, no browser
 *   braille run <scenario.json>… --base URL   run scenarios; exit 0 green, 1 red, 2 bad call
 *       [--out DIR] [--record-api DIR | --replay-api DIR] [--storage-state FILE] [--values FILE]
 *   braille start --base URL [--storage-state FILE] [--values FILE]   open a step session in the background
 *   braille step '<step JSON>' | look | close  drive the session one step at a time
 *   braille install <frontend>                copy the runtime into <frontend>/src/shared/agent
 *   braille check-runtime <frontend>          fail if the application's copy drifted
 *   braille check-build <dist> enabled|disabled   prove the agent API is in or out of a build
 *   braille selftest                          control cases, no network
 *
 * Scenario format and rules for the model: docs/SCENARIOS.md.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { fillValues } from "../lib/session.mjs";
import { AFTER_KINDS, parseStep } from "../lib/steps.mjs";
import { checkBuild, syncRuntime } from "../lib/install.mjs";

const EXECUTOR = new URL("../lib/executor.mjs", import.meta.url).pathname;
const REQUIRED_FIELDS = ["name", "why", "verifies", "steps"];
const EXPECT_KINDS = ["wait", "order", "absent", "active", "disabled", "enabled", "field", "filled", "checked", "unchecked", "focused", "visible", "hidden", "fact", "requested", "described"];
const SESSION_FILE = path.resolve("tmp/braille/current");
const SESSION_ROOT = path.resolve("tmp/braille");
const START_TIMEOUT_MS = 60_000;
const STEP_DEFAULT_S = 300;
const STEP_SLACK_S = 120;
const STALE_HEARTBEAT_S = 15;
const POLL_MS = 200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every reason a scenario is malformed; strict adds the rules for new scenarios. */
export function scenarioProblems(scenario, fileName, { strict = true } = {}) {
  const problems = REQUIRED_FIELDS.filter((field) => scenario[field] === undefined).map((field) => `missing field ${field}`);
  if (fileName && scenario.name && scenario.name !== path.basename(fileName, ".json")) problems.push("name differs from the file name");
  if (!Array.isArray(scenario.steps)) return problems;
  if (!fileName?.startsWith("_") && !path.basename(fileName ?? "").startsWith("_") && Array.isArray(scenario.verifies) && !scenario.verifies.length) problems.push("verifies names no requirement");
  scenario.steps.forEach((raw, index) => {
    try {
      const step = parseStep(raw);
      if (typeof raw.wait === "number") problems.push(`step ${index + 1}: fixed pause; wait for something observable through after or wait`);
      if (strict && AFTER_KINDS.includes(step.kind) && !raw.after) problems.push(`step ${index + 1}: ${step.kind} needs after: what becomes observable`);
      if (strict && step.kind === "click" && typeof raw.click === "string") problems.push(`step ${index + 1}: click by label; use {"testid": …}`);
    } catch (error) {
      problems.push(`step ${index + 1}: ${error.message}`);
    }
  });
  if (!scenario.steps.some((raw) => EXPECT_KINDS.some((kind) => kind in raw))) problems.push("no expectation: the scenario checks nothing");
  return problems;
}

function check(dir) {
  const files = fs.readdirSync(dir).filter((file) => file.endsWith(".json"));
  let bad = 0;
  for (const file of files) {
    for (const problem of scenarioProblems(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")), file)) {
      console.log(`${file}: ${problem}`);
      bad += 1;
    }
  }
  console.log(`checked ${files.length} scenarios, ${bad} problems`);
  return bad ? 1 : 0;
}

function parseOptions(argv) {
  const names = { "--base": "base", "--out": "out", "--record-api": "recordApi", "--replay-api": "replayApi", "--storage-state": "storageState", "--values": "values" };
  const options = { rest: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (names[argv[i]]) options[names[argv[i]]] = argv[(i += 1)];
    else if (argv[i] === "--loose") options.loose = true;
    else options.rest.push(argv[i]);
  }
  return options;
}

const executorFlags = (options) => [...(options.storageState ? ["--storage-state", options.storageState] : [])];

function runOne(file, options) {
  const scenario = JSON.parse(fs.readFileSync(file, "utf8"));
  const problems = scenarioProblems(scenario, path.basename(file), { strict: !options.loose });
  if (problems.length) {
    problems.forEach((problem) => console.log(`${scenario.name}: ${problem}`));
    return { name: scenario.name, code: 1, reason: problems[0] };
  }
  const out = path.resolve(options.out ?? "tmp/braille/runs", scenario.name);
  fs.mkdirSync(out, { recursive: true });
  const replayFile = options.replayApi && path.join(options.replayApi, `${scenario.name}.json`);
  const replayDoc = replayFile && fs.existsSync(replayFile) ? JSON.parse(fs.readFileSync(replayFile, "utf8")) : null;
  if (options.replayApi && !replayDoc) return { name: scenario.name, code: 1, reason: `no recording ${replayFile}` };
  const values = { ...(options.values ? JSON.parse(fs.readFileSync(options.values, "utf8")) : {}), ...(replayDoc?.values ?? {}) };
  const stepsFile = path.join(out, "steps.json");
  fs.writeFileSync(stepsFile, JSON.stringify(fillValues(scenario.steps, values)));
  const args = [EXECUTOR, "--out", out, "--steps", stepsFile, ...executorFlags(options), ...(scenario.onboarding ? ["--onboarding"] : [])];
  if (replayFile) args.push("--replay-api", replayFile);
  if (options.recordApi) {
    fs.mkdirSync(options.recordApi, { recursive: true });
    args.push("--record-api", path.join(options.recordApi, `${scenario.name}.json`), "--api-meta", JSON.stringify({ scenario: scenario.name, source: "local", values }));
  }
  const started = Date.now();
  const result = spawnSync(process.execPath, args, { env: { ...process.env, BASE: options.base }, encoding: "utf8" });
  const failure = result.stdout.split("\n").find((line) => line.includes("FAILED"));
  return { name: scenario.name, code: result.status ?? 1, seconds: (Date.now() - started) / 1000, reason: failure ?? (result.status ? result.stderr.trim().split("\n")[0] : null), out };
}

function run(options) {
  let bad = 0;
  for (const file of options.rest) {
    const result = runOne(file, options);
    console.log(`${result.code ? "RED  " : "green"} ${result.name}${result.seconds ? ` ${result.seconds.toFixed(1)}s` : ""}${result.reason ? ` :: ${result.reason.slice(0, 300)}` : ""}${result.code && result.out ? ` :: ${path.join(result.out, "report.json")}` : ""}`);
    if (result.code) bad += 1;
  }
  console.log(`${options.rest.length - bad} of ${options.rest.length} green`);
  return bad ? 1 : 0;
}

// ---------- step session ----------

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

function sessionProblem(session) {
  const state = readJson(path.join(session, "state.json"));
  if (!state) return `no session at ${session}: run braille start first`;
  if (state.state === "closed" || state.state === "failed") return `session ${state.state}${state.reason ? `: ${state.reason}` : ""}`;
  const beat = Number(readJson(path.join(session, "heartbeat")));
  if (!beat || Date.now() - beat > STALE_HEARTBEAT_S * 1000) return `the executor stopped responding; log: ${path.join(session, "executor.log")}`;
  return null;
}

async function ask(body, timeoutS) {
  if (!fs.existsSync(SESSION_FILE)) return { ok: false, error: "no session: run braille start first" };
  const session = fs.readFileSync(SESSION_FILE, "utf8").trim();
  const problem = sessionProblem(session);
  if (problem) return { ok: false, error: problem };
  const id = String(Date.now()) + String(Math.floor(Math.random() * 1000));
  const file = path.join(session, "request.json");
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...body, id }));
  fs.renameSync(`${file}.tmp`, file);
  const answer = path.join(session, `reply-${id}.json`);
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    if (fs.existsSync(answer)) return JSON.parse(fs.readFileSync(answer, "utf8"));
    const stopped = sessionProblem(session);
    if (stopped) return { ok: false, error: stopped };
    await sleep(POLL_MS);
  }
  return { ok: false, error: `no answer in ${timeoutS}s; log: ${path.join(session, "executor.log")}` };
}

async function start(options) {
  const session = path.join(SESSION_ROOT, `session-${Date.now()}`);
  fs.mkdirSync(session, { recursive: true });
  const log = fs.openSync(path.join(session, "executor.log"), "w");
  const args = [EXECUTOR, "--session", session, "--out", path.join(session, "out"), ...executorFlags(options), ...(options.values ? ["--values", options.values] : [])];
  spawn(process.execPath, args, { detached: true, stdio: ["ignore", log, log], env: { ...process.env, BASE: options.base } }).unref();
  fs.writeFileSync(SESSION_FILE, session);
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = readJson(path.join(session, "state.json"));
    if (state?.state === "ready") return { ok: true, session, next: 'first step: {"goto": "/…"}' };
    if (state?.state === "failed") break;
    await sleep(POLL_MS);
  }
  return { ok: false, error: "the session did not start", log: fs.readFileSync(path.join(session, "executor.log"), "utf8").slice(-1500) };
}

function selftest() {
  const good = { name: "a", why: "b", verifies: ["c"], steps: [{ goto: "/", after: { state: "ready" } }, { wait: "x" }] };
  const cases = [
    ["clean scenario", scenarioProblems(good, "a.json"), null],
    ["action without after", scenarioProblems({ ...good, steps: [{ goto: "/" }, { wait: "x" }] }, "a.json"), "needs after"],
    ["fixed pause", scenarioProblems({ ...good, steps: [{ goto: "/", after: { state: "ready" } }, { wait: 2000 }] }, "a.json"), "fixed pause"],
    ["click by label", scenarioProblems({ ...good, steps: [{ click: "Save", after: { state: "ready" } }, { wait: "x" }] }, "a.json"), "click by label"],
    ["no expectation", scenarioProblems({ ...good, steps: [{ goto: "/", after: { state: "ready" } }] }, "a.json"), "checks nothing"],
    ["unknown step", scenarioProblems({ ...good, steps: [{ tap: 1 }, { wait: "x" }] }, "a.json"), "step 1"],
    ["missing field", scenarioProblems({ ...good, why: undefined }, "a.json"), "missing field why"],
    ["wrong file name", scenarioProblems(good, "b.json"), "file name"],
    ["no requirement", scenarioProblems({ ...good, verifies: [] }, "a.json"), "no requirement"],
  ];
  let bad = 0;
  for (const [title, problems, wanted] of cases) {
    const passed = wanted === null ? problems.length === 0 : problems.some((problem) => problem.includes(wanted));
    if (!passed) { console.log(`FAIL ${title}: ${JSON.stringify(problems)}`); bad += 1; }
  }
  console.log(`braille selftest: ${cases.length - bad} of ${cases.length}`);
  return bad ? 1 : spawnSync(process.execPath, [EXECUTOR, "--selftest"], { stdio: ["ignore", "ignore", "inherit"] }).status;
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const options = parseOptions(argv);
  if (command === "selftest") return selftest();
  if (command === "install" && options.rest[0]) {
    const problems = syncRuntime(options.rest[0], { install: true });
    problems.forEach((problem) => console.log(problem));
    if (!problems.length) console.log("runtime installed");
    return problems.length ? 1 : 0;
  }
  if (command === "check-runtime" && options.rest[0]) {
    const problems = syncRuntime(options.rest[0]);
    problems.forEach((problem) => console.log(problem));
    return problems.length ? 1 : 0;
  }
  if (command === "check-build" && options.rest[1]) {
    const problems = checkBuild(options.rest[0], options.rest[1]);
    problems.forEach((problem) => console.log(problem));
    if (!problems.length) console.log(`build ${options.rest[1]}: ok`);
    return problems.length ? 1 : 0;
  }
  if (command === "check" && options.rest[0]) return check(options.rest[0]);
  if (command === "step" || command === "look" || command === "close") {
    let answer;
    if (command === "step") {
      let step = null;
      try { step = JSON.parse(options.rest[0] ?? ""); } catch (error) { answer = { ok: false, error: `a step is a JSON object: ${error.message}` }; }
      if (step) answer = await ask({ step }, Math.max(STEP_DEFAULT_S, (step.after?.within ?? step.within ?? 0) + STEP_SLACK_S));
    } else answer = await ask({ [command]: true }, 60);
    console.log(JSON.stringify(answer, null, 1));
    return answer.ok ? 0 : 1;
  }
  if ((command === "run" || command === "start") && options.base) {
    if (command === "run") return run(options);
    const answer = await start(options);
    console.log(JSON.stringify(answer, null, 1));
    return answer.ok ? 0 : 1;
  }
  console.error("usage: see the head of bin/braille.mjs");
  return 2;
}

process.exit(await main());
