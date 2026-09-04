//! Extra app windows, one workspace at a time.
//!
//! Gavin shipped as a single window, and every part of the frontend that
//! shows a workspace assumed there was only one place it could be shown.
//! That assumption is what this module replaces with a rule:
//!
//!   **A workspace is on screen in exactly one window.**
//!
//! It is not a stylistic choice. Two panes over one PTY each report their
//! own cols/rows to the daemon, so the program inside would be resized
//! back and forth forever by two windows that both believe they own it.
//! Nothing about the daemon is per-window -- one connection, one Attach
//! per session, output broadcast to every webview -- so the only thing
//! that can keep two windows from fighting is deciding which of them a
//! workspace belongs to.
//!
//! This registry is that decision, and it is deliberately EPHEMERAL: a
//! workspace with no entry belongs to the main window, and every entry
//! disappears when its window does (including on quit). Windows are not
//! restored across launches -- the app comes back the way it always has,
//! one window holding everything, which is a state the user can always
//! reach and never has to be rescued from.

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// The label the app's first window always has -- Tauri's own default
/// for the window declared in tauri.conf.json, and the fallback owner of
/// every workspace no other window has claimed.
pub const MAIN_WINDOW_LABEL: &str = "main";

/// Prefix for a workspace window's label. The capability file grants
/// `ws-*` the same permissions as `main`; nothing else about the app
/// parses the label, so the suffix is for a human reading a log.
const WORKSPACE_WINDOW_PREFIX: &str = "ws-";

/// Where each workspace currently is: workspace id -> window label.
/// Absent means the main window.
#[derive(Default)]
pub struct WorkspaceWindows(pub Mutex<HashMap<String, String>>);

/// New windows cascade off the one that opened them rather than landing
/// exactly on top of it, so "it opened somewhere" is visible at a glance.
const CASCADE_OFFSET: f64 = 34.0;

fn snapshot(state: &WorkspaceWindows) -> HashMap<String, String> {
    state.0.lock().unwrap().clone()
}

/// Tells every window where the workspaces are now. Broadcast rather than
/// returned to the caller alone: the window that KEEPS a workspace has to
/// learn it lost it just as much as the one that took it, and the sidebar
/// in a third window has to stop offering to switch to it.
fn broadcast(app: &AppHandle, state: &WorkspaceWindows) {
    let _ = app.emit("workspace-windows-changed", snapshot(state));
}

/// The window a workspace is currently shown in.
fn owner(state: &WorkspaceWindows, workspace_id: &str) -> String {
    state
        .0
        .lock()
        .unwrap()
        .get(workspace_id)
        .cloned()
        .unwrap_or_else(|| MAIN_WINDOW_LABEL.to_string())
}

/// Where a new window should open: down-right of the window that asked
/// for it. Best-effort -- a failure to read the opener's geometry means
/// the new window centres itself, which is what a first window does.
fn cascade_from(app: &AppHandle, opener: &str) -> Option<(f64, f64)> {
    let window = app.get_webview_window(opener)?;
    let position = window.outer_position().ok()?;
    let scale = window.scale_factor().unwrap_or(1.0);
    Some((
        position.x as f64 / scale + CASCADE_OFFSET,
        position.y as f64 / scale + CASCADE_OFFSET,
    ))
}

/// Puts a workspace in a window of its own, and answers with the label of
/// the window that now holds it.
///
/// Idempotent by design: a workspace that already has a window is brought
/// to the front instead of being given a second one. That is what makes
/// this safe to wire behind "Open in New Window" on a row whose state the
/// menu may have read a moment ago -- the worst a stale click can do is
/// raise a window.
#[tauri::command]
pub fn open_workspace_window(
    workspace_id: String,
    app_handle: AppHandle,
    window: tauri::Window,
    state: tauri::State<WorkspaceWindows>,
) -> Result<String, String> {
    let label = format!("{WORKSPACE_WINDOW_PREFIX}{workspace_id}");
    // Its own window already, or a window it merely shares? The label is
    // derived from the workspace id, so only the FIRST is a reason to
    // stop: a workspace created inside somebody else's workspace window
    // is registered to that window and can still be given one of its own.
    if owner(&state, &workspace_id) == label {
        if let Some(open) = app_handle.get_webview_window(&label) {
            let _ = open.unminimize();
            let _ = open.set_focus();
            return Ok(label);
        }
        // The registry outlived its window (a destroy we never saw).
        // Drop the entry and fall through to building a fresh one rather
        // than handing the caller a label nothing answers to.
        state.0.lock().unwrap().remove(&workspace_id);
    }

    let mut builder = WebviewWindowBuilder::new(&app_handle, &label, WebviewUrl::default())
        .title("Gavin")
        .inner_size(1000.0, 700.0)
        .min_inner_size(800.0, 600.0)
        .decorations(false)
        .disable_drag_drop_handler();
    if let Some((x, y)) = cascade_from(&app_handle, window.label()) {
        builder = builder.position(x, y);
    } else {
        builder = builder.center();
    }
    let created = builder.build().map_err(|e| e.to_string())?;

    // The same chrome the main window gets in lib.rs's setup. A window
    // with square corners and a dead title-bar double-click would read as
    // a different app, not a second window of this one.
    //
    // Hopped onto the main thread, unlike lib.rs's copy, which is already
    // on it inside `setup`. A tauri command runs on a worker thread, and
    // both of these are AppKit: `setWantsLayer`/`layer()` off the main
    // thread tears the webview's layer backing out from under it and the
    // window comes up BLANK -- correctly sized, correctly positioned, and
    // completely empty. Found by opening one.
    #[cfg(target_os = "macos")]
    {
        let chrome = created.clone();
        let _ = app_handle.run_on_main_thread(move || {
            crate::mac_window::round_window_corners(&chrome, 10.0);
            crate::mac_window::install_edge_double_click(&chrome, 6.0);
        });
    }

    state.0.lock().unwrap().insert(workspace_id.clone(), label.clone());

    // Registered on the built window rather than through the builder: the
    // entry has to survive exactly as long as the window, and a window
    // closed by the OS (⌘W, the red button, a quit) emits Destroyed
    // without anything in the app having asked. Without this, a workspace
    // whose window is gone would be unreachable from every window that is
    // still open.
    let cleanup_app = app_handle.clone();
    let cleanup_label = label.clone();
    created.on_window_event(move |event| {
        if !matches!(event, WindowEvent::Destroyed) {
            return;
        }
        let state = cleanup_app.state::<WorkspaceWindows>();
        state.0.lock().unwrap().retain(|_, l| l != &cleanup_label);
        broadcast(&cleanup_app, &state);
    });

    broadcast(&app_handle, &state);
    Ok(label)
}

/// Records that a workspace belongs to the calling window.
///
/// For the two moments a workspace appears in a window without having
/// been handed to it: one created there, and one re-keyed onto a removed
/// workspace's id (the reclaim prompt). Both leave a window showing a
/// workspace the registry has never heard of, which the main window would
/// then believe is its own -- and both windows would draw its terminals.
///
/// A claim by the main window REMOVES the entry rather than storing
/// "main": absence is what "in the main window" means everywhere else,
/// and a second spelling of it is a second thing to keep correct.
#[tauri::command]
pub fn claim_workspace_window(
    workspace_id: String,
    app_handle: AppHandle,
    window: tauri::Window,
    state: tauri::State<WorkspaceWindows>,
) {
    {
        let mut map = state.0.lock().unwrap();
        if window.label() == MAIN_WINDOW_LABEL {
            map.remove(&workspace_id);
        } else {
            map.insert(workspace_id, window.label().to_string());
        }
    }
    broadcast(&app_handle, &state);
}

/// The whole map, for a window that has just loaded and has to find out
/// which workspaces are elsewhere -- and, if it is a workspace window,
/// which one is its own.
#[tauri::command]
pub fn workspace_windows(state: tauri::State<WorkspaceWindows>) -> HashMap<String, String> {
    snapshot(&state)
}

/// Raises the window a workspace is already in. What clicking that
/// workspace does anywhere in the app: it is on screen, just not here.
#[tauri::command]
pub fn focus_workspace_window(
    workspace_id: String,
    app_handle: AppHandle,
    state: tauri::State<WorkspaceWindows>,
) -> Result<(), String> {
    let label = owner(&state, &workspace_id);
    let window = app_handle
        .get_webview_window(&label)
        .ok_or_else(|| format!("no window labelled {label}"))?;
    window.unminimize().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

/// Closes the window a workspace lives in, if it has one of its own.
///
/// Called when the workspace itself goes away (the sidebar X, the delete
/// wizard): a window whose workspace no longer exists has nothing to
/// show. A no-op for a workspace in the main window -- removing a
/// workspace must never take the app down with it.
#[tauri::command]
pub fn close_workspace_window(
    workspace_id: String,
    app_handle: AppHandle,
    state: tauri::State<WorkspaceWindows>,
) -> Result<(), String> {
    let label = owner(&state, &workspace_id);
    if label == MAIN_WINDOW_LABEL {
        return Ok(());
    }
    // The registry entry is dropped by the Destroyed handler above, so
    // this only asks; it never bookkeeps.
    if let Some(window) = app_handle.get_webview_window(&label) {
        window.destroy().map_err(|e| e.to_string())?;
    } else {
        state.0.lock().unwrap().remove(&workspace_id);
        broadcast(&app_handle, &state);
    }
    Ok(())
}
