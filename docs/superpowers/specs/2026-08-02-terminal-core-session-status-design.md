# Terminal Core — Session Status Detection & Notifications — Design Spec

Date: 2026-08-02
Status: Approved

## Context

This is the next milestone after the Workspaces milestone (sidebar, pages,
drag-and-drop — shipped). It picks up scope the original terminal-core spec
(`docs/superpowers/specs/2026-07-29-terminal-core-design.md`) sketched but
never designed in detail: per-session status detection
(`idle`/`working`/`waiting_for_input`) and OS notifications on
status-worthy transitions.

The original spec bundled this with "git status per workspace." That
pairing no longer holds: the original spec assumed a workspace is bound to
a directory (`Workspace: { id, name, path, ... }`), but the actual
Workspaces milestone deliberately made workspaces directory-less arbitrary
groupings of pages, each page holding its own independent panes/sessions
with independently-tracked cwds. There is no single "workspace directory"
left to run `git status` against. Git status is therefore **out of scope
here** and will get its own brainstorm once its scoping question (per
session? per page?) is resolved separately.

Much of this milestone's data-model plumbing already exists from
Milestone A, unused: the daemon's `SessionStatus` enum
(`Idle`/`Working`/`WaitingForInput`/`Exited`, `crates/daemon/src/registry.rs`)
is already persisted end-to-end through `SessionRecord` → `SessionSummary`
→ `ListSessions` responses — nothing has ever actually *set* it to
`Working` or `WaitingForInput`. This milestone's real work is the
detection logic, a live-update event (mirroring the existing
`Response::CwdChanged` precedent from OSC 7 cwd tracking), and the
frontend UI/notification layer.

## Goals

- Detect, per session, three live states: `idle`, `working`,
  `waiting_for_input` — persisted the same way `cwd` already is, surfaced
  live to the frontend via a new event (no polling).
- Zero required user configuration — every mechanism activates
  automatically for shells/tools that already emit the relevant signal,
  and degrades gracefully (to a coarser but still-useful state) for those
  that don't. Same silent-fallback precedent OSC 7 cwd tracking already
  established.
- A per-tab status indicator (idle / working / request attention) in
  `Pane.svelte`, aggregated as a count badge on `Sidebar.svelte`'s page
  and workspace rows.
- An OS notification on the two transitions actually worth interrupting
  the user for: into `waiting_for_input`, and `working → idle`
  ("your task just finished") — suppressed whenever the app itself is
  the frontmost window, regardless of which pane is internally focused.

## Non-goals (this spec)

- Git status (per-workspace or otherwise) — separate future brainstorm,
  blocked on deciding what it should even be scoped to now that
  workspaces aren't directory-bound.
- A documented/shipped shell-integration init snippet. Detection is
  entirely signal-observation — nothing this milestone ships requires the
  user to source anything, matching OSC 7's existing precedent exactly.
- An "exited" pane UI (exit code shown, restart-command action) — the
  original terminal-core spec sketched this, but it was never built in
  any shipped milestone; sessions are simply removed from the tree on
  exit today (`layoutState.ts`'s `handleSessionExited`). Out of scope
  here; `Exited` is not part of this milestone's new `StatusChanged`
  event at all (see Architecture).
- Notification actions/interactivity (e.g. a button to jump straight to
  the session) — a plain notification is enough for v1.
- Any change to the existing OSC 7 cwd-tracking scanner or its behavior.

## Detection mechanisms

Two independent mechanisms, layered:

**Idle ↔ Working** — OSC 133 shell-integration markers
(`ESC ] 133 ; <command> ST`, terminator BEL or `ESC \`) when the
shell/prompt framework emits them:
- `A` (prompt start) or `B` (command start, prompt finished rendering) →
  `idle`.
- `C` (command executed, output starting) → `working`.
- `D` (command finished, optionally `;<exit-code>`, digits 0-255) →
  `idle`.

Falls back to a pure output-activity heuristic for sessions where no OSC
133 marker has ever been observed: any new PTY bytes written →
`working`; 2 seconds with no further output → `idle`. This is
intentionally coarse (it cannot distinguish "command still running" from
"sitting at an unmarked prompt") but requires nothing from the user,
matching OSC 7's own sourced-vs-not-sourced fallback story.

**Precise switching rule, to avoid the two mechanisms conflicting or
flapping against each other**: per session, the *first* valid OSC 133
marker ever observed permanently switches that session's idle/working
detection to OSC-133-only for the rest of its lifetime — the
output-activity heuristic stops being consulted for that session
entirely from that point on. Before a session's first OSC 133 marker,
the heuristic drives idle/working. This is a one-way switch per session
(never reverts to heuristic mode once OSC 133 has been seen), so the two
mechanisms are never both live for the same session at the same time.
Bare-BEL waiting-for-input detection is independent of this switch and
is always active regardless of which idle/working mechanism a session is
currently using.

**Waiting for input** — a bare terminal BEL byte (`\x07`), observed
*outside* any OSC escape sequence. This is a deliberate departure from
the original spec's sketch of prompt-text pattern-matching (`"(y/n)"`,
`"Continue?"`): research during this milestone's brainstorm found that
Claude Code and many other CLI tools already ring the terminal bell
specifically to signal "waiting for your approval/input" — a real,
intentional, long-standing terminal convention, not something requiring
per-tool text-pattern heuristics that would need constant upkeep as tools
change their prompt wording. cmux (this project's own stated inspiration)
similarly relies on terminal escape-sequence signals rather than text
matching. A BEL always transitions to `waiting_for_input` regardless of
current state; the next OSC 133 `C`, or renewed output activity in
heuristic mode, transitions back to `working`.

**Critical subtlety, worth stating explicitly since it's easy to get
wrong**: OSC 7 (cwd) and OSC 133 (status) both legally use BEL as an
alternative sequence terminator to `ESC \`. A BEL-scanner that isn't
aware of *any* OSC sequence in progress — not just OSC 133 specifically —
would misfire on every single shell prompt that happens to use
BEL-terminated OSC 7, since that BEL is a delimiter, not a bell. The
scanner (below) is therefore built to recognize OSC sequences generically
(any number, not just 133) purely so it can correctly withhold a
terminator BEL from being misclassified as a standalone attention-bell.

## Daemon architecture

**New file `crates/daemon/src/status.rs`** — a `StatusScanner`, built with
the same rigor and conventions as the existing `OscCwdScanner`
(`crates/daemon/src/osc.rs`): payload-length cap so a malformed/runaway
sequence can't grow forever, byte-by-byte state so a sequence split across
separate PTY reads is still found correctly, graceful recovery to `Idle`
on anything unexpected — never panics, never gets stuck. One `StatusScanner`
instance per session also owns a `seen_osc133: bool` flag and (while
`false`) the output-activity heuristic's own quiet-period timer, so it can
implement the one-way OSC-133-permanently-wins switching rule described
above in "Detection mechanisms" — the flag flips to `true` the first time
a valid OSC 133 marker is parsed, and the heuristic timer is simply never
consulted again for that instance afterward.

State machine, at a high level:
- `Idle`: a bare `BEL` byte here is the standalone terminal bell →
  emit `waiting_for_input`. An `ESC` byte moves to watching for the OSC
  introducer.
- On seeing `ESC ]`, the scanner is "inside an OSC sequence" — it
  accumulates the OSC number generically (not just checking for `133`)
  until `;`, then accumulates the payload until a terminator (`BEL` or
  `ESC \`). This terminator is *always* consumed as a delimiter, never
  treated as a standalone bell, regardless of what OSC number it was.
- Only when the accumulated number was specifically `133` is the payload
  parsed as a status command (`A`/`B`/`C`/`D` + D's optional
  `;<exit-code>`), producing an idle/working transition. Any other OSC
  number's sequence is still correctly tracked structurally (for
  terminator purposes) but produces no status transition.
- Anything that doesn't look like a well-formed OSC introduction (e.g.
  `ESC` followed by something other than `]`, such as a CSI sequence)
  resets straight back to `Idle` without misinterpreting subsequent bytes
  — the same permissive-recovery convention `OscCwdScanner` already uses.

**Wiring into `spawn_pump`** (`crates/daemon/src/server.rs`): a
`StatusScanner` is instantiated per-pump-thread alongside the existing
`OscCwdScanner`, fed the identical raw `&buf[..n]` slice at the identical
point (before UTF-8 decoding) — one more scanner in the same spot, same
pattern. On a detected transition: `registry.update_status(&id, status)`
(mirroring `update_cwd`), then a new `Response::StatusChanged { id, status }`
sent to the attached writer (mirroring `Response::CwdChanged`). On
`Attach`, a synthetic baseline `StatusChanged` is sent immediately after
scrollback replay, carrying the session's current persisted status — the
same precedent `CwdChanged` already established for its own attach-time
baseline, so a newly-attached or reattaching frontend knows current status
without waiting for the next transition.

**`crates/protocol/src/lib.rs`**: `Response::StatusChanged { id: String, status: String }`,
reusing `SessionStatus::as_str()`'s existing string convention
(`"idle"`/`"working"`/`"waiting_for_input"`) — the same convention
`SessionSummary.status` already uses over the wire. `Exited` is
deliberately never sent via this event: the existing `SessionExited`
event already communicates session death, and the session is removed from
the UI tree regardless (see Non-goals), so a parallel status event at
exactly that moment would be redundant and racy against teardown.

## Frontend architecture & UI

**`app/src-tauri/src/session.rs`**: a new `Response::StatusChanged { id, status }`
match arm in `bootstrap()`'s relay loop (mirroring the existing
`CwdChanged` arm), emitting a Tauri event `"session-status-changed"` with
payload `(id, status)`.

**`app/src/lib/layoutState.ts`**: `LayoutState` gains
`sessionStatusById: Record<string, "idle" | "working" | "waiting_for_input">`
(mirroring `cwdBySessionId` exactly, including its "never cleaned up on
session exit, harmless stale entry" convention). A new
`handleSessionStatusChanged(sessionId, status)` action, wired into
`bootstrap()`'s event listeners the same way the existing `cwd-changed`
listener is. Before overwriting the map, this action reads the *previous*
status (needed to detect "transition into X," not just current value)
and hands `{sessionId, previousStatus, newStatus}` to the new
notifications module below.

**Per-tab indicator** (`Pane.svelte`): a small status dot on each tab,
driven by `$layoutState.sessionStatusById[sessionId]` — three visual
states: idle shows no dot at all (the common/default state stays visually
quiet, consistent with how this app already treats "nothing to report" —
e.g. the focus-indicator border being fully transparent rather than a
dim color when unfocused), working shows a distinct color (e.g. blue),
request attention shows an attention-grabbing color (e.g. red/amber).
`waiting_for_input` stays the internal/data-model name (matching the
existing Rust enum unchanged); "request attention" is the UI-facing
label/tooltip wording.

**Aggregated counts** (`Sidebar.svelte`): each page row and workspace row
shows a small count badge — the number of sessions currently in
`waiting_for_input` within it. This is the one state worth surfacing at a
glance in a collapsed/navigated-away-from row; "working" is background
information, not something a badge needs to draw the eye to.

## Notifications

**New `app/src/lib/notifications.ts`** (matching this project's
established one-file-per-concern module style — `confirmClose.ts`,
`clipboard.ts`, `dragDrop.ts`). Exports
`maybeNotifyStatusChange(sessionId, previousStatus, newStatus)`, called
from `handleSessionStatusChanged` before the map is overwritten:

- Fires only on two transitions: into `waiting_for_input`, or
  `working → idle`.
- Suppressed entirely whenever gavin's window is the OS-frontmost/key
  window (checked via Tauri's window-focus API), regardless of which
  pane is internally focused — a deliberately simpler rule than
  per-pane-visibility, chosen because "the app is in front of you at all"
  already means you don't need an OS notification to notice something
  changed; the in-app status dot/badge is enough once you're looking at
  the app at all.
- Permission requested lazily via `@tauri-apps/plugin-notification`'s
  `isPermissionGranted()`/`requestPermission()`: checked first, and
  `requestPermission()` is only called the first time a real
  notification-worthy transition actually occurs — not at app launch,
  so the OS permission dialog has context ("a session needs you") rather
  than appearing unprompted before any session exists.
- Notification body text uses the same session-label fallback chain
  `Pane.svelte`'s `tabLabel`/`tabTooltip` already use (custom
  `sessionNames` override → cwd-derived folder name → session-id
  fragment), so it reads as `"my-project needs your input"` rather than
  a raw UUID.

## Error handling

- A session that never emits OSC 133 or BEL simply stays in the
  output-activity-heuristic idle/working loop forever — not an error
  state, the documented expected degraded mode (same as OSC 7's own
  silent-fallback precedent).
- A malformed/truncated OSC sequence (cut off mid-stream) recovers to
  `Idle` via the same abandon-on-cap-length mechanism `OscCwdScanner`
  already uses.
- Notification permission denied: `maybeNotifyStatusChange` simply
  no-ops after a denied `requestPermission()` result — no retry loop, no
  error surfaced, matching this project's established best-effort,
  non-blocking convention for anything frontend-notification-adjacent.

## Testing

- `status.rs` gets the same exhaustive byte-by-byte and
  split-at-every-boundary test treatment `osc.rs` already has, including
  the specific false-positive regression test this design exists to
  prevent: an OSC 7 sequence terminated by BEL must *not* register as a
  standalone attention-bell. Also: each of A/B/C/D individually, D with
  and without an exit code, a bare standalone BEL in plain output, an OSC
  number other than 133 or 7 (still correctly tracked structurally, no
  status transition produced), and recovery from a malformed/runaway
  sequence.
- Rust tests for the new `StatusChanged` relay/baseline-on-attach
  behavior in `session.rs`, mirroring the existing `CwdChanged` tests'
  style.
- Frontend: `layoutState.test.ts` extended for
  `handleSessionStatusChanged` (map update, previous-value handoff to
  notifications). New `notifications.test.ts` covering the
  transition-filtering logic and the frontmost-window suppression rule,
  with `sendNotification`/window-focus mocked — matching this project's
  established Tauri-API-mocking test style (see `confirmClose.test.ts`,
  `TitleBar.svelte`'s window-API usage).
- GUI-only aspects (the actual dot colors rendering correctly, the
  aggregated badge counts, a real OS notification actually appearing) are
  verified manually per this project's consistently-documented limitation
  — no synthetic input/notification observation available in the
  automated verification environment.
