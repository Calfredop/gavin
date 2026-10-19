//! The OS watch with reads taken out before a debouncer sees them.
//!
//! inotify reports a file or folder being OPENED, and closed unwritten,
//! and `notify_debouncer_mini` keeps only an event's path, so on Linux a
//! read arrives as a change. Every watcher here reads what it watches in
//! answer to a change -- the Git tab's `git ls-files`, the file viewer
//! reloading the file it watches -- so each answer armed the next. FSEvents and
//! `ReadDirectoryChangesW` report no reads, so elsewhere this drops
//! nothing. Build every debouncer over this, never the bare
//! `RecommendedWatcher`.
//!
//! The daemon keeps its own copy (`crates/daemon/src/changes_only.rs`):
//! the app does not link it.

use std::path::Path;

pub(crate) struct ChangesOnly(notify::RecommendedWatcher);

impl notify::Watcher for ChangesOnly {
    fn new<F: notify::EventHandler>(mut handler: F, config: notify::Config) -> notify::Result<Self> {
        let inner = notify::RecommendedWatcher::new(
            move |event: notify::Result<notify::Event>| {
                if event.as_ref().map_or(true, |e| is_change(&e.kind)) {
                    handler.handle_event(event);
                }
            },
            config,
        )?;
        Ok(ChangesOnly(inner))
    }

    fn watch(&mut self, path: &Path, mode: notify::RecursiveMode) -> notify::Result<()> {
        self.0.watch(path, mode)
    }

    fn unwatch(&mut self, path: &Path) -> notify::Result<()> {
        self.0.unwatch(path)
    }

    fn kind() -> notify::WatcherKind {
        notify::RecommendedWatcher::kind()
    }
}

/// Anything but a read. A close after writing stays: it ends a write.
fn is_change(kind: &notify::EventKind) -> bool {
    use notify::event::{AccessKind, AccessMode};
    !matches!(kind, notify::EventKind::Access(access) if !matches!(access, AccessKind::Close(AccessMode::Write)))
}

/// `notify_debouncer_mini::new_debouncer`, over `ChangesOnly`.
pub(crate) fn new_debouncer<F: notify_debouncer_mini::DebounceEventHandler>(
    timeout: std::time::Duration,
    on_batch: F,
) -> notify::Result<notify_debouncer_mini::Debouncer<ChangesOnly>> {
    let config = notify_debouncer_mini::Config::default()
        .with_timeout(timeout)
        .with_notify_config(notify::Config::default().with_follow_symlinks(false));
    notify_debouncer_mini::new_debouncer_opt(config, on_batch)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_read_is_not_a_change() {
        use notify::event::{AccessKind, AccessMode, CreateKind, DataChange, ModifyKind};
        use notify::EventKind;
        assert!(!is_change(&EventKind::Access(AccessKind::Open(AccessMode::Any))));
        assert!(!is_change(&EventKind::Access(AccessKind::Close(AccessMode::Read))));
        assert!(is_change(&EventKind::Access(AccessKind::Close(AccessMode::Write))));
        assert!(is_change(&EventKind::Modify(ModifyKind::Data(DataChange::Any))));
        assert!(is_change(&EventKind::Create(CreateKind::File)));
    }
}
