# Agent Orchestration Foundations — Design Spec

Sub-project **1 of 6** of the agent-orchestration phase. Phase context, all decisions
(D1–D13), and the approved build order live in
`docs/superpowers/brainstorms/2026-08-06-agent-orchestration-brainstorm.md`.

**Goal:** bind workspaces to root directories, define the `.gavin-root`/`.gavin`
on-disk convention, and give the daemon a scanner + watcher that keeps a live,
event-pushed picture of every gavin context and plan file under each bound root.

**Explicitly out of scope here** (later sub-projects): board projection and status
write-back *wiring* (sub-2 — though the file model including the surgical status
writer ships here), the MCP server (sub-3), CodeMirror editing (sub-4), the plan
explorer (sub-5), the orchestration home (sub-6). The hub UI in this sub-project is
limited to the root-binding banner/header affordances.

---

## 1. The on-disk convention

A folder becomes a **gavin context** by containing a `.gavin/` directory; the
workspace root's context uses `.gavin-root/` instead. A directory holds one or the
other, never both (see edge rules below).

```
<workspace root>/
  .gavin-root/
    config.toml        # version + agent profile (see below)
    PRD.md             # scaffolded from template; the development lead document
    plans/             # plan .md files (frontmatter carries status)
    docs/
    specs/
  auth/                # any folder under root can become a context
    .gavin/
      config.toml      # minimal: display name
      plans/  docs/  specs/
```

`plans/`, `docs/`, `specs/` are scaffolded with a `.gitkeep` each so the structure
survives git before real files exist.

### config.toml

Root (`.gavin-root/config.toml`):

```toml
version = 1

[agent]
profile = "claude-code"
```

Context (`.gavin/config.toml`):

```toml
name = "auth"     # display name; omitted/unparseable → folder name
```

`version` is for future migrations; `[agent].profile` is the D4 agent-profile seam
(only `"claude-code"` exists in v1). No other fields — YAGNI. Parsing uses the
standard `toml` crate — a **new daemon dependency** (small, std in the Rust
ecosystem; the line-oriented economy applied to frontmatter is not needed here
because config.toml is never surgically rewritten).

### PRD template

`InitGavinRoot` writes this verbatim (workspace-name substitution only):

```markdown
# {workspace name} — Product Requirements

> This PRD is the lead document for development in this workspace. The main agent
> session reads it first; plans in `.gavin*/plans/` should trace back to it.

## Vision

_What are we building, for whom, and why?_

## Current focus

_The active goals, roughly ordered._

## Out of scope

_Explicit non-goals._
```

### Plan file format

A plan is a markdown file in a context's `plans/` with an optional YAML-style
frontmatter block:

```markdown
---
status: In Progress      # matches a board column by name (D6); missing → first column
priority: high           # optional; none|low|medium|high|urgent (case-insensitive)
title: Auth flow rework  # optional; falls back to the filename stem
---
# Auth flow rework
…free-form markdown body…
```

**Parsing is line-oriented and dependency-free** (`serde_yaml` is deprecated; nested
YAML is out of scope in v1):

- Frontmatter exists iff the file's **first line is exactly `---`**; it runs until
  the next line that is exactly `---`. No opening marker → no frontmatter, no
  warning, `status: None`.
- An opening marker with no closing marker before EOF → `parse_warning: true`,
  `status: None`.
- Recognized lines are flat `key: value` (split on the first `:`; key must match
  `[A-Za-z0-9_-]+` after trimming; value trimmed, one pair of surrounding single or
  double quotes stripped). Unrecognized lines inside the block (comments, nested
  structures) are **preserved verbatim and ignored** — not a warning.
- `status`: any non-empty string. `priority`: case-insensitive match against the
  existing `Priority` vocabulary; a non-matching value → `None` **plus**
  `parse_warning: true`. `title`: any non-empty string.
- Unknown keys are never dropped, reordered, or rewritten.

### Surgical status write-back (model ships here, wiring ships in sub-2)

`write_plan_status(path, new_status)` rewrites **only the `status:` line**:

- Existing `status:` line → its value is replaced in place.
- Frontmatter exists but no `status:` line → `status: <v>` inserted as the first
  line inside the block.
- No frontmatter at all → a new `---\nstatus: <v>\n---\n` block is prepended.
- **Every other byte of the file is preserved identically** — guaranteed by test.

### Edge rules

- `.gavin-root` is recognized **only directly under the bound root**; one found
  deeper is ignored (logged, not surfaced).
- A `.gavin` directly at the root is treated as an ordinary context (harmless; the
  scaffolder never creates this).
- If a folder somehow contains both, `.gavin-root` wins at root; `.gavin` wins
  elsewhere; the loser is ignored.

---

## 2. Workspace ⇄ root binding

### Schema

- TS (`workspace.ts`): `Workspace` gains `rootPath?: string`.
- Rust (`app/src-tauri/src/config.rs`): the persisted `Workspace` struct gains
  `#[serde(default)] pub root_path: Option<String>` — an existing `config.json`
  deserializes as `None`; no migration.
- The Unfiled pseudo-workspace is exempt: no UI ever offers it a root.
- Exactly one root per workspace; the root is a directory path, stored verbatim.

### UI flow (hub-level, pre-home)

Workspace creation is unchanged (inline name input). The affordances live in the
hub area (adopted by the orchestration home in sub-6):

- **No root set** → a slim banner above the hub view: “No root folder set ·
  **Set root…**”. The button opens the native directory picker
  (`@tauri-apps/plugin-dialog` `open({ directory: true })` — the plugin is already a
  dependency; the capability grant must be verified against the generated ACL
  manifest, per this project's twice-learned lesson).
- After picking:
  - `<root>/.gavin-root/` **absent** → confirm modal (existing `Modal.svelte`
    pattern): “Initialize gavin in this folder?” → `InitGavinRoot`.
  - **present** → bind silently; nothing is written.
  - Either way the workspace persists `rootPath` and the app sends
    `WatchGavinRoot`.
- **Root set** → the hub header shows it compactly (`~/Coding/gavin ⚙`); ⚙ re-opens
  the picker. Re-binding is pure config — nothing on disk is deleted or moved.
- **Root missing at runtime** (unmounted volume, moved folder) → the banner returns,
  naming the stale path (“Root not found: /Volumes/… · Re-pick”). The config value
  is **never auto-cleared** — a remounted drive heals without user action.

---

## 3. Architecture: the daemon owns the `.gavin` domain

Scanning, watching, scaffolding — and later status write-back wiring (sub-2) and the
MCP server (sub-3) — all live in `gavin-daemon`. Rationale: the merged board is
served by the daemon (`get_board` lives there and must merge SQLite cards + plan
projections in one place), the MCP server is daemon-hosted and needs the same
picture, and the daemon already carries `notify` + `notify-debouncer-mini` plus the
`RepoPoller` lessons. Scan state is **never persisted** — fully re-derivable from
disk, exactly like git status.

New module: `crates/daemon/src/gavin.rs` — one scanner instance per registered
root, owned by the server the way `repo_pollers` are.

### Protocol additions (`crates/protocol`)

All frontend-crossing shapes are `#[serde(rename_all = "camelCase")]` with a
shape-assertion test (the `GitStatus` precedent).

```rust
pub struct PlanFileInfo {
    pub path: String,          // absolute
    pub file_name: String,     // "auth-flow.md"
    pub title: String,         // frontmatter title, else filename stem
    pub status: Option<String>,
    pub priority: Option<Priority>,
    pub parse_warning: bool,
}
pub struct MdFileInfo { pub path: String, pub rel_path: String }  // rel to plans|docs|specs dir
pub enum GavinContextKind { Root, Context }
pub struct GavinContext {
    pub folder_path: String,   // the folder containing .gavin*/
    pub kind: GavinContextKind,
    pub name: String,          // config name → folder name fallback; root: root folder name
    pub plans: Vec<PlanFileInfo>,
    pub docs: Vec<MdFileInfo>,
    pub specs: Vec<MdFileInfo>,
    pub has_prd: bool,         // meaningful for Root only
    pub config_warning: bool,  // config.toml present but unparseable
}
pub struct GavinTree {
    pub root_path: String,
    pub root_missing: bool,
    pub contexts: Vec<GavinContext>,  // root context first, then sorted by folder_path
}
```

Requests:

- `WatchGavinRoot { workspace_id, root_path }` — idempotent; performs an initial
  scan, starts the watcher, replies with the typed tree response.
- `UnwatchGavinRoot { workspace_id }` — tears down the watcher; replies `Ok`.
- `GetGavinTree { workspace_id }` — fresh scan, typed tree reply.
- `InitGavinRoot { root_path }` — scaffolds `.gavin-root` (§1); replies `Ok`.
- `CreateGavinContext { parent_folder }` — scaffolds `.gavin` (§1); replies `Ok`.

Responses: a typed reply variant `GavinTreeSnapshot { workspace_id, tree: GavinTree }`
(the `Board` precedent), and the push event
`GavinTreeChanged { workspace_id, tree: GavinTree }`. Failures use the existing
`Error { message }`.

Tauri side (`session.rs` + `backend.ts`): commands mirroring the five requests, and
a one-line relay arm emitting `gavin-tree-changed` (the established pattern).

### Scan algorithm

Walk from the root looking for `.gavin-root`/`.gavin` directories:

- **Exclusions** (directory names, exact match): `.git`, `node_modules`, `target`,
  `dist`, `build`, `.venv`, `venv`, `__pycache__`, plus every dot-directory except
  `.gavin` and `.gavin-root`. Full `.gitignore` semantics: explicitly out of scope
  in v1.
- **Depth cap**: 12 levels below the root.
- The walker **never descends into `.gavin*` directories themselves** — their
  contents are listed via the §1 structure, not scanned for nested contexts.
- Within a context, `plans/`, `docs/`, `specs/` are listed **recursively**, `.md`
  files only, as paths relative to that subfolder. Plan files additionally get
  frontmatter parsed into `PlanFileInfo`.

### Watcher

One **recursive watch on the root** (the `RepoPoller` precedent), debounced 500 ms,
with two hard-learned properties designed in from day one:

- a **minimum-rescan-interval floor** (2 s — sleep out the remainder, never skip),
  so sustained working-tree churn (builds, installs) can't drive continuous
  rescans; and
- **change-gated emission**: `GavinTreeChanged` fires only when the freshly scanned
  tree differs from the previous one (`PartialEq` on `GavinTree`).

Events are pre-filtered before scheduling a rescan: a path containing a `.gavin` /
`.gavin-root` segment, or a create/remove of a directory by those names. Everything
else is ignored. A rescan is always a full re-walk of that root (incremental
per-context scanning is YAGNI at v1 scale).

If the root path is missing at scan time, the scanner emits a tree with
`root_missing: true` and empty contexts, keeps the registration, and recovers on a
later successful scan.

### Frontend state

New `app/src/lib/gavinState.ts` (svelte/store pattern, like `layoutState.ts`):

- `gavinTreeByWorkspaceId: Record<string, GavinTree>`, fed by a
  `gavin-tree-changed` listener and by `WatchGavinRoot`'s reply.
- **The `gavin-tree-changed` listener must be registered before the first
  `watchGavinRoot` is sent** — Tauri events emitted with no listener are lost, not
  buffered (the Milestone B race class, twice burned in this codebase).
- Bootstrap: after workspaces hydrate, send `watchGavinRoot` for **every workspace
  with a `rootPath`** (and only those).
- `setWorkspaceRoot(workspaceId, rootPath)` orchestration action: updates the
  workspace, persists via the existing workspace-persistence path, sends
  `watchGavinRoot`; `clearWatch`/rebind sends `unwatchGavinRoot` first when the
  root actually changed.

---

## 4. Error handling

- **Broken frontmatter** never fails a scan and never drops the file: the plan
  appears with `status: None` and `parse_warning: true` (sub-2 renders the warning;
  agents writing bad YAML cannot crash the board).
- **Unparseable `config.toml`**: context still appears (folder-name fallback) with
  `config_warning: true`.
- **Root vanishes mid-session**: `GavinTreeChanged` with `root_missing: true`;
  registration kept; §2's banner shows the stale path; heals on reappearance.
- **Scaffolding is idempotent and never overwrites.** `InitGavinRoot` /
  `CreateGavinContext` create whatever's missing and refuse to touch existing files
  (especially an existing `PRD.md`). Init on a partial skeleton completes it; on a
  complete one it's a no-op `Ok`. No rollback needed — a partial scaffold is inert
  and re-running heals it. Real failures (permissions) reply `Error` naming the
  failed path.
- **Watch setup failure** (fd limits): degrade to manual refresh — the initial scan
  and `GetGavinTree` still work; failure is logged, never fatal.

## 5. Testing

Conventions: tempdir-based Rust unit tests; socket-level daemon integration tests
(deadline-style, like kanban/git-status); mocked-backend Vitest for frontend logic;
**no Svelte component tests** (codebase-wide convention).

- **Unit (daemon)**: frontmatter parser (extraction; unknown-key preservation;
  unterminated block → warning; no-frontmatter file; invalid priority → warning);
  `write_plan_status` byte-preservation (only the `status:` line differs, all three
  insertion cases); walker on tempdir fixtures (finds root + nested contexts,
  honors exclusions and depth cap, deep `.gavin-root` ignored, both-markers edge);
  scaffolding (creates all pieces, never overwrites, completes partials);
  config.toml parse + fallbacks.
- **Integration (daemon)**: `WatchGavinRoot` → snapshot reply; touch a plan file →
  debounce-aware `GavinTreeChanged` arrives; unchanged rescan emits nothing;
  `UnwatchGavinRoot` stops events; missing root → `root_missing: true`.
- **Frontend (Vitest, mocked backend)**: bootstrap registers rooted workspaces only;
  tree lands in per-workspace state; `setWorkspaceRoot` persists + watches (+
  unwatches on rebind).
- **Manual GUI smoke** (rendered UI is human-verified in this project): set root on
  this repo, initialize, verify scaffold on disk; banner ↔ header states; stale
  root path shown when the folder is renamed away and heals when renamed back.
- **Capability check**: the dialog plugin's directory-open permission verified
  against `gen/schemas/acl-manifests.json` **before** wiring UI (twice-learned
  lesson).

## 6. What later sub-projects consume from this one

- **Sub-2 (plans ⇄ kanban)**: `GavinTree`/`PlanFileInfo` as the projection source;
  `write_plan_status` for drag write-back; `parse_warning` for warning badges.
- **Sub-3 (MCP)**: `InitGavinRoot`/`CreateGavinContext`/scan functions reused as
  tool implementations; the agent profile field from root config.
- **Sub-5 (plan explorer)**: the recursive `docs/`/`specs/`/`plans/` md listings.
- **Sub-6 (home)**: `has_prd` + `root_missing` for tile/banner states.
