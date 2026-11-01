# Scenarios: rules for a model

A scenario is `<dir>/<name>.json`. Files starting with `_` are controls and must be red.

```json
{"name": "people-add", "why": "what this checks and why", "verifies": ["spec: requirement title"], "steps": []}
```

Optional: `"onboarding": true` keeps tours and hints on.

## The loop

1. `braille start --base http://localhost:5173` against a build with `VITE_AGENT_API=1`.
2. First step: `braille step '{"goto": "/path"}'`.
3. `ok: true`: the step is recorded and `observed` holds what is visible now. `ok: false`: not recorded, `error` says why. After a failed action only `goto` is accepted.
4. Choose the next step **only from the last `observed`**. A testid that is not there does not exist.
5. `braille look` shows the screen without a step. `braille close` writes the steps to `steps.json` in the session directory; copy them into `steps` as they are.
6. `braille check <dir>` gives no problems, `braille run <file> --base …` is green.

`api` in the answer lists the API requests of this step with their status; empty means the step made none. Read it instead of logs.

`observed`: `screen` (name, state), `elements` (visible, with testid), `fields` (inputs by label), `labels` (buttons without a testid), `options` (open list items), `headings`, `overlays`, `facts`.

## Steps

| Need | Step |
|---|---|
| open a page | `{"goto": "/items", "after": {"screen": "items", "state": "ready"}}` |
| press | `{"click": {"testid": "items.add"}, "after": {"shown": ["items.title"]}}` |
| pick one of several alike | `{"click": {"testid": "items.row", "item": "First"}, "after": {"state": "ready"}}` |
| pick from an open list | `{"click": {"role": "option", "name": "Engineer"}, "after": {"state": "ready"}}` |
| type | `{"fill": {"testid": "items.title"}, "value": "Text", "after": {"state": "ready"}}`, or a field label instead of the target |
| key | `{"press": "Escape", "after": {"gone": ["items.title"]}}` |
| upload | `{"upload": "sample.txt", "after": {"state": "ready"}}` |
| wait | `{"wait": {"testid": "items.row"}}`, `{"wait": "Text from the requirement", "within": 30}` |
| enabled, disabled | `{"enabled": {"testid": "a.b"}}`, `{"disabled": {"testid": "a.b"}}` |
| not there | `{"absent": {"testid": "a.b"}}`, `{"absent": "Text"}` |
| order on the page | `{"order": ["First", "Second", {"testid": "a.b"}]}` |
| checkbox, focus | `{"checked": {"testid": "a.b"}}`, `unchecked`, `focused` |
| field value | `{"field": {"testid": "a.b"}, "has": "text"}`, `{"filled": {"testid": "a.b"}}` |
| fact | `{"fact": {"mode": "preview", "step": "4"}}` |
| hover | `{"hover": {"testid": "a.b"}}` |
| CSS, last resort | `{"visible": {"selector": "[role=tooltip]"}}`, `hidden` |
| description for screen readers | `{"described": "Field", "has": "text"}` |
| download | `{"download": {"testid": "a.b"}, "named": {"selector": "h1"}}` |
| repeat | `{"repeat": [{"click": {"testid": "a.next"}, "after": {"state": "ready"}}], "until": "Done", "max": 40}` |
| same link | `{"same-href": ["tr:has-text('A') a", "tr:has-text('B') a"]}` |
| delay a request | `{"hold": "/uploads", "ms": 6000}` |
| lose a response | `{"cut": "/answer"}`: the request reaches the server, the page gets a network failure |
| server finished by itself (replay) | `{"advance": "/jobs"}` before waiting for the result |
| second tab | `{"tab": "open"}`, `first`, `second` |
| tab hidden | `{"visibility": "hidden"}`, `visible` |
| count requests | `{"requested": "/pause", "times": 1, "method": "POST"}` |

Text values may use `{name}` substitutions from `--values` or a recording.

- **`after` is required on `goto`, `click`, `fill`, `press`, `upload`:** what becomes observable. Fields: `screen`, `state`, `shown`, `gone`, `within` (seconds, default 20). In a session you may send a step without it: the executor records what it saw in `recorded.after`. Compare that with the requirement; if it is wrong, the scenario or the screen is wrong.
- **`name` on a testid target only for a label the requirement quotes.** Otherwise a harmless copy change breaks the scenario.
- `item` is data (a row, an answer), not interface text.
- **Each source answers its own question.** `state` and `busy` say the app has finished; only what is visible proves the result. A scenario needs at least one check of what is visible (`after.shown`, `after.gone`, a check step): `fact`, `state` and `requested` alone are refused.
- `"optional": true` for what appears only sometimes.
- After every action the executor waits for `window.__agent.busy()` to be empty. No pauses needed.

## Forbidden

- A testid, screen or state that was not in `observed`.
- Fixed pauses such as `{"wait": 2000}`.
- Reading screen sources or executor code to find a button. If it is not in `observed`, stop and name the screen and the button. If `observed` lacked what the step needed, fix what the executor reports instead of reading code.
- Editing a check to make a scenario green.

## When to stop

Return what was done, the last three errors and what was ruled out when one step failed three times with different fixes, a needed element is not in `observed`, or the screen disagrees with the requirement.

## Reading a red run

`report.json` in the run directory has `evidence` for the failed step, with a screenshot next to it. Read in this order:

1. `load`: `agent: false` with an empty root or `chunkErrors` means the page did not load. Neither the product nor the scenario is at fault.
2. `requests`, `pageerrors`: a 4xx/5xx or a page error names the cause.
3. `api`: no failing request but the expectation did not hold: the page got different data or did not ask again.
4. The expectation failed sooner than the event could happen: wait for a signal (`after`, `data-state`), not a pause.
5. Open the screenshot last: it costs more than the text.

## Recording and replay

```
braille run s.json --base URL --record-api api/       # on a green run
braille run s.json --base URL --replay-api api/       # no backend
```

The state of the server is the last completed change (a non-GET request) in the recording. A GET gets the first answer captured in that state, however many times the page asks. A request that is not in the file turns the scenario red and names the address. Foreign hosts are closed during replay.
