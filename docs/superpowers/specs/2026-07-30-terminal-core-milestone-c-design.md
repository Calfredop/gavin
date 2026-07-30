# Terminal Core — Milestone C: Split Panes

Date: 2026-07-30
Status: Approved

## Context

Milestone B (`docs/superpowers/specs/2026-07-30-terminal-core-milestone-b-design.md`)
built the first real client: a Tauri + Svelte + xterm.js app with exactly one
hardcoded terminal session, full-window, `cwd=$HOME`. This spec covers the
next increment on the terminal-core roadmap — originally framed as
"Milestone C: workspaces + split panes" — narrowed, by explicit choice, to
**split panes only**. Multiple project-directory workspaces (the sidebar,
per-workspace switching) is deferred to a later milestone; this one stays
scoped to making a single workspace genuinely useful for running several
sessions at once, since that's the more distinctive "vibe coding" value
(multiple AI agents/shells side by side) and everything here composes
cleanly under a future workspace-switcher rather than needing to be
redesigned for it.

## Goals

- A freeform, resizable split-pane layout within the app's single
  (still `$HOME`-based) workspace context.
- **Each pane hosts multiple sessions as tabs**, browser-tab-style — not
  one session per pane. Clicking a tab switches that pane's visible session
  and moves keyboard focus there; clicking anywhere else in a pane moves
  focus there without changing its active tab.
- Split/new-tab/close triggered via keyboard shortcuts and a first-version
  toolbar. A small set of layout presets (quick-apply starting layouts).
- Mouse-drag text selection and clipboard copy/paste, using standard
  terminal-app conventions (`Cmd+C`/`Cmd+V` for copy/paste, `Ctrl+C`
  remaining the only way to send an interrupt to a running process — these
  never conflict, they're different keys).
- The whole layout (pane tree structure, which sessions are in which tabs)
  persists across app restarts, extending the single-session persistence
  Milestone B already built and using the same per-session stale/exited
  fallback it established.

## Non-goals (this spec)

- Multiple workspaces / project-directory switching, the sidebar — a later
  milestone.
- Git status, shell-integration status detection, OS notifications —
  Milestones D/E per the original roadmap.
- Moving or duplicating an existing session into a new tab/pane, or any
  session picker UI — every new tab/pane gets a fresh session
  (`cwd=$HOME`, same default as today).
- A right-click context menu for copy/paste — keyboard shortcuts only for
  this pass.

## Product decisions carried from brainstorming (why they're not obvious)

- **Closing the app never kills sessions** (unchanged from Milestone B —
  they're daemon-owned and outlive the window). **Closing a tab, closing a
  pane, or a session exiting on its own (e.g. typing `exit`) all kill that
  session explicitly.** The distinguishing principle: an action that
  targets a *specific* session is treated as clear intent to end it; closing
  the window's chrome doesn't target any session, so it doesn't end
  anything.
- **Tabs stay mounted (hidden, not destroyed) when you switch away.** Like
  a browser keeping background tabs' content alive rather than tearing down
  and re-rendering DOM on every switch. Costs more memory with many tabs
  open, but switching is instant and no scroll/rendering state is lost —
  the alternative (destroy on switch, re-`Attach` and replay scrollback on
  return) would show a visible reconnect flash on every tab switch.
- **`Cmd+C` never sends an interrupt, `Ctrl+C` always does.** `Cmd+C`
  copies the active selection (if any) to the OS clipboard and is never
  forwarded to the shell; if there's no selection, it does nothing. This
  matches iTerm2/Terminal.app convention, not something invented for this
  app — the two keys don't overlap, so there's no ambiguity to resolve at
  runtime.

## Architecture

- **Daemon protocol: no changes.** `CreateSession`/`Attach`/`WriteInput`/
  `ResizeSession`/`KillSession` already operate per-session-id, and
  `Output`/`SessionExited` already carry a session id in their payload —
  Milestone B's event-filtering-by-id pattern (`Terminal.svelte`'s
  `currentSessionId` check) already anticipated exactly this multiplexing
  need. The Tauri backend keeps its single persistent daemon connection;
  multiple `Attach` calls for different session ids on that one connection
  work correctly today, and the existing reader-thread relay (tagging every
  outgoing Tauri event with the session id) needs no structural change —
  it already broadcasts by id, and now multiple frontend components each
  filter for their own id instead of just one.
- **Backend (Tauri Rust) changes:**
  - `ActiveSessionId` (a single value) is removed entirely — there's no
    longer one "the" active session. `write_input`/`resize_session` gain an
    explicit `session_id: String` parameter instead of reading implicit
    state.
  - `bootstrap()`'s single "create-or-reattach one session" flow
    generalizes: read the persisted layout tree (or default to one pane,
    one tab, fresh session, matching today's first-launch behavior), call
    `ListSessions` once, and for every session id referenced anywhere in
    the tree — attach if it's present and not `exited`, otherwise create a
    fresh session and substitute its id into the tree (same per-session
    fallback Milestone B's final review added, now applied uniformly
    across every tab in every pane, not just one session).
  - New on-demand commands: `create_session() -> Result<String, String>`
    (new tab/pane — sends `CreateSession`, returns the new id) and
    `kill_session(id) -> Result<(), String>` (tab/pane close). Both are
    thin wrappers sending the corresponding daemon request, matching
    `write_input`'s existing shape.
  - A `get_current_layout() -> Option<LayoutNode>` command, polled the same
    race-safe way `get_current_session` was in Milestone B: `bootstrap` may
    substitute fresh session ids for stale ones, so the frontend needs the
    *resolved* tree, not the one it might have cached, before rendering.
  - Config (`AppConfig`) changes from `{ session_id: Option<String> }` to
    `{ layout: Option<LayoutNode> }`.
- **Frontend (Svelte) changes:**
  - `Terminal.svelte`'s pane-rendering logic (attach/create, render,
    input/resize/exit handling) is extracted into a reusable component
    parameterized by session id, since a pane's tab bar now mounts one of
    these per tab (kept alive, hidden via CSS when not the active tab —
    see Product decisions above).
  - A new layout component owns the split-tree, renders panes recursively
    with draggable resize dividers, and renders each pane's tab bar
    (clickable tabs, a "+" to add a tab, an "×" to close one).
  - A toolbar (Split Right, Split Down, Close Pane, Layout presets menu)
    plus keyboard shortcuts drive the same actions against whichever pane
    currently has focus: `Cmd+D` split right, `Cmd+Shift+D` split down,
    `Cmd+T` new tab in the focused pane, `Cmd+W` close the focused tab.
  - Copy/paste: `Cmd+C` reads the focused pane's active tab's xterm.js
    selection (if any) and writes it to the OS clipboard; `Cmd+V` reads the
    clipboard and sends it as input to that same session, via the existing
    `write_input` command. Needs a new dependency,
    `tauri-plugin-clipboard-manager` (+ its npm package), with an explicit
    capability grant — `core:default` does not include clipboard access,
    the same kind of gap already hit once with window close/destroy in
    Milestone B, so this is checked against the compiled ACL up front
    rather than assumed. Mouse-drag text selection is xterm.js's built-in
    behavior and should work without new code; verified, not built from
    scratch.

## Data model

- **Layout tree** (replaces Milestone B's flat `session_id` field):
  ```
  LayoutNode =
    | { type: "leaf", tabs: string[], activeTabIndex: number }
    | { type: "split", direction: "row" | "column", children: LayoutNode[], sizes: number[] }
  ```
  `tabs` is an ordered list of session ids; `activeTabIndex` picks which one
  is currently visible in that pane.
- **Focus**: exactly one pane (leaf) has focus at a time — not persisted,
  resets to some pane on launch. Keyboard input goes to that pane's active
  tab's session.
- **Layout presets**: pure functions producing a starting tree (e.g.
  side-by-side, 2×2 grid), each leaf a single fresh-session tab. Applying a
  preset replaces the current tree — since this discards existing panes'
  sessions (via the same explicit-kill semantics as closing them), it's
  presented as a deliberate action, not a casual one-click default.

## Data flow

1. **Launch:** read the persisted layout tree (default: one pane, one tab,
   fresh session, if none saved). Resolve every referenced session id
   against `ListSessions` — attach the valid ones, create fresh sessions
   for stale/exited/missing ones, updating the tree in place. Persist the
   resolved tree. Expose it to the frontend via `get_current_layout`.
2. **Render:** the layout component walks the resolved tree, rendering
   split dividers and, at each leaf, a tab bar plus one mounted-but-hidden
   pane component per tab (only the active tab's pane is visible).
3. **Split** (toolbar or `Cmd+D`/`Cmd+Shift+D`, on the focused pane): call
   `create_session()` → wrap the focused leaf in a new `split` node with
   the original leaf and a new one-tab leaf as children → persist.
4. **New tab** (`Cmd+T` or a pane's "+"): call `create_session()` → append
   to the focused leaf's `tabs`, set it active → persist.
5. **Close tab/pane** (a tab's "×", `Cmd+W`, or the pane-close toolbar
   button): `kill_session(id)` for every session being closed → remove from
   the tree (a pane whose last tab closes collapses out of its parent split)
   → persist. Closing the layout's very last pane leaves an empty state
   with a "New Session" affordance rather than silently recreating one.
6. **Resize** (dragging a divider): update the tree's stored `sizes` →
   send `ResizeSession` for *every* session in the affected pane's tab list
   (not just the active one — they share the same on-screen rectangle, so
   a tab you switch to later must already be the right size, not need its
   own resize event).
7. **Copy/paste/selection:** as described in Architecture above.

## Error handling

- Same daemon-unreachable / bootstrap-failure handling as Milestone B,
  applied once at launch (not per-pane) — if the daemon can't be reached at
  all, nothing in the layout can resolve, so the existing connecting/error
  overlay covers the whole window before any panes render.
- A `create_session`/`kill_session` command failing (e.g. the daemon
  connection drops mid-session) surfaces as a `daemon-error` event, same
  mechanism as `write_input`/`resize_session` failures today — not a new
  error path.

## Testing

- Backend: the generalized `bootstrap` (looping over multiple session ids,
  same per-session stale-fallback logic) and the new `create_session`/
  `kill_session`/`get_current_layout` commands get real automated tests —
  same discipline as Milestone A/B (spawn a real daemon, real sockets, no
  mocks).
- Frontend: the split-tree layout, tab bar, keyboard shortcuts, toolbar,
  and copy/paste are GUI-only and need manual verification, same
  limitation noted in Milestone B — the agent environment has no
  Accessibility permission for synthetic keyboard/mouse input, so the
  interactive parts need a human at the keyboard.
