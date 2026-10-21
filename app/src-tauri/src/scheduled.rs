//! Scheduled tasks (v77, ADR 0010): the desk's commands over the daemon's
//! eight requests. Each is routed by its workspace like `card_runs`, and
//! awaits its lane, so no daemon round trip runs on the main thread.
//!
//! The daemon owns the copies and their run state; the app's scheduler
//! (`$lib/scheduling`) decides when a fire is due and launches it.

use crate::command_lane::DaemonLanes;
use crate::session::{lanes_for, CommandConnection, DaemonCompatState};
use protocol::scheduled::{FireClaim, ScheduledTask};
use protocol::{Request, Response};
use serde::Serialize;
use tauri::{AppHandle, State};

/// A fire's Run report and saved terminal, either absent.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledReportText {
    pub markdown: Option<String>,
    pub raw: Option<String>,
}

fn lanes(
    app_handle: &AppHandle,
    workspace_id: &str,
    state: &CommandConnection,
    compat: &DaemonCompatState,
) -> Result<DaemonLanes, String> {
    let route = crate::remote::route_for_workspace(app_handle, workspace_id)?;
    Ok(lanes_for(route, state, compat))
}

async fn ok(lanes: DaemonLanes, req: Request) -> Result<(), String> {
    match lanes.request(req).await.map_err(|e| e.to_string())? {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("expected Ok, got {other:?}")),
    }
}

async fn created(lanes: DaemonLanes, req: Request) -> Result<String, String> {
    match lanes.request(req).await.map_err(|e| e.to_string())? {
        Response::ScheduledTaskCreated { path } => Ok(path),
        Response::Error { message } => Err(message),
        other => Err(format!("expected ScheduledTaskCreated, got {other:?}")),
    }
}

/// Every Scheduled task of a workspace, with its run state.
#[tauri::command]
pub async fn list_scheduled_tasks(
    workspace_id: String,
    root_path: String,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<Vec<ScheduledTask>, String> {
    let lanes = lanes(&app_handle, &workspace_id, &state, &compat)?;
    match lanes.request(Request::ListScheduledTasks { root_path }).await.map_err(|e| e.to_string())? {
        Response::ScheduledTasks { tasks } => Ok(tasks),
        Response::Error { message } => Err(message),
        other => Err(format!("expected ScheduledTasks, got {other:?}")),
    }
}

/// Copies a task card into a new Scheduled task (`from_card`), or writes
/// one from scratch (`title` + `body`). Answers with its path.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn create_scheduled_task(
    workspace_id: String,
    root_path: String,
    from_card: Option<String>,
    title: Option<String>,
    body: Option<String>,
    schedule: Option<String>,
    agent: Option<String>,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<String, String> {
    let lanes = lanes(&app_handle, &workspace_id, &state, &compat)?;
    created(lanes, Request::CreateScheduledTask { root_path, from_card, title, body, schedule, agent }).await
}

/// Rewrites one field of a Scheduled task (`title`, `agent`, `model`,
/// `effort`, `complexity`, `schedule`, `paused`, `body`).
#[tauri::command]
pub async fn set_scheduled_task_field(
    workspace_id: String,
    path: String,
    key: String,
    value: String,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<(), String> {
    let lanes = lanes(&app_handle, &workspace_id, &state, &compat)?;
    ok(lanes, Request::SetScheduledTaskField { path, key, value }).await
}

#[tauri::command]
pub async fn duplicate_scheduled_task(
    workspace_id: String,
    path: String,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<String, String> {
    let lanes = lanes(&app_handle, &workspace_id, &state, &compat)?;
    created(lanes, Request::DuplicateScheduledTask { path }).await
}

#[tauri::command]
pub async fn delete_scheduled_task(
    workspace_id: String,
    path: String,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<(), String> {
    let lanes = lanes(&app_handle, &workspace_id, &state, &compat)?;
    ok(lanes, Request::DeleteScheduledTask { path }).await
}

/// Claims one fire at the daemon -- the scheduler's half, and Run now's.
/// Only a claim that comes back `claimed` with no `skipped` may launch.
#[tauri::command]
pub async fn claim_scheduled_fire(
    workspace_id: String,
    path: String,
    slot: Option<u64>,
    stamp: String,
    skip_reason: Option<String>,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<FireClaim, String> {
    let lanes = lanes(&app_handle, &workspace_id, &state, &compat)?;
    let req = Request::ClaimScheduledFire { path, slot, stamp, skip_reason };
    match lanes.request(req).await.map_err(|e| e.to_string())? {
        Response::ScheduledFireClaimed { claim } => Ok(claim),
        Response::Error { message } => Err(message),
        other => Err(format!("expected ScheduledFireClaimed, got {other:?}")),
    }
}

#[tauri::command]
pub async fn record_scheduled_launch(
    workspace_id: String,
    fire_id: i64,
    session_id: Option<String>,
    error: Option<String>,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<(), String> {
    let lanes = lanes(&app_handle, &workspace_id, &state, &compat)?;
    ok(lanes, Request::RecordScheduledLaunch { fire_id, session_id, error }).await
}

#[tauri::command]
pub async fn scheduled_report(
    workspace_id: String,
    fire_id: i64,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<ScheduledReportText, String> {
    let lanes = lanes(&app_handle, &workspace_id, &state, &compat)?;
    match lanes.request(Request::ScheduledReport { fire_id }).await.map_err(|e| e.to_string())? {
        Response::ScheduledReportText { markdown, raw } => Ok(ScheduledReportText { markdown, raw }),
        Response::Error { message } => Err(message),
        other => Err(format!("expected ScheduledReportText, got {other:?}")),
    }
}
