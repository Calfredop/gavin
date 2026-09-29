use crate::command_lane::{CommandLane, DaemonLanes, Redial};
use crate::config::Workspace;
use crate::layout::LayoutNode;
use crate::stream_writer::StreamWriter;
use protocol::{
    read_message, socket_path, write_message, Board, CardRun, CardSession, Column, ConflictNote,
    GroupTemplate, Label, Orchestration, Rail, Request, Response, ToolDef, ToolRun,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::BufReader;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use protocol::transport::Stream;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct DaemonConnection {
    writer: StreamWriter,
    /// Set while `reconnect` swaps the daemon underneath this connection,
    /// for the same reason a command lane has one: a keystroke then fails
    /// at once rather than riding a socket to the daemon being killed.
    /// The restart used to hold the main thread for its whole length, so
    /// no keystroke could reach this connection meanwhile; now one can.
    swapping: std::sync::atomic::AtomicBool,
}

impl DaemonConnection {
    fn new(writer: StreamWriter) -> DaemonConnection {
        DaemonConnection { writer, swapping: std::sync::atomic::AtomicBool::new(false) }
    }

    /// Whether a request from a command may go down this connection now.
    /// `reconnect`'s own writes -- the Attach per session, the watch per
    /// workspace -- use the writer directly and are never refused.
    fn admit(&self) -> anyhow::Result<()> {
        if self.swapping.load(std::sync::atomic::Ordering::SeqCst) {
            anyhow::bail!("the gavin daemon is restarting — try again in a moment");
        }
        Ok(())
    }
}

/// The frontend's whole view of workspace/page state, sent over IPC (the
/// return value of `get_workspaces_state`, and the payload of the
/// `workspaces-ready` event). camelCase to match the frontend's TypeScript
/// naming -- the same reason `Workspace`/`Page` themselves use it, and the
/// same reason `LayoutNode` already renames `active_tab_index`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacesData {
    pub workspaces: Vec<Workspace>,
    pub active_workspace_id: Option<String>,
    /// Tombstones for workspaces the sidebar X removed, newest first.
    /// Carried HERE rather than as a seventh `persist_workspaces`
    /// argument on purpose: the list crosses to the frontend with the
    /// workspaces it belongs to, and a field on the record that is
    /// already passed by reference cannot be forgotten at a save site the
    /// way session_names/file_tabs/theme/agent_models each were in turn.
    pub removed_workspaces: Vec<crate::config::RemovedWorkspace>,
}

pub struct WorkspacesState(pub Mutex<WorkspacesData>);

/// User-assigned session display names, keyed by session id. Independent
/// Tauri-managed state from `WorkspacesState`/`FileTabs`, but all three
/// persist into the same `AppConfig` -- every command that saves one must
/// read the others' current values too (see `set_workspaces_state`/
/// `set_session_name`/`set_file_tabs`), or it would silently reset the
/// other fields to empty on every save.
pub struct SessionNames(pub Mutex<HashMap<String, String>>);

/// Persists workspace/page state, session names, and file tabs together --
/// the three things that make up AppConfig. Centralizing this is what
/// makes the "always carry the others along, or you'll silently reset one"
/// rule (see SessionNames's doc comment) structural rather than just
/// documented: every save site funnels through here instead of each
/// independently reconstructing the AppConfig literal.
/// `pub(crate)` so `typesafe.rs` can prove the one thing this function
/// does NOT take as an argument survives it (`AppConfig::typesafe`).
pub(crate) fn persist_workspaces(
    config_dir: &std::path::Path,
    data: &WorkspacesData,
    session_names: HashMap<String, String>,
    file_tabs: HashMap<String, String>,
    board_tabs: HashMap<String, crate::config::BoardTabRecord>,
    // Safe beside board_tabs for the reason `superpowers` spells out
    // below: its value type is not `BoardTabRecord`, so transposing the
    // two is a compile error rather than a silently swapped map.
    card_tabs: HashMap<String, crate::config::CardTabRecord>,
    theme: Option<String>,
    // Last, and deliberately not beside file_tabs/board_tabs: three
    // same-shaped maps in a row is an argument list you can transpose
    // without the compiler noticing.
    agent_models: HashMap<String, String>,
    terminal_font_size: Option<u16>,
    auto_commit: Option<bool>,
    // Safe as a positional despite the warning above: `Option<AgentPauseConfig>`
    // shares a shape with nothing else here, so a transposition is a type
    // error rather than a silent swap.
    agent_pause: Option<crate::config::AgentPauseConfig>,
    // Safe to sit beside them only because its value type is not String:
    // transposing it with any of the three above is a type error, which
    // is the guarantee the comment on `agent_models` had to ask for in
    // prose.
    superpowers: HashMap<String, crate::config::SuperpowersMark>,
    // The custom agent's command and flag plus the complexity table, in
    // one struct rather than three positionals -- see
    // `AgentDefaultsConfig`. Its type is shared with nothing else here,
    // so a transposition is a type error rather than a silent swap.
    agent_defaults: crate::config::AgentDefaultsConfig,
    // Ninth, and safe as a positional for the reason its own type
    // comment gives: `GitTrackingDefault` wraps the `Option<bool>` that
    // would otherwise be indistinguishable from `auto_commit` above.
    git_tracking: crate::config::GitTrackingDefault,
    // Tenth, and wrapped for the same reason `git_tracking` is: a bare
    // `Option<bool>` here would sit beside `auto_commit` with exactly the
    // same shape, and the two are unrelated settings.
    require_review: crate::config::RequireReviewDefault,
    // Thirteenth to arrive, and beside its sibling rather than last: it
    // is the same kind of setting as `require_review`, and wrapped for
    // the same reason -- `HeadroomDefault` is a type nothing else here
    // has, so a transposition is a compile error.
    headroom: crate::config::HeadroomDefault,
    // Eleventh. `Option<LaunchConfig>` shares a shape with nothing else in
    // this list, so a transposition is a type error rather than a
    // silently swapped value -- the same guarantee `agent_pause` above
    // relies on.
    launch: Option<crate::config::LaunchConfig>,
    // Twelfth. `Option<String>` shares a shape with `theme` above, but
    // the two are never adjacent in this list, so a transposition
    // between them is still a type error at the call site (theme is
    // bound long before this parameter).
    custom_resume_args: Option<String>,
) -> anyhow::Result<()> {
    // The thirteenth app-wide field, and the one that is NOT a parameter
    // above: the TypeSafe key and toggle are read back off the file and
    // written straight through. See `AppConfig::typesafe` for why a
    // secret stays out of the in-memory mirror every window saves from,
    // and why a thirteenth same-shaped positional on this particular
    // argument list was the worse of the two risks.
    //
    // A config that will not parse yields `None` here -- but that save
    // was going to overwrite every other field with defaults anyway, so
    // this loses nothing the rest of the function was not already
    // losing.
    let typesafe = crate::config::load(config_dir).ok().and_then(|c| c.typesafe);
    crate::config::save(
        config_dir,
        &crate::config::AppConfig {
            typesafe,
            workspaces: data.workspaces.clone(),
            active_workspace_id: data.active_workspace_id.clone(),
            session_names,
            file_tabs,
            board_tabs,
            card_tabs,
            theme,
            agent_models,
            terminal_font_size,
            auto_commit,
            removed_workspaces: data.removed_workspaces.clone(),
            agent_pause,
            superpowers,
            agent_defaults,
            git_tracking,
            require_review,
            headroom,
            launch,
            custom_resume_args,
        },
    )
}

/// Open file-viewer tabs (tab id -> absolute path). Independent
/// Tauri-managed state from `WorkspacesState`/`SessionNames`, but all
/// three persist into the same `AppConfig` -- every command that saves one
/// must read the others' current values too, or it would silently reset
/// them to empty on every save.
pub struct FileTabs(pub Mutex<HashMap<String, String>>);

/// App-wide default model per agent profile id. Tauri-managed like
/// `ThemePref`, and persisted into the same `AppConfig` -- so every
/// command that saves must carry it along, exactly as `SessionNames`
/// describes.
pub struct AgentModels(pub Mutex<HashMap<String, String>>);

/// The app-wide agent pause cycle, `None` for no cycle at all.
/// Tauri-managed and persisted into the same `AppConfig` as the rest --
/// the seventh field a save site can silently wipe, and carried through
/// `persist_workspaces` for exactly that reason.
pub struct AgentPause(pub Mutex<Option<crate::config::AgentPauseConfig>>);

#[tauri::command]
pub fn get_agent_pause(state: State<AgentPause>) -> Option<crate::config::AgentPauseConfig> {
    state.0.lock().unwrap().clone()
}

/// Replaces the app-wide cycle. `None` clears it back to no cycle at
/// all, the same "there is no separate clear command" shape as
/// `set_theme_pref`.
///
/// The ANCHOR is the caller's to supply and gavin never rewrites it here:
/// the frontend stamps one when the cycle is first switched on, and every
/// later edit carries the same value through. Stamping `now` on each save
/// would slide the pause forward every time somebody nudged a field, so
/// the cycle would never actually fire for anyone who kept adjusting it.
#[tauri::command]
pub fn set_agent_pause(
    agent_pause: Option<crate::config::AgentPauseConfig>,
    app_handle: AppHandle,
    state: State<WorkspacesState>,
    names_state: State<SessionNames>,
    file_tabs_state: State<FileTabs>,
    board_tabs_state: State<BoardTabs>,
    card_tabs_state: State<CardTabs>,
    theme_state: State<ThemePref>,
    agent_models_state: State<AgentModels>,
    font_size_state: State<TerminalFontSize>,
    auto_commit_state: State<AutoCommit>,
    agent_pause_state: State<AgentPause>,
    superpowers_state: State<SuperpowersMarks>,
    agent_defaults_state: State<AgentDefaults>,
    git_tracking_state: State<GitTrackingDefaults>,
    require_review_state: State<RequireReviewDefaults>,
    headroom_state: State<HeadroomDefaults>,
    launch_state: State<LaunchSettings>,
    custom_resume_args_state: State<CustomResumeArgs>,
) -> Result<(), String> {
    *agent_pause_state.0.lock().unwrap() = agent_pause.clone();
    let data = state.0.lock().unwrap().clone();
    let session_names = names_state.0.lock().unwrap().clone();
    let file_tabs = file_tabs_state.0.lock().unwrap().clone();
    let board_tabs = board_tabs_state.0.lock().unwrap().clone();
    let card_tabs = card_tabs_state.0.lock().unwrap().clone();
    let theme = theme_state.0.lock().unwrap().clone();
    let agent_models = agent_models_state.0.lock().unwrap().clone();
    let superpowers = superpowers_state.0.lock().unwrap().clone();
    let agent_defaults = agent_defaults_state.0.lock().unwrap().clone();
    let git_tracking = *git_tracking_state.0.lock().unwrap();
    let require_review = *require_review_state.0.lock().unwrap();
    let headroom = *headroom_state.0.lock().unwrap();
    let launch = *launch_state.0.lock().unwrap();
    let custom_resume_args = custom_resume_args_state.0.lock().unwrap().clone();
    let terminal_font_size = *font_size_state.0.lock().unwrap();
    let auto_commit = *auto_commit_state.0.lock().unwrap();
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    persist_workspaces(
        &config_dir,
        &data,
        session_names,
        file_tabs,
        board_tabs,
        card_tabs,
        theme,
        agent_models,
        terminal_font_size,
        auto_commit,
        agent_pause,
        superpowers,
        agent_defaults,
        git_tracking,
        require_review,
        headroom,
        launch,
        custom_resume_args,
    )
    .map_err(|e| e.to_string())
}
/// The app-wide launch wall, `None` until somebody edits it (the shipped
/// `LaunchConfig::default()` then applies). Tauri-managed and persisted
/// into the same `AppConfig` as the rest -- the TENTH field a save site
/// can silently wipe, and carried through `persist_workspaces` for
/// exactly that reason.
pub struct LaunchSettings(pub Mutex<Option<crate::config::LaunchConfig>>);

#[tauri::command]
pub fn get_launch_config(state: State<LaunchSettings>) -> Option<crate::config::LaunchConfig> {
    *state.0.lock().unwrap()
}

/// Replaces the app-wide launch wall wholesale, the same shape as
/// `set_agent_pause` and `set_agent_defaults`: the panel edits both
/// fields and hands them back, so there is no per-key command and no way
/// for one of them to be saved while the other is dropped.
///
/// `None` clears it back to the shipped default rather than to "no
/// ceiling" -- there is no way to express "off" except by clearing the
/// ceiling itself, which is `Some(LaunchConfig { max_in_flight: None, .. })`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn set_launch_config(
    launch: Option<crate::config::LaunchConfig>,
    app_handle: AppHandle,
    state: State<WorkspacesState>,
    names_state: State<SessionNames>,
    file_tabs_state: State<FileTabs>,
    board_tabs_state: State<BoardTabs>,
    card_tabs_state: State<CardTabs>,
    theme_state: State<ThemePref>,
    agent_models_state: State<AgentModels>,
    font_size_state: State<TerminalFontSize>,
    auto_commit_state: State<AutoCommit>,
    agent_pause_state: State<AgentPause>,
    superpowers_state: State<SuperpowersMarks>,
    agent_defaults_state: State<AgentDefaults>,
    git_tracking_state: State<GitTrackingDefaults>,
    require_review_state: State<RequireReviewDefaults>,
    headroom_state: State<HeadroomDefaults>,
    launch_state: State<LaunchSettings>,
    custom_resume_args_state: State<CustomResumeArgs>,
) -> Result<(), String> {
    *launch_state.0.lock().unwrap() = launch;
    let custom_resume_args = custom_resume_args_state.0.lock().unwrap().clone();
    let data = state.0.lock().unwrap().clone();
    let session_names = names_state.0.lock().unwrap().clone();
    let file_tabs = file_tabs_state.0.lock().unwrap().clone();
    let board_tabs = board_tabs_state.0.lock().unwrap().clone();
    let card_tabs = card_tabs_state.0.lock().unwrap().clone();
    let theme = theme_state.0.lock().unwrap().clone();
    let agent_models = agent_models_state.0.lock().unwrap().clone();
    let superpowers = superpowers_state.0.lock().unwrap().clone();
    let agent_defaults = agent_defaults_state.0.lock().unwrap().clone();
    let git_tracking = *git_tracking_state.0.lock().unwrap();
    let require_review = *require_review_state.0.lock().unwrap();
    let headroom = *headroom_state.0.lock().unwrap();
    let agent_pause = agent_pause_state.0.lock().unwrap().clone();
    let terminal_font_size = *font_size_state.0.lock().unwrap();
    let auto_commit = *auto_commit_state.0.lock().unwrap();
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    persist_workspaces(
        &config_dir,
        &data,
        session_names,
        file_tabs,
        board_tabs,
        card_tabs,
        theme,
        agent_models,
        terminal_font_size,
        auto_commit,
        agent_pause,
        superpowers,
        agent_defaults,
        git_tracking,
        require_review,
        headroom,
        launch,
        custom_resume_args,
    )
    .map_err(|e| e.to_string())
}

/// The app-wide resume flag for the `custom` agent profile (v38), `None`
/// until somebody sets one -- and, absent an app-wide value, `custom`
/// simply has no resume argv, the same "no verified convention" posture
/// `AgentProfile::resume_args` takes for an unconfigured row. Tauri-
/// managed and persisted into the same `AppConfig` as the rest -- the
/// TWELFTH field a save site can silently wipe, and carried through
/// `persist_workspaces` for exactly that reason.
pub struct CustomResumeArgs(pub Mutex<Option<String>>);

#[tauri::command]
pub fn get_custom_resume_args(state: State<CustomResumeArgs>) -> Option<String> {
    state.0.lock().unwrap().clone()
}

/// Replaces the app-wide `custom` resume flag, the same shape as
/// `set_launch_config`: this workspace's OWN override
/// (`Workspace::custom_resume_args`) lives on the ordinary workspaces
/// save instead, since it travels with `WorkspacesState` like `color` or
/// `terminal_font_size` do.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn set_custom_resume_args(
    custom_resume_args: Option<String>,
    app_handle: AppHandle,
    state: State<WorkspacesState>,
    names_state: State<SessionNames>,
    file_tabs_state: State<FileTabs>,
    board_tabs_state: State<BoardTabs>,
    card_tabs_state: State<CardTabs>,
    theme_state: State<ThemePref>,
    agent_models_state: State<AgentModels>,
    font_size_state: State<TerminalFontSize>,
    auto_commit_state: State<AutoCommit>,
    agent_pause_state: State<AgentPause>,
    superpowers_state: State<SuperpowersMarks>,
    agent_defaults_state: State<AgentDefaults>,
    git_tracking_state: State<GitTrackingDefaults>,
    require_review_state: State<RequireReviewDefaults>,
    headroom_state: State<HeadroomDefaults>,
    launch_state: State<LaunchSettings>,
    custom_resume_args_state: State<CustomResumeArgs>,
) -> Result<(), String> {
    *custom_resume_args_state.0.lock().unwrap() = custom_resume_args.clone();
    let data = state.0.lock().unwrap().clone();
    let session_names = names_state.0.lock().unwrap().clone();
    let file_tabs = file_tabs_state.0.lock().unwrap().clone();
    let board_tabs = board_tabs_state.0.lock().unwrap().clone();
    let card_tabs = card_tabs_state.0.lock().unwrap().clone();
    let theme = theme_state.0.lock().unwrap().clone();
    let agent_models = agent_models_state.0.lock().unwrap().clone();
    let superpowers = superpowers_state.0.lock().unwrap().clone();
    let agent_defaults = agent_defaults_state.0.lock().unwrap().clone();
    let git_tracking = *git_tracking_state.0.lock().unwrap();
    let require_review = *require_review_state.0.lock().unwrap();
    let headroom = *headroom_state.0.lock().unwrap();
    let agent_pause = agent_pause_state.0.lock().unwrap().clone();
    let terminal_font_size = *font_size_state.0.lock().unwrap();
    let auto_commit = *auto_commit_state.0.lock().unwrap();
    let launch = *launch_state.0.lock().unwrap();
    let custom_resume_args = custom_resume_args_state.0.lock().unwrap().clone();
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    persist_workspaces(
        &config_dir,
        &data,
        session_names,
        file_tabs,
        board_tabs,
        card_tabs,
        theme,
        agent_models,
        terminal_font_size,
        auto_commit,
        agent_pause,
        superpowers,
        agent_defaults,
        git_tracking,
        require_review,
        headroom,
        launch,
        custom_resume_args,
    )
    .map_err(|e| e.to_string())
}

/// The human's Superpowers word per workspace root. Same carry-through
/// contract as `AgentModels` above; the value type differs from the
/// String maps so a transposed argument is a compile error rather than a
/// silently wiped field.
pub struct SuperpowersMarks(pub Mutex<HashMap<String, crate::config::SuperpowersMark>>);

/// The app-wide custom agent (command + model flag) and the complexity
/// table. Tauri-managed and persisted into the same `AppConfig` as the
/// rest -- the eighth field a save site can silently wipe, and carried
/// through `persist_workspaces` for exactly that reason.
pub struct AgentDefaults(pub Mutex<crate::config::AgentDefaultsConfig>);

/// The app-wide git-tracking default. Tauri-managed and persisted into the
/// same `AppConfig` as the rest -- the ninth field a save site can silently
/// wipe, and carried through `persist_workspaces` for exactly that reason.
///
/// A default for INITIALISATION only. What a workspace that already exists
/// does is written in its own repo's `.gitignore` and read back from git
/// (`git::tracking`), so there is nothing per-workspace to keep here and
/// nothing that can drift out of step with the file.
pub struct GitTrackingDefaults(pub Mutex<crate::config::GitTrackingDefault>);

/// The app-wide default for whether a card must be reviewed before its
/// first Run. Tauri-managed and persisted into the same `AppConfig` as the
/// rest -- the tenth field a save site can silently wipe, and carried
/// through `persist_workspaces` for exactly that reason.
///
/// Live, unlike `GitTrackingDefaults` one field up: a workspace with no
/// override of its own resolves against whatever this holds at the moment
/// of the check (`cardReview.ts`'s gate), not a value copied in at init.
pub struct RequireReviewDefaults(pub Mutex<crate::config::RequireReviewDefault>);

/// The app-wide default for whether agents are compressed through
/// Headroom. Tauri-managed and persisted into the same `AppConfig` as
/// the rest, and carried through `persist_workspaces` like them.
///
/// Live, like `RequireReviewDefaults` above: a workspace with no
/// override of its own resolves against whatever this holds at the
/// moment it is resolved (`headroom/compression.ts`), and what the
/// daemon is told follows from that.
pub struct HeadroomDefaults(pub Mutex<crate::config::HeadroomDefault>);

#[tauri::command]
pub fn get_agent_defaults(state: State<AgentDefaults>) -> crate::config::AgentDefaultsConfig {
    state.0.lock().unwrap().clone()
}

/// Replaces the app-wide agent defaults wholesale, the same shape as
/// `set_agent_pause`: the panel edits a whole struct and hands it back,
/// so there is no per-key command and no way for one field of it to be
/// saved while another is dropped.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn set_agent_defaults(
    agent_defaults: crate::config::AgentDefaultsConfig,
    app_handle: AppHandle,
    state: State<WorkspacesState>,
    names_state: State<SessionNames>,
    file_tabs_state: State<FileTabs>,
    board_tabs_state: State<BoardTabs>,
    card_tabs_state: State<CardTabs>,
    theme_state: State<ThemePref>,
    agent_models_state: State<AgentModels>,
    font_size_state: State<TerminalFontSize>,
    auto_commit_state: State<AutoCommit>,
    agent_pause_state: State<AgentPause>,
    superpowers_state: State<SuperpowersMarks>,
    agent_defaults_state: State<AgentDefaults>,
    git_tracking_state: State<GitTrackingDefaults>,
    require_review_state: State<RequireReviewDefaults>,
    headroom_state: State<HeadroomDefaults>,
    launch_state: State<LaunchSettings>,
    custom_resume_args_state: State<CustomResumeArgs>,
) -> Result<(), String> {
    *agent_defaults_state.0.lock().unwrap() = agent_defaults.clone();
    let git_tracking = *git_tracking_state.0.lock().unwrap();
    let require_review = *require_review_state.0.lock().unwrap();
    let headroom = *headroom_state.0.lock().unwrap();
    let launch = *launch_state.0.lock().unwrap();
    let custom_resume_args = custom_resume_args_state.0.lock().unwrap().clone();
    let data = state.0.lock().unwrap().clone();
    let session_names = names_state.0.lock().unwrap().clone();
    let file_tabs = file_tabs_state.0.lock().unwrap().clone();
    let board_tabs = board_tabs_state.0.lock().unwrap().clone();
    let card_tabs = card_tabs_state.0.lock().unwrap().clone();
    let theme = theme_state.0.lock().unwrap().clone();
    let agent_models = agent_models_state.0.lock().unwrap().clone();
    let superpowers = superpowers_state.0.lock().unwrap().clone();
    let terminal_font_size = *font_size_state.0.lock().unwrap();
    let auto_commit = *auto_commit_state.0.lock().unwrap();
    let agent_pause = agent_pause_state.0.lock().unwrap().clone();
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    persist_workspaces(
        &config_dir,
        &data,
        session_names,
        file_tabs,
        board_tabs,
        card_tabs,
        theme,
        agent_models,
        terminal_font_size,
        auto_commit,
        agent_pause,
        superpowers,
        agent_defaults,
        git_tracking,
        require_review,
        headroom,
        launch,
        custom_resume_args,
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod workspaces_data_tests {
    use super::*;

    #[test]
    fn workspaces_data_serializes_to_the_camel_case_shape_the_frontend_expects() {
        let data = WorkspacesData { workspaces: vec![], active_workspace_id: None, removed_workspaces: vec![] };
        let json = serde_json::to_value(&data).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "workspaces": [],
                "activeWorkspaceId": null,
                "removedWorkspaces": [],
            })
        );
    }

    /// The same hazard D48 named for `theme`: `agent_models` is a fifth
    /// carry-through field, so a save that rebuilds AppConfig without it
    /// silently wipes every app-wide model default.
    #[test]
    fn persist_workspaces_carries_agent_models_through() {
        let dir = tempfile::tempdir().unwrap();
        let data = WorkspacesData { workspaces: vec![], active_workspace_id: None, removed_workspaces: vec![] };
        let mut models = HashMap::new();
        models.insert("claude-code".to_string(), "opus".to_string());
        persist_workspaces(
            dir.path(),
            &data,
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            Some("light".to_string()),
            models.clone(),
            None,
            None,
            None,
            HashMap::new(),
            crate::config::AgentDefaultsConfig::default(),
            crate::config::GitTrackingDefault::default(),
            crate::config::RequireReviewDefault::default(),
            crate::config::HeadroomDefault::default(),
            None,
            None,
        )
        .unwrap();
        let loaded = crate::config::load(dir.path()).unwrap();
        assert_eq!(loaded.agent_models, models);
        assert_eq!(loaded.theme, Some("light".to_string()));
    }

    /// The card-tab map is the one carry-through field whose loss is not
    /// cosmetic. A tab id in a layout tree that no tab map claims reads
    /// as a terminal session (see `non_session_tab_ids`), so a save that
    /// dropped this map would not blank the pane -- the next launch would
    /// spawn a shell in its place.
    #[test]
    fn persist_workspaces_carries_card_tabs_through() {
        let dir = tempfile::tempdir().unwrap();
        let data = WorkspacesData { workspaces: vec![], active_workspace_id: None, removed_workspaces: vec![] };
        let mut card_tabs = HashMap::new();
        card_tabs.insert(
            "tab-9".to_string(),
            crate::config::CardTabRecord {
                workspace_id: "ws-1".to_string(),
                path: "/tmp/ws/.gavin-root/plans/login.md".to_string(),
                view: "plan".to_string(),
                session_id: None,
            },
        );
        persist_workspaces(
            dir.path(),
            &data,
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            card_tabs.clone(),
            None,
            HashMap::new(),
            None,
            None,
            None,
            HashMap::new(),
            crate::config::AgentDefaultsConfig::default(),
            crate::config::GitTrackingDefault::default(),
            crate::config::RequireReviewDefault::default(),
            crate::config::HeadroomDefault::default(),
            None,
            None,
        )
        .unwrap();
        assert_eq!(crate::config::load(dir.path()).unwrap().card_tabs, card_tabs);
    }

    /// The seventh carry-through field. Cheap to lose compared with the
    /// tombstones below, but lost the same way: a save that rebuilds
    /// AppConfig without it silently snaps every terminal in the app back
    /// to the default size.
    #[test]
    fn persist_workspaces_carries_the_terminal_font_size_through() {
        let dir = tempfile::tempdir().unwrap();
        let data = WorkspacesData { workspaces: vec![], active_workspace_id: None, removed_workspaces: vec![] };
        persist_workspaces(
            dir.path(),
            &data,
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            None,
            HashMap::new(),
            Some(11),
            None,
            None,
            HashMap::new(),
            crate::config::AgentDefaultsConfig::default(),
            crate::config::GitTrackingDefault::default(),
            crate::config::RequireReviewDefault::default(),
            crate::config::HeadroomDefault::default(),
            None,
            None,
        )
        .unwrap();
        assert_eq!(crate::config::load(dir.path()).unwrap().terminal_font_size, Some(11));
    }

    /// The twelfth carry-through field (v38): the app-wide `custom`
    /// resume flag.
    #[test]
    fn persist_workspaces_carries_the_custom_resume_args_through() {
        let dir = tempfile::tempdir().unwrap();
        let data = WorkspacesData { workspaces: vec![], active_workspace_id: None, removed_workspaces: vec![] };
        persist_workspaces(
            dir.path(),
            &data,
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            None,
            HashMap::new(),
            None,
            None,
            None,
            HashMap::new(),
            crate::config::AgentDefaultsConfig::default(),
            crate::config::GitTrackingDefault::default(),
            crate::config::RequireReviewDefault::default(),
            crate::config::HeadroomDefault::default(),
            None,
            Some("--resume".to_string()),
        )
        .unwrap();
        assert_eq!(
            crate::config::load(dir.path()).unwrap().custom_resume_args,
            Some("--resume".to_string())
        );
    }

    /// The eighth carry-through field. A save that rebuilt AppConfig
    /// without it would flip the app-wide default silently back to off,
    /// and the only symptom would be new cards quietly losing the
    /// auto-commit block -- which nobody notices until an agent finishes
    /// without committing.
    #[test]
    fn persist_workspaces_carries_the_auto_commit_default_through() {
        let dir = tempfile::tempdir().unwrap();
        let data = WorkspacesData { workspaces: vec![], active_workspace_id: None, removed_workspaces: vec![] };
        persist_workspaces(
            dir.path(),
            &data,
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            None,
            HashMap::new(),
            None,
            Some(true),
            None,
            HashMap::new(),
            crate::config::AgentDefaultsConfig::default(),
            crate::config::GitTrackingDefault::default(),
            crate::config::RequireReviewDefault::default(),
            crate::config::HeadroomDefault::default(),
            None,
            None,
        )
        .unwrap();
        assert_eq!(crate::config::load(dir.path()).unwrap().auto_commit, Some(true));
    }

    /// Absence is a state of its own: `false` means "this install chose
    /// off" and None means "nobody chose", and only the second may be
    /// moved by a change to gavin's default. A round-trip that collapsed
    /// them would take the app-wide Off switch away.
    #[test]
    fn an_explicit_off_survives_the_round_trip_as_false_not_absent() {
        let dir = tempfile::tempdir().unwrap();
        let data = WorkspacesData { workspaces: vec![], active_workspace_id: None, removed_workspaces: vec![] };
        persist_workspaces(
            dir.path(),
            &data,
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            None,
            HashMap::new(),
            None,
            Some(false),
            None,
            HashMap::new(),
            crate::config::AgentDefaultsConfig::default(),
            crate::config::GitTrackingDefault::default(),
            crate::config::RequireReviewDefault::default(),
            crate::config::HeadroomDefault::default(),
            None,
            None,
        )
        .unwrap();
        assert_eq!(crate::config::load(dir.path()).unwrap().auto_commit, Some(false));
    }

    /// The sixth carry-through field, and the one whose loss is
    /// unrecoverable: a wiped tombstone list means a removed workspace's
    /// daemon rows can never be named again.
    #[test]
    fn persist_workspaces_carries_removed_workspaces_through() {
        let dir = tempfile::tempdir().unwrap();
        let tombstone = crate::config::RemovedWorkspace {
            id: "ws-1".to_string(),
            name: "One".to_string(),
            root_path: "/repo/one".to_string(),
            removed_at: 1_700_000_000_000,
        };
        let data = WorkspacesData {
            workspaces: vec![],
            active_workspace_id: None,
            removed_workspaces: vec![tombstone.clone()],
        };
        persist_workspaces(
            dir.path(),
            &data,
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            None,
            HashMap::new(),
            None,
            None,
            None,
            HashMap::new(),
            crate::config::AgentDefaultsConfig::default(),
            crate::config::GitTrackingDefault::default(),
            crate::config::RequireReviewDefault::default(),
            crate::config::HeadroomDefault::default(),
            None,
            None,
        )
        .unwrap();
        assert_eq!(crate::config::load(dir.path()).unwrap().removed_workspaces, vec![tombstone]);
    }

    /// The seventh carry-through field. Its loss is quiet rather than
    /// loud: a wiped marker does not break anything, it just starts the
    /// Home banner nagging again about a step the human already declined.
    #[test]
    fn persist_workspaces_carries_superpowers_marks_through() {
        let dir = tempfile::tempdir().unwrap();
        let data = WorkspacesData { workspaces: vec![], active_workspace_id: None, removed_workspaces: vec![] };
        let mut marks = HashMap::new();
        marks.insert("/repo/one".to_string(), crate::config::SuperpowersMark::Skipped);
        marks.insert("/repo/two".to_string(), crate::config::SuperpowersMark::Installed);
        persist_workspaces(
            dir.path(),
            &data,
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            None,
            HashMap::new(),
            None,
            None,
            None,
            marks.clone(),
            crate::config::AgentDefaultsConfig::default(),
            crate::config::GitTrackingDefault::default(),
            crate::config::RequireReviewDefault::default(),
            crate::config::HeadroomDefault::default(),
            None,
            None,
        )
        .unwrap();
        assert_eq!(crate::config::load(dir.path()).unwrap().superpowers, marks);
    }

    /// The eighth carry-through field, and the one whose loss is the most
    /// expensive to notice: a wiped complexity table does not error, it
    /// silently sends every card back to the workspace's default agent,
    /// which looks exactly like a table that was never filled in.
    #[test]
    fn persist_workspaces_carries_the_agent_defaults_through() {
        let dir = tempfile::tempdir().unwrap();
        let data = WorkspacesData { workspaces: vec![], active_workspace_id: None, removed_workspaces: vec![] };
        let mut complexity = HashMap::new();
        complexity.insert(
            "intricate".to_string(),
            crate::config::ComplexityAgent {
                profile: "claude-code".to_string(),
                model: "opus".to_string(),
            },
        );
        let defaults = crate::config::AgentDefaultsConfig {
            custom_command: "my-agent --yolo".to_string(),
            custom_model_flag: "--llm".to_string(),
            custom_api_family: "openai".to_string(),
            complexity,
            agent_fallback: vec!["codex".to_string()],
            fallback_thresholds: {
                let mut m = HashMap::new();
                m.insert("claude-code".to_string(), 80);
                m
            },
            action_prompt_overrides: HashMap::new(),
        };
        persist_workspaces(
            dir.path(),
            &data,
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            None,
            HashMap::new(),
            None,
            None,
            None,
            HashMap::new(),
            defaults.clone(),
            crate::config::GitTrackingDefault::default(),
            crate::config::RequireReviewDefault::default(),
            crate::config::HeadroomDefault::default(),
            None,
            None,
        )
        .unwrap();
        assert_eq!(crate::config::load(dir.path()).unwrap().agent_defaults, defaults);
    }

    /// The TENTH carry-through field, and the one whose loss is a
    /// safety regression rather than a cosmetic one: a save site that
    /// dropped it would put an install that deliberately set a ceiling
    /// of 2 back on the shipped 4, silently, on the next unrelated save.
    #[test]
    fn persist_workspaces_carries_the_launch_wall_through() {
        let dir = tempfile::tempdir().unwrap();
        let data = WorkspacesData { workspaces: vec![], active_workspace_id: None, removed_workspaces: vec![] };
        let launch = crate::config::LaunchConfig {
            max_in_flight: Some(2),
            hold_on_pressure: false,
            reclaim_done_sessions: false,
        };
        persist_workspaces(
            dir.path(),
            &data,
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            None,
            HashMap::new(),
            None,
            None,
            None,
            HashMap::new(),
            crate::config::AgentDefaultsConfig::default(),
            crate::config::GitTrackingDefault::default(),
            crate::config::RequireReviewDefault::default(),
            crate::config::HeadroomDefault::default(),
            Some(launch),
            None,
        )
        .unwrap();
        assert_eq!(crate::config::load(dir.path()).unwrap().launch, Some(launch));
    }

    /// A blank ceiling is a real answer -- "no ceiling" -- and has to
    /// survive the round trip as absence rather than come back as the
    /// shipped 4. `skip_serializing_if` keeps the key out of the file
    /// entirely, which is exactly the shape that could read back wrong.
    #[test]
    fn persist_workspaces_keeps_an_explicitly_blank_ceiling_blank() {
        let dir = tempfile::tempdir().unwrap();
        let data = WorkspacesData { workspaces: vec![], active_workspace_id: None, removed_workspaces: vec![] };
        let launch = crate::config::LaunchConfig {
            max_in_flight: None,
            hold_on_pressure: true,
            reclaim_done_sessions: true,
        };
        persist_workspaces(
            dir.path(),
            &data,
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            None,
            HashMap::new(),
            None,
            None,
            None,
            HashMap::new(),
            crate::config::AgentDefaultsConfig::default(),
            crate::config::GitTrackingDefault::default(),
            crate::config::RequireReviewDefault::default(),
            crate::config::HeadroomDefault::default(),
            Some(launch),
            None,
        )
        .unwrap();
        let loaded = crate::config::load(dir.path()).unwrap().launch.unwrap();
        assert_eq!(loaded.max_in_flight, None);
        assert!(loaded.hold_on_pressure);
    }

    /// A config.json written before the reclaim switch existed carries
    /// only the ceiling and the hold. It has to parse as the shipped
    /// answer, not as a refusal: a machine that upgraded is the machine
    /// with six idle agents of done cards already on it.
    #[test]
    fn launch_config_written_before_the_reclaim_switch_reads_as_on() {
        let launch: crate::config::LaunchConfig =
            serde_json::from_str(r#"{"maxInFlight":4,"holdOnPressure":true}"#).unwrap();
        assert!(launch.reclaim_done_sessions);
        assert!(launch.hold_on_pressure);
        assert_eq!(launch.max_in_flight, Some(4));
        // And the wire name is the one launchGate.ts reads.
        let json = serde_json::to_value(crate::config::LaunchConfig::default()).unwrap();
        assert_eq!(json["reclaimDoneSessions"], serde_json::Value::Bool(true));
    }

    #[test]
    fn persist_workspaces_carries_the_git_tracking_default_through() {
        let dir = tempfile::tempdir().unwrap();
        let data = WorkspacesData { workspaces: vec![], active_workspace_id: None, removed_workspaces: vec![] };
        persist_workspaces(
            dir.path(),
            &data,
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            None,
            HashMap::new(),
            None,
            None,
            None,
            HashMap::new(),
            crate::config::AgentDefaultsConfig::default(),
            crate::config::GitTrackingDefault(Some(false)),
            crate::config::RequireReviewDefault::default(),
            crate::config::HeadroomDefault::default(),
            None,
            None,
        )
        .unwrap();
        // An explicit "off" survives as false, not as absence: absence is
        // "nobody chose" and would put this install back on gavin's own
        // default, which is the opposite answer.
        assert_eq!(
            crate::config::load(dir.path()).unwrap().git_tracking,
            crate::config::GitTrackingDefault(Some(false))
        );
    }

    #[test]
    fn persist_workspaces_carries_the_require_review_default_through() {
        let dir = tempfile::tempdir().unwrap();
        let data = WorkspacesData { workspaces: vec![], active_workspace_id: None, removed_workspaces: vec![] };
        persist_workspaces(
            dir.path(),
            &data,
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            None,
            HashMap::new(),
            None,
            None,
            None,
            HashMap::new(),
            crate::config::AgentDefaultsConfig::default(),
            crate::config::GitTrackingDefault::default(),
            crate::config::RequireReviewDefault(Some(false)),
            crate::config::HeadroomDefault::default(),
            None,
            None,
        )
        .unwrap();
        // An explicit "off" survives as false, not as absence: absence is
        // "nobody chose" and would put this install back on gavin's own
        // default (require review), which is the opposite answer.
        assert_eq!(
            crate::config::load(dir.path()).unwrap().require_review,
            crate::config::RequireReviewDefault(Some(false))
        );
    }

    fn persist_with_headroom(dir: &std::path::Path, headroom: crate::config::HeadroomDefault) {
        let data = WorkspacesData { workspaces: vec![], active_workspace_id: None, removed_workspaces: vec![] };
        persist_workspaces(
            dir,
            &data,
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            None,
            HashMap::new(),
            None,
            None,
            None,
            HashMap::new(),
            crate::config::AgentDefaultsConfig::default(),
            crate::config::GitTrackingDefault::default(),
            crate::config::RequireReviewDefault::default(),
            headroom,
            None,
            None,
        )
        .unwrap();
    }

    #[test]
    fn persist_workspaces_carries_the_headroom_default_through() {
        let dir = tempfile::tempdir().unwrap();

        persist_with_headroom(dir.path(), crate::config::HeadroomDefault(Some(true)));
        assert_eq!(
            crate::config::load(dir.path()).unwrap().headroom,
            crate::config::HeadroomDefault(Some(true))
        );

        // An explicit "off" survives as false, not as absence: absence
        // is "nobody chose", and would follow gavin's default if that
        // ever moved.
        persist_with_headroom(dir.path(), crate::config::HeadroomDefault(Some(false)));
        assert_eq!(
            crate::config::load(dir.path()).unwrap().headroom,
            crate::config::HeadroomDefault(Some(false))
        );
    }

    /// The default starts Off, and it starts UNWRITTEN: a config.json
    /// nobody has set this in gains no key, so the release build that
    /// shares the file reads back exactly what it wrote.
    #[test]
    fn a_headroom_default_nobody_chose_is_absent_from_the_file_and_reads_as_unset() {
        let dir = tempfile::tempdir().unwrap();

        persist_with_headroom(dir.path(), crate::config::HeadroomDefault::default());

        let written: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(crate::config::config_path(dir.path())).unwrap(),
        )
        .unwrap();
        assert!(written.get("headroom").is_none(), "{written}");
        assert_eq!(crate::config::load(dir.path()).unwrap().headroom.0, None);
    }

    /// A workspace's own overrides ride on the workspace record, so they
    /// travel with `WorkspacesData` rather than as a thirteenth
    /// positional -- the same reason `removed_workspaces` does. This pins
    /// that they survive the save at all: `skip_serializing_if` keeps the
    /// key out of config.json for an inheriting workspace, and a bug
    /// there would drop a real override just as quietly.
    #[test]
    fn persist_workspaces_carries_a_workspaces_complexity_overrides_through() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace {
            id: "ws-1".to_string(),
            name: "WS".to_string(),
            pages: vec![],
            active_page_id: None,
            active_view: None,
            hub_view: None,
            root_path: None,
            main_session_id: None,
            orchestration_agent: None,
            developing_cards: Vec::new(),
            legacy_agent_command: None,
            color: None,
            notify_needs_input: true,
            notify_finished: true,
            confirm_tab_close: true,
            home_agent_share: None,
            git_view: None,
            last_active_at: None,
            terminal_font_size: None,
            auto_commit: None,
            auto_resume_runs: false,
            agent_pause: None,
            pinned_at: None,
            complexity_agents: HashMap::new(),
            git_tracking_asked: false,
            trusted_config_hash: None,
            mcp_foreign_servers_choice: None,
            reviewed_cards: None,
            require_review: None,
            headroom: None,
            require_review_asked: false,
            headroom_asked: false,
            custom_resume_args: None,
            agent_fallback: None,
            armed_agents: Vec::new(),
            declined_agents: Vec::new(),
            ssh: None,
            action_prompt_overrides: HashMap::new(),
        };
        ws.complexity_agents.insert(
            "trivial".to_string(),
            crate::config::ComplexityAgent {
                profile: String::new(),
                model: "haiku".to_string(),
            },
        );
        let data = WorkspacesData {
            workspaces: vec![ws.clone()],
            active_workspace_id: None,
            removed_workspaces: vec![],
        };
        persist_workspaces(
            dir.path(),
            &data,
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            None,
            HashMap::new(),
            None,
            None,
            None,
            HashMap::new(),
            crate::config::AgentDefaultsConfig::default(),
            crate::config::GitTrackingDefault::default(),
            crate::config::RequireReviewDefault::default(),
            crate::config::HeadroomDefault::default(),
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            crate::config::load(dir.path()).unwrap().workspaces[0].complexity_agents,
            ws.complexity_agents
        );
    }

    /// The marker is the human's word, so it has to survive a round trip
    /// through JSON by NAME -- a config.json hand-edited to say
    /// "installed" must load, and a renamed variant must not silently
    /// become the other one.
    #[test]
    fn superpowers_marks_serialize_as_lowercase_names() {
        let dir = tempfile::tempdir().unwrap();
        let data = WorkspacesData { workspaces: vec![], active_workspace_id: None, removed_workspaces: vec![] };
        let mut marks = HashMap::new();
        marks.insert("/repo".to_string(), crate::config::SuperpowersMark::Installed);
        persist_workspaces(
            dir.path(),
            &data,
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            None,
            HashMap::new(),
            None,
            None,
            None,
            marks,
            crate::config::AgentDefaultsConfig::default(),
            crate::config::GitTrackingDefault::default(),
            crate::config::RequireReviewDefault::default(),
            crate::config::HeadroomDefault::default(),
            None,
            None,
        )
        .unwrap();
        let raw = std::fs::read_to_string(crate::config::config_path(dir.path())).unwrap();
        assert!(raw.contains("\"installed\""), "{raw}");
    }

    /// A config.json written before the field existed must still load --
    /// otherwise every user's workspaces vanish on the upgrade.
    #[test]
    fn a_config_without_the_field_loads_with_an_empty_list() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            crate::config::config_path(dir.path()),
            r#"{"workspaces":[],"activeWorkspaceId":null}"#,
        )
        .unwrap();
        assert!(crate::config::load(dir.path()).unwrap().removed_workspaces.is_empty());
    }

    /// Every config.json on every machine was written before this field
    /// existed. An absent map must load as empty rather than failing the
    /// whole parse -- `config::load` swallows a parse error into
    /// `AppConfig::default()`, so the failure mode here is not an error
    /// message, it is every workspace silently vanishing.
    #[test]
    fn a_config_written_before_superpowers_existed_still_loads_its_workspaces() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            crate::config::config_path(dir.path()),
            // snake_case, because that is what AppConfig actually writes:
            // it carries no `rename_all`, unlike the structs that cross to
            // the frontend. A camelCase key here would silently parse as
            // absent and the test would pass for the wrong reason.
            r#"{"workspaces":[],"active_workspace_id":"ws-1","theme":"dark"}"#,
        )
        .unwrap();
        let loaded = crate::config::load(dir.path()).unwrap();
        assert!(loaded.superpowers.is_empty());
        assert_eq!(loaded.active_workspace_id.as_deref(), Some("ws-1"));
        assert_eq!(loaded.theme.as_deref(), Some("dark"));
    }

    /// The regression D48 exists to prevent: theme is a fourth field on
    /// AppConfig, so a save that reconstructs the struct without carrying
    /// it would silently reset it -- exactly what already bit
    /// session_names and file_tabs.
    #[test]
    fn persist_workspaces_carries_theme_through() {
        let dir = tempfile::tempdir().unwrap();
        let data = WorkspacesData { workspaces: vec![], active_workspace_id: None, removed_workspaces: vec![] };
        persist_workspaces(
            dir.path(),
            &data,
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            Some("light".to_string()),
            HashMap::new(),
            None,
            None,
            None,
            HashMap::new(),
            crate::config::AgentDefaultsConfig::default(),
            crate::config::GitTrackingDefault::default(),
            crate::config::RequireReviewDefault::default(),
            crate::config::HeadroomDefault::default(),
            None,
            None,
        )
        .unwrap();
        assert_eq!(crate::config::load(dir.path()).unwrap().theme, Some("light".to_string()));
    }

    /// The seventh field, and the seventh chance to make the same
    /// mistake: session_names, file_tabs, board_tabs, theme, agent_models
    /// and removed_workspaces were each silently reset by a save site
    /// that reconstructed AppConfig without carrying them. A wiped pause
    /// cycle would be quieter than any of those -- nothing looks wrong
    /// until a rail runs straight through a window it was told to sit out.
    #[test]
    fn persist_workspaces_carries_the_agent_pause_cycle_through() {
        let dir = tempfile::tempdir().unwrap();
        let data = WorkspacesData { workspaces: vec![], active_workspace_id: None, removed_workspaces: vec![] };
        let cycle = crate::config::AgentPauseConfig {
            enabled: true,
            period_minutes: 300,
            pause_minutes: 10,
            anchor_ms: 1_700_000_000_000,
            limit_percent: 95.0,
            limit_enabled: true,
        };
        persist_workspaces(
            dir.path(),
            &data,
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            None,
            HashMap::new(),
            None,
            None,
            Some(cycle.clone()),
            HashMap::new(),
            crate::config::AgentDefaultsConfig::default(),
            crate::config::GitTrackingDefault::default(),
            crate::config::RequireReviewDefault::default(),
            crate::config::HeadroomDefault::default(),
            None,
            None,
        )
        .unwrap();
        assert_eq!(crate::config::load(dir.path()).unwrap().agent_pause, Some(cycle));
    }

    /// The anchor is what makes the cycle survive a restart, so it has to
    /// come back off disk byte-identical. A config written before this
    /// field existed loads with no cycle -- which is off, and is the
    /// shipped default.
    #[test]
    fn a_config_without_a_cycle_loads_with_none() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            crate::config::config_path(dir.path()),
            r#"{"workspaces":[],"activeWorkspaceId":null}"#,
        )
        .unwrap();
        assert_eq!(crate::config::load(dir.path()).unwrap().agent_pause, None);
    }
}

// The two migrations every config.json passes through on load: the
// pinned workspace's rename, and the retired Smoke Test workspace's
// removal.
#[cfg(test)]
mod workspace_migration_tests {
    use super::*;

    fn pinned(name: &str) -> Workspace {
        Workspace {
            id: crate::config::UNFILED_WORKSPACE_ID.to_string(),
            name: name.to_string(),
            pages: vec![],
            active_page_id: None,
            active_view: None,
            hub_view: None,
            root_path: None,
            main_session_id: None,
            orchestration_agent: None,
            developing_cards: Vec::new(),
            legacy_agent_command: None,
            color: None,
            notify_needs_input: true,
            notify_finished: true,
            confirm_tab_close: true,
            home_agent_share: None,
            git_view: None,
            last_active_at: None,
            terminal_font_size: None,
            auto_commit: None,
            auto_resume_runs: false,
            agent_pause: None,
            pinned_at: None,
            complexity_agents: HashMap::new(),
            git_tracking_asked: false,
            trusted_config_hash: None,
            mcp_foreign_servers_choice: None,
            reviewed_cards: None,
            require_review: None,
            headroom: None,
            require_review_asked: false,
            headroom_asked: false,
            custom_resume_args: None,
            agent_fallback: None,
            armed_agents: Vec::new(),
            declined_agents: Vec::new(),
            ssh: None,
            action_prompt_overrides: HashMap::new(),
        }
    }

    #[test]
    fn rename_migrates_the_old_pinned_workspace_name() {
        let mut workspaces = vec![pinned("Unfiled")];
        rename_legacy_unfiled(&mut workspaces);
        assert_eq!(workspaces[0].name, "Scratchpad");
        assert_eq!(workspaces[0].id, crate::config::UNFILED_WORKSPACE_ID, "the id must never move");
    }

    #[test]
    fn rename_leaves_a_hand_picked_pinned_name_alone() {
        let mut workspaces = vec![pinned("Loose ends")];
        rename_legacy_unfiled(&mut workspaces);
        assert_eq!(workspaces[0].name, "Loose ends");
    }

    #[test]
    fn rename_ignores_a_regular_workspace_that_happens_to_be_called_unfiled() {
        let mut ws = pinned("Unfiled");
        ws.id = "ws-1".to_string();
        let mut workspaces = vec![ws];
        rename_legacy_unfiled(&mut workspaces);
        assert_eq!(workspaces[0].name, "Unfiled");
    }

    #[test]
    fn drop_removes_a_smoketest_workspace_left_by_an_older_build() {
        let mut workspaces = vec![pinned("Scratchpad"), {
            let mut ws = pinned("Smoke Test");
            ws.id = crate::config::SMOKETEST_WORKSPACE_ID.to_string();
            ws.root_path = Some("/tmp/scratch".to_string());
            ws
        }];
        drop_smoketest_workspace(&mut workspaces);
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].id, crate::config::UNFILED_WORKSPACE_ID, "only the retired one goes");
        // Idempotent: a config that never had one is left alone.
        drop_smoketest_workspace(&mut workspaces);
        assert_eq!(workspaces.len(), 1);
    }
}

/// Returns the current workspace/page state. An empty `WorkspacesData`
/// (`workspaces: []`) is a normal, permanent steady state -- e.g. every
/// user's first launch after this migration, before they've created any
/// workspace -- not a "not ready yet" signal. The only reliable
/// not-ready signal is this command's invoke rejecting outright (the
/// state hasn't been `manage`d yet, i.e. `bootstrap` hasn't finished) --
/// callers must not infer readiness from whether the payload is empty.
#[tauri::command]
pub fn get_workspaces_state(state: State<WorkspacesState>) -> WorkspacesData {
    state.0.lock().unwrap().clone()
}

/// Writes the workspaces state -- the desk's LAYOUT save -- and tells the
/// OTHER windows what it now says.
///
/// Layout only, for every workspace the host already holds: pages, tabs
/// and the rest of `workspace_settings::LAYOUT_KEYS`. The payload still
/// carries whole workspaces, because this is also how the desk adds,
/// closes and reorders them, and a new one arrives with its settings; but
/// a known workspace keeps the settings the host has, and a setting
/// changes only through `set_workspace_settings`. A Companion may call
/// that one and never this one (docs/adr/0006).
///
/// config.json is one file behind however many windows are open, and
/// every window holds its own copy of the array it writes back whole. So
/// a window that saved a page rename against a copy taken before another
/// window added a tab would undo that tab. The broadcast below is what
/// closes that: the writer is the authority, and every other window
/// adopts what it wrote (layoutState's `workspaces-synced` listener),
/// keeping only its own `active_workspace_id` -- which is per WINDOW, not
/// per app, once a workspace can be in a window of its own.
///
/// `window` is Tauri's, injected rather than passed: the payload carries
/// the label that wrote it so the writer can ignore its own echo instead
/// of re-adopting state it is already showing.
#[tauri::command]
pub fn set_workspaces_state(
    workspaces: Vec<Workspace>,
    active_workspace_id: Option<String>,
    // Required rather than Option: a caller that forgets it should fail
    // loudly at the boundary, because the failure mode of a silent
    // default here is every tombstone disappearing on the next save.
    removed_workspaces: Vec<crate::config::RemovedWorkspace>,
    app_handle: AppHandle,
    window: tauri::Window,
    state: State<WorkspacesState>,
    names_state: State<SessionNames>,
    file_tabs_state: State<FileTabs>,
    board_tabs_state: State<BoardTabs>,
    card_tabs_state: State<CardTabs>,
    theme_state: State<ThemePref>,
    agent_models_state: State<AgentModels>,
    font_size_state: State<TerminalFontSize>,
    auto_commit_state: State<AutoCommit>,
    agent_pause_state: State<AgentPause>,
    superpowers_state: State<SuperpowersMarks>,
    agent_defaults_state: State<AgentDefaults>,
    git_tracking_state: State<GitTrackingDefaults>,
    require_review_state: State<RequireReviewDefaults>,
    headroom_state: State<HeadroomDefaults>,
    launch_state: State<LaunchSettings>,
    custom_resume_args_state: State<CustomResumeArgs>,
) -> Result<(), String> {
    // The LAYOUT save (workspace_settings.rs): for a workspace the host
    // already holds, only the payload's layout is taken and the settings
    // stay the host's. Settings have their own command, so a window saving
    // a copy taken before another writer's settings change cannot undo it.
    let data = {
        let mut guard = state.0.lock().unwrap();
        #[cfg(debug_assertions)]
        for incoming in &workspaces {
            if let Some(stored) = guard.workspaces.iter().find(|w| w.id == incoming.id) {
                let dropped = crate::workspace_settings::dropped_settings(stored, incoming);
                if !dropped.is_empty() {
                    eprintln!(
                        "set_workspaces_state: ignored settings {dropped:?} of {} -- a setting goes through set_workspace_settings",
                        incoming.id
                    );
                }
            }
        }
        let workspaces = crate::workspace_settings::merge_layout_save(&guard.workspaces, workspaces);
        *guard = WorkspacesData { workspaces, active_workspace_id, removed_workspaces };
        guard.clone()
    };
    let session_names = names_state.0.lock().unwrap().clone();
    let file_tabs = file_tabs_state.0.lock().unwrap().clone();
    let board_tabs = board_tabs_state.0.lock().unwrap().clone();
    let card_tabs = card_tabs_state.0.lock().unwrap().clone();
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let theme = theme_state.0.lock().unwrap().clone();
    let agent_models = agent_models_state.0.lock().unwrap().clone();
    let terminal_font_size = *font_size_state.0.lock().unwrap();
    let auto_commit = *auto_commit_state.0.lock().unwrap();
    let agent_pause = agent_pause_state.0.lock().unwrap().clone();
    let superpowers = superpowers_state.0.lock().unwrap().clone();
    let agent_defaults = agent_defaults_state.0.lock().unwrap().clone();
    let git_tracking = *git_tracking_state.0.lock().unwrap();
    let require_review = *require_review_state.0.lock().unwrap();
    let headroom = *headroom_state.0.lock().unwrap();
    let launch = *launch_state.0.lock().unwrap();
    let custom_resume_args = custom_resume_args_state.0.lock().unwrap().clone();
    persist_workspaces(
        &config_dir,
        &data,
        session_names,
        file_tabs,
        board_tabs,
        card_tabs,
        theme,
        agent_models,
        terminal_font_size,
        auto_commit,
        agent_pause,
        superpowers,
        agent_defaults,
        git_tracking,
        require_review,
        headroom,
        launch,
        custom_resume_args,
    )
    .map_err(|e| e.to_string())?;
    let _ = app_handle.emit(
        "workspaces-synced",
        WorkspacesSync { origin: window.label().to_string(), data },
    );
    Ok(())
}

/// One window's write, addressed to all the others. `origin` is the
/// label of the window that made it.
#[derive(Clone, serde::Serialize)]
pub struct WorkspacesSync {
    origin: String,
    data: WorkspacesData,
}

impl WorkspacesSync {
    /// A write nobody's window made: a link resolving an ssh workspace's
    /// sessions on its host (`remote.rs`). The origin names the host, so
    /// no window mistakes it for its own echo and every window adopts it.
    pub(crate) fn from_remote(host: &str, data: WorkspacesData) -> Self {
        Self { origin: format!("remote:{host}"), data }
    }
}

/// Persists `data` with every other managed setting as it currently is,
/// for a writer that is not `set_workspaces_state`: a link that just
/// resolved an ssh workspace's sessions (`remote.rs`). Reads the same
/// states that command reads, so nothing beside the workspaces is reset
/// by the save.
pub(crate) fn persist_current(app_handle: &AppHandle, data: &WorkspacesData) -> anyhow::Result<()> {
    let config_dir = app_handle.path().app_config_dir()?;
    persist_workspaces(
        &config_dir,
        data,
        app_handle.state::<SessionNames>().0.lock().unwrap().clone(),
        app_handle.state::<FileTabs>().0.lock().unwrap().clone(),
        app_handle.state::<BoardTabs>().0.lock().unwrap().clone(),
        app_handle.state::<CardTabs>().0.lock().unwrap().clone(),
        app_handle.state::<ThemePref>().0.lock().unwrap().clone(),
        app_handle.state::<AgentModels>().0.lock().unwrap().clone(),
        *app_handle.state::<TerminalFontSize>().0.lock().unwrap(),
        *app_handle.state::<AutoCommit>().0.lock().unwrap(),
        app_handle.state::<AgentPause>().0.lock().unwrap().clone(),
        app_handle.state::<SuperpowersMarks>().0.lock().unwrap().clone(),
        app_handle.state::<AgentDefaults>().0.lock().unwrap().clone(),
        *app_handle.state::<GitTrackingDefaults>().0.lock().unwrap(),
        *app_handle.state::<RequireReviewDefaults>().0.lock().unwrap(),
        *app_handle.state::<HeadroomDefaults>().0.lock().unwrap(),
        *app_handle.state::<LaunchSettings>().0.lock().unwrap(),
        app_handle.state::<CustomResumeArgs>().0.lock().unwrap().clone(),
    )
}

#[tauri::command]
pub fn get_agent_model_defaults(state: State<AgentModels>) -> HashMap<String, String> {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_agent_model_default(
    profile_id: String,
    model: String,
    app_handle: AppHandle,
    state: State<WorkspacesState>,
    names_state: State<SessionNames>,
    file_tabs_state: State<FileTabs>,
    board_tabs_state: State<BoardTabs>,
    card_tabs_state: State<CardTabs>,
    theme_state: State<ThemePref>,
    agent_models_state: State<AgentModels>,
    font_size_state: State<TerminalFontSize>,
    auto_commit_state: State<AutoCommit>,
    agent_pause_state: State<AgentPause>,
    superpowers_state: State<SuperpowersMarks>,
    agent_defaults_state: State<AgentDefaults>,
    git_tracking_state: State<GitTrackingDefaults>,
    require_review_state: State<RequireReviewDefaults>,
    headroom_state: State<HeadroomDefaults>,
    launch_state: State<LaunchSettings>,
    custom_resume_args_state: State<CustomResumeArgs>,
) -> Result<(), String> {
    // An empty model removes the entry rather than storing "": the
    // picker's unset row must be able to UNDO a default, not just
    // overwrite it, and a stored empty string would read as a deliberate
    // empty model to resolveAgentConfig.
    let agent_models = {
        let mut current = agent_models_state.0.lock().unwrap();
        if model.trim().is_empty() {
            current.remove(&profile_id);
        } else {
            current.insert(profile_id, model.trim().to_string());
        }
        current.clone()
    };
    let data = state.0.lock().unwrap().clone();
    let session_names = names_state.0.lock().unwrap().clone();
    let file_tabs = file_tabs_state.0.lock().unwrap().clone();
    let board_tabs = board_tabs_state.0.lock().unwrap().clone();
    let card_tabs = card_tabs_state.0.lock().unwrap().clone();
    let theme = theme_state.0.lock().unwrap().clone();
    let terminal_font_size = *font_size_state.0.lock().unwrap();
    let auto_commit = *auto_commit_state.0.lock().unwrap();
    let agent_pause = agent_pause_state.0.lock().unwrap().clone();
    let superpowers = superpowers_state.0.lock().unwrap().clone();
    let agent_defaults = agent_defaults_state.0.lock().unwrap().clone();
    let git_tracking = *git_tracking_state.0.lock().unwrap();
    let require_review = *require_review_state.0.lock().unwrap();
    let headroom = *headroom_state.0.lock().unwrap();
    let launch = *launch_state.0.lock().unwrap();
    let custom_resume_args = custom_resume_args_state.0.lock().unwrap().clone();
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    persist_workspaces(
        &config_dir,
        &data,
        session_names,
        file_tabs,
        board_tabs,
        card_tabs,
        theme,
        agent_models,
        terminal_font_size,
        auto_commit,
        agent_pause,
        superpowers,
        agent_defaults,
        git_tracking,
        require_review,
        headroom,
        launch,
        custom_resume_args,
    )
    .map_err(|e| e.to_string())
}

/// What the human has told gavin about Superpowers, keyed by workspace
/// root path. Machine-local, so it answers only for this machine -- see
/// `AppConfig::superpowers`.
#[tauri::command]
pub fn get_superpowers_marks(
    state: State<SuperpowersMarks>,
) -> HashMap<String, crate::config::SuperpowersMark> {
    state.0.lock().unwrap().clone()
}

/// Records "I've installed it" / "Not now" for one workspace root, or --
/// with `mark: None` -- forgets what was said. Forgetting matters: a
/// human who asserted an install and then removed it needs a way back to
/// the honest "absent", and overwriting with the other marker would say
/// something they did not mean.
#[tauri::command]
pub fn set_superpowers_mark(
    root_path: String,
    mark: Option<crate::config::SuperpowersMark>,
    app_handle: AppHandle,
    state: State<WorkspacesState>,
    names_state: State<SessionNames>,
    file_tabs_state: State<FileTabs>,
    board_tabs_state: State<BoardTabs>,
    card_tabs_state: State<CardTabs>,
    theme_state: State<ThemePref>,
    agent_models_state: State<AgentModels>,
    font_size_state: State<TerminalFontSize>,
    auto_commit_state: State<AutoCommit>,
    agent_pause_state: State<AgentPause>,
    superpowers_state: State<SuperpowersMarks>,
    agent_defaults_state: State<AgentDefaults>,
    git_tracking_state: State<GitTrackingDefaults>,
    require_review_state: State<RequireReviewDefaults>,
    headroom_state: State<HeadroomDefaults>,
    launch_state: State<LaunchSettings>,
    custom_resume_args_state: State<CustomResumeArgs>,
) -> Result<(), String> {
    let superpowers = {
        let mut current = superpowers_state.0.lock().unwrap();
        match mark {
            Some(m) => {
                current.insert(root_path, m);
            }
            None => {
                current.remove(&root_path);
            }
        }
        current.clone()
    };
    let data = state.0.lock().unwrap().clone();
    let session_names = names_state.0.lock().unwrap().clone();
    let file_tabs = file_tabs_state.0.lock().unwrap().clone();
    let board_tabs = board_tabs_state.0.lock().unwrap().clone();
    let card_tabs = card_tabs_state.0.lock().unwrap().clone();
    let theme = theme_state.0.lock().unwrap().clone();
    let agent_models = agent_models_state.0.lock().unwrap().clone();
    let agent_pause = agent_pause_state.0.lock().unwrap().clone();
    let agent_defaults = agent_defaults_state.0.lock().unwrap().clone();
    let git_tracking = *git_tracking_state.0.lock().unwrap();
    let require_review = *require_review_state.0.lock().unwrap();
    let headroom = *headroom_state.0.lock().unwrap();
    let launch = *launch_state.0.lock().unwrap();
    let custom_resume_args = custom_resume_args_state.0.lock().unwrap().clone();
    let terminal_font_size = *font_size_state.0.lock().unwrap();
    let auto_commit = *auto_commit_state.0.lock().unwrap();
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    persist_workspaces(
        &config_dir,
        &data,
        session_names,
        file_tabs,
        board_tabs,
        card_tabs,
        theme,
        agent_models,
        terminal_font_size,
        auto_commit,
        agent_pause,
        superpowers,
        agent_defaults,
        git_tracking,
        require_review,
        headroom,
        launch,
        custom_resume_args,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_theme_pref(state: State<ThemePref>) -> Option<String> {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_theme_pref(
    theme: Option<String>,
    app_handle: AppHandle,
    state: State<WorkspacesState>,
    names_state: State<SessionNames>,
    file_tabs_state: State<FileTabs>,
    board_tabs_state: State<BoardTabs>,
    card_tabs_state: State<CardTabs>,
    theme_state: State<ThemePref>,
    agent_models_state: State<AgentModels>,
    font_size_state: State<TerminalFontSize>,
    auto_commit_state: State<AutoCommit>,
    agent_pause_state: State<AgentPause>,
    superpowers_state: State<SuperpowersMarks>,
    agent_defaults_state: State<AgentDefaults>,
    git_tracking_state: State<GitTrackingDefaults>,
    require_review_state: State<RequireReviewDefaults>,
    headroom_state: State<HeadroomDefaults>,
    launch_state: State<LaunchSettings>,
    custom_resume_args_state: State<CustomResumeArgs>,
) -> Result<(), String> {
    // An absent or blank value clears the override back to System rather
    // than persisting an empty string -- there's no separate "clear"
    // command, the same shape as set_session_name.
    let theme = {
        let mut current = theme_state.0.lock().unwrap();
        *current = theme.filter(|t| !t.trim().is_empty());
        current.clone()
    };
    let data = state.0.lock().unwrap().clone();
    let session_names = names_state.0.lock().unwrap().clone();
    let file_tabs = file_tabs_state.0.lock().unwrap().clone();
    let board_tabs = board_tabs_state.0.lock().unwrap().clone();
    let card_tabs = card_tabs_state.0.lock().unwrap().clone();
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let agent_models = agent_models_state.0.lock().unwrap().clone();
    let terminal_font_size = *font_size_state.0.lock().unwrap();
    let auto_commit = *auto_commit_state.0.lock().unwrap();
    let agent_pause = agent_pause_state.0.lock().unwrap().clone();
    let superpowers = superpowers_state.0.lock().unwrap().clone();
    let agent_defaults = agent_defaults_state.0.lock().unwrap().clone();
    let git_tracking = *git_tracking_state.0.lock().unwrap();
    let require_review = *require_review_state.0.lock().unwrap();
    let headroom = *headroom_state.0.lock().unwrap();
    let launch = *launch_state.0.lock().unwrap();
    let custom_resume_args = custom_resume_args_state.0.lock().unwrap().clone();
    persist_workspaces(
        &config_dir,
        &data,
        session_names,
        file_tabs,
        board_tabs,
        card_tabs,
        theme,
        agent_models,
        terminal_font_size,
        auto_commit,
        agent_pause,
        superpowers,
        agent_defaults,
        git_tracking,
        require_review,
        headroom,
        launch,
        custom_resume_args,
    )
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_terminal_font_size(state: State<TerminalFontSize>) -> Option<u16> {
    *state.0.lock().unwrap()
}

/// The app-wide terminal font size. `None` clears the setting rather than
/// writing a number, which is what puts every inheriting workspace back on
/// gavin's default -- the same "there is no separate clear command" shape
/// set_theme_pref and set_session_name take.
///
/// The range is enforced here as well as in the frontend: this value goes
/// into xterm's metrics, and a config.json edited by hand to 0 would come
/// back through the same door as a picked value.
#[tauri::command]
pub fn set_terminal_font_size(
    size: Option<u16>,
    app_handle: AppHandle,
    state: State<WorkspacesState>,
    names_state: State<SessionNames>,
    file_tabs_state: State<FileTabs>,
    board_tabs_state: State<BoardTabs>,
    card_tabs_state: State<CardTabs>,
    theme_state: State<ThemePref>,
    agent_models_state: State<AgentModels>,
    font_size_state: State<TerminalFontSize>,
    auto_commit_state: State<AutoCommit>,
    agent_pause_state: State<AgentPause>,
    superpowers_state: State<SuperpowersMarks>,
    agent_defaults_state: State<AgentDefaults>,
    git_tracking_state: State<GitTrackingDefaults>,
    require_review_state: State<RequireReviewDefaults>,
    headroom_state: State<HeadroomDefaults>,
    launch_state: State<LaunchSettings>,
    custom_resume_args_state: State<CustomResumeArgs>,
) -> Result<(), String> {
    let terminal_font_size = {
        let mut current = font_size_state.0.lock().unwrap();
        *current = size.filter(|s| {
            (crate::config::MIN_TERMINAL_FONT_SIZE..=crate::config::MAX_TERMINAL_FONT_SIZE)
                .contains(s)
        });
        *current
    };
    let data = state.0.lock().unwrap().clone();
    let session_names = names_state.0.lock().unwrap().clone();
    let file_tabs = file_tabs_state.0.lock().unwrap().clone();
    let board_tabs = board_tabs_state.0.lock().unwrap().clone();
    let card_tabs = card_tabs_state.0.lock().unwrap().clone();
    let theme = theme_state.0.lock().unwrap().clone();
    let agent_models = agent_models_state.0.lock().unwrap().clone();
    let auto_commit = *auto_commit_state.0.lock().unwrap();
    let agent_pause = agent_pause_state.0.lock().unwrap().clone();
    let superpowers = superpowers_state.0.lock().unwrap().clone();
    let agent_defaults = agent_defaults_state.0.lock().unwrap().clone();
    let git_tracking = *git_tracking_state.0.lock().unwrap();
    let require_review = *require_review_state.0.lock().unwrap();
    let headroom = *headroom_state.0.lock().unwrap();
    let launch = *launch_state.0.lock().unwrap();
    let custom_resume_args = custom_resume_args_state.0.lock().unwrap().clone();
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    persist_workspaces(
        &config_dir,
        &data,
        session_names,
        file_tabs,
        board_tabs,
        card_tabs,
        theme,
        agent_models,
        terminal_font_size,
        auto_commit,
        agent_pause,
        superpowers,
        agent_defaults,
        git_tracking,
        require_review,
        headroom,
        launch,
        custom_resume_args,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_auto_commit(state: State<AutoCommit>) -> Option<bool> {
    *state.0.lock().unwrap()
}

/// The app-wide default for a new card's auto-commit block. `None` clears
/// the setting rather than writing `false`, which is what puts every
/// inheriting workspace back on gavin's own default -- the same "there is
/// no separate clear command" shape set_theme_pref and
/// set_terminal_font_size take.
#[tauri::command]
pub fn set_auto_commit(
    enabled: Option<bool>,
    app_handle: AppHandle,
    state: State<WorkspacesState>,
    names_state: State<SessionNames>,
    file_tabs_state: State<FileTabs>,
    board_tabs_state: State<BoardTabs>,
    card_tabs_state: State<CardTabs>,
    theme_state: State<ThemePref>,
    agent_models_state: State<AgentModels>,
    font_size_state: State<TerminalFontSize>,
    auto_commit_state: State<AutoCommit>,
    agent_pause_state: State<AgentPause>,
    superpowers_state: State<SuperpowersMarks>,
    agent_defaults_state: State<AgentDefaults>,
    git_tracking_state: State<GitTrackingDefaults>,
    require_review_state: State<RequireReviewDefaults>,
    headroom_state: State<HeadroomDefaults>,
    launch_state: State<LaunchSettings>,
    custom_resume_args_state: State<CustomResumeArgs>,
) -> Result<(), String> {
    let auto_commit = {
        let mut current = auto_commit_state.0.lock().unwrap();
        *current = enabled;
        *current
    };
    let data = state.0.lock().unwrap().clone();
    let session_names = names_state.0.lock().unwrap().clone();
    let file_tabs = file_tabs_state.0.lock().unwrap().clone();
    let board_tabs = board_tabs_state.0.lock().unwrap().clone();
    let card_tabs = card_tabs_state.0.lock().unwrap().clone();
    let theme = theme_state.0.lock().unwrap().clone();
    let agent_models = agent_models_state.0.lock().unwrap().clone();
    let terminal_font_size = *font_size_state.0.lock().unwrap();
    let agent_pause = agent_pause_state.0.lock().unwrap().clone();
    let superpowers = superpowers_state.0.lock().unwrap().clone();
    let agent_defaults = agent_defaults_state.0.lock().unwrap().clone();
    let git_tracking = *git_tracking_state.0.lock().unwrap();
    let require_review = *require_review_state.0.lock().unwrap();
    let headroom = *headroom_state.0.lock().unwrap();
    let launch = *launch_state.0.lock().unwrap();
    let custom_resume_args = custom_resume_args_state.0.lock().unwrap().clone();
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    persist_workspaces(
        &config_dir,
        &data,
        session_names,
        file_tabs,
        board_tabs,
        card_tabs,
        theme,
        agent_models,
        terminal_font_size,
        auto_commit,
        agent_pause,
        superpowers,
        agent_defaults,
        git_tracking,
        require_review,
        headroom,
        launch,
        custom_resume_args,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_require_review(state: State<RequireReviewDefaults>) -> Option<bool> {
    state.0.lock().unwrap().0
}

/// The app-wide default for whether a card must be reviewed before its
/// first Run (`cardReview.ts`, AG-01). `None` clears the setting rather
/// than writing `true`, which is what puts every inheriting workspace back
/// on gavin's own default (require review) -- the same "there is no
/// separate clear command" shape set_theme_pref and set_auto_commit take.
#[tauri::command]
pub fn set_require_review(
    enabled: Option<bool>,
    app_handle: AppHandle,
    state: State<WorkspacesState>,
    names_state: State<SessionNames>,
    file_tabs_state: State<FileTabs>,
    board_tabs_state: State<BoardTabs>,
    card_tabs_state: State<CardTabs>,
    theme_state: State<ThemePref>,
    agent_models_state: State<AgentModels>,
    font_size_state: State<TerminalFontSize>,
    auto_commit_state: State<AutoCommit>,
    agent_pause_state: State<AgentPause>,
    superpowers_state: State<SuperpowersMarks>,
    agent_defaults_state: State<AgentDefaults>,
    git_tracking_state: State<GitTrackingDefaults>,
    require_review_state: State<RequireReviewDefaults>,
    headroom_state: State<HeadroomDefaults>,
    launch_state: State<LaunchSettings>,
    custom_resume_args_state: State<CustomResumeArgs>,
) -> Result<(), String> {
    let require_review = {
        let mut current = require_review_state.0.lock().unwrap();
        *current = crate::config::RequireReviewDefault(enabled);
        *current
    };
    let headroom = *headroom_state.0.lock().unwrap();
    let data = state.0.lock().unwrap().clone();
    let session_names = names_state.0.lock().unwrap().clone();
    let file_tabs = file_tabs_state.0.lock().unwrap().clone();
    let board_tabs = board_tabs_state.0.lock().unwrap().clone();
    let card_tabs = card_tabs_state.0.lock().unwrap().clone();
    let theme = theme_state.0.lock().unwrap().clone();
    let agent_models = agent_models_state.0.lock().unwrap().clone();
    let terminal_font_size = *font_size_state.0.lock().unwrap();
    let auto_commit = *auto_commit_state.0.lock().unwrap();
    let agent_pause = agent_pause_state.0.lock().unwrap().clone();
    let superpowers = superpowers_state.0.lock().unwrap().clone();
    let agent_defaults = agent_defaults_state.0.lock().unwrap().clone();
    let git_tracking = *git_tracking_state.0.lock().unwrap();
    let launch = *launch_state.0.lock().unwrap();
    let custom_resume_args = custom_resume_args_state.0.lock().unwrap().clone();
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    persist_workspaces(
        &config_dir,
        &data,
        session_names,
        file_tabs,
        board_tabs,
        card_tabs,
        theme,
        agent_models,
        terminal_font_size,
        auto_commit,
        agent_pause,
        superpowers,
        agent_defaults,
        git_tracking,
        require_review,
        headroom,
        launch,
        custom_resume_args,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_headroom_default(state: State<HeadroomDefaults>) -> Option<bool> {
    state.0.lock().unwrap().0
}

/// The app-wide default for whether agents are compressed through
/// Headroom (`2026-09-28-headroom-design.md`, "The switch"). `None`
/// clears the setting rather than writing `false`, which is what puts
/// every inheriting workspace back on gavin's own default (Off) -- the
/// same "there is no separate clear command" shape `set_require_review`
/// takes.
///
/// It writes config.json and tells every window. Telling the DAEMON is
/// the frontend's, which resolves every workspace against the new
/// default and pushes the result (`set_headroom_workspaces`).
#[tauri::command]
pub fn set_headroom_default(
    enabled: Option<bool>,
    app_handle: AppHandle,
    state: State<WorkspacesState>,
    names_state: State<SessionNames>,
    file_tabs_state: State<FileTabs>,
    board_tabs_state: State<BoardTabs>,
    card_tabs_state: State<CardTabs>,
    theme_state: State<ThemePref>,
    agent_models_state: State<AgentModels>,
    font_size_state: State<TerminalFontSize>,
    auto_commit_state: State<AutoCommit>,
    agent_pause_state: State<AgentPause>,
    superpowers_state: State<SuperpowersMarks>,
    agent_defaults_state: State<AgentDefaults>,
    git_tracking_state: State<GitTrackingDefaults>,
    require_review_state: State<RequireReviewDefaults>,
    headroom_state: State<HeadroomDefaults>,
    launch_state: State<LaunchSettings>,
    custom_resume_args_state: State<CustomResumeArgs>,
) -> Result<(), String> {
    let headroom = {
        let mut current = headroom_state.0.lock().unwrap();
        *current = crate::config::HeadroomDefault(enabled);
        *current
    };
    let data = state.0.lock().unwrap().clone();
    let session_names = names_state.0.lock().unwrap().clone();
    let file_tabs = file_tabs_state.0.lock().unwrap().clone();
    let board_tabs = board_tabs_state.0.lock().unwrap().clone();
    let card_tabs = card_tabs_state.0.lock().unwrap().clone();
    let theme = theme_state.0.lock().unwrap().clone();
    let agent_models = agent_models_state.0.lock().unwrap().clone();
    let terminal_font_size = *font_size_state.0.lock().unwrap();
    let auto_commit = *auto_commit_state.0.lock().unwrap();
    let agent_pause = agent_pause_state.0.lock().unwrap().clone();
    let superpowers = superpowers_state.0.lock().unwrap().clone();
    let agent_defaults = agent_defaults_state.0.lock().unwrap().clone();
    let git_tracking = *git_tracking_state.0.lock().unwrap();
    let require_review = *require_review_state.0.lock().unwrap();
    let launch = *launch_state.0.lock().unwrap();
    let custom_resume_args = custom_resume_args_state.0.lock().unwrap().clone();
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    persist_workspaces(
        &config_dir,
        &data,
        session_names,
        file_tabs,
        board_tabs,
        card_tabs,
        theme,
        agent_models,
        terminal_font_size,
        auto_commit,
        agent_pause,
        superpowers,
        agent_defaults,
        git_tracking,
        require_review,
        headroom,
        launch,
        custom_resume_args,
    )
    .map_err(|e| e.to_string())?;
    // Every window resolves its workspaces against this, and only one of
    // them is showing Settings. The window holding the app's duties is
    // the one that tells the daemon, and it is often not that one.
    let _ = app_handle.emit("headroom-default-changed", enabled);
    Ok(())
}

#[tauri::command]
pub fn get_git_tracking_default(state: State<GitTrackingDefaults>) -> Option<bool> {
    state.0.lock().unwrap().0
}

/// The app-wide answer a NEW workspace's init starts from. `None` clears
/// the setting rather than writing `true`, so an install that never chose
/// keeps following gavin's own default -- the same shape set_theme_pref,
/// set_terminal_font_size and set_auto_commit take.
///
/// It reaches nothing that already exists. A workspace's real answer is
/// the ignore rule in its own repo, and rewriting every checkout's
/// `.gitignore` because a default moved is not a preference change, it is
/// an edit to nine repositories.
#[tauri::command]
pub fn set_git_tracking_default(
    tracked: Option<bool>,
    app_handle: AppHandle,
    state: State<WorkspacesState>,
    names_state: State<SessionNames>,
    file_tabs_state: State<FileTabs>,
    board_tabs_state: State<BoardTabs>,
    card_tabs_state: State<CardTabs>,
    theme_state: State<ThemePref>,
    agent_models_state: State<AgentModels>,
    font_size_state: State<TerminalFontSize>,
    auto_commit_state: State<AutoCommit>,
    agent_pause_state: State<AgentPause>,
    superpowers_state: State<SuperpowersMarks>,
    agent_defaults_state: State<AgentDefaults>,
    git_tracking_state: State<GitTrackingDefaults>,
    require_review_state: State<RequireReviewDefaults>,
    headroom_state: State<HeadroomDefaults>,
    launch_state: State<LaunchSettings>,
    custom_resume_args_state: State<CustomResumeArgs>,
) -> Result<(), String> {
    let git_tracking = {
        let mut current = git_tracking_state.0.lock().unwrap();
        *current = crate::config::GitTrackingDefault(tracked);
        *current
    };
    let data = state.0.lock().unwrap().clone();
    let session_names = names_state.0.lock().unwrap().clone();
    let file_tabs = file_tabs_state.0.lock().unwrap().clone();
    let board_tabs = board_tabs_state.0.lock().unwrap().clone();
    let card_tabs = card_tabs_state.0.lock().unwrap().clone();
    let theme = theme_state.0.lock().unwrap().clone();
    let agent_models = agent_models_state.0.lock().unwrap().clone();
    let terminal_font_size = *font_size_state.0.lock().unwrap();
    let auto_commit = *auto_commit_state.0.lock().unwrap();
    let agent_pause = agent_pause_state.0.lock().unwrap().clone();
    let superpowers = superpowers_state.0.lock().unwrap().clone();
    let agent_defaults = agent_defaults_state.0.lock().unwrap().clone();
    let require_review = *require_review_state.0.lock().unwrap();
    let headroom = *headroom_state.0.lock().unwrap();
    let launch = *launch_state.0.lock().unwrap();
    let custom_resume_args = custom_resume_args_state.0.lock().unwrap().clone();
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    persist_workspaces(
        &config_dir,
        &data,
        session_names,
        file_tabs,
        board_tabs,
        card_tabs,
        theme,
        agent_models,
        terminal_font_size,
        auto_commit,
        agent_pause,
        superpowers,
        agent_defaults,
        git_tracking,
        require_review,
        headroom,
        launch,
        custom_resume_args,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_session_names(state: State<SessionNames>) -> HashMap<String, String> {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_session_name(
    session_id: String,
    name: String,
    app_handle: AppHandle,
    workspaces_state: State<WorkspacesState>,
    names_state: State<SessionNames>,
    file_tabs_state: State<FileTabs>,
    board_tabs_state: State<BoardTabs>,
    card_tabs_state: State<CardTabs>,
    theme_state: State<ThemePref>,
    agent_models_state: State<AgentModels>,
    font_size_state: State<TerminalFontSize>,
    auto_commit_state: State<AutoCommit>,
    agent_pause_state: State<AgentPause>,
    superpowers_state: State<SuperpowersMarks>,
    agent_defaults_state: State<AgentDefaults>,
    git_tracking_state: State<GitTrackingDefaults>,
    require_review_state: State<RequireReviewDefaults>,
    headroom_state: State<HeadroomDefaults>,
    launch_state: State<LaunchSettings>,
    custom_resume_args_state: State<CustomResumeArgs>,
) -> Result<(), String> {
    // An empty (or whitespace-only) name clears the override rather than
    // persisting an empty string -- there's no separate "clear" command,
    // this is the one way a rename can be undone.
    let session_names = {
        let mut names = names_state.0.lock().unwrap();
        let trimmed = name.trim();
        if trimmed.is_empty() {
            names.remove(&session_id);
        } else {
            names.insert(session_id, trimmed.to_string());
        }
        names.clone()
    };
    let file_tabs = file_tabs_state.0.lock().unwrap().clone();
    let board_tabs = board_tabs_state.0.lock().unwrap().clone();
    let card_tabs = card_tabs_state.0.lock().unwrap().clone();
    let data = workspaces_state.0.lock().unwrap().clone();
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let theme = theme_state.0.lock().unwrap().clone();
    let agent_models = agent_models_state.0.lock().unwrap().clone();
    let terminal_font_size = *font_size_state.0.lock().unwrap();
    let auto_commit = *auto_commit_state.0.lock().unwrap();
    let agent_pause = agent_pause_state.0.lock().unwrap().clone();
    let superpowers = superpowers_state.0.lock().unwrap().clone();
    let agent_defaults = agent_defaults_state.0.lock().unwrap().clone();
    let git_tracking = *git_tracking_state.0.lock().unwrap();
    let require_review = *require_review_state.0.lock().unwrap();
    let headroom = *headroom_state.0.lock().unwrap();
    let launch = *launch_state.0.lock().unwrap();
    let custom_resume_args = custom_resume_args_state.0.lock().unwrap().clone();
    persist_workspaces(
        &config_dir,
        &data,
        session_names,
        file_tabs,
        board_tabs,
        card_tabs,
        theme,
        agent_models,
        terminal_font_size,
        auto_commit,
        agent_pause,
        superpowers,
        agent_defaults,
        git_tracking,
        require_review,
        headroom,
        launch,
        custom_resume_args,
    )
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_file_tabs(state: State<FileTabs>) -> HashMap<String, String> {
    state.0.lock().unwrap().clone()
}

/// Replaces the whole file-tab map. Whole-map rather than per-tab
/// (unlike `set_session_name`) because Part 2's callers always mutate it
/// alongside a pane-tree change they're already persisting wholesale --
/// there is no "rename one file tab" operation the way there is for
/// session names.
#[tauri::command]
pub fn set_file_tabs(
    file_tabs: HashMap<String, String>,
    app_handle: AppHandle,
    workspaces_state: State<WorkspacesState>,
    names_state: State<SessionNames>,
    file_tabs_state: State<FileTabs>,
    board_tabs_state: State<BoardTabs>,
    card_tabs_state: State<CardTabs>,
    theme_state: State<ThemePref>,
    agent_models_state: State<AgentModels>,
    font_size_state: State<TerminalFontSize>,
    auto_commit_state: State<AutoCommit>,
    agent_pause_state: State<AgentPause>,
    superpowers_state: State<SuperpowersMarks>,
    agent_defaults_state: State<AgentDefaults>,
    git_tracking_state: State<GitTrackingDefaults>,
    require_review_state: State<RequireReviewDefaults>,
    headroom_state: State<HeadroomDefaults>,
    launch_state: State<LaunchSettings>,
    custom_resume_args_state: State<CustomResumeArgs>,
) -> Result<(), String> {
    *file_tabs_state.0.lock().unwrap() = file_tabs.clone();
    let session_names = names_state.0.lock().unwrap().clone();
    let board_tabs = board_tabs_state.0.lock().unwrap().clone();
    let card_tabs = card_tabs_state.0.lock().unwrap().clone();
    let data = workspaces_state.0.lock().unwrap().clone();
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let theme = theme_state.0.lock().unwrap().clone();
    let agent_models = agent_models_state.0.lock().unwrap().clone();
    let terminal_font_size = *font_size_state.0.lock().unwrap();
    let auto_commit = *auto_commit_state.0.lock().unwrap();
    let agent_pause = agent_pause_state.0.lock().unwrap().clone();
    let superpowers = superpowers_state.0.lock().unwrap().clone();
    let agent_defaults = agent_defaults_state.0.lock().unwrap().clone();
    let git_tracking = *git_tracking_state.0.lock().unwrap();
    let require_review = *require_review_state.0.lock().unwrap();
    let headroom = *headroom_state.0.lock().unwrap();
    let launch = *launch_state.0.lock().unwrap();
    let custom_resume_args = custom_resume_args_state.0.lock().unwrap().clone();
    persist_workspaces(
        &config_dir,
        &data,
        session_names,
        file_tabs,
        board_tabs,
        card_tabs,
        theme,
        agent_models,
        terminal_font_size,
        auto_commit,
        agent_pause,
        superpowers,
        agent_defaults,
        git_tracking,
        require_review,
        headroom,
        launch,
        custom_resume_args,
    )
        .map_err(|e| e.to_string())
}

/// Open per-context board tabs (tab id -> BoardTabRecord). Same
/// always-carry persistence contract as FileTabs.
pub struct BoardTabs(pub Mutex<HashMap<String, crate::config::BoardTabRecord>>);

/// App-global light/dark preference: "light", "dark", or None for
/// System. Same always-carry persistence contract as FileTabs/BoardTabs.
pub struct ThemePref(pub Mutex<Option<String>>);

/// App-wide terminal font size in px, or None when nobody has chosen one
/// and gavin's own default applies. Same always-carry persistence contract
/// as ThemePref -- and the same reason for storing absence rather than the
/// default number: a config that spells out today's default would pin
/// every existing install to it the day the default moves.
pub struct TerminalFontSize(pub Mutex<Option<u16>>);

/// App-wide default for a new card's auto-commit block, or None when
/// nobody has chosen and gavin's own default (off) applies. Same
/// always-carry persistence contract as ThemePref, and the same reason for
/// storing absence rather than `false`: a config that spelled out today's
/// default would pin every existing install to it the day the default
/// moves.
pub struct AutoCommit(pub Mutex<Option<bool>>);

/// Open card tabs (tab id -> which card, and which of its two views).
/// Same always-carry persistence contract as `FileTabs`/`BoardTabs`, and
/// the same reason it exists at all: a tab id the frontend cannot
/// classify is taken to be a terminal session, so a card tab whose entry
/// went missing would come back from a restart as a shell rather than as
/// nothing.
pub struct CardTabs(pub Mutex<HashMap<String, crate::config::CardTabRecord>>);

#[tauri::command]
pub fn get_card_tabs(state: State<CardTabs>) -> HashMap<String, crate::config::CardTabRecord> {
    state.0.lock().unwrap().clone()
}

/// Replaces the whole card-tab map -- whole-map for the same reason as
/// set_file_tabs/set_board_tabs: callers always mutate it alongside a
/// pane-tree change they're already persisting wholesale.
#[tauri::command]
pub fn set_card_tabs(
    card_tabs: HashMap<String, crate::config::CardTabRecord>,
    app_handle: AppHandle,
    workspaces_state: State<WorkspacesState>,
    names_state: State<SessionNames>,
    file_tabs_state: State<FileTabs>,
    board_tabs_state: State<BoardTabs>,
    card_tabs_state: State<CardTabs>,
    theme_state: State<ThemePref>,
    agent_models_state: State<AgentModels>,
    font_size_state: State<TerminalFontSize>,
    auto_commit_state: State<AutoCommit>,
    agent_pause_state: State<AgentPause>,
    superpowers_state: State<SuperpowersMarks>,
    agent_defaults_state: State<AgentDefaults>,
    git_tracking_state: State<GitTrackingDefaults>,
    require_review_state: State<RequireReviewDefaults>,
    headroom_state: State<HeadroomDefaults>,
    launch_state: State<LaunchSettings>,
    custom_resume_args_state: State<CustomResumeArgs>,
) -> Result<(), String> {
    *card_tabs_state.0.lock().unwrap() = card_tabs.clone();
    let session_names = names_state.0.lock().unwrap().clone();
    let file_tabs = file_tabs_state.0.lock().unwrap().clone();
    let board_tabs = board_tabs_state.0.lock().unwrap().clone();
    let data = workspaces_state.0.lock().unwrap().clone();
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let theme = theme_state.0.lock().unwrap().clone();
    let agent_models = agent_models_state.0.lock().unwrap().clone();
    let terminal_font_size = *font_size_state.0.lock().unwrap();
    let auto_commit = *auto_commit_state.0.lock().unwrap();
    let agent_pause = agent_pause_state.0.lock().unwrap().clone();
    let superpowers = superpowers_state.0.lock().unwrap().clone();
    let agent_defaults = agent_defaults_state.0.lock().unwrap().clone();
    let git_tracking = *git_tracking_state.0.lock().unwrap();
    let require_review = *require_review_state.0.lock().unwrap();
    let headroom = *headroom_state.0.lock().unwrap();
    let launch = *launch_state.0.lock().unwrap();
    let custom_resume_args = custom_resume_args_state.0.lock().unwrap().clone();
    persist_workspaces(
        &config_dir,
        &data,
        session_names,
        file_tabs,
        board_tabs,
        card_tabs,
        theme,
        agent_models,
        terminal_font_size,
        auto_commit,
        agent_pause,
        superpowers,
        agent_defaults,
        git_tracking,
        require_review,
        headroom,
        launch,
        custom_resume_args,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_board_tabs(state: State<BoardTabs>) -> HashMap<String, crate::config::BoardTabRecord> {
    state.0.lock().unwrap().clone()
}

/// Replaces the whole board-tab map -- whole-map for the same reason as
/// set_file_tabs: callers always mutate it alongside a pane-tree change
/// they're already persisting wholesale.
#[tauri::command]
pub fn set_board_tabs(
    board_tabs: HashMap<String, crate::config::BoardTabRecord>,
    app_handle: AppHandle,
    workspaces_state: State<WorkspacesState>,
    names_state: State<SessionNames>,
    file_tabs_state: State<FileTabs>,
    board_tabs_state: State<BoardTabs>,
    card_tabs_state: State<CardTabs>,
    theme_state: State<ThemePref>,
    agent_models_state: State<AgentModels>,
    font_size_state: State<TerminalFontSize>,
    auto_commit_state: State<AutoCommit>,
    agent_pause_state: State<AgentPause>,
    superpowers_state: State<SuperpowersMarks>,
    agent_defaults_state: State<AgentDefaults>,
    git_tracking_state: State<GitTrackingDefaults>,
    require_review_state: State<RequireReviewDefaults>,
    headroom_state: State<HeadroomDefaults>,
    launch_state: State<LaunchSettings>,
    custom_resume_args_state: State<CustomResumeArgs>,
) -> Result<(), String> {
    *board_tabs_state.0.lock().unwrap() = board_tabs.clone();
    let card_tabs = card_tabs_state.0.lock().unwrap().clone();
    let session_names = names_state.0.lock().unwrap().clone();
    let file_tabs = file_tabs_state.0.lock().unwrap().clone();
    let data = workspaces_state.0.lock().unwrap().clone();
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let theme = theme_state.0.lock().unwrap().clone();
    let agent_models = agent_models_state.0.lock().unwrap().clone();
    let terminal_font_size = *font_size_state.0.lock().unwrap();
    let auto_commit = *auto_commit_state.0.lock().unwrap();
    let agent_pause = agent_pause_state.0.lock().unwrap().clone();
    let superpowers = superpowers_state.0.lock().unwrap().clone();
    let agent_defaults = agent_defaults_state.0.lock().unwrap().clone();
    let git_tracking = *git_tracking_state.0.lock().unwrap();
    let require_review = *require_review_state.0.lock().unwrap();
    let headroom = *headroom_state.0.lock().unwrap();
    let launch = *launch_state.0.lock().unwrap();
    let custom_resume_args = custom_resume_args_state.0.lock().unwrap().clone();
    persist_workspaces(
        &config_dir,
        &data,
        session_names,
        file_tabs,
        board_tabs,
        card_tabs,
        theme,
        agent_models,
        terminal_font_size,
        auto_commit,
        agent_pause,
        superpowers,
        agent_defaults,
        git_tracking,
        require_review,
        headroom,
        launch,
        custom_resume_args,
    )
        .map_err(|e| e.to_string())
}

/// Set once (`AtomicBool`, not a one-shot channel — a one-shot signal sent
/// before anyone is waiting on it would be lost) when the frontend confirms
/// its event listeners are registered. Managed via `Builder::manage` before
/// `.setup()` runs (not inside it — window creation can precede the setup
/// closure), so `signal_frontend_ready` is always valid to call.
pub struct FrontendReady(pub std::sync::atomic::AtomicBool);

/// Set if `bootstrap` fails before it can emit `daemon-error` to a listener
/// that might not exist yet. Same eager-`manage` rationale as `FrontendReady`.
pub struct BootstrapError(pub Mutex<Option<String>>);

/// Bumped on every deliberate reconnect (`reconnect`). A relay thread
/// captures the epoch it was spawned in and reports a disconnect only
/// while that epoch is still current -- without it, the OLD thread's
/// "daemon closed the connection" would throw the connection-error
/// overlay over a restart the human just asked for.
///
/// An epoch rather than a "restarting" flag: the old thread can notice
/// its socket close at any point, including after the new connection is
/// already live and serving, and a flag lowered at the end of the
/// restart would still race it. An epoch it can never win.
pub struct ConnectionEpoch(pub std::sync::atomic::AtomicU64);

#[tauri::command]
pub fn signal_frontend_ready(state: State<FrontendReady>) {
    state.0.store(true, std::sync::atomic::Ordering::SeqCst);
}

#[tauri::command]
pub fn get_bootstrap_error(state: State<BootstrapError>) -> Option<String> {
    state.0.lock().unwrap().clone()
}

/// Restarts `gavin-daemon` and puts this app back on it.
///
/// Two paths, both ending fully connected. If the app never bootstrapped
/// (a version mismatch or missing daemon at startup, behind the
/// connection-error overlay) it kills whatever is running, clears the
/// stale bootstrap error and bootstraps cleanly. If it HAS bootstrapped
/// -- the Settings button, with a live app around it -- it reconnects in
/// place; see `reconnect` for why that is not simply "bootstrap again".
///
/// Restarting is destructive to sessions and callers must say so first.
/// `SessionManager::recover` does not reattach to the old PTYs: it spawns
/// a fresh BARE SHELL in each surviving record's cwd and marks the record
/// `interrupted`. Every running agent is stopped, and none of them is
/// restarted -- an agent's command carries its whole prompt, so re-running
/// it would be a second from-scratch attempt at the same work rather than
/// a recovery.
///
/// "They die with the daemon" is what this comment used to claim, and it
/// is not enforced anywhere: killing the daemon reaches a child only as
/// the SIGHUP a closing PTY master sends, and a child that ignores SIGHUP
/// survives, reparented to init (verified under a temp $HOME). That is
/// precisely why recovery must not re-run a command -- the alternative is
/// two agents editing one checkout.
///
/// `token` is the grant `confirm_gate` minted when the human answered
/// the restart prompt. BOTH branches below run `stop_running_daemon`,
/// and the daemon on this socket is shared with every other gavin window
/// pointed at it: an in-page script calling this used to be a one-line
/// denial of service on somebody else's sessions (AS-05/R5). All four
/// routes to it -- Settings, the sessions manager, the compat banner and
/// the connection-error overlay -- now ask first. What it can no longer
/// be is a denial of service on a daemon this app never connected to:
/// the forceful half is aimed at the pid serving THIS socket, not at
/// everything named gavin-daemon.
///
/// Off the main thread: the stop alone waits up to ~0.9 s, the respawn
/// up to 3 s more, and it then runs the version probe, both `Hello`s, an
/// `Attach` per session and a watch per workspace -- from the error
/// overlay a whole `bootstrap`. The token is spent here, before any of
/// that, and a restart already under way refuses this one
/// (`DaemonRestart`).
#[tauri::command]
pub async fn restart_daemon(
    app_handle: AppHandle,
    token: String,
    gate: State<'_, crate::confirm_gate::ConfirmGate>,
    restart: State<'_, DaemonRestart>,
) -> Result<(), String> {
    crate::confirm_gate::spend(
        &gate,
        &token,
        "restart_daemon",
        crate::confirm_gate::DAEMON_SUBJECT,
    )?;
    let claim = restart.claim()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _claim = claim;
        restart_blocking(app_handle).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn restart_blocking(app_handle: AppHandle) -> anyhow::Result<()> {
    if app_handle.try_state::<DaemonConnection>().is_some() {
        return reconnect(&app_handle);
    }
    crate::daemon::stop_running_daemon(&socket_path()?)?;
    if let Some(state) = app_handle.try_state::<BootstrapError>() {
        *state.0.lock().unwrap() = None;
    }
    bootstrap(app_handle)
}

/// One restart or stop of the daemon at a time.
///
/// Both used to hold the main thread from start to finish, which kept a
/// second one out as a side effect. Off it, two can overlap -- a double
/// click, two windows, the Settings button beside the compat banner --
/// and the second one's stop would kill the daemon the first had just
/// spawned, halfway through its handshake, with both swapping the same
/// connections. So the second is refused instead.
///
/// Not taken by the startup `bootstrap`: a daemon that accepts and never
/// answers could hold that one for as long as the handshake deadline,
/// and Restart on the error overlay is how the human gets out of it.
#[derive(Default)]
pub struct DaemonRestart(Arc<std::sync::atomic::AtomicBool>);

impl DaemonRestart {
    fn claim(&self) -> Result<DaemonRestartClaim, String> {
        use std::sync::atomic::Ordering::SeqCst;
        self.0
            .compare_exchange(false, true, SeqCst, SeqCst)
            .map_err(|_| "the gavin daemon is already being restarted or stopped".to_string())?;
        Ok(DaemonRestartClaim(Arc::clone(&self.0)))
    }
}

/// Lets the next restart in when dropped -- on the blocking pool, once
/// the work is done or has panicked.
struct DaemonRestartClaim(Arc<std::sync::atomic::AtomicBool>);

impl Drop for DaemonRestartClaim {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Stops the daemon on this build's endpoint and leaves it stopped.
///
/// The difference from `restart_daemon` is the whole point of the
/// command: that one exists to bring the daemon back, and every route to
/// it is a human saying "this connection is wedged". This one is the
/// close prompt's bottom rung -- the human is done for the day and is
/// asking, deliberately, for the work to stop outliving the window.
///
/// So: no `reconnect`, and no `bootstrap`. Rewiring the app onto a
/// daemon nobody asked for is the one thing that rung promises will not
/// happen. The connection epoch is still bumped first, so the relay
/// thread goes quiet instead of logging a closed socket at a window that
/// is already on its way out.
///
/// `token` is the grant `confirm_gate` minted when the human picked the
/// rung. Like the restart, it is aimed at the pid serving THIS socket
/// rather than at everything named gavin-daemon: a release install and a
/// dev build keep separate endpoints, and stopping one must not reach
/// the other.
///
/// Off the main thread like the restart, and refused while one is under
/// way: a stop in the middle of a restart would kill the daemon that
/// restart is handshaking.
#[tauri::command]
pub async fn stop_daemon(
    app_handle: AppHandle,
    token: String,
    gate: State<'_, crate::confirm_gate::ConfirmGate>,
    restart: State<'_, DaemonRestart>,
) -> Result<(), String> {
    crate::confirm_gate::spend(
        &gate,
        &token,
        "stop_daemon",
        crate::confirm_gate::DAEMON_SUBJECT,
    )?;
    let claim = restart.claim()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _claim = claim;
        if let Some(epoch) = app_handle.try_state::<ConnectionEpoch>() {
            epoch.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
        let socket = socket_path().map_err(|e| e.to_string())?;
        crate::daemon::stop_running_daemon(&socket).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Rewires a running app onto a freshly restarted daemon, with no
/// relaunch.
///
/// The obvious implementation -- call `bootstrap` again -- cannot work:
/// it publishes the connections with `app_handle.manage(...)`, and
/// Tauri's `manage` keeps the first value for a given type, so the second
/// call would leave the app writing to the dead socket. (That is exactly
/// why this command used to return "restarted, now relaunch".)
///
/// But the state does not need replacing. The streaming writer is a
/// mutex around a `Stream` and the command lanes take a new connection
/// through their own queue, so a reconnect hands fresh connections to
/// the ones the app is holding, and every command that borrows them
/// keeps working untouched.
///
/// The lanes refuse requests from before the daemon is stopped until the
/// new connections are in: a request made meanwhile fails at once rather
/// than riding a socket to the daemon being killed, or reaching the new
/// one before its version verdict is published. The streaming connection
/// refuses keystrokes, resizes and repaints for the whole reconnect, and
/// takes them again only once every session is attached on the new one.
fn reconnect(app_handle: &AppHandle) -> anyhow::Result<()> {
    use std::sync::atomic::Ordering::SeqCst;
    let command = app_handle.state::<CommandConnection>();
    let stream = app_handle.state::<DaemonConnection>();
    stream.swapping.store(true, SeqCst);
    command.begin_swap();
    let reconnected = reconnect_swapping(app_handle, &command);
    if reconnected.is_err() {
        command.abort_swap();
    }
    stream.swapping.store(false, SeqCst);
    reconnected
}

fn reconnect_swapping(app_handle: &AppHandle, command: &CommandConnection) -> anyhow::Result<()> {
    // Bump BEFORE killing: the old relay thread notices its socket close
    // almost immediately, and this is the only thing keeping it quiet.
    app_handle.state::<ConnectionEpoch>().0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    crate::daemon::stop_running_daemon(&socket_path()?)?;
    if let Some(state) = app_handle.try_state::<BootstrapError>() {
        *state.0.lock().unwrap() = None;
    }

    let socket = socket_path()?;
    let mut stream_conn = crate::daemon::connect_or_spawn(
        &socket,
        Duration::from_secs(3),
        crate::daemon::spawn_real_daemon,
    )?;
    handshake_deadline(&stream_conn, true);
    let probe = Mutex::new(connect_for_handshake(&socket)?);
    // Verified before ANYTHING is swapped in: a daemon that fails the
    // version probe must leave a named error and an app that is merely
    // disconnected, never one wired half onto each daemon.
    let compat = verify_daemon_protocol(&probe)?;
    // Re-present identity on the fresh connections: a restart can hand
    // back a differently-versioned (or freshly-token'd) daemon, so the
    // handshake and its proof run again before either connection is
    // published.
    app_handshake(&compat, &probe, &mut stream_conn)?;
    // The relay reads this one for as long as the app runs.
    handshake_deadline(&stream_conn, false);

    // A restart can hand the app a differently-versioned daemon than the
    // one it started with -- refresh the stored verdict BEFORE either
    // connection is repointed at the new daemon. A concurrent Tauri
    // command reads this state via `current_compat` and gates its
    // `send_request` against it; if the verdict still described the
    // outgoing daemon while the writer below already pointed at the
    // incoming one, that command could pass the gate and write a request
    // the new (older) daemon can't parse -- closing the connection and
    // taking every push riding on it down with it, the exact failure this
    // compatibility window exists to prevent. `compat` was already
    // computed above via `verify_daemon_protocol`, and `DaemonCompat` is
    // `Copy`, so this is a pure reorder.
    *app_handle.state::<DaemonCompatState>().0.lock().unwrap() = Some(compat);

    let reads = open_command_stream(&socket, &compat)?;
    let writer = app_handle.state::<DaemonConnection>().writer.clone();
    writer.replace(stream_conn.try_clone()?);
    command.finish_swap(
        probe.into_inner().expect("protocol probe mutex poisoned"),
        reads,
        compat.daemon_version,
    );

    let data = app_handle.state::<WorkspacesState>().0.lock().unwrap().clone();
    let non_session_tab_ids = non_session_tab_ids(
        &app_handle.state::<FileTabs>().0.lock().unwrap(),
        &app_handle.state::<BoardTabs>().0.lock().unwrap(),
        &app_handle.state::<CardTabs>().0.lock().unwrap(),
    );
    attach_and_relay(
        app_handle,
        &writer,
        stream_conn,
        attachable_session_ids(&data, &non_session_tab_ids),
        compat,
        RelayOwner::Local,
    )?;

    // The daemon's gavin watchers were per-connection and died with it.
    // Re-armed here rather than from the frontend because this is where
    // the new connection exists: miss it and the Plans, Kanban and
    // Orchestration tabs go quietly dead after a restart -- the exact
    // failure the fs-sync work just removed. An ssh workspace's watcher
    // is on its host's daemon, which this restart never touched.
    for ws in data.workspaces.iter().filter(|w| w.ssh.is_none()) {
        if let Some(root) = &ws.root_path {
            send_request(
                &writer,
                &Request::WatchGavinRoot {
                    workspace_id: ws.id.clone(),
                    root_path: root.clone(),
                },
                &compat,
            )?;
        }
    }
    Ok(())
}

/// The wire guard. An older daemon cannot PARSE a request it predates,
/// and a parse error there closes the whole connection (see
/// handle_connection) -- taking every push with it. So the check has to
/// happen here, before the bytes leave, not as error handling after.
pub fn gate(req: &Request, compat: &DaemonCompat) -> Result<(), String> {
    // The predicate is `protocol::gate_request`, shared with gavin-mcp so
    // both clients refuse the same requests against the same daemon. Only
    // the advice is ours: the app has a Restart daemon button to point at.
    protocol::gate_request(req, compat.daemon_version)
        .map_err(|gated| format!("this {gated} — restart the daemon to use it"))
}

/// Gates `req` and queues it on a streaming connection, returning without
/// waiting for the daemon to read it (`stream_writer.rs`).
pub(crate) fn send_request(
    writer: &StreamWriter,
    req: &Request,
    compat: &DaemonCompat,
) -> anyhow::Result<()> {
    gate(req, compat).map_err(|e| anyhow::anyhow!(e))?;
    writer.send(req)
}

/// The command lanes a route names: a link's, or the local daemon's with
/// the local verdict. Every routed command goes through here or
/// `with_writer`, so "which daemon" is decided in one place per command
/// and the local path stays what it was.
///
/// A command awaits what it sends on these (`DaemonLanes::request`),
/// which is what keeps its daemon round trip off the main thread.
pub(crate) fn lanes_for(
    route: crate::remote::Route,
    state: &CommandConnection,
    compat: &DaemonCompatState,
) -> DaemonLanes {
    match route {
        crate::remote::Route::Remote(link) => link.lanes(),
        crate::remote::Route::Local => state.lanes(current_compat(compat)),
    }
}

/// `lanes_for` for the streaming connection's writer -- `Attach`,
/// `WriteInput`, `ResizeSession`, `Snapshot`, `WatchGavinRoot`.
///
/// Refused on the local daemon while a restart swaps it (`reconnect`),
/// without calling `f`.
pub(crate) fn with_writer<R>(
    route: crate::remote::Route,
    state: &DaemonConnection,
    compat: &DaemonCompatState,
    f: impl FnOnce(&StreamWriter, &DaemonCompat) -> anyhow::Result<R>,
) -> anyhow::Result<R> {
    match route {
        crate::remote::Route::Remote(link) => f(&link.writer, &link.compat),
        crate::remote::Route::Local => {
            state.admit()?;
            f(&state.writer, &current_compat(compat))
        }
    }
}

/// The local daemon's request/response connections, one worker thread
/// each (`command_lane.rs`).
///
/// Kept apart from the streaming connection (DaemonConnection), whose
/// background thread continuously reads Output/SessionExited off the
/// socket — reading a CreateSession reply off *that* connection would
/// race the relay thread for bytes, with no way to tell which reply
/// belongs to which request. Each lane's worker runs one
/// request-then-response cycle at a time, which is what makes correlation
/// unambiguous without the daemon protocol needing a request-id field.
///
/// Two lanes because the daemon serves each connection on one thread,
/// strictly in order: `reads` carries the reads that can take seconds
/// (`command_lane::is_slow_read`), so a tree rescan never holds a
/// `set_step_run` behind it.
pub struct CommandConnection {
    main: CommandLane,
    reads: CommandLane,
}

impl CommandConnection {
    /// Lanes over two connections to the local daemon at `socket`, both
    /// already probed and handshaken. A lane that loses its connection
    /// redials `socket` and presents the app again.
    fn new(socket: &Path, main: Stream, reads: Stream, compat: &DaemonCompat) -> CommandConnection {
        let redial = || Some(Redial { endpoint: socket.to_path_buf(), token: read_daemon_token });
        CommandConnection {
            main: CommandLane::spawn("the gavin daemon", main, compat.daemon_version, redial()),
            reads: CommandLane::spawn("the gavin daemon", reads, compat.daemon_version, redial()),
        }
    }

    pub(crate) fn lanes(&self, compat: DaemonCompat) -> DaemonLanes {
        DaemonLanes::new(self.main.clone(), self.reads.clone(), compat)
    }

    /// The pid of the daemon this app is talking to, as the kernel named
    /// the main lane's connection (`CommandLane::server_pid`).
    pub(crate) fn server_pid(&self) -> Option<u32> {
        self.main.server_pid()
    }

    fn begin_swap(&self) {
        self.main.begin_swap();
        self.reads.begin_swap();
    }

    fn finish_swap(&self, main: Stream, reads: Stream, version: u32) {
        self.main.finish_swap(main, version);
        self.reads.finish_swap(reads, version);
    }

    fn abort_swap(&self) {
        self.main.abort_swap();
        self.reads.abort_swap();
    }
}

/// One more command connection to the local daemon, with the app
/// presented on it the way `app_handshake` presents it on the first --
/// for the reads lane, which must not run as `local` any more than the
/// main one does.
fn open_command_stream(socket: &Path, compat: &DaemonCompat) -> anyhow::Result<Stream> {
    let conn = Mutex::new(connect_for_handshake(socket)?);
    if compat.daemon_version >= HELLO_MIN_VERSION {
        if let Some(token) = read_daemon_token() {
            app_handshake_command(&conn, &token)?;
        }
    }
    Ok(conn.into_inner().expect("command connection mutex poisoned"))
}

/// How long each reply may take while the app presents itself to a
/// daemon it has just connected to: the version probe and the `Hello`s.
/// Without it, a daemon that accepts and never answers held bootstrap --
/// and a restart, which held the main thread with it -- with no end.
const HANDSHAKE_DEADLINE: Duration = Duration::from_secs(10);

/// Bounds every read on `stream` by `HANDSHAKE_DEADLINE`, or lifts the
/// bound again. A failure is ignored: the one way this fails is macOS
/// refusing SO_RCVTIMEO on a socket whose peer has already closed, and a
/// read on that cannot block anyway (command_lane.rs's `read_reply`).
fn handshake_deadline(stream: &Stream, bounded: bool) {
    let _ = stream.set_read_timeout(bounded.then_some(HANDSHAKE_DEADLINE));
}

/// A command connection to the local daemon, ready for its handshake.
/// Left bounded: a command lane sets its own deadline before every read.
fn connect_for_handshake(socket: &Path) -> anyhow::Result<Stream> {
    let stream = Stream::connect(socket)?;
    handshake_deadline(&stream, true);
    Ok(stream)
}

/// What the app negotiated with the daemon it just connected to.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonCompat {
    pub daemon_version: u32,
    pub app_version: u32,
    /// True when the daemon is older than us but still inside the
    /// window: usable, with the newer requests gated off.
    pub degraded: bool,
}

/// Holds the verdict from the most recent `verify_daemon_protocol` call, so
/// commands issued later (and, eventually, the frontend) can see whether
/// they're talking to a degraded daemon without re-probing it. `None`
/// until the first successful probe.
pub struct DaemonCompatState(pub Mutex<Option<DaemonCompat>>);

/// The verdict for a `#[tauri::command]` to `gate` its own `send_request`
/// calls against. `DaemonCompatState` is `.manage()`d at app setup (see
/// lib.rs) and only ever turns `Some` -- both `bootstrap` and `reconnect`
/// populate it before they publish (`bootstrap`, via `.manage()`) or
/// repoint (`reconnect`, by overwriting the `Mutex`es in place) the
/// connection state a command would need to even be reachable -- so
/// `None` here means a command ran before bootstrap finished, which
/// should not be possible, and a command that does run never sees a
/// verdict for a daemon other than the one its connection currently
/// points at.
pub(crate) fn current_compat(state: &DaemonCompatState) -> DaemonCompat {
    state.0.lock().unwrap().expect("DaemonCompatState populated before any command runs")
}

/// Wraps `protocol::version_band` -- too new (hard error: this app has no
/// idea how to speak an unreleased protocol newer than its own), too old
/// (below `floor`, i.e. `MIN_COMPATIBLE_VERSION`, so the daemon predates
/// the oldest request shape this app still knows how to send), or inside
/// the window, usable at parity or degraded.
///
/// The arithmetic moved to `protocol` when gavin-mcp was brought into the
/// same window; what stays here is this app's WORDING and its
/// `DaemonCompat`, which is a serde contract with the frontend
/// (`app/src/lib/daemonCompat.ts`). Pure so the bands are testable without
/// a daemon. Split out of `verify_daemon_protocol`, which owns the I/O.
pub fn classify(daemon: u32, app: u32, floor: u32) -> Result<DaemonCompat, String> {
    match protocol::version_band(daemon, app, floor) {
        protocol::VersionBand::DaemonNewer => Err(format!(
            "the gavin daemon is newer than this app (v{daemon} vs v{app}) — update the app"
        )),
        protocol::VersionBand::DaemonTooOld => Err(format!(
            "the gavin daemon is too old to use (v{daemon}, minimum v{floor}) — restart it"
        )),
        protocol::VersionBand::Usable { degraded } => {
            Ok(DaemonCompat { daemon_version: daemon, app_version: app, degraded })
        }
    }
}

/// Spec §4: probe the daemon's protocol version before anything else.
/// Interprets FAILURE SHAPE -- a daemon older than the probe itself can't
/// parse the request and closes the connection, which must map to the
/// same actionable message as an explicit lower version (this turned the
/// 2026-08-07 stale-daemon incident's mystery close into a named state).
pub(crate) fn verify_daemon_protocol(command_conn: &Mutex<Stream>) -> anyhow::Result<DaemonCompat> {
    const UNREACHABLE: &str = "the gavin daemon is too old to talk to this app — restart it (quit gavin, then relaunch)";
    match send_command(command_conn, &Request::GetProtocolVersion) {
        Ok(Response::ProtocolVersion { version }) => {
            classify(version, protocol::PROTOCOL_VERSION, protocol::MIN_COMPATIBLE_VERSION)
                .map_err(|e| anyhow::anyhow!(e))
        }
        // Not the old-daemon shape below: it took the connection and
        // then said nothing at all. Calling that "too old" would send the
        // human after a version problem they do not have.
        Err(e) if crate::command_lane::timed_out(&e) => {
            anyhow::bail!("the gavin daemon took the connection but never answered — restart it")
        }
        // A daemon too old to parse the probe closes the connection.
        // Preserved from the 2026-08-07 stale-daemon incident: this
        // failure SHAPE has to map to the same named state as an
        // explicit too-low version, not to a mystery.
        Ok(_) | Err(_) => anyhow::bail!(UNREACHABLE),
    }
}

fn send_command(conn: &Mutex<Stream>, req: &Request) -> anyhow::Result<Response> {
    let mut stream = conn.lock().unwrap();
    write_message(&mut *stream, req)?;
    let mut reader = BufReader::new(&mut *stream);
    read_message(&mut reader)?
        .ok_or_else(|| anyhow::anyhow!("daemon closed the command connection"))
}

/// The daemon token the daemon wrote `0600` at startup
/// (`sec-fix-client-identity.md`). `None` when the file is absent -- an
/// older daemon that never wrote one, or a first launch racing the write
/// (the connect that spawned the daemon has already returned by the time
/// this is read, and the token is written before the socket binds, so this
/// only ever misses against a pre-v35 daemon).
pub(crate) fn read_daemon_token() -> Option<String> {
    std::fs::read_to_string(protocol::daemon_token_path().ok()?)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Check a `HelloAck` the app received: the daemon must have granted the
/// `app` role and returned a `server_proof` equal to HMAC(token, nonce).
/// A mismatch is the DP-06 case -- the app connected to something holding
/// the socket path that does NOT hold the token -- and is a hard error.
pub(crate) fn verify_app_ack(ack: Response, token: &str, nonce: &str) -> anyhow::Result<()> {
    match ack {
        Response::HelloAck { role, server_proof, .. } => {
            if role != "app" {
                anyhow::bail!("the daemon did not accept this app's token (role: {role})");
            }
            let expected = protocol::server_proof(token, nonce);
            if server_proof.as_deref() != Some(expected.as_str()) {
                anyhow::bail!(
                    "the gavin daemon's identity proof did not match — the socket may be held by \
                     another process; quit gavin and relaunch"
                );
            }
            Ok(())
        }
        other => anyhow::bail!("unexpected reply to Hello: {other:?}"),
    }
}

/// Send a `Hello` with the daemon token on the command connection and
/// verify the proof. The command connection has already exchanged the
/// version probe, which is fine: `Hello` need only be the first *Hello*,
/// and both real clients probe the version before it.
fn app_handshake_command(conn: &Mutex<Stream>, token: &str) -> anyhow::Result<()> {
    let nonce = protocol::random_hex(16)?;
    let ack = send_command(
        conn,
        &Request::Hello {
            client: "app".to_string(),
            protocol_version: protocol::PROTOCOL_VERSION,
            auth: protocol::HelloAuth::DaemonToken { token: token.to_string() },
            nonce: nonce.clone(),
        },
    )?;
    verify_app_ack(ack, token, &nonce)
}

/// Send a `Hello` with the daemon token directly on the streaming
/// connection and verify the proof. Read with a one-byte reader so no push
/// that follows the ack is swallowed -- the same hazard the daemon tests'
/// `line_reader` guards, though at bootstrap nothing is attached yet.
fn app_handshake_stream(stream: &mut Stream, token: &str) -> anyhow::Result<()> {
    let nonce = protocol::random_hex(16)?;
    write_message(
        stream,
        &Request::Hello {
            client: "app".to_string(),
            protocol_version: protocol::PROTOCOL_VERSION,
            auth: protocol::HelloAuth::DaemonToken { token: token.to_string() },
            nonce: nonce.clone(),
        },
    )?;
    let mut reader = BufReader::with_capacity(1, &mut *stream);
    let ack = read_message(&mut reader)?
        .ok_or_else(|| anyhow::anyhow!("daemon closed the connection during the app handshake"))?;
    verify_app_ack(ack, token, &nonce)
}

/// The first daemon version that understands `Hello`.
pub(crate) const HELLO_MIN_VERSION: u32 = 35;

/// Present the app's identity on both connections, when the daemon is new
/// enough to understand `Hello`. Both become `app` so neither is narrowed
/// if `require_local_token` is ever turned on: the command connection
/// carries `CreateSession` (privileged, refused to an untokened local
/// under the switch), and the streaming connection is given the same
/// identity so it is `app` too rather than relying on the switch never
/// reaching the requests it carries.
///
/// A daemon older than v35, or a missing token file, is not an error: the
/// app skips the handshake and continues as `local`, which in phase 1 has
/// today's full reach. A wrong server_proof IS an error -- that is DP-06.
fn app_handshake(
    compat: &DaemonCompat,
    command_conn: &Mutex<Stream>,
    stream: &mut Stream,
) -> anyhow::Result<()> {
    let Some(token) = read_daemon_token() else {
        return Ok(());
    };
    app_handshake_with_token(compat, command_conn, stream, &token)
}

/// The handshake with the token supplied rather than read from this
/// machine's token file: a link to a daemon on another host presents the
/// token its bridge read THERE (`remote.rs`). Same gate on the daemon's
/// version, same proof check, same two connections.
pub(crate) fn app_handshake_with_token(
    compat: &DaemonCompat,
    command_conn: &Mutex<Stream>,
    stream: &mut Stream,
    token: &str,
) -> anyhow::Result<()> {
    if compat.daemon_version < HELLO_MIN_VERSION {
        return Ok(());
    }
    app_handshake_command(command_conn, token)?;
    app_handshake_stream(stream, token)?;
    Ok(())
}

/// Whether an untokened local connection is narrowed on the daemon. The
/// daemon reads this same marker file per request, so the toggle is live.
#[tauri::command]
pub fn get_require_local_token() -> bool {
    protocol::require_local_token_path().is_ok_and(|p| p.exists())
}

/// Turn `require_local_token` on (write the marker `0600`) or off (remove
/// it). The Settings "Remote access" surface calls this; the daemon honours
/// it on the next request with no restart.
#[tauri::command]
pub fn set_require_local_token(enabled: bool) -> Result<(), String> {
    let path = protocol::require_local_token_path().map_err(|e| e.to_string())?;
    if enabled {
        std::fs::write(&path, b"1").map_err(|e| e.to_string())?;
        #[cfg(unix)]
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    } else if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// -- Remote access, phase 2 (v42) -------------------------------------
//
// The seven `app`-only requests the Settings section drives, and the
// three device pushes it listens for. Every one of them is aimed at the
// LOCAL daemon and nothing else: `lanes_for`'s route exists because a
// session or a workspace can live on an ssh host, and a paired phone is
// neither. Pairing a device decides who may reach THIS machine, so the
// daemon that answers has to be the one the human is sitting at -- a
// "Pair a device" that quietly enrolled a phone against a remote host's
// trust store would be the one screen where the wrong answer is
// invisible. So these take the local lanes and `current_compat` directly
// rather than a `route_for_*`, the way `list_queued_inputs` reads the
// local half of its answer.
//
// Each one is gated twice over. The command lane refuses to
// put the bytes on the wire against a daemon older than v42, and the
// frontend refuses to offer the control at all
// (`FEATURE_MIN_VERSION.remoteAccess`) so the human is told the version
// rather than handed an error after the click.

/// `BeginPairing`'s answer, as the frontend reads it: the string to draw
/// as a QR and the second the offer stops being valid.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingOffer {
    /// `protocol::PairingQr`'s compact JSON -- what the phone's camera
    /// hands its parser. Passed through as the opaque string it is: the
    /// app draws it and never reads inside it.
    pub qr: String,
    /// Wall-clock epoch SECONDS, the daemon's clock. The countdown is
    /// derived from it in `remoteAccess.ts` rather than from a duration,
    /// so a dialog left open across a suspend shows the truth.
    pub expires_at: i64,
}

/// `ListDevices`'s answer: the trust store's rows plus the two
/// remote-access settings that ride along with them (see
/// `protocol::Response::Devices` for why they share one round trip).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceList {
    pub devices: Vec<protocol::DeviceInfo>,
    pub remote_access_enabled: bool,
    pub relay_url: Option<String>,
}

/// Mint a one-time pairing secret and hand back the QR payload (§3, "The
/// ceremony"). A second call replaces the first: there is one offer at a
/// time because the human is looking at one QR at a time.
#[tauri::command]
pub async fn begin_pairing(
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<PairingOffer, String> {
    let resp = state
        .lanes(current_compat(&compat))
        .request(Request::BeginPairing)
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        Response::PairingOffer { qr, expires_at } => Ok(PairingOffer { qr, expires_at }),
        Response::Error { message } => Err(message),
        other => Err(format!("expected PairingOffer, got {other:?}")),
    }
}

/// The human compared the two six-digit codes and pressed Confirm. The
/// only call in the app that writes a row into `devices.sqlite`.
#[tauri::command]
pub async fn confirm_pairing(
    device_id: String,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<(), String> {
    let resp = state
        .lanes(current_compat(&compat))
        .request(Request::ConfirmPairing { device_id })
        .await
        .map_err(|e| e.to_string())?;
    expect_ok(resp)
}

/// The human pressed Reject: discard the pending handshake without
/// writing anything, so the phone hears an answer rather than waiting out
/// the two-minute expiry.
#[tauri::command]
pub async fn reject_pairing(
    device_id: String,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<(), String> {
    let resp = state
        .lanes(current_compat(&compat))
        .request(Request::RejectPairing { device_id })
        .await
        .map_err(|e| e.to_string())?;
    expect_ok(resp)
}

/// Every paired device, revoked ones included, and the remote-access
/// settings. The panel's whole read: the toggle, the relay field and the
/// list are one answer, so they cannot draw three different accounts of
/// the same store.
#[tauri::command]
pub async fn list_devices(
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<DeviceList, String> {
    let resp = state
        .lanes(current_compat(&compat))
        .request(Request::ListDevices)
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        Response::Devices { devices, remote_access_enabled, relay_url } => {
            Ok(DeviceList { devices, remote_access_enabled, relay_url })
        }
        Response::Error { message } => Err(message),
        other => Err(format!("expected Devices, got {other:?}")),
    }
}

/// Revoke one device: the daemon marks the row and drops every live
/// connection carrying its id (§3, "Revocation").
#[tauri::command]
pub async fn revoke_device(
    device_id: String,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<(), String> {
    let resp = state
        .lanes(current_compat(&compat))
        .request(Request::RevokeDevice { device_id })
        .await
        .map_err(|e| e.to_string())?;
    expect_ok(resp)
}

/// Revoke every device AND rotate the daemon's static key: the one-button
/// answer to a lost phone. Every phone pinned the old key, so the
/// rotation invalidates all of them at once even if `devices.sqlite` is
/// later restored from a backup.
#[tauri::command]
pub async fn revoke_all_devices(
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<(), String> {
    let resp = state
        .lanes(current_compat(&compat))
        .request(Request::RevokeAllDevices)
        .await
        .map_err(|e| e.to_string())?;
    expect_ok(resp)
}

/// Store whether remote access is on and which relay to reach this daemon
/// through. Stored and INERT in this phase: nothing dials and nothing
/// listens until phase 3's `remote.rs`, which is what the section's own
/// copy says in so many words.
///
/// Every window hears the switch move (`remote-access-changed`), not only
/// the one whose Settings flipped it: what closing the main window does
/// and whether the Mac is held awake both read it (keepRunningState.ts),
/// and the window holding the app's duties is often not the one showing
/// Settings.
#[tauri::command]
pub async fn set_remote_access(
    enabled: bool,
    relay_url: Option<String>,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<(), String> {
    let resp = state
        .lanes(current_compat(&compat))
        .request(Request::SetRemoteAccess { enabled, relay_url })
        .await
        .map_err(|e| e.to_string())?;
    expect_ok(resp)?;
    let _ = app_handle.emit("remote-access-changed", enabled);
    Ok(())
}

/// Walks the tree, replacing any session id not present in `valid_ids`
/// (stale, exited, or never existed) with a freshly created session — the
/// same silent, normal fallback Milestone B established for its one
/// session, now applied uniformly to every tab in every pane.
/// Ids in `non_session_tab_ids` are file-viewer tabs, not terminal sessions --
/// they're skipped entirely. The daemon has never heard of them, so
/// without this check every persisted file tab would be treated as a
/// stale session and silently replaced by a freshly spawned shell on
/// every single launch.
/// `workspace_root` is the root of the workspace whose page this layout
/// belongs to -- the authority on which workspace a replacement session
/// is for, which is why it comes from the saved layout rather than from
/// the dead row's own recorded `workspace_path`: a row written before that
/// field carried the workspace still names only a cwd.
/// `home` is the cwd fallback for a fresh session -- this machine's home
/// for the local daemon, the HOST's for a link (`remote.rs`), because a
/// daemon on another machine cannot open the desktop's home directory.
pub(crate) fn resolve_sessions(
    node: &mut LayoutNode,
    lanes: &DaemonLanes,
    all_sessions: &HashMap<String, protocol::SessionSummary>,
    non_session_tab_ids: &HashSet<String>,
    workspace_root: Option<&str>,
    home: &str,
) -> anyhow::Result<()> {
    match node {
        LayoutNode::Leaf { tabs, pinned, .. } => {
            for id in tabs.iter_mut() {
                if non_session_tab_ids.contains(id.as_str()) {
                    continue;
                }
                let is_valid = all_sessions.get(id.as_str()).is_some_and(|s| s.status != "exited");
                if !is_valid {
                    let last_known_cwd = all_sessions.get(id.as_str()).map(|s| s.cwd.as_str());
                    // Bootstrap and a link's setup run on their own
                    // threads, never the runtime's, so this may block.
                    // A plain shell in the tab's place: no command, so
                    // no profile, and nothing to compress.
                    let fresh = tauri::async_runtime::block_on(create_fresh_session(
                        lanes,
                        last_known_cwd,
                        workspace_root,
                        None,
                        None,
                        None,
                        home,
                    ))?;
                    // A pin belongs to the tab slot, not the dead process:
                    // carry it over so a daemon restart doesn't unpin it.
                    if let Some(pin) = pinned.iter_mut().find(|p| **p == *id) {
                        *pin = fresh.clone();
                    }
                    *id = fresh;
                }
            }
            Ok(())
        }
        LayoutNode::Split { children, .. } => {
            for child in children.iter_mut() {
                resolve_sessions(
                    child,
                    lanes,
                    all_sessions,
                    non_session_tab_ids,
                    workspace_root,
                    home,
                )?;
            }
            Ok(())
        }
    }
}

/// Fetches the full session list once -- every record, exited ones
/// included -- keyed by id. Called at most once per bootstrap, regardless
/// of how many pages/workspaces need reconciling against it. Exited
/// records are kept (not filtered out here) so `resolve_sessions` can look
/// up an exited session's own last-known `cwd` before replacing it, rather
/// than falling back to `$HOME`.
/// One live session's push-derived state, read back in a single query.
/// camelCase because it crosses to the frontend; the protocol's own
/// `SessionSummary` stays as it is on the wire.
/// `get_session_baselines`'s answer: the sessions, and which ssh hosts
/// they include.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionBaselines {
    pub sessions: Vec<SessionBaseline>,
    /// The linked hosts that answered. A linked host missing from here
    /// said nothing about its sessions -- which is not the same as saying
    /// it has none, and the frontend must not close its tabs over it.
    pub hosts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionBaseline {
    pub id: String,
    pub cwd: String,
    pub status: String,
    pub restored: bool,
    /// This session's run was killed with a previous daemon and its
    /// command was deliberately not re-run (daemon `SessionManager::
    /// recover`). Read back here for the same reason the other three are:
    /// `session-interrupted` is baselined on Attach, which happens once
    /// per app PROCESS, so a reloaded frontend would otherwise come up
    /// believing every interrupted run is still going.
    pub interrupted: bool,
    /// The process this session left running after the daemon that
    /// hosted it died -- probed, not inferred (daemon `proc`). Read back
    /// here for the same reason as the four above, and with more at
    /// stake: losing this on a reload would hide a live agent editing the
    /// checkout behind a tab that looks like an ordinary shell.
    ///
    /// `None` from a daemon below v21 means "never probed", not "nothing
    /// survived". The frontend separates the two on the compat verdict
    /// (orphan.ts's `orphanDetectionAvailable`), never on this field
    /// alone.
    pub orphan: Option<protocol::OrphanProcess>,
    /// Why this session is `failed`, or None. Baselined for the same
    /// reason `interrupted` is -- the reason arrives only as the
    /// `session-failed` push, whose baseline rides on Attach -- and it
    /// matters more here than there: a red session with nothing to say
    /// for itself is exactly the state this feature exists to replace.
    pub failure_reason: Option<String>,
}

/// Every live session's cwd, status, restored, interrupted flags and
/// failure reason, in one read.
///
/// The frontend only ever learns these from pushes (`cwd-changed`,
/// `session-status-changed`, `session-restored`), and their baseline is
/// what the daemon sends in reply to `Attach` -- which happens once per
/// APP PROCESS, in `attach_and_relay`. A frontend reload therefore comes
/// up with those maps empty and no way to refill them until the shell
/// happens to emit another OSC 7: the tab loses its cwd-derived label and
/// its "open this context's board" button until the next prompt. Under
/// `tauri dev` that is every single frontend edit.
///
/// A re-`Attach` would rebuild the same state, but it also replays
/// scrollback -- this just reads the registry instead. `ListSessions` has
/// been in the protocol since v1, so nothing here needs a compat gate of
/// its own beyond the one every command lane already applies.
///
/// Every daemon the app is talking to: the local one and each linked
/// host. The frontend closes any layout tab whose session this list does
/// not name, so it sweeps a host's workspaces only when `hosts` says
/// that host answered: a host that failed, or ran out of its budget
/// (`remote::ask_every_link`), contributes nothing -- its relay reports
/// it lost -- rather than failing the read for the local sessions too,
/// and rather than having every one of its tabs closed as stale.
///
/// Every daemon is asked before any answer is awaited, so a slow host
/// costs its own round trip and not the local one's as well.
#[tauri::command]
pub async fn get_session_baselines(
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<SessionBaselines, String> {
    let local = state.lanes(current_compat(&compat)).submit(Request::ListSessions).map_err(|e| e.to_string())?;
    let links = crate::remote::ask_every_link(&app_handle, |link| {
        let (host, lanes) = (link.host.clone(), link.lanes());
        async move {
            let sessions = sessions_by_id(lanes.request(Request::ListSessions).await).map_err(|e| e.to_string())?;
            Ok((host, sessions))
        }
    });
    let mut sessions = sessions_by_id(local.await).map_err(|e| e.to_string())?;
    let mut hosts = Vec::new();
    for (host, more) in links.answers().await {
        hosts.push(host);
        sessions.extend(more);
    }
    let sessions = sessions
        .into_values()
        .filter(|s| s.status != "exited")
        .map(|s| SessionBaseline {
            id: s.id,
            cwd: s.cwd,
            status: s.status,
            restored: s.restored,
            interrupted: s.interrupted,
            orphan: s.orphan,
            failure_reason: s.failure_reason,
        })
        .collect();
    Ok(SessionBaselines { sessions, hosts })
}

/// Ends the process a session left running after its daemon died.
///
/// A thin pass-through on purpose: every guard that matters is the
/// daemon's, because the daemon is the only side that knows which
/// process it recorded and can re-probe its identity before signalling.
/// This command carries a session id and nothing else, so nothing
/// reachable from the frontend can aim a signal at an arbitrary pid.
///
/// The two booleans are distinct outcomes and the caller says different
/// things about them: `ended` false with `still_running` true is a
/// process refusing SIGTERM -- the same stubbornness that got it here --
/// while both false means it had already gone.
///
/// The daemon waits out its grace on the connection that carries the
/// request, so it rides one of its own (`command_lane::runs_apart`):
/// several at once wait side by side, and nothing else waits behind them.
#[tauri::command]
pub async fn end_orphan(
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
    session_id: String,
) -> Result<OrphanEndResult, String> {
    let route = crate::remote::route_for_session(&app_handle, &session_id)?;
    let resp = lanes_for(route, &state, &compat)
        .request(Request::EndOrphan { id: session_id })
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        Response::OrphanEnded { ended, still_running, .. } => {
            Ok(OrphanEndResult { ended, still_running })
        }
        Response::Error { message } => Err(message),
        other => Err(format!("expected OrphanEnded, got {other:?}")),
    }
}

/// camelCase because it crosses to the frontend, like SessionBaseline.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OrphanEndResult {
    pub ended: bool,
    pub still_running: bool,
}

/// One row of the task manager: everything the daemon knows about a
/// session, whether or not anything in the app is showing it.
///
/// Deliberately unfiltered, unlike `get_session_baselines`, which drops
/// Exited rows because a tab for a dead session is nothing the layout can
/// use. This list exists precisely to account for the sessions no tab is
/// showing -- an exited row that still carries an orphan is the sharpest
/// case there is, and filtering it out is what left that case with no
/// surface at all.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSession {
    pub id: String,
    pub workspace_path: String,
    pub cwd: String,
    pub status: String,
    pub restored: bool,
    pub interrupted: bool,
    pub orphan: Option<protocol::OrphanProcess>,
    /// The command line the session was launched with, or None for a
    /// plain shell.
    pub command: Option<String>,
    /// The pid the daemon verified is still this session's own process.
    /// None means there is nothing running to measure OR to kill.
    pub pid: Option<u32>,
    pub rss_bytes: u64,
    pub cpu_time_us: u64,
    pub process_count: u32,
    pub sampled_at_us: i64,
}

/// The task manager's read: every session, plus whether the figures in it
/// are real.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSessions {
    pub sessions: Vec<ManagedSession>,
    /// False when this daemon has no `SessionProcesses` to ask. The rows
    /// are still there and still killable -- `ListSessions` has existed
    /// since v1 -- but every figure in them is a zero nobody measured,
    /// and a panel that drew those as "0.0% / 0 MB" would be inventing
    /// data. The panel says the columns are unavailable instead.
    pub metrics: bool,
}

/// Every session the daemon is holding, with one sample of what each is
/// costing.
///
/// Two requests rather than one: `ListSessions` for the facts, which has
/// been in the protocol since v1 and always answers, and
/// `SessionProcesses` for the figures, which is gated at v23. Joining
/// them here rather than in the frontend keeps the poll to a single IPC
/// hop, and means the "which daemon is this" question is answered once,
/// in the place that actually holds the compat verdict.
///
/// A gated-out metrics request degrades rather than fails: an older
/// daemon still gets a working list of sessions to jump to and kill,
/// which is most of the panel.
///
/// One daemon's rows; `list_managed_sessions` joins the local daemon's
/// with every linked host's.
async fn managed_sessions_on(lanes: DaemonLanes) -> Result<ManagedSessions, String> {
    let compat = *lanes.compat();
    let resp = lanes.request(Request::ListSessions).await.map_err(|e| e.to_string())?;
    let sessions = match resp {
        Response::SessionList { sessions } => sessions,
        Response::Error { message } => return Err(message),
        other => return Err(format!("expected SessionList, got {other:?}")),
    };

    // Only the gate is tolerated silently. A daemon that HAS the request
    // and failed to answer it is a fault worth surfacing, not a reason to
    // quietly show a panel full of zeroes.
    let metrics = compat.daemon_version >= protocol::min_version_for(&Request::SessionProcesses);
    let processes: HashMap<String, protocol::SessionProcess> = if !metrics {
        HashMap::new()
    } else {
        match lanes.request(Request::SessionProcesses).await.map_err(|e| e.to_string())? {
            Response::SessionProcessList { processes } => {
                processes.into_iter().map(|p| (p.session_id.clone(), p)).collect()
            }
            Response::Error { message } => return Err(message),
            other => return Err(format!("expected SessionProcessList, got {other:?}")),
        }
    };

    Ok(ManagedSessions {
        metrics,
        sessions: sessions
            .into_iter()
            .map(|s| {
                let p = processes.get(&s.id);
                ManagedSession {
                    id: s.id,
                    workspace_path: s.workspace_path,
                    cwd: s.cwd,
                    status: s.status,
                    restored: s.restored,
                    interrupted: s.interrupted,
                    orphan: s.orphan,
                    command: p.and_then(|p| p.command.clone()),
                    pid: p.and_then(|p| p.pid),
                    rss_bytes: p.map(|p| p.rss_bytes).unwrap_or(0),
                    cpu_time_us: p.map(|p| p.cpu_time_us).unwrap_or(0),
                    process_count: p.map(|p| p.process_count).unwrap_or(0),
                    sampled_at_us: p.map(|p| p.sampled_at_us).unwrap_or(0),
                }
            })
            .collect(),
    })
}

/// Every session on every daemon the app is talking to. A linked host's
/// rows are added when it answers; `metrics` is true only when every
/// daemon that contributed rows measured them, so a panel never draws a
/// zero one daemon invented next to a figure another one measured.
///
/// Polled every few seconds by three surfaces, so it must never wait on
/// the main thread: each daemon's two requests queue on its lanes and are
/// awaited there. The hosts are asked all at once, alongside the local
/// daemon, and each gets a bound of its own (`remote::ask_every_link`):
/// one host that has stopped answering costs the read that host's rows,
/// not everybody's for as long as it takes to give up on it.
#[tauri::command]
pub async fn list_managed_sessions(
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<ManagedSessions, String> {
    let links = crate::remote::ask_every_link(&app_handle, |link| managed_sessions_on(link.lanes()));
    let mut all = managed_sessions_on(state.lanes(current_compat(&compat))).await?;
    for theirs in links.answers().await {
        all.metrics = all.metrics && theirs.metrics;
        all.sessions.extend(theirs.sessions);
    }
    Ok(all)
}

/// A `ListSessions` reply keyed by session id.
fn sessions_by_id(
    resp: anyhow::Result<Response>,
) -> anyhow::Result<HashMap<String, protocol::SessionSummary>> {
    match resp? {
        Response::SessionList { sessions } => {
            Ok(sessions.into_iter().map(|s| (s.id.clone(), s)).collect())
        }
        other => anyhow::bail!("expected SessionList, got {other:?}"),
    }
}

/// Every session one daemon holds, for the synchronous callers already off
/// the main thread: bootstrap and a link's setup.
pub(crate) fn list_valid_session_ids(
    lanes: &DaemonLanes,
) -> anyhow::Result<HashMap<String, protocol::SessionSummary>> {
    sessions_by_id(lanes.ask(Request::ListSessions))
}

/// Resolves every session id referenced by every page of every workspace
/// against the daemon's actual live sessions, replacing any that are stale
/// in place. An empty `workspaces` list -- nothing saved yet, or a config
/// from before this milestone -- is left untouched: no default workspace
/// or session is auto-created, and `ListSessions` isn't even called.
fn resolve_workspaces(
    workspaces: &mut [Workspace],
    lanes: &DaemonLanes,
    non_session_tab_ids: &HashSet<String>,
) -> anyhow::Result<()> {
    if workspaces.is_empty() {
        return Ok(());
    }
    // Every tab across every page is a file tab -- there are no sessions to
    // reconcile, so skip the ListSessions round-trip entirely (matching the
    // empty-workspaces early return above).
    let has_any_session_tab = workspaces
        .iter()
        .flat_map(|w| w.pages.iter())
        .flat_map(|p| p.layout.all_session_ids())
        .any(|id| !non_session_tab_ids.contains(&id));
    if !has_any_session_tab {
        return Ok(());
    }
    let all_sessions = list_valid_session_ids(lanes)?;
    let home = local_home();
    // An ssh workspace's sessions are another daemon's: this one has
    // never heard of their ids and would replace every one with a fresh
    // local shell. They are resolved on their link (`remote::link_workspace`).
    for workspace in workspaces.iter_mut().filter(|w| w.ssh.is_none()) {
        let workspace_root = workspace.root_path.clone();
        for page in workspace.pages.iter_mut() {
            resolve_sessions(
                &mut page.layout,
                lanes,
                &all_sessions,
                non_session_tab_ids,
                workspace_root.as_deref(),
                &home,
            )?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod test_support {
    use super::*;
    use protocol::transport::Listener;

    /// A daemon at exact parity with this app -- gates nothing, so the
    /// tests below that aren't specifically exercising the gate itself
    /// don't have to think about it. `gate_tests` and
    /// `command_connection_tests`'s two gating tests build their own
    /// `DaemonCompat` deliberately instead, since an intentionally-old
    /// `daemon_version` is the whole point there.
    pub fn parity_compat() -> DaemonCompat {
        DaemonCompat {
            daemon_version: protocol::PROTOCOL_VERSION,
            app_version: protocol::PROTOCOL_VERSION,
            degraded: false,
        }
    }

    /// One daemon's lanes over a single connection to a fake daemon, at
    /// parity. No redial: a fake that runs out of replies closes, and a
    /// test must see that as the failure it is rather than have the lane
    /// go looking for another daemon.
    pub fn lanes_over(stream: Stream) -> DaemonLanes {
        lanes_at(stream, parity_compat())
    }

    pub fn lanes_at(stream: Stream, compat: DaemonCompat) -> DaemonLanes {
        DaemonLanes::single(CommandLane::spawn("the fake daemon", stream, compat.daemon_version, None), compat)
    }

    /// Runs an async helper to completion from a plain test thread.
    pub fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tauri::async_runtime::block_on(future)
    }

    /// Spins up a minimal fake daemon: accepts one connection, then for
    /// each response given, reads exactly one Request and replies with
    /// that Response, in order. Returns the connected client-side
    /// Stream ready to pass to send_command. Shared by
    /// command_connection_tests and resolve_workspaces_tests.
    pub fn fake_daemon_replying_with(responses: Vec<Response>) -> (Stream, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let socket_path = dir.path().join("fake.sock");
        let listener = Listener::bind(&socket_path).unwrap();

        std::thread::spawn(move || {
            let mut stream = listener.accept().unwrap();
            for response in responses {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let _req: Request = read_message(&mut reader).unwrap().unwrap();
                write_message(&mut stream, &response).unwrap();
            }
        });

        let client = Stream::connect(&socket_path).unwrap();
        (client, dir)
    }

    /// Like `fake_daemon_replying_with`, but also captures every request
    /// the fake daemon receives, in order, into the returned `Vec` (shared
    /// via `Arc<Mutex<...>>` since the daemon thread and the test both
    /// need it) -- for tests that need to assert not just the final
    /// resolved state, but specifically what was SENT to get there (e.g.
    /// which `cwd` a `CreateSession` request carried).
    pub fn fake_daemon_capturing_requests(
        responses: Vec<Response>,
    ) -> (Stream, Arc<Mutex<Vec<Request>>>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let socket_path = dir.path().join("fake.sock");
        let listener = Listener::bind(&socket_path).unwrap();
        let captured = Arc::new(Mutex::new(Vec::new()));
        let captured_clone = Arc::clone(&captured);

        std::thread::spawn(move || {
            let mut stream = listener.accept().unwrap();
            for response in responses {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let req: Request = read_message(&mut reader).unwrap().unwrap();
                captured_clone.lock().unwrap().push(req);
                write_message(&mut stream, &response).unwrap();
            }
        });

        let client = Stream::connect(&socket_path).unwrap();
        (client, captured, dir)
    }
}

#[cfg(test)]
mod command_connection_tests {
    use super::test_support::{block_on, fake_daemon_capturing_requests, fake_daemon_replying_with, lanes_at};
    use super::*;

    /// The property that actually matters for the compat window: the
    /// daemon must receive NOTHING -- not a request it answers with an
    /// error, but no bytes at all. An older daemon can't parse a variant
    /// it predates, and that parse error closes the whole connection.
    #[test]
    fn a_command_the_daemon_predates_never_reaches_the_wire() {
        let (client, captured, _dir) = fake_daemon_capturing_requests(vec![]);
        let compat = DaemonCompat { daemon_version: 9, app_version: 12, degraded: true };
        let lanes = lanes_at(client, compat);
        let too_new = Request::NameSession { session_id: "s-1".into(), name: "x".into(), agent_conversation_id: None };

        let err = block_on(lanes.request(too_new)).unwrap_err().to_string();
        assert!(err.contains("v10"), "should name the version needed: {err}");
        assert!(err.contains("v9"), "should name the version running: {err}");

        drop(lanes);
        assert!(captured.lock().unwrap().is_empty(), "a gated request must not reach the daemon");
    }

    #[test]
    fn a_command_the_daemon_understands_still_reaches_the_wire() {
        let (client, _dir) = fake_daemon_replying_with(vec![Response::SessionList { sessions: vec![] }]);
        let compat = DaemonCompat { daemon_version: 9, app_version: 12, degraded: true };

        // ListSessions is v1, so a v9 daemon serves it fine.
        let resp = block_on(lanes_at(client, compat).request(Request::ListSessions)).unwrap();
        assert!(matches!(resp, Response::SessionList { .. }));
    }

    #[test]
    fn send_command_round_trips_a_request_and_response() {
        let (client, _dir) = fake_daemon_replying_with(vec![Response::SessionCreated {
            id: "new-session-id".to_string(),
        }]);
        let conn = Mutex::new(client);

        let resp = send_command(
            &conn,
            &Request::CreateSession {
                workspace_path: "/tmp".to_string(),
                cwd: "/tmp".to_string(),
                command: None,
                profile_id: None,
                api_family: None,
            },
        )
        .unwrap();

        match resp {
            Response::SessionCreated { id } => assert_eq!(id, "new-session-id"),
            other => panic!("expected SessionCreated, got {other:?}"),
        }
    }

    #[test]
    fn send_command_returns_the_error_response() {
        let (client, _dir) = fake_daemon_replying_with(vec![Response::Error {
            message: "unknown session: xyz".to_string(),
        }]);
        let conn = Mutex::new(client);

        let resp = send_command(&conn, &Request::KillSession { id: "xyz".to_string() }).unwrap();

        match resp {
            Response::Error { message } => assert_eq!(message, "unknown session: xyz"),
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn send_command_sequential_calls_dont_cross_streams() {
        // Two calls in a row on the same connection must each get their own
        // reply, in order -- this is the whole reason CommandConnection
        // exists as a separate, mutex-serialized connection.
        let (client, _dir) = fake_daemon_replying_with(vec![
            Response::SessionCreated { id: "session-0".to_string() },
            Response::SessionCreated { id: "session-1".to_string() },
        ]);
        let conn = Mutex::new(client);

        let make_req = || Request::CreateSession {
            workspace_path: "/tmp".to_string(),
            cwd: "/tmp".to_string(),
            command: None,
            profile_id: None,
            api_family: None,
        };

        let first = send_command(&conn, &make_req()).unwrap();
        let second = send_command(&conn, &make_req()).unwrap();

        match (first, second) {
            (Response::SessionCreated { id: id0 }, Response::SessionCreated { id: id1 }) => {
                assert_eq!(id0, "session-0");
                assert_eq!(id1, "session-1");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }
}

#[cfg(test)]
mod resolve_workspaces_tests {
    use super::test_support::{
        block_on, fake_daemon_capturing_requests, fake_daemon_replying_with, lanes_at, lanes_over,
        parity_compat,
    };
    use super::*;
    use crate::config::Page;

    fn leaf(tabs: &[&str]) -> LayoutNode {
        LayoutNode::Leaf { tabs: tabs.iter().map(|s| s.to_string()).collect(), active_tab_index: 0, pinned: Vec::new() }
    }

    fn page(id: &str, layout: LayoutNode) -> Page {
        Page { id: id.to_string(), name: id.to_string(), layout, focused_session_id: None, pinned_at: None }
    }

    fn workspace(id: &str, pages: Vec<Page>) -> Workspace {
        Workspace {
            id: id.to_string(),
            name: id.to_string(),
            pages,
            active_page_id: None,
            active_view: None,
            hub_view: None,
            root_path: None,
            main_session_id: None,
            orchestration_agent: None,
            developing_cards: Vec::new(),
            legacy_agent_command: None,
            color: None,
            notify_needs_input: true,
            notify_finished: true,
            confirm_tab_close: true,
            home_agent_share: None,
            git_view: None,
            last_active_at: None,
            terminal_font_size: None,
            auto_commit: None,
            auto_resume_runs: false,
            agent_pause: None,
            pinned_at: None,
            complexity_agents: HashMap::new(),
            git_tracking_asked: false,
            trusted_config_hash: None,
            mcp_foreign_servers_choice: None,
            reviewed_cards: None,
            require_review: None,
            headroom: None,
            require_review_asked: false,
            headroom_asked: false,
            custom_resume_args: None,
            agent_fallback: None,
            armed_agents: Vec::new(),
            declined_agents: Vec::new(),
            ssh: None,
            action_prompt_overrides: HashMap::new(),
        }
    }

    fn no_file_tabs() -> HashSet<String> {
        HashSet::new()
    }

    #[test]
    fn a_file_tab_id_is_left_alone_not_replaced_with_a_fresh_session() {
        // Zero queued responses: if resolve_workspaces treated the file tab
        // as a stale session it would try to CreateSession and hang/fail on
        // the empty queue. A workspace whose only tab is a file tab must
        // not even call ListSessions.
        let (client, captured, _dir) = fake_daemon_capturing_requests(vec![]);
        let conn = lanes_over(client);
        let mut workspaces = vec![workspace("ws-1", vec![page("page-1", leaf(&["file-tab-1"]))])];
        let non_session_tab_ids: HashSet<String> = ["file-tab-1".to_string()].into_iter().collect();

        resolve_workspaces(&mut workspaces, &conn, &non_session_tab_ids).unwrap();

        assert_eq!(workspaces[0].pages[0].layout, leaf(&["file-tab-1"]));
        assert!(captured.lock().unwrap().is_empty(), "no daemon calls at all for a file-tab-only workspace");
    }

    #[test]
    fn a_file_tab_alongside_a_stale_session_leaves_the_file_tab_and_replaces_only_the_session() {
        let (client, _captured, _dir) = fake_daemon_capturing_requests(vec![
            Response::SessionList { sessions: vec![] },
            Response::SessionCreated { id: "fresh-a".to_string() },
        ]);
        let conn = lanes_over(client);
        let mut workspaces =
            vec![workspace("ws-1", vec![page("page-1", leaf(&["file-tab-1", "stale-session"]))])];
        let non_session_tab_ids: HashSet<String> = ["file-tab-1".to_string()].into_iter().collect();

        resolve_workspaces(&mut workspaces, &conn, &non_session_tab_ids).unwrap();

        assert_eq!(workspaces[0].pages[0].layout, leaf(&["file-tab-1", "fresh-a"]));
    }

    #[test]
    fn a_pinned_stale_session_stays_pinned_under_its_fresh_id() {
        let (client, _captured, _dir) = fake_daemon_capturing_requests(vec![
            Response::SessionList { sessions: vec![] },
            Response::SessionCreated { id: "fresh-a".to_string() },
            Response::SessionCreated { id: "fresh-b".to_string() },
        ]);
        let conn = lanes_over(client);
        let pinned_leaf = LayoutNode::Leaf {
            tabs: vec!["stale-a".to_string(), "stale-b".to_string()],
            active_tab_index: 1,
            pinned: vec!["stale-a".to_string()],
        };
        let mut workspaces = vec![workspace("ws-1", vec![page("page-1", pinned_leaf)])];

        resolve_workspaces(&mut workspaces, &conn, &no_file_tabs()).unwrap();

        assert_eq!(
            workspaces[0].pages[0].layout,
            LayoutNode::Leaf {
                tabs: vec!["fresh-a".to_string(), "fresh-b".to_string()],
                active_tab_index: 1,
                pinned: vec!["fresh-a".to_string()],
            }
        );
    }

    fn valid_session(id: &str) -> protocol::SessionSummary {
        protocol::SessionSummary {
            id: id.to_string(),
            workspace_path: "/tmp".to_string(),
            cwd: "/tmp".to_string(),
            status: "idle".to_string(),
            restored: false,
            interrupted: false,
            orphan: None,
            failure_reason: None,
            compressed: false,
            uncompressed_reason: None,
        }
    }

    fn exited_session(id: &str, cwd: &str) -> protocol::SessionSummary {
        protocol::SessionSummary {
            id: id.to_string(),
            workspace_path: cwd.to_string(),
            cwd: cwd.to_string(),
            status: "exited".to_string(),
            restored: false,
            interrupted: false,
            orphan: None,
            failure_reason: None,
            compressed: false,
            uncompressed_reason: None,
        }
    }

    #[test]
    fn empty_workspaces_makes_no_daemon_calls_at_all() {
        // Zero queued responses -- if resolve_workspaces called
        // ListSessions anyway, send_command would hit a connection the fake
        // daemon thread already closed and error, which the unwrap() below
        // would turn into a clear panic rather than silently passing.
        let (client, _dir) = fake_daemon_replying_with(vec![]);
        let conn = lanes_over(client);
        let mut workspaces: Vec<Workspace> = vec![];

        resolve_workspaces(&mut workspaces, &conn, &no_file_tabs()).unwrap();

        assert_eq!(workspaces, vec![]);
    }

    #[test]
    fn calls_list_sessions_exactly_once_regardless_of_page_count() {
        // Only one SessionList reply is queued. If resolve_workspaces
        // called ListSessions more than once (e.g. once per page instead
        // of once total), the second send_command would hit a connection
        // the fake daemon thread already closed after its one reply, and
        // the unwrap() below would panic on that error.
        let (client, _dir) = fake_daemon_replying_with(vec![Response::SessionList {
            sessions: vec![valid_session("valid-1"), valid_session("valid-2")],
        }]);
        let conn = lanes_over(client);
        let mut workspaces = vec![
            workspace("ws-1", vec![page("page-1", leaf(&["valid-1"]))]),
            workspace("ws-2", vec![page("page-2", leaf(&["valid-2"]))]),
        ];

        resolve_workspaces(&mut workspaces, &conn, &no_file_tabs()).unwrap();

        assert_eq!(workspaces[0].pages[0].layout, leaf(&["valid-1"]));
        assert_eq!(workspaces[1].pages[0].layout, leaf(&["valid-2"]));
    }

    #[test]
    fn replaces_stale_session_ids_across_multiple_pages_and_workspaces() {
        let (client, _dir) = fake_daemon_replying_with(vec![
            Response::SessionList { sessions: vec![valid_session("valid-1")] },
            Response::SessionCreated { id: "fresh-a".to_string() },
            Response::SessionCreated { id: "fresh-b".to_string() },
        ]);
        let conn = lanes_over(client);
        let mut workspaces = vec![
            workspace("ws-1", vec![page("page-1", leaf(&["valid-1", "stale-1"]))]),
            workspace("ws-2", vec![page("page-2", leaf(&["stale-2"]))]),
        ];

        resolve_workspaces(&mut workspaces, &conn, &no_file_tabs()).unwrap();

        assert_eq!(workspaces[0].pages[0].layout, leaf(&["valid-1", "fresh-a"]));
        assert_eq!(workspaces[1].pages[0].layout, leaf(&["fresh-b"]));
    }

    #[test]
    fn replaces_an_exited_session_at_its_own_last_known_cwd_not_home() {
        let (client, captured, _dir) = fake_daemon_capturing_requests(vec![
            Response::SessionList {
                sessions: vec![exited_session("exited-1", "/Users/alice/project")],
            },
            Response::SessionCreated { id: "fresh-a".to_string() },
        ]);
        let conn = lanes_over(client);
        let mut workspaces = vec![workspace("ws-1", vec![page("page-1", leaf(&["exited-1"]))])];

        resolve_workspaces(&mut workspaces, &conn, &no_file_tabs()).unwrap();

        assert_eq!(workspaces[0].pages[0].layout, leaf(&["fresh-a"]));
        let requests = captured.lock().unwrap();
        match &requests[1] {
            Request::CreateSession { cwd, workspace_path, .. } => {
                assert_eq!(cwd, "/Users/alice/project");
                assert_eq!(workspace_path, "/Users/alice/project");
            }
            other => panic!("expected the second request to be CreateSession, got {other:?}"),
        }
    }

    /// The restore counterpart of
    /// `create_fresh_session_names_the_owning_workspace_not_a_second_copy_of_cwd`:
    /// a replacement lands back in the dead session's own worktree, but it
    /// is still the workspace's session, and the daemon has to be told
    /// which workspace that is or the agent it hosts loses its card writes.
    #[test]
    fn a_replacement_keeps_its_workspace_root_even_when_it_comes_back_in_a_worktree() {
        let (client, captured, _dir) = fake_daemon_capturing_requests(vec![
            Response::SessionList {
                sessions: vec![exited_session("exited-1", "/Users/alice/project-rail")],
            },
            Response::SessionCreated { id: "fresh-a".to_string() },
        ]);
        let conn = lanes_over(client);
        let mut ws = workspace("ws-1", vec![page("page-1", leaf(&["exited-1"]))]);
        ws.root_path = Some("/Users/alice/project".to_string());
        let mut workspaces = vec![ws];

        resolve_workspaces(&mut workspaces, &conn, &no_file_tabs()).unwrap();

        let requests = captured.lock().unwrap();
        match &requests[1] {
            Request::CreateSession { cwd, workspace_path, .. } => {
                assert_eq!(cwd, "/Users/alice/project-rail");
                assert_eq!(workspace_path, "/Users/alice/project");
            }
            other => panic!("expected the second request to be CreateSession, got {other:?}"),
        }
    }

    #[test]
    fn falls_back_to_home_only_when_the_id_has_no_registry_record_at_all() {

        let (client, captured, _dir) = fake_daemon_capturing_requests(vec![
            Response::SessionList { sessions: vec![] },
            Response::SessionCreated { id: "fresh-b".to_string() },
        ]);
        let conn = lanes_over(client);
        let mut workspaces = vec![workspace("ws-1", vec![page("page-1", leaf(&["unknown-id"]))])];

        resolve_workspaces(&mut workspaces, &conn, &no_file_tabs()).unwrap();

        assert_eq!(workspaces[0].pages[0].layout, leaf(&["fresh-b"]));
        let requests = captured.lock().unwrap();
        let home = std::env::var("HOME").unwrap();
        match &requests[1] {
            Request::CreateSession { cwd, .. } => assert_eq!(cwd, &home),
            other => panic!("expected the second request to be CreateSession, got {other:?}"),
        }
    }

    #[test]
    fn falls_back_to_home_when_the_last_known_cwd_is_rejected_instead_of_failing_the_whole_bootstrap() {
        // The exact scenario recover()'s own workspace_path-missing fix
        // produces: an exited record whose last-known cwd no longer
        // exists, so the daemon rejects the first CreateSession attempt.
        // Before the fallback, this Error propagated all the way up
        // through resolve_workspaces -- this test is what would have
        // failed (via the unwrap() below) had that regression shipped.
        let (client, captured, _dir) = fake_daemon_capturing_requests(vec![
            Response::SessionList {
                sessions: vec![exited_session("exited-2", "/definitely/does/not/exist/anywhere")],
            },
            Response::Error { message: "cwd does not exist or is not a directory".to_string() },
            Response::SessionCreated { id: "fresh-c".to_string() },
        ]);
        let conn = lanes_over(client);
        let mut workspaces = vec![workspace("ws-1", vec![page("page-1", leaf(&["exited-2"]))])];

        resolve_workspaces(&mut workspaces, &conn, &no_file_tabs()).unwrap();

        assert_eq!(workspaces[0].pages[0].layout, leaf(&["fresh-c"]));
        let requests = captured.lock().unwrap();
        assert_eq!(requests.len(), 3, "expected the rejected attempt plus a fallback retry at $HOME");
        let home = std::env::var("HOME").unwrap();
        match &requests[1] {
            Request::CreateSession { cwd, .. } => assert_eq!(cwd, "/definitely/does/not/exist/anywhere"),
            other => panic!("expected the second request to be the rejected CreateSession, got {other:?}"),
        }
        match &requests[2] {
            Request::CreateSession { cwd, .. } => assert_eq!(cwd, &home),
            other => panic!("expected the third request to be the $HOME fallback, got {other:?}"),
        }
    }

    #[test]
    fn create_fresh_session_with_no_command_sends_none() {
        let (client, captured, _dir) =
            fake_daemon_capturing_requests(vec![Response::SessionCreated { id: "s1".to_string() }]);
        let conn = lanes_over(client);

        block_on(create_fresh_session(&conn, Some("/tmp"), None, None, None, None, "/home/t")).unwrap();


        let requests = captured.lock().unwrap();
        match &requests[0] {
            Request::CreateSession { command, .. } => assert_eq!(command, &None),
            other => panic!("expected CreateSession, got {other:?}"),
        }
    }

    #[test]
    fn create_fresh_session_threads_an_explicit_command_through() {
        let (client, captured, _dir) =
            fake_daemon_capturing_requests(vec![Response::SessionCreated { id: "s1".to_string() }]);
        let conn = lanes_over(client);

        block_on(create_fresh_session(&conn, Some("/tmp"), None, Some("npm test"), None, None, "/home/t"))
            .unwrap();

        let requests = captured.lock().unwrap();
        match &requests[0] {
            Request::CreateSession { command, .. } => assert_eq!(command, &Some("npm test".to_string())),
            other => panic!("expected CreateSession, got {other:?}"),
        }
    }

    /// The field the daemon's agent scope gate reads. A rail agent runs in
    /// a worktree that is not its workspace root, and the two are
    /// different answers -- sending the cwd twice is what confined such an
    /// agent to the worktree and had the daemon refuse the card write its
    /// own run prompt demanded.
    #[test]
    fn create_fresh_session_names_the_owning_workspace_not_a_second_copy_of_cwd() {
        let (client, captured, _dir) =
            fake_daemon_capturing_requests(vec![Response::SessionCreated { id: "s1".to_string() }]);
        let conn = lanes_over(client);

        block_on(create_fresh_session(
            &conn,
            Some("/Users/alice/project-rail"),
            Some("/Users/alice/project"),
            None,
            None,
            None,
            "/Users/alice",
        ))
        .unwrap();

        let requests = captured.lock().unwrap();
        match &requests[0] {
            Request::CreateSession { cwd, workspace_path, .. } => {
                assert_eq!(cwd, "/Users/alice/project-rail");
                assert_eq!(workspace_path, "/Users/alice/project");
            }
            other => panic!("expected CreateSession, got {other:?}"),
        }
    }

    /// No workspace to name (a bare terminal) keeps exactly what every
    /// caller sent before the field meant anything.
    #[test]
    fn create_fresh_session_without_a_workspace_falls_back_to_its_cwd() {
        let (client, captured, _dir) =
            fake_daemon_capturing_requests(vec![Response::SessionCreated { id: "s1".to_string() }]);
        let conn = lanes_over(client);

        block_on(create_fresh_session(&conn, Some("/tmp/loose"), None, None, None, None, "/home/t")).unwrap();

        let requests = captured.lock().unwrap();
        match &requests[0] {
            Request::CreateSession { cwd, workspace_path, .. } => {
                assert_eq!(cwd, "/tmp/loose");
                assert_eq!(workspace_path, "/tmp/loose");
            }
            other => panic!("expected CreateSession, got {other:?}"),
        }
    }

    fn compat_at(daemon_version: u32) -> DaemonCompat {
        DaemonCompat {
            daemon_version,
            app_version: protocol::PROTOCOL_VERSION,
            degraded: daemon_version < protocol::PROTOCOL_VERSION,
        }
    }

    fn the_profile_sent(captured: &Arc<Mutex<Vec<Request>>>, index: usize) -> Option<String> {
        match &captured.lock().unwrap()[index] {
            Request::CreateSession { profile_id, .. } => profile_id.clone(),
            other => panic!("expected CreateSession, got {other:?}"),
        }
    }

    /// What makes a session a candidate for compression: the daemon
    /// decides at spawn, and the profile is the app's word for what it
    /// launched.
    #[test]
    fn create_fresh_session_names_the_profile_doing_the_launching() {
        let (client, captured, _dir) =
            fake_daemon_capturing_requests(vec![Response::SessionCreated { id: "s1".to_string() }]);
        let conn = lanes_over(client);

        block_on(create_fresh_session(
            &conn,
            Some("/Users/alice/project-rail"),
            Some("/Users/alice/project"),
            Some("claude 'Read the card'"),
            Some("claude-code"),
            None,
            "/Users/alice",
        ))
        .unwrap();

        assert_eq!(the_profile_sent(&captured, 0).as_deref(), Some("claude-code"));
    }

    /// The widening is invisible to `min_version_for`, so the lane's own
    /// gate lets the request through to any daemon. A v46 one would
    /// parse it, drop the profile and launch the agent uncompressed with
    /// nothing to say why -- so it is never sent one, whoever asked.
    #[test]
    fn an_older_daemon_is_never_sent_the_launching_profile() {
        let (client, captured, _dir) =
            fake_daemon_capturing_requests(vec![Response::SessionCreated { id: "s1".to_string() }]);
        let conn = lanes_at(client, compat_at(protocol::COMPRESSED_LAUNCH_MIN_VERSION - 1));

        let id = block_on(create_fresh_session(
            &conn,
            Some("/tmp"),
            Some("/tmp"),
            Some("claude 'Read the card'"),
            Some("claude-code"),
            None,
            "/home/t",
        ))
        .unwrap();

        // The launch itself goes ahead: compression never stops a run.
        assert_eq!(id, "s1");
        assert_eq!(the_profile_sent(&captured, 0), None);
        // And what reached the wire is the request as it always was.
        let sent = serde_json::to_value(&captured.lock().unwrap()[0]).unwrap();
        assert!(sent.get("profile_id").is_none(), "{sent}");
    }

    #[test]
    fn the_profile_is_sent_from_the_version_that_reads_it() {
        let at = protocol::COMPRESSED_LAUNCH_MIN_VERSION;
        assert_eq!(profile_for_daemon(at - 1, Some("claude-code")), None);
        assert_eq!(profile_for_daemon(at, Some("claude-code")).as_deref(), Some("claude-code"));
        assert_eq!(profile_for_daemon(at + 1, Some("codex")).as_deref(), Some("codex"));
        // Nothing to name is nothing to send, at any version.
        assert_eq!(profile_for_daemon(at, None), None);
        assert_eq!(profile_for_daemon(at, Some("")), None);
        assert_eq!(profile_for_daemon(at, Some("   ")), None);
    }

    /// The fallback is a plain shell in $HOME, not that workspace's
    /// session: the workspace is dropped, and the profile with it.
    #[test]
    fn the_home_fallback_drops_the_profile_along_with_the_workspace() {
        let (client, captured, _dir) = fake_daemon_capturing_requests(vec![
            Response::Error { message: "cwd does not exist or is not a directory".to_string() },
            Response::SessionCreated { id: "s2".to_string() },
        ]);
        let conn = lanes_over(client);

        block_on(create_fresh_session(
            &conn,
            Some("/definitely/does/not/exist/anywhere"),
            Some("/Users/alice/project"),
            Some("claude 'Read the card'"),
            Some("claude-code"),
            None,
            "/home/t",
        ))
        .unwrap();

        assert_eq!(the_profile_sent(&captured, 0).as_deref(), Some("claude-code"));
        assert_eq!(the_profile_sent(&captured, 1), None);
    }

    fn the_family_sent(captured: &Arc<Mutex<Vec<Request>>>, index: usize) -> Option<String> {
        match &captured.lock().unwrap()[index] {
            Request::CreateSession { api_family, .. } => api_family.clone(),
            other => panic!("expected CreateSession, got {other:?}"),
        }
    }

    /// What lets a custom agent be compressed: the daemon knows nothing
    /// of the binary, and the family names the variable that routes it.
    #[test]
    fn a_custom_launch_names_the_api_family_its_settings_name() {
        let (client, captured, _dir) =
            fake_daemon_capturing_requests(vec![Response::SessionCreated { id: "s1".to_string() }]);
        let conn = lanes_over(client);

        block_on(create_fresh_session(
            &conn,
            Some("/tmp"),
            Some("/tmp"),
            Some("my-agent 'Read the card'"),
            Some("custom"),
            Some("anthropic"),
            "/home/t",
        ))
        .unwrap();

        assert_eq!(the_profile_sent(&captured, 0).as_deref(), Some("custom"));
        assert_eq!(the_family_sent(&captured, 0).as_deref(), Some("anthropic"));
    }

    /// None is the default, and it is no field at all: the request a
    /// v47 daemon has always read.
    #[test]
    fn a_custom_agent_with_no_api_family_sends_none() {
        let (client, captured, _dir) =
            fake_daemon_capturing_requests(vec![Response::SessionCreated { id: "s1".to_string() }]);
        let conn = lanes_over(client);

        block_on(create_fresh_session(
            &conn,
            Some("/tmp"),
            Some("/tmp"),
            Some("my-agent 'Read the card'"),
            Some("custom"),
            Some(""),
            "/home/t",
        ))
        .unwrap();

        assert_eq!(the_family_sent(&captured, 0), None);
        let sent = serde_json::to_value(&captured.lock().unwrap()[0]).unwrap();
        assert!(sent.get("api_family").is_none(), "{sent}");
    }

    #[test]
    fn the_api_family_is_sent_only_with_the_custom_profile_to_a_daemon_that_reads_it() {
        let at = protocol::CUSTOM_API_FAMILY_MIN_VERSION;
        assert_eq!(api_family_for_daemon(at, Some("custom"), Some("openai")).as_deref(), Some("openai"));
        assert_eq!(api_family_for_daemon(at + 1, Some("custom"), Some(" anthropic ")).as_deref(), Some("anthropic"));
        // A v47 daemon would drop it; it reads profile_id and nothing more.
        assert_eq!(api_family_for_daemon(at - 1, Some("custom"), Some("openai")), None);
        // Every other profile is a binary the daemon knows the API of.
        assert_eq!(api_family_for_daemon(at, Some("claude-code"), Some("openai")), None);
        assert_eq!(api_family_for_daemon(at, Some("codex"), Some("anthropic")), None);
        // A shell names no profile, and so no family.
        assert_eq!(api_family_for_daemon(at, None, Some("openai")), None);
        // None, the default.
        assert_eq!(api_family_for_daemon(at, Some("custom"), Some("")), None);
        assert_eq!(api_family_for_daemon(at, Some("custom"), None), None);
    }

    /// The fallback shell belongs to no workspace and runs no agent, so
    /// it names neither.
    #[test]
    fn the_home_fallback_drops_the_api_family_along_with_the_profile() {
        let (client, captured, _dir) = fake_daemon_capturing_requests(vec![
            Response::Error { message: "cwd does not exist or is not a directory".to_string() },
            Response::SessionCreated { id: "s2".to_string() },
        ]);
        let conn = lanes_over(client);

        block_on(create_fresh_session(
            &conn,
            Some("/definitely/does/not/exist/anywhere"),
            Some("/Users/alice/project"),
            Some("my-agent 'Read the card'"),
            Some("custom"),
            Some("openai"),
            "/home/t",
        ))
        .unwrap();

        assert_eq!(the_family_sent(&captured, 0).as_deref(), Some("openai"));
        assert_eq!(the_family_sent(&captured, 1), None);
    }
}

/// Connects to (or spawns) the daemon over three connections — one for the
/// continuous Attach/Output relay, two for one-shot request/response
/// commands (see CommandConnection's doc comment) — resolves every page of
/// every saved workspace (or does nothing if none are saved), attaches every
/// session it references, registers Tauri-managed state for the commands
/// below, and spawns a background thread that relays every subsequent daemon
/// message to the frontend as a Tauri event. Called once from the app's setup
/// hook.
/// Renames the pinned workspace from its old label to the current one.
/// The id never moves (UNFILED_WORKSPACE_ID is what every persisted page
/// hangs off), so this is purely cosmetic -- but without it an install
/// that predates the app hub keeps saying "Unfiled" forever, since the
/// seed above only runs when the workspace is absent entirely.
///
/// Guarded on the old name rather than applied unconditionally: a config
/// whose pinned workspace reads anything else was renamed deliberately,
/// and that outranks our default.
fn rename_legacy_unfiled(workspaces: &mut [Workspace]) {
    for ws in workspaces.iter_mut() {
        if ws.id == crate::config::UNFILED_WORKSPACE_ID
            && ws.name == crate::config::LEGACY_UNFILED_WORKSPACE_NAME
        {
            ws.name = crate::config::SCRATCHPAD_WORKSPACE_NAME.to_string();
        }
    }
}

/// Drops the retired dev-only "Smoke Test" workspace. It used to be
/// appended at bootstrap by debug builds and stripped by release ones;
/// now nothing creates it and every build strips it, so a dev config.json
/// that still carries one loses it on the next launch rather than keeping
/// a workspace no build can explain. Kept as a migration rather than
/// deleted outright: the id is written into config.json, and only code
/// that names it can take it back out.
fn drop_smoketest_workspace(workspaces: &mut Vec<Workspace>) {
    workspaces.retain(|w| w.id != crate::config::SMOKETEST_WORKSPACE_ID);
}

/// Clears every `main_session_id` the daemon no longer has (unknown, or
/// exited). Deliberately CLEARS rather than replacing with a fresh
/// session, unlike `resolve_sessions` does for page tabs: starting an
/// agent costs money and attention, so it only ever happens because the
/// user pressed Start (D12).
///
/// Fetches its own session list rather than sharing `resolve_workspaces`'
/// one: that function skips the round trip entirely when no page tab is a
/// session, and a workspace can legitimately have a main agent and no
/// page sessions at all.
fn reconcile_main_sessions(workspaces: &mut [Workspace], lanes: &DaemonLanes) -> anyhow::Result<()> {
    if !workspaces.iter().any(|w| w.main_session_id.is_some()) {
        return Ok(());
    }
    let sessions = list_valid_session_ids(lanes)?;
    // An ssh workspace's main agent runs on its host; `remote::link_workspace`
    // reconciles it against that daemon's list.
    for workspace in workspaces.iter_mut().filter(|w| w.ssh.is_none()) {
        let Some(id) = workspace.main_session_id.clone() else { continue };
        let alive = sessions.get(id.as_str()).is_some_and(|s| s.status != "exited");
        if !alive {
            workspace.main_session_id = None;
        }
    }
    Ok(())
}

/// Tab ids that are NOT sessions. File, board and card tabs live in the
/// same id space as sessions in the layout tree, but the daemon has never
/// heard of them -- attaching one would fail for an id that was never a
/// session, and `resolve_sessions` would replace it with a freshly
/// spawned shell on every launch.
pub(crate) fn non_session_tab_ids(
    file_tabs: &HashMap<String, String>,
    board_tabs: &HashMap<String, crate::config::BoardTabRecord>,
    card_tabs: &HashMap<String, crate::config::CardTabRecord>,
) -> HashSet<String> {
    file_tabs
        .keys()
        .chain(board_tabs.keys())
        .chain(card_tabs.keys())
        .cloned()
        .collect()
}

/// Every session id this app expects the daemon to stream for it.
///
/// Main agent sessions live outside every page tree by design (D12), so
/// the page-tree walk cannot see them -- without the second half they
/// reattach to nothing and render blank forever (Milestone C's bug).
fn attachable_session_ids(
    data: &WorkspacesData,
    non_session_tab_ids: &HashSet<String>,
) -> Vec<String> {
    // Local workspaces only: an ssh workspace's sessions are attached on
    // its link, and asking this daemon for them would be answered with
    // an error per id.
    data.workspaces
        .iter()
        .filter(|w| w.ssh.is_none())
        .flat_map(|w| w.pages.iter())
        .flat_map(|p| p.layout.all_session_ids())
        .filter(|id| !non_session_tab_ids.contains(id))
        .chain(
            data.workspaces
                .iter()
                .filter(|w| w.ssh.is_none())
                .filter_map(|w| w.main_session_id.clone()),
        )
        .collect()
}

/// A relay thread's stream ended. Silent when a newer connection has
/// already taken over (see `ConnectionEpoch`) -- that disconnect WAS the
/// restart, and surfacing it would flash the connection-error overlay
/// over a reconnect that is going fine.
fn report_disconnect(app_handle: &AppHandle, epoch: u64, message: String) {
    if app_handle.state::<ConnectionEpoch>().0.load(std::sync::atomic::Ordering::SeqCst) != epoch {
        return;
    }
    let _ = app_handle.emit("daemon-error", message);
}

/// Attaches every session on the streaming connection and starts the
/// thread that relays the daemon's pushes to the frontend as Tauri
/// events. Shared by the cold path (`bootstrap`) and the reconnect path
/// (`reconnect`) so the two can never drift on what gets attached or
/// which pushes are forwarded.
/// Whose streaming connection a relay thread reads, which decides what
/// the connection ending means.
pub(crate) enum RelayOwner {
    /// The local daemon: the connection the whole window rests on, so its
    /// end is `daemon-error` -- the overlay.
    Local,
    /// One host's link (`remote.rs`): only that host's workspaces are
    /// affected, so its end is `remote-link-lost` for that host and the
    /// rest of the app keeps working.
    Remote { host: String, link_id: u64 },
}

impl RelayOwner {
    fn lost(&self, app_handle: &AppHandle, epoch: u64, message: String) {
        match self {
            RelayOwner::Local => report_disconnect(app_handle, epoch, message),
            RelayOwner::Remote { host, link_id } => {
                crate::remote::link_lost(app_handle, host, *link_id, message)
            }
        }
    }
}

pub(crate) fn attach_and_relay(
    app_handle: &AppHandle,
    writer: &StreamWriter,
    reader_stream: Stream,
    session_ids: Vec<String>,
    // By value, not `&`: `DaemonCompat` is `Copy`, and the relay thread
    // spawned below needs its own owned copy to move into the `'static`
    // closure -- there is no `AppHandle`-free way to borrow it instead.
    compat: DaemonCompat,
    owner: RelayOwner,
) -> anyhow::Result<()> {
    for id in session_ids {
        send_request(writer, &Request::Attach { id }, &compat)?;
    }

    let epoch = app_handle.state::<ConnectionEpoch>().0.load(std::sync::atomic::Ordering::SeqCst);
    let mut reader = BufReader::new(reader_stream);
    let reader_app_handle = app_handle.clone();
    let relay_writer = writer.clone();
    std::thread::spawn(move || {
        // Wait for the frontend to confirm its listeners are registered
        // before reading -- and therefore emitting -- anything from the
        // daemon (see FrontendReady's doc comment). Bounded: an unbounded
        // wait here would leave the daemon's connection-handling thread
        // blocked mid-write on a full scrollback replay, backing up
        // through the session's writer mutex into the PTY pump -- worse
        // than the small chance of an early emit being missed if the
        // frontend is simply slow rather than broken. On a reconnect the
        // flag is long since set, so this falls straight through.
        let gate_deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if reader_app_handle
                .state::<FrontendReady>()
                .0
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                break;
            }
            if Instant::now() >= gate_deadline {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        loop {
            let resp: Option<Response> = match read_message(&mut reader) {
                Ok(r) => r,
                Err(e) => {
                    owner.lost(&reader_app_handle, epoch, e.to_string());
                    break;
                }
            };
            let Some(resp) = resp else {
                owner.lost(&reader_app_handle, epoch, "daemon closed the connection".to_string());
                break;
            };
            match resp {
                Response::Output { id, data } => {
                    let _ = reader_app_handle.emit("pty-output", (id, data));
                }
                Response::SessionExited { id, exit_code } => {
                    let _ = reader_app_handle.emit("session-exited", (id, exit_code));
                }
                Response::CwdChanged { id, cwd } => {
                    let _ = reader_app_handle.emit("cwd-changed", (id, cwd));
                }
                Response::StatusChanged { id, status } => {
                    let _ = reader_app_handle.emit("session-status-changed", (id, status));
                }
                Response::GitStatusChanged { id, status } => {
                    let _ = reader_app_handle.emit("git-status-changed", (id, status));
                }
                Response::GitOpProgress { op_id, line } => {
                    // The very event `git::ops`'s local runner emits, with
                    // the same payload: the toolbar's progress row reads
                    // one stream of lines and cannot tell which machine
                    // drew them (v42).
                    crate::git::ops::emit_progress(&reader_app_handle, op_id, line);
                }
                Response::GitOpDone { op_id, error } => {
                    // Not an event: the caller in `git::ops::run_op` is
                    // parked on this, so handing it over is what makes a
                    // remote fetch return like a local one.
                    crate::remote::finish_git_op(&op_id, error);
                }
                Response::GitWorktreeChanged { cwd } => {
                    // The host's watcher fired. Emitted as `git-changed`,
                    // the same event the desktop's own `notify` watch
                    // emits for a local worktree (v42).
                    let _ = reader_app_handle
                        .emit("git-changed", crate::git::watch::GitChanged { cwd });
                }
                Response::SessionRestored { id } => {
                    let _ = reader_app_handle.emit("session-restored", id);
                }
                Response::SessionInterrupted { id } => {
                    let _ = reader_app_handle.emit("session-interrupted", id);
                }
                Response::SessionOrphaned { id, orphan } => {
                    let _ = reader_app_handle.emit("session-orphaned", (id, orphan));
                }
                Response::SessionFailed { id, reason } => {
                    let _ = reader_app_handle.emit("session-failed", (id, reason));
                }
                Response::QueuedInputsChanged { id, queued } => {
                    // Carries the whole queue, never a delta, so a
                    // frontend that missed one of these cannot drift --
                    // and so the Attach baseline and this push are the
                    // same message with the same handler.
                    let _ = reader_app_handle.emit("queued-inputs-changed", (id, queued));
                }
                Response::OrchestrationChanged { workspace_id, orchestration } => {
                    let _ = reader_app_handle
                        .emit("orchestration-changed", (workspace_id, orchestration));
                }
                Response::GavinTreeChanged { workspace_id, tree } => {
                    let _ = reader_app_handle.emit("gavin-tree-changed", (workspace_id, tree));
                }
                Response::ToolsChanged { workspace_id, tools } => {
                    // An agent authored a tool over gavin-mcp (v37). The
                    // whole library, never a delta, so the frontend
                    // replaces its rows for this workspace the same way
                    // a fetch would -- and cannot drift by missing one.
                    let _ = reader_app_handle.emit("tools-changed", (workspace_id, tools));
                }
                Response::SessionNamed { session_id, name } => {
                    // The frontend applies it through setSessionName, the
                    // very path the tab's own rename UI takes -- so an
                    // agent rename and a human rename persist identically.
                    let _ = reader_app_handle.emit("session-named", (session_id, name));
                }
                // The three device pushes (v42). Forwarded verbatim, the
                // way `remote-link-ready`/`remote-link-lost` are: the
                // Settings section is the only listener, and what it does
                // with each is its own (`remoteAccess.ts`).
                //
                // `DevicePairingRequested` is the one that cannot be
                // dropped. It is the ONLY notice a phone has finished the
                // handshake and is waiting on the human -- the daemon
                // pushes it once and keeps nothing to re-read, because
                // the pending handshake lives in memory until it is
                // answered or replaced. So it rides the stream
                // connection, which is the one the app keeps open for its
                // whole life.
                Response::DevicePairingRequested { device_id, name, sas } => {
                    let _ = reader_app_handle
                        .emit("device-pairing-requested", (device_id, name, sas));
                }
                // Nothing in the binary produces these two in phase 2 --
                // there is no transport yet -- so today they arrive only
                // in the daemon's own tests. Forwarded anyway: phase 3's
                // `remote.rs` is what makes them routine, and a listener
                // that has to be remembered later is a listener that is
                // forgotten.
                Response::DeviceConnected { device_id } => {
                    let _ = reader_app_handle.emit("device-connected", device_id);
                }
                Response::DeviceDisconnected { device_id } => {
                    let _ = reader_app_handle.emit("device-disconnected", device_id);
                }
                Response::AgentSessionSpawned { workspace_id, session_id, cwd, command } => {
                    // Attach BEFORE emitting: a session nobody attaches
                    // renders blank forever (the Milestone-C lesson).
                    let _ = send_request(
                        &relay_writer,
                        &Request::Attach { id: session_id.clone() },
                        &compat,
                    );
                    let _ = reader_app_handle
                        .emit("agent-session-spawned", (workspace_id, session_id, cwd, command));
                }
                Response::Error { message } => {
                    // A REJECTED REQUEST, not a lost connection. This
                    // connection carries Attach/WriteInput/ResizeSession,
                    // and the daemon answers every one of them with
                    // Response::Error for an id it no longer has -- so a
                    // resize racing a session's exit, or a pane mounted
                    // for a tab id that was never a session, used to put
                    // the whole window behind the "Couldn't connect to
                    // the daemon" overlay. (The Milestone-C plan called
                    // that out as a known limitation it did not
                    // special-case.) `daemon-error` now means only what
                    // report_disconnect and bootstrap mean by it: the
                    // connection is gone. A rejected request gets its own
                    // event, surfaced as a dismissible banner over a
                    // still-working app.
                    let _ = reader_app_handle.emit("daemon-request-error", message);
                }
                _ => {}
            }
        }
    });
    Ok(())
}


/// One-time carry-over of D34's `agentCommand` from config.json into
/// config.toml (D41). Writes only when config.toml has no
/// `[agent].command`, so the file always wins on later launches and a
/// user's own edit is never reverted. Unrooted workspaces have nowhere to
/// carry to and are skipped by the caller -- no loss, since
/// startMainAgent already refuses to run without a root.
fn carry_over_agent_command(root_path: &str, legacy: Option<&str>) -> anyhow::Result<()> {
    let Some(legacy) = legacy.filter(|c| !c.trim().is_empty()) else { return Ok(()) };
    let path = std::path::Path::new(root_path).join(".gavin-root").join("config.toml");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let already = existing
        .parse::<toml::Table>()
        .ok()
        .and_then(|t| Some(t.get("agent")?.as_table()?.contains_key("command")))
        .unwrap_or(false);
    if already {
        return Ok(());
    }
    crate::agent_setup::write_root_config_key(std::path::Path::new(root_path), "command", legacy)
}

pub fn bootstrap(app_handle: AppHandle) -> anyhow::Result<()> {
    let socket = socket_path()?;
    let mut stream_conn = crate::daemon::connect_or_spawn(
        &socket,
        Duration::from_secs(3),
        crate::daemon::spawn_real_daemon,
    )?;
    handshake_deadline(&stream_conn, true);
    // The daemon is confirmed reachable by the connect above (which may
    // have just spawned it) — this second connection should succeed
    // immediately, no retry/backoff needed.
    let command_conn = Mutex::new(connect_for_handshake(&socket)?);
    let compat = verify_daemon_protocol(&command_conn)?;
    // Present the app's identity on both connections and verify the
    // daemon's proof (`sec-fix-client-identity.md`). A no-op against a
    // pre-v35 daemon; a proof mismatch aborts bootstrap (DP-06).
    app_handshake(&compat, &command_conn, &mut stream_conn)?;
    // The relay reads this one for as long as the app runs.
    handshake_deadline(&stream_conn, false);
    *app_handle.state::<DaemonCompatState>().0.lock().unwrap() = Some(compat);
    let command = CommandConnection::new(
        &socket,
        command_conn.into_inner().expect("protocol probe mutex poisoned"),
        open_command_stream(&socket, &compat)?,
        &compat,
    );
    let lanes = command.lanes(compat);

    let writer = StreamWriter::spawn(stream_conn.try_clone()?);
    let reader_stream = stream_conn;

    let config_dir = app_handle.path().app_config_dir()?;
    let config = crate::config::load(&config_dir)?;
    let session_names = config.session_names;
    let file_tabs = config.file_tabs;
    let board_tabs = config.board_tabs;
    let card_tabs = config.card_tabs;

    let mut workspaces = config.workspaces;
    // A truly fresh install (no config.json yet, or one from before this
    // feature) has zero workspaces -- in that case the app should open
    // directly into the newly-created Unfiled workspace rather than the
    // usual "no workspace, create one" empty state. An install that
    // already has real workspaces keeps whatever was active, and Unfiled
    // is just silently added to the list without disturbing it.
    let had_no_workspaces = workspaces.is_empty();
    if !workspaces.iter().any(|w| w.id == crate::config::UNFILED_WORKSPACE_ID) {
        workspaces.insert(
            0,
            Workspace {
                id: crate::config::UNFILED_WORKSPACE_ID.to_string(),
                name: crate::config::SCRATCHPAD_WORKSPACE_NAME.to_string(),
                pages: vec![],
                active_page_id: None,
                active_view: None,
                hub_view: None,
                root_path: None,
                main_session_id: None,
                orchestration_agent: None,
                developing_cards: Vec::new(),
                legacy_agent_command: None,
                color: None,
                notify_needs_input: true,
                notify_finished: true,
                confirm_tab_close: true,
                home_agent_share: None,
                git_view: None,
                last_active_at: None,
                terminal_font_size: None,
                auto_commit: None,
                auto_resume_runs: false,
                agent_pause: None,
                pinned_at: None,
                complexity_agents: HashMap::new(),
                git_tracking_asked: false,
                trusted_config_hash: None,
                mcp_foreign_servers_choice: None,
                reviewed_cards: None,
                require_review: None,
                headroom: None,
                require_review_asked: false,
                headroom_asked: false,
                custom_resume_args: None,
            agent_fallback: None,
            armed_agents: Vec::new(),
            declined_agents: Vec::new(),
            ssh: None,
            action_prompt_overrides: HashMap::new(),
            },
        );
    }
    rename_legacy_unfiled(&mut workspaces);
    drop_smoketest_workspace(&mut workspaces);
    // D41: take() clears the legacy value, so the next save drops the key
    // from config.json permanently.
    for ws in workspaces.iter_mut() {
        if let (Some(root), Some(legacy)) = (ws.root_path.clone(), ws.legacy_agent_command.take()) {
            if let Err(e) = carry_over_agent_command(&root, Some(&legacy)) {
                eprintln!("agent command carry-over failed for {}: {e}", ws.id);
            }
        }
    }
    reconcile_main_sessions(&mut workspaces, &lanes)?;
    let non_session_tab_ids = non_session_tab_ids(&file_tabs, &board_tabs, &card_tabs);
    resolve_workspaces(&mut workspaces, &lanes, &non_session_tab_ids)?;
    let active_workspace_id = if had_no_workspaces {
        Some(crate::config::UNFILED_WORKSPACE_ID.to_string())
    } else {
        config.active_workspace_id
    };
    let workspaces_data = WorkspacesData {
        workspaces,
        active_workspace_id,
        removed_workspaces: config.removed_workspaces.clone(),
    };
    persist_workspaces(
        &config_dir,
        &workspaces_data,
        session_names.clone(),
        file_tabs.clone(),
        board_tabs.clone(),
        card_tabs.clone(),
        config.theme.clone(),
        config.agent_models.clone(),
        config.terminal_font_size,
        config.auto_commit,
        config.agent_pause.clone(),
        config.superpowers.clone(),
        config.agent_defaults.clone(),
        config.git_tracking,
        config.require_review,
        config.headroom,
        config.launch,
        config.custom_resume_args.clone(),
    )?;

    let session_ids = attachable_session_ids(&workspaces_data, &non_session_tab_ids);

    app_handle.manage(DaemonConnection::new(writer.clone()));
    app_handle.manage(command);
    app_handle.manage(WorkspacesState(Mutex::new(workspaces_data.clone())));
    app_handle.manage(SessionNames(Mutex::new(session_names)));
    app_handle.manage(FileTabs(Mutex::new(file_tabs)));
    app_handle.manage(BoardTabs(Mutex::new(board_tabs)));
    app_handle.manage(CardTabs(Mutex::new(card_tabs)));
    app_handle.manage(ThemePref(Mutex::new(config.theme)));
    app_handle.manage(AgentModels(Mutex::new(config.agent_models)));
    app_handle.manage(TerminalFontSize(Mutex::new(config.terminal_font_size)));
    app_handle.manage(AutoCommit(Mutex::new(config.auto_commit)));
    app_handle.manage(AgentPause(Mutex::new(config.agent_pause)));
    app_handle.manage(SuperpowersMarks(Mutex::new(config.superpowers)));
    app_handle.manage(AgentDefaults(Mutex::new(config.agent_defaults)));
    app_handle.manage(GitTrackingDefaults(Mutex::new(config.git_tracking)));
    app_handle.manage(RequireReviewDefaults(Mutex::new(config.require_review)));
    app_handle.manage(HeadroomDefaults(Mutex::new(config.headroom)));
    app_handle.manage(LaunchSettings(Mutex::new(config.launch)));
    app_handle.manage(CustomResumeArgs(Mutex::new(config.custom_resume_args)));
    app_handle.emit("workspaces-ready", &workspaces_data)?;

    attach_and_relay(&app_handle, &writer, reader_stream, session_ids, compat, RelayOwner::Local)?;
    // The ssh workspaces, after the window is up: each host on its own
    // thread, a host that is down costing only its own workspaces.
    crate::remote::link_all(app_handle.clone());
    Ok(())
}

#[tauri::command]
pub fn write_input(
    session_id: String,
    data: String,
    app_handle: AppHandle,
    state: State<DaemonConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let route = crate::remote::route_for_session(&app_handle, &session_id)?;
    with_writer(route, &state, &compat, |writer, compat| {
        send_request(writer, &Request::WriteInput { id: session_id, data }, compat)
    })
    .map_err(|e| e.to_string())
}

/// The four follow-up-queue commands, which all answer with the queue
/// they left behind.
///
/// They ride the COMMAND connection, not the streaming one `write_input`
/// uses: each has a reply the caller needs, and the streaming connection
/// is where pushes arrive. The matching `QueuedInputsChanged` push comes
/// back on the streaming connection independently -- which is a feature,
/// not a duplication: it is how a second surface showing the same
/// session's queue learns about a change it did not make.
async fn queued_inputs_request(lanes: DaemonLanes, req: Request) -> Result<Vec<protocol::QueuedInput>, String> {
    queued_inputs(lanes.request(req).await)
}

fn queued_inputs(resp: anyhow::Result<Response>) -> Result<Vec<protocol::QueuedInput>, String> {
    match resp.map_err(|e| e.to_string())? {
        Response::QueuedInputs { queued } => Ok(queued),
        Response::Error { message } => Err(message),
        other => Err(format!("expected QueuedInputs, got {other:?}")),
    }
}

/// Holds a follow-up for a session and, if that session is already idle,
/// delivers it at once. The daemon decides which -- the app never has to
/// know a session's status to queue for it.
#[tauri::command]
pub async fn queue_input(
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
    session_id: String,
    text: String,
) -> Result<Vec<protocol::QueuedInput>, String> {
    let route = crate::remote::route_for_session(&app_handle, &session_id)?;
    queued_inputs_request(lanes_for(route, &state, &compat), Request::QueueInput { id: session_id, text }).await
}

/// Every session's pending follow-ups, on every daemon the app is
/// talking to.
///
/// The read-back for a push-fed map. `QueuedInputsChanged` reaches only
/// whoever is attached to a session, so a frontend that reloaded has
/// missed every one -- and a baseline that rides only on Attach is what
/// left the git chip blank after a reload.
#[tauri::command]
pub async fn list_queued_inputs(
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<Vec<protocol::QueuedInput>, String> {
    let local = state
        .lanes(current_compat(&compat))
        .submit(Request::ListQueuedInputs)
        .map_err(|e| e.to_string())?;
    // A link that cannot answer in time is left out -- its relay reports
    // it lost if it is -- and the local queue is still worth returning.
    let links = crate::remote::ask_every_link(&app_handle, |link| {
        queued_inputs_request(link.lanes(), Request::ListQueuedInputs)
    });
    let mut queued = queued_inputs(local.await)?;
    for more in links.answers().await {
        queued.extend(more);
    }
    Ok(queued)
}

/// The queue this session should have from now on, in order. One writer
/// for reorder, cancel and clear.
#[tauri::command]
pub async fn set_queued_inputs(
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
    session_id: String,
    queued_ids: Vec<String>,
) -> Result<Vec<protocol::QueuedInput>, String> {
    let route = crate::remote::route_for_session(&app_handle, &session_id)?;
    queued_inputs_request(
        lanes_for(route, &state, &compat),
        Request::SetQueuedInputs { id: session_id, queued_ids },
    )
    .await
}

/// Deliver one queued follow-up now, whatever the session is doing.
#[tauri::command]
pub async fn send_queued_input(
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
    session_id: String,
    queued_id: String,
) -> Result<Vec<protocol::QueuedInput>, String> {
    let route = crate::remote::route_for_session(&app_handle, &session_id)?;
    queued_inputs_request(
        lanes_for(route, &state, &compat),
        Request::SendQueuedInput { id: session_id, queued_id },
    )
    .await
}

#[tauri::command]
pub fn resize_session(
    session_id: String,
    cols: u16,
    rows: u16,
    app_handle: AppHandle,
    state: State<DaemonConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let route = crate::remote::route_for_session(&app_handle, &session_id)?;
    with_writer(route, &state, &compat, |writer, compat| {
        send_request(writer, &Request::ResizeSession { id: session_id, cols, rows }, compat)
    })
    .map_err(|e| e.to_string())
}

/// Shared by the create_session command below and resolve_sessions's
/// per-tab fallback (via resolve_workspaces) -- "create a fresh session at
/// the given cwd (or $HOME when there is none), and return its id."
///
/// A `cwd` from a stale registry record (resolve_sessions's last-known-cwd
/// case) can point at a directory that no longer exists -- exactly the
/// scenario recover() itself marks Exited when a session's workspace_path
/// vanishes. The daemon's own create_session rejects a non-directory cwd,
/// and that Error would otherwise propagate all the way up through
/// resolve_workspaces into bootstrap(), which turns any Err into an
/// app-wide "daemon-error" event -- the exact whole-app-blanking failure
/// mode this milestone exists to avoid, except now hit on every
/// subsequent launch (persist_workspaces never runs to fix up the config,
/// since it's gated on resolve_workspaces succeeding). So a rejected
/// non-$HOME target falls back to $HOME once before giving up for real.
/// `workspace_root` is the workspace the session BELONGS to, which is not
/// always where it runs: a rail launches its agent in a worktree, and the
/// card it is told to write lives in the main checkout. The daemon records
/// the two separately and its agent scope gate reads both
/// (`scope_roots`), so sending the cwd for both -- which is what every
/// caller did while the field carried no information -- confines such an
/// agent to the worktree and has the daemon refuse the one card write the
/// run prompt demands of it.
///
/// `None` means the caller has no workspace to name (a bare terminal, a
/// tool run outside any root), and keeps the cwd in both fields.
/// This machine's home, for the local daemon's sessions. "/" only when
/// there is no home at all: the point of the fallback is a directory that
/// certainly exists, and every OS has that one.
pub(crate) fn local_home() -> String {
    crate::home::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "/".to_string())
}

/// The profile to name in a `CreateSession` for a daemon at
/// `daemon_version`, which is none at all for one that would drop it.
///
/// The field widens a request that has been v1 since v1, so
/// `min_version_for` -- and with it the gate every request passes on its
/// way to a lane -- cannot see it. A daemon older than the widening
/// parses the request, discards the profile and launches the agent
/// uncompressed with nothing anywhere saying why. Withholding it here
/// makes "an older daemon is never sent one" true of every caller,
/// including one that forgot to ask `featureBlockedReason` first.
pub(crate) fn profile_for_daemon(daemon_version: u32, profile_id: Option<&str>) -> Option<String> {
    if daemon_version < protocol::COMPRESSED_LAUNCH_MIN_VERSION {
        return None;
    }
    profile_id.map(str::trim).filter(|id| !id.is_empty()).map(str::to_string)
}

/// The API family to name in a `CreateSession`: the custom agent's, on
/// a launch of the custom profile, for a daemon that reads it -- and
/// none otherwise.
///
/// Only the custom profile, because every other one is a binary the
/// daemon already knows the API of, and a family sent with it would be
/// a second answer to a question it has settled. None when the setting
/// names none, which is the default and means no recipe. And none for a
/// daemon older than the widening, for the reason `profile_for_daemon`
/// gives: it would parse the request and drop the field.
pub(crate) fn api_family_for_daemon(
    daemon_version: u32,
    profile_id: Option<&str>,
    api_family: Option<&str>,
) -> Option<String> {
    if daemon_version < protocol::CUSTOM_API_FAMILY_MIN_VERSION {
        return None;
    }
    if profile_id.map(str::trim) != Some("custom") {
        return None;
    }
    api_family.map(str::trim).filter(|family| !family.is_empty()).map(str::to_string)
}

/// `home` is the fallback cwd, and it belongs to the machine the daemon
/// is on: `local_home()` for the local daemon, the banner's `home` for a
/// link (`remote.rs`).
///
/// `profile_id` is the agent profile doing the launching, and `None` for
/// everything that is not an agent launch. It is what makes the session
/// a candidate for compression, which the daemon decides. `api_family`
/// is the custom agent's, from its settings; it is sent only with the
/// custom profile (`api_family_for_daemon`).
pub(crate) async fn create_fresh_session(
    lanes: &DaemonLanes,
    cwd: Option<&str>,
    workspace_root: Option<&str>,
    command: Option<&str>,
    profile_id: Option<&str>,
    api_family: Option<&str>,
    home: &str,
) -> anyhow::Result<String> {
    let home = home.to_string();
    let target = cwd.map(str::to_string).unwrap_or_else(|| home.clone());
    let workspace = workspace_root.map(str::to_string).unwrap_or_else(|| target.clone());
    let command = command.map(str::to_string);
    let daemon_version = lanes.compat().daemon_version;
    let api_family = api_family_for_daemon(daemon_version, profile_id, api_family);
    let profile_id = profile_for_daemon(daemon_version, profile_id);

    let resp = lanes
        .request(Request::CreateSession {
            workspace_path: workspace,
            cwd: target.clone(),
            command: command.clone(),
            profile_id,
            api_family,
        })
        .await?;
    match resp {
        Response::SessionCreated { id } => return Ok(id),
        Response::Error { message } if target != home => {
            eprintln!("failed to recreate session at last-known cwd {target}, falling back to $HOME: {message}");
        }
        other => anyhow::bail!("expected SessionCreated, got {other:?}"),
    }

    // The workspace is dropped here along with the cwd, deliberately. This
    // branch means the directory the session was meant for could not be
    // honoured, so what comes back is a plain shell in $HOME rather than
    // that workspace's session -- and an agent scope the session's cwd no
    // longer sits inside is not one to hand it on an error path.
    //
    // The profile goes with them, and its API family. Compression is a
    // property of the workspace a session belongs to, and this one
    // belongs to none.
    let resp = lanes
        .request(Request::CreateSession {
            workspace_path: home.clone(),
            cwd: home.clone(),
            command,
            profile_id: None,
            api_family: None,
        })
        .await?;
    match resp {
        Response::SessionCreated { id } => Ok(id),
        other => anyhow::bail!("expected SessionCreated, got {other:?}"),
    }
}

/// Routed by `workspace_root`: a root that belongs to an ssh workspace
/// creates the session on that host's daemon, in that host's home when
/// the cwd is gone, and records the id as the link's so every later
/// command on it (`write_input`, `kill_session`, …) finds the same link.
///
/// `profile_id` is the agent profile doing the launching, sent by every
/// surface that launches an agent and by nothing else. On an ssh route
/// it reaches the HOST's daemon, which holds no copy of the compression
/// switch -- the desk pushes that to its own daemon only -- so a session
/// there is never compressed, which is what v1 of Headroom promises for
/// an ssh workspace.
///
/// The custom agent's API family is read here rather than sent by every
/// surface that launches one: it is a setting of the custom agent this
/// host keeps (`AgentDefaultsConfig::custom_api_family`), the profile id
/// already says the launch is that agent's, and a launch that had to
/// carry it would be one more argument on every surface for a value
/// none of them decides.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_session(
    cwd: Option<String>,
    workspace_root: Option<String>,
    command: Option<String>,
    profile_id: Option<String>,
    app_handle: AppHandle,
    command_state: State<'_, CommandConnection>,
    daemon_state: State<'_, DaemonConnection>,
    compat: State<'_, DaemonCompatState>,
    agent_defaults: State<'_, AgentDefaults>,
) -> Result<String, String> {
    let api_family = agent_defaults.0.lock().unwrap().custom_api_family.clone();
    if let crate::remote::Route::Remote(link) =
        crate::remote::route_for_root(&app_handle, workspace_root.as_deref())?
    {
        let id = create_fresh_session(
            &link.lanes(),
            cwd.as_deref(),
            workspace_root.as_deref(),
            command.as_deref(),
            profile_id.as_deref(),
            Some(&api_family),
            &link.home,
        )
        .await
        .map_err(|e| e.to_string())?;
        crate::remote::remember_session(&app_handle, &id, &link.host);
        send_request(&link.writer, &Request::Attach { id: id.clone() }, &link.compat)
            .map_err(|e| e.to_string())?;
        return Ok(id);
    }
    let compat = current_compat(&compat);
    let id = create_fresh_session(
        &command_state.lanes(compat),
        cwd.as_deref(),
        workspace_root.as_deref(),
        command.as_deref(),
        profile_id.as_deref(),
        Some(&api_family),
        &local_home(),
    )
    .await
    .map_err(|e| e.to_string())?;

    send_request(&daemon_state.writer, &Request::Attach { id: id.clone() }, &compat)
        .map_err(|e| e.to_string())?;
    Ok(id)
}

/// Hands the LOCAL daemon every workspace's effective compression
/// setting, in place of whatever it held.
///
/// The daemon keeps a copy because it is the one deciding at spawn, and
/// a session another agent spawns over MCP never passes through the
/// app. The frontend resolves the list (a workspace's own choice, else
/// the app-wide default) and sends it whenever it changes; the daemon
/// persists it, and runs Headroom while any workspace is on.
///
/// Aimed at the local daemon and nothing else, like the remote-access
/// commands: an ssh workspace's sessions are its host daemon's, and
/// compression there would need a Headroom installed and supervised on
/// the host.
///
/// A new request TYPE, so the lane's own gate refuses it against a
/// daemon older than v47 and the error names both versions. The answer
/// is Headroom's status AFTER the list was taken.
#[tauri::command]
pub async fn set_headroom_workspaces(
    workspaces: Vec<protocol::HeadroomWorkspace>,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<protocol::HeadroomStatus, String> {
    let resp = state
        .lanes(current_compat(&compat))
        .request(Request::SetHeadroomWorkspaces { workspaces })
        .await
        .map_err(|e| e.to_string())?;
    headroom_status(resp)
}

/// Headroom on this machine, as the LOCAL daemon -- the one that has to
/// execute it -- sees it: installed or not, at what version against the
/// floor and the pin, running or not, on which port, and what it has
/// saved. What Settings' Headroom section and the wizard's step draw.
///
/// Local only, like `set_headroom_workspaces` and for its reason: an ssh
/// workspace is Unavailable, and its host's daemon runs no Headroom for
/// this machine to show.
///
/// A new request TYPE (v46), so the lane's gate refuses it against an
/// older daemon with both versions named. The app does not ask one: it
/// reads `FEATURE_MIN_VERSION.headroomSetup` first and says what the
/// section needs instead.
#[tauri::command]
pub async fn get_headroom_status(
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<protocol::HeadroomStatus, String> {
    let resp = state
        .lanes(current_compat(&compat))
        .request(Request::GetHeadroomStatus)
        .await
        .map_err(|e| e.to_string())?;
    headroom_status(resp)
}

/// Every card run's savings snapshot that ended at or after `since`
/// (epoch seconds), from the LOCAL daemon: what the hub sums into each
/// agent's limit window.
///
/// Local only, like the other Headroom commands: an ssh workspace is
/// Unavailable, so its host's daemon took no snapshots for this machine.
/// A new request TYPE (v49), so the lane's gate refuses it against an
/// older daemon; the app reads `FEATURE_MIN_VERSION.headroomSavings`
/// first and does not ask one.
#[tauri::command]
pub async fn headroom_savings(
    since: i64,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<Vec<protocol::RunSavings>, String> {
    let resp = state
        .lanes(current_compat(&compat))
        .request(Request::HeadroomSavings { since })
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        Response::HeadroomSavings { runs } => Ok(runs),
        Response::Error { message } => Err(message),
        other => Err(format!("expected Headroom's savings, got {other:?}")),
    }
}

/// Looks for Headroom again: Settings' Check again (`located_path`
/// absent) and Locate… (the file the human picked, remembered from then
/// on; an empty string forgets it). Runs `headroom --version`, which is
/// a Python start.
#[tauri::command]
pub async fn detect_headroom(
    located_path: Option<String>,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<protocol::HeadroomStatus, String> {
    let resp = state
        .lanes(current_compat(&compat))
        .request(Request::DetectHeadroom { located_path })
        .await
        .map_err(|e| e.to_string())?;
    headroom_status(resp)
}

/// Installs the pinned Headroom with `uv` and fetches its compression
/// model: Settings' Install and Update, and the wizard's Install. The
/// daemon answers at once with the install marked running, and the
/// caller reads its progress off the status.
#[tauri::command]
pub async fn install_headroom(
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<protocol::HeadroomStatus, String> {
    let resp = state
        .lanes(current_compat(&compat))
        .request(Request::InstallHeadroom)
        .await
        .map_err(|e| e.to_string())?;
    headroom_status(resp)
}

/// The status a Headroom request answers with -- every one answers with
/// the status AFTER it. Each command awaits its own lane, in its own
/// body, so the main-thread guard can see that it does.
fn headroom_status(resp: Response) -> Result<protocol::HeadroomStatus, String> {
    match resp {
        Response::Headroom { status } => Ok(status),
        Response::Error { message } => Err(message),
        other => Err(format!("expected Headroom's status, got {other:?}")),
    }
}

/// Asks the daemon to repaint this session's terminal.
///
/// The frontend learns a terminal's contents from `pty-output` pushes, and
/// the screen those pushes build up lives only in the webview's `Terminal`
/// object. A frontend reload throws that object away and builds a blank one
/// -- and nothing re-sends anything, because `Attach` runs once per app
/// PROCESS (`attach_and_relay`), not once per frontend load. Under
/// `tauri dev` that is every frontend edit. What arrives next is the running
/// program's next repaint DELTA, computed against a screen this terminal no
/// longer has, so it paints a broken frame.
///
/// A second `Attach` would also repaint, but it re-sends the
/// `CwdChanged` / `StatusChanged` / `SessionRestored` baselines with it, and
/// a `waiting_for_input` baseline notifies unconditionally
/// (`notifications.ts`) -- every hot reload would fire an OS notification for
/// every session waiting on the human. This asks for the screen and nothing
/// else.
///
/// Best-effort by design: against a daemon older than the screen model, the
/// gate refuses the request and the terminal is simply left as it was found,
/// which is what happened before any of this existed.
#[tauri::command]
pub fn snapshot_session(
    session_id: String,
    app_handle: AppHandle,
    daemon_state: State<DaemonConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let route = crate::remote::route_for_session(&app_handle, &session_id)?;
    with_writer(route, &daemon_state, &compat, |writer, compat| {
        send_request(writer, &Request::Snapshot { id: session_id }, compat)
    })
    .map_err(|e| e.to_string())
}

/// This session's screen as plain text -- the visible grid, no escape
/// sequences.
///
/// The read `snapshot_session` cannot be. That one asks the daemon to
/// REPAINT a terminal: the bytes it produces are escape sequences written
/// to whatever terminal is attached, and it answers this process nothing.
/// The TypeSafe turn verdict needs the TEXT, and needs it for sessions
/// with no terminal attached at all -- a rail step in a background pane,
/// a card run nobody is watching -- which is every case the feature
/// exists for.
///
/// NOT best-effort, unlike `snapshot_session` and `set_failure_patterns`.
/// Those two degrade into doing nothing, which is a fine outcome for a
/// repaint that does not happen. An unanswered screen read is different:
/// the caller is about to pass judgement on a turn, and the empty string
/// is a perfectly parseable screen that any reader would call finished.
/// So the error crosses back, and `turnVerdictState.ts` treats it the way
/// it treats a timeout and a missing key -- no verdict at all, today's
/// answer kept.
#[tauri::command]
pub async fn session_screen(
    session_id: String,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<String, String> {
    let resp = state
        .lanes(current_compat(&compat))
        .request(Request::SessionScreen { id: session_id })
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        Response::SessionScreen { contents, .. } => Ok(contents),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}

/// Tells the daemon what THIS session's agent prints when it has stopped
/// because something broke.
///
/// Sent once, right after the session is created, by whichever surface
/// launched an agent. The patterns come from the agent profile
/// (`agent_setup::AGENT_PROFILES`) and never from the daemon: the daemon
/// hosts every workspace's agents at once and has no idea which CLI any
/// of them is, while a hard-coded pattern would be a silent regression
/// the day a CLI reworks its messages -- and opencode's error text is
/// still unverified.
///
/// Best-effort, exactly like `snapshot_session`: against a daemon older
/// than v21 the gate refuses the request, nothing is sent, and a quiet
/// agent reads as idle the way it always did. A profile with no verified
/// patterns sends none, which the daemon reads as "no failure detection
/// for this session" -- never as "nothing failed".
#[tauri::command]
pub async fn set_failure_patterns(
    session_id: String,
    patterns: Vec<String>,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<(), String> {
    let route = crate::remote::route_for_session(&app_handle, &session_id)?;
    let resp = lanes_for(route, &state, &compat)
        .request(Request::SetFailurePatterns { id: session_id, patterns })
        .await
        .map_err(|e| e.to_string())?;
    expect_ok(resp)
}

#[tauri::command]
pub async fn kill_session(
    session_id: String,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<(), String> {
    let route = crate::remote::route_for_session(&app_handle, &session_id)?;
    let resp = lanes_for(route, &state, &compat)
        .request(Request::KillSession { id: session_id })
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}

/// Whether `session_id` is still alive, attaching to it when it is.
///
/// The one case that needs this: a HIDDEN run (the Git tab's "Commit via
/// agent") outlives the window it was launched from. Bootstrap cannot
/// recover it -- `resolve_sessions` only reconciles ids a page
/// references, and a hidden run is referenced by none -- so the frontend
/// re-offers the id it wrote down and asks this.
///
/// Attaching is the point, not a side effect: exit and output events only
/// reach the app for attached sessions, so a "yes, running" answer that
/// left the relay unsubscribed would be a spinner that never resolves.
/// Attach is idempotent daemon-side, so re-adopting an already-attached
/// session is harmless.
///
/// `ListSessions` keeps exited records, which is what makes a dead
/// session distinguishable from an unknown one -- both answer `false`
/// here, because the caller does the same thing with either.
async fn adopt_session_impl(
    lanes: &DaemonLanes,
    daemon_writer: &StreamWriter,
    session_id: String,
) -> anyhow::Result<bool> {
    let sessions = sessions_by_id(lanes.request(Request::ListSessions).await)?;
    let Some(record) = sessions.get(&session_id) else {
        return Ok(false);
    };
    if record.status == "exited" {
        return Ok(false);
    }
    send_request(daemon_writer, &Request::Attach { id: session_id }, lanes.compat())?;
    Ok(true)
}

#[tauri::command]
pub async fn adopt_session(
    session_id: String,
    app_handle: AppHandle,
    command_state: State<'_, CommandConnection>,
    daemon_state: State<'_, DaemonConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<bool, String> {
    match crate::remote::route_for_session(&app_handle, &session_id)? {
        crate::remote::Route::Remote(link) => {
            adopt_session_impl(&link.lanes(), &link.writer, session_id).await.map_err(|e| e.to_string())
        }
        crate::remote::Route::Local => adopt_session_impl(
            &command_state.lanes(current_compat(&compat)),
            &daemon_state.writer,
            session_id,
        )
        .await
        .map_err(|e| e.to_string()),
    }
}

async fn get_board_impl(
    lanes: &DaemonLanes,
    workspace_id: String,
) -> anyhow::Result<Board> {
    let resp = lanes.request(Request::GetBoard { workspace_id }).await?;
    match resp {
        Response::Board { columns, labels, mut card_sessions } => {
            // A daemon before v43 still fills every binding's launch
            // command. The webview never gets it either way: it is most
            // of the reply, the board is re-read on every tree push, and
            // the one reader asks for it by card (`card_session`).
            for binding in &mut card_sessions {
                binding.command = None;
            }
            Ok(Board { columns, labels, card_sessions })
        }
        other => anyhow::bail!("expected Board, got {other:?}"),
    }
}

#[tauri::command]
pub async fn get_board(
    workspace_id: String,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<Board, String> {
    let route = crate::remote::route_for_workspace(&app_handle, &workspace_id)?;
    get_board_impl(&lanes_for(route, &state, &compat), workspace_id).await.map_err(|e| e.to_string())
}

/// A card's run history (v27). Gated by `min_version_for` on the way
/// out like every other request, so against a daemon older than 27 this
/// fails with the version message rather than pretending the card has
/// never been run -- which is why the panel reads
/// `FEATURE_MIN_VERSION.runHistory` before it ever asks.
/// One card's binding WITH the command it launched -- the field the board
/// read leaves out (v43), and what Re-launch replays. None when nothing is
/// bound to the card.
///
/// A daemon older than 43 cannot parse `GetCardSession`, but its board
/// still carries every command, so against one this reads that board and
/// picks the card out of it. Re-launch keeps working across the skew
/// rather than greying out behind a restart it does not need -- which is
/// why no `FEATURE_MIN_VERSION` entry mirrors the request. Decided per
/// route: an ssh workspace's lanes carry its HOST's version.
async fn card_session_impl(
    lanes: &DaemonLanes,
    workspace_id: String,
    path: String,
) -> anyhow::Result<Option<CardSession>> {
    let req = Request::GetCardSession { workspace_id, path };
    if gate(&req, lanes.compat()).is_ok() {
        return match lanes.request(req).await? {
            Response::CardSession { card_session } => Ok(card_session),
            other => anyhow::bail!("expected CardSession, got {other:?}"),
        };
    }
    let Request::GetCardSession { workspace_id, path } = req else { unreachable!() };
    match lanes.request(Request::GetBoard { workspace_id }).await? {
        Response::Board { card_sessions, .. } => Ok(card_sessions.into_iter().find(|cs| cs.path == path)),
        other => anyhow::bail!("expected Board, got {other:?}"),
    }
}

#[tauri::command]
pub async fn card_session(
    workspace_id: String,
    path: String,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<Option<CardSession>, String> {
    let route = crate::remote::route_for_workspace(&app_handle, &workspace_id)?;
    card_session_impl(&lanes_for(route, &state, &compat), workspace_id, path).await.map_err(|e| e.to_string())
}

async fn card_runs_impl(
    lanes: &DaemonLanes,
    workspace_id: String,
    path: String,
) -> anyhow::Result<Vec<CardRun>> {
    let resp = lanes.request(Request::CardRuns { workspace_id, path }).await?;
    match resp {
        Response::CardRuns { runs } => Ok(runs),
        other => anyhow::bail!("expected CardRuns, got {other:?}"),
    }
}

#[tauri::command]
pub async fn card_runs(
    workspace_id: String,
    path: String,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<Vec<CardRun>, String> {
    let route = crate::remote::route_for_workspace(&app_handle, &workspace_id)?;
    card_runs_impl(&lanes_for(route, &state, &compat), workspace_id, path).await.map_err(|e| e.to_string())
}

async fn set_board_impl(
    lanes: &DaemonLanes,
    workspace_id: String,
    columns: Vec<Column>,
    labels: Vec<Label>,
) -> anyhow::Result<()> {
    let resp = lanes.request(Request::SetBoard { workspace_id, columns, labels }).await?;
    match resp {
        Response::Ok => Ok(()),
        other => anyhow::bail!("expected Ok, got {other:?}"),
    }
}

#[tauri::command]
pub async fn set_board(
    workspace_id: String,
    columns: Vec<Column>,
    labels: Vec<Label>,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<(), String> {
    let route = crate::remote::route_for_workspace(&app_handle, &workspace_id)?;
    set_board_impl(&lanes_for(route, &state, &compat), workspace_id, columns, labels)
        .await
        .map_err(|e| e.to_string())
}

// --- Orchestration (SP1) ----------------------------------------------------
//
// `state_value` rather than `state`: the Tauri State<CommandConnection>
// parameter already owns the name `state` in this file's convention.

async fn get_orchestration_impl(
    lanes: &DaemonLanes,
    workspace_id: String,
) -> anyhow::Result<Orchestration> {
    let resp = lanes.request(Request::GetOrchestration { workspace_id }).await?;
    match resp {
        Response::Orchestration { rails, conflict_notes, rail_runs, step_runs } => {
            Ok(Orchestration { rails, conflict_notes, rail_runs, step_runs })
        }
        other => anyhow::bail!("expected Orchestration, got {other:?}"),
    }
}

#[tauri::command]
pub async fn get_orchestration(
    workspace_id: String,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<Orchestration, String> {
    let route = crate::remote::route_for_workspace(&app_handle, &workspace_id)?;
    get_orchestration_impl(&lanes_for(route, &state, &compat), workspace_id).await.map_err(|e| e.to_string())
}

/// A refused write (the running-step guard) comes back as
/// Response::Error and must reach the caller verbatim -- the board's
/// save-error strip shows it, so it has to name the step.
pub(crate) fn expect_ok(resp: Response) -> Result<(), String> {
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("expected Ok, got {other:?}")),
    }
}

#[tauri::command]
pub async fn set_orchestration(
    workspace_id: String,
    rails: Vec<Rail>,
    conflict_notes: Vec<ConflictNote>,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<(), String> {
    let route = crate::remote::route_for_workspace(&app_handle, &workspace_id)?;
    let resp = lanes_for(route, &state, &compat)
        .request(Request::SetOrchestration { workspace_id, rails, conflict_notes })
        .await
        .map_err(|e| e.to_string())?;
    expect_ok(resp)
}

/// The rail-, step-, tool- and template-id writes carry no workspace on
/// the wire, so nothing here can tell whose daemon holds the id. The
/// caller may say (`workspaceId`), and an ssh workspace's scheduler must;
/// absent, the id is taken to be the local daemon's -- which is every
/// caller that predates ssh workspaces.
fn route_for_optional_workspace(
    app_handle: &AppHandle,
    workspace_id: Option<&str>,
) -> Result<crate::remote::Route, String> {
    match workspace_id {
        Some(id) => crate::remote::route_for_workspace(app_handle, id),
        None => Ok(crate::remote::Route::Local),
    }
}

#[tauri::command]
pub async fn set_rail_run(
    rail_id: String,
    state_value: String,
    current_stage_id: Option<String>,
    workspace_id: Option<String>,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<(), String> {
    let route = route_for_optional_workspace(&app_handle, workspace_id.as_deref())?;
    let resp = lanes_for(route, &state, &compat)
        .request(Request::SetRailRun { rail_id, state: state_value, current_stage_id })
        .await
        .map_err(|e| e.to_string())?;
    expect_ok(resp)
}

#[tauri::command]
pub async fn set_step_run(
    step_id: String,
    state_value: String,
    session_id: Option<String>,
    reason: Option<String>,
    conversation_id: Option<String>,
    launch_cwd: Option<String>,
    resume_attempts: Option<u32>,
    workspace_id: Option<String>,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<(), String> {
    let route = route_for_optional_workspace(&app_handle, workspace_id.as_deref())?;
    let resp = lanes_for(route, &state, &compat)
        .request(Request::SetStepRun {
            step_id,
            state: state_value,
            session_id,
            reason,
            conversation_id,
            launch_cwd,
            resume_attempts,
        })
        .await
        .map_err(|e| e.to_string())?;
    expect_ok(resp)
}

// --- The tool library -------------------------------------------------------
//
// These three arrived with the orchestration merge, which predates the
// compatibility window. They go through the gated path like every other
// command: their requests are v11, so against a v10 daemon they must fail
// locally rather than putting bytes on a socket that cannot parse them.

#[tauri::command]
pub async fn get_tools(
    workspace_id: String,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<Vec<ToolDef>, String> {
    let route = crate::remote::route_for_workspace(&app_handle, &workspace_id)?;
    let resp = lanes_for(route, &state, &compat)
        .request(Request::GetTools { workspace_id })
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        Response::Tools { tools } => Ok(tools),
        Response::Error { message } => Err(message),
        other => Err(format!("expected Tools, got {other:?}")),
    }
}

/// The daemon's validation (unknown kind, a built-in id, an empty name)
/// comes back as Response::Error and reaches the dialog verbatim.
/// Routed by the tool's own `workspace_id`; a global tool (none) is the
/// local daemon's.
#[tauri::command]
pub async fn save_tool(
    tool: ToolDef,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<(), String> {
    let route = route_for_optional_workspace(&app_handle, tool.workspace_id.as_deref())?;
    let resp = lanes_for(route, &state, &compat)
        .request(Request::SaveTool { tool })
        .await
        .map_err(|e| e.to_string())?;
    expect_ok(resp)
}

#[tauri::command]
pub async fn delete_tool(
    id: String,
    workspace_id: Option<String>,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<(), String> {
    let route = route_for_optional_workspace(&app_handle, workspace_id.as_deref())?;
    let resp = lanes_for(route, &state, &compat)
        .request(Request::DeleteTool { id })
        .await
        .map_err(|e| e.to_string())?;
    expect_ok(resp)
}

// --- Standalone tool runs (v30) ---------------------------------------------
//
// Three new request TYPES, so the gated send path is a real gate here:
// against a v29 daemon each of these fails locally with the version
// message rather than putting bytes on a socket that cannot parse them.
// The Tools tab is already dark there (FEATURE_MIN_VERSION.toolRuns), so
// this is the belt to that braces.

#[tauri::command]
pub async fn start_tool_run(
    workspace_id: String,
    tool_id: String,
    session_id: String,
    command: Option<String>,
    launch_cwd: Option<String>,
    conversation_id: Option<String>,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<(), String> {
    let route = crate::remote::route_for_workspace(&app_handle, &workspace_id)?;
    let resp = lanes_for(route, &state, &compat)
        .request(Request::StartToolRun {
            workspace_id,
            tool_id,
            session_id,
            command,
            launch_cwd,
            conversation_id,
        })
        .await
        .map_err(|e| e.to_string())?;
    expect_ok(resp)
}

#[tauri::command]
pub async fn set_tool_run_outcome(
    session_id: String,
    outcome: String,
    exit_code: Option<i32>,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<(), String> {
    let route = crate::remote::route_for_session(&app_handle, &session_id)?;
    let resp = lanes_for(route, &state, &compat)
        .request(Request::SetToolRunOutcome { session_id, outcome, exit_code })
        .await
        .map_err(|e| e.to_string())?;
    expect_ok(resp)
}

async fn tool_runs_impl(
    lanes: &DaemonLanes,
    workspace_id: String,
) -> anyhow::Result<Vec<ToolRun>> {
    let resp = lanes.request(Request::ToolRuns { workspace_id }).await?;
    match resp {
        Response::ToolRuns { runs } => Ok(runs),
        other => anyhow::bail!("expected ToolRuns, got {other:?}"),
    }
}

#[tauri::command]
pub async fn tool_runs(
    workspace_id: String,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<Vec<ToolRun>, String> {
    let route = crate::remote::route_for_workspace(&app_handle, &workspace_id)?;
    tool_runs_impl(&lanes_for(route, &state, &compat), workspace_id).await.map_err(|e| e.to_string())
}

// --- Group templates --------------------------------------------------------
//
// v15 requests, so against a v14 daemon they fail LOCALLY through the
// gated path rather than putting bytes on a socket that cannot parse
// them. The UI is already dark there (FEATURE_MIN_VERSION.groups), so
// this is the belt to that braces.

#[tauri::command]
pub async fn get_group_templates(
    workspace_id: String,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<Vec<GroupTemplate>, String> {
    let route = crate::remote::route_for_workspace(&app_handle, &workspace_id)?;
    let resp = lanes_for(route, &state, &compat)
        .request(Request::GetGroupTemplates { workspace_id })
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        Response::GroupTemplates { templates } => Ok(templates),
        Response::Error { message } => Err(message),
        other => Err(format!("expected GroupTemplates, got {other:?}")),
    }
}

/// Routed by the template's own `workspace_id`, like `save_tool`.
#[tauri::command]
pub async fn save_group_template(
    template: GroupTemplate,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<(), String> {
    let route = route_for_optional_workspace(&app_handle, template.workspace_id.as_deref())?;
    let resp = lanes_for(route, &state, &compat)
        .request(Request::SaveGroupTemplate { template })
        .await
        .map_err(|e| e.to_string())?;
    expect_ok(resp)
}

#[tauri::command]
pub async fn delete_group_template(
    id: String,
    workspace_id: Option<String>,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<(), String> {
    let route = route_for_optional_workspace(&app_handle, workspace_id.as_deref())?;
    let resp = lanes_for(route, &state, &compat)
        .request(Request::DeleteGroupTemplate { id })
        .await
        .map_err(|e| e.to_string())?;
    expect_ok(resp)
}

async fn delete_board_impl(
    lanes: &DaemonLanes,
    workspace_id: String,
) -> anyhow::Result<()> {
    let resp = lanes.request(Request::DeleteBoard { workspace_id }).await?;
    match resp {
        Response::Ok => Ok(()),
        other => anyhow::bail!("expected Ok, got {other:?}"),
    }
}

#[tauri::command]
pub async fn delete_board(
    workspace_id: String,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<(), String> {
    let route = crate::remote::route_for_workspace(&app_handle, &workspace_id)?;
    delete_board_impl(&lanes_for(route, &state, &compat), workspace_id).await.map_err(|e| e.to_string())
}

/// Rides the STREAMING connection (fire-and-forget, mirroring
/// write_input): the daemon intercepts WatchGavinRoot to capture that
/// connection's writer for pushes, and the initial scan arrives as the
/// first gavin-tree-changed event rather than a reply.
#[tauri::command]
pub fn watch_gavin_root(
    workspace_id: String,
    root_path: String,
    app_handle: AppHandle,
    conn: State<DaemonConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let route = crate::remote::route_for_workspace(&app_handle, &workspace_id)?;
    with_writer(route, &conn, &compat, |writer, compat| {
        send_request(writer, &Request::WatchGavinRoot { workspace_id, root_path }, compat)
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn unwatch_gavin_root(
    workspace_id: String,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<(), String> {
    let route = crate::remote::route_for_workspace(&app_handle, &workspace_id)?;
    let resp = lanes_for(route, &state, &compat)
        .request(Request::UnwatchGavinRoot { workspace_id })
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}

#[tauri::command]
pub async fn get_gavin_tree(
    workspace_id: String,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<protocol::GavinTree, String> {
    let route = crate::remote::route_for_workspace(&app_handle, &workspace_id)?;
    let resp = lanes_for(route, &state, &compat)
        .request(Request::GetGavinTree { workspace_id })
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        Response::GavinTreeSnapshot { tree, .. } => Ok(tree),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}

#[tauri::command]
pub async fn init_gavin_root(
    root_path: String,
    workspace_name: String,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<(), String> {
    let route = crate::remote::route_for_root(&app_handle, Some(&root_path))?;
    let resp = lanes_for(route, &state, &compat)
        .request(Request::InitGavinRoot { root_path, workspace_name })
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}

#[tauri::command]
pub async fn create_gavin_context(
    parent_folder: String,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<(), String> {
    let route = crate::remote::route_for_path(&app_handle, &parent_folder)?;
    let resp = lanes_for(route, &state, &compat)
        .request(Request::CreateGavinContext { parent_folder })
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}

#[tauri::command]
pub async fn add_external_gavin_context(
    root_path: String,
    folder: String,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<(), String> {
    let route = crate::remote::route_for_root(&app_handle, Some(&root_path))?;
    let resp = lanes_for(route, &state, &compat)
        .request(Request::AddExternalGavinContext { root_path, folder })
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}

#[tauri::command]
pub async fn remove_external_gavin_context(
    root_path: String,
    folder: String,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<(), String> {
    let route = crate::remote::route_for_root(&app_handle, Some(&root_path))?;
    let resp = lanes_for(route, &state, &compat)
        .request(Request::RemoveExternalGavinContext { root_path, folder })
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}

/// The set-root flow's init-vs-bind fork (spec §2) -- the frontend can't
/// stat the disk itself, and watching hasn't started yet at the moment
/// the picker returns.
///
/// A local root is a local `is_dir`. A root that belongs to an ssh
/// workspace is on another disk, so the question goes to that host's
/// daemon: `ScanGavinRoot` reports `root_missing` when there is no
/// `.gavin-root` there. Asked of the wrong disk this would answer
/// "not initialised" for every remote repo and offer to init it locally.
#[tauri::command]
pub async fn gavin_root_exists(root_path: String, app_handle: AppHandle) -> Result<bool, String> {
    match crate::remote::route_for_root(&app_handle, Some(&root_path))? {
        crate::remote::Route::Remote(link) => {
            let resp = link
                .lanes()
                .request(Request::ScanGavinRoot { root_path })
                .await
                .map_err(|e| e.to_string())?;
            match resp {
                Response::GavinTreeScanned { tree } => Ok(!tree.root_missing),
                Response::Error { message } => Err(message),
                other => Err(format!("unexpected response: {other:?}")),
            }
        }
        crate::remote::Route::Local => {
            Ok(std::path::Path::new(&root_path).join(".gavin-root").is_dir())
        }
    }
}

/// `token` is the grant `confirm_gate` minted for THIS card path when
/// the human answered the delete prompt. Deleting a plan card takes its
/// nested tasks' files with it, so one prompt names several paths and
/// the caller spends the same token once per file (AS-05/R5).
#[tauri::command]
pub async fn delete_card_file(
    path: String,
    token: String,
    app_handle: AppHandle,
    gate: State<'_, crate::confirm_gate::ConfirmGate>,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<(), String> {
    crate::confirm_gate::spend(&gate, &token, "delete_card_file", &path)?;
    let route = crate::remote::route_for_path(&app_handle, &path)?;
    let resp = lanes_for(route, &state, &compat)
        .request(Request::DeleteCardFile { path })
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected daemon reply: {other:?}")),
    }
}

#[tauri::command]
pub async fn link_card_session(
    workspace_id: String,
    path: String,
    session_id: String,
    cwd: String,
    command: Option<String>,
    conversation_id: Option<String>,
    launch_cwd: Option<String>,
    resume_attempts: Option<u32>,
    base_sha: Option<String>,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<(), String> {
    let route = crate::remote::route_for_workspace(&app_handle, &workspace_id)?;
    let resp = lanes_for(route, &state, &compat)
        .request(Request::LinkCardSession {
            workspace_id,
            path,
            session_id,
            cwd,
            command,
            conversation_id,
            launch_cwd,
            resume_attempts,
            base_sha,
        })
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected daemon reply: {other:?}")),
    }
}

#[tauri::command]
pub async fn unlink_card_session(
    workspace_id: String,
    path: String,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<(), String> {
    let route = crate::remote::route_for_workspace(&app_handle, &workspace_id)?;
    let resp = lanes_for(route, &state, &compat)
        .request(Request::UnlinkCardSession { workspace_id, path })
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected daemon reply: {other:?}")),
    }
}

#[tauri::command]
pub async fn set_checklist_item(
    path: String,
    line_index: u32,
    expected_text: String,
    checked: bool,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<(), String> {
    let route = crate::remote::route_for_path(&app_handle, &path)?;
    let resp = lanes_for(route, &state, &compat)
        .request(Request::SetChecklistItem { path, line_index, expected_text, checked })
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected daemon reply: {other:?}")),
    }
}

/// Files a `Decision:` / `Human test:` line on a card. Returns true when
/// it re-armed an identical failed test rather than appending a new line.
///
/// The app sends this one as well as gavin-mcp -- a human can file a
/// check they want to remember to run -- so it is an ordinary card write,
/// routed by path like `set_checklist_item` beside it.
#[tauri::command]
pub async fn file_human_item(
    path: String,
    kind: protocol::HumanItemKind,
    text: String,
    options: Vec<String>,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<bool, String> {
    let route = crate::remote::route_for_path(&app_handle, &path)?;
    let resp = lanes_for(route, &state, &compat)
        .request(Request::FileHumanItem { path, kind, text, options })
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        Response::HumanItemFiled { rearmed } => Ok(rearmed),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected daemon reply: {other:?}")),
    }
}

/// Writes the human's answer under a human item and sets its checkbox.
/// `expected_text` is the item line's raw remainder, guarded by the
/// daemon exactly as `set_checklist_item`'s is -- a refusal here means
/// an agent rewrote the card under the tab, and the caller must re-read.
#[tauri::command]
pub async fn resolve_human_item(
    path: String,
    expected_text: String,
    outcome: protocol::HumanItemOutcome,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<(), String> {
    let route = crate::remote::route_for_path(&app_handle, &path)?;
    let resp = lanes_for(route, &state, &compat)
        .request(Request::ResolveHumanItem { path, expected_text, outcome })
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected daemon reply: {other:?}")),
    }
}

/// Returns the created task card's path.
#[tauri::command]
pub async fn promote_checklist_item(
    plan_path: String,
    item: String,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<String, String> {
    let route = crate::remote::route_for_path(&app_handle, &plan_path)?;
    let resp = lanes_for(route, &state, &compat)
        .request(Request::PromoteChecklistItem { plan_path, item })
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        Response::TaskPromoted { path } => Ok(path),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected daemon reply: {other:?}")),
    }
}

/// Plan authoring from the app (the explorer's "New plan"). Routes
/// through the same daemon request MCP agents use, so validation and the
/// never-overwrite guarantee are identical no matter who creates a plan.
/// Returns the created path.
#[tauri::command]
pub async fn create_plan(
    context_folder: String,
    file_name: String,
    title: String,
    status: Option<String>,
    priority: Option<String>,
    body: Option<String>,
    kind: Option<String>,
    parent: Option<String>,
    attachments: Option<String>,
    complexity: Option<String>,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<String, String> {
    let route = crate::remote::route_for_path(&app_handle, &context_folder)?;
    let resp = lanes_for(route, &state, &compat)
        .request(Request::CreatePlan {
            context_folder,
            file_name,
            title,
            status,
            priority,
            body,
            kind,
            parent,
            attachments,
            complexity,
        })
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        Response::PlanCreated { path } => Ok(path),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}

#[tauri::command]
/// Returns the card's path AFTER the write: a status write can archive
/// the file into `plans/done/`, and the UI holds that path as identity.
pub async fn set_plan_frontmatter_field(
    path: String,
    key: String,
    value: String,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<String, String> {
    let route = crate::remote::route_for_path(&app_handle, &path)?;
    let resp = lanes_for(route, &state, &compat)
        .request(Request::SetPlanFrontmatterField { path, key, value })
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        Response::PlanFieldSet { path } => Ok(path),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}

/// Moves a card into its context's `plans/archive/`, taking its nested
/// children with it, and returns the path it landed on. The card leaves
/// the kanban board until `unarchive_card` brings it back.
#[tauri::command]
pub async fn archive_card(
    path: String,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<String, String> {
    let route = crate::remote::route_for_path(&app_handle, &path)?;
    let resp = lanes_for(route, &state, &compat)
        .request(Request::ArchiveCard { path })
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        Response::CardMoved { path } => Ok(path),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}

/// The inverse of `archive_card`: files the card back where its status
/// says it belongs and returns its new path.
#[tauri::command]
pub async fn unarchive_card(
    path: String,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<String, String> {
    let route = crate::remote::route_for_path(&app_handle, &path)?;
    let resp = lanes_for(route, &state, &compat)
        .request(Request::UnarchiveCard { path })
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        Response::CardMoved { path } => Ok(path),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}

#[tauri::command]
pub async fn set_root_config_field(
    root_path: String,
    key: String,
    value: String,
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<(), String> {
    let route = crate::remote::route_for_root(&app_handle, Some(&root_path))?;
    let resp = lanes_for(route, &state, &compat)
        .request(Request::SetRootConfigField { root_path, key, value })
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}

#[cfg(test)]
mod adopt_session_tests {
    use super::test_support::*;
    use super::*;

    fn running_session(id: &str) -> protocol::SessionSummary {
        protocol::SessionSummary {
            id: id.to_string(),
            workspace_path: "/r".to_string(),
            cwd: "/r".to_string(),
            status: "working".to_string(),
            restored: false,
            interrupted: false,
            orphan: None,
            failure_reason: None,
            compressed: false,
            uncompressed_reason: None,
        }
    }

    fn exited(id: &str) -> protocol::SessionSummary {
        protocol::SessionSummary {
            id: id.to_string(),
            workspace_path: "/r".to_string(),
            cwd: "/r".to_string(),
            status: "exited".to_string(),
            restored: false,
            interrupted: false,
            orphan: None,
            failure_reason: None,
            compressed: false,
            uncompressed_reason: None,
        }
    }

    /// The reason this command exists at all: the events a hidden run's
    /// verdict is read from only reach an ATTACHED session, so "still
    /// running" and "now attached" have to be the same answer.
    #[test]
    fn attaches_to_a_session_that_is_still_running() {
        let (command_client, _d1) = fake_daemon_replying_with(vec![Response::SessionList {
            sessions: vec![running_session("commit-1")],
        }]);
        let (writer_client, attached, _d2) =
            fake_daemon_capturing_requests(vec![Response::Ok]);
        let writer = StreamWriter::spawn(writer_client);

        let alive = block_on(adopt_session_impl(
            &lanes_over(command_client),
            &writer,
            "commit-1".to_string(),
        ))
        .unwrap();

        assert!(alive);
        // Poll: send_request writes and returns, so the fake daemon's
        // read of it races this assertion.
        let deadline = Instant::now() + Duration::from_secs(2);
        while attached.lock().unwrap().is_empty() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        let requests = attached.lock().unwrap();
        match &requests[0] {
            Request::Attach { id } => assert_eq!(id, "commit-1"),
            other => panic!("expected an Attach, got {other:?}"),
        }
    }

    /// An exited record and an unknown id answer the same way, because
    /// the caller does the same thing with either: drop what it wrote
    /// down. Neither may attach -- a subscription to a dead session is a
    /// spinner with no end.
    #[test]
    fn reports_a_finished_or_unknown_session_as_gone_without_attaching() {
        for sessions in [vec![exited("commit-1")], vec![]] {
            let (command_client, _d1) =
                fake_daemon_replying_with(vec![Response::SessionList { sessions }]);
            let (writer_client, attached, _d2) = fake_daemon_capturing_requests(vec![]);
            let writer = StreamWriter::spawn(writer_client);

            let alive = block_on(adopt_session_impl(
                &lanes_over(command_client),
                &writer,
                "commit-1".to_string(),
            ))
            .unwrap();

            assert!(!alive);
            assert!(attached.lock().unwrap().is_empty());
        }
    }
}

#[cfg(test)]
mod migration_tests {
    use super::*;

    fn rooted(dir: &std::path::Path) -> String {
        let g = dir.join(".gavin-root");
        std::fs::create_dir_all(&g).unwrap();
        std::fs::write(g.join("config.toml"), "version = 1\n").unwrap();
        dir.to_string_lossy().to_string()
    }

    #[test]
    fn carries_a_legacy_agent_command_into_config_toml_once() {
        let dir = tempfile::tempdir().unwrap();
        let root = rooted(dir.path());

        carry_over_agent_command(&root, Some("claude --model opus")).unwrap();
        let after = std::fs::read_to_string(dir.path().join(".gavin-root/config.toml")).unwrap();
        assert!(after.contains("command = \"claude --model opus\""));

        // Runs again with a different legacy value -> no-op, the file wins.
        carry_over_agent_command(&root, Some("something-else")).unwrap();
        let after2 = std::fs::read_to_string(dir.path().join(".gavin-root/config.toml")).unwrap();
        assert!(after2.contains("command = \"claude --model opus\""));
        assert!(!after2.contains("something-else"));
    }

    #[test]
    fn carry_over_is_a_no_op_without_a_legacy_value() {
        let dir = tempfile::tempdir().unwrap();
        let root = rooted(dir.path());
        carry_over_agent_command(&root, None).unwrap();
        carry_over_agent_command(&root, Some("   ")).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join(".gavin-root/config.toml")).unwrap(),
            "version = 1\n"
        );
    }
}

#[cfg(test)]
mod main_session_tests {
    use super::test_support::{fake_daemon_replying_with, lanes_over};
    use super::*;

    fn ws_with_main(id: &str, main: Option<&str>) -> Workspace {
        Workspace {
            id: id.to_string(),
            name: id.to_string(),
            pages: vec![],
            active_page_id: None,
            active_view: None,
            hub_view: None,
            root_path: Some("/tmp/ws".to_string()),
            main_session_id: main.map(|m| m.to_string()),
            orchestration_agent: None,
            developing_cards: Vec::new(),
            legacy_agent_command: None,
            color: None,
            notify_needs_input: true,
            notify_finished: true,
            confirm_tab_close: true,
            home_agent_share: None,
            git_view: None,
            last_active_at: None,
            terminal_font_size: None,
            auto_commit: None,
            auto_resume_runs: false,
            agent_pause: None,
            pinned_at: None,
            complexity_agents: HashMap::new(),
            git_tracking_asked: false,
            trusted_config_hash: None,
            mcp_foreign_servers_choice: None,
            reviewed_cards: None,
            require_review: None,
            headroom: None,
            require_review_asked: false,
            headroom_asked: false,
            custom_resume_args: None,
            agent_fallback: None,
            armed_agents: Vec::new(),
            declined_agents: Vec::new(),
            ssh: None,
            action_prompt_overrides: HashMap::new(),
        }
    }

    fn summary(id: &str, status: &str) -> protocol::SessionSummary {
        protocol::SessionSummary {
            id: id.to_string(),
            workspace_path: "/tmp/ws".to_string(),
            cwd: "/tmp/ws".to_string(),
            status: status.to_string(),
            restored: false,
            interrupted: false,
            orphan: None,
            failure_reason: None,
            compressed: false,
            uncompressed_reason: None,
        }
    }

    #[test]
    fn keeps_a_live_main_session() {
        let (client, _dir) = fake_daemon_replying_with(vec![Response::SessionList {
            sessions: vec![summary("agent-1", "idle")],
        }]);
        let mut workspaces = vec![ws_with_main("ws-1", Some("agent-1"))];
        reconcile_main_sessions(&mut workspaces, &lanes_over(client)).unwrap();
        assert_eq!(workspaces[0].main_session_id.as_deref(), Some("agent-1"));
    }

    #[test]
    fn clears_an_exited_or_unknown_main_session_without_respawning() {
        let (client, _dir) = fake_daemon_replying_with(vec![Response::SessionList {
            sessions: vec![summary("agent-1", "exited")],
        }]);
        let mut workspaces =
            vec![ws_with_main("ws-1", Some("agent-1")), ws_with_main("ws-2", Some("never-existed"))];
        reconcile_main_sessions(&mut workspaces, &lanes_over(client)).unwrap();
        assert_eq!(workspaces[0].main_session_id, None);
        assert_eq!(workspaces[1].main_session_id, None);
    }

    #[test]
    fn skips_the_round_trip_when_no_workspace_has_a_main_session() {
        // An exhausted fake daemon cannot answer, so this passing proves
        // no ListSessions was sent at all.
        let (client, _dir) = fake_daemon_replying_with(vec![]);
        let mut workspaces = vec![ws_with_main("ws-1", None)];
        reconcile_main_sessions(&mut workspaces, &lanes_over(client)).unwrap();
        assert_eq!(workspaces[0].main_session_id, None);
    }
}

#[cfg(test)]
mod version_probe_tests {
    use super::test_support::fake_daemon_replying_with;
    use super::*;

    #[test]
    fn matching_version_passes() {
        let (client, _dir) = fake_daemon_replying_with(vec![Response::ProtocolVersion {
            version: protocol::PROTOCOL_VERSION,
        }]);
        let compat = verify_daemon_protocol(&Mutex::new(client)).unwrap();
        assert_eq!(compat.daemon_version, protocol::PROTOCOL_VERSION);
        assert!(!compat.degraded);
    }

    #[test]
    fn an_older_in_window_daemon_connects_degraded_instead_of_erroring() {
        // This is the behaviour the whole feature exists for: an older
        // daemon inside the window used to be a hard error that forced a
        // daemon-killing restart. It must now come back Ok, just flagged.
        let (client, _dir) = fake_daemon_replying_with(vec![Response::ProtocolVersion {
            version: protocol::MIN_COMPATIBLE_VERSION,
        }]);
        let compat = verify_daemon_protocol(&Mutex::new(client)).unwrap();
        assert_eq!(compat.daemon_version, protocol::MIN_COMPATIBLE_VERSION);
        assert!(compat.degraded);
    }

    #[test]
    fn newer_daemon_names_the_app_as_stale() {
        let (client, _dir) = fake_daemon_replying_with(vec![Response::ProtocolVersion {
            version: protocol::PROTOCOL_VERSION + 1,
        }]);
        let err = verify_daemon_protocol(&Mutex::new(client)).unwrap_err().to_string();
        assert!(err.contains("newer than this app"));
    }

    #[test]
    fn unparsed_probe_or_error_reply_names_the_daemon_as_unreachable() {
        // An old daemon can't parse the probe at all: closed connection.
        // This is a distinct band from an explicit too-low version -- the
        // daemon never got far enough to report one -- but per the
        // 2026-08-07 incident it must still land on a named, actionable
        // error rather than a bare connection-closed mystery.
        let (client, _dir) = fake_daemon_replying_with(vec![]);
        let err = verify_daemon_protocol(&Mutex::new(client)).unwrap_err().to_string();
        assert!(err.contains("too old to talk to this app"));
        // A daemon that replies Error (unknown request) maps the same way.
        let (client, _dir) = fake_daemon_replying_with(vec![Response::Error {
            message: "unknown".to_string(),
        }]);
        let err = verify_daemon_protocol(&Mutex::new(client)).unwrap_err().to_string();
        assert!(err.contains("too old to talk to this app"));
    }

    /// The restart's worst case: a daemon that takes the connection and
    /// never says a word. The probe ends at its deadline -- the one
    /// `connect_for_handshake` sets, shortened here -- and the error says
    /// what happened rather than calling the daemon too old.
    #[test]
    fn a_daemon_that_never_answers_ends_the_probe_at_its_deadline() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("mute.sock");
        let listener = protocol::transport::Listener::bind(&sock).unwrap();
        let (hold, held) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            let _conn = listener.accept().unwrap();
            let _ = held.recv();
        });
        let client = Stream::connect(&sock).unwrap();
        client.set_read_timeout(Some(Duration::from_millis(200))).unwrap();

        let started = Instant::now();
        let err = verify_daemon_protocol(&Mutex::new(client)).unwrap_err().to_string();

        assert!(started.elapsed() < Duration::from_secs(5), "the probe waited {:?}", started.elapsed());
        assert!(err.contains("never answered"), "{err}");
        drop(hold);
    }
}

#[cfg(test)]
mod restart_tests {
    use super::test_support::{fake_daemon_replying_with, parity_compat};
    use super::*;
    use std::sync::atomic::Ordering::SeqCst;

    #[test]
    fn a_second_restart_is_refused_while_one_is_under_way() {
        let restart = DaemonRestart::default();
        let first = restart.claim().expect("the first restart");
        let err = restart.claim().err().expect("a second restart ran beside the first");
        assert!(err.contains("already being restarted"), "{err}");

        // Dropped when the blocking work ends, however it ends.
        drop(first);
        assert!(restart.claim().is_ok(), "a finished restart kept the next one out");
    }

    /// Keystrokes, resizes and repaints are refused while the daemon is
    /// swapped underneath the streaming connection -- before they are
    /// written anywhere -- and go through again once it is back.
    #[test]
    fn the_streaming_connection_refuses_input_while_the_daemon_is_swapped() {
        let (client, _dir) = fake_daemon_replying_with(vec![]);
        let conn = DaemonConnection::new(StreamWriter::spawn(client));
        let compat = DaemonCompatState(Mutex::new(Some(parity_compat())));
        let write = |conn: &DaemonConnection| {
            let mut reached = false;
            let result = with_writer(crate::remote::Route::Local, conn, &compat, |_, _| {
                reached = true;
                Ok(())
            });
            (result, reached)
        };

        conn.swapping.store(true, SeqCst);
        let (refused, reached) = write(&conn);
        let err = refused.err().expect("input was taken mid-restart").to_string();
        assert!(err.contains("restarting"), "{err}");
        assert!(!reached, "the write reached the connection mid-restart");

        conn.swapping.store(false, SeqCst);
        let (taken, reached) = write(&conn);
        assert!(taken.is_ok() && reached, "input stayed refused after the restart");
    }

    /// The streaming connection is handshaken under a deadline and then
    /// handed to the relay, which must wait on a quiet daemon for as long
    /// as the app runs: a bound left behind would read an idle stretch as
    /// a lost daemon and throw the connection-error overlay.
    #[test]
    fn lifting_the_handshake_deadline_leaves_reads_unbounded() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("quiet.sock");
        let listener = protocol::transport::Listener::bind(&sock).unwrap();
        let (hang_up, hung_up) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            let _conn = listener.accept().unwrap();
            let _ = hung_up.recv();
        });
        let stream = Stream::connect(&sock).unwrap();
        // Shorter than HANDSHAKE_DEADLINE, which a test cannot wait out:
        // what is under test is that lifting it clears ANY bound.
        stream.set_read_timeout(Some(Duration::from_millis(50))).unwrap();
        handshake_deadline(&stream, false);

        let (read_back, ended) = std::sync::mpsc::channel();
        let mut reader = stream.try_clone().unwrap();
        std::thread::spawn(move || {
            let mut byte = [0u8; 1];
            let _ = read_back.send(std::io::Read::read(&mut reader, &mut byte).map_err(|e| e.kind()));
        });
        assert!(
            ended.recv_timeout(Duration::from_millis(400)).is_err(),
            "a read on a quiet daemon ended while the relay should still be waiting"
        );
        drop(hang_up);
        assert_eq!(ended.recv_timeout(Duration::from_secs(5)).unwrap(), Ok(0), "the hang-up was not seen");
    }
}

#[cfg(test)]
mod classify_tests {
    use super::*;

    #[test]
    fn an_exactly_matching_daemon_is_not_degraded() {
        let c = classify(12, 12, 5).unwrap();
        assert_eq!(c.daemon_version, 12);
        assert!(!c.degraded);
    }

    #[test]
    fn an_older_daemon_inside_the_window_is_usable_but_degraded() {
        let c = classify(9, 12, 5).unwrap();
        assert!(c.degraded);
        assert_eq!(c.daemon_version, 9);
    }

    #[test]
    fn the_floor_itself_is_inside_the_window() {
        assert!(classify(5, 12, 5).is_ok());
    }

    #[test]
    fn a_daemon_below_the_floor_is_rejected() {
        let err = classify(4, 12, 5).unwrap_err();
        assert!(err.contains("too old"), "message should say what to do: {err}");
    }

    #[test]
    fn a_daemon_newer_than_the_app_is_rejected() {
        let err = classify(13, 12, 5).unwrap_err();
        assert!(err.contains("newer"));
    }
}

#[cfg(test)]
mod gate_tests {
    use super::*;

    #[test]
    fn a_request_the_daemon_predates_is_refused_before_it_is_sent() {
        let compat = DaemonCompat { daemon_version: 9, app_version: 12, degraded: true };
        let too_new = Request::NameSession { session_id: "s-1".into(), name: "x".into(), agent_conversation_id: None };
        let err = gate(&too_new, &compat).unwrap_err();
        assert!(err.contains("v10"), "should name the version needed: {err}");
        assert!(err.contains("v9"), "should name the version running: {err}");
    }

    #[test]
    fn a_request_the_daemon_understands_passes() {
        let compat = DaemonCompat { daemon_version: 9, app_version: 12, degraded: true };
        assert!(gate(&Request::ListSessions, &compat).is_ok());
    }

    #[test]
    fn an_exact_match_gates_nothing() {
        let compat = DaemonCompat { daemon_version: 12, app_version: 12, degraded: false };
        let newest = Request::NameSession { session_id: "s-1".into(), name: "x".into(), agent_conversation_id: None };
        assert!(gate(&newest, &compat).is_ok());
    }

    /// One sample of every `Request` variant, `Unknown` included. Field
    /// values are placeholders -- `gate` and `min_version_for` only look at
    /// which variant a request is, never its payload -- so the only thing
    /// that has to be right here is that every variant in
    /// `crates/protocol/src/lib.rs` has exactly one entry below. A variant
    /// added there without a matching entry here would silently narrow the
    /// sweep below rather than fail loudly, which is a real gap: nothing
    /// else forces this list to stay exhaustive the way `min_version_for`'s
    /// own match does. Reviewed by hand against the enum each time it
    /// changes.
    fn one_of_every_request_variant() -> Vec<Request> {
        vec![
            Request::CreateSession { workspace_path: "w".into(), cwd: "c".into(), command: None, profile_id: None, api_family: None },
            Request::ListSessions,
            Request::WriteInput { id: "s".into(), data: "d".into() },
            Request::ResizeSession { id: "s".into(), cols: 80, rows: 24 },
            Request::KillSession { id: "s".into() },
            Request::Attach { id: "s".into() },
            Request::GetBoard { workspace_id: "w".into() },
            Request::SetBoard { workspace_id: "w".into(), columns: vec![], labels: vec![] },
            Request::DeleteBoard { workspace_id: "w".into() },
            Request::WatchGavinRoot { workspace_id: "w".into(), root_path: "r".into() },
            Request::UnwatchGavinRoot { workspace_id: "w".into() },
            Request::GetGavinTree { workspace_id: "w".into() },
            Request::InitGavinRoot { root_path: "r".into(), workspace_name: "n".into() },
            Request::CreateGavinContext { parent_folder: "p".into() },
            Request::AddExternalGavinContext { root_path: "r".into(), folder: "f".into() },
            Request::RemoveExternalGavinContext { root_path: "r".into(), folder: "f".into() },
            Request::SetPlanFrontmatterField { path: "p".into(), key: "k".into(), value: "v".into() },
            Request::SetRootConfigField { root_path: "r".into(), key: "k".into(), value: "v".into() },
            Request::ScanGavinRoot { root_path: "r".into() },
            Request::ReadPrd { root_path: "r".into() },
            Request::CreatePlan {
                context_folder: "c".into(),
                file_name: "f".into(),
                title: "t".into(),
                status: None,
                priority: None,
                body: None,
                kind: None,
                parent: None,
                attachments: None,
                complexity: None,
            },
            Request::GetBoardByRoot { root_path: "r".into() },
            Request::SpawnAgentSession { root_path: "r".into(), cwd: "c".into(), command: "cmd".into() },
            Request::DeleteCardFile { path: "p".into() },
            Request::SetChecklistItem {
                path: "p".into(),
                line_index: 0,
                expected_text: "x".into(),
                checked: true,
            },
            Request::PromoteChecklistItem { plan_path: "p".into(), item: "i".into() },
            Request::FileHumanItem {
                path: "p".into(),
                kind: protocol::HumanItemKind::Decision,
                text: "which?".into(),
                options: vec![],
            },
            Request::ResolveHumanItem {
                path: "p".into(),
                expected_text: "Decision: which?".into(),
                outcome: protocol::HumanItemOutcome::Pass,
            },
            Request::LinkCardSession {
                workspace_id: "w".into(),
                path: "p".into(),
                session_id: "s".into(),
                cwd: "c".into(),
                command: None,
                conversation_id: None,
                launch_cwd: None,
                resume_attempts: None,
                base_sha: None,
            },
            Request::UnlinkCardSession { workspace_id: "w".into(), path: "p".into() },
            Request::GetCardSession { workspace_id: "w".into(), path: "p".into() },
            Request::GetOrchestration { workspace_id: "w".into() },
            Request::SetOrchestration { workspace_id: "w".into(), rails: vec![], conflict_notes: vec![] },
            Request::SetRailRun { rail_id: "r".into(), state: "idle".into(), current_stage_id: None },
            Request::SetStepRun {
                step_id: "s".into(),
                state: "pending".into(),
                session_id: None,
                reason: None,
                conversation_id: None,
                launch_cwd: None,
                resume_attempts: None,
            },
            Request::GetOrchestrationByRoot { root_path: "r".into() },
            Request::SetOrchestrationByRoot { root_path: "r".into(), rails: vec![], conflict_notes: vec![] },
            Request::GitDirtyPaths { cwd: "c".into(), limit: 10 },
            Request::NameSession { session_id: "s".into(), name: "n".into(), agent_conversation_id: None },
            Request::GetProtocolVersion,
            Request::Shutdown,
            // v37's agent-authored workspace tools. The app sends
            // neither -- it writes tools for a workspace whose id it
            // already has -- but the sweep is about `gate` agreeing with
            // the table for every variant, and these two sit exactly on
            // the current parity boundary, which is the case it catches.
            Request::SaveToolByRoot {
                root_path: "r".into(),
                tool: ToolDef {
                    id: "t".into(),
                    workspace_id: None,
                    name: "n".into(),
                    description: "d".into(),
                    kind: "command".into(),
                    body: "b".into(),
                    params: vec![],
                    position: 0,
                    cwd: None,
                    icon: None,
                },
            },
            Request::DeleteToolByRoot { root_path: "r".into(), id: "t".into() },
            // Deserialize-only in production, but nothing stops Rust code
            // from constructing it -- and the sweep needs to, to prove it
            // is refused everywhere rather than just trusting the comment
            // on `min_version_for`'s `u32::MAX` arm.
            Request::Unknown,
        ]
    }

    /// The sweep: across EVERY daemon version in the compat window (not
    /// just a representative slice of it), `gate`'s verdict must agree
    /// with what `min_version_for` reports for EVERY request variant, not
    /// just the couple of variants the tests above exercise.
    ///
    /// This used to sample only three daemon versions (the floor, v9, and
    /// parity). Because the version table jumps v8 -> v10, no variant
    /// needs exactly v9, so that sample put only 3 of the request variants
    /// on their own `needed == daemon_version` boundary -- the case below
    /// that actually catches comparison-operator drift. Iterating the
    /// whole window instead costs nothing (39 variants * 8 versions = 312
    /// trivial assertions) and puts roughly a third of the variants on
    /// their boundary.
    ///
    /// Honest limit: `gate` computes `needed = min_version_for(req)` and
    /// this test's own `should_pass` comes from that same call, so this
    /// cannot catch a version number in the table that is simply wrong in
    /// an absolute sense (e.g. a variant attributed to v9 when it should
    /// truly be v10) -- only the humans maintaining the table can catch
    /// that. What it DOES catch, at every variant and (crucially) right at
    /// the `needed == daemon_version` boundary rather than only away from
    /// it: `gate`'s comparison drifting from "permitted exactly when
    /// `needed <= daemon_version`" -- an accidental `>=` in place of `>`,
    /// say. Verified empirically while writing this test: that exact
    /// one-character change made this sweep fail (LinkCardSession, needed
    /// v5, refused by a v5 daemon) while the narrower tests earlier in
    /// this module and `a_command_the_daemon_predates_never_reaches_the_wire`
    /// (each pinned to one variant away from any boundary) stayed green.
    #[test]
    fn gate_agrees_with_min_version_for_across_every_variant_at_every_version_in_the_window() {
        let daemon_versions =
            (protocol::MIN_COMPATIBLE_VERSION..=protocol::PROTOCOL_VERSION).collect::<Vec<_>>();

        for &daemon_version in &daemon_versions {
            let compat = DaemonCompat {
                daemon_version,
                app_version: protocol::PROTOCOL_VERSION,
                degraded: daemon_version < protocol::PROTOCOL_VERSION,
            };
            for req in one_of_every_request_variant() {
                let needed = protocol::min_version_for(&req);
                let should_pass = needed <= daemon_version;
                let verdict = gate(&req, &compat);
                assert_eq!(
                    verdict.is_ok(),
                    should_pass,
                    "{req:?} needs v{needed}; a v{daemon_version} daemon should {} it, but gate returned {verdict:?}",
                    if should_pass { "permit" } else { "refuse" },
                );
            }
        }
    }
}

#[cfg(test)]
mod kanban_command_tests {
    use super::test_support::{block_on, fake_daemon_capturing_requests, fake_daemon_replying_with, lanes_at, lanes_over};
    use super::*;

    fn bound(path: &str, command: Option<&str>) -> CardSession {
        CardSession {
            path: path.into(),
            session_id: format!("s-{path}"),
            cwd: "/p".into(),
            command: command.map(Into::into),
            conversation_id: None,
            launch_cwd: Some("/p".into()),
            resume_attempts: None,
            base_sha: None,
        }
    }

    #[test]
    fn card_session_impl_asks_a_current_daemon_for_the_one_binding() {
        let (client, captured, _dir) = fake_daemon_capturing_requests(vec![Response::CardSession {
            card_session: Some(bound("/p/t.md", Some("claude 'x'"))),
        }]);

        let got = block_on(card_session_impl(&lanes_over(client), "ws-1".into(), "/p/t.md".into())).unwrap();

        assert_eq!(got.and_then(|cs| cs.command).as_deref(), Some("claude 'x'"));
        let requests = captured.lock().unwrap();
        match &requests[0] {
            Request::GetCardSession { workspace_id, path } => {
                assert_eq!((workspace_id.as_str(), path.as_str()), ("ws-1", "/p/t.md"));
            }
            other => panic!("expected GetCardSession, got {other:?}"),
        }
    }

    /// Against a v42 daemon the request would close the connection, so it
    /// must never be sent -- and it does not need to be: that daemon's
    /// board still carries every command.
    #[test]
    fn card_session_impl_reads_an_older_daemons_board_instead() {
        let old_board = || Response::Board {
            columns: vec![],
            labels: vec![],
            card_sessions: vec![bound("/p/a.md", Some("claude 'a'")), bound("/p/t.md", Some("claude 'x'"))],
        };
        let (client, captured, _dir) = fake_daemon_capturing_requests(vec![old_board(), old_board()]);
        let v42 = DaemonCompat { daemon_version: 42, app_version: protocol::PROTOCOL_VERSION, degraded: true };
        let lanes = lanes_at(client, v42);

        let got = block_on(card_session_impl(&lanes, "ws-1".into(), "/p/t.md".into())).unwrap().unwrap();
        assert_eq!(got.command.as_deref(), Some("claude 'x'"));
        assert_eq!(got.session_id, "s-/p/t.md");
        assert_eq!(block_on(card_session_impl(&lanes, "ws-1".into(), "/p/never.md".into())).unwrap(), None);

        drop(lanes);
        let requests = captured.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(
            requests.iter().all(|r| matches!(r, Request::GetBoard { workspace_id } if workspace_id == "ws-1")),
            "{requests:?}"
        );
    }

    /// The webview's board never holds a launch prompt, whichever daemon
    /// answered: the store keeps one board per workspace in memory, and
    /// re-reads it on every tree push.
    #[test]
    fn get_board_impl_hands_on_no_launch_command() {
        let (client, _dir) = fake_daemon_replying_with(vec![Response::Board {
            columns: vec![],
            labels: vec![],
            card_sessions: vec![bound("/p/t.md", Some("claude 'the whole prompt'"))],
        }]);

        let board = block_on(get_board_impl(&lanes_over(client), "ws-1".into())).unwrap();

        assert_eq!(board.card_sessions.len(), 1);
        assert_eq!(board.card_sessions[0].command, None);
        assert!(!serde_json::to_string(&board).unwrap().contains("whole prompt"));
    }

    #[test]
    fn card_runs_impl_returns_the_cards_runs_newest_first() {
        let (client, _dir) = fake_daemon_replying_with(vec![Response::CardRuns {
            runs: vec![
                CardRun {
                    id: 2,
                    path: "/p/t.md".to_string(),
                    session_id: "s-2".to_string(),
                    command: Some("claude".to_string()),
                    conversation_id: Some("conv-2".to_string()),
                    launch_cwd: None,
                    base_sha: None,
                    started_at: 20,
                    ended_at: None,
                    exit_code: None,
                    outcome: "running".to_string(),
                    resume_attempts: None,
                    headroom_tokens_saved: None,
                    headroom_requests: None,
                },
                CardRun {
                    id: 1,
                    path: "/p/t.md".to_string(),
                    session_id: "s-1".to_string(),
                    command: None,
                    conversation_id: None,
                    launch_cwd: None,
                    base_sha: None,
                    started_at: 10,
                    ended_at: Some(15),
                    exit_code: Some(0),
                    outcome: "exited".to_string(),
                    resume_attempts: None,
                    headroom_tokens_saved: None,
                    headroom_requests: None,
                },
            ],
        }]);
        let conn = lanes_over(client);

        let runs = block_on(card_runs_impl(&conn, "ws-1".to_string(), "/p/t.md".to_string())).unwrap();

        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].session_id, "s-2");
        assert_eq!(runs[1].outcome, "exited");
    }

    #[test]
    fn get_board_impl_returns_the_boards_columns_and_labels() {
        let (client, _dir) = fake_daemon_replying_with(vec![Response::Board {
            card_sessions: vec![],
            columns: vec![Column { id: "c1".to_string(), name: "To Do".to_string(), position: 0 }],
            labels: vec![Label { id: "l1".to_string(), name: "urgent".to_string(), color: "#f00".to_string() }],
        }]);
        let conn = lanes_over(client);

        let board = block_on(get_board_impl(&conn, "ws-1".to_string())).unwrap();

        assert_eq!(board.columns.len(), 1);
        assert_eq!(board.columns[0].name, "To Do");
        assert_eq!(board.labels.len(), 1);
    }

    /// Test lanes are built with no redial, so a connection a fake daemon
    /// drops is a failure the test sees -- never a reconnect to
    /// `protocol::socket_path()`, the developer's real daemon. The old
    /// retry derived its target from the connection's peer path to stay
    /// off the real socket; that hazard is closed structurally now: the
    /// only lanes that redial are the ones bootstrap builds, pointed at
    /// the socket it connected to.
    #[test]
    fn a_test_lane_that_loses_its_fake_daemon_fails_instead_of_redialling() {
        let (client, _dir) = fake_daemon_replying_with(vec![]);
        let err = block_on(get_board_impl(&lanes_over(client), "ws-1".to_string())).unwrap_err().to_string();
        assert!(err.contains("closed"), "{err}");
    }

    #[test]
    fn get_board_impl_sends_the_given_workspace_id() {
        let (client, captured, _dir) =
            fake_daemon_capturing_requests(vec![Response::Board { columns: vec![], labels: vec![], card_sessions: vec![] }]);
        let conn = lanes_over(client);

        block_on(get_board_impl(&conn, "ws-42".to_string())).unwrap();

        let requests = captured.lock().unwrap();
        match &requests[0] {
            Request::GetBoard { workspace_id } => assert_eq!(workspace_id, "ws-42"),
            other => panic!("expected GetBoard, got {other:?}"),
        }
    }

    #[test]
    fn get_board_impl_propagates_a_daemon_error() {
        let (client, _dir) =
            fake_daemon_replying_with(vec![Response::Error { message: "board fetch failed".to_string() }]);
        let conn = lanes_over(client);

        let result = block_on(get_board_impl(&conn, "ws-1".to_string()));

        assert!(result.is_err());
    }

    #[test]
    fn set_board_impl_sends_the_given_columns_and_labels() {
        let (client, captured, _dir) = fake_daemon_capturing_requests(vec![Response::Ok]);
        let conn = lanes_over(client);
        let columns = vec![Column { id: "c1".to_string(), name: "Only".to_string(), position: 0,  }];

        block_on(set_board_impl(&conn, "ws-1".to_string(), columns.clone(), vec![])).unwrap();

        let requests = captured.lock().unwrap();
        match &requests[0] {
            Request::SetBoard { workspace_id, columns: sent_columns, .. } => {
                assert_eq!(workspace_id, "ws-1");
                assert_eq!(sent_columns.len(), 1);
                assert_eq!(sent_columns[0].name, "Only");
            }
            other => panic!("expected SetBoard, got {other:?}"),
        }
    }

    #[test]
    fn set_board_impl_propagates_a_daemon_error() {
        let (client, _dir) =
            fake_daemon_replying_with(vec![Response::Error { message: "board save failed".to_string() }]);
        let conn = lanes_over(client);

        let result = block_on(set_board_impl(&conn, "ws-1".to_string(), vec![], vec![]));

        assert!(result.is_err());
    }

    #[test]
    fn delete_board_impl_sends_the_given_workspace_id() {
        let (client, captured, _dir) = fake_daemon_capturing_requests(vec![Response::Ok]);
        let conn = lanes_over(client);

        block_on(delete_board_impl(&conn, "ws-1".to_string())).unwrap();

        let requests = captured.lock().unwrap();
        match &requests[0] {
            Request::DeleteBoard { workspace_id } => assert_eq!(workspace_id, "ws-1"),
            other => panic!("expected DeleteBoard, got {other:?}"),
        }
    }
}

#[cfg(test)]
mod attach_target_tests {
    use super::*;
    use crate::config::Page;

    fn leaf(tabs: &[&str]) -> LayoutNode {
        LayoutNode::Leaf {
            tabs: tabs.iter().map(|s| s.to_string()).collect(),
            active_tab_index: 0,
            pinned: Vec::new(),
        }
    }

    fn ws(id: &str, tabs: &[&str], main: Option<&str>) -> Workspace {
        Workspace {
            id: id.to_string(),
            name: id.to_string(),
            pages: vec![Page {
                id: format!("{id}-p1"),
                name: "p1".to_string(),
                layout: leaf(tabs),
                focused_session_id: None,
                pinned_at: None,
            }],
            active_page_id: None,
            active_view: None,
            hub_view: None,
            root_path: None,
            main_session_id: main.map(|m| m.to_string()),
            orchestration_agent: None,
            developing_cards: Vec::new(),
            legacy_agent_command: None,
            color: None,
            notify_needs_input: true,
            notify_finished: true,
            confirm_tab_close: true,
            home_agent_share: None,
            git_view: None,
            last_active_at: None,
            terminal_font_size: None,
            auto_commit: None,
            auto_resume_runs: false,
            agent_pause: None,
            pinned_at: None,
            complexity_agents: HashMap::new(),
            git_tracking_asked: false,
            trusted_config_hash: None,
            mcp_foreign_servers_choice: None,
            reviewed_cards: None,
            require_review: None,
            headroom: None,
            require_review_asked: false,
            headroom_asked: false,
            custom_resume_args: None,
            agent_fallback: None,
            armed_agents: Vec::new(),
            declined_agents: Vec::new(),
            ssh: None,
            action_prompt_overrides: HashMap::new(),
        }
    }

    fn data(workspaces: Vec<Workspace>) -> WorkspacesData {
        WorkspacesData { workspaces, active_workspace_id: None, removed_workspaces: vec![] }
    }

    #[test]
    fn non_session_tab_ids_covers_file_board_and_card_tabs() {
        let mut files = HashMap::new();
        files.insert("f1".to_string(), "/tmp/a.md".to_string());
        let mut boards = HashMap::new();
        boards.insert(
            "b1".to_string(),
            crate::config::BoardTabRecord {
                workspace_id: "w1".to_string(),
                context_folder: "/tmp/ws".to_string(),
            },
        );

        let mut cards = HashMap::new();
        cards.insert(
            "c1".to_string(),
            crate::config::CardTabRecord {
                workspace_id: "w1".to_string(),
                path: "/tmp/ws/.gavin-root/plans/login.md".to_string(),
                view: "plan".to_string(),
                session_id: None,
            },
        );

        let ids = non_session_tab_ids(&files, &boards, &cards);

        assert_eq!(ids, HashSet::from(["f1".to_string(), "b1".to_string(), "c1".to_string()]));
    }

    #[test]
    fn attachable_ids_include_main_agents_that_live_outside_every_page_tree() {
        // D12: a main agent session is remembered on the workspace, not
        // placed in a page. Walking page trees alone misses it, and a
        // session nobody attaches renders blank forever.
        let d = data(vec![ws("w1", &["s1", "s2"], Some("main-1"))]);

        let ids = attachable_session_ids(&d, &HashSet::new());

        assert_eq!(ids, vec!["s1".to_string(), "s2".to_string(), "main-1".to_string()]);
    }

    #[test]
    fn attachable_ids_skip_file_and_board_tabs() {
        // These share the layout tree's id space but were never sessions
        // -- the daemon would reject an Attach for them.
        let d = data(vec![ws("w1", &["s1", "f1", "b1"], None)]);

        let ids = attachable_session_ids(
            &d,
            &HashSet::from(["f1".to_string(), "b1".to_string()]),
        );

        assert_eq!(ids, vec!["s1".to_string()]);
    }

    #[test]
    fn attachable_ids_span_every_workspace() {
        let d = data(vec![ws("w1", &["s1"], Some("m1")), ws("w2", &["s2"], None)]);

        let ids = attachable_session_ids(&d, &HashSet::new());

        assert_eq!(ids, vec!["s1".to_string(), "s2".to_string(), "m1".to_string()]);
    }
}
