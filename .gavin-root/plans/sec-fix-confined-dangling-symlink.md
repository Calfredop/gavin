---
kind: task
title: "[sec] WriteWorkspaceFile follows a dangling symlink out of the workspace root"
status: To Do
priority: low
complexity: simple
---
Fix a low-severity finding from the 2026-10-15 security audit (run-1). Fingerprint: `daemon-gavin-resolve_for_containment-dangling-symlink-write`.

Full record: `findings.json` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

The daemon's workspace-file containment (confined -> resolve_for_containment) canonicalises only the longest prefix that EXISTS, and it tests that with Path::exists, which follows symlinks. A symlink inside the root whose target does not exist yet therefore counts as a file not created yet: the check joins its canonical parent with the link's own name and judges that path inside the root. write_workspace_file then calls std::fs::write, which follows the link and creates the target wherever it points. A repository author can commit such a dangling symlink at a path gavin later writes on an ssh workspace host. Examples are the agent instructions file (CLAUDE.md / AGENTS.md / GEMINI.md, written by setup_agent_integration through RemoteFiles) or a top-level .gitignore saved through write_file_over_link. The result is a new file outside every workspace root, at a path the author chose, holding content gavin wrote, on the host machine. On that machine confined() is the only path guard. The effect is limited to creating a file. If the target already exists, the link resolves and is refused (observed). The target's parent directory must already exist. The content is gavin's (instructions block, MCP JSON, the user's ignore text), not the attacker's. .git/info/exclude cannot be pre-planted, because .git does not come from the clone.

## Root cause

resolve_for_containment (crates/daemon/src/gavin.rs:3095) loops `while !existing.exists()`. Path::exists follows symlinks and is false for a dangling link, so the link's name is moved into the unresolved suffix and appended to its canonical parent without being resolved. write_workspace_file (gavin.rs:3178) then writes with std::fs::write, an O_CREAT|O_TRUNC open that follows the link. It neither refuses a symlink leaf nor opens no-follow.

## The invariant to enforce

The doc comment on resolve_for_containment (gavin.rs:3084-3088) says a symlink inside the root that points outside resolves to where it leads and is judged there. A write through any symlink whose final destination is outside workspace_roots(root) must be refused, whether or not that destination exists yet. create_workspace_path already gets this right by opening with create_new (O_EXCL).

## Trace (lines as of 2026-10-16; re-read before editing)

- `crates/daemon/src/server.rs:6732` (handle_request Request::WriteWorkspaceFile): Passes root_path and the request's path straight to gavin::write_workspace_file; the dispatch decides nothing about paths. The desk host sends this request for ssh workspaces (app/src-tauri/src/remote.rs:417), and the path names a repository-controlled file such as CLAUDE.md.
- `crates/daemon/src/gavin.rs:3128` (confined): Refuses a `..` component lexically, then calls resolve_for_containment(absolute_in(root, path)) and accepts the result if inside_root holds for any of workspace_roots(root).
- `crates/daemon/src/gavin.rs:3095` (resolve_for_containment): `while !existing.exists()` is false-negative for a dangling symlink, so the link's leaf name is pushed into the unresolved suffix and appended to the canonical parent, which lies inside the root, so the containment check passes.
- `crates/daemon/src/gavin.rs:3178` (write_workspace_file): std::fs::write(&resolved, content) follows the in-root link and creates its target outside every workspace root.

## Fix

Decide containment without following the leaf. In resolve_for_containment, stop the walk at a prefix that exists as a directory entry (symlink_metadata), so a dangling link reaches canonical_path and fails closed. Also refuse a symlink leaf in write_workspace_file, which narrows the check-then-write window. On unix, opening with O_NOFOLLOW closes that window fully. The desk host's local resolve_for_containment (app/src-tauri/src/fileviewer.rs) uses the same walk and should get the same change. Add a gavin.rs regression test with a dangling-link fixture that expects a refusal and no file created outside the root.

`crates/daemon/src/gavin.rs`, as a sketch only:

```
fn resolve_for_containment(path: &Path) -> anyhow::Result<PathBuf> {
    if !path.is_absolute() {
        anyhow::bail!("{} is not an absolute path", path.display());
    }
    let mut existing = path;
    let mut suffix: Vec<&std::ffi::OsStr> = Vec::new();
    // symlink_metadata, not exists(): a DANGLING link is an entry that
    // exists, and canonical_path then fails on it instead of the link's
    // name being judged as a file not created yet.
    while existing.symlink_metadata().is_err() {
        let name = existing
            .file_name()
            .ok_or_else(|| anyhow::anyhow!("{} could not be resolved", path.display()))?;
        suffix.push(name);
        existing = existing
            .parent()
            .ok_or_else(|| anyhow::anyhow!("{} could not be resolved", path.display()))?;
    }
    let mut canonical = protocol::canonical_path(existing)?;
    for name in suffix.into_iter().rev() {
        canonical.push(name);
    }
    Ok(canonical)
}

pub fn write_workspace_file(root: &Path, path: &str, content: &str) -> anyhow::Result<()> {
    let resolved = confined(root, path)?;
    if let Some(parent) = resolved.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if std::fs::symlink_metadata(&resolved).is_ok_and(|m| m.file_type().is_symlink()) {
        anyhow::bail!("{path} is a symlink; refusing to write through it");
    }
    std::fs::write(&resolved, content)?;
    Ok(())
}
```

## Done when

- The fix enforces the invariant above at the last trusted decision point, not in a caller.
- The regression cases named in the fix are tests in the touched crate or module, and they fail before the change.
- The checks in CLAUDE.md pass for every part you touched.
- The audit reproduction no longer works. It is the record's `execution` field in `findings.json`.
- Follow the CLAUDE.md traps that apply: a new SQLite column needs its own `ALTER TABLE`, a widened request needs a compat-gate entry, and you commit only your own files.
