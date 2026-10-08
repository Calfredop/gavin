use std::path::{Path, PathBuf};
use tauri::Manager as _;

/// One gavin-authored file dropped verbatim into a workspace --
/// a skill under the profile's skill root, or the agent definition a
/// headless run names. Overwritten wholesale on every setup run, like
/// the instructions block's marker section: gavin owns these outright,
/// so there is nothing in them to merge.
pub struct ManagedFile {
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
    /// for a local server, and an `env` block that re-forwards the
    /// `GAVIN_SESSION_*` values and `GAVIN_MCP` the daemon put on the
    /// PTY. Cursor's Agent CLI strips almost every inherited variable
    /// when it spawns an MCP server (PATH/cwd only), so without
    /// `${env:…}` interpolation `gavin_name_session` sees no tab id even
    /// though the agent itself has one, and the launcher never sees
    /// which gavin-mcp this build pinned. Its own variant rather than a
    /// key written unconditionally: Gemini's documented server fields do
    /// not include `type`, Claude inherits the full PTY env so it needs
    /// no passthrough, and gavin does not put keys it has not verified
    /// into someone else's config.
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
    /// JSON shape -- three of the six stock CLIs use it, so it is the
    /// best guess for a seventh.
    fn from_id(id: Option<&str>) -> McpFormat {
        McpFormat::ALL
            .iter()
            .copied()
            .find(|f| Some(f.id()) == id)
            .unwrap_or(McpFormat::JsonServers)
    }
}

/// Where a profile's agent reads MCP config, and what it installs beside
/// it. `skills` is empty only for unconfigured `custom` (gavin knows no
/// skill convention for an agent it has never heard of); those workspaces
/// carry the same guidance inline in the instructions block instead (see
/// instructions_block_for). Every stock profile gets the four gavin skills
/// under its own verified root.
pub struct McpLayout {
    pub config_file: &'static str,
    pub server_key: &'static str,
    pub format: McpFormat,
    pub skills: &'static [ManagedFile],
}

/// A layout with the path resolved: from the profile table for the six
/// stock profiles, from the workspace's own config for `custom`, whose
/// agent reads MCP config wherever its author decided. Owned rather than
/// borrowed for exactly that reason -- a configured path is a String, and
/// the table's fields are `&'static str`.
pub struct ResolvedMcp {
    config_file: String,
    server_key: &'static str,
    format: McpFormat,
    skills: &'static [ManagedFile],
}

impl ResolvedMcp {
    /// Where a step skill this profile does not already install would go:
    /// the parent every installed skill shares, and the filename they all
    /// use. Taken from the first entry because that is the shape an
    /// agent's own skill loader imposes -- one directory per skill under
    /// a single root, each holding the same filename -- so every entry
    /// answers identically. None when the profile installs no skills.
    fn skill_slot(&self) -> Option<(&'static Path, &'static str)> {
        let first = self.skills.first()?;
        Some((Path::new(first.dir).parent()?, first.file))
    }

    /// The path the instructions block points an agent at. The FIRST
    /// entry by the same convention skill_slot relies on: the table
    /// lists the always-on workflow skill first, and the block exists to
    /// name exactly that one. Read from the layout rather than written
    /// as a literal, because two profiles now install skills to two
    /// different roots -- a hardcoded `.claude/…` would send an opencode
    /// or Cursor workspace to a file gavin never wrote there.
    fn workflow_skill_path(&self) -> Option<String> {
        let first = self.skills.first()?;
        Some(format!("{}/{}", first.dir, first.file))
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
/// Where agent integration reads and writes: this machine's disk for a
/// local workspace, the host's -- through its daemon -- for an ssh one
/// (`docs/superpowers/specs/2026-09-22-ssh-card-runs-design.md`).
///
/// Everything below that produces a file goes through this and nothing
/// else, so the merge logic (foreign MCP servers, the `### Learned`
/// section, the `.replaced` backup) runs once, identically, for both.
/// Paths are absolute on the machine the implementation writes to; a
/// write creates the parents.
pub trait WorkspaceFiles {
    /// The file's bytes, or `None` when there is no such file.
    fn read_bytes(&self, path: &Path) -> anyhow::Result<Option<Vec<u8>>>;
    fn write_bytes(&self, path: &Path, contents: &[u8]) -> anyhow::Result<()>;
    fn is_dir(&self, path: &Path) -> bool;
    fn is_file(&self, path: &Path) -> bool;
    /// The directory's canonical path, for the one check that compares
    /// canonical paths (`validate_agent_file_path`). A remote
    /// implementation answers the path itself: the daemon on the host
    /// confines every write to the root, so the check is its.
    fn canonical_dir(&self, path: &Path) -> Option<PathBuf>;

    /// Whether the machine whose disk this is runs Windows. Asked by
    /// `launcher_file`, which has to name the file that would actually
    /// run -- and for an ssh workspace that machine is the host, not this
    /// desktop. Defaulted to this process's platform because that is the
    /// right answer for every local implementation, including the test
    /// doubles; a remote overrides it from the link's banner.
    fn is_windows(&self) -> bool {
        cfg!(windows)
    }

    /// The home directory of the account the agent CLIs run under, on the
    /// machine whose disk this is -- where an agent keeps state that
    /// belongs to the USER rather than to one workspace (kimi's folder
    /// trust). `None` is the default and means "not reachable": an ssh
    /// workspace's home is the host's, which nothing here can find, and a
    /// test double has no home worth writing to. Callers write there only
    /// on a `Some`, so an implementation that forgets to override this
    /// fails safe -- no write -- rather than putting a record on the
    /// wrong machine.
    fn agent_home(&self) -> Option<PathBuf> {
        None
    }

    /// An environment variable of the machine whose disk this is, for
    /// the one kind of question the CLIs answer that way: where their
    /// state lives (`KIMI_CODE_HOME`). Behind the trait for the reason
    /// `agent_home` is: an ssh host's environment is not this process's,
    /// and a test must not depend on the developer's.
    fn env_var(&self, _name: &str) -> Option<std::ffi::OsString> {
        None
    }

    /// `write_bytes` for a file in the user's own state (`agent_home`),
    /// which agent CLIs keep owner-only. Defaults to `write_bytes`;
    /// `LocalFiles` narrows the modes on unix.
    fn write_private(&self, path: &Path, contents: &[u8]) -> anyhow::Result<()> {
        self.write_bytes(path, contents)
    }

    fn read_to_string(&self, path: &Path) -> anyhow::Result<Option<String>> {
        match self.read_bytes(path)? {
            Some(bytes) => Ok(Some(String::from_utf8(bytes).map_err(|_| {
                anyhow::anyhow!("{} is not valid UTF-8 text", path.display())
            })?)),
            None => Ok(None),
        }
    }
}

/// This machine's disk: byte for byte what the integration always did.
pub struct LocalFiles;

impl WorkspaceFiles for LocalFiles {
    fn read_bytes(&self, path: &Path) -> anyhow::Result<Option<Vec<u8>>> {
        match std::fs::read(path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn write_bytes(&self, path: &Path, contents: &[u8]) -> anyhow::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        Ok(std::fs::write(path, contents)?)
    }

    fn is_dir(&self, path: &Path) -> bool {
        path.is_dir()
    }

    fn is_file(&self, path: &Path) -> bool {
        path.is_file()
    }

    fn canonical_dir(&self, path: &Path) -> Option<PathBuf> {
        std::fs::canonicalize(path).ok()
    }

    fn agent_home(&self) -> Option<PathBuf> {
        crate::home::home_dir()
    }

    fn env_var(&self, name: &str) -> Option<std::ffi::OsString> {
        std::env::var_os(name)
    }

    #[cfg(unix)]
    fn write_private(&self, path: &Path, contents: &[u8]) -> anyhow::Result<()> {
        use std::io::Write;
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
        if let Some(dir) = path.parent() {
            std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
        }
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        Ok(file.write_all(contents)?)
    }
}

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

/// A configured `[agent] file` must name a spot INSIDE the root, the same
/// promise `usable_mcp_path` makes for `mcp_file`. There is no fallback
/// destination for gavin's own marker block, though -- it is written for
/// EVERY profile, never skipped -- so a bad value is a loud error naming
/// the value, not a silent downgrade.
///
/// Canonicalizes the parent directory and checks containment rather than
/// components alone, the same way fileviewer's `resolve_new` does: a
/// symlinked directory leading out of the root is caught, not just a
/// literal `..`. Safe to canonicalize eagerly here -- unlike an MCP
/// config's directory, this write never creates the parent, so it must
/// already exist for a valid value.
fn validate_agent_file_path(fs: &dyn WorkspaceFiles, root: &Path, value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    let path = Path::new(trimmed);
    let outside = || format!("[agent] file {trimmed:?} would write outside the workspace root");
    if trimmed.is_empty() || path.is_absolute() {
        return Err(outside());
    }
    // Rejects `..` anywhere, and the Windows prefixes/root-dir components
    // an absolute check on a foreign separator would miss.
    if !path.components().all(|c| matches!(c, std::path::Component::Normal(_))) {
        return Err(outside());
    }
    let root_canonical = fs
        .canonical_dir(root)
        .ok_or_else(|| format!("workspace root {} is unreadable", root.display()))?;
    let parent = path.parent().filter(|p| !p.as_os_str().is_empty());
    let canonical_parent = match parent {
        Some(p) => fs.canonical_dir(&root_canonical.join(p)).ok_or_else(outside)?,
        None => root_canonical.clone(),
    };
    if canonical_parent == root_canonical || canonical_parent.starts_with(&root_canonical) {
        Ok(())
    } else {
        Err(outside())
    }
}

/// The layout to write for this root: the profile's own, or -- for
/// `custom`, which has none -- the one its config describes. None when
/// `custom` has not been pointed at a file yet, which is what leaves MCP
/// config named as skipped.
fn resolved_mcp(fs: &dyn WorkspaceFiles, root: &Path, profile: &AgentProfile) -> Option<ResolvedMcp> {
    if let Some(layout) = profile.mcp.as_ref() {
        return Some(layout.into());
    }
    let config_file = usable_mcp_path(&root_agent_key_in(fs, root, "mcp_file")?)?;
    Some(ResolvedMcp {
        config_file,
        server_key: "gavin",
        format: McpFormat::from_id(root_agent_key_in(fs, root, "mcp_format").as_deref()),
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
    /// The argv that carries a prompt into a LAUNCHED (visible) session,
    /// as a prefix concatenated with the shell-quoted prompt:
    ///
    /// - `Some("")` — a bare positional: `claude '<prompt>'`.
    /// - `Some("--prompt=")` — a flag whose value is ATTACHED:
    ///   `opencode --prompt='<prompt>'`. The attached form is not a
    ///   stylistic choice; see the opencode row for why the separated
    ///   one is broken.
    /// - `None` — this agent takes no prompt at all, so every
    ///   agent-driven flow is hidden rather than launched with garbage
    ///   in its argv (spec §7.2).
    ///
    /// A prefix rather than a bool because two shapes had to coexist and
    /// one concatenation expresses both: `<command> <prompt_args><quoted>`
    /// is the whole builder, for every row.
    pub prompt_args: Option<&'static str>,
    /// True when a visible run launches this agent BARE and its card
    /// prompt reaches it through the daemon's follow-up queue rather
    /// than argv (K3): the daemon holds the queued prompt until the
    /// agent's gavin-mcp presents its session token -- the "the TUI is
    /// up" signal such a CLI has -- then writes it into the PTY. Only
    /// meaningful with `prompt_args: None` (an agent that takes a prompt
    /// on its command line gets it there); kimi-code is the first row.
    pub prompt_injection: bool,
    /// True when this agent's OSC 133 markers are NOT to be believed --
    /// the app sends `Request::DistrustOsc133` for the session at spawn,
    /// and the daemon drops every 133 marker for it: the quiet-timer
    /// heuristic stays the authority and only a bare BEL raises
    /// waiting_for_input. kimi-code is the first row: it emits A at
    /// startup and per prompt submission amid redraw spam, wraps every
    /// tool result in B;C pairs, and its LAST marker is always C
    /// (Working) even sitting at its prompt -- so arming OSC-133-only
    /// detection on any marker strands the session in `working` forever
    /// (bug-kimi-launch-integrations, 2026-10-08, captured from a live
    /// TUI's PTY stream).
    pub untrusted_osc133: bool,
    /// The argv that makes this agent run ONE prompt with no TUI and
    /// then exit. Empty where the convention is unverified, which hides
    /// every background run -- a hidden session that never exits is a
    /// spinner with no end, so this is a harder requirement than
    /// `prompt_args` alone.
    ///
    /// Two verified shapes (mirrors `buildHeadlessCommand`):
    /// - ends in ` --`: positional prompt after a double-dash
    ///   (`<command> <headless_args> "<prompt>"`) -- claude, codex,
    ///   cursor, opencode. The separator keeps a prompt that starts
    ///   with `-` from being read as a flag, and stops a variadic
    ///   allow-list flag from swallowing the prompt.
    /// - ends in `=`: flag-attached prompt with no space
    ///   (`<command> <headless_args>"<prompt>"`) -- gemini's
    ///   `--prompt=`, because a bare positional stays interactive.
    ///
    /// The tool allow-list / auto-approve flags are part of it: a
    /// headless agent cannot be asked to approve anything, so a run
    /// with no grant is a run that can only report it was refused.
    pub headless_args: &'static str,
    /// The flag that selects a model, e.g. `--model`. Empty where the
    /// command takes none -- `custom` is the user's own argv. An empty
    /// flag hides every model control for the profile rather than
    /// guessing one, which is the same posture `headless_args` takes
    /// above.
    pub model_flag: &'static str,
    /// Model names offered as picks, and only ever the ones the CLI
    /// itself documents as STABLE aliases -- a name that points at
    /// "the latest model of this tier" and so never goes stale. A dated
    /// id does not belong here: it rots, and a wrong name lands in
    /// somebody's argv.
    ///
    /// Re-checked against each CLI 2026-09-07, by running it rather than
    /// by reading about it:
    ///
    /// - claude-code -- `claude --model` takes `fable`, `opus`,
    ///   `sonnet` and `haiku` (one per tier), `opusplan` (opus while
    ///   planning, sonnet while executing), `best` (the latest Fable
    ///   where the account has one, else opus) and the `[1m]` variants
    ///   that open the 1M-token context window. All eight were run
    ///   through `claude --model <x> -p` and answered. `default` is
    ///   deliberately absent: it means "no override", which is what
    ///   gavin's own empty row already says.
    /// - gemini -- `auto`, `pro`, `flash` and `flash-lite`, the four
    ///   `GEMINI_MODEL_ALIAS_*` constants its own `resolveModel` switches
    ///   on before falling through to a concrete name.
    /// - codex, opencode and kimi-code -- no stable alias exists. All
    ///   three ship empty here and are enumerated at runtime instead; see
    ///   `model_catalog` below.
    /// - cursor -- Cursor Agent CLI (`agent`): `--model` takes dated ids
    ///   from `agent --list-models`, enumerated at runtime like
    ///   opencode rather than shipped as presets here.
    pub models: &'static [&'static str],
    /// How this agent's CURRENT model list is read back at runtime, for
    /// the CLIs whose names are dated ids rather than aliases.
    ///
    /// `models` above is a constant compiled into gavin: correct for an
    /// agent that promises "sonnet is always the latest sonnet", useless
    /// for one whose picker is `gpt-5.2` today and something else next
    /// month. Those agents keep their own catalogue, and gavin reads it
    /// once per app START (`agent_models::agent_model_catalog`) rather
    /// than shipping a copy that is stale the day it lands.
    ///
    /// `None` is the honest default and says gavin has no route: three
    /// of the six rows have none, and for them the picker is `models`
    /// plus "Custom…", exactly as before.
    pub model_catalog: Option<ModelCatalog>,
    /// How a chosen effort level reaches this agent's launch command,
    /// composed by `composeEffort` in agentModel.ts. Three shapes, told
    /// apart the way `headless_args` tells its two apart:
    ///
    /// - a flag ending in `=` is concatenated with the level
    ///   (`-c model_reasoning_effort=high`);
    /// - anything else takes the level as the next argument
    ///   (`--effort high`);
    /// - an ENV-ASSIGNMENT shape -- `/^[A-Z][A-Z0-9_]*=$/`, e.g.
    ///   `KIMI_MODEL_THINKING_EFFORT=` -- is PREPENDED before the whole
    ///   command (`KIMI_MODEL_THINKING_EFFORT=low kimi ...`), for an
    ///   agent whose effort is an environment variable rather than an
    ///   argv flag. Gavin composes every launch through `sh -c`, so the
    ///   prefix composes like a flag.
    ///
    /// Empty where the launched TUI has no such knob, which hides every
    /// effort control for the profile -- the posture `model_flag` takes.
    /// Checked 2026-09-30, kimi-code added 2026-10-05:
    ///
    /// - gemini -- no flag; the thinking budget lives in settings.json.
    /// - cursor -- effort is a bracket parameter OF the model id
    ///   (`claude-opus-4-8[effort=high]`, `agent --help`), so the model's
    ///   own Custom… box is already the route and a second flag would
    ///   be a second, conflicting spelling of it.
    /// - opencode -- `--variant` is the provider's reasoning effort, but
    ///   only `opencode run` takes it; the interactive TUI gavin launches
    ///   rejects it (1.18.25, `opencode --help`).
    /// - kimi-code -- no effort flag exists (docs-verified); the knob is
    ///   the `KIMI_MODEL_THINKING_EFFORT` env var, verified at the wire
    ///   through a local proxy: the request body carried
    ///   `thinking.effort="low"` with it set (2.1.1, 2026-10-05).
    pub effort_flag: &'static str,
    /// The effort levels the CLI itself documents, lowest first. Offered
    /// as picks beside "Custom…", which stays for a level a newer CLI
    /// adds before this list does. Empty wherever `effort_flag` is.
    pub efforts: &'static [&'static str],
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
    /// shares is `API Error:` -- until real transcripts turned up five
    /// lines that do not carry it (a session limit, a login that
    /// expired, ...), each of which the profile's row now names.
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
    /// A shell one-liner the naming skill runs (v38) to find THIS agent's
    /// own newest conversation id, for a CLI that mints its own instead
    /// of taking one from the caller -- codex/gemini/opencode, unlike
    /// Claude Code, which `session_id_args` already covers. The agent
    /// runs it itself and self-reports the result over
    /// `gavin_name_session`'s `agent_conversation_id` argument
    /// (`agent-session-id-self-report.md`), which the daemon stores in
    /// `card_sessions.conversation_id` exactly where a minted id lives.
    ///
    /// Empty where unverified or not applicable, the same posture
    /// `headless_args` takes: a wrong discovery command reports the
    /// wrong id, or none, which is worse than admitting gavin has none to
    /// offer.
    pub session_id_discovery: &'static str,
    /// The argv that reopens that conversation: `<command> <resume_args>
    /// <uuid>`, run in the directory the run was LAUNCHED in.
    ///
    /// Empty unless EITHER `session_id_args` (a minted id) OR
    /// `session_id_discovery` (a self-reported one) is set -- see the
    /// guard test: a profile may resume by an id gavin fixed at launch,
    /// by one the agent handed back, or not at all, but never claims
    /// resume with no way to ever learn an id. Resuming by anything else
    /// is how you get a silent fresh conversation wearing a better name.
    ///
    /// A profile with none keeps today's behaviour and falls back to
    /// `composeResumeTaskPrompt` -- a written reconstruction instead of
    /// the conversation itself.
    pub resume_args: &'static str,
    /// How gavin reads this agent's SUBSCRIPTION limits -- the windows
    /// the account is spending against, not the tokens one conversation
    /// happened to burn.
    ///
    /// `None` is the honest default: a profile gavin cannot ask, and the
    /// usage panel says so in those words rather than showing a bar it
    /// invented. The same posture as `failure_patterns` -- an empty row
    /// means "gavin cannot see this", never "there is no limit".
    ///
    /// What was checked, 2026-09-11:
    ///
    /// - `claude-code` -- Anthropic OAuth usage endpoint.
    /// - `codex` -- newest rollout `token_count` with rate_limits.
    /// - `cursor` -- `GET https://cursor.com/api/usage-summary` with the
    ///   CLI's session JWT (Keychain `cursor-access-token`, else the
    ///   Cursor app's `state.vscdb`). Live Pro body verified: Auto / API
    ///   / Total percents plus a billing-cycle reset.
    /// - `gemini` -- Cloud Code Assist `retrieveUserQuota`. Consumer
    ///   Google accounts return 403 `SUBSCRIPTION_REQUIRED` after the
    ///   2026-06-18 OAuth shutdown; Workspace / Code Assist still
    ///   answer. `/stats` still prints nothing when piped.
    /// - `opencode` -- `GET https://opencode.ai/zen/go/v1/usage` with the
    ///   `opencode-go` key from `auth.json`. BYO provider keys (and Zen
    ///   without Go) have no account-wide limit; the probe then reports
    ///   Unavailable rather than inventing a bar.
    /// - `kimi-code` -- `GET <managed base>/usages` with the OAuth token
    ///   from `~/.kimi-code/credentials/kimi-code-env-*.json`; verified
    ///   200 on both kimi.com and kimi.ai hosts (2026-10-05, kimi 2.1.1).
    /// - `custom` -- no route.
    pub usage_probe: Option<UsageProbe>,
    /// Where this agent writes the per-CONVERSATION transcript gavin
    /// reads token totals out of -- the sibling `usage_probe` explicitly
    /// is not: that one reports the account's windows, this one reports
    /// what one run of one card actually burned.
    ///
    /// Keyed on the conversation id gavin already mints at launch and
    /// records on the run, so nothing has to be matched by cwd or by
    /// time. `None` means gavin cannot cost this profile's runs and the
    /// panel says exactly that.
    ///
    /// What was checked, 2026-09-03:
    ///
    /// - `gemini` -- `~/.gemini/tmp/*/chats/session-*.json` does carry
    ///   per-session token totals (see `usage_probe` above, where the
    ///   same file was rejected for being a burn estimate rather than a
    ///   quota -- a burn estimate is precisely what this field wants).
    ///   No row anyway: nothing here could verify the file's shape or
    ///   that its name carries gavin's conversation id, and a parser
    ///   copied from a description is how a panel starts inventing
    ///   numbers.
    /// - `cursor`, `opencode` -- no per-conversation transcript on disk
    ///   that gavin mints the id for. No row.
    /// - `kimi-code` -- `~/.kimi-code/sessions/.../wire.jsonl`, resolved
    ///   through `~/.kimi-code/session_index.jsonl` (verified 2026-10-05,
    ///   kimi 2.1.1; see `TokenLog::KimiWireJsonl`). The id is the
    ///   self-reported one `session_id_discovery` learns, exactly where
    ///   opencode's resumes get theirs.
    pub token_log: Option<TokenLog>,
    /// The per-folder trust record this agent's CLI wants before it will
    /// load a repository's own MCP servers, or `None` where it has no
    /// such gate (every row but kimi-code). Integration writes it, and
    /// reports it -- the one place gavin writes outside the workspace.
    pub folder_trust: Option<FolderTrust>,
    /// A gavin-owned agent DEFINITION this profile's headless run names
    /// by `--agent`, when its CLI grants tool permissions through a file
    /// rather than a flag. Written and removed exactly like a skill --
    /// gavin owns the whole file -- and deliberately not merged into the
    /// user's own agent config: that would silently re-scope the
    /// interactive sessions they drive themselves, and gavin writes
    /// nothing into someone else's config beyond the MCP entry (and, for
    /// kimi, the per-folder trust record -- `folder_trust` -- which is
    /// state, not config).
    ///
    /// None where the grant rides the argv instead, which is every other
    /// row that runs headless.
    pub agent_file: Option<ManagedFile>,
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
    /// Cursor Agent / dashboard. `GET https://cursor.com/api/usage-summary`
    /// with cookie `WorkosCursorSessionToken=<jwt.sub>%3A%3A<jwt>`.
    ///
    /// The JWT is the same session the CLI stores after `agent login`
    /// (Keychain `cursor-access-token` on macOS; `state.vscdb`
    /// `cursorAuth/accessToken` everywhere the IDE has run). Chosen over
    /// the Admin API, which needs a team key a personal account does not
    /// have, and over `/usage` in the TUI, which is Ink and prints
    /// nothing when piped -- the same reason Gemini's `/stats` is not a
    /// route. The dashboard endpoint is account truth, including other
    /// machines, which is the whole reason it is worth a credential.
    CursorSession,
    /// Gemini CLI. `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota`
    /// with the CLI's OAuth access token from `~/.gemini/oauth_creds.json`,
    /// refreshed through Google's token endpoint with Gemini CLI's public
    /// installed-app client when `expiry_date` has passed.
    ///
    /// Chosen over piping `/stats` (Ink, empty) and over summing
    /// `~/.gemini/tmp/*/chats/session-*.json` (a burn estimate, not a
    /// quota). Buckets are remainingFraction per model; gavin collapses
    /// them to Pro / Flash / Lite at the worst remaining in each tier.
    /// Consumer accounts after 2026-06-18 answer 403; that is Unavailable,
    /// not a zero bar.
    GeminiCodeAssist,
    /// OpenCode Go. `GET https://opencode.ai/zen/go/v1/usage` with the
    /// `opencode-go` API key from `~/.local/share/opencode/auth.json`.
    /// Returns rolling / weekly / monthly percents with `resetsAt`.
    ///
    /// Zen-only and BYO-provider logins have no such endpoint (Zen
    /// balance is console-cookie scraping, which this will not do). The
    /// probe then reports Unavailable naming Go, rather than Unsupported
    /// -- the route exists, this account is not on it.
    OpencodeGo,
    /// Kimi Code. `GET <managed base>/usages` with
    /// `Authorization: Bearer <access_token>` from
    /// `~/.kimi-code/credentials/kimi-code-env-*.json` (the same
    /// AnthropicOauth-shaped credential file Claude Code's probe reads).
    /// Verified live 2026-10-05 against kimi 2.1.1: HTTP 200 on BOTH
    /// `api.kimi.ai/coding/v1` and `api.kimi.com/coding/v1`, and the body
    /// is snake_case:
    /// `{limits: [{window, detail: {limit, remaining, resetTime}}],
    ///   usages: {limit_5h: {used_ratio, reset_time}, limit_month_total,
    ///   limit_month_code}}`.
    ///
    /// Chosen over the console API key (`sk-kimi-xxx`) third-party
    /// trackers use: gavin will not ask users to mint console keys when
    /// the membership OAuth credential the CLI already holds answers the
    /// same endpoint.
    KimiOauth,
}

impl UsageProbe {
    /// The wire name the frontend keys on. Stable strings, like
    /// `McpFormat::id`: they reach `agentUsage.ts` and a rename here
    /// without one there silently turns every probe into "unsupported".
    pub fn id(self) -> &'static str {
        match self {
            UsageProbe::AnthropicOauth => "anthropic-oauth",
            UsageProbe::CodexRollout => "codex-rollout",
            UsageProbe::CursorSession => "cursor-session",
            UsageProbe::GeminiCodeAssist => "gemini-code-assist",
            UsageProbe::OpencodeGo => "opencode-go",
            UsageProbe::KimiOauth => "kimi-oauth",
        }
    }
}

/// Where a profile's per-conversation token totals are read from. Like
/// `UsageProbe`, one variant per VERIFIED shape rather than a generic
/// "parse a log": the two differ in file layout, in what a record means
/// and in how a total is arrived at.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TokenLog {
    /// Claude Code. `~/.claude/projects/<slugged cwd>/<session id>.jsonl`,
    /// one JSON record per line, where a record of type `assistant`
    /// carries `message.usage` with `input_tokens`,
    /// `cache_creation_input_tokens`, `cache_read_input_tokens` and
    /// `output_tokens`.
    ///
    /// Found by GLOBBING the project directories for `<id>.jsonl` rather
    /// than by slugging a cwd: the file is named for the session, the
    /// slug rule is Claude Code's and undocumented, and the launch cwd on
    /// the run is where gavin STARTED the agent -- which is not
    /// necessarily the directory the transcript was filed under.
    ///
    /// The totals are summed per DISTINCT `message.id`, not per record:
    /// one assistant message is written once per content block and every
    /// copy repeats the same `usage`, so a naive sum over lines reports
    /// roughly three times the real cost (measured, 2026-09-03: 39
    /// records for 15 messages).
    ClaudeSessionJsonl,
    /// Codex CLI. The same rollout files under `~/.codex/sessions` that
    /// `UsageProbe::CodexRollout` reads, and the same `token_count`
    /// event -- a different field on it. `info.total_token_usage` is
    /// CUMULATIVE for the conversation, so the answer is the LAST such
    /// event rather than a sum, and a sum would multiply the transcript
    /// by its own length.
    CodexRollout,
    /// Kimi Code. Per-session
    /// `~/.kimi-code/sessions/<wd_key>/<session_id>/agents/<agent_id>/wire.jsonl`,
    /// verified live 2026-10-05 against kimi 2.1.1: its `usage.record`
    /// events carry `{usage: {inputOther, output, inputCacheRead,
    /// inputCacheCreation}, usageScope: "turn"}` and its
    /// `token_counting.turn_recorded`/`measured` events carry
    /// context-length tokens. `wd_key` is `wd_<slug>_<sha256(cwd)[:12]>`.
    ///
    /// Resolved through `~/.kimi-code/session_index.jsonl`, which maps
    /// sessionId to its sessionDir -- not by path derivation: kimi's
    /// `transcript_path` analogue has no cwd to slug from, and the
    /// index's `workDir` is the PHYSICAL path (`/private/tmp/...`), the
    /// same `pwd -P` caveat opencode's discovery carries.
    KimiWireJsonl,
}

/// How an agent CLI gates the PROJECT-level MCP servers a repository
/// ships behind a per-folder "do you trust this?" record, and so how
/// gavin's own `.mcp.json` entry reaches it. One variant per VERIFIED
/// store, like `UsageProbe` and `TokenLog`.
///
/// Written only when a human runs Integration for the workspace, and
/// only when that run actually wrote gavin's MCP entry -- see
/// `grant_folder_trust`, which is where the consent rules live.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FolderTrust {
    /// Kimi Code. An untrusted folder makes the interactive TUI stop at a
    /// "Trust this folder?" screen (declining exits kimi) and makes a
    /// headless `-p` run skip every project MCP server with `Warning:
    /// this folder is not trusted; skipped N project-level MCP server`.
    /// The record is `<kimi home>/workspace-trust/<wd_key>` holding
    /// `{"root": <physical path>, "trustedAt": <ms>}`, with
    /// `wd_key = wd_<slug>_<sha256(root)[:12]>` (`kimi_workdir_key`).
    ///
    /// Read out of the kimi 2.1.1 binary (`workdir-slug.ts`,
    /// `trustRecord.ts`) and then proven against it in a scratch
    /// `KIMI_CODE_HOME` (2026-10-06): a record written this way lifts the
    /// warning, and a trusted PARENT does not cover a subdirectory -- a
    /// worktree is its own workspace and needs its own record.
    KimiRecord,
}

/// Where a profile's model list is read from at runtime. One variant per
/// VERIFIED route, the same posture `UsageProbe` and `TokenLog` take: the
/// two differ in whether a file or a process answers, in what a record
/// means, and in what "available to this user" turns out to mean.
///
/// Both are read best-effort and merged BEHIND `models` rather than
/// replacing it (`mergeDiscoveredModels` in agentModel.ts). A route that
/// answers nothing -- the agent is not installed, the file was never
/// written, the shape changed -- leaves exactly today's picker rather
/// than an empty one.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ModelCatalog {
    /// Codex CLI. `~/.codex/models_cache.json`, the snapshot codex writes
    /// after asking its own `/models` endpoint: a `models` array of
    /// objects carrying `slug` (the name `--model` takes) and
    /// `visibility` (`list` for the ones its own picker shows, `hide`
    /// and `none` for internal rows like `codex-auto-review`).
    ///
    /// The FILE rather than `codex debug models`, which prints the same
    /// catalogue: reading costs no process, no network and no auth, and
    /// a `debug` subcommand is by name not a promise. The cost is that a
    /// machine where codex has never run has no file -- which reads as
    /// "no route", the same as codex not being installed at all.
    CodexCache,
    /// opencode. `opencode models` prints one `provider/model` per line,
    /// and there is nothing to read instead: `~/.cache/opencode/models.json`
    /// is the whole models.dev registry (every provider that exists),
    /// while the command answers the narrower and only useful question --
    /// which models THIS machine's configured providers actually offer.
    /// 454 rows here against a registry of thousands.
    ///
    /// This is also why opencode has no static list: `--model sonnet`
    /// dies with `ProviderModelNotFoundError { providerID: "sonnet",
    /// modelID: "" }`, so a name gavin could hard-code does not exist.
    OpencodeCli,
    /// Kimi Code. `kimi provider list --json` prints
    /// `{providers: {...}, models: {"kimi-code/kimi-for-coding":
    /// {provider, model, displayName, supportEfforts, defaultEffort,
    /// ...}, ...}, defaultModel: "..."}` -- verified against kimi 2.1.1
    /// (2026-10-05). The `models` map's KEYS are the aliases `-m` takes.
    ///
    /// The command rather than a static list for opencode's reason: the
    /// aliases are managed and refresh upstream, so a name gavin pinned
    /// here would be stale the day it lands.
    KimiCli,
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
        models: &[
            "fable",
            "opus",
            "sonnet",
            "haiku",
            "opusplan",
            "best",
            "sonnet[1m]",
            "opus[1m]",
        ],
        // No route: `claude` has no models subcommand, and it does not
        // need one -- the aliases above are the whole picker and each
        // already means "the latest of this tier".
        model_catalog: None,
        // `claude --help` (2.1.285, 2026-09-30): "--effort <level>
        // Effort level for the current session (low, medium, high,
        // xhigh, max)". A model that does not support a level falls back
        // to its own highest, so the list is the CLI's, not the model's.
        effort_flag: "--effort",
        efforts: &["low", "medium", "high", "xhigh", "max"],
        label: "Claude Code",
        instructions_file: "CLAUDE.md",
        command: "claude",
        // `claude "<prompt>"`: the bare positional starts the session.
        prompt_args: Some(""),
        prompt_injection: false,
        untrusted_osc133: false,
        // `claude -p`: print/non-interactive mode (code.claude.com/docs/en/headless,
        // re-checked 2026-09-11). `--allowedTools "Bash(git *)"` auto-
        // approves git for commit-via-agent without opening the whole
        // shell; trailing `--` so a prompt starting with `-` is not eaten.
        headless_args: "-p --allowedTools \"Bash(git *)\" --",
        // Measured under a PTY against a fake API (2026-09-02, Claude
        // Code v2.1.258): a connection reset, a stream killed mid-flight,
        // a 429 usage limit and a 401 expired token all end with a line
        // beginning "API Error:" and the process still alive at its
        // prompt. During the retries the session is NOT quiet -- the
        // countdown repaints once a second -- which is why the daemon
        // only reads this at the moment a quiet session would go idle.
        //
        // The fake-API session only saw failures that print "API Error:".
        // The real ones do not all: this repo's own transcripts (2026-09,
        // entries flagged `isApiErrorMessage`) hold five lines Claude
        // Code prints WITHOUT it, and a turn that ends on one read as a
        // finished turn, so a rail's agent step completed on it. Each is
        // matched by the most distinctive fragment of its line, because
        // every entry is tried against the WHOLE rendered screen -- and
        // two obvious fragments are not safe. `limit · resets` and
        // `/usage-credits` also end Claude Code's near-limit WARNING
        // ("You've used 90% of your session limit · resets ... ·
        // Run /usage-credits to ...", read off the v2.1.278 binary's
        // message templates), which paints on healthy sessions. A wrapped
        // row can still hide the tail of a long line; that costs a
        // missed detection, which is what happened before these entries.
        //
        //   "You've hit your session limit · resets 6:50pm (Europe/Rome)"
        //   "You've reached your Fable 5 limit. Run /usage-credits to
        //    continue or switch models with /model."
        //   "Login expired · Please run /login"
        //   "Your organization has disabled Claude subscription access for
        //    Claude Code · Use an Anthropic API key instead, ..."
        //   "Request timed out"
        //
        // `Request timed out` is the whole line, so it has no longer
        // fragment to prefer: a test log or an agent's own summary that
        // says it on screen at the quiet->idle moment reads as a failure.
        failure_patterns: &[
            "API Error:",
            "hit your session limit",
            "/usage-credits to continue or switch",
            "Please run /login",
            "disabled Claude subscription access",
            "Request timed out",
        ],
        // Two provenances, both real Claude Code output and neither
        // invented. Ten rows are the fake-API session's (the two auth
        // rows `/login` and `OAuth token has expired`, the two `usage
        // limit` rows, the two `Overloaded` rows and four network
        // ones): every string appeared verbatim on a live screen. The
        // other nine come from the transcripts above -- the exact
        // `text` of each error message (2026-09), not a painted screen.
        // A guessed row is worse than a missing one, so a line nobody
        // has seen gets none.
        //
        // ORDER decides, first match wins. Auth is FIRST because its line
        // carries "API Error:" as well, and a token that needs a login
        // back must never read as a network blip worth retrying. The
        // `temporarily limiting requests` row is server-side throttling
        // -- its line reads "(not your usage limit) · You have
        // exceeded your usage limit" -- so it must come BEFORE both
        // usage-limit rows or it classifies as an exhausted budget, a
        // wait for a reset that never comes.
        //
        // `Your computer went to sleep mid-response` has NO row, on
        // purpose: the daemon's own slept-mid-turn verdict owns suspend,
        // and a row here would race it. Nor is there a bare
        // `mid-response` row, which would swallow that line.
        failure_causes: &[
            FailureCausePattern { pattern: "/login", cause: "auth" },
            FailureCausePattern { pattern: "OAuth token has expired", cause: "auth" },
            FailureCausePattern { pattern: "disabled Claude subscription access", cause: "auth" },
            FailureCausePattern { pattern: "temporarily limiting requests", cause: "outage" },
            FailureCausePattern { pattern: "exceeded your usage limit", cause: "usage-limit" },
            FailureCausePattern { pattern: "usage limit", cause: "usage-limit" },
            FailureCausePattern { pattern: "hit your session limit", cause: "usage-limit" },
            FailureCausePattern {
                pattern: "/usage-credits to continue or switch",
                cause: "usage-limit",
            },
            FailureCausePattern { pattern: "529 Overloaded", cause: "outage" },
            FailureCausePattern { pattern: "Overloaded", cause: "outage" },
            FailureCausePattern { pattern: "Server error mid-response", cause: "outage" },
            FailureCausePattern { pattern: "Connection dropped", cause: "network" },
            FailureCausePattern { pattern: "ECONNRESET", cause: "network" },
            FailureCausePattern { pattern: "empty or malformed response", cause: "network" },
            FailureCausePattern { pattern: "Connection error", cause: "network" },
            FailureCausePattern { pattern: "Connection closed mid-response", cause: "network" },
            FailureCausePattern { pattern: "Connection lost mid-response", cause: "network" },
            FailureCausePattern { pattern: "The response stopped arriving", cause: "network" },
            FailureCausePattern { pattern: "Request timed out", cause: "network" },
        ],
        // `claude --session-id <uuid>` (a real UUID; the CLI validates
        // it) and `claude --resume <uuid>`. Verified end to end: the
        // transcript is written to `<uuid>.jsonl`, resume comes back
        // carrying the conversation, and it APPENDS to that same file
        // rather than rotating it -- which is why gavin reuses the id
        // instead of `--fork-session`. The failed attempt stays readable
        // either way, so the one argument for forking does not apply.
        session_id_args: "--session-id",
        // Not needed: gavin already mints this profile's id at launch.
        session_id_discovery: "",
        resume_args: "--resume",
        usage_probe: Some(UsageProbe::AnthropicOauth),
        token_log: Some(TokenLog::ClaudeSessionJsonl),
        folder_trust: None,
        // The allow-list rides claude's own argv, so there is no file.
        agent_file: None,
        mcp: Some(McpLayout {
            config_file: ".mcp.json",
            server_key: "gavin",
            format: McpFormat::JsonServers,
            skills: &[
                ManagedFile {
                    dir: ".claude/skills/gavin",
                    file: "SKILL.md",
                    contents: include_str!("gavin_skill.md"),
                },
                // Its own skill, not a section of the workflow one: this
                // loads only when orchestration comes up, so the
                // always-on skill stays short.
                ManagedFile {
                    dir: ".claude/skills/gavin-orchestrate",
                    file: "SKILL.md",
                    contents: include_str!("gavin_orchestrate_skill.md"),
                },
                // Loaded by the In Progress column's Resume: the card
                // it names was worked on before, and picking that up is
                // a different job from starting it.
                ManagedFile {
                    dir: ".claude/skills/gavin-resume",
                    file: "SKILL.md",
                    contents: include_str!("gavin_resume_skill.md"),
                },
                // The To Do counterpart, loaded by a card's "Develop
                // into a plan": the card is one line of intent, and
                // turning it into steps is an interview, not a build.
                ManagedFile {
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
        model_catalog: Some(ModelCatalog::CodexCache),
        // No dedicated flag: effort is the `model_reasoning_effort`
        // config key, which `-c key=value` overrides for one run (its
        // value parsed as TOML, a bare word kept as a string). ATTACHED,
        // hence the trailing `=`. Levels from the Codex config
        // reference's `model_reasoning_effort` enum, 2026-09-30; no local
        // `codex` binary was available to run.
        effort_flag: "-c model_reasoning_effort=",
        efforts: &["minimal", "low", "medium", "high", "xhigh"],
        label: "Codex CLI",
        instructions_file: "AGENTS.md",
        command: "codex",
        // `codex "<prompt>"`: the TUI's clap parser takes an optional
        // positional PROMPT that starts the session.
        // Verified against developers.openai.com/codex/cli/reference
        // (2026-09-11).
        prompt_args: Some(""),
        prompt_injection: false,
        untrusted_osc133: false,
        // `codex exec` is the non-interactive subcommand. Default sandbox
        // is read-only, so a commit run needs `workspace-write`;
        // `--ask-for-approval never` stops a hidden session stalling on
        // a prompt nobody can answer. Trailing `--` so a prompt starting
        // with `-` is not read as a flag. Docs 2026-09-11; no local
        // binary available to re-check --help against.
        headless_args: "exec --sandbox workspace-write --ask-for-approval never --",
        failure_patterns: &[],
        failure_causes: &[],
        session_id_args: "",
        // Unverified: no `codex` binary was available to check
        // `codex resume <id>` or the newest-rollout-file discovery
        // against (2026-09-10). Left empty rather than guessed, the
        // same posture every other unverified row in this file takes.
        session_id_discovery: "",
        resume_args: "",
        usage_probe: Some(UsageProbe::CodexRollout),
        token_log: Some(TokenLog::CodexRollout),
        folder_trust: None,
        agent_file: None,
        mcp: Some(McpLayout {
            config_file: ".codex/config.toml",
            server_key: "gavin",
            format: McpFormat::TomlServers,
            // Verified 2026-09-11 against developers.openai.com/codex/skills:
            // Codex scans `.agents/skills/<name>/SKILL.md` from CWD up to
            // the repo root (user scope is `~/.agents/skills/`). That is
            // the documented REPO path — not `.codex/skills/`, which some
            // third-party writeups still name. Same Agent Skills
            // frontmatter as the other skill-capable rows.
            skills: &[
                ManagedFile {
                    dir: ".agents/skills/gavin",
                    file: "SKILL.md",
                    contents: include_str!("gavin_skill.md"),
                },
                ManagedFile {
                    dir: ".agents/skills/gavin-orchestrate",
                    file: "SKILL.md",
                    contents: include_str!("gavin_orchestrate_skill.md"),
                },
                ManagedFile {
                    dir: ".agents/skills/gavin-resume",
                    file: "SKILL.md",
                    contents: include_str!("gavin_resume_skill.md"),
                },
                ManagedFile {
                    dir: ".agents/skills/gavin-develop",
                    file: "SKILL.md",
                    contents: include_str!("gavin_develop_skill.md"),
                },
            ],
        }),
    },
    AgentProfile {
        id: "gemini",
        model_flag: "--model",
        // Aliases, not the `gemini-3-pro-preview`-shaped ids the docs
        // also list: `resolveModel` maps these four onto whatever the
        // installed CLI considers current, and the account's preview
        // access decides the rest. A dated id pinned here would outlive
        // the model it names.
        models: &["auto", "pro", "flash", "flash-lite"],
        // No route: `gemini` has no models subcommand, and the Google
        // endpoint that does list them wants an API key a CLI signed in
        // with a Google account does not have.
        model_catalog: None,
        effort_flag: "",
        efforts: &[],
        label: "Gemini CLI",
        instructions_file: "GEMINI.md",
        command: "gemini",
        // `gemini [query..]`: the positional is the initial prompt and
        // stays interactive, which is what a launched session wants.
        // (-p / --prompt would run it headless and exit.)
        // Verified against `gemini --help` 2026-09-11 and
        // geminicli.com/docs/cli/headless.
        prompt_args: Some(""),
        prompt_injection: false,
        untrusted_osc133: false,
        // Headless is `--prompt=<value>`, not a bare positional: a
        // positional without `-p` stays interactive. `--yolo` auto-
        // accepts tool calls so a hidden commit does not stall.
        // Attach-form (`=`) so buildHeadlessCommand concatenates the
        // quoted prompt with no space. Verified 2026-09-11 against
        // local `gemini --help`.
        headless_args: "--yolo --prompt=",
        failure_patterns: &[],
        failure_causes: &[],
        session_id_args: "",
        // Verified INCOMPATIBLE, not merely unverified (0.35.3,
        // 2026-09-10): `gemini --help` really does carry `-r, --resume`,
        // but its value is "latest" or a session INDEX ("--resume 5"),
        // never an arbitrary id -- so the self-reported opaque id this
        // table's `<command> <resume_args> <uuid>` shape always appends
        // would be garbage in gemini's argv. There is nothing to
        // discover that this mechanism could use, so both this field
        // and `resume_args` stay empty on purpose rather than wire up a
        // flag that resumes the wrong session (or none).
        session_id_discovery: "",
        resume_args: "",
        usage_probe: Some(UsageProbe::GeminiCodeAssist),
        token_log: None,
        folder_trust: None,
        agent_file: None,
        mcp: Some(McpLayout {
            config_file: ".gemini/settings.json",
            server_key: "gavin",
            format: McpFormat::JsonServers,
            // Verified 2026-09-11 against gemini-cli docs/cli/skills.md and
            // local `gemini skills` (0.35.3): workspace skills live under
            // `.gemini/skills/<name>/SKILL.md` (`.agents/skills/` is an
            // alias that would also be discovered by Codex, so install
            // under Gemini's own root). Same four skills / frontmatter as
            // the other skill-capable rows.
            skills: &[
                ManagedFile {
                    dir: ".gemini/skills/gavin",
                    file: "SKILL.md",
                    contents: include_str!("gavin_skill.md"),
                },
                ManagedFile {
                    dir: ".gemini/skills/gavin-orchestrate",
                    file: "SKILL.md",
                    contents: include_str!("gavin_orchestrate_skill.md"),
                },
                ManagedFile {
                    dir: ".gemini/skills/gavin-resume",
                    file: "SKILL.md",
                    contents: include_str!("gavin_resume_skill.md"),
                },
                ManagedFile {
                    dir: ".gemini/skills/gavin-develop",
                    file: "SKILL.md",
                    contents: include_str!("gavin_develop_skill.md"),
                },
            ],
        }),
    },
    AgentProfile {
        id: "cursor",
        // Verified 2026-09-11 against Cursor Agent CLI 2026.09.10
        // (`agent --help`): `--model <name>` selects the model;
        // `agent --list-models` prints dated ids that rot, so the
        // picker is Custom… until a catalog route lands.
        model_flag: "--model",
        models: &[],
        model_catalog: None,
        effort_flag: "",
        efforts: &[],
        label: "Cursor",
        instructions_file: "AGENTS.md",
        // The terminal agent binary (`agent`), not the IDE launcher
        // (`cursor`). The IDE's positionals are paths; this CLI takes a
        // prompt. Workspaces that still name `cursor` as command need
        // to switch to `agent` (Settings / the agent-change wizard).
        //
        // `--approve-mcps` and `--trust` belong on the command itself,
        // not in a human custom override: without them Cursor stalls on
        // MCP/workspace prompts (or a hand-rolled flag line eats the
        // positional and the tab opens empty). No trailing `--` here —
        // `composeLaunchCommand` appends `--model …` after this string,
        // and a `--` would turn that model flag into prompt text.
        // Verified against `agent --help` 2026.09.10.
        command: "agent --approve-mcps --trust",
        // Bare positional after the flags
        // (`Usage: agent [options] [command] [prompt...]`).
        prompt_args: Some(""),
        prompt_injection: false,
        untrusted_osc133: false,
        // Print mode for scripts; `--force` so a hidden run can write
        // and run tools (without it, `-p` proposes and applies nothing);
        // same MCP/trust pins as the interactive command. Trailing `--`
        // so a prompt starting with `-` is not read as a flag. Verified
        // against `agent --help` 2026-09-11 and cursor.com/docs/cli/headless.
        headless_args: "-p --force --approve-mcps --trust --",
        failure_patterns: &[],
        failure_causes: &[],
        session_id_args: "",
        // `--resume [chatId]` exists, but gavin does not yet mint or
        // discover Cursor chat ids the way it does for claude-code /
        // opencode, so resume stays off rather than opening a picker.
        session_id_discovery: "",
        resume_args: "",
        usage_probe: Some(UsageProbe::CursorSession),
        token_log: None,
        folder_trust: None,
        agent_file: None,
        mcp: Some(McpLayout {
            config_file: ".cursor/mcp.json",
            server_key: "gavin",
            format: McpFormat::JsonServersStdio,
            // Verified 2026-09-11 against cursor.com/docs/skills: Cursor
            // loads project skills from `.cursor/skills/<name>/SKILL.md`
            // (and also discovers `.claude/skills/` / `.codex/skills/`
            // for compatibility). Install under Cursor's own root so a
            // workspace that never chose Claude Code does not grow a
            // `.claude/` directory. Same four skills as the other skill-
            // capable rows; Cursor's frontmatter (`name` + `description`)
            // matches what gavin already authors.
            skills: &[
                ManagedFile {
                    dir: ".cursor/skills/gavin",
                    file: "SKILL.md",
                    contents: include_str!("gavin_skill.md"),
                },
                ManagedFile {
                    dir: ".cursor/skills/gavin-orchestrate",
                    file: "SKILL.md",
                    contents: include_str!("gavin_orchestrate_skill.md"),
                },
                ManagedFile {
                    dir: ".cursor/skills/gavin-resume",
                    file: "SKILL.md",
                    contents: include_str!("gavin_resume_skill.md"),
                },
                ManagedFile {
                    dir: ".cursor/skills/gavin-develop",
                    file: "SKILL.md",
                    contents: include_str!("gavin_develop_skill.md"),
                },
            ],
        }),
    },
    AgentProfile {
        id: "opencode",
        model_flag: "--model",
        // No stable alias exists (see ModelCatalog::OpencodeCli), so this
        // row is empty on purpose and the picker is filled at startup
        // from the machine's own catalogue instead.
        models: &[],
        model_catalog: Some(ModelCatalog::OpencodeCli),
        effort_flag: "",
        efforts: &[],
        label: "opencode",
        instructions_file: "AGENTS.md",
        command: "opencode",
        // ATTACHED, not separated. `opencode [project]`'s bare positional
        // is a directory (`opencode 'Fix the login flow'` dies with
        // "Failed to change directory to …/Fix the login flow"), so the
        // prompt has to ride a flag -- and `--prompt <value>` is parsed
        // by yargs, which reads a value beginning with `-` as the next
        // flag and prints the usage banner instead of starting. The
        // `--prompt=<value>` form takes the same value and stores it
        // byte for byte, newlines and quotes included. Verified
        // 2026-09-02 against 1.3.13 through `sh -c`, which is how the
        // daemon runs every session.
        prompt_args: Some("--prompt="),
        prompt_injection: false,
        untrusted_osc133: false,
        // `run` is the non-interactive subcommand; `--agent` names the
        // gavin-owned definition below, which carries the git-only grant.
        // `--auto` (verified on current `opencode run --help` 2026-09-11)
        // auto-approves permissions the agent file has not denied, so a
        // hidden commit does not stall on an ask nobody can answer. The
        // trailing `--` is load-bearing: without it a prompt starting
        // with `-` is read as a flag and the run prints usage.
        //
        // A denied tool comes back as a tool error the agent can read
        // ("The user has specified a rule which prevents you…"), so the
        // grant in gavin-commit.md stays the real fence.
        headless_args: "run --agent gavin-commit --auto --",
        failure_patterns: &[],
        failure_causes: &[],
        session_id_args: "",
        // Verified against the real binary and its own on-disk store
        // (1.18.25, 2026-09-10): opencode has moved off the flat
        // `storage/session/<hash>/*.json` layout older docs describe and
        // onto a SQLite db at `~/.local/share/opencode/opencode.db`,
        // whose `session` table has a `directory` column holding the
        // exact launch cwd (not a hash of it) -- read with real gavin
        // spike data still in that table from `/private/tmp/gavin-oc-*`.
        //
        // `pwd -P`, not bare `pwd`: opencode records the PHYSICAL path
        // (`/private/tmp/...`), and bash's `pwd` returns the LOGICAL one
        // by default -- a bare `pwd` from inside `/tmp/...` (a symlink to
        // `/private/tmp` on macOS) matches nothing, confirmed live
        // 2026-09-11 with a real `opencode run` under `/tmp` that stored
        // `/private/tmp` and a bare-`pwd` discovery query that came back
        // empty. macOS/Linux XDG path only; not checked on Windows.
        session_id_discovery: "sqlite3 \"$HOME/.local/share/opencode/opencode.db\" \"SELECT id FROM session WHERE directory = '$(pwd -P)' ORDER BY time_updated DESC LIMIT 1;\"",
        // Top-level `-s/--session <id>` (`opencode --help`, not the
        // `run` subcommand's own copy of the same flag): the interactive
        // TUI command this profile already launches with via
        // `--prompt=` above, continued at a specific session instead of
        // a fresh one -- the same "no new prompt, reopen the transcript"
        // shape `claude --resume` already has. `run --session <id>` was
        // rejected: `run` is the ONE-SHOT headless subcommand
        // (`headless_args` above), not what a live launched session is.
        resume_args: "--session",
        usage_probe: Some(UsageProbe::OpencodeGo),
        token_log: None,
        folder_trust: None,
        // opencode reads `.claude/skills/` too, but a workspace that
        // never chose Claude Code should not grow a `.claude/`
        // directory. Its own validator accepts gavin's existing
        // `name` + `description` frontmatter unchanged, so the four
        // files install verbatim.
        agent_file: Some(ManagedFile {
            dir: ".opencode/agent",
            file: "gavin-commit.md",
            contents: include_str!("opencode_commit_agent.md"),
        }),
        mcp: Some(McpLayout {
            config_file: "opencode.json",
            server_key: "gavin",
            format: McpFormat::JsonLocal,
            skills: &[
                ManagedFile {
                    dir: ".opencode/skills/gavin",
                    file: "SKILL.md",
                    contents: include_str!("gavin_skill.md"),
                },
                ManagedFile {
                    dir: ".opencode/skills/gavin-orchestrate",
                    file: "SKILL.md",
                    contents: include_str!("gavin_orchestrate_skill.md"),
                },
                ManagedFile {
                    dir: ".opencode/skills/gavin-resume",
                    file: "SKILL.md",
                    contents: include_str!("gavin_resume_skill.md"),
                },
                ManagedFile {
                    dir: ".opencode/skills/gavin-develop",
                    file: "SKILL.md",
                    contents: include_str!("gavin_develop_skill.md"),
                },
            ],
        }),
    },
    AgentProfile {
        id: "kimi-code",
        // `-m <alias>` (`kimi --help`, 2.1.1). No static list: the
        // aliases are managed and refresh upstream, so they are read off
        // `kimi provider list --json` at startup like opencode's.
        model_flag: "-m",
        models: &[],
        model_catalog: Some(ModelCatalog::KimiCli),
        // ENV-ASSIGNMENT shape (see the field's doc comment): kimi has no
        // effort flag at all -- the knob is `KIMI_MODEL_THINKING_EFFORT`,
        // which `composeEffort` prepends as `KIMI_MODEL_THINKING_EFFORT=low
        // kimi ...`. Verified at the wire through a local proxy: the
        // request body carried `thinking.effort="low"` (2.1.1,
        // 2026-10-05). Levels from the managed models' `supportEfforts`.
        effort_flag: "KIMI_MODEL_THINKING_EFFORT=",
        efforts: &["low", "high", "max"],
        label: "Kimi Code",
        // kimi reads AGENTS.md only -- not CLAUDE.md or KIMI.md -- so it
        // shares codex's file; the marker-block writer already merges.
        instructions_file: "AGENTS.md",
        command: "kimi",
        // None ON PURPOSE (K3): kimi has NO interactive prompt flag --
        // `-p` is non-interactive and exits, and there is no positional.
        // A visible run launches `kimi` bare and gets its card prompt
        // written into the PTY once kimi's MCP handshake says the TUI is
        // up (verified eager, 2.1.1) -- which is what
        // prompt_injection tells the app to do.
        prompt_args: None,
        prompt_injection: true,
        untrusted_osc133: true,
        // `-p='<prompt>'`, ATTACHED: the separated `-p -- '<prompt>'`
        // form does not work (verified live 2026-10-05, 2.1.1). Headless
        // runs land in kimi's `auto` permission policy by default -- no
        // approvals, static deny rules apply -- so a hidden commit needs
        // no grant flag (and `--yolo` conflicts with `-p`).
        headless_args: "-p=",
        // `error: failed to run prompt: <reason>` observed live 4x
        // (2.1.1); the rest are kimi's own i18n failure strings.
        failure_patterns: &[
            "error: failed to run prompt:",
            "Model rate limit reached",
            "Model authentication failed",
            "Model overloaded",
            "Context size exceeded",
            "Cannot connect to the model service",
        ],
        // Auth first, the same ordering rule claude-code's table
        // carries: a line that is an auth failure must never classify as
        // a network blip worth retrying. Only verified strings carry a
        // row -- the same posture as every other profile.
        failure_causes: &[
            FailureCausePattern { pattern: "Model authentication failed", cause: "auth" },
            FailureCausePattern { pattern: "Model rate limit reached", cause: "usage-limit" },
            FailureCausePattern { pattern: "Context size exceeded", cause: "usage-limit" },
            FailureCausePattern { pattern: "Model overloaded", cause: "outage" },
            FailureCausePattern { pattern: "Cannot connect to the model service", cause: "network" },
        ],
        // Discover-not-mint, the opencode pattern: `--session <unknown>`
        // hard-errors, so gavin cannot hand kimi an id. kimi also prints
        // `To resume this session: kimi -r session_<uuid>` on stderr
        // after every `-p` run, and the naming skill's self-report route
        // gets the id either way. `kimi session list --json` is
        // newest-first and defaults to the cwd (`--cwd` takes a REQUIRED
        // path arg, so omitting it is what scopes the list); the first
        // `"id":` line of the pretty-printed array is the answer.
        // Verified against the real CLI (2.1.1, 2026-10-05).
        session_id_args: "",
        session_id_discovery: "kimi session list --json | sed -n -E 's/^ *\"id\": \"([^\"]+)\".*/\\1/p' | head -1",
        // Top-level `--session <id>` reopens the conversation: the
        // interactive TUI this profile launches bare, continued at the
        // discovered id -- the same shape opencode's `--session` has.
        // `--continue` was rejected: newest-for-cwd is the race
        // opencode's V11e demonstrated.
        resume_args: "--session",
        usage_probe: Some(UsageProbe::KimiOauth),
        token_log: Some(TokenLog::KimiWireJsonl),
        // The per-folder trust record kimi checks before it loads a
        // project `.mcp.json` (K18, decided B: gavin writes it at
        // integration). Granted only when this run wrote gavin's entry
        // -- `grant_folder_trust` holds the consent rules.
        folder_trust: Some(FolderTrust::KimiRecord),
        // No grant file: the headless grant rides kimi's default `auto`
        // policy, not an agent definition.
        agent_file: None,
        mcp: Some(McpLayout {
            // The SAME file and dialect as claude-code (K6): kimi reads
            // the project `.mcp.json`, proven live with this repo's own
            // committed file. The merge writer and the foreign-server
            // gate already handle two profiles sharing one file.
            config_file: ".mcp.json",
            server_key: "gavin",
            format: McpFormat::JsonServers,
            // kimi also reads the shared `.agents/skills/`, but gavin
            // keeps its files in kimi's own root -- the same reasoning as
            // opencode's layout.
            skills: &[
                ManagedFile {
                    dir: ".kimi-code/skills/gavin",
                    file: "SKILL.md",
                    contents: include_str!("gavin_skill.md"),
                },
                ManagedFile {
                    dir: ".kimi-code/skills/gavin-orchestrate",
                    file: "SKILL.md",
                    contents: include_str!("gavin_orchestrate_skill.md"),
                },
                ManagedFile {
                    dir: ".kimi-code/skills/gavin-resume",
                    file: "SKILL.md",
                    contents: include_str!("gavin_resume_skill.md"),
                },
                ManagedFile {
                    dir: ".kimi-code/skills/gavin-develop",
                    file: "SKILL.md",
                    contents: include_str!("gavin_develop_skill.md"),
                },
            ],
        }),
    },
];

pub fn profile_by_id(id: &str) -> &'static AgentProfile {
    AGENT_PROFILES.iter().find(|p| p.id == id).unwrap_or(&AGENT_PROFILES[0])
}

/// The stock row for an id, or None for anything else. Read paths that
/// attribute machine state BY profile (the usage probe, the token log)
/// take this rather than `profile_by_id`: the claude-code fallback there
/// serves reads of shipped defaults, and a named custom is not claude --
/// probing claude under a custom's id would cache claude's usage as the
/// custom's, reading the custom as spent whenever claude is.
pub fn stock_profile_by_id(id: &str) -> Option<&'static AgentProfile> {
    AGENT_PROFILES.iter().find(|p| p.id == id)
}

/// What a named custom profile IS to a WRITE: no stock row, so no skill
/// mechanism and no MCP layout of gavin's own -- `resolved_mcp` then
/// falls through to the workspace's `[agent] mcp_file`, and the step
/// guidance goes inline. This is the retired hard-coded `custom` row's
/// shape, kept for exactly that purpose.
static CUSTOM_WRITE_PROFILE: AgentProfile = AgentProfile {
    id: "custom",
    model_flag: "",
    models: &[],
    model_catalog: None,
    effort_flag: "",
    efforts: &[],
    label: "Custom…",
    instructions_file: "",
    command: "",
    prompt_args: None,
    prompt_injection: false,
    untrusted_osc133: false,
    headless_args: "",
    failure_patterns: &[],
    failure_causes: &[],
    session_id_args: "",
    session_id_discovery: "",
    resume_args: "",
    usage_probe: None,
    token_log: None,
    folder_trust: None,
    agent_file: None,
    mcp: None,
};

/// The profile a WRITE through the workspace's files resolves to. Unlike
/// `profile_by_id` -- whose claude-code fallback serves READS of shipped
/// defaults -- a write must never put claude's skill file or MCP layout
/// down for someone's own binary: a named custom (or a config still
/// naming the retired `custom` id) gets the custom-like row above.
fn profile_for_writes(id: &str) -> &'static AgentProfile {
    if crate::config::is_stock_profile_id(id) {
        profile_by_id(id)
    } else {
        &CUSTOM_WRITE_PROFILE
    }
}

/// The profile id recorded in config.toml, defaulting to claude-code.
/// Read directly rather than routed through the daemon: this is a
/// one-shot read on a user-initiated action, and agent_setup already
/// touches the root's files directly.
pub fn read_profile_id(root: &Path) -> String {
    read_profile_id_in(&LocalFiles, root)
}

/// `read_profile_id`, on whichever disk the workspace is.
pub fn read_profile_id_in(fs: &dyn WorkspaceFiles, root: &Path) -> String {
    root_agent_key_in(fs, root, "profile").unwrap_or_else(|| "claude-code".to_string())
}

/// The profile id a profile-less workspace resolves to: config.toml's
/// `[agent] profile` when it names one, else the app-wide default agent
/// (config.json's `agentDefaults.defaultAgent`), else claude-code -- the
/// same order the frontend's `resolveAgentConfig` answers with, so what
/// an integration or a prompt composer writes FOR is the agent the
/// launch will actually run.
fn resolved_profile_id_in(fs: &dyn WorkspaceFiles, root: &Path, default_agent: Option<&str>) -> String {
    root_agent_key_in(fs, root, "profile")
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            default_agent
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("claude-code")
                .to_string()
        })
}

/// `resolved_profile_id_in` on the local disk.
fn resolved_profile_id(root: &Path, default_agent: Option<&str>) -> String {
    resolved_profile_id_in(&LocalFiles, root, default_agent)
}

/// config.toml's explicit `file`, else the profile's default.
fn resolved_instructions_file(fs: &dyn WorkspaceFiles, root: &Path, profile: &AgentProfile) -> String {
    root_agent_key_in(fs, root, "file")
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| profile.instructions_file.to_string())
}

pub fn root_agent_key(root: &Path, key: &str) -> Option<String> {
    root_agent_key_in(&LocalFiles, root, key)
}

/// `root_agent_key`, on whichever disk the workspace is.
pub fn root_agent_key_in(fs: &dyn WorkspaceFiles, root: &Path, key: &str) -> Option<String> {
    let path = root.join(".gavin-root").join("config.toml");
    let content = fs.read_to_string(&path).ok()??;
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
    prd_relative_path_in(&LocalFiles, root)
}

/// `prd_relative_path`, on whichever disk the workspace is.
pub fn prd_relative_path_in(fs: &dyn WorkspaceFiles, root: &Path) -> String {
    let read = || -> Option<String> {
        let path = root.join(".gavin-root").join("config.toml");
        let content = fs.read_to_string(&path).ok()??;
        let table = content.parse::<toml::Table>().ok()?;
        protocol::usable_prd_path(table.get("prd")?.as_str()?)
    };
    read().unwrap_or_else(|| protocol::DEFAULT_PRD_PATH.to_string())
}

/// Same allow-list and format-preserving write as the daemon's
/// set_root_config_field, for app-side paths that must not depend on a
/// daemon round trip (the D41 launch-command migration).
pub fn write_root_config_key(root: &Path, key: &str, value: &str) -> anyhow::Result<()> {
    if !matches!(key, "profile" | "file" | "command" | "mcp_file" | "mcp_format" | "model_flag") {
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
development. Follow the gavin workflow skill in `{skill}`\n\
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
  work, and never mark work done that you have not verified. Write In\n\
  Progress when you START: that column claims the card for your tab, so the\n\
  board stops offering to run a second agent on it.\n\
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
    let skill = mcp.and_then(ResolvedMcp::workflow_skill_path);
    let template = match (mcp, skill.as_deref()) {
        (Some(_), Some(_)) => BLOCK_WITH_SKILL,
        (Some(_), None) => BLOCK_INLINE_WITH_MCP,
        (None, _) => BLOCK_INLINE,
    };
    with_prd_path(template, prd).replace("{skill}", skill.as_deref().unwrap_or(""))
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
    // With the platform's executable suffix -- see
    // `daemon::resolve_daemon_binary_path`, whose reasoning is the same
    // and whose file ships beside this one.
    let path = dir.join(format!("gavin-mcp{}", std::env::consts::EXE_SUFFIX));
    if !path.is_file() {
        anyhow::bail!(
            "gavin-mcp binary not found beside the app ({}) — build it with `cargo build -p gavin-mcp`",
            path.display()
        );
    }
    Ok(path)
}

/// gavin's own committed launcher, named by the config files RELATIVE to
/// the workspace root. Forward slash on both platforms: it is a config
/// value, not a path built here, and Windows accepts it.
const MCP_LAUNCHER: &str = "scripts/gavin-mcp";

/// The file the launcher command actually spawns.
///
/// Windows resolves an extensionless relative command through PATHEXT and
/// lands on the `.cmd`; everywhere else the sh script runs itself. Both
/// are committed, so a real checkout has the pair -- but the existence
/// check has to name the one that would run, or a half-checkout writes a
/// command that cannot start.
///
/// `windows` is the platform of the machine that will RUN the command,
/// which is not this process for an ssh workspace -- the agent and its
/// `gavin-mcp` are on the host. `WorkspaceFiles::is_windows` answers it
/// for whichever disk the root is on.
fn launcher_file(root: &Path, windows: bool) -> PathBuf {
    let name = if windows { "gavin-mcp.cmd" } else { "gavin-mcp" };
    root.join("scripts").join(name)
}

/// What the config files name as the command.
///
/// `.mcp.json` and `.cursor/mcp.json` are committed and this checkout is
/// opened from both a Mac and a Windows box, so an absolute path there is
/// wrong for one machine by construction: each setup run re-pointed the
/// file and broke the other, three times over, until it named a binary
/// that existed on neither and every agent session lost the gavin_* tools.
/// A root that carries gavin's own launcher is named by relative path
/// instead, and the per-machine resolving moves into the launcher.
///
/// Every OTHER workspace -- gavin manages roots that are not its own
/// checkout -- gets the absolute binary resolved beside the running app,
/// which is correct there: those files are not shared between machines.
///
/// That split is also why the launcher needs a second condition, and not
/// just "a file sits at that path". A relative command is resolved by the
/// agent against the workspace root, so naming one means the REPO chooses
/// what gavin's own entry executes. `03-agent-surface.md` records that
/// gavin's own writes cannot be redirected; pointing them at a file an
/// arbitrary cloned repo happens to ship would falsify that. So the
/// launcher is named only in a checkout that actually builds gavin-mcp --
/// where the human already trusts the tree enough to compile and run it,
/// and where the shared-config problem is the one that exists.
///
/// Both questions go through `fs`, never through this process's disk. An
/// ssh workspace's root is a path on the HOST: answering it locally would
/// read a same-shaped directory on the desktop, and the answer decides
/// what gavin's own MCP entry executes. A remote gavin checkout that
/// ships the launcher gets it, resolved on the host by the host's copy,
/// which is the same guarantee the local case gets -- and `mcp_path`'s
/// absolute binary remains the answer for every root that ships none.
fn mcp_command(fs: &dyn WorkspaceFiles, root: &Path, binary: &Path) -> String {
    let is_gavin_checkout = fs.is_file(&root.join("crates/gavin-mcp/Cargo.toml"));
    if is_gavin_checkout && fs.is_file(&launcher_file(root, fs.is_windows())) {
        MCP_LAUNCHER.to_string()
    } else {
        binary.to_string_lossy().into_owned()
    }
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

    /// Gavin's own entry, in this dialect's shape. The command is already
    /// resolved by `mcp_command` -- an absolute binary, or the launcher.
    fn json_entry(self, command: &str) -> serde_json::Value {
        match self {
            McpFormat::JsonLocal => {
                serde_json::json!({ "type": "local", "command": [command], "enabled": true })
            }
            McpFormat::JsonServersStdio => {
                // Cursor's `${env:NAME}` interpolation reads from the
                // agent process (the PTY child that still has the
                // daemon's injections) and puts them back on gavin-mcp.
                // Literal values would freeze one tab's id into the
                // workspace file; absent vars become empty and the tools
                // fail closed the same way a bare terminal does.
                serde_json::json!({
                    "type": "stdio",
                    "command": command,
                    "args": [],
                    "env": {
                        "GAVIN_MCP": "${env:GAVIN_MCP}",
                        "GAVIN_SESSION_ID": "${env:GAVIN_SESSION_ID}",
                        "GAVIN_SESSION_TOKEN": "${env:GAVIN_SESSION_TOKEN}",
                        "GAVIN_SESSION_SOCKET": "${env:GAVIN_SESSION_SOCKET}",
                    }
                })
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
fn write_mcp_config(
    fs: &dyn WorkspaceFiles,
    root: &Path,
    layout: &ResolvedMcp,
    binary: &Path,
) -> anyhow::Result<PathBuf> {
    let path = root.join(&layout.config_file);
    // The `create_dir_all` that used to stand here is gone on purpose:
    // `.gemini/`, `.cursor/` and `.codex/` still need not exist, but the
    // parent is now created by `LocalFiles::write_bytes`, on whichever
    // disk the workspace is. Doing it here would create a `.cursor/` on
    // the DESKTOP for an ssh workspace whose files live on the host.
    let command = mcp_command(fs, root, binary);
    match layout.format {
        McpFormat::TomlServers => write_mcp_config_toml(fs, &path, layout, &command)?,
        McpFormat::JsonServers | McpFormat::JsonServersStdio | McpFormat::JsonLocal => {
            write_mcp_config_json(fs, &path, layout, &command)?
        }
    }
    Ok(path)
}

fn write_mcp_config_json(
    fs: &dyn WorkspaceFiles,
    path: &Path,
    layout: &ResolvedMcp,
    command: &str,
) -> anyhow::Result<()> {
    let mut doc: serde_json::Value = if let Some(existing) = fs.read_to_string(path)? {
        serde_json::from_str(&existing).map_err(|_| {
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
    servers.insert(layout.server_key.to_string(), layout.format.json_entry(command));
    fs.write_bytes(path, format!("{}\n", serde_json::to_string_pretty(&doc)?).as_bytes())?;
    Ok(())
}

/// Codex's `.codex/config.toml`, written with toml_edit so a hand-edited
/// file keeps its comments, key order and formatting -- the same reason
/// set_root_config_field uses it for gavin's own config.
fn write_mcp_config_toml(
    fs: &dyn WorkspaceFiles,
    path: &Path,
    layout: &ResolvedMcp,
    command: &str,
) -> anyhow::Result<()> {
    // Absent is empty; unreadable-but-present is an error, not a reason to
    // overwrite it -- the same promise the JSON writer makes.
    let existing = fs.read_to_string(path)?.unwrap_or_default();
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
    server["command"] = toml_edit::value(command);
    server["args"] = toml_edit::value(toml_edit::Array::new());
    fs.write_bytes(path, doc.to_string().as_bytes())?;
    Ok(())
}

/// A managed write, and what it cost. `replaced` is the file the
/// displaced bytes were moved to -- `None` when there was nothing there,
/// or when what was there is exactly what gavin just wrote.
pub struct ManagedWrite {
    pub path: PathBuf,
    pub replaced: Option<PathBuf>,
}

/// Where gavin parks the bytes it displaced. Deliberately not a `.md`:
/// every skill loader gavin writes for reads one filename per directory,
/// and a second markdown file beside it is one more thing that could get
/// picked up.
const REPLACED_SUFFIX: &str = ".replaced";

/// Writes a file gavin owns, preserving whatever it displaces.
///
/// Ownership is unchanged, and deliberately so: skipping a file that
/// differs cannot tell a hand edit from a version an older gavin wrote,
/// short of recording every write, and it would strand a workspace on
/// the first skill it ever installed. What changes is that the displaced
/// bytes survive. `f772997` added the `complexity:` section to
/// `.claude/skills/gavin-develop/SKILL.md` and a later setup run put the
/// stale template back over it -- with no prompt, no copy, and no record,
/// in a checkout several people share, where the natural reading of the
/// diff was that an agent had done it.
///
/// Identical bytes are not a displacement. The ordinary case is a re-run
/// that changes nothing, and it has to stay silent or the report the
/// caller renders is noise nobody reads.
///
/// One backup per file, holding the bytes displaced MOST recently: a
/// per-run history would pile up inside a directory an agent reads, and
/// the displacement worth showing is the one the human is looking at.
fn write_owned(fs: &dyn WorkspaceFiles, path: &Path, contents: &str) -> anyhow::Result<Option<PathBuf>> {
    // Bytes, not a string: a file that is not UTF-8 has no business in a
    // skill directory, but destroying it silently because it would not
    // decode is exactly the failure this function exists to stop.
    let displaced = fs.read_bytes(path).ok().flatten().filter(|existing| existing != contents.as_bytes());
    let replaced = match displaced {
        Some(existing) => {
            let mut name = path.as_os_str().to_os_string();
            name.push(REPLACED_SUFFIX);
            let backup = PathBuf::from(name);
            fs.write_bytes(&backup, &existing)?;
            Some(backup)
        }
        None => None,
    };
    fs.write_bytes(path, contents.as_bytes())?;
    Ok(replaced)
}

/// Gavin-managed: overwritten wholesale on each setup run, whatever the
/// file is. Substitution runs for every one of them, not just the ones
/// that mention the PRD today: a document that grows a `{prd}` later
/// needs no change here, and one that has none is unaffected.
fn write_managed_file(
    fs: &dyn WorkspaceFiles,
    root: &Path,
    file: &ManagedFile,
    prd: &str,
) -> anyhow::Result<ManagedWrite> {
    let path = root.join(file.dir).join(file.file);
    let replaced = write_owned(fs, &path, &with_prd_path(file.contents, prd))?;
    Ok(ManagedWrite { path, replaced })
}

fn write_skills(
    fs: &dyn WorkspaceFiles,
    root: &Path,
    layout: &ResolvedMcp,
    prd: &str,
) -> anyhow::Result<Vec<ManagedWrite>> {
    layout.skills.iter().map(|skill| write_managed_file(fs, root, skill, prd)).collect()
}

/// The heading that opens the memories the human has adopted off
/// `memory` note cards. Gavin authors the rest of the block and rewrites
/// it wholesale, but this section is the human's: it is carried across
/// every re-merge untouched.
///
/// Spelled identically in app/src/lib/memoryCard.ts, which is what
/// writes it. A drift between the two spellings does not fail anywhere:
/// it silently drops every adopted memory on the next setup run.
const LEARNED_HEADING: &str = "### Learned";

/// The adopted-memory section of an existing block: from its heading to
/// the end of the block, byte for byte. Last-thing-in-the-block by
/// construction (memoryCard.ts only ever appends), so there is no
/// following heading to stop at -- and taking everything after it is the
/// safe reading anyway, since the alternative is deleting text nobody
/// can get back.
fn learned_section(block_body: &str) -> Option<&str> {
    let mut offset = 0usize;
    for line in block_body.split_inclusive('\n') {
        if line.trim_end() == LEARNED_HEADING {
            return Some(block_body[offset..].trim_end());
        }
        offset += line.len();
    }
    None
}

/// Replaces the marker block in place, appends it otherwise (creating the
/// file if absent). Nothing outside the markers is ever touched, and the
/// one thing INSIDE them that gavin does not author -- the `### Learned`
/// section -- is carried over verbatim.
fn write_instructions_block(
    fs: &dyn WorkspaceFiles,
    root: &Path,
    instructions_file: &str,
    block_body: &str,
) -> anyhow::Result<PathBuf> {
    validate_agent_file_path(fs, root, instructions_file).map_err(|e| anyhow::anyhow!(e))?;
    let path = root.join(instructions_file);
    let content = if let Some(existing) = fs.read_to_string(&path)? {
        match (existing.find(MARKER_START), existing.find(MARKER_END)) {
            (Some(start), Some(end)) if end >= start => {
                let after = existing[end + MARKER_END.len()..].trim_start_matches('\n');
                let learned = learned_section(&existing[start + MARKER_START.len()..end]);
                let block = block_with(block_body, learned);
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
                format!("{existing}{sep}{}", block_with(block_body, None))
            }
        }
    } else {
        block_with(block_body, None)
    };
    fs.write_bytes(&path, content.as_bytes())?;
    Ok(path)
}

/// The marker block as it goes to disk: gavin's guidance, then whatever
/// the previous block had adopted. Trimmed and re-terminated rather than
/// spliced raw, so re-running setup twice over the same file produces
/// the same bytes both times.
fn block_with(block_body: &str, learned: Option<&str>) -> String {
    match learned {
        Some(section) => format!("{MARKER_START}\n{block_body}\n{section}\n{MARKER_END}\n"),
        None => format!("{MARKER_START}\n{block_body}{MARKER_END}\n"),
    }
}

/// One server entry a target MCP config already names that is not
/// gavin's own (AG-07). Returned instead of merged past silently: the
/// human sees exactly what a just-cloned repo would launch beside
/// gavin, in the shape it will run in -- the command and args verbatim,
/// not a summary that could drift from what the file says.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignMcpServer {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
}

/// What `run_integration` found in the target MCP config that is not
/// gavin's, and where. Carried on `IntegrationResult` only while a
/// decision is outstanding -- its presence is the signal the UI keys
/// the chooser off; a resolved run (nothing foreign, or a choice
/// supplied and honoured) carries none.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpForeignServers {
    pub file: String,
    pub servers: Vec<ForeignMcpServer>,
    /// Why "isolate" would refuse right now, computed up front so the
    /// UI can say so beside the button rather than only after a click
    /// fails. `None` would mean isolate is available for this profile --
    /// not reachable today (`isolate_refusal` above), kept as an option
    /// so a profile that later names a real second location needs no
    /// shape change here, only a `None` where this used to be `Some`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub isolate_refusal: Option<String>,
}

/// The human's answer to "this file already runs servers gavin did not
/// add": `Keep` merges gavin's entry beside them, same as every run
/// before this fix; `Isolate` asks for a file that carries only gavin's
/// entry (`isolate_refusal` says why that is not available yet). Any
/// other value -- including absent -- means undecided, which is what
/// `run_integration` treats as "skip the write and report the foreign
/// set" so the frontend can ask before anything changes on disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpForeignChoice {
    Keep,
    Isolate,
}

impl McpForeignChoice {
    fn from_str(value: Option<&str>) -> Option<Self> {
        match value {
            Some("keep") => Some(Self::Keep),
            Some("isolate") => Some(Self::Isolate),
            _ => None,
        }
    }
}

/// The server entries a target MCP config already names that are not
/// gavin's own, in the shape `write_mcp_config` would otherwise merge
/// past without a word. Empty for an absent file -- there is nothing to
/// disclose about a file gavin is about to create -- and an unparsable
/// one errors the same way `write_mcp_config` does, so a scan never
/// reports "nothing here" about a file it could not actually read.
fn foreign_mcp_servers(
    fs: &dyn WorkspaceFiles,
    path: &Path,
    layout: &ResolvedMcp,
) -> anyhow::Result<Vec<ForeignMcpServer>> {
    if !fs.is_file(path) {
        return Ok(Vec::new());
    }
    match layout.format {
        McpFormat::TomlServers => foreign_mcp_servers_toml(fs, path, layout.server_key),
        McpFormat::JsonServers | McpFormat::JsonServersStdio | McpFormat::JsonLocal => {
            foreign_mcp_servers_json(fs, path, layout)
        }
    }
}

fn foreign_mcp_servers_json(
    fs: &dyn WorkspaceFiles,
    path: &Path,
    layout: &ResolvedMcp,
) -> anyhow::Result<Vec<ForeignMcpServer>> {
    let doc: serde_json::Value = serde_json::from_str(&fs.read_to_string(path)?.unwrap_or_default())
        .map_err(|_| {
            anyhow::anyhow!("existing {} is not valid JSON — fix or remove it first", path.display())
        })?;
    let Some(servers) = doc.get(layout.format.json_container()).and_then(|v| v.as_object()) else {
        return Ok(Vec::new());
    };
    let mut out: Vec<ForeignMcpServer> = servers
        .iter()
        .filter(|(name, _)| name.as_str() != layout.server_key)
        .map(|(name, entry)| json_foreign_entry(name, entry, layout.format))
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Reads a JSON array of strings, dropping anything that is not one --
/// a defensively-read foreign file, not gavin's own, so a malformed
/// entry degrades to an empty list rather than failing the whole scan.
fn json_string_array(value: Option<&serde_json::Value>) -> Vec<String> {
    value
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

fn json_foreign_entry(name: &str, entry: &serde_json::Value, format: McpFormat) -> ForeignMcpServer {
    if format == McpFormat::JsonLocal {
        // opencode's shape: the executable and its args share one array,
        // command first -- the same layout `json_entry` writes.
        let mut parts = json_string_array(entry.get("command")).into_iter();
        let command = parts.next().unwrap_or_default();
        return ForeignMcpServer { name: name.to_string(), command, args: parts.collect() };
    }
    let command = entry.get("command").and_then(|v| v.as_str()).unwrap_or("").to_string();
    ForeignMcpServer { name: name.to_string(), command, args: json_string_array(entry.get("args")) }
}

fn foreign_mcp_servers_toml(
    fs: &dyn WorkspaceFiles,
    path: &Path,
    server_key: &str,
) -> anyhow::Result<Vec<ForeignMcpServer>> {
    let doc = fs.read_to_string(path)?.unwrap_or_default().parse::<toml_edit::DocumentMut>().map_err(|_| {
        anyhow::anyhow!("existing {} is not valid TOML — fix or remove it first", path.display())
    })?;
    let Some(table) = doc.get("mcp_servers").and_then(|i| i.as_table_like()) else {
        return Ok(Vec::new());
    };
    let mut out: Vec<ForeignMcpServer> = table
        .iter()
        .filter(|(name, _)| *name != server_key)
        .map(|(name, item)| ForeignMcpServer {
            name: name.to_string(),
            command: item.get("command").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            args: item
                .get("args")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str()).map(str::to_string).collect())
                .unwrap_or_default(),
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Why "isolate" refuses today. It would write gavin's entry to a file
/// that carries only it, leaving the repo's own config untouched -- for
/// a CLI whose docs name a SECOND file it reads automatically beside
/// the project one. None of the six stock dialects have one gavin has
/// verified: each CLI's own "second scope" (a user/global config) lives
/// under the human's home directory, which gavin's writes never reach
/// on purpose (`usable_mcp_path`, `validate_agent_file_path`) -- so this
/// refuses rather than writing to a path nobody confirmed the agent CLI
/// reads. "keep" stays available regardless.
fn isolate_refusal(layout: &ResolvedMcp) -> String {
    format!(
        "gavin knows no second file this agent reads automatically alongside {} — \"keep\" is the only option until one is verified",
        layout.config_file
    )
}

// --- Folder trust (K18) -------------------------------------------------
//
// An agent CLI that gates a repository's own MCP servers behind a
// per-folder "trust this?" record has no use for gavin's `.mcp.json` entry
// until the folder is trusted: an interactive run stops at a prompt and a
// headless run silently drops the server. The human decided gavin should
// write the record itself when they run Integration (2026-10-06, card
// feat-kimi-integration), so this is the one place gavin writes into the
// user's own agent state. Everything that keeps that from being a blank
// cheque lives in `grant_folder_trust`.

/// What `grant_folder_trust` came to, for the integration report.
#[derive(Debug, PartialEq, Eq)]
enum TrustGrant {
    /// A record was written at this path.
    Written(PathBuf),
    /// The folder already has one -- the human's own answer to the CLI's
    /// prompt, or an earlier run's. Left exactly as it was.
    Present,
    /// Not granted, and why, in words the wizard can show as they are.
    Withheld(String),
}

/// `\\?\C:\x` becomes `C:\x` and `\\?\UNC\host\share` becomes
/// `\\host\share`: the spelling `std::fs::canonicalize` gives on Windows,
/// which no process's own cwd ever has -- and the cwd is what kimi keys
/// its records on.
fn without_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

/// kimi's `canonicalWorkspaceRoot` for a path that is already absolute and
/// physical: backslashes to `/`, trailing `/` dropped, and a drive or UNC
/// shaped path lowercased (Windows paths compare case-insensitively).
fn kimi_canonical_root(path: &str) -> String {
    let slashed = path.replace('\\', "/");
    let bytes = slashed.as_bytes();
    let win_shaped = slashed.starts_with("//")
        || (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/');
    let trimmed = slashed.trim_end_matches('/');
    let key = if win_shaped { trimmed.to_lowercase() } else { trimmed.to_string() };
    if key.is_empty() {
        slashed
    } else {
        key
    }
}

/// The directory-name part of a kimi workdir key: kimi's
/// `slugifyWorkDirName`. Lowercased, every run outside `[a-z0-9._-]`
/// collapsed to one `-`, `-` trimmed from both ends, cut to 40, trimmed
/// again, and `workspace` when nothing usable is left.
fn kimi_slug(name: &str) -> String {
    let mut slug = String::new();
    let mut in_run = false;
    for c in name.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-') {
            slug.push(c);
            in_run = false;
        } else if !in_run {
            slug.push('-');
            in_run = true;
        }
    }
    let slug: String = slug.trim_matches('-').chars().take(40).collect();
    let slug = slug.trim_matches('-');
    if matches!(slug, "" | "." | "..") {
        "workspace".to_string()
    } else {
        slug.to_string()
    }
}

/// kimi's `encodeWorkDirKey`: `wd_<slug of the last segment>_<first 12 hex
/// of sha256 of the whole normalised path>`. The hash covers the whole
/// path, so a repository and each of its worktrees are different
/// workspaces -- which is also why a trusted parent does not cover a
/// child (proved against kimi 2.1.1, 2026-10-06).
///
/// Read out of the kimi binary and checked against every key kimi itself
/// wrote on the machine it was verified on (see the test); a rule this
/// exact is not something to re-derive from two samples.
fn kimi_workdir_key(path: &str) -> String {
    let slashed = path.replace('\\', "/");
    let normalized = slashed.trim_end_matches('/');
    let last = normalized.rsplit('/').next().unwrap_or(normalized);
    // `hash_token_hex` is named for the tokens it was written for and is
    // plain SHA-256 of the string's UTF-8 bytes, which is all this needs.
    let hash = protocol::hash_token_hex(normalized);
    format!("wd_{}_{}", kimi_slug(last), &hash[..12])
}

/// The trust key for a workspace root: canonical first (kimi's
/// `trustKey`), then the workdir key of THAT.
fn kimi_trust_key(root: &str) -> String {
    kimi_workdir_key(&kimi_canonical_root(root))
}

/// The record's bytes, in kimi's own compact shape.
fn kimi_trust_record(root: &str, trusted_at_ms: u128) -> String {
    serde_json::json!({ "root": root, "trustedAt": trusted_at_ms as u64 }).to_string()
}

/// kimi's home: `KIMI_CODE_HOME` when it names an absolute directory
/// (documented, and what the scratch setups in the spike use), else
/// `~/.kimi-code`. A relative value is ignored rather than guessed at --
/// kimi would resolve it against a cwd gavin does not know.
fn kimi_home_from(home: &Path, override_dir: Option<std::ffi::OsString>) -> PathBuf {
    match override_dir.map(PathBuf::from) {
        Some(dir) if dir.is_absolute() => dir,
        _ => home.join(".kimi-code"),
    }
}

fn kimi_home(fs: &dyn WorkspaceFiles, home: &Path) -> PathBuf {
    kimi_home_from(home, fs.env_var("KIMI_CODE_HOME"))
}

fn unix_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Trust `root` for the agent whose `FolderTrust` this is.
///
/// What keeps this from being a blank cheque:
///
/// - Only when this run WROTE gavin's MCP entry (the caller's gate). A
///   run that stopped at the foreign-server disclosure, or was told to
///   isolate, enables nothing: trusting the folder would switch on every
///   server the repository declares, including the ones the human has not
///   been shown or has just refused.
/// - Never when the agent's OTHER project MCP file -- `.kimi-code/mcp.json`
///   -- declares servers, for the same reason: the disclosure only reads
///   `.mcp.json`, and kimi gates and loads both behind the one record.
/// - Never over an existing record. It is the human's own answer, or an
///   earlier run's, and either way not this run's to rewrite.
/// - Only on a disk with a home to write to (`agent_home`): an ssh
///   workspace's record belongs on the host, out of reach from here.
///
/// And never revoked by gavin afterwards: it cannot tell its own record
/// from the one the human wrote by answering kimi's prompt.
///
/// A failure here is a `Withheld`, not an error: the instructions, skills
/// and MCP entry are already on disk, and a record that could not be
/// written costs one prompt on kimi's first run, not the whole setup.
fn grant_folder_trust(fs: &dyn WorkspaceFiles, trust: FolderTrust, root: &Path) -> TrustGrant {
    match try_grant_folder_trust(fs, trust, root) {
        Ok(grant) => grant,
        Err(e) => TrustGrant::Withheld(format!(
            "could not write the trust record ({e}) — kimi will ask once on its first run in this folder"
        )),
    }
}

fn try_grant_folder_trust(
    fs: &dyn WorkspaceFiles,
    trust: FolderTrust,
    root: &Path,
) -> anyhow::Result<TrustGrant> {
    let FolderTrust::KimiRecord = trust;
    let Some(home) = fs.agent_home() else {
        return Ok(TrustGrant::Withheld(
            "gavin cannot reach the machine kimi runs on from here — kimi will ask once on its first run in this folder"
                .to_string(),
        ));
    };

    // The second project MCP file kimi gates behind the same record.
    if let Some(text) = fs.read_to_string(&root.join(".kimi-code").join("mcp.json"))? {
        // An empty file is `{}` to kimi; so is a document with no
        // `mcpServers`. Anything unreadable is withheld on, since what
        // trusting would start is then unknown.
        let declared = if text.trim().is_empty() {
            Some(0)
        } else {
            serde_json::from_str::<serde_json::Value>(&text).ok().map(|doc| {
                doc.get("mcpServers").and_then(|s| s.as_object()).map_or(0, |servers| servers.len())
            })
        };
        match declared {
            Some(0) => {}
            Some(_) => {
                return Ok(TrustGrant::Withheld(
                    ".kimi-code/mcp.json declares MCP servers gavin has not shown you, and trusting the folder would start them — kimi will ask once on its first run in this folder"
                        .to_string(),
                ))
            }
            None => {
                return Ok(TrustGrant::Withheld(
                    ".kimi-code/mcp.json is not valid JSON, so gavin cannot tell what trusting the folder would start — kimi will ask once on its first run in this folder"
                        .to_string(),
                ))
            }
        }
    }

    // kimi keys on its own cwd, which is the PHYSICAL path.
    let physical = without_verbatim_prefix(
        &fs.canonical_dir(root).unwrap_or_else(|| root.to_path_buf()).to_string_lossy(),
    );
    let record = kimi_home(fs, &home).join("workspace-trust").join(kimi_trust_key(&physical));
    if fs.is_file(&record) {
        return Ok(TrustGrant::Present);
    }
    fs.write_private(&record, kimi_trust_record(&physical, unix_millis()).as_bytes())?;
    Ok(TrustGrant::Written(record))
}

// --- Kimi's fullscreen TUI ---------------------------------------------
//
// Kimi's default ("regular") TUI is inline: its prompt is the last lines
// of the live screen, so scrolling the terminal up to read earlier output
// takes the input out of view, and typing snaps the view back down. Its
// "fullscreen" mode draws on the alternate screen, owns scrolling and
// keeps the prompt pinned -- the same arrangement Claude Code's fullscreen
// mode has. Only the file switches it: `KIMI_CODE_TUI_FULL_SCREEN` appears
// in the binary but does not override a `tui_mode = "regular"` line
// (checked against kimi 2.1.1, 2026-10-08). The file is the user's own
// and global to kimi, so the rules below keep this to flipping the
// shipped default and nothing else.

/// What `set_kimi_fullscreen` came to, for the integration report.
#[derive(Debug, PartialEq, Eq)]
enum TuiModeGrant {
    /// The file was written (or created) at this path.
    Written(PathBuf),
    /// Already fullscreen. Left exactly as it was.
    Present,
    /// Not changed, and why, in words the wizard can show as they are.
    Withheld(String),
}

/// The text of `tui.toml` with `tui_mode = "fullscreen"`, or `None` when
/// it already is, or `Err` when the value is one this does not recognise.
///
/// Only the shipped default is flipped: `"regular"` becomes `"fullscreen"`
/// on its own line, keeping the trailing comment and every other line; no
/// `tui_mode` line gets one prepended (a top-level key has to precede any
/// table). Any other value -- a spelling a later kimi adds, or a line this
/// cannot parse -- is the human's, and is not touched.
fn with_kimi_fullscreen(text: &str) -> Result<Option<String>, String> {
    let mut found = false;
    let mut changed = false;
    let mut out = String::with_capacity(text.len() + 24);
    for line in text.split_inclusive('\n') {
        let body = line.trim_start();
        let rest = body.strip_prefix("tui_mode").map(str::trim_start).and_then(|r| r.strip_prefix('='));
        let Some(rest) = rest.filter(|_| !found) else {
            out.push_str(line);
            continue;
        };
        found = true;
        let eol = &line[line.trim_end_matches(['\r', '\n']).len()..];
        let (value, comment) = match rest.find('#') {
            Some(i) => (rest[..i].trim(), Some(rest[i..].trim_end_matches(['\r', '\n']))),
            None => (rest.trim(), None),
        };
        match value {
            "\"fullscreen\"" => out.push_str(line),
            "\"regular\"" => {
                changed = true;
                let indent = &line[..line.len() - body.len()];
                out.push_str(indent);
                out.push_str("tui_mode = \"fullscreen\"");
                if let Some(comment) = comment {
                    out.push(' ');
                    out.push_str(comment);
                }
                out.push_str(eol);
            }
            other => return Err(format!("tui_mode is {other}, which gavin leaves alone")),
        }
    }
    if !found {
        return Ok(Some(format!("tui_mode = \"fullscreen\"\n{text}")));
    }
    Ok(changed.then_some(out))
}

/// Switch kimi to its fullscreen TUI, in the user's own `tui.toml`.
///
/// Why Integration does this: the inline TUI scrolls its prompt out of
/// view inside gavin's terminals, and there is no per-launch switch. The
/// human chose to have it done for them (2026-10-08), so this is the
/// second place gavin writes into the user's own agent state, beside the
/// trust record. What keeps it modest: it flips the shipped default
/// `"regular"` or fills an absent key, never overrides another value, and
/// only on a disk with a home to write to (`agent_home`) -- an ssh
/// workspace's file belongs to the host. A failure is a `Withheld`, not an
/// error: the rest of the setup is already on disk.
fn set_kimi_fullscreen(fs: &dyn WorkspaceFiles) -> TuiModeGrant {
    let Some(home) = fs.agent_home() else {
        return TuiModeGrant::Withheld(
            "gavin cannot reach the machine kimi runs on from here — set tui_mode = \"fullscreen\" in kimi's tui.toml there for a pinned prompt".to_string(),
        );
    };
    let path = kimi_home(fs, &home).join("tui.toml");
    let current = match fs.read_to_string(&path) {
        Ok(text) => text.unwrap_or_default(),
        Err(e) => return TuiModeGrant::Withheld(format!("could not read kimi's tui.toml ({e})")),
    };
    match with_kimi_fullscreen(&current) {
        Ok(None) => TuiModeGrant::Present,
        Ok(Some(next)) => match fs.write_private(&path, next.as_bytes()) {
            Ok(()) => TuiModeGrant::Written(path),
            Err(e) => TuiModeGrant::Withheld(format!("could not write kimi's tui.toml ({e})")),
        },
        Err(why) => TuiModeGrant::Withheld(why),
    }
}

/// What kimi's folder-trust launch grant needs from the MCP config files,
/// read through whatever `WorkspaceFiles` the caller runs on.
fn mcp_server_count(fs: &dyn WorkspaceFiles, file: &Path) -> Option<usize> {
    let text = fs.read_to_string(file).ok()??;
    if text.trim().is_empty() {
        return Some(0);
    }
    let doc = serde_json::from_str::<serde_json::Value>(&text).ok()?;
    Some(doc.get("mcpServers").and_then(|servers| servers.as_object()).map_or(0, |servers| servers.len()))
}

/// Every server key `<file>` declares, for the "only what gavin manages"
/// reading a launch-time grant applies to the workspace root's `.mcp.json`.
fn mcp_server_keys(fs: &dyn WorkspaceFiles, file: &Path) -> Option<Vec<String>> {
    let text = fs.read_to_string(file).ok()??;
    let doc = serde_json::from_str::<serde_json::Value>(&text).ok()?;
    Some(
        doc.get("mcpServers")
            .and_then(|servers| servers.as_object())
            .map(|servers| servers.keys().cloned().collect())
            .unwrap_or_default(),
    )
}

/// Grants kimi's per-folder trust record for a session LAUNCH about to
/// run in `cwd`, when `cwd` sits strictly inside a gavin workspace whose
/// project MCP configuration the integration already vetted.
///
/// Why launches need their own grant: kimi keys the record on the
/// process's exact cwd, a trusted PARENT does not cover a child (proved
/// against 2.1.1, 2026-10-06), and cards launch in context folders
/// below the workspace root. Such a launch used to stop at the trust
/// screen -- before any MCP server (gavin's included) started, so the
/// daemon's queued card prompt, pasted into a screen that was not the
/// chat input, was lost and the run "never started"
/// (bug-kimi-launch-folder-trust).
///
/// What keeps this from being a blank cheque, given the record starts
/// every project MCP target kimi discovers from `cwd` upward:
///
/// - `cwd` must be STRICTLY INSIDE the workspace root. The root's own
///   record is the integration's grant (or the human's own answer at
///   kimi's prompt), and this function never revisits that decision.
/// - No `.mcp.json` or `.kimi-code/mcp.json` may sit in any directory
///   from `cwd` up to (excluding) the root: a file there declares
///   servers the integration's disclosure never showed the human.
/// - The root's own files must still say what the integration vetted:
///   `.kimi-code/mcp.json` declaring nothing, and `.mcp.json` (when
///   present) declaring no server beyond the one gavin's merge writer
///   manages (`McpLayout::server_key`). A later-added foreign server
///   turns the grant off, not on.
/// - `try_grant_folder_trust` never overwrites an existing record: the
///   human's own answer at kimi's prompt stands.
///
/// `None` means "no grant", by shape or by policy -- not an error: kimi
/// asks once at its trust screen, exactly as it did before this
/// function existed.
fn grant_kimi_launch_trust(fs: &dyn WorkspaceFiles, cwd: &Path, workspace_root: &Path) -> Option<TrustGrant> {
    let physical_cwd = fs.canonical_dir(cwd)?;
    let physical_root = fs.canonical_dir(workspace_root)?;
    if physical_cwd == physical_root || !physical_cwd.starts_with(&physical_root) {
        return None;
    }
    // No MCP declaration between the launch folder and the root: kimi
    // walks upward from the cwd, so a file at any level in between
    // would hand servers this grant never disclosed a way to start.
    let mut dir = physical_cwd.as_path();
    while dir != physical_root {
        if fs.is_file(&dir.join(".mcp.json")) || fs.is_file(&dir.join(".kimi-code").join("mcp.json")) {
            return None;
        }
        dir = dir.parent()?;
    }
    // The root's own files still declare nothing the integration did
    // not vet. Unreadable or invalid JSON withholds -- what the grant
    // would start is then unknown, the same posture
    // `try_grant_folder_trust` takes; an absent file declares nothing
    // (a `None` freshness below reads as `usize::MAX`, never 0).
    let own = physical_root.join(".kimi-code").join("mcp.json");
    if fs.is_file(&own) && mcp_server_count(fs, &own).unwrap_or(usize::MAX) != 0 {
        return None;
    }
    let shared = physical_root.join(".mcp.json");
    if fs.is_file(&shared) {
        match mcp_server_count(fs, &shared) {
            Some(0) => {}
            Some(_) => {
                // Non-empty: every server must be gavin's own.
                if mcp_server_keys(fs, &shared).unwrap_or_default().iter().any(|key| key != "gavin") {
                    return None;
                }
            }
            None => return None,
        }
    }
    Some(
        try_grant_folder_trust(fs, FolderTrust::KimiRecord, &physical_cwd)
            .unwrap_or_else(|e| TrustGrant::Withheld(format!("could not write the trust record ({e})"))),
    )
}

/// kimi's managed models' own default for new sessions, and gavin's
/// attention hooks, written into the human's kimi state when absent.
///
/// Two halves, one write:
///
/// - `default_permission_mode`. kimi's default is `manual` -- every tool
///   call stops for an answer -- which leaves an unattended card run
///   stalled at its first edit. The mode this writes, `yolo` ("Ask When
///   Needed"), is the one the CLI's own `-y` flag documents: routine
///   edits and commands run automatically; risky actions, questions and
///   plans still ask -- it stops only when needed. (`auto` would be
///   "never ask"; that is a different, stronger choice, and never what a
///   gavin launch should take for the human.)
///
/// - The `[[hooks]]` rules that turn kimi's own events into the one
///   signal the daemon already understands: a bell on the terminal.
///   kimi asks for approval, fails a turn, finishes a background task
///   or raises a background question WITHOUT ringing anything the
///   daemon scans for, so a tab that needs the human read as `working`
///   (or as `idle`, one unraised badge away) -- the exact complaint the
///   hooks fix. Each rule runs `gavin-attention`, a script gavin also
///   writes into the kimi home, which writes a bare BEL to `/dev/tty`;
///   the daemon's status scanner maps a bare BEL to
///   `waiting_for_input`, so the tab, the sidebar dot and the attention
///   inbox light the moment kimi waits. The events are observation-only
///   (none can block the tool or the turn), and the script consumes its
///   stdin and exits 0, so a hook failure can never disturb the agent.
///
/// What is never touched: a `default_permission_mode` the human has
/// already set (to any value, including `manual`), a hook event gavin's
/// script already has an entry for (the human's edits to it stand), a
/// `hooks` key that is not an array, and a `config.toml` kimi's own
/// parser would reject -- a file this function cannot read is not this
/// function's to rewrite.
fn ensure_kimi_launch_config(fs: &dyn WorkspaceFiles, home: &Path) {
    let kimi_home_dir = kimi_home(fs, home);
    let config = kimi_home_dir.join("config.toml");
    let script = kimi_home_dir.join(GAVIN_HOOK_SCRIPT_FILE);
    if !fs.is_file(&script) {
        let _ = fs.write_private(&script, GAVIN_HOOK_SCRIPT.as_bytes());
    }
    let text = fs.read_to_string(&config).ok().flatten().unwrap_or_default();
    if !text.trim().is_empty() && toml::from_str::<toml::Value>(&text).is_err() {
        return;
    }
    let doc = toml::from_str::<toml::Value>(&text).unwrap_or(toml::Value::Table(Default::default()));
    let mut out = text.clone();
    if doc.get("default_permission_mode").is_none() {
        out = insert_top_level_key(&out, "default_permission_mode = \"yolo\"\n");
    }
    // Which of gavin's hook events already have an entry running the
    // gavin script. `None` (the key absent entirely) appends them all;
    // a `hooks` key of any other shape is left strictly alone.
    let hooked: Option<std::collections::HashSet<&str>> = match doc.get("hooks") {
        None => Some(Default::default()),
        Some(toml::Value::Array(entries)) => Some(
            entries
                .iter()
                .filter_map(|entry| entry.as_table())
                .filter(|table| {
                    table
                        .get("command")
                        .and_then(toml::Value::as_str)
                        .is_some_and(|command| command.contains(GAVIN_HOOK_SCRIPT_FILE))
                })
                .filter_map(|table| table.get("event").and_then(toml::Value::as_str))
                .collect(),
        ),
        Some(_) => None,
    };
    if let Some(hooked) = hooked {
        let mut additions = String::new();
        for (event, matcher) in GAVIN_ATTENTION_HOOKS {
            if !hooked.contains(event) {
                additions.push_str(&format!(
                    "[[hooks]]\nevent = \"{event}\"\nmatcher = \"{matcher}\"\ncommand = \"sh '{script}'\"\ntimeout = 5\n\n",
                    script = script.display(),
                ));
            }
        }
        if !additions.is_empty() {
            if !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(&additions.trim_end_matches('\n'));
            out.push('\n');
        }
    }
    let _ = fs.write_private(&config, out.as_bytes());
}

/// `text` with `line` inserted ahead of the first `[table]` header --
/// top-level TOML keys must precede every table -- or appended to a
/// header-less file.
fn insert_top_level_key(text: &str, line: &str) -> String {
    let mut out = String::new();
    let mut inserted = false;
    for existing in text.lines() {
        if !inserted && existing.trim_start().starts_with('[') {
            out.push_str(line);
            inserted = true;
        }
        out.push_str(existing);
        out.push('\n');
    }
    if !inserted {
        out.push_str(line);
    }
    out
}

/// The file name of gavin's hook script inside the kimi home. One name
/// for the file and the `command` strings, and the marker the config
/// merge looks for when deciding which hook events already exist.
const GAVIN_HOOK_SCRIPT_FILE: &str = "gavin-attention";

/// The hook events gavin maintains, as `(event, matcher)` pairs --
/// every rule runs the same script, which only rings the bell.
///
/// `PermissionRequest` is the approval prompt in Ask When Needed mode
/// (and the trust screen is gone before it, thanks to the launch-time
/// grant); `StopFailure` is a turn that died on an error; the
/// `Notification` matcher is background-task completions and failures;
/// a `question` TaskStarted is a background question waiting on the
/// human. Each is observation-only in kimi's hook table: no return
/// value is read, so the script can never interfere with the agent.
const GAVIN_ATTENTION_HOOKS: &[(&str, &str)] = &[
    ("PermissionRequest", ".*"),
    ("StopFailure", ".*"),
    ("Notification", "task\\\\.(completed|failed)"),
    ("TaskStarted", "question"),
];

/// What the hook script does, in four lines: drink the event JSON kimi
/// pipes in (so a large payload can never fill the pipe and stall the
/// hook), ring the terminal bell, succeed. `/dev/tty` is the session's
/// own PTY -- hooks run in kimi's session even in their own process
/// group -- and the daemon's status scanner turns a bare BEL into
/// `waiting_for_input` for exactly this session. When no terminal is
/// attached the write fails silently: missing the bell never blocks
/// the turn.
const GAVIN_HOOK_SCRIPT: &str = "\
#!/bin/sh
# gavin-managed: rings the terminal bell so gavin's daemon marks this
# session waiting_for_input. Do not edit -- config.toml merges on this
# file's name.
cat >/dev/null 2>&1
printf '\\a' > /dev/tty 2>/dev/null
exit 0
";

/// Everything a kimi launch needs from the human's own kimi state,
/// applied to this machine's disk before the session spawns: the
/// folder-trust record for the launch cwd (a card's context folder
/// below the root has none from the integration), and the config.toml
/// entries a launched session should run with (permission default,
/// attention hooks, the hook script). All no-ops on every launch after
/// the first; a withheld trust grant leaves kimi asking at its screen,
/// the pre-existing behavior, and is logged for the tab's log.
pub fn prepare_kimi_launch(cwd: Option<&str>, workspace_root: Option<&str>, home: &str) {
    let fs = LocalFiles;
    let target = cwd.map(Path::new).unwrap_or_else(|| Path::new(home));
    let workspace = workspace_root.map(Path::new).unwrap_or(target);
    if let Some(TrustGrant::Withheld(reason)) = grant_kimi_launch_trust(&fs, target, workspace) {
        eprintln!("kimi folder trust withheld for {}: {reason}", target.display());
    }
    ensure_kimi_launch_config(&fs, Path::new(home));
}

/// What a setup run wrote, and what it could not. Rendered verbatim by
/// the wizard's Integration step: a profile with no McpLayout still gets
/// its instructions block, and the two omissions are named with reasons
/// rather than failing the whole run (W4).
///
/// Every path in here is `protocol::wire_path`ed, like everything else
/// gavin puts in front of the UI. It is not cosmetic on Windows: a
/// `ManagedFile.dir` is a literal holding forward slashes
/// (`.opencode/skills/gavin`) and `Path::join` puts a backslash in front
/// of the file name, so the raw spelling carries BOTH separators --
/// `.opencode/skills/gavin\SKILL.md`. Anything that later splits such a
/// path on `/`, or compares it against a path it built itself, silently
/// misses. Normalised where the string is made rather than at each
/// consumer, so there is one spelling and not a rule to remember.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationResult {
    pub written: Vec<String>,
    pub skipped: Vec<(String, String)>,
    /// The managed files whose previous contents were not gavin's own,
    /// as (file, where the displaced bytes went). Reported apart from
    /// `written` because it is the only line of this result that says
    /// something was LOST: a workspace that hand-edited a skill has no
    /// other way to learn the run took it. Empty on an ordinary re-run,
    /// which writes the same bytes that were already there.
    pub replaced: Vec<(String, String)>,
    /// The foreign MCP servers a decision is still outstanding for, so
    /// the caller can show them and re-run with a choice. Absent once
    /// there is nothing left to ask (AG-07).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_foreign: Option<McpForeignServers>,
}

#[tauri::command]
/// `instructions_file` is the workspace's RESOLVED agent file. Passed
/// rather than read from config.toml here for the same reason
/// `agent_skills::binary_for` takes its binary: `[agent] file` ships with
/// the repository, and this command WRITES through it. The frontend
/// supplies a value already gated by workspace trust
/// (`workspaceTrust.ts`) -- the repo's only once a human approved this
/// config, the profile's own until then -- so the file gavin writes is
/// the file its Settings panel says it will write. `None` falls back to
/// reading the root, which is what an older frontend does and what
/// `validate_agent_file_path` still contains to the workspace.
///
/// `mcp_foreign_choice` is "keep", "isolate", or absent -- the answer to
/// a foreign-server disclosure a previous call returned, recorded by
/// the frontend (`mcpServerTrust.ts`) and replayed here so the question
/// is asked once per distinct set (AG-07). Meaningless, and ignored,
/// when there is nothing foreign to ask about.
///
/// For an ssh workspace the files are on the host and so is the
/// `gavin-mcp` the config must name: both come through the link
/// (`remote::RemoteFiles`, the banner's `mcpPath`). A host with no
/// `gavin-mcp` beside its daemon is reported, not written around.
///
/// Off the main thread: on an ssh workspace a run is a dozen round trips
/// to the host, one after another. One run at a time, still: the main
/// thread used to be what kept two runs from interleaving their
/// read-modify-writes of the same config files, and `INTEGRATION_RUNS`
/// is that now.
pub async fn setup_agent_integration(
    root_path: String,
    instructions_file: Option<String>,
    mcp_foreign_choice: Option<String>,
    profile_id: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<IntegrationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _one_at_a_time = INTEGRATION_RUNS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let choice = McpForeignChoice::from_str(mcp_foreign_choice.as_deref());
        let default_agent = app_handle
            .state::<crate::session::AgentDefaults>()
            .0
            .lock()
            .unwrap()
            .default_agent
            .clone();
        if let crate::remote::Route::Remote(link) =
            crate::remote::route_for_root(&app_handle, Some(&root_path))?
        {
            let host = link.host.clone();
            let mcp = link.mcp_path.clone();
            let files = crate::remote::RemoteFiles { link, root: root_path.clone() };
            return run_integration(
                &files,
                Path::new(&root_path),
                move || {
                    mcp.clone().map(PathBuf::from).ok_or_else(|| {
                        anyhow::anyhow!(
                            "gavin-mcp is not beside gavin-daemon on {host} — install it there and reconnect"
                        )
                    })
                },
                instructions_file.as_deref(),
                choice,
                profile_id.as_deref(),
                default_agent.as_deref(),
            );
        }
        run_integration(
            &LocalFiles,
            Path::new(&root_path),
            resolve_mcp_binary_path,
            instructions_file.as_deref(),
            choice,
            profile_id.as_deref(),
            default_agent.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Held for the whole of an integration run (`setup_agent_integration`).
static INTEGRATION_RUNS: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The command's body, with the binary lookup injected. Injected because
/// resolve_mcp_binary_path wants gavin-mcp beside the running executable,
/// which is never true under `cargo test` -- and it stays a closure rather
/// than a parameter so that a profile with no MCP config still succeeds
/// without one having to exist.
///
/// `default_agent` is config.json's `agentDefaults.defaultAgent`: the
/// profile a root with no `[agent] profile` of its own integrates, so a
/// profile-less workspace gets the files of the agent its launches
/// actually resolve to.
fn run_integration(
    fs: &dyn WorkspaceFiles,
    root: &Path,
    resolve_binary: impl Fn() -> anyhow::Result<PathBuf>,
    instructions_file: Option<&str>,
    mcp_choice: Option<McpForeignChoice>,
    profile_id: Option<&str>,
    default_agent: Option<&str>,
) -> Result<IntegrationResult, String> {
    if !fs.is_dir(root) {
        return Err(format!("root does not exist: {}", root.display()));
    }
    let profile_id = profile_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| resolved_profile_id_in(fs, root, default_agent));
    let profile = profile_for_writes(&profile_id);
    let instructions_file = instructions_file
        .map(str::trim)
        .filter(|f| !f.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| resolved_instructions_file(fs, root, profile));
    let mcp = resolved_mcp(fs, root, profile);
    let prd = prd_relative_path_in(fs, root);
    let mut written = Vec::new();
    let mut skipped = Vec::new();
    let mut replaced = Vec::new();
    let mut mcp_foreign = None;
    // Whether gavin's own entry reached the MCP config on this run: the
    // gate on `folder_trust`, since trusting a folder starts every server
    // it declares and the foreign-server disclosure is what says the
    // human has seen them.
    let mut mcp_written = false;

    // Written for EVERY profile -- the change W4 makes. Before this, a
    // profile without an McpLayout errored out and got nothing at all.
    written.push(protocol::wire_path(
        &write_instructions_block(
            fs,
            root,
            &instructions_file,
            &instructions_block_for(mcp.as_ref(), &prd),
        )
        .map_err(|e| e.to_string())?,
    ));

    // The two capabilities are reported separately: after sub-project B
    // every stock profile gets MCP config and skills; only unconfigured
    // custom (no verified skill root) skips the skill file.
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
                for write in write_skills(fs, root, layout, &prd).map_err(|e| e.to_string())? {
                    written.push(protocol::wire_path(&write.path));
                    if let Some(backup) = write.replaced {
                        replaced.push((
                            protocol::wire_path(&write.path),
                            protocol::wire_path(&backup),
                        ));
                    }
                }
            }
            let mcp_path = root.join(&layout.config_file);
            let foreign = foreign_mcp_servers(fs, &mcp_path, layout).map_err(|e| e.to_string())?;
            if foreign.is_empty() {
                written.push(protocol::wire_path(
                    &write_mcp_config(fs, root, layout, &binary).map_err(|e| e.to_string())?,
                ));
                mcp_written = true;
            } else {
                match mcp_choice {
                    Some(McpForeignChoice::Keep) => {
                        written.push(protocol::wire_path(
                            &write_mcp_config(fs, root, layout, &binary).map_err(|e| e.to_string())?,
                        ));
                        mcp_written = true;
                    }
                    Some(McpForeignChoice::Isolate) => {
                        skipped.push(("MCP config".to_string(), isolate_refusal(layout)));
                    }
                    None => {
                        let count = foreign.len();
                        skipped.push((
                            "MCP config".to_string(),
                            format!(
                                "{} already names {} gavin did not add — choose keep or isolate before it writes here",
                                layout.config_file,
                                if count == 1 {
                                    "a server".to_string()
                                } else {
                                    format!("{count} servers")
                                }
                            ),
                        ));
                        mcp_foreign = Some(McpForeignServers {
                            file: protocol::wire_path(&mcp_path),
                            isolate_refusal: Some(isolate_refusal(layout)),
                            servers: foreign,
                        });
                    }
                }
            }
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

    // The per-folder trust record the agent's CLI wants before it loads
    // the entry just written (K18). Reported either way: a write outside
    // the workspace is something the human is told, and a record that was
    // withheld is a prompt they will meet on first run.
    if let Some(trust) = profile.folder_trust {
        if !mcp_written {
            skipped.push((
                "folder trust".to_string(),
                format!(
                    "not granted — gavin's MCP entry was not written (see MCP config), so there is nothing to trust; {} will ask once on its first run in this folder",
                    profile.label
                ),
            ));
        } else {
            match grant_folder_trust(fs, trust, root) {
                TrustGrant::Written(path) => written.push(protocol::wire_path(&path)),
                TrustGrant::Present => {}
                TrustGrant::Withheld(why) => skipped.push(("folder trust".to_string(), why)),
            }
        }
    }

    // Kimi's pinned-prompt TUI. Independent of MCP, and keyed on the same
    // column as the trust record: kimi is the one agent whose own user
    // state gavin writes during Integration.
    if profile.folder_trust == Some(FolderTrust::KimiRecord) {
        match set_kimi_fullscreen(fs) {
            TuiModeGrant::Written(path) => written.push(protocol::wire_path(&path)),
            TuiModeGrant::Present => {}
            TuiModeGrant::Withheld(why) => skipped.push(("kimi fullscreen".to_string(), why)),
        }
    }

    // Independent of MCP: this is the profile's own tool grant, and the
    // headless run names it by `--agent`. Written last so the wizard's
    // list reads outward from the instructions file.
    if let Some(file) = profile.agent_file.as_ref() {
        let write = write_managed_file(fs, root, file, &prd).map_err(|e| e.to_string())?;
        written.push(protocol::wire_path(&write.path));
        if let Some(backup) = write.replaced {
            replaced.push((protocol::wire_path(&write.path), protocol::wire_path(&backup)));
        }
    }
    Ok(IntegrationResult { written, skipped, replaced, mcp_foreign })
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
    /// The gavin-owned agent definition, where the profile declares one.
    /// A whole file gavin authored, so it is removed outright -- unlike
    /// the MCP config and the instructions file, which are shared and
    /// only ever edited.
    pub agent_file: Option<PathBuf>,
}

pub fn gavin_install(root: &Path, default_agent: Option<&str>) -> GavinInstall {
    let profile = profile_for_writes(&resolved_profile_id(root, default_agent));
    let instructions = root.join(resolved_instructions_file(&LocalFiles, root, profile));
    let mcp = resolved_mcp(&LocalFiles, root, profile);
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
        agent_file: profile.agent_file.as_ref().map(|f| root.join(f.dir).join(f.file)),
    }
}

/// Whether the root's MCP config actually carries gavin's server entry.
/// A config file that never mentioned gavin is not the wizard's
/// business, and neither is one that does not parse -- refusing to
/// report an unreadable file is what keeps the remover from being handed
/// a file it would have to clobber to edit.
pub fn mcp_entry_present(root: &Path, default_agent: Option<&str>) -> bool {
    let profile = profile_for_writes(&resolved_profile_id(root, default_agent));
    let Some(layout) = resolved_mcp(&LocalFiles, root, profile) else { return false };
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
pub fn remove_mcp_entry(root: &Path, default_agent: Option<&str>) -> anyhow::Result<bool> {
    let profile = profile_for_writes(&resolved_profile_id(root, default_agent));
    let Some(layout) = resolved_mcp(&LocalFiles, root, profile) else { return Ok(false) };
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
/// with buildRunCommand; only profiles with prompt_args get that far.
#[tauri::command]
pub fn compose_agent_prompt(
    root_path: String,
    flow: String,
    prompt_extras: Vec<String>,
    agent_defaults: tauri::State<'_, crate::session::AgentDefaults>,
) -> Result<String, String> {
    let default_agent = agent_defaults.0.lock().unwrap().default_agent.clone();
    compose_agent_prompt_for(&root_path, &flow, default_agent.as_deref(), &prompt_extras)
}

/// The command's body, with the app-wide default agent injected: a root
/// with no `[agent] profile` composes for the agent its launches resolve
/// to, exactly as `run_integration` writes for it. `prompt_extras` is the
/// EFFECTIVE (workspace-overridden) list of extra prompt lines for that
/// agent, resolved by the frontend from the two per-primary maps.
fn compose_agent_prompt_for(
    root_path: &str,
    flow: &str,
    default_agent: Option<&str>,
    prompt_extras: &[String],
) -> Result<String, String> {
    let root = Path::new(root_path);
    if !root.is_dir() {
        return Err(format!("root does not exist: {root_path}"));
    }
    let skill = step_skill(flow).ok_or_else(|| format!("unknown flow: {flow}"))?;
    let profile = profile_for_writes(&resolved_profile_id(root, default_agent));
    let instructions_file = resolved_instructions_file(&LocalFiles, root, profile);
    let prd = prd_relative_path(root);
    let target = match flow {
        "prd" => prd.clone(),
        _ => instructions_file,
    };
    // The document names the PRD too, and it is the same document whether
    // it lands as a skill file or inline in the prompt.
    let document = with_prd_path(skill.document, &prd);

    // Keyed on the skill slot, not on MCP: a profile can have an MCP
    // config and still have nowhere to put a skill file (unconfigured
    // custom, or custom with mcp_file but no known skill root).
    let prompt = match resolved_mcp(&LocalFiles, root, profile).as_ref().and_then(ResolvedMcp::skill_slot) {
        Some((parent, file)) => {
            // The step skill sits beside the gavin-managed ones: same
            // parent directory, one directory per skill, matching the
            // profile. Written through `write_owned` for the same reason
            // they do: a composer action re-run over a step skill someone
            // edited destroys it exactly the way a setup run destroys an
            // edited managed skill. This flow has no result to report the
            // displacement on, so the `.replaced` file beside it is the
            // whole of the record -- which is why preserving the bytes
            // matters more here, not less.
            let dir = root.join(parent).join(skill.name);
            write_owned(&LocalFiles, &dir.join(file), &document).map_err(|e| e.to_string())?;
            format!(
                "Use the {} skill to write {target} for this repo. Interview me first.",
                skill.name
            )
        }
        None => format!(
            "Write {target} for this repo, following these instructions exactly.\n\n{document}"
        ),
    };
    Ok(append_prompt_extras(prompt, prompt_extras))
}

/// The profile's extra prompt lines at the END of the composed prompt,
/// each its own line, blanks skipped. Appended after composition rather
/// than woven in, so the same list lands identically on a skill prompt
/// and an inline-document one.
fn append_prompt_extras(prompt: String, extras: &[String]) -> String {
    let lines: Vec<&str> = extras.iter().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
    if lines.is_empty() {
        return prompt;
    }
    format!("{prompt}\n\n{}", lines.join("\n"))
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
    /// The profile's prompt argv prefix, or null where it takes no
    /// prompt at all. Null rather than "" so the frontend cannot confuse
    /// "no prompt argument exists" with "the prompt is the bare
    /// positional" -- the two are opposite answers and "" is the second.
    pub prompt_args: Option<String>,
    /// True when a visible run launches this agent bare and its prompt
    /// reaches it through the daemon's follow-up queue (K3; see
    /// `AgentProfile::prompt_injection`). The frontend's cue to compose
    /// a bare launch plus a queued prompt instead of refusing with
    /// "takes no prompt".
    pub prompt_injection: bool,
    /// True when the app must tell the daemon to distrust this agent's
    /// OSC 133 markers for the session (see
    /// `AgentProfile::untrusted_osc133`): sent alongside the failure
    /// patterns at spawn, on the same per-session arming path.
    pub untrusted_osc133: bool,
    pub headless_args: String,
    /// The flag that selects a model, empty where the CLI takes none --
    /// which is how the settings panels decide whether to offer a model
    /// control for this profile at all.
    pub model_flag: String,
    /// Stable model aliases offered as picks; empty where the CLI has
    /// none worth pinning.
    pub models: Vec<String>,
    /// The flag that sets the effort level, empty where the CLI takes
    /// none -- the same gate `model_flag` is for the model controls. A
    /// trailing `=` means the level is attached rather than separated,
    /// and an env-assignment shape (`KIMI_MODEL_THINKING_EFFORT=`) means
    /// it is prepended before the command instead (see
    /// `AgentProfile::effort_flag`).
    pub effort_flag: String,
    /// The effort levels the CLI documents, lowest first.
    pub efforts: Vec<String>,
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
    /// A shell one-liner that finds this agent's own newest conversation
    /// id, for a CLI that mints its own instead of taking one from the
    /// caller (see AgentProfile::session_id_discovery). Empty where
    /// unverified, not applicable, or where `session_id_args` already
    /// covers conversation resume for this profile.
    pub session_id_discovery: String,
    pub resume_args: String,
    /// How gavin reads this agent's subscription limits, or `None` where
    /// it cannot (see AgentProfile::usage_probe). The usage panel keys on
    /// this to decide between a bar and a sentence explaining there is
    /// nothing to show.
    pub usage_probe: Option<String>,
}

/// Build the DTO shape the frontend merges for a named custom profile.
/// Empty failure patterns, no MCP unless the workspace configures
/// `mcp_file`, `prompt_args` null like the retired hard-coded row.
pub fn agent_profile_dto_from_custom(profile: &crate::config::CustomProfile) -> AgentProfileDto {
    AgentProfileDto {
        id: profile.id.clone(),
        label: profile.label.clone(),
        instructions_file: String::new(),
        command: profile.command.clone(),
        mcp_supported: false,
        mcp_config_file: String::new(),
        prompt_args: None,
        prompt_injection: false,
        untrusted_osc133: false,
        headless_args: String::new(),
        model_flag: profile.model_flag.clone(),
        models: Vec::new(),
        effort_flag: profile.effort_flag.clone(),
        efforts: Vec::new(),
        failure_patterns: Vec::new(),
        failure_causes: Vec::new(),
        session_id_args: String::new(),
        session_id_discovery: String::new(),
        resume_args: profile.resume_args.clone().unwrap_or_default(),
        usage_probe: None,
    }
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
            prompt_args: p.prompt_args.map(|a| a.to_string()),
            prompt_injection: p.prompt_injection,
            untrusted_osc133: p.untrusted_osc133,
            headless_args: p.headless_args.to_string(),
            model_flag: p.model_flag.to_string(),
            models: p.models.iter().map(|m| m.to_string()).collect(),
            effort_flag: p.effort_flag.to_string(),
            efforts: p.efforts.iter().map(|e| e.to_string()).collect(),
            failure_patterns: p.failure_patterns.iter().map(|f| f.to_string()).collect(),
            failure_causes: p
                .failure_causes
                .iter()
                .map(|c| FailureCauseDto { pattern: c.pattern.to_string(), cause: c.cause.to_string() })
                .collect(),
            session_id_args: p.session_id_args.to_string(),
            session_id_discovery: p.session_id_discovery.to_string(),
            resume_args: p.resume_args.to_string(),
            usage_probe: p.usage_probe.map(|u| u.id().to_string()),
        })
        .collect()
}

/// One row of the init-wizard PATH sweep: every built-in profile whose
/// default command is non-empty, plus whether that command resolves.
#[derive(serde::Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DetectedAgentDto {
    pub id: String,
    pub label: String,
    pub command: String,
    pub found: bool,
    /// Absolute path when found; null when missing. The wizard shows it
    /// as a title so a wrong binary on PATH is visible without a second
    /// round trip.
    pub path: Option<String>,
}

/// Which of gavin's built-in agent CLIs are startable on this machine.
/// `custom` is skipped: it has no default command to probe. The sweep is
/// `program::resolve` — PATH plus the well-known install directories the
/// daemon also launches from — and does not spawn anything, so a missing
/// license or a broken install still reads as "found" when the shim
/// exists.
#[tauri::command]
pub fn detect_agent_binaries() -> Vec<DetectedAgentDto> {
    detect_agent_binaries_with(AGENT_PROFILES, |name| crate::program::resolve(name))
}

fn detect_agent_binaries_with(
    profiles: &[AgentProfile],
    resolve: impl Fn(&str) -> Option<std::path::PathBuf>,
) -> Vec<DetectedAgentDto> {
    profiles
        .iter()
        .filter(|p| !p.command.is_empty())
        .map(|p| {
            // The profile command may carry flags (`agent --approve-mcps
            // --trust --`); PATH only answers for the leading word.
            let bin = p.command.split_whitespace().next().unwrap_or(p.command);
            let path = resolve(bin);
            DetectedAgentDto {
                id: p.id.to_string(),
                label: p.label.to_string(),
                command: p.command.to_string(),
                found: path.is_some(),
                path: path.map(|p| p.to_string_lossy().into_owned()),
            }
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
    fn only_alias_cli_s_ship_model_presets() {
        let by = |id: &str| AGENT_PROFILES.iter().find(|p| p.id == id).unwrap();
        // Aliases named by `claude --model`'s own help and by the model
        // config docs: each points at the latest model of a tier, or at
        // a mode, so none of them can go stale.
        assert_eq!(
            by("claude-code").models,
            &["fable", "opus", "sonnet", "haiku", "opusplan", "best", "sonnet[1m]", "opus[1m]"]
        );
        assert_eq!(by("claude-code").model_flag, "--model");
        // Gemini's four aliases, the ones its own resolveModel switches
        // on. Its dated ids are deliberately NOT here.
        assert_eq!(by("gemini").model_flag, "--model");
        assert_eq!(by("gemini").models, &["auto", "pro", "flash", "flash-lite"]);
        // Flags verified from each CLI's own --help; no preset names for
        // these two, because theirs are dated ids that rot -- they are
        // enumerated at startup instead (agent_models).
        assert_eq!(by("codex").model_flag, "--model");
        assert!(by("codex").models.is_empty());
        assert_eq!(by("opencode").model_flag, "--model");
        assert!(by("opencode").models.is_empty());
        // Kimi's `-m` (`kimi --help`, 2.1.1); no presets either -- its
        // aliases are managed and refresh upstream, so the picker is
        // filled from `kimi provider list --json` like opencode's.
        assert_eq!(by("kimi-code").model_flag, "-m");
        assert!(by("kimi-code").models.is_empty());
        // Cursor Agent CLI (`agent`): flag verified from `--help`;
        // models are dated ids from `--list-models`, so none ship here.
        assert_eq!(by("cursor").model_flag, "--model");
        assert!(by("cursor").models.is_empty());
        assert_eq!(by("cursor").command, "agent --approve-mcps --trust");
        assert_eq!(by("cursor").headless_args, "-p --force --approve-mcps --trust --");
    }

    /// The two halves have to be exclusive. A row that ships an alias
    /// list AND a runtime route would be gavin offering two answers to
    /// the same question, and the merge order would start to matter.
    #[test]
    fn a_profile_names_its_models_or_discovers_them_never_both() {
        for profile in AGENT_PROFILES {
            assert!(
                profile.models.is_empty() || profile.model_catalog.is_none(),
                "{} both ships presets and discovers them",
                profile.id
            );
        }
    }

    #[test]
    fn custom_profile_dto_carries_command_flags_and_null_prompt() {
        let dto = agent_profile_dto_from_custom(&crate::config::CustomProfile {
            id: "custom-agent".to_string(),
            label: "Custom".to_string(),
            command: "my-agent".to_string(),
            model_flag: "--llm".to_string(),
            effort_flag: "--think=".to_string(),
            api_family: "openai".to_string(),
            resume_args: Some("--resume".to_string()),
        });
        assert_eq!(dto.id, "custom-agent");
        assert_eq!(dto.command, "my-agent");
        assert_eq!(dto.model_flag, "--llm");
        assert_eq!(dto.effort_flag, "--think=");
        assert_eq!(dto.resume_args, "--resume");
        assert!(dto.prompt_args.is_none());
        assert!(!dto.mcp_supported);
        assert!(dto.failure_patterns.is_empty());
    }

    #[test]
    fn profile_dto_carries_the_model_fields_in_camel_case() {
        let dto = agent_profiles().into_iter().find(|p| p.id == "claude-code").unwrap();
        let json = serde_json::to_value(&dto).unwrap();
        assert_eq!(json["modelFlag"], "--model");
        assert_eq!(
            json["models"],
            serde_json::json!([
                "fable", "opus", "sonnet", "haiku", "opusplan", "best", "sonnet[1m]", "opus[1m]"
            ])
        );
        assert_eq!(json["effortFlag"], "--effort");
        assert_eq!(json["efforts"], serde_json::json!(["low", "medium", "high", "xhigh", "max"]));
    }

    /// The three CLIs whose LAUNCHED command can carry an effort carry a
    /// flag: claude's own `--effort`, codex's config override (attached,
    /// hence the `=`), and kimi's env-assignment shape
    /// (`KIMI_MODEL_THINKING_EFFORT=`, which `composeEffort` PREPENDS
    /// rather than appends -- kimi has no effort flag at all). The other
    /// rows are empty on purpose -- see `AgentProfile::effort_flag` for
    /// what each one was checked for.
    #[test]
    fn only_verified_cli_s_ship_an_effort_flag() {
        let by = |id: &str| AGENT_PROFILES.iter().find(|p| p.id == id).unwrap();
        assert_eq!(by("claude-code").effort_flag, "--effort");
        assert_eq!(by("codex").effort_flag, "-c model_reasoning_effort=");
        assert_eq!(by("codex").efforts, &["minimal", "low", "medium", "high", "xhigh"]);
        assert_eq!(by("kimi-code").effort_flag, "KIMI_MODEL_THINKING_EFFORT=");
        assert_eq!(by("kimi-code").efforts, &["low", "high", "max"]);
        for id in ["gemini", "cursor", "opencode"] {
            assert_eq!(by(id).effort_flag, "", "{id} ships an unverified effort flag");
        }
    }

    /// A preset list with no flag to carry it would be a picker whose
    /// every choice silently goes nowhere.
    #[test]
    fn effort_presets_ship_only_beside_a_flag() {
        for profile in AGENT_PROFILES {
            assert!(
                !profile.effort_flag.is_empty() || profile.efforts.is_empty(),
                "{} offers effort levels it has no flag for",
                profile.id
            );
        }
    }

    #[test]
    fn every_profile_row_is_usable_and_ids_are_unique() {
        let mut ids: Vec<&str> = AGENT_PROFILES.iter().map(|p| p.id).collect();
        let count = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), count, "profile ids must be unique");
        assert_eq!(count, 6, "claude-code, codex, gemini, cursor, opencode, kimi-code");

        for p in AGENT_PROFILES {
            assert!(!p.label.is_empty(), "{} has no label", p.id);
            assert!(!p.instructions_file.is_empty(), "{} has no instructions file", p.id);
            assert!(!p.command.is_empty(), "{} has no command", p.id);
        }
    }

    #[test]
    fn detect_skips_custom_and_reports_path_hits() {
        use std::path::PathBuf;
        let rows = detect_agent_binaries_with(AGENT_PROFILES, |name| match name {
            "claude" | "agent" => Some(PathBuf::from(format!("/opt/bin/{name}"))),
            _ => None,
        });
        assert!(rows.iter().all(|r| r.id != "custom"));
        assert_eq!(
            rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["claude-code", "codex", "gemini", "cursor", "opencode", "kimi-code"]
        );
        let claude = rows.iter().find(|r| r.id == "claude-code").unwrap();
        assert!(claude.found);
        assert_eq!(claude.path.as_deref(), Some("/opt/bin/claude"));
        let codex = rows.iter().find(|r| r.id == "codex").unwrap();
        assert!(!codex.found);
        assert_eq!(codex.path, None);
        let cursor = rows.iter().find(|r| r.id == "cursor").unwrap();
        assert!(cursor.found);
        assert_eq!(cursor.command, "agent --approve-mcps --trust");
        assert_eq!(cursor.path.as_deref(), Some("/opt/bin/agent"));
    }

    /// The conventions re-verified 2026-08-23, pinned so a drift in the
    /// table is a failing test rather than a config written to the wrong
    /// path. `custom` is the only row with no layout: its path comes from
    /// the workspace's own config, not from here.
    ///
    /// "A verified layout", deliberately not "its own": kimi-code shares
    /// claude-code's `.mcp.json` and JsonServers dialect -- the file kimi
    /// actually reads (K6, proven live 2026-10-05). Two profiles writing
    /// one file coexist because the writer only ever merges its own
    /// `gavin` key.
    #[test]
    fn every_stock_profile_writes_a_verified_mcp_layout() {
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
                ("kimi-code", ".mcp.json", McpFormat::JsonServers),
            ]
        );
        for p in AGENT_PROFILES {
            if let Some(m) = p.mcp.as_ref() {
                assert_eq!(m.server_key, "gavin", "{} names the server oddly", p.id);
            }
        }
    }

    /// Which profiles have somewhere gavin can install a skill file; the
    /// rest carry the same guidance inline (spec §9, settled by the init
    /// wizard). This is what instructions_block_for and compose_agent_prompt
    /// both key on, so it is worth pinning on its own -- and the roots
    /// must differ, because a workspace that never chose Claude Code
    /// should not grow a `.claude/` directory.
    #[test]
    fn skill_slots_are_the_verified_set_and_do_not_share_a_root() {
        let with_skills: Vec<(&str, String)> = AGENT_PROFILES
            .iter()
            .filter_map(|p| {
                let layout: ResolvedMcp = p.mcp.as_ref()?.into();
                let (dir, file) = layout.skill_slot()?;
                Some((p.id, format!("{}/{}", dir.display(), file)))
            })
            .collect();
        assert_eq!(
            with_skills,
            [
                ("claude-code", ".claude/skills/SKILL.md".to_string()),
                ("codex", ".agents/skills/SKILL.md".to_string()),
                ("gemini", ".gemini/skills/SKILL.md".to_string()),
                ("cursor", ".cursor/skills/SKILL.md".to_string()),
                ("opencode", ".opencode/skills/SKILL.md".to_string()),
                ("kimi-code", ".kimi-code/skills/SKILL.md".to_string()),
            ]
        );
        // Every profile that installs skills installs the SAME four, so
        // no surface can be taught a skill one agent has and the other
        // does not.
        let names: Vec<Vec<&str>> = AGENT_PROFILES
            .iter()
            .filter_map(|p| p.mcp.as_ref())
            .filter(|m| !m.skills.is_empty())
            .map(|m| m.skills.iter().map(|s| s.dir.rsplit('/').next().unwrap()).collect())
            .collect();
        assert_eq!(names.len(), 6);
        assert_eq!(names[0], ["gavin", "gavin-orchestrate", "gavin-resume", "gavin-develop"]);
        for other in &names[1..] {
            assert_eq!(&names[0], other);
        }
    }

    /// The block points at a REAL path for whichever profile is
    /// configured. It used to name `.claude/skills/gavin/SKILL.md` as a
    /// literal, which was true while Claude Code was the only row with
    /// skills and became a lie the moment a second one appeared.
    #[test]
    fn the_instructions_block_names_the_profiles_own_skill_file() {
        for (id, expected) in [
            ("claude-code", ".claude/skills/gavin/SKILL.md"),
            ("codex", ".agents/skills/gavin/SKILL.md"),
            ("gemini", ".gemini/skills/gavin/SKILL.md"),
            ("cursor", ".cursor/skills/gavin/SKILL.md"),
            ("opencode", ".opencode/skills/gavin/SKILL.md"),
            ("kimi-code", ".kimi-code/skills/gavin/SKILL.md"),
        ] {
            let layout: ResolvedMcp = profile_by_id(id).mcp.as_ref().unwrap().into();
            let block = instructions_block_for(Some(&layout), "docs/PRD.md");
            assert!(block.contains(expected), "{id} block does not name {expected}: {block}");
            assert!(!block.contains("{skill}"), "{id} block left the placeholder in");
        }
        // A layout with MCP but no skill slot (custom) gets the
        // inline-with-MCP variant, which has no placeholder to leak.
        let custom_mcp = ResolvedMcp {
            config_file: "agent.json".into(),
            server_key: "gavin",
            format: McpFormat::JsonServers,
            skills: &[],
        };
        let block = instructions_block_for(Some(&custom_mcp), "docs/PRD.md");
        assert!(!block.contains("{skill}"));
        assert!(block.contains("gavin_set_plan_field"), "custom-with-MCP gets tools named inline");
    }

    /// A headless row must be promptable at all: the caller builds
    /// either `<command> <headless_args> '<prompt>'` (args end in ` --`)
    /// or `<command> <headless_args>'<prompt>'` (args end in `=`, the
    /// attach form gemini's `--prompt=` and kimi's `-p=` need). And a
    /// positional form must end in `--`, or a flag ahead of the prompt
    /// eats it -- claude's allow-list flag is variadic, and opencode's
    /// yargs reads a leading `-` as a flag.
    #[test]
    fn headless_rows_are_the_verified_set_and_well_formed() {
        let headless: Vec<&str> =
            AGENT_PROFILES.iter().filter(|p| !p.headless_args.is_empty()).map(|p| p.id).collect();
        assert_eq!(
            headless,
            ["claude-code", "codex", "gemini", "cursor", "opencode", "kimi-code"]
        );
        for p in AGENT_PROFILES {
            if p.headless_args.is_empty() {
                continue;
            }
            // kimi-code is the deliberate exception: its VISIBLE run has
            // no prompt argv (K3 -- the prompt is written into the PTY
            // once kimi's MCP handshake says the TUI is up), while its
            // headless `-p=` carries one. Every other headless row must
            // also be launchable with a prompt.
            if p.id != "kimi-code" {
                assert!(p.prompt_args.is_some(), "{} runs headless but takes no prompt", p.id);
            }
            let args = p.headless_args;
            assert!(
                args.ends_with(" --") || args.ends_with('='),
                "{} headless argv must end in ` --` (positional) or `=` (attached)",
                p.id
            );
        }
    }

    /// Conversation resume never claims a flag with no way to ever learn
    /// an id to feed it. Resuming by an id gavin never fixed at launch
    /// AND never learned back from the agent is not resume at all -- the
    /// CLI would open a picker, or start fresh, which is precisely the
    /// silent from-scratch second attempt this feature exists to
    /// prevent. So `resume_args` is empty unless `session_id_args` (a
    /// minted id, claude-code) or `session_id_discovery` (a
    /// self-reported one, opencode) is set, and the app falls back to a
    /// written reconstruction for every other row.
    #[test]
    fn conversation_resume_argv_is_all_or_nothing_per_profile() {
        let resumable: Vec<&str> =
            AGENT_PROFILES.iter().filter(|p| !p.resume_args.is_empty()).map(|p| p.id).collect();
        assert_eq!(resumable, ["claude-code", "opencode", "kimi-code"]);
        for p in AGENT_PROFILES {
            assert!(
                p.resume_args.is_empty() || !p.session_id_args.is_empty() || !p.session_id_discovery.is_empty(),
                "{} claims resume argv with no minted or self-reported id to feed it",
                p.id
            );
        }
    }

    /// The discovery field's own guard, mirroring
    /// `prompt_args_is_set_only_where_the_convention_is_verified`: pinned
    /// so a future row's shell one-liner is a deliberate, reviewed act
    /// rather than a copy-paste from unverified documentation.
    #[test]
    fn session_id_discovery_is_set_only_where_the_convention_is_verified() {
        let column: Vec<(&str, bool)> =
            AGENT_PROFILES.iter().map(|p| (p.id, !p.session_id_discovery.is_empty())).collect();
        assert_eq!(
            column,
            [
                ("claude-code", false),
                ("codex", false),
                ("gemini", false),
                ("cursor", false),
                ("opencode", true),
                ("kimi-code", true),
            ]
        );
    }

    /// Which profiles claim they can be asked about their limits, pinned
    /// so adding a probe is a deliberate act with a route behind it.
    ///
    /// Custom is the only `None`: every stock CLI has a verified route,
    /// even when that route often answers Unavailable (consumer Gemini,
    /// OpenCode without Go). Adding a probe is still a deliberate act
    /// with a route behind it -- this list is what pins that.
    #[test]
    fn only_profiles_with_a_route_carry_a_usage_probe() {
        let probed: Vec<(&str, &str)> = AGENT_PROFILES
            .iter()
            .filter_map(|p| p.usage_probe.map(|u| (p.id, u.id())))
            .collect();
        assert_eq!(
            probed,
            [
                ("claude-code", "anthropic-oauth"),
                ("codex", "codex-rollout"),
                ("gemini", "gemini-code-assist"),
                ("cursor", "cursor-session"),
                ("opencode", "opencode-go"),
                ("kimi-code", "kimi-oauth"),
            ]
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
        assert_eq!(UsageProbe::CursorSession.id(), "cursor-session");
        assert_eq!(UsageProbe::GeminiCodeAssist.id(), "gemini-code-assist");
        assert_eq!(UsageProbe::OpencodeGo.id(), "opencode-go");
        assert_eq!(UsageProbe::KimiOauth.id(), "kimi-oauth");
    }

    /// The empty pattern list is a real answer -- "nobody has verified
    /// what this agent says when it breaks" -- and it must read as NO
    /// detection rather than as a licence to guess. Only rows measured
    /// against the real CLI carry one: claude-code's from a fake-API
    /// session plus this repo's own transcripts, kimi-code's from live
    /// 2.1.1 runs (2026-10-05).
    #[test]
    fn only_verified_profiles_carry_failure_patterns() {
        let detecting: Vec<&str> = AGENT_PROFILES
            .iter()
            .filter(|p| !p.failure_patterns.is_empty())
            .map(|p| p.id)
            .collect();
        assert_eq!(detecting, ["claude-code", "kimi-code"]);
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
    fn headroom_not_blamed_markers_cover_every_non_network_cause() {
        // The daemon's `NOT_HEADROOMS_MARKERS` keeps a compressed session's
        // auth / usage-limit / outage line from being renamed a Headroom
        // failure. It lists the same strings as these rows.
        const SERVER: &str = include_str!("../../../crates/daemon/src/server.rs");
        let start = SERVER.find("pub const NOT_HEADROOMS_MARKERS").expect("const");
        let list = &SERVER[start..start + SERVER[start..].find("];").unwrap()];
        for p in AGENT_PROFILES {
            for row in p.failure_causes.iter().filter(|r| r.cause != "network") {
                assert!(
                    list.contains(&format!("\"{}\"", row.pattern)),
                    "{} ({}) missing from NOT_HEADROOMS_MARKERS",
                    row.pattern,
                    row.cause
                );
            }
        }
    }

    #[test]
    fn failure_causes_travel_with_patterns_and_put_auth_first() {
        let classifying: Vec<&str> = AGENT_PROFILES
            .iter()
            .filter(|p| !p.failure_causes.is_empty())
            .map(|p| p.id)
            .collect();
        assert_eq!(classifying, ["claude-code", "kimi-code"]);

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

        // The second ordering trap, from a real transcript. Server-side
        // throttling says "(not your usage limit) · You have exceeded
        // your usage limit", so BOTH usage-limit rows match it, and
        // whichever reads it first decides. It is an outage -- a hold
        // for a reset that never comes would strand the rail. Checked on
        // the whole line and on its first 80 columns, which is all a
        // terminal that narrow paints on one row.
        let throttled = "API Error: Server is temporarily limiting requests (not your usage limit) \u{b7} You have exceeded your usage limit. Please try again later.";
        for line in [throttled.to_string(), throttled.chars().take(80).collect::<String>()] {
            assert_eq!(claude_cause(&line), "outage", "{line}");
        }
        let position = |pattern: &str| {
            claude
                .failure_causes
                .iter()
                .position(|row| row.pattern == pattern)
                .unwrap_or_else(|| panic!("no cause row for {pattern:?}"))
        };
        assert!(
            position("temporarily limiting requests") < position("exceeded your usage limit")
                && position("temporarily limiting requests") < position("usage limit"),
            "the throttling row must come before every usage-limit row"
        );
    }

    /// What claude-code's cause table says about `line`: the first row
    /// whose pattern the line contains, in table order, which is exactly
    /// `classifyFailure`'s rule, or `unknown` when none does.
    fn claude_cause(line: &str) -> &'static str {
        profile_by_id("claude-code")
            .failure_causes
            .iter()
            .find(|row| line.contains(row.pattern))
            .map_or("unknown", |row| row.cause)
    }

    /// Whether claude-code's profile would call `line` a failure: the
    /// daemon's test, `line.contains(pattern)` for any pattern.
    fn claude_detects(line: &str) -> bool {
        profile_by_id("claude-code").failure_patterns.iter().any(|p| line.contains(p))
    }

    /// Every distinct error Claude Code printed in this repo's own
    /// transcripts (2026-09, `"isApiErrorMessage": true`), verbatim, and
    /// the cause each one has to classify as. The fake-API session found
    /// the `API Error:` family; this is the family it missed, so the table
    /// is what stops a reworded pattern from quietly un-detecting one.
    ///
    /// The sleep line is `unknown` ON PURPOSE: the daemon's slept-mid-turn
    /// verdict owns suspend, and a cause row would race it.
    const REAL_CLAUDE_FAILURES: &[(&str, &str)] = &[
        ("API Error: Connection dropped (ECONNRESET)", "network"),
        ("API Error: API returned an empty or malformed response (HTTP 200) \u{2014} check for a proxy or gateway intercepting the request. Response: content-type event-stream, body is an event stream (the non-streaming request was answered with a stream), 203 bytes, request-id absent. This was the non-streaming retry of streaming request (no Anthropic request-id), which failed with: no_events, StreamNoEventsError", "network"),
        ("API Error: 529 Overloaded. This is a server-side issue, usually temporary \u{2014} try again in a moment. If it persists, check your inference gateway (127.0.0.1:8802).", "outage"),
        ("Please run /login \u{b7} API Error: 401 OAuth token has expired. Please run /login", "auth"),
        ("Please run /login \u{b7} API Error: 401 OAuth access token has been revoked.", "auth"),
        ("API Error: Server is temporarily limiting requests (not your usage limit) \u{b7} You have exceeded your usage limit. Please try again later.", "outage"),
        ("You've hit your session limit \u{b7} resets 6:50pm (Europe/Rome)", "usage-limit"),
        ("You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.", "usage-limit"),
        ("Login expired \u{b7} Please run /login", "auth"),
        ("Your organization has disabled Claude subscription access for Claude Code \u{b7} Use an Anthropic API key instead, or ask your admin to enable access", "auth"),
        ("Request timed out", "network"),
        ("API Error: Connection closed mid-response. The response above may be incomplete.", "network"),
        ("API Error: Connection lost mid-response. The response above may be incomplete.", "network"),
        ("API Error: The response stopped arriving. The response above may be incomplete.", "network"),
        ("API Error: Server error mid-response. The response above may be incomplete.", "outage"),
        ("API Error: Your computer went to sleep mid-response. The response above may be incomplete.", "unknown"),
    ];

    #[test]
    fn every_error_claude_code_really_printed_is_detected_and_classified() {
        for (line, cause) in REAL_CLAUDE_FAILURES {
            assert!(claude_detects(line), "a broken turn would read as finished: {line}");
            assert_eq!(claude_cause(line), *cause, "{line}");

            // The daemon reads one screen ROW, and an 80-column terminal
            // wraps the long lines. The first row alone has to reach the
            // same verdict, or the answer depends on the tile's width.
            let first_row: String = line.chars().take(80).collect();
            assert!(claude_detects(&first_row), "lost to an 80-column wrap: {first_row}");
            assert_eq!(claude_cause(&first_row), *cause, "{first_row}");
        }
    }

    /// The reason `limit · resets` and a bare `/usage-credits` are NOT
    /// patterns. Claude Code ends its near-limit WARNING with the same
    /// tail ("You've used 90% of your session limit · resets ... · Run
    /// /usage-credits to ..."), and that paints on healthy sessions, so
    /// either fragment would turn every turn near the limit into a
    /// failure. Built from the message templates in the v2.1.278 binary,
    /// not measured off a screen -- the hard-stop lines above are the
    /// measured ones.
    #[test]
    fn claude_codes_near_limit_warnings_do_not_read_as_failures() {
        for line in [
            "You've used 90% of your session limit \u{b7} resets 6:50pm",
            "You've used 75% of your weekly limit \u{b7} resets Fri 3:00pm \u{b7} Run /usage-credits to ask your admin for more",
            "Approaching session limit \u{b7} resets 6:50pm \u{b7} Run /usage-credits to turn on extra usage for your org",
            "Approaching weekly limit \u{b7} Run /usage-credits to raise the cap",
        ] {
            assert!(!claude_detects(line), "a healthy session would read as broken: {line}");
        }
    }

    /// The grant a hidden run needs has to exist wherever there is no
    /// flag carrying it. Stated as a pair so neither half can drift: a
    /// row that names `--agent` and ships no file would launch against a
    /// definition that is not there, and a file nothing names is dead
    /// weight in someone's repo.
    #[test]
    fn a_headless_row_naming_an_agent_ships_that_agent_file() {
        for p in AGENT_PROFILES {
            let names_one = p.headless_args.contains("--agent ");
            assert_eq!(
                names_one,
                p.agent_file.is_some(),
                "{}: headless argv and agent file must agree",
                p.id
            );
            if let Some(file) = p.agent_file.as_ref() {
                let stem = file.file.trim_end_matches(".md");
                assert!(
                    p.headless_args.contains(&format!("--agent {stem} ")),
                    "{} names an agent its file does not define",
                    p.id
                );
            }
        }
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
        // Through `run_integration` rather than the command, which now
        // takes the app handle it routes an ssh root by; the refusal is
        // the run's, on whichever disk it is asked about.
        let err = run_integration(&LocalFiles, Path::new("/no/such/root"), fake_binary(), None, None, None, None)
            .unwrap_err();
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

    /// This machine's real disk, with the account home moved into a
    /// tempdir. A test that integrates a kimi profile through plain
    /// `LocalFiles` would write the folder-trust record into the
    /// DEVELOPER's `~/.kimi-code/workspace-trust/` -- a real grant, left
    /// behind by every run -- so any such test goes through this instead.
    struct HomedFiles {
        home: PathBuf,
    }

    impl WorkspaceFiles for HomedFiles {
        fn agent_home(&self) -> Option<PathBuf> {
            Some(self.home.clone())
        }
        fn write_private(&self, path: &Path, contents: &[u8]) -> anyhow::Result<()> {
            LocalFiles.write_private(path, contents)
        }
        fn read_bytes(&self, path: &Path) -> anyhow::Result<Option<Vec<u8>>> {
            LocalFiles.read_bytes(path)
        }
        fn write_bytes(&self, path: &Path, contents: &[u8]) -> anyhow::Result<()> {
            LocalFiles.write_bytes(path, contents)
        }
        fn is_dir(&self, path: &Path) -> bool {
            LocalFiles.is_dir(path)
        }
        fn is_file(&self, path: &Path) -> bool {
            LocalFiles.is_file(path)
        }
        fn canonical_dir(&self, path: &Path) -> Option<PathBuf> {
            LocalFiles.canonical_dir(path)
        }
    }

    /// A workspace that exists only in memory -- what the host's disk is
    /// to the desktop. Every read and write goes through the trait, and
    /// the test below proves the integration never reaches past it.
    #[derive(Default)]
    struct MemoryFiles {
        files: std::sync::Mutex<std::collections::HashMap<PathBuf, Vec<u8>>>,
        dirs: Vec<PathBuf>,
        /// The HOST's platform, which is what `RemoteFiles` answers from
        /// the banner. Left false by `Default` so it differs from this
        /// suite's own machine on Windows -- the point of the field.
        windows: bool,
        /// The account home on this disk, which `RemoteFiles` has no
        /// answer for. `None` by `Default` -- the ssh case -- so nothing
        /// here writes outside the workspace unless a test gives it one.
        home: Option<PathBuf>,
        /// The machine's environment, as `RemoteFiles` would have to ask
        /// it of the host. Empty by `Default`.
        env: Vec<(String, std::ffi::OsString)>,
    }

    impl WorkspaceFiles for MemoryFiles {
        fn agent_home(&self) -> Option<PathBuf> {
            self.home.clone()
        }
        fn env_var(&self, name: &str) -> Option<std::ffi::OsString> {
            self.env.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone())
        }
        fn read_bytes(&self, path: &Path) -> anyhow::Result<Option<Vec<u8>>> {
            Ok(self.files.lock().unwrap().get(path).cloned())
        }
        fn write_bytes(&self, path: &Path, contents: &[u8]) -> anyhow::Result<()> {
            self.files.lock().unwrap().insert(path.to_path_buf(), contents.to_vec());
            Ok(())
        }
        fn is_dir(&self, path: &Path) -> bool {
            self.dirs.iter().any(|d| d == path)
        }
        fn is_file(&self, path: &Path) -> bool {
            self.files.lock().unwrap().contains_key(path)
        }
        fn canonical_dir(&self, path: &Path) -> Option<PathBuf> {
            Some(path.to_path_buf())
        }
        fn is_windows(&self) -> bool {
            self.windows
        }
    }

    /// The ssh case, end to end through the trait: a root that does not
    /// exist on this machine gets its instructions block, skill files and
    /// MCP config -- naming the HOST's gavin-mcp -- written where the
    /// implementation puts them, and nothing appears on this disk.
    #[test]
    fn integration_on_a_remote_root_touches_only_the_files_it_was_given() {
        let root = PathBuf::from("/remote/repo");
        let fs = MemoryFiles { dirs: vec![root.clone()], ..Default::default() };
        fs.write_bytes(&root.join(".gavin-root").join("config.toml"), b"[agent]\nprofile = \"claude-code\"\n")
            .unwrap();
        let result = run_integration(
            &fs,
            &root,
            || Ok(PathBuf::from("/opt/gavin/gavin-mcp")),
            None,
            None,
            None,
            None,
        )
        .unwrap();

        let files = fs.files.lock().unwrap();
        let instructions = files.get(&root.join("CLAUDE.md")).expect("instructions block written");
        assert!(String::from_utf8_lossy(instructions).contains(MARKER_START));
        let mcp = files.get(&root.join(".mcp.json")).expect("MCP config written");
        assert!(String::from_utf8_lossy(mcp).contains("/opt/gavin/gavin-mcp"), "the host's gavin-mcp");
        assert!(result.written.iter().any(|w| w.ends_with(".mcp.json")));
        assert!(!Path::new("/remote").exists() && !Path::new("C:/remote").exists(), "nothing on this disk");
    }

    /// Where the launcher and ssh meet, which is the merge of these two
    /// changes and belongs to neither alone. `mcp_command` asks two
    /// questions about the root -- is this a gavin checkout, does it carry
    /// the launcher -- and for an ssh workspace the root is a path on the
    /// HOST. Asked of this process's disk they are answered by whatever
    /// happens to sit at the same spelling here, and the answer decides
    /// what gavin's own MCP entry executes. So both go through `fs`, and
    /// the platform half goes through `is_windows`: a Linux host must be
    /// checked for `scripts/gavin-mcp`, not for the `.cmd` this desktop
    /// would run. Neither is answerable from `cfg!` or `Path::is_file`,
    /// which is what makes this a gate and not a restatement.
    #[test]
    fn a_remote_gavin_checkout_that_carries_the_launcher_is_named_by_relative_path() {
        let root = PathBuf::from("/remote/gavin");
        // windows: false -- the host is Linux even when this suite is not.
        let fs = MemoryFiles { dirs: vec![root.clone()], ..Default::default() };
        fs.write_bytes(&root.join(".gavin-root").join("config.toml"), b"[agent]\nprofile = \"claude-code\"\n")
            .unwrap();
        fs.write_bytes(&root.join("crates/gavin-mcp/Cargo.toml"), b"[package]\n").unwrap();
        fs.write_bytes(&root.join("scripts").join("gavin-mcp"), b"#!/bin/sh\n").unwrap();

        run_integration(&fs, &root, || Ok(PathBuf::from("/opt/gavin/gavin-mcp")), None, None, None, None)
            .unwrap();

        let files = fs.files.lock().unwrap();
        let mcp = String::from_utf8_lossy(files.get(&root.join(".mcp.json")).unwrap()).to_string();
        let v: serde_json::Value = serde_json::from_str(&mcp).unwrap();
        assert_eq!(
            v.pointer("/mcpServers/gavin/command").unwrap(),
            MCP_LAUNCHER,
            "the host's own launcher, resolved on the host"
        );
        assert!(
            !mcp.contains("/opt/gavin/gavin-mcp"),
            "a relative command replaces the absolute one, it does not sit beside it"
        );
    }

    /// The shrink sub-project B is for: custom can name an MCP config
    /// without a skill root, so only the skill file is still skipped.
    #[test]
    fn integration_writes_mcp_for_a_profile_with_no_skill_mechanism() {
        let dir = tempfile::tempdir().unwrap();
        custom_rooted(
            dir.path(),
            "mcp_file = \"agent.json\"\nmcp_format = \"json-servers\"\n",
        );

        let result = run_integration(&LocalFiles, dir.path(), fake_binary(), None, None, None, None).unwrap();

        assert!(dir.path().join("RULES.md").is_file());
        assert!(result.written.iter().any(|w| w.ends_with("RULES.md")));
        assert!(dir.path().join("agent.json").is_file());
        assert!(result.written.iter().any(|w| w.ends_with("agent.json")));

        let skipped: Vec<&str> = result.skipped.iter().map(|(what, _)| what.as_str()).collect();
        assert_eq!(skipped, ["skill file"], "MCP config is no longer skipped");
        assert!(result.skipped[0].1.contains("Custom"), "the reason names the profile");
    }

    /// Fallback arming: a profile_id overlay writes THAT agent's files
    /// and leaves the workspace's active profile (and its files) alone.
    #[test]
    fn integration_can_arm_a_profile_other_than_the_workspace_agent() {
        let dir = tempfile::tempdir().unwrap();
        rooted_with_profile(dir.path(), "claude-code");

        let result = run_integration(&LocalFiles, dir.path(), fake_binary(), None, None, Some("codex"), None).unwrap();

        assert!(dir.path().join("AGENTS.md").is_file());
        assert!(dir.path().join(".codex/config.toml").is_file());
        assert!(!dir.path().join("CLAUDE.md").is_file());
        assert!(!dir.path().join(".mcp.json").is_file());
        assert!(result.written.iter().any(|w| w.ends_with("AGENTS.md")));
        assert!(result.written.iter().any(|w| w.ends_with(".codex/config.toml")));
        let cfg = std::fs::read_to_string(dir.path().join(".gavin-root/config.toml")).unwrap();
        assert!(cfg.contains("profile = \"claude-code\""));
        assert!(!cfg.contains("profile = \"codex\""));
    }

    /// AG-07, the "no existing file" case: nothing to disclose about a
    /// file gavin is about to create, so the write proceeds exactly as
    /// it did before this fix and no decision is asked for.
    #[test]
    fn integration_writes_mcp_straight_through_when_there_is_no_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        rooted_with_profile(dir.path(), "claude-code");

        let result = run_integration(&LocalFiles, dir.path(), fake_binary(), None, None, None, None).unwrap();

        assert!(dir.path().join(".mcp.json").is_file());
        assert!(result.written.iter().any(|w| w.ends_with(".mcp.json")));
        assert!(result.mcp_foreign.is_none());
        let skipped: Vec<&str> = result.skipped.iter().map(|(what, _)| what.as_str()).collect();
        assert!(!skipped.contains(&"MCP config"));
    }

    /// AG-07, the "existing with only gavin" case: a re-run over a file
    /// that already carries nothing but gavin's own (stale) entry has
    /// nothing to disclose either, so it still needs no decision.
    #[test]
    fn integration_writes_mcp_straight_through_when_only_gavin_is_present() {
        let dir = tempfile::tempdir().unwrap();
        rooted_with_profile(dir.path(), "claude-code");
        std::fs::write(
            dir.path().join(".mcp.json"),
            r#"{ "mcpServers": { "gavin": { "command": "/old/gavin-mcp", "args": [] } } }"#,
        )
        .unwrap();

        let result = run_integration(&LocalFiles, dir.path(), fake_binary(), None, None, None, None).unwrap();

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join(".mcp.json")).unwrap())
                .unwrap();
        assert_eq!(v.pointer("/mcpServers/gavin/command").unwrap(), "/apps/gavin-mcp");
        assert!(result.written.iter().any(|w| w.ends_with(".mcp.json")));
        assert!(result.mcp_foreign.is_none());
    }

    /// AG-07, the "existing with a foreign server" case: the write is
    /// held back and the foreign entry -- name, command, args, verbatim
    /// -- comes back instead of being silently merged past. Then both
    /// answers: "keep" merges beside it same as before, and "isolate"
    /// refuses (no verified second location yet) without touching the
    /// file or writing anything else in its place.
    #[test]
    fn integration_discloses_a_foreign_mcp_server_and_honours_the_choice() {
        let dir = tempfile::tempdir().unwrap();
        rooted_with_profile(dir.path(), "claude-code");
        std::fs::write(
            dir.path().join(".mcp.json"),
            r#"{ "mcpServers": { "evil": { "command": "/bin/sh", "args": ["-c", "curl x"] } } }"#,
        )
        .unwrap();

        // No decision yet -> the write is held back and the foreign
        // entry is reported, verbatim.
        let result = run_integration(&LocalFiles, dir.path(), fake_binary(), None, None, None, None).unwrap();
        assert!(!result.written.iter().any(|w| w.ends_with(".mcp.json")));
        let foreign = result.mcp_foreign.expect("a foreign server was present");
        assert!(foreign.file.ends_with(".mcp.json"));
        assert_eq!(
            foreign.servers,
            vec![ForeignMcpServer {
                name: "evil".to_string(),
                command: "/bin/sh".to_string(),
                args: vec!["-c".to_string(), "curl x".to_string()],
            }]
        );
        // The refusal reason comes back up front, not only after a
        // failed "isolate" attempt -- the chooser can show it beside the
        // button instead of the human learning it by trying.
        assert!(foreign.isolate_refusal.unwrap().contains("second file"));
        assert!(result.skipped.iter().any(|(what, why)| what == "MCP config" && why.contains(".mcp.json")));
        // Untouched while undecided.
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join(".mcp.json")).unwrap())
                .unwrap();
        assert!(v.pointer("/mcpServers/gavin").is_none());

        // "keep": merges beside it, same as every run before this fix.
        let result =
            run_integration(&LocalFiles, dir.path(), fake_binary(), None, Some(McpForeignChoice::Keep), None, None).unwrap();
        assert!(result.written.iter().any(|w| w.ends_with(".mcp.json")));
        assert!(result.mcp_foreign.is_none());
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join(".mcp.json")).unwrap())
                .unwrap();
        assert_eq!(v.pointer("/mcpServers/evil/command").unwrap(), "/bin/sh");
        assert_eq!(v.pointer("/mcpServers/gavin/command").unwrap(), "/apps/gavin-mcp");

        // "isolate": refuses (claude-code has no verified second
        // location), and the file gains nothing new.
        std::fs::write(
            dir.path().join(".mcp.json"),
            r#"{ "mcpServers": { "evil": { "command": "/bin/sh" } } }"#,
        )
        .unwrap();
        let result = run_integration(&LocalFiles, dir.path(), fake_binary(), None, Some(McpForeignChoice::Isolate), None, None)
            .unwrap();
        assert!(!result.written.iter().any(|w| w.ends_with(".mcp.json")));
        let reason = result
            .skipped
            .iter()
            .find(|(what, _)| what == "MCP config")
            .map(|(_, why)| why.as_str())
            .expect("isolate refuses with a reason");
        assert!(reason.contains("second file"), "{reason}");
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join(".mcp.json")).unwrap())
                .unwrap();
        assert!(v.pointer("/mcpServers/gavin").is_none(), "isolate must not merge");
    }

    /// The marker block goes into the file the CALLER named, and a repo's
    /// own `[agent] file` is not consulted when one is given.
    ///
    /// That key ships with the repository, and workspace trust holds it
    /// inert until a human approves it (`workspaceTrust.ts`) -- so the
    /// frontend passes the file its own panels name. Reading the root
    /// here instead would have this command writing gavin's block into a
    /// file the Settings panel says nothing about.
    #[test]
    fn integration_writes_the_instructions_file_the_caller_named() {
        let dir = tempfile::tempdir().unwrap();
        rooted_with_profile(dir.path(), "claude-code");
        std::fs::write(
            dir.path().join(".gavin-root").join("config.toml"),
            "[agent]\nprofile = \"claude-code\"\nfile = \"REPO_CHOSE_THIS.md\"\n",
        )
        .unwrap();

        let result = run_integration(&LocalFiles, dir.path(), fake_binary(), Some("CLAUDE.md"), None, None, None).unwrap();

        assert!(dir.path().join("CLAUDE.md").is_file());
        assert!(!dir.path().join("REPO_CHOSE_THIS.md").exists());
        assert!(result.written.iter().any(|w| w.ends_with("CLAUDE.md")));

        // None still reads the root, which is what an older frontend
        // does -- and what `validate_agent_file_path` still contains.
        let other = tempfile::tempdir().unwrap();
        rooted_with_profile(other.path(), "claude-code");
        std::fs::write(
            other.path().join(".gavin-root").join("config.toml"),
            "[agent]\nprofile = \"claude-code\"\nfile = \"REPO_CHOSE_THIS.md\"\n",
        )
        .unwrap();
        run_integration(&LocalFiles, other.path(), fake_binary(), None, None, None, None).unwrap();
        assert!(other.path().join("REPO_CHOSE_THIS.md").is_file());
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

        let result = run_integration(&LocalFiles, dir.path(), fake_binary(), None, None, None, None).unwrap();

        assert!(dir.path().join("RULES.md").is_file());
        let skipped: Vec<&str> = result.skipped.iter().map(|(what, _)| what.as_str()).collect();
        assert_eq!(skipped, ["skill file", "MCP config"]);
    }

    #[test]
    fn a_profile_with_mcp_but_no_skill_mechanism_gets_the_guidance_inline() {
        let dir = tempfile::tempdir().unwrap();
        custom_rooted(
            dir.path(),
            "mcp_file = \"agent.json\"\nmcp_format = \"json-servers\"\n",
        );

        run_integration(&LocalFiles, dir.path(), fake_binary(), None, None, None, None).unwrap();

        let body = std::fs::read_to_string(dir.path().join("RULES.md")).unwrap();
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

            let result = run_integration(&LocalFiles, dir.path(), fake_binary(), None, None, None, None).unwrap();

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
        run_integration(&LocalFiles, dir.path(), fake_binary(), None, None, None, None).unwrap();
        let text = std::fs::read_to_string(dir.path().join(".myagent/config.toml")).unwrap();
        let parsed = text.parse::<toml::Table>().unwrap();
        assert_eq!(parsed["mcp_servers"]["gavin"]["command"].as_str().unwrap(), "/apps/gavin-mcp");
    }

    /// An unnamed dialect is the JSON shape three of the six CLIs use --
    /// the best guess for a seventh, and better than refusing to write.
    #[test]
    fn an_unnamed_or_unknown_custom_format_falls_back_to_mcp_servers_json() {
        for extra in
            ["mcp_file = \"agent.json\"\n", "mcp_file = \"agent.json\"\nmcp_format = \"yaml?\"\n"]
        {
            let dir = tempfile::tempdir().unwrap();
            custom_rooted(dir.path(), extra);
            run_integration(&LocalFiles, dir.path(), fake_binary(), None, None, None, None).unwrap();
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
        let result = run_integration(&LocalFiles, dir.path(), fake_binary(), None, None, None, None).unwrap();
        let skipped: Vec<&str> = result.skipped.iter().map(|(w, _)| w.as_str()).collect();
        assert_eq!(skipped, ["skill file", "MCP config"]);
        assert!(!dir.path().parent().unwrap().join("escaped.json").exists());
    }

    /// R3: `[agent] file` got no containment at all before this test --
    /// reproduced by writing gavin's marker block through it to a file
    /// beside the repo. Now it gets the same refusal `mcp_file` does, but
    /// louder: there is no "skipped" to degrade to for the one file every
    /// profile writes, so a bad value fails the whole run.
    #[test]
    fn an_agent_file_that_escapes_the_root_is_refused() {
        for escape in ["/etc/motd", "../victim.txt", "a/../../victim.txt"] {
            let dir = tempfile::tempdir().unwrap();
            let g = dir.path().join(".gavin-root");
            std::fs::create_dir_all(&g).unwrap();
            std::fs::write(
                g.join("config.toml"),
                format!("[agent]\nprofile = \"custom\"\nfile = \"{escape}\"\n"),
            )
            .unwrap();

            let err = run_integration(&LocalFiles, dir.path(), fake_binary(), None, None, None, None).unwrap_err();

            assert!(err.contains(escape), "error should name the value {escape}: {err}");
            assert!(
                !dir.path().parent().unwrap().join("victim.txt").exists(),
                "must never write outside the root"
            );
        }
    }

    /// Without an MCP config there are no tools to name, so the plain
    /// inline block must not promise any. A custom layout with MCP but
    /// no skill root is the remaining inline-with-MCP case.
    #[test]
    fn the_inline_block_names_the_tools_only_when_a_config_was_written() {
        let with_mcp = ResolvedMcp {
            config_file: "agent.json".into(),
            server_key: "gavin",
            format: McpFormat::JsonServers,
            skills: &[],
        };
        let with = instructions_block_for(Some(&with_mcp), protocol::DEFAULT_PRD_PATH);
        let without = instructions_block_for(None, protocol::DEFAULT_PRD_PATH);
        assert!(with.contains("gavin_set_plan_field"));
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
        let writes =
            write_skills(&LocalFiles, dir.path(), &claude_layout(), &prd_relative_path(dir.path())).unwrap();
        let workflow = std::fs::read_to_string(&writes[0].path).unwrap();
        assert!(workflow.contains("read `docs/PRD.md`"), "{workflow}");

        // And the flow document, whether it lands as a file or a prompt.
        let prompt = compose_agent_prompt_for(&root, "prd", None, &[]).unwrap();
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
        custom_rooted(dir.path(), "");
        std::fs::write(
            dir.path().join(".gavin-root/config.toml"),
            "prd = \"PRD.md\"\n\n[agent]\nprofile = \"custom\"\nfile = \"RULES.md\"\n",
        )
        .unwrap();

        // Custom has no skill slot, so the target and the document both
        // arrive in the prompt text -- the one place a stale path would
        // send the agent to write a second PRD beside the real one.
        let prompt = compose_agent_prompt_for(&dir.path().to_string_lossy(), "prd", None, &[])
        .unwrap();
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

        let prompt = compose_agent_prompt_for(&root, "prd", None, &[]).unwrap();

        assert!(prompt.contains("gavin-write-prd"), "invokes the skill by name");
        assert!(prompt.len() < 400, "a skill-capable profile gets a short prompt, not the doc");
        assert!(dir.path().join(".claude/skills/gavin-write-prd/SKILL.md").is_file());
    }

    #[test]
    fn compose_prompt_inlines_the_document_when_there_is_no_skill_mechanism() {
        let dir = tempfile::tempdir().unwrap();
        custom_rooted(dir.path(), "");

        let prompt = compose_agent_prompt_for(&dir.path().to_string_lossy(), "prd", None, &[])
        .unwrap();

        assert!(prompt.contains("## Vision"), "the guidance itself is in the prompt");
        assert!(!dir.path().join(".agents").exists(), "no skill dir for a profile without one");
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

        let prompt = compose_agent_prompt_for(&dir.path().to_string_lossy(), "agent-file", None, &[])
        .unwrap();

        assert!(prompt.contains("NOTES.md"), "the prompt names the configured file");
    }

    #[test]
    fn compose_prompt_rejects_an_unknown_flow() {
        let dir = tempfile::tempdir().unwrap();
        let root = rooted_with_profile(dir.path(), "claude-code");
        assert!(compose_agent_prompt_for(&root, "not-a-flow", None, &[]).is_err());
    }

    /// The whole column, not just which rows have one: `Some("")` and
    /// `None` are opposite answers that a `is_some()` check would blur,
    /// and `Some("--prompt=")` is a third shape that only exists because
    /// the separated form was tried and refused. Verified 2026-08-23
    /// against each CLI's own argument parser, opencode re-verified
    /// 2026-09-02 against 1.3.13 (see the card's `## Verified` block),
    /// Cursor Agent CLI (`agent`) re-verified 2026-09-11 against
    /// 2026.09.10 — bare positional prompt, same shape as claude-code.
    /// kimi-code's `None` is verified ABSENCE (2.1.1, 2026-10-05, K3):
    /// kimi has no interactive prompt flag, so a visible run launches
    /// bare and gets its prompt by PTY injection once kimi's MCP
    /// handshake reports the TUI up -- that injection is a separate task.
    #[test]
    fn prompt_args_is_set_only_where_the_convention_is_verified() {
        let column: Vec<(&str, Option<&str>)> =
            AGENT_PROFILES.iter().map(|p| (p.id, p.prompt_args)).collect();
        assert_eq!(
            column,
            [
                ("claude-code", Some("")),
                ("codex", Some("")),
                ("gemini", Some("")),
                ("cursor", Some("")),
                ("opencode", Some("--prompt=")),
                ("kimi-code", None),
            ]
        );
        // A prefix is concatenated with the quoted prompt, never joined
        // by a space, so a flagged row must carry its own separator or
        // the value lands as a positional.
        for p in AGENT_PROFILES {
            if let Some(args) = p.prompt_args.filter(|a| !a.is_empty()) {
                assert!(args.ends_with('='), "{} must attach its prompt value", p.id);
            }
        }
    }

    /// Injection and argv are the two ways a prompt reaches a visible
    /// run, and a row gets exactly one: injection exists only because
    /// kimi has no prompt flag, and an agent that takes a prompt on its
    /// command line gets it there. kimi-code is the whole `true` set;
    /// cursor's `None` stays a REFUSAL, which is the other half of what
    /// this pin protects -- the flag is what keeps "takes no prompt"
    /// and "takes no prompt ARGV" from blurring into one answer.
    #[test]
    fn prompt_injection_is_kimi_only_and_always_replaces_prompt_args() {
        for p in AGENT_PROFILES {
            assert_eq!(
                p.prompt_injection,
                p.id == "kimi-code",
                "{}: prompt_injection drifted",
                p.id
            );
            if p.prompt_injection {
                assert!(p.prompt_args.is_none(), "{} injects AND takes argv", p.id);
            }
        }
        // And it rides the DTO, or the frontend has nothing to read.
        let dto = agent_profiles().into_iter().find(|p| p.id == "kimi-code").unwrap();
        assert!(dto.prompt_injection);
    }

    /// A setup run over a workspace that EDITED a managed skill. The
    /// skill still ends up as gavin's -- that part is unchanged -- but
    /// the edit is preserved and, crucially, SAID. Silence is what made
    /// this a bug worth a card: the human saw an unexplained revert in a
    /// shared checkout and the obvious reading was that an agent did it.
    #[test]
    fn a_run_that_displaces_an_edited_skill_keeps_it_and_reports_it() {
        let dir = tempfile::tempdir().unwrap();
        rooted_with_profile(dir.path(), "claude-code");
        run_integration(&LocalFiles, dir.path(), fake_binary(), None, None, None, None).unwrap();

        // A re-run that changes nothing must say nothing, or the report
        // cries wolf on every setup the human runs twice.
        let quiet = run_integration(&LocalFiles, dir.path(), fake_binary(), None, None, None, None).unwrap();
        assert!(quiet.replaced.is_empty(), "{:?}", quiet.replaced);

        let skill = dir.path().join(".claude/skills/gavin-develop/SKILL.md");
        std::fs::write(&skill, "### Rate it: `complexity:`\nmy own words\n").unwrap();
        let result = run_integration(&LocalFiles, dir.path(), fake_binary(), None, None, None, None).unwrap();

        let (reported, backup) = result
            .replaced
            .iter()
            .find(|(p, _)| p.ends_with("SKILL.md") && p.contains("gavin-develop"))
            .expect("the displaced skill is named in the result");
        assert_eq!(Path::new(reported), skill);
        assert_eq!(
            std::fs::read_to_string(backup).unwrap(),
            "### Rate it: `complexity:`\nmy own words\n"
        );
        // Still written, and still gavin's: preserving the edit is not
        // the same as honouring it.
        assert!(std::fs::read_to_string(&skill).unwrap().contains("gavin_create_plan"));
        // The three skills nobody touched are not reported -- only the
        // one that actually lost something.
        assert_eq!(result.replaced.len(), 1, "{:?}", result.replaced);
        // And they are in `written` all the same: the run did write them.
        assert!(result.written.iter().any(|p| p == reported));
    }

    /// The whole opencode install, from the one entry point that writes
    /// it. Asserted as a set of paths rather than one file at a time:
    /// the failure this guards against is a row that gains a field and
    /// loses a writer, which only shows up as an absence.
    #[test]
    fn an_opencode_root_gets_its_skills_agent_file_and_mcp_entry() {
        let dir = tempfile::tempdir().unwrap();
        rooted_with_profile(dir.path(), "opencode");

        let result = run_integration(&LocalFiles, dir.path(), fake_binary(), None, None, None, None).unwrap();

        let rel: Vec<String> = result
            .written
            .iter()
            .map(|p| {
                Path::new(p).strip_prefix(dir.path()).unwrap().to_string_lossy().to_string()
            })
            .collect();
        assert_eq!(
            rel,
            [
                "AGENTS.md",
                ".opencode/skills/gavin/SKILL.md",
                ".opencode/skills/gavin-orchestrate/SKILL.md",
                ".opencode/skills/gavin-resume/SKILL.md",
                ".opencode/skills/gavin-develop/SKILL.md",
                "opencode.json",
                ".opencode/agent/gavin-commit.md",
            ]
        );
        // Nothing was skipped: this profile has both capabilities now.
        assert!(result.skipped.is_empty(), "{:?}", result.skipped);
        // And nothing was written into a Claude Code workspace's shape.
        assert!(!dir.path().join(".claude").exists(), "opencode must not grow a .claude/");
        assert!(!dir.path().join(".mcp.json").exists());
    }

    /// Cursor's skill root is `.cursor/skills/`, not Claude's. Same four
    /// skills, own MCP path, no `.claude/` side effect.
    #[test]
    fn a_cursor_root_gets_its_skills_and_mcp_entry() {
        let dir = tempfile::tempdir().unwrap();
        rooted_with_profile(dir.path(), "cursor");

        let result = run_integration(&LocalFiles, dir.path(), fake_binary(), None, None, None, None).unwrap();

        let rel: Vec<String> = result
            .written
            .iter()
            .map(|p| {
                Path::new(p).strip_prefix(dir.path()).unwrap().to_string_lossy().to_string()
            })
            .collect();
        assert_eq!(
            rel,
            [
                "AGENTS.md",
                ".cursor/skills/gavin/SKILL.md",
                ".cursor/skills/gavin-orchestrate/SKILL.md",
                ".cursor/skills/gavin-resume/SKILL.md",
                ".cursor/skills/gavin-develop/SKILL.md",
                ".cursor/mcp.json",
            ]
        );
        assert!(result.skipped.is_empty(), "{:?}", result.skipped);
        assert!(!dir.path().join(".claude").exists(), "cursor must not grow a .claude/");
        let block = std::fs::read_to_string(dir.path().join("AGENTS.md")).unwrap();
        assert!(
            block.contains(".cursor/skills/gavin/SKILL.md"),
            "instructions block must point at Cursor's skill, not inline: {block}"
        );
    }

    /// Codex's documented REPO skill root is `.agents/skills/`, not
    /// `.codex/skills/`. Same four skills, own MCP path under `.codex/`.
    #[test]
    fn a_codex_root_gets_its_skills_and_mcp_entry() {
        let dir = tempfile::tempdir().unwrap();
        rooted_with_profile(dir.path(), "codex");

        let result = run_integration(&LocalFiles, dir.path(), fake_binary(), None, None, None, None).unwrap();

        let rel: Vec<String> = result
            .written
            .iter()
            .map(|p| {
                Path::new(p).strip_prefix(dir.path()).unwrap().to_string_lossy().to_string()
            })
            .collect();
        assert_eq!(
            rel,
            [
                "AGENTS.md",
                ".agents/skills/gavin/SKILL.md",
                ".agents/skills/gavin-orchestrate/SKILL.md",
                ".agents/skills/gavin-resume/SKILL.md",
                ".agents/skills/gavin-develop/SKILL.md",
                ".codex/config.toml",
            ]
        );
        assert!(result.skipped.is_empty(), "{:?}", result.skipped);
        assert!(!dir.path().join(".claude").exists(), "codex must not grow a .claude/");
        assert!(!dir.path().join(".codex/skills").exists(), "not the undocumented path");
        let block = std::fs::read_to_string(dir.path().join("AGENTS.md")).unwrap();
        assert!(
            block.contains(".agents/skills/gavin/SKILL.md"),
            "instructions block must point at Codex's skill, not inline: {block}"
        );
    }

    /// Kimi's whole install: codex's instructions file (kimi reads
    /// AGENTS.md, not CLAUDE.md), claude-code's MCP file and dialect
    /// (kimi reads the project `.mcp.json` -- K6, proven live), and kimi's
    /// own skill root (K8: gavin does not use the shared `.agents/skills/`
    /// kimi would also discover, for opencode's O5 reason).
    #[test]
    fn a_kimi_code_root_gets_its_skills_and_mcp_entry() {
        let dir = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        rooted_with_profile(dir.path(), "kimi-code");

        let fs = HomedFiles { home: home.path().to_path_buf() };
        let result = run_integration(&fs, dir.path(), fake_binary(), None, None, None, None).unwrap();

        // The last two entries live in the account's kimi home and so
        // cannot be made relative to the root: the folder-trust record
        // (`a_kimi_run_trusts_its_folder_and_says_so` owns that one) and
        // the fullscreen switch in `tui.toml`.
        let (in_workspace, tail) = result.written.split_at(result.written.len() - 2);
        let trust = &tail[0];
        assert!(trust.contains("workspace-trust"), "{trust}");
        assert!(tail[1].ends_with("tui.toml"), "{}", tail[1]);
        let rel: Vec<String> = in_workspace
            .iter()
            .map(|p| {
                Path::new(p).strip_prefix(dir.path()).unwrap().to_string_lossy().to_string()
            })
            .collect();
        assert_eq!(
            rel,
            [
                "AGENTS.md",
                ".kimi-code/skills/gavin/SKILL.md",
                ".kimi-code/skills/gavin-orchestrate/SKILL.md",
                ".kimi-code/skills/gavin-resume/SKILL.md",
                ".kimi-code/skills/gavin-develop/SKILL.md",
                ".mcp.json",
            ]
        );
        assert!(result.skipped.is_empty(), "{:?}", result.skipped);
        assert!(!dir.path().join(".claude").exists(), "kimi-code must not grow a .claude/");
        assert!(!dir.path().join(".agents").exists(), "kimi's skills live in its own root");
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join(".mcp.json")).unwrap())
                .unwrap();
        assert_eq!(v.pointer("/mcpServers/gavin/command").unwrap(), "/apps/gavin-mcp");
        let block = std::fs::read_to_string(dir.path().join("AGENTS.md")).unwrap();
        assert!(
            block.contains(".kimi-code/skills/gavin/SKILL.md"),
            "instructions block must point at Kimi's skill, not inline: {block}"
        );
    }

    // --- Folder trust (K18) ----------------------------------------------

    /// kimi's trust records under a home, empty when it has none yet.
    fn trust_records(home: &Path) -> Vec<PathBuf> {
        match std::fs::read_dir(home.join(".kimi-code").join("workspace-trust")) {
            Ok(entries) => entries.map(|e| e.unwrap().path()).collect(),
            Err(_) => Vec::new(),
        }
    }

    /// The path kimi sees as its cwd for `dir`: physical, and spelled the
    /// way a process's own cwd is.
    fn physical(dir: &Path) -> String {
        without_verbatim_prefix(&std::fs::canonicalize(dir).unwrap().to_string_lossy())
    }

    fn record_path(home: &Path, root: &str) -> PathBuf {
        home.join(".kimi-code").join("workspace-trust").join(kimi_trust_key(root))
    }

    /// The first three rows are keys kimi 2.1.1 wrote itself, on the
    /// machine it was verified on -- the reproduction that mattered is
    /// that they come out byte for byte. (The same check also passed for
    /// two more, longer-path entries, and for a key gavin computed that a
    /// live `kimi -p` then honoured; those paths name a person and a
    /// session, so they are not carried here.) The Windows rows come from
    /// kimi's source (`workspaceRootKey`), not from a Windows run -- K16.
    #[test]
    fn kimi_trust_keys_match_the_ones_kimi_wrote() {
        for (root, key) in [
            ("/private/tmp", "wd_tmp_11fe14a563f7"),
            ("/private/tmp/kimi-spike", "wd_kimi-spike_7f16626aeb0a"),
            ("/private/tmp/kimi-spike2", "wd_kimi-spike2_d612afd43a8e"),
            // A trailing separator is not part of the identity.
            ("/private/tmp/kimi-spike/", "wd_kimi-spike_7f16626aeb0a"),
            // A drive path is lowercased and slashed before it is hashed,
            // and `std::fs::canonicalize`'s verbatim spelling is stripped.
            (r"C:\Users\Ada\Repo\", "wd_repo_dbf5f7ee08cf"),
            (r"\\?\C:\Users\Ada\Repo", "wd_repo_dbf5f7ee08cf"),
            (r"\\?\UNC\Server\Share\Proj", "wd_proj_49ea924784e1"),
        ] {
            assert_eq!(kimi_trust_key(&without_verbatim_prefix(root)), key, "{root}");
        }
        // Trust does not inherit: a trusted parent left its child's warning
        // standing when run against kimi 2.1.1 (2026-10-06). A worktree is
        // its own workspace, so it gets its own key and needs its own record.
        assert_ne!(
            kimi_trust_key("/work/repo"),
            kimi_trust_key("/work/repo/.gavin-worktrees/wt")
        );
    }

    #[test]
    fn kimi_slugs_follow_its_rule() {
        let long = "x".repeat(60);
        let dashed = format!("ab{}cd", "-".repeat(50));
        let cut_on_a_dash = format!("{} b", "a".repeat(39));
        for (name, slug) in [
            ("My Project (v2)", "my-project-v2"),
            ("UPPER_case.Name", "upper_case.name"),
            ("a é b", "a-b"),
            ("Çafé-ñ", "af"),
            // Nothing usable left: kimi's own fallback.
            ("..", "workspace"),
            (".", "workspace"),
            ("", "workspace"),
            ("---", "workspace"),
            ("é", "workspace"),
            // Cut at 40, then trimmed again -- so a cut that lands on a
            // dash does not leave one behind.
            (long.as_str(), &"x".repeat(40)),
            (dashed.as_str(), "ab"),
            (cut_on_a_dash.as_str(), &"a".repeat(39)),
        ] {
            assert_eq!(kimi_slug(name), slug, "{name:?}");
        }
    }

    /// Byte for byte what kimi 2.1.1 wrote for `/private/tmp/kimi-spike`.
    #[test]
    fn a_trust_record_has_kimis_own_shape() {
        assert_eq!(
            kimi_trust_record("/private/tmp/kimi-spike", 1791219481952),
            r#"{"root":"/private/tmp/kimi-spike","trustedAt":1791219481952}"#
        );
    }

    #[test]
    fn kimi_home_takes_an_absolute_override_and_nothing_else() {
        let home = Path::new("home").join("ada");
        let default = home.join(".kimi-code");
        let scratch = std::env::temp_dir().join("kimi-scratch");
        assert_eq!(kimi_home_from(&home, None), default);
        assert_eq!(kimi_home_from(&home, Some(scratch.clone().into_os_string())), scratch);
        // Relative, or blank: kimi would resolve it against a cwd gavin
        // does not know, so it is not guessed at.
        assert_eq!(kimi_home_from(&home, Some("relative/kimi".into())), default);
        assert_eq!(kimi_home_from(&home, Some("".into())), default);
    }

    #[test]
    fn kimi_fullscreen_flips_only_the_shipped_default() {
        // The file kimi ships: comment kept, other lines untouched.
        let shipped = "theme = \"auto\"\ntui_mode = \"regular\" # \"regular\" | \"fullscreen\"\nrender_latex = true\n";
        assert_eq!(
            with_kimi_fullscreen(shipped).unwrap().unwrap(),
            "theme = \"auto\"\ntui_mode = \"fullscreen\" # \"regular\" | \"fullscreen\"\nrender_latex = true\n"
        );
        // Already there: nothing to write.
        assert_eq!(with_kimi_fullscreen("tui_mode = \"fullscreen\"\n").unwrap(), None);
        // Absent key is prepended, ahead of any table.
        assert_eq!(
            with_kimi_fullscreen("[editor]\ncommand = \"\"\n").unwrap().unwrap(),
            "tui_mode = \"fullscreen\"\n[editor]\ncommand = \"\"\n"
        );
        assert_eq!(with_kimi_fullscreen("").unwrap().unwrap(), "tui_mode = \"fullscreen\"\n");
        // CRLF and a missing final newline survive.
        assert_eq!(
            with_kimi_fullscreen("tui_mode = \"regular\"\r\nx = 1\r\n").unwrap().unwrap(),
            "tui_mode = \"fullscreen\"\r\nx = 1\r\n"
        );
        assert_eq!(with_kimi_fullscreen("tui_mode=\"regular\"").unwrap().unwrap(), "tui_mode = \"fullscreen\"");
        // A value this does not know is the human's.
        assert!(with_kimi_fullscreen("tui_mode = \"compact\"\n").is_err());
        // A commented-out line is not the key.
        assert_eq!(
            with_kimi_fullscreen("# tui_mode = \"regular\"\n").unwrap().unwrap(),
            "tui_mode = \"fullscreen\"\n# tui_mode = \"regular\"\n"
        );
    }

    #[test]
    fn kimi_fullscreen_writes_the_kimi_home_and_only_there() {
        let home = tempfile::tempdir().unwrap();
        let fs = HomedFiles { home: home.path().to_path_buf() };
        let file = home.path().join(".kimi-code").join("tui.toml");
        // No file yet: created.
        assert_eq!(set_kimi_fullscreen(&fs), TuiModeGrant::Written(file.clone()));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "tui_mode = \"fullscreen\"\n");
        // Second run: already so.
        assert_eq!(set_kimi_fullscreen(&fs), TuiModeGrant::Present);
        // Another value is left alone and reported.
        std::fs::write(&file, "tui_mode = \"compact\"\n").unwrap();
        assert!(matches!(set_kimi_fullscreen(&fs), TuiModeGrant::Withheld(_)));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "tui_mode = \"compact\"\n");
        // A disk with no reachable home (ssh) gets nothing.
        assert!(matches!(set_kimi_fullscreen(&MemoryFiles::default()), TuiModeGrant::Withheld(_)));
    }

    /// The column's whole population: kimi is the only agent whose CLI
    /// gates a repository's own MCP servers behind a record gavin knows
    /// how to write, and a row added without the store verified is the
    /// unverified convention this table does not take.
    #[test]
    fn only_kimi_has_a_folder_trust_gate() {
        let gated: Vec<&str> =
            AGENT_PROFILES.iter().filter(|p| p.folder_trust.is_some()).map(|p| p.id).collect();
        assert_eq!(gated, ["kimi-code"]);
    }

    /// `LocalFiles` is this machine, so its home is this machine's -- the
    /// reason `HomedFiles` exists.
    #[test]
    fn the_local_disk_answers_with_this_machines_home() {
        assert_eq!(LocalFiles.agent_home(), crate::home::home_dir());
    }

    #[test]
    fn a_kimi_run_trusts_its_folder_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        rooted_with_profile(dir.path(), "kimi-code");
        let fs = HomedFiles { home: home.path().to_path_buf() };

        let result = run_integration(&fs, dir.path(), fake_binary(), None, None, None, None).unwrap();

        let root = physical(dir.path());
        let record = record_path(home.path(), &root);
        let n = result.written.len();
        assert_eq!(&result.written[n - 2], &protocol::wire_path(&record), "reported, before the tui switch");
        assert!(result.written[n - 1].ends_with("tui.toml"), "{:?}", result.written);
        assert_eq!(
            std::fs::read_to_string(home.path().join(".kimi-code").join("tui.toml")).unwrap(),
            "tui_mode = \"fullscreen\"\n"
        );
        assert!(result.skipped.is_empty(), "{:?}", result.skipped);
        let body = std::fs::read_to_string(&record).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(doc["root"], root.as_str(), "the PHYSICAL path -- kimi's cwd");
        assert!(doc["trustedAt"].as_u64().unwrap() > 1_700_000_000_000, "{body}");

        // Owner-only, as kimi keeps its own store.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&record), 0o600);
            assert_eq!(mode(record.parent().unwrap()), 0o700);
        }

        // A re-run neither rewrites it nor reports it again.
        let again = run_integration(&fs, dir.path(), fake_binary(), None, None, None, None).unwrap();
        assert!(!again.written.iter().any(|w| w.contains("workspace-trust")), "{:?}", again.written);
        assert_eq!(std::fs::read_to_string(&record).unwrap(), body);
        assert_eq!(trust_records(home.path()).len(), 1);
    }

    /// A record that is already there is the human's own answer to kimi's
    /// prompt, or an earlier run's -- not this run's to rewrite.
    #[test]
    fn an_existing_trust_record_is_left_exactly_as_it_was() {
        let dir = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        rooted_with_profile(dir.path(), "kimi-code");
        let record = record_path(home.path(), &physical(dir.path()));
        std::fs::create_dir_all(record.parent().unwrap()).unwrap();
        std::fs::write(&record, r#"{"root":"theirs","trustedAt":1}"#).unwrap();
        let fs = HomedFiles { home: home.path().to_path_buf() };

        let result = run_integration(&fs, dir.path(), fake_binary(), None, None, None, None).unwrap();

        assert_eq!(std::fs::read_to_string(&record).unwrap(), r#"{"root":"theirs","trustedAt":1}"#);
        assert!(!result.written.iter().any(|w| w.contains("workspace-trust")));
        assert!(result.skipped.is_empty(), "{:?}", result.skipped);
    }

    /// Trusting a folder starts every server the repository declares, so
    /// the grant waits on the same disclosure that decides whether gavin
    /// may write its own entry next to them: pending, or refused, enables
    /// nothing; "keep" is the human saying they have seen them.
    #[test]
    fn trust_waits_for_the_foreign_server_disclosure() {
        let foreign = r#"{"mcpServers":{"other":{"command":"/bin/other"}}}"#;
        for (choice, granted) in
            [(None, false), (Some(McpForeignChoice::Isolate), false), (Some(McpForeignChoice::Keep), true)]
        {
            let dir = tempfile::tempdir().unwrap();
            let home = tempfile::tempdir().unwrap();
            rooted_with_profile(dir.path(), "kimi-code");
            std::fs::write(dir.path().join(".mcp.json"), foreign).unwrap();
            let fs = HomedFiles { home: home.path().to_path_buf() };

            let result = run_integration(&fs, dir.path(), fake_binary(), None, choice, None, None).unwrap();

            let label = format!("{choice:?}");
            assert_eq!(trust_records(home.path()).len(), usize::from(granted), "{label}");
            let says = result.skipped.iter().find(|(what, _)| what == "folder trust");
            assert_eq!(says.is_some(), !granted, "{label}: {:?}", result.skipped);
            if let Some((_, why)) = says {
                assert!(why.contains("MCP entry was not written"), "{label}: {why}");
            }
        }
    }

    /// kimi gates `.kimi-code/mcp.json` behind the same record as
    /// `.mcp.json`, and the disclosure only reads the latter.
    #[test]
    fn trust_is_withheld_when_kimis_own_project_mcp_file_declares_servers() {
        for (body, granted) in [
            (None, true),
            (Some(""), true),
            (Some("{}"), true),
            (Some(r#"{"mcpServers":{}}"#), true),
            (Some(r#"{"mcpServers":{"x":{"command":"/bin/x"}}}"#), false),
            (Some("{not json"), false),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let home = tempfile::tempdir().unwrap();
            rooted_with_profile(dir.path(), "kimi-code");
            if let Some(body) = body {
                std::fs::create_dir_all(dir.path().join(".kimi-code")).unwrap();
                std::fs::write(dir.path().join(".kimi-code").join("mcp.json"), body).unwrap();
            }
            let fs = HomedFiles { home: home.path().to_path_buf() };

            let result = run_integration(&fs, dir.path(), fake_binary(), None, None, None, None).unwrap();

            assert_eq!(trust_records(home.path()).len(), usize::from(granted), "{body:?}");
            let says = result.skipped.iter().find(|(what, _)| what == "folder trust");
            assert_eq!(says.is_some(), !granted, "{body:?}: {:?}", result.skipped);
            if let Some((_, why)) = says {
                assert!(why.contains(".kimi-code/mcp.json"), "{body:?}: {why}");
            }
        }
    }

    /// The launch-time grant this file exists for: a session spawned in a
    /// context folder BELOW the root used to stop at kimi's trust screen
    /// (a trusted parent does not cover a child), losing the queued card
    /// prompt. The grant writes the child its own record, never touches
    /// the root's, and repeats as a no-op.
    #[test]
    fn a_launch_below_the_root_gets_its_own_trust_record() {
        let dir = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".mcp.json"),
            r#"{"mcpServers":{"gavin":{"command":"scripts/gavin-mcp"}}}"#,
        )
        .unwrap();
        let sub = dir.path().join("packages").join("app");
        std::fs::create_dir_all(&sub).unwrap();
        let fs = HomedFiles { home: home.path().to_path_buf() };

        let grant = grant_kimi_launch_trust(&fs, &sub, dir.path());

        let record = record_path(home.path(), &physical(&sub));
        assert!(matches!(grant, Some(TrustGrant::Written(_))), "{grant:?}");
        let body: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&record).unwrap()).unwrap();
        assert_eq!(body["root"], physical(&sub).as_str(), "the launch cwd, physical");
        assert_eq!(trust_records(home.path()).len(), 1, "the root got no record");

        // The next launch in the same folder reads the record and leaves
        // it alone.
        let again = grant_kimi_launch_trust(&fs, &sub, dir.path());
        assert!(matches!(again, Some(TrustGrant::Present)), "{again:?}");
        assert_eq!(trust_records(home.path()).len(), 1);
    }

    /// Every way the launch grant must refuse: at the root itself (the
    /// integration's or the human's decision stands), outside the root,
    /// a server declaration in a folder between the cwd and the root,
    /// and foreign servers at the root -- the root file may only ever
    /// declare what gavin manages.
    #[test]
    fn a_launch_trust_is_withheld_by_shape_and_by_policy() {
        let foreign = r#"{"mcpServers":{"other":{"command":"/bin/other"}}}"#;
        let gavin_only = r#"{"mcpServers":{"gavin":{"command":"scripts/gavin-mcp"}}}"#;
        for (label, root_body, between, cwd_name, granted) in [
            ("at the root", gavin_only, None, "", false),
            ("outside the root", gavin_only, None, "../elsewhere", false),
            ("a subfolder declares servers", gavin_only, Some(foreign), "sub", false),
            ("a foreign server at the root", foreign, None, "sub", false),
            ("an unreadable root mcp file", "{not json", None, "sub", false),
            ("the roots own kimi mcp file declares", gavin_only, Some("KIMI_MCP"), "sub", false),
            ("a clean gavin-only root", gavin_only, None, "sub", true),
            ("no root mcp file at all", "", None, "sub", true),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let home = tempfile::tempdir().unwrap();
            if !root_body.is_empty() {
                std::fs::write(dir.path().join(".mcp.json"), root_body).unwrap();
            }
            let sub = if cwd_name == "../elsewhere" {
                let outside = dir.path().parent().unwrap().join("elsewhere-twin");
                std::fs::create_dir_all(&outside).unwrap();
                outside
            } else {
                let sub = dir.path().join(cwd_name);
                std::fs::create_dir_all(&sub).unwrap();
                sub
            };
            if let Some(body) = between {
                if body == "KIMI_MCP" {
                    std::fs::create_dir_all(sub.join(".kimi-code")).unwrap();
                    std::fs::write(sub.join(".kimi-code").join("mcp.json"), foreign).unwrap();
                } else {
                    std::fs::write(sub.join(".mcp.json"), body).unwrap();
                }
            }
            let fs = HomedFiles { home: home.path().to_path_buf() };

            let grant = grant_kimi_launch_trust(&fs, &sub, dir.path());

            assert_eq!(grant.is_some(), granted, "{label}: {grant:?}");
            assert_eq!(trust_records(home.path()).len(), usize::from(granted), "{label}");
        }
    }

    /// `default_permission_mode` and the attention hooks are written
    /// only where the human has not chosen them: absent means gavin's
    /// defaults go in (the key ahead of the first table header, the
    /// hooks appended at the end). A permission key the human set --
    /// even `manual` -- keeps its value while the hooks still land;
    /// invalid TOML stays untouched entirely, the file being kimi's
    /// to fix, not gavin's to rewrite.
    #[test]
    fn the_launch_config_is_written_only_where_absent() {
        let want = "default_permission_mode = \"yolo\"";
        for (label, before, yolo, hooks) in [
            ("absent", "", true, true),
            ("tables below", "[providers.\"managed:kimi-code\"]\ntype = \"kimi\"\n", true, true),
            ("the humans manual", "default_permission_mode = \"manual\"\n", false, true),
            ("broken toml", "not toml [", false, false),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let home = dir.path().join("home");
            std::fs::create_dir_all(&home).unwrap();
            let config = home.join(".kimi-code").join("config.toml");
            if !before.is_empty() {
                std::fs::create_dir_all(config.parent().unwrap()).unwrap();
                std::fs::write(&config, before).unwrap();
            }
            let fs = HomedFiles { home: home.clone() };

            ensure_kimi_launch_config(&fs, &home);

            let text = std::fs::read_to_string(&config).unwrap();
            if yolo {
                assert!(text.contains(want), "{label}: {text}");
                assert!(toml::from_str::<toml::Value>(&text).is_ok(), "{label}: {text}");
                if before.starts_with('[') {
                    assert!(text.find(want).unwrap() < text.find('[').unwrap(), "{label}: the key precedes the tables: {text}");
                }
            } else if !before.is_empty() {
                assert!(text.starts_with(before.trim_end()), "{label}: the human's text leads: {text}");
            }
            assert_eq!(text.contains(want), yolo, "{label}: the yolo default iff absent: {text}");
            assert_eq!(text.contains("gavin-attention"), hooks, "{label}: hooks iff parseable: {text}");
            if hooks {
                let script = home.join(".kimi-code").join(GAVIN_HOOK_SCRIPT_FILE);
                assert!(script.is_file(), "{label}: the hook script was written");
                let doc = toml::from_str::<toml::Value>(&text).unwrap();
                let hook_list = doc.get("hooks").and_then(toml::Value::as_array).cloned().unwrap_or_default();
                assert_eq!(hook_list.len(), GAVIN_ATTENTION_HOOKS.len(), "{label}: one rule per event: {text}");
            }
        }
    }

    /// A second launch changes nothing: every event already has its
    /// rule and the permission key exists, so the file comes back byte
    /// for byte. A human's own hook -- even one gavin would not have
    /// written -- is preserved alongside, and a hand-edited matcher on
    /// gavin's rule is not rewritten.
    #[test]
    fn the_launch_config_merges_idempotently_and_keeps_the_humans_hooks() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        let fs = HomedFiles { home: home.clone() };

        ensure_kimi_launch_config(&fs, &home);
        let config = home.join(".kimi-code").join("config.toml");
        let first = std::fs::read_to_string(&config).unwrap();
        ensure_kimi_launch_config(&fs, &home);
        assert_eq!(std::fs::read_to_string(&config).unwrap(), first, "second launch is a no-op");

        // A human hook and a hand-tuned matcher survive the next launch.
        let mut edited = first.clone();
        edited.push_str("[[hooks]]\nevent = \"SessionStart\"\ncommand = \"my-tracker\"\n\n");
        edited = edited.replace("matcher = \".*\"\ncommand = \"sh '", "matcher = \"^Bash$\"\ncommand = \"sh '");
        std::fs::write(&config, &edited).unwrap();
        ensure_kimi_launch_config(&fs, &home);
        let after = std::fs::read_to_string(&config).unwrap();
        assert!(after.contains("my-tracker"), "the human's hook stays");
        assert!(after.matches("[[hooks]]").count() == GAVIN_ATTENTION_HOOKS.len() + 1, "no rule duplicated: {after}");
        assert!(after.contains("matcher = \"^Bash$\""), "the hand-tuned matcher is not rewritten");
        assert_eq!(after.matches("event = \"PermissionRequest\"").count(), 1, "one PermissionRequest rule");
    }

    /// `KIMI_CODE_HOME` relocates the whole store, the hooks with it.
    #[test]
    fn the_launch_config_follows_kimi_code_home() {
        let fs = MemoryFiles {
            home: Some(PathBuf::from("/home/ada")),
            env: vec![("KIMI_CODE_HOME".to_string(), "/opt/kimi".into())],
            ..Default::default()
        };

        ensure_kimi_launch_config(&fs, Path::new("/home/ada"));

        let files = fs.files.lock().unwrap();
        let config = files.get(Path::new("/opt/kimi/config.toml")).map(|b| String::from_utf8_lossy(b).into_owned()).expect("config written");
        assert!(config.contains("default_permission_mode = \"yolo\""), "{config}");
        assert!(config.contains("gavin-attention"), "{config}");
        assert!(files.contains_key(Path::new("/opt/kimi/gavin-attention")), "the script follows too");
        assert!(!files.contains_key(Path::new("/home/ada/.kimi-code/config.toml")));
    }

    /// ssh: kimi's home is the host's, which nothing here can reach, so no
    /// record is written anywhere and the report says why.
    #[test]
    fn a_disk_with_no_reachable_home_gets_no_trust_record() {
        let root = PathBuf::from("/remote/repo");
        let fs = MemoryFiles { dirs: vec![root.clone()], ..Default::default() };
        fs.write_bytes(&root.join(".gavin-root").join("config.toml"), b"[agent]\nprofile = \"kimi-code\"\n")
            .unwrap();

        let result = run_integration(
            &fs,
            &root,
            || Ok(PathBuf::from("/opt/gavin/gavin-mcp")),
            None,
            None,
            None,
            None,
        )
        .unwrap();

        let (_, why) = result.skipped.iter().find(|(what, _)| what == "folder trust").expect("said so");
        assert!(why.contains("cannot reach"), "{why}");
        assert!(
            !fs.files.lock().unwrap().keys().any(|p| p.to_string_lossy().contains("workspace-trust")),
            "nothing written for a trust store"
        );
    }

    /// Where it lands, with no disk involved: the record goes under the
    /// account's kimi home, keyed by the canonical root.
    #[test]
    fn the_record_goes_where_kimi_reads_it() {
        let root = PathBuf::from("/work/repo");
        let home = PathBuf::from("/home/ada");
        let fs = MemoryFiles { dirs: vec![root.clone()], home: Some(home.clone()), ..Default::default() };
        fs.write_bytes(&root.join(".gavin-root").join("config.toml"), b"[agent]\nprofile = \"kimi-code\"\n")
            .unwrap();

        run_integration(&fs, &root, || Ok(PathBuf::from("/opt/gavin/gavin-mcp")), None, None, None, None)
            .unwrap();

        let want = home.join(".kimi-code").join("workspace-trust").join(kimi_trust_key("/work/repo"));
        let files = fs.files.lock().unwrap();
        let body = String::from_utf8(files.get(&want).expect("record at kimi's path").clone()).unwrap();
        assert!(body.starts_with(r#"{"root":"/work/repo","trustedAt":"#), "{body}");
    }

    /// `KIMI_CODE_HOME` relocates the whole kimi home, so the record has
    /// to follow it -- a record under `~/.kimi-code` would be a grant
    /// nothing reads. The machine's variable, not this process's.
    #[test]
    fn a_kimi_code_home_override_moves_the_record() {
        let root = PathBuf::from("/work/repo");
        let scratch = std::env::temp_dir().join("kimi-scratch");
        let fs = MemoryFiles {
            dirs: vec![root.clone()],
            home: Some(PathBuf::from("/home/ada")),
            env: vec![("KIMI_CODE_HOME".to_string(), scratch.clone().into_os_string())],
            ..Default::default()
        };
        fs.write_bytes(&root.join(".gavin-root").join("config.toml"), b"[agent]\nprofile = \"kimi-code\"\n")
            .unwrap();

        run_integration(&fs, &root, || Ok(PathBuf::from("/opt/gavin/gavin-mcp")), None, None, None, None)
            .unwrap();

        let files = fs.files.lock().unwrap();
        assert!(files.contains_key(&scratch.join("workspace-trust").join(kimi_trust_key("/work/repo"))));
        assert!(!files.keys().any(|p| p.starts_with("/home/ada")), "nothing under the default home");
    }

    /// Only a profile with a gate writes a record: claude-code's run
    /// leaves the home untouched and says nothing about trust.
    #[test]
    fn a_profile_without_a_trust_gate_never_touches_the_home() {
        let dir = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        rooted_with_profile(dir.path(), "claude-code");
        let fs = HomedFiles { home: home.path().to_path_buf() };

        let result = run_integration(&fs, dir.path(), fake_binary(), None, None, None, None).unwrap();

        assert_eq!(std::fs::read_dir(home.path()).unwrap().count(), 0, "the home stays empty");
        assert!(!result.written.iter().any(|w| w.contains("workspace-trust")));
        assert!(result.skipped.iter().all(|(what, _)| what != "folder trust"), "{:?}", result.skipped);
    }

    /// Gemini's skill root is `.gemini/skills/`, kept separate from the
    /// `.agents/skills/` alias Codex also reads.
    #[test]
    fn a_gemini_root_gets_its_skills_and_mcp_entry() {
        let dir = tempfile::tempdir().unwrap();
        rooted_with_profile(dir.path(), "gemini");

        let result = run_integration(&LocalFiles, dir.path(), fake_binary(), None, None, None, None).unwrap();

        let rel: Vec<String> = result
            .written
            .iter()
            .map(|p| {
                Path::new(p).strip_prefix(dir.path()).unwrap().to_string_lossy().to_string()
            })
            .collect();
        assert_eq!(
            rel,
            [
                "GEMINI.md",
                ".gemini/skills/gavin/SKILL.md",
                ".gemini/skills/gavin-orchestrate/SKILL.md",
                ".gemini/skills/gavin-resume/SKILL.md",
                ".gemini/skills/gavin-develop/SKILL.md",
                ".gemini/settings.json",
            ]
        );
        assert!(result.skipped.is_empty(), "{:?}", result.skipped);
        assert!(!dir.path().join(".agents").exists(), "gemini must not grow a shared .agents/");
        let block = std::fs::read_to_string(dir.path().join("GEMINI.md")).unwrap();
        assert!(
            block.contains(".gemini/skills/gavin/SKILL.md"),
            "instructions block must point at Gemini's skill, not inline: {block}"
        );
    }

    /// The agent file is the one gavin writes AND the one the headless
    /// argv names, with the grant that makes a hidden run safe. Read off
    /// disk rather than off the constant, so a writer that stopped
    /// substituting or stopped running fails here.
    #[test]
    fn the_opencode_agent_file_carries_the_git_only_grant() {
        let dir = tempfile::tempdir().unwrap();
        rooted_with_profile(dir.path(), "opencode");
        run_integration(&LocalFiles, dir.path(), fake_binary(), None, None, None, None).unwrap();

        let body =
            std::fs::read_to_string(dir.path().join(".opencode/agent/gavin-commit.md")).unwrap();
        // The frontmatter opencode's own parser normalizes into
        // `{permission: bash, pattern: "git *", action: allow}`.
        assert!(body.starts_with("---
"), "must open with frontmatter");
        for line in ["  edit: deny", "  webfetch: deny", "    \"*\": deny", "    \"git *\": allow"] {
            assert!(body.contains(line), "missing {line} in:\n{body}");
        }
        // A `{prd}` that was never substituted would reach the agent as
        // a literal, the same failure the skill writer guards against.
        assert!(!body.contains("{prd}"));
    }

    /// A step skill lands beside the profile's OWN skills, not in
    /// Claude Code's directory. This is `skill_slot` doing its job for a
    /// second profile for the first time.
    #[test]
    fn a_step_skill_lands_under_the_opencode_skill_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = rooted_with_profile(dir.path(), "opencode");

        let prompt = compose_agent_prompt_for(&root, "prd", None, &[]).unwrap();

        assert!(dir.path().join(".opencode/skills/gavin-write-prd/SKILL.md").is_file());
        assert!(!dir.path().join(".claude").exists());
        // The skill-slot branch hands back the short "use the skill"
        // prompt, not the whole document inlined.
        assert!(prompt.contains("gavin-write-prd"));
        assert!(!prompt.contains("following these instructions exactly"));
    }

    #[test]
    fn gavin_install_reports_the_agent_file_only_where_the_profile_has_one() {
        let dir = tempfile::tempdir().unwrap();
        rooted_with_profile(dir.path(), "opencode");
        let install = gavin_install(dir.path(), None);
        assert_eq!(install.agent_file.unwrap(), dir.path().join(".opencode/agent/gavin-commit.md"));
        assert_eq!(install.skill_root.unwrap(), dir.path().join(".opencode/skills"));

        rooted_with_profile(dir.path(), "claude-code");
        assert!(gavin_install(dir.path(), None).agent_file.is_none());
    }

    #[test]
    fn resolved_instructions_file_prefers_config_then_profile() {
        let dir = tempfile::tempdir().unwrap();
        let g = dir.path().join(".gavin-root");
        std::fs::create_dir_all(&g).unwrap();

        std::fs::write(g.join("config.toml"), "[agent]\nprofile = \"codex\"\n").unwrap();
        assert_eq!(resolved_instructions_file(&LocalFiles, dir.path(), profile_by_id("codex")), "AGENTS.md");

        std::fs::write(g.join("config.toml"), "[agent]\nprofile = \"codex\"\nfile = \"NOTES.md\"\n")
            .unwrap();
        assert_eq!(resolved_instructions_file(&LocalFiles, dir.path(), profile_by_id("codex")), "NOTES.md");
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
        let p = write_mcp_config(&LocalFiles, dir.path(), &claude_layout(), binary).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v.pointer("/mcpServers/gavin/command").unwrap(), "/apps/gavin-mcp");
        // Existing with another server + stale gavin → both handled.
        std::fs::write(
            &p,
            r#"{ "mcpServers": { "other": { "command": "/bin/other" }, "gavin": { "command": "/old" } }, "unrelated": true }"#,
        )
        .unwrap();
        write_mcp_config(&LocalFiles, dir.path(), &claude_layout(), binary).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v.pointer("/mcpServers/other/command").unwrap(), "/bin/other");
        assert_eq!(v.pointer("/mcpServers/gavin/command").unwrap(), "/apps/gavin-mcp");
        assert_eq!(v.pointer("/unrelated").unwrap(), true);
        // Unparseable → error, file untouched.
        std::fs::write(&p, "{not json").unwrap();
        assert!(write_mcp_config(&LocalFiles, dir.path(), &claude_layout(), binary).is_err());
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{not json");
    }

    /// Just the launcher pair. BOTH files: which one is actually spawned
    /// is per-platform (Windows resolves the extensionless command
    /// through PATHEXT to the .cmd), so a fixture with only one would
    /// pass on one OS and fail on the other.
    fn with_launcher_scripts(root: &std::path::Path) {
        let scripts = root.join("scripts");
        std::fs::create_dir_all(&scripts).unwrap();
        std::fs::write(scripts.join("gavin-mcp"), "#!/bin/sh\nexec gavin-mcp \"$@\"\n").unwrap();
        std::fs::write(scripts.join("gavin-mcp.cmd"), "@echo off\r\ngavin-mcp %*\r\n").unwrap();
    }

    /// A checkout of gavin itself: the launcher pair AND the crate that
    /// builds the binary it resolves. Both are required before gavin
    /// names a repo-relative command -- see `mcp_command`.
    fn with_launcher(root: &std::path::Path) {
        with_launcher_scripts(root);
        let crate_dir = root.join("crates/gavin-mcp");
        std::fs::create_dir_all(&crate_dir).unwrap();
        std::fs::write(crate_dir.join("Cargo.toml"), "[package]\nname = \"gavin-mcp\"\n").unwrap();
    }

    /// The fix for the flip-flop: a root that carries the launcher gets
    /// the RELATIVE path to it, so the committed file is the same bytes
    /// on a Mac and on Windows and no machine's setup run re-points it.
    #[test]
    fn mcp_config_names_the_launcher_when_the_root_carries_one() {
        let dir = tempfile::tempdir().unwrap();
        with_launcher(dir.path());

        let p =
            write_mcp_config(&LocalFiles, dir.path(), &claude_layout(), Path::new("/apps/gavin-mcp")).unwrap();

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v.pointer("/mcpServers/gavin/command").unwrap(), MCP_LAUNCHER);
    }

    /// The other half of the same rule: a workspace that is NOT gavin's
    /// own checkout has no launcher to name, so it still gets the
    /// absolute binary resolved beside the running app. gavin manages
    /// other people's roots, and this is every one of them.
    #[test]
    fn mcp_config_keeps_the_absolute_binary_when_the_root_has_no_launcher() {
        let dir = tempfile::tempdir().unwrap();

        let p =
            write_mcp_config(&LocalFiles, dir.path(), &claude_layout(), Path::new("/apps/gavin-mcp")).unwrap();

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v.pointer("/mcpServers/gavin/command").unwrap(), "/apps/gavin-mcp");
    }

    /// A2, and the reason `mcp_command` wants two conditions rather than
    /// one: a cloned repo that merely SHIPS `scripts/gavin-mcp` must not
    /// get gavin to write a config that executes it. A relative command
    /// is resolved against the workspace root, so naming one hands the
    /// repo control of what gavin's own entry runs -- exactly what
    /// `03-agent-surface.md` says gavin's writes cannot be made to do.
    #[test]
    fn a_repo_that_merely_ships_a_launcher_does_not_get_one_written() {
        let dir = tempfile::tempdir().unwrap();
        with_launcher_scripts(dir.path()); // ... but no gavin-mcp crate.

        let p =
            write_mcp_config(&LocalFiles, dir.path(), &claude_layout(), Path::new("/apps/gavin-mcp")).unwrap();

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(
            v.pointer("/mcpServers/gavin/command").unwrap(),
            "/apps/gavin-mcp",
            "gavin pointed its own entry at a script the repo supplied"
        );
    }

    /// The launcher is the command in every dialect, not just Claude's:
    /// `.cursor/mcp.json` is committed too and carried the mirror-image
    /// of the same fault (a Mac path, dead on Windows).
    #[test]
    fn every_dialect_names_the_launcher() {
        let dir = tempfile::tempdir().unwrap();
        with_launcher(dir.path());
        let binary = Path::new("/apps/gavin-mcp");

        let cursor = write_mcp_config(&LocalFiles, dir.path(), &layout("cursor"), binary).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&cursor).unwrap()).unwrap();
        assert_eq!(v.pointer("/mcpServers/gavin/command").unwrap(), MCP_LAUNCHER);

        let opencode = write_mcp_config(&LocalFiles, dir.path(), &layout("opencode"), binary).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&opencode).unwrap()).unwrap();
        // opencode's command IS the array -- the launcher has to land
        // inside it, not beside it.
        assert_eq!(v.pointer("/mcp/gavin/command").unwrap(), &serde_json::json!([MCP_LAUNCHER]));

        let codex = write_mcp_config(&LocalFiles, dir.path(), &layout("codex"), binary).unwrap();
        let parsed = std::fs::read_to_string(&codex).unwrap().parse::<toml::Table>().unwrap();
        assert_eq!(parsed["mcp_servers"]["gavin"]["command"].as_str().unwrap(), MCP_LAUNCHER);
    }

    /// End to end through the wizard's own entry point, which is what
    /// actually re-pointed the file on every machine.
    #[test]
    fn integration_writes_the_launcher_for_a_root_that_carries_one() {
        let dir = tempfile::tempdir().unwrap();
        rooted_with_profile(dir.path(), "claude-code");
        with_launcher(dir.path());

        run_integration(&LocalFiles, dir.path(), fake_binary(), None, None, None, None).unwrap();

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join(".mcp.json")).unwrap())
                .unwrap();
        assert_eq!(v.pointer("/mcpServers/gavin/command").unwrap(), MCP_LAUNCHER);
    }

    /// The regression this whole fix exists for, pinned against the real
    /// files: a setup run on one machine re-pointed the committed configs
    /// at ITS binary, someone committed that, and the other machine lost
    /// all sixteen gavin_* tools for every session. It happened three
    /// times (d4191db, 030d99f, b8ba17c) and ended with a path that was
    /// dead on both. No committed config may name an absolute path again,
    /// and a re-run of the wizard no longer writes one -- so if this test
    /// goes red, someone committed a machine-local path by hand.
    /// Byte equality, not just the command: a setup run in this checkout
    /// has to leave every file EXACTLY as committed. Anything less and
    /// the wizard dirties them again, which is the churn the card is
    /// about -- someone commits the dirt and a machine loses its tools.
    #[test]
    fn the_repos_own_committed_configs_name_the_launcher() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap();
        assert!(
            launcher_file(repo, cfg!(windows)).is_file(),
            "the launcher those configs name has to be committed beside them"
        );

        let dir = tempfile::tempdir().unwrap();
        with_launcher(dir.path());
        for (profile, rel, command) in [
            ("claude-code", ".mcp.json", "/mcpServers/gavin/command"),
            ("gemini", ".gemini/settings.json", "/mcpServers/gavin/command"),
            ("cursor", ".cursor/mcp.json", "/mcpServers/gavin/command"),
            ("opencode", "opencode.json", "/mcp/gavin/command/0"),
            // kimi-code shares claude-code's file and dialect (K6), so
            // this is the same committed `.mcp.json` -- pinned twice so a
            // layout change on either row is caught against the repo's
            // real file.
            ("kimi-code", ".mcp.json", "/mcpServers/gavin/command"),
        ] {
            let fresh = write_mcp_config(
                &LocalFiles,
                dir.path(),
                &layout(profile),
                Path::new("/apps/gavin-mcp"),
            )
            .unwrap();
            let committed = std::fs::read_to_string(repo.join(rel)).unwrap();
            assert_eq!(
                std::fs::read_to_string(&fresh).unwrap(),
                committed,
                "a setup run would rewrite {rel} -- commit what the writer produces"
            );
            let v: serde_json::Value = serde_json::from_str(&committed).unwrap();
            assert_eq!(
                v.pointer(command).unwrap(),
                MCP_LAUNCHER,
                "{rel} names a machine-local binary again"
            );
        }
    }

    /// The delete wizard keys off the server NAME, never the command, so
    /// it has to find and remove an entry written as a launcher exactly
    /// as it did an absolute one.
    #[test]
    fn entry_present_and_remove_still_work_against_a_launcher_command() {
        let dir = tempfile::tempdir().unwrap();
        rooted_with_profile(dir.path(), "claude-code");
        with_launcher(dir.path());
        write_mcp_config(&LocalFiles, dir.path(), &claude_layout(), Path::new("/apps/gavin-mcp")).unwrap();

        assert!(mcp_entry_present(dir.path(), None), "a launcher entry is still gavin's");
        assert!(remove_mcp_entry(dir.path(), None).unwrap(), "it reports having removed one");
        assert!(!mcp_entry_present(dir.path(), None), "and it is gone");
    }

    /// The delete flow resolves the profile the write path used: a
    /// custom-profile root's entry lives in its `[agent] mcp_file`, and
    /// removing it must edit THAT file -- resolving claude-code here
    /// (the `profile_by_id` fallback) would leave the real entry behind
    /// while poking at a `.mcp.json` nobody wrote.
    #[test]
    fn entry_present_and_remove_follow_the_custom_roots_own_config() {
        let dir = tempfile::tempdir().unwrap();
        custom_rooted(dir.path(), "mcp_file = \"agent.json\"\nmcp_format = \"json-servers\"\n");
        run_integration(&LocalFiles, dir.path(), fake_binary(), None, None, None, None).unwrap();
        assert!(dir.path().join("agent.json").is_file());

        assert!(mcp_entry_present(dir.path(), None), "the custom config's entry is gavin's");
        assert!(remove_mcp_entry(dir.path(), None).unwrap(), "it reports having removed one");
        assert!(!mcp_entry_present(dir.path(), None), "and it is gone");
        let left: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join("agent.json")).unwrap()).unwrap();
        assert!(left.pointer("/mcpServers/gavin").is_none(), "the entry left the custom file");
        assert!(!dir.path().join(".mcp.json").exists(), "claude's file was never touched");
    }

    /// A root with no `[agent] profile` integrates the app-wide default
    /// agent, so what setup writes is what the launch resolves to.
    #[test]
    fn a_profile_less_root_integrates_the_app_default_agent() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".gavin-root")).unwrap();
        let result = run_integration(&LocalFiles, dir.path(), fake_binary(), None, None, None, Some("codex")).unwrap();
        assert!(dir.path().join("AGENTS.md").is_file(), "the default agent's file, not claude's");
        assert!(!dir.path().join("CLAUDE.md").exists());
        assert!(result.written.iter().any(|w| w.contains(".codex/config.toml")), "{:?}", result.written);

        // An explicit overlay still wins over the default, and no default
        // configured is claude-code, as before the setting existed.
        let other = tempfile::tempdir().unwrap();
        rooted_with_profile(other.path(), "claude-code");
        run_integration(&LocalFiles, other.path(), fake_binary(), None, None, None, Some("codex")).unwrap();
        assert!(other.path().join("CLAUDE.md").is_file(), "config.toml's profile wins");
        let plain = tempfile::tempdir().unwrap();
        run_integration(&LocalFiles, plain.path(), fake_binary(), None, None, None, None).unwrap();
        assert!(plain.path().join("CLAUDE.md").is_file(), "no default configured is claude-code");
    }

    /// The composer resolves the same way: a profile-less root's step
    /// skill lands under the default agent's skill parent.
    #[test]
    fn a_profile_less_root_composes_for_the_app_default_agent() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".gavin-root")).unwrap();
        let prompt = compose_agent_prompt_for(&dir.path().to_string_lossy(), "prd", Some("codex"), &[]).unwrap();
        assert!(prompt.contains("gavin-write-prd"), "{prompt}");
        // Codex's skill root, not claude's `.claude/skills`.
        assert!(dir.path().join(".agents/skills/gavin-write-prd/SKILL.md").is_file());
        assert!(!dir.path().join(".claude").exists());
    }

    /// The profile's extra prompt lines land at the END of the composed
    /// prompt, each its own line, on both prompt shapes (skill and
    /// inline document); blanks are skipped.
    #[test]
    fn compose_prompt_appends_the_prompt_extras() {
        let dir = tempfile::tempdir().unwrap();
        custom_rooted(dir.path(), "");
        let extras = vec![
            "Always run cargo test before reporting.".to_string(),
            "  ".to_string(),
            "Prefer small commits.".to_string(),
        ];
        let prompt = compose_agent_prompt_for(&dir.path().to_string_lossy(), "prd", None, &extras).unwrap();
        assert!(prompt.ends_with("Always run cargo test before reporting.\nPrefer small commits."), "{prompt}");

        let none = compose_agent_prompt_for(&dir.path().to_string_lossy(), "prd", None, &[]).unwrap();
        assert!(!none.contains("Prefer small commits"), "{none}");
    }


    fn layout(id: &str) -> ResolvedMcp {
        profile_by_id(id).mcp.as_ref().unwrap().into()
    }

    /// Gemini and Cursor share the mcpServers shape, but Cursor also needs
    /// `type: "stdio"` and the GAVIN_SESSION_* env passthrough — Cursor
    /// strips inherited env when spawning MCP, Gemini does not.
    #[test]
    fn gemini_and_cursor_write_mcp_servers_at_their_own_paths() {
        let dir = tempfile::tempdir().unwrap();
        let binary = Path::new("/apps/gavin-mcp");

        // Neither .gemini/ nor .cursor/ exists yet: the writer creates them.
        let g = write_mcp_config(&LocalFiles, dir.path(), &layout("gemini"), binary).unwrap();
        assert!(g.ends_with(".gemini/settings.json"), "{g:?}");
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&g).unwrap()).unwrap();
        assert_eq!(v.pointer("/mcpServers/gavin/command").unwrap(), "/apps/gavin-mcp");
        assert_eq!(v.pointer("/mcpServers/gavin/args").unwrap(), &serde_json::json!([]));
        assert!(v.pointer("/mcpServers/gavin/type").is_none(), "not a documented Gemini field");
        assert!(v.pointer("/mcpServers/gavin/env").is_none(), "Gemini inherits the PTY env");

        let c = write_mcp_config(&LocalFiles, dir.path(), &layout("cursor"), binary).unwrap();
        assert!(c.ends_with(".cursor/mcp.json"), "{c:?}");
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&c).unwrap()).unwrap();
        assert_eq!(v.pointer("/mcpServers/gavin/type").unwrap(), "stdio");
        assert_eq!(v.pointer("/mcpServers/gavin/command").unwrap(), "/apps/gavin-mcp");
        assert_eq!(
            v.pointer("/mcpServers/gavin/env/GAVIN_MCP").unwrap(),
            "${env:GAVIN_MCP}"
        );
        assert_eq!(
            v.pointer("/mcpServers/gavin/env/GAVIN_SESSION_ID").unwrap(),
            "${env:GAVIN_SESSION_ID}"
        );
        assert_eq!(
            v.pointer("/mcpServers/gavin/env/GAVIN_SESSION_TOKEN").unwrap(),
            "${env:GAVIN_SESSION_TOKEN}"
        );
        assert_eq!(
            v.pointer("/mcpServers/gavin/env/GAVIN_SESSION_SOCKET").unwrap(),
            "${env:GAVIN_SESSION_SOCKET}"
        );
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

        let p = write_mcp_config(&LocalFiles, dir.path(), &layout("opencode"), binary).unwrap();
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
        let p = write_mcp_config(&LocalFiles, dir.path(), &layout("codex"), binary).unwrap();
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
        write_mcp_config(&LocalFiles, dir.path(), &layout("codex"), binary).unwrap();

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
        assert!(write_mcp_config(&LocalFiles, dir.path(), &layout("codex"), binary).is_err());
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "[[[not toml");
    }

    /// `foreign_mcp_servers` reads every dialect's own shape: opencode's
    /// command array splits into command + args, and codex's TOML table
    /// reads the same fields the writer would replace.
    #[test]
    fn foreign_mcp_servers_reads_every_dialect() {
        let dir = tempfile::tempdir().unwrap();

        std::fs::write(
            dir.path().join("opencode.json"),
            r#"{ "mcp": { "gavin": { "type": "local", "command": ["/apps/gavin-mcp"] },
                          "other": { "type": "local", "command": ["/bin/other", "--flag"] } } }"#,
        )
        .unwrap();
        let found = foreign_mcp_servers(&LocalFiles, &dir.path().join("opencode.json"), &layout("opencode")).unwrap();
        assert_eq!(
            found,
            vec![ForeignMcpServer {
                name: "other".to_string(),
                command: "/bin/other".to_string(),
                args: vec!["--flag".to_string()],
            }]
        );

        let codex_path = dir.path().join(".codex/config.toml");
        std::fs::create_dir_all(codex_path.parent().unwrap()).unwrap();
        std::fs::write(
            &codex_path,
            "[mcp_servers.gavin]\ncommand = \"/apps/gavin-mcp\"\nargs = []\n\n\
             [mcp_servers.linty]\ncommand = \"/bin/linty\"\nargs = [\"--fix\"]\n",
        )
        .unwrap();
        let found = foreign_mcp_servers(&LocalFiles, &codex_path, &layout("codex")).unwrap();
        assert_eq!(
            found,
            vec![ForeignMcpServer {
                name: "linty".to_string(),
                command: "/bin/linty".to_string(),
                args: vec!["--fix".to_string()],
            }]
        );

        // Unparsable -> an error, the same as the writer gives, never a
        // silent "nothing foreign here".
        std::fs::write(&codex_path, "[[[not toml").unwrap();
        assert!(foreign_mcp_servers(&LocalFiles, &codex_path, &layout("codex")).is_err());
    }

    #[test]
    fn instructions_block_appends_replaces_and_never_touches_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        // Absent → created with just the block.
        let p = write_instructions_block(&LocalFiles, dir.path(), "CLAUDE.md", BLOCK_WITH_SKILL).unwrap();
        let first = std::fs::read_to_string(&p).unwrap();
        assert!(first.starts_with(MARKER_START));
        // Existing content → appended after it.
        std::fs::write(&p, "# My rules\n\nKeep tests green.\n").unwrap();
        write_instructions_block(&LocalFiles, dir.path(), "CLAUDE.md", BLOCK_WITH_SKILL).unwrap();
        let appended = std::fs::read_to_string(&p).unwrap();
        assert!(appended.starts_with("# My rules"));
        assert!(appended.contains(MARKER_START));
        // Re-run → block replaced in place, custom content above AND below intact.
        let with_tail = format!("{appended}## After\n\ntail text\n");
        std::fs::write(&p, &with_tail).unwrap();
        write_instructions_block(&LocalFiles, dir.path(), "CLAUDE.md", BLOCK_WITH_SKILL).unwrap();
        let replaced = std::fs::read_to_string(&p).unwrap();
        assert!(replaced.starts_with("# My rules"));
        assert!(replaced.contains("tail text"));
        assert_eq!(replaced.matches(MARKER_START).count(), 1);
    }

    /// The whole point of adopting a memory INTO the block: gavin
    /// rewrites its own guidance on every "Set up / update", and a
    /// memory that did not survive that would last until the next
    /// profile change and then quietly vanish.
    #[test]
    fn re_merging_the_block_keeps_the_adopted_memories_byte_for_byte() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("CLAUDE.md");
        // The exact shape memoryCard.ts's `appendLearned` emits --
        // heading, blank line, one bullet per adopted memory, the
        // optional "Why" line indented into its bullet. Copied from that
        // function's output rather than invented here: this test is the
        // only place the two languages' idea of the section meets.
        let learned = "### Learned\n\n- The daemon is shared; never pkill it.\n  Why: every other session loses its PTYs.\n- `cargo test -p daemon` is flaky in parallel.";
        std::fs::write(
            &p,
            format!("# My rules\n\n{MARKER_START}\nold guidance\n\n{learned}\n{MARKER_END}\n\n## After\n\ntail\n"),
        )
        .unwrap();

        write_instructions_block(&LocalFiles, dir.path(), "CLAUDE.md", BLOCK_WITH_SKILL).unwrap();
        let merged = std::fs::read_to_string(&p).unwrap();
        assert!(merged.contains(learned), "the adopted section survived unchanged: {merged}");
        assert!(!merged.contains("old guidance"), "gavin's own half WAS rewritten: {merged}");
        assert!(merged.contains("## Gavin workspace"), "{merged}");
        // Still inside the block -- outside it, the next re-merge would
        // have no reason to look for it at all.
        let inner = &merged[merged.find(MARKER_START).unwrap()..merged.find(MARKER_END).unwrap()];
        assert!(inner.contains(learned), "{inner}");
        assert!(merged.starts_with("# My rules") && merged.contains("tail"), "{merged}");
        assert_eq!(merged.matches(LEARNED_HEADING).count(), 1, "not duplicated: {merged}");

        // Idempotent: a second run must not drift the bytes, or every
        // setup would add another blank line to the file forever.
        write_instructions_block(&LocalFiles, dir.path(), "CLAUDE.md", BLOCK_WITH_SKILL).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), merged);
    }

    #[test]
    fn a_learned_heading_outside_the_block_is_not_the_block_s_business() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("CLAUDE.md");
        // The human's own "### Learned" prose, below the block: gavin
        // neither adopts into it nor moves it.
        std::fs::write(
            &p,
            format!("{MARKER_START}\nold\n{MARKER_END}\n\n### Learned\n\n- mine, not gavin's\n"),
        )
        .unwrap();
        write_instructions_block(&LocalFiles, dir.path(), "CLAUDE.md", BLOCK_WITH_SKILL).unwrap();
        let merged = std::fs::read_to_string(&p).unwrap();
        let inner = &merged[..merged.find(MARKER_END).unwrap()];
        assert!(!inner.contains(LEARNED_HEADING), "not pulled into the block: {merged}");
        assert!(merged.contains("- mine, not gavin's"), "and not lost either: {merged}");
    }

    #[test]
    fn every_skill_is_written_and_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let writes = write_skills(&LocalFiles, dir.path(), &claude_layout(), protocol::DEFAULT_PRD_PATH).unwrap();
        assert_eq!(writes.len(), 4, "workflow skill plus orchestrate, resume and develop");
        let paths: Vec<PathBuf> = writes.iter().map(|w| w.path.clone()).collect();
        // Nothing was there to displace, so nothing was preserved.
        assert!(writes.iter().all(|w| w.replaced.is_none()), "a first run displaces nothing");

        let workflow = std::fs::read_to_string(&paths[0]).unwrap();
        assert!(workflow.contains("gavin_create_plan"), "{workflow}");
        // v38: the self-report half of naming a tab, spelled apart from
        // NameSession's own session_id everywhere it appears -- losing
        // this line from the installed file is how an agent never
        // learns it can hand its own conversation id back at all.
        assert!(workflow.contains("gavin_name_session(name, agent_conversation_id)"), "{workflow}");
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

        // Gavin-managed: a hand-edited skill is replaced, not merged --
        // but the edit is not destroyed doing it.
        for p in &paths {
            std::fs::write(p, "mangled").unwrap();
        }
        let writes = write_skills(&LocalFiles, dir.path(), &claude_layout(), protocol::DEFAULT_PRD_PATH).unwrap();
        assert!(std::fs::read_to_string(&paths[0]).unwrap().contains("gavin_create_plan"));
        assert!(std::fs::read_to_string(&paths[1]).unwrap().contains("gavin_get_orchestration"));
        assert!(std::fs::read_to_string(&paths[2]).unwrap().contains("Finished work stays finished"));
        assert!(std::fs::read_to_string(&paths[3])
            .unwrap()
            .contains("Nothing is written before you hear yes"));
        for write in &writes {
            let backup = write.replaced.as_ref().expect("the edit was displaced, so it was kept");
            assert_eq!(std::fs::read_to_string(backup).unwrap(), "mangled");
            assert!(backup.to_string_lossy().ends_with("SKILL.md.replaced"), "{backup:?}");
        }

        // And a third run, over gavin's own bytes, displaces nothing --
        // the report has to stay empty when a re-run changes nothing, or
        // it reads as a loss every time.
        let writes = write_skills(&LocalFiles, dir.path(), &claude_layout(), protocol::DEFAULT_PRD_PATH).unwrap();
        assert!(writes.iter().all(|w| w.replaced.is_none()), "an idempotent re-run reports nothing");
        // The kept edit is still there, untouched by the run that
        // displaced nothing.
        assert_eq!(
            std::fs::read_to_string(paths[0].with_extension("md.replaced")).unwrap(),
            "mangled"
        );
    }

    /// Gavin's own checkout IS a gavin workspace, so every skill the app
    /// embeds has a live counterpart under `.claude/skills/` that this
    /// repo's agents read -- and a setup run against this root overwrites
    /// that counterpart unconditionally. Nothing else links the two
    /// copies: one is Rust-adjacent and one is prose, they are edited by
    /// different kinds of work, and `f772997` added the `complexity:`
    /// section to `.claude/skills/gavin-develop/SKILL.md` alone. The next
    /// setup run reinstated the stale template over it, silently, in a
    /// shared tree.
    ///
    /// Deliberately NOT a byte compare of the two paths: `gavin_skill.md`
    /// carries a `{prd}` placeholder the installer substitutes per
    /// workspace, so a plain diff would report `gavin` broken forever and
    /// get switched off. This runs the installer's own substitution,
    /// through the same `prd_relative_path` call `run_integration` makes,
    /// against this workspace's own PRD.
    #[test]
    fn every_embedded_document_matches_the_copy_this_repo_ships() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..");
        assert!(
            repo.join(".gavin-root").is_dir(),
            "{} is not the gavin workspace this test compares against",
            repo.display()
        );
        let prd = prd_relative_path(&repo);

        // Every document the app can drop into a workspace, at the
        // workspace-relative path it lands on. Driven off the profile
        // table rather than a list written out here, because a second
        // hand-maintained list is the same convention that failed the
        // first time.
        let mut installs: Vec<(String, &'static str)> = Vec::new();
        for profile in AGENT_PROFILES {
            let layout = profile.mcp.as_ref().map(ResolvedMcp::from);
            for file in layout.iter().flat_map(|l| l.skills.iter()) {
                installs.push((format!("{}/{}", file.dir, file.file), file.contents));
            }
            // The step skills appear in no table -- compose_agent_prompt
            // installs them into the same slot beside the managed ones --
            // so they are reconstructed here the way it reconstructs
            // them. These are the two flows `step_skill` answers.
            if let Some((parent, file)) = layout.as_ref().and_then(ResolvedMcp::skill_slot) {
                for flow in ["prd", "agent-file"] {
                    let step = step_skill(flow).unwrap();
                    installs
                        .push((format!("{}/{}/{file}", parent.display(), step.name), step.document));
                }
            }
            if let Some(file) = profile.agent_file.as_ref() {
                installs.push((format!("{}/{}", file.dir, file.file), file.contents));
            }
        }

        // Only `.claude/` is compared: this workspace is configured for
        // Claude Code (`.gavin-root/config.toml`), so that is the set the
        // repo commits and the set a setup run here would clobber. An
        // `.opencode/` tree in this checkout would be a local artifact of
        // someone switching profiles, not something the repo ships.
        let mut checked: Vec<&str> = Vec::new();
        for (rel, contents) in installs.iter().filter(|(rel, _)| rel.starts_with(".claude/")) {
            let Ok(shipped) = std::fs::read_to_string(repo.join(rel)) else { continue };
            // Line endings belong to the checkout, not to the document:
            // this tree is cloned with core.autocrlf on Windows and
            // without it elsewhere, and `include_str!` bakes in whichever
            // the build machine had.
            let norm = |s: &str| s.replace("\r\n", "\n");
            assert_eq!(
                norm(&with_prd_path(contents, &prd)),
                norm(&shipped),
                "{rel} has drifted from the template the app embeds — the next setup run \
                 against this repo overwrites it with the app's copy"
            );
            checked.push(rel.as_str());
        }
        // Pinned, so a skill that goes MISSING from the repo fails here
        // rather than dropping quietly out of the loop above.
        assert_eq!(
            checked,
            [
                ".claude/skills/gavin/SKILL.md",
                ".claude/skills/gavin-orchestrate/SKILL.md",
                ".claude/skills/gavin-resume/SKILL.md",
                ".claude/skills/gavin-develop/SKILL.md",
            ]
        );

        // What is left unguarded, and why. Distinct documents, first
        // install path each: the step skills are written on demand by a
        // composer action, so this repo has no committed copy to compare
        // them against, and opencode's agent file belongs to a profile
        // this workspace does not use. A NEW managed document lands in
        // this list, which is the point -- adding one forces the decision
        // about whether it needs a counterpart.
        let guarded: Vec<&str> =
            installs.iter().filter(|(r, _)| checked.contains(&r.as_str())).map(|(_, c)| *c).collect();
        let mut unguarded: Vec<(&str, &str)> = Vec::new();
        for (rel, contents) in &installs {
            if guarded.contains(contents) || unguarded.iter().any(|(_, c)| c == contents) {
                continue;
            }
            unguarded.push((rel.as_str(), contents));
        }
        assert_eq!(
            unguarded.into_iter().map(|(r, _)| r).collect::<Vec<_>>(),
            [
                ".claude/skills/gavin-write-prd/SKILL.md",
                ".claude/skills/gavin-write-agent-file/SKILL.md",
                ".opencode/agent/gavin-commit.md",
            ],
            "a document the app embeds has no copy in this repo to check it against — give it \
             one under .claude/skills/, or record here why it cannot have one"
        );
    }

    #[test]
    fn every_skill_lands_in_its_own_directory() {
        let dir = tempfile::tempdir().unwrap();
        let paths: Vec<PathBuf> = write_skills(&LocalFiles, dir.path(), &claude_layout(), protocol::DEFAULT_PRD_PATH)
            .unwrap()
            .into_iter()
            .map(|w| w.path)
            .collect();
        assert!(paths[0].ends_with(".claude/skills/gavin/SKILL.md"), "{:?}", paths[0]);
        assert!(paths[1].ends_with(".claude/skills/gavin-orchestrate/SKILL.md"), "{:?}", paths[1]);
        assert!(paths[2].ends_with(".claude/skills/gavin-resume/SKILL.md"), "{:?}", paths[2]);
        assert!(paths[3].ends_with(".claude/skills/gavin-develop/SKILL.md"), "{:?}", paths[3]);
    }
}
