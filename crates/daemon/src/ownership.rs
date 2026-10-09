//! Which Device each session takes input from (v68,
//! `docs/superpowers/specs/2026-10-09-session-ownership.md`, ADR 0008).
//!
//! A session with no record here is the desk's. A Device takes one by
//! starting it, by sending input into one nobody owns, or by asking
//! (`SetSessionOwner`); from then on every other Device's input is refused
//! with the owner's name, until somebody takes it over, it is handed on,
//! or it is released. The desk's own input is never refused here: its
//! connection carries rails and the follow-up queue as well as its human,
//! so the desk holds its human to the lock at its surfaces.
//!
//! Every change goes through `&mut self` under the manager's one mutex,
//! so two Devices racing for a session get one winner -- the second is
//! refused with who won (`Owned`, or `Changed` when it said whom it
//! expected).
//!
//! In memory, like presence: a restart starts every session the desk's.
//! The other daemon sharing the trust store hosts other sessions and has
//! no need to see these.
//!
//! Every method that changes something returns what to push, and the
//! caller pushes it after letting go of the lock.

use protocol::session_owner::{OWNER_BUSY_SECS, OWNER_GRACE_SECS};
use protocol::{OwnerChange, OwnerRefusal, SessionOwner, SessionOwnership};
use std::collections::HashMap;

/// A Device as this module needs it: its id, and its name for the lock to
/// say -- asked for only when a Device actually takes a session, since it
/// is a trust-store read and input arrives a keystroke at a time.
pub struct Caller<'a, F: FnOnce() -> String> {
    pub device_id: &'a str,
    pub name: F,
}

#[derive(Default)]
pub struct Owners {
    by_session: HashMap<String, Record>,
    /// The desk's last input into each session no Device owns: the holder
    /// a Take over of that session asks before taking from.
    desk_typed: HashMap<String, i64>,
}

struct Record {
    owner: SessionOwner,
    changed_by: Option<String>,
    reason: OwnerChange,
    at: i64,
}

impl Record {
    fn ownership(&self, session_id: &str) -> SessionOwnership {
        SessionOwnership {
            session_id: session_id.to_string(),
            owner: Some(self.owner.clone()),
            changed_by: self.changed_by.clone(),
            reason: self.reason,
            at: self.at,
        }
    }
}

/// The desk's ownership of a session, after a change that left it there.
fn desks(session_id: &str, changed_by: Option<&str>, reason: OwnerChange, at: i64) -> SessionOwnership {
    SessionOwnership {
        session_id: session_id.to_string(),
        owner: None,
        changed_by: changed_by.map(str::to_string),
        reason,
        at,
    }
}

fn fresh(at: i64, typed: i64) -> bool {
    at - typed < OWNER_BUSY_SECS
}

impl Owners {
    /// The desk's input into `session_id`. Always passes, and is
    /// remembered only while no Device owns the session: while one does,
    /// the desk's write for that session is the owner's own forwarded
    /// input, not the desk typing.
    pub fn desk_input(&mut self, session_id: &str, now: i64) {
        if !self.by_session.contains_key(session_id) {
            self.desk_typed.insert(session_id.to_string(), now);
        }
    }

    /// A Device's input into `session_id`.
    ///
    /// The owner passes. Any other Device is refused while a Device owns
    /// the session, asked first (`Busy`) while the desk typed into it a
    /// moment ago, and otherwise takes it: `Some` is that change, to push.
    pub fn device_input<F: FnOnce() -> String>(
        &mut self,
        device: Caller<'_, F>,
        session_id: &str,
        now: i64,
    ) -> Result<Option<SessionOwnership>, OwnerRefusal> {
        if let Some(record) = self.by_session.get_mut(session_id) {
            if record.owner.device_id != device.device_id {
                return Err(OwnerRefusal::Owned { session_id: session_id.to_string(), owner: record.owner.clone() });
            }
            record.owner.typed_at = Some(now);
            return Ok(None);
        }
        if let Some(&typed) = self.desk_typed.get(session_id).filter(|&&typed| fresh(now, typed)) {
            return Err(OwnerRefusal::Busy { session_id: session_id.to_string(), owner: None, typed_at: typed });
        }
        let record = self.take(session_id, device.device_id, (device.name)(), Some(device.device_id), OwnerChange::Claimed, now);
        record.owner.typed_at = Some(now);
        Ok(Some(record.ownership(session_id)))
    }

    /// A Device started `session_id`: it is that Device's.
    pub fn started(&mut self, device_id: &str, name: String, session_id: &str, now: i64) -> SessionOwnership {
        self.take(session_id, device_id, name, Some(device_id), OwnerChange::Started, now).ownership(session_id)
    }

    /// `SetSessionOwner`: `caller` (a Device, or `None` for the desk)
    /// makes `to` (likewise) the owner, having seen `expect` there.
    ///
    /// Refused, in this order: `Changed` when the owner is no longer
    /// `expect`; `NotConnected` when `to` is a Device other than the
    /// caller with no live connection (`live`); `Busy` when the caller is
    /// not the holder and the holder typed a moment ago, unless `force`.
    /// The second element says whether anything changed -- asking for
    /// the owner a session already has changes nothing and pushes
    /// nothing.
    #[allow(clippy::too_many_arguments)]
    pub fn set(
        &mut self,
        caller: Option<&str>,
        session_id: &str,
        to: Option<(&str, String)>,
        expect: Option<&str>,
        force: bool,
        live: impl Fn(&str) -> bool,
        now: i64,
    ) -> Result<(SessionOwnership, bool), OwnerRefusal> {
        let current = self.by_session.get(session_id);
        let current_id = current.map(|r| r.owner.device_id.as_str());
        if current_id != expect {
            return Err(OwnerRefusal::Changed {
                session_id: session_id.to_string(),
                owner: current.map(|r| r.owner.clone()),
            });
        }
        let to_id = to.as_ref().map(|(id, _)| *id);
        if to_id == current_id {
            let unchanged = match current {
                Some(record) => record.ownership(session_id),
                None => desks(session_id, None, OwnerChange::Released, now),
            };
            return Ok((unchanged, false));
        }
        if let Some(target) = to_id.filter(|&target| Some(target) != caller) {
            if !live(target) {
                return Err(OwnerRefusal::NotConnected {
                    session_id: session_id.to_string(),
                    device_id: target.to_string(),
                });
            }
        }
        if caller != current_id && !force {
            let typed = match current {
                Some(record) => record.owner.typed_at,
                None => self.desk_typed.get(session_id).copied(),
            };
            if let Some(typed) = typed.filter(|&typed| fresh(now, typed)) {
                return Err(OwnerRefusal::Busy {
                    session_id: session_id.to_string(),
                    owner: current.map(|r| r.owner.clone()),
                    typed_at: typed,
                });
            }
        }
        let reason = match to_id {
            _ if to_id == caller => OwnerChange::TookOver,
            None => OwnerChange::Released,
            Some(_) => OwnerChange::HandedOver,
        };
        let changed = match to {
            None => {
                self.by_session.remove(session_id);
                self.desk_typed.remove(session_id);
                desks(session_id, caller, reason, now)
            }
            Some((device_id, name)) => self.take(session_id, device_id, name, caller, reason, now).ownership(session_id),
        };
        Ok((changed, true))
    }

    /// `device_id`'s last connection closed: its sessions wait out the
    /// grace for it.
    pub fn device_away(&mut self, device_id: &str, now: i64) -> Vec<SessionOwnership> {
        self.by_session
            .iter_mut()
            .filter(|(_, r)| r.owner.device_id == device_id && r.owner.away_since.is_none())
            .map(|(session_id, r)| {
                r.owner.away_since = Some(now);
                r.owner.releases_at = Some(now + OWNER_GRACE_SECS);
                r.ownership(session_id)
            })
            .collect()
    }

    /// `device_id` connected again: its sessions are its own once more.
    pub fn device_back(&mut self, device_id: &str) -> Vec<SessionOwnership> {
        self.by_session
            .iter_mut()
            .filter(|(_, r)| r.owner.device_id == device_id && r.owner.away_since.is_some())
            .map(|(session_id, r)| {
                r.owner.away_since = None;
                r.owner.releases_at = None;
                r.ownership(session_id)
            })
            .collect()
    }

    /// Every session whose Device stayed away past the grace, back to the
    /// desk.
    pub fn lapse(&mut self, now: i64) -> Vec<SessionOwnership> {
        let lapsed: Vec<String> = self
            .by_session
            .iter()
            .filter(|(_, r)| r.owner.releases_at.is_some_and(|at| at <= now))
            .map(|(session_id, _)| session_id.clone())
            .collect();
        lapsed
            .into_iter()
            .map(|session_id| {
                self.by_session.remove(&session_id);
                desks(&session_id, None, OwnerChange::Lapsed, now)
            })
            .collect()
    }

    /// Every session `device_id` owns, back to the desk at once: it was
    /// revoked, removed itself, or was refused for a reason that ends its
    /// trust. No grace -- a Device that may not connect again cannot come
    /// back for them.
    pub fn release_device(&mut self, device_id: &str, now: i64) -> Vec<SessionOwnership> {
        let held: Vec<String> = self
            .by_session
            .iter()
            .filter(|(_, r)| r.owner.device_id == device_id)
            .map(|(session_id, _)| session_id.clone())
            .collect();
        held.into_iter()
            .map(|session_id| {
                self.by_session.remove(&session_id);
                desks(&session_id, None, OwnerChange::Revoked, now)
            })
            .collect()
    }

    /// The session ended. `Some` when a Device owned it, to push.
    pub fn session_ended(&mut self, session_id: &str, now: i64) -> Option<SessionOwnership> {
        self.desk_typed.remove(session_id);
        self.by_session.remove(session_id).map(|_| desks(session_id, None, OwnerChange::Ended, now))
    }

    /// Every session a Device owns. A session not listed is the desk's.
    pub fn list(&self) -> Vec<SessionOwnership> {
        let mut owned: Vec<SessionOwnership> =
            self.by_session.iter().map(|(session_id, r)| r.ownership(session_id)).collect();
        owned.sort_by(|a, b| a.session_id.cmp(&b.session_id));
        owned
    }

    fn take(
        &mut self,
        session_id: &str,
        device_id: &str,
        name: String,
        changed_by: Option<&str>,
        reason: OwnerChange,
        now: i64,
    ) -> &mut Record {
        self.desk_typed.remove(session_id);
        let record = Record {
            owner: SessionOwner {
                device_id: device_id.to_string(),
                name,
                since: now,
                typed_at: None,
                away_since: None,
                releases_at: None,
            },
            changed_by: changed_by.map(str::to_string),
            reason,
            at: now,
        };
        self.by_session.insert(session_id.to_string(), record);
        self.by_session.get_mut(session_id).unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(id: &str) -> Caller<'_, impl FnOnce() -> String + '_> {
        Caller { device_id: id, name: move || format!("{id}'s phone") }
    }

    fn owner_of(o: &Owners, session_id: &str) -> Option<String> {
        o.by_session.get(session_id).map(|r| r.owner.device_id.clone())
    }

    fn everyone_live(_: &str) -> bool {
        true
    }

    #[test]
    fn a_device_typing_into_a_session_nobody_owns_takes_it() {
        let mut o = Owners::default();
        let claimed = o.device_input(device("ipad"), "s1", 100).unwrap().unwrap();
        assert_eq!(claimed.reason, OwnerChange::Claimed);
        assert_eq!(claimed.changed_by.as_deref(), Some("ipad"));
        let owner = claimed.owner.unwrap();
        assert_eq!((owner.device_id.as_str(), owner.name.as_str()), ("ipad", "ipad's phone"));
        assert_eq!((owner.since, owner.typed_at), (100, Some(100)));
    }

    #[test]
    fn the_owners_own_input_passes_and_is_not_a_change() {
        let mut o = Owners::default();
        o.device_input(device("ipad"), "s1", 100).unwrap();
        assert_eq!(o.device_input(device("ipad"), "s1", 104).unwrap(), None);
        assert_eq!(o.list()[0].owner.as_ref().unwrap().typed_at, Some(104));
    }

    #[test]
    fn another_devices_input_is_refused_naming_the_owner() {
        let mut o = Owners::default();
        o.device_input(device("iphone"), "s1", 100).unwrap();
        match o.device_input(device("ipad"), "s1", 101) {
            Err(OwnerRefusal::Owned { session_id, owner }) => {
                assert_eq!(session_id, "s1");
                assert_eq!(owner.device_id, "iphone");
            }
            other => panic!("expected Owned, got {other:?}"),
        }
        // Long after the owner stopped typing, still refused: owning is
        // not typing.
        assert!(matches!(o.device_input(device("ipad"), "s1", 10_000), Err(OwnerRefusal::Owned { .. })));
    }

    /// The desk's connection carries its rails and its queue: never
    /// refused, and it never takes a session from a Device.
    #[test]
    fn the_desks_input_always_passes_and_never_claims() {
        let mut o = Owners::default();
        o.desk_input("s1", 100);
        assert_eq!(owner_of(&o, "s1"), None);
        o.device_input(device("iphone"), "s1", 200).unwrap();
        o.desk_input("s1", 201);
        assert_eq!(owner_of(&o, "s1").as_deref(), Some("iphone"));
    }

    /// The decision-4 confirm, for a phone typing into a session the desk
    /// is typing in.
    #[test]
    fn a_device_typing_where_the_desk_just_typed_is_asked_first() {
        let mut o = Owners::default();
        o.desk_input("s1", 100);
        match o.device_input(device("iphone"), "s1", 100 + OWNER_BUSY_SECS - 1) {
            Err(OwnerRefusal::Busy { owner: None, typed_at, .. }) => assert_eq!(typed_at, 100),
            other => panic!("expected Busy from the desk, got {other:?}"),
        }
        assert_eq!(owner_of(&o, "s1"), None);
        // Once the desk has been quiet a moment, the phone just takes it.
        assert!(o.device_input(device("iphone"), "s1", 100 + OWNER_BUSY_SECS).unwrap().is_some());
    }

    /// While a Device owns the session, the desk's writes for it are that
    /// Device's own, forwarded: not the desk typing.
    #[test]
    fn the_desk_is_not_typing_while_a_device_owns_the_session() {
        let mut o = Owners::default();
        o.device_input(device("iphone"), "s1", 100).unwrap();
        o.desk_input("s1", 101);
        let (released, _) = o.set(Some("iphone"), "s1", None, Some("iphone"), false, everyone_live, 102).unwrap();
        assert_eq!(released.owner, None);
        assert!(o.device_input(device("ipad"), "s1", 103).unwrap().is_some(), "the desk never typed");
    }

    #[test]
    fn a_session_a_device_started_is_that_devices() {
        let mut o = Owners::default();
        let started = o.started("iphone", "iPhone".into(), "s1", 50);
        assert_eq!(started.reason, OwnerChange::Started);
        assert_eq!(started.owner.unwrap().typed_at, None);
        assert!(matches!(o.device_input(device("ipad"), "s1", 51), Err(OwnerRefusal::Owned { .. })));
    }

    #[test]
    fn take_over_moves_the_session_and_says_who() {
        let mut o = Owners::default();
        o.device_input(device("iphone"), "s1", 100).unwrap();
        let name = "iPad".to_string();
        let (taken, changed) =
            o.set(Some("ipad"), "s1", Some(("ipad", name)), Some("iphone"), false, everyone_live, 200).unwrap();
        assert!(changed);
        assert_eq!(taken.reason, OwnerChange::TookOver);
        assert_eq!(taken.changed_by.as_deref(), Some("ipad"));
        assert_eq!(taken.owner.unwrap().device_id, "ipad");
        // The loser is now the one refused.
        assert!(matches!(o.device_input(device("iphone"), "s1", 201), Err(OwnerRefusal::Owned { .. })));
        assert_eq!(o.device_input(device("ipad"), "s1", 201).unwrap(), None);
    }

    #[test]
    fn the_desk_takes_back_a_devices_session() {
        let mut o = Owners::default();
        o.device_input(device("iphone"), "s1", 100).unwrap();
        let (back, changed) = o.set(None, "s1", None, Some("iphone"), false, everyone_live, 200).unwrap();
        assert!(changed);
        assert_eq!((back.owner, back.changed_by, back.reason), (None, None, OwnerChange::TookOver));
        assert_eq!(owner_of(&o, "s1"), None);
    }

    #[test]
    fn a_device_takes_a_session_from_the_desk() {
        let mut o = Owners::default();
        let (taken, _) = o.set(Some("ipad"), "s1", Some(("ipad", "iPad".into())), None, false, everyone_live, 10).unwrap();
        assert_eq!(taken.reason, OwnerChange::TookOver);
        assert_eq!(owner_of(&o, "s1").as_deref(), Some("ipad"));
    }

    /// Two Devices both saw the iPhone own it and both pressed Take over:
    /// the first wins, and the second is told who did.
    #[test]
    fn two_racing_take_overs_have_one_winner() {
        let mut o = Owners::default();
        o.device_input(device("iphone"), "s1", 100).unwrap();
        o.set(Some("ipad"), "s1", Some(("ipad", "iPad".into())), Some("iphone"), true, everyone_live, 200).unwrap();
        match o.set(Some("pixel"), "s1", Some(("pixel", "Pixel".into())), Some("iphone"), true, everyone_live, 200) {
            Err(OwnerRefusal::Changed { owner: Some(owner), .. }) => assert_eq!(owner.device_id, "ipad"),
            other => panic!("expected Changed naming the iPad, got {other:?}"),
        }
        assert_eq!(owner_of(&o, "s1").as_deref(), Some("ipad"));
    }

    /// The racing claim by input: two Devices type into an unowned
    /// session; the second is refused, naming the first.
    #[test]
    fn two_racing_claims_by_input_have_one_winner() {
        let mut o = Owners::default();
        assert!(o.device_input(device("iphone"), "s1", 100).unwrap().is_some());
        match o.device_input(device("ipad"), "s1", 100) {
            Err(OwnerRefusal::Owned { owner, .. }) => assert_eq!(owner.device_id, "iphone"),
            other => panic!("expected Owned, got {other:?}"),
        }
    }

    #[test]
    fn taking_over_while_the_owner_types_asks_first_and_force_passes() {
        let mut o = Owners::default();
        o.device_input(device("iphone"), "s1", 100).unwrap();
        let ask = o.set(Some("ipad"), "s1", Some(("ipad", "iPad".into())), Some("iphone"), false, everyone_live, 102);
        match ask {
            Err(OwnerRefusal::Busy { owner: Some(owner), typed_at, .. }) => {
                assert_eq!((owner.device_id.as_str(), typed_at), ("iphone", 100));
            }
            other => panic!("expected Busy, got {other:?}"),
        }
        assert_eq!(owner_of(&o, "s1").as_deref(), Some("iphone"));
        let (forced, _) =
            o.set(Some("ipad"), "s1", Some(("ipad", "iPad".into())), Some("iphone"), true, everyone_live, 102).unwrap();
        assert_eq!(forced.owner.unwrap().device_id, "ipad");
    }

    /// Busy is about the HOLDER typing: the owner handing its own session
    /// on, or a session nobody has typed into, is not asked about.
    #[test]
    fn the_owner_is_never_asked_about_its_own_typing() {
        let mut o = Owners::default();
        o.device_input(device("iphone"), "s1", 100).unwrap();
        let (handed, _) =
            o.set(Some("iphone"), "s1", Some(("ipad", "iPad".into())), Some("iphone"), false, everyone_live, 101).unwrap();
        assert_eq!(handed.reason, OwnerChange::HandedOver);
        assert_eq!(handed.changed_by.as_deref(), Some("iphone"));
        assert_eq!(handed.owner.unwrap().device_id, "ipad");
    }

    #[test]
    fn the_desk_taking_back_while_the_phone_types_asks_first() {
        let mut o = Owners::default();
        o.device_input(device("iphone"), "s1", 100).unwrap();
        assert!(matches!(
            o.set(None, "s1", None, Some("iphone"), false, everyone_live, 101),
            Err(OwnerRefusal::Busy { owner: Some(_), .. })
        ));
    }

    #[test]
    fn handing_over_to_a_device_with_no_connection_is_refused() {
        let mut o = Owners::default();
        o.device_input(device("iphone"), "s1", 100).unwrap();
        let only_iphone = |id: &str| id == "iphone";
        match o.set(Some("iphone"), "s1", Some(("ipad", "iPad".into())), Some("iphone"), false, only_iphone, 101) {
            Err(OwnerRefusal::NotConnected { device_id, .. }) => assert_eq!(device_id, "ipad"),
            other => panic!("expected NotConnected, got {other:?}"),
        }
        assert_eq!(owner_of(&o, "s1").as_deref(), Some("iphone"));
    }

    #[test]
    fn the_owner_releases_to_the_desk() {
        let mut o = Owners::default();
        o.device_input(device("iphone"), "s1", 100).unwrap();
        let (released, _) = o.set(Some("iphone"), "s1", None, Some("iphone"), false, everyone_live, 120).unwrap();
        assert_eq!((released.owner, released.reason), (None, OwnerChange::Released));
        assert_eq!(released.changed_by.as_deref(), Some("iphone"));
        assert!(o.list().is_empty());
    }

    #[test]
    fn asking_for_the_owner_it_already_has_changes_nothing() {
        let mut o = Owners::default();
        o.device_input(device("iphone"), "s1", 100).unwrap();
        let (same, changed) =
            o.set(Some("iphone"), "s1", Some(("iphone", "iPhone".into())), Some("iphone"), false, everyone_live, 101).unwrap();
        assert!(!changed);
        assert_eq!(same.owner.unwrap().since, 100);
        let (desk, changed) = o.set(None, "s2", None, None, false, everyone_live, 101).unwrap();
        assert!(!changed);
        assert_eq!(desk.owner, None);
    }

    #[test]
    fn revoking_the_owner_releases_its_sessions_at_once() {
        let mut o = Owners::default();
        o.device_input(device("iphone"), "s1", 100).unwrap();
        o.started("iphone", "iPhone".into(), "s2", 100);
        o.device_input(device("ipad"), "s3", 100).unwrap();
        let mut released = o.release_device("iphone", 150);
        released.sort_by(|a, b| a.session_id.cmp(&b.session_id));
        assert_eq!(released.iter().map(|r| r.session_id.as_str()).collect::<Vec<_>>(), ["s1", "s2"]);
        assert!(released.iter().all(|r| r.owner.is_none() && r.reason == OwnerChange::Revoked));
        assert_eq!(o.list().len(), 1, "the iPad keeps its own");
    }

    #[test]
    fn an_owner_that_goes_away_keeps_the_session_through_the_grace_then_loses_it() {
        let mut o = Owners::default();
        o.device_input(device("iphone"), "s1", 100).unwrap();
        let away = o.device_away("iphone", 200);
        assert_eq!(away.len(), 1);
        let owner = away[0].owner.as_ref().unwrap();
        assert_eq!((owner.away_since, owner.releases_at), (Some(200), Some(200 + OWNER_GRACE_SECS)));
        // Away a second time (another of its connections closing) is not
        // news, and does not move the deadline.
        assert!(o.device_away("iphone", 210).is_empty());
        // Others are still refused during the grace...
        assert!(matches!(o.device_input(device("ipad"), "s1", 201), Err(OwnerRefusal::Owned { .. })));
        assert!(o.lapse(200 + OWNER_GRACE_SECS - 1).is_empty());
        // ...and once it runs out, the desk has it back.
        let lapsed = o.lapse(200 + OWNER_GRACE_SECS);
        assert_eq!(lapsed.len(), 1);
        assert_eq!((lapsed[0].owner.clone(), lapsed[0].reason), (None, OwnerChange::Lapsed));
        assert!(o.device_input(device("ipad"), "s1", 300).unwrap().is_some());
    }

    #[test]
    fn an_owner_back_inside_the_grace_keeps_its_sessions() {
        let mut o = Owners::default();
        o.device_input(device("iphone"), "s1", 100).unwrap();
        o.device_away("iphone", 200);
        let back = o.device_back("iphone");
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].owner.as_ref().unwrap().away_since, None);
        assert!(o.lapse(200 + OWNER_GRACE_SECS + 1).is_empty());
        assert_eq!(owner_of(&o, "s1").as_deref(), Some("iphone"));
        // A Device that comes back owning nothing away is no news.
        assert!(o.device_back("iphone").is_empty());
    }

    /// Take over works at any time, the grace included.
    #[test]
    fn a_session_in_its_grace_can_be_taken_over() {
        let mut o = Owners::default();
        o.device_input(device("iphone"), "s1", 100).unwrap();
        o.device_away("iphone", 200);
        let (taken, _) = o.set(None, "s1", None, Some("iphone"), false, everyone_live, 205).unwrap();
        assert_eq!(taken.owner, None);
        assert!(o.lapse(200 + OWNER_GRACE_SECS).is_empty(), "nothing left to lapse");
    }

    #[test]
    fn a_session_that_ends_goes_with_its_owner() {
        let mut o = Owners::default();
        o.device_input(device("iphone"), "s1", 100).unwrap();
        let ended = o.session_ended("s1", 150).unwrap();
        assert_eq!((ended.owner, ended.reason), (None, OwnerChange::Ended));
        assert!(o.list().is_empty());
        // One nobody owned is nothing to push.
        o.desk_input("s2", 100);
        assert_eq!(o.session_ended("s2", 150), None);
        assert!(o.desk_typed.is_empty());
    }
}
