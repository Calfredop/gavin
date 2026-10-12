//! Agent skills -- Matt Pocock's skills -- status and install, per agent
//! profile.
//!
//! Driven by `docs/superpowers/specs/2026-10-05-mattpocock-skills-install-matrix.md`,
//! which is a record of what was actually run on a machine rather than of
//! what the docs promise. Two rules come straight from it and are the
//! reason this module is shaped the way it is:
//!
//! 1. **Never guess a detector.** A profile gavin cannot check reports
//!    `Unavailable` with the reason, and the UI falls back to the human's
//!    word. A green LED that is a lie is worse than a row admitting it does
//!    not know.
//! 2. **The detector, not the installer, says what happened.** Both
//!    installers can exit non-zero having installed most of what was asked
//!    (the skills CLI does for one unknown skill name), and both can exit
//!    zero into a state gavin does not read. The row is whatever the check
//!    that follows the install finds.
//!
//! Two routes. Claude Code takes the plugin from its official marketplace,
//! a managed bundle that updates itself; the other known agents take the
//! skills CLI's copy into the repo's `.agents/skills/`, which all four read.
//! A custom agent gets neither: gavin does not know its skills CLI id.
//!
//! Subprocesses follow `git/run.rs`'s shape: an argv array (never a shell
//! string), an explicit timeout, and both pipes drained on threads so a
//! chatty child cannot deadlock on a full pipe buffer.
//!
//! The name is generic on purpose: the module is gavin's recommended agent
//! tooling, and the product it recommends has changed once already.

use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, PoisonError, RwLock};
use std::time::{Duration, Instant};

use tauri::Manager;

/// The plugin's package name, marketplace-agnostic: every id comparison is
/// on the part before the `@`, so an install from any marketplace counts.
const PLUGIN_PACKAGE: &str = "mattpocock-skills";

/// The skills CLI's name for the repository, and the `source` every entry
/// it writes into `skills-lock.json` carries.
const SKILLS_SOURCE: &str = "mattpocock/skills";

/// Where the skills CLI puts a project install for every agent gavin sends
/// it -- `codex`, `cursor`, `gemini-cli` and `opencode` all have this as
/// their `skillsDir` in the CLI's own table.
const SKILLS_DIR: &str = ".agents/skills";

/// What Claude Code says when the official marketplace was never added --
/// a Claude Code that has not run interactively on this machine.
const NO_MARKETPLACE: &str = "not found in any configured marketplace";
const ADD_MARKETPLACE: &str = "claude plugin marketplace add anthropics/claude-plugins-official";

/// Detection is a local read or a fast subcommand; 10 s is the same
/// ceiling `git/run.rs` puts on its read-only calls.
const DETECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Both installs fetch over the network -- a marketplace, or a clone of
/// the skills repository. Long, but bounded: the run is hidden, and a
/// hidden run with no ceiling is a spinner with no end.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(180);

/// Every `claude plugin` run gavin makes: a check reads, an install
/// writes.
///
/// A human who leaves Settings mid-install comes back to an Install
/// button, and a second click would start a second install against the
/// same plugin cache -- `~/.claude/plugins`, user-global, so one lock for
/// the machine rather than one per root. A check waits an install out
/// too: asked for during one, its row says "checking" until it can say
/// what the install did.
static CLAUDE_PLUGINS: RwLock<()> = RwLock::new(());

/// Every skills CLI install. Two at once would race to clear and copy the
/// same `.agents/skills/` directories. The check is two file reads and
/// takes no lock: a half-written install reads as whatever it is.
static SKILLS_CLI: Mutex<()> = Mutex::new(());

/// What gavin can say about the skills for one workspace.
///
/// `Asserted` is a separate state, not a second flavour of `Verified`,
/// precisely so the UI can show that this one is somebody's word rather
/// than a result. It is reachable only for a custom agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    /// A detector ran and found the skills active here.
    Verified,
    /// No check could run, but the human said they are installed.
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
    /// What to install with. Runnable by gavin exactly when `installable`;
    /// otherwise the line to run yourself.
    pub command: String,
    /// Whether gavin may run `command` itself.
    pub installable: bool,
    /// Raw evidence, verbatim, for the "Show output" drawer: the
    /// detector's own output, or -- after an install -- that run's stdout
    /// and stderr interleaved. Claude Code puts its failure reason on
    /// stderr and only its progress line on stdout, and the skills CLI
    /// writes its whole report to stderr, so a drawer showing one stream
    /// misreports both.
    pub output: String,
}

/// How a profile gets the skills.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Route {
    /// `claude plugin install|list`.
    Plugin,
    /// `npx skills add … -a <id>`, the id being the skills CLI's name for
    /// the agent -- not gavin's: Gemini is `gemini-cli` there.
    SkillsCli(&'static str),
    /// A custom agent: gavin knows neither its CLI id nor where it reads
    /// skills, so it neither installs nor checks.
    Manual,
}

fn route(profile_id: &str) -> Route {
    match profile_id {
        "claude-code" => Route::Plugin,
        "codex" => Route::SkillsCli("codex"),
        "gemini" => Route::SkillsCli("gemini-cli"),
        "cursor" => Route::SkillsCli("cursor"),
        "opencode" => Route::SkillsCli("opencode"),
        _ => Route::Manual,
    }
}

/// The skills CLI's argv after `npx`. `-y` twice and on purpose: npx's
/// own, so it fetches the package without asking, and the CLI's, so it
/// installs without asking. Neither has a TTY to ask on.
fn skills_cli_args(agent: &str) -> [&str; 9] {
    ["-y", "skills@latest", "add", SKILLS_SOURCE, "--skill", "*", "-a", agent, "-y"]
}

/// The command each profile installs with, as the row shows it. For the
/// two runnable routes it is exactly what gavin runs; for a custom agent
/// it is the interactive form that asks which agent to install for.
fn command_for(profile_id: &str) -> String {
    match route(profile_id) {
        Route::Plugin => format!("claude plugin install {PLUGIN_PACKAGE} --scope project -y"),
        Route::SkillsCli(agent) => {
            format!("npx -y skills@latest add {SKILLS_SOURCE} --skill '*' -a {agent} -y")
        }
        Route::Manual => format!("npx skills@latest add {SKILLS_SOURCE}"),
    }
}

/// A plugin id's package name: everything before the `@` that separates
/// it from its marketplace. Leading `@` (an npm scope) is kept, since a
/// scoped name's separator is the *second* `@`.
fn package_name(id: &str) -> &str {
    let body = id.strip_prefix('@').unwrap_or(id);
    let name = body.split('@').next().unwrap_or(body);
    if id.starts_with('@') {
        &id[..1 + name.len()]
    } else {
        name
    }
}

/// Reads `claude plugin list --json` output. `enabled` is computed by the
/// CLI relative to its own cwd -- and only for the project root itself,
/// not a directory under it -- which is why the caller runs it in the
/// workspace root: that turns "is it installed somewhere" into "would a
/// session started here have it". So no scope arithmetic and no
/// `projectPath` comparison happens here. Nor is `projectEnabled` read:
/// it answers only for the cwd's project settings file.
pub fn claude_list_says_installed(stdout: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(stdout) else {
        return false;
    };
    let Some(entries) = value.as_array() else {
        return false;
    };
    entries.iter().any(|e| {
        e.get("id")
            .and_then(|v| v.as_str())
            .is_some_and(|id| package_name(id) == PLUGIN_PACKAGE)
            && e.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false)
    })
}

/// The skill names a project `skills-lock.json` records as coming from
/// Matt's repository. The lock tracks only the CLI's own installs, so a
/// directory of gavin's own skills beside them is never in it.
///
/// A name that could step out of `.agents/skills/` is dropped rather than
/// joined onto a path: the lock is a file in the repository.
pub fn locked_skills(body: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return Vec::new();
    };
    let Some(skills) = value.get("skills").and_then(|v| v.as_object()) else {
        return Vec::new();
    };
    let mut names: Vec<String> = skills
        .iter()
        .filter(|(_, entry)| entry.get("source").and_then(|v| v.as_str()) == Some(SKILLS_SOURCE))
        .map(|(name, _)| name.clone())
        .filter(|name| !name.is_empty() && name != ".." && !name.contains(['/', '\\']))
        .collect();
    names.sort();
    names
}

/// One child process, run to completion or killed at the deadline.
/// Returns stdout and stderr separately so callers can interleave them
/// for display while still testing an exit code.
///
/// Shared with `agent_playwright.rs`, whose browser install is the same
/// shape of run: a hidden `npx` with a ceiling and a drawer to fill.
#[derive(Debug)]
pub(crate) struct Run {
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) code: i32,
}

impl Run {
    /// Both streams as the drawer shows them, terminal escapes resolved.
    /// stdout first: it carries the progress line Claude's install starts
    /// with, and stderr the reason it stopped.
    pub(crate) fn combined(&self) -> String {
        let mut out = String::new();
        for part in [plain_text(&self.stdout), plain_text(&self.stderr)] {
            let part = part.trim_end();
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

/// A terminal UI's output as the text it leaves on screen. The skills CLI
/// draws with spinners: a frame, then "cursor to column 1, clear to the
/// end", then the next frame, all on one line. Stripping the escapes
/// alone would leave every frame run together; honouring the two that
/// redraw a line leaves the last frame, which is what the human saw.
fn plain_text(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    let clear_line = |out: &mut String| {
        let start = out.rfind('\n').map_or(0, |i| i + 1);
        out.truncate(start);
    };
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => {
                if chars.peek() != Some(&'[') {
                    chars.next();
                    continue;
                }
                chars.next();
                let mut params = String::new();
                let mut last = None;
                for n in chars.by_ref() {
                    if ('@'..='~').contains(&n) {
                        last = Some(n);
                        break;
                    }
                    params.push(n);
                }
                let to_column_one = last == Some('G') && (params.is_empty() || params == "1");
                if to_column_one || matches!(last, Some('J') | Some('K')) {
                    clear_line(&mut out);
                }
            }
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    continue;
                }
                clear_line(&mut out);
            }
            _ => out.push(c),
        }
    }
    out
}

pub(crate) fn run(bin: &str, args: &[&str], cwd: &Path, timeout: Duration) -> Result<Run, String> {
    if !cwd.is_dir() {
        return Err(format!("directory not found: {}", cwd.display()));
    }
    // `bin` is `claude` or `npx`, which on Windows are shims CreateProcess
    // cannot start unresolved.
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

/// The `claude` binary to drive: the launch command the CALLER handed in,
/// else the profile's own. A workspace that points `[agent] command` at a
/// wrapper is still running that harness, and the first token is its
/// executable -- the rest of the line is launch flags that mean nothing to
/// a `plugin` subcommand.
///
/// The command arrives as an argument and is never read from disk here,
/// which is the whole point of the parameter. `.gavin-root/config.toml`
/// ships with the repository, and this function's result is handed
/// straight to `Command::new`: reading `[agent] command` off disk meant a
/// freshly cloned repo could name any executable and have it run the
/// moment the workspace's Home or Settings tab rendered -- no Run click,
/// no confirmation, because `agent_skills_status` fires on render.
///
/// The frontend decides instead, because that is where workspace trust
/// lives (`workspaceTrust.ts`): it passes the resolved command, which is
/// the repo's only once a human has approved it and the profile table's
/// verified one until then. `None` -- an older frontend, or a caller with
/// no workspace -- falls back to the profile, which is always safe.
///
/// The skills CLI route runs `npx`, always: nothing about it is the
/// agent's binary.
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
    match route(profile_id) {
        Route::Plugin => {
            let bin = binary_for(agent_command, profile);
            // cwd is the root, not the app's: `enabled` is answered
            // relative to it, and answering it anywhere else answers a
            // different question.
            let listed = {
                // Nothing lives inside the lock, so a run that panicked
                // holding it left nothing torn behind.
                let _reading = CLAUDE_PLUGINS.read().unwrap_or_else(PoisonError::into_inner);
                run(&bin, &["plugin", "list", "--json"], root, DETECT_TIMEOUT)
            };
            match listed {
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
        Route::SkillsCli(_) => detect_skills_cli(root),
        Route::Manual => Detected {
            installed: None,
            blocked: "gavin does not know which agent a custom profile is to the skills CLI, so \
                      it cannot install or check. Run this in the workspace and pick your agent."
                .to_string(),
            output: String::new(),
        },
    }
}

/// Both halves, because each alone lies. The lock is a repo file and
/// travels with a clone whose `.agents/skills/` may be gitignored -- that
/// is absent, and `npx skills experimental_install` restores it. And a
/// `.agents/skills/` with no lock entry is someone else's skills: gavin
/// installs its own there for Codex.
fn detect_skills_cli(root: &Path) -> Detected {
    let lock = root.join("skills-lock.json");
    let Ok(body) = std::fs::read_to_string(&lock) else {
        return Detected {
            installed: Some(false),
            blocked: String::new(),
            output: format!("{} — no such file", lock.display()),
        };
    };
    let locked = locked_skills(&body);
    let present = locked
        .iter()
        .filter(|name| root.join(SKILLS_DIR).join(name).join("SKILL.md").is_file())
        .count();
    Detected {
        installed: Some(present > 0),
        blocked: String::new(),
        output: format!(
            "{} — {} {SKILLS_SOURCE} skills locked\n{} — {present} of them present",
            lock.display(),
            locked.len(),
            root.join(SKILLS_DIR).display(),
        ),
    }
}

/// Turns a detector's answer plus the human's marker into the row.
/// Separated from `detect` so it can be tested without a machine: the
/// precedence between a check and somebody's word is a decision, and
/// decisions deserve tests more than subprocesses do.
///
/// `asserted` counts only where no detector exists. For the known agents
/// the evidence is machine-true -- the plugin list answers for this
/// machine, and the skill files travel with the repo -- so a word cannot
/// add to it, and an old one left over from a custom profile must not
/// outrank it.
pub fn resolve(
    profile_id: &str,
    installed: Option<bool>,
    blocked: &str,
    asserted: bool,
) -> (State, String) {
    let asserted = asserted && route(profile_id) == Route::Manual;
    match (installed, asserted) {
        (Some(true), _) => (
            State::Verified,
            "Matt Pocock's skills are active for sessions started in this workspace.".to_string(),
        ),
        (_, true) => (
            State::Asserted,
            "You told gavin Matt Pocock's skills are installed. gavin has not confirmed it."
                .to_string(),
        ),
        (Some(false), false) => (
            State::Absent,
            match route(profile_id) {
                Route::Plugin => {
                    "The mattpocock-skills plugin is not enabled for this workspace.".to_string()
                }
                _ => "Matt Pocock's skills are not installed in this workspace.".to_string(),
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
        installable: route(profile_id) != Route::Manual,
        output: found.output,
    }
}

/// Fallback arming names a profile other than the workspace's active
/// agent. Blank/absent overlay reads the root, which is what every
/// existing caller (Settings, Home, agent-change after commit) does.
/// Straight off disk like `agent_setup`'s own readers: this answers a
/// question about the local checkout and needs no daemon, so it keeps
/// working across a version skew that has every `gavin_*` tool failing
/// closed.
fn overlay_profile_id(root: &Path, overlay: Option<&str>) -> String {
    overlay
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| crate::agent_setup::read_profile_id(root))
}

/// Whether the human told gavin this root has the skills installed.
fn said_installed(marks: &crate::session::AgentSkillsMarks, root_path: &str) -> bool {
    matches!(
        marks.0.lock().unwrap().get(root_path),
        Some(crate::config::AgentSkillsMark::Installed)
    )
}

/// `agent_command` is the workspace's RESOLVED launch command -- the
/// repo's `[agent] command` only where the human has approved this
/// workspace's config, and the profile table's own everywhere else. It is
/// a parameter rather than a read because this command runs on a tab
/// render: see `binary_for`.
///
/// `async` + `spawn_blocking`: the Claude Code detector is `claude plugin
/// list`, a Node start measured at 0.48-0.90 s, and this runs on every
/// Settings visit, every workspace or profile change there, and every
/// Home visit to a workspace with no recorded answer. As a plain `fn` each
/// of those froze the window for the whole run. The mark is read before
/// the hand-off because a borrowed `State` cannot follow the work onto
/// the blocking pool.
#[tauri::command]
pub async fn agent_skills_status(
    root_path: String,
    agent_command: Option<String>,
    profile_id: Option<String>,
    marks: tauri::State<'_, crate::session::AgentSkillsMarks>,
) -> Result<Status, String> {
    let asserted = said_installed(&marks, &root_path);
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(&root_path);
        status_for(
            &root,
            &overlay_profile_id(&root, profile_id.as_deref()),
            asserted,
            agent_command.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("the agent skills check did not run: {e}"))
}

/// Runs the install and reports the status that follows it. A non-zero
/// exit is NOT an `Err`: the drawer needs the output either way, and the
/// honest answer to "did that work" is what the detector says next, not
/// what the installer claimed. `Err` is reserved for the cases where no
/// install was attempted at all.
///
/// `async` + `spawn_blocking`: both installs fetch over the network for up
/// to `INSTALL_TIMEOUT`, and as a plain `fn` the window was frozen for all
/// of it. The app handle crosses rather than a borrowed `State` because
/// the mark is read after the run.
#[tauri::command]
pub async fn agent_skills_install(
    app: tauri::AppHandle,
    root_path: String,
    agent_command: Option<String>,
    profile_id: Option<String>,
) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || {
        install(
            &root_path,
            agent_command.as_deref(),
            profile_id.as_deref(),
            &app.state::<crate::session::AgentSkillsMarks>(),
        )
    })
    .await
    .map_err(|e| format!("the agent skills install did not run: {e}"))?
}

fn install(
    root_path: &str,
    agent_command: Option<&str>,
    profile_id: Option<&str>,
    marks: &crate::session::AgentSkillsMarks,
) -> Result<Status, String> {
    let root = PathBuf::from(root_path);
    let profile_id = overlay_profile_id(&root, profile_id);
    let out = match route(&profile_id) {
        Route::Plugin => {
            let bin = binary_for(agent_command, crate::agent_setup::profile_by_id(&profile_id));
            // Released before the check below, which reads under the same
            // lock and would otherwise wait on itself.
            let _writing = CLAUDE_PLUGINS.write().unwrap_or_else(PoisonError::into_inner);
            // `-y` is not optional: the CLI's own help says the
            // confirmation is required when stdin or stdout is not a TTY,
            // and a hidden run has neither.
            run(
                &bin,
                &["plugin", "install", PLUGIN_PACKAGE, "--scope", "project", "-y"],
                &root,
                INSTALL_TIMEOUT,
            )?
        }
        Route::SkillsCli(agent) => {
            let _installing = SKILLS_CLI.lock().unwrap_or_else(PoisonError::into_inner);
            run("npx", &skills_cli_args(agent), &root, INSTALL_TIMEOUT)?
        }
        Route::Manual => {
            let label = crate::agent_setup::profile_by_id(&profile_id).label;
            return Err(format!("gavin cannot install Matt Pocock's skills for {label}."));
        }
    };
    let log = out.combined();
    let asserted = said_installed(marks, root_path);
    let mut status = status_for(&root, &profile_id, asserted, agent_command);
    if out.code != 0 && status.state != State::Verified.id() {
        status.detail = if out.stderr.contains(NO_MARKETPLACE) {
            format!(
                "Claude Code has no official marketplace configured on this machine. Add it \
                 with `{ADD_MARKETPLACE}`, then install again."
            )
        } else {
            format!("Install exited with status {} — see the output.", out.code)
        };
    }
    // The install log, not the detector's: it is what the human asked to
    // see, and it carries the stderr line that says why a failure failed.
    status.output = log;
    Ok(status)
}

/// Whether this root's owner met Superpowers through gavin and has not yet
/// read that gavin recommends something else now. A root with no old mark
/// never sees the note: there is nobody to say goodbye to.
pub fn farewell_due(config: &crate::config::AppConfig, root_path: &str) -> bool {
    config.superpowers.contains_key(root_path)
        && !config.superpowers_farewell_dismissed.iter().any(|r| r == root_path)
}

/// The Settings → Agent section's one-time note. Read off disk on demand:
/// the old marks are not mirrored in managed state (see
/// `AppConfig::superpowers`), and this is one small file read per visit.
#[tauri::command]
pub fn agent_skills_farewell(app_handle: tauri::AppHandle, root_path: String) -> Result<bool, String> {
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let config = crate::config::load(&config_dir).map_err(|e| e.to_string())?;
    Ok(farewell_due(&config, &root_path))
}

/// Dismisses the note for one root, for good. Read, change, write -- the
/// way `typesafe.rs` writes its own field, and for the same reason:
/// `persist_workspaces` carries this field forward from disk rather than
/// from managed state.
#[tauri::command]
pub fn dismiss_agent_skills_farewell(
    app_handle: tauri::AppHandle,
    root_path: String,
) -> Result<(), String> {
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    dismiss_farewell_in(&config_dir, &root_path)
}

fn dismiss_farewell_in(config_dir: &Path, root_path: &str) -> Result<(), String> {
    let mut config = crate::config::load(config_dir).map_err(|e| e.to_string())?;
    if !config.superpowers_farewell_dismissed.iter().any(|r| r == root_path) {
        config.superpowers_farewell_dismissed.push(root_path.to_string());
    }
    crate::config::save(config_dir, &config).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Recorded from `claude plugin list --json` on 2026-10-06, trimmed to
    /// the entries that matter. Fixtures rather than a live call so the
    /// parser is tested even on a machine with no `claude`.
    const CLAUDE_LIST_PROJECT: &str = r#"[
      {"id":"clangd-lsp@claude-plugins-official","version":"1.0.0","scope":"user","enabled":true},
      {"id":"mattpocock-skills@claude-plugins-official","version":"1.2.3","scope":"project",
       "enabled":true,
       "installPath":"/Users/x/.claude/plugins/cache/claude-plugins-official/mattpocock-skills/1.2.3",
       "installedAt":"2026-10-06T06:58:39.045Z","lastUpdated":"2026-10-06T06:58:39.045Z",
       "projectPath":"/private/tmp/p2","projectEnabled":true}
    ]"#;

    /// The same install listed from a sibling directory: the CLI reports
    /// `enabled: false` rather than omitting the entry. This is the whole
    /// reason the detector runs with cwd = the workspace root.
    const CLAUDE_LIST_ELSEWHERE: &str = r#"[
      {"id":"mattpocock-skills@claude-plugins-official","version":"1.2.3","scope":"project",
       "enabled":false,"projectPath":"/private/tmp/p2","projectEnabled":false}
    ]"#;

    /// A project lock as the skills CLI 1.7.0 wrote it, trimmed.
    const LOCK: &str = r#"{
      "version": 1,
      "skills": {
        "ask-matt": {"source":"mattpocock/skills","sourceType":"github",
          "skillPath":"skills/engineering/ask-matt/SKILL.md","computedHash":"16554b78"},
        "tdd": {"source":"mattpocock/skills","sourceType":"github",
          "skillPath":"skills/engineering/tdd/SKILL.md","computedHash":"bf1bf5ff"},
        "frontend-design": {"source":"vercel-labs/agent-skills","sourceType":"github",
          "skillPath":"skills/frontend-design/SKILL.md","computedHash":"00"}
      }
    }"#;

    #[test]
    fn claude_detector_reads_an_enabled_entry() {
        assert!(claude_list_says_installed(CLAUDE_LIST_PROJECT));
    }

    #[test]
    fn claude_detector_treats_a_disabled_entry_as_absent() {
        assert!(!claude_list_says_installed(CLAUDE_LIST_ELSEWHERE));
    }

    /// An install from any marketplace is no less installed.
    #[test]
    fn claude_detector_accepts_any_marketplace() {
        let body = r#"[{"id":"mattpocock-skills@some-mirror","enabled":true}]"#;
        assert!(claude_list_says_installed(body));
    }

    /// A name that merely starts with the package name is a different
    /// plugin, and Superpowers is not these skills.
    #[test]
    fn claude_detector_matches_the_whole_package_name() {
        let body = r#"[{"id":"mattpocock-skills-lite@claude-plugins-official","enabled":true},
                       {"id":"superpowers@claude-plugins-official","enabled":true}]"#;
        assert!(!claude_list_says_installed(body));
    }

    /// An empty list, a crash message where JSON was expected, and an
    /// object instead of an array all mean "not found", never a panic.
    #[test]
    fn claude_detector_survives_output_that_is_not_a_plugin_list() {
        assert!(!claude_list_says_installed("[]"));
        assert!(!claude_list_says_installed(""));
        assert!(!claude_list_says_installed("Error: not logged in"));
        assert!(!claude_list_says_installed(r#"{"id":"mattpocock-skills@x","enabled":true}"#));
    }

    /// Only Matt's entries, by `source` -- another repository's skill in
    /// the same lock is not evidence.
    #[test]
    fn the_lock_names_only_matts_skills() {
        assert_eq!(locked_skills(LOCK), vec!["ask-matt".to_string(), "tdd".to_string()]);
        assert!(locked_skills("").is_empty());
        assert!(locked_skills(r#"{"version":1}"#).is_empty());
        assert!(locked_skills(r#"{"version":1,"skills":[]}"#).is_empty());
    }

    /// The lock is a repository file; a name in it must not be able to
    /// point the presence check outside `.agents/skills/`.
    #[test]
    fn a_lock_name_cannot_leave_the_skills_dir() {
        let body = r#"{"skills":{"../../etc":{"source":"mattpocock/skills"},
                                  "..":{"source":"mattpocock/skills"},
                                  "a\\b":{"source":"mattpocock/skills"}}}"#;
        assert!(locked_skills(body).is_empty());
    }

    fn write_skill(root: &Path, name: &str) {
        let dir = root.join(SKILLS_DIR).join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), "---\nname: x\n---\n").unwrap();
    }

    #[test]
    fn the_cli_route_reads_installed_from_the_lock_and_the_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("skills-lock.json"), LOCK).unwrap();
        write_skill(dir.path(), "tdd");
        let found = detect_skills_cli(dir.path());
        assert_eq!(found.installed, Some(true));
        assert!(found.output.contains("2 mattpocock/skills skills locked"), "{}", found.output);
        assert!(found.output.contains("1 of them present"), "{}", found.output);
    }

    /// A fresh clone: the lock travelled, the gitignored skill directories
    /// did not. Nothing a session could load is there.
    #[test]
    fn a_lock_without_its_files_is_absent() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("skills-lock.json"), LOCK).unwrap();
        assert_eq!(detect_skills_cli(dir.path()).installed, Some(false));
    }

    /// gavin writes its own skills into `.agents/skills/` for Codex. A
    /// directory of skills with no lock entry behind it is not Matt's.
    #[test]
    fn skill_files_without_a_lock_entry_are_absent() {
        let dir = tempfile::tempdir().unwrap();
        write_skill(dir.path(), "gavin");
        write_skill(dir.path(), "tdd");
        let found = detect_skills_cli(dir.path());
        assert_eq!(found.installed, Some(false));
        assert!(found.output.contains("no such file"), "{}", found.output);
    }

    #[test]
    fn every_known_profile_has_an_install_route_and_custom_has_none() {
        assert_eq!(route("claude-code"), Route::Plugin);
        assert_eq!(route("codex"), Route::SkillsCli("codex"));
        assert_eq!(route("gemini"), Route::SkillsCli("gemini-cli"));
        assert_eq!(route("cursor"), Route::SkillsCli("cursor"));
        assert_eq!(route("opencode"), Route::SkillsCli("opencode"));
        assert_eq!(route("custom"), Route::Manual);
        assert_eq!(route("custom-agent"), Route::Manual);
    }

    /// What the row shows is what gavin runs, word for word.
    #[test]
    fn the_shown_command_is_the_run_command() {
        let quoted: Vec<String> = skills_cli_args("gemini-cli")
            .iter().map(|a| if *a == "*" { "'*'".to_string() } else { a.to_string() }).collect();
        assert_eq!(command_for("gemini"), format!("npx {}", quoted.join(" ")));
        assert_eq!(command_for("claude-code"), "claude plugin install mattpocock-skills --scope project -y");
        assert_eq!(command_for("custom"), "npx skills@latest add mattpocock/skills");
    }

    #[test]
    fn a_positive_check_is_verified_even_without_the_human_saying_so() {
        let (state, _) = resolve("claude-code", Some(true), "", false);
        assert_eq!(state, State::Verified);
    }

    /// For a known agent the evidence is machine-true, so a stale word --
    /// left over from when this root ran a custom profile -- must not
    /// light anything.
    #[test]
    fn a_known_agent_ignores_the_humans_word() {
        assert_eq!(resolve("codex", Some(false), "", true).0, State::Absent);
        assert_eq!(resolve("claude-code", None, "claude was not found on PATH", true).0, State::Unavailable);
    }

    #[test]
    fn a_custom_agent_is_unavailable_with_its_reason_until_vouched_for() {
        let dir = tempfile::tempdir().unwrap();
        let status = status_for(dir.path(), "custom", false, None);
        assert_eq!(status.state, "unavailable");
        assert!(!status.installable);
        assert!(status.detail.contains("custom"), "{}", status.detail);
        let (state, detail) = resolve("custom", None, "cannot check", true);
        assert_eq!(state, State::Asserted);
        assert!(detail.contains("not confirmed"), "{detail}");
    }

    #[test]
    fn a_verified_check_outranks_the_humans_word() {
        let (state, _) = resolve("custom", Some(true), "", true);
        assert_eq!(state, State::Verified);
    }

    /// Fallback arming must not read the workspace's active profile when
    /// the caller named a different one -- otherwise arming Codex would
    /// install Claude's plugin.
    #[test]
    fn overlay_profile_id_uses_the_named_profile_not_the_workspace_agent() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(overlay_profile_id(dir.path(), Some("codex")), "codex");
        assert_eq!(overlay_profile_id(dir.path(), Some("  gemini  ")), "gemini");
        assert_eq!(overlay_profile_id(dir.path(), Some("")), "claude-code");
        assert_eq!(overlay_profile_id(dir.path(), None), "claude-code");
        let status = status_for(dir.path(), "codex", false, None);
        assert!(status.installable);
        assert_eq!(status.state, "absent");
        assert!(status.command.contains("-a codex"), "{}", status.command);
    }

    /// The binary is whatever the CALLER named, never what a repo's
    /// config.toml did.
    ///
    /// This is AS-02's fix, and the failure it prevents is silent: this
    /// string reaches `Command::new` from `agent_skills_status`, which the
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

    /// The drawer shows both streams: Claude Code's progress line is on
    /// stdout and its failure reason on stderr, so either alone is a
    /// misleading report.
    #[test]
    fn combined_output_carries_both_streams() {
        let r = Run {
            stdout: "Installing plugin \"mattpocock-skills\"...\n".to_string(),
            stderr: "✘ Failed to install plugin \"mattpocock-skills\": Plugin \"mattpocock-skills\" not found in any configured marketplace\n".to_string(),
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

    /// Recorded from the skills CLI's stderr: colour, hidden cursor, and a
    /// spinner that redraws its line by jumping to column 1 and clearing.
    /// What is left is what the human saw on a terminal.
    #[test]
    fn terminal_output_reads_as_the_screen_did() {
        let raw = "\u{1b}[?25l│\n◒  Cloning repository…\u{1b}[1G\u{1b}[J◐  Cloning repository…\u{1b}[1G\u{1b}[J◇  Repository cloned\n\u{1b}[?25h\u{1b}[38;5;102m$\u{1b}[0m done\r\nnext\r\n";
        assert_eq!(plain_text(raw), "│\n◇  Repository cloned\n$ done\nnext\n");
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
    fn a_custom_profile_has_nothing_to_install() {
        let dir = tempfile::tempdir().unwrap();
        let marks = crate::session::AgentSkillsMarks(std::sync::Mutex::new(Default::default()));
        let err = install(dir.path().to_str().unwrap(), None, Some("custom"), &marks).unwrap_err();
        assert!(err.contains("cannot install"), "{err}");
    }

    /// The note is for people who met Superpowers through gavin, once.
    #[test]
    fn the_farewell_is_targeted_and_dismissed_once() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = crate::config::AppConfig::default();
        config.superpowers.insert("/met".to_string(), crate::config::SuperpowersMark::Skipped);
        crate::config::save(dir.path(), &config).unwrap();

        let loaded = crate::config::load(dir.path()).unwrap();
        assert!(farewell_due(&loaded, "/met"));
        assert!(!farewell_due(&loaded, "/never-met"));

        dismiss_farewell_in(dir.path(), "/met").unwrap();
        dismiss_farewell_in(dir.path(), "/met").unwrap();
        let loaded = crate::config::load(dir.path()).unwrap();
        assert!(!farewell_due(&loaded, "/met"));
        assert_eq!(loaded.superpowers_farewell_dismissed, vec!["/met".to_string()]);
        // The old mark itself stays: an older build sharing this file
        // still reads it as its own setup step's answer.
        assert!(loaded.superpowers.contains_key("/met"));
    }

    /// The one test that talks to a real machine. `#[ignore]`d because a
    /// checkout without Claude Code -- or without the plugin -- is not a
    /// broken build; run it with
    /// `cargo test --lib agent_skills -- --ignored --nocapture` when the
    /// question is whether the DETECTOR still matches the CLI, which is
    /// the only thing the fixtures above cannot answer.
    #[test]
    #[ignore = "requires a machine with Claude Code and the mattpocock-skills plugin enabled"]
    fn live_claude_detector_agrees_with_the_cli() {
        let dir = tempfile::tempdir().unwrap();
        let out = run("claude", &["plugin", "list", "--json"], dir.path(), DETECT_TIMEOUT)
            .expect("claude plugin list");
        assert_eq!(out.code, 0, "{}", out.combined());
        assert!(
            claude_list_says_installed(&out.stdout),
            "expected mattpocock-skills active here; got: {}",
            out.stdout
        );
    }

    /// A stand-in `claude` that logs when each run starts and ends, and
    /// takes long enough that two runs left to themselves overlap. Its
    /// second argument is the subcommand: `install` or `list`.
    #[cfg(unix)]
    fn logging_claude(dir: &Path) -> (String, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let log = dir.join("runs.log");
        let bin = dir.join("claude");
        std::fs::write(
            &bin,
            format!(
                "#!/bin/sh\necho \"start $2\" >> '{0}'\nsleep 0.3\necho \"end $2\" >> '{0}'\necho '[]'\n",
                log.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        (bin.to_str().unwrap().to_string(), log)
    }

    /// Two installs, and a check asked for while they run, never overlap
    /// an install -- checks may overlap each other.
    ///
    /// A human who leaves Settings mid-install comes back to an Install
    /// button, and a second click would start a second install against
    /// the same user-global plugin cache.
    #[cfg(unix)]
    #[test]
    fn claude_plugin_runs_never_overlap_an_install() {
        let dir = tempfile::tempdir().unwrap();
        let (claude, log) = logging_claude(dir.path());
        let root = dir.path().to_str().unwrap();
        let marks = crate::session::AgentSkillsMarks(std::sync::Mutex::new(Default::default()));
        std::thread::scope(|s| {
            for _ in 0..2 {
                s.spawn(|| install(root, Some(&claude), Some("claude-code"), &marks).unwrap());
            }
            s.spawn(|| status_for(dir.path(), "claude-code", false, Some(&claude)));
        });

        let log = std::fs::read_to_string(log).unwrap();
        let (mut installing, mut listing) = (0, 0);
        for line in log.lines() {
            match line {
                "start install" => {
                    assert!(installing == 0 && listing == 0, "an install overlapped a run:\n{log}");
                    installing += 1;
                }
                "end install" => installing -= 1,
                "start list" => {
                    assert_eq!(installing, 0, "a check overlapped an install:\n{log}");
                    listing += 1;
                }
                "end list" => listing -= 1,
                other => panic!("unexpected line {other:?}"),
            }
        }
        // Two installs, each followed by its own check, plus the third.
        assert_eq!(log.lines().filter(|l| *l == "start install").count(), 2, "{log}");
        assert_eq!(log.lines().filter(|l| *l == "start list").count(), 3, "{log}");
    }
}
