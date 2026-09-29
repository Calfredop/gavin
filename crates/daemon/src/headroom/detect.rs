//! Finding Headroom on this machine.
//!
//! Detection runs in the daemon because the daemon is what has to
//! execute the binary, and its `PATH` is not the human's. It is the one
//! the app was launched with, and a macOS app started from the Dock gets
//! `/usr/bin:/bin:/usr/sbin:/sbin` -- no `~/.local/bin`, which is
//! exactly where `uv tool install` puts `headroom`. A Headroom the human
//! can run from their own terminal is invisible to a `PATH` lookup here.
//!
//! So the search has an order, and `PATH` is not first: uv's tool bin
//! directory, then `PATH`, then the path the human picked with Locate….
//! What it finds is stored as an absolute path and used at every start;
//! `PATH` is never searched at a launch.

use super::run;
use super::version::{self, Version};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// `headroom --version` imports a Python package before it prints. 1.8 s
/// on a warm Apple Silicon machine; the ceiling is for a cold disk.
const VERSION_TIMEOUT: Duration = Duration::from_secs(20);

#[cfg(windows)]
const BINARY: &str = "headroom.exe";
#[cfg(not(windows))]
const BINARY: &str = "headroom";

#[cfg(windows)]
const UV_BINARY: &str = "uv.exe";
#[cfg(not(windows))]
const UV_BINARY: &str = "uv";

/// The part of the environment detection reads, passed in.
///
/// Split out for the reason `protocol::resolve_app_support_dir` is: the
/// suite runs multi-threaded and spawns real processes, so mutating the
/// process environment to test a lookup is how a green suite starts
/// failing on someone else's machine.
#[derive(Debug, Clone, Default)]
pub struct Env {
    pub home: Option<PathBuf>,
    pub path: Option<OsString>,
    pub uv_tool_bin_dir: Option<PathBuf>,
    pub xdg_bin_home: Option<PathBuf>,
    pub xdg_data_home: Option<PathBuf>,
    /// Where a package manager puts `uv` that a Dock-launched `PATH`
    /// does not name. Part of the environment rather than a constant so
    /// a test can say "no uv on this machine" on a machine that has one.
    pub well_known_bin_dirs: Vec<PathBuf>,
}

impl Env {
    pub fn current() -> Env {
        let dir = |name: &str| {
            std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from)
        };
        let home = dir("HOME").or_else(|| dir("USERPROFILE"));
        let mut well_known = Vec::new();
        if let Some(home) = &home {
            // uv's own installer, then cargo's.
            well_known.push(home.join(".local").join("bin"));
            well_known.push(home.join(".cargo").join("bin"));
        }
        // Homebrew on Apple Silicon, then Homebrew on Intel and most
        // hand installs.
        well_known.push(PathBuf::from("/opt/homebrew/bin"));
        well_known.push(PathBuf::from("/usr/local/bin"));
        Env {
            home,
            path: std::env::var_os("PATH"),
            uv_tool_bin_dir: dir("UV_TOOL_BIN_DIR"),
            xdg_bin_home: dir("XDG_BIN_HOME"),
            xdg_data_home: dir("XDG_DATA_HOME"),
            well_known_bin_dirs: well_known,
        }
    }
}

/// Where `uv tool install` puts executables, by uv's own rule:
/// `$UV_TOOL_BIN_DIR`, else `$XDG_BIN_HOME`, else `$XDG_DATA_HOME/../bin`,
/// else `~/.local/bin`.
///
/// Computed rather than asked of `uv tool dir --bin`: uv is not on a
/// Dock-launched `PATH` either, and a Headroom installed by uv is still
/// there on a machine whose uv has since been removed.
pub fn uv_tool_bin_dir(env: &Env) -> Option<PathBuf> {
    let absolute = |p: &PathBuf| p.is_absolute();
    if let Some(dir) = env.uv_tool_bin_dir.as_ref().filter(|p| absolute(p)) {
        return Some(dir.clone());
    }
    if let Some(dir) = env.xdg_bin_home.as_ref().filter(|p| absolute(p)) {
        return Some(dir.clone());
    }
    if let Some(data) = env.xdg_data_home.as_ref().filter(|p| absolute(p)) {
        if let Some(parent) = data.parent() {
            return Some(parent.join("bin"));
        }
    }
    env.home.as_ref().map(|home| home.join(".local").join("bin"))
}

/// Where a candidate came from. The word travels as
/// `HeadroomStatus.source`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    UvToolDir,
    Path,
    Located,
}

impl Source {
    pub fn id(self) -> &'static str {
        match self {
            Source::UvToolDir => "uv-tool-dir",
            Source::Path => "path",
            Source::Located => "located",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub path: PathBuf,
    pub source: Source,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub path: PathBuf,
    pub source: Source,
    pub version: Version,
}

/// What a search came back with. `note` is what it could not use and
/// why, so a Settings row that says "absent" can also say that the file
/// the human located was not executable.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Detection {
    pub found: Option<Found>,
    pub note: Option<String>,
}

/// An existing file the OS will execute. On unix that is any execute
/// bit; on Windows the extension already decided it.
fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else { return false };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// `name` in each directory of a `PATH`-shaped value, in order. A
/// relative entry is skipped: it would resolve against the daemon's
/// working directory, and the path stored has to mean the same file at
/// every later start.
fn on_path(path: Option<&OsString>, name: &str) -> Vec<PathBuf> {
    let Some(path) = path else { return Vec::new() };
    std::env::split_paths(path)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(name))
        .filter(|file| is_executable(file))
        .collect()
}

/// Every Headroom there is to try, in the order they are tried. A file
/// reachable two ways -- `~/.local/bin` is uv's directory AND on the
/// human's `PATH` -- is listed once, under the first of them.
pub fn candidates(env: &Env, located: Option<&Path>) -> Vec<Candidate> {
    let mut found: Vec<Candidate> = Vec::new();
    let mut seen: Vec<PathBuf> = Vec::new();
    let mut offer = |path: PathBuf, source: Source| {
        if !path.is_absolute() || !is_executable(&path) {
            return;
        }
        let identity = path.canonicalize().unwrap_or_else(|_| path.clone());
        if seen.contains(&identity) {
            return;
        }
        seen.push(identity);
        found.push(Candidate { path, source });
    };
    if let Some(dir) = uv_tool_bin_dir(env) {
        offer(dir.join(BINARY), Source::UvToolDir);
    }
    for file in on_path(env.path.as_ref(), BINARY) {
        offer(file, Source::Path);
    }
    if let Some(located) = located {
        offer(located.to_path_buf(), Source::Located);
    }
    found
}

/// `uv`, for the install: the places a package manager puts it, then
/// `PATH`. The well-known directories come first for the same reason
/// uv's tool directory does above.
pub fn find_uv(env: &Env) -> Option<PathBuf> {
    env.well_known_bin_dirs
        .iter()
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(UV_BINARY))
        .find(|file| is_executable(file))
        .or_else(|| on_path(env.path.as_ref(), UV_BINARY).into_iter().next())
}

/// Runs the search.
///
/// The order decides between candidates gavin WILL start: the first one
/// at or above the floor wins. One below the floor does not shadow a
/// good one further down -- a stale `uv` install must not hide the
/// Headroom the human went and located -- and is reported only when
/// nothing better exists, so "too old" still names a file.
pub fn detect(
    env: &Env,
    located: Option<&Path>,
    read_version: &dyn Fn(&Path) -> Result<Version, String>,
) -> Detection {
    let mut too_old: Option<Found> = None;
    let mut notes: Vec<String> = Vec::new();
    if let Some(located) = located {
        if !located.is_absolute() {
            notes.push(format!("{} is not an absolute path.", located.display()));
        } else if !is_executable(located) {
            notes.push(format!("{} is not an executable file.", located.display()));
        }
    }
    for candidate in candidates(env, located) {
        match read_version(&candidate.path) {
            Ok(version) => {
                let found =
                    Found { path: candidate.path, source: candidate.source, version };
                if version >= version::FLOOR {
                    return Detection { found: Some(found), note: None };
                }
                too_old.get_or_insert(found);
            }
            Err(why) => notes.push(format!("{}: {why}", candidate.path.display())),
        }
    }
    Detection {
        found: too_old,
        note: if notes.is_empty() { None } else { Some(notes.join(" ")) },
    }
}

/// Asks a Headroom what it is: `headroom --version`.
pub fn read_version(path: &Path) -> Result<Version, String> {
    let out = run::run(path, &["--version"], &[], VERSION_TIMEOUT)?;
    version::read_version_output(&out.stdout)
        // click prints the version on stdout; read stderr too rather
        // than depend on that staying true.
        .or_else(|| version::read_version_output(&out.stderr))
        .ok_or_else(|| "it did not answer --version the way Headroom does".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What a macOS app launched from the Dock or Finder is handed.
    const DOCK_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";

    fn executable(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    fn env_at(home: &Path, path: &str) -> Env {
        Env {
            home: Some(home.to_path_buf()),
            path: Some(OsString::from(path)),
            ..Env::default()
        }
    }

    fn v(text: &str) -> Version {
        Version::parse(text).unwrap()
    }

    /// Reads a version out of the file itself, so a test can put
    /// different Headrooms at different paths.
    fn version_in_file(path: &Path) -> Result<Version, String> {
        let body = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        body.lines()
            .find_map(|line| line.strip_prefix("# version "))
            .and_then(Version::parse)
            .ok_or_else(|| "it did not answer --version the way Headroom does".to_string())
    }

    fn headroom_at(path: &Path, version: &str) {
        executable(path);
        let mut body = std::fs::read_to_string(path).unwrap();
        body.push_str(&format!("# version {version}\n"));
        std::fs::write(path, body).unwrap();
    }

    #[test]
    fn a_headroom_in_uvs_tool_dir_is_found_with_a_dock_launch_path() {
        let home = tempfile::tempdir().unwrap();
        let installed = home.path().join(".local").join("bin").join(BINARY);
        headroom_at(&installed, "0.39.1");
        let env = env_at(home.path(), DOCK_PATH);

        let detection = detect(&env, None, &version_in_file);

        assert_eq!(
            detection.found,
            Some(Found { path: installed, source: Source::UvToolDir, version: v("0.39.1") })
        );
    }

    #[test]
    fn a_located_path_is_honoured_when_nothing_else_is_installed() {
        let home = tempfile::tempdir().unwrap();
        let located = home.path().join("venvs").join("hr").join("bin").join(BINARY);
        headroom_at(&located, "0.38.2");
        let env = env_at(home.path(), DOCK_PATH);

        assert_eq!(detect(&env, None, &version_in_file).found, None);
        assert_eq!(
            detect(&env, Some(&located), &version_in_file).found,
            Some(Found { path: located, source: Source::Located, version: v("0.38.2") })
        );
    }

    #[test]
    fn the_order_is_uvs_directory_then_path_then_the_located_file() {
        let home = tempfile::tempdir().unwrap();
        let uv = home.path().join(".local").join("bin").join(BINARY);
        let on_path = home.path().join("brew").join("bin").join(BINARY);
        let located = home.path().join("picked").join(BINARY);
        for file in [&uv, &on_path, &located] {
            headroom_at(file, "0.39.1");
        }
        let path = format!("{DOCK_PATH}:{}", on_path.parent().unwrap().display());
        let env = env_at(home.path(), &path);

        let listed = candidates(&env, Some(&located));
        assert_eq!(
            listed.iter().map(|c| c.source).collect::<Vec<_>>(),
            vec![Source::UvToolDir, Source::Path, Source::Located]
        );
        assert_eq!(detect(&env, Some(&located), &version_in_file).found.unwrap().path, uv);

        std::fs::remove_file(&uv).unwrap();
        assert_eq!(
            detect(&env, Some(&located), &version_in_file).found.unwrap().path,
            on_path
        );

        std::fs::remove_file(&on_path).unwrap();
        assert_eq!(
            detect(&env, Some(&located), &version_in_file).found.unwrap().path,
            located
        );
    }

    /// uv's own rule for its bin directory, every row of it.
    #[test]
    fn uvs_tool_bin_dir_follows_uvs_own_precedence() {
        let home = PathBuf::from("/Users/x");
        let base = Env { home: Some(home.clone()), ..Env::default() };
        assert_eq!(uv_tool_bin_dir(&base), Some(home.join(".local/bin")));

        let data = Env { xdg_data_home: Some("/data/share".into()), ..base.clone() };
        assert_eq!(uv_tool_bin_dir(&data), Some(PathBuf::from("/data/bin")));

        let bin = Env { xdg_bin_home: Some("/xdg/bin".into()), ..data.clone() };
        assert_eq!(uv_tool_bin_dir(&bin), Some(PathBuf::from("/xdg/bin")));

        let explicit = Env { uv_tool_bin_dir: Some("/tools/bin".into()), ..bin.clone() };
        assert_eq!(uv_tool_bin_dir(&explicit), Some(PathBuf::from("/tools/bin")));

        // A relative value would move with the daemon's cwd.
        let relative = Env { uv_tool_bin_dir: Some("tools/bin".into()), ..base.clone() };
        assert_eq!(uv_tool_bin_dir(&relative), Some(home.join(".local/bin")));

        assert_eq!(uv_tool_bin_dir(&Env::default()), None);
    }

    #[test]
    fn a_headroom_below_the_floor_does_not_shadow_a_good_one_further_down() {
        let home = tempfile::tempdir().unwrap();
        let stale = home.path().join(".local").join("bin").join(BINARY);
        let located = home.path().join("picked").join(BINARY);
        headroom_at(&stale, "0.36.0");
        headroom_at(&located, "0.39.1");
        let env = env_at(home.path(), DOCK_PATH);

        let found = detect(&env, Some(&located), &version_in_file).found.unwrap();

        assert_eq!(found.path, located);
        assert_eq!(found.source, Source::Located);
    }

    #[test]
    fn a_headroom_below_the_floor_is_still_reported_when_it_is_all_there_is() {
        let home = tempfile::tempdir().unwrap();
        let stale = home.path().join(".local").join("bin").join(BINARY);
        headroom_at(&stale, "0.36.0");
        let env = env_at(home.path(), DOCK_PATH);

        let found = detect(&env, None, &version_in_file).found.unwrap();

        assert_eq!(found.version, v("0.36.0"));
        assert_eq!(found.path, stale);
    }

    #[test]
    fn a_file_reachable_two_ways_is_asked_its_version_once() {
        let home = tempfile::tempdir().unwrap();
        let installed = home.path().join(".local").join("bin").join(BINARY);
        headroom_at(&installed, "0.37.0");
        // The human's own PATH names uv's directory too.
        let path = format!("{}:{DOCK_PATH}", installed.parent().unwrap().display());
        let env = env_at(home.path(), &path);
        let asked = std::cell::Cell::new(0);

        let detection = detect(&env, Some(&installed), &|p| {
            asked.set(asked.get() + 1);
            version_in_file(p)
        });

        assert_eq!(asked.get(), 1);
        assert_eq!(detection.found.unwrap().source, Source::UvToolDir);
    }

    #[test]
    fn a_program_that_is_not_headroom_is_passed_over_and_named() {
        let home = tempfile::tempdir().unwrap();
        let impostor = home.path().join(".local").join("bin").join(BINARY);
        executable(&impostor);
        let env = env_at(home.path(), DOCK_PATH);

        let detection = detect(&env, None, &version_in_file);

        assert_eq!(detection.found, None);
        let note = detection.note.unwrap();
        assert!(note.contains(&impostor.display().to_string()), "{note}");
    }

    #[test]
    fn a_located_path_that_cannot_be_run_says_so() {
        let home = tempfile::tempdir().unwrap();
        let env = env_at(home.path(), DOCK_PATH);
        let missing = home.path().join("nowhere").join(BINARY);

        let detection = detect(&env, Some(&missing), &version_in_file);
        assert_eq!(detection.found, None);
        assert!(detection.note.unwrap().contains("not an executable file"));

        let relative = detect(&env, Some(Path::new("bin/headroom")), &version_in_file);
        assert!(relative.note.unwrap().contains("not an absolute path"));
    }

    #[cfg(unix)]
    #[test]
    fn a_file_without_an_execute_bit_is_not_a_candidate() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        let installed = home.path().join(".local").join("bin").join(BINARY);
        headroom_at(&installed, "0.39.1");
        std::fs::set_permissions(&installed, std::fs::Permissions::from_mode(0o644)).unwrap();
        let env = env_at(home.path(), DOCK_PATH);

        assert!(candidates(&env, None).is_empty());
    }

    #[test]
    fn a_relative_path_entry_is_never_searched() {
        let home = tempfile::tempdir().unwrap();
        let env = env_at(home.path(), "bin:.:relative/dir");
        assert!(candidates(&env, None).is_empty());
    }

    #[test]
    fn uv_is_found_where_a_package_manager_puts_it_before_path() {
        let home = tempfile::tempdir().unwrap();
        let brew = home.path().join("opt").join("homebrew").join("bin");
        let on_path = home.path().join("elsewhere");
        executable(&brew.join(UV_BINARY));
        executable(&on_path.join(UV_BINARY));
        let env = Env {
            well_known_bin_dirs: vec![home.path().join("missing"), brew.clone()],
            ..env_at(home.path(), &on_path.display().to_string())
        };
        assert_eq!(find_uv(&env), Some(brew.join(UV_BINARY)));

        let path_only = Env { well_known_bin_dirs: vec![], ..env.clone() };
        assert_eq!(find_uv(&path_only), Some(on_path.join(UV_BINARY)));

        let none = Env { well_known_bin_dirs: vec![], ..env_at(home.path(), DOCK_PATH) };
        // `/usr/bin/uv` does not exist on any machine this runs on.
        assert_eq!(find_uv(&none), None);
    }

    /// The real reader against a real process: a script that prints
    /// what Headroom prints.
    #[cfg(unix)]
    #[test]
    fn the_version_is_read_by_running_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join(BINARY);
        std::fs::write(
            &program,
            "#!/bin/sh\n[ \"$1\" = \"--version\" ] && echo 'headroom, version 0.39.1'\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(read_version(&program), Ok(v("0.39.1")));
    }

    #[test]
    fn every_source_has_the_word_the_wire_carries() {
        assert_eq!(Source::UvToolDir.id(), "uv-tool-dir");
        assert_eq!(Source::Path.id(), "path");
        assert_eq!(Source::Located.id(), "located");
    }
}
