# Terminal Core — Design Spec

Date: 2026-07-29
Status: Approved (first sub-project of the larger app)

## Context

The long-term goal is a standalone, cross-platform terminal app (inspired by
[cmux](https://github.com/manaflow-ai/cmux)) that organizes terminal sessions
into folder-like workspaces, supports split panes, surfaces git status, and
lets a kanban board drive/link terminal sessions — all aimed at "vibe coding"
workflows where AI coding agents run inside sessions.

That full scope is too large for one spec. It decomposes into:

1. **Terminal core** (this spec): workspaces, sessions, split panes, git
   status, per-session status + notifications.
2. **Kanban board** (future spec): task/card board with persistence.
3. **Integration layer** (future spec): linking kanban cards to sessions,
   launching/switching sessions from cards.

This document covers **#1 only**. Kanban and the integration layer are
explicitly out of scope here.

## Goals

- Standalone cross-platform GUI desktop app. **macOS first**, Linux and
  Windows follow once the core model is proven there.
- Organize terminal sessions into workspaces bound to a directory on disk
  (typically a git repo or worktree).
- Freeform split panes within a workspace window (split/resize/close), plus
  quick-apply layout presets.
- Compact git status per workspace (branch, dirty indicator, ahead/behind).
- Per-session status indicator (idle / working / waiting-for-input) with OS
  notifications on transitions that need the user's attention.
- Sessions survive the app closing or crashing. Workspace/pane layout and
  session identity also survive a full device restart, though (as explained
  below) the underlying shell process itself cannot — a fresh shell is
  restored in its place.

## Non-goals (this spec)

- Kanban board UI or persistence.
- Linking sessions to kanban cards.
- Remote/SSH sessions — local PTYs only.
- Scrollback replay after a device restart (the pane starts empty; only
  workspace/layout/cwd are restored).

## Architecture

Two-process, client/server model:

- **Daemon** (Rust binary, no UI): owns all PTYs via `portable-pty`.
  Auto-spawned as a detached background process the first time it's needed;
  keeps running independently of the GUI app's lifecycle. Exposes a local
  IPC socket (Unix domain socket on macOS/Linux, named pipe on Windows) for
  session control (create/list/kill/resize) and streams PTY I/O over it.
  Durably persists its session registry (see Data model) to local storage on
  every state change, so it can rebuild state after its own restart.
- **App** (Tauri): the Rust side is a thin client to the daemon — connects
  over the socket, forwards session I/O to/from the frontend via Tauri
  events/commands. The frontend (webview) renders workspaces, the pane-split
  UI, and terminals via **xterm.js**.

This split is what makes "sessions survive the app closing" possible:
closing the Tauri window doesn't touch the daemon or its PTYs. On relaunch,
the app reconnects to the running daemon and rehydrates open sessions.

The daemon is spawned on demand (when the app starts and none is running),
not installed as an OS boot-time service. A full **device restart** kills
the daemon along with everything else — restoration happens the next time
the app (and therefore the daemon) is launched, not automatically in the
background before that. Making the daemon an always-on boot service is a
possible future enhancement, not part of this spec.

## Data model

- **Workspace**: `{ id, name, path, created_at }` — `path` is a directory on
  disk (typically a git repo or worktree). Persisted locally (SQLite or
  JSON, exact choice left to the implementation plan).
- **Session**: `{ id, workspace_id, cwd, command, status, restored }` —
  owned and durably persisted by the daemon (not just held in memory), so
  its identity and placement survive a daemon restart.
  `status ∈ {idle, working, waiting_for_input, exited}`. `restored` is set
  when a session was recreated after its original PTY could not be
  reattached (see Data flow, step 6).
- **Pane layout**: a split-tree per workspace window — either
  `{ type: leaf, session_id }` or
  `{ type: split, direction, children[] }` — persisted client-side so
  layout is restored on reopen. Layout presets (e.g. "2x2 grid") are
  generator functions that produce one of these trees; the user can still
  freely split/resize/close after applying one.

## Data flow

1. **Create workspace**: user picks a directory → app records
   `{name, path}`, kicks off an initial git status read.
2. **Create session**: app asks daemon to spawn a PTY with
   `cwd = workspace.path` (or a pane's overridden cwd) → daemon persists the
   session record and returns `session_id` → app opens an xterm.js pane
   subscribed to that session's I/O stream.
3. **Reconnect (app closed, daemon still running)**: on app launch, the app
   asks the daemon for all live sessions and matches them back into each
   workspace's last-known pane layout. Existing PTYs are reattached as-is,
   scrollback and all.
4. **Status detection**: a shell init snippet (sourced by the user in
   bash/zsh/fish) emits OSC 133-style markers on command start/end and
   prompt display. The daemon parses these out of the PTY stream to derive
   `idle` / `working`; `waiting_for_input` is inferred from prompt-pattern
   matching on recent output (e.g. `(y/n)`, `Continue?`). If no
   shell-integration markers are ever seen for a session, status falls back
   to a simple output-activity heuristic (recent bytes written = working),
   and `waiting_for_input` is unavailable for that session.
5. **Notifications**: on a status transition into `waiting_for_input`, or
   `working → idle` (task just completed), the app fires an OS notification
   — but only if that session's pane isn't currently focused/visible, to
   avoid self-notifying.
6. **Daemon restart / device restart recovery**: on daemon start, it reads
   its persisted session registry. Any session whose PTY is not actually
   alive — which is always true after a full device restart, and also true
   if the daemon itself crashed — is not silently pretended to still exist.
   Instead the daemon spawns a fresh shell at that session's last-known
   `cwd`, marks it `restored: true`, and the app renders the pane with a
   distinct "restored after restart" marker rather than an error. Actual
   live-PTY reattachment (scrollback included) only happens for the
   app-closed-but-daemon-alive case in step 3 — reattaching to a PTY whose
   owning process no longer exists is not physically possible.
7. **Git status refresh**: on workspace focus and on a timer (e.g. every
   few seconds) or filesystem-watch trigger, run `git status --porcelain`
   plus branch/ahead-behind (via `git2-rs` or shelling out to `git`)
   against the workspace path; update the compact indicator (branch, dirty
   dot, ahead/behind counts) in the sidebar.

## Error handling

- **Daemon unreachable** (not running / socket gone): app attempts to
  respawn it; if that fails, shows a reconnect banner rather than silently
  failing.
- **PTY exits normally**: pane shows an "exited" state with the exit code
  and a restart-command action, doesn't auto-close.
- **Session restored after restart**: shown distinctly from both a normal
  exited pane and an error — it's informational, not a failure. The pane
  auto-reopens a fresh shell in the same `cwd`.
- **Workspace path missing/moved**: workspace is marked broken in the
  sidebar; user is prompted to relocate or remove it. Sessions under it are
  not auto-spawned against a bad path.
- **Shell integration not sourced**: silently falls back to the heuristic
  (no error state) — `waiting_for_input` just won't fire for that session.

## Testing

- Rust unit tests for daemon session lifecycle (spawn/list/kill/resize),
  the IPC protocol, and registry persistence/recovery (including the
  simulated-reboot case: registry has entries but no live PTYs).
- Unit tests for the OSC-marker parser and prompt-pattern heuristic against
  recorded PTY output fixtures.
- Frontend unit tests for the pane split-tree logic
  (split/resize/close/serialize).
- Manual QA on macOS for actual PTY rendering/interaction and notification
  delivery (hard to fully automate terminal rendering).
