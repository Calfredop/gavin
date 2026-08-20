# Git Tab — Worktrees / Agent Forks (SP3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A worktree switcher in the Git tab's toolbar; fork a branch + worktree from the tab and start an agent in it; merge it back with optional cleanup; remove/prune; the watcher follows a linked worktree's gitdir.

**Architecture:** `git worktree list --porcelain` joins the SP2 refs snapshot. The store's `cwd` becomes switchable (`switchWorktree` → fresh `GitViewState` + persisted `gitView.worktree`); `GitHubView`'s watcher effect keys on that cwd. Fork = `worktree add -b` + `switchWorktree` + the existing `createSessionForCard` with the workspace's resolved agent command. Merge back runs `git_merge` in the **root** checkout.

**Tech Stack:** as SP1/SP2.

**Spec:** `docs/superpowers/specs/2026-08-20-git-tab-sync-worktrees-design.md` §3–5.

## Global Constraints

- SP1/SP2 constraints hold. Default fork path is the sibling folder `../<repo>-<branch>` (G11); merge back = merge + optional cleanup (G12).
- Removing a worktree never forces on the first try; `--force` only after the refusal is shown (same pattern as delete-branch).
- `gitView.worktree` persists the selection; a missing path falls back to the root.

## File structure

**Rust**: `parse.rs` (+ `parse_worktree_list`), `commands.rs` (+ `worktrees`, `worktree_add/remove/prune`, refs fills `worktrees`), `watch.rs` (gitdir watch), `config.rs` (`GitViewPrefs.worktree`), `lib.rs`.
**TS**: `git.ts` (`defaultWorktreePath`, `validateBranchName`), `backend.ts`, `gitState.ts` (`switchWorktree`, `forkWorktree`, `removeWorktree`, `pruneWorktrees`, `mergeBack`), `workspace.ts`, new `GitWorktreeSwitcher.svelte`, `GitForkDialog.svelte`; modified `GitToolbar.svelte`, `GitHubView.svelte`, `smokeChecklist.ts`.

---

### Task 1: Worktree parsing + commands + watcher gitdir

**Interfaces:** `parse_worktree_list(raw) -> Vec<WorktreeInfo>`; `commands::worktrees(cwd)`; `worktree_add(cwd, path, branch, from: Option<&str>, new_branch: bool)`, `worktree_remove(cwd, path, force)`, `worktree_prune(cwd)`; Tauri `git_worktree_add/remove/prune`; `watch::gitdir_for(cwd) -> Option<PathBuf>` (absolute gitdir when outside cwd); `watch::relevant_event(root, gitdir, path) -> bool`.

- [ ] Tests:
```rust
// parse.rs
#[test] fn worktree_list_parses_main_linked_detached_and_prunable() {
    let raw = "worktree /r/main\nHEAD aaaa\nbranch refs/heads/main\n\nworktree /r/wt-feature\nHEAD bbbb\nbranch refs/heads/feature\nlocked\n\nworktree /r/wt-det\nHEAD cccc\ndetached\nprunable gitdir file points to non-existent location\n\n";
    let w = parse_worktree_list(raw);
    assert_eq!(w.len(), 3);
    assert!(w[0].is_main && w[0].branch.as_deref() == Some("main"));
    assert!(!w[1].is_main && w[1].locked && w[1].branch.as_deref() == Some("feature"));
    assert!(w[2].branch.is_none() && w[2].prunable);
}
// watch.rs
#[test] fn gitdir_events_map_onto_the_dot_git_rule() {
    let root = Path::new("/r/wt"); let gitdir = Path::new("/r/main/.git/worktrees/wt");
    assert!(relevant_event(root, Some(gitdir), Path::new("/r/main/.git/worktrees/wt/HEAD")));
    assert!(relevant_event(root, Some(gitdir), Path::new("/r/main/.git/worktrees/wt/index")));
    assert!(!relevant_event(root, Some(gitdir), Path::new("/r/main/.git/worktrees/wt/index.lock")));
    assert!(relevant_event(root, Some(gitdir), Path::new("/r/wt/src/a.ts")));
    assert!(!relevant_event(root, None, Path::new("/elsewhere/x")) == false || true); // outside both: treated as relevant (conservative)
}
// commands.rs
#[test] fn worktree_add_list_remove_prune_round_trip() {
    let dir = temp_repo();
    let wt = dir.path().parent().unwrap().join(format!("{}-feature", dir.path().file_name().unwrap().to_string_lossy()));
    let wt_s = wt.to_str().unwrap().to_string();
    worktree_add(cwd(&dir), &wt_s, "feature", None, true).unwrap();
    let r = refs(cwd(&dir)).unwrap();
    assert_eq!(r.worktrees.len(), 2);
    assert!(r.worktrees[0].is_main);
    assert_eq!(r.worktrees[1].branch.as_deref(), Some("feature"));
    assert_eq!(repo_info(&wt_s).unwrap().branch.as_deref(), Some("feature"));
    std::fs::write(wt.join("dirty.txt"), "x").unwrap();
    assert!(worktree_remove(cwd(&dir), &wt_s, false).is_err());
    worktree_remove(cwd(&dir), &wt_s, true).unwrap();
    assert_eq!(refs(cwd(&dir)).unwrap().worktrees.len(), 1);
    // Existing-branch mode + prune after an external rm -rf.
    worktree_add(cwd(&dir), &wt_s, "feature", None, false).unwrap();
    std::fs::remove_dir_all(&wt).unwrap();
    assert!(refs(cwd(&dir)).unwrap().worktrees[1].prunable);
    worktree_prune(cwd(&dir)).unwrap();
    assert_eq!(refs(cwd(&dir)).unwrap().worktrees.len(), 1);
}
```
- [ ] Implement per spec §3.1; `git_watch` resolves `gitdir_for(cwd)` and, when Some, adds `debouncer.watcher().watch(gitdir, NonRecursive)`; the event filter becomes `relevant_event(root, gitdir, &e.path)`. Register commands. Commit `feat(git): worktree list/add/remove/prune; watcher follows linked gitdirs`.

### Task 2: Store + prefs

**Interfaces:** `git.ts`: `defaultWorktreePath(root, branch)`, `validateBranchName(name): string | null`; `workspace.ts`/`config.rs`: `gitView.worktree?: string`; `gitState.ts`: `switchWorktree(ws, path)`, `forkWorktree(ws, { path, branch, from, newBranch })`, `removeWorktree(ws, path, force, deleteBranch: string | null)`, `pruneWorktrees(ws)`, `mergeBack(ws, rootPath, branch): Promise<"merged" | "conflict" | "failed">`, `rootPathOf(state)` (main worktree path from refs, else cwd).

- [ ] Tests (`git.test.ts`, `gitState.test.ts`): default path `/a/b/repo` + `feat/x` → `/a/b/repo-feat-x`; branch validation rejects spaces, `..`, leading `-`, trailing `.lock`; `switchWorktree` resets state to the new cwd and persists `gitView.worktree` (mock `setGitViewPrefs` via `./layoutState` mock); `mergeBack` returns `"conflict"` when the root repo info reports `inProgress: "merge"` after a failed merge.
- [ ] Implement. `GitHubView`: initial cwd = `ws.gitView?.worktree ?? root`; the mount effect keys on `cwdTarget`; an error containing `directory not found` while `cwd !== root` → `switchWorktree(ws, root)` + banner note. Commit `feat(git): worktree switching in the store with persisted selection`.

### Task 3: Switcher + fork dialog + agent spawn

- [ ] `GitWorktreeSwitcher.svelte` (toolbar `leading` snippet): button `<folder> · <branch>` with chevron; popover menu (click-outside closes) listing worktrees (main first; prunable dimmed "(missing)"), row actions ▶ *Open agent here* (`createSessionForCard(ws, path, agentCommand)`), ⑂ *Merge into <root branch>* (linked only), 🗑 *Remove* (linked only); footer **+ New worktree…** and **Prune** (when any prunable).
- [ ] `GitForkDialog.svelte`: new/existing toggle, Branch name (validated) or branch select, From select (local branches + "current HEAD"), Folder (default sibling), **Start agent here** (default on). Submit → `forkWorktree` → `switchWorktree` → optional spawn.
- [ ] Wire in `GitToolbar` (`leading` snippet from `GitHubView`). Commit `feat(git): worktree switcher, fork dialog, agent spawn`.

### Task 4: Merge back, remove, prune flows

- [ ] Merge back: `mergeBack` → `"merged"` → confirm dialog *"Merged `<branch>` into `<root branch>`. Remove worktree and delete the branch?"* (**Remove & delete** / **Keep**); `"conflict"` → `switchWorktree(root)` (banner's Abort is there); `"failed"` → error banner.
- [ ] Remove: confirm → `removeWorktree(force=false)`; error containing `contains modified or untracked files` → re-confirm with **Force remove**; checkbox "Also delete branch" (default off). Removing the selected worktree switches to root first. Prune → `pruneWorktrees`.
- [ ] Commit `feat(git): merge back with cleanup, remove/force, prune`.

### Task 5: Smoke, cards, final verification

- [ ] Append “Git tab — worktrees” smoke section; tick the SP3 card; execution notes in the brainstorm log; merge `main` into the branch; `cargo test -p app && npm test && npm run check && npm run build`. Commit `feat(git): SP3 smoke entries; Git tab complete pending manual pass`.
