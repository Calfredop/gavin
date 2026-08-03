# Terminal Core — Git Status Detection — Design Spec

Date: 2026-08-03
Status: Approved

## Context

This is the git-status scope explicitly deferred out of the just-shipped
session status detection milestone
(`docs/superpowers/specs/2026-08-02-terminal-core-session-status-design.md`):
the original terminal-core spec
(`docs/superpowers/specs/2026-07-29-terminal-core-design.md`) assumed
workspaces were bound to a single directory (`Workspace: { id, name, path,
... }`) and sketched git status as a per-workspace indicator (branch, dirty
indicator, ahead/behind) refreshed on focus/timer/filesystem-watch. The
shipped Workspaces milestone made workspaces directory-less arbitrary
groupings of pages, each page holding independent panes/sessions with
independently-tracked cwds (via OSC 7,
`crates/daemon/src/osc.rs`/`cwdBySessionId` in `layoutState.ts`) — so "per
workspace" no longer has a single directory to check. This spec resolves
that scoping question and designs the feature against the current
architecture.

This is also this project's first genuinely *actively-polled* detection
mechanism. Every prior daemon-side detection (OSC 7 cwd tracking, OSC
133/BEL session status) is a passive scanner watching bytes the shell
already emits on its own — there is no escape sequence for "the working
tree just got dirty." Git status has to be actively checked.

During design, research into how cmux (this project's stated inspiration)
handles this surfaced a real, shipped bug worth learning from directly
rather than rediscovering the hard way: cmux originally polled `git status`
on a ~5-second timer, which touches `.git/index.lock` as a side effect on
every check — this broke other tools watching the same repo (dev-server
hot-reloaders) and interfered with the user's own concurrent git commands
(manaflow-ai/cmux issues #2722, #4779). cmux's own fix was to move refresh
triggering to filesystem events on git's own internal state files rather
than a blind schedule (issue #2329). This spec adopts that lesson directly
— see "Refresh triggers" below.

## Goals

- Per-session git status: branch name, a dirty/clean indicator, and
  ahead/behind counts relative to the upstream tracking branch (when one
  exists) — the same three things the original spec envisioned, now scoped
  per session instead of per workspace.
- Zero required user configuration, matching every prior milestone's
  precedent — no shell integration, no setup step.
- Refresh promptly on real repo-state changes (commits, checkouts, staging)
  without the index.lock-contention problem cmux hit.
- Sidebar surfacing that reflects reality even when a page's sessions span
  multiple different repos, rather than picking one arbitrary
  representative and hiding the rest.

## Non-goals

- `git fetch`, ever. Ahead/behind reflects whatever the local
  remote-tracking ref last recorded — exactly what running `git status`
  shows without fetching first. Staleness here is expected, matching
  ordinary git usage, not a defect.
- A simple workspace-level or session-count-style badge (e.g. "N repos with
  changes"). This was considered during design and intentionally replaced
  by the richer page/session-level design in "Frontend architecture & UI"
  below — a future reader should not wonder why there's no such badge.
- PR status, listening ports, or any other richer per-session metadata
  cmux's sidebar also shows — out of scope for this milestone.
- Any git *write* operation (commit, push, stage) from within the app —
  read-only status only.
- Remote/SSH repos — this app is local-PTY-only already (see the original
  terminal-core spec's own non-goals); git status detection inherits that
  constraint.

## Detection mechanism

**Scope: per session, deduped by repo root.** Each session shows its own
git status (its cwd may be in a different repo than a neighboring tab), but
the underlying `git status` check is computed and cached once per unique
canonical repo root — sessions that happen to share a repo share one check
rather than each running it independently.

**Repo-root resolution.** Whenever a session's cwd is established or
changes — piggybacking on the existing `OscCwdScanner` cwd-change
detection, no new PTY scanning needed — the daemon runs
`git rev-parse --show-toplevel --path-format=absolute` in that cwd. A
non-zero exit (not in any git repo) means the session maps to no repo root:
no status, no indicator, nothing further happens for it. A successful
result gives the canonical repo root the session is now associated with.

**Shared per-repo-root pollers.** The daemon maintains a map from repo root
to a single shared poller. The first session that resolves to a given repo
root spawns a poller for it; any additional session resolving to the same
root registers against the existing poller instead of spawning a second
one. When the *last* session mapped to a repo root goes away (session
closes, or its cwd moves elsewhere), that root's poller is torn down.

Each poller runs `git status --porcelain=v2 --branch` — one command that
returns branch name, upstream tracking ref, ahead/behind counts, and dirty
working-tree status together — with output parsed into a `dirty: bool`
(true if any changed, renamed, unmerged, *or untracked* entry is present —
untracked files count as dirty, matching plain `git status`'s own
"Untracked files" section), `branch: String`, `ahead`/`behind: u32`, and
`has_upstream: bool` (ahead/behind are only meaningful, and only shown,
when an upstream exists).

**Refresh triggers**, in order of how much work they do:
- **Primary — filesystem watch** on `<repo_root>/.git/HEAD`,
  `<repo_root>/.git/index`, and `<repo_root>/.git/refs` (via the `notify`
  crate), debounced so a single git operation's rapid-fire internal writes
  don't trigger multiple re-checks. This reacts to actual repo-state
  changes — commits, checkouts, staging — instead of touching
  `.git/index.lock` on a blind schedule, directly avoiding the bug cmux hit.
- **Reactive, free** — piggyback on the existing `StatusScanner`'s OSC 133
  idle detection: a session's shell reporting a fresh prompt (A/B markers)
  is a natural "worth rechecking" moment, and the signal already exists.
- **Sparse timer backstop — every 3 minutes.** A pure safety net for a
  watcher that's ever missed or silently dies; infrequent enough that it
  carries essentially none of the index.lock-contention risk a tight
  polling loop has.

**Error handling for detection itself:**
- `git` not on PATH, or any invocation failing to spawn or exiting
  non-zero for reasons other than "not a repo": treated identically to "not
  in a repo" — no indicator, no user-facing error, logged to stderr only.
  Matches this project's established silent-degradation convention (same
  story as OSC 7/133's own fallback).
- A 10-second timeout on the `git status` subprocess itself, so one
  slow or hung repo (unusual hooks, an enormous repo) can't leak a thread
  forever — it only affects that repo's own freshness, never blocks
  anything else, since each repo root already has its own independent
  poller.
- Malformed or unexpected `git status --porcelain=v2 --branch` output
  parses to "no status available" rather than panicking, matching the
  existing byte-scanners' graceful-recovery convention.
- A repo becoming unreachable mid-session (directory deleted or renamed)
  surfaces as a transition back to "no repo" on the next check, not a stuck
  stale value.
- Repo-root re-resolution is driven by the existing cwd-change tracking, so
  a session moving into, out of, or between repos migrates to the correct
  poller (or none) automatically — no separate mechanism needed.

## Daemon architecture

**New shared state**, distinct from every prior milestone's purely
per-session state: a map from canonical repo root to poller state (the
watcher handle, last-known `GitStatus`, and the set of session ids
currently mapped to it). This is the first daemon-side state in this
project that is genuinely shared across sessions rather than keyed by
session id alone.

**New protocol event**, mirroring `Response::CwdChanged`/`StatusChanged`'s
existing precedent:

```rust
Response::GitStatusChanged { id: String, status: Option<GitStatus> }

struct GitStatus {
    repo_root: String,   // serialized as repoRoot -- see wire-shape note below
    branch: String,
    dirty: bool,
    ahead: u32,
    behind: u32,
    has_upstream: bool,  // serialized as hasUpstream
}
```

`status: None` means "this session is not in a git repo" — the same
`Option`-based non-signal used nowhere else yet in this protocol (every
existing event either always has a value or is itself the absence signal),
since unlike cwd or session status, "no git repo" is a completely normal,
common, permanent state for many sessions (e.g. one parked at `$HOME`), not
a transient "not yet known" state.

`repo_root` is included specifically so the frontend can group sessions by
actual repo *identity*, not by branch name — two unrelated repos could
coincidentally both be on a branch called `main`.

**Wire-shape convention**: `GitStatus` is a new struct sent over IPC/Tauri,
so it follows the camelCase-over-the-wire convention already established
for `Workspace`/`Page` (`#[serde(rename_all = "camelCase")]`) — `repoRoot`,
`hasUpstream` on the JSON side. Workspaces Part 1's own final review found
this exact class of thing (a wire-shape contract with no coverage) as a
real gap after the fact; this milestone's plan should include a dedicated
shape test from the start rather than relying on incidental coverage.

**On a poll completing**, the result is cached against the repo root and a
`GitStatusChanged` event is sent to *every* session currently mapped to
that root, not just one. On `Attach`, a cached status (if one already
exists for that session's repo root) is sent immediately as a baseline,
mirroring `CwdChanged`/`StatusChanged`'s existing attach-time baseline
precedent; otherwise the first live update arrives once that root's poller
completes its first check.

**Not persisted.** Unlike cwd and session status, this state is fully
re-derivable from the filesystem, so a daemon restart simply starts every
repo root's polling fresh rather than reloading potentially-stale cached
git output from disk.

**Git access**: shell out to the system `git` binary
(`std::process::Command`), not a linked library (`git2`/`gix`). One clean
CLI invocation (`git status --porcelain=v2 --branch`) already returns
everything needed in one call; a native library dependency would add real
build complexity (`git2` links `libgit2`, a C library) for no capability
this app actually needs, and requiring a system `git` install is a safe
assumption for an app whose entire purpose is running terminal sessions.

## Frontend architecture & UI

**`app/src-tauri/src/session.rs`**: a new `Response::GitStatusChanged { id,
status }` match arm in `bootstrap()`'s relay loop, mirroring the existing
`CwdChanged`/`StatusChanged` arms, emitting a Tauri event
`"git-status-changed"` with payload `(id, status)` — a 2-tuple matching the
existing event shape convention, where `status` is the `GitStatus` object
(camelCase fields) or `null`.

**`app/src/lib/layoutState.ts`**: gains a new
`gitStatusById: Record<string, GitStatus | null>` map (mirroring
`sessionStatusById`'s existing shape and the same "never cleaned up on
session exit, harmless stale entry" convention), populated by a new
`"git-status-changed"` listener wired into `bootstrap()` the same way
`"session-status-changed"` already is.

**`Pane.svelte` tab**: a single compact dot, positioned alongside the
existing working/waiting-for-input status dot — filled when dirty, hollow
(outlined, not filled) when clean, absent entirely when the session has no
git repo. No branch name, no ahead/behind numbers, and no tooltip
elaboration on the tab itself — that detail lives entirely in the sidebar
(a deliberate choice made during design, see below).

**`Sidebar.svelte` page row**: for each page, group its sessions' non-null
`GitStatus` values by `repoRoot`:
- **Zero distinct repos** (no session in the page has a git repo): no git
  indicator on the page row at all.
- **Exactly one distinct repo**: that repo's branch name, dirty indicator,
  and ahead/behind are shown directly on the page row — no expansion
  needed, since every session in the page agrees.
- **Two or more distinct repos**: the page row gains an expand toggle
  (mirroring the existing workspace-row chevron pattern, one level deeper
  than today's workspace→page nesting). Expanding reveals one row per
  session in the page, each showing that session's own label plus its
  branch/dirty/ahead-behind, clickable to switch to that session — the same
  click-to-switch interaction the page row itself already has.

This is a genuine new third level of sidebar hierarchy
(workspace → page → session), but only materializes when a page's sessions
actually span multiple repos — a single-repo (or no-repo) page never grows
an expand affordance, so the common case stays exactly as simple as it is
today.

**Workspace row**: no git indicator at any level above the page row —
richer per-repo detail doesn't aggregate meaningfully up to "all pages in
this workspace," unlike a simple count would have.

## Testing

- Daemon: pure parsing tests for `git status --porcelain=v2 --branch`
  output (fixed sample text in, expected `GitStatus` fields out), matching
  the existing byte-scanner test style (`osc.rs`, `status.rs`). Additionally
  — a genuinely new pattern for this project — integration tests against a
  *real* temporary git repository (via `tempfile` plus shelling to
  `git init`/`git commit`/etc., the same fixture pattern the daemon's
  existing tests already use for PTY sessions) verifying end-to-end
  behavior: a clean repo, a dirty one, ahead/behind after configuring a
  fake local upstream. A dedicated camelCase wire-shape roundtrip test for
  `GitStatus`, per the note above.
- Frontend: the repo-root grouping logic (zero/one/multiple distinct repos
  per page) is real business logic, not template rendering — extracted as
  a pure, independently-tested function, unlike the previous milestone's
  UI-only tasks (which had no dedicated tests since they were pure
  rendering with no branching logic of their own).
- Same GUI-only caveat as every prior milestone: actual dot rendering,
  sidebar expand/collapse interaction, and real git output display need
  manual verification — no synthetic input/notification observation
  available in the automated verification environment.
