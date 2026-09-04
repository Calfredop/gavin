# Workspace windows

Card: `.gavin-root/plans/feat-new-window.md` — "Allow to open a workspace in a
new window, or to move an already opened one to a new window. Make this possible
via the contextual menu of the workspace, and from the action buttons of the hub
(befor the new page '+' button)".

Gavin shipped as a one-window app, and said so out loud: the app-hub spec opens
with "Gavin has one window and the pinned workspace always exists, so there is no
'nothing open' moment to hang a welcome page on." This is the change to that
sentence.

## The rule

**A workspace is on screen in exactly one window.**

Not a preference — the thing that makes the feature possible at all. Nothing
about gavin's backend is per window: one daemon connection, one `Attach` per
session, and every push (`pty-output`, statuses, gavin trees) broadcast to every
webview in the process. Two windows drawing one workspace would therefore be two
`TerminalPane`s over one PTY, each reporting its own cols/rows to the daemon on
every layout change, resizing the program between them for as long as both were
open. There is no arbitration to add: there is only the question of which window
a workspace is in.

So "open in a new window" and "move to a new window" — the card's two verbs —
are one operation. The difference is only whether the window doing the handing
over happened to be looking at the workspace, which is a fact it can read for
itself.

## Where the answer lives

`app/src-tauri/src/workspace_window.rs` holds a `HashMap<workspace id, window
label>`. Three properties matter:

- **Absence means the main window.** The map records only the exceptions, so
  "nothing has moved" is the empty map rather than a full one every window would
  have to keep correct.
- **It is ephemeral.** Entries die with their window, including on quit. Windows
  are deliberately *not* restored across launches: the app comes back as one
  window holding everything, which is a state the user can always reach and never
  has to be rescued from. (Restoring them is a later card if it is ever wanted.)
- **A workspace window's label is `ws-<workspace id>`.** That is how a fresh
  webview finds out what it is for without a URL query, and it is what the
  capability file's `ws-*` glob grants — a window with no capability comes up
  dead, so this pattern is load-bearing.

`app/src/lib/appWindow.ts` is every rule read off that map, pure and unit-tested;
`appWindowState.ts` holds the live copy and this window's label.

## One guard, not thirty call sites

Every path that puts a workspace on screen — the sidebar, the hub's recents, the
⌘⌥-digits, a card jumping to its session, a rail launching a step — ends in
`layoutState`'s `activateWorkspace`. Guarding that one function is what makes the
rule hold everywhere:

> If another window owns this workspace, return the state unchanged and raise
> that window instead.

`switchWorkspaceView` is guarded separately, because it deliberately does *not*
go through `activateWorkspace`: `activeView` is stored **on the workspace**, so a
click here would persist a tab change that the other window then adopts — one
window silently redrawing another.

## The hand-off, in order

`handOffWorkspace(workspaceId)`:

1. **Look away.** Switch this window to the next workspace it still holds, or
   open the app hub when it holds none.
2. **Give up the terminals.** `destroyTerminal` for every id in the workspace's
   trees, plus the main agent (which sits outside every page tree, D12). This is
   what unsubscribes this window from those sessions' output.
3. **Ask for the window.** The new one builds its own terminals and asks the
   daemon to repaint them from its screen model — the same path a frontend reload
   already takes.

Any other order has two live panes on one PTY, even briefly. Nothing is killed
and nothing is closed: the sessions run on in the daemon throughout. Scrollback
from before the move does not survive, because scrollback exists only inside an
xterm; the running program does.

## Keeping the windows in step

`config.json` is one file behind however many windows are open, and every window
writes the whole workspaces array back. Without something, the second window to
save would undo the first's work — a page renamed here, a tab opened there, and
whichever saved last wins the file.

So `set_workspaces_state` broadcasts `workspaces-synced` carrying the payload and
the **label of the window that wrote it**. Every other window adopts it; the
writer ignores its own echo. What is *not* adopted is `activeWorkspaceId`: that
is per window now, and taking the writer's would make one window's click change
what another is looking at. Each window reads the stored id as a preference and
falls back to the first workspace it actually holds
(`activeWorkspaceForWindow`).

This is last-writer-wins, not a merge. Two windows saving within the same
round trip can still lose one of the two writes; they converge afterwards. Given
both writes are human-driven clicks in two windows, that was judged acceptable —
a merge would need per-field provenance the config format does not carry.

## What the human sees

Two entry points, as the card asks, and one function behind both so they can
never disagree about the words (`windowActionLabel`):

- The sidebar workspace menu, in its own group under "New Page".
- An `AppWindow` icon on the hub tab row, **before** the "New page" `+` — both
  act on the workspace as a whole rather than on what is inside it, and this one
  decides *where* the workspace is before the other adds to it.

It reads **"Open in New Window"** for a workspace this window holds, **"Show in
Its Window"** for one that has already left, and is **absent** in the window a
workspace already is — where both gestures would end where they started.

The sidebar keeps listing every workspace, including the ones in other windows:
it is the whole fleet, not this window's share of it. Those rows are dimmed and
carry a window glyph whose tooltip names the axis, and clicking them raises the
owning window (the guard above, so every route to them behaves the same). The
glyph is a mark rather than a `StatusBadge`: "where is it" is not one of the axes
`ui/indicators.ts` speaks for.

A workspace window is otherwise the whole app — same sidebar, same hub, same
everything. Two things differ: it opens on its own workspace, and closing it asks
nothing. The main window's close prompt exists because closing that window is how
you put gavin away; a workspace window puts nothing away.

Closing a **workspace** (the sidebar X, or the delete wizard) takes its window
with it, after the confirmation — a window whose workspace no longer exists has
nothing to show.

## Rejected

- **Letting a workspace appear in two windows.** The PTY resize fight above. It
  is not a polish problem; there is no correct size to report.
- **A cut-down workspace window** (its own workspace only, no sidebar list, no
  hub). It costs a second layout to maintain and takes away the only thing that
  makes the other windows reachable from it.
- **A URL query (`?workspace=…`) to tell a new window what it is for.** The label
  already says it, the label is what the capability matches, and one source is
  better than two that can disagree.
- **Restoring windows across launches.** Real, but a separate decision: it needs
  the registry to become persistent state with all the reconciliation that
  implies, and the one-window fallback is never wrong.
