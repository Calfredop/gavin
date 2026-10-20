---
order: 29696
kind: task
title: "[sec] gavin_read_prd and the .gavin* scan follow a committed symlink out of the workspace and return the outside file to the agent"
status: Done
priority: medium
complexity: moderate
---
Fix a medium-severity finding from the 2026-10-15 security audit (run-1). Fingerprint: `gavin-daemon/gavin.rs/read_prd/final-component-symlink-escapes-workspace-root`.

Full record: `findings.json` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

A repository can commit .gavin-root/PRD.md, or the path its config.toml names as `prd`, as a symlink to any file the user can read. The daemon's read_prd follows the link without checking that the resolved file is inside the workspace root. It returns the content (UTF-8, up to 1 MB) as the PRD. The agent role may send ReadPrd because the REQUESTED root is in the agent's scope. Nothing checks where the file that is actually read resolves. gavin-mcp's gavin_read_prd hands the content to the agent, and gavin's shipped skill tells every agent to call that tool first. Suppose a user opens a cloned repository as a gavin workspace and runs an agent there. A file outside the workspace then lands in the agent's context, and from there in the model provider's transcript. Examples are a key or credentials file at a guessable relative path. No prompt injection is needed. The tool call has a harmless-looking name, so a CLI permission prompt reads 'read the PRD' rather than naming the outside file. The .gavin* scan has the same gap for file-level entries. safe_to_descend confines symlinked DIRECTORIES for this reason, but its own comment says a symlinked FILE is unaffected. A committed plans/x.md symlink is therefore read into GavinTree/GetBoard and gavin_get_tree (frontmatter title, status, labels, human items) and into the card index (its whole body). For an arbitrary file with no frontmatter, only the parse-derived fields and the card-index ranking are exposed through the scan path. The PRD path exposes the full content.

## Root cause

read_prd (crates/daemon/src/gavin.rs:928-936) resolves root.join(prd_relative_path(root)) with is_file, metadata and read_to_string, all of which follow links. It never canonicalises the target or compares it with the canonical root. usable_prd_path (protocol lib.rs:5279) checks only the spelling of the configured value. list_md_files (gavin.rs:2270-2294) applies safe_to_descend to directories only, so build_context (2320) and card_bodies (2255) read symlinked files. The agent role's authorisation (agent_root_in_scope, server.rs:7284) is checked against the request's root argument, not against the file that is read.

## The invariant to enforce

A daemon reader that turns a fixed or repository-configured relative path into content returned to a principal should return bytes only when the fully resolved target lies under the canonical workspace root, as confine_card_path and safe_to_descend already require. A PRD or card symlink that leaves the root should read as 'no PRD found' (has_prd false) or be skipped by the scan. The 2026-09-08 audit already recommended 'no following of symlinks that leave the root' (docs/security/README.md R8, DP-05), so this is not an accepted-by-design boundary.

## Trace (lines as of 2026-10-16; re-read before editing)

- `crates/gavin-mcp/src/main.rs:889` (gavin-mcp tools/call dispatch): gavin_read_prd (defined at main.rs:701, no arguments) becomes Request::ReadPrd { root_path } for the session's workspace root. It is sent on a connection that presented GAVIN_SESSION_TOKEN, so it has the agent role.
- `crates/daemon/src/server.rs:7325` (agent_allows): ReadPrd is allowed when agent_root_in_scope(id, root_path) holds (server.rs:7284), which canonicalises only the requested root. The file to be read is not checked. Observed: ReadPrd for an out-of-scope root returns Forbidden, while ReadPrd for the in-scope root returns the outside file.
- `crates/daemon/src/server.rs:6705` (handle_request ReadPrd): Calls crate::gavin::read_prd and wraps the result unchanged in Response::PrdContent.
- `crates/daemon/src/gavin.rs:923` (prd_relative_path): Returns the repository's own config.toml `prd` value (spelling-checked by usable_prd_path, protocol lib.rs:5279) or the default .gavin-root/PRD.md (lib.rs:5267). Either can be a committed symlink, or can sit under a symlinked directory.
- `crates/daemon/src/gavin.rs:936` (read_prd): is_file(), metadata() and read_to_string() all follow the link. The resolved target is never compared with the canonical root, so an outside file's content is returned as the PRD.

## Fix

Add one helper that resolves a root-relative path and refuses it unless the canonical target is a regular file under the canonical root. Use it in read_prd and in build_context's has_prd (gavin.rs:2336). Make list_md_files apply its containment to file entries as well as directories; safe_to_descend already returns true for non-symlinks, so it can be reused. Open the canonical path once and take the size from the open handle, so that the check and the read concern the same file. Regression tests: (a) a PRD.md symlinked to a file in a sibling tempdir makes read_prd return Err and has_prd false; (b) a PRD symlinked to another file INSIDE the root still reads; (c) a plans/x.md symlink to a file outside the root is absent from scan_root and from cards_with_bodies; (d) a symlinked .gavin-root directory leading outside makes read_prd fail.

`crates/daemon/src/gavin.rs`, as a sketch only:

```
/// `rel` under `root`, resolved through every symlink, or an error when
/// the resolved target is not inside the canonical root.
fn resolve_inside_root(root: &Path, rel: &str) -> anyhow::Result<PathBuf> {
    let canonical_root = root.canonicalize()?;
    let target = root.join(rel).canonicalize()?;
    if !target.starts_with(&canonical_root) {
        anyhow::bail!("{rel} resolves outside the workspace");
    }
    Ok(target)
}

pub fn read_prd(root: &Path) -> anyhow::Result<String> {
    use std::io::Read;
    let rel = prd_relative_path(root);
    let prd = resolve_inside_root(root, &rel)
        .map_err(|_| anyhow::anyhow!("no PRD found at {}", root.join(&rel).display()))?;
    let mut file = std::fs::File::open(&prd)?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        anyhow::bail!("no PRD found at {}", root.join(&rel).display());
    }
    if meta.len() > MAX_PRD_BYTES {
        anyhow::bail!("PRD exceeds the 1 MB read cap");
    }
    let mut content = String::new();
    (&mut file).take(MAX_PRD_BYTES).read_to_string(&mut content)?;
    Ok(content)
}

// list_md_files::walk -- confine file entries the same way as directories:
//     } else if path.extension().map(|e| e == "md").unwrap_or(false)
//         && safe_to_descend(&path, boundary)
//     {
// build_context has_prd -- resolve_inside_root(folder, &prd_rel).is_ok_and(|p| p.is_file())
```

## Done when

- The fix enforces the invariant above at the last trusted decision point, not in a caller.
- The regression cases named in the fix are tests in the touched crate or module, and they fail before the change.
- The checks in CLAUDE.md pass for every part you touched.
- The audit reproduction no longer works. It is the record's `execution` field in `findings.json`.
- Follow the CLAUDE.md traps that apply: a new SQLite column needs its own `ALTER TABLE`, a widened request needs a compat-gate entry, and you commit only your own files.
