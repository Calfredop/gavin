use std::path::{Path, PathBuf};

/// One gavin-managed skill file. Overwritten wholesale on every setup
/// run, like the instructions block's marker section.
pub struct SkillFile {
    pub dir: &'static str,
    pub file: &'static str,
    pub contents: &'static str,
}

/// How an agent's MCP config file is written: the serialization, the key
/// the server entry hangs off, and the entry's own shape. The path is a
/// separate field because three CLIs share one dialect and differ only in
/// where the file sits. Verified against upstream docs 2026-08-23.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum McpFormat {
    /// JSON `mcpServers.<key>` = `{ command, args }` — Claude Code
    /// (`.mcp.json`) and Gemini CLI (`.gemini/settings.json`).
    JsonServers,
    /// The same, plus the `type: "stdio"` Cursor's docs list as required
    /// for a local server. Its own variant rather than a key written
    /// unconditionally: Gemini's documented server fields do not include
    /// `type`, and gavin does not put keys it has not verified into
    /// someone else's config.
    JsonServersStdio,
    /// JSON `mcp.<key>` = `{ type: "local", command: [...], enabled }` —
    /// opencode (`opencode.json`). The command is an array here, not a
    /// string with a separate args list.
    JsonLocal,
    /// TOML `[mcp_servers.<key>]` with `command` and `args` — Codex CLI
    /// (`.codex/config.toml`, its project-scoped layer).
    TomlServers,
}

impl McpFormat {
    /// The name this dialect goes by in `.gavin-root/config.toml`'s
    /// `[agent].mcp_format`. Kebab-case to match the profile ids beside
    /// it in the same file.
    pub fn id(self) -> &'static str {
        match self {
            McpFormat::JsonServers => "json-servers",
            McpFormat::JsonServersStdio => "json-servers-stdio",
            McpFormat::JsonLocal => "json-local",
            McpFormat::TomlServers => "toml-servers",
        }
    }

    /// Every dialect a `custom` profile can be pointed at, in the order
    /// the settings picker offers them.
    pub const ALL: &'static [McpFormat] = &[
        McpFormat::JsonServers,
        McpFormat::JsonServersStdio,
        McpFormat::JsonLocal,
        McpFormat::TomlServers,
    ];

    /// An unknown or absent name falls back to the `mcpServers.<key>`
    /// JSON shape -- three of the five stock CLIs use it, so it is the
    /// best guess for a sixth.
    fn from_id(id: Option<&str>) -> McpFormat {
        McpFormat::ALL
            .iter()
            .copied()
            .find(|f| Some(f.id()) == id)
            .unwrap_or(McpFormat::JsonServers)
    }
}

/// Where a profile's agent reads MCP config, and what it installs beside
/// it. `skills` is empty for every profile but Claude Code: the others
/// have no skill mechanism gavin writes to, so their guidance rides
/// inline in the instructions block instead (see instructions_block_for).
pub struct McpLayout {
    pub config_file: &'static str,
    pub server_key: &'static str,
    pub format: McpFormat,
    pub skills: &'static [SkillFile],
}

/// A layout with the path resolved: from the profile table for the five
/// stock profiles, from the workspace's own config for `custom`, whose
/// agent reads MCP config wherever its author decided. Owned rather than
/// borrowed for exactly that reason -- a configured path is a String, and
/// the table's fields are `&'static str`.
pub struct ResolvedMcp {
    config_file: String,
    server_key: &'static str,
    format: McpFormat,
    skills: &'static [SkillFile],
}

impl ResolvedMcp {
    /// Where a step skill this profile does not already install would go:
    /// the parent every installed skill shares, and the filename they all
    /// use. Taken from the first entry because that is the shape an
    /// agent's own skill loader imposes -- one directory per skill under
    /// a single root, each holding the same filename -- so every entry
    /// answers identically. None when the profile installs no skills,
    /// which is every profile but Claude Code.
    fn skill_slot(&self) -> Option<(&'static Path, &'static str)> {
        let first = self.skills.first()?;
        Some((Path::new(first.dir).parent()?, first.file))
    }
}

impl From<&McpLayout> for ResolvedMcp {
    fn from(l: &McpLayout) -> Self {
        ResolvedMcp {
            config_file: l.config_file.to_string(),
            server_key: l.server_key,
            format: l.format,
            skills: l.skills,
        }
    }
}

/// A configured `mcp_file` must name a spot INSIDE the root, the same
/// promise move_agent_file makes about the agent-file field: a settings
/// box can never become a writer into someone's home directory. Relative
/// subpaths are allowed -- unlike the agent file, an MCP config usually
/// lives in a dot-directory.
fn usable_mcp_path(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let path = Path::new(trimmed);
    if trimmed.is_empty() || path.is_absolute() {
        return None;
    }
    // Rejects `..` anywhere, and the Windows prefixes/root-dir components
    // an absolute check on a foreign separator would miss.
    if !path.components().all(|c| matches!(c, std::path::Component::Normal(_))) {
        return None;
    }
    Some(trimmed.to_string())
}

/// The layout to write for this root: the profile's own, or -- for
/// `custom`, which has none -- the one its config describes. None when
/// `custom` has not been pointed at a file yet, which is what leaves MCP
/// config named as skipped.
fn resolved_mcp(root: &Path, profile: &AgentProfile) -> Option<ResolvedMcp> {
    if let Some(layout) = profile.mcp.as_ref() {
        return Some(layout.into());
    }
    let config_file = usable_mcp_path(&root_agent_key(root, "mcp_file")?)?;
    Some(ResolvedMcp {
        config_file,
        server_key: "gavin",
        format: McpFormat::from_id(root_agent_key(root, "mcp_format").as_deref()),
        // Nothing to install: gavin knows no skill convention for an
        // agent it has never heard of, so the guidance goes inline.
        skills: &[],
    })
}

/// D4's seam, widened. The writers below read fields, never literals.
pub struct AgentProfile {
    pub id: &'static str,
    pub label: &'static str,
    /// Empty for `custom`, where the user supplies it.
    pub instructions_file: &'static str,
    /// Empty for `custom`, where the user supplies it.
    pub command: &'static str,
    /// Whether this agent accepts a positional prompt argument, i.e.
    /// `<command> "<prompt>"`. Only true where the convention is
    /// verified: getting it wrong puts garbage in the agent's argv, so
    /// agent-driven flows are hidden rather than risked (spec §7.2).
    pub prompt_arg: bool,
    pub mcp: Option<McpLayout>,
}

pub const AGENT_PROFILES: &[AgentProfile] = &[
    AgentProfile {
        id: "claude-code",
        label: "Claude Code",
        instructions_file: "CLAUDE.md",
        command: "claude",
        prompt_arg: true,
        mcp: Some(McpLayout {
            config_file: ".mcp.json",
            server_key: "gavin",
            format: McpFormat::JsonServers,
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
        // `codex "<prompt>"`: the TUI's clap parser takes an optional
        // positional PROMPT that starts the session.
        prompt_arg: true,
        mcp: Some(McpLayout {
            config_file: ".codex/config.toml",
            server_key: "gavin",
            format: McpFormat::TomlServers,
            skills: &[],
        }),
    },
    AgentProfile {
        id: "gemini",
        label: "Gemini CLI",
        instructions_file: "GEMINI.md",
        command: "gemini",
        // `gemini [query..]`: the positional is the initial prompt and
        // stays interactive, which is what a launched session wants.
        // (-p would run it headless and exit.)
        prompt_arg: true,
        mcp: Some(McpLayout {
            config_file: ".gemini/settings.json",
            server_key: "gavin",
            format: McpFormat::JsonServers,
            skills: &[],
        }),
    },
    AgentProfile {
        id: "cursor",
        label: "Cursor",
        instructions_file: "AGENTS.md",
        command: "cursor",
        // Verified false, not merely unverified: `cursor` is the IDE
        // launcher and its positionals are paths, so a prompt would be
        // read as a file to open. Cursor's terminal agent is a separate
        // binary; a user who wants it points `command` at it in Settings.
        prompt_arg: false,
        mcp: Some(McpLayout {
            config_file: ".cursor/mcp.json",
            server_key: "gavin",
            format: McpFormat::JsonServersStdio,
            skills: &[],
        }),
    },
    AgentProfile {
        id: "opencode",
        label: "opencode",
        instructions_file: "AGENTS.md",
        command: "opencode",
        // Also verified false: `opencode [project]`'s positional is a
        // directory to start in, so a prompt would land as a path.
        // Prompts go through the `opencode run` subcommand instead.
        prompt_arg: false,
        mcp: Some(McpLayout {
            config_file: "opencode.json",
            server_key: "gavin",
            format: McpFormat::JsonLocal,
            skills: &[],
        }),
    },
    AgentProfile {
        id: "custom",
        label: "Custom…",
        instructions_file: "",
        command: "",
        prompt_arg: false,
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
    if !matches!(key, "profile" | "file" | "command" | "mcp_file" | "mcp_format") {
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

/// Pointer variant: for profiles with a skill mechanism, the block stays
/// short and defers to the skill file.
const BLOCK_WITH_SKILL: &str = "## Gavin workspace\n\n\
This repo is a gavin workspace. Read `.gavin-root/PRD.md` first — it leads all\n\
development. Follow the gavin workflow skill in `.claude/skills/gavin/SKILL.md`\n\
(plan before coding, keep plan statuses current, use the gavin_* MCP tools).\n";

/// Inline variant: for agents with no skill mechanism, the same guidance
/// has to live in the block itself -- there is no file to point at.
const BLOCK_INLINE: &str = "## Gavin workspace\n\n\
This repo is a gavin workspace. Read `.gavin-root/PRD.md` first — it leads all\n\
development.\n\n\
- Plans are markdown files in `.gavin-root/plans/` (and any `.gavin/plans/`).\n\
  Their frontmatter drives a kanban board the human watches: `status:` is the\n\
  column, `priority:` the dot, `kind:` one of note/task/plan.\n\
- Plan before coding. Create a plan file, keep its `status:` current as you\n\
  work, and never mark work done that you have not verified.\n\
- The files are the truth. Edit them directly; the board follows.\n";

/// The inline guidance plus the one line it could not carry before
/// sub-project B: with an MCP config written, these agents CAN call the
/// tools, and an agent that edits frontmatter by hand when
/// `gavin_set_plan_field` exists gets the format wrong.
const BLOCK_INLINE_WITH_MCP: &str = "## Gavin workspace\n\n\
This repo is a gavin workspace. Read `.gavin-root/PRD.md` first — it leads all\n\
development.\n\n\
- Plans are markdown files in `.gavin-root/plans/` (and any `.gavin/plans/`).\n\
  Their frontmatter drives a kanban board the human watches: `status:` is the\n\
  column, `priority:` the dot, `kind:` one of note/task/plan.\n\
- Plan before coding. Create a plan file, keep its `status:` current as you\n\
  work, and never mark work done that you have not verified.\n\
- Use the `gavin_*` MCP tools rather than editing frontmatter by hand:\n\
  `gavin_read_prd`, `gavin_get_tree`, `gavin_create_plan`,\n\
  `gavin_set_plan_field`, `gavin_promote_task`.\n\
- The files are the truth. Edit them directly; the board follows.\n";

/// Three variants for two independent capabilities. A skill file, where
/// one can be installed, keeps the block short by pointing at it; without
/// one the guidance is inline, and mentions the MCP tools only where a
/// config was actually written for them.
fn instructions_block_for(mcp: Option<&ResolvedMcp>) -> &'static str {
    match mcp {
        Some(layout) if !layout.skills.is_empty() => BLOCK_WITH_SKILL,
        Some(_) => BLOCK_INLINE_WITH_MCP,
        None => BLOCK_INLINE,
    }
}

const PRD_SKILL_MD: &str = include_str!("gavin_prd_skill.md");
const AGENT_FILE_SKILL_MD: &str = include_str!("gavin_agent_file_skill.md");

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

impl McpFormat {
    /// The key the per-server map hangs off. Meaningless for TOML, which
    /// spells its own table name in the writer.
    fn json_container(self) -> &'static str {
        match self {
            McpFormat::JsonLocal => "mcp",
            // Exhaustive rather than a catch-all, here and below: a sixth
            // dialect must state its own shape, not inherit Claude's.
            McpFormat::JsonServers | McpFormat::JsonServersStdio | McpFormat::TomlServers => {
                "mcpServers"
            }
        }
    }

    /// Gavin's own entry, in this dialect's shape.
    fn json_entry(self, binary: &Path) -> serde_json::Value {
        let command = binary.to_string_lossy();
        match self {
            McpFormat::JsonLocal => {
                serde_json::json!({ "type": "local", "command": [command], "enabled": true })
            }
            McpFormat::JsonServersStdio => {
                serde_json::json!({ "type": "stdio", "command": command, "args": [] })
            }
            McpFormat::JsonServers | McpFormat::TomlServers => {
                serde_json::json!({ "command": command, "args": [] })
            }
        }
    }
}

/// Merge-aware in both dialects: gavin creates or replaces exactly its own
/// server entry, and every other byte of an existing file survives -- other
/// servers, unrelated settings, and (in TOML) comments and key order. A
/// file that does not parse errors out rather than being clobbered.
fn write_mcp_config(root: &Path, layout: &ResolvedMcp, binary: &Path) -> anyhow::Result<PathBuf> {
    let path = root.join(&layout.config_file);
    // .gemini/, .cursor/ and .codex/ need not exist yet; .mcp.json and
    // opencode.json sit at the root, where this is a no-op.
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match layout.format {
        McpFormat::TomlServers => write_mcp_config_toml(&path, layout, binary)?,
        McpFormat::JsonServers | McpFormat::JsonServersStdio | McpFormat::JsonLocal => {
            write_mcp_config_json(&path, layout, binary)?
        }
    }
    Ok(path)
}

fn write_mcp_config_json(path: &Path, layout: &ResolvedMcp, binary: &Path) -> anyhow::Result<()> {
    let mut doc: serde_json::Value = if path.exists() {
        serde_json::from_str(&std::fs::read_to_string(path)?).map_err(|_| {
            anyhow::anyhow!("existing {} is not valid JSON — fix or remove it first", path.display())
        })?
    } else {
        serde_json::json!({})
    };
    let container = layout.format.json_container();
    let obj = doc
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("existing {} is not a JSON object", path.display()))?;
    let servers = obj
        .entry(container)
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("{container} is not a JSON object"))?;
    servers.insert(layout.server_key.to_string(), layout.format.json_entry(binary));
    std::fs::write(path, format!("{}\n", serde_json::to_string_pretty(&doc)?))?;
    Ok(())
}

/// Codex's `.codex/config.toml`, written with toml_edit so a hand-edited
/// file keeps its comments, key order and formatting -- the same reason
/// set_root_config_field uses it for gavin's own config.
fn write_mcp_config_toml(path: &Path, layout: &ResolvedMcp, binary: &Path) -> anyhow::Result<()> {
    // Absent is empty; unreadable-but-present is an error, not a reason to
    // overwrite it -- the same promise the JSON writer makes.
    let existing = if path.exists() { std::fs::read_to_string(path)? } else { String::new() };
    let mut doc = existing.parse::<toml_edit::DocumentMut>().map_err(|_| {
        anyhow::anyhow!("existing {} is not valid TOML — fix or remove it first", path.display())
    })?;
    // Removed before it is written so a stale entry is REPLACED rather
    // than merged into, matching the JSON writer: gavin owns its key
    // outright, including any comments someone hung inside it.
    if let Some(table) = doc.get_mut("mcp_servers").and_then(|i| i.as_table_like_mut()) {
        table.remove(layout.server_key);
    }
    let server = &mut doc["mcp_servers"][layout.server_key];
    server["command"] = toml_edit::value(binary.to_string_lossy().as_ref());
    server["args"] = toml_edit::value(toml_edit::Array::new());
    std::fs::write(path, doc.to_string())?;
    Ok(())
}

/// Gavin-managed: every skill is overwritten wholesale on each setup run.
fn write_skills(root: &Path, layout: &ResolvedMcp) -> anyhow::Result<Vec<PathBuf>> {
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
fn write_instructions_block(
    root: &Path,
    instructions_file: &str,
    block_body: &str,
) -> anyhow::Result<PathBuf> {
    let path = root.join(instructions_file);
    let block = format!("{MARKER_START}\n{block_body}{MARKER_END}\n");
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

/// What a setup run wrote, and what it could not. Rendered verbatim by
/// the wizard's Integration step: a profile with no McpLayout still gets
/// its instructions block, and the two omissions are named with reasons
/// rather than failing the whole run (W4).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationResult {
    pub written: Vec<String>,
    pub skipped: Vec<(String, String)>,
}

#[tauri::command]
pub fn setup_agent_integration(root_path: String) -> Result<IntegrationResult, String> {
    run_integration(Path::new(&root_path), resolve_mcp_binary_path)
}

/// The command's body, with the binary lookup injected. Injected because
/// resolve_mcp_binary_path wants gavin-mcp beside the running executable,
/// which is never true under `cargo test` -- and it stays a closure rather
/// than a parameter so that a profile with no MCP config still succeeds
/// without one having to exist.
fn run_integration(
    root: &Path,
    resolve_binary: impl Fn() -> anyhow::Result<PathBuf>,
) -> Result<IntegrationResult, String> {
    if !root.is_dir() {
        return Err(format!("root does not exist: {}", root.display()));
    }
    let profile = profile_by_id(&read_profile_id(root));
    let instructions_file = resolved_instructions_file(root, profile);
    let mcp = resolved_mcp(root, profile);
    let mut written = Vec::new();
    let mut skipped = Vec::new();

    // Written for EVERY profile -- the change W4 makes. Before this, a
    // profile without an McpLayout errored out and got nothing at all.
    written.push(
        write_instructions_block(root, &instructions_file, instructions_block_for(mcp.as_ref()))
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .to_string(),
    );

    // The two capabilities are reported separately: after sub-project B
    // every stock profile gets its MCP config, and only the skill file is
    // still skipped for the four with no skill mechanism to write to.
    let no_skill_file = || {
        (
            "skill file".to_string(),
            format!(
                "{} has no skill mechanism — the guidance is inline in {instructions_file}",
                profile.label
            ),
        )
    };

    match mcp.as_ref() {
        Some(layout) => {
            let binary = resolve_binary().map_err(|e| e.to_string())?;
            if layout.skills.is_empty() {
                skipped.push(no_skill_file());
            } else {
                written.extend(
                    write_skills(root, layout)
                        .map_err(|e| e.to_string())?
                        .into_iter()
                        .map(|p| p.to_string_lossy().to_string()),
                );
            }
            written.push(
                write_mcp_config(root, layout, &binary)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .to_string(),
            );
        }
        None => {
            skipped.push(no_skill_file());
            skipped.push((
                "MCP config".to_string(),
                format!(
                    "no MCP config file set for {} — name one in Settings and re-run",
                    profile.label
                ),
            ));
        }
    }
    Ok(IntegrationResult { written, skipped })
}

/// One authored document per agent-driven flow (W6), delivered two ways:
/// installed as a real skill where the profile has a skill mechanism, and
/// inlined into the prompt where it does not. One source either way, so
/// the guidance can be reviewed as a file rather than a format string.
struct StepSkill {
    /// Directory name under the profile's skill root, and the name the
    /// prompt invokes.
    name: &'static str,
    document: &'static str,
}

fn step_skill(flow: &str) -> Option<StepSkill> {
    match flow {
        "prd" => Some(StepSkill { name: "gavin-write-prd", document: PRD_SKILL_MD }),
        "agent-file" => {
            Some(StepSkill { name: "gavin-write-agent-file", document: AGENT_FILE_SKILL_MD })
        }
        _ => None,
    }
}

/// Installs the flow's skill (when the profile supports skills) and
/// returns the prompt that starts the agent on it. The caller wraps this
/// with buildRunCommand; only profiles with prompt_arg get that far.
#[tauri::command]
pub fn compose_agent_prompt(root_path: String, flow: String) -> Result<String, String> {
    let root = Path::new(&root_path);
    if !root.is_dir() {
        return Err(format!("root does not exist: {root_path}"));
    }
    let skill = step_skill(&flow).ok_or_else(|| format!("unknown flow: {flow}"))?;
    let profile = profile_by_id(&read_profile_id(root));
    let instructions_file = resolved_instructions_file(root, profile);
    let target = match flow.as_str() {
        "prd" => ".gavin-root/PRD.md".to_string(),
        _ => instructions_file,
    };

    // Keyed on the skill slot, not on MCP: a profile can have an MCP
    // config and still have nowhere to put a skill file, which is true of
    // every profile but Claude Code.
    match resolved_mcp(root, profile).as_ref().and_then(ResolvedMcp::skill_slot) {
        Some((parent, file)) => {
            // The step skill sits beside the gavin-managed ones: same
            // parent directory, one directory per skill, matching the
            // profile.
            let dir = root.join(parent).join(skill.name);
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            std::fs::write(dir.join(file), skill.document).map_err(|e| e.to_string())?;
            Ok(format!(
                "Use the {} skill to write {target} for this repo. Interview me first.",
                skill.name
            ))
        }
        None => Ok(format!(
            "Write {target} for this repo, following these instructions exactly.\n\n{}",
            skill.document
        )),
    }
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
    /// The file this profile's agent reads MCP config from, so the
    /// settings copy can name it rather than saying ".mcp.json" at every
    /// profile. Empty for `custom`, whose path lives in config.toml.
    pub mcp_config_file: String,
    pub prompt_arg: bool,
}

/// The dialects a `custom` profile can be pointed at, for the settings
/// picker. Same one-source-of-truth reason as agent_profiles().
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpFormatDto {
    pub id: String,
    pub label: String,
}

#[tauri::command]
pub fn mcp_formats() -> Vec<McpFormatDto> {
    McpFormat::ALL
        .iter()
        .map(|f| McpFormatDto {
            id: f.id().to_string(),
            label: match f {
                McpFormat::JsonServers => "JSON — mcpServers".to_string(),
                McpFormat::JsonServersStdio => "JSON — mcpServers, typed stdio".to_string(),
                McpFormat::JsonLocal => "JSON — mcp, command array".to_string(),
                McpFormat::TomlServers => "TOML — [mcp_servers]".to_string(),
            },
        })
        .collect()
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
            mcp_config_file: p.mcp.as_ref().map(|m| m.config_file).unwrap_or("").to_string(),
            prompt_arg: p.prompt_arg,
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
    fn claude_layout() -> ResolvedMcp {
        profile_by_id("claude-code").mcp.as_ref().unwrap().into()
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

    /// The conventions re-verified 2026-08-23, pinned so a drift in the
    /// table is a failing test rather than a config written to the wrong
    /// path. `custom` is the only row with no layout: its path comes from
    /// the workspace's own config, not from here.
    #[test]
    fn every_stock_profile_writes_its_own_verified_mcp_layout() {
        let layouts: Vec<(&str, &str, McpFormat)> = AGENT_PROFILES
            .iter()
            .filter_map(|p| p.mcp.as_ref().map(|m| (p.id, m.config_file, m.format)))
            .collect();
        assert_eq!(
            layouts,
            [
                ("claude-code", ".mcp.json", McpFormat::JsonServers),
                ("codex", ".codex/config.toml", McpFormat::TomlServers),
                ("gemini", ".gemini/settings.json", McpFormat::JsonServers),
                ("cursor", ".cursor/mcp.json", McpFormat::JsonServersStdio),
                ("opencode", "opencode.json", McpFormat::JsonLocal),
            ]
        );
        assert!(profile_by_id("custom").mcp.is_none(), "custom is user-supplied");
        for p in AGENT_PROFILES {
            if let Some(m) = p.mcp.as_ref() {
                assert_eq!(m.server_key, "gavin", "{} names the server oddly", p.id);
            }
        }
    }

    /// Only Claude Code has somewhere gavin can install a skill file; the
    /// rest carry the same guidance inline (spec §9, settled by the init
    /// wizard). This is what instructions_block_for and compose_agent_prompt
    /// both key on, so it is worth pinning on its own.
    #[test]
    fn only_claude_code_has_a_skill_slot() {
        let with_skills: Vec<&str> = AGENT_PROFILES
            .iter()
            .filter(|p| p.mcp.as_ref().is_some_and(|m| !m.skills.is_empty()))
            .map(|p| p.id)
            .collect();
        assert_eq!(with_skills, ["claude-code"]);
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

    // Was setup_refuses_a_profile_with_no_mcp_layout: a profile without an
    // MCP layout now degrades (see the tests below) rather than refusing.
    // The surviving refusal is a root that is not there at all.
    #[test]
    fn setup_refuses_a_root_that_does_not_exist() {
        let err = setup_agent_integration("/no/such/root".to_string()).unwrap_err();
        assert!(err.contains("root does not exist"), "got: {err}");
    }

    fn rooted_with_profile(dir: &std::path::Path, profile: &str) -> String {
        let g = dir.join(".gavin-root");
        std::fs::create_dir_all(&g).unwrap();
        std::fs::write(g.join("config.toml"), format!("[agent]\nprofile = \"{profile}\"\n"))
            .unwrap();
        dir.to_string_lossy().to_string()
    }

    /// Stands in for the gavin-mcp binary the real command resolves
    /// beside the app.
    fn fake_binary() -> impl Fn() -> anyhow::Result<PathBuf> {
        || Ok(PathBuf::from("/apps/gavin-mcp"))
    }

    /// The shrink sub-project B is for: Codex gets its MCP config, so only
    /// the skill file is still named as skipped.
    #[test]
    fn integration_writes_mcp_for_a_profile_with_no_skill_mechanism() {
        let dir = tempfile::tempdir().unwrap();
        rooted_with_profile(dir.path(), "codex");

        let result = run_integration(dir.path(), fake_binary()).unwrap();

        // The agent file IS written, which was the whole point of W4.
        assert!(dir.path().join("AGENTS.md").is_file());
        assert!(result.written.iter().any(|w| w.ends_with("AGENTS.md")));
        // ...and now so is the MCP config.
        assert!(dir.path().join(".codex/config.toml").is_file());
        assert!(result.written.iter().any(|w| w.ends_with(".codex/config.toml")));

        let skipped: Vec<&str> = result.skipped.iter().map(|(what, _)| what.as_str()).collect();
        assert_eq!(skipped, ["skill file"], "MCP config is no longer skipped");
        assert!(result.skipped[0].1.contains("Codex CLI"), "the reason names the profile");
    }

    /// Both omissions survive only where there is no layout at all, which
    /// after sub-project B means an unconfigured `custom` profile.
    #[test]
    fn integration_names_both_omissions_only_without_a_layout() {
        let dir = tempfile::tempdir().unwrap();
        rooted_with_profile(dir.path(), "custom");
        // `custom` carries no default agent file, so name one.
        let g = dir.path().join(".gavin-root");
        let base = "[agent]\nprofile = \"custom\"\nfile = \"RULES.md\"\n";
        std::fs::write(g.join("config.toml"), base).unwrap();

        let result = run_integration(dir.path(), fake_binary()).unwrap();

        assert!(dir.path().join("RULES.md").is_file());
        let skipped: Vec<&str> = result.skipped.iter().map(|(what, _)| what.as_str()).collect();
        assert_eq!(skipped, ["skill file", "MCP config"]);
    }

    #[test]
    fn a_profile_with_mcp_but_no_skill_mechanism_gets_the_guidance_inline() {
        let dir = tempfile::tempdir().unwrap();
        rooted_with_profile(dir.path(), "codex");

        run_integration(dir.path(), fake_binary()).unwrap();

        let body = std::fs::read_to_string(dir.path().join("AGENTS.md")).unwrap();
        assert!(body.contains(MARKER_START) && body.contains(MARKER_END));
        assert!(!body.contains("SKILL.md"), "no skill file exists to point at");
        assert!(body.contains("`.gavin-root/plans/`"), "the guidance is inline instead");
        // The line the inline block could not carry before this work.
        assert!(body.contains("gavin_set_plan_field"), "it can call the tools now: {body}");
    }

    fn custom_rooted(dir: &std::path::Path, extra: &str) {
        let g = dir.join(".gavin-root");
        std::fs::create_dir_all(&g).unwrap();
        std::fs::write(
            g.join("config.toml"),
            format!("[agent]\nprofile = \"custom\"\nfile = \"RULES.md\"\n{extra}"),
        )
        .unwrap();
    }

    /// The `custom` row's whole point: a path the table cannot know, in
    /// whichever dialect that agent reads.
    #[test]
    fn a_custom_profile_writes_the_config_its_own_settings_name() {
        for (format, config_file, probe) in [
            ("json-servers", ".aider/mcp.json", "/mcpServers/gavin/command"),
            ("json-servers-stdio", "tools/mcp.json", "/mcpServers/gavin/type"),
            ("json-local", "myagent.json", "/mcp/gavin/type"),
        ] {
            let dir = tempfile::tempdir().unwrap();
            custom_rooted(
                dir.path(),
                &format!("mcp_file = \"{config_file}\"\nmcp_format = \"{format}\"\n"),
            );

            let result = run_integration(dir.path(), fake_binary()).unwrap();

            let written = dir.path().join(config_file);
            assert!(written.is_file(), "{format} did not write {config_file}");
            assert!(result.written.iter().any(|w| w.ends_with(config_file)));
            let v: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&written).unwrap()).unwrap();
            assert!(v.pointer(probe).is_some(), "{format} wrote the wrong shape: {v}");
            // Only the skill file is still out of reach.
            let skipped: Vec<&str> = result.skipped.iter().map(|(w, _)| w.as_str()).collect();
            assert_eq!(skipped, ["skill file"], "{format}");
        }

        // ...and the TOML dialect, which needs a different parser.
        let dir = tempfile::tempdir().unwrap();
        custom_rooted(
            dir.path(),
            "mcp_file = \".myagent/config.toml\"\nmcp_format = \"toml-servers\"\n",
        );
        run_integration(dir.path(), fake_binary()).unwrap();
        let text = std::fs::read_to_string(dir.path().join(".myagent/config.toml")).unwrap();
        let parsed = text.parse::<toml::Table>().unwrap();
        assert_eq!(parsed["mcp_servers"]["gavin"]["command"].as_str().unwrap(), "/apps/gavin-mcp");
    }

    /// An unnamed dialect is the JSON shape three of the five CLIs use --
    /// the best guess for a sixth, and better than refusing to write.
    #[test]
    fn an_unnamed_or_unknown_custom_format_falls_back_to_mcp_servers_json() {
        for extra in
            ["mcp_file = \"agent.json\"\n", "mcp_file = \"agent.json\"\nmcp_format = \"yaml?\"\n"]
        {
            let dir = tempfile::tempdir().unwrap();
            custom_rooted(dir.path(), extra);
            run_integration(dir.path(), fake_binary()).unwrap();
            let written = std::fs::read_to_string(dir.path().join("agent.json")).unwrap();
            let v: serde_json::Value = serde_json::from_str(&written).unwrap();
            assert_eq!(v.pointer("/mcpServers/gavin/command").unwrap(), "/apps/gavin-mcp");
        }
    }

    /// A settings box must never become a writer outside the root -- the
    /// promise move_agent_file already makes for the agent-file field. A
    /// refused path degrades to "no layout", not to a write somewhere else.
    #[test]
    fn a_custom_mcp_path_that_escapes_the_root_is_refused() {
        for escape in ["/etc/mcp.json", "../outside.json", "a/../../outside.json", "   "] {
            assert!(usable_mcp_path(escape).is_none(), "allowed {escape}");
        }
        assert_eq!(usable_mcp_path(" .aider/mcp.json ").unwrap(), ".aider/mcp.json");

        let dir = tempfile::tempdir().unwrap();
        custom_rooted(dir.path(), "mcp_file = \"../escaped.json\"\n");
        let result = run_integration(dir.path(), fake_binary()).unwrap();
        let skipped: Vec<&str> = result.skipped.iter().map(|(w, _)| w.as_str()).collect();
        assert_eq!(skipped, ["skill file", "MCP config"]);
        assert!(!dir.path().parent().unwrap().join("escaped.json").exists());
    }

    /// Without an MCP config there are no tools to name, so the plain
    /// inline block must not promise any.
    #[test]
    fn the_inline_block_names_the_tools_only_when_a_config_was_written() {
        let codex = ResolvedMcp::from(profile_by_id("codex").mcp.as_ref().unwrap());
        let with_mcp = instructions_block_for(Some(&codex));
        let without = instructions_block_for(None);
        assert!(with_mcp.contains("gavin_set_plan_field"));
        assert!(!without.contains("gavin_"), "custom has no MCP config yet: {without}");
        assert!(without.contains("`.gavin-root/plans/`"), "the rest of the guidance is the same");
    }

    #[test]
    fn claude_code_keeps_the_pointer_block_and_its_layout() {
        // resolve_mcp_binary_path needs the binary beside current_exe, which
        // is not true under cargo test -- so assert on what does not need it.
        let block = instructions_block_for(Some(&claude_layout()));
        assert!(block.contains(".claude/skills/gavin/SKILL.md"));
        assert!(profile_by_id("claude-code").mcp.is_some());
        assert!(instructions_block_for(Some(&layout("codex"))) != block);
    }

    #[test]
    fn compose_prompt_invokes_the_skill_by_name_for_a_skill_capable_profile() {
        let dir = tempfile::tempdir().unwrap();
        let root = rooted_with_profile(dir.path(), "claude-code");

        let prompt = compose_agent_prompt(root, "prd".to_string()).unwrap();

        assert!(prompt.contains("gavin-write-prd"), "invokes the skill by name");
        assert!(prompt.len() < 400, "a skill-capable profile gets a short prompt, not the doc");
        assert!(dir.path().join(".claude/skills/gavin-write-prd/SKILL.md").is_file());
    }

    #[test]
    fn compose_prompt_inlines_the_document_when_there_is_no_skill_mechanism() {
        let dir = tempfile::tempdir().unwrap();
        let root = rooted_with_profile(dir.path(), "codex");

        let prompt = compose_agent_prompt(root, "prd".to_string()).unwrap();

        assert!(prompt.contains("## Vision"), "the guidance itself is in the prompt");
        assert!(!dir.path().join(".claude").exists(), "no skill dir for a profile without one");
    }

    #[test]
    fn compose_prompt_names_the_configured_agent_file_for_the_agent_file_flow() {
        let dir = tempfile::tempdir().unwrap();
        let g = dir.path().join(".gavin-root");
        std::fs::create_dir_all(&g).unwrap();
        std::fs::write(
            g.join("config.toml"),
            "[agent]\nprofile = \"claude-code\"\nfile = \"NOTES.md\"\n",
        )
        .unwrap();

        let prompt = compose_agent_prompt(
            dir.path().to_string_lossy().to_string(),
            "agent-file".to_string(),
        )
        .unwrap();

        assert!(prompt.contains("NOTES.md"), "the prompt names the configured file");
    }

    #[test]
    fn compose_prompt_rejects_an_unknown_flow() {
        let dir = tempfile::tempdir().unwrap();
        let root = rooted_with_profile(dir.path(), "claude-code");
        assert!(compose_agent_prompt(root, "not-a-flow".to_string()).is_err());
    }

    /// Verified 2026-08-23 against each CLI's own argument parser. The
    /// two absences are verified too: `cursor` opens paths, and
    /// opencode's bare positional is a project directory -- both would
    /// swallow a prompt as a filename.
    #[test]
    fn prompt_arg_is_set_only_where_the_convention_is_verified() {
        let with_prompt: Vec<&str> =
            AGENT_PROFILES.iter().filter(|p| p.prompt_arg).map(|p| p.id).collect();
        assert_eq!(with_prompt, ["claude-code", "codex", "gemini"]);
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
        let p = write_mcp_config(dir.path(), &claude_layout(), binary).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v.pointer("/mcpServers/gavin/command").unwrap(), "/apps/gavin-mcp");
        // Existing with another server + stale gavin → both handled.
        std::fs::write(
            &p,
            r#"{ "mcpServers": { "other": { "command": "/bin/other" }, "gavin": { "command": "/old" } }, "unrelated": true }"#,
        )
        .unwrap();
        write_mcp_config(dir.path(), &claude_layout(), binary).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v.pointer("/mcpServers/other/command").unwrap(), "/bin/other");
        assert_eq!(v.pointer("/mcpServers/gavin/command").unwrap(), "/apps/gavin-mcp");
        assert_eq!(v.pointer("/unrelated").unwrap(), true);
        // Unparseable → error, file untouched.
        std::fs::write(&p, "{not json").unwrap();
        assert!(write_mcp_config(dir.path(), &claude_layout(), binary).is_err());
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{not json");
    }

    fn layout(id: &str) -> ResolvedMcp {
        profile_by_id(id).mcp.as_ref().unwrap().into()
    }

    /// Gemini and Cursor are the "path change only" pair -- except Cursor's
    /// docs now list `type` as required for a local server, so its entry
    /// carries one and Gemini's does not.
    #[test]
    fn gemini_and_cursor_write_mcp_servers_at_their_own_paths() {
        let dir = tempfile::tempdir().unwrap();
        let binary = Path::new("/apps/gavin-mcp");

        // Neither .gemini/ nor .cursor/ exists yet: the writer creates them.
        let g = write_mcp_config(dir.path(), &layout("gemini"), binary).unwrap();
        assert!(g.ends_with(".gemini/settings.json"), "{g:?}");
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&g).unwrap()).unwrap();
        assert_eq!(v.pointer("/mcpServers/gavin/command").unwrap(), "/apps/gavin-mcp");
        assert_eq!(v.pointer("/mcpServers/gavin/args").unwrap(), &serde_json::json!([]));
        assert!(v.pointer("/mcpServers/gavin/type").is_none(), "not a documented Gemini field");

        let c = write_mcp_config(dir.path(), &layout("cursor"), binary).unwrap();
        assert!(c.ends_with(".cursor/mcp.json"), "{c:?}");
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&c).unwrap()).unwrap();
        assert_eq!(v.pointer("/mcpServers/gavin/type").unwrap(), "stdio");
        assert_eq!(v.pointer("/mcpServers/gavin/command").unwrap(), "/apps/gavin-mcp");
    }

    /// opencode's second JSON shape: a different container, and the
    /// command is the array -- there is no separate args list to put the
    /// empty one in.
    #[test]
    fn opencode_writes_a_local_server_with_a_command_array() {
        let dir = tempfile::tempdir().unwrap();
        let binary = Path::new("/apps/gavin-mcp");
        // An existing file keeps its $schema, its other servers and its
        // unrelated top-level settings.
        std::fs::write(
            dir.path().join("opencode.json"),
            r#"{ "$schema": "https://opencode.ai/config.json", "model": "x/y",
                 "mcp": { "other": { "type": "local", "command": ["/bin/other"] } } }"#,
        )
        .unwrap();

        let p = write_mcp_config(dir.path(), &layout("opencode"), binary).unwrap();
        assert!(p.ends_with("opencode.json"), "{p:?}");
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v.pointer("/mcp/gavin/type").unwrap(), "local");
        let command = serde_json::json!(["/apps/gavin-mcp"]);
        assert_eq!(v.pointer("/mcp/gavin/command").unwrap(), &command);
        assert_eq!(v.pointer("/mcp/gavin/enabled").unwrap(), true);
        assert!(v.pointer("/mcpServers").is_none(), "opencode's container is `mcp`");
        assert_eq!(v.pointer("/$schema").unwrap(), "https://opencode.ai/config.json");
        assert_eq!(v.pointer("/model").unwrap(), "x/y");
        assert_eq!(v.pointer("/mcp/other/command").unwrap(), &serde_json::json!(["/bin/other"]));
    }

    /// The TOML writer owes everything the JSON one does -- other servers
    /// survive, a stale gavin is replaced -- plus the thing only a
    /// format-preserving writer can promise: the comments and key order of
    /// a hand-edited file come through untouched.
    #[test]
    fn codex_toml_merges_and_preserves_comments() {
        let dir = tempfile::tempdir().unwrap();
        let binary = Path::new("/apps/gavin-mcp");

        // Absent → created, with .codex/ made on the way.
        let p = write_mcp_config(dir.path(), &layout("codex"), binary).unwrap();
        assert!(p.ends_with(".codex/config.toml"), "{p:?}");
        let parsed = std::fs::read_to_string(&p).unwrap().parse::<toml::Table>().unwrap();
        let gavin = parsed["mcp_servers"]["gavin"].as_table().unwrap();
        assert_eq!(gavin["command"].as_str().unwrap(), "/apps/gavin-mcp");
        assert!(gavin["args"].as_array().unwrap().is_empty());

        // A hand-edited file: comments, an unrelated setting, another
        // server, and a stale gavin entry.
        std::fs::write(
            &p,
            "# my codex config\nmodel = \"gpt-5\"\n\n\
             # the linter's server\n[mcp_servers.linty]\ncommand = \"/bin/linty\"\n\n\
             [mcp_servers.gavin]\ncommand = \"/old/gavin-mcp\"\nargs = [\"--stale\"]\n",
        )
        .unwrap();
        write_mcp_config(dir.path(), &layout("codex"), binary).unwrap();

        let text = std::fs::read_to_string(&p).unwrap();
        assert!(text.contains("# my codex config"), "{text}");
        assert!(text.contains("# the linter's server"), "{text}");
        let parsed = text.parse::<toml::Table>().unwrap();
        assert_eq!(parsed["model"].as_str().unwrap(), "gpt-5");
        assert_eq!(parsed["mcp_servers"]["linty"]["command"].as_str().unwrap(), "/bin/linty");
        let gavin = parsed["mcp_servers"]["gavin"].as_table().unwrap();
        assert_eq!(gavin["command"].as_str().unwrap(), "/apps/gavin-mcp");
        assert!(gavin["args"].as_array().unwrap().is_empty(), "the stale args are replaced");

        // Unparseable → error, file untouched.
        std::fs::write(&p, "[[[not toml").unwrap();
        assert!(write_mcp_config(dir.path(), &layout("codex"), binary).is_err());
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "[[[not toml");
    }

    #[test]
    fn instructions_block_appends_replaces_and_never_touches_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        // Absent → created with just the block.
        let p = write_instructions_block(dir.path(), "CLAUDE.md", BLOCK_WITH_SKILL).unwrap();
        let first = std::fs::read_to_string(&p).unwrap();
        assert!(first.starts_with(MARKER_START));
        // Existing content → appended after it.
        std::fs::write(&p, "# My rules\n\nKeep tests green.\n").unwrap();
        write_instructions_block(dir.path(), "CLAUDE.md", BLOCK_WITH_SKILL).unwrap();
        let appended = std::fs::read_to_string(&p).unwrap();
        assert!(appended.starts_with("# My rules"));
        assert!(appended.contains(MARKER_START));
        // Re-run → block replaced in place, custom content above AND below intact.
        let with_tail = format!("{appended}## After\n\ntail text\n");
        std::fs::write(&p, &with_tail).unwrap();
        write_instructions_block(dir.path(), "CLAUDE.md", BLOCK_WITH_SKILL).unwrap();
        let replaced = std::fs::read_to_string(&p).unwrap();
        assert!(replaced.starts_with("# My rules"));
        assert!(replaced.contains("tail text"));
        assert_eq!(replaced.matches(MARKER_START).count(), 1);
    }

    #[test]
    fn every_skill_is_written_and_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let paths = write_skills(dir.path(), &claude_layout()).unwrap();
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
        write_skills(dir.path(), &claude_layout()).unwrap();
        assert!(std::fs::read_to_string(&paths[0]).unwrap().contains("gavin_create_plan"));
        assert!(std::fs::read_to_string(&paths[1]).unwrap().contains("gavin_get_orchestration"));
    }

    #[test]
    fn the_two_skills_land_in_different_directories() {
        let dir = tempfile::tempdir().unwrap();
        let paths = write_skills(dir.path(), &claude_layout()).unwrap();
        assert!(paths[0].ends_with(".claude/skills/gavin/SKILL.md"), "{:?}", paths[0]);
        assert!(paths[1].ends_with(".claude/skills/gavin-orchestrate/SKILL.md"), "{:?}", paths[1]);
    }
}
