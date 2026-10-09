//! Where each Device is and what it is doing, read off the commands it has
//! the desktop run (companion-16).
//!
//! A Device does everything through `InvokeDesktop`, so the forwarded
//! command is the whole of what the daemon sees it do -- and the whole of
//! what it needs to. Most workspace commands name the desk's workspace
//! (`workspaceId`); the input commands name the session being typed into;
//! `create_session` answers with the id of the session the Device started,
//! its `workspaceId` names the workspace it was started in, and its
//! `workspaceAgent` says whether that was the workspace's own agent.
//! Nothing here asks the Device where it is, so a Companion that never
//! heard of presence has one all the same.
//!
//! Only a command the desktop ran without error counts. A refused name
//! never reaches this module, and neither does a desktop that is not
//! running: neither says where the Device is.
//!
//! In memory, like the refusals: a fact about the recent past, which the
//! other daemon sharing the trust store cannot see and has no need to.

use protocol::{DevicePresence, DeviceStartedSession, DeviceTyping, DEVICE_TYPING_REPUSH_SECS};
use serde_json::Value;
use std::collections::HashMap;

/// How many started sessions one Device's presence keeps. The desk places
/// each as it arrives; the list is for the Devices panel's account of what
/// the Device did, and for a desk that reloads to know which tabs to label.
pub const STARTED_KEPT: usize = 8;

/// The commands that send input to a session. `queue_input` counts: it is
/// the compose field's send, which is how the Companion types by default.
/// Also the commands a session's owner is held to (`ownership.rs`).
pub const INPUT_COMMANDS: &[&str] = &["write_input", "queue_input", "send_queued_input"];

#[derive(Default)]
pub struct Presences {
    by_device: HashMap<String, Tracked>,
}

#[derive(Default)]
struct Tracked {
    presence: DevicePresence,
    /// The `typing.at` the desk was last told, so continued typing into
    /// the same session is pushed on a cadence rather than per keystroke.
    typing_told_at: Option<i64>,
}

impl Presences {
    /// Records a command the desktop ran for `device_id` without error, and
    /// returns the presence to push -- or `None` when nothing the desk
    /// needs to hear has changed. The stored presence is updated either
    /// way, so a read always has the latest.
    ///
    /// `value` is what the desktop answered, read only for
    /// `create_session`'s session id.
    pub fn observe(
        &mut self,
        device_id: &str,
        command: &str,
        args: &Value,
        value: Option<&Value>,
        now: i64,
    ) -> Option<DevicePresence> {
        let tracked = self.by_device.entry(device_id.to_string()).or_default();
        let presence = &mut tracked.presence;
        let mut changed = false;

        if let Some(workspace_id) = text(args, "workspaceId") {
            if presence.workspace_id.as_deref() != Some(workspace_id) {
                presence.workspace_id = Some(workspace_id.to_string());
                changed = true;
            }
        }

        if INPUT_COMMANDS.contains(&command) {
            if let Some(session_id) = text(args, "sessionId") {
                let same = presence.typing.as_ref().is_some_and(|t| t.session_id == session_id);
                presence.typing = Some(DeviceTyping { session_id: session_id.to_string(), at: now });
                let due = tracked
                    .typing_told_at
                    .is_none_or(|told| now - told >= DEVICE_TYPING_REPUSH_SECS);
                if !same || due {
                    changed = true;
                }
            }
        }

        if command == "create_session" {
            if let Some(session_id) = value.and_then(Value::as_str).filter(|id| !id.is_empty()) {
                presence.started.retain(|s| s.session_id != session_id);
                presence.started.push(DeviceStartedSession {
                    session_id: session_id.to_string(),
                    workspace_id: text(args, "workspaceId").map(str::to_string),
                    workspace_root: text(args, "workspaceRoot").map(str::to_string),
                    cwd: text(args, "cwd").map(str::to_string),
                    workspace_agent: args.get("workspaceAgent").and_then(Value::as_bool) == Some(true),
                    at: now,
                });
                let over = presence.started.len().saturating_sub(STARTED_KEPT);
                presence.started.drain(..over);
                changed = true;
            }
        }

        // A Device that kills a session it started has taken it back; one
        // killed at the desk stays in the account, which is history.
        if command == "kill_session" {
            if let Some(session_id) = text(args, "sessionId") {
                let before = presence.started.len();
                presence.started.retain(|s| s.session_id != session_id);
                changed |= presence.started.len() != before;
            }
        }

        if !changed {
            return None;
        }
        tracked.typing_told_at = presence.typing.as_ref().map(|t| t.at);
        Some(presence.clone())
    }

    /// What is known of `device_id`, for `ListDevices`.
    pub fn get(&self, device_id: &str) -> Option<DevicePresence> {
        self.by_device.get(device_id).map(|t| t.presence.clone())
    }
}

/// A non-empty string argument, as the webview's `invoke` names it.
fn text<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn observe(p: &mut Presences, device: &str, command: &str, args: Value, now: i64) -> Option<DevicePresence> {
        p.observe(device, command, &args, None, now)
    }

    #[test]
    fn a_command_naming_a_workspace_puts_the_device_in_it() {
        let mut p = Presences::default();
        let pushed = observe(&mut p, "d1", "get_board", json!({"workspaceId": "w1"}), 100).unwrap();
        assert_eq!(pushed.workspace_id.as_deref(), Some("w1"));
        // The same workspace again is nothing new.
        assert_eq!(observe(&mut p, "d1", "git_status", json!({"workspaceId": "w1"}), 101), None);
        let moved = observe(&mut p, "d1", "get_board", json!({"workspaceId": "w2"}), 102).unwrap();
        assert_eq!(moved.workspace_id.as_deref(), Some("w2"));
    }

    #[test]
    fn a_command_naming_no_workspace_leaves_it_where_it_was() {
        let mut p = Presences::default();
        observe(&mut p, "d1", "get_board", json!({"workspaceId": "w1"}), 100);
        assert_eq!(observe(&mut p, "d1", "get_theme_pref", json!({}), 101), None);
        assert_eq!(observe(&mut p, "d1", "get_board", json!({"workspaceId": ""}), 102), None);
        assert_eq!(p.get("d1").unwrap().workspace_id.as_deref(), Some("w1"));
    }

    #[test]
    fn input_is_typing_into_that_session_and_pushed_on_a_cadence() {
        let mut p = Presences::default();
        let first = observe(&mut p, "d1", "write_input", json!({"sessionId": "s1", "data": "l"}), 100).unwrap();
        assert_eq!(first.typing, Some(DeviceTyping { session_id: "s1".into(), at: 100 }));
        // Keystrokes inside the cadence update the record without a push...
        assert_eq!(observe(&mut p, "d1", "write_input", json!({"sessionId": "s1", "data": "s"}), 101), None);
        assert_eq!(p.get("d1").unwrap().typing.unwrap().at, 101);
        // ...and the first one past it is pushed.
        let later = observe(
            &mut p,
            "d1",
            "write_input",
            json!({"sessionId": "s1", "data": "\r"}),
            100 + DEVICE_TYPING_REPUSH_SECS,
        )
        .unwrap();
        assert_eq!(later.typing.unwrap().at, 100 + DEVICE_TYPING_REPUSH_SECS);
    }

    #[test]
    fn typing_into_another_session_is_pushed_at_once() {
        let mut p = Presences::default();
        observe(&mut p, "d1", "write_input", json!({"sessionId": "s1", "data": "x"}), 100);
        let moved = observe(&mut p, "d1", "queue_input", json!({"sessionId": "s2", "text": "go on"}), 100).unwrap();
        assert_eq!(moved.typing.unwrap().session_id, "s2");
    }

    #[test]
    fn a_session_command_that_is_not_input_is_not_typing() {
        let mut p = Presences::default();
        assert_eq!(observe(&mut p, "d1", "resize_session", json!({"sessionId": "s1", "cols": 80, "rows": 24}), 100), None);
        assert_eq!(observe(&mut p, "d1", "session_screen", json!({"sessionId": "s1"}), 100), None);
        assert_eq!(p.get("d1").unwrap().typing, None);
    }

    #[test]
    fn create_session_records_the_session_the_desktop_answered() {
        let mut p = Presences::default();
        let args = json!({"cwd": "/work/app/src", "workspaceRoot": "/work/app", "command": "claude"});
        let pushed = p.observe("d1", "create_session", &args, Some(&json!("sess-1")), 200).unwrap();
        assert_eq!(
            pushed.started,
            vec![DeviceStartedSession {
                session_id: "sess-1".into(),
                workspace_id: None,
                workspace_root: Some("/work/app".into()),
                cwd: Some("/work/app/src".into()),
                workspace_agent: false,
                at: 200,
            }]
        );
    }

    /// A terminal in a workspace with no folder names no root and no cwd
    /// -- it opens in the home folder -- so the workspace's id is all the
    /// desk has to place it by.
    #[test]
    fn create_session_records_the_workspace_it_named() {
        let mut p = Presences::default();
        let args = json!({"workspaceId": "w-scratch"});
        let pushed = p.observe("d1", "create_session", &args, Some(&json!("sess-1")), 200).unwrap();
        let started = &pushed.started[0];
        assert_eq!(started.workspace_id.as_deref(), Some("w-scratch"));
        assert_eq!((started.workspace_root.as_deref(), started.cwd.as_deref()), (None, None));
        // The Device is in that workspace too, as for any command naming it.
        assert_eq!(pushed.workspace_id.as_deref(), Some("w-scratch"));
        // An empty id is no id.
        let args = json!({"workspaceId": ""});
        let pushed = p.observe("d1", "create_session", &args, Some(&json!("sess-2")), 201).unwrap();
        assert_eq!(pushed.started[1].workspace_id, None);
    }

    #[test]
    fn create_session_says_when_the_device_asked_for_the_workspace_agent() {
        let mut p = Presences::default();
        let args = json!({"cwd": "/work/app", "workspaceRoot": "/work/app", "workspaceAgent": true});
        let pushed = p.observe("d1", "create_session", &args, Some(&json!("sess-1")), 200).unwrap();
        assert!(pushed.started[0].workspace_agent);
        // Anything but a true is a plain start.
        let args = json!({"workspaceRoot": "/work/app", "workspaceAgent": "yes"});
        let pushed = p.observe("d1", "create_session", &args, Some(&json!("sess-2")), 201).unwrap();
        assert!(!pushed.started[1].workspace_agent);
    }

    #[test]
    fn a_create_session_with_no_id_starts_nothing() {
        let mut p = Presences::default();
        assert_eq!(p.observe("d1", "create_session", &json!({}), Some(&Value::Null), 200), None);
        assert_eq!(p.observe("d1", "create_session", &json!({}), None, 200), None);
        assert!(p.get("d1").unwrap().started.is_empty());
    }

    #[test]
    fn only_the_most_recent_started_sessions_are_kept() {
        let mut p = Presences::default();
        for i in 0..(STARTED_KEPT + 3) {
            p.observe("d1", "create_session", &json!({}), Some(&json!(format!("s{i}"))), i as i64);
        }
        let started = p.get("d1").unwrap().started;
        assert_eq!(started.len(), STARTED_KEPT);
        assert_eq!(started.first().unwrap().session_id, "s3");
        assert_eq!(started.last().unwrap().session_id, format!("s{}", STARTED_KEPT + 2));
    }

    #[test]
    fn a_device_killing_a_session_it_started_takes_it_off_the_list() {
        let mut p = Presences::default();
        p.observe("d1", "create_session", &json!({}), Some(&json!("s1")), 1);
        assert_eq!(observe(&mut p, "d1", "kill_session", json!({"sessionId": "other"}), 2), None);
        let pushed = observe(&mut p, "d1", "kill_session", json!({"sessionId": "s1"}), 3).unwrap();
        assert!(pushed.started.is_empty());
    }

    #[test]
    fn two_devices_are_tracked_apart() {
        let mut p = Presences::default();
        observe(&mut p, "a", "get_board", json!({"workspaceId": "w1"}), 1);
        observe(&mut p, "b", "write_input", json!({"sessionId": "s9", "data": "x"}), 1);
        let a = p.get("a").unwrap();
        let b = p.get("b").unwrap();
        assert_eq!((a.workspace_id.as_deref(), a.typing), (Some("w1"), None));
        assert_eq!(b.workspace_id, None);
        assert_eq!(b.typing.unwrap().session_id, "s9");
        assert_eq!(p.get("c"), None);
    }
}
