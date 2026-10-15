//! Which Device each session's PTY is sized for (v74,
//! `ui-companion-session-connect.md`).
//!
//! A PTY has one size. A phone has to shrink it to be readable -- about 45
//! columns against the desk's 150 or more -- and until v74 nothing gave it
//! back: the desk's terminal stayed phone-width after the phone had left.
//! So a Device's resize BORROWS the size: the daemon remembers the size the
//! desk last asked for, holds the desk's own resizes back while the borrow
//! lasts (applied, they would squeeze the phone mid-read), and puts the
//! desk's size back when the borrow ends -- the Device closing the terminal,
//! its last connection closing, the desk asking, or the session ending.
//!
//! Separate from ownership (`ownership.rs`): a Device that only looks at a
//! session borrows its size without taking its input.
//!
//! In memory, like ownership: a restart starts every session the desk's,
//! and the desk refits every terminal it shows when it reconnects.
//!
//! Every method that changes something returns what the caller has to do,
//! and the caller does it after letting go of the lock.

use protocol::LiveDevice;
use std::collections::HashMap;

pub type Size = (u16, u16);

#[derive(Default)]
pub struct Borrows {
    by_session: HashMap<String, LiveDevice>,
    /// The size the desk last asked for, per session, borrowed or not:
    /// what a borrow's end gives back.
    desk_size: HashMap<String, Size>,
}

/// What to do with a resize the desk asked for.
#[derive(Debug, PartialEq, Eq)]
pub enum DeskResize {
    Apply,
    /// A Device has the size: hold it back, and say who has it again.
    Held(LiveDevice),
}

/// A borrow that ended: the desk's size to put back (`None` when the desk
/// never sized the session -- one a Device started and the desk never
/// showed), and the session to announce as the desk's again.
#[derive(Debug, PartialEq, Eq)]
pub struct Returned {
    pub session_id: String,
    pub desk_size: Option<Size>,
}

impl Borrows {
    /// The desk asked for `size`. Remembered either way.
    pub fn desk_resize(&mut self, session_id: &str, size: Size) -> DeskResize {
        self.desk_size.insert(session_id.to_string(), size);
        match self.by_session.get(session_id) {
            Some(device) => DeskResize::Held(device.clone()),
            None => DeskResize::Apply,
        }
    }

    /// A Device resized the session: it has the size now, taking it from
    /// another Device if one had it. The new borrower when it changed, to
    /// announce; `None` when this Device already had it.
    pub fn device_resize(&mut self, session_id: &str, device: LiveDevice) -> Option<LiveDevice> {
        match self.by_session.get(session_id) {
            Some(current) if current.device_id == device.device_id => None,
            _ => {
                self.by_session.insert(session_id.to_string(), device.clone());
                Some(device)
            }
        }
    }

    /// Ends the session's borrow. `by` is the Device asking, `None` for the
    /// desk: a Device gives back only a borrow of its own, so a phone
    /// closing a terminal cannot undo another phone's.
    pub fn give_back(&mut self, session_id: &str, by: Option<&str>) -> Option<Returned> {
        let current = self.by_session.get(session_id)?;
        if by.is_some_and(|device_id| device_id != current.device_id) {
            return None;
        }
        self.by_session.remove(session_id);
        Some(Returned { session_id: session_id.to_string(), desk_size: self.desk_size.get(session_id).copied() })
    }

    /// The Device's last connection closed: every size it had goes back.
    pub fn device_gone(&mut self, device_id: &str) -> Vec<Returned> {
        let mut sessions: Vec<String> = self
            .by_session
            .iter()
            .filter(|(_, device)| device.device_id == device_id)
            .map(|(session_id, _)| session_id.clone())
            .collect();
        sessions.sort();
        sessions.into_iter().filter_map(|session_id| self.give_back(&session_id, Some(device_id))).collect()
    }

    /// The session ended: nothing to give back, and nobody to tell -- its
    /// tab is going.
    pub fn session_ended(&mut self, session_id: &str) {
        self.by_session.remove(session_id);
        self.desk_size.remove(session_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn phone(id: &str) -> LiveDevice {
        LiveDevice { device_id: id.to_string(), name: format!("{id}'s phone") }
    }

    #[test]
    fn the_desk_resizes_freely_while_nothing_is_borrowed() {
        let mut b = Borrows::default();
        assert_eq!(b.desk_resize("s", (160, 48)), DeskResize::Apply);
    }

    #[test]
    fn a_device_borrows_and_the_desk_is_held_back_and_told_who() {
        let mut b = Borrows::default();
        b.desk_resize("s", (160, 48));
        assert_eq!(b.device_resize("s", phone("p")), Some(phone("p")));
        assert_eq!(b.desk_resize("s", (170, 50)), DeskResize::Held(phone("p")));
    }

    #[test]
    fn the_same_device_resizing_again_announces_nothing() {
        let mut b = Borrows::default();
        b.device_resize("s", phone("p"));
        assert_eq!(b.device_resize("s", phone("p")), None);
    }

    #[test]
    fn another_device_takes_the_borrow() {
        let mut b = Borrows::default();
        b.device_resize("s", phone("p"));
        assert_eq!(b.device_resize("s", phone("q")), Some(phone("q")));
        // The first phone closing its terminal is not the second's to undo.
        assert_eq!(b.give_back("s", Some("p")), None);
        assert_eq!(b.desk_resize("s", (160, 48)), DeskResize::Held(phone("q")));
    }

    #[test]
    fn giving_back_restores_the_size_the_desk_last_asked_for() {
        let mut b = Borrows::default();
        b.desk_resize("s", (160, 48));
        b.device_resize("s", phone("p"));
        // Held back, but remembered: the desk window grew meanwhile.
        b.desk_resize("s", (200, 60));
        assert_eq!(b.give_back("s", Some("p")), Some(Returned { session_id: "s".into(), desk_size: Some((200, 60)) }));
        assert_eq!(b.desk_resize("s", (200, 60)), DeskResize::Apply);
        assert_eq!(b.give_back("s", None), None, "nothing is borrowed any more");
    }

    #[test]
    fn the_desk_takes_it_back_from_any_device() {
        let mut b = Borrows::default();
        b.device_resize("s", phone("p"));
        assert_eq!(b.give_back("s", None), Some(Returned { session_id: "s".into(), desk_size: None }));
    }

    #[test]
    fn a_device_going_away_gives_back_only_its_own() {
        let mut b = Borrows::default();
        b.desk_resize("a", (100, 30));
        b.device_resize("a", phone("p"));
        b.device_resize("b", phone("p"));
        b.device_resize("c", phone("q"));
        assert_eq!(
            b.device_gone("p"),
            vec![
                Returned { session_id: "a".into(), desk_size: Some((100, 30)) },
                Returned { session_id: "b".into(), desk_size: None },
            ]
        );
        assert_eq!(b.desk_resize("c", (100, 30)), DeskResize::Held(phone("q")));
    }

    #[test]
    fn an_ended_session_forgets_both() {
        let mut b = Borrows::default();
        b.desk_resize("s", (160, 48));
        b.device_resize("s", phone("p"));
        b.session_ended("s");
        assert_eq!(b.give_back("s", None), None);
        assert_eq!(b.device_gone("p"), vec![]);
    }
}
