# agent-braille

A browser tool can only report what is visible from outside: the page, the network, the console. Why a button is disabled, why a row was dropped, why a save is sitting in a queue is known only to the frontend's code. Without it an agent guesses, and a wrong guess costs far more tokens than any screenshot: it reads code, reruns and fixes what is not broken.

agent-braille is about putting that knowledge into the code. The agent adds small inserts where the code decides (`data-state`, `data-fact`, busy sources), scenarios check them, and the next agent gets a direct answer:

```json
{"screen": {"name": "people", "state": "empty"},
 "elements": [{"testid": "people.add", "role": "button", "name": "Add person"}],
 "fields": [], "options": [], "overlays": [], "facts": {"count": "0"}}
```

Each source answers its own question. `state` and `busy` say the app has finished. What is visible proves the result, so a scenario needs at least one check of it; `fact` and `state` alone are refused, because they are the app's own report. A failed step names the cause: what covers a button, and which API requests the step made, or that it made none.

## What the inserts give

Seeded defects on the example app, a neutral task ("add a person, she appears in the list"), three sessions per defect, Sonnet:

| Defects | Sessions | Playwright CLI | Playwright CLI + inserts | agent-braille |
|---|---|---|---|---|
| Known only to the code: hidden validation rule, rows dropped on the client, a queue waiting on a socket, a client throttle, a changed response format, demo mode | 18 | 3 right | 15 right | 15 right |
| Visible from outside, but not in the accessibility tree or status codes: same colour as the background, transparent, covered, off-screen, a short toast, a 200 that says it failed | 30 | 1 right | 3 right | 22 right |

Most of the gain in the first row comes from the inserts, not from the tool: plain Playwright reads them as well. No session raised a false alarm on the 5 working controls of the second row. A delayed autosave, declared as a busy source, was judged correctly 3 of 3 times, against 1 of 3 and 2 of 3.

These defects were chosen to expose what a browser tool cannot see, so this is not a bug-finding rate. On ordinary failures, a failed request or a covered button, Playwright CLI found the cause just as often in our runs on a real application, at about 20% lower cost.

**What to insert.** When a step does not explain why something did not happen, add a fact where the code decides, and let a scenario check it. Name the consequence, not the internal mode: `saved-to=local-only` works, `mode=demo` was ignored in all 9 sessions.

```tsx
<span {...screenFactProps("blocked-by", name.length > 10 ? "name-longer-than-10" : "none")} />
```

What the tool adds on top:

- **A diagnosis instead of a wait.** A failed request ends the wait within seconds and names it: `API: POST /x -> 502`, where a plain wait reports a 60 s timeout.
- **Contradictions.** The app's report is compared with the network on every step: `ready` while a request failed, `loading` with nothing busy, a 200 whose body says it failed, the same POST sent twice, a poll that stands still. The inserts can drift from reality, so they do not get the last word.
- **The data layer as a sensor** (`--sensors`). The request client reports what it knows through `registerDataSource`: which requests a screen shows and how they ended, how each save ended. A step goes red when a request the screen shows failed while the screen says `ready` or `empty`, or a save failed and the page said nothing (no `role=alert` or `role=status`). From outside, a silent refusal and a told one look the same: the dialog stays open.
- **A wait that knows the data came.** The screen says `ready` or `empty`, nothing is busy or in flight, the network has been quiet 5 s: the wait ends and names what the page got (`the page got: /api/people {items: [0]}`) and what is shown instead of the awaited text. A step with its own `within` waits its time.
- **A check of the check.** `braille mutate` breaks each recorded request in turn. A scenario still green did not depend on it.
- **What a person cannot see,** though the tree has it: `visual` in the answer.
- **Toasts.** Alerts that appeared in a step are kept in `notices` after they vanish.
- **Replay by server state,** with no backend, and a red step for any request not in the file.

It has four parts:

| Part | What it does | Where |
|---|---|---|
| In-page API | `window.stalker`: `screen`, `busy`, `find`, `act`, `layout`, `errors`, `tools`. Exists only in a build with `VITE_STALKER=1` | `runtime/` |
| Markup contract | screen root `data-testid="screen.<name>"` with `data-state` (`loading`, `ready`, `empty`, `error`); buttons `data-testid="<screen>.<action>"`; hidden state `data-fact` | `runtime/screenState.ts` |
| Markup guard | a lint rule refuses an action button without a testid; a test checks names | `frontend/` |
| Executor | runs scenarios, or one step at a time for a model; records API answers and replays a screen with no backend | `bin/braille.mjs`, `lib/` |

Tested on Chromium with a Vite build. The example in `examples/react-mantine` uses React, Mantine, React Query and React Router. The runtime has no framework dependency, but other bundlers and UI libraries are not tested here: see [Limits](#limits).

## What it saves

On the example's 14-step `people-add` scenario the agent reads a 2.9 KB `report.json`. The same run with a 1440×1000 screenshot after every step is 14 images, about 27,000 input tokens at Claude's published estimate of width×height/750 per image. That compares what the agent has to read; total session cost depends on your workflow and was not measured. With a recorded API the scenario also runs with no backend or live model. This compares one observation with screenshots only. It was not measured against accessibility snapshots such as Playwright CLI, or over a whole agent session.

## Try it

```bash
npm install
npx playwright-core install chromium   # or BRAILLE_CHROME=/path/to/chrome
bash test.sh
```

## Add it to an application

Written for the agent doing the work. Each step ends with a check; if it fails, fix that step before going on.

1. **Install the runtime.** `node <braille>/bin/braille.mjs install <frontend>` copies it to `<frontend>/src/shared/stalker/`. `check-runtime <frontend>` later reports drift. Before v2 the bridge was `window.__agent`, the flag `VITE_AGENT_API` and the copy `src/shared/agent/`: `install` removes the old copy, the import and the flag in your build scripts you change yourself. `window.__agent` still points to `window.stalker` for players that have not moved yet.
2. **Load it at the entry point, before the first request:**
   ```ts
   import { maybeInstallStalker } from "./shared/stalker/bootstrap";
   maybeInstallStalker();
   ```
3. **Prove both builds.** Build with `VITE_STALKER=1`, run `braille check-build <dist> enabled`. Build without it, run `braille check-build <dist> disabled`. Production is always built without the flag. Plain esbuild keeps the module even with the flag off: on any bundler other than Vite this check decides, and the import has to be replaced with an empty module.
4. **Declare what the page is busy with,** so the executor never sleeps. For React Query and React Router:
   ```ts
   registerBusySource("queries", () => queryClient.getQueryCache().findAll({ fetchStatus: "fetching", predicate: (q) => q.state.data === undefined }).length);
   registerBusySource("mutations", () => queryClient.isMutating());
   registerBusySource("navigation", () => (router.state.navigation.state === "idle" ? 0 : 1));
   ```
   Leave out background refetches over loaded data, or a polling page never settles.

   Then hand over the data layer, so `--sensors` can compare it with the screen (the example's `App.tsx` has the React Query version):
   ```ts
   registerDataSource("queries", () => queryClient.getQueryCache().getAll().map((q) => ({ key: JSON.stringify(q.queryKey), status: q.state.status, observers: q.getObserversCount(), updatedAt: q.state.dataUpdatedAt, ...(q.state.error ? { error: String(q.state.error.message) } : {}) })));
   registerDataSource("mutations", () => queryClient.getMutationCache().getAll().map((m) => ({ status: m.state.status, submittedAt: m.state.submittedAt, ...(m.state.error ? { error: String(m.state.error.message) } : {}) })));
   ```
   Saves that bypass React Query go to a `writes` source from the HTTP client: `{ call: "POST /api/x", status, at, code }` per non-GET call, `status: null` when there was no answer. A refusal the screen handles on purpose is marked `handled: true` on its query.
5. **Mark up screens.** On the root of each page: `{...screenRootProps("people", queryScreenState(query))}`. The root exists from the first frame and takes its state from the main request, never a timer. Start with one screen. Pages without a root are reported as `NO ROOT` in the run output.
6. **Add testids to action buttons:** `<screen>.<action>`. Repeated elements share one id and a step picks the instance with `item`.
7. **Turn on the guard.** Copy `frontend/testidScope.js` and `eslint-testid-block.js`, list your button components in `testidBlock([...])`. Copy `frontend/testids.test.js`; its control cases must fail on a button without a testid. Add directories as you mark them up.
8. **Switch off tours and hints.** They call `agentTurnedOff("onboarding")` from `runtime/switches.ts`; the executor sets that key itself, so they do not pop up over steps.
9. **Write the first scenario step by step** as in [docs/SCENARIOS.md](docs/SCENARIOS.md), record the API, replay it with the backend stopped. Break one expectation and confirm that it goes red with a clear reason.
10. **Tell your agents.** Add to `AGENTS.md`: read screens through `window.stalker` and `braille step` (`braille help` is the short manual), write scenarios by `docs/SCENARIOS.md`, use a screenshot only for questions about appearance.

Done when every page has a root with `data-state`, lint covers every screen with buttons, and each screen with meaningful behaviour has a green scenario plus a control that can go red.

If the application calls an LLM on a scenario's path, see [docs/RECORDINGS.md](docs/RECORDINGS.md).

## Commands

```
braille check <dir>                     validate all scenarios, no browser
braille run <file>… --base URL          run scenarios: --out DIR, --storage-state FILE, --values FILE,
                                        --record-api DIR, --replay-api DIR, --sensors, --loose
braille mutate <file> --base URL --replay-api DIR [--strict]
                                        break each recorded request in turn: is the scenario a real check?
braille start --base URL                open a step session for a model
braille step '<json>' | look | close    drive it
braille install | check-runtime <frontend>
braille check-build <dist> enabled|disabled
braille selftest
```

| Environment | Meaning |
|---|---|
| `BRAILLE_CHROME` | path to a browser; default is the one Playwright installed |
| `BRAILLE_ALLOWED_HOSTS` | extra hosts beyond localhost. Never add production |
| `BRAILLE_API_ROOTS` | comma-separated API path prefixes to record and replay; default `/api` |
| `BRAILLE_DISMISS_LABEL` | label of a cookie banner button to press after the first step |
| `BRAILLE_API_FAIL_GRACE_MS` | how long a wait goes on after a request failed and the network went quiet; default 5000 |
| `BRAILLE_SETTLED_GIVEUP_MS` | how long a ready, idle and quiet screen is waited on before a wait ends without a failure; default 5000 |
| `BRAILLE_OCCLUSION_GRACE_MS` | how long a covered button may wait for the cover to go before the step fails naming it; default 1000 |
| `BRAILLE_FILES_DIR` | files for `upload` steps; default `scenarios/files` |
| `BRAILLE_CREDENTIAL`, `BRAILLE_SECRET`, `BRAILLE_TOKEN_KEY` | log in with `bearer` (written to `localStorage[BRAILLE_TOKEN_KEY]`) or `cookie`. `--storage-state` is the alternative |

`--loose` drops the rules for new scenarios (`after` on actions, testid instead of label). Use it only to run scenarios you are migrating.

## Pitfalls

- **Portals.** Toasts, dialogs and lists render outside the screen root. `screen()` includes them; check your library's.
- **Hidden inputs.** Chips and custom checkboxes hide the `<input>` at zero size. Geometry falls back to its `<label>`. Check on your own components.
- **A screen that swallows errors.** The server returned 5xx, the UI showed an empty form, the scenario passed. A recording with a 5xx is refused for that reason, `errors()` keeps the code, and `--sensors` fails the step.
- **Recording.** The executor waits for the network to go quiet, and freezes the browser clock so dated queries match. Other random data has to be fixed by the application.
- **Secrets.** Fields named like `password`, `token`, `secret`, `cookie`, `api_key` are masked in the query, the request body and the response. That list is a name match: read a recording before committing it, and record only with test data.
- **Mass re-recording.** Many re-recordings per change mean a recording key depends on something irrelevant. Fix the key.
- **Fewer scenarios.** One scenario per requirement grows out of hand. Aim for one per screen in one data state.

## Limits

- It does not check appearance. A misplaced button is structurally fine; keep screenshot comparison as a separate check.
- `screen()` returns every element: about 220 bytes each, so a 1000-row screen answers with 218 KB in 59 ms. On long lists, ask `find({testid})`, which took 1 ms there, or paginate.
- Chromium only, one window size (1440×1000).
- Only Vite is tested. The runtime is plain DOM code, but other bundlers need their own flag handling.
- The lint guard is passed by `{...props}` and by wrappers under names you did not list.
- `--sensors` does not see a save after which the list was not reloaded: what a save changes is declared only by the invalidation call, and the missing call is the defect itself.
- A recorded API does not test the backend: compare recordings with your API schema separately.

## License

Apache-2.0.
