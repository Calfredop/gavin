//! Finding `npx` for the two things gavin runs through it itself: the
//! skills CLI and Playwright's browser install.
//!
//! A Dock- or Finder-launched app inherits launchd's PATH,
//! `/usr/bin:/bin:/usr/sbin:/sbin`, and `program::resolve` adds only the
//! well-known install directories (`protocol::bin_dirs`). That is enough
//! for a Homebrew Node and not for a version manager: mise, nvm, fnm,
//! asdf and nodenv put Node on PATH from a hook in the shell's rc file,
//! which an app opened from the Dock never runs. So "npx works in my
//! terminal and gavin says it is not on PATH" was the setup wizard's
//! answer on exactly the machines whose owners care most about which Node
//! they run.
//!
//! The search, in order, stops at the first hit:
//!
//! 1. the path the human gave gavin (`npx-path` in the app support
//!    folder) -- their word, asked for only after everything below failed;
//! 2. PATH plus the well-known install directories (`program::resolve`);
//! 3. where Node's version managers keep their installs and shims
//!    (`common_places`);
//! 4. the human's own login shell, asked `command -v npx` -- or, on
//!    Windows, `where npx`.
//!
//! What is found is run with its own directory put FIRST on the child's
//! PATH: `npx` is a `#!/usr/bin/env node` script, so the `node` that runs
//! it is whichever comes first there, and the one beside this `npx` is
//! the one it was installed with.

use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The start of every "there is no npx" message, so the frontend can tell
/// that failure from every other and offer the manual path
/// (`npxLocate.ts` holds the same string).
pub const NOT_FOUND: &str = "npx was not found";

/// The whole message, naming what was searched: "not on PATH" alone is
/// what sent people to their terminal, where it plainly was.
pub fn not_found_message() -> String {
    format!(
        "{NOT_FOUND} — gavin looked on PATH, in the usual Node.js install places (Homebrew, \
         mise, nvm, fnm, Volta, asdf, nodenv, n) and asked your login shell. Install Node.js, \
         or tell gavin where npx is."
    )
}

/// How long the login shell gets to answer. An rc file that loads a
/// version manager, a prompt theme and completions takes a second or two;
/// one that waits on something takes for ever, and this is its ceiling.
const SHELL_TIMEOUT: Duration = Duration::from_secs(10);

/// How long a "the shell does not know either" stands before the shell is
/// asked again. The Playwright step re-checks on every render of its
/// step; without this each one would spend a shell start finding nothing.
/// Short, because the usual next step after reading the failure is to
/// install Node and click again.
const SHELL_MISS_TTL: Duration = Duration::from_secs(30);

/// An `npx` gavin can start, and the PATH to start it under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Located {
    pub program: PathBuf,
    pub path_env: OsString,
}

/// Where the human's answer is kept: one line, the path. A file of its
/// own in the app support folder rather than a field of `config.json`,
/// because the release app and the dev build share that file and an
/// older build that does not know the field would drop it on its next
/// save. One machine, one Node: both builds want the same answer.
fn manual_file() -> Option<PathBuf> {
    protocol::app_support_dir().ok().map(|dir| dir.join("npx-path"))
}

/// The path the human gave, if any, whether or not it still exists.
pub fn manual() -> Option<PathBuf> {
    let body = std::fs::read_to_string(manual_file()?).ok()?;
    let line = body.lines().next()?.trim();
    (!line.is_empty()).then(|| PathBuf::from(line))
}

/// Records the human's answer, or forgets it with `None`. Checked before
/// it is kept: the path must be absolute, a file, and answer
/// `npx --version` -- a path that is not `npx` would otherwise turn the
/// next Install into a mystery.
pub fn set_manual(path: Option<&str>) -> Result<(), String> {
    let file = manual_file().ok_or("this account has no app support folder to keep the path in")?;
    let Some(raw) = path.map(str::trim).filter(|p| !p.is_empty()) else {
        return match std::fs::remove_file(&file) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("could not forget the npx path: {e}")),
        };
    };
    let program = expand_home(raw, crate::home::home_dir().as_deref());
    if !program.is_absolute() {
        return Err(format!("{raw} is not an absolute path — paste what `command -v npx` printed"));
    }
    if !program.is_file() {
        return Err(format!("there is no file at {}", program.display()));
    }
    let located = with_path(startable(program, cfg!(windows), |c| c.is_file()));
    run_version(&located)?;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    }
    std::fs::write(&file, format!("{}\n", located.program.display()))
        .map_err(|e| format!("could not save the npx path: {e}"))
}

/// `~/x` as the human typed it, against `home`. Nothing else is expanded:
/// no variables, no globs.
fn expand_home(raw: &str, home: Option<&Path>) -> PathBuf {
    match (raw.strip_prefix("~/"), home) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(raw),
    }
}

/// `npx --version` under the PATH it would run with, to completion or 20 s.
fn run_version(located: &Located) -> Result<String, String> {
    let mut child = crate::program::command(&located.program)
        .arg("--version")
        .env("PATH", &located.path_env)
        .current_dir(crate::home::neutral_cwd())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", located.program.display()))?;
    let (code, stdout, stderr) = wait_with_output(&mut child, Duration::from_secs(20))
        .ok_or_else(|| format!("{} --version did not answer in 20s", located.program.display()))?;
    if code == Some(0) {
        Ok(stdout.trim().to_string())
    } else {
        let why = if stderr.trim().is_empty() { stdout } else { stderr };
        Err(format!("{} --version failed: {}", located.program.display(), why.trim()))
    }
}

/// The child's exit code and both streams, or `None` when it ran past
/// `timeout` and was killed.
fn wait_with_output(child: &mut std::process::Child, timeout: Duration) -> Option<(Option<i32>, String, String)> {
    let readers: Vec<_> = [
        child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>),
        child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .map(|stream| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut stream) = stream {
                let _ = stream.read_to_end(&mut buf);
            }
            String::from_utf8_lossy(&buf).into_owned()
        })
    })
    .collect();
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    // A killed shell can leave a grandchild holding the pipe open; its
    // output is not worth waiting on.
    let mut outputs = readers.into_iter().map(|r| if status.is_some() { r.join().unwrap_or_default() } else { String::new() });
    let stdout = outputs.next().unwrap_or_default();
    let stderr = outputs.next().unwrap_or_default();
    status.map(|s| (s.code(), stdout, stderr))
}

/// The file name `npx` has on this platform's disk.
fn file_name(windows: bool) -> &'static str {
    if windows {
        "npx.cmd"
    } else {
        "npx"
    }
}

/// A Node version folder's name as numbers, for picking the newest:
/// `v22.11.0`, `22.11.0`, `node@22` and mise's `22` all read. `None` for
/// an alias like mise's `latest` or nvm's `system`.
fn version_key(name: &str) -> Option<Vec<u64>> {
    let digits = name.trim_start_matches("node@").trim_start_matches('v');
    let parts: Vec<u64> = digits.split('.').map(|p| p.parse().ok()).collect::<Option<_>>()?;
    (!parts.is_empty()).then_some(parts)
}

/// Every version folder `list` names under a directory, newest first;
/// anything that is not a version number is left out.
fn newest_first(names: Vec<String>, prefix: &str) -> Vec<String> {
    let mut versions: Vec<(Vec<u64>, String)> = names
        .into_iter()
        .filter(|n| n.starts_with(prefix))
        .filter_map(|n| version_key(&n[prefix.len()..]).map(|k| (k, n)))
        .collect();
    versions.sort_by(|a, b| b.0.cmp(&a.0));
    versions.into_iter().map(|(_, n)| n).collect()
}

/// Where Node's version managers and installers put `npx`, most likely
/// first, whether or not each exists. `list` names a directory's entries,
/// so the versioned layouts can be walked without touching the disk in
/// tests. `data_home` is `$XDG_DATA_HOME` where it is set: mise and fnm
/// keep their installs under it on Linux, and `~/.local/share` is only
/// its default.
///
/// A manager's own install of a concrete version comes before its shim:
/// the shim decides the version from config at run time, and an app
/// started from the Dock in the home directory may have none to give it
/// (mise: "No version is set for shim"). The newest installed version is
/// the honest guess, and the human's own path overrides it.
pub fn common_places(
    home: Option<&Path>,
    data_home: Option<&Path>,
    windows: bool,
    list: impl Fn(&Path) -> Vec<String>,
) -> Vec<PathBuf> {
    let npx = file_name(windows);
    let mut out = Vec::new();
    let versions = |dir: PathBuf, prefix: &str, tail: &[&str], out: &mut Vec<PathBuf>| {
        for name in newest_first(list(&dir), prefix) {
            let mut path = dir.join(name);
            for part in tail {
                path = path.join(part);
            }
            out.push(path.join(npx));
        }
    };
    if windows {
        // Every Windows Node keeps `npx.cmd` beside `node.exe`, with no
        // `bin` folder. Volta's and mise's shims are `.exe` in their
        // current releases and were `.cmd` before, so both are looked for.
        if let Some(home) = home {
            let roaming = home.join("AppData").join("Roaming");
            let local = home.join("AppData").join("Local");
            out.push(roaming.join("npm").join(npx));
            // nvm-windows: one folder per version, `v22.11.0`.
            versions(roaming.join("nvm"), "v", &[], &mut out);
            versions(roaming.join("fnm").join("node-versions"), "v", &["installation"], &mut out);
            versions(local.join("mise").join("installs").join("node"), "", &[], &mut out);
            for shims in [local.join("mise").join("shims"), local.join("Volta").join("bin")] {
                out.push(shims.join("npx.exe"));
                out.push(shims.join(npx));
            }
            for app in ["nodejs", "nodejs-lts"] {
                out.push(home.join("scoop").join("apps").join(app).join("current").join(npx));
            }
        }
        out.push(PathBuf::from(r"C:\Program Files\nodejs").join(npx));
        out.push(PathBuf::from(r"C:\Program Files (x86)\nodejs").join(npx));
        return out;
    }
    let mut data_homes: Vec<PathBuf> = data_home.map(Path::to_path_buf).into_iter().collect();
    if let Some(home) = home {
        let default = home.join(".local/share");
        if !data_homes.contains(&default) {
            data_homes.push(default);
        }
    }
    for data in &data_homes {
        let mise = data.join("mise");
        versions(mise.join("installs/node"), "", &["bin"], &mut out);
        out.push(mise.join("shims").join(npx));
    }
    if let Some(home) = home {
        versions(home.join(".nvm/versions/node"), "v", &["bin"], &mut out);
    }
    let fnm_dirs = data_homes
        .iter()
        .map(|d| d.join("fnm/node-versions"))
        .chain(home.map(|h| h.join("Library/Application Support/fnm/node-versions")))
        .chain(home.map(|h| h.join(".fnm/node-versions")));
    for fnm in fnm_dirs.collect::<Vec<_>>() {
        versions(fnm, "v", &["installation", "bin"], &mut out);
    }
    if let Some(home) = home {
        out.push(home.join(".volta/bin").join(npx));
        versions(home.join(".asdf/installs/nodejs"), "", &["bin"], &mut out);
        out.push(home.join(".asdf/shims").join(npx));
        versions(home.join(".nodenv/versions"), "", &["bin"], &mut out);
        out.push(home.join(".nodenv/shims").join(npx));
        out.push(home.join("n/bin").join(npx));
        out.push(home.join(".n/bin").join(npx));
        out.push(home.join(".linuxbrew/bin").join(npx));
    }
    // Homebrew on Apple Silicon, on Intel and on Linux, each with its
    // versioned `node@22` kegs that are not linked into `bin`.
    for prefix in ["/opt/homebrew", "/usr/local", "/home/linuxbrew/.linuxbrew"] {
        let opt = PathBuf::from(prefix).join("opt");
        out.push(opt.join("node/bin").join(npx));
        versions(opt.clone(), "node@", &["bin"], &mut out);
        out.push(PathBuf::from(prefix).join("bin").join(npx));
    }
    // The Node snap's command alias, and a distribution's own package.
    out.push(PathBuf::from("/snap/bin").join(npx));
    out.push(PathBuf::from("/usr/bin").join(npx));
    out
}

/// On Windows, the `.cmd` beside an extensionless `npx`. npm writes both
/// into the same folder, and `where npx` lists the extensionless one --
/// a `#!/bin/sh` script for Git Bash that CreateProcess refuses -- first.
/// Anything else is returned as it came.
fn startable(path: PathBuf, windows: bool, exists: impl Fn(&Path) -> bool) -> PathBuf {
    if !windows || path.extension().is_some() {
        return path;
    }
    let cmd = path.with_extension("cmd");
    if exists(&cmd) {
        cmd
    } else {
        path
    }
}

/// The first absolute path in a shell's output that names an existing
/// file. Taken from the END: an rc file may print a banner first, and
/// `command -v` answers last.
fn path_from_output(output: &str, exists: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    output
        .lines()
        .rev()
        .map(str::trim)
        .filter(|l| Path::new(l).is_absolute())
        .map(PathBuf::from)
        .find(|p| exists(p))
}

/// `where npx` prints every match, the extensionless shell script npm
/// also writes among them; the `.cmd` is the one CreateProcess can start.
fn pick_where(output: &str, exists: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    let hits: Vec<PathBuf> = output.lines().map(str::trim).filter(|l| !l.is_empty()).map(PathBuf::from).filter(|p| exists(p)).collect();
    hits.iter()
        .find(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd")))
        .or(hits.first())
        .cloned()
}

/// The shell to ask: the human's own (`$SHELL`, which launchd hands
/// every app), else the platform's default login shell.
fn login_shell() -> PathBuf {
    std::env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|s| s.is_absolute() && s.is_file())
        .unwrap_or_else(|| PathBuf::from(if cfg!(target_os = "macos") { "/bin/zsh" } else { "/bin/sh" }))
}

/// Asks the human's shell where `npx` is. Interactive AND login, because
/// a version manager is set up in `.zshrc`/`.bashrc`, which only an
/// interactive shell reads, and Homebrew's `shellenv` often only in
/// `.zprofile`, which only a login shell does.
fn ask_shell() -> Option<PathBuf> {
    let mut command = if cfg!(windows) {
        let mut c = crate::program::command("where");
        c.arg("npx");
        c
    } else {
        let mut c = crate::program::command(login_shell());
        c.args(["-l", "-i", "-c", "command -v npx"]);
        c
    };
    let mut child = command
        .current_dir(crate::home::neutral_cwd())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let (_, stdout, _) = wait_with_output(&mut child, SHELL_TIMEOUT)?;
    if cfg!(windows) {
        pick_where(&stdout, |p| p.is_file())
    } else {
        path_from_output(&stdout, |p| p.is_file())
    }
}

/// The shell's last answer: a hit is kept for the life of the app (and
/// re-checked on disk before use), a miss for `SHELL_MISS_TTL`.
static SHELL_ANSWER: Mutex<Option<(Instant, Option<PathBuf>)>> = Mutex::new(None);

fn shell_npx() -> Option<PathBuf> {
    {
        let cached = SHELL_ANSWER.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        match &*cached {
            Some((_, Some(hit))) if hit.is_file() => return Some(hit.clone()),
            Some((at, None)) if at.elapsed() < SHELL_MISS_TTL => return None,
            _ => {}
        }
    }
    // Not under the lock: the ask can take seconds, and two callers
    // asking at once costs a shell start, not a wrong answer.
    let answer = ask_shell();
    *SHELL_ANSWER.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some((Instant::now(), answer.clone()));
    answer
}

/// `program` with the PATH to run it under: its own directory first, then
/// this process's PATH with the well-known install directories.
fn with_path(program: PathBuf) -> Located {
    let home = crate::home::home_dir();
    let dirs = protocol::bin_dirs::well_known_bin_dirs(home.as_deref(), cfg!(windows));
    let current = std::env::var_os("PATH");
    let base = protocol::bin_dirs::path_with_bin_dirs(current.as_deref(), &dirs, cfg!(windows), |p| p.is_dir())
        .or(current)
        .unwrap_or_default();
    let path_env = path_with_first(program.parent(), &base);
    Located { program, path_env }
}

/// `base` with `dir` put in front of it.
fn path_with_first(dir: Option<&Path>, base: &std::ffi::OsStr) -> OsString {
    let Some(dir) = dir.filter(|d| !d.as_os_str().is_empty()) else {
        return base.to_os_string();
    };
    let mut out = dir.as_os_str().to_os_string();
    if !base.is_empty() {
        out.push(if cfg!(windows) { ";" } else { ":" });
        out.push(base);
    }
    out
}

/// The `npx` gavin should run, or `None` when nothing anywhere has one.
/// Can take seconds on a miss (the login shell); call it off the main
/// thread.
pub fn locate() -> Option<Located> {
    let home = crate::home::home_dir();
    let data_home = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).filter(|p| p.is_absolute());
    manual()
        .filter(|p| p.is_file())
        .or_else(|| crate::program::resolve("npx"))
        .or_else(|| {
            common_places(home.as_deref(), data_home.as_deref(), cfg!(windows), list_dir)
                .into_iter()
                .find(|p| p.is_file())
        })
        .or_else(shell_npx)
        .map(|p| with_path(startable(p, cfg!(windows), |c| c.is_file())))
}

fn list_dir(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .map(|entries| entries.filter_map(Result::ok).filter_map(|e| e.file_name().into_string().ok()).collect())
        .unwrap_or_default()
}

/// What the wizard shows about `npx`: where gavin found it, and the path
/// the human gave, if they gave one.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NpxReport {
    pub found: Option<String>,
    pub manual: Option<String>,
}

fn report() -> NpxReport {
    NpxReport {
        found: locate().map(|l| l.program.to_string_lossy().into_owned()),
        manual: manual().map(|p| p.to_string_lossy().into_owned()),
    }
}

/// Off the main thread: a miss asks the login shell, which takes seconds.
#[tauri::command]
pub async fn npx_location() -> Result<NpxReport, String> {
    tauri::async_runtime::spawn_blocking(report)
        .await
        .map_err(|e| format!("the npx lookup did not run: {e}"))
}

/// The human's answer to "where is npx", checked by running it, or `None`
/// to forget it. Off the main thread for the same reason, and because the
/// check starts Node.
#[tauri::command]
pub async fn set_npx_path(path: Option<String>) -> Result<NpxReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        set_manual(path.as_deref())?;
        Ok(report())
    })
    .await
    .map_err(|e| format!("the npx path was not saved: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn listing(entries: &[(&str, &[&str])]) -> impl Fn(&Path) -> Vec<String> {
        let map: HashMap<PathBuf, Vec<String>> = entries
            .iter()
            .map(|(dir, names)| (PathBuf::from(dir), names.iter().map(|n| n.to_string()).collect()))
            .collect();
        move |p| map.get(p).cloned().unwrap_or_default()
    }

    /// The reported machine: Node from mise, nothing on the Dock's PATH.
    /// The newest install comes first, ahead of the shim, and `latest`
    /// (mise's alias) is not mistaken for a version.
    #[test]
    fn mise_installs_are_searched_newest_first_before_the_shim() {
        let home = Path::new("/Users/ada");
        let places = common_places(
            Some(home),
            None,
            false,
            listing(&[("/Users/ada/.local/share/mise/installs/node", &["20.11.1", "22.3.0", "latest", "22"])]),
        );
        let mise: Vec<_> = places.iter().filter(|p| p.starts_with("/Users/ada/.local/share/mise")).collect();
        assert_eq!(
            mise,
            vec![
                Path::new("/Users/ada/.local/share/mise/installs/node/22.3.0/bin/npx"),
                Path::new("/Users/ada/.local/share/mise/installs/node/22/bin/npx"),
                Path::new("/Users/ada/.local/share/mise/installs/node/20.11.1/bin/npx"),
                Path::new("/Users/ada/.local/share/mise/shims/npx"),
            ]
        );
    }

    #[test]
    fn every_version_manager_is_covered() {
        let places = common_places(
            Some(Path::new("/h")),
            None,
            false,
            listing(&[
                ("/h/.nvm/versions/node", &["v18.20.0", "v20.1.0"]),
                ("/h/Library/Application Support/fnm/node-versions", &["v22.0.0"]),
                ("/h/.asdf/installs/nodejs", &["21.0.0"]),
                ("/opt/homebrew/opt", &["node@20", "git", "node@22"]),
            ]),
        );
        for expected in [
            "/h/.nvm/versions/node/v20.1.0/bin/npx",
            "/h/Library/Application Support/fnm/node-versions/v22.0.0/installation/bin/npx",
            "/h/.volta/bin/npx",
            "/h/.asdf/installs/nodejs/21.0.0/bin/npx",
            "/h/.asdf/shims/npx",
            "/h/.nodenv/shims/npx",
            "/h/n/bin/npx",
            "/opt/homebrew/opt/node@22/bin/npx",
            "/opt/homebrew/bin/npx",
            "/usr/local/bin/npx",
        ] {
            assert!(places.contains(&PathBuf::from(expected)), "{expected} missing from {places:#?}");
        }
        let nvm20 = places.iter().position(|p| p.ends_with("v20.1.0/bin/npx")).unwrap();
        let nvm18 = places.iter().position(|p| p.ends_with("v18.20.0/bin/npx")).unwrap();
        assert!(nvm20 < nvm18, "newest nvm version first");
        assert!(!places.iter().any(|p| p.to_string_lossy().contains("/git/")), "only node@ folders under opt");
    }

    #[test]
    fn windows_looks_where_windows_installers_put_npx() {
        let home = Path::new(r"C:\Users\Ada");
        let places = common_places(
            Some(home),
            None,
            true,
            listing(&[(r"C:\Users\Ada/AppData/Roaming/nvm", &["v20.1.0", "v22.3.0", "settings.txt"])]),
        );
        let roaming = home.join("AppData").join("Roaming");
        let local = home.join("AppData").join("Local");
        for expected in [
            roaming.join("npm").join("npx.cmd"),
            roaming.join("nvm").join("v22.3.0").join("npx.cmd"),
            local.join("Volta").join("bin").join("npx.exe"),
            local.join("mise").join("shims").join("npx.cmd"),
            home.join("scoop").join("apps").join("nodejs-lts").join("current").join("npx.cmd"),
            PathBuf::from(r"C:\Program Files\nodejs").join("npx.cmd"),
        ] {
            assert!(places.contains(&expected), "{} missing from {places:#?}", expected.display());
        }
        assert!(
            places.iter().all(|p| p.extension().is_some()),
            "never an extensionless npx, which CreateProcess cannot start: {places:#?}"
        );
        assert!(
            !places.iter().any(|p| p.starts_with("/") || p.to_string_lossy().contains(".nvm")),
            "no unix layout on Windows: {places:#?}"
        );
    }

    /// Linux keeps mise and fnm under `$XDG_DATA_HOME` when it is set;
    /// the default `~/.local/share` is still searched after it.
    #[test]
    fn linux_follows_xdg_data_home_and_its_package_managers() {
        let places = common_places(
            Some(Path::new("/home/ada")),
            Some(Path::new("/data")),
            false,
            listing(&[("/data/fnm/node-versions", &["v22.0.0"])]),
        );
        let at = |p: &str| places.iter().position(|x| x == Path::new(p)).unwrap_or_else(|| panic!("{p} missing from {places:#?}"));
        assert!(at("/data/mise/shims/npx") < at("/home/ada/.local/share/mise/shims/npx"));
        at("/data/fnm/node-versions/v22.0.0/installation/bin/npx");
        at("/home/linuxbrew/.linuxbrew/bin/npx");
        at("/snap/bin/npx");
        at("/usr/bin/npx");
    }

    #[test]
    fn an_extensionless_npx_on_windows_becomes_its_cmd() {
        let sh = PathBuf::from(r"C:\Program Files\nodejs\npx");
        let cmd = PathBuf::from(r"C:\Program Files\nodejs\npx.cmd");
        assert_eq!(startable(sh.clone(), true, |p| p == cmd.as_path()), cmd);
        assert_eq!(startable(sh.clone(), true, |_| false), sh, "no .cmd beside it: left alone");
        assert_eq!(startable(sh.clone(), false, |_| true), sh, "unix: the script IS the program");
    }

    #[test]
    fn the_shell_answer_is_the_last_existing_path_after_any_banner() {
        let out = "Welcome back!\n/not/there/npx\n/Users/ada/.local/share/mise/installs/node/22/bin/npx\n";
        let found = path_from_output(out, |p| p.starts_with("/Users"));
        assert_eq!(found, Some(PathBuf::from("/Users/ada/.local/share/mise/installs/node/22/bin/npx")));
        assert_eq!(path_from_output("npx not found\n", |_| true), None, "a sentence is not a path");
        assert_eq!(path_from_output("alias npx=...\n", |_| true), None);
    }

    #[test]
    fn where_prefers_the_cmd_shim() {
        let out = "C:\\Program Files\\nodejs\\npx\r\nC:\\Program Files\\nodejs\\npx.cmd\r\n";
        assert_eq!(
            pick_where(out, |_| true),
            Some(PathBuf::from("C:\\Program Files\\nodejs\\npx.cmd"))
        );
        assert_eq!(pick_where("", |_| true), None);
    }

    /// `npx` is `#!/usr/bin/env node`: the node beside it must win over
    /// any other on PATH.
    #[test]
    fn npx_runs_with_its_own_directory_first() {
        let sep = if cfg!(windows) { ";" } else { ":" };
        let path = path_with_first(Some(Path::new("/m/node/22/bin")), std::ffi::OsStr::new("/usr/bin"));
        assert_eq!(path, OsString::from(format!("/m/node/22/bin{sep}/usr/bin")));
        let path = path_with_first(Some(Path::new("/m/bin")), std::ffi::OsStr::new(""));
        assert_eq!(path, OsString::from("/m/bin"), "no trailing separator: an empty entry is the cwd");
    }

    #[test]
    fn version_folders_read_as_numbers() {
        assert_eq!(version_key("v22.11.0"), Some(vec![22, 11, 0]));
        assert_eq!(version_key("node@20"), Some(vec![20]));
        assert_eq!(version_key("latest"), None);
        assert_eq!(version_key("system"), None);
        assert_eq!(version_key("v"), None);
    }

    #[test]
    fn a_typed_home_path_is_expanded_and_nothing_else_is() {
        let home = Path::new("/Users/ada");
        assert_eq!(expand_home("~/.volta/bin/npx", Some(home)), PathBuf::from("/Users/ada/.volta/bin/npx"));
        assert_eq!(expand_home("$HOME/npx", Some(home)), PathBuf::from("$HOME/npx"));
    }

    /// The machine this runs on, end to end: where the suite's own PATH
    /// has `npx`, `locate` finds one that answers `--version`.
    #[test]
    fn a_located_npx_answers_version() {
        if crate::program::resolve("npx").is_none() {
            eprintln!("skipped: no npx on this machine");
            return;
        }
        let located = locate().expect("npx is on PATH");
        let version = run_version(&located).expect("npx --version");
        assert!(version.chars().next().is_some_and(|c| c.is_ascii_digit()), "{version}");
    }
}
