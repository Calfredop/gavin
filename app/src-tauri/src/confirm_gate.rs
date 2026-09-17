//! A host-side confirmation the destructive commands require.
//!
//! Every "are you sure" in gavin is drawn in the webview (`dialog.ts` +
//! `ConfirmPrompt`, because the dialog plugin is deliberately narrowed
//! to `dialog:allow-open`). The command each one guards is a direct
//! `invoke`, so until now the confirmation was a CONVENTION every call
//! site repeated rather than a precondition anything enforced: a new
//! route to `delete_card_file` that forgot to ask would work perfectly,
//! and nothing in any suite would notice (AS-05/R5).
//!
//! This makes it a precondition. `open_confirmation` records that a
//! prompt is on screen; `answer_confirmation` mints a token when the
//! human said yes; the guarded command spends that token, and refuses
//! without one. The token is bound to the ACTION and to the exact
//! SUBJECTS the prompt named, is single use per subject, and expires --
//! so a confirmation for one card cannot delete another, and none can be
//! stockpiled.
//!
//! What this does NOT do, stated plainly because the security report
//! records it that way: it does not stop a script that already runs in
//! the page and knows gavin. Such a script can call `open_confirmation`,
//! call `answer_confirmation(true)` and spend the token, never drawing
//! anything -- the prompt is a frontend construct, and the host cannot
//! tell a drawn one from an asserted one. Closing that needs the
//! confirmation to be drawn by the host in a webview the page cannot
//! script; the commands would then require the same token and only the
//! minting authority would change. What is closed here is the whole
//! class of accidental bypass, plus the generic payload that walks
//! `__TAURI_INTERNALS__` invoking commands by name.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::State;

/// Every action a token gates, and the argument each one binds its
/// subject to.
///
/// The list is the contract `app/src/lib/commandGate.test.ts` checks
/// against `lib.rs`'s handler list: a new command that destroys
/// something has to be classified there before that suite passes, which
/// is what stops this set from quietly falling behind the app.
///
/// `kill_session` is DESTRUCTIVE AND DELIBERATELY NOT HERE. Three of its
/// callers have no human in the loop at all -- the app-quit sweep
/// (`appClose.ts`), the rollback after a failed multi-session spawn, and
/// killing an agent session whose workspace has gone -- and a workspace
/// with "Close confirm" off has none either. A gate it had to mint its
/// own way past for those would be decorative; leaving it out is the
/// honest record.
pub const GATED_ACTIONS: &[&str] = &[
    "delete_card_file",
    "install_update",
    "remove_gavin_footprint",
    "restart_daemon",
    "stop_daemon",
    "trash_entry",
];

/// `restart_daemon` takes no path: it destroys one thing, the daemon,
/// and there is only ever one of it. Its prompt names this subject so
/// the binding has the same shape as every other action's.
pub const DAEMON_SUBJECT: &str = "";

/// How long a prompt may stand unanswered before its record is dropped.
/// Generous: a human can leave a modal on screen over lunch, and the
/// cost of a stale record is a map entry.
const PROMPT_TTL: Duration = Duration::from_secs(30 * 60);

/// How long a minted token stays spendable. Short, because the gap it
/// covers is one `await` between the dialog resolving and the command
/// being sent -- the delete wizard's file half is the longest of them
/// and is still one call.
const GRANT_TTL: Duration = Duration::from_secs(120);

struct Prompt {
    action: String,
    subjects: HashSet<String>,
    opened: Instant,
}

struct Grant {
    action: String,
    /// The subjects still unspent. One prompt legitimately covers many
    /// (a plan card takes its nested tasks' files with it), so the grant
    /// is consumed subject by subject and dropped when the last one
    /// goes -- rather than on first use, which would break that loop.
    subjects: HashSet<String>,
    minted: Instant,
}

#[derive(Default)]
struct GateState {
    prompts: HashMap<u64, Prompt>,
    grants: HashMap<String, Grant>,
    next_id: u64,
}

#[derive(Default)]
pub struct ConfirmGate(Mutex<GateState>);

impl GateState {
    /// Drops what has aged out. Called on every entry point rather than
    /// on a timer: the maps only grow when somebody is answering
    /// prompts, so the moment there is something to collect is exactly
    /// the moment somebody is here.
    fn prune(&mut self, now: Instant) {
        self.prompts.retain(|_, p| now.duration_since(p.opened) < PROMPT_TTL);
        self.grants.retain(|_, g| now.duration_since(g.minted) < GRANT_TTL);
    }
}

fn random_token() -> String {
    // Unguessable, not secret: a page that can invoke can also mint one
    // legitimately, so the token proves a flow ran, not who ran it. It
    // still has to be unguessable, or the flow could be skipped outright
    // by naming a token nobody minted. Same source tauri uses for its
    // own CSP nonces.
    let hi = getrandom::u64().expect("no OS randomness for a confirmation token");
    let lo = getrandom::u64().expect("no OS randomness for a confirmation token");
    format!("{hi:016x}{lo:016x}")
}

/// Records that gavin is asking about `action` over `subjects`, and
/// returns the id the answer comes back with.
///
/// Refuses an action that nothing gates: a caller opening a prompt for
/// one is either a typo or an action somebody forgot to add to
/// `GATED_ACTIONS`, and both are better as an error than as a token
/// nothing will ever ask for.
#[tauri::command]
pub fn open_confirmation(
    action: String,
    subjects: Vec<String>,
    gate: State<ConfirmGate>,
) -> Result<u64, String> {
    if !GATED_ACTIONS.contains(&action.as_str()) {
        return Err(format!("{action} is not a confirmed action"));
    }
    let mut state = gate.0.lock().unwrap();
    state.prune(Instant::now());
    state.next_id += 1;
    let id = state.next_id;
    state.prompts.insert(
        id,
        Prompt { action, subjects: subjects.into_iter().collect(), opened: Instant::now() },
    );
    Ok(id)
}

/// Settles the prompt `prompt_id`. Answering yes mints the token its
/// command needs; answering no mints nothing and returns None, which is
/// also what an expired or already-answered prompt gets -- a caller that
/// has nothing to spend is in exactly the state a cancel leaves it in.
#[tauri::command]
pub fn answer_confirmation(
    prompt_id: u64,
    confirmed: bool,
    gate: State<ConfirmGate>,
) -> Result<Option<String>, String> {
    let now = Instant::now();
    let mut state = gate.0.lock().unwrap();
    state.prune(now);
    let Some(prompt) = state.prompts.remove(&prompt_id) else { return Ok(None) };
    if !confirmed {
        return Ok(None);
    }
    let token = random_token();
    state
        .grants
        .insert(token.clone(), Grant { action: prompt.action, subjects: prompt.subjects, minted: now });
    Ok(Some(token))
}

/// Spends `token` for one `subject` of `action`, or says why it cannot.
///
/// The message is a clause, not a sentence: every call site already
/// wraps a failure in its own "Couldn't delete X: ..." banner, and a
/// refusal has to read as a refusal there rather than as an unexplained
/// error.
pub fn spend(gate: &ConfirmGate, token: &str, action: &str, subject: &str) -> Result<(), String> {
    let now = Instant::now();
    let mut state = gate.0.lock().unwrap();
    state.prune(now);
    let Some(grant) = state.grants.get_mut(token) else {
        return Err("this needs a confirmation gavin drew, and the call carried none".to_string());
    };
    if grant.action != action {
        return Err("that confirmation was for a different action".to_string());
    }
    if !grant.subjects.remove(subject) {
        return Err("that confirmation named something else".to_string());
    }
    if grant.subjects.is_empty() {
        state.grants.remove(token);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gate() -> ConfirmGate {
        ConfirmGate::default()
    }

    /// The commands take `State<ConfirmGate>`, which a unit test has no
    /// way to build, so these drive the same bodies through the lock
    /// directly. `open_confirmation`/`answer_confirmation` are one-liners
    /// over this state; what is worth pinning is the spending rules.
    fn open(g: &ConfirmGate, action: &str, subjects: &[&str]) -> u64 {
        let mut state = g.0.lock().unwrap();
        state.next_id += 1;
        let id = state.next_id;
        state.prompts.insert(
            id,
            Prompt {
                action: action.to_string(),
                subjects: subjects.iter().map(|s| s.to_string()).collect(),
                opened: Instant::now(),
            },
        );
        id
    }

    fn answer(g: &ConfirmGate, id: u64, confirmed: bool) -> Option<String> {
        let now = Instant::now();
        let mut state = g.0.lock().unwrap();
        let prompt = state.prompts.remove(&id)?;
        if !confirmed {
            return None;
        }
        let token = random_token();
        state.grants.insert(
            token.clone(),
            Grant { action: prompt.action, subjects: prompt.subjects, minted: now },
        );
        Some(token)
    }

    #[test]
    fn a_command_with_no_token_is_refused() {
        let g = gate();
        assert!(spend(&g, "nothing-was-minted", "trash_entry", "/w/a.txt").is_err());
    }

    #[test]
    fn a_confirmed_prompt_mints_a_token_its_own_subject_can_spend() {
        let g = gate();
        let id = open(&g, "trash_entry", &["/w/a.txt"]);
        let token = answer(&g, id, true).expect("a yes mints");
        assert!(spend(&g, &token, "trash_entry", "/w/a.txt").is_ok());
    }

    /// The close prompt's bottom rung stops the daemon for good, which
    /// is a different question from Settings' "restart it" -- one leaves
    /// the daemon running and one does not. A grant is bound to the
    /// action its prompt named, so the restart prompt's token cannot
    /// answer for the stop.
    #[test]
    fn a_restart_grant_cannot_stop_the_daemon() {
        let g = gate();
        let id = open(&g, "restart_daemon", &[DAEMON_SUBJECT]);
        let token = answer(&g, id, true).expect("a yes mints");
        assert!(spend(&g, &token, "stop_daemon", DAEMON_SUBJECT).is_err());
    }

    /// Registration is the gate: `open_confirmation` refuses to mint for
    /// an action that is not on the list, so a command left off it can
    /// never be confirmed at all.
    #[test]
    fn stopping_the_daemon_is_a_gated_action() {
        assert!(GATED_ACTIONS.contains(&"stop_daemon"));
    }

    #[test]
    fn a_cancelled_prompt_mints_nothing() {
        let g = gate();
        let id = open(&g, "trash_entry", &["/w/a.txt"]);
        assert!(answer(&g, id, false).is_none());
    }

    #[test]
    fn a_prompt_can_only_be_answered_once() {
        let g = gate();
        let id = open(&g, "trash_entry", &["/w/a.txt"]);
        assert!(answer(&g, id, true).is_some());
        assert!(answer(&g, id, true).is_none());
    }

    /// The property that makes the binding worth having: a human who
    /// agreed to delete one card has not agreed to delete another.
    #[test]
    fn a_token_cannot_be_redirected_at_another_subject() {
        let g = gate();
        let id = open(&g, "delete_card_file", &["/w/.gavin-root/plans/a.md"]);
        let token = answer(&g, id, true).unwrap();
        assert!(spend(&g, &token, "delete_card_file", "/w/.gavin-root/plans/b.md").is_err());
        // ...and the failed attempt did not burn the real one.
        assert!(spend(&g, &token, "delete_card_file", "/w/.gavin-root/plans/a.md").is_ok());
    }

    #[test]
    fn a_token_cannot_be_redirected_at_another_action() {
        let g = gate();
        let id = open(&g, "trash_entry", &["/w/a.txt"]);
        let token = answer(&g, id, true).unwrap();
        assert!(spend(&g, &token, "delete_card_file", "/w/a.txt").is_err());
    }

    #[test]
    fn a_subject_can_be_spent_only_once() {
        let g = gate();
        let id = open(&g, "trash_entry", &["/w/a.txt"]);
        let token = answer(&g, id, true).unwrap();
        assert!(spend(&g, &token, "trash_entry", "/w/a.txt").is_ok());
        assert!(spend(&g, &token, "trash_entry", "/w/a.txt").is_err());
    }

    /// One prompt, many files: deleting a plan card takes its nested
    /// tasks' files with it, and the human answered for all of them.
    #[test]
    fn one_prompt_covers_every_subject_it_named() {
        let g = gate();
        let id = open(&g, "delete_card_file", &["/w/a.md", "/w/b.md", "/w/c.md"]);
        let token = answer(&g, id, true).unwrap();
        for path in ["/w/c.md", "/w/a.md", "/w/b.md"] {
            assert!(spend(&g, &token, "delete_card_file", path).is_ok());
        }
        assert!(spend(&g, &token, "delete_card_file", "/w/a.md").is_err());
    }

    #[test]
    fn an_expired_grant_cannot_be_spent() {
        let g = gate();
        let id = open(&g, "restart_daemon", &[DAEMON_SUBJECT]);
        let token = answer(&g, id, true).unwrap();
        // Age the grant past its TTL rather than sleeping for it.
        {
            let mut state = g.0.lock().unwrap();
            let grant = state.grants.get_mut(&token).unwrap();
            grant.minted = Instant::now() - GRANT_TTL - Duration::from_secs(1);
        }
        assert!(spend(&g, &token, "restart_daemon", DAEMON_SUBJECT).is_err());
    }

    /// Every gated action is spelled the way the command is registered:
    /// the frontend names the action with the command's own name, so a
    /// mismatch here would be a gate nothing can ever satisfy.
    #[test]
    fn gated_actions_are_sorted_and_unique() {
        let mut sorted = GATED_ACTIONS.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted, GATED_ACTIONS);
    }
}
