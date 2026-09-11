use protocol::transport::Stream;
use protocol::{read_message, write_message, Request, Response};
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

// The daemon's console flag, shared with every other program the app
// starts (`program::command`), for the reason written on it there.
#[cfg(windows)]
use crate::program::CREATE_NO_WINDOW;

/// `EXE_SUFFIX` rather than a bare name: it is "" on unix and ".exe" on
/// Windows, where a file without it is not executable and `externalBin`
/// bundles the binary WITH it. Same rule in `resolve_mcp_binary_path`,
/// and the absolute path gavin writes into a workspace's agent config
/// has to name the file that actually exists.
pub fn resolve_daemon_binary_path() -> anyhow::Result<PathBuf> {
    let current_exe = std::env::current_exe()?;
    let dir = current_exe
        .parent()
        .ok_or_else(|| anyhow::anyhow!("current_exe has no parent directory"))?;
    Ok(dir.join(format!("gavin-daemon{}", std::env::consts::EXE_SUFFIX)))
}

/// Tries to connect to `socket_path`. If nothing is listening, calls
/// `spawn_daemon` to start a process expected to bind that socket, then
/// polls with a short backoff until the connection succeeds or `timeout`
/// elapses.
pub fn connect_or_spawn(
    socket_path: &Path,
    timeout: Duration,
    mut spawn_daemon: impl FnMut() -> anyhow::Result<std::process::Child>,
) -> anyhow::Result<Stream> {
    if let Ok(stream) = Stream::connect(socket_path) {
        return Ok(stream);
    }

    spawn_daemon()?;

    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(stream) = Stream::connect(socket_path) {
            return Ok(stream);
        }
        if Instant::now() >= deadline {
            anyhow::bail!(
                "daemon did not become reachable at {} within {:?}",
                socket_path.display(),
                timeout
            );
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Starts the daemon as a PEER of the app, not a member of its process
/// tree.
///
/// The daemon is designed to outlive the app -- `docs/dev-setup.md` says
/// so, and every session it owns depends on it. On unix that costs
/// nothing: an orphan is reparented to init and keeps running, which is
/// why a plain spawn was right for years.
///
/// On Windows a plain spawn is NOT right, and the difference is a job
/// object. A child joins its parent's job by default, and killing a job
/// kills everything in it -- so `tauri dev` tearing the app down to
/// rebuild took the daemon with it, every PTY session included, two
/// seconds after any source edit. An agent developing gavin inside gavin
/// edits source constantly, which made that workflow impossible rather
/// than merely noisy.
pub fn spawn_real_daemon() -> anyhow::Result<std::process::Child> {
    let binary = resolve_daemon_binary_path()?;
    spawn_detached(&binary)
}

/// Unix: nothing to arrange. Reparenting to init is what makes the
/// daemon outlive the app, and it happens whether or not anyone asks.
#[cfg(not(windows))]
fn spawn_detached(binary: &Path) -> anyhow::Result<std::process::Child> {
    Ok(Command::new(binary).spawn()?)
}

/// Escapes the parent's job object. The one flag that fixes the bug: a
/// daemon inside the app's job dies when that job is killed, and
/// `tauri dev` kills it on every rebuild.
///
/// A job is allowed to REFUSE breakaway, and then `CreateProcess` fails
/// outright rather than ignoring the flag -- so this is attempted, not
/// assumed, and `spawn_detached` retries without it.
#[cfg(windows)]
const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;

/// Its own process group, so a Ctrl-C aimed at the app's group is not
/// also delivered here.
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

/// Signal-isolated, on a hidden console of its own, but still inside
/// the job.
///
/// `CREATE_NO_WINDOW` and not `DETACHED_PROCESS`, which is what this
/// was. Both keep the daemon off the launching terminal's console -- a
/// daemon holding that console dies when the terminal closes, the same
/// "outlives the app" promise broken a second way -- but they differ in
/// what the daemon's own children get. Detached means NO console, and a
/// child with nothing to inherit allocates one, and a new console is a
/// window: the packaged app flashed a terminal for every `git` the
/// daemon ran. No-window means one invisible console the daemon owns
/// and every child inherits. Either way its stdout goes where nobody
/// can see it, which is why the log below exists.
#[cfg(windows)]
const DETACHED_FLAGS: u32 = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP;

/// What is asked for first: the above, plus out of the job entirely.
#[cfg(windows)]
const DETACHED_FLAGS_WITH_BREAKAWAY: u32 = DETACHED_FLAGS | CREATE_BREAKAWAY_FROM_JOB;

/// Windows: on a hidden console of its own, out of the job, and logging
/// to a file.
///
/// The breakaway is tried first and dropped if the job forbids it
/// (`ERROR_ACCESS_DENIED`). Falling back rather than failing is
/// deliberate: a daemon that dies with the app is bad, and a daemon that
/// never starts is worse -- the app would have nothing to connect to at
/// all.
#[cfg(windows)]
fn spawn_detached(binary: &Path) -> anyhow::Result<std::process::Child> {
    use std::os::windows::process::CommandExt;

    /// `ERROR_ACCESS_DENIED`, which is how a job that forbids breakaway
    /// answers -- not a permissions problem to report to anyone.
    const ACCESS_DENIED: i32 = 5;

    let log = daemon_log_file();
    let attempt = |flags: u32| -> std::io::Result<std::process::Child> {
        let mut command = Command::new(binary);
        command.creation_flags(flags);
        // The daemon's console has no window, so anything it printed
        // there would never be seen. Its startup line names the socket
        // it bound, which is the first thing anyone debugging a
        // connection asks for.
        match &log {
            Some(file) => {
                command.stdout(file.try_clone()?).stderr(file.try_clone()?);
            }
            None => {
                command.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
            }
        }
        command.spawn()
    };

    match attempt(DETACHED_FLAGS_WITH_BREAKAWAY) {
        Ok(child) => Ok(child),
        Err(e) if e.raw_os_error() == Some(ACCESS_DENIED) => {
            // Said out loud, because this fallback REINSTATES the bug:
            // a daemon that could not leave the job dies with the app,
            // and the only thing worse than that is it happening
            // silently while a log line claims a daemon started.
            note_breakaway_refused(&log);
            Ok(attempt(DETACHED_FLAGS)?)
        }
        Err(e) => Err(e.into()),
    }
}

/// Records that the daemon had to stay inside the app's job object.
///
/// Written where its output goes, so the line sits immediately before
/// the startup line of the daemon it describes.
#[cfg(windows)]
fn note_breakaway_refused(log: &Option<std::fs::File>) {
    use std::io::Write;
    if let Some(file) = log {
        if let Ok(mut file) = file.try_clone() {
            let _ = writeln!(
                file,
                "gavin: the job object refused CREATE_BREAKAWAY_FROM_JOB, so this daemon is inside the app's job and will be killed with it"
            );
        }
    }
}

/// The file a detached daemon's output goes to, beside its databases.
///
/// Appended, never truncated: the interesting case is a daemon that died
/// and was replaced, and truncating on start is exactly when the line
/// explaining the death would be lost. `None` if it cannot be opened,
/// which sends the output to null rather than refusing to start a daemon
/// over a log file.
#[cfg(windows)]
fn daemon_log_file() -> Option<std::fs::File> {
    let dir = protocol::app_support_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    std::fs::OpenOptions::new().create(true).append(true).open(dir.join("daemon.log")).ok()
}

/// How long a daemon gets to exit after being asked, before the blunt
/// route is used and before a caller looks for a listener again.
///
/// `Request::Shutdown` replies and then calls `std::process::exit`, so
/// the wait is for a process teardown, not for work.
const DAEMON_EXIT_GRACE: Duration = Duration::from_millis(300);

/// Stops the running daemon: over the wire if it can hear, by force if
/// it cannot. The restart path behind the connection-error overlay and
/// the Settings button.
///
/// **Asked first.** `Request::Shutdown` is a clean exit -- the daemon
/// closes its stores rather than losing whatever SQLite had in flight --
/// and it is the only route that exists on every platform. It is not
/// enough on its own, though, and that is the whole reason the second
/// half is still here: `Shutdown` is gated at protocol version 12, so a
/// daemon older than that cannot PARSE the request, and "a daemon too
/// old to talk to" is precisely the failure this function is reached
/// from. A wedged daemon that never replies is the same case.
///
/// So the fallback stays, per platform -- but it is aimed at ONE
/// process: the pid the kernel says is serving this endpoint
/// (`Stream::server_pid`), read off the same connection the polite
/// request goes down. By NAME is what it used to be, and a name is not
/// an address: `taskkill /IM gavin-daemon.exe` and `pkill -x
/// gavin-daemon` reach every daemon on the machine. That is how `cargo
/// test -p app` took down the daemon holding a human's sessions, and how
/// Restart daemon in the dev app took the stable app's with it. A daemon
/// on another socket is now never touched.
///
/// Nothing listening means nothing to stop -- not a reason to go looking
/// more widely -- so that case returns `Ok` having done nothing at all.
/// Same for a connection the kernel will not name an owner for: `None`
/// is "no process to act on", never "kill something else instead".
///
/// The socket file a killed daemon leaves behind is removed by the next
/// one when it binds (see `run_server`); the Windows pipe has no such
/// debris.
pub fn stop_running_daemon(socket_path: &Path) -> anyhow::Result<()> {
    let Ok(stream) = Stream::connect(socket_path) else {
        return Ok(());
    };
    // Read before the request goes down it: a daemon that obeys is gone
    // by the time the reply is handled, and a closed connection has no
    // owner left to name.
    let owner = stream.server_pid();
    if ask_daemon_to_stop(stream).is_ok() && wait_until_gone(socket_path) {
        return Ok(());
    }
    if let Some(pid) = owner {
        kill_daemon_process(pid)?;
        wait_until_gone(socket_path);
    }
    Ok(())
}

/// One `Request::Shutdown`, with the reply read back.
///
/// The reply is what distinguishes "it heard and is going" from "the
/// bytes went into a socket nobody is reading". A read timeout, because
/// a daemon wedged inside a request handler would otherwise hold the
/// restart open forever -- and the caller's answer to that case is the
/// forceful one below, which it cannot reach while blocked here.
///
/// Takes the connection rather than opening its own, because the caller
/// has already asked it who it belongs to and the answer is only good
/// for THAT connection.
fn ask_daemon_to_stop(mut stream: Stream) -> anyhow::Result<()> {
    stream.set_read_timeout(Some(DAEMON_EXIT_GRACE))?;
    write_message(&mut stream, &Request::Shutdown)?;
    let mut reader = BufReader::new(stream.try_clone()?);
    match read_message::<_, Response>(&mut reader)? {
        Some(Response::Ok) => Ok(()),
        other => anyhow::bail!("daemon answered a Shutdown with {other:?}"),
    }
}

/// Polls until nothing answers on the endpoint, or the grace runs out.
///
/// Asking whether something ANSWERS rather than sleeping a fixed 300ms:
/// the old code slept regardless and still raced, because a dying
/// daemon's socket accepts connections until its process actually goes.
/// `false` means one is still there.
fn wait_until_gone(socket_path: &Path) -> bool {
    let endpoint = protocol::transport::Endpoint::new(socket_path.to_path_buf());
    let deadline = Instant::now() + DAEMON_EXIT_GRACE;
    loop {
        if !protocol::transport::is_listening(&endpoint) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Kills the ONE process that was serving the endpoint.
///
/// The fallback half of `stop_running_daemon`, and only ever that. The
/// pid comes from the connection itself, so a daemon this app never
/// connected to -- another workspace's, another install's, the one a
/// human is working in while the suite runs -- is out of reach by
/// construction.
///
/// A pid that is already gone is not an error: the polite request may
/// well have worked and only lost the race in `wait_until_gone`.
fn kill_daemon_process(pid: u32) -> anyhow::Result<()> {
    // The endpoint is served from inside this very process. The app
    // never serves its own socket, so in production this cannot happen;
    // in a test that stands a fake listener in for the daemon it always
    // does, and terminating the test runner is not a fallback. Either
    // way there is no daemon here to kill.
    if pid == std::process::id() {
        return Ok(());
    }
    kill_process(pid)
}

/// `TerminateProcess`, for the same reason `taskkill` needed `/F`:
/// WM_CLOSE reaches top-level windows and the daemon owns none, so the
/// polite Win32 routes answer "can only be terminated forcefully". The
/// exit code is the one Windows itself uses for a process killed from
/// Task Manager, matching `proc::terminate`.
#[cfg(windows)]
fn kill_process(pid: u32) -> anyhow::Result<()> {
    use windows::Win32::Foundation::{CloseHandle, ERROR_INVALID_PARAMETER};
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

    // SAFETY: no pointer arguments; the handle returned is this
    // function's and is closed on the way out.
    let handle = match unsafe { OpenProcess(PROCESS_TERMINATE, false, pid) } {
        Ok(handle) => handle,
        // What Windows answers for a pid that names nothing: the daemon
        // did take the polite request and only lost the race in
        // `wait_until_gone`. Already stopped is the outcome asked for.
        Err(e) if e.code() == ERROR_INVALID_PARAMETER.to_hresult() => return Ok(()),
        // Anything else -- access denied against a daemon running at a
        // different integrity level, most plausibly -- is a restart that
        // did not happen, and saying so beats leaving the caller to
        // reconnect to the daemon it believes it just stopped.
        Err(e) => return Err(e.into()),
    };
    // SAFETY: `handle` is live and owned here.
    let killed = unsafe { TerminateProcess(handle, 1) };
    // SAFETY: closing a handle this function opened, exactly once.
    unsafe {
        let _ = CloseHandle(handle);
    }
    Ok(killed?)
}

/// SIGTERM, which is what `pkill -x gavin-daemon` sent and all this
/// needs to be: the daemon installs no handler for it, so the default
/// action applies and it stops. Nothing escalates to SIGKILL behind it,
/// the same restraint `proc::terminate` states for agents.
#[cfg(not(windows))]
fn kill_process(pid: u32) -> anyhow::Result<()> {
    // SAFETY: `kill` takes a pid and a signal number, no pointers.
    if unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) } == 0 {
        return Ok(());
    }
    let err = std::io::Error::last_os_error();
    // Already gone between the connection and here.
    if err.raw_os_error() == Some(libc::ESRCH) {
        return Ok(());
    }
    Err(err.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::transport::Listener;

    #[test]
    fn resolve_daemon_binary_path_is_sibling_of_current_exe() {
        let path = resolve_daemon_binary_path().unwrap();
        let current_exe = std::env::current_exe().unwrap();
        assert_eq!(path.parent(), current_exe.parent());
        // With the platform's executable suffix, which is what
        // `externalBin` bundles and what CreateProcess will run.
        assert_eq!(
            path.file_name().unwrap(),
            std::ffi::OsStr::new(&format!("gavin-daemon{}", std::env::consts::EXE_SUFFIX))
        );
    }

    /// The whole point of asking before killing: a daemon that can hear
    /// the request gets to close its stores.
    ///
    /// The listener is dropped the moment the connection is accepted,
    /// before the reply rather than after. A real daemon's `Shutdown`
    /// handler replies and then calls `std::process::exit`, which closes
    /// both at one instant; doing it in this order in a test closes the
    /// window in which `wait_until_gone` can still find the endpoint
    /// answering, and that window is the whole difference between this
    /// test asserting what it says and falling through to the forceful
    /// half it is meant to avoid.
    #[test]
    fn stop_asks_over_the_wire_and_returns_once_nothing_answers() {
        let dir = tempfile::tempdir().unwrap();
        let socket_path = dir.path().join("polite.sock");
        let listener = Listener::bind(&socket_path).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut stream = listener.accept().unwrap();
            // Standing in for `std::process::exit`: the endpoint stops
            // answering, which is the only thing the caller can observe.
            drop(listener);
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let req: Option<Request> = read_message(&mut reader).unwrap();
            tx.send(matches!(req, Some(Request::Shutdown))).unwrap();
            write_message(&mut stream, &Response::Ok).unwrap();
            drop(reader);
            drop(stream);
        });
        stop_running_daemon(&socket_path).unwrap();
        assert!(rx.recv().unwrap(), "the daemon was asked, not killed");
    }

    /// Nothing there at all -- the case every restart hits when the
    /// daemon has already gone -- must not become an error, and must not
    /// become a search either.
    ///
    /// This test used to be the bug. An absent socket fails the polite
    /// half by design, so it fell straight through to the by-name sweep
    /// and ran `taskkill /IM gavin-daemon.exe` against the real machine:
    /// `cargo test -p app` took down whatever daemon the human had
    /// running, every session with it. There is no sweep left to reach --
    /// an endpoint nobody answers names no process, and no process is
    /// nothing to kill.
    #[test]
    fn stop_is_content_when_nothing_is_listening() {
        let dir = tempfile::tempdir().unwrap();
        stop_running_daemon(&dir.path().join("absent.sock")).unwrap();
    }

    /// The property the sweep could never have: stopping one daemon
    /// cannot reach another.
    ///
    /// The listener stands in for a daemon on a DIFFERENT socket -- the
    /// stable app's while the dev app restarts, or the human's while the
    /// suite runs. `stop_running_daemon` is pointed somewhere else
    /// entirely, and the only thing that ever connected the two was the
    /// process name they share.
    #[test]
    fn stopping_one_endpoint_leaves_a_daemon_on_another_alone() {
        let theirs = tempfile::tempdir().unwrap();
        let their_socket = theirs.path().join("theirs.sock");
        let _listener = Listener::bind(&their_socket).unwrap();

        let ours = tempfile::tempdir().unwrap();
        stop_running_daemon(&ours.path().join("ours.sock")).unwrap();

        assert!(
            protocol::transport::is_listening(&protocol::transport::Endpoint::new(their_socket)),
            "a daemon on a socket this call never touched must still be there"
        );
    }

    /// The forceful half, reached and declining to fire.
    ///
    /// Any test that stands a fake listener in for the daemon makes the
    /// endpoint's owner the TEST RUNNER, so a fallback that fires on the
    /// pid it was handed would end the suite where it stands. That is
    /// the guard, called with the pid it actually has to refuse. The
    /// assertion is that this line is reached at all.
    #[test]
    fn the_forceful_half_will_not_terminate_this_process() {
        let me = std::process::id();
        kill_daemon_process(me).unwrap();
        assert_eq!(std::process::id(), me, "reached only by a process that was not terminated");
    }

    /// The forceful half, reached in anger.
    ///
    /// A daemon too old to parse `Request::Shutdown` is precisely what
    /// this function is called about -- the compat banner's Restart
    /// button -- and it cannot answer `Ok`. `ask_daemon_to_stop` fails,
    /// and the fallback runs against the pid serving the endpoint.
    ///
    /// This is the shape that used to take the machine's daemon down:
    /// the polite half fails, and the sweep that followed it did not
    /// care which socket anything was on. It now goes to one pid, and
    /// that pid is this process, which `kill_daemon_process` refuses.
    #[test]
    fn stop_falls_back_when_the_daemon_cannot_answer() {
        let dir = tempfile::tempdir().unwrap();
        let socket_path = dir.path().join("too-old.sock");
        let listener = Listener::bind(&socket_path).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let stream = listener.accept().unwrap();
            // Before the request is even read, so the endpoint is gone
            // by the time the caller looks again -- the same reason as
            // in the polite test above.
            drop(listener);
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let req: Option<Request> = read_message(&mut reader).unwrap();
            tx.send(matches!(req, Some(Request::Shutdown))).unwrap();
            // No reply: an old daemon has no handler to answer with.
            drop(reader);
            drop(stream);
        });

        stop_running_daemon(&socket_path).unwrap();

        assert!(rx.recv().unwrap(), "the request went down the wire before the fallback ran");
    }

    #[test]
    fn connect_or_spawn_returns_immediately_if_already_listening() {
        let dir = tempfile::tempdir().unwrap();
        let socket_path = dir.path().join("already.sock");
        let _listener = Listener::bind(&socket_path).unwrap();

        let mut spawn_calls = 0;
        let result = connect_or_spawn(&socket_path, Duration::from_secs(1), || {
            spawn_calls += 1;
            anyhow::bail!("should not be called")
        });

        assert!(result.is_ok());
        assert_eq!(spawn_calls, 0);
    }

    /// A child that stays alive and binds nothing -- what
    /// `connect_or_spawn` is handed when the spawn "succeeds".
    ///
    /// Spelled per platform because there is no one command: `sleep` is
    /// not on Windows, and `timeout` there refuses to run with the
    /// redirected stdin a test harness gives it, so `ping` is the
    /// idiomatic stand-in.
    fn a_child_that_binds_nothing() -> std::io::Result<std::process::Child> {
        #[cfg(unix)]
        {
            crate::program::command("sleep").arg("5").spawn()
        }
        #[cfg(windows)]
        {
            crate::program::command("ping")
                .args(["-n", "6", "127.0.0.1"])
                .stdout(std::process::Stdio::null())
                .spawn()
        }
    }

    #[test]
    fn connect_or_spawn_spawns_and_retries_until_listening() {
        let dir = tempfile::tempdir().unwrap();
        let socket_path = dir.path().join("spawned.sock");

        // The listener comes up a moment AFTER the spawn hook returns,
        // which is the retry loop's whole reason to exist -- and it is
        // bound in-process rather than by an external `nc -lU`, which
        // exists on neither Windows nor a bare CI image.
        let listening = std::sync::Arc::new(std::sync::Mutex::new(None));
        let result = connect_or_spawn(&socket_path, Duration::from_secs(5), || {
            let path = socket_path.clone();
            let slot = std::sync::Arc::clone(&listening);
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(150));
                let listener = Listener::bind(&path).unwrap();
                // Held for the life of the test: dropping it would close
                // the endpoint again mid-connect.
                *slot.lock().unwrap() = Some(listener);
                std::thread::sleep(Duration::from_secs(2));
            });
            Ok(a_child_that_binds_nothing()?)
        });

        assert!(result.is_ok(), "expected connection to succeed");
    }

    #[test]
    fn connect_or_spawn_times_out_if_nothing_ever_listens() {
        let dir = tempfile::tempdir().unwrap();
        let socket_path = dir.path().join("never.sock");

        let result = connect_or_spawn(&socket_path, Duration::from_millis(300), || {
            // Spawn "succeeds" but nothing ever binds the endpoint.
            Ok(a_child_that_binds_nothing()?)
        });

        assert!(result.is_err());
    }

    /// The contract the fallback in `spawn_detached` depends on: the
    /// first attempt leaves the job, the second does not, and neither
    /// keeps a console. Asserted on the flag words rather than on a
    /// spawned process because a job that forbids breakaway is a
    /// property of whatever launched the test runner -- CI, a terminal,
    /// an IDE -- and a test may not assume which.
    #[cfg(windows)]
    #[test]
    fn the_first_spawn_attempt_breaks_out_of_the_job_and_the_retry_does_not() {
        assert_eq!(
            DETACHED_FLAGS_WITH_BREAKAWAY & CREATE_BREAKAWAY_FROM_JOB,
            CREATE_BREAKAWAY_FROM_JOB,
            "the first attempt is the one that escapes tauri dev's job"
        );
        assert_eq!(
            DETACHED_FLAGS & CREATE_BREAKAWAY_FROM_JOB,
            0,
            "the retry must drop the flag the job refused, or it fails the same way again"
        );
        for flags in [DETACHED_FLAGS, DETACHED_FLAGS_WITH_BREAKAWAY] {
            assert_eq!(
                flags & CREATE_NEW_PROCESS_GROUP,
                CREATE_NEW_PROCESS_GROUP,
                "no inherited Ctrl-C"
            );
        }
    }

    /// The daemon must OWN a console -- a hidden one -- rather than have
    /// none. A process with no console at all (`DETACHED_PROCESS`) has
    /// nothing to hand its children, so every `git` the daemon runs
    /// allocates a console of its own, and a new console is a window:
    /// the packaged app flashed a terminal for every command it ran.
    /// `CREATE_NO_WINDOW` gives the daemon one invisible console that
    /// every child inherits, and it is still not the launching
    /// terminal's, so closing that terminal still cannot take the daemon.
    /// What `DETACHED_FLAGS` used to carry and must not again: no
    /// console at all.
    #[cfg(windows)]
    const DETACHED_PROCESS: u32 = 0x0000_0008;

    #[cfg(windows)]
    #[test]
    fn the_daemon_owns_a_hidden_console_rather_than_none() {
        for flags in [DETACHED_FLAGS, DETACHED_FLAGS_WITH_BREAKAWAY] {
            assert_eq!(
                flags & CREATE_NO_WINDOW,
                CREATE_NO_WINDOW,
                "a hidden console of its own, for its children to inherit"
            );
            assert_eq!(
                flags & DETACHED_PROCESS,
                0,
                "DETACHED_PROCESS leaves children nothing to inherit, and CreateProcess does not combine it with CREATE_NO_WINDOW"
            );
        }
    }
}
