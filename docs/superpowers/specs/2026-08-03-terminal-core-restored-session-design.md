# Terminal Core — Restored-Session UX — Design Spec

Date: 2026-08-03
Status: Approved

## Context

This is Milestone F, sketched only as a brief roadmap note in the original
daemon plan's header
(`docs/superpowers/plans/2026-07-29-terminal-core-daemon.md`) and never
properly designed. The original terminal-core spec
(`docs/superpowers/specs/2026-07-29-terminal-core-design.md`) already
specified the intended shape in its Data flow step 6 and Error handling
section — restoring a session after a daemon/device restart means a fresh
shell at the session's last-known `cwd`, marked `restored: true`, shown with
a distinct "restored after restart" pane marker (informational, not an
error). That vision was partially built (the backend mechanics and the wire
field exist) but never finished on the frontend, and in the time since,
Workspaces reshaped enough of the surrounding architecture that a few of the
original spec's assumptions no longer hold.

Auditing the current code against that original vision surfaced two classes
of gap:

1. **A real, reachable breakage**, not just missing polish. If
   `recover()`'s `PtySession::spawn` fails for a session record (its command
   no longer exists, its directory was deleted), the record is left at its
   stale pre-crash status forever — not marked `Exited`. On the next app
   launch, the frontend's reconciliation logic (`resolve_workspaces` in
   `app/src-tauri/src/session.rs`) sees this record as "valid" (status isn't
   `exited`) and tries to `Attach` to it. The daemon's `spawn_pump` then
   fails to find a live process for that id and sends a generic
   `Response::Error` with no session id attached — which the frontend
   treats as an app-wide fatal error, blanking the *entire* window, not
   just the one broken pane. And because the registry row is never
   corrected, this repeats on every future launch until someone manually
   intervenes.
2. **Missing, purely additive UI.** `SessionSummary.restored: bool` is
   already plumbed all the way through the wire protocol from the daemon's
   `recover()` call, but nothing in the frontend ever reads it. There is no
   distinct visual treatment for "this pane's shell was just freshly
   respawned" anywhere.

A closely related, longstanding gap was folded in during this brainstorm:
`create_fresh_session` (used whenever a stale/invalid session id needs full
replacement, not just the recover()-specific case above) always spawns the
replacement at `$HOME`, silently relocating a pane away from whatever
workspace directory or git repo it used to be in, with zero indication
anything happened. This is the "Attach-outcome residual" gap noted since
Milestone B's own history.

## Goals

- A single session that fails to restore never breaks anything beyond its
  own pane — the rest of the app continues working normally.
- A registry record that fails to restore self-heals: it doesn't repeat the
  same failure on every subsequent launch.
- A session that must be fully replaced (not just recovered) lands back at
  its own last-known location, not `$HOME`.
- A pane whose shell was freshly respawned after a daemon/device restart
  shows a small, informational, self-clearing marker — closing the
  originally-specified "distinct restored-after-restart" requirement that
  was never built.

## Non-goals

- **No rich inline "exited" banner UI.** There is currently no exited-pane
  treatment of any kind in this app — a session exiting (for any reason)
  silently closes its tab (`handleSessionExited` in `layoutState.ts`). This
  milestone does not change that for restore-failures either; it makes the
  *existing* behavior safely scoped to one pane instead of introducing a
  new failure mode that blanks the whole app. A richer "here's why this
  pane closed" UI is a legitimate future milestone, not this one.
- **The original spec's "workspace path missing/moved" handling is moot.**
  It assumed the pre-Workspaces data model (`Workspace: { id, name, path }`,
  one directory per workspace). The shipped Workspaces milestone made
  workspaces directory-less arbitrary groupings of pages; there is no
  single "the workspace's path" to go missing anymore. Not carried forward.
- **True PTY reattachment across a daemon restart remains impossible** — a
  physical constraint (the original process is gone), not a design choice.
  Still a fresh shell at the same `cwd`, never scrollback replay. This is
  an explicit non-goal already established in the original spec and
  unchanged here.
- **No change to `kill_session`'s pre-existing `output_buffers` leak** — a
  separate, already-documented, unrelated Milestone-A-era issue.
- **No OS notification for the restored marker.** Matches this project's
  existing precedent that only session status transitions
  (`working`/`waiting_for_input`) and nothing else trigger OS notifications.

## Architecture

### 1. `recover()` self-heals its own failure mode

**File:** `crates/daemon/src/server.rs`, `SessionManager::recover()`.

Currently, when `PtySession::spawn` fails for a registry record during
daemon startup, the `Err(e)` arm only logs and continues — the record's
`status` is left at whatever it was before the crash. Change this arm to
also call `self.registry.lock().unwrap().update_status(&record.id,
SessionStatus::Exited)` (logging, not panicking, on that call's own
failure, matching this function's existing per-record error tolerance).
This is the same status a normally-exited session already gets — no new
`SessionStatus` variant, no new downstream handling to build anywhere.

### 2. Bootstrap-time replacement uses the session's own last-known cwd

**File:** `app/src-tauri/src/session.rs`.

`list_valid_session_ids` currently discards everything from `ListSessions`
except a bare `HashSet<String>` of non-exited ids. Change it to fetch and
retain the *full*, *unfiltered* `ListSessions` response as a
`HashMap<String, SessionSummary>` keyed by id (exited records included, not
dropped) — call it `all_sessions`. `resolve_sessions` computes validity by
checking `all_sessions.get(id).is_some_and(|s| s.status != "exited")`
instead of the old set-membership check; when that's false (the session is
exited, or was never in the registry at all), it looks up
`all_sessions.get(id).map(|s| s.cwd.as_str())` for that *same* id — the
exited record is still present in `all_sessions`, just failing the
liveness check, so its own last-known `cwd` is right there — and passes
that to `create_fresh_session`. `create_fresh_session` gains a `cwd:
Option<&str>` parameter: `Some(last_known_cwd)` when the id was found (the
common case — an exited record, whether from the recover() case above or
any other cause), falling back to today's `$HOME` behavior only when the
id has no registry record at all (a defensive fallback for a genuinely
unknown id, not the common path).

### 3. Per-session Attach failures are isolated to one pane

**File:** `crates/daemon/src/server.rs`, `spawn_pump`'s `reader_for`-fails
error arm (the same arm Task 4/5 of the git-status backend plan already
touched twice for the git-status mapping leak).

Currently sends `Response::Error { message: e.to_string() }` — no session
id, so the frontend can't scope the failure. Change this to send
`Response::SessionExited { id: id.clone(), exit_code: ATTACH_FAILURE_EXIT_CODE
}` instead, where `ATTACH_FAILURE_EXIT_CODE` is a new named constant
(`-2`, distinct from the pre-existing `-1` "exit code unknown" sentinel
used elsewhere in this file, so the two "we don't have a real exit code"
cases stay distinguishable in logs/diagnostics even though the frontend
doesn't currently branch on the value). This reuses
`handleSessionExited`'s *existing* tab-closing behavior in
`layoutState.ts` verbatim — no frontend code changes needed for this part
at all. Also mark the registry record `Exited` at this same point
(`update_status`, same tolerant-logging pattern as fix #1) so this
self-heals for the *next* launch via fix #2, regardless of why this arm
was reached — this is a general defense, not narrowly scoped to the
recover()-specific cause in fix #1.

### 4. The "restored" marker

**New protocol variant**, `crates/protocol/src/lib.rs`:

```rust
Response::SessionRestored { id: String }
```

**Daemon** (`crates/daemon/src/server.rs`, `attach()`'s existing baseline
block): sent once, immediately after the existing `CwdChanged` baseline,
only when `record.restored` is `true` — mirroring the exact "silence is a
valid baseline" convention `GitStatusChanged`'s own baseline already
established (nothing sent when there's nothing to report). Do **not** gate
this on `record.status != SessionStatus::Exited` the way the
`StatusChanged`/git-status baselines are — an `Exited` record is filtered
out before `Attach` is ever attempted per fix #2/#3 above, so in practice
this case shouldn't arise, but the field itself is orthogonal to status
and gating on it would just be dead code, not a safety requirement.

**Clearing — daemon side, persisted:** in the `Request::WriteInput` handler
(`crates/daemon/src/server.rs`), issue a single conditional update —
`UPDATE sessions SET restored = 0 WHERE id = ? AND restored = 1` (a new
`Registry` method, e.g. `clear_restored`) — on every `WriteInput` call. A
`WHERE`-guarded update against an already-`0` row is a cheap no-op; this
daemon has no separate in-memory cache of registry state to check first
(the registry, behind its own `Mutex`, already is the single source of
truth), so adding one just to skip an already-trivial write would be
premature. This makes the flag persisted-and-authoritative: a session the
user already interacted with won't spuriously re-show the badge on a later
app relaunch, even without any daemon restart in between.

**Tauri relay** (`app/src-tauri/src/session.rs`, `bootstrap()`'s existing
match arm on `Response`): `Response::SessionRestored { id } => {
reader_app_handle.emit("session-restored", id); }`, mirroring every other
single-field relay arm already in that match.

**Frontend** (`app/src/lib/layoutState.ts`): a new
`restoredSessionIds: Set<string>` field on `LayoutState`. A
`"session-restored"` listener adds the incoming id to the set. Clearing is
**not** wire-driven — the frontend clears its own local copy the moment its
*own* `writeInput` action fires for that session id (it already knows
input was just sent; no need to wait on a round-trip echo from the
daemon). The daemon's own independent clearing (above) keeps the
*persisted* state correct for future bootstraps; the two clearings are
deliberately decoupled, not synchronized over the wire.

**UI**: a small badge on the pane's tab in `Pane.svelte`, present while
`$layoutState.restoredSessionIds` contains that session's id. Exact visual
treatment (icon vs. text vs. dot) is an implementation-time detail within
this project's existing compact-badge/dot visual language — not
prescribed further here, since the user has explicitly chosen to move
straight to implementation and iterate via manual testing rather than a
further design pass on this cosmetic detail.

## Testing

- **Daemon (Rust):** `recover()`'s failed-spawn arm marks the record
  `Exited` — a registry-fixture test (a record with a nonexistent command,
  `recover()` called, assert `status == Exited` afterward), extending the
  existing `recover_spawns_fresh_shells_for_leftover_registry_entries`-style
  test file. The Attach-failure-isolation path: attach to a session id with
  no live `sessions` entry, assert the client receives
  `SessionExited { id, exit_code: ATTACH_FAILURE_EXIT_CODE }` (not a bare
  `Error`), and assert the registry now shows that record `Exited`. The
  `SessionRestored` baseline: attach to a session with `restored: true`,
  assert it's the message immediately following `CwdChanged`; attach to one
  with `restored: false`, assert no `SessionRestored` is ever sent.
  `WriteInput` clearing: mark a record restored, send one `WriteInput`,
  assert the registry now shows `restored: false`.
- **App (Rust, `app/src-tauri`):** `resolve_sessions`'s replacement path
  now uses the exited session's own last-known `cwd` — a fake-daemon test
  (mirroring the existing `fake_daemon_replying_with` pattern already in
  `session.rs`'s own test module) asserting `create_fresh_session` is
  called with that `cwd`, not the hardcoded `$HOME` fallback; a second test
  covering the true-fallback case (an id genuinely absent from the
  registry entirely, not just exited) still uses `$HOME`.
- **Frontend (TypeScript):** `restoredSessionIds` set/clear logic in
  `layoutState.ts`, mirroring `handleGitStatusChanged`'s own pure-function
  test pattern from the git-status milestone — set on the
  `"session-restored"` listener's handler, cleared by the `writeInput`
  action's own local-state update.
- **GUI-only, same established limitation as every prior milestone in this
  project:** the actual rendered badge's appearance and disappearance on
  real keystrokes, and confirming a genuinely killed daemon process
  actually reproduces the whole end-to-end restore flow — none of this is
  observable in the automated verification environment.
