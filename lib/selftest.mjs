/** Control cases of the executor. No network. */
import fs from "node:fs";

import { API_SAMPLE, ApiReplay, apiDocument, apiRequestKey, foldOverlapping, missLine, parseApiRecords, pendingLine, recordedCall, serverFailureLine, visitsOf } from "./api-records.mjs";
import { chromeOption, givenCredential, requestCount, requestedProblem, rootlessLine, screenMark } from "./browser.mjs";
import { EVIDENCE, apiCallsLine, apiFailuresLine, buildEvidence, evidenceProblems, isChunkError, timeoutReason } from "./evidence.mjs";
import { fillValues, sessionMoveProblem } from "./session.mjs";
import { HOLD_MAX_MS, TESTID_KINDS, absentProblem, absentProblemByCount, activeProblem, afterOf, afterProblem, checkBase, clickBlockedProblem, clipFor, describedProblem, disabledProblem, downloadNameProblem, enabledProblem, fieldProblem, filledProblem, labelProblem, legacyProblem, observedAfter, coverLine, occlusionProblem, orderLines, orderProblem, orderProblemByHits, parseStep, sameHrefProblem, screenPending, screenProblem, seenProblem, targetLabel, tickProblem } from "./steps.mjs";
export function selftest() {
  const cases = [
    [
      "recordings: secrets are masked in query, request body and response, and replay still matches",
      () => {
        const call = recordedCall("POST", "http://x/api/login?token=abc&a=1", '{"password":"hunter2","user":"u"}', "application/json", 200, "application/json", '{"access_token":"t0p","me":"u"}');
        const text = JSON.stringify(call);
        for (const leak of ["hunter2", "abc", "t0p"]) if (text.includes(leak)) throw new Error(`leaked ${leak}: ${text}`);
        const other = apiRequestKey("POST", "http://y/api/login?token=zzz&a=1", '{"password":"other","user":"u"}', "application/json");
        if (other !== JSON.stringify([call.method, call.path, call.query, call.body])) throw new Error("replay key differs");
      },
      true,
    ],
    ["foreign host refused", () => checkBase("https://other.example.com"), false],
    ["localhost accepted", () => checkBase("http://localhost:5173"), true],
    ["step with two kinds rejected", () => parseStep({ goto: "/a", click: "b" }), false],
    ["step without a kind rejected", () => parseStep({ value: "x" }), false],
    ["fill without value rejected", () => parseStep({ fill: "Name" }), false],
    ["goto without \"/\" rejected", () => parseStep({ goto: "app" }), false],
    ["click accepted", () => parseStep({ click: "Sign in" }), true],
    // A testid target and after.
    ...TESTID_KINDS.map((kind) => [
      `${kind} with testid accepted`,
      () => parseStep({ [kind]: { testid: "checkout.submit" }, ...(kind === "fill" ? { value: "x" } : {}), ...(kind === "download" ? { named: { selector: "h1" } } : {}), ...(kind === "field" ? { has: "x" } : {}) }),
      true,
    ]),
    ["order with testid and text accepted", () => parseStep({ order: [{ testid: "tabs.tab-items" }, "Items"] }), true],
    ["empty testid rejected", () => parseStep({ click: { testid: "" } }), false],
    ["testid without an area rejected", () => parseStep({ click: { testid: "submit" } }), false],
    ["testid with name and item together rejected", () => parseStep({ click: { testid: "a.b", name: "x", item: "y" } }), false],
    ["testid with selector rejected", () => parseStep({ click: { testid: "a.b", selector: "x" } }), false],
    ["testid for active rejected", () => parseStep({ active: { testid: "nav.analytics" } }), false],
    ["wait with an object without testid rejected", () => parseStep({ wait: { selector: "h1" } }), false],
    ["fact with mode and step accepted", () => parseStep({ fact: { mode: "preview", step: "4" } }).kind === "fact", true],
    ["empty fact rejected", () => parseStep({ fact: {} }), false],
    ["fact with a number rejected", () => parseStep({ fact: { step: 4 } }), false],
    ["after for click accepted", () => parseStep({ click: { testid: "a.b" }, after: { screen: "checkout", state: "ready", shown: ["checkout.restart"] } }), true],
    ["after for wait rejected", () => parseStep({ wait: "Text", after: { state: "ready" } }), false],
    ["empty after rejected", () => parseStep({ click: "OK", after: {} }), false],
    ["after with a foreign key rejected", () => parseStep({ click: "OK", after: { text: "x" } }), false],
    ["after with a testid without an area rejected", () => parseStep({ click: "OK", after: { shown: ["restart"] } }), false],
    ["after inside repeat is parsed", () => parseStep({ repeat: [{ click: { testid: "a.b" }, after: { state: "ready" } }], until: "Total" }).target[0].after.state === "ready", true],
    [
      "labelProblem: no element, foreign label, no data; a match is null",
      () => {
        const infos = [{ name: "Next step", text: "Next step" }];
        if (labelProblem([], { testid: "a.b" }) !== "element a.b is not on the page") throw new Error("no element");
        const label = labelProblem(infos, { testid: "a.b", name: "Submit answer" });
        if (!(label.includes("\"Next step\"") && label.includes("\"Submit answer\"") && label.startsWith("label of a.b"))) throw new Error(label);
        if (!labelProblem(infos, { testid: "a.b", item: "Option 2" }).startsWith("a.b with \"Option 2\" is absent")) throw new Error("item");
        if (labelProblem(infos, { testid: "a.b", name: "Next step" }) !== null) throw new Error("match rejected");
        return labelProblem(infos, { testid: "a.b" }) === null;
      },
      true,
    ],
    [
      "afterProblem: wrong screen, state, did not appear, did not disappear; everything in place - null",
      () => {
        const after = afterOf({ screen: "checkout", state: "ready", shown: ["a.x"], gone: ["a.y"] }, {});
        const ok = { screen: { name: "checkout", state: "ready" }, testids: ["a.x"] };
        if (afterProblem(after, ok) !== null) throw new Error("occurred after rejected");
        const bad = afterProblem(after, { screen: { name: "people", state: "loading" }, testids: ["a.y"] });
        return ["screen checkout", "state ready", "did not appear: a.x", "did not disappear: a.y"].every((part) => bad.includes(part));
      },
      true,
    ],
    [
      "observedAfter: screen, state and the testids that appeared, the screen's own first",
      () => {
        const seen = observedAfter({ testids: ["a.x"] }, { screen: { name: "people", state: "ready" }, testids: ["a.x", "a.y"] });
        const ownFirst = observedAfter({ testids: [] }, { screen: { name: "people", state: "ready" }, testids: ["nav.a", "nav.b", "nav.c", "people.add"] });
        return JSON.stringify(seen) === JSON.stringify({ screen: "people", state: "ready", shown: ["a.y"] }) && ownFirst.shown[0] === "people.add";
      },
      true,
    ],
    [
      "session: declared transitions pass, undeclared ones do not",
      () => sessionMoveProblem("ready", "busy") === null && sessionMoveProblem("busy", "dirty") === null && sessionMoveProblem("dirty", "busy") === null && sessionMoveProblem("closed", "ready") !== null && sessionMoveProblem("busy", "closed") !== null && sessionMoveProblem("dirty", "ready") !== null,
      true,
    ],
    ["fillValues substitutes values with quotes", () => fillValues({ click: { testid: "a.b", item: "{t}" } }, { t: 'Item "A"' }).click.item === 'Item "A"', true],
    ["order from a single text rejected", () => parseStep({ order: ["Create"] }), false],
    ["order accepted", () => parseStep({ order: ["Create", "Library"] }), true],
    ["absent without a text rejected", () => parseStep({ absent: "" }), false],
    ["upload with a file name accepted", () => parseStep({ upload: "sample.txt" }), true],
    ["hover accepted", () => parseStep({ hover: "Build" }), true],
    ["same-href accepted", () => parseStep({ "same-href": ["a.x", "a.y"] }), true],
    ["same-href from a single selector rejected", () => parseStep({ "same-href": ["a.x"] }), false],
    [
      "equal addresses pass, different and unread ones do not",
      () => {
        if (sameHrefProblem("/g?d=1", "/g?d=1") !== null) throw new Error("equal rejected");
        if (sameHrefProblem("/g?d=1", "/g?d=2") === null) throw new Error("different accepted");
        if (sameHrefProblem(null, null) === null) throw new Error("unread accepted");
        return true;
      },
      true,
    ],
    [
      "visits: API requests and pages collected, foreign requests dropped",
      () => {
        const v = visitsOf(
          [{ method: "GET", path: "/api/people" }, { method: "GET", path: "/assets/app.js" }, { method: "GET", path: "/api/people" }],
          ["/app/people"],
          [{ path: "/app/people?x=1" }, { path: "/app/items/7" }],
        );
        return v.api.length === 1 && v.pages.join() === "/app/items/7,/app/people";
      },
      true,
    ],
    ["hold accepted", () => parseStep({ hold: "/attachments", ms: 6000 }), true],
    ["hold without ms rejected", () => parseStep({ hold: "/attachments" }), false],
    ["hold with a delay above the limit rejected", () => parseStep({ hold: "/attachments", ms: HOLD_MAX_MS + 1 }), false],
    ["hold without \"/\" in the address rejected", () => parseStep({ hold: "attachments", ms: 6000 }), false],
    ["cut accepted", () => parseStep({ cut: "/session/answer" }), true],
    ["cut without \"/\" rejected", () => parseStep({ cut: "session/answer" }), false],
    ["tab open accepted", () => parseStep({ tab: "open" }), true],
    ["tab with a foreign value rejected", () => parseStep({ tab: "third" }), false],
    ["visibility hidden accepted", () => parseStep({ visibility: "hidden" }), true],
    ["visibility with a foreign value rejected", () => parseStep({ visibility: "away" }), false],
    ["requested with times accepted", () => parseStep({ requested: "/pause", times: 1 }), true],
    ["requested without \"/\" rejected", () => parseStep({ requested: "pause" }), false],
    ["requested with a fractional times rejected", () => parseStep({ requested: "/pause", times: 1.5 }), false],
    ["times for click rejected", () => parseStep({ click: "Build", times: 1 }), false],
    ["method for requested with a foreign value rejected", () => parseStep({ requested: "/pause", method: "FETCH" }), false],
    [
      "requested turns red: no requests, too few, too many; turns green on a match",
      () => {
        const log = [{ method: "POST", path: "/api/x/pause" }, { method: "POST", path: "/api/x/resume" }, { method: "GET", path: "/api/x/resume" }];
        if (requestedProblem(requestCount(log, "/answer"), undefined, "/answer") === null) throw new Error("there was no request, but the expectation was accepted");
        if (requestedProblem(requestCount(log, "/resume"), 1, "/resume") === null) throw new Error("two requests, one expected, but the expectation was accepted");
        if (requestedProblem(requestCount(log, "/pause"), 2, "/pause") === null) throw new Error("one request, two expected, but the expectation was accepted");
        if (requestedProblem(requestCount(log, "/pause"), 0, "/pause") === null) throw new Error("zero expected, there was a request, but the expectation was accepted");
        if (requestedProblem(requestCount(log, "/resume", "POST"), 1, "/resume") !== null) throw new Error("one POST rejected");
        if (requestedProblem(requestCount(log, "/pause"), undefined, "/pause") !== null) throw new Error("there was a request, but the expectation was rejected");
        return true;
      },
      true,
    ],
    ["ms for click rejected", () => parseStep({ click: "Build", ms: 6000 }), false],
    ["visible without a selector rejected", () => parseStep({ visible: "Hint" }), false],
    ["hidden with a selector accepted", () => parseStep({ hidden: { selector: "[role=tooltip]" } }), true],
    ["filled accepted", () => parseStep({ filled: "Person role" }), true],
    ["described accepted", () => parseStep({ described: "Purpose", has: "Sets" }), true],
    ["download accepted", () => parseStep({ download: "Download", named: { selector: "h1" } }), true],
    ["download without named rejected", () => parseStep({ download: "Download" }), false],
    ["named for click rejected", () => parseStep({ click: "Download", named: { selector: "h1" } }), false],
    [
      "file name by title accepted, a foreign one rejected",
      () => {
        if (downloadNameProblem("Quarterly report.docx", "Quarterly: report") !== null) throw new Error("correct name not accepted");
        if (downloadNameProblem("Unrelated notes.docx", "Report") === null) throw new Error("foreign name accepted");
        return true;
      },
      true,
    ],
    ["described without has rejected", () => parseStep({ described: "Purpose" }), false],
    [
      "field description: has the text, empty, foreign text, no field",
      () => {
        if (describedProblem(["Sets the expected outcome"], "expected outcome") !== null) throw new Error("correct description not recognized");
        if (describedProblem([""], "expected") === null) throw new Error("empty description accepted");
        if (describedProblem(["Other"], "expected") === null) throw new Error("foreign description accepted");
        if (describedProblem([], "expected") === null) throw new Error("missing field accepted");
      },
      true,
    ],
    ["filled with an empty object rejected", () => parseStep({ filled: {} }), false],
    ["filled with testid accepted", () => parseStep({ filled: { testid: "editor.prompt" } }), true],
    ["enabled without a text rejected", () => parseStep({ enabled: "" }), false],
    ["repeat accepted", () => parseStep({ repeat: [{ click: "Next" }], until: "Total", max: 12 }), true],
    ["repeat without until rejected", () => parseStep({ repeat: [{ click: "Next" }] }), false],
    ["repeat inside repeat rejected", () => parseStep({ repeat: [{ repeat: [{ click: "a" }], until: "b" }], until: "c" }), false],
    ["until for a foreign step rejected", () => parseStep({ click: "Next", until: "Total" }), false],
    [
      "enabled button, filled field and visibility",
      () => {
        if (enabledProblem([false], "Assign") !== null) throw new Error("enabled button not recognized");
        if (enabledProblem([true], "Assign") === null) throw new Error("disabled button taken for enabled");
        if (enabledProblem([], "Assign") === null) throw new Error("missing button taken for enabled");
        if (filledProblem(["text"]) !== null) throw new Error("filled field not recognized");
        if (filledProblem(["  "]) === null || filledProblem([]) === null) throw new Error("empty field or its absence taken for filled");
        if (seenProblem(1, "visible") !== null || seenProblem(0, "visible") === null) throw new Error("visible counts wrong");
        if (seenProblem(0, "hidden") !== null || seenProblem(2, "hidden") === null) throw new Error("hidden counts wrong");
      },
      true,
    ],
    ["click by role and name accepted", () => parseStep({ click: { role: "link", name: "Smith", contains: true } }), true],
    ["click on the first choice button accepted", () => parseStep({ click: { role: "button", pressed: false }, optional: true }), true],
    ["click with an empty object rejected", () => parseStep({ click: {} }), false],
    ["click with a foreign object key rejected", () => parseStep({ click: { name: "Smith", nth: 2 } }), false],
    ["contains without a name rejected", () => parseStep({ click: { role: "link", contains: true } }), false],
    ["fill by role and name accepted", () => parseStep({ fill: { role: "textbox", name: "Describe", contains: true }, value: "x" }), true],
    ["within for fill accepted: the field is disabled while the counterpart answers", () => parseStep({ fill: "Answer", value: "a", within: 120 }), true],
    ["within for fill above 1800 rejected", () => parseStep({ fill: "Answer", value: "a", within: 5000 }), false],
    ["within for wait with a text accepted", () => parseStep({ wait: "Document ready", within: 300 }), true],
    ["within for a numeric pause rejected", () => parseStep({ wait: 500, within: 300 }), false],
    ["within for click rejected", () => parseStep({ click: "Next", within: 5 }), false],
    ["within above 1800 rejected", () => parseStep({ wait: "Done", within: 5000 }), false],
    [
      "legacy mode: without a reason rejected; root not found - the line names the path",
      () => {
        if (legacyProblem("page without window.__agent") !== null) throw new Error("named reason rejected");
        if (legacyProblem("") === null || legacyProblem("  ") === null || legacyProblem(undefined) === null) throw new Error("key without a reason accepted");
        if (!rootlessLine("/view/abc").includes("/view/abc") || !rootlessLine("/view/abc").includes("data-state")) throw new Error("the line does not name the path and the mark");
        if (targetLabel({ role: "link", name: "Smith", contains: true }) !== "Smith") throw new Error("wrong target name");
      },
      true,
    ],
    [
      "multiline order text split into lines in order",
      () => {
        const lines = orderLines(["People\n\n0\n\nItems done", "Total · More"]);
        if (JSON.stringify(lines) !== JSON.stringify(["People", "0", "Items done", "Total", "More"])) throw new Error(`wrong lines: ${JSON.stringify(lines)}`);
        if (orderLines(["One"]).length !== 1) throw new Error("single-line text changed");
      },
      true,
    ],
    [
      "the report names the step's screen; a page without a root - screen null",
      () => {
        const on = screenMark(true, { name: "editor", state: "ready", url: "x" });
        if (on.agent !== true || on.screen?.name !== "editor" || on.screen?.state !== "ready") throw new Error("screen not named");
        const off = screenMark(true, null);
        if (off.agent !== true || off.screen !== null) throw new Error("page without a root named as a screen");
        if (screenMark(false, null).agent !== false) throw new Error("absence of window.__agent not passed");
      },
      true,
    ],
    ["upload with a path outside rejected", () => parseStep({ upload: "../../etc/passwd" }), false],
    ["to for a foreign step rejected", () => parseStep({ click: "Build", to: { selector: "input" } }), false],
    [
      "login from the environment: not set - null, set - as is, a kind outside the list and an empty secret rejected",
      () => {
        if (givenCredential({}) !== null) throw new Error("empty environment gave a login");
        const given = givenCredential({ BRAILLE_CREDENTIAL: "bearer", BRAILLE_SECRET: "t" });
        if (given.credential !== "bearer" || given.secret !== "t") throw new Error("login parsed wrong");
        if (givenCredential({ BRAILLE_CREDENTIAL: "none" }).secret !== "") throw new Error("anon without a secret rejected");
        let refused = 0;
        for (const env of [{ BRAILLE_CREDENTIAL: "basic", BRAILLE_SECRET: "t" }, { BRAILLE_CREDENTIAL: "cookie" }]) {
          try {
            givenCredential(env);
          } catch {
            refused += 1;
          }
        }
        if (refused !== 2) throw new Error("bad login accepted");
      },
      true,
    ],
    [
      "browser: default path, custom path, bundled - no path",
      () => {
        if ("executablePath" in chromeOption({})) throw new Error("wrong default path");
        if (chromeOption({ BRAILLE_CHROME: "/x/chrome" }).executablePath !== "/x/chrome") throw new Error("custom path not accepted");
        if ("executablePath" in chromeOption({ BRAILLE_CHROME: "bundled" })) throw new Error("bundled gave a path");
      },
      true,
    ],
    ["active without a text rejected", () => parseStep({ active: "" }), false],
    ["active accepted", () => parseStep({ active: "Create" }), true],
    ["disabled without a text rejected", () => parseStep({ disabled: "" }), false],
    [
      "disabled button: disabled passes; enabled and not on the page do not",
      () => {
        if (disabledProblem([true], "Next") !== null) throw new Error("disabled rejected");
        if (disabledProblem([false], "Next") === null) throw new Error("enabled accepted");
        if (disabledProblem([true, false], "Next") === null) throw new Error("one of two is enabled, but accepted");
        if (disabledProblem([], "Next") === null) throw new Error("missing accepted");
        if (clickBlockedProblem(false, "Next") === null) throw new Error("disabled click target accepted");
        if (clickBlockedProblem(true, "Next") !== null) throw new Error("enabled click target rejected");
        const api = apiFailuresLine([
          { kind: "console", message: "x" },
          { kind: "request", method: "POST", url: "http://h/api/items/extract", status: 502, code: "replay_miss" },
        ]);
        if (api !== "API: POST /api/items/extract -> 502 replay_miss") throw new Error(`API failure not named: ${api}`);
        if (apiFailuresLine([{ kind: "console", message: "x" }]) !== "") throw new Error("the line is not empty without failed requests");
      },
      true,
    ],
    ["field without has rejected", () => parseStep({ field: "Request" }), false],
    ["field accepted", () => parseStep({ field: { selector: "textarea" }, has: "summary" }), true],
    ["checked without a name rejected", () => parseStep({ checked: "" }), false],
    ["focused accepted", () => parseStep({ focused: "I accept the rules" }), true],
    [
      "field value: a text in the value passes; another text and no field do not",
      () => {
        if (fieldProblem(["Write a summary for the team"], "summary") !== null) throw new Error("correct value rejected");
        if (fieldProblem([""], "summary") === null) throw new Error("empty field accepted");
        if (fieldProblem(["Write the notes"], "summary") === null) throw new Error("foreign text accepted");
        if (fieldProblem([], "summary") === null) throw new Error("missing field accepted");
      },
      true,
    ],
    [
      "checkbox: checked, unchecked and focused are told apart; no checkbox and two checkboxes - failure",
      () => {
        const on = [{ checked: true, focused: false }];
        const off = [{ checked: false, focused: true }];
        if (tickProblem(on, "I accept", "checked") !== null) throw new Error("checked rejected");
        if (tickProblem(off, "I accept", "checked") === null) throw new Error("unchecked taken for checked");
        if (tickProblem(off, "I accept", "unchecked") !== null) throw new Error("unchecked rejected");
        if (tickProblem(on, "I accept", "unchecked") === null) throw new Error("checked taken for unchecked");
        if (tickProblem(off, "I accept", "focused") !== null) throw new Error("focus rejected");
        if (tickProblem(on, "I accept", "focused") === null) throw new Error("checkbox without focus accepted");
        for (const kind of ["checked", "unchecked", "focused"]) {
          if (tickProblem([], "I accept", kind) === null) throw new Error("missing checkbox accepted");
          if (tickProblem([...on, ...off], "I accept", kind) === null) throw new Error("two checkboxes accepted");
        }
      },
      true,
    ],
    ["optional for click accepted", () => parseStep({ click: "Not now", optional: true }), true],
    ["optional for fill accepted", () => parseStep({ fill: "Name", value: "Test", optional: true }), true],
    ["optional for press rejected", () => parseStep({ press: "Enter", optional: true }), false],
    ["optional for an expectation rejected", () => parseStep({ absent: "Office", optional: true }), false],
    ["optional for wait with a text accepted", () => parseStep({ wait: "Second question", within: 90, optional: true }), true],
    ["optional for wait with a number rejected", () => parseStep({ wait: 500, optional: true }), false],
    ["optional not true rejected", () => parseStep({ click: "Not now", optional: "yes" }), false],
    [
      "current menu item: its own passes; a foreign one, none and two do not",
      () => {
        if (activeProblem(["Create"], "Create") !== null) throw new Error("own item rejected");
        if (activeProblem(["Library"], "Create") === null) throw new Error("foreign item accepted");
        if (activeProblem([], "Create") === null) throw new Error("empty menu accepted");
        if (activeProblem(["Create", "Requests"], "Create") === null) throw new Error("two current accepted");
      },
      true,
    ],
    [
      "text order: the correct one passes, a swap and a gap do not",
      () => {
        const text = "Home\nLibrary\nReports";
        if (orderProblem(text, ["Home", "Reports"]) !== null) throw new Error("correct order rejected");
        if (orderProblem(text, ["Reports", "Home"]) === null) throw new Error("swap accepted");
        if (orderProblem(text, ["Home", "Office"]) === null) throw new Error("gap accepted");
      },
      true,
    ],
    [
      "text absence: an empty page is a failure, a found text is a failure",
      () => {
        if (absentProblem("Create", "Office") !== null) throw new Error("absence not recognized");
        if (absentProblem("", "Office") === null) throw new Error("empty page taken for absence");
        if (absentProblem("Office", "Office") === null) throw new Error("found text taken for absence");
      },
      true,
    ],
    [
      "screen in error - a failure with the screen text; ready, loading and no screen - not a failure",
      () => {
        const err = screenProblem({ testid: "screen.editor", state: "error", alerts: ["Failed to load"] });
        if (!err || !err.includes("screen.editor") || !err.includes("Failed to load")) throw new Error("error not recognized as a failure with a text");
        if (screenProblem({ testid: "screen.editor", state: "ready", alerts: [] }) !== null) throw new Error("ready taken for a failure");
        if (screenProblem({ testid: "screen.editor", state: "loading", alerts: [] }) !== null) throw new Error("loading taken for a failure");
        if (screenProblem(null) !== null) throw new Error("absence of a screen taken for a failure");
        if (!screenPending({ state: "loading" }) || screenPending({ state: "ready" }) || screenPending({ state: "empty" }) || screenPending({ state: "error" }) || screenPending(null)) {
          throw new Error("waiting for the screen to leave loading is computed wrong");
        }
      },
      true,
    ],
    [
      "a cover names the element and the dialog; a step's requests are named, and so is their absence",
      () => {
        const line = coverLine({ element: "div.overlay", position: "fixed", size: "1440x1000", zIndex: "200", inside: null, dialogs: ["New"] });
        if (!line.includes("div.overlay") || !line.includes("fixed") || !line.includes('"New"')) throw new Error(line);
        if (coverLine(null) !== "") throw new Error("no data, yet a line");
        if (apiCallsLine([]) !== "no requests") throw new Error("an empty step is not named");
        const calls = apiCallsLine(["GET /a 200", "GET /a 200", "POST /b 201"]);
        if (!calls.includes("GET /a 200 x2") || !calls.includes("POST /b 201")) throw new Error(calls);
      },
      true,
    ],
    [
      "a covered button - a failure naming the covering element; a free one passes",
      () => {
        const covered = { name: "Create", testid: "editor.submit", occludedBy: [{ name: "Cookies", testid: "cookie.banner", tag: "div" }] };
        const problem = occlusionProblem(covered);
        if (!problem || !problem.includes("Cookies") || !problem.includes("Create")) throw new Error("overlap without the name of the covering element");
        if (occlusionProblem({ name: "Create", occludedBy: [] }) !== null) throw new Error("free button rejected");
        if (occlusionProblem(undefined) !== null) throw new Error("no element data taken for an overlap");
      },
      true,
    ],
    [
      "order by domIndex: the correct one passes; a swap and a gap do not; the nearest occurrence after the previous one is taken",
      () => {
        if (orderProblemByHits([[3], [9]], ["Create", "Sources"]) !== null) throw new Error("correct order rejected");
        if (orderProblemByHits([[9], [3]], ["Sources", "Create"]) === null) throw new Error("swap accepted");
        if (orderProblemByHits([[3], []], ["Create", "Office"]) === null) throw new Error("gap accepted");
        if (orderProblemByHits([[3, 20], [9]], ["Create", "Sources"]) !== null) throw new Error("first occurrence of the first text not taken into account");
        if (orderProblemByHits([[30], [9]], ["A", "B"]) === null) throw new Error("B before A accepted");
        if (orderProblemByHits([[5], [5]], ["A", "B"], { 5: "A then B" }) !== null) throw new Error("order within one element rejected");
        if (orderProblemByHits([[5], [5]], ["B", "A"], { 5: "A then B" }) === null) throw new Error("swap within one element accepted");
        if (orderProblemByHits([[2], [5], [5, 30], [9]], ["Summary", "Item", "Mode", "Assigned"], { 5: "Item · Mode" }) !== null) throw new Error("continuation in the same element lost to a later occurrence");
      },
      true,
    ],
    [
      "text absence by find: no elements on a live page - passes; an empty page and a found text - failure",
      () => {
        if (absentProblemByCount(0, true, "Office") !== null) throw new Error("absence not recognized");
        if (absentProblemByCount(0, false, "Office") === null) throw new Error("empty page taken for absence");
        if (absentProblemByCount(1, true, "Office") === null) throw new Error("found text taken for absence");
      },
      true,
    ],
    [
      "failure snapshot clip: a margin around the element, at the edge it does not go negative; no box - null",
      () => {
        const clip = clipFor({ x: 100, y: 50, width: 80, height: 40 });
        if (clip.x !== 84 || clip.y !== 34 || clip.width !== 112 || clip.height !== 72) throw new Error(`wrong clip: ${JSON.stringify(clip)}`);
        const edge = clipFor({ x: 4, y: 0, width: 10, height: 10 });
        if (edge.x !== 0 || edge.y !== 0) throw new Error("the clip went past the edge");
        if (clipFor(null) !== null || clipFor({ x: 0, y: 0, width: 0, height: 10 }) !== null) throw new Error("empty clip accepted");
      },
      true,
    ],
    [
      "API records: the sample file passes the git check",
      () => parseApiRecords(fs.readFileSync(API_SAMPLE, "utf8"), "api-sample", { gitSource: true }),
      true,
    ],
    [
      "API records: the key does not depend on the host, the API root, the order of parameters and body keys; a different body gives a different key",
      () => {
        const a = apiRequestKey("post", "https://app.example.com/api/x?b=2&a=1", '{"y":1,"x":2}', "application/json");
        const b = apiRequestKey("POST", "http://localhost:8010/api/x?a=1&b=2", '{ "x": 2, "y": 1 }', "application/json");
        if (a !== b) throw new Error(`keys diverged: ${a} / ${b}`);
        if (a === apiRequestKey("POST", "https://app.example.com/api/x?a=1&b=2", '{"x":3,"y":1}', "application/json")) throw new Error("a different body gave the same key");
        const ev1 = apiRequestKey("POST", "https://x/api/a", '{"event_id":"2aa0d9ec-ecd3-4876-81ed-996a2a5d0001","channel":"option"}', "application/json");
        const ev2 = apiRequestKey("POST", "https://x/api/a", '{"event_id":"2e06daa0-fe47-4cd6-8845-576dd1ae0002","channel":"option"}', "application/json");
        if (ev1 !== ev2) throw new Error("bodies that differ only in the browser UUID gave different keys");
        if (ev1 === apiRequestKey("POST", "https://x/api/a", '{"event_id":"2aa0d9ec-ecd3-4876-81ed-996a2a5d0001","channel":"text"}', "application/json")) throw new Error("the UUID mark swallowed a difference in another field");
        if (apiRequestKey("GET", "https://app.example.com/assets/app.js", null) !== null) throw new Error("a non-API request taken for an API request");
        if (apiRequestKey("POST", "https://x/api/f", "--b1\r\n", "multipart/form-data; boundary=b1") !== apiRequestKey("POST", "https://x/api/f", "--b2\r\n", "multipart/form-data; boundary=b2")) throw new Error("multipart boundaries got into the key");
      },
      true,
    ],
    [
      "replay: a request from the file is answered with a record, GET repeats do not move the response, the advance step does",
      () => {
        const replay = new ApiReplay(JSON.parse(fs.readFileSync(API_SAMPLE, "utf8")));
        const me = replay.answer("GET", "https://app.example.com/api/users/me", null);
        if (!me || me.status !== 200 || JSON.parse(me.body).role !== "admin") throw new Error("the record was not served");
        const list = replay.answer("GET", "https://app.example.com/api/people?offset=0&limit=50", null);
        if (!list || JSON.parse(list.body).total !== 0) throw new Error("a request with a query in another order was not found");
        const post = replay.answer("POST", "https://app.example.com/api/people/search", '{"page":1,"name":"a"}', "application/json");
        if (!post) throw new Error("a request with a body was not found");
        const job = () => JSON.parse(replay.answer("GET", "https://app.example.com/api/jobs/1", null).body).state;
        const before = [job(), job()];
        replay.advance("/jobs/1");
        const states = [...before, job(), job()];
        if (states.join() !== "running,running,done,done") throw new Error(`repeats go wrong: ${states}`);
        if (replay.misses.length) throw new Error("requests from the file are recorded as unknown");
      },
      true,
    ],
    [
      "replay: an advance given before the record arrives applies to the state after it; series of one address go in turn; without a series - zero",
      () => {
        const get = (state) => ({ method: "GET", path: "/api/jobs/1", query: "", body: null, status: 200, content_type: "application/json", response: { state } });
        const post = { method: "POST", path: "/api/jobs", query: "", body: null, status: 200, content_type: "application/json", response: {} };
        const replay = new ApiReplay({ calls: [post, get("a1"), get("a2"), { ...post }, get("b1"), get("b2")] });
        const read = () => JSON.parse(replay.answer("GET", "https://app.example.com/api/jobs/1", null).body).state;
        if (replay.advance("/jobs/1") !== 1) throw new Error("the first series was not moved");
        if (replay.advance("/nothing") !== 0) throw new Error("an address without a series was moved");
        replay.answer("POST", "https://app.example.com/api/jobs", null);
        if (read() !== "a2") throw new Error("advance before the record was lost");
        replay.answer("POST", "https://app.example.com/api/jobs", null);
        if (read() !== "b1") throw new Error("advance carried over to the next series");
        if (replay.advance("/jobs/1") !== 1 || read() !== "b2") throw new Error("the second series was not moved");
        if (replay.advance("/jobs/1") !== 0) throw new Error("the series ran out, but advance moved something");
      },
      true,
    ],
    [
      "replay: after a cut the queues continue from the cut point of the recording, however many requests the page made before it",
      () => {
        const call = (state) => ({ method: "GET", path: "/api/state", query: "", body: "", status: 200, content_type: "application/json", response: { state } });
        const replay = new ApiReplay({ calls: [call("before"), call("before2"), call("after")], cuts: [2] });
        replay.answer("GET", "https://app.example.com/api/state", null);
        replay.cut();
        const got = JSON.parse(replay.answer("GET", "https://app.example.com/api/state", null).body).state;
        if (got !== "after") throw new Error(`after the cut got the response "${got}"`);
      },
      true,
    ],
    [
      "replay: an extra GET before a change does not eat the response taken after it (deleting a draft)",
      () => {
        const get = (state) => ({ method: "GET", path: "/api/list", query: "", body: "", status: 200, content_type: "application/json", response: { state } });
        const del = { method: "DELETE", path: "/api/item/1", query: "", body: "", status: 200, content_type: "application/json", response: {} };
        const replay = new ApiReplay({ calls: [get("before"), del, get("after")] });
        const read = () => JSON.parse(replay.answer("GET", "https://app.example.com/api/list", null).body).state;
        const seen = [read(), read()];
        if (seen.join() !== "before,before") throw new Error(`before the change got ${seen}`);
        replay.answer("DELETE", "https://app.example.com/api/item/1", null);
        if (read() !== "after") throw new Error("after the change got the response from before it");
      },
      true,
    ],
    [
      "replay: a request that is not in the file is not answered and is named by its address in the failure line",
      () => {
        const replay = new ApiReplay(JSON.parse(fs.readFileSync(API_SAMPLE, "utf8")));
        if (replay.answer("GET", "https://app.example.com/api/items?limit=5", null) !== null) throw new Error("an unknown request got a response");
        if (replay.answer("DELETE", "https://app.example.com/api/users/me", null) !== null) throw new Error("the same path with another method got a response");
        const line = missLine(replay.takeMisses());
        if (!line || !line.includes("GET /api/items?limit=5") || !line.includes("DELETE /api/users/me")) throw new Error(`the address is not in the line: ${line}`);
        if (replay.takeMisses().length) throw new Error("misses were not reset");
      },
      true,
    ],
    [
      "API records: a damaged file, a foreign name, a shared-environment source in git, empty records, a wrong status - refusal",
      () => {
        const good = JSON.parse(fs.readFileSync(API_SAMPLE, "utf8"));
        const refused = (label, text, name = "api-sample", options) => {
          try {
            parseApiRecords(typeof text === "string" ? text : JSON.stringify(text), name, options);
          } catch {
            return;
          }
          throw new Error(`accepted: ${label}`);
        };
        refused("not JSON", "{");
        refused("truncated file", JSON.stringify(good).slice(0, 200));
        refused("different file name", good, "other");
        refused("no calls", { ...good, calls: undefined });
        refused("calls empty", { ...good, calls: [] });
        refused("shared source in git", { ...good, source: "dev" }, "api-sample", { gitSource: true });
        refused("unknown source", { ...good, source: "other" });
        refused("substitutions not an object", { ...good, values: ["c1"] });
        refused("browser time not a time", { ...good, clock: "yesterday" });
        refused("manual edits not a list", { ...good, "patches": "added" });
        refused("manual edits empty", { ...good, "patches": [] });
        parseApiRecords(JSON.stringify({ ...good, "patches": ["POST answer: added by hand, the environment cannot produce it"] }), "api-sample");
        const a = { method: "POST", path: "/api/c", response: { token: "first" } };
        const b = { ...a, response: { token: "second" } };
        const poll = [{ ...a, response: 1 }, { ...a, response: 2 }];
        // The response of the second sent request (b) came first: both get it, not the one that arrived last.
        const folded = foldOverlapping([b, a, ...poll], [{ burst: 1, sent: 2 }, { burst: 1, sent: 1 }, { burst: 2, sent: 3 }, { burst: 3, sent: 4 }]);
        if (folded[0].response.token !== "second" || folded[1].response.token !== "second") throw new Error("an overlapping batch got the record of a request that was not the last one sent");
        if (folded[2].response !== 1 || folded[3].response !== 2) throw new Error("requests in turn lost their order");
        const miss = serverFailureLine([{ ...a, status: 200 }, { ...a, status: 502, response: { detail: { code: "replay_miss" } } }]);
        if (!miss || !miss.includes("502 replay_miss")) throw new Error("a 5xx failure in the records is not named");
        if (serverFailureLine([{ ...a, status: 404 }]) !== null) throw new Error("4xx taken for a backend failure");
        refused("substitution is an object", { ...good, values: { item_id: { id: 1 } } });
        parseApiRecords(JSON.stringify({ ...good, values: { item_id: "c1", step: 2 } }), "api-sample");
        refused("record without a response", { ...good, calls: [{ ...good.calls[0], response: undefined }] });
        refused("status is not a code", { ...good, calls: [{ ...good.calls[0], status: "200" }] });
        refused("path is not an API path", { ...good, calls: [{ ...good.calls[0], path: "/assets/app.js" }] });
        refused("query not reduced", { ...good, calls: [{ ...good.calls[1], query: "offset=0&limit=50" }] });
        parseApiRecords(JSON.stringify({ ...good, source: "dev" }), "api-sample");
      },
      true,
    ],
    [
      "API records: requests without a response by the end of the run - refusal with the address; none - no refusal",
      () => {
        if (pendingLine([]) !== null) throw new Error("an empty list was refused");
        const line = pendingLine(["GET /api/items/drafts"]);
        if (!line || !line.includes("GET /api/items/drafts")) throw new Error("the address is not in the line");
      },
      true,
    ],
    [
      "API records: a caught pair is read by replay; a login secret in the response - the record is refused",
      () => {
        const call = recordedCall("GET", "https://app.example.com/api/ping?z=1&a=2", null, "", 200, "application/json; charset=utf-8", '{"ok":true}');
        const meta = { scenario: "x", source: "dev" };
        const doc = apiDocument(meta, [call], ["a-secret-token-123"]);
        const answer = new ApiReplay(doc).answer("GET", "https://app.example.com/api/ping?a=2&z=1", null);
        if (!answer || JSON.parse(answer.body).ok !== true) throw new Error("the recorded pair is not answered");
        if (recordedCall("GET", "https://app.example.com/assets/a.js", null, "", 200, "text/javascript", "x") !== null) throw new Error("a non-API request recorded");
        const leak = recordedCall("GET", "https://app.example.com/api/login", null, "", 200, "application/json", '{"note":"a-secret-token-123"}');
        try {
          apiDocument(meta, [leak], ["a-secret-token-123"]);
        } catch {
          return;
        }
        throw new Error("a secret in the response accepted");
      },
      true,
    ],
    [
      "failed step evidence: all required fields non-empty, limits kept",
      () => {
        const long = "line ".repeat(2000);
        const evidence = buildEvidence({
          url: "https://app.example.com/app/page?x=1#h",
          title: "Dashboard",
          text: long,
          console: Array.from({ length: 50 }, (_, i) => `error message ${i}`),
          pageerrors: ["TypeError: x is undefined"],
          requests: [{ method: "GET", path: "/api/me?token=abc", status: 502, ms: 1200 }, { method: "GET", path: "/assets/chunk.js", status: "net::ERR_FAILED", ms: 900 }],
          screenshot: "tmp/screen-runs/s/03-click.page.png",
          load: { readyState: "complete", root: "div#root, descendants 0", agent: false, scripts: 3, chunkErrors: ["GET /assets/chunk.js -> net::ERR_FAILED"] },
        });
        const problems = evidenceProblems(evidence);
        if (problems.length) throw new Error(`a complete composition was found incomplete: ${problems.join("; ")}`);
        if (evidence.url.includes("?") || evidence.url.includes("#")) throw new Error("the query string stayed in the address");
        if (evidence.requests[0].path.includes("?")) throw new Error("the query string stayed in the request path");
        if (evidence.text.length > EVIDENCE.limits.text) throw new Error("the text was not trimmed");
        if (evidence.console.length > EVIDENCE.limits.console) throw new Error("the console was not trimmed");
        if (evidence.requests[0].status !== 502 || evidence.requests[1].status !== "net::ERR_FAILED") throw new Error("the request status was lost");
      },
      true,
    ],
    [
      "evidence: an empty page without a snapshot and a load state is found incomplete (must turn red)",
      () => {
        const problems = evidenceProblems(buildEvidence({}));
        if (problems.length === 0) throw new Error("empty evidence found complete");
      },
      true,
    ],
    [
      "evidence: a failure with no evidence at all is incomplete",
      () => {
        if (evidenceProblems(null).length === 0 || evidenceProblems({}).length === 0) throw new Error("the absence of evidence accepted");
      },
      true,
    ],
    [
      "masking: the login token, JWT, Bearer, key=value pairs and long tokens do not reach the evidence",
      () => {
        const secret = "sekret-token-value-12345";
        const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEFghiJKL";
        const evidence = buildEvidence(
          {
            url: `https://app.example.com/x?auth_token=${secret}`,
            title: "t",
            text: `You are signed in. token: ${secret}. Authorization: Bearer abcdef1234567890xyz. ${jwt}. key ${"A1b2C3d4".repeat(5)}`,
            console: [`error fetch failed password=hunter2hunter2 ${secret}`],
            pageerrors: [],
            requests: [{ method: "GET", path: `/api/me/${secret}`, status: 401, ms: 5 }],
            screenshot: "tmp/x.png",
            load: { readyState: "complete", root: "r", agent: true, scripts: 1, chunkErrors: [] },
          },
          [secret],
        );
        const dump = JSON.stringify(evidence);
        for (const leaked of [secret, jwt, "abcdef1234567890xyz", "hunter2hunter2", "A1b2C3d4".repeat(5)]) {
          if (dump.includes(leaked)) throw new Error(`a secret stayed in the evidence: ${leaked.slice(0, 12)}…`);
        }
        if (!dump.includes("You are signed in")) throw new Error("the mask swallowed ordinary text");
      },
      true,
    ],
    [
      "chunk load errors are recognized, an ordinary console error is not",
      () => {
        if (!isChunkError("Failed to fetch dynamically imported module: https://x/assets/a.js")) throw new Error("chunk not recognized");
        if (!isChunkError("Loading chunk 12 failed")) throw new Error("ChunkLoadError not recognized");
        if (isChunkError("TypeError: x is not a function")) throw new Error("an ordinary error taken for a chunk");
      },
      true,
    ],
    [
      "step timeout names the wait, the deadline and the screen by Braille; another error is left alone",
      () => {
        const evidence = buildEvidence({ load: { agent: true }, screen: { testid: "screen.home", state: "ready", overlays: [], facts: { tab: "items" }, alerts: [] }, busy: { requests: 1 } });
        const got = timeoutReason("page.waitForFunction: Timeout 60000ms exceeded. — API: GET /x -> 404", { kind: "wait", target: "Items 1" }, evidence);
        if (!got.startsWith("wait \"Items 1\" did not come true within 60 s; screen screen.home data-state=ready")) throw new Error(got);
        if (!got.includes("facts: tab=items") || !got.includes("busy: requests=1") || !got.endsWith("API: GET /x -> 404")) throw new Error(got);
        if (timeoutReason("no button", { kind: "click", target: "x" }, evidence) !== "no button") throw new Error("a non-timeout error was rewritten");
        if (!timeoutReason("Timeout 15000ms exceeded.", { kind: "click", target: "x" }, buildEvidence({ load: { agent: false } })).includes("no window.__agent")) throw new Error("a page without __agent not named");
        const off = buildEvidence({ load: { agent: true }, screen: { testid: "screen.q", state: "ready" }, target: [{ role: "button", name: "Submit answer", testid: null, disabled: true, inViewport: true, occludedBy: [] }] });
        if (!timeoutReason("Timeout 15000ms exceeded.", { kind: "click", target: "Submit answer" }, off).includes("target: button \"Submit answer\", disabled")) throw new Error("a disabled target not named");
        const none = buildEvidence({ load: { agent: true }, screen: { testid: "screen.q", state: "ready" }, target: [] });
        if (!timeoutReason("Timeout 15000ms exceeded.", { kind: "click", target: "x" }, none).includes("target: none on the screen")) throw new Error("the absence of a target not named");
      },
      true,
    ],
  ];
  let bad = 0;
  for (const [name, run, shouldPass] of cases) {
    let passed = true;
    try {
      run();
    } catch {
      passed = false;
    }
    const ok = passed === shouldPass;
    if (!ok) bad += 1;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  }
  process.exit(bad ? 1 : 0);
}
