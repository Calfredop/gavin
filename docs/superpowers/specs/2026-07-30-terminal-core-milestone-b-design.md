# Terminal Core — Milestone B: Minimal Client (Tauri + Svelte + xterm.js)

Date: 2026-07-30
Status: Approved

## Context

Milestone A (`docs/superpowers/plans/2026-07-29-terminal-core-daemon.md`) built
and hardened `gavin-daemon`: a Rust binary that owns terminal PTYs, persists
session state in SQLite, and exposes session control (create/list/kill/resize/
attach) over a Unix domain socket using a newline-delimited JSON protocol. It
has no GUI — it was verified entirely through integration tests and a manual
`nc` smoke test.

This spec covers **Milestone B**, per the roadmap in the terminal-core design
spec (`docs/superpowers/specs/2026-07-29-terminal-core-design.md`) and the
Milestone A plan's own roadmap note: a minimal but real desktop client that
proves the daemon's protocol works end-to-end from an actual GUI. It is
explicitly the smallest useful client, not a preview of the final app.

## Goals

- A Tauri desktop app that, on launch, auto-spawns `gavin-daemon` if it isn't
  already running, and connects to it.
- Creates a terminal session (or reattaches to a previously-created one — see
  below) and renders it full-window via xterm.js, with working keyboard
  input, live output, and resize.
- **Session persistence across app restarts**: the app remembers the session
  id it was last using (in a local config file) and reattaches to it on the
  next launch, rather than creating a fresh session every time. This is what
  actually exercises the daemon's core value proposition (sessions survive
  the app closing) from an end-user's perspective, not just from a test.
- Frontend framework: **Svelte**. Chosen deliberately because it also needs
  to carry the kanban board work later (`svelte-dnd-action` for drag-and-drop,
  and Svelte's reactivity model fits both a kanban board's live state updates
  and a terminal's high-frequency output stream better than a virtual-DOM
  framework would), not just for this milestone in isolation.

## Non-goals (this spec)

- Workspaces, multiple sessions, split panes, or any sidebar/chrome beyond
  the terminal itself — Milestone C.
- Git status, shell-integration status detection, OS notifications —
  Milestones D/E.
- Production packaging: code signing, installers, or bundling the daemon as
  a Tauri "sidecar" binary for distribution. The app locates and spawns a
  sibling `gavin-daemon` binary built by the same workspace in development
  mode; production distribution is a later concern.
- Automated end-to-end GUI testing (keystrokes, rendering). Out of reach for
  this milestone's scope — verified manually instead (see Testing).

## Architecture

- **Shared protocol crate.** `crates/daemon/src/protocol.rs` (the
  `Request`/`Response` types and newline-delimited-JSON framing) is extracted
  into a new `crates/protocol` crate. Both `crates/daemon` and the Tauri app's
  Rust backend depend on it, so client and server can't drift apart on wire
  format. `crates/daemon` keeps re-exporting or directly using
  `crates/protocol`'s types under the same names it already uses internally
  (`server.rs` and its tests are otherwise unaffected).
- **Repo layout.** A new `app/` directory holds the Tauri project: `app/src`
  (Svelte frontend), `app/src-tauri` (Rust backend, Tauri's standard
  scaffold), added as another member of the existing Cargo workspace
  alongside `crates/daemon` and `crates/protocol`.
- **Process model.** The Tauri Rust backend is a thin socket client — the
  same architectural role the terminal-core design spec already assigned it.
  On startup: attempt to connect to the daemon's known socket path
  (`~/Library/Application Support/gavin/daemon.sock`, matching Milestone A);
  on connection failure, locate the sibling `gavin-daemon` binary (next to
  the app's own executable in the workspace's build output) and spawn it as
  a detached child process, then retry the connection with a short backoff
  (e.g. up to ~2s, polling every 100ms) before giving up and surfacing an
  error state.
- **Frontend↔backend IPC.** xterm.js's `onData` callback invokes a Tauri
  command (`write_input`) that the Rust backend forwards as a `WriteInput`
  request over the socket. PTY output arrives on the Rust side as streamed
  `Output` responses (from the daemon's `Attach` mechanism) and is pushed to
  the frontend via a Tauri event (`pty-output`) that the Svelte terminal
  component subscribes to. Window resize triggers xterm.js's `FitAddon` to
  compute new cols/rows, which invokes a `resize_session` command mapping to
  `ResizeSession`.

## Data model

- **Local app config** (Tauri's app-config-dir, e.g.
  `~/Library/Application Support/com.gavin.app/config.json` — exact Tauri
  identifier decided at scaffold time): `{ "session_id": string | null }`.
  Written immediately after a session is created or successfully reattached
  to, so a crash immediately after doesn't lose the pointer to a live
  session.

## Data flow

1. **Launch:** Rust backend reads the local config for a saved `session_id`.
   Attempts to connect to the daemon socket; if unreachable, spawns
   `gavin-daemon` and retries until connected or the backoff is exhausted
   (surfacing an error state on exhaustion — see Error handling).
2. **Reattach or create:**
   - If a `session_id` was saved, send `Attach { id: session_id }`.
   - If the daemon responds with an error (unknown session — e.g. first run,
     or the session was killed/no longer exists), fall through to creating a
     new session: `CreateSession { cwd: $HOME, ... }`, then immediately
     persist the new id to the config file.
   - If no `session_id` was saved at all, go straight to creating a new one.
3. **Render:** the frontend mounts an xterm.js instance filling the window
   and subscribes to `pty-output`. Because `Attach` already replays the
   daemon's per-session scrollback buffer (Milestone A), reattaching to a
   session naturally shows recent output from before the app was closed,
   with no special handling needed on the client side.
4. **Interact:** keystrokes → `write_input` command → `WriteInput` over the
   socket → PTY. Output → daemon `Output` response → `pty-output` event →
   xterm.js. Window resize → `FitAddon` → `resize_session` command →
   `ResizeSession` over the socket.

## Error handling

- **Daemon never becomes reachable** (spawn failed, or connect retries
  exhausted): render an inline error state in the window (the underlying
  error message, plus the socket path being used) instead of crashing or
  showing a blank window.
- **Saved session id is stale/unknown:** transparently create a new session
  and overwrite the saved id (already covered in Data flow step 2) — no
  error surfaced to the user for this case, since it's an expected, normal
  occurrence (e.g. the session was killed outside the app, or this is the
  very first launch after Milestone A recovery skipped an unrecoverable
  record).
- **Session exits** (the shell process ends): render an "exited" state in
  the terminal pane (using the daemon's `SessionExited` message — surface
  the exit code) rather than leaving a frozen/dead-looking terminal or
  auto-quitting the app.

## Testing

- **Rust backend:** unit tests for the connect-or-spawn logic (using a
  throwaway socket path so tests don't collide with a real running daemon)
  and the config-file read/write (using a temp dir), following the same
  "real process, real socket, no mocks" discipline established in Milestone
  A rather than stubbing the daemon.
- **Frontend/GUI:** manual verification only for this milestone — typing
  works, output renders, window resize actually resizes the PTY, and
  quitting and relaunching the app reattaches to the same session and shows
  recent scrollback. Automated end-to-end GUI testing is out of scope (see
  Non-goals).
