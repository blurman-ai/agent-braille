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

const WS = process.cwd();
const HERE = path.dirname(new URL(import.meta.url).pathname);

/** Hosts the executor may visit. Never add production here. */
const ALLOWED_HOSTS = ["localhost", "127.0.0.1", ...(process.env.BRAILLE_ALLOWED_HOSTS ?? "").split(",").filter(Boolean)];

/** The single declaration of step kinds: parsing, execution and the selftest all read it. */
const REPLAY_WITHIN_S = 30;
const STEP_KINDS = ["goto", "click", "fill", "press", "upload", "wait", "order", "absent", "active", "disabled", "field", "checked", "unchecked", "focused", "hover", "enabled", "filled", "visible", "hidden", "described", "download", "repeat", "hold", "same-href", "cut", "advance", "tab", "visibility", "requested", "fact"];

/**
 * The target `{"testid": …}`: an element by data-testid, no label needed. `name` is a label check,
 * only when the scenario requirement names it (`braille check` does not verify the text); `item` picks one of identical elements (an answer
 * option, a row): data, not an interface label.
 */
export const TESTID_KINDS = ["click", "hover", "fill", "enabled", "disabled", "checked", "unchecked", "focused", "download", "wait", "absent", "filled", "field"];
const RE_TESTID = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/;

/**
 * `after` - what observably changes after an action: the screen and its `data-state`, testids that appeared or disappeared.
 * The executor waits for it and fails this step, not the next wait. Required for actions (`braille check` verifies it).
 */
export const AFTER_KINDS = ["goto", "click", "fill", "press", "upload"];
const AFTER_KEYS = ["screen", "state", "shown", "gone", "within"];
const AFTER_TIMEOUT_S = 20;

/** Where the upload step takes files from and which field it puts them into when no field is named. */
const UPLOAD_DIR = path.resolve(WS, process.env.BRAILLE_FILES_DIR ?? "scenarios/files");
const UPLOAD_DEFAULT = "input[type=file]";

/** Expectations about the visibility of an element by selector. */
const SEEN_KINDS = ["visible", "hidden"];

/**
 * The hold step: how many milliseconds a request may be delayed.
 * A file on a form is uploaded when the submit button is pressed, and the server processes the document in the same
 * request within fractions of a second, so the "processing" state cannot be held. The request is not
 * replaced but delayed: the screen is checked, the response is real.
 */
const HOLD_MIN_MS = 500;
const HOLD_MAX_MS = 30000;

/** The second tab and hiding the tab: values of the tab and visibility steps. */
const TAB_ACTIONS = ["open", "first", "second"];
const VISIBILITY_VALUES = ["hidden", "visible"];
/** The requested step: how many requests can be named and with which method. */
const REQUESTED_TIMES_MAX = 50;
const REQUEST_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** How many times repeat steps repeat by default before the step refuses. */
const REPEAT_MAX = 40;

/** Expectations about a checkbox: kind name -> what is expected of it. */
const TICK_KINDS = ["checked", "unchecked", "focused"];

/** How long to wait for an optional element before skipping the step. */
const OPTIONAL_TIMEOUT_MS = 3000;
// In agent mode a disabled click target waits this long, not Playwright's 15 s:
// the button is enabled by a response that has already arrived, not by a future one.
const DISABLED_GRACE_MS = 5000;
// A notification can cover buttons for the first seconds after login and go away by itself.
const OCCLUSION_GRACE_MS = 6000;

/** How long to wait for the page to finish rendering what is expected: a heavy screen renders for several seconds. */
const EXPECT_TIMEOUT_MS = 20000;

// ── API response records ──────────────────────────────────────────────────────
// `--record-api file` saves "request -> response" pairs for `/api/*` during a run; `--replay-api file`
// answers them from the file without a network to the backend. The file (sample - testdata/api-sample.json):
//   {"scenario", "source", "recorded_at", "calls": [
//     {"method", "path", "query", "body", "status", "content_type", "response"}, …]}
// The format, the matching key and the file check are declared exactly here; other tools call
// `--check-api-records` instead of copying it.

// Design: (1) all API roots map to one key, so that a recording answers
// in a frontend build with any root; (2) repeats of one key are answered in recording order - polling a state
// ("running" -> "done") could not be reproduced otherwise; (3) during replay foreign hosts are closed, and the service worker is
// disabled for recording and replay - otherwise "no network" would be a word, not a property; (4) the hold step passes the request on via `fallback`, not `continue`.
/** API roots, comma-separated in `BRAILLE_API_ROOTS`, `/api` by default. The first one goes into the key. */
export const API_ROOTS = (process.env.BRAILLE_API_ROOTS ?? "/api").split(",").filter(Boolean);
export const API_FILE_FIELDS = ["scenario", "source", "recorded_at", "calls"];
export const API_CALL_FIELDS = ["method", "path", "query", "body", "status", "content_type", "response"];
/** Where records come from. Only `local` goes into git: data from shared environments may carry user data. */
export const API_SOURCES = ["local", "dev"];
export const API_GIT_SOURCE = "local";
/** A request body with a file upload: multipart boundaries are random, so the key holds a single mark for the whole body. */
export const API_MULTIPART_BODY = "<multipart/form-data>";
/** How long, when a run finishes, to wait for the bodies of responses not yet read to the end. */
const API_DRAIN_MS = 10000;
/** A sample records file: used by the selftest. */
const API_SAMPLE = path.join(HERE, "testdata", "api-sample.json");

/** What the scenario opened: unique API requests (method, path) and page addresses (navigations and the address after each step). */
export function visitsOf(requests, navigations, report) {
  const api = new Map();
  for (const r of requests) {
    const p = apiPath(r.path);
    if (p !== null) api.set(`${r.method} ${r.path}`, { method: r.method, path: r.path });
  }
  const pages = new Set(navigations);
  for (const entry of report) if (entry.path) pages.add(entry.path.split("?")[0]);
  return { api: [...api.values()], pages: [...pages].sort() };
}

/** A path without the host, reduced to the first API root; null means this is not an API request. */
export function apiPath(pathname) {
  for (const root of API_ROOTS) {
    if (pathname === root || pathname.startsWith(`${root}/`)) return API_ROOTS[0] + pathname.slice(root.length);
  }
  return null;
}

/** The query string: pairs ordered by name, then by value. */
/** Field names whose values never reach a recording: applied to query, request body and response alike. */
const SECRET_FIELD = /pass(word|wd)?|secret|token|authorization|cookie|api[-_]?key/i;
export const SECRET_MARK = "***";

function maskedFields(value) {
  if (Array.isArray(value)) return value.map(maskedFields);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_FIELD.test(key) ? SECRET_MARK : maskedFields(item)]));
  }
  return value;
}

export function normalizeQuery(search) {
  const pairs = [...new URLSearchParams(search)].map(([name, value]) => [name, SECRET_FIELD.test(name) ? SECRET_MARK : value]);
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return new URLSearchParams(pairs).toString();
}

function sortedKeys(value) {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedKeys(value[key])]));
  return value;
}

/** A UUID in a string value of the body. The browser generates them itself on every run (the step response `client_event_id`),
 * and a key containing them would never match during replay. */
const RE_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
export const API_UUID_MARK = "<uuid>";

function maskedUuids(value) {
  if (typeof value === "string") return value.replace(RE_UUID, API_UUID_MARK);
  if (Array.isArray(value)) return value.map(maskedUuids);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskedUuids(v)]));
  return value;
}

/** The request body: JSON with sorted keys, no spaces and UUIDs under a mark, multipart as a single mark,
 * anything else as is. Requests that differ only in UUID go into one queue and are answered in recording order. */
export function normalizeBody(text, contentType = "") {
  if (text === null || text === undefined || text === "") return "";
  if (String(contentType).startsWith("multipart/")) return API_MULTIPART_BODY;
  try {
    return JSON.stringify(sortedKeys(maskedFields(maskedUuids(JSON.parse(text)))));
  } catch {
    return text;
  }
}

/** The only place where a request becomes a key: method, path without host, query string, body. */
export function apiRequestKey(method, rawUrl, postData, contentType = "") {
  const url = new URL(rawUrl, "http://localhost");
  const pathname = apiPath(url.pathname);
  if (pathname === null) return null;
  return JSON.stringify([method.toUpperCase(), pathname, normalizeQuery(url.search), normalizeBody(postData, contentType)]);
}

// The record body goes through the same normalization as the request during replay: records taken before the UUID mark stay valid.
const callKey = (call) => JSON.stringify([call.method, call.path, call.query, normalizeBody(call.body, "application/json")]);

/** What is wrong with the records document; throws an `Error` with the first reason. `gitSource` - the file goes into git (local source only). */
export function checkApiDocument(doc, name, { gitSource = false } = {}) {
  const bad = (what) => { throw new Error(`API records "${name}": ${what}`); };
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) bad("the file is not an object");
  const absent = API_FILE_FIELDS.filter((field) => !(field in doc));
  if (absent.length) bad(`missing fields: ${absent.join(", ")}`);
  if (doc.scenario !== name) bad(`scenario "${doc.scenario}" does not match the file name`);
  if (!API_SOURCES.includes(doc.source)) bad(`source "${doc.source}": allowed are ${API_SOURCES.join(", ")}`);
  if (gitSource && doc.source !== API_GIT_SOURCE) {
    bad(`source "${doc.source}", but only records from ${API_GIT_SOURCE} go into git: responses from shared environments may carry user data`);
  }
  if (typeof doc.recorded_at !== "string" || Number.isNaN(Date.parse(doc.recorded_at))) bad("recorded_at is not a time");
  if ("values" in doc && (doc.values === null || typeof doc.values !== "object" || Array.isArray(doc.values) || Object.values(doc.values).some((v) => !["string", "number", "boolean"].includes(typeof v)))) {
    bad("values is not an object \"substitution name -> string or number\"");
  }
  if (doc.clock != null && (typeof doc.clock !== "string" || Number.isNaN(Date.parse(doc.clock)))) bad("clock is not a time");
  // Responses added by hand, not taken from a live backend: every edit is a line "which request, what and why".
  if ("patches" in doc && !(Array.isArray(doc["patches"]) && doc["patches"].length && doc["patches"].every((line) => typeof line === "string" && line.trim()))) {
    bad("the manual-edits field must be a non-empty list of strings: which response was added by hand and why");
  }
  if (!Array.isArray(doc.calls) || !doc.calls.length) bad("there are no recorded requests");
  doc.calls.forEach((call, index) => {
    const where = `request ${index + 1}`;
    if (call === null || typeof call !== "object" || API_CALL_FIELDS.some((field) => !(field in call))) bad(`${where}: missing fields from ${API_CALL_FIELDS.join(", ")}`);
    if (typeof call.method !== "string" || call.method !== call.method.toUpperCase() || !call.method) bad(`${where}: method must be uppercase`);
    if (typeof call.path !== "string" || apiPath(call.path) !== call.path || !call.path.startsWith(`${API_ROOTS[0]}/`)) bad(`${where}: path must look like ${API_ROOTS[0]}/…, without a host`);
    if (typeof call.query !== "string" || call.query !== normalizeQuery(call.query)) bad(`${where}: query is not reduced to the key form`);
    if (typeof call.body !== "string") bad(`${where}: body is not a string`);
    if (!Number.isInteger(call.status) || call.status < 100 || call.status > 599) bad(`${where}: status must be a code from 100 to 599`);
    if (typeof call.content_type !== "string") bad(`${where}: content_type is not a string`);
  });
  return doc;
}

/** File text -> document; a damaged file is a refusal with a reason, not an empty set. */
export function parseApiRecords(text, name, options) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new Error(`API records "${name}": the file cannot be parsed (${error.message})`);
  }
  return checkApiDocument(doc, name, options);
}

/** A records document from caught requests. The login secret does not get into the file: found in the text - refusal. */
export function apiDocument(meta, calls, secrets = []) {
  const doc = { scenario: meta.scenario, source: meta.source, recorded_at: meta.recorded_at ?? new Date().toISOString().replace(/\.\d+Z$/, "Z"), values: meta.values ?? {}, clock: meta.clock ?? null, ...(meta.cuts?.length ? { cuts: meta.cuts } : {}), calls };
  checkApiDocument(doc, meta.scenario);
  const text = JSON.stringify(doc);
  for (const secret of secrets) {
    if (secret && secret.length >= 8 && text.includes(secret)) throw new Error(`API records "${meta.scenario}": the responses contain the login secret - the file is not written`);
  }
  return doc;
}

/** One caught "request -> response" pair as a record; null means this is not an API request. */
export function recordedCall(method, rawUrl, postData, requestType, status, responseType, responseText) {
  const key = apiRequestKey(method, rawUrl, postData, requestType);
  if (key === null) return null;
  const [m, path, query, body] = JSON.parse(key);
  let response = responseText;
  if (/json/.test(responseType)) {
    try { response = maskedFields(JSON.parse(responseText)); } catch { /* not JSON - stays as text */ }
  }
  return { method: m, path, query, body, status, content_type: responseType, response };
}

/** Replay: a request with a key from the file is answered with the record. The server state is the number of the last performed change
 * (non-GET records). A GET response depends on this state and on advance steps, not on the number of page requests:
 * the polling rhythm differs between replay and recording. Changes with one key go in recording order, the last one repeats. */
export class ApiReplay {
  constructor(doc) {
    this.queues = new Map();
    doc.calls.forEach((call, index) => {
      const key = callKey(call);
      if (!this.queues.has(key)) this.queues.set(key, { calls: [], at: [], advanced: new Set() });
      this.queues.get(key).calls.push(call);
      this.queues.get(key).at.push(index);
    });
    this.cuts = Array.isArray(doc.cuts) ? doc.cuts : [];
    this.cutsTaken = 0;
    this.misses = [];
    this.writes = doc.calls.flatMap((call, index) => (call.method.toUpperCase() === "GET" ? [] : [index]));
    this.stateAt = -1;
  }

  /** The number of the change after which record `index` was taken; -1 means before the first change. */
  stateOf(index) {
    return this.writes.filter((write) => write < index).at(-1) ?? -1;
  }

  /** The cut step during replay: the request "reached" the server, and the state becomes the one it was at the recording cut. */
  cut() {
    const mark = this.cuts[this.cutsTaken++];
    if (mark !== undefined) this.stateAt = Math.max(this.stateAt, mark - 1);
  }

  /** The advance step during replay: the server finished its work by itself (a build, file processing). Moves to the nearest state where GET
   * requests with `target` in the path change the response: in it they answer with the last one taken. It may still be ahead - the record leading
   * to it is on the way. Returns how many requests it moved: zero means the records have no such response change. */
  advance(target) {
    const reads = [...this.queues].filter(([key, queue]) => queue.calls[0].method.toUpperCase() === "GET" && JSON.parse(key)[1].includes(target)).map(([, queue]) => queue);
    const reached = this.stateOf(this.stateAt + 1);
    const waiting = (queue) => {
      const states = queue.at.map((index) => this.stateOf(index));
      return [...new Set(states)].filter((state) => state >= reached && !queue.advanced.has(state) && states.filter((other) => other === state).length > 1);
    };
    const next = Math.min(...reads.flatMap(waiting));
    const moved = reads.filter((queue) => waiting(queue).includes(next));
    for (const queue of moved) queue.advanced.add(next);
    return moved.length;
  }

  /** GET: of those taken in the current state the first, after an advance step the last; none - the last one taken earlier; not even that - the first one taken later. */
  pickRead(queue) {
    const end = this.writes.find((index) => index > this.stateAt) ?? Infinity;
    const now = queue.at.flatMap((index, i) => (index > this.stateAt && index < end ? [i] : []));
    if (now.length) return queue.calls[queue.advanced.has(this.stateOf(queue.at[now[0]])) ? now.at(-1) : now[0]];
    return queue.calls.filter((_, i) => queue.at[i] < this.stateAt).at(-1) ?? queue.calls[0];
  }

  /** `{status, contentType, body}` or null if the request is not in the file (it then goes into `misses`). */
  answer(method, rawUrl, postData, requestType = "") {
    const key = apiRequestKey(method, rawUrl, postData, requestType);
    const queue = key === null ? undefined : this.queues.get(key);
    if (!queue) {
      const url = new URL(rawUrl, "http://localhost");
      this.misses.push(`${method.toUpperCase()} ${url.pathname}${url.search}${postData ? ` body ${normalizeBody(postData, requestType).slice(0, 120)}` : ""}`);
      return null;
    }
    let call;
    if (method.toUpperCase() === "GET") {
      call = this.pickRead(queue);
    } else {
      const pick = queue.at.find((index) => index > this.stateAt) ?? queue.at.at(-1);
      call = queue.calls[queue.at.indexOf(pick)];
      this.stateAt = Math.max(this.stateAt, pick);
    }
    return { status: call.status, contentType: call.content_type, body: typeof call.response === "string" ? call.response : JSON.stringify(call.response) };
  }

  takeMisses() {
    const taken = this.misses;
    this.misses = [];
    return taken;
  }
}

/** Identical overlapping requests (the second left before the first was answered) form one batch: each of its records gets the response
 * of the request sent last. The page lives on it (the earlier one is an unmounted view, its response is dropped),
 * and during replay it is impossible to predict how many such requests will go and in which order: a confirm request went out
 * twice with different tokens, and a follow-up request went out with the wrong one during replay. The response that arrived last is not the right one:
 * once it came from the first request. Requests in turn (polling) are different batches, their responses go in recording order.
 * `marks[i]` is {burst, sent} of record i: the batch and the send number. */
export function foldOverlapping(calls, marks) {
  const last = new Map();
  calls.forEach((call, index) => {
    const mark = marks[index];
    if (!call || !mark) return;
    const held = last.get(mark.burst);
    if (!held || mark.sent > held.sent) last.set(mark.burst, { sent: mark.sent, call });
  });
  return calls.map((call, index) => {
    const final = call && marks[index] && last.get(marks[index].burst)?.call;
    return final && final !== call ? { ...call, status: final.status, content_type: final.content_type, response: final.response } : call;
  });
}

/** A record refusal line if the backend answered 5xx: the screen could have swallowed the failure (502 replay_miss in request parsing),
 * and replay would reproduce the failure as the norm. null means no failures. */
export function serverFailureLine(calls) {
  const failed = calls.filter((call) => call.status >= 500).map((call) => `${call.method} ${call.path} -> ${call.status}${call.response?.detail?.code ? ` ${call.response.detail.code}` : ""}`);
  return failed.length ? `the record contains a backend failure, the green screen was on a failure: ${[...new Set(failed)].join("; ")}` : null;
}

/** A record refusal line if by the end of the run API requests were left without a response: the file would be incomplete, and replay would turn red on them. */
export function pendingLine(urls) {
  return urls.length ? `by the end of the run these requests were left without a response: ${[...new Set(urls)].join("; ")}` : null;
}

/** A step failure line for requests that are not in the records. */
export function missLine(misses) {
  return misses.length ? `request not recorded, network untouched: ${[...new Set(misses)].join("; ")}` : null;
}

/** `--check-api-records directory`: every `*.json` in the directory is parsed as a git file; prints a list of reasons. */
function checkApiRecords(directory) {
  const problems = [];
  if (fs.existsSync(directory)) {
    for (const file of fs.readdirSync(directory).filter((f) => f.endsWith(".json")).sort()) {
      try {
        parseApiRecords(fs.readFileSync(path.join(directory, file), "utf8"), file.replace(/\.json$/, ""), { gitSource: true });
      } catch (error) {
        problems.push(`${file}: ${error.message}`);
      }
    }
  }
  console.log(JSON.stringify(problems));
}

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

export function checkBase(base) {
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`BASE is not an address: ${base}`);
  }
  if (!ALLOWED_HOSTS.includes(url.hostname)) {
    throw new Error(
      `BASE=${base}: the tool only visits ${ALLOWED_HOSTS.join(", ")}`,
    );
  }
  return url.origin;
}

/** A target by testid: only the keys testid, name, item; name and item do not occur together. */
export function testidTarget(target) {
  if (target === null || typeof target !== "object" || Array.isArray(target) || !("testid" in target)) return false;
  if (Object.keys(target).some((key) => !["testid", "name", "item"].includes(key))) return false;
  if (!(typeof target.testid === "string" && RE_TESTID.test(target.testid))) return false;
  if ("name" in target && "item" in target) return false;
  return ["name", "item"].every((key) => !(key in target) || (typeof target[key] === "string" && target[key].trim() !== ""));
}

/** The parsed `after` of a step; the error says what is missing. */
export function afterOf(after, raw) {
  const bad = (why) => new Error(`after — ${why}: ${JSON.stringify(raw)}`);
  if (after === null || typeof after !== "object" || Array.isArray(after)) throw bad("an object");
  if (Object.keys(after).some((key) => !AFTER_KEYS.includes(key))) throw bad(`only the keys ${AFTER_KEYS.join(", ")}`);
  if (!["screen", "state", "shown", "gone"].some((key) => key in after)) throw bad("at least one of screen, state, shown, gone");
  for (const key of ["screen", "state"]) {
    if (key in after && !(typeof after[key] === "string" && after[key])) throw bad(`${key} is a non-empty string`);
  }
  for (const key of ["shown", "gone"]) {
    if (key in after && !(Array.isArray(after[key]) && after[key].length && after[key].every((id) => typeof id === "string" && RE_TESTID.test(id)))) {
      throw bad(`${key} is a non-empty list of testids of the form <area>.<action>`);
    }
  }
  if ("within" in after && !(Number.isInteger(after.within) && after.within >= 1 && after.within <= 1800)) throw bad("within is a whole number of seconds from 1 to 1800");
  return { screen: after.screen, state: after.state, shown: after.shown ?? [], gone: after.gone ?? [], within: after.within ?? AFTER_TIMEOUT_S };
}

export function parseStep(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`step is not an object: ${JSON.stringify(raw)}`);
  }
  const kinds = STEP_KINDS.filter((kind) => kind in raw);
  if (kinds.length !== 1) {
    throw new Error(
      `a step must have exactly one of ${STEP_KINDS.join(", ")}: ${JSON.stringify(raw)}`,
    );
  }
  const kind = kinds[0];
  const target = raw[kind];
  if (kind === "fill" && typeof raw.value !== "string") {
    throw new Error(`fill has no value: ${JSON.stringify(raw)}`);
  }
  if (
    kind === "order" &&
    !(Array.isArray(target) && target.length >= 2 && target.every((t) => (typeof t === "string" && t) || testidTarget(t)))
  ) {
    throw new Error(`order is a list of two or more texts or {"testid": …}: ${JSON.stringify(raw)}`);
  }
  const byTestid = testidTarget(target);
  if (target !== null && typeof target === "object" && !Array.isArray(target) && "testid" in target && !(byTestid && TESTID_KINDS.includes(kind))) {
    throw new Error(`{"testid": …} is only for ${TESTID_KINDS.join(", ")}; keys are testid (of the form <area>.<action>) and one of name, item: ${JSON.stringify(raw)}`);
  }
  if ("after" in raw && !AFTER_KINDS.includes(kind)) {
    throw new Error(`after is only for ${AFTER_KINDS.join(", ")}: ${JSON.stringify(raw)}`);
  }
  const after = "after" in raw ? afterOf(raw.after, raw) : undefined;
  if (kind === "wait" && target !== null && typeof target === "object" && !byTestid) {
    throw new Error(`wait is a text, milliseconds or {"testid": …}: ${JSON.stringify(raw)}`);
  }
  if (kind === "fact" && !(target && typeof target === "object" && !Array.isArray(target) && Object.keys(target).length > 0
    && Object.values(target).every((v) => typeof v === "string" && v))) {
    throw new Error(`fact is an object "screen fact: value" with strings, for example {"mode": "preview"}: ${JSON.stringify(raw)}`);
  }
  if (kind === "field" && !(typeof raw.has === "string" && raw.has)) {
    throw new Error(`field has no has: ${JSON.stringify(raw)}`);
  }
  if (kind === "download" && !(((typeof target === "string" && target) || byTestid) && raw.named && typeof raw.named.selector === "string" && raw.named.selector)) {
    throw new Error(`download is a button name and named: {"selector": …}: ${JSON.stringify(raw)}`);
  }
  if ("named" in raw && kind !== "download") {
    throw new Error(`named is only for download: ${JSON.stringify(raw)}`);
  }
  if (kind === "described" && !(typeof target === "string" && target && typeof raw.has === "string" && raw.has)) {
    throw new Error(`described is a field name and a non-empty has: ${JSON.stringify(raw)}`);
  }
  const isSelector = target !== null && typeof target === "object" && !Array.isArray(target) && typeof target.selector === "string" && target.selector;
  const isTestid = target !== null && typeof target === "object" && !Array.isArray(target) && typeof target.testid === "string" && target.testid;
  if (["click", "hover", "fill"].includes(kind) && target !== null && typeof target === "object" && !Array.isArray(target) && !isSelector && !namedTarget(target) && !byTestid) {
    throw new Error(`${kind} is a name, {"selector": …}, {"testid": …} or {"role": …, "name": …, "contains": true, "pressed": false}: ${JSON.stringify(raw)}`);
  }
  if (kind === "hover" && !((typeof target === "string" && target) || isSelector || namedTarget(target) || byTestid)) {
    throw new Error(`${kind} is a name or {"selector": …}: ${JSON.stringify(raw)}`);
  }
  if (kind === "filled" && !((typeof target === "string" && target) || isSelector || isTestid)) {
    throw new Error(`${kind} is a name, {"selector": …} or {"testid": …}: ${JSON.stringify(raw)}`);
  }
  if (SEEN_KINDS.includes(kind) && !isSelector) {
    throw new Error(`${kind} is only {"selector": …}: ${JSON.stringify(raw)}`);
  }
  if (kind === "repeat") {
    if (!(Array.isArray(target) && target.length >= 1 && typeof raw.until === "string" && raw.until)) {
      throw new Error(`repeat is a non-empty list of steps and a text in until: ${JSON.stringify(raw)}`);
    }
    if ("max" in raw && !(Number.isInteger(raw.max) && raw.max >= 1 && raw.max <= 200)) {
      throw new Error(`max of repeat is a whole number from 1 to 200: ${JSON.stringify(raw)}`);
    }
    const inner = target.map(parseStep);
    if (inner.some((step) => step.kind === "repeat" || step.kind === "goto")) {
      throw new Error(`repeat and goto are not allowed inside repeat: ${JSON.stringify(raw)}`);
    }
    return { kind, target: inner, until: raw.until, max: raw.max ?? REPEAT_MAX, optional: false };
  }
  if ("within" in raw && !((kind === "wait" && (typeof target === "string" || byTestid)) || kind === "fill") || ("within" in raw && !(Number.isInteger(raw.within) && raw.within >= 1 && raw.within <= 1800))) {
    throw new Error(`within is a whole number of seconds from 1 to 1800, only for wait with a text or testid and for fill: ${JSON.stringify(raw)}`);
  }
  if (["until", "max"].some((key) => key in raw)) {
    throw new Error(`until and max are only for repeat: ${JSON.stringify(raw)}`);
  }
  if (["absent", "active", "disabled", "enabled", ...TICK_KINDS].includes(kind) && !((typeof target === "string" && target) || (byTestid && kind !== "active"))) {
    throw new Error(`${kind} is a non-empty text${kind === "active" ? "" : ' or {"testid": …}'}: ${JSON.stringify(raw)}`);
  }
  if ("optional" in raw && !((kind === "click" || kind === "fill" || (kind === "wait" && (typeof target === "string" || byTestid))) && raw.optional === true)) {
    throw new Error(`optional is only true and only for click, fill and wait with a text or testid: ${JSON.stringify(raw)}`);
  }
  if (kind === "upload" && !(typeof target === "string" && /^[\w][\w.-]*$/.test(target))) {
    throw new Error(`upload is a file name from the scenario files directory, without directories: ${JSON.stringify(raw)}`);
  }
  if ("to" in raw && !(kind === "upload" && raw.to && typeof raw.to.selector === "string" && raw.to.selector)) {
    throw new Error(`to is only for upload and only {"selector": …}: ${JSON.stringify(raw)}`);
  }
  if (kind === "goto" && !(typeof target === "string" && target.startsWith("/"))) {
    throw new Error(`goto is a path from the root, with "/": ${JSON.stringify(raw)}`);
  }
  if (kind === "hold" && !(typeof target === "string" && target.startsWith("/") && Number.isInteger(raw.ms) && raw.ms >= HOLD_MIN_MS && raw.ms <= HOLD_MAX_MS)) {
    throw new Error(`hold is a part of the request address with "/" and ms, a whole number from ${HOLD_MIN_MS} to ${HOLD_MAX_MS}: ${JSON.stringify(raw)}`);
  }
  if (kind === "same-href" && !(Array.isArray(target) && target.length === 2 && target.every((item) => typeof item === "string" && item))) {
    throw new Error(`same-href is two link selectors: ${JSON.stringify(raw)}`);
  }
  if (kind === "advance" && !(typeof target === "string" && target.startsWith("/"))) {
    throw new Error(`advance is a part of the request path with "/": ${JSON.stringify(raw)}`);
  }
  if (kind === "cut" && !(typeof target === "string" && target.startsWith("/"))) {
    throw new Error(`cut is the end of the request path with "/": ${JSON.stringify(raw)}`);
  }
  if (kind === "tab" && !TAB_ACTIONS.includes(target)) {
    throw new Error(`tab is one of ${TAB_ACTIONS.join(", ")}: ${JSON.stringify(raw)}`);
  }
  if (kind === "visibility" && !VISIBILITY_VALUES.includes(target)) {
    throw new Error(`visibility is one of ${VISIBILITY_VALUES.join(", ")}: ${JSON.stringify(raw)}`);
  }
  if (kind === "requested" && !(typeof target === "string" && target.startsWith("/"))) {
    throw new Error(`requested is the end of the request path with "/": ${JSON.stringify(raw)}`);
  }
  if ("times" in raw && !(kind === "requested" && Number.isInteger(raw.times) && raw.times >= 0 && raw.times <= REQUESTED_TIMES_MAX)) {
    throw new Error(`times is only for requested, a whole number from 0 to ${REQUESTED_TIMES_MAX}: ${JSON.stringify(raw)}`);
  }
  if ("method" in raw && !(kind === "requested" && REQUEST_METHODS.includes(raw.method))) {
    throw new Error(`method is only for requested, one of ${REQUEST_METHODS.join(", ")}: ${JSON.stringify(raw)}`);
  }
  if ("ms" in raw && kind !== "hold") {
    throw new Error(`ms is only for hold: ${JSON.stringify(raw)}`);
  }
  return { kind, target, value: raw.value, has: raw.has, to: raw.to, named: raw.named, optional: raw.optional === true, within: raw.within, ms: raw.ms, times: raw.times, method: raw.method, after };
}

/** A target by role and name, not by CSS: `{"role": "link", "name": "Smith", "contains": true}`; `pressed: false` is the first unmarked choice button. */
export function namedTarget(target) {
  if (target === null || typeof target !== "object" || Array.isArray(target) || "selector" in target || "testid" in target) return false;
  const known = ["role", "name", "contains", "pressed"];
  if (Object.keys(target).some((key) => !known.includes(key))) return false;
  if (!("role" in target || "name" in target || "pressed" in target)) return false;
  if ("role" in target && !(typeof target.role === "string" && target.role)) return false;
  if ("name" in target && !(typeof target.name === "string" && target.name)) return false;
  if ("contains" in target && !("name" in target && target.contains === true)) return false;
  if ("pressed" in target && !(target.pressed === false && !("name" in target))) return false;
  return true;
}

/** Why the `--legacy` key is wrong; null means the reason is given. */
export function legacyProblem(value) {
  return typeof value === "string" && value.trim() ? null : '--legacy requires a reason: --legacy "reason"';
}

/** How the target is named in a failure message. */
export function targetLabel(target) {
  if (typeof target === "string") return target;
  if (testidTarget(target)) return target.testid + (target.name ? ` "${target.name}"` : target.item ? ` [${target.item}]` : "");
  return target.name ?? target.selector ?? target.testid ?? `${target.role ?? "button"} without a selection mark`;
}

/** Elements with a testid, selected by name (exact label) or item (the name contains the data text). */
export function pickByTestid(infos, target) {
  const norm = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
  if (target.name) return infos.filter((e) => norm(e.name) === norm(target.name));
  if (target.item) return infos.filter((e) => norm(e.name).includes(norm(target.item)) || norm(e.text).includes(norm(target.item)));
  return infos;
}

/** Why there is no testid target; null means there is. `infos` - all visible elements with this testid. */
export function labelProblem(infos, target) {
  if (pickByTestid(infos, target).length) return null;
  if (!infos.length) return `element ${target.testid} is not on the page`;
  const seen = [...new Set(infos.map((e) => `"${String(e.name ?? "").trim()}"`))].slice(0, 5).join(", ");
  if (target.name) return `label of ${target.testid}: ${seen}, the requirement names "${target.name}"`;
  return `${target.testid} with "${target.item}" is absent; present: ${seen}`;
}

/**
 * Why `after` did not occur; null means it did. `seen` - the screen after the step (`{name, state}` or null) and the visible testids.
 */
export function afterProblem(after, seen) {
  const misses = [];
  const screen = seen.screen;
  if (after.screen && screen?.name !== after.screen) misses.push(`screen ${after.screen}, but ${screen?.name ?? "no root"} is open`);
  if (after.state && screen?.state !== after.state) misses.push(`state ${after.state}, but ${screen?.state ?? "none"}`);
  const shown = new Set(seen.testids);
  const notShown = after.shown.filter((id) => !shown.has(id));
  const notGone = after.gone.filter((id) => shown.has(id));
  if (notShown.length) misses.push(`did not appear: ${notShown.join(", ")}`);
  if (notGone.length) misses.push(`did not disappear: ${notGone.join(", ")}`);
  return misses.length ? `after the step did not occur: ${misses.join("; ")}` : null;
}

/** `after` taken from observation: the screen and state after the step and up to three testids that appeared - first the screen's own testids, then those of shared areas (menu, overlays). */
export function observedAfter(before, now) {
  const had = new Set(before.testids);
  const own = (id) => (now.screen?.name && id.startsWith(`${now.screen.name}.`) ? 0 : 1);
  const appeared = now.testids.filter((id) => !had.has(id)).sort((a, b) => own(a) - own(b)).slice(0, 3);
  const after = {};
  if (now.screen?.name) after.screen = now.screen.name;
  if (now.screen?.state) after.state = now.screen.state;
  if (appeared.length) after.shown = appeared;
  return after;
}

/** Why the texts are not in order in the visible text of the page; null means they are. */
export function orderProblem(text, items) {
  let from = 0;
  for (const item of items) {
    const at = text.indexOf(item, from);
    if (at < 0) {
      return text.includes(item)
        ? `"${item}" comes before the previous text of the list`
        : `text "${item}" is not on the page`;
    }
    from = at + item.length;
  }
  return null;
}

/** Why two links do not lead to the same place; null means the addresses are equal and non-empty. */
export function sameHrefProblem(first, second) {
  if (!first || !second) return `link address not read: "${first ?? ""}" and "${second ?? ""}"`;
  return first === second ? null : `links lead to different places: ${first} and ${second}`;
}

/** Why the absence of a text is not proven; null means the text is absent on a non-empty page. */
export function absentProblem(text, item) {
  if (!text.trim()) return "the page is empty: the absence of the text is not proven";
  return text.includes(item) ? `text "${item}" is on the page` : null;
}

/** Why the menu item is not the current one; null means exactly it is current. `current` - names of items with aria-current="page". */
export function activeProblem(current, item) {
  if (current.length === 0) return "no menu item is marked current";
  if (current.length > 1) return `several items are marked current: ${current.join(", ")}`;
  return current[0] === item ? null : `"${current[0]}" is marked current, not "${item}"`;
}

/** Login kinds the tool can put into the browser; bearer, cookie or none. */
const CREDENTIAL_KINDS = ["bearer", "cookie", "none"];
const BUNDLED_CHROME = "bundled";

/** A login passed by the environment; null means no login. */
export function givenCredential(env) {
  const kind = env.BRAILLE_CREDENTIAL;
  if (!kind) return null;
  if (!CREDENTIAL_KINDS.includes(kind)) {
    throw new Error(`BRAILLE_CREDENTIAL=${kind}: expected ${CREDENTIAL_KINDS.join(", ")}`);
  }
  const secret = env.BRAILLE_SECRET ?? "";
  if (kind !== "none" && !secret) throw new Error("BRAILLE_CREDENTIAL is set, but BRAILLE_SECRET is empty");
  return { credential: kind, secret };
}

/** Which browser to launch: the default path, a custom path or the one Playwright finds itself. */
export function chromeOption(env) {
  const chrome = env.BRAILLE_CHROME || BUNDLED_CHROME;
  return chrome === BUNDLED_CHROME ? {} : { executablePath: chrome };
}

/** Why the button is not considered disabled; null means it is the only one on the page and it is disabled. `states` - per button with this name: whether it is disabled. */
export function disabledProblem(states, item) {
  if (states.length === 0) return `button "${item}" is not on the page`;
  return states.every(Boolean) ? null : `button "${item}" is enabled`;
}

/** The composition of failure evidence: one declaration. */
export const EVIDENCE = {
  "required": [
    "url",
    "text",
    "screenshot",
    "load"
  ],
  "requiredInLoad": [
    "readyState",
    "root",
    "agent",
    "scripts",
    "chunkErrors"
  ],
  "limits": {
    "text": 1500,
    "console": 20,
    "pageerrors": 10,
    "requests": 30,
    "line": 240,
    "api": 12
  },
  "chunkError": "dynamically imported module|Loading chunk|ChunkLoadError|Importing a module script failed|error loading dynamically|MIME type",
  "masks": {
    "replacement": "***",
    "patterns": [
      "eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]*",
      "(?:Bearer|Basic)\\s+[A-Za-z0-9._~+/=-]{8,}",
      "(?:token|secret|password|passwd|api[_-]?key|auth_token|access_token|refresh_token|authorization)[\"']?\\s*[:=]\\s*[\"']?[^\\s\"'&,;}]{4,}",
      "(?=[A-Za-z0-9_]*\\d)(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{32,}"
    ]
  }
};
const MASK_PATTERNS = EVIDENCE.masks.patterns.map((source) => new RegExp(source, "gi"));
const CHUNK_ERROR = new RegExp(EVIDENCE.chunkError, "i");

/** Masking by data: patterns from the declaration and the login secret itself, wherever it stands. */
export function maskSecrets(text, secrets = []) {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join(EVIDENCE.masks.replacement);
  }
  for (const pattern of MASK_PATTERNS) out = out.replace(pattern, EVIDENCE.masks.replacement);
  return out;
}

/** An address without the query string and the anchor: they may contain tokens. */
export function bareUrl(url) {
  return String(url ?? "").replace(/[?#].*$/, "");
}

/** Whether the message refers to a chunk load failure. */
export function isChunkError(text) {
  return CHUNK_ERROR.test(String(text ?? ""));
}

/** Evidence from raw page data: trimming to the limits and masking. A pure function - the selftest checks it. */
export function buildEvidence(raw, secrets = []) {
  const limits = EVIDENCE.limits;
  const line = (value) => maskSecrets(String(value ?? ""), secrets).slice(0, limits.line);
  const list = (items, max) => (Array.isArray(items) ? items : []).slice(0, max).map(line);
  const load = raw.load ?? {};
  return {
    url: maskSecrets(bareUrl(raw.url), secrets),
    title: line(raw.title),
    text: maskSecrets(String(raw.text ?? "").replace(/\s+\n/g, "\n").trim(), secrets).slice(0, limits.text),
    console: list(raw.console, limits.console),
    pageerrors: list(raw.pageerrors, limits.pageerrors),
    requests: (Array.isArray(raw.requests) ? raw.requests : []).slice(0, limits.requests).map((r) => ({
      method: line(r.method),
      path: maskSecrets(bareUrl(r.path), secrets).slice(0, limits.line),
      status: typeof r.status === "number" ? r.status : line(r.status),
      ms: r.ms,
    })),
    api: (Array.isArray(raw.api) ? raw.api : []).slice(-limits.api).map((r) => ({
      method: line(r.method),
      path: maskSecrets(bareUrl(r.path), secrets).slice(0, limits.line),
      status: r.status,
      ms: r.ms,
    })),
    screenshot: raw.screenshot ?? "",
    screen: raw.screen
      ? {
          testid: line(raw.screen.testid),
          state: raw.screen.state === null || raw.screen.state === undefined ? null : line(raw.screen.state),
          outer: list((raw.screen.outer ?? []).map((o) => `${o.testid}:${o.state}`), limits.console),
          overlays: list((raw.screen.overlays ?? []).map((o) => o.name || o.testid || o.role), limits.console),
          facts: list(Object.entries(raw.screen.facts ?? {}).map(([k, v]) => `${k}=${v}`), limits.console),
          alerts: list(raw.screen.alerts, limits.console),
        }
      : null,
    busy: list(Object.entries(raw.busy ?? {}).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`), limits.console),
    target: raw.target === null || raw.target === undefined
      ? null
      : list(raw.target.map((e) => [`${e.role ?? "?"} "${e.name}"${e.testid ? ` ${e.testid}` : ""}`, e.disabled && "disabled", e.busy && "busy", e.inViewport === false && "outside the viewport", e.occludedBy?.length && `covered: ${e.occludedBy.join(", ")}`].filter(Boolean).join(", ")), limits.console),
    load: {
      readyState: load.readyState ?? null,
      root: load.root ?? null,
      agent: load.agent ?? null,
      scripts: load.scripts ?? null,
      chunkErrors: list(load.chunkErrors, limits.console),
    },
  };
}

/** What is missing from the evidence; empty means the composition is complete. Read by the selftest. */
export function evidenceProblems(evidence) {
  const problems = [];
  if (!evidence || typeof evidence !== "object") return ["no evidence"];
  for (const field of EVIDENCE.required) {
    const value = evidence[field];
    const empty = value === undefined || value === null || value === "" || (typeof value === "object" && !Object.keys(value).length);
    if (empty) problems.push(`no field ${field}`);
  }
  for (const field of EVIDENCE.requiredInLoad) {
    if (!evidence.load || !(field in evidence.load) || evidence.load[field] === undefined) problems.push(`no load.${field}`);
  }
  return problems;
}

/** Takes the page load state; the page may be closed or dead - then the fields are empty but present. */
async function collectEvidence(page, trail, shot, secrets, step = null) {
  // The step target as the agent sees it: what `__agent.find` sees under this name or testid - role, name, disabled, covered, in the viewport.
  const query = typeof step?.target === "string" ? { name: step.target } : step?.target?.testid ? { testid: step.target.testid } : null;
  const found = query
    ? await page
        .evaluate((q) => (window.__agent?.find ? window.__agent.find(q).slice(0, 3) : null), query)
        .catch(() => null)
    : null;
  const evaluated = await page
    .evaluate(() => {
      const rootEl = document.querySelector("#root, #app");
      return {
        title: document.title,
        text: document.body ? document.body.innerText : "",
        load: {
          readyState: document.readyState,
          root: rootEl ? `${rootEl.tagName.toLowerCase()}#${rootEl.id}, descendants ${rootEl.childElementCount}` : "no #root",
          agent: typeof window.__agent === "object" && window.__agent !== null,
          scripts: document.querySelectorAll("script[src]").length,
        },
        // What the screen says about itself - name, data-state, layers on top, facts, alerts, unfinished work.
        screen: (() => {
          try {
            const s = window.__agent?.screen?.();
            return s ? { testid: s.testid, state: s.state, outer: s.outerScreens, overlays: s.overlays, facts: s.facts, alerts: s.alerts } : null;
          } catch {
            return null;
          }
        })(),
        busy: (() => {
          try {
            return window.__agent?.busy?.() ?? null;
          } catch {
            return null;
          }
        })(),
      };
    })
    .catch((error) => ({ title: "", text: "", load: { readyState: `page not responding: ${error.message.slice(0, 80)}`, root: null, agent: null, scripts: null } }));
  const chunkErrors = [
    ...trail.console.filter(isChunkError),
    ...trail.pageerrors.filter(isChunkError),
    ...trail.requests.filter((r) => /\.m?js$/.test(r.path) && r.status !== undefined).map((r) => `${r.method} ${r.path} -> ${r.status}`),
  ];
  return buildEvidence(
    {
      url: page.url(),
      title: evaluated.title,
      text: evaluated.text,
      console: trail.console,
      pageerrors: trail.pageerrors,
      requests: trail.requests,
      api: trail.api,
      screenshot: shot,
      load: { ...evaluated.load, chunkErrors },
      screen: evaluated.screen ?? null,
      busy: evaluated.busy ?? null,
      target: found === null ? null : found.map((e) => ({ role: e.role, name: e.name, testid: e.testid, disabled: !!e.aria?.disabled, busy: !!e.aria?.busy, inViewport: e.inViewport, occludedBy: (e.occludedBy ?? []).map((o) => o.name || o.testid || o.role) })),
    },
    secrets,
  );
}

/** The screen state in one line: name, data-state, layers on top, facts, alerts, unfinished work. */
export function screenSummary(evidence) {
  const screen = evidence?.screen;
  if (!screen) return evidence?.load?.agent ? "window.__agent is present, no screen with data-state" : "no window.__agent";
  const parts = [`screen ${screen.testid} data-state=${screen.state}`];
  if (screen.overlays?.length) parts.push(`on top: ${screen.overlays.join(", ")}`);
  if (screen.alerts?.length) parts.push(`alerts: ${screen.alerts.join("; ")}`);
  if (screen.facts?.length) parts.push(`facts: ${screen.facts.join(", ")}`);
  if (evidence.busy?.length) parts.push(`busy: ${evidence.busy.join(", ")}`);
  if (evidence.target) parts.push(evidence.target.length ? `target: ${evidence.target.join("; ")}` : "target: none on the screen");
  return parts.join(" | ");
}

/** A Playwright timeout is not a cause: the cause is named by the screen. "Timeout 60000ms exceeded" becomes what
 * the step was waiting for, the deadline and the screen state; other errors are left alone. */
export function timeoutReason(error, step, evidence) {
  const timeout = /Timeout (\d+)ms exceeded/.exec(error ?? "");
  if (!timeout) return error;
  // The step arrives parsed (`parseStep`: {kind, target}).
  const kind = step?.kind ?? "step";
  const target = step?.target;
  const wanted = typeof target === "string" ? `"${target}"` : JSON.stringify(target ?? "");
  const rest = error.split(" — ").slice(1).join(" — ");
  return [`${kind} ${wanted} did not come true within ${Math.round(Number(timeout[1]) / 1000)} s; ${screenSummary(evidence)}`, rest].filter(Boolean).join(" - ").slice(0, 600);
}

/** Failed API requests from `window.__agent.errors()` in one line; empty means none. */
export function apiFailuresLine(entries) {
  const lines = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.kind === "request")
    .map((e) => `${e.method} ${String(e.url).replace(/^https?:\/\/[^/]+/, "")} -> ${e.status}${e.code ? ` ${e.code}` : ""}`);
  return lines.length ? `API: ${[...new Set(lines)].join("; ")}` : "";
}

/** Why the click will not happen: the target is disabled; null means enabled. */
export function clickBlockedProblem(enabled, item) {
  return enabled ? null : `"${item}" is disabled - cannot click`;
}

/** Why the button is not considered enabled; null means buttons with this name exist and are all enabled. */
export function enabledProblem(states, item) {
  if (states.length === 0) return `button "${item}" is not on the page`;
  return states.some(Boolean) ? `button "${item}" is disabled` : null;
}

/** Why the field is not considered filled; null means the field exists and has a non-empty value. */
export function filledProblem(values) {
  if (values.length === 0) return "the field is not on the page";
  return values[0].trim() ? null : "the field is empty";
}

/** Why the visibility is wrong; null means as expected. `count` - how many elements by the selector are visible. */
export function seenProblem(count, kind) {
  if (kind === "visible") return count > 0 ? null : "no visible element by the selector";
  return count === 0 ? null : `elements visible by the selector: ${count}`;
}

/** Why the field value is wrong; null means the field exists and its value contains the text. `values` - values of the found fields. */
export function fieldProblem(values, text) {
  if (values.length === 0) return "the field is not on the page";
  return values[0].includes(text) ? null : `the field holds "${values[0].slice(0, 80)}", the text "${text}" is not in it`;
}

/** A name without the extension, as the download step compares it: only letters and digits, case-insensitive. */
function nameLetters(text) {
  return String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Why the downloaded file name is wrong; null means the file is named after the document title.
 * Servers replace characters forbidden in a file name and may cut long names,
 * so only letters and digits are compared, and the name may be the beginning of the title.
 */
export function downloadNameProblem(fileName, title) {
  const stem = nameLetters(String(fileName).replace(/\.[^.]+$/, ""));
  const wanted = nameLetters(title);
  if (!wanted) return "no document title on the page";
  if (!stem || !wanted.startsWith(stem)) return `file "${fileName}", expected the title "${title.trim()}"`;
  return null;
}

/** Why the field description is wrong; null means the field has a description with this text. `descriptions` - descriptions of the found fields (text of the elements from aria-describedby). */
export function describedProblem(descriptions, text) {
  if (descriptions.length === 0) return "the field is not on the page";
  if (!descriptions[0].trim()) return "the field has no description (aria-describedby is empty or points to an empty place)";
  return descriptions[0].includes(text) ? null : `the field description is "${descriptions[0].slice(0, 80)}", the text "${text}" is not in it`;
}

/** Why the checkbox is not in the expected state; null means it is the only one and as expected. `ticks` - per checkbox with this name: {checked, focused}. */
export function tickProblem(ticks, item, kind) {
  if (ticks.length === 0) return `checkbox "${item}" is not on the page`;
  if (ticks.length > 1) return `there are ${ticks.length} checkboxes "${item}" on the page`;
  const [tick] = ticks;
  if (kind === "checked") return tick.checked ? null : `checkbox "${item}" is unchecked`;
  if (kind === "unchecked") return tick.checked ? `checkbox "${item}" is checked` : null;
  return tick.focused ? null : `focus is not on checkbox "${item}"`;
}

/** The size of the margin around the element in a failure snapshot. */
const CLIP_PAD = 16;

/** Screen states in which it is ready; `loading` - still waiting, `error` - failure. */
const READY_STATES = ["ready", "empty"];

/**
 * How long to wait for the screen root to appear before concluding that the page has none.
 * Measured: the root appeared 0.1-1.2 s after `window.__agent` (while
 * an auth guard waited for the current-user request), and over three seconds under the load of four parallel scenarios.
 */
const SCREEN_APPEAR_TIMEOUT_MS = 8000;

/** How long to wait for the screen to leave loading. */
const SCREEN_READY_TIMEOUT_MS = 20000;

/** Roles by which click finds an element by name; overlap is checked only for them. */
const CLICK_ROLES = ["button", "link", "tab", "menuitem"];

/** Why the screen is a failure; null means it is not. `screen` - the answer of `window.__agent.screen()` or null. */
export function screenProblem(screen) {
  if (!screen || screen.state !== "error") return null;
  const text = (screen.alerts ?? []).join("; ");
  return `screen ${screen.testid} is in the error state${text ? `: ${text}` : ""}`;
}

/** Whether to keep waiting: the screen exists and has not left loading. */
export function screenPending(screen) {
  return Boolean(screen) && !READY_STATES.includes(screen.state) && screen.state !== "error";
}

/** Why the element cannot be clicked: another one covers it; null means not covered. `info` - an element from `find()`. */
export function occlusionProblem(info) {
  const over = info?.occludedBy ?? [];
  if (over.length === 0) return null;
  const names = over.map((o) => `"${o.name || o.testid || o.tag}"${o.testid ? ` (${o.testid})` : ""}`);
  return `"${info.name || info.testid}" is covered: ${names.join(", ")}`;
}

/** Why the texts are not in order; null means they are. `hits` - per text of `items`: domIndex of the found elements. */
export function orderProblemByHits(hits, items, texts = {}) {
  let from = -1;
  let prev = null;
  for (const [i, item] of items.entries()) {
    const list = hits[i] ?? [];
    if (list.length === 0) return `text "${item}" is not on the page`;
    // Both texts in one element ("title · mode"): the order is by the text of this element,
    // and this occurrence is closer than any following element.
    const body = texts[from];
    const same = list.includes(from) && typeof body === "string" && prev !== null;
    if (same && body.indexOf(item, body.indexOf(prev) + prev.length) >= 0) {
      prev = item;
      continue;
    }
    const next = list.filter((index) => index > from).sort((a, b) => a - b)[0];
    if (next === undefined) return `"${item}" comes before the previous text of the list`;
    from = next;
    prev = item;
  }
  return null;
}

/**
 * Order texts for `find()`: a multiline text is several elements in a row, and
 * `find()` searches by the text of one element, so the lines go as separate items.
 */
export function orderLines(items) {
  return items.flatMap((item) => item.split(/\n+| · /).map((line) => line.trim()).filter(Boolean));
}

/** Why the absence of a text is not proven; null means the text is absent on a non-empty page. `count` - how many elements contain the text, `alive` - whether there is anything at all on the page. */
export function absentProblemByCount(count, alive, item) {
  if (!alive) return "the page is empty: the absence of the text is not proven";
  return count > 0 ? `text "${item}" is on the page` : null;
}

/** The failure snapshot clip: the element box with a margin, not going past the left and top edges. No box or an empty one - null. */
export function clipFor(box, pad = CLIP_PAD) {
  if (!box || !(box.width > 0) || !(box.height > 0)) return null;
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  return { x, y, width: box.width + (box.x - x) + pad, height: box.height + (box.y - y) + pad };
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

function selftest() {
  const cases = [
    [
      "recordings: secrets are masked in query, request body and response, and replay still matches",
      () => {
        const call = recordedCall("POST", "http://x/api/login?token=abc&a=1", '{"password":"hunter2","user":"u"}', "application/json", 200, "application/json", '{"access_token":"t0p","me":"u"}');
        const text = JSON.stringify(call);
        for (const leak of ["hunter2", "abc", "t0p"]) if (text.includes(leak)) throw new Error(`leaked ${leak}: ${text}`);
        const other = apiRequestKey("POST", "http://y/api/login?token=zzz&a=1", '{"password":"other","user":"u"}', "application/json");
        if (other !== JSON.stringify([call.method, call.path, call.query, call.body])) throw new Error("replay key differs");
      },
      true,
    ],
    ["foreign host refused", () => checkBase("https://other.example.com"), false],
    ["localhost accepted", () => checkBase("http://localhost:5173"), true],
    ["step with two kinds rejected", () => parseStep({ goto: "/a", click: "b" }), false],
    ["step without a kind rejected", () => parseStep({ value: "x" }), false],
    ["fill without value rejected", () => parseStep({ fill: "Name" }), false],
    ["goto without \"/\" rejected", () => parseStep({ goto: "app" }), false],
    ["click accepted", () => parseStep({ click: "Sign in" }), true],
    // A testid target and after.
    ...TESTID_KINDS.map((kind) => [
      `${kind} with testid accepted`,
      () => parseStep({ [kind]: { testid: "checkout.submit" }, ...(kind === "fill" ? { value: "x" } : {}), ...(kind === "download" ? { named: { selector: "h1" } } : {}), ...(kind === "field" ? { has: "x" } : {}) }),
      true,
    ]),
    ["order with testid and text accepted", () => parseStep({ order: [{ testid: "tabs.tab-items" }, "Items"] }), true],
    ["empty testid rejected", () => parseStep({ click: { testid: "" } }), false],
    ["testid without an area rejected", () => parseStep({ click: { testid: "submit" } }), false],
    ["testid with name and item together rejected", () => parseStep({ click: { testid: "a.b", name: "x", item: "y" } }), false],
    ["testid with selector rejected", () => parseStep({ click: { testid: "a.b", selector: "x" } }), false],
    ["testid for active rejected", () => parseStep({ active: { testid: "nav.analytics" } }), false],
    ["wait with an object without testid rejected", () => parseStep({ wait: { selector: "h1" } }), false],
    ["fact with mode and step accepted", () => parseStep({ fact: { mode: "preview", step: "4" } }).kind === "fact", true],
    ["empty fact rejected", () => parseStep({ fact: {} }), false],
    ["fact with a number rejected", () => parseStep({ fact: { step: 4 } }), false],
    ["after for click accepted", () => parseStep({ click: { testid: "a.b" }, after: { screen: "checkout", state: "ready", shown: ["checkout.restart"] } }), true],
    ["after for wait rejected", () => parseStep({ wait: "Text", after: { state: "ready" } }), false],
    ["empty after rejected", () => parseStep({ click: "OK", after: {} }), false],
    ["after with a foreign key rejected", () => parseStep({ click: "OK", after: { text: "x" } }), false],
    ["after with a testid without an area rejected", () => parseStep({ click: "OK", after: { shown: ["restart"] } }), false],
    ["after inside repeat is parsed", () => parseStep({ repeat: [{ click: { testid: "a.b" }, after: { state: "ready" } }], until: "Total" }).target[0].after.state === "ready", true],
    [
      "labelProblem: no element, foreign label, no data; a match is null",
      () => {
        const infos = [{ name: "Next step", text: "Next step" }];
        if (labelProblem([], { testid: "a.b" }) !== "element a.b is not on the page") throw new Error("no element");
        const label = labelProblem(infos, { testid: "a.b", name: "Submit answer" });
        if (!(label.includes("\"Next step\"") && label.includes("\"Submit answer\"") && label.startsWith("label of a.b"))) throw new Error(label);
        if (!labelProblem(infos, { testid: "a.b", item: "Option 2" }).startsWith("a.b with \"Option 2\" is absent")) throw new Error("item");
        if (labelProblem(infos, { testid: "a.b", name: "Next step" }) !== null) throw new Error("match rejected");
        return labelProblem(infos, { testid: "a.b" }) === null;
      },
      true,
    ],
    [
      "afterProblem: wrong screen, state, did not appear, did not disappear; everything in place - null",
      () => {
        const after = afterOf({ screen: "checkout", state: "ready", shown: ["a.x"], gone: ["a.y"] }, {});
        const ok = { screen: { name: "checkout", state: "ready" }, testids: ["a.x"] };
        if (afterProblem(after, ok) !== null) throw new Error("occurred after rejected");
        const bad = afterProblem(after, { screen: { name: "people", state: "loading" }, testids: ["a.y"] });
        return ["screen checkout", "state ready", "did not appear: a.x", "did not disappear: a.y"].every((part) => bad.includes(part));
      },
      true,
    ],
    [
      "observedAfter: screen, state and the testids that appeared, the screen's own first",
      () => {
        const seen = observedAfter({ testids: ["a.x"] }, { screen: { name: "people", state: "ready" }, testids: ["a.x", "a.y"] });
        const ownFirst = observedAfter({ testids: [] }, { screen: { name: "people", state: "ready" }, testids: ["nav.a", "nav.b", "nav.c", "people.add"] });
        return JSON.stringify(seen) === JSON.stringify({ screen: "people", state: "ready", shown: ["a.y"] }) && ownFirst.shown[0] === "people.add";
      },
      true,
    ],
    [
      "session: declared transitions pass, undeclared ones do not",
      () => sessionMoveProblem("ready", "busy") === null && sessionMoveProblem("busy", "dirty") === null && sessionMoveProblem("dirty", "busy") === null && sessionMoveProblem("closed", "ready") !== null && sessionMoveProblem("busy", "closed") !== null && sessionMoveProblem("dirty", "ready") !== null,
      true,
    ],
    ["fillValues substitutes values with quotes", () => fillValues({ click: { testid: "a.b", item: "{t}" } }, { t: 'Item "A"' }).click.item === 'Item "A"', true],
    ["order from a single text rejected", () => parseStep({ order: ["Create"] }), false],
    ["order accepted", () => parseStep({ order: ["Create", "Library"] }), true],
    ["absent without a text rejected", () => parseStep({ absent: "" }), false],
    ["upload with a file name accepted", () => parseStep({ upload: "sample.txt" }), true],
    ["hover accepted", () => parseStep({ hover: "Build" }), true],
    ["same-href accepted", () => parseStep({ "same-href": ["a.x", "a.y"] }), true],
    ["same-href from a single selector rejected", () => parseStep({ "same-href": ["a.x"] }), false],
    [
      "equal addresses pass, different and unread ones do not",
      () => {
        if (sameHrefProblem("/g?d=1", "/g?d=1") !== null) throw new Error("equal rejected");
        if (sameHrefProblem("/g?d=1", "/g?d=2") === null) throw new Error("different accepted");
        if (sameHrefProblem(null, null) === null) throw new Error("unread accepted");
        return true;
      },
      true,
    ],
    [
      "visits: API requests and pages collected, foreign requests dropped",
      () => {
        const v = visitsOf(
          [{ method: "GET", path: "/api/people" }, { method: "GET", path: "/assets/app.js" }, { method: "GET", path: "/api/people" }],
          ["/app/people"],
          [{ path: "/app/people?x=1" }, { path: "/app/items/7" }],
        );
        return v.api.length === 1 && v.pages.join() === "/app/items/7,/app/people";
      },
      true,
    ],
    ["hold accepted", () => parseStep({ hold: "/attachments", ms: 6000 }), true],
    ["hold without ms rejected", () => parseStep({ hold: "/attachments" }), false],
    ["hold with a delay above the limit rejected", () => parseStep({ hold: "/attachments", ms: HOLD_MAX_MS + 1 }), false],
    ["hold without \"/\" in the address rejected", () => parseStep({ hold: "attachments", ms: 6000 }), false],
    ["cut accepted", () => parseStep({ cut: "/session/answer" }), true],
    ["cut without \"/\" rejected", () => parseStep({ cut: "session/answer" }), false],
    ["tab open accepted", () => parseStep({ tab: "open" }), true],
    ["tab with a foreign value rejected", () => parseStep({ tab: "third" }), false],
    ["visibility hidden accepted", () => parseStep({ visibility: "hidden" }), true],
    ["visibility with a foreign value rejected", () => parseStep({ visibility: "away" }), false],
    ["requested with times accepted", () => parseStep({ requested: "/pause", times: 1 }), true],
    ["requested without \"/\" rejected", () => parseStep({ requested: "pause" }), false],
    ["requested with a fractional times rejected", () => parseStep({ requested: "/pause", times: 1.5 }), false],
    ["times for click rejected", () => parseStep({ click: "Build", times: 1 }), false],
    ["method for requested with a foreign value rejected", () => parseStep({ requested: "/pause", method: "FETCH" }), false],
    [
      "requested turns red: no requests, too few, too many; turns green on a match",
      () => {
        const log = [{ method: "POST", path: "/api/x/pause" }, { method: "POST", path: "/api/x/resume" }, { method: "GET", path: "/api/x/resume" }];
        if (requestedProblem(requestCount(log, "/answer"), undefined, "/answer") === null) throw new Error("there was no request, but the expectation was accepted");
        if (requestedProblem(requestCount(log, "/resume"), 1, "/resume") === null) throw new Error("two requests, one expected, but the expectation was accepted");
        if (requestedProblem(requestCount(log, "/pause"), 2, "/pause") === null) throw new Error("one request, two expected, but the expectation was accepted");
        if (requestedProblem(requestCount(log, "/pause"), 0, "/pause") === null) throw new Error("zero expected, there was a request, but the expectation was accepted");
        if (requestedProblem(requestCount(log, "/resume", "POST"), 1, "/resume") !== null) throw new Error("one POST rejected");
        if (requestedProblem(requestCount(log, "/pause"), undefined, "/pause") !== null) throw new Error("there was a request, but the expectation was rejected");
        return true;
      },
      true,
    ],
    ["ms for click rejected", () => parseStep({ click: "Build", ms: 6000 }), false],
    ["visible without a selector rejected", () => parseStep({ visible: "Hint" }), false],
    ["hidden with a selector accepted", () => parseStep({ hidden: { selector: "[role=tooltip]" } }), true],
    ["filled accepted", () => parseStep({ filled: "Person role" }), true],
    ["described accepted", () => parseStep({ described: "Purpose", has: "Sets" }), true],
    ["download accepted", () => parseStep({ download: "Download", named: { selector: "h1" } }), true],
    ["download without named rejected", () => parseStep({ download: "Download" }), false],
    ["named for click rejected", () => parseStep({ click: "Download", named: { selector: "h1" } }), false],
    [
      "file name by title accepted, a foreign one rejected",
      () => {
        if (downloadNameProblem("Quarterly report.docx", "Quarterly: report") !== null) throw new Error("correct name not accepted");
        if (downloadNameProblem("Unrelated notes.docx", "Report") === null) throw new Error("foreign name accepted");
        return true;
      },
      true,
    ],
    ["described without has rejected", () => parseStep({ described: "Purpose" }), false],
    [
      "field description: has the text, empty, foreign text, no field",
      () => {
        if (describedProblem(["Sets the expected outcome"], "expected outcome") !== null) throw new Error("correct description not recognized");
        if (describedProblem([""], "expected") === null) throw new Error("empty description accepted");
        if (describedProblem(["Other"], "expected") === null) throw new Error("foreign description accepted");
        if (describedProblem([], "expected") === null) throw new Error("missing field accepted");
      },
      true,
    ],
    ["filled with an empty object rejected", () => parseStep({ filled: {} }), false],
    ["filled with testid accepted", () => parseStep({ filled: { testid: "editor.prompt" } }), true],
    ["enabled without a text rejected", () => parseStep({ enabled: "" }), false],
    ["repeat accepted", () => parseStep({ repeat: [{ click: "Next" }], until: "Total", max: 12 }), true],
    ["repeat without until rejected", () => parseStep({ repeat: [{ click: "Next" }] }), false],
    ["repeat inside repeat rejected", () => parseStep({ repeat: [{ repeat: [{ click: "a" }], until: "b" }], until: "c" }), false],
    ["until for a foreign step rejected", () => parseStep({ click: "Next", until: "Total" }), false],
    [
      "enabled button, filled field and visibility",
      () => {
        if (enabledProblem([false], "Assign") !== null) throw new Error("enabled button not recognized");
        if (enabledProblem([true], "Assign") === null) throw new Error("disabled button taken for enabled");
        if (enabledProblem([], "Assign") === null) throw new Error("missing button taken for enabled");
        if (filledProblem(["text"]) !== null) throw new Error("filled field not recognized");
        if (filledProblem(["  "]) === null || filledProblem([]) === null) throw new Error("empty field or its absence taken for filled");
        if (seenProblem(1, "visible") !== null || seenProblem(0, "visible") === null) throw new Error("visible counts wrong");
        if (seenProblem(0, "hidden") !== null || seenProblem(2, "hidden") === null) throw new Error("hidden counts wrong");
      },
      true,
    ],
    ["click by role and name accepted", () => parseStep({ click: { role: "link", name: "Smith", contains: true } }), true],
    ["click on the first choice button accepted", () => parseStep({ click: { role: "button", pressed: false }, optional: true }), true],
    ["click with an empty object rejected", () => parseStep({ click: {} }), false],
    ["click with a foreign object key rejected", () => parseStep({ click: { name: "Smith", nth: 2 } }), false],
    ["contains without a name rejected", () => parseStep({ click: { role: "link", contains: true } }), false],
    ["fill by role and name accepted", () => parseStep({ fill: { role: "textbox", name: "Describe", contains: true }, value: "x" }), true],
    ["within for fill accepted: the field is disabled while the counterpart answers", () => parseStep({ fill: "Answer", value: "a", within: 120 }), true],
    ["within for fill above 1800 rejected", () => parseStep({ fill: "Answer", value: "a", within: 5000 }), false],
    ["within for wait with a text accepted", () => parseStep({ wait: "Document ready", within: 300 }), true],
    ["within for a numeric pause rejected", () => parseStep({ wait: 500, within: 300 }), false],
    ["within for click rejected", () => parseStep({ click: "Next", within: 5 }), false],
    ["within above 1800 rejected", () => parseStep({ wait: "Done", within: 5000 }), false],
    [
      "legacy mode: without a reason rejected; root not found - the line names the path",
      () => {
        if (legacyProblem("page without window.__agent") !== null) throw new Error("named reason rejected");
        if (legacyProblem("") === null || legacyProblem("  ") === null || legacyProblem(undefined) === null) throw new Error("key without a reason accepted");
        if (!rootlessLine("/view/abc").includes("/view/abc") || !rootlessLine("/view/abc").includes("data-state")) throw new Error("the line does not name the path and the mark");
        if (targetLabel({ role: "link", name: "Smith", contains: true }) !== "Smith") throw new Error("wrong target name");
      },
      true,
    ],
    [
      "multiline order text split into lines in order",
      () => {
        const lines = orderLines(["People\n\n0\n\nItems done", "Total · More"]);
        if (JSON.stringify(lines) !== JSON.stringify(["People", "0", "Items done", "Total", "More"])) throw new Error(`wrong lines: ${JSON.stringify(lines)}`);
        if (orderLines(["One"]).length !== 1) throw new Error("single-line text changed");
      },
      true,
    ],
    [
      "the report names the step's screen; a page without a root - screen null",
      () => {
        const on = screenMark(true, { name: "editor", state: "ready", url: "x" });
        if (on.agent !== true || on.screen?.name !== "editor" || on.screen?.state !== "ready") throw new Error("screen not named");
        const off = screenMark(true, null);
        if (off.agent !== true || off.screen !== null) throw new Error("page without a root named as a screen");
        if (screenMark(false, null).agent !== false) throw new Error("absence of window.__agent not passed");
      },
      true,
    ],
    ["upload with a path outside rejected", () => parseStep({ upload: "../../etc/passwd" }), false],
    ["to for a foreign step rejected", () => parseStep({ click: "Build", to: { selector: "input" } }), false],
    [
      "login from the environment: not set - null, set - as is, a kind outside the list and an empty secret rejected",
      () => {
        if (givenCredential({}) !== null) throw new Error("empty environment gave a login");
        const given = givenCredential({ BRAILLE_CREDENTIAL: "bearer", BRAILLE_SECRET: "t" });
        if (given.credential !== "bearer" || given.secret !== "t") throw new Error("login parsed wrong");
        if (givenCredential({ BRAILLE_CREDENTIAL: "none" }).secret !== "") throw new Error("anon without a secret rejected");
        let refused = 0;
        for (const env of [{ BRAILLE_CREDENTIAL: "basic", BRAILLE_SECRET: "t" }, { BRAILLE_CREDENTIAL: "cookie" }]) {
          try {
            givenCredential(env);
          } catch {
            refused += 1;
          }
        }
        if (refused !== 2) throw new Error("bad login accepted");
      },
      true,
    ],
    [
      "browser: default path, custom path, bundled - no path",
      () => {
        if ("executablePath" in chromeOption({})) throw new Error("wrong default path");
        if (chromeOption({ BRAILLE_CHROME: "/x/chrome" }).executablePath !== "/x/chrome") throw new Error("custom path not accepted");
        if ("executablePath" in chromeOption({ BRAILLE_CHROME: "bundled" })) throw new Error("bundled gave a path");
      },
      true,
    ],
    ["active without a text rejected", () => parseStep({ active: "" }), false],
    ["active accepted", () => parseStep({ active: "Create" }), true],
    ["disabled without a text rejected", () => parseStep({ disabled: "" }), false],
    [
      "disabled button: disabled passes; enabled and not on the page do not",
      () => {
        if (disabledProblem([true], "Next") !== null) throw new Error("disabled rejected");
        if (disabledProblem([false], "Next") === null) throw new Error("enabled accepted");
        if (disabledProblem([true, false], "Next") === null) throw new Error("one of two is enabled, but accepted");
        if (disabledProblem([], "Next") === null) throw new Error("missing accepted");
        if (clickBlockedProblem(false, "Next") === null) throw new Error("disabled click target accepted");
        if (clickBlockedProblem(true, "Next") !== null) throw new Error("enabled click target rejected");
        const api = apiFailuresLine([
          { kind: "console", message: "x" },
          { kind: "request", method: "POST", url: "http://h/api/items/extract", status: 502, code: "replay_miss" },
        ]);
        if (api !== "API: POST /api/items/extract -> 502 replay_miss") throw new Error(`API failure not named: ${api}`);
        if (apiFailuresLine([{ kind: "console", message: "x" }]) !== "") throw new Error("the line is not empty without failed requests");
      },
      true,
    ],
    ["field without has rejected", () => parseStep({ field: "Request" }), false],
    ["field accepted", () => parseStep({ field: { selector: "textarea" }, has: "summary" }), true],
    ["checked without a name rejected", () => parseStep({ checked: "" }), false],
    ["focused accepted", () => parseStep({ focused: "I accept the rules" }), true],
    [
      "field value: a text in the value passes; another text and no field do not",
      () => {
        if (fieldProblem(["Write a summary for the team"], "summary") !== null) throw new Error("correct value rejected");
        if (fieldProblem([""], "summary") === null) throw new Error("empty field accepted");
        if (fieldProblem(["Write the notes"], "summary") === null) throw new Error("foreign text accepted");
        if (fieldProblem([], "summary") === null) throw new Error("missing field accepted");
      },
      true,
    ],
    [
      "checkbox: checked, unchecked and focused are told apart; no checkbox and two checkboxes - failure",
      () => {
        const on = [{ checked: true, focused: false }];
        const off = [{ checked: false, focused: true }];
        if (tickProblem(on, "I accept", "checked") !== null) throw new Error("checked rejected");
        if (tickProblem(off, "I accept", "checked") === null) throw new Error("unchecked taken for checked");
        if (tickProblem(off, "I accept", "unchecked") !== null) throw new Error("unchecked rejected");
        if (tickProblem(on, "I accept", "unchecked") === null) throw new Error("checked taken for unchecked");
        if (tickProblem(off, "I accept", "focused") !== null) throw new Error("focus rejected");
        if (tickProblem(on, "I accept", "focused") === null) throw new Error("checkbox without focus accepted");
        for (const kind of ["checked", "unchecked", "focused"]) {
          if (tickProblem([], "I accept", kind) === null) throw new Error("missing checkbox accepted");
          if (tickProblem([...on, ...off], "I accept", kind) === null) throw new Error("two checkboxes accepted");
        }
      },
      true,
    ],
    ["optional for click accepted", () => parseStep({ click: "Not now", optional: true }), true],
    ["optional for fill accepted", () => parseStep({ fill: "Name", value: "Test", optional: true }), true],
    ["optional for press rejected", () => parseStep({ press: "Enter", optional: true }), false],
    ["optional for an expectation rejected", () => parseStep({ absent: "Office", optional: true }), false],
    ["optional for wait with a text accepted", () => parseStep({ wait: "Second question", within: 90, optional: true }), true],
    ["optional for wait with a number rejected", () => parseStep({ wait: 500, optional: true }), false],
    ["optional not true rejected", () => parseStep({ click: "Not now", optional: "yes" }), false],
    [
      "current menu item: its own passes; a foreign one, none and two do not",
      () => {
        if (activeProblem(["Create"], "Create") !== null) throw new Error("own item rejected");
        if (activeProblem(["Library"], "Create") === null) throw new Error("foreign item accepted");
        if (activeProblem([], "Create") === null) throw new Error("empty menu accepted");
        if (activeProblem(["Create", "Requests"], "Create") === null) throw new Error("two current accepted");
      },
      true,
    ],
    [
      "text order: the correct one passes, a swap and a gap do not",
      () => {
        const text = "Home\nLibrary\nReports";
        if (orderProblem(text, ["Home", "Reports"]) !== null) throw new Error("correct order rejected");
        if (orderProblem(text, ["Reports", "Home"]) === null) throw new Error("swap accepted");
        if (orderProblem(text, ["Home", "Office"]) === null) throw new Error("gap accepted");
      },
      true,
    ],
    [
      "text absence: an empty page is a failure, a found text is a failure",
      () => {
        if (absentProblem("Create", "Office") !== null) throw new Error("absence not recognized");
        if (absentProblem("", "Office") === null) throw new Error("empty page taken for absence");
        if (absentProblem("Office", "Office") === null) throw new Error("found text taken for absence");
      },
      true,
    ],
    [
      "screen in error - a failure with the screen text; ready, loading and no screen - not a failure",
      () => {
        const err = screenProblem({ testid: "screen.editor", state: "error", alerts: ["Failed to load"] });
        if (!err || !err.includes("screen.editor") || !err.includes("Failed to load")) throw new Error("error not recognized as a failure with a text");
        if (screenProblem({ testid: "screen.editor", state: "ready", alerts: [] }) !== null) throw new Error("ready taken for a failure");
        if (screenProblem({ testid: "screen.editor", state: "loading", alerts: [] }) !== null) throw new Error("loading taken for a failure");
        if (screenProblem(null) !== null) throw new Error("absence of a screen taken for a failure");
        if (!screenPending({ state: "loading" }) || screenPending({ state: "ready" }) || screenPending({ state: "empty" }) || screenPending({ state: "error" }) || screenPending(null)) {
          throw new Error("waiting for the screen to leave loading is computed wrong");
        }
      },
      true,
    ],
    [
      "a covered button - a failure naming the covering element; a free one passes",
      () => {
        const covered = { name: "Create", testid: "editor.submit", occludedBy: [{ name: "Cookies", testid: "cookie.banner", tag: "div" }] };
        const problem = occlusionProblem(covered);
        if (!problem || !problem.includes("Cookies") || !problem.includes("Create")) throw new Error("overlap without the name of the covering element");
        if (occlusionProblem({ name: "Create", occludedBy: [] }) !== null) throw new Error("free button rejected");
        if (occlusionProblem(undefined) !== null) throw new Error("no element data taken for an overlap");
      },
      true,
    ],
    [
      "order by domIndex: the correct one passes; a swap and a gap do not; the nearest occurrence after the previous one is taken",
      () => {
        if (orderProblemByHits([[3], [9]], ["Create", "Sources"]) !== null) throw new Error("correct order rejected");
        if (orderProblemByHits([[9], [3]], ["Sources", "Create"]) === null) throw new Error("swap accepted");
        if (orderProblemByHits([[3], []], ["Create", "Office"]) === null) throw new Error("gap accepted");
        if (orderProblemByHits([[3, 20], [9]], ["Create", "Sources"]) !== null) throw new Error("first occurrence of the first text not taken into account");
        if (orderProblemByHits([[30], [9]], ["A", "B"]) === null) throw new Error("B before A accepted");
        if (orderProblemByHits([[5], [5]], ["A", "B"], { 5: "A then B" }) !== null) throw new Error("order within one element rejected");
        if (orderProblemByHits([[5], [5]], ["B", "A"], { 5: "A then B" }) === null) throw new Error("swap within one element accepted");
        if (orderProblemByHits([[2], [5], [5, 30], [9]], ["Summary", "Item", "Mode", "Assigned"], { 5: "Item · Mode" }) !== null) throw new Error("continuation in the same element lost to a later occurrence");
      },
      true,
    ],
    [
      "text absence by find: no elements on a live page - passes; an empty page and a found text - failure",
      () => {
        if (absentProblemByCount(0, true, "Office") !== null) throw new Error("absence not recognized");
        if (absentProblemByCount(0, false, "Office") === null) throw new Error("empty page taken for absence");
        if (absentProblemByCount(1, true, "Office") === null) throw new Error("found text taken for absence");
      },
      true,
    ],
    [
      "failure snapshot clip: a margin around the element, at the edge it does not go negative; no box - null",
      () => {
        const clip = clipFor({ x: 100, y: 50, width: 80, height: 40 });
        if (clip.x !== 84 || clip.y !== 34 || clip.width !== 112 || clip.height !== 72) throw new Error(`wrong clip: ${JSON.stringify(clip)}`);
        const edge = clipFor({ x: 4, y: 0, width: 10, height: 10 });
        if (edge.x !== 0 || edge.y !== 0) throw new Error("the clip went past the edge");
        if (clipFor(null) !== null || clipFor({ x: 0, y: 0, width: 0, height: 10 }) !== null) throw new Error("empty clip accepted");
      },
      true,
    ],
    [
      "API records: the sample file passes the git check",
      () => parseApiRecords(fs.readFileSync(API_SAMPLE, "utf8"), "api-sample", { gitSource: true }),
      true,
    ],
    [
      "API records: the key does not depend on the host, the API root, the order of parameters and body keys; a different body gives a different key",
      () => {
        const a = apiRequestKey("post", "https://app.example.com/api/x?b=2&a=1", '{"y":1,"x":2}', "application/json");
        const b = apiRequestKey("POST", "http://localhost:8010/api/x?a=1&b=2", '{ "x": 2, "y": 1 }', "application/json");
        if (a !== b) throw new Error(`keys diverged: ${a} / ${b}`);
        if (a === apiRequestKey("POST", "https://app.example.com/api/x?a=1&b=2", '{"x":3,"y":1}', "application/json")) throw new Error("a different body gave the same key");
        const ev1 = apiRequestKey("POST", "https://x/api/a", '{"client_event_id":"2aa0d9ec-ecd3-4876-81ed-996a2a5d0001","channel":"option"}', "application/json");
        const ev2 = apiRequestKey("POST", "https://x/api/a", '{"client_event_id":"2e06daa0-fe47-4cd6-8845-576dd1ae0002","channel":"option"}', "application/json");
        if (ev1 !== ev2) throw new Error("bodies that differ only in the browser UUID gave different keys");
        if (ev1 === apiRequestKey("POST", "https://x/api/a", '{"client_event_id":"2aa0d9ec-ecd3-4876-81ed-996a2a5d0001","channel":"text"}', "application/json")) throw new Error("the UUID mark swallowed a difference in another field");
        if (apiRequestKey("GET", "https://app.example.com/assets/app.js", null) !== null) throw new Error("a non-API request taken for an API request");
        if (apiRequestKey("POST", "https://x/api/f", "--b1\r\n", "multipart/form-data; boundary=b1") !== apiRequestKey("POST", "https://x/api/f", "--b2\r\n", "multipart/form-data; boundary=b2")) throw new Error("multipart boundaries got into the key");
      },
      true,
    ],
    [
      "replay: a request from the file is answered with a record, GET repeats do not move the response, the advance step does",
      () => {
        const replay = new ApiReplay(JSON.parse(fs.readFileSync(API_SAMPLE, "utf8")));
        const me = replay.answer("GET", "https://app.example.com/api/users/me", null);
        if (!me || me.status !== 200 || JSON.parse(me.body).role !== "admin") throw new Error("the record was not served");
        const list = replay.answer("GET", "https://app.example.com/api/people?offset=0&limit=50", null);
        if (!list || JSON.parse(list.body).total !== 0) throw new Error("a request with a query in another order was not found");
        const post = replay.answer("POST", "https://app.example.com/api/people/search", '{"page":1,"name":"a"}', "application/json");
        if (!post) throw new Error("a request with a body was not found");
        const job = () => JSON.parse(replay.answer("GET", "https://app.example.com/api/jobs/1", null).body).state;
        const before = [job(), job()];
        replay.advance("/jobs/1");
        const states = [...before, job(), job()];
        if (states.join() !== "running,running,done,done") throw new Error(`repeats go wrong: ${states}`);
        if (replay.misses.length) throw new Error("requests from the file are recorded as unknown");
      },
      true,
    ],
    [
      "replay: an advance given before the record arrives applies to the state after it; series of one address go in turn; without a series - zero",
      () => {
        const get = (state) => ({ method: "GET", path: "/api/jobs/1", query: "", body: null, status: 200, content_type: "application/json", response: { state } });
        const post = { method: "POST", path: "/api/jobs", query: "", body: null, status: 200, content_type: "application/json", response: {} };
        const replay = new ApiReplay({ calls: [post, get("a1"), get("a2"), { ...post }, get("b1"), get("b2")] });
        const read = () => JSON.parse(replay.answer("GET", "https://app.example.com/api/jobs/1", null).body).state;
        if (replay.advance("/jobs/1") !== 1) throw new Error("the first series was not moved");
        if (replay.advance("/nothing") !== 0) throw new Error("an address without a series was moved");
        replay.answer("POST", "https://app.example.com/api/jobs", null);
        if (read() !== "a2") throw new Error("advance before the record was lost");
        replay.answer("POST", "https://app.example.com/api/jobs", null);
        if (read() !== "b1") throw new Error("advance carried over to the next series");
        if (replay.advance("/jobs/1") !== 1 || read() !== "b2") throw new Error("the second series was not moved");
        if (replay.advance("/jobs/1") !== 0) throw new Error("the series ran out, but advance moved something");
      },
      true,
    ],
    [
      "replay: after a cut the queues continue from the cut point of the recording, however many requests the page made before it",
      () => {
        const call = (state) => ({ method: "GET", path: "/api/state", query: "", body: "", status: 200, content_type: "application/json", response: { state } });
        const replay = new ApiReplay({ calls: [call("before"), call("before2"), call("after")], cuts: [2] });
        replay.answer("GET", "https://app.example.com/api/state", null);
        replay.cut();
        const got = JSON.parse(replay.answer("GET", "https://app.example.com/api/state", null).body).state;
        if (got !== "after") throw new Error(`after the cut got the response "${got}"`);
      },
      true,
    ],
    [
      "replay: an extra GET before a change does not eat the response taken after it (deleting a draft)",
      () => {
        const get = (state) => ({ method: "GET", path: "/api/list", query: "", body: "", status: 200, content_type: "application/json", response: { state } });
        const del = { method: "DELETE", path: "/api/item/1", query: "", body: "", status: 200, content_type: "application/json", response: {} };
        const replay = new ApiReplay({ calls: [get("before"), del, get("after")] });
        const read = () => JSON.parse(replay.answer("GET", "https://app.example.com/api/list", null).body).state;
        const seen = [read(), read()];
        if (seen.join() !== "before,before") throw new Error(`before the change got ${seen}`);
        replay.answer("DELETE", "https://app.example.com/api/item/1", null);
        if (read() !== "after") throw new Error("after the change got the response from before it");
      },
      true,
    ],
    [
      "replay: a request that is not in the file is not answered and is named by its address in the failure line",
      () => {
        const replay = new ApiReplay(JSON.parse(fs.readFileSync(API_SAMPLE, "utf8")));
        if (replay.answer("GET", "https://app.example.com/api/items?limit=5", null) !== null) throw new Error("an unknown request got a response");
        if (replay.answer("DELETE", "https://app.example.com/api/users/me", null) !== null) throw new Error("the same path with another method got a response");
        const line = missLine(replay.takeMisses());
        if (!line || !line.includes("GET /api/items?limit=5") || !line.includes("DELETE /api/users/me")) throw new Error(`the address is not in the line: ${line}`);
        if (replay.takeMisses().length) throw new Error("misses were not reset");
      },
      true,
    ],
    [
      "API records: a damaged file, a foreign name, a shared-environment source in git, empty records, a wrong status - refusal",
      () => {
        const good = JSON.parse(fs.readFileSync(API_SAMPLE, "utf8"));
        const refused = (label, text, name = "api-sample", options) => {
          try {
            parseApiRecords(typeof text === "string" ? text : JSON.stringify(text), name, options);
          } catch {
            return;
          }
          throw new Error(`accepted: ${label}`);
        };
        refused("not JSON", "{");
        refused("truncated file", JSON.stringify(good).slice(0, 200));
        refused("different file name", good, "other");
        refused("no calls", { ...good, calls: undefined });
        refused("calls empty", { ...good, calls: [] });
        refused("shared source in git", { ...good, source: "dev" }, "api-sample", { gitSource: true });
        refused("unknown source", { ...good, source: "other" });
        refused("substitutions not an object", { ...good, values: ["c1"] });
        refused("browser time not a time", { ...good, clock: "yesterday" });
        refused("manual edits not a list", { ...good, "patches": "added" });
        refused("manual edits empty", { ...good, "patches": [] });
        parseApiRecords(JSON.stringify({ ...good, "patches": ["POST answer: added by hand, the environment cannot produce it"] }), "api-sample");
        const a = { method: "POST", path: "/api/c", response: { token: "first" } };
        const b = { ...a, response: { token: "second" } };
        const poll = [{ ...a, response: 1 }, { ...a, response: 2 }];
        // The response of the second sent request (b) came first: both get it, not the one that arrived last.
        const folded = foldOverlapping([b, a, ...poll], [{ burst: 1, sent: 2 }, { burst: 1, sent: 1 }, { burst: 2, sent: 3 }, { burst: 3, sent: 4 }]);
        if (folded[0].response.token !== "second" || folded[1].response.token !== "second") throw new Error("an overlapping batch got the record of a request that was not the last one sent");
        if (folded[2].response !== 1 || folded[3].response !== 2) throw new Error("requests in turn lost their order");
        const miss = serverFailureLine([{ ...a, status: 200 }, { ...a, status: 502, response: { detail: { code: "replay_miss" } } }]);
        if (!miss || !miss.includes("502 replay_miss")) throw new Error("a 5xx failure in the records is not named");
        if (serverFailureLine([{ ...a, status: 404 }]) !== null) throw new Error("4xx taken for a backend failure");
        refused("substitution is an object", { ...good, values: { item_id: { id: 1 } } });
        parseApiRecords(JSON.stringify({ ...good, values: { item_id: "c1", step: 2 } }), "api-sample");
        refused("record without a response", { ...good, calls: [{ ...good.calls[0], response: undefined }] });
        refused("status is not a code", { ...good, calls: [{ ...good.calls[0], status: "200" }] });
        refused("path is not an API path", { ...good, calls: [{ ...good.calls[0], path: "/assets/app.js" }] });
        refused("query not reduced", { ...good, calls: [{ ...good.calls[1], query: "offset=0&limit=50" }] });
        parseApiRecords(JSON.stringify({ ...good, source: "dev" }), "api-sample");
      },
      true,
    ],
    [
      "API records: requests without a response by the end of the run - refusal with the address; none - no refusal",
      () => {
        if (pendingLine([]) !== null) throw new Error("an empty list was refused");
        const line = pendingLine(["GET /api/items/drafts"]);
        if (!line || !line.includes("GET /api/items/drafts")) throw new Error("the address is not in the line");
      },
      true,
    ],
    [
      "API records: a caught pair is read by replay; a login secret in the response - the record is refused",
      () => {
        const call = recordedCall("GET", "https://app.example.com/api/ping?z=1&a=2", null, "", 200, "application/json; charset=utf-8", '{"ok":true}');
        const meta = { scenario: "x", source: "dev" };
        const doc = apiDocument(meta, [call], ["a-secret-token-123"]);
        const answer = new ApiReplay(doc).answer("GET", "https://app.example.com/api/ping?a=2&z=1", null);
        if (!answer || JSON.parse(answer.body).ok !== true) throw new Error("the recorded pair is not answered");
        if (recordedCall("GET", "https://app.example.com/assets/a.js", null, "", 200, "text/javascript", "x") !== null) throw new Error("a non-API request recorded");
        const leak = recordedCall("GET", "https://app.example.com/api/login", null, "", 200, "application/json", '{"note":"a-secret-token-123"}');
        try {
          apiDocument(meta, [leak], ["a-secret-token-123"]);
        } catch {
          return;
        }
        throw new Error("a secret in the response accepted");
      },
      true,
    ],
    [
      "failed step evidence: all required fields non-empty, limits kept",
      () => {
        const long = "line ".repeat(2000);
        const evidence = buildEvidence({
          url: "https://app.example.com/app/page?x=1#h",
          title: "Dashboard",
          text: long,
          console: Array.from({ length: 50 }, (_, i) => `error message ${i}`),
          pageerrors: ["TypeError: x is undefined"],
          requests: [{ method: "GET", path: "/api/me?token=abc", status: 502, ms: 1200 }, { method: "GET", path: "/assets/chunk.js", status: "net::ERR_FAILED", ms: 900 }],
          screenshot: "tmp/screen-runs/s/03-click.page.png",
          load: { readyState: "complete", root: "div#root, descendants 0", agent: false, scripts: 3, chunkErrors: ["GET /assets/chunk.js -> net::ERR_FAILED"] },
        });
        const problems = evidenceProblems(evidence);
        if (problems.length) throw new Error(`a complete composition was found incomplete: ${problems.join("; ")}`);
        if (evidence.url.includes("?") || evidence.url.includes("#")) throw new Error("the query string stayed in the address");
        if (evidence.requests[0].path.includes("?")) throw new Error("the query string stayed in the request path");
        if (evidence.text.length > EVIDENCE.limits.text) throw new Error("the text was not trimmed");
        if (evidence.console.length > EVIDENCE.limits.console) throw new Error("the console was not trimmed");
        if (evidence.requests[0].status !== 502 || evidence.requests[1].status !== "net::ERR_FAILED") throw new Error("the request status was lost");
      },
      true,
    ],
    [
      "evidence: an empty page without a snapshot and a load state is found incomplete (must turn red)",
      () => {
        const problems = evidenceProblems(buildEvidence({}));
        if (problems.length === 0) throw new Error("empty evidence found complete");
      },
      true,
    ],
    [
      "evidence: a failure with no evidence at all is incomplete",
      () => {
        if (evidenceProblems(null).length === 0 || evidenceProblems({}).length === 0) throw new Error("the absence of evidence accepted");
      },
      true,
    ],
    [
      "masking: the login token, JWT, Bearer, key=value pairs and long tokens do not reach the evidence",
      () => {
        const secret = "sekret-token-value-12345";
        const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEFghiJKL";
        const evidence = buildEvidence(
          {
            url: `https://app.example.com/x?auth_token=${secret}`,
            title: "t",
            text: `You are signed in. token: ${secret}. Authorization: Bearer abcdef1234567890xyz. ${jwt}. key ${"A1b2C3d4".repeat(5)}`,
            console: [`error fetch failed password=hunter2hunter2 ${secret}`],
            pageerrors: [],
            requests: [{ method: "GET", path: `/api/me/${secret}`, status: 401, ms: 5 }],
            screenshot: "tmp/x.png",
            load: { readyState: "complete", root: "r", agent: true, scripts: 1, chunkErrors: [] },
          },
          [secret],
        );
        const dump = JSON.stringify(evidence);
        for (const leaked of [secret, jwt, "abcdef1234567890xyz", "hunter2hunter2", "A1b2C3d4".repeat(5)]) {
          if (dump.includes(leaked)) throw new Error(`a secret stayed in the evidence: ${leaked.slice(0, 12)}…`);
        }
        if (!dump.includes("You are signed in")) throw new Error("the mask swallowed ordinary text");
      },
      true,
    ],
    [
      "chunk load errors are recognized, an ordinary console error is not",
      () => {
        if (!isChunkError("Failed to fetch dynamically imported module: https://x/assets/a.js")) throw new Error("chunk not recognized");
        if (!isChunkError("Loading chunk 12 failed")) throw new Error("ChunkLoadError not recognized");
        if (isChunkError("TypeError: x is not a function")) throw new Error("an ordinary error taken for a chunk");
      },
      true,
    ],
    [
      "step timeout names the wait, the deadline and the screen by Braille; another error is left alone",
      () => {
        const evidence = buildEvidence({ load: { agent: true }, screen: { testid: "screen.dashboard", state: "ready", overlays: [], facts: { tab: "items" }, alerts: [] }, busy: { requests: 1 } });
        const got = timeoutReason("page.waitForFunction: Timeout 60000ms exceeded. — API: GET /x -> 404", { kind: "wait", target: "Items 1" }, evidence);
        if (!got.startsWith("wait \"Items 1\" did not come true within 60 s; screen screen.dashboard data-state=ready")) throw new Error(got);
        if (!got.includes("facts: tab=items") || !got.includes("busy: requests=1") || !got.endsWith("API: GET /x -> 404")) throw new Error(got);
        if (timeoutReason("no button", { kind: "click", target: "x" }, evidence) !== "no button") throw new Error("a non-timeout error was rewritten");
        if (!timeoutReason("Timeout 15000ms exceeded.", { kind: "click", target: "x" }, buildEvidence({ load: { agent: false } })).includes("no window.__agent")) throw new Error("a page without __agent not named");
        const off = buildEvidence({ load: { agent: true }, screen: { testid: "screen.q", state: "ready" }, target: [{ role: "button", name: "Submit answer", testid: null, disabled: true, inViewport: true, occludedBy: [] }] });
        if (!timeoutReason("Timeout 15000ms exceeded.", { kind: "click", target: "Submit answer" }, off).includes("target: button \"Submit answer\", disabled")) throw new Error("a disabled target not named");
        const none = buildEvidence({ load: { agent: true }, screen: { testid: "screen.q", state: "ready" }, target: [] });
        if (!timeoutReason("Timeout 15000ms exceeded.", { kind: "click", target: "x" }, none).includes("target: none on the screen")) throw new Error("the absence of a target not named");
      },
      true,
    ],
  ];
  let bad = 0;
  for (const [name, run, shouldPass] of cases) {
    let passed = true;
    try {
      run();
    } catch {
      passed = false;
    }
    const ok = passed === shouldPass;
    if (!ok) bad += 1;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  }
  process.exit(bad ? 1 : 0);
}

/** The reason legacy mode is on (`--legacy`); null means agent mode. */
let legacyReason = null;

/** Paths where no `screen.*` root was found; readiness waits are short on them. */
const rootlessPaths = new Set();

/** The page path without a screen root at the current step; null means there is a root or the mode is not agent mode. */
let stepRootless = null;

/** A report line about a page without a `data-state` root. */
export function rootlessLine(pathname) {
  return `NO ROOT: no screen.<name> with data-state on ${pathname} - readiness by fallback signs (needs markup in the frontend)`;
}

/** Whether the page has `window.__agent`; legacy mode does not use it even if present. */
async function agentPresent(page) {
  if (legacyReason !== null) return false;
  return page.evaluate(() => typeof window.__agent === "object" && window.__agent !== null).catch(() => false);
}

async function agentScreen(page) {
  return page.evaluate(() => window.__agent.screen()).catch(() => null);
}

/**
 * What the report knows about the screen after a step: whether there is `window.__agent` and a `screen.<name>` root.
 */
export function screenMark(agent, screen) {
  return { agent, screen: screen ? { name: screen.name, state: screen.state } : null };
}

async function agentFind(page, query) {
  return page.evaluate((q) => window.__agent.find(q), query).catch(() => []);
}

/** Texts a person sees: hidden ones (a closed select list) have a zero box. */
async function agentFindShown(page, query) {
  return (await agentFind(page, query)).filter((e) => !e.rect || (e.rect.w > 0 && e.rect.h > 0));
}

/**
 * Readiness by the `data-state` of the screen root. Returns true if the page has
 * a screen and it has settled; false - there is no root (the page is not instrumented), and the
 * previous wait applies. A screen in error is a step failure with the screen text.
 */
async function agentSettle(page, appearMs = SCREEN_APPEAR_TIMEOUT_MS) {
  const appeared =
    appearMs > 0
      ? await page
          .waitForFunction(() => window.__agent.screen() !== null, null, { timeout: appearMs, polling: 100 })
          .then(() => true, () => false)
      : (await agentScreen(page)) !== null;
  if (!appeared) return false;
  await page
    .waitForFunction(
      (ready) => {
        const screen = window.__agent.screen();
        return screen === null || ready.includes(screen.state) || screen.state === "error";
      },
      READY_STATES,
      { timeout: SCREEN_READY_TIMEOUT_MS, polling: 100 },
    )
    .catch(() => {});
  const problem = screenProblem(await agentScreen(page));
  if (problem) throw new Error(problem);
  return true;
}

/**
 * Rest by `__agent.busy()`: the page names its unfinished work itself (navigation, load,
 * submission, animation). Empty on two polls in a row - rest; a build without `busy` - at once.
 */
async function agentIdle(page) {
  await page
    .waitForFunction(
      () => {
        const busy = typeof window.__agent?.busy === "function" ? window.__agent.busy() : {};
        const idle = Object.keys(busy).length === 0;
        window.__agentIdleStreak = idle ? (window.__agentIdleStreak ?? 0) + 1 : 0;
        return window.__agentIdleStreak >= 2;
      },
      null,
      { timeout: SCREEN_READY_TIMEOUT_MS, polling: 100 },
    )
    .catch(() => {});
  await page.evaluate(() => { window.__agentIdleStreak = 0; }).catch(() => {});
}

async function settle(page) {
  const agent = await agentPresent(page);
  if (agent) {
    await agentIdle(page);
    const here = new URL(page.url()).pathname;
    if (await agentSettle(page, rootlessPaths.has(here) ? 0 : SCREEN_APPEAR_TIMEOUT_MS)) {
      rootlessPaths.delete(here);
      return;
    }
    rootlessPaths.add(here);
    stepRootless = here;
  }
  // The SPA polls statuses constantly, `networkidle` never comes. A page without a screen root
  // has no readiness sign - a pause; shorter in agent mode: step waits poll by themselves.
  await page.waitForTimeout(agent ? ROOTLESS_PAUSE_MS : 1200);
}

/** A pause after a step on a page without a `data-state` root. */
const ROOTLESS_PAUSE_MS = 500;

// An element with a role wins over a text with the same spelling: a caption in a card comes in the
// markup before an item of an open menu and otherwise intercepts the click: a list row would go red when its rows get a caption.
const ROLE_FIRST_TIMEOUT_MS = 1500;

/** The time within which a testid element must appear before the step names a reason. */
const TESTID_APPEAR_MS = 15000;

/** An element by testid; with name/item - the one whose name matched. None - a failure with the reason from `labelProblem`. */
async function locateTestid(page, target, timeoutMs = TESTID_APPEAR_MS) {
  const all = page.getByTestId(target.testid);
  const deadline = Date.now() + timeoutMs;
  let problem;
  do {
    const infos = (await agentPresent(page)) ? await agentFindShown(page, { testid: target.testid }) : [];
    problem = (await agentPresent(page)) ? labelProblem(infos, target) : (await all.filter({ visible: true }).count()) ? null : `element ${target.testid} is not on the page`;
    if (!problem) break;
    await page.waitForTimeout(200);
  } while (Date.now() < deadline);
  if (problem) throw new Error(problem);
  const wanted = target.name ?? target.item;
  // A zero-size field (a chip component) is clicked by its caption - its box is what window.__agent returns.
  const label = page.locator(`[data-testid="${target.testid}"] + label, label:has(> [data-testid="${target.testid}"])`);
  if (!wanted) return all.filter({ visible: true }).or(label.filter({ visible: true })).first();
  // `name` is the exact label, `item` is a name or text that contains the data; `pickByTestid` selects the same way.
  const byName = TESTID_ROLES.map((role) => page.getByRole(role, { name: wanted, exact: Boolean(target.name) })).reduce((acc, next) => acc.or(next));
  const picked = all.and(byName);
  // a testid on a caption without a role (a segmented control: a span in a label) - by exact text; the label was already checked by labelProblem.
  const exact = new RegExp(`^\\s*${wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
  const found = picked.or(all.filter({ hasText: target.item ? wanted : exact }));
  // A zero-size checkbox with name has the same caption (one testid, the label was already checked).
  return (target.name ? found.or(label) : found).filter({ visible: true }).first();
}

/** Roles by which a testid target is checked against name/item. */
const TESTID_ROLES = ["button", "link", "tab", "menuitem", "option", "checkbox", "radio", "switch", "textbox", "combobox"];

/** Roles that `observe` returns by label (`labels`) when the element has no testid by the scheme. */
const LABEL_ROLES = ["button", "link", "tab", "menuitem", "checkbox", "radio", "switch"];
async function locate(page, target) {
  if (testidTarget(target)) return locateTestid(page, target);
  if (typeof target === "object" && "selector" in target) return page.locator(target.selector).first();
  if (typeof target === "object") return namedLocator(page, target);
  // option, combobox, textbox - choosing from a dropdown: click the field by name,
  // then the item by name (required fields of a form).
  const byRole = ["button", "link", "tab", "menuitem", "option", "combobox", "textbox", "checkbox", "radio", "switch"]
    .map((role) => page.getByRole(role, { name: target, exact: true }))
    .reduce((acc, next) => acc.or(next));
  const hasRole = await byRole
    .first()
    .waitFor({ state: "visible", timeout: ROLE_FIRST_TIMEOUT_MS })
    .then(() => true, () => false);
  if (hasRole) return byRole.first();
  // A hidden input (a switch component) comes in the markup before its caption: the visible element is taken.
  return byRole.or(page.getByText(target, { exact: true })).filter({ visible: true }).first();
}

/** An element by role and name (`contains` - the name as a substring) or the first choice button without a mark. */
function namedLocator(page, target) {
  if ("pressed" in target) {
    return page.getByRole(target.role ?? "button").and(page.locator('[aria-pressed="false"]')).first();
  }
  const roles = target.role ? [target.role] : ["button", "link", "tab", "menuitem", "option", "combobox", "textbox", "checkbox", "radio", "switch"];
  return roles
    .map((role) => page.getByRole(role, { name: target.name, exact: target.contains !== true }))
    .reduce((acc, next) => acc.or(next))
    .first();
}

/** The run state shared by steps: tabs, the page request log, cut responses. One tab until the tab step opens a second. */
const session = { context: null, pages: [], current: 0, requests: [], navigations: [], cuts: [], watch: () => {} };
const REQUESTED_SETTLE_MS = 1500;

/** How many page requests end with `suffix` (a path); `method` - only with this method. */
export function requestCount(requests, suffix, method) {
  return requests.filter((r) => r.path.endsWith(suffix) && (!method || r.method === method)).length;
}

/** Why the request count is wrong; null means as expected. Without `times` at least one is expected, with `times` exactly that many. */
export function requestedProblem(count, times, suffix) {
  if (times === undefined) return count >= 1 ? null : `no requests for "${suffix}"`;
  return count === times ? null : `requests for "${suffix}": ${count}, expected ${times}`;
}

/** The tab the steps run on. A second one can be opened once. */
async function switchTab(base, page, action) {
  if (action === "open") {
    if (session.pages.length > 1) throw new Error("the second tab is already open");
    const next = await session.context.newPage();
    session.watch(next);
    const here = new URL(page.url());
    await perform(next, base, { kind: "goto", target: here.pathname + here.search });
    session.pages.push(next);
    session.current = 1;
    return;
  }
  const index = action === "first" ? 0 : 1;
  if (!session.pages[index]) throw new Error(`tab "${action}" does not exist: first {"tab": "open"}`);
  session.current = index;
  await session.pages[index].bringToFront();
}

/** What is visible after a step: the screen (`{name, state}` or null) and the visible testids of the form `<area>.<action>`. */
async function observe(page) {
  if (!(await agentPresent(page))) return { screen: null, testids: [], elements: [] };
  const screen = await agentScreen(page);
  const all = await agentFindShown(page, {});
  const shown = all.filter((e) => e.testid && RE_TESTID.test(e.testid) && !e.testid.startsWith("screen."));
  // Input fields do not get a testid (testids are on buttons); the model types by the field caption: {"fill": "<caption>"}.
  const fields = all.filter((e) => !e.testid && FIELD_ROLES.includes(e.role) && String(e.name ?? "").trim());
  // Items of an open list are data (a person's name, an item name): they have no testid, they are chosen by name
  // {"click": {"role": "option", "name": "{substitution}", "contains": true}}. Headings - where the model is.
  const text = (e) => String(e.name || e.text || "").trim().slice(0, 80);
  const options = all.filter((e) => !e.testid && e.role === "option" && text(e));
  // Buttons and links without a testid by the scheme (screens not yet instrumented, old-style testids): by label - otherwise the model
  // sees an empty screen (a button of a dialog was missing from the answer).
  const labels = all.filter((e) => !(e.testid && RE_TESTID.test(e.testid)) && LABEL_ROLES.includes(e.role) && text(e));
  const headings = all.filter((e) => e.role === "heading").map(text).filter(Boolean);
  return {
    screen: screen ? { name: screen.name, state: screen.state } : null,
    testids: [...new Set(shown.map((e) => e.testid))],
    elements: shown.map((e) => ({ testid: e.testid, role: e.role, name: String(e.name ?? "").slice(0, 80), ...(e.aria?.disabled ? { disabled: true } : {}) })),
    fields: [...new Map(fields.map((e) => [String(e.name).trim(), { field: String(e.name).trim().slice(0, 80), role: e.role, ...(e.aria?.disabled ? { disabled: true } : {}) }])).values()],
    ...(options.length ? { options: [...new Set(options.map(text))].slice(0, 30) } : {}),
    ...(labels.length ? { labels: [...new Map(labels.map((e) => [text(e), { label: text(e), role: e.role, ...(e.aria?.disabled ? { disabled: true } : {}) }])).values()].slice(0, 30) } : {}),
    ...(headings.length ? { headings: [...new Set(headings)].slice(0, 10) } : {}),
    // Layers on top of the screen (a dialog, an open list): a click under them will be covered.
    ...(screen?.overlays?.length ? { overlays: screen.overlays } : {}),
    ...(screen?.facts && Object.keys(screen.facts).length ? { facts: screen.facts } : {}),
  };
}

/** Waits for the step's `after`; if it does not occur in time - a failure of this step with what is visible instead. */
async function awaitAfter(page, after) {
  if (!(await agentPresent(page))) throw new Error("after requires window.__agent: legacy mode (--legacy) does not check it");
  const deadline = Date.now() + after.within * 1000;
  let problem;
  do {
    const seen = await observe(page);
    problem = afterProblem(after, seen);
    if (!problem) return;
    if (seen.screen?.state === "error") break;
    await page.waitForTimeout(200);
  } while (Date.now() < deadline);
  throw new Error(problem);
}

/** The step is skipped: the optional target is not on the page. `after` of such a step is not checked. */
const SKIPPED = "skipped";

async function perform(page, base, step) {
  const outcome = await performStep(page, base, step);
  if (step.after && outcome !== SKIPPED) await awaitAfter(session.pages[session.current] ?? page, step.after);
  return outcome;
}

async function performStep(page, base, rawStep) {
  // The `within` deadlines are meant for a live model; during replay the response is there at once, and a red step must not wait for minutes.
  const step = session.replay && rawStep.within > REPLAY_WITHIN_S ? { ...rawStep, within: REPLAY_WITHIN_S } : rawStep;
  const { kind, target, value } = step;
  if (kind === "goto") {
    await page.goto(base + target, { waitUntil: "domcontentloaded" });
    // The agent object is installed after the module loads; a build without the flag does not install it at all.
    if (legacyReason === null) {
      const waitAgent = () => page.waitForFunction(() => window.__agent, null, { timeout: AGENT_APPEAR_TIMEOUT_MS }).then(() => true, () => false);
      // A page sometimes loads without the agent object;
      // one repeated visit tells a load failure from a build without the flag - such a build has no object after it either.
      const appeared = (await waitAgent()) || (await page.goto(base + target, { waitUntil: "domcontentloaded" }).then(waitAgent, () => false));
      if (!appeared) {
        throw new Error(`no window.__agent on page ${target}: a frontend build without VITE_AGENT_API=1; legacy mode - the --legacy "reason" key`);
      }
    }
  } else if (kind === "click") {
    if (step.optional && testidTarget(target)) {
      const found = await locateTestid(page, target, OPTIONAL_TIMEOUT_MS).catch(() => null);
      if (!found) return SKIPPED;
    }
    const element = await locate(page, target);
    if (step.optional) {
      const present = await element
        .waitFor({ state: "visible", timeout: OPTIONAL_TIMEOUT_MS })
        .then(() => true, () => false);
      if (!present) return SKIPPED;
    }
    failTarget = { locator: element };
    if (await agentPresent(page)) {
      await element.waitFor({ state: "visible", timeout: 15000 });
      const enabled = await page
        .waitForFunction((el) => el && !el.disabled && el.getAttribute("aria-disabled") !== "true", await element.elementHandle(), {
          timeout: DISABLED_GRACE_MS,
          polling: 100,
        })
        .then(() => true, () => false);
      const blocked = clickBlockedProblem(enabled, targetLabel(target));
      if (blocked) throw new Error(blocked);
      await assertNotOccluded(page, element, target);
    }
    // The accessible name of a multi-select field sits on the inner input, and on top
    // it is covered by a wrapper of the same field: a person clicks the wrapper, Playwright waits for
    // the input and fails on "intercepts pointer events".
    // An ancestor of the target itself - click at the same point as a person; a foreign element on top
    // is still a failure.
    // The same with the selected chips of the field: they lie inside the same wrapper over the
    // input. Then - a free point of the wrapper where the field itself is on top.
    const coverPoint = await element
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        const top = document.elementFromPoint(cx, cy);
        if (!top || top === el || el.contains(top)) return null;
        if (top.contains(el)) return { x: cx, y: cy };
        const field = el.parentElement?.closest('[class*="Input-input"], [class*="MultiSelect-input"], [class*="PillsInput"]');
        if (!field || !field.contains(top)) return null;
        const box = field.getBoundingClientRect();
        for (let x = box.right - 6; x > box.left; x -= 12) {
          const hit = document.elementFromPoint(x, box.y + box.height / 2);
          if (hit && field.contains(hit) && !hit.closest('[class*="Pill"]')) return { x, y: box.y + box.height / 2 };
        }
        return null;
      })
      .catch(() => null);
    if (coverPoint) await page.mouse.click(coverPoint.x, coverPoint.y);
    else await element.click({ timeout: 15000 });
  } else if (kind === "fill") {
    // The field - by role and exact name, as window.__agent.find() sees it; the caption
    // and the hint are the fallback path. getByLabel once failed to find a wizard
    // field that find() reported as a textbox with the same name.
    const field =
      testidTarget(target)
        ? await locateTestid(page, target, step.optional ? OPTIONAL_TIMEOUT_MS : TESTID_APPEAR_MS).catch((error) => {
            if (step.optional) return null;
            throw error;
          })
        : typeof target === "object"
        ? "selector" in target
          ? page.locator(target.selector).first()
          : namedLocator(page, target)
        : await (async () => {
            // A caption by substring (getByLabel) also catches a button "Hint: <name>" before the field itself:
            // it is the fallback path, used when there is no field with such a name and role.
            const byRole = page
              .getByRole("textbox", { name: target, exact: true })
              .or(page.getByRole("combobox", { name: target, exact: true }))
              .or(page.getByRole("spinbutton", { name: target, exact: true }));
            const found = await byRole.first().waitFor({ state: "attached", timeout: ROLE_FIRST_TIMEOUT_MS }).then(() => true, () => false);
            return found ? byRole.first() : page.getByLabel(target).or(page.getByPlaceholder(target)).first();
          })();
    if (!field) return SKIPPED;
    if (step.optional) {
      const present = await field.waitFor({ state: "visible", timeout: OPTIONAL_TIMEOUT_MS }).then(() => true, () => false);
      if (!present) return SKIPPED;
    }
    await field.fill(value, { timeout: (step.within ?? 15) * 1000 });
  } else if (kind === "press") {
    await page.keyboard.press(target);
  } else if (kind === "download") {
    const element = await locate(page, target);
    const [file] = await Promise.all([
      page.waitForEvent("download", { timeout: WAIT_TEXT_S * 1000 }),
      element.click({ timeout: 15000 }),
    ]);
    const title = await page.locator(step.named.selector).first().innerText({ timeout: 15000 });
    const problem = downloadNameProblem(file.suggestedFilename(), title);
    if (problem) throw new Error(problem);
  } else if (kind === "described") {
    // The description is what a screen reader reads: the text of the elements pointed to by the field's aria-describedby.
    const fields = page
      .getByRole("textbox", { name: target, exact: true })
      .or(page.getByRole("combobox", { name: target, exact: true }))
      .or(page.getByRole("spinbutton", { name: target, exact: true }));
    const deadline = Date.now() + EXPECT_TIMEOUT_MS;
    let problem;
    do {
      await settle(page);
      const seen = await fields
        .evaluateAll((nodes) =>
          nodes.map((n) =>
            (n.getAttribute("aria-describedby") || "")
              .split(/\s+/)
              .filter(Boolean)
              .map((id) => document.getElementById(id)?.textContent ?? "")
              .join(" "),
          ),
        )
        .catch(() => []);
      problem = describedProblem(seen, step.has);
    } while (problem && Date.now() < deadline);
    if (problem) throw new Error(problem);
    return;
  } else if (kind === "hover") {
    await (await locate(page, target)).hover({ timeout: 15000 });
  } else if (kind === "repeat") {
    const reached = async () => (await page.locator("body").innerText().catch(() => "")).includes(step.until);
    for (let turn = 0; turn < step.max; turn += 1) {
      if (await reached()) return;
      for (const inner of target) await perform(page, base, inner);
      await settle(page);
    }
    if (!(await reached())) throw new Error(`text "${step.until}" is absent after ${step.max} repeats`);
  } else if (kind === "same-href") {
    const deadline = Date.now() + EXPECT_TIMEOUT_MS;
    let problem;
    do {
      const hrefs = [];
      for (const selector of target) {
        hrefs.push(await page.locator(selector).first().getAttribute("href", { timeout: EXPECT_TIMEOUT_MS }).catch(() => null));
      }
      problem = sameHrefProblem(hrefs[0], hrefs[1]);
      if (problem) await page.waitForTimeout(500);
    } while (problem && Date.now() < deadline);
    if (problem) throw new Error(problem);
  } else if (kind === "hold") {
    await page.route((url) => url.pathname.includes(target), async (route) => {
      await new Promise((resolve) => setTimeout(resolve, step.ms));
      // fallback, not continue: when responses are replaced (--replay-api) the request goes on to the replay, not past it into the network.
      await route.fallback().catch(() => {});
    });
  } else if (kind === "cut") {
    session.cuts.push({ suffix: target, used: false });
  } else if (kind === "advance") {
    if (session.replay && !session.replay.advance(target)) throw new Error(`advance ${target}: the records have no GET with this address that changes the response`);
  } else if (kind === "tab") {
    await switchTab(base, page, target);
  } else if (kind === "visibility") {
    await page.evaluate((value) => {
      const hidden = value === "hidden";
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
      document.dispatchEvent(new Event("visibilitychange"));
    }, target);
  } else if (kind === "requested") {
    const deadline = Date.now() + EXPECT_TIMEOUT_MS;
    let problem;
    do {
      problem = requestedProblem(requestCount(session.requests, target, step.method), step.times, target);
      if (problem) await page.waitForTimeout(250);
    } while (problem && Date.now() < deadline);
    // The required number is reached: one more moment for an extra request, otherwise "exactly this many" would be confirmed too early.
    if (!problem && step.times !== undefined) {
      await page.waitForTimeout(REQUESTED_SETTLE_MS);
      problem = requestedProblem(requestCount(session.requests, target, step.method), step.times, target);
    }
    if (problem) throw new Error(problem);
  } else if (kind === "upload") {
    const file = path.join(UPLOAD_DIR, target);
    if (!fs.existsSync(file)) throw new Error(`file ${target} is not in the scenario files directory`);
    await page.locator(step.to ? step.to.selector : UPLOAD_DEFAULT).first().setInputFiles(file, { timeout: 15000 });
  } else if (AGENT_KINDS.includes(kind) && agentTarget(step) && (await agentPresent(page))) {
    await expectViaAgent(page, step);
    return;
  } else if (TICK_KINDS.includes(kind) && testidTarget(target)) {
    // In checkbox/radio components the testid is on the input; on the wrapper - the nested input is taken; in a segmented control
    // the testid is on a caption inside a label, and the radio is next to it - the field of this label is taken.
    const element = await locateTestid(page, target);
    const deadline = Date.now() + EXPECT_TIMEOUT_MS;
    let problem;
    do {
      const tick = await element
        .evaluate((el) => {
          const input = el.matches("input")
            ? el
            : (el.querySelector("input[type=checkbox], input[type=radio]") ?? el.closest("label")?.control ?? null);
          return input ? { checked: input.checked === true, focused: input === document.activeElement } : null;
        })
        .catch(() => null);
      problem = tickProblem(tick ? [tick] : [], targetLabel(target), kind);
      if (problem) await page.waitForTimeout(200);
    } while (problem && Date.now() < deadline);
    if (problem) throw new Error(problem);
    return;
  } else if (kind === "wait" && testidTarget(target)) {
    // Polling find(): a visible element with the testid (and the label, if named); a screen in error aborts the wait.
    const deadline = Date.now() + (step.within ?? WAIT_TEXT_S) * 1000;
    let problem;
    do {
      if (!(await agentPresent(page))) {
        problem = (await page.getByTestId(target.testid).filter({ visible: true }).count()) ? null : `element ${target.testid} is not on the page`;
      } else {
        problem = labelProblem(await agentFindShown(page, { testid: target.testid }), target);
        if (problem && (await agentScreen(page))?.state === "error") {
          throw new Error(screenProblem(await agentScreen(page)) ?? problem);
        }
      }
      if (problem) await page.waitForTimeout(250);
    } while (problem && Date.now() < deadline);
    if (problem && step.optional) return SKIPPED;
    if (problem) throw new Error(problem);
  } else if (kind === "fact") {
    // A screen fact (`data-fact` in the frontend): mode, step number - what is not visible from the elements.
    if (!(await agentPresent(page))) throw new Error("fact requires window.__agent");
    const deadline = Date.now() + EXPECT_TIMEOUT_MS;
    let problem;
    do {
      await settle(page);
      const facts = (await agentScreen(page))?.facts ?? {};
      const wrong = Object.entries(target).filter(([name, value]) => facts[name] !== value);
      problem = wrong.length
        ? `screen fact: expected ${wrong.map(([n, v]) => `${n}=${v}`).join(", ")}, but the screen has ${JSON.stringify(facts)}`
        : null;
      if (problem) await page.waitForTimeout(250);
    } while (problem && Date.now() < deadline);
    if (problem) throw new Error(problem);
    return;
  } else if (["order", "absent", "active", "disabled", "enabled", "field", "filled", ...SEEN_KINDS, ...TICK_KINDS].includes(kind)) {
    if (testidTarget(target) || (Array.isArray(target) && target.some(testidTarget))) {
      throw new Error(`${kind} with {"testid": …} requires window.__agent: legacy mode (--legacy) cannot check this`);
    }
    const problemOf = {
      order: orderProblem, absent: absentProblem, active: activeProblem, disabled: disabledProblem,
      field: (values) => fieldProblem(values, step.has),
      enabled: enabledProblem, filled: filledProblem,
      visible: (count) => seenProblem(count, "visible"), hidden: (count) => seenProblem(count, "hidden"),
      ...Object.fromEntries(TICK_KINDS.map((tick) => [tick, (ticks, item) => tickProblem(ticks, item, tick)])),
    }[kind];
    const deadline = Date.now() + EXPECT_TIMEOUT_MS;
    let problem;
    do {
      await settle(page);
      const seen =
        kind === "active"
          ? await page
              .locator('nav [aria-current="page"], aside [aria-current="page"]')
              .evaluateAll((nodes) => nodes.map((n) => (n.innerText || n.getAttribute("aria-label") || "").trim()))
              .catch(() => [])
          : SEEN_KINDS.includes(kind)
            ? await page
                .locator(target.selector)
                .evaluateAll((nodes) => nodes.filter((n) => (n.checkVisibility ? n.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : n.offsetParent !== null)).length)
                .catch(() => 0)
          : kind === "field" || kind === "filled"
            ? await (typeof target === "object" ? page.locator(target.selector) : page.getByLabel(target).or(page.getByPlaceholder(target)))
                .evaluateAll((nodes) => nodes.map((n) => String(n.value ?? "")))
                .catch(() => [])
          : TICK_KINDS.includes(kind)
            ? await page
                .getByRole("checkbox", { name: target })
                .or(page.getByRole("radio", { name: target }))
                .evaluateAll((nodes) => nodes.map((n) => ({ checked: n.checked === true, focused: n === document.activeElement })))
                .catch(() => [])
          : kind === "disabled" || kind === "enabled"
            ? await page
                .getByRole("button", { name: target, exact: true })
                .evaluateAll((nodes) => nodes.map((n) => n.disabled === true || n.getAttribute("aria-disabled") === "true" || n.hasAttribute("data-disabled")))
                .catch(() => [])
            : await page.locator("body").innerText().catch(() => "");
      problem = problemOf(seen, target);
      // "No text" on a fully rendered page is an answer at once; "present" and "empty" are rechecked until the deadline.
    } while (problem && Date.now() < deadline);
    if (problem) throw new Error(problem);
    return;
  } else if (typeof target === "number") {
    await page.waitForTimeout(target);
  } else if (await agentPresent(page)) {
    // We wait for the text, but a screen in error aborts the wait: nothing to wait for.
    const came = await page.waitForFunction(
      (text) => document.body.textContent.toLowerCase().includes(text.toLowerCase()) || window.__agent?.screen()?.state === "error",
      target,
      { timeout: (step.within ?? WAIT_TEXT_S) * 1000 },
    ).then(() => true, (error) => {
      if (step.optional) return false;
      throw error;
    });
    if (!came) return;
    const has = await page.evaluate((text) => document.body.textContent.toLowerCase().includes(text.toLowerCase()), target);
    const problem = has ? null : screenProblem(await agentScreen(page));
    if (problem) throw new Error(problem);
  } else {
    const came = await page.getByText(target).first().waitFor({ timeout: (step.within ?? WAIT_TEXT_S) * 1000 }).then(() => true, (error) => {
      if (step.optional) return false;
      throw error;
    });
    if (!came) return;
  }
  await settle(page);
}

/** Which element is named in the step failure: `{locator}` or `{rect}` from `find()`; the snapshot is cut by it. */
let failTarget = null;

/** Steps that read `find()` rather than the page text when `window.__agent` is present. */
const AGENT_KINDS = ["order", "absent", "disabled", "enabled", "field", "filled"];

/** How many seconds a wait step with a text waits if `within` is not named. */
const WAIT_TEXT_S = 60;

/** How long to wait for `window.__agent` after a navigation. */
const AGENT_APPEAR_TIMEOUT_MS = 30000;

/** Field roles that field and filled look up by name. */
const FIELD_ROLES = ["textbox", "combobox", "searchbox"];

/** Whether the step target is read through `find()`: a field by CSS selector is not. */
function agentTarget(step) {
  if (step.kind !== "field" && step.kind !== "filled") return true;
  return typeof step.target === "string" || Boolean(step.target?.testid);
}

/** The center of the box belongs to an element with this name (or its descendant): the click will arrive there. */
async function centerHitsTarget(page, rect, name) {
  return page
    .evaluate(
      ({ x, y, w, h, name }) => {
        const hit = document.elementFromPoint(x + w / 2, y + h / 2);
        if (!hit) return false;
        const owner = hit.closest("button, a, [role=tab], [role=menuitem], [role=option], [role=button], [role=link]");
        const label = (owner?.getAttribute("aria-label") ?? owner?.textContent ?? "").replace(/\s+/g, " ").trim();
        return Boolean(owner) && (label === name || label.startsWith(name));
      },
      { ...rect, name },
    )
    .catch(() => false);
}

/** While the element is covered (for example, a dialog is still sliding in), we wait; if it does not clear - a failure naming the covering element. */
async function assertNotOccluded(page, element, target) {
  await element.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  const testid = await element.getAttribute("data-testid", { timeout: 1000 }).catch(() => null);
  const query = testid ? { testid } : typeof target === "string" ? { name: target } : null;
  if (!query) return;
  let problem = null;
  for (let attempt = 0; attempt < OCCLUSION_GRACE_MS / 250; attempt += 1) {
    const infos = (await agentFind(page, query)).filter((e) => testid || (e.name === target && CLICK_ROLES.includes(e.role)));
    const info = infos.find((e) => e.inViewport) ?? infos[0];
    problem = occlusionProblem(info);
    // The box is covered at the corners (rounded edges, a neighbouring block by a couple of pixels), but the click
    // goes to the center: if the element itself is at the center, the click will arrive.
    if (problem && info?.rect && (await centerHitsTarget(page, info.rect, info.name))) return;
    if (!problem) return;
    failTarget = { rect: info.rect };
    await page.waitForTimeout(250);
  }
  throw new Error(problem);
}

/** What `find()` says about a wait step: the problem (null - all as expected) and the box of the named element. */
async function agentVerdict(page, step) {
  const { kind, target } = step;
  if (kind === "order") {
    // A testid element is one order line; the text can still split into lines (orderLines).
    const parts = target.map((item) => (testidTarget(item) ? [item] : orderLines([item])));
    const lines = parts.flat();
    const lists = await Promise.all(
      lines.map(async (item) => (testidTarget(item) ? pickByTestid(await agentFindShown(page, { testid: item.testid }), item) : agentFindShown(page, { text: item }))),
    );
    const labels = lines.map((item) => (testidTarget(item) ? targetLabel(item) : item));
    const texts = Object.fromEntries(lists.flat().map((e) => [e.domIndex, e.text]));
    return { problem: orderProblemByHits(lists.map((l) => l.map((e) => e.domIndex)), labels, texts), rect: lists.flat()[0]?.rect };
  }
  if (kind === "absent") {
    const found = testidTarget(target) ? pickByTestid(await agentFindShown(page, { testid: target.testid }), target) : await agentFindShown(page, { text: target });
    const alive = found.length > 0 || (await agentFind(page, {})).length > 0;
    return { problem: absentProblemByCount(found.length, alive, targetLabel(target)), rect: found[0]?.rect };
  }
  if (kind === "disabled" || kind === "enabled") {
    const infos = testidTarget(target)
      ? pickByTestid(await agentFindShown(page, { testid: target.testid }), target)
      : (await agentFind(page, { role: "button", name: target })).filter((e) => e.name === target);
    const states = infos.map((e) => e.aria.disabled === true);
    return { problem: (kind === "disabled" ? disabledProblem : enabledProblem)(states, targetLabel(target)), rect: infos[0]?.rect };
  }
  // A field by name: an exact match wins over a substring ("Title" and "Title of the page").
  const named = typeof target === "string" ? (await agentFind(page, { name: target })).filter((e) => FIELD_ROLES.includes(e.role)) : [];
  const infos =
    typeof target === "string"
      ? named.some((e) => e.name === target) ? named.filter((e) => e.name === target) : named
      : await agentFind(page, { testid: target.testid });
  const values = infos.map((e) => String(e.value ?? ""));
  return { problem: kind === "field" ? fieldProblem(values, step.has) : filledProblem(values), rect: infos[0]?.rect };
}

async function expectViaAgent(page, step) {
  const deadline = Date.now() + EXPECT_TIMEOUT_MS;
  let verdict;
  do {
    await settle(page);
    verdict = await agentVerdict(page, step);
    if (verdict.problem) await page.waitForTimeout(200);
  } while (verdict.problem && Date.now() < deadline);
  if (verdict.problem) {
    failTarget = verdict.rect ? { rect: verdict.rect } : null;
    throw new Error(verdict.problem);
  }
}

/** A failure snapshot: only the area of the named element; no element - the visible part of the page. */
async function failureShot(page, file) {
  let box = null;
  if (failTarget?.rect) {
    const { x, y, w, h } = failTarget.rect;
    const [scrollX, scrollY] = await page.evaluate(() => [window.scrollX, window.scrollY]).catch(() => [0, 0]);
    box = { x: x + scrollX, y: y + scrollY, width: w, height: h };
  } else if (failTarget?.locator) {
    const found = await failTarget.locator.boundingBox({ timeout: 2000 }).catch(() => null);
    const [scrollX, scrollY] = await page.evaluate(() => [window.scrollX, window.scrollY]).catch(() => [0, 0]);
    box = found && { ...found, x: found.x + scrollX, y: found.y + scrollY };
  }
  const clip = clipFor(box);
  await page.screenshot(clip ? { path: file, clip, fullPage: true } : { path: file }).catch(() => {});
}

/**
 * A step-by-step session (`--session DIR`): steps arrive one at a time in the file `DIR/request.json`,
 * the reply is `DIR/reply-<id>.json`. A passed step is appended to `DIR/steps.json` as it arrived
 * (with `{name}` substitutions), with `after` - given or taken from observation. The client is `braille step`.
 *
 * The session state is `DIR/state.json`, written only by `setSessionState`; transitions are `SESSION_MOVES`.
 */
// dirty - the action did not pass, and the page could have changed (the click happened, after did not occur): the step is not recorded,
// and the next recorded step must be goto, otherwise the recorded scenario would diverge from what the model saw.
export const SESSION_MOVES = { starting: ["ready", "failed"], ready: ["busy", "closed", "failed"], busy: ["ready", "dirty", "failed"], dirty: ["busy", "closed", "failed"], closed: [], failed: [] };
/** The executor is alive while it writes `DIR/heartbeat` (the pid in a container is not visible to the host). */
const SESSION_HEARTBEAT_MS = 2000;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const SESSION_POLL_MS = 150;

export function sessionMoveProblem(from, to) {
  if (!(from in SESSION_MOVES)) return `session state "${from}" does not exist`;
  return SESSION_MOVES[from].includes(to) ? null : `session: transition ${from} -> ${to} is not declared`;
}

function setSessionState(dir, current, to, extra = {}) {
  const problem = current === null ? (to === "starting" ? null : `a session starts with starting, not with ${to}`) : sessionMoveProblem(current, to);
  if (problem) throw new Error(problem);
  const file = path.join(dir, "state.json");
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ state: to, pid: process.pid, at: new Date().toISOString(), ...extra }));
  fs.renameSync(`${file}.tmp`, file);
  return to;
}

/** A session step with `{name}` values substituted; `braille run` substitutes the same way. */
export function fillValues(raw, values) {
  let text = JSON.stringify(raw);
  for (const [name, value] of Object.entries(values)) text = text.split(`{${name}}`).join(JSON.stringify(String(value)).slice(1, -1));
  return JSON.parse(text);
}

async function interactive(args, runStep, report, currentPage) {
  const dir = args.session;
  const values = args.values ? JSON.parse(fs.readFileSync(args.values, "utf8")) : {};
  const recorded = [];
  const stepsFile = path.join(dir, "steps.json");
  let state = setSessionState(dir, null, "starting");
  const beat = () => fs.writeFileSync(path.join(dir, "heartbeat"), String(Date.now()));
  beat();
  const heartbeat = setInterval(beat, SESSION_HEARTBEAT_MS);
  state = setSessionState(dir, state, "ready");
  let lastAt = Date.now();
  const reply = (id, body) => {
    const file = path.join(dir, `reply-${id}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(body, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  };
  for (;;) {
    const requestFile = path.join(dir, "request.json");
    if (!fs.existsSync(requestFile)) {
      if (Date.now() - lastAt > SESSION_IDLE_MS) {
        setSessionState(dir, state, "failed", { reason: `no requests for ${SESSION_IDLE_MS / 60000} min` });
        clearInterval(heartbeat);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, SESSION_POLL_MS));
      continue;
    }
    lastAt = Date.now();
    let request;
    try {
      request = JSON.parse(fs.readFileSync(requestFile, "utf8"));
    } catch (error) {
      fs.unlinkSync(requestFile);
      continue;
    }
    fs.unlinkSync(requestFile);
    const id = request.id ?? "x";
    if (request.close) {
      reply(id, { ok: true, closed: true, steps: recorded.length, file: stepsFile });
      setSessionState(dir, state, "closed");
      clearInterval(heartbeat);
      return;
    }
    if (request.look) {
      reply(id, { ok: true, observed: await observe(currentPage()) });
      continue;
    }
    if (!("step" in request)) {
      reply(id, { ok: false, error: 'a request is {"step": …}, {"look": true} or {"close": true}' });
      continue;
    }
    let step;
    try {
      step = parseStep(fillValues(request.step, values));
    } catch (error) {
      reply(id, { ok: false, error: `step cannot be parsed: ${error.message}` });
      continue;
    }
    if (state === "dirty" && step.kind !== "goto") {
      reply(id, { ok: false, error: 'the previous action did not pass, and the page could have changed: the next step is {"goto": "/…"} from the start of the path' });
      continue;
    }
    state = setSessionState(dir, state, "busy");
    const before = await observe(currentPage());
    const entry = await runStep(recorded.length, step);
    report.push(entry);
    const now = await observe(currentPage());
    if (entry.error) {
      const dirty = AFTER_KINDS.includes(step.kind) && step.kind !== "goto";
      reply(id, { ok: false, error: entry.error, ...(dirty ? { next: 'step not recorded; the page could have changed - only {"goto": "/…"} next' } : {}), observed: now, ...(entry.evidence ? { requests: entry.evidence.requests?.slice(0, 5), pageerrors: entry.evidence.pageerrors?.slice(0, 3) } : {}) });
    } else {
      const raw = { ...request.step };
      let afterFrom = "given";
      if (AFTER_KINDS.includes(step.kind) && !raw.after) {
        const seen = observedAfter(before, now);
        if (Object.keys(seen).length) raw.after = seen;
        afterFrom = "observed";
      }
      recorded.push(raw);
      fs.writeFileSync(stepsFile, `${JSON.stringify(recorded, null, 2)}\n`);
      reply(id, { ok: true, recorded: raw, after: AFTER_KINDS.includes(step.kind) ? afterFrom : "—", observed: now });
    }
    state = setSessionState(dir, state, entry.error && AFTER_KINDS.includes(step.kind) && step.kind !== "goto" ? "dirty" : "ready");
  }
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

  const browser = await chromium.launch({ ...chromeOption(process.env), args: ["--no-sandbox"] });
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

  legacyReason = args.legacy;
  if (legacyReason !== null) {
    const problem = legacyProblem(legacyReason);
    if (problem) fail(problem);
    console.log(`LEGACY MODE (snapshots and page text, without window.__agent): ${legacyReason}`);
  }
  const report = [];
  let failed = false;
  const runStep = async (index, step) => {
    const name = `${String(index + 1).padStart(2, "0")}-${slug(step)}`;
    noise = [];
    trail = { console: [], pageerrors: [], requests: [], api: [] };
    failTarget = null;
    stepRootless = null;
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
    const entry = { step: name, path: here.pathname + here.search, error, ...(evidence ? { evidence } : {}), noise, ms: Date.now() - stepStarted, ...(stepRootless ? { rootless: stepRootless } : {}), ...screenMark(present, present ? await agentScreen(page) : null) };
    console.log(
      [
        name,
        entry.path,
        error ? `FAILED: ${error}` : `ok ${(entry.ms / 1000).toFixed(1)} s`,
        noise.length ? noise.join(" ; ") : "no network or console errors",
        ...(stepRootless ? [rootlessLine(stepRootless)] : []),
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
