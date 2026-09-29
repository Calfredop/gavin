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
const ROUTING: [&str; 3] = ["ANTHROPIC_BASE_URL", "ENABLE_TOOL_SEARCH", "ANTHROPIC_CUSTOM_HEADERS"];

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
        Response::SessionCreated { id } => id,
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
