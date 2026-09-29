//! The workspace state split (docs/adr/0006-workspace-settings-apart-from-layout.md).
//!
//! A workspace record holds two things with two different owners:
//!
//! - its SETTINGS -- the Workstation data: what it is called, where it
//!   lives, the Settings tab's switches, the consent and trust stamps, the
//!   runs in flight. Written through `set_workspace_settings`, which a
//!   Companion is allowed to call.
//! - the desk's LAYOUT -- where things are on THIS screen: pages and their
//!   pane trees, which page, view and tab is showing, sidebar pins, divider
//!   and splitter positions. Written through `set_workspaces_state`, which
//!   a Companion is refused.
//!
//! The host is the authority on both halves: a layout save takes only
//! layout from its payload for a workspace it already knows
//! (`merge_layout_save`), and a settings write takes only settings
//! (`apply_settings_patch`). So a desk window saving a stale copy cannot
//! undo a setting the phone -- or another window -- just changed, and
//! nothing a Companion sends can move a tab.
//!
//! config.json itself does NOT change shape: both halves still live in one
//! workspace object on disk, because a release install and a dev build
//! share that file and an older build must go on reading it as its own.
//! The split is in who may write which key, not in where it is stored.
//!
//! The key lists must match `workspaceSettings.ts` on the frontend;
//! `workspaceSettingsParity.test.ts` holds the two to it, and
//! `every_key_a_workspace_writes_is_classified_exactly_once` below holds
//! these lists to the `Workspace` struct.

use crate::config::Workspace;
use crate::session::{WorkspacesData, WorkspacesState};
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, Manager, State};

/// Where things are on the desk's screen: what a Companion never writes.
/// The keys are config.json's (camelCase), which are also the wire's.
pub const LAYOUT_KEYS: &[&str] = &[
    "pages",
    "activePageId",
    "activeView",
    "hubView",
    // The Home tab's agent cell: which session sits there is placement.
    "mainSessionId",
    "homeAgentShare",
    // Splitter widths, diff layout, the selected worktree: the Git tab's
    // view state. Its in-flight commit record rides along; a Companion that
    // starts a commit will need that record on the settings side.
    "gitView",
    "lastActiveAt",
    "pinnedAt",
];

/// Everything else about a workspace: the Workstation data.
pub const SETTINGS_KEYS: &[&str] = &[
    "name",
    "rootPath",
    "ssh",
    "color",
    "notifyNeedsInput",
    "notifyFinished",
    "confirmTabClose",
    "terminalFontSize",
    "autoCommit",
    "autoResumeRuns",
    "agentPause",
    "agentFallback",
    "armedAgents",
    "declinedAgents",
    "complexityAgents",
    "gitTrackingAsked",
    "trustedConfigHash",
    "mcpForeignServersChoice",
    "reviewedCards",
    "requireReview",
    "requireReviewAsked",
    "headroom",
    "headroomAsked",
    "customResumeArgs",
    "actionPromptOverrides",
    // Runs in flight are not layout: a Generate or a Develop started from
    // the phone has to be able to claim its slot as well.
    "orchestrationAgent",
    "developingCards",
];

/// D41's `agentCommand`, which bootstrap carries into config.toml and
/// clears. Neither side may write it: the frontend has never known the key,
/// so it rides the LAYOUT save exactly as it rode every save before the
/// split -- which is what drops it from config.json after the migration.
pub const LEGACY_KEYS: &[&str] = &["agentCommand"];

fn object_of(ws: &Workspace) -> Map<String, Value> {
    match serde_json::to_value(ws) {
        Ok(Value::Object(object)) => object,
        // A struct of strings, numbers and maps serializes to an object or
        // not at all; neither arm below can be reached by a real workspace.
        Ok(other) => unreachable!("a workspace serialized to {other}"),
        Err(e) => unreachable!("a workspace failed to serialize: {e}"),
    }
}

/// A workspace's Workstation data: its id and the settings it has, and
/// nothing of the layout. What `get_workspace_settings` answers with and
/// what `workspace-settings-synced` carries.
pub fn settings_record(ws: &Workspace) -> Map<String, Value> {
    object_of(ws)
        .into_iter()
        .filter(|(key, _)| key == "id" || SETTINGS_KEYS.contains(&key.as_str()))
        .collect()
}

/// `ws` with `patch` applied. A key set to `null` is removed, which puts it
/// back to its default -- inherit, for every `Option` here. A patch naming
/// anything but a setting is refused WHOLE rather than applied in part: a
/// caller that sent a layout key has misunderstood which command it is
/// calling, and half-applying its patch would hide that. A value of the
/// wrong shape is refused by the same deserialization config.json's load
/// goes through, so nothing stored here could fail to load again.
pub fn apply_settings_patch(ws: &Workspace, patch: &Map<String, Value>) -> Result<Workspace, String> {
    if let Some(key) = patch.keys().find(|key| !SETTINGS_KEYS.contains(&key.as_str())) {
        return Err(format!("`{key}` is not a workspace setting"));
    }
    let mut object = object_of(ws);
    for (key, value) in patch {
        if value.is_null() {
            object.remove(key);
        } else {
            object.insert(key.clone(), value.clone());
        }
    }
    serde_json::from_value(Value::Object(object)).map_err(|e| format!("invalid workspace setting: {e}"))
}

/// A layout save of a workspace the host already holds: the save's
/// layout, the host's settings. Written field by field rather than through
/// the key lists so the compiler checks it; the key-list tests check that
/// the two agree.
pub fn with_layout_of(stored: &Workspace, layout: Workspace) -> Workspace {
    Workspace {
        id: layout.id,
        pages: layout.pages,
        active_page_id: layout.active_page_id,
        active_view: layout.active_view,
        hub_view: layout.hub_view,
        main_session_id: layout.main_session_id,
        home_agent_share: layout.home_agent_share,
        git_view: layout.git_view,
        last_active_at: layout.last_active_at,
        pinned_at: layout.pinned_at,
        legacy_agent_command: layout.legacy_agent_command,
        ..stored.clone()
    }
}

/// The workspaces a layout save leaves behind. Its order wins and a
/// workspace it leaves out is gone -- adding, closing and reordering
/// workspaces are still the desk's, through this save. A workspace the host
/// has never seen is taken whole, since the desk is creating it (or, for a
/// reclaim, re-keying it to a removed workspace's id); one it already holds
/// takes only its layout from the save.
pub fn merge_layout_save(stored: &[Workspace], incoming: Vec<Workspace>) -> Vec<Workspace> {
    incoming
        .into_iter()
        .map(|layout| match stored.iter().find(|w| w.id == layout.id) {
            Some(known) => with_layout_of(known, layout),
            None => layout,
        })
        .collect()
}

/// The settings a layout save carried that differ from the host's, in
/// `SETTINGS_KEYS` order -- the changes `with_layout_of` is about to drop.
/// Compared as stored values rather than as JSON, so a key the frontend
/// leaves absent and the host holds at its default is not a difference.
/// Only ever logged: a window that saves before it has adopted another
/// writer's settings does this legitimately, but a setter that still
/// writes a setting through the layout save does it every time.
pub fn dropped_settings(stored: &Workspace, layout: &Workspace) -> Vec<&'static str> {
    let (stored, layout) = (object_of(stored), object_of(layout));
    SETTINGS_KEYS
        .iter()
        .copied()
        .filter(|key| stored.get(*key) != layout.get(*key))
        .collect()
}

/// One writer's change to one workspace's settings, addressed to every
/// window. `origin` is the writer's window label, so the writer can ignore
/// its own echo; `record` is the workspace's WHOLE settings after the
/// write, so a window adopting it converges on the host's copy.
#[derive(Clone, serde::Serialize)]
pub struct WorkspaceSettingsSync {
    origin: String,
    record: Map<String, Value>,
}

/// Every workspace's Workstation data, in the desk's order.
#[tauri::command]
pub fn get_workspace_settings(state: State<WorkspacesState>) -> Vec<Map<String, Value>> {
    state.0.lock().unwrap().workspaces.iter().map(settings_record).collect()
}

/// Changes some of one workspace's settings, persists, and tells every
/// window. See `write_workspace_settings`.
#[tauri::command]
pub fn set_workspace_settings(
    workspace_id: String,
    patch: Map<String, Value>,
    app_handle: AppHandle,
    window: tauri::Window,
) -> Result<(), String> {
    write_workspace_settings(&app_handle, window.label(), &workspace_id, &patch)
}

/// The body of `set_workspace_settings`, apart from the window that asked:
/// a caller with no window of its own -- a forwarded Companion call --
/// names its origin instead.
///
/// A workspace the host does not hold is a no-op, not an error. The one
/// way the desk gets here is a window that has not yet adopted another
/// window's close of that workspace, and the close is the newer word;
/// answering it with an error would put the whole window in its error
/// state over a race it lost.
pub(crate) fn write_workspace_settings(
    app: &AppHandle,
    origin: &str,
    workspace_id: &str,
    patch: &Map<String, Value>,
) -> Result<(), String> {
    let state = app.state::<WorkspacesState>();
    let (data, record): (WorkspacesData, Map<String, Value>) = {
        let mut guard = state.0.lock().unwrap();
        let Some(slot) = guard.workspaces.iter_mut().find(|w| w.id == workspace_id) else {
            return Ok(());
        };
        *slot = apply_settings_patch(slot, patch)?;
        let record = settings_record(slot);
        (guard.clone(), record)
    };
    crate::session::persist_current(app, &data).map_err(|e| e.to_string())?;
    let _ = app.emit(
        "workspace-settings-synced",
        WorkspaceSettingsSync { origin: origin.to_string(), record },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        AgentCommitRecord, AgentPauseConfig, ComplexityAgent, DevelopingCardRecord, GitViewPrefs,
        McpForeignServersChoice, OrchestrationAgentRecord, Page, SshConfig,
    };
    use crate::layout::LayoutNode;
    use std::collections::{BTreeSet, HashMap};

    /// A workspace with EVERY key present and every value depending on
    /// `flavour`, so a test that compares key by key cannot pass by
    /// finding nothing to compare, or by two sides happening to agree.
    fn every_key(id: &str, flavour: &str) -> Workspace {
        let n = if flavour == "a" { 1 } else { 2 };
        let s = |prefix: &str| format!("{prefix}-{flavour}");
        Workspace {
            id: id.to_string(),
            name: s("name"),
            pages: vec![Page {
                id: s("page"),
                name: s("Page"),
                layout: LayoutNode::Leaf { tabs: vec![s("tab")], active_tab_index: 0, pinned: vec![] },
                focused_session_id: Some(s("tab")),
                pinned_at: Some(n),
            }],
            active_page_id: Some(s("page")),
            active_view: Some(s("view")),
            hub_view: Some(s("hub")),
            root_path: Some(format!("/root/{flavour}")),
            ssh: Some(SshConfig { host: s("host"), daemon_path: Some(s("daemon")) }),
            main_session_id: Some(s("main")),
            orchestration_agent: Some(OrchestrationAgentRecord {
                session_id: s("orch"),
                rail_id: Some(s("rail")),
                label: s("Generate"),
            }),
            developing_cards: vec![DevelopingCardRecord { path: s("/card"), session_id: s("dev") }],
            legacy_agent_command: Some(s("claude")),
            color: Some(s("#color")),
            notify_needs_input: flavour == "a",
            notify_finished: flavour == "a",
            confirm_tab_close: flavour == "a",
            terminal_font_size: Some(12 + n as u16),
            auto_commit: Some(flavour == "a"),
            home_agent_share: Some(0.25 * n as f64),
            auto_resume_runs: flavour == "a",
            git_view: Some(GitViewPrefs {
                nav_width: Some(100 * n as u32),
                list_width: Some(200 * n as u32),
                unstaged_share: Some(0.1 * n as f64),
                diff_layout: Some(s("split")),
                skip_hunk_discard_confirm: flavour == "a",
                nav_collapsed: Some(HashMap::from([(s("section"), true)])),
                worktree: Some(s("/wt")),
                graph_all: Some(flavour == "a"),
                agent_commit: Some(AgentCommitRecord {
                    session_id: s("commit"),
                    cwd: s("/cwd"),
                    retries: n as u32,
                    started_at: Some(n),
                }),
            }),
            last_active_at: Some(n),
            agent_pause: Some(AgentPauseConfig {
                enabled: flavour == "a",
                period_minutes: 300,
                pause_minutes: 10 * n as u32,
                anchor_ms: n,
                limit_percent: 95.0,
                limit_enabled: flavour == "a",
            }),
            pinned_at: Some(10 * n),
            complexity_agents: HashMap::from([(
                "complex".to_string(),
                ComplexityAgent { profile: s("profile"), model: s("model"), effort: s("effort") },
            )]),
            git_tracking_asked: flavour == "a",
            trusted_config_hash: Some(s("hash")),
            mcp_foreign_servers_choice: Some(McpForeignServersChoice {
                hash: s("mcp"),
                action: "keep".to_string(),
            }),
            reviewed_cards: Some(HashMap::from([(s("/card"), s("digest"))])),
            require_review: Some(flavour == "a"),
            headroom: Some(flavour == "a"),
            require_review_asked: flavour == "a",
            headroom_asked: flavour == "a",
            custom_resume_args: Some(s("--resume")),
            agent_fallback: Some(vec![s("fallback")]),
            armed_agents: vec![s("armed")],
            declined_agents: vec![s("declined")],
            action_prompt_overrides: HashMap::from([("action:run-task".to_string(), s("prompt"))]),
        }
    }

    fn json(ws: &Workspace) -> Map<String, Value> {
        match serde_json::to_value(ws).unwrap() {
            Value::Object(object) => object,
            other => panic!("a workspace serialized to {other}"),
        }
    }

    fn patch(value: Value) -> Map<String, Value> {
        match value {
            Value::Object(object) => object,
            other => panic!("not a patch: {other}"),
        }
    }

    #[test]
    fn every_key_a_workspace_writes_is_classified_exactly_once() {
        let written: BTreeSet<String> = json(&every_key("ws", "a")).keys().cloned().collect();
        let mut classified: Vec<&str> = vec!["id"];
        classified.extend(LAYOUT_KEYS);
        classified.extend(SETTINGS_KEYS);
        classified.extend(LEGACY_KEYS);
        let unique: BTreeSet<String> = classified.iter().map(|k| k.to_string()).collect();
        assert_eq!(unique.len(), classified.len(), "a key is on two lists: {classified:?}");
        assert_eq!(unique, written, "the lists and the keys config.json holds disagree");
    }

    #[test]
    fn a_settings_record_is_the_id_and_the_settings_and_nothing_else() {
        let record = settings_record(&every_key("ws-a", "a"));
        let keys: BTreeSet<&str> = record.keys().map(String::as_str).collect();
        let mut expected: BTreeSet<&str> = SETTINGS_KEYS.iter().copied().collect();
        expected.insert("id");
        assert_eq!(keys, expected);
        assert_eq!(record["id"], "ws-a");
        assert_eq!(record["autoCommit"], true);
    }

    #[test]
    fn a_patch_sets_the_named_settings_and_leaves_everything_else() {
        let before = every_key("ws-a", "a");
        let after = apply_settings_patch(
            &before,
            &patch(serde_json::json!({ "autoCommit": false, "color": "#123456", "name": "Renamed" })),
        )
        .unwrap();
        assert_eq!(after.auto_commit, Some(false));
        assert_eq!(after.color.as_deref(), Some("#123456"));
        assert_eq!(after.name, "Renamed");
        let expected = Workspace {
            auto_commit: Some(false),
            color: Some("#123456".to_string()),
            name: "Renamed".to_string(),
            ..before
        };
        assert_eq!(after, expected);
    }

    /// The compression switch (`2026-09-28-headroom-design.md`, "The
    /// switch"): a setting, written as one, that is still there after a
    /// restart -- and that leaves no trace while nobody has chosen.
    #[test]
    fn the_compression_switch_is_a_setting_that_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let mut undecided = every_key("ws-a", "b");
        undecided.headroom = None;
        let as_written = serde_json::to_value(&undecided).unwrap();
        assert!(as_written.get("headroom").is_none(), "absence is inherit, and is not written");

        let on = apply_settings_patch(&undecided, &patch(serde_json::json!({ "headroom": true }))).unwrap();
        let config = crate::config::AppConfig { workspaces: vec![on], ..Default::default() };
        crate::config::save(dir.path(), &config).unwrap();

        // The next launch reads the file.
        let restarted = crate::config::load(dir.path()).unwrap();
        assert_eq!(restarted.workspaces[0].headroom, Some(true));
        assert_eq!(settings_record(&restarted.workspaces[0]).get("headroom"), Some(&Value::Bool(true)));

        // Off is a choice of its own, and null is no choice at all.
        let off = apply_settings_patch(
            &restarted.workspaces[0],
            &patch(serde_json::json!({ "headroom": false })),
        )
        .unwrap();
        assert_eq!(off.headroom, Some(false));
        let cleared =
            apply_settings_patch(&off, &patch(serde_json::json!({ "headroom": null }))).unwrap();
        assert_eq!(cleared.headroom, None);
        assert_eq!(cleared.pages, undecided.pages);
    }

    /// The desk's layout save must not be able to undo the switch: it is
    /// the write ADR 0006 took the settings away from.
    #[test]
    fn a_layout_save_cannot_turn_compression_off() {
        let mut stored = every_key("ws-a", "b");
        stored.headroom = Some(true);
        let mut from_the_desk = stored.clone();
        from_the_desk.headroom = None;

        let merged = merge_layout_save(&[stored.clone()], vec![from_the_desk.clone()]);

        assert_eq!(merged[0].headroom, Some(true));
        // And a debug build says which setting the save tried to change.
        assert_eq!(dropped_settings(&stored, &from_the_desk), vec!["headroom"]);
    }

    #[test]
    fn null_clears_a_setting_back_to_its_default() {
        let before = every_key("ws-a", "b");
        let after = apply_settings_patch(
            &before,
            &patch(serde_json::json!({
                "agentPause": null,
                "requireReview": null,
                "notifyNeedsInput": null,
                "armedAgents": null,
            })),
        )
        .unwrap();
        assert_eq!(after.agent_pause, None, "absent means inherit the app-wide cycle");
        assert_eq!(after.require_review, None);
        assert!(after.notify_needs_input, "a cleared notification toggle is back on");
        assert!(after.armed_agents.is_empty());
        assert_eq!(after.pages, before.pages);
    }

    #[test]
    fn a_patch_naming_layout_is_refused_whole() {
        let before = every_key("ws-a", "a");
        for key in LAYOUT_KEYS.iter().chain(["id", "agentCommand", "noSuchKey"].iter()) {
            let err = apply_settings_patch(
                &before,
                &patch(serde_json::json!({ "autoCommit": false, (*key): null })),
            )
            .unwrap_err();
            assert!(err.contains(key), "{key}: {err}");
        }
    }

    #[test]
    fn a_patch_of_the_wrong_shape_is_refused() {
        let before = every_key("ws-a", "a");
        assert!(apply_settings_patch(&before, &patch(serde_json::json!({ "autoCommit": "yes" }))).is_err());
        // `name` is required: clearing it would leave a workspace nobody
        // can tell apart in the sidebar, and no older build could load it.
        assert!(apply_settings_patch(&before, &patch(serde_json::json!({ "name": null }))).is_err());
    }

    #[test]
    fn a_layout_save_takes_only_layout_for_a_workspace_the_host_knows() {
        let stored = every_key("ws-a", "a");
        let incoming = every_key("ws-a", "b");
        let merged = json(&with_layout_of(&stored, incoming.clone()));
        let (stored, incoming) = (json(&stored), json(&incoming));
        for key in LAYOUT_KEYS {
            assert_eq!(merged[*key], incoming[*key], "layout key {key} must come from the save");
        }
        for key in SETTINGS_KEYS {
            assert_eq!(merged[*key], stored[*key], "setting {key} must survive a layout save");
        }
    }

    /// D41's migration key. The frontend has never sent it, so the layout
    /// save is what drops it from config.json after bootstrap has carried
    /// it into config.toml -- exactly what every save did before the split.
    #[test]
    fn the_legacy_agent_command_follows_the_layout_save_as_it_always_did() {
        let stored = every_key("ws-a", "a");
        let incoming = Workspace { legacy_agent_command: None, ..every_key("ws-a", "b") };
        assert_eq!(with_layout_of(&stored, incoming).legacy_agent_command, None);
    }

    #[test]
    fn a_layout_save_adds_removes_and_reorders_workspaces() {
        let stored = vec![every_key("ws-a", "a"), every_key("ws-b", "a")];
        let incoming = vec![every_key("ws-new", "b"), every_key("ws-a", "b")];
        let merged = merge_layout_save(&stored, incoming.clone());
        assert_eq!(
            merged.iter().map(|w| w.id.as_str()).collect::<Vec<_>>(),
            vec!["ws-new", "ws-a"],
            "the save's order wins, and a workspace it leaves out is gone"
        );
        assert_eq!(merged[0], incoming[0], "a workspace the host has never seen is taken whole");
        assert_eq!(merged[1].name, "name-a", "a known one keeps the host's settings");
        assert_eq!(merged[1].pages, incoming[1].pages);
    }

    #[test]
    fn dropped_settings_names_what_a_layout_save_tried_to_change() {
        let stored = every_key("ws-a", "a");
        assert!(dropped_settings(&stored, &stored.clone()).is_empty());
        let stale = Workspace { auto_commit: Some(false), color: None, pages: vec![], ..stored.clone() };
        assert_eq!(dropped_settings(&stored, &stale), vec!["color", "autoCommit"]);
    }

    /// Acceptance: a config.json written by the build before the split --
    /// every key it knew, hand-written in its shape, the Scratchpad in the
    /// shape it has when nothing was ever set on it -- loads without loss,
    /// and what this build writes back after a settings write and a layout
    /// save is that file again, byte for byte as JSON.
    #[test]
    fn an_old_shape_config_survives_a_settings_write_and_a_layout_save_unchanged() {
        let old_shape = r##"{
          "workspaces": [
            {
              "id": "ws-1",
              "name": "Gavin",
              "pages": [
                {
                  "id": "page-1",
                  "name": "Main",
                  "layout": {
                    "type": "split",
                    "direction": "row",
                    "children": [
                      { "type": "leaf", "tabs": ["s-1", "s-2"], "activeTabIndex": 1, "pinned": ["s-1"] },
                      { "type": "leaf", "tabs": ["f-1"], "activeTabIndex": 0 }
                    ],
                    "sizes": [0.6, 0.4]
                  },
                  "focusedSessionId": "s-2",
                  "pinnedAt": 1700000000000
                }
              ],
              "activePageId": "page-1",
              "activeView": "terminal",
              "hubView": "board",
              "rootPath": "/Users/me/gavin",
              "mainSessionId": "main-1",
              "orchestrationAgent": { "sessionId": "orch-1", "railId": "rail-1", "label": "Reorganize “backend”" },
              "developingCards": [{ "path": "/Users/me/gavin/.gavin-root/plans/x.md", "sessionId": "dev-1" }],
              "color": "#a78bfa",
              "notifyNeedsInput": false,
              "notifyFinished": true,
              "confirmTabClose": false,
              "terminalFontSize": 14,
              "autoCommit": true,
              "homeAgentShare": 0.42,
              "autoResumeRuns": true,
              "gitView": {
                "navWidth": 220,
                "listWidth": 340,
                "unstagedShare": 0.5,
                "diffLayout": "split",
                "skipHunkDiscardConfirm": true,
                "navCollapsed": { "stashes": true },
                "worktree": "/Users/me/gavin/.gavin-worktrees/x",
                "graphAll": false,
                "agentCommit": { "sessionId": "commit-1", "cwd": "/Users/me/gavin", "retries": 1, "startedAt": 1700000000001 }
              },
              "lastActiveAt": 1700000000002,
              "agentPause": { "enabled": true, "periodMinutes": 300, "pauseMinutes": 10, "anchorMs": 1700000000003, "limitPercent": 95.0, "limitEnabled": true },
              "pinnedAt": 1700000000004,
              "complexityAgents": { "complex": { "profile": "claude-code", "model": "opus" } },
              "gitTrackingAsked": true,
              "trustedConfigHash": "abc123",
              "mcpForeignServersChoice": { "hash": "def456", "action": "keep" },
              "reviewedCards": { "/Users/me/gavin/.gavin-root/plans/x.md": "digest" },
              "requireReview": false,
              "requireReviewAsked": true,
              "customResumeArgs": "--resume",
              "agentFallback": ["codex"],
              "armedAgents": ["codex"],
              "declinedAgents": ["opencode"],
              "actionPromptOverrides": { "action:run-task": "Do it." }
            },
            {
              "id": "__unfiled__",
              "name": "Scratchpad",
              "pages": [],
              "activePageId": null,
              "activeView": null,
              "rootPath": null,
              "mainSessionId": null,
              "color": null,
              "notifyNeedsInput": true,
              "notifyFinished": true,
              "confirmTabClose": true,
              "autoResumeRuns": false,
              "gitView": null,
              "lastActiveAt": null,
              "gitTrackingAsked": false,
              "requireReviewAsked": false
            }
          ],
          "active_workspace_id": "ws-1",
          "session_names": { "s-1": "server" },
          "file_tabs": { "f-1": "/Users/me/gavin/README.md" },
          "board_tabs": {},
          "card_tabs": {},
          "theme": "dark",
          "agent_models": { "claude-code": "opus" },
          "terminal_font_size": 13,
          "auto_commit": false,
          "removed_workspaces": [{ "id": "ws-old", "name": "Old", "rootPath": "/Users/me/old", "removedAt": 1690000000000 }],
          "agent_pause": null,
          "superpowers": { "/Users/me/gavin": "installed" },
          "agent_defaults": { "customCommand": "claude", "customModelFlag": "--model", "complexity": {} },
          "git_tracking": null,
          "require_review": null,
          "launch": null,
          "custom_resume_args": null
        }"##;
        let original: Value = serde_json::from_str(old_shape).unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(crate::config::config_path(dir.path()), old_shape).unwrap();
        let config = crate::config::load(dir.path()).unwrap();
        assert_eq!(config.workspaces.len(), 2, "the old file must not read as a corrupt one");

        // What the settings commands load: every setting the file held.
        let record = settings_record(&config.workspaces[0]);
        let file_ws = original["workspaces"][0].as_object().unwrap();
        for key in SETTINGS_KEYS {
            assert_eq!(record.get(*key), file_ws.get(*key), "setting {key} lost on load");
        }

        // A settings write that changes nothing, then the desk's layout
        // save of what it holds -- the round trip every save now makes.
        let unchanged = patch(serde_json::json!({ "autoCommit": true }));
        let patched = apply_settings_patch(&config.workspaces[0], &unchanged).unwrap();
        let workspaces = vec![patched, config.workspaces[1].clone()];
        let saved = crate::config::AppConfig {
            workspaces: merge_layout_save(&workspaces, config.workspaces.clone()),
            ..config.clone()
        };
        crate::config::save(dir.path(), &saved).unwrap();
        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(crate::config::config_path(dir.path())).unwrap())
                .unwrap();

        // The file this build writes back IS the file the old build wrote:
        // no key lost, no value changed, and no key the old build does not
        // know -- so the release install that shares it reads it as its own.
        assert_eq!(written, original);
    }
}
