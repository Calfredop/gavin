//! Out-of-process coverage for `Request::Shutdown`.
//!
//! `handle_connection`'s `Shutdown` interception ends with
//! `std::process::exit(0)`, so it can't be exercised through the in-process
//! socket harness in `server.rs`'s `mod tests` (`start_test_server` runs
//! `run_server` on a thread *inside* the shared `cargo test` binary -- a
//! real exit there would take down every other test running in that
//! process). Spawning the actual `gavin-daemon` binary as a child process
//! sidesteps that: this test's own process survives the child's exit.

use protocol::{read_message, write_message, Request, Response};
use std::io::BufReader;
use protocol::transport::Stream;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[test]
fn shutdown_replies_over_the_socket_then_the_daemon_process_exits() {
    // A fake $HOME so the daemon binds its socket (and opens its sqlite
    // stores) under a tempdir instead of the developer's real data
    // directory. Getting this wrong would send a live Shutdown to -- and
    // kill -- whatever real daemon happens to be running on the machine
    // this test executes on.
    //
    // Built directly under /tmp on unix rather than tempfile::tempdir()'s
    // default (macOS's $TMPDIR, something like
    // /var/folders/xx/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/T/): appended to
    // "/Library/Application Support/gavin/daemon.sock" (46 chars, and 50
    // for a debug build's daemon-dev.sock), that
    // default overflows sockaddr_un's ~103-byte sun_path limit and bind()
    // fails outright. /tmp keeps the prefix short enough to leave room.
    // Windows has no such budget -- the endpoint there is a pipe name
    // hashed from the path -- so the platform's own temp directory is
    // fine, and there is no /tmp to ask for anyway.
    let temp_root = if cfg!(windows) { std::env::temp_dir() } else { PathBuf::from("/tmp") };
    let home = tempfile::Builder::new()
        .prefix("gavin-shutdown-test-")
        .tempdir_in(&temp_root)
        .unwrap();
    // The same rule the daemon will apply to the environment set below,
    // asked of the same function rather than spelled out again: the three
    // layouts differ per OS, and a hardcoded one would leave this test
    // polling for an endpoint the daemon is not binding.
    let fake = Some(home.path().as_os_str().to_os_string());
    let socket_path = protocol::resolve_app_support_dir(
        fake.clone(),
        None,
        fake.clone(),
        fake.clone(),
        protocol::HostOs::current(),
    )
    .unwrap()
    .join(protocol::profile_file_name("daemon", "sock", protocol::BuildProfile::current()));
    let endpoint = protocol::transport::Endpoint::new(socket_path.clone());

    let mut child = Command::new(env!("CARGO_BIN_EXE_gavin-daemon"))
        .env("HOME", home.path())
        // Each OS's own variable, all set: which one the daemon reads is
        // its decision, and this test must not encode a second copy of
        // it. What matters is that no route out of `app_support_dir`
        // leads to the developer's real data directory.
        .env("LOCALAPPDATA", home.path())
        .env("USERPROFILE", home.path())
        // Off macOS the fake HOME is not enough on its own: an inherited
        // XDG_DATA_HOME outranks it, and the daemon would bind the
        // developer's REAL socket -- the exact "kill the running daemon"
        // accident the tempdir exists to prevent.
        .env_remove("XDG_DATA_HOME")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("failed to spawn gavin-daemon");

    // The daemon prints its "listening on" line before it actually binds
    // (see main.rs), so stdout isn't a readiness signal -- poll the
    // endpoint itself. Asking whether something ANSWERS rather than
    // whether a file exists is the only question with an answer on both
    // platforms: on Windows there is no socket file to stat.
    let bind_deadline = Instant::now() + Duration::from_secs(5);
    while !protocol::transport::is_listening(&endpoint) {
        assert!(
            Instant::now() < bind_deadline,
            "daemon never bound its endpoint at {}",
            socket_path.display()
        );
        std::thread::sleep(Duration::from_millis(20));
    }

    let mut stream = Stream::connect(&socket_path).expect("connect to daemon endpoint");
    write_message(&mut stream, &Request::Shutdown).unwrap();

    // Assertion 1: the reply actually crosses the wire before the process
    // dies. This is the flush-before-exit contract the Shutdown
    // interception depends on (write_message flushes explicitly) -- if a
    // future change reordered exit before the write, this would see EOF
    // (`None`) instead of `Response::Ok`.
    // Without this, a regression where the daemon accepts the connection
    // but neither replies nor exits blocks this read forever -- `cargo
    // test` has no per-test timeout, so that would hang the whole job
    // instead of failing this one test. The exit assertion below is
    // already properly deadlined; this read needs the same guarantee.
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let reply: Option<Response> = read_message(&mut reader).unwrap();
    assert!(matches!(reply, Some(Response::Ok)), "expected Response::Ok, got {reply:?}");

    // Assertion 2 & 3: the whole process exits, not just this connection,
    // and it does so promptly. Polled with a deadline (never a blocking
    // `child.wait()`) so a regression that makes Shutdown a no-op fails
    // this test loudly instead of hanging the suite forever.
    let exit_deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        if let Some(status) = child.try_wait().expect("waiting on daemon process") {
            break status;
        }
        assert!(Instant::now() < exit_deadline, "daemon did not exit within 5s of Shutdown");
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(status.success(), "daemon exited with {status:?}");
}
