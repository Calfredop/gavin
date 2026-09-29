//! Installing the pinned Headroom, and fetching its compression model.
//!
//! Two runs, in order: `uv tool install --python 3.13
//! "headroom-ai[all]==<pin>"`, then the model prefetch through the
//! installed tool's own Python. Headroom has no CLI command for the
//! prefetch, so it is `prefetch_kompress_artifacts()` called directly --
//! an internal API, pinned along with the version. Without it the first
//! compressed run stalls on a 274 MB download, and a cold model does not
//! fail `/readyz`, so nothing would say why.
//!
//! Like the Superpowers install (`app/src-tauri/src/superpowers.rs`):
//! argv arrays, a timeout, both pipes drained on threads (`run.rs`), and
//! one lock for the machine so a second click cannot start a second
//! install into the same tool directory.

use super::compress;
use super::detect::{self, Env};
use super::run::{self, Run};
use super::version::PIN;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The package, with every optional compressor. What the pin is a
/// version OF.
const PACKAGE: &str = "headroom-ai[all]";
/// The interpreter uv builds the tool's environment on. Named rather
/// than left to uv's default, which is whatever Python the machine has:
/// the pin was tested on this one.
const PYTHON: &str = "3.13";

/// The install downloads torch among eighty-odd packages; the prefetch
/// downloads the model. Long, but bounded.
pub const INSTALL_TIMEOUT: Duration = Duration::from_secs(30 * 60);
pub const PREFETCH_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// What the tool's Python is asked to run. The exit code carries the
/// function's own answer: it returns whether an artifact is now cached.
const PREFETCH: &str = "import sys\n\
from headroom.transforms.kompress_compressor import prefetch_kompress_artifacts\n\
sys.exit(0 if prefetch_kompress_artifacts() else 1)\n";

pub fn lock_path(state_dir: &Path) -> PathBuf {
    // Not per build: both daemons install into the same uv tool
    // directory, so both take the same lock.
    state_dir.join("headroom-install.lock")
}

/// `uv`'s arguments, as the array they are passed as.
pub fn install_args() -> Vec<String> {
    vec![
        "tool".to_string(),
        "install".to_string(),
        "--python".to_string(),
        PYTHON.to_string(),
        format!("{PACKAGE}=={PIN}"),
    ]
}

/// The tool's Python's arguments.
pub fn prefetch_args() -> Vec<String> {
    vec!["-c".to_string(), PREFETCH.to_string()]
}

/// The command a human without `uv` is shown, to run themselves.
pub fn command_line() -> String {
    format!("uv tool install --python {PYTHON} \"{PACKAGE}=={PIN}\"")
}

/// The Python that has Headroom installed in it: the interpreter beside
/// the real `headroom` script.
///
/// uv's bin directory holds a link into the tool's own environment
/// (`…/tools/headroom-ai/bin/headroom`), and every other kind of install
/// -- pip in a virtualenv, pipx, Homebrew -- has the same layout, because
/// a console script is always written next to the interpreter it runs
/// on. Any other Python on the machine does not have the package.
pub fn tool_python(headroom: &Path) -> Option<PathBuf> {
    let real = headroom.canonicalize().ok()?;
    let dir = real.parent()?;
    let names: &[&str] =
        if cfg!(windows) { &["python.exe"] } else { &["python", "python3"] };
    names.iter().map(|name| dir.join(name)).find(|python| python.is_file())
}

/// Headroom's opencode transport plugin, inside the package that
/// `headroom` was installed as, or `None` when it is not there.
///
/// Found from the same fact `tool_python` rests on: a console script is
/// written into its environment's `bin` (`Scripts` on Windows), and the
/// package is in that environment's `site-packages` -- a uv tool, a
/// virtualenv, pipx and a Homebrew prefix alike. The file is looked for
/// rather than asked of Headroom's Python, which would be a process per
/// launch for a path that only moves when Headroom is reinstalled.
pub fn opencode_plugin(headroom: &Path) -> Option<PathBuf> {
    let real = headroom.canonicalize().ok()?;
    let prefix = real.parent()?.parent()?;
    let site_packages: Vec<PathBuf> = if cfg!(windows) {
        vec![prefix.join("Lib").join("site-packages")]
    } else {
        // `lib/python3.13`, named for the interpreter the environment
        // was made with. Sorted, so a prefix holding two answers the
        // same way every time.
        let mut versions: Vec<PathBuf> = std::fs::read_dir(prefix.join("lib"))
            .ok()?
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("python"))
            .map(|entry| entry.path().join("site-packages"))
            .collect();
        versions.sort();
        versions
    };
    site_packages
        .into_iter()
        .map(|dir| compress::OPENCODE_PLUGIN.iter().fold(dir, |path, part| path.join(part)))
        .find(|plugin| plugin.is_file())
}

/// The machine's one install at a time, held for as long as this value
/// lives.
///
/// An OS file lock rather than a mutex, because there are two daemons on
/// a machine with a release install and a dev tree, and a mutex is one
/// per process. The OS drops it when the holder exits, however it
/// exits, so a daemon that crashes mid-install does not leave the
/// button dead.
#[derive(Debug)]
pub struct InstallLock {
    _file: File,
}

impl InstallLock {
    pub fn acquire(path: &Path) -> Result<InstallLock, String> {
        let file = File::options()
            .create(true)
            .truncate(false)
            .write(true)
            .open(path)
            .map_err(|e| format!("could not open {}: {e}", path.display()))?;
        match file.try_lock() {
            Ok(()) => Ok(InstallLock { _file: file }),
            Err(std::fs::TryLockError::WouldBlock) => {
                Err("Headroom is already being installed on this machine.".to_string())
            }
            Err(std::fs::TryLockError::Error(e)) => {
                Err(format!("could not lock {}: {e}", path.display()))
            }
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Timeouts {
    pub install: Duration,
    pub prefetch: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Timeouts { install: INSTALL_TIMEOUT, prefetch: PREFETCH_TIMEOUT }
    }
}

/// How an install ended, and everything it printed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    pub succeeded: bool,
    pub output: String,
}

fn section(title: &str, body: &str) -> String {
    if body.is_empty() {
        format!("$ {title}")
    } else {
        format!("$ {title}\n{body}")
    }
}

fn finished(step: &str, result: Result<Run, String>, log: &mut Vec<String>) -> bool {
    match result {
        Ok(run) => {
            log.push(section(step, &run.combined()));
            if !run.succeeded() {
                log.push(format!("{step} exited with status {}.", run.code));
            }
            run.succeeded()
        }
        Err(why) => {
            log.push(section(step, &why));
            false
        }
    }
}

/// Runs the install and the prefetch, under the machine's lock.
///
/// The prefetch failing does not undo the install: Headroom is there
/// and will download the model itself on first use. It is still a
/// failure, because the first compressed run will stall and the human
/// asked for exactly that not to happen.
pub fn install(uv: &Path, env: &Env, lock: &Path, timeouts: Timeouts) -> Outcome {
    let _held = match InstallLock::acquire(lock) {
        Ok(held) => held,
        Err(why) => return Outcome { succeeded: false, output: why },
    };
    let mut log = Vec::new();

    let args = install_args();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    if !finished(&command_line(), run::run(uv, &args, &[], timeouts.install), &mut log) {
        return Outcome { succeeded: false, output: log.join("\n") };
    }

    let installed = detect::uv_tool_bin_dir(env)
        .map(|dir| dir.join(if cfg!(windows) { "headroom.exe" } else { "headroom" }));
    let Some(python) = installed.as_deref().and_then(tool_python) else {
        log.push(
            "The install finished, but the tool's Python was not found, so the compression \
             model was not fetched."
                .to_string(),
        );
        return Outcome { succeeded: false, output: log.join("\n") };
    };
    let args = prefetch_args();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let fetched = finished(
        "fetch the compression model",
        run::run(&python, &args, &[], timeouts.prefetch),
        &mut log,
    );
    Outcome { succeeded: fetched, output: log.join("\n") }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_install_is_the_pinned_package_on_the_named_python() {
        assert_eq!(
            install_args(),
            ["tool", "install", "--python", "3.13", "headroom-ai[all]==0.39.1"]
        );
        assert_eq!(command_line(), "uv tool install --python 3.13 \"headroom-ai[all]==0.39.1\"");
    }

    #[test]
    fn the_prefetch_calls_the_pinned_function_and_reports_its_answer() {
        let args = prefetch_args();
        assert_eq!(args[0], "-c");
        assert!(args[1].contains(
            "from headroom.transforms.kompress_compressor import prefetch_kompress_artifacts"
        ));
        assert!(args[1].contains("sys.exit(0 if prefetch_kompress_artifacts() else 1)"));
        assert_eq!(args.len(), 2);
    }

    #[test]
    fn a_second_install_is_refused_while_the_first_holds_the_lock() {
        let dir = tempfile::tempdir().unwrap();
        let path = lock_path(dir.path());

        let first = InstallLock::acquire(&path).unwrap();
        let refused = InstallLock::acquire(&path).unwrap_err();
        assert!(refused.contains("already being installed"), "{refused}");

        drop(first);
        InstallLock::acquire(&path).expect("the lock is free once its holder is gone");
    }

    #[test]
    fn the_lock_is_one_for_the_machine_not_one_per_build() {
        let dir = Path::new("/state");
        assert_eq!(lock_path(dir), dir.join("headroom-install.lock"));
    }

    #[cfg(unix)]
    fn script(path: &Path, body: &str) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    /// A machine in a tempdir: a `uv` that "installs" by writing a
    /// `headroom` and a `python` into a tool environment and linking
    /// the first into `~/.local/bin`, the way the real one does.
    #[cfg(unix)]
    struct Machine {
        home: tempfile::TempDir,
    }

    #[cfg(unix)]
    impl Machine {
        fn new(uv_body: &str, python_body: &str) -> Machine {
            let home = tempfile::tempdir().unwrap();
            let staged = home.path().join("staged");
            let tool = home.path().join("tools").join("headroom-ai").join("bin");
            let bin = home.path().join(".local").join("bin");
            let log = home.path().join("calls.log");
            script(
                &staged.join("python"),
                &format!("echo \"python $1\" >> '{}'\n{python_body}", log.display()),
            );
            script(&staged.join("headroom"), "true");
            let uv = format!(
                "echo \"uv $*\" >> '{log}'\n\
                 {uv_body}\n\
                 mkdir -p '{tool}' '{bin}'\n\
                 cp '{staged}/python' '{staged}/headroom' '{tool}/'\n\
                 ln -sf '{tool}/headroom' '{bin}/headroom'",
                log = log.display(),
                staged = staged.display(),
                tool = tool.display(),
                bin = bin.display(),
            );
            script(&home.path().join("uv"), &uv);
            Machine { home }
        }

        fn uv(&self) -> PathBuf {
            self.home.path().join("uv")
        }

        fn env(&self) -> Env {
            Env { home: Some(self.home.path().to_path_buf()), ..Env::default() }
        }

        fn lock(&self) -> PathBuf {
            lock_path(self.home.path())
        }

        fn calls(&self) -> Vec<String> {
            std::fs::read_to_string(self.home.path().join("calls.log"))
                .unwrap_or_default()
                .lines()
                .map(String::from)
                .collect()
        }
    }

    #[cfg(unix)]
    #[test]
    fn an_install_runs_uv_and_then_the_prefetch_through_the_tools_python() {
        let machine = Machine::new("echo 'Installed 2 executables'", "echo fetched");

        let outcome = install(&machine.uv(), &machine.env(), &machine.lock(), Timeouts::default());

        assert!(outcome.succeeded, "{}", outcome.output);
        assert_eq!(
            machine.calls(),
            ["uv tool install --python 3.13 headroom-ai[all]==0.39.1", "python -c"]
        );
        assert!(outcome.output.contains("Installed 2 executables"), "{}", outcome.output);
        assert!(outcome.output.contains("fetched"), "{}", outcome.output);
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_install_does_not_go_on_to_the_prefetch() {
        let machine =
            Machine::new("echo 'No solution found' >&2; exit 2", "echo fetched");

        let outcome = install(&machine.uv(), &machine.env(), &machine.lock(), Timeouts::default());

        assert!(!outcome.succeeded);
        assert_eq!(machine.calls().len(), 1, "{:?}", machine.calls());
        assert!(outcome.output.contains("No solution found"), "{}", outcome.output);
        assert!(outcome.output.contains("status 2"), "{}", outcome.output);
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_prefetch_is_a_failed_install_and_says_which_step() {
        let machine = Machine::new("echo installed", "echo 'no network' >&2; exit 1");

        let outcome = install(&machine.uv(), &machine.env(), &machine.lock(), Timeouts::default());

        assert!(!outcome.succeeded);
        assert!(outcome.output.contains("no network"), "{}", outcome.output);
        assert!(
            outcome.output.contains("fetch the compression model exited with status 1"),
            "{}",
            outcome.output
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_install_that_hangs_is_killed_at_its_deadline() {
        let machine = Machine::new("sleep 30", "echo fetched");
        let started = std::time::Instant::now();

        let outcome = install(
            &machine.uv(),
            &machine.env(),
            &machine.lock(),
            Timeouts { install: Duration::from_millis(300), prefetch: Duration::from_secs(5) },
        );

        assert!(!outcome.succeeded);
        assert!(outcome.output.contains("timed out"), "{}", outcome.output);
        assert!(started.elapsed() < Duration::from_secs(10));
        // And the lock went with it: the button is not dead.
        InstallLock::acquire(&machine.lock()).expect("a timed-out install releases the lock");
    }

    #[cfg(unix)]
    #[test]
    fn an_install_refused_by_the_lock_runs_nothing() {
        let machine = Machine::new("echo installed", "echo fetched");
        let _held = InstallLock::acquire(&machine.lock()).unwrap();

        let outcome = install(&machine.uv(), &machine.env(), &machine.lock(), Timeouts::default());

        assert!(!outcome.succeeded);
        assert!(outcome.output.contains("already being installed"), "{}", outcome.output);
        assert!(machine.calls().is_empty(), "{:?}", machine.calls());
    }

    #[cfg(unix)]
    #[test]
    fn the_tools_python_is_the_one_beside_the_real_script_not_beside_the_link() {
        let machine = Machine::new("true", "true");
        install(&machine.uv(), &machine.env(), &machine.lock(), Timeouts::default());
        let link = machine.home.path().join(".local").join("bin").join("headroom");

        let python = tool_python(&link).unwrap();

        assert_eq!(
            python,
            machine
                .home
                .path()
                .canonicalize()
                .unwrap()
                .join("tools")
                .join("headroom-ai")
                .join("bin")
                .join("python")
        );
        assert_eq!(tool_python(Path::new("/nonexistent/headroom")), None);
    }

    /// Where the plugin sits in a uv tool environment, beside the
    /// interpreter the tool was built on.
    #[cfg(unix)]
    fn plugin_in(tool: &Path, python: &str) -> PathBuf {
        let plugin = compress::OPENCODE_PLUGIN
            .iter()
            .fold(tool.join("lib").join(python).join("site-packages"), |path, part| path.join(part));
        std::fs::create_dir_all(plugin.parent().unwrap()).unwrap();
        std::fs::write(&plugin, "export default async () => ({})\n").unwrap();
        plugin
    }

    #[cfg(unix)]
    #[test]
    fn the_opencode_plugin_is_found_in_the_package_the_link_leads_to() {
        let home = tempfile::tempdir().unwrap();
        let tool = home.path().join("tools").join("headroom-ai");
        script(&tool.join("bin").join("headroom"), "true");
        let bin = home.path().join(".local").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let link = bin.join("headroom");
        std::os::unix::fs::symlink(tool.join("bin").join("headroom"), &link).unwrap();

        assert_eq!(opencode_plugin(&link), None, "nothing is there yet");

        let plugin = plugin_in(&tool, "python3.13");
        assert_eq!(opencode_plugin(&link), Some(plugin.canonicalize().unwrap()));
        // Not beside the link: `~/.local/lib` holds nobody's package.
        assert!(!home.path().join(".local").join("lib").exists());
        assert_eq!(opencode_plugin(Path::new("/nonexistent/bin/headroom")), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_prefix_with_two_pythons_answers_the_same_way_every_time() {
        let home = tempfile::tempdir().unwrap();
        let tool = home.path().join("env");
        script(&tool.join("bin").join("headroom"), "true");
        let older = plugin_in(&tool, "python3.12");
        plugin_in(&tool, "python3.13");
        std::fs::create_dir_all(tool.join("lib").join("pkgconfig")).unwrap();

        let found = opencode_plugin(&tool.join("bin").join("headroom"));

        assert_eq!(found, Some(older.canonicalize().unwrap()));
    }
}
