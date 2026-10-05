//! The attention request — the one deliberately stable API between the
//! Companion shell and a Workstation (ADR 0005).
//!
//! A Device asks `GetAttention`; the daemon asks the desktop (where the
//! signals live) and answers with the Workstation's state and the waiting
//! items. The request carries an explicit API version (`ATTENTION_API_VERSION`)
//! and the answer only ever grows by optional fields, so an older reader
//! that has never heard of a new field still parses.

use serde::{Deserialize, Serialize};

/// The attention API version this crate writes. Distinct from
/// `PROTOCOL_VERSION`: the shell pins this number across Workstation
/// builds, while the protocol version gates the request TYPE.
pub const ATTENTION_API_VERSION: u32 = 1;

/// What the shell draws for a Workstation on the hub.
///
/// `Asleep` is never on this wire: the shell infers it from the Relay
/// (the Mac is not answering). The Workstation itself only reports
/// whether its desktop app is ready to answer.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WorkstationState {
    Ready,
    DesktopAppNotRunning,
}

/// Why a waiting item is on the list.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AttentionKind {
    /// An agent is waiting on the human (a question on screen).
    Waiting,
    /// A card carries an open `Human test:` item.
    HumanTest,
    /// An agent failed.
    Failed,
    /// An agent was interrupted (daemon restart, sleep, …).
    Interrupted,
    /// A rail stopped (paused or stalled) and wants a look.
    RailStopped,
}

/// Where tapping the item should land.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum AttentionTarget {
    Session { id: String },
    Card { path: String },
}

/// One thing waiting on the human, anywhere on the Workstation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AttentionItem {
    pub id: String,
    /// Workspace id the item belongs to.
    pub workspace: String,
    pub kind: AttentionKind,
    /// Short text for the combined inbox row.
    pub text: String,
    pub target: AttentionTarget,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_older_reader_ignores_an_unknown_optional_field() {
        // A newer writer added `priority`. An older reader that has never
        // heard of it must still parse: growth is by optional fields only.
        let json = serde_json::json!({
            "id": "a1",
            "workspace": "w1",
            "kind": "waiting",
            "text": "needs you",
            "target": { "kind": "session", "id": "s1" },
            "priority": 3,
        });
        let item: AttentionItem = serde_json::from_value(json).unwrap();
        assert_eq!(item.id, "a1");
        assert_eq!(item.kind, AttentionKind::Waiting);
        assert_eq!(
            item.target,
            AttentionTarget::Session { id: "s1".into() }
        );
    }

    #[test]
    fn workstation_state_and_kinds_round_trip_as_kebab_case() {
        assert_eq!(
            serde_json::to_value(WorkstationState::DesktopAppNotRunning).unwrap(),
            serde_json::json!("desktop-app-not-running")
        );
        assert_eq!(
            serde_json::to_value(AttentionKind::HumanTest).unwrap(),
            serde_json::json!("human-test")
        );
        assert_eq!(
            serde_json::to_value(AttentionKind::RailStopped).unwrap(),
            serde_json::json!("rail-stopped")
        );
    }
}
