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

/// Everywhere else the crate's own backend does the whole job and there
/// is no grant to sidestep, so this is the plain call.
///
/// On Linux that is the freedesktop backend: it writes
/// `<trash>/info/<name>.trashinfo` and moves the file into
/// `<trash>/files/`, which is exactly what GNOME's and KDE's "Put back"
/// reads -- and it needs the `chrono` feature, without which the info
/// file has no `DeletionDate` (see Cargo.toml). On Windows it is
/// `IFileOperation` with `FOF_ALLOWUNDO`, i.e. the Recycle Bin, with the
/// same Restore the shell's own delete gives.
#[cfg(not(target_os = "macos"))]
pub fn trash_path(path: &str) -> Result<(), String> {
    trash::delete(path).map_err(|e| e.to_string())
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use std::path::{Path, PathBuf};

    /// The promise `trash_path` makes over `rm`, checked end to end:
    /// after this, the file is in the desktop's Trash AND the record
    /// that lets "Put back" work is complete.
    ///
    /// The victim is created under `$HOME` rather than a tempdir on
    /// purpose. The freedesktop trash is per MOUNT, and `/tmp` is
    /// usually a tmpfs -- a file trashed from there lands in
    /// `/tmp/.Trash-<uid>`, not the home trash a desktop shows, and the
    /// test would be asserting about a directory no human ever opens.
    #[test]
    fn a_trashed_file_lands_in_the_home_trash_with_a_complete_info_file() {
        let Some(home) = std::env::var_os("HOME").map(PathBuf::from).filter(|p| p.is_absolute())
        else {
            return; // no HOME: nothing to assert about, and nothing broken
        };
        let name = format!("gavin-trash-test-{}", std::process::id());
        let victim = home.join(&name);
        std::fs::write(&victim, b"restore me").unwrap();

        super::trash_path(victim.to_str().unwrap()).expect("the file goes to the Trash");
        assert!(!victim.exists(), "the original is gone from where it was");

        let trash = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| home.join(".local").join("share"))
            .join("Trash");
        let info = find_info_for(&trash.join("info"), victim.to_str().unwrap())
            .expect("a .trashinfo naming the original path");
        let body = std::fs::read_to_string(&info).unwrap();

        // Path is what "Put back" restores TO; DeletionDate is the key
        // the spec makes mandatory and the `chrono` feature writes.
        assert!(body.contains("[Trash Info]"), "{body}");
        assert!(body.contains("Path="), "{body}");
        assert!(body.contains("DeletionDate="), "{body}");

        // The file itself, beside its record, is what makes it restorable.
        let stem = info.file_name().unwrap().to_string_lossy().replace(".trashinfo", "");
        let trashed = trash.join("files").join(&stem);
        assert!(trashed.exists(), "{} should hold the file", trashed.display());
        assert_eq!(std::fs::read_to_string(&trashed).unwrap(), "restore me");

        // Put the Trash back the way it was found: this is a real
        // desktop's Trash on a developer's machine, not a tempdir.
        std::fs::remove_file(&trashed).ok();
        std::fs::remove_file(&info).ok();
    }

    /// The trashed name is deduplicated by the crate, so the info files
    /// are searched by the `Path=` they record rather than by name.
    fn find_info_for(info_dir: &Path, original: &str) -> Option<PathBuf> {
        // The path is percent-encoded in the file; the tail after the
        // last slash is unencoded for the names this test uses.
        let needle = original.rsplit('/').next()?.to_string();
        std::fs::read_dir(info_dir)
            .ok()?
            .flatten()
            .map(|e| e.path())
            .find(|p| {
                std::fs::read_to_string(p).is_ok_and(|body| {
                    body.lines().any(|l| l.starts_with("Path=") && l.ends_with(&needle))
                })
            })
    }
}
