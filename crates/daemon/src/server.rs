use protocol::{read_message, write_message, Board, Column, GitStatus, Label, Request, Response, SessionSummary};
use crate::kanban::KanbanStore;
use crate::osc::OscCwdScanner;
use crate::pty::PtySession;
use crate::registry::{Registry, SessionRecord, SessionStatus};
use crate::screen::SessionScreen;
use crate::status::{StatusEvent, StatusScanner, HEURISTIC_QUIET_PERIOD};
use notify_debouncer_mini::Debouncer;
use std::collections::{HashMap, HashSet};
use std::io::{BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use uuid::Uuid;

/// Sent as the exit_code of a Response::SessionExited that isn't really an
/// exit at all -- it's spawn_pump's reader_for failing to find any live
/// process for this session id (no PTY was ever running for it in THIS
/// daemon process). Distinct from the -1 "exit code genuinely unknown"
/// sentinel used elsewhere in this file (see exit_code_for's own callers),
/// so the two different "we don't have a real exit code" cases stay
/// distinguishable in logs/diagnostics even though the frontend doesn't
/// currently branch on the value -- it reuses the exact same
/// SessionExited handling as any other exit either way.
const ATTACH_FAILURE_EXIT_CODE: i32 = -2;

/// How often the heuristic idle-timeout companion thread (see
/// spawn_heuristic_idle_timer) wakes to check whether a session has gone
/// quiet -- granularity of HEURISTIC_QUIET_PERIOD, not a hard
/// real-time guarantee.
const HEURISTIC_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Shared between a session's pump thread and its heuristic idle-timeout
/// companion thread (spawn_heuristic_idle_timer). last_activity,
/// heuristic_working, and running all live behind one lock so a
/// thread's full read-decide-mutate-emit sequence can never interleave
/// with the other thread's -- splitting these across separate atomics
/// let the pump's "bytes arrived" transition and the companion's "gone
/// quiet" transition each act on a stale snapshot of the other,
/// sometimes emitting Idle after Working even though real activity was
/// ongoing (and letting a stale Idle land after teardown). Both threads
/// hold this lock across their persist_and_emit_status call too, so
/// emission order can never contradict decision order.
struct HeuristicState {
    inner: Mutex<HeuristicInner>,
    /// Set true the first time this session's StatusScanner reports any
    /// OSC 133 marker -- once true, the heuristic (both the reactive
    /// "bytes arrived -> working" check in the pump loop below, and the
    /// companion thread's idle-timeout check) permanently stops applying
    /// for this session, per the one-way switching rule. Kept as its
    /// own atomic rather than folded into HeuristicInner: it's
    /// write-once, and every reader is safe seeing a stale `false` by
    /// one instruction, since last_activity is refreshed on every
    /// incoming byte regardless of source.
    seen_osc133: AtomicBool,
}

struct HeuristicInner {
    last_activity: Instant,
    /// True = the heuristic currently considers this session Working.
    heuristic_working: bool,
    /// True once a bare BEL has fired WaitingForInput and nothing has
    /// ended it yet. The companion thread's quiet-period idle check must
    /// not downgrade WaitingForInput to Idle just because output has
    /// also stopped -- that's the expected, common case (the shell IS
    /// quiet because it's waiting on the user), not a signal the wait is
    /// over. Cleared only by renewed output activity, in the same
    /// reactive block that would otherwise re-fire Working.
    waiting_for_input: bool,
    /// Set false right before the pump thread's final Exited update, so
    /// the companion thread stops polling promptly once the session
    /// ends rather than spinning forever on a dead session.
    running: bool,
}

/// How often a repo root's poller re-checks even with no filesystem event
/// and no OSC-133-idle hook firing -- a pure safety net, deliberately
/// sparse. This project's own design history has a cautionary example of
/// getting this wrong: cmux (this project's stated inspiration) originally
/// polled `git status` on a tight ~5-second timer, which touches
/// `.git/index.lock` on every single check and broke other tools watching
/// the same repo (manaflow-ai/cmux#2722) and interfered with users' own
/// concurrent git commands (#4779). At 3 minutes, this backstop carries
/// essentially none of that risk -- the filesystem watch and the
/// OSC-133-idle hook are what actually keep things fresh in practice.
const GIT_STATUS_BACKSTOP_INTERVAL: Duration = Duration::from_secs(180);

/// How long the filesystem watch waits for a burst of related writes (a
/// single git operation, or a single file save, both often touch several
/// paths in quick succession) to settle before firing one recheck, rather
/// than one recheck per individual write event.
const GIT_STATUS_DEBOUNCE: Duration = Duration::from_millis(500);

/// Hard floor on how often a given repo root's `git status` may actually
/// run, across ALL three trigger sources combined. Do not remove this as
/// unnecessary complexity: without it, the filesystem watch alone can
/// out-poll the very design this whole module exists to avoid. The
/// debouncer above flushes roughly once per `GIT_STATUS_DEBOUNCE` for as
/// long as events keep arriving, and its callback runs `trigger_recheck`
/// synchronously -- so sustained churn inside the watched working tree (a
/// `cargo build` writing `target/`, `npm install` writing
/// `node_modules/`, a watch-mode bundler; none of which are excluded from
/// the working-tree watch) would otherwise degenerate into a `git status`
/// every ~500ms for the whole duration of that build. That is a *higher*
/// `.git/index.lock`-touching rate than the ~5-second blind polling loop
/// that caused cmux's manaflow-ai/cmux#2722 and #4779 (other tools
/// watching the same repo broken; users' own concurrent git commands
/// interfered with) -- the exact failure this design's three-trigger
/// structure was chosen to prevent.
///
/// Enforced by *sleeping out* the remainder rather than skipping the
/// check, so the final event of a burst is never silently dropped; every
/// caller of `trigger_recheck` already runs on a thread that is not the
/// PTY pump (the debouncer's own thread, the backstop timer's own thread,
/// and the thread `trigger_recheck_for_session` spawns), so blocking here
/// stalls nothing user-visible.
const MIN_RECHECK_INTERVAL: Duration = Duration::from_secs(5);

/// One shared poller per unique repo root -- not per session. The first
/// session that resolves to a given repo root causes one of these to be
/// created (see `register_session_with_repo`); the last session mapped to
/// it going away tears it down.
struct RepoPoller {
    /// True while a `git status` subprocess for this repo root is
    /// currently running. Lets a trigger that fires while a check is
    /// already in flight simply skip rather than piling up a second,
    /// redundant subprocess -- correctness doesn't require every trigger
    /// to actually run a check (see this task's own doc comment on why),
    /// and the backstop timer guarantees eventual freshness regardless.
    checking: AtomicBool,
    /// The session ids currently mapped to this repo root, and the most
    /// recently observed status -- read and written together whenever a
    /// check completes, so both live behind one lock.
    inner: Mutex<RepoPollerInner>,
    /// Kept alive for as long as this poller exists; dropping it
    /// unregisters the filesystem watch. `None` only in the brief window
    /// during poller construction before the watch is set up (or if
    /// setting it up failed -- watch failure degrades to "no filesystem
    /// trigger for this repo root," not a hard error, since the
    /// OSC-133-idle hook and the backstop timer still work either way).
    debouncer: Mutex<Option<Debouncer<notify::RecommendedWatcher>>>,
}

struct RepoPollerInner {
    mapped_sessions: HashSet<String>,
    last_status: Option<GitStatus>,
    /// When a `git status` for this repo root last actually ran (whatever
    /// its result, and whether or not the result differed from the
    /// previous one) -- the basis for MIN_RECHECK_INTERVAL's floor.
    /// `None` until the very first check completes, so a brand-new
    /// poller's first check never waits.
    last_checked: Option<Instant>,
}

/// Persists a status transition and, if a client is currently attached,
/// relays it live via Response::StatusChanged -- the same
/// persist-then-relay shape spawn_pump's existing cwd handling already
/// uses for Response::CwdChanged, factored out here since this plan adds
/// three separate call sites for it (OSC 133 events, bare-BEL events, and
/// the heuristic timer).
fn persist_and_emit_status(manager: &Arc<SessionManager>, id: &str, status: SessionStatus) {
    let status_str = status.as_str();
    if let Err(e) = manager.registry.lock().unwrap().update_status(id, status) {
        eprintln!("failed to persist status for session {id}: {e}");
    }
    let target = manager.attached_writers.lock().unwrap().get(id).cloned();
    if let Some(w) = target {
        let _ = write_message(
            &mut *w.lock().unwrap(),
            &Response::StatusChanged { id: id.to_string(), status: status_str.to_string() },
        );
    }
}

/// Spawned once per session pump (see spawn_pump), alongside it. Polls
/// `heuristic.inner` every HEURISTIC_POLL_INTERVAL; once
/// HEURISTIC_QUIET_PERIOD has elapsed with no new output AND this session
/// has never seen a valid OSC 133 marker, fires an Idle transition.
/// Exits promptly once the session either switches permanently to
/// OSC-133-only detection (seen_osc133) or ends (running set false).
fn spawn_heuristic_idle_timer(manager: &Arc<SessionManager>, id: String, heuristic: Arc<HeuristicState>) {
    let manager = Arc::clone(manager);
    std::thread::spawn(move || loop {
        std::thread::sleep(HEURISTIC_POLL_INTERVAL);
        if heuristic.seen_osc133.load(Ordering::SeqCst) {
            // Permanently switched to OSC-133-only detection -- nothing
            // left for this thread to ever do for this session again.
            return;
        }
        let mut inner = heuristic.inner.lock().unwrap();
        if !inner.running {
            return;
        }
        if !inner.heuristic_working || inner.waiting_for_input {
            // Already considered idle, or currently waiting for input --
            // waiting_for_input can only be cleared by renewed output
            // activity (handled in the pump loop's reactive check) or a
            // permanent switch to OSC-133-only detection; a quiet period
            // alone must never silently downgrade it to idle.
            continue;
        }
        if inner.last_activity.elapsed() >= HEURISTIC_QUIET_PERIOD {
            inner.heuristic_working = false;
            // Emitted while still holding `inner` so this can never be
            // reordered relative to a concurrent pump-thread decision.
            persist_and_emit_status(&manager, &id, SessionStatus::Idle);
        }
    });
}

/// Called whenever a session's cwd is newly known or changes: resolves
/// the repo root for the new cwd and updates this session's mapping,
/// unregistering it from its previous root (if any -- tearing that
/// root's poller down if this was the last session mapped to it) and
/// registering it with the new one (spawning a poller if this is the
/// first session ever mapped to that root). A cwd that resolves to the
/// same root as before is a no-op -- the common case, since most PTY
/// output containing a cwd report doesn't actually change which repo the
/// session is in.
///
/// Runs `resolve_repo_root` synchronously (a cheap `git rev-parse` call,
/// tolerated inline the same way the existing synchronous SQLite
/// `update_cwd` write already is in this same loop) -- but never runs
/// `run_git_status` itself inline; see `register_session_with_repo`.
///
/// On any real transition, notifies this session's own attached client
/// with a `Response::GitStatusChanged` carrying the new root's cached
/// status (or `None`, when the session is no longer in a repo at all) --
/// see the comment at the bottom of the body for why that notification
/// can't come from anywhere else.
fn update_session_repo_mapping(manager: &Arc<SessionManager>, id: &str, cwd: &str) {
    let new_root = crate::git_status::resolve_repo_root(cwd);

    // Held across the whole read-decide-mutate-register/unregister
    // sequence below (not just the map update) so this function is
    // atomic per session id -- `register_session_with_repo`/
    // `unregister_session_from_repo` never touch `session_repo_root`
    // themselves, so this can't deadlock, and without it two concurrent
    // callers for the same session (as Task 5's `attach()` call site
    // will introduce alongside this one) could interleave their
    // mapped_sessions add/remove out of order relative to this map's
    // own final state.
    let mut map = manager.session_repo_root.lock().unwrap();
    let old_root = map.get(id).cloned();
    if old_root == new_root {
        return;
    }
    match &new_root {
        Some(root) => map.insert(id.to_string(), root.clone()),
        None => map.remove(id),
    };

    if let Some(old) = &old_root {
        unregister_session_from_repo(manager, id, old);
    }
    if let Some(new) = &new_root {
        register_session_with_repo(manager, id, new);
    }

    // Dropped explicitly here, before the lookup + blocking write below --
    // holding it through register/unregister above is deliberate (see the
    // comment on its acquisition), and safe because neither of those ever
    // touches `session_repo_root` itself; it must not be held any further
    // than this, matching this file's rule of never holding a lock across
    // blocking I/O.
    drop(map);

    // Without this, a session that LEAVES a repo (cd'd out entirely, or
    // moved to a different one) would never get another GitStatusChanged
    // after this point: `trigger_recheck` only emits to sessions still
    // present in *that* poller's `mapped_sessions`, and this session
    // either has no mapping at all now (`new_root` is None) or is mapped
    // to a poller it was not registered with until a moment ago. That
    // would leave the frontend showing the previous repo's last-known
    // status forever, with no event able to clear it -- and `Option`
    // exists on this event's payload precisely so `None` can say "not in
    // a repo".
    //
    // Sent unconditionally, including `status: None` -- unlike attach()'s
    // baseline block, which only sends when it has something (silence
    // there is a valid "nothing known yet"). This one is a *change*
    // notification for a mapping that just transitioned, so the client
    // genuinely needs to hear it even when the new state is "no repo".
    let new_status = new_root.as_ref().and_then(|root| {
        manager
            .repo_pollers
            .lock()
            .unwrap()
            .get(root)
            .and_then(|poller| poller.inner.lock().unwrap().last_status.clone())
    });
    let target = manager.attached_writers.lock().unwrap().get(id).cloned();
    if let Some(w) = target {
        let _ = write_message(
            &mut *w.lock().unwrap(),
            &Response::GitStatusChanged { id: id.to_string(), status: new_status },
        );
    }
}

/// Registers `id` as mapped to `repo_root`, spawning a new poller for
/// that root first if none exists yet. The poller's own setup (the
/// filesystem watch, the backstop timer, and its first check) all happen
/// on a dedicated background thread -- never inline here -- so a
/// session's first `cd` into a brand-new repo can never block whatever
/// caller triggered this (the `spawn_pump` PTY-reading loop, or
/// `attach()`'s baseline logic in Task 5) on a `git status` subprocess.
fn register_session_with_repo(manager: &Arc<SessionManager>, id: &str, repo_root: &str) {
    let mut pollers = manager.repo_pollers.lock().unwrap();
    if let Some(existing) = pollers.get(repo_root) {
        // An existing poller was constructed for some *other*, earlier
        // session, so this one still has to be added separately.
        existing.inner.lock().unwrap().mapped_sessions.insert(id.to_string());
        return;
    }
    // `mapped_sessions` is seeded with this session id at construction
    // rather than inserted afterward: the thread spawned just below runs
    // its own first `trigger_recheck` immediately, and if that won the
    // race against a separate follow-up insert it would emit to an empty
    // mapped-sessions set, so the very session that caused this poller to
    // exist would miss the first result (delayed to the next fs-watch /
    // OSC-133-idle / backstop trigger -- avoidable, so avoided).
    let poller = Arc::new(RepoPoller {
        checking: AtomicBool::new(false),
        inner: Mutex::new(RepoPollerInner {
            mapped_sessions: HashSet::from([id.to_string()]),
            last_status: None,
            last_checked: None,
        }),
        debouncer: Mutex::new(None),
    });
    pollers.insert(repo_root.to_string(), Arc::clone(&poller));
    let manager = Arc::clone(manager);
    let repo_root = repo_root.to_string();
    std::thread::spawn(move || spawn_repo_poller(&manager, repo_root, poller));
}

/// Unregisters `id` from `repo_root`'s mapped-sessions set, tearing the
/// poller down entirely (dropping its `Arc`, which drops its debouncer
/// and therefore unregisters the filesystem watch) if that was the last
/// session mapped to it.
fn unregister_session_from_repo(manager: &Arc<SessionManager>, id: &str, repo_root: &str) {
    let mut pollers = manager.repo_pollers.lock().unwrap();
    let Some(poller) = pollers.get(repo_root) else { return };
    let now_empty = {
        let mut inner = poller.inner.lock().unwrap();
        inner.mapped_sessions.remove(id);
        inner.mapped_sessions.is_empty()
    };
    if now_empty {
        pollers.remove(repo_root);
    }
}

/// Removes `id` from whatever repo root it was mapped to, if any --
/// called from `spawn_pump`'s teardown when a session exits, mirroring
/// how `attached_writers`/`heuristic` are also cleaned up there.
fn unregister_session_repo_mapping(manager: &Arc<SessionManager>, id: &str) {
    // Held across the whole remove+unregister sequence (not just the map
    // update), mirroring update_session_repo_mapping's own fix -- this
    // function's only caller (spawn_pump's session-exit teardown) can now
    // race a concurrent attach() call to update_session_repo_mapping for
    // the same session id, and without this the two could interleave and
    // leave session_repo_root inconsistent with the poller's own
    // mapped_sessions bookkeeping.
    let mut map = manager.session_repo_root.lock().unwrap();
    let old_root = map.remove(id);
    if let Some(root) = old_root {
        unregister_session_from_repo(manager, id, &root);
    }
}

/// Sets up a newly-created repo root's poller: the filesystem watch, the
/// backstop timer thread, and one immediate check so a fresh poller
/// doesn't wait for either to produce its first result. Always runs on
/// its own dedicated thread (spawned by `register_session_with_repo`),
/// never inline on a caller's thread.
fn spawn_repo_poller(manager: &Arc<SessionManager>, repo_root: String, poller: Arc<RepoPoller>) {
    setup_filesystem_watch(manager, &repo_root, &poller);

    {
        let manager = Arc::clone(manager);
        let repo_root = repo_root.clone();
        let poller = Arc::clone(&poller);
        std::thread::spawn(move || loop {
            std::thread::sleep(GIT_STATUS_BACKSTOP_INTERVAL);
            // Checks THIS poller instance's own liveness (zero mapped
            // sessions), not whether the shared map still has an entry
            // under `repo_root` -- that key could since have been
            // reassigned to an unrelated, newer `RepoPoller` (a session
            // left, then a different session entered the same repo
            // root before this thread's next wake), in which case
            // `contains_key` would stay true forever and this thread
            // would loop on its own orphaned poller indefinitely.
            if poller.inner.lock().unwrap().mapped_sessions.is_empty() {
                return; // this poller was torn down; stop looping
            }
            trigger_recheck(&manager, &repo_root, &poller);
        });
    }

    trigger_recheck(manager, &repo_root, &poller);
}

/// Sets up the filesystem-watch trigger for one repo root: git's own
/// internal state files (HEAD, index, refs -- covers commits, checkouts,
/// and staging), plus the working tree itself (covers plain file
/// edits/new files, which touch none of those three -- the single most
/// common way a repo becomes dirty). Watching `.git/` broadly (via a
/// naive single recursive watch on the whole repo root) is deliberately
/// avoided: `.git/objects/` alone can hold many thousands of loose
/// object files in an active repo, and recursively watching all of them
/// wastes OS-level watch resources for no benefit (on Linux, this can
/// exhaust `inotify`'s system-wide watch-count limit for a large repo) --
/// so the working-tree watch enumerates `repo_root`'s existing top-level
/// entries once at setup time, skips `.git` specifically, and watches
/// each remaining entry recursively, plus `repo_root` itself
/// non-recursively (to notice new/deleted top-level entries). A known,
/// accepted limitation: a file created deep inside a *brand-new*
/// top-level directory (created after this poller started) won't be
/// watched until something else triggers a fresh check for this root --
/// the 3-minute backstop timer always eventually does.
fn setup_filesystem_watch(manager: &Arc<SessionManager>, repo_root: &str, poller: &Arc<RepoPoller>) {
    let manager = Arc::clone(manager);
    let repo_root_owned = repo_root.to_string();
    // A `Weak` reference, not a strong `Arc::clone` -- this callback lives
    // inside the `Debouncer` we're about to store in `poller.debouncer`,
    // so a strong clone here would create a genuine reference cycle
    // (`poller.debouncer` -> `Debouncer` -> this closure -> strong
    // `Arc<RepoPoller>` -> back to `poller.debouncer`) that would keep
    // `RepoPoller`'s strong count above zero forever, so `Drop` (the only
    // thing that sends the `Debouncer`'s internal `Shutdown` signal) would
    // never run, leaking its background thread, its `RecommendedWatcher`,
    // and every OS-level watch it holds for the daemon's entire remaining
    // lifetime -- an orphaned watch that keeps firing `git status` forever
    // for a repo no session cares about anymore, exactly the cmux #2722
    // `.git/index.lock` contention bug this whole design exists to avoid.
    let poller_for_callback = Arc::downgrade(poller);
    let debounce_result = notify_debouncer_mini::new_debouncer(
        GIT_STATUS_DEBOUNCE,
        move |res: notify_debouncer_mini::DebounceEventResult| {
            if res.is_ok() {
                // If this fires after teardown has begun (the poller's
                // last strong `Arc` was already dropped), `.upgrade()`
                // returns `None` and this is a silent no-op -- correct,
                // since there's nothing left to recheck.
                if let Some(poller) = poller_for_callback.upgrade() {
                    trigger_recheck(&manager, &repo_root_owned, &poller);
                }
            }
        },
    );
    let Ok(mut debouncer) = debounce_result else {
        // Watch setup failed entirely (e.g. a permissions issue) -- the
        // OSC-133-idle hook and the backstop timer still work, so this
        // repo root degrades to "less responsive," not "broken."
        return;
    };

    let git_dir = std::path::Path::new(repo_root).join(".git");
    // A NonRecursive watch on the `.git` directory itself, not on
    // `.git/HEAD` / `.git/index` individually: git replaces both files via
    // lockfile-plus-rename (`index.lock` renamed over `index`, and the
    // same pattern for HEAD on many checkout paths), and on Linux
    // `inotify` watches inodes rather than paths -- a rename-over-target
    // orphans the watch on the old, now-unlinked inode, so a per-file
    // watch here would silently stop firing after the very first commit
    // or checkout (macOS's FSEvents backend is directory-granular and
    // unaffected, which is why this never surfaces in local testing).
    // Watching the containing directory NonRecursively catches
    // HEAD/index/ORIG_HEAD/MERGE_HEAD etc. being replaced regardless of
    // how git swaps them in, and still never recurses into
    // `.git/objects/` -- preserving this design's original intent.
    let _ = debouncer.watcher().watch(&git_dir, notify::RecursiveMode::NonRecursive);
    // refs is a directory tree (refs/heads/<branch>, etc.) -- a new
    // branch or commit can create files nested under it, so this one
    // specifically still needs its own Recursive watch; the NonRecursive
    // watch on `.git` above only sees `refs/` itself being replaced, not
    // files nested inside it.
    let _ = debouncer.watcher().watch(&git_dir.join("refs"), notify::RecursiveMode::Recursive);

    // repo_root itself, non-recursively, to notice new/deleted top-level
    // entries (including a freshly re-created .git, in the rare case
    // this directory stops being a repo entirely).
    let _ = debouncer.watcher().watch(std::path::Path::new(repo_root), notify::RecursiveMode::NonRecursive);
    if let Ok(entries) = std::fs::read_dir(repo_root) {
        for entry in entries.flatten() {
            if entry.file_name() == ".git" {
                continue;
            }
            let _ = debouncer.watcher().watch(&entry.path(), notify::RecursiveMode::Recursive);
        }
    }

    *poller.debouncer.lock().unwrap() = Some(debouncer);
}

/// Shared by all three trigger sources (filesystem watch, backstop timer,
/// and the reactive OSC-133-idle hook in `spawn_pump`). Runs at most one
/// `git status` at a time per repo root (via `checking`) and no more often
/// than MIN_RECHECK_INTERVAL (see that constant -- the floor is load-
/// bearing, not incidental), caches the result, and emits
/// `Response::GitStatusChanged` to every session currently mapped to this
/// root that has an attached writer -- but only when the result actually
/// differs from the last one this root produced.
///
/// May block for up to MIN_RECHECK_INTERVAL plus the `git status` timeout;
/// every caller already runs on a thread that is not a session's PTY pump.
fn trigger_recheck(manager: &Arc<SessionManager>, repo_root: &str, poller: &Arc<RepoPoller>) {
    if poller.checking.swap(true, Ordering::SeqCst) {
        return;
    }

    // Sleep out whatever remains of MIN_RECHECK_INTERVAL since this repo
    // root's last actual check, rather than skipping outright -- see that
    // constant's own doc comment for both why the floor exists at all and
    // why waiting (rather than dropping the trigger) is the right shape
    // here. `checking` is already held for the duration, so concurrent
    // triggers still collapse into this one instead of queueing behind it.
    let wait = {
        let inner = poller.inner.lock().unwrap();
        inner.last_checked.map(|t| MIN_RECHECK_INTERVAL.saturating_sub(t.elapsed()))
    };
    if let Some(wait) = wait {
        if !wait.is_zero() {
            std::thread::sleep(wait);
        }
    }

    let status = crate::git_status::run_git_status(repo_root);

    // Emit only on an actual change -- this event is `GitStatusChanged`,
    // not `GitStatusPolled`, and three independent triggers (plus the
    // backstop) would otherwise re-send byte-identical payloads to every
    // mapped session indefinitely. `last_checked`, unlike `last_status`,
    // updates on every check regardless of the outcome: it paces the
    // subprocess, not the event.
    let mapped: Vec<String> = {
        let mut inner = poller.inner.lock().unwrap();
        inner.last_checked = Some(Instant::now());
        if status == inner.last_status {
            Vec::new()
        } else {
            inner.last_status = status.clone();
            inner.mapped_sessions.iter().cloned().collect()
        }
    };
    for id in mapped {
        let target = manager.attached_writers.lock().unwrap().get(&id).cloned();
        if let Some(w) = target {
            let _ = write_message(
                &mut *w.lock().unwrap(),
                &Response::GitStatusChanged { id: id.clone(), status: status.clone() },
            );
        }
    }

    // `checking` stays true for the ENTIRE run-git-status + mutate-inner
    // + emit-to-sessions sequence, not just the subprocess call -- so a
    // second concurrent `trigger_recheck` (fs-watch vs. OSC-133-idle vs.
    // backstop timer can each call this) can't start, finish, and emit
    // its own (possibly staler) result while this call's mutate-and-emit
    // is still in flight, which could otherwise let a fresher result be
    // raced by a staler one's later write.
    poller.checking.store(false, Ordering::SeqCst);
}

/// Piggybacks on the existing OSC-133 idle-marker detection in
/// `spawn_pump`: a fresh shell prompt is a natural moment to recheck
/// git status, at zero additional detection cost (the marker is already
/// being scanned for session-status purposes). Dispatched to its own
/// thread -- never run inline on the pump thread -- since `git status`
/// can take up to `GIT_STATUS_TIMEOUT` in the worst case, and this must
/// never stall PTY output relay. No-ops if this session isn't currently
/// mapped to any repo root.
fn trigger_recheck_for_session(manager: &Arc<SessionManager>, id: &str) {
    let manager = Arc::clone(manager);
    let id = id.to_string();
    std::thread::spawn(move || {
        let root = manager.session_repo_root.lock().unwrap().get(&id).cloned();
        let Some(root) = root else { return };
        let poller = manager.repo_pollers.lock().unwrap().get(&root).cloned();
        let Some(poller) = poller else { return };
        trigger_recheck(&manager, &root, &poller);
    });
}

pub struct SessionManager {
    registry: Mutex<Registry>,
    kanban: Mutex<KanbanStore>,
    orchestration: Mutex<crate::orchestration::OrchestrationStore>,
    sessions: Mutex<HashMap<String, PtySession>>,
    attached_writers: Mutex<HashMap<String, Arc<Mutex<UnixStream>>>>,
    /// What each live session's screen currently IS, so a client that
    /// reconnects can be sent the screen rather than a tail of the bytes that
    /// built it (see `screen.rs`). Each screen is behind its own mutex, held
    /// by the pump across BOTH feeding a chunk in and forwarding that same
    /// chunk on: a snapshot taken between those two steps would contain a
    /// delta the client is about to receive a second time, and a TUI frame
    /// survives a delta applied twice no better than one applied never.
    /// Lock order everywhere is screen -> attached_writers -> writer.
    screens: Mutex<HashMap<String, Arc<Mutex<SessionScreen>>>>,
    /// The daemon's first genuinely *shared* (not per-session) state:
    /// one entry per unique repo root any live session is currently
    /// mapped to. Not persisted -- see this plan's Global Constraints.
    repo_pollers: Mutex<HashMap<String, Arc<RepoPoller>>>,
    /// Each session's current repo root, if any -- the reverse lookup
    /// `update_session_repo_mapping` needs to know what to unregister a
    /// session from when its cwd changes again (or it exits).
    session_repo_root: Mutex<HashMap<String, String>>,
    /// One per workspace with a watched gavin root, keyed by workspace id.
    /// Replaced wholesale on every WatchGavinRoot (idempotent re-watch,
    /// and how a restarted app's fresh connection takes over pushes).
    /// Never persisted, like repo_pollers.
    gavin_watchers: Mutex<HashMap<String, Arc<crate::gavin::GavinWatcher>>>,
}

impl SessionManager {
    pub fn new(
        registry: Registry,
        kanban: KanbanStore,
        orchestration: crate::orchestration::OrchestrationStore,
    ) -> Self {
        Self {
            registry: Mutex::new(registry),
            kanban: Mutex::new(kanban),
            orchestration: Mutex::new(orchestration),
            sessions: Mutex::new(HashMap::new()),
            attached_writers: Mutex::new(HashMap::new()),
            screens: Mutex::new(HashMap::new()),
            repo_pollers: Mutex::new(HashMap::new()),
            session_repo_root: Mutex::new(HashMap::new()),
            gavin_watchers: Mutex::new(HashMap::new()),
        }
    }

    /// Takes the Arc rather than `&self` because the watcher it starts
    /// holds a hook back into the manager. Weak, not Arc: the manager
    /// owns the watcher, and a strong handle here would be the same
    /// reference cycle the debouncer callback already avoids.
    pub fn watch_gavin_root(
        manager: &Arc<Self>,
        workspace_id: &str,
        root_path: &str,
        writer: Arc<Mutex<UnixStream>>,
    ) {
        let weak = Arc::downgrade(manager);
        let hook: crate::gavin::ScanHook = Box::new(move |workspace_id, tree| {
            weak.upgrade()?.recover_moved_card_paths(workspace_id, tree)
        });
        let watcher = crate::gavin::GavinWatcher::start(
            workspace_id.to_string(),
            std::path::PathBuf::from(root_path),
            writer,
            Some(hook),
        );
        // Insert AFTER start: the old watcher (if any) drops here, tearing
        // down its debouncer thread.
        manager.gavin_watchers.lock().unwrap().insert(workspace_id.to_string(), watcher);
    }

    /// Re-keys everything holding the path of a card whose file moved
    /// without the daemon moving it -- an agent running `mv`, a one-time
    /// migration, a hand edit. `follow_card_move` covers the moves the
    /// daemon makes itself; this covers the rest, on the scan that first
    /// sees the file somewhere else. Without it a rail STALLS on a step
    /// whose card is merely finished, because the step reads as "card
    /// file is missing".
    ///
    /// Returns the orchestration to push when something moved: the app
    /// holds its own copy of every step, and a re-key it never hears
    /// about leaves it scheduling against the old path.
    fn recover_moved_card_paths(
        &self,
        workspace_id: &str,
        tree: &protocol::GavinTree,
    ) -> Option<Response> {
        let tracked = self.orchestration.lock().unwrap().step_card_paths(workspace_id).ok()?;
        let moved = crate::gavin::recover_moved_card_paths(tree, &tracked);
        if moved.is_empty() {
            return None;
        }
        // The plain re-key, not follow_card_move: this runs ON the watch
        // thread, and the response below rides the watcher's own writer
        // rather than looking the watcher back up through the map that
        // owns it.
        for (from, to) in &moved {
            self.rename_card_everywhere(from, to);
        }
        Some(Response::OrchestrationChanged {
            workspace_id: workspace_id.to_string(),
            orchestration: self.get_orchestration(workspace_id).ok()?,
        })
    }

    pub fn unwatch_gavin_root(&self, workspace_id: &str) {
        self.gavin_watchers.lock().unwrap().remove(workspace_id);
    }

    pub fn gavin_tree_snapshot(&self, workspace_id: &str) -> Option<protocol::GavinTree> {
        let watcher = self.gavin_watchers.lock().unwrap().get(workspace_id).cloned();
        watcher.map(|w| w.snapshot())
    }

    /// The watched workspace whose root matches `root_path`. Watchers
    /// store canonicalized roots, so the incoming path is canonicalized
    /// before comparison.
    fn find_watcher_by_root(&self, root_path: &str) -> Option<Arc<crate::gavin::GavinWatcher>> {
        let canonical = std::path::Path::new(root_path)
            .canonicalize()
            .unwrap_or_else(|_| std::path::PathBuf::from(root_path));
        self.gavin_watchers
            .lock()
            .unwrap()
            .values()
            .find(|w| w.root_path == canonical)
            .cloned()
    }

    pub fn board_by_root(&self, root_path: &str) -> anyhow::Result<protocol::Board> {
        let watcher = self
            .find_watcher_by_root(root_path)
            .ok_or_else(|| anyhow::anyhow!("workspace not open in gavin"))?;
        self.get_board(&watcher.workspace_id)
    }

    /// D19: spawning requires the workspace to be open (watched) -- an
    /// agent session the human can't see is never allowed. The push rides
    /// the watching connection; the app Attaches, then lands it on the
    /// Agents page (Part 2).
    pub fn spawn_agent_session(
        &self,
        root_path: &str,
        cwd: &str,
        command: &str,
    ) -> anyhow::Result<String> {
        let watcher = self
            .find_watcher_by_root(root_path)
            .ok_or_else(|| anyhow::anyhow!("workspace not open in gavin"))?;
        let id = self.create_session(root_path, cwd, Some(command))?;
        watcher.push_response(&Response::AgentSessionSpawned {
            workspace_id: watcher.workspace_id.clone(),
            session_id: id.clone(),
            cwd: cwd.to_string(),
            command: command.to_string(),
        });
        Ok(id)
    }

    /// An agent naming its own tab. Routed by the session's ATTACHED
    /// connection rather than by a watched root, unlike every other
    /// agent-facing request here: an orchestration agent runs in its
    /// rail's worktree, which is not the workspace root and matches no
    /// watcher -- and the app showing a tab is, by definition, the
    /// connection attached to it. A session this daemon has never heard
    /// of, or one nothing is attached to, is refused: a stale
    /// GAVIN_SESSION_ID must be told, not silently swallowed.
    pub fn name_session(&self, session_id: &str, name: &str) -> anyhow::Result<()> {
        if self.registry.lock().unwrap().get(session_id)?.is_none() {
            anyhow::bail!("no such session: {session_id}");
        }
        // Cloned out of the map first: this file never holds a lock
        // across the blocking write below.
        let target = self.attached_writers.lock().unwrap().get(session_id).cloned();
        let writer = target.ok_or_else(|| anyhow::anyhow!("that session is not open in gavin"))?;
        write_message(
            &mut *writer.lock().unwrap(),
            &Response::SessionNamed {
                session_id: session_id.to_string(),
                name: name.to_string(),
            },
        )?;
        Ok(())
    }

    pub fn create_session(
        &self,
        workspace_path: &str,
        cwd: &str,
        command: Option<&str>,
    ) -> anyhow::Result<String> {
        if !std::path::Path::new(cwd).is_dir() {
            anyhow::bail!("cwd does not exist or is not a directory: {cwd}");
        }

        let id = Uuid::new_v4().to_string();
        let pty = PtySession::spawn(cwd, command, &id)?;

        self.registry.lock().unwrap().insert(&SessionRecord {
            id: id.clone(),
            workspace_path: workspace_path.to_string(),
            cwd: cwd.to_string(),
            command: command.map(|c| c.to_string()),
            status: SessionStatus::Idle,
            restored: false,
            // Stamped by the registry with the lifetime doing the
            // inserting -- this one. See SessionRecord::generation.
            generation: 0,
            interrupted: false,
        })?;

        self.sessions.lock().unwrap().insert(id.clone(), pty);
        Ok(id)
    }

    pub fn list_sessions(&self) -> anyhow::Result<Vec<SessionSummary>> {
        let records = self.registry.lock().unwrap().list()?;
        Ok(records
            .into_iter()
            .map(|r| SessionSummary {
                id: r.id,
                workspace_path: r.workspace_path,
                cwd: r.cwd,
                status: r.status.as_str().to_string(),
                restored: r.restored,
                interrupted: r.interrupted,
            })
            .collect())
    }

    pub fn get_board(&self, workspace_id: &str) -> anyhow::Result<Board> {
        self.kanban.lock().unwrap().get_board(workspace_id)
    }

    pub fn set_board(&self, workspace_id: &str, columns: Vec<Column>, labels: Vec<Label>) -> anyhow::Result<()> {
        self.kanban.lock().unwrap().replace_board(workspace_id, &columns, &labels)
    }

    pub fn get_orchestration(&self, workspace_id: &str) -> anyhow::Result<protocol::Orchestration> {
        self.orchestration.lock().unwrap().get(workspace_id)
    }

    pub fn set_orchestration(
        &self,
        workspace_id: &str,
        rails: Vec<protocol::Rail>,
        conflict_notes: Vec<protocol::ConflictNote>,
    ) -> anyhow::Result<()> {
        // Who is ACTUALLY running, for the running-step guard: a run row
        // is only the app's claim, and one left behind by a session that
        // has since ended must not refuse the write forever. Taken and
        // released before the orchestration lock -- never both at once.
        let live: HashSet<String> = self.sessions.lock().unwrap().keys().cloned().collect();
        // The `?` before the push is deliberate: a refused write (the
        // running-step guard) must not push a plan that was never stored.
        // The lock is released at the end of this statement, which
        // matters -- push_orchestration re-reads through the same mutex.
        self.orchestration
            .lock()
            .unwrap()
            .replace_plan(workspace_id, &rails, &conflict_notes, &live)?;
        self.push_orchestration(workspace_id);
        Ok(())
    }

    pub fn orchestration_by_root(&self, root_path: &str) -> anyhow::Result<protocol::Orchestration> {
        let watcher = self
            .find_watcher_by_root(root_path)
            .ok_or_else(|| anyhow::anyhow!("workspace not open in gavin"))?;
        self.get_orchestration(&watcher.workspace_id)
    }

    pub fn set_orchestration_by_root(
        &self,
        root_path: &str,
        rails: Vec<protocol::Rail>,
        conflict_notes: Vec<protocol::ConflictNote>,
    ) -> anyhow::Result<()> {
        let watcher = self
            .find_watcher_by_root(root_path)
            .ok_or_else(|| anyhow::anyhow!("workspace not open in gavin"))?;
        self.set_orchestration(&watcher.workspace_id, rails, conflict_notes)
    }

    /// Best-effort push of the whole orchestration on the watching app
    /// connection. Silent when the workspace is not watched (a headless
    /// agent with the app closed) or the writer is dead -- the app's next
    /// fetch catches up either way.
    fn push_orchestration(&self, workspace_id: &str) {
        let watcher = self.gavin_watchers.lock().unwrap().get(workspace_id).cloned();
        let Some(watcher) = watcher else { return };
        let Ok(orchestration) = self.get_orchestration(workspace_id) else { return };
        watcher.push_response(&protocol::Response::OrchestrationChanged {
            workspace_id: workspace_id.to_string(),
            orchestration,
        });
    }

    // ---- The tool library ------------------------------------------------
    // Targeted, like link_card_session -- a tool outlives every
    // arrangement that references it, so there is nothing to replace
    // wholesale. No push either: writes originate in the app that is
    // already holding the state.

    pub fn tools(&self, workspace_id: &str) -> anyhow::Result<Vec<protocol::ToolDef>> {
        self.orchestration.lock().unwrap().tools(workspace_id)
    }

    pub fn save_tool(&self, tool: protocol::ToolDef) -> anyhow::Result<()> {
        self.orchestration.lock().unwrap().save_tool(&tool)
    }

    pub fn delete_tool(&self, id: &str) -> anyhow::Result<()> {
        self.orchestration.lock().unwrap().delete_tool(id)
    }

    pub fn group_templates(&self, workspace_id: &str) -> anyhow::Result<Vec<protocol::GroupTemplate>> {
        self.orchestration.lock().unwrap().group_templates(workspace_id)
    }

    pub fn save_group_template(&self, template: protocol::GroupTemplate) -> anyhow::Result<()> {
        self.orchestration.lock().unwrap().save_group_template(&template)
    }

    pub fn delete_group_template(&self, id: &str) -> anyhow::Result<()> {
        self.orchestration.lock().unwrap().delete_group_template(id)
    }

    pub fn tools_by_root(&self, root_path: &str) -> anyhow::Result<Vec<protocol::ToolDef>> {
        let watcher = self
            .find_watcher_by_root(root_path)
            .ok_or_else(|| anyhow::anyhow!("workspace not open in gavin"))?;
        self.tools(&watcher.workspace_id)
    }

    pub fn set_rail_run(
        &self,
        rail_id: &str,
        state: &str,
        current_stage_id: Option<String>,
    ) -> anyhow::Result<()> {
        self.orchestration.lock().unwrap().set_rail_run(rail_id, state, current_stage_id.as_deref())
    }

    pub fn set_step_run(
        &self,
        step_id: &str,
        state: &str,
        session_id: Option<String>,
        reason: Option<String>,
    ) -> anyhow::Result<()> {
        self.orchestration
            .lock()
            .unwrap()
            .set_step_run(step_id, state, session_id.as_deref(), reason.as_deref())
    }

    pub fn link_card_session(
        &self,
        workspace_id: &str,
        path: &str,
        session_id: &str,
        cwd: &str,
        command: Option<&str>,
    ) -> anyhow::Result<()> {
        self.kanban.lock().unwrap().link_card_session(workspace_id, path, session_id, cwd, command)
    }

    pub fn unlink_card_session(&self, workspace_id: &str, path: &str) -> anyhow::Result<()> {
        self.kanban.lock().unwrap().unlink_card_session(workspace_id, path)
    }

    pub fn delete_card_file(&self, path: &str) -> anyhow::Result<()> {
        crate::gavin::delete_card_file(std::path::Path::new(path))?;
        self.kanban.lock().unwrap().unlink_card_session_all(path)
    }

    /// Writes one frontmatter field and returns the card's path
    /// afterwards. A status write can file the card into `plans/done/`
    /// (or bring it back), and two databases key on that path -- so the
    /// re-keying happens here, beside the write, exactly as
    /// `delete_card_file` keeps its unlinking beside the delete.
    pub fn set_plan_field(&self, path: &str, key: &str, value: &str) -> anyhow::Result<String> {
        let moved = crate::gavin::set_plan_field(std::path::Path::new(path), key, value)?;
        Ok(self.follow_card_move(path, moved))
    }

    /// Moves a card into `plans/archive/` and re-keys everything that
    /// holds its path. Same shape as `set_plan_field`'s re-keying, and
    /// for the same reason: a card's path IS its identity in both the
    /// kanban and the orchestration databases, so a move that skipped
    /// this would silently orphan a bound session or a rail step.
    pub fn archive_card(&self, path: &str) -> anyhow::Result<String> {
        let moved = crate::gavin::archive_card(std::path::Path::new(path))?;
        Ok(self.follow_card_move(path, moved))
    }

    /// The inverse; see `archive_card`.
    pub fn unarchive_card(&self, path: &str) -> anyhow::Result<String> {
        let moved = crate::gavin::unarchive_card(std::path::Path::new(path))?;
        Ok(self.follow_card_move(path, moved))
    }

    /// Re-keys a card's session binding and rail steps onto the path it
    /// landed on, and answers which workspaces had a step aimed at it.
    /// Neither failure is worth losing the move over -- the file is
    /// already where it belongs on disk, so a failure is reported and
    /// the move stands.
    fn rename_card_everywhere(&self, from: &str, to: &str) -> Vec<String> {
        if let Err(e) = self.kanban.lock().unwrap().rename_card_path(from, to) {
            eprintln!("card moved to {to} but its session binding didn't follow: {e}");
        }
        let mut orchestration = self.orchestration.lock().unwrap();
        // Read while the steps still spell the old path.
        let affected = orchestration.workspaces_with_card(from).unwrap_or_default();
        if let Err(e) = orchestration.rename_card_path(from, to) {
            eprintln!("card moved to {to} but its rail steps didn't follow: {e}");
        }
        affected
    }

    /// The same re-key, plus telling the app about it, and returning the
    /// path the card landed on.
    ///
    /// The app holds its OWN copy of every step and only ever re-reads
    /// it on mount, so a re-key it never hears about leaves it
    /// scheduling against a path with no file behind it -- the very
    /// stall this re-keying exists to prevent.
    fn follow_card_move(&self, from: &str, to: std::path::PathBuf) -> String {
        let to = to.to_string_lossy().to_string();
        if to != from {
            for workspace_id in self.rename_card_everywhere(from, &to) {
                self.push_orchestration(&workspace_id);
            }
        }
        to
    }

    pub fn delete_board(&self, workspace_id: &str) -> anyhow::Result<()> {
        self.kanban.lock().unwrap().delete_board(workspace_id)
    }

    pub fn write_input(&self, id: &str, data: &[u8]) -> anyhow::Result<()> {
        let writer = {
            let sessions = self.sessions.lock().unwrap();
            let session = sessions
                .get(id)
                .ok_or_else(|| anyhow::anyhow!("unknown session: {id}"))?;
            session.writer_handle()
        };
        writer.lock().unwrap().write_all(data)?;
        if let Err(e) = self.registry.lock().unwrap().clear_restored(id) {
            eprintln!("failed to clear restored flag for session {id}: {e}");
        }
        Ok(())
    }

    pub fn resize_session(&self, id: &str, cols: u16, rows: u16) -> anyhow::Result<()> {
        {
            let sessions = self.sessions.lock().unwrap();
            let session = sessions
                .get(id)
                .ok_or_else(|| anyhow::anyhow!("unknown session: {id}"))?;
            session.resize(cols, rows)?;
        }
        // The screen model has to follow the PTY, or a snapshot is rendered at
        // a size the session itself stopped believing in -- and the client that
        // asked for it is the one that just changed the size.
        //
        // This runs on a connection's request loop and can wait on a lock the
        // pump holds across a socket write, which reads like the stall this
        // file works hard to avoid. It is bounded by the same condition that
        // already bounds the pump: the pump's write goes to
        // `attached_writers[id]` -- the very connection resizes arrive on --
        // and a client drains that direction from its own reader thread. A
        // client that stopped draining has already stopped receiving output,
        // so there is nothing left for a resize to be late for.
        if let Some(screen) = self.screens.lock().unwrap().get(id) {
            screen.lock().unwrap().set_size(rows, cols);
        }
        Ok(())
    }

    pub fn kill_session(&self, id: &str) -> anyhow::Result<()> {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.get_mut(id) {
            session.kill()?;
        }
        self.registry.lock().unwrap().remove(id)?;
        sessions.remove(id);
        Ok(())
    }

    pub fn reader_for(&self, id: &str) -> anyhow::Result<Box<dyn std::io::Read + Send>> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("unknown session: {id}"))?;
        session.reader()
    }

    pub fn exit_code_for(&self, id: &str) -> anyhow::Result<Option<i32>> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(id)
            .ok_or_else(|| anyhow::anyhow!("unknown session: {id}"))?;
        session.try_wait()
    }

    /// Where a recovered session should come back: its own `cwd` when that
    /// still exists, else the workspace root, else nowhere.
    ///
    /// `create_session` has always spawned in `cwd` while `recover` spawned in
    /// `workspace_path`, and the app happens to pass the same value for both --
    /// so recovery landed in the right directory by coincidence. `Attach`
    /// reports `record.cwd` either way, which is what a session that had cd'd
    /// somewhere else would have contradicted.
    fn recovery_cwd(record: &SessionRecord) -> Option<&str> {
        for candidate in [record.cwd.as_str(), record.workspace_path.as_str()] {
            if std::path::Path::new(candidate).is_dir() {
                return Some(candidate);
            }
        }
        None
    }

    /// Brings a previous daemon lifetime's sessions back.
    ///
    /// Two rules, and both of them are about what recovery must NOT
    /// pretend to be:
    ///
    /// **A row this process inherited is not one it is hosting.** Every
    /// row here is stamped with the lifetime that created it
    /// (`Registry::open`), and a row below the current generation belongs
    /// to a daemon that is gone -- along with every PTY master it held.
    /// A row AT the current generation is one this very process created,
    /// so it is left completely alone: recovery is for the inherited
    /// ones. (In practice `recover` runs once, before the socket is
    /// bound, so there are none -- the guard states the invariant rather
    /// than defending against a caller.)
    ///
    /// **A command is not a shell.** For a plain terminal session
    /// `record.command` is `None` and recovery is what it always was: the
    /// user's shell, in the same directory. For every agent gavin starts
    /// the command IS the task -- `buildRunCommand` bakes the whole
    /// prompt into it -- so re-running it does not resume anything, it
    /// starts a SECOND from-scratch attempt in a checkout that already
    /// carries the first attempt's edits. Worse, the first attempt may
    /// still be running: the old daemon's death only reaches its children
    /// as the SIGHUP a closing PTY master sends, and a child that ignores
    /// it survives, reparented to init (verified under a temp $HOME). Two
    /// agents editing one worktree is the worst outcome in this family,
    /// and it sits behind the "Restart daemon" button the app tells
    /// people to press. So the command is dropped and the session comes
    /// back as a bare shell in the same cwd -- the "fresh shell" the PRD
    /// already promises after a device restart -- with the row marked
    /// `interrupted` so every surface bound to that session id can say
    /// what happened. Reattaching to the real process, or resuming the
    /// agent's conversation, stays out of scope.
    ///
    /// The cwd is `record.cwd`, not `record.workspace_path`: cwd is where
    /// the session actually was (OSC 7 keeps it current) and the one
    /// `Attach` reports back. `workspace_path` is the fallback for a cwd
    /// that has since been deleted -- losing a session because the human
    /// removed a directory they had cd'd into would be a worse answer
    /// than putting them back at the workspace root.
    pub fn recover(&self) -> anyhow::Result<()> {
        let generation = self.registry.lock().unwrap().generation();
        let records = self.registry.lock().unwrap().list()?;
        let mut sessions = self.sessions.lock().unwrap();
        for record in records {
            if record.status == SessionStatus::Exited {
                continue;
            }
            if record.generation >= generation {
                continue;
            }
            let Some(cwd) = Self::recovery_cwd(&record) else {
                eprintln!(
                    "skipping recovery of session {} — neither its cwd ({}) nor its workspace_path ({}) exists",
                    record.id, record.cwd, record.workspace_path
                );
                if let Err(e) = self.registry.lock().unwrap().update_status(&record.id, SessionStatus::Exited) {
                    eprintln!("failed to mark session {} exited: {e}", record.id);
                }
                continue;
            };
            // A row that carried a command was running a TASK, and the
            // task is what recovery refuses to repeat.
            let interrupted = record.command.is_some();
            // `None` unconditionally -- a bare shell is what recovery
            // gives every session now. For a plain terminal one that is
            // byte-for-byte what it always did (its command was already
            // None); for an agent one it is the whole fix.
            //
            // Matched rather than `?`d: a single bad leftover record
            // (e.g. its directory is no longer enterable) must not abort
            // recovery of every session after it in the list.
            match PtySession::spawn(cwd, None, &record.id) {
                Ok(pty) => {
                    sessions.insert(record.id.clone(), pty);
                    let registry = self.registry.lock().unwrap();
                    if let Err(e) = registry.mark_restored(&record.id) {
                        eprintln!("failed to mark session {} restored: {e}", record.id);
                    }
                    if interrupted {
                        if let Err(e) = registry.mark_interrupted(&record.id) {
                            eprintln!("failed to mark session {} interrupted: {e}", record.id);
                        }
                        // The stored status describes the agent that was
                        // working, and what is here now is a shell
                        // sitting at a prompt. Attach replays this value
                        // as its baseline, so leaving it would paint a
                        // "working" dot over a session doing nothing --
                        // the same lie in a second place. A plain
                        // terminal session keeps its status untouched:
                        // its recovery is unchanged, and its next prompt
                        // corrects it anyway.
                        if let Err(e) = registry.update_status(&record.id, SessionStatus::Idle) {
                            eprintln!("failed to reset status for session {}: {e}", record.id);
                        }
                    }
                }
                Err(e) => {
                    eprintln!("failed to recover session {} (cwd {cwd}): {e}", record.id);
                    if let Err(e) = self.registry.lock().unwrap().update_status(&record.id, SessionStatus::Exited) {
                        eprintln!("failed to mark session {} exited: {e}", record.id);
                    }
                }
            }
        }
        Ok(())
    }

    pub fn attach(self: &Arc<Self>, id: &str, writer: Arc<Mutex<UnixStream>>) {
        // Send the session's current known cwd immediately, before anything
        // else -- this gives a fresh Attach's frontend an instant baseline
        // (launch directory, or the last OSC-7-reported directory) without
        // needing a separate query command; live updates arrive the same
        // way, via the same CwdChanged variant, as OSC 7 sequences are seen.
        //
        // The lookup is bound to an owned value in its own `let` first,
        // rather than inlined into the `if let` scrutinee below: Rust
        // extends a MutexGuard temporary created in an `if let` condition
        // across the whole body, which would otherwise keep `registry`
        // locked for the blocking write -- violating this file's rule of
        // never holding a lock across blocking I/O.
        // Both baselines (cwd and status) come from the same single
        // registry lookup, extending the existing lock-across-blocking-io
        // rule the comment above this block already established: the
        // lookup is bound to an owned value in its own `let` first,
        // rather than inlined into the `if let` scrutinee, so the
        // MutexGuard temporary doesn't get lifetime-extended across the
        // blocking writes below.
        let baseline_record = self.registry.lock().unwrap().get(id).ok().flatten();
        if let Some(record) = baseline_record {
            let _ = write_message(
                &mut *writer.lock().unwrap(),
                &Response::CwdChanged { id: id.to_string(), cwd: record.cwd.clone() },
            );
            // Sent regardless of status (unlike StatusChanged/git-status
            // just below) -- restored is orthogonal to the session's
            // current status, and an Exited record never reaches this
            // point via a normal attach anyway (Task 1/3 keep it that
            // way), so gating on status here would just be dead code, not
            // a safety requirement. Nothing is sent when restored is
            // false, mirroring GitStatusChanged's own "silence is a valid
            // baseline" convention.
            if record.restored {
                let _ = write_message(
                    &mut *writer.lock().unwrap(),
                    &Response::SessionRestored { id: id.to_string() },
                );
            }
            // Alongside SessionRestored, never instead of it: `restored`
            // is what the ↻ badge and every existing consumer read, and
            // this only ADDS the stronger fact that the command was not
            // re-run. Unlike `restored` it is never cleared, so it keeps
            // being sent on every later Attach -- a card, a rail step or
            // a commit record bound to this session id is still
            // describing work that nothing is doing, and a frontend
            // reload must not lose that.
            if record.interrupted {
                let _ = write_message(
                    &mut *writer.lock().unwrap(),
                    &Response::SessionInterrupted { id: id.to_string() },
                );
            }
            // Git-status mapping/baseline is skipped for Exited sessions
            // too, for the same reason StatusChanged is: there is nothing
            // live to map. Establishing a mapping here would spawn (or
            // join) a repo poller on behalf of a session that may never
            // get a pump thread at all to tear it back down again --
            // specifically after a daemon restart, where recover() skips
            // Exited rows entirely, so `sessions` holds no entry, and the
            // pump's reader_for call would fail outright. (Within one
            // daemon lifetime an exited session still has its `sessions`
            // entry -- only kill_session removes it -- so its pump does
            // spawn, hits EOF immediately, and its normal teardown
            // unregisters correctly.) The pump's error path now also
            // unregisters as a backstop, but this gate keeps the daemon
            // from doing the pointless work in the first place, and
            // attaching to an already-exited session is a supported flow.
            if record.status != SessionStatus::Exited {
                let _ = write_message(
                    &mut *writer.lock().unwrap(),
                    &Response::StatusChanged { id: id.to_string(), status: record.status.as_str().to_string() },
                );
                // Establishes this session's repo mapping even if it never
                // emits a single OSC 7 cwd report (Task 4's own wiring is
                // purely reactive to *live* changes) -- runs synchronously
                // (cheap `git rev-parse`, same tolerance as the existing
                // registry read just above), but never runs `git status`
                // itself inline; see register_session_with_repo's own note.
                update_session_repo_mapping(self, id, &record.cwd);
                let cached_status = {
                    let repo_root = self.session_repo_root.lock().unwrap().get(id).cloned();
                    repo_root.and_then(|root| {
                        self.repo_pollers
                            .lock()
                            .unwrap()
                            .get(&root)
                            .and_then(|poller| poller.inner.lock().unwrap().last_status.clone())
                    })
                };
                if let Some(status) = cached_status {
                    let _ = write_message(
                        &mut *writer.lock().unwrap(),
                        &Response::GitStatusChanged { id: id.to_string(), status: Some(status) },
                    );
                }
            }
        }

        // Restore the screen BEFORE registering the writer, so a
        // concurrently-running pump thread (this session may already be
        // attached elsewhere) can't interleave live output ahead of it.
        self.write_snapshot(id, &writer);

        let already_running = {
            let mut writers = self.attached_writers.lock().unwrap();
            let existed = writers.contains_key(id);
            writers.insert(id.to_string(), writer);
            existed
        };
        if !already_running {
            self.spawn_pump(id.to_string());
        }
    }

    /// This session's screen (creating it on first use), so both the pump and
    /// a snapshot request work through the same mutex.
    fn screen_for(&self, id: &str) -> Arc<Mutex<SessionScreen>> {
        Arc::clone(
            self.screens
                .lock()
                .unwrap()
                .entry(id.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(SessionScreen::new()))),
        )
    }

    /// Sends `writer` a byte stream that reproduces this session's screen in a
    /// terminal that has seen none of its output.
    ///
    /// Nothing is sent for a session with no screen -- one that has never had
    /// a pump, so has produced nothing to restore -- rather than a bare
    /// clear-screen, which would blank a terminal for no reason.
    ///
    /// The render and the write both happen under the screen's own lock, which
    /// is the lock the pump holds across feed-then-forward: that is what makes
    /// "the screen as of exactly the last chunk this client was sent" a
    /// meaningful thing to say.
    pub fn write_snapshot(&self, id: &str, writer: &Arc<Mutex<UnixStream>>) {
        let screen = { self.screens.lock().unwrap().get(id).cloned() };
        let Some(screen) = screen else { return };
        let mut screen = screen.lock().unwrap();
        let data = String::from_utf8_lossy(&screen.snapshot()).into_owned();
        let _ = write_message(
            &mut *writer.lock().unwrap(),
            &Response::Output { id: id.to_string(), data },
        );
    }

    fn spawn_pump(self: &Arc<Self>, id: String) {
        let manager = Arc::clone(self);
        std::thread::spawn(move || {
            let mut reader = match manager.reader_for(&id) {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("attach failed for session {id}: {e}");
                    // Atomically take-and-remove in one lock acquisition. Getting the
                    // writer and removing the entry as two separate lock acquisitions
                    // would leave a window where a concurrent Attach for this same id
                    // registers a new writer in between — and this cleanup would then
                    // delete that fresh registration, stranding the new client with no
                    // pump thread ever spawned for it again. `.remove()` returns
                    // whatever is currently registered (possibly a writer from a
                    // concurrent Attach that raced in first), so the right writer
                    // always gets notified no matter how the race lands.
                    manager.screens.lock().unwrap().remove(&id);
                    let removed = manager.attached_writers.lock().unwrap().remove(&id);
                    if let Some(w) = removed {
                        let _ = write_message(
                            &mut *w.lock().unwrap(),
                            &Response::SessionExited { id: id.clone(), exit_code: ATTACH_FAILURE_EXIT_CODE },
                        );
                    }
                    if let Err(e) = manager.registry.lock().unwrap().update_status(&id, SessionStatus::Exited) {
                        eprintln!("failed to mark session {id} exited after a failed attach: {e}");
                    }
                    // The normal teardown at the bottom of this thread is
                    // unreachable from here, so the repo mapping attach()
                    // just established (it runs
                    // update_session_repo_mapping before spawning this
                    // thread) would otherwise leak -- along with the repo
                    // poller, its filesystem watch, and its 3-minute
                    // backstop thread, permanently, once per attach.
                    // Reachable with no race at all: any registry row at
                    // a non-Exited status whose `sessions` entry is
                    // missing -- what a failed recovery spawn leaves
                    // behind -- passes attach()'s Exited gate, yet
                    // reader_for above fails.
                    unregister_session_repo_mapping(&manager, &id);
                    return;
                }
            };

            let mut buf = [0u8; 4096];
            let screen = manager.screen_for(&id);
            // Bytes read but not yet forwarded because they end mid-way
            // through a multi-byte UTF-8 character — carried to the next
            // read instead of being lossily corrupted at the chunk boundary.
            let mut pending: Vec<u8> = Vec::new();
            let mut osc_scanner = OscCwdScanner::new();
            let mut status_scanner = StatusScanner::new();
            // The last cwd this session reported via OSC 7, used purely to
            // skip a redundant `update_session_repo_mapping` (and with it
            // the `git rev-parse` subprocess fork inside it) when the
            // reported directory hasn't actually changed -- standard shell
            // integrations emit OSC 7 on EVERY prompt, not just on `cd`,
            // and OscCwdScanner deliberately reports every one of them.
            // Session-local and single-threaded (only this session's own
            // pump thread reads or writes it), so unlike
            // `session_repo_root` it needs no place in SessionManager.
            let mut last_cwd_seen: Option<String> = None;
            let heuristic = Arc::new(HeuristicState {
                inner: Mutex::new(HeuristicInner {
                    last_activity: Instant::now(),
                    heuristic_working: false, // sessions start Idle
                    waiting_for_input: false,
                    running: true,
                }),
                seen_osc133: AtomicBool::new(false),
            });
            spawn_heuristic_idle_timer(&manager, id.clone(), Arc::clone(&heuristic));

            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        // Raw bytes, never the decoded String assembled below:
                        // the parser is a byte state machine that carries a
                        // partial UTF-8 character across calls itself.
                        //
                        // The guard is taken here and deliberately held for the
                        // whole arm, so it is still held when this same chunk is
                        // forwarded at the bottom. A snapshot rendered in
                        // between would already contain a delta the client is
                        // then sent again, and a TUI frame survives a delta
                        // applied twice no better than one applied never.
                        //
                        // This is the one exception to the rule elsewhere in
                        // this file about not holding a lock across blocking
                        // I/O, and it is a narrow one: the lock is per session,
                        // and its only other contender is a snapshot for that
                        // SAME session, which would be writing to the same
                        // socket this write is already blocked on. No other
                        // session, and no shared state, waits behind it.
                        let mut screen = screen.lock().unwrap();
                        screen.feed(&buf[..n]);

                        for cwd in osc_scanner.feed(&buf[..n]) {
                            if let Err(e) = manager.registry.lock().unwrap().update_cwd(&id, &cwd) {
                                eprintln!("failed to persist cwd for session {id}: {e}");
                            }
                            let target = manager.attached_writers.lock().unwrap().get(&id).cloned();
                            if let Some(w) = target {
                                let _ = write_message(
                                    &mut *w.lock().unwrap(),
                                    &Response::CwdChanged { id: id.clone(), cwd: cwd.clone() },
                                );
                            }
                            if last_cwd_seen.as_deref() != Some(cwd.as_str()) {
                                update_session_repo_mapping(&manager, &id, &cwd);
                                last_cwd_seen = Some(cwd.clone());
                            }
                        }

                        {
                            let mut inner = heuristic.inner.lock().unwrap();
                            inner.last_activity = Instant::now();
                            if !heuristic.seen_osc133.load(Ordering::SeqCst)
                                && (!inner.heuristic_working || inner.waiting_for_input)
                            {
                                // Was idle, waiting for input, or never
                                // yet working -- now has fresh output,
                                // fire Working. Emitted while still
                                // holding `inner` so this can never be
                                // reordered relative to a concurrent
                                // companion-thread decision. Renewed
                                // output activity is what ends
                                // waiting_for_input in heuristic mode, so
                                // this also clears that flag.
                                inner.heuristic_working = true;
                                inner.waiting_for_input = false;
                                persist_and_emit_status(&manager, &id, SessionStatus::Working);
                            }
                        }

                        for event in status_scanner.feed(&buf[..n]) {
                            match event {
                                StatusEvent::Idle => {
                                    heuristic.seen_osc133.store(true, Ordering::SeqCst);
                                    persist_and_emit_status(&manager, &id, SessionStatus::Idle);
                                    trigger_recheck_for_session(&manager, &id);
                                }
                                StatusEvent::Working => {
                                    heuristic.seen_osc133.store(true, Ordering::SeqCst);
                                    persist_and_emit_status(&manager, &id, SessionStatus::Working);
                                }
                                StatusEvent::WaitingForInput => {
                                    heuristic.inner.lock().unwrap().waiting_for_input = true;
                                    persist_and_emit_status(&manager, &id, SessionStatus::WaitingForInput);
                                }
                            }
                        }

                        pending.extend_from_slice(&buf[..n]);
                        let (consume_len, force_flush) = match std::str::from_utf8(&pending) {
                            Ok(_) => (pending.len(), false),
                            Err(e) => (e.valid_up_to(), e.error_len().is_some()),
                        };
                        if consume_len == 0 && !force_flush {
                            // Genuinely incomplete multi-byte sequence at the very
                            // end — wait for more bytes instead of corrupting it.
                            continue;
                        }
                        let take = if force_flush { pending.len() } else { consume_len };
                        let data = if force_flush {
                            // Not just incomplete — genuinely invalid bytes. Don't
                            // wait forever for a completion that will never come.
                            String::from_utf8_lossy(&pending[..take]).into_owned()
                        } else {
                            String::from_utf8(pending[..take].to_vec())
                                .expect("consume_len is a valid utf8 boundary")
                        };
                        pending.drain(..take);

                        // No writer currently attached, or a write to it failed
                        // (dead connection): drop this chunk from live forwarding
                        // and keep reading — it's already in the scrollback buffer
                        // above, so a future Attach will still see it.
                        let target = manager.attached_writers.lock().unwrap().get(&id).cloned();
                        if let Some(w) = target {
                            let _ = write_message(&mut *w.lock().unwrap(), &Response::Output { id: id.clone(), data });
                        }
                    }
                    Err(_) => break,
                }
            }

            heuristic.inner.lock().unwrap().running = false;
            unregister_session_repo_mapping(&manager, &id);
            let exit_code = manager.exit_code_for(&id).ok().flatten().unwrap_or(-1);
            if let Err(e) = manager.registry.lock().unwrap().update_status(&id, SessionStatus::Exited) {
                eprintln!("failed to persist exited status for session {id}: {e}");
            }
            // Same atomic take-and-remove as the error path above, and for the same
            // reason: a single `.remove()` call closes the race window a separate
            // get-then-remove would leave open.
            let removed = manager.attached_writers.lock().unwrap().remove(&id);
            if let Some(w) = removed {
                let _ = write_message(&mut *w.lock().unwrap(), &Response::SessionExited { id: id.clone(), exit_code });
            }
            // The screen model is per-session state like the writer above,
            // and this is the one place that runs for BOTH a natural exit and
            // a kill_session (which makes the pump's read return 0). Dropping
            // it here is what stops a session's grid and scrollback -- by far
            // the largest thing the daemon holds per session -- leaking for the
            // daemon's whole lifetime, and also stops a dead session's stale
            // screen being restored to a later Attach.
            manager.screens.lock().unwrap().remove(&id);
        });
    }
}

pub fn handle_request(manager: &SessionManager, req: Request) -> Response {
    let result = match req {
        Request::CreateSession { workspace_path, cwd, command } => manager
            .create_session(&workspace_path, &cwd, command.as_deref())
            .map(|id| Response::SessionCreated { id }),
        Request::ListSessions => manager
            .list_sessions()
            .map(|sessions| Response::SessionList { sessions }),
        Request::WriteInput { id, data } => manager
            .write_input(&id, data.as_bytes())
            .map(|_| Response::Ok),
        Request::ResizeSession { id, cols, rows } => manager
            .resize_session(&id, cols, rows)
            .map(|_| Response::Ok),
        Request::KillSession { id } => manager.kill_session(&id).map(|_| Response::Ok),
        Request::GetBoard { workspace_id } => manager
            .get_board(&workspace_id)
            .map(|board| Response::Board { columns: board.columns, labels: board.labels, card_sessions: board.card_sessions }),
        Request::SetBoard { workspace_id, columns, labels } => manager
            .set_board(&workspace_id, columns, labels)
            .map(|_| Response::Ok),
        Request::DeleteBoard { workspace_id } => manager.delete_board(&workspace_id).map(|_| Response::Ok),
        Request::GetOrchestrationByRoot { root_path } => {
            manager.orchestration_by_root(&root_path).map(|o| Response::Orchestration {
                rails: o.rails,
                conflict_notes: o.conflict_notes,
                rail_runs: o.rail_runs,
                step_runs: o.step_runs,
            })
        }
        Request::SetOrchestrationByRoot { root_path, rails, conflict_notes } => manager
            .set_orchestration_by_root(&root_path, rails, conflict_notes)
            .map(|_| Response::Ok),
        Request::GitDirtyPaths { cwd, limit } => Ok(
            match crate::git_status::dirty_paths(&cwd, limit as usize) {
                Some((paths, truncated)) => Response::DirtyPaths { paths, truncated },
                // Not a repo, or git was too slow: empty evidence, not an
                // error -- one unreadable worktree must not fail the
                // whole gavin_get_orchestration payload.
                None => Response::DirtyPaths { paths: vec![], truncated: false },
            },
        ),
        Request::GetOrchestration { workspace_id } => {
            manager.get_orchestration(&workspace_id).map(|o| Response::Orchestration {
                rails: o.rails,
                conflict_notes: o.conflict_notes,
                rail_runs: o.rail_runs,
                step_runs: o.step_runs,
            })
        }
        Request::SetOrchestration { workspace_id, rails, conflict_notes } => manager
            .set_orchestration(&workspace_id, rails, conflict_notes)
            .map(|_| Response::Ok),
        Request::SetRailRun { rail_id, state, current_stage_id } => manager
            .set_rail_run(&rail_id, &state, current_stage_id)
            .map(|_| Response::Ok),
        Request::SetStepRun { step_id, state, session_id, reason } => manager
            .set_step_run(&step_id, &state, session_id, reason)
            .map(|_| Response::Ok),
        Request::GetTools { workspace_id } => {
            manager.tools(&workspace_id).map(|tools| Response::Tools { tools })
        }
        Request::SaveTool { tool } => manager.save_tool(tool).map(|_| Response::Ok),
        Request::DeleteTool { id } => manager.delete_tool(&id).map(|_| Response::Ok),
        Request::GetToolsByRoot { root_path } => {
            manager.tools_by_root(&root_path).map(|tools| Response::Tools { tools })
        }
        Request::GetGroupTemplates { workspace_id } => manager
            .group_templates(&workspace_id)
            .map(|templates| Response::GroupTemplates { templates }),
        Request::SaveGroupTemplate { template } => {
            manager.save_group_template(template).map(|_| Response::Ok)
        }
        Request::DeleteGroupTemplate { id } => {
            manager.delete_group_template(&id).map(|_| Response::Ok)
        }
        Request::Attach { .. } => unreachable!("Attach is intercepted in handle_connection"),
        Request::Snapshot { .. } => {
            unreachable!("Snapshot is intercepted in handle_connection")
        }
        Request::WatchGavinRoot { .. } => {
            unreachable!("WatchGavinRoot is intercepted in handle_connection")
        }
        Request::UnwatchGavinRoot { workspace_id } => {
            manager.unwatch_gavin_root(&workspace_id);
            Ok(Response::Ok)
        }
        Request::GetGavinTree { workspace_id } => match manager.gavin_tree_snapshot(&workspace_id)
        {
            Some(tree) => Ok(Response::GavinTreeSnapshot { workspace_id, tree }),
            None => Ok(Response::Error {
                message: format!("no gavin root watched for workspace: {workspace_id}"),
            }),
        },
        Request::InitGavinRoot { root_path, workspace_name } => {
            crate::gavin::init_gavin_root(std::path::Path::new(&root_path), &workspace_name)
                .map(|_| Response::Ok)
        }
        Request::CreateGavinContext { parent_folder } => {
            crate::gavin::create_gavin_context(std::path::Path::new(&parent_folder))
                .map(|_| Response::Ok)
        }
        Request::AddExternalGavinContext { root_path, folder } => {
            crate::gavin::add_external_context(
                std::path::Path::new(&root_path),
                std::path::Path::new(&folder),
            )
            .map(|_| Response::Ok)
        }
        Request::RemoveExternalGavinContext { root_path, folder } => {
            crate::gavin::remove_external_context(
                std::path::Path::new(&root_path),
                std::path::Path::new(&folder),
            )
            .map(|_| Response::Ok)
        }
        Request::SetPlanFrontmatterField { path, key, value } => {
            manager.set_plan_field(&path, &key, &value).map(|path| Response::PlanFieldSet { path })
        }
        Request::SetRootConfigField { root_path, key, value } => {
            crate::gavin::set_root_config_field(std::path::Path::new(&root_path), &key, &value)
                .map(|_| Response::Ok)
        }
        Request::ScanGavinRoot { root_path } => Ok(Response::GavinTreeScanned {
            tree: crate::gavin::scan_root(std::path::Path::new(&root_path)),
        }),
        Request::ReadPrd { root_path } => crate::gavin::read_prd(std::path::Path::new(&root_path))
            .map(|content| Response::PrdContent { content }),
        Request::CreatePlan {
            context_folder,
            file_name,
            title,
            status,
            priority,
            body,
            kind,
            parent,
            attachments,
        } => {
            crate::gavin::create_plan_file(
                std::path::Path::new(&context_folder),
                &file_name,
                &title,
                status.as_deref(),
                priority.as_deref(),
                body.as_deref(),
                kind.as_deref(),
                parent.as_deref(),
                attachments.as_deref(),
            )
            .map(|p| Response::PlanCreated { path: p.to_string_lossy().to_string() })
        }
        Request::LinkCardSession { workspace_id, path, session_id, cwd, command } => manager
            .link_card_session(&workspace_id, &path, &session_id, &cwd, command.as_deref())
            .map(|_| Response::Ok),
        Request::UnlinkCardSession { workspace_id, path } => manager
            .unlink_card_session(&workspace_id, &path)
            .map(|_| Response::Ok),
        Request::DeleteCardFile { path } => {
            manager.delete_card_file(&path).map(|_| Response::Ok)
        }
        Request::ArchiveCard { path } => {
            manager.archive_card(&path).map(|path| Response::CardMoved { path })
        }
        Request::UnarchiveCard { path } => {
            manager.unarchive_card(&path).map(|path| Response::CardMoved { path })
        }
        Request::SetChecklistItem { path, line_index, expected_text, checked } => {
            crate::gavin::set_checklist_item(
                std::path::Path::new(&path),
                line_index,
                &expected_text,
                checked,
            )
            .map(|_| Response::Ok)
        }
        Request::PromoteChecklistItem { plan_path, item } => {
            crate::gavin::promote_checklist_item(std::path::Path::new(&plan_path), &item)
                .map(|p| Response::TaskPromoted { path: p.to_string_lossy().to_string() })
        }
        Request::GetProtocolVersion => {
            Ok(Response::ProtocolVersion { version: protocol::PROTOCOL_VERSION })
        }
        Request::GetBoardByRoot { root_path } => manager
            .board_by_root(&root_path)
            .map(|board| Response::Board { columns: board.columns, labels: board.labels, card_sessions: board.card_sessions }),
        Request::SpawnAgentSession { root_path, cwd, command } => manager
            .spawn_agent_session(&root_path, &cwd, &command)
            .map(|id| Response::SessionCreated { id }),
        Request::NameSession { session_id, name } => {
            manager.name_session(&session_id, &name).map(|_| Response::Ok)
        }
        // handle_connection intercepts Shutdown first (mirroring
        // Attach/WatchGavinRoot) so it can reply and then exit the process.
        // This arm only exists so the match stays exhaustive; it is never
        // expected to fire.
        Request::Shutdown => Ok(Response::Ok),
        // A client newer than this daemon sent a request type we don't
        // know. Answer instead of the parse error that used to close the
        // whole connection (and every push riding on it).
        Request::Unknown => Ok(Response::Unsupported {
            request_type: "unknown".to_string(),
            min_version: protocol::PROTOCOL_VERSION,
        }),
    };

    result.unwrap_or_else(|e| Response::Error { message: e.to_string() })
}

pub fn run_server(socket_path: &std::path::Path, manager: Arc<SessionManager>) -> anyhow::Result<()> {
    if socket_path.exists() {
        if UnixStream::connect(socket_path).is_ok() {
            anyhow::bail!(
                "another gavin-daemon is already listening on {}",
                socket_path.display()
            );
        }
        std::fs::remove_file(socket_path)?;
    }
    let listener = UnixListener::bind(socket_path)?;
    std::fs::set_permissions(socket_path, std::fs::Permissions::from_mode(0o600))?;

    for stream in listener.incoming() {
        let stream = match stream {
            Ok(s) => s,
            Err(e) => {
                eprintln!("accept error: {e}");
                continue;
            }
        };
        let manager = Arc::clone(&manager);
        std::thread::spawn(move || {
            if let Err(e) = handle_connection(stream, manager) {
                eprintln!("connection error: {e}");
            }
        });
    }
    Ok(())
}

fn handle_connection(stream: UnixStream, manager: Arc<SessionManager>) -> anyhow::Result<()> {
    let writer = Arc::new(Mutex::new(stream.try_clone()?));
    let mut reader = BufReader::new(stream);

    loop {
        let req: Option<Request> = read_message(&mut reader)?;
        let req = match req {
            Some(r) => r,
            None => break,
        };

        if let Request::Attach { id } = req {
            manager.attach(&id, Arc::clone(&writer));
            continue;
        }

        // Intercepted for the same reason as Attach: the answer is a push to
        // THIS connection's writer, in line with that session's live output,
        // not a reply value handle_request could return. Routing it through
        // handle_request would put the snapshot behind the connection loop's
        // own write instead of the pump's ordering, which is the one thing a
        // repaint cannot afford to get wrong.
        if let Request::Snapshot { id } = req {
            manager.write_snapshot(&id, &writer);
            continue;
        }

        // Like Attach: needs THIS connection's writer (for tree pushes),
        // so it can't go through handle_request. No reply -- the initial
        // scan arrives as the first GavinTreeChanged push.
        if let Request::WatchGavinRoot { workspace_id, root_path } = req {
            SessionManager::watch_gavin_root(
                &manager,
                &workspace_id,
                &root_path,
                Arc::clone(&writer),
            );
            continue;
        }

        // Also intercepted rather than routed through handle_request: this
        // is the one request that ends the whole process, not just this
        // connection, so it can't be expressed as an `Ok(Response)` return
        // value. Reply first so the caller (the app, asking the daemon to
        // stop politely instead of pkill-ing every daemon on the machine)
        // sees an acknowledgement rather than a connection that just closed.
        if matches!(req, Request::Shutdown) {
            let _ = write_message(&mut *writer.lock().unwrap(), &Response::Ok);
            std::process::exit(0);
        }

        let response = handle_request(&manager, req);
        write_message(&mut *writer.lock().unwrap(), &response)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    /// Every daemon test gets a throwaway in-memory orchestration store:
    /// none of them exercise it, they just need SessionManager to build.
    fn test_orchestration_store() -> crate::orchestration::OrchestrationStore {
        crate::orchestration::OrchestrationStore::open(std::path::Path::new(":memory:")).unwrap()
    }

    fn test_manager(dir: &tempfile::TempDir) -> Arc<SessionManager> {
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        let kanban = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        Arc::new(SessionManager::new(registry, kanban, test_orchestration_store()))
    }

    fn orch_rail(rail_id: &str, step_id: &str) -> protocol::Rail {
        orch_rail_at(rail_id, step_id, "/x/a.md")
    }

    /// The same one-stage, one-step rail, aimed at a given card.
    fn orch_rail_at(rail_id: &str, step_id: &str, card_path: &str) -> protocol::Rail {
        protocol::Rail {
            id: rail_id.into(),
            name: "backend".into(),
            position: 0,
            worktree_path: None,
            branch: None,
            page_id: None,
            stages: vec![protocol::Stage {
                id: "s1".into(),
                position: 0,
                mode: protocol::default_stage_mode(),
                name: None,
                steps: vec![protocol::Step {
                    id: step_id.into(),
                    position: 0,
                    card_path: card_path.into(),
                    tool_id: None,
                    tool_params: Default::default(),
                }],
            }],
        }
    }

    #[test]
    fn set_orchestration_then_get_orchestration_round_trips_through_handle_request() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        let rails = vec![orch_rail("r1", "t1")];
        let resp = handle_request(
            &manager,
            Request::SetOrchestration {
                workspace_id: "ws-1".into(),
                rails: rails.clone(),
                conflict_notes: vec![],
            },
        );
        assert!(matches!(resp, Response::Ok));

        let resp = handle_request(&manager, Request::GetOrchestration { workspace_id: "ws-1".into() });
        match resp {
            Response::Orchestration { rails: got, .. } => assert_eq!(got, rails),
            other => panic!("expected Orchestration, got {other:?}"),
        }
    }

    #[test]
    fn run_state_writes_come_back_on_the_next_get() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        handle_request(
            &manager,
            Request::SetOrchestration {
                workspace_id: "ws-1".into(),
                rails: vec![orch_rail("r1", "t1")],
                conflict_notes: vec![],
            },
        );
        handle_request(
            &manager,
            Request::SetRailRun {
                rail_id: "r1".into(),
                state: "running".into(),
                current_stage_id: Some("s1".into()),
            },
        );
        handle_request(
            &manager,
            Request::SetStepRun {
                step_id: "t1".into(),
                state: "running".into(),
                session_id: Some("sess-1".into()),
                reason: None,
            },
        );
        match handle_request(&manager, Request::GetOrchestration { workspace_id: "ws-1".into() }) {
            Response::Orchestration { rail_runs, step_runs, .. } => {
                assert_eq!(rail_runs[0].state, "running");
                assert_eq!(step_runs[0].session_id.as_deref(), Some("sess-1"));
            }
            other => panic!("expected Orchestration, got {other:?}"),
        }
    }

    fn a_tool(id: &str, workspace_id: Option<&str>) -> protocol::ToolDef {
        protocol::ToolDef {
            id: id.into(),
            workspace_id: workspace_id.map(str::to_string),
            name: "Push".into(),
            description: "git push".into(),
            kind: "command".into(),
            body: "git push -u {{remote}} HEAD".into(),
            params: vec![protocol::ToolParam {
                name: "remote".into(),
                label: "Remote".into(),
                default: "origin".into(),
            }],
            position: 0,
        }
    }

    #[test]
    fn save_tool_then_get_tools_round_trips_through_handle_request() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        assert!(matches!(
            handle_request(&manager, Request::SaveTool { tool: a_tool("u1", Some("ws-1")) }),
            Response::Ok
        ));
        match handle_request(&manager, Request::GetTools { workspace_id: "ws-1".into() }) {
            Response::Tools { tools } => {
                assert_eq!(tools.len(), 1);
                assert_eq!(tools[0].id, "u1");
                assert_eq!(tools[0].params[0].default, "origin");
            }
            other => panic!("wrong response: {other:?}"),
        }
    }

    #[test]
    fn a_global_tool_is_visible_from_every_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        handle_request(&manager, Request::SaveTool { tool: a_tool("g1", None) });
        for ws in ["ws-1", "ws-2"] {
            match handle_request(&manager, Request::GetTools { workspace_id: ws.into() }) {
                Response::Tools { tools } => assert_eq!(tools.len(), 1, "{ws}"),
                other => panic!("wrong response: {other:?}"),
            }
        }
    }

    #[test]
    fn delete_tool_removes_it() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        handle_request(&manager, Request::SaveTool { tool: a_tool("u1", Some("ws-1")) });
        assert!(matches!(
            handle_request(&manager, Request::DeleteTool { id: "u1".into() }),
            Response::Ok
        ));
        match handle_request(&manager, Request::GetTools { workspace_id: "ws-1".into() }) {
            Response::Tools { tools } => assert!(tools.is_empty()),
            other => panic!("wrong response: {other:?}"),
        }
    }

    #[test]
    fn get_tools_by_root_needs_the_workspace_open() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        match handle_request(
            &manager,
            Request::GetToolsByRoot { root_path: "/nope".into() },
        ) {
            Response::Error { message } => assert!(message.contains("not open"), "{message}"),
            other => panic!("wrong response: {other:?}"),
        }
    }

    fn a_group_template(id: &str, workspace_id: Option<&str>) -> protocol::GroupTemplate {
        protocol::GroupTemplate {
            id: id.into(),
            workspace_id: workspace_id.map(str::to_string),
            name: "Merge and push".into(),
            description: "Land it, then push".into(),
            mode: "sequence".into(),
            steps: vec![protocol::GroupTemplateStep {
                tool_id: "builtin:push".into(),
                tool_params: HashMap::from([("remote".to_string(), "origin".to_string())]),
            }],
            position: 0,
        }
    }

    #[test]
    fn save_then_get_group_templates_round_trips_through_handle_request() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        assert!(matches!(
            handle_request(
                &manager,
                Request::SaveGroupTemplate { template: a_group_template("g1", Some("ws-1")) }
            ),
            Response::Ok
        ));
        match handle_request(&manager, Request::GetGroupTemplates { workspace_id: "ws-1".into() }) {
            Response::GroupTemplates { templates } => assert_eq!(templates.len(), 1),
            other => panic!("expected GroupTemplates, got {other:?}"),
        }
    }

    #[test]
    fn a_refused_save_tool_answers_with_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        let mut bad = a_tool("u1", None);
        bad.kind = "wasm".into();
        match handle_request(&manager, Request::SaveTool { tool: bad }) {
            Response::Error { message } => assert!(message.contains("wasm"), "{message}"),
            other => panic!("wrong response: {other:?}"),
        }
    }

    /// A step run row that names a session this daemon actually hosts --
    /// what the guard refuses to delete. The PTY is real: liveness is read
    /// off the session table, not off the row.
    fn running_step_with_a_live_session(manager: &Arc<SessionManager>, step_id: &str) {
        let session_id = manager.create_session("/tmp", "/tmp", Some("/bin/sh")).unwrap();
        handle_request(
            manager,
            Request::SetStepRun {
                step_id: step_id.into(),
                state: "running".into(),
                session_id: Some(session_id),
                reason: None,
            },
        );
    }

    #[test]
    fn a_refused_set_orchestration_answers_with_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        handle_request(
            &manager,
            Request::SetOrchestration {
                workspace_id: "ws-1".into(),
                rails: vec![orch_rail("r1", "t1")],
                conflict_notes: vec![],
            },
        );
        running_step_with_a_live_session(&manager, "t1");
        match handle_request(
            &manager,
            Request::SetOrchestration {
                workspace_id: "ws-1".into(),
                rails: vec![orch_rail("r1", "t2")],
                conflict_notes: vec![],
            },
        ) {
            Response::Error { message } => assert!(message.contains("t1"), "{message}"),
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn an_unknown_request_gets_a_reply_and_leaves_the_connection_usable() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);

        // The regression this guards: before v12, an unparseable line closed
        // the socket, so the *next* request never got an answer at all.
        let unsupported = handle_request(&manager, Request::Unknown);
        assert!(matches!(unsupported, Response::Unsupported { .. }));

        let after = handle_request(&manager, Request::GetProtocolVersion);
        assert!(matches!(after, Response::ProtocolVersion { version } if version == protocol::PROTOCOL_VERSION));
    }

    use super::*;
    use std::time::Duration;

    fn start_test_server() -> (std::path::PathBuf, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let socket_path = dir.path().join("daemon.sock");
        let db_path = dir.path().join("registry.sqlite");

        let registry = Registry::open(&db_path).unwrap();
        let kanban = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        let manager = Arc::new(SessionManager::new(registry, kanban, test_orchestration_store()));

        let server_socket_path = socket_path.clone();
        std::thread::spawn(move || {
            run_server(&server_socket_path, manager).unwrap();
        });

        // Give the listener a moment to bind.
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while !socket_path.exists() {
            assert!(std::time::Instant::now() < deadline, "server never bound");
            std::thread::sleep(Duration::from_millis(20));
        }

        (socket_path, dir)
    }

    fn request(stream: &mut UnixStream, req: &Request) -> Response {
        write_message(stream, req).unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        read_message(&mut reader).unwrap().unwrap()
    }

    #[test]
    fn orchestration_by_root_errors_when_the_workspace_is_not_open() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        match handle_request(
            &manager,
            Request::GetOrchestrationByRoot { root_path: "/nowhere".into() },
        ) {
            Response::Error { message } => assert!(message.contains("not open in gavin"), "{message}"),
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn set_orchestration_by_root_writes_the_watched_workspaces_plan_and_pushes() {
        let (socket_path, _dir) = start_test_server();
        let ws_dir = tempfile::tempdir().unwrap();
        crate::gavin::init_gavin_root(ws_dir.path(), "WS").unwrap();
        let root = ws_dir.path().to_string_lossy().to_string();

        // A watching connection is what makes the root resolvable.
        let mut watcher = UnixStream::connect(&socket_path).unwrap();
        write_message(
            &mut watcher,
            &Request::WatchGavinRoot { workspace_id: "ws-1".into(), root_path: root.clone() },
        )
        .unwrap();
        let mut reader = BufReader::new(watcher.try_clone().unwrap());
        let first: Option<Response> = read_message(&mut reader).unwrap();
        assert!(matches!(first, Some(Response::GavinTreeChanged { .. })));

        let mut cmd = UnixStream::connect(&socket_path).unwrap();
        let resp = request(
            &mut cmd,
            &Request::SetOrchestrationByRoot {
                root_path: root.clone(),
                rails: vec![orch_rail("r1", "t1")],
                conflict_notes: vec![],
            },
        );
        assert!(matches!(resp, Response::Ok));

        // Readable by workspace id, and the write pushed.
        match request(&mut cmd, &Request::GetOrchestration { workspace_id: "ws-1".into() }) {
            Response::Orchestration { rails, .. } => assert_eq!(rails[0].id, "r1"),
            other => panic!("expected Orchestration, got {other:?}"),
        }
        match read_message(&mut reader).unwrap() {
            Some(Response::OrchestrationChanged { workspace_id, orchestration }) => {
                assert_eq!(workspace_id, "ws-1");
                assert_eq!(orchestration.rails[0].stages[0].steps[0].id, "t1");
            }
            other => panic!("expected OrchestrationChanged, got {other:?}"),
        }
    }

    /// The reported bug: a rail that could never be deleted. Only the app
    /// writes run state, so a row left at `running` by a session that has
    /// since ended -- here, one the daemon never hosted at all -- must not
    /// refuse the write, or the rail carrying it is wedged shut forever.
    #[test]
    fn a_running_row_whose_session_is_gone_does_not_refuse_the_write() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        handle_request(
            &manager,
            Request::SetOrchestration {
                workspace_id: "ws-1".into(),
                rails: vec![orch_rail("r1", "t1")],
                conflict_notes: vec![],
            },
        );
        handle_request(
            &manager,
            Request::SetStepRun {
                step_id: "t1".into(),
                state: "running".into(),
                session_id: Some("a-session-that-ended".into()),
                reason: None,
            },
        );
        // Deleting the whole rail, which is what the human was doing.
        match handle_request(
            &manager,
            Request::SetOrchestration {
                workspace_id: "ws-1".into(),
                rails: vec![],
                conflict_notes: vec![],
            },
        ) {
            Response::Ok => {}
            other => panic!("expected Ok, got {other:?}"),
        }
        assert!(manager.get_orchestration("ws-1").unwrap().rails.is_empty());
    }

    #[test]
    fn a_refused_write_through_the_root_path_still_reports_the_running_step() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        handle_request(
            &manager,
            Request::SetOrchestration {
                workspace_id: "ws-1".into(),
                rails: vec![orch_rail("r1", "t1")],
                conflict_notes: vec![],
            },
        );
        running_step_with_a_live_session(&manager, "t1");
        match handle_request(
            &manager,
            Request::SetOrchestration {
                workspace_id: "ws-1".into(),
                rails: vec![orch_rail("r1", "t2")],
                conflict_notes: vec![],
            },
        ) {
            Response::Error { message } => assert!(message.contains("is running"), "{message}"),
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn watch_gavin_root_pushes_initial_tree_then_changes() {
        let (socket_path, _dir) = start_test_server();
        let ws_dir = tempfile::tempdir().unwrap();
        crate::gavin::init_gavin_root(ws_dir.path(), "WS").unwrap();

        let mut stream = UnixStream::connect(&socket_path).unwrap();
        write_message(
            &mut stream,
            &Request::WatchGavinRoot {
                workspace_id: "ws-1".to_string(),
                root_path: ws_dir.path().to_string_lossy().to_string(),
            },
        )
        .unwrap();

        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let first: Response = read_message(&mut reader).unwrap().unwrap();
        match &first {
            Response::GavinTreeChanged { workspace_id, tree } => {
                assert_eq!(workspace_id, "ws-1");
                assert!(!tree.root_missing);
                assert_eq!(tree.contexts.len(), 1);
                assert!(tree.contexts[0].has_prd);
            }
            other => panic!("expected initial GavinTreeChanged, got {other:?}"),
        }

        // A new plan file must produce a second push. (Debounce 500ms +
        // 2s floor: the blocking read simply waits them out.)
        std::fs::write(
            ws_dir.path().join(".gavin-root").join("plans").join("new.md"),
            "---\nstatus: To Do\n---\n# New\n",
        )
        .unwrap();
        let second: Response = read_message(&mut reader).unwrap().unwrap();
        match second {
            Response::GavinTreeChanged { tree, .. } => {
                assert_eq!(tree.contexts[0].plans.len(), 1);
                assert_eq!(tree.contexts[0].plans[0].file_name, "new.md");
            }
            other => panic!("expected change push, got {other:?}"),
        }
    }

    #[test]
    fn watching_a_missing_root_reports_root_missing_and_get_tree_replies() {
        let (socket_path, _dir) = start_test_server();
        let mut stream = UnixStream::connect(&socket_path).unwrap();
        write_message(
            &mut stream,
            &Request::WatchGavinRoot {
                workspace_id: "ws-2".to_string(),
                root_path: "/definitely/not/real".to_string(),
            },
        )
        .unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let first: Response = read_message(&mut reader).unwrap().unwrap();
        match first {
            Response::GavinTreeChanged { tree, .. } => assert!(tree.root_missing),
            other => panic!("expected GavinTreeChanged, got {other:?}"),
        }

        // GetGavinTree over a second (command-style) connection.
        let mut cmd = UnixStream::connect(&socket_path).unwrap();
        let resp = request(&mut cmd, &Request::GetGavinTree { workspace_id: "ws-2".to_string() });
        match resp {
            Response::GavinTreeSnapshot { workspace_id, tree } => {
                assert_eq!(workspace_id, "ws-2");
                assert!(tree.root_missing);
            }
            other => panic!("expected snapshot, got {other:?}"),
        }
        let resp = request(
            &mut cmd,
            &Request::GetGavinTree { workspace_id: "never-watched".to_string() },
        );
        assert!(matches!(resp, Response::Error { .. }));
    }

    #[test]
    fn board_and_spawn_require_a_watched_root() {
        let (socket_path, _dir) = start_test_server();
        let ws_dir = tempfile::tempdir().unwrap();
        crate::gavin::init_gavin_root(ws_dir.path(), "WS").unwrap();
        let root = ws_dir.path().to_string_lossy().to_string();
        let mut cmd = UnixStream::connect(&socket_path).unwrap();

        let resp = request(&mut cmd, &Request::GetBoardByRoot { root_path: root.clone() });
        assert!(matches!(resp, Response::Error { .. }));
        let resp = request(
            &mut cmd,
            &Request::SpawnAgentSession {
                root_path: root,
                cwd: "/tmp".to_string(),
                command: "/bin/sh".to_string(),
            },
        );
        assert!(matches!(resp, Response::Error { .. }));
    }

    #[test]
    fn spawn_replies_session_id_and_pushes_on_the_watching_connection() {
        let (socket_path, _dir) = start_test_server();
        let ws_dir = tempfile::tempdir().unwrap();
        crate::gavin::init_gavin_root(ws_dir.path(), "WS").unwrap();
        let root = ws_dir.path().to_string_lossy().to_string();

        // The "app": watches the root on a streaming connection.
        let mut app = UnixStream::connect(&socket_path).unwrap();
        write_message(
            &mut app,
            &Request::WatchGavinRoot { workspace_id: "ws-a".to_string(), root_path: root.clone() },
        )
        .unwrap();
        let mut app_reader = BufReader::new(app.try_clone().unwrap());
        let first: Response = read_message(&mut app_reader).unwrap().unwrap();
        assert!(matches!(first, Response::GavinTreeChanged { .. }));

        // The "shim": spawns over a command connection.
        let mut cmd = UnixStream::connect(&socket_path).unwrap();
        let resp = request(
            &mut cmd,
            &Request::SpawnAgentSession {
                root_path: root.clone(),
                cwd: root.clone(),
                command: "/bin/sh".to_string(),
            },
        );
        let session_id = match resp {
            Response::SessionCreated { id } => id,
            other => panic!("expected SessionCreated, got {other:?}"),
        };

        // The push arrives on the WATCHING connection. (The watcher stores
        // the canonicalized root, so the pushed cwd echoes the request's
        // spelling while the match itself is canonical.)
        let push: Response = read_message(&mut app_reader).unwrap().unwrap();
        match push {
            Response::AgentSessionSpawned { workspace_id, session_id: pushed, cwd, command } => {
                assert_eq!(workspace_id, "ws-a");
                assert_eq!(pushed, session_id);
                assert_eq!(cwd, root);
                assert_eq!(command, "/bin/sh");
            }
            other => panic!("expected AgentSessionSpawned, got {other:?}"),
        }

        // Board happy path now that the root is watched: default seed.
        let resp = request(&mut cmd, &Request::GetBoardByRoot { root_path: root });
        match resp {
            Response::Board { columns, .. } => assert_eq!(columns.len(), 3),
            other => panic!("expected Board, got {other:?}"),
        }

        // Tidy the spawned shell.
        let resp = request(&mut cmd, &Request::KillSession { id: session_id });
        assert!(matches!(resp, Response::Ok));
    }

    #[test]
    fn naming_a_session_pushes_on_the_connection_attached_to_it() {
        let (socket_path, _dir) = start_test_server();

        let mut cmd = UnixStream::connect(&socket_path).unwrap();
        // A session id this daemon never issued is refused rather than
        // pushed anywhere: an agent outliving its tab must hear about it.
        let resp = request(
            &mut cmd,
            &Request::NameSession { session_id: "ghost".to_string(), name: "x".to_string() },
        );
        assert!(matches!(resp, Response::Error { .. }));

        let resp = request(
            &mut cmd,
            &Request::CreateSession {
                workspace_path: "/tmp".to_string(),
                cwd: "/tmp".to_string(),
                command: Some("/bin/sh".to_string()),
            },
        );
        let session_id = match resp {
            Response::SessionCreated { id } => id,
            other => panic!("expected SessionCreated, got {other:?}"),
        };

        // Nothing attached yet: there is no app showing this tab, so
        // there is nowhere for a name to land.
        let resp = request(
            &mut cmd,
            &Request::NameSession { session_id: session_id.clone(), name: "x".to_string() },
        );
        assert!(matches!(resp, Response::Error { .. }));

        // The "app": attaches on a streaming connection. Note it never
        // watches a root -- naming is deliberately independent of that,
        // so an agent in a rail's worktree can still name its tab.
        let mut app = UnixStream::connect(&socket_path).unwrap();
        write_message(&mut app, &Request::Attach { id: session_id.clone() }).unwrap();
        let mut app_reader = BufReader::new(app.try_clone().unwrap());

        // Attach is handled on its own connection thread, so the writer
        // may not be registered the instant the request is written --
        // retry to a deadline rather than racing it.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            let resp = request(
                &mut cmd,
                &Request::NameSession {
                    session_id: session_id.clone(),
                    name: "login flow".to_string(),
                },
            );
            if matches!(resp, Response::Ok) {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "attach never registered: {resp:?}");
            std::thread::sleep(std::time::Duration::from_millis(25));
        }

        // Attach replays baselines (cwd, status, buffered output) first;
        // the name is somewhere after them.
        let named = std::iter::from_fn(|| read_message::<_, Response>(&mut app_reader).unwrap())
            .take(20)
            .find_map(|r| match r {
                Response::SessionNamed { session_id, name } => Some((session_id, name)),
                _ => None,
            })
            .expect("no SessionNamed push arrived");
        assert_eq!(named, (session_id.clone(), "login flow".to_string()));

        let resp = request(&mut cmd, &Request::KillSession { id: session_id });
        assert!(matches!(resp, Response::Ok));
    }

    #[test]
    fn renaming_the_root_away_pushes_root_missing_and_renaming_back_heals() {
        let (socket_path, _dir) = start_test_server();
        let holder = tempfile::tempdir().unwrap();
        let root = holder.path().join("ws");
        std::fs::create_dir_all(&root).unwrap();
        crate::gavin::init_gavin_root(&root, "WS").unwrap();

        let mut stream = UnixStream::connect(&socket_path).unwrap();
        write_message(
            &mut stream,
            &Request::WatchGavinRoot {
                workspace_id: "ws-r".to_string(),
                root_path: root.to_string_lossy().to_string(),
            },
        )
        .unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let first: Response = read_message(&mut reader).unwrap().unwrap();
        assert!(matches!(first, Response::GavinTreeChanged { .. }));

        // The rename event's path is the ROOT itself -- no `.gavin`
        // segment -- so this exercises the event filter's root-path arm
        // (missing it was a live-found spec violation: the UI's
        // "Root not found" banner never appeared).
        let away = holder.path().join("ws-x");
        std::fs::rename(&root, &away).unwrap();
        let missing: Response = read_message(&mut reader).unwrap().unwrap();
        match missing {
            Response::GavinTreeChanged { tree, .. } => assert!(tree.root_missing),
            other => panic!("expected root_missing push, got {other:?}"),
        }

        std::fs::rename(&away, &root).unwrap();
        let healed: Response = read_message(&mut reader).unwrap().unwrap();
        match healed {
            Response::GavinTreeChanged { tree, .. } => {
                assert!(!tree.root_missing);
                assert!(tree.contexts[0].has_prd);
            }
            other => panic!("expected healed push, got {other:?}"),
        }
    }

    #[test]
    fn scan_prd_create_plan_and_version_over_socket() {
        let (socket_path, _dir) = start_test_server();
        let ws_dir = tempfile::tempdir().unwrap();
        crate::gavin::init_gavin_root(ws_dir.path(), "WS").unwrap();
        let root = ws_dir.path().to_string_lossy().to_string();
        let mut cmd = UnixStream::connect(&socket_path).unwrap();

        let resp = request(&mut cmd, &Request::GetProtocolVersion);
        assert!(
            matches!(resp, Response::ProtocolVersion { version } if version == protocol::PROTOCOL_VERSION)
        );

        let resp = request(&mut cmd, &Request::ReadPrd { root_path: root.clone() });
        assert!(matches!(resp, Response::PrdContent { .. }));

        let resp = request(
            &mut cmd,
            &Request::CreatePlan {
                context_folder: root.clone(),
                file_name: "over-socket.md".to_string(),
                title: "Over socket".to_string(),
                status: None,
                priority: Some("low".to_string()),
                kind: None,
                parent: None,
                body: None,
                attachments: None,
            },
        );
        let created_path = match resp {
            Response::PlanCreated { path } => path,
            other => panic!("expected PlanCreated, got {other:?}"),
        };
        assert!(std::path::Path::new(&created_path).is_file());

        let resp = request(&mut cmd, &Request::ScanGavinRoot { root_path: root });
        match resp {
            Response::GavinTreeScanned { tree } => {
                assert!(!tree.root_missing);
                assert_eq!(tree.contexts[0].plans.len(), 1);
                assert_eq!(tree.contexts[0].plans[0].title, "Over socket");
            }
            other => panic!("expected GavinTreeScanned, got {other:?}"),
        }
    }

    #[test]
    fn set_plan_frontmatter_field_over_socket_writes_and_rejects() {
        let (socket_path, _dir) = start_test_server();
        let ws_dir = tempfile::tempdir().unwrap();
        let plan = ws_dir.path().join("p.md");
        std::fs::write(&plan, "---\nstatus: To Do\n---\n# P\n").unwrap();
        let mut cmd = UnixStream::connect(&socket_path).unwrap();

        let resp = request(
            &mut cmd,
            &Request::SetPlanFrontmatterField {
                path: plan.to_string_lossy().to_string(),
                key: "status".to_string(),
                value: "Done".to_string(),
            },
        );
        // Loose file, outside any plans/ folder: Done archives nothing, and
        // the reply carries the path it still has.
        match resp {
            Response::PlanFieldSet { path } => assert_eq!(path, plan.to_string_lossy()),
            other => panic!("expected PlanFieldSet, got {other:?}"),
        }
        assert_eq!(std::fs::read_to_string(&plan).unwrap(), "---\nstatus: Done\n---\n# P\n");

        let resp = request(
            &mut cmd,
            &Request::SetPlanFrontmatterField {
                path: plan.to_string_lossy().to_string(),
                key: "owner".to_string(),
                value: "alice".to_string(),
            },
        );
        assert!(matches!(resp, Response::Error { .. }));
    }

    #[test]
    fn init_and_create_context_over_socket_are_idempotent() {
        let (socket_path, _dir) = start_test_server();
        let ws_dir = tempfile::tempdir().unwrap();
        let mut cmd = UnixStream::connect(&socket_path).unwrap();
        let root = ws_dir.path().to_string_lossy().to_string();

        let resp = request(
            &mut cmd,
            &Request::InitGavinRoot { root_path: root.clone(), workspace_name: "WS".to_string() },
        );
        assert!(matches!(resp, Response::Ok));
        let resp = request(
            &mut cmd,
            &Request::InitGavinRoot { root_path: root, workspace_name: "WS".to_string() },
        );
        assert!(matches!(resp, Response::Ok)); // idempotent second run

        let feature = ws_dir.path().join("auth");
        std::fs::create_dir_all(&feature).unwrap();
        let resp = request(
            &mut cmd,
            &Request::CreateGavinContext {
                parent_folder: feature.to_string_lossy().to_string(),
            },
        );
        assert!(matches!(resp, Response::Ok));
        assert!(feature.join(".gavin").join("config.toml").is_file());

        let resp = request(
            &mut cmd,
            &Request::CreateGavinContext { parent_folder: "/not/a/real/dir".to_string() },
        );
        assert!(matches!(resp, Response::Error { .. }));
    }

    #[test]
    fn create_list_and_kill_session_over_socket() {
        let (socket_path, _dir) = start_test_server();
        let mut stream = UnixStream::connect(&socket_path).unwrap();

        let created = request(
            &mut stream,
            &Request::CreateSession {
                workspace_path: "/tmp/ws".to_string(),
                cwd: "/tmp".to_string(),
                command: Some("/bin/sh".to_string()),
            },
        );
        let id = match created {
            Response::SessionCreated { id } => id,
            other => panic!("expected SessionCreated, got {other:?}"),
        };

        let listed = request(&mut stream, &Request::ListSessions);
        match listed {
            Response::SessionList { sessions } => {
                assert_eq!(sessions.len(), 1);
                assert_eq!(sessions[0].id, id);
                assert_eq!(sessions[0].status, "idle");
                assert_eq!(sessions[0].restored, false);
            }
            other => panic!("expected SessionList, got {other:?}"),
        }

        let killed = request(&mut stream, &Request::KillSession { id: id.clone() });
        assert!(matches!(killed, Response::Ok));

        let listed_after = request(&mut stream, &Request::ListSessions);
        match listed_after {
            Response::SessionList { sessions } => assert_eq!(sessions.len(), 0),
            other => panic!("expected SessionList, got {other:?}"),
        }
    }

    #[test]
    fn write_input_to_unknown_session_returns_error() {
        let (socket_path, _dir) = start_test_server();
        let mut stream = UnixStream::connect(&socket_path).unwrap();

        let resp = request(
            &mut stream,
            &Request::WriteInput {
                id: "does-not-exist".to_string(),
                data: "echo hi\n".to_string(),
            },
        );
        assert!(matches!(resp, Response::Error { .. }));
    }

    /// Drives a session until its output contains `marker`, returning every
    /// Response seen on the way. Shared by the reconnect tests below, which
    /// all need a session that has genuinely produced something before they
    /// can ask for it back.
    fn drive_until(
        stream: &mut UnixStream,
        id: &str,
        input: &str,
        marker: &str,
    ) -> Vec<Response> {
        write_message(stream, &Request::WriteInput { id: id.to_string(), data: input.to_string() })
            .unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut seen = Vec::new();
        let mut collected = String::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let resp: Response = read_message(&mut reader).unwrap().unwrap();
            if let Response::Output { data, .. } = &resp {
                collected.push_str(data);
            }
            seen.push(resp);
            if collected.contains(marker) {
                return seen;
            }
            assert!(std::time::Instant::now() < deadline, "got: {collected}");
        }
    }

    #[test]
    fn a_reconnecting_client_is_sent_the_screen_not_a_log_of_how_it_got_there() {
        let (socket_path, _dir) = start_test_server();
        let mut first = UnixStream::connect(&socket_path).unwrap();
        let id = match request(
            &mut first,
            &Request::CreateSession {
                workspace_path: "/tmp/ws".to_string(),
                cwd: "/tmp".to_string(),
                command: Some("/bin/sh".to_string()),
            },
        ) {
            Response::SessionCreated { id } => id,
            other => panic!("expected SessionCreated, got {other:?}"),
        };
        write_message(&mut first, &Request::Attach { id: id.clone() }).unwrap();
        drive_until(&mut first, &id, "echo on_the_screen\n", "on_the_screen");

        // A second client -- the app, restarted -- attaches and must be able
        // to reconstruct the screen from what it is sent, with no access to
        // anything that came before.
        let mut second = UnixStream::connect(&socket_path).unwrap();
        write_message(&mut second, &Request::Attach { id: id.clone() }).unwrap();
        let mut reader = BufReader::new(second.try_clone().unwrap());
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut restored = String::new();
        while std::time::Instant::now() < deadline && !restored.contains("on_the_screen") {
            if let Some(Response::Output { data, .. }) = read_message(&mut reader).unwrap() {
                restored.push_str(&data);
            }
        }
        assert!(
            restored.contains("on_the_screen"),
            "a fresh attach must restore what the session has on screen, got: {restored:?}"
        );
        assert!(
            restored.contains("\u{1b}[H\u{1b}[J"),
            "and it must be a repaint from a known state, not a byte log: {restored:?}"
        );
    }

    #[test]
    fn snapshot_repaints_without_re_sending_the_baselines_attach_does() {
        // The hot-reload path. Attach re-sends CwdChanged / StatusChanged /
        // SessionRestored, and a waiting_for_input status notifies
        // unconditionally on the app side -- so a frontend that reloaded and
        // wants its terminals back must have a way to ask for the screen ONLY.
        let (socket_path, _dir) = start_test_server();
        let mut stream = UnixStream::connect(&socket_path).unwrap();
        let id = match request(
            &mut stream,
            &Request::CreateSession {
                workspace_path: "/tmp/ws".to_string(),
                cwd: "/tmp".to_string(),
                command: Some("/bin/sh".to_string()),
            },
        ) {
            Response::SessionCreated { id } => id,
            other => panic!("expected SessionCreated, got {other:?}"),
        };
        write_message(&mut stream, &Request::Attach { id: id.clone() }).unwrap();
        drive_until(&mut stream, &id, "echo still_here\n", "still_here");

        // Drained to quiescence FIRST. The status heuristic pushes an `idle`
        // StatusChanged a couple of seconds after output stops, and a live
        // transition looks exactly like a re-sent baseline on the wire -- so
        // without waiting it out, this test would be asserting on which of
        // the two won a race.
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let deadline = std::time::Instant::now() + HEURISTIC_QUIET_PERIOD * 4;
        let mut settled = false;
        while std::time::Instant::now() < deadline && !settled {
            settled = matches!(
                read_message(&mut reader).unwrap(),
                Some(Response::StatusChanged { ref status, .. }) if status == "idle"
            );
        }
        assert!(settled, "precondition: the session never went idle");

        write_message(&mut stream, &Request::Snapshot { id: id.clone() }).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut repainted = String::new();
        let mut baselines: Vec<Response> = Vec::new();
        while std::time::Instant::now() < deadline && !repainted.contains("still_here") {
            match read_message(&mut reader).unwrap() {
                Some(Response::Output { data, .. }) => repainted.push_str(&data),
                Some(other) => baselines.push(other),
                None => break,
            }
        }
        assert!(
            repainted.contains("still_here"),
            "Snapshot must repaint the screen, got: {repainted:?}"
        );
        assert!(
            baselines.is_empty(),
            "Snapshot must send the screen and nothing else, also got: {baselines:?}"
        );
    }

    #[test]
    fn a_snapshot_for_a_session_with_no_screen_sends_nothing_rather_than_a_clear() {
        // A blank Output would clear a terminal that may well have content in
        // it -- for a session id the daemon has never pumped, silence is the
        // only safe answer.
        let (socket_path, _dir) = start_test_server();
        let mut stream = UnixStream::connect(&socket_path).unwrap();
        write_message(&mut stream, &Request::Snapshot { id: "never-existed".to_string() }).unwrap();
        // Prove the connection is still live and simply had nothing to say,
        // by putting a request behind it whose reply we know how to recognise.
        let resp = request(&mut stream, &Request::ListSessions);
        assert!(
            matches!(resp, Response::SessionList { .. }),
            "the next reply on this connection must be ListSessions', not a \
             stray Output for a session with no screen: {resp:?}"
        );
    }

    #[test]
    fn attach_from_a_new_connection_streams_output_of_an_existing_session() {
        let (socket_path, _dir) = start_test_server();

        // Connection 1: create the session, then drop the connection
        // (simulating the GUI app closing).
        let id = {
            let mut stream = UnixStream::connect(&socket_path).unwrap();
            let created = request(
                &mut stream,
                &Request::CreateSession {
                    workspace_path: "/tmp/ws".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/bin/sh".to_string()),
                },
            );
            match created {
                Response::SessionCreated { id } => id,
                other => panic!("expected SessionCreated, got {other:?}"),
            }
        };

        // Connection 2: attach to the same session and drive it.
        let mut stream2 = UnixStream::connect(&socket_path).unwrap();
        write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();
        write_message(
            &mut stream2,
            &Request::WriteInput {
                id: id.clone(),
                data: "echo attached_ok\n".to_string(),
            },
        )
        .unwrap();

        let mut reader = BufReader::new(stream2.try_clone().unwrap());
        let mut collected = String::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            let resp: Response = read_message(&mut reader).unwrap().unwrap();
            if let Response::Output { data, .. } = resp {
                collected.push_str(&data);
                if collected.contains("attached_ok") {
                    break;
                }
            }
            assert!(std::time::Instant::now() < deadline, "got: {collected}");
        }
    }

    #[test]
    fn reattaching_after_detach_delivers_output_to_the_new_connection_only() {
        let (socket_path, _dir) = start_test_server();

        let id = {
            let mut stream = UnixStream::connect(&socket_path).unwrap();
            let created = request(
                &mut stream,
                &Request::CreateSession {
                    workspace_path: "/tmp/ws".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/bin/sh".to_string()),
                },
            );
            match created {
                Response::SessionCreated { id } => id,
                other => panic!("expected SessionCreated, got {other:?}"),
            }
        };

        // First attach, then drop the connection without the session exiting.
        {
            let mut stream2 = UnixStream::connect(&socket_path).unwrap();
            write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();
            // Give the pump thread a moment to start before we drop the connection.
            std::thread::sleep(Duration::from_millis(100));
        }

        // Reattach from a third connection and drive the session — this must
        // not race with, or lose output to, the now-disconnected first pump.
        let mut stream3 = UnixStream::connect(&socket_path).unwrap();
        write_message(&mut stream3, &Request::Attach { id: id.clone() }).unwrap();
        write_message(
            &mut stream3,
            &Request::WriteInput {
                id: id.clone(),
                data: "echo reattached_ok\n".to_string(),
            },
        )
        .unwrap();

        let mut reader = BufReader::new(stream3.try_clone().unwrap());
        let mut collected = String::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            let resp: Response = read_message(&mut reader).unwrap().unwrap();
            if let Response::Output { data, .. } = resp {
                collected.push_str(&data);
                if collected.contains("reattached_ok") {
                    break;
                }
            }
            assert!(std::time::Instant::now() < deadline, "got: {collected}");
        }
    }

    #[test]
    fn reattach_replays_buffered_output_produced_while_detached() {
        let (socket_path, _dir) = start_test_server();

        let id = {
            let mut stream = UnixStream::connect(&socket_path).unwrap();
            let created = request(
                &mut stream,
                &Request::CreateSession {
                    workspace_path: "/tmp/ws".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/bin/sh".to_string()),
                },
            );
            match created {
                Response::SessionCreated { id } => id,
                other => panic!("expected SessionCreated, got {other:?}"),
            }
        };

        // First attach starts the pump (and the scrollback buffer), then detach.
        {
            let mut stream2 = UnixStream::connect(&socket_path).unwrap();
            write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();
            std::thread::sleep(Duration::from_millis(100));
        }

        // Produce output while nobody is attached; the pump is still running
        // and keeps appending to the scrollback buffer even with no writer.
        {
            let mut stream = UnixStream::connect(&socket_path).unwrap();
            let resp = request(
                &mut stream,
                &Request::WriteInput {
                    id: id.clone(),
                    data: "echo while_detached\n".to_string(),
                },
            );
            assert!(matches!(resp, Response::Ok));
        }
        std::thread::sleep(Duration::from_millis(300));

        // Reattach: the replay must include output produced while detached.
        let mut stream3 = UnixStream::connect(&socket_path).unwrap();
        write_message(&mut stream3, &Request::Attach { id: id.clone() }).unwrap();

        let mut reader = BufReader::new(stream3.try_clone().unwrap());
        let mut collected = String::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            let resp: Response = read_message(&mut reader).unwrap().unwrap();
            if let Response::Output { data, .. } = resp {
                collected.push_str(&data);
                if collected.contains("while_detached") {
                    break;
                }
            }
            assert!(std::time::Instant::now() < deadline, "got: {collected}");
        }
    }

    #[test]
    fn create_session_rejects_nonexistent_cwd() {
        let (socket_path, _dir) = start_test_server();
        let mut stream = UnixStream::connect(&socket_path).unwrap();

        let resp = request(
            &mut stream,
            &Request::CreateSession {
                workspace_path: "/tmp/ws".to_string(),
                cwd: "/tmp/definitely-does-not-exist-xyz".to_string(),
                command: Some("/bin/sh".to_string()),
            },
        );
        assert!(matches!(resp, Response::Error { .. }));
    }

    #[test]
    fn archiving_a_card_re_keys_its_session_binding_and_rail_steps() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        let kanban = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        let manager = SessionManager::new(registry, kanban, test_orchestration_store());

        let ws = tempfile::tempdir().unwrap();
        crate::gavin::init_gavin_root(ws.path(), "WS").unwrap();
        let plans = ws.path().join(".gavin-root").join("plans");
        let card = plans.join("ship.md");
        std::fs::write(&card, "---\ntitle: Ship\nstatus: In Progress\n---\n").unwrap();
        let before = card.to_string_lossy().to_string();
        let after = plans.join("done").join("ship.md").to_string_lossy().to_string();

        manager.link_card_session("ws-1", &before, "s-1", "/p", None).unwrap();
        // The rail's one step points at the card about to move.
        manager
            .set_orchestration(
                "ws-1",
                vec![protocol::Rail {
                    id: "r1".into(),
                    name: "R1".into(),
                    position: 0,
                    worktree_path: None,
                    branch: None,
                    page_id: None,
                    stages: vec![protocol::Stage {
                        id: "st1".into(),
                        position: 0,
                        mode: protocol::default_stage_mode(),
                        name: None,
                        steps: vec![protocol::Step {
                            id: "t1".into(),
                            position: 0,
                            card_path: before.clone(),
                            tool_id: None,
                            tool_params: Default::default(),
                        }],
                    }],
                }],
                vec![],
            )
            .unwrap();

        let resp = handle_request(
            &manager,
            Request::SetPlanFrontmatterField {
                path: before.clone(),
                key: "status".to_string(),
                value: "Done".to_string(),
            },
        );

        match resp {
            Response::PlanFieldSet { path } => assert_eq!(path, after),
            other => panic!("expected PlanFieldSet, got {other:?}"),
        }
        let board = manager.get_board("ws-1").unwrap();
        assert_eq!(board.card_sessions[0].path, after);
        let orch = manager.get_orchestration("ws-1").unwrap();
        assert_eq!(orch.rails[0].stages[0].steps[0].card_path, after);
    }

    #[test]
    fn a_card_moved_behind_the_daemons_back_re_keys_its_rail_step_on_the_next_scan() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);

        let ws = tempfile::tempdir().unwrap();
        crate::gavin::init_gavin_root(ws.path(), "WS").unwrap();
        // Canonical, because that is the only spelling anything ever
        // learns a card path in: the watcher canonicalizes its root, and
        // every path the app and the MCP hand back came out of that scan.
        let root = ws.path().canonicalize().unwrap();
        let plans = root.join(".gavin-root").join("plans");
        let card = plans.join("ship.md");
        std::fs::write(&card, "---\ntitle: Ship\nstatus: Done\n---\n").unwrap();
        let before = card.to_string_lossy().to_string();

        manager.link_card_session("ws-1", &before, "s-1", "/p", None).unwrap();
        manager
            .set_orchestration("ws-1", vec![orch_rail_at("r1", "t1", &before)], vec![])
            .unwrap();

        // The move the daemon knows nothing about: an agent's `mv`, or the
        // one-time migration that introduced plans/done/.
        std::fs::create_dir_all(plans.join("done")).unwrap();
        let after = plans.join("done").join("ship.md");
        std::fs::rename(&card, &after).unwrap();
        let after = after.to_string_lossy().to_string();

        let (ours, theirs) = UnixStream::pair().unwrap();
        ours.set_read_timeout(Some(Duration::from_millis(500))).unwrap();
        SessionManager::watch_gavin_root(
            &manager,
            "ws-1",
            &ws.path().to_string_lossy(),
            Arc::new(Mutex::new(theirs)),
        );

        let orch = manager.get_orchestration("ws-1").unwrap();
        assert_eq!(orch.rails[0].stages[0].steps[0].card_path, after);
        assert_eq!(manager.get_board("ws-1").unwrap().card_sessions[0].path, after);

        // The app is holding the old path, so the re-key has to reach it --
        // and BEFORE the tree, which is what re-runs its scheduler.
        let mut reader = BufReader::new(ours);
        match read_message::<_, Response>(&mut reader).unwrap().unwrap() {
            Response::OrchestrationChanged { orchestration, .. } => {
                assert_eq!(orchestration.rails[0].stages[0].steps[0].card_path, after);
            }
            other => panic!("expected OrchestrationChanged first, got {other:?}"),
        }
        assert!(matches!(
            read_message::<_, Response>(&mut reader).unwrap().unwrap(),
            Response::GavinTreeChanged { .. }
        ));
    }

    #[test]
    fn a_card_the_daemon_archives_pushes_its_re_keyed_step_to_the_watching_app() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);

        let ws = tempfile::tempdir().unwrap();
        crate::gavin::init_gavin_root(ws.path(), "WS").unwrap();
        let root = ws.path().canonicalize().unwrap();
        let plans = root.join(".gavin-root").join("plans");
        let card = plans.join("ship.md");
        std::fs::write(&card, "---\ntitle: Ship\nstatus: In Progress\n---\n").unwrap();
        let before = card.to_string_lossy().to_string();
        let after = plans.join("done").join("ship.md").to_string_lossy().to_string();

        manager.set_orchestration("ws-1", vec![orch_rail_at("r1", "t1", &before)], vec![]).unwrap();

        // Watched only now, so the arrangement's own push is not in the
        // stream and the initial scan is the only thing to drain.
        let (ours, theirs) = UnixStream::pair().unwrap();
        ours.set_read_timeout(Some(Duration::from_millis(500))).unwrap();
        SessionManager::watch_gavin_root(
            &manager,
            "ws-1",
            &root.to_string_lossy(),
            Arc::new(Mutex::new(theirs)),
        );
        let mut reader = BufReader::new(ours);
        assert!(matches!(
            read_message::<_, Response>(&mut reader).unwrap().unwrap(),
            Response::GavinTreeChanged { .. }
        ));

        // The daemon's OWN move: the DB follows the card by itself, but
        // the app holds a copy of every step and must be told too.
        manager.set_plan_field(&before, "status", "Done").unwrap();

        match read_message::<_, Response>(&mut reader).unwrap().unwrap() {
            Response::OrchestrationChanged { orchestration, .. } => {
                assert_eq!(orchestration.rails[0].stages[0].steps[0].card_path, after);
            }
            other => panic!("expected OrchestrationChanged, got {other:?}"),
        }
    }

    #[test]
    fn a_scan_that_moved_nothing_pushes_only_the_tree() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);

        let ws = tempfile::tempdir().unwrap();
        crate::gavin::init_gavin_root(ws.path(), "WS").unwrap();
        let card = ws.path().join(".gavin-root").join("plans").join("ship.md");
        std::fs::write(&card, "---\ntitle: Ship\n---\n").unwrap();
        let path = card.to_string_lossy().to_string();
        manager.set_orchestration("ws-1", vec![orch_rail_at("r1", "t1", &path)], vec![]).unwrap();

        let (ours, theirs) = UnixStream::pair().unwrap();
        ours.set_read_timeout(Some(Duration::from_millis(500))).unwrap();
        SessionManager::watch_gavin_root(
            &manager,
            "ws-1",
            &ws.path().to_string_lossy(),
            Arc::new(Mutex::new(theirs)),
        );

        let mut reader = BufReader::new(ours);
        assert!(matches!(
            read_message::<_, Response>(&mut reader).unwrap().unwrap(),
            Response::GavinTreeChanged { .. }
        ));
        // And nothing after it: a scan that re-keyed nothing must not
        // hand the app a whole orchestration it already has.
        assert!(read_message::<_, Response>(&mut reader).is_err(), "a no-op scan still pushed");
    }

    #[test]
    fn get_board_request_returns_the_default_seed_for_a_new_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        let kanban = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        let manager = SessionManager::new(registry, kanban, test_orchestration_store());

        let resp = handle_request(&manager, Request::GetBoard { workspace_id: "ws-1".to_string() });

        match resp {
            Response::Board { columns, labels, card_sessions: _ } => {
                assert_eq!(columns.len(), 3);
                assert!(labels.is_empty());
            }
            other => panic!("expected Board, got {other:?}"),
        }
    }

    #[test]
    fn set_board_then_get_board_round_trips_through_handle_request() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        let kanban = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        let manager = SessionManager::new(registry, kanban, test_orchestration_store());
        let columns =
            vec![Column { id: "c1".to_string(), name: "Only column".to_string(), position: 0 }];

        let set_resp = handle_request(
            &manager,
            Request::SetBoard { workspace_id: "ws-1".to_string(), columns: columns.clone(), labels: vec![] },
        );
        assert!(matches!(set_resp, Response::Ok));

        let get_resp = handle_request(&manager, Request::GetBoard { workspace_id: "ws-1".to_string() });
        match get_resp {
            Response::Board { columns: got, .. } => {
                // The written column round-trips first; get_board then
                // restores the three permanent statuses behind it.
                assert_eq!(got[0].name, "Only column");
                assert_eq!(got.len(), 4);
                for name in ["To Do", "In Progress", "Done"] {
                    assert!(got.iter().any(|c| c.name == name), "permanent column {name} restored");
                }
            }
            other => panic!("expected Board, got {other:?}"),
        }
    }

    #[test]
    fn delete_board_request_removes_the_board_and_a_later_get_reseeds_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        let kanban = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        let manager = SessionManager::new(registry, kanban, test_orchestration_store());
        handle_request(
            &manager,
            Request::SetBoard {
                workspace_id: "ws-1".to_string(),
                columns: vec![Column { id: "c1".to_string(), name: "Custom".to_string(), position: 0 }],
                labels: vec![],
            },
        );

        let delete_resp = handle_request(&manager, Request::DeleteBoard { workspace_id: "ws-1".to_string() });
        assert!(matches!(delete_resp, Response::Ok));

        let get_resp = handle_request(&manager, Request::GetBoard { workspace_id: "ws-1".to_string() });
        match get_resp {
            Response::Board { columns, .. } => {
                assert_eq!(columns.len(), 3, "should reseed fresh defaults, not the deleted custom column");
            }
            other => panic!("expected Board, got {other:?}"),
        }
    }

    #[test]
    fn resize_session_returns_ok_for_existing_session() {
        let (socket_path, _dir) = start_test_server();
        let mut stream = UnixStream::connect(&socket_path).unwrap();

        let created = request(
            &mut stream,
            &Request::CreateSession {
                workspace_path: "/tmp/ws".to_string(),
                cwd: "/tmp".to_string(),
                command: Some("/bin/sh".to_string()),
            },
        );
        let id = match created {
            Response::SessionCreated { id } => id,
            other => panic!("expected SessionCreated, got {other:?}"),
        };

        let resp = request(&mut stream, &Request::ResizeSession { id, cols: 120, rows: 40 });
        assert!(matches!(resp, Response::Ok));
    }

    #[test]
    fn resize_session_returns_error_for_unknown_session() {
        let (socket_path, _dir) = start_test_server();
        let mut stream = UnixStream::connect(&socket_path).unwrap();

        let resp = request(
            &mut stream,
            &Request::ResizeSession { id: "does-not-exist".to_string(), cols: 80, rows: 24 },
        );
        assert!(matches!(resp, Response::Error { .. }));
    }

    #[test]
    fn attach_sends_a_baseline_cwd_changed_with_the_launch_directory() {
        let (socket_path, _dir) = start_test_server();

        let id = {
            let mut stream = UnixStream::connect(&socket_path).unwrap();
            let created = request(
                &mut stream,
                &Request::CreateSession {
                    workspace_path: "/tmp/ws".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/bin/sh".to_string()),
                },
            );
            match created {
                Response::SessionCreated { id } => id,
                other => panic!("expected SessionCreated, got {other:?}"),
            }
        };

        let mut stream2 = UnixStream::connect(&socket_path).unwrap();
        write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();

        let mut reader = BufReader::new(stream2.try_clone().unwrap());
        let resp: Response = read_message(&mut reader).unwrap().unwrap();
        match resp {
            Response::CwdChanged { id: rid, cwd } => {
                assert_eq!(rid, id);
                assert_eq!(cwd, "/tmp");
            }
            other => panic!("expected CwdChanged as the first message after Attach, got {other:?}"),
        }
    }

    #[test]
    fn attach_sends_a_baseline_status_changed_immediately_after_the_baseline_cwd_changed() {
        let (socket_path, _dir) = start_test_server();

        let id = {
            let mut stream = UnixStream::connect(&socket_path).unwrap();
            let created = request(
                &mut stream,
                &Request::CreateSession {
                    workspace_path: "/tmp/ws".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/bin/sh".to_string()),
                },
            );
            match created {
                Response::SessionCreated { id } => id,
                other => panic!("expected SessionCreated, got {other:?}"),
            }
        };

        let mut stream2 = UnixStream::connect(&socket_path).unwrap();
        write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();

        let mut reader = BufReader::new(stream2.try_clone().unwrap());

        let first: Response = read_message(&mut reader).unwrap().unwrap();
        assert!(matches!(first, Response::CwdChanged { .. }), "expected CwdChanged first, got {first:?}");

        let second: Response = read_message(&mut reader).unwrap().unwrap();
        match second {
            Response::StatusChanged { id: rid, status } => {
                assert_eq!(rid, id);
                assert_eq!(status, "idle");
            }
            other => panic!("expected StatusChanged as the second message after Attach, got {other:?}"),
        }
    }

    #[test]
    fn attach_never_sends_a_baseline_status_changed_for_an_exited_session() {
        let (socket_path, _dir) = start_test_server();

        let id = {
            let mut stream = UnixStream::connect(&socket_path).unwrap();
            let created = request(
                &mut stream,
                &Request::CreateSession {
                    workspace_path: "/tmp/ws".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/bin/sh".to_string()),
                },
            );
            match created {
                Response::SessionCreated { id } => id,
                other => panic!("expected SessionCreated, got {other:?}"),
            }
        };

        // Attach once, then make the shell exit so the pump thread's
        // teardown persists SessionStatus::Exited to the registry (this
        // does not remove the registry record -- only kill_session does).
        let mut stream1 = UnixStream::connect(&socket_path).unwrap();
        write_message(&mut stream1, &Request::Attach { id: id.clone() }).unwrap();
        write_message(&mut stream1, &Request::WriteInput { id: id.clone(), data: "exit\n".to_string() }).unwrap();

        let mut reader1 = BufReader::new(stream1.try_clone().unwrap());
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut exited = false;
        while std::time::Instant::now() < deadline && !exited {
            let resp: Response = read_message(&mut reader1).unwrap().unwrap();
            if let Response::SessionExited { id: rid, .. } = resp {
                if rid == id {
                    exited = true;
                }
            }
        }
        assert!(exited, "session never reported SessionExited");

        // Now attach a second, fresh connection to the now-exited
        // session and confirm the baseline never includes StatusChanged.
        let mut stream2 = UnixStream::connect(&socket_path).unwrap();
        write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();

        let mut reader2 = BufReader::new(stream2.try_clone().unwrap());
        reader2.get_ref().set_read_timeout(Some(Duration::from_millis(500))).unwrap();
        loop {
            match read_message::<_, Response>(&mut reader2) {
                Ok(Some(Response::StatusChanged { id: rid, .. })) if rid == id => {
                    panic!("attach() sent a baseline StatusChanged for an exited session");
                }
                Ok(Some(_)) => continue,
                Ok(None) | Err(_) => break, // nothing more arrived within the timeout, as expected
            }
        }
    }

    #[test]
    fn attach_never_establishes_a_repo_mapping_or_sends_git_status_changed_for_an_exited_session() {
        // Created inside a real git repo (unlike the /tmp-based exited-
        // session test above) specifically so that, absent the Exited
        // gate around attach()'s git-status baseline block, a repo
        // mapping WOULD get established and a poller WOULD get spawned
        // for this repo root on the second attach below.
        let repo_dir = tempfile::tempdir().unwrap();
        init_test_repo(repo_dir.path());
        let repo_path = repo_dir.path().to_str().unwrap().to_string();

        let (socket_path, _dir) = start_test_server();

        let id = {
            let mut stream = UnixStream::connect(&socket_path).unwrap();
            let created = request(
                &mut stream,
                &Request::CreateSession {
                    workspace_path: repo_path.clone(),
                    cwd: repo_path.clone(),
                    command: Some("/bin/sh".to_string()),
                },
            );
            match created {
                Response::SessionCreated { id } => id,
                other => panic!("expected SessionCreated, got {other:?}"),
            }
        };

        // Attach once, then make the shell exit so the pump thread's
        // teardown persists SessionStatus::Exited to the registry (this
        // does not remove the registry record -- only kill_session does).
        // Teardown also calls unregister_session_repo_mapping before
        // persisting Exited, so no mapping is left over from this first
        // attach either.
        let mut stream1 = UnixStream::connect(&socket_path).unwrap();
        write_message(&mut stream1, &Request::Attach { id: id.clone() }).unwrap();
        write_message(&mut stream1, &Request::WriteInput { id: id.clone(), data: "exit\n".to_string() }).unwrap();

        let mut reader1 = BufReader::new(stream1.try_clone().unwrap());
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut exited = false;
        while std::time::Instant::now() < deadline && !exited {
            let resp: Response = read_message(&mut reader1).unwrap().unwrap();
            if let Response::SessionExited { id: rid, .. } = resp {
                if rid == id {
                    exited = true;
                }
            }
        }
        assert!(exited, "session never reported SessionExited");

        // Now attach a second, fresh connection to the now-exited session
        // and confirm no GitStatusChanged is ever sent -- before the fix,
        // attach()'s unconditional update_session_repo_mapping call would
        // establish a mapping and spawn a poller here even though no pump
        // thread will ever run for this session to tear it back down
        // again, leaking that poller (its filesystem watch and 3-minute
        // backstop timer thread) permanently.
        let mut stream2 = UnixStream::connect(&socket_path).unwrap();
        write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();

        let mut reader2 = BufReader::new(stream2.try_clone().unwrap());
        reader2.get_ref().set_read_timeout(Some(Duration::from_millis(500))).unwrap();
        loop {
            match read_message::<_, Response>(&mut reader2) {
                Ok(Some(Response::GitStatusChanged { id: rid, .. })) if rid == id => {
                    panic!("attach() sent a baseline GitStatusChanged for an exited session");
                }
                Ok(Some(_)) => continue,
                Ok(None) | Err(_) => break, // nothing more arrived within the timeout, as expected
            }
        }
    }

    #[test]
    fn attach_relays_cwd_changed_when_pty_output_contains_osc7() {
        let (socket_path, _dir) = start_test_server();

        let id = {
            let mut stream = UnixStream::connect(&socket_path).unwrap();
            let created = request(
                &mut stream,
                &Request::CreateSession {
                    workspace_path: "/tmp/ws".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/bin/sh".to_string()),
                },
            );
            match created {
                Response::SessionCreated { id } => id,
                other => panic!("expected SessionCreated, got {other:?}"),
            }
        };

        let mut stream2 = UnixStream::connect(&socket_path).unwrap();
        write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();
        write_message(
            &mut stream2,
            &Request::WriteInput {
                id: id.clone(),
                data: "printf '\\033]7;file://host/tmp/from-osc7\\007'\n".to_string(),
            },
        )
        .unwrap();

        let mut reader = BufReader::new(stream2.try_clone().unwrap());
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut found = false;
        while std::time::Instant::now() < deadline {
            let resp: Response = read_message(&mut reader).unwrap().unwrap();
            if let Response::CwdChanged { id: rid, cwd } = resp {
                if rid == id && cwd == "/tmp/from-osc7" {
                    found = true;
                    break;
                }
            }
        }
        assert!(found, "never saw the expected CwdChanged for the printf'd OSC 7 sequence");
    }

    #[test]
    fn relays_status_changed_when_pty_output_contains_an_osc_133_command_executed_marker() {
        let (socket_path, _dir) = start_test_server();

        let id = {
            let mut stream = UnixStream::connect(&socket_path).unwrap();
            let created = request(
                &mut stream,
                &Request::CreateSession {
                    workspace_path: "/tmp/ws".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/bin/sh".to_string()),
                },
            );
            match created {
                Response::SessionCreated { id } => id,
                other => panic!("expected SessionCreated, got {other:?}"),
            }
        };

        let mut stream2 = UnixStream::connect(&socket_path).unwrap();
        write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();
        write_message(
            &mut stream2,
            &Request::WriteInput {
                id: id.clone(),
                data: "printf '\\033]133;C\\007'\n".to_string(),
            },
        )
        .unwrap();

        let mut reader = BufReader::new(stream2.try_clone().unwrap());
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut found = false;
        while std::time::Instant::now() < deadline {
            let resp: Response = read_message(&mut reader).unwrap().unwrap();
            if let Response::StatusChanged { id: rid, status } = resp {
                if rid == id && status == "working" {
                    found = true;
                    break;
                }
            }
        }
        assert!(found, "never saw the expected StatusChanged{{status:\"working\"}} for the printf'd OSC 133 C marker");
    }

    #[test]
    fn relays_status_changed_when_pty_output_contains_a_bare_bel() {
        let (socket_path, _dir) = start_test_server();

        let id = {
            let mut stream = UnixStream::connect(&socket_path).unwrap();
            let created = request(
                &mut stream,
                &Request::CreateSession {
                    workspace_path: "/tmp/ws".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/bin/sh".to_string()),
                },
            );
            match created {
                Response::SessionCreated { id } => id,
                other => panic!("expected SessionCreated, got {other:?}"),
            }
        };

        let mut stream2 = UnixStream::connect(&socket_path).unwrap();
        write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();
        write_message(
            &mut stream2,
            &Request::WriteInput { id: id.clone(), data: "printf '\\007'\n".to_string() },
        )
        .unwrap();

        let mut reader = BufReader::new(stream2.try_clone().unwrap());
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut found = false;
        while std::time::Instant::now() < deadline {
            let resp: Response = read_message(&mut reader).unwrap().unwrap();
            if let Response::StatusChanged { id: rid, status } = resp {
                if rid == id && status == "waiting_for_input" {
                    found = true;
                    break;
                }
            }
        }
        assert!(found, "never saw the expected StatusChanged{{status:\"waiting_for_input\"}} for the printf'd bare BEL");
    }

    #[test]
    fn relays_status_changed_when_pty_output_contains_an_osc777_notification() {
        // The end-to-end path for the signal a real Claude Code session
        // actually emits when it needs the user: an OSC 777 desktop
        // notification (what it sends under TERM_PROGRAM=ghostty). The
        // bare-BEL test above covers only the Apple_Terminal case.
        let (socket_path, _dir) = start_test_server();

        let id = {
            let mut stream = UnixStream::connect(&socket_path).unwrap();
            let created = request(
                &mut stream,
                &Request::CreateSession {
                    workspace_path: "/tmp/ws".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/bin/sh".to_string()),
                },
            );
            match created {
                Response::SessionCreated { id } => id,
                other => panic!("expected SessionCreated, got {other:?}"),
            }
        };

        let mut stream2 = UnixStream::connect(&socket_path).unwrap();
        write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();
        // A genuinely blocking read after the notification, so the
        // heuristic's renewed-output-activity rule can't clear
        // waiting_for_input before the assertion runs -- the same reason
        // the bare-BEL test above pairs its printf with a `read`.
        write_message(
            &mut stream2,
            &Request::WriteInput {
                id: id.clone(),
                data: "printf '\\033]777;notify;Claude Code;Claude needs your permission\\007'; read _unused\n"
                    .to_string(),
            },
        )
        .unwrap();

        // A read timeout so a regression fails at the deadline instead of
        // blocking forever: once the shell reaches its blocking `read`, no
        // further messages arrive, and this loop's deadline is only
        // consulted between messages.
        stream2.set_read_timeout(Some(Duration::from_millis(250))).unwrap();
        let mut reader = BufReader::new(stream2.try_clone().unwrap());
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut found = false;
        while std::time::Instant::now() < deadline {
            match read_message::<_, Response>(&mut reader) {
                Ok(Some(Response::StatusChanged { id: rid, status }))
                    if rid == id && status == "waiting_for_input" =>
                {
                    found = true;
                    break;
                }
                Ok(_) => {}
                // A timeout tick -- keep waiting until the deadline.
                Err(_) => {}
            }
        }
        assert!(found, "never saw the expected StatusChanged{{status:\"waiting_for_input\"}} for the OSC 777 notification");
    }

    #[test]
    fn heuristic_fires_working_promptly_then_idle_after_a_real_quiet_period() {
        let (socket_path, _dir) = start_test_server();

        let id = {
            let mut stream = UnixStream::connect(&socket_path).unwrap();
            let created = request(
                &mut stream,
                &Request::CreateSession {
                    workspace_path: "/tmp/ws".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/bin/sh".to_string()),
                },
            );
            match created {
                Response::SessionCreated { id } => id,
                other => panic!("expected SessionCreated, got {other:?}"),
            }
        };

        let mut stream2 = UnixStream::connect(&socket_path).unwrap();
        write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();
        // Plain output with no OSC 133 markers at all -- this session
        // stays in heuristic mode for its whole life.
        write_message(
            &mut stream2,
            &Request::WriteInput { id: id.clone(), data: "echo heuristic_test\n".to_string() },
        )
        .unwrap();

        let mut reader = BufReader::new(stream2.try_clone().unwrap());
        let mut statuses: Vec<String> = Vec::new();
        // HEURISTIC_QUIET_PERIOD is 2 real seconds; give this a generous
        // deadline (this project's tests already accept multi-second real
        // waits for timing-dependent behavior, e.g. the existing OSC 7
        // test's 5-second deadline -- no time-mocking is used anywhere in
        // this codebase).
        let deadline = std::time::Instant::now() + Duration::from_secs(6);
        let mut saw_working_then_idle = false;
        while std::time::Instant::now() < deadline {
            let resp: Response = read_message(&mut reader).unwrap().unwrap();
            if let Response::StatusChanged { id: rid, status } = resp {
                if rid == id {
                    statuses.push(status.clone());
                    if statuses.contains(&"working".to_string()) && status == "idle" {
                        saw_working_then_idle = true;
                        break;
                    }
                }
            }
        }
        assert!(
            saw_working_then_idle,
            "expected a \"working\" StatusChanged followed eventually by \"idle\", got: {statuses:?}"
        );
    }

    #[test]
    fn heuristic_permanently_stops_once_a_real_osc_133_marker_has_been_seen() {
        let (socket_path, _dir) = start_test_server();

        let id = {
            let mut stream = UnixStream::connect(&socket_path).unwrap();
            let created = request(
                &mut stream,
                &Request::CreateSession {
                    workspace_path: "/tmp/ws".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/bin/sh".to_string()),
                },
            );
            match created {
                Response::SessionCreated { id } => id,
                other => panic!("expected SessionCreated, got {other:?}"),
            }
        };

        let mut stream2 = UnixStream::connect(&socket_path).unwrap();
        write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();
        // A real OSC 133 "C" marker, followed by plain output with no
        // further markers -- once this session has seen OSC 133 once,
        // the heuristic must never fire again, even after a full quiet
        // period elapses.
        write_message(
            &mut stream2,
            &Request::WriteInput {
                id: id.clone(),
                data: "printf '\\033]133;C\\007'; echo done_working\n".to_string(),
            },
        )
        .unwrap();

        let mut reader = BufReader::new(stream2.try_clone().unwrap());
        let mut saw_working = false;
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline && !saw_working {
            let resp: Response = read_message(&mut reader).unwrap().unwrap();
            if let Response::StatusChanged { id: rid, status } = resp {
                if rid == id && status == "working" {
                    saw_working = true;
                }
            }
        }
        assert!(saw_working, "never saw the initial \"working\" from the OSC 133 C marker");

        // Wait well past HEURISTIC_QUIET_PERIOD (2s) with no further OSC
        // 133 marker -- if the heuristic incorrectly re-activated, it
        // would fire a spurious "idle" here. Drain anything that arrives
        // in a bounded window afterward and assert none of it is that.
        std::thread::sleep(Duration::from_secs(3));
        reader.get_ref().set_read_timeout(Some(Duration::from_millis(500))).unwrap();
        loop {
            match read_message::<_, Response>(&mut reader) {
                Ok(Some(Response::StatusChanged { id: rid, status })) if rid == id => {
                    assert_ne!(status, "idle", "heuristic fired a spurious idle after OSC 133 was already seen");
                }
                Ok(Some(_)) => continue,
                Ok(None) | Err(_) => break, // nothing more arrived within the timeout, as expected
            }
        }
    }

    #[test]
    fn waiting_for_input_survives_a_full_quiet_period_in_heuristic_mode() {
        let (socket_path, _dir) = start_test_server();

        let id = {
            let mut stream = UnixStream::connect(&socket_path).unwrap();
            let created = request(
                &mut stream,
                &Request::CreateSession {
                    workspace_path: "/tmp/ws".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/bin/sh".to_string()),
                },
            );
            match created {
                Response::SessionCreated { id } => id,
                other => panic!("expected SessionCreated, got {other:?}"),
            }
        };

        let mut stream2 = UnixStream::connect(&socket_path).unwrap();
        write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();
        // No OSC 133 markers at all -- stays in heuristic mode for its
        // whole life. Rings a bare bell, then genuinely blocks on `read`
        // with nothing else printed -- unlike a bare `printf '\007'\n`
        // alone, this doesn't return control to the interactive shell
        // (which would otherwise immediately redraw its own PS1 prompt
        // right after the bell, and that redraw is itself legitimate
        // "renewed output activity" that correctly ends waiting_for_input
        // by this fix's own design -- see HeuristicInner::waiting_for_input's
        // doc comment). This mirrors the real scenario the fix targets:
        // a program (e.g. a confirmation prompt) that dings a bell and
        // then sits fully silent waiting on stdin, with no shell prompt
        // reappearing until the user responds.
        write_message(
            &mut stream2,
            &Request::WriteInput { id: id.clone(), data: "printf '\\007'; read _unused\n".to_string() },
        )
        .unwrap();

        let mut reader = BufReader::new(stream2.try_clone().unwrap());
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut saw_waiting = false;
        while std::time::Instant::now() < deadline && !saw_waiting {
            let resp: Response = read_message(&mut reader).unwrap().unwrap();
            if let Response::StatusChanged { id: rid, status } = resp {
                if rid == id && status == "waiting_for_input" {
                    saw_waiting = true;
                }
            }
        }
        assert!(saw_waiting, "never saw the initial waiting_for_input from the bare BEL");

        // Wait well past HEURISTIC_QUIET_PERIOD (2s) with no further
        // output -- before the fix, the companion thread would silently
        // downgrade this to idle. Drain anything that arrives in a
        // bounded window afterward and assert none of it is that.
        std::thread::sleep(Duration::from_secs(3));
        reader.get_ref().set_read_timeout(Some(Duration::from_millis(500))).unwrap();
        loop {
            match read_message::<_, Response>(&mut reader) {
                Ok(Some(Response::StatusChanged { id: rid, status })) if rid == id => {
                    assert_ne!(status, "idle", "heuristic silently downgraded waiting_for_input to idle after a quiet period");
                }
                Ok(Some(_)) => continue,
                Ok(None) | Err(_) => break,
            }
        }
    }

    fn init_test_repo(dir: &std::path::Path) {
        std::process::Command::new("git").args(["init", "-q"]).current_dir(dir).status().unwrap();
        std::process::Command::new("git").args(["config", "user.email", "test@example.com"]).current_dir(dir).status().unwrap();
        std::process::Command::new("git").args(["config", "user.name", "Test"]).current_dir(dir).status().unwrap();
        std::process::Command::new("git").args(["checkout", "-q", "-b", "main"]).current_dir(dir).status().unwrap();
        std::fs::write(dir.join("file.txt"), "hello").unwrap();
        std::process::Command::new("git").args(["add", "-A"]).current_dir(dir).status().unwrap();
        std::process::Command::new("git").args(["commit", "-q", "-m", "initial"]).current_dir(dir).status().unwrap();
    }

    #[test]
    fn relays_git_status_changed_when_a_session_cwd_reports_a_git_repo() {
        let repo_dir = tempfile::tempdir().unwrap();
        init_test_repo(repo_dir.path());
        let repo_path = repo_dir.path().to_str().unwrap().to_string();

        let (socket_path, _dir) = start_test_server();

        let id = {
            let mut stream = UnixStream::connect(&socket_path).unwrap();
            let created = request(
                &mut stream,
                &Request::CreateSession {
                    workspace_path: "/tmp/ws".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/bin/sh".to_string()),
                },
            );
            match created {
                Response::SessionCreated { id } => id,
                other => panic!("expected SessionCreated, got {other:?}"),
            }
        };

        let mut stream2 = UnixStream::connect(&socket_path).unwrap();
        write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();
        write_message(
            &mut stream2,
            &Request::WriteInput {
                id: id.clone(),
                data: format!("printf '\\033]7;file://host{repo_path}\\007'\n"),
            },
        )
        .unwrap();

        let mut reader = BufReader::new(stream2.try_clone().unwrap());
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let mut found = false;
        while std::time::Instant::now() < deadline {
            let resp: Response = read_message(&mut reader).unwrap().unwrap();
            if let Response::GitStatusChanged { id: rid, status: Some(status) } = resp {
                if rid == id && status.branch == "main" {
                    found = true;
                    break;
                }
            }
        }
        assert!(found, "never saw the expected GitStatusChanged for the session's OSC7-reported repo cwd");
    }

    // Deliberately not testing "exactly one poller was spawned" directly:
    // that would need `start_test_server()` (shared by every test in this
    // file) to also return a handle to the `SessionManager` it constructs,
    // which it currently doesn't -- a broader change to shared test
    // infrastructure than this one property justifies. The dedup-by-repo-
    // root mechanism is an internal efficiency optimization (avoiding
    // redundant `git status` subprocesses), not a user-visible correctness
    // requirement -- even if it were somehow broken, both sessions below
    // would still receive correct status independently, just less
    // efficiently. The test below verifies the behavior that actually
    // matters: two sessions mapped to the same repo both receive
    // consistent, correct status for it.
    #[test]
    fn two_sessions_in_the_same_repo_both_receive_git_status_changed() {
        let repo_dir = tempfile::tempdir().unwrap();
        init_test_repo(repo_dir.path());
        let repo_path = repo_dir.path().to_str().unwrap().to_string();

        let (socket_path, _dir) = start_test_server();

        let make_session = || {
            let mut stream = UnixStream::connect(&socket_path).unwrap();
            let created = request(
                &mut stream,
                &Request::CreateSession {
                    workspace_path: "/tmp/ws".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/bin/sh".to_string()),
                },
            );
            match created {
                Response::SessionCreated { id } => id,
                other => panic!("expected SessionCreated, got {other:?}"),
            }
        };
        let id_a = make_session();
        let id_b = make_session();

        let attach_and_report_cwd = |id: &str| {
            let mut stream = UnixStream::connect(&socket_path).unwrap();
            write_message(&mut stream, &Request::Attach { id: id.to_string() }).unwrap();
            write_message(
                &mut stream,
                &Request::WriteInput {
                    id: id.to_string(),
                    data: format!("printf '\\033]7;file://host{repo_path}\\007'\n"),
                },
            )
            .unwrap();
            stream
        };
        let mut stream_a = attach_and_report_cwd(&id_a);
        let mut stream_b = attach_and_report_cwd(&id_b);

        let wait_for_git_status = |stream: &mut UnixStream, expected_id: &str| {
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            while std::time::Instant::now() < deadline {
                let resp: Response = read_message(&mut reader).unwrap().unwrap();
                if let Response::GitStatusChanged { id: rid, status: Some(status) } = resp {
                    if rid == expected_id {
                        return status;
                    }
                }
            }
            panic!("never saw GitStatusChanged for {expected_id}");
        };
        let status_a = wait_for_git_status(&mut stream_a, &id_a);
        let status_b = wait_for_git_status(&mut stream_b, &id_b);
        assert_eq!(status_a.repo_root, status_b.repo_root);
        assert_eq!(status_a.branch, "main");
        assert_eq!(status_b.branch, "main");
    }

    #[test]
    fn a_session_outside_any_git_repo_never_receives_git_status_changed() {
        let (socket_path, _dir) = start_test_server();

        let id = {
            let mut stream = UnixStream::connect(&socket_path).unwrap();
            let created = request(
                &mut stream,
                &Request::CreateSession {
                    workspace_path: "/tmp/ws".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/bin/sh".to_string()),
                },
            );
            match created {
                Response::SessionCreated { id } => id,
                other => panic!("expected SessionCreated, got {other:?}"),
            }
        };

        let mut stream2 = UnixStream::connect(&socket_path).unwrap();
        write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();
        // /tmp itself is essentially never a git repo -- no OSC7 report
        // needed, the session's own launch cwd already qualifies.
        write_message(&mut stream2, &Request::WriteInput { id: id.clone(), data: "echo no_repo_here\n".to_string() }).unwrap();

        let mut reader = BufReader::new(stream2.try_clone().unwrap());
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        reader.get_ref().set_read_timeout(Some(Duration::from_millis(500))).unwrap();
        let mut saw_output = false;
        loop {
            if std::time::Instant::now() >= deadline {
                break;
            }
            match read_message::<_, Response>(&mut reader) {
                Ok(Some(Response::GitStatusChanged { id: rid, .. })) if rid == id => {
                    panic!("session outside any git repo received a GitStatusChanged");
                }
                Ok(Some(Response::Output { data, .. })) if data.contains("no_repo_here") => {
                    saw_output = true;
                    break;
                }
                Ok(Some(_)) => continue,
                Ok(None) | Err(_) => continue,
            }
        }
        assert!(saw_output, "never even saw the echoed output -- test setup itself may be broken");
    }

    #[test]
    fn attach_sends_a_baseline_git_status_changed_when_a_cached_status_already_exists() {
        let repo_dir = tempfile::tempdir().unwrap();
        init_test_repo(repo_dir.path());
        let repo_path = repo_dir.path().to_str().unwrap().to_string();

        let (socket_path, _dir) = start_test_server();

        let id = {
            let mut stream = UnixStream::connect(&socket_path).unwrap();
            let created = request(
                &mut stream,
                &Request::CreateSession {
                    workspace_path: repo_path.clone(),
                    cwd: repo_path.clone(),
                    command: Some("/bin/sh".to_string()),
                },
            );
            match created {
                Response::SessionCreated { id } => id,
                other => panic!("expected SessionCreated, got {other:?}"),
            }
        };

        // First attach: establishes the repo mapping via attach()'s own
        // update_session_repo_mapping call, and waits for the poller's
        // very first check (spawned in the background) to actually land
        // before detaching, so the SECOND attach below has something
        // real to find already cached.
        {
            let mut stream1 = UnixStream::connect(&socket_path).unwrap();
            write_message(&mut stream1, &Request::Attach { id: id.clone() }).unwrap();
            let mut reader = BufReader::new(stream1.try_clone().unwrap());
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            let mut found = false;
            while std::time::Instant::now() < deadline {
                let resp: Response = read_message(&mut reader).unwrap().unwrap();
                if let Response::GitStatusChanged { id: rid, status: Some(_) } = resp {
                    if rid == id {
                        found = true;
                        break;
                    }
                }
            }
            assert!(found, "first attach never produced a live GitStatusChanged to seed the cache");
        }

        // Second attach, a fresh connection: this is what actually
        // exercises the baseline path (a cache already populated by the
        // first attach above), not a fresh live check.
        let mut stream2 = UnixStream::connect(&socket_path).unwrap();
        write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();
        let mut reader2 = BufReader::new(stream2.try_clone().unwrap());

        let first: Response = read_message(&mut reader2).unwrap().unwrap();
        assert!(matches!(first, Response::CwdChanged { .. }), "expected CwdChanged first, got {first:?}");
        let second: Response = read_message(&mut reader2).unwrap().unwrap();
        assert!(matches!(second, Response::StatusChanged { .. }), "expected StatusChanged second, got {second:?}");
        let third: Response = read_message(&mut reader2).unwrap().unwrap();
        match third {
            Response::GitStatusChanged { id: rid, status: Some(status) } => {
                assert_eq!(rid, id);
                assert_eq!(status.branch, "main");
            }
            other => panic!("expected a baseline GitStatusChanged third, got {other:?}"),
        }
    }

    #[test]
    fn recover_spawns_fresh_shells_for_leftover_registry_entries() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("registry.sqlite");

        // Simulate a previous daemon process: a registry entry exists,
        // but there is no live PTY for it (this new process just started).
        {
            let registry = Registry::open(&db_path).unwrap();
            registry
                .insert(&SessionRecord {
                    id: "leftover-1".to_string(),
                    workspace_path: "/tmp".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/bin/sh".to_string()),
                    status: SessionStatus::Idle,
                    restored: false,
                    generation: 0,
                    interrupted: false,
                })
                .unwrap();
        }

        let registry = Registry::open(&db_path).unwrap();
        let kanban = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        let manager = SessionManager::new(registry, kanban, test_orchestration_store());

        manager.recover().unwrap();

        let sessions = manager.list_sessions().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "leftover-1");
        assert_eq!(sessions[0].restored, true);

        // The recovered session must have a real, live PTY behind it.
        manager
            .write_input("leftover-1", b"echo recovered_ok\n")
            .unwrap();
        let mut reader = manager.reader_for("leftover-1").unwrap();

        let mut collected = String::new();
        let mut buf = [0u8; 4096];
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !collected.contains("recovered_ok") {
            let n = reader.read(&mut buf).unwrap();
            collected.push_str(&String::from_utf8_lossy(&buf[..n]));
            assert!(std::time::Instant::now() < deadline, "got: {collected}");
        }
    }

    /// A registry row exactly as a killed daemon would have left it: no
    /// live PTY, at whatever status it was last seen in, and stamped with
    /// a previous generation because the `Registry` that wrote it has
    /// been closed.
    fn leftover_row(
        db_path: &std::path::Path,
        id: &str,
        cwd: &str,
        command: Option<&str>,
        status: SessionStatus,
    ) {
        let registry = Registry::open(db_path).unwrap();
        registry
            .insert(&SessionRecord {
                id: id.to_string(),
                workspace_path: "/tmp".to_string(),
                cwd: cwd.to_string(),
                command: command.map(|c| c.to_string()),
                status,
                restored: false,
                generation: 0,
                interrupted: false,
            })
            .unwrap();
    }

    fn recovered_manager(dir: &tempfile::TempDir) -> SessionManager {
        let manager = SessionManager::new(
            Registry::open(&dir.path().join("registry.sqlite")).unwrap(),
            KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap(),
            test_orchestration_store(),
        );
        manager.recover().unwrap();
        manager
    }

    /// Reads from a recovered session until `needle` shows up, or gives
    /// up. Proves there is a real interactive shell behind the id rather
    /// than merely a registry row.
    fn shell_echoes(manager: &SessionManager, id: &str, needle: &str) -> bool {
        manager.write_input(id, format!("echo {needle}\n").as_bytes()).unwrap();
        let mut reader = manager.reader_for(id).unwrap();
        let mut collected = String::new();
        let mut buf = [0u8; 4096];
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while std::time::Instant::now() < deadline {
            let Ok(n) = reader.read(&mut buf) else { break };
            if n == 0 {
                break;
            }
            collected.push_str(&String::from_utf8_lossy(&buf[..n]));
            // The echo of the typed line contains the needle too, so the
            // marker is assembled at runtime by the shell instead.
            if collected.matches(needle).count() > 1 {
                return true;
            }
        }
        false
    }

    #[test]
    fn recover_never_re_runs_an_agents_command_and_says_so_on_the_record() {
        // The bug this whole epoch exists for. `command` is the entire
        // task for every agent gavin starts, so re-running it is a
        // second from-scratch attempt in a checkout that already carries
        // the first attempt's edits -- and, since a child that ignores
        // SIGHUP survives its daemon, possibly alongside the first agent
        // still working. The marker file is the witness: if recovery ran
        // the command, it exists.
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("the-command-ran");
        let command = format!("touch {}; sleep 30", marker.display());
        leftover_row(
            &dir.path().join("registry.sqlite"),
            "agent-1",
            "/tmp",
            Some(&command),
            SessionStatus::Working,
        );

        let manager = recovered_manager(&dir);

        // Generous: the spawn is async, so give a re-run every chance to
        // betray itself before concluding it did not happen.
        std::thread::sleep(Duration::from_millis(500));
        assert!(
            !marker.exists(),
            "recovery re-ran the agent's command — a second from-scratch attempt at the same work"
        );
        let summary = &manager.list_sessions().unwrap()[0];
        assert_eq!(summary.id, "agent-1");
        assert_eq!(summary.restored, true);
        assert_eq!(summary.interrupted, true, "the record must say the run was killed, not merely restored");
        assert!(
            shell_echoes(&manager, "agent-1", "recovered_shell_ok"),
            "an interrupted agent session must come back as a usable bare shell"
        );
    }

    #[test]
    fn recover_resets_an_interrupted_rows_status_so_a_bare_shell_never_reads_as_working() {
        // Attach replays the stored status as its baseline. The stored
        // one describes the agent that was working; what is here now is a
        // shell at a prompt.
        let dir = tempfile::tempdir().unwrap();
        leftover_row(
            &dir.path().join("registry.sqlite"),
            "agent-2",
            "/tmp",
            Some("sleep 30"),
            SessionStatus::WaitingForInput,
        );

        let manager = recovered_manager(&dir);

        assert_eq!(
            manager.registry.lock().unwrap().get("agent-2").unwrap().unwrap().status,
            SessionStatus::Idle
        );
    }

    #[test]
    fn recover_brings_a_plain_terminal_session_back_exactly_as_it_always_did() {
        // The other half of the rule: a session with no command has no
        // run to have been interrupted, so nothing about it changes and
        // nothing claims otherwise.
        let dir = tempfile::tempdir().unwrap();
        leftover_row(
            &dir.path().join("registry.sqlite"),
            "shell-1",
            "/tmp",
            None,
            SessionStatus::Working,
        );

        let manager = recovered_manager(&dir);

        let summary = &manager.list_sessions().unwrap()[0];
        assert_eq!(summary.restored, true);
        assert_eq!(summary.interrupted, false, "a plain terminal session was never running a task");
        assert_eq!(summary.status, "working", "its status is left for its next prompt to correct");
        assert!(shell_echoes(&manager, "shell-1", "plain_shell_ok"));
    }

    #[test]
    fn recover_spawns_in_the_sessions_own_cwd_not_the_workspace_root() {
        // create_session has always spawned in `cwd` while recover spawned
        // in `workspace_path`; the app passes the same value for both, so
        // this was right by coincidence. A session that had cd'd
        // elsewhere came back at the workspace root while Attach kept
        // reporting the cwd it no longer had.
        let dir = tempfile::tempdir().unwrap();
        let elsewhere = dir.path().join("elsewhere");
        std::fs::create_dir(&elsewhere).unwrap();
        // Symlinks (/tmp -> /private/tmp on macOS) make the shell's own
        // $PWD the only reliable answer, so compare against what the
        // shell reports for the same path.
        leftover_row(
            &dir.path().join("registry.sqlite"),
            "moved-1",
            elsewhere.to_str().unwrap(),
            Some("sleep 30"),
            SessionStatus::Working,
        );

        let manager = recovered_manager(&dir);

        assert!(
            shell_echoes(&manager, "moved-1", "$PWD"),
            "the recovered shell should print a directory at all"
        );
        manager.write_input("moved-1", b"case \"$PWD\" in *elsewhere) echo CWDMARK_yes;; *) echo CWDMARK_no;; esac\n").unwrap();
        let mut reader = manager.reader_for("moved-1").unwrap();
        let mut collected = String::new();
        let mut buf = [0u8; 4096];
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while std::time::Instant::now() < deadline && collected.matches("CWDMARK_").count() < 2 {
            let Ok(n) = reader.read(&mut buf) else { break };
            if n == 0 {
                break;
            }
            collected.push_str(&String::from_utf8_lossy(&buf[..n]));
        }
        assert!(
            collected.contains("CWDMARK_yes"),
            "recovery must land in the session's own cwd, got: {collected}"
        );
    }

    #[test]
    fn recover_leaves_a_row_from_its_own_lifetime_completely_alone() {
        // The epoch's whole point: a row at the current generation is one
        // this very process is hosting. Recovering it would spawn a
        // SECOND PTY over a live session.
        let dir = tempfile::tempdir().unwrap();
        let manager = SessionManager::new(
            Registry::open(&dir.path().join("registry.sqlite")).unwrap(),
            KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap(),
            test_orchestration_store(),
        );
        let id = manager.create_session("/tmp", "/tmp", Some("sleep 30")).unwrap();

        manager.recover().unwrap();

        let summary = &manager.list_sessions().unwrap()[0];
        assert_eq!(summary.id, id);
        assert_eq!(summary.restored, false, "a session this process is hosting was never restored");
        assert_eq!(summary.interrupted, false);
    }

    #[test]
    fn attach_announces_an_interrupted_session_alongside_the_restored_marker() {
        // The signal every surface consults. It rides Attach, like
        // SessionRestored, so a frontend that reloads gets it again.
        let dir = tempfile::tempdir().unwrap();
        leftover_row(
            &dir.path().join("registry.sqlite"),
            "agent-3",
            "/tmp",
            Some("sleep 30"),
            SessionStatus::Working,
        );
        let manager = Arc::new(recovered_manager(&dir));

        let (client, server_side) = UnixStream::pair().unwrap();
        client.set_read_timeout(Some(Duration::from_millis(500))).unwrap();
        manager.attach("agent-3", Arc::new(Mutex::new(server_side)));

        let mut reader = BufReader::new(client);
        let mut saw_restored = false;
        let mut saw_interrupted = false;
        while let Ok(Some(msg)) = read_message::<_, Response>(&mut reader) {
            match msg {
                Response::SessionRestored { .. } => saw_restored = true,
                Response::SessionInterrupted { id } => {
                    assert_eq!(id, "agent-3");
                    saw_interrupted = true;
                    break;
                }
                _ => continue,
            }
        }
        assert!(saw_restored, "SessionRestored must still be sent — every existing consumer reads it");
        assert!(saw_interrupted, "an interrupted session must announce itself on Attach");
    }

    #[test]
    fn attach_never_calls_a_merely_restored_session_interrupted() {
        let dir = tempfile::tempdir().unwrap();
        leftover_row(
            &dir.path().join("registry.sqlite"),
            "shell-2",
            "/tmp",
            None,
            SessionStatus::Idle,
        );
        let manager = Arc::new(recovered_manager(&dir));

        let (client, server_side) = UnixStream::pair().unwrap();
        client.set_read_timeout(Some(Duration::from_millis(500))).unwrap();
        manager.attach("shell-2", Arc::new(Mutex::new(server_side)));

        let mut reader = BufReader::new(client);
        while let Ok(Some(msg)) = read_message::<_, Response>(&mut reader) {
            assert!(
                !matches!(msg, Response::SessionInterrupted { .. }),
                "a plain terminal session's recovery must not read as an interrupted run"
            );
        }
    }

    /// A `SessionManager` with nothing else attached to it, for the tests
    /// below that drive `trigger_recheck`/`attach` directly rather than
    /// over the socket.
    fn bare_manager(dir: &tempfile::TempDir) -> Arc<SessionManager> {
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        let kanban = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        Arc::new(SessionManager::new(registry, kanban, test_orchestration_store()))
    }

    fn bare_poller() -> Arc<RepoPoller> {
        Arc::new(RepoPoller {
            checking: AtomicBool::new(false),
            inner: Mutex::new(RepoPollerInner {
                mapped_sessions: HashSet::new(),
                last_status: None,
                last_checked: None,
            }),
            debouncer: Mutex::new(None),
        })
    }

    #[test]
    fn trigger_recheck_waits_out_the_minimum_interval_before_running_a_second_check() {
        let repo_dir = tempfile::tempdir().unwrap();
        init_test_repo(repo_dir.path());
        let repo_root = repo_dir.path().to_str().unwrap();

        let dir = tempfile::tempdir().unwrap();
        let manager = bare_manager(&dir);
        let poller = bare_poller();

        // The very first check for a repo root has no previous check to
        // pace itself against, so it must not wait at all.
        let started = std::time::Instant::now();
        trigger_recheck(&manager, repo_root, &poller);
        let first_elapsed = started.elapsed();
        assert!(
            first_elapsed < Duration::from_secs(2),
            "the first check for a repo root must not wait out any floor, but took {first_elapsed:?}"
        );

        // The second one, immediately after, must sleep out the remainder
        // of MIN_RECHECK_INTERVAL rather than firing another `git status`
        // straight away (and must not skip the check outright either --
        // it still updates last_checked, asserted below).
        let started = std::time::Instant::now();
        trigger_recheck(&manager, repo_root, &poller);
        let second_elapsed = started.elapsed();
        assert!(
            second_elapsed >= MIN_RECHECK_INTERVAL - Duration::from_millis(250),
            "a second check within MIN_RECHECK_INTERVAL must wait it out, but returned after {second_elapsed:?}"
        );
        assert!(
            poller.inner.lock().unwrap().last_checked.is_some(),
            "the check must still have actually run after the wait"
        );
    }

    #[test]
    fn trigger_recheck_does_not_re_emit_an_unchanged_status() {
        let repo_dir = tempfile::tempdir().unwrap();
        init_test_repo(repo_dir.path());
        let repo_root = repo_dir.path().to_str().unwrap();

        let dir = tempfile::tempdir().unwrap();
        let manager = bare_manager(&dir);
        let poller = bare_poller();

        // A session mapped to this root with a live "client" on the other
        // end of a socketpair, so emitted responses are directly readable.
        let (client, server_side) = UnixStream::pair().unwrap();
        // Set before anything can close the far end: on macOS,
        // SO_RCVTIMEO on a socketpair whose peer has already been dropped
        // fails with EINVAL.
        client.set_read_timeout(Some(Duration::from_millis(500))).unwrap();
        poller.inner.lock().unwrap().mapped_sessions.insert("s1".to_string());
        manager
            .attached_writers
            .lock()
            .unwrap()
            .insert("s1".to_string(), Arc::new(Mutex::new(server_side)));

        // Two checks back to back with nothing touching the repo in
        // between: identical results, so only the first is an actual
        // change and only it may be emitted.
        trigger_recheck(&manager, repo_root, &poller);
        trigger_recheck(&manager, repo_root, &poller);

        let mut reader = BufReader::new(client);
        let mut emitted = 0;
        loop {
            match read_message::<_, Response>(&mut reader) {
                Ok(Some(Response::GitStatusChanged { status: Some(status), .. })) => {
                    assert_eq!(status.branch, "main");
                    emitted += 1;
                }
                Ok(Some(_)) => continue,
                Ok(None) | Err(_) => break,
            }
        }
        assert_eq!(emitted, 1, "an unchanged status must not be re-emitted on every recheck");
    }

    #[test]
    fn a_session_that_leaves_a_git_repo_receives_a_git_status_changed_with_no_status() {
        let repo_dir = tempfile::tempdir().unwrap();
        init_test_repo(repo_dir.path());
        let repo_path = repo_dir.path().to_str().unwrap().to_string();
        // A directory that is deliberately not a repo, and not under one.
        let plain_dir = tempfile::tempdir().unwrap();
        let plain_path = plain_dir.path().to_str().unwrap().to_string();

        let (socket_path, _dir) = start_test_server();

        let id = {
            let mut stream = UnixStream::connect(&socket_path).unwrap();
            let created = request(
                &mut stream,
                &Request::CreateSession {
                    workspace_path: plain_path.clone(),
                    cwd: plain_path.clone(),
                    command: Some("/bin/sh".to_string()),
                },
            );
            match created {
                Response::SessionCreated { id } => id,
                other => panic!("expected SessionCreated, got {other:?}"),
            }
        };

        let mut stream2 = UnixStream::connect(&socket_path).unwrap();
        write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();
        write_message(
            &mut stream2,
            &Request::WriteInput {
                id: id.clone(),
                data: format!("printf '\\033]7;file://host{repo_path}\\007'\n"),
            },
        )
        .unwrap();

        // First get into the repo, so there is a stale indicator to clear.
        let mut reader = BufReader::new(stream2.try_clone().unwrap());
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let mut in_repo = false;
        while std::time::Instant::now() < deadline && !in_repo {
            let resp: Response = read_message(&mut reader).unwrap().unwrap();
            if let Response::GitStatusChanged { id: rid, status: Some(_) } = resp {
                in_repo = rid == id;
            }
        }
        assert!(in_repo, "never saw the session's status for the repo it moved into");

        // Now leave it entirely.
        write_message(
            &mut stream2,
            &Request::WriteInput {
                id: id.clone(),
                data: format!("printf '\\033]7;file://host{plain_path}\\007'\n"),
            },
        )
        .unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let mut cleared = false;
        while std::time::Instant::now() < deadline && !cleared {
            let resp: Response = read_message(&mut reader).unwrap().unwrap();
            if let Response::GitStatusChanged { id: rid, status: None } = resp {
                cleared = rid == id;
            }
        }
        assert!(
            cleared,
            "a session that cd'd out of a git repo never received GitStatusChanged{{status: None}}, \
             so its client could never clear the stale indicator"
        );
    }

    #[test]
    fn killing_a_session_frees_its_screen() {
        let dir = tempfile::tempdir().unwrap();
        let manager = bare_manager(&dir);
        let id = manager.create_session("/tmp", "/tmp", Some("/bin/sh")).unwrap();

        // Attaching spawns the pump, which is what creates the screen.
        let (client, server_side) = UnixStream::pair().unwrap();
        client.set_read_timeout(Some(Duration::from_millis(500))).unwrap();
        manager.attach(&id, Arc::new(Mutex::new(server_side)));

        // Drive some output and wait for it to reach the SCREEN, not merely
        // for the map key to appear -- the pump creates its entry before it
        // reads a single byte, so a key-only precondition would hold even if
        // nothing were ever fed in, and this test would prove nothing.
        manager.write_input(&id, b"echo hello\n").unwrap();
        let painted = |id: &str| {
            manager.screens.lock().unwrap().get(id).is_some_and(|s| {
                String::from_utf8_lossy(&s.lock().unwrap().snapshot()).contains("hello")
            })
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline && !painted(&id) {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            painted(&id),
            "precondition: the pump should have painted this session's output onto its screen"
        );

        manager.kill_session(&id).unwrap();

        // The pump notices the closed pty and tears down asynchronously.
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if !manager.screens.lock().unwrap().contains_key(&id) {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            !manager.screens.lock().unwrap().contains_key(&id),
            "the screen model -- grid plus scrollback, the largest thing held \
             per session -- must be dropped on teardown, not leaked for the \
             daemon's lifetime"
        );
    }

    #[test]
    fn a_session_that_moves_between_repos_receives_the_new_repos_git_status() {
        let repo_a = tempfile::tempdir().unwrap();
        init_test_repo(repo_a.path());
        let repo_a_path = repo_a.path().to_str().unwrap().to_string();
        let repo_b = tempfile::tempdir().unwrap();
        init_test_repo(repo_b.path());
        let repo_b_path = repo_b.path().to_str().unwrap().to_string();
        let plain_dir = tempfile::tempdir().unwrap();
        let plain_path = plain_dir.path().to_str().unwrap().to_string();

        let (socket_path, _dir) = start_test_server();

        let make_session = |cwd: &str| {
            let mut stream = UnixStream::connect(&socket_path).unwrap();
            let created = request(
                &mut stream,
                &Request::CreateSession {
                    workspace_path: cwd.to_string(),
                    cwd: cwd.to_string(),
                    command: Some("/bin/sh".to_string()),
                },
            );
            match created {
                Response::SessionCreated { id } => id,
                other => panic!("expected SessionCreated, got {other:?}"),
            }
        };
        let attach = |id: &str| {
            let stream = UnixStream::connect(&socket_path).unwrap();
            write_message(&mut &stream, &Request::Attach { id: id.to_string() }).unwrap();
            stream
        };
        let report_cwd = |stream: &UnixStream, id: &str, path: &str| {
            write_message(
                &mut &*stream,
                &Request::WriteInput {
                    id: id.to_string(),
                    data: format!("printf '\\033]7;file://host{path}\\007'\n"),
                },
            )
            .unwrap();
        };
        let wait_for_status_in = |reader: &mut BufReader<UnixStream>, id: &str, root: &std::path::Path| {
            let want = std::fs::canonicalize(root).unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(15);
            while std::time::Instant::now() < deadline {
                let resp: Response = read_message(reader).unwrap().unwrap();
                if let Response::GitStatusChanged { id: rid, status: Some(status) } = resp {
                    if rid == id && std::fs::canonicalize(&status.repo_root).unwrap() == want {
                        return;
                    }
                }
            }
            panic!("never saw a GitStatusChanged for {id} reporting repo root {want:?}");
        };

        // Session B goes into repo B first, purely so repo B's poller
        // already has a cached status by the time session A arrives.
        let id_b = make_session(&plain_path);
        let stream_b = attach(&id_b);
        report_cwd(&stream_b, &id_b, &repo_b_path);
        let mut reader_b = BufReader::new(stream_b.try_clone().unwrap());
        wait_for_status_in(&mut reader_b, &id_b, repo_b.path());

        // Session A starts out in repo A...
        let id_a = make_session(&plain_path);
        let stream_a = attach(&id_a);
        report_cwd(&stream_a, &id_a, &repo_a_path);
        let mut reader_a = BufReader::new(stream_a.try_clone().unwrap());
        wait_for_status_in(&mut reader_a, &id_a, repo_a.path());

        // ...and then moves straight into repo B, which must produce a
        // GitStatusChanged carrying repo B's status -- repo B's poller
        // fires no fresh check for a session merely joining it, so
        // without the mapping-change notification nothing would ever tell
        // session A's client it is now looking at a different repo.
        report_cwd(&stream_a, &id_a, &repo_b_path);
        wait_for_status_in(&mut reader_a, &id_a, repo_b.path());
    }

    #[test]
    fn attaching_to_a_session_with_no_live_pty_leaves_no_repo_mapping_or_poller_behind() {
        // A registry row whose `sessions` entry is missing -- what a
        // failed recovery spawn leaves behind -- at a non-Exited status,
        // so attach()'s Exited gate does not apply: the mapping gets
        // established, a poller gets spawned, and then the pump's
        // reader_for call fails. Without the error arm's own
        // unregister_session_repo_mapping, both leak permanently, once
        // per attach.
        let repo_dir = tempfile::tempdir().unwrap();
        init_test_repo(repo_dir.path());
        let repo_path = repo_dir.path().to_str().unwrap().to_string();

        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("registry.sqlite");
        {
            let registry = Registry::open(&db_path).unwrap();
            registry
                .insert(&SessionRecord {
                    id: "failed-spawn-1".to_string(),
                    workspace_path: repo_path.clone(),
                    cwd: repo_path.clone(),
                    command: Some("/bin/sh".to_string()),
                    status: SessionStatus::Idle,
                    restored: false,
                    generation: 0,
                    interrupted: false,
                })
                .unwrap();
        }

        // Deliberately NOT recovered: the row exists, no PTY does. Held
        // this way rather than via a spawn that fails, because a launch
        // command is a shell command line now (PtySession::spawn) -- an
        // unresolvable program no longer fails the spawn, it makes the
        // shell exit 127.
        let manager = Arc::new(SessionManager::new(
            Registry::open(&db_path).unwrap(),
            KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap(),
            test_orchestration_store(),
        ));
        assert!(
            manager.sessions.lock().unwrap().get("failed-spawn-1").is_none(),
            "test premise broken: this session must have no live PTY"
        );

        let (client, server_side) = UnixStream::pair().unwrap();
        // Set before attach, not after: the pump's error arm drops the
        // far end of this pair, and on macOS SO_RCVTIMEO on a socketpair
        // whose peer has already been dropped fails with EINVAL.
        client.set_read_timeout(Some(Duration::from_millis(500))).unwrap();
        manager.attach("failed-spawn-1", Arc::new(Mutex::new(server_side)));

        // The pump thread's error arm runs asynchronously, so poll for it.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let mapped = manager.session_repo_root.lock().unwrap().contains_key("failed-spawn-1");
            let pollers = manager.repo_pollers.lock().unwrap().len();
            if !mapped && pollers == 0 {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "attach to a session with no live PTY leaked its repo mapping ({mapped}) \
                 and/or {pollers} poller(s)"
            );
            std::thread::sleep(Duration::from_millis(25));
        }

        // And nothing git-status-shaped was ever sent to this client.
        let mut reader = BufReader::new(client);
        loop {
            match read_message::<_, Response>(&mut reader) {
                Ok(Some(Response::GitStatusChanged { .. })) => {
                    panic!("a session with no live PTY received a GitStatusChanged");
                }
                Ok(Some(_)) => continue,
                Ok(None) | Err(_) => break,
            }
        }
    }

    #[test]
    fn recover_marks_a_failed_spawn_record_exited_instead_of_leaving_it_stale() {
        use std::os::unix::fs::PermissionsExt;

        // The spawn failure is induced with a workspace directory that
        // exists (so recover()'s own is_dir gate lets it through) but
        // cannot be entered, which is what is left of this arm now that a
        // launch command goes through `sh -c`: an unresolvable program
        // makes the shell exit 127 rather than failing the spawn, so the
        // reachable failures are the environmental ones -- chdir refused,
        // no /bin/sh, fds exhausted.
        let dir = tempfile::tempdir().unwrap();
        let unenterable = dir.path().join("locked-workspace");
        std::fs::create_dir(&unenterable).unwrap();
        std::fs::set_permissions(&unenterable, std::fs::Permissions::from_mode(0o000)).unwrap();
        let unenterable_path = unenterable.to_str().unwrap().to_string();
        // root ignores the permission bits, so there would be nothing to
        // assert; the tempdir is cleaned up by the guard either way.
        if std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg("exit 0")
            .current_dir(&unenterable)
            .status()
            .is_ok()
        {
            let _ = std::fs::set_permissions(&unenterable, std::fs::Permissions::from_mode(0o700));
            eprintln!("skipping: this user can enter a mode-000 directory (running as root?)");
            return;
        }

        let db_path = dir.path().join("registry.sqlite");
        {
            let registry = Registry::open(&db_path).unwrap();
            registry
                .insert(&SessionRecord {
                    id: "failed-spawn-2".to_string(),
                    workspace_path: unenterable_path.clone(),
                    cwd: unenterable_path.clone(),
                    command: Some("/bin/sh".to_string()),
                    status: SessionStatus::Idle,
                    restored: false,
                    generation: 0,
                    interrupted: false,
                })
                .unwrap();
        }

        let manager = SessionManager::new(
            Registry::open(&db_path).unwrap(),
            KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap(),
            test_orchestration_store(),
        );
        manager.recover().unwrap();
        std::fs::set_permissions(&unenterable, std::fs::Permissions::from_mode(0o700)).unwrap();

        assert!(
            manager.sessions.lock().unwrap().get("failed-spawn-2").is_none(),
            "test premise broken: the spawn was expected to fail"
        );
        assert_eq!(
            manager.registry.lock().unwrap().get("failed-spawn-2").unwrap().unwrap().status,
            SessionStatus::Exited,
            "a failed-spawn record must now be marked Exited, not left at its pre-crash status"
        );
    }

    #[test]
    fn recover_marks_a_missing_workspace_path_record_exited_instead_of_leaving_it_stale() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("registry.sqlite");
        {
            let registry = Registry::open(&db_path).unwrap();
            registry
                .insert(&SessionRecord {
                    id: "missing-workspace-1".to_string(),
                    workspace_path: "/definitely/does/not/exist/anywhere".to_string(),
                    cwd: "/definitely/does/not/exist/anywhere".to_string(),
                    command: Some("/bin/sh".to_string()),
                    status: SessionStatus::Working,
                    restored: false,
                    generation: 0,
                    interrupted: false,
                })
                .unwrap();
        }

        let manager = SessionManager::new(
            Registry::open(&db_path).unwrap(),
            KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap(),
            test_orchestration_store(),
        );
        manager.recover().unwrap();

        assert!(manager.sessions.lock().unwrap().get("missing-workspace-1").is_none());
        assert_eq!(
            manager.registry.lock().unwrap().get("missing-workspace-1").unwrap().unwrap().status,
            SessionStatus::Exited,
            "a record whose workspace_path no longer exists must also be marked Exited"
        );
    }

    #[test]
    fn attach_to_a_registry_record_with_no_live_pty_sends_a_scoped_session_exited_not_a_bare_error() {
        // Constructs the general "registry says alive, no live process"
        // case directly, independent of any specific real-world cause --
        // recover()'s own two failure-to-recover avenues are now closed by
        // the fixes above (both mark the record Exited immediately), so
        // this is the defensive path spawn_pump's error arm exists for
        // regardless of how it's reached (a future, currently
        // unanticipated cause; a narrow timing race; etc.).
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("registry.sqlite");
        {
            let registry = Registry::open(&db_path).unwrap();
            registry
                .insert(&SessionRecord {
                    id: "no-live-pty-1".to_string(),
                    workspace_path: "/tmp".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/bin/sh".to_string()),
                    status: SessionStatus::Idle,
                    restored: false,
                    generation: 0,
                    interrupted: false,
                })
                .unwrap();
        }
        let manager = Arc::new(SessionManager::new(
            Registry::open(&db_path).unwrap(),
            KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap(),
            test_orchestration_store(),
        ));
        // No recover() call -- `sessions` genuinely has no entry for this
        // id, simulating whatever unanticipated cause reaches this arm.

        let (client, server_side) = UnixStream::pair().unwrap();
        // Set before attach, not after: the pump's error arm drops the far
        // end of this pair, and on macOS SO_RCVTIMEO on a socketpair whose
        // peer has already been dropped fails with EINVAL.
        client.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        manager.attach("no-live-pty-1", Arc::new(Mutex::new(server_side)));

        let mut reader = BufReader::new(client);
        let mut saw_scoped_exit = false;
        loop {
            match read_message::<_, Response>(&mut reader) {
                Ok(Some(Response::SessionExited { id, exit_code })) if id == "no-live-pty-1" => {
                    assert_eq!(exit_code, ATTACH_FAILURE_EXIT_CODE);
                    saw_scoped_exit = true;
                    break;
                }
                Ok(Some(Response::Error { message })) => {
                    panic!("expected a scoped SessionExited, got a bare Error: {message}");
                }
                Ok(Some(_)) => continue,
                Ok(None) | Err(_) => break,
            }
        }
        assert!(saw_scoped_exit, "never received a scoped SessionExited for the failed attach");

        // And it self-heals: the registry now reflects Exited too, so the
        // *next* launch's reconciliation (Task 3) can cleanly replace it.
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            let status = manager.registry.lock().unwrap().get("no-live-pty-1").unwrap().unwrap().status;
            if status == SessionStatus::Exited {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "registry never self-healed to Exited");
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    #[test]
    fn attach_sends_a_session_restored_baseline_right_after_cwd_changed_when_restored_is_true() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("registry.sqlite");
        {
            let registry = Registry::open(&db_path).unwrap();
            registry
                .insert(&SessionRecord {
                    id: "restored-1".to_string(),
                    workspace_path: "/tmp".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/bin/sh".to_string()),
                    status: SessionStatus::Idle,
                    restored: true,
                    generation: 0,
                    interrupted: false,
                })
                .unwrap();
        }
        let manager = Arc::new(SessionManager::new(
            Registry::open(&db_path).unwrap(),
            KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap(),
            test_orchestration_store(),
        ));

        let (client, server_side) = UnixStream::pair().unwrap();
        client.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        manager.attach("restored-1", Arc::new(Mutex::new(server_side)));

        let mut reader = BufReader::new(client);
        let first: Response = read_message(&mut reader).unwrap().unwrap();
        assert!(matches!(first, Response::CwdChanged { .. }), "expected CwdChanged first, got {first:?}");
        let second: Response = read_message(&mut reader).unwrap().unwrap();
        match second {
            Response::SessionRestored { id } => assert_eq!(id, "restored-1"),
            other => panic!("expected SessionRestored right after CwdChanged, got {other:?}"),
        }
    }

    #[test]
    fn attach_never_sends_session_restored_when_restored_is_false() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("registry.sqlite");
        {
            let registry = Registry::open(&db_path).unwrap();
            registry
                .insert(&SessionRecord {
                    id: "not-restored-1".to_string(),
                    workspace_path: "/tmp".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/bin/sh".to_string()),
                    status: SessionStatus::Idle,
                    restored: false,
                    generation: 0,
                    interrupted: false,
                })
                .unwrap();
        }
        let manager = Arc::new(SessionManager::new(
            Registry::open(&db_path).unwrap(),
            KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap(),
            test_orchestration_store(),
        ));

        let (client, server_side) = UnixStream::pair().unwrap();
        client.set_read_timeout(Some(Duration::from_millis(500))).unwrap();
        manager.attach("not-restored-1", Arc::new(Mutex::new(server_side)));

        let mut reader = BufReader::new(client);
        loop {
            match read_message::<_, Response>(&mut reader) {
                Ok(Some(Response::SessionRestored { .. })) => {
                    panic!("SessionRestored must never be sent when restored is false");
                }
                Ok(Some(_)) => continue,
                Ok(None) | Err(_) => break,
            }
        }
    }

    #[test]
    fn write_input_clears_the_restored_flag() {
        // Drives SessionManager directly rather than over the socket: a
        // session created via Request::CreateSession is always fresh and
        // never restored, so `restored: true` needs to be established
        // directly first, which only the in-process manager makes
        // convenient.
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("registry.sqlite");
        let manager = SessionManager::new(
            Registry::open(&db_path).unwrap(),
            KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap(),
            test_orchestration_store(),
        );
        let id = manager.create_session("/tmp", "/tmp", Some("/bin/sh")).unwrap();
        manager.registry.lock().unwrap().mark_restored(&id).unwrap();
        assert_eq!(
            manager.registry.lock().unwrap().get(&id).unwrap().unwrap().restored,
            true,
            "test premise broken: mark_restored should have set restored"
        );

        manager.write_input(&id, b"echo hi\n").unwrap();

        assert_eq!(
            manager.registry.lock().unwrap().get(&id).unwrap().unwrap().restored,
            false,
            "write_input must clear the restored flag"
        );
    }

    #[test]
    fn recover_falls_back_to_workspace_path_when_the_live_tracked_cwd_is_gone() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("registry.sqlite");

        // Recovery spawns in the session's OWN cwd now (recovery_cwd), so
        // this is the fallback rather than the rule: a live-tracked cwd
        // (via OSC 7) that drifted into a directory the human has since
        // deleted must not cost them the session. The stable
        // workspace_path takes over, exactly as it always did.
        {
            let registry = Registry::open(&db_path).unwrap();
            registry
                .insert(&SessionRecord {
                    id: "leftover-2".to_string(),
                    workspace_path: "/tmp".to_string(),
                    cwd: "/tmp/this-directory-does-not-exist-xyz".to_string(),
                    command: Some("/bin/sh".to_string()),
                    status: SessionStatus::Idle,
                    restored: false,
                    generation: 0,
                    interrupted: false,
                })
                .unwrap();
        }

        let registry = Registry::open(&db_path).unwrap();
        let kanban = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        let manager = SessionManager::new(registry, kanban, test_orchestration_store());

        manager.recover().unwrap();

        let sessions = manager.list_sessions().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(
            sessions[0].restored, true,
            "session should have been recovered despite its stale live-tracked cwd"
        );
    }
}
