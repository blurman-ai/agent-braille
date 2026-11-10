/** What a failed step leaves behind: composition, limits, masking. */
/** The composition of failure evidence: one declaration. */
export const EVIDENCE = {
  "required": [
    "url",
    "text",
    "screenshot",
    "load"
  ],
  "requiredInLoad": [
    "readyState",
    "root",
    "agent",
    "scripts",
    "chunkErrors"
  ],
  "limits": {
    "text": 1500,
    "console": 20,
    "pageerrors": 10,
    "requests": 30,
    "line": 240,
    "api": 12
  },
  "chunkError": "dynamically imported module|Loading chunk|ChunkLoadError|Importing a module script failed|error loading dynamically|MIME type",
  "masks": {
    "replacement": "***",
    "patterns": [
      "eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]*",
      "(?:Bearer|Basic)\\s+[A-Za-z0-9._~+/=-]{8,}",
      "(?:token|secret|password|passwd|api[_-]?key|auth_token|access_token|refresh_token|authorization)[\"']?\\s*[:=]\\s*[\"']?[^\\s\"'&,;}]{4,}",
      "(?=[A-Za-z0-9_]*\\d)(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{32,}"
    ]
  }
};
export const MASK_PATTERNS = EVIDENCE.masks.patterns.map((source) => new RegExp(source, "gi"));
export const CHUNK_ERROR = new RegExp(EVIDENCE.chunkError, "i");

/** Masking by data: patterns from the declaration and the login secret itself, wherever it stands. */
export function maskSecrets(text, secrets = []) {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join(EVIDENCE.masks.replacement);
  }
  for (const pattern of MASK_PATTERNS) out = out.replace(pattern, EVIDENCE.masks.replacement);
  return out;
}

/** An address without the query string and the anchor: they may contain tokens. */
export function bareUrl(url) {
  return String(url ?? "").replace(/[?#].*$/, "");
}

/** Whether the message refers to a chunk load failure. */
export function isChunkError(text) {
  return CHUNK_ERROR.test(String(text ?? ""));
}

/** Evidence from raw page data: trimming to the limits and masking. A pure function - the selftest checks it. */
export function buildEvidence(raw, secrets = []) {
  const limits = EVIDENCE.limits;
  const line = (value) => maskSecrets(String(value ?? ""), secrets).slice(0, limits.line);
  const list = (items, max) => (Array.isArray(items) ? items : []).slice(0, max).map(line);
  const load = raw.load ?? {};
  return {
    url: maskSecrets(bareUrl(raw.url), secrets),
    title: line(raw.title),
    text: maskSecrets(String(raw.text ?? "").replace(/\s+\n/g, "\n").trim(), secrets).slice(0, limits.text),
    console: list(raw.console, limits.console),
    pageerrors: list(raw.pageerrors, limits.pageerrors),
    requests: (Array.isArray(raw.requests) ? raw.requests : []).slice(0, limits.requests).map((r) => ({
      method: line(r.method),
      path: maskSecrets(bareUrl(r.path), secrets).slice(0, limits.line),
      status: typeof r.status === "number" ? r.status : line(r.status),
      ms: r.ms,
    })),
    api: (Array.isArray(raw.api) ? raw.api : []).slice(-limits.api).map((r) => ({
      method: line(r.method),
      path: maskSecrets(bareUrl(r.path), secrets).slice(0, limits.line),
      status: r.status,
      ms: r.ms,
    })),
    screenshot: raw.screenshot ?? "",
    screen: raw.screen
      ? {
          testid: line(raw.screen.testid),
          state: raw.screen.state === null || raw.screen.state === undefined ? null : line(raw.screen.state),
          outer: list((raw.screen.outer ?? []).map((o) => `${o.testid}:${o.state}`), limits.console),
          overlays: list((raw.screen.overlays ?? []).map((o) => o.name || o.testid || o.role), limits.console),
          facts: list(Object.entries(raw.screen.facts ?? {}).map(([k, v]) => `${k}=${v}`), limits.console),
          alerts: list(raw.screen.alerts, limits.console),
        }
      : null,
    busy: list(Object.entries(raw.busy ?? {}).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`), limits.console),
    target: raw.target === null || raw.target === undefined
      ? null
      : list(raw.target.map((e) => [`${e.role ?? "?"} "${e.name}"${e.testid ? ` ${e.testid}` : ""}`, e.disabled && "disabled", e.busy && "busy", e.inViewport === false && "outside the viewport", e.occludedBy?.length && `covered: ${e.occludedBy.join(", ")}`].filter(Boolean).join(", ")), limits.console),
    load: {
      readyState: load.readyState ?? null,
      root: load.root ?? null,
      agent: load.agent ?? null,
      scripts: load.scripts ?? null,
      chunkErrors: list(load.chunkErrors, limits.console),
    },
  };
}

/** What is missing from the evidence; empty means the composition is complete. Read by the selftest. */
export function evidenceProblems(evidence) {
  const problems = [];
  if (!evidence || typeof evidence !== "object") return ["no evidence"];
  for (const field of EVIDENCE.required) {
    const value = evidence[field];
    const empty = value === undefined || value === null || value === "" || (typeof value === "object" && !Object.keys(value).length);
    if (empty) problems.push(`no field ${field}`);
  }
  for (const field of EVIDENCE.requiredInLoad) {
    if (!evidence.load || !(field in evidence.load) || evidence.load[field] === undefined) problems.push(`no load.${field}`);
  }
  return problems;
}

/** Takes the page load state; the page may be closed or dead - then the fields are empty but present. */
export async function collectEvidence(page, trail, shot, secrets, step = null) {
  // The step target as the agent sees it: what `stalker.find` sees under this name or testid - role, name, disabled, covered, in the viewport.
  const query = typeof step?.target === "string" ? { name: step.target } : step?.target?.testid ? { testid: step.target.testid } : null;
  const found = query
    ? await page
        .evaluate((q) => (window.stalker?.find ? window.stalker.find(q).slice(0, 3) : null), query)
        .catch(() => null)
    : null;
  const evaluated = await page
    .evaluate(() => {
      const rootEl = document.querySelector("#root, #app");
      return {
        title: document.title,
        text: document.body ? document.body.innerText : "",
        load: {
          readyState: document.readyState,
          root: rootEl ? `${rootEl.tagName.toLowerCase()}#${rootEl.id}, descendants ${rootEl.childElementCount}` : "no #root",
          agent: typeof window.stalker === "object" && window.stalker !== null,
          scripts: document.querySelectorAll("script[src]").length,
        },
        // What the screen says about itself - name, data-state, layers on top, facts, alerts, unfinished work.
        screen: (() => {
          try {
            const s = window.stalker?.screen?.();
            return s ? { testid: s.testid, state: s.state, outer: s.outerScreens, overlays: s.overlays, facts: s.facts, alerts: s.alerts } : null;
          } catch {
            return null;
          }
        })(),
        busy: (() => {
          try {
            return window.stalker?.busy?.() ?? null;
          } catch {
            return null;
          }
        })(),
      };
    })
    .catch((error) => ({ title: "", text: "", load: { readyState: `page not responding: ${error.message.slice(0, 80)}`, root: null, agent: null, scripts: null } }));
  const chunkErrors = [
    ...trail.console.filter(isChunkError),
    ...trail.pageerrors.filter(isChunkError),
    ...trail.requests.filter((r) => /\.m?js$/.test(r.path) && r.status !== undefined).map((r) => `${r.method} ${r.path} -> ${r.status}`),
  ];
  return buildEvidence(
    {
      url: page.url(),
      title: evaluated.title,
      text: evaluated.text,
      console: trail.console,
      pageerrors: trail.pageerrors,
      requests: trail.requests,
      api: trail.api,
      screenshot: shot,
      load: { ...evaluated.load, chunkErrors },
      screen: evaluated.screen ?? null,
      busy: evaluated.busy ?? null,
      target: found === null ? null : found.map((e) => ({ role: e.role, name: e.name, testid: e.testid, disabled: !!e.aria?.disabled, busy: !!e.aria?.busy, inViewport: e.inViewport, occludedBy: (e.occludedBy ?? []).map((o) => o.name || o.testid || o.role) })),
    },
    secrets,
  );
}

/** The screen state in one line: name, data-state, layers on top, facts, alerts, unfinished work. */
export function screenSummary(evidence) {
  const screen = evidence?.screen;
  if (!screen) return evidence?.load?.agent ? "window.stalker is present, no screen with data-state" : "no window.stalker";
  const parts = [`screen ${screen.testid} data-state=${screen.state}`];
  if (screen.overlays?.length) parts.push(`on top: ${screen.overlays.join(", ")}`);
  if (screen.alerts?.length) parts.push(`alerts: ${screen.alerts.join("; ")}`);
  if (screen.facts?.length) parts.push(`facts: ${screen.facts.join(", ")}`);
  if (evidence.busy?.length) parts.push(`busy: ${evidence.busy.join(", ")}`);
  if (evidence.target) parts.push(evidence.target.length ? `target: ${evidence.target.join("; ")}` : "target: none on the screen");
  return parts.join(" | ");
}

/** A Playwright timeout is not a cause: the cause is named by the screen. "Timeout 60000ms exceeded" becomes what
 * the step was waiting for, the deadline and the screen state; other errors are left alone. */
export function timeoutReason(error, step, evidence) {
  const timeout = /Timeout (\d+)ms exceeded/.exec(error ?? "");
  if (!timeout) return error;
  // The step arrives parsed (`parseStep`: {kind, target}).
  const kind = step?.kind ?? "step";
  const target = step?.target;
  const wanted = typeof target === "string" ? `"${target}"` : JSON.stringify(target ?? "");
  const rest = error.split(" — ").slice(1).join(" — ");
  return [`${kind} ${wanted} did not come true within ${Math.round(Number(timeout[1]) / 1000)} s; ${screenSummary(evidence)}`, rest].filter(Boolean).join(" - ").slice(0, 600);
}

/** Failed API requests from `window.stalker.errors()` in one line; empty means none. */
export function apiFailuresLine(entries) {
  const lines = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.kind === "request")
    .map((e) => `${e.method} ${String(e.url).replace(/^https?:\/\/[^/]+/, "")} -> ${e.status}${e.code ? ` ${e.code}` : ""}`);
  return lines.length ? `API: ${[...new Set(lines)].join("; ")}` : "";
}

/** API requests of a step: what actually happened, not "no errors". Path only: addresses may hold secrets. */
export function apiCallsLine(calls) {
  if (!calls?.length) return "no requests";
  const counts = new Map();
  for (const call of calls) counts.set(call, (counts.get(call) ?? 0) + 1);
  const lines = [...counts].map(([call, count]) => (count > 1 ? `${call} x${count}` : call));
  return lines.length > 6 ? `${lines.slice(0, 6).join(", ")} and ${lines.length - 6} more` : lines.join(", ");
}
