//! Moving a file to the OS Trash, for the two features that destroy the
//! human's files: the workspace delete wizard and a run discard.
//!
//! Its own module because both of those had the same choice to make and
//! must not make it twice. The rule is that nothing gavin removes on the
//! human's behalf is unrecoverable when the OS offers a Trash --
//! `git reset --hard` leaves a reflog and a delete wizard leaves a
//! Finder window, and an `rm` would leave neither.

/// Moves one path to the OS Trash.
///
/// On macOS the crate offers two routes and neither is free. The default
/// asks Finder over Apple events: it plays the sound and fills in "Put
/// Back", but it needs the Automation permission, and a feature that
/// dies on an unrelated TCC prompt is worse than one without a
/// context-menu entry. `NsFileManager` needs no grant and is markedly
/// faster; the files land in the same Trash and can still be dragged
/// back out, which is the promise this actually makes.
#[cfg(target_os = "macos")]
pub fn trash_path(path: &str) -> Result<(), String> {
    use trash::macos::{DeleteMethod, TrashContextExtMacos};
    let mut ctx = trash::TrashContext::default();
    ctx.set_delete_method(DeleteMethod::NsFileManager);
    ctx.delete(path).map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn trash_path(path: &str) -> Result<(), String> {
    trash::delete(path).map_err(|e| e.to_string())
}
