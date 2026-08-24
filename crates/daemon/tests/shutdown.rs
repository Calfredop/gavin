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
use std::os::unix::net::UnixStream;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[test]
fn shutdown_replies_over_the_socket_then_the_daemon_process_exits() {
    // A fake $HOME so the daemon binds its socket (and opens its sqlite
    // stores) under a tempdir instead of the developer's real
    // ~/Library/Application Support/gavin. Getting this wrong would send a
    // live Shutdown to -- and kill -- whatever real daemon happens to be
    // running on the machine this test executes on.
    //
    // Built directly under /tmp rather than tempfile::tempdir()'s default
    // (macOS's $TMPDIR, something like
    // /var/folders/xx/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/T/): appended to
    // "/Library/Application Support/gavin/daemon.sock" (47 chars), that
    // default overflows sockaddr_un's ~103-byte sun_path limit and bind()
    // fails outright. /tmp keeps the prefix short enough to leave room.
    let home = tempfile::Builder::new().prefix("gavin-shutdown-test-").tempdir_in("/tmp").unwrap();
    let socket_path = home
        .path()
        .join("Library")
        .join("Application Support")
        .join("gavin")
        .join("daemon.sock");

    let mut child = Command::new(env!("CARGO_BIN_EXE_gavin-daemon"))
        .env("HOME", home.path())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("failed to spawn gavin-daemon");

    // The daemon prints its "listening on" line before it actually binds
    // (see main.rs), so stdout isn't a readiness signal -- poll for the
    // socket file the way server.rs's own start_test_server() does.
    let bind_deadline = Instant::now() + Duration::from_secs(5);
    while !socket_path.exists() {
        assert!(
            Instant::now() < bind_deadline,
            "daemon never bound its socket at {}",
            socket_path.display()
        );
        std::thread::sleep(Duration::from_millis(20));
    }

    let mut stream = UnixStream::connect(&socket_path).expect("connect to daemon socket");
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
