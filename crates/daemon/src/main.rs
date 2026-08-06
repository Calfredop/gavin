mod gavin;
mod git_status;
mod kanban;
mod osc;
mod pty;
mod registry;
mod server;
mod status;

use kanban::KanbanStore;
use registry::Registry;
use server::SessionManager;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Arc;

fn db_path() -> PathBuf {
    protocol::app_support_dir().join("registry.sqlite")
}

fn kanban_db_path() -> PathBuf {
    protocol::app_support_dir().join("kanban.sqlite")
}

fn main() -> anyhow::Result<()> {
    let dir = protocol::app_support_dir();
    std::fs::create_dir_all(&dir)?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;

    let registry = Registry::open(&db_path())?;
    let kanban = KanbanStore::open(&kanban_db_path())?;
    let manager = Arc::new(SessionManager::new(registry, kanban));
    manager.recover()?;

    println!("gavin-daemon listening on {}", protocol::socket_path().display());
    server::run_server(&protocol::socket_path(), manager)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_scoped_under_app_support() {
        let dir = protocol::app_support_dir();
        assert!(protocol::socket_path().starts_with(&dir));
        assert!(db_path().starts_with(&dir));
        assert!(kanban_db_path().starts_with(&dir));
        assert_eq!(protocol::socket_path().file_name().unwrap(), "daemon.sock");
        assert_eq!(db_path().file_name().unwrap(), "registry.sqlite");
        assert_eq!(kanban_db_path().file_name().unwrap(), "kanban.sqlite");
    }
}
