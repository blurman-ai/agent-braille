// Managed by agent-braille: update with `braille install`.
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStalker, installStalker } from "./install";
import { STALKER_TOOLS } from "./tools";

afterEach(() => {
  delete window.stalker;
  delete window.__agent;
  vi.restoreAllMocks();
});

describe("window.stalker", () => {
  it("installStalker installs six functions and the tool descriptions", () => {
    installStalker(window);
    const agent = window.stalker!;
    for (const name of ["screen", "busy", "find", "layout", "errors", "act"] as const) {
      expect(typeof agent[name]).toBe("function");
    }
    expect(agent.tools).toBe(STALKER_TOOLS);
  });

  it("every function is described by a tool: name, description, input schema", () => {
    installStalker(window);
    const names = STALKER_TOOLS.map(t => t.name).sort();
    expect(names).toEqual(["act", "busy", "errors", "find", "layout", "screen"]);
    for (const tool of STALKER_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.inputSchema).toMatchObject({ type: "object" });
      expect(typeof window.stalker![tool.name]).toBe("function");
    }
  });

  it("the name before v2, window.__agent, points to the same object", () => {
    installStalker(window);
    expect(window.__agent).toBe(window.stalker);
  });

  it("a repeated install does not replace the object", () => {
    installStalker(window);
    const first = window.stalker;
    installStalker(window);
    expect(window.stalker).toBe(first);
  });

  it("registers tools in navigator.modelContext when it exists", async () => {
    const registerTool = vi.fn();
    Object.defineProperty(window.navigator, "modelContext", { value: { registerTool }, configurable: true });
    try {
      installStalker(window);
      expect(registerTool).toHaveBeenCalledTimes(STALKER_TOOLS.length);
      const screenTool = registerTool.mock.calls.find(c => c[0].name === "screen")![0];
      const out = await screenTool.execute({});
      expect(out.content[0].type).toBe("text");
    } finally {
      delete (window.navigator as { modelContext?: unknown }).modelContext;
    }
  });
});

describe("errors()", () => {
  it("collects console.error and a failed fetch, clear empties the buffer", async () => {
    const realConsoleError = console.error;
    console.error = () => {};
    const realFetch = window.fetch;
    window.fetch = vi.fn(async () => new Response("no", { status: 500 })) as typeof fetch;
    const api = createStalker(window);
    try {
      console.error("boom", { a: 1 });
      await window.fetch("/api/v1/x", { method: "POST" });
      const errors = api.errors();
      expect(errors.map(e => e.kind)).toEqual(["console", "request"]);
      expect(errors[0].message).toContain("boom");
      expect(errors[1]).toMatchObject({ method: "POST", url: "/api/v1/x", status: 500 });
      expect(api.errors({ clear: true })).toHaveLength(2);
      expect(api.errors()).toEqual([]);
    } finally {
      api.dispose();
      console.error = realConsoleError;
      window.fetch = realFetch;
    }
  });

  it("the refusal code from the JSON body ends up in the request entry", async () => {
    const realFetch = window.fetch;
    window.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ detail: { code: "replay_miss" } }), { status: 502 }),
    ) as typeof fetch;
    const api = createStalker(window);
    try {
      await window.fetch("/api/items/extract", { method: "POST" });
      expect(api.errors()[0]).toMatchObject({ status: 502, code: "replay_miss" });
      expect(api.errors()[0].message).toContain("replay_miss");
    } finally {
      api.dispose();
      window.fetch = realFetch;
    }
  });

  it("a successful request is not listed; an error survives navigation and names its page", async () => {
    const realFetch = window.fetch;
    window.fetch = vi.fn(async () => new Response("ok", { status: 200 })) as typeof fetch;
    const api = createStalker(window);
    try {
      await window.fetch("/api/ok");
      expect(api.errors()).toEqual([]);
      window.dispatchEvent(new ErrorEvent("error", { message: "old screen" }));
      expect(api.errors()).toHaveLength(1);
      const page = window.location.pathname;
      window.history.pushState({}, "", "/app/other");
      expect(api.errors()[0]).toMatchObject({ path: page });
    } finally {
      window.history.pushState({}, "", "/");
      api.dispose();
      window.fetch = realFetch;
    }
  });
});
