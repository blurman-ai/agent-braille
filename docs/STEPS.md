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

`wait` fails after 5 quiet seconds when a request failed and nothing is on its way, naming the request. No pauses are needed: each step waits until the page is not busy.

`contradictions` lists where the app's report disagrees with the network or itself: treat these as leads, not verdicts.

`sent` shows the body of each change and its answer. `visual` lists what a person cannot see though the tree has it: text the colour of its background, transparent, cut, covered, outside its container or the screen, and a control whose name in the tree differs from what it shows. The answer to an action comes after the changes it started have finished.

A `visual` line means a person using the app cannot read that text, whatever the tree or the network says, and even if the same happens on every row. A requirement that something is shown fails on it. A `notices` line is what the app told the person: if it says the result is not what was asked for, believe it.

What to believe: `state` and `busy` say the app has finished. `state: error` is the app's own report: read `text` and `api` to see what actually failed. What is visible proves the result.

After a failed step you continue from where you are. Only when an action happened and its `after` did not come true is `{"goto": ...}` required.

If an answer does not explain why something did not happen, and you can edit the frontend, add a fact where the code decides: `screenFactProps("blocked-by", reason)`. Name the consequence (`saved-to=local-only`), not the internal mode. Rebuild, step again, and check the fact in a scenario.

Writing a scenario file: `docs/SCENARIOS.md`.
