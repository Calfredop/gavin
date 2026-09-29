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
//! recipe is a function of the agent, the port and the session id.
//! Neither reads the clock, the disk or the process table, which is what
//! lets every row of the decision be a unit test.
//!
//! Nothing here is remembered. A resume, a relaunch, a fallback and an
//! auto-resume are all fresh spawns, so each is decided again against
//! Headroom as it is at that moment -- a session is never left pointed
//! at a proxy that has gone because the one before it was.

use super::launch::HOST;

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

/// What is about to be launched, as far as the daemon can tell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Launch<'a> {
    /// The app named the agent profile doing the launching
    /// (`CreateSession`'s `profile_id`).
    Profile(&'a str),
    /// A command line another agent asked for over MCP
    /// (`SpawnAgentSession`), with nobody's word for what it is.
    Command(&'a str),
    /// No profile: a shell tab, a command tool, a setup script.
    Shell,
}

/// The agents gavin knows by name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Agent {
    ClaudeCode,
    Codex,
    Gemini,
    Cursor,
    Opencode,
    /// A profile gavin has no table row for: `custom`, and any id a
    /// newer app sends that this daemon has not heard of.
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
    /// The agent could be routed and gavin has no recipe for it.
    NoRecipe,
    /// The agent cannot be routed at all. Cursor's CLI sends everything
    /// through Cursor's own servers over Cursor's protocol.
    UnsupportedAgent,
}

impl Reason {
    /// The word written on the session, and sent to the app.
    pub fn id(self) -> &'static str {
        match self {
            Reason::NotReady => "not-ready",
            Reason::NoRecipe => "no-recipe",
            Reason::UnsupportedAgent => "unsupported-agent",
        }
    }
}

/// What routes one agent through Headroom: environment that lasts as
/// long as the process, and no file anywhere (ADR 0007).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Recipe {
    pub env: Vec<(String, String)>,
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
    /// `ANTHROPIC_CUSTOM_HEADERS` as the session would otherwise
    /// inherit it, so the human's own headers are kept.
    pub inherited_headers: Option<&'a str>,
}

/// Whether this session is compressed.
///
/// The order is the order of the answers' permanence. A workspace that
/// is off and a launch that is no agent's are not exceptions and carry
/// no reason. An agent that cannot be routed is said before readiness
/// is: "Cursor cannot be compressed" is true tomorrow, and "Headroom
/// was not ready" would send the human to fix something that changes
/// nothing for that session.
pub fn decide(facts: Facts) -> Decision {
    if !facts.workspace_on {
        return Decision::Uncompressed(None);
    }
    let agent = match facts.launch {
        Launch::Shell => return Decision::Uncompressed(None),
        Launch::Profile(id) => Agent::from_profile(id),
        Launch::Command(line) => match Agent::from_command(line) {
            Some(agent) => agent,
            None => return Decision::Uncompressed(None),
        },
    };
    if let Some(reason) = unroutable(agent) {
        return Decision::Uncompressed(Some(reason));
    }
    let Some(port) = facts.ready_port else {
        return Decision::Uncompressed(Some(Reason::NotReady));
    };
    match recipe(agent, port, facts.session_id, facts.inherited_headers) {
        Some(recipe) => Decision::Compressed(recipe),
        None => Decision::Uncompressed(Some(Reason::NoRecipe)),
    }
}

/// Why this agent has no recipe whatever Headroom's state, or `None`
/// when it has one.
fn unroutable(agent: Agent) -> Option<Reason> {
    match agent {
        Agent::ClaudeCode => None,
        Agent::Cursor => Some(Reason::UnsupportedAgent),
        Agent::Codex | Agent::Gemini | Agent::Opencode | Agent::Other => Some(Reason::NoRecipe),
    }
}

/// The recipe for an agent, on a Headroom answering on `port`.
///
/// **Claude Code.** `ENABLE_TOOL_SEARCH=true` is not decoration: behind
/// a custom base URL Claude Code otherwise loads every tool schema into
/// context (Headroom #746), which spends more than compression saves.
/// The session is tagged through a header rather than a `/p/` prefix
/// because the header is what Claude Code can be given without changing
/// the URL its OAuth login is checked against.
pub fn recipe(
    agent: Agent,
    port: u16,
    session_id: &str,
    inherited_headers: Option<&str>,
) -> Option<Recipe> {
    match agent {
        Agent::ClaudeCode => Some(Recipe {
            env: vec![
                (CLAUDE_BASE_URL.to_string(), base_url(port)),
                (CLAUDE_TOOL_SEARCH.to_string(), "true".to_string()),
                (CLAUDE_HEADERS.to_string(), claude_headers(inherited_headers, session_id)),
            ],
        }),
        Agent::Codex | Agent::Gemini | Agent::Cursor | Agent::Opencode | Agent::Other => None,
    }
}

/// Where a compressed agent sends its model traffic.
pub fn base_url(port: u16) -> String {
    format!("http://{HOST}:{port}")
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
/// compressed gavin session's environment and nothing else.
///
/// Each entry is a variable and what to leave in it; `None` removes
/// it. The header list keeps the lines that were the human's before
/// the recipe added its own.
pub fn inherited_routing(
    inherited: impl Fn(&str) -> Option<String>,
) -> Vec<(&'static str, Option<String>)> {
    let Some(launcher) = inherited(SESSION_ID).filter(|id| !id.trim().is_empty()) else {
        return Vec::new();
    };
    let headers = inherited(CLAUDE_HEADERS);
    let tagged_as_the_launcher = headers.as_deref().unwrap_or_default().lines().any(|line| {
        let (name, value) = header(line);
        name.eq_ignore_ascii_case(PROJECT_HEADER) && value == launcher.trim()
    });
    if !tagged_as_the_launcher {
        return Vec::new();
    }
    let kept = own_headers(headers.as_deref());
    vec![
        (CLAUDE_BASE_URL, None),
        (CLAUDE_TOOL_SEARCH, None),
        (CLAUDE_HEADERS, (!kept.is_empty()).then(|| kept.join("\n"))),
    ]
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
            inherited_headers: None,
        }
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
        for profile in ["codex", "opencode", "gemini", "custom", "a-profile-from-a-newer-app"] {
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
            let decision = decide(Facts { launch: Launch::Command(line), ..facts() });

            assert!(decision.compressed(), "{line}");
        }
    }

    #[test]
    fn an_mcp_spawn_is_judged_like_the_profile_its_binary_belongs_to() {
        let cursor = decide(Facts { launch: Launch::Command("agent --approve-mcps --trust"), ..facts() });
        let codex = decide(Facts { launch: Launch::Command("codex 'fix it'"), ..facts() });

        assert_eq!(cursor, Decision::Uncompressed(Some(Reason::UnsupportedAgent)));
        assert_eq!(codex, Decision::Uncompressed(Some(Reason::NoRecipe)));
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
            let decision = decide(Facts { launch: Launch::Command(line), ..facts() });

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
        let recipe = recipe(Agent::ClaudeCode, 9, SESSION, None).unwrap();

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
            Agent::Other,
        ] {
            for inherited in [
                None,
                Some(""),
                Some("x-headroom-session-id: theirs"),
                Some("X-Headroom-Session-Id:theirs"),
                Some("  X-HEADROOM-SESSION-ID : theirs  \nX-Team: platform"),
            ] {
                if let Some(recipe) = recipe(agent, PORT, SESSION, inherited) {
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
    }
}
