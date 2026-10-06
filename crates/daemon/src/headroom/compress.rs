//! Whether a session about to be spawned is compressed, and what makes
//! it so.
//!
//! The decision is the daemon's, made at spawn (spec, "Compressed
//! sessions"). Readiness, the port and the recipes are all daemon facts,
//! and a session another agent spawns over MCP never passes through the
//! app, so deciding anywhere else would split the decision in two with a
//! race between checking readiness and spawning.
//!
//! Both halves are pure. `decide` is a function of the workspace's
//! setting, whether Headroom is ready, and what is being launched; a
//! recipe is a function of the agent, the port, the session id and the
//! command line. Neither reads the clock, the disk or the process
//! table, which is what lets every row of the decision be a unit test.
//! The facts that live on disk -- where the installed Headroom keeps
//! its opencode plugin, the OAuth host Kimi persists -- are looked up
//! by the caller and handed in. So is the one write a launch needs:
//! the caller runs `provision_kimi_credential`, filling the credential
//! slot a routed Kimi derives, from the human's own login.
//!
//! Nothing here is remembered. A resume, a relaunch, a fallback and an
//! auto-resume are all fresh spawns, so each is decided again against
//! Headroom as it is at that moment -- a session is never left pointed
//! at a proxy that has gone because the one before it was.

use super::launch::HOST;
use serde_json::{json, Map, Value};
use std::path::Path;

/// The header that tags a session's requests as Headroom's "project",
/// so `/stats` reports savings per session.
const PROJECT_HEADER: &str = "X-Headroom-Project";

/// The header gavin never sends. It opts a session into mid-turn
/// queueing -- Headroom answers `202 headroom_queued` -- and turns the
/// id into a key that subagents share.
const SESSION_HEADER: &str = "x-headroom-session-id";

/// The variable Claude Code reads extra request headers from, one
/// `Name: Value` per line.
pub const CLAUDE_HEADERS: &str = "ANTHROPIC_CUSTOM_HEADERS";

/// The session a process was launched in, as gavin tells it
/// (`PtySession::spawn`).
const SESSION_ID: &str = "GAVIN_SESSION_ID";

const CLAUDE_BASE_URL: &str = "ANTHROPIC_BASE_URL";
const CLAUDE_TOOL_SEARCH: &str = "ENABLE_TOOL_SEARCH";

/// What the Gemini CLI reads its API endpoint from when it authenticates
/// with an API key. It appends `/v1beta/models/...` to it, so a `/p/<id>`
/// prefix survives.
const GEMINI_BASE_URL: &str = "GOOGLE_GEMINI_BASE_URL";

/// What Codex and every other OpenAI client reads its base URL from.
/// Not enough on its own for current Codex (see `recipe`), and set
/// anyway: it is what the commands Codex runs read.
const OPENAI_BASE_URL: &str = "OPENAI_BASE_URL";

/// What the Kimi Code CLI reads its managed provider's base URL from
/// (verified against 2.1.1: it redirects the OpenAI-compatible chat
/// traffic at runtime). Kimi appends `/chat/completions` to it as-is,
/// so like an OpenAI client it is handed a base that ends in `/v1`.
pub const KIMI_BASE_URL: &str = "KIMI_CODE_BASE_URL";

/// The OAuth host half of Kimi's credential-slot derivation. Setting
/// `KIMI_CODE_BASE_URL` re-derives the slot kimi reads
/// (`kimi_credential_slot`) from this host and the override, so a
/// routed kimi needs it set to the host the human logged in against.
const KIMI_OAUTH_HOST: &str = "KIMI_CODE_OAUTH_HOST";

/// The host kimi's derivation assumes when neither its configuration
/// nor the environment names one.
pub const KIMI_DEFAULT_OAUTH_HOST: &str = "https://auth.kimi.com";

/// Configuration opencode merges over its on-disk files, so a recipe
/// needs no file of its own.
pub const OPENCODE_CONFIG: &str = "OPENCODE_CONFIG_CONTENT";

/// The Codex config key its built-in `openai` provider takes its base
/// URL from.
const CODEX_BASE_URL_KEY: &str = "openai_base_url";

/// Where Headroom's opencode transport plugin sits inside its Python
/// package, as Headroom 0.39.1 ships it
/// (`headroom/providers/opencode/runtime.py`,
/// `headroom_opencode_plugin_path`). Pinned with the version.
pub const OPENCODE_PLUGIN: [&str; 5] =
    ["headroom", "providers", "opencode", "_dist", "entry.opencode.js"];

fn is_stock_profile_id(id: &str) -> bool {
    matches!(id, "claude-code" | "codex" | "gemini" | "cursor" | "opencode" | "kimi-code")
}

/// What is about to be launched, as far as the daemon can tell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Launch<'a> {
    /// The app named the agent profile doing the launching
    /// (`CreateSession`'s `profile_id`).
    Profile(&'a str),
    /// A non-stock profile whose settings name the API it speaks
    /// (`CreateSession`'s `api_family`). A custom agent that names none
    /// is `Profile(id)`: gavin knows nothing of the binary, and
    /// has no recipe for it.
    Custom(ApiFamily),
    /// A command line another agent asked for over MCP
    /// (`SpawnAgentSession`), with nobody's word for what it is.
    Command(&'a str),
    /// No profile: a shell tab, a command tool, a setup script.
    Shell,
}

impl<'a> Launch<'a> {
    /// What a `CreateSession` names. No profile is a shell. A known
    /// `api_family` on a non-stock profile is a custom recipe; stock
    /// built-ins keep their own routes. The retired id `"custom"` still
    /// counts as non-stock during the migration window.
    pub fn requested(profile_id: Option<&'a str>, api_family: Option<&str>) -> Launch<'a> {
        match profile_id {
            None => Launch::Shell,
            Some(id) => {
                if !is_stock_profile_id(id) {
                    if let Some(family) = api_family.and_then(ApiFamily::from_id) {
                        return Launch::Custom(family);
                    }
                }
                Launch::Profile(id)
            }
        }
    }

    /// The agent this launches, or `None` for a launch that is no
    /// agent's.
    pub fn agent(self) -> Option<Agent> {
        match self {
            Launch::Shell => None,
            Launch::Profile(id) => Some(Agent::from_profile(id)),
            Launch::Custom(family) => Some(Agent::Custom(family)),
            Launch::Command(line) => Agent::from_command(line),
        }
    }
}

/// The API a custom agent speaks, which is what routes it: gavin cannot
/// know what the binary is, but a client of either API reads the one
/// variable its API's SDK reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiFamily {
    /// Anthropic's Messages API, routed by `ANTHROPIC_BASE_URL`.
    Anthropic,
    /// OpenAI's API and the ones compatible with it, routed by
    /// `OPENAI_BASE_URL`.
    OpenAi,
}

impl ApiFamily {
    /// The family a setting names. `None` for no family, and for a word
    /// this daemon has not heard of: a newer app's third family is not
    /// one of these two, and routing it as either would be a guess.
    pub fn from_id(id: &str) -> Option<ApiFamily> {
        match id.trim() {
            "anthropic" => Some(ApiFamily::Anthropic),
            "openai" => Some(ApiFamily::OpenAi),
            _ => None,
        }
    }
}

/// The agents gavin knows by name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Agent {
    ClaudeCode,
    Codex,
    Gemini,
    Cursor,
    Opencode,
    Kimi,
    /// The human's own agent, with the API it speaks.
    Custom(ApiFamily),
    /// A profile gavin has no table row for: `custom` with no API
    /// family, and any id a newer app sends that this daemon has not
    /// heard of.
    Other,
}

impl Agent {
    /// The agent a profile id names. The ids are the app's
    /// (`agent_setup.rs`'s `AGENT_PROFILES`).
    pub fn from_profile(id: &str) -> Agent {
        match id {
            "claude-code" => Agent::ClaudeCode,
            "codex" => Agent::Codex,
            "gemini" => Agent::Gemini,
            "cursor" => Agent::Cursor,
            "opencode" => Agent::Opencode,
            "kimi-code" => Agent::Kimi,
            _ => Agent::Other,
        }
    }

    /// The agent a command line launches, or `None` when its first
    /// token is not an agent's binary.
    ///
    /// The first token is what `binary_for` reads for Superpowers; here
    /// it is also matched by its file name, because an MCP spawn carries
    /// no profile and a line can name its binary by path. Anything else
    /// is not an agent launch: a line that opens with `cd`, `npm` or an
    /// assignment is a command that happens to run in a workspace, and
    /// handing it the routing variables is what plain shells are spared.
    pub fn from_command(line: &str) -> Option<Agent> {
        let first = line.split_whitespace().next()?;
        let name = std::path::Path::new(first).file_stem()?.to_str()?;
        match name {
            "claude" => Some(Agent::ClaudeCode),
            "codex" => Some(Agent::Codex),
            "gemini" => Some(Agent::Gemini),
            // `agent` is what Cursor's CLI installs today, and
            // `cursor-agent` what it installed before.
            "agent" | "cursor-agent" => Some(Agent::Cursor),
            "opencode" => Some(Agent::Opencode),
            "kimi" => Some(Agent::Kimi),
            _ => None,
        }
    }
}

/// Why a session in a workspace with compression on is not compressed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    /// Headroom is not answering `/readyz`: not installed, still
    /// starting, or down.
    NotReady,
    /// The agent could be routed and gavin has no recipe for it -- or
    /// has one that this launch gives it nothing to apply to: a Codex
    /// line with no `codex` in it to hand the base URL, an opencode on
    /// a Headroom whose plugin is not where it ships.
    NoRecipe,
    /// The agent cannot be routed at all. Cursor's CLI sends everything
    /// through Cursor's own servers over Cursor's protocol.
    UnsupportedAgent,
    /// A relaunch of a session that broke on Headroom: its agent failed
    /// while Headroom was failing its health check, and auto-resume put
    /// it back without Headroom (`CreateSession.without_headroom`).
    HeadroomFailed,
}

impl Reason {
    /// The word written on the session, and sent to the app.
    pub fn id(self) -> &'static str {
        match self {
            Reason::NotReady => "not-ready",
            Reason::NoRecipe => "no-recipe",
            Reason::UnsupportedAgent => "unsupported-agent",
            Reason::HeadroomFailed => "headroom-failed",
        }
    }
}

/// What routes one agent through Headroom: environment that lasts as
/// long as the process, and no file anywhere (ADR 0007) -- bar the
/// credential copy a routed Kimi needs, which is the caller's write of
/// the human's own login, not a file the recipe carries
/// (`provision_kimi_credential`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Recipe {
    pub env: Vec<(String, String)>,
    /// The line to run in place of the one asked for, when the recipe
    /// has to change it. Only Codex's does: it is the one agent that
    /// cannot be routed by environment alone.
    pub command: Option<String>,
}

impl Recipe {
    fn env(env: Vec<(&str, String)>) -> Recipe {
        Recipe {
            env: env.into_iter().map(|(key, value)| (key.to_string(), value)).collect(),
            command: None,
        }
    }
}

/// What `decide` settled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Compressed(Recipe),
    /// The reason is `None` for a session that was never a candidate: a
    /// workspace with compression off, and a launch that is no agent's.
    Uncompressed(Option<Reason>),
}

impl Decision {
    pub fn compressed(&self) -> bool {
        matches!(self, Decision::Compressed(_))
    }

    pub fn reason(&self) -> Option<Reason> {
        match self {
            Decision::Compressed(_) => None,
            Decision::Uncompressed(reason) => *reason,
        }
    }

    /// What to add to the session's environment. Nothing, unless it is
    /// compressed.
    pub fn env(&self) -> &[(String, String)] {
        match self {
            Decision::Compressed(recipe) => &recipe.env,
            Decision::Uncompressed(_) => &[],
        }
    }

    /// The line to run in place of the one asked for, or `None` to run
    /// that one. Only a compressed Codex has one.
    pub fn command(&self) -> Option<&str> {
        match self {
            Decision::Compressed(recipe) => recipe.command.as_deref(),
            Decision::Uncompressed(_) => None,
        }
    }
}

/// Everything the decision is a function of.
#[derive(Debug, Clone, Copy)]
pub struct Facts<'a> {
    /// The workspace's effective setting, from the daemon's own copy.
    pub workspace_on: bool,
    /// The port Headroom is answering on, or `None` while it is not
    /// ready.
    pub ready_port: Option<u16>,
    pub launch: Launch<'a>,
    pub session_id: &'a str,
    /// The line the session is about to run, which Codex's recipe
    /// changes.
    pub command: Option<&'a str>,
    /// `ANTHROPIC_CUSTOM_HEADERS` as the session would otherwise
    /// inherit it, so the human's own headers are kept.
    pub inherited_headers: Option<&'a str>,
    /// `OPENCODE_CONFIG_CONTENT` as the session would otherwise inherit
    /// it, so the human's own configuration is kept.
    pub inherited_opencode_config: Option<&'a str>,
    /// Where the installed Headroom keeps its opencode transport
    /// plugin, or `None` when it has none there. Only an opencode
    /// launch needs it.
    pub opencode_plugin: Option<&'a Path>,
    /// The launch asked not to be routed through Headroom: a relaunch
    /// of a session that broke on it (`CreateSession.without_headroom`).
    pub without_headroom: bool,
    /// Whether the Gemini CLI would authenticate with an API key
    /// (`gemini_uses_api_key`). Only a Gemini launch reads it.
    pub gemini_api_key: bool,
    /// The OAuth host Kimi's managed provider persists, or
    /// `KIMI_DEFAULT_OAUTH_HOST` when its configuration cannot be read.
    /// Only a Kimi launch reads it.
    pub kimi_oauth_host: &'a str,
}

/// What of the environment decides the Gemini CLI's auth type.
#[derive(Debug, Clone, Copy, Default)]
pub struct GeminiEnv {
    /// `GEMINI_API_KEY` or `GOOGLE_API_KEY` is set and not empty.
    pub api_key: bool,
    /// `GOOGLE_GENAI_USE_VERTEXAI` is `true` or `1`.
    pub vertex: bool,
    /// `GOOGLE_GENAI_USE_GCA` is `true` or `1`.
    pub login: bool,
}

/// The auth type a Gemini settings file selects, or `None` when it
/// selects none. `security.auth.selectedType` is where the CLI keeps it
/// now; the top-level `selectedAuthType` is the older spelling, read
/// only when the new one is absent.
fn gemini_selected_type(settings: &str) -> Option<String> {
    let value: Value = serde_json::from_str(settings).ok()?;
    let new = value.pointer("/security/auth/selectedType").and_then(Value::as_str);
    let old = value.get("selectedAuthType").and_then(Value::as_str);
    new.or(old).map(str::to_string)
}

/// Whether the Gemini CLI, as configured, authenticates with an API key
/// -- the one mode of its two that is routed (`recipe`).
///
/// `settings` are the settings files that apply, highest precedence
/// first (the project's, then the user's). A selected type wins over the
/// environment, which the CLI only consults to pick a mode when none is
/// selected: an API key in the environment does not override a Login
/// with Google the human chose. A file that names no type, or does not
/// parse, defers to the next.
pub fn gemini_uses_api_key(settings: &[&str], env: GeminiEnv) -> bool {
    if let Some(selected) = settings.iter().find_map(|text| gemini_selected_type(text)) {
        return selected == "gemini-api-key";
    }
    env.api_key && !env.vertex && !env.login
}

/// Whether this session is compressed.
///
/// The order is the order of the answers' permanence. A workspace that
/// is off and a launch that is no agent's are not exceptions and carry
/// no reason. An agent that cannot be routed is said before readiness
/// is: "Cursor cannot be compressed" is true tomorrow, and "Headroom
/// was not ready" would send the human to fix something that changes
/// nothing for that session.
///
/// A relaunch without Headroom is said before readiness too, and for the
/// opposite reason: it is an override, and a Headroom that looks ready is
/// exactly the case it overrides. The one that broke the session was
/// answering `/readyz` as well, or had come back by the time the relaunch
/// fired; deciding on readiness would hand the relaunch the proxy it just
/// broke on, and the auto-resume budget with it.
pub fn decide(facts: Facts) -> Decision {
    if !facts.workspace_on {
        return Decision::Uncompressed(None);
    }
    let Some(agent) = facts.launch.agent() else {
        return Decision::Uncompressed(None);
    };
    if let Some(reason) = unroutable(agent) {
        return Decision::Uncompressed(Some(reason));
    }
    if facts.without_headroom {
        return Decision::Uncompressed(Some(Reason::HeadroomFailed));
    }
    let Some(port) = facts.ready_port else {
        return Decision::Uncompressed(Some(Reason::NotReady));
    };
    match recipe(agent, port, &facts) {
        Some(recipe) => Decision::Compressed(recipe),
        None => Decision::Uncompressed(Some(Reason::NoRecipe)),
    }
}

/// Why this agent has no recipe whatever Headroom's state, or `None`
/// when it has one.
fn unroutable(agent: Agent) -> Option<Reason> {
    match agent {
        Agent::ClaudeCode
        | Agent::Codex
        | Agent::Gemini
        | Agent::Opencode
        | Agent::Kimi
        | Agent::Custom(_) => None,
        Agent::Cursor => Some(Reason::UnsupportedAgent),
        Agent::Other => Some(Reason::NoRecipe),
    }
}

/// The recipe for an agent, on a Headroom answering on `port`, or
/// `None` when this launch gives it nothing to apply to.
///
/// Every agent but Claude Code is tagged with a `/p/<id>` prefix on the
/// URL it is given, which Headroom strips and files the request under
/// (`project_policy.split_project_path`); what opencode's plugin
/// reroutes is tagged by the plugin, with the same id.
///
/// **Claude Code.** `ENABLE_TOOL_SEARCH=true` is not decoration: behind
/// a custom base URL Claude Code otherwise loads every tool schema into
/// context (Headroom #746), which spends more than compression saves.
/// The session is tagged through a header rather than a `/p/` prefix
/// because the header is what Claude Code can be given without changing
/// the URL its OAuth login is checked against.
///
/// **Codex.** `OPENAI_BASE_URL` alone does not route current Codex: its
/// built-in `openai` provider takes the base URL only from the config
/// key, and its WebSocket transport ignores the variable. The key goes
/// on the command line (`-c`), the one route that writes no file -- a
/// project's own `config.toml` may not set it anyway -- and the one
/// Codex's own TypeScript SDK takes. The variable is set as well, for
/// whatever Codex runs. A line with no `codex` in it has nowhere to put
/// the flag, and a session marked compressed that is not would be a
/// lie, so it has no recipe.
///
/// **opencode.** Its native `anthropic` and `openai` providers are
/// pointed at Headroom, and Headroom's transport plugin is loaded for
/// everything else: Zen and Go reach Headroom only through the plugin,
/// which patches `fetch`. Without the plugin a Zen session would be
/// marked compressed and send Headroom nothing, so there is no recipe
/// without it.
///
/// **Gemini.** Routed only when the CLI authenticates with an API key,
/// through `GOOGLE_GEMINI_BASE_URL`; the spike (headroom-07) proved that
/// request path reaches Headroom and Google's answer comes back through
/// it. Login with Google has no recipe: its endpoint variable
/// (`CODE_ASSIST_ENDPOINT`) is documented only "for development and
/// testing", Headroom serves `/v1internal` for other Gemini clients, and
/// Google itself now refuses the CLI's individual tier
/// (`UNSUPPORTED_CLIENT`), so a session marked compressed there would not
/// be a session that works.
///
/// **Kimi.** `KIMI_CODE_BASE_URL` alone routes it: against 2.1.1 the
/// variable redirected real chat traffic end-to-end, and kimi appends
/// `/chat/completions` to what it is handed, which is the OpenAI shape
/// `tagged_v1_url` exists for. The OAuth host comes along because the
/// override re-derives the credential slot kimi reads from host and
/// URL together (`kimi_credential_slot`): a user who logged in against
/// another region's host would otherwise be derived a slot that cannot
/// exist. Filling that slot is the one file a launch needs, and it is
/// the caller's write, not the recipe's
/// (`provision_kimi_credential`).
///
/// **Custom.** Whichever variable its API family's SDK reads.
pub fn recipe(agent: Agent, port: u16, facts: &Facts) -> Option<Recipe> {
    let base = base_url(port);
    let session = facts.session_id;
    match agent {
        Agent::ClaudeCode => Some(Recipe::env(vec![
            (CLAUDE_BASE_URL, base),
            (CLAUDE_TOOL_SEARCH, "true".to_string()),
            (CLAUDE_HEADERS, claude_headers(facts.inherited_headers, session)),
        ])),
        Agent::Codex => {
            let url = tagged_v1_url(&base, session);
            let command = with_codex_base_url(facts.command?, &url)?;
            Some(Recipe { command: Some(command), ..Recipe::env(vec![(OPENAI_BASE_URL, url)]) })
        }
        Agent::Opencode => {
            let plugin = facts.opencode_plugin?;
            let config =
                opencode_config(facts.inherited_opencode_config, &base, session, plugin);
            Some(Recipe::env(vec![(OPENCODE_CONFIG, config)]))
        }
        Agent::Gemini if facts.gemini_api_key => {
            Some(Recipe::env(vec![(GEMINI_BASE_URL, tagged_url(&base, session))]))
        }
        Agent::Custom(ApiFamily::Anthropic) => {
            Some(Recipe::env(vec![(CLAUDE_BASE_URL, tagged_url(&base, session))]))
        }
        Agent::Custom(ApiFamily::OpenAi) => {
            Some(Recipe::env(vec![(OPENAI_BASE_URL, tagged_v1_url(&base, session))]))
        }
        Agent::Kimi => Some(Recipe::env(vec![
            (KIMI_BASE_URL, tagged_v1_url(&base, session)),
            (KIMI_OAUTH_HOST, facts.kimi_oauth_host.to_string()),
        ])),
        Agent::Gemini | Agent::Cursor | Agent::Other => None,
    }
}

/// Where a compressed agent sends its model traffic.
pub fn base_url(port: u16) -> String {
    format!("http://{HOST}:{port}")
}

/// `base` with the session's tag on its path.
fn tagged_url(base: &str, session_id: &str) -> String {
    format!("{base}/p/{session_id}")
}

/// The tagged base URL for a client whose own default base URL ends in
/// `/v1` -- OpenAI's, Kimi's managed provider, and the AI SDK providers
/// opencode is built on -- because those clients append only what comes
/// after it.
fn tagged_v1_url(base: &str, session_id: &str) -> String {
    format!("{}/v1", tagged_url(base, session_id))
}

/// The credential slot kimi reads under a given OAuth host and base
/// URL, as 2.1.1 derives it (reproduced byte-exact against a live
/// install's slot): the first 16 hex chars of the SHA-256 of the JSON
/// object `{"oauthHost":…,"baseUrl":…}`, keys in that order. With
/// `KIMI_CODE_BASE_URL` set the URL in the pair is the override, so a
/// routed kimi reads a different slot than the one it logged into.
pub fn kimi_credential_slot(oauth_host: &str, base_url: &str) -> String {
    let json = format!("{{\"oauthHost\":\"{oauth_host}\",\"baseUrl\":\"{base_url}\"}}");
    let digest = ring::digest::digest(&ring::digest::SHA256, json.as_bytes());
    let hex: String = digest.as_ref()[..8].iter().map(|byte| format!("{byte:02x}")).collect();
    format!("kimi-code-env-{hex}")
}

/// What of `~/.kimi-code/config.toml` a compressed Kimi launch reads:
/// the managed provider's persisted OAuth host and base URL, either
/// `None` when the file does not parse or names none -- the defaults
/// stand then.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KimiConfig {
    /// `[providers."managed:kimi-code".oauth] oauth_host`.
    pub oauth_host: Option<String>,
    /// `[providers."managed:kimi-code"] base_url`.
    pub base_url: Option<String>,
}

/// The `KimiConfig` of a config.toml's text.
pub fn kimi_config(text: &str) -> KimiConfig {
    let Ok(config) = toml::from_str::<toml::Value>(text) else { return KimiConfig::default() };
    let Some(provider) = config.get("providers").and_then(|p| p.get("managed:kimi-code")) else {
        return KimiConfig::default();
    };
    KimiConfig {
        oauth_host: provider
            .get("oauth")
            .and_then(|oauth| oauth.get("oauth_host"))
            .and_then(toml::Value::as_str)
            .map(str::to_string),
        base_url: provider.get("base_url").and_then(toml::Value::as_str).map(str::to_string),
    }
}

/// Fills the credential slot a routed kimi will read, from the human's
/// own login.
///
/// With `KIMI_CODE_BASE_URL` set kimi re-derives the slot it reads
/// (`kimi_credential_slot`), and a launch whose derived slot is empty
/// fails authentication exactly as a logged-out kimi does. So the
/// human's existing credential is copied under the derived name. A
/// copy, never a move or an edit: the human's file stays as it is, and
/// an existing derived slot is never overwritten -- kimi may have
/// refreshed the token in it. The source is the slot the persisted
/// configuration itself derives when it names a base URL, else the
/// only `kimi-code-env-*.json` there is; with none, or several to
/// guess between, nothing is written, and the launch fails the way an
/// unauthenticated kimi's does.
pub fn provision_kimi_credential(
    credentials: &Path,
    oauth_host: &str,
    routed_base: &str,
    persisted_base: Option<&str>,
) {
    let target = credentials.join(format!("{}.json", kimi_credential_slot(oauth_host, routed_base)));
    if target.exists() {
        return;
    }
    let persisted = persisted_base
        .map(|base| credentials.join(format!("{}.json", kimi_credential_slot(oauth_host, base))))
        .filter(|path| path.is_file());
    let Some(source) = persisted.or_else(|| only_kimi_credential(credentials)) else { return };
    let _ = std::fs::copy(source, target);
}

/// The single kimi credential file in the directory, or `None` when
/// there are none, or several to guess between.
fn only_kimi_credential(credentials: &Path) -> Option<std::path::PathBuf> {
    let mut files = std::fs::read_dir(credentials).ok()?.filter_map(Result::ok).map(|entry| entry.path()).filter(
        |path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("kimi-code-env-") && name.ends_with(".json"))
        },
    );
    let first = files.next()?;
    files.next().is_none().then_some(first)
}

/// Whether `url` is the tagged URL a recipe gave `session_id`, on any
/// port: the path is what names the session.
fn is_tagged_for(url: &str, session_id: &str) -> bool {
    let Some(rest) = url.trim().strip_prefix(&format!("http://{HOST}:")) else {
        return false;
    };
    let path = rest.trim_start_matches(|c: char| c.is_ascii_digit());
    path.len() < rest.len()
        && (path == format!("/p/{session_id}") || path == format!("/p/{session_id}/v1"))
}

/// A POSIX single-quoted word: exactly `text`, whatever it holds.
fn single_quoted(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

/// `line`, with Codex's base URL handed to every Codex it runs: `-c
/// openai_base_url="<url>"` right after each command word that is the
/// `codex` binary. `None` when it runs no Codex that can be found.
///
/// After the binary rather than at the end, because the end of a line
/// gavin composes is its prompt -- after a `--`, where a flag would be
/// read as prompt text -- and a root flag before any subcommand is one
/// every subcommand takes (`codex -c … exec …`). Every Codex in the
/// line, because a worktree's setup can be chained ahead of the agent,
/// and a line another agent spawned can run two; the session is tagged
/// as one, so both are routed. The value is quoted for the shell so
/// Codex receives it with its TOML quotes on, exactly as its SDK passes
/// it.
fn with_codex_base_url(line: &str, url: &str) -> Option<String> {
    let ends: Vec<usize> = command_words(line)?
        .into_iter()
        .filter(|(_, word)| names_binary(word, "codex"))
        .map(|(end, _)| end)
        .collect();
    if ends.is_empty() {
        return None;
    }
    let flag = format!(" -c {}", single_quoted(&format!("{CODEX_BASE_URL_KEY}=\"{url}\"")));
    let mut out = line.to_string();
    for end in ends.into_iter().rev() {
        out.insert_str(end, &flag);
    }
    Some(out)
}

/// Whether a command word runs the binary called `name`, by path or
/// bare, with or without an extension -- the reading `Agent::from_command`
/// gives a first token.
fn names_binary(word: &str, name: &str) -> bool {
    Path::new(word).file_stem().and_then(|stem| stem.to_str()) == Some(name)
}

/// Where each simple command in a POSIX command line names the program
/// it runs: the byte offset just past that word, and the word as the
/// shell reads it, quotes removed.
///
/// Not a shell parser: enough of one for the lines a session is
/// launched with. Quotes and escapes, so a prompt that mentions `codex`
/// is text; the operators after which a new command starts (`&&`, `||`,
/// `;`, `|`, `&`, a newline, a parenthesis); assignments ahead of a
/// command (`KEY=value codex`); comments.
///
/// What it cannot read it refuses -- `None` for the whole line -- rather
/// than guess, because a guess puts the flag inside a string, a heredoc
/// body or a function's name, and a line whose Codex is only partly
/// routed must not be marked compressed. It refuses an ANSI-C string
/// (`$'…'`, whose `\'` does not end it), a heredoc (`<<`, whose body is
/// text, not commands), a function definition (`name() {`), and a
/// command word that hands the real command to the word after it (`time`,
/// `env`, `nohup`, `exec`, `then`, `{`, `!` and the like). A line
/// without a Codex to route is left alone either way.
fn command_words(line: &str) -> Option<Vec<(usize, String)>> {
    let mut words = Vec::new();
    let mut word: Option<String> = None;
    let mut starts_command = true;
    let mut quote: Option<char> = None;
    let mut chars = line.char_indices().peekable();

    let mut finish = |word: &mut Option<String>, end: usize, starts_command: &mut bool| {
        let Some(value) = word.take() else { return };
        if *starts_command && !is_assignment(&value) {
            words.push((end, value));
            *starts_command = false;
        }
    };

    while let Some((at, c)) = chars.next() {
        match quote {
            Some('\'') => {
                if c == '\'' {
                    quote = None;
                } else {
                    word.get_or_insert_default().push(c);
                }
                continue;
            }
            Some(_) => {
                match c {
                    '"' => quote = None,
                    '\\' => match chars.peek().map(|&(_, next)| next) {
                        Some(next @ ('$' | '`' | '"' | '\\')) => {
                            chars.next();
                            word.get_or_insert_default().push(next);
                        }
                        Some('\n') => {
                            chars.next();
                        }
                        _ => word.get_or_insert_default().push('\\'),
                    },
                    _ => word.get_or_insert_default().push(c),
                }
                continue;
            }
            None => {}
        }
        match c {
            '\\' => match chars.next() {
                Some((_, '\n')) => {}
                Some((_, next)) => word.get_or_insert_default().push(next),
                None => word.get_or_insert_default().push('\\'),
            },
            '$' if chars.peek().is_some_and(|&(_, next)| next == '\'') => return None,
            '<' if chars.peek().is_some_and(|&(_, next)| next == '<') => {
                chars.next();
                // `<<<` is a here-string: one word, no body.
                if chars.peek().is_some_and(|&(_, next)| next == '<') {
                    chars.next();
                    word.get_or_insert_default().push_str("<<<");
                } else {
                    return None;
                }
            }
            '(' if function_definition(&word, starts_command, &mut chars) => return None,
            '\'' | '"' => {
                word.get_or_insert_default();
                quote = Some(c);
            }
            ' ' | '\t' => finish(&mut word, at, &mut starts_command),
            // `2>&1` is a redirection inside a word, not a background
            // operator between two commands.
            '&' if word.as_deref().is_some_and(|w| w.ends_with(['>', '<'])) => {
                word.get_or_insert_default().push(c);
            }
            '\n' | ';' | '&' | '|' | '(' | ')' => {
                finish(&mut word, at, &mut starts_command);
                starts_command = true;
            }
            '#' if word.is_none() => {
                while chars.peek().is_some_and(|&(_, next)| next != '\n') {
                    chars.next();
                }
            }
            _ => word.get_or_insert_default().push(c),
        }
    }
    finish(&mut word, line.len(), &mut starts_command);
    if words.iter().any(|(_, word)| PREFIX_WORDS.contains(&word.as_str())) {
        return None;
    }
    Some(words)
}

/// Command words after which the command that runs is the NEXT word, or
/// a compound's body: not read through, so a line holding one is refused.
const PREFIX_WORDS: [&str; 15] = [
    "time", "env", "nohup", "exec", "command", "builtin", "then", "else", "elif", "do", "if",
    "while", "until", "{", "!",
];

/// Whether the `(` about to be read opens a function definition: right
/// after a command word (`codex() {`), or after one and a space with
/// nothing between the parentheses (`codex () {`).
fn function_definition(
    word: &Option<String>,
    starts_command: bool,
    chars: &mut std::iter::Peekable<std::str::CharIndices<'_>>,
) -> bool {
    match word {
        Some(w) => starts_command && !is_assignment(w) && !w.ends_with(['$', '<', '>']),
        None => !starts_command && chars.peek().is_some_and(|&(_, next)| next == ')'),
    }
}

/// `NAME=value`: an assignment, which a shell reads ahead of the
/// command word rather than as it.
fn is_assignment(word: &str) -> bool {
    let Some((name, _)) = word.split_once('=') else { return false };
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The `OPENCODE_CONFIG_CONTENT` a compressed opencode is given.
///
/// opencode deep-merges this over its on-disk configuration (verified
/// against 1.18.25 with `opencode debug config`): the providers' other
/// options survive, the MCP servers gavin's Integration writes survive,
/// and the plugin list is appended to rather than replaced. So only
/// what routes is written here, and the file stays the human's.
///
/// The providers' base URLs carry the session's tag. The plugin is
/// loaded from the installed Headroom by path, with the proxy and the
/// project as its options (`HeadroomPlugin(input, options)`), which is
/// what tags the Zen and Go traffic it reroutes -- rather than from the
/// `HEADROOM_PROXY_URL` and `HEADROOM_PROJECT` variables it would
/// otherwise read, which every command opencode runs would inherit.
///
/// The human's own `OPENCODE_CONFIG_CONTENT`, when there is one, is the
/// starting point, because setting the variable replaces it. A Headroom
/// plugin already in it goes: opencode would load the transport twice,
/// and the one it kept would not be this session's.
fn opencode_config(inherited: Option<&str>, base: &str, session_id: &str, plugin: &Path) -> String {
    let mut config = inherited
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .and_then(|value| match value {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default();
    remove_headroom_plugins(&mut config);

    let url = tagged_v1_url(base, session_id);
    for provider in ["anthropic", "openai"] {
        let options = object_at(&mut config, &["provider", provider, "options"]);
        options.insert("baseURL".to_string(), Value::String(url.clone()));
    }
    let entry = json!([
        plugin.to_string_lossy(),
        { "proxyUrl": base, "project": session_id },
    ]);
    match config.get_mut("plugin") {
        Some(Value::Array(plugins)) => plugins.push(entry),
        _ => {
            config.insert("plugin".to_string(), Value::Array(vec![entry]));
        }
    }
    Value::Object(config).to_string()
}

/// The object at `path` inside `map`, made (or made an object) on the
/// way.
fn object_at<'m>(map: &'m mut Map<String, Value>, path: &[&str]) -> &'m mut Map<String, Value> {
    let Some((first, rest)) = path.split_first() else { return map };
    let slot = map.entry(first.to_string()).or_insert_with(|| Value::Object(Map::new()));
    if !slot.is_object() {
        *slot = Value::Object(Map::new());
    }
    match slot {
        Value::Object(inner) => object_at(inner, rest),
        _ => unreachable!("made an object above"),
    }
}

/// A plugin entry's file, whether it is written bare or as `[file,
/// options]`.
fn plugin_file(entry: &Value) -> Option<&str> {
    match entry {
        Value::String(file) => Some(file),
        Value::Array(pair) => pair.first().and_then(Value::as_str),
        _ => None,
    }
}

/// Whether a plugin entry loads Headroom's opencode transport, from
/// wherever it is installed.
fn is_headroom_plugin(entry: &Value) -> bool {
    plugin_file(entry).is_some_and(|file| {
        let file = file.trim_start_matches("file://").replace('\\', "/");
        file.ends_with(&OPENCODE_PLUGIN.join("/"))
    })
}

/// The project a Headroom plugin entry tags its traffic with.
fn plugin_project(entry: &Value) -> Option<&str> {
    match entry {
        Value::Array(pair) => pair.get(1)?.get("project")?.as_str(),
        _ => None,
    }
}

fn remove_headroom_plugins(config: &mut Map<String, Value>) {
    if let Some(Value::Array(plugins)) = config.get_mut("plugin") {
        plugins.retain(|entry| !is_headroom_plugin(entry));
    }
}

/// The headers a compressed Claude Code sends: the human's own, then
/// the tag.
///
/// Setting the variable replaces what the session would have inherited,
/// so the inherited lines are carried over rather than lost -- a human
/// who routes through a gateway that wants a header still has it. Two
/// are dropped on the way: an inherited project tag, which would name
/// something other than this session, and the session-id header, which
/// gavin never sends whoever set it.
fn claude_headers(inherited: Option<&str>, session_id: &str) -> String {
    let mut lines = own_headers(inherited);
    lines.push(format!("{PROJECT_HEADER}: {session_id}"));
    lines.join("\n")
}

/// One header line's name and value.
fn header(line: &str) -> (&str, &str) {
    let (name, value) = line.split_once(':').unwrap_or((line, ""));
    (name.trim(), value.trim())
}

/// The inherited header lines that are the human's own: every one but
/// Headroom's two.
fn own_headers(inherited: Option<&str>) -> Vec<String> {
    inherited
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| {
            let (name, _) = header(line);
            !name.eq_ignore_ascii_case(PROJECT_HEADER) && !name.eq_ignore_ascii_case(SESSION_HEADER)
        })
        .map(str::to_string)
        .collect()
}

/// What a session must NOT inherit: another session's routing.
///
/// The daemon hands every PTY the environment it was started with, and
/// on this project it is routinely started from inside an agent's shell
/// -- an agent runs the dev app, the app starts the daemon. When that
/// agent's session was compressed, its three routing variables come
/// down the whole chain and into every tab this daemon opens: a plain
/// shell that was promised its own environment, and an agent in a
/// workspace with compression off, both talking to their model through
/// Headroom under the LAUNCHER's tag. Marked uncompressed, and
/// compressed; and the savings land on a session that did not earn
/// them. It is the leak `PtySession::spawn` already stops for Claude
/// Code's own session variables, one recipe later.
///
/// The test is exact, because the human's own routing must survive it:
/// a gateway of theirs in `ANTHROPIC_BASE_URL`, even a Headroom of
/// their own with a project of their choosing, is configuration a
/// terminal keeps. What is removed is a recipe GAVIN wrote, and gavin's
/// is recognisable: its project tag is the session id, which the same
/// environment carries as `GAVIN_SESSION_ID`. The two agreeing is a
/// compressed gavin session's environment and nothing else. Each recipe
/// carries the tag in its own place -- Claude Code's in a header, the
/// others' on a `/p/<id>` path, opencode's also as its plugin's
/// `project` -- so each is looked for there.
///
/// Each entry is a variable and what to leave in it; `None` removes
/// it. The header list keeps the lines that were the human's before
/// the recipe added its own, and opencode's configuration keeps
/// whatever was not the recipe's.
pub fn inherited_routing(
    inherited: impl Fn(&str) -> Option<String>,
) -> Vec<(&'static str, Option<String>)> {
    let Some(launcher) = inherited(SESSION_ID).filter(|id| !id.trim().is_empty()) else {
        return Vec::new();
    };
    let launcher = launcher.trim();
    let mut removed = Vec::new();

    // Claude Code's, tagged by its header.
    let headers = inherited(CLAUDE_HEADERS);
    let tagged_as_the_launcher = headers.as_deref().unwrap_or_default().lines().any(|line| {
        let (name, value) = header(line);
        name.eq_ignore_ascii_case(PROJECT_HEADER) && value == launcher
    });
    if tagged_as_the_launcher {
        let kept = own_headers(headers.as_deref());
        removed.extend([
            (CLAUDE_BASE_URL, None),
            (CLAUDE_TOOL_SEARCH, None),
            (CLAUDE_HEADERS, (!kept.is_empty()).then(|| kept.join("\n"))),
        ]);
    } else if inherited(CLAUDE_BASE_URL).is_some_and(|url| is_tagged_for(&url, launcher)) {
        // A custom agent's that speaks Anthropic's API.
        removed.push((CLAUDE_BASE_URL, None));
    }

    // Codex's, and a custom agent's that speaks OpenAI's.
    if inherited(OPENAI_BASE_URL).is_some_and(|url| is_tagged_for(&url, launcher)) {
        removed.push((OPENAI_BASE_URL, None));
    }

    // Kimi's, and the OAuth host with it: gavin only ever sets the host
    // beside its own base URL (the credential slot is derived from the
    // pair), so the host goes when and only when the URL was gavin's.
    // A host the human exported alone stays -- kimi reads it on every
    // run, routed or not, and removing it would re-derive the slot of
    // an unrouted launch.
    if inherited(KIMI_BASE_URL).is_some_and(|url| is_tagged_for(&url, launcher)) {
        removed.push((KIMI_BASE_URL, None));
        removed.push((KIMI_OAUTH_HOST, None));
    }

    // opencode's.
    if let Some(kept) = inherited(OPENCODE_CONFIG)
        .and_then(|config| without_opencode_recipe(&config, launcher))
    {
        removed.push((OPENCODE_CONFIG, kept));
    }
    removed
}

/// `config` without the opencode recipe gavin wrote for `launcher`:
/// `None` when it holds no such recipe, and otherwise what is left, or
/// `Some(None)` when nothing is.
///
/// The recipe is known by its plugin: a Headroom plugin whose project is
/// the launcher. The base URLs go with it only where they carry the
/// launcher's tag, so a provider the human pointed elsewhere keeps its
/// URL.
fn without_opencode_recipe(config: &str, launcher: &str) -> Option<Option<String>> {
    let Ok(Value::Object(mut config)) = serde_json::from_str::<Value>(config) else {
        return None;
    };
    let plugins = config.get("plugin").and_then(Value::as_array)?;
    let launchers = |entry: &Value| is_headroom_plugin(entry) && plugin_project(entry) == Some(launcher);
    if !plugins.iter().any(launchers) {
        return None;
    }
    remove_headroom_plugins(&mut config);
    if config.get("plugin").and_then(Value::as_array).is_some_and(Vec::is_empty) {
        config.remove("plugin");
    }
    if let Some(Value::Object(providers)) = config.get_mut("provider") {
        for provider in ["anthropic", "openai"] {
            let Some(Value::Object(entry)) = providers.get_mut(provider) else { continue };
            if let Some(Value::Object(options)) = entry.get_mut("options") {
                if options
                    .get("baseURL")
                    .and_then(Value::as_str)
                    .is_some_and(|url| is_tagged_for(url, launcher))
                {
                    options.remove("baseURL");
                }
                if options.is_empty() {
                    entry.remove("options");
                }
            }
            if entry.is_empty() {
                providers.remove(provider);
            }
        }
        if providers.is_empty() {
            config.remove("provider");
        }
    }
    Some((!config.is_empty()).then(|| Value::Object(config).to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = "0b6c4a52-7f0e-4d0c-9a53-3f6f0c1f2a11";
    const PORT: u16 = 41873;

    /// A Claude Code card run in a workspace with compression on, and a
    /// Headroom that is ready: the one case that is compressed. Every
    /// test below changes one fact of it.
    fn facts() -> Facts<'static> {
        Facts {
            workspace_on: true,
            ready_port: Some(PORT),
            launch: Launch::Profile("claude-code"),
            session_id: SESSION,
            command: Some("claude --model opus 'Read the card'"),
            inherited_headers: None,
            inherited_opencode_config: None,
            opencode_plugin: None,
            without_headroom: false,
            gemini_api_key: false,
            kimi_oauth_host: KIMI_DEFAULT_OAUTH_HOST,
        }
    }

    /// A line another agent asked for over MCP: the line is both what
    /// speaks for the launch and what runs.
    fn spawned(line: &'static str) -> Facts<'static> {
        Facts { launch: Launch::Command(line), command: Some(line), ..facts() }
    }

    /// Where uv puts Headroom's opencode plugin.
    const PLUGIN: &str = "/Users/h/.local/share/uv/tools/headroom-ai/lib/python3.13/site-packages/headroom/providers/opencode/_dist/entry.opencode.js";

    /// An opencode card run, on a Headroom with its plugin where it
    /// ships.
    fn opencode() -> Facts<'static> {
        Facts {
            launch: Launch::Profile("opencode"),
            command: Some("opencode --model anthropic/claude-sonnet-4-5 --prompt='Read the card'"),
            opencode_plugin: Some(Path::new(PLUGIN)),
            ..facts()
        }
    }

    /// A Codex card run.
    fn codex(line: &'static str) -> Facts<'static> {
        Facts { launch: Launch::Profile("codex"), command: Some(line), ..facts() }
    }

    fn env_of(decision: &Decision) -> Vec<(&str, &str)> {
        decision.env().iter().map(|(k, v)| (k.as_str(), v.as_str())).collect()
    }

    #[test]
    fn a_claude_code_launch_in_a_compressed_workspace_is_compressed() {
        let decision = decide(facts());

        assert!(decision.compressed());
        assert_eq!(decision.reason(), None);
    }

    #[test]
    fn a_workspace_with_compression_off_compresses_nothing_and_owes_no_reason() {
        let decision = decide(Facts { workspace_on: false, ..facts() });

        assert_eq!(decision, Decision::Uncompressed(None));
        assert!(decision.env().is_empty());
    }

    #[test]
    fn a_headroom_that_is_not_ready_leaves_the_session_uncompressed_and_says_so() {
        let decision = decide(Facts { ready_port: None, ..facts() });

        assert_eq!(decision, Decision::Uncompressed(Some(Reason::NotReady)));
        assert!(decision.env().is_empty(), "a session must never be pointed at a proxy that is not there");
    }

    #[test]
    fn an_agent_with_no_recipe_is_not_compressed() {
        for profile in ["gemini", "custom", "a-profile-from-a-newer-app"] {
            let decision = decide(Facts { launch: Launch::Profile(profile), ..facts() });

            assert_eq!(decision, Decision::Uncompressed(Some(Reason::NoRecipe)), "{profile}");
        }
    }

    #[test]
    fn cursor_cannot_be_routed_and_says_that_rather_than_blaming_headroom() {
        let ready = decide(Facts { launch: Launch::Profile("cursor"), ..facts() });
        let down = decide(Facts { launch: Launch::Profile("cursor"), ready_port: None, ..facts() });

        assert_eq!(ready, Decision::Uncompressed(Some(Reason::UnsupportedAgent)));
        assert_eq!(down, Decision::Uncompressed(Some(Reason::UnsupportedAgent)));
    }

    /// Auto-resume's relaunch of a session that broke on Headroom. The
    /// Headroom here is READY, which is the case the override exists for:
    /// the one the session broke on answered `/readyz` too, or had come
    /// back by the time the relaunch fired.
    #[test]
    fn a_relaunch_without_headroom_is_uncompressed_however_ready_headroom_looks() {
        let decision = decide(Facts { without_headroom: true, ..facts() });

        assert_eq!(decision, Decision::Uncompressed(Some(Reason::HeadroomFailed)));
        assert_eq!(decision.reason().map(Reason::id), Some("headroom-failed"));
        assert!(decision.env().is_empty(), "handed the proxy it just broke on");
        assert_eq!(decision.command(), None);

        let down = decide(Facts { without_headroom: true, ready_port: None, ..facts() });
        assert_eq!(down, Decision::Uncompressed(Some(Reason::HeadroomFailed)), "the override names why");
    }

    /// The override is an exception only where compression was asked
    /// for: a workspace that is off, a shell and an agent that cannot be
    /// routed answer as they always did.
    #[test]
    fn the_override_changes_nothing_that_was_never_going_to_be_compressed() {
        assert_eq!(
            decide(Facts { without_headroom: true, workspace_on: false, ..facts() }),
            Decision::Uncompressed(None)
        );
        assert_eq!(
            decide(Facts { without_headroom: true, launch: Launch::Shell, ..facts() }),
            Decision::Uncompressed(None)
        );
        assert_eq!(
            decide(Facts { without_headroom: true, launch: Launch::Profile("cursor"), ..facts() }),
            Decision::Uncompressed(Some(Reason::UnsupportedAgent))
        );
    }

    #[test]
    fn a_plain_shell_tab_never_qualifies() {
        let decision = decide(Facts { launch: Launch::Shell, ..facts() });

        assert_eq!(decision, Decision::Uncompressed(None));
        assert!(decision.env().is_empty());
    }

    #[test]
    fn an_mcp_spawn_of_claude_is_compressed() {
        for line in [
            "claude",
            "claude --model opus 'Read the card'",
            "/opt/homebrew/bin/claude --model sonnet[1m]",
            "  claude  'leading space'",
        ] {
            let decision = decide(spawned(line));

            assert!(decision.compressed(), "{line}");
            assert_eq!(decision.command(), None, "Claude Code is routed by environment alone");
        }
    }

    fn gemini() -> Facts<'static> {
        Facts {
            launch: Launch::Profile("gemini"),
            command: Some("gemini --yolo --prompt='Read the card'"),
            ..facts()
        }
    }

    #[test]
    fn gemini_on_an_api_key_is_routed_through_a_tagged_base_url() {
        let decision = decide(Facts { gemini_api_key: true, ..gemini() });

        assert_eq!(
            decision.env(),
            [("GOOGLE_GEMINI_BASE_URL".to_string(), format!("http://127.0.0.1:{PORT}/p/{SESSION}"))]
        );
        assert_eq!(decision.command(), None, "Gemini is routed by environment alone");
    }

    #[test]
    fn gemini_on_any_other_login_has_no_recipe_and_is_handed_nothing() {
        let decision = decide(gemini());

        assert_eq!(decision, Decision::Uncompressed(Some(Reason::NoRecipe)));
        assert!(decision.env().is_empty(), "Login with Google must never get CODE_ASSIST_ENDPOINT");
    }

    #[test]
    fn a_gemini_that_is_not_ready_says_so_before_saying_it_has_no_recipe() {
        let decision = decide(Facts { ready_port: None, gemini_api_key: true, ..gemini() });

        assert_eq!(decision, Decision::Uncompressed(Some(Reason::NotReady)));
    }

    #[test]
    fn an_mcp_spawn_of_gemini_follows_the_configured_auth() {
        let key = decide(Facts { gemini_api_key: true, ..spawned("gemini 'fix it'") });

        assert!(key.compressed());
    }

    const KEY: &str = r#"{"security":{"auth":{"selectedType":"gemini-api-key"}}}"#;
    const LOGIN: &str = r#"{"security":{"auth":{"selectedType":"oauth-personal"}}}"#;

    #[test]
    fn the_auth_type_is_the_configured_one_and_the_environment_only_fills_a_gap() {
        let key_in_env = GeminiEnv { api_key: true, ..Default::default() };
        // Chosen Login with Google outranks a key that happens to be set.
        assert!(!gemini_uses_api_key(&[LOGIN], key_in_env));
        assert!(gemini_uses_api_key(&[KEY], GeminiEnv::default()));
        // Nothing chosen: the environment decides.
        assert!(gemini_uses_api_key(&[], key_in_env));
        assert!(gemini_uses_api_key(&["{}"], key_in_env));
        assert!(!gemini_uses_api_key(&[], GeminiEnv::default()));
        assert!(!gemini_uses_api_key(&[], GeminiEnv { vertex: true, ..key_in_env }));
        assert!(!gemini_uses_api_key(&[], GeminiEnv { login: true, ..key_in_env }));
    }

    #[test]
    fn the_projects_settings_outrank_the_users_and_a_bad_file_defers() {
        let none = GeminiEnv::default();
        assert!(gemini_uses_api_key(&[KEY, LOGIN], none));
        assert!(!gemini_uses_api_key(&[LOGIN, KEY], none));
        assert!(gemini_uses_api_key(&["not json", "{}", KEY], none));
        // The older spelling is read only when the new one is absent.
        assert!(gemini_uses_api_key(&[r#"{"selectedAuthType":"gemini-api-key"}"#], none));
        assert!(!gemini_uses_api_key(
            &[r#"{"selectedAuthType":"gemini-api-key","security":{"auth":{"selectedType":"oauth-personal"}}}"#],
            none
        ));
    }

    #[test]
    fn an_mcp_spawn_is_judged_like_the_profile_its_binary_belongs_to() {
        let cursor = decide(spawned("agent --approve-mcps --trust"));
        let codex = decide(spawned("codex 'fix it'"));
        let gemini = decide(spawned("gemini 'fix it'"));
        let kimi = decide(spawned("kimi -p 'fix it'"));

        assert_eq!(cursor, Decision::Uncompressed(Some(Reason::UnsupportedAgent)));
        assert!(codex.compressed());
        assert_eq!(gemini, Decision::Uncompressed(Some(Reason::NoRecipe)));
        assert!(kimi.compressed());
    }

    fn kimi() -> Facts<'static> {
        Facts {
            launch: Launch::Profile("kimi-code"),
            command: Some("kimi -p 'Read the card'"),
            kimi_oauth_host: "https://auth.kimi.ai",
            ..facts()
        }
    }

    /// The verified shape (2.1.1): kimi appends `/chat/completions` to
    /// the base as-is, so it is handed the same `/p/<id>/v1` an OpenAI
    /// client is, plus the host its credential slot is derived from.
    #[test]
    fn the_kimi_recipe_is_environment_alone_with_the_oauth_host_beside_the_base_url() {
        let decision = decide(kimi());

        assert!(decision.compressed());
        assert_eq!(
            env_of(&decision),
            [("KIMI_CODE_BASE_URL", OPENAI_URL), ("KIMI_CODE_OAUTH_HOST", "https://auth.kimi.ai")]
        );
        assert_eq!(decision.command(), None, "Kimi is routed by environment alone");
    }

    /// A configuration that cannot be read leaves the derivation's own
    /// default standing.
    #[test]
    fn a_kimi_launch_with_no_readable_oauth_host_is_handed_the_default() {
        let decision = decide(Facts { kimi_oauth_host: KIMI_DEFAULT_OAUTH_HOST, ..kimi() });

        assert_eq!(
            env_of(&decision),
            [("KIMI_CODE_BASE_URL", OPENAI_URL), ("KIMI_CODE_OAUTH_HOST", KIMI_DEFAULT_OAUTH_HOST)]
        );
    }

    /// The derivation, pinned to the slot a live install persisted for
    /// this host and base URL (`~/.kimi-code/config.toml`'s
    /// `oauth/kimi-code-env-0e4f99c69cc27850`).
    #[test]
    fn the_credential_slot_is_derived_exactly_as_kimi_derives_it() {
        assert_eq!(
            kimi_credential_slot("https://auth.kimi.ai", "https://api.kimi.ai/coding/v1"),
            "kimi-code-env-0e4f99c69cc27850"
        );
        // The key order is part of the formula: hashed as written,
        // `{"oauthHost":…,"baseUrl":…}`, not sorted.
        assert_ne!(
            kimi_credential_slot("https://auth.kimi.ai", "https://api.kimi.ai/coding/v1"),
            kimi_credential_slot("https://api.kimi.ai/coding/v1", "https://auth.kimi.ai")
        );
    }

    const KIMI_CONFIG: &str = r#"
default_model = "kimi-code/k3"

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.ai/coding/v1"

[providers."managed:kimi-code".oauth]
storage = "file"
oauth_host = "https://auth.kimi.ai"
"#;

    #[test]
    fn the_managed_providers_persisted_host_and_base_url_are_read() {
        assert_eq!(
            kimi_config(KIMI_CONFIG),
            KimiConfig {
                oauth_host: Some("https://auth.kimi.ai".to_string()),
                base_url: Some("https://api.kimi.ai/coding/v1".to_string()),
            }
        );
    }

    #[test]
    fn a_config_that_names_nothing_or_does_not_parse_leaves_the_defaults() {
        assert_eq!(kimi_config("not toml ["), KimiConfig::default());
        assert_eq!(kimi_config(""), KimiConfig::default());
        assert_eq!(kimi_config("[providers.other]\ntype = \"x\""), KimiConfig::default());
        // Half a configuration still gives its half.
        assert_eq!(
            kimi_config("[providers.\"managed:kimi-code\"]\nbase_url = \"https://api.kimi.com/coding/v1\""),
            KimiConfig { oauth_host: None, base_url: Some("https://api.kimi.com/coding/v1".to_string()) }
        );
    }

    /// What a launch provisions: the slot the routed base URL derives,
    /// filled from the slot the human's own login is filed under.
    #[test]
    fn the_derived_slot_is_filled_from_the_persisted_logins_slot() {
        let dir = tempfile::tempdir().unwrap();
        let credentials = dir.path();
        let login = credentials.join("kimi-code-env-0e4f99c69cc27850.json");
        std::fs::write(&login, r#"{"access_token":"a"}"#).unwrap();

        provision_kimi_credential(
            credentials,
            "https://auth.kimi.ai",
            "http://127.0.0.1:41873/p/s/v1",
            Some("https://api.kimi.ai/coding/v1"),
        );

        let derived =
            credentials.join(format!("{}.json", kimi_credential_slot("https://auth.kimi.ai", "http://127.0.0.1:41873/p/s/v1")));
        assert_eq!(std::fs::read_to_string(derived).unwrap(), r#"{"access_token":"a"}"#);
        assert_eq!(std::fs::read_to_string(&login).unwrap(), r#"{"access_token":"a"}"#, "a copy, never a move");
    }

    /// Kimi may have refreshed the token in a derived slot; a later
    /// launch must not put the stale copy back over it.
    #[test]
    fn an_existing_derived_slot_is_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let credentials = dir.path();
        std::fs::write(credentials.join("kimi-code-env-0e4f99c69cc27850.json"), r#"{"access_token":"old"}"#).unwrap();
        let derived =
            credentials.join(format!("{}.json", kimi_credential_slot("https://auth.kimi.ai", "http://127.0.0.1:41873/p/s/v1")));
        std::fs::write(&derived, r#"{"access_token":"refreshed"}"#).unwrap();

        provision_kimi_credential(
            credentials,
            "https://auth.kimi.ai",
            "http://127.0.0.1:41873/p/s/v1",
            Some("https://api.kimi.ai/coding/v1"),
        );

        assert_eq!(std::fs::read_to_string(derived).unwrap(), r#"{"access_token":"refreshed"}"#);
    }

    /// A configuration that cannot be read still leaves the one
    /// credential there is to copy.
    #[test]
    fn with_nothing_persisted_the_single_credential_there_is_is_copied() {
        let dir = tempfile::tempdir().unwrap();
        let credentials = dir.path();
        std::fs::write(credentials.join("kimi-code-env-deadbeefdeadbeef.json"), r#"{"access_token":"a"}"#).unwrap();

        provision_kimi_credential(credentials, "https://auth.kimi.com", "http://127.0.0.1:41873/p/s/v1", None);

        let derived =
            credentials.join(format!("{}.json", kimi_credential_slot("https://auth.kimi.com", "http://127.0.0.1:41873/p/s/v1")));
        assert_eq!(std::fs::read_to_string(derived).unwrap(), r#"{"access_token":"a"}"#);
    }

    /// With nothing to copy, or several to guess between, nothing is
    /// written: the launch fails the way an unauthenticated kimi's
    /// does, rather than with someone else's login.
    #[test]
    fn with_no_credential_to_copy_or_several_nothing_is_written() {
        let empty = tempfile::tempdir().unwrap();
        provision_kimi_credential(empty.path(), "https://auth.kimi.com", "http://127.0.0.1:1/p/s/v1", None);
        assert_eq!(std::fs::read_dir(empty.path()).unwrap().count(), 0);

        let several = tempfile::tempdir().unwrap();
        for slot in ["kimi-code-env-aaaaaaaaaaaaaaaa.json", "kimi-code-env-bbbbbbbbbbbbbbbb.json"] {
            std::fs::write(several.path().join(slot), "{}").unwrap();
        }
        provision_kimi_credential(several.path(), "https://auth.kimi.com", "http://127.0.0.1:1/p/s/v1", None);
        assert_eq!(std::fs::read_dir(several.path()).unwrap().count(), 2, "no third file guessed");
    }

    #[test]
    fn a_daemon_started_from_a_compressed_kimi_session_does_not_pass_its_routing_on() {
        let env = [
            ("GAVIN_SESSION_ID", "launcher-1"),
            ("KIMI_CODE_BASE_URL", "http://127.0.0.1:41873/p/launcher-1/v1"),
            ("KIMI_CODE_OAUTH_HOST", "https://auth.kimi.ai"),
        ];

        assert_eq!(
            inherited_routing(inherited(&env)),
            [("KIMI_CODE_BASE_URL", None), ("KIMI_CODE_OAUTH_HOST", None)]
        );
    }

    /// The host leaves with gavin's base URL and nowhere else: exported
    /// alone or beside the human's own routing it is the human's, and
    /// kimi reads it on every run, routed or not.
    #[test]
    fn an_oauth_host_that_is_not_beside_gavins_base_url_is_left_alone() {
        let alone = [("GAVIN_SESSION_ID", "launcher-1"), ("KIMI_CODE_OAUTH_HOST", "https://auth.kimi.ai")];
        let their_routing = [
            ("GAVIN_SESSION_ID", "launcher-1"),
            ("KIMI_CODE_BASE_URL", "https://proxy.example.com/coding/v1"),
            ("KIMI_CODE_OAUTH_HOST", "https://auth.kimi.ai"),
        ];
        let their_tag = [
            ("GAVIN_SESSION_ID", "launcher-1"),
            ("KIMI_CODE_BASE_URL", "http://127.0.0.1:41873/p/launcher-10/v1"),
            ("KIMI_CODE_OAUTH_HOST", "https://auth.kimi.ai"),
        ];

        for env in [&alone[..], &their_routing[..], &their_tag[..]] {
            assert_eq!(inherited_routing(inherited(env)), [], "{env:?}");
        }
    }

    #[test]
    fn an_mcp_spawn_of_anything_else_is_a_command_not_an_agent() {
        for line in [
            "npm test",
            "cd app && claude",
            "ANTHROPIC_API_KEY=x claude",
            "claude-wrapper --fast",
            "echo claude",
            "",
            "   ",
        ] {
            let decision = decide(spawned(line));

            assert_eq!(decision, Decision::Uncompressed(None), "{line:?}");
        }
    }

    /// The profile is the app's word for what it launched. A workspace
    /// that points `[agent] command` at a wrapper is still running that
    /// harness, which the command line alone could not have said.
    #[test]
    fn a_profile_is_believed_whatever_the_command_line_would_have_said() {
        assert_eq!(Agent::from_profile("claude-code"), Agent::ClaudeCode);
        assert_eq!(Agent::from_command("claude-wrapper --fast"), None);
    }

    #[test]
    fn the_claude_code_recipe_is_exactly_three_variables() {
        let decision = decide(facts());

        assert_eq!(
            env_of(&decision),
            [
                ("ANTHROPIC_BASE_URL", "http://127.0.0.1:41873"),
                ("ENABLE_TOOL_SEARCH", "true"),
                ("ANTHROPIC_CUSTOM_HEADERS", "X-Headroom-Project: 0b6c4a52-7f0e-4d0c-9a53-3f6f0c1f2a11"),
            ]
        );
    }

    /// The base URL is the bare origin. Claude Code appends its own
    /// path, and a `/p/<id>` prefix is the other agents' tag, not this
    /// one's.
    #[test]
    fn the_claude_code_base_url_carries_no_path() {
        let recipe = recipe(Agent::ClaudeCode, 9, &facts()).unwrap();

        assert_eq!(recipe.env[0], ("ANTHROPIC_BASE_URL".to_string(), "http://127.0.0.1:9".to_string()));
    }

    fn mentions_the_session_header(recipe: &Recipe) -> bool {
        recipe.env.iter().any(|(key, value)| {
            key.to_ascii_lowercase().contains(SESSION_HEADER)
                || value.to_ascii_lowercase().contains(SESSION_HEADER)
        })
    }

    #[test]
    fn no_recipe_ever_sets_the_session_id_header() {
        for agent in [
            Agent::ClaudeCode,
            Agent::Codex,
            Agent::Gemini,
            Agent::Cursor,
            Agent::Opencode,
            Agent::Kimi,
            Agent::Custom(ApiFamily::Anthropic),
            Agent::Custom(ApiFamily::OpenAi),
            Agent::Other,
        ] {
            for inherited in [
                None,
                Some(""),
                Some("x-headroom-session-id: theirs"),
                Some("X-Headroom-Session-Id:theirs"),
                Some("  X-HEADROOM-SESSION-ID : theirs  \nX-Team: platform"),
            ] {
                // Every recipe has what it needs to be written.
                let facts = Facts {
                    command: Some("codex --model o3 'Read the card'"),
                    inherited_headers: inherited,
                    ..opencode()
                };
                if let Some(recipe) = recipe(agent, PORT, &facts) {
                    assert!(
                        !mentions_the_session_header(&recipe),
                        "{agent:?} with {inherited:?} set it: {recipe:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn the_humans_own_headers_are_kept_and_the_tag_is_this_sessions() {
        let inherited = "X-Team: platform\r\n\nX-Headroom-Project: someone-else\nX-Trace: on";

        let headers = claude_headers(Some(inherited), SESSION);

        assert_eq!(
            headers.lines().collect::<Vec<_>>(),
            [
                "X-Team: platform",
                "X-Trace: on",
                "X-Headroom-Project: 0b6c4a52-7f0e-4d0c-9a53-3f6f0c1f2a11",
            ]
        );
    }

    fn inherited<'a>(env: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |key| env.iter().find(|(k, _)| *k == key).map(|(_, v)| v.to_string())
    }

    /// What a compressed gavin session hands everything it starts: its
    /// own id, and the recipe written for it.
    fn a_compressed_sessions_environment(headers: &'static str) -> Vec<(&'static str, &'static str)> {
        vec![
            ("GAVIN_SESSION_ID", "launcher-1"),
            ("ANTHROPIC_BASE_URL", "http://127.0.0.1:41873"),
            ("ENABLE_TOOL_SEARCH", "true"),
            ("ANTHROPIC_CUSTOM_HEADERS", headers),
        ]
    }

    #[test]
    fn a_daemon_started_from_a_compressed_session_does_not_pass_its_routing_on() {
        let env = a_compressed_sessions_environment("X-Headroom-Project: launcher-1");

        assert_eq!(
            inherited_routing(inherited(&env)),
            [
                ("ANTHROPIC_BASE_URL", None),
                ("ENABLE_TOOL_SEARCH", None),
                ("ANTHROPIC_CUSTOM_HEADERS", None),
            ]
        );
    }

    #[test]
    fn the_humans_own_headers_survive_the_launchers_recipe_being_removed() {
        let env =
            a_compressed_sessions_environment("X-Team: platform\nx-headroom-project:launcher-1\nX-Trace: on");

        let removed = inherited_routing(inherited(&env));

        assert_eq!(
            removed[2],
            ("ANTHROPIC_CUSTOM_HEADERS", Some("X-Team: platform\nX-Trace: on".to_string()))
        );
    }

    /// Configuration a terminal keeps: none of these is a recipe gavin
    /// wrote, and removing any of them would be gavin deciding how the
    /// human reaches their model.
    #[test]
    fn routing_that_is_the_humans_own_is_left_alone() {
        let theirs: [&[(&str, &str)]; 6] = [
            &[],
            // A gateway of their own.
            &[("ANTHROPIC_BASE_URL", "https://gateway.example.com")],
            &[
                ("ANTHROPIC_BASE_URL", "https://gateway.example.com"),
                ("ANTHROPIC_CUSTOM_HEADERS", "X-Team: platform"),
            ],
            // A Headroom of their own, tagged as they chose.
            &[
                ("ANTHROPIC_BASE_URL", "http://127.0.0.1:8787"),
                ("ENABLE_TOOL_SEARCH", "true"),
                ("ANTHROPIC_CUSTOM_HEADERS", "X-Headroom-Project: my-laptop"),
            ],
            // The same, in a daemon that a gavin session started: the
            // tag is not that session's, so the recipe is not gavin's.
            &[
                ("GAVIN_SESSION_ID", "launcher-1"),
                ("ANTHROPIC_BASE_URL", "http://127.0.0.1:8787"),
                ("ANTHROPIC_CUSTOM_HEADERS", "X-Headroom-Project: my-laptop"),
            ],
            // A gavin session that was not compressed.
            &[("GAVIN_SESSION_ID", "launcher-1"), ("ANTHROPIC_BASE_URL", "https://gateway.example.com")],
        ];

        for env in theirs {
            assert_eq!(inherited_routing(inherited(env)), [], "{env:?}");
        }
    }

    #[test]
    fn a_tag_that_merely_contains_the_launchers_id_is_not_the_launchers() {
        let env = a_compressed_sessions_environment("X-Headroom-Project: launcher-10");

        assert_eq!(inherited_routing(inherited(&env)), []);
    }

    #[test]
    fn every_reason_has_its_own_word() {
        assert_eq!(Reason::NotReady.id(), "not-ready");
        assert_eq!(Reason::NoRecipe.id(), "no-recipe");
        assert_eq!(Reason::UnsupportedAgent.id(), "unsupported-agent");
    }

    #[test]
    fn a_binary_is_recognised_by_name_whatever_its_path_or_extension() {
        assert_eq!(Agent::from_command("/usr/local/bin/codex exec"), Some(Agent::Codex));
        assert_eq!(Agent::from_command("claude.exe"), Some(Agent::ClaudeCode));
        assert_eq!(Agent::from_command("cursor-agent -p"), Some(Agent::Cursor));
        assert_eq!(Agent::from_command("opencode --prompt='x'"), Some(Agent::Opencode));
        assert_eq!(Agent::from_command("gemini"), Some(Agent::Gemini));
        assert_eq!(Agent::from_command("/opt/homebrew/bin/kimi -p 'x'"), Some(Agent::Kimi));
    }

    const CODEX_FLAG: &str =
        r#"-c 'openai_base_url="http://127.0.0.1:41873/p/0b6c4a52-7f0e-4d0c-9a53-3f6f0c1f2a11/v1"'"#;
    const OPENAI_URL: &str = "http://127.0.0.1:41873/p/0b6c4a52-7f0e-4d0c-9a53-3f6f0c1f2a11/v1";

    #[test]
    fn the_codex_recipe_hands_the_tagged_base_url_to_the_binary_and_to_the_environment() {
        let decision = decide(codex("codex --model gpt-5.5 'Read the card'"));

        assert!(decision.compressed());
        assert_eq!(
            decision.command(),
            Some(format!("codex {CODEX_FLAG} --model gpt-5.5 'Read the card'").as_str())
        );
        assert_eq!(env_of(&decision), [("OPENAI_BASE_URL", OPENAI_URL)]);
    }

    /// Right after the binary, whatever the rest of the line is: the end
    /// of a line gavin composes is its prompt, after a `--` where a flag
    /// would be read as prompt text.
    #[test]
    fn the_codex_flag_goes_right_after_the_binary_whatever_follows_it() {
        let rows: [(&str, String); 10] = [
            ("codex", format!("codex {CODEX_FLAG}")),
            // The model suffix `composeLaunchCommand` adds.
            ("codex --model gpt-5.5", format!("codex {CODEX_FLAG} --model gpt-5.5")),
            // A card run's prompt, quoted the way `shellQuote` quotes it,
            // naming the binary and an operator as text.
            (
                r"codex --model 'gpt-5.5-codex' 'Fix it. It'\''s codex && tests; then codex'",
                format!(r"codex {CODEX_FLAG} --model 'gpt-5.5-codex' 'Fix it. It'\''s codex && tests; then codex'"),
            ),
            // The hidden commit run's headless line.
            (
                "codex --model o3 exec --sandbox workspace-write --ask-for-approval never -- 'Commit'",
                format!("codex {CODEX_FLAG} --model o3 exec --sandbox workspace-write --ask-for-approval never -- 'Commit'"),
            ),
            (
                "/opt/homebrew/bin/codex --model o3 'x'",
                format!("/opt/homebrew/bin/codex {CODEX_FLAG} --model o3 'x'"),
            ),
            // A worktree's setup chained ahead of the agent.
            (
                "npm ci && cargo fetch && codex --model o3 'x'",
                format!("npm ci && cargo fetch && codex {CODEX_FLAG} --model o3 'x'"),
            ),
            ("OPENAI_API_KEY=sk-1 codex 'x'", format!("OPENAI_API_KEY=sk-1 codex {CODEX_FLAG} 'x'")),
            (
                "'/Applications/My Tools/codex' 'x'",
                format!("'/Applications/My Tools/codex' {CODEX_FLAG} 'x'"),
            ),
            ("codex 2>&1 | tee log", format!("codex {CODEX_FLAG} 2>&1 | tee log")),
            // Two in one line: the session is tagged as one, so both are
            // routed.
            (
                "codex exec 'a' && codex exec 'b'",
                format!("codex {CODEX_FLAG} exec 'a' && codex {CODEX_FLAG} exec 'b'"),
            ),
        ];

        for (line, expected) in rows {
            assert_eq!(decide(codex(line)).command(), Some(expected.as_str()), "{line}");
        }
    }

    #[test]
    fn an_mcp_spawn_of_codex_is_given_the_flag_too() {
        let decision = decide(spawned("/usr/local/bin/codex exec 'fix it'"));

        assert_eq!(
            decision.command(),
            Some(format!("/usr/local/bin/codex {CODEX_FLAG} exec 'fix it'").as_str())
        );
        assert_eq!(env_of(&decision), [("OPENAI_BASE_URL", OPENAI_URL)]);
    }

    /// Without the flag current Codex is not routed, and a session marked
    /// compressed that is not would be a lie. The profile is believed;
    /// it is the line that has nowhere to put the flag.
    #[test]
    fn a_codex_launch_whose_line_runs_no_codex_has_no_recipe() {
        for line in [
            "npx @openai/codex 'x'",
            // A fallback's command under the card's own profile.
            "claude --model opus 'Read the card'",
            "echo codex",
            "my-codex-wrapper --fast",
            "# codex",
            "'echo && codex'",
        ] {
            let decision = decide(codex(line));

            assert_eq!(decision, Decision::Uncompressed(Some(Reason::NoRecipe)), "{line}");
        }
        let no_line = decide(Facts { command: None, ..codex("codex") });
        assert_eq!(no_line, Decision::Uncompressed(Some(Reason::NoRecipe)));
    }

    /// A construct the scanner cannot read is refused whole: a flag put
    /// in a string, a heredoc body or a function's name, or a line only
    /// partly routed, is worse than a line left alone.
    #[test]
    fn a_line_with_a_construct_the_scanner_cannot_read_is_refused() {
        for line in [
            // `\'` does not end an ANSI-C string.
            r"codex exec $'it\'s done; codex is fine'",
            "cat > notes.txt <<EOF\ncodex = true\nEOF\ncodex exec x",
            r#"codex() { command codex "$@"; }; codex exec x"#,
            r#"codex () { command codex "$@"; }; codex exec x"#,
            "codex exec a && time codex exec b",
            "codex exec a && env A=1 codex exec b",
            "codex exec a && nohup codex exec b",
            "if true; then codex exec b; fi",
            "{ codex exec b; }",
            "! codex exec b",
        ] {
            assert_eq!(with_codex_base_url(line, "http://127.0.0.1:1/p/s/v1"), None, "{line}");
        }
        // Not refused: a here-string, a substitution, a quoted `<<`.
        for line in ["codex exec <<< hi", "codex exec \"$(pwd)\" '<<'", "A=$(x) codex exec y"] {
            assert!(with_codex_base_url(line, "http://127.0.0.1:1/p/s/v1").is_some(), "{line}");
        }
    }

    #[test]
    fn a_line_is_read_for_the_programs_it_runs_and_nothing_else() {
        let line = "A=1 b c && 'd e' f; g|h (i) # j\nk \"l\\\"m\" n\\ o";

        let words: Vec<String> = command_words(line).expect("readable").into_iter().map(|(_, word)| word).collect();

        assert_eq!(words, ["b", "d e", "g", "h", "i", "k"]);
        let (end, _) = command_words("  codex  --x").expect("readable").remove(0);
        assert_eq!(end, "  codex".len());
    }

    fn opencode_content(decision: &Decision) -> Value {
        let env = env_of(decision);
        assert_eq!(env.len(), 1, "{env:?}");
        assert_eq!(env[0].0, "OPENCODE_CONFIG_CONTENT");
        serde_json::from_str(env[0].1).expect("OPENCODE_CONFIG_CONTENT is JSON")
    }

    #[test]
    fn the_opencode_recipe_points_both_native_providers_and_the_plugin_at_this_session() {
        let decision = decide(opencode());

        assert!(decision.compressed());
        assert_eq!(decision.command(), None, "opencode is routed by environment alone");
        assert_eq!(
            opencode_content(&decision),
            json!({
                "provider": {
                    "anthropic": { "options": { "baseURL": OPENAI_URL } },
                    "openai": { "options": { "baseURL": OPENAI_URL } },
                },
                "plugin": [[PLUGIN, { "proxyUrl": "http://127.0.0.1:41873", "project": SESSION }]],
            })
        );
    }

    /// opencode's own merge of `OPENCODE_CONFIG_CONTENT` over a file, as
    /// `mergeConfigConcatArrays` does it (seen against 1.18.25 with
    /// `opencode debug config`): objects merge key by key, the plugin
    /// lists are joined, and anything else is replaced.
    fn opencode_merge(disk: &Value, content: &Value) -> Value {
        fn deep(target: &Value, source: &Value) -> Value {
            match (target, source) {
                (Value::Object(target), Value::Object(source)) => {
                    let mut merged = target.clone();
                    for (key, value) in source {
                        let next = match merged.get(key) {
                            Some(existing) => deep(existing, value),
                            None => value.clone(),
                        };
                        merged.insert(key.clone(), next);
                    }
                    Value::Object(merged)
                }
                (_, source) => source.clone(),
            }
        }
        let mut merged = deep(disk, content);
        if let (Some(Value::Array(on_disk)), Some(Value::Array(added))) =
            (disk.get("plugin"), content.get("plugin"))
        {
            merged["plugin"] = Value::Array(on_disk.iter().chain(added).cloned().collect());
        }
        merged
    }

    #[test]
    fn the_opencode_config_content_keeps_the_mcp_servers_on_disk() {
        // What gavin's Integration writes into a workspace on opencode
        // (`McpFormat::JsonLocal`), beside the human's own settings.
        let disk = json!({
            "$schema": "https://opencode.ai/config.json",
            "mcp": { "gavin": { "type": "local", "command": ["/usr/local/bin/gavin-mcp"], "enabled": true } },
            "provider": { "anthropic": { "options": { "apiKey": "{env:MY_KEY}" } } },
            "plugin": ["./their-plugin.js"],
        });
        let content = opencode_content(&decide(opencode()));

        assert!(content.get("mcp").is_none(), "the recipe writes no MCP server of its own");
        let merged = opencode_merge(&disk, &content);

        assert_eq!(merged["mcp"], disk["mcp"]);
        assert_eq!(merged["provider"]["anthropic"]["options"]["apiKey"], "{env:MY_KEY}");
        assert_eq!(merged["provider"]["anthropic"]["options"]["baseURL"], OPENAI_URL);
        assert_eq!(merged["provider"]["openai"]["options"]["baseURL"], OPENAI_URL);
        assert_eq!(
            merged["plugin"],
            json!(["./their-plugin.js", [PLUGIN, { "proxyUrl": "http://127.0.0.1:41873", "project": SESSION }]])
        );
    }

    /// Zen and Go reach Headroom only through the plugin. Without it a
    /// Zen session would be marked compressed and send Headroom nothing.
    #[test]
    fn an_opencode_launch_on_a_headroom_without_its_plugin_has_no_recipe() {
        let decision = decide(Facts { opencode_plugin: None, ..opencode() });

        assert_eq!(decision, Decision::Uncompressed(Some(Reason::NoRecipe)));
    }

    /// Setting the variable replaces what the session would have
    /// inherited, so the human's own configuration is the starting
    /// point -- all of it but a Headroom plugin, which opencode would
    /// otherwise load twice.
    #[test]
    fn the_humans_own_opencode_config_is_kept_and_an_earlier_headroom_plugin_is_replaced() {
        let theirs = json!({
            "theme": "tokyonight",
            "provider": { "anthropic": { "options": { "apiKey": "k", "baseURL": "https://gateway.example.com" } } },
            "plugin": [
                "mine.js",
                ["/somewhere/else/headroom/providers/opencode/_dist/entry.opencode.js", { "project": "theirs" }],
            ],
        })
        .to_string();

        let content = opencode_content(&decide(Facts {
            inherited_opencode_config: Some(&theirs),
            ..opencode()
        }));

        assert_eq!(content["theme"], "tokyonight");
        assert_eq!(content["provider"]["anthropic"]["options"]["apiKey"], "k");
        assert_eq!(content["provider"]["anthropic"]["options"]["baseURL"], OPENAI_URL);
        assert_eq!(
            content["plugin"],
            json!(["mine.js", [PLUGIN, { "proxyUrl": "http://127.0.0.1:41873", "project": SESSION }]])
        );
    }

    #[test]
    fn an_inherited_opencode_config_that_is_no_object_is_replaced() {
        for theirs in ["", "not json", "[1, 2]", "null"] {
            let content = opencode_content(&decide(Facts {
                inherited_opencode_config: Some(theirs),
                ..opencode()
            }));

            assert_eq!(content, opencode_content(&decide(opencode())), "{theirs:?}");
        }
    }

    #[test]
    fn a_custom_agent_is_routed_by_the_api_family_its_settings_name() {
        let anthropic = decide(Facts { launch: Launch::Custom(ApiFamily::Anthropic), ..facts() });
        let openai = decide(Facts { launch: Launch::Custom(ApiFamily::OpenAi), ..facts() });

        assert_eq!(
            env_of(&anthropic),
            [("ANTHROPIC_BASE_URL", "http://127.0.0.1:41873/p/0b6c4a52-7f0e-4d0c-9a53-3f6f0c1f2a11")]
        );
        assert_eq!(env_of(&openai), [("OPENAI_BASE_URL", OPENAI_URL)]);
        assert_eq!(anthropic.command(), None);
        assert_eq!(openai.command(), None);
    }

    /// None is the default, and it means no recipe: gavin knows nothing
    /// of the binary.
    #[test]
    fn a_custom_agent_with_no_api_family_has_no_recipe() {
        for family in [None, Some(""), Some("none"), Some("gemini")] {
            let launch = Launch::requested(Some("custom"), family);

            assert_eq!(launch, Launch::Profile("custom"), "{family:?}");
            assert_eq!(
                decide(Facts { launch, ..facts() }),
                Decision::Uncompressed(Some(Reason::NoRecipe)),
                "{family:?}"
            );
        }
    }

    #[test]
    fn an_api_family_counts_on_any_non_stock_profile() {
        assert_eq!(Launch::requested(Some("custom"), Some("anthropic")), Launch::Custom(ApiFamily::Anthropic));
        assert_eq!(Launch::requested(Some("custom-agent"), Some(" openai ")), Launch::Custom(ApiFamily::OpenAi));
        assert_eq!(Launch::requested(Some("my-bot"), Some("anthropic")), Launch::Custom(ApiFamily::Anthropic));
        assert_eq!(Launch::requested(Some("claude-code"), Some("openai")), Launch::Profile("claude-code"));
        assert_eq!(Launch::requested(Some("kimi-code"), Some("anthropic")), Launch::Profile("kimi-code"));
        assert_eq!(Launch::requested(None, Some("anthropic")), Launch::Shell);
    }

    #[test]
    fn a_daemon_started_from_a_compressed_codex_or_custom_session_does_not_pass_its_routing_on() {
        let codex = [
            ("GAVIN_SESSION_ID", "launcher-1"),
            ("OPENAI_BASE_URL", "http://127.0.0.1:41873/p/launcher-1/v1"),
        ];
        let custom_anthropic = [
            ("GAVIN_SESSION_ID", "launcher-1"),
            ("ANTHROPIC_BASE_URL", "http://127.0.0.1:41873/p/launcher-1"),
        ];

        assert_eq!(inherited_routing(inherited(&codex)), [("OPENAI_BASE_URL", None)]);
        assert_eq!(inherited_routing(inherited(&custom_anthropic)), [("ANTHROPIC_BASE_URL", None)]);
    }

    #[test]
    fn a_daemon_started_from_a_compressed_opencode_session_does_not_pass_its_routing_on() {
        let plugin = Path::new(PLUGIN);
        let base = base_url(41873);
        let recipe = opencode_config(None, &base, "launcher-1", plugin);
        let theirs = json!({ "theme": "tokyonight", "plugin": ["mine.js"] }).to_string();
        let merged = opencode_config(Some(&theirs), &base, "launcher-1", plugin);

        let alone = inherited_routing(inherited(&[
            ("GAVIN_SESSION_ID", "launcher-1"),
            ("OPENCODE_CONFIG_CONTENT", &recipe),
        ]));
        let with_theirs = inherited_routing(inherited(&[
            ("GAVIN_SESSION_ID", "launcher-1"),
            ("OPENCODE_CONFIG_CONTENT", &merged),
        ]));

        assert_eq!(alone, [("OPENCODE_CONFIG_CONTENT", None)]);
        let [(key, Some(kept))] = with_theirs.as_slice() else { panic!("{with_theirs:?}") };
        assert_eq!(*key, "OPENCODE_CONFIG_CONTENT");
        assert_eq!(serde_json::from_str::<Value>(kept).unwrap(), serde_json::from_str::<Value>(&theirs).unwrap());
    }

    #[test]
    fn routing_to_somewhere_else_or_under_another_tag_is_the_humans_own() {
        let their_opencode = opencode_config(None, &base_url(8787), "my-laptop", Path::new(PLUGIN));
        let theirs: [&[(&str, &str)]; 6] = [
            &[("GAVIN_SESSION_ID", "launcher-1"), ("OPENAI_BASE_URL", "https://api.example.com/v1")],
            &[("GAVIN_SESSION_ID", "launcher-1"), ("OPENAI_BASE_URL", "http://127.0.0.1:8787/p/my-laptop/v1")],
            &[("GAVIN_SESSION_ID", "launcher-1"), ("OPENAI_BASE_URL", "http://127.0.0.1:41873/p/launcher-10/v1")],
            &[("GAVIN_SESSION_ID", "launcher-1"), ("ANTHROPIC_BASE_URL", "http://127.0.0.1:41873/p/launcher-1/x")],
            &[("GAVIN_SESSION_ID", "launcher-1"), ("OPENCODE_CONFIG_CONTENT", &their_opencode)],
            &[("GAVIN_SESSION_ID", "launcher-1"), ("OPENCODE_CONFIG_CONTENT", "not json")],
        ];

        for env in theirs {
            assert_eq!(inherited_routing(inherited(env)), [], "{env:?}");
        }
    }
}
