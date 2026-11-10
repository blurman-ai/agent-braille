// Managed by agent-braille: update with `braille install`.
/**
 * Screen readiness for agents and scenarios. Values are declared once: a screen root takes them through
 * `screenRootProps`, `window.stalker` and the executor read the same values from the DOM. Derive the state
 * from the request or state the screen already has, never from a timer.
 */
export const SCREEN_STATES = ["loading", "ready", "empty", "error"] as const;
export type ScreenState = (typeof SCREEN_STATES)[number];

export const SCREEN_TESTID_PREFIX = "screen.";

export function screenRootProps(name: string, state: ScreenState) {
  return {
    "data-testid": `${SCREEN_TESTID_PREFIX}${name}`,
    "data-state": state,
    ...(state === "loading" ? { "aria-busy": true as const } : {}),
  };
}

export const SCREEN_FACT_ATTR = "data-fact";
export const SCREEN_FACT_VALUE_ATTR = "data-fact-value";

/** A fact the elements do not show: a mode, a step number. Read by `window.stalker.screen().facts`. */
export function screenFactProps(name: string, value: string | number): Record<string, string> {
  return { [SCREEN_FACT_ATTR]: name, [SCREEN_FACT_VALUE_ATTR]: String(value) };
}

export type QueryScreenInput = { status: "pending" | "error" | "success"; isEmpty?: boolean };

/** State from the main request. A failed refresh over loaded data keeps the screen. */
export function queryScreenState(query: QueryScreenInput): ScreenState {
  if (query.status === "pending") return "loading";
  if (query.status === "error") return "error";
  return query.isEmpty ? "empty" : "ready";
}

/** Any error wins, then any loading; empty only when all are empty. */
export function combineScreenStates(states: readonly ScreenState[]): ScreenState {
  if (states.includes("error")) return "error";
  if (states.includes("loading")) return "loading";
  if (states.length > 0 && states.every((state) => state === "empty")) return "empty";
  return "ready";
}
