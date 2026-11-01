/** Executing steps in the page through window.__agent. */
import fs from "node:fs";
import path from "node:path";

import { CLICK_ROLES, coverLine, DISABLED_GRACE_MS, EXPECT_TIMEOUT_MS, OCCLUSION_GRACE_MS, OPTIONAL_TIMEOUT_MS, READY_STATES, REPLAY_WITHIN_S, RE_TESTID, SCREEN_APPEAR_TIMEOUT_MS, SCREEN_READY_TIMEOUT_MS, SEEN_KINDS, TICK_KINDS, UPLOAD_DEFAULT, UPLOAD_DIR, absentProblem, absentProblemByCount, activeProblem, afterProblem, clickBlockedProblem, clipFor, describedProblem, disabledProblem, downloadNameProblem, enabledProblem, fieldProblem, filledProblem, labelProblem, occlusionProblem, orderLines, orderProblem, orderProblemByHits, pickByTestid, sameHrefProblem, screenProblem, seenProblem, targetLabel, testidTarget, tickProblem } from "./steps.mjs";

/** Run state read and written across modules: reasons and marks of the current step. */
export const shared = { legacyReason: null, stepRootless: null, failTarget: null };
/** Login kinds the tool can put into the browser; bearer, cookie or none. */
export const CREDENTIAL_KINDS = ["bearer", "cookie", "none"];
export const BUNDLED_CHROME = "bundled";

/** A login passed by the environment; null means no login. */
export function givenCredential(env) {
  const kind = env.BRAILLE_CREDENTIAL;
  if (!kind) return null;
  if (!CREDENTIAL_KINDS.includes(kind)) {
    throw new Error(`BRAILLE_CREDENTIAL=${kind}: expected ${CREDENTIAL_KINDS.join(", ")}`);
  }
  const secret = env.BRAILLE_SECRET ?? "";
  if (kind !== "none" && !secret) throw new Error("BRAILLE_CREDENTIAL is set, but BRAILLE_SECRET is empty");
  return { credential: kind, secret };
}

/** Which browser to launch: the default path, a custom path or the one Playwright finds itself. */
export function chromeOption(env) {
  const chrome = env.BRAILLE_CHROME || BUNDLED_CHROME;
  return chrome === BUNDLED_CHROME ? {} : { executablePath: chrome };
}

/** The reason legacy mode is on (`--legacy`); null means agent mode. */

/** Paths where no `screen.*` root was found; readiness waits are short on them. */
export const rootlessPaths = new Set();

/** The page path without a screen root at the current step; null means there is a root or the mode is not agent mode. */

/** A report line about a page without a `data-state` root. */
export function rootlessLine(pathname) {
  return `NO ROOT: no screen.<name> with data-state on ${pathname} - readiness by fallback signs (needs markup in the frontend)`;
}

/** Whether the page has `window.__agent`; legacy mode does not use it even if present. */
export async function agentPresent(page) {
  if (shared.legacyReason !== null) return false;
  return page.evaluate(() => typeof window.__agent === "object" && window.__agent !== null).catch(() => false);
}

export async function agentScreen(page) {
  return page.evaluate(() => window.__agent.screen()).catch(() => null);
}

/**
 * What the report knows about the screen after a step: whether there is `window.__agent` and a `screen.<name>` root.
 */
export function screenMark(agent, screen) {
  return { agent, screen: screen ? { name: screen.name, state: screen.state } : null };
}

export async function agentFind(page, query) {
  return page.evaluate((q) => window.__agent.find(q), query).catch(() => []);
}

/** Texts a person sees: hidden ones (a closed select list) have a zero box. */
export async function agentFindShown(page, query) {
  return (await agentFind(page, query)).filter((e) => !e.rect || (e.rect.w > 0 && e.rect.h > 0));
}

/**
 * Readiness by the `data-state` of the screen root. Returns true if the page has
 * a screen and it has settled; false - there is no root (the page is not instrumented), and the
 * previous wait applies. A screen in error is a step failure with the screen text.
 */
export async function agentSettle(page, appearMs = SCREEN_APPEAR_TIMEOUT_MS) {
  const appeared =
    appearMs > 0
      ? await page
          .waitForFunction(() => window.__agent.screen() !== null, null, { timeout: appearMs, polling: 100 })
          .then(() => true, () => false)
      : (await agentScreen(page)) !== null;
  if (!appeared) return false;
  await page
    .waitForFunction(
      (ready) => {
        const screen = window.__agent.screen();
        return screen === null || ready.includes(screen.state) || screen.state === "error";
      },
      READY_STATES,
      { timeout: SCREEN_READY_TIMEOUT_MS, polling: 100 },
    )
    .catch(() => {});
  const problem = screenProblem(await agentScreen(page));
  if (problem) throw new Error(problem);
  return true;
}

/**
 * Rest by `__agent.busy()`: the page names its unfinished work itself (navigation, load,
 * submission, animation). Empty on two polls in a row - rest; a build without `busy` - at once.
 */
export async function agentIdle(page) {
  await page
    .waitForFunction(
      () => {
        const busy = typeof window.__agent?.busy === "function" ? window.__agent.busy() : {};
        const idle = Object.keys(busy).length === 0;
        window.__agentIdleStreak = idle ? (window.__agentIdleStreak ?? 0) + 1 : 0;
        return window.__agentIdleStreak >= 2;
      },
      null,
      { timeout: SCREEN_READY_TIMEOUT_MS, polling: 100 },
    )
    .catch(() => {});
  await page.evaluate(() => { window.__agentIdleStreak = 0; }).catch(() => {});
}

export async function settle(page) {
  const agent = await agentPresent(page);
  if (agent) {
    await agentIdle(page);
    const here = new URL(page.url()).pathname;
    if (await agentSettle(page, rootlessPaths.has(here) ? 0 : SCREEN_APPEAR_TIMEOUT_MS)) {
      rootlessPaths.delete(here);
      return;
    }
    rootlessPaths.add(here);
    shared.stepRootless = here;
  }
  // The SPA polls statuses constantly, `networkidle` never comes. A page without a screen root
  // has no readiness sign - a pause; shorter in agent mode: step waits poll by themselves.
  await page.waitForTimeout(agent ? ROOTLESS_PAUSE_MS : 1200);
}

/** A pause after a step on a page without a `data-state` root. */
export const ROOTLESS_PAUSE_MS = 500;

// An element with a role wins over a text with the same spelling: a caption in a card comes in the
// markup before an item of an open menu and otherwise intercepts the click: a list row would go red when its rows get a caption.
export const ROLE_FIRST_TIMEOUT_MS = 1500;

/** The time within which a testid element must appear before the step names a reason. */
export const TESTID_APPEAR_MS = 15000;

/** An element by testid; with name/item - the one whose name matched. None - a failure with the reason from `labelProblem`. */
export async function locateTestid(page, target, timeoutMs = TESTID_APPEAR_MS) {
  const all = page.getByTestId(target.testid);
  const deadline = Date.now() + timeoutMs;
  let problem;
  do {
    const infos = (await agentPresent(page)) ? await agentFindShown(page, { testid: target.testid }) : [];
    problem = (await agentPresent(page)) ? labelProblem(infos, target) : (await all.filter({ visible: true }).count()) ? null : `element ${target.testid} is not on the page`;
    if (!problem) break;
    await page.waitForTimeout(200);
  } while (Date.now() < deadline);
  if (problem) throw new Error(problem);
  const wanted = target.name ?? target.item;
  // A zero-size field (a chip component) is clicked by its caption - its box is what window.__agent returns.
  const label = page.locator(`[data-testid="${target.testid}"] + label, label:has(> [data-testid="${target.testid}"])`);
  if (!wanted) return all.filter({ visible: true }).or(label.filter({ visible: true })).first();
  // `name` is the exact label, `item` is a name or text that contains the data; `pickByTestid` selects the same way.
  const byName = TESTID_ROLES.map((role) => page.getByRole(role, { name: wanted, exact: Boolean(target.name) })).reduce((acc, next) => acc.or(next));
  const picked = all.and(byName);
  // a testid on a caption without a role (a segmented control: a span in a label) - by exact text; the label was already checked by labelProblem.
  const exact = new RegExp(`^\\s*${wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
  const found = picked.or(all.filter({ hasText: target.item ? wanted : exact }));
  // A zero-size checkbox with name has the same caption (one testid, the label was already checked).
  return (target.name ? found.or(label) : found).filter({ visible: true }).first();
}

/** Roles by which a testid target is checked against name/item. */
export const TESTID_ROLES = ["button", "link", "tab", "menuitem", "option", "checkbox", "radio", "switch", "textbox", "combobox"];

/** Roles that `observe` returns by label (`labels`) when the element has no testid by the scheme. */
export const LABEL_ROLES = ["button", "link", "tab", "menuitem", "checkbox", "radio", "switch"];
export async function locate(page, target) {
  if (testidTarget(target)) return locateTestid(page, target);
  if (typeof target === "object" && "selector" in target) return page.locator(target.selector).first();
  if (typeof target === "object") return namedLocator(page, target);
  // option, combobox, textbox - choosing from a dropdown: click the field by name,
  // then the item by name (required fields of a form).
  const byRole = ["button", "link", "tab", "menuitem", "option", "combobox", "textbox", "checkbox", "radio", "switch"]
    .map((role) => page.getByRole(role, { name: target, exact: true }))
    .reduce((acc, next) => acc.or(next));
  const hasRole = await byRole
    .first()
    .waitFor({ state: "visible", timeout: ROLE_FIRST_TIMEOUT_MS })
    .then(() => true, () => false);
  if (hasRole) return byRole.first();
  // A hidden input (a switch component) comes in the markup before its caption: the visible element is taken.
  return byRole.or(page.getByText(target, { exact: true })).filter({ visible: true }).first();
}

/** An element by role and name (`contains` - the name as a substring) or the first choice button without a mark. */
export function namedLocator(page, target) {
  if ("pressed" in target) {
    return page.getByRole(target.role ?? "button").and(page.locator('[aria-pressed="false"]')).first();
  }
  const roles = target.role ? [target.role] : ["button", "link", "tab", "menuitem", "option", "combobox", "textbox", "checkbox", "radio", "switch"];
  return roles
    .map((role) => page.getByRole(role, { name: target.name, exact: target.contains !== true }))
    .reduce((acc, next) => acc.or(next))
    .first();
}

/** The run state shared by steps: tabs, the page request log, cut responses. One tab until the tab step opens a second. */
export const session = { context: null, pages: [], current: 0, requests: [], navigations: [], cuts: [], watch: () => {} };
export const REQUESTED_SETTLE_MS = 1500;

/** How many page requests end with `suffix` (a path); `method` - only with this method. */
export function requestCount(requests, suffix, method) {
  return requests.filter((r) => r.path.endsWith(suffix) && (!method || r.method === method)).length;
}

/** Why the request count is wrong; null means as expected. Without `times` at least one is expected, with `times` exactly that many. */
export function requestedProblem(count, times, suffix) {
  if (times === undefined) return count >= 1 ? null : `no requests for "${suffix}"`;
  return count === times ? null : `requests for "${suffix}": ${count}, expected ${times}`;
}

/** The tab the steps run on. A second one can be opened once. */
export async function switchTab(base, page, action) {
  if (action === "open") {
    if (session.pages.length > 1) throw new Error("the second tab is already open");
    const next = await session.context.newPage();
    session.watch(next);
    const here = new URL(page.url());
    await perform(next, base, { kind: "goto", target: here.pathname + here.search });
    session.pages.push(next);
    session.current = 1;
    return;
  }
  const index = action === "first" ? 0 : 1;
  if (!session.pages[index]) throw new Error(`tab "${action}" does not exist: first {"tab": "open"}`);
  session.current = index;
  await session.pages[index].bringToFront();
}

/** What is visible after a step: the screen (`{name, state}` or null) and the visible testids of the form `<area>.<action>`. */
export async function observe(page) {
  if (!(await agentPresent(page))) return { screen: null, testids: [], elements: [] };
  const screen = await agentScreen(page);
  const all = await agentFindShown(page, {});
  const shown = all.filter((e) => e.testid && RE_TESTID.test(e.testid) && !e.testid.startsWith("screen."));
  // Input fields do not get a testid (testids are on buttons); the model types by the field caption: {"fill": "<caption>"}.
  const fields = all.filter((e) => !e.testid && FIELD_ROLES.includes(e.role) && String(e.name ?? "").trim());
  // Items of an open list are data (a person's name, an item name): they have no testid, they are chosen by name
  // {"click": {"role": "option", "name": "{substitution}", "contains": true}}. Headings - where the model is.
  const text = (e) => String(e.name || e.text || "").trim().slice(0, 80);
  const options = all.filter((e) => !e.testid && e.role === "option" && text(e));
  // Buttons and links without a testid by the scheme (screens not yet instrumented, old-style testids): by label - otherwise the model
  // sees an empty screen (a button of a dialog was missing from the answer).
  const labels = all.filter((e) => !(e.testid && RE_TESTID.test(e.testid)) && LABEL_ROLES.includes(e.role) && text(e));
  const headings = all.filter((e) => e.role === "heading").map(text).filter(Boolean);
  return {
    screen: screen ? { name: screen.name, state: screen.state } : null,
    testids: [...new Set(shown.map((e) => e.testid))],
    elements: shown.map((e) => ({ testid: e.testid, role: e.role, name: String(e.name ?? "").slice(0, 80), ...(e.aria?.disabled ? { disabled: true } : {}) })),
    fields: [...new Map(fields.map((e) => [String(e.name).trim(), { field: String(e.name).trim().slice(0, 80), role: e.role, ...(e.aria?.disabled ? { disabled: true } : {}) }])).values()],
    ...(options.length ? { options: [...new Set(options.map(text))].slice(0, 30) } : {}),
    ...(labels.length ? { labels: [...new Map(labels.map((e) => [text(e), { label: text(e), role: e.role, ...(e.aria?.disabled ? { disabled: true } : {}) }])).values()].slice(0, 30) } : {}),
    ...(headings.length ? { headings: [...new Set(headings)].slice(0, 10) } : {}),
    // Layers on top of the screen (a dialog, an open list): a click under them will be covered.
    ...(screen?.overlays?.length ? { overlays: screen.overlays } : {}),
    ...(screen?.facts && Object.keys(screen.facts).length ? { facts: screen.facts } : {}),
  };
}

/** Waits for the step's `after`; if it does not occur in time - a failure of this step with what is visible instead. */
export async function awaitAfter(page, after) {
  if (!(await agentPresent(page))) throw new Error("after requires window.__agent: legacy mode (--legacy) does not check it");
  const deadline = Date.now() + after.within * 1000;
  let problem;
  do {
    const seen = await observe(page);
    problem = afterProblem(after, seen);
    if (!problem) return;
    if (seen.screen?.state === "error") break;
    await page.waitForTimeout(200);
  } while (Date.now() < deadline);
  throw new Error(problem);
}

/** The step is skipped: the optional target is not on the page. `after` of such a step is not checked. */
export const SKIPPED = "skipped";

export async function perform(page, base, step) {
  const outcome = await performStep(page, base, step);
  if (step.after && outcome !== SKIPPED) await awaitAfter(session.pages[session.current] ?? page, step.after);
  return outcome;
}

export async function performStep(page, base, rawStep) {
  // The `within` deadlines are meant for a live model; during replay the response is there at once, and a red step must not wait for minutes.
  const step = session.replay && rawStep.within > REPLAY_WITHIN_S ? { ...rawStep, within: REPLAY_WITHIN_S } : rawStep;
  const { kind, target, value } = step;
  if (kind === "goto") {
    await page.goto(base + target, { waitUntil: "domcontentloaded" });
    // The agent object is installed after the module loads; a build without the flag does not install it at all.
    if (shared.legacyReason === null) {
      const waitAgent = () => page.waitForFunction(() => window.__agent, null, { timeout: AGENT_APPEAR_TIMEOUT_MS }).then(() => true, () => false);
      // A page sometimes loads without the agent object;
      // one repeated visit tells a load failure from a build without the flag - such a build has no object after it either.
      const appeared = (await waitAgent()) || (await page.goto(base + target, { waitUntil: "domcontentloaded" }).then(waitAgent, () => false));
      if (!appeared) {
        throw new Error(`no window.__agent on page ${target}: a frontend build without VITE_AGENT_API=1; legacy mode - the --legacy "reason" key`);
      }
    }
  } else if (kind === "click") {
    if (step.optional && testidTarget(target)) {
      const found = await locateTestid(page, target, OPTIONAL_TIMEOUT_MS).catch(() => null);
      if (!found) return SKIPPED;
    }
    const element = await locate(page, target);
    if (step.optional) {
      const present = await element
        .waitFor({ state: "visible", timeout: OPTIONAL_TIMEOUT_MS })
        .then(() => true, () => false);
      if (!present) return SKIPPED;
    }
    shared.failTarget = { locator: element };
    if (await agentPresent(page)) {
      await element.waitFor({ state: "visible", timeout: 15000 });
      const enabled = await page
        .waitForFunction((el) => el && !el.disabled && el.getAttribute("aria-disabled") !== "true", await element.elementHandle(), {
          timeout: DISABLED_GRACE_MS,
          polling: 100,
        })
        .then(() => true, () => false);
      const blocked = clickBlockedProblem(enabled, targetLabel(target));
      if (blocked) throw new Error(blocked);
      await assertNotOccluded(page, element, target);
    }
    // The accessible name of a multi-select field sits on the inner input, and on top
    // it is covered by a wrapper of the same field: a person clicks the wrapper, Playwright waits for
    // the input and fails on "intercepts pointer events".
    // An ancestor of the target itself - click at the same point as a person; a foreign element on top
    // is still a failure.
    // The same with the selected chips of the field: they lie inside the same wrapper over the
    // input. Then - a free point of the wrapper where the field itself is on top.
    const coverPoint = await element
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        const top = document.elementFromPoint(cx, cy);
        if (!top || top === el || el.contains(top)) return null;
        if (top.contains(el)) return { x: cx, y: cy };
        const field = el.parentElement?.closest('[class*="Input-input"], [class*="MultiSelect-input"], [class*="PillsInput"]');
        if (!field || !field.contains(top)) return null;
        const box = field.getBoundingClientRect();
        for (let x = box.right - 6; x > box.left; x -= 12) {
          const hit = document.elementFromPoint(x, box.y + box.height / 2);
          if (hit && field.contains(hit) && !hit.closest('[class*="Pill"]')) return { x, y: box.y + box.height / 2 };
        }
        return null;
      })
      .catch(() => null);
    if (coverPoint) await page.mouse.click(coverPoint.x, coverPoint.y);
    else await element.click({ timeout: 15000 });
  } else if (kind === "fill") {
    // The field - by role and exact name, as window.__agent.find() sees it; the caption
    // and the hint are the fallback path. getByLabel once failed to find a wizard
    // field that find() reported as a textbox with the same name.
    const field =
      testidTarget(target)
        ? await locateTestid(page, target, step.optional ? OPTIONAL_TIMEOUT_MS : TESTID_APPEAR_MS).catch((error) => {
            if (step.optional) return null;
            throw error;
          })
        : typeof target === "object"
        ? "selector" in target
          ? page.locator(target.selector).first()
          : namedLocator(page, target)
        : await (async () => {
            // A caption by substring (getByLabel) also catches a button "Hint: <name>" before the field itself:
            // it is the fallback path, used when there is no field with such a name and role.
            const byRole = page
              .getByRole("textbox", { name: target, exact: true })
              .or(page.getByRole("combobox", { name: target, exact: true }))
              .or(page.getByRole("spinbutton", { name: target, exact: true }));
            const found = await byRole.first().waitFor({ state: "attached", timeout: ROLE_FIRST_TIMEOUT_MS }).then(() => true, () => false);
            return found ? byRole.first() : page.getByLabel(target).or(page.getByPlaceholder(target)).first();
          })();
    if (!field) return SKIPPED;
    if (step.optional) {
      const present = await field.waitFor({ state: "visible", timeout: OPTIONAL_TIMEOUT_MS }).then(() => true, () => false);
      if (!present) return SKIPPED;
    }
    await field.fill(value, { timeout: (step.within ?? 15) * 1000 });
  } else if (kind === "press") {
    await page.keyboard.press(target);
  } else if (kind === "download") {
    const element = await locate(page, target);
    const [file] = await Promise.all([
      page.waitForEvent("download", { timeout: WAIT_TEXT_S * 1000 }),
      element.click({ timeout: 15000 }),
    ]);
    const title = await page.locator(step.named.selector).first().innerText({ timeout: 15000 });
    const problem = downloadNameProblem(file.suggestedFilename(), title);
    if (problem) throw new Error(problem);
  } else if (kind === "described") {
    // The description is what a screen reader reads: the text of the elements pointed to by the field's aria-describedby.
    const fields = page
      .getByRole("textbox", { name: target, exact: true })
      .or(page.getByRole("combobox", { name: target, exact: true }))
      .or(page.getByRole("spinbutton", { name: target, exact: true }));
    const deadline = Date.now() + EXPECT_TIMEOUT_MS;
    let problem;
    do {
      await settle(page);
      const seen = await fields
        .evaluateAll((nodes) =>
          nodes.map((n) =>
            (n.getAttribute("aria-describedby") || "")
              .split(/\s+/)
              .filter(Boolean)
              .map((id) => document.getElementById(id)?.textContent ?? "")
              .join(" "),
          ),
        )
        .catch(() => []);
      problem = describedProblem(seen, step.has);
    } while (problem && Date.now() < deadline);
    if (problem) throw new Error(problem);
    return;
  } else if (kind === "hover") {
    await (await locate(page, target)).hover({ timeout: 15000 });
  } else if (kind === "repeat") {
    const reached = async () => (await page.locator("body").innerText().catch(() => "")).includes(step.until);
    for (let turn = 0; turn < step.max; turn += 1) {
      if (await reached()) return;
      for (const inner of target) await perform(page, base, inner);
      await settle(page);
    }
    if (!(await reached())) throw new Error(`text "${step.until}" is absent after ${step.max} repeats`);
  } else if (kind === "same-href") {
    const deadline = Date.now() + EXPECT_TIMEOUT_MS;
    let problem;
    do {
      const hrefs = [];
      for (const selector of target) {
        hrefs.push(await page.locator(selector).first().getAttribute("href", { timeout: EXPECT_TIMEOUT_MS }).catch(() => null));
      }
      problem = sameHrefProblem(hrefs[0], hrefs[1]);
      if (problem) await page.waitForTimeout(500);
    } while (problem && Date.now() < deadline);
    if (problem) throw new Error(problem);
  } else if (kind === "hold") {
    await page.route((url) => url.pathname.includes(target), async (route) => {
      await new Promise((resolve) => setTimeout(resolve, step.ms));
      // fallback, not continue: when responses are replaced (--replay-api) the request goes on to the replay, not past it into the network.
      await route.fallback().catch(() => {});
    });
  } else if (kind === "cut") {
    session.cuts.push({ suffix: target, used: false });
  } else if (kind === "advance") {
    if (session.replay && !session.replay.advance(target)) throw new Error(`advance ${target}: the records have no GET with this address that changes the response`);
  } else if (kind === "tab") {
    await switchTab(base, page, target);
  } else if (kind === "visibility") {
    await page.evaluate((value) => {
      const hidden = value === "hidden";
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
      document.dispatchEvent(new Event("visibilitychange"));
    }, target);
  } else if (kind === "requested") {
    const deadline = Date.now() + EXPECT_TIMEOUT_MS;
    let problem;
    do {
      problem = requestedProblem(requestCount(session.requests, target, step.method), step.times, target);
      if (problem) await page.waitForTimeout(250);
    } while (problem && Date.now() < deadline);
    // The required number is reached: one more moment for an extra request, otherwise "exactly this many" would be confirmed too early.
    if (!problem && step.times !== undefined) {
      await page.waitForTimeout(REQUESTED_SETTLE_MS);
      problem = requestedProblem(requestCount(session.requests, target, step.method), step.times, target);
    }
    if (problem) throw new Error(problem);
  } else if (kind === "upload") {
    const file = path.join(UPLOAD_DIR, target);
    if (!fs.existsSync(file)) throw new Error(`file ${target} is not in the scenario files directory`);
    await page.locator(step.to ? step.to.selector : UPLOAD_DEFAULT).first().setInputFiles(file, { timeout: 15000 });
  } else if (AGENT_KINDS.includes(kind) && agentTarget(step) && (await agentPresent(page))) {
    await expectViaAgent(page, step);
    return;
  } else if (TICK_KINDS.includes(kind) && testidTarget(target)) {
    // In checkbox/radio components the testid is on the input; on the wrapper - the nested input is taken; in a segmented control
    // the testid is on a caption inside a label, and the radio is next to it - the field of this label is taken.
    const element = await locateTestid(page, target);
    const deadline = Date.now() + EXPECT_TIMEOUT_MS;
    let problem;
    do {
      const tick = await element
        .evaluate((el) => {
          const input = el.matches("input")
            ? el
            : (el.querySelector("input[type=checkbox], input[type=radio]") ?? el.closest("label")?.control ?? null);
          return input ? { checked: input.checked === true, focused: input === document.activeElement } : null;
        })
        .catch(() => null);
      problem = tickProblem(tick ? [tick] : [], targetLabel(target), kind);
      if (problem) await page.waitForTimeout(200);
    } while (problem && Date.now() < deadline);
    if (problem) throw new Error(problem);
    return;
  } else if (kind === "wait" && testidTarget(target)) {
    // Polling find(): a visible element with the testid (and the label, if named); a screen in error aborts the wait.
    const deadline = Date.now() + (step.within ?? WAIT_TEXT_S) * 1000;
    let problem;
    do {
      if (!(await agentPresent(page))) {
        problem = (await page.getByTestId(target.testid).filter({ visible: true }).count()) ? null : `element ${target.testid} is not on the page`;
      } else {
        problem = labelProblem(await agentFindShown(page, { testid: target.testid }), target);
        if (problem && (await agentScreen(page))?.state === "error") {
          throw new Error(screenProblem(await agentScreen(page)) ?? problem);
        }
      }
      if (problem) await page.waitForTimeout(250);
    } while (problem && Date.now() < deadline);
    if (problem && step.optional) return SKIPPED;
    if (problem) throw new Error(problem);
  } else if (kind === "fact") {
    // A screen fact (`data-fact` in the frontend): mode, step number - what is not visible from the elements.
    if (!(await agentPresent(page))) throw new Error("fact requires window.__agent");
    const deadline = Date.now() + EXPECT_TIMEOUT_MS;
    let problem;
    do {
      await settle(page);
      const facts = (await agentScreen(page))?.facts ?? {};
      const wrong = Object.entries(target).filter(([name, value]) => facts[name] !== value);
      problem = wrong.length
        ? `screen fact: expected ${wrong.map(([n, v]) => `${n}=${v}`).join(", ")}, but the screen has ${JSON.stringify(facts)}`
        : null;
      if (problem) await page.waitForTimeout(250);
    } while (problem && Date.now() < deadline);
    if (problem) throw new Error(problem);
    return;
  } else if (["order", "absent", "active", "disabled", "enabled", "field", "filled", ...SEEN_KINDS, ...TICK_KINDS].includes(kind)) {
    if (testidTarget(target) || (Array.isArray(target) && target.some(testidTarget))) {
      throw new Error(`${kind} with {"testid": …} requires window.__agent: legacy mode (--legacy) cannot check this`);
    }
    const problemOf = {
      order: orderProblem, absent: absentProblem, active: activeProblem, disabled: disabledProblem,
      field: (values) => fieldProblem(values, step.has),
      enabled: enabledProblem, filled: filledProblem,
      visible: (count) => seenProblem(count, "visible"), hidden: (count) => seenProblem(count, "hidden"),
      ...Object.fromEntries(TICK_KINDS.map((tick) => [tick, (ticks, item) => tickProblem(ticks, item, tick)])),
    }[kind];
    const deadline = Date.now() + EXPECT_TIMEOUT_MS;
    let problem;
    do {
      await settle(page);
      const seen =
        kind === "active"
          ? await page
              .locator('nav [aria-current="page"], aside [aria-current="page"]')
              .evaluateAll((nodes) => nodes.map((n) => (n.innerText || n.getAttribute("aria-label") || "").trim()))
              .catch(() => [])
          : SEEN_KINDS.includes(kind)
            ? await page
                .locator(target.selector)
                .evaluateAll((nodes) => nodes.filter((n) => (n.checkVisibility ? n.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : n.offsetParent !== null)).length)
                .catch(() => 0)
          : kind === "field" || kind === "filled"
            ? await (typeof target === "object" ? page.locator(target.selector) : page.getByLabel(target).or(page.getByPlaceholder(target)))
                .evaluateAll((nodes) => nodes.map((n) => String(n.value ?? "")))
                .catch(() => [])
          : TICK_KINDS.includes(kind)
            ? await page
                .getByRole("checkbox", { name: target })
                .or(page.getByRole("radio", { name: target }))
                .evaluateAll((nodes) => nodes.map((n) => ({ checked: n.checked === true, focused: n === document.activeElement })))
                .catch(() => [])
          : kind === "disabled" || kind === "enabled"
            ? await page
                .getByRole("button", { name: target, exact: true })
                .evaluateAll((nodes) => nodes.map((n) => n.disabled === true || n.getAttribute("aria-disabled") === "true" || n.hasAttribute("data-disabled")))
                .catch(() => [])
            : await page.locator("body").innerText().catch(() => "");
      problem = problemOf(seen, target);
      // "No text" on a fully rendered page is an answer at once; "present" and "empty" are rechecked until the deadline.
    } while (problem && Date.now() < deadline);
    if (problem) throw new Error(problem);
    return;
  } else if (typeof target === "number") {
    await page.waitForTimeout(target);
  } else if (await agentPresent(page)) {
    // We wait for the text, but a screen in error aborts the wait: nothing to wait for.
    const came = await page.waitForFunction(
      (text) => document.body.textContent.toLowerCase().includes(text.toLowerCase()) || window.__agent?.screen()?.state === "error",
      target,
      { timeout: (step.within ?? WAIT_TEXT_S) * 1000 },
    ).then(() => true, (error) => {
      if (step.optional) return false;
      throw error;
    });
    if (!came) return;
    const has = await page.evaluate((text) => document.body.textContent.toLowerCase().includes(text.toLowerCase()), target);
    const problem = has ? null : screenProblem(await agentScreen(page));
    if (problem) throw new Error(problem);
  } else {
    const came = await page.getByText(target).first().waitFor({ timeout: (step.within ?? WAIT_TEXT_S) * 1000 }).then(() => true, (error) => {
      if (step.optional) return false;
      throw error;
    });
    if (!came) return;
  }
  await settle(page);
}

/** Which element is named in the step failure: `{locator}` or `{rect}` from `find()`; the snapshot is cut by it. */

/** Steps that read `find()` rather than the page text when `window.__agent` is present. */
export const AGENT_KINDS = ["order", "absent", "disabled", "enabled", "field", "filled"];

/** How many seconds a wait step with a text waits if `within` is not named. */
export const WAIT_TEXT_S = 60;

/** How long to wait for `window.__agent` after a navigation. */
export const AGENT_APPEAR_TIMEOUT_MS = 30000;

/** Field roles that field and filled look up by name. */
export const FIELD_ROLES = ["textbox", "combobox", "searchbox"];

/** Whether the step target is read through `find()`: a field by CSS selector is not. */
export function agentTarget(step) {
  if (step.kind !== "field" && step.kind !== "filled") return true;
  return typeof step.target === "string" || Boolean(step.target?.testid);
}

/** The center of the box belongs to an element with this name (or its descendant): the click will arrive there. */
export async function centerHitsTarget(page, rect, name) {
  return page
    .evaluate(
      ({ x, y, w, h, name }) => {
        const hit = document.elementFromPoint(x + w / 2, y + h / 2);
        if (!hit) return false;
        const owner = hit.closest("button, a, [role=tab], [role=menuitem], [role=option], [role=button], [role=link]");
        const label = (owner?.getAttribute("aria-label") ?? owner?.textContent ?? "").replace(/\s+/g, " ").trim();
        return Boolean(owner) && (label === name || label.startsWith(name));
      },
      { ...rect, name },
    )
    .catch(() => false);
}

/** What lies at the centre of the target and which dialogs are open: a direct answer to what covers it, instead of a nameless div */
export async function coverDetails(page, rect) {
  if (!rect) return null;
  return page
    .evaluate(
      ({ x, y, w, h }) => {
        const hit = document.elementFromPoint(x + w / 2, y + h / 2);
        const shown = (e) => e.getBoundingClientRect().width > 0;
        const title = (e) => (e.getAttribute("aria-label") ?? document.getElementById(e.getAttribute("aria-labelledby") ?? "")?.textContent ?? e.querySelector("h1, h2, h3, [role=heading]")?.textContent ?? e.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
        const dialogs = [...document.querySelectorAll("[role=dialog], [aria-modal=true]")].filter(shown).map(title);
        if (!hit) return { dialogs };
        const style = getComputedStyle(hit);
        const box = hit.getBoundingClientRect();
        const owner = hit.closest("[data-testid], [role=dialog], [aria-label]");
        return {
          element: [hit.tagName.toLowerCase(), ...[...hit.classList].slice(0, 2)].join("."),
          position: style.position,
          size: `${Math.round(box.width)}x${Math.round(box.height)}`,
          zIndex: style.zIndex,
          inside: owner ? owner.getAttribute("data-testid") ?? title(owner) : null,
          dialogs,
        };
      },
      rect,
    )
    .catch(() => null);
}

/** While the element is covered (for example, a dialog is still sliding in), we wait; if it does not clear - a failure naming the covering element. */
export async function assertNotOccluded(page, element, target) {
  await element.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  const testid = await element.getAttribute("data-testid", { timeout: 1000 }).catch(() => null);
  const query = testid ? { testid } : typeof target === "string" ? { name: target } : null;
  if (!query) return;
  let problem = null;
  for (let attempt = 0; attempt < OCCLUSION_GRACE_MS / 250; attempt += 1) {
    const infos = (await agentFind(page, query)).filter((e) => testid || (e.name === target && CLICK_ROLES.includes(e.role)));
    const info = infos.find((e) => e.inViewport) ?? infos[0];
    problem = occlusionProblem(info);
    // The box is covered at the corners (rounded edges, a neighbouring block by a couple of pixels), but the click
    // goes to the center: if the element itself is at the center, the click will arrive.
    if (problem && info?.rect && (await centerHitsTarget(page, info.rect, info.name))) return;
    if (!problem) return;
    shared.failTarget = { rect: info.rect };
    await page.waitForTimeout(250);
  }
  throw new Error(`${problem}${coverLine(await coverDetails(page, shared.failTarget?.rect))}`);
}

/** What `find()` says about a wait step: the problem (null - all as expected) and the box of the named element. */
export async function agentVerdict(page, step) {
  const { kind, target } = step;
  if (kind === "order") {
    // A testid element is one order line; the text can still split into lines (orderLines).
    const parts = target.map((item) => (testidTarget(item) ? [item] : orderLines([item])));
    const lines = parts.flat();
    const lists = await Promise.all(
      lines.map(async (item) => (testidTarget(item) ? pickByTestid(await agentFindShown(page, { testid: item.testid }), item) : agentFindShown(page, { text: item }))),
    );
    const labels = lines.map((item) => (testidTarget(item) ? targetLabel(item) : item));
    const texts = Object.fromEntries(lists.flat().map((e) => [e.domIndex, e.text]));
    return { problem: orderProblemByHits(lists.map((l) => l.map((e) => e.domIndex)), labels, texts), rect: lists.flat()[0]?.rect };
  }
  if (kind === "absent") {
    const found = testidTarget(target) ? pickByTestid(await agentFindShown(page, { testid: target.testid }), target) : await agentFindShown(page, { text: target });
    const alive = found.length > 0 || (await agentFind(page, {})).length > 0;
    return { problem: absentProblemByCount(found.length, alive, targetLabel(target)), rect: found[0]?.rect };
  }
  if (kind === "disabled" || kind === "enabled") {
    const infos = testidTarget(target)
      ? pickByTestid(await agentFindShown(page, { testid: target.testid }), target)
      : (await agentFind(page, { role: "button", name: target })).filter((e) => e.name === target);
    const states = infos.map((e) => e.aria.disabled === true);
    return { problem: (kind === "disabled" ? disabledProblem : enabledProblem)(states, targetLabel(target)), rect: infos[0]?.rect };
  }
  // A field by name: an exact match wins over a substring ("Title" and "Title of the page").
  const named = typeof target === "string" ? (await agentFind(page, { name: target })).filter((e) => FIELD_ROLES.includes(e.role)) : [];
  const infos =
    typeof target === "string"
      ? named.some((e) => e.name === target) ? named.filter((e) => e.name === target) : named
      : await agentFind(page, { testid: target.testid });
  const values = infos.map((e) => String(e.value ?? ""));
  return { problem: kind === "field" ? fieldProblem(values, step.has) : filledProblem(values), rect: infos[0]?.rect };
}

export async function expectViaAgent(page, step) {
  const deadline = Date.now() + EXPECT_TIMEOUT_MS;
  let verdict;
  do {
    await settle(page);
    verdict = await agentVerdict(page, step);
    if (verdict.problem) await page.waitForTimeout(200);
  } while (verdict.problem && Date.now() < deadline);
  if (verdict.problem) {
    shared.failTarget = verdict.rect ? { rect: verdict.rect } : null;
    throw new Error(verdict.problem);
  }
}

/** A failure snapshot: only the area of the named element; no element - the visible part of the page. */
export async function failureShot(page, file) {
  let box = null;
  if (shared.failTarget?.rect) {
    const { x, y, w, h } = shared.failTarget.rect;
    const [scrollX, scrollY] = await page.evaluate(() => [window.scrollX, window.scrollY]).catch(() => [0, 0]);
    box = { x: x + scrollX, y: y + scrollY, width: w, height: h };
  } else if (shared.failTarget?.locator) {
    const found = await shared.failTarget.locator.boundingBox({ timeout: 2000 }).catch(() => null);
    const [scrollX, scrollY] = await page.evaluate(() => [window.scrollX, window.scrollY]).catch(() => [0, 0]);
    box = found && { ...found, x: found.x + scrollX, y: found.y + scrollY };
  }
  const clip = clipFor(box);
  await page.screenshot(clip ? { path: file, clip, fullPage: true } : { path: file }).catch(() => {});
}
