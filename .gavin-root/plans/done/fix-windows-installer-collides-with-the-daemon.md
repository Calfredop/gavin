---
order: 8192
title: [fix] The Windows installer installs into the daemon's state directory, and never stops the daemon
labels: windows
status: Done
priority: high
complexity: moderate
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
- [x] Then run the install end to end and confirm §1's remaining items on
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

      **The install ran, and every expectation above was met** (observed
      2026-09-22 by a board audit, from the machine state rather than from
      a report):

      - registry `InstallLocation` under HKCU Uninstall\Gavin is
        `C:\Users\calfr\AppData\Local\Programs\Gavin`;
      - that folder holds `Gavin.exe`, `gavin-daemon.exe`, `gavin-mcp.exe`,
        `uninstall.exe`, built 22:59–23:02, installed 23:43;
      - `%LOCALAPPDATA%\gavin` holds **zero `.exe` files** and still has
        `kanban.sqlite`, `orchestration.sqlite`, `registry.sqlite`,
        `daemon.token` and `daemon.log` intact — the whole point of the fix;
      - `Gavin.exe` and `gavin-daemon.exe` are both running **from
        `Programs\Gavin`**;
      - the Start menu and Desktop `Gavin.lnk` both retarget to
        `Programs\Gavin\Gavin.exe` — the hooks' most fragile behaviour, and
        the one the stock template never does in `/UPDATE` mode.

      **One thing is still owed, and it is breaking every agent session in
      this repo right now.** "Re-run Set up / update for each workspace's
      agents" has not been done: `.mcp.json` still reads
      `C:\Users\calfr\AppData\Local\gavin\gavin-mcp.exe`, a file the move
      deleted, so the `gavin` MCP server fails to connect at every session
      start and `gavin_*` tools are unavailable. This item also now carries
      **§1's wizard line from
      [the windows port card](./feat-windows-port-on-a-windows-machine.md)**,
      merged here on 2026-09-22 because it is the same button press:
      confirming the absolute `gavin-mcp` path the wizard writes resolves
      is what re-running the integration step does. Doing it ticks this box
      and closes that card's last section.

      Note the shape problem it exposes, which outlives the button press:
      `.mcp.json` is committed and carries one absolute path, so it cannot
      be right on this machine and the Mac at once. That is
      [fix-mcp-json-points-at-the-windows-gavin-mcp-on-the-mac](../archive/fix-mcp-json-points-at-the-windows-gavin-mcp-on-the-mac.md),
      and it is a code change, not a button press.

      **2026-09-23, from the machine: the install half is confirmed a
      second time, and the button press is now the WRONG action for this
      checkout.** Re-verified independently (registry, files, live pids,
      shortcut targets — not from the paragraph above): `InstallLocation`
      is `C:\Users\calfr\AppData\Local\Programs\Gavin`, that folder holds
      the four binaries, `%LOCALAPPDATA%\gavin` holds **zero `.exe`** with
      `kanban.sqlite` / `orchestration.sqlite` / `registry.sqlite` /
      `daemon.token` / `daemon.log` intact, `Gavin.exe` (pid 4736) and
      `gavin-daemon.exe` (pid 16268) both run from `Programs\Gavin`, and
      the Start-menu and Desktop `Gavin.lnk` both point there. Also
      confirmed: `GAVIN_SESSION_SOCKET` in an agent shell is still
      `%LOCALAPPDATA%\gavin\daemon.sock` — the state directory did not
      move, which is the fix's whole claim. (Cosmetic leak, no consumer in
      the tree: the hooks' `GAVIN_DAEMON_EXE_PATH` — set with
      `SetEnvironmentVariable` so the stop macro's PowerShell can read it —
      is inherited by the `Gavin.exe` the installer runs at the end and so
      by every session under it, naming the *predecessor's*
      `%LOCALAPPDATA%\gavin\gavin-daemon.exe`. Nothing but `hooks.nsh`
      reads that name; it is gone at the next normal launch.)

      **Why the press is wrong here.**
      [fix-mcp-json-points-at-the-windows-gavin-mcp-on-the-mac](../archive/fix-mcp-json-points-at-the-windows-gavin-mcp-on-the-mac.md)
      was landed on `fix/agent-fixes` (`43bafd9f`, `fed453d5`) and says so
      in as many words: the committed configs now name `scripts/gavin-mcp`
      by relative path, and "no wizard re-run is needed, and none should be
      done, since that is the flip-flop this card removes". A press here
      would write this machine's absolute path back over the launcher and
      re-break the Mac. Probed today from the branch worktree, spawned the
      way a client spawns it: `scripts\gavin-mcp.cmd` resolves
      `%LOCALAPPDATA%\Programs\Gavin\gavin-mcp.exe` (candidate 2 — `GAVIN_MCP`
      is unset), answers `initialize` as `gavin-mcp 0.1.0` and `tools/list`
      with all sixteen tools, and puts nothing but JSON-RPC on stdout.

      **So this box waits on a merge, not a button — and the merge is
      now resolved and waiting.** `fix/agent-fixes` did not merge: it
      forked at `902938f5` and `fd5945a9` (the ssh merge) has since
      rewritten the same `write_mcp_config_*` / `json_entry` region to take
      `fs: &dyn WorkspaceFiles`, so `git merge-tree` conflicted in 4 hunks
      of `app/src-tauri/src/agent_setup.rs`. Resolved 2026-09-23 on
      **`fix/agent-fixes-merged`** (`c51990b9`, worktree `C:\Users\calfr\gvm`),
      which takes both sides — the trait threading from main, the resolved
      command from the branch — and drops the branch's own `create_dir_all`,
      since `LocalFiles::write_bytes` already makes the parent and doing it
      in the writer would create a `.cursor\` on the DESKTOP for a workspace
      whose files are on a host.

      The decision neither side could make alone — what an ssh workspace
      does with a relative launcher — went this way: `mcp_command` asks two
      questions about the root (*is this a gavin checkout, does it carry the
      launcher*), and for an ssh workspace the root is a path on the HOST,
      so asking this process's disk lets whatever sits at the same spelling
      here decide what gavin's own MCP entry executes. Both questions now go
      through `fs`, and the platform half with them: `launcher_file` picks
      `.cmd` or the sh script by the platform that will RUN the command, so
      `WorkspaceFiles` grew `is_windows` — `cfg!` for `LocalFiles`, the
      banner's `host_os` for `RemoteFiles`. A remote gavin checkout that
      ships the launcher gets it; every root that ships none keeps the
      absolute binary, which for ssh is the banner's `mcp_path`.

      `cargo test -p app` **534 passed / 0 failed** on the merge, the
      branch's seven launcher tests among them. One test added for the new
      gate and **confirmed to go red with either half reverted**. Nothing
      under `app/src` is touched, so the JS suites are main's. Probed on
      this machine from the merged tree: `scripts\gavin-mcp.cmd` resolves
      the installed binary and answers `initialize`. `git merge
      fix/agent-fixes-merged` from `main` is a **fast-forward** as of
      `a3781101`.

      **And `.mcp.json` is not the only one. jarvis is a second instance
      the launcher does not cover.** `C:\Users\calfr\coding\jarvis` is the
      other registered workspace (`config.json`; both are `profile =
      "claude-code"`, so both write `.mcp.json`). Its committed config names
      `C:\Users\calfr\coding\gavin\target\debug\gavin-mcp.exe` — a file that
      does exist, built 2026-09-10, which is worse than a missing one: it
      connects and then fails every call. Driven directly today,
      `gavin_get_board` from that root returns *"the gavin daemon is newer
      than this gavin-mcp (v41 vs v36)"*. The launcher is written only into
      a root that already ships one (the branch's own decision — "every
      other workspace still gets the absolute binary"), and jarvis ships
      none, so **jarvis is the one workspace where "Set up / update" is
      still the right action**, and it will write
      `%LOCALAPPDATA%\Programs\Gavin\gavin-mcp.exe`, which resolves.

      Two actions were left. **The first is done; the second is the only
      thing this box still waits on.**

      1. **gavin — merged 2026-09-23.** `git merge --ff-only
         fix/agent-fixes-merged` on `main`: `a3781101..c51990b9`, a clean
         fast-forward, six files, none of them dirty in the shared tree
         beforehand (checked before merging — a ff that has to touch a
         dirty file is the one way this could have gone wrong). The suite
         was not re-run: the merge is a fast-forward, so `c51990b9` already
         *is* the post-merge state the card recorded `cargo test -p app`
         534/0 against. Verified from `main` afterwards, from the machine
         rather than from the branch's claim:
         - `.mcp.json` and `.cursor/mcp.json` name `scripts/gavin-mcp`, and
           all four files are `w/lf` on disk (`git ls-files --eol`), so the
           launcher cmd's single-line discipline survived the checkout;
         - spawned the way a client spawns it (`cmd /d /s /c
           scripts\gavin-mcp` from the root), it answers `initialize` as
           `gavin-mcp 0.1.0`, lists all sixteen tools, and puts **two
           lines on stdout, both JSON** — nothing but JSON-RPC, which is
           the launcher's own stated failure mode;
         - `gavin_get_board` through it returns the board, so it reaches
           the daemon and clears the version gate — not just connects;
         - `claude mcp list` reports `gavin: scripts/gavin-mcp - ✔
           Connected`, so the harness resolves the relative command through
           PATHEXT as the branch intended.
         `C:\Users\calfr\gvm` removed (`git worktree remove --force`, as
         predicted — cargo had built in it). "Set up / update" was **not**
         pressed here, deliberately: it would write this machine's absolute
         path back over the launcher.
      2. **jarvis — still owed, and still the owner's.** Re-verified today
         from the machine: `C:\Users\calfr\coding\jarvis\.mcp.json` still
         names `C:\Users\calfr\coding\gavin\target\debug\gavin-mcp.exe`
         (present, built 2026-09-10), the root ships no `scripts/gavin-mcp`
         and has no `.cursor/mcp.json`, and driving that binary from the
         jarvis root reproduces the exact failure — `initialize` succeeds,
         then `gavin_get_board` returns *"the gavin daemon is newer than
         this gavin-mcp (v41 vs v36)"*. Connects, then fails every call.

         The press is safe from either build, which the merge does not
         change: `mcp_command` writes the launcher only for a root that
         holds `crates/gavin-mcp/Cargo.toml` **and** the launcher file, and
         jarvis holds neither, so it takes the `binary` branch —
         `resolve_mcp_binary_path`, i.e. `current_exe().parent()` +
         `gavin-mcp.exe` = `%LOCALAPPDATA%\Programs\Gavin\gavin-mcp.exe`,
         the binary proven above to answer and clear the gate.

         An agent cannot discharge this one and should not fake it. Writing
         that path into jarvis's `.mcp.json` by hand would fix jarvis and
         still leave the box false, because what this item merged in from
         §1 of the windows port card is *the wizard writing a path that
         resolves* — evidence only the button press produces.

      **2026-09-24, re-verified from the machine: still owed, unchanged,
      and the press's outcome is now proven in advance.** Nothing has moved
      but the app binary — `Gavin.exe` and `uninstall.exe` are stamped
      2026-09-24 00:24, while the two sidecars keep their 2026-09-22 22:59
      build stamps, which is cargo declining to rebuild an unchanged crate,
      not a half-applied install. Registry `InstallLocation` is still
      `C:\Users\calfr\AppData\Local\Programs\Gavin`, that folder holds the
      four binaries, `%LOCALAPPDATA%\gavin` holds **zero `.exe`** beside the
      five state files, and `Gavin.exe` (pid 3012) and `gavin-daemon.exe`
      (pid 8260) both run from `Programs\Gavin`. On the gavin side
      `.mcp.json` and `.cursor/mcp.json` still name `scripts/gavin-mcp` and
      all four files are `w/lf` on disk. And
      `C:\Users\calfr\coding\jarvis\.mcp.json` still names
      `C:\Users\calfr\coding\gavin\target\debug\gavin-mcp.exe`: driven from
      the jarvis root today it reproduces the failure exactly — `initialize`
      answers `gavin-mcp 0.1.0`, then `gavin_get_board` returns *"the gavin
      daemon is newer than this gavin-mcp (v41 vs v36)"*.

      What is new is that the press's result no longer has to be taken on
      faith. Driven from the jarvis root the same way, the installed
      `%LOCALAPPDATA%\Programs\Gavin\gavin-mcp.exe` — the exact path
      `mcp_command`'s `binary` branch will write, since jarvis holds neither
      `crates/gavin-mcp/Cargo.toml` nor a launcher file (re-read on `main`
      at `agent_setup.rs:1442`) — answers `initialize` and returns the
      **board** from `gavin_get_board`, clearing the version gate rather
      than merely connecting. jarvis's `.mcp.json` and `CLAUDE.md` are both
      clean in git, so the press lands as a diff a reader can check. Also
      re-confirmed why no agent can discharge this: agent setup is six
      `#[tauri::command]`s in `app/src-tauri/src/agent_setup.rs` with no
      daemon request behind them, so the app's own UI is the only caller.

      Where the button is: the **Settings** tab with **jarvis** selected,
      the "Agent integration" banner — "Set up / update". It must be
      jarvis's own settings; the same button under gavin would write this
      machine's absolute path back over the launcher and re-break the Mac.

      **Pressed 2026-09-24 11:17, and the box is ticked on the machine
      state rather than on the report.** `C:\Users\calfr\coding\jarvis\.mcp.json`
      now names `C:\Users\calfr\AppData\Local\Programs\Gavin\gavin-mcp.exe`
      — the wizard's own `binary` branch, resolved from the running
      `Gavin.exe`, which is exactly the evidence §1 of the windows port
      card asked for: the absolute `gavin-mcp` path the wizard writes
      resolves. Driven from the jarvis root the way a client spawns it,
      that command answers `initialize` as `gavin-mcp 0.1.0` and returns
      the **board** from `gavin_get_board`, so it clears the version gate
      instead of connecting and then failing every call — the v41-vs-v36
      failure reproduced from that same root an hour earlier is gone.

      The press's whole footprint in jarvis, by mtime: `.mcp.json`, and one
      trailing newline on `claude.md` (its `gavin:start`/`gavin:end` block
      was already correct). The `.replaced` skill files and the other dirty
      plans in that tree predate it and belong to other sessions. The
      flip-flop this card warned about did **not** happen: gavin's own
      `.mcp.json` and `.cursor/mcp.json` still name `scripts/gavin-mcp` and
      are clean in git, and the launcher files are untouched.

      One small correction to the prediction above, immaterial and recorded
      only so the next reader is not surprised: `GAVIN_DAEMON_EXE_PATH` is
      **not** "gone at the next normal launch" — it is still set in an agent
      shell today. It now reads
      `C:\Users\calfr\AppData\Local\Programs\Gavin\gavin-daemon.exe`, the
      current install rather than a predecessor, because the sessions still
      descend from an installer-launched `Gavin.exe`. Still nothing in the
      tree reads it, and it now names the right file.

**Out of scope:** code signing; the machine-wide install path, which has
neither problem.
