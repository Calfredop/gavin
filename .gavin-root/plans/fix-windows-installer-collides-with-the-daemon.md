---
order: 9216
title: [fix] The Windows installer installs into the daemon's state directory, and never stops the daemon
labels: windows
status: In Progress
priority: high
complexity: medium
---
Found 2026-09-11 while working
[feat-windows-port-on-a-windows-machine](./feat-windows-port-on-a-windows-machine.md)
§1, by reading the `installer.nsi` the 2026-09-10 `npm run bundle` generated
(`gavin-stable/target/release/nsis/x64/installer.nsi`) against what the
daemon actually writes. Neither of these is visible from a dev build, and
neither needs the installer to be run to be certain of — the generated
script says both in as many words.

The good news the same reading settles, so it does not need re-checking:
`externalBin` **does** strip the target triple. Lines 643–644 are

```
File /a "/oname=gavin-daemon.exe" "...\binaries\gavin-daemon-x86_64-pc-windows-msvc.exe"
File /a "/oname=gavin-mcp.exe"    "...\binaries\gavin-mcp-x86_64-pc-windows-msvc.exe"
```

into `$INSTDIR`, beside `Gavin.exe` — which is what `resolve_daemon_binary_path`
and `resolve_mcp_binary_path` join against `current_exe().parent()` to find.

## 1. `$INSTDIR` and the state directory are the same folder

The per-user default install directory is `$LOCALAPPDATA\Gavin`
(installer.nsi:504). `app_support_dir` returns `%LOCALAPPDATA%\gavin`
(protocol/src/lib.rs). Windows paths are case-insensitive, so these are
**one directory** — the one that already holds `kanban.sqlite`,
`orchestration.sqlite`, `registry.sqlite`, `daemon.token` and `daemon.log`
on this machine. A machine-wide install lands in `$PROGRAMFILES64\Gavin`
and has no collision, so this only bites the default.

What it costs today:

- **The uninstaller's "Delete app data" checkbox is a no-op that reads as
  a promise.** It removes `$APPDATA\${BUNDLEID}` and
  `$LOCALAPPDATA\${BUNDLEID}` — `com.gavin.app`, a directory gavin has
  never written to. The real databases are in `$INSTDIR`, and survive.
- **An uninstall leaves the folder behind, silently.** `RMDir "$INSTDIR"`
  (installer.nsi:774) is not `/r`, so it fails on a non-empty directory
  and says nothing. The user is left with the databases, a stale
  `daemon.token`, and no binaries.
- It is one `/r` away from being data loss instead of litter, and nothing
  in the repo records that the two directories must not converge.

## 2. Nothing stops the daemon before overwriting it

`CheckIfAppIsRunning` is inserted twice (635, 754) and both times for
`${MAINBINARYNAME}.exe` — `Gavin.exe` only. `gavin-daemon.exe` is never
checked, and it is precisely the process that outlives the app: it is
spawned `DETACHED_PROCESS` and stays up after every window closes.

Windows will not let `File /a` overwrite a running executable, so an
**upgrade over a live daemon fails to replace `gavin-daemon.exe`** — and
the new `Gavin.exe` then talks to the old daemon binary. That is the
version-skew state `gavin-mcp` already fails closed on, arrived at by
installing rather than by not rebuilding.

## Fix

Done 2026-09-22 on branch `win/installer-state-dir` (worktree
`gavin-win-installer-state-dir`), uncommitted: `app/src-tauri/nsis/hooks.nsh`
(new), `tauri.windows.conf.json` (`bundle.windows.nsis.installerHooks`),
`BUNDLING.md` (a "Windows: the install directory and the daemon" section),
the doc comment on `protocol::resolve_app_support_dir`, and the tips and
comments in `scripts/build-windows-installer.ps1` and
`scripts/start-stable-win.ps1`. The state directory did not move; the
installer did.

- [x] Decide the install directory. Either move the state directory off
      `%LOCALAPPDATA%\gavin` (expensive — it is in `protocol`, three
      databases, and every existing install would need migrating), or
      give the installer a `$INSTDIR` that is not it. The second is much
      the smaller change, and `nsis.installerHooks` / an `installMode`
      override in `tauri.windows.conf.json` is where it goes.
      **Decided: the installer moves, `protocol` stays.** `installerHooks`
      only, no custom template (850 lines to own for one line's change).
      Tauri's `.onInit` picks the default and then restores a previous
      install's folder from the registry; the hooks file is `!include`d
      before `MUI_LANGUAGE`, so it can define `MUI_CUSTOMFUNCTION_GUIINIT`
      and swap `$LOCALAPPDATA\Gavin` for `$LOCALAPPDATA\Programs\Gavin`
      (the per-user Program Files, and what `start-stable-win.ps1` already
      looks in first) after both. `.onVerifyInstDir` greys Install on the
      state directory, the directory page's text says why, and the
      pre-install hook redirects a silent `/S` or `/D=` install that names
      it. An install whose registered predecessor lives in the state
      directory (this machine's) stops that daemon, deletes its four
      binaries by name — never the folder — and retargets the Start menu
      and desktop shortcuts, which the template only retargets within one
      folder and never in `/UPDATE` mode.
- [x] Make the uninstaller's "Delete app data" checkbox mean the real
      directory, or remove it. A checkbox that deletes nothing is worse
      than no checkbox.
      **Meant.** `NSIS_HOOK_POSTUNINSTALL` adds `RMDir /r` of the state
      directory when the box is ticked and the run is not `/UPDATE`. (§1
      overstates one thing: the template's two `com.gavin.app` folders do
      exist — WebView2's profile and `config.json` — what it missed was the
      databases.) A dev-tree daemon holding its `-dev` files keeps those.
- [x] Stop the daemon before install and uninstall. It answers
      `Request::Shutdown` over the transport, and `taskkill /F /IM
      gavin-daemon.exe` is the fallback the Settings restart already
      uses — an NSIS `preInstall` hook is the place.
      **Stopped, by image path, never by name** (a name reaches the dev
      daemon too). `Request::Shutdown` needs a client — token plus pipe
      name — so the hooks go straight to TerminateProcess the way
      `stop_running_daemon`'s fallback does; the daemon answers Shutdown
      with `exit` anyway. PowerShell + CIM, `Win32_Process.ExecutablePath`
      compared case-insensitively to `$INSTDIR\gavin-daemon.exe`, the path
      handed over in the environment (an apostrophe in a user name ends a
      quoted argument). Interactive runs get OK / Cancel like the
      template's own Gavin.exe prompt; `/S` and `/P` (the updater) stop it
      without asking. The template's app check is inserted ahead of the
      daemon stop so the app cannot respawn the daemon from its connection
      overlay while the prompt waits. Found on the way: a 32-bit installer
      launches the SysWOW64 PowerShell, which took 3.7 s to start and blew
      a 30 s timeout enumerating processes; the hooks disable FS
      redirection and run `$SYSDIR`'s native one (0.8 s / 1.7 s). Proven:
      `makensis` compiles the stable build's generated script with the
      hooks, zero warnings; a throwaway silent installer running the real
      macro stopped three fake `gavin-daemon.exe` (a renamed `ping.exe`) in
      12 s and left the live daemon, pid 21616, alone.
- [ ] Then run the install end to end and confirm §1's remaining items on
      [the windows port card](./feat-windows-port-on-a-windows-machine.md).
      **The human's, and it cannot be otherwise:** this agent's shell is a
      child of the installed daemon (`Gavin.exe → gavin-daemon.exe → sh.exe
      → claude.exe`), so a setup run from an agent tab kills the tab.
      Built 2026-09-22 by `scripts\build-windows-installer.ps1` from this worktree:
      `C:\Users\calfr\coding\gavin-win-installer-state-dir\target\release\bundle\nsis\Gavin_0.1.0_x64-setup.exe`
      (release build 13 m 55 s, makensis clean). The generated
      `target\release\nsis\x64\installer.nsi` there `!include`s the hooks
      by plain path at line 31 and inserts all four at the template's points.
      To run it: quit Gavin, start the setup from a plain terminal. Expect
      the daemon prompt, `%LOCALAPPDATA%\Programs\Gavin` as the default,
      the old `Gavin.exe` / `gavin-daemon.exe` / `gavin-mcp.exe` /
      `uninstall.exe` gone from `%LOCALAPPDATA%\gavin` with the databases,
      token and log untouched, and `Gavin.exe` under `Programs\Gavin`
      launching and reaching a daemon that runs from there. Then re-run
      "Set up / update" for each workspace's agents: their MCP config still
      names the old `gavin-mcp.exe` path. The stable-install card's recipe
      steps 3 and 4 (choose the folder by hand, stop the daemon by hand)
      are obsolete once this lands.

**Out of scope:** code signing; the machine-wide install path, which has
neither problem.
