//! Whether a compressed session's requests are reaching Headroom.
//!
//! A session is compressed by environment, and environment is only as
//! good as the agent CLI's respect for it: Headroom documents one gap
//! for Claude Code already (#951, background workers that re-read the
//! settings file instead of inheriting the environment), and any CLI
//! can stop honouring a base URL in its next release. Such a session
//! is marked compressed, reaches its model directly, and nothing about
//! it looks wrong (spec, "Failures").
//!
//! So when one of its turns ends, the app asks, and the answer is read
//! off Headroom's `/stats`: the requests it has counted under the
//! session's tag. Any at all and the session reaches Headroom, for good.
//! None is harder, because Headroom's count can lose a session that did
//! reach it, in two ways that are both measured against 0.39.1:
//!
//! - **Eviction.** `per_project` keeps at most 50 sessions and, on every
//!   new one past that, evicts the one that saved least
//!   (`savings_tracker.py`, `DEFAULT_MAX_PROJECTS`). Within one process
//!   the map only grows to its limit and never shrinks, so a map below
//!   its limit has evicted nothing, and one at its limit may have
//!   evicted this session a moment ago.
//! - **A restart.** Headroom writes its savings to disk every 25
//!   requests (`PROXY_SAVINGS_FLUSH_EVERY`). A Headroom that died and was
//!   restarted forgot whatever it had counted since the last write, so
//!   a young session can be missing from a map that is nowhere near
//!   full. Only the process the session was pointed at can say it saw
//!   nothing.
//!
//! An absence that either could explain is `Unknown`, which marks
//! nothing: a false "not reaching Headroom" on a session that is fine is
//! the noise the mark is meant never to be.
//!
//! Pure: `Headroom::reach` does the asking.

use super::http::ProjectView;

/// What Headroom has seen of one compressed session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reach {
    /// Headroom has counted at least one request under its tag.
    Reached,
    /// A turn ended, and the process the session was pointed at, with
    /// room to spare in its map, has counted nothing.
    Unreached,
    /// It cannot be told: Headroom did not answer, has been restarted
    /// since, or is keeping as many sessions as it will hold.
    Unknown,
}

impl Reach {
    /// The word sent to the app (`Response::HeadroomReach`).
    pub fn id(self) -> &'static str {
        match self {
            Reach::Reached => "reached",
            Reach::Unreached => "unreached",
            Reach::Unknown => "unknown",
        }
    }
}

/// The verdict on one ask.
///
/// `view` is `/stats`' account of the session, or `None` when Headroom
/// did not give one. `same_process` is whether the Headroom that answered
/// is the one the session was pointed at when it launched.
pub fn verdict(view: Option<&ProjectView>, same_process: bool) -> Reach {
    let Some(view) = view else {
        return Reach::Unknown;
    };
    if view.requests.is_some_and(|requests| requests > 0) {
        return Reach::Reached;
    }
    if !same_process || view.kept >= view.limit {
        return Reach::Unknown;
    }
    Reach::Unreached
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view(requests: Option<u64>, kept: u64) -> ProjectView {
        ProjectView { requests, kept, limit: 50 }
    }

    #[test]
    fn any_request_under_its_tag_is_a_session_that_reaches_headroom() {
        assert_eq!(verdict(Some(&view(Some(1), 3)), true), Reach::Reached);
        assert_eq!(verdict(Some(&view(Some(37), 50)), true), Reach::Reached);
    }

    /// A count is proof whoever gives it: a restarted Headroom that has
    /// counted the session's requests since has seen them.
    #[test]
    fn a_count_is_proof_even_from_a_headroom_restarted_since_the_launch() {
        assert_eq!(verdict(Some(&view(Some(4), 3)), false), Reach::Reached);
    }

    #[test]
    fn nothing_counted_by_the_process_it_was_pointed_at_with_room_to_spare_is_unreached() {
        assert_eq!(verdict(Some(&view(None, 0)), true), Reach::Unreached);
        assert_eq!(verdict(Some(&view(None, 49)), true), Reach::Unreached);
        assert_eq!(verdict(Some(&view(Some(0), 12)), true), Reach::Unreached, "an entry of nothing");
    }

    /// Eviction: at its limit the map drops the session that saved
    /// least on every new arrival, and a young one saved least.
    #[test]
    fn a_missing_session_in_a_full_map_may_have_been_evicted() {
        assert_eq!(verdict(Some(&view(None, 50)), true), Reach::Unknown);
        let over = ProjectView { requests: None, kept: 51, limit: 50 };
        assert_eq!(verdict(Some(&over), true), Reach::Unknown);
    }

    /// A restart: Headroom writes its count every 25 requests, and a
    /// Headroom that died forgot what it counted since.
    #[test]
    fn a_missing_session_on_a_headroom_restarted_since_it_launched_may_have_been_forgotten() {
        assert_eq!(verdict(Some(&view(None, 2)), false), Reach::Unknown);
    }

    #[test]
    fn a_headroom_that_did_not_answer_says_nothing() {
        assert_eq!(verdict(None, true), Reach::Unknown);
    }

    #[test]
    fn the_words_are_the_ones_the_app_reads() {
        assert_eq!(Reach::Reached.id(), "reached");
        assert_eq!(Reach::Unreached.id(), "unreached");
        assert_eq!(Reach::Unknown.id(), "unknown");
    }
}
