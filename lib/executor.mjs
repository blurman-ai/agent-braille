#!/usr/bin/env node
/**
 * agent-braille executor: runs steps in a browser through window.__agent.
 * Normally called by bin/braille.mjs; the step catalogue and rules are in docs/SCENARIOS.md.
 *
 *   node lib/executor.mjs --out DIR --steps steps.json    run steps; BASE is the site, localhost by default
 *        [--storage-state FILE] [--record-api FILE --api-meta JSON | --replay-api FILE] [--onboarding]
 *   node lib/executor.mjs --session DIR --out DIR         one step at a time through files in DIR
 *   node lib/executor.mjs --selftest                      control cases, no network
 *
 * Exit: 0 green, 1 a step failed, 2 bad call, 4 steps malformed, 5 recording malformed.
 */
import fs from "node:fs";
import path from "node:path";

import { API_DRAIN_MS, ApiReplay, apiDocument, apiPath, apiRequestKey, checkApiRecords, foldOverlapping, missLine, parseApiRecords, pendingLine, recordedCall, serverFailureLine, visitsOf } from "./api-records.mjs";
import { agentPresent, agentScreen, chromeOption, failureShot, givenCredential, perform, rootlessLine, screenMark, session } from "./browser.mjs";
import { apiCallsLine, apiFailuresLine, buildEvidence, collectEvidence, timeoutReason } from "./evidence.mjs";
import { selftest } from "./selftest.mjs";
import { interactive } from "./session.mjs";
import { WS, checkBase, legacyProblem, parseStep, targetLabel } from "./steps.mjs";
import { shared } from "./browser.mjs";

function fail(message) {
  console.error(message);
  process.exit(2);
}

/** Exit code "steps cannot be parsed": the scenario is to blame, not the environment. */
export const STEPS_MALFORMED_CODE = 4;

/** Exit code "the API records file cannot be parsed": the file is to blame, not the environment or the screen. */
export const API_RECORDS_BAD_CODE = 5;

/** `--parse-steps file`: the file is an object {name: steps}; prints {name: error} for those whose steps cannot be parsed.
 * No browser needed: this is how the scenario form check reads the step rules from here, not from a copy. */
function parseOnly(file) {
  const given = JSON.parse(fs.readFileSync(file, "utf8"));
  const errors = {};
  for (const [name, raw] of Object.entries(given)) {
    try {
      if (!Array.isArray(raw)) throw new Error("steps are not an array");
      raw.forEach(parseStep);
    } catch (error) {
      errors[name] = error.message;
    }
  }
  console.log(JSON.stringify(errors));
}

function slug(step) {
  const label = step.kind === "repeat"
    ? `until ${step.until}`
    : Array.isArray(step.target)
    ? step.target.join(" ")
    : typeof step.target === "object"
      ? targetLabel(step.target)
      : String(step.target);
  const tail = label
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `${step.kind}-${tail || "x"}`;
}

function parseArgs(argv) {
  const args = { out: null, steps: null, routes: [], mode: "run", legacy: null, recordApi: null, replayApi: null, apiMeta: null, apiName: null, session: null, values: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--selftest") args.mode = "selftest";
    else if (arg === "--storage-state") args.storageState = argv[(i += 1)];
    else if (arg === "--evidence-sample") args.mode = "evidence-sample";
    else if (arg === "--parse-steps") {
      args.mode = "parse";
      args.steps = argv[(i += 1)];
    }
    else if (arg === "--out") args.out = argv[(i += 1)];
    else if (arg === "--steps") args.steps = argv[(i += 1)];
    else if (arg === "--legacy") args.legacy = argv[(i += 1)] ?? "";
    else if (arg === "--record-api") args.recordApi = argv[(i += 1)];
    else if (arg === "--replay-api") args.replayApi = argv[(i += 1)];
    else if (arg === "--api-meta") args.apiMeta = argv[(i += 1)];
    else if (arg === "--session") args.session = argv[(i += 1)];
    else if (arg === "--values") args.values = argv[(i += 1)];
    else if (arg === "--onboarding") args.onboarding = true;
    else if (arg === "--check-api-records") {
      args.mode = "check-api";
      args.steps = argv[(i += 1)];
    }
    else if (arg.startsWith("--")) fail(`unknown key ${arg}`);
    else args.routes.push(arg);
  }
  return args;
}

async function run(args) {
  let base;
  let steps;
  try {
    base = checkBase(process.env.BASE ?? "http://localhost:5173");
  } catch (error) {
    fail(error.message);
  }
  try {
    const raw = args.steps ? JSON.parse(fs.readFileSync(args.steps, "utf8")) : [];
    if (!Array.isArray(raw)) throw new Error("the steps file is not an array");
    steps = [...args.routes.map((route) => ({ goto: route })), ...raw].map(parseStep);
  } catch (error) {
    console.error(error.message);
    process.exit(STEPS_MALFORMED_CODE);
  }
  if (!steps.length && !args.session) fail("neither routes nor --steps");
  if (!args.out) fail("--out <directory> is required for snapshots");
  if (args.recordApi && args.replayApi) fail("--record-api and --replay-api together: recording goes from a live backend, replay goes without one");
  let replay = null;
  let meta = null;
  // The browser time is the same for recording and replay: requests in which the page counts a period from "now" give the same key.
  let clock = null;
  if (args.replayApi) {
    try {
      const doc = parseApiRecords(fs.readFileSync(args.replayApi, "utf8"), path.basename(args.replayApi).replace(/\.json$/, ""));
      replay = new ApiReplay(doc);
      session.replay = replay;
      clock = doc.clock ?? null;
    } catch (error) {
      console.error(error.message);
      process.exit(API_RECORDS_BAD_CODE);
    }
  }
  if (args.recordApi) {
    try {
      meta = JSON.parse(args.apiMeta ?? "null");
      if (!meta || typeof meta.scenario !== "string") throw new Error("no scenario");
    } catch (error) {
      fail(`--record-api requires --api-meta '{"scenario", "source", "backend_commit", "frontend_commit"}': ${error.message}`);
    }
    clock = new Date().toISOString();
    meta.clock = clock;
  }

  let credential;
  let secret;
  try {
    ({ credential, secret } = givenCredential(process.env) ?? {});
  } catch (error) {
    fail(error.message);
  }
  if (!credential) {
    credential = "none";
    secret = "";
  }

  let chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    fail("playwright-core is not installed: run npm install");
  }
  fs.mkdirSync(args.out, { recursive: true });

  let browser;
  try {
    browser = await chromium.launch({ ...chromeOption(process.env), args: ["--no-sandbox"] });
  } catch (error) {
    fail(`the browser did not start: run npx playwright-core install chromium, or set BRAILLE_CHROME. ${String(error.message).split("\n")[0]}`);
  }
  // The application's service worker answers requests bypassing `page.route` and response interception: during recording and replay it is closed.
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...(args.storageState ? { storageState: args.storageState } : {}), ...(args.recordApi || args.replayApi ? { serviceWorkers: "block" } : {}) });
  if (clock) await context.clock.setFixedTime(clock);
  if (credential === "bearer") {
    // The storage key is the application's auth token key.
    await context.addInitScript(({ key, token }) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, token);
    }, { key: process.env.BRAILLE_TOKEN_KEY ?? "auth_token", token: secret });
  } else if (credential === "cookie") {
    const [name, ...rest] = secret.split("=");
    await context.addCookies([{ name, value: rest.join("="), url: base }]);
  }
  // An introductory overlay pops up by its own rules and covers steps; a scenario for the overlay itself asks for it with the --onboarding key.
  // The key and the name match `AGENT_OFF_KEY` in the runtime switches module (runtime/switches.ts).
  if (!args.onboarding) await context.addInitScript(() => localStorage.setItem("agent.off", "onboarding"));
  let page = await context.newPage();
  session.context = context;
  session.pages = [page];
  session.current = 0;
  context.on("request", (request) => session.requests.push({ method: request.method(), path: new URL(request.url()).pathname }));
  // Pages opened by navigating to an address (visits); navigations inside the SPA are visible by the address after a step.
  context.on("request", (request) => {
    if (request.isNavigationRequest() && request.url().startsWith(base)) session.navigations.push(new URL(request.url()).pathname);
  });
  const cutSlots = [];   // how many responses were recorded by the time of each cut
  // The cut step: the request reaches the server, the response to it is lost. One request per step, then the network is as it was.
  await context.route(
    (url) => session.cuts.some((cut) => !cut.used && url.pathname.endsWith(cut.suffix)),
    async (route) => {
      const cut = session.cuts.find((c) => !c.used && new URL(route.request().url()).pathname.endsWith(c.suffix));
      if (!cut) return route.fallback().catch(() => {});
      cut.used = true;
      await route.fetch().catch(() => {});
      cutSlots.push(recorded.length);
      await route.abort("connectionreset").catch(() => {});
    },
  );

  if (replay) {
    // Replay does not touch the network at all: foreign hosts (counters, fonts) are closed, the API is answered by the file, static files come from BASE.
    await context.route((url) => url.origin !== base && url.protocol.startsWith("http"), (route) => route.abort("blockedbyclient").catch(() => {}));
    await context.route((url) => url.origin === base && apiPath(url.pathname) !== null, async (route) => {
      const request = route.request();
      // The cut step during replay: the page does not get a response, and during recording the request is torn without a lookup in the file.
      // That the server accepted it, the page learns from the following requests (the response status), and those are recorded.
      const cut = session.cuts.find((c) => !c.used && new URL(request.url()).pathname.endsWith(c.suffix));
      if (cut) {
        cut.used = true;
        replay.cut();
        await route.abort("connectionreset").catch(() => {});
        return;
      }
      const answer = replay.answer(request.method(), request.url(), request.postData(), request.headers()["content-type"] ?? "");
      if (!answer) {
        await route.abort("failed").catch(() => {});
        return;
      }
      await route.fulfill({ status: answer.status, ...(answer.contentType ? { contentType: answer.contentType } : {}), body: answer.body }).catch(() => {});
    });
  }
  // Recording: responses are read as they arrive, the place in the file is taken in the order the responses arrive.
  const recorded = [];
  const recordedBursts = [];      // the overlap batch of each record - for `foldOverlapping`
  const reading = [];
  const unanswered = new Set();   // API requests that started and got neither a response nor a failure
  if (meta) {
    const isApi = (request) => apiPath(new URL(request.url()).pathname) !== null;
    const keyOf = (request) => apiRequestKey(request.method(), request.url(), request.postData(), request.headers()["content-type"] ?? "");
    const inFlight = new Map();   // key -> how many such requests await a response
    const burstOf = new Map();    // key -> current batch; request -> its batch
    let bursts = 0;
    const sentOrder = new Map();  // request -> send number
    let sent = 0;
    const settle = (request) => {
      if (!unanswered.delete(request)) return;
      const key = keyOf(request);
      inFlight.set(key, (inFlight.get(key) ?? 1) - 1);
    };
    page.on("request", (request) => {
      if (!isApi(request)) return;
      unanswered.add(request);
      const key = keyOf(request);
      const waiting = inFlight.get(key) ?? 0;
      if (!waiting) burstOf.set(key, (bursts += 1));
      burstOf.set(request, burstOf.get(key));
      sentOrder.set(request, (sent += 1));
      inFlight.set(key, waiting + 1);
    });
    page.on("requestfailed", settle);
    page.on("response", (response) => {
      const request = response.request();
      settle(request);
      if (!isApi(request)) return;
      const slot = recorded.push(null) - 1;
      recordedBursts[slot] = { burst: burstOf.get(request), sent: sentOrder.get(request) };
      const requestType = request.headers()["content-type"] ?? "";
      const postData = request.postData();
      reading.push(
        response.text().catch(() => "").then((text) => {
          recorded[slot] = recordedCall(request.method(), request.url(), postData, requestType, response.status(), response.headers()["content-type"] ?? "", text);
        }),
      );
    });
  }

  let noise = [];
  let stepCalls = [];
  // Step evidence: everything the page said during the step window (reset at the start of the step).
  let trail = { console: [], pageerrors: [], requests: [], api: [] };
  let stepStartedAt = Date.now();
  const sinceStep = () => Date.now() - stepStartedAt;
  // The same subscriptions - on every tab (the tab step).
  session.watch = (tab) => {
    tab.on("response", (response) => {
      if (apiPath(new URL(response.url()).pathname) !== null) {
        trail.api.push({ method: response.request().method(), path: new URL(response.url()).pathname, status: response.status(), ms: sinceStep() });
      }
      if (response.status() >= 400 && response.url().startsWith(base)) {
        trail.requests.push({ method: response.request().method(), path: new URL(response.url()).pathname, status: response.status(), ms: sinceStep() });
      }
    });
    tab.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") trail.console.push(`${message.type()} ${message.text()}`);
    });
    tab.on("pageerror", (error) => trail.pageerrors.push(String(error.stack ?? error.message ?? error).split("\n").slice(0, 3).join(" | ")));
    tab.on("requestfailed", (request) => {
      const reason = request.failure()?.errorText ?? "";
      // Cancellation by the page itself is not evidence; foreign hosts (counters) are not either.
      if (reason !== "net::ERR_ABORTED" && request.url().startsWith(base)) {
        trail.requests.push({ method: request.method(), path: new URL(request.url()).pathname, status: reason || "failed", ms: sinceStep() });
      }
    });
    tab.on("response", (response) => {
      if (apiPath(new URL(response.url()).pathname) !== null) stepCalls.push(`${response.request().method()} ${new URL(response.url()).pathname} ${response.status()}`);
      // Responses from API endpoints.
      if (response.status() >= 400 && apiPath(new URL(response.url()).pathname) !== null) {
        const where = response.url().replace(/^https?:\/\/[^/]+/, "");
        noise.push(`${response.status()} ${response.request().method()} ${where}`);
      }
    });
    tab.on("console", (message) => {
      // "Failed to load resource" duplicates the line with the address from two neighbouring subscriptions.
      if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) {
        noise.push(`console ${message.text().slice(0, 200)}`);
      }
    });
    tab.on("requestfailed", (request) => {
      const reason = request.failure()?.errorText ?? "";
      // Only our own host: third-party counters are not evidence.
      if (reason !== "net::ERR_ABORTED" && request.url().startsWith(base)) {
        noise.push(`${reason} ${request.url().slice(0, 120)}`);
      }
    });
    tab.on("pageerror", (error) => noise.push(`pageerror ${error.message.slice(0, 200)}`));
  };
  session.watch(page);

  shared.legacyReason = args.legacy;
  if (shared.legacyReason !== null) {
    const problem = legacyProblem(shared.legacyReason);
    if (problem) fail(problem);
    console.log(`LEGACY MODE (snapshots and page text, without window.__agent): ${shared.legacyReason}`);
  }
  const report = [];
  let failed = false;
  const runStep = async (index, step) => {
    const name = `${String(index + 1).padStart(2, "0")}-${slug(step)}`;
    noise = [];
    stepCalls = [];
    trail = { console: [], pageerrors: [], requests: [], api: [] };
    shared.failTarget = null;
    shared.stepRootless = null;
    let error = null;
    const stepStarted = Date.now();
    stepStartedAt = stepStarted;
    try {
      await perform(page, base, step);
      if (index === 0 && process.env.BRAILLE_DISMISS_LABEL) {
        // A cookie banner covers the bottom of the screen: pressed once if the application has one.
        const accept = page.getByRole("button", { name: process.env.BRAILLE_DISMISS_LABEL, exact: true });
        if (await accept.count()) await accept.first().click().catch(() => {});
      }
    } catch (caught) {
      const lines = String(caught.message ?? caught).split("\n");
      // Who covered the element, Playwright writes in the attempt log, not in the first line.
      const blocker = lines.find((line) => line.includes("intercepts pointer events"));
      error = [lines[0], blocker?.trim()].filter(Boolean).join(" — ").slice(0, 400);
    }
    page = session.pages[session.current];
    // A request that is not in the records is turned red by the step itself, even if the screen survived it: during replay there is no network.
    const missing = replay ? missLine(replay.takeMisses()) : null;
    if (missing) error = (error ? `${missing} — ${error}` : missing).slice(0, 600);
    // Evidence is taken before the rest of the analysis: the page is still in the state in which the step failed.
    let evidence = null;
    if (error) {
      const shotFile = path.join(args.out, `${name}.page.png`);
      await page.screenshot({ path: shotFile }).catch(() => {});
      evidence = await collectEvidence(page, trail, path.relative(WS, shotFile), [secret, secret.split("=").slice(1).join("=")], step);
      error = timeoutReason(error, step, evidence);
    }
    const present = await agentPresent(page);
    if (present) {
      // The agent object is present: a snapshot and a screen description - only on failure.
      if (error) {
        // A screen may swallow an API failure (502 replay_miss in request parsing):
        // the step reason - together with the failed requests from errors().
        const failures = apiFailuresLine(
          await page.evaluate(() => window.__agent.errors()).catch(() => []),
        );
        if (failures) error = `${error} — ${failures}`.slice(0, 600);
        await failureShot(page, path.join(args.out, `${name}.png`));
        fs.writeFileSync(
          path.join(args.out, `${name}.json`),
          JSON.stringify(await agentScreen(page), null, 2),
        );
      }
    } else {
      await page.screenshot({ path: path.join(args.out, `${name}.png`), fullPage: true });
      fs.writeFileSync(
        path.join(args.out, `${name}.txt`),
        await page.locator("body").innerText().catch(() => ""),
      );
    }
    const here = new URL(page.url());
    const entry = { step: name, path: here.pathname + here.search, error, ...(evidence ? { evidence } : {}), calls: stepCalls, noise, ms: Date.now() - stepStarted, ...(shared.stepRootless ? { rootless: shared.stepRootless } : {}), ...screenMark(present, present ? await agentScreen(page) : null) };
    console.log(
      [
        name,
        entry.path,
        error ? `FAILED: ${error}` : `ok ${(entry.ms / 1000).toFixed(1)} s`,
        [...noise, `API in this step: ${apiCallsLine(stepCalls)}`].join(" ; "),
        ...(shared.stepRootless ? [rootlessLine(shared.stepRootless)] : []),
      ].join(" | "),
    );
    return entry;
  };
  if (args.session) {
    await interactive(args, runStep, report, () => session.pages[session.current]);
  } else {
    for (const [index, step] of steps.entries()) {
      const entry = await runStep(index, step);
      report.push(entry);
      if (entry.error) {
        failed = true;
        break;
      }
    }
  }
  fs.writeFileSync(path.join(args.out, "report.json"), JSON.stringify(report, null, 2));
  // What the run opened: API requests and page addresses. Used for impact analysis.
  fs.writeFileSync(path.join(args.out, "visits.json"), JSON.stringify(visitsOf(session.requests, session.navigations, report), null, 2));
  const late = replay ? missLine(replay.takeMisses()) : null;
  if (late) {
    console.log(`after the last step | FAILED: ${late}`);
    failed = true;
  }
  // Recording did not go (a red run, a 5xx failure in the responses) - a draft outside git: the responses the page received,
  // to which the missing ones are added by hand (the manual-edits field). This is how a file is assembled when the environment does not give the needed response:
  // the follow-up question is asked by the model, request parsing failed on the model record, and the scenario checks the screen.
  const writeDraft = () => {
    const draft = path.join(WS, "tmp", "screen-api-partial", path.basename(args.recordApi));
    try {
      const calls = foldOverlapping(recorded, recordedBursts).filter(Boolean);
      const cuts = cutSlots.map((n) => recorded.slice(0, n).filter(Boolean).length);
      const doc = apiDocument({ ...meta, source: meta.source, cuts }, calls, [secret]);
      fs.mkdirSync(path.dirname(draft), { recursive: true });
      fs.writeFileSync(draft, JSON.stringify(doc, null, 2) + "\n");
      console.log(`API records draft: ${doc.calls.length} requests -> ${path.relative(WS, draft)}`);
    } catch (error) {
      console.log(`no API records draft: ${error.message}`);
    }
  };
  if (meta && !failed) {
    // After the last step the page is still loading data: we write when the network has gone quiet, not at the moment the steps end.
    await page.waitForLoadState("networkidle", { timeout: API_DRAIN_MS }).catch(() => {});
    let drained = false;
    await Promise.race([Promise.allSettled(reading).then(() => { drained = true; }), new Promise((resolve) => setTimeout(resolve, API_DRAIN_MS))]);
    try {
      if (!drained || recorded.includes(null)) throw new Error(`not all response bodies were read to the end within ${API_DRAIN_MS / 1000} s (a stream, not a whole response): the file would be incomplete`);
      const pending = pendingLine([...unanswered].map((request) => `${request.method()} ${new URL(request.url()).pathname}`));
      if (pending) throw new Error(pending);
      const calls = foldOverlapping(recorded, recordedBursts).filter(Boolean);
      const broken = serverFailureLine(calls);
      if (broken) throw new Error(broken);
      const cuts = cutSlots.map((n) => recorded.slice(0, n).filter(Boolean).length);
      const doc = apiDocument({ ...meta, source: meta.source, cuts }, calls, [secret]);
      fs.mkdirSync(path.dirname(path.resolve(args.recordApi)), { recursive: true });
      fs.writeFileSync(args.recordApi, JSON.stringify(doc, null, 2) + "\n");
      console.log(`API records: ${doc.calls.length} requests -> ${args.recordApi}`);
    } catch (error) {
      console.log(`API records not written: ${error.message}`);
      writeDraft();
      failed = true;
    }
  } else if (meta) {
    console.log("API records are not written: the run is red");
    writeDraft();
  }
  await browser.close();
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
const args = parseArgs(process.argv.slice(2));
if (args.mode === "selftest") selftest();
else if (args.mode === "parse") parseOnly(args.steps);
else if (args.mode === "evidence-sample") {
  // A sample of failure evidence with a planted secret: used to check masking.
  console.log(JSON.stringify(buildEvidence({
    url: "https://app.example.com/app/page?auth_token=SAMPLE-SECRET-TOKEN-0001", title: "Sample", text: "Visible text. token: SAMPLE-SECRET-TOKEN-0001",
    console: ["error failure Bearer SAMPLE-SECRET-TOKEN-0001"], pageerrors: [], requests: [{ method: "GET", path: "/api/me", status: 502, ms: 40 }],
    screenshot: "tmp/runs/sample/01-goto.page.png", load: { readyState: "complete", root: "div#root, descendants 0", agent: false, scripts: 2, chunkErrors: [] },
  }, ["SAMPLE-SECRET-TOKEN-0001"])));
}
else if (args.mode === "check-api") checkApiRecords(args.steps);
else await run(args);
}
