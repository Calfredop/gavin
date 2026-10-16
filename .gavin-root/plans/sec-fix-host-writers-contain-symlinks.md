---
kind: task
title: "[sec] A cloned repository's committed symlinks redirect gavin's setup and .gitignore writes to arbitrary user files outside the workspace"
status: To Do
priority: medium
complexity: complex
---
Fix a medium-severity finding from the 2026-10-15 security audit (run-1). Fingerprint: `app/src-tauri/workspace-relative-writers-follow-committed-symlinks`.

Full record: `findings.json` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

During agent-integration setup and the git-tracking switch, the desktop host writes fixed or config-named paths under a workspace root. These are CLAUDE.md (or the [agent] file), the profile's MCP config (.mcp.json, .codex/config.toml, .cursor/, .gemini/, opencode), the .claude/skills/*/SKILL.md files and their .replaced backups, the Playwright MCP entry, .gavin-root/config.toml and .gitignore. Each write is root.join(rel) followed by a path-based std::fs::read plus std::fs::write or create_dir_all. Nothing checks the leaf or any intermediate component for a symlink, and the CLAUDE.md check canonicalises only the parent. A repository that commits a symlink at one of those paths therefore makes gavin append to, merge into or wholesale overwrite any file the user can write outside the workspace. For .gitignore, a non-UTF-8 target is destroyed outright. A symlinked directory such as .claude also makes gavin create whole skill trees at the target. Targets include shell rc files, ~/.claude/ (global skills), ~/.claude.json or ~/.codex/config.toml (a persistent gavin MCP entry in the global agent config), ~/.ssh/authorized_keys and binary databases. For a symlinked skill leaf, the displaced target bytes are also copied into the repository working tree as SKILL.md.replaced. The human approved setting up gavin in that folder, not writing to these files. Nothing in the flow shows the resolved destination, and the foreign-MCP disclosure names the unresolved <root>/.mcp.json path. The bytes written are gavin's own content, not the attacker's. The 2026-09-08 design review (docs/security/03-agent-surface.md:316-319) saw the symlinked-directory case and set it aside as an A1 prerequisite. That misfiles it: the same threat model's A2 includes a cloned repo's shipped content, and git materialises committed symlinks on clone, so no same-user process is needed.

## Root cause

The workspace-relative writers in app/src-tauri resolve destinations with Path::join. The only checks are a lexical component check (usable_mcp_path), a canonicalisation of the parent alone (validate_agent_file_path), or nothing (write_managed_file, write_root_config_key, tracking::set, write_repo_file). The writers then do path-based std::fs::read/write/create_dir_all, which follow symlinks at the leaf and at every intermediate directory. tracking::read_gitignore and write_root_config_key also treat any read error (non-UTF-8, EACCES) as an empty file and then overwrite the file.

## The invariant to enforce

A setup or tracking write to a workspace-relative path must land inside the canonical workspace root or be refused. A symlink at the leaf or at any intermediate component that resolves outside the root must be refused, and the final open must not follow a symlink swapped in later (O_NOFOLLOW on the resolved path). An existing file that cannot be read as text must abort the write rather than be replaced. The code states this promise itself. agent_setup.rs:1918-1919 records, citing 03-agent-surface.md, that gavin's own writes cannot be redirected. validate_agent_file_path's doc (301-304) says it canonicalises so that a symlinked directory leading out of the root is caught, a check that skips the leaf and every other writer. The design doc's own exception for symlinks (03-agent-surface.md:318-319) rests on the wrong adversary: a committed symlink is cloned-repo content (A2), not a same-user process (A1).

## Trace (lines as of 2026-10-16; re-read before editing)

- `app/src-tauri/src/agent_setup.rs:2998` (setup_agent_integration): Tauri command. The setup wizard invokes it (IntegrationStep.svelte:81, PrdStep.svelte:102), and so does Re-run setup, on the workspace root the human opened. It is also Device-callable (remote_commands.rs:227). A local root dispatches run_integration with LocalFiles (3037-3038).
- `app/src-tauri/src/agent_setup.rs:3112` (run_integration): Always writes the instructions block first, for every profile. instructions_file defaults to the profile's CLAUDE.md/AGENTS.md. Nothing in run_integration checks for a symlink.
- `app/src-tauri/src/agent_setup.rs:307` (validate_agent_file_path): Checks lexical components and then canonicalises only the PARENT (323-327). A symlinked leaf such as CLAUDE.md -> ../../.zshrc passes, because its parent is the root.
- `app/src-tauri/src/agent_setup.rs:2205` (write_instructions_block): path = root.join(instructions_file). It reads the symlink target (2206), appends the gavin marker block (2222) and writes it back (2228).
- `app/src-tauri/src/agent_setup.rs:2153` (write_managed_file): path = root.join(file.dir).join(file.file) for .claude/skills/gavin/SKILL.md and its siblings. A symlinked .claude directory or SKILL.md leaf is followed.
- `app/src-tauri/src/agent_setup.rs:2134` (write_owned): Reads the target through the path (2128) and copies the displaced bytes to <path>.replaced, which stays inside the repo when only the leaf is a symlink. It then overwrites the target wholesale with the skill text (2139).
- `app/src-tauri/src/agent_setup.rs:2002` (write_mcp_config): path = root.join(&layout.config_file). The foreign-server check (3151) reads the same symlinked path. When the target has no other servers in that container, the merge proceeds without a disclosure.
- `app/src-tauri/src/agent_setup.rs:2058` (write_mcp_config_json): Re-serialises the symlink target (e.g. ~/.claude.json) with mcpServers.gavin inserted. The command is the absolute gavin-mcp binary, or MCP_LAUNCHER when the root carries crates/gavin-mcp/Cargo.toml and the launcher file (mcp_command, 1932-1938).
- `app/src-tauri/src/agent_setup.rs:237` (LocalFiles::write_bytes): std::fs::create_dir_all(parent) + std::fs::write(path) (238-241). Both follow symlinks at the leaf and at every intermediate component.

## Fix

Route every workspace-relative read and write in these writers through one containment helper. The helper rejects any non-Normal component, canonicalises the deepest existing prefix (leaf included when it exists) and requires the result to stay under the canonical root. That refuses a symlink, at any level, that leads out of the root, while an in-root alias such as CLAUDE.md -> AGENTS.md keeps working. The helper creates missing directories itself with create_dir, one component at a time, and the leaf is then opened at the resolved path with O_NOFOLLOW (read and write), so a symlink swapped in afterwards fails with ELOOP. Apply it in write_mcp_config and the Playwright write_mcp_server caller (agent_setup.rs:2002, agent_playwright.rs:591), in write_managed_file and the .replaced backup, and in write_instructions_block (replacing the parent-only check). Apply it also in write_root_config_key, remove_mcp_entry, tracking::set and the local branch of write_repo_file. Make tracking::read_gitignore and write_root_config_key abort on any read error other than NotFound instead of treating it as empty. RemoteFiles needs the same rule on the host side. Add regression tests that plant a symlinked leaf and a symlinked parent directory pointing outside a tempdir for each writer and assert an error and an unchanged target. Add one that keeps an in-root symlink working, and one that plants a non-UTF-8 .gitignore and asserts that tracking::set errors. Correct 03-agent-surface.md:316-319 so the symlink case is filed under A2.

`app/src-tauri/src/agent_setup.rs`, as a sketch only:

```
/// The destination for a write gavin makes INSIDE a workspace. A cloned
/// repo can commit a symlink at any path gavin writes, so the path is
/// resolved here and must stay under the canonical root; an in-root alias
/// (CLAUDE.md -> AGENTS.md) is allowed, one leading out is refused.
pub(crate) fn contained_dest(root: &Path, rel: &Path) -> anyhow::Result<PathBuf> {
    let root_c = std::fs::canonicalize(root)?;
    let parts: Vec<_> = rel.components().collect();
    if parts.is_empty() || !parts.iter().all(|c| matches!(c, std::path::Component::Normal(_))) {
        anyhow::bail!("{} is not a plain path inside the workspace", rel.display());
    }
    let mut cur = root_c.clone();
    for (i, c) in parts.iter().enumerate() {
        cur.push(c.as_os_str());
        let last = i + 1 == parts.len();
        match std::fs::symlink_metadata(&cur) {
            Ok(_) => {
                // Resolve whatever is there (a symlink included) and require
                // the result to stay inside the root.
                let resolved = std::fs::canonicalize(&cur)?;
                if !resolved.starts_with(&root_c) {
                    anyhow::bail!("{} leads outside the workspace; gavin will not write through it", cur.display());
                }
                if !last && !resolved.is_dir() {
                    anyhow::bail!("{} is not a directory", cur.display());
                }
                cur = resolved;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && !last => std::fs::create_dir(&cur)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(cur)
}

// LocalFiles::read_bytes / write_bytes for workspace paths open the leaf with
// std::os::unix::fs::OpenOptionsExt::custom_flags(libc::O_NOFOLLOW), so a
// symlink swapped in after contained_dest fails with ELOOP.
// Callers: write_mcp_config -> contained_dest(root, Path::new(&layout.config_file))?;
// write_managed_file -> contained_dest(root, &Path::new(file.dir).join(file.file))?;
// write_instructions_block -> contained_dest(root, Path::new(instructions_file))?;
// write_root_config_key -> contained_dest(root, Path::new(".gavin-root/config.toml"))?
//   and `match std::fs::read_to_string(&path) { Ok(s) => s, Err(e) if e.kind() == NotFound => String::new(), Err(e) => return Err(e.into()) }`.
```

`app/src-tauri/src/git/tracking.rs`, as a sketch only:

```
fn read_gitignore(root: &str) -> Result<String, String> {
    let path = crate::agent_setup::contained_dest(std::path::Path::new(root), std::path::Path::new(".gitignore"))
        .map_err(|e| e.to_string())?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("could not read .gitignore: {e}")),
    }
}
// set(): let before = read_gitignore(root)?; and write the contained path with an
// O_NOFOLLOW open instead of std::fs::write(&gitignore_path(root), ..).
```

## Also covers

write_claude_md_excludes (app/src-tauri/src/git/commands.rs:334-362) runs after every worktree_add. It reads and rewrites <worktree>/.claude/settings.local.json through read_repo_file/write_repo_file (app/src-tauri/src/git/run.rs:410-431), so a symlink committed on the checked-out branch reaches the same sink. prepare_worktrees_dir (app/src-tauri/src/git/commands.rs:288-297) runs before every worktree_add and writes <root>/.gavin-worktrees/.gitignore the same way, so a committed .gavin-worktrees directory symlink gets '*' written at its target. Fixing write_repo_file covers both; each needs its own regression test (a branch committing .claude -> outside, and a root committing .gavin-worktrees -> outside).

## Done when

- The fix enforces the invariant above at the last trusted decision point, not in a caller.
- The regression cases named in the fix are tests in the touched crate or module, and they fail before the change.
- The checks in CLAUDE.md pass for every part you touched.
- The audit reproduction no longer works. It is the record's `execution` field in `findings.json`.
- Follow the CLAUDE.md traps that apply: a new SQLite column needs its own `ALTER TABLE`, a widened request needs a compat-gate entry, and you commit only your own files.
