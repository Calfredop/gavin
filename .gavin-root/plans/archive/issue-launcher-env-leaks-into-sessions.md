---
order: 10240
kind: task
title: [issue] launcher env leaks into sessions
status: Done
---
A session inherits whatever environment the GUI was launched from, so an
agent that starts the app hands its own session identity to every tab.

Found while diagnosing `issue-windows-terminal` (the black-and-white
terminals). That card's root cause was one inherited variable, `NO_COLOR`;
these are the rest of the same leak, and they are not about colour.

Observed on the app instance running on this machine, whose parent chain is

    Claude Code powershell tool -> scripts/start-dev-win.ps1 -> npm
      -> node (tauri) -> cmd -> cargo -> cargo -> Gavin.exe -> gavin-daemon.exe

Every PTY that daemon spawns therefore carries:

  - `CLAUDECODE=1`, `CLAUDE_CODE_ENTRYPOINT=cli`, `CLAUDE_CODE_CHILD_SESSION=1`,
    `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_BRIDGE_SESSION_ID`, `CLAUDE_PID` --
    so a `claude` started in a gavin tab can read itself as a nested child of
    the agent that happened to launch the app, rather than the top-level
    session it actually is.
  - `GIT_TERMINAL_PROMPT=0` -- git in every tab silently fails instead of
    asking for credentials.

Not yet established, and worth settling before touching anything: whether
those `CLAUDE_*` values actually change how a hosted agent behaves, or are
merely inert. Colour is already ruled out -- the fix on
`issue-windows-terminal` was measured with all of these still present and
colour came back fine, so this is a separate question.

The decision is also not simply "strip them". `GAVIN_SESSION_ID` and
`GAVIN_SESSION_TOKEN` are deliberately passed in by the same code, and a
hosted agent may legitimately want some of what it inherits; a blanket
scrub would be a different bug. The judgement is which variables name the
*launcher's* session rather than this one.

Where it would go: `PtySession::spawn` in `crates/daemon/src/pty.rs`, beside
the existing `TERM` / `TERM_PROGRAM` pins and the `NO_COLOR` removal, which
already carry the reasoning for why the daemon's launcher does not get to
answer questions about the terminal the app draws itself.

## Settled: not inert

The open question above has an answer, and it is the bad one. The worst
of them is `CLAUDE_CODE_CHILD_SESSION`, which Claude Code reads as "you
are a nested child, not a top-level session" and answers by **turning
transcript persistence off**: the session's JSONL is never written, so
`--resume` and `--continue` cannot find it afterwards, and prompt history
is dropped for the tab.

It is not a deduction. This repo was already carrying the evidence:
`crates/daemon/tests/fixtures/claude-code-tui.raw`, captured from an agent
running in a real gavin tab, contains the banner

    Transcript saving is off - inherited CLAUDE_CODE_CHILD_SESSION marker
     - restart with CLAUDE_CODE_FORCE_SESSION_PE...

The marker has an escape hatch for exactly this shape of mistake, but it
only forgives a marker that arrived via tmux's global environment, on the
grounds that it is ambient rather than a real parent-child link. A PTY
opened by this daemon is the same ambient case and gets no such reprieve,
so the daemon has to answer it by not passing the marker on.

Two more, neither in the original list, both found by reading the
environment the app was actually launched with rather than the report:

  - `CLAUDE_CODE_MESSAGING_SOCKET` + `CLAUDE_CODE_MESSAGING_TOKEN` -- the
    launcher's cross-session message bus and a live bearer token for it.
    The sharpest of the set, because it is a credential for somebody
    else's session sitting in every tab.
  - `GCM_INTERACTIVE=never` and `GIT_EDITOR=true`, set as a pair with
    `GIT_TERMINAL_PROMPT=0`. On Windows `GCM_INTERACTIVE` is the one that
    actually bites -- Git Credential Manager is the helper this platform
    ships and "never" forbids its UI, so a `git push` in a tab fails
    looking like a broken credential store. `GIT_EDITOR=true` is worse
    than a refusal: it makes a bare `git commit` succeed with an empty
    message and `git rebase -i` skip its todo list, which is lost work
    rather than a visible failure.

## Done

`PtySession::spawn` now removes two groups, beside the `NO_COLOR` block
and for the same stated reason. Identity: `CLAUDECODE`,
`CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_CHILD_SESSION`,
`CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_BRIDGE_SESSION_ID`, `CLAUDE_PID`,
`CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`, `AI_AGENT`,
`CLAUDE_EFFORT`. Non-interactivity: `GIT_TERMINAL_PROMPT`, `GIT_ASKPASS`,
`GCM_INTERACTIVE`, `GIT_EDITOR`.

The line drawn, as the card asked: a variable goes only if it names the
**launcher's session**. That is why this is a list and not a `CLAUDE_*`
sweep -- `ANTHROPIC_API_KEY` and `CLAUDE_CODE_USE_BEDROCK` are user
configuration a terminal is entitled to inherit, and
`CLAUDE_CODE_EXECPATH` names an *install*, which every session of that
install shares. None of those are this bug, and a test pins the two kept
cases so a later sweep cannot quietly take them.

Three tests in `pty.rs`, each checked to fail with the scrub disabled
rather than assumed: with it off the PTY prints
`IDMARK=[1][cli][1][launcher-session-uuid][...][launcher-secret][...]`
and `GITMARK=[0][][never][true]`.

Also here: `lock_env()` replaces `ENV_MUTEX.lock().unwrap()` in the test
module. It guards `()`, so a poisoned lock carries no information except
"an earlier env test failed" -- and propagating it turned one real failure
into a cascade of misleading ones, which is exactly what happened while
proving the tests above. Tripling the number of tests on that mutex made
it worth fixing.

`scripts/start-stable-win.ps1` warned that every tab would inherit the
launching agent's environment. That is no longer true for a current
daemon, so it now says which builds strip it and which still pass it
through.

Not verified here, and the owner's to confirm in the running app: that a
`claude` started in a tab of a rebuilt daemon reports a top-level session
and keeps its transcript. The daemon on this machine is the shared
long-lived one, and a rebuild and restart is the human's call.
