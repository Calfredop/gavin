//! A Device's "Commit via agent" (ADR 0003: the Companion drives the
//! desktop app).
//!
//! The run is the desk's: a hidden agent session a desk window starts,
//! writes down in the workspace's Git prefs and watches to a verdict
//! (`gitState.ts`'s `commitViaAgent`). A Device only asks for it, as Start
//! only arms a rail. So `agent_commit_for_device` tells the desk's windows
//! (`agent-commit-requested`) and waits; the window that runs the
//! workspace -- or, for a Stop, the one watching that run -- does what its
//! own button does and answers through `answer_agent_commit_request`, and
//! that answer is the Device's result. A press the desk refuses (the
//! launch wall, nothing to commit, an agent with no headless mode) is said
//! on the phone in the desk's words instead of going dead.
//!
//! To the webviews only, never offered to Devices: it is a question for
//! the desk, and the Device hears the run itself through the record the
//! desk writes, which reaches it as `workspaces-synced`.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;

/// What the desk's windows are told.
pub const REQUESTED: &str = "agent-commit-requested";

/// How long a Device's ask waits for a window. Starting the run is a
/// session spawn and a config write, a second or two; well inside the
/// daemon's own wait on a forwarded command (`forwarding::DISPATCH_BUDGET`),
/// so a window that never answers is reported as that, not as a timeout
/// of the forwarding connection.
const ANSWER_BUDGET: Duration = Duration::from_secs(30);

const NO_ANSWER: &str =
    "No gavin window on the Workstation answered. Try again once its window has loaded.";

/// The asks waiting for a window's answer, by id.
#[derive(Default)]
pub struct DeviceCommitRequests {
    next: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Answer>>>,
}

/// A window's answer: why not, or what to hand the Device.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    #[serde(default)]
    refused: Option<String>,
    #[serde(default)]
    value: Value,
}

/// What the windows are told: a run in `cwd`, or a Stop for `session_id`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Requested {
    id: u64,
    workspace_id: String,
    action: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
}

impl DeviceCommitRequests {
    /// Opens an ask: its id, and where its answer will land. Registered
    /// before anybody is told, so an answer cannot beat it.
    fn open(&self) -> (u64, oneshot::Receiver<Answer>) {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        (id, rx)
    }

    /// Hands `answer` to the ask `id` names. The first answer is the one
    /// taken; a second, or one for an ask that has stopped waiting, is
    /// dropped.
    fn settle(&self, id: u64, answer: Answer) {
        if let Some(tx) = self.pending.lock().unwrap().remove(&id) {
            let _ = tx.send(answer);
        }
    }

    /// Tells the windows through `announce` and waits up to `budget` for
    /// one to answer.
    async fn ask(&self, announce: impl FnOnce(u64), budget: Duration) -> Result<Value, String> {
        let (id, answer) = self.open();
        announce(id);
        match tokio::time::timeout(budget, answer).await {
            Ok(Ok(Answer { refused: Some(why), .. })) => Err(why),
            Ok(Ok(Answer { value, .. })) => Ok(value),
            Ok(Err(_)) => Err(NO_ANSWER.to_string()),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(NO_ANSWER.to_string())
            }
        }
    }
}

/// A Device's "Commit via agent": `start` a run in `cwd`, or `stop` the
/// run `session_id` names. Answers a start with the hidden session the desk
/// began (`{ sessionId, startedAt }`) and a stop with null; a refusal is
/// the error, in the desk's words.
#[tauri::command]
pub async fn agent_commit_for_device(
    workspace_id: String,
    action: String,
    cwd: Option<String>,
    session_id: Option<String>,
    app_handle: AppHandle,
    requests: State<'_, DeviceCommitRequests>,
) -> Result<Value, String> {
    let action = match (action.as_str(), &cwd, &session_id) {
        ("start", Some(_), _) => "start",
        ("stop", _, Some(_)) => "stop",
        _ => return Err(format!("not a commit request: {action}")),
    };
    requests
        .ask(
            |id| {
                let requested = Requested { id, workspace_id, action, cwd, session_id };
                let _ = app_handle.emit(REQUESTED, requested);
            },
            ANSWER_BUDGET,
        )
        .await
}

/// A desk window's answer to the ask `id` names.
#[tauri::command]
pub fn answer_agent_commit_request(
    id: u64,
    answer: Answer,
    requests: State<'_, DeviceCommitRequests>,
) -> Result<(), String> {
    requests.settle(id, answer);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn answer(raw: Value) -> Answer {
        serde_json::from_value(raw).expect("an answer")
    }

    const SOON: Duration = Duration::from_secs(5);

    #[test]
    fn a_windows_answer_is_the_devices_result() {
        let requests = DeviceCommitRequests::default();
        let started = json!({ "sessionId": "agent-1", "startedAt": 5 });
        let got = tauri::async_runtime::block_on(
            requests.ask(|id| requests.settle(id, answer(json!({ "value": started.clone() }))), SOON),
        );
        assert_eq!(got, Ok(started));
    }

    #[test]
    fn a_refusal_comes_back_in_the_desks_words() {
        let requests = DeviceCommitRequests::default();
        let got = tauri::async_runtime::block_on(
            requests.ask(|id| requests.settle(id, answer(json!({ "refused": "Nothing to commit" }))), SOON),
        );
        assert_eq!(got, Err("Nothing to commit".to_string()));
    }

    #[test]
    fn a_stop_on_its_way_is_answered_with_nothing() {
        let requests = DeviceCommitRequests::default();
        let got = tauri::async_runtime::block_on(requests.ask(|id| requests.settle(id, answer(json!({}))), SOON));
        assert_eq!(got, Ok(Value::Null));
    }

    #[test]
    fn the_first_answer_is_taken_and_a_stray_one_is_dropped() {
        let requests = DeviceCommitRequests::default();
        let got = tauri::async_runtime::block_on(requests.ask(
            |id| {
                requests.settle(id + 100, answer(json!({ "refused": "not this one" })));
                requests.settle(id, answer(json!({ "value": 1 })));
                requests.settle(id, answer(json!({ "value": 2 })));
            },
            SOON,
        ));
        assert_eq!(got, Ok(json!(1)));
        assert!(requests.pending.lock().unwrap().is_empty());
    }

    #[test]
    fn an_ask_nobody_answers_says_so_and_stops_waiting() {
        let requests = DeviceCommitRequests::default();
        let got = tauri::async_runtime::block_on(requests.ask(|_| {}, Duration::from_millis(20)));
        assert_eq!(got, Err(NO_ANSWER.to_string()));
        assert!(requests.pending.lock().unwrap().is_empty());
    }

    #[test]
    fn the_windows_are_told_in_the_shape_the_desk_reads() {
        let start = Requested {
            id: 3,
            workspace_id: "ws".into(),
            action: "start",
            cwd: Some("/r".into()),
            session_id: None,
        };
        assert_eq!(
            serde_json::to_value(start).unwrap(),
            json!({ "id": 3, "workspaceId": "ws", "action": "start", "cwd": "/r" })
        );
        let stop = Requested {
            id: 4,
            workspace_id: "ws".into(),
            action: "stop",
            cwd: None,
            session_id: Some("agent-1".into()),
        };
        assert_eq!(
            serde_json::to_value(stop).unwrap(),
            json!({ "id": 4, "workspaceId": "ws", "action": "stop", "sessionId": "agent-1" })
        );
    }
}
