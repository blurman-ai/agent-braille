// Managed by agent-braille: update with `braille install`.
import { SCREEN_FACT_ATTR, SCREEN_FACT_VALUE_ATTR, SCREEN_TESTID_PREFIX } from "./screenState";
import type {
  ActAction,
  ActResult,
  AriaState,
  ElementInfo,
  ElementQuery,
  LayoutInfo,
  Occluder,
  Rect,
  ScreenInfo,
} from "./types";

const IMPLICIT_ROLES: Record<string, string> = {
  button: "button",
  select: "combobox",
  textarea: "textbox",
  a: "link",
  nav: "navigation",
  dialog: "dialog",
  li: "listitem",
  ul: "list",
  ol: "list",
  tr: "row",
  td: "cell",
  table: "table",
  main: "main",
  img: "img",
  progress: "progressbar",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
};

const INPUT_ROLES: Record<string, string> = {
  checkbox: "checkbox",
  radio: "radio",
  range: "slider",
  button: "button",
  submit: "button",
  reset: "button",
  search: "searchbox",
};

export function roleOf(el: Element): string | null {
  const explicit = el.getAttribute("role")?.trim().split(/\s+/)[0];
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === "a") return el.hasAttribute("href") ? "link" : null;
  if (tag === "input") {
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    return INPUT_ROLES[type] ?? "textbox";
  }
  return IMPLICIT_ROLES[tag] ?? null;
}

function squash(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

export function visibleTextOf(el: Element): string {
  return squash(el.textContent);
}

/** Accessible name: aria-labelledby, aria-label, label, alt/title/placeholder, text. */
export function nameOf(el: Element): string {
  const doc = el.ownerDocument;
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const joined = labelledBy
      .split(/\s+/)
      .map(id => squash(doc.getElementById(id)?.textContent))
      .filter(Boolean)
      .join(" ");
    if (joined) return joined;
  }
  const aria = squash(el.getAttribute("aria-label"));
  if (aria) return aria;

  const id = el.getAttribute("id");
  if (id) {
    const label = Array.from(doc.querySelectorAll("label")).find(
      l => l.getAttribute("for") === id,
    );
    const text = squash(label?.textContent);
    if (text) return text;
  }
  const wrapping = el.closest("label");
  if (wrapping && wrapping !== el) {
    const text = squash(wrapping.textContent);
    if (text) return text;
  }
  const alt = squash(el.getAttribute("alt"));
  if (alt) return alt;

  const tag = el.tagName.toLowerCase();
  const fromContent = tag === "input" || tag === "textarea" || tag === "select"
    ? ""
    : visibleTextOf(el);
  if (fromContent) return fromContent;
  return squash(el.getAttribute("title")) || squash(el.getAttribute("placeholder"));
}

function boolAttr(el: Element, name: string): boolean | undefined {
  const raw = el.getAttribute(name);
  if (raw == null) return undefined;
  return raw === "true";
}

export function ariaStateOf(el: Element): AriaState {
  const state: AriaState = {};
  const busy = boolAttr(el, "aria-busy");
  if (busy !== undefined) state.busy = busy;
  const invalid = el.getAttribute("aria-invalid");
  if (invalid != null) state.invalid = invalid !== "false";
  const supportsDisabled = "disabled" in el;
  const nativeDisabled = supportsDisabled && (el as HTMLButtonElement).disabled === true;
  const ariaDisabled = boolAttr(el, "aria-disabled");
  if (supportsDisabled || ariaDisabled !== undefined) {
    // `data-disabled` is set by UI libraries where there is no native attribute.
    state.disabled = nativeDisabled || ariaDisabled === true || el.hasAttribute("data-disabled");
  }
  const selected = boolAttr(el, "aria-selected");
  if (selected !== undefined) state.selected = selected;
  const current = el.getAttribute("aria-current");
  if (current != null && current !== "false") state.current = current;
  const expanded = boolAttr(el, "aria-expanded");
  if (expanded !== undefined) state.expanded = expanded;
  const checked = el.getAttribute("aria-checked");
  if (checked != null) state.checked = checked === "mixed" ? "mixed" : checked === "true";
  else if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
    state.checked = el.checked;
  }
  const pressed = el.getAttribute("aria-pressed");
  if (pressed != null) state.pressed = pressed === "mixed" ? "mixed" : pressed === "true";
  return state;
}

export function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function isInViewport(rect: Rect, win: Window | null): boolean {
  if (rect.w <= 0 || rect.h <= 0) return false;
  const vw = win?.innerWidth ?? 0;
  const vh = win?.innerHeight ?? 0;
  return rect.x < vw && rect.y < vh && rect.x + rect.w > 0 && rect.y + rect.h > 0;
}

function describeOccluder(el: Element): Occluder {
  return {
    testid: el.getAttribute("data-testid"),
    role: roleOf(el),
    name: nameOf(el).slice(0, 80),
    tag: el.tagName.toLowerCase(),
  };
}

/**
 * What lies on top of an element: `elementFromPoint` at the center and at the
 * four corners of the box (inset by a pixel). The element itself, its
 * descendants and its ancestors do not count as covering: an ancestor on top
 * means clipping, not a foreign layer.
 */
export function occludedByOf(el: Element, rect: Rect = rectOf(el)): Occluder[] {
  if (rect.w <= 0 || rect.h <= 0) return [];
  const doc = el.ownerDocument;
  const inset = Math.min(1, rect.w / 2, rect.h / 2);
  const points: Array<[number, number]> = [
    [rect.x + rect.w / 2, rect.y + rect.h / 2],
    [rect.x + inset, rect.y + inset],
    [rect.x + rect.w - inset, rect.y + inset],
    [rect.x + inset, rect.y + rect.h - inset],
    [rect.x + rect.w - inset, rect.y + rect.h - inset],
  ];
  const found = new Map<Element, Occluder>();
  for (const [px, py] of points) {
    const hit = doc.elementFromPoint(px, py);
    if (!hit || hit === el || el.contains(hit) || hit.contains(el)) continue;
    if (!found.has(hit)) found.set(hit, describeOccluder(hit));
  }
  return Array.from(found.values());
}

function valueOf(el: Element): string | undefined {
  return el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
    ? el.value
    : undefined;
}

/**
 * What the user sees in place of an element. A chip component puts `data-testid`
 * on a zero-size `<input>` and draws a `<label>` caption: the box, visibility
 * and overlap of such a field are taken from its caption.
 */
export function visualBoxOf(el: Element): Element {
  if (!(el instanceof HTMLInputElement)) return el;
  const r = el.getBoundingClientRect();
  if (r.width > 0 && r.height > 0) return el;
  const label =
    (el.id && Array.from(el.ownerDocument.querySelectorAll("label")).find(l => l.htmlFor === el.id)) ||
    el.closest("label");
  return label ?? el;
}

export function describeElement(el: Element): ElementInfo {
  const box = visualBoxOf(el);
  const rect = rectOf(box);
  const value = valueOf(el);
  return {
    ...(value === undefined ? {} : { value }),
    domIndex: Array.prototype.indexOf.call(el.ownerDocument.querySelectorAll("*"), el),
    testid: el.getAttribute("data-testid"),
    role: roleOf(el),
    name: nameOf(el),
    text: visibleTextOf(el).slice(0, 200),
    aria: ariaStateOf(el),
    rect,
    inViewport: isInViewport(rect, el.ownerDocument.defaultView),
    occludedBy: occludedByOf(box, rect),
    clipped: el.scrollWidth > el.clientWidth,
  };
}

function matchesTestid(actual: string | null, wanted: string): boolean {
  if (actual == null) return false;
  return wanted.endsWith("*")
    ? actual.startsWith(wanted.slice(0, -1))
    : actual === wanted;
}

const norm = (s: string) => s.toLowerCase();

export function matchesQuery(el: Element, query: ElementQuery): boolean {
  if (query.testid !== undefined && !matchesTestid(el.getAttribute("data-testid"), query.testid)) {
    return false;
  }
  if (query.role !== undefined && roleOf(el) !== query.role) return false;
  if (query.name !== undefined && !norm(nameOf(el)).includes(norm(query.name))) return false;
  if (query.text !== undefined && !norm(visibleTextOf(el)).includes(norm(query.text))) {
    return false;
  }
  return true;
}

function isRendered(el: Element): boolean {
  const win = el.ownerDocument.defaultView;
  if (!win) return true;
  const style = win.getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden";
}

const ELEMENT_SELECTOR = [
  "[data-testid]",
  "button",
  "a[href]",
  "input",
  "textarea",
  "select",
  '[role="button"]',
  '[role="tab"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="switch"]',
  '[role="alert"]',
  "h1",
  "h2",
  "h3",
].join(",");

/**
 * Elements the agent can ask about, except those hidden by style.
 *
 * A query with `text` searches all elements, not only interactive ones: this is
 * how it is checked that a text is on the screen or is not. Of nested matches
 * the deepest one is kept, so that ancestors with the same text do not multiply
 * the answer.
 */
export function queryElements(root: ParentNode, query?: ElementQuery): Element[] {
  if (query?.text !== undefined) {
    const matched = Array.from(root.querySelectorAll("*")).filter(el => matchesQuery(el, query));
    const deepest = matched.filter(el => !matched.some(other => other !== el && el.contains(other)));
    return deepest.filter(isRendered);
  }
  const all = Array.from(root.querySelectorAll(ELEMENT_SELECTOR)).filter(isRendered);
  return query ? all.filter(el => matchesQuery(el, query)) : all;
}

export function findInfos(doc: Document, query: ElementQuery): ElementInfo[] {
  return queryElements(doc, query).map(describeElement);
}

/**
 * The screen root. A nested screen sits inside an outer screen, so the
 * page has two roots: the innermost one is taken - the one a person sees.
 */
export function screenRootOf(doc: Document): Element | null {
  const roots = Array.from(doc.querySelectorAll(`[data-testid^="${SCREEN_TESTID_PREFIX}"]`));
  return roots.find(root => !roots.some(other => other !== root && root.contains(other))) ?? null;
}

export function screenInfoOf(doc: Document): ScreenInfo | null {
  const root = screenRootOf(doc);
  if (!root) return null;
  // Modal dialogs live in a portal outside the screen root, but are visible on the screen.
  const scopes: ParentNode[] = [root, ...Array.from(doc.querySelectorAll('[role="dialog"]'))];
  const seen = new Set<Element>();
  const elements: ElementInfo[] = [];
  for (const scope of scopes) {
    for (const el of queryElements(scope)) {
      if (seen.has(el) || el === root) continue;
      seen.add(el);
      elements.push(describeElement(el));
    }
  }
  // Notifications are also rendered in a portal outside the screen root: a
  // refusal like "choose a category first" would otherwise be invisible to the agent.
  const alerts = Array.from(doc.querySelectorAll('[role="alert"]'))
    .filter(isRendered)
    .map(visibleTextOf)
    .filter(Boolean);
  return {
    testid: root.getAttribute("data-testid") ?? "",
    name: (root.getAttribute("data-testid") ?? "").slice(SCREEN_TESTID_PREFIX.length),
    state: root.getAttribute("data-state"),
    url: doc.defaultView?.location.href ?? "",
    outerScreens: Array.from(doc.querySelectorAll(`[data-testid^="${SCREEN_TESTID_PREFIX}"]`))
      .filter(other => other !== root && other.contains(root))
      .map(other => ({
        testid: other.getAttribute("data-testid") ?? "",
        state: other.getAttribute("data-state"),
      })),
    overlays: overlaysOf(doc),
    facts: factsOf(scopes),
    alerts,
    elements,
  };
}

const OVERLAY_SELECTOR = '[role="dialog"],[role="alertdialog"],[role="listbox"],[role="menu"]';

/** Visible layers on top of the screen: a click on whatever is under them runs into them. */
export function overlaysOf(doc: Document): ScreenInfo["overlays"] {
  return Array.from(doc.querySelectorAll(OVERLAY_SELECTOR))
    .filter(el => isRendered(el) && rectOf(el).w > 0 && rectOf(el).h > 0)
    .map(el => ({
      role: el.getAttribute("role") ?? "",
      name: (nameOf(el) || el.querySelector("h1,h2,h3,h4")?.textContent || "").trim().slice(0, 80),
      testid: el.getAttribute("data-testid"),
    }));
}

function factsOf(scopes: ParentNode[]): Record<string, string> {
  const facts: Record<string, string> = {};
  for (const scope of scopes) {
    for (const el of Array.from(scope.querySelectorAll(`[${SCREEN_FACT_ATTR}]`))) {
      if (!isRendered(el)) continue;
      facts[el.getAttribute(SCREEN_FACT_ATTR) ?? ""] = el.getAttribute(SCREEN_FACT_VALUE_ATTR) ?? "";
    }
  }
  return facts;
}

export function computeLayout(a: Rect, b: Rect): LayoutInfo {
  const gapX = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
  const gapY = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
  const overlapW = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const overlapH = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  const overlaps = overlapW > 0 && overlapH > 0;
  return {
    a,
    b,
    aAbove: a.y + a.h <= b.y,
    aBelow: a.y >= b.y + b.h,
    aLeftOf: a.x + a.w <= b.x,
    aRightOf: a.x >= b.x + b.w,
    gapX: round(gapX),
    gapY: round(gapY),
    distance: round(Math.hypot(gapX, gapY)),
    overlaps,
    overlapArea: overlaps ? round(overlapW * overlapH) : 0,
  };
}

export function layoutOf(doc: Document, a: string, b: string): LayoutInfo | null {
  const ea = queryElements(doc, { testid: a })[0];
  const eb = queryElements(doc, { testid: b })[0];
  if (!ea || !eb) return null;
  return computeLayout(rectOf(ea), rectOf(eb));
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = Object.getPrototypeOf(el) as object;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

function dispatchMouse(el: Element, type: string) {
  const Ctor = el.ownerDocument.defaultView?.MouseEvent ?? MouseEvent;
  el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true }));
}

/** An action along the user's path: focus, a chain of mouse events, native value + input/change. */
export function actOn(doc: Document, testid: string, action: ActAction, value?: string): ActResult {
  const el = queryElements(doc, { testid })[0];
  if (!el) return { ok: false, error: "not_found" };
  const info = describeElement(el);
  if (info.aria.disabled) return { ok: false, error: "disabled" };

  if (action === "focus") {
    (el as HTMLElement).focus();
    return { ok: true };
  }
  if (action === "click") {
    if (info.occludedBy.length > 0) {
      return { ok: false, error: "occluded", occludedBy: info.occludedBy };
    }
    (el as HTMLElement).focus?.();
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      dispatchMouse(el, type);
    }
    (el as HTMLElement).click();
    return { ok: true };
  }
  const isField =
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement;
  if (!isField) return { ok: false, error: "unsupported" };
  if (action === "type" || action === "clear") {
    if (el instanceof HTMLSelectElement) return { ok: false, error: "unsupported" };
    el.focus();
    setNativeValue(el, action === "clear" ? "" : (value ?? ""));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return { ok: true };
  }
  // select
  if (!(el instanceof HTMLSelectElement)) return { ok: false, error: "unsupported" };
  setNativeValue(el, value ?? "");
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true };
}
