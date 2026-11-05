// Managed by agent-braille: update with `braille install`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  actOn,
  ariaStateOf,
  computeLayout,
  describeElement,
  findInfos,
  nameOf,
  occludedByOf,
  roleOf,
  screenInfoOf,
} from "./inspect";

/** jsdom does not compute geometry: boxes are set by hand. */
function stubRect(el: Element, x: number, y: number, w: number, h: number) {
  el.getBoundingClientRect = () =>
    ({ x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h, toJSON: () => ({}) }) as DOMRect;
}

/** What lies on top of a point: substituted for `elementFromPoint`. */
function stubTopmost(pick: (x: number, y: number) => Element | null) {
  document.elementFromPoint = vi.fn(pick);
}

beforeEach(() => {
  document.body.innerHTML = "";
  Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
});

afterEach(() => {
  // @ts-expect-error jsdom does not define elementFromPoint; remove the stub
  delete document.elementFromPoint;
});

describe("role, name and ARIA state", () => {
  it("role: explicit, implicit by tag, a link without href has no role", () => {
    document.body.innerHTML = `<button id="b"></button><a id="a1" href="/x"></a><a id="a2"></a><div id="d" role="tab"></div><input id="i" type="checkbox"><textarea id="t"></textarea>`;
    const role = (id: string) => roleOf(document.getElementById(id)!);
    expect(role("b")).toBe("button");
    expect(role("a1")).toBe("link");
    expect(role("a2")).toBeNull();
    expect(role("d")).toBe("tab");
    expect(role("i")).toBe("checkbox");
    expect(role("t")).toBe("textbox");
  });

  it("name: aria-label wins over text, label[for] names the field", () => {
    document.body.innerHTML = `<button id="b" aria-label="Attach files">+</button><label for="f">Item topic</label><input id="f"><button id="c">  Create   item </button>`;
    expect(nameOf(document.getElementById("b")!)).toBe("Attach files");
    expect(nameOf(document.getElementById("f")!)).toBe("Item topic");
    expect(nameOf(document.getElementById("c")!)).toBe("Create item");
  });

  it("name: aria-hidden parts are left out, so a required field is named without its asterisk", () => {
    document.body.innerHTML = `<label for="g">Group <span aria-hidden="true">*</span></label><input id="g"><span id="l">Role<i aria-hidden="true"> *</i></span><button id="r" aria-labelledby="l"></button>`;
    expect(nameOf(document.getElementById("g")!)).toBe("Group");
    expect(nameOf(document.getElementById("r")!)).toBe("Role");
  });

  it("ARIA: disabled from the native attribute and aria-disabled, selected, expanded, busy, invalid", () => {
    document.body.innerHTML = `<button id="n" disabled></button><button id="a" aria-disabled="true"></button><button id="s" aria-selected="false" aria-expanded="true" aria-busy="true" aria-invalid="true"></button><button id="p"></button>`;
    expect(ariaStateOf(document.getElementById("n")!).disabled).toBe(true);
    expect(ariaStateOf(document.getElementById("a")!).disabled).toBe(true);
    expect(ariaStateOf(document.getElementById("s")!)).toEqual({
      disabled: false,
      selected: false,
      expanded: true,
      busy: true,
      invalid: true,
    });
    expect(ariaStateOf(document.getElementById("p")!)).toEqual({ disabled: false });
  });
});

describe("overlap", () => {
  function setup() {
    document.body.innerHTML = `<button id="target" data-testid="editor.save">Create</button><div id="cover" data-testid="cookie.banner" role="dialog" aria-label="Cookies"></div>`;
    const target = document.getElementById("target")!;
    const cover = document.getElementById("cover")!;
    stubRect(target, 100, 100, 80, 40);
    stubRect(cover, 0, 110, 1000, 100);
    return { target, cover };
  }

  it("control case: a button under a banner reports who covers it", () => {
    const { target, cover } = setup();
    // the banner lies over the bottom half of the button: the bottom corners and the center fall into it
    stubTopmost((_x, y) => (y >= 110 ? cover : target));
    const info = describeElement(target);
    expect(info.occludedBy).toHaveLength(1);
    expect(info.occludedBy[0]).toMatchObject({ testid: "cookie.banner", role: "dialog", name: "Cookies" });
  });

  it("an uncovered button gives an empty list", () => {
    const { target } = setup();
    stubTopmost(() => target);
    expect(occludedByOf(target)).toEqual([]);
  });

  it("an ancestor on top is clipping, not overlap", () => {
    const { target } = setup();
    stubTopmost(() => document.body);
    expect(occludedByOf(target)).toEqual([]);
  });

  it("outside the window elementFromPoint gives null and there is no overlap", () => {
    const { target } = setup();
    stubTopmost(() => null);
    expect(occludedByOf(target)).toEqual([]);
  });
});

describe("box, viewport, clipping", () => {
  it("inViewport: true inside the window, false below it, false for a zero box", () => {
    document.body.innerHTML = `<i id="in"></i><i id="below"></i><i id="zero"></i>`;
    stubTopmost(() => null);
    const [inEl, below, zero] = ["in", "below", "zero"].map(id => document.getElementById(id)!);
    stubRect(inEl, 10, 10, 50, 20);
    stubRect(below, 10, 900, 50, 20);
    stubRect(zero, 10, 10, 0, 0);
    expect(describeElement(inEl).inViewport).toBe(true);
    expect(describeElement(below).inViewport).toBe(false);
    expect(describeElement(zero).inViewport).toBe(false);
  });

  it("a zero-size field with a caption (chip component) uses the caption box, and the caption is not an overlap", () => {
    document.body.innerHTML = `<input id="c" type="checkbox" data-testid="filters.assigned-only"><label id="l" for="c">Assigned only</label><input id="bare" type="checkbox">`;
    const [input, label, bare] = ["c", "l", "bare"].map(id => document.getElementById(id)!);
    stubRect(input, 0, 0, 0, 0);
    stubRect(label, 10, 10, 120, 30);
    stubRect(bare, 0, 0, 0, 0);
    stubTopmost(() => label);
    const info = describeElement(input);
    expect(info.rect).toEqual({ x: 10, y: 10, w: 120, h: 30 });
    expect(info.inViewport).toBe(true);
    expect(info.occludedBy).toEqual([]);
    // control case: without a caption the field stays invisible
    expect(describeElement(bare).inViewport).toBe(false);
  });

  it("clipped: scrollWidth is greater than clientWidth", () => {
    document.body.innerHTML = `<span id="t">a very long caption</span>`;
    stubTopmost(() => null);
    const el = document.getElementById("t")!;
    stubRect(el, 0, 0, 40, 10);
    Object.defineProperty(el, "scrollWidth", { value: 120, configurable: true });
    Object.defineProperty(el, "clientWidth", { value: 40, configurable: true });
    expect(describeElement(el).clipped).toBe(true);
    Object.defineProperty(el, "scrollWidth", { value: 40, configurable: true });
    expect(describeElement(el).clipped).toBe(false);
  });
});

describe("computeLayout", () => {
  it("a above b with a gap", () => {
    const l = computeLayout({ x: 0, y: 0, w: 100, h: 20 }, { x: 0, y: 50, w: 100, h: 20 });
    expect(l).toMatchObject({ aAbove: true, aBelow: false, gapY: 30, gapX: 0, distance: 30, overlaps: false, overlapArea: 0 });
  });

  it("an intersection gives an area and zero gaps", () => {
    const l = computeLayout({ x: 0, y: 0, w: 100, h: 100 }, { x: 50, y: 50, w: 100, h: 100 });
    expect(l).toMatchObject({ overlaps: true, overlapArea: 2500, gapX: 0, gapY: 0, aAbove: false, aLeftOf: false });
  });

  it("a left of b diagonally", () => {
    const l = computeLayout({ x: 0, y: 0, w: 10, h: 10 }, { x: 40, y: 30, w: 10, h: 10 });
    expect(l).toMatchObject({ aLeftOf: true, aAbove: true, gapX: 30, gapY: 20, distance: 36.1 });
  });
});

describe("screenInfoOf and find", () => {
  it("screen root, state, alert and elements", () => {
    document.body.innerHTML = `
      <div data-testid="screen.editor" data-state="error">
        <div role="alert">Failed to load</div>
        <button data-testid="editor.submit" disabled>Create</button>
        <span data-testid="editor.hidden" style="display:none">hidden</span>
      </div>`;
    stubTopmost(() => null);
    const screen = screenInfoOf(document)!;
    expect(screen.testid).toBe("screen.editor");
    expect(screen.name).toBe("editor");
    expect(screen.state).toBe("error");
    expect(screen.alerts).toEqual(["Failed to load"]);
    const submit = screen.elements.find(e => e.testid === "editor.submit")!;
    expect(submit).toMatchObject({ role: "button", name: "Create", aria: { disabled: true } });
    expect(screen.elements.find(e => e.testid === "editor.hidden")).toBeUndefined();
  });

  it("a notification in a portal outside the screen root ends up in alerts", () => {
    document.body.innerHTML = `
      <div data-testid="screen.editor" data-state="ready"><button>Build</button></div>
      <div class="notifications-root">
        <div role="alert">Choose a category first</div>
      </div>`;
    stubTopmost(() => null);
    expect(screenInfoOf(document)!.alerts).toEqual(["Choose a category first"]);
  });

  it("nested screens: the innermost is taken, the outer one is named in outerScreens", () => {
    document.body.innerHTML = `
      <div data-testid="screen.editor" data-state="ready">
        <div data-testid="screen.nested" data-state="loading">
          <button data-testid="nested.start">Start</button>
        </div>
      </div>`;
    stubTopmost(() => null);
    const screen = screenInfoOf(document)!;
    expect(screen.testid).toBe("screen.nested");
    expect(screen.state).toBe("loading");
    expect(screen.outerScreens).toEqual([{ testid: "screen.editor", state: "ready" }]);
    expect(screen.elements.map(e => e.testid)).toEqual(["nested.start"]);
  });

  it("find by text sees non-interactive elements too, keeping the deepest", () => {
    document.body.innerHTML = `<main><p id="p">Office <b id="b">closed</b> until Monday</p><button>Create</button></main>`;
    stubTopmost(() => null);
    const hits = findInfos(document, { text: "until Monday" });
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toContain("Office closed");
    expect(findInfos(document, { text: "no such text" })).toEqual([]);
    const [a, b] = [findInfos(document, { text: "Office" })[0], findInfos(document, { text: "Create" })[0]];
    expect(a.domIndex).toBeLessThan(b.domIndex);
  });

  it("the field value and data-disabled end up in the description", () => {
    document.body.innerHTML = `<textarea data-testid="f">summary</textarea><button data-testid="b" data-disabled="true">x</button>`;
    stubTopmost(() => null);
    expect(findInfos(document, { testid: "f" })[0].value).toBe("summary");
    expect(findInfos(document, { testid: "b" })[0].aria.disabled).toBe(true);
  });

  it("no root - null", () => {
    document.body.innerHTML = `<button>x</button>`;
    expect(screenInfoOf(document)).toBeNull();
  });

  it("find: by role and name substring, by testid prefix", () => {
    document.body.innerHTML = `<button data-testid="row.1" aria-label="Open document">a</button><button data-testid="row.2">b</button><a href="/x" data-testid="nav.x">c</a>`;
    stubTopmost(() => null);
    expect(findInfos(document, { testid: "row.*" })).toHaveLength(2);
    expect(findInfos(document, { role: "button", name: "document" })).toHaveLength(1);
    expect(findInfos(document, { role: "link" })[0].testid).toBe("nav.x");
    expect(findInfos(document, { testid: "row.9" })).toEqual([]);
  });
});

describe("actOn", () => {
  it("click on a free button calls the handler", () => {
    document.body.innerHTML = `<button data-testid="b">OK</button>`;
    stubTopmost(() => null);
    const onClick = vi.fn();
    document.querySelector("button")!.addEventListener("click", onClick);
    expect(actOn(document, "b", "click")).toEqual({ ok: true });
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("control case: click on a covered button is rejected with the name of the covering element", () => {
    document.body.innerHTML = `<button id="t" data-testid="b">OK</button><div id="c" data-testid="overlay" aria-label="Window"></div>`;
    const target = document.getElementById("t")!;
    const cover = document.getElementById("c")!;
    stubRect(target, 0, 0, 50, 20);
    stubTopmost(() => cover);
    const onClick = vi.fn();
    target.addEventListener("click", onClick);
    const result = actOn(document, "b", "click");
    expect(result).toMatchObject({ ok: false, error: "occluded" });
    expect(result.ok === false && result.occludedBy?.[0].name).toBe("Window");
    expect(onClick).not.toHaveBeenCalled();
  });

  it("a disabled button and an unknown testid", () => {
    document.body.innerHTML = `<button data-testid="b" disabled>OK</button>`;
    expect(actOn(document, "b", "click")).toEqual({ ok: false, error: "disabled" });
    expect(actOn(document, "nope", "click")).toEqual({ ok: false, error: "not_found" });
  });

  it("type sets the value and sends input; clear empties it", () => {
    document.body.innerHTML = `<textarea data-testid="f"></textarea>`;
    const field = document.querySelector("textarea")!;
    const onInput = vi.fn();
    field.addEventListener("input", onInput);
    expect(actOn(document, "f", "type", "topic")).toEqual({ ok: true });
    expect(field.value).toBe("topic");
    expect(actOn(document, "f", "clear")).toEqual({ ok: true });
    expect(field.value).toBe("");
    expect(onInput).toHaveBeenCalledTimes(2);
  });

  it("control case: type and clear on a read-only field are unsupported and keep the value", () => {
    document.body.innerHTML = `<input data-testid="f" readonly value="Admin">`;
    const field = document.querySelector("input")!;
    expect(actOn(document, "f", "type", "Editor")).toEqual({ ok: false, error: "unsupported" });
    expect(actOn(document, "f", "clear")).toEqual({ ok: false, error: "unsupported" });
    expect(field.value).toBe("Admin");
  });

  it("select sets the value on a select and sends change", () => {
    document.body.innerHTML = `<select data-testid="s"><option value="a">A</option><option value="b">B</option></select>`;
    const select = document.querySelector("select")!;
    const onChange = vi.fn();
    select.addEventListener("change", onChange);
    expect(actOn(document, "s", "select", "b")).toEqual({ ok: true });
    expect(select.value).toBe("b");
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("type on a button is not supported", () => {
    document.body.innerHTML = `<button data-testid="b">x</button>`;
    expect(actOn(document, "b", "type", "x")).toEqual({ ok: false, error: "unsupported" });
  });
});

describe("screen layers and facts", () => {
  it("an open list and a dialog are in overlays; a zero-size list is not", () => {
    document.body.innerHTML = `
      <div data-testid="screen.people" data-state="ready"><button>Assign</button></div>
      <div role="listbox" aria-label="People" id="open"></div>
      <div role="listbox" aria-label="Hidden" id="closed"></div>
      <div role="dialog" data-testid="assign.dialog"><h2>Assignment</h2></div>`;
    stubRect(document.getElementById("open")!, 0, 0, 300, 200);
    stubRect(document.querySelector('[role="dialog"]')!, 0, 0, 600, 400);
    const overlays = screenInfoOf(document)!.overlays;
    expect(overlays).toEqual([
      { role: "listbox", name: "People", testid: null },
      { role: "dialog", name: "Assignment", testid: "assign.dialog" },
    ]);
  });

  it("screen facts by data-fact; without them - an empty object", () => {
    document.body.innerHTML = `<div data-testid="screen.viewer" data-state="ready"></div>`;
    expect(screenInfoOf(document)!.facts).toEqual({});
    document.body.innerHTML = `
      <div data-testid="screen.viewer" data-state="ready">
        <div data-fact="mode" data-fact-value="preview"><div data-fact="step" data-fact-value="4"></div></div>
      </div>`;
    expect(screenInfoOf(document)!.facts).toEqual({ mode: "preview", step: "4" });
  });
});
