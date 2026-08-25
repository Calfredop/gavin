---
kind: task
title: [bug] Commit tool
status: Done
---
# [bug] Commit tool

adding the commit tool to a rail, when it finish, it doesn't notify the rail which gets stuck until I manually remove the commit session and step

## What it was

Not the Commit tool — **every `agent`-kind tool**: Commit, Merge, Browser test
and Review this branch, four of the ten built-ins, all from one cause.

`executeToolLaunch` runs an agent tool through `buildRunCommand`, the same
interactive command a card step uses. An interactive agent never exits — it
finishes its turn and sits at its prompt forever, which is the whole reason
`buildHeadlessCommand` exists for the runs that must end. But a tool step has
no card, so rule 1 is skipped for it and its only completion path was T5's
"session gone + exit 0". The session never went. The step stayed `running`,
the daemon refuses every plan write that drops a `running` step, and the rail
was wedged shut until the session and the step were deleted by hand.

Measured rather than reasoned, on this machine: session `8ddda88e` — the agent
that finished the "Orchestration agent actions" card and filed it Done — was
`idle` in the registry with its process still alive 16 minutes later. Every
`claude '<prompt>'` row in that registry is `idle`/`working`; only `claude -p …`
and the shell tools ever reach `exited`.

The whole library was re-verified, each tool run as the daemon runs it
(`sh -c`), in a throwaway repo with a local bare remote:

| tool | kind | session ends? | verdict |
|---|---|---|---|
| Commit / Merge / Browser test / Review | agent | never | **was unfinishable** |
| Push branch | command | exit 0 | done |
| Open a pull request | command | exit 1 off GitHub | stalls, with the reason |
| Run tests | command | exit 254 | stalls, with the reason |
| Run Unity tests | command | exit 127 | stalls, with the reason |
| Send a notification | command | exit 0 | done |
| Send an email | script | wrapper + AppleScript verified, not sent | done — but its `to` default is empty, so it needs editing before it can succeed |

## The fix

An agent tool step is done when **its session goes `idle`** — the daemon's own
signal, the one already behind the "<label> finished" notification.
`working` and `waiting_for_input` both keep it running, the latter
deliberately: `pty.rs` pins `TERM_PROGRAM`, so an agent that wants the human
says so rather than merely going quiet, and the daemon refuses to let a quiet
period downgrade it — advancing past a question would answer it by walking
away. A session with no status yet keeps running too, since the daemon
registers every new session `idle`.

Command and script tools keep their exit code as the whole verdict. Card steps
are untouched: rule 1 owns them, because an agent that stopped talking without
finishing its card left the work undone.

Headless was the alternative and was rejected: the only verified headless argv
is claude's, scoped to `Bash(git *)` on purpose, which kills Browser test,
stops Merge running the tests its own prompt demands, and stalls all four
tools under codex, gemini and cursor.

With it, a **Mark done** button beside Retry on any running or stalled step, so
a signal that never arrives costs one click instead of the session and the step.

Reproduced in code over the real `BUILTIN_TOOLS` (`every built-in tool can
finish`): against the unfixed scheduler exactly the four agent tools fail and
the six others pass. Verified in a detached worktree at HEAD carrying only this
change — 1478 tests green, 0 type errors, build clean — because the shared tree
was mid-flight with another session's work at the time.
