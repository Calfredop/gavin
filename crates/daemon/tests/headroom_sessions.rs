//! Out-of-process coverage for compressed sessions.
//!
//! The decision and the recipe are pure and unit-tested where they live
//! (`headroom/compress.rs`). What is tested here is that they REACH the
//! process: a real `gavin-daemon` under a temp `$HOME`, the fake
//! Headroom where uv would have put it, and sessions whose command
//! writes the environment it was actually born with to a file. A
//! recipe that is decided and recorded and then lost on the way to the
//! PTY is a session marked compressed that is not, and only the
//! process's own account of its environment can tell the two apart.

#![cfg(unix)]

#[path = "fixtures/fake.rs"]
mod fake;

#[path = "fixtures/daemon.rs"]
mod daemon;

use daemon::{kill, unavailable_here, wait_for, Daemon, Machine};
use protocol::{
    read_message, write_message, HeadroomStatus, HeadroomWorkspace, Request, Response,
    SessionSummary,
};
use std::collections::BTreeMap;
use std::io::BufReader;
use std::path::PathBuf;

const CLAUDE_CODE: &str = "claude-code";

/// The three variables the Claude Code recipe sets, and the only ones.
const ROUTING: [&str; 4] =
    ["ANTHROPIC_BASE_URL", "ENABLE_TOOL_SEARCH", "ANTHROPIC_CUSTOM_HEADERS", "GOOGLE_GEMINI_BASE_URL"];

/// The two Gemini logins, as the CLI's user settings select them.
const GEMINI_KEY: &str = r#"{"security":{"auth":{"selectedType":"gemini-api-key"}}}"#;
const GEMINI_LOGIN: &str = r#"{"security":{"auth":{"selectedType":"oauth-personal"}}}"#;

fn gemini_settings(machine: &Machine, text: &str) {
    let dir = machine.home.path().join(".gemini");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("settings.json"), text).unwrap();
}

/// Writes the environment it runs in where the test can read it, and
/// exits. NUL-separated, because a header list is more than one line.
/// Written under another name and renamed, so the test never reads half
/// of it.
const REPORT: &str = r#"env -0 > "$HOME/launch-$GAVIN_SESSION_ID.tmp" && mv "$HOME/launch-$GAVIN_SESSION_ID.tmp" "$HOME/launch-$GAVIN_SESSION_ID.env""#;

fn machine_with_headroom() -> Machine {
    let machine = Machine::new();
    fake::install_into(&machine.uv_bin());
    machine
}

/// A directory to be a workspace, by the one spelling the daemon will
/// resolve it to (`/tmp` is a symlink on macOS).
fn workspace(machine: &Machine, name: &str) -> String {
    let dir = machine.home.path().join(name);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::canonicalize(dir).unwrap().to_string_lossy().into_owned()
}

/// What the app sends whenever a workspace's effective setting changes.
fn switch(daemon: &Daemon, workspaces: &[(&str, bool)]) -> HeadroomStatus {
    daemon.headroom(Request::SetHeadroomWorkspaces {
        workspaces: workspaces
            .iter()
            .map(|(path, enabled)| HeadroomWorkspace {
                workspace_path: path.to_string(),
                enabled: *enabled,
            })
            .collect(),
    })
}

/// A machine whose daemon has one workspace with compression on and a
/// Headroom that is ready for it.
fn compressing() -> (Machine, Daemon, String, u16) {
    let machine = machine_with_headroom();
    let daemon = machine.daemon();
    let root = workspace(&machine, "repo");
    switch(&daemon, &[(&root, true)]);
    let port = daemon.until_ready().port.expect("a ready Headroom has a port");
    (machine, daemon, root, port)
}

/// A session, as the process in it saw itself and as the daemon
/// recorded it.
struct Launched {
    id: String,
    env: BTreeMap<String, String>,
    summary: SessionSummary,
}

impl Launched {
    fn routing(&self) -> Vec<(&str, &str)> {
        ROUTING
            .iter()
            .filter_map(|key| self.env.get(*key).map(|value| (*key, value.as_str())))
            .collect()
    }

    /// The header gavin never sends, looked for everywhere a process
    /// could have been handed it.
    fn mentions_the_session_header(&self) -> bool {
        self.env.iter().any(|(key, value)| {
            key.to_ascii_lowercase().contains("x-headroom-session-id")
                || value.to_ascii_lowercase().contains("x-headroom-session-id")
        })
    }
}

fn created(response: Response) -> String {
    match response {
        Response::SessionCreated { id, .. } => id,
        other => panic!("expected a session, got {other:?}"),
    }
}

fn summary(daemon: &Daemon, id: &str) -> SessionSummary {
    match daemon.ask(Request::ListSessions) {
        Response::SessionList { sessions } => sessions
            .into_iter()
            .find(|session| session.id == id)
            .unwrap_or_else(|| panic!("the daemon lists no session {id}")),
        other => panic!("expected the sessions, got {other:?}"),
    }
}

fn reported(machine: &Machine, daemon: &Daemon, id: String) -> Launched {
    let report: PathBuf = machine.home.path().join(format!("launch-{id}.env"));
    let body = wait_for("the session to report its environment", || std::fs::read(&report).ok());
    let env = String::from_utf8_lossy(&body)
        .split('\0')
        .filter_map(|entry| entry.split_once('='))
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect();
    let summary = summary(daemon, &id);
    Launched { id, env, summary }
}

/// A launch from the app: `profile` is the agent profile doing the
/// launching, and `None` is a plain shell tab running a command.
fn launch_in(
    machine: &Machine,
    daemon: &Daemon,
    root: &str,
    cwd: &str,
    profile: Option<&str>,
) -> Launched {
    launch_line(machine, daemon, root, cwd, REPORT, profile, None)
}

/// A launch of any line, with the custom agent's API family if the app
/// named one.
fn launch_line(
    machine: &Machine,
    daemon: &Daemon,
    root: &str,
    cwd: &str,
    line: &str,
    profile: Option<&str>,
    api_family: Option<&str>,
) -> Launched {
    let id = created(daemon.ask(Request::CreateSession {
        workspace_path: root.to_string(),
        cwd: cwd.to_string(),
        command: Some(line.to_string()),
        profile_id: profile.map(str::to_string),
        api_family: api_family.map(str::to_string),
        without_headroom: false,
    }));
    reported(machine, daemon, id)
}

/// An agent's binary, by name, that reports instead of talking to a
/// model: the arguments it was handed, then its environment.
fn agent_binary(machine: &Machine, name: &str) -> PathBuf {
    let bin = machine.home.path().join("agents");
    std::fs::create_dir_all(&bin).unwrap();
    let script = bin.join(name);
    std::fs::write(
        &script,
        format!("#!/bin/sh\nprintf '%s\\0' \"$@\" > \"$HOME/launch-$GAVIN_SESSION_ID.args\"\n{REPORT}\n"),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    script
}

/// The arguments an `agent_binary` was handed. Written before its
/// environment, so there by the time `reported` has returned.
fn args_of(machine: &Machine, id: &str) -> Vec<String> {
    let body = std::fs::read(machine.home.path().join(format!("launch-{id}.args"))).unwrap();
    String::from_utf8_lossy(&body)
        .split_terminator('\0')
        .map(str::to_string)
        .collect()
}

/// The line the daemon recorded for a session, as a task manager reads
/// it.
fn recorded_command(daemon: &Daemon, id: &str) -> Option<String> {
    match daemon.ask(Request::SessionProcesses) {
        Response::SessionProcessList { processes } => processes
            .into_iter()
            .find(|process| process.session_id == id)
            .unwrap_or_else(|| panic!("the daemon lists no session {id}"))
            .command,
        other => panic!("expected the processes, got {other:?}"),
    }
}

fn launch(machine: &Machine, daemon: &Daemon, root: &str, profile: Option<&str>) -> Launched {
    launch_in(machine, daemon, root, root, profile)
}

#[test]
fn turning_compression_on_starts_headroom_and_turning_the_last_workspace_off_stops_it() {
    if unavailable_here() {
        return;
    }
    let machine = machine_with_headroom();
    let daemon = machine.daemon();
    let one = workspace(&machine, "one");
    let two = workspace(&machine, "two");
    assert!(!daemon.status().wanted, "nothing is on, so nothing is started");

    let on = switch(&daemon, &[(&one, true), (&two, false)]);
    assert!(on.wanted);
    let pid = wait_for("Headroom to be started", || {
        daemon.status().ready.then(|| machine.pid()).flatten()
    });

    // Another workspace turns it on and the first turns it off: one is
    // still on, so the proxy every one of its agents talks through stays.
    let still = switch(&daemon, &[(&one, false), (&two, true)]);
    assert!(still.wanted);
    assert!(still.running);
    assert_eq!(machine.pid(), Some(pid), "the same Headroom, not a restart");

    let off = switch(&daemon, &[(&one, false), (&two, false)]);
    assert!(!off.wanted);
    assert!(!off.running);
    assert!(!daemon::alive(pid));
    assert_eq!(fake::launches(&machine.workspace()).len(), 1);
}

#[test]
fn a_claude_code_launch_in_a_compressed_workspace_is_routed_through_headroom() {
    if unavailable_here() {
        return;
    }
    let (machine, daemon, root, port) = compressing();

    let session = launch(&machine, &daemon, &root, Some(CLAUDE_CODE));

    assert_eq!(
        session.routing(),
        [
            ("ANTHROPIC_BASE_URL", format!("http://127.0.0.1:{port}").as_str()),
            ("ENABLE_TOOL_SEARCH", "true"),
            ("ANTHROPIC_CUSTOM_HEADERS", format!("X-Headroom-Project: {}", session.id).as_str()),
        ]
    );
    assert!(!session.mentions_the_session_header());
    assert_eq!(session.env.get("GAVIN_SESSION_ID"), Some(&session.id), "the tag is this session's id");
    assert!(session.summary.compressed);
    assert_eq!(session.summary.uncompressed_reason, None);
}

/// A rail launches its agent in a worktree, and the workspace it belongs
/// to is the one whose setting counts.
#[test]
fn the_workspace_a_session_belongs_to_decides_not_the_directory_it_runs_in() {
    if unavailable_here() {
        return;
    }
    let (machine, daemon, root, _port) = compressing();
    let worktree = workspace(&machine, "elsewhere/worktree");
    let other = workspace(&machine, "other");
    switch(&daemon, &[(&root, true), (&other, false)]);

    let in_a_worktree = launch_in(&machine, &daemon, &root, &worktree, Some(CLAUDE_CODE));
    let in_the_other = launch_in(&machine, &daemon, &other, &root, Some(CLAUDE_CODE));
    let spelled_otherwise =
        launch_in(&machine, &daemon, &format!("{root}/"), &root, Some(CLAUDE_CODE));

    assert!(in_a_worktree.summary.compressed);
    assert_eq!(in_a_worktree.routing().len(), 3);
    assert!(!in_the_other.summary.compressed);
    assert_eq!(in_the_other.summary.uncompressed_reason, None, "off is not an exception");
    assert!(in_the_other.routing().is_empty());
    assert!(spelled_otherwise.summary.compressed, "a trailing slash is the same workspace");
}

#[test]
fn a_plain_shell_tab_in_a_compressed_workspace_is_left_alone() {
    if unavailable_here() {
        return;
    }
    let (machine, daemon, root, _port) = compressing();

    let shell = launch(&machine, &daemon, &root, None);

    assert!(shell.routing().is_empty(), "a shell was handed {:?}", shell.routing());
    assert!(!shell.summary.compressed);
    assert_eq!(shell.summary.uncompressed_reason, None);
}

#[test]
fn an_agent_gavin_cannot_route_launches_uncompressed_and_says_which_kind_it_is() {
    if unavailable_here() {
        return;
    }
    let (machine, daemon, root, _port) = compressing();

    for (profile, reason) in [("cursor", "unsupported-agent"), ("gemini", "no-recipe")] {
        let session = launch(&machine, &daemon, &root, Some(profile));

        assert!(session.routing().is_empty(), "{profile}");
        assert!(!session.summary.compressed, "{profile}");
        assert_eq!(session.summary.uncompressed_reason.as_deref(), Some(reason), "{profile}");
    }
}

/// Gemini is the one agent whose recipe depends on how the human logged
/// in: an API key is routed, Login with Google is not (headroom-07).
#[test]
fn gemini_is_compressed_on_an_api_key_and_left_alone_on_login_with_google() {
    if unavailable_here() {
        return;
    }
    let (machine, daemon, root, port) = compressing();

    gemini_settings(&machine, GEMINI_LOGIN);
    let login = launch(&machine, &daemon, &root, Some("gemini"));
    assert!(login.routing().is_empty(), "{:?}", login.routing());
    assert_eq!(login.summary.uncompressed_reason.as_deref(), Some("no-recipe"));
    assert!(!login.env.contains_key("CODE_ASSIST_ENDPOINT"));

    gemini_settings(&machine, GEMINI_KEY);
    let key = launch(&machine, &daemon, &root, Some("gemini"));
    assert!(key.summary.compressed);
    assert_eq!(
        key.routing(),
        [("GOOGLE_GEMINI_BASE_URL", format!("http://127.0.0.1:{port}/p/{}", key.id).as_str())]
    );
    assert!(!key.env.contains_key("CODE_ASSIST_ENDPOINT"));
}

/// Compression never stops a launch. A Headroom that is installed and
/// still loading is the ordinary case of it: the daemon was told to
/// start it a moment ago.
#[test]
fn a_launch_before_headroom_is_ready_goes_ahead_uncompressed_and_says_why() {
    if unavailable_here() {
        return;
    }
    let machine = machine_with_headroom();
    let daemon = machine.daemon_with(&[("FAKE_HEADROOM_READY_AFTER_MS", "600000")]);
    let root = workspace(&machine, "repo");
    let status = switch(&daemon, &[(&root, true)]);
    assert!(status.wanted);
    wait_for("Headroom to be running and not yet ready", || {
        let status = daemon.status();
        (status.running && !status.ready).then_some(())
    });

    let session = launch(&machine, &daemon, &root, Some(CLAUDE_CODE));

    assert!(session.routing().is_empty(), "pointed at a proxy that is not answering");
    assert!(!session.summary.compressed);
    assert_eq!(session.summary.uncompressed_reason.as_deref(), Some("not-ready"));
}

/// A workspace with compression on and no Headroom on the machine at
/// all: the same answer, for the same reason.
#[test]
fn a_launch_on_a_machine_with_no_headroom_goes_ahead_uncompressed() {
    if unavailable_here() {
        return;
    }
    let machine = Machine::new();
    let daemon = machine.daemon();
    let root = workspace(&machine, "repo");
    switch(&daemon, &[(&root, true)]);

    let session = launch(&machine, &daemon, &root, Some(CLAUDE_CODE));

    assert!(session.routing().is_empty());
    assert_eq!(session.summary.uncompressed_reason.as_deref(), Some("not-ready"));
}

/// Resume, relaunch, the fallback chain and auto-resume all reach the
/// daemon as a fresh `CreateSession`. Nothing of the session before it
/// is consulted, in either direction.
#[test]
fn a_resumed_session_is_decided_against_headroom_as_it_is_at_that_moment() {
    if unavailable_here() {
        return;
    }
    let (machine, daemon, root, port) = compressing();
    let first = launch(&machine, &daemon, &root, Some(CLAUDE_CODE));
    assert!(first.summary.compressed);

    // Headroom goes, and cannot come back: its file is gone.
    let installed = machine.uv_bin().join(fake::NAME);
    std::fs::remove_file(&installed).unwrap();
    kill(machine.pid().unwrap());
    wait_for("the daemon to notice Headroom is gone", || (!daemon.status().ready).then_some(()));

    let resumed = launch(&machine, &daemon, &root, Some(CLAUDE_CODE));

    assert!(resumed.routing().is_empty(), "resumed into a proxy that is gone");
    assert!(!resumed.summary.compressed);
    assert_eq!(resumed.summary.uncompressed_reason.as_deref(), Some("not-ready"));
    // The first session's record is its own: its process still carries
    // the routing it was born with.
    assert!(summary(&daemon, &first.id).compressed);

    // And back. The next resume is compressed, under its own id.
    fake::install_into(&machine.uv_bin());
    daemon.headroom(Request::DetectHeadroom { located_path: None });
    assert_eq!(daemon.until_ready().port, Some(port), "on the port the survivors were given");

    let again = launch(&machine, &daemon, &root, Some(CLAUDE_CODE));

    assert!(again.summary.compressed);
    assert_eq!(
        again.env.get("ANTHROPIC_CUSTOM_HEADERS").map(String::as_str),
        Some(format!("X-Headroom-Project: {}", again.id).as_str())
    );
    assert_ne!(again.id, first.id);
}

/// The reason the daemon keeps a copy at all: it restarts before any
/// app connects, and the first thing to reach it may be an agent.
#[test]
fn the_daemons_copy_of_the_switch_survives_a_restart() {
    if unavailable_here() {
        return;
    }
    let (machine, daemon, root, port) = compressing();
    let other = workspace(&machine, "other");
    switch(&daemon, &[(&root, true), (&other, false)]);

    daemon.crash();
    let next = machine.daemon();

    // Nobody has told this daemon anything.
    let status = next.until_ready();
    assert!(status.wanted);
    assert_eq!(status.port, Some(port));
    let session = launch(&machine, &next, &root, Some(CLAUDE_CODE));
    let elsewhere = launch(&machine, &next, &other, Some(CLAUDE_CODE));
    assert!(session.summary.compressed);
    assert_eq!(session.routing().len(), 3);
    assert!(!elsewhere.summary.compressed);
    assert!(elsewhere.routing().is_empty());
}

/// Setting the variable replaces what the session would have inherited,
/// so the human's own headers have to be carried over -- and the one
/// header gavin never sends is dropped even when it was theirs.
#[test]
fn a_compressed_session_keeps_the_humans_own_headers_and_never_the_session_id_one() {
    if unavailable_here() {
        return;
    }
    let machine = machine_with_headroom();
    let daemon = machine.daemon_with(&[(
        "ANTHROPIC_CUSTOM_HEADERS",
        "X-Team: platform\nx-headroom-session-id: theirs",
    )]);
    let root = workspace(&machine, "repo");
    switch(&daemon, &[(&root, true)]);
    daemon.until_ready();

    let session = launch(&machine, &daemon, &root, Some(CLAUDE_CODE));

    assert_eq!(
        session.env.get("ANTHROPIC_CUSTOM_HEADERS").map(String::as_str),
        Some(format!("X-Team: platform\nX-Headroom-Project: {}", session.id).as_str())
    );
    assert!(!session.mentions_the_session_header());
}

/// The dev loop on this project: an agent runs the app, the app starts
/// the daemon, and the agent's session was compressed. Its routing
/// comes down that chain into the daemon's own environment, and must
/// stop there.
#[test]
fn a_daemon_started_from_a_compressed_session_does_not_pass_its_routing_on() {
    if unavailable_here() {
        return;
    }
    let machine = machine_with_headroom();
    let daemon = machine.daemon_with(&[
        ("GAVIN_SESSION_ID", "the-launcher"),
        ("ANTHROPIC_BASE_URL", "http://127.0.0.1:1"),
        ("ENABLE_TOOL_SEARCH", "true"),
        ("ANTHROPIC_CUSTOM_HEADERS", "X-Team: platform\nX-Headroom-Project: the-launcher"),
    ]);
    let root = workspace(&machine, "repo");
    let off = workspace(&machine, "off");
    switch(&daemon, &[(&root, true), (&off, false)]);
    let port = daemon.until_ready().port.unwrap();

    let shell = launch(&machine, &daemon, &root, None);
    let uncompressed = launch(&machine, &daemon, &off, Some(CLAUDE_CODE));
    let compressed = launch(&machine, &daemon, &root, Some(CLAUDE_CODE));

    // Neither of these was ever a candidate, and neither is routed: what
    // they keep of the launcher's environment is the human's own header.
    for session in [&shell, &uncompressed] {
        assert_eq!(
            session.routing(),
            [("ANTHROPIC_CUSTOM_HEADERS", "X-Team: platform")],
            "session {} inherited the launcher's routing",
            session.id
        );
        assert!(!session.summary.compressed);
    }
    // And the one that is compressed is routed as itself.
    assert_eq!(
        compressed.routing(),
        [
            ("ANTHROPIC_BASE_URL", format!("http://127.0.0.1:{port}").as_str()),
            ("ENABLE_TOOL_SEARCH", "true"),
            (
                "ANTHROPIC_CUSTOM_HEADERS",
                format!("X-Team: platform\nX-Headroom-Project: {}", compressed.id).as_str()
            ),
        ]
    );
}

/// The human's own routing is configuration a terminal keeps. Gavin
/// adds a recipe to the sessions it compresses and takes nothing away
/// from the ones it does not.
#[test]
fn a_session_that_is_not_compressed_keeps_the_routing_the_human_gave_it() {
    if unavailable_here() {
        return;
    }
    let machine = Machine::new();
    let daemon = machine.daemon_with(&[
        ("ANTHROPIC_BASE_URL", "https://gateway.example.com"),
        ("ANTHROPIC_CUSTOM_HEADERS", "X-Team: platform"),
    ]);
    let root = workspace(&machine, "repo");

    let shell = launch(&machine, &daemon, &root, None);

    assert_eq!(
        shell.routing(),
        [
            ("ANTHROPIC_BASE_URL", "https://gateway.example.com"),
            ("ANTHROPIC_CUSTOM_HEADERS", "X-Team: platform"),
        ]
    );
}

/// A session another agent spawns over MCP never passes through the
/// app, so there is no profile: the command line speaks for itself.
#[test]
fn an_mcp_spawn_of_an_agent_is_compressed_and_one_of_anything_else_is_not() {
    if unavailable_here() {
        return;
    }
    let (machine, daemon, root, port) = compressing();
    for name in ["claude", "codex", "not-an-agent"] {
        agent_binary(&machine, name);
    }
    let bin = machine.home.path().join("agents");
    assert!(matches!(
        daemon.ask(Request::InitGavinRoot {
            root_path: root.clone(),
            workspace_name: "repo".to_string()
        }),
        Response::Ok
    ));
    // Spawning requires the workspace to be open, which is a connection
    // watching it. Held for as long as the spawns take.
    let mut app = daemon.connect();
    write_message(
        &mut app,
        &Request::WatchGavinRoot { workspace_id: "ws-a".to_string(), root_path: root.clone() },
    )
    .unwrap();
    let mut pushes = BufReader::new(app.try_clone().unwrap());
    let first: Response = read_message(&mut pushes).unwrap().unwrap();
    assert!(matches!(first, Response::GavinTreeChanged { .. }), "{first:?}");

    let spawn = |name: &str| {
        created(daemon.ask(Request::SpawnAgentSession {
            root_path: root.clone(),
            cwd: root.clone(),
            command: format!("{} --model opus 'Read the card'", bin.join(name).display()),
        }))
    };
    let agent = reported(&machine, &daemon, spawn("claude"));
    let codex = reported(&machine, &daemon, spawn("codex"));
    let other = reported(&machine, &daemon, spawn("not-an-agent"));

    assert!(agent.summary.compressed);
    assert_eq!(agent.routing().len(), 3);
    assert_eq!(
        agent.env.get("ANTHROPIC_CUSTOM_HEADERS").map(String::as_str),
        Some(format!("X-Headroom-Project: {}", agent.id).as_str())
    );
    assert!(codex.summary.compressed);
    let url = format!("http://127.0.0.1:{port}/p/{}/v1", codex.id);
    assert_eq!(
        args_of(&machine, &codex.id),
        ["-c", &format!("openai_base_url=\"{url}\""), "--model", "opus", "Read the card"]
    );
    assert_eq!(codex.env.get("OPENAI_BASE_URL"), Some(&url));
    assert!(!other.summary.compressed);
    assert_eq!(other.summary.uncompressed_reason, None, "a command is not an agent that failed to compress");
    assert!(other.routing().is_empty());
    assert_eq!(args_of(&machine, &other.id), ["--model", "opus", "Read the card"]);
    drop(app);
}

/// Codex is the one agent the environment alone does not route: its
/// built-in provider reads its base URL only from its config, so the
/// URL goes on the command line as well. What is checked is what the
/// binary was actually handed -- the shell's reading of the line, not
/// the line.
#[test]
fn a_codex_card_run_is_handed_the_base_url_on_its_command_line_and_in_its_environment() {
    if unavailable_here() {
        return;
    }
    let (machine, daemon, root, port) = compressing();
    let codex = agent_binary(&machine, "codex");
    let line = format!("true && {} --model gpt-5.5 'Read the card. It'\\''s codex'", codex.display());

    let session = launch_line(&machine, &daemon, &root, &root, &line, Some("codex"), None);

    let url = format!("http://127.0.0.1:{port}/p/{}/v1", session.id);
    assert!(session.summary.compressed);
    assert_eq!(
        args_of(&machine, &session.id),
        ["-c", &format!("openai_base_url=\"{url}\""), "--model", "gpt-5.5", "Read the card. It's codex"]
    );
    assert_eq!(session.env.get("OPENAI_BASE_URL"), Some(&url));
    // A relaunch built from the record must not carry this session's
    // tag and port into the next one.
    assert_eq!(recorded_command(&daemon, &session.id), Some(line));
}

/// The profile is believed, and the line still has to have a Codex in it
/// to hand the flag to. A session marked compressed that is not would be
/// a lie.
#[test]
fn a_codex_launch_whose_line_runs_no_codex_goes_ahead_uncompressed() {
    if unavailable_here() {
        return;
    }
    let (machine, daemon, root, _port) = compressing();

    let session = launch(&machine, &daemon, &root, Some("codex"));

    assert!(!session.summary.compressed);
    assert_eq!(session.summary.uncompressed_reason.as_deref(), Some("no-recipe"));
    assert_eq!(session.env.get("OPENAI_BASE_URL"), None);
}

/// Where uv puts Headroom's opencode plugin, relative to the `headroom`
/// the daemon found: the fake is installed straight into the bin
/// directory, so its environment is the one that directory belongs to.
fn install_opencode_plugin(machine: &Machine) -> PathBuf {
    let plugin = machine
        .home
        .path()
        .join(".local/lib/python3.13/site-packages/headroom/providers/opencode/_dist/entry.opencode.js");
    std::fs::create_dir_all(plugin.parent().unwrap()).unwrap();
    std::fs::write(&plugin, "export default async () => ({})\n").unwrap();
    std::fs::canonicalize(plugin).unwrap()
}

#[test]
fn an_opencode_card_run_loads_headroom_s_plugin_for_its_session() {
    if unavailable_here() {
        return;
    }
    let (machine, daemon, root, port) = compressing();
    let plugin = install_opencode_plugin(&machine);

    let session = launch(&machine, &daemon, &root, Some("opencode"));

    assert!(session.summary.compressed);
    let config: serde_json::Value = serde_json::from_str(
        session.env.get("OPENCODE_CONFIG_CONTENT").expect("the recipe reached the process"),
    )
    .expect("OPENCODE_CONFIG_CONTENT is JSON");
    let url = format!("http://127.0.0.1:{port}/p/{}/v1", session.id);
    assert_eq!(config["provider"]["anthropic"]["options"]["baseURL"], url.as_str());
    assert_eq!(config["provider"]["openai"]["options"]["baseURL"], url.as_str());
    assert_eq!(
        config["plugin"],
        serde_json::json!([[
            plugin.to_string_lossy(),
            { "proxyUrl": format!("http://127.0.0.1:{port}"), "project": session.id },
        ]])
    );

    // Without the plugin, Zen and Go never reach Headroom.
    std::fs::remove_file(&plugin).unwrap();
    let without = launch(&machine, &daemon, &root, Some("opencode"));

    assert!(!without.summary.compressed);
    assert_eq!(without.summary.uncompressed_reason.as_deref(), Some("no-recipe"));
    assert_eq!(without.env.get("OPENCODE_CONFIG_CONTENT"), None);
}

#[test]
fn a_custom_agent_is_compressed_only_when_its_api_family_is_named() {
    if unavailable_here() {
        return;
    }
    let (machine, daemon, root, port) = compressing();
    let custom = |family: Option<&str>| {
        launch_line(&machine, &daemon, &root, &root, REPORT, Some("custom"), family)
    };

    let anthropic = custom(Some("anthropic"));
    let openai = custom(Some("openai"));
    let none = custom(None);

    assert!(anthropic.summary.compressed);
    assert_eq!(
        anthropic.env.get("ANTHROPIC_BASE_URL"),
        Some(&format!("http://127.0.0.1:{port}/p/{}", anthropic.id))
    );
    assert_eq!(anthropic.env.get("OPENAI_BASE_URL"), None);
    assert!(openai.summary.compressed);
    assert_eq!(
        openai.env.get("OPENAI_BASE_URL"),
        Some(&format!("http://127.0.0.1:{port}/p/{}/v1", openai.id))
    );
    assert_eq!(openai.env.get("ANTHROPIC_BASE_URL"), None);
    assert!(!none.summary.compressed);
    assert_eq!(none.summary.uncompressed_reason.as_deref(), Some("no-recipe"));
    assert_eq!(none.env.get("ANTHROPIC_BASE_URL"), None);
    assert_eq!(none.env.get("OPENAI_BASE_URL"), None);
}

/// The same leak 02 stopped for Claude Code, one recipe later: a daemon
/// started from inside a compressed Codex or opencode session.
#[test]
fn a_daemon_started_from_a_compressed_codex_or_opencode_session_does_not_pass_its_routing_on() {
    if unavailable_here() {
        return;
    }
    let machine = machine_with_headroom();
    let launcher_opencode = serde_json::json!({
        "provider": { "openai": { "options": { "baseURL": "http://127.0.0.1:1/p/the-launcher/v1" } } },
        "plugin": [[
            "/x/site-packages/headroom/providers/opencode/_dist/entry.opencode.js",
            { "proxyUrl": "http://127.0.0.1:1", "project": "the-launcher" },
        ]],
    })
    .to_string();
    let daemon = machine.daemon_with(&[
        ("GAVIN_SESSION_ID", "the-launcher"),
        ("OPENAI_BASE_URL", "http://127.0.0.1:1/p/the-launcher/v1"),
        ("OPENCODE_CONFIG_CONTENT", &launcher_opencode),
    ]);
    let root = workspace(&machine, "repo");

    let shell = launch(&machine, &daemon, &root, None);

    assert_eq!(shell.env.get("OPENAI_BASE_URL"), None);
    assert_eq!(shell.env.get("OPENCODE_CONFIG_CONTENT"), None);
}

/// What the app sends when its last workspace is closed. The list is
/// replaced, never merged, so an empty one leaves nothing on.
#[test]
fn a_list_naming_no_workspace_turns_compression_off_everywhere() {
    if unavailable_here() {
        return;
    }
    let (machine, daemon, root, _port) = compressing();

    let status = switch(&daemon, &[]);

    assert!(!status.wanted);
    assert!(!status.running);
    let session = launch(&machine, &daemon, &root, Some(CLAUDE_CODE));
    assert!(!session.summary.compressed);
    assert_eq!(session.summary.uncompressed_reason, None);
    assert!(session.routing().is_empty());
}

// --- savings (v49) -----------------------------------------------------

/// Waits for its own go file, so the test can bind it to a card and
/// attach before it ends.
const HELD: &str = r#"while [ ! -e "$HOME/go-$GAVIN_SESSION_ID" ]; do sleep 0.05; done"#;

fn held(daemon: &Daemon, root: &str, profile: Option<&str>) -> String {
    created(daemon.ask(Request::CreateSession {
        workspace_path: root.to_string(),
        cwd: root.to_string(),
        command: Some(HELD.to_string()),
        profile_id: profile.map(str::to_string),
        api_family: None,
        without_headroom: false,
    }))
}

fn release(machine: &Machine, id: &str) {
    std::fs::write(machine.home.path().join(format!("go-{id}")), "").unwrap();
}

fn bind(daemon: &Daemon, root: &str, card: &str, id: &str) {
    match daemon.ask(Request::LinkCardSession {
        workspace_id: "ws-1".into(),
        path: card.into(),
        session_id: id.into(),
        cwd: root.into(),
        command: Some(HELD.into()),
        conversation_id: None,
        launch_cwd: Some(root.into()),
        resume_attempts: None,
        base_sha: None,
    }) {
        Response::Ok => {}
        other => panic!("expected the card bound, got {other:?}"),
    }
}

/// Attaches and drains, on a thread that holds the connection: the pump
/// that sees a session end, and closes its runs, exists only once
/// something has attached.
fn attach(daemon: &Daemon, id: &str) {
    let mut stream = daemon.connect();
    write_message(&mut stream, &Request::Attach { id: id.to_string() }).unwrap();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        while let Ok(Some(_)) = read_message::<_, Response>(&mut reader) {}
    });
}

fn run_of(daemon: &Daemon, card: &str) -> protocol::CardRun {
    match daemon.ask(Request::CardRuns { workspace_id: "ws-1".into(), path: card.into() }) {
        Response::CardRuns { mut runs } => runs.remove(0),
        other => panic!("expected the card's runs, got {other:?}"),
    }
}

/// The snapshot, end to end: the fake's `/stats` names both sessions,
/// and only the one whose agent talked to Headroom keeps what it says.
/// The plain one ends first, and its run is closed before the
/// compressed one is let go, so its "nothing" is a decision already
/// made rather than a snapshot not yet written.
#[test]
fn a_compressed_card_run_keeps_what_headroom_saved_it_and_a_plain_one_keeps_nothing() {
    if unavailable_here() {
        return;
    }
    let machine = machine_with_headroom();
    let per_project = machine.home.path().join("per-project.json");
    let daemon =
        machine.daemon_with(&[("FAKE_HEADROOM_PER_PROJECT_FILE", per_project.to_str().unwrap())]);
    let root = workspace(&machine, "repo");
    switch(&daemon, &[(&root, true)]);
    daemon.until_ready();

    let compressed = held(&daemon, &root, Some(CLAUDE_CODE));
    let plain = held(&daemon, &root, None);
    assert!(summary(&daemon, &compressed).compressed);
    assert!(!summary(&daemon, &plain).compressed);
    let (compressed_card, plain_card) = ("/repo/plans/a.md", "/repo/plans/b.md");
    bind(&daemon, &root, compressed_card, &compressed);
    bind(&daemon, &root, plain_card, &plain);
    std::fs::write(
        &per_project,
        format!(
            r#"{{"{compressed}":{{"requests":37,"tokens_saved":41200,"savings_percent":14.1}},
                "{plain}":{{"requests":5,"tokens_saved":999}}}}"#
        ),
    )
    .unwrap();
    attach(&daemon, &compressed);
    attach(&daemon, &plain);

    release(&machine, &plain);
    let plain_run = wait_for("the plain run to be closed", || {
        let run = run_of(&daemon, plain_card);
        (run.outcome == "exited").then_some(run)
    });
    release(&machine, &compressed);
    let compressed_run = wait_for("the compressed run's snapshot", || {
        let run = run_of(&daemon, compressed_card);
        run.headroom_tokens_saved.is_some().then_some(run)
    });

    assert_eq!(compressed_run.outcome, "exited");
    assert_eq!(compressed_run.headroom_tokens_saved, Some(41_200));
    assert_eq!(compressed_run.headroom_requests, Some(37));
    assert_eq!(plain_run.headroom_tokens_saved, None);
    let plain_run = run_of(&daemon, plain_card);
    assert_eq!(plain_run.headroom_tokens_saved, None, "a plain run is never asked about");
    assert_eq!(plain_run.headroom_requests, None);
    match daemon.ask(Request::HeadroomSavings { since: 0 }) {
        Response::HeadroomSavings { runs } => {
            assert_eq!(runs.len(), 1, "{runs:?}");
            assert_eq!(runs[0].session_id, compressed);
            assert_eq!(runs[0].path, compressed_card);
            assert_eq!(runs[0].tokens_saved, 41_200);
        }
        other => panic!("expected the savings, got {other:?}"),
    }
}

/// Attaches, and returns once the session's pump is reading it: the
/// first Output can only come from the pump, and a session killed before
/// its pump has a reader never reaches the teardown this is about. Then
/// drains, like `attach`.
fn attach_to_a_running_pump(daemon: &Daemon, id: &str) {
    let mut stream = daemon.connect();
    write_message(&mut stream, &Request::Attach { id: id.to_string() }).unwrap();
    let mut reader = BufReader::new(stream);
    loop {
        match read_message::<_, Response>(&mut reader) {
            Ok(Some(Response::Output { .. })) => break,
            Ok(Some(_)) => {}
            other => panic!("the session's pump never forwarded its output: {other:?}"),
        }
    }
    std::thread::spawn(move || while let Ok(Some(_)) = read_message::<_, Response>(&mut reader) {});
}

/// The way an interactive agent actually ends: its tab is closed. The
/// kill drops the session's registry row before the hangup that brings
/// the teardown, so a snapshot decided on that row never happened. The
/// run's history is read straight after the kill, as a card modal open
/// on it would, which can land between the kill and the teardown and
/// abandon the run with no end; either way the snapshot must arrive and
/// be counted. And Headroom stops tracking the session once it has.
#[test]
fn a_compressed_card_run_whose_tab_was_closed_keeps_what_headroom_saved_it() {
    if unavailable_here() {
        return;
    }
    let (_machine, daemon, root, per_project) = counting();
    let id = created(create(&daemon, &root, &format!("echo up; {HELD}"), Some(CLAUDE_CODE), false));
    assert!(summary(&daemon, &id).compressed);
    let card = "/repo/plans/a.md";
    bind(&daemon, &root, card, &id);
    std::fs::write(
        &per_project,
        format!(r#"{{"{id}":{{"requests":37,"tokens_saved":41200,"savings_percent":14.1}}}}"#),
    )
    .unwrap();
    attach_to_a_running_pump(&daemon, &id);

    match daemon.ask(Request::KillSession { id: id.clone() }) {
        Response::Ok => {}
        other => panic!("expected the session killed, got {other:?}"),
    }
    let _ = run_of(&daemon, card);
    let run = wait_for("the closed run's snapshot", || {
        let run = run_of(&daemon, card);
        run.headroom_tokens_saved.is_some().then_some(run)
    });

    assert_eq!(run.headroom_tokens_saved, Some(41_200));
    assert_eq!(run.headroom_requests, Some(37));
    assert!(run.ended_at.is_some(), "a run with a snapshot and no end is never counted: {run:?}");
    match daemon.ask(Request::HeadroomSavings { since: 0 }) {
        Response::HeadroomSavings { runs } => {
            assert_eq!(runs.len(), 1, "{runs:?}");
            assert_eq!(runs[0].session_id, id);
            assert_eq!(runs[0].tokens_saved, 41_200);
        }
        other => panic!("expected the savings, got {other:?}"),
    }
    wait_for("Headroom to stop tracking the closed session", || {
        (reach(&daemon, &id) == "unknown").then_some(())
    });
}

// --- honest failures (v50) ---------------------------------------------

/// A launch as auto-resume makes it, with the override when it relaunches
/// a session that broke on Headroom, and the daemon's whole reply.
fn create(daemon: &Daemon, root: &str, line: &str, profile: Option<&str>, without_headroom: bool) -> Response {
    daemon.ask(Request::CreateSession {
        workspace_path: root.to_string(),
        cwd: root.to_string(),
        command: Some(line.to_string()),
        profile_id: profile.map(str::to_string),
        api_family: None,
        without_headroom,
    })
}

/// The reply to a launch says what was decided about it, so the app can
/// mark it from its first frame.
#[test]
fn a_created_session_says_what_was_decided_about_routing_it() {
    if unavailable_here() {
        return;
    }
    let (_machine, daemon, root, _port) = compressing();

    for (profile, compressed, reason) in [
        (Some(CLAUDE_CODE), true, None),
        (Some("cursor"), false, Some("unsupported-agent")),
        (None, false, None),
    ] {
        match create(&daemon, &root, HELD, profile, false) {
            Response::SessionCreated { id, compressed: said, uncompressed_reason } => {
                assert_eq!(said, compressed, "{profile:?}");
                assert_eq!(uncompressed_reason.as_deref(), reason, "{profile:?}");
                let listed = summary(&daemon, &id);
                assert_eq!((listed.compressed, listed.uncompressed_reason.as_deref()), (said, reason));
            }
            other => panic!("expected a session, got {other:?}"),
        }
    }
}

/// Auto-resume's relaunch of a session that broke on Headroom. Headroom
/// here is READY: the override is for exactly that, a proxy that looks
/// fine and is the one the session just broke on.
#[test]
fn a_relaunch_without_headroom_is_uncompressed_while_headroom_is_ready_and_says_why() {
    if unavailable_here() {
        return;
    }
    let (machine, daemon, root, _port) = compressing();
    assert!(daemon.status().ready);

    let id = match create(&daemon, &root, REPORT, Some(CLAUDE_CODE), true) {
        Response::SessionCreated { id, compressed, uncompressed_reason } => {
            assert!(!compressed);
            assert_eq!(uncompressed_reason.as_deref(), Some("headroom-failed"));
            id
        }
        other => panic!("expected a session, got {other:?}"),
    };
    let session = reported(&machine, &daemon, id);

    assert!(session.routing().is_empty(), "relaunched into the proxy it broke on: {:?}", session.routing());
    assert!(!session.summary.compressed);
    assert_eq!(session.summary.uncompressed_reason.as_deref(), Some("headroom-failed"));
    // And only that launch: the next one is decided as ever.
    let next = launch(&machine, &daemon, &root, Some(CLAUDE_CODE));
    assert!(next.summary.compressed);
}

/// Prints the line Claude Code prints when its connection is refused,
/// once its go file appears, and then sits quiet: a broken agent, as the
/// daemon sees one.
const BREAKS: &str = r#"while [ ! -e "$HOME/go-$GAVIN_SESSION_ID" ]; do sleep 0.05; done; printf 'API Error%s Connection error\n' :; sleep 600"#;

/// The reason the daemon gives when this session breaks: its failure
/// patterns set, attached so its pump runs, then let go.
fn failure_of(machine: &Machine, daemon: &Daemon, id: &str) -> String {
    match daemon.ask(Request::SetFailurePatterns { id: id.to_string(), patterns: vec!["API Error:".into()] }) {
        Response::Ok => {}
        other => panic!("expected the patterns set, got {other:?}"),
    }
    let mut stream = daemon.connect();
    write_message(&mut stream, &Request::Attach { id: id.to_string() }).unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let watched = id.to_string();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        while let Ok(Some(message)) = read_message::<_, Response>(&mut reader) {
            if let Response::SessionFailed { id, reason } = message {
                if id == watched {
                    let _ = tx.send(reason);
                    return;
                }
            }
        }
    });
    release(machine, id);
    rx.recv_timeout(std::time::Duration::from_secs(30)).expect("the session never failed")
}

/// A compressed session that breaks while Headroom fails its health check
/// is Headroom's failure, said in gavin's own words -- the prefix the app
/// classifies as `headroom` and relaunches without it.
#[test]
fn a_compressed_session_that_breaks_while_headroom_fails_its_health_check_is_headroom_s_failure() {
    if unavailable_here() {
        return;
    }
    let machine = machine_with_headroom();
    let broken = machine.home.path().join("headroom-is-broken");
    let daemon =
        machine.daemon_with(&[("FAKE_HEADROOM_UNHEALTHY_FILE", broken.to_str().unwrap())]);
    let root = workspace(&machine, "repo");
    switch(&daemon, &[(&root, true)]);
    daemon.until_ready();
    let id = created(create(&daemon, &root, BREAKS, Some(CLAUDE_CODE), false));
    assert!(summary(&daemon, &id).compressed);

    std::fs::write(&broken, "").unwrap();
    wait_for("the daemon to see Headroom fail", || (!daemon.status().ready).then_some(()));
    let reason = failure_of(&machine, &daemon, &id);

    assert!(reason.starts_with("Headroom stopped answering"), "{reason}");
    assert!(!reason.contains("API Error"), "an older app would read that as the network's: {reason}");
}

/// The other side: Headroom answering, or a session it never carried.
/// Either way the break is what the agent said it was.
#[test]
fn a_break_while_headroom_answers_or_of_a_plain_session_keeps_the_agent_s_own_line() {
    if unavailable_here() {
        return;
    }
    let machine = machine_with_headroom();
    let broken = machine.home.path().join("headroom-is-broken");
    let daemon =
        machine.daemon_with(&[("FAKE_HEADROOM_UNHEALTHY_FILE", broken.to_str().unwrap())]);
    let root = workspace(&machine, "repo");
    switch(&daemon, &[(&root, true)]);
    daemon.until_ready();

    let compressed = created(create(&daemon, &root, BREAKS, Some(CLAUDE_CODE), false));
    assert_eq!(failure_of(&machine, &daemon, &compressed), "API Error: Connection error");

    let plain = created(create(&daemon, &root, BREAKS, None, false));
    std::fs::write(&broken, "").unwrap();
    wait_for("the daemon to see Headroom fail", || (!daemon.status().ready).then_some(()));
    assert_eq!(failure_of(&machine, &daemon, &plain), "API Error: Connection error");
}

fn reach(daemon: &Daemon, id: &str) -> String {
    match daemon.ask(Request::HeadroomReach { session_id: id.to_string() }) {
        Response::HeadroomReach { session_id, reach } => {
            assert_eq!(session_id, id);
            reach
        }
        other => panic!("expected the reach, got {other:?}"),
    }
}

/// A daemon whose fake Headroom reports `per_project` from a file the
/// test writes, with one workspace compressed and ready.
fn counting() -> (Machine, Daemon, String, PathBuf) {
    let machine = machine_with_headroom();
    let per_project = machine.home.path().join("per-project.json");
    let daemon =
        machine.daemon_with(&[("FAKE_HEADROOM_PER_PROJECT_FILE", per_project.to_str().unwrap())]);
    let root = workspace(&machine, "repo");
    switch(&daemon, &[(&root, true)]);
    daemon.until_ready();
    (machine, daemon, root, per_project)
}

/// Headroom's own count is the evidence: nothing counted under the
/// session's tag by the process it was pointed at is a session talking to
/// its model some other way; anything counted settles it for good.
#[test]
fn whether_a_compressed_session_reaches_headroom_is_read_off_headroom_s_own_count() {
    if unavailable_here() {
        return;
    }
    let (_machine, daemon, root, per_project) = counting();
    let id = created(create(&daemon, &root, HELD, Some(CLAUDE_CODE), false));
    assert_eq!(summary(&daemon, &id).headroom_reach, None, "nobody has asked yet");

    assert_eq!(reach(&daemon, &id), "unreached");
    assert_eq!(summary(&daemon, &id).headroom_reach.as_deref(), Some("unreached"));

    std::fs::write(&per_project, format!(r#"{{"{id}":{{"requests":3,"tokens_saved":120}}}}"#)).unwrap();
    assert_eq!(reach(&daemon, &id), "reached");
    assert_eq!(summary(&daemon, &id).headroom_reach.as_deref(), Some("reached"));

    // Settled: an eviction afterwards does not make it a stranger.
    std::fs::write(&per_project, "{}").unwrap();
    assert_eq!(reach(&daemon, &id), "reached");

    // A session that was never compressed has nothing to reach.
    let plain = created(create(&daemon, &root, HELD, None, false));
    assert_eq!(reach(&daemon, &plain), "unknown");
    assert_eq!(summary(&daemon, &plain).headroom_reach, None);
}

/// The two ways Headroom's count loses a session that did reach it. An
/// absence either could explain marks nothing.
#[test]
fn a_session_missing_from_a_full_map_or_from_a_restarted_headroom_is_not_called_unreached() {
    if unavailable_here() {
        return;
    }
    let (machine, daemon, root, per_project) = counting();
    let id = created(create(&daemon, &root, HELD, Some(CLAUDE_CODE), false));

    // Fifty others: Headroom evicts the least saver on every arrival.
    let others: Vec<String> = (0..50)
        .map(|i| format!(r#""other-{i}":{{"requests":1,"tokens_saved":{i}}}"#))
        .collect();
    std::fs::write(&per_project, format!("{{{}}}", others.join(","))).unwrap();
    assert_eq!(reach(&daemon, &id), "unknown");
    assert_eq!(summary(&daemon, &id).headroom_reach, None);

    // A restart: the new process forgot what it had not written down.
    std::fs::write(&per_project, "{}").unwrap();
    let first = machine.pid().unwrap();
    kill(first);
    wait_for("a second Headroom", || {
        machine.pid().filter(|pid| *pid != first && daemon.status().ready)
    });
    assert_eq!(reach(&daemon, &id), "unknown");
    assert_eq!(summary(&daemon, &id).headroom_reach, None);
}
