mod gavin;
mod git_status;
mod kanban;
mod orchestration;
mod osc;
mod proc;
mod pty;
mod registry;
mod screen;
mod server;
mod shell;
mod status;

use kanban::KanbanStore;
use registry::{secure_db_file, Registry};
use server::SessionManager;
use std::path::PathBuf;
use std::sync::Arc;

fn db_path() -> anyhow::Result<PathBuf> {
    Ok(protocol::app_support_dir()?.join("registry.sqlite"))
}

fn kanban_db_path() -> anyhow::Result<PathBuf> {
    Ok(protocol::app_support_dir()?.join("kanban.sqlite"))
}

fn orchestration_db_path() -> anyhow::Result<PathBuf> {
    Ok(protocol::app_support_dir()?.join("orchestration.sqlite"))
}

fn main() -> anyhow::Result<()> {
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
        assert_eq!(protocol::socket_path().unwrap().file_name().unwrap(), "daemon.sock");
        assert_eq!(db_path().unwrap().file_name().unwrap(), "registry.sqlite");
        assert_eq!(kanban_db_path().unwrap().file_name().unwrap(), "kanban.sqlite");
        assert_eq!(orchestration_db_path().unwrap().file_name().unwrap(), "orchestration.sqlite");
    }
}
