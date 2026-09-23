//! Moving a file to THIS machine's Trash, for `TrashWorkspacePath`
//! (v42): the Files tree of a workspace that lives here and is being
//! driven from a desktop somewhere else.
//!
//! A near-copy of `app/src-tauri/src/trash.rs`, and deliberately not a
//! weaker version of it. The desktop's rule is that nothing gavin
//! removes on the human's behalf is unrecoverable when the OS offers a
//! Trash; a workspace reached over ssh does not get `rm` instead, least
//! of all because it is the machine the human is least able to check.
//! The two copies exist because the crates are separate, not because the
//! decision is.

/// Moves one path to the OS Trash.
///
/// On macOS the crate offers two routes and only one of them can work
/// here. The default asks Finder over Apple events, which needs the
/// Automation permission -- a grant a daemon started by `sshd` will
/// never be given, and a prompt no one is sitting in front of to
/// answer. `NsFileManager` needs no grant, is markedly faster, and the
/// files land in the same Trash to be dragged back out, which is the
/// promise this actually makes.
#[cfg(target_os = "macos")]
pub fn trash_path(path: &str) -> anyhow::Result<()> {
    use trash::macos::{DeleteMethod, TrashContextExtMacos};
    let mut ctx = trash::TrashContext::default();
    ctx.set_delete_method(DeleteMethod::NsFileManager);
    ctx.delete(path).map_err(|e| anyhow::anyhow!("{e}"))
}

/// Everywhere else the crate's own backend does the whole job and there
/// is no grant to sidestep. On Linux that is the freedesktop backend
/// (`<trash>/info/<name>.trashinfo` plus the file itself, which is what
/// GNOME's and KDE's "Put back" reads -- and needs the `chrono` feature,
/// see Cargo.toml); on Windows it is `IFileOperation` with
/// `FOF_ALLOWUNDO`, i.e. the Recycle Bin with the shell's own Restore.
#[cfg(not(target_os = "macos"))]
pub fn trash_path(path: &str) -> anyhow::Result<()> {
    trash::delete(path).map_err(|e| anyhow::anyhow!("{e}"))
}
