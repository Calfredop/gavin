---
kind: task
title: "[sec] A directory symlink committed in a cloned repo makes gavin's Linux inotify watchers walk and watch trees outside the worktree, using up the user's shared inotify watch quota"
status: To Do
priority: low
complexity: moderate
labels: security, ready-for-agent
---
Fix a needs-validation lead from the 2026-10-15 security audit (run-1). It is not confirmed: the audit traced it in source but could not observe notify's inotify walk itself, because the audit host is macOS and that backend is compiled only for Linux. The failing regression test below is the proof — write it first and watch it fail. If it already passes before any change, the lead is wrong: record why under a dated "## Comments" heading and move the card to Done with no code change. Fingerprint: `notify-default-follow-symlinks:recursive-watch-descends-committed-dir-symlink`.

Full record: `NEEDS-VALIDATION.md` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

Four watchers register `RecursiveMode::Recursive` on paths a repository's contents decide: the daemon's RepoPoller (every top-level entry), the desktop Git tab watcher and the daemon's ssh-side Git tab watcher (every top-level entry, Linux only), and the daemon's `.gavin*`/`.gavin-root` marker watch (Linux only). All four build their debouncer through `changes_only::new_debouncer` with `notify_debouncer_mini::Config::default()`, so notify 8.2.0's `follow_symlinks` stays true. No registration site checks `symlink_metadata` on what it registers, and the marker watch applies `safe_to_descend` (DP-05) only to the marker itself, not to links inside it.

On Linux, notify's inotify `add_watch` walks the target with `WalkDir::new(path).follow_links(true)`. walkdir follows the root link, crosses filesystems and rejects only ancestor loops. notify calls `inotify_add_watch` for every directory it reaches and stops at the first error with `?`, without removing the watches already added. Those watches stay until the debouncer is dropped: when the last session leaves the repo, when the Git tab's refcount reaches zero, or when the workspace watcher stops. The per-user `fs.inotify.max_user_watches` quota is shared by every inotify consumer of the account: IDEs, file managers, build tools and gavin's other watchers.

`inotify_add_watch` needs read permission, so the walk also ends at the first directory the user cannot read. That bounds a link to `/`. The realistic hostile input is a relative link to a tree the user can read in full, such as `a -> ..` (every sibling project, with its `node_modules` and `target`) or `b -> ../..` (often the home directory, with `.cache`, `.cargo` and `.npm`). On a developer machine these often hold 10^5 or more directories, and git checks such links out by default. Each top-level link is its own `watch()` call, so one abort does not stop the others, and gavin discards every result. In `GavinWatcher::sync_watches` a failed marker path is left out of `registered`, so the marker is re-walked on every rescan while the `WatcherInner` lock is held, which also blocks `GetGavinTree`. Events from the outside tree then drive more rescans and rechecks. Callers that block meanwhile: the desktop's sync Tauri command `git_watch` (holding the `GitWatchers` mutex), the daemon connection loop for `WatchGitWorktree`, and `GavinWatcher` under its inner lock.

There is a smaller variant on macOS. The RepoPoller is not gated by `ONE_RECURSIVE_WATCH`, so FSEvents watches a link's target, and outside events can re-run `git status` at most once per 5 s. It is bounded, and the same registration-site fix closes it.

## Root cause

Both `changes_only.rs` copies build the debouncer with `Config::default().with_timeout(..)` and never call `with_notify_config`, so `follow_symlinks: true` reaches the inotify backend. The registration sites hand notify a Recursive watch on a repository-controlled path, filtered only by name or by a link-following `is_dir()`. Flipping `follow_symlinks` alone is not enough: walkdir's `follow_root_links` defaults to true and notify stats the path with link-following `metadata()`, so a top-level directory link would still be walked one level. The registration sites must also skip directory symlinks.

## The invariant to enforce

No filesystem watch gavin registers on a repository's behalf follows a symlink out of the tree it was asked to watch. Every debouncer is built with `follow_symlinks(false)`. Every Recursive registration on a repository-chosen path skips directory symlinks, judged with `symlink_metadata` or `DirEntry::file_type()`, which do not follow links.

## Trace (lines as of 2026-10-16; re-read before editing)

- `crates/daemon/src/changes_only.rs:57` and `app/src-tauri/src/changes_only.rs:56` (new_debouncer): `notify_debouncer_mini::Config::default().with_timeout(timeout)`, no `with_notify_config`.
- `crates/daemon/src/server.rs:1105` -> `:1182` -> `:1305` (update_session_repo_mapping -> register_session_with_repo -> setup_filesystem_watch): a session's cwd resolves to a cloned repo's root, and the first session there arms a RepoPoller.
- `crates/daemon/src/server.rs:1384` (setup_filesystem_watch): `watch(&entry.path(), Recursive)` on every top-level entry except `.git` and `.gavin-worktrees`, with no symlink check and the result discarded.
- `app/src-tauri/src/git/watch.rs:180` (arm_initial): Recursive on each top-level entry passing the name-only `is_top_level_watch_target` (125). Reached from the sync command `git_watch` (573).
- `app/src-tauri/src/git/watch.rs:226` and `:237` (rearm_new_top_level_dirs): gated by `e.path.is_dir()`, which follows links, so a link created later is armed too. The module's own link-safe `is_dir` helper (485) is not used here.
- `crates/daemon/src/git_watch.rs:174`, `:219` and `:230` (the ssh-side twin): the same per-entry registration and link-following re-arm gate. Reached from `Request::WatchGitWorktree` (`server.rs:8425`, spawn at 8441); `confined_worktree` confines the cwd, not the links inside it.
- `crates/daemon/src/gavin.rs:2581` (watch_targets): a `.gavin*`/`.gavin-root` marker is pushed as Recursive after `safe_to_descend` (2179) checked only the marker path.
- `crates/daemon/src/gavin.rs:2897` (sync_watches): holds the `WatcherInner` lock across `fs_watcher.watch`; on `MaxFilesWatch` (2924) or any other error the path is left out of `registered` and re-walked next time.
- `crates/daemon/src/gavin.rs:2512` (ONE_RECURSIVE_WATCH): false off macOS and Windows, so Linux takes the per-entry registrations above.

## What the audit could not observe

- notify's inotify backend is Linux-only, and no Linux build or VM was allowed, so the walk, the per-directory `inotify_add_watch`, the persistence of a partial watch set after an abort, and the effect on another inotify consumer of the same user were not seen.
- The magnitude depends on facts only a Linux owner can see: `max_user_watches` on the shipped distros, and how many readable directories `..` and `../..` reach from a typical clone location.

## Fix

1. In both `changes_only.rs` copies, build the config with `.with_notify_config(notify::Config::default().with_follow_symlinks(false))`.
2. At every Recursive registration on a repository-chosen path, skip directory symlinks: `server.rs:1384`, `git/watch.rs:180` and `:237` (switch the re-arm gate to the module's own `is_dir`), and `git_watch.rs:174` and `:230` (the same; that module also has a link-safe `is_dir` at 478). Use `entry.file_type()` in the `read_dir` loops. A symlinked top-level directory then gets no recursive watch. The root's NonRecursive watch still reports the entry itself changing.
3. For the marker watch, `follow_symlinks(false)` stops notify descending links inside the marker; leave `safe_to_descend` on the marker itself as it is. `sec-fix-gavin-walkers-visited-set.md` changes gavin's own `watch_targets` walk; this card changes only what notify is told to follow, so the two do not conflict.

Regression tests, written first:

- Any OS: in the daemon's git_watch tests (the `spawn_worktree_watcher` shape near `git_watch.rs:929`) and the host's `git/watch.rs` tests, a worktree with a real `src/` and a committed `x -> <tempdir outside>` ends with `x` absent from the `armed` set. The same for the RepoPoller, asserted through whatever the poller exposes, or by factoring its entry filter into a function the test calls. It fails today.
- Linux, `#[cfg(target_os = "linux")]` (CI runs ubuntu): build a temp tree with 200 nested directories outside the repo and link it as `x`. Arm `spawn_worktree_watcher`, then count `inotify wd:` lines in `/proc/self/fdinfo/<fd>` for the process's `anon_inode:inotify` fds. It stays at about the repo's own directory count, not 200 or more. Do the same for `GavinWatcher::start` on a repo whose `.gavin-root/plans/x` links outside. Both fail today.

## Done when

- The fix enforces the invariant above at the last trusted decision point, not in a caller.
- The regression cases named in the fix are tests in the touched crate or module, and they fail before the change.
- The checks in CLAUDE.md pass for every part you touched. The daemon's `gavin::tests` are flaky under full-suite parallelism; re-run that module alone before calling a failure a regression.
- The regression test fails before the change and passes after it.
- Follow the CLAUDE.md traps that apply: a new SQLite column needs its own `ALTER TABLE`, a widened request needs a compat-gate entry, and you commit only your own files.
- Once the fix is in, file this check with `gavin_request_human(<this card>, "test", …)` using exactly this text: "On a Linux machine with a desktop build installed, a scratch repo with a committed `z -> ..` symlink, opened as a workspace with its Git tab shown and a terminal in it, keeps the count of `inotify wd:` lines under `/proc/<pid>/fdinfo/` of that install's gavin-daemon and gavin app processes near the repo's own directory count, and `inotifywait -r` on an unrelated folder still starts."
