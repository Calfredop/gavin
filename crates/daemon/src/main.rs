mod bridge;
mod gavin;
mod git_status;
mod kanban;
mod orchestration;
mod osc;
mod proc;
mod program;
mod pty;
mod registry;
mod screen;
mod server;
mod shell;
mod status;
#[cfg(test)]
mod testing;

use kanban::KanbanStore;
use registry::{secure_db_file, Registry};
use server::SessionManager;
use std::path::PathBuf;
use std::sync::Arc;

/// The registry is the ONE store that splits per build.
///
/// Not tidiness: it is the only one holding PROCESS IDENTITY -- `pid` and
/// `orphan_pid` -- and `SessionManager::recover` runs over every inherited
/// row at every startup, probes the recorded pid with `proc::still_running`,
/// records a live one as an orphan for the app to surface and the human to
/// END, and respawns a bare shell in the row's cwd. Shared, a dev daemon
/// starting while the release daemon holds live PTYs would bump the
/// generation out from under those rows, mark them interrupted, list the
/// other app's running agents as orphans offering to kill them, and open a
/// phantom shell for each. That is the damage "never pkill gavin-daemon"
/// exists to prevent, arriving through a different door.
///
/// Splitting it costs nothing durable. A PTY cannot outlive its daemon, so
/// live sessions were never portable between builds, and this file holds
/// only sessions, their queued input and a generation counter. The two
/// stores beside it -- kanban and orchestration -- hold the work and
/// deliberately do NOT split.
fn db_path() -> anyhow::Result<PathBuf> {
    Ok(protocol::app_support_dir()?
        .join(protocol::profile_file_name("registry", "sqlite", protocol::BuildProfile::current())))
}

fn kanban_db_path() -> anyhow::Result<PathBuf> {
    Ok(protocol::app_support_dir()?.join("kanban.sqlite"))
}

fn orchestration_db_path() -> anyhow::Result<PathBuf> {
    Ok(protocol::app_support_dir()?.join("orchestration.sqlite"))
}

fn main() -> anyhow::Result<()> {
    // The one subcommand. `gavin-daemon` alone serves, as it always has;
    // `gavin-daemon bridge` is what the desktop runs over ssh on a host
    // whose workspace it wants (`bridge.rs`). Anything else is refused
    // by name rather than ignored: an argument silently dropped is a
    // daemon started where a bridge was meant.
    let mut args = std::env::args().skip(1);
    if let Some(first) = args.next() {
        if first == "bridge" {
            return bridge::run(bridge::parse_args(args)?);
        }
        anyhow::bail!(
            "gavin-daemon: unknown argument {first:?} -- run it with no arguments to serve, or `gavin-daemon bridge` on an ssh host"
        );
    }
    serve()
}

fn serve() -> anyhow::Result<()> {
    let dir = protocol::app_support_dir()?;

    std::fs::create_dir_all(&dir)?;
    // Owner-only, where the OS says that with a mode. On Windows the
    // directory sits under %LOCALAPPDATA%, which is already inside the
    // user's profile and inherits its ACL; the socket that used to live
    // here is a pipe, carrying its own DACL (see protocol::transport).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }

    // `Registry::open` secures its own file; kanban and orchestration
    // don't carry that logic themselves, so it's asserted here instead --
    // same 0600 as the socket beside them (`server::bind_server`), same
    // reassert-on-every-open shape, since neither store has a schema
    // version to hang a one-time migration off of a file mode.
    let registry = Registry::open(&db_path()?)?;
    let kanban = KanbanStore::open(&kanban_db_path()?)?;
    secure_db_file(&kanban_db_path()?)?;
    let orchestration = orchestration::OrchestrationStore::open(&orchestration_db_path()?)?;
    secure_db_file(&orchestration_db_path()?)?;
    let manager = Arc::new(SessionManager::new(registry, kanban, orchestration));
    manager.recover()?;

    let socket = protocol::socket_path()?;
    println!("gavin-daemon listening on {}", socket.display());
    // Which console state this daemon is in, for the machine nobody can
    // attach a debugger to: a launcher that gave it none is the state
    // `program::command` exists to survive.
    #[cfg(windows)]
    println!(
        "gavin-daemon console: {}",
        if program::has_console() { "attached" } else { "none (each child gets a hidden one)" }
    );
    server::run_server(&socket, manager)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_scoped_under_app_support() {
        let dir = protocol::app_support_dir().unwrap();
        assert!(protocol::socket_path().unwrap().starts_with(&dir));
        assert!(db_path().unwrap().starts_with(&dir));
        assert!(kanban_db_path().unwrap().starts_with(&dir));
        assert_eq!(
            protocol::socket_path().unwrap().file_name().unwrap(),
            protocol::profile_file_name("daemon", "sock", protocol::BuildProfile::current()).as_str()
        );
        assert_eq!(
            db_path().unwrap().file_name().unwrap(),
            protocol::profile_file_name("registry", "sqlite", protocol::BuildProfile::current())
                .as_str()
        );
        // NOT through profile_file_name, and that is the point: these two
        // hold the work -- board vocabularies, card runs, rails, steps,
        // tools -- and both builds must find all of it. Pinned as
        // literals so widening the split to them is a failing test rather
        // than a quiet loss of everything on the board.
        assert_eq!(kanban_db_path().unwrap().file_name().unwrap(), "kanban.sqlite");
        assert_eq!(orchestration_db_path().unwrap().file_name().unwrap(), "orchestration.sqlite");
    }
}
