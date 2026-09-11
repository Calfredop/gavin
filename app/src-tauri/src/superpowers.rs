//! Superpowers plugin status and install, per agent profile.
//!
//! Driven by `docs/superpowers/specs/2026-09-01-superpowers-install-matrix.md`,
//! which is a record of what was actually run on a machine rather than of
//! what the docs promise. Two rules come straight from it and are the
//! reason this module is shaped the way it is:
//!
//! 1. **Never guess a detector.** A profile whose plugin mechanism gavin
//!    cannot check reports `Unavailable` with the reason, and the UI falls
//!    back to the human's word. A green LED that is a lie is worse than a
//!    row admitting it does not know.
//! 2. **Only Claude Code gets an Install button.** Gemini has a real CLI
//!    command and still does not get one: `gemini extensions install` asks
//!    the human to accept third-party code that rewrites the agent's system
//!    prompt, and there is no `--yes`. Driving it would mean piping `y`
//!    into a security prompt on their behalf -- exactly what choosing the
//!    pre-configured `claude-plugins-official` marketplace avoided for
//!    Claude Code.
//!
//! Subprocesses follow `git/run.rs`'s shape: an argv array (never a shell
//! string), an explicit timeout, and both pipes drained on threads so a
//! chatty child cannot deadlock on a full pipe buffer.

use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

/// The package name, marketplace-agnostic. Upstream documents a second
/// source (`superpowers@superpowers-marketplace`) and a human who
/// installed from there is no less installed, so every id comparison is
/// on the part before the `@`.
const PACKAGE: &str = "superpowers";

/// The marketplace gavin installs from: configured on every Claude Code
/// install, so there is no `marketplace add` and no trust prompt for
/// gavin to answer on the human's behalf (spec S3).
const CLAUDE_PLUGIN_ID: &str = "superpowers@claude-plugins-official";

/// Detection is a local read or a fast subcommand; 10 s is the same
/// ceiling `git/run.rs` puts on its read-only calls.
const DETECT_TIMEOUT: Duration = Duration::from_secs(10);
/// The install fetches a marketplace over the network. Long, but bounded:
/// the run is hidden, and a hidden run with no ceiling is a spinner with
/// no end.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(180);

/// What gavin can say about Superpowers for one workspace.
///
/// `Asserted` outranks a negative check deliberately. gavin's checks
/// answer "is it active in a session started here" and can legitimately
/// miss an install -- a scope it does not read, a harness it cannot
/// query -- whereas the human looked. It is a separate state, not a
/// second flavour of `Verified`, precisely so the UI can show that this
/// one is somebody's word rather than a result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    /// A detector ran and found the plugin active here.
    Verified,
    /// No check found it, but the human said it is installed.
    Asserted,
    /// A detector ran and found nothing.
    Absent,
    /// gavin has no way to check this profile at all.
    Unavailable,
}

impl State {
    fn id(self) -> &'static str {
        match self {
            State::Verified => "verified",
            State::Asserted => "asserted",
            State::Absent => "absent",
            State::Unavailable => "unavailable",
        }
    }
}

/// The status of one workspace, as the frontend sees it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// One of `verified` / `asserted` / `absent` / `unavailable`.
    pub state: String,
    /// One sentence for the row. For `unavailable` this is the reason
    /// gavin cannot check, named rather than implied -- a control that
    /// cannot explain itself is worse than no control.
    pub detail: String,
    /// What to install with. Empty only for `custom`, whose agent gavin
    /// has never heard of. Runnable by gavin exactly when `installable`.
    pub command: String,
    /// Whether gavin may run `command` itself.
    pub installable: bool,
    /// Raw evidence, verbatim, for the "Show output" drawer: the
    /// detector's own output, or -- after an install -- that run's stdout
    /// and stderr interleaved. Claude Code puts its failure reason on
    /// stderr and only its progress line on stdout, so a drawer showing
    /// one stream reports a failure as a truncated success.
    pub output: String,
}

/// What a profile's plugin mechanism lets gavin do.
enum Mechanism {
    /// `claude plugin install|list` -- the verified baseline.
    ClaudeCli,
    /// A user-global extension directory gavin can read but must not
    /// write: `gemini extensions install` is interactive by design.
    GeminiExtensionDir,
    /// A `plugin` array in `opencode.json`, global or project.
    OpencodeConfig,
    /// Installed from inside the agent's own TUI. Nothing to run, nothing
    /// to read -- the string is the reason, shown to the human.
    InTui(&'static str),
    /// `custom`: gavin does not know this agent's plugin mechanism, or
    /// whether it has one.
    Unknown,
}

fn mechanism(profile_id: &str) -> Mechanism {
    match profile_id {
        "claude-code" => Mechanism::ClaudeCli,
        "gemini" => Mechanism::GeminiExtensionDir,
        "opencode" => Mechanism::OpencodeConfig,
        "codex" => Mechanism::InTui(
            "Codex CLI installs plugins from inside its own TUI, so gavin cannot check or run it.",
        ),
        "cursor" => Mechanism::InTui(
            "Cursor installs plugins from its agent chat, so gavin cannot check or run it.",
        ),
        _ => Mechanism::Unknown,
    }
}

/// The paste-able command or instruction per profile, verbatim from
/// upstream's README (and, for opencode, from its `.opencode/INSTALL.md`).
fn command_for(profile_id: &str) -> String {
    match profile_id {
        "claude-code" => {
            format!("claude plugin install {CLAUDE_PLUGIN_ID} --scope project -y")
        }
        "gemini" => "gemini extensions install https://github.com/obra/superpowers".to_string(),
        // Not a shell command: opencode's own instruction is a JSON key.
        // Shown as the line to add rather than dressed up as something
        // runnable, because pretending otherwise is how a copy button
        // produces a paste that fails.
        "opencode" => {
            "Add to the \"plugin\" array in opencode.json, then restart opencode:\n  \"superpowers@git+https://github.com/obra/superpowers.git\""
                .to_string()
        }
        "codex" => "/plugins   → search \"superpowers\" → Install Plugin".to_string(),
        "cursor" => "/add-plugin superpowers".to_string(),
        _ => String::new(),
    }
}

/// A plugin id's package name: everything before the `@` that separates
/// it from its marketplace. Leading `@` (an npm scope) is kept, since a
/// scoped name's separator is the *second* `@`.
fn package_name(id: &str) -> &str {
    let body = id.strip_prefix('@').unwrap_or(id);
    let name = body.split('@').next().unwrap_or(body);
    if id.starts_with('@') {
        // Scoped: the caller wants "@scope/name" to compare unequal to
        // "name", which it does -- return the whole scoped portion.
        &id[..1 + name.len()]
    } else {
        name
    }
}

fn is_superpowers(id: &str) -> bool {
    package_name(id) == PACKAGE
}

/// Reads `claude plugin list --json` output. `enabled` is computed by the
/// CLI relative to its own cwd, which is why the caller runs it in the
/// workspace root: that turns "is it installed somewhere" into "would a
/// session started here have it", which is the question S5 asks. So no
/// scope arithmetic and no `projectPath` comparison happens here -- the
/// CLI already did it.
pub fn claude_list_says_installed(stdout: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(stdout) else {
        return false;
    };
    let Some(entries) = value.as_array() else {
        return false;
    };
    entries.iter().any(|e| {
        e.get("id").and_then(|v| v.as_str()).is_some_and(is_superpowers)
            && e.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false)
    })
}

/// Reads an `opencode.json` body for a `plugin` array entry naming
/// Superpowers. Upstream's spec is `superpowers@git+https://...`, so the
/// match is on the package name and the git spec that follows is ignored.
pub fn opencode_config_says_installed(body: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    value
        .get("plugin")
        .and_then(|v| v.as_array())
        .is_some_and(|list| {
            list.iter()
                .filter_map(|v| v.as_str())
                .any(is_superpowers)
        })
}

/// One child process, run to completion or killed at the deadline.
/// Returns stdout and stderr separately so callers can interleave them
/// for display while still testing an exit code.
#[derive(Debug)]
struct Run {
    stdout: String,
    stderr: String,
    code: i32,
}

impl Run {
    /// Both streams as the drawer shows them. stdout first: it carries
    /// the progress line the command starts with, and stderr the reason
    /// it stopped.
    fn combined(&self) -> String {
        let mut out = String::new();
        for part in [self.stdout.trim_end(), self.stderr.trim_end()] {
            if part.is_empty() {
                continue;
            }
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(part);
        }
        out
    }
}

fn run(bin: &str, args: &[&str], cwd: &Path, timeout: Duration) -> Result<Run, String> {
    if !cwd.is_dir() {
        return Err(format!("directory not found: {}", cwd.display()));
    }
    // `bin` is an agent CLI name (`claude`, `gemini`), which on Windows
    // is an npm shim CreateProcess cannot start unresolved.
    let mut child = crate::program::command(crate::program::resolve_or_name(bin))
        .args(args)
        .current_dir(cwd)
        // Nothing here is interactive, and a child that decides to ask
        // anyway must hit EOF rather than block until the deadline.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                // The first thing that bites a Finder-launched app: its
                // PATH is the stripped login one, not the shell's.
                format!("{bin} was not found on PATH")
            } else {
                format!("failed to run {bin}: {e}")
            }
        })?;

    let mut out_pipe = child.stdout.take().ok_or("stdout unavailable")?;
    let mut err_pipe = child.stderr.take().ok_or("stderr unavailable")?;
    let (out_tx, out_rx) = std::sync::mpsc::channel();
    let (err_tx, err_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = out_pipe.read_to_end(&mut buf);
        let _ = out_tx.send(String::from_utf8_lossy(&buf).into_owned());
    });
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = err_pipe.read_to_end(&mut buf);
        let _ = err_tx.send(String::from_utf8_lossy(&buf).into_owned());
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "{bin} {} timed out after {}s",
                        args.join(" "),
                        timeout.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(format!("failed waiting for {bin}: {e}")),
        }
    };

    Ok(Run {
        stdout: out_rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default(),
        stderr: err_rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default(),
        code: status.code().unwrap_or(-1),
    })
}

/// The binary to drive for a profile: the launch command the CALLER
/// handed in, else the profile's own. A workspace that points `[agent]
/// command` at a wrapper is still running that harness, and the first
/// token is its executable -- the rest of the line is launch flags that
/// mean nothing to a `plugin` subcommand.
///
/// The command arrives as an argument and is never read from disk here,
/// which is the whole point of the parameter. `.gavin-root/config.toml`
/// ships with the repository, and this function's result is handed
/// straight to `Command::new`: reading `[agent] command` off disk meant a
/// freshly cloned repo could name any executable and have it run the
/// moment the workspace's Home or Settings tab rendered -- no Run click,
/// no confirmation, because `superpowers_status` fires on render.
///
/// The frontend decides instead, because that is where workspace trust
/// lives (`workspaceTrust.ts`): it passes the resolved command, which is
/// the repo's only once a human has approved it and the profile table's
/// verified one until then. `None` -- an older frontend, or a caller with
/// no workspace -- falls back to the profile, which is always safe.
fn binary_for(agent_command: Option<&str>, profile: &crate::agent_setup::AgentProfile) -> String {
    agent_command
        .unwrap_or_default()
        .split_whitespace()
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(profile.command)
        .to_string()
}

/// What a detector found, plus whatever it saw while finding out.
struct Detected {
    installed: Option<bool>,
    /// Set when `installed` is None: why gavin cannot answer.
    blocked: String,
    output: String,
}

fn detect(
    root: &Path,
    profile_id: &str,
    profile: &crate::agent_setup::AgentProfile,
    agent_command: Option<&str>,
) -> Detected {
    match mechanism(profile_id) {
        Mechanism::ClaudeCli => {
            let bin = binary_for(agent_command, profile);
            // cwd is the root, not the app's: `enabled` is answered
            // relative to it, and answering it anywhere else answers a
            // different question.
            match run(&bin, &["plugin", "list", "--json"], root, DETECT_TIMEOUT) {
                Ok(r) if r.code == 0 => Detected {
                    installed: Some(claude_list_says_installed(&r.stdout)),
                    blocked: String::new(),
                    output: r.combined(),
                },
                Ok(r) => Detected {
                    installed: None,
                    blocked: format!("`{bin} plugin list` exited with status {}.", r.code),
                    output: r.combined(),
                },
                Err(e) => Detected { installed: None, blocked: e.clone(), output: e },
            }
        }
        Mechanism::GeminiExtensionDir => {
            // Not `gemini extensions list`: it prints to stderr, has no
            // `enabled` field in its JSON, and on a machine with a Gemini
            // auth problem buries the payload under a stack trace.
            // Installs are user-global, so the directory is the whole
            // answer.
            match gemini_extension_dir() {
                Some(dir) => Detected {
                    installed: Some(dir.is_dir()),
                    blocked: String::new(),
                    output: format!("checked {}", dir.display()),
                },
                None => Detected {
                    installed: None,
                    blocked: "gavin could not find your home directory.".to_string(),
                    output: String::new(),
                },
            }
        }
        Mechanism::OpencodeConfig => {
            let mut checked = Vec::new();
            let mut found = false;
            for path in opencode_config_paths(root) {
                let exists = path.is_file();
                let hit = exists
                    && std::fs::read_to_string(&path)
                        .map(|b| opencode_config_says_installed(&b))
                        .unwrap_or(false);
                checked.push(format!(
                    "{} — {}",
                    path.display(),
                    if !exists {
                        "no such file"
                    } else if hit {
                        "lists superpowers"
                    } else {
                        "no superpowers entry"
                    }
                ));
                found |= hit;
            }
            Detected { installed: Some(found), blocked: String::new(), output: checked.join("\n") }
        }
        Mechanism::InTui(reason) => {
            Detected { installed: None, blocked: reason.to_string(), output: String::new() }
        }
        Mechanism::Unknown => Detected {
            installed: None,
            blocked: "gavin does not know how a custom agent installs plugins.".to_string(),
            output: String::new(),
        },
    }
}

fn gemini_extension_dir() -> Option<PathBuf> {
    Some(home_dir()?.join(".gemini").join("extensions").join(PACKAGE))
}

/// The two files opencode reads a `plugin` array from, project first:
/// either one makes the plugin real for a session started in the root.
fn opencode_config_paths(root: &Path) -> Vec<PathBuf> {
    let mut paths = vec![root.join("opencode.json")];
    if let Some(home) = home_dir() {
        paths.push(home.join(".config").join("opencode").join("opencode.json"));
    }
    paths
}

use crate::home::home_dir;

/// Turns a detector's answer plus the human's marker into the row.
/// Separated from `detect` so it can be tested without a machine: the
/// precedence between a check and somebody's word is a decision, and
/// decisions deserve tests more than subprocesses do.
pub fn resolve(
    profile_id: &str,
    installed: Option<bool>,
    blocked: &str,
    asserted: bool,
) -> (State, String) {
    match (installed, asserted) {
        (Some(true), _) => (
            State::Verified,
            "Superpowers is active for sessions started in this workspace.".to_string(),
        ),
        (_, true) => (
            State::Asserted,
            "You told gavin Superpowers is installed. gavin has not confirmed it.".to_string(),
        ),
        (Some(false), false) => (
            State::Absent,
            match profile_id {
                "claude-code" => "Superpowers is not installed for this workspace.".to_string(),
                _ => "gavin found no Superpowers install for this agent.".to_string(),
            },
        ),
        (None, false) => (State::Unavailable, blocked.to_string()),
    }
}

fn status_for(
    root: &Path,
    profile_id: &str,
    asserted: bool,
    agent_command: Option<&str>,
) -> Status {
    let profile = crate::agent_setup::profile_by_id(profile_id);
    let found = detect(root, profile_id, profile, agent_command);
    let (state, detail) = resolve(profile_id, found.installed, &found.blocked, asserted);
    Status {
        state: state.id().to_string(),
        detail,
        command: command_for(profile_id),
        installable: matches!(mechanism(profile_id), Mechanism::ClaudeCli),
        output: found.output,
    }
}

/// Reads the profile this root runs. Straight off disk like
/// `agent_setup`'s own readers: this answers a question about the local
/// checkout and needs no daemon, so it keeps working across a version
/// skew that has every `gavin_*` tool failing closed.
fn profile_id_for(root: &Path) -> String {
    crate::agent_setup::read_profile_id(root)
}

/// `agent_command` is the workspace's RESOLVED launch command -- the
/// repo's `[agent] command` only where the human has approved this
/// workspace's config, and the profile table's own everywhere else. It is
/// a parameter rather than a read because this command runs on a tab
/// render: see `binary_for`.
#[tauri::command]
pub fn superpowers_status(
    root_path: String,
    agent_command: Option<String>,
    marks: tauri::State<crate::session::SuperpowersMarks>,
) -> Status {
    let root = PathBuf::from(&root_path);
    let asserted = matches!(
        marks.0.lock().unwrap().get(&root_path),
        Some(crate::config::SuperpowersMark::Installed)
    );
    status_for(&root, &profile_id_for(&root), asserted, agent_command.as_deref())
}

/// Runs the install and reports the status that follows it. A non-zero
/// exit is NOT an `Err`: the drawer needs the output either way, and the
/// honest answer to "did that work" is what the detector says next, not
/// what the installer claimed. `Err` is reserved for the two cases where
/// no install was attempted at all.
#[tauri::command]
pub fn superpowers_install(
    root_path: String,
    agent_command: Option<String>,
    marks: tauri::State<crate::session::SuperpowersMarks>,
) -> Result<Status, String> {
    let root = PathBuf::from(&root_path);
    let profile_id = profile_id_for(&root);
    if !matches!(mechanism(&profile_id), Mechanism::ClaudeCli) {
        let label = crate::agent_setup::profile_by_id(&profile_id).label;
        return Err(format!("gavin cannot install Superpowers for {label}."));
    }
    let bin = binary_for(agent_command.as_deref(), crate::agent_setup::profile_by_id(&profile_id));
    // `-y` is not optional: the CLI's own help says the confirmation is
    // required when stdin or stdout is not a TTY, and a hidden run has
    // neither.
    let out = run(
        &bin,
        &["plugin", "install", CLAUDE_PLUGIN_ID, "--scope", "project", "-y"],
        &root,
        INSTALL_TIMEOUT,
    )?;
    let log = out.combined();
    let asserted = matches!(
        marks.0.lock().unwrap().get(&root_path),
        Some(crate::config::SuperpowersMark::Installed)
    );
    let mut status = status_for(&root, &profile_id, asserted, agent_command.as_deref());
    if out.code != 0 && status.state != State::Verified.id() {
        status.detail = format!("Install exited with status {} — see the output.", out.code);
    }
    // The install log, not the detector's: it is what the human asked to
    // see, and it carries the stderr line that says why a failure failed.
    status.output = log;
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Recorded verbatim from `claude plugin list --json` on 2026-09-02,
    /// trimmed to the entries that matter. Fixtures rather than a live
    /// call so the parser is tested even on a machine with no `claude`.
    const CLAUDE_LIST_INSTALLED: &str = r#"[
      {"id":"clangd-lsp@claude-plugins-official","version":"1.0.0","scope":"user","enabled":true,
       "installPath":"/Users/x/.claude/plugins/cache/claude-plugins-official/clangd-lsp/1.0.0"},
      {"id":"superpowers@claude-plugins-official","version":"6.3.0","scope":"user","enabled":true,
       "installPath":"/Users/x/.claude/plugins/cache/claude-plugins-official/superpowers/6.3.0",
       "installedAt":"2026-05-04T15:00:54.385Z","lastUpdated":"2026-08-17T13:05:39.550Z"}
    ]"#;

    /// The same machine, same command, run from a directory the plugin is
    /// not active in: the CLI reports `enabled: false` rather than
    /// omitting the entry. This is the whole reason the detector runs with
    /// cwd = the workspace root.
    const CLAUDE_LIST_ELSEWHERE: &str = r#"[
      {"id":"superpowers@claude-plugins-official","version":"6.3.0","scope":"local","enabled":false,
       "projectPath":"/Users/x/other-project"}
    ]"#;

    const CLAUDE_LIST_PROJECT_SCOPE: &str = r#"[
      {"id":"superpowers@claude-plugins-official","version":"6.3.0","scope":"user","enabled":true},
      {"id":"superpowers@claude-plugins-official","version":"6.3.0","scope":"project","enabled":true,
       "projectPath":"/private/tmp/probe-proj"}
    ]"#;

    #[test]
    fn claude_detector_reads_an_enabled_entry() {
        assert!(claude_list_says_installed(CLAUDE_LIST_INSTALLED));
        assert!(claude_list_says_installed(CLAUDE_LIST_PROJECT_SCOPE));
    }

    #[test]
    fn claude_detector_treats_a_disabled_entry_as_absent() {
        assert!(!claude_list_says_installed(CLAUDE_LIST_ELSEWHERE));
    }

    /// Upstream documents a second marketplace, and a human who installed
    /// from it is no less installed.
    #[test]
    fn claude_detector_accepts_any_marketplace() {
        let body = r#"[{"id":"superpowers@superpowers-marketplace","enabled":true}]"#;
        assert!(claude_list_says_installed(body));
    }

    /// A name that merely starts with the package name is a different
    /// plugin. `superpowers-lite@x` must not light the LED.
    #[test]
    fn claude_detector_matches_the_whole_package_name() {
        let body = r#"[{"id":"superpowers-lite@claude-plugins-official","enabled":true}]"#;
        assert!(!claude_list_says_installed(body));
    }

    /// An empty list, a crash message where JSON was expected, and an
    /// object instead of an array all mean "not found", never a panic.
    #[test]
    fn claude_detector_survives_output_that_is_not_a_plugin_list() {
        assert!(!claude_list_says_installed("[]"));
        assert!(!claude_list_says_installed(""));
        assert!(!claude_list_says_installed("Error: not logged in"));
        assert!(!claude_list_says_installed(r#"{"id":"superpowers@x","enabled":true}"#));
    }

    #[test]
    fn opencode_detector_reads_the_plugin_array() {
        let body = r#"{"$schema":"https://opencode.ai/config.json",
          "plugin":["superpowers@git+https://github.com/obra/superpowers.git"],
          "model":"anthropic/claude-sonnet-5"}"#;
        assert!(opencode_config_says_installed(body));
    }

    #[test]
    fn opencode_detector_reads_a_config_without_the_key_as_absent() {
        // The real global config on the spike machine: model and provider
        // and no `plugin` at all.
        let body = r#"{"$schema":"https://opencode.ai/config.json","model":"x/y","provider":{}}"#;
        assert!(!opencode_config_says_installed(body));
        assert!(!opencode_config_says_installed(r#"{"plugin":[]}"#));
        assert!(!opencode_config_says_installed(r#"{"plugin":["other@git+https://x"]}"#));
        assert!(!opencode_config_says_installed("not json at all"));
    }

    /// An npm scope's `@` is not the marketplace separator, so a scoped
    /// package must not be mistaken for the bare one.
    #[test]
    fn package_name_keeps_an_npm_scope() {
        assert_eq!(package_name("superpowers@claude-plugins-official"), "superpowers");
        assert_eq!(package_name("superpowers"), "superpowers");
        // The scope stays attached, so a scoped package never collapses
        // onto the bare name it ends with.
        assert_eq!(package_name("@obra/superpowers@git+https://x"), "@obra/superpowers");
        assert!(!is_superpowers("@obra/superpowers"));
        assert!(!is_superpowers("@obra/superpowers@git+https://x"));
    }

    #[test]
    fn a_positive_check_is_verified_even_without_the_human_saying_so() {
        let (state, _) = resolve("claude-code", Some(true), "", false);
        assert_eq!(state, State::Verified);
    }

    /// The human's word outranks a negative check, because gavin's checks
    /// answer "active here" and can legitimately miss an install -- but it
    /// stays a distinct state so the UI never draws it as a result.
    #[test]
    fn the_humans_word_outranks_a_negative_check() {
        let (state, detail) = resolve("claude-code", Some(false), "", true);
        assert_eq!(state, State::Asserted);
        assert!(detail.contains("not confirmed"), "{detail}");
    }

    #[test]
    fn a_verified_check_outranks_the_humans_word() {
        let (state, _) = resolve("claude-code", Some(true), "", true);
        assert_eq!(state, State::Verified);
    }

    /// A profile gavin cannot check reports the reason, and the reason is
    /// the detail the row shows -- never a bare greyed-out control.
    #[test]
    fn an_uncheckable_profile_carries_its_reason() {
        let blocked = "Cursor installs plugins from its agent chat, so gavin cannot check or run it.";
        let (state, detail) = resolve("cursor", None, blocked, false);
        assert_eq!(state, State::Unavailable);
        assert_eq!(detail, blocked);
    }

    #[test]
    fn an_uncheckable_profile_the_human_vouched_for_is_asserted() {
        let (state, _) = resolve("cursor", None, "cannot check", true);
        assert_eq!(state, State::Asserted);
    }

    /// Only Claude Code gets a button. Gemini has a working CLI command
    /// and still does not -- see the module header.
    #[test]
    fn only_claude_code_is_installable() {
        for id in ["claude-code", "codex", "gemini", "cursor", "opencode", "custom"] {
            let installable = matches!(mechanism(id), Mechanism::ClaudeCli);
            assert_eq!(installable, id == "claude-code", "{id}");
        }
    }

    /// The binary is whatever the CALLER named, never what a repo's
    /// config.toml did.
    ///
    /// This is AS-02's fix, and the failure it prevents is silent: this
    /// string reaches `Command::new` from `superpowers_status`, which the
    /// Home and Settings tabs fire on RENDER. Reading `[agent] command`
    /// off disk here meant a cloned repo naming `./scripts/setup.sh` got
    /// it executed by merely opening the workspace -- no Run click, no
    /// confirmation. The frontend passes a command already gated by
    /// workspace trust; `None` falls back to the profile, which is always
    /// gavin's own verified binary.
    #[test]
    fn the_probed_binary_comes_from_the_caller_and_never_from_disk() {
        let profile = crate::agent_setup::profile_by_id("claude-code");
        assert_eq!(binary_for(None, profile), "claude");
        assert_eq!(binary_for(Some(""), profile), "claude");
        assert_eq!(binary_for(Some("   "), profile), "claude");
        // The first token, because the rest of the line is launch flags
        // that mean nothing to a `plugin` subcommand.
        assert_eq!(binary_for(Some("/opt/bin/claude --model opus"), profile), "/opt/bin/claude");

        // And with a hostile config.toml on disk in the cwd's root: the
        // value is not consulted, so it cannot reach Command::new.
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".gavin-root")).unwrap();
        std::fs::write(
            dir.path().join(".gavin-root").join("config.toml"),
            "[agent]\nprofile = \"claude-code\"\ncommand = \"./scripts/pwn.sh\"\n",
        )
        .unwrap();
        assert_eq!(
            crate::agent_setup::root_agent_key(dir.path(), "command").as_deref(),
            Some("./scripts/pwn.sh"),
            "the fixture has to actually carry the key it is testing the absence of"
        );
        assert_eq!(binary_for(None, profile), "claude");
    }

    /// Every profile but `custom` has something for the human to paste.
    #[test]
    fn every_known_profile_offers_a_command() {
        for id in ["claude-code", "codex", "gemini", "cursor", "opencode"] {
            assert!(!command_for(id).is_empty(), "{id}");
        }
        assert!(command_for("custom").is_empty());
    }

    /// The drawer shows both streams: Claude Code's progress line is on
    /// stdout and its failure reason on stderr, so either alone is a
    /// misleading report.
    #[test]
    fn combined_output_carries_both_streams() {
        let r = Run {
            stdout: "Installing plugin \"superpowers@claude-plugins-official\"...\n".to_string(),
            stderr: "✘ Failed to install plugin: not found in marketplace\n".to_string(),
            code: 1,
        };
        let combined = r.combined();
        assert!(combined.contains("Installing plugin"), "{combined}");
        assert!(combined.contains("Failed to install"), "{combined}");
    }

    #[test]
    fn combined_output_of_one_stream_has_no_stray_blank_line() {
        let r = Run { stdout: "done\n".to_string(), stderr: String::new(), code: 0 };
        assert_eq!(r.combined(), "done");
    }

    /// A missing binary is the Finder-launched-app case, and the message
    /// has to name it: an empty PATH failure that reads "failed to run"
    /// sends people looking in the wrong place.
    #[test]
    fn a_missing_binary_names_itself() {
        let dir = tempfile::tempdir().unwrap();
        let err = run("gavin-no-such-binary", &[], dir.path(), DETECT_TIMEOUT).unwrap_err();
        assert!(err.contains("was not found on PATH"), "{err}");
    }

    #[test]
    fn opencode_detection_reads_the_project_config_first() {
        let dir = tempfile::tempdir().unwrap();
        let paths = opencode_config_paths(dir.path());
        assert_eq!(paths[0], dir.path().join("opencode.json"));
    }

    /// The whole point of a detector reading a real file: an opencode
    /// workspace whose own config lists the plugin reads as installed
    /// without any subprocess at all.
    #[test]
    fn opencode_detection_finds_a_project_config() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("opencode.json"),
            r#"{"plugin":["superpowers@git+https://github.com/obra/superpowers.git"]}"#,
        )
        .unwrap();
        let profile = crate::agent_setup::profile_by_id("opencode");
        let found = detect(dir.path(), "opencode", profile, None);
        assert_eq!(found.installed, Some(true));
        assert!(found.output.contains("lists superpowers"), "{}", found.output);
    }

    #[test]
    fn opencode_detection_reports_what_it_looked_at_when_it_finds_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let profile = crate::agent_setup::profile_by_id("opencode");
        let found = detect(dir.path(), "opencode", profile, None);
        assert_eq!(found.installed, Some(false));
        assert!(found.output.contains("opencode.json"), "{}", found.output);
    }

    /// The one test that talks to a real machine. `#[ignore]`d because a
    /// checkout without Claude Code -- or with Superpowers uninstalled --
    /// is not a broken build; run it with
    /// `cargo test --lib superpowers -- --ignored --nocapture` when the
    /// question is whether the DETECTOR still matches the CLI, which is
    /// the only thing the fixtures above cannot answer.
    #[test]
    #[ignore = "requires a machine with Claude Code and Superpowers installed"]
    fn live_claude_detector_agrees_with_the_cli() {
        let dir = tempfile::tempdir().unwrap();
        let out = run("claude", &["plugin", "list", "--json"], dir.path(), DETECT_TIMEOUT)
            .expect("claude plugin list");
        assert_eq!(out.code, 0, "{}", out.combined());
        println!("claude plugin list --json said: {}", claude_list_says_installed(&out.stdout));
        assert!(
            claude_list_says_installed(&out.stdout),
            "expected superpowers active here; got: {}",
            out.stdout
        );
    }

    /// A profile installed from inside its own TUI answers None with a
    /// reason rather than guessing a detector -- the rule this whole
    /// module exists to keep.
    #[test]
    fn an_in_tui_profile_never_guesses() {
        let dir = tempfile::tempdir().unwrap();
        for id in ["codex", "cursor", "custom"] {
            let found = detect(dir.path(), id, crate::agent_setup::profile_by_id(id), None);
            assert_eq!(found.installed, None, "{id}");
            assert!(!found.blocked.is_empty(), "{id}");
        }
    }
}
