---
order: 33792
kind: task
title: "[sec] A cloned repository's committed extra_contexts makes the daemon hand another workspace's cards to agents through ScanGavinRoot and gavin_get_tree/gavin_find_cards"
status: Done
priority: low
complexity: moderate
---
Fix a low-severity finding from the 2026-10-15 security audit (run-1). Fingerprint: `crates/daemon/src/gavin.rs:scan_root:repo-committed-extra-contexts-disclosed-to-agent`.

Full record: `findings.json` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

scan_root appends every absolute folder listed in the workspace's own .gavin-root/config.toml `extra_contexts` array as an `outside` context, provided the folder has a .gavin directory. Nothing checks where that value came from. config.toml ships with the repository, and the human's workspace-trust digest (trustedConfigHash) covers only [agent] command, [agent] file and [worktree] setup. A cloned repository can therefore name a gavin context folder elsewhere on the victim's disk. The attacker has to guess its absolute path, and only paths that exist with a .gavin directory show up. Every agent session in the clone that calls gavin_get_tree or gavin_find_cards then receives that folder's card paths, titles, statuses, labels, checklist counts, attachment lists, the text of its Decision/Human test items, and its docs/specs file names. The daemon refuses the same agent token's direct ScanGavinRoot of the victim folder (Forbidden), so the committed key widens what the agent role may read beyond its own workspace confinement, without the human's workspace-trust approval. The same raw list feeds cards_with_bodies, so SearchCards embeds the outside cards' bodies into the clone's per-root card index and ranks them for the agent's queries. That path returns only paths and scores and was not exercised locally. The result is disclosure only: scope_roots and agent_path_in_scope do not widen, so the outside cards cannot be written through the agent role.

## Root cause

parse_extra_contexts and scan_root (crates/daemon/src/gavin.rs:2095-2103, 2427-2443) treat a value committed to the repository's config.toml as if the human had registered those outside folders. The agent-role gate (server.rs:7324-7335) authorises ScanGavinRoot, SearchCards and GetBoardByRoot on the requested root alone, never on the folders the reply contains. The human's registration path (add_external_context) writes the same config key, so a registered folder and a committed one cannot be told apart, and workspaceTrust.ts does not cover the key.

## The invariant to enforce

An agent scoped to a workspace should receive only that workspace's cards, plus outside folders that the human on this machine registered for it (add_external_context from the app). The project's own security notes call these 'explicitly-registered extra_contexts' (docs/security/03-agent-surface.md:499). A value that arrives with a clone, a colleague's commit or a git pull should stay inert until approved, as the three execution keys already are.

## Trace (lines as of 2026-10-16; re-read before editing)

- `crates/daemon/src/gavin.rs:2428` (scan_root): When .gavin-root exists, scan_root reads extra_contexts from the repository's own .gavin-root/config.toml.
- `crates/daemon/src/gavin.rs:2095` (parse_extra_contexts): Returns every string in the top-level array as written. There is no provenance, approval or machine-local registration check.
- `crates/daemon/src/gavin.rs:2441` (scan_root): Each listed folder that is not lexically under the root and has a .gavin dir is built with build_context and pushed with outside=true.
- `crates/daemon/src/gavin.rs:2313` (build_context): Lists and parses <folder>/.gavin/plans/*.md (title, status, labels, checklist, human items, attachments) and the docs/specs listings of the outside folder.
- `crates/daemon/src/server.rs:7324` (agent_allows): ScanGavinRoot, SearchCards and GetBoardByRoot are allowed when agent_root_in_scope(root_path) holds. Only the requested root is checked, never the outside folders in the reply.
- `crates/daemon/src/server.rs:6702` (handle_request ScanGavinRoot): Returns scan_root's tree to the agent connection unfiltered.
- `crates/gavin-mcp/src/main.rs:1343` (find_cards / gavin_get_tree dispatch (main.rs:888)): gavin_get_tree and gavin_find_cards both send ScanGavinRoot for the session's root and render the full tree.
- `crates/gavin-mcp/src/cards.rs:242` (ContextView::of / find (cards.rs:403)): Outside contexts are serialised into the tool result, and so into the agent's model context: folderPath, card paths, titles, status, labels, checklist counts and docs/specs. find also emits the humanItems text.

## Fix

Stop treating the committed config.toml value as a registration. Keep a machine-local list of the outside folders the human registered, written only by add_external_context / AddExternalContext from the app role and keyed by canonical root. scan_root, workspace_roots and cards_with_bodies should honour an extra_contexts entry only when it appears in that list. An alternative is to add extra_contexts to the workspace-trust digest and have the daemon drop outside contexts from agent-role replies until the human approves. Regression case: a fresh root whose committed config names a sibling folder with .gavin gets no outside context from scan_root and none in an agent ScanGavinRoot reply. After add_external_context for that folder, it appears.

`crates/daemon/src/gavin.rs`, as a sketch only:

```
/// extra_contexts entries the HUMAN registered on this machine: present in
/// the root config AND in the machine-local registration list that only
/// add_external_context writes. A value that arrived with the repository
/// is inert until registered.
fn registered_extra_contexts(root: &Path) -> Vec<String> {
    let listed = parse_extra_contexts(&root.join(GAVIN_ROOT_DIR).join("config.toml"));
    let approved = crate::registry::registered_outside_contexts(root); // machine-local, per canonical root
    listed.into_iter().filter(|f| approved.iter().any(|a| a == f)).collect()
}
// scan_root: `let mut extras = registered_extra_contexts(root);`
// workspace_roots: `for extra in registered_extra_contexts(root) { ... }`
// add_external_context: after the config write, `crate::registry::register_outside_context(root, folder)?;`
// remove_external_context: also unregister.
```

Notes from the record verifier:
- The request is named `AddExternalGavinContext`.
- The `crate::registry` helpers do not exist yet.
- `registry-dev.sqlite` is per build, so a list kept there would not be shared by the dev and release daemons. Keep the list somewhere both share, such as `config.json` or `devices.sqlite`.

## Done when

- A committed `extra_contexts` value is inert until the human registers the folder on this machine.
- `scan_root`, `workspace_roots` and `cards_with_bodies` honour only registered entries.
- The regression case named in the fix is a test.
- If the list lives in SQLite, add an `ALTER TABLE` migration and a `pre_v*` test.
- The checks in CLAUDE.md pass, and you commit only your own files.
