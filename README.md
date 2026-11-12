# session-cockpit

A Claude Code mod that turns the terminal session into a small cockpit.

## What it does

- **HUD above the prompt**: folder, git branch, context-window bar, 5-hour and 7-day rate limits, and the last turn's duration, tool calls and edited files.
- **Colored tool calls**: a gutter mark per tool kind (blue = read/search, yellow = file edits, magenta = shell, red = risky command or error, cyan = subagent).
- **Subagent pane**: one live row per subagent with its model and elapsed time. Opens on the first spawn; `/cockpit` opens it at any width.
- **Quiet diffs**: Edit/Write results show one `+N −M` line; ctrl+o still shows the full diff.
- **Guards**: asks before `git push`, cluster-mutating `kubectl`/`helm`/`helmfile`, and `tofu`/`terraform apply|destroy`; asks before spawning a subagent that is not on Sonnet or Haiku.
- **Notification** when a turn longer than 60 seconds finishes.

Prompts and labels are in Vietnamese.

## Install

At the prompt of a terminal session:

```
/plugin install session-cockpit --marketplace nguyenleminhquan/session-cockpit
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install session-cockpit --marketplace nguyenleminhquan/session-cockpit
```

## Develop

```
claude --plugin-dir <path to this folder>
claude plugin validate .
claude plugin test .
```
