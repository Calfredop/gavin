//! `gavin-mcp playwright`: the command a workspace's MCP config runs for
//! the `playwright` server.
//!
//! It asks the daemon for this session's endpoint on the browser proxy
//! (`Request::PlaywrightEndpoint`), then becomes the pinned
//! `@playwright/mcp` pointed at it, run through `npx`. On unix that is an
//! `exec()`, so the agent's MCP client is talking to Playwright on the
//! very same pipes. Windows has no `exec()`, so the MCP runs as a child
//! on this process's own stdio and this process waits and exits with its
//! code, as the re-exec handover does there.
//!
//! Every way it cannot start says why on stderr and exits non-zero. An
//! MCP client shows the agent that line rather than a server that
//! silently failed.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

use protocol::{Request, Response};

use crate::DaemonTransport;

/// What the shim needs before it can start the MCP: this session's
/// endpoint and output folder.
#[derive(Debug, PartialEq)]
pub struct Endpoint {
    pub endpoint: String,
    pub output_dir: PathBuf,
}

/// Asks the daemon for this session's endpoint. `session_id` is
/// `GAVIN_SESSION_ID`, which the daemon sets on every tab it opens.
pub fn resolve(transport: &mut dyn DaemonTransport, session_id: Option<&str>) -> Result<Endpoint, String> {
    let Some(session_id) = session_id.filter(|s| !s.is_empty()) else {
        return Err(
            "gavin's Playwright server runs only inside a gavin agent session (GAVIN_SESSION_ID is not set) -- \
             start the agent from a gavin tab"
                .into(),
        );
    };
    match transport.request(&Request::PlaywrightEndpoint { session_id: session_id.to_string() }) {
        Ok(Response::PlaywrightEndpoint { endpoint, output_dir }) => {
            Ok(Endpoint { endpoint, output_dir: PathBuf::from(output_dir) })
        }
        Ok(Response::Error { message }) => Err(message),
        Ok(Response::Forbidden { request_type, role, .. }) => Err(format!(
            "the gavin daemon refused {request_type} to this {role} connection -- is GAVIN_SESSION_TOKEN set?"
        )),
        Ok(other) => Err(format!("the gavin daemon answered PlaywrightEndpoint with {other:?}")),
        Err(e) => Err(e.to_string()),
    }
}

/// Where `npx` is looked for: this `PATH`, then the well-known install
/// directories a Dock-launched `PATH` lacks (Homebrew's among them).
pub fn npx_dirs(path: Option<&std::ffi::OsStr>, home: Option<&Path>, windows: bool) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = path.map(|p| std::env::split_paths(p).collect()).unwrap_or_default();
    dirs.extend(protocol::bin_dirs::well_known_bin_dirs(home, windows));
    dirs
}

/// The first `npx` in `dirs`.
pub fn find_npx(dirs: &[PathBuf], windows: bool) -> Option<PathBuf> {
    let name = if windows { "npx.cmd" } else { "npx" };
    dirs.iter().map(|dir| dir.join(name)).find(|candidate| candidate.is_file())
}

/// The command that runs the pinned MCP against `endpoint`, with `extra`
/// (anything after `playwright` in the MCP entry) passed on to it.
pub fn mcp_command(npx: &Path, endpoint: &Endpoint, extra: &[OsString]) -> Command {
    let args = protocol::playwright::mcp_args(&endpoint.endpoint, &endpoint.output_dir);
    // `npx.cmd` is a batch file, and a batch file's arguments are parsed
    // by cmd.exe, by rules no quoting from here survives. It is a thin
    // wrapper over npm's own `npx-cli.js` beside it, so that is run with
    // the `node.exe` beside it, which parses argv the ordinary way.
    if npx.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd")) {
        let dir = npx.parent().unwrap_or(Path::new("."));
        let node = dir.join("node.exe");
        let cli = dir.join("node_modules").join("npm").join("bin").join("npx-cli.js");
        if node.is_file() && cli.is_file() {
            let mut command = Command::new(node);
            command.arg(cli).args(&args).args(extra);
            return command;
        }
    }
    let mut command = Command::new(npx);
    command.args(&args).args(extra);
    // `npx` is a `#!/usr/bin/env node` script, and found in a well-known
    // directory rather than on PATH, the node beside it is not on PATH
    // either.
    if let Some(path) = path_with_dir_of(std::env::var_os("PATH").as_deref(), npx) {
        command.env("PATH", path);
    }
    command
}

/// `path` with the directory `program` is in appended, or `None` when it
/// is already on it.
fn path_with_dir_of(path: Option<&std::ffi::OsStr>, program: &Path) -> Option<OsString> {
    let dir = program.parent().filter(|d| !d.as_os_str().is_empty())?;
    let mut dirs: Vec<PathBuf> = path.map(|p| std::env::split_paths(p).collect()).unwrap_or_default();
    if dirs.iter().any(|d| d == dir) {
        return None;
    }
    dirs.push(dir.to_path_buf());
    std::env::join_paths(dirs).ok()
}

/// The whole subcommand. `Err` is why the MCP could not be started,
/// not yet printed: the caller may still hand the session to a newer
/// binary first. `Ok` is an exit code -- on unix only ever a failed
/// `exec`, since a successful one does not return.
pub fn run(transport: &mut dyn DaemonTransport, extra: &[OsString]) -> Result<i32, String> {
    let session_id = std::env::var("GAVIN_SESSION_ID").ok();
    let endpoint = resolve(transport, session_id.as_deref())?;
    let home_var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    let home = std::env::var_os(home_var).filter(|h| !h.is_empty()).map(PathBuf::from);
    let dirs = npx_dirs(std::env::var_os("PATH").as_deref(), home.as_deref(), cfg!(windows));
    let npx = find_npx(&dirs, cfg!(windows)).ok_or_else(|| {
        "Node.js/npx is needed for Playwright and was not found on PATH -- \
         install Node.js (https://nodejs.org), then restart this agent"
            .to_string()
    })?;
    let mut command = mcp_command(&npx, &endpoint, extra);
    Ok(start(&mut command))
}

#[cfg(unix)]
fn start(command: &mut Command) -> i32 {
    use std::os::unix::process::CommandExt;
    let error = command.exec();
    eprintln!("gavin-mcp playwright: could not start {:?}: {error}", command.get_program());
    1
}

#[cfg(windows)]
fn start(command: &mut Command) -> i32 {
    match command.spawn() {
        Ok(mut child) => match child.wait() {
            Ok(status) => status.code().unwrap_or(1),
            Err(e) => {
                eprintln!("gavin-mcp playwright: lost the Playwright MCP: {e}");
                1
            }
        },
        Err(e) => {
            eprintln!("gavin-mcp playwright: could not start {:?}: {e}", command.get_program());
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Answers(Vec<anyhow::Result<Response>>, Vec<Request>);

    impl DaemonTransport for Answers {
        fn request(&mut self, req: &Request) -> anyhow::Result<Response> {
            self.1.push(req.clone());
            self.0.remove(0)
        }
    }

    #[test]
    fn no_session_id_says_so_without_asking_the_daemon() {
        let mut daemon = Answers(vec![], vec![]);
        for absent in [None, Some("")] {
            let why = resolve(&mut daemon, absent).unwrap_err();
            assert!(why.contains("GAVIN_SESSION_ID is not set"), "{why}");
        }
        assert!(daemon.1.is_empty());
    }

    #[test]
    fn the_endpoint_is_asked_for_this_session_and_handed_back() {
        let mut daemon = Answers(
            vec![Ok(Response::PlaywrightEndpoint {
                endpoint: "ws://127.0.0.1:4/devtools/browser/ab".into(),
                output_dir: "/state/playwright/s1/output".into(),
            })],
            vec![],
        );
        let got = resolve(&mut daemon, Some("s1")).unwrap();
        assert_eq!(got.endpoint, "ws://127.0.0.1:4/devtools/browser/ab");
        assert_eq!(got.output_dir, PathBuf::from("/state/playwright/s1/output"));
        assert!(matches!(&daemon.1[0], Request::PlaywrightEndpoint { session_id } if session_id == "s1"));
    }

    #[test]
    fn the_daemons_reason_is_the_message() {
        let not_installed = "Playwright's browser is not installed -- run the Playwright step in gavin's setup";
        let mut daemon = Answers(vec![Ok(Response::Error { message: not_installed.into() })], vec![]);
        assert_eq!(resolve(&mut daemon, Some("s")).unwrap_err(), not_installed);

        let mut daemon = Answers(vec![Err(anyhow::anyhow!("gavin daemon isn't running — open the gavin app"))], vec![]);
        assert!(resolve(&mut daemon, Some("s")).unwrap_err().contains("isn't running"));
    }

    #[test]
    fn npx_is_looked_for_on_path_first_then_in_the_well_known_dirs() {
        let path = std::env::join_paths(["/first", "/second"]).unwrap();
        let dirs = npx_dirs(Some(&path), Some(Path::new("/home/ada")), false);
        assert_eq!(&dirs[..2], [PathBuf::from("/first"), PathBuf::from("/second")]);
        assert!(dirs.contains(&PathBuf::from("/home/ada/.local/bin")));
        assert!(dirs.contains(&PathBuf::from("/opt/homebrew/bin")));
    }

    #[test]
    fn the_first_dir_holding_npx_wins() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (dir.path().join("a"), dir.path().join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let dirs = [a.clone(), b.clone()];
        assert_eq!(find_npx(&dirs, false), None);
        std::fs::write(b.join("npx"), "").unwrap();
        assert_eq!(find_npx(&dirs, false), Some(b.join("npx")));
        std::fs::write(a.join("npx.cmd"), "").unwrap();
        assert_eq!(find_npx(&dirs, true), Some(a.join("npx.cmd")));
    }

    #[test]
    fn the_command_runs_the_pin_against_the_endpoint() {
        let endpoint = Endpoint {
            endpoint: "ws://127.0.0.1:4/devtools/browser/ab".into(),
            output_dir: PathBuf::from("/out"),
        };
        let command = mcp_command(Path::new("/usr/bin/npx"), &endpoint, &[OsString::from("--caps=vision")]);
        let args: Vec<String> = command.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(command.get_program(), "/usr/bin/npx");
        assert_eq!(
            args,
            [
                "-y",
                &protocol::playwright::mcp_spec(),
                "--cdp-endpoint",
                "ws://127.0.0.1:4/devtools/browser/ab",
                "--output-dir",
                "/out",
                "--caps=vision"
            ]
        );
    }

    #[test]
    fn npx_found_off_path_brings_its_directory_onto_it() {
        let path = std::env::join_paths(["/usr/bin", "/bin"]).unwrap();
        let added = path_with_dir_of(Some(&path), Path::new("/opt/homebrew/bin/npx")).unwrap();
        assert_eq!(std::env::split_paths(&added).last().unwrap(), PathBuf::from("/opt/homebrew/bin"));
        assert_eq!(path_with_dir_of(Some(&path), Path::new("/usr/bin/npx")), None);
    }

    #[test]
    fn a_windows_npx_cmd_runs_through_the_node_beside_it() {
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("node_modules").join("npm").join("bin");
        std::fs::create_dir_all(&cli).unwrap();
        std::fs::write(cli.join("npx-cli.js"), "").unwrap();
        std::fs::write(dir.path().join("node.exe"), "").unwrap();
        let endpoint = Endpoint { endpoint: "ws://x".into(), output_dir: PathBuf::from("C:/Users/A B/out") };
        let command = mcp_command(&dir.path().join("npx.cmd"), &endpoint, &[]);
        assert_eq!(command.get_program(), dir.path().join("node.exe").as_os_str());
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args[0], cli.join("npx-cli.js").as_os_str());
        assert_eq!(args.last().unwrap(), &std::ffi::OsStr::new("C:/Users/A B/out"));
    }
}
