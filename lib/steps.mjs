/** Step grammar and verdicts: what a step may say and why an expectation failed. No browser. */
import path from "node:path";

export const WS = process.cwd();
export const HERE = path.dirname(new URL(import.meta.url).pathname);

/** Hosts the executor may visit. Never add production here. */
export const ALLOWED_HOSTS = ["localhost", "127.0.0.1", ...(process.env.BRAILLE_ALLOWED_HOSTS ?? "").split(",").filter(Boolean)];

/** The single declaration of step kinds: parsing, execution and the selftest all read it. */
export const REPLAY_WITHIN_S = 30;
export const STEP_KINDS = ["goto", "click", "fill", "press", "upload", "wait", "order", "absent", "active", "disabled", "field", "checked", "unchecked", "focused", "hover", "enabled", "filled", "visible", "hidden", "described", "download", "repeat", "hold", "same-href", "cut", "advance", "tab", "visibility", "requested", "fact"];

/**
 * The target `{"testid": …}`: an element by data-testid, no label needed. `name` is a label check,
 * only when the scenario requirement names it (`braille check` does not verify the text); `item` picks one of identical elements (an answer
 * option, a row): data, not an interface label.
 */
export const TESTID_KINDS = ["click", "hover", "fill", "enabled", "disabled", "checked", "unchecked", "focused", "download", "wait", "absent", "filled", "field"];
export const RE_TESTID = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/;

/**
 * `after` - what observably changes after an action: the screen and its `data-state`, testids that appeared or disappeared.
 * The executor waits for it and fails this step, not the next wait. Required for actions (`braille check` verifies it).
 */
export const AFTER_KINDS = ["goto", "click", "fill", "press", "upload"];
export const AFTER_KEYS = ["screen", "state", "shown", "gone", "within"];
export const AFTER_TIMEOUT_S = 20;

/** Where the upload step takes files from and which field it puts them into when no field is named. */
export const UPLOAD_DIR = path.resolve(WS, process.env.BRAILLE_FILES_DIR ?? "scenarios/files");
export const UPLOAD_DEFAULT = "input[type=file]";

/** Expectations about the visibility of an element by selector. */
export const SEEN_KINDS = ["visible", "hidden"];

/**
 * The hold step: how many milliseconds a request may be delayed.
 * A file on a form is uploaded when the submit button is pressed, and the server processes the document in the same
 * request within fractions of a second, so the "processing" state cannot be held. The request is not
 * replaced but delayed: the screen is checked, the response is real.
 */
export const HOLD_MIN_MS = 500;
export const HOLD_MAX_MS = 30000;

/** The second tab and hiding the tab: values of the tab and visibility steps. */
export const TAB_ACTIONS = ["open", "first", "second"];
export const VISIBILITY_VALUES = ["hidden", "visible"];
/** The requested step: how many requests can be named and with which method. */
export const REQUESTED_TIMES_MAX = 50;
export const REQUEST_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** How many times repeat steps repeat by default before the step refuses. */
export const REPEAT_MAX = 40;

/** Expectations about a checkbox: kind name -> what is expected of it. */
export const TICK_KINDS = ["checked", "unchecked", "focused"];

/** How long to wait for an optional element before skipping the step. */
export const OPTIONAL_TIMEOUT_MS = 3000;
// In agent mode a disabled click target waits this long, not Playwright's 15 s:
// the button is enabled by a response that has already arrived, not by a future one.
export const DISABLED_GRACE_MS = 5000;
// How long a covered target may wait for the cover to go (a dialog sliding in). Then the step fails naming the cover.
export const OCCLUSION_GRACE_MS = Number(process.env.BRAILLE_OCCLUSION_GRACE_MS ?? 1000);

/** How long to wait for the page to finish rendering what is expected: a heavy screen renders for several seconds. */
export const EXPECT_TIMEOUT_MS = 20000;

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
  return { screen: after.screen, state: after.state, shown: after.shown ?? [], gone: after.gone ?? [], within: after.within ?? AFTER_TIMEOUT_S, patient: "within" in after };
}

export function parseStep(raw) {
  // {"fill": {"label": "Name"}} is what a model writes first: the same as a plain name.
  for (const key of ["click", "hover", "fill", "field", "filled"]) {
    if (raw?.[key]?.label && Object.keys(raw[key]).length === 1) raw = { ...raw, [key]: raw[key].label };
  }
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

/** Why the button is not considered disabled; null means it is the only one on the page and it is disabled. `states` - per button with this name: whether it is disabled. */
export function disabledProblem(states, item) {
  if (states.length === 0) return `button "${item}" is not on the page`;
  return states.every(Boolean) ? null : `button "${item}" is enabled`;
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
export function nameLetters(text) {
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
export const CLIP_PAD = 16;

/** Screen states in which it is ready; `loading` - still waiting, `error` - failure. */
export const READY_STATES = ["ready", "empty"];

/**
 * How long to wait for the screen root to appear before concluding that the page has none.
 * Measured: the root appeared 0.1-1.2 s after `window.__agent` (while
 * an auth guard waited for the current-user request), and over three seconds under the load of four parallel scenarios.
 */
export const SCREEN_APPEAR_TIMEOUT_MS = 8000;

/** How long to wait for the screen to leave loading. */
export const SCREEN_READY_TIMEOUT_MS = 20000;

/** Roles by which click finds an element by name; overlap is checked only for them. */
export const CLICK_ROLES = ["button", "link", "tab", "menuitem"];

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

/** What covered the target, read from the page itself; empty when there is no data. */
export function coverLine(details) {
  if (!details) return "";
  const parts = [];
  if (details.element) parts.push(`at the centre of the target: ${details.element}, position ${details.position}, ${details.size}, z-index ${details.zIndex}`);
  if (details.inside) parts.push(`inside "${details.inside}"`);
  if (details.dialogs?.length) parts.push(`open dialog: ${details.dialogs.map((d) => `"${d}"`).join(", ")}`);
  return parts.length ? ` - ${parts.join("; ")}` : "";
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

// A request failed and the page is no longer busy: how long a wait goes on before the step fails naming the request.
export const API_FAIL_GRACE_MS = Number(process.env.BRAILLE_API_FAIL_GRACE_MS ?? 5000);

/**
 * Where the app's own report disagrees with what was observed directly. The state layer can drift from reality,
 * so it is compared with the network and with itself on every step. `failed` - requests of the step with status >= 400.
 */
export function contradictionsOf({ screen, busy = [], failed = [] }) {
  if (!screen) return [];
  const found = [];
  const quiet = ["ready", "empty"].includes(screen.state);
  if (quiet) for (const call of failed) found.push(`state is ${screen.state}, but ${call}`);
  if (screen.state === "error") {
    found.push(failed.length ? `state is error for the whole screen; only these requests failed: ${failed.join(", ")}. Check whether they affect what you are testing` : "state is error, but no request of this step failed");
  }
  if (screen.state === "loading" && !busy.length) found.push("state is loading, but nothing is busy");
  if (screen.state === "empty") {
    for (const [name, value] of Object.entries(screen.facts ?? {})) {
      if (Number(value) > 0) found.push(`state is empty, but fact ${name}=${value}`);
    }
  }
  return found;
}

const FAILED_WORDS = /^(failed|failure|error|rejected|denied)$/i;

/** A 200 that says it failed; null when the body does not say so. Only the top level: nested data is not a verdict. */
export function bodySaysFailed(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  if (data.ok === false) return "ok: false";
  if (data.success === false) return "success: false";
  if (typeof data.status === "string" && FAILED_WORDS.test(data.status)) return `status: ${data.status}`;
  if (data.error) return `error: ${JSON.stringify(data.error).slice(0, 80)}`;
  for (const key of ["errors", "failed", "skipped"]) {
    if (Array.isArray(data[key]) && data[key].length) return `${key}: ${data[key].length}`;
  }
  return null;
}

/** What the network of one step says by itself. `seen` - [{method, path, status, sent, body}] in order of response. */
export function networkContradictions(seen) {
  const found = [];
  const sent = new Map();
  const polled = new Map();
  for (const call of seen) {
    const name = `${call.method} ${call.path}`;
    if (call.method === "GET") {
      const key = `${name} ${call.status} ${call.body}`;
      polled.set(key, { name, status: call.status, count: (polled.get(key)?.count ?? 0) + 1 });
    } else {
      const key = `${name} ${call.sent}`;
      sent.set(key, { name, count: (sent.get(key)?.count ?? 0) + 1 });
    }
    if (call.status < 400 && call.method !== "GET") {
      const failed = bodySaysFailed(call.body);
      if (failed) found.push(`${name} ${call.status}, but the body says ${failed}`);
    }
  }
  for (const { name, count } of sent.values()) if (count > 1) found.push(`${name} sent ${count} times with the same body`);
  for (const { name, status, count } of polled.values()) if (count >= 5) found.push(`${name} ${status} ${count} times with the same answer: nothing is moving`);
  return found;
}

/** A request as the model reads it: the path, the query with secrets masked, the status last. */
export function callLabel(method, url, status, mask = (value) => value) {
  const { pathname, searchParams } = new URL(url);
  const query = Object.entries(mask(Object.fromEntries(searchParams))).map(([k, v]) => `${k}=${v}`).join("&").slice(0, 100);
  return `${method} ${pathname}${query ? `?${query}` : ""} ${status}`;
}

/**
 * Nothing more will happen: a request failed and was not repeated successfully, nothing is on its way, the page is not busy,
 * and the network has been quiet for the whole grace. A live poll keeps the wait going.
 */
export function waitIsOver({ failed, inFlight, busy, quietFor, grace = API_FAIL_GRACE_MS }) {
  return failed > 0 && inFlight === 0 && busy === 0 && quietFor >= grace;
}

/** What a JSON answer holds, briefly: lists by their length, so an empty list the screen got is visible next to the failed wait. */
export function answerShape(body) {
  let data;
  try { data = JSON.parse(body); } catch { return "not JSON"; }
  if (Array.isArray(data)) return `[${data.length}]`;
  if (!data || typeof data !== "object") return JSON.stringify(data).slice(0, 40);
  const lists = Object.entries(data).filter(([, value]) => Array.isArray(value)).map(([key, value]) => `${key}: [${value.length}]`);
  return lists.length ? `{${lists.slice(0, 6).join(", ")}}` : `{${Object.keys(data).slice(0, 6).join(", ")}}`;
}

/**
 * What the data layer of the page knows and the screen does not show (`window.__agent.data()`): a request the screen shows failed while
 * the screen says ready or empty; a save failed and the page said nothing. Mutations in the cache only grow, so the ones after `before` are this step's.
 */
export function dataContradictions({ state, before, after, notices = [] }) {
  if (!after) return [];
  const out = [];
  const watched = (after.queries ?? []).filter((query) => query.observers > 0);
  if (state === "ready" || state === "empty") {
    for (const query of watched.filter((q) => q.status === "error" && !q.handled)) out.push(`the screen says ${state}, but a request it shows failed: ${query.error} (${query.key})`);
  }
  // Writes are seen two ways: React Query mutations and every non-GET call of the HTTP client (some forms post past React Query).
  const writes = (after.writes ?? []).slice((before?.writes ?? []).length).map((w) => ({
    status: w.status !== null && w.status < 400 ? "success" : "error",
    submittedAt: w.at,
    call: w.call,
    error: `${w.call} -> ${w.status ?? "no answer"}${w.code ? ` ${w.code}` : ""}`,
  }));
  // A refusal repeated with success (a refreshed session) is not a failure.
  const settled = writes.filter((w) => w.status === "success" || !writes.some((later) => later.call === w.call && later.status === "success" && later.submittedAt >= w.submittedAt));
  const fresh = [...(after.mutations ?? []).slice((before?.mutations ?? []).length), ...settled];
  if (!notices.length && state !== "error") for (const m of fresh.filter((m) => m.status === "error")) out.push(`a save failed (${m.error}) and the page said nothing`);
  return [...new Set(out)];
}

export const SETTLED_GIVEUP_MS = Number(process.env.BRAILLE_SETTLED_GIVEUP_MS ?? 5000);

/**
 * Nothing more will happen without a failure either: the screen declares itself ready or empty, nothing is busy or on its way,
 * and the network has been quiet for the grace. The data came and it is not what the step expects. A step with `within` waits its time.
 */
export function settledWithout({ state, inFlight, busy, quietFor, grace = SETTLED_GIVEUP_MS }) {
  return (state === "ready" || state === "empty") && inFlight === 0 && busy === 0 && quietFor >= grace;
}
