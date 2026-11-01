/** Step-by-step sessions for a model. */
import fs from "node:fs";
import path from "node:path";

import { takeNotices, observe } from "./browser.mjs";
import { AFTER_KINDS, observedAfter, parseStep } from "./steps.mjs";
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
export const SESSION_HEARTBEAT_MS = 2000;
export const SESSION_IDLE_MS = 30 * 60 * 1000;
export const SESSION_POLL_MS = 150;

export function sessionMoveProblem(from, to) {
  if (!(from in SESSION_MOVES)) return `session state "${from}" does not exist`;
  return SESSION_MOVES[from].includes(to) ? null : `session: transition ${from} -> ${to} is not declared`;
}

export function setSessionState(dir, current, to, extra = {}) {
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

/** The answer of a step: what changed since the last one; `unchanged` counts what is still there. */
export function compactObserved(now, before = null) {
  const { testids, ...rest } = now;
  if (!before) return rest;
  let unchanged = 0;
  for (const key of ["elements", "fields", "labels"]) {
    if (!rest[key]) continue;
    const old = new Set((before[key] ?? []).map((item) => JSON.stringify(item)));
    const fresh = rest[key].filter((item) => !old.has(JSON.stringify(item)));
    unchanged += rest[key].length - fresh.length;
    rest[key] = fresh;
  }
  if (rest.text && rest.text === before.text) delete rest.text;
  return unchanged ? { ...rest, unchanged } : rest;
}

export async function interactive(args, runStep, report, currentPage) {
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
      reply(id, { ok: true, observed: compactObserved(await observe(currentPage())) });
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
    await takeNotices(currentPage());
    const entry = await runStep(recorded.length, step);
    report.push(entry);
    const now = await observe(currentPage());
    const notices = await takeNotices(currentPage());
    const seen = { ...compactObserved(now, before), ...(notices.length ? { notices } : {}) };
    if (entry.error) {
      const dirty = entry.error?.includes("after the step did not occur");
      reply(id, { ok: false, error: entry.error, api: entry.calls, ...(dirty ? { next: 'step not recorded; the page could have changed - only {"goto": "/…"} next' } : {}), observed: now, ...(entry.evidence ? { requests: entry.evidence.requests?.slice(0, 5), pageerrors: entry.evidence.pageerrors?.slice(0, 3) } : {}) });
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
      reply(id, { ok: true, recorded: raw, after: AFTER_KINDS.includes(step.kind) ? afterFrom : "—", api: entry.calls, observed: seen });
    }
    state = setSessionState(dir, state, entry.error?.includes("after the step did not occur") ? "dirty" : "ready");
  }
}
