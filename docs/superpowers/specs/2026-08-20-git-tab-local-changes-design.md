# Git Tab — Local Changes (sub-project 1 of 3) — Design Spec

Sub-project **1 of 3** of the Git tab ("à la Fork"). Decisions G1–G9 live in
`docs/superpowers/brainstorms/2026-08-20-git-tab-brainstorm.md`; hub-level
decisions D11/D33 (`2026-08-06-agent-orchestration-brainstorm.md`) govern the
tab row and front door.

**Goal:** a Git tab in the workspace hub whose Local Changes screen lets the
human review what agents changed, stage it at file / hunk / line granularity
in a unified or side-by-side diff, discard what they reject, and commit (or
amend) — refreshing live as the working tree changes.

**Out of scope (later sub-projects):** fetch/pull/push, remotes, branch
list/checkout, stashes (SP2); worktree switcher, agent forks, merge-back
(SP3); commit graph / history (SP4). Also out: syntax highlighting in diffs,
tree view of changed files, merge/rebase abort/continue buttons, keyboard
shortcut for discard, diff whitespace options.

---

## 1. The tab and its layout

### Registration

`HUB_VIEWS` (`app/src/lib/workspaceViews.ts`) gains, directly after `home`:

```ts
{ id: "git", label: "Git", icon: GitBranch, component: GitHubView, requiresRoot: true }
```

`HomeHubView` gets a fifth tile — **Git** · *"N changes"* (or *"not a
repository"*) — clicking through to the tab; its count comes from the same
`gitStore` the tab uses, so tile and tab cannot disagree. The tiles grid
becomes `repeat(5, 1fr)`.

### Empty states

- Root is not a git repository → centered message *"Not a git repository"*
  with an **Initialize repository** button (`git init`). After init the
  watcher starts and the view loads normally.
- `git` not on PATH → full-view error *"git was not found on PATH"* with the
  install hint; no retry loop (tab activation re-checks).

### Three-pane layout

```
┌ toolbar: [repo name] [⎇ branch]                           [↻ Refresh] ┐
├───────────┬──────────────────────────────┬─────────────────────────────┤
│ NAV       │ UNSTAGED (3)     [Stage all] │ src/lib/foo.ts  [Unified|Split]│
│ ● Local   │  M  src/lib/foo.ts           │ @@ -10,6 +10,8 @@ [Stage][Discard]│
│   Changes │  ?  src/lib/bar.ts           │   10  10   const a = 1;        │
│   (5)     │  D  old.md                   │   11     -  const b = 2;       │
│           ├──────────────────────────────┤       11 +  const b = 3;       │
│           │ STAGED (2)     [Unstage all] │ …                              │
│           │  A  new.ts                   │                                │
│           │  M  README.md                │                                │
│           ├──────────────────────────────┤                                │
│           │ Summary ____________________ │                                │
│           │ Description                  │                                │
│           │ ☐ Amend        [Commit (2)]  │                                │
└───────────┴──────────────────────────────┴─────────────────────────────┘
```

**Toolbar.** Repo name (basename of the toplevel), branch label, Refresh.
Branch label variants: `⎇ main`; `⎇ main (no commits)` on an unborn HEAD;
`abc1234 · detached` on a detached HEAD. SP2 adds Fetch/Pull/Push here.

**Nav column** (`GitNav.svelte`, fixed 160 px). A vertical list with a
single entry in SP1 — *Local Changes* with the total changed-file count
(unstaged ∪ staged by path). It is a real component so SP2/SP3 append
sections (Branches, Remotes, Stashes, Worktrees) without restructuring.

**Middle column** (`GitChanges.svelte`): *Unstaged* list, *Staged* list, commit
box — stacked, the two lists sharing the free height.

- List header: title + count + **Stage all** / **Unstage all**.
- Row: status badge (`M A D R C ? U`; `U` in red), directory dimmed +
  filename bright, hover reveals **Stage**/**Unstage** and **Discard** (trash)
  buttons. Renames show `old → new`.
- Flat list sorted by path; conflicted (`U`) rows sort first.
- Display cap: 1 000 rows per list with a *"… and N more"* footer; *Stage
  all* still covers everything.
- Click selects the row (drives the diff column); `↑/↓` move within a list,
  `Tab` moves between lists, `Space` stages/unstages the selected row.

**Commit box** (`GitCommitBox.svelte`): single-line *Summary*, multiline
*Description*, **Amend** checkbox, **Commit (n)** button where n is the staged
count. Author line beneath from `user.name <user.email>`; when either is
unset the button is disabled with the hint *"Set user.name and user.email in
git config"*. Button disabled when nothing is staged unless amending.
`⌘Enter` commits from either field. Amend is hidden on an unborn HEAD.

**Diff column** (`GitDiff.svelte`, flex, widest). Header: path (+ `old → new`
for renames), status badge, **Unified / Split** segmented toggle. Body: the
diff viewer (§3) or one of: *"Binary file — N bytes"*, *"Diff too large
(> 2 MB)"*, *"Select a file to see its diff"*.

**Splitters and persisted prefs.** The two column boundaries are draggable
via the existing `pointerDrag.ts`. `Workspace` gains one persisted field,
`gitView?: { navWidth, listWidth, diffLayout, skipHunkDiscardConfirm }`
(Rust: `#[serde(default)] git_view: Option<GitViewPrefs>`), following the
`rootPath`/`agentCommand` precedent — the Rust `Workspace` literal sites and
the camelCase shape test are updated in the same task. The commit draft is
**not** persisted: the `gitStore` entry outlives tab switches, so a draft
survives navigating away and back, but not an app restart.

### Selection rules

- An unstaged row shows *worktree vs index*; a staged row shows *index vs
  HEAD*. A file present in both lists is two rows, each with its own diff.
- Untracked files show the whole file as added; they support file-level
  stage/discard only (no hunk/line actions — there is no index entry).
- After a stage/unstage the selection follows the file: if it still has
  changes in its current list it stays; otherwise the counterpart row is
  selected; otherwise selection clears.

## 2. Backend — `app/src-tauri/src/git.rs`

One module registered in `lib.rs`, mirroring `fileviewer.rs`. Every command
takes `cwd: String` (the worktree path; SP3's switcher changes only this) and
runs the system `git` via `std::process::Command` with:

- `-C <cwd>` and an argv array (never a shell string);
- `--no-optional-locks` on read-only commands so reads never create
  `index.lock`;
- a **10 s timeout** (as `git_status.rs`), killed on expiry;
- the user's environment plus `GIT_TERMINAL_PROMPT=0` so nothing blocks on a
  tty prompt; hooks, signing and credential helpers run exactly as in the
  user's terminal.

All commands return `Result<T, String>`; the `Err` is git's stderr, trimmed,
shown verbatim in the UI. "Not a repository" is a value, not an error.

### Reads

| Command | git invocation | Returns |
|---|---|---|
| `git_repo_info(cwd)` | `rev-parse --show-toplevel`, `symbolic-ref --short -q HEAD` (fails → detached, label from `rev-parse --short HEAD`), `rev-parse --verify -q HEAD` (fails → unborn; note `symbolic-ref` still succeeds on an unborn branch), `config user.name` / `user.email`, `log -1 --format=%B` (skipped when unborn; `headMessage: null`) | `RepoInfo { notARepo: bool, root, branch, detached, unborn, author: {name,email} \| null, headMessage, inProgress: "merge" \| "rebase" \| null }` |
| `git_status(cwd)` | `status --porcelain=v2 -z --untracked-files=all` | `StatusResult { unstaged: FileEntry[], staged: FileEntry[] }` |
| `git_diff(cwd, path, staged, untracked)` | `diff --no-color --no-ext-diff -U3 [--cached] -- <path>`; untracked: `diff --no-index -- /dev/null <path>` (exit code 1 means "differences found" and is success for both forms); binary detected via `--numstat` `-` columns; size guard at 2 MB checked on the file before diffing | `FileDiff { path, oldPath, binary, tooLarge, hunks: Hunk[] }` |

```ts
type FileStatus = "M" | "A" | "D" | "R" | "C" | "?" | "U";
interface FileEntry { path: string; oldPath?: string; status: FileStatus }
interface Hunk { header: string; oldStart: number; oldLines: number;
                 newStart: number; newLines: number; lines: Line[] }
interface Line { kind: "context" | "add" | "del"; text: string;
                 oldNo?: number; newNo?: number; noNewline?: boolean }
```

Porcelain-v2 rules: a file with both index and worktree changes appears in
**both** lists; `u` (unmerged) records go to unstaged as `U`; `?` records are
untracked; renames carry `oldPath`. The porcelain and unified-diff parsers
are pure functions (`parse_status`, `parse_diff`) with unit tests — the diff
parser must be exact because the frontend patch builder reverses it.

### Writes

Each returns `()`; the frontend refreshes after every success.

| Command | git invocation |
|---|---|
| `git_stage_files(cwd, paths)` | `add -A -- <paths>` |
| `git_unstage_files(cwd, paths)` | `restore --staged -- <paths>`; on an unborn HEAD `rm --cached -r -- <paths>` |
| `git_stage_all(cwd)` / `git_unstage_all(cwd)` | `add -A` / `reset -q` (unborn: `rm --cached -r .`) |
| `git_apply_patch(cwd, patch, mode)` | `apply --unidiff-zero --whitespace=nowarn` + `--cached` (mode `stage`), `--cached -R` (`unstage`), `-R` (`discard`); patch on stdin |
| `git_discard_files(cwd, tracked, untracked)` | `checkout -- <tracked>` then `clean -f -- <untracked>` |
| `git_commit(cwd, message, amend)` | `commit -F - [--amend]`, message on stdin |
| `git_init(cwd)` | `init` |

### Watcher

`git_watch(cwd)` / `git_unwatch(cwd)` — a `notify-debouncer-mini` recursive
watch on the worktree, **300 ms** debounce, held in a `GitWatchers`
(`Mutex<HashMap<cwd, (Debouncer, refcount)>>`) state like `FileWatchers`.
On a debounced batch it emits the Tauri event `git-changed` with payload
`{ cwd }`. Path filter (pure, unit-tested `is_relevant(path)`):

- outside `.git/` → relevant;
- inside `.git/` → relevant only for `HEAD`, `ORIG_HEAD`, `MERGE_HEAD`,
  `index`, `packed-refs`, `refs/**`, `rebase-merge/**`, `rebase-apply/**`;
- `index.lock`, `objects/**`, `logs/**`, `*.lock` → ignored (prevents
  feedback loops from our own and other tools' commands).

There is **no timer**. The daemon's `git_status.rs` poller and the sidebar's
`git-status-changed` event are untouched.

## 3. Diff viewer and staging model

### Rendering

Plain Svelte rows, not CodeMirror — per-line selection and per-hunk buttons
are list UI. Hunks longer than 500 lines render collapsed with **Expand**.

### One model, two layouts (`diffRows.ts`, pure)

- `toUnifiedRows(hunks): DiffRow[]` — one row per line; gutter shows old/new
  numbers; hunk header rows carry the hunk's action buttons.
- `toSplitRows(hunks): SplitRow[]` — within each hunk, consecutive `del`
  lines pair with the following consecutive `add` lines in order (k-th del
  beside k-th add; leftovers face a blank cell); `context` spans both sides.

Every rendered line carries `lineId = "<hunkIndex>:<lineIndex>"` pointing
into `hunks[h].lines[i]`, so the selection (`Set<lineId>`) is layout-
independent and survives toggling.

### Selection

- Click an `add`/`del` line to select it; shift-click extends within the
  same hunk; pointer-drag over the gutter paints a range; `context` lines are
  not selectable; `Esc` clears.
- With a non-empty selection, that hunk's header buttons read **Stage
  selected (n)** / **Discard selected (n)** (staged view: **Unstage selected
  (n)**). Selection is confined to one hunk at a time — selecting in another
  hunk replaces it.

### Patch builder (`patch.ts`, pure)

`buildPatch(diff: FileDiff, hunkIndex: number, selected: Set<lineId> | null): string`

1. Emit `--- a/<oldPath>` / `+++ b/<path>` (`/dev/null` for add/delete
   files), then exactly one hunk.
2. Walk the hunk's lines: `context` kept; selected `add`/`del` kept;
   **unselected `add` dropped**; **unselected `del` emitted as context**
   (the line still exists in the patch's base). `null` selection = whole
   hunk.
3. Recompute `@@ -oldStart,oldCount +newStart,newCount @@` from surviving
   lines; carry `\ No newline at end of file` markers with their line.

The same patch string serves all three modes because it is always relative
to the diff's own base: `stage` applies it to the index, `unstage` is the
staged diff applied `-R --cached`, `discard` is the unstaged diff applied
`-R` to the worktree.

### After an action

Refetch the same file's diff, clear the selection, apply the selection
follow rule from §1. A failed `git apply` (typically: file changed between
diff and apply) shows the stderr inline in the diff header and triggers a
refresh.

## 4. Frontend state, refresh, destructive actions

### `gitState.ts` + `gitStore`

Pure reducers in `gitState.ts` (tested), a writable `gitStore` keyed by
`workspaceId` as `kanbanState` is:

```ts
interface GitViewState {
  cwd: string;
  repo: RepoInfo | null;            // null = loading
  status: StatusResult | null;
  selected: { path: string; area: "unstaged" | "staged" } | null;
  diff: FileDiff | null;
  lineSelection: Set<string>;
  diffLayout: "unified" | "split";  // persisted
  commit: { summary: string; description: string; amend: boolean };  // draft, in-memory (survives tab switches)
  busy: string | null;              // label of in-flight mutation
  error: string | null;             // last stderr, dismissable
  refreshToken: number;             // supersession guard
}
```

### Refresh

One `refresh(workspaceId)`: bump `refreshToken`, run `git_repo_info` +
`git_status`, then `git_diff` for the selection; results whose token is stale
are dropped. Triggers:

1. `git-changed` event whose `cwd` matches.
2. Tab activation (`switchWorkspaceView(…, "git")`) and root rebinding.
3. Immediately after every successful mutation.
4. The Refresh button.

`git_watch` starts on tab mount and `git_unwatch` runs on unmount — hidden
workspaces cost nothing.

### Mutations

One helper `run(label, op)`: refuse if `busy` (buttons are disabled anyway),
set `busy = label`, clear `error`, await, `refresh`, on failure set
`error = "<label> failed: <stderr>"` and still `refresh`. Serialization
prevents two `git apply`s racing on the index.

### Destructive actions

Discard (file / hunk / lines) is the only irreversible operation in SP1.

- Always confirm through the existing `Modal.svelte`, naming the scope:
  *"Discard changes in 2 files?"*, *"Discard this hunk in src/foo.ts?"*,
  *"Discard 7 selected lines?"*. Untracked files get their own sentence —
  *"Delete 1 untracked file?"* — because `git clean` removes them from disk.
- The dialog for hunks/lines offers *"Don't ask again for hunks and lines"*
  (persisted as `gitView.skipHunkDiscardConfirm`). File-level and untracked
  deletions always confirm.
- Disabled while `busy`; no keyboard shortcut.

### Commit flow

Commit → `git_commit`; on success clear the draft and refresh. Ticking
Amend fills summary/description from `headMessage` only when the draft is
empty, otherwise the draft is kept with a *"keeping your draft"* hint;
unticking restores the pre-amend draft. On failure (hook rejection, signing)
the draft is kept and the stderr shown — nothing is lost.

### Keyboard

`↑/↓` within a list, `Tab` between lists, `Space` stage/unstage selected
row, `⌘Enter` commit, `Esc` clear line selection — registered via
`keyboard.ts` conventions and scoped to the tab being focused.

## 5. Edge cases

| State | Behaviour |
|---|---|
| Not a repo | Empty state + Initialize (§1) |
| Unborn HEAD | Branch *"main (no commits)"*; staged diff against empty tree; Amend hidden; unstage via `rm --cached` |
| Detached HEAD | Short SHA + *detached* pill; commit allowed |
| Merge / rebase in progress | Banner *"Merge in progress — resolve conflicts and commit"* (or *Rebase*); `U` rows first, red; staging a `U` file marks it resolved |
| Nested repo / submodule | Single entry as porcelain reports; no recursion |
| Paths with spaces/unicode; renames | `-z` everywhere, argv arrays, `oldPath` carried |
| File changed between diff and apply | `git apply` error shown inline; refresh |
| > 1 000 changed files | Lists capped with footer; bulk actions unaffected |
| Diff > 2 MB or binary | Message + file-level actions only |

## 6. Testing

1. **Rust unit** (`git.rs`): `parse_status` (both-lists case, renames,
   conflicts, untracked, `-z` escaping), `parse_diff` (multi-hunk, no-newline
   marker, rename headers, `/dev/null` headers, binary), `is_relevant`
   watcher filter.
2. **Rust integration** (temp repo via `tempfile`): init → write → status →
   stage file → apply a fixture patch with `--check` then for real → commit
   → amend → unstage on unborn HEAD. Proves builder output and git agree.
3. **Vitest**: `toUnifiedRows` / `toSplitRows` alignment, `buildPatch` (whole
   hunk, subset of adds, subset of dels, mixed, no-newline, delete-file,
   add-file), selection survives layout switch, `gitState` reducers
   (supersession, busy serialization, selection follow-through).
   `buildPatch` fixtures live in a shared JSON file read by both the Vitest
   suite and the Rust integration test.
4. **Smoke checklist** additions: discard untracked, discard with "don't ask
   again", commit rejected by a pre-commit hook, live refresh while an agent
   edits files.

## 7. Build order

One implementation plan, roughly: backend parsers + commands + integration
tests → watcher → `gitState` + `diffRows` + `patch` (TS, tested) → tab
registration + layout shell → lists + commit box → diff viewer (unified) →
split layout → line selection + partial staging → discard + confirms →
home tile + smoke checklist.
