/** API recordings: the file format, the matching key, secret masking and replay. No browser. */
import fs from "node:fs";
import path from "node:path";

import { HERE } from "./steps.mjs";
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
export const API_DRAIN_MS = 10000;
/** A sample records file: used by the selftest. */
export const API_SAMPLE = path.join(HERE, "testdata", "api-sample.json");

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
export const SECRET_FIELD = /pass(word|wd)?|secret|token|authorization|cookie|api[-_]?key/i;
export const SECRET_MARK = "***";

export function maskedFields(value) {
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

export function sortedKeys(value) {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedKeys(value[key])]));
  return value;
}

/** A UUID in a string value of the body. The browser generates them itself on every run,
 * and a key containing them would never match during replay. */
export const RE_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
export const API_UUID_MARK = "<uuid>";

export function maskedUuids(value) {
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
export const callKey = (call) => JSON.stringify([call.method, call.path, call.query, normalizeBody(call.body, "application/json")]);

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
export function checkApiRecords(directory) {
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
