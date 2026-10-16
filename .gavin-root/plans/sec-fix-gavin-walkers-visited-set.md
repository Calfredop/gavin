---
kind: task
title: "[sec] The workspace .gavin scan and the plans-tree walk follow directory-symlink loops inside the repo with no visited set or depth cap, so the work grows exponentially in the shared daemon"
status: To Do
priority: medium
complexity: moderate
---
Fix a medium-severity finding from the 2026-10-15 security audit (run-1). Fingerprint: `crates/daemon/src/gavin.rs:list_md_files:symlink-loop-unbounded-descent`.

Full record: `findings.json` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

When a workspace is watched, the daemon runs scan_root -> build_context -> list_md_files over .gavin-root/plans, docs and specs. WatchGavinRoot is sent when the desk opens a workspace, and the scan runs again on every debounced rescan. list_md_files recurses into every directory that safe_to_descend allows. That check only refuses a symlink whose canonical target leaves the repository root, so a committed self-link such as plans/a -> . is followed again at every level. The walk keeps no set of directories already visited and has no depth or entry cap. It stops only when one path lookup hits the kernel's symlink-resolution limit (33 self-link components were measured on this macOS host) or when the path reaches MAXPATHLEN. With N self-links, the number of directories visited, and of card entries read, stored and serialised, is (N^(d+1)-1)/(N-1). Verified against the daemon built from the current tree (protocol v75), with a 29-byte repo prefix and 100-character link names: one real card was reported 1, 10, 1,023 and 29,524 times for 0, 1, 2 and 3 links. The 3-link GavinTreeChanged push was 37,924,498 bytes and took 7.34 s; the 2-link push was already over the 1 MiB protocol line cap. The desk's push reader (app/src-tauri/src/session.rs:5456) uses read_message, so an over-cap line is treated as a lost daemon connection, and that connection also carries PTY output. This was read in source, not exercised. With 1-character names the depth limit is about 33 levels, so two links mean about 2^33 visits, all pushed into one Vec. That is effectively non-terminating and memory-unbounded; it was not run. The same unguarded descent is in plans_tree_files/find_in_plans_tree (gavin.rs:1169/1194), which also has no containment check. CreatePlan's uniqueness check took 1.43 s on the 3-link fixture. scan_root's own walk is capped at depth 12 but has no visited set either.

## Root cause

safe_to_descend (gavin.rs:2179) checks containment, not cycles. The .gavin* walkers recurse on is_dir() without recording canonical directories already visited. list_md_files (gavin.rs:2270) and plans_tree_files (gavin.rs:1169) also have no depth or entry ceiling, and plans_tree_files has no containment check at all. A symlink loop whose target stays inside the root passes the check and is descended until the OS symlink or path-length limit.

## The invariant to enforce

Scanning a repository-supplied .gavin* tree must cost no more than the real directory tree. Each real directory is visited at most once, or directory symlinks are not descended inside .gavin* trees at all. A depth cap and an aggregate entry cap apply, so cost is linear in the files that exist and the push stays under MAX_LINE_BYTES. A fix that only tightens safe_to_descend does not stop loops that stay inside the root.

## Trace (lines as of 2026-10-16; re-read before editing)

- `crates/daemon/src/server.rs:8384` (serve_connection request loop): WatchGavinRoot { workspace_id, root_path } is intercepted and watch_gavin_root runs on a spawned thread. The desk sends it for each workspace it opens. The root holds repository content, possibly a cloned hostile repo; the lower-trust input is that repo's committed symlinks.
- `crates/daemon/src/server.rs:4040` (SessionManager::watch_gavin_root): Starts GavinWatcher for the root with a scan hook that also feeds the card index.
- `crates/daemon/src/gavin.rs:2858` (GavinWatcher::start): Calls rescan_and_push for the initial push; filesystem events call it again (2846).
- `crates/daemon/src/gavin.rs:2973` (GavinWatcher::rescan_and_push): scan_root(&self.root_path) runs with the watcher's inner lock held, then serialises the whole tree as one GavinTreeChanged line.
- `crates/daemon/src/gavin.rs:2313` (build_context): list_md_files(&gavin_dir.join("plans"), root) runs, then every listed path is stat'ed and read and a PlanFileInfo is built for it. docs and specs use the same walker (2329-2330).
- `crates/daemon/src/gavin.rs:2271` (list_md_files::walk): For each entry with path.is_dir(), recurses whenever safe_to_descend (2179) allows. That function returns true for any symlink whose canonical target is under the root, so plans/a -> . is always descended. There is no depth parameter, no visited set and no entry cap, so `out` grows as N^depth.

## Fix

Make every .gavin* walker linear in the real tree: list_md_files, plans_tree_files/find_in_plans_tree, scan_root's walk and the watch-target walk. Prefer not descending directory symlinks at all inside .gavin* trees, using entry.file_type(), which does not follow links. Failing that, keep a set of canonical directories already visited. Add a depth cap matching MAX_SCAN_DEPTH and an aggregate entry cap that reports truncation as a parse warning. Give plans_tree_files the same containment check. Tightening safe_to_descend alone does not help, because the loop stays inside the root. Regression tests: plans/a -> . and plans/b -> . must report exactly one plan; a 1-character self-link must return promptly; CreatePlan against that tree must stay constant-time in the link count.

`crates/daemon/src/gavin.rs`, as a sketch only:

```
const MAX_MD_FILES: usize = 10_000;

fn list_md_files(dir: &Path, boundary: &Path) -> Vec<MdFileInfo> {
    fn walk(
        dir: &Path,
        base: &Path,
        boundary: &Path,
        depth: usize,
        seen: &mut std::collections::HashSet<PathBuf>,
        out: &mut Vec<MdFileInfo>,
    ) {
        if depth > MAX_SCAN_DEPTH || out.len() >= MAX_MD_FILES {
            return;
        }
        // A directory reached twice (a symlink loop, or two links to one
        // folder) is walked once: cost follows the real tree.
        let Ok(real) = dir.canonicalize() else { return };
        if !seen.insert(real) {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if safe_to_descend(&path, boundary) {
                    walk(&path, base, boundary, depth + 1, seen, out);
                }
            } else if path.extension().map(|e| e == "md").unwrap_or(false) && out.len() < MAX_MD_FILES {
                out.push(MdFileInfo {
                    path: protocol::wire_path(&path),
                    rel_path: protocol::wire_path(path.strip_prefix(base).unwrap_or(&path)),
                });
            }
        }
    }
    if !safe_to_descend(dir, boundary) {
        return Vec::new();
    }
    let mut out = Vec::new();
    walk(dir, dir, boundary, 0, &mut std::collections::HashSet::new(), &mut out);
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    out
}
// Apply the same canonical `seen` set to scan_root's walk, watch_targets'
// walk and plans_tree_files, and give plans_tree_files the MAX_SCAN_DEPTH cap
// and a safe_to_descend(&path, plans_root) check.
```

## Done when

- The fix enforces the invariant above at the last trusted decision point, not in a caller.
- The regression cases named in the fix are tests in the touched crate or module, and they fail before the change.
- The checks in CLAUDE.md pass for every part you touched.
- The audit reproduction no longer works. It is the record's `execution` field in `findings.json`.
- Follow the CLAUDE.md traps that apply: a new SQLite column needs its own `ALTER TABLE`, a widened request needs a compat-gate entry, and you commit only your own files.
