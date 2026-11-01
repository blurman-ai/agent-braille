# agent-braille

When an agent has only indirect evidence about a UI, it guesses, and a wrong guess costs far more tokens than any screenshot: it reads code, reruns and fixes what is not broken. agent-braille gives the agent direct evidence through structured answers: which screen is open, whether it finished loading, which buttons exist, which are disabled or covered, and what just failed.

```json
{"screen": {"name": "people", "state": "empty"},
 "elements": [{"testid": "people.add", "role": "button", "name": "Add person"}],
 "fields": [], "options": [], "overlays": [], "facts": {"count": "0"}}
```

Each source answers its own question. `state` and `busy` say the app has finished. What is visible proves the result, so a scenario needs at least one check of it; `fact` and `state` alone are refused, because they are the app's own report. A failed step names the cause: what covers a button, and which API requests the step made, or that it made none.

It has four parts:

| Part | What it does | Where |
|---|---|---|
| In-page API | `window.__agent`: `screen`, `busy`, `find`, `act`, `layout`, `errors`, `tools`. Exists only in a build with `VITE_AGENT_API=1` | `runtime/` |
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

1. **Install the runtime.** `node <braille>/bin/braille.mjs install <frontend>` copies it to `<frontend>/src/shared/agent/`. `check-runtime <frontend>` later reports drift.
2. **Load it at the entry point, before the first request:**
   ```ts
   import { maybeInstallAgentApi } from "./shared/agent/bootstrap";
   maybeInstallAgentApi();
   ```
3. **Prove both builds.** Build with `VITE_AGENT_API=1`, run `braille check-build <dist> enabled`. Build without it, run `braille check-build <dist> disabled`. Production is always built without the flag. Plain esbuild keeps the module even with the flag off: on any bundler other than Vite this check decides, and the import has to be replaced with an empty module.
4. **Declare what the page is busy with,** so the executor never sleeps. For React Query and React Router:
   ```ts
   registerBusySource("queries", () => queryClient.getQueryCache().findAll({ fetchStatus: "fetching", predicate: (q) => q.state.data === undefined }).length);
   registerBusySource("mutations", () => queryClient.isMutating());
   registerBusySource("navigation", () => (router.state.navigation.state === "idle" ? 0 : 1));
   ```
   Leave out background refetches over loaded data, or a polling page never settles.
5. **Mark up screens.** On the root of each page: `{...screenRootProps("people", queryScreenState(query))}`. The root exists from the first frame and takes its state from the main request, never a timer. Start with one screen. Pages without a root are reported as `NO ROOT` in the run output.
6. **Add testids to action buttons:** `<screen>.<action>`. Repeated elements share one id and a step picks the instance with `item`.
7. **Turn on the guard.** Copy `frontend/testidScope.js` and `eslint-testid-block.js`, list your button components in `testidBlock([...])`. Copy `frontend/testids.test.js`; its control cases must fail on a button without a testid. Add directories as you mark them up.
8. **Switch off tours and hints.** They call `agentTurnedOff("onboarding")` from `runtime/switches.ts`; the executor sets that key itself, so they do not pop up over steps.
9. **Write the first scenario step by step** as in [docs/SCENARIOS.md](docs/SCENARIOS.md), record the API, replay it with the backend stopped. Break one expectation and confirm that it goes red with a clear reason.
10. **Tell your agents.** Add to `AGENTS.md`: read screens through `window.__agent` and `braille step`, follow `docs/SCENARIOS.md`, use a screenshot only for questions about appearance.

Done when every page has a root with `data-state`, lint covers every screen with buttons, and each screen with meaningful behaviour has a green scenario plus a control that can go red.

If the application calls an LLM on a scenario's path, see [docs/RECORDINGS.md](docs/RECORDINGS.md).

## Commands

```
braille check <dir>                     validate all scenarios, no browser
braille run <file>… --base URL          run scenarios: --out DIR, --storage-state FILE, --values FILE,
                                        --record-api DIR, --replay-api DIR, --loose
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
| `BRAILLE_OCCLUSION_GRACE_MS` | how long a covered button may wait for the cover to go before the step fails naming it; default 1000 |
| `BRAILLE_FILES_DIR` | files for `upload` steps; default `scenarios/files` |
| `BRAILLE_CREDENTIAL`, `BRAILLE_SECRET`, `BRAILLE_TOKEN_KEY` | log in with `bearer` (written to `localStorage[BRAILLE_TOKEN_KEY]`) or `cookie`. `--storage-state` is the alternative |

`--loose` drops the rules for new scenarios (`after` on actions, testid instead of label). Use it only to run scenarios you are migrating.

## Pitfalls

- **Portals.** Toasts, dialogs and lists render outside the screen root. `screen()` includes them; check your library's.
- **Hidden inputs.** Chips and custom checkboxes hide the `<input>` at zero size. Geometry falls back to its `<label>`. Check on your own components.
- **A screen that swallows errors.** The server returned 5xx, the UI showed an empty form, the scenario passed. A recording with a 5xx is refused for that reason, and `errors()` keeps the code.
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
- A recorded API does not test the backend: compare recordings with your API schema separately.

## License

Apache-2.0.
