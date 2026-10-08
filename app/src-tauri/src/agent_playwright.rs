//! Playwright for gavin's agents -- the real browser an agent drives
//! through Microsoft's `@playwright/mcp` -- installed per workspace, for
//! every stock agent profile.
//!
//! Three things have to be true on the machine the agents run on, and
//! the setup step checks each of them:
//!
//! 1. **`npx` starts.** The `gavin-mcp playwright` shim runs the pinned
//!    MCP through it, so Node is a prerequisite. The step detects it and
//!    does not install it.
//! 2. **The browser is installed.** Playwright's Chrome Headless Shell,
//!    at the revision the pinned MCP brings, sits finished (its
//!    `INSTALLATION_COMPLETE` marker written) in Playwright's own cache.
//!    The daemon launches it once for each agent session.
//! 3. **The entry is there.** A `playwright` server in this profile's MCP
//!    config -- the file and dialect gavin writes its own `gavin` entry
//!    to -- running gavin's own command with the argument `playwright`.
//!
//! The pin and the cache rules are `protocol::playwright`'s, and nothing
//! here repeats them. Design and evidence:
//! `docs/superpowers/specs/2026-10-08-playwright-integration-design.md`.
//!
//! `agent_skills.rs`'s two rules hold here unchanged. **Never guess a
//! detector:** gavin does not know where a custom agent reads MCP config,
//! so a custom profile reports `unavailable` and the step takes the
//! human's word. **The detector, not the installer, says what
//! happened:** the row after an install is whatever the three checks find
//! next, whatever the installer's exit code claimed.
//!
//! An ssh workspace's agents run on the host, so that is where all three
//! answers live. The entry is read and written through the same
//! `WorkspaceFiles` the integration uses, and the browser marker is
//! stat'ed through the host's daemon, which answers for paths outside the
//! root too (`StatWorkspacePaths`). Today's wire has no way to look a
//! program up on the host or to run one there and wait for it, so for an
//! ssh workspace `npx` reads "not checked", and the browser install is
//! named for the human to run on the host; once it is there, Install
//! writes the entry.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use protocol::playwright as pw;
use protocol::HostOs;
use serde::Serialize;
use tauri::Manager;

use crate::agent_setup::{ForeignMcpServer, LocalFiles, ResolvedMcp, WorkspaceFiles};
use crate::agent_skills::Run;

/// The spike measured 19 s for the 208 MB download on a fast line. Ten
/// minutes covers a slow one, and still bounds a hidden run that would
/// otherwise be a spinner with no end.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);

/// One browser install at a time on this machine. Two would download
/// into the same revision folder of the same per-user cache at once.
static BROWSER_INSTALLS: Mutex<()> = Mutex::new(());

/// What gavin can say about Playwright for one workspace. There is no
/// `asserted` here: the human's word is the frontend's to keep, beside
/// their "not now" (`playwrightSetup.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    /// All three checks found what they look for.
    Verified,
    /// A check ran and found something missing.
    Absent,
    /// gavin could not check: a custom agent, an unreadable config, a
    /// cache it cannot look in.
    Unavailable,
}

impl State {
    fn id(self) -> &'static str {
        match self {
            State::Verified => "verified",
            State::Absent => "absent",
            State::Unavailable => "unavailable",
        }
    }
}

/// One of the three checks, as its row shows it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    /// `npx`, `browser` or `entry`.
    pub id: &'static str,
    /// Found, not found, or `None` when gavin could not look.
    pub ok: Option<bool>,
    pub line: String,
}

/// A `playwright` server already in the config that gavin did not write,
/// verbatim, so the human sees what Replace would remove.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub file: String,
    pub command: String,
    pub args: Vec<String>,
}

/// The status of one workspace, as the frontend sees it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// One of `verified` / `absent` / `unavailable`.
    pub state: String,
    /// One sentence for the row: what is missing, or why gavin cannot
    /// tell.
    pub detail: String,
    /// `npx`, `browser`, `entry`, in that order.
    pub checks: Vec<Check>,
    /// The browser install, exactly as gavin runs it.
    pub command: String,
    /// Whether Install would do something here.
    pub installable: bool,
    pub conflict: Option<Conflict>,
    /// The checks' evidence, or -- after an install -- that run's output.
    pub output: String,
}

/// How the rows name a profile gavin has no stock row for. The table's
/// own label for it, "Custom…", is a menu item, not a noun.
const CUSTOM_LABEL: &str = "a custom agent";

/// The machine the agents run on: this one, or an ssh workspace's host.
trait Machine {
    fn files(&self) -> &dyn WorkspaceFiles;
    /// Whether `npx` starts there. `Err` says why gavin cannot tell.
    fn npx(&self) -> Result<bool, String>;
    /// Whether the pinned headless shell is installed there, and where
    /// gavin looked. `Err` says why it could not look.
    fn browser(&self) -> Result<(bool, String), String>;
    /// The gavin-mcp an agent there runs.
    fn mcp_binary(&self) -> Result<PathBuf, String>;
    /// The browser install, run there to completion. `Err` when it could
    /// not be started at all.
    fn install_browser(&self) -> Result<Run, String>;
    /// The host's name, for an ssh workspace.
    fn host(&self) -> Option<&str> {
        None
    }
}

/// `chromium_headless_shell-1247/INSTALLATION_COMPLETE` in Playwright's
/// cache on a machine with this platform, home and environment.
fn marker_path(os: HostOs, home: &Path, env: impl Fn(&str) -> Option<String>) -> PathBuf {
    pw::browsers_dir(os, home, env)
        .join(pw::headless_shell_folder(pw::HEADLESS_SHELL_REVISION))
        .join(pw::INSTALLATION_COMPLETE)
}

/// The install line as the row shows it: `npx` plus the pinned argv.
fn install_command() -> String {
    format!("npx {}", pw::install_args().join(" "))
}

/// Where the install runs: never the workspace. `npx` reads the `.npmrc`
/// and `node_modules` of its cwd, so in the root a cloned repository
/// could name the registry the pinned package is fetched from, or ship a
/// package of that name and version to run in its place, on one click
/// of Install. The browser lands in the per-user cache whatever the cwd.
fn neutral_cwd() -> PathBuf {
    crate::home::home_dir().filter(|home| home.is_dir()).unwrap_or_else(std::env::temp_dir)
}

struct ThisMachine;

impl Machine for ThisMachine {
    fn files(&self) -> &dyn WorkspaceFiles {
        &LocalFiles
    }

    fn npx(&self) -> Result<bool, String> {
        Ok(crate::program::resolve("npx").is_some())
    }

    fn browser(&self) -> Result<(bool, String), String> {
        let home = crate::home::home_dir()
            .ok_or("this account has no home directory to find Playwright's cache under")?;
        let marker = marker_path(HostOs::current(), &home, |name| std::env::var(name).ok());
        Ok((marker.is_file(), protocol::wire_path(&marker)))
    }

    fn mcp_binary(&self) -> Result<PathBuf, String> {
        crate::agent_setup::resolve_mcp_binary_path().map_err(|e| e.to_string())
    }

    fn install_browser(&self) -> Result<Run, String> {
        // Nothing lives inside the lock, so a run that panicked holding
        // it left nothing torn behind.
        let _one_at_a_time = BROWSER_INSTALLS.lock().unwrap_or_else(PoisonError::into_inner);
        let args = pw::install_args();
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        crate::agent_skills::run("npx", &args, &neutral_cwd(), INSTALL_TIMEOUT)
    }
}

/// An ssh workspace's host, reached through its daemon.
struct HostMachine {
    files: crate::remote::RemoteFiles,
}

impl HostMachine {
    fn os(&self) -> HostOs {
        match self.files.link.host_os.as_str() {
            "macos" => HostOs::MacOs,
            "windows" => HostOs::Windows,
            _ => HostOs::Xdg,
        }
    }
}

impl Machine for HostMachine {
    fn files(&self) -> &dyn WorkspaceFiles {
        &self.files
    }

    fn npx(&self) -> Result<bool, String> {
        Err(format!("Node.js (npx) not checked — gavin cannot look up programs on {} from here", self.files.link.host))
    }

    /// At the default location: the host's own environment, which could
    /// move the cache (`PLAYWRIGHT_BROWSERS_PATH`, `XDG_CACHE_HOME`), is
    /// not something this machine can read.
    fn browser(&self) -> Result<(bool, String), String> {
        let link = &self.files.link;
        let marker = protocol::wire_path(&marker_path(self.os(), Path::new(&link.home), |_| None));
        let stat = link
            .stat_paths(&self.files.root, std::slice::from_ref(&marker))
            .map_err(|e| format!("could not ask {} about its browser cache: {e}", link.host))?
            .into_iter()
            .next()
            .ok_or_else(|| format!("{} answered nothing about its browser cache", link.host))?;
        if let Some(reason) = stat.refused_reason {
            return Err(format!("{} refused to look at {marker}: it {reason}", link.host));
        }
        Ok((stat.exists, format!("{}:{marker}", link.host)))
    }

    fn mcp_binary(&self) -> Result<PathBuf, String> {
        let link = &self.files.link;
        link.mcp_path.clone().map(PathBuf::from).ok_or_else(|| {
            format!("gavin-mcp is not beside gavin-daemon on {} — install it there and reconnect", link.host)
        })
    }

    fn install_browser(&self) -> Result<Run, String> {
        Err(format!(
            "gavin cannot run programs on {} from here — run `{}` there, then install again",
            self.files.link.host,
            install_command()
        ))
    }

    fn host(&self) -> Option<&str> {
        Some(&self.files.link.host)
    }
}

/// Whether a server entry is the Playwright step's, exactly as gavin
/// writes it in this root: the key, gavin's own command here
/// (`agent_setup::mcp_command`), and `playwright` as its only argument.
///
/// Exact on purpose, because the AG-07 disclosure and kimi's launch trust
/// read it. The disclosure exists to show what a just-cloned repository
/// would launch beside gavin, and a looser rule -- any binary named
/// `gavin-mcp`, or any extra flags after `playwright` -- would let a repo
/// hide a server behind gavin's name. An entry a human extended with
/// their own flags is still recognised by the step (`read_entry`), and
/// the disclosure shows it to them once.
pub(crate) fn is_gavins_entry(server: &ForeignMcpServer, own_command: &str) -> bool {
    server.name == pw::SUBCOMMAND && server.command == own_command && server.args == [pw::SUBCOMMAND]
}

/// What this profile's MCP config holds under `playwright`.
#[derive(Debug, Clone, PartialEq)]
enum Entry {
    /// gavin's command with `playwright` first: what gavin writes, or
    /// that with flags the human added after it (the shim forwards them).
    Present,
    Absent,
    /// Someone else's `playwright` server.
    Conflict(ForeignMcpServer),
    /// gavin cannot tell, and why.
    Unknown(String),
}

fn read_entry(fs: &dyn WorkspaceFiles, root: &Path, layout: &ResolvedMcp, own: &Result<String, String>) -> Entry {
    let path = root.join(layout.config_file());
    let servers = match crate::agent_setup::mcp_servers_in(fs, &path, layout.format()) {
        Ok(servers) => servers,
        Err(e) => return Entry::Unknown(e.to_string()),
    };
    let Some(server) = servers.into_iter().find(|s| s.name == pw::SUBCOMMAND) else {
        return Entry::Absent;
    };
    match own {
        Ok(own) if server.command == *own && server.args.first().map(String::as_str) == Some(pw::SUBCOMMAND) => {
            Entry::Present
        }
        Ok(_) => Entry::Conflict(server),
        Err(why) => Entry::Unknown(format!(
            "cannot tell whether {}'s `playwright` server is gavin's: {why}",
            layout.config_file()
        )),
    }
}

/// Everything the three checks found, before any of it is judged.
struct Findings {
    npx: Result<bool, String>,
    browser: Result<(bool, String), String>,
    /// The config file and what it holds. `None` for a profile gavin
    /// knows no MCP layout for: a custom agent.
    entry: Option<(String, Entry)>,
    own_command: Result<String, String>,
    profile_label: String,
    host: Option<String>,
}

fn findings(machine: &dyn Machine, root: &Path, profile_id: &str) -> Findings {
    let fs = machine.files();
    let profile = crate::agent_setup::profile_for_writes(profile_id);
    let stock = crate::config::is_stock_profile_id(profile_id);
    let own_command = machine.mcp_binary().map(|binary| crate::agent_setup::mcp_command(fs, root, &binary));
    // A stock profile only: a custom agent's configured `mcp_file` is
    // where gavin's own entry goes, but gavin has never seen that agent
    // start a second server from it, so it does not claim to know.
    let entry = stock
        .then(|| crate::agent_setup::resolved_mcp(fs, root, profile))
        .flatten()
        .map(|layout| (layout.config_file().to_string(), read_entry(fs, root, &layout, &own_command)));
    Findings {
        npx: machine.npx(),
        browser: machine.browser(),
        entry,
        own_command,
        profile_label: if stock { profile.label } else { CUSTOM_LABEL }.to_string(),
        host: machine.host().map(str::to_string),
    }
}

fn server_line(command: &str, args: &[String]) -> String {
    std::iter::once(command).chain(args.iter().map(String::as_str)).collect::<Vec<_>>().join(" ")
}

fn checks(f: &Findings) -> Vec<Check> {
    let npx = match &f.npx {
        Ok(true) => Check { id: "npx", ok: Some(true), line: "Node.js (npx) found".to_string() },
        Ok(false) => Check { id: "npx", ok: Some(false), line: "Node.js (npx) not found on PATH".to_string() },
        Err(why) => Check { id: "npx", ok: None, line: why.clone() },
    };
    let revision = pw::HEADLESS_SHELL_REVISION;
    let browser = match &f.browser {
        Ok((true, at)) => Check {
            id: "browser",
            ok: Some(true),
            line: format!("Chrome Headless Shell r{revision} installed — {at}"),
        },
        Ok((false, at)) => Check {
            id: "browser",
            ok: Some(false),
            line: format!("Chrome Headless Shell r{revision} not installed — {at}"),
        },
        Err(why) => Check { id: "browser", ok: None, line: why.clone() },
    };
    let entry = match &f.entry {
        None => Check {
            id: "entry",
            ok: None,
            line: format!("MCP entry not checked — gavin does not know where {} reads MCP config", f.profile_label),
        },
        Some((file, Entry::Present)) => {
            Check { id: "entry", ok: Some(true), line: format!("`playwright` server in {file}") }
        }
        Some((file, Entry::Absent)) => {
            Check { id: "entry", ok: Some(false), line: format!("no `playwright` server in {file}") }
        }
        Some((file, Entry::Conflict(s))) => Check {
            id: "entry",
            ok: Some(false),
            line: format!("{file}'s `playwright` server runs `{}` — not gavin's", server_line(&s.command, &s.args)),
        },
        Some((_, Entry::Unknown(why))) => Check { id: "entry", ok: None, line: why.clone() },
    };
    vec![npx, browser, entry]
}

/// The findings judged into a row. Separate from the machine so the
/// precedence -- which missing piece the row leads with, and when
/// Install is offered -- is tested without one.
fn assess(f: &Findings) -> Status {
    let command = install_command();
    let checks = checks(f);
    let output = checks.iter().map(|c| c.line.as_str()).collect::<Vec<_>>().join("\n");
    let conflict = match &f.entry {
        Some((file, Entry::Conflict(s))) => {
            Some(Conflict { file: file.clone(), command: s.command.clone(), args: s.args.clone() })
        }
        _ => None,
    };
    let own = f.own_command.as_deref().unwrap_or("gavin-mcp");

    let (state, detail, installable) = match (&f.entry, &f.npx, &f.browser) {
        (None, _, _) => (
            State::Unavailable,
            format!(
                "gavin does not know where {} reads MCP config, so it cannot add the `playwright` server or check for it. \
                 Install the browser with `{command}`, give the agent a server named `playwright` that runs `{own} playwright`, \
                 then tell gavin it is set up.",
                f.profile_label
            ),
            false,
        ),
        (_, Ok(false), _) => (
            State::Absent,
            "Node.js was not found, and Playwright runs through `npx`. Install Node.js, then check again.".to_string(),
            false,
        ),
        (Some((_, Entry::Unknown(why))), _, _) => (State::Unavailable, why.clone(), false),
        (_, _, Err(why)) => (State::Unavailable, format!("gavin cannot check for Playwright's browser: {why}"), false),
        (Some((_, Entry::Present)), _, Ok((true, _))) => (
            State::Verified,
            "Playwright is set up: each agent session started here gets a browser of its own.".to_string(),
            false,
        ),
        _ if f.own_command.is_err() => (
            State::Unavailable,
            f.own_command.clone().err().unwrap_or_default(),
            false,
        ),
        (Some((file, entry)), _, Ok((present, _))) => {
            let entry_gap = match entry {
                Entry::Absent => Some(format!("{file} has no `playwright` server")),
                Entry::Conflict(s) => Some(format!(
                    "{file} already has a `playwright` server gavin did not write (`{}`)",
                    server_line(&s.command, &s.args)
                )),
                _ => None,
            };
            match (&f.host, present) {
                (Some(host), false) => (
                    State::Absent,
                    format!(
                        "Playwright's browser is not installed on {host}. Run `{command}` there, then come back to add the entry."
                    ),
                    false,
                ),
                _ => {
                    let mut gaps = Vec::new();
                    if !present {
                        gaps.push("the browser is not installed".to_string());
                    }
                    gaps.extend(entry_gap);
                    let first = gaps.first().map(String::as_str).map(capitalised).unwrap_or_default();
                    let rest: Vec<&str> = gaps.iter().skip(1).map(String::as_str).collect();
                    let summary = if rest.is_empty() { first } else { format!("{first}, and {}", rest.join(", and ")) };
                    let what = if conflict.is_some() { "Replace swaps it for gavin's" } else { "Install sets it up" };
                    (State::Absent, format!("{summary}. {what}."), true)
                }
            }
        }
    };
    Status { state: state.id().to_string(), detail, checks, command, installable, conflict, output }
}

fn capitalised(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

fn status_for(machine: &dyn Machine, root: &Path, profile_id: &str) -> Status {
    assess(&findings(machine, root, profile_id))
}

/// Installs what is missing, then reports what the checks find next.
///
/// The browser first, and the entry only once the browser is there: an
/// entry with no browser behind it is a server every agent session starts
/// and every one of its calls fails. A browser already installed is not
/// downloaded again. An existing `playwright` server gavin did not write
/// is replaced only when `replace` says the human asked.
///
/// A non-zero exit is not an `Err`, for `agent_skills::install`'s reason:
/// the drawer needs the output either way, and the answer is the
/// detector's. `Err` is kept for the cases where nothing was attempted.
fn install(machine: &dyn Machine, root: &Path, profile_id: &str, replace: bool) -> Result<Status, String> {
    let fs = machine.files();
    if !fs.is_dir(root) {
        return Err(format!("root does not exist: {}", root.display()));
    }
    let profile = crate::agent_setup::profile_for_writes(profile_id);
    let layout = crate::config::is_stock_profile_id(profile_id)
        .then(|| crate::agent_setup::resolved_mcp(fs, root, profile))
        .flatten()
        .ok_or_else(|| {
            format!("gavin cannot install Playwright for {CUSTOM_LABEL}: it does not know where that agent reads MCP config.")
        })?;

    let before = findings(machine, root, profile_id);
    if before.npx == Ok(false) {
        return Ok(assess(&before));
    }
    let mut log = String::new();
    let mut exit = None;
    if !matches!(before.browser, Ok((true, _))) {
        match machine.install_browser() {
            Ok(run) => {
                log = run.combined();
                exit = Some(run.code);
            }
            Err(e) => log = e,
        }
    }

    let mut write_error = None;
    if let (Ok((true, _)), Ok(own)) = (machine.browser(), &before.own_command) {
        // Read again under the integration's lock: a run that started
        // since may have written this file.
        let _one_writer = crate::agent_setup::INTEGRATION_RUNS.lock().unwrap_or_else(PoisonError::into_inner);
        let write = match read_entry(fs, root, &layout, &Ok(own.clone())) {
            Entry::Absent => true,
            Entry::Conflict(_) => replace,
            Entry::Present | Entry::Unknown(_) => false,
        };
        if write {
            let path = root.join(layout.config_file());
            if let Err(e) =
                crate::agent_setup::write_mcp_server(fs, &path, layout.format(), pw::SUBCOMMAND, own, &[pw::SUBCOMMAND])
            {
                write_error = Some(format!("Could not write {}: {e}", protocol::wire_path(&path)));
            }
        }
    }

    let mut status = status_for(machine, root, profile_id);
    if !log.is_empty() {
        status.output = log;
    }
    if status.state != State::Verified.id() {
        if let Some(e) = write_error {
            status.detail = e;
        } else if let Some(code) = exit.filter(|code| *code != 0) {
            status.detail = format!("The browser install exited with status {code} — see the output.");
        }
    }
    Ok(status)
}

/// The machine a root's agents run on.
fn machine_for(app: &tauri::AppHandle, root_path: &str) -> Result<Box<dyn Machine>, String> {
    Ok(match crate::remote::route_for_root(app, Some(root_path))? {
        crate::remote::Route::Remote(link) => {
            Box::new(HostMachine { files: crate::remote::RemoteFiles { link, root: root_path.to_string() } })
        }
        crate::remote::Route::Local => Box::new(ThisMachine),
    })
}

/// The profile named, else the one the root's launches resolve to --
/// `[agent] profile`, then the app's default agent, then claude-code,
/// as `setup_agent_integration` resolves it.
fn profile_id_for(app: &tauri::AppHandle, fs: &dyn WorkspaceFiles, root: &Path, named: Option<&str>) -> String {
    if let Some(named) = named.map(str::trim).filter(|s| !s.is_empty()) {
        return named.to_string();
    }
    let default_agent =
        app.state::<crate::session::AgentDefaults>().0.lock().unwrap().default_agent.clone();
    crate::agent_setup::resolved_profile_id_in(fs, root, default_agent.as_deref())
}

/// `profile_id` overlays the workspace's agent, as `agent_skills_status`'s
/// does. Off the main thread: for an ssh workspace each check is a round
/// trip to the host.
#[tauri::command]
pub async fn playwright_status(
    app: tauri::AppHandle,
    root_path: String,
    profile_id: Option<String>,
) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let machine = machine_for(&app, &root_path)?;
        let root = Path::new(&root_path);
        let profile_id = profile_id_for(&app, machine.files(), root, profile_id.as_deref());
        Ok(status_for(machine.as_ref(), root, &profile_id))
    })
    .await
    .map_err(|e| format!("the Playwright check did not run: {e}"))?
}

/// `replace_foreign` is the human's answer to a `conflict` the status
/// showed: true replaces that server with gavin's.
#[tauri::command]
pub async fn playwright_install(
    app: tauri::AppHandle,
    root_path: String,
    profile_id: Option<String>,
    replace_foreign: Option<bool>,
) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let machine = machine_for(&app, &root_path)?;
        let root = Path::new(&root_path);
        let profile_id = profile_id_for(&app, machine.files(), root, profile_id.as_deref());
        install(machine.as_ref(), root, &profile_id, replace_foreign.unwrap_or(false))
    })
    .await
    .map_err(|e| format!("the Playwright install did not run: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const BINARY: &str = "/apps/gavin-mcp";

    /// A machine whose browser cache is a tempdir and whose install is a
    /// stand-in: it writes the marker or does not, and exits with a code.
    struct Fake<'a> {
        files: &'a dyn WorkspaceFiles,
        npx: Result<bool, String>,
        marker: PathBuf,
        binary: Result<PathBuf, String>,
        /// `None`: the install cannot be started here (the ssh case).
        install: Option<(bool, i32)>,
        host: Option<String>,
        installs: AtomicUsize,
    }

    impl<'a> Fake<'a> {
        fn new(files: &'a dyn WorkspaceFiles, cache: &Path) -> Self {
            Fake {
                files,
                npx: Ok(true),
                marker: cache.join(pw::headless_shell_folder(pw::HEADLESS_SHELL_REVISION)).join(pw::INSTALLATION_COMPLETE),
                binary: Ok(PathBuf::from(BINARY)),
                install: Some((true, 0)),
                host: None,
                installs: AtomicUsize::new(0),
            }
        }

        fn with_browser(self) -> Self {
            std::fs::create_dir_all(self.marker.parent().unwrap()).unwrap();
            std::fs::write(&self.marker, "").unwrap();
            self
        }
    }

    impl Machine for Fake<'_> {
        fn files(&self) -> &dyn WorkspaceFiles {
            self.files
        }
        fn npx(&self) -> Result<bool, String> {
            self.npx.clone()
        }
        fn browser(&self) -> Result<(bool, String), String> {
            Ok((self.marker.is_file(), protocol::wire_path(&self.marker)))
        }
        fn mcp_binary(&self) -> Result<PathBuf, String> {
            self.binary.clone()
        }
        fn install_browser(&self) -> Result<Run, String> {
            self.installs.fetch_add(1, Ordering::SeqCst);
            let (writes, code) = self.install.ok_or("cannot run programs on the host from here")?;
            if writes {
                std::fs::create_dir_all(self.marker.parent().unwrap()).unwrap();
                std::fs::write(&self.marker, "").unwrap();
            }
            Ok(Run { stdout: "Downloading Chrome Headless Shell…\n".to_string(), stderr: String::new(), code })
        }
        fn host(&self) -> Option<&str> {
            self.host.as_deref()
        }
    }

    fn rooted(dir: &Path, profile: &str) {
        let g = dir.join(".gavin-root");
        std::fs::create_dir_all(&g).unwrap();
        std::fs::write(g.join("config.toml"), format!("[agent]\nprofile = \"{profile}\"\n")).unwrap();
    }

    fn json(path: &Path) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    /// The card's "done": a fresh workspace, for each stock profile, ends
    /// with the right entry in the right file and dialect -- the shape
    /// gavin's own entry has there, with `playwright` as its argument.
    #[test]
    fn every_stock_profile_gets_its_entry_in_a_fresh_workspace() {
        for profile in crate::config::STOCK_PROFILE_IDS {
            let root = tempfile::tempdir().unwrap();
            let cache = tempfile::tempdir().unwrap();
            rooted(root.path(), profile);
            let machine = Fake::new(&LocalFiles, cache.path());

            assert_eq!(status_for(&machine, root.path(), profile).state, "absent", "{profile}");
            let status = install(&machine, root.path(), profile, false).unwrap();
            assert_eq!(status.state, "verified", "{profile}: {}", status.detail);
            assert!(status.checks.iter().all(|c| c.ok == Some(true)), "{profile}: {:?}", status.checks);
            assert_eq!(machine.installs.load(Ordering::SeqCst), 1, "{profile}");

            let p = root.path();
            match profile {
                "claude-code" | "kimi-code" | "gemini" => {
                    let file = if profile == "gemini" { p.join(".gemini/settings.json") } else { p.join(".mcp.json") };
                    assert_eq!(
                        json(&file)["mcpServers"]["playwright"],
                        serde_json::json!({ "command": BINARY, "args": ["playwright"] }),
                        "{profile}"
                    );
                }
                "cursor" => {
                    let entry = &json(&p.join(".cursor/mcp.json"))["mcpServers"]["playwright"];
                    assert_eq!(entry["type"], "stdio");
                    assert_eq!(entry["command"], BINARY);
                    assert_eq!(entry["args"], serde_json::json!(["playwright"]));
                    // Cursor's MCP servers see almost none of the agent's
                    // environment; the shim needs its session.
                    for var in ["GAVIN_SESSION_ID", "GAVIN_SESSION_TOKEN", "GAVIN_SESSION_SOCKET"] {
                        assert_eq!(entry["env"][var], format!("${{env:{var}}}"), "{var}");
                    }
                }
                "opencode" => {
                    assert_eq!(
                        json(&p.join("opencode.json"))["mcp"]["playwright"],
                        serde_json::json!({ "type": "local", "command": [BINARY, "playwright"], "enabled": true })
                    );
                }
                "codex" => {
                    let text = std::fs::read_to_string(p.join(".codex/config.toml")).unwrap();
                    let parsed = text.parse::<toml::Table>().unwrap();
                    let entry = parsed["mcp_servers"]["playwright"].as_table().unwrap();
                    assert_eq!(entry["command"].as_str(), Some(BINARY));
                    assert_eq!(entry["args"].as_array().unwrap(), &vec![toml::Value::from("playwright")]);
                }
                other => panic!("a stock profile this test does not know: {other}"),
            }
        }
    }

    /// The entry merges like gavin's own: every other server, gavin's
    /// included, and (in TOML) every comment survive.
    #[test]
    fn the_entry_merges_beside_servers_already_there() {
        let root = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        rooted(root.path(), "claude-code");
        std::fs::write(
            root.path().join(".mcp.json"),
            r#"{ "mcpServers": { "gavin": { "command": "/apps/gavin-mcp", "args": [] },
                                 "linty": { "command": "/bin/linty", "args": ["--fix"] } },
                 "other": true }"#,
        )
        .unwrap();
        let machine = Fake::new(&LocalFiles, cache.path());
        install(&machine, root.path(), "claude-code", false).unwrap();
        let v = json(&root.path().join(".mcp.json"));
        assert_eq!(v["mcpServers"]["linty"]["args"], serde_json::json!(["--fix"]));
        assert_eq!(v["mcpServers"]["gavin"]["command"], BINARY);
        assert_eq!(v["other"], true);
        assert_eq!(v["mcpServers"]["playwright"]["args"], serde_json::json!(["playwright"]));

        let codex = tempfile::tempdir().unwrap();
        rooted(codex.path(), "codex");
        std::fs::create_dir_all(codex.path().join(".codex")).unwrap();
        std::fs::write(
            codex.path().join(".codex/config.toml"),
            "# my codex config\nmodel = \"gpt-5\"\n\n# the linter's server\n[mcp_servers.linty]\ncommand = \"/bin/linty\"\n",
        )
        .unwrap();
        install(&machine, codex.path(), "codex", false).unwrap();
        let text = std::fs::read_to_string(codex.path().join(".codex/config.toml")).unwrap();
        assert!(text.contains("# my codex config") && text.contains("# the linter's server"), "{text}");
        let parsed = text.parse::<toml::Table>().unwrap();
        assert_eq!(parsed["mcp_servers"]["linty"]["command"].as_str(), Some("/bin/linty"));
        assert_eq!(parsed["mcp_servers"]["playwright"]["command"].as_str(), Some(BINARY));
    }

    /// A `playwright` server somebody else wrote -- the human's own `npx
    /// @playwright/mcp@latest`, say -- is shown, never silently replaced.
    #[test]
    fn a_foreign_playwright_server_is_replaced_only_when_asked() {
        let root = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        rooted(root.path(), "claude-code");
        let theirs = r#"{"mcpServers":{"playwright":{"command":"npx","args":["@playwright/mcp@latest"]}}}"#;
        std::fs::write(root.path().join(".mcp.json"), theirs).unwrap();
        let machine = Fake::new(&LocalFiles, cache.path());

        let status = status_for(&machine, root.path(), "claude-code");
        assert_eq!(status.state, "absent");
        assert!(status.installable);
        assert_eq!(
            status.conflict,
            Some(Conflict {
                file: ".mcp.json".to_string(),
                command: "npx".to_string(),
                args: vec!["@playwright/mcp@latest".to_string()],
            })
        );
        assert!(status.detail.contains("Replace"), "{}", status.detail);

        let kept = install(&machine, root.path(), "claude-code", false).unwrap();
        assert_eq!(std::fs::read_to_string(root.path().join(".mcp.json")).unwrap(), theirs);
        assert!(kept.conflict.is_some());

        let replaced = install(&machine, root.path(), "claude-code", true).unwrap();
        assert_eq!(replaced.state, "verified", "{}", replaced.detail);
        assert_eq!(json(&root.path().join(".mcp.json"))["mcpServers"]["playwright"]["command"], BINARY);
    }

    /// Flags a human added after `playwright` are theirs to keep: the
    /// step counts the entry, and Install does not touch it.
    #[test]
    fn gavins_entry_with_the_humans_own_flags_counts_and_is_kept() {
        let root = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        rooted(root.path(), "claude-code");
        let body = r#"{"mcpServers":{"playwright":{"command":"/apps/gavin-mcp","args":["playwright","--viewport-size","1600,900"]}}}"#;
        std::fs::write(root.path().join(".mcp.json"), body).unwrap();
        let machine = Fake::new(&LocalFiles, cache.path()).with_browser();
        assert_eq!(status_for(&machine, root.path(), "claude-code").state, "verified");
        install(&machine, root.path(), "claude-code", false).unwrap();
        assert_eq!(std::fs::read_to_string(root.path().join(".mcp.json")).unwrap(), body);
    }

    #[test]
    fn without_npx_nothing_runs_and_the_row_says_why() {
        let root = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        rooted(root.path(), "claude-code");
        let mut machine = Fake::new(&LocalFiles, cache.path());
        machine.npx = Ok(false);
        let status = install(&machine, root.path(), "claude-code", false).unwrap();
        assert_eq!(status.state, "absent");
        assert!(!status.installable);
        assert!(status.detail.contains("Node.js"), "{}", status.detail);
        assert_eq!(machine.installs.load(Ordering::SeqCst), 0);
        assert!(!root.path().join(".mcp.json").exists(), "no entry for a server that cannot start");
    }

    /// The detector, not the installer: an install that exited non-zero
    /// and wrote nothing leaves no entry behind and says so; one that
    /// exited non-zero but finished is set up.
    #[test]
    fn the_checks_not_the_exit_code_say_what_an_install_did() {
        let root = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        rooted(root.path(), "claude-code");
        let mut machine = Fake::new(&LocalFiles, cache.path());
        machine.install = Some((false, 1));
        let failed = install(&machine, root.path(), "claude-code", false).unwrap();
        assert_eq!(failed.state, "absent");
        assert!(failed.detail.contains("status 1"), "{}", failed.detail);
        assert!(failed.output.contains("Downloading"), "the install's log, not the checks': {}", failed.output);
        assert!(!root.path().join(".mcp.json").exists(), "no entry without the browser behind it");

        machine.install = Some((true, 1));
        let finished = install(&machine, root.path(), "claude-code", false).unwrap();
        assert_eq!(finished.state, "verified", "{}", finished.detail);
    }

    #[test]
    fn a_browser_already_installed_is_not_downloaded_again() {
        let root = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        rooted(root.path(), "gemini");
        let machine = Fake::new(&LocalFiles, cache.path()).with_browser();
        let status = install(&machine, root.path(), "gemini", false).unwrap();
        assert_eq!(status.state, "verified");
        assert_eq!(machine.installs.load(Ordering::SeqCst), 0);
    }

    /// Never guess a detector: gavin does not know where a custom agent
    /// reads MCP config, so it checks nothing there and installs nothing.
    #[test]
    fn a_custom_profile_is_unavailable_and_has_nothing_to_install() {
        let root = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        rooted(root.path(), "my-agent");
        let machine = Fake::new(&LocalFiles, cache.path());
        let status = status_for(&machine, root.path(), "my-agent");
        assert_eq!(status.state, "unavailable");
        assert!(!status.installable);
        assert_eq!(status.checks[2].ok, None);
        assert!(status.detail.contains("/apps/gavin-mcp playwright"), "{}", status.detail);
        assert!(install(&machine, root.path(), "my-agent", false).unwrap_err().contains("cannot install"));
        assert_eq!(machine.installs.load(Ordering::SeqCst), 0);
    }

    /// An MCP config that does not parse is not "no entry": gavin cannot
    /// tell, so it offers nothing that would have to clobber the file.
    #[test]
    fn an_unreadable_config_is_unavailable_and_untouched() {
        let root = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        rooted(root.path(), "claude-code");
        std::fs::write(root.path().join(".mcp.json"), "{ not json").unwrap();
        let machine = Fake::new(&LocalFiles, cache.path());
        let status = install(&machine, root.path(), "claude-code", false).unwrap();
        assert_eq!(status.state, "unavailable");
        assert_eq!(std::fs::read_to_string(root.path().join(".mcp.json")).unwrap(), "{ not json");
    }

    /// No gavin-mcp to name -- a dev tree that never built it -- is said,
    /// not written around.
    #[test]
    fn no_gavin_mcp_means_no_entry() {
        let root = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        rooted(root.path(), "claude-code");
        let mut machine = Fake::new(&LocalFiles, cache.path()).with_browser();
        machine.binary = Err("gavin-mcp binary not found beside the app".to_string());
        let status = install(&machine, root.path(), "claude-code", false).unwrap();
        assert_eq!(status.state, "unavailable");
        assert!(status.detail.contains("gavin-mcp"), "{}", status.detail);
        assert!(!root.path().join(".mcp.json").exists());
    }

    /// The host's disk, in memory: what an ssh workspace's files are to
    /// this machine.
    #[derive(Default)]
    struct HostFiles {
        files: Mutex<HashMap<PathBuf, Vec<u8>>>,
        dirs: Vec<PathBuf>,
    }

    impl WorkspaceFiles for HostFiles {
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
    }

    /// The ssh case through the trait: the install that cannot run from
    /// here is named for the host, and once the browser is there the
    /// entry lands in the host's files -- naming the host's gavin-mcp --
    /// and nowhere on this disk.
    #[test]
    fn an_ssh_workspace_is_set_up_on_the_host() {
        let root = PathBuf::from("/remote/repo");
        let files = HostFiles { dirs: vec![root.clone()], ..Default::default() };
        files.write_bytes(&root.join(".gavin-root/config.toml"), b"[agent]\nprofile = \"claude-code\"\n").unwrap();
        let cache = tempfile::tempdir().unwrap();
        let mut machine = Fake::new(&files, cache.path());
        machine.npx = Err("Node.js (npx) not checked — gavin cannot look up programs on box from here".to_string());
        machine.install = None;
        machine.host = Some("box".to_string());
        machine.binary = Ok(PathBuf::from("/opt/gavin/gavin-mcp"));

        let status = install(&machine, &root, "claude-code", false).unwrap();
        assert_eq!(status.state, "absent");
        assert!(!status.installable, "nothing to do here until the browser is on the host");
        assert!(status.detail.contains("on box") && status.detail.contains(&install_command()), "{}", status.detail);
        assert_eq!(status.checks[0].ok, None, "npx is not checked, and does not block");
        assert!(!files.is_file(&root.join(".mcp.json")));

        std::fs::create_dir_all(machine.marker.parent().unwrap()).unwrap();
        std::fs::write(&machine.marker, "").unwrap();
        assert!(status_for(&machine, &root, "claude-code").installable);
        let status = install(&machine, &root, "claude-code", false).unwrap();
        assert_eq!(status.state, "verified", "{}", status.detail);
        let mcp = String::from_utf8(files.read_bytes(&root.join(".mcp.json")).unwrap().unwrap()).unwrap();
        let v: serde_json::Value = serde_json::from_str(&mcp).unwrap();
        assert_eq!(v["mcpServers"]["playwright"]["command"], "/opt/gavin/gavin-mcp");
        assert!(!Path::new("/remote").exists(), "nothing on this disk");
    }

    /// The rule AG-07 and kimi's launch trust read is exact.
    #[test]
    fn only_the_exact_entry_is_gavins() {
        let server = |name: &str, command: &str, args: &[&str]| ForeignMcpServer {
            name: name.to_string(),
            command: command.to_string(),
            args: args.iter().map(|a| a.to_string()).collect(),
        };
        assert!(is_gavins_entry(&server("playwright", BINARY, &["playwright"]), BINARY));
        assert!(!is_gavins_entry(&server("playwright", "./evil/gavin-mcp", &["playwright"]), BINARY));
        assert!(!is_gavins_entry(&server("playwright", BINARY, &["playwright", "--config", "x"]), BINARY));
        assert!(!is_gavins_entry(&server("playwright", BINARY, &[]), BINARY));
        assert!(!is_gavins_entry(&server("browser", BINARY, &["playwright"]), BINARY));
    }

    #[test]
    fn the_marker_is_the_pinned_revisions() {
        let marker = marker_path(HostOs::MacOs, Path::new("/Users/ada"), |_| None);
        assert_eq!(
            marker,
            PathBuf::from("/Users/ada/Library/Caches/ms-playwright")
                .join(format!("chromium_headless_shell-{}", pw::HEADLESS_SHELL_REVISION))
                .join("INSTALLATION_COMPLETE")
        );
        assert_eq!(install_command(), format!("npx -y {} install-browser chromium-headless-shell", pw::mcp_spec()));
    }

    /// The two tests that touch this machine. `#[ignore]`d because a
    /// checkout without Node is not a broken build. This one only reads:
    /// `cargo test --lib agent_playwright -- --ignored --nocapture` shows
    /// what the real checks say here.
    #[test]
    #[ignore = "reads this machine's PATH and Playwright cache"]
    fn live_checks_on_this_machine() {
        let root = tempfile::tempdir().unwrap();
        rooted(root.path(), "claude-code");
        let status = status_for(&ThisMachine, root.path(), "claude-code");
        for check in &status.checks {
            eprintln!("{}: {:?} — {}", check.id, check.ok, check.line);
        }
        assert!(status.checks[..2].iter().all(|c| c.ok.is_some()), "gavin could look: {:?}", status.checks);
    }

    /// This machine's npx and real download, the real cache rule, and
    /// the entry written by the real writer: everything but gavin-mcp,
    /// which `cargo test` has none of beside it.
    struct ThisMachineWithBinary;

    impl Machine for ThisMachineWithBinary {
        fn files(&self) -> &dyn WorkspaceFiles {
            ThisMachine.files()
        }
        fn npx(&self) -> Result<bool, String> {
            ThisMachine.npx()
        }
        fn browser(&self) -> Result<(bool, String), String> {
            ThisMachine.browser()
        }
        fn mcp_binary(&self) -> Result<PathBuf, String> {
            Ok(PathBuf::from(BINARY))
        }
        fn install_browser(&self) -> Result<Run, String> {
            ThisMachine.install_browser()
        }
    }

    /// The real install, end to end: about 200 MB from Playwright's CDN.
    /// It refuses to run unless `PLAYWRIGHT_BROWSERS_PATH` names a
    /// scratch directory, so a test never fills the developer's own
    /// cache:
    ///
    /// `PLAYWRIGHT_BROWSERS_PATH=/tmp/pw cargo test --lib agent_playwright::tests::live_install -- --ignored --nocapture`
    #[test]
    #[ignore = "downloads Chrome Headless Shell into PLAYWRIGHT_BROWSERS_PATH"]
    fn live_install_into_a_scratch_cache() {
        let scratch = std::env::var("PLAYWRIGHT_BROWSERS_PATH").expect("set PLAYWRIGHT_BROWSERS_PATH to a scratch dir");
        assert!(Path::new(&scratch).is_absolute(), "an absolute scratch dir, or Playwright ignores it");
        let root = tempfile::tempdir().unwrap();
        rooted(root.path(), "codex");
        let status = install(&ThisMachineWithBinary, root.path(), "codex", false).unwrap();
        eprintln!("{}\n---\n{}", status.detail, status.output);
        assert_eq!(status.state, "verified", "{}", status.detail);
        assert!(status.checks[1].line.contains(&scratch), "{}", status.checks[1].line);
        let text = std::fs::read_to_string(root.path().join(".codex/config.toml")).unwrap();
        eprintln!("{text}");
        let parsed = text.parse::<toml::Table>().unwrap();
        assert_eq!(parsed["mcp_servers"]["playwright"]["args"][0].as_str(), Some("playwright"), "{text}");
    }
}
