// Managed by agent-braille: update with `braille install`.
import { busyOf, dataOf } from "./busy";
import { startErrorsLog } from "./errorsLog";
import { actOn, findInfos, layoutOf, screenInfoOf } from "./inspect";
import { STALKER_TOOLS } from "./tools";
import type { ActAction, StalkerApi, StalkerToolDescriptor, ElementQuery } from "./types";

declare global {
  interface Window {
    stalker?: StalkerApi;
    /** The name before v2; points to the same object until consumers move to `window.stalker`. */
    __agent?: StalkerApi;
  }
}

type ModelContext = {
  registerTool?: (tool: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    execute: (input: Record<string, unknown>) => Promise<unknown>;
  }) => void;
};

/** Builds the object without touching `window`: this is how tests check it. */
export function createStalker(win: Window & typeof globalThis): StalkerApi & { dispose: () => void } {
  const doc = win.document;
  const log = startErrorsLog(win);
  return {
    version: "agent-braille.v2",
    screen: () => screenInfoOf(doc),
    busy: () => busyOf(doc),
    data: () => dataOf(),
    find: (query: ElementQuery) => findInfos(doc, query ?? {}),
    layout: (a, b) => layoutOf(doc, a, b),
    errors: options => log.read(options),
    act: (testid: string, action: ActAction, value?: string) => actOn(doc, testid, action, value),
    tools: STALKER_TOOLS,
    dispose: log.dispose,
  };
}

function callTool(api: StalkerApi, name: StalkerToolDescriptor["name"], input: Record<string, unknown>): unknown {
  switch (name) {
    case "screen":
      return api.screen();
    case "busy":
      return api.busy();
    case "find":
      return api.find(input as ElementQuery);
    case "layout":
      return api.layout(String(input.a), String(input.b));
    case "errors":
      return api.errors(input as { clear?: boolean });
    case "act":
      return api.act(String(input.testid), input.action as ActAction, input.value as string | undefined);
  }
}

/** Installs `window.stalker`. Called only from `bootstrap.ts` when `VITE_STALKER=1`. */
export function installStalker(win: Window & typeof globalThis = window): void {
  if (win.stalker) return;
  const { dispose, ...api } = createStalker(win);
  void dispose;
  win.stalker = api;
  win.__agent = api;

  // When the browser provides navigator.modelContext (WebMCP draft), the same
  // functions are registered as page tools.
  const modelContext = (win.navigator as Navigator & { modelContext?: ModelContext }).modelContext;
  for (const tool of modelContext?.registerTool ? STALKER_TOOLS : []) {
    modelContext?.registerTool?.({
      ...tool,
      execute: async input => ({
        content: [{ type: "text", text: JSON.stringify(callTool(api, tool.name, input)) }],
      }),
    });
  }
}
