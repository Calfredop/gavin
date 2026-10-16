---
kind: task
title: "[sec] Daemon writers of .gavin-root/config.toml and plan cards follow repository-committed symlinks and write outside the workspace"
status: To Do
priority: low
complexity: moderate
---
Fix a low-severity finding from the 2026-10-15 security audit (run-1). Fingerprint: `daemon/gavin.rs/fixed-path-writers-follow-repo-committed-symlinks`.

Full record: `findings.json` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

A cloned repository can commit .gavin-root/config.toml as a symlink, either dangling or pointing at an existing TOML file, to any path relative to the clone. It can also commit .gavin-root/plans as a directory symlink. When the human then uses ordinary gavin features in that workspace, the shared daemon writes through those links with plain std::fs calls. The features are the setup wizard's Agent step (which writes `profile` once its PATH sweep suggests a different profile), Settings agent/model/effort/PRD fields, Add or Remove context, and creating a card. The result is a new file at a path the repository chose, or an in-place edit of an existing TOML file the human owns outside the workspace. Card files likewise land in an outside directory while the board shows nothing. The scan path already treats a symlink leaving the root as hostile (safe_to_descend, DP-05), but no writer applies the equivalent check. Written content is gavin's fixed TOML or card shape carrying values the human chose. The attacker controls only where it lands.

## Root cause

set_root_config_field (crates/daemon/src/gavin.rs:1906-1968), add_external_context (2118-2148), remove_external_context (2155-2167) and create_plan_file (941-1090) build their targets as root.join(fixed relative path) and call std::fs::read_to_string, create_dir_all and write on them. Nothing checks whether a component or the leaf is a symlink resolving outside the root. A dangling leaf reads as empty (unwrap_or_default at 1949), so the write at 1967 creates the link's target. confine_root_path (2048) confines only the root argument and is applied only to AddExternalGavinContext; the DP-05 safe_to_descend guard (2179) is applied only to scan descent (2276, 2287, 2365, 2387, 2576).

## The invariant to enforce

A write that gavin makes on the human's behalf into a workspace's .gavin* tree must land inside that workspace. A committed symlink whose resolved target leaves the root, or a dangling one whose target would be created, must be refused with an error, the same way the scan refuses to descend such a link.

## Trace (lines as of 2026-10-16; re-read before editing)

- `app/src/lib/wizardSteps/AgentStep.svelte:122` (AgentStep $effect): The setup wizard's Agent step calls setAgentField(workspaceId, "profile", main) by itself when the PATH sweep's suggested profile differs from the configured one and no command is set. Settings (layoutState.ts:2810, 2856-2858, 2880), Add/Remove context (PlanExplorerHubView.svelte:338, 455) and card creation (PlanExplorerHubView.svelte:303, CardComposeModal.svelte:313) are the other human entries.
- `app/src/lib/core/layoutState.ts:2810` (setAgentField): Forwards the workspace's rootPath with the human-chosen key and value to backend.setRootConfigField (backend.ts:1666), the Tauri set_root_config_field command (app/src-tauri/src/session.rs:7804), which sends Request::SetRootConfigField to the daemon unchanged.
- `crates/daemon/src/server.rs:6698` (handle_request SetRootConfigField): Calls gavin::set_root_config_field with root_path unchanged. There is no confinement and no final-path check (AddExternalGavinContext at 6681 confines only the root via confine_root_path; RemoveExternalGavinContext at 6688 and CreatePlan at 6786 pass straight through).
- `crates/daemon/src/gavin.rs:1948` (set_root_config_field): Builds root/.gavin-root/config.toml and reads it with read_to_string(...).unwrap_or_default() at 1949: a committed dangling symlink reads as an empty document, a link to an existing TOML file reads that file.
- `crates/daemon/src/gavin.rs:1967` (set_root_config_field): std::fs::write(&path, doc.to_string()) follows the symlink, creating the dangling target or rewriting the outside file. The same sink pattern is at 1933 (clear), 2147 (add_external_context), 2166 (remove_external_context) and 1089 (create_plan_file under a symlinked plans/ directory, create_dir_all at 1035/1055).

## Fix

Apply the DP-05 rule to writes. Before any write into a workspace's .gavin* tree, walk each component from the root with symlink_metadata. Refuse a symlink whose canonical target leaves the canonical root, and refuse a dangling one (it would create its target). Do this in set_root_config_field (both writes), add_external_context, remove_external_context, create_plan_file (for plans/, done/ and the leaf) and init_gavin_root's scaffold, config and PRD targets. Regression tests: a dangling and an outside-pointing config.toml symlink make set_root_config_field and add/remove_external_context return Err and leave the outside file byte-identical. A plans/ symlink leaving the root makes create_plan_file return Err with nothing written outside. An in-root symlink is still accepted.

`crates/daemon/src/gavin.rs`, as a sketch only:

```
/// DP-05 for writes: refuses a target when it, or any directory between
/// `root` and it, is a symlink resolving outside `root` -- or a dangling
/// one, whose write would create the link's target wherever it points.
fn confine_write_target(root: &Path, target: &Path) -> anyhow::Result<()> {
    let canonical_root = root.canonicalize()?;
    let rel = target
        .strip_prefix(root)
        .map_err(|_| anyhow::anyhow!("{} is outside {}", target.display(), root.display()))?;
    let mut at = root.to_path_buf();
    for comp in rel.components() {
        at.push(comp);
        match std::fs::symlink_metadata(&at) {
            Ok(m) if m.file_type().is_symlink() => {
                let resolved = at
                    .canonicalize()
                    .map_err(|_| anyhow::anyhow!("{} is a dangling symlink", at.display()))?;
                if !resolved.starts_with(&canonical_root) {
                    anyhow::bail!("{} is a symlink leaving the workspace", at.display());
                }
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

// set_root_config_field / add_external_context / remove_external_context, before reading:
//     confine_write_target(root, &path)?;
// create_plan_file, before create_dir_all(&plans) and before the final write:
//     confine_write_target(context_folder, &plans)?;
//     confine_write_target(context_folder, &path)?;
// init_gavin_root, before each create_dir_all/write (gavin_dir, config, prd):
//     confine_write_target(root, &prd)?;
```

## Done when

- The fix enforces the invariant above at the last trusted decision point, not in a caller.
- The regression cases named in the fix are tests in the touched crate or module, and they fail before the change.
- The checks in CLAUDE.md pass for every part you touched.
- The audit reproduction no longer works. It is the record's `execution` field in `findings.json`.
- Follow the CLAUDE.md traps that apply: a new SQLite column needs its own `ALTER TABLE`, a widened request needs a compat-gate entry, and you commit only your own files.
