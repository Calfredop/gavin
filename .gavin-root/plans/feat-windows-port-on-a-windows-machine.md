---
order: 4096
title: [feat] windows port — the half that needs a Windows machine
status: To Do
---
Everything in [feat-windows-port.md](./feat-windows-port.md) that could be done
from a mac is done: four commits on `feat/multi-os-support`
(`376cc75..a538312`), the whole macOS suite green, and `cargo check -p protocol
-p gavin-daemon -p gavin-mcp --tests --target x86_64-pc-windows-msvc` passing.
That last one is the honest limit of what was proved. **Nothing below has ever
been executed on Windows** — the port compiles, and compiling is not running.

Read that card's three decision sections first (**Shell**, **Corrections to the
assumptions**, **Window chrome**). They record why each route was chosen and
what was rejected, so none of it needs re-deriving here.

**Assumption** (overrule in one word): Windows 11 x64, or a Windows 10 new
enough to have WebView2 and ConPTY, with Git for Windows, the MSVC build tools,
Node 22, and the agent CLIs installed the way a user would install them
(`npm i -g`).

## 1. It builds, and it packages

- [ ] `cargo test --workspace -- --skip gavin::` and `cargo test -p gavin-daemon
      gavin:: -- --test-threads=1`. Expect intermittent red from
      [fix-daemon-server-test-flakiness.md](./fix-daemon-server-test-flakiness.md),
      which predates this work; a DIFFERENT test each run is that, the SAME one
      twice is ours.
- [ ] `cd app && npm ci && npm test && npm run check && npm run build`.
- [ ] `npm run tauri dev` launches and reaches its daemon.
- [ ] `npm run bundle` produces an **NSIS installer** (`tauri.windows.conf.json`
      narrows `bundle.targets` to that; `app/src-tauri/BUNDLING.md` says why the
      `--config` flag must not be dropped). The staging script is Node now
      precisely so this step does not need `sh.exe` on PATH — confirm it did not.
- [ ] **The spec's open item, now with an extension on it:** install the
      package and check `externalBin` stripped the target triple and left
      `gavin-daemon.exe` and `gavin-mcp.exe` **beside `Gavin.exe`**.
      `resolve_daemon_binary_path` and `resolve_mcp_binary_path` both join
      against `current_exe().parent()` and both now append `EXE_SUFFIX`; if the
      files are not there, the packaging approach needs rethinking, not patching.
      (The Linux card carries the same question — a Linux answer is most of a
      Windows answer.)
- [ ] Run the INSTALLED app, not a dev build, and confirm it starts its own
      daemon. That is the sibling lookup working end to end.
- [ ] Run the wizard's integration step and confirm the absolute `gavin-mcp`
      path it writes into the agent config resolves.

## 2. The shell assumption — everything rests on this one

The parent card's Shell decision is the load-bearing guess of the whole port:
emitted command lines keep their POSIX shape and run through Git for Windows'
`sh.exe` under ConPTY. If this section fails, the fallback is emitting
PowerShell, which touches every emission site and every agent launch line —
a re-plan, not a patch. Do this section before anything else.

- [ ] `git --exec-path` answers, and `crates/daemon/src/shell.rs` resolves
      `<git>/usr/bin/sh.exe` from it. A scoop or portable install too, if one is
      to hand.
- [ ] **ConPTY gives `sh.exe` a tty.** Run a card and watch a full-screen agent
      TUI draw and accept input. This is the single assumption most likely to
      be wrong, and the reason it is plausible is that Git Bash works in Windows
      Terminal.
- [ ] Each profile CLI starts under it: `claude`, `codex`, `gemini`, `cursor`,
      `opencode`. Inside `sh.exe` the extensionless npm shim is the one that
      wins, which is the whole reason this route was chosen over PowerShell.
- [ ] A `script`-kind tool (which wraps its body in `bash -c`) runs, and the
      failure epilogue prints `[gavin] <tool> exited with code N` and **re-raises
      the code** — the step's verdict depends on it.
- [ ] A `[worktree] setup` chain (`&&`-joined) runs in the new worktree.
- [ ] OSC 7: a Git Bash prompt configured to emit it reports the cwd, and the
      drive letter arrives as `C:/…` rather than `/C:/…`. If it emits nothing,
      that is fine and expected — idle detection is OSC 133 plus a quiet timer
      and must not regress either way.

## 3. The desktop pass

- [ ] Launch, and spawn a plain shell tab: it should be `%COMSPEC%`, not bash.
- [ ] **Restart the daemon from Settings.** It now asks over the wire
      (`Request::Shutdown`) before falling back to `taskkill /F /IM
      gavin-daemon.exe`. Exercise both — the fallback by wedging or downgrading
      a daemon so the polite route cannot land.
- [ ] Delete a workspace and confirm it is in the **Recycle Bin** and that
      **Restore** puts it back.
- [ ] Hover a path in terminal output and open it. This is
      `resolve_path_under_cursor`, and the first place a `\\?\` verbatim path
      would have surfaced before `protocol::canonical_path`.
- [ ] A workspace at a `C:\` path renders on the board, and its cards open from
      the Plans tab and the file viewer. Card ids are paths, compared and split
      as strings — this is what the forward-slash normalisation is for.
- [ ] A `until` rail step retries and **quotes its check** in the retry prompt.
      The log now lives under the host's own temp directory rather than `/tmp`,
      which on Windows was two different directories: the shell wrote one and
      the app read the other.
- [ ] Resize the window from all eight edges and corners
      (`WindowResizeEdges.svelte`), and note whether the OS *also* resizes
      there. The grips are drawn on Windows on the assumption WebView2 swallows
      the frame's hit-testing; if the OS border works after all, the overlay can
      be dropped on this platform.
- [ ] Drag the window by the corner strip and by the empty run of a tab row;
      double-click the title bar to maximize.
- [ ] The non-mac `WindowControls` — minimize / maximize / close, with the
      corner still top-LEFT (a decision, recorded on the parent card).

## 4. Two accounts, one machine

- [ ] A second Windows account gets its **own** daemon: the pipe name is hashed
      from `%LOCALAPPDATA%`, which differs per user.
- [ ] Neither account can open the other's pipe. The descriptor is
      `D:P(A;;GA;;;SY)(A;;GA;;;<the running user's SID>)`; `Get-Acl` on
      `\\.\pipe\gavin-*`, or simply the second account failing to connect, is
      the evidence. This is a **security** property, not a nicety — the default
      pipe descriptor grants READ to Everyone, which is why it is set explicitly.

## 5. Then

- [ ] Promote the reporting steps in the `windows` CI job to gates, one per
      thing that goes green. Only `cargo check` on the three crates is a gate
      today; the rest run with `continue-on-error: true` on purpose.
- [ ] Record what broke on this card, and carry anything structural back to
      [feat-windows-port.md](./feat-windows-port.md) rather than leaving the
      decision sections claiming something the machine disproved.

**Out of scope:** WSL-based operation (a WSL workspace is the Linux app talking
to a Linux daemon); code signing; the ARM64 Windows target.
