//! One child process, run to completion or killed at its deadline.
//!
//! The shape `app/src-tauri/src/superpowers.rs` and `gavin::run_git`
//! already use, for the same three reasons. The program and its
//! arguments are an argv array, never a shell string, so nothing in a
//! path or a version can become a second command. There is a timeout,
//! because every run here is hidden and a hidden run with no ceiling is
//! a spinner with no end. And both pipes are drained on threads, because
//! a child that fills one while nobody reads it blocks forever on a
//! write -- `uv tool install` prints a line per package.

use std::io::Read;
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

/// What a finished run said.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Run {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

impl Run {
    pub fn succeeded(&self) -> bool {
        self.code == 0
    }

    /// Both streams as a human reads them. stdout first: it carries the
    /// progress, and stderr the reason the run stopped.
    pub fn combined(&self) -> String {
        let mut out = String::new();
        for part in [self.stdout.trim_end(), self.stderr.trim_end()] {
            if part.is_empty() {
                continue;
            }
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(part);
        }
        out
    }
}

/// How long a drain thread is waited on once the child has exited.
///
/// Bounded, because the pipe stays open for as long as ANY process holds
/// its write end: a child killed at the deadline can leave a grandchild
/// behind with the pipe inherited, and `read_to_end` then never returns.
/// The run is over either way, and what was read so far is lost rather
/// than the request.
const DRAIN_GRACE: Duration = Duration::from_secs(2);

pub fn run(
    program: &Path,
    args: &[&str],
    envs: &[(&str, &str)],
    timeout: Duration,
) -> Result<Run, String> {
    let name = program.display();
    let mut command = crate::program::command(program);
    command
        .args(args)
        // Nothing here is interactive, and a child that decides to ask
        // anyway must hit EOF rather than wait out the deadline.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in envs {
        command.env(key, value);
    }
    let mut child = command.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("{name} was not found")
        } else {
            format!("failed to run {name}: {e}")
        }
    })?;

    let mut out_pipe = child.stdout.take().ok_or("stdout unavailable")?;
    let mut err_pipe = child.stderr.take().ok_or("stderr unavailable")?;
    let (out_tx, out_rx) = std::sync::mpsc::channel();
    let (err_tx, err_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = out_pipe.read_to_end(&mut buf);
        let _ = out_tx.send(String::from_utf8_lossy(&buf).into_owned());
    });
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = err_pipe.read_to_end(&mut buf);
        let _ = err_tx.send(String::from_utf8_lossy(&buf).into_owned());
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "{name} {} timed out after {}s",
                        args.join(" "),
                        timeout.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(format!("failed waiting for {name}: {e}")),
        }
    };

    Ok(Run {
        stdout: out_rx.recv_timeout(DRAIN_GRACE).unwrap_or_default(),
        stderr: err_rx.recv_timeout(DRAIN_GRACE).unwrap_or_default(),
        code: status.code().unwrap_or(-1),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn script(dir: &Path, name: &str, body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    #[test]
    fn a_run_returns_both_streams_and_the_exit_code() {
        let dir = tempfile::tempdir().unwrap();
        let program = script(dir.path(), "both.sh", "echo out; echo err >&2; exit 3");
        let run = run(&program, &[], &[], Duration::from_secs(10)).unwrap();
        assert_eq!(run.stdout, "out\n");
        assert_eq!(run.stderr, "err\n");
        assert_eq!(run.code, 3);
        assert!(!run.succeeded());
        assert_eq!(run.combined(), "out\nerr");
    }

    #[cfg(unix)]
    #[test]
    fn arguments_and_environment_reach_the_child_as_given() {
        let dir = tempfile::tempdir().unwrap();
        let program = script(dir.path(), "echo.sh", r#"printf '%s|%s|%s' "$1" "$2" "$GAVIN_RUN_TEST""#);
        // One argument with a space and a shell metacharacter in it:
        // an argv array carries it whole, a shell string would split it
        // and run the second half.
        let run = run(
            &program,
            &["a b; echo injected", "headroom-ai[all]==0.39.1"],
            &[("GAVIN_RUN_TEST", "set")],
            Duration::from_secs(10),
        )
        .unwrap();
        assert_eq!(run.stdout, "a b; echo injected|headroom-ai[all]==0.39.1|set");
    }

    /// The deadlock the drain threads exist for: more output than a pipe
    /// buffer holds (64 KiB on Linux, 16-64 KiB on macOS), on both
    /// streams, from a child nobody would otherwise be reading.
    #[cfg(unix)]
    #[test]
    fn a_child_that_fills_both_pipes_still_finishes() {
        let dir = tempfile::tempdir().unwrap();
        let program = script(
            dir.path(),
            "chatty.sh",
            "i=0; while [ $i -lt 4000 ]; do \
             echo 'a line of output that is long enough to fill a pipe buffer quickly'; \
             echo 'a line of errors that is long enough to fill a pipe buffer quickly' >&2; \
             i=$((i+1)); done",
        );
        let run = run(&program, &[], &[], Duration::from_secs(30)).unwrap();
        assert_eq!(run.code, 0);
        assert_eq!(run.stdout.lines().count(), 4000);
        assert_eq!(run.stderr.lines().count(), 4000);
    }

    #[cfg(unix)]
    #[test]
    fn a_run_past_its_deadline_is_killed_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let program = script(dir.path(), "sleepy.sh", "sleep 30");
        let started = Instant::now();
        let error = run(&program, &["now"], &[], Duration::from_millis(200)).unwrap_err();
        assert!(error.contains("timed out"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(10), "the deadline did not hold");
    }

    #[test]
    fn a_missing_program_names_itself() {
        let error = run(
            Path::new("/nonexistent/gavin-test/headroom"),
            &["--version"],
            &[],
            Duration::from_secs(5),
        )
        .unwrap_err();
        assert!(error.contains("/nonexistent/gavin-test/headroom"), "{error}");
    }

    #[test]
    fn combined_output_of_one_stream_has_no_stray_blank_line() {
        let run = Run { stdout: String::new(), stderr: "only this\n".into(), code: 1 };
        assert_eq!(run.combined(), "only this");
    }
}
