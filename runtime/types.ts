// Managed by agent-braille: update with `braille install`.
export type AriaState = {
  busy?: boolean;
  invalid?: boolean;
  disabled?: boolean;
  selected?: boolean;
  current?: string;
  expanded?: boolean;
  checked?: boolean | "mixed";
  pressed?: boolean | "mixed";
};

export type Rect = { x: number; y: number; w: number; h: number };

/** What lies on top of an element. */
export type Occluder = {
  testid: string | null;
  role: string | null;
  name: string;
  tag: string;
};

export type ElementInfo = {
  testid: string | null;
  role: string | null;
  name: string;
  text: string;
  aria: AriaState;
  rect: Rect;
  inViewport: boolean;
  /** Value of an input field; other elements have none. */
  value?: string;
  /** Position in document order: used to check that one text comes before another. */
  domIndex: number;
  /** Covering elements at the center and corners of the box; empty means not covered. */
  occludedBy: Occluder[];
  /** `scrollWidth > clientWidth`: the content is wider than the visible area. */
  clipped: boolean;
};

export type ScreenInfo = {
  testid: string;
  name: string;
  state: string | null;
  url: string;
  /** Outer screens this one sits inside (for example, an outer screen around an editor screen). */
  outerScreens: Array<{ testid: string; state: string | null }>;
  /** Layers on top of the screen: dialogs, open lists and menus; empty means nothing on top. */
  overlays: Array<{ role: string; name: string; testid: string | null }>;
  /** Screen facts (`data-fact` → `data-fact-value`): mode, step number. */
  facts: Record<string, string>;
  /** Texts of `role="alert"` on the screen; with state=error - the reason for the red step. */
  alerts: string[];
  elements: ElementInfo[];
};

export type ElementQuery = {
  /** Exact match; `prefix*` matches by the start. */
  testid?: string;
  role?: string;
  /** Substring of the accessible name, case-insensitive. */
  name?: string;
  /** Substring of the visible text, case-insensitive. */
  text?: string;
};

export type LayoutInfo = {
  a: Rect;
  b: Rect;
  /** a above b: the bottom edge of a is not below the top edge of b. */
  aAbove: boolean;
  aBelow: boolean;
  aLeftOf: boolean;
  aRightOf: boolean;
  /** Gap per axis; 0 if the boxes overlap on this axis. */
  gapX: number;
  gapY: number;
  /** Distance between the nearest edges. */
  distance: number;
  overlaps: boolean;
  overlapArea: number;
};

export type CapturedError = {
  kind: "console" | "exception" | "rejection" | "request";
  message: string;
  /** For kind=request: method, URL and status (0 - the network did not answer). */
  method?: string;
  url?: string;
  status?: number;
  /** For kind=request: `detail.code` from the JSON body of the refusal, if present (`replay_miss`). */
  code?: string;
  path: string;
  at: number;
};

export type ActAction = "click" | "type" | "select" | "focus" | "clear";

export type ActResult =
  | { ok: true }
  | {
      ok: false;
      error: "not_found" | "disabled" | "occluded" | "unsupported";
      occludedBy?: Occluder[];
    };

export type StalkerApi = {
  version: string;
  screen: () => ScreenInfo | null;
  /** Unfinished items of the page per source; an empty object means at rest. */
  busy: () => Record<string, number>;
  /** Snapshots of the page's data layer per source (`registerDataSource`); empty when nothing is registered. */
  data?: () => Record<string, unknown>;
  find: (query: ElementQuery) => ElementInfo[];
  layout: (a: string, b: string) => LayoutInfo | null;
  errors: (options?: { clear?: boolean }) => CapturedError[];
  act: (testid: string, action: ActAction, value?: string) => ActResult;
  tools: ReadonlyArray<StalkerToolDescriptor>;
};

/** A tool in the form of the W3C WebMCP draft. */
export type StalkerToolDescriptor = {
  name: keyof Omit<StalkerApi, "tools" | "data">;
  description: string;
  inputSchema: Record<string, unknown>;
};
