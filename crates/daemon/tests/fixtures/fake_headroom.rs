//! A fake Headroom, for the lifecycle tests.
//!
//! Answers the two things the daemon does with the real one: `--version`
//! and `proxy --host H --port P …`, where it binds the port and serves
//! `/readyz`, `/health`, `/livez` and `/stats` in the shapes Headroom
//! 0.39.1 does. Std only, so the test helper can build it with a bare
//! `rustc` and no dependency has to be resolved.
//!
//! Every `proxy` start appends one line to
//! `$HEADROOM_WORKSPACE_DIR/fake-launches.jsonl`: its pid, its
//! arguments, and every variable it was handed that Headroom would read.
//! That file is how a test sees what a start actually carried.
//!
//! Knobs, all read from the environment it inherits from the daemon:
//!
//! - `FAKE_HEADROOM_VERSION`: the version it claims (default `0.39.1`)
//! - `FAKE_HEADROOM_READY_AFTER_MS`: how long `/readyz` answers 503
//! - `FAKE_HEADROOM_TOKENS_SAVED`: the lifetime total `/stats` reports
//! - `FAKE_HEADROOM_PER_PROJECT_FILE`: a file holding the JSON object
//!   `/stats` reports as `savings.per_project`. Read on every request,
//!   because a test learns a session's id only after the daemon has
//!   started its Headroom; absent or empty is `{}`

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

fn knob(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn json_string(text: &str) -> String {
    let mut out = String::from("\"");
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn record_launch(args: &[String]) {
    let Some(dir) = knob("HEADROOM_WORKSPACE_DIR") else { return };
    let mut env: Vec<(String, String)> = std::env::vars()
        .filter(|(key, _)| key.starts_with("HEADROOM_") || key == "DO_NOT_TRACK")
        .collect();
    env.sort();
    let args: Vec<String> = args.iter().map(|a| json_string(a)).collect();
    let env: Vec<String> =
        env.iter().map(|(k, v)| format!("{}:{}", json_string(k), json_string(v))).collect();
    let line = format!(
        "{{\"pid\":{},\"args\":[{}],\"env\":{{{}}}}}\n",
        std::process::id(),
        args.join(","),
        env.join(",")
    );
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(std::path::Path::new(&dir).join("fake-launches.jsonl"))
    {
        let _ = file.write_all(line.as_bytes());
    }
}

fn value_after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).map(String::as_str)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let version = knob("FAKE_HEADROOM_VERSION").unwrap_or_else(|| "0.39.1".to_string());
    match args.first().map(String::as_str) {
        Some("--version") => {
            println!("headroom, version {version}");
        }
        Some("proxy") => serve(&args, &version),
        _ => {
            eprintln!("fake headroom: unknown arguments {args:?}");
            std::process::exit(2);
        }
    }
}

fn serve(args: &[String], version: &str) {
    record_launch(args);
    let host = value_after(args, "--host").unwrap_or("127.0.0.1");
    let port: u16 = value_after(args, "--port").and_then(|p| p.parse().ok()).unwrap_or(8787);
    let listener = match TcpListener::bind((host, port)) {
        Ok(listener) => listener,
        Err(e) => {
            // What the real one does with a port that is taken.
            eprintln!("fake headroom: cannot bind {host}:{port}: {e}");
            std::process::exit(1);
        }
    };
    let ready_at = Instant::now()
        + Duration::from_millis(
            knob("FAKE_HEADROOM_READY_AFTER_MS").and_then(|v| v.parse().ok()).unwrap_or(0),
        );
    let tokens_saved: u64 =
        knob("FAKE_HEADROOM_TOKENS_SAVED").and_then(|v| v.parse().ok()).unwrap_or(0);
    let per_project_file = knob("FAKE_HEADROOM_PER_PROJECT_FILE");
    println!("fake headroom {version} listening on {host}:{port}");

    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { continue };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let Ok(clone) = stream.try_clone() else { continue };
        let mut reader = BufReader::new(clone);
        let mut request_line = String::new();
        if reader.read_line(&mut request_line).is_err() {
            continue;
        }
        let mut header = String::new();
        while reader.read_line(&mut header).is_ok_and(|n| n > 0) && !header.trim().is_empty() {
            header.clear();
        }
        let path = request_line.split_whitespace().nth(1).unwrap_or("/");
        let ready = Instant::now() >= ready_at;
        let identity = format!("\"service\":\"headroom-proxy\",\"version\":{}", json_string(version));
        let (status, body) = match path {
            "/readyz" if ready => (200, format!("{{{identity},\"status\":\"healthy\",\"ready\":true}}")),
            "/readyz" => (503, format!("{{{identity},\"status\":\"starting\",\"ready\":false}}")),
            "/livez" => (200, format!("{{{identity},\"alive\":true}}")),
            "/health" => (
                200,
                format!(
                    "{{{identity},\"status\":\"healthy\",\"ready\":{ready},\"config\":{{\"pid\":{}}}}}",
                    std::process::id()
                ),
            ),
            "/stats" => {
                let per_project = per_project_file
                    .as_deref()
                    .and_then(|file| std::fs::read_to_string(file).ok())
                    .map(|body| body.trim().to_string())
                    .filter(|body| !body.is_empty())
                    .unwrap_or_else(|| "{}".to_string());
                (
                    200,
                    format!(
                        "{{\"savings\":{{\"per_project\":{per_project}}},\"persistent_savings\":{{\"schema_version\":6,\"lifetime\":{{\"requests\":1,\"tokens_saved\":{tokens_saved}}}}}}}"
                    ),
                )
            }
            _ => (404, "{}".to_string()),
        };
        let _ = write!(
            stream,
            "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
    }
}
