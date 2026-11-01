// Managed by agent-braille: update with `braille install`.
import type { CapturedError } from "./types";

const MAX_ENTRIES = 200;

export type ErrorsLog = {
  read: (options?: { clear?: boolean }) => CapturedError[];
  dispose: () => void;
};

type TrackedXhr = XMLHttpRequest & { __agentReq?: { method: string; url: string } };

/**
 * Collects console errors, unhandled exceptions and failed API requests
 * (fetch and XMLHttpRequest).
 * Entries survive navigation and name the page they happened on.
 */
export function startErrorsLog(win: Window & typeof globalThis): ErrorsLog {
  let entries: CapturedError[] = [];
  const disposers: Array<() => void> = [];

  const push = (entry: Omit<CapturedError, "path" | "at">) => {
    entries.push({ ...entry, path: win.location.pathname, at: Date.now() });
    if (entries.length > MAX_ENTRIES) entries.shift();
  };

  const originalConsoleError = win.console.error;
  win.console.error = (...args: unknown[]) => {
    push({ kind: "console", message: args.map(stringify).join(" ").slice(0, 500) });
    originalConsoleError.apply(win.console, args);
  };
  disposers.push(() => {
    win.console.error = originalConsoleError;
  });

  const onError = (event: ErrorEvent) =>
    push({ kind: "exception", message: String(event.message).slice(0, 500) });
  const onRejection = (event: PromiseRejectionEvent) =>
    push({ kind: "rejection", message: stringify(event.reason).slice(0, 500) });
  win.addEventListener("error", onError);
  win.addEventListener("unhandledrejection", onRejection);
  disposers.push(() => {
    win.removeEventListener("error", onError);
    win.removeEventListener("unhandledrejection", onRejection);
  });

  for (const method of ["pushState", "replaceState"] as const) {
    const original = win.history[method];
    win.history[method] = function (this: History, ...args: Parameters<History["pushState"]>) {
      const result = original.apply(this, args);
        return result;
    };
    disposers.push(() => {
      win.history[method] = original;
    });
  }

  if (typeof win.fetch === "function") {
    const originalFetch = win.fetch;
    win.fetch = async (...args: Parameters<typeof fetch>) => {
      const method = (args[1]?.method ?? (args[0] instanceof Request ? args[0].method : "GET")).toUpperCase();
      const url = args[0] instanceof Request ? args[0].url : String(args[0]);
      try {
        const response = await originalFetch.apply(win, args);
        if (response.status >= 400) {
          const code = errorCodeOf(await response.clone().text().catch(() => ""));
          push({
            kind: "request",
            message: `${method} ${url} -> ${response.status}${code ? ` ${code}` : ""}`,
            method,
            url,
            status: response.status,
            ...(code ? { code } : {}),
          });
        }
        return response;
      } catch (error) {
        push({ kind: "request", message: `${method} ${url} -> ${stringify(error)}`, method, url, status: 0 });
        throw error;
      }
    };
    disposers.push(() => {
      win.fetch = originalFetch;
    });
  }

  const xhrProto = win.XMLHttpRequest?.prototype;
  if (xhrProto) {
    const originalOpen = xhrProto.open;
    const originalSend = xhrProto.send;
    xhrProto.open = function (this: TrackedXhr, method: string, url: string | URL, ...rest: unknown[]) {
      this.__agentReq = { method: method.toUpperCase(), url: String(url) };
      return (originalOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
    } as typeof xhrProto.open;
    xhrProto.send = function (this: TrackedXhr, body?: Document | XMLHttpRequestBodyInit | null) {
      this.addEventListener("loadend", () => {
        const req = this.__agentReq;
        if (!req || (this.status > 0 && this.status < 400)) return;
        const text = this.responseType === "" || this.responseType === "text" ? this.responseText : "";
        const code = errorCodeOf(text || (this.responseType === "json" ? stringify(this.response) : ""));
        push({
          kind: "request",
          message: `${req.method} ${req.url} -> ${this.status}${code ? ` ${code}` : ""}`,
          method: req.method,
          url: req.url,
          status: this.status,
          ...(code ? { code } : {}),
        });
      });
      return originalSend.call(this, body);
    };
    disposers.push(() => {
      xhrProto.open = originalOpen;
      xhrProto.send = originalSend;
    });
  }

  return {
    read: options => {
        const out = entries.slice();
      if (options?.clear) entries = [];
      return out;
    },
    dispose: () => disposers.reverse().forEach(d => d()),
  };
}

/** `detail.code` (or `code`) from the JSON body of an API refusal; not JSON - no code. */
export function errorCodeOf(text: string): string | undefined {
  if (!text || text.length > 20000) return undefined;
  try {
    const body = JSON.parse(text) as { detail?: { code?: unknown }; code?: unknown };
    const code = body?.detail?.code ?? body?.code;
    return typeof code === "string" && code ? code.slice(0, 80) : undefined;
  } catch {
    return undefined;
  }
}

function stringify(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
