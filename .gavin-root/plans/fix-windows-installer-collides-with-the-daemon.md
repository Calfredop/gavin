---
title: [fix] The Windows installer installs into the daemon's state directory, and never stops the daemon
status: To Do
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

- [ ] Decide the install directory. Either move the state directory off
      `%LOCALAPPDATA%\gavin` (expensive — it is in `protocol`, three
      databases, and every existing install would need migrating), or
      give the installer a `$INSTDIR` that is not it. The second is much
      the smaller change, and `nsis.installerHooks` / an `installMode`
      override in `tauri.windows.conf.json` is where it goes.
- [ ] Make the uninstaller's "Delete app data" checkbox mean the real
      directory, or remove it. A checkbox that deletes nothing is worse
      than no checkbox.
- [ ] Stop the daemon before install and uninstall. It answers
      `Request::Shutdown` over the transport, and `taskkill /F /IM
      gavin-daemon.exe` is the fallback the Settings restart already
      uses — an NSIS `preInstall` hook is the place.
- [ ] Then run the install end to end and confirm §1's remaining items on
      [the windows port card](./feat-windows-port-on-a-windows-machine.md).

**Out of scope:** code signing; the machine-wide install path, which has
neither problem.
