use protocol::{read_message, write_message, Board, Column, GitStatus, Label, Request, Response, SessionProcess, SessionSummary};
use crate::kanban::KanbanStore;
use crate::osc::OscCwdScanner;
use crate::pty::PtySession;
use crate::registry::{Registry, SessionRecord, SessionStatus};
use crate::screen::SessionScreen;
use crate::status::{StatusEvent, StatusScanner, HEURISTIC_QUIET_PERIOD};
use notify_debouncer_mini::Debouncer;
use std::collections::{HashMap, HashSet};
use std::io::{BufReader, Read, Write};
use protocol::transport::{Listener, Stream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
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

/// Ceiling on live sessions (`SessionManager::sessions`, one entry per PTY
/// this daemon currently holds open) that `create_session` will allow
/// before refusing with a named error instead of silently accumulating
/// shells, pump threads, and PTY fds without bound (DP-05: nothing stopped
/// A1/A2 from exhausting all three). Generous -- ordinary use is a handful
/// of terminals per open workspace, dozens across every workspace at once.
///
/// Held on the manager as an `AtomicUsize` seeded from this constant,
/// rather than compared against the bare constant, so the boundary test
/// can lower it directly (tests share this module and can already reach
/// private fields) instead of spawning hundreds of real PTYs.
const MAX_LIVE_SESSIONS: usize = 256;

/// Ceiling on connections `handle_connection` will admit to its request
/// loop before refusing the rest with the same named error. `serve` spawns
/// one thread per accepted connection with no other limit (DP-05), so
/// this is what actually bounds thread count. Generous, for the same
/// reason as `MAX_LIVE_SESSIONS`, and overridable the same way.
const MAX_CONNECTIONS: usize = 512;

/// How often the heuristic idle-timeout companion thread (see
/// spawn_heuristic_idle_timer) wakes to check whether a session has gone
/// quiet -- granularity of HEURISTIC_QUIET_PERIOD, not a hard
/// real-time guarantee.
const HEURISTIC_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// How often the suspend watchdog compares its two clocks.
///
/// **Must stay below `HEURISTIC_QUIET_PERIOD`**, and that is the whole
/// reason it is not the sparse ten seconds two clock reads would
/// otherwise deserve. On wake, a session that was mid-turn is silent and
/// its quiet timer fires `Idle` HEURISTIC_QUIET_PERIOD later -- measured
/// on the same `Instant` clock, which excluded the sleep, so the timer
/// starts counting from the wake. The mark this watchdog leaves is read
/// at exactly that transition (`failure_verdict`), so a watchdog that
/// polled less often than the quiet period would usually publish its
/// mark AFTER the rail had already advanced on the silence. See
/// `the_suspend_watchdog_must_outrun_the_quiet_timer`.
const SUSPEND_POLL_INTERVAL: Duration = Duration::from_secs(1);

/// How far the two clocks must diverge before the gap is called a
/// suspend. Comfortably above what ordinary scheduling delay, a heavily
/// loaded machine or a one-second NTP slew can produce, and far below the
/// shortest sleep anyone closes a lid for.
const SUSPEND_GAP_THRESHOLD: Duration = Duration::from_secs(30);

/// How long after the terminal says something ABOUT ITSELF into a
/// session its output stops counting as the agent doing something.
///
/// Two things gavin does to a PTY make the program in it repaint without
/// the agent having done anything, and the activity heuristic cannot tell
/// either repaint from a turn starting:
///
///   - a size change, which raises SIGWINCH. One pane geometry change
///     refits EVERY tab in the pane (Pane.svelte's `fitAll`, deliberately
///     -- a hidden tab has to already be the right shape when it is
///     switched to), so one click that opened a page put every agent on
///     that page into `working` for two seconds.
///   - a focus report (`ESC [ I` / `ESC [ O`), which xterm sends whenever
///     its textarea gains or loses focus and the program has asked for
///     them with DEC mode 1004 -- as Claude Code does. Clicking from one
///     session to another therefore repainted both.
///
/// Worse than the spinner: the same block clears `waiting_for_input`, and
/// an agent rings its notification bell exactly once. A refit or a click
/// landing after the question took the only badge saying a human was
/// needed off every surface, permanently.
///
/// Long enough to cover a repaint that dribbles in over several reads,
/// and far below HEURISTIC_QUIET_PERIOD so an agent that really is
/// working is picked up by its very next chunk. A resize only opens the
/// window when the size CHANGED: the kernel raises no SIGWINCH for a
/// resize to the size the PTY already has, so there is no repaint to
/// forgive, and the app refits far more often than the geometry moves.
const PROVOKED_REDRAW_GRACE: Duration = Duration::from_millis(400);

/// The two reports a terminal emulator sends about ITSELF once the
/// program has enabled DEC mode 1004 (focus in, focus out).
///
/// Recognised by the whole payload, never by a prefix: xterm emits each
/// one as its own data event, and three bytes a human typed arrive as
/// three separate ones. So an exact match is a report and nothing else --
/// which matters, because this is what separates the terminal describing
/// itself from the human typing.
fn is_focus_report(data: &[u8]) -> bool {
    data == b"\x1b[I" || data == b"\x1b[O"
}

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
    /// Whether the output-activity heuristic is entitled to speak for
    /// this session at all. Fixed for the session's whole life (see
    /// `heuristic_speaks_for`), so it lives outside the mutex.
    ///
    /// False for a plain terminal, and that is this flag's entire
    /// reason for existing: the heuristic reads "bytes arrived" as "the
    /// agent is working", and a tab the human opened to type in has no
    /// agent in it. Its prompt paint and its keystroke echoes are
    /// output, so it used to report `working` for two seconds after
    /// every character typed -- a spinner drawn from the app's AGENT
    /// vocabulary (ui/indicators.ts) over a session where nothing was
    /// running, counted as a running agent by the sidebar recap, the
    /// fleet view and the close-idle-tabs prompt alike.
    applies: bool,
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

/// Whether the output-activity heuristic may speak for this session.
///
/// It may only when gavin put something in the PTY that is expected to
/// work and then stop: a session created with a command line (an agent,
/// a rail's script, a git commit run). For those the heuristic is the
/// only turn-boundary detector there is, since the agents this app hosts
/// emit no OSC 133.
///
/// It may not for a plain terminal -- `command: None`, the tab the human
/// opens to type in -- nor for a session `recover` put a bare shell into,
/// whose command column still names an agent that was deliberately NOT
/// re-run. Both hold a shell at a prompt, and inferring work from a
/// shell's own echo is inventing a status rather than detecting one.
///
/// Explicit signals are untouched by this: a shell with OSC 133
/// integration still reports its own command boundaries, and a bell still
/// asks for the human. Only the INFERENCE is withdrawn.
fn heuristic_speaks_for(record: &SessionRecord) -> bool {
    record.command.is_some() && !record.interrupted
}

/// Persists a status transition and, if a client is currently attached,
/// relays it live via Response::StatusChanged -- the same
/// persist-then-relay shape spawn_pump's existing cwd handling already
/// uses for Response::CwdChanged, factored out here since this plan adds
/// three separate call sites for it (OSC 133 events, bare-BEL events, and
/// the heuristic timer).
fn persist_and_emit_status(manager: &Arc<SessionManager>, id: &str, status: SessionStatus) {
    let status_str = status.as_str();
    let went_idle = status == SessionStatus::Idle;
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
    // The one trigger the whole follow-up queue hangs off, placed here
    // rather than at each `Idle` call site so that the OSC 133 prompt
    // marker, the quiet timer and anything added later all deliver
    // through the same door. AFTER the status is persisted and pushed:
    // a delivery makes the session busy again within milliseconds, and
    // a client that saw the follow-up leave the queue before it saw the
    // session go idle would be watching the effect precede the cause.
    if went_idle {
        deliver_next_queued(manager, id);
    }
}

/// The envelope a queued follow-up is delivered in: one bracketed paste
/// and a carriage return.
///
/// Bracketed so a multi-line message arrives as ONE block instead of
/// line-by-line submissions -- the same envelope `pasteToMainAgent` uses
/// on the app side, and for the same reason. It is applied here, at
/// delivery, rather than stored: the stored string is what the tab shows
/// the human back, and a list of escape sequences is not a list of
/// messages.
fn bracketed_paste(text: &str) -> String {
    format!("\x1b[200~{text}\x1b[201~\r")
}

/// Why this session cannot be handed a follow-up right now, or `None` if
/// it can.
///
/// The `interrupted` clause is the one that matters most and is the
/// least obvious: after a daemon restart the tab holds a bare shell in
/// the agent's old cwd, not the agent. Pasting the human's English there
/// would hand a shell a line of prose and press Enter -- and the queue
/// exists precisely because the human walked away, so nobody would be
/// watching when it happened. The follow-up stays queued instead, and
/// becomes deliverable again once a real session is running.
fn queue_delivery_refusal(manager: &SessionManager, id: &str) -> Option<String> {
    let record = match manager.registry.lock().unwrap().get(id) {
        Ok(Some(r)) => r,
        Ok(None) => return Some(format!("unknown session: {id}")),
        Err(e) => return Some(format!("couldn't read session {id}: {e}")),
    };
    if record.interrupted {
        return Some(
            "this session's agent was stopped and what is running now is a plain shell — \
             relaunch it before sending, or the message would be run as a command"
                .to_string(),
        );
    }
    if !manager.sessions.lock().unwrap().contains_key(id) {
        return Some(format!("session {id} is not running"));
    }
    None
}

/// Hands this session the head of its queue, if it has one and is in a
/// state to take it.
///
/// Peek, write, then take -- deliberately in that order. The failure
/// this sequence is chosen for is the plausible one: the session exits
/// between the peek and the write, and a take-first ordering would have
/// already destroyed a message that was never delivered. Taking last
/// risks re-delivering only if a DELETE by primary key fails immediately
/// after the row was read, which is not a failure this database has.
fn deliver_next_queued(manager: &SessionManager, id: &str) {
    // Refuse before claiming the delivery slot, so a session that can
    // never take a follow-up (an interrupted one, most of all) does not
    // shut out a delivery that later becomes possible.
    if queue_delivery_refusal(manager, id).is_some() {
        return;
    }
    if !manager.delivering_queued.lock().unwrap().insert(id.to_string()) {
        return;
    }
    let result = deliver_head(manager, id);
    manager.delivering_queued.lock().unwrap().remove(id);
    match result {
        Ok(true) => emit_queued_inputs_changed(manager, id),
        Ok(false) => {}
        Err(e) => eprintln!("failed to deliver a queued follow-up to session {id}: {e}"),
    }
}

/// The body of a delivery, split out so `deliver_next_queued` can clear
/// its in-flight marker on every path including the error one.
/// `Ok(false)` means the queue was empty -- not a failure, and not a
/// reason to push a change nobody made.
fn deliver_head(manager: &SessionManager, id: &str) -> anyhow::Result<bool> {
    let head = {
        let registry = manager.registry.lock().unwrap();
        registry.queued_inputs_for(id)?.into_iter().next()
    };
    let Some(head) = head else { return Ok(false) };
    manager.write_input(id, bracketed_paste(&head.text).as_bytes())?;
    manager.registry.lock().unwrap().take_queued_input(id, &head.id)?;
    Ok(true)
}

/// Delivers only if the session is sitting `Idle`. The trigger for the
/// human queueing onto an agent that already finished its turn.
///
/// `Idle` and nothing else, which is the load-bearing half of the whole
/// feature. Not `WaitingForInput`: that session is asking the human a
/// question, and answering it with an unrelated follow-up would put the
/// answer to a different question at its prompt. Not `Failed`: there is
/// no turn to follow up on, and a message sent into a broken agent is a
/// message spent. Not `Exited`, for the obvious reason.
fn deliver_next_queued_if_idle(manager: &SessionManager, id: &str) {
    let idle = matches!(
        manager.registry.lock().unwrap().get(id),
        Ok(Some(ref r)) if r.status == SessionStatus::Idle
    );
    if idle {
        deliver_next_queued(manager, id);
    }
}

/// Pushes this session's queue, as it now stands, to whoever is attached
/// to it.
///
/// The whole list rather than a delta, so a client that missed one push
/// cannot drift -- and routed to the attached writer exactly like
/// `StatusChanged`, which is precisely why `Request::ListQueuedInputs`
/// has to exist as well: a frontend that reloaded was attached to
/// nothing when this fired.
fn emit_queued_inputs_changed(manager: &SessionManager, id: &str) {
    let queued = match manager.registry.lock().unwrap().queued_inputs_for(id) {
        Ok(q) => q,
        Err(e) => {
            eprintln!("failed to read the follow-up queue for session {id}: {e}");
            return;
        }
    };
    let target = manager.attached_writers.lock().unwrap().get(id).cloned();
    if let Some(w) = target {
        let _ = write_message(
            &mut *w.lock().unwrap(),
            &Response::QueuedInputsChanged { id: id.to_string(), queued },
        );
    }
}

/// How the daemon decides that a quiet agent stopped because something
/// BROKE rather than because its turn ended -- the one distinction the
/// whole v21 change exists to make.
///
/// Two independent signals, because they catch different deaths and
/// neither alone is enough:
///
/// - the agent SAID so (`failure_on_screen`): the profile's own error
///   text, matched against the rendered screen. Catches an API error, a
///   usage limit, an expired token, a connection that died mid-stream.
/// - the machine SLEPT (`slept_mid_turn`): a fact about this process's
///   own clock, owing nothing to the agent's output at all.
///
/// Consulted at exactly one moment: the transition a quiet session would
/// otherwise make to `Idle`. That is deliberate. A failure is a verdict
/// on a TURN, and a session that is still painting frames has not
/// finished one -- an agent retrying a dropped connection prints
/// "Retrying in 39s · attempt 8/10" once a second for minutes, and
/// pausing its rail for that would be exactly the false alarm this whole
/// design is trying not to raise.
fn failure_verdict(manager: &Arc<SessionManager>, id: &str) -> Option<String> {
    if let Some(gap) = manager.slept_mid_turn.lock().unwrap().get(id).copied() {
        return Some(slept_reason(gap));
    }
    let matched = failure_on_screen(manager, id)?;
    // Already on screen when the human last typed here: they have seen
    // it, answered at the prompt below it, and this is the verdict on
    // THAT turn rather than a re-run of the last one.
    if manager.acknowledged_failures.lock().unwrap().get(id) == Some(&matched) {
        return None;
    }
    Some(matched)
}

/// The first line of this session's RENDERED screen that matches one of
/// its profile's failure patterns.
///
/// The screen model, not the byte stream. `StatusScanner` is the
/// established seam for deriving a status from PTY output, but it is an
/// OSC scanner and an agent's error banner is plain text painted by a
/// TUI: the bytes that produce `API Error: Connection dropped` arrive
/// interleaved with cursor moves and repaints, so a raw substring match
/// would straddle them and find nothing. In the vt100 model that gavin
/// already keeps per session, the same text is one contiguous row.
fn failure_on_screen(manager: &Arc<SessionManager>, id: &str) -> Option<String> {
    let patterns = manager.failure_patterns.lock().unwrap().get(id).cloned()?;
    if patterns.is_empty() {
        return None;
    }
    let screen = manager.screens.lock().unwrap().get(id).cloned()?;
    let contents = screen.lock().unwrap().contents();
    for line in contents.lines() {
        if patterns.iter().any(|p| line.contains(p.as_str())) {
            return Some(strip_tui_decoration(line));
        }
    }
    None
}

/// The agent's line without the glyph its TUI painted in front of it.
///
/// Measured, not imagined: Claude Code prefixes its error line with
/// `\u{23fa} ` and its status lines with `\u{273b} `, and a reason that
/// starts with a bullet reads as a rendering artefact in every surface
/// that shows it. Everything from the first alphanumeric character on is
/// the agent's own sentence.
fn strip_tui_decoration(line: &str) -> String {
    let trimmed = line.trim();
    match trimmed.char_indices().find(|(_, c)| c.is_alphanumeric()) {
        Some((i, _)) => trimmed[i..].trim_end().to_string(),
        None => trimmed.to_string(),
    }
}

/// The opening of the one failure reason gavin writes ITSELF rather than
/// quoting from an agent's screen.
///
/// It is a fixed prefix because the app has to recognise it: the
/// auto-resume trigger table classifies a failure by its reason, and
/// every OTHER reason is the agent's own sentence, matched against the
/// profile's `failure_causes`. A suspend has no profile behind it, so
/// `app/src/lib/autoResume.ts` matches this prefix instead, and
/// `the_slept_reason_keeps_the_prefix_the_app_classifies_on` below is
/// what stops a copy-edit here from silently turning every wake-up
/// failure into an unclassifiable one.
pub const SLEPT_REASON_PREFIX: &str = "the machine slept for";

fn slept_reason(gap: u64) -> String {
    format!("{SLEPT_REASON_PREFIX} {} and this agent has not spoken since", humanize_gap(gap))
}

/// "2h 14m", "45m", "90s" -- for a human reading one sentence about why
/// their rail stopped, not for arithmetic.
fn humanize_gap(seconds: u64) -> String {
    if seconds >= 3600 {
        let h = seconds / 3600;
        let m = (seconds % 3600) / 60;
        if m == 0 { format!("{h}h") } else { format!("{h}h {m}m") }
    } else if seconds >= 60 {
        format!("{}m", seconds / 60)
    } else {
        format!("{seconds}s")
    }
}

/// The `Failed` counterpart of `persist_and_emit_status`: status and
/// reason are written together and pushed together, so no consumer can
/// ever see a red session with nothing to say for itself.
fn persist_and_emit_failure(manager: &Arc<SessionManager>, id: &str, reason: &str) {
    if let Err(e) = manager.registry.lock().unwrap().update_status_failed(id, reason) {
        eprintln!("failed to persist failure for session {id}: {e}");
    }
    let target = manager.attached_writers.lock().unwrap().get(id).cloned();
    if let Some(w) = target {
        let mut w = w.lock().unwrap();
        // StatusChanged first, so a consumer that only reads statuses is
        // never briefly told a reason for a session it still believes is
        // idle. Same ordering rule SessionRestored/SessionInterrupted use.
        let _ = write_message(
            &mut *w,
            &Response::StatusChanged { id: id.to_string(), status: "failed".to_string() },
        );
        let _ = write_message(
            &mut *w,
            &Response::SessionFailed { id: id.to_string(), reason: reason.to_string() },
        );
    }
}

/// Watches for time this process did not observe -- a machine suspend,
/// which is the originating case of the whole connection-failure family:
/// a laptop leaves the office mid-rail and comes back on a different
/// network, with every agent's TCP connection dead and every agent
/// process still alive.
///
/// Pairs a monotonic reading with a wall-clock one and compares their
/// deltas. WHICH of the two runs ahead was measured, not assumed, before
/// this was written: on macOS `Instant` is `CLOCK_UPTIME_RAW`, which
/// EXCLUDES suspended time (verified against `kern.boottime` on a machine
/// with 17h of accumulated sleep -- wall-clock-since-boot 419,736s vs
/// `Instant` 357,712s, and `Instant`'s own debug timespec matched
/// `CLOCK_UPTIME_RAW` to the second). So the `SystemTime` delta is the
/// one that runs ahead, and a watchdog that read only `Instant` would
/// detect nothing at all and pass its own tests doing it.
///
/// That same measurement decides the poll interval. `HeuristicInner::
/// last_activity` is an `Instant` too, so a suspend is invisible to it:
/// on wake it has not "elapsed" the sleep, which is good news twice and
/// bad news once.
///
/// Good: no burst of spurious `Idle` transitions fires for the sessions
/// that were already quiet before the lid closed, because from their
/// timer's point of view no time passed.
///
/// Bad: the session that was mid-TURN is silent from the wake onward, so
/// its timer reaches HEURISTIC_QUIET_PERIOD two seconds after the wake
/// and calls it `Idle` -- which is the rail-advancing verdict this whole
/// change exists to prevent. The mark below is read at exactly that
/// transition (`failure_verdict`), so it has to be published FIRST. That
/// is why SUSPEND_POLL_INTERVAL is a second rather than the ten a gap
/// measured in hours would otherwise deserve.
fn spawn_suspend_watchdog(manager: &Arc<SessionManager>) {
    let manager = Arc::clone(manager);
    std::thread::spawn(move || {
        let mut last = (Instant::now(), std::time::SystemTime::now());
        loop {
            std::thread::sleep(SUSPEND_POLL_INTERVAL);
            let now = (Instant::now(), std::time::SystemTime::now());
            let mono = now.0.duration_since(last.0);
            // Saturating: a wall clock that went BACKWARDS (an NTP step,
            // a manual clock change) is not a suspend, and must not be
            // read as one.
            let wall = now.1.duration_since(last.1).unwrap_or(Duration::ZERO);
            last = now;
            let gap = wall.saturating_sub(mono);
            if gap < SUSPEND_GAP_THRESHOLD {
                continue;
            }
            // Every session the registry says was Working. Read from the
            // registry rather than from per-session heuristic state
            // because that is where the status already lives, and it is
            // the same value every other consumer sees.
            let working: Vec<String> = match manager.registry.lock().unwrap().list() {
                Ok(rows) => rows
                    .into_iter()
                    .filter(|r| r.status == SessionStatus::Working)
                    .map(|r| r.id)
                    .collect(),
                Err(e) => {
                    eprintln!("suspend watchdog could not read the registry: {e}");
                    continue;
                }
            };
            if working.is_empty() {
                continue;
            }
            let secs = gap.as_secs();
            eprintln!(
                "gavin-daemon: {secs}s of unobserved time -- {} session(s) were mid-turn",
                working.len()
            );
            let mut marks = manager.slept_mid_turn.lock().unwrap();
            for id in working {
                marks.insert(id, secs);
            }
        }
    });
}

/// Spawned once per session pump (see spawn_pump), alongside it -- but
/// only for a session the heuristic speaks for at all
/// (`heuristic_speaks_for`); a plain terminal gets no timer, because
/// nothing ever sets the flag it would be timing out. Polls
/// `heuristic.inner` every HEURISTIC_POLL_INTERVAL; once
/// HEURISTIC_QUIET_PERIOD has elapsed with no new output AND this session
/// has never seen a valid OSC 133 marker, fires an Idle transition.
/// Exits promptly once the session either switches permanently to
/// OSC-133-only detection (seen_osc133) or ends (running set false).
fn spawn_heuristic_idle_timer(manager: &Arc<SessionManager>, id: String, heuristic: Arc<HeuristicState>) {
    if !heuristic.applies {
        // Nothing to time out: the reactive half never sets
        // heuristic_working for this session, so this thread would poll
        // for the session's whole life to decide nothing.
        return;
    }
    let manager = Arc::clone(manager);
    std::thread::spawn(move || loop {
        std::thread::sleep(HEURISTIC_POLL_INTERVAL);
        if heuristic.seen_osc133.load(Ordering::SeqCst) {
            // Permanently switched to OSC-133-only detection -- nothing
            // left for this thread to ever do for this session again.
            return;
        }
        // Not `mut`: this binding only ever READS, and is dropped before
        // the failure verdict is taken. The mutation moved to the second
        // binding below, which is re-taken after the screen is read.
        let inner = heuristic.inner.lock().unwrap();
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
        if inner.last_activity.elapsed() < HEURISTIC_QUIET_PERIOD {
            continue;
        }
        // The quiet period is up, and this is the one moment a failure is
        // judged: an agent that stopped because something broke and one
        // that stopped because it finished produce byte-identical
        // silence, and this is the line where the two used to become the
        // same word -- `idle`, which orchestration reads as "the turn
        // ended. Done." and acts on by advancing the rail.
        //
        // `inner` is DROPPED before the verdict is taken, and that is not
        // a detail. The verdict reads the session's rendered screen, and
        // the pump holds the screen's lock across feed-then-forward and
        // takes `inner` inside it -- so a verdict computed while holding
        // `inner` inverts that order and the two threads deadlock. It
        // does not merely race: the timer stops firing for that session
        // altogether, which is every status this feature depends on.
        let quiet_since = inner.last_activity;
        drop(inner);
        let verdict = failure_verdict(&manager, &id);

        // Re-taken, and re-validated: anything could have happened while
        // the screen was being read. New output means this verdict
        // describes a turn that is no longer over, and the next poll will
        // judge the next silence on its own.
        let mut inner = heuristic.inner.lock().unwrap();
        if !inner.running
            || !inner.heuristic_working
            || inner.waiting_for_input
            || inner.last_activity != quiet_since
        {
            continue;
        }
        inner.heuristic_working = false;
        // Emitted while still holding `inner` so this can never be
        // reordered relative to a concurrent pump-thread decision.
        match verdict {
            Some(reason) => persist_and_emit_failure(&manager, &id, &reason),
            None => persist_and_emit_status(&manager, &id, SessionStatus::Idle),
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

/// How long `end_orphan` gives a signalled process to actually exit
/// before reporting that it refused.
///
/// Long enough for a node-based agent to run its exit handlers, short
/// enough to stay inside a button press: this blocks the connection
/// thread serving the app's single command socket.
const ORPHAN_EXIT_GRACE: Duration = Duration::from_secs(2);

/// The one place a registry row becomes the wire's view of a session.
///
/// Shared by `list_sessions` and the Attach baseline so the two cannot
/// drift: an orphan that showed up in one and not the other would be a
/// session that looks fine until you reload, which is the exact class of
/// bug `get_session_baselines` exists to prevent.
fn session_summary(r: SessionRecord) -> SessionSummary {
    SessionSummary {
        orphan: r.orphan.map(|o| protocol::OrphanProcess {
            pid: o.pid,
            // The command is what makes a confirmation nameable ("end
            // `claude --model opus`?" rather than "end pid 4172?"). It is
            // the LAUNCH command, which is what gavin knows; the process
            // may have exec'd something else since.
            command: r.command.clone(),
        }),
        id: r.id,
        workspace_path: r.workspace_path,
        cwd: r.cwd,
        status: r.status.as_str().to_string(),
        restored: r.restored,
        failure_reason: r.failure_reason,
        interrupted: r.interrupted,
    }
}

pub struct SessionManager {
    registry: Mutex<Registry>,
    kanban: Mutex<KanbanStore>,
    orchestration: Mutex<crate::orchestration::OrchestrationStore>,
    sessions: Mutex<HashMap<String, PtySession>>,
    attached_writers: Mutex<HashMap<String, Arc<Mutex<Stream>>>>,
    /// What each live session's screen currently IS, so a client that
    /// reconnects can be sent the screen rather than a tail of the bytes that
    /// built it (see `screen.rs`). Each screen is behind its own mutex, held
    /// by the pump across BOTH feeding a chunk in and forwarding that same
    /// chunk on: a snapshot taken between those two steps would contain a
    /// delta the client is about to receive a second time, and a TUI frame
    /// survives a delta applied twice no better than one applied never.
    /// Lock order everywhere is screen -> attached_writers -> writer.
    screens: Mutex<HashMap<String, Arc<Mutex<SessionScreen>>>>,
    /// The text each session's agent prints when it has STOPPED because
    /// something broke (`Request::SetFailurePatterns`). Empty for a
    /// session nobody has told the daemon about -- a plain shell, or an
    /// agent profile whose error text nobody has verified -- and an empty
    /// list means NO failure detection, never "nothing failed".
    ///
    /// Per session rather than daemon-wide because the patterns belong to
    /// the agent profile, and one daemon hosts every workspace's agents
    /// at once.
    failure_patterns: Mutex<HashMap<String, Vec<String>>>,
    /// The failure line that was already on a session's screen when the
    /// human last typed into it. A failure is only ever a verdict on the
    /// turn that just ended, so an error the human has already seen --
    /// still painted in the transcript above the prompt they answered at
    /// -- must not condemn the NEXT turn. Compared by text, so a genuinely
    /// new error still reads as new.
    acknowledged_failures: Mutex<HashMap<String, String>>,
    /// Sessions that were `Working` when this process stopped observing
    /// time (see `spawn_suspend_watchdog`) and have not produced a single
    /// byte since. Value is how long the gap was, in seconds.
    ///
    /// Removed by the pump on the first chunk after the wake: an agent
    /// that is painting again woke up and is talking, and whether THAT
    /// turn ends well is the screen's business, not the clock's. What
    /// stays in here is the session that never spoke again -- which
    /// cannot have finished its turn, because it was frozen in the middle
    /// of one.
    slept_mid_turn: Mutex<HashMap<String, u64>>,
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
    /// Per workspace, the number of watch/unwatch requests seen so far.
    /// A watcher is started off the requesting connection's thread (see
    /// handle_connection) and installed only if no later request for the
    /// same workspace arrived while it was starting -- otherwise a slow
    /// start for a root the human has since re-picked would win over the
    /// watcher for the root they actually chose. Locked before
    /// `gavin_watchers`, never after.
    gavin_watch_generation: Mutex<HashMap<String, u64>>,
    /// Sessions with a queued follow-up being delivered right now.
    ///
    /// Delivery is peek -> write -> take, and that middle step cannot be
    /// held under the registry lock (it writes to a PTY). Two triggers
    /// can therefore reach the same session at once -- the quiet timer
    /// firing `Idle` at the instant the human queues something -- and
    /// without this both would peek the same head and paste it twice.
    /// A session already in here is skipped, never queued behind:
    /// whatever the other delivery is doing ends the idleness anyway.
    delivering_queued: Mutex<std::collections::HashSet<String>>,
    /// The size each session's PTY was last set to.
    ///
    /// Remembered so a resize that changes nothing can be told from one
    /// that does: `resize_session` is called far more often than the
    /// geometry moves (every mount, every refit), the kernel raises a
    /// SIGWINCH only on a real change, and a grace window opened by a
    /// no-op would forgive output nothing provoked. See
    /// `PROVOKED_REDRAW_GRACE`.
    last_pty_size: Mutex<HashMap<String, (u16, u16)>>,
    /// When gavin last did something to a session that makes the program
    /// in it repaint on its own account -- a real size change, or a focus
    /// report written into it.
    ///
    /// Kept on the manager rather than beside the pump's own heuristic
    /// state because the writers are request threads, and read by the
    /// pump, which must not have to lock `sessions` to decide what a
    /// chunk of output means.
    provoked_repaint_at: Mutex<HashMap<String, Instant>>,
    /// See `MAX_LIVE_SESSIONS`. Compared against `sessions.len()` in
    /// `create_session`.
    session_ceiling: AtomicUsize,
    /// Connections currently past `handle_connection`'s ceiling check and
    /// into its request loop -- incremented on entry, decremented on every
    /// exit path via the `ConnectionSlot` guard, so a connection that never
    /// sends a request still frees its slot when it closes.
    active_connections: AtomicUsize,
    /// See `MAX_CONNECTIONS`. Compared against `active_connections` in
    /// `handle_connection`.
    connection_ceiling: AtomicUsize,
    /// The token this daemon minted at startup (`run_server`), the one a
    /// `Hello` presents to take the `app` role and the key the
    /// `server_proof` in `HelloAck` is HMAC'd with (DP-06). A `OnceLock`
    /// rather than a `new()` argument so every existing `SessionManager`
    /// construction site -- and every test that builds one -- stays
    /// unchanged; `run_server` sets it before the first connection is
    /// accepted, and a manager that never had it set (a unit test that
    /// does not exercise `Hello` with the `app` role) simply matches no
    /// daemon token, which is the safe default.
    daemon_token: std::sync::OnceLock<String>,
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
            failure_patterns: Mutex::new(HashMap::new()),
            acknowledged_failures: Mutex::new(HashMap::new()),
            slept_mid_turn: Mutex::new(HashMap::new()),
            repo_pollers: Mutex::new(HashMap::new()),
            session_repo_root: Mutex::new(HashMap::new()),
            gavin_watchers: Mutex::new(HashMap::new()),
            gavin_watch_generation: Mutex::new(HashMap::new()),
            delivering_queued: Mutex::new(std::collections::HashSet::new()),
            last_pty_size: Mutex::new(HashMap::new()),
            provoked_repaint_at: Mutex::new(HashMap::new()),
            session_ceiling: AtomicUsize::new(MAX_LIVE_SESSIONS),
            active_connections: AtomicUsize::new(0),
            connection_ceiling: AtomicUsize::new(MAX_CONNECTIONS),
            daemon_token: std::sync::OnceLock::new(),
        }
    }

    /// Records the token this daemon minted at startup. Called once by
    /// `run_server` before the socket accepts anything; idempotent because
    /// the `OnceLock` ignores a second set, which keeps a stray test call
    /// from panicking.
    pub fn set_daemon_token(&self, token: String) {
        let _ = self.daemon_token.set(token);
    }

    /// The daemon token, or `""` if none was ever set (a bare unit-test
    /// manager). Empty never equals a real token, so a `Hello` presenting
    /// the daemon token against such a manager stays `local`.
    fn daemon_token(&self) -> &str {
        self.daemon_token.get().map(String::as_str).unwrap_or("")
    }

    /// Turn a `Hello`'s `auth` into the connection's identity and the
    /// `HelloAck` to answer with. The role never comes from the client's
    /// `client` field, only from what it proves here (§4):
    ///
    /// - the daemon token yields `app`, and the ack carries a
    ///   `server_proof` (HMAC of the client's nonce) so the app knows it
    ///   reached the real daemon (DP-06);
    /// - a session token that hashes to a live session yields `agent`,
    ///   scoped to that session's `workspace_path` and `cwd`;
    /// - anything else -- no auth, a wrong daemon token, an unknown
    ///   session token -- yields `local`, which in phase 1 keeps today's
    ///   reach. A wrong credential is not an error here: a same-uid client
    ///   already has local reach, so refusing would only break a client
    ///   that mistyped, not stop one that meant harm.
    fn resolve_hello(&self, auth: &protocol::HelloAuth, nonce: &str) -> (ClientIdentity, Response) {
        let local = || {
            (
                ClientIdentity::local(),
                Response::HelloAck {
                    role: "local".to_string(),
                    daemon_version: protocol::PROTOCOL_VERSION,
                    session_id: None,
                    server_proof: None,
                    workspace_root: None,
                },
            )
        };
        match auth {
            protocol::HelloAuth::DaemonToken { token }
                if !self.daemon_token().is_empty() && token == self.daemon_token() =>
            {
                (
                    ClientIdentity {
                        role: Role::App,
                        session_id: None,
                        workspace_root: None,
                        cwd: None,
                    },
                    Response::HelloAck {
                        role: "app".to_string(),
                        daemon_version: protocol::PROTOCOL_VERSION,
                        session_id: None,
                        server_proof: Some(protocol::server_proof(self.daemon_token(), nonce)),
                        workspace_root: None,
                    },
                )
            }
            protocol::HelloAuth::SessionToken { token } => {
                let hash = protocol::hash_token_hex(token);
                let record = {
                    let reg = self.registry.lock().unwrap();
                    reg.session_id_for_token_hash(&hash)
                        .ok()
                        .flatten()
                        .and_then(|sid| reg.get(&sid).ok().flatten())
                };
                match record {
                    Some(rec) => (
                        ClientIdentity {
                            role: Role::Agent,
                            session_id: Some(rec.id.clone()),
                            workspace_root: Some(std::path::PathBuf::from(&rec.workspace_path)),
                            cwd: Some(std::path::PathBuf::from(&rec.cwd)),
                        },
                        Response::HelloAck {
                            role: "agent".to_string(),
                            daemon_version: protocol::PROTOCOL_VERSION,
                            session_id: Some(rec.id),
                            server_proof: None,
                            // The owning workspace, not the PTY cwd: a rail
                            // agent runs in a worktree whose tracked
                            // `.gavin-root` is a decoy, and gavin-mcp needs
                            // this path so its reads hit the real board.
                            workspace_root: Some(rec.workspace_path),
                        },
                    ),
                    None => local(),
                }
            }
            _ => local(),
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
        writer: Arc<Mutex<Stream>>,
    ) {
        let generation = manager.begin_gavin_watch(workspace_id);
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
        manager.install_gavin_watcher(workspace_id, generation, watcher);
    }

    /// Claims the next watch of `workspace_id`. The value has to come back
    /// through `install_gavin_watcher`, which refuses it once a later
    /// watch or unwatch of the same workspace has moved on.
    fn begin_gavin_watch(&self, workspace_id: &str) -> u64 {
        let mut generations = self.gavin_watch_generation.lock().unwrap();
        let next = generations.get(workspace_id).copied().unwrap_or(0) + 1;
        generations.insert(workspace_id.to_string(), next);
        next
    }

    /// Installs a started watcher, replacing the workspace's previous one,
    /// unless the workspace was watched again or unwatched while this one
    /// was starting. Returns whether it went in; a refused watcher is
    /// simply dropped, which tears down its debouncer thread.
    fn install_gavin_watcher(
        &self,
        workspace_id: &str,
        generation: u64,
        watcher: Arc<crate::gavin::GavinWatcher>,
    ) -> bool {
        // Whatever is replaced (or refused) drops after both locks are
        // released: dropping a watcher joins its debouncer thread, which
        // may be mid-scan, and a concurrent watch or snapshot must not
        // wait on that scan.
        let superseded;
        let installed;
        {
            let generations = self.gavin_watch_generation.lock().unwrap();
            if generations.get(workspace_id) == Some(&generation) {
                // Insert AFTER start: the old watcher (if any) is what drops.
                superseded =
                    self.gavin_watchers.lock().unwrap().insert(workspace_id.to_string(), watcher);
                installed = true;
            } else {
                superseded = Some(watcher);
                installed = false;
            }
        }
        drop(superseded);
        installed
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
        // Bumped so a watch still starting for this workspace installs
        // nothing when it finishes: an unwatch that a slow start could
        // undo would not be an unwatch.
        let removed;
        {
            let mut generations = self.gavin_watch_generation.lock().unwrap();
            let next = generations.get(workspace_id).copied().unwrap_or(0) + 1;
            generations.insert(workspace_id.to_string(), next);
            removed = self.gavin_watchers.lock().unwrap().remove(workspace_id);
        }
        drop(removed);
    }

    pub fn gavin_tree_snapshot(&self, workspace_id: &str) -> Option<protocol::GavinTree> {
        let watcher = self.gavin_watchers.lock().unwrap().get(workspace_id).cloned();
        watcher.map(|w| w.snapshot())
    }

    /// Every root this daemon currently has a live watcher on,
    /// canonicalized -- what `confine_root_path` checks a root-taking
    /// request's path against (DP-03/R4). One list shared by every
    /// connection, same as `gavin_watchers` itself: nothing here says
    /// which of these roots is the CALLING connection's own yet, so this
    /// narrows "anywhere on disk" down to "somewhere this daemon already
    /// has open", not yet "open by the caller" -- `sec-fix-client-identity.md`
    /// is what sharpens it the rest of the way.
    fn watched_roots(&self) -> Vec<std::path::PathBuf> {
        self.gavin_watchers.lock().unwrap().values().map(|w| w.root_path.clone()).collect()
    }

    /// The watched workspace whose root matches `root_path`. Watchers
    /// store canonicalized roots, so the incoming path is canonicalized
    /// before comparison.
    fn find_watcher_by_root(&self, root_path: &str) -> Option<Arc<crate::gavin::GavinWatcher>> {
        let canonical = protocol::canonical_path(std::path::Path::new(root_path))
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
    ///
    /// `agent_conversation_id`, when present, is the reporting agent's
    /// OWN CLI-native session id (v38) -- never gavin's `session_id`
    /// above. Stored into this session's bound `card_sessions.
    /// conversation_id`, exactly where a minted id already lives, so
    /// resume treats a self-reported id and a minted one alike. A
    /// session with no bound card is a no-op, not an error: there is
    /// nothing yet to link it to, and the tab still gets renamed.
    pub fn name_session(
        &self,
        session_id: &str,
        name: &str,
        agent_conversation_id: Option<&str>,
    ) -> anyhow::Result<()> {
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
        if let Some(conversation_id) = agent_conversation_id {
            self.kanban
                .lock()
                .unwrap()
                .set_conversation_id_for_session(session_id, conversation_id)?;
        }
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

        let ceiling = self.session_ceiling.load(Ordering::SeqCst);
        if self.sessions.lock().unwrap().len() >= ceiling {
            anyhow::bail!(
                "gavin-daemon: session ceiling reached ({ceiling} already open) — close one before starting another"
            );
        }

        let id = Uuid::new_v4().to_string();
        // Mint the per-session token before the PTY exists, so it can ride
        // into the environment as GAVIN_SESSION_TOKEN and gavin-mcp can
        // present it to take the `agent` role scoped to THIS session
        // (`sec-fix-client-identity.md`). Only the hash is persisted.
        let session_token = protocol::random_hex(32)?;
        let pty = PtySession::spawn(cwd, command, &id, Some(&session_token))?;

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
            // Read BEFORE the session is published, so the row never
            // exists without the identity a later daemon needs to probe
            // it. A row that reached the table with no handle would be
            // permanently un-probeable -- the pid is knowable only here,
            // while this process still holds the Child.
            process: pty.process_handle(),
            // Only recovery can find one, and this is a session being
            // created, not recovered.
            orphan: None,
            failure_reason: None,
        })?;

        // After the row exists (the id is its key): store only the hash,
        // so a copy of registry.sqlite yields no presentable token.
        self.registry
            .lock()
            .unwrap()
            .set_token_hash(&id, &protocol::hash_token_hex(&session_token))?;

        self.sessions.lock().unwrap().insert(id.clone(), pty);
        Ok(id)
    }

    pub fn list_sessions(&self) -> anyhow::Result<Vec<SessionSummary>> {
        let records = self.registry.lock().unwrap().list()?;
        Ok(records.into_iter().map(session_summary).collect())
    }

    /// One sample of what every session is costing right now.
    ///
    /// Every row in the registry gets an entry, including the ones with
    /// nothing to measure. A session whose pid was never recorded, or
    /// whose process is gone, comes back with `process_count: 0` rather
    /// than being left out: "we looked and there is nothing running" is
    /// the answer a task manager needs in order to show an exited row at
    /// all, and dropping it would make the row vanish from a list whose
    /// whole job is to account for sessions nobody can see.
    ///
    /// The sample instant is read once, before the walk, and shared by
    /// every row. Stamping each row as it is measured would make the
    /// interval between two polls differ per session by however long the
    /// walk took, which is exactly the error a rate computed from these
    /// would inherit.
    ///
    /// No caching and no baseline: this returns counters, not rates, so
    /// there is nothing here for a second client's polling period to
    /// corrupt.
    pub fn session_processes(&self) -> anyhow::Result<Vec<SessionProcess>> {
        let records = self.registry.lock().unwrap().list()?;
        let sampled_at_us = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_micros() as i64)
            .unwrap_or(0);
        Ok(records
            .into_iter()
            .map(|record| {
                let usage = record.process.and_then(crate::proc::tree_usage);
                SessionProcess {
                    session_id: record.id,
                    command: record.command,
                    // The pid is reported only when the probe agreed it
                    // is still the process that was recorded. A stored
                    // number the identity check just rejected belongs to
                    // something else, and putting it in a row that
                    // carries a kill button is how the wrong process
                    // gets ended.
                    pid: usage.and(record.process).map(|p| p.pid),
                    rss_bytes: usage.map(|u| u.rss_bytes).unwrap_or(0),
                    cpu_time_us: usage.map(|u| u.cpu_time_us).unwrap_or(0),
                    process_count: usage.map(|u| u.process_count).unwrap_or(0),
                    sampled_at_us,
                }
            })
            .collect())
    }

    /// Ends the process this session left running, and stops reporting it
    /// once it is actually gone.
    ///
    /// Every guard here is about not killing the wrong thing. The pid
    /// comes from the daemon's own row, never from the caller, so this
    /// request cannot be aimed at an arbitrary process. `proc::terminate`
    /// re-probes the identity immediately before signalling, because the
    /// gap between recovery finding the orphan and a human deciding to
    /// end it is unbounded and a pid is a recycled number. And the signal
    /// is SIGTERM with no SIGKILL behind it -- see `proc::terminate`.
    ///
    /// Then it WAITS, rather than assuming the signal worked. A process
    /// that ignores SIGHUP is exactly the shape of process that might
    /// ignore SIGTERM, so the row is cleared only once the OS agrees the
    /// process is gone; otherwise the orphan stays recorded and the app
    /// keeps showing it, which is the honest outcome. The wait is bounded
    /// and short: this runs on the connection's own thread, behind a
    /// confirmation the human is watching.
    pub fn end_orphan(&self, id: &str) -> anyhow::Result<Response> {
        let record = self
            .registry
            .lock()
            .unwrap()
            .get(id)?
            .ok_or_else(|| anyhow::anyhow!("no such session: {id}"))?;
        let Some(orphan) = record.orphan else {
            // Nothing recorded: either there never was an orphan, or a
            // previous call already cleared it. Not an error -- two
            // clicks on the same button must not produce a failure the
            // second time.
            return Ok(Response::OrphanEnded {
                id: id.to_string(),
                ended: false,
                still_running: false,
            });
        };

        crate::proc::terminate(orphan);
        let deadline = std::time::Instant::now() + ORPHAN_EXIT_GRACE;
        while crate::proc::still_running(orphan) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
        let still_running = crate::proc::still_running(orphan);
        if !still_running {
            // The conversation this orphan belonged to is confirmed over,
            // so a follow-up still queued for it can never be delivered --
            // reap it in the same write that clears the orphan (R7).
            self.registry.lock().unwrap().clear_orphan_and_reap_queue(id)?;
        }
        Ok(Response::OrphanEnded {
            id: id.to_string(),
            ended: !still_running,
            still_running,
        })
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

    /// `set_rail_run` for a caller that knows a root and not a workspace
    /// id -- gavin-mcp's `gavin_start_rail`, and nothing else.
    ///
    /// The push is the point. The plain request writes the row and tells
    /// nobody, so a rail armed from outside the app stayed idle on screen
    /// until the Orchestration tab was next mounted -- the half-adopted
    /// state five rails armed over the raw socket left behind on
    /// 2026-09-03. Resolving the root gives the push the workspace id it
    /// needs, and makes an unwatched root a refusal rather than a write
    /// nobody will ever see.
    pub fn set_rail_run_by_root(
        &self,
        root_path: &str,
        rail_id: &str,
        state: &str,
        current_stage_id: Option<String>,
    ) -> anyhow::Result<()> {
        let watcher = self
            .find_watcher_by_root(root_path)
            .ok_or_else(|| anyhow::anyhow!("workspace not open in gavin"))?;
        self.set_rail_run(rail_id, state, current_stage_id)?;
        self.push_orchestration(&watcher.workspace_id);
        Ok(())
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
    // wholesale. The plain three take the scope from the caller and push
    // nothing: they are the APP's, and the app already holds the state it
    // just wrote. The `_by_root` pair below is gavin-mcp's, and differs
    // on both counts.

    pub fn tools(&self, workspace_id: &str) -> anyhow::Result<Vec<protocol::ToolDef>> {
        self.orchestration.lock().unwrap().tools(workspace_id)
    }

    pub fn save_tool(&self, tool: protocol::ToolDef) -> anyhow::Result<()> {
        self.orchestration.lock().unwrap().save_tool(&tool)
    }

    pub fn delete_tool(&self, id: &str) -> anyhow::Result<()> {
        self.orchestration.lock().unwrap().delete_tool(id)
    }

    /// The one tool an agent may write: this workspace's own.
    ///
    /// The guard is DETERMINISTIC and it lives here, not in gavin-mcp's
    /// argument checking and not in a tool description an agent is asked
    /// to respect. Three rules, in order, and each one a refusal rather
    /// than a silent correction:
    ///
    /// 1. A `builtin:` id is refused. Built-ins are gavin's own, they
    ///    are TypeScript constants that never reach this table (tools
    ///    spec T7), and a row wearing one of their ids would SHADOW the
    ///    real one in the app's merge -- which is `save_tool`'s reason
    ///    for refusing it too. Checked here as well so the refusal names
    ///    the agent's mistake before the store's generic message does.
    /// 2. An id that already belongs to a GLOBAL row or to ANOTHER
    ///    workspace is refused. `save_tool` upserts by id and takes the
    ///    scope from the payload, so without this an agent could rewrite
    ///    a tool every workspace on the machine shares -- body and all --
    ///    by saving over its id, and the re-scope would look like a
    ///    routine edit.
    /// 3. The scope is not the caller's to state. Whatever
    ///    `tool.workspace_id` arrived, the watched workspace's id is
    ///    stamped over it, so "workspace tools only" is a property of
    ///    the write rather than a hope about the payload.
    ///
    /// Answers with the tool as STORED, so the caller reports the id and
    /// scope the daemon settled on rather than the ones it proposed.
    pub fn save_tool_by_root(
        &self,
        root_path: &str,
        mut tool: protocol::ToolDef,
    ) -> anyhow::Result<protocol::ToolDef> {
        let watcher = self
            .find_watcher_by_root(root_path)
            .ok_or_else(|| anyhow::anyhow!("workspace not open in gavin"))?;
        if is_builtin_tool_id(&tool.id) {
            anyhow::bail!(
                "{} is one of gavin's built-in tools — an agent can only author this workspace's own tools",
                tool.id
            );
        }
        if let Some(existing) = self.orchestration.lock().unwrap().tool(&tool.id)? {
            guard_workspace_owns(&existing, &watcher.workspace_id, "edit")?;
        }
        tool.workspace_id = Some(watcher.workspace_id.clone());
        self.orchestration.lock().unwrap().save_tool(&tool)?;
        self.push_tools(&watcher.workspace_id);
        Ok(tool)
    }

    /// The delete half, guarded on the same three rules -- with one
    /// difference that is deliberate: an id NOTHING owns is refused too.
    ///
    /// `delete_tool` is a no-op on an unknown id, which is right for the
    /// app (the row is gone either way, and the human is looking at the
    /// list). It is wrong here: an agent that mistyped an id, or aimed
    /// at a `builtin:` one, would read "ok" and believe a tool it can
    /// still see was deleted.
    pub fn delete_tool_by_root(&self, root_path: &str, id: &str) -> anyhow::Result<()> {
        let watcher = self
            .find_watcher_by_root(root_path)
            .ok_or_else(|| anyhow::anyhow!("workspace not open in gavin"))?;
        if is_builtin_tool_id(id) {
            anyhow::bail!(
                "{id} is one of gavin's built-in tools — it is not stored in this workspace and cannot be deleted"
            );
        }
        let existing = self
            .orchestration
            .lock()
            .unwrap()
            .tool(id)?
            .ok_or_else(|| anyhow::anyhow!("no tool with id {id} in this workspace"))?;
        guard_workspace_owns(&existing, &watcher.workspace_id, "delete")?;
        self.orchestration.lock().unwrap().delete_tool(id)?;
        self.push_tools(&watcher.workspace_id);
        Ok(())
    }

    /// Best-effort push of the whole library on the watching app
    /// connection, on the same terms as `push_orchestration`: silent when
    /// nothing is watching this workspace, because the app's next fetch
    /// catches up.
    ///
    /// Only the `_by_root` writes call it. An app write needs no push --
    /// it is the state the app is already holding -- and pushing one back
    /// would be the app telling itself what it just did.
    fn push_tools(&self, workspace_id: &str) {
        let watcher = self.gavin_watchers.lock().unwrap().get(workspace_id).cloned();
        let Some(watcher) = watcher else { return };
        let Ok(tools) = self.tools(workspace_id) else { return };
        watcher.push_response(&protocol::Response::ToolsChanged {
            workspace_id: workspace_id.to_string(),
            tools,
        });
    }

    // ---- Standalone tool runs (v30) --------------------------------------

    pub fn start_tool_run(
        &self,
        workspace_id: &str,
        tool_id: &str,
        session_id: &str,
        command: Option<&str>,
        launch_cwd: Option<&str>,
        conversation_id: Option<&str>,
    ) -> anyhow::Result<()> {
        self.orchestration.lock().unwrap().start_tool_run(
            workspace_id,
            tool_id,
            session_id,
            command,
            launch_cwd,
            conversation_id,
        )
    }

    pub fn set_tool_run_outcome(
        &self,
        session_id: &str,
        outcome: &str,
        exit_code: Option<i32>,
    ) -> anyhow::Result<()> {
        self.orchestration.lock().unwrap().set_tool_run_outcome(session_id, outcome, exit_code)
    }

    /// The last run of each of this workspace's tools, reconciled against
    /// the registry before it is returned -- exactly as `card_runs` is,
    /// and for the same reason: `running` is a CLAIM, and this is the only
    /// place that can check it. A session that ended with nothing
    /// attached had no pump to report its exit, so without this a run
    /// that has been over for days reads as still going.
    pub fn tool_runs(&self, workspace_id: &str) -> anyhow::Result<Vec<protocol::ToolRun>> {
        let runs = self.orchestration.lock().unwrap().tool_runs(workspace_id)?;
        let claimed: Vec<&str> = runs
            .iter()
            .filter(|r| r.outcome == "running")
            .map(|r| r.session_id.as_str())
            .collect();
        if claimed.is_empty() {
            return Ok(runs);
        }
        let registry = self.registry.lock().unwrap();
        let gone: Vec<String> = claimed
            .into_iter()
            .filter(|id| {
                !matches!(
                    registry.get(id),
                    Ok(Some(ref record)) if record.status != SessionStatus::Exited
                )
            })
            .map(|id| id.to_string())
            .collect();
        drop(registry);
        if gone.is_empty() {
            return Ok(runs);
        }
        let mut orchestration = self.orchestration.lock().unwrap();
        orchestration.abandon_tool_runs_for_sessions(&gone)?;
        orchestration.tool_runs(workspace_id)
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

    #[allow(clippy::too_many_arguments)]
    pub fn set_step_run(
        &self,
        step_id: &str,
        state: &str,
        session_id: Option<String>,
        reason: Option<String>,
        conversation_id: Option<String>,
        launch_cwd: Option<String>,
        resume_attempts: Option<u32>,
    ) -> anyhow::Result<()> {
        self.orchestration.lock().unwrap().set_step_run(
            step_id,
            state,
            session_id.as_deref(),
            reason.as_deref(),
            conversation_id.as_deref(),
            launch_cwd.as_deref(),
            resume_attempts,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn link_card_session(
        &self,
        workspace_id: &str,
        path: &str,
        session_id: &str,
        cwd: &str,
        command: Option<&str>,
        conversation_id: Option<&str>,
        launch_cwd: Option<&str>,
        resume_attempts: Option<u32>,
        base_sha: Option<&str>,
    ) -> anyhow::Result<()> {
        self.kanban.lock().unwrap().link_card_session(
            workspace_id,
            path,
            session_id,
            cwd,
            command,
            conversation_id,
            launch_cwd,
            resume_attempts,
            base_sha,
        )
    }

    pub fn unlink_card_session(&self, workspace_id: &str, path: &str) -> anyhow::Result<()> {
        self.kanban.lock().unwrap().unlink_card_session(workspace_id, path)
    }

    /// A card's run history (v27). Never an error for a card nobody has
    /// launched: an empty list is the answer.
    ///
    /// Reconciled against the registry before it is returned, because
    /// `running` is a claim and this is the only place that can check it.
    /// The pump closes a run where it already reports `SessionExited`,
    /// and that covers every session something was attached to -- but a
    /// session that ends UNATTACHED has no pump, so its row would sit
    /// open, and a panel would show a run that has been over for days as
    /// still going. A row whose session the registry no longer counts as
    /// live is `abandoned`: over, at a time nobody recorded.
    pub fn card_runs(&self, workspace_id: &str, path: &str) -> anyhow::Result<Vec<protocol::CardRun>> {
        let runs = self.kanban.lock().unwrap().card_runs(workspace_id, path)?;
        let claimed: Vec<&str> = runs
            .iter()
            .filter(|r| r.outcome == "running")
            .map(|r| r.session_id.as_str())
            .collect();
        if claimed.is_empty() {
            return Ok(runs);
        }
        let registry = self.registry.lock().unwrap();
        let gone: Vec<String> = claimed
            .into_iter()
            .filter(|id| {
                // Absent from the registry counts as gone, the same as
                // Exited: a session the daemon has no record of is not
                // one it is hosting.
                !matches!(
                    registry.get(id),
                    Ok(Some(ref record)) if record.status != SessionStatus::Exited
                )
            })
            .map(|id| id.to_string())
            .collect();
        drop(registry);
        if gone.is_empty() {
            return Ok(runs);
        }
        let mut kanban = self.kanban.lock().unwrap();
        kanban.abandon_runs_for_sessions(&gone)?;
        kanban.card_runs(workspace_id, path)
    }

    /// An agent session claiming the card it just wrote. The app binds a
    /// card the moment it launches an agent FOR it; nothing did the same
    /// for a card an agent picked up by itself -- so a card the Home
    /// tab's workspace agent filed and started still looked unbound on
    /// the board, and Run, Resume and "Start all" would all cheerfully
    /// spawn a second agent onto work already in flight.
    ///
    /// Three gates, all of them "a binding must not lie":
    ///
    ///  - The workspace must be open (watched), like every other
    ///    root-addressed request. There is no board to bind against
    ///    otherwise.
    ///  - The card must be In Progress ON DISK, read back rather than
    ///    taken from the caller. A binding is what makes the board stop
    ///    offering Run, so an agent filing a backlog must not bind it;
    ///    In Progress is the one status that means a session has the
    ///    card in hand, and it is the status the gavin skill already
    ///    tells every agent to write when it starts.
    ///  - A DIFFERENT session that is still alive keeps its claim. A
    ///    card's binding is the human's route to the agent working it,
    ///    and a bystander that merely touched the file must never
    ///    redirect it. The same session re-claiming is an upsert, and a
    ///    dead one's claim is stale by definition.
    ///
    /// `cwd` and `command` come off the session record because the agent
    /// knows neither; they are what the card detail's Re-launch replays.
    /// Answers whether the claim stood. The wire reply is a plain `Ok`
    /// either way -- the agent asked for none of this and has nothing to
    /// do about a refusal -- so the bool exists for the tests that pin
    /// each of the three gates.
    pub fn claim_card_for_session(
        &self,
        root_path: &str,
        path: &str,
        session_id: &str,
    ) -> anyhow::Result<bool> {
        let watcher = self
            .find_watcher_by_root(root_path)
            .ok_or_else(|| anyhow::anyhow!("workspace not open in gavin"))?;
        let record = self
            .registry
            .lock()
            .unwrap()
            .get(session_id)?
            .ok_or_else(|| anyhow::anyhow!("no such session: {session_id}"))?;

        // Canonicalized, because a binding is keyed by path STRING and
        // this is the one caller whose path did not come out of the
        // watcher's scan. `create_plan_file` joins the context folder it
        // was handed verbatim, so an agent that passes `.` as its
        // context -- the obvious thing to pass -- gets a card reported at
        // `<root>/./.gavin-root/plans/x.md`. Keyed on that spelling the
        // binding is real, invisible and unfixable: the board's card id
        // is the scanned path, and the two never compare equal.
        let path = &protocol::wire_path(
            &protocol::canonical_path(std::path::Path::new(path))
                .unwrap_or_else(|_| std::path::PathBuf::from(path)),
        );

        // The card's OWN status line, deliberately raw. A nested task
        // that carries no `status:` inherits its parent's, and reading
        // that inherited value here would claim a card whose session
        // never said anything -- the claim is a declaration, and a card
        // with no status line made none. An agent starting a nested task
        // writes a status, which is exactly what frees it from its
        // parent on the board.
        let content = std::fs::read_to_string(path).unwrap_or_default();
        let info = crate::gavin::plan_file_info(std::path::Path::new(path), &content);
        if !info.status.as_deref().is_some_and(crate::gavin::is_in_progress_status) {
            return Ok(false);
        }

        let workspace_id = watcher.workspace_id.clone();
        let held = self.kanban.lock().unwrap().card_session(&workspace_id, path)?;
        if let Some(held) = &held {
            if held.session_id != session_id
                && self.sessions.lock().unwrap().contains_key(&held.session_id)
            {
                return Ok(false);
            }
        }
        // The held row's run record is CARRIED, not overwritten. A claim
        // is a status write, not a launch: the agent that sends it is
        // very often the one gavin itself started (its prompt tells it to
        // keep the card's status current), and re-linking with None would
        // then erase the conversation id its Resume needs, the launch cwd
        // that id has to be resumed in, the budget bounding automatic
        // resumes, and the baseline the Changes view diffs against --
        // four fields destroyed by an agent doing exactly as it was told.
        //
        // A claim with no held row is the case this branch was written
        // for: work the human's own agent picked up. It has no
        // conversation gavin can name, but it does have a checkout, so
        // the baseline is resolved here -- the only moment anyone can
        // still see where that run began.
        let base_sha = match &held {
            Some(held) => held.base_sha.clone(),
            None => crate::git_status::head_sha(&record.cwd),
        };
        self.kanban.lock().unwrap().link_card_session(
            &workspace_id,
            path,
            session_id,
            &record.cwd,
            record.command.as_deref(),
            held.as_ref().and_then(|h| h.conversation_id.as_deref()),
            held.as_ref().and_then(|h| h.launch_cwd.as_deref()),
            held.as_ref().and_then(|h| h.resume_attempts),
            base_sha.as_deref(),
        )?;
        Ok(true)
    }

    /// Deletes a card's file and every database row keyed to it: its
    /// bindings and run history in kanban.sqlite, its rail steps in
    /// orchestration.sqlite.
    ///
    /// A card's path IS its identity in both stores, which is why
    /// `archive_card` re-keys them rather than letting a move orphan
    /// anything. A delete has the same obligation and no destination:
    /// rows left behind name a file that will never exist again, and a
    /// rail carrying one shows a step whose card "is missing" with no
    /// way to fix it.
    ///
    /// The file goes first, and neither cleanup can undo that -- so a
    /// failure in either is reported and the delete stands, the same
    /// contract `rename_card_everywhere` has.
    pub fn delete_card_file(&self, path: &str) -> anyhow::Result<()> {
        crate::gavin::delete_card_file(std::path::Path::new(path))?;
        if let Err(e) = self.kanban.lock().unwrap().purge_card(path) {
            eprintln!("card {path} deleted but its bindings didn't go with it: {e}");
        }
        let affected = {
            let mut orchestration = self.orchestration.lock().unwrap();
            // Read while the steps still exist to be counted.
            let affected = orchestration.workspaces_with_card(path).unwrap_or_default();
            match orchestration.remove_card_steps(path) {
                Ok(_) => affected,
                Err(e) => {
                    eprintln!("card {path} deleted but its rail steps didn't go with it: {e}");
                    Vec::new()
                }
            }
        };
        // Outside the lock: push_orchestration re-reads the store.
        //
        // The app holds its own copy of every rail and re-reads it only
        // on mount, so a removal it is never told about leaves it
        // scheduling a step whose card this daemon has just deleted --
        // the same staleness follow_card_move exists to prevent.
        for workspace_id in affected {
            self.push_orchestration(&workspace_id);
        }
        Ok(())
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
        // A focus report is the terminal describing ITSELF, and every
        // rule below this point is about the human typing -- so it takes
        // none of them. It does not acknowledge the failure on screen
        // (nobody read it), it does not clear the restored badge (nobody
        // took the tab over), and the repaint it provokes is not the
        // agent working: xterm sends one whenever its textarea gains or
        // loses focus, so clicking from one session to another used to
        // put a spinner on both. Written all the same -- the program
        // asked for these, and Claude Code uses them to decide whether a
        // notification is even worth sending.
        if is_focus_report(data) {
            self.provoke_repaint(id);
            writer.lock().unwrap().write_all(data)?;
            return Ok(());
        }
        // BEFORE the bytes reach the PTY, and that ordering is the whole
        // correctness of it. Whatever failure is on screen at the moment
        // the human types, they have read -- they are typing at the
        // prompt underneath it -- so it is history from here and must not
        // be the verdict on the turn they are starting. Acknowledging
        // AFTER the write reads a screen the agent may already have
        // repainted: the shell echoes and runs within milliseconds, so a
        // failure produced BY this very input would be acknowledged
        // before it had ever been seen, and the turn it belongs to would
        // read as a clean finish. A genuinely new error compares
        // different and still lands (see failure_verdict).
        {
            let mut acked = self.acknowledged_failures.lock().unwrap();
            // Taken WITHOUT the failure_on_screen helper's Arc<Self>: this
            // is a &self method, and the lookup it does is the same two
            // map reads inlined here rather than a signature change on a
            // helper every other caller has an Arc for.
            let matched = self
                .failure_patterns
                .lock()
                .unwrap()
                .get(id)
                .filter(|p| !p.is_empty())
                .cloned()
                .and_then(|patterns| {
                    let screen = self.screens.lock().unwrap().get(id).cloned()?;
                    let contents = screen.lock().unwrap().contents();
                    contents
                        .lines()
                        .find(|line| patterns.iter().any(|p| line.contains(p.as_str())))
                        .map(strip_tui_decoration)
                });
            match matched {
                Some(line) => acked.insert(id.to_string(), line),
                None => acked.remove(id),
            };
        }
        writer.lock().unwrap().write_all(data)?;
        if let Err(e) = self.registry.lock().unwrap().clear_restored(id) {
            eprintln!("failed to clear restored flag for session {id}: {e}");
        }
        Ok(())
    }

    /// Holds a follow-up for this session and, if the session happens to
    /// be idle already, delivers it straight away.
    ///
    /// Queueing onto an idle agent and sending to one are the same act,
    /// so this is not two entry points: the human writing a message for
    /// an agent that finished its turn a second ago means it to go now.
    /// The wait only exists because the agent is busy.
    pub fn queue_input(&self, id: &str, text: &str) -> anyhow::Result<Response> {
        // A message that is only whitespace delivers as a bare carriage
        // return -- an empty turn submitted to the agent, which is worse
        // than nothing because it costs a round trip and says nothing.
        if text.trim().is_empty() {
            anyhow::bail!("a queued follow-up needs some text");
        }
        // Refused rather than stored: a queue for a session that does
        // not exist can never be delivered from, and the row would
        // survive in every listing with nothing able to drain it.
        if self.registry.lock().unwrap().get(id)?.is_none() {
            anyhow::bail!("unknown session: {id}");
        }
        self.registry.lock().unwrap().queue_input(id, text)?;
        deliver_next_queued_if_idle(self, id);
        let queued = self.registry.lock().unwrap().queued_inputs_for(id)?;
        emit_queued_inputs_changed(self, id);
        Ok(Response::QueuedInputs { queued })
    }

    /// Every session's pending follow-ups -- the read-back a frontend
    /// that reloaded uses to recover what the pushes already told
    /// somebody else.
    pub fn list_queued_inputs(&self) -> anyhow::Result<Response> {
        let queued = self.registry.lock().unwrap().queued_inputs()?;
        Ok(Response::QueuedInputs { queued })
    }

    /// The queue this session should have from now on. Reorder, cancel
    /// and clear are all this one write.
    pub fn set_queued_inputs(&self, id: &str, queued_ids: &[String]) -> anyhow::Result<Response> {
        self.registry.lock().unwrap().set_queued_inputs(id, queued_ids)?;
        let queued = self.registry.lock().unwrap().queued_inputs_for(id)?;
        emit_queued_inputs_changed(self, id);
        Ok(Response::QueuedInputs { queued })
    }

    /// Deliver one queued follow-up now, whatever the session's status.
    ///
    /// The status is the only thing the override skips. A session whose
    /// agent was replaced by a bare shell still refuses, because "send
    /// it anyway" is a decision about waiting, not a decision to run the
    /// human's prose as a shell command.
    pub fn send_queued_input(&self, id: &str, queued_id: &str) -> anyhow::Result<Response> {
        if let Some(reason) = queue_delivery_refusal(self, id) {
            anyhow::bail!("{reason}");
        }
        let found = self
            .registry
            .lock()
            .unwrap()
            .queued_inputs_for(id)?
            .into_iter()
            .find(|q| q.id == queued_id);
        // Gone between the human's click and this request -- the queue
        // drained on its own while they were reaching for the button.
        // An error, not a silent success: the message they meant to send
        // HAS been sent, and telling them nothing happened would be a
        // lie in the other direction.
        let Some(entry) = found else {
            anyhow::bail!("that follow-up is no longer queued — it may have just been delivered");
        };
        // Same peek -> write -> take ordering as an idle delivery, and
        // through the same in-flight marker, so an override that lands
        // at the instant the session goes idle cannot double-paste.
        if !self.delivering_queued.lock().unwrap().insert(id.to_string()) {
            anyhow::bail!("a queued follow-up is already being delivered to this session");
        }
        let written = self.write_input(id, bracketed_paste(&entry.text).as_bytes());
        if written.is_ok() {
            let _ = self.registry.lock().unwrap().take_queued_input(id, queued_id);
        }
        self.delivering_queued.lock().unwrap().remove(id);
        written?;
        let queued = self.registry.lock().unwrap().queued_inputs_for(id)?;
        emit_queued_inputs_changed(self, id);
        Ok(Response::QueuedInputs { queued })
    }

    /// What this session's agent prints when it has stopped because
    /// something broke (`Request::SetFailurePatterns`).
    ///
    /// Replaces rather than merges: the caller owns the whole list, and
    /// an empty one is a legitimate instruction meaning "this profile has
    /// no verified error text, so do not detect failures for it".
    pub fn set_failure_patterns(&self, id: &str, patterns: Vec<String>) -> anyhow::Result<()> {
        self.failure_patterns.lock().unwrap().insert(id.to_string(), patterns);
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
        // Recorded before the screen model follows, and deliberately only
        // when the size MOVED: this is the window in which the repaint
        // the SIGWINCH provokes must not be mistaken for the agent
        // working (see PROVOKED_REDRAW_GRACE). A first resize of a
        // session this daemon has not sized before always counts as a
        // move -- the PTY is spawned at 80x24 and the app's first
        // measurement is essentially never that.
        let moved = self
            .last_pty_size
            .lock()
            .unwrap()
            .insert(id.to_string(), (cols, rows))
            != Some((cols, rows));
        if moved {
            self.provoke_repaint(id);
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

    /// Ends a session and answers without waiting for its process to go.
    ///
    /// Nothing of its own left: `forget_session` is the whole body, and
    /// the pump's teardown calls the same thing. The two ways a session
    /// ends have to leave the daemon in one state, and the reaper
    /// described below is what stops either of them from paying
    /// portable-pty's grace loop on a thread that owes somebody a reply.
    pub fn kill_session(&self, id: &str) -> anyhow::Result<()> {
        self.forget_session(id)
    }

    /// Opens the window in which this session's output is the program
    /// answering something gavin did to its terminal, not the agent.
    fn provoke_repaint(&self, id: &str) {
        self.provoked_repaint_at.lock().unwrap().insert(id.to_string(), Instant::now());
    }

    /// Whether that window is still open. See `PROVOKED_REDRAW_GRACE`.
    fn repainting_for_the_terminal(&self, id: &str) -> bool {
        self.provoked_repaint_at
            .lock()
            .unwrap()
            .get(id)
            .is_some_and(|at| at.elapsed() < PROVOKED_REDRAW_GRACE)
    }

    /// Drops every trace of a session the daemon is no longer hosting:
    /// its registry row (and, with it, the follow-ups queued against it)
    /// and the PTY it was running in.
    ///
    /// Shared by `kill_session` and the pump's teardown, which are the
    /// two ways a session ends, so neither can drift into leaving half of
    /// it behind. Tolerant of an id it does not know: the two callers
    /// overlap -- a killed session's pump wakes on the closed PTY and
    /// tears down after the kill has already run -- and the second pass
    /// must be a no-op rather than an error.
    ///
    /// The PTY goes through `retire` rather than being dropped where it
    /// is removed, and that is the whole latency of a close. Both
    /// `Child::kill` and `Drop` spend up to a fifth of a second inside
    /// portable-pty's SIGHUP grace loop (see `PtySession::retire`) --
    /// measured against this daemon, ~55ms per session while a client is
    /// draining the pty and ~430ms when nothing is. On the kill path
    /// that is time the app's UI thread spends blocked, once per
    /// session, on every close that ends more than one: a page of eight
    /// tabs froze the window for half a second, a workspace for several.
    /// The hangup still goes out before this returns -- the process has
    /// to learn its terminal is gone NOW -- and only the waiting for it
    /// to act moves off.
    fn forget_session(&self, id: &str) -> anyhow::Result<()> {
        self.registry.lock().unwrap().remove(id)?;
        self.last_pty_size.lock().unwrap().remove(id);
        self.provoked_repaint_at.lock().unwrap().remove(id);
        // Bound before the `if let` so the map's guard is dropped at the
        // end of this statement rather than held across the spawn.
        let session = self.sessions.lock().unwrap().remove(id);
        if let Some(session) = session {
            session.retire();
        }
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
    /// `workspace_path`. For as long as the app sent one value for both fields
    /// those were the same directory and recovery landed correctly by
    /// coincidence; now that `workspace_path` names the workspace a session
    /// BELONGS to, the second candidate is a real fallback, and it does what
    /// this function's second line has always claimed -- a rail session whose
    /// worktree has since been removed comes back at the workspace root
    /// instead of being written off as exited. `Attach` reports `record.cwd`
    /// either way, which is what a session that had cd'd somewhere else would
    /// have contradicted.
    fn recovery_cwd(record: &SessionRecord) -> Option<&str> {
        for candidate in [record.cwd.as_str(), record.workspace_path.as_str()] {
            if std::path::Path::new(candidate).is_dir() {
                return Some(candidate);
            }
        }
        None
    }

    /// What, if anything, is STILL RUNNING from this inherited row.
    ///
    /// The question the epoch cannot answer. `generation` proves the
    /// daemon that spawned this row is gone; it says nothing about the
    /// process, because a dying daemon reaches its children only as the
    /// SIGHUP its closing PTY masters send, and a child that ignores
    /// SIGHUP survives it, reparented to init. So this asks the OS
    /// instead of reasoning about it.
    ///
    /// A previously recorded orphan is re-checked FIRST, and wins if it
    /// is still alive. That is what makes a second daemon restart safe:
    /// by then the row's own `process` is the bare shell the first
    /// recovery spawned (dead, like every shell, since shells do not
    /// ignore SIGHUP), so a probe that only looked there would quietly
    /// drop a survivor that is still running. Re-checking it also clears
    /// it once it finally exits -- returning `None` is how an orphan
    /// stops being reported.
    ///
    /// Both `still_running` calls fail toward "gone" for an unknown
    /// handle, which is every row written before v21: those rows carry no
    /// pid, and inventing liveness for them would be the same
    /// over-claiming this whole change exists to undo.
    fn surviving_process(record: &SessionRecord) -> Option<crate::proc::ProcessHandle> {
        if let Some(known) = record.orphan {
            if crate::proc::still_running(known) {
                return Some(known);
            }
        }
        record.process.filter(|p| crate::proc::still_running(*p))
    }

    /// Brings a previous daemon lifetime's sessions back.
    ///
    /// Three rules now, and all of them are about what recovery must NOT
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
    /// **A stopped run is not a stopped process.** The clause above --
    /// "the old daemon's death only reaches its children as a SIGHUP" --
    /// is the reason the command is not re-run, and it is also a fact
    /// about THIS run that recovery used to state without checking. So
    /// every inherited row is probed (`surviving_process`) before
    /// anything else happens to it, and a survivor is recorded on the row
    /// as `orphan` for the app to surface and the human to end. The probe
    /// runs first, ahead of the cwd check, so a row that is about to be
    /// marked Exited still records what it left behind -- a process does
    /// not stop existing because the directory it was launched in did.
    /// (The ROW is truthful either way; the app is a separate question,
    /// and today `get_session_baselines` filters Exited rows out, so an
    /// orphan on one reaches only this log line. A session manager that
    /// lists invisible sessions -- `.gavin-root/plans/sessions-manager.md`
    /// -- is where that gap closes.) The common answer is "nothing
    /// survived", which costs one syscall per inherited row and writes
    /// nothing.
    ///
    /// What the probe can see is the process gavin ITSELF launched, and
    /// only that. A child that agent detached into its own session
    /// (`setsid`, a background build, a language server) outlives both
    /// of them and is invisible here -- measured, not assumed. Following
    /// those would mean scanning the process table the way cmux's
    /// VaultAgentProcessScanner does, which is a different and much
    /// larger promise than "remember what we spawned".
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
            // Before anything else touches this row: is the process it
            // named still out there? Written back only when the answer
            // CHANGED, so the overwhelmingly common "nothing survived,
            // nothing was recorded" path does no I/O at all.
            let orphan = Self::surviving_process(&record);
            if orphan != record.orphan {
                if let Err(e) = self.registry.lock().unwrap().set_orphan(&record.id, orphan) {
                    eprintln!("failed to record the orphan state of session {}: {e}", record.id);
                }
            }
            if let Some(orphan) = orphan {
                eprintln!(
                    "session {} left a process behind: pid {} is still running in {} (command: {})",
                    record.id,
                    orphan.pid,
                    record.cwd,
                    record.command.as_deref().unwrap_or("(none)"),
                );
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
            match PtySession::spawn(cwd, None, &record.id, None) {
                Ok(pty) => {
                    // Repointed at the shell that is actually in the PTY
                    // now, before the pty is moved into the map. Leaving
                    // the previous lifetime's pid here would make the
                    // NEXT recovery probe a process this one already
                    // reported -- and, once that pid was recycled, probe
                    // a stranger. The orphan (if any) was captured above
                    // and lives in its own column precisely so this
                    // overwrite cannot lose it.
                    let handle = pty.process_handle();
                    sessions.insert(record.id.clone(), pty);
                    let registry = self.registry.lock().unwrap();
                    if let Err(e) = registry.set_process(&record.id, handle) {
                        eprintln!("failed to record the new process for session {}: {e}", record.id);
                    }
                    if let Err(e) = registry.mark_restored(&record.id) {
                        eprintln!("failed to mark session {} restored: {e}", record.id);
                    }
                    if interrupted {
                        if let Err(e) = registry.mark_interrupted(&record.id) {
                            eprintln!("failed to mark session {} interrupted: {e}", record.id);
                        }
                    }
                    // Every recovered session, not just an interrupted
                    // one. The stored status describes whatever was in
                    // the PTY under the previous daemon; what is here now
                    // is a bare shell sitting at a prompt, and Attach
                    // replays this value as its baseline -- so leaving it
                    // paints a "working" dot over a session doing
                    // nothing.
                    //
                    // A plain terminal used to be exempt, on the grounds
                    // that its next prompt corrected it anyway. It does
                    // not: the output-activity heuristic no longer speaks
                    // for a bare shell (see `heuristic_speaks_for`), so
                    // nothing would ever move that row off `working`
                    // again. The status is now reset here for the same
                    // reason it always was for an agent row -- the shell
                    // in front of the human is idle.
                    if let Err(e) = registry.update_status(&record.id, SessionStatus::Idle) {
                        eprintln!("failed to reset status for session {}: {e}", record.id);
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

    pub fn attach(self: &Arc<Self>, id: &str, writer: Arc<Mutex<Stream>>) {
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
            // After SessionInterrupted, never instead of it: the run WAS
            // interrupted as far as gavin is concerned, and this adds the
            // part the daemon had to go and measure. Like `interrupted`
            // and unlike `restored` it is not cleared by the human typing
            // -- a process does not stop surviving because someone used
            // the shell in front of it -- so it keeps arriving on every
            // later Attach, and a frontend reload cannot lose it.
            if let Some(orphan) = record.orphan {
                let _ = write_message(
                    &mut *writer.lock().unwrap(),
                    &Response::SessionOrphaned {
                        id: id.to_string(),
                        orphan: protocol::OrphanProcess { pid: orphan.pid, command: record.command.clone() },
                    },
                );
            }
            // Git-status mapping/baseline is skipped for Exited sessions
            // too, for the same reason StatusChanged is: there is nothing
            // live to map. Establishing a mapping here would spawn (or
            // join) a repo poller on behalf of a session that may never
            // get a pump thread at all to tear it back down again --
            // specifically after a daemon restart, where recover() skips
            // Exited rows entirely, so `sessions` holds no entry, and the
            // pump's reader_for call would fail outright. That is now the
            // only shape an Exited row reaching here can have: a session
            // whose process ends in THIS lifetime is forgotten outright
            // by the pump's teardown, row and PTY together, so a later
            // attach to it finds no record at all and never gets here.
            // The pump's error path unregisters as a backstop either way,
            // but this gate keeps the daemon from doing the pointless
            // work in the first place, and attaching to an already-exited
            // session is a supported flow.
            if record.status != SessionStatus::Exited {
                let _ = write_message(
                    &mut *writer.lock().unwrap(),
                    &Response::StatusChanged { id: id.to_string(), status: record.status.as_str().to_string() },
                );
                // Beside the status, never instead of it -- the same
                // shape SessionInterrupted takes above. The reason
                // travels as a push, so without this baseline a frontend
                // reload would leave a red session with nothing to say
                // for itself, which is precisely the hole cwd, status and
                // the git chip each had to have closed in turn.
                if let Some(reason) = record.failure_reason.clone() {
                    let _ = write_message(
                        &mut *writer.lock().unwrap(),
                        &Response::SessionFailed { id: id.to_string(), reason },
                    );
                }
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
                // The follow-up queue's baseline, and the fifth push-fed
                // map to need one. Sent unconditionally rather than only
                // when non-empty: "this session has nothing queued" is
                // an answer a reattaching client has to be able to
                // receive, or a queue drained while it was away would
                // stay on screen until something else changed it.
                //
                // `ListQueuedInputs` covers the other half -- a frontend
                // reload learns about sessions it has not attached yet
                // -- because a baseline that only rides on Attach is
                // exactly what left the git chip blank after a reload.
                match self.registry.lock().unwrap().queued_inputs_for(id) {
                    Ok(queued) => {
                        let _ = write_message(
                            &mut *writer.lock().unwrap(),
                            &Response::QueuedInputsChanged { id: id.to_string(), queued },
                        );
                    }
                    Err(e) => eprintln!("failed to read the follow-up queue for session {id}: {e}"),
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
    pub fn write_snapshot(&self, id: &str, writer: &Arc<Mutex<Stream>>) {
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
                // Read once, here, rather than per chunk: `command` is
                // written at creation and never changes, and
                // `interrupted` is stamped by `recover` before this
                // session can be attached to. A row that cannot be read
                // keeps the old behaviour -- an unreadable registry is
                // not evidence that a session is a plain terminal.
                applies: match manager.registry.lock().unwrap().get(&id) {
                    Ok(Some(record)) => heuristic_speaks_for(&record),
                    Ok(None) => true,
                    Err(e) => {
                        eprintln!("failed to read session {id} while starting its pump: {e}");
                        true
                    }
                },
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

                        // This session woke up and is painting again, so
                        // the clock has nothing left to say about it --
                        // whether THIS turn ends well is the screen's
                        // business (see failure_verdict). Cheap: the map
                        // is empty except in the seconds after a suspend.
                        if !manager.slept_mid_turn.lock().unwrap().is_empty() {
                            manager.slept_mid_turn.lock().unwrap().remove(&id);
                        }

                        {
                            // Read before `inner` is locked: a different
                            // mutex, and this block's rule is that the
                            // heuristic lock is taken once and held
                            // across the whole decide-and-emit sequence.
                            let repainting = manager.repainting_for_the_terminal(&id);
                            let mut inner = heuristic.inner.lock().unwrap();
                            inner.last_activity = Instant::now();
                            if heuristic.seen_osc133.load(Ordering::SeqCst) {
                                // The shell speaks for itself now, and
                                // that is a one-way switch.
                            } else if repainting {
                                // The terminal just said something about
                                // itself into this session -- a new size,
                                // or a focus report -- so these bytes are
                                // the program answering that, not the
                                // agent doing anything. Ahead of BOTH
                                // branches below on purpose: this must
                                // neither report `working` nor -- the
                                // more damaging half -- clear
                                // `waiting_for_input`, which is the one
                                // state nothing will say twice. The
                                // explicit signals underneath (OSC 133,
                                // the notification bell) are untouched;
                                // only the guess is suspended.
                            } else if !heuristic.applies {
                                // A plain terminal: output claims
                                // nothing. It does still END a wait --
                                // the rule that renewed activity clears
                                // waiting_for_input is about the bell
                                // being answered, not about anything
                                // working, and without this a shell that
                                // beeped once would sit at
                                // `waiting_for_input` forever, since the
                                // quiet timer this session has no longer
                                // runs.
                                if inner.waiting_for_input {
                                    inner.waiting_for_input = false;
                                    persist_and_emit_status(&manager, &id, SessionStatus::Idle);
                                }
                            } else if !inner.heuristic_working || inner.waiting_for_input {
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
            // Close whatever card run this session WAS (v27), here rather
            // than anywhere else because this block runs for both a
            // natural exit and a kill_session -- the two ways a run
            // actually ends. A failure to write history must not affect
            // the teardown below, so it is logged and stepped over: the
            // row simply stays open and the next daemon reads it as
            // `abandoned`, which is the honest thing for a run whose end
            // was not recorded.
            if let Err(e) = manager.kanban.lock().unwrap().finish_runs_for_session(&id, Some(exit_code)) {
                eprintln!("failed to close card runs for session {id}: {e}");
            }
            // And whatever standalone TOOL run it was (v30), here for the
            // same reason: this is the one block that runs for both a
            // natural exit and a kill. For a `command` or `script` tool
            // the code IS the verdict, so this call is the whole of that
            // tool's result -- nobody has to have been watching. An
            // `agent` tool's row is already closed by the time its
            // session ends, and the store's `outcome = 'running'` guard
            // is what keeps this from overwriting that verdict.
            if let Err(e) =
                manager.orchestration.lock().unwrap().finish_tool_runs_for_session(&id, Some(exit_code))
            {
                eprintln!("failed to close tool runs for session {id}: {e}");
            }
            // Then forget the session itself. Nothing else ever did:
            // `kill_session` was the only path that removed a row, and it
            // only runs when a human closes a tab -- so every run that
            // ended by itself left its record behind, and a hidden one
            // (the Git tab's commit agent, a tool, anything the app takes
            // off screen the moment it exits) left one nobody could see.
            // `recover` skips an exited row rather than dropping it, so
            // the pile outlived the daemon too, and the task manager was
            // the only place to clear it, by hand, one run at a time.
            //
            // Nothing is lost with it: every reader treats an exited row
            // and an unknown one identically (see the app's
            // `adopt_session_impl`), the exit code has already gone into
            // the card and tool run histories above, and the exit itself
            // is announced below.
            //
            // The exception is a row that still names a process this
            // session left RUNNING. That record is the human's only
            // handle on the survivor -- `end_orphan` reads the pid out of
            // it -- so an orphan turns the reap off rather than being
            // swept away by it. A recovery that could not respawn a
            // session marks its row Exited without ever reaching this
            // block, so those stay too.
            let orphaned = manager
                .registry
                .lock()
                .unwrap()
                .get(&id)
                .ok()
                .flatten()
                .is_some_and(|record| record.orphan.is_some());
            if !orphaned {
                if let Err(e) = manager.forget_session(&id) {
                    eprintln!("failed to drop the record of exited session {id}: {e}");
                }
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
            // Same reason as the screen above: per-session state that
            // would otherwise leak for the daemon's whole lifetime, and
            // would answer for a session id the daemon no longer hosts.
            manager.failure_patterns.lock().unwrap().remove(&id);
            manager.acknowledged_failures.lock().unwrap().remove(&id);
            manager.slept_mid_turn.lock().unwrap().remove(&id);
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
        Request::QueueInput { id, text } => manager.queue_input(&id, &text),
        Request::ListQueuedInputs => manager.list_queued_inputs(),
        Request::SetQueuedInputs { id, queued_ids } => {
            manager.set_queued_inputs(&id, &queued_ids)
        }
        Request::SendQueuedInput { id, queued_id } => manager.send_queued_input(&id, &queued_id),
        Request::ResizeSession { id, cols, rows } => manager
            .resize_session(&id, cols, rows)
            .map(|_| Response::Ok),
        Request::KillSession { id } => manager.kill_session(&id).map(|_| Response::Ok),
        Request::SessionProcesses => manager
            .session_processes()
            .map(|processes| Response::SessionProcessList { processes }),
        Request::EndOrphan { id } => manager.end_orphan(&id),
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
        Request::SetRailRunByRoot { root_path, rail_id, state, current_stage_id } => manager
            .set_rail_run_by_root(&root_path, &rail_id, &state, current_stage_id)
            .map(|_| Response::Ok),
        Request::SetFailurePatterns { id, patterns } => {
            manager.set_failure_patterns(&id, patterns).map(|_| Response::Ok)
        }
        Request::SetStepRun {
            step_id,
            state,
            session_id,
            reason,
            conversation_id,
            launch_cwd,
            resume_attempts,
        } => manager
            .set_step_run(
                &step_id,
                &state,
                session_id,
                reason,
                conversation_id,
                launch_cwd,
                resume_attempts,
            )
            .map(|_| Response::Ok),
        Request::GetTools { workspace_id } => {
            manager.tools(&workspace_id).map(|tools| Response::Tools { tools })
        }
        Request::SaveTool { tool } => manager.save_tool(tool).map(|_| Response::Ok),
        Request::DeleteTool { id } => manager.delete_tool(&id).map(|_| Response::Ok),
        Request::GetToolsByRoot { root_path } => {
            manager.tools_by_root(&root_path).map(|tools| Response::Tools { tools })
        }
        // Answered with the tool as STORED (a one-element `Tools`), not
        // `Ok`: the daemon decides the scope, so the caller has to be
        // told what it decided rather than assume its payload survived.
        Request::SaveToolByRoot { root_path, tool } => manager
            .save_tool_by_root(&root_path, tool)
            .map(|saved| Response::Tools { tools: vec![saved] }),
        Request::DeleteToolByRoot { root_path, id } => {
            manager.delete_tool_by_root(&root_path, &id).map(|_| Response::Ok)
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
        Request::Hello { .. } => unreachable!("Hello is intercepted in handle_connection"),
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
        // Not confined to a watched root: see the doc comment on
        // `gavin::init_gavin_root` for why this one request-taking-a-root
        // stays exempt (DP-03/R4).
        Request::InitGavinRoot { root_path, workspace_name } => {
            crate::gavin::init_gavin_root(std::path::Path::new(&root_path), &workspace_name)
                .map(|_| Response::Ok)
        }
        Request::CreateGavinContext { parent_folder } => {
            crate::gavin::confine_root_path(
                std::path::Path::new(&parent_folder),
                &manager.watched_roots(),
            )
            .and_then(|confined| crate::gavin::create_gavin_context(&confined))
            .map(|_| Response::Ok)
        }
        Request::AddExternalGavinContext { root_path, folder } => {
            crate::gavin::confine_root_path(std::path::Path::new(&root_path), &manager.watched_roots())
                .and_then(|confined| {
                    crate::gavin::add_external_context(&confined, std::path::Path::new(&folder))
                })
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
            complexity,
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
                complexity.as_deref(),
            )
            .map(|p| Response::PlanCreated { path: p.to_string_lossy().to_string() })
        }
        Request::LinkCardSession {
            workspace_id,
            path,
            session_id,
            cwd,
            command,
            conversation_id,
            launch_cwd,
            resume_attempts,
            base_sha,
        } => manager
            .link_card_session(
                &workspace_id,
                &path,
                &session_id,
                &cwd,
                command.as_deref(),
                conversation_id.as_deref(),
                launch_cwd.as_deref(),
                resume_attempts,
                base_sha.as_deref(),
            )
            .map(|_| Response::Ok),
        Request::ClaimCardForSession { root_path, path, session_id } => manager
            .claim_card_for_session(&root_path, &path, &session_id)
            .map(|_| Response::Ok),
        Request::UnlinkCardSession { workspace_id, path } => manager
            .unlink_card_session(&workspace_id, &path)
            .map(|_| Response::Ok),
        Request::CardRuns { workspace_id, path } => {
            manager.card_runs(&workspace_id, &path).map(|runs| Response::CardRuns { runs })
        }
        Request::StartToolRun {
            workspace_id,
            tool_id,
            session_id,
            command,
            launch_cwd,
            conversation_id,
        } => manager
            .start_tool_run(
                &workspace_id,
                &tool_id,
                &session_id,
                command.as_deref(),
                launch_cwd.as_deref(),
                conversation_id.as_deref(),
            )
            .map(|_| Response::Ok),
        Request::SetToolRunOutcome { session_id, outcome, exit_code } => manager
            .set_tool_run_outcome(&session_id, &outcome, exit_code)
            .map(|_| Response::Ok),
        Request::ToolRuns { workspace_id } => {
            manager.tool_runs(&workspace_id).map(|runs| Response::ToolRuns { runs })
        }
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
        Request::NameSession { session_id, name, agent_conversation_id } => manager
            .name_session(&session_id, &name, agent_conversation_id.as_deref())
            .map(|_| Response::Ok),
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

/// What a connection is, decided once from its `Hello` (or left `Local`
/// for a client that sends none) and fixed for the connection's life
/// (`sec-fix-client-identity.md`, remote-access design §4). Nothing a later
/// request carries can change it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Role {
    /// The desktop app, holding the daemon token. Everything today's
    /// clients can do.
    App,
    /// A same-uid connection that presented no credential. Equal to `App`
    /// in phase 1 (the socket is the same-uid boundary regardless, AD-1);
    /// narrowable by `require_local_token`.
    Local,
    /// `gavin-mcp` holding a session token, scoped to the launching
    /// session's root and its own session id.
    Agent,
    /// A paired device over the (not-yet-built) remote transport. Denied
    /// everything in phase 1: the remote column of §6's table lands read
    /// by read in phases 4 and 5, and "before that phase it is deny".
    ///
    /// Constructed only by that future transport and by `authorize`'s
    /// tests; carried now so the role is a first-class case in `authorize`
    /// and cannot be forgotten when the transport lands.
    #[allow(dead_code)]
    Remote,
}

/// The identity carried on a connection. `workspace_root` and `cwd` are the
/// session's own (from the row its token was minted for); an `agent` may act
/// only inside them, and only on its own `session_id`.
#[derive(Debug, Clone)]
pub struct ClientIdentity {
    pub role: Role,
    pub session_id: Option<String>,
    pub workspace_root: Option<std::path::PathBuf>,
    pub cwd: Option<std::path::PathBuf>,
}

impl ClientIdentity {
    /// The identity every connection starts with and keeps unless a
    /// `Hello` elevates it: a same-uid local client with today's full
    /// reach. This is what keeps every pre-v35 client working unchanged.
    pub fn local() -> Self {
        Self { role: Role::Local, session_id: None, workspace_root: None, cwd: None }
    }

    /// A test helper: an agent scoped to one root/cwd and one session id.
    #[cfg(test)]
    pub fn agent(session_id: &str, root: &str, cwd: &str) -> Self {
        Self {
            role: Role::Agent,
            session_id: Some(session_id.to_string()),
            workspace_root: Some(std::path::PathBuf::from(root)),
            cwd: Some(std::path::PathBuf::from(cwd)),
        }
    }
}

/// Gavin's OWN tools, by the one thing that marks them: the `builtin:`
/// id prefix (tools spec T7, and `isBuiltinId` in
/// `orchestrationTools.ts`). They are constants in the app and never
/// rows in this table, so nothing here can be "one of them" -- which is
/// exactly why a save wearing one of their ids has to be refused rather
/// than stored: the app merges the library by id, and a stored row would
/// shadow the built-in everywhere it is drawn.
fn is_builtin_tool_id(id: &str) -> bool {
    id.starts_with("builtin:")
}

/// Whether `tool` is the named workspace's own, said as a refusal that
/// names WHICH kind of tool it is. A global tool belongs to every
/// workspace on the machine and another workspace's belongs to that one;
/// neither is this agent's to `verb`.
fn guard_workspace_owns(
    tool: &protocol::ToolDef,
    workspace_id: &str,
    verb: &str,
) -> anyhow::Result<()> {
    match tool.workspace_id.as_deref() {
        Some(owner) if owner == workspace_id => Ok(()),
        // The distinction matters to the agent reading the message: a
        // global tool is shared with every workspace on this machine and
        // a foreign one is somebody else's board, and neither is fixed
        // by retrying.
        None => anyhow::bail!(
            "{} is a GLOBAL tool, shared by every workspace on this machine — an agent can only {verb} this workspace's own tools",
            tool.id
        ),
        Some(_) => anyhow::bail!(
            "{} belongs to another workspace — an agent can only {verb} this workspace's own tools",
            tool.id
        ),
    }
}

/// The `type` tag of a request, for a `Forbidden`/error message. Via serde
/// rather than a 60-arm match: refusals are not a hot path, and the tag is
/// always exactly the wire name this way.
fn request_type_name(req: &Request) -> String {
    serde_json::to_value(req)
        .ok()
        .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(String::from))
        .unwrap_or_else(|| "Unknown".to_string())
}

/// The canonical scope roots an `agent` may act within: the session's
/// recorded `workspace_path` and its `cwd`. Both are kept because a rail
/// agent runs in a worktree (`cwd`) that is not the workspace root
/// (`workspace_path`) and matches no watcher -- the same split
/// `name_session` documents -- so confining to only one would refuse the
/// other's legitimate writes. Canonicalized so `starts_with` survives the
/// `/private` symlink macOS puts in front of `/tmp` and `/var`.
///
/// This is only ever two roots because the app sends two values: while
/// `create_fresh_session` passed its cwd for both, every worktree agent
/// was confined to the worktree and refused the card write its own run
/// prompt names (`cardHomeNote`), which is what
/// `an_agent_in_a_worktree_may_still_write_its_own_workspaces_card` pins.

fn scope_roots(id: &ClientIdentity) -> Vec<std::path::PathBuf> {
    [id.workspace_root.as_ref(), id.cwd.as_ref()]
        .into_iter()
        .flatten()
        .map(|p| p.canonicalize().unwrap_or_else(|_| p.clone()))
        .collect()
}

/// A path argument (a card, a context folder, a cwd) is in scope when it
/// canonicalizes to somewhere under one of the session's scope roots.
/// One-directional: a card must be INSIDE the workspace, never an ancestor
/// of it. A path that cannot be resolved is refused -- an agent naming a
/// file that does not exist is not naming one of its own.
fn agent_path_in_scope(id: &ClientIdentity, arg: &str) -> bool {
    let roots = scope_roots(id);
    if roots.is_empty() {
        return false;
    }
    match std::path::Path::new(arg).canonicalize() {
        Ok(c) => roots.iter().any(|r| c.starts_with(r)),
        Err(_) => false,
    }
}

/// A root argument (the workspace root gavin-mcp resolved from its cwd) is
/// in scope when it and a scope root are the same tree -- either contains
/// the other. Bidirectional for the same reason `confine_root_path` is: the
/// resolved `.gavin-root` ancestor and the recorded `workspace_path` can be
/// parent and child of each other without either being wrong.
fn agent_root_in_scope(id: &ClientIdentity, arg: &str) -> bool {
    let roots = scope_roots(id);
    if roots.is_empty() {
        return false;
    }
    match std::path::Path::new(arg).canonicalize() {
        Ok(c) => roots.iter().any(|r| c.starts_with(r) || r.starts_with(&c)),
        Err(_) => false,
    }
}

fn agent_owns_session(id: &ClientIdentity, session_id: &str) -> bool {
    id.session_id.as_deref() == Some(session_id)
}

/// What an `agent` connection may do, as an EXHAUSTIVE match over every
/// `Request` -- so a new variant fails to compile until someone classifies
/// it here (item 4 of the card), exactly like `min_version_for`.
///
/// The allow set is the 17 request types `gavin-mcp` sends today, each
/// confined to the launching session's root/cwd and its own session id
/// (§6's `agent` column). Everything that starts a process, ends the
/// daemon, configures the scheduler, or touches another workspace is
/// denied.
///
/// One deliberate reading of the card's prose: item 4 says the `agent` is
/// "refused ... the `*ByRoot` family", but §6's capability table -- the
/// section the card tells us to follow, and which it calls load-bearing --
/// marks the `*ByRoot` reads and writes `scoped` for the agent, and
/// `gavin-mcp` cannot function without them (item 5 requires it to keep
/// working). So the `*ByRoot` calls are allowed *within the session's own
/// scope* and refused for any other root, which is what "refused outside
/// its scope" means and what makes AD-2's carve-out enforceable rather
/// than making the agent role unusable.
fn agent_allows(id: &ClientIdentity, req: &Request) -> bool {
    match req {
        // Identity and the version probe: always.
        Request::Hello { .. } | Request::GetProtocolVersion => true,

        // Scoped reads/writes by ROOT (gavin-mcp's own workspace).
        Request::ScanGavinRoot { root_path }
        | Request::ReadPrd { root_path }
        | Request::GetBoardByRoot { root_path }
        | Request::GetOrchestrationByRoot { root_path }
        | Request::GetToolsByRoot { root_path }
        | Request::InitGavinRoot { root_path, .. } => agent_root_in_scope(id, root_path),
        Request::SetOrchestrationByRoot { root_path, .. }
        | Request::SetRailRunByRoot { root_path, .. } => agent_root_in_scope(id, root_path),

        // Authoring this workspace's tools (v37). Scoped by root like
        // every other `*ByRoot` write, and that is only the OUTER gate:
        // it says which workspace the agent is standing in. Which tools
        // inside that workspace it may touch is `save_tool_by_root` /
        // `delete_tool_by_root`'s guard -- built-ins and global tools
        // are gavin's and the machine's, not this workspace's, and they
        // are refused there even though the root checks out.
        //
        // The un-scoped `SaveTool`/`DeleteTool` stay denied below, and
        // must: those take the scope from the payload, which is exactly
        // the decision an agent does not get to make.
        Request::SaveToolByRoot { root_path, .. }
        | Request::DeleteToolByRoot { root_path, .. } => agent_root_in_scope(id, root_path),

        // Scoped card/folder writes by PATH.
        Request::SetPlanFrontmatterField { path, .. }
        | Request::SetChecklistItem { path, .. } => agent_path_in_scope(id, path),
        Request::PromoteChecklistItem { plan_path, .. } => agent_path_in_scope(id, plan_path),
        Request::CreatePlan { context_folder, .. } => agent_path_in_scope(id, context_folder),
        Request::CreateGavinContext { parent_folder } => agent_path_in_scope(id, parent_folder),
        Request::GitDirtyPaths { cwd, .. } => agent_path_in_scope(id, cwd),

        // Spawning is allowed but confined: an agent may open another
        // visible session in its OWN workspace (an orchestration agent
        // fanning out), never elsewhere.
        Request::SpawnAgentSession { root_path, cwd, .. } => {
            agent_root_in_scope(id, root_path) && agent_path_in_scope(id, cwd)
        }

        // Binding a card to a session, and naming a tab: only its own.
        Request::ClaimCardForSession { root_path, path, session_id } => {
            agent_root_in_scope(id, root_path)
                && agent_path_in_scope(id, path)
                && agent_owns_session(id, session_id)
        }
        Request::NameSession { session_id, .. } => agent_owns_session(id, session_id),

        // Everything else: denied. Starting a shell, ending the daemon,
        // ending an orphan, driving or reading another session's PTY,
        // configuring the board/scheduler/tools, or touching a workspace
        // by an un-scoped variant -- none of it is the agent's to do
        // (§6). Listed exhaustively so a new Request variant cannot be
        // added without a decision here.
        Request::CreateSession { .. }
        | Request::ListSessions
        | Request::SessionProcesses
        | Request::EndOrphan { .. }
        | Request::WriteInput { .. }
        | Request::QueueInput { .. }
        | Request::ListQueuedInputs
        | Request::SetQueuedInputs { .. }
        | Request::SendQueuedInput { .. }
        | Request::ResizeSession { .. }
        | Request::KillSession { .. }
        | Request::Attach { .. }
        | Request::Snapshot { .. }
        | Request::SetFailurePatterns { .. }
        | Request::GetBoard { .. }
        | Request::SetBoard { .. }
        | Request::DeleteBoard { .. }
        | Request::WatchGavinRoot { .. }
        | Request::UnwatchGavinRoot { .. }
        | Request::GetGavinTree { .. }
        | Request::AddExternalGavinContext { .. }
        | Request::RemoveExternalGavinContext { .. }
        | Request::SetRootConfigField { .. }
        | Request::DeleteCardFile { .. }
        | Request::ArchiveCard { .. }
        | Request::UnarchiveCard { .. }
        | Request::LinkCardSession { .. }
        | Request::UnlinkCardSession { .. }
        | Request::CardRuns { .. }
        | Request::StartToolRun { .. }
        | Request::SetToolRunOutcome { .. }
        | Request::ToolRuns { .. }
        | Request::GetOrchestration { .. }
        | Request::SetOrchestration { .. }
        | Request::SetRailRun { .. }
        | Request::SetStepRun { .. }
        | Request::GetTools { .. }
        | Request::SaveTool { .. }
        | Request::DeleteTool { .. }
        | Request::GetGroupTemplates { .. }
        | Request::SaveGroupTemplate { .. }
        | Request::DeleteGroupTemplate { .. }
        | Request::Shutdown
        | Request::Unknown => false,
    }
}

/// The process-starting / daemon-ending / launch-reconfiguring requests an
/// untokened `local` connection loses once `require_local_token` is on.
/// Kept small on purpose: the switch's job in phase 1 is to make "you must
/// authenticate to start a shell or stop the daemon" expressible, not to
/// reproduce the whole agent table for a connection that has no session to
/// scope against.
fn is_privileged(req: &Request) -> bool {
    matches!(
        req,
        Request::CreateSession { .. }
            | Request::SpawnAgentSession { .. }
            | Request::Shutdown
            | Request::EndOrphan { .. }
            | Request::SetRootConfigField { .. }
    )
}

/// The one gate, keyed on the connection's role, run in `handle_connection`
/// before the intercepts and `handle_request` (§4). `Ok(())` lets the
/// request through; `Err(Response::Forbidden { .. })` is the reply to send
/// instead. `require_local_token` is read live per request so a Settings
/// toggle takes effect without a daemon restart.
pub fn authorize(
    id: &ClientIdentity,
    req: &Request,
    require_local_token: bool,
) -> Result<(), Response> {
    let allowed = match id.role {
        // App and (with the switch off) Local keep today's full reach:
        // phase 1 must not change what the app can do, and the socket is
        // the same-uid boundary regardless (AD-1).
        Role::App => true,
        Role::Local => !require_local_token || !is_privileged(req),
        Role::Agent => agent_allows(id, req),
        // Phase 1: the remote transport does not exist and the remote
        // column is deny throughout. Phases 4-5 open §6's reads and writes.
        Role::Remote => false,
    };
    if allowed {
        Ok(())
    } else {
        let role = match id.role {
            Role::App => "app",
            Role::Local => "local",
            Role::Agent => "agent",
            Role::Remote => "remote",
        };
        Err(Response::Forbidden {
            request_type: request_type_name(req),
            role: role.to_string(),
        })
    }
}

/// The peer-uid floor (`getpeereid`, §4): confirm the connecting process
/// runs as this daemon's own uid. The socket is `0600` in a `0700` dir, so
/// this only ever fires if the socket escapes that dir -- defence in depth,
/// not identity. Fails closed: a peer whose uid cannot be read is refused.
#[cfg(unix)]
fn peer_uid_ok(fd: std::os::unix::io::RawFd) -> bool {
    let mut uid: libc::uid_t = 0;
    let mut gid: libc::gid_t = 0;
    // SAFETY: `fd` is a live, connected Unix-domain socket for the
    // duration of this call; getpeereid only reads through it.
    let rc = unsafe { libc::getpeereid(fd, &mut uid, &mut gid) };
    if rc != 0 {
        return false;
    }
    uid == unsafe { libc::getuid() }
}

/// Whether an untokened local connection is narrowed. Absent marker file
/// (the default) means no; present means yes. Read per request so the
/// Settings toggle is live.
fn require_local_token() -> bool {
    protocol::require_local_token_path().is_ok_and(|p| p.exists())
}

/// Mint this daemon's per-start token and write it `0600` beside the
/// socket, for the app to read (DP-06). Fresh each start: a token from a
/// previous daemon lifetime is worthless the moment this one rebinds.
fn mint_daemon_token() -> anyhow::Result<String> {
    let token = protocol::random_hex(32)?;
    let path = protocol::daemon_token_path()?;
    std::fs::write(&path, &token)?;
    // 0600 where the OS has modes. Off unix the token inherits the ACL of
    // the per-user data directory it sits in, which is the same audience.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(token)
}

pub fn run_server(socket_path: &std::path::Path, manager: Arc<SessionManager>) -> anyhow::Result<()> {
    // Mint the token before the socket accepts anything, so the first
    // connection's Hello already has something to check against and a
    // server_proof to compute.
    manager.set_daemon_token(mint_daemon_token()?);
    serve(bind_server(socket_path)?, manager)
}

/// Claim the socket, and return only once it is accepting connections.
///
/// Split out from `serve` so a caller can hold that guarantee before it
/// lets anything else run -- which is the only way to hand it to another
/// thread. Watching for the socket FILE does not give it: `bind(2)`
/// creates the file and `connect(2)` is refused until `listen(2)`, two
/// syscalls later, so a connect aimed at the gap between them fails
/// against a daemon that is moments from being ready.
fn bind_server(socket_path: &std::path::Path) -> anyhow::Result<Listener> {
    let endpoint = protocol::transport::Endpoint::new(socket_path.to_path_buf());
    // Connecting, not `path.exists()`: on Windows there is no socket file
    // to look for, and on Unix the file outliving its daemon is the
    // normal case after a crash. `Listener::bind` clears that debris
    // itself, so all this has to decide is whether someone answers.
    if protocol::transport::is_listening(&endpoint) {
        anyhow::bail!("another gavin-daemon is already listening on {endpoint}");
    }
    let listener = Listener::bind(&endpoint)?;
    // 0600 on the socket file, where there is one. The Windows pipe is
    // scoped by the DACL `transport` builds for it instead -- there is no
    // per-user pipe namespace to fall back on.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(socket_path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(listener)
}

fn serve(listener: Listener, manager: Arc<SessionManager>) -> anyhow::Result<()> {
    // After recover(), before the first connection: the watchdog's first
    // reading has to be taken while the daemon is definitely awake, and
    // it must be running before any session it might have to speak for.
    spawn_suspend_watchdog(&manager);

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

/// Decrements `active_connections` when a connection's thread ends, no
/// matter which of `handle_connection`'s several return points got it
/// there -- a manual decrement at each one is what a future added return
/// forgets.
struct ConnectionSlot<'a>(&'a AtomicUsize);

impl Drop for ConnectionSlot<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

fn handle_connection(stream: Stream, manager: Arc<SessionManager>) -> anyhow::Result<()> {
    // The peer-uid floor, before anything else on this connection: a peer
    // whose uid is not this daemon's own is refused outright (§4). It only
    // fires if the socket ever escapes its 0700 dir; same-uid, which is
    // every client today, passes unchanged.
    //
    // Unix only, and not a gap off it: a Windows client reaches a named
    // pipe whose DACL already names this user alone, so the check has
    // nothing left to decide there. Written through `&stream` rather than
    // by moving it, so the refusal path does not conditionally consume a
    // value the caller still uses when the check passes.
    #[cfg(unix)]
    if !peer_uid_ok(stream.as_raw_fd()) {
        let _ = write_message(
            &mut &stream,
            &Response::Error {
                message: "gavin-daemon: refusing a connection from a different user".to_string(),
            },
        );
        return Ok(());
    }

    let writer = Arc::new(Mutex::new(stream.try_clone()?));
    let mut reader = BufReader::new(stream);

    // The connection's identity, `local` until a `Hello` says otherwise,
    // and fixed thereafter (§4). `hello_seen` refuses a second `Hello`.
    let mut identity = ClientIdentity::local();
    let mut hello_seen = false;

    // Counted before anything else on this connection runs, so a client
    // that never sends a request still costs a slot for as long as it
    // stays open (DP-05: `serve` spawns one thread per accepted
    // connection with no other limit).
    let count = manager.active_connections.fetch_add(1, Ordering::SeqCst) + 1;
    let _slot = ConnectionSlot(&manager.active_connections);
    let ceiling = manager.connection_ceiling.load(Ordering::SeqCst);
    if count > ceiling {
        let _ = write_message(
            &mut *writer.lock().unwrap(),
            &Response::Error {
                message: format!(
                    "gavin-daemon: connection ceiling reached ({ceiling} already open) — refusing this one"
                ),
            },
        );
        return Ok(());
    }

    loop {
        let req: Option<Request> = read_message(&mut reader)?;
        let req = match req {
            Some(r) => r,
            None => break,
        };

        // `Hello` establishes identity for the connection. Handled here,
        // never authorized (it is what SETS the role) and never dispatched
        // to handle_request. A second one is refused -- identity is fixed
        // once set.
        if let Request::Hello { auth, nonce, .. } = &req {
            if hello_seen {
                write_message(
                    &mut *writer.lock().unwrap(),
                    &Response::Error {
                        message: "gavin-daemon: Hello already sent on this connection".to_string(),
                    },
                )?;
                continue;
            }
            hello_seen = true;
            let (id, ack) = manager.resolve_hello(auth, nonce);
            identity = id;
            write_message(&mut *writer.lock().unwrap(), &ack)?;
            continue;
        }

        // The authorization gate (§4), BEFORE the Attach/Snapshot/
        // WatchGavinRoot/Shutdown intercepts below and before
        // handle_request: a refused request must not reach any of them.
        // App and (switch-off) Local pass everything, so today's clients
        // are unaffected; an `agent` is held to its scope, and an
        // untokened `local` loses the privileged set when the switch is on.
        if let Err(forbidden) = authorize(&identity, &req, require_local_token()) {
            write_message(&mut *writer.lock().unwrap(), &forbidden)?;
            continue;
        }

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
            // Off this thread. Starting a watcher scans the root, and on
            // a large repo that held every later request on this
            // connection -- Attach for a freshly launched agent, the
            // Snapshot its terminal asked for, every keystroke -- behind
            // a scan that took minutes (gavin::ONE_RECURSIVE_WATCH has the
            // numbers). Nothing a client sends next depends on the watcher
            // being up: the initial scan was always delivered as a push,
            // and a GetGavinTree that lands first answers "not watched",
            // which the app already treats as "ask again later".
            let manager = Arc::clone(&manager);
            let writer = Arc::clone(&writer);
            std::thread::spawn(move || {
                SessionManager::watch_gavin_root(&manager, &workspace_id, &root_path, writer);
            });
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
            auto_resume: None,
            trigger: None,
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
                conversation_id: None,
                launch_cwd: None,
                resume_attempts: None,
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
            cwd: None,
            icon: None,
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

    /// A refusal from the store reaches the client as `Response::Error`
    /// rather than as an `Ok` that stored nothing.
    ///
    /// The refusal it uses is a tool with NO KIND, which since
    /// 2026-09-07 is the only kind-shaped thing `save_tool` refuses: it
    /// used to hold an allow-list of three kinds while the app authored
    /// seven, so this test was riding on a rejection that was itself the
    /// bug.
    #[test]
    fn a_refused_save_tool_answers_with_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        let mut bad = a_tool("u1", None);
        bad.kind = String::new();
        match handle_request(&manager, Request::SaveTool { tool: bad }) {
            Response::Error { message } => assert!(message.contains("kind"), "{message}"),
            other => panic!("wrong response: {other:?}"),
        }
    }

    /// And the save the allow-list used to refuse: every kind the app
    /// offers a chip for goes through `SaveTool` and comes back.
    #[test]
    fn save_tool_accepts_every_kind_the_app_can_author() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        for kind in ["agent", "command", "script", "gavin", "until", "pr", "review", "critique"] {
            let mut tool = a_tool(&format!("u-{kind}"), Some("ws-1"));
            tool.kind = kind.into();
            match handle_request(&manager, Request::SaveTool { tool }) {
                Response::Ok => {}
                other => panic!("saving a {kind} tool: {other:?}"),
            }
        }
        match handle_request(&manager, Request::GetTools { workspace_id: "ws-1".into() }) {
            Response::Tools { tools } => assert_eq!(tools.len(), 7),
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
                conversation_id: None,
                launch_cwd: None,
                resume_attempts: None,
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

    /// A reader with no buffer of its own, which is what sharing one
    /// connection between several reads requires.
    ///
    /// A `BufReader` takes up to its capacity per `read(2)` and keeps
    /// the surplus, so a second reader built on the same connection
    /// starts wherever the first one's buffer happened to stop -- and a
    /// loaded machine is exactly when the daemon coalesces a response
    /// and a push into one write, putting that stop mid-message. The
    /// first reader then goes out of scope with the rest of the write
    /// still inside it. `request()` and `drive_until()` build one each,
    /// so every test that reads twice has been reading a stream with
    /// holes in it. A byte at a time never over-consumes, and these are
    /// short messages read a few dozen at a time.
    fn line_reader<R: std::io::Read>(inner: R) -> BufReader<R> {
        BufReader::with_capacity(1, inner)
    }

    /// How long a test waits on a real OS process -- a fork, an exec, a
    /// shell reaching its first prompt, a PTY round trip -- before
    /// calling it dead.
    ///
    /// Far longer than any of those takes on an idle machine, on
    /// purpose. `cargo test` runs this file's ~150 tests in parallel and
    /// dozens of them spawn shells of their own, so what sets the wall
    /// clock on a round trip is how contended the machine is, not the
    /// daemon. Only a test that is going to fail anyway ever pays this
    /// in full, so the reliability it buys costs a green run nothing.
    const PROCESS_BUDGET: Duration = Duration::from_secs(30);

    // ---- client identity: authorize() ----

    /// A workspace on disk with one real card, so the scope checks (which
    /// canonicalize) have something that resolves.
    fn workspace_with_card() -> (tempfile::TempDir, String, String) {
        let dir = tempfile::tempdir().unwrap();
        crate::gavin::init_gavin_root(dir.path(), "WS").unwrap();
        let card = dir.path().join(".gavin-root").join("plans").join("a.md");
        std::fs::write(&card, "---\ntitle: A\n---\n").unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let card = card.to_string_lossy().to_string();
        (dir, root, card)
    }

    fn sff(path: &str) -> Request {
        Request::SetPlanFrontmatterField {
            path: path.to_string(),
            key: "status".into(),
            value: "Done".into(),
        }
    }

    #[test]
    fn app_may_do_everything_and_the_switch_never_narrows_it() {
        let id = ClientIdentity { role: Role::App, session_id: None, workspace_root: None, cwd: None };
        assert!(authorize(&id, &Request::Shutdown, false).is_ok());
        assert!(authorize(
            &id,
            &Request::CreateSession { workspace_path: "/x".into(), cwd: "/x".into(), command: None },
            true, // even with the switch on
        )
        .is_ok());
    }

    #[test]
    fn untokened_local_keeps_full_reach_until_the_switch_is_on() {
        let id = ClientIdentity::local();
        // Switch off (the default): today's reach, including a shell and Shutdown.
        assert!(authorize(&id, &Request::Shutdown, false).is_ok());
        assert!(authorize(
            &id,
            &Request::CreateSession { workspace_path: "/x".into(), cwd: "/x".into(), command: None },
            false,
        )
        .is_ok());
        // Switch on: the privileged, process-starting set is refused...
        assert!(matches!(
            authorize(&id, &Request::Shutdown, true),
            Err(Response::Forbidden { .. })
        ));
        assert!(matches!(
            authorize(
                &id,
                &Request::CreateSession { workspace_path: "/x".into(), cwd: "/x".into(), command: None },
                true
            ),
            Err(Response::Forbidden { .. })
        ));
        // ...but ordinary reads still go through.
        assert!(authorize(&id, &Request::ListSessions, true).is_ok());
    }

    #[test]
    fn an_agent_is_confined_to_its_own_scope() {
        let (_ws, root, card) = workspace_with_card();
        let (_other, other_root, other_card) = workspace_with_card();
        let id = ClientIdentity::agent("sess-1", &root, &root);

        // In its own workspace: allowed.
        assert!(authorize(&id, &sff(&card), false).is_ok());
        assert!(authorize(&id, &Request::GetBoardByRoot { root_path: root.clone() }, false).is_ok());
        assert!(authorize(&id, &Request::ScanGavinRoot { root_path: root.clone() }, false).is_ok());

        // Another workspace's card or root: refused.
        assert!(matches!(
            authorize(&id, &sff(&other_card), false),
            Err(Response::Forbidden { role, .. }) if role == "agent"
        ));
        assert!(matches!(
            authorize(&id, &Request::GetBoardByRoot { root_path: other_root }, false),
            Err(Response::Forbidden { .. })
        ));

        // A path that does not resolve at all is refused, not waved through.
        assert!(authorize(&id, &sff("/no/such/card.md"), false).is_err());
    }

    /// The shape every rail agent actually has, and the one this gate was
    /// written for: running in a WORKTREE, writing a card that lives in
    /// the workspace it was launched from. Both scope roots are load
    /// bearing here -- the card is under neither the cwd nor any ancestor
    /// of it -- which is why the app has to send the workspace and the cwd
    /// as two different values on `CreateSession`. Sending the cwd twice
    /// is what had the daemon refuse the one write `cardHomeNote` tells
    /// such an agent to make.
    #[test]
    fn an_agent_in_a_worktree_may_still_write_its_own_workspaces_card() {
        let (_ws, root, card) = workspace_with_card();
        let worktree = tempfile::tempdir().unwrap();
        let cwd = worktree.path().to_string_lossy().to_string();
        let id = ClientIdentity::agent("sess-1", &root, &cwd);

        assert!(authorize(&id, &sff(&card), false).is_ok());
        assert!(authorize(&id, &Request::CreatePlan {
            context_folder: root.clone(),
            file_name: "b.md".into(),
            title: "B".into(),
            status: None,
            priority: None,
            body: None,
            kind: None,
            parent: None,
            attachments: None,
            complexity: None,
        }, false)
        .is_ok());
        assert!(authorize(&id, &Request::GitDirtyPaths { cwd: cwd.clone(), limit: 10 }, false).is_ok());


        // Still only its own: another workspace's card stays refused.
        let (_other, _other_root, other_card) = workspace_with_card();
        assert!(matches!(
            authorize(&id, &sff(&other_card), false),
            Err(Response::Forbidden { role, .. }) if role == "agent"
        ));
    }


    #[test]
    fn an_agent_cannot_spawn_a_shell_end_the_daemon_or_drive_another_session() {
        let (_ws, root, _card) = workspace_with_card();
        let id = ClientIdentity::agent("sess-1", &root, &root);
        for req in [
            Request::CreateSession { workspace_path: root.clone(), cwd: root.clone(), command: None },
            Request::Shutdown,
            Request::EndOrphan { id: "x".into() },
            Request::WriteInput { id: "other".into(), data: "rm -rf /\n".into() },
            Request::KillSession { id: "other".into() },
            Request::Attach { id: "other".into() },
            Request::SetRootConfigField { root_path: root.clone(), key: "command".into(), value: "evil".into() },
            Request::SetOrchestration { workspace_id: "ws".into(), rails: vec![], conflict_notes: vec![] },
        ] {
            assert!(
                matches!(authorize(&id, &req, false), Err(Response::Forbidden { .. })),
                "agent should be refused {}",
                request_type_name(&req)
            );
        }
    }

    /// The agent role's half of the tool guard, and only its half: this
    /// says WHICH WORKSPACE an agent is standing in. Which tools inside
    /// it are writable is `save_tool_by_root`'s guard, tested above --
    /// authorize cannot answer that, because the answer is a row in the
    /// database rather than anything in the request.
    ///
    /// The unscoped pair stays refused, and that is the point of the
    /// `ByRoot` variants existing at all: `SaveTool` takes the scope
    /// from its payload, so an agent allowed to send it could store a
    /// tool global to every workspace on the machine.
    #[test]
    fn an_agent_may_author_its_own_workspaces_tools_and_never_the_unscoped_pair() {
        let (_ws, root, _card) = workspace_with_card();
        let (_other, other_root, _other_card) = workspace_with_card();
        let id = ClientIdentity::agent("sess-1", &root, &root);

        for req in [
            Request::SaveToolByRoot { root_path: root.clone(), tool: a_tool("u1", None) },
            Request::DeleteToolByRoot { root_path: root.clone(), id: "u1".into() },
            Request::GetToolsByRoot { root_path: root.clone() },
        ] {
            assert!(
                authorize(&id, &req, false).is_ok(),
                "agent should be allowed {} in its own workspace",
                request_type_name(&req)
            );
        }

        for req in [
            // Another workspace's root: outside its scope.
            Request::SaveToolByRoot { root_path: other_root.clone(), tool: a_tool("u1", None) },
            Request::DeleteToolByRoot { root_path: other_root, id: "u1".into() },
            // The unscoped pair: the scope would be the payload's.
            Request::SaveTool { tool: a_tool("u1", None) },
            Request::DeleteTool { id: "u1".into() },
        ] {
            assert!(
                matches!(authorize(&id, &req, false), Err(Response::Forbidden { role, .. }) if role == "agent"),
                "agent should be refused {}",
                request_type_name(&req)
            );
        }
    }

    #[test]
    fn an_agent_owns_only_its_own_session_id() {
        let (_ws, root, _card) = workspace_with_card();
        let id = ClientIdentity::agent("sess-1", &root, &root);
        assert!(authorize(
            &id,
            &Request::NameSession { session_id: "sess-1".into(), name: "x".into(), agent_conversation_id: None },
            false
        )
        .is_ok());
        assert!(matches!(
            authorize(
                &id,
                &Request::NameSession { session_id: "sess-2".into(), name: "x".into(), agent_conversation_id: None },
                false
            ),
            Err(Response::Forbidden { .. })
        ));
    }

    #[test]
    fn a_remote_identity_is_denied_every_request_in_phase_one() {
        let id = ClientIdentity {
            role: Role::Remote,
            session_id: None,
            workspace_root: None,
            cwd: None,
        };
        for req in one_of_every_request_variant_for_authorize() {
            // Hello is never authorized (it sets the role), so skip it.
            if matches!(req, Request::Hello { .. }) {
                continue;
            }
            assert!(
                matches!(authorize(&id, &req, false), Err(Response::Forbidden { role, .. }) if role == "remote"),
                "remote should be refused {} in phase 1",
                request_type_name(&req)
            );
        }
    }

    /// A representative request of every variant, for sweeping `authorize`.
    /// Kept local (rather than reusing protocol's) so the daemon test does
    /// not depend on that helper's visibility.
    fn one_of_every_request_variant_for_authorize() -> Vec<Request> {
        vec![
            Request::CreateSession { workspace_path: "/x".into(), cwd: "/x".into(), command: None },
            Request::ListSessions,
            Request::SessionProcesses,
            Request::EndOrphan { id: "s".into() },
            Request::WriteInput { id: "s".into(), data: "x".into() },
            Request::QueueInput { id: "s".into(), text: "x".into() },
            Request::ListQueuedInputs,
            Request::SetQueuedInputs { id: "s".into(), queued_ids: vec![] },
            Request::SendQueuedInput { id: "s".into(), queued_id: "q".into() },
            Request::ResizeSession { id: "s".into(), cols: 80, rows: 24 },
            Request::KillSession { id: "s".into() },
            Request::Attach { id: "s".into() },
            Request::Snapshot { id: "s".into() },
            Request::SetFailurePatterns { id: "s".into(), patterns: vec![] },
            Request::GetBoard { workspace_id: "w".into() },
            Request::SetBoard { workspace_id: "w".into(), columns: vec![], labels: vec![] },
            Request::DeleteBoard { workspace_id: "w".into() },
            Request::WatchGavinRoot { workspace_id: "w".into(), root_path: "/x".into() },
            Request::UnwatchGavinRoot { workspace_id: "w".into() },
            Request::GetGavinTree { workspace_id: "w".into() },
            Request::InitGavinRoot { root_path: "/x".into(), workspace_name: "w".into() },
            Request::CreateGavinContext { parent_folder: "/x".into() },
            Request::AddExternalGavinContext { root_path: "/x".into(), folder: "/y".into() },
            Request::RemoveExternalGavinContext { root_path: "/x".into(), folder: "/y".into() },
            sff("/x/a.md"),
            Request::SetRootConfigField { root_path: "/x".into(), key: "k".into(), value: "v".into() },
            Request::ScanGavinRoot { root_path: "/x".into() },
            Request::ReadPrd { root_path: "/x".into() },
            Request::GetBoardByRoot { root_path: "/x".into() },
            Request::PromoteChecklistItem { plan_path: "/x/a.md".into(), item: "i".into() },
            Request::SetChecklistItem { path: "/x/a.md".into(), line_index: 0, expected_text: "i".into(), checked: true },
            Request::SpawnAgentSession { root_path: "/x".into(), cwd: "/x".into(), command: "sh".into() },
            Request::DeleteCardFile { path: "/x/a.md".into() },
            Request::ArchiveCard { path: "/x/a.md".into() },
            Request::UnarchiveCard { path: "/x/a.md".into() },
            Request::GetOrchestration { workspace_id: "w".into() },
            Request::SetOrchestration { workspace_id: "w".into(), rails: vec![], conflict_notes: vec![] },
            Request::SetRailRun { rail_id: "r".into(), state: "x".into(), current_stage_id: None },
            Request::SetStepRun {
                step_id: "s".into(),
                state: "x".into(),
                session_id: None,
                reason: None,
                conversation_id: None,
                launch_cwd: None,
                resume_attempts: None,
            },
            Request::GetOrchestrationByRoot { root_path: "/x".into() },
            Request::SetOrchestrationByRoot { root_path: "/x".into(), rails: vec![], conflict_notes: vec![] },
            Request::SetRailRunByRoot { root_path: "/x".into(), rail_id: "r".into(), state: "x".into(), current_stage_id: None },
            Request::GetTools { workspace_id: "w".into() },
            Request::GetToolsByRoot { root_path: "/x".into() },
            Request::DeleteTool { id: "t".into() },
            Request::DeleteToolByRoot { root_path: "/x".into(), id: "t".into() },
            Request::SaveToolByRoot { root_path: "/x".into(), tool: a_tool("t", None) },
            Request::GetGroupTemplates { workspace_id: "w".into() },
            Request::DeleteGroupTemplate { id: "g".into() },
            Request::GitDirtyPaths { cwd: "/x".into(), limit: 10 },
            Request::NameSession { session_id: "s".into(), name: "n".into(), agent_conversation_id: None },
            Request::CardRuns { workspace_id: "w".into(), path: "/x/a.md".into() },
            Request::ToolRuns { workspace_id: "w".into() },
            Request::GetProtocolVersion,
            Request::Shutdown,
        ]
    }

    #[test]
    fn set_and_look_up_a_session_token_hash() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        registry
            .insert(&SessionRecord {
                id: "s1".into(),
                workspace_path: "/tmp/ws".into(),
                cwd: "/tmp/ws".into(),
                command: None,
                status: SessionStatus::Idle,
                restored: false,
                generation: 0,
                interrupted: false,
                process: None,
                orphan: None,
                failure_reason: None,
            })
            .unwrap();
        let hash = protocol::hash_token_hex("the-token");
        registry.set_token_hash("s1", &hash).unwrap();
        assert_eq!(registry.session_id_for_token_hash(&hash).unwrap().as_deref(), Some("s1"));
        // A token nobody minted matches nothing.
        assert_eq!(
            registry.session_id_for_token_hash(&protocol::hash_token_hex("nope")).unwrap(),
            None
        );
    }

    fn start_test_server() -> (std::path::PathBuf, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let socket_path = dir.path().join("daemon.sock");
        let db_path = dir.path().join("registry.sqlite");

        let registry = Registry::open(&db_path).unwrap();
        let kanban = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        let manager = Arc::new(SessionManager::new(registry, kanban, test_orchestration_store()));
        // `serve` (unlike `run_server`) does not mint one, so set a known
        // token here: the Hello tests present it to take the `app` role
        // and check the server_proof against it.
        manager.set_daemon_token("test-daemon-token".to_string());

        // Bound here rather than on the server thread, so this function
        // cannot return before the socket is accepting. The wait it
        // replaces -- poll until the socket file appears -- was watching
        // for something `bind(2)` does and `connect(2)` does not depend
        // on, and every caller's FIRST connect was riding on the gap.
        let listener = bind_server(&socket_path).unwrap();
        std::thread::spawn(move || {
            serve(listener, manager).unwrap();
        });

        (socket_path, dir)
    }

    fn request(stream: &mut Stream, req: &Request) -> Response {
        write_message(stream, req).unwrap();
        let mut reader = line_reader(stream.try_clone().unwrap());
        read_message(&mut reader).unwrap().unwrap()
    }

    #[test]
    fn a_hello_with_the_daemon_token_becomes_app_with_a_valid_proof() {
        let (socket_path, _dir) = start_test_server();
        let mut conn = Stream::connect(&socket_path).unwrap();
        let resp = request(
            &mut conn,
            &Request::Hello {
                client: "app".into(),
                protocol_version: protocol::PROTOCOL_VERSION,
                auth: protocol::HelloAuth::DaemonToken { token: "test-daemon-token".into() },
                nonce: "nonce-123".into(),
            },
        );
        match resp {
            Response::HelloAck { role, session_id, server_proof, daemon_version, workspace_root } => {
                assert_eq!(role, "app");
                assert_eq!(daemon_version, protocol::PROTOCOL_VERSION);
                assert_eq!(session_id, None);
                assert_eq!(workspace_root, None);
                // The proof the app checks to know it reached the real daemon.
                assert_eq!(
                    server_proof.as_deref(),
                    Some(protocol::server_proof("test-daemon-token", "nonce-123").as_str())
                );
            }
            other => panic!("expected HelloAck, got {other:?}"),
        }
    }

    #[test]
    fn a_hello_with_no_auth_is_local_and_a_wrong_token_does_not_elevate() {
        let (socket_path, _dir) = start_test_server();
        let mut conn = Stream::connect(&socket_path).unwrap();
        match request(
            &mut conn,
            &Request::Hello {
                client: "cli".into(),
                protocol_version: protocol::PROTOCOL_VERSION,
                auth: protocol::HelloAuth::None,
                nonce: "n".into(),
            },
        ) {
            Response::HelloAck { role, server_proof, .. } => {
                assert_eq!(role, "local");
                assert_eq!(server_proof, None);
            }
            other => panic!("expected HelloAck, got {other:?}"),
        }

        let mut conn2 = Stream::connect(&socket_path).unwrap();
        match request(
            &mut conn2,
            &Request::Hello {
                client: "impostor".into(),
                protocol_version: protocol::PROTOCOL_VERSION,
                auth: protocol::HelloAuth::DaemonToken { token: "wrong".into() },
                nonce: "n".into(),
            },
        ) {
            Response::HelloAck { role, .. } => assert_eq!(role, "local"),
            other => panic!("expected HelloAck, got {other:?}"),
        }
    }

    #[test]
    fn a_second_hello_on_one_connection_is_refused() {
        let (socket_path, _dir) = start_test_server();
        let mut conn = Stream::connect(&socket_path).unwrap();
        let hello = Request::Hello {
            client: "app".into(),
            protocol_version: protocol::PROTOCOL_VERSION,
            auth: protocol::HelloAuth::None,
            nonce: "n".into(),
        };
        assert!(matches!(request(&mut conn, &hello), Response::HelloAck { .. }));
        match request(&mut conn, &hello) {
            Response::Error { message } => assert!(message.contains("already sent"), "{message}"),
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn an_agent_hello_over_the_socket_is_scoped_and_refused_a_shell() {
        // A real session, so its token maps to a real scope. `serve` is
        // running against this manager, but we drive create_session
        // directly to mint a token, then re-derive its hash the way a
        // Hello would.
        let (socket_path, _dir) = start_test_server();

        // Create a session over the socket the way the app does; then a
        // second connection presents a *forged* session token (unknown to
        // the registry) and must fall back to local rather than agent.
        let mut conn = Stream::connect(&socket_path).unwrap();
        match request(
            &mut conn,
            &Request::Hello {
                client: "mcp".into(),
                protocol_version: protocol::PROTOCOL_VERSION,
                auth: protocol::HelloAuth::SessionToken { token: "not-a-real-token".into() },
                nonce: "n".into(),
            },
        ) {
            Response::HelloAck { role, session_id, .. } => {
                assert_eq!(role, "local");
                assert_eq!(session_id, None);
            }
            other => panic!("expected HelloAck, got {other:?}"),
        }
    }

    /// The read half of the worktree-agent contract: HelloAck must name
    /// the owning workspace (not the PTY cwd), so gavin-mcp can prefer
    /// it over walking into the worktree's decoy `.gavin-root`.
    #[test]
    fn an_agent_hello_ack_carries_the_sessions_workspace_root_not_its_cwd() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        let workspace = "/tmp/real-workspace";
        let worktree = "/tmp/rail-worktree";
        manager
            .registry
            .lock()
            .unwrap()
            .insert(&SessionRecord {
                id: "sess-rail".into(),
                workspace_path: workspace.into(),
                cwd: worktree.into(),
                command: None,
                status: SessionStatus::Idle,
                restored: false,
                generation: 0,
                interrupted: false,
                process: None,
                orphan: None,
                failure_reason: None,
            })
            .unwrap();
        let token = "agent-token-for-hello";
        manager
            .registry
            .lock()
            .unwrap()
            .set_token_hash("sess-rail", &protocol::hash_token_hex(token))
            .unwrap();

        let (id, ack) = manager.resolve_hello(
            &protocol::HelloAuth::SessionToken { token: token.into() },
            "n",
        );
        assert_eq!(id.role, Role::Agent);
        assert_eq!(id.workspace_root.as_deref(), Some(std::path::Path::new(workspace)));
        assert_eq!(id.cwd.as_deref(), Some(std::path::Path::new(worktree)));
        match ack {
            Response::HelloAck {
                role,
                session_id,
                workspace_root,
                server_proof,
                ..
            } => {
                assert_eq!(role, "agent");
                assert_eq!(session_id.as_deref(), Some("sess-rail"));
                assert_eq!(workspace_root.as_deref(), Some(workspace));
                assert!(server_proof.is_none());
            }
            other => panic!("expected HelloAck, got {other:?}"),
        }
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
        let mut watcher = Stream::connect(&socket_path).unwrap();
        write_message(
            &mut watcher,
            &Request::WatchGavinRoot { workspace_id: "ws-1".into(), root_path: root.clone() },
        )
        .unwrap();
        let mut reader = line_reader(watcher.try_clone().unwrap());
        let first: Option<Response> = read_message(&mut reader).unwrap();
        assert!(matches!(first, Some(Response::GavinTreeChanged { .. })));

        let mut cmd = Stream::connect(&socket_path).unwrap();
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


    // ---- Agent-authored workspace tools (v37) ------------------------------
    //
    // Every test below is about the GUARD, and the guard is the feature:
    // an agent may author this workspace's own tools and nothing else.
    // Gavin's built-ins and the machine's global tools are refused by the
    // daemon, deterministically, whatever the caller asked for -- so none
    // of this rests on gavin-mcp checking its arguments first.

    /// A watched workspace, ready for `*ByRoot` calls: the socket, the
    /// root, the watcher's reader (for the pushes) and a command
    /// connection. The first `GavinTreeChanged` is drained, so the next
    /// message off `reader` is whatever the test's own write produced.
    fn watched_workspace() -> (
        std::path::PathBuf,
        String,
        std::io::BufReader<Stream>,
        Stream,
        tempfile::TempDir,
        tempfile::TempDir,
    ) {
        let (socket_path, server_dir) = start_test_server();
        let ws_dir = tempfile::tempdir().unwrap();
        crate::gavin::init_gavin_root(ws_dir.path(), "WS").unwrap();
        let root = ws_dir.path().to_string_lossy().to_string();

        let mut watcher = Stream::connect(&socket_path).unwrap();
        write_message(
            &mut watcher,
            &Request::WatchGavinRoot { workspace_id: "ws-1".into(), root_path: root.clone() },
        )
        .unwrap();
        let mut reader = line_reader(watcher.try_clone().unwrap());
        let first: Option<Response> = read_message(&mut reader).unwrap();
        assert!(matches!(first, Some(Response::GavinTreeChanged { .. })));

        let cmd = Stream::connect(&socket_path).unwrap();
        (socket_path, root, reader, cmd, server_dir, ws_dir)
    }

    fn error_message(resp: Response) -> String {
        match resp {
            Response::Error { message } => message,
            other => panic!("expected Error, got {other:?}"),
        }
    }

    /// The scope is the daemon's, not the payload's. A tool asking to be
    /// global -- which is what `workspace_id: None` means to `SaveTool`
    /// -- is stored as this workspace's, and the reply says so, so the
    /// caller reports what was written rather than what it proposed.
    #[test]
    fn save_tool_by_root_stamps_the_watched_workspaces_scope_over_the_payload() {
        let (_sock, root, mut reader, mut cmd, _d1, _d2) = watched_workspace();

        let mut asked_for_global = a_tool("u1", None);
        asked_for_global.name = "Deploy".into();
        let resp = request(
            &mut cmd,
            &Request::SaveToolByRoot { root_path: root.clone(), tool: asked_for_global },
        );
        match resp {
            Response::Tools { tools } => {
                assert_eq!(tools.len(), 1);
                assert_eq!(tools[0].workspace_id.as_deref(), Some("ws-1"));
            }
            other => panic!("expected Tools, got {other:?}"),
        }

        // Stored as the workspace's own, and therefore invisible to a
        // workspace that is not this one -- which a global tool would not
        // be.
        match request(&mut cmd, &Request::GetTools { workspace_id: "ws-2".into() }) {
            Response::Tools { tools } => assert!(tools.is_empty(), "{tools:?}"),
            other => panic!("expected Tools, got {other:?}"),
        }

        // ...and a workspace_id naming somebody else fares no better.
        let mut asked_for_another = a_tool("u2", Some("ws-2"));
        asked_for_another.name = "Sneak".into();
        request(
            &mut cmd,
            &Request::SaveToolByRoot { root_path: root.clone(), tool: asked_for_another },
        );
        match request(&mut cmd, &Request::GetTools { workspace_id: "ws-2".into() }) {
            Response::Tools { tools } => assert!(tools.is_empty(), "{tools:?}"),
            other => panic!("expected Tools, got {other:?}"),
        }
        match request(&mut cmd, &Request::GetTools { workspace_id: "ws-1".into() }) {
            Response::Tools { tools } => assert_eq!(tools.len(), 2),
            other => panic!("expected Tools, got {other:?}"),
        }

        // An EDIT of the workspace's own tool still goes through: the
        // guard is about whose tool it is, not about the id being new.
        let mut edited = a_tool("u1", None);
        edited.name = "Deploy twice".into();
        request(&mut cmd, &Request::SaveToolByRoot { root_path: root, tool: edited });
        match request(&mut cmd, &Request::GetTools { workspace_id: "ws-1".into() }) {
            Response::Tools { tools } => {
                assert_eq!(tools.len(), 2, "an edit is not a third tool: {tools:?}");
                let own = tools.iter().find(|t| t.id == "u1").expect("u1");
                assert_eq!(own.name, "Deploy twice");
            }
            other => panic!("expected Tools, got {other:?}"),
        }

        // Every write pushed the whole library at the watching app.
        for expected in [1, 2, 2] {
            match read_message(&mut reader).unwrap() {
                Some(Response::ToolsChanged { workspace_id, tools }) => {
                    assert_eq!(workspace_id, "ws-1");
                    assert_eq!(tools.len(), expected);
                }
                other => panic!("expected ToolsChanged, got {other:?}"),
            }
        }
    }

    /// Gavin's own tools are not this workspace's. They are constants in
    /// the app and never rows in this table, so a save wearing one of
    /// their ids is not an edit -- it is a row that would SHADOW the
    /// built-in everywhere the app merges the library by id.
    #[test]
    fn save_tool_by_root_refuses_one_of_gavins_built_in_ids() {
        let (_sock, root, _reader, mut cmd, _d1, _d2) = watched_workspace();
        let message = error_message(request(
            &mut cmd,
            &Request::SaveToolByRoot {
                root_path: root.clone(),
                tool: a_tool("builtin:push", Some("ws-1")),
            },
        ));
        // The BY-ROOT refusal, named: `save_tool` refuses a `builtin:`
        // id too, so an assertion on the word "built-in" alone would
        // pass with this guard deleted.
        assert!(message.contains("an agent can only author"), "{message}");
        assert!(message.contains("builtin:push"), "{message}");

        match request(&mut cmd, &Request::GetTools { workspace_id: "ws-1".into() }) {
            Response::Tools { tools } => assert!(tools.is_empty(), "{tools:?}"),
            other => panic!("expected Tools, got {other:?}"),
        }
    }

    /// A GLOBAL tool belongs to every workspace on the machine. Saving
    /// over its id is how a tool changes scope, so without this guard an
    /// agent could rewrite a shared tool's body and pull it into one
    /// workspace in a single call that looks like an ordinary edit.
    #[test]
    fn save_tool_by_root_refuses_to_overwrite_a_global_or_foreign_tool() {
        let (_sock, root, _reader, mut cmd, _d1, _d2) = watched_workspace();
        // Seeded the way the APP writes them -- the unscoped SaveTool,
        // which an agent connection is refused outright.
        request(&mut cmd, &Request::SaveTool { tool: a_tool("g1", None) });
        request(&mut cmd, &Request::SaveTool { tool: a_tool("f1", Some("ws-2")) });

        let mut hijacked = a_tool("g1", Some("ws-1"));
        hijacked.body = "rm -rf /".into();
        let message = error_message(request(
            &mut cmd,
            &Request::SaveToolByRoot { root_path: root.clone(), tool: hijacked },
        ));
        assert!(message.contains("GLOBAL"), "{message}");

        let message = error_message(request(
            &mut cmd,
            &Request::SaveToolByRoot { root_path: root, tool: a_tool("f1", Some("ws-1")) },
        ));
        assert!(message.contains("another workspace"), "{message}");

        // Refused, not partly applied: the global tool still has its own
        // body and its own scope.
        match request(&mut cmd, &Request::GetTools { workspace_id: "ws-1".into() }) {
            Response::Tools { tools } => {
                let global = tools.iter().find(|t| t.id == "g1").expect("global tool");
                assert_eq!(global.workspace_id, None);
                assert!(!global.body.contains("rm -rf"), "{:?}", global.body);
                assert!(!tools.iter().any(|t| t.id == "f1"), "{tools:?}");
            }
            other => panic!("expected Tools, got {other:?}"),
        }
    }

    /// The same three rules on the way out, plus one the app does not
    /// need: an id nothing owns is an ERROR here. `delete_tool` is a
    /// no-op on an unknown id, which would leave an agent that mistyped
    /// one reading "ok" about a tool it can still see.
    #[test]
    fn delete_tool_by_root_removes_this_workspaces_own_and_refuses_every_other_id() {
        let (_sock, root, mut reader, mut cmd, _d1, _d2) = watched_workspace();
        request(&mut cmd, &Request::SaveTool { tool: a_tool("g1", None) });
        request(&mut cmd, &Request::SaveTool { tool: a_tool("f1", Some("ws-2")) });
        request(&mut cmd, &Request::SaveToolByRoot { root_path: root.clone(), tool: a_tool("u1", None) });
        assert!(matches!(
            read_message::<_, Response>(&mut reader).unwrap(),
            Some(Response::ToolsChanged { .. })
        ));

        for (id, expected) in [
            ("builtin:push", "built-in"),
            ("g1", "GLOBAL"),
            ("f1", "another workspace"),
            ("nope", "no tool with id"),
        ] {
            let message = error_message(request(
                &mut cmd,
                &Request::DeleteToolByRoot { root_path: root.clone(), id: id.into() },
            ));
            assert!(message.contains(expected), "deleting {id}: {message}");
        }

        // Its own, though, goes -- and the app hears about it.
        assert!(matches!(
            request(&mut cmd, &Request::DeleteToolByRoot { root_path: root, id: "u1".into() }),
            Response::Ok
        ));
        match request(&mut cmd, &Request::GetTools { workspace_id: "ws-1".into() }) {
            Response::Tools { tools } => {
                assert!(!tools.iter().any(|t| t.id == "u1"), "{tools:?}");
                assert!(tools.iter().any(|t| t.id == "g1"), "the global tool is untouched");
            }
            other => panic!("expected Tools, got {other:?}"),
        }
        match read_message(&mut reader).unwrap() {
            Some(Response::ToolsChanged { tools, .. }) => {
                assert!(!tools.iter().any(|t| t.id == "u1"), "{tools:?}");
            }
            other => panic!("expected ToolsChanged, got {other:?}"),
        }
    }

    /// A root no watcher claims is a refusal, not a write nobody will
    /// ever see -- the same rule every other `*ByRoot` write follows.
    #[test]
    fn tool_writes_by_root_need_the_workspace_open() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        for req in [
            Request::SaveToolByRoot { root_path: "/nope".into(), tool: a_tool("u1", None) },
            Request::DeleteToolByRoot { root_path: "/nope".into(), id: "u1".into() },
        ] {
            match handle_request(&manager, req) {
                Response::Error { message } => assert!(message.contains("not open"), "{message}"),
                other => panic!("expected Error, got {other:?}"),
            }
        }
    }

    /// Arming a rail from outside the app. Two things the plain
    /// `SetRailRun` cannot do: name the workspace, and therefore tell the
    /// app -- without which the row lands in SQLite and the rail keeps
    /// reading idle on screen.
    #[test]
    fn set_rail_run_by_root_writes_the_row_and_pushes_it() {
        let (socket_path, _dir) = start_test_server();
        let ws_dir = tempfile::tempdir().unwrap();
        crate::gavin::init_gavin_root(ws_dir.path(), "WS").unwrap();
        let root = ws_dir.path().to_string_lossy().to_string();

        let mut watcher = Stream::connect(&socket_path).unwrap();
        write_message(
            &mut watcher,
            &Request::WatchGavinRoot { workspace_id: "ws-1".into(), root_path: root.clone() },
        )
        .unwrap();
        let mut reader = line_reader(watcher.try_clone().unwrap());
        let first: Option<Response> = read_message(&mut reader).unwrap();
        assert!(matches!(first, Some(Response::GavinTreeChanged { .. })));

        let mut cmd = Stream::connect(&socket_path).unwrap();
        // The plan first, and its own push read off the watcher, so the
        // push asserted below is the one the run-state write produced.
        request(
            &mut cmd,
            &Request::SetOrchestrationByRoot {
                root_path: root.clone(),
                rails: vec![orch_rail("r1", "t1")],
                conflict_notes: vec![],
            },
        );
        assert!(matches!(
            read_message::<_, Response>(&mut reader).unwrap(),
            Some(Response::OrchestrationChanged { .. })
        ));

        let resp = request(
            &mut cmd,
            &Request::SetRailRunByRoot {
                root_path: root.clone(),
                rail_id: "r1".into(),
                state: "running".into(),
                current_stage_id: Some("s1".into()),
            },
        );
        assert!(matches!(resp, Response::Ok));

        match request(&mut cmd, &Request::GetOrchestration { workspace_id: "ws-1".into() }) {
            Response::Orchestration { rail_runs, .. } => {
                assert_eq!(rail_runs[0].rail_id, "r1");
                assert_eq!(rail_runs[0].state, "running");
                assert_eq!(rail_runs[0].current_stage_id.as_deref(), Some("s1"));
            }
            other => panic!("expected Orchestration, got {other:?}"),
        }
        match read_message(&mut reader).unwrap() {
            Some(Response::OrchestrationChanged { workspace_id, orchestration }) => {
                assert_eq!(workspace_id, "ws-1");
                assert_eq!(orchestration.rail_runs[0].state, "running");
                assert_eq!(orchestration.rail_runs[0].current_stage_id.as_deref(), Some("s1"));
            }
            other => panic!("expected OrchestrationChanged, got {other:?}"),
        }
    }

    /// A root gavin does not have open is refused rather than written
    /// blind: the row would name a rail in a database nobody is watching,
    /// and the agent would be told its rail was armed.
    #[test]
    fn set_rail_run_by_root_errors_when_the_workspace_is_not_open() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        match handle_request(
            &manager,
            Request::SetRailRunByRoot {
                root_path: "/nowhere".into(),
                rail_id: "r1".into(),
                state: "running".into(),
                current_stage_id: Some("s1".into()),
            },
        ) {
            Response::Error { message } => assert!(message.contains("not open in gavin"), "{message}"),
            other => panic!("expected Error, got {other:?}"),
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
                conversation_id: None,
                launch_cwd: None,
                resume_attempts: None,
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

        let mut stream = Stream::connect(&socket_path).unwrap();
        write_message(
            &mut stream,
            &Request::WatchGavinRoot {
                workspace_id: "ws-1".to_string(),
                root_path: ws_dir.path().to_string_lossy().to_string(),
            },
        )
        .unwrap();

        let mut reader = line_reader(stream.try_clone().unwrap());
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
        let mut stream = Stream::connect(&socket_path).unwrap();
        write_message(
            &mut stream,
            &Request::WatchGavinRoot {
                workspace_id: "ws-2".to_string(),
                root_path: "/definitely/not/real".to_string(),
            },
        )
        .unwrap();
        let mut reader = line_reader(stream.try_clone().unwrap());
        let first: Response = read_message(&mut reader).unwrap().unwrap();
        match first {
            Response::GavinTreeChanged { tree, .. } => assert!(tree.root_missing),
            other => panic!("expected GavinTreeChanged, got {other:?}"),
        }

        // GetGavinTree over a second (command-style) connection.
        let mut cmd = Stream::connect(&socket_path).unwrap();
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
    fn a_watch_superseded_while_starting_is_never_installed() {
        // Watchers start off the connection thread now, so two answers
        // can be in flight for one workspace. The generation guard is
        // what makes the LAST request win regardless of which start
        // finishes first -- and what makes an unwatch stick even when a
        // start it interrupted lands afterwards.
        let dir = tempfile::tempdir().unwrap();
        let ws = tempfile::tempdir().unwrap();
        crate::gavin::init_gavin_root(ws.path(), "WS").unwrap();
        let manager = test_manager(&dir);
        let root = ws.path().to_path_buf();
        let start = |id: &str| {
            let (_ours, theirs) = Stream::pair().unwrap();
            crate::gavin::GavinWatcher::start(
                id.to_string(),
                root.clone(),
                Arc::new(Mutex::new(theirs)),
                None,
            )
        };

        // Unwatched while starting: nothing may be left behind.
        let g1 = manager.begin_gavin_watch("ws-1");
        manager.unwatch_gavin_root("ws-1");
        assert!(!manager.install_gavin_watcher("ws-1", g1, start("ws-1")));
        assert!(manager.gavin_tree_snapshot("ws-1").is_none());

        // Re-watched while starting: the later request wins even though
        // it is installed first, and the earlier one is refused.
        let g2 = manager.begin_gavin_watch("ws-1");
        let g3 = manager.begin_gavin_watch("ws-1");
        assert!(manager.install_gavin_watcher("ws-1", g3, start("ws-1")));
        assert!(!manager.install_gavin_watcher("ws-1", g2, start("ws-1")));
        assert!(manager.gavin_tree_snapshot("ws-1").is_some());

        // A plain watch still replaces the previous one.
        let g4 = manager.begin_gavin_watch("ws-1");
        assert!(manager.install_gavin_watcher("ws-1", g4, start("ws-1")));
        assert!(manager.gavin_tree_snapshot("ws-1").is_some());
    }

    #[test]
    fn board_and_spawn_require_a_watched_root() {
        let (socket_path, _dir) = start_test_server();
        let ws_dir = tempfile::tempdir().unwrap();
        crate::gavin::init_gavin_root(ws_dir.path(), "WS").unwrap();
        let root = ws_dir.path().to_string_lossy().to_string();
        let mut cmd = Stream::connect(&socket_path).unwrap();

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
        let mut app = Stream::connect(&socket_path).unwrap();
        write_message(
            &mut app,
            &Request::WatchGavinRoot { workspace_id: "ws-a".to_string(), root_path: root.clone() },
        )
        .unwrap();
        let mut app_reader = line_reader(app.try_clone().unwrap());
        let first: Response = read_message(&mut app_reader).unwrap().unwrap();
        assert!(matches!(first, Response::GavinTreeChanged { .. }));

        // The "shim": spawns over a command connection.
        let mut cmd = Stream::connect(&socket_path).unwrap();
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

        let mut cmd = Stream::connect(&socket_path).unwrap();
        // A session id this daemon never issued is refused rather than
        // pushed anywhere: an agent outliving its tab must hear about it.
        let resp = request(
            &mut cmd,
            &Request::NameSession { session_id: "ghost".to_string(), name: "x".to_string(), agent_conversation_id: None },
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
            &Request::NameSession { session_id: session_id.clone(), name: "x".to_string(), agent_conversation_id: None },
        );
        assert!(matches!(resp, Response::Error { .. }));

        // The "app": attaches on a streaming connection. Note it never
        // watches a root -- naming is deliberately independent of that,
        // so an agent in a rail's worktree can still name its tab.
        let mut app = Stream::connect(&socket_path).unwrap();
        write_message(&mut app, &Request::Attach { id: session_id.clone() }).unwrap();
        let mut app_reader = line_reader(app.try_clone().unwrap());

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
                    agent_conversation_id: None,
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

        // A self-reported agent_conversation_id lands on this session's
        // bound card, once it has one -- exactly the same conversation_id
        // column LinkCardSession's own minted id would occupy.
        let resp = request(
            &mut cmd,
            &Request::LinkCardSession {
                workspace_id: "ws-1".to_string(),
                path: "/p/t.md".to_string(),
                session_id: session_id.clone(),
                cwd: "/tmp".to_string(),
                command: None,
                conversation_id: None,
                launch_cwd: None,
                resume_attempts: None,
                base_sha: None,
            },
        );
        assert!(matches!(resp, Response::Ok));

        let resp = request(
            &mut cmd,
            &Request::NameSession {
                session_id: session_id.clone(),
                name: "login flow".to_string(),
                agent_conversation_id: Some("rollout-abc123".to_string()),
            },
        );
        assert!(matches!(resp, Response::Ok));

        let resp = request(&mut cmd, &Request::GetBoard { workspace_id: "ws-1".to_string() });
        match resp {
            Response::Board { card_sessions, .. } => {
                let bound = card_sessions.iter().find(|s| s.path == "/p/t.md").expect("card not bound");
                assert_eq!(bound.conversation_id, Some("rollout-abc123".to_string()));
            }
            other => panic!("expected Board, got {other:?}"),
        }

        let resp = request(&mut cmd, &Request::KillSession { id: session_id });
        assert!(matches!(resp, Response::Ok));
    }

    #[test]
    fn a_self_reported_conversation_id_for_an_unbound_session_is_still_a_successful_rename() {
        let (socket_path, _dir) = start_test_server();
        let mut cmd = Stream::connect(&socket_path).unwrap();

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

        let mut app = Stream::connect(&socket_path).unwrap();
        write_message(&mut app, &Request::Attach { id: session_id.clone() }).unwrap();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            let resp = request(
                &mut cmd,
                &Request::NameSession {
                    session_id: session_id.clone(),
                    name: "no card yet".to_string(),
                    agent_conversation_id: Some("rollout-xyz".to_string()),
                },
            );
            if matches!(resp, Response::Ok) {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "attach never registered: {resp:?}");
            std::thread::sleep(std::time::Duration::from_millis(25));
        }

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

        let mut stream = Stream::connect(&socket_path).unwrap();
        write_message(
            &mut stream,
            &Request::WatchGavinRoot {
                workspace_id: "ws-r".to_string(),
                root_path: root.to_string_lossy().to_string(),
            },
        )
        .unwrap();
        let mut reader = line_reader(stream.try_clone().unwrap());
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
        let mut cmd = Stream::connect(&socket_path).unwrap();

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
                complexity: Some("simple".to_string()),
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
        let mut cmd = Stream::connect(&socket_path).unwrap();

        // DP-03: a path outside any .gavin*/plans|docs|specs folder is
        // refused outright now -- it used to write the field and only
        // silently skip the move.
        let loose = ws_dir.path().join("p.md");
        std::fs::write(&loose, "---\nstatus: To Do\n---\n# P\n").unwrap();
        let resp = request(
            &mut cmd,
            &Request::SetPlanFrontmatterField {
                path: loose.to_string_lossy().to_string(),
                key: "status".to_string(),
                value: "Done".to_string(),
            },
        );
        assert!(matches!(resp, Response::Error { .. }));
        assert_eq!(std::fs::read_to_string(&loose).unwrap(), "---\nstatus: To Do\n---\n# P\n");

        crate::gavin::init_gavin_root(ws_dir.path(), "WS").unwrap();
        let plan = ws_dir.path().join(crate::gavin::GAVIN_ROOT_DIR).join("plans").join("p.md");
        std::fs::write(&plan, "---\nstatus: To Do\n---\n# P\n").unwrap();

        let resp = request(
            &mut cmd,
            &Request::SetPlanFrontmatterField {
                path: plan.to_string_lossy().to_string(),
                key: "priority".to_string(),
                value: "high".to_string(),
            },
        );
        match resp {
            Response::PlanFieldSet { path } => assert_eq!(path, plan.to_string_lossy()),
            other => panic!("expected PlanFieldSet, got {other:?}"),
        }
        assert_eq!(
            std::fs::read_to_string(&plan).unwrap(),
            "---\npriority: high\nstatus: To Do\n---\n# P\n"
        );

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
        let mut cmd = Stream::connect(&socket_path).unwrap();
        let root = ws_dir.path().to_string_lossy().to_string();

        let resp = request(
            &mut cmd,
            &Request::InitGavinRoot { root_path: root.clone(), workspace_name: "WS".to_string() },
        );
        assert!(matches!(resp, Response::Ok));
        let resp = request(
            &mut cmd,
            &Request::InitGavinRoot { root_path: root.clone(), workspace_name: "WS".to_string() },
        );
        assert!(matches!(resp, Response::Ok)); // idempotent second run

        // CreateGavinContext is confined to a workspace this daemon
        // already watches (DP-03) -- unlike InitGavinRoot just above,
        // which exists to bootstrap a root nothing has watched yet.
        let mut watcher = Stream::connect(&socket_path).unwrap();
        write_message(
            &mut watcher,
            &Request::WatchGavinRoot { workspace_id: "ws-1".into(), root_path: root.clone() },
        )
        .unwrap();
        let mut reader = line_reader(watcher.try_clone().unwrap());
        let first: Option<Response> = read_message(&mut reader).unwrap();
        assert!(matches!(first, Some(Response::GavinTreeChanged { .. })));

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

        // Unrelated to any watched root: refused even though it exists.
        let elsewhere = tempfile::tempdir().unwrap();
        let resp = request(
            &mut cmd,
            &Request::CreateGavinContext {
                parent_folder: elsewhere.path().to_string_lossy().to_string(),
            },
        );
        assert!(matches!(resp, Response::Error { .. }));
    }

    #[test]
    fn add_external_gavin_context_over_socket_is_confined_to_a_watched_root() {
        let (socket_path, _dir) = start_test_server();
        let ws_dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        crate::gavin::init_gavin_root(ws_dir.path(), "WS").unwrap();
        let root = ws_dir.path().to_string_lossy().to_string();
        let lib = outside.path().join("shared-lib");
        std::fs::create_dir_all(&lib).unwrap();

        let mut cmd = Stream::connect(&socket_path).unwrap();

        // DP-03: root_path names a workspace nobody has told this daemon
        // to watch, so the write is refused rather than landing on it
        // unasked.
        let resp = request(
            &mut cmd,
            &Request::AddExternalGavinContext { root_path: root.clone(), folder: lib.to_string_lossy().to_string() },
        );
        assert!(matches!(resp, Response::Error { .. }));
        assert!(
            !std::fs::read_to_string(ws_dir.path().join(crate::gavin::GAVIN_ROOT_DIR).join("config.toml"))
                .unwrap()
                .contains("shared-lib")
        );

        let mut watcher = Stream::connect(&socket_path).unwrap();
        write_message(
            &mut watcher,
            &Request::WatchGavinRoot { workspace_id: "ws-1".into(), root_path: root.clone() },
        )
        .unwrap();
        let mut reader = line_reader(watcher.try_clone().unwrap());
        let first: Option<Response> = read_message(&mut reader).unwrap();
        assert!(matches!(first, Some(Response::GavinTreeChanged { .. })));

        let resp = request(
            &mut cmd,
            &Request::AddExternalGavinContext { root_path: root.clone(), folder: lib.to_string_lossy().to_string() },
        );
        assert!(matches!(resp, Response::Ok));
        assert!(lib.join(".gavin").join("config.toml").is_file());

        // A folder truly inside the workspace still refuses (unaffected
        // by confining root_path first): `add_external_context`'s own
        // `folder.starts_with(root)` check must still see them as the
        // same tree even though root_path arrives at the confinement
        // guard un-canonicalized and macOS's tmp dirs symlink into
        // /private underneath it.
        let inner = ws_dir.path().join("inner");
        std::fs::create_dir_all(&inner).unwrap();
        let resp = request(
            &mut cmd,
            &Request::AddExternalGavinContext { root_path: root, folder: inner.to_string_lossy().to_string() },
        );
        assert!(matches!(resp, Response::Error { .. }));
    }

    #[test]
    fn create_list_and_kill_session_over_socket() {
        let (socket_path, _dir) = start_test_server();
        let mut stream = Stream::connect(&socket_path).unwrap();

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

    /// Polls `list_sessions` until `id` is gone, or gives up. A poll
    /// rather than a signal because the teardown that forgets a session
    /// runs on that session's own pump thread, not on the one asking.
    fn wait_until_forgotten(manager: &SessionManager, id: &str) -> bool {
        let deadline = std::time::Instant::now() + PROCESS_BUDGET;
        while std::time::Instant::now() < deadline {
            if !manager.list_sessions().unwrap().iter().any(|s| s.id == id) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn a_session_whose_process_ends_stops_being_listed() {
        // `kill_session` used to be the only thing that ever removed a
        // session, and nobody closes a tab that was never there: a hidden
        // run -- the Git tab's commit agent, a tool, any launch the app
        // takes off screen the moment it ends -- left its row behind for
        // good. `recover` skips an exited row rather than dropping it, so
        // the pile survived daemon restarts too, and the task manager was
        // the only place to clear it, by hand, one run at a time.
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        let id = manager.create_session("/tmp", "/tmp", Some("exit 3")).unwrap();

        // The pump is what witnesses an exit, and only an Attach starts
        // one. The client end stays bound: dropping it would close the
        // socket the teardown reports the exit on.
        let (_client, server) = Stream::pair().unwrap();
        manager.attach(&id, Arc::new(Mutex::new(server)));

        assert!(
            wait_until_forgotten(&manager, &id),
            "a session whose process has ended must stop being listed"
        );
    }

    #[test]
    fn a_session_that_left_a_process_behind_keeps_its_row_when_its_shell_ends() {
        // The one row worth keeping. A session whose command outlived its
        // daemon is recorded as an orphan, and that row is the only handle
        // the human has on the survivor -- `end_orphan` reads the pid out
        // of it. Reaping it when the bare shell recovery put in its place
        // finally exits would leave the process running with nothing left
        // offering to end it.
        let dir = tempfile::tempdir().unwrap();
        let (survivor, handle) = spawn_survivor();
        leftover_row_running(
            &dir.path().join("registry.sqlite"),
            "orphan-kept",
            "/tmp",
            Some("claude"),
            SessionStatus::Working,
            Some(handle),
        );
        let manager = Arc::new(recovered_manager(&dir));

        let (_client, server) = Stream::pair().unwrap();
        manager.attach("orphan-kept", Arc::new(Mutex::new(server)));
        manager.write_input("orphan-kept", b"exit\n").unwrap();

        // Waits for the status rather than for the row to vanish, because
        // not vanishing is the whole assertion.
        let deadline = std::time::Instant::now() + PROCESS_BUDGET;
        let mut exited = None;
        while std::time::Instant::now() < deadline && exited.is_none() {
            match manager.list_sessions().unwrap().into_iter().find(|s| s.id == "orphan-kept") {
                Some(row) if row.status == "exited" => exited = Some(row),
                Some(_) => std::thread::sleep(Duration::from_millis(20)),
                None => panic!("the row of a session with a surviving process must be kept"),
            }
        }
        let row = exited.expect("the recovered shell never exited");
        assert_eq!(
            row.orphan.map(|o| o.pid),
            Some(handle.pid),
            "the surviving process must still be reported"
        );

        kill_and_reap(survivor);
    }

    #[test]
    fn write_input_to_unknown_session_returns_error() {
        let (socket_path, _dir) = start_test_server();
        let mut stream = Stream::connect(&socket_path).unwrap();

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
        stream: &mut Stream,
        id: &str,
        input: &str,
        marker: &str,
    ) -> Vec<Response> {
        write_message(stream, &Request::WriteInput { id: id.to_string(), data: input.to_string() })
            .unwrap();
        let mut reader = line_reader(stream.try_clone().unwrap());
        let mut seen = Vec::new();
        let mut collected = String::new();
        let deadline = std::time::Instant::now() + PROCESS_BUDGET;
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
        let mut first = Stream::connect(&socket_path).unwrap();
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
        let mut second = Stream::connect(&socket_path).unwrap();
        write_message(&mut second, &Request::Attach { id: id.clone() }).unwrap();
        let mut reader = line_reader(second.try_clone().unwrap());
        let deadline = std::time::Instant::now() + PROCESS_BUDGET;
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
        let mut stream = Stream::connect(&socket_path).unwrap();
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
        let mut reader = line_reader(stream.try_clone().unwrap());
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
        let deadline = std::time::Instant::now() + PROCESS_BUDGET;
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
        let mut stream = Stream::connect(&socket_path).unwrap();
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
            let mut stream = Stream::connect(&socket_path).unwrap();
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
        let mut stream2 = Stream::connect(&socket_path).unwrap();
        write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();
        write_message(
            &mut stream2,
            &Request::WriteInput {
                id: id.clone(),
                data: "echo attached_ok\n".to_string(),
            },
        )
        .unwrap();

        let mut reader = line_reader(stream2.try_clone().unwrap());
        let mut collected = String::new();
        let deadline = std::time::Instant::now() + PROCESS_BUDGET;
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
            let mut stream = Stream::connect(&socket_path).unwrap();
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
            let mut stream2 = Stream::connect(&socket_path).unwrap();
            write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();
            // Give the pump thread a moment to start before we drop the connection.
            std::thread::sleep(Duration::from_millis(100));
        }

        // Reattach from a third connection and drive the session — this must
        // not race with, or lose output to, the now-disconnected first pump.
        let mut stream3 = Stream::connect(&socket_path).unwrap();
        write_message(&mut stream3, &Request::Attach { id: id.clone() }).unwrap();
        write_message(
            &mut stream3,
            &Request::WriteInput {
                id: id.clone(),
                data: "echo reattached_ok\n".to_string(),
            },
        )
        .unwrap();

        let mut reader = line_reader(stream3.try_clone().unwrap());
        let mut collected = String::new();
        let deadline = std::time::Instant::now() + PROCESS_BUDGET;
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
            let mut stream = Stream::connect(&socket_path).unwrap();
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
            let mut stream2 = Stream::connect(&socket_path).unwrap();
            write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();
            std::thread::sleep(Duration::from_millis(100));
        }

        // Produce output while nobody is attached; the pump is still running
        // and keeps appending to the scrollback buffer even with no writer.
        {
            let mut stream = Stream::connect(&socket_path).unwrap();
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
        let mut stream3 = Stream::connect(&socket_path).unwrap();
        write_message(&mut stream3, &Request::Attach { id: id.clone() }).unwrap();

        let mut reader = line_reader(stream3.try_clone().unwrap());
        let mut collected = String::new();
        let deadline = std::time::Instant::now() + PROCESS_BUDGET;
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
        let mut stream = Stream::connect(&socket_path).unwrap();

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

    /// DP-05: `create_session` must refuse once it is already holding
    /// `session_ceiling` live PTYs, with a named error rather than
    /// spawning without bound. Driven against a lowered ceiling -- see
    /// `MAX_LIVE_SESSIONS`'s doc comment -- so this doesn't spawn
    /// hundreds of real shells.
    #[test]
    fn session_ceiling_refuses_the_nplus1th_and_frees_up_on_kill() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        manager.session_ceiling.store(2, Ordering::SeqCst);
        let cwd = dir.path().to_string_lossy().to_string();

        let s1 = manager.create_session("/ws", &cwd, Some("/bin/sh")).unwrap();
        manager.create_session("/ws", &cwd, Some("/bin/sh")).unwrap();

        let err = manager.create_session("/ws", &cwd, Some("/bin/sh")).unwrap_err();
        assert!(err.to_string().contains("session ceiling reached"), "{err}");
        assert_eq!(manager.sessions.lock().unwrap().len(), 2);

        // Killing one frees the slot the ceiling was counting.
        manager.kill_session(&s1).unwrap();
        manager.create_session("/ws", &cwd, Some("/bin/sh")).unwrap();
    }

    /// DP-05: `handle_connection` must refuse to admit a connection past
    /// `connection_ceiling` into its request loop, and the refusal has to
    /// be the first thing that connection sees -- not silence. Each of
    /// the first `max` connections sends one request before the next one
    /// connects, so the server-side counter is guaranteed to have
    /// already counted it (otherwise the accept and the increment race).
    #[test]
    fn connection_ceiling_refuses_the_nplus1th_connection() {
        let dir = tempfile::tempdir().unwrap();
        let socket_path = dir.path().join("daemon.sock");
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        let kanban = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        let manager = Arc::new(SessionManager::new(registry, kanban, test_orchestration_store()));
        manager.connection_ceiling.store(2, Ordering::SeqCst);
        let listener = bind_server(&socket_path).unwrap();
        std::thread::spawn(move || {
            serve(listener, manager).unwrap();
        });

        let mut kept = Vec::new();
        for _ in 0..2 {
            let mut stream = Stream::connect(&socket_path).unwrap();
            // Round-trips a harmless request so the connection's thread
            // has definitely run past the ceiling check (and counted
            // itself) before the next connection is opened.
            let resp = request(&mut stream, &Request::GetProtocolVersion);
            assert!(matches!(resp, Response::ProtocolVersion { .. }));
            kept.push(stream);
        }

        let over = Stream::connect(&socket_path).unwrap();
        let mut reader = line_reader(over.try_clone().unwrap());
        let resp: Response = read_message(&mut reader).unwrap().unwrap();
        match resp {
            Response::Error { message } => assert!(message.contains("connection ceiling reached"), "{message}"),
            other => panic!("expected Error, got {other:?}"),
        }

        drop(kept);
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

        manager.link_card_session("ws-1", &before, "s-1", "/p", None, None, None, None, None).unwrap();
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
                    auto_resume: None,
                    trigger: None,
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

    /// A manager watching a fresh gavin root, with one card written into
    /// it. Returns the manager, the workspace dir (kept alive by the
    /// caller) and the card's canonical path -- the only spelling
    /// anything ever learns a card path in.
    fn manager_watching_a_card(
        dir: &tempfile::TempDir,
        ws: &tempfile::TempDir,
        status: &str,
    ) -> (Arc<SessionManager>, String, String) {
        let manager = test_manager(dir);
        crate::gavin::init_gavin_root(ws.path(), "WS").unwrap();
        let root = ws.path().canonicalize().unwrap();
        let card = root.join(".gavin-root").join("plans").join("ship.md");
        std::fs::write(&card, format!("---\ntitle: Ship\nstatus: {status}\n---\n")).unwrap();
        let (_ours, theirs) = Stream::pair().unwrap();
        SessionManager::watch_gavin_root(
            &manager,
            "ws-1",
            &root.to_string_lossy(),
            Arc::new(Mutex::new(theirs)),
        );
        (manager, root.to_string_lossy().to_string(), card.to_string_lossy().to_string())
    }

    /// A live session in the registry AND in the pty map, which is what
    /// `claim_card_for_session` reads to decide whether an existing
    /// binding still has an agent behind it.
    fn live_session(manager: &SessionManager) -> String {
        manager.create_session("/tmp/ws", "/tmp", Some("/bin/sh")).unwrap()
    }

    // --- the run history (v27) ---------------------------------------

    #[test]
    fn card_runs_answers_over_the_wire_for_a_card_that_has_been_run() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        manager
            .link_card_session("ws-1", "/p/t.md", "s-1", "/p", Some("claude"), None, None, None, None)
            .unwrap();

        let resp = handle_request(
            &manager,
            Request::CardRuns { workspace_id: "ws-1".into(), path: "/p/t.md".into() },
        );

        match resp {
            Response::CardRuns { runs } => {
                assert_eq!(runs.len(), 1);
                assert_eq!(runs[0].session_id, "s-1");
            }
            other => panic!("expected CardRuns, got {other:?}"),
        }
    }

    // --- standalone tool runs (v30) -----------------------------------

    #[test]
    fn a_tool_run_opens_and_reads_back_over_the_wire() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);

        assert!(matches!(
            handle_request(
                &manager,
                Request::StartToolRun {
                    workspace_id: "ws-1".into(),
                    tool_id: "builtin:push".into(),
                    session_id: "s-1".into(),
                    command: Some("git push".into()),
                    launch_cwd: Some("/r/app".into()),
                    conversation_id: None,
                },
            ),
            Response::Ok
        ));

        match handle_request(&manager, Request::ToolRuns { workspace_id: "ws-1".into() }) {
            Response::ToolRuns { runs } => {
                assert_eq!(runs.len(), 1);
                assert_eq!(runs[0].tool_id, "builtin:push");
                assert_eq!(runs[0].launch_cwd.as_deref(), Some("/r/app"));
                // Abandoned, not running: the session id names nothing
                // the registry is hosting, and the read reconciles.
                assert_eq!(runs[0].outcome, "abandoned");
            }
            other => panic!("expected ToolRuns, got {other:?}"),
        }
    }

    #[test]
    fn tool_runs_is_an_empty_list_for_a_workspace_that_has_run_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        match handle_request(&manager, Request::ToolRuns { workspace_id: "ws-nothing".into() }) {
            Response::ToolRuns { runs } => assert!(runs.is_empty()),
            other => panic!("expected ToolRuns, got {other:?}"),
        }
    }

    /// An agent tool's verdict comes from the app, because its session is
    /// still alive when its turn ends -- nothing the daemon watches would
    /// ever close that row.
    #[test]
    fn an_agent_tools_verdict_is_recorded_by_the_caller() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        let session = live_session(&manager);
        handle_request(
            &manager,
            Request::StartToolRun {
                workspace_id: "ws-1".into(),
                tool_id: "builtin:commit".into(),
                session_id: session.clone(),
                command: None,
                launch_cwd: None,
                conversation_id: Some("conv-1".into()),
            },
        );

        assert!(matches!(
            handle_request(
                &manager,
                Request::SetToolRunOutcome {
                    session_id: session.clone(),
                    outcome: "passed".into(),
                    exit_code: None,
                },
            ),
            Response::Ok
        ));

        match handle_request(&manager, Request::ToolRuns { workspace_id: "ws-1".into() }) {
            Response::ToolRuns { runs } => {
                assert_eq!(runs[0].outcome, "passed");
                assert!(runs[0].ended_at.is_some());
                assert_eq!(runs[0].conversation_id.as_deref(), Some("conv-1"));
            }
            other => panic!("expected ToolRuns, got {other:?}"),
        }
    }

    #[test]
    fn card_runs_is_an_empty_list_for_a_card_nobody_has_run() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);

        match handle_request(
            &manager,
            Request::CardRuns { workspace_id: "ws-1".into(), path: "/p/never.md".into() },
        ) {
            Response::CardRuns { runs } => assert!(runs.is_empty()),
            other => panic!("expected CardRuns, got {other:?}"),
        }
    }

    /// `running` is a claim, and this is the only layer that can check
    /// it. The pump closes a run where it reports `SessionExited`, but a
    /// pump only exists while something is attached -- so a session that
    /// ends unattached would leave a run reading as live indefinitely.
    #[test]
    fn a_run_whose_session_the_registry_no_longer_has_stops_claiming_to_be_running() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        manager
            .link_card_session("ws-1", "/p/t.md", "s-gone", "/p", None, None, None, None, None)
            .unwrap();
        assert_eq!(manager.kanban.lock().unwrap().card_runs("ws-1", "/p/t.md").unwrap()[0].outcome, "running");

        let runs = manager.card_runs("ws-1", "/p/t.md").unwrap();

        assert_eq!(runs[0].outcome, "abandoned");
        assert_eq!(runs[0].ended_at, None, "nobody watched it end, so nobody can say when");
        // Written back, not computed per read: the next reader gets the
        // same answer without re-deriving it.
        assert_eq!(
            manager.kanban.lock().unwrap().card_runs("ws-1", "/p/t.md").unwrap()[0].outcome,
            "abandoned"
        );
    }

    #[test]
    fn a_run_whose_session_is_still_live_keeps_running() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        let session = live_session(&manager);
        manager
            .link_card_session("ws-1", "/p/t.md", &session, "/tmp", None, None, None, None, None)
            .unwrap();

        assert_eq!(manager.card_runs("ws-1", "/p/t.md").unwrap()[0].outcome, "running");

        manager.kill_session(&session).unwrap();
    }

    #[test]
    fn claiming_binds_an_in_progress_card_to_the_session_that_wrote_it() {
        let dir = tempfile::tempdir().unwrap();
        let ws = tempfile::tempdir().unwrap();
        let (manager, root, card) = manager_watching_a_card(&dir, &ws, "In Progress");
        let session = live_session(&manager);

        assert!(manager.claim_card_for_session(&root, &card, &session).unwrap());

        let bound = &manager.get_board("ws-1").unwrap().card_sessions[0];
        assert_eq!(bound.path, card);
        assert_eq!(bound.session_id, session);
        // Off the session record, not the caller: the agent knows
        // neither, and Re-launch replays both.
        assert_eq!(bound.cwd, "/tmp");
        assert_eq!(bound.command.as_deref(), Some("/bin/sh"));
    }

    #[test]
    fn claiming_leaves_a_card_the_agent_only_filed_startable() {
        // The whole reason the claim reads the card back instead of
        // trusting the call: an agent that files a backlog of To Do
        // cards has not started any of them, and a binding is what makes
        // the board stop offering Run.
        let dir = tempfile::tempdir().unwrap();
        let ws = tempfile::tempdir().unwrap();
        let (manager, root, card) = manager_watching_a_card(&dir, &ws, "To Do");
        let session = live_session(&manager);

        assert!(!manager.claim_card_for_session(&root, &card, &session).unwrap());
        assert!(manager.get_board("ws-1").unwrap().card_sessions.is_empty());
    }

    #[test]
    fn claiming_never_takes_a_card_off_another_live_session() {
        let dir = tempfile::tempdir().unwrap();
        let ws = tempfile::tempdir().unwrap();
        let (manager, root, card) = manager_watching_a_card(&dir, &ws, "In Progress");
        let owner = live_session(&manager);
        let bystander = live_session(&manager);
        manager.link_card_session("ws-1", &card, &owner, "/p", None, None, None, None, None).unwrap();

        assert!(!manager.claim_card_for_session(&root, &card, &bystander).unwrap());
        assert_eq!(manager.get_board("ws-1").unwrap().card_sessions[0].session_id, owner);
    }

    #[test]
    fn claiming_replaces_a_binding_whose_session_is_gone() {
        // A binding outlives its session on purpose (the card detail's
        // Re-launch reads it), so "already bound" cannot mean "already
        // being worked". Only a session the daemon still hosts keeps its
        // claim.
        let dir = tempfile::tempdir().unwrap();
        let ws = tempfile::tempdir().unwrap();
        let (manager, root, card) = manager_watching_a_card(&dir, &ws, "In Progress");
        manager.link_card_session("ws-1", &card, "s-long-gone", "/p", None, None, None, None, None).unwrap();
        let session = live_session(&manager);

        assert!(manager.claim_card_for_session(&root, &card, &session).unwrap());
        assert_eq!(manager.get_board("ws-1").unwrap().card_sessions[0].session_id, session);
    }

    /// The claim is a STATUS write, and the agent sending it is very
    /// often the one gavin launched -- its prompt tells it to keep the
    /// card's status current. Re-linking with None for the run fields
    /// therefore erased, from a card being worked correctly, the
    /// conversation its Resume needs, the directory that conversation
    /// has to reopen in, the budget bounding automatic resumes, and the
    /// baseline the Changes view diffs against.
    #[test]
    fn claiming_carries_the_run_record_it_found_instead_of_wiping_it() {
        let dir = tempfile::tempdir().unwrap();
        let ws = tempfile::tempdir().unwrap();
        let (manager, root, card) = manager_watching_a_card(&dir, &ws, "In Progress");
        let session = live_session(&manager);
        let base = "3333333333333333333333333333333333333333";
        manager
            .link_card_session(
                "ws-1",
                &card,
                &session,
                "/p",
                Some("claude 'run it'"),
                Some("conv-1"),
                Some("/p/wt"),
                Some(1),
                Some(base),
            )
            .unwrap();

        assert!(manager.claim_card_for_session(&root, &card, &session).unwrap());

        let bound = &manager.get_board("ws-1").unwrap().card_sessions[0];
        assert_eq!(bound.conversation_id.as_deref(), Some("conv-1"));
        assert_eq!(bound.launch_cwd.as_deref(), Some("/p/wt"));
        assert_eq!(bound.resume_attempts, Some(1));
        assert_eq!(bound.base_sha.as_deref(), Some(base));
        // What the claim IS still lands: the session record's cwd and
        // command, which is how a card an agent picked up gets a
        // Re-launch at all.
        assert_eq!(bound.cwd, "/tmp");
        assert_eq!(bound.command.as_deref(), Some("/bin/sh"));
    }

    /// The one baseline nobody else can take. Every gavin-launched run
    /// gets its sha from the app, before there is a session; a card the
    /// human's own agent picked up has only this moment.
    #[test]
    fn a_first_claim_records_the_baseline_of_the_sessions_checkout() {
        let dir = tempfile::tempdir().unwrap();
        let ws = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        let repo_path = repo.path().to_str().unwrap();
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec!["config", "user.email", "t@example.com"],
            vec!["config", "user.name", "T"],
            vec!["config", "commit.gpgsign", "false"],
            vec!["commit", "-q", "--allow-empty", "-m", "base"],
        ] {
            std::process::Command::new("git").args(&args).current_dir(repo_path).status().unwrap();
        }
        let head = String::from_utf8(
            std::process::Command::new("git")
                .args(["rev-parse", "HEAD"])
                .current_dir(repo_path)
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .to_string();

        let (manager, root, card) = manager_watching_a_card(&dir, &ws, "In Progress");
        let session = manager.create_session("/tmp/ws", repo_path, Some("/bin/sh")).unwrap();

        assert!(manager.claim_card_for_session(&root, &card, &session).unwrap());
        assert_eq!(
            manager.get_board("ws-1").unwrap().card_sessions[0].base_sha.as_deref(),
            Some(head.as_str())
        );
    }

    /// An agent working outside a repository is not an error and not a
    /// refusal: it binds, with no baseline, and the Changes surfaces say
    /// there is nothing to diff against.
    #[test]
    fn a_claim_from_outside_a_repository_binds_with_no_baseline() {
        let dir = tempfile::tempdir().unwrap();
        let ws = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let outside_path = outside.path().to_str().unwrap();
        // Only meaningful if the tempdir really is outside a checkout --
        // a machine whose temp dir sits inside one would prove nothing.
        let inside_a_repo = std::process::Command::new("git")
            .args(["rev-parse", "--show-toplevel"])
            .current_dir(outside_path)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if inside_a_repo {
            return;
        }

        let (manager, root, card) = manager_watching_a_card(&dir, &ws, "In Progress");
        let session = manager.create_session("/tmp/ws", outside_path, Some("/bin/sh")).unwrap();

        assert!(manager.claim_card_for_session(&root, &card, &session).unwrap());
        assert_eq!(manager.get_board("ws-1").unwrap().card_sessions[0].base_sha, None);
    }

    #[test]
    fn claiming_keys_the_binding_on_the_path_the_board_uses() {
        // The MCP hands over whatever `create_plan_file` built out of the
        // context folder the agent passed, and `.` is the obvious thing
        // to pass. The board's card id is the watcher's SCANNED path, so
        // a binding keyed on the un-normalized spelling would exist and
        // never be found.
        let dir = tempfile::tempdir().unwrap();
        let ws = tempfile::tempdir().unwrap();
        let (manager, root, card) = manager_watching_a_card(&dir, &ws, "In Progress");
        let session = live_session(&manager);
        let dotted = card.replace("/.gavin-root/", "/./.gavin-root/");
        assert_ne!(dotted, card);

        assert!(manager.claim_card_for_session(&root, &dotted, &session).unwrap());
        assert_eq!(manager.get_board("ws-1").unwrap().card_sessions[0].path, card);
    }

    #[test]
    fn claiming_refuses_a_workspace_that_is_not_open_in_gavin() {
        // Same rule as every other root-addressed request: with no
        // watcher there is no workspace id, and a binding keyed on a
        // guess would attach to the wrong board.
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        let session = live_session(&manager);
        let err = manager
            .claim_card_for_session("/tmp/not-a-workspace", "/tmp/not-a-workspace/a.md", &session)
            .unwrap_err();
        assert!(err.to_string().contains("not open in gavin"), "{err}");
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

        manager.link_card_session("ws-1", &before, "s-1", "/p", None, None, None, None, None).unwrap();
        manager
            .set_orchestration("ws-1", vec![orch_rail_at("r1", "t1", &before)], vec![])
            .unwrap();

        // The move the daemon knows nothing about: an agent's `mv`, or the
        // one-time migration that introduced plans/done/.
        std::fs::create_dir_all(plans.join("done")).unwrap();
        let after = plans.join("done").join("ship.md");
        std::fs::rename(&card, &after).unwrap();
        let after = after.to_string_lossy().to_string();

        let (ours, theirs) = Stream::pair().unwrap();
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
        let mut reader = line_reader(ours);
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
        let (ours, theirs) = Stream::pair().unwrap();
        ours.set_read_timeout(Some(Duration::from_millis(500))).unwrap();
        SessionManager::watch_gavin_root(
            &manager,
            "ws-1",
            &root.to_string_lossy(),
            Arc::new(Mutex::new(theirs)),
        );
        let mut reader = line_reader(ours);
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

    /// The archive's bulk delete is the one action that ends a card for
    /// good, so the rows keyed to it have to end with it -- the binding,
    /// the run history, and the rail step, which would otherwise sit
    /// there naming a file no restore can bring back.
    #[test]
    fn deleting_a_card_takes_its_rail_step_and_tells_the_watching_app() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);

        let ws = tempfile::tempdir().unwrap();
        crate::gavin::init_gavin_root(ws.path(), "WS").unwrap();
        let root = ws.path().canonicalize().unwrap();
        let archive = root.join(".gavin-root").join("plans").join("archive");
        std::fs::create_dir_all(&archive).unwrap();
        let card = archive.join("ship.md");
        std::fs::write(&card, "---\ntitle: Ship\nstatus: Done\n---\n").unwrap();
        let path = card.to_string_lossy().to_string();

        manager.link_card_session("ws-1", &path, "s-1", "/p", None, None, None, None, None).unwrap();
        manager.set_orchestration("ws-1", vec![orch_rail_at("r1", "t1", &path)], vec![]).unwrap();

        let (ours, theirs) = Stream::pair().unwrap();
        ours.set_read_timeout(Some(Duration::from_millis(500))).unwrap();
        SessionManager::watch_gavin_root(
            &manager,
            "ws-1",
            &root.to_string_lossy(),
            Arc::new(Mutex::new(theirs)),
        );
        let mut reader = line_reader(ours);
        assert!(matches!(
            read_message::<_, Response>(&mut reader).unwrap().unwrap(),
            Response::GavinTreeChanged { .. }
        ));

        manager.delete_card_file(&path).unwrap();

        assert!(!card.exists());
        assert!(manager.get_board("ws-1").unwrap().card_sessions.is_empty());
        assert!(manager.card_runs("ws-1", &path).unwrap().is_empty());
        // The stage went with its only step; the rail itself stays.
        let orch = manager.get_orchestration("ws-1").unwrap();
        assert_eq!(orch.rails.len(), 1);
        assert!(orch.rails[0].stages.is_empty());

        // The app holds its own copy of every step, so the removal has to
        // reach it -- otherwise it keeps scheduling a card this daemon
        // has just deleted.
        match read_message::<_, Response>(&mut reader).unwrap().unwrap() {
            Response::OrchestrationChanged { orchestration, .. } => {
                assert!(orchestration.rails[0].stages.is_empty());
            }
            other => panic!("expected OrchestrationChanged, got {other:?}"),
        }
    }

    /// A card on no rail must not provoke a push: the app would take a
    /// whole orchestration it already has, and the no-op scan test below
    /// makes the same point about the watcher.
    #[test]
    fn deleting_a_card_no_rail_carries_pushes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);

        let ws = tempfile::tempdir().unwrap();
        crate::gavin::init_gavin_root(ws.path(), "WS").unwrap();
        let root = ws.path().canonicalize().unwrap();
        let card = root.join(".gavin-root").join("plans").join("ship.md");
        std::fs::write(&card, "---\ntitle: Ship\n---\n").unwrap();

        let (ours, theirs) = Stream::pair().unwrap();
        ours.set_read_timeout(Some(Duration::from_millis(500))).unwrap();
        SessionManager::watch_gavin_root(
            &manager,
            "ws-1",
            &root.to_string_lossy(),
            Arc::new(Mutex::new(theirs)),
        );
        let mut reader = line_reader(ours);
        assert!(matches!(
            read_message::<_, Response>(&mut reader).unwrap().unwrap(),
            Response::GavinTreeChanged { .. }
        ));

        manager.delete_card_file(&card.to_string_lossy()).unwrap();

        // Whatever the watcher makes of the vanished file, none of it is
        // an orchestration the rails never carried.
        while let Ok(Some(resp)) = read_message::<_, Response>(&mut reader) {
            assert!(
                !matches!(resp, Response::OrchestrationChanged { .. }),
                "a card on no rail pushed an orchestration"
            );
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

        let (ours, theirs) = Stream::pair().unwrap();
        ours.set_read_timeout(Some(Duration::from_millis(500))).unwrap();
        SessionManager::watch_gavin_root(
            &manager,
            "ws-1",
            &ws.path().to_string_lossy(),
            Arc::new(Mutex::new(theirs)),
        );

        let mut reader = line_reader(ours);
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

    // ---- v21: a quiet agent that BROKE is not a finished one ----------
    //
    // The whole family this exists for was measured, not assumed, under a
    // temp $HOME with the real Claude Code CLI pointed at a fake API:
    //
    //   connection reset before a response   retries visibly, then
    //                                        "API Error: Connection dropped
    //                                        (ECONNRESET)" and goes quiet
    //   connection killed MID-STREAM         "API Error: API returned an
    //                                        empty or malformed response",
    //                                        quiet within ~11s
    //   529 overloaded / 401 expired token   retries visibly, then API Error:
    //   429 usage limit                      "API Error: ... You have
    //                                        exceeded your usage limit.",
    //                                        quiet within ~11s
    //   server accepts and never answers     spinner forever; never quiet
    //
    // In EVERY terminal case the process stayed alive, the session went
    // quiet, and the scanner saw no OSC 133 and no bell -- so the daemon
    // called it `idle` and the rail marked the step done. The one thing
    // they all share is a screen line containing "API Error:".

    /// Waits for this session to report `status`, returning the reason
    /// that came with it (SessionFailed rides beside StatusChanged).
    ///
    /// Takes the reader rather than making one, and that is the whole
    /// point: an attached connection carries PTY output between the
    /// messages this is looking for, so a fresh `BufReader` per call
    /// throws away everything the previous one had already pulled off
    /// the socket. A test that waited twice would then block for good on
    /// a status that had already arrived and been discarded.
    fn await_status(
        reader: &mut BufReader<Stream>,
        id: &str,
        status: &str,
    ) -> Option<String> {
        let deadline = std::time::Instant::now() + HEURISTIC_QUIET_PERIOD * 8;
        let mut hit = false;
        let mut seen = Vec::new();
        while std::time::Instant::now() < deadline {
            // The read half is shut down by failure_test_session's
            // watchdog, so a status that never comes fails the test
            // instead of hanging it for ever.
            let resp: Response = match read_message(reader) {
                Ok(Some(r)) => r,
                // The watchdog in failure_test_session shut the read half
                // down: nothing more is coming, so say what WAS seen.
                Ok(None) => break,
                Err(e) => panic!("reading while waiting for {status:?}: {e}"),
            };
            match &resp {
                Response::StatusChanged { id: rid, status: s } if rid == id => {
                    seen.push(s.clone());
                    if s == status {
                        // `failed` is always followed by its reason; every
                        // other status has none to wait for.
                        if status != "failed" {
                            return None;
                        }
                        hit = true;
                    }
                }
                Response::SessionFailed { id: rid, reason } if rid == id && hit => {
                    return Some(reason.clone());
                }
                _ => {}
            }
        }
        panic!("never saw status {status:?} for {id}; saw {seen:?}");
    }

    /// A session with its patterns already set, then attached.
    ///
    /// That ORDER is not incidental. `request` reads the next message off
    /// the socket, and an attached connection carries PTY output and
    /// status pushes on the same wire -- so a reply read after Attach is
    /// whatever arrived first, not the reply. In the app these never
    /// share a socket at all: patterns go over the COMMAND connection
    /// (`session::set_failure_patterns`) and pushes over the streaming
    /// one.
    fn failure_test_session(
        socket_path: &std::path::Path,
        patterns: Option<&[&str]>,
    ) -> (Stream, BufReader<Stream>, String) {
        let mut stream = Stream::connect(socket_path).unwrap();
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
        if let Some(patterns) = patterns {
            let resp = request(
                &mut stream,
                &Request::SetFailurePatterns {
                    id: id.clone(),
                    patterns: patterns.iter().map(|p| p.to_string()).collect(),
                },
            );
            assert!(matches!(resp, Response::Ok), "SetFailurePatterns: {resp:?}");
        }
        write_message(&mut stream, &Request::Attach { id: id.clone() }).unwrap();
        // ONE reader for the whole test, and one that cannot block for
        // ever. NOT a socket read timeout: these messages arrive in
        // fragments, so a timeout that lands mid-message consumes half a
        // line and desynchronises everything after it. Shutting the read
        // half down from a watchdog thread ends the wait at a clean EOF
        // instead, and only ever after every deadline in here has passed.
        let reader = line_reader(stream.try_clone().unwrap());
        let guard = stream.try_clone().unwrap();
        std::thread::spawn(move || {
            std::thread::sleep(HEURISTIC_QUIET_PERIOD * 20);
            let _ = guard.shutdown(std::net::Shutdown::Read);
        });
        (stream, reader, id)
    }

    /// `printf 'API Error%s ...' :` rather than the literal text: the
    /// shell ECHOES what is typed, so a command line containing the
    /// pattern would make this pass whether or not the printf ever ran.
    /// Only the produced output carries "API Error:".
    const PRINT_FAILURE: &str =
        "printf 'API Error%s Connection dropped (ECONNRESET)\\n' :\n";

    #[test]
    fn a_quiet_session_whose_screen_shows_the_profiles_error_text_goes_failed_not_idle() {
        let (socket_path, _dir) = start_test_server();
        let (mut stream, mut reader, id) = failure_test_session(&socket_path, Some(&["API Error:"]));

        write_message(
            &mut stream,
            &Request::WriteInput { id: id.clone(), data: PRINT_FAILURE.to_string() },
        )
        .unwrap();

        let reason = await_status(&mut reader, &id, "failed");
        assert_eq!(
            reason.as_deref(),
            Some("API Error: Connection dropped (ECONNRESET)"),
            "the reason must be the agent's OWN line, which is what tells a human \
             a dead network from an expired token"
        );
    }

    #[test]
    fn the_same_screen_with_no_patterns_set_still_goes_idle() {
        // A profile whose error text nobody has verified gets NO failure
        // detection -- never a guess. This is the control for the test
        // above, and the reason the patterns are supplied per session
        // rather than hard-coded in the daemon.
        let (socket_path, _dir) = start_test_server();
        let (mut stream, mut reader, id) = failure_test_session(&socket_path, None);

        write_message(
            &mut stream,
            &Request::WriteInput { id: id.clone(), data: PRINT_FAILURE.to_string() },
        )
        .unwrap();

        await_status(&mut reader, &id, "idle");
    }

    #[test]
    fn an_empty_pattern_list_means_no_detection_rather_than_matching_everything() {
        let (socket_path, _dir) = start_test_server();
        // An empty list SENT, not the absence of a call: the daemon has
        // an entry for this session and it matches nothing. That is the
        // honest reading of a profile whose error text nobody has
        // verified, and it must not read as "match everything".
        let (mut stream, mut reader, id) = failure_test_session(&socket_path, Some(&[]));
        write_message(
            &mut stream,
            &Request::WriteInput { id: id.clone(), data: PRINT_FAILURE.to_string() },
        )
        .unwrap();
        await_status(&mut reader, &id, "idle");
    }

    #[test]
    fn typing_after_a_failure_means_the_next_turn_is_judged_on_its_own() {
        // The error stays painted in the transcript above the prompt the
        // human answers at. Without this, every later turn in that
        // session would be condemned by a line the human has already
        // read and acted on.
        let (socket_path, _dir) = start_test_server();
        let (mut stream, mut reader, id) = failure_test_session(&socket_path, Some(&["API Error:"]));
        write_message(
            &mut stream,
            &Request::WriteInput { id: id.clone(), data: PRINT_FAILURE.to_string() },
        )
        .unwrap();
        await_status(&mut reader, &id, "failed");

        write_message(
            &mut stream,
            &Request::WriteInput { id: id.clone(), data: "printf 'carrying on\n'\n".to_string() },
        )
        .unwrap();
        await_status(&mut reader, &id, "idle");
    }

    /// The reason is shown to a human on four surfaces, so it must be
    /// the agent's SENTENCE and not the bullet its TUI drew in front of
    /// it. Both glyphs here were taken off a real Claude Code screen.
    #[test]
    fn the_reason_drops_the_glyph_the_tui_painted_in_front_of_it() {
        assert_eq!(
            strip_tui_decoration("\u{23fa} API Error: 529 Overloaded."),
            "API Error: 529 Overloaded."
        );
        assert_eq!(
            strip_tui_decoration("  \u{23fa} Please run /login \u{b7} API Error: 401 expired  "),
            "Please run /login \u{b7} API Error: 401 expired"
        );
        // Nothing to strip, and nothing lost.
        assert_eq!(strip_tui_decoration("API Error: x"), "API Error: x");
    }

    /// The ordering this whole detector depends on, as an assertion
    /// rather than a comment.
    ///
    /// On wake a mid-turn session is silent, and its quiet timer is
    /// measured on `Instant` -- which on macOS is CLOCK_UPTIME_RAW and
    /// therefore did NOT advance through the suspend (measured: 371,638s
    /// of `Instant` against 433,667s of wall clock since boot on a
    /// machine with 17h of accumulated sleep). So the timer starts
    /// counting from the wake and fires `Idle` two seconds later. The
    /// watchdog has to have published its mark by then, or the rail
    /// advances on the silence and the mark arrives too late to matter.
    #[test]
    fn the_suspend_watchdog_must_outrun_the_quiet_timer() {
        assert!(
            SUSPEND_POLL_INTERVAL < HEURISTIC_QUIET_PERIOD,
            "a suspend mark published after the quiet timer has already called the \
             session idle is a mark nothing will ever read"
        );
    }

    /// The app classifies a failure by reading its reason, and a suspend
    /// is the one reason gavin writes rather than quotes. `autoResume.ts`
    /// holds this same prefix; a reword here without one there turns
    /// every wake-up failure into an unknown cause, which never
    /// auto-resumes -- the feature would go quiet with every test green.
    #[test]
    fn the_slept_reason_keeps_the_prefix_the_app_classifies_on() {
        assert_eq!(SLEPT_REASON_PREFIX, "the machine slept for");
        assert!(
            slept_reason(8040).starts_with(SLEPT_REASON_PREFIX),
            "the sentence and the prefix the app matches on have to be the same string"
        );
        assert_eq!(slept_reason(8040), "the machine slept for 2h 14m and this agent has not spoken since");
    }

    #[test]
    fn a_gap_measured_in_seconds_is_said_the_way_a_human_reads_it() {
        assert_eq!(humanize_gap(45), "45s");
        assert_eq!(humanize_gap(90), "1m");
        assert_eq!(humanize_gap(3600), "1h");
        assert_eq!(humanize_gap(8040), "2h 14m");
    }

    #[test]
    fn resize_session_returns_ok_for_existing_session() {
        let (socket_path, _dir) = start_test_server();
        let mut stream = Stream::connect(&socket_path).unwrap();

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
        let mut stream = Stream::connect(&socket_path).unwrap();

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
            let mut stream = Stream::connect(&socket_path).unwrap();
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

        let mut stream2 = Stream::connect(&socket_path).unwrap();
        write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();

        let mut reader = line_reader(stream2.try_clone().unwrap());
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
            let mut stream = Stream::connect(&socket_path).unwrap();
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

        let mut stream2 = Stream::connect(&socket_path).unwrap();
        write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();

        let mut reader = line_reader(stream2.try_clone().unwrap());

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
            let mut stream = Stream::connect(&socket_path).unwrap();
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
        // teardown runs. It forgets the session outright, so the second
        // attach below is one to an id the daemon no longer knows -- the
        // shape a tab left holding a finished run actually has.
        let mut stream1 = Stream::connect(&socket_path).unwrap();
        write_message(&mut stream1, &Request::Attach { id: id.clone() }).unwrap();
        write_message(&mut stream1, &Request::WriteInput { id: id.clone(), data: "exit\n".to_string() }).unwrap();

        let mut reader1 = line_reader(stream1.try_clone().unwrap());
        let deadline = std::time::Instant::now() + PROCESS_BUDGET;
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
        let mut stream2 = Stream::connect(&socket_path).unwrap();
        write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();

        let mut reader2 = line_reader(stream2.try_clone().unwrap());
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
    fn attach_sends_no_baseline_status_for_a_row_recovery_could_not_bring_back() {
        // The Exited gate's remaining input. A session whose process ends
        // under a live daemon is forgotten outright now -- row and PTY
        // together -- so the only Exited row an attach can still find is
        // one a previous lifetime left and recovery could not respawn.
        // Baselining it would paint a status over a session with nothing
        // in it.
        let dir = tempfile::tempdir().unwrap();
        {
            let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
            registry
                .insert(&SessionRecord {
                    id: "unrecoverable-1".to_string(),
                    workspace_path: "/definitely/does/not/exist/anywhere".to_string(),
                    cwd: "/definitely/does/not/exist/anywhere".to_string(),
                    command: Some("claude".to_string()),
                    status: SessionStatus::Working,
                    restored: false,
                    generation: 0,
                    interrupted: false,
                    process: None,
                    orphan: None,
                    failure_reason: None,
                })
                .unwrap();
        }
        let manager = Arc::new(recovered_manager(&dir));
        assert_eq!(
            manager.registry.lock().unwrap().get("unrecoverable-1").unwrap().unwrap().status,
            SessionStatus::Exited,
            "test premise: recovery must mark this row Exited and keep it"
        );

        let (client, server) = Stream::pair().unwrap();
        // Set before attach, not after: this row is Exited, so attach()
        // has nothing to baseline and drops the far end of this pair
        // straight away -- and on macOS SO_RCVTIMEO on a socketpair whose
        // peer has already gone fails with EINVAL.
        client.set_read_timeout(Some(Duration::from_millis(500))).unwrap();
        manager.attach("unrecoverable-1", Arc::new(Mutex::new(server)));
        let mut reader = line_reader(client);
        loop {
            match read_message::<_, Response>(&mut reader) {
                Ok(Some(Response::StatusChanged { id, .. })) if id == "unrecoverable-1" => {
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
            let mut stream = Stream::connect(&socket_path).unwrap();
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
        // teardown runs -- which forgets the session, leaving the second
        // attach below aimed at an id the daemon no longer knows.
        // Teardown also calls unregister_session_repo_mapping first, so
        // no mapping is left over from this first attach either.
        let mut stream1 = Stream::connect(&socket_path).unwrap();
        write_message(&mut stream1, &Request::Attach { id: id.clone() }).unwrap();
        write_message(&mut stream1, &Request::WriteInput { id: id.clone(), data: "exit\n".to_string() }).unwrap();

        let mut reader1 = line_reader(stream1.try_clone().unwrap());
        let deadline = std::time::Instant::now() + PROCESS_BUDGET;
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
        let mut stream2 = Stream::connect(&socket_path).unwrap();
        write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();

        let mut reader2 = line_reader(stream2.try_clone().unwrap());
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
            let mut stream = Stream::connect(&socket_path).unwrap();
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

        let mut stream2 = Stream::connect(&socket_path).unwrap();
        write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();
        write_message(
            &mut stream2,
            &Request::WriteInput {
                id: id.clone(),
                data: "printf '\\033]7;file://host/tmp/from-osc7\\007'\n".to_string(),
            },
        )
        .unwrap();

        let mut reader = line_reader(stream2.try_clone().unwrap());
        let deadline = std::time::Instant::now() + PROCESS_BUDGET;
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
            let mut stream = Stream::connect(&socket_path).unwrap();
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

        let mut stream2 = Stream::connect(&socket_path).unwrap();
        write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();
        write_message(
            &mut stream2,
            &Request::WriteInput {
                id: id.clone(),
                data: "printf '\\033]133;C\\007'\n".to_string(),
            },
        )
        .unwrap();

        let mut reader = line_reader(stream2.try_clone().unwrap());
        let deadline = std::time::Instant::now() + PROCESS_BUDGET;
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
            let mut stream = Stream::connect(&socket_path).unwrap();
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

        let mut stream2 = Stream::connect(&socket_path).unwrap();
        write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();
        write_message(
            &mut stream2,
            &Request::WriteInput { id: id.clone(), data: "printf '\\007'\n".to_string() },
        )
        .unwrap();

        let mut reader = line_reader(stream2.try_clone().unwrap());
        let deadline = std::time::Instant::now() + PROCESS_BUDGET;
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
            let mut stream = Stream::connect(&socket_path).unwrap();
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

        let mut stream2 = Stream::connect(&socket_path).unwrap();
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
        let mut reader = line_reader(stream2.try_clone().unwrap());
        let deadline = std::time::Instant::now() + PROCESS_BUDGET;
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
            let mut stream = Stream::connect(&socket_path).unwrap();
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

        let mut stream2 = Stream::connect(&socket_path).unwrap();
        write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();
        // Plain output with no OSC 133 markers at all -- this session
        // stays in heuristic mode for its whole life.
        write_message(
            &mut stream2,
            &Request::WriteInput { id: id.clone(), data: "echo heuristic_test\n".to_string() },
        )
        .unwrap();

        let mut reader = line_reader(stream2.try_clone().unwrap());
        let mut statuses: Vec<String> = Vec::new();
        // HEURISTIC_QUIET_PERIOD is 2 real seconds; give this a generous
        // deadline (this project's tests already accept multi-second real
        // waits for timing-dependent behavior, e.g. the existing OSC 7
        // test's 5-second deadline -- no time-mocking is used anywhere in
        // this codebase).
        let deadline = std::time::Instant::now() + PROCESS_BUDGET;
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

    /// A session whose program repaints the moment its PTY is resized --
    /// what every full-screen agent CLI does, and the whole reason a
    /// refit used to read as work. `read` rather than `sleep` in the
    /// loop so the trap runs the instant SIGWINCH lands instead of at
    /// the end of the current second.
    const REPAINTS_ON_RESIZE: &str =
        "trap 'printf gavin_redraw' WINCH; printf gavin_painted; while :; do read _unused; done";

    fn create_session_with(socket_path: &std::path::Path, command: &str) -> String {
        let mut stream = Stream::connect(socket_path).unwrap();
        let created = request(
            &mut stream,
            &Request::CreateSession {
                workspace_path: "/tmp/ws".to_string(),
                cwd: "/tmp".to_string(),
                command: Some(command.to_string()),
            },
        );
        match created {
            Response::SessionCreated { id } => id,
            other => panic!("expected SessionCreated, got {other:?}"),
        }
    }

    /// Everything this attached connection is told over `window`, split
    /// into the statuses and whether the repaint marker came through.
    ///
    /// The marker matters as much as the statuses: without it a passing
    /// assertion could just mean the resize never reached the program,
    /// which would make the whole test vacuous.
    fn collect_after(
        reader: &mut BufReader<Stream>,
        id: &str,
        window: Duration,
    ) -> (Vec<String>, bool) {
        let deadline = std::time::Instant::now() + window;
        let mut statuses = Vec::new();
        let mut repainted = false;
        while std::time::Instant::now() < deadline {
            match read_message::<_, Response>(reader) {
                Ok(Some(Response::StatusChanged { id: rid, status })) if rid == id => {
                    statuses.push(status)
                }
                Ok(Some(Response::Output { id: rid, data }))
                    if rid == id && data.contains("gavin_redraw") =>
                {
                    repainted = true
                }
                Ok(_) => {}
                // A read timeout -- keep waiting until the deadline.
                Err(_) => {}
            }
        }
        (statuses, repainted)
    }

    /// Waits for `want` to show up on this connection.
    ///
    /// Takes the reader rather than the stream, and every caller shares
    /// ONE: a `BufReader` dropped mid-stream takes whatever it had
    /// already pulled out of the socket with it, and the next one starts
    /// reading in the middle of a line.
    fn wait_for_status(reader: &mut BufReader<Stream>, id: &str, want: &str) {
        let deadline = std::time::Instant::now() + PROCESS_BUDGET;
        while std::time::Instant::now() < deadline {
            if let Ok(Some(Response::StatusChanged { id: rid, status })) =
                read_message::<_, Response>(reader)
            {
                if rid == id && status == want {
                    return;
                }
            }
        }
        panic!("never saw StatusChanged{{status:{want:?}}} for {id}");
    }

    /// An attached connection and its one reader, with a read timeout so
    /// a silent daemon ends a wait at its deadline instead of blocking
    /// forever.
    fn attach_reader(socket_path: &std::path::Path, id: &str) -> BufReader<Stream> {
        let mut stream = Stream::connect(socket_path).unwrap();
        write_message(&mut stream, &Request::Attach { id: id.to_string() }).unwrap();
        stream.set_read_timeout(Some(Duration::from_millis(100))).unwrap();
        line_reader(stream)
    }

    /// The bug: one pane geometry change refits every tab in the pane, so
    /// a single click that opened a page resized half a dozen live agents
    /// at once -- and each one's SIGWINCH repaint was read as that agent
    /// starting work. The sidebar, the tab bar and every board card bound
    /// to those sessions then said `working` about agents that were
    /// sitting still.
    #[test]
    fn a_resize_is_not_the_agent_working() {
        let (socket_path, _dir) = start_test_server();
        let id = create_session_with(&socket_path, REPAINTS_ON_RESIZE);

        let mut attached = attach_reader(&socket_path, &id);
        // The first paint is real output and legitimately reports
        // working; wait for the quiet timer to take it back to idle, so
        // what follows can only have come from the resize. Both halves,
        // in order: Attach opens with a baseline `idle`, and settling on
        // that one would resize a session whose shell has not started.
        wait_for_status(&mut attached, &id, "working");
        wait_for_status(&mut attached, &id, "idle");

        let mut commands = Stream::connect(&socket_path).unwrap();
        assert!(matches!(
            request(&mut commands, &Request::ResizeSession { id: id.clone(), cols: 100, rows: 30 }),
            Response::Ok
        ));

        let (statuses, repainted) = collect_after(&mut attached, &id, Duration::from_millis(1500));
        assert!(repainted, "the session never repainted, so this proves nothing about resizes");
        assert!(
            statuses.is_empty(),
            "a resize the daemon itself asked for was reported as the agent working: {statuses:?}"
        );
    }

    /// The more damaging half. `waiting_for_input` is cleared by renewed
    /// output, and an agent rings its notification bell exactly once --
    /// so a refit landing after the question wiped the only badge saying
    /// a human was needed, permanently.
    #[test]
    fn a_resize_never_answers_a_question_the_agent_asked() {
        let (socket_path, _dir) = start_test_server();
        let id = create_session_with(
            &socket_path,
            "trap 'printf gavin_redraw' WINCH; \
             printf '\\033]777;notify;Claude Code;needs your permission\\007'; \
             while :; do read _unused; done",
        );

        let mut attached = attach_reader(&socket_path, &id);
        wait_for_status(&mut attached, &id, "waiting_for_input");
        // Past HEURISTIC_QUIET_PERIOD, so the wait is settled and no
        // timer is about to speak for this session either way.
        std::thread::sleep(HEURISTIC_QUIET_PERIOD + Duration::from_millis(500));

        let mut commands = Stream::connect(&socket_path).unwrap();
        request(&mut commands, &Request::ResizeSession { id: id.clone(), cols: 100, rows: 30 });

        let (statuses, repainted) = collect_after(&mut attached, &id, Duration::from_millis(1500));
        assert!(repainted, "the session never repainted, so this proves nothing about resizes");
        assert!(
            statuses.is_empty(),
            "a resize took the agent's question off the board: {statuses:?}"
        );
        assert_eq!(
            manager_status(&socket_path, &id),
            "waiting_for_input",
            "the stored status must still say a human is needed"
        );
    }

    /// The other side of the window: it opens only when the size actually
    /// MOVED. The app refits far more often than the geometry changes
    /// (every mount, every ResizeObserver tick), the kernel raises no
    /// SIGWINCH for a resize to the size the PTY already has, and a
    /// window opened by one of those would forgive output nothing
    /// provoked -- real work, gone quiet for a moment.
    #[test]
    fn a_resize_that_changes_nothing_still_lets_the_agent_speak() {
        let (socket_path, _dir) = start_test_server();
        // `cat` deliberately: it ignores SIGWINCH and paints nothing at
        // startup, so this test has no repaint whose arrival it would
        // have to race. What it asserts is about the WINDOW, not about
        // repainting, and the two resize tests above already cover that
        // half against a program that does repaint.
        let id = create_session_with(&socket_path, "cat");
        let mut attached = attach_reader(&socket_path, &id);

        let mut commands = Stream::connect(&socket_path).unwrap();
        // A real move, to give the PTY a size that can then be asked for
        // a second time -- and, since nothing answers it, long enough
        // ago that its window has certainly closed.
        request(&mut commands, &Request::ResizeSession { id: id.clone(), cols: 100, rows: 30 });
        std::thread::sleep(PROVOKED_REDRAW_GRACE + Duration::from_millis(300));
        collect_after(&mut attached, &id, Duration::from_millis(300));

        // The same size again: nothing moves, so no SIGWINCH is raised,
        // so there is no repaint to forgive -- and the very next byte of
        // genuine output must still count.
        request(&mut commands, &Request::ResizeSession { id: id.clone(), cols: 100, rows: 30 });
        write_message(
            &mut commands,
            &Request::WriteInput { id: id.clone(), data: "gavin_typed\n".to_string() },
        )
        .unwrap();

        let (statuses, _) = collect_after(&mut attached, &id, Duration::from_secs(3));
        assert!(
            statuses.first().map(String::as_str) == Some("working"),
            "output right after a no-op resize must still report working, got: {statuses:?}"
        );
    }

    /// A session whose program repaints when the terminal reports a
    /// focus change into it -- what Claude Code does (it enables DEC mode
    /// 1004 at startup; verified against the real CLI). `stty raw -echo`
    /// so the tty itself does not echo the report back, exactly as a TUI
    /// in raw mode leaves it: the only output is the program's own.
    const REPAINTS_ON_FOCUS: &str = "printf gavin_painted; stty raw -echo; \
         while head -c 3 >/dev/null; do printf gavin_redraw; done";

    /// Clicking from one session to another focuses one terminal and
    /// blurs another, so xterm writes a focus report into BOTH -- and the
    /// repaint each program answers with used to read as that agent
    /// starting work. Nothing had happened but a change of keyboard
    /// focus.
    #[test]
    fn a_focus_report_is_not_the_agent_working() {
        let (socket_path, _dir) = start_test_server();
        let id = create_session_with(&socket_path, REPAINTS_ON_FOCUS);

        let mut attached = attach_reader(&socket_path, &id);
        wait_for_status(&mut attached, &id, "working");
        wait_for_status(&mut attached, &id, "idle");

        let mut commands = Stream::connect(&socket_path).unwrap();
        // Exactly what xterm sends when its textarea loses focus.
        request(
            &mut commands,
            &Request::WriteInput { id: id.clone(), data: "\u{1b}[O".to_string() },
        );

        let (statuses, repainted) = collect_after(&mut attached, &id, Duration::from_millis(1500));
        assert!(repainted, "the session never repainted, so this proves nothing about focus");
        assert!(
            statuses.is_empty(),
            "a focus report the terminal sent about itself was reported as the agent working: {statuses:?}"
        );
    }

    /// The other half of the same rule: a focus report is not the human
    /// taking the tab over, so it must not dismiss the ↻ badge that says
    /// this session came back as a bare shell. Only typing does that.
    #[test]
    fn a_focus_report_does_not_dismiss_the_restored_badge() {
        let dir = tempfile::tempdir().unwrap();
        leftover_row(
            &dir.path().join("registry.sqlite"),
            "shell-1",
            "/tmp",
            None,
            SessionStatus::Idle,
        );
        let manager = recovered_manager(&dir);
        assert!(manager.list_sessions().unwrap()[0].restored, "precondition: the row is restored");

        manager.write_input("shell-1", b"\x1b[O").unwrap();
        assert!(
            manager.list_sessions().unwrap()[0].restored,
            "a focus report dismissed the restored badge -- nobody typed anything"
        );

        manager.write_input("shell-1", b"x").unwrap();
        assert!(
            !manager.list_sessions().unwrap()[0].restored,
            "typing must still dismiss it"
        );
    }

    /// The persisted status, read back the way any other client would.
    fn manager_status(socket_path: &std::path::Path, id: &str) -> String {
        let mut stream = Stream::connect(socket_path).unwrap();
        match request(&mut stream, &Request::ListSessions) {
            Response::SessionList { sessions } => sessions
                .into_iter()
                .find(|s| s.id == id)
                .map(|s| s.status)
                .unwrap_or_else(|| panic!("session {id} is gone")),
            other => panic!("expected SessionList, got {other:?}"),
        }
    }

    fn session_record(command: Option<&str>, interrupted: bool) -> SessionRecord {
        SessionRecord {
            id: "s1".to_string(),
            workspace_path: "/tmp/ws".to_string(),
            cwd: "/tmp".to_string(),
            command: command.map(|c| c.to_string()),
            status: SessionStatus::Idle,
            restored: false,
            generation: 0,
            interrupted,
            process: None,
            orphan: None,
            failure_reason: None,
        }
    }

    #[test]
    fn the_heuristic_speaks_only_for_a_session_gavin_launched_something_in() {
        assert!(heuristic_speaks_for(&session_record(Some("claude --model opus"), false)));
        // The tab a human opened to type in.
        assert!(!heuristic_speaks_for(&session_record(None, false)));
        // An agent row `recover` put a bare shell into: the command
        // column still names the agent, but the agent is not there.
        assert!(!heuristic_speaks_for(&session_record(Some("claude --model opus"), true)));
    }

    /// The heuristic's premise is that an agent produces output while it
    /// works. A plain terminal has no agent in it: every byte it emits is
    /// the shell painting a prompt or echoing what the human just typed,
    /// and calling that "working" put a spinner on a tab where nothing
    /// was happening -- the same lie
    /// `recover_resets_an_interrupted_rows_status_so_a_bare_shell_never_reads_as_working`
    /// already had to stamp out on the recovery path.
    ///
    /// Asserts the absence of a status rather than the presence of one,
    /// because the correct answer here is that the daemon says nothing:
    /// the session is created `idle` and stays there until something
    /// explicit -- an OSC 133 marker, a bell -- speaks for it.
    #[test]
    fn a_plain_terminal_never_reports_working_from_its_own_output() {
        let (socket_path, _dir) = start_test_server();

        let id = {
            let mut stream = Stream::connect(&socket_path).unwrap();
            // `None`: exactly what the app sends for a terminal tab the
            // human opened (backend.createSession with no command).
            let created = request(
                &mut stream,
                &Request::CreateSession {
                    workspace_path: "/tmp/ws".to_string(),
                    cwd: "/tmp".to_string(),
                    command: None,
                },
            );
            match created {
                Response::SessionCreated { id } => id,
                other => panic!("expected SessionCreated, got {other:?}"),
            }
        };

        let mut stream2 = Stream::connect(&socket_path).unwrap();
        write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();
        // Typed, not run: bare characters with no newline are echoed by
        // the shell's line editor without executing anything, so this
        // exercises the keystroke-echo path without depending on whether
        // the ambient $SHELL happens to emit OSC 133 around a command.
        write_message(
            &mut stream2,
            &Request::WriteInput { id: id.clone(), data: "echo not_run".to_string() },
        )
        .unwrap();

        // Well past HEURISTIC_QUIET_PERIOD, so a heuristic that fired at
        // all has had time to be seen -- and a read timeout so a quiet
        // session ends the loop at the deadline instead of blocking.
        stream2.set_read_timeout(Some(Duration::from_millis(250))).unwrap();
        let mut reader = line_reader(stream2.try_clone().unwrap());
        let deadline = std::time::Instant::now() + HEURISTIC_QUIET_PERIOD * 3;
        let mut statuses: Vec<String> = Vec::new();
        while std::time::Instant::now() < deadline {
            match read_message::<_, Response>(&mut reader) {
                Ok(Some(Response::StatusChanged { id: rid, status })) if rid == id => {
                    statuses.push(status);
                }
                Ok(_) => {}
                // A timeout tick -- keep waiting until the deadline.
                Err(_) => {}
            }
        }
        assert!(
            !statuses.iter().any(|s| s == "working"),
            "a plain terminal reported working with no agent in it, got: {statuses:?}"
        );
    }

    #[test]
    fn heuristic_permanently_stops_once_a_real_osc_133_marker_has_been_seen() {
        let (socket_path, _dir) = start_test_server();

        let id = {
            let mut stream = Stream::connect(&socket_path).unwrap();
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

        let mut stream2 = Stream::connect(&socket_path).unwrap();
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

        let mut reader = line_reader(stream2.try_clone().unwrap());
        let mut saw_working = false;
        let deadline = std::time::Instant::now() + PROCESS_BUDGET;
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
            let mut stream = Stream::connect(&socket_path).unwrap();
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

        let mut stream2 = Stream::connect(&socket_path).unwrap();
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

        let mut reader = line_reader(stream2.try_clone().unwrap());
        let deadline = std::time::Instant::now() + PROCESS_BUDGET;
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
            let mut stream = Stream::connect(&socket_path).unwrap();
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

        let mut stream2 = Stream::connect(&socket_path).unwrap();
        write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();
        write_message(
            &mut stream2,
            &Request::WriteInput {
                id: id.clone(),
                data: format!("printf '\\033]7;file://host{repo_path}\\007'\n"),
            },
        )
        .unwrap();

        let mut reader = line_reader(stream2.try_clone().unwrap());
        let deadline = std::time::Instant::now() + PROCESS_BUDGET;
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
            let mut stream = Stream::connect(&socket_path).unwrap();
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
            let mut stream = Stream::connect(&socket_path).unwrap();
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

        let wait_for_git_status = |stream: &mut Stream, expected_id: &str| {
            let mut reader = line_reader(stream.try_clone().unwrap());
            let deadline = std::time::Instant::now() + PROCESS_BUDGET;
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
            let mut stream = Stream::connect(&socket_path).unwrap();
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

        let mut stream2 = Stream::connect(&socket_path).unwrap();
        write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();
        // /tmp itself is essentially never a git repo -- no OSC7 report
        // needed, the session's own launch cwd already qualifies.
        write_message(&mut stream2, &Request::WriteInput { id: id.clone(), data: "echo no_repo_here\n".to_string() }).unwrap();

        let mut reader = line_reader(stream2.try_clone().unwrap());
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
            let mut stream = Stream::connect(&socket_path).unwrap();
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
            let mut stream1 = Stream::connect(&socket_path).unwrap();
            write_message(&mut stream1, &Request::Attach { id: id.clone() }).unwrap();
            let mut reader = line_reader(stream1.try_clone().unwrap());
            let deadline = std::time::Instant::now() + PROCESS_BUDGET;
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
        let mut stream2 = Stream::connect(&socket_path).unwrap();
        write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();
        let mut reader2 = line_reader(stream2.try_clone().unwrap());

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
                    process: None,
                    orphan: None,
                    failure_reason: None,
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
        // Through pty_reads_until, not a bare read loop: the deadline has
        // to bound the READ, not merely the gap between two of them.
        let collected = pty_reads_until(&manager, "leftover-1", |c| {
            c.matches("recovered_ok").count() > 1
        });
        assert!(collected.matches("recovered_ok").count() > 1, "got: {collected}");
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
        leftover_row_running(db_path, id, cwd, command, status, None)
    }

    /// `leftover_row`, plus the process handle the dead daemon would have
    /// recorded for it. `None` is a row written before v21 (or one whose
    /// child was gone before its pid could be read); `Some` is what
    /// recovery's orphan probe actually reads.
    fn leftover_row_running(
        db_path: &std::path::Path,
        id: &str,
        cwd: &str,
        command: Option<&str>,
        status: SessionStatus,
        process: Option<crate::proc::ProcessHandle>,
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
                process,
                orphan: None,
                failure_reason: None,
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

    /// Reads a session's PTY until `enough` is satisfied, and returns
    /// everything read; empty if the budget ran out first.
    ///
    /// The reading happens on a thread of its own because `reader_for`
    /// hands back a blocking `Read` with no timeout, so a deadline
    /// consulted BETWEEN reads bounds only a session that is talking --
    /// and misses the one case worth bounding, a session that never says
    /// anything at all. Handing the wait to `recv_timeout` bounds both.
    fn pty_reads_until(
        manager: &SessionManager,
        id: &str,
        enough: impl Fn(&str) -> bool + Send + 'static,
    ) -> String {
        let mut reader = manager.reader_for(id).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut collected = String::new();
            let mut buf = [0u8; 4096];
            loop {
                let Ok(n) = reader.read(&mut buf) else { break };
                if n == 0 {
                    break;
                }
                collected.push_str(&String::from_utf8_lossy(&buf[..n]));
                if enough(&collected) {
                    break;
                }
            }
            let _ = tx.send(collected);
        });
        rx.recv_timeout(PROCESS_BUDGET).unwrap_or_default()
    }

    /// Reads from a recovered session until `needle` shows up, or gives
    /// up. Proves there is a real interactive shell behind the id rather
    /// than merely a registry row.
    ///
    /// TWICE, because the tty echoes the typed line back before the
    /// shell has run it -- so one occurrence proves only that the PTY
    /// exists. The needle must therefore be a LITERAL the shell prints
    /// unchanged; a needle the shell expands (`$PWD`) can only ever
    /// appear once, in the echo.
    fn shell_echoes(manager: &SessionManager, id: &str, needle: &str) -> bool {
        manager.write_input(id, format!("echo {needle}\n").as_bytes()).unwrap();
        // The echo of the typed line carries the needle too, so what
        // proves a shell ran the command is the SECOND occurrence.
        let wanted = needle.to_string();
        pty_reads_until(manager, id, move |seen| seen.matches(&wanted).count() > 1)
            .matches(needle)
            .count()
            > 1
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
    fn recover_brings_a_plain_terminal_session_back_as_an_idle_bare_shell() {
        // The other half of the rule: a session with no command has no
        // run to have been interrupted, so it is never marked as such --
        // but it is still a fresh bare shell, so it comes back idle like
        // every other recovered session.
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
        assert_eq!(
            summary.status, "idle",
            "a shell at a prompt is idle, and nothing else will ever correct this row"
        );
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
            shell_echoes(&manager, "moved-1", "recovered_shell_ok"),
            "the recovered shell should answer at all"
        );
        manager.write_input("moved-1", b"case \"$PWD\" in *elsewhere) echo CWDMARK_yes;; *) echo CWDMARK_no;; esac\n").unwrap();
        let collected =
            pty_reads_until(&manager, "moved-1", |seen| seen.matches("CWDMARK_").count() >= 2);
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

    /// A process that behaves the way an orphan does: it ignores SIGHUP,
    /// so closing the PTY master its daemon held would not have killed
    /// it. Returned with its handle so a test can plant exactly what a
    /// dead daemon would have left in the registry.
    ///
    /// The `Child` comes back too and MUST be kept alive for the duration
    /// of the test: dropping it leaks the process, and this suite would
    /// then strew `sleep`s across the developer's machine.
    fn spawn_survivor() -> (std::process::Child, crate::proc::ProcessHandle) {
        let child = std::process::Command::new("/bin/sh")
            .args(["-c", "trap '' HUP; sleep 30"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let handle = crate::proc::identify(child.id()).expect("the survivor must be visible");
        (child, handle)
    }

    fn kill_and_reap(mut child: std::process::Child) {
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn recover_reports_a_process_that_outlived_its_daemon_instead_of_a_clean_interruption() {
        // The whole card. The daemon is gone and the session's PTY with
        // it, but the process it launched ignored the SIGHUP that death
        // sent and is still running in the checkout. Saying "interrupted"
        // and nothing else describes what gavin did, not what happened.
        let dir = tempfile::tempdir().unwrap();
        let (survivor, handle) = spawn_survivor();
        leftover_row_running(
            &dir.path().join("registry.sqlite"),
            "orphan-1",
            "/tmp",
            Some("claude --model opus"),
            SessionStatus::Working,
            Some(handle),
        );

        let manager = recovered_manager(&dir);

        let summary = &manager.list_sessions().unwrap()[0];
        assert_eq!(summary.interrupted, true, "the run was still interrupted");
        let orphan = summary.orphan.as_ref().expect("a surviving process must be reported");
        assert_eq!(orphan.pid, handle.pid);
        assert_eq!(
            orphan.command.as_deref(),
            Some("claude --model opus"),
            "the confirmation has to be able to name what it would kill"
        );
        kill_and_reap(survivor);
    }

    #[test]
    fn recover_reports_no_orphan_when_the_process_really_did_die() {
        // The common path, and the one that must not get noisier: almost
        // every agent DOES die with its daemon (measured per profile --
        // claude, gemini and opencode all take the SIGHUP), so a
        // recovery that cried orphan here would be worse than useless.
        let dir = tempfile::tempdir().unwrap();
        let (survivor, handle) = spawn_survivor();
        kill_and_reap(survivor);
        leftover_row_running(
            &dir.path().join("registry.sqlite"),
            "gone-1",
            "/tmp",
            Some("claude"),
            SessionStatus::Working,
            Some(handle),
        );

        let manager = recovered_manager(&dir);

        let summary = &manager.list_sessions().unwrap()[0];
        assert_eq!(summary.interrupted, true);
        assert!(summary.orphan.is_none(), "a dead pid is not an orphan");
    }

    #[test]
    fn recover_never_calls_a_recycled_pid_an_orphan() {
        // The destructive mistake this must not make. The pid is alive --
        // it is this test binary -- but it is not the process that was
        // recorded, and reporting it would put a stranger's process
        // behind a button labelled "end this agent".
        let dir = tempfile::tempdir().unwrap();
        let mut mine = crate::proc::identify(std::process::id()).unwrap();
        mine.started_at_us -= 1;
        leftover_row_running(
            &dir.path().join("registry.sqlite"),
            "recycled-1",
            "/tmp",
            Some("claude"),
            SessionStatus::Working,
            Some(mine),
        );

        let manager = recovered_manager(&dir);

        assert!(
            manager.list_sessions().unwrap()[0].orphan.is_none(),
            "a pid whose identity does not match is gone, the safe direction"
        );
    }

    #[test]
    fn recover_reports_no_orphan_for_a_row_that_never_recorded_a_process() {
        // Every row written before v22. It cannot be probed, and
        // "unknown" has to read as gone -- inventing liveness for it
        // would be the same over-claiming this change exists to undo.
        let dir = tempfile::tempdir().unwrap();
        leftover_row(
            &dir.path().join("registry.sqlite"),
            "legacy-1",
            "/tmp",
            Some("claude"),
            SessionStatus::Working,
        );

        let manager = recovered_manager(&dir);

        assert!(manager.list_sessions().unwrap()[0].orphan.is_none());
    }

    #[test]
    fn recover_keeps_reporting_an_orphan_across_a_second_daemon_restart() {
        // The row's own `process` is the bare shell the FIRST recovery
        // spawned, and shells die with their daemon -- so a probe that
        // only looked there would drop the survivor on restart number
        // two, while it kept running. The human restarting twice is not
        // a reason to stop telling them.
        let dir = tempfile::tempdir().unwrap();
        let (survivor, handle) = spawn_survivor();
        leftover_row_running(
            &dir.path().join("registry.sqlite"),
            "orphan-2",
            "/tmp",
            Some("claude"),
            SessionStatus::Working,
            Some(handle),
        );

        let first = recovered_manager(&dir);
        assert!(first.list_sessions().unwrap()[0].orphan.is_some());
        drop(first);

        let second = recovered_manager(&dir);

        let summary = &second.list_sessions().unwrap()[0];
        let orphan = summary.orphan.as_ref().expect("the survivor is still running");
        assert_eq!(orphan.pid, handle.pid);
        kill_and_reap(survivor);
    }

    #[test]
    fn recover_stops_reporting_an_orphan_once_it_has_exited_on_its_own() {
        // An orphan that finished its turn and quit is not something to
        // keep offering to kill. Recovery re-probes what it recorded
        // earlier, which is the only thing that ever clears it besides
        // the human.
        let dir = tempfile::tempdir().unwrap();
        let (survivor, handle) = spawn_survivor();
        leftover_row_running(
            &dir.path().join("registry.sqlite"),
            "orphan-3",
            "/tmp",
            Some("claude"),
            SessionStatus::Working,
            Some(handle),
        );
        let first = recovered_manager(&dir);
        assert!(first.list_sessions().unwrap()[0].orphan.is_some());
        drop(first);
        kill_and_reap(survivor);

        let second = recovered_manager(&dir);

        assert!(
            second.list_sessions().unwrap()[0].orphan.is_none(),
            "the recorded orphan exited, so there is nothing left to report"
        );
    }

    #[test]
    fn recover_records_the_bare_shell_it_spawned_not_the_process_it_replaced() {
        // Otherwise the next recovery would probe a pid this one already
        // reported -- and once that number was recycled, probe a
        // stranger. The orphan lives in its own column so this overwrite
        // cannot lose it.
        let dir = tempfile::tempdir().unwrap();
        let (survivor, handle) = spawn_survivor();
        leftover_row_running(
            &dir.path().join("registry.sqlite"),
            "orphan-4",
            "/tmp",
            Some("claude"),
            SessionStatus::Working,
            Some(handle),
        );

        let manager = recovered_manager(&dir);

        let record = manager.registry.lock().unwrap().get("orphan-4").unwrap().unwrap();
        let shell = record.process.expect("the recovered shell must be recorded");
        assert_ne!(shell.pid, handle.pid, "the row must name the shell, not the orphan");
        assert!(crate::proc::still_running(shell), "and that shell must really be running");
        assert_eq!(record.orphan.map(|o| o.pid), Some(handle.pid));
        kill_and_reap(survivor);
    }

    #[test]
    fn end_orphan_kills_the_recorded_process_and_stops_reporting_it() {
        let dir = tempfile::tempdir().unwrap();
        let (survivor, handle) = spawn_survivor();
        leftover_row_running(
            &dir.path().join("registry.sqlite"),
            "orphan-5",
            "/tmp",
            Some("claude"),
            SessionStatus::Working,
            Some(handle),
        );
        let manager = recovered_manager(&dir);

        let resp = manager.end_orphan("orphan-5").unwrap();

        match resp {
            Response::OrphanEnded { ended, still_running, .. } => {
                assert!(ended, "the survivor takes SIGTERM even though it ignored SIGHUP");
                assert!(!still_running);
            }
            other => panic!("expected OrphanEnded, got {other:?}"),
        }
        assert!(!crate::proc::still_running(handle), "the process is actually gone");
        assert!(
            manager.list_sessions().unwrap()[0].orphan.is_none(),
            "and it stops being reported"
        );
        kill_and_reap(survivor);
    }

    #[test]
    fn end_orphan_reaps_the_sessions_queued_follow_ups_once_the_process_is_gone() {
        // R7: a follow-up queued before the daemon restart is typed for a
        // conversation that ending the orphan confirms is over. It must
        // not keep sitting on disk under an id nothing will ever deliver
        // it to.
        let dir = tempfile::tempdir().unwrap();
        let (survivor, handle) = spawn_survivor();
        leftover_row_running(
            &dir.path().join("registry.sqlite"),
            "orphan-7",
            "/tmp",
            Some("claude"),
            SessionStatus::Working,
            Some(handle),
        );
        let manager = recovered_manager(&dir);
        manager.registry.lock().unwrap().queue_input("orphan-7", "pasted while busy").unwrap();

        manager.end_orphan("orphan-7").unwrap();

        assert!(
            manager.registry.lock().unwrap().queued_inputs_for("orphan-7").unwrap().is_empty(),
            "the queue must not outlive the conversation it was typed for"
        );
        kill_and_reap(survivor);
    }

    #[test]
    fn end_orphan_is_a_harmless_no_op_when_there_is_nothing_recorded() {
        // Two presses of the same button, or a press after the orphan
        // exited by itself. Neither is an error: an error here would
        // read as "something went wrong" when nothing did.
        let dir = tempfile::tempdir().unwrap();
        leftover_row(
            &dir.path().join("registry.sqlite"),
            "plain-1",
            "/tmp",
            Some("claude"),
            SessionStatus::Working,
        );
        let manager = recovered_manager(&dir);

        match manager.end_orphan("plain-1").unwrap() {
            Response::OrphanEnded { ended, still_running, .. } => {
                assert!(!ended);
                assert!(!still_running, "nothing recorded is not the same as something refusing");
            }
            other => panic!("expected OrphanEnded, got {other:?}"),
        }
    }

    #[test]
    fn session_processes_measures_a_live_session_and_names_its_command() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        let id = manager
            .create_session("/tmp", "/tmp", Some("/bin/sleep 30"))
            .unwrap();

        let sample = manager.session_processes().unwrap();
        let row = sample.iter().find(|p| p.session_id == id).expect("the session must be sampled");
        assert_eq!(row.command.as_deref(), Some("/bin/sleep 30"));
        assert!(row.pid.is_some(), "a live session reports the pid it was verified at");
        assert!(row.process_count >= 1, "at least the process in the PTY");
        assert!(row.rss_bytes > 0, "a live process occupies memory");
        assert!(row.sampled_at_us > 0, "a rate needs an instant to divide by");

        manager.kill_session(&id).unwrap();
    }

    #[test]
    fn session_processes_keeps_a_row_it_could_not_measure() {
        // The reason `process_count` exists. A row the daemon cannot
        // measure -- no recorded pid, or a process that has gone -- has
        // to stay in the list: the whole point of the task manager is to
        // account for sessions nobody can see, and dropping the
        // unmeasurable ones would hide exactly those.
        let dir = tempfile::tempdir().unwrap();
        leftover_row(
            &dir.path().join("registry.sqlite"),
            "no-pid",
            "/tmp",
            Some("claude"),
            SessionStatus::Working,
        );
        let manager = test_manager(&dir);

        let sample = manager.session_processes().unwrap();
        let row = sample.iter().find(|p| p.session_id == "no-pid").expect("the row must still be listed");
        assert_eq!(row.pid, None);
        assert_eq!(row.process_count, 0);
        assert_eq!(row.rss_bytes, 0);
        assert_eq!(row.cpu_time_us, 0);
        assert_eq!(row.command.as_deref(), Some("claude"));
    }

    #[test]
    fn session_processes_withholds_a_pid_whose_identity_no_longer_matches() {
        // A recycled pid is live, so reporting the number would put a
        // stranger's process in a row that carries a kill button. The
        // identity check is what decides, not the liveness of the number.
        let dir = tempfile::tempdir().unwrap();
        let live = crate::proc::identify(std::process::id()).unwrap();
        leftover_row_running(
            &dir.path().join("registry.sqlite"),
            "recycled",
            "/tmp",
            Some("claude"),
            SessionStatus::Working,
            Some(crate::proc::ProcessHandle { started_at_us: live.started_at_us + 1, ..live }),
        );
        let manager = test_manager(&dir);

        let row = manager
            .session_processes()
            .unwrap()
            .into_iter()
            .find(|p| p.session_id == "recycled")
            .unwrap();
        assert_eq!(row.pid, None, "the stored pid is live, but it is not this session's process");
        assert_eq!(row.process_count, 0);
    }

    #[test]
    fn session_processes_stamps_every_row_with_one_instant() {
        // Two polls become a rate by subtracting these, so a per-row
        // timestamp would give each session a different interval --
        // however long the walk happened to take between them.
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        let a = manager.create_session("/tmp", "/tmp", Some("/bin/sleep 30")).unwrap();
        let b = manager.create_session("/tmp", "/tmp", Some("/bin/sleep 30")).unwrap();

        let sample = manager.session_processes().unwrap();
        let stamps: std::collections::HashSet<i64> = sample.iter().map(|p| p.sampled_at_us).collect();
        assert_eq!(stamps.len(), 1, "one sample, one instant");

        manager.kill_session(&a).unwrap();
        manager.kill_session(&b).unwrap();
    }

    #[test]
    fn session_processes_is_dispatched_to_a_session_process_list() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        let id = manager.create_session("/tmp", "/tmp", None).unwrap();

        match handle_request(&manager, Request::SessionProcesses) {
            Response::SessionProcessList { processes } => {
                assert!(processes.iter().any(|p| p.session_id == id));
            }
            other => panic!("expected SessionProcessList, got {other:?}"),
        }
        manager.kill_session(&id).unwrap();
    }

    #[test]
    fn end_orphan_refuses_a_session_the_daemon_never_issued() {
        // The request names a session, never a pid, so this is the only
        // shape a caller could use to aim it somewhere unexpected.
        let dir = tempfile::tempdir().unwrap();
        let manager = recovered_manager(&dir);
        assert!(manager.end_orphan("no-such-session").is_err());
    }

    #[test]
    fn attach_announces_an_orphan_alongside_the_interrupted_marker() {
        // Alongside, never instead: the run WAS interrupted, and this
        // adds what the probe went and measured. Both ride Attach, so a
        // frontend reload gets them again.
        let dir = tempfile::tempdir().unwrap();
        let (survivor, handle) = spawn_survivor();
        leftover_row_running(
            &dir.path().join("registry.sqlite"),
            "orphan-6",
            "/tmp",
            Some("claude"),
            SessionStatus::Working,
            Some(handle),
        );
        let manager = Arc::new(recovered_manager(&dir));

        let (mut client, server) = Stream::pair().unwrap();
        manager.attach("orphan-6", Arc::new(Mutex::new(server)));

        let mut reader = line_reader(&mut client);
        let mut saw_interrupted = false;
        let mut saw_orphan = None;
        for _ in 0..6 {
            let next: Result<Option<Response>, _> = read_message(&mut reader);
            match next {
                Ok(Some(Response::SessionInterrupted { .. })) => saw_interrupted = true,
                Ok(Some(Response::SessionOrphaned { orphan, .. })) => {
                    saw_orphan = Some(orphan);
                    break;
                }
                Ok(Some(_)) => continue,
                Ok(None) | Err(_) => break,
            }
        }
        assert!(saw_interrupted, "the interrupted marker must still be sent");
        let orphan = saw_orphan.expect("a surviving process must announce itself on Attach");
        assert_eq!(orphan.pid, handle.pid);
        kill_and_reap(survivor);
    }

    #[test]
    fn attach_never_calls_an_ordinary_interrupted_session_orphaned() {
        // The common case. Its process really did die, and an orphan
        // push here would put a kill button over nothing.
        let dir = tempfile::tempdir().unwrap();
        leftover_row(
            &dir.path().join("registry.sqlite"),
            "plain-2",
            "/tmp",
            Some("claude"),
            SessionStatus::Working,
        );
        let manager = Arc::new(recovered_manager(&dir));

        let (mut client, server) = Stream::pair().unwrap();
        manager.attach("plain-2", Arc::new(Mutex::new(server)));

        let mut reader = line_reader(&mut client);
        for _ in 0..5 {
            let next: Result<Option<Response>, _> = read_message(&mut reader);
            match next {
                Ok(Some(Response::SessionOrphaned { .. })) => {
                    panic!("an interrupted session whose process died must not report an orphan")
                }
                Ok(Some(_)) => continue,
                Ok(None) | Err(_) => break,
            }
        }
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

        let (client, server_side) = Stream::pair().unwrap();
        client.set_read_timeout(Some(Duration::from_millis(500))).unwrap();
        manager.attach("agent-3", Arc::new(Mutex::new(server_side)));

        let mut reader = line_reader(client);
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

        let (client, server_side) = Stream::pair().unwrap();
        client.set_read_timeout(Some(Duration::from_millis(500))).unwrap();
        manager.attach("shell-2", Arc::new(Mutex::new(server_side)));

        let mut reader = line_reader(client);
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
        let (client, server_side) = Stream::pair().unwrap();
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

        let mut reader = line_reader(client);
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
            let mut stream = Stream::connect(&socket_path).unwrap();
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

        let mut stream2 = Stream::connect(&socket_path).unwrap();
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
        let mut reader = line_reader(stream2.try_clone().unwrap());
        let deadline = std::time::Instant::now() + PROCESS_BUDGET;
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

        let deadline = std::time::Instant::now() + PROCESS_BUDGET;
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
        let (client, server_side) = Stream::pair().unwrap();
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
        let deadline = Instant::now() + PROCESS_BUDGET;
        while Instant::now() < deadline && !painted(&id) {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            painted(&id),
            "precondition: the pump should have painted this session's output onto its screen"
        );

        manager.kill_session(&id).unwrap();

        // The pump notices the closed pty and tears down asynchronously.
        let deadline = Instant::now() + PROCESS_BUDGET;
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
    fn kill_session_reaps_its_queued_follow_ups() {
        // R7: the RPC path, not just `Registry::remove` underneath it --
        // a follow-up queued for a session must not survive the request
        // that ends that session.
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        let id = manager.create_session("/tmp", "/tmp", None).unwrap();
        manager.registry.lock().unwrap().queue_input(&id, "pasted secret").unwrap();

        manager.kill_session(&id).unwrap();

        assert!(manager.registry.lock().unwrap().queued_inputs().unwrap().is_empty());
    }

    #[test]
    fn kill_session_answers_without_waiting_for_the_process_to_go() {
        // The UI hang this exists to prevent. The app's `kill_session`
        // is a synchronous Tauri command, so it runs on the thread that
        // draws the window, and every close that ends more than one
        // session -- a task-manager batch, archiving a card with live
        // agents, closing a page or a workspace -- issues one per
        // session, one after another. Whatever this reply waits for is
        // a frozen window, multiplied by the tab count.
        //
        // The command ignores SIGHUP, which is what makes the wait
        // measurable: portable-pty's `Child::kill` gives the process
        // five `try_wait` attempts 50ms apart before escalating to
        // SIGKILL, and dropping the session pays that loop again. This
        // request used to take ~250ms for a session like this one (and
        // ~55ms for an ordinary shell); the bound below is far enough
        // under that to fail if the wait ever comes back, and far
        // enough over the ~1ms it costs now to survive a loaded
        // machine.
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        let id = manager
            .create_session("/tmp", "/tmp", Some("trap '' HUP; sleep 30"))
            .unwrap();
        let process = manager.registry.lock().unwrap().list().unwrap()[0]
            .process
            .expect("a session just spawned records the process it is holding");

        // Wait for the shell to reach `sleep`, which is the only proof
        // that it has already run `trap`. Killed any earlier it dies on
        // the hangup like any other shell, and the test would be timing
        // the fast path it is not about -- which is exactly what it did
        // before this wait existed.
        let ignoring_hangup = |manager: &SessionManager| {
            manager
                .session_processes()
                .unwrap()
                .iter()
                .any(|p| p.session_id == id && p.process_count >= 2)
        };
        let deadline = Instant::now() + PROCESS_BUDGET;
        while Instant::now() < deadline && !ignoring_hangup(&manager) {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            ignoring_hangup(&manager),
            "precondition: the session's shell never got as far as `sleep`, so it has not \
             installed the SIGHUP trap this test needs it to ignore the hangup with"
        );

        let started = Instant::now();
        manager.kill_session(&id).unwrap();
        let waited = started.elapsed();

        assert!(
            waited < Duration::from_millis(200),
            "kill_session waited {waited:?} for the process to die -- the grace period \
             belongs on the reaper thread, not on the reply the app's UI blocks on"
        );

        // And the escalation still happens: a process that ignored the
        // hangup is SIGKILLed once the grace period passes, so ending a
        // session asynchronously must not mean ending it never.
        let deadline = Instant::now() + PROCESS_BUDGET;
        while Instant::now() < deadline && crate::proc::still_running(process) {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            !crate::proc::still_running(process),
            "the retired session's process is still running: the reaper never escalated \
             to SIGKILL, so the session was answered for but never actually ended"
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
            let mut stream = Stream::connect(&socket_path).unwrap();
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
            let stream = Stream::connect(&socket_path).unwrap();
            write_message(&mut &stream, &Request::Attach { id: id.to_string() }).unwrap();
            stream
        };
        let report_cwd = |stream: &Stream, id: &str, path: &str| {
            write_message(
                &mut &*stream,
                &Request::WriteInput {
                    id: id.to_string(),
                    data: format!("printf '\\033]7;file://host{path}\\007'\n"),
                },
            )
            .unwrap();
        };
        let wait_for_status_in = |reader: &mut BufReader<Stream>, id: &str, root: &std::path::Path| {
            let want = std::fs::canonicalize(root).unwrap();
            let deadline = std::time::Instant::now() + PROCESS_BUDGET;
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
        let mut reader_b = line_reader(stream_b.try_clone().unwrap());
        wait_for_status_in(&mut reader_b, &id_b, repo_b.path());

        // Session A starts out in repo A...
        let id_a = make_session(&plain_path);
        let stream_a = attach(&id_a);
        report_cwd(&stream_a, &id_a, &repo_a_path);
        let mut reader_a = line_reader(stream_a.try_clone().unwrap());
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
                    process: None,
                    orphan: None,
                    failure_reason: None,
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

        let (client, server_side) = Stream::pair().unwrap();
        // Set before attach, not after: the pump's error arm drops the
        // far end of this pair, and on macOS SO_RCVTIMEO on a socketpair
        // whose peer has already been dropped fails with EINVAL.
        client.set_read_timeout(Some(Duration::from_millis(500))).unwrap();
        manager.attach("failed-spawn-1", Arc::new(Mutex::new(server_side)));

        // The pump thread's error arm runs asynchronously, so poll for it.
        let deadline = std::time::Instant::now() + PROCESS_BUDGET;
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
        let mut reader = line_reader(client);
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

    /// unix only, because the SUBJECT is: the failure being provoked is
    /// a spawn into a directory the process may not enter, and `chmod
    /// 000` is how that is arranged. Windows has no mode to remove --
    /// the equivalent is a deny ACE, which is a different setup for the
    /// same assertion and not one worth carrying to prove a
    /// platform-independent code path.
    #[cfg(unix)]
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
                    process: None,
                    orphan: None,
                    failure_reason: None,
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
                    process: None,
                    orphan: None,
                    failure_reason: None,
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
                    process: None,
                    orphan: None,
                    failure_reason: None,
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

        let (client, server_side) = Stream::pair().unwrap();
        // Set before attach, not after: the pump's error arm drops the far
        // end of this pair, and on macOS SO_RCVTIMEO on a socketpair whose
        // peer has already been dropped fails with EINVAL.
        client.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        manager.attach("no-live-pty-1", Arc::new(Mutex::new(server_side)));

        let mut reader = line_reader(client);
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
        let deadline = std::time::Instant::now() + PROCESS_BUDGET;
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
                    process: None,
                    orphan: None,
                    failure_reason: None,
                })
                .unwrap();
        }
        let manager = Arc::new(SessionManager::new(
            Registry::open(&db_path).unwrap(),
            KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap(),
            test_orchestration_store(),
        ));

        let (client, server_side) = Stream::pair().unwrap();
        client.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        manager.attach("restored-1", Arc::new(Mutex::new(server_side)));

        let mut reader = line_reader(client);
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
                    process: None,
                    orphan: None,
                    failure_reason: None,
                })
                .unwrap();
        }
        let manager = Arc::new(SessionManager::new(
            Registry::open(&db_path).unwrap(),
            KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap(),
            test_orchestration_store(),
        ));

        let (client, server_side) = Stream::pair().unwrap();
        client.set_read_timeout(Some(Duration::from_millis(500))).unwrap();
        manager.attach("not-restored-1", Arc::new(Mutex::new(server_side)));

        let mut reader = line_reader(client);
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
                    process: None,
                    orphan: None,
                    failure_reason: None,
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

    // ---- the follow-up queue (v26) ----

    /// A registry row with no PTY behind it. Enough for every property
    /// of the queue that is decided BEFORE anything is written to a
    /// terminal -- which is all of the refusals, and they are the half
    /// that has to be right.
    fn queue_test_record(id: &str, status: SessionStatus, interrupted: bool) -> SessionRecord {
        SessionRecord {
            id: id.to_string(),
            workspace_path: "/tmp/ws".to_string(),
            cwd: "/tmp/ws".to_string(),
            command: Some("claude".to_string()),
            status,
            restored: false,
            generation: 0,
            interrupted,
            process: None,
            orphan: None,
            failure_reason: None,
        }
    }

    fn queued_texts(manager: &SessionManager, id: &str) -> Vec<String> {
        manager
            .registry
            .lock()
            .unwrap()
            .queued_inputs_for(id)
            .unwrap()
            .into_iter()
            .map(|q| q.text)
            .collect()
    }

    #[test]
    fn queueing_a_follow_up_for_a_session_that_does_not_exist_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);

        // Not stored-and-ignored: a queue for a session nobody hosts can
        // never be drained, so the row would sit in every listing
        // forever with no way to deliver or explain it.
        assert!(manager.queue_input("nope", "hello").is_err());
        assert!(manager.registry.lock().unwrap().queued_inputs().unwrap().is_empty());
    }

    #[test]
    fn a_whitespace_only_follow_up_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        manager
            .registry
            .lock()
            .unwrap()
            .insert(&queue_test_record("s1", SessionStatus::Working, false))
            .unwrap();

        // It would deliver as a bare carriage return: an empty turn,
        // which costs the agent a round trip and says nothing.
        assert!(manager.queue_input("s1", "   \n  ").is_err());
        assert!(queued_texts(&manager, "s1").is_empty());
    }

    #[test]
    fn a_busy_session_keeps_its_follow_up_queued_instead_of_being_typed_over() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        manager
            .registry
            .lock()
            .unwrap()
            .insert(&queue_test_record("s1", SessionStatus::Working, false))
            .unwrap();

        manager.queue_input("s1", "and then run the tests").unwrap();

        // The whole point of the feature: mid-turn, the message waits.
        assert_eq!(queued_texts(&manager, "s1"), ["and then run the tests"]);
    }

    #[test]
    fn an_agent_waiting_on_the_human_is_not_answered_with_an_unrelated_follow_up() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        manager
            .registry
            .lock()
            .unwrap()
            .insert(&queue_test_record("s1", SessionStatus::WaitingForInput, false))
            .unwrap();

        manager.queue_input("s1", "carry on").unwrap();

        // `waiting_for_input` means the agent asked a QUESTION. Handing
        // it the human's next instruction would submit that instruction
        // as the answer to something else entirely.
        assert_eq!(queued_texts(&manager, "s1"), ["carry on"]);
    }

    #[test]
    fn a_failed_agent_is_not_handed_a_follow_up() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        manager
            .registry
            .lock()
            .unwrap()
            .insert(&queue_test_record("s1", SessionStatus::Failed, false))
            .unwrap();

        manager.queue_input("s1", "carry on").unwrap();

        // A failure is a verdict on a turn that BROKE. There is no
        // finished turn to follow up on, and a message sent into a dead
        // API connection is a message spent.
        assert_eq!(queued_texts(&manager, "s1"), ["carry on"]);
    }

    #[test]
    fn an_interrupted_session_refuses_delivery_because_its_shell_would_run_the_message() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        manager
            .registry
            .lock()
            .unwrap()
            .insert(&queue_test_record("s1", SessionStatus::Idle, true))
            .unwrap();

        let refusal = queue_delivery_refusal(&manager, "s1").expect("an interrupted session refuses");

        // The specific hazard, asserted specifically rather than via the
        // "not running" clause that also happens to be true here: after
        // a daemon restart the tab holds a bare shell, and the human is
        // not watching -- that is why they queued.
        assert!(
            refusal.contains("plain shell"),
            "the refusal must name the shell hazard, got {refusal:?}"
        );
    }

    #[test]
    fn the_send_now_override_still_refuses_an_interrupted_session() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        manager
            .registry
            .lock()
            .unwrap()
            .insert(&queue_test_record("s1", SessionStatus::Working, false))
            .unwrap();
        let queued = manager.registry.lock().unwrap().queue_input("s1", "carry on").unwrap();
        manager.registry.lock().unwrap().mark_interrupted("s1").unwrap();

        assert!(manager.send_queued_input("s1", &queued.id).is_err());
        // Held, not consumed: the human can relaunch and send it then.
        assert_eq!(queued_texts(&manager, "s1"), ["carry on"]);
    }

    #[test]
    fn sending_a_follow_up_that_is_no_longer_queued_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        manager
            .registry
            .lock()
            .unwrap()
            .insert(&queue_test_record("s1", SessionStatus::Working, false))
            .unwrap();

        // Silence would be the wrong answer in both directions: the
        // human pressed a button, and either it sent something or it did
        // not.
        assert!(manager.send_queued_input("s1", "never-existed").is_err());
    }

    #[test]
    fn setting_the_queue_answers_with_the_list_that_survived() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        manager
            .registry
            .lock()
            .unwrap()
            .insert(&queue_test_record("s1", SessionStatus::Working, false))
            .unwrap();
        manager.queue_input("s1", "a").unwrap();
        manager.queue_input("s1", "b").unwrap();
        let ids: Vec<String> = manager
            .registry
            .lock()
            .unwrap()
            .queued_inputs_for("s1")
            .unwrap()
            .into_iter()
            .map(|q| q.id)
            .collect();

        // The reply carries the result, so a caller never has to wait
        // for the push to learn what its own write did.
        match manager.set_queued_inputs("s1", &[ids[1].clone()]).unwrap() {
            Response::QueuedInputs { queued } => {
                assert_eq!(queued.len(), 1);
                assert_eq!(queued[0].text, "b");
            }
            other => panic!("expected QueuedInputs, got {other:?}"),
        }
    }

    #[test]
    fn list_queued_inputs_answers_for_every_session_at_once() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        for id in ["s1", "s2"] {
            manager
                .registry
                .lock()
                .unwrap()
                .insert(&queue_test_record(id, SessionStatus::Working, false))
                .unwrap();
            manager.queue_input(id, "hold on").unwrap();
        }

        // The read-back a reloaded frontend depends on: it has attached
        // to nothing, so it has missed every push the daemon sent.
        match manager.list_queued_inputs().unwrap() {
            Response::QueuedInputs { queued } => assert_eq!(queued.len(), 2),
            other => panic!("expected QueuedInputs, got {other:?}"),
        }
    }

    #[test]
    fn a_queue_change_is_pushed_to_whoever_is_attached_to_that_session() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        manager
            .registry
            .lock()
            .unwrap()
            .insert(&queue_test_record("s1", SessionStatus::Working, false))
            .unwrap();

        // The writer is registered directly rather than through
        // `attach`, which would spawn a pump for a session that has no
        // PTY and tear the registration straight back down again.
        let (client, server_side) = Stream::pair().unwrap();
        client.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        manager
            .attached_writers
            .lock()
            .unwrap()
            .insert("s1".to_string(), Arc::new(Mutex::new(server_side)));

        manager.queue_input("s1", "hold on").unwrap();

        let mut reader = line_reader(client);
        match read_message::<_, Response>(&mut reader).unwrap().unwrap() {
            Response::QueuedInputsChanged { id, queued } => {
                assert_eq!(id, "s1");
                assert_eq!(queued.len(), 1, "the push carries the whole list, not a delta");
            }
            other => panic!("expected QueuedInputsChanged, got {other:?}"),
        }
    }

    #[test]
    fn attach_sends_the_follow_up_queue_baseline() {
        // The fifth push-fed map to need one. Without it a frontend
        // reload shows an empty queue for a session that has three
        // messages waiting -- the git-chip bug, one map along.
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("registry.sqlite");
        {
            let registry = Registry::open(&db_path).unwrap();
            registry
                .insert(&queue_test_record("queued-1", SessionStatus::Working, false))
                .unwrap();
            registry.queue_input("queued-1", "still waiting").unwrap();
        }
        let manager = Arc::new(SessionManager::new(
            Registry::open(&db_path).unwrap(),
            KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap(),
            test_orchestration_store(),
        ));

        let (client, server_side) = Stream::pair().unwrap();
        client.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        manager.attach("queued-1", Arc::new(Mutex::new(server_side)));

        let mut reader = line_reader(client);
        let mut seen = None;
        // The baseline rides among CwdChanged / StatusChanged / the
        // screen snapshot, so the assertion is on arrival, not position.
        for _ in 0..10 {
            match read_message::<_, Response>(&mut reader) {
                Ok(Some(Response::QueuedInputsChanged { id, queued })) => {
                    seen = Some((id, queued));
                    break;
                }
                Ok(Some(_)) => {}
                _ => break,
            }
        }
        let (id, queued) = seen.expect("Attach must re-send the follow-up queue");
        assert_eq!(id, "queued-1");
        assert_eq!(queued.len(), 1);
    }

    #[test]
    fn a_follow_up_queued_mid_turn_reaches_the_terminal_once_the_session_goes_idle() {
        // The end-to-end promise, through a real PTY: queued while the
        // session is producing output, delivered after it stops.
        //
        // The assertion is on the PTY's own echo of the delivered bytes
        // rather than on the marker being EXECUTED, and deliberately so:
        // delivery wraps the message in a bracketed paste, which a plain
        // `sh` has never enabled and therefore reads as literal
        // characters. The agents this feature is for do enable it (the
        // same envelope `pasteToMainAgent` already ships), and what this
        // test is here to prove is that the bytes arrive at the right
        // MOMENT.
        let (socket_path, _dir) = start_test_server();

        let id = {
            let mut stream = Stream::connect(&socket_path).unwrap();
            match request(
                &mut stream,
                &Request::CreateSession {
                    workspace_path: "/tmp/ws".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/bin/sh".to_string()),
                },
            ) {
                Response::SessionCreated { id } => id,
                other => panic!("expected SessionCreated, got {other:?}"),
            }
        };

        let mut streaming = Stream::connect(&socket_path).unwrap();
        write_message(&mut streaming, &Request::Attach { id: id.clone() }).unwrap();
        // Chatty for about two and a half seconds -- longer than one
        // HEURISTIC_QUIET_PERIOD, so the session is unambiguously
        // Working while the follow-up is queued, and unambiguously Idle
        // afterwards.
        write_message(
            &mut streaming,
            &Request::WriteInput {
                id: id.clone(),
                data: "i=0; while [ $i -lt 6 ]; do echo tick; sleep 0.4; i=$((i+1)); done\n"
                    .to_string(),
            },
        )
        .unwrap();

        streaming.set_read_timeout(Some(Duration::from_millis(250))).unwrap();
        let mut reader = line_reader(streaming.try_clone().unwrap());

        // Wait for the loop to actually be producing output before
        // queueing, so the request cannot land while the session is
        // still Idle and be delivered straight through -- which would
        // pass the marker assertion while proving nothing.
        let started = std::time::Instant::now() + PROCESS_BUDGET;
        let mut working = false;
        while std::time::Instant::now() < started && !working {
            if let Ok(Some(Response::StatusChanged { id: rid, status })) =
                read_message::<_, Response>(&mut reader)
            {
                working = rid == id && status == "working";
            }
        }
        assert!(working, "the shell never reported working");

        let mut queue_stream = Stream::connect(&socket_path).unwrap();
        match request(
            &mut queue_stream,
            &Request::QueueInput { id: id.clone(), text: "QUEUED_MARK_OK".to_string() },
        ) {
            Response::QueuedInputs { queued } => assert_eq!(
                queued.len(),
                1,
                "a follow-up for a busy session must WAIT, not go straight through"
            ),
            other => panic!("expected QueuedInputs, got {other:?}"),
        }

        let deadline = std::time::Instant::now() + PROCESS_BUDGET;
        let mut delivered = false;
        while std::time::Instant::now() < deadline && !delivered {
            if let Ok(Some(Response::Output { id: rid, data })) =
                read_message::<_, Response>(&mut reader)
            {
                delivered = rid == id && data.contains("QUEUED_MARK_OK");
            }
        }
        assert!(delivered, "the queued follow-up never reached the terminal");

        let mut check = Stream::connect(&socket_path).unwrap();
        match request(&mut check, &Request::ListQueuedInputs) {
            Response::QueuedInputs { queued } => assert!(
                queued.is_empty(),
                "a delivered follow-up leaves the queue, got {queued:?}"
            ),
            other => panic!("expected QueuedInputs, got {other:?}"),
        }
    }

    #[test]
    fn a_follow_up_for_an_idle_session_goes_straight_through() {
        // Queueing onto an agent that finished its turn a second ago and
        // sending to it are the same act. The wait exists only because
        // the agent is busy.
        let (socket_path, _dir) = start_test_server();

        let id = {
            let mut stream = Stream::connect(&socket_path).unwrap();
            match request(
                &mut stream,
                &Request::CreateSession {
                    workspace_path: "/tmp/ws".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/bin/sh".to_string()),
                },
            ) {
                Response::SessionCreated { id } => id,
                other => panic!("expected SessionCreated, got {other:?}"),
            }
        };

        let mut streaming = Stream::connect(&socket_path).unwrap();
        write_message(&mut streaming, &Request::Attach { id: id.clone() }).unwrap();
        streaming.set_read_timeout(Some(Duration::from_millis(250))).unwrap();
        let mut reader = line_reader(streaming.try_clone().unwrap());

        let mut queue_stream = Stream::connect(&socket_path).unwrap();
        match request(
            &mut queue_stream,
            &Request::QueueInput { id: id.clone(), text: "STRAIGHT_THROUGH_OK".to_string() },
        ) {
            Response::QueuedInputs { queued } => {
                assert!(queued.is_empty(), "an idle session takes it now, got {queued:?}")
            }
            other => panic!("expected QueuedInputs, got {other:?}"),
        }

        let deadline = std::time::Instant::now() + PROCESS_BUDGET;
        let mut delivered = false;
        while std::time::Instant::now() < deadline && !delivered {
            if let Ok(Some(Response::Output { id: rid, data })) =
                read_message::<_, Response>(&mut reader)
            {
                delivered = rid == id && data.contains("STRAIGHT_THROUGH_OK");
            }
        }
        assert!(delivered, "an idle session never received its follow-up");
    }
}
