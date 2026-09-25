//! Links to daemons on other machines, one per ssh host.
//!
//! An ssh workspace is the desktop driving the daemon that runs where the
//! workspace lives (`docs/superpowers/specs/2026-09-22-ssh-workspaces-design.md`).
//! This module is the desktop's half: it runs `ssh <host> gavin-daemon
//! bridge` once per connection, reads the bridge's banner, presents that
//! daemon's token so the connection is the `app` role THERE, and then
//! hands the rest of the app a `Stream` it cannot tell from a local one.
//! Nothing in `session.rs` speaks ssh; it speaks to a `Stream`, and the
//! only question a command asks is which link -- if any -- owns the
//! session, workspace, root or path it was given (`route_for_*`).
//!
//! What a link is made of is exactly what the local connection is made
//! of: a streaming connection whose reader feeds `attach_and_relay` and
//! whose writer carries `Attach`/`WriteInput`/`Resize`, a command
//! connection for request/reply, and a `DaemonCompat` for THAT daemon.
//! The host's daemon can be older than the app and still inside the
//! window; every request to it is gated on its own verdict, never on the
//! local daemon's.

use crate::config::{SshConfig, Workspace};
use crate::session::{
    attach_and_relay, list_valid_session_ids, non_session_tab_ids, resolve_sessions, send_request,
    BoardTabs, CardTabs, DaemonCompat, FileTabs, RelayOwner, WorkspacesState,
};
use protocol::transport::Stream;
use protocol::{Request, Response};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::net::Shutdown;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

/// The bridge's first line (`crates/daemon/src/bridge.rs`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Banner {
    pub protocol_version: u32,
    /// The host daemon's own token. `None` from a daemon too old to have
    /// written one; the link then continues as `local` there, exactly as
    /// the app does at home against such a daemon.
    #[serde(default)]
    pub daemon_token: Option<String>,
    pub host_os: String,
    /// The user's home ON THE HOST, the cwd a session there falls back to.
    #[serde(default)]
    pub home: Option<String>,
    /// The `gavin-mcp` beside the host's daemon, for the MCP config agent
    /// integration writes there; `None` when the host has none.
    #[serde(default)]
    pub mcp_path: Option<String>,
}

impl Banner {
    /// Anything that is not the banner is what ssh or the host's shell
    /// said instead -- `gavin-daemon: command not found`, most often --
    /// and that text is the diagnosis, so the error carries it verbatim.
    pub fn parse(line: &str) -> anyhow::Result<Banner> {
        #[derive(Deserialize)]
        struct Tagged {
            #[serde(rename = "type")]
            kind: String,
            #[serde(flatten)]
            banner: Banner,
        }
        let line = line.trim_end();
        match serde_json::from_str::<Tagged>(line) {
            Ok(tagged) if tagged.kind == "BridgeReady" => Ok(tagged.banner),
            _ => anyhow::bail!("the ssh host did not start a gavin bridge; it said: {line}"),
        }
    }
}

/// The program the desktop runs. Bare, resolved on PATH: `ssh` is on
/// every macOS and Linux desktop, and `C:\Windows\System32\OpenSSH` is
/// on the default Windows PATH.
const SSH_PROGRAM: &str = "ssh";

/// `ssh <options> -- <host> "<daemon>" bridge`.
///
/// The options say what an unattended child needs: no pty, no prompt it
/// cannot answer (`BatchMode`), a bounded connect, and keepalives so a
/// dead network becomes a dropped link in under a minute. Everything
/// else -- keys, aliases, jump hosts, multiplexing -- is the human's
/// `~/.ssh/config`, which ssh reads on its own.
///
/// The remote command is one string, run by whatever shell the host's
/// sshd uses: `sh` on Linux, `cmd.exe` (or PowerShell) on Windows. A
/// double-quoted path followed by a bare word is valid in all three, so
/// that is the one form emitted; a path containing a double quote has no
/// spelling that works in all three and is refused rather than escaped
/// differently per host.
pub fn ssh_command(cfg: &SshConfig) -> anyhow::Result<(String, Vec<String>)> {
    let host = cfg.host.trim();
    if host.is_empty()
        || host.starts_with('-')
        || host.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        anyhow::bail!("{:?} is not an ssh host name", cfg.host);
    }
    let daemon = match cfg.daemon_path.as_deref().map(str::trim) {
        None => "gavin-daemon",
        Some("") => anyhow::bail!("the daemon path for {host} is empty; leave it unset to use `gavin-daemon` on the host's PATH"),
        Some(path) if path.contains('"') || path.chars().any(char::is_control) => {
            anyhow::bail!("the daemon path {path:?} contains a double quote, which cannot be quoted for both sh and cmd.exe")
        }
        Some(path) => path,
    };
    let args = [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "--",
        host,
        &format!("\"{daemon}\" bridge"),
    ]
    .into_iter()
    .map(String::from)
    .collect();
    Ok((SSH_PROGRAM.to_string(), args))
}

/// Turns a child's stdout and stdin into a `Stream`.
///
/// `Stream::pair()` plus two copying threads, rather than a `Stream` arm
/// that wraps pipes: the pair gives every method the rest of the app
/// calls -- `try_clone`, `set_read_timeout`, `shutdown`, sharing behind
/// a `Mutex` -- for free, and has no name on the filesystem for another
/// process to reach.
///
/// The two ends are not symmetric, and the order of the shutdowns is
/// what makes both directions end. The child closing its stdout ends the
/// first thread, which shuts the pair down; that unblocks the second
/// thread's read, which drops the child's stdin (so ssh exits) and its
/// own clone of the pair -- and once no clone is left the app side reads
/// end-of-stream, which is how `attach_and_relay` learns the link is
/// gone. On Windows a pipe's peer sees the end only when the LAST handle
/// goes, so the drops are load-bearing, not tidiness.
pub fn pump(
    mut reader: impl Read + Send + 'static,
    mut writer: impl Write + Send + 'static,
) -> std::io::Result<Stream> {
    let (app_side, pump_side) = Stream::pair()?;
    let up = pump_side.try_clone()?;
    let down = pump_side;
    std::thread::spawn(move || {
        let mut buf = [0u8; 64 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if (&up).write_all(&buf[..n]).is_err() {
                        break;
                    }
                }
                Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        let _ = up.shutdown(Shutdown::Both);
    });
    std::thread::spawn(move || {
        let mut buf = [0u8; 64 * 1024];
        loop {
            match (&down).read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if writer.write_all(&buf[..n]).and_then(|_| writer.flush()).is_err() {
                        break;
                    }
                }
                Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        drop(writer);
        let _ = down.shutdown(Shutdown::Both);
    });
    Ok(app_side)
}

/// Probe the host daemon's version on the command connection, then
/// present the banner's token on both connections -- the same two steps
/// `session::bootstrap` takes at home, against the same functions.
pub fn establish(
    stream: &mut Stream,
    command: &Mutex<Stream>,
    banner: &Banner,
) -> anyhow::Result<DaemonCompat> {
    let compat = crate::session::verify_daemon_protocol(command)?;
    if let Some(token) = banner.daemon_token.as_deref() {
        crate::session::app_handshake_with_token(&compat, command, stream, token)?;
    }
    Ok(compat)
}

/// One ssh child and what it gave us.
struct Bridge {
    stream: Stream,
    banner: Banner,
    child: Child,
    /// What ssh printed to stderr so far, kept for the moment the link
    /// drops: "Connection reset by peer" is ssh's line, not gavin's.
    stderr: Arc<Mutex<String>>,
}

/// How much of ssh's stderr is kept. The useful part is the last line.
const STDERR_KEEP: usize = 4096;

fn spawn_bridge(cfg: &SshConfig) -> anyhow::Result<Bridge> {
    let (program, args) = ssh_command(cfg)?;
    let mut child = crate::program::command(&program)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| anyhow::anyhow!("could not run {program}: {e}"))?;
    let stdout = child.stdout.take().expect("stdout was piped");
    let stdin = child.stdin.take().expect("stdin was piped");
    let mut stderr = child.stderr.take().expect("stderr was piped");

    // Drained continuously: an ssh that fills its stderr pipe stops,
    // and a link that stops for a warning nobody read is a mystery.
    let stderr_tail = Arc::new(Mutex::new(String::new()));
    let drain = {
        let tail = Arc::clone(&stderr_tail);
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match stderr.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut tail = tail.lock().unwrap();
                        tail.push_str(&String::from_utf8_lossy(&buf[..n]));
                        if tail.len() > STDERR_KEEP {
                            let cut = tail.len() - STDERR_KEEP;
                            tail.drain(..cut);
                        }
                    }
                }
            }
        })
    };

    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    let read = reader.read_line(&mut line);
    let banner = match read {
        Ok(0) | Err(_) => {
            // ssh exited before the bridge said anything: its stderr is
            // the whole story (no key, no host, no gavin-daemon there).
            let _ = child.wait();
            let _ = drain.join();
            let said = stderr_tail.lock().unwrap().trim().to_string();
            anyhow::bail!(
                "ssh {} did not start a gavin bridge{}",
                cfg.host,
                if said.is_empty() { String::new() } else { format!(": {said}") }
            );
        }
        Ok(_) => match Banner::parse(&line) {
            Ok(banner) => banner,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e);
            }
        },
    };
    // The reader keeps whatever it buffered past the banner -- the
    // daemon's first pushes may already be in it -- which is why the
    // pump takes the BufReader and not the raw pipe.
    let stream = pump(reader, stdin)?;
    Ok(Bridge { stream, banner, child, stderr: stderr_tail })
}

static NEXT_LINK_ID: AtomicU64 = AtomicU64::new(1);

/// One host's daemon, as the app holds it.
pub struct RemoteLink {
    /// Distinguishes this link from a later one to the same host, so the
    /// relay thread of a dead link never unregisters its replacement.
    pub id: u64,
    pub host: String,
    pub compat: DaemonCompat,
    /// Request/reply, serialised by the mutex like `CommandConnection`.
    pub command: Mutex<Stream>,
    /// The streaming connection's writer, like `DaemonConnection`.
    pub writer: Arc<Mutex<Stream>>,
    /// The user's home on the host: the cwd fallback for sessions there.
    pub home: String,
    pub host_os: String,
    /// The host's `gavin-mcp`, from the banner; what an ssh workspace's
    /// MCP config names so the agent running there finds its tools.
    pub mcp_path: Option<String>,
    children: Mutex<Vec<Child>>,
    stderr: Vec<Arc<Mutex<String>>>,
}

impl RemoteLink {
    /// One request/reply on the command connection, gated on THIS daemon's
    /// version like every command the app sends it.
    fn ask(&self, req: &Request) -> anyhow::Result<Response> {
        crate::session::send_command_reconnecting(&self.command, &self.compat, req)
    }

    /// `ReadWorkspaceFile` (v39): the file's text under `root` on the
    /// host, or `None` when there is none, and whether it was cut at the
    /// cap.
    pub fn read_file(&self, root: &str, path: &str) -> anyhow::Result<(Option<String>, bool)> {
        match self.ask(&Request::ReadWorkspaceFile { root_path: root.to_string(), path: path.to_string() })? {
            Response::WorkspaceFile { content, truncated } => Ok((content, truncated)),
            Response::Error { message } => anyhow::bail!("{message}"),
            other => anyhow::bail!("expected WorkspaceFile, got {other:?}"),
        }
    }

    /// `WriteWorkspaceFile` (v39).
    pub fn write_file(&self, root: &str, path: &str, content: &str) -> anyhow::Result<()> {
        match self.ask(&Request::WriteWorkspaceFile {
            root_path: root.to_string(),
            path: path.to_string(),
            content: content.to_string(),
        })? {
            Response::Ok => Ok(()),
            Response::Error { message } => anyhow::bail!("{message}"),
            other => anyhow::bail!("expected Ok, got {other:?}"),
        }
    }

    /// `StatWorkspacePaths` (v39): where each path resolves on the host.
    pub fn stat_paths(&self, root: &str, paths: &[String]) -> anyhow::Result<Vec<protocol::WorkspacePathStat>> {
        match self.ask(&Request::StatWorkspacePaths { root_path: root.to_string(), paths: paths.to_vec() })? {
            Response::WorkspacePathStats { stats } => Ok(stats),
            Response::Error { message } => anyhow::bail!("{message}"),
            other => anyhow::bail!("expected WorkspacePathStats, got {other:?}"),
        }
    }

    /// `RunGit` (v40): a git subcommand in `cwd` on the host, its stdout,
    /// stderr and exit code -- the three the desktop's local `run_git`
    /// returns, so the Git tab's parsing is unchanged.
    pub fn run_git(
        &self,
        root: &str,
        cwd: &str,
        args: &[String],
        stdin: Option<&str>,
    ) -> anyhow::Result<(Vec<u8>, String, i32)> {
        match self.ask(&Request::RunGit {
            root_path: root.to_string(),
            cwd: cwd.to_string(),
            args: args.to_vec(),
            stdin: stdin.map(str::to_string),
        })? {
            Response::GitRun { stdout, stderr, code } => Ok((stdout, stderr, code)),
            Response::Error { message } => anyhow::bail!("{message}"),
            other => anyhow::bail!("expected GitRun, got {other:?}"),
        }
    }

    /// `ListWorkspaceDir` (v40): a directory's children on the host.
    pub fn list_dir(&self, root: &str, path: &str) -> anyhow::Result<Vec<protocol::WorkspaceDirEntry>> {
        match self.ask(&Request::ListWorkspaceDir { root_path: root.to_string(), path: path.to_string() })? {
            Response::WorkspaceDir { entries } => Ok(entries),
            Response::Error { message } => anyhow::bail!("{message}"),
            other => anyhow::bail!("expected WorkspaceDir, got {other:?}"),
        }
    }

    /// `RunGitEnv` (v42): `run_git` with an allow-listed environment, for
    /// the two callers that set `GIT_EDITOR=true` so a cherry-pick or a
    /// `<op> --continue` never waits on an editor nobody can see.
    pub fn run_git_env(
        &self,
        root: &str,
        cwd: &str,
        args: &[String],
        env: &[(String, String)],
    ) -> anyhow::Result<(Vec<u8>, String, i32)> {
        match self.ask(&Request::RunGitEnv {
            root_path: root.to_string(),
            cwd: cwd.to_string(),
            args: args.to_vec(),
            env: env.to_vec(),
        })? {
            Response::GitRun { stdout, stderr, code } => Ok((stdout, stderr, code)),
            Response::Error { message } => anyhow::bail!("{message}"),
            other => anyhow::bail!("expected GitRun, got {other:?}"),
        }
    }

    /// `CancelGitOp` (v42), on the COMMAND connection: a cancel queued
    /// behind the op it is cancelling never arrives, which is the whole
    /// reason the op itself goes the other way.
    pub fn cancel_git_op(&self, op_id: &str) -> anyhow::Result<bool> {
        match self.ask(&Request::CancelGitOp { op_id: op_id.to_string() })? {
            Response::GitOpCancelled { cancelled } => Ok(cancelled),
            Response::Error { message } => anyhow::bail!("{message}"),
            other => anyhow::bail!("expected GitOpCancelled, got {other:?}"),
        }
    }

    /// One request out on the STREAMING connection, with no reply to wait
    /// for: what the host answers arrives as pushes the relay thread
    /// reads. `Attach` and `WatchGavinRoot` already travel this way, and
    /// the v42 trio joins them for the same reason -- the answer is a
    /// push in its own time, not a value a reply could carry.
    fn tell(&self, req: &Request) -> anyhow::Result<()> {
        send_request(&self.writer, req, &self.compat)
    }

    /// `RunGitStreaming` (v42): starts a long git network op on the host.
    /// Returns as soon as the request is out -- `GitOpProgress` and the
    /// single `GitOpDone` come back through the relay.
    pub fn start_git_op(&self, root: &str, cwd: &str, args: &[String], op_id: &str) -> anyhow::Result<()> {
        self.tell(&Request::RunGitStreaming {
            root_path: root.to_string(),
            cwd: cwd.to_string(),
            args: args.to_vec(),
            op_id: op_id.to_string(),
        })
    }

    /// `WatchGitWorktree` / `UnwatchGitWorktree` (v42): the Git tab's live
    /// refresh, run by the daemon that has the worktree on its disk.
    pub fn watch_git(&self, root: &str, cwd: &str) -> anyhow::Result<()> {
        self.tell(&Request::WatchGitWorktree { root_path: root.to_string(), cwd: cwd.to_string() })
    }

    pub fn unwatch_git(&self, root: &str, cwd: &str) -> anyhow::Result<()> {
        self.tell(&Request::UnwatchGitWorktree { root_path: root.to_string(), cwd: cwd.to_string() })
    }

    /// `CreateWorkspacePath` (v42): an empty file, or one directory.
    pub fn create_path(&self, root: &str, path: &str, directory: bool) -> anyhow::Result<()> {
        match self.ask(&Request::CreateWorkspacePath {
            root_path: root.to_string(),
            path: path.to_string(),
            directory,
        })? {
            Response::Ok => Ok(()),
            Response::Error { message } => anyhow::bail!("{message}"),
            other => anyhow::bail!("expected Ok, got {other:?}"),
        }
    }

    /// `RenameWorkspacePath` (v42).
    pub fn rename_path(&self, root: &str, from: &str, to: &str) -> anyhow::Result<()> {
        match self.ask(&Request::RenameWorkspacePath {
            root_path: root.to_string(),
            from: from.to_string(),
            to: to.to_string(),
        })? {
            Response::Ok => Ok(()),
            Response::Error { message } => anyhow::bail!("{message}"),
            other => anyhow::bail!("expected Ok, got {other:?}"),
        }
    }

    /// `TrashWorkspacePath` (v42): the HOST's Trash, not `rm` -- see the
    /// request's own note. The confirmation was answered on this side
    /// before the request went out.
    pub fn trash_path(&self, root: &str, path: &str) -> anyhow::Result<()> {
        match self.ask(&Request::TrashWorkspacePath {
            root_path: root.to_string(),
            path: path.to_string(),
        })? {
            Response::Ok => Ok(()),
            Response::Error { message } => anyhow::bail!("{message}"),
            other => anyhow::bail!("expected Ok, got {other:?}"),
        }
    }

    /// The last thing ssh said on either connection, for a dropped link's
    /// message.
    pub fn last_words(&self) -> String {
        self.stderr
            .iter()
            .filter_map(|s| s.lock().ok().map(|s| s.trim().to_string()))
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" | ")
    }
}

impl Drop for RemoteLink {
    /// Ends both ssh processes. Dropping the streams alone would end them
    /// too, one EOF at a time; this is the prompt version.
    fn drop(&mut self) {
        for child in self.children.lock().unwrap().iter_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

// --- The git router ---------------------------------------------------------
//
// The Git tab's subprocess runner (`git::run`) takes a bare `cwd` and no
// AppHandle, so it cannot reach `RemoteLinks` state to decide whether a
// cwd is on a host. This process-global registry closes that gap: a link
// registers its workspace root here when it comes up, clears it when it
// drops, and `git::run` asks `git_link_for_cwd` which link -- if any --
// owns a cwd. Keyed by root so a cwd is matched by prefix, the same way
// `path_is_under` matches a card path.

/// root (trimmed of a trailing slash) -> the link that serves it.
static GIT_ROUTER: std::sync::OnceLock<Mutex<Vec<(String, Arc<RemoteLink>)>>> =
    std::sync::OnceLock::new();

fn git_router() -> &'static Mutex<Vec<(String, Arc<RemoteLink>)>> {
    GIT_ROUTER.get_or_init(|| Mutex::new(Vec::new()))
}

/// Records that `root` is served by `link`, replacing any earlier entry
/// for the same root (a Reconnect makes a new link for the same root).
fn register_git_root(root: &str, link: Arc<RemoteLink>) {
    let key = trim_root(root).to_string();
    let mut router = git_router().lock().unwrap();
    router.retain(|(r, _)| r != &key);
    router.push((key, link));
}

/// Drops every root a host served, when its link is lost.
fn clear_git_host(host: &str) {
    git_router().lock().unwrap().retain(|(_, link)| link.host != host);
}

/// The link whose workspace root contains `cwd`, and that root -- what
/// `git::run` needs to send a `RunGit`. `None` for a local cwd.
pub fn git_link_for_cwd(cwd: &str) -> Option<(Arc<RemoteLink>, String)> {
    let cwd = protocol::wire_path_str(cwd);
    git_router()
        .lock()
        .unwrap()
        .iter()
        .find(|(root, _)| path_is_under(root, &cwd))
        .map(|(root, link)| (Arc::clone(link), root.clone()))
}

/// Runs a git subcommand on the host that owns `cwd`, or `None` when the
/// cwd is local (the caller then runs git itself). The Git tab's runner
/// (`git::run::run_git`) calls this first, so every synchronous git
/// command it issues works on an ssh workspace with no change at the call
/// site -- exactly the "change only where the process runs" the card asks
/// for. The network ops it keeps to itself go through `run_git_streaming`,
/// which does not call this.
pub fn run_git_over_link(
    cwd: &str,
    args: &[&str],
    stdin: Option<&[u8]>,
) -> Option<Result<(Vec<u8>, String, i32), String>> {
    let (link, root) = git_link_for_cwd(cwd)?;
    let argv: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    // git's stdin here is a commit message or a patch -- text; a non-UTF-8
    // patch is a case gavin does not produce.
    let stdin = stdin.map(|b| String::from_utf8_lossy(b).into_owned());
    Some(
        link.run_git(&root, &protocol::wire_path_str(cwd), &argv, stdin.as_deref())
            .map_err(|e| e.to_string()),
    )
}

/// `run_git_env`'s router arm (v42) -- the same shape as
/// `run_git_over_link`, for the two callers that need `GIT_EDITOR`.
pub fn run_git_env_over_link(
    cwd: &str,
    args: &[&str],
    env: &[(&str, &str)],
) -> Option<Result<(Vec<u8>, String, i32), String>> {
    let (link, root) = git_link_for_cwd(cwd)?;
    let argv: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let env: Vec<(String, String)> = env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    Some(
        link.run_git_env(&root, &protocol::wire_path_str(cwd), &argv, &env)
            .map_err(|e| e.to_string()),
    )
}

/// A file read or written on the host that owns `cwd`, for the two
/// modules that reach past `run_git` to the disk: `conflict.rs` (the
/// rebase state under the git dir, and the worktree side of a conflicted
/// file) and `ignore.rs` (`.gitignore` and `.git/info/exclude`, both
/// located by git and then read as files).
///
/// Like `run_git_over_link`, this takes a bare `cwd` and finds the link
/// through the router -- neither caller has an `AppHandle` to reach
/// `RemoteLinks` through. `None` means the cwd is local and the caller
/// does its own `std::fs`.
///
/// The read answers `Ok(None)` for a file that is not there, and an `Err`
/// for one the host refused -- which includes a file that is not UTF-8,
/// since `ReadWorkspaceFile` carries text. Both callers already treat an
/// unreadable file as "nothing to check", which is the same conclusion.
pub fn read_file_over_link(cwd: &str, path: &str) -> Option<Result<Option<String>, String>> {
    let (link, root) = git_link_for_cwd(cwd)?;
    Some(
        link.read_file(&root, &protocol::wire_path_str(path))
            .map(|(content, _truncated)| content)
            .map_err(|e| e.to_string()),
    )
}

pub fn write_file_over_link(cwd: &str, path: &str, content: &str) -> Option<Result<(), String>> {
    let (link, root) = git_link_for_cwd(cwd)?;
    Some(
        link.write_file(&root, &protocol::wire_path_str(path), content)
            .map_err(|e| e.to_string()),
    )
}

/// The cwds the Git tab has asked a host to watch, remembered so a link
/// that comes back can be asked again.
///
/// A host's watchers belong to the CONNECTION that asked for them
/// (`handle_connection` owns them, so a dropped link takes them with it),
/// which is the right lifetime there and a gap here: the tab's own
/// `$effect` re-runs when its cwd changes, and a reconnect does not
/// change the cwd. Without this, a Git tab that survived a dropped link
/// would sit there never refreshing, with nothing to say it had stopped
/// listening.
static REMOTE_GIT_WATCHES: std::sync::OnceLock<Mutex<HashSet<String>>> = std::sync::OnceLock::new();

fn remote_git_watches() -> &'static Mutex<HashSet<String>> {
    REMOTE_GIT_WATCHES.get_or_init(|| Mutex::new(HashSet::new()))
}

/// The Git tab's watch, on the host that owns `cwd` (v42). `None` for a
/// local cwd, where `git::watch` runs its own `notify` watcher.
pub fn watch_git_over_link(cwd: &str) -> Option<Result<(), String>> {
    let (link, root) = git_link_for_cwd(cwd)?;
    let wire = protocol::wire_path_str(cwd);
    // Remembered even when the request fails: a host that is too old
    // today is a host that may be updated, and the reconnect after that
    // is exactly when this should be tried again.
    remote_git_watches().lock().unwrap().insert(wire.clone());
    Some(link.watch_git(&root, &wire).map_err(|e| e.to_string()))
}

pub fn unwatch_git_over_link(cwd: &str) -> Option<Result<(), String>> {
    let (link, root) = git_link_for_cwd(cwd)?;
    let wire = protocol::wire_path_str(cwd);
    remote_git_watches().lock().unwrap().remove(&wire);
    Some(link.unwatch_git(&root, &wire).map_err(|e| e.to_string()))
}

/// Re-asks a freshly linked host to watch every cwd under `root` the Git
/// tab still believes is watched. Called from `link_workspace` once the
/// root is in the router, so a Reconnect restores live refresh instead of
/// leaving the tab on manual Refresh with no sign of it.
fn rewatch_git_roots(link: &Arc<RemoteLink>, root: &str) {
    let cwds: Vec<String> = remote_git_watches()
        .lock()
        .unwrap()
        .iter()
        .filter(|cwd| path_is_under(root, cwd))
        .cloned()
        .collect();
    for cwd in cwds {
        // A host below v42 refuses this locally on the version gate; the
        // tab's manual Refresh is what it keeps, as before.
        let _ = link.watch_git(root, &cwd);
    }
}

// --- Long git ops on a host -------------------------------------------
//
// `run_git_streaming` runs a fetch/pull/push and returns when it ends,
// which is the shape `ops.rs` is built around. On a host the op is
// started with a request that does not reply, and its end arrives later
// as a `GitOpDone` push on the relay thread. This registry is the join
// between the two: the caller parks on a channel, the relay hands the
// result to it, and `ops.rs` keeps its signature.
//
// Keyed by the desktop's own op id, which is also what the frontend
// already generates to address a cancel -- so an op is one id from the
// button that starts it all the way to the child on the host.

struct PendingOp {
    link: Arc<RemoteLink>,
    done: std::sync::mpsc::Sender<Result<(), String>>,
}

static PENDING_GIT_OPS: std::sync::OnceLock<Mutex<HashMap<String, PendingOp>>> =
    std::sync::OnceLock::new();

fn pending_git_ops() -> &'static Mutex<HashMap<String, PendingOp>> {
    PENDING_GIT_OPS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Runs a long git op on the host that owns `cwd`, blocking until the
/// host says it ended -- so `ops.rs::run_op` cannot tell a remote op from
/// a local one. `None` when the cwd is local.
///
/// Progress is NOT returned here: the relay thread emits each
/// `GitOpProgress` as the very `git-op-progress` event the local runner
/// emits, so the toolbar's progress row is fed the same way either way.
pub fn run_git_op_over_link(cwd: &str, args: &[String], op_id: &str) -> Option<Result<(), String>> {
    let (link, root) = git_link_for_cwd(cwd)?;
    let (tx, rx) = std::sync::mpsc::channel();
    pending_git_ops()
        .lock()
        .unwrap()
        .insert(op_id.to_string(), PendingOp { link: Arc::clone(&link), done: tx });
    if let Err(e) = link.start_git_op(&root, &protocol::wire_path_str(cwd), args, op_id) {
        pending_git_ops().lock().unwrap().remove(op_id);
        return Some(Err(e.to_string()));
    }
    // No deadline of our own. The host applies the same ten-minute
    // ceiling the desktop's runner does and reports the timeout as an
    // ordinary `GitOpDone`; a link that dies instead is what
    // `abandon_git_ops` is for, so there is no state here that can
    // outlive its link.
    let result = rx.recv().unwrap_or_else(|_| Err("the connection to the host was lost".to_string()));
    pending_git_ops().lock().unwrap().remove(op_id);
    Some(result)
}

/// A `GitOpDone` from the relay thread: hands the verdict to whoever is
/// parked in `run_git_op_over_link`. An id nobody is waiting on is
/// ignored -- a cancel that raced the op's own end is the ordinary case.
pub fn finish_git_op(op_id: &str, error: Option<String>) {
    let pending = pending_git_ops().lock().unwrap().remove(op_id);
    if let Some(op) = pending {
        let _ = op.done.send(match error {
            Some(message) => Err(message),
            None => Ok(()),
        });
    }
}

/// Cancels a long git op running on a host: `Some(true)` when the host
/// still had a child to kill, `None` when no op by that id is remote (the
/// caller then tries its local registry).
pub fn cancel_git_op_over_link(op_id: &str) -> Option<bool> {
    let link = {
        let ops = pending_git_ops().lock().unwrap();
        Arc::clone(&ops.get(op_id)?.link)
    };
    Some(link.cancel_git_op(op_id).unwrap_or(false))
}

/// Releases everyone parked on an op that a dying link was running. Called
/// from `link_lost`: without it the caller would sit in `recv` for as
/// long as the app lives, holding the Tauri blocking thread it was
/// spawned on.
fn abandon_git_ops(host: &str, message: &str) {
    let mut ops = pending_git_ops().lock().unwrap();
    let doomed: Vec<String> =
        ops.iter().filter(|(_, op)| op.link.host == host).map(|(id, _)| id.clone()).collect();
    for id in doomed {
        if let Some(op) = ops.remove(&id) {
            let _ = op.done.send(Err(message.to_string()));
        }
    }
}

/// Agent integration's files on the host, through the link
/// (`agent_setup::WorkspaceFiles`). Every path is absolute on the host;
/// it crosses the wire forward-slashed like every other path, so a root
/// joined on a Windows desktop reaches a Linux host spelled the way that
/// host reads it.
pub struct RemoteFiles {
    pub link: Arc<RemoteLink>,
    pub root: String,
}

impl RemoteFiles {
    fn wire(path: &std::path::Path) -> String {
        protocol::wire_path(path)
    }
}

impl crate::agent_setup::WorkspaceFiles for RemoteFiles {
    fn read_bytes(&self, path: &std::path::Path) -> anyhow::Result<Option<Vec<u8>>> {
        let (content, truncated) = self.link.read_file(&self.root, &Self::wire(path))?;
        if truncated {
            anyhow::bail!("{} is larger than the 1 MB the host will send", path.display());
        }
        Ok(content.map(String::into_bytes))
    }

    fn write_bytes(&self, path: &std::path::Path, contents: &[u8]) -> anyhow::Result<()> {
        let text = std::str::from_utf8(contents)
            .map_err(|_| anyhow::anyhow!("{} is not UTF-8 text, which is all the host takes", path.display()))?;
        self.link.write_file(&self.root, &Self::wire(path), text)
    }

    fn is_dir(&self, path: &std::path::Path) -> bool {
        self.link
            .stat_paths(&self.root, &[Self::wire(path)])
            .ok()
            .and_then(|stats| stats.into_iter().next())
            .is_some_and(|s| s.is_dir)
    }

    fn is_file(&self, path: &std::path::Path) -> bool {
        self.link
            .stat_paths(&self.root, &[Self::wire(path)])
            .ok()
            .and_then(|stats| stats.into_iter().next())
            .is_some_and(|s| s.exists)
    }

    /// The daemon confines every write to the root, so the path is its
    /// own answer here.
    fn canonical_dir(&self, path: &std::path::Path) -> Option<std::path::PathBuf> {
        Some(path.to_path_buf())
    }

    /// From the banner, not from `cfg!`: the agent and its `gavin-mcp` run
    /// on the host, so it is the host's platform that decides which
    /// launcher file a relative MCP command would land on.
    fn is_windows(&self) -> bool {
        self.link.host_os == "windows"
    }
}

/// host -> its link. Managed at app setup, before bootstrap.
#[derive(Default)]
pub struct RemoteLinks(pub Mutex<HashMap<String, Arc<RemoteLink>>>);

/// session id -> the host whose daemon owns it. A session id not in here
/// is the local daemon's. Filled wherever a session is created, resolved
/// or adopted on a link; never pruned, because an id is never reused.
#[derive(Default)]
pub struct SessionHosts(pub Mutex<HashMap<String, String>>);

/// Opens both connections to a host, probes and handshakes on them, and
/// returns the link with the streaming connection's reader still to be
/// handed to `attach_and_relay` once the caller knows what to attach.
pub fn open_link(cfg: &SshConfig) -> anyhow::Result<(Arc<RemoteLink>, Stream)> {
    let Bridge { stream: mut stream_conn, child: mut streaming_child, stderr: streaming_stderr, .. } =
        spawn_bridge(cfg)?;
    let Bridge { stream: command_stream, banner, child: mut command_child, stderr: command_stderr } =
        match spawn_bridge(cfg) {
            Ok(bridge) => bridge,
            Err(e) => {
                let _ = streaming_child.kill();
                return Err(e);
            }
        };
    let command_conn = Mutex::new(command_stream);
    let compat = match establish(&mut stream_conn, &command_conn, &banner) {
        Ok(compat) => compat,
        Err(e) => {
            let _ = streaming_child.kill();
            let _ = command_child.kill();
            return Err(anyhow::anyhow!("{}: {e}", cfg.host));
        }
    };
    let writer = Arc::new(Mutex::new(stream_conn.try_clone()?));
    let host_os = banner.host_os.clone();
    let home = banner.home.clone().unwrap_or_else(|| {
        // A host with no home named is a host misconfigured, but a
        // session still needs somewhere that exists.
        if host_os == "windows" { "C:/".to_string() } else { "/".to_string() }
    });
    let link = Arc::new(RemoteLink {
        id: NEXT_LINK_ID.fetch_add(1, Ordering::Relaxed),
        host: cfg.host.clone(),
        compat,
        command: command_conn,
        writer,
        home,
        host_os,
        mcp_path: banner.mcp_path.clone(),
        children: Mutex::new(vec![streaming_child, command_child]),
        stderr: vec![streaming_stderr, command_stderr],
    });
    Ok((link, stream_conn))
}

/// What the frontend hears when a link is up for a workspace, and when
/// one goes down. camelCase like every payload that crosses to it.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteLinkEvent {
    pub host: String,
    /// The workspace the event is about, when it is about one: a ready
    /// event always is; a lost link affects every workspace on the host.
    pub workspace_id: Option<String>,
    pub message: Option<String>,
    /// What the bridge said the host runs (`linux`, `windows`, `macos`),
    /// on a ready event: the badge can say it, and a path typed for the
    /// wrong OS is the first thing to check when a root is missing.
    pub host_os: Option<String>,
    /// The host daemon's protocol version, on a ready event. The frontend
    /// gates what needs a newer HOST daemon (card runs, v39) on this, not
    /// on the local daemon's verdict, which says nothing about the
    /// machine the run happens on.
    pub daemon_version: Option<u32>,
}

/// Connects a workspace to its host: opens the host's link if this is
/// the first workspace on it, resolves the workspace's pages against the
/// host daemon's sessions (fresh ones there for dead ids, with the host's
/// home as the fallback), attaches them, watches the root, persists the
/// resolved layout and tells every window.
///
/// The mirror of what `bootstrap` does for local workspaces, on the link
/// instead of the local connection -- and deliberately after
/// `workspaces-ready`, so a host that is down costs the app nothing but
/// this workspace, never the window.
pub fn link_workspace(app: &AppHandle, workspace_id: &str) -> anyhow::Result<()> {
    let ws = app
        .state::<WorkspacesState>()
        .0
        .lock()
        .unwrap()
        .workspaces
        .iter()
        .find(|w| w.id == workspace_id)
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("no workspace {workspace_id}"))?;
    let cfg = ws
        .ssh
        .clone()
        .ok_or_else(|| anyhow::anyhow!("{} is not an ssh workspace", ws.name))?;
    let root = ws
        .root_path
        .clone()
        .ok_or_else(|| anyhow::anyhow!("ssh workspace {} names no root path on {}", ws.name, cfg.host))?;

    let existing = app.state::<RemoteLinks>().0.lock().unwrap().get(&cfg.host).cloned();
    let (link, fresh_reader) = match existing {
        Some(link) => (link, None),
        None => {
            let (link, reader) = open_link(&cfg)?;
            app.state::<RemoteLinks>().0.lock().unwrap().insert(cfg.host.clone(), Arc::clone(&link));
            (link, Some(reader))
        }
    };
    // The git router keys on the workspace root so `git::run` can find
    // this link from a bare cwd, with no AppHandle to reach state through.
    register_git_root(&root, Arc::clone(&link));
    // A reconnect gets a new connection, and the host's watchers belonged
    // to the old one. Ask again for whatever the Git tab still thinks is
    // watched under this root.
    rewatch_git_roots(&link, &root);

    let non_session = non_session_tab_ids(
        &app.state::<FileTabs>().0.lock().unwrap(),
        &app.state::<BoardTabs>().0.lock().unwrap(),
        &app.state::<CardTabs>().0.lock().unwrap(),
    );
    let all = list_valid_session_ids(&link.command, &link.compat)?;
    let mut ws = ws;
    for page in ws.pages.iter_mut() {
        resolve_sessions(
            &mut page.layout,
            &link.command,
            &all,
            &non_session,
            &link.compat,
            Some(&root),
            &link.home,
        )?;
    }
    if let Some(id) = ws.main_session_id.clone() {
        if !all.get(&id).is_some_and(|s| s.status != "exited") {
            ws.main_session_id = None;
        }
    }
    let ids: Vec<String> = ws
        .pages
        .iter()
        .flat_map(|p| p.layout.all_session_ids())
        .filter(|id| !non_session.contains(id))
        .chain(ws.main_session_id.clone())
        .collect();
    {
        let hosts = app.state::<SessionHosts>();
        let mut hosts = hosts.0.lock().unwrap();
        for id in &ids {
            hosts.insert(id.clone(), cfg.host.clone());
        }
    }

    let data = {
        let state = app.state::<WorkspacesState>();
        let mut state = state.0.lock().unwrap();
        if let Some(slot) = state.workspaces.iter_mut().find(|w| w.id == workspace_id) {
            *slot = ws.clone();
        }
        state.clone()
    };
    crate::session::persist_current(app, &data)?;

    match fresh_reader {
        Some(reader) => attach_and_relay(
            app,
            &link.writer,
            reader,
            ids,
            link.compat,
            RelayOwner::Remote { host: cfg.host.clone(), link_id: link.id },
        )?,
        None => {
            for id in ids {
                send_request(&link.writer, &Request::Attach { id }, &link.compat)?;
            }
        }
    }
    send_request(
        &link.writer,
        &Request::WatchGavinRoot { workspace_id: workspace_id.to_string(), root_path: root },
        &link.compat,
    )?;

    let _ = app.emit("workspaces-synced", crate::session::WorkspacesSync::from_remote(&cfg.host, data));
    let _ = app.emit(
        "remote-link-ready",
        RemoteLinkEvent {
            host: cfg.host,
            workspace_id: Some(workspace_id.to_string()),
            message: None,
            host_os: Some(link.host_os.clone()),
            daemon_version: Some(link.compat.daemon_version),
        },
    );
    Ok(())
}

/// Links every ssh workspace, one thread per host so a host that is down
/// delays only its own workspaces. Called from `bootstrap` after
/// `workspaces-ready`; a failure is an event for that host, never an
/// error for the window.
pub fn link_all(app: AppHandle) {
    let mut by_host: HashMap<String, Vec<String>> = HashMap::new();
    for ws in &app.state::<WorkspacesState>().0.lock().unwrap().workspaces {
        if let Some(cfg) = &ws.ssh {
            by_host.entry(cfg.host.clone()).or_default().push(ws.id.clone());
        }
    }
    for (host, workspace_ids) in by_host {
        let app = app.clone();
        std::thread::spawn(move || {
            for workspace_id in workspace_ids {
                if let Err(e) = link_workspace(&app, &workspace_id) {
                    let _ = app.emit(
                        "remote-link-lost",
                        RemoteLinkEvent {
                            host: host.clone(),
                            workspace_id: Some(workspace_id),
                            message: Some(e.to_string()),
                            host_os: None,
                            daemon_version: None,
                        },
                    );
                }
            }
        });
    }
}

/// The relay thread's report that a link's streaming connection ended.
/// Unregisters the link -- only if it is still the one registered -- and
/// tells the frontend, with whatever ssh said last.
pub fn link_lost(app: &AppHandle, host: &str, link_id: u64, message: String) {
    let removed = {
        let links = app.state::<RemoteLinks>();
        let mut links = links.0.lock().unwrap();
        match links.get(host) {
            Some(link) if link.id == link_id => links.remove(host),
            _ => None,
        }
    };
    // Drop this host's git-router entries too, so `git::run` stops routing
    // a cwd whose link is gone and falls back to the local error path.
    if removed.is_some() {
        clear_git_host(host);
    }
    let said = removed.as_ref().map(|l| l.last_words()).unwrap_or_default();
    let message = if said.is_empty() { message } else { format!("{message} ({said})") };
    // A fetch running on this host will never report its own end now.
    // Release whoever is parked on it, or that caller sits in `recv` for
    // as long as the app lives, holding the blocking thread it is on --
    // and the toolbar's spinner never stops.
    abandon_git_ops(host, &message);
    let _ = app.emit(
        "remote-link-lost",
        RemoteLinkEvent {
            host: host.to_string(),
            workspace_id: None,
            message: Some(message),
            host_os: None,
            daemon_version: None,
        },
    );
}

/// The Reconnect button, and the first connect of a workspace the human
/// just made an ssh workspace. Async so the ssh connect -- up to ten
/// seconds, by `ConnectTimeout` -- never runs on the main thread.
#[tauri::command]
pub async fn connect_remote_workspace(workspace_id: String, app_handle: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || link_workspace(&app_handle, &workspace_id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

// --- Routing ----------------------------------------------------------------
//
// A command does not know which daemon it is for; the argument it already
// carries does. These answer "whose is it" from the workspace list and
// the session map, and `route_for_*` turns the answer into a connection
// -- or into an error when the workspace IS an ssh one and its host is
// not linked, because an ssh workspace's request must never fall through
// to the local daemon.

pub fn host_for_workspace(workspaces: &[Workspace], workspace_id: &str) -> Option<String> {
    workspaces
        .iter()
        .find(|w| w.id == workspace_id)
        .and_then(|w| w.ssh.as_ref())
        .map(|ssh| ssh.host.clone())
}

fn trim_root(root: &str) -> &str {
    let trimmed = root.trim_end_matches('/');
    if trimmed.is_empty() { root } else { trimmed }
}

pub fn host_for_root(workspaces: &[Workspace], root: &str) -> Option<String> {
    let root = trim_root(root);
    workspaces
        .iter()
        .find(|w| w.root_path.as_deref().map(trim_root) == Some(root))
        .and_then(|w| w.ssh.as_ref())
        .map(|ssh| ssh.host.clone())
}

/// `path` is `root` itself or something inside it -- at a separator, so
/// `/repo2` is not inside `/repo`.
pub fn path_is_under(root: &str, path: &str) -> bool {
    let root = trim_root(root);
    path == root || path.strip_prefix(root).is_some_and(|rest| rest.starts_with('/'))
}

pub fn host_for_path(workspaces: &[Workspace], path: &str) -> Option<String> {
    workspaces
        .iter()
        .filter(|w| w.ssh.is_some())
        .find(|w| w.root_path.as_deref().is_some_and(|root| path_is_under(root, path)))
        .and_then(|w| w.ssh.as_ref())
        .map(|ssh| ssh.host.clone())
}

/// Where a command's request goes.
pub enum Route {
    Local,
    Remote(Arc<RemoteLink>),
}

fn link_by_host(app: &AppHandle, host: &str) -> Result<Route, String> {
    app.state::<RemoteLinks>()
        .0
        .lock()
        .unwrap()
        .get(host)
        .cloned()
        .map(Route::Remote)
        .ok_or_else(|| format!("not connected to {host} — reconnect the workspace"))
}

fn workspaces(app: &AppHandle) -> Vec<Workspace> {
    app.state::<WorkspacesState>().0.lock().unwrap().workspaces.clone()
}

pub fn route_for_session(app: &AppHandle, session_id: &str) -> Result<Route, String> {
    let host = app.state::<SessionHosts>().0.lock().unwrap().get(session_id).cloned();
    match host {
        Some(host) => link_by_host(app, &host),
        None => Ok(Route::Local),
    }
}

pub fn route_for_workspace(app: &AppHandle, workspace_id: &str) -> Result<Route, String> {
    match host_for_workspace(&workspaces(app), workspace_id) {
        Some(host) => link_by_host(app, &host),
        None => Ok(Route::Local),
    }
}

/// `None` -- no root named -- is local: a bare terminal is this machine's.
pub fn route_for_root(app: &AppHandle, root: Option<&str>) -> Result<Route, String> {
    match root.and_then(|root| host_for_root(&workspaces(app), root)) {
        Some(host) => link_by_host(app, &host),
        None => Ok(Route::Local),
    }
}

pub fn route_for_path(app: &AppHandle, path: &str) -> Result<Route, String> {
    match host_for_path(&workspaces(app), path) {
        Some(host) => link_by_host(app, &host),
        None => Ok(Route::Local),
    }
}

/// Every live link, for the reads that span daemons (the sessions
/// manager, the baselines).
pub fn every_link(app: &AppHandle) -> Vec<Arc<RemoteLink>> {
    app.state::<RemoteLinks>().0.lock().unwrap().values().cloned().collect()
}

/// Records that a session the app just created on a link is the link's.
pub fn remember_session(app: &AppHandle, session_id: &str, host: &str) {
    app.state::<SessionHosts>().0.lock().unwrap().insert(session_id.to_string(), host.to_string());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{SshConfig, Workspace};
    use protocol::transport::Stream;
    use protocol::{read_message, write_message, Request, Response};
    use std::io::{BufReader, Read, Write};
    use std::sync::Mutex;
    use std::time::Duration;

    #[test]
    fn banner_parse_reads_what_the_bridge_prints() {
        let line = r#"{"type":"BridgeReady","protocolVersion":38,"daemonToken":"abc","hostOs":"linux","home":"/home/me"}"#;
        let banner = Banner::parse(line).unwrap();
        assert_eq!(banner.protocol_version, 38);
        assert_eq!(banner.daemon_token.as_deref(), Some("abc"));
        assert_eq!(banner.host_os, "linux");
        assert_eq!(banner.home.as_deref(), Some("/home/me"));
    }

    #[test]
    fn banner_parse_tolerates_a_daemon_with_no_token() {
        let line = r#"{"type":"BridgeReady","protocolVersion":34,"daemonToken":null,"hostOs":"windows","home":"C:/Users/me"}"#;
        let banner = Banner::parse(line).unwrap();
        assert_eq!(banner.daemon_token, None);
        assert_eq!(banner.home.as_deref(), Some("C:/Users/me"));
    }

    /// The first line is what ssh printed when it could not run the
    /// bridge -- and that text is the whole diagnosis, so it must reach
    /// the human verbatim.
    #[test]
    fn banner_parse_refuses_anything_else_and_quotes_it() {
        let err = Banner::parse("bash: gavin-daemon: command not found").unwrap_err().to_string();
        assert!(err.contains("gavin-daemon: command not found"), "{err}");
        let err = Banner::parse(r#"{"type":"Ok"}"#).unwrap_err().to_string();
        assert!(err.contains(r#"{"type":"Ok"}"#), "{err}");
    }

    fn cfg(host: &str, daemon_path: Option<&str>) -> SshConfig {
        SshConfig { host: host.to_string(), daemon_path: daemon_path.map(str::to_string) }
    }

    #[test]
    fn ssh_command_runs_the_bridge_through_the_hosts_path_by_default() {
        let (program, args) = ssh_command(&cfg("box", None)).unwrap();
        assert_eq!(program, "ssh");
        let n = args.len();
        assert_eq!(args[n - 1], "\"gavin-daemon\" bridge");
        assert_eq!(args[n - 2], "box");
        assert_eq!(args[n - 3], "--", "the host follows an option terminator: {args:?}");
        assert!(args.windows(2).any(|w| w == ["-o", "BatchMode=yes"]), "{args:?}");
        assert!(args.iter().any(|a| a == "-T"), "no pty is asked for: {args:?}");
    }

    #[test]
    fn ssh_command_quotes_an_explicit_daemon_path_once_for_sh_and_cmd() {
        let (_, args) =
            ssh_command(&cfg("box", Some("C:/Program Files/gavin/gavin-daemon.exe"))).unwrap();
        assert_eq!(args.last().unwrap(), "\"C:/Program Files/gavin/gavin-daemon.exe\" bridge");
    }

    #[test]
    fn ssh_command_refuses_a_host_that_would_not_be_a_host() {
        assert!(ssh_command(&cfg("-oProxyCommand=evil", None)).is_err());
        assert!(ssh_command(&cfg("", None)).is_err());
        assert!(ssh_command(&cfg("bo x", None)).is_err());
        assert!(ssh_command(&cfg("me@box", None)).is_ok());
    }

    #[test]
    fn ssh_command_refuses_a_daemon_path_with_a_double_quote() {
        assert!(ssh_command(&cfg("box", Some("C:/a\"b/gavin-daemon"))).is_err());
        assert!(ssh_command(&cfg("box", Some(""))).is_err());
    }

    // --- The Git tab's watch on a host (v42) ---------------------------

    /// A link whose two connections are `Stream::pair()`s, with the far
    /// end of the streaming one handed back so a test can read what the
    /// app wrote on it. Nothing spawns ssh: what these tests are about is
    /// which request goes out on which connection and what is remembered.
    fn linked_to(host: &str, version: u32) -> (Arc<RemoteLink>, Stream) {
        let (app_side, host_side) = Stream::pair().unwrap();
        let (command_side, _command_far) = Stream::pair().unwrap();
        let link = Arc::new(RemoteLink {
            id: NEXT_LINK_ID.fetch_add(1, Ordering::Relaxed),
            host: host.to_string(),
            compat: DaemonCompat {
                daemon_version: version,
                app_version: protocol::PROTOCOL_VERSION,
                degraded: version < protocol::PROTOCOL_VERSION,
            },
            command: Mutex::new(command_side),
            writer: Arc::new(Mutex::new(app_side)),
            home: "/home/me".to_string(),
            host_os: "linux".to_string(),
            mcp_path: None,
            children: Mutex::new(Vec::new()),
            // The far end of the command pair is dropped by the caller;
            // nothing here reads it.
            stderr: vec![Arc::new(Mutex::new(String::new()))],
        });
        // The command pair's far end drops here on purpose: these tests
        // only ever write on the streaming connection, and a command
        // write would rightly fail with nobody on the other end.
        (link, host_side)
    }

    /// The watch request goes out on the STREAMING connection -- the one
    /// `Attach` and `WatchGavinRoot` use -- because its answer is a push
    /// in its own time, not a reply. Getting this wrong would park the
    /// tab's watch behind whatever the command connection is doing.
    #[test]
    fn watching_a_remote_worktree_sends_the_request_on_the_streaming_connection() {
        let (link, host_side) = linked_to("watch-host", protocol::PROTOCOL_VERSION);
        register_git_root("/home/me/watch-repo", Arc::clone(&link));

        assert!(watch_git_over_link("/home/me/watch-repo").unwrap().is_ok());
        let mut reader = BufReader::new(host_side.try_clone().unwrap());
        let sent: Option<Request> = read_message(&mut reader).unwrap();
        match sent {
            Some(Request::WatchGitWorktree { root_path, cwd }) => {
                assert_eq!(root_path, "/home/me/watch-repo");
                assert_eq!(cwd, "/home/me/watch-repo");
            }
            other => panic!("expected WatchGitWorktree, got {other:?}"),
        }

        // A local cwd is nobody's: the caller then runs its own watcher.
        assert!(watch_git_over_link("/not/under/any/root").is_none());

        assert!(unwatch_git_over_link("/home/me/watch-repo").unwrap().is_ok());
        let sent: Option<Request> = read_message(&mut reader).unwrap();
        assert!(matches!(sent, Some(Request::UnwatchGitWorktree { .. })), "{sent:?}");
        clear_git_host("watch-host");
    }

    /// The gap this closes: a host's watchers belong to the CONNECTION
    /// that asked for them, and a reconnect is a new connection. The
    /// tab's own effect keys on its cwd, which a reconnect does not
    /// change -- so without re-asking here, a Git tab that survived a
    /// dropped link would silently stop refreshing for good.
    #[test]
    fn a_relinked_host_is_asked_to_watch_again_and_only_under_its_own_root() {
        let (first, _first_host) = linked_to("relink-host", protocol::PROTOCOL_VERSION);
        register_git_root("/home/me/relink-repo", Arc::clone(&first));
        let (elsewhere, _elsewhere_host) = linked_to("other-host", protocol::PROTOCOL_VERSION);
        register_git_root("/home/me/relink-other", Arc::clone(&elsewhere));
        let _ = watch_git_over_link("/home/me/relink-repo");
        let _ = watch_git_over_link("/home/me/relink-other");

        // The link drops and comes back as a different connection.
        let (second, second_host) = linked_to("relink-host", protocol::PROTOCOL_VERSION);
        register_git_root("/home/me/relink-repo", Arc::clone(&second));
        rewatch_git_roots(&second, "/home/me/relink-repo");

        let mut reader = BufReader::new(second_host.try_clone().unwrap());
        let sent: Option<Request> = read_message(&mut reader).unwrap();
        match sent {
            // Only this root's cwd: the other host's watch is not this
            // link's to re-establish.
            Some(Request::WatchGitWorktree { cwd, .. }) => assert_eq!(cwd, "/home/me/relink-repo"),
            other => panic!("expected WatchGitWorktree, got {other:?}"),
        }

        let _ = unwatch_git_over_link("/home/me/relink-repo");
        let _ = unwatch_git_over_link("/home/me/relink-other");
        clear_git_host("relink-host");
        clear_git_host("other-host");
    }

    /// A cwd the tab stopped watching is not resurrected by a reconnect.
    #[test]
    fn an_unwatched_cwd_is_not_re_asked_after_a_relink() {
        let (link, _host) = linked_to("forget-host", protocol::PROTOCOL_VERSION);
        register_git_root("/home/me/forget", Arc::clone(&link));
        let _ = watch_git_over_link("/home/me/forget");
        let _ = unwatch_git_over_link("/home/me/forget");

        let (second, second_host) = linked_to("forget-host", protocol::PROTOCOL_VERSION);
        register_git_root("/home/me/forget", Arc::clone(&second));
        rewatch_git_roots(&second, "/home/me/forget");
        // Nothing to read: a non-blocking read of an empty pair would
        // hang, so assert on the bookkeeping the re-ask reads instead.
        assert!(!remote_git_watches().lock().unwrap().contains("/home/me/forget"));
        drop(second_host);
        clear_git_host("forget-host");
    }

    /// The pump with a fake child on two pairs: what the child prints
    /// comes out of the app side, what the app writes reaches the child's
    /// stdin, and the child closing its stdout ends both directions.
    #[test]
    fn pump_relays_both_ways_and_ends_when_the_child_closes() {
        let (child_stdout_w, child_stdout_r) = Stream::pair().unwrap();
        let (child_stdin_r, child_stdin_w) = Stream::pair().unwrap();
        let app = pump(child_stdout_r, child_stdin_w).unwrap();

        (&child_stdout_w).write_all(b"{\"type\":\"Ok\"}\n").unwrap();
        let mut reader = BufReader::new(app.try_clone().unwrap());
        let pushed: Option<Response> = read_message(&mut reader).unwrap();
        assert!(matches!(pushed, Some(Response::Ok)), "{pushed:?}");

        write_message(&mut &app, &Request::GetProtocolVersion).unwrap();
        let mut child_reader = BufReader::new(child_stdin_r.try_clone().unwrap());
        let got: Option<Request> = read_message(&mut child_reader).unwrap();
        assert!(matches!(got, Some(Request::GetProtocolVersion)), "{got:?}");

        // Both timeouts BEFORE the child goes away. Its EOF makes the pump
        // close both of its ends, and macOS refuses SO_RCVTIMEO on a
        // socket whose peer has already closed (EINVAL) -- so a timeout
        // set afterwards raced the pump, and lost most runs.
        app.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        child_stdin_r.set_read_timeout(Some(Duration::from_secs(5))).unwrap();

        // The child goes away.
        drop(child_stdout_w);
        let mut byte = [0u8; 1];
        match (&app).read(&mut byte) {
            Ok(0) => {}
            Ok(_) => panic!("bytes from a dead child"),
            Err(e) => panic!("the app side never saw EOF: {e}"),
        }
        match (&child_stdin_r).read(&mut byte) {
            Ok(0) => {}
            Ok(_) => panic!("bytes after the pump ended"),
            Err(e) => panic!("the child's stdin was never closed: {e}"),
        }
    }

    fn ack(token: &str, nonce: &str) -> Response {
        Response::HelloAck {
            role: "app".to_string(),
            daemon_version: protocol::PROTOCOL_VERSION,
            session_id: None,
            server_proof: Some(protocol::server_proof(token, nonce)),
            workspace_root: None,
        }
    }

    fn banner_with(token: Option<&str>) -> Banner {
        Banner {
            protocol_version: protocol::PROTOCOL_VERSION,
            daemon_token: token.map(str::to_string),
            host_os: "linux".to_string(),
            home: Some("/home/me".to_string()),
            mcp_path: None,
        }
    }

    /// The far daemon's side of `establish`: answers the version probe on
    /// the command connection, then a Hello on each connection with a
    /// proof computed by `prove`. Returns what the two Hellos carried.
    fn fake_daemon(
        daemon_cmd: Stream,
        daemon_stream: Stream,
        prove: impl Fn(&str) -> Response + Send + 'static,
    ) -> std::thread::JoinHandle<Vec<Request>> {
        std::thread::spawn(move || {
            let mut seen = Vec::new();
            let mut cmd_reader = BufReader::new(daemon_cmd.try_clone().unwrap());
            let probe: Request = read_message(&mut cmd_reader).unwrap().unwrap();
            assert!(matches!(probe, Request::GetProtocolVersion), "{probe:?}");
            write_message(
                &mut &daemon_cmd,
                &Response::ProtocolVersion { version: protocol::PROTOCOL_VERSION },
            )
            .unwrap();
            let Ok(Some(hello)) = read_message::<_, Request>(&mut cmd_reader) else {
                return seen;
            };
            let Request::Hello { nonce, .. } = &hello else { panic!("expected Hello, got {hello:?}") };
            write_message(&mut &daemon_cmd, &prove(nonce)).unwrap();
            seen.push(hello);
            let mut s_reader = BufReader::new(daemon_stream.try_clone().unwrap());
            let Ok(Some(hello)) = read_message::<_, Request>(&mut s_reader) else {
                return seen;
            };
            let Request::Hello { nonce, .. } = &hello else { panic!("expected Hello, got {hello:?}") };
            write_message(&mut &daemon_stream, &prove(nonce)).unwrap();
            seen.push(hello);
            seen
        })
    }

    #[test]
    fn establish_probes_the_version_then_presents_the_token_on_both_connections() {
        let (mut app_stream, daemon_stream) = Stream::pair().unwrap();
        let (app_cmd, daemon_cmd) = Stream::pair().unwrap();
        let daemon = fake_daemon(daemon_cmd, daemon_stream, |nonce| ack("t0k3n", nonce));

        let app_cmd = Mutex::new(app_cmd);
        let compat = establish(&mut app_stream, &app_cmd, &banner_with(Some("t0k3n"))).unwrap();
        assert_eq!(compat.daemon_version, protocol::PROTOCOL_VERSION);
        assert!(!compat.degraded);

        let hellos = daemon.join().unwrap();
        assert_eq!(hellos.len(), 2, "one Hello per connection: {hellos:?}");
        for hello in hellos {
            let Request::Hello { client, auth, .. } = hello else { unreachable!() };
            assert_eq!(client, "app");
            assert!(
                matches!(&auth, protocol::HelloAuth::DaemonToken { token } if token == "t0k3n"),
                "{auth:?}"
            );
        }
    }

    /// DP-06 on the far side: something answered on the host that does not
    /// hold the token the bridge read. That is a hard error, as at home.
    #[test]
    fn establish_refuses_a_daemon_whose_proof_does_not_match() {
        let (mut app_stream, daemon_stream) = Stream::pair().unwrap();
        let (app_cmd, daemon_cmd) = Stream::pair().unwrap();
        let _daemon = fake_daemon(daemon_cmd, daemon_stream, |nonce| ack("other", nonce));
        let app_cmd = Mutex::new(app_cmd);
        let err = establish(&mut app_stream, &app_cmd, &banner_with(Some("t0k3n")))
            .unwrap_err()
            .to_string();
        assert!(err.contains("proof"), "{err}");
    }

    /// A host daemon too old to have written a token is still a daemon
    /// inside the window: the link continues as `local` there, exactly as
    /// the app does at home against such a daemon.
    #[test]
    fn establish_sends_no_hello_when_the_banner_carries_no_token() {
        let (mut app_stream, daemon_stream) = Stream::pair().unwrap();
        let (app_cmd, daemon_cmd) = Stream::pair().unwrap();
        let daemon = fake_daemon(daemon_cmd, daemon_stream, |nonce| ack("unused", nonce));
        let app_cmd = Mutex::new(app_cmd);
        establish(&mut app_stream, &app_cmd, &banner_with(None)).unwrap();
        drop(app_cmd);
        drop(app_stream);
        assert!(daemon.join().unwrap().is_empty(), "a Hello was sent with nothing to present");
    }

    #[test]
    fn a_path_is_under_a_root_only_at_a_separator() {
        assert!(path_is_under("/home/me/repo", "/home/me/repo/.gavin-root/plans/x.md"));
        assert!(path_is_under("/home/me/repo/", "/home/me/repo/x"));
        assert!(path_is_under("/home/me/repo", "/home/me/repo"));
        assert!(!path_is_under("/home/me/repo", "/home/me/repo2/x"));
        assert!(!path_is_under("/home/me/repo", "/home/me"));
        assert!(path_is_under("C:/Users/me/repo", "C:/Users/me/repo/.gavin-root/PRD.md"));
    }

    /// Every field but the four required ones defaulted, the way an older
    /// config.json loads -- so this helper never has to be revisited when
    /// a field is added to `Workspace`.
    fn ws(id: &str, root: Option<&str>, host: Option<&str>) -> Workspace {
        let mut value = serde_json::json!({ "id": id, "name": id, "pages": [], "activePageId": null });
        if let Some(root) = root {
            value["rootPath"] = serde_json::json!(root);
        }
        if let Some(host) = host {
            value["ssh"] = serde_json::json!({ "host": host });
        }
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn host_lookups_name_the_workspace_that_owns_an_id_a_root_or_a_path() {
        let list = vec![ws("local", Some("/l"), None), ws("far", Some("/home/me/repo"), Some("box"))];
        assert_eq!(host_for_workspace(&list, "far").as_deref(), Some("box"));
        assert_eq!(host_for_workspace(&list, "local"), None);
        assert_eq!(host_for_workspace(&list, "nope"), None);
        assert_eq!(host_for_root(&list, "/home/me/repo").as_deref(), Some("box"));
        assert_eq!(host_for_root(&list, "/home/me/repo/").as_deref(), Some("box"));
        assert_eq!(host_for_root(&list, "/l"), None);
        assert_eq!(host_for_path(&list, "/home/me/repo/.gavin-root/plans/a.md").as_deref(), Some("box"));
        assert_eq!(host_for_path(&list, "/l/.gavin-root/plans/a.md"), None);
        assert_eq!(host_for_path(&list, "/elsewhere/a.md"), None);
    }
}
