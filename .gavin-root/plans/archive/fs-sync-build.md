---
title: FS sync — build
status: Done
priority: high
---
# FS sync — build

Implementation checklist for the task card `fs-sync.md`: deleting, renaming
or moving a folder or plan file on disk must reach the Plans, Kanban and
Orchestration tabs — and the plan editor/viewer — in near real time, without
paying for a firehose watch.

## The bug (verified)

The daemon's gavin watcher (`crates/daemon/src/gavin.rs`) registers ONE
recursive watch on the workspace root and rescans only when an event path
carries a `.gavin` / `.gavin-root` component (or is the root itself).

A probe against the real `notify` backend showed that renaming a folder that
holds a context emits exactly two paths — the old and the new folder — and
**neither carries a `.gavin` segment**:

```
=== RENAME EVENTS ===   (mv packages/foo packages/bar, with packages/foo/.gavin)
  …/packages/bar
  …/packages/foo
```

So the rescan never fires and every tab keeps the stale context until the app
restarts. The same hole swallows a context folder moved *into* the tree.

Meanwhile the recursive watch covers 3587 directories in this repo (`target/`,
`node_modules/`, `.git/`) against the 44 that `scan_root` actually walks — the
kernel streams every build event into the daemon for nothing.

## Design

**Watch exactly what the scanner walks.** Replace the single root-recursive
watch with a watch SET, derived from the same rules as `scan_root`:

- every directory the scanner descends into → `NonRecursive` (so a child
  folder appearing, vanishing or being renamed is seen by its parent's watch)
- every `.gavin` / `.gavin-root` directory → `Recursive` (plans/, docs/,
  specs/ churn below it)
- excluded dirs (`.git`, `node_modules`, `target`, …, any dot-dir that is not
  a gavin marker) and anything past `MAX_SCAN_DEPTH` → never watched

The set is recomputed after every rescan and **diffed**, so a steady tree
re-registers nothing.

**Relevance filter, rewritten to match.** Directory-shaped events now count:

- the root itself → relevant (root renamed away/back)
- any `.gavin*` component → relevant
- excluded / dot-dir component → never relevant
- path exists and `is_dir()` → relevant (a folder appeared or moved in, and it
  may carry a `.gavin` with it)
- path is gone but is an ancestor of a context in the last scanned tree →
  relevant (that context's folder was deleted or moved out)

Both new rules are what the old filter was missing.

**Fast first, throttle after.** Debounce 500ms → 150ms, and the 2s floor now
applies only to *sustained* churn: the first flush after a quiet period
rescans immediately, a burst still gets throttled.

**Editor/viewer sync (frontend).** `FileEditor` already watches its file;
extend the same treatment to the surfaces that don't:

- `CardDetailModal` re-reads on `file-changed` for its card path
- an editor whose file is deleted says so, instead of blanking the buffer and
  offering to "create" it
- the Plans tab keeps its selection through a rename rather than dropping it

## Steps

- [x] daemon: `watch_targets()` — the scanner's own walk, returning the dirs
      to watch and their recursion mode, with tests
- [x] daemon: `tree_relevant()` — new filter (dir-shaped + vanished-ancestor),
      with tests covering folder rename / move-in / move-out
- [x] daemon: `GavinWatcher` owns a diffed watch set, re-armed after each scan
- [x] daemon: fast-first debounce + sustained-churn-only floor
- [x] daemon: wire-level tests — renaming and moving-away a context folder
      each push a new tree
- [x] frontend: `CardDetailModal` live-reloads on `file-changed`
- [x] frontend: deleted-file state in `FileEditor` (distinct from "not yet
      created"; no silent resurrect on unmount)
- [x] frontend: refcount the Rust file watchers, so a modal and an editor on
      the same file don't cancel each other's updates
- [x] frontend: Plans tab follows a renamed selection
- [x] frontend: pinned board tabs follow a renamed context folder
- [x] `cargo test --workspace` + `npm test` green, clippy clean on new code
- [x] verify against a real daemon on a real-sized tree

## Found while building

Two holes the first cut opened, both caught by tests rather than by reading:

1. **The root's watch must be permanent.** With the watch set derived from
   the tree, renaming the root away emptied the set — including the root's
   own watch — so nothing was left to notice it come back. `watch_targets`
   now lists the root unconditionally and `sync_watches` never drops it.
   (The first fix, watching the root's PARENT while it was missing, was
   worse: a trace showed each watcher picking up every sibling temp dir in
   the suite. A workspace root's parent is routinely `~/Code`. Reverted.)

2. **An event can arrive from outside the root.** Moving a context folder
   away is reported against its DESTINATION as readily as its source, and
   the filter rejected anything it couldn't `strip_prefix(root)`. But such
   an event can only reach us through a watch we registered, and every
   watch we register is under the root — so it means a subtree of ours just
   left. Now conservatively relevant, matching `git/watch.rs`.

Verified with a trace across the whole daemon suite: 8 debouncer flushes,
all 8 relevant, none crossing between watchers (21 before, most of them
another watcher's temp dir).

## Measured

The real `gavin-daemon` binary, driven over its socket exactly as the app
drives it, against a 3617-directory workspace (11 of them scanned; the rest
`node_modules/` and `target/`). Same script, same fixtures, both builds:

| operation                          | before (HEAD) | after  |
|------------------------------------|---------------|--------|
| delete a plan file                 | 2004 ms       | 159 ms |
| rename a plan file                 |  518 ms       | 172 ms |
| move a plan into another context   |  528 ms       | 166 ms |
| **rename a context folder**        | **never**     | 181 ms |
| move a context folder out          | (unreachable) | 172 ms |
| move it back in                    | (unreachable) | 172 ms |
| delete a context folder            | (unreachable) | 169 ms |

The "before" run stopped at the folder rename: no push ever arrived, which
is the bug. 2000 writes across `target/`, `node_modules/` and `app/src/`
produce no push and no rescan on either build -- but only the new one keeps
those events out of the process to begin with.
