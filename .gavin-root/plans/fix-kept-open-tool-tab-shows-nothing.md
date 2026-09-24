---
order: 28672
kind: task
title: [fix] A kept-open shell tool tab can show nothing
labels: bug
status: To Do
---
A command or script tool step on a rail finished, and its tab stayed open,
as cd708524 intended, but it was EMPTY. Seen on tempo-game's skeleton rail,
2026-09-25: "Sync from main and install" ran `git merge --ff-only main`,
printed "Already up to date" and exited 0 in under a second, and its tab on
the rail's page showed no text at all. Keeping the tab open exists so the
human can read the run, so an empty tab defeats the point of cd708524.

## What the code says (read, not yet reproduced)

- Only the ACTIVE page's layout renders (`TerminalView.svelte` draws
  `<LayoutTree node={activeTree}>`). A pane on any other page is not mounted.
- A session's xterm and its `pty-output` listener are both created the first
  time a `TerminalPane` mounts for it (`getOrCreateTerminal`,
  `terminalRegistry.ts`). Until then, output the host emits for that session
  goes to no listener and is dropped.
- For a LIVE session that gap is covered: on first mount, `restoreScreen`
  asks the daemon for its screen model (`snapshotSession`).
- For an EXITED session nothing covers it. The daemon's pump drops the
  session's screen and forgets its record the moment it exits
  (`server.rs`, end of `spawn_pump`: `screens.remove`, `forget_session`).
- A rail launches its steps on the rail's own page, which is usually not the
  page the human is looking at, and it does not reveal them.

Leading hypothesis: the tool ran and exited while the rail's page was not on
screen, so its output reached no terminal. When the human opened the page,
the pane mounted a fresh xterm, `restoreScreen` asked a daemon that had
already dropped the screen, and got nothing.

A second, smaller window exists even when the page IS on screen: the
listener is registered through a round trip (`listen`), and a sub-second run
can finish before it lands. The Tools-tab run (`workspaceToolsActions.ts`)
reveals its tab, but can still lose that race.

## Do

1. Reproduce before changing anything: put a fast script tool
   (`echo hello`) on a rail, start the rail from a different page, then open
   the rail's page. Then try the same with the rail's page on screen. Say
   which cases come up empty. If the hypothesis is wrong, stop and report
   what you found instead.
2. Fix it so a kept-open tool tab always shows what the run printed, however
   fast the run and whichever page was on screen. Pick the approach and say
   why. Candidates, none decided:
   - the daemon keeps an exited session's screen until the app asks for it
     or the tab closes, instead of dropping it at exit;
   - the final screen travels with the exit (`SessionExited`);
   - the app creates the terminal, and so the listener, when it retains the
     tab (`retainTabOnExit`), before any output can arrive. This one only
     narrows the race; it does not close it.
3. A daemon or protocol change means a version bump. Read CLAUDE.md's traps
   first ("The compat gate is per request TYPE", "The daemon is shared and
   long-lived"), verify against an isolated daemon under a temp `$HOME`, and
   never restart the shared daemon.

Pin whatever decides the outcome with tests in the pure modules. The
rendered pane is the owner's to confirm in the running app.
