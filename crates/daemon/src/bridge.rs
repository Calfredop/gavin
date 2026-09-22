//! `gavin-daemon bridge`: the host side of an ssh workspace.
//!
//! The desktop runs `ssh <host> gavin-daemon bridge` and speaks the daemon
//! protocol over the child's stdio. This process is the far end of that:
//! it connects to THIS host's own daemon endpoint -- the Unix socket or
//! the named pipe `protocol::socket_path` names for this build -- starts
//! a daemon when nothing answers, prints one banner line, and then copies
//! bytes in both directions until either side closes.
//!
//! It is a subcommand of the daemon binary rather than a binary of its
//! own so that a host has ONE file to install, and so the daemon it
//! starts is always its own version, binding the endpoint its own
//! profile names. See
//! `docs/superpowers/specs/2026-09-22-ssh-workspaces-design.md` §2 and §6.
//!
//! What it deliberately is not: an ssh port-forward. OpenSSH forwards TCP
//! ports and Unix sockets, and on Windows the daemon's endpoint is
//! neither. Stdio works on every host OS, needs no port and no listener,
//! and ends when the ssh session does.

use protocol::transport::{Endpoint, Stream};
use serde::Serialize;
use std::io::{ErrorKind, Read, Write};
use std::net::Shutdown;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// What the command line may say.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Options {
    /// Fail rather than start a daemon when nothing is listening. The
    /// tests' flag: a fake listener is the daemon there, and a real one
    /// starting beside it would be a second process nobody asked for.
    pub no_spawn: bool,
}

/// Everything after `bridge` on the command line.
pub fn parse_args<I: IntoIterator<Item = String>>(args: I) -> anyhow::Result<Options> {
    let mut opts = Options::default();
    for arg in args {
        match arg.as_str() {
            "--no-spawn" => opts.no_spawn = true,
            other => anyhow::bail!(
                "gavin-daemon bridge: unknown argument {other:?} (the only flag is --no-spawn)"
            ),
        }
    }
    Ok(opts)
}

/// The first line on stdout, before any protocol byte.
///
/// `daemon_token` is what lets the desktop become `app` on THIS daemon:
/// it sends `Hello { DaemonToken }` and checks the proof, exactly as it
/// does locally, so the gate is exercised and `require_local_token` here
/// does not narrow it. Read after the connect succeeded, never before,
/// so a daemon this process just started has minted it. `None` against a
/// daemon too old to write one; the desktop then continues as `local`,
/// the same as it does against such a daemon at home.
///
/// `home` is the cwd a session falls back to when the one it was asked
/// for is gone -- the desktop's own home is on the wrong machine.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Banner {
    #[serde(rename = "type")]
    kind: &'static str,
    protocol_version: u32,
    daemon_token: Option<String>,
    host_os: &'static str,
    home: Option<String>,
    /// The `gavin-mcp` beside this binary, when there is one: the path
    /// the desktop writes into an ssh workspace's MCP config, so the
    /// agent that runs here finds its tools here. `None` says the host
    /// has none installed, which the desktop reports rather than writing
    /// a path that is not there.
    mcp_path: Option<String>,
}

pub fn run(opts: Options) -> anyhow::Result<()> {
    let endpoint = Endpoint::new(protocol::socket_path()?);
    let stream = if opts.no_spawn { connect(&endpoint)? } else { connect_or_spawn(&endpoint)? };
    let banner = Banner {
        kind: "BridgeReady",
        protocol_version: protocol::PROTOCOL_VERSION,
        daemon_token: read_daemon_token(),
        host_os: std::env::consts::OS,
        home: home_dir(),
        mcp_path: mcp_beside_this_binary(),
    };
    let stdout = std::io::stdout();
    protocol::write_message(&mut stdout.lock(), &banner)?;
    relay(stream, std::io::stdin(), stdout);
    Ok(())
}

fn connect(endpoint: &Endpoint) -> anyhow::Result<Stream> {
    Stream::connect(endpoint).map_err(|e| {
        anyhow::anyhow!("no gavin daemon is listening at {endpoint} ({e}) and --no-spawn was given")
    })
}

/// How long a daemon this process started gets to bind. Longer than the
/// app's three seconds: a cold host opening three SQLite stores over a
/// network home directory is the case this exists for.
const SPAWN_GRACE: Duration = Duration::from_secs(10);

fn connect_or_spawn(endpoint: &Endpoint) -> anyhow::Result<Stream> {
    if let Ok(stream) = Stream::connect(endpoint) {
        return Ok(stream);
    }
    spawn_daemon()?;
    let deadline = Instant::now() + SPAWN_GRACE;
    loop {
        if let Ok(stream) = Stream::connect(endpoint) {
            return Ok(stream);
        }
        if Instant::now() >= deadline {
            anyhow::bail!(
                "started a gavin daemon but nothing came to listen at {endpoint} within {SPAWN_GRACE:?}"
            );
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Starts this same binary as a daemon, detached from this process and
/// from the ssh session that started this process.
///
/// Its stdio is NOT this process's: a child holding ssh's pipes keeps the
/// ssh channel open after the bridge exits, and would interleave its own
/// startup line with the protocol. Stdin is null; stdout and stderr go to
/// the per-profile `daemon.log` beside its databases, the file the app
/// writes on Windows, so the line naming the endpoint it bound is where
/// someone debugging a host will look.
fn spawn_daemon() -> anyhow::Result<()> {
    let exe = std::env::current_exe()?;
    let log = log_file();
    let build = |command: &mut Command| -> anyhow::Result<()> {
        command.stdin(Stdio::null());
        match &log {
            Some(file) => {
                command.stdout(file.try_clone()?).stderr(file.try_clone()?);
            }
            None => {
                command.stdout(Stdio::null()).stderr(Stdio::null());
            }
        }
        Ok(())
    };
    spawn_detached(&exe, build)?;
    Ok(())
}

/// Unix: its own session. Without `setsid` the daemon stays in the ssh
/// session's process group, and sshd tearing that session down reaches
/// it -- the daemon dying with the window is the one thing the daemon
/// exists not to do.
#[cfg(unix)]
fn spawn_detached(
    exe: &std::path::Path,
    build: impl Fn(&mut Command) -> anyhow::Result<()>,
) -> anyhow::Result<std::process::Child> {
    use std::os::unix::process::CommandExt;
    let mut command = crate::program::command(exe);
    build(&mut command)?;
    // SAFETY: `setsid` is async-signal-safe and touches nothing the
    // parent shares; the closure allocates nothing.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    Ok(command.spawn()?)
}

/// Windows: out of the job and off any console, the way the app spawns
/// its daemon (`app/src-tauri/src/daemon.rs`), because the OpenSSH
/// server's session is a job that is torn down with the connection.
///
/// And with this process's own stdio marked non-inheritable first. A
/// child on Windows inherits every inheritable handle its parent holds,
/// not only the three it is given as stdio -- and the pipes sshd handed
/// this process are inheritable, since that is how they were handed
/// over. A daemon holding a copy of them keeps the ssh channel open for
/// as long as it lives, which is exactly as long as the human's
/// sessions. Clearing the flag here costs the bridge nothing: it still
/// reads and writes them, it just stops passing them on.
#[cfg(windows)]
fn spawn_detached(
    exe: &std::path::Path,
    build: impl Fn(&mut Command) -> anyhow::Result<()>,
) -> anyhow::Result<std::process::Child> {
    use std::os::windows::process::CommandExt;

    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    /// How a job that forbids breakaway answers.
    const ACCESS_DENIED: i32 = 5;

    stop_inheriting_stdio();

    let attempt = |flags: u32| -> anyhow::Result<std::process::Child> {
        let mut command = crate::program::command(exe);
        build(&mut command)?;
        command.creation_flags(flags);
        Ok(command.spawn()?)
    };
    let base = crate::program::CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP;
    match attempt(base | CREATE_BREAKAWAY_FROM_JOB) {
        Ok(child) => Ok(child),
        Err(e)
            if e.downcast_ref::<std::io::Error>().and_then(|e| e.raw_os_error())
                == Some(ACCESS_DENIED) =>
        {
            attempt(base)
        }
        Err(e) => Err(e),
    }
}

#[cfg(windows)]
fn stop_inheriting_stdio() {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::{SetHandleInformation, HANDLE, HANDLE_FLAGS, HANDLE_FLAG_INHERIT};
    for handle in [
        std::io::stdin().as_raw_handle(),
        std::io::stdout().as_raw_handle(),
        std::io::stderr().as_raw_handle(),
    ] {
        if handle.is_null() {
            continue;
        }
        // SAFETY: a handle this process owns, and the call only changes
        // its inheritance flag.
        let _ = unsafe { SetHandleInformation(HANDLE(handle), HANDLE_FLAG_INHERIT.0, HANDLE_FLAGS(0)) };
    }
}

/// Appended, never truncated, like the app's: the interesting line is the
/// one a daemon that died wrote last.
fn log_file() -> Option<std::fs::File> {
    let dir = protocol::app_support_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join(protocol::profile_file_name("daemon", "log", protocol::BuildProfile::current()));
    std::fs::OpenOptions::new().create(true).append(true).open(path).ok()
}

fn read_daemon_token() -> Option<String> {
    std::fs::read_to_string(protocol::daemon_token_path().ok()?)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// `gavin-mcp` next to this executable, the way the desktop app resolves
/// its own (`resolve_mcp_binary_path`): the three binaries of a build are
/// siblings by construction, so beside the daemon is where an install
/// puts it. Forward-slashed for the wire.
fn mcp_beside_this_binary() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let path = exe.parent()?.join(format!("gavin-mcp{}", std::env::consts::EXE_SUFFIX));
    path.is_file().then(|| protocol::wire_path(&path))
}

/// This user's home on this host, forward-slashed like every path on the
/// wire.
fn home_dir() -> Option<String> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .filter(|v| !v.is_empty())
        .map(|v| protocol::wire_path(std::path::Path::new(&v)))
}

/// Copies `input` to the daemon and the daemon to `output` until one side
/// ends, then ends the other.
///
/// The daemon-to-output direction runs on this thread and the other on
/// a second one, over a clone of the same connection. The two endings
/// are not symmetric. `input` closing -- the ssh session is gone -- is
/// answered by shutting the connection down, which unblocks the read
/// below and lets this function return. The daemon closing is answered
/// by returning, and the input thread, blocked in a read nobody can
/// interrupt, ends with the process. Either way nothing is left holding
/// the daemon's connection, so its per-connection watchers go with it.
///
/// Output is flushed after every chunk. The wire is newline-delimited
/// and a chunk boundary is not a message boundary, so the reader on the
/// far side is waiting for the rest of a line, not for a flush.
fn relay(stream: Stream, mut input: impl Read + Send + 'static, mut output: impl Write) {
    let Ok(to_daemon) = stream.try_clone() else { return };
    std::thread::spawn(move || {
        let mut buf = [0u8; 64 * 1024];
        loop {
            match input.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if (&to_daemon).write_all(&buf[..n]).is_err() {
                        break;
                    }
                }
                Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        let _ = to_daemon.shutdown(Shutdown::Both);
    });

    let mut buf = [0u8; 64 * 1024];
    loop {
        match (&stream).read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if output.write_all(&buf[..n]).and_then(|_| output.flush()).is_err() {
                    break;
                }
            }
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    let _ = stream.shutdown(Shutdown::Both);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn no_arguments_means_spawn_is_allowed() {
        assert_eq!(parse_args(args(&[])).unwrap(), Options { no_spawn: false });
    }

    #[test]
    fn no_spawn_is_the_one_flag() {
        assert_eq!(parse_args(args(&["--no-spawn"])).unwrap(), Options { no_spawn: true });
    }

    #[test]
    fn anything_else_is_refused_by_name() {
        let err = parse_args(args(&["--endpoint", "/x"])).unwrap_err().to_string();
        assert!(err.contains("--endpoint"), "{err}");
    }

    /// The relay with both ends in-process: what goes in one side comes
    /// out the other, and closing the input side ends the daemon side.
    #[test]
    fn relay_copies_both_ways_and_closes_the_daemon_when_input_ends() {
        let (daemon_side, bridge_side) = Stream::pair().unwrap();
        let (input_writer, input_reader) = Stream::pair().unwrap();
        let output = std::sync::Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));

        struct SharedOut(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
        impl Write for SharedOut {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        let out = SharedOut(std::sync::Arc::clone(&output));
        let relay_thread = std::thread::spawn(move || relay(bridge_side, input_reader, out));

        // Desktop -> daemon.
        (&input_writer).write_all(b"{\"type\":\"GetProtocolVersion\"}\n").unwrap();
        let mut got = [0u8; 64];
        let n = (&daemon_side).read(&mut got).unwrap();
        assert_eq!(&got[..n], b"{\"type\":\"GetProtocolVersion\"}\n");

        // Daemon -> desktop.
        (&daemon_side).write_all(b"{\"type\":\"Ok\"}\n").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while output.lock().unwrap().is_empty() {
            assert!(Instant::now() < deadline, "nothing relayed to the output");
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(output.lock().unwrap().as_slice(), b"{\"type\":\"Ok\"}\n");

        // Input ends: the daemon sees EOF and the relay returns.
        drop(input_writer);
        let n = (&daemon_side).read(&mut got).unwrap_or(0);
        assert_eq!(n, 0, "the daemon side should have been shut down");
        relay_thread.join().unwrap();
    }
}
