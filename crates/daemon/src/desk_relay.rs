//! The Relay the desk runs on this Mac (v73,
//! `desk-runs-the-local-relay-itself.md`): "Run a Relay on this Mac" in
//! Settings → Remote access, instead of starting `gavin-relay` by hand
//! with its environment and copying its token across
//! (`docs/companion-mobile.md`, "Pair with a local Relay").
//!
//! **Who runs it.** The daemon, not the app window, for the reason the
//! Relay dial lives here (`remote.rs`): the daemon outlives the window. And
//! only a RELEASE build's daemon. The dev and release daemons share one
//! trust store, so they share the option and the token. The human decided
//! (2026-10-15) that a dev daemon never starts a Relay. It reports
//! `other_build` and dials the URL and token the release one stored, as it
//! would any Relay's. A test daemon is a dev build, so it is handed the
//! binary through `GAVIN_DESK_RELAY_BIN`, the way it is handed
//! `GAVIN_DIRECT_PORT`.
//!
//! **What it runs.** `gavin-relay`, the sidecar shipped beside this binary,
//! bound to `0.0.0.0:<port>` with `GAVIN_RELAY_TLS_TERMINATED=1`: in the
//! clear, which `RelayUrl::parse` allows to this network only, and which
//! the phone's own cleartext exception covers on the LAN. Its tokens come
//! from a `0600` file in the data folder, never its environment. It exits
//! when its stdin closes (`GAVIN_RELAY_EXIT_WITH_STDIN`). This daemon
//! holds the other end, so a daemon that dies, however it dies, takes its
//! Relay with it and leaves the port free for the next one.
//!
//! **What it fills in.** The admission token: minted by the desk once,
//! kept as the one stored token (`TrustStore::desk_admission`), and
//! presented by the daemon, carried by the QR and asked for by the direct
//! listener. The URL: `ws://<this Mac's LAN address>:<port>`, written as
//! the stored Relay URL and written again when DHCP renumbers the Mac, with
//! a note saying phones paired before must pair again. The port: the one
//! it took last, so the URL a phone kept keeps working; otherwise the
//! first free one from 8443 that is not a direct listener's (`pick_port`).
//!
//! **Refresh** (`companion-relay-token-refresh.md`). Settings' "Refresh
//! token" mints a new token, and the one it replaced is still accepted
//! for `admission_grace()` (`TrustStore::rotate_desk_admission`). This
//! supervisor then rewrites the tokens file to hold both and tells the
//! Relay to read it again (`reload` on its stdin), so nothing it carries
//! is dropped. It hands the new token to every Device connected to this
//! daemon (`RelayAdmissionChanged`), and when the window closes it
//! forgets the old token and has the Relay read the file again. The
//! supervisor runs in both builds, because both daemons carry Devices and
//! either may have written the rotation to the shared store. Each hands
//! the new token to its own Devices. A Device offline for the whole
//! window is refused at its next dial and told to pair again.

use crate::server::SessionManager;
use crate::trust::RemoteAccess;
use protocol::relay::RELAY_DEFAULT_PORT;
use protocol::{BuildProfile, DeskRelayState};
use std::io::Write;
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Names the `gavin-relay` binary to run, whatever the build: what lets
/// `crates/daemon/tests/device_wire.rs` run the desk's Relay under a dev
/// build's daemon.
const BINARY_SEAM: &str = "GAVIN_DESK_RELAY_BIN";
/// Overrides the port; `0` takes one the system says is free. Many test
/// daemons run at once, and the developer's own Relay may hold 8443.
const PORT_SEAM: &str = "GAVIN_DESK_RELAY_PORT";
/// Shortens the grace window, in seconds, so a test can watch it close.
const GRACE_SEAM: &str = "GAVIN_ADMISSION_GRACE_SECS";

/// How long a refreshed token's predecessor is still accepted. Long
/// enough for a phone in a pocket overnight to connect once and be handed
/// the new token. Short enough that a token handed to someone it should
/// not have been stops working within the day.
const ADMISSION_GRACE: Duration = Duration::from_secs(24 * 60 * 60);

/// The grace window a Refresh opens: `ADMISSION_GRACE`, or the seam's.
pub(crate) fn admission_grace() -> Duration {
    std::env::var(GRACE_SEAM)
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .map(Duration::from_secs)
        .unwrap_or(ADMISSION_GRACE)
}

/// Whether the store's token moved from `heard` to `now` by a Refresh,
/// rather than by being typed in or cleared: the one it replaced is the
/// one in its grace window. What this daemon pushes the new token for.
pub(crate) fn refreshed<'a>(heard: Option<&str>, now: Option<&'a str>, in_grace: Option<&str>) -> Option<&'a str> {
    let (Some(heard), Some(now)) = (heard, now) else { return None };
    (heard != now && in_grace == Some(heard)).then_some(now)
}

/// How many ports from `RELAY_DEFAULT_PORT` up the picker tries.
const PORTS_TRIED: u16 = 16;
/// How often the supervisor looks at the store and the process while
/// nothing wakes it, for the other daemon sharing the store, and for a
/// Mac whose address changed.
const STORE_POLL: Duration = Duration::from_secs(2);
/// How long a started Relay has to answer on its port.
const STARTUP: Duration = Duration::from_secs(10);
const BACKOFF_FLOOR: Duration = Duration::from_secs(2);
const BACKOFF_CEILING: Duration = Duration::from_secs(60);

/// The file of admission tokens the Relay reads, one a line.
const TOKENS_FILE: &str = "desk-relay-tokens";
/// Where the Relay's own output goes.
const LOG_FILE: &str = "desk-relay.log";

/// The binary that runs this Mac's Relay, or `None` when this daemon is
/// not the one to run it.
///
/// The seam's binary whatever the build. Otherwise a release build's
/// `gavin-relay` beside this binary, where the bundle puts its sidecars,
/// and nothing for a dev build: the release daemon is the one that runs
/// it.
pub(crate) fn relay_binary(
    profile: BuildProfile,
    seam: Option<PathBuf>,
    beside: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(binary) = seam.filter(|p| !p.as_os_str().is_empty()) {
        return Some(binary);
    }
    match profile {
        BuildProfile::Dev => None,
        BuildProfile::Release => {
            beside.map(|dir| dir.join(format!("gavin-relay{}", std::env::consts::EXE_SUFFIX)))
        }
    }
}

/// The port the desk's Relay binds.
///
/// The one it took last, while nothing else holds it, so the URL a phone
/// kept from pairing keeps working. Otherwise the first port from
/// `RELAY_DEFAULT_PORT` up that `free` says nothing listens on. Never a
/// direct listener's port: `RelayUrl::refuse_direct_listener` would
/// refuse the URL, and the daemon would be dialling a listener as its
/// Relay. `None` when every port tried is taken.
pub(crate) fn pick_port(
    previous: Option<u16>,
    direct_ports: &[u16],
    free: impl Fn(u16) -> bool,
) -> Option<u16> {
    let usable = |port: u16| port != 0 && !direct_ports.contains(&port) && free(port);
    if let Some(port) = previous.filter(|&p| usable(p)) {
        return Some(port);
    }
    (RELAY_DEFAULT_PORT..RELAY_DEFAULT_PORT.saturating_add(PORTS_TRIED)).find(|&p| usable(p))
}

/// Whether nothing listens on `port`: it can be bound on every address,
/// and nothing answers on loopback. Both checks are needed, because a
/// socket bound to one address does not stop another binding the
/// wildcard.
fn port_is_free(port: u16) -> bool {
    let bindable = TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)).is_ok();
    let answered = TcpStream::connect_timeout(
        &SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
        Duration::from_millis(200),
    )
    .is_ok();
    bindable && !answered
}

/// Writes the Relay's tokens file: one token a line, readable and
/// writable by this user alone. Written to a file beside it and renamed
/// over it, so a Relay reading it never reads half of one.
pub(crate) fn write_tokens(path: &Path, tokens: &[&str]) -> std::io::Result<()> {
    let partial = path.with_extension("partial");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&partial)?;
    // A file left behind wider than this by something else is narrowed:
    // `mode` applies only to a file being created.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    for token in tokens {
        writeln!(file, "{token}")?;
    }
    file.sync_all()?;
    drop(file);
    std::fs::rename(&partial, path)
}

/// A running `gavin-relay`. Dropped, it is stopped.
struct Running {
    child: Child,
    /// Its stdin: closing this is what tells it to exit, should this
    /// daemon die before it can kill it.
    stdin: Option<ChildStdin>,
    port: u16,
    /// The tokens its file holds now. A different set is written and
    /// read again (`reload`), never restarted for: a restart drops every
    /// stream it carries.
    tokens: Vec<String>,
    /// What the human should know about it for as long as it runs: that
    /// its URL changed, so phones paired before must pair again.
    note: Option<String>,
}

impl Drop for Running {
    fn drop(&mut self) {
        drop(self.stdin.take());
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Running {
    /// Has it read its tokens file again.
    fn reload(&mut self) -> std::io::Result<()> {
        let stdin = self.stdin.as_mut().ok_or_else(|| std::io::Error::other("its stdin is closed"))?;
        stdin.write_all(b"reload\n")?;
        stdin.flush()
    }

    /// Why it stopped, if it has: its exit and the last thing it said.
    fn exited(&mut self, log: &Path) -> Option<String> {
        let status = self.child.try_wait().ok()??;
        Some(match last_line(log) {
            Some(said) => format!("gavin-relay stopped ({status}): {said}"),
            None => format!("gavin-relay stopped ({status})"),
        })
    }
}

/// The last line `gavin-relay` wrote to its log, for a status line.
fn last_line(log: &Path) -> Option<String> {
    let text = std::fs::read_to_string(log).ok()?;
    text.lines().rev().map(str::trim).find(|l| !l.is_empty()).map(str::to_string)
}

/// Starts `binary` on `port` and waits until it answers there.
fn start(
    binary: &Path,
    port: u16,
    tokens: &Path,
    log: &Path,
    accepted: Vec<String>,
) -> Result<Running, String> {
    let output = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)
        .map_err(|e| format!("could not open {}: {e}", log.display()))?;
    let errors = output.try_clone().map_err(|e| format!("could not open {}: {e}", log.display()))?;
    // Through `program::command`, as every spawn in this crate is, so it
    // opens no console window on Windows.
    let mut command = crate::program::command(binary);
    command
        .env("GAVIN_RELAY_LISTEN", format!("0.0.0.0:{port}"))
        .env("GAVIN_RELAY_TOKENS_FILE", tokens)
        .env("GAVIN_RELAY_TLS_TERMINATED", "1")
        .env("GAVIN_RELAY_EXIT_WITH_STDIN", "1")
        // The file is where its tokens come from, and nothing else: not a
        // variable this daemon happened to inherit.
        .env_remove("GAVIN_RELAY_TOKENS")
        .env_remove("GAVIN_RELAY_TLS_CERT")
        .env_remove("GAVIN_RELAY_TLS_KEY")
        .stdin(Stdio::piped())
        .stdout(Stdio::from(output))
        .stderr(Stdio::from(errors));
    let mut child =
        command.spawn().map_err(|e| format!("could not start {}: {e}", binary.display()))?;
    let stdin = child.stdin.take();
    let mut running = Running { child, stdin, port, tokens: accepted, note: None };
    let deadline = Instant::now() + STARTUP;
    loop {
        if let Some(why) = running.exited(log) {
            return Err(why);
        }
        let answered = TcpStream::connect_timeout(
            &SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
            Duration::from_millis(200),
        );
        if answered.is_ok() {
            return Ok(running);
        }
        if Instant::now() >= deadline {
            return Err(format!("gavin-relay did not answer on port {port} within {}s", STARTUP.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Starts the supervisor. Called once, by `serve`, after the trust store
/// is open.
pub fn spawn(manager: &Arc<SessionManager>) {
    let manager = Arc::clone(manager);
    let started =
        std::thread::Builder::new().name("desk-relay".into()).spawn(move || supervise(&manager));
    if let Err(e) = started {
        eprintln!("gavin-daemon: could not start the desk's Relay supervisor: {e}");
    }
}

/// Whether the store wants the desk's Relay: the option and remote
/// access both on. A store that cannot be read wants nothing.
fn wanted(manager: &SessionManager) -> bool {
    let Some(trust) = manager.trust() else { return false };
    trust.desk_relay_enabled().unwrap_or(false)
        && trust.remote_access().map(|r| r.enabled).unwrap_or(false)
}

fn supervise(manager: &Arc<SessionManager>) {
    let wake = manager.remote_wake();
    let seam = std::env::var_os(BINARY_SEAM).map(PathBuf::from);
    let beside = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf));
    let binary = relay_binary(manager.build_profile(), seam, beside.as_deref());
    let data = protocol::app_support_dir().ok();
    let mut running: Option<Running> = None;
    let mut backoff = BACKOFF_FLOOR;
    let mut retry_at = Instant::now();
    let mut said: Option<String> = None;
    // The token this daemon last saw in the store, to tell a Refresh by.
    let mut heard: Option<String> = None;
    loop {
        // Read BEFORE the store is, for the reason `remote::supervise`
        // gives.
        let seen = wake.generation();
        hand_over_refreshed_token(manager, &mut heard);
        if !wanted(manager) {
            if running.take().is_some() {
                eprintln!("gavin-daemon: stopped this Mac's Relay");
                forget_url(manager);
            }
            manager.set_desk_relay_state(DeskRelayState::NotWanted);
            backoff = BACKOFF_FLOOR;
            said = None;
            wake.wait_past(seen, Some(STORE_POLL));
            continue;
        }
        let (Some(binary), Some(data)) = (binary.as_deref(), data.as_deref()) else {
            manager.set_desk_relay_state(match binary {
                None => DeskRelayState::OtherBuild,
                Some(_) => DeskRelayState::Failed { why: "the data folder could not be found".into() },
            });
            wake.wait_past(seen, Some(STORE_POLL));
            continue;
        };
        let log = data.join(LOG_FILE);
        match step(manager, binary, data, &log, &mut running, Instant::now() >= retry_at) {
            Ok(Some(state)) => {
                backoff = BACKOFF_FLOOR;
                said = None;
                manager.set_desk_relay_state(state);
            }
            Ok(None) => {}
            Err(why) => {
                running = None;
                if said.as_deref() != Some(why.as_str()) {
                    eprintln!("gavin-daemon: this Mac's Relay: {why}");
                    said = Some(why.clone());
                }
                manager.set_desk_relay_state(DeskRelayState::Failed { why });
                retry_at = Instant::now() + backoff;
                backoff = (backoff * 2).min(BACKOFF_CEILING);
            }
        }
        wake.wait_past(seen, Some(STORE_POLL));
    }
}

/// In both builds: closes a grace window that is due, and when the store's
/// token was refreshed since the last look, hands the new one to every
/// Device connected to this daemon -- before the old one is retired,
/// which is a window away.
fn hand_over_refreshed_token(manager: &SessionManager, heard: &mut Option<String>) {
    let now = (crate::trust::now_us() / 1_000_000).max(0) as u64;
    let (current, in_grace) = {
        let Some(trust) = manager.trust() else { return };
        if trust.retire_admission_if_due(now).unwrap_or(false) {
            eprintln!("gavin-daemon: the admission token a Refresh replaced is no longer accepted");
        }
        let current = trust.remote_access().ok().and_then(|r| r.relay_admission);
        (current, trust.admission_in_grace(now).ok().flatten())
    };
    if let Some(token) = refreshed(heard.as_deref(), current.as_deref(), in_grace.as_deref()) {
        let reached =
            manager.push_to_devices(&protocol::Response::RelayAdmissionChanged { token: token.to_string() });
        eprintln!("gavin-daemon: handed the refreshed admission token to {reached} connected Device(s)");
    }
    *heard = current;
}

/// One look: keeps the running Relay and its URL as the store says, or
/// starts one when `may_start`. The state to show, `None` for "no change
/// to say" (waiting out a backoff), or why it could not run.
fn step(
    manager: &SessionManager,
    binary: &Path,
    data: &Path,
    log: &Path,
    running: &mut Option<Running>,
    may_start: bool,
) -> Result<Option<DeskRelayState>, String> {
    let now = (crate::trust::now_us() / 1_000_000).max(0) as u64;
    let accepted = {
        let trust = manager.trust().ok_or("the trust store is not open")?;
        // A token someone typed in in place of the desk's is replaced by
        // one the desk minted: the desk's Relay would not know it.
        trust.desk_admission().map_err(|e| e.to_string())?;
        trust.admissions_at(now).map_err(|e| e.to_string())?
    };
    let tokens = data.join(TOKENS_FILE);
    let write = |accepted: &[String]| {
        let lines: Vec<&str> = accepted.iter().map(String::as_str).collect();
        write_tokens(&tokens, &lines).map_err(|e| format!("could not write {}: {e}", tokens.display()))
    };
    if let Some(relay) = running.as_mut() {
        if let Some(why) = relay.exited(log) {
            return Err(why);
        }
        // Refreshed, its window closed, or replaced: the file is written
        // again and read again, with every stream kept.
        if relay.tokens != accepted {
            write(&accepted)?;
            relay.reload().map_err(|e| format!("could not tell gavin-relay to read its tokens again: {e}"))?;
            relay.tokens = accepted.clone();
        }
    }
    if running.is_none() {
        if !may_start {
            return Ok(None);
        }
        let port = choose_port(manager)?;
        write(&accepted)?;
        let started = start(binary, port, &tokens, log, accepted)?;
        eprintln!("gavin-daemon: running this Mac's Relay on port {port}");
        *running = Some(started);
    }
    let Some(relay) = running.as_mut() else { return Ok(None) };
    let filled = fill_url(manager, relay.port)?;
    if let Some(moved) = filled.moved_from {
        relay.note = Some(format!(
            "The Relay's address changed from {moved} to {}. Phones paired before reach it no longer — pair them again.",
            filled.url
        ));
    }
    let note = if filled.loopback {
        Some("This Mac has no address on a local network, so only this Mac can reach its Relay — no phone can pair through it until it has one.".to_string())
    } else {
        relay.note.clone()
    };
    Ok(Some(DeskRelayState::Running { port: relay.port, url: filled.url, note }))
}

/// What `fill_url` wrote.
struct Filled {
    url: String,
    /// The URL the desk had filled in before, when this is a different
    /// one: phones paired with that one cannot find this.
    moved_from: Option<String>,
    /// No LAN address, so the URL is loopback.
    loopback: bool,
}

fn choose_port(manager: &SessionManager) -> Result<u16, String> {
    match std::env::var(PORT_SEAM).ok().and_then(|p| p.trim().parse::<u16>().ok()) {
        Some(0) => TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))
            .and_then(|l| l.local_addr())
            .map(|a| a.port())
            .map_err(|e| format!("no free port: {e}")),
        Some(port) => Ok(port),
        None => {
            let previous = manager.trust().and_then(|t| t.desk_relay_port().ok().flatten());
            let direct = crate::direct::direct_ports(manager);
            pick_port(previous, &direct, port_is_free).ok_or_else(|| {
                format!(
                    "every port from {RELAY_DEFAULT_PORT} to {} is taken",
                    RELAY_DEFAULT_PORT + PORTS_TRIED - 1
                )
            })
        }
    }
}

/// Writes the Relay URL for `port` where the store does not hold it
/// already. With no LAN address it is loopback, which only this Mac can
/// reach. Writes nothing when nothing changed: it is asked every poll.
fn fill_url(manager: &SessionManager, port: u16) -> Result<Filled, String> {
    let lan = crate::direct::lan_address();
    let host = lan.map(|a| a.to_string()).unwrap_or_else(|| Ipv4Addr::LOCALHOST.to_string());
    let url = format!("ws://{host}:{port}");
    let trust = manager.trust().ok_or("the trust store is not open")?;
    let fail = |e: anyhow::Error| e.to_string();
    let settings = trust.remote_access().map_err(fail)?;
    let before = trust.desk_relay_url().map_err(fail)?;
    if settings.relay_url.as_deref() != Some(url.as_str()) {
        trust.set_remote_access(&RemoteAccess { relay_url: Some(url.clone()), ..settings }).map_err(fail)?;
        manager.remote_wake().poke();
    }
    if before.as_deref() != Some(url.as_str()) {
        trust.set_desk_relay_url(Some(&url)).map_err(fail)?;
    }
    if trust.desk_relay_port().map_err(fail)? != Some(port) {
        trust.set_desk_relay_port(port).map_err(fail)?;
    }
    let moved_from = before.filter(|b| *b != url);
    Ok(Filled { url, moved_from, loopback: lan.is_none() })
}

/// The option went off: the stored Relay URL, if it is still the one the
/// desk filled in, is cleared, so nothing dials a Relay that is not
/// there. The token stays, and so do the port and the URL the desk
/// remembers: turned on again, the desk's Relay comes back where the
/// phones paired with it expect it.
fn forget_url(manager: &SessionManager) {
    let Some(trust) = manager.trust() else { return };
    let (Ok(settings), Ok(Some(desk))) = (trust.remote_access(), trust.desk_relay_url()) else {
        return;
    };
    if settings.relay_url.as_deref() == Some(desk.as_str()) {
        let _ = trust.set_remote_access(&RemoteAccess { relay_url: None, ..settings });
        manager.remote_wake().poke();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The human's decision (2026-10-15): a release daemon runs the
    /// Relay, a dev daemon never does, and a test names the binary.
    #[test]
    fn only_a_release_daemon_runs_this_macs_relay() {
        let dir = Path::new("/Applications/gavin.app/Contents/MacOS");
        assert_eq!(relay_binary(BuildProfile::Dev, None, Some(dir)), None);
        assert_eq!(
            relay_binary(BuildProfile::Release, None, Some(dir)),
            Some(dir.join(format!("gavin-relay{}", std::env::consts::EXE_SUFFIX)))
        );
        let seam = PathBuf::from("/tmp/target/debug/gavin-relay");
        assert_eq!(relay_binary(BuildProfile::Dev, Some(seam.clone()), Some(dir)), Some(seam));
        assert_eq!(relay_binary(BuildProfile::Dev, Some(PathBuf::new()), Some(dir)), None);
        assert_eq!(relay_binary(BuildProfile::Release, None, None), None);
    }

    #[test]
    fn the_port_is_the_one_it_took_last_while_that_is_free() {
        let direct = [8445, 8446];
        assert_eq!(pick_port(Some(8450), &direct, |_| true), Some(8450));
        assert_eq!(pick_port(Some(8450), &direct, |p| p != 8450), Some(8443), "taken: the first free one");
        assert_eq!(pick_port(None, &direct, |_| true), Some(RELAY_DEFAULT_PORT));
    }

    /// The URL it makes must never be one `RelayUrl::refuse_direct_listener`
    /// refuses: a direct listener's port is skipped, whoever asks.
    #[test]
    fn the_port_is_never_a_direct_listeners_nor_one_something_holds() {
        let direct = [8443, 8445, 8446];
        assert_eq!(pick_port(Some(8445), &direct, |_| true), Some(8444));
        assert_eq!(pick_port(None, &direct, |p| p != 8444), Some(8447));
        assert_eq!(pick_port(None, &[], |_| false), None);
        for previous in [None, Some(8445), Some(8446)] {
            let port = pick_port(previous, &[8445, 8446], |p| p % 2 == 0).unwrap();
            assert!(![8445, 8446].contains(&port), "{port}");
            let url = protocol::relay::RelayUrl::parse(&format!("ws://127.0.0.1:{port}")).unwrap();
            assert!(url.refuse_direct_listener(&[], &[8445, 8446]).is_ok(), "{port}");
        }
    }

    /// A Refresh is a move to a new token whose predecessor is in its grace
    /// window. A token typed in or cleared is not one: nothing is pushed
    /// for it.
    #[test]
    fn only_a_refresh_hands_a_new_token_to_the_devices() {
        assert_eq!(refreshed(Some("old"), Some("new"), Some("old")), Some("new"));
        assert_eq!(refreshed(Some("old"), Some("typed"), None), None, "typed in");
        assert_eq!(refreshed(Some("old"), None, None), None, "cleared");
        assert_eq!(refreshed(None, Some("new"), Some("old")), None, "the first look");
        assert_eq!(refreshed(Some("new"), Some("new"), Some("old")), None, "already handed over");
    }

    #[cfg(unix)]
    #[test]
    fn the_tokens_file_is_this_users_alone_one_token_a_line() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(TOKENS_FILE);
        // Left behind world-readable by something else: narrowed.
        std::fs::write(path.with_extension("partial"), "old").unwrap();
        std::fs::set_permissions(path.with_extension("partial"), std::fs::Permissions::from_mode(0o644))
            .unwrap();
        write_tokens(&path, &["one", "two"]).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "one\ntwo\n");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "{mode:o}");
        write_tokens(&path, &["three"]).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "three\n");
        assert!(!path.with_extension("partial").exists());
    }
}
