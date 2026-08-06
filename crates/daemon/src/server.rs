use protocol::{read_message, write_message, Board, Column, GitStatus, Label, Request, Response, SessionSummary};
use crate::kanban::KanbanStore;
use crate::osc::OscCwdScanner;
use crate::pty::PtySession;
use crate::registry::{Registry, SessionRecord, SessionStatus};
use crate::status::{StatusEvent, StatusScanner, HEURISTIC_QUIET_PERIOD};
use notify_debouncer_mini::Debouncer;
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use uuid::Uuid;

/// Cap on how much recent output is retained per session for replay to a
/// client that reattaches after missing it (e.g. app closed, daemon still
/// running). A rolling window, not a per-attach diff — every Attach replays
/// whatever's currently buffered, regardless of what a previous Attach saw.
const OUTPUT_BUFFER_CAP: usize = 64 * 1024;

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
    sessions: Mutex<HashMap<String, PtySession>>,
    attached_writers: Mutex<HashMap<String, Arc<Mutex<UnixStream>>>>,
    output_buffers: Mutex<HashMap<String, VecDeque<u8>>>,
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
    pub fn new(registry: Registry, kanban: KanbanStore) -> Self {
        Self {
            registry: Mutex::new(registry),
            kanban: Mutex::new(kanban),
            sessions: Mutex::new(HashMap::new()),
            attached_writers: Mutex::new(HashMap::new()),
            output_buffers: Mutex::new(HashMap::new()),
            repo_pollers: Mutex::new(HashMap::new()),
            session_repo_root: Mutex::new(HashMap::new()),
            gavin_watchers: Mutex::new(HashMap::new()),
        }
    }

    pub fn watch_gavin_root(
        &self,
        workspace_id: &str,
        root_path: &str,
        writer: Arc<Mutex<UnixStream>>,
    ) {
        let watcher = crate::gavin::GavinWatcher::start(
            workspace_id.to_string(),
            std::path::PathBuf::from(root_path),
            writer,
        );
        // Insert AFTER start: the old watcher (if any) drops here, tearing
        // down its debouncer thread.
        self.gavin_watchers.lock().unwrap().insert(workspace_id.to_string(), watcher);
    }

    pub fn unwatch_gavin_root(&self, workspace_id: &str) {
        self.gavin_watchers.lock().unwrap().remove(workspace_id);
    }

    pub fn gavin_tree_snapshot(&self, workspace_id: &str) -> Option<protocol::GavinTree> {
        let watcher = self.gavin_watchers.lock().unwrap().get(workspace_id).cloned();
        watcher.map(|w| w.snapshot())
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
        let pty = PtySession::spawn(cwd, command)?;

        self.registry.lock().unwrap().insert(&SessionRecord {
            id: id.clone(),
            workspace_path: workspace_path.to_string(),
            cwd: cwd.to_string(),
            command: command.map(|c| c.to_string()),
            status: SessionStatus::Idle,
            restored: false,
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
            })
            .collect())
    }

    pub fn get_board(&self, workspace_id: &str) -> anyhow::Result<Board> {
        self.kanban.lock().unwrap().get_board(workspace_id)
    }

    pub fn set_board(&self, workspace_id: &str, columns: Vec<Column>, labels: Vec<Label>) -> anyhow::Result<()> {
        self.kanban.lock().unwrap().replace_board(workspace_id, &columns, &labels)
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
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("unknown session: {id}"))?;
        session.resize(cols, rows)
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

    pub fn recover(&self) -> anyhow::Result<()> {
        let records = self.registry.lock().unwrap().list()?;
        let mut sessions = self.sessions.lock().unwrap();
        for record in records {
            if record.status == SessionStatus::Exited {
                continue;
            }
            if !std::path::Path::new(&record.workspace_path).is_dir() {
                eprintln!(
                    "skipping recovery of session {} — workspace_path no longer exists: {}",
                    record.id, record.workspace_path
                );
                if let Err(e) = self.registry.lock().unwrap().update_status(&record.id, SessionStatus::Exited) {
                    eprintln!("failed to mark session {} exited: {e}", record.id);
                }
                continue;
            }
            // A single bad leftover record (e.g. its command is no longer
            // executable) must not abort recovery of every session after it
            // in the list. Log and move on instead of propagating with `?`.
            match PtySession::spawn(&record.workspace_path, record.command.as_deref()) {
                Ok(pty) => {
                    sessions.insert(record.id.clone(), pty);
                    if let Err(e) = self.registry.lock().unwrap().mark_restored(&record.id) {
                        eprintln!("failed to mark session {} restored: {e}", record.id);
                    }
                }
                Err(e) => {
                    eprintln!(
                        "failed to recover session {} (workspace_path {}): {e}",
                        record.id, record.workspace_path
                    );
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

        // Replay buffered output BEFORE registering the writer, so a
        // concurrently-running pump thread (this session may already be
        // attached elsewhere) can't interleave live output ahead of history.
        let buffered: Vec<u8> = {
            let buffers = self.output_buffers.lock().unwrap();
            buffers
                .get(id)
                .map(|b| b.iter().copied().collect())
                .unwrap_or_default()
        };
        if !buffered.is_empty() {
            let data = String::from_utf8_lossy(&buffered).into_owned();
            let _ = write_message(
                &mut *writer.lock().unwrap(),
                &Response::Output { id: id.to_string(), data },
            );
        }

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
                    manager.output_buffers.lock().unwrap().remove(&id);
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
                    // Reachable with no race at all: recover() leaves a
                    // registry row at its ORIGINAL, non-Exited status when
                    // PtySession::spawn fails for it (e.g. its command is
                    // no longer executable), so attach()'s Exited gate
                    // doesn't apply, yet `sessions` has no entry and
                    // reader_for below fails.
                    unregister_session_repo_mapping(&manager, &id);
                    return;
                }
            };

            let mut buf = [0u8; 4096];
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
                        // Scrollback buffer stores raw bytes — never affected by
                        // the UTF-8 chunking concern below, since it isn't decoded
                        // to a String until replay time (attach(), a rare event).
                        {
                            let mut buffers = manager.output_buffers.lock().unwrap();
                            let ring = buffers.entry(id.clone()).or_insert_with(VecDeque::new);
                            ring.extend(buf[..n].iter().copied());
                            while ring.len() > OUTPUT_BUFFER_CAP {
                                ring.pop_front();
                            }
                        }

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
            // The scrollback ring is per-session state like the writer above,
            // and this is the one place that runs for BOTH a natural exit and
            // a kill_session (which makes the pump's read return 0). Dropping
            // it here is what stops up to OUTPUT_BUFFER_CAP bytes per session
            // leaking for the daemon's whole lifetime, and also stops a dead
            // session's stale history replaying to a later Attach.
            manager.output_buffers.lock().unwrap().remove(&id);
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
            .map(|board| Response::Board { columns: board.columns, labels: board.labels }),
        Request::SetBoard { workspace_id, columns, labels } => manager
            .set_board(&workspace_id, columns, labels)
            .map(|_| Response::Ok),
        Request::DeleteBoard { workspace_id } => manager.delete_board(&workspace_id).map(|_| Response::Ok),
        Request::Attach { .. } => unreachable!("Attach is intercepted in handle_connection"),
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

        // Like Attach: needs THIS connection's writer (for tree pushes),
        // so it can't go through handle_request. No reply -- the initial
        // scan arrives as the first GavinTreeChanged push.
        if let Request::WatchGavinRoot { workspace_id, root_path } = req {
            manager.watch_gavin_root(&workspace_id, &root_path, Arc::clone(&writer));
            continue;
        }

        let response = handle_request(&manager, req);
        write_message(&mut *writer.lock().unwrap(), &response)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn start_test_server() -> (std::path::PathBuf, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let socket_path = dir.path().join("daemon.sock");
        let db_path = dir.path().join("registry.sqlite");

        let registry = Registry::open(&db_path).unwrap();
        let kanban = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        let manager = Arc::new(SessionManager::new(registry, kanban));

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
    fn get_board_request_returns_the_default_seed_for_a_new_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        let kanban = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        let manager = SessionManager::new(registry, kanban);

        let resp = handle_request(&manager, Request::GetBoard { workspace_id: "ws-1".to_string() });

        match resp {
            Response::Board { columns, labels } => {
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
        let manager = SessionManager::new(registry, kanban);
        let columns =
            vec![Column { id: "c1".to_string(), name: "Only column".to_string(), position: 0, cards: vec![] }];

        let set_resp = handle_request(
            &manager,
            Request::SetBoard { workspace_id: "ws-1".to_string(), columns: columns.clone(), labels: vec![] },
        );
        assert!(matches!(set_resp, Response::Ok));

        let get_resp = handle_request(&manager, Request::GetBoard { workspace_id: "ws-1".to_string() });
        match get_resp {
            Response::Board { columns: got, .. } => {
                assert_eq!(got.len(), 1);
                assert_eq!(got[0].name, "Only column");
            }
            other => panic!("expected Board, got {other:?}"),
        }
    }

    #[test]
    fn delete_board_request_removes_the_board_and_a_later_get_reseeds_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        let kanban = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        let manager = SessionManager::new(registry, kanban);
        handle_request(
            &manager,
            Request::SetBoard {
                workspace_id: "ws-1".to_string(),
                columns: vec![Column { id: "c1".to_string(), name: "Custom".to_string(), position: 0, cards: vec![] }],
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
                })
                .unwrap();
        }

        let registry = Registry::open(&db_path).unwrap();
        let kanban = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        let manager = SessionManager::new(registry, kanban);

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

    /// A `SessionManager` with nothing else attached to it, for the tests
    /// below that drive `trigger_recheck`/`attach` directly rather than
    /// over the socket.
    fn bare_manager(dir: &tempfile::TempDir) -> Arc<SessionManager> {
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        let kanban = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        Arc::new(SessionManager::new(registry, kanban))
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
    fn killing_a_session_frees_its_scrollback_buffer() {
        let dir = tempfile::tempdir().unwrap();
        let manager = bare_manager(&dir);
        let id = manager.create_session("/tmp", "/tmp", Some("/bin/sh")).unwrap();

        // Attaching spawns the pump, which is what fills the ring buffer.
        let (client, server_side) = UnixStream::pair().unwrap();
        client.set_read_timeout(Some(Duration::from_millis(500))).unwrap();
        manager.attach(&id, Arc::new(Mutex::new(server_side)));

        // Drive some output so the buffer is genuinely non-empty -- a test
        // that passed against an always-empty map would prove nothing.
        manager.write_input(&id, b"echo hello\n").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if manager.output_buffers.lock().unwrap().get(&id).is_some_and(|b| !b.is_empty()) {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            manager.output_buffers.lock().unwrap().get(&id).is_some_and(|b| !b.is_empty()),
            "precondition: the pump should have buffered some output"
        );

        manager.kill_session(&id).unwrap();

        // The pump notices the closed pty and tears down asynchronously.
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if !manager.output_buffers.lock().unwrap().contains_key(&id) {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            !manager.output_buffers.lock().unwrap().contains_key(&id),
            "the scrollback ring must be dropped on teardown, not leaked for the daemon's lifetime"
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
    fn attaching_after_a_failed_recovery_spawn_leaves_no_repo_mapping_or_poller_behind() {
        // recover() leaves a registry row at its ORIGINAL, non-Exited
        // status when PtySession::spawn fails for it, and no `sessions`
        // entry -- so attach()'s Exited gate does not apply, the mapping
        // gets established, a poller gets spawned, and then the pump's
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
                    command: Some("/nonexistent/definitely-not-an-executable-xyz".to_string()),
                    status: SessionStatus::Idle,
                    restored: false,
                })
                .unwrap();
        }

        let manager = Arc::new(SessionManager::new(
            Registry::open(&db_path).unwrap(),
            KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap(),
        ));
        manager.recover().unwrap();
        assert!(
            manager.sessions.lock().unwrap().get("failed-spawn-1").is_none(),
            "test premise broken: the command was expected to fail to spawn"
        );
        assert_eq!(
            manager.registry.lock().unwrap().get("failed-spawn-1").unwrap().unwrap().status,
            SessionStatus::Exited,
            "test premise broken: recover() is now expected to mark a failed-spawn record Exited"
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
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("registry.sqlite");
        {
            let registry = Registry::open(&db_path).unwrap();
            registry
                .insert(&SessionRecord {
                    id: "failed-spawn-2".to_string(),
                    workspace_path: "/tmp".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/nonexistent/definitely-not-an-executable-xyz".to_string()),
                    status: SessionStatus::Idle,
                    restored: false,
                })
                .unwrap();
        }

        let manager = SessionManager::new(
            Registry::open(&db_path).unwrap(),
            KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap(),
        );
        manager.recover().unwrap();

        assert!(
            manager.sessions.lock().unwrap().get("failed-spawn-2").is_none(),
            "test premise broken: the command was expected to fail to spawn"
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
                })
                .unwrap();
        }

        let manager = SessionManager::new(
            Registry::open(&db_path).unwrap(),
            KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap(),
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
                })
                .unwrap();
        }
        let manager = Arc::new(SessionManager::new(
            Registry::open(&db_path).unwrap(),
            KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap(),
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
                })
                .unwrap();
        }
        let manager = Arc::new(SessionManager::new(
            Registry::open(&db_path).unwrap(),
            KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap(),
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
                })
                .unwrap();
        }
        let manager = Arc::new(SessionManager::new(
            Registry::open(&db_path).unwrap(),
            KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap(),
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
    fn recover_uses_workspace_path_not_the_live_tracked_cwd() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("registry.sqlite");

        // Simulate a session whose live-tracked cwd (via OSC 7) has drifted
        // to a directory that no longer exists by the time the daemon
        // restarts -- recovery must still succeed, using the stable
        // workspace_path, not the (possibly stale/gone) live cwd.
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
                })
                .unwrap();
        }

        let registry = Registry::open(&db_path).unwrap();
        let kanban = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        let manager = SessionManager::new(registry, kanban);

        manager.recover().unwrap();

        let sessions = manager.list_sessions().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(
            sessions[0].restored, true,
            "session should have been recovered despite its stale live-tracked cwd"
        );
    }
}
