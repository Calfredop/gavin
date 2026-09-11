use crate::config::Workspace;
use crate::layout::LayoutNode;
use protocol::{
    read_message, socket_path, write_message, Board, CardRun, Column, ConflictNote, GroupTemplate,
    Label, Orchestration, Rail, Request, Response, ToolDef, ToolRun,
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
    writer: Arc<Mutex<Stream>>,
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
fn persist_workspaces(
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
    crate::config::save(
        config_dir,
        &crate::config::AppConfig {
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
    launch_state: State<LaunchSettings>,
    custom_resume_args_state: State<CustomResumeArgs>,
) -> Result<(), String> {
    *agent_defaults_state.0.lock().unwrap() = agent_defaults.clone();
    let git_tracking = *git_tracking_state.0.lock().unwrap();
    let require_review = *require_review_state.0.lock().unwrap();
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
            complexity,
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
            require_review_asked: false,
            custom_resume_args: None,
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
            require_review_asked: false,
            custom_resume_args: None,
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

/// Writes the whole workspaces state, and tells the OTHER windows what
/// it now says.
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
    launch_state: State<LaunchSettings>,
    custom_resume_args_state: State<CustomResumeArgs>,
) -> Result<(), String> {
    let data = WorkspacesData { workspaces, active_workspace_id, removed_workspaces };
    *state.0.lock().unwrap() = data.clone();
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
    launch_state: State<LaunchSettings>,
    custom_resume_args_state: State<CustomResumeArgs>,
) -> Result<(), String> {
    let require_review = {
        let mut current = require_review_state.0.lock().unwrap();
        *current = crate::config::RequireReviewDefault(enabled);
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
        launch,
        custom_resume_args,
    )
    .map_err(|e| e.to_string())
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
#[tauri::command]
pub fn restart_daemon(
    app_handle: AppHandle,
    token: String,
    gate: State<crate::confirm_gate::ConfirmGate>,
) -> Result<(), String> {
    crate::confirm_gate::spend(
        &gate,
        &token,
        "restart_daemon",
        crate::confirm_gate::DAEMON_SUBJECT,
    )?;
    if app_handle.try_state::<DaemonConnection>().is_some() {
        return reconnect(&app_handle).map_err(|e| e.to_string());
    }
    let socket = socket_path().map_err(|e| e.to_string())?;
    crate::daemon::stop_running_daemon(&socket).map_err(|e| e.to_string())?;
    if let Some(state) = app_handle.try_state::<BootstrapError>() {
        *state.0.lock().unwrap() = None;
    }
    bootstrap(app_handle).map_err(|e| e.to_string())
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
/// But the state does not need replacing. Both connections are already
/// mutexes around a `Stream`, so a reconnect just assigns fresh
/// streams into the ones the app is holding, and every command that
/// borrows them keeps working untouched.
fn reconnect(app_handle: &AppHandle) -> anyhow::Result<()> {
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
    let probe = Mutex::new(Stream::connect(&socket)?);
    // Verified before ANYTHING is swapped in: a daemon that fails the
    // version probe must leave a named error and an app that is merely
    // disconnected, never one wired half onto each daemon.
    let compat = verify_daemon_protocol(&probe)?;
    // Re-present identity on the fresh connections: a restart can hand
    // back a differently-versioned (or freshly-token'd) daemon, so the
    // handshake and its proof run again before either connection is
    // published.
    app_handshake(&compat, &probe, &mut stream_conn)?;

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

    let writer = Arc::clone(&app_handle.state::<DaemonConnection>().writer);
    *writer.lock().unwrap() = stream_conn.try_clone()?;
    *app_handle.state::<CommandConnection>().0.lock().unwrap() =
        probe.into_inner().expect("protocol probe mutex poisoned");

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
    )?;

    // The daemon's gavin watchers were per-connection and died with it.
    // Re-armed here rather than from the frontend because this is where
    // the new connection exists: miss it and the Plans, Kanban and
    // Orchestration tabs go quietly dead after a restart -- the exact
    // failure the fs-sync work just removed.
    for ws in &data.workspaces {
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

fn send_request(
    writer: &Arc<Mutex<Stream>>,
    req: &Request,
    compat: &DaemonCompat,
) -> anyhow::Result<()> {
    gate(req, compat).map_err(|e| anyhow::anyhow!(e))?;
    write_message(&mut *writer.lock().unwrap(), req)
}

/// A second, dedicated connection to the daemon, used only for one-shot
/// request/response commands (ListSessions/CreateSession/KillSession).
/// Kept separate from the streaming connection (DaemonConnection) whose
/// background thread continuously reads Output/SessionExited off the
/// socket — reading a CreateSession reply off *that* connection would
/// race the relay thread for bytes, with no way to tell which reply
/// belongs to which request. The Mutex serializes this connection's own
/// request-then-response cycles, one at a time, which is what makes
/// correlation unambiguous without the daemon protocol needing a
/// request-id field.
pub struct CommandConnection(pub Mutex<Stream>);

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
fn current_compat(state: &DaemonCompatState) -> DaemonCompat {
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
fn verify_daemon_protocol(command_conn: &Mutex<Stream>) -> anyhow::Result<DaemonCompat> {
    const UNREACHABLE: &str = "the gavin daemon is too old to talk to this app — restart it (quit gavin, then relaunch)";
    match send_command(command_conn, &Request::GetProtocolVersion) {
        Ok(Response::ProtocolVersion { version }) => {
            classify(version, protocol::PROTOCOL_VERSION, protocol::MIN_COMPATIBLE_VERSION)
                .map_err(|e| anyhow::anyhow!(e))
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
fn read_daemon_token() -> Option<String> {
    std::fs::read_to_string(protocol::daemon_token_path().ok()?)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Check a `HelloAck` the app received: the daemon must have granted the
/// `app` role and returned a `server_proof` equal to HMAC(token, nonce).
/// A mismatch is the DP-06 case -- the app connected to something holding
/// the socket path that does NOT hold the token -- and is a hard error.
fn verify_app_ack(ack: Response, token: &str, nonce: &str) -> anyhow::Result<()> {
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
    const HELLO_MIN_VERSION: u32 = 35;
    if compat.daemon_version < HELLO_MIN_VERSION {
        return Ok(());
    }
    let Some(token) = read_daemon_token() else {
        return Ok(());
    };
    app_handshake_command(command_conn, &token)?;
    app_handshake_stream(stream, &token)?;
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

/// One reconnect per call, mirroring gavin-mcp's `SocketTransport`
/// (`crates/gavin-mcp/src/main.rs`), which has done this since it was
/// written. Without it, any single command failure -- daemon restart, or
/// a request an older/newer daemon can't parse -- leaves `conn` closed
/// with nothing to ever reopen it, turning one bad request into a
/// permanently dead app.
///
/// Known gap, deliberately not fixed here: reconnecting re-opens the
/// socket but does NOT re-run the version probe. If the daemon was
/// replaced by a different version between the original failure and this
/// reconnect, the app keeps serving its previous `DaemonCompat` verdict
/// until the next explicit `reconnect()` or restart.
///
/// Also known, also deliberately not fixed here: the retry gives the app
/// at-least-once request semantics it did not previously have. If the
/// first `send_command` fails because the reply never arrived rather than
/// because the request never went out -- e.g. the daemon processed
/// `CreateSession` and then died before the response crossed the wire --
/// the retry resends the same request to the (now different) connection,
/// which creates a second session and orphans the first one's PTY. This
/// is inherited from gavin-mcp's transport shape (see the mirror note
/// above), and the alternative -- no retry -- was demonstrably worse: one
/// failed request left `conn` permanently closed and the app permanently
/// dead, which is the whole reason this function exists.
///
/// Takes `socket_path` as a parameter rather than resolving one itself so
/// this core logic stays directly testable against a throwaway tempdir
/// socket. `send_command_reconnecting` below is the production wrapper
/// call sites should use -- it derives `socket_path` from the connection's
/// own peer address rather than from a fixed, globally-resolved one; see
/// its doc comment for why.
fn send_command_reconnecting_at(
    conn: &Mutex<Stream>,
    socket_path: &Path,
    req: &Request,
) -> anyhow::Result<Response> {
    match send_command(conn, req) {
        Ok(resp) => Ok(resp),
        Err(_) => {
            *conn.lock().unwrap() = Stream::connect(socket_path)?;
            send_command(conn, req)
        }
    }
}

/// Production entry point for every command site: see
/// `send_command_reconnecting_at` for the reconnect logic and its
/// documented gap. `verify_daemon_protocol` deliberately does NOT go
/// through this -- see its own doc comment for why a closed connection
/// there must stay a hard failure rather than get retried away.
///
/// Reconnects to the peer THIS connection was already opened against,
/// read back from the connection itself via `peer_path()`, rather than
/// resolving `protocol::socket_path()` (the real daemon) globally. Several
/// of this function's callers -- `list_valid_session_ids`,
/// `create_fresh_session`, `get_board_impl`, `set_board_impl`,
/// `delete_board_impl` -- are themselves unit-tested against a bare
/// `Mutex<Stream>` pointed at a tempdir fake socket, with no path
/// threaded through for a reconnect to target. A global-path resolution
/// here would have meant any of those tests reaching the retry branch --
/// today only by accident, tomorrow by a one-off regression -- silently
/// redirects the test process into issuing real requests against the
/// developer's actual running daemon. Deriving the reconnect target from
/// the connection's own peer address closes that off structurally instead
/// of relying on every test's response queue never running short.
///
/// Falls back to a single, non-retried attempt if the peer can't be
/// named -- an unnamed socket, either half of a `Stream::pair()`, or the
/// accepted side of a connection, none of which have a path to dial. A
/// missed retry is recoverable, a retry aimed at an unknown or wrong peer
/// is not.
///
/// Gated here rather than in `send_command_reconnecting_at`: this function
/// has TWO branches that can put bytes on the wire -- the peer-derived
/// retry path through `_at`, and the `peer_path()`-failed fallback that
/// calls `send_command` directly. Gating only inside `_at` would leave
/// that fallback branch unprotected, and a gated request reaching the
/// socket by that one uncommon path is exactly the failure this exists to
/// rule out. Checked before the bytes leave, not as error handling after:
/// an older daemon cannot PARSE a request it predates, and read_message
/// propagates that parse error with `?`, dropping the connection and
/// every push riding on it.
fn send_command_reconnecting(
    conn: &Mutex<Stream>,
    compat: &DaemonCompat,
    req: &Request,
) -> anyhow::Result<Response> {
    gate(req, compat).map_err(|e| anyhow::anyhow!(e))?;
    let peer = conn.lock().unwrap().peer_path();
    match peer {
        Some(path) => send_command_reconnecting_at(conn, &path, req),
        None => send_command(conn, req),
    }
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
fn resolve_sessions(
    node: &mut LayoutNode,
    command_conn: &Mutex<Stream>,
    all_sessions: &HashMap<String, protocol::SessionSummary>,
    non_session_tab_ids: &HashSet<String>,
    compat: &DaemonCompat,
    workspace_root: Option<&str>,
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
                    let fresh =
                        create_fresh_session(command_conn, last_known_cwd, workspace_root, None, compat)?;
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
                    command_conn,
                    all_sessions,
                    non_session_tab_ids,
                    compat,
                    workspace_root,
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
/// its own beyond the one `send_command_reconnecting` already applies.
#[tauri::command]
pub fn get_session_baselines(
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<Vec<SessionBaseline>, String> {
    let sessions =
        list_valid_session_ids(&state.0, &current_compat(&compat)).map_err(|e| e.to_string())?;
    Ok(sessions
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
        .collect())
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
#[tauri::command]
pub fn end_orphan(
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
    session_id: String,
) -> Result<OrphanEndResult, String> {
    let resp = send_command_reconnecting(
        &state.0,
        &current_compat(&compat),
        &Request::EndOrphan { id: session_id },
    )
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
#[tauri::command]
pub fn list_managed_sessions(
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<ManagedSessions, String> {
    let compat = current_compat(&compat);
    let resp = send_command_reconnecting(&state.0, &compat, &Request::ListSessions)
        .map_err(|e| e.to_string())?;
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
        match send_command_reconnecting(&state.0, &compat, &Request::SessionProcesses)
            .map_err(|e| e.to_string())?
        {
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

fn list_valid_session_ids(
    command_conn: &Mutex<Stream>,
    compat: &DaemonCompat,
) -> anyhow::Result<HashMap<String, protocol::SessionSummary>> {
    let resp = send_command_reconnecting(command_conn, compat, &Request::ListSessions)?;
    match resp {
        Response::SessionList { sessions } => {
            Ok(sessions.into_iter().map(|s| (s.id.clone(), s)).collect())
        }
        other => anyhow::bail!("expected SessionList, got {other:?}"),
    }
}

/// Resolves every session id referenced by every page of every workspace
/// against the daemon's actual live sessions, replacing any that are stale
/// in place. An empty `workspaces` list -- nothing saved yet, or a config
/// from before this milestone -- is left untouched: no default workspace
/// or session is auto-created, and `ListSessions` isn't even called.
fn resolve_workspaces(
    workspaces: &mut [Workspace],
    command_conn: &Mutex<Stream>,
    non_session_tab_ids: &HashSet<String>,
    compat: &DaemonCompat,
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
    let all_sessions = list_valid_session_ids(command_conn, compat)?;
    for workspace in workspaces.iter_mut() {
        let workspace_root = workspace.root_path.clone();
        for page in workspace.pages.iter_mut() {
            resolve_sessions(
                &mut page.layout,
                command_conn,
                &all_sessions,
                non_session_tab_ids,
                compat,
                workspace_root.as_deref(),
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
    use super::test_support::{fake_daemon_replying_with, parity_compat};
    use super::*;
    use protocol::transport::Listener;

    /// A closed command connection must not stay dead forever: the daemon
    /// may simply have restarted between calls. The first connection
    /// closes without answering (simulating exactly that), and
    /// send_command_reconnecting must reconnect and retry once rather
    /// than surfacing the failure to the caller.
    ///
    /// Goes through the production `send_command_reconnecting` wrapper,
    /// not `_at` directly -- this is the empirical check for whether
    /// `Stream::peer_addr()` still resolves to the original peer path
    /// once that peer has already hung up (the state the retry branch
    /// always runs in). If it didn't, the wrapper would silently fall back
    /// to a single non-retried attempt and this test's second `accept()`
    /// would never fire, hanging the test. Passing quickly is the proof:
    /// peer_path() survives the disconnect, and the retry lands back on
    /// this exact tempdir socket rather than on `protocol::socket_path()`
    /// (the real daemon), which reconnecting into would be the hazard this
    /// whole design change exists to close off.
    #[test]
    fn a_command_retries_once_on_a_closed_connection() {
        // Serve two connections: the first closes immediately (simulating a
        // daemon that hung up), the second answers properly.
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("retry.sock");
        let listener = Listener::bind(&sock).unwrap();

        let server = std::thread::spawn(move || {
            let first = listener.accept().unwrap();
            drop(first);
            let mut second = listener.accept().unwrap();
            let mut reader = BufReader::new(second.try_clone().unwrap());
            let _req: Option<Request> = read_message(&mut reader).unwrap();
            write_message(&mut second, &Response::ProtocolVersion { version: 12 }).unwrap();
        });

        let conn = Mutex::new(Stream::connect(&sock).unwrap());
        let resp = send_command_reconnecting(&conn, &parity_compat(), &Request::GetProtocolVersion).unwrap();
        assert!(matches!(resp, Response::ProtocolVersion { version: 12 }));
        server.join().unwrap();
    }

    /// The property that actually matters for the compat window: the
    /// daemon must receive NOTHING -- not a request it answers with an
    /// error, but no bytes at all. An older daemon can't parse a variant
    /// it predates, and that parse error closes the whole connection.
    #[test]
    fn a_command_the_daemon_predates_never_reaches_the_wire() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("gated.sock");
        let listener = Listener::bind(&sock).unwrap();

        let server = std::thread::spawn(move || {
            let conn = listener.accept().unwrap();
            let mut reader = BufReader::new(conn.try_clone().unwrap());
            // Returns None if the client correctly sent nothing and hung up.
            read_message::<_, Request>(&mut reader).unwrap()
        });

        let conn = Mutex::new(Stream::connect(&sock).unwrap());
        let compat = DaemonCompat { daemon_version: 9, app_version: 12, degraded: true };
        let too_new = Request::NameSession { session_id: "s-1".into(), name: "x".into(), agent_conversation_id: None };

        let err = send_command_reconnecting(&conn, &compat, &too_new).unwrap_err().to_string();
        assert!(err.contains("v10"), "should name the version needed: {err}");
        assert!(err.contains("v9"), "should name the version running: {err}");

        drop(conn);
        assert!(server.join().unwrap().is_none(), "a gated request must not reach the daemon");
    }

    #[test]
    fn a_command_the_daemon_understands_still_reaches_the_wire() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("allowed.sock");
        let listener = Listener::bind(&sock).unwrap();

        let server = std::thread::spawn(move || {
            let mut conn = listener.accept().unwrap();
            let mut reader = BufReader::new(conn.try_clone().unwrap());
            let _req: Option<Request> = read_message(&mut reader).unwrap();
            write_message(&mut conn, &Response::SessionList { sessions: vec![] }).unwrap();
        });

        let conn = Mutex::new(Stream::connect(&sock).unwrap());
        let compat = DaemonCompat { daemon_version: 9, app_version: 12, degraded: true };

        // ListSessions is v1, so a v9 daemon serves it fine.
        let resp = send_command_reconnecting(&conn, &compat, &Request::ListSessions).unwrap();
        assert!(matches!(resp, Response::SessionList { .. }));
        server.join().unwrap();
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
    use super::test_support::fake_daemon_capturing_requests;
    use super::test_support::fake_daemon_replying_with;
    use super::test_support::parity_compat;
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
            require_review_asked: false,
            custom_resume_args: None,
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
        let conn = Mutex::new(client);
        let mut workspaces = vec![workspace("ws-1", vec![page("page-1", leaf(&["file-tab-1"]))])];
        let non_session_tab_ids: HashSet<String> = ["file-tab-1".to_string()].into_iter().collect();

        resolve_workspaces(&mut workspaces, &conn, &non_session_tab_ids, &parity_compat()).unwrap();

        assert_eq!(workspaces[0].pages[0].layout, leaf(&["file-tab-1"]));
        assert!(captured.lock().unwrap().is_empty(), "no daemon calls at all for a file-tab-only workspace");
    }

    #[test]
    fn a_file_tab_alongside_a_stale_session_leaves_the_file_tab_and_replaces_only_the_session() {
        let (client, _captured, _dir) = fake_daemon_capturing_requests(vec![
            Response::SessionList { sessions: vec![] },
            Response::SessionCreated { id: "fresh-a".to_string() },
        ]);
        let conn = Mutex::new(client);
        let mut workspaces =
            vec![workspace("ws-1", vec![page("page-1", leaf(&["file-tab-1", "stale-session"]))])];
        let non_session_tab_ids: HashSet<String> = ["file-tab-1".to_string()].into_iter().collect();

        resolve_workspaces(&mut workspaces, &conn, &non_session_tab_ids, &parity_compat()).unwrap();

        assert_eq!(workspaces[0].pages[0].layout, leaf(&["file-tab-1", "fresh-a"]));
    }

    #[test]
    fn a_pinned_stale_session_stays_pinned_under_its_fresh_id() {
        let (client, _captured, _dir) = fake_daemon_capturing_requests(vec![
            Response::SessionList { sessions: vec![] },
            Response::SessionCreated { id: "fresh-a".to_string() },
            Response::SessionCreated { id: "fresh-b".to_string() },
        ]);
        let conn = Mutex::new(client);
        let pinned_leaf = LayoutNode::Leaf {
            tabs: vec!["stale-a".to_string(), "stale-b".to_string()],
            active_tab_index: 1,
            pinned: vec!["stale-a".to_string()],
        };
        let mut workspaces = vec![workspace("ws-1", vec![page("page-1", pinned_leaf)])];

        resolve_workspaces(&mut workspaces, &conn, &no_file_tabs(), &parity_compat()).unwrap();

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
        }
    }

    #[test]
    fn empty_workspaces_makes_no_daemon_calls_at_all() {
        // Zero queued responses -- if resolve_workspaces called
        // ListSessions anyway, send_command would hit a connection the fake
        // daemon thread already closed and error, which the unwrap() below
        // would turn into a clear panic rather than silently passing.
        let (client, _dir) = fake_daemon_replying_with(vec![]);
        let conn = Mutex::new(client);
        let mut workspaces: Vec<Workspace> = vec![];

        resolve_workspaces(&mut workspaces, &conn, &no_file_tabs(), &parity_compat()).unwrap();

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
        let conn = Mutex::new(client);
        let mut workspaces = vec![
            workspace("ws-1", vec![page("page-1", leaf(&["valid-1"]))]),
            workspace("ws-2", vec![page("page-2", leaf(&["valid-2"]))]),
        ];

        resolve_workspaces(&mut workspaces, &conn, &no_file_tabs(), &parity_compat()).unwrap();

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
        let conn = Mutex::new(client);
        let mut workspaces = vec![
            workspace("ws-1", vec![page("page-1", leaf(&["valid-1", "stale-1"]))]),
            workspace("ws-2", vec![page("page-2", leaf(&["stale-2"]))]),
        ];

        resolve_workspaces(&mut workspaces, &conn, &no_file_tabs(), &parity_compat()).unwrap();

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
        let conn = Mutex::new(client);
        let mut workspaces = vec![workspace("ws-1", vec![page("page-1", leaf(&["exited-1"]))])];

        resolve_workspaces(&mut workspaces, &conn, &no_file_tabs(), &parity_compat()).unwrap();

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
        let conn = Mutex::new(client);
        let mut ws = workspace("ws-1", vec![page("page-1", leaf(&["exited-1"]))]);
        ws.root_path = Some("/Users/alice/project".to_string());
        let mut workspaces = vec![ws];

        resolve_workspaces(&mut workspaces, &conn, &no_file_tabs(), &parity_compat()).unwrap();

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
        let conn = Mutex::new(client);
        let mut workspaces = vec![workspace("ws-1", vec![page("page-1", leaf(&["unknown-id"]))])];

        resolve_workspaces(&mut workspaces, &conn, &no_file_tabs(), &parity_compat()).unwrap();

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
        let conn = Mutex::new(client);
        let mut workspaces = vec![workspace("ws-1", vec![page("page-1", leaf(&["exited-2"]))])];

        resolve_workspaces(&mut workspaces, &conn, &no_file_tabs(), &parity_compat()).unwrap();

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
        let conn = Mutex::new(client);

        create_fresh_session(&conn, Some("/tmp"), None, None, &parity_compat()).unwrap();


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
        let conn = Mutex::new(client);

        create_fresh_session(&conn, Some("/tmp"), None, Some("npm test"), &parity_compat())
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
        let conn = Mutex::new(client);

        create_fresh_session(
            &conn,
            Some("/Users/alice/project-rail"),
            Some("/Users/alice/project"),
            None,
            &parity_compat(),
        )
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
        let conn = Mutex::new(client);

        create_fresh_session(&conn, Some("/tmp/loose"), None, None, &parity_compat()).unwrap();

        let requests = captured.lock().unwrap();
        match &requests[0] {
            Request::CreateSession { cwd, workspace_path, .. } => {
                assert_eq!(cwd, "/tmp/loose");
                assert_eq!(workspace_path, "/tmp/loose");
            }
            other => panic!("expected CreateSession, got {other:?}"),
        }
    }
}

/// Connects to (or spawns) the daemon over two connections — one for the
/// continuous Attach/Output relay, one for one-shot request/response
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
fn reconcile_main_sessions(
    workspaces: &mut [Workspace],
    command_conn: &Mutex<Stream>,
    compat: &DaemonCompat,
) -> anyhow::Result<()> {
    if !workspaces.iter().any(|w| w.main_session_id.is_some()) {
        return Ok(());
    }
    let sessions = list_valid_session_ids(command_conn, compat)?;
    for workspace in workspaces.iter_mut() {
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
fn non_session_tab_ids(
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
    data.workspaces
        .iter()
        .flat_map(|w| w.pages.iter())
        .flat_map(|p| p.layout.all_session_ids())
        .filter(|id| !non_session_tab_ids.contains(id))
        .chain(data.workspaces.iter().filter_map(|w| w.main_session_id.clone()))
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
fn attach_and_relay(
    app_handle: &AppHandle,
    writer: &Arc<Mutex<Stream>>,
    reader_stream: Stream,
    session_ids: Vec<String>,
    // By value, not `&`: `DaemonCompat` is `Copy`, and the relay thread
    // spawned below needs its own owned copy to move into the `'static`
    // closure -- there is no `AppHandle`-free way to borrow it instead.
    compat: DaemonCompat,
) -> anyhow::Result<()> {
    for id in session_ids {
        send_request(writer, &Request::Attach { id }, &compat)?;
    }

    let epoch = app_handle.state::<ConnectionEpoch>().0.load(std::sync::atomic::Ordering::SeqCst);
    let mut reader = BufReader::new(reader_stream);
    let reader_app_handle = app_handle.clone();
    let relay_writer = Arc::clone(writer);
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
                    report_disconnect(&reader_app_handle, epoch, e.to_string());
                    break;
                }
            };
            let Some(resp) = resp else {
                report_disconnect(
                    &reader_app_handle,
                    epoch,
                    "daemon closed the connection".to_string(),
                );
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
    // The daemon is confirmed reachable by the connect above (which may
    // have just spawned it) — this second connection should succeed
    // immediately, no retry/backoff needed.
    let command_stream = Stream::connect(&socket)?;
    let command_conn = Mutex::new(command_stream);
    let compat = verify_daemon_protocol(&command_conn)?;
    // Present the app's identity on both connections and verify the
    // daemon's proof (`sec-fix-client-identity.md`). A no-op against a
    // pre-v35 daemon; a proof mismatch aborts bootstrap (DP-06).
    app_handshake(&compat, &command_conn, &mut stream_conn)?;
    *app_handle.state::<DaemonCompatState>().0.lock().unwrap() = Some(compat);

    let writer = Arc::new(Mutex::new(stream_conn.try_clone()?));
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
                require_review_asked: false,
                custom_resume_args: None,
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
    reconcile_main_sessions(&mut workspaces, &command_conn, &compat)?;
    let non_session_tab_ids = non_session_tab_ids(&file_tabs, &board_tabs, &card_tabs);
    resolve_workspaces(&mut workspaces, &command_conn, &non_session_tab_ids, &compat)?;
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
        config.launch,
        config.custom_resume_args.clone(),
    )?;

    let session_ids = attachable_session_ids(&workspaces_data, &non_session_tab_ids);

    app_handle.manage(DaemonConnection { writer: Arc::clone(&writer) });
    app_handle.manage(CommandConnection(command_conn));
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
    app_handle.manage(LaunchSettings(Mutex::new(config.launch)));
    app_handle.manage(CustomResumeArgs(Mutex::new(config.custom_resume_args)));
    app_handle.emit("workspaces-ready", &workspaces_data)?;

    attach_and_relay(&app_handle, &writer, reader_stream, session_ids, compat)?;
    Ok(())
}

#[tauri::command]
pub fn write_input(
    session_id: String,
    data: String,
    state: State<DaemonConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    send_request(
        &state.writer,
        &Request::WriteInput { id: session_id, data },
        &current_compat(&compat),
    )
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
fn queued_inputs_request(
    conn: &Mutex<Stream>,
    compat: &DaemonCompatState,
    req: &Request,
) -> Result<Vec<protocol::QueuedInput>, String> {
    match send_command_reconnecting(conn, &current_compat(compat), req).map_err(|e| e.to_string())? {
        Response::QueuedInputs { queued } => Ok(queued),
        Response::Error { message } => Err(message),
        other => Err(format!("expected QueuedInputs, got {other:?}")),
    }
}

/// Holds a follow-up for a session and, if that session is already idle,
/// delivers it at once. The daemon decides which -- the app never has to
/// know a session's status to queue for it.
#[tauri::command]
pub fn queue_input(
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
    session_id: String,
    text: String,
) -> Result<Vec<protocol::QueuedInput>, String> {
    queued_inputs_request(&state.0, &compat, &Request::QueueInput { id: session_id, text })
}

/// Every session's pending follow-ups.
///
/// The read-back for a push-fed map. `QueuedInputsChanged` reaches only
/// whoever is attached to a session, so a frontend that reloaded has
/// missed every one -- and a baseline that rides only on Attach is what
/// left the git chip blank after a reload.
#[tauri::command]
pub fn list_queued_inputs(
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<Vec<protocol::QueuedInput>, String> {
    queued_inputs_request(&state.0, &compat, &Request::ListQueuedInputs)
}

/// The queue this session should have from now on, in order. One writer
/// for reorder, cancel and clear.
#[tauri::command]
pub fn set_queued_inputs(
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
    session_id: String,
    queued_ids: Vec<String>,
) -> Result<Vec<protocol::QueuedInput>, String> {
    queued_inputs_request(
        &state.0,
        &compat,
        &Request::SetQueuedInputs { id: session_id, queued_ids },
    )
}

/// Deliver one queued follow-up now, whatever the session is doing.
#[tauri::command]
pub fn send_queued_input(
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
    session_id: String,
    queued_id: String,
) -> Result<Vec<protocol::QueuedInput>, String> {
    queued_inputs_request(
        &state.0,
        &compat,
        &Request::SendQueuedInput { id: session_id, queued_id },
    )
}

#[tauri::command]
pub fn resize_session(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<DaemonConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    send_request(
        &state.writer,
        &Request::ResizeSession { id: session_id, cols, rows },
        &current_compat(&compat),
    )
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
fn create_fresh_session(
    command_conn: &Mutex<Stream>,
    cwd: Option<&str>,
    workspace_root: Option<&str>,
    command: Option<&str>,
    compat: &DaemonCompat,
) -> anyhow::Result<String> {
    // "/" only when there is no home at all: the point of the fallback
    // is a directory that certainly exists, and every OS has that one.
    let home = crate::home::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "/".to_string());
    let target = cwd.map(str::to_string).unwrap_or_else(|| home.clone());
    let workspace = workspace_root.map(str::to_string).unwrap_or_else(|| target.clone());
    let command = command.map(str::to_string);

    let resp = send_command_reconnecting(
        command_conn,
        compat,
        &Request::CreateSession { workspace_path: workspace, cwd: target.clone(), command: command.clone() },
    )?;
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
    let resp = send_command_reconnecting(
        command_conn,
        compat,
        &Request::CreateSession { workspace_path: home.clone(), cwd: home.clone(), command },
    )?;
    match resp {
        Response::SessionCreated { id } => Ok(id),
        other => anyhow::bail!("expected SessionCreated, got {other:?}"),
    }
}

#[tauri::command]
pub fn create_session(
    cwd: Option<String>,
    workspace_root: Option<String>,
    command: Option<String>,
    command_state: State<CommandConnection>,
    daemon_state: State<DaemonConnection>,
    compat: State<DaemonCompatState>,
) -> Result<String, String> {
    let compat = current_compat(&compat);
    let id = create_fresh_session(
        &command_state.0,
        cwd.as_deref(),
        workspace_root.as_deref(),
        command.as_deref(),
        &compat,
    )
    .map_err(|e| e.to_string())?;

    send_request(&daemon_state.writer, &Request::Attach { id: id.clone() }, &compat)
        .map_err(|e| e.to_string())?;
    Ok(id)
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
    daemon_state: State<DaemonConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    send_request(
        &daemon_state.writer,
        &Request::Snapshot { id: session_id },
        &current_compat(&compat),
    )
    .map_err(|e| e.to_string())
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
pub fn set_failure_patterns(
    session_id: String,
    patterns: Vec<String>,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let resp = send_command_reconnecting(
        &state.0,
        &current_compat(&compat),
        &Request::SetFailurePatterns { id: session_id, patterns },
    )
    .map_err(|e| e.to_string())?;
    expect_ok(resp)
}

#[tauri::command]
pub fn kill_session(
    session_id: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let resp = send_command_reconnecting(&state.0, &current_compat(&compat), &Request::KillSession { id: session_id })
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
fn adopt_session_impl(
    command_conn: &Mutex<Stream>,
    daemon_writer: &Arc<Mutex<Stream>>,
    session_id: String,
    compat: &DaemonCompat,
) -> anyhow::Result<bool> {
    let sessions = list_valid_session_ids(command_conn, compat)?;
    let Some(record) = sessions.get(&session_id) else {
        return Ok(false);
    };
    if record.status == "exited" {
        return Ok(false);
    }
    send_request(daemon_writer, &Request::Attach { id: session_id }, compat)?;
    Ok(true)
}

#[tauri::command]
pub fn adopt_session(
    session_id: String,
    command_state: State<CommandConnection>,
    daemon_state: State<DaemonConnection>,
    compat: State<DaemonCompatState>,
) -> Result<bool, String> {
    adopt_session_impl(
        &command_state.0,
        &daemon_state.writer,
        session_id,
        &current_compat(&compat),
    )
    .map_err(|e| e.to_string())
}

fn get_board_impl(
    command_conn: &Mutex<Stream>,
    workspace_id: String,
    compat: &DaemonCompat,
) -> anyhow::Result<Board> {
    let resp = send_command_reconnecting(command_conn, compat, &Request::GetBoard { workspace_id })?;
    match resp {
        Response::Board { columns, labels, card_sessions } => Ok(Board { columns, labels, card_sessions }),
        other => anyhow::bail!("expected Board, got {other:?}"),
    }
}

#[tauri::command]
pub fn get_board(
    workspace_id: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<Board, String> {
    get_board_impl(&state.0, workspace_id, &current_compat(&compat)).map_err(|e| e.to_string())
}

/// A card's run history (v27). Gated by `min_version_for` on the way
/// out like every other request, so against a daemon older than 27 this
/// fails with the version message rather than pretending the card has
/// never been run -- which is why the panel reads
/// `FEATURE_MIN_VERSION.runHistory` before it ever asks.
fn card_runs_impl(
    command_conn: &Mutex<Stream>,
    workspace_id: String,
    path: String,
    compat: &DaemonCompat,
) -> anyhow::Result<Vec<CardRun>> {
    let resp = send_command_reconnecting(command_conn, compat, &Request::CardRuns { workspace_id, path })?;
    match resp {
        Response::CardRuns { runs } => Ok(runs),
        other => anyhow::bail!("expected CardRuns, got {other:?}"),
    }
}

#[tauri::command]
pub fn card_runs(
    workspace_id: String,
    path: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<Vec<CardRun>, String> {
    card_runs_impl(&state.0, workspace_id, path, &current_compat(&compat)).map_err(|e| e.to_string())
}

fn set_board_impl(
    command_conn: &Mutex<Stream>,
    workspace_id: String,
    columns: Vec<Column>,
    labels: Vec<Label>,
    compat: &DaemonCompat,
) -> anyhow::Result<()> {
    let resp =
        send_command_reconnecting(command_conn, compat, &Request::SetBoard { workspace_id, columns, labels })?;
    match resp {
        Response::Ok => Ok(()),
        other => anyhow::bail!("expected Ok, got {other:?}"),
    }
}

#[tauri::command]
pub fn set_board(
    workspace_id: String,
    columns: Vec<Column>,
    labels: Vec<Label>,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    set_board_impl(&state.0, workspace_id, columns, labels, &current_compat(&compat)).map_err(|e| e.to_string())
}

// --- Orchestration (SP1) ----------------------------------------------------
//
// `state_value` rather than `state`: the Tauri State<CommandConnection>
// parameter already owns the name `state` in this file's convention.

fn get_orchestration_impl(
    command_conn: &Mutex<Stream>,
    workspace_id: String,
    compat: &DaemonCompat,
) -> anyhow::Result<Orchestration> {
    let resp = send_command_reconnecting(command_conn, compat, &Request::GetOrchestration { workspace_id })?;
    match resp {
        Response::Orchestration { rails, conflict_notes, rail_runs, step_runs } => {
            Ok(Orchestration { rails, conflict_notes, rail_runs, step_runs })
        }
        other => anyhow::bail!("expected Orchestration, got {other:?}"),
    }
}

#[tauri::command]
pub fn get_orchestration(
    workspace_id: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<Orchestration, String> {
    get_orchestration_impl(&state.0, workspace_id, &current_compat(&compat)).map_err(|e| e.to_string())
}

/// A refused write (the running-step guard) comes back as
/// Response::Error and must reach the caller verbatim -- the board's
/// save-error strip shows it, so it has to name the step.
fn expect_ok(resp: Response) -> Result<(), String> {
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("expected Ok, got {other:?}")),
    }
}

#[tauri::command]
pub fn set_orchestration(
    workspace_id: String,
    rails: Vec<Rail>,
    conflict_notes: Vec<ConflictNote>,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let resp = send_command_reconnecting(
        &state.0,
        &current_compat(&compat),
        &Request::SetOrchestration { workspace_id, rails, conflict_notes },
    )
    .map_err(|e| e.to_string())?;
    expect_ok(resp)
}

#[tauri::command]
pub fn set_rail_run(
    rail_id: String,
    state_value: String,
    current_stage_id: Option<String>,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let resp = send_command_reconnecting(
        &state.0,
        &current_compat(&compat),
        &Request::SetRailRun { rail_id, state: state_value, current_stage_id },
    )
    .map_err(|e| e.to_string())?;
    expect_ok(resp)
}

#[tauri::command]
pub fn set_step_run(
    step_id: String,
    state_value: String,
    session_id: Option<String>,
    reason: Option<String>,
    conversation_id: Option<String>,
    launch_cwd: Option<String>,
    resume_attempts: Option<u32>,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let resp = send_command_reconnecting(
        &state.0,
        &current_compat(&compat),
        &Request::SetStepRun {
            step_id,
            state: state_value,
            session_id,
            reason,
            conversation_id,
            launch_cwd,
            resume_attempts,
        },
    )
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
pub fn get_tools(
    workspace_id: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<Vec<ToolDef>, String> {
    let resp = send_command_reconnecting(
        &state.0,
        &current_compat(&compat),
        &Request::GetTools { workspace_id },
    )
    .map_err(|e| e.to_string())?;
    match resp {
        Response::Tools { tools } => Ok(tools),
        Response::Error { message } => Err(message),
        other => Err(format!("expected Tools, got {other:?}")),
    }
}

/// The daemon's validation (unknown kind, a built-in id, an empty name)
/// comes back as Response::Error and reaches the dialog verbatim.
#[tauri::command]
pub fn save_tool(
    tool: ToolDef,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let resp =
        send_command_reconnecting(&state.0, &current_compat(&compat), &Request::SaveTool { tool })
            .map_err(|e| e.to_string())?;
    expect_ok(resp)
}

#[tauri::command]
pub fn delete_tool(
    id: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let resp =
        send_command_reconnecting(&state.0, &current_compat(&compat), &Request::DeleteTool { id })
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
pub fn start_tool_run(
    workspace_id: String,
    tool_id: String,
    session_id: String,
    command: Option<String>,
    launch_cwd: Option<String>,
    conversation_id: Option<String>,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let resp = send_command_reconnecting(
        &state.0,
        &current_compat(&compat),
        &Request::StartToolRun {
            workspace_id,
            tool_id,
            session_id,
            command,
            launch_cwd,
            conversation_id,
        },
    )
    .map_err(|e| e.to_string())?;
    expect_ok(resp)
}

#[tauri::command]
pub fn set_tool_run_outcome(
    session_id: String,
    outcome: String,
    exit_code: Option<i32>,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let resp = send_command_reconnecting(
        &state.0,
        &current_compat(&compat),
        &Request::SetToolRunOutcome { session_id, outcome, exit_code },
    )
    .map_err(|e| e.to_string())?;
    expect_ok(resp)
}

fn tool_runs_impl(
    command_conn: &Mutex<Stream>,
    workspace_id: String,
    compat: &DaemonCompat,
) -> anyhow::Result<Vec<ToolRun>> {
    let resp = send_command_reconnecting(command_conn, compat, &Request::ToolRuns { workspace_id })?;
    match resp {
        Response::ToolRuns { runs } => Ok(runs),
        other => anyhow::bail!("expected ToolRuns, got {other:?}"),
    }
}

#[tauri::command]
pub fn tool_runs(
    workspace_id: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<Vec<ToolRun>, String> {
    tool_runs_impl(&state.0, workspace_id, &current_compat(&compat)).map_err(|e| e.to_string())
}

// --- Group templates --------------------------------------------------------
//
// v15 requests, so against a v14 daemon they fail LOCALLY through the
// gated path rather than putting bytes on a socket that cannot parse
// them. The UI is already dark there (FEATURE_MIN_VERSION.groups), so
// this is the belt to that braces.

#[tauri::command]
pub fn get_group_templates(
    workspace_id: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<Vec<GroupTemplate>, String> {
    let resp = send_command_reconnecting(
        &state.0,
        &current_compat(&compat),
        &Request::GetGroupTemplates { workspace_id },
    )
    .map_err(|e| e.to_string())?;
    match resp {
        Response::GroupTemplates { templates } => Ok(templates),
        Response::Error { message } => Err(message),
        other => Err(format!("expected GroupTemplates, got {other:?}")),
    }
}

#[tauri::command]
pub fn save_group_template(
    template: GroupTemplate,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let resp = send_command_reconnecting(
        &state.0,
        &current_compat(&compat),
        &Request::SaveGroupTemplate { template },
    )
    .map_err(|e| e.to_string())?;
    expect_ok(resp)
}

#[tauri::command]
pub fn delete_group_template(
    id: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let resp = send_command_reconnecting(
        &state.0,
        &current_compat(&compat),
        &Request::DeleteGroupTemplate { id },
    )
    .map_err(|e| e.to_string())?;
    expect_ok(resp)
}

fn delete_board_impl(
    command_conn: &Mutex<Stream>,
    workspace_id: String,
    compat: &DaemonCompat,
) -> anyhow::Result<()> {
    let resp = send_command_reconnecting(command_conn, compat, &Request::DeleteBoard { workspace_id })?;
    match resp {
        Response::Ok => Ok(()),
        other => anyhow::bail!("expected Ok, got {other:?}"),
    }
}

#[tauri::command]
pub fn delete_board(
    workspace_id: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    delete_board_impl(&state.0, workspace_id, &current_compat(&compat)).map_err(|e| e.to_string())
}

/// Rides the STREAMING connection (fire-and-forget, mirroring
/// write_input): the daemon intercepts WatchGavinRoot to capture that
/// connection's writer for pushes, and the initial scan arrives as the
/// first gavin-tree-changed event rather than a reply.
#[tauri::command]
pub fn watch_gavin_root(
    workspace_id: String,
    root_path: String,
    conn: State<DaemonConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    send_request(
        &conn.writer,
        &Request::WatchGavinRoot { workspace_id, root_path },
        &current_compat(&compat),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn unwatch_gavin_root(
    workspace_id: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let resp = send_command_reconnecting(&state.0, &current_compat(&compat), &Request::UnwatchGavinRoot { workspace_id })
        .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}

#[tauri::command]
pub fn get_gavin_tree(
    workspace_id: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<protocol::GavinTree, String> {
    let resp = send_command_reconnecting(&state.0, &current_compat(&compat), &Request::GetGavinTree { workspace_id })
        .map_err(|e| e.to_string())?;
    match resp {
        Response::GavinTreeSnapshot { tree, .. } => Ok(tree),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}

#[tauri::command]
pub fn init_gavin_root(
    root_path: String,
    workspace_name: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let resp = send_command_reconnecting(
        &state.0,
        &current_compat(&compat),
        &Request::InitGavinRoot { root_path, workspace_name },
    )
    .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}

#[tauri::command]
pub fn create_gavin_context(
    parent_folder: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let resp = send_command_reconnecting(&state.0, &current_compat(&compat), &Request::CreateGavinContext { parent_folder })
        .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}

#[tauri::command]
pub fn add_external_gavin_context(
    root_path: String,
    folder: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let resp = send_command_reconnecting(
        &state.0,
        &current_compat(&compat),
        &Request::AddExternalGavinContext { root_path, folder },
    )
    .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}

#[tauri::command]
pub fn remove_external_gavin_context(
    root_path: String,
    folder: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let resp = send_command_reconnecting(
        &state.0,
        &current_compat(&compat),
        &Request::RemoveExternalGavinContext { root_path, folder },
    )
    .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}

/// Local fs probe for the set-root flow's init-vs-bind fork (spec §2) --
/// the frontend can't stat the disk itself, and watching hasn't started
/// yet at the moment the picker returns.
#[tauri::command]
pub fn gavin_root_exists(root_path: String) -> bool {
    std::path::Path::new(&root_path).join(".gavin-root").is_dir()
}

/// `token` is the grant `confirm_gate` minted for THIS card path when
/// the human answered the delete prompt. Deleting a plan card takes its
/// nested tasks' files with it, so one prompt names several paths and
/// the caller spends the same token once per file (AS-05/R5).
#[tauri::command]
pub fn delete_card_file(
    path: String,
    token: String,
    gate: State<crate::confirm_gate::ConfirmGate>,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    crate::confirm_gate::spend(&gate, &token, "delete_card_file", &path)?;
    let resp = send_command_reconnecting(&state.0, &current_compat(&compat), &Request::DeleteCardFile { path })
        .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected daemon reply: {other:?}")),
    }
}

#[tauri::command]
pub fn link_card_session(
    workspace_id: String,
    path: String,
    session_id: String,
    cwd: String,
    command: Option<String>,
    conversation_id: Option<String>,
    launch_cwd: Option<String>,
    resume_attempts: Option<u32>,
    base_sha: Option<String>,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let resp = send_command_reconnecting(
        &state.0,
        &current_compat(&compat),
        &Request::LinkCardSession {
            workspace_id,
            path,
            session_id,
            cwd,
            command,
            conversation_id,
            launch_cwd,
            resume_attempts,
            base_sha,
        },
    )
    .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected daemon reply: {other:?}")),
    }
}

#[tauri::command]
pub fn unlink_card_session(
    workspace_id: String,
    path: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let resp = send_command_reconnecting(
        &state.0,
        &current_compat(&compat),
        &Request::UnlinkCardSession { workspace_id, path },
    )
    .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected daemon reply: {other:?}")),
    }
}

#[tauri::command]
pub fn set_checklist_item(
    path: String,
    line_index: u32,
    expected_text: String,
    checked: bool,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let resp = send_command_reconnecting(
        &state.0,
        &current_compat(&compat),
        &Request::SetChecklistItem { path, line_index, expected_text, checked },
    )
    .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected daemon reply: {other:?}")),
    }
}

/// Returns the created task card's path.
#[tauri::command]
pub fn promote_checklist_item(
    plan_path: String,
    item: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<String, String> {
    let resp = send_command_reconnecting(
        &state.0,
        &current_compat(&compat),
        &Request::PromoteChecklistItem { plan_path, item },
    )
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
pub fn create_plan(
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
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<String, String> {
    let resp = send_command_reconnecting(
        &state.0,
        &current_compat(&compat),
        &Request::CreatePlan {
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
        },
    )
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
pub fn set_plan_frontmatter_field(
    path: String,
    key: String,
    value: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<String, String> {
    let resp = send_command_reconnecting(
        &state.0,
        &current_compat(&compat),
        &Request::SetPlanFrontmatterField { path, key, value },
    )
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
pub fn archive_card(
    path: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<String, String> {
    let resp =
        send_command_reconnecting(&state.0, &current_compat(&compat), &Request::ArchiveCard { path })
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
pub fn unarchive_card(
    path: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<String, String> {
    let resp = send_command_reconnecting(
        &state.0,
        &current_compat(&compat),
        &Request::UnarchiveCard { path },
    )
    .map_err(|e| e.to_string())?;
    match resp {
        Response::CardMoved { path } => Ok(path),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}

#[tauri::command]
pub fn set_root_config_field(
    root_path: String,
    key: String,
    value: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let resp = send_command_reconnecting(
        &state.0,
        &current_compat(&compat),
        &Request::SetRootConfigField { root_path, key, value },
    )
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
        let writer = Arc::new(Mutex::new(writer_client));

        let alive = adopt_session_impl(
            &Mutex::new(command_client),
            &writer,
            "commit-1".to_string(),
            &parity_compat(),
        )
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
            let writer = Arc::new(Mutex::new(writer_client));

            let alive = adopt_session_impl(
                &Mutex::new(command_client),
                &writer,
                "commit-1".to_string(),
                &parity_compat(),
            )
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
    use super::test_support::{fake_daemon_replying_with, parity_compat};
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
            require_review_asked: false,
            custom_resume_args: None,
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
        }
    }

    #[test]
    fn keeps_a_live_main_session() {
        let (client, _dir) = fake_daemon_replying_with(vec![Response::SessionList {
            sessions: vec![summary("agent-1", "idle")],
        }]);
        let mut workspaces = vec![ws_with_main("ws-1", Some("agent-1"))];
        reconcile_main_sessions(&mut workspaces, &Mutex::new(client), &parity_compat()).unwrap();
        assert_eq!(workspaces[0].main_session_id.as_deref(), Some("agent-1"));
    }

    #[test]
    fn clears_an_exited_or_unknown_main_session_without_respawning() {
        let (client, _dir) = fake_daemon_replying_with(vec![Response::SessionList {
            sessions: vec![summary("agent-1", "exited")],
        }]);
        let mut workspaces =
            vec![ws_with_main("ws-1", Some("agent-1")), ws_with_main("ws-2", Some("never-existed"))];
        reconcile_main_sessions(&mut workspaces, &Mutex::new(client), &parity_compat()).unwrap();
        assert_eq!(workspaces[0].main_session_id, None);
        assert_eq!(workspaces[1].main_session_id, None);
    }

    #[test]
    fn skips_the_round_trip_when_no_workspace_has_a_main_session() {
        // An exhausted fake daemon cannot answer, so this passing proves
        // no ListSessions was sent at all.
        let (client, _dir) = fake_daemon_replying_with(vec![]);
        let mut workspaces = vec![ws_with_main("ws-1", None)];
        reconcile_main_sessions(&mut workspaces, &Mutex::new(client), &parity_compat()).unwrap();
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
            Request::CreateSession { workspace_path: "w".into(), cwd: "c".into(), command: None },
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
    use super::test_support::{fake_daemon_capturing_requests, fake_daemon_replying_with, parity_compat};
    use super::*;
    use protocol::transport::Listener;

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
                },
            ],
        }]);
        let conn = Mutex::new(client);

        let runs = card_runs_impl(&conn, "ws-1".to_string(), "/p/t.md".to_string(), &parity_compat()).unwrap();

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
        let conn = Mutex::new(client);

        let board = get_board_impl(&conn, "ws-1".to_string(), &parity_compat()).unwrap();

        assert_eq!(board.columns.len(), 1);
        assert_eq!(board.columns[0].name, "To Do");
        assert_eq!(board.labels.len(), 1);
    }

    /// Regression for the Critical finding in fix round 1: `get_board_impl`
    /// -- one of the several functions here that are unit-tested against a
    /// bare `Mutex<Stream>` pointed at a tempdir fake socket, with no
    /// path threaded through for a reconnect -- must retry against THAT
    /// SAME fake socket when its connection drops, never against
    /// `protocol::socket_path()` (the real daemon). Built by hand rather
    /// than via `fake_daemon_replying_with` because that helper serves only
    /// one connection; this needs a second `accept()` on the identical
    /// listener to prove the reconnect targets it. If the retry instead
    /// resolved the real socket path, this test would either fail fast (no
    /// real daemon in the test environment) or hang forever waiting on a
    /// second local connection that would never arrive -- either way it
    /// would not pass quickly and cleanly the way it does here.
    #[test]
    fn get_board_impl_retries_against_the_same_fake_socket_not_the_real_daemon() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("board-retry.sock");
        let listener = Listener::bind(&sock).unwrap();

        let server = std::thread::spawn(move || {
            let first = listener.accept().unwrap();
            drop(first);
            let mut second = listener.accept().unwrap();
            let mut reader = BufReader::new(second.try_clone().unwrap());
            let _req: Request = read_message(&mut reader).unwrap().unwrap();
            write_message(
                &mut second,
                &Response::Board {
                    columns: vec![Column { id: "c1".to_string(), name: "To Do".to_string(), position: 0 }],
                    labels: vec![],
                    card_sessions: vec![],
                },
            )
            .unwrap();
        });

        let conn = Mutex::new(Stream::connect(&sock).unwrap());
        let board = get_board_impl(&conn, "ws-1".to_string(), &parity_compat()).unwrap();

        assert_eq!(board.columns.len(), 1);
        assert_eq!(board.columns[0].name, "To Do");
        server.join().unwrap();
    }

    #[test]
    fn get_board_impl_sends_the_given_workspace_id() {
        let (client, captured, _dir) =
            fake_daemon_capturing_requests(vec![Response::Board { columns: vec![], labels: vec![], card_sessions: vec![] }]);
        let conn = Mutex::new(client);

        get_board_impl(&conn, "ws-42".to_string(), &parity_compat()).unwrap();

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
        let conn = Mutex::new(client);

        let result = get_board_impl(&conn, "ws-1".to_string(), &parity_compat());

        assert!(result.is_err());
    }

    #[test]
    fn set_board_impl_sends_the_given_columns_and_labels() {
        let (client, captured, _dir) = fake_daemon_capturing_requests(vec![Response::Ok]);
        let conn = Mutex::new(client);
        let columns = vec![Column { id: "c1".to_string(), name: "Only".to_string(), position: 0,  }];

        set_board_impl(&conn, "ws-1".to_string(), columns.clone(), vec![], &parity_compat()).unwrap();

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
        let conn = Mutex::new(client);

        let result = set_board_impl(&conn, "ws-1".to_string(), vec![], vec![], &parity_compat());

        assert!(result.is_err());
    }

    #[test]
    fn delete_board_impl_sends_the_given_workspace_id() {
        let (client, captured, _dir) = fake_daemon_capturing_requests(vec![Response::Ok]);
        let conn = Mutex::new(client);

        delete_board_impl(&conn, "ws-1".to_string(), &parity_compat()).unwrap();

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
            require_review_asked: false,
            custom_resume_args: None,
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
