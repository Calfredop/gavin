//! Out-of-process coverage for the daemon running Headroom.
//!
//! What a RESTARTED daemon does cannot be tested from inside one: the
//! case is a daemon that died without stopping anything, and the only
//! honest way to produce it is to kill a real `gavin-daemon`. So these
//! spawn the binary under a temp `$HOME` -- its own socket, its own
//! databases, never the developer's -- install the fake Headroom
//! (`fixtures/fake_headroom.rs`) where uv would have put it, and drive
//! the daemon over its socket.

#![cfg(unix)]

#[path = "fixtures/fake.rs"]
mod fake;

#[path = "fixtures/daemon.rs"]
mod daemon;

use daemon::{alive, kill, serving, unavailable_here, wait_for, Daemon, Machine};
use protocol::{Request, Response};
use std::time::Duration;

fn machine_with_headroom() -> Machine {
    let machine = Machine::new();
    fake::install_into(&machine.uv_bin());
    machine
}

/// A machine with a daemon whose Headroom is up: the state every
/// restart test begins in.
fn running() -> (Machine, Daemon, u32, u16) {
    let machine = machine_with_headroom();
    let daemon = machine.daemon();
    daemon.headroom(Request::StartHeadroom);
    let port = daemon.until_ready().port.expect("a running Headroom has a port");
    let pid = machine.pid().expect("a running Headroom is recorded");
    (machine, daemon, pid, port)
}

#[test]
fn detection_finds_headroom_in_uvs_directory_with_a_dock_launch_path() {
    if unavailable_here() {
        return;
    }
    let machine = machine_with_headroom();
    let daemon = machine.daemon();

    let status = daemon.status();

    assert_eq!(status.state, "verified");
    assert_eq!(status.version.as_deref(), Some("0.39.1"));
    assert_eq!(status.pin, "0.39.1");
    assert_eq!(status.source.as_deref(), Some("uv-tool-dir"));
    assert_eq!(
        status.path,
        Some(machine.home.path().join(".local/bin").join(fake::NAME).display().to_string())
    );
    assert!(!status.running);
    assert_eq!(status.port, None, "a port is chosen when Headroom is first started");
}

#[test]
fn detection_honours_a_path_the_human_located() {
    if unavailable_here() {
        return;
    }
    let machine = Machine::new();
    let located = fake::install_into(&machine.home.path().join("venvs/headroom/bin"));
    let daemon = machine.daemon();
    assert_eq!(daemon.status().state, "absent");

    let status = daemon.headroom(Request::DetectHeadroom {
        located_path: Some(located.display().to_string()),
    });

    assert_eq!(status.state, "verified");
    assert_eq!(status.source.as_deref(), Some("located"));
    assert_eq!(status.path, Some(located.display().to_string()));
    // Remembered across daemons: it is a fact about the machine.
    daemon.crash();
    let next = machine.daemon();
    assert_eq!(next.status().path, Some(located.display().to_string()));
}

#[test]
fn a_start_carries_the_fixed_flags_and_none_of_the_daemons_own_headroom_variables() {
    if unavailable_here() {
        return;
    }
    let (machine, _daemon, pid, port) = running();

    let launches = fake::launches(&machine.workspace());

    assert_eq!(launches.len(), 1);
    assert_eq!(launches[0].pid, pid);
    assert_eq!(
        launches[0].args,
        ["proxy", "--host", "127.0.0.1", "--port", &port.to_string(), "--no-subscription-tracking"]
    );
    // The daemon was started with HEADROOM_MODE and HEADROOM_PORT set.
    assert_eq!(
        launches[0].env,
        [
            ("DO_NOT_TRACK".to_string(), "1".to_string()),
            ("HEADROOM_BEACON".to_string(), "off".to_string()),
            ("HEADROOM_UPDATE_CHECK".to_string(), "off".to_string()),
            ("HEADROOM_WORKSPACE_DIR".to_string(), machine.workspace().display().to_string()),
        ]
    );
    assert_ne!(port, 8787);
}

#[test]
fn a_killed_headroom_is_restarted_on_the_same_port() {
    if unavailable_here() {
        return;
    }
    let (machine, daemon, first, port) = running();

    kill(first);

    let second = wait_for("a second Headroom", || {
        machine.pid().filter(|pid| *pid != first && daemon.status().ready)
    });
    let status = daemon.status();
    assert!(alive(second));
    assert_eq!(status.port, Some(port));
    assert_eq!(status.restarts, 1);
    assert!(serving(port));
}

#[test]
fn a_restarted_daemon_re_adopts_the_headroom_it_recorded() {
    if unavailable_here() {
        return;
    }
    let (machine, daemon, pid, port) = running();

    daemon.crash();
    // The proxy outlives its daemon, which is the whole reason there is
    // anything to re-adopt: the agents it serves outlive it too.
    assert!(alive(pid));
    assert!(serving(port));
    let next = machine.daemon();

    let status = next.until_ready();
    assert!(status.running);
    assert!(status.wanted);
    assert_eq!(status.port, Some(port));
    assert_eq!(machine.pid(), Some(pid), "the same process, not a second one");
    assert_eq!(status.restarts, 0);
    assert_eq!(fake::launches(&machine.workspace()).len(), 1, "nothing was started");

    // Re-adopted means supervised: it is restarted when it dies, like
    // one this daemon had spawned itself.
    kill(pid);
    let second = wait_for("a restart of the adopted Headroom", || {
        machine.pid().filter(|found| *found != pid && next.status().ready)
    });
    assert!(alive(second));
    assert_eq!(next.status().port, Some(port));
}

#[test]
fn a_restarted_daemon_starts_a_fresh_headroom_when_the_recorded_one_is_gone() {
    if unavailable_here() {
        return;
    }
    let (machine, daemon, pid, port) = running();

    daemon.crash();
    kill(pid);
    wait_for("the old Headroom to be gone", || (!serving(port)).then_some(()));
    let next = machine.daemon();

    let status = next.until_ready();
    let fresh = machine.pid().unwrap();
    assert_ne!(fresh, pid);
    assert_eq!(status.port, Some(port), "the agents that survived are pointed at this port");
    assert_eq!(fake::launches(&machine.workspace()).len(), 2);
}

/// `/health` answers, as Headroom, at a version that is not the one
/// recorded. The process is this daemon's own -- its pid and start time
/// say so -- so it is stopped and replaced on the same port.
#[test]
fn a_restarted_daemon_replaces_a_headroom_that_answers_as_another_version() {
    if unavailable_here() {
        return;
    }
    let (machine, daemon, pid, port) = running();

    daemon.crash();
    machine.edit_record(|record| record["process"]["version"] = "0.38.0".into());
    let next = machine.daemon();

    let fresh = wait_for("a fresh Headroom", || {
        machine.pid().filter(|found| *found != pid && next.status().ready)
    });
    assert!(alive(fresh));
    assert!(!alive(pid), "the recorded one was this daemon's to stop");
    assert_eq!(next.status().port, Some(port));
    assert_eq!(fake::launches(&machine.workspace()).len(), 2);
}

/// The reuse guard. The recorded start time is not the running
/// process's, so that process is a stranger that inherited the pid. It
/// holds the port; the daemon moves, and the stranger is not touched.
#[test]
fn a_restarted_daemon_never_stops_a_headroom_it_did_not_start() {
    if unavailable_here() {
        return;
    }
    let (machine, daemon, stranger, port) = running();

    daemon.crash();
    machine.edit_record(|record| {
        let started = record["process"]["started_at_us"].as_i64().unwrap();
        record["process"]["started_at_us"] = (started - 1_000_000).into();
    });
    let next = machine.daemon();

    let own = wait_for("the daemon's own Headroom", || {
        machine.pid().filter(|found| *found != stranger && next.status().ready)
    });
    let status = next.status();
    assert!(alive(stranger), "a Headroom this daemon did not start was stopped");
    assert!(serving(port), "and it is still serving");
    assert!(alive(own));
    assert_ne!(status.port, Some(port), "the port is the stranger's now");
    assert!(serving(status.port.unwrap()));

    // Stopping stops the daemon's own, and only that.
    let stopped = next.headroom(Request::StopHeadroom);
    assert!(!stopped.running);
    assert!(!alive(own));
    assert!(alive(stranger));
}

#[test]
fn a_daemon_asked_to_shut_down_takes_its_headroom_with_it() {
    if unavailable_here() {
        return;
    }
    let (machine, mut daemon, pid, port) = running();

    assert!(matches!(daemon.ask(Request::Shutdown), Response::Ok));

    wait_for("the daemon to exit", || daemon.child.try_wait().unwrap());
    assert!(!alive(pid), "a proxy with no daemon and no agents was left running");
    // Still wanted: the human did not turn compression off, the daemon
    // was restarted. The next one starts it again, on the same port.
    assert_eq!(machine.record()["wanted"], true);
    let next = machine.daemon();
    let status = next.until_ready();
    assert_eq!(status.port, Some(port));
    assert_ne!(machine.pid(), Some(pid));
}

#[test]
fn a_stopped_headroom_stays_stopped_across_a_daemon_restart() {
    if unavailable_here() {
        return;
    }
    let (machine, daemon, pid, _port) = running();

    let stopped = daemon.headroom(Request::StopHeadroom);
    assert!(!stopped.running);
    assert!(!alive(pid));
    daemon.crash();
    let next = machine.daemon();

    // Long enough for a supervisor that was going to start one to have
    // done it: the fake is ready the moment it binds.
    std::thread::sleep(Duration::from_millis(1500));
    let status = next.status();
    assert!(!status.wanted);
    assert!(!status.running);
    assert_eq!(fake::launches(&machine.workspace()).len(), 1);
}
