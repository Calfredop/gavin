//! The handover itself is the one part of the self re-exec that the unit
//! tests cannot reach: it only exists as a real process replacing (unix)
//! or spawning (windows) another one over the same stdio, and on Windows
//! that spawn-and-wait is a different mechanism from the `exec` the spec
//! was written for. So this drives the ACTUAL binary against a daemon
//! claiming to be newer than it.
//!
//! What it deliberately does not prove is the buffered-stdin carry: the
//! child inherits the same pipe, so bytes the parent failed to hand over
//! would often still be readable from the pipe and the failure would not
//! show. `the_requests_pipelined_behind_the_in_flight_one_ride_across_the_handover`
//! in the crate's own tests pins that down deterministically instead.

use protocol::{read_message, write_message, Request, Response, PROTOCOL_VERSION};
use std::io::{BufReader, Write};
use std::path::PathBuf;

/// A daemon that answers every version probe with `version` and nothing
/// else. It keeps accepting rather than serving one connection: the
/// successor opens its own, and a one-shot accept would hang it instead
/// of failing it.
fn fake_daemon(version: u32) -> (PathBuf, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fake.sock");
    let listener = protocol::transport::Listener::bind(&path).unwrap();
    std::thread::spawn(move || {
        while let Ok(mut stream) = listener.accept() {
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            while let Ok(Some(req)) = read_message::<_, Request>(&mut reader) {
                let resp = match req {
                    Request::GetProtocolVersion => Response::ProtocolVersion { version },
                    _ => break,
                };
                if write_message(&mut stream, &resp).is_err() {
                    break;
                }
            }
        }
    });
    (path, dir)
}

fn tool_call_line(id: u32) -> String {
    format!(
        r#"{{"jsonrpc":"2.0","id":{id},"method":"tools/call","params":{{"name":"gavin_get_tree","arguments":{{}}}}}}"#
    )
}

#[test]
fn a_newer_daemon_hands_the_session_to_the_binary_at_our_own_path() {
    // Nothing replaces the binary under test between the two processes,
    // so the successor is the same version and meets the same newer
    // daemon. That is the loop guard's real-world case, and it makes the
    // whole chain observable in one run: the parent hands over, the child
    // comes up marked, and the MARKED process answers instead of handing
    // over again. Without the guard this test would never terminate.
    let (socket, _socket_dir) = fake_daemon(PROTOCOL_VERSION + 1);

    // `gavin_get_tree` needs a root, and the root is re-derived from the
    // cwd the successor inherits -- so this also proves the inheritance.
    let ws = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(ws.path().join(".gavin-root")).unwrap();

    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_gavin-mcp"))
        .current_dir(ws.path())
        .env("GAVIN_SESSION_SOCKET", &socket)
        // A test runner that already carried these would start the binary
        // pre-marked and prove nothing.
        .env_remove("GAVIN_MCP_REEXEC")
        .env_remove("GAVIN_MCP_REPLAY")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("the binary under test has to be runnable");

    // Both requests in one write, then EOF: the second is what a client
    // pipelines behind the one that trips the skew.
    let piped = format!("{}\n{}\n", tool_call_line(1), tool_call_line(2));
    child.stdin.take().unwrap().write_all(piped.as_bytes()).unwrap();

    let out = child.wait_with_output().expect("the parent must wait for its successor");
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);

    let replies: Vec<serde_json::Value> =
        stdout.lines().filter(|l| !l.trim().is_empty()).map(|l| serde_json::from_str(l).unwrap()).collect();

    // Exactly two, and in order. Two replies for one id would mean the
    // predecessor answered a request its successor then answered again --
    // the duplicate the `reexec_requested` check exists to prevent.
    assert_eq!(replies.len(), 2, "stdout was:\n{stdout}\nstderr was:\n{stderr}");
    assert_eq!(replies[0]["id"], 1);
    assert_eq!(replies[1]["id"], 2);

    // Answered by the MARKED successor: same binary, so the skew is still
    // there, and a second handover would be a loop.
    for reply in &replies {
        let text = reply.pointer("/result/content/0/text").unwrap().as_str().unwrap();
        assert!(text.contains("newer than this gavin-mcp"), "{text}");
        assert!(text.contains("restart this Claude Code session"), "{text}");
    }

    assert!(
        stderr.contains("re-execing into"),
        "the transcript has to show the handover and the versions either side of it:\n{stderr}"
    );
    assert!(
        stderr.contains(&format!("v{}", PROTOCOL_VERSION + 1)),
        "the stderr line must name the daemon's version:\n{stderr}"
    );
    assert!(
        out.status.success(),
        "the parent exits with the successor's code, so the client sees one process: {:?}",
        out.status
    );
}
