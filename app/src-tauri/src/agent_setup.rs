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
    /// The argv that makes this agent run ONE prompt with no TUI and
    /// then exit: `<command> <headless_args> "<prompt>"`. Empty where
    /// the convention is unverified, which hides every background run --
    /// a hidden session that never exits is a spinner with no end, so
    /// this is a harder requirement than `prompt_arg` alone.
    ///
    /// The tool allow-list is part of it: a headless agent cannot be
    /// asked to approve anything, so a run with no grant is a run that
    /// can only report it was refused. Scoped to git deliberately --
    /// gavin's background runs are git work, and a blanket bypass is
    /// not gavin's to hand out.
    ///
    /// Must end in `--`. Verified the hard way: claude's allow-list flag
    /// takes a VARIADIC value, so without the separator it swallows the
    /// prompt that follows and the run dies with "input must be provided
    /// either through stdin or as a prompt argument". The separator also
    /// keeps a prompt that starts with `-` from being read as a flag.
    pub headless_args: &'static str,
    /// The flag that selects a model, e.g. `--model`. Empty where the
    /// command takes none -- `cursor` is the IDE launcher, and `custom`
    /// is the user's own argv. An empty flag hides every model control
    /// for the profile rather than guessing one, which is the same
    /// posture `headless_args` takes above.
    pub model_flag: &'static str,
    /// Model names offered as picks. Only ever names the CLI itself
    /// documents as STABLE aliases: `claude --help` names `fable`,
    /// `opus` and `sonnet`, which point at the latest model of each tier
    /// and so never go stale. Nobody else offers that -- `opencode
    /// models` is a per-user catalogue built from whichever providers
    /// that user configured, and Gemini's and Codex's names are dated
    /// ids that rot -- so those rows ship empty and the user types what
    /// they want. A wrong name here lands in somebody's argv.
    pub models: &'static [&'static str],
    /// The text this agent prints on screen when it has STOPPED because
    /// something BROKE, rather than because its turn ended. Handed to the
    /// daemon per session (`Request::SetFailurePatterns`) and matched
    /// against the RENDERED screen, which is the only place an error
    /// banner painted by a TUI is contiguous text.
    ///
    /// Verified rows only, and the empty list is the honest default:
    /// no patterns means NO failure detection for this profile, never
    /// "nothing failed". A guessed pattern is worse than none -- it
    /// paints healthy sessions as broken and pauses rails for nothing.
    ///
    /// claude-code's was measured, not guessed: a connection reset
    /// before the response, a stream killed mid-flight, a 429 usage
    /// limit and an expired token all leave the process ALIVE and quiet
    /// with one line on screen, and the only thing every one of them
    /// shares is `API Error:`.
    pub failure_patterns: &'static [&'static str],
    /// What each of those failures MEANS, for the one caller that has to
    /// act on it without a human: auto-resume.
    ///
    /// `failure_patterns` answers "did this agent break"; a rail deciding
    /// whether to resume itself needs "broke HOW", because the answers
    /// are opposites. A dead network is worth another try the moment it
    /// comes back; an expired token loops against a wall until somebody
    /// runs `/login`; an exhausted usage limit is a wait for a reset that
    /// no amount of retrying brings forward.
    ///
    /// Ordered, and FIRST MATCH WINS -- which is load-bearing, not
    /// incidental. Claude Code's expired-token line reads "Please run
    /// /login" followed by "API Error: 401 OAuth token has expired", so
    /// it carries the generic marker too; the auth row has to be reached
    /// first or an auth failure classifies as a network one and gavin
    /// resumes into a login prompt.
    ///
    /// It belongs to the PROFILE for the same reason the patterns do:
    /// this is the agent's own vocabulary, opencode's will differ, and a
    /// hard-coded table becomes a silent regression the day a CLI rewords
    /// its errors. A profile with no rows classifies every failure as
    /// `unknown`, and `unknown` never auto-resumes -- which is today's
    /// behaviour, and the honest one.
    pub failure_causes: &'static [FailureCausePattern],
    /// The argv that makes this agent take a conversation id supplied by
    /// the CALLER: `<command> <session_id_args> <uuid>`. Gavin mints the
    /// uuid when it builds the run command, so it holds the id from the
    /// first byte and never has to scrape the agent's store or guess by
    /// mtime.
    ///
    /// Empty where the convention is unverified -- the same posture
    /// `headless_args` takes, and for the same reason: a wrong flag puts
    /// garbage in the agent's argv.
    pub session_id_args: &'static str,
    /// The argv that reopens that conversation: `<command> <resume_args>
    /// <uuid>`, run in the directory the run was LAUNCHED in.
    ///
    /// Always empty when `session_id_args` is (see the guard test): an id
    /// gavin never fixed at launch is an id it cannot resume by, and
    /// resuming by anything else is how you get a silent fresh
    /// conversation wearing a better name.
    ///
    /// A profile with none keeps today's behaviour and falls back to
    /// `composeResumeTaskPrompt` -- a written reconstruction instead of
    /// the conversation itself.
    pub resume_args: &'static str,
    /// How gavin reads this agent's SUBSCRIPTION limits -- the windows
    /// the account is spending against, not the tokens one conversation
    /// happened to burn.
    ///
    /// `None` is the honest default and the common case: three of the
    /// five profiles expose nothing an outside process can read, and the
    /// usage panel says so in those words rather than showing a bar it
    /// invented. The same posture as `failure_patterns` -- an empty row
    /// means "gavin cannot see this", never "there is no limit".
    ///
    /// What was checked, 2026-09-02:
    ///
    /// - `gemini` -- `/stats` renders through Ink and prints nothing when
    ///   piped; `~/.gemini/tmp/*/chats/session-*.json` carries per-session
    ///   token totals, which is a burn estimate and not a quota. No row.
    /// - `cursor` -- usage lives in the web dashboard. No row.
    /// - `opencode` -- provider keys are the user's own, so there is no
    ///   single limit to report. No row.
    pub usage_probe: Option<UsageProbe>,
    pub mcp: Option<McpLayout>,
}

/// Where a profile's usage numbers come from. One variant per VERIFIED
/// route, never a generic "run this command and parse it": every route
/// below has its own auth, its own shape and its own failure mode, and
/// flattening them into a string would move all three into the caller.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum UsageProbe {
    /// Claude Code. `GET https://api.anthropic.com/api/oauth/usage` with
    /// the CLI's own OAuth token, which answers with a `five_hour` and a
    /// `seven_day` object, each `{utilization, resets_at}`.
    ///
    /// Chosen over the two alternatives deliberately. The statusline's
    /// stdin JSON carries the same numbers
    /// (`rate_limits.five_hour.used_percentage`), but a profile has ONE
    /// statusline and taking it would silently replace whatever the human
    /// runs there. Summing `~/.claude/projects/**.jsonl` needs no
    /// credential at all, but it can only ever produce a local burn
    /// estimate -- blind to the same account on another machine and to
    /// claude.ai -- and a bar that disagrees with `/usage` is worse than
    /// no bar.
    ///
    /// The endpoint is account truth for every device, which is the whole
    /// reason it is worth reaching for a credential to read it.
    AnthropicOauth,
    /// Codex CLI. Read the newest `token_count` event out of the rollout
    /// files under `~/.codex/sessions`, whose payload carries
    /// `rate_limits.primary` and `.secondary`, each with `used_percent`,
    /// `window_minutes` and either `resets_at` or `resets_in_seconds`.
    ///
    /// Chosen over `codex app-server`'s `account/rateLimits/read`, which
    /// is live rather than last-seen but which nothing here could verify:
    /// `codex` resolves to a shim on this machine, so the handshake, the
    /// method name and the reply shape would all have been copied from a
    /// blog post into a subprocess gavin spawns. A file whose shape is
    /// checked is worth more than an RPC that is not, and the cost is
    /// staleness -- which is reportable. The reading carries the event's
    /// own timestamp so the panel can say how old it is, and a number
    /// with an age on it is never mistaken for a live one.
    ///
    /// `resets_in_seconds` is why the timestamp is load-bearing rather
    /// than decorative: it is relative to the moment the event was
    /// written, so resolving it against `now` would under-report the
    /// remaining wait by however long codex has been idle.
    CodexRollout,
}

impl UsageProbe {
    /// The wire name the frontend keys on. Stable strings, like
    /// `McpFormat::id`: they reach `agentUsage.ts` and a rename here
    /// without one there silently turns every probe into "unsupported".
    pub fn id(self) -> &'static str {
        match self {
            UsageProbe::AnthropicOauth => "anthropic-oauth",
            UsageProbe::CodexRollout => "codex-rollout",
        }
    }
}

/// One row of a profile's cause table: a substring of the failure line
/// the daemon reported, and what that line MEANS.
///
/// `cause` is one of the ids `autoResume.ts` knows -- "network",
/// "outage", "usage-limit", "auth" -- and anything else classifies as
/// unknown there, which never resumes. Deliberately a plain string
/// rather than an enum: the app owns the trigger table, and a new cause
/// invented there must not need a Rust change to be sayable.
#[derive(Clone, Copy)]
pub struct FailureCausePattern {
    pub pattern: &'static str,
    pub cause: &'static str,
}

pub const AGENT_PROFILES: &[AgentProfile] = &[
    AgentProfile {
        id: "claude-code",
        model_flag: "--model",
        models: &["fable", "opus", "sonnet"],
        label: "Claude Code",
        instructions_file: "CLAUDE.md",
        command: "claude",
        prompt_arg: true,
        headless_args: "-p --allowedTools \"Bash(git *)\" --",
        // Measured under a PTY against a fake API (2026-09-02, Claude
        // Code v2.1.258): a connection reset, a stream killed mid-flight,
        // a 429 usage limit and a 401 expired token all end with a line
        // beginning "API Error:" and the process still alive at its
        // prompt. During the retries the session is NOT quiet -- the
        // countdown repaints once a second -- which is why the daemon
        // only reads this at the moment a quiet session would go idle.
        failure_patterns: &["API Error:"],
        // Drawn from the same measurement session as the pattern above,
        // and from nowhere else: every string here appeared verbatim on
        // a real Claude Code screen driven against a fake API. Auth is
        // FIRST because its line carries "API Error:" as well, and a
        // token that needs a login back must never read as a network
        // blip worth retrying.
        failure_causes: &[
            FailureCausePattern { pattern: "/login", cause: "auth" },
            FailureCausePattern { pattern: "OAuth token has expired", cause: "auth" },
            FailureCausePattern { pattern: "exceeded your usage limit", cause: "usage-limit" },
            FailureCausePattern { pattern: "usage limit", cause: "usage-limit" },
            FailureCausePattern { pattern: "529 Overloaded", cause: "outage" },
            FailureCausePattern { pattern: "Overloaded", cause: "outage" },
            FailureCausePattern { pattern: "Connection dropped", cause: "network" },
            FailureCausePattern { pattern: "ECONNRESET", cause: "network" },
            FailureCausePattern { pattern: "empty or malformed response", cause: "network" },
            FailureCausePattern { pattern: "Connection error", cause: "network" },
        ],
        // `claude --session-id <uuid>` (a real UUID; the CLI validates
        // it) and `claude --resume <uuid>`. Verified end to end: the
        // transcript is written to `<uuid>.jsonl`, resume comes back
        // carrying the conversation, and it APPENDS to that same file
        // rather than rotating it -- which is why gavin reuses the id
        // instead of `--fork-session`. The failed attempt stays readable
        // either way, so the one argument for forking does not apply.
        session_id_args: "--session-id",
        resume_args: "--resume",
        usage_probe: Some(UsageProbe::AnthropicOauth),
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
                // Loaded by the In Progress column's Resume: the card
                // it names was worked on before, and picking that up is
                // a different job from starting it.
                SkillFile {
                    dir: ".claude/skills/gavin-resume",
                    file: "SKILL.md",
                    contents: include_str!("gavin_resume_skill.md"),
                },
                // The To Do counterpart, loaded by a card's "Develop
                // into a plan": the card is one line of intent, and
                // turning it into steps is an interview, not a build.
                SkillFile {
                    dir: ".claude/skills/gavin-develop",
                    file: "SKILL.md",
                    contents: include_str!("gavin_develop_skill.md"),
                },
            ],
        }),
    },
    AgentProfile {
        id: "codex",
        model_flag: "--model",
        models: &[],
        label: "Codex CLI",
        instructions_file: "AGENTS.md",
        command: "codex",
        // `codex "<prompt>"`: the TUI's clap parser takes an optional
        // positional PROMPT that starts the session.
        prompt_arg: true,
        headless_args: "",
        failure_patterns: &[],
        failure_causes: &[],
        session_id_args: "",
        resume_args: "",
        usage_probe: Some(UsageProbe::CodexRollout),
        mcp: Some(McpLayout {
            config_file: ".codex/config.toml",
            server_key: "gavin",
            format: McpFormat::TomlServers,
            skills: &[],
        }),
    },
    AgentProfile {
        id: "gemini",
        model_flag: "--model",
        models: &[],
        label: "Gemini CLI",
        instructions_file: "GEMINI.md",
        command: "gemini",
        // `gemini [query..]`: the positional is the initial prompt and
        // stays interactive, which is what a launched session wants.
        // (-p would run it headless and exit.)
        prompt_arg: true,
        headless_args: "",
        failure_patterns: &[],
        failure_causes: &[],
        session_id_args: "",
        resume_args: "",
        usage_probe: None,
        mcp: Some(McpLayout {
            config_file: ".gemini/settings.json",
            server_key: "gavin",
            format: McpFormat::JsonServers,
            skills: &[],
        }),
    },
    AgentProfile {
        id: "cursor",
        model_flag: "",
        models: &[],
        label: "Cursor",
        instructions_file: "AGENTS.md",
        command: "cursor",
        // Verified false, not merely unverified: `cursor` is the IDE
        // launcher and its positionals are paths, so a prompt would be
        // read as a file to open. Cursor's terminal agent is a separate
        // binary; a user who wants it points `command` at it in Settings.
        prompt_arg: false,
        headless_args: "",
        failure_patterns: &[],
        failure_causes: &[],
        session_id_args: "",
        resume_args: "",
        usage_probe: None,
        mcp: Some(McpLayout {
            config_file: ".cursor/mcp.json",
            server_key: "gavin",
            format: McpFormat::JsonServersStdio,
            skills: &[],
        }),
    },
    AgentProfile {
        id: "opencode",
        model_flag: "--model",
        models: &[],
        label: "opencode",
        instructions_file: "AGENTS.md",
        command: "opencode",
        // Also verified false: `opencode [project]`'s positional is a
        // directory to start in, so a prompt would land as a path.
        // Prompts go through the `opencode run` subcommand instead.
        prompt_arg: false,
        headless_args: "",
        failure_patterns: &[],
        failure_causes: &[],
        session_id_args: "",
        resume_args: "",
        usage_probe: None,
        mcp: Some(McpLayout {
            config_file: "opencode.json",
            server_key: "gavin",
            format: McpFormat::JsonLocal,
            skills: &[],
        }),
    },
    AgentProfile {
        id: "custom",
        model_flag: "",
        models: &[],
        label: "Custom…",
        instructions_file: "",
        command: "",
        prompt_arg: false,
        headless_args: "",
        failure_patterns: &[],
        failure_causes: &[],
        session_id_args: "",
        resume_args: "",
        usage_probe: None,
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

/// Where this workspace's PRD lives, relative to the root. The same
/// answer the daemon's `gavin::prd_relative_path` gives -- read here
/// rather than fetched, because every caller below is writing a file for
/// an agent to read and must not depend on a daemon round trip (the same
/// reason `root_agent_key` exists beside the daemon's parse). The
/// validator and the fallback both come from `protocol`, so the two
/// readers cannot disagree about what the path IS.
pub fn prd_relative_path(root: &Path) -> String {
    let read = || -> Option<String> {
        let path = root.join(".gavin-root").join("config.toml");
        let content = std::fs::read_to_string(path).ok()?;
        let table = content.parse::<toml::Table>().ok()?;
        protocol::usable_prd_path(table.get("prd")?.as_str()?)
    };
    read().unwrap_or_else(|| protocol::DEFAULT_PRD_PATH.to_string())
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
This repo is a gavin workspace. Read `{prd}` first — it leads all\n\
development. Follow the gavin workflow skill in `.claude/skills/gavin/SKILL.md`\n\
(plan before coding, keep plan statuses current, use the gavin_* MCP tools).\n";

/// Inline variant: for agents with no skill mechanism, the same guidance
/// has to live in the block itself -- there is no file to point at.
const BLOCK_INLINE: &str = "## Gavin workspace\n\n\
This repo is a gavin workspace. Read `{prd}` first — it leads all\n\
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
This repo is a gavin workspace. Read `{prd}` first — it leads all\n\
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
///
/// Every variant opens by naming the PRD, so all three are templates: a
/// workspace pointed at its own `docs/PRD.md` must not hand its agents a
/// block telling them to read a file gavin never wrote.
fn instructions_block_for(mcp: Option<&ResolvedMcp>, prd: &str) -> String {
    let template = match mcp {
        Some(layout) if !layout.skills.is_empty() => BLOCK_WITH_SKILL,
        Some(_) => BLOCK_INLINE_WITH_MCP,
        None => BLOCK_INLINE,
    };
    with_prd_path(template, prd)
}

/// The one substitution every authored document shares. Kept as a named
/// function rather than an inline `.replace` at each site so that adding a
/// document means writing `{prd}` in it and nothing else.
pub fn with_prd_path(document: &str, prd: &str) -> String {
    document.replace("{prd}", prd)
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
fn write_skills(root: &Path, layout: &ResolvedMcp, prd: &str) -> anyhow::Result<Vec<PathBuf>> {
    let mut written = Vec::new();
    for skill in layout.skills {
        let dir = root.join(skill.dir);
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(skill.file);
        // Substituted for every skill, not just the ones that mention the
        // PRD today: a document that grows a `{prd}` later needs no
        // change here, and one that has none is unaffected.
        std::fs::write(&path, with_prd_path(skill.contents, prd))?;
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
    let prd = prd_relative_path(root);
    let mut written = Vec::new();
    let mut skipped = Vec::new();

    // Written for EVERY profile -- the change W4 makes. Before this, a
    // profile without an McpLayout errored out and got nothing at all.
    written.push(
        write_instructions_block(
            root,
            &instructions_file,
            &instructions_block_for(mcp.as_ref(), &prd),
        )
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
                    write_skills(root, layout, &prd)
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

// --- What a setup run installed, for the delete wizard to undo ---------
//
// Every function below resolves through the SAME profile table and the
// SAME writers that put the files there. That is the point: a wizard
// that hardcoded `.mcp.json` and `.claude/skills/gavin` would silently
// miss a Codex workspace's `.codex/config.toml`, and a wizard with its
// own TOML editor would reformat a file gavin was careful not to.

/// Where this root's gavin files live, per the profile it is configured
/// for. Paths are absolute and may not exist -- existence is the
/// scanner's question, not this one's.
pub struct GavinInstall {
    /// The agent's instructions file, the one that carries the marker
    /// block.
    pub instructions: PathBuf,
    /// The MCP config and the key gavin's entry hangs off. None for a
    /// `custom` profile that has never been pointed at a file.
    pub mcp: Option<(PathBuf, String)>,
    /// The skill directories the profile's table lists.
    pub skills: Vec<PathBuf>,
    /// The parent those skills share, when the profile has one. Scanned
    /// for gavin-prefixed siblings too: `compose_agent_prompt` installs
    /// step skills (`gavin-write-prd`, `gavin-write-agent-file`) that
    /// appear in no table, and a wizard that only read the table would
    /// leave them behind.
    pub skill_root: Option<PathBuf>,
}

pub fn gavin_install(root: &Path) -> GavinInstall {
    let profile = profile_by_id(&read_profile_id(root));
    let instructions = root.join(resolved_instructions_file(root, profile));
    let mcp = resolved_mcp(root, profile);
    let skills = mcp
        .as_ref()
        .map(|m| m.skills.iter().map(|s| root.join(s.dir)).collect())
        .unwrap_or_default();
    let skill_root = mcp.as_ref().and_then(|m| m.skill_slot()).map(|(dir, _)| root.join(dir));
    GavinInstall {
        instructions,
        mcp: mcp.map(|m| (root.join(&m.config_file), m.server_key.to_string())),
        skills,
        skill_root,
    }
}

/// Whether the root's MCP config actually carries gavin's server entry.
/// A config file that never mentioned gavin is not the wizard's
/// business, and neither is one that does not parse -- refusing to
/// report an unreadable file is what keeps the remover from being handed
/// a file it would have to clobber to edit.
pub fn mcp_entry_present(root: &Path) -> bool {
    let profile = profile_by_id(&read_profile_id(root));
    let Some(layout) = resolved_mcp(root, profile) else { return false };
    let path = root.join(&layout.config_file);
    let Ok(content) = std::fs::read_to_string(&path) else { return false };
    match layout.format {
        McpFormat::TomlServers => content
            .parse::<toml_edit::DocumentMut>()
            .ok()
            .and_then(|doc| {
                Some(doc.get("mcp_servers")?.as_table_like()?.contains_key(layout.server_key))
            })
            .unwrap_or(false),
        _ => serde_json::from_str::<serde_json::Value>(&content)
            .ok()
            .and_then(|doc| {
                Some(doc.get(layout.format.json_container())?.get(layout.server_key).is_some())
            })
            .unwrap_or(false),
    }
}

/// Strips gavin's server entry, keeping every other server and the
/// file's own formatting -- the exact inverse of `write_mcp_config`, and
/// written with the same editors so a hand-tuned config survives being
/// un-gavined. The file is only ever EDITED: it is shared with whatever
/// else the agent talks to, so removing it is never gavin's call.
///
/// Returns whether anything changed. A file that does not parse errors
/// out rather than being rewritten, the same promise the writer makes.
pub fn remove_mcp_entry(root: &Path) -> anyhow::Result<bool> {
    let profile = profile_by_id(&read_profile_id(root));
    let Some(layout) = resolved_mcp(root, profile) else { return Ok(false) };
    let path = root.join(&layout.config_file);
    if !path.exists() {
        return Ok(false);
    }
    let content = std::fs::read_to_string(&path)?;
    match layout.format {
        McpFormat::TomlServers => {
            let mut doc = content.parse::<toml_edit::DocumentMut>().map_err(|_| {
                anyhow::anyhow!("{} is not valid TOML — fix or remove it first", path.display())
            })?;
            let Some(table) = doc.get_mut("mcp_servers").and_then(|i| i.as_table_like_mut()) else {
                return Ok(false);
            };
            if table.remove(layout.server_key).is_none() {
                return Ok(false);
            }
            std::fs::write(&path, doc.to_string())?;
        }
        _ => {
            let mut doc: serde_json::Value = serde_json::from_str(&content).map_err(|_| {
                anyhow::anyhow!("{} is not valid JSON — fix or remove it first", path.display())
            })?;
            let container = layout.format.json_container();
            let Some(servers) =
                doc.get_mut(container).and_then(|c| c.as_object_mut())
            else {
                return Ok(false);
            };
            if servers.remove(layout.server_key).is_none() {
                return Ok(false);
            }
            std::fs::write(&path, format!("{}\n", serde_json::to_string_pretty(&doc)?))?;
        }
    }
    Ok(true)
}

/// Whether a file carries the marker block. Both markers, in order --
/// half a block is a file someone edited by hand, and cutting from a
/// start marker to the end of the file would take their prose with it.
pub fn instructions_block_present(path: &Path) -> bool {
    let Ok(content) = std::fs::read_to_string(path) else { return false };
    match (content.find(MARKER_START), content.find(MARKER_END)) {
        (Some(start), Some(end)) => end >= start,
        _ => false,
    }
}

/// Cuts the marker block out, leaving the human's own prose byte for
/// byte as it was. Only the block and the newlines that bracketed it go:
/// the writer inserted a blank-line separator when it appended, so
/// removing the block without it would leave the file one newline longer
/// than the file gavin was first pointed at.
///
/// The file itself is never removed, even if the block was all it held.
/// It is the agent's instructions file, not gavin's.
pub fn remove_instructions_block(path: &Path) -> anyhow::Result<bool> {
    if !path.exists() {
        return Ok(false);
    }
    let content = std::fs::read_to_string(path)?;
    let (Some(start), Some(end)) = (content.find(MARKER_START), content.find(MARKER_END)) else {
        return Ok(false);
    };
    if end < start {
        return Ok(false);
    }
    let before = content[..start].trim_end_matches('\n');
    let after = content[end + MARKER_END.len()..].trim_start_matches('\n');
    let mut out = String::from(before);
    if !before.is_empty() {
        out.push('\n');
        if !after.is_empty() {
            out.push('\n');
        }
    }
    out.push_str(after);
    std::fs::write(path, out)?;
    Ok(true)
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
    let prd = prd_relative_path(root);
    let target = match flow.as_str() {
        "prd" => prd.clone(),
        _ => instructions_file,
    };
    // The document names the PRD too, and it is the same document whether
    // it lands as a skill file or inline in the prompt.
    let document = with_prd_path(skill.document, &prd);

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
            std::fs::write(dir.join(file), &document).map_err(|e| e.to_string())?;
            Ok(format!(
                "Use the {} skill to write {target} for this repo. Interview me first.",
                skill.name
            ))
        }
        None => Ok(format!(
            "Write {target} for this repo, following these instructions exactly.\n\n{document}"
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
    pub headless_args: String,
    /// The flag that selects a model, empty where the CLI takes none --
    /// which is how the settings panels decide whether to offer a model
    /// control for this profile at all.
    pub model_flag: String,
    /// Stable model aliases offered as picks; empty where the CLI has
    /// none worth pinning.
    pub models: Vec<String>,
    /// What this agent prints when it has BROKEN. Empty means no failure
    /// detection for the profile (see AgentProfile::failure_patterns);
    /// the app hands these to the daemon per session.
    pub failure_patterns: Vec<String>,
    /// What each of those failures means, in order (see
    /// AgentProfile::failure_causes). Read by the app's auto-resume
    /// trigger table; empty means every failure of this profile
    /// classifies as unknown, which never resumes itself.
    pub failure_causes: Vec<FailureCauseDto>,
    /// The launch and resume argv for conversation resume, both empty
    /// where the convention is unverified.
    pub session_id_args: String,
    pub resume_args: String,
    /// How gavin reads this agent's subscription limits, or `None` where
    /// it cannot (see AgentProfile::usage_probe). The usage panel keys on
    /// this to decide between a bar and a sentence explaining there is
    /// nothing to show.
    pub usage_probe: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailureCauseDto {
    pub pattern: String,
    pub cause: String,
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
            headless_args: p.headless_args.to_string(),
            model_flag: p.model_flag.to_string(),
            models: p.models.iter().map(|m| m.to_string()).collect(),
            failure_patterns: p.failure_patterns.iter().map(|f| f.to_string()).collect(),
            failure_causes: p
                .failure_causes
                .iter()
                .map(|c| FailureCauseDto { pattern: c.pattern.to_string(), cause: c.cause.to_string() })
                .collect(),
            session_id_args: p.session_id_args.to_string(),
            resume_args: p.resume_args.to_string(),
            usage_probe: p.usage_probe.map(|u| u.id().to_string()),
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
    fn only_claude_code_ships_model_presets_and_cursor_has_no_flag() {
        let by = |id: &str| AGENT_PROFILES.iter().find(|p| p.id == id).unwrap();
        // Aliases named by `claude --help`: pointers to the latest model
        // of each tier, so they cannot go stale.
        assert_eq!(by("claude-code").models, &["fable", "opus", "sonnet"]);
        assert_eq!(by("claude-code").model_flag, "--model");
        // Flags verified from each CLI's own --help; no preset names,
        // because theirs are dated ids that rot.
        assert_eq!(by("gemini").model_flag, "--model");
        assert!(by("gemini").models.is_empty());
        assert_eq!(by("opencode").model_flag, "--model");
        assert!(by("opencode").models.is_empty());
        // `cursor` is the IDE launcher -- no model control at all.
        assert_eq!(by("cursor").model_flag, "");
        assert_eq!(by("custom").model_flag, "");
    }

    #[test]
    fn profile_dto_carries_the_model_fields_in_camel_case() {
        let dto = agent_profiles().into_iter().find(|p| p.id == "claude-code").unwrap();
        let json = serde_json::to_value(&dto).unwrap();
        assert_eq!(json["modelFlag"], "--model");
        assert_eq!(json["models"], serde_json::json!(["fable", "opus", "sonnet"]));
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

    /// A headless row must also take a positional prompt: the caller
    /// builds `<command> <headless_args> '<prompt>'`, so an agent that
    /// cannot be handed a prompt in argv has nowhere to put one. And it
    /// must end in `--`, or a variadic flag ahead of the prompt eats it.
    #[test]
    fn only_claude_code_runs_headless_and_headless_rows_are_well_formed() {
        let headless: Vec<&str> =
            AGENT_PROFILES.iter().filter(|p| !p.headless_args.is_empty()).map(|p| p.id).collect();
        assert_eq!(headless, ["claude-code"]);
        for p in AGENT_PROFILES {
            if p.headless_args.is_empty() {
                continue;
            }
            assert!(p.prompt_arg, "{} runs headless but takes no positional prompt", p.id);
            assert!(
                p.headless_args.ends_with(" --"),
                "{} must end its headless argv with `--`",
                p.id
            );
        }
    }

    /// Conversation resume is all-or-nothing per profile. Resuming by an
    /// id gavin never fixed at launch is not resume at all -- the CLI
    /// would open a picker, or start fresh, which is precisely the
    /// silent from-scratch second attempt this feature exists to
    /// prevent. So a row either verifies both halves or ships neither,
    /// and the app falls back to a written reconstruction.
    #[test]
    fn conversation_resume_argv_is_all_or_nothing_per_profile() {
        let resumable: Vec<&str> =
            AGENT_PROFILES.iter().filter(|p| !p.resume_args.is_empty()).map(|p| p.id).collect();
        assert_eq!(resumable, ["claude-code"]);
        for p in AGENT_PROFILES {
            assert_eq!(
                p.resume_args.is_empty(),
                p.session_id_args.is_empty(),
                "{} verifies one half of conversation resume and not the other",
                p.id
            );
        }
    }

    /// Which profiles claim they can be asked about their limits, pinned
    /// so adding a probe is a deliberate act with a route behind it.
    ///
    /// The three `None` rows are the point of the test as much as the two
    /// `Some` ones: Gemini's `/stats` prints nothing when piped, Cursor's
    /// usage lives in a web dashboard and opencode runs on the user's own
    /// provider keys, so a bar for any of them could only be invented.
    #[test]
    fn only_profiles_with_a_route_carry_a_usage_probe() {
        let probed: Vec<(&str, &str)> = AGENT_PROFILES
            .iter()
            .filter_map(|p| p.usage_probe.map(|u| (p.id, u.id())))
            .collect();
        assert_eq!(
            probed,
            [("claude-code", "anthropic-oauth"), ("codex", "codex-rollout")]
        );
    }

    /// The wire names reach `agentUsage.ts`, which decides what to render
    /// from them. Renaming one here without renaming it there turns a
    /// working probe into "unsupported" with nothing failing, so the
    /// strings are pinned rather than derived.
    #[test]
    fn usage_probe_ids_are_stable_wire_names() {
        assert_eq!(UsageProbe::AnthropicOauth.id(), "anthropic-oauth");
        assert_eq!(UsageProbe::CodexRollout.id(), "codex-rollout");
    }

    /// The empty pattern list is a real answer -- "nobody has verified
    /// what this agent says when it breaks" -- and it must read as NO
    /// detection rather than as a licence to guess. Only rows measured
    /// against the real CLI carry one.
    #[test]
    fn only_verified_profiles_carry_failure_patterns() {
        let detecting: Vec<&str> = AGENT_PROFILES
            .iter()
            .filter(|p| !p.failure_patterns.is_empty())
            .map(|p| p.id)
            .collect();
        assert_eq!(detecting, ["claude-code"]);
        for p in AGENT_PROFILES {
            for pattern in p.failure_patterns {
                assert!(!pattern.trim().is_empty(), "{} carries a blank pattern", p.id);
            }
        }
    }

    /// A cause table without patterns to classify is dead weight, and a
    /// pattern list without causes silently downgrades every failure to
    /// "unknown" -- which reads as "never auto-resume" and would make the
    /// feature do nothing while looking wired up. They travel together.
    ///
    /// The ORDER matters too: every cause row must be reachable, and the
    /// auth rows must come before any row a Claude Code auth line would
    /// also match, or an expired token classifies as a network blip and
    /// gavin resumes into a login prompt.
    #[test]
    fn failure_causes_travel_with_patterns_and_put_auth_first() {
        let classifying: Vec<&str> = AGENT_PROFILES
            .iter()
            .filter(|p| !p.failure_causes.is_empty())
            .map(|p| p.id)
            .collect();
        assert_eq!(classifying, ["claude-code"]);

        for p in AGENT_PROFILES {
            assert_eq!(
                p.failure_causes.is_empty(),
                p.failure_patterns.is_empty(),
                "{} has one half of failure classification without the other",
                p.id
            );
            for row in p.failure_causes {
                assert!(!row.pattern.trim().is_empty(), "{} carries a blank cause pattern", p.id);
                assert!(
                    ["network", "outage", "usage-limit", "auth", "crashed"].contains(&row.cause),
                    "{} names a cause the app's trigger table does not know: {}",
                    p.id,
                    row.cause
                );
            }
        }

        // The real line, verbatim from the measurement session. First
        // match wins, so this is the whole guard against the ordering
        // regression.
        let line = "Please run /login \u{b7} API Error: 401 OAuth token has expired. Please run /login";
        let claude = profile_by_id("claude-code");
        let first = claude
            .failure_causes
            .iter()
            .find(|row| line.contains(row.pattern))
            .expect("claude-code classifies its own expired-token line");
        assert_eq!(first.cause, "auth");
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
        let with_mcp = instructions_block_for(Some(&codex), protocol::DEFAULT_PRD_PATH);
        let without = instructions_block_for(None, protocol::DEFAULT_PRD_PATH);
        assert!(with_mcp.contains("gavin_set_plan_field"));
        assert!(!without.contains("gavin_"), "custom has no MCP config yet: {without}");
        assert!(without.contains("`.gavin-root/plans/`"), "the rest of the guidance is the same");
    }

    #[test]
    fn claude_code_keeps_the_pointer_block_and_its_layout() {
        // resolve_mcp_binary_path needs the binary beside current_exe, which
        // is not true under cargo test -- so assert on what does not need it.
        let block = instructions_block_for(Some(&claude_layout()), protocol::DEFAULT_PRD_PATH);
        assert!(block.contains(".claude/skills/gavin/SKILL.md"));
        assert!(profile_by_id("claude-code").mcp.is_some());
        assert!(instructions_block_for(Some(&layout("codex")), protocol::DEFAULT_PRD_PATH) != block);
    }

    #[test]
    fn every_authored_document_names_the_configured_prd() {
        let dir = tempfile::tempdir().unwrap();
        let root = rooted_with_profile(dir.path(), "claude-code");
        std::fs::write(
            dir.path().join(".gavin-root/config.toml"),
            "prd = \"docs/PRD.md\"\n\n[agent]\nprofile = \"claude-code\"\n",
        )
        .unwrap();
        assert_eq!(prd_relative_path(dir.path()), "docs/PRD.md");

        // The instructions block an agent reads first.
        let block = instructions_block_for(Some(&claude_layout()), &prd_relative_path(dir.path()));
        assert!(block.contains("`docs/PRD.md`"), "{block}");
        assert!(!block.contains(".gavin-root/PRD.md"), "{block}");

        // The workflow skill, which repeats the path for the agent that
        // would rather read the file than call the tool.
        let paths =
            write_skills(dir.path(), &claude_layout(), &prd_relative_path(dir.path())).unwrap();
        let workflow = std::fs::read_to_string(&paths[0]).unwrap();
        assert!(workflow.contains("read `docs/PRD.md`"), "{workflow}");

        // And the flow document, whether it lands as a file or a prompt.
        let prompt = compose_agent_prompt(root, "prd".to_string()).unwrap();
        let skill =
            std::fs::read_to_string(dir.path().join(".claude/skills/gavin-write-prd/SKILL.md"))
                .unwrap();
        assert!(skill.contains("`docs/PRD.md`"), "{skill}");
        assert!(!skill.contains("{prd}"), "no placeholder survives into a written file: {skill}");
        assert!(!prompt.contains("{prd}"), "{prompt}");
    }

    #[test]
    fn compose_prompt_targets_the_configured_prd_when_the_document_is_inlined() {
        let dir = tempfile::tempdir().unwrap();
        let root = rooted_with_profile(dir.path(), "codex");
        std::fs::write(
            dir.path().join(".gavin-root/config.toml"),
            "prd = \"PRD.md\"\n\n[agent]\nprofile = \"codex\"\n",
        )
        .unwrap();

        // Codex has no skill slot, so the target and the document both
        // arrive in the prompt text -- the one place a stale path would
        // send the agent to write a second PRD beside the real one.
        let prompt = compose_agent_prompt(root, "prd".to_string()).unwrap();
        assert!(prompt.contains("Write PRD.md for this repo"), "{prompt}");
        assert!(!prompt.contains(".gavin-root/PRD.md"), "{prompt}");
        assert!(!prompt.contains("{prd}"), "{prompt}");
    }

    #[test]
    fn a_prd_key_pointing_outside_the_root_falls_back_to_the_default() {
        let dir = tempfile::tempdir().unwrap();
        rooted_with_profile(dir.path(), "claude-code");
        std::fs::write(
            dir.path().join(".gavin-root/config.toml"),
            "prd = \"../elsewhere/PRD.md\"\n\n[agent]\nprofile = \"claude-code\"\n",
        )
        .unwrap();
        // Same verdict the daemon reaches: both go through
        // protocol::usable_prd_path, so a hand-edited escape cannot make
        // the two disagree about which file is the PRD.
        assert_eq!(prd_relative_path(dir.path()), protocol::DEFAULT_PRD_PATH);
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
        let paths = write_skills(dir.path(), &claude_layout(), protocol::DEFAULT_PRD_PATH).unwrap();
        assert_eq!(paths.len(), 4, "workflow skill plus orchestrate, resume and develop");

        let workflow = std::fs::read_to_string(&paths[0]).unwrap();
        assert!(workflow.contains("gavin_create_plan"), "{workflow}");
        let orchestrate = std::fs::read_to_string(&paths[1]).unwrap();
        assert!(orchestrate.contains("gavin_get_orchestration"), "{orchestrate}");
        // Tool steps are half the step vocabulary; a skill that never
        // mentions them would have the agent rewrite them into broken
        // card steps on the first reorganize.
        assert!(orchestrate.contains("toolId"), "{orchestrate}");
        assert!(
            orchestrate.contains("When unsure, serialize"),
            "the parallelism rule must survive into the installed file"
        );
        let resume = std::fs::read_to_string(&paths[2]).unwrap();
        assert!(resume.contains("Finished work stays finished"), "{resume}");
        let develop = std::fs::read_to_string(&paths[3]).unwrap();
        // The approval gate IS the skill: an agent that writes before the
        // human answers has done the one thing this action must not do.
        assert!(develop.contains("Nothing is written before you hear yes"), "{develop}");
        // A card that gains nested children must become kind: plan, or
        // the board marks every child broken (planBoard.ts) and done/
        // leaves them behind (gavin.rs). Losing this line from the
        // installed file is how that bug reaches a user's workspace.
        assert!(develop.contains("kind: plan"), "{develop}");
        assert!(develop.contains("gavin_create_plan"), "{develop}");

        // Gavin-managed: a hand-edited skill is replaced, not merged.
        for p in &paths {
            std::fs::write(p, "mangled").unwrap();
        }
        write_skills(dir.path(), &claude_layout(), protocol::DEFAULT_PRD_PATH).unwrap();
        assert!(std::fs::read_to_string(&paths[0]).unwrap().contains("gavin_create_plan"));
        assert!(std::fs::read_to_string(&paths[1]).unwrap().contains("gavin_get_orchestration"));
        assert!(std::fs::read_to_string(&paths[2]).unwrap().contains("Finished work stays finished"));
        assert!(std::fs::read_to_string(&paths[3])
            .unwrap()
            .contains("Nothing is written before you hear yes"));
    }

    #[test]
    fn every_skill_lands_in_its_own_directory() {
        let dir = tempfile::tempdir().unwrap();
        let paths = write_skills(dir.path(), &claude_layout(), protocol::DEFAULT_PRD_PATH).unwrap();
        assert!(paths[0].ends_with(".claude/skills/gavin/SKILL.md"), "{:?}", paths[0]);
        assert!(paths[1].ends_with(".claude/skills/gavin-orchestrate/SKILL.md"), "{:?}", paths[1]);
        assert!(paths[2].ends_with(".claude/skills/gavin-resume/SKILL.md"), "{:?}", paths[2]);
        assert!(paths[3].ends_with(".claude/skills/gavin-develop/SKILL.md"), "{:?}", paths[3]);
    }
}
