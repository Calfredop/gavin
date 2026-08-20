# Git Tab — Sync, Branches, Stashes (SP2) and Worktrees (SP3) — Design Spec

Sub-projects **2 and 3 of 3** of the Git tab. Decisions G1–G14 live in
`docs/superpowers/brainstorms/2026-08-20-git-tab-brainstorm.md`; SP1's spec
(`2026-08-20-git-tab-local-changes-design.md`) defines the conventions this
builds on (runner, `run()` mutation gate, watcher, store, components).

**Goal:** the Git tab becomes a complete Fork-style client for the daily
loop: fetch/pull/push with progress, branches and remotes in the sidebar,
stashes, and — the gavin twist — worktrees as agent forks: create a
branch+worktree from the tab, start an agent in it, merge it back, clean up.

**Out of scope:** force push, tags, rebase-interactive, auto-stash on
checkout, credential prompting, the commit graph (SP4), submodules.

---

## 1. Backend additions (`app/src-tauri/src/git/`)

### 1.1 Streaming runner and op registry (`run.rs`, `ops.rs`)

`run_git_streaming(cwd, args, op_id, on_line) -> Result<(), String>`:
spawns git with the user's env + `GIT_TERMINAL_PROMPT=0`, reads **stderr**
line by line (git's progress channel; `\r`-separated progress updates are
split like newlines), calls `on_line` per line, waits with a **10-minute**
ceiling, and returns `Err(stderr_tail)` on non-zero exit or
`Err("cancelled")` when killed through the registry. The child handle is
registered in `GitOps(Mutex<HashMap<op_id, Child>>)` for the op's lifetime
so `git_cancel_op(op_id)` can `kill()` it.

Commands (all `async` Tauri commands running the blocking work on
`tauri::async_runtime::spawn_blocking`, emitting `git-op-progress
{ opId, line }`):

| Command | git |
|---|---|
| `git_fetch(cwd, remote, op_id)` | `fetch --progress --prune <remote>` |
| `git_pull(cwd, op_id)` | `pull --progress` (user config decides merge/rebase — G10) |
| `git_push(cwd, remote, op_id)` | `push --progress` ; when `rev-parse --abbrev-ref @{u}` fails: `push --progress -u <remote> <current-branch>` |
| `git_cancel_op(op_id)` | kills the registered child |

### 1.2 Refs snapshot — `git_refs(cwd) -> RefsSnapshot`

```ts
interface BranchInfo { name: string; current: boolean; upstream: string | null; ahead: number; behind: number; sha: string; subject: string }
interface RemoteInfo { name: string; url: string; branches: string[] }
interface StashInfo  { index: number; message: string; date: string }   // date = %cr (relative)
interface WorktreeInfo { path: string; head: string; branch: string | null; isMain: boolean; locked: boolean; prunable: boolean }
interface RefsSnapshot { branches: BranchInfo[]; remotes: RemoteInfo[]; stashes: StashInfo[]; worktrees: WorktreeInfo[]; headBranch: string | null }
```

Sources, one subprocess each:
- `for-each-ref --format='%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)%00%(objectname:short)%00%(subject)' refs/heads` — `upstream:track` is `[ahead 2, behind 1]` / `[gone]` / empty, parsed by `parse_track`.
- `for-each-ref --format='%(refname:short)' refs/remotes` grouped by the first path segment; `<remote>/HEAD` entries dropped.
- `remote -v` (fetch lines) for names + URLs; a remote with no branches still appears.
- `stash list --format='%gd%00%gs%00%cr'` (`%gd` = `stash@{n}`).
- `worktree list --porcelain` (SP3; see §3.1).

### 1.3 Branch, remote, stash commands

| Command | git | Notes |
|---|---|---|
| `git_checkout(cwd, name, track_remote: Option<String>)` | `switch <name>` / `switch -c <name> --track <remote>/<name>` | dirty-tree refusal surfaces verbatim (G14) |
| `git_create_branch(cwd, name, from: Option<String>, checkout)` | `branch <name> [<from>]` then `switch <name>` if `checkout` | |
| `git_delete_branch(cwd, name, force)` | `branch -d` / `-D` | UI tries `-d`, re-offers force on "not fully merged" |
| `git_merge(cwd, branch)` | `merge --no-edit <branch>` | conflict → exit 1 with `MERGE_HEAD` present; the error is returned AND the banner shows |
| `git_abort_in_progress(cwd, kind)` | `merge --abort` / `rebase --abort` | |
| `git_continue_rebase(cwd)` | `rebase --continue` with `GIT_EDITOR=true` | never opens an editor |
| `git_add_remote(cwd, name, url)` / `git_remove_remote(cwd, name)` | `remote add` / `remote remove` | |
| `git_stash_push(cwd, message, include_untracked)` | `stash push [-u] -m <message>` (no `-m` when empty) | |
| `git_stash_pop(cwd, index)` / `git_stash_apply` / `git_stash_drop` | `stash pop|apply|drop stash@{n}` | |
| `git_stash_files(cwd, index)` | `stash show --name-status --include-untracked stash@{n}` → `FileEntry[]` | `--include-untracked` needs git ≥ 2.32; on failure retry without it |

## 2. SP2 frontend

### 2.1 Store (`gitState.ts`)

`GitViewState` gains:
```ts
refs: RefsSnapshot | null;
activeRemote: string | null;          // session override; null = derived
navSelection: "changes" | { stash: number };
stashFiles: FileEntry[] | null;       // for the selected stash
op: { id: string; label: string; line: string | null } | null;   // running long op
```
`refresh()` also calls `gitRefs` (after status; failures leave `refs` as-is
and set `error`). `effectiveRemote(state)` = override ?? current branch's
upstream remote ?? `"origin"` if present ?? first remote ?? null.
`pushLabel(state)` = `"Publish"` when the current branch has no upstream,
else `"Push"`. Badges: `behind`/`ahead` of the current branch.

Long ops: `startOp(workspaceId, label, invoke)` — refuses while `busy` or
`op` is set, generates `op.id = crypto.randomUUID()`, subscribes to
`git-op-progress` (filtering by id) into `op.line`, awaits the command,
clears `op`, refreshes, records `"<label> failed: …"` like `run()`.
`cancelOp(workspaceId)` calls `gitCancelOp(op.id)`.

### 2.2 Toolbar (`GitHubView.svelte` → extracted `GitToolbar.svelte`)

Left: worktree switcher (SP3, §3.2) · branch pill. Middle: **Fetch**,
**Pull ↓N**, **Push ↑N / Publish**, then the **remote dropdown** (rendered
only with ≥2 remotes; sets `activeRemote`). Right: **Stash**, **Pop**
(disabled when no stashes), **Refresh**. Buttons disable while `busy || op`.
`GitOpBar.svelte` renders under the toolbar while `op` is set: label,
`op.line`, **Cancel**.

Stash button → `GitStashDialog.svelte`: message input, "Include untracked"
checkbox, Stash/Cancel.

### 2.3 In-progress banner

`merge` → **Abort merge**. `rebase` → **Abort rebase**, **Continue**
(disabled while any `U` entry remains in `status.unstaged`).

### 2.4 Sidebar (`GitNav.svelte` → sections)

`GitNav` receives `refs`, `navSelection`, callbacks, and
`collapsed: Record<string, boolean>` persisted in `gitView.navCollapsed`.
Sections, each a header with a chevron and optional `+`:

- **Local Changes** — count; selected when `navSelection === "changes"`.
- **Branches** — rows: `● name ↑a ↓b` (current bold). Double-click →
  checkout. Hover actions: ⤵ *Checkout* (non-current), ⑂ *Merge into
  current* (non-current), 🗑 *Delete* (non-current). Header `+` → *New
  branch* dialog (name, "Checkout after creating", from = current HEAD).
- **Remotes** — per remote: name row (URL tooltip, 🗑 → confirm → remove)
  then its branches; branch hover action ⤵ *Checkout* (creates a tracking
  local branch; if a local branch of that name exists, plain `switch`).
  Header `+` → *Add remote* dialog (name, URL).
- **Stashes** — rows `stash@{n}: message · date`; click → `navSelection =
  { stash: n }` + `gitStashFiles` load; hover actions *Pop*, *Apply*, 🗑
  *Drop* (confirm).

Dialogs share a small `GitPromptDialog.svelte` (title, fields, primary
label) built on `Modal.svelte`; confirms reuse `GitDiscardDialog` with
`offerSkip={false}` (renamed usage only — no new component).

### 2.5 Middle column in stash mode

When `navSelection` is a stash, `GitChanges` renders a single read-only
list "Stash `stash@{n}` — message" of `stashFiles` (rows via `GitFileRow`
with no actions) and a footer with **Pop** / **Apply**; the commit box is
hidden. The diff column reads *"Stash contents — pop or apply to edit"*.
Selecting Local Changes restores the normal view.

### 2.6 Delete-branch refusal

`git_delete_branch(…, false)` failing with stderr containing `not fully
merged` → the confirm dialog re-opens with title *"Branch `x` isn't fully
merged. Force delete?"* and a red **Force delete** button → `force: true`.

## 3. SP3 — worktrees

### 3.1 Backend

`parse_worktree_list(porcelain)` handles blocks of `worktree <path>` /
`HEAD <sha>` / `branch refs/heads/<name>` | `detached` / `bare` / `locked
[reason]` / `prunable [reason]`. `isMain` = the first block (git lists the
main worktree first). Commands:

| Command | git |
|---|---|
| `git_worktree_add(cwd, path, branch, from: Option<String>, new_branch: bool)` | `worktree add -b <branch> <path> [<from>]` / `worktree add <path> <branch>` |
| `git_worktree_remove(cwd, path, force)` | `worktree remove [--force] <path>` |
| `git_worktree_prune(cwd)` | `worktree prune` |

**Watcher**: `git_watch(cwd)` resolves `rev-parse --absolute-git-dir`; when
it is not inside `cwd` (linked worktree), a second non-recursive watch on
that directory joins the same debouncer; its events are filtered with
`is_relevant(Path::new(".git").join(rel))` so the SP1 rule applies
unchanged.

### 3.2 Switcher (`GitWorktreeSwitcher.svelte`)

Leftmost toolbar control: current name (`<repo> · <branch>`) with a
chevron; the menu lists the main worktree first, then linked ones
(`<folder> · <branch|detached sha>`, dimmed + "(missing)" when prunable).
Row actions: ▶ *Open agent here*, ⑂ *Merge into <main branch>* (linked
only), 🗑 *Remove* (linked only). Footer: **+ New worktree…**, and
**Prune** when anything is prunable.

Selecting a row → `switchWorktree(workspaceId, path)`: persists
`gitView.worktree = path`, calls `ensureGitView(workspaceId, path)` (fresh
state), restarts the watcher (the `$effect` in `GitHubView` keys on the
view's `cwd` instead of `root`). On mount, `cwd = gitView.worktree` when
that path is a listed worktree, else the root.

### 3.3 Fork dialog (`GitForkDialog.svelte`)

Fields: *Branch name* (required, validated `^[^\s~^:?*\[\\]+$`, no leading
`-`), *From* (local branches + "current HEAD"), *Folder* (default
`<parent-of-root>/<repo>-<branch-with-/→->`; editable), *Use existing
branch* toggle (then Branch is a dropdown of local branches not checked out
anywhere and From/`-b` are hidden), **Start agent here** checkbox (default
on). Create → `git_worktree_add` → on success `switchWorktree(path)` and, if
ticked, `createSessionForCard(workspaceId, path, agentCommand)` where
`agentCommand` is `resolveAgentConfig(rootConfig, profiles).command` — the
same resolution the Home tab uses.

### 3.4 Merge back

`mergeBack(workspaceId, fork)`: runs `gitMerge(rootPath, fork.branch)`
(note: **root** cwd, not the fork's). Success → `GitCleanupDialog`: *"Merged
`<branch>` into `<root branch>`. Remove worktree `<path>` and delete the
branch?"* with **Remove & delete** / **Keep** — remove uses
`git_worktree_remove` then `git_delete_branch(-d)`. Failure → if the root
now has `MERGE_HEAD` (conflict) switch the view to the root so the banner's
Abort is at hand; otherwise the error banner shows git's message (e.g.
"local changes would be overwritten").

### 3.5 Remove

Confirm → `git_worktree_remove(force=false)`; stderr containing `contains
modified or untracked files` re-opens the dialog with **Force remove**
(text spells out that uncommitted changes there are lost). A "Also delete
branch `<name>`" checkbox (default off) runs `git_delete_branch(-d)` after
a successful removal. Removing the currently selected worktree switches the
view back to the root first.

## 4. Edge cases

| Case | Behaviour |
|---|---|
| No remotes | Fetch/Pull/Push disabled with tooltip "No remotes — add one in the sidebar" |
| Detached HEAD | Pull/Push disabled ("detached HEAD"); Fetch works; branch pill unchanged |
| Unborn HEAD | Push/Pull disabled; Branches section shows "(no commits yet)" |
| Push rejected (non-fast-forward) | git's message in the banner; no force option (G10) |
| Auth needed | fails fast (GIT_TERMINAL_PROMPT=0); banner shows git's message |
| Op cancelled | banner "Fetch cancelled"; refresh |
| Checkout with dirty tree | git's refusal verbatim (G14) |
| Worktree path exists / not empty | `worktree add` error verbatim |
| Fork branch already exists | dialog validation: "branch exists — use *existing branch* mode" |
| Selected worktree deleted externally | falls back to the root on next refresh with a banner note |

## 5. Testing

- **Rust**: `parse_track`, `parse_refs`, `parse_worktree_list` unit tests; integration: bare-remote clone → fetch/pull/push round-trip (ahead/behind, publish sets upstream); stash push/pop/apply/drop/files; checkout/create/delete (+ `-D` path); merge ok / conflict → `in_progress` → abort; worktree add/list/remove/prune; linked-worktree watcher resolves the gitdir; streaming runner emits progress lines (a local clone with `--progress` of a repo with a few hundred commits) and cancel kills the child.
- **Vitest**: `effectiveRemote`, `pushLabel`, badges; nav selection reducer; `defaultWorktreePath`; fork validation; `switchWorktree` resets state and persists; op lifecycle (start/progress/cancel/refresh) with mocked events.
- **Smoke checklist**: “Sync & branches” (fetch with SSH remote, pull conflict → abort, publish new branch, stash/pop, remote add/remove, delete unmerged → force) and “Worktrees” (fork + agent session, switch, merge back + cleanup, force remove).

## 6. Build order

Two plans, back-to-back on `worktree-git-tab-local-changes`:
1. **SP2**: streaming runner + ops registry → refs parsers + snapshot → branch/remote/stash commands → store → toolbar/op bar/stash dialog → banner buttons → sidebar sections + dialogs → stash view → smoke.
2. **SP3**: worktree parsing + commands + watcher gitdir → store cwd switch + persistence → switcher → fork dialog + agent spawn → merge back + cleanup → remove/prune → smoke.
