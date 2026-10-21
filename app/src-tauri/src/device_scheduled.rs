//! A Device's "Run now" on a Scheduled task (ADR 0003, ADR 0010).
//!
//! A run is the desk's: a headless session the desk window that runs the
//! workspace starts and records at the daemon (`scheduledState.ts`'s
//! `runScheduledNow`). The phone only asks, the way it asks for a commit
//! (`device_commit.rs`, whose wait this shares): the host tells the desk's
//! windows (`scheduled-run-now-requested`), the one that runs the
//! workspace does what its own button does and answers through
//! `answer_scheduled_run_now`, and a refusal -- the memory wall, a run
//! already going, an agent with no headless mode -- reaches the phone in
//! the desk's words.
//!
//! To the webviews only, never offered to Devices: the Device hears the
//! run itself through the list, which the daemon's push re-reads.

use crate::device_commit::{Answer, DeviceCommitRequests, ANSWER_BUDGET};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

/// What the desk's windows are told.
pub const REQUESTED: &str = "scheduled-run-now-requested";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Requested {
    id: u64,
    workspace_id: String,
    path: String,
}

/// A Device's Run now on the Scheduled task at `path`. Answers null once
/// the desk has started it; a refusal is the error.
#[tauri::command]
pub async fn scheduled_run_now_for_device(
    workspace_id: String,
    path: String,
    app_handle: AppHandle,
    requests: State<'_, DeviceCommitRequests>,
) -> Result<Value, String> {
    requests
        .ask(
            |id| {
                let _ = app_handle.emit(REQUESTED, Requested { id, workspace_id, path });
            },
            ANSWER_BUDGET,
        )
        .await
}

/// A desk window's answer to the ask `id` names.
#[tauri::command]
pub fn answer_scheduled_run_now(
    id: u64,
    answer: Answer,
    requests: State<'_, DeviceCommitRequests>,
) -> Result<(), String> {
    requests.settle(id, answer);
    Ok(())
}
