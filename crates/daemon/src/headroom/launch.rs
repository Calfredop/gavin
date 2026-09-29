//! The one way gavin starts Headroom: the same fixed flags, every time.
//!
//! "Gavin runs Headroom" is only true while gavin chose everything the
//! proxy was started with (ADR 0007). So a start is not assembled from
//! options -- it is this list, the port, and nothing the daemon happened
//! to inherit.

use protocol::BuildProfile;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Loopback, spelled as the address rather than `localhost`: a name can
/// resolve to `::1` first, and the agents are handed `127.0.0.1`.
pub const HOST: &str = "127.0.0.1";

/// Every variable Headroom reads its own settings from starts with this.
const OWN_PREFIX: &str = "HEADROOM_";

/// Where this daemon's Headroom keeps its state: beside the daemon's own
/// files, with the socket's suffix.
///
/// Per daemon because two proxies over one directory overwrite each
/// other's savings -- each loads `proxy_savings.json` once and rewrites
/// it whole -- and a release build and a dev build run a Headroom each.
pub fn workspace_dir(state_dir: &Path, profile: BuildProfile) -> PathBuf {
    state_dir.join(format!("headroom{}", profile.suffix()))
}

/// A start, as data: what to run, with which arguments, under which
/// environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub workspace_dir: PathBuf,
}

/// The fixed flags.
///
/// | Setting | Why |
/// |---|---|
/// | `--host 127.0.0.1 --port <port>` | Loopback only, on the daemon's port |
/// | `HEADROOM_WORKSPACE_DIR` | Its own state, per daemon |
/// | `HEADROOM_BEACON=off`, `DO_NOT_TRACK=1` | The usage beacon is on by default |
/// | `HEADROOM_UPDATE_CHECK=off` | Gavin owns the version |
/// | `--no-subscription-tracking` | Headroom would poll Anthropic's OAuth usage endpoint with the human's token; gavin already polls it, and it rate-limits hard |
///
/// Nothing else is passed, which is the other half of the list: memory,
/// learn, the output shaper, model routing and Serena are off by default
/// in Headroom, and gavin turns none of them on.
pub fn launch(program: &Path, port: u16, state_dir: &Path, profile: BuildProfile) -> Launch {
    let workspace_dir = workspace_dir(state_dir, profile);
    Launch {
        program: program.to_path_buf(),
        args: vec![
            "proxy".to_string(),
            "--host".to_string(),
            HOST.to_string(),
            "--port".to_string(),
            port.to_string(),
            "--no-subscription-tracking".to_string(),
        ],
        env: vec![
            ("HEADROOM_WORKSPACE_DIR".to_string(), workspace_dir.to_string_lossy().into_owned()),
            ("HEADROOM_BEACON".to_string(), "off".to_string()),
            ("DO_NOT_TRACK".to_string(), "1".to_string()),
            ("HEADROOM_UPDATE_CHECK".to_string(), "off".to_string()),
        ],
        workspace_dir,
    }
}

/// The inherited variables a start must NOT pass on: every one of
/// Headroom's own.
///
/// Each of Headroom's flags has an environment twin (`HEADROOM_MODE`,
/// `HEADROOM_TELEMETRY`, `HEADROOM_PORT`, `HEADROOM_OUTPUT_SHAPER`, …),
/// and the daemon inherits whatever the app was launched with -- from a
/// terminal, that is the human's whole shell profile. A proxy that
/// picked its port or turned a feature on from there would be running
/// with settings gavin did not choose, which is what adopting a stranger
/// was rejected for. Variables that are not Headroom's own are left
/// alone: `HTTPS_PROXY` and the provider target URLs describe the
/// human's network, not the proxy's behaviour.
pub fn inherited_to_remove(keys: impl Iterator<Item = OsString>) -> Vec<OsString> {
    keys.filter(|key| key.to_str().is_some_and(|k| k.starts_with(OWN_PREFIX))).collect()
}

/// The `Command` for a launch, through `program::command` like every
/// other program the daemon starts.
pub fn command(
    launch: &Launch,
    inherited: impl Iterator<Item = OsString>,
) -> std::process::Command {
    let mut command = crate::program::command(&launch.program);
    command.args(&launch.args);
    for key in inherited_to_remove(inherited) {
        command.env_remove(key);
    }
    for (key, value) in &launch.env {
        command.env(key, value);
    }
    command
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    /// What a built command will pass: every variable it sets, and
    /// every one it removes (`None`).
    fn explicit_env(command: &std::process::Command) -> Vec<(String, Option<String>)> {
        let mut env: Vec<_> = command
            .get_envs()
            .map(|(k, v)| {
                (k.to_string_lossy().into_owned(), v.map(|v| v.to_string_lossy().into_owned()))
            })
            .collect();
        env.sort();
        env
    }

    fn state_dir() -> PathBuf {
        PathBuf::from("/Users/x/Library/Application Support/gavin")
    }

    #[test]
    fn every_start_carries_exactly_the_fixed_flags() {
        let launch = launch(
            Path::new("/Users/x/.local/bin/headroom"),
            51234,
            &state_dir(),
            BuildProfile::Release,
        );
        assert_eq!(launch.program, PathBuf::from("/Users/x/.local/bin/headroom"));
        assert_eq!(
            launch.args,
            ["proxy", "--host", "127.0.0.1", "--port", "51234", "--no-subscription-tracking"]
        );
        assert_eq!(
            launch.env,
            [
                (
                    "HEADROOM_WORKSPACE_DIR".to_string(),
                    "/Users/x/Library/Application Support/gavin/headroom".to_string()
                ),
                ("HEADROOM_BEACON".to_string(), "off".to_string()),
                ("DO_NOT_TRACK".to_string(), "1".to_string()),
                ("HEADROOM_UPDATE_CHECK".to_string(), "off".to_string()),
            ]
        );
    }

    #[test]
    fn the_state_directory_follows_the_sockets_dev_suffix() {
        assert_eq!(
            workspace_dir(&state_dir(), BuildProfile::Release),
            state_dir().join("headroom")
        );
        assert_eq!(workspace_dir(&state_dir(), BuildProfile::Dev), state_dir().join("headroom-dev"));
        // The same rule the socket itself is named by.
        for profile in [BuildProfile::Release, BuildProfile::Dev] {
            let socket = protocol::profile_file_name("daemon", "sock", profile);
            let dir = workspace_dir(&state_dir(), profile);
            assert_eq!(
                socket.contains("-dev"),
                dir.file_name().unwrap().to_string_lossy().contains("-dev")
            );
        }
    }

    #[test]
    fn a_release_and_a_dev_start_differ_only_in_port_and_state_directory() {
        let program = Path::new("/Users/x/.local/bin/headroom");
        let release = launch(program, 50001, &state_dir(), BuildProfile::Release);
        let dev = launch(program, 50002, &state_dir(), BuildProfile::Dev);
        assert_ne!(release.workspace_dir, dev.workspace_dir);
        let differing: Vec<usize> = release
            .args
            .iter()
            .zip(&dev.args)
            .enumerate()
            .filter(|(_, (a, b))| a != b)
            .map(|(i, _)| i)
            .collect();
        assert_eq!(differing, vec![4], "only the port argument may differ");
        let differing: Vec<&str> = release
            .env
            .iter()
            .zip(&dev.env)
            .filter(|(a, b)| a != b)
            .map(|(a, _)| a.0.as_str())
            .collect();
        assert_eq!(differing, vec!["HEADROOM_WORKSPACE_DIR"]);
    }

    #[test]
    fn headrooms_own_inherited_variables_are_removed_and_nothing_else_is() {
        let inherited = [
            "PATH",
            "HOME",
            "HEADROOM_MODE",
            "HEADROOM_TELEMETRY",
            "HEADROOM_PORT",
            "HEADROOM_WORKSPACE_DIR",
            "HTTPS_PROXY",
            "ANTHROPIC_TARGET_API_URL",
            "MY_HEADROOM_NOTES",
        ];
        let removed = inherited_to_remove(inherited.iter().map(OsString::from));
        assert_eq!(
            removed,
            ["HEADROOM_MODE", "HEADROOM_TELEMETRY", "HEADROOM_PORT", "HEADROOM_WORKSPACE_DIR"]
                .map(OsString::from)
        );
    }

    /// The built command, not the plan for one: what `spawn` would pass.
    #[test]
    fn the_command_passes_the_fixed_environment_over_whatever_was_inherited() {
        let launch = launch(
            Path::new("/Users/x/.local/bin/headroom"),
            51234,
            &state_dir(),
            BuildProfile::Dev,
        );
        let inherited = ["PATH", "HEADROOM_BEACON", "HEADROOM_LOSSLESS"].map(OsString::from);

        let command = command(&launch, inherited.into_iter());

        assert_eq!(command.get_program(), OsStr::new("/Users/x/.local/bin/headroom"));
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            ["proxy", "--host", "127.0.0.1", "--port", "51234", "--no-subscription-tracking"]
        );
        assert_eq!(
            explicit_env(&command),
            [
                ("DO_NOT_TRACK".to_string(), Some("1".to_string())),
                // Inherited as something else, set to gavin's value.
                ("HEADROOM_BEACON".to_string(), Some("off".to_string())),
                // Inherited, and not one of the fixed four: removed.
                ("HEADROOM_LOSSLESS".to_string(), None),
                ("HEADROOM_UPDATE_CHECK".to_string(), Some("off".to_string())),
                (
                    "HEADROOM_WORKSPACE_DIR".to_string(),
                    Some("/Users/x/Library/Application Support/gavin/headroom-dev".to_string())
                ),
            ]
        );
    }
}
