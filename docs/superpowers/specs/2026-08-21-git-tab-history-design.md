# Git Tab — History Graph (SP4) — Design Spec

Sub-project **4 of 4** of the Git tab. Decisions G15–G16 in
`docs/superpowers/brainstorms/2026-08-20-git-tab-brainstorm.md`; SP1–SP3
specs define the runner, store, components and conventions reused here.

**Goal:** Fork's "All Commits": a colored-lane commit graph over all
branches, a commit detail pane with its files and read-only diffs, and the
usual commit actions (checkout, branch here, copy, cherry-pick, revert,
reset).

**Out of scope:** interactive rebase, commit search across unloaded pages,
tags management, GPG status, file history / blame.

---

## 1. Backend (`app/src-tauri/src/git/`)

### 1.1 Log

`git_log(cwd, all, skip, limit) -> LogPage { commits: Vec<CommitInfo>, has_more }`

```
git log --date=iso-strict --topo-order [--all] --skip=<skip> --max-count=<limit+1>
        --format=%H%x00%P%x00%an%x00%ae%x00%ad%x00%s%x00%D%x1e
```
Records are `\x1e`-separated, fields `\x00`-separated. `has_more` = more than
`limit` records came back (the extra one is dropped). An unborn HEAD without
`--all` → empty page, not an error (`git log` exits 128 with "does not have
any commits yet"; matched and mapped to empty).

```ts
interface RefLabel { name: string; kind: "head" | "local" | "remote" | "tag" | "stash" }
interface CommitInfo { sha: string; parents: string[]; author: string; email: string; date: string; subject: string; refs: RefLabel[]; isHead: boolean }
```

`parse_decorations("HEAD -> main, origin/main, tag: v1, refs/stash")` →
`isHead = true` when `HEAD` appears (either `HEAD -> x` or bare `HEAD` when
detached); `HEAD -> main` yields `main` as local; `tag: v1` → tag; names
containing `/` whose first segment is a known remote → remote (the parser
takes the remote names as an argument); `refs/stash` → stash; else local.

### 1.2 Commit detail + revision diffs

`git_commit_detail(cwd, sha) -> CommitDetail { body, files: FileEntry[] }`:
`show -s --format=%B <sha>` and `diff-tree --root --no-commit-id
--name-status -r -M <sha>` (the `--root` flag makes root commits list their
files; it is harmless otherwise). Name-status parsing reuses the
SP2 stash-files parser (extracted as `parse_name_status`).

`git_diff` gains `rev: Option<String>`: when set, the diff is
`diff --no-color --no-ext-diff -U3 -M <rev>^ <rev> -- <old?> <path>`; for a
root commit (`rev-parse --verify -q <rev>^` fails) the base is the empty
tree `4b825dc642cb6eb9a060e54bf8d69288fbee4904`. Binary/too-large handling
and parsing are unchanged.

### 1.3 Actions

| Command | git |
|---|---|
| `git_checkout_commit(cwd, sha)` | `switch --detach <sha>` |
| `git_cherry_pick(cwd, sha)` | `cherry-pick <sha>` |
| `git_revert(cwd, sha)` | `revert --no-edit <sha>` |
| `git_reset(cwd, sha, mode)` | `reset --soft|--mixed|--hard <sha>` |

`repo_info.in_progress` additionally reports `"cherry-pick"`
(`CHERRY_PICK_HEAD`) and `"revert"` (`REVERT_HEAD`). `abort_in_progress`
accepts them (`cherry-pick --abort` / `revert --abort`) and a new
`git_continue_in_progress(cwd, kind)` runs `<kind> --continue` with
`GIT_EDITOR=true` for rebase, cherry-pick and revert (the SP2
`git_continue_rebase` becomes a call into it).

## 2. Lane model (`graphLanes.ts`, pure)

Input: topo-ordered `CommitInfo[]`. Output: `GraphRow[]` aligned 1:1.

```ts
interface GraphRow {
  lane: number;                 // the commit's column
  color: number;                // lane colour index (0..7)
  lanes: number;                // active lane count on this row (for width)
  passes: number[];             // lanes that run straight through this row
  links: { from: number; to: number; color: number }[];   // curves leaving this row downward
}
```

Algorithm: `active: (sha | null)[]` — the SHA each lane is waiting for.
For commit `c`:
1. `lane` = index of the first active slot holding `c.sha`; if none, append
   a new slot. Every other slot also holding `c.sha` closes (merge targets
   converging) and produces a link `{ from: thatLane, to: lane }` drawn on
   the previous rows' continuation (represented as an incoming link).
2. Parents: the first parent takes over `lane` (`active[lane] = p0`); each
   further parent `pi` reuses a slot already waiting for `pi` if one
   exists, else takes the first free (`null`) slot, else appends — and
   emits `links.push({ from: lane, to: thatSlot })`.
3. No parents: `active[lane] = null`.
4. `passes` = slots that are non-null and not `lane` and not touched by a
   link this row. Trailing `null` slots are trimmed so `lanes` shrinks back.

Colours: `color = lane % 8`. Rendering: one `<svg>` per row, 14 px per
lane, 22 px tall; passes are vertical lines, links are cubic curves from
`(from, mid)` to `(to, bottom)`, the commit is a 4 px-radius dot (hollow
when `isHead`). Lanes beyond 12 are clamped to column 12.

## 3. Frontend

### 3.1 Store

`navSelection` gains `"commits"`. New `GitViewState` fields:
```ts
log: { commits: CommitInfo[]; hasMore: boolean; all: boolean } | null;
logLoading: boolean;
logFilter: string;
selectedCommit: string | null;
commitDetail: CommitDetail | null;
detailFile: string | null;
detailDiff: FileDiff | null;
```
Actions: `selectCommits(ws)` (sets nav + `loadLog(ws, true)`),
`loadLog(ws, reset)` (page 0 with `all` from `gitView.graphAll ?? true`),
`loadMore(ws)`, `setGraphAll(ws, all)` (persists, reloads),
`setLogFilter(ws, text)`, `selectCommit(ws, sha)` (loads detail; picks the
first file; loads its diff), `selectDetailFile(ws, path)`. `refresh()`
reloads page 0 when `navSelection === "commits"` and keeps `selectedCommit`
if still present. Token guards as elsewhere.

Actions through `run()`: `checkoutCommit`, `cherryPick`, `revertCommit`,
`resetTo(sha, mode)`, `continueInProgress(kind)`; `abortInProgress` accepts
the new kinds.

### 3.2 Components

- **`GitGraph.svelte`** (middle column when `navSelection === "commits"`):
  header — *All branches / Current branch* toggle, filter input, count;
  list of rows (`GitGraphRow.svelte`: SVG cell + ref chips + subject +
  author + relative date); click selects; ↑/↓ move; right-click / ⋯ opens
  the context menu (`ContextMenu.svelte`); **Load more** footer.
  Filter is client-side: subject, author, email, SHA prefix; the graph is
  still drawn for the full list (filtered-out rows are hidden, lanes stay
  consistent because rows are 1:1 with the full list and we just skip
  rendering rows that don't match — with a note "n of m commits shown").
- **`GitCommitDetail.svelte`** (diff column): header (short SHA → copy,
  author, date, chips), message, file list (read-only `GitFileRow`,
  selected highlight), then `GitDiffUnified`/`GitDiffSplit` with
  `canAct={false}` and an empty selection.
- **`GitResetDialog.svelte`**: Soft / Mixed / Hard radios with one-line
  explanations; Hard shows a text field that must equal the short SHA.
- Context menu entries: Checkout (detached) · New branch here… · Copy SHA ·
  Copy message · Cherry-pick onto `<branch>` · Revert… · Reset `<branch>` to
  here… (last two disabled on detached HEAD; all disabled while busy/op).
- Banner: the in-progress kinds cherry-pick/revert get *Abort cherry-pick* /
  *Abort revert* and **Continue** (disabled while conflicts remain).

### 3.3 Prefs

`gitView.graphAll?: boolean` (default true).

## 4. Edge cases

| Case | Behaviour |
|---|---|
| Unborn HEAD | graph empty state "No commits yet" |
| Detached HEAD | HEAD chip shows `HEAD` alone; cherry-pick allowed, revert/reset disabled |
| > 12 lanes | clamped column; still correct links |
| Filter hides the selected commit | selection kept; detail stays |
| Commit vanished after a reset/rebase | `selectedCommit` cleared, detail emptied |
| Octopus merge | extra parents each get a link; lanes grow |
| Cherry-pick/revert conflict | banner kind + Abort/Continue |

## 5. Testing

- Rust: `parse_decorations` (head/local/remote/tag/stash, detached HEAD,
  empty), `parse_log` (merge commit parents, subjects with NULs impossible
  but with commas/quotes), `log` on a temp repo with a branch + tag + merge
  (`has_more` paging), `commit_detail` on root and merge commits, `diff`
  revision mode (root commit vs empty tree), cherry-pick conflict → kind →
  abort, revert ok, reset soft/mixed/hard effects.
- Vitest: `graphLanes` on linear, fork+merge, octopus, two roots; filter
  matcher; store: `selectCommits` loads page 0, `loadMore` appends, refresh
  keeps selection, reset-mode guard.
- Smoke: "Git tab — history" (graph draws the workspace repo's branches,
  chips, click detail + file diff, cherry-pick conflict → abort, reset hard
  requires the SHA, load more).
