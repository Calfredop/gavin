---
kind: task
title: "[sec] The workspace delete wizard trashes and edits gavin files outside the workspace root through committed directory and file symlinks"
status: To Do
priority: low
complexity: moderate
---
Fix a low-severity finding from the 2026-10-15 security audit (run-1). Fingerprint: `app/src-tauri/workspace-delete-scan-follows-committed-symlinks-out-of-root`.

Full record: `findings.json` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

The delete wizard's scan (scan_with_default) follows directory symlinks committed in the workspace and never checks that they stay inside the root. walk_contexts uses entry_is_dir, which stats a symlink and follows it, so it descends a non-dot-prefixed linked directory such as vendor -> ../other-project. The skill listing calls read_dir on <root>/.claude/skills (or .opencode/skills), which resolves through a symlinked .claude. The scan reports what it finds under the unresolved in-root spelling: <root>/vendor/.gavin with outside:false, and <root>/.claude/skills/gavin*. defaultAnswers ticks skills and every outside:false context, and the wizard shows only the in-root spelling. The remover's only path control is to intersect the plan with a fresh run of the same scan, so these paths are allowed. trash_path then hands each one to trash 5.2.6, which resolves the parent (canonicalize_paths) and passes realpath(parent)/leaf to NSFileManager trashItemAtURL. The real directory outside the root is moved to the Trash. Examples are the user's global ~/.claude/skills/gavin* skills, or another project's .gavin with its cards. The completion report still names the in-root spelling. Any path-based OS call would follow the intermediate link, so the crate's canonicalisation is not the cause; it only makes the outcome certain. Shared-file edits have the same gap. remove_instructions_block and remove_mcp_entry std::fs::write through a symlinked CLAUDE.md, .mcp.json or .codex/config.toml. gavin_install also builds the instructions path with root.join() on the committed .gavin-root/config.toml [agent] file and never calls validate_agent_file_path, so an absolute value names any file. The setup-time writer refuses that value (line 2204). The daemon's own context walk refuses outward directory links (safe_to_descend, DP-05), and the host mirror's doc comment says the two walks match. In the same fixture the daemon walk reported no contexts. Correction to the hunter: the self-link amplification claim (k links to '.') is dropped from this finding. The daemon's scan_root has the same shape, because safe_to_descend accepts a link to '.' (it resolves inside the root) and the walk has no visited set. The independent model measured identical read_dir counts for host and daemon. That is a separate, shared root cause, not the containment gap this record describes.

## Root cause

workspace_delete.rs builds the removable set with symlink-following checks (entry_is_dir at 167-173, Path::is_dir, and read_dir of root.join(skill_dir) at 282-288). It never checks that a reported path's canonical parent stays inside the canonical root, unlike the daemon's safe_to_descend. The remover re-runs the same scan to decide what is allowed, and the path-based trash sink acts on the resolved location. The agent_setup removal helpers write through a configured or symlinked path with no containment check. gavin_install skips validate_agent_file_path, which the setup writer applies.

## The invariant to enforce

Only gavin's own files physically inside the workspace root are offered, removed or edited. The module's rule that 'a path the scan did not report cannot be removed' should mean that the reported path is the one acted on. Directory symlinks that leave the root are neither descended nor listed, as in the daemon's scan_root. Shared-file edits refuse targets that resolve outside the root, and the [agent] file is validated as it is at write time. The only outside paths the wizard touches are explicit extra_contexts entries, which are marked outside and left unticked.

## Trace (lines as of 2026-10-16; re-read before editing)

- `app/src-tauri/src/workspace_delete.rs:426` (scan_gavin_footprint (Tauri command)): The desk wizard asks for the footprint of a workspace root, which can be a cloned repository. The root holds committed symlinks such as .claude -> ../../.claude and vendor -> ../other-project. Device reach is refused (remote_commands.rs:260-261).
- `app/src-tauri/src/workspace_delete.rs:282` (scan_with_default skill listing): read_dir(install.skill_root), where skill_root is root.join(".claude/skills") (agent_setup.rs:3291), follows a symlinked .claude. Every gavin* entry that passes path.is_dir() (line 286) is pushed as <root>/.claude/skills/gavin*.
- `app/src-tauri/src/workspace_delete.rs:169` (entry_is_dir / walk_contexts): A symlinked directory entry is stat'ed and followed. walk_contexts (178-198) skips only dot-prefixed and excluded names, so it descends a link like vendor and pushes <link>/.gavin (line 190) with no containment check. The daemon's walk refuses it with safe_to_descend (crates/daemon/src/gavin.rs:2179-2188, 2387).
- `app/src-tauri/src/workspace_delete.rs:323` (scan_with_default contexts): Each walked context is reported as <root>/<link>/.gavin with outside:false. wire_path only normalises separators (protocol lib.rs:5749-5751) and never resolves links.
- `app/src/lib/workspace/workspaceDelete.ts:231` (defaultAnswers / plannedRemovals): Skills and every outside:false context are ticked by default. plannedRemovals (261-285) puts them in trash. The wizard renders the unresolved spelling (WorkspaceDeleteWizard.svelte:208-209, 245).
- `app/src-tauri/src/workspace_delete.rs:371` (remove_with_default): confirm_gate::spend binds only the root string (line 457). The remover re-runs the same link-following scan (366) and allows every path it reports (371-377).
- `app/src-tauri/src/trash.rs:24` (trash_path): ctx.delete(path) reaches trash 5.2.6. canonicalize_paths (src/lib.rs:247-251) returns realpath(parent)/leaf, and delete_using_file_mgr (src/macos/mod.rs:85-100) calls trashItemAtURL on it. The real directory outside the root is moved to the Trash.

## Fix

Bind the removable set to the canonical root. In walk_contexts, never descend a symlinked directory, as safe_to_descend does. A symlinked .gavin leaf can still be reported, because trashing a leaf moves only the link. In scan_with_default, compute root_canonical once. Drop any reported path (gavin_root, skills, agent_file, contexts, mcp, instructions) whose canonical parent is not inside root_canonical, and skip the skill listing when skill_root's canonical form leaves the root. Repeat the check in remove_with_default immediately before each trash_path and each edit, so the decision sits next to the sink. Have gavin_install validate the [agent] file with validate_agent_file_path and fall back to the profile default. Have the edit helpers refuse a symlinked leaf. Regression test: a tempdir with outside/.claude/skills/gavin and outside/proj/.gavin, and the root links .claude -> ../outside/.claude and vendor -> ../outside/proj. Assert that scan omits both, and that remove() given those paths reports them failed and leaves both outside directories in place.

`app/src-tauri/src/workspace_delete.rs`, as a sketch only:

```
/// True when `path` will be acted on inside `root_canonical`: the trash
/// crate (and any path-based OS call) resolves the PARENT and keeps the
/// leaf, so the parent is what must resolve inside the root.
fn resolves_inside(path: &Path, root_canonical: &Path) -> bool {
    path.parent()
        .and_then(|p| p.canonicalize().ok())
        .is_some_and(|p| p.starts_with(root_canonical))
}

fn walk_contexts(dir: &Path, depth: usize, found: &mut Vec<PathBuf>) {
    if depth > MAX_SCAN_DEPTH { return; }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name == GAVIN_DIR && path.is_dir() { found.push(path); continue; } // a linked leaf trashes only the link
        if kind.is_symlink() || !kind.is_dir() { continue; } // never descend a link
        if name == GAVIN_ROOT_DIR || EXCLUDED_DIRS.contains(&name.as_str()) || name.starts_with('.') { continue; }
        walk_contexts(&path, depth + 1, found);
    }
}

// scan_with_default, after the root check:
//   let root_canonical = root.canonicalize().map_err(|e| e.to_string())?;
//   skills.retain(|p| resolves_inside(p, &root_canonical));
//   inside.retain(|p| resolves_inside(p, &root_canonical));
//   require resolves_inside (and a non-symlink leaf) for agent_file, mcp path and instructions.
// remove_with_default, before each trash_path / edit:
//   if !resolves_inside(Path::new(path), &root_canonical) { report.failed.push((path.clone(), "resolves outside the workspace".into())); continue; }
```

`app/src-tauri/src/agent_setup.rs`, as a sketch only:

```
// gavin_install: validate the configured instructions file the way the writer does
let file = resolved_instructions_file(&LocalFiles, root, profile);
let instructions = if validate_agent_file_path(&LocalFiles, root, &file).is_ok() {
    root.join(&file)
} else {
    root.join(profile.instructions_file)
};
// remove_instructions_block / remove_mcp_entry: refuse a symlinked leaf
if std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
    anyhow::bail!("{} is a symlink -- left alone", path.display());
}
```

## Done when

- A regression test with outside/.claude/skills/gavin and outside/proj/.gavin, linked from the root as .claude -> ../outside/.claude and vendor -> ../outside/proj: scan omits both, and remove() given those paths reports them failed and leaves both outside directories in place.
- gavin_install validates the [agent] file with validate_agent_file_path, and remove_instructions_block/remove_mcp_entry refuse a symlinked leaf.
- The fix enforces the invariant above at the last trusted decision point, not in a caller.
- The regression cases named in the fix are tests, and they fail before the change.
- The checks in CLAUDE.md pass for every part you touched, and you commit only your own files.
