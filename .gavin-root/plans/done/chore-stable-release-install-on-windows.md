---
order: 3072
title: [chore] a stable release install beside the dev tree on Windows
labels: windows
status: Done
priority: high
complexity: moderate
---
The dev app is the only Gavin on this machine, and it is the one thing on it
that cannot be trusted to stay up: `tauri dev` restarts it on every Rust edit,
and when the daemon is the app's child it goes too, every PTY with it. The
daemon log under `%LOCALAPPDATA%\gavin` for 2026-09-10 shows exactly that
run: the 14:17 daemon was spawned by the app, the job refused
`CREATE_BREAKAWAY_FROM_JOB`, and nothing was running an hour later.

The fix is not a flag on the dev app. Its binaries live in `target\debug`,
where every agent's `cargo build` either fails against the running exe or
replaces the one the next spawn uses. A stable Gavin has to be a release
build, installed outside the checkout, owning a daemon nothing in the
checkout can reach. Recompiling it is then an explicit act, and losing its
sessions only ever happens when the human chooses to upgrade.

## Recipe

1. A detached worktree pins what the stable build is cut from, so edits in
   flight in the shared tree cannot leak into it mid-compile:
   `git worktree add --detach C:\Users\calfr\coding\gavin-stable <commit>`.
   The first one is 607c560 plus ONLY the uncommitted Windows work as of
   2026-09-10, copied in file by file because none of it had landed yet:
   `daemon.rs` (detachment), `pty.rs` (the `NO_COLOR` fix), `gavin.rs`
   (a symlink helper for the tests), `+page.svelte` (corner radius only on
   macOS), `app.html` (the window title), `package.json`,
   `start-dev-win.ps1` and `docs/dev-setup.md`. The first attempt copied
   every modified file and failed in `agent_tokens.rs`, which the
   resume-conversation card had mid-edit (`log_root` not defined
   anywhere), so the shared tree itself did not compile at that moment.
   That is the reason a stable build is cut from a worktree and not from
   the tree agents are typing in. Once the Windows work lands, moving the
   stable forward is `git checkout <commit>` in that worktree and nothing
   else. Since 2026-09-15 (71b4944) `scripts\start-stable-win.ps1` with no
   flags does that move itself, to this checkout's `main` tip with
   `git checkout -m --detach`, and rebuilds before it launches; `-SkipBuild`
   launches what is already there.
2. `cd gavin-stable\app && npm ci && npm run bundle`. The installer lands in
   `target\release\bundle\nsis\`. `app/src-tauri/BUNDLING.md` says why the
   `--config` flag in that script must not be dropped.
   Since 2026-09-16 (214935d) `scripts\build-windows-installer.ps1` runs
   the same bundle and opens Explorer on the setup exe. It builds THIS
   checkout by default, so a local fix lands in the installer you are about
   to run, and `-Stable` builds the worktree instead, re-cutting it to
   `main` first. The default trades the pinning above for immediacy:
   whatever is uncommitted in the shared tree at build time goes in.
3. Install it, choosing `%LOCALAPPDATA%\Programs\Gavin` as the folder. The
   installer's default is `%LOCALAPPDATA%\Gavin`, which is the daemon's own
   state directory under another case: the binaries would sit beside
   `daemon.log` and the SQLite files. Harmless (Tauri's uninstaller deletes
   only the files it installed and removes the folder only when empty) but
   confusing, and the launch script looks in `Programs\Gavin` first, then
   in the default folder, then in the worktree's `target\release`. The
   collision itself has its own card,
   [fix-windows-installer-collides-with-the-daemon.md](./fix-windows-installer-collides-with-the-daemon.md).
   Then run `scripts\start-stable-win.ps1` or the Start menu entry. Launch
   it from your own terminal or the shell, never from inside `tauri dev`:
   the packaged app spawns its daemon detached and outside any hostile
   job, so it outlives the app.
4. To upgrade: rebuild in the worktree, quit Gavin, stop the daemon, run the
   installer, relaunch. A PTY cannot outlive its process, so the sessions end
   with the daemon in every version; the installer cannot overwrite a running
   `gavin-daemon.exe` either. The rebuild half is scripted (steps 1 and 2
   above); running the setup exe is not, and stays the human's.

## What it does not do

- Isolate state, and by design only halfway. As first written here both
  apps shared the pipe, so the dev app adopted the stable daemon and
  Restart daemon in either killed by process name. Settled 2026-09-11 on
  [issue-stable-and-dev-apps-share-one-state-dir.md](./issue-stable-and-dev-apps-share-one-state-dir.md):
  a debug build binds `daemon-dev.sock` with its own token, log and
  `registry.sqlite`, so neither app can adopt the other's daemon and
  Restart daemon kills only the pid owning the endpoint it connected to.
  `kanban.sqlite`, `orchestration.sqlite` and `config.json` under
  `%APPDATA%\com.gavin.app` stay shared on purpose: one board, one set of
  rails, one workspace list, and a build that widens `config.json` writes a
  shape the other then reads.
- Silence the updater. A release build asks the GitHub endpoint once at
  launch and only reports; installing is behind a confirm. Do not accept an
  upstream release over the local build.

## Steps

- [x] Cut `C:\Users\calfr\coding\gavin-stable` detached at 607c560 with the
      uncommitted Windows work snapshotted in (31 files; `git diff` in the
      worktree is the record of what went in)
- [x] `npm ci` and `npm run bundle` there; record what broke on this card and
      tick the bundle item on
      [feat-windows-port-on-a-windows-machine.md](./feat-windows-port-on-a-windows-machine.md).
      Produced `gavin-stable\target\release\bundle\nsis\Gavin_0.1.0_x64-setup.exe`
      (6.7 MB) on the second run; the staging script ran through Node under
      `cmd /C` without `sh.exe`, and NSIS came from the cache under
      `%LOCALAPPDATA%\tauri`. The only thing that broke was the snapshot
      (step 1 above), not the packaging.
- [x] Confirm the generated NSIS script installs `gavin-daemon.exe` and
      `gavin-mcp.exe` beside `Gavin.exe`, with the target triple stripped.
      `target\release\nsis\x64\installer.nsi` copies both with
      `/oname=gavin-daemon.exe` and `/oname=gavin-mcp.exe` into `$INSTDIR`,
      and its uninstall section deletes exactly those files plus the main
      binary and `uninstall.exe`, then a non-recursive `RMDir`. The three
      exes also sit together in `target\release\`, so the worktree's output
      runs unpackaged too.
- [x] `scripts/start-stable-win.ps1`: find the installed Gavin, refuse to run
      without its sidecars, say which daemon binary is already listening,
      start the app detached from the terminal. `-DryRun` does every check
      without starting anything; `-Path` overrides the search.
- [x] Human: install, launch, and confirm the daemon survives a `tauri dev`
      rebuild in the shared tree (this closes the packaged-app item on
      [fix-daemon-dies-with-the-app-on-windows.md](./fix-daemon-dies-with-the-app-on-windows.md))
- [x] Human: commit the Windows work, then re-cut the worktree from the commit
      and drop the snapshot
      Landed on `win/windows-dev-setup` as e29019a..80881d5 (the daemon
      detachment, the hidden consoles, the launcher, and the rest). Re-cut
      2026-09-10 17:08: every snapshot file was byte-identical to 80881d5
      once CRLF was ignored (the worktree checks out with `autocrlf`), and
      the one that was not, the windows-port card, was a strictly older copy
      of the committed one — so the worktree moved with
      `git checkout -m --detach 80881d5`, which carried the snapshot forward
      onto itself and discarded nothing. `git status` there is clean.
      `target\release\` is untouched, so the running app and daemon are
      still the 16:00 build; "Re-cut" below says what that build lacks.

## First launch, 2026-09-10

Launched from the worktree's `target\release\Gavin.exe` at 14:59. The daemon
it spawned (pid 6880) logged no breakaway refusal, so the app-side
detachment is enough outside `tauri dev`; that answers the packaged-app item
on [fix-daemon-dies-with-the-app-on-windows.md](./fix-daemon-dies-with-the-app-on-windows.md).
Unusable all the same: every action flashes terminal windows and the UI
crawls, because the release app is a GUI-subsystem process and the detached
daemon has no console either, so every `git`, `gh` and `claude` they run
opens a console of its own. Filed and fixed the same day as
[fix-release-app-console-windows-on-windows.md](./fix-release-app-console-windows-on-windows.md),
and the worktree rebuilt twice: 15:24 with the first pass, which still
flashed because the git tab's runner lives in `src/git/` and had been
missed, and 16:00 with that routed too and a lint test guarding every
spawn site. Verified by process trace and a visible-window sample: no
console window from the app or its git children. The daemon binary itself
did not change (the flag lives in the app's spawn of it).

Also learned the hard way: `cargo test -p app` kills the running daemon by
name through `stop_running_daemon`'s fallback, so both full suite runs
that afternoon took the stable daemon and its sessions down. Filed as
[fix-app-tests-kill-the-running-daemon.md](./fix-app-tests-kill-the-running-daemon.md);
until it lands, run the app suite only when the daemon holds nothing you
need.

## Re-cut, 2026-09-10 17:08

The worktree is detached at 80881d5, the tip of `win/windows-dev-setup`,
with no local changes. The binaries in `target\release\` (`Gavin.exe`
16:00, `gavin-daemon.exe` and `gavin-mcp.exe` 14:39) were built from the
snapshot, which equals the tip for every file it touched. What the tip
changed that the snapshot never carried, and the running build therefore
lacks: `agent_tokens.rs` and `lib.rs` (the resume-conversation fix),
`gavin_develop_skill.md` (the embedded skill), the `cardRun`,
`cardRunActions`, `orchestrationState` and `backend` modules on the
frontend, `windowCorners.test.ts`, `LICENSE`, and the plan cards. Bringing
the install up to 80881d5 is step 4 of the recipe: quit Gavin, stop the
daemon, `npm run bundle`, install, relaunch. The link step cannot replace a
running `Gavin.exe` or `gavin-daemon.exe`, and the checkout bumped every
mtime, so cargo will recompile most of the workspace on that run.

Pre-flight for the install item, checked against the running system:

- The app up now is the worktree's `target\release\Gavin.exe` (pid 8016,
  since 16:03); its daemon is pid 18464 from the same folder.
  `IsProcessInJob` answers false for both, so no job — `tauri dev`'s
  included — can take the daemon down; the only things that reach it are
  kills by name (`cargo test -p app`, Restart daemon in either app). The
  daemon log holds the one breakaway refusal, the 14:17 daemon's, and none
  for the four daemons since.
- Nothing is installed yet: neither `%LOCALAPPDATA%\Programs\Gavin` nor a
  `Gavin.exe` under `%LOCALAPPDATA%\Gavin` exists.
- The installer's `CheckIfAppIsRunning` looks for `Gavin.exe` by name in
  the current user's session. Interactive, it asks before killing; `/S`
  and `/P` kill without asking. Quit the worktree app first, or the
  installer will. `gavin-daemon.exe` is not on that list and survives
  either way.
- Silent install into the right folder (`/D=` must be the last argument
  and unquoted), from the stable worktree:
  `.\target\release\bundle\nsis\Gavin_0.1.0_x64-setup.exe /S /D=C:\Users\calfr\AppData\Local\Programs\Gavin`
  The interactive installer wants the same folder typed over its default.
- The installed app adopts the worktree daemon on first launch (the
  launcher says so, with pid and path). To run the INSTALLED daemon, use
  Restart daemon in Settings once: the polite shutdown lands, sessions end,
  and the app respawns from beside itself. Then a `tauri dev` rebuild in
  the shared tree (`scripts\start-dev-win.ps1` from a plain terminal, touch
  one `.rs` file) must leave `Get-Process gavin-daemon` showing the same
  pid under `Programs\Gavin`. Do not run `cargo test -p app` during that
  check.
- Why an agent did not do this: the installer kills the app the human is
  looking at, a dev app started from an agent's tool call hands its
  `CLAUDE_*` environment to every tab
  ([issue-launcher-env-leaks-into-sessions.md](./issue-launcher-env-leaks-into-sessions.md)),
  and the rebuild it would confirm restarts an app on the desktop.

## Status, 2026-09-22 11:30

Every step above re-checked against the running machine and holding.
Nothing on this card is open; what is still open lives on the cards named
at the end, so this one is filed done.

- Installed: `%LOCALAPPDATA%\Gavin`, the installer's default rather than
  `Programs\Gavin` (the uninstall key's `InstallLocation` says so), with
  `Gavin.exe` 0.1.0 and both sidecars beside it. Built today 08:40 to
  08:43 from the DEV checkout's `target\release`, i.e. through
  `scripts\build-windows-installer.ps1`'s default tree: the installed
  `gavin-daemon.exe` hashes identical to `gavin\target\release\`'s, and
  `gavin-mcp.exe` to the 2026-09-15 17:06 one still sitting there (cargo
  found nothing to relink). So the running stable is `main` 662e977 plus
  whatever was uncommitted in the shared tree at 08:40. Installed 08:44,
  launched 08:47.
- Running: `Gavin.exe` pid 23424 and `gavin-daemon.exe` pid 21616, both
  from the install folder. `IsProcessInJob` is false for the daemon, which
  is the one that has to break away, and true for the app, which does not
  matter. One pipe, `gavin-daemon-sock-…`, and no dev pipe. `.mcp.json`
  points every agent at the installed `gavin-mcp.exe` (b8ba17c).
- `scripts\start-stable-win.ps1 -DryRun` passes: finds the install, both
  sidecars present, reports the release daemon as already listening,
  would start it.
- The worktree is detached at 8271956 (2026-09-17), clean (`Cargo.toml`
  lists as modified with an empty diff, the CRLF phantom), 12 commits
  behind `main`. Its binaries are from 2026-09-15 (`Gavin.exe` 21:42,
  cut at 71b4944), OLDER than its HEAD: the reflog shows the launcher's
  full mode moved it to 8271956 on 2026-09-21 at 14:00:01, and the bundle
  stopped eight seconds in (`deps\gavin_daemon.d` at 14:00:09 is the only
  artefact newer than `Gavin.exe`; no exe was relinked). Nothing records
  why; the next `scripts\build-windows-installer.ps1 -Stable` will say.
  Not retried today: two other sessions' cargo builds were running with
  about 2 GB free, and a release rebuild of the workspace on top of them
  is how builds get killed for memory on this machine.
- Open elsewhere: the default-folder collision and the daemon-unaware
  installer on
  [fix-windows-installer-collides-with-the-daemon.md](./fix-windows-installer-collides-with-the-daemon.md)
  (In Progress, four items); the owner's two-daemons check on
  [issue-stable-and-dev-apps-share-one-state-dir.md](./issue-stable-and-dev-apps-share-one-state-dir.md)
  (one item); §1's install-and-check items on
  [feat-windows-port-on-a-windows-machine.md](./feat-windows-port-on-a-windows-machine.md).
