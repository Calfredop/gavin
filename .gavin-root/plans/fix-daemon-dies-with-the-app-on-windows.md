---
order: 9216
title: [fix] on Windows the daemon dies with the app, taking every session with it
status: In Progress
priority: high
complexity: moderate
---
On Windows the daemon and the app are one process tree, so anything that tears
the app down takes the daemon with it. Under `tauri dev` that is every rebuild:
editing one source file killed both, two seconds later, every PTY session
included. An agent developing gavin inside gavin edits source constantly, so
the rail could not complete a single card — it destroyed the daemon running it.

Measured, by touching one file's mtime and changing nothing:

```
BEFORE  Gavin.exe 17076  <-  cargo 14836  <-  cargo 4360  <-  node 8748  <-  cmd 10520
        gavin-daemon.exe 19032  <-  Gavin.exe 17076
  daemon 19032 DIED at +2s
  app    17076 DIED at +2s
```

## Why, and why only here

`spawn_real_daemon` was `Command::new(binary).spawn()` — a plain child, with no
platform handling on either side. Unix carries that for free: an orphan is
reparented to init and keeps running, which is exactly what `docs/dev-setup.md`
promises and why nobody had to arrange it. On Windows a child joins its
parent's **job object**, and killing a job kills everything inside it.

**The app cannot fix this from the inside.** It can ask to leave the job with
`CREATE_BREAKAWAY_FROM_JOB`, and tauri dev's job **refuses** — `CreateProcess`
answers `ERROR_ACCESS_DENIED` rather than ignoring the flag. That refusal is
now recorded in the daemon log instead of being swallowed, because the fallback
it triggers puts the daemon back inside the job: silently reinstating the bug
while a log line claims a daemon started is worse than the bug.

## Done

- [x] Detach the daemon as far as the app is able:
      `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`, plus a
      `CREATE_BREAKAWAY_FROM_JOB` attempt that falls back when refused. This is
      what a packaged build needs, where there is no hostile job — and the
      console and Ctrl-C isolation are worth having regardless.
- [x] Give the detached daemon somewhere to speak: `%LOCALAPPDATA%\gavin\daemon.log`,
      appended and never truncated, since the interesting case is a daemon that
      died and was replaced. `DETACHED_PROCESS` costs it a console, and its
      startup line names the socket it bound — the first thing anyone debugging
      a connection asks for.
- [x] Say when the breakaway was refused, in that same log, immediately before
      the startup line of the daemon it describes.
- [x] Start the daemon from `scripts/start-dev-win.ps1` instead, before the app
      exists, and only when nothing is already listening. A daemon that is a
      child of the script never enters tauri dev's job, and the app adopts it
      rather than spawning one. Verified: app restarted at +2s, daemon survived,
      new app took over the existing one.
- [x] A test on the flag contract: the first attempt carries the breakaway bit,
      the retry does not, and neither keeps a console. Asserted on the flags
      rather than on a spawned process, because whether a job permits breakaway
      is a property of whatever launched the test runner.

## Still open

- [ ] Confirm the packaged app needs none of the script half — a bundled Gavin
      is not launched inside tauri dev's job, so the app-side detachment should
      be sufficient there. Unverified: it wants an installed build, which is
      section 1 of
      [the windows port card](./feat-windows-port-on-a-windows-machine.md).
- [ ] Decide whether the app should be able to escape a hostile job on its own
      rather than depending on the launcher. The route that works when
      breakaway is refused is to have a process outside the job do the
      creating — `Win32_Process.Create` over WMI is the usual one, since the
      WMI service is the creator. It costs the `Child` handle and the stdio
      redirect, so it is a real trade, not an obvious win.
- [ ] `scripts/start-dev-mac.sh` is deliberately untouched: reparenting already
      gives macOS the behaviour this arranges by hand. If the Linux port lands,
      check which of the two it resembles.
