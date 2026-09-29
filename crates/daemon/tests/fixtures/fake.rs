//! Builds the fake Headroom (`fake_headroom.rs`) for a test.
//!
//! Shared by the daemon's unit tests and its integration tests, which is
//! why it lives here and is pulled in with `#[path]`: an integration
//! test cannot see inside a binary crate, and a second copy of the
//! build step is a second place for it to go stale.
//!
//! Compiled with `rustc` on first use rather than declared as a `[[bin]]`
//! of the daemon's package, so a fake never lands in a release build's
//! output directory beside the daemon it imitates.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

#[cfg(windows)]
pub const NAME: &str = "headroom.exe";
#[cfg(not(windows))]
pub const NAME: &str = "headroom";

/// The fake, built once per test process.
pub fn binary() -> PathBuf {
    static BUILT: OnceLock<PathBuf> = OnceLock::new();
    BUILT.get_or_init(build).clone()
}

fn modified(path: &Path) -> Option<std::time::SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

fn build() -> PathBuf {
    let source =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("fake_headroom.rs");
    // Beside the test binaries, so it shares their target directory and
    // `cargo clean` takes it with them.
    let exe = std::env::current_exe().expect("a test has an executable");
    let dir = exe.parent().expect("an executable has a directory").join("fake-headroom");
    std::fs::create_dir_all(&dir).expect("create the fake's directory");
    let built = dir.join(NAME);
    if let (Some(binary), Some(source)) = (modified(&built), modified(&source)) {
        if binary >= source {
            return built;
        }
    }
    // Two test binaries can get here at once. Each compiles to a name
    // of its own and renames, so neither ever executes half a file.
    let temp = dir.join(format!("{NAME}.{}.tmp", std::process::id()));
    let rustc = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
    let output = Command::new(&rustc)
        .args(["--edition", "2021", "-o"])
        .arg(&temp)
        .arg(&source)
        .output()
        .unwrap_or_else(|e| panic!("could not run {rustc:?} to build the fake Headroom: {e}"));
    assert!(
        output.status.success(),
        "the fake Headroom did not compile:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    std::fs::rename(&temp, &built).expect("move the fake into place");
    built
}

/// Puts the fake at `dir/headroom`, the way an install would.
pub fn install_into(dir: &Path) -> PathBuf {
    std::fs::create_dir_all(dir).expect("create the bin directory");
    let installed = dir.join(NAME);
    std::fs::copy(binary(), &installed).expect("copy the fake Headroom");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&installed, std::fs::Permissions::from_mode(0o755))
            .expect("make the fake executable");
    }
    installed
}

/// What one start of the fake recorded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub pid: u32,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// Every start recorded in a state directory, oldest first.
pub fn launches(workspace_dir: &Path) -> Vec<Launch> {
    let Ok(body) = std::fs::read_to_string(workspace_dir.join("fake-launches.jsonl")) else {
        return Vec::new();
    };
    body.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let value: serde_json::Value = serde_json::from_str(line).expect("a launch line");
            let mut env: Vec<(String, String)> = value["env"]
                .as_object()
                .expect("env")
                .iter()
                .map(|(k, v)| (k.clone(), v.as_str().expect("an env value").to_string()))
                .collect();
            env.sort();
            Launch {
                pid: value["pid"].as_u64().expect("pid") as u32,
                args: value["args"]
                    .as_array()
                    .expect("args")
                    .iter()
                    .map(|a| a.as_str().expect("an argument").to_string())
                    .collect(),
                env,
            }
        })
        .collect()
}
