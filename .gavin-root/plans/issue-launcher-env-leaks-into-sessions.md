---
order: 10240
kind: task
title: [issue] launcher env leaks into sessions
status: To Do
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
