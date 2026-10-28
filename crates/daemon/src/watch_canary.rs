//! Notices when the OS has stopped delivering file events to the watches
//! this process already holds, so they can be made again.
//!
//! macOS hands every FSEvents stream its events through one system daemon,
//! `fseventsd`. When that restarts -- it did on 2026-10-28, on a Mac
//! running at a load average in the hundreds -- every stream opened before
//! the restart goes quiet for good: no error, no "rescan" flag, no event,
//! ever again. Streams opened afterwards work. gavin's watches are opened
//! once and kept, so everything they feed froze at the restart: cards an
//! agent filed through `gavin_create_plan` were on disk, the MCP's own scan
//! listed them, and the board never heard; the Git tab and the session git
//! chips stopped moving with the files. Closing and reopening a workspace
//! "fixed" the board only because that opened a fresh stream.
//!
//! Nothing a watch reports can tell a quiet folder from a deaf stream, so
//! the canary asks a question with a known answer: it keeps a watch of its
//! own on a folder it owns and touches a file there every
//! `PROBE_INTERVAL`. A canary that hears the touch vouches for every watch
//! opened before it. One that does not is checked against a watch opened
//! just now -- if THAT one hears, the old streams are dead and the process
//! re-arms its watches; if neither hears, events are merely slow (or
//! broken outright), and re-arming would only rescan every root for
//! nothing.
//!
//! Every process that holds watches runs one: the daemon (`.gavin*`, the
//! ssh Git tab, the session git chips) and the desktop app (the local Git
//! tab). The two crates do not link each other, so each keeps this file,
//! byte for byte the same -- the daemon's tests compare them.
//!
//! Only macOS has a separate event daemon to lose; inotify and
//! `ReadDirectoryChangesW` live in the kernel and die with the process.

use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

/// How often the canary is touched. Bounds how long a board stays frozen
/// after `fseventsd` restarts, at the cost of one tiny file write.
const PROBE_INTERVAL: Duration = Duration::from_secs(30);

/// How long a watch gets to hear a touch. Generous: a Mac loaded enough to
/// restart `fseventsd` delivers late, and a late event is not a dead one.
const HEAR_TIMEOUT: Duration = Duration::from_secs(10);

/// Where events come from, and how to make one. The real one is a notify
/// watch on the canary folder; tests stand in a stream they can kill.
pub trait Source {
    type Watch;
    /// A new watch that sends on `heard` for every change it reports.
    fn watch(&self, heard: Sender<()>) -> Option<Self::Watch>;
    /// Changes the watched file.
    fn touch(&self);
}

/// The watch that stands for "every watch opened before now".
pub struct Standing<W> {
    _watch: W,
    heard: Receiver<()>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// The standing watch heard the touch.
    Alive,
    /// The standing watch heard nothing and one opened just now did: the
    /// streams opened before it are dead, and have to be opened again.
    Deaf,
    /// Neither heard. Events are slow or not arriving at all; nothing a
    /// re-arm could fix. The fresh watch stands from now on, so the next
    /// probe asks again.
    Silent,
}

fn arm<S: Source>(source: &S) -> Option<Standing<S::Watch>> {
    let (tx, heard) = channel();
    source.watch(tx).map(|watch| Standing { _watch: watch, heard })
}

fn drain(heard: &Receiver<()>) {
    while heard.try_recv().is_ok() {}
}

fn hears(heard: &Receiver<()>, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        match heard.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(()) => return true,
            Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => return false,
        }
    }
}

/// One probe. Arms the standing watch if there is none yet -- with nothing
/// opened before it to vouch for, that probe is `Alive` by definition.
pub fn probe<S: Source>(source: &S, standing: &mut Option<Standing<S::Watch>>, timeout: Duration) -> Verdict {
    let Some(current) = standing.as_ref() else {
        *standing = arm(source);
        return Verdict::Alive;
    };
    drain(&current.heard);
    source.touch();
    if hears(&current.heard, timeout) {
        return Verdict::Alive;
    }
    let Some(fresh) = arm(source) else { return Verdict::Silent };
    source.touch();
    let fresh_heard = hears(&fresh.heard, timeout);
    // Both watches are fed the same events in the same order, so an alive
    // standing watch has heard the first touch by the time the fresh one
    // hears the second. One that has is slow, not deaf.
    let late = current.heard.try_recv().is_ok();
    *standing = Some(fresh);
    match (fresh_heard, late) {
        (true, false) => Verdict::Deaf,
        (true, true) => Verdict::Alive,
        (false, _) => Verdict::Silent,
    }
}

/// The canary folder's notify watch.
struct FolderSource {
    file: PathBuf,
}

impl Source for FolderSource {
    type Watch = crate::changes_only::ChangesOnly;

    fn watch(&self, heard: Sender<()>) -> Option<Self::Watch> {
        use notify::Watcher;
        let file = self.file.clone();
        let mut watch = crate::changes_only::ChangesOnly::new(
            move |event: notify::Result<notify::Event>| {
                if event.is_ok_and(|e| e.paths.iter().any(|p| p == &file)) {
                    let _ = heard.send(());
                }
            },
            notify::Config::default(),
        )
        .ok()?;
        watch.watch(self.file.parent()?, notify::RecursiveMode::NonRecursive).ok()?;
        Some(watch)
    }

    fn touch(&self) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let _ = std::fs::write(&self.file, now.to_string());
    }
}

/// Starts the canary on macOS, in a folder of its own -- two processes
/// sharing one would vouch for each other's touches. `on_deaf` re-arms the
/// caller's watches each time the ones opened before a probe turn out to
/// be dead; it returns whether the canary should keep going. `label` begins
/// every line this writes to the log.
pub fn spawn(label: &'static str, folder: PathBuf, mut on_deaf: impl FnMut() -> bool + Send + 'static) {
    if !cfg!(target_os = "macos") {
        return;
    }
    if let Err(e) = std::fs::create_dir_all(&folder) {
        eprintln!("{label}: no watch canary ({}: {e}); a restarted fseventsd will leave file watches deaf", folder.display());
        return;
    }
    // FSEvents reports resolved paths; compare against the same spelling.
    let folder = protocol::canonical_path(&folder).unwrap_or(folder);
    let source = FolderSource { file: folder.join("canary") };
    let spawned = std::thread::Builder::new().name("watch-canary".into()).spawn(move || {
        let mut standing = None;
        loop {
            if probe(&source, &mut standing, HEAR_TIMEOUT) == Verdict::Deaf {
                eprintln!("{label}: file watches stopped hearing events (fseventsd restarted?); re-arming them");
                if !on_deaf() {
                    break;
                }
            }
            std::thread::sleep(PROBE_INTERVAL);
        }
    });
    if let Err(e) = spawned {
        eprintln!("{label}: could not start the watch canary: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Mutex;

    /// Watches that hear every touch until `kill` -- after which every
    /// watch opened BEFORE the kill is deaf and every one opened after
    /// hears, which is what a restarted fseventsd does.
    #[derive(Default)]
    struct Fake {
        watches: Mutex<Vec<(usize, Sender<()>)>>,
        opened: AtomicUsize,
        killed_before: Mutex<Option<usize>>,
        refuse_new: AtomicBool,
        everyone_deaf: AtomicBool,
    }

    impl Fake {
        fn kill(&self) {
            *self.killed_before.lock().unwrap() = Some(self.opened.load(Ordering::SeqCst));
        }
    }

    impl Source for Fake {
        type Watch = ();
        fn watch(&self, heard: Sender<()>) -> Option<()> {
            if self.refuse_new.load(Ordering::SeqCst) {
                return None;
            }
            let n = self.opened.fetch_add(1, Ordering::SeqCst);
            self.watches.lock().unwrap().push((n, heard));
            Some(())
        }
        fn touch(&self) {
            if self.everyone_deaf.load(Ordering::SeqCst) {
                return;
            }
            let dead_below = self.killed_before.lock().unwrap().unwrap_or(0);
            for (n, tx) in self.watches.lock().unwrap().iter() {
                if *n >= dead_below {
                    let _ = tx.send(());
                }
            }
        }
    }

    const QUICK: Duration = Duration::from_millis(50);

    /// The desktop app keeps the same file (see the module doc), and the
    /// two must not drift.
    #[test]
    fn the_desktops_copy_is_this_file() {
        let here = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let ours = std::fs::read_to_string(here.join("src/watch_canary.rs")).unwrap();
        let theirs = std::fs::read_to_string(here.join("../../app/src-tauri/src/watch_canary.rs")).unwrap();
        assert!(ours == theirs, "app/src-tauri/src/watch_canary.rs differs from crates/daemon/src/watch_canary.rs");
    }

    #[test]
    fn a_hearing_canary_vouches_for_its_watches() {
        let fake = Fake::default();
        let mut standing = None;
        assert_eq!(probe(&fake, &mut standing, QUICK), Verdict::Alive, "the first probe only arms");
        assert_eq!(probe(&fake, &mut standing, QUICK), Verdict::Alive);
        assert_eq!(probe(&fake, &mut standing, QUICK), Verdict::Alive);
        assert_eq!(fake.opened.load(Ordering::SeqCst), 1, "a hearing canary is never replaced");
    }

    #[test]
    fn a_restart_reads_as_deaf_once_and_the_fresh_watch_stands() {
        let fake = Fake::default();
        let mut standing = None;
        probe(&fake, &mut standing, QUICK);
        fake.kill();
        assert_eq!(probe(&fake, &mut standing, QUICK), Verdict::Deaf);
        // The watch that proved the restart now stands, and hears.
        assert_eq!(probe(&fake, &mut standing, QUICK), Verdict::Alive);
        assert_eq!(fake.opened.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn events_lost_everywhere_are_not_a_dead_stream() {
        let fake = Fake::default();
        let mut standing = None;
        probe(&fake, &mut standing, QUICK);
        fake.everyone_deaf.store(true, Ordering::SeqCst);
        assert_eq!(probe(&fake, &mut standing, QUICK), Verdict::Silent, "re-arming could not help");
        fake.refuse_new.store(true, Ordering::SeqCst);
        assert_eq!(probe(&fake, &mut standing, QUICK), Verdict::Silent, "nor when no watch can be opened");
    }

    /// A slow standing watch hears its touch only after the timeout; by the
    /// time the fresh one hears the second touch, the first has arrived.
    #[test]
    fn a_late_standing_watch_is_slow_not_deaf() {
        struct Late {
            watches: Mutex<Vec<Sender<()>>>,
            touches: AtomicUsize,
        }
        impl Source for Late {
            type Watch = ();
            fn watch(&self, heard: Sender<()>) -> Option<()> {
                self.watches.lock().unwrap().push(heard);
                Some(())
            }
            fn touch(&self) {
                // The first probe's touch reaches nobody in time; the
                // second reaches everyone, the standing one included.
                if self.touches.fetch_add(1, Ordering::SeqCst) == 0 {
                    return;
                }
                for tx in self.watches.lock().unwrap().iter() {
                    let _ = tx.send(());
                }
            }
        }
        let late = Late { watches: Mutex::new(Vec::new()), touches: AtomicUsize::new(0) };
        let mut standing = None;
        probe(&late, &mut standing, QUICK);
        assert_eq!(probe(&late, &mut standing, QUICK), Verdict::Alive);
    }

    /// The real folder watch hears its own touch. macOS only: elsewhere the
    /// canary never runs.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_folder_canary_hears_its_touch() {
        let dir = tempfile::tempdir().unwrap();
        let folder = protocol::canonical_path(dir.path()).unwrap();
        let source = FolderSource { file: folder.join("canary") };
        let mut standing = None;
        probe(&source, &mut standing, HEAR_TIMEOUT);
        assert!(standing.is_some(), "the canary folder could not be watched");
        assert_eq!(probe(&source, &mut standing, HEAR_TIMEOUT), Verdict::Alive);
    }
}
