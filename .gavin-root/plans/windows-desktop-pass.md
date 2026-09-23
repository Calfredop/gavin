---
kind: plan
title: "[owner] the Windows desktop pass — nine rendered checks in the running app"
status: To Do
labels: windows
priority: high
complexity: moderate
---
Split out of [feat-windows-port-on-a-windows-machine](./feat-windows-port-on-a-windows-machine.md)
on 2026-09-22, when a board audit confirmed item by item that every one of
these nine needs the owner in front of the running app and none of them has
agent-executable work left. The umbrella card kept §1, §2, §4 and §5; this
card is §3, moved verbatim with its static pre-flights intact.

**Do these on the installed build, and it is already the right one.** The
install at `%LOCALAPPDATA%\Programs\Gavin` was made at 22:59–23:02 on
2026-09-22, after the `win/installer-state-dir` merge (`2bcde943`, 21:59) and
after `95871081` (22:48), so it carries every merged Windows fix. The
umbrella card's old "rebuild and reinstall before doing them" warning is
satisfied and does not apply here.

One thing to do first, because it is broken right now: **re-run "Set up /
update" for each workspace's agents.** The repo's `.mcp.json` still names
`%LOCALAPPDATA%\gavin\gavin-mcp.exe`, which the installer move deleted, so
every agent session in this repo currently starts with a dead `gavin` MCP
server. That is [fix-mcp-json-points-at-the-windows-gavin-mcp-on-the-mac](./fix-mcp-json-points-at-the-windows-gavin-mcp-on-the-mac.md)
and the last item of [fix-windows-installer-collides-with-the-daemon](./fix-windows-installer-collides-with-the-daemon.md).


**None of these is ticked, and an agent should not tick them.** Rendered
UI is the one thing the suites cannot cover and confirming it is the
owner's, in the running app (CLAUDE.md). What is below each item is the
static pre-flight for it: the exact code path the item exercises, checked
against the committed source, so that when the human does run it a
failure is a surprise rather than a re-derivation. Two of them turned up
something worth knowing before the app is ever launched.

**The item-2 text below is out of date and the code is better than it
says.** The restart's fallback is no longer `taskkill /F /IM
gavin-daemon.exe` — no `taskkill` shells out anywhere in the app; it
survives only in `daemon.rs`'s comments. `stop_running_daemon` reads the
pid serving THIS endpoint off the connection (`Stream::server_pid`),
sends `Request::Shutdown`, and on failure calls `TerminateProcess` on
that one pid. The comment says why: a name is not an address, and
`taskkill /IM` reached every daemon on the machine — which is how `cargo
test -p app` once killed a human's sessions and how the dev app's Restart
took the stable app's daemon with it. So the second half of that item —
"the fallback by wedging or downgrading a daemon" — is still worth doing,
but it exercises `TerminateProcess` on one pid, and the thing to watch
for is that the OTHER daemon on this machine is untouched.

- [ ] Launch, and spawn a plain shell tab: it should be `%COMSPEC%`, not bash.
      *Pre-flight:* `shell::interactive_shell` reads `%COMSPEC%` and falls
      back to a bare `cmd.exe`; `shell::tests::on_windows_a_plain_tab_gets_a_comspec_that_is_really_there`
      now asserts the resolved value is an existing file, so the fallback
      being reached is a test failure rather than a surprise in a tab. A
      plain tab gets no PATH augmentation — that is deliberate, and §2's
      finding explains why it must not.
- [ ] **Restart the daemon from Settings.** It asks over the wire
      (`Request::Shutdown`) and, on failure, calls `TerminateProcess` on the
      **one pid serving this endpoint**, read off the connection with
      `Stream::server_pid` (`app/src-tauri/src/daemon.rs:253,260,342,359`).
      Exercise both — the fallback by wedging or downgrading a daemon so the
      polite route cannot land, and watch that the OTHER daemon on this
      machine survives it.
      *Corrected 2026-09-22:* this item used to say the fallback was
      `taskkill /F /IM gavin-daemon.exe`. It is not, and has not been for a
      while — no `taskkill` shells out anywhere in the app; it survives only
      in `daemon.rs`'s comments. The prose above this list already said so;
      the item itself had not been updated. A name is not an address, and
      `taskkill /IM` reached every daemon on the machine, which is exactly
      the thing to confirm no longer happens.
- [ ] Delete a workspace and confirm it is in the **Recycle Bin** and that
      **Restore** puts it back.
      *Pre-flight:* the Linux half of this had an end-to-end test
      (`trash::tests`, gated `target_os = "linux"`) asserting the file
      reaches the desktop Trash WITH the `.trashinfo` that makes "Put
      back" work; Windows had none. Added
      `trash::windows_tests::a_trashed_file_lands_in_the_recycle_bin_with_its_restore_record`,
      the exact counterpart: it trashes a file and finds the
      `$Recycle.Bin\<SID>\$I…` record that holds the original path plus
      the `$R…` data beside it, then removes both so a developer's bin is
      left as it was found. An `$R` with no `$I` is the failure worth
      catching — it looks identical in the shell and cannot be restored.
      What the human still owns: that the WIZARD reaches this, and that
      Restore in the shell puts a whole workspace back.
- [ ] Hover a path in terminal output and open it. This is
      `resolve_path_under_cursor`, and the first place a `\\?\` verbatim path
      would have surfaced before `protocol::canonical_path`.
      *Pre-flight:* `protocol::canonical_path` canonicalises and then
      hands the result to `strip_verbatim_prefix`, which turns
      `\\?\C:\x` into `C:/x` and `\\?\UNC\server\share` into
      `//server/share`, while deliberately leaving `\\?\Volume{…}` alone
      (a volume with no drive letter, where stripping would name
      something else). Both are unit-tested. Worth hovering a path with a
      SPACE in it and one on a UNC share, which is where the two arms
      differ.
- [ ] A workspace at a `C:\` path renders on the board, and its cards open from
      the Plans tab and the file viewer. Card ids are paths, compared and split
      as strings — this is what the forward-slash normalisation is for.
- [ ] A `until` rail step retries and **quotes its check** in the retry prompt.
      The log now lives under the host's own temp directory rather than `/tmp`,
      which on Windows was two different directories: the shell wrote one and
      the app read the other.
      *Pre-flight:* the wiring is whole. `fileviewer::temp_dir` answers
      `protocol::wire_path(std::env::temp_dir())` — forward-slash
      normalised — `layoutState` pushes it into
      `orchestrationLoop::setTempRoot` at bootstrap, and `untilLogPath`
      builds on it, so the `tee 'C:/Users/…/Temp/gavin-until-<id>.log'`
      the shell writes and the path the app reads are one string. The
      `/tmp` default is only what the module holds before the host
      answers. MSYS opens a `C:/…` path natively, so `tee` needs no
      translation.
- [ ] Resize the window from all eight edges and corners
      (`WindowResizeEdges.svelte`), and note whether the OS *also* resizes
      there. The grips are drawn on Windows on the assumption WebView2 swallows
      the frame's hit-testing; if the OS border works after all, the overlay can
      be dropped on this platform.
      *Pre-flight:* the branch is `needsResizeGrips(isMacSync())` — one
      call, evaluated on the first frame from plugin-os's synchronous
      platform read, so the grips are up before any await. `decorations:
      false` and `shadow: true` are both present and adjacent in
      tauri.conf.json, which is the pair that leaves an undecorated
      Windows 11 window its 1px border and rounded corners. The question
      this item exists to answer — whether the OS border responds too —
      cannot be read off the source at all; it needs the window.
- [ ] Drag the window by the corner strip and by the empty run of a tab row;
      double-click the title bar to maximize.
- [ ] The non-mac `WindowControls` — minimize / maximize / close, with the
      corner still top-LEFT (a decision, recorded on the parent card).
