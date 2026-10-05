//! The `gavin-relay` program itself: what it refuses to start as, and
//! that what it starts as is a Relay.
//!
//! Configured from the environment, so each test runs it with an
//! environment of its own and nothing inherited.

use gavin_relay::client::{dial, DialError, DialOptions};
use protocol::relay::{rendezvous_id, RefusalReason, RelayHello};
use std::io::{BufRead, BufReader};
use std::process::{Command, Output, Stdio};

fn relay() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_gavin-relay"));
    for (name, _) in std::env::vars() {
        if name.starts_with("GAVIN_RELAY_") {
            command.env_remove(name);
        }
    }
    command.env("GAVIN_RELAY_LISTEN", "127.0.0.1:0");
    command
}

/// Runs a Relay that is expected to refuse to start.
fn refused(command: &mut Command) -> (String, String) {
    let Output { status, stdout, stderr } = command.output().unwrap();
    assert!(!status.success(), "the Relay started");
    (String::from_utf8_lossy(&stdout).into_owned(), String::from_utf8_lossy(&stderr).into_owned())
}

#[test]
fn the_relay_will_not_start_without_an_admission_token() {
    for tokens in [None, Some(""), Some(" , ,")] {
        let mut command = relay();
        command.env("GAVIN_RELAY_TLS_TERMINATED", "1");
        if let Some(tokens) = tokens {
            command.env("GAVIN_RELAY_TOKENS", tokens);
        }
        let (stdout, stderr) = refused(&mut command);
        assert!(stderr.contains("admission token"), "{tokens:?}: {stderr}");
        // Refused BEFORE it bound: a Relay that announced itself and
        // then exited would have been reachable for a moment, and would
        // have told whatever was watching its output that it was up.
        assert!(!stdout.contains("listening"), "{tokens:?}: {stdout}");
    }
}

/// A Relay that came up in the clear because a variable was misspelt
/// would carry every admission token in the clear with it.
#[test]
fn the_relay_will_not_start_in_the_clear_unless_told_tls_is_someone_elses() {
    let (stdout, stderr) = refused(relay().env("GAVIN_RELAY_TOKENS", "let-me-in"));
    assert!(stderr.contains("GAVIN_RELAY_TLS_CERT"), "{stderr}");
    assert!(stderr.contains("GAVIN_RELAY_TLS_TERMINATED"), "{stderr}");
    assert!(!stdout.contains("listening"), "{stdout}");

    // Anything but `1` is not being told.
    let (_, stderr) = refused(
        relay().env("GAVIN_RELAY_TOKENS", "let-me-in").env("GAVIN_RELAY_TLS_TERMINATED", "yes"),
    );
    assert!(stderr.contains("GAVIN_RELAY_TLS_CERT"), "{stderr}");
}

#[test]
fn half_a_certificate_is_refused_by_name() {
    let (_, stderr) = refused(
        relay().env("GAVIN_RELAY_TOKENS", "let-me-in").env("GAVIN_RELAY_TLS_CERT", "/nonexistent"),
    );
    assert!(stderr.contains("go together"), "{stderr}");
}

#[test]
fn a_certificate_that_is_not_one_is_refused_before_the_relay_listens() {
    let dir = tempfile::tempdir().unwrap();
    let cert = dir.path().join("cert.pem");
    let key = dir.path().join("key.pem");
    std::fs::write(&cert, "not a certificate").unwrap();
    std::fs::write(&key, "not a key").unwrap();

    let (stdout, stderr) = refused(
        relay()
            .env("GAVIN_RELAY_TOKENS", "let-me-in")
            .env("GAVIN_RELAY_TLS_CERT", &cert)
            .env("GAVIN_RELAY_TLS_KEY", &key),
    );
    assert!(stderr.contains("certificate"), "{stderr}");
    assert!(!stdout.contains("listening"), "{stdout}");
}

#[test]
fn an_argument_is_refused_rather_than_ignored() {
    let (_, stderr) = refused(relay().arg("--port").arg("9000"));
    assert!(stderr.contains("unknown argument"), "{stderr}");
    assert!(stderr.contains("GAVIN_RELAY_LISTEN"), "{stderr}");
}

/// Kills the Relay a test started, however the test ends.
struct Running(std::process::Child);

impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn the_relay_it_starts_admits_by_token() {
    let mut child = relay()
        .env("GAVIN_RELAY_TLS_TERMINATED", "1")
        // From a file and from the variable, both: either admits.
        .env("GAVIN_RELAY_TOKENS", "from-the-variable")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let _running = Running(child);

    // The one line it prints is where it is listening.
    let mut line = String::new();
    BufReader::new(stdout).read_line(&mut line).unwrap();
    let addr = line
        .strip_prefix("gavin-relay listening on ")
        .and_then(|rest| rest.split_whitespace().next())
        .unwrap_or_else(|| panic!("unexpected first line: {line:?}"));
    let url = format!("ws://{addr}");
    let rendezvous = rendezvous_id(&[1; 32]);

    let admitted = dial(
        &url,
        &RelayHello::workstation("from-the-variable", &rendezvous),
        &DialOptions::default(),
    );
    assert!(admitted.is_ok(), "{:?}", admitted.err().map(|e| e.to_string()));

    match dial(&url, &RelayHello::workstation("another", &rendezvous), &DialOptions::default()) {
        Err(DialError::Refused(RefusalReason::Admission)) => {}
        Err(other) => panic!("expected an admission refusal, got {other}"),
        Ok(_) => panic!("a token the Relay does not hold was admitted"),
    }
}

#[test]
fn tokens_are_read_from_a_file_one_a_line() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = dir.path().join("tokens");
    std::fs::write(&tokens, "first-token\n\n  second-token  \n").unwrap();

    let mut child = relay()
        .env("GAVIN_RELAY_TLS_TERMINATED", "1")
        .env("GAVIN_RELAY_TOKENS_FILE", &tokens)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let _running = Running(child);
    let mut line = String::new();
    BufReader::new(stdout).read_line(&mut line).unwrap();
    let addr = line
        .strip_prefix("gavin-relay listening on ")
        .and_then(|rest| rest.split_whitespace().next())
        .unwrap_or_else(|| panic!("unexpected first line: {line:?}"));
    let url = format!("ws://{addr}");
    let rendezvous = rendezvous_id(&[1; 32]);

    for token in ["first-token", "second-token"] {
        let admitted =
            dial(&url, &RelayHello::workstation(token, &rendezvous), &DialOptions::default());
        assert!(admitted.is_ok(), "{token}: {:?}", admitted.err().map(|e| e.to_string()));
    }
}
