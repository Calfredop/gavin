//! Headroom, run by the daemon (ADR 0007).
//!
//! Headroom compresses what an agent sends to its model. Gavin never
//! launches an agent through `headroom wrap`, which writes into the repo
//! and the human's home; each daemon runs its own Headroom as a
//! supervised child instead, and wires agents to it with environment
//! that lasts as long as the process. The daemon owns it, and not the
//! app, because the daemon owns the agent PTYs and they outlive the
//! window: a Headroom that died with the app would take every compressed
//! agent's model connection with it.
//!
//! This module is the daemon's half of that, and the wiring:
//!
//! - `detect` finds Headroom and `version` decides what state it is in
//! - `launch` is the fixed flags every start carries
//! - `supervisor` keeps it alive, and takes it back after a crash
//! - `install` installs the pinned version and fetches its model
//! - `store` is what is remembered between lifetimes
//! - `switch` is the daemon's copy of which workspaces want compression
//! - `compress` decides whether a session is compressed, and how
//!
//! Whether a workspace WANTS compression is the app's to say. It pushes
//! each workspace's effective setting (`set_workspaces`), and Headroom
//! runs while any of them is on.

pub mod compress;
pub mod detect;
pub mod http;
pub mod install;
pub mod launch;
pub mod run;
pub mod store;
pub mod supervisor;
pub mod switch;
pub mod version;

#[cfg(test)]
#[path = "../../tests/fixtures/fake.rs"]
pub mod fake;

use compress::{Decision, Facts, Launch};
use protocol::{BuildProfile, HeadroomInstall, HeadroomStatus, HeadroomWorkspace};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use store::InstallRecord;
use supervisor::Supervisor;
use switch::Switch;
use version::{State, Version};

/// What this lifetime found when it looked.
#[derive(Debug, Clone, Default)]
struct Detected {
    path: Option<PathBuf>,
    source: Option<String>,
    version: Option<Version>,
    note: Option<String>,
}

struct Inner {
    state_dir: PathBuf,
    /// The environment the daemon was started with. Read once: it does
    /// not change, and detection is asked for more than once.
    env: detect::Env,
    unavailable: Option<&'static str>,
    supervisor: Supervisor,
    /// `None` until this lifetime has looked. The stored record says
    /// where Headroom WAS; it is checked before it is reported.
    detected: Mutex<Option<Detected>>,
    /// Held for the whole of a search. A status, a Check again and the
    /// end of an install can all look at once; each reads the install
    /// record, runs `headroom --version` and writes the record back,
    /// and two of those interleaved is one overwriting the other's
    /// located path.
    looking: Mutex<()>,
    install: Mutex<Option<HeadroomInstall>>,
    timeouts: install::Timeouts,
    switch: Switch,
    /// Held from taking a list to the start or stop it asks for. Two
    /// windows can push at once, and a list that turned the last
    /// workspace off must not have its stop overtaken by the start of
    /// the list before it.
    switching: Mutex<()>,
}

/// One daemon's Headroom: what is installed, and the process it runs.
#[derive(Clone)]
pub struct Headroom {
    inner: Arc<Inner>,
}

impl Headroom {
    /// For the daemon: this machine, this build.
    pub fn open(state_dir: &Path) -> Headroom {
        Headroom::open_as(
            state_dir,
            BuildProfile::current(),
            detect::Env::current(),
            version::platform_unavailable(std::env::consts::OS, std::env::consts::ARCH),
        )
    }

    /// With everything that differs between daemons passed in, so two
    /// of them can stand side by side in one test.
    pub fn open_as(
        state_dir: &Path,
        profile: BuildProfile,
        env: detect::Env,
        unavailable: Option<&'static str>,
    ) -> Headroom {
        Headroom {
            inner: Arc::new(Inner {
                state_dir: state_dir.to_path_buf(),
                env,
                unavailable,
                supervisor: Supervisor::open(state_dir.to_path_buf(), profile, unavailable),
                detected: Mutex::new(None),
                looking: Mutex::new(()),
                install: Mutex::new(None),
                timeouts: install::Timeouts::default(),
                switch: Switch::open(state_dir, profile),
                switching: Mutex::new(()),
            }),
        }
    }

    /// Picks up the last lifetime's Headroom. Called once, by `serve`,
    /// and returns at once: the adoption or the start happens on the
    /// supervisor's own thread, so a slow proxy cannot hold up the
    /// socket.
    pub fn resume(&self) {
        self.inner.supervisor.resume();
    }

    /// The daemon is exiting on request.
    pub fn close(&self) {
        self.inner.supervisor.close();
    }

    pub fn status(&self) -> HeadroomStatus {
        let detected = self.detected();
        let state = version::state_for(self.inner.unavailable, detected.version);
        let run = self.inner.supervisor.snapshot();
        let reason = match state {
            State::Unavailable(reason) => Some(reason.to_string()),
            State::TooOld => Some(format!(
                "Headroom {} is older than {}, the oldest version gavin will start.",
                detected.version.map(|v| v.to_string()).unwrap_or_default(),
                version::FLOOR
            )),
            State::Absent => detected.note.clone(),
            State::Verified { .. } => None,
        };
        HeadroomStatus {
            state: state.id().to_string(),
            reason,
            newer_than_tested: matches!(state, State::Verified { newer_than_tested: true }),
            version: detected.version.map(|v| v.to_string()),
            floor: version::FLOOR.to_string(),
            pin: version::PIN.to_string(),
            path: detected.path.map(|p| p.to_string_lossy().into_owned()),
            source: detected.source,
            uv_found: self.inner.unavailable.is_none()
                && detect::find_uv(&self.inner.env).is_some(),
            wanted: run.wanted,
            running: run.running,
            ready: run.ready,
            port: run.port,
            restarts: run.restarts,
            last_error: run.last_error,
            lifetime_tokens_saved: run.lifetime_tokens_saved,
            install: self.lock_install().clone(),
        }
    }

    /// Looks again. `located` is the file the human picked: `Some` of a
    /// path remembers it, `Some` of nothing forgets it, and `None`
    /// checks again against whatever was located before.
    pub fn detect(&self, located: Option<String>) -> HeadroomStatus {
        if self.inner.unavailable.is_none() {
            self.look(located);
            self.inner.supervisor.nudge();
        }
        self.status()
    }

    pub fn start(&self) -> HeadroomStatus {
        if self.inner.unavailable.is_none() {
            // A first start on a daemon nobody has asked for a status:
            // look before launching, so the launch has a path to read.
            self.detected();
            self.inner.supervisor.start();
        }
        self.status()
    }

    pub fn stop(&self) -> HeadroomStatus {
        self.inner.supervisor.stop();
        self.status()
    }

    /// Takes each workspace's effective compression setting from the
    /// app, and runs Headroom while any of them is on.
    ///
    /// Started here rather than on the first compressed launch, because
    /// the compression model takes seconds to load: a Headroom started
    /// by the launch that needs it would leave that launch uncompressed
    /// every time.
    pub fn set_workspaces(&self, workspaces: &[HeadroomWorkspace]) -> HeadroomStatus {
        let _switching = self.inner.switching.lock().unwrap_or_else(PoisonError::into_inner);
        self.inner.switch.replace(workspaces);
        if self.inner.switch.any_on() {
            self.start()
        } else {
            self.stop()
        }
    }

    /// Whether a session about to be spawned in this workspace is
    /// compressed, as things stand right now.
    ///
    /// Asked at every spawn and remembered by nobody: a resume is a
    /// fresh session, and it is decided against the Headroom that is
    /// there when it launches.
    pub fn decide(&self, workspace_path: &str, launch: Launch, session_id: &str) -> Decision {
        // Read per spawn, like everything else a session inherits: it
        // is the daemon's environment the PTY is about to be handed.
        let inherited_headers = std::env::var(compress::CLAUDE_HEADERS).ok();
        compress::decide(Facts {
            workspace_on: self.inner.switch.is_on(workspace_path),
            ready_port: self.inner.supervisor.ready_port(),
            launch,
            session_id,
            inherited_headers: inherited_headers.as_deref(),
        })
    }

    /// Starts the install and returns. Its output and its outcome are
    /// read from the status.
    pub fn install(&self) -> HeadroomStatus {
        if let Some(reason) = self.inner.unavailable {
            self.set_install("failed", reason);
            return self.status();
        }
        let Some(uv) = detect::find_uv(&self.inner.env) else {
            self.set_install(
                "failed",
                &format!(
                    "uv was not found. Install uv, or install Headroom yourself and locate it:\n{}",
                    install::command_line()
                ),
            );
            return self.status();
        };
        {
            let mut current = self.lock_install();
            if current.as_ref().is_some_and(|i| i.state == "running") {
                drop(current);
                return self.status();
            }
            *current = Some(HeadroomInstall { state: "running".into(), output: String::new() });
        }
        let this = self.clone();
        let spawned = std::thread::Builder::new().name("headroom-install".to_string()).spawn(
            move || {
                let outcome = install::install(
                    &uv,
                    &this.inner.env,
                    &install::lock_path(&this.inner.state_dir),
                    this.inner.timeouts,
                );
                // Looked for whatever the outcome: a failed prefetch
                // still leaves a Headroom installed.
                this.look(None);
                this.set_install(
                    if outcome.succeeded { "succeeded" } else { "failed" },
                    &outcome.output,
                );
                this.inner.supervisor.nudge();
            },
        );
        if let Err(e) = spawned {
            self.set_install("failed", &format!("the install could not be started: {e}"));
        }
        self.status()
    }

    fn lock_install(&self) -> MutexGuard<'_, Option<HeadroomInstall>> {
        self.inner.install.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn set_install(&self, state: &str, output: &str) {
        *self.lock_install() =
            Some(HeadroomInstall { state: state.to_string(), output: output.to_string() });
    }

    fn install_path(&self) -> PathBuf {
        store::install_path(&self.inner.state_dir)
    }

    /// What this lifetime found, looking first if it has not yet.
    fn detected(&self) -> Detected {
        if self.inner.unavailable.is_some() {
            return Detected::default();
        }
        self.known().unwrap_or_else(|| {
            let _looking = self.inner.looking.lock().unwrap_or_else(PoisonError::into_inner);
            // Two first statuses at once: the second waited on the
            // first, and what it waited for is the answer.
            self.known().unwrap_or_else(|| self.search(None))
        })
    }

    fn known(&self) -> Option<Detected> {
        self.inner.detected.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    /// Runs the search, stores what it found, and remembers it.
    fn look(&self, located: Option<String>) -> Detected {
        let _looking = self.inner.looking.lock().unwrap_or_else(PoisonError::into_inner);
        self.search(located)
    }

    fn search(&self, located: Option<String>) -> Detected {
        let mut record: InstallRecord = store::load(&self.install_path());
        match located.as_deref().map(str::trim) {
            Some("") => record.located = None,
            Some(path) => record.located = Some(PathBuf::from(path)),
            None => {}
        }
        let detection =
            detect::detect(&self.inner.env, record.located.as_deref(), &detect::read_version);
        let detected = Detected {
            path: detection.found.as_ref().map(|f| f.path.clone()),
            source: detection.found.as_ref().map(|f| f.source.id().to_string()),
            version: detection.found.as_ref().map(|f| f.version),
            note: detection.note,
        };
        record.path = detected.path.clone();
        record.source = detected.source.clone();
        record.version = detected.version.map(|v| v.to_string());
        if let Err(e) = store::save(&self.install_path(), &record) {
            eprintln!("headroom: could not write {}: {e}", self.install_path().display());
        }
        *self.inner.detected.lock().unwrap_or_else(PoisonError::into_inner) =
            Some(detected.clone());
        detected
    }
}

/// The lifecycle, against the fake Headroom: a real process, really
/// spawned, killed and restarted. What a restarted DAEMON does is in
/// `tests/headroom.rs`, where there is a daemon to kill.
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// What a macOS app launched from the Dock is handed.
    const DOCK_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";

    /// A machine in a tempdir, with the fake Headroom where uv would
    /// have installed it.
    struct Machine {
        home: tempfile::TempDir,
    }

    impl Machine {
        fn bare() -> Machine {
            // Under /tmp for the reason `tests/shutdown.rs` gives: the
            // default temp directory on macOS is long, and these paths
            // end up in environment variables and log lines.
            Machine {
                home: tempfile::Builder::new().prefix("gavin-hr-").tempdir_in("/tmp").unwrap(),
            }
        }

        fn with_headroom() -> Machine {
            let machine = Machine::bare();
            fake::install_into(&machine.bin());
            machine
        }

        fn bin(&self) -> PathBuf {
            self.home.path().join(".local").join("bin")
        }

        fn state(&self) -> PathBuf {
            let dir = self.home.path().join("state");
            std::fs::create_dir_all(&dir).unwrap();
            dir
        }

        fn env(&self) -> detect::Env {
            detect::Env {
                home: Some(self.home.path().to_path_buf()),
                path: Some(DOCK_PATH.into()),
                ..detect::Env::default()
            }
        }

        fn daemon(&self, profile: BuildProfile) -> Daemon {
            Daemon {
                headroom: Headroom::open_as(&self.state(), profile, self.env(), None),
                state: self.state(),
                profile,
            }
        }
    }

    /// One daemon's Headroom, stopped when the test ends however it
    /// ends, so a failed assertion does not leave a process behind.
    struct Daemon {
        headroom: Headroom,
        state: PathBuf,
        profile: BuildProfile,
    }

    impl Drop for Daemon {
        fn drop(&mut self) {
            self.headroom.stop();
        }
    }

    impl Daemon {
        fn record(&self) -> store::RunRecord {
            store::load(&store::run_path(&self.state, self.profile))
        }

        fn pid(&self) -> Option<u32> {
            self.record().process.map(|p| p.pid)
        }

        fn workspace(&self) -> PathBuf {
            launch::workspace_dir(&self.state, self.profile)
        }

        fn until_ready(&self) -> HeadroomStatus {
            wait_for("Headroom to be ready", || {
                let status = self.headroom.status();
                status.ready.then_some(status)
            })
        }
    }

    fn wait_for<T>(what: &str, mut look: impl FnMut() -> Option<T>) -> T {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(found) = look() {
                return found;
            }
            assert!(Instant::now() < deadline, "gave up waiting for {what}");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn alive(pid: u32) -> bool {
        crate::proc::identify(pid).is_some()
    }

    fn kill(pid: u32) {
        // SAFETY: a plain signal to a pid the test itself started.
        unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    }

    fn script(path: &Path, body: &str) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn a_headroom_in_uvs_directory_is_verified_without_being_on_the_path() {
        let machine = Machine::with_headroom();
        let daemon = machine.daemon(BuildProfile::Dev);

        let status = daemon.headroom.status();

        assert_eq!(status.state, "verified");
        assert_eq!(status.version.as_deref(), Some("0.39.1"));
        assert_eq!(status.pin, "0.39.1");
        assert_eq!(status.floor, "0.38.0");
        assert_eq!(status.source.as_deref(), Some("uv-tool-dir"));
        assert_eq!(status.path, Some(machine.bin().join(fake::NAME).display().to_string()));
        assert!(!status.newer_than_tested);
        assert!(!status.running);
        assert!(!status.wanted);
        // And it was written down, which is what a start reads.
        let stored: InstallRecord = store::load(&store::install_path(&machine.state()));
        assert_eq!(stored.path, Some(machine.bin().join(fake::NAME)));
    }

    #[test]
    fn a_located_path_is_honoured_and_remembered() {
        let machine = Machine::bare();
        let located = fake::install_into(&machine.home.path().join("venv").join("bin"));
        let daemon = machine.daemon(BuildProfile::Dev);
        assert_eq!(daemon.headroom.status().state, "absent");

        let status = daemon.headroom.detect(Some(located.display().to_string()));

        assert_eq!(status.state, "verified");
        assert_eq!(status.source.as_deref(), Some("located"));
        assert_eq!(status.path, Some(located.display().to_string()));
        // "Check again" names no path, and still finds it.
        assert_eq!(daemon.headroom.detect(None).path, Some(located.display().to_string()));
        // Forgetting it is an empty path.
        assert_eq!(daemon.headroom.detect(Some(String::new())).state, "absent");
    }

    #[test]
    fn every_start_carries_exactly_the_fixed_flags() {
        let machine = Machine::with_headroom();
        let daemon = machine.daemon(BuildProfile::Dev);

        let started = daemon.headroom.start();
        assert!(started.wanted);
        let status = daemon.until_ready();

        let port = status.port.expect("a running Headroom has a port");
        assert_ne!(port, 8787, "the daemon's port is never Headroom's default");
        let launches = fake::launches(&daemon.workspace());
        assert_eq!(launches.len(), 1);
        assert_eq!(
            launches[0].args,
            ["proxy", "--host", "127.0.0.1", "--port", &port.to_string(), "--no-subscription-tracking"]
        );
        let own: Vec<(String, String)> = launches[0]
            .env
            .iter()
            .filter(|(key, _)| !key.starts_with("HEADROOM_WORKSPACE"))
            .cloned()
            .collect();
        assert_eq!(
            own,
            [
                ("DO_NOT_TRACK".to_string(), "1".to_string()),
                ("HEADROOM_BEACON".to_string(), "off".to_string()),
                ("HEADROOM_UPDATE_CHECK".to_string(), "off".to_string()),
            ]
        );
        assert!(launches[0].env.contains(&(
            "HEADROOM_WORKSPACE_DIR".to_string(),
            machine.state().join("headroom-dev").display().to_string()
        )));
        assert_eq!(launches[0].env.len(), 4, "{:?}", launches[0].env);
        assert_eq!(Some(launches[0].pid), daemon.pid());
    }

    #[test]
    fn a_killed_headroom_is_restarted_on_the_same_port() {
        let machine = Machine::with_headroom();
        let daemon = machine.daemon(BuildProfile::Dev);
        daemon.headroom.start();
        let before = daemon.until_ready();
        let first = daemon.pid().unwrap();

        kill(first);

        let second = wait_for("a second Headroom", || {
            daemon.pid().filter(|pid| *pid != first && daemon.headroom.status().ready)
        });
        let after = daemon.headroom.status();
        assert!(alive(second));
        assert!(!alive(first));
        assert_eq!(after.port, before.port, "every compressed agent is pointed at this port");
        assert_eq!(after.restarts, 1);
        assert!(after.running);
        // And the second start carried the same flags as the first.
        let launches = fake::launches(&daemon.workspace());
        assert_eq!(launches.len(), 2);
        assert_eq!(launches[0].args, launches[1].args);
        assert_eq!(launches[0].env, launches[1].env);
    }

    #[test]
    fn a_stopped_headroom_is_gone_and_keeps_its_port_for_the_next_start() {
        let machine = Machine::with_headroom();
        let daemon = machine.daemon(BuildProfile::Dev);
        daemon.headroom.start();
        let port = daemon.until_ready().port;
        let pid = daemon.pid().unwrap();

        let stopped = daemon.headroom.stop();

        assert!(!stopped.running);
        assert!(!stopped.ready);
        assert!(!stopped.wanted);
        assert!(!alive(pid), "stop returns once the process is gone");
        assert_eq!(daemon.record().process, None);
        assert_eq!(stopped.port, port);

        daemon.headroom.start();
        assert_eq!(daemon.until_ready().port, port);
        assert_eq!(daemon.headroom.status().restarts, 0, "a start is not a restart");
    }

    /// A release install and the dev tree run a daemon each, over ONE
    /// state directory. Two facades stand in for them, since a test can
    /// only build one profile of the daemon itself.
    #[test]
    fn a_release_and_a_dev_daemon_run_a_headroom_each_without_clashing() {
        let machine = Machine::with_headroom();
        let release = machine.daemon(BuildProfile::Release);
        let dev = machine.daemon(BuildProfile::Dev);

        release.headroom.start();
        dev.headroom.start();
        let release_status = release.until_ready();
        let dev_status = dev.until_ready();

        assert_ne!(release_status.port, dev_status.port);
        assert_ne!(release.pid(), dev.pid());
        assert_eq!(release.workspace(), machine.state().join("headroom"));
        assert_eq!(dev.workspace(), machine.state().join("headroom-dev"));
        // Each wrote its launch into its own state directory, and its
        // process into its own record.
        let release_launches = fake::launches(&release.workspace());
        let dev_launches = fake::launches(&dev.workspace());
        assert_eq!(release_launches.len(), 1);
        assert_eq!(dev_launches.len(), 1);
        assert_eq!(Some(release_launches[0].pid), release.pid());
        assert_eq!(Some(dev_launches[0].pid), dev.pid());
        assert!(machine.state().join("headroom-run.json").is_file());
        assert!(machine.state().join("headroom-run-dev.json").is_file());

        // Stopping one leaves the other serving.
        let dev_pid = dev.pid().unwrap();
        release.headroom.stop();
        assert!(alive(dev_pid));
        assert!(http::ready(dev_status.port.unwrap()));
        assert!(dev.headroom.status().ready);
    }

    #[test]
    fn a_headroom_below_the_floor_is_never_started() {
        let machine = Machine::bare();
        script(
            &machine.bin().join("headroom"),
            "[ \"$1\" = \"--version\" ] && echo 'headroom, version 0.37.4' && exit 0\n\
             sleep 30",
        );
        let daemon = machine.daemon(BuildProfile::Dev);
        assert_eq!(daemon.headroom.status().state, "too-old");

        daemon.headroom.start();

        let status = wait_for("the refusal", || {
            let status = daemon.headroom.status();
            status.last_error.is_some().then_some(status)
        });
        assert!(!status.running);
        let why = status.last_error.unwrap();
        assert!(why.contains("0.37.4") && why.contains("0.38.0"), "{why}");
        assert_eq!(daemon.pid(), None);
        assert!(status.reason.unwrap().contains("older than 0.38.0"));
    }

    #[test]
    fn a_start_with_no_headroom_installed_says_so_and_runs_nothing() {
        let machine = Machine::bare();
        let daemon = machine.daemon(BuildProfile::Dev);

        daemon.headroom.start();

        let status = wait_for("the refusal", || {
            let status = daemon.headroom.status();
            status.last_error.is_some().then_some(status)
        });
        assert_eq!(status.state, "absent");
        assert!(status.wanted, "wanted is the human's answer, not the machine's");
        assert!(!status.running);
        assert!(status.last_error.unwrap().contains("has not been found"));
    }

    /// Wanted while absent is a state the machine can leave: once
    /// Headroom is found, the waiting supervisor starts it.
    #[test]
    fn a_wanted_headroom_starts_once_it_is_found() {
        let machine = Machine::bare();
        let daemon = machine.daemon(BuildProfile::Dev);
        daemon.headroom.start();
        wait_for("the refusal", || daemon.headroom.status().last_error);

        fake::install_into(&machine.bin());
        daemon.headroom.detect(None);

        let status = daemon.until_ready();
        assert!(status.running);
        assert_eq!(status.last_error, None);
    }

    #[test]
    fn an_unavailable_platform_is_reported_and_nothing_is_run_on_it() {
        let machine = Machine::with_headroom();
        let reason = version::platform_unavailable("macos", "x86_64").unwrap();
        let headroom =
            Headroom::open_as(&machine.state(), BuildProfile::Dev, machine.env(), Some(reason));

        let status = headroom.start();

        assert_eq!(status.state, "unavailable");
        assert_eq!(status.reason.as_deref(), Some(reason));
        assert!(!status.wanted);
        assert!(!status.running);
        assert_eq!(status.path, None, "nothing is looked for on a platform it cannot run on");
        assert!(!status.uv_found);
        let installed = headroom.install();
        let install = installed.install.unwrap();
        assert_eq!(install.state, "failed");
        assert_eq!(install.output, reason);
        assert!(fake::launches(&machine.state().join("headroom-dev")).is_empty());
    }

    /// The reuse guard. The record names a living process by pid, and
    /// the start time beside it is not that process's: it is a
    /// stranger that inherited the number.
    #[test]
    fn a_process_this_daemon_did_not_start_is_never_stopped() {
        let machine = Machine::bare();
        let mut stranger = std::process::Command::new("sleep").arg("60").spawn().unwrap();
        let identity = crate::proc::identify(stranger.id()).unwrap();
        store::save(
            &store::run_path(&machine.state(), BuildProfile::Dev),
            &store::RunRecord {
                wanted: false,
                port: Some(51234),
                process: Some(store::ProcessRecord {
                    pid: identity.pid,
                    started_at_us: identity.started_at_us - 1_000_000,
                    version: "0.39.1".into(),
                    port: 51234,
                }),
                lifetime_tokens_saved: None,
            },
        )
        .unwrap();
        let daemon = machine.daemon(BuildProfile::Dev);

        daemon.headroom.resume();
        daemon.headroom.stop();

        assert!(
            matches!(stranger.try_wait(), Ok(None)),
            "a process with another start time was signalled"
        );
        assert_eq!(daemon.record().process, None, "the stale record is dropped");
        let _ = stranger.kill();
        let _ = stranger.wait();
    }

    /// The other side of the same rule: a recorded process that IS the
    /// one recorded, and that nobody wants any more, is this daemon's
    /// to stop.
    #[test]
    fn a_recorded_headroom_nobody_wants_any_more_is_stopped() {
        let machine = Machine::bare();
        let mut ours = std::process::Command::new("sleep").arg("60").spawn().unwrap();
        let identity = crate::proc::identify(ours.id()).unwrap();
        store::save(
            &store::run_path(&machine.state(), BuildProfile::Dev),
            &store::RunRecord {
                wanted: false,
                port: Some(51234),
                process: Some(store::ProcessRecord {
                    pid: identity.pid,
                    started_at_us: identity.started_at_us,
                    version: "0.39.1".into(),
                    port: 51234,
                }),
                lifetime_tokens_saved: None,
            },
        )
        .unwrap();
        let daemon = machine.daemon(BuildProfile::Dev);

        daemon.headroom.resume();

        wait_for("the recorded process to be stopped", || {
            matches!(ours.try_wait(), Ok(Some(_))).then_some(())
        });
        wait_for("the record to be cleared", || daemon.record().process.is_none().then_some(()));
    }

    #[test]
    fn the_install_button_installs_headroom_and_it_is_found_afterwards() {
        let machine = Machine::bare();
        let tools = machine.home.path().join("tools");
        let calls = machine.home.path().join("uv-calls.log");
        // A `uv` that installs the fake Headroom where the real one
        // would, with a Python beside it for the prefetch.
        script(&tools.join("python"), "echo 'model cached'");
        script(
            &tools.join("uv"),
            &format!(
                "echo \"$*\" >> '{calls}'\n\
                 mkdir -p '{bin}'\n\
                 cp '{fake}' '{bin}/headroom'\n\
                 cp '{tools}/python' '{bin}/python'\n\
                 echo 'Installed 2 executables: headroom, headroom-cache-ttl'",
                calls = calls.display(),
                bin = machine.bin().display(),
                fake = fake::binary().display(),
                tools = tools.display(),
            ),
        );
        let env = detect::Env { well_known_bin_dirs: vec![tools.clone()], ..machine.env() };
        let headroom = Headroom::open_as(&machine.state(), BuildProfile::Dev, env, None);
        let before = headroom.status();
        assert_eq!(before.state, "absent");
        assert!(before.uv_found);

        let pressed = headroom.install();
        assert_eq!(pressed.install.unwrap().state, "running");
        // A second click while it runs starts nothing.
        headroom.install();

        let done = wait_for("the install to finish", || {
            let status = headroom.status();
            (status.install.as_ref()?.state != "running").then_some(status)
        });
        let install = done.install.unwrap();
        assert_eq!(install.state, "succeeded", "{}", install.output);
        assert!(install.output.contains("Installed 2 executables"), "{}", install.output);
        assert!(install.output.contains("model cached"), "{}", install.output);
        assert_eq!(done.state, "verified");
        assert_eq!(done.version.as_deref(), Some("0.39.1"));
        assert_eq!(
            std::fs::read_to_string(&calls).unwrap(),
            "tool install --python 3.13 headroom-ai[all]==0.39.1\n"
        );
    }

    #[test]
    fn without_uv_the_install_says_what_to_run_instead() {
        let machine = Machine::bare();
        let daemon = machine.daemon(BuildProfile::Dev);
        assert!(!daemon.headroom.status().uv_found);

        let install = daemon.headroom.install().install.unwrap();

        assert_eq!(install.state, "failed");
        assert!(
            install.output.contains("uv tool install --python 3.13 \"headroom-ai[all]==0.39.1\""),
            "{}",
            install.output
        );
    }

    #[test]
    fn the_lifetime_total_comes_from_headroom_and_outlives_it() {
        let machine = Machine::with_headroom();
        let daemon = machine.daemon(BuildProfile::Dev);
        daemon.headroom.start();

        let status = daemon.until_ready();
        // The fake reports 0 unless told otherwise; what matters is
        // that a number was read, where none was known before.
        let total = wait_for("a lifetime total", || daemon.headroom.status().lifetime_tokens_saved);
        assert_eq!(total, 0);
        assert!(status.running);

        let stopped = daemon.headroom.stop();
        assert_eq!(stopped.lifetime_tokens_saved, Some(0));
        assert_eq!(daemon.record().lifetime_tokens_saved, Some(0));
    }
}
