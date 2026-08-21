use std::path::{Path, PathBuf};

/// Where a profile's agent reads MCP config. Held only by profiles that
/// gavin can actually set up; sub-project B fills in the rest (the
/// verified layouts are recorded in the design spec's §4.1).
/// One gavin-managed skill file. Overwritten wholesale on every setup
/// run, like the instructions block's marker section.
pub struct SkillFile {
    pub dir: &'static str,
    pub file: &'static str,
    pub contents: &'static str,
}

pub struct McpLayout {
    pub config_file: &'static str,
    pub server_key: &'static str,
    pub skills: &'static [SkillFile],
}

/// D4's seam, widened. The writers below read fields, never literals.
pub struct AgentProfile {
    pub id: &'static str,
    pub label: &'static str,
    /// Empty for `custom`, where the user supplies it.
    pub instructions_file: &'static str,
    /// Empty for `custom`, where the user supplies it.
    pub command: &'static str,
    pub mcp: Option<McpLayout>,
}

pub const AGENT_PROFILES: &[AgentProfile] = &[
    AgentProfile {
        id: "claude-code",
        label: "Claude Code",
        instructions_file: "CLAUDE.md",
        command: "claude",
        mcp: Some(McpLayout {
            config_file: ".mcp.json",
            server_key: "gavin",
            skills: &[
                SkillFile {
                    dir: ".claude/skills/gavin",
                    file: "SKILL.md",
                    contents: include_str!("gavin_skill.md"),
                },
                // Its own skill, not a section of the workflow one: this
                // loads only when orchestration comes up, so the
                // always-on skill stays short.
                SkillFile {
                    dir: ".claude/skills/gavin-orchestrate",
                    file: "SKILL.md",
                    contents: include_str!("gavin_orchestrate_skill.md"),
                },
            ],
        }),
    },
    AgentProfile {
        id: "codex",
        label: "Codex CLI",
        instructions_file: "AGENTS.md",
        command: "codex",
        mcp: None,
    },
    AgentProfile {
        id: "gemini",
        label: "Gemini CLI",
        instructions_file: "GEMINI.md",
        command: "gemini",
        mcp: None,
    },
    AgentProfile {
        id: "cursor",
        label: "Cursor",
        instructions_file: "AGENTS.md",
        command: "cursor",
        mcp: None,
    },
    AgentProfile {
        id: "opencode",
        label: "opencode",
        instructions_file: "AGENTS.md",
        command: "opencode",
        mcp: None,
    },
    AgentProfile {
        id: "custom",
        label: "Custom…",
        instructions_file: "",
        command: "",
        mcp: None,
    },
];

pub fn profile_by_id(id: &str) -> &'static AgentProfile {
    AGENT_PROFILES.iter().find(|p| p.id == id).unwrap_or(&AGENT_PROFILES[0])
}

/// The profile id recorded in config.toml, defaulting to claude-code.
/// Read directly rather than routed through the daemon: this is a
/// one-shot read on a user-initiated action, and agent_setup already
/// touches the root's files directly.
fn read_profile_id(root: &Path) -> String {
    root_agent_key(root, "profile").unwrap_or_else(|| "claude-code".to_string())
}

/// config.toml's explicit `file`, else the profile's default.
fn resolved_instructions_file(root: &Path, profile: &AgentProfile) -> String {
    root_agent_key(root, "file")
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| profile.instructions_file.to_string())
}

fn root_agent_key(root: &Path, key: &str) -> Option<String> {
    let path = root.join(".gavin-root").join("config.toml");
    let content = std::fs::read_to_string(path).ok()?;
    let table = content.parse::<toml::Table>().ok()?;
    table.get("agent")?.as_table()?.get(key)?.as_str().map(|s| s.to_string())
}

/// Same allow-list and format-preserving write as the daemon's
/// set_root_config_field, for app-side paths that must not depend on a
/// daemon round trip (the D41 launch-command migration).
pub fn write_root_config_key(root: &Path, key: &str, value: &str) -> anyhow::Result<()> {
    if !matches!(key, "profile" | "file" | "command") {
        anyhow::bail!("not a settable agent key: {key}");
    }
    let path = root.join(".gavin-root").join("config.toml");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let mut doc = existing
        .parse::<toml_edit::DocumentMut>()
        .map_err(|_| anyhow::anyhow!("{} is not valid TOML", path.display()))?;
    doc["agent"][key] = toml_edit::value(value);
    if let Some(t) = doc["agent"].as_table_mut() {
        t.set_implicit(false);
    }
    std::fs::write(&path, doc.to_string())?;
    Ok(())
}

const MARKER_START: &str = "<!-- gavin:start -->";
const MARKER_END: &str = "<!-- gavin:end -->";

const CLAUDE_MD_BLOCK: &str = "## Gavin workspace\n\n\
This repo is a gavin workspace. Read `.gavin-root/PRD.md` first — it leads all\n\
development. Follow the gavin workflow skill in `.claude/skills/gavin/SKILL.md`\n\
(plan before coding, keep plan statuses current, use the gavin_* MCP tools).\n";

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
fn write_mcp_config(root: &Path, layout: &McpLayout, binary: &Path) -> anyhow::Result<PathBuf> {
    let path = root.join(layout.config_file);
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
        layout.server_key.to_string(),
        serde_json::json!({ "command": binary.to_string_lossy(), "args": [] }),
    );
    std::fs::write(&path, format!("{}\n", serde_json::to_string_pretty(&doc)?))?;
    Ok(path)
}

/// Gavin-managed: every skill is overwritten wholesale on each setup run.
fn write_skills(root: &Path, layout: &McpLayout) -> anyhow::Result<Vec<PathBuf>> {
    let mut written = Vec::new();
    for skill in layout.skills {
        let dir = root.join(skill.dir);
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(skill.file);
        std::fs::write(&path, skill.contents)?;
        written.push(path);
    }
    Ok(written)
}

/// Replaces the marker block in place, appends it otherwise (creating the
/// file if absent). Nothing outside the markers is ever touched.
fn write_instructions_block(root: &Path, instructions_file: &str) -> anyhow::Result<PathBuf> {
    let path = root.join(instructions_file);
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
    let profile = profile_by_id(&read_profile_id(root));
    let Some(layout) = profile.mcp.as_ref() else {
        return Err(format!("MCP integration isn't available for {} yet", profile.label));
    };
    let instructions_file = resolved_instructions_file(root, profile);
    let binary = resolve_mcp_binary_path().map_err(|e| e.to_string())?;
    let mut written = vec![write_mcp_config(root, layout, &binary).map_err(|e| e.to_string())?];
    written.extend(write_skills(root, layout).map_err(|e| e.to_string())?);
    written.push(write_instructions_block(root, &instructions_file).map_err(|e| e.to_string())?);
    Ok(written.into_iter().map(|p| p.to_string_lossy().to_string()).collect())
}

/// The profile table, flattened for the frontend. Mirrors
/// fileviewer::viewable_extensions -- one source of truth in Rust rather
/// than a TypeScript copy that drifts.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfileDto {
    pub id: String,
    pub label: String,
    pub instructions_file: String,
    pub command: String,
    pub mcp_supported: bool,
}

#[tauri::command]
pub fn agent_profiles() -> Vec<AgentProfileDto> {
    AGENT_PROFILES
        .iter()
        .map(|p| AgentProfileDto {
            id: p.id.to_string(),
            label: p.label.to_string(),
            instructions_file: p.instructions_file.to_string(),
            command: p.command.to_string(),
            mcp_supported: p.mcp.is_some(),
        })
        .collect()
}

/// Renames the agent instructions file. Refuses when the target exists --
/// gavin never overwrites (D10) -- and when either name is not a bare
/// filename, so a settings field can never write outside the root.
#[tauri::command]
pub fn move_agent_file(root_path: String, from: String, to: String) -> Result<(), String> {
    for name in [&from, &to] {
        if name.trim().is_empty() || name.contains('/') || name.contains('\\') {
            return Err(format!("not a bare file name: {name}"));
        }
    }
    let root = Path::new(&root_path);
    let target = root.join(&to);
    if target.exists() {
        return Err(format!("{to} already exists — pointing at it instead of moving"));
    }
    std::fs::rename(root.join(&from), target).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The claude-code row's MCP layout, for the writer tests below.
    /// Reaches through profile_by_id so the tests exercise the real table
    /// rather than a second copy of the same constants.
    fn claude_layout() -> &'static McpLayout {
        profile_by_id("claude-code").mcp.as_ref().unwrap()
    }

    #[test]
    fn every_profile_row_is_usable_and_ids_are_unique() {
        let mut ids: Vec<&str> = AGENT_PROFILES.iter().map(|p| p.id).collect();
        let count = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), count, "profile ids must be unique");
        assert_eq!(count, 6, "claude-code, codex, gemini, cursor, opencode, custom");

        for p in AGENT_PROFILES {
            assert!(!p.label.is_empty(), "{} has no label", p.id);
            if p.id == "custom" {
                assert!(p.instructions_file.is_empty(), "custom is user-supplied");
                assert!(p.command.is_empty(), "custom is user-supplied");
            } else {
                assert!(!p.instructions_file.is_empty(), "{} has no instructions file", p.id);
                assert!(!p.command.is_empty(), "{} has no command", p.id);
            }
        }
    }

    #[test]
    fn only_claude_code_supports_mcp_in_this_sub_project() {
        let with_mcp: Vec<&str> =
            AGENT_PROFILES.iter().filter(|p| p.mcp.is_some()).map(|p| p.id).collect();
        assert_eq!(with_mcp, ["claude-code"]);
    }

    #[test]
    fn profile_by_id_falls_back_to_claude_code_for_an_unknown_id() {
        assert_eq!(profile_by_id("codex").id, "codex");
        assert_eq!(profile_by_id("not-a-thing").id, "claude-code");
    }

    #[test]
    fn move_agent_file_renames_and_refuses_an_existing_target() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("CLAUDE.md"), "# mine\n").unwrap();

        move_agent_file(
            dir.path().to_string_lossy().to_string(),
            "CLAUDE.md".into(),
            "AGENTS.md".into(),
        )
        .unwrap();
        assert!(!dir.path().join("CLAUDE.md").exists());
        assert_eq!(std::fs::read_to_string(dir.path().join("AGENTS.md")).unwrap(), "# mine\n");

        // Target exists -> refused, both files untouched.
        std::fs::write(dir.path().join("CLAUDE.md"), "# new\n").unwrap();
        assert!(move_agent_file(
            dir.path().to_string_lossy().to_string(),
            "CLAUDE.md".into(),
            "AGENTS.md".into()
        )
        .is_err());
        assert_eq!(std::fs::read_to_string(dir.path().join("AGENTS.md")).unwrap(), "# mine\n");
    }

    #[test]
    fn move_agent_file_rejects_path_traversal() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("CLAUDE.md"), "x").unwrap();
        assert!(move_agent_file(
            dir.path().to_string_lossy().to_string(),
            "CLAUDE.md".into(),
            "../escaped.md".into()
        )
        .is_err());
    }

    #[test]
    fn setup_refuses_a_profile_with_no_mcp_layout() {
        let dir = tempfile::tempdir().unwrap();
        let g = dir.path().join(".gavin-root");
        std::fs::create_dir_all(&g).unwrap();
        std::fs::write(g.join("config.toml"), "version = 1\n\n[agent]\nprofile = \"codex\"\n")
            .unwrap();
        let err = setup_agent_integration(dir.path().to_string_lossy().to_string()).unwrap_err();
        assert!(err.contains("Codex CLI"), "the message names the profile: {err}");
    }

    #[test]
    fn resolved_instructions_file_prefers_config_then_profile() {
        let dir = tempfile::tempdir().unwrap();
        let g = dir.path().join(".gavin-root");
        std::fs::create_dir_all(&g).unwrap();

        std::fs::write(g.join("config.toml"), "[agent]\nprofile = \"codex\"\n").unwrap();
        assert_eq!(resolved_instructions_file(dir.path(), profile_by_id("codex")), "AGENTS.md");

        std::fs::write(g.join("config.toml"), "[agent]\nprofile = \"codex\"\nfile = \"NOTES.md\"\n")
            .unwrap();
        assert_eq!(resolved_instructions_file(dir.path(), profile_by_id("codex")), "NOTES.md");
    }

    #[test]
    fn read_profile_id_defaults_to_claude_code_without_a_config() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_profile_id(dir.path()), "claude-code");
    }

    #[test]
    fn mcp_config_merges_preserving_other_servers_and_replacing_stale_gavin() {
        let dir = tempfile::tempdir().unwrap();
        let binary = Path::new("/apps/gavin-mcp");
        // Absent → created.
        let p = write_mcp_config(dir.path(), claude_layout(), binary).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v.pointer("/mcpServers/gavin/command").unwrap(), "/apps/gavin-mcp");
        // Existing with another server + stale gavin → both handled.
        std::fs::write(
            &p,
            r#"{ "mcpServers": { "other": { "command": "/bin/other" }, "gavin": { "command": "/old" } }, "unrelated": true }"#,
        )
        .unwrap();
        write_mcp_config(dir.path(), claude_layout(), binary).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v.pointer("/mcpServers/other/command").unwrap(), "/bin/other");
        assert_eq!(v.pointer("/mcpServers/gavin/command").unwrap(), "/apps/gavin-mcp");
        assert_eq!(v.pointer("/unrelated").unwrap(), true);
        // Unparseable → error, file untouched.
        std::fs::write(&p, "{not json").unwrap();
        assert!(write_mcp_config(dir.path(), claude_layout(), binary).is_err());
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{not json");
    }

    #[test]
    fn instructions_block_appends_replaces_and_never_touches_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        // Absent → created with just the block.
        let p = write_instructions_block(dir.path(), "CLAUDE.md").unwrap();
        let first = std::fs::read_to_string(&p).unwrap();
        assert!(first.starts_with(MARKER_START));
        // Existing content → appended after it.
        std::fs::write(&p, "# My rules\n\nKeep tests green.\n").unwrap();
        write_instructions_block(dir.path(), "CLAUDE.md").unwrap();
        let appended = std::fs::read_to_string(&p).unwrap();
        assert!(appended.starts_with("# My rules"));
        assert!(appended.contains(MARKER_START));
        // Re-run → block replaced in place, custom content above AND below intact.
        let with_tail = format!("{appended}## After\n\ntail text\n");
        std::fs::write(&p, &with_tail).unwrap();
        write_instructions_block(dir.path(), "CLAUDE.md").unwrap();
        let replaced = std::fs::read_to_string(&p).unwrap();
        assert!(replaced.starts_with("# My rules"));
        assert!(replaced.contains("tail text"));
        assert_eq!(replaced.matches(MARKER_START).count(), 1);
    }

    #[test]
    fn every_skill_is_written_and_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let paths = write_skills(dir.path(), claude_layout()).unwrap();
        assert_eq!(paths.len(), 2, "workflow skill plus the orchestrate one");

        let workflow = std::fs::read_to_string(&paths[0]).unwrap();
        assert!(workflow.contains("gavin_create_plan"), "{workflow}");
        let orchestrate = std::fs::read_to_string(&paths[1]).unwrap();
        assert!(orchestrate.contains("gavin_get_orchestration"), "{orchestrate}");
        assert!(
            orchestrate.contains("When unsure, serialize"),
            "the parallelism rule must survive into the installed file"
        );

        // Gavin-managed: a hand-edited skill is replaced, not merged.
        for p in &paths {
            std::fs::write(p, "mangled").unwrap();
        }
        write_skills(dir.path(), claude_layout()).unwrap();
        assert!(std::fs::read_to_string(&paths[0]).unwrap().contains("gavin_create_plan"));
        assert!(std::fs::read_to_string(&paths[1]).unwrap().contains("gavin_get_orchestration"));
    }

    #[test]
    fn the_two_skills_land_in_different_directories() {
        let dir = tempfile::tempdir().unwrap();
        let paths = write_skills(dir.path(), claude_layout()).unwrap();
        assert!(paths[0].ends_with(".claude/skills/gavin/SKILL.md"), "{:?}", paths[0]);
        assert!(paths[1].ends_with(".claude/skills/gavin-orchestrate/SKILL.md"), "{:?}", paths[1]);
    }
}
