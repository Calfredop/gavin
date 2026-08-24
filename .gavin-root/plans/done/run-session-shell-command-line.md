---
order: 512
title: Run session: spawn the launch command as a shell command line
status: Done
priority: high
---
"Run session" on a card fails with:

> Couldn't start the agent: expected SessionCreated, got Error { message: "Unable to spawn claude 'Read …/plans/workspace-init-wizard.md and execute that plan. …' because it doesn't exist on the filesystem and was not found in PATH" }

**Root cause.** `crates/daemon/src/pty.rs:24` does `CommandBuilder::new(shell)` with the
*whole* `command` string as argv[0] — no argv splitting, no shell. The frontend
(`app/src/lib/cardRun.ts`, `buildRunCommand` + `shellQuote`) deliberately composes a POSIX
shell command line (`claude 'prompt…'`), and `workspace-settings-design.md` documents
`[agent].command = "claude --model opus"`. So anything but a bare program name fails —
this breaks the documented config too, not just card runs.

**Fix.** When a `command` is supplied, spawn it through `/bin/sh -c` (POSIX quoting, which
is exactly what `shellQuote` emits). `command: None` keeps spawning `$SHELL` directly.

- [x] Failing test in `pty.rs`: a command line with a quoted multi-word argument spawns and runs
- [x] `PtySession::spawn` routes `Some(command)` through `/bin/sh -c`
- [x] Second test pins the `'\''` quoting contract `shellQuote` emits
- [x] Retarget the two tests that relied on a bad command failing the spawn (it now exits 127 instead)
- [x] `cargo test -p gavin-daemon` green (191 passed)
- [x] Manual smoke: restart the daemon, then Run session on a card actually starts the agent
