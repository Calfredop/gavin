---
order: 9216
title: [fix] on Windows the daemon dies with the app, taking every session with it
status: Done
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
      Since then `DETACHED_PROCESS` became `CREATE_NO_WINDOW`
      ([fix-release-app-console-windows-on-windows.md](./fix-release-app-console-windows-on-windows.md)):
      a daemon with no console at all handed every `git` it ran a console
      window of its own. The job handling did not change.
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

## Was open

- [x] Confirm the packaged app needs none of the script half — a bundled Gavin
      is not launched inside tauri dev's job, so the app-side detachment should
      be sufficient there. Confirmed 2026-09-10 on the release build in the
      stable worktree, launched from a terminal — the three exes in its
      `target\release\` are exactly what the NSIS installer copies. The daemon
      it spawned logged no breakaway refusal, and a probe that evening
      answered `IsProcessInJob` **false** for both `Gavin.exe` (pid 8016) and
      `gavin-daemon.exe` (pid 18464), while the probing shell's own pid
      answered true — the probe discriminates, and no job, tauri dev's
      included, can reach that daemon. The terminal that launched them is
      gone and both are still up. Not re-run against the NSIS-installed copy
      (nothing is under `Programs\Gavin` yet), but job membership comes from
      the creator, not the folder, so installing cannot change it. The
      script half is dev-only. Record on
      [chore-stable-release-install-on-windows.md](./chore-stable-release-install-on-windows.md).
- [x] Decide whether the app should be able to escape a hostile job on its own
      rather than depending on the launcher. The route that works when
      breakaway is refused is to have a process outside the job do the
      creating — `Win32_Process.Create` over WMI is the usual one, since the
      WMI service is the creator. It costs the `Child` handle and the stdio
      redirect, so it is a real trade, not an obvious win.
      **Decided 2026-09-10: no.** The only job that has ever refused
      breakaway is `tauri dev`'s, and that case is handled where the job is
      made — `start-dev-win.ps1` starts the daemon before the app exists —
      while the packaged app has no hostile job (item above). What the escape
      costs is concrete. With a third party as creator the app gets a pid at
      best, not a `Child`, so the stdout/stderr redirect that writes
      `daemon.log` goes with it and the daemon would have to open its own log;
      the environment becomes the creator's, not the app's; and the app grows
      a COM dependency — WMI, the Task Scheduler, or `Shell.Application`
      through explorer.exe, same trade with a different creator — that only a
      dev flow exercises. The refusal is logged rather than swallowed, so if a
      packaged launch ever lands in a job without
      `JOB_OBJECT_LIMIT_BREAKAWAY_OK` — a launcher or installer that wraps the
      app in one — the log names it, and that is what reopens this. Until
      then the launcher is the contract for dev.
- [x] `scripts/start-dev-mac.sh` is deliberately untouched: reparenting already
      gives macOS the behaviour this arranges by hand. If the Linux port lands,
      check which of the two it resembles. Answered from the code, 2026-09-10:
      Linux is macOS, not Windows. `spawn_detached` is the plain spawn on every
      non-Windows target, tauri-cli's rebuild kill is the same unix code on
      both, and an orphan reparents to init (or the nearest subreaper) on
      both. The Linux-only ways to lose the daemon are a `PR_SET_PDEATHSIG`
      the daemon never sets and a systemd scope killing its whole cgroup,
      which no dev flow does. Nothing to change in the mac script or the
      code; the check on a real box now sits on
      [the Linux port card](./feat-linux-port-on-a-linux-machine.md) §2,
      where it will actually be run.
