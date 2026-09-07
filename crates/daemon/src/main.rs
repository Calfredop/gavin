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
mod status;

use kanban::KanbanStore;
use registry::Registry;
use server::SessionManager;
use std::os::unix::fs::PermissionsExt;
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
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;

    let registry = Registry::open(&db_path()?)?;
    let kanban = KanbanStore::open(&kanban_db_path()?)?;
    let orchestration = orchestration::OrchestrationStore::open(&orchestration_db_path()?)?;
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
