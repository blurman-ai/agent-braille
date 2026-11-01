# Driving a screen step by step

```
braille start --base URL
braille step '{"goto": "/path"}'
braille look      # the whole screen
braille close
```

Each answer has `ok`, `api` (the step's requests with status, empty means none), `notices` (toasts and alerts that appeared, even if gone), and `observed`:
`screen` (name, state), `text` (visible text), `elements`, `fields`, `labels`, `options`, `headings`, `overlays`, `facts`. A step's answer lists only what changed; `unchanged` counts the rest, `text` is absent if the same.

Steps, by `testid` from `elements` or by the label from `fields` and `labels`:

```
{"click": {"testid": "people.add"}}        {"click": "Save"}      {"click": {"role": "option", "name": "Engineer"}}
{"fill": "Name", "value": "Ada"}           {"press": "Escape"}
{"wait": "Text"}                           {"absent": "Text"}     {"goto": "/path"}
```

`wait` fails 5 seconds after a request of the step failed and the page stopped working. No pauses are needed: each step waits until the page is not busy.

What to believe: `state` and `busy` say the app has finished. `state: error` is the app's own report: read `text` and `api` to see what actually failed. What is visible proves the result.

After a failed step you continue from where you are. Only when an action happened and its `after` did not come true is `{"goto": ...}` required.

Writing a scenario file: `docs/SCENARIOS.md`.
