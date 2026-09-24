---
kind: plan
title: "[owner] the Windows desktop pass — nine rendered checks in the running app"
status: In Progress
labels: windows
priority: high
complexity: moderate
---
Split out of [feat-windows-port-on-a-windows-machine](./done/feat-windows-port-on-a-windows-machine.md)
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

~~One thing to do first: re-run "Set up / update" for each workspace's
agents.~~ **Done — nothing to do first any more.** `.mcp.json` names
`scripts/gavin-mcp` now, not the `%LOCALAPPDATA%\gavin\gavin-mcp.exe` the
installer move deleted; both halves of the shim (`scripts/gavin-mcp` and
`scripts/gavin-mcp.cmd`) are on disk, the old absolute path appears nowhere
in the tree, and the `gavin_*` tools answer. `fix-mcp-json-points-at-the-windows-gavin-mcp-on-the-mac`
is archived and [fix-windows-installer-collides-with-the-daemon](./done/fix-windows-installer-collides-with-the-daemon.md)
is Done.

**None of these is ticked, and an agent should not tick them.** Rendered
UI is the one thing the suites cannot cover and confirming it is the
owner's, in the running app (CLAUDE.md). What is below each item is the
static pre-flight for it: the exact code path the item exercises, checked
against the committed source, so that when the human does run it a
failure is a surprise rather than a re-derivation.

**Pre-flights re-checked against the working tree on 2026-09-24**, every
line reference below re-resolved rather than carried over. Eight of the
nine hold exactly as written. **Item 4 does not, and will fail** — the
reason is under it, and the fix is
[fix-terminal-path-links-never-match-a-windows-path](./fix-terminal-path-links-never-match-a-windows-path.md).
Items 5, 8 and 9 had no pre-flight and now have one.

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
      *Pre-flight (holds, 2026-09-24):* `shell::interactive_shell`
      (`crates/daemon/src/shell.rs:46`) reads `%COMSPEC%`, rejects an empty
      value, and falls back to a bare `cmd.exe`;
      `shell::tests::on_windows_a_plain_tab_gets_a_comspec_that_is_really_there`
      (`shell.rs:585`) asserts the resolved value `is_file()`, so the
      fallback being reached is a test failure rather than a surprise in a
      tab. A plain tab gets no PATH augmentation — confirmed at the source:
      `pty.rs:146` is `None => CommandBuilder::new(interactive_shell())`
      with no `cmd.env("PATH", …)` on that arm, while the `Some(command)`
      arm above it calls `path_with_posix_tools`. That is deliberate, and
      `path_with_posix_tools`'s own doc comment says why: "`interactive_shell`
      is a Windows shell a human typed into and keeps the PATH Windows gave
      it."
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
      *Pre-flight (holds, 2026-09-24):* all four line numbers still land on
      what the item names. `stop_running_daemon` returns `Ok(())` untouched
      when `Stream::connect` fails, reads `server_pid` BEFORE sending (a
      daemon that obeys is gone by the time the reply is handled), and only
      then falls through to `kill_daemon_process(pid)`. The property this
      item exists to confirm now has a test of its own:
      `stopping_one_endpoint_leaves_a_daemon_on_another_alone`
      (`daemon.rs:475`). One consequence worth knowing before you start:
      `cargo test -p app` is safe to run beside live sessions now. The
      `memory-app-tests-kill-the-daemon` card, which warned that it killed
      every daemon by name, was describing the code this rewrite replaced
      and has been corrected.
- [ ] Delete a workspace and confirm it is in the **Recycle Bin** and that
      **Restore** puts it back.
      *Pre-flight (holds, 2026-09-24):* the Linux half of this had an
      end-to-end test (`trash::tests`, gated `target_os = "linux"`) asserting
      the file reaches the desktop Trash WITH the `.trashinfo` that makes
      "Put back" work; Windows had none. Added
      `trash::windows_tests::a_trashed_file_lands_in_the_recycle_bin_with_its_restore_record`
      (`app/src-tauri/src/trash.rs:136`), the exact counterpart: it trashes a
      file and finds the `$Recycle.Bin\<SID>\$I…` record that holds the
      original path plus the `$R…` data beside it, then removes both so a
      developer's bin is left as it was found. An `$R` with no `$I` is the
      failure worth catching — it looks identical in the shell and cannot be
      restored. It searches the records by CONTENT (the original path, as
      UTF-16LE bytes) because the filed name is a generated id, and it
      returns early rather than failing when the volume has no bin at all.
      What the human still owns: that the WIZARD reaches this, and that
      Restore in the shell puts a whole workspace back.
- [ ] Hover a path in terminal output and open it. This is
      `resolve_path_under_cursor`, and the first place a `\\?\` verbatim path
      would have surfaced before `protocol::canonical_path`.
      *Pre-flight (**FAILS** — measured 2026-09-24):* the Rust half is
      sound and is not what breaks. `protocol::canonical_path`
      (`crates/protocol/src/lib.rs:2951`) canonicalises and hands the result
      to `strip_verbatim_prefix`, which turns `\\?\C:\x` into `C:/x` and
      `\\?\UNC\server\share` into `//server/share` while deliberately
      leaving `\\?\Volume{…}` alone; all three arms are unit-tested at
      `lib.rs:5168-5178`. `resolve_path_under_cursor_impl`
      (`app/src-tauri/src/fileviewer.rs:284`) takes the candidate string
      whole, so a space in it costs nothing.
      **What breaks is the tokenizer that decides what text to hand it.**
      `PATH_CANDIDATE` (`app/src/lib/terminal/terminalRegistry.ts:93`) is
      `/(~\/|\.{0,2}\/)[^\s'"()[\]{}:,]+/g`: every alternative requires a
      forward slash and `:` is excluded from the run. Run against the
      committed regex, a `C:\Users\Ada\repo\file.txt` and a
      `\\server\share\file.txt` produce **no match at all** — so the
      underline never appears for the way `cmd.exe`, PowerShell and MSVC
      spell a path. A forward-slashed `C:/Users/Ada/repo/file.txt` matches
      only from the slash, yielding `/Users/Ada/repo/file.txt` with the
      drive letter gone, which then resolves against whatever the current
      drive is — right by luck on a C:-only machine. A space truncates
      (`C:/Users/Ada/My Documents/x.txt` → `/Users/Ada/My`), and a `dir`
      timestamp `09/24/2026` matches as a false positive.
      So the item's old closing line — "worth hovering a path with a SPACE
      in it and one on a UNC share, which is where the two arms differ" —
      was aimed at `strip_verbatim_prefix`'s two arms, and neither a space
      nor a UNC path ever reaches them. Fix filed as
      [fix-terminal-path-links-never-match-a-windows-path](./fix-terminal-path-links-never-match-a-windows-path.md).
      **Run this item after that card lands**, or run it now only to
      confirm the failure.
- [ ] A workspace at a `C:\` path renders on the board, and its cards open from
      the Plans tab and the file viewer. Card ids are paths, compared and split
      as strings — this is what the forward-slash normalisation is for.
      *Pre-flight (holds, 2026-09-24):* the invariant is single-sourced and
      the frontend depends on it totally. `scan_root`
      (`crates/daemon/src/gavin.rs:1587`) forward-slashes the root before
      anything else — "every path this scan produces is a card id the app
      splits on `/`, compares and joins" — and each card's `path` and
      `rel_path` go through `protocol::wire_path` individually
      (`gavin.rs:1517-1518`), which on Windows is `path.replace('\\', "/")`.
      The frontend has no backslash handling anywhere to fall back on: a
      dozen call sites split card ids on the literal `"/"` alone
      (`cardDelete.ts:127,153`, `cardCompletion.ts:193`, `cardTabLink.ts:68`,
      `changeAttribution.ts:215`, `runHistory.ts:152`, `attachments.ts:95`,
      `memoryCard.ts:106`, `runChangesState.ts:71`). So a single card id that
      escapes `wire_path` does not render wrong — it breaks open, delete and
      title for that card only, which is what makes the Plans-tab and
      file-viewer halves of this item worth doing separately rather than
      trusting one card that opens. The containment side is normalised the
      same way and for a recorded reason: `gavin.rs:1339` uses
      `protocol::canonical_path` rather than `Path::canonicalize` because a
      raw `Prefix::VerbatimDisk` can never `starts_with` a stored
      `Prefix::Disk`, which had refused every context creation inside a
      watched workspace on Windows.
- [ ] A `until` rail step retries and **quotes its check** in the retry prompt.
      The log now lives under the host's own temp directory rather than `/tmp`,
      which on Windows was two different directories: the shell wrote one and
      the app read the other.
      *Pre-flight (holds, 2026-09-24):* the wiring is whole, end to end.
      `fileviewer::temp_dir` (`app/src-tauri/src/fileviewer.rs:315`) answers
      `protocol::wire_path(std::env::temp_dir())` — forward-slash normalised
      — `layoutState.ts:1189-1191` pushes it into
      `orchestrationLoop::setTempRoot` at bootstrap, and `untilLogPathIn`
      (`orchestrationLoop.ts:129`) strips any trailing separator and joins
      with `/`. Both ends call the same `untilLogPath(stepId)`: the writer
      through `buildUntilScript` → `… | tee <quoted path>`
      (`orchestrationState.ts:1339`), the reader through
      `readFileForViewer` (`orchestrationState.ts:988`). The `/tmp` default
      is only what the module holds before the host answers. MSYS opens a
      `C:/…` path natively, so `tee` needs no translation. The one gap the
      source shows: the `tempDir()` invoke is deliberately not awaited, so a
      rail step launched in the first few milliseconds of a cold start would
      write under `/tmp` — the comment argues the first loop step is many
      seconds away, and it is, but that is the shape of it if this ever does
      misbehave once and never again.
- [ ] Resize the window from all eight edges and corners
      (`WindowResizeEdges.svelte`), and note whether the OS *also* resizes
      there. The grips are drawn on Windows on the assumption WebView2 swallows
      the frame's hit-testing; if the OS border works after all, the overlay can
      be dropped on this platform.
      *Pre-flight (holds, 2026-09-24):* the branch is
      `needsResizeGrips(isMacSync())` (`WindowResizeEdges.svelte:12`), which
      is `!macOS` (`windowResize.ts:94`) — one call, evaluated on the first
      frame from plugin-os's synchronous platform read, so the grips are up
      before any await. `isMacSync` resolves to `null` rather than refusing
      when the platform cannot be told, which on this branch means grips are
      drawn, the safe direction. All eight zones are really there
      (`resizeZones`, `windowResize.ts:63-72`): four edges at `GRIP` px and
      four corners at `CORNER` px, each with its own cursor. `decorations:
      false` and `shadow: true` are both present and adjacent in
      tauri.conf.json (lines 20-21), which is the pair that leaves an
      undecorated Windows 11 window its 1px border and rounded corners. The
      question this item exists to answer — whether the OS border responds
      too — cannot be read off the source at all; it needs the window. The
      source states the assumption to be tested outright: tao keeps
      `WS_THICKFRAME` and answers `WM_NCHITTEST` inside the client area, but
      the WebView2 child window is believed to take the mouse first.
- [ ] Drag the window by the corner strip and by the empty run of a tab row;
      double-click the title bar to maximize.
      *Pre-flight (holds, 2026-09-24):* not `data-tauri-drag-region` —
      `TitleBar.svelte:53` says so in a comment and the whole app has no
      such attribute. The gesture is `use:windowDrag` (`windowDrag.ts:36`)
      calling `getCurrentWindow().startDragging()`, mounted on seven
      surfaces: the strip over the sidebar (`TitleBar.svelte:58`), the empty
      run of a pane's tab row (`Pane.svelte:664`) and the hub's
      (`+page.svelte:372,555`), and two sidebar list spacers
      (`Sidebar.svelte:1411,1682`). None of them is mac-gated. Double-click
      is handled by the app, not the OS: the tracker suppresses the second
      mousedown's drag (a native drag swallows the mouseup) and acts on the
      mouseup if the cursor stayed put. On Windows
      `title_bar_double_click_action` returns `None` — the NSUserDefaults
      read is `#[cfg(target_os = "macos")]` only (`mac_window.rs:60-69`) —
      and `doubleClickAction(null)` falls to its `default:` arm,
      `toggleMaximize` (`titleBarGesture.ts:19-28`). So maximize is the
      expected answer here, and getting nothing is a real failure rather
      than an unset preference. Worth also trying right- and middle-click
      on those strips: the handler is left-button only by design and must
      not hijack them.
- [ ] The non-mac `WindowControls` — minimize / maximize / close, with the
      corner still top-LEFT (a decision, recorded on the parent card).
      *Pre-flight (holds, 2026-09-24):* the `{:else}` branch of
      `WindowControls.svelte:83` draws the three, and its comment carries
      the decision: "Close first, minimize last: the reverse of what Windows
      draws on the right-hand end of a title bar, because this corner is not
      there." So the order on screen is **close, maximize, minimize**,
      left to right — reading it as backwards is the expected first
      reaction and is not the bug. `+page.svelte:339-340` applies
      `wide-window-controls` on non-mac and withholds `rounded-corners`, so
      the strip is sized for this branch. Two things only the window can
      answer: that the middle button's icon really swaps `Maximize2` →
      `Minimize2` and its label "Maximize" → "Restore" when the window is
      maximized (it is driven by a live `onResized`-style listener whose
      subscribe is wrapped in try/catch and fails silently outside a Tauri
      window), and that Close runs the `CloseRequested` ladder in
      `+page.svelte` rather than killing the window — it calls `close()`,
      not `destroy()`, specifically so that prompt still appears.
