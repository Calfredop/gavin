use std::path::{Path, PathBuf};

/// D4's seam: everything profile-specific lives in fields. One profile
/// exists today; the writers below read fields, never literals.
struct ClaudeCodeProfile {
    mcp_config: &'static str,
    server_key: &'static str,
    skill_dir: &'static str,
    skill_file: &'static str,
    instructions_file: &'static str,
}

const CLAUDE_CODE: ClaudeCodeProfile = ClaudeCodeProfile {
    mcp_config: ".mcp.json",
    server_key: "gavin",
    skill_dir: ".claude/skills/gavin",
    skill_file: "SKILL.md",
    instructions_file: "CLAUDE.md",
};

const MARKER_START: &str = "<!-- gavin:start -->";
const MARKER_END: &str = "<!-- gavin:end -->";

const CLAUDE_MD_BLOCK: &str = "## Gavin workspace\n\n\
This repo is a gavin workspace. Read `.gavin-root/PRD.md` first — it leads all\n\
development. Follow the gavin workflow skill in `.claude/skills/gavin/SKILL.md`\n\
(plan before coding, keep plan statuses current, use the gavin_* MCP tools).\n";

const SKILL_MD: &str = include_str!("gavin_skill.md");

fn resolve_mcp_binary_path() -> anyhow::Result<PathBuf> {
    let current_exe = std::env::current_exe()?;
    let dir = current_exe
        .parent()
        .ok_or_else(|| anyhow::anyhow!("current_exe has no parent directory"))?;
    let path = dir.join("gavin-mcp");
    if !path.is_file() {
        anyhow::bail!(
            "gavin-mcp binary not found beside the app ({}) — build it with `cargo build -p gavin-mcp`",
            path.display()
        );
    }
    Ok(path)
}

/// Merge-aware: only mcpServers.<key> is created/replaced; every other
/// entry of an existing file survives. Unparseable JSON errors instead of
/// clobbering.
fn write_mcp_config(
    root: &Path,
    profile: &ClaudeCodeProfile,
    binary: &Path,
) -> anyhow::Result<PathBuf> {
    let path = root.join(profile.mcp_config);
    let mut doc: serde_json::Value = if path.exists() {
        serde_json::from_str(&std::fs::read_to_string(&path)?).map_err(|_| {
            anyhow::anyhow!("existing {} is not valid JSON — fix or remove it first", path.display())
        })?
    } else {
        serde_json::json!({})
    };
    let obj = doc
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("existing {} is not a JSON object", path.display()))?;
    let servers = obj
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("mcpServers is not a JSON object"))?;
    servers.insert(
        profile.server_key.to_string(),
        serde_json::json!({ "command": binary.to_string_lossy(), "args": [] }),
    );
    std::fs::write(&path, format!("{}\n", serde_json::to_string_pretty(&doc)?))?;
    Ok(path)
}

/// Gavin-managed: overwritten wholesale on every setup run.
fn write_skill(root: &Path, profile: &ClaudeCodeProfile) -> anyhow::Result<PathBuf> {
    let dir = root.join(profile.skill_dir);
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(profile.skill_file);
    std::fs::write(&path, SKILL_MD)?;
    Ok(path)
}

/// Replaces the marker block in place, appends it otherwise (creating the
/// file if absent). Nothing outside the markers is ever touched.
fn write_instructions_block(root: &Path, profile: &ClaudeCodeProfile) -> anyhow::Result<PathBuf> {
    let path = root.join(profile.instructions_file);
    let block = format!("{MARKER_START}\n{CLAUDE_MD_BLOCK}{MARKER_END}\n");
    let content = if path.exists() {
        let existing = std::fs::read_to_string(&path)?;
        match (existing.find(MARKER_START), existing.find(MARKER_END)) {
            (Some(start), Some(end)) if end >= start => {
                let after = existing[end + MARKER_END.len()..].trim_start_matches('\n');
                format!("{}{}{}", &existing[..start], block, after)
            }
            _ => {
                let sep = if existing.is_empty() || existing.ends_with("\n\n") {
                    ""
                } else if existing.ends_with('\n') {
                    "\n"
                } else {
                    "\n\n"
                };
                format!("{existing}{sep}{block}")
            }
        }
    } else {
        block
    };
    std::fs::write(&path, content)?;
    Ok(path)
}

#[tauri::command]
pub fn setup_agent_integration(root_path: String) -> Result<Vec<String>, String> {
    let root = Path::new(&root_path);
    if !root.is_dir() {
        return Err(format!("root does not exist: {root_path}"));
    }
    let profile = &CLAUDE_CODE;
    let binary = resolve_mcp_binary_path().map_err(|e| e.to_string())?;
    let written = vec![
        write_mcp_config(root, profile, &binary).map_err(|e| e.to_string())?,
        write_skill(root, profile).map_err(|e| e.to_string())?,
        write_instructions_block(root, profile).map_err(|e| e.to_string())?,
    ];
    Ok(written.into_iter().map(|p| p.to_string_lossy().to_string()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_config_merges_preserving_other_servers_and_replacing_stale_gavin() {
        let dir = tempfile::tempdir().unwrap();
        let binary = Path::new("/apps/gavin-mcp");
        // Absent → created.
        let p = write_mcp_config(dir.path(), &CLAUDE_CODE, binary).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v.pointer("/mcpServers/gavin/command").unwrap(), "/apps/gavin-mcp");
        // Existing with another server + stale gavin → both handled.
        std::fs::write(
            &p,
            r#"{ "mcpServers": { "other": { "command": "/bin/other" }, "gavin": { "command": "/old" } }, "unrelated": true }"#,
        )
        .unwrap();
        write_mcp_config(dir.path(), &CLAUDE_CODE, binary).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v.pointer("/mcpServers/other/command").unwrap(), "/bin/other");
        assert_eq!(v.pointer("/mcpServers/gavin/command").unwrap(), "/apps/gavin-mcp");
        assert_eq!(v.pointer("/unrelated").unwrap(), true);
        // Unparseable → error, file untouched.
        std::fs::write(&p, "{not json").unwrap();
        assert!(write_mcp_config(dir.path(), &CLAUDE_CODE, binary).is_err());
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{not json");
    }

    #[test]
    fn instructions_block_appends_replaces_and_never_touches_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        // Absent → created with just the block.
        let p = write_instructions_block(dir.path(), &CLAUDE_CODE).unwrap();
        let first = std::fs::read_to_string(&p).unwrap();
        assert!(first.starts_with(MARKER_START));
        // Existing content → appended after it.
        std::fs::write(&p, "# My rules\n\nKeep tests green.\n").unwrap();
        write_instructions_block(dir.path(), &CLAUDE_CODE).unwrap();
        let appended = std::fs::read_to_string(&p).unwrap();
        assert!(appended.starts_with("# My rules"));
        assert!(appended.contains(MARKER_START));
        // Re-run → block replaced in place, custom content above AND below intact.
        let with_tail = format!("{appended}## After\n\ntail text\n");
        std::fs::write(&p, &with_tail).unwrap();
        write_instructions_block(dir.path(), &CLAUDE_CODE).unwrap();
        let replaced = std::fs::read_to_string(&p).unwrap();
        assert!(replaced.starts_with("# My rules"));
        assert!(replaced.contains("tail text"));
        assert_eq!(replaced.matches(MARKER_START).count(), 1);
    }

    #[test]
    fn skill_is_written_and_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let p = write_skill(dir.path(), &CLAUDE_CODE).unwrap();
        assert!(std::fs::read_to_string(&p).unwrap().contains("gavin_create_plan"));
        std::fs::write(&p, "mangled").unwrap();
        write_skill(dir.path(), &CLAUDE_CODE).unwrap();
        assert!(std::fs::read_to_string(&p).unwrap().contains("gavin_create_plan"));
    }
}
