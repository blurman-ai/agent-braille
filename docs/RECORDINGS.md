# Recorded LLM answers

Needed only if the application calls an LLM on a scenario's path. This code is not in the project because it lives where your backend calls the provider; below is the design to build there.

**Recording.** One pass against a local environment with the real model saves the answers to files in git: `task`, `semantic`, `request`, `provider_model`, `response`.

**Key:** `task` + `semantic`. `semantic` is a fingerprint of the meaning of the input (the task's significant fields), not the prompt text. `request` is a fingerprint of the prompt.

| Outcome | When | Action |
|---|---|---|
| `hit` | key found, same `request` | return the recording |
| `stale` | key found, the prompt was edited | return the recording: a screen scenario tests the screen, not the model |
| `miss` | no key | refuse with a code such as `llm_replay_miss`; **never** fall through to the live model |

Required checks:

- A production process refuses to start with substitution on, and a test proves it.
- Recordings come only from a local environment: others may hold user data.
- A replay run goes red on any live call. Count them in your usage log; a green step proves nothing.
- Control: a scenario with its file removed must go red with the miss code.
- Model quality is checked separately at the call site, with a schema and a judge. A screen scenario does not do it.

Keep derived fields out of the key: they produce a miss on every code change and push you toward mass re-recording. Before a live recording, look for an existing answer to reuse.
