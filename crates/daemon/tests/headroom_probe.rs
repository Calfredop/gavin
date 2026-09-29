//! The concurrency probe, against the REAL pinned Headroom.
//!
//! Headroom #3549: state leaking between two compressions running at
//! once. A fleet is nothing but concurrent compressions, and a leak
//! there means one agent's tool output reaching another agent's model.
//! PR #3556 (0.38.0, gavin's floor) moved the content router's
//! per-request state -- including its tool-call maps -- into
//! context-local storage, which reads as the fix; the issue is still
//! open. So gavin does not take the fix on trust. Every pin bump
//! re-runs this.
//!
//! The probe sends pairs of requests at the same moment, through a
//! daemon-run Headroom, to a fake upstream that records what arrives.
//! The two requests of a pair differ in every piece of content and
//! COLLIDE in every `tool_use` id, because the tool-call map is keyed
//! by that id. Then, for each pair: neither upstream body may carry
//! anything of the other's.
//!
//! Two things keep a pass from being vacuous. Every body must have been
//! compressed -- a proxy that passed everything through has proved
//! nothing about compression. And every body must still carry some of
//! its OWN content: a compressor that replaces a block with "[400 lines
//! omitted]" leaves nothing a leak could be seen in, so the payloads
//! are shaped to survive in part.
//!
//! Ignored by default, because it needs a real Headroom and its model:
//!
//! ```text
//! GAVIN_HEADROOM_PROBE_BIN=/path/to/headroom \
//!   cargo test -p gavin-daemon --test headroom_probe -- --ignored --nocapture
//! ```
//!
//! `HF_HOME` is passed through when set, else the human's own
//! Hugging Face cache is used, so the model is not downloaded per run.
//! `GAVIN_HEADROOM_PROBE_ROUNDS` sets the number of pairs (default 6).
//!
//! If it fails: stop. The floor rises, or the default goes lossless
//! (`--lossless`).

#![cfg(unix)]

#[path = "fixtures/daemon.rs"]
mod daemon;

use daemon::{unavailable_here, wait_up_to, Machine};
use protocol::Request;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// What arrived upstream, by the `metadata.user_id` each request names
/// itself with. Headroom forwards that field untouched, so it says
/// whose body a body is without depending on anything being probed.
type Arrived = Arc<Mutex<HashMap<String, Vec<String>>>>;

/// A fake Anthropic API: records each request body and answers with a
/// small valid message.
fn upstream() -> (u16, Arrived) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let arrived: Arrived = Arc::default();
    let record = Arc::clone(&arrived);
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let record = Arc::clone(&record);
            std::thread::spawn(move || answer(stream, &record));
        }
    });
    (port, arrived)
}

/// One request per connection, and the connection closed after it: a
/// recorder has no use for keep-alive, and a response left half-read on
/// a reused connection is how a proxy comes to retry -- which would put
/// the same body upstream twice and say nothing about Headroom.
fn answer(stream: TcpStream, arrived: &Arrived) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut stream = stream;
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
        return;
    }
    let mut length = 0usize;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).unwrap_or(0) == 0 {
            return;
        }
        let header = header.trim();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().unwrap_or(0);
            }
        }
    }
    let mut body = vec![0u8; length];
    if reader.read_exact(&mut body).is_err() {
        return;
    }
    if !request_line.starts_with("POST") {
        // httpx opens with a `HEAD /`. No body: a HEAD has none.
        let _ = write!(stream, "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
        return;
    }
    let body = String::from_utf8_lossy(&body).into_owned();
    let who = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| v["metadata"]["user_id"].as_str().map(String::from))
        .unwrap_or_else(|| "?".to_string());
    arrived.lock().unwrap().entry(who).or_default().push(body);
    // Long enough for the pair to overlap upstream as well.
    std::thread::sleep(Duration::from_millis(50));
    let reply = json!({
        "id": "msg_probe", "type": "message", "role": "assistant",
        "model": "claude-sonnet-4-5",
        "content": [{"type": "text", "text": "ok"}],
        "stop_reason": "end_turn", "stop_sequence": null,
        "usage": {"input_tokens": 10, "output_tokens": 1}
    })
    .to_string();
    let _ = write!(
        stream,
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}",
        reply.len()
    );
}

/// A service log: mostly INFO, with the errors a log compressor keeps.
fn log(marker: &str) -> String {
    (0..300)
        .map(|i| {
            let failed = i % 41 == 7;
            format!(
                "2026-09-29T01:{:02}:{:02}Z {} worker[{marker}] request {marker}-{i:05} \
                 path=/api/{}/items/{i} status={} note=the {marker} service {} item {i}",
                i % 60,
                (i * 7) % 60,
                if failed { "ERROR" } else { "INFO" },
                marker.to_lowercase(),
                if failed { 500 } else { 200 },
                if failed { "failed on" } else { "processed" },
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// A table, as the JSON a query tool returns it.
fn rows(marker: &str) -> String {
    let rows: Vec<Value> = (0..200)
        .map(|i| {
            json!({
                "id": format!("{marker}-{i:05}"),
                "owner": marker,
                "name": format!("{marker} item {i}"),
                "status": if i % 53 == 5 { "failed" } else { "ok" },
                "size": (i * 131) % 9000,
                "path": format!("/srv/{}/data/{i}.bin", marker.to_lowercase()),
            })
        })
        .collect();
    serde_json::to_string(&rows).unwrap()
}

/// Prose, which is what the compression MODEL is for.
fn prose(marker: &str) -> String {
    (0..24)
        .map(|i| {
            format!(
                "Section {i} of the {marker} design note explains that the {marker} scheduler \
                 keeps a queue of pending {marker} jobs, that each job is retried at most three \
                 times, and that a job which fails its third attempt is moved to the {marker} \
                 dead letter table where an operator has to look at it."
            )
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// The tool results every request carries. The ids are the same in
/// every request, on purpose.
const RESULTS: [(&str, &str, fn(&str) -> String); 3] = [
    ("toolu_01LOG", "Bash", log),
    ("toolu_02ROWS", "mcp__db__query", rows),
    ("toolu_03PROSE", "mcp__wiki__page", prose),
];

fn request(who: &str, marker: &str) -> String {
    let schema = json!({"type": "object", "properties": {"command": {"type": "string"}}});
    json!({
        "model": "claude-sonnet-4-5",
        "max_tokens": 64,
        "metadata": {"user_id": who},
        "system": "You are a coding agent.",
        "tools": RESULTS.iter().map(|(_, tool, _)| json!({
            "name": tool, "description": "Run a command", "input_schema": schema
        })).collect::<Vec<_>>(),
        "messages": [
            {"role": "user", "content": format!("Look at the {marker} service.")},
            {"role": "assistant", "content":
                std::iter::once(json!({"type": "text", "text": "Reading."}))
                    .chain(RESULTS.iter().map(|(id, tool, _)| json!({
                        "type": "tool_use", "id": id, "name": tool,
                        "input": {"command": format!("read {}", marker.to_lowercase())}
                    })))
                    .collect::<Vec<_>>()},
            // The newest turn, which is the one cache mode compresses.
            {"role": "user", "content": RESULTS.iter().map(|(id, _, make)| json!({
                "type": "tool_result", "tool_use_id": id, "content": make(marker)
            })).collect::<Vec<_>>()},
        ]
    })
    .to_string()
}

/// Sends one request the way Claude Code on a subscription login does,
/// tagged the way gavin tags a compressed session. Returns the size of
/// what was sent.
fn send(port: u16, who: &str, marker: &str) -> usize {
    let body = request(who, marker);
    let response = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(300))
        .build()
        .post(&format!("http://127.0.0.1:{port}/v1/messages"))
        .set("content-type", "application/json")
        .set("anthropic-version", "2023-06-01")
        .set("authorization", "Bearer sk-ant-oat01-probe")
        .set("user-agent", "claude-cli/2.1.0 (external, cli)")
        .set("x-headroom-project", who)
        .send_string(&body)
        .unwrap_or_else(|e| panic!("{who}: Headroom did not answer: {e}"));
    assert_eq!(response.status(), 200, "{who}");
    body.len()
}

fn readyz(port: u16) -> Option<Value> {
    let response = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(3))
        .build()
        .get(&format!("http://127.0.0.1:{port}/readyz"))
        .call()
        .ok()?;
    serde_json::from_str(&response.into_string().ok()?).ok()
}

/// The CCR hashes in a body: what a compressor leaves behind for the
/// model to fetch the original with. Derived from the content, so two
/// requests with different content share none.
fn hashes(text: &str) -> BTreeSet<String> {
    text.split("hash=")
        .skip(1)
        .map(|rest| rest.chars().take_while(char::is_ascii_hexdigit).collect::<String>())
        .filter(|hash| !hash.is_empty())
        .collect()
}

#[test]
#[ignore = "needs a real Headroom: set GAVIN_HEADROOM_PROBE_BIN and run with --ignored"]
fn concurrent_compressions_do_not_leak_into_each_other() {
    if unavailable_here() {
        return;
    }
    let bin = std::env::var("GAVIN_HEADROOM_PROBE_BIN")
        .expect("set GAVIN_HEADROOM_PROBE_BIN to the headroom to probe");
    let rounds: usize = std::env::var("GAVIN_HEADROOM_PROBE_ROUNDS")
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(6);
    let models = std::env::var("HF_HOME").unwrap_or_else(|_| {
        format!("{}/.cache/huggingface", std::env::var("HOME").expect("HOME"))
    });

    let (upstream_port, arrived) = upstream();
    let machine = Machine::new();
    let daemon = machine.daemon_with(&[
        // Not one of Headroom's own variables, so the daemon passes it
        // on: it describes where the provider is, which here is the
        // recorder above.
        ("ANTHROPIC_TARGET_API_URL", &format!("http://127.0.0.1:{upstream_port}")),
        ("HF_HOME", &models),
    ]);

    let found = daemon.headroom(Request::DetectHeadroom { located_path: Some(bin.clone()) });
    assert_eq!(found.state, "verified", "{bin}: {:?}", found.reason);
    assert_eq!(
        found.version.as_deref(),
        Some(found.pin.as_str()),
        "the probe is a statement about the pin; {bin} is another version"
    );
    daemon.headroom(Request::StartHeadroom);
    let port = daemon
        .until_ready_within(Duration::from_secs(180))
        .port
        .expect("a running Headroom has a port");

    // The model loads in the background after the proxy is ready, and a
    // request that arrives first is not compressed by it.
    send(port, "warm-up", "WARMUPX");
    wait_up_to(Duration::from_secs(180), "the compression model to load", || {
        readyz(port)?["checks"]["kompress"]["ready"].as_bool()?.then_some(())
    });

    let mut leaks: Vec<String> = Vec::new();
    let mut requests = 0;
    for round in 0..rounds {
        // Markers no compressor can turn into each other: distinct
        // words, the round, and a letter that ends the number.
        let pair = [
            (format!("alpha-{round}"), format!("ALPHA{round}X")),
            (format!("bravo-{round}"), format!("BRAVO{round}X")),
        ];
        let sent: Vec<usize> = std::thread::scope(|scope| {
            let sending: Vec<_> = pair
                .iter()
                .map(|(who, marker)| scope.spawn(move || send(port, who, marker)))
                .collect();
            sending.into_iter().map(|thread| thread.join().unwrap()).collect()
        });

        let arrived = arrived.lock().unwrap();
        let mut seen: Vec<BTreeSet<String>> = Vec::new();
        for (index, (who, marker)) in pair.iter().enumerate() {
            let (_, other) = &pair[1 - index];
            let bodies = arrived.get(who).unwrap_or_else(|| panic!("{who} never reached upstream"));
            requests += 1;
            let mut own = BTreeSet::new();
            // Every body that arrived under this name, should Headroom
            // have sent one twice: a retry is held to the same rule.
            for body in bodies {
                let parsed: Value = serde_json::from_str(body).unwrap();
                let results = parsed["messages"]
                    .as_array()
                    .and_then(|messages| messages.last())
                    .map(|last| last["content"].to_string())
                    .unwrap_or_default();
                assert!(
                    body.len() * 100 < sent[index] * 95,
                    "{who} was not compressed ({} bytes sent, {} upstream): the probe proves \
                     nothing about a proxy that passes content through",
                    sent[index],
                    body.len()
                );
                assert!(
                    results.contains(marker.as_str()),
                    "{who}'s upstream body carries none of its own content, so a leak into \
                     it could not be seen"
                );
                if body.contains(other.as_str()) {
                    leaks.push(format!("{who}'s upstream body carries {other}"));
                }
                own.extend(hashes(&results));
                println!(
                    "round {round}: {who} sent {} bytes, {} upstream, {} of its own markers",
                    sent[index],
                    body.len(),
                    results.matches(marker.as_str()).count()
                );
            }
            seen.push(own);
        }
        let shared: Vec<_> = seen[0].intersection(&seen[1]).cloned().collect();
        if !shared.is_empty() {
            leaks.push(format!("round {round}: both bodies carry the retrieval hash {shared:?}"));
        }
    }

    println!(
        "probed Headroom {} with {requests} concurrent requests: {} leaks",
        found.version.unwrap_or_default(),
        leaks.len()
    );
    assert!(
        leaks.is_empty(),
        "Headroom leaked between concurrent compressions (#3549). Stop: the floor rises, \
         or the default goes lossless.\n{}",
        leaks.join("\n")
    );
    daemon.headroom(Request::StopHeadroom);
}
