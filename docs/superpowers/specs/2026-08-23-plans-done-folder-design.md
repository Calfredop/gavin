# Plans — Archive Done cards into `plans/done/` — Design Spec

**Goal:** stop finished work from clogging `.gavin*/plans/`. An agent that
greps or lists the plans folder today wades through every card the workspace
has ever finished — 30 of this repo's 44. A plan card whose status reaches
Done moves into `plans/done/`; everything else stays flat, exactly where it is
now.

**Out of scope:** a folder per status (rejected — every status change would
move a file, and column renames would strand folders); user-configurable
archive statuses; folders under `docs/` or `specs/`; any change to how status
itself is stored or how the board reads it.

---

## 1. The rule

A plan file lives at

```
<context>/.gavin*/plans/<name>.md          status is anything but Done
<context>/.gavin*/plans/done/<name>.md     status slugs to "done"
```

The rule is deliberately narrow: it moves a file **only** between `plans/`
and its `done/` child. A plan someone filed under `plans/roadmap/` by hand is
scanned (`list_md_files` already recurses) and left exactly where its author
put it — a status write must never flatten somebody's own hierarchy.

**Status frontmatter stays the single source of truth.** The folder is
derived from it; nothing ever reads the folder to decide a card's status. A
file a human drags into `done/` by hand keeps whatever status it had, still
appears in that column, and gets relocated the next time its status is
written. That asymmetry is deliberate: a scan that inferred status from the
path would make two sources of truth disagree the first time someone used
Finder.

"Done" is matched by the same slug rule the board uses (`slugStatus` /
`column_slug`): `Done`, `done`, `DONE` all count; `Shipped` and `Cancelled`
do not. Done is one of the three permanent columns, so this needs no
configuration and cannot be renamed out from under the rule.

### Nested children travel with their parent

A task with `parent: <plan>.md` and no status is *nested* — it has no card of
its own, it renders inside its parent's card, and `cardDelete.ts` already
deletes it along with its parent ("they have no status and travel with their
parent"). Archiving follows the same rule: when a plan moves into `done/`,
every task in the same context whose `parent` is that plan's file name and
whose status is absent moves with it. When the plan comes back out, they
come back out. A done plan must not leave its children scattered across the
active folder — that is exactly the clutter this card exists to remove.

Children are found by scanning the context's `plans/` tree and parsing
frontmatter — the same read `scan_root` already does — not by any index.

### Collisions

If the destination path is already taken, the file stays where it is and the
status write still lands. Two plan files sharing a `fileName` inside one
context already break `parent:` resolution (it keys on
`(contextFolder, fileName)`), so a collision is a pre-existing anomaly to
surface, not one to paper over with a `-2` suffix that would then be wrong
when the card comes back out of `done/`. The daemon logs it; the card model
stays consistent.

---

## 2. Daemon

`crates/daemon/src/gavin.rs` owns the rule. Two new functions:

```rust
/// Where a plan file with this status belongs. `plans/done/<name>.md`
/// when the status slugs to "done", `plans/<name>.md` otherwise.
fn archived_path_for(path: &Path, status: Option<&str>) -> Option<PathBuf>;

/// Relocates a plan file (and its nested children) to match its status.
/// Returns the file's path afterwards -- unchanged when no move was
/// needed or a collision blocked it.
pub fn relocate_for_status(path: &Path) -> anyhow::Result<PathBuf>;
```

Callers:

- **`set_plan_field`** — after writing the field, call `relocate_for_status`
  and return the resulting path. Only a `status` write can change it, but
  running it unconditionally keeps a hand-misplaced file self-healing on any
  frontmatter write. Signature becomes
  `pub fn set_plan_field(..) -> anyhow::Result<PathBuf>`.
- **`create_plan_file`** — a card created with `status: Done` is written into
  `done/` directly rather than created flat and immediately moved.
- **`promote_checklist_item`** — its `plans_dir` derivation requires
  `plan_path.parent()` to be named `plans`, which every archived plan fails.
  It walks up instead: parent, or grandparent when the parent is `done/`.
  The promoted task is created **beside the plan it came from** — it is a
  nested child, and nested children live where their parent lives (§1), so
  creating it in `plans/` root would only relocate it on its next write.
  Its collision suffix (`-2`) is checked against the whole `plans/` tree
  rather than one folder, since `parent:` resolution keys on `fileName`
  across the context.
- **`delete_card_file`** — already walks ancestors looking for a
  `plans|docs|specs` directory under a `.gavin*`, so `plans/done/x.md`
  passes unchanged. No edit; a test pins it.

`scan_root` needs no change at all: `list_md_files` already walks `plans/`
recursively, and `.gavin*` directories are already watched **recursively**
(`watch_targets`), so `done/` is covered by the existing fs-sync machinery.

### Path re-keying

A move invalidates two persisted path keys:

- `card_sessions.path` (kanban.sqlite) — a card's live agent binding
- `orch_steps.card_path` (orchestration.sqlite) — a rail step's card

Both get a `rename_card_path(old, new)` on their store, and the move
therefore belongs to `Manager` (`server.rs`), not to `gavin::set_plan_field`
directly — the same shape as `Manager::delete_card_file`, which already
calls `gavin::delete_card_file` then `unlink_card_session_all`.

**No SQLite schema migration is required.** Both are plain `UPDATE`s on
existing columns, and nothing else in either database stores a plan path.

---

## 3. Protocol

`Request::SetPlanFrontmatterField` answers with the file's path after the
write instead of `Response::Ok`:

```rust
Response::PlanFieldSet { path: String }
```

That is a wire-breaking change: `PROTOCOL_VERSION` 9 → 10. The app and
gavin-mcp both probe it at connect and already turn a mismatch into
"restart the daemon".

`gavin-mcp`'s `gavin_set_plan_field` reports the path back to the agent when
it changed ("moved to plans/done/x.md"), so an agent that just marked its own
plan Done knows where the file went.

---

## 4. Frontend

The tree rescan heals most of the UI for free — cards are re-projected from
the new tree and a moved card simply reappears with a new `id`. Three places
hold a path as identity across the write and do not heal:

**The card detail modal.** `KanbanBoard`, `BoardPane` and
`OrchestrationHubView` each keep `openPlanPath` and resolve the card with
`allCards.find(p => p.id === openPlanPath)`. Setting a card to Done from
inside the modal moves the file, the find misses, and the modal vanishes
mid-interaction. `CardDetailModal` gains an `onPathChange(path)` prop that
fires when a field write returns a different path; each host updates its
`openPlanPath`. `gavinState.ts` gains `patchPlanPath(workspaceId, old, new)`
so the optimistic projection keeps identity in the ~3s before the rescan
lands (fs-sync's debounce + rescan floor).

**Run flows.** `runCard` and `sendToMainAgent` compose the agent's prompt
from `card.id` and only then write In Progress. Running a card that sits in
`done/` therefore hands the agent a path that is about to move. Both write
the status first and compose from the returned path. The failure ordering is
no worse: "status set but agent didn't start" was already reachable in the
opposite order, and both error strings already say which half happened.

**The plan explorer.** `buildExplorerTree` flattens every plan into one
`plans` group. Files whose path sits under `plans/done/` are collected into a
single collapsed **Done** child node instead of 30 sibling rows — otherwise
the tab that shows plans is exactly as cluttered as before.

Everything else keys off the tree: `planBoard`'s parent resolution is
`(contextFolder, fileName)`, so nesting survives a move untouched.

---

## 5. Migration

Once the behaviour is in, this repo's own Done plan cards move into
`.gavin-root/plans/done/` in a separate, reviewable commit (`git mv`, no
content edits). Card files are the only thing that moves; a stale
`orch_steps.card_path` for an archived card in a local database heals the
next time that card's status is written, and points at a Done card in the
meantime.

---

## 6. Testing

**Rust** (`gavin.rs` unit tests, temp dirs, the existing style):

- status → Done moves the file into `plans/done/`, creating the folder
- status → To Do moves it back out of `done/`
- a status that is not Done (`Shipped`) never moves anything
- nested children (parent + no status) travel in both directions; a child
  that has its own status does not
- a collision leaves the file in place and still writes the status
- `create_plan_file(status = "Done")` writes into `done/`
- `promote_checklist_item` works from a plan inside `done/`, creating the
  task in `plans/` root and rewriting the link line
- `delete_card_file` accepts `plans/done/x.md`

**Rust** (`server.rs` / store tests): a move re-keys `card_sessions.path`
and `orch_steps.card_path`.

**Vitest:** `patchPlanPath` moves a plan's identity in the projection;
`buildExplorerTree` groups `done/` files into one Done node and leaves flat
plans alone.

**Smoke:** drag a card to Done → the file appears under `plans/done/` in the
Plans tab; drag it back → it returns. Do it with the detail modal open and
confirm the modal stays open on the same card.
