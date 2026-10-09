//! Which Device a session takes input from (v68,
//! `docs/superpowers/specs/2026-10-09-session-ownership.md`, ADR 0008).
//!
//! A session has at most one **Owner**: a Device, or the desk when no
//! record names one. Everyone else sees it locked, and the daemon refuses
//! their input -- a Device's, that is: the desk's connection carries its
//! rails and its follow-up queue as well as its human, so the desk holds
//! its own human to the lock at its surfaces. A courtesy, not a security
//! boundary: anyone may take a session over.
//!
//! The daemon keeps the records (`crates/daemon/src/ownership.rs`) and is
//! the one arbiter, so two Devices racing a Take over get one winner. No
//! operating-system part, so the Companion core can depend on it from
//! `wasm32-unknown-unknown`.

use serde::{Deserialize, Serialize};

/// The first version that answers `SetSessionOwner` and
/// `ListSessionOwners` and pushes `SessionOwnerChanged`. The daemon
/// compares an app's `Hello` version with this before it writes the push.
pub const SESSION_OWNERS_MIN_VERSION: u32 = 68;

/// How long a session stays its Device's after the Device's last
/// connection closes -- the phone locked, went to the background, or lost
/// the network -- before it goes back to the desk. Long enough for a
/// train tunnel, short enough that a pocketed phone never strands one.
pub const OWNER_GRACE_SECS: i64 = 30;

/// How recently the holder must have typed for a Take over to ask first.
/// The holder is the owning Device, or the desk for a session nobody owns.
pub const OWNER_BUSY_SECS: i64 = 5;

/// What every owner refusal's message starts with, the JSON of the
/// `OwnerRefusal` following it. One string both ways: a Device reads it as
/// the error of the command it invoked, the desk as its Tauri command's
/// error, and both parse it with the same rule (`OwnerRefusal::from_error`,
/// and `sessionOwnership.ts`'s `ownerRefusalFrom`).
pub const OWNER_REFUSED_PREFIX: &str = "gavin-daemon: session owner refused: ";

/// The Device a session takes input from.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionOwner {
    pub device_id: String,
    /// The Device's name as the trust store holds it, read when it took
    /// the session: what a lock says ("iPhone is working on this").
    pub name: String,
    /// When it became the owner. Wall-clock epoch seconds, as all of these.
    pub since: i64,
    /// Its last input into the session, if it has sent any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub typed_at: Option<i64>,
    /// When its last connection closed, while it has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub away_since: Option<i64>,
    /// When the session goes back to the desk unless it reconnects:
    /// `away_since + OWNER_GRACE_SECS`. Present exactly when `away_since` is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub releases_at: Option<i64>,
}

/// What last changed a session's owner. Says, to the Device that lost a
/// session, how it lost it.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OwnerChange {
    /// A Device sent input into a session nobody owned.
    Claimed,
    /// A Device started the session.
    Started,
    /// Somebody made themselves the owner: Take over, or Take back at
    /// the desk.
    TookOver,
    /// The owner, or anyone, passed it to another Device.
    HandedOver,
    /// It was passed back to the desk.
    Released,
    /// Its Device was revoked, removed itself, or was refused for a reason
    /// that ends its trust.
    Revoked,
    /// Its Device stayed away past the grace.
    Lapsed,
    /// The session ended.
    Ended,
    /// A reason a newer daemon sent.
    #[serde(other)]
    Other,
}

/// A session's ownership, whole: what `SetSessionOwner` answers and
/// `SessionOwnerChanged` pushes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionOwnership {
    pub session_id: String,
    /// `None`: the desk's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<SessionOwner>,
    /// The Device whose request made the change, or `None` for the desk
    /// and for a change the daemon made itself (a lapse, an end).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changed_by: Option<String>,
    pub reason: OwnerChange,
    pub at: i64,
}

/// A Device with a live connection: who a session can be handed to.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LiveDevice {
    pub device_id: String,
    pub name: String,
}

/// `ListSessionOwners`'s answer as the webview reads it, from the desk's
/// Tauri command and from the daemon answering a Device alike.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionOwnersList {
    /// Only sessions a Device owns; a session not listed is the desk's.
    pub owners: Vec<SessionOwnership>,
    pub devices: Vec<LiveDevice>,
    /// The asking Device, `None` at the desk.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub you: Option<String>,
}

/// Why a write or a change of owner was refused.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum OwnerRefusal {
    /// Input from a Device that does not own the session.
    Owned { session_id: String, owner: SessionOwner },
    /// The holder typed within `OWNER_BUSY_SECS`: ask, then send the
    /// change again with `force`. `owner: None` is the desk.
    Busy {
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        owner: Option<SessionOwner>,
        typed_at: i64,
    },
    /// The owner is no longer the one the request expected: somebody else
    /// changed it first. `owner` is who has it now.
    Changed {
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        owner: Option<SessionOwner>,
    },
    /// A hand-over to a Device with no live connection, which would never
    /// see it.
    NotConnected { session_id: String, device_id: String },
}

impl OwnerRefusal {
    /// The refusal as an error message: `OWNER_REFUSED_PREFIX` and JSON.
    pub fn to_error(&self) -> String {
        format!("{OWNER_REFUSED_PREFIX}{}", serde_json::to_string(self).unwrap_or_default())
    }

    /// The refusal an error message carries, or `None` for any other
    /// error.
    pub fn from_error(message: &str) -> Option<Self> {
        let json = message.find(OWNER_REFUSED_PREFIX).map(|at| &message[at + OWNER_REFUSED_PREFIX.len()..])?;
        serde_json::from_str(json).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner() -> SessionOwner {
        SessionOwner {
            device_id: "d1".into(),
            name: "iPhone".into(),
            since: 10,
            typed_at: Some(12),
            away_since: None,
            releases_at: None,
        }
    }

    /// The webview and the bundle read these fields by their camelCase
    /// names, and an enum's `rename_all` reaches only its variants: the
    /// fields need `rename_all_fields`, or they cross as `session_id`
    /// and read as undefined.
    #[test]
    fn a_refusal_crosses_in_camel_case() {
        let busy = OwnerRefusal::Busy { session_id: "s1".into(), owner: Some(owner()), typed_at: 12 };
        let json = serde_json::to_value(&busy).unwrap();
        assert_eq!(json["kind"], "busy");
        assert_eq!(json["sessionId"], "s1");
        assert_eq!(json["typedAt"], 12);
        assert_eq!(json["owner"]["deviceId"], "d1");
        let gone = OwnerRefusal::NotConnected { session_id: "s1".into(), device_id: "d2".into() };
        assert_eq!(serde_json::to_value(&gone).unwrap()["kind"], "notConnected");
    }

    #[test]
    fn a_refusal_survives_the_error_string() {
        for refusal in [
            OwnerRefusal::Owned { session_id: "s1".into(), owner: owner() },
            OwnerRefusal::Busy { session_id: "s1".into(), owner: None, typed_at: 3 },
            OwnerRefusal::Changed { session_id: "s1".into(), owner: None },
            OwnerRefusal::NotConnected { session_id: "s1".into(), device_id: "d2".into() },
        ] {
            let message = refusal.to_error();
            assert!(message.starts_with(OWNER_REFUSED_PREFIX));
            assert_eq!(OwnerRefusal::from_error(&message), Some(refusal));
        }
    }

    /// The host's Tauri command and the shell may each put words in front
    /// of the daemon's message; the refusal is still found in it.
    #[test]
    fn a_refusal_is_found_behind_other_words() {
        let refusal = OwnerRefusal::Changed { session_id: "s1".into(), owner: None };
        let wrapped = format!("Couldn't send: {}", refusal.to_error());
        assert_eq!(OwnerRefusal::from_error(&wrapped), Some(refusal));
        assert_eq!(OwnerRefusal::from_error("gavin-daemon: no such session"), None);
    }

    #[test]
    fn a_reason_a_newer_daemon_sent_still_parses() {
        let parsed: OwnerChange = serde_json::from_str("\"somethingNew\"").unwrap();
        assert_eq!(parsed, OwnerChange::Other);
        assert_eq!(serde_json::to_string(&OwnerChange::TookOver).unwrap(), "\"tookOver\"");
    }

    #[test]
    fn the_desks_ownership_carries_no_owner() {
        let desk = SessionOwnership {
            session_id: "s1".into(),
            owner: None,
            changed_by: None,
            reason: OwnerChange::Released,
            at: 5,
        };
        let json = serde_json::to_value(&desk).unwrap();
        assert!(json.get("owner").is_none());
        assert_eq!(serde_json::from_value::<SessionOwnership>(json).unwrap(), desk);
    }
}
