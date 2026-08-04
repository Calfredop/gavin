use crate::layout::LayoutNode;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub id: String,
    pub name: String,
    pub layout: LayoutNode,
    /// The leaf (pane) last focused while this page was active. Kept in
    /// sync with the frontend's live focus while this page IS the active
    /// one; simply retained otherwise. Lets a cross-page "add as tab" drag
    /// (a later plan) target a well-defined pane even in a page that isn't
    /// currently rendered.
    pub focused_session_id: Option<String>,
}

/// Well-known id for the always-present "Unfiled" pseudo-workspace -- a
/// pinned, non-closable, non-renameable workspace for pages the user
/// hasn't organized into a real workspace yet. `session.rs`'s bootstrap()
/// ensures a workspace with this exact id always exists. Must match the
/// frontend's own copy of this constant exactly
/// (app/src/lib/workspace.ts's UNFILED_WORKSPACE_ID).
pub const UNFILED_WORKSPACE_ID: &str = "__unfiled__";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub pages: Vec<Page>,
    pub active_page_id: Option<String>,
    pub active_view: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct AppConfig {
    #[serde(default)]
    pub workspaces: Vec<Workspace>,
    #[serde(default)]
    pub active_workspace_id: Option<String>,
    /// User-assigned display names, keyed by session id. Independent of
    /// `workspaces` (a session can be renamed regardless of which
    /// page/workspace it sits in) -- callers that persist one must always
    /// carry the other's current value along too, or they'll silently
    /// reset it to empty.
    #[serde(default)]
    pub session_names: HashMap<String, String>,
}

pub fn config_path(config_dir: &Path) -> PathBuf {
    config_dir.join("config.json")
}

pub fn load(config_dir: &Path) -> anyhow::Result<AppConfig> {
    let path = config_path(config_dir);
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let contents = std::fs::read_to_string(&path)?;
    // A corrupted/unparseable config file is treated the same as "no
    // saved session" rather than a startup error — a stale or missing
    // session id is already normal, expected behavior (see the
    // ListSessions check in session::bootstrap), not something that
    // should block launch.
    Ok(serde_json::from_str(&contents).unwrap_or_default())
}

pub fn save(config_dir: &Path, config: &AppConfig) -> anyhow::Result<()> {
    std::fs::create_dir_all(config_dir)?;
    let path = config_path(config_dir);
    let contents = serde_json::to_string_pretty(config)?;
    std::fs::write(path, contents)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::LayoutNode;

    fn sample_layout() -> LayoutNode {
        LayoutNode::Leaf {
            tabs: vec!["abc-123".to_string()],
            active_tab_index: 0,
        }
    }

    fn sample_page() -> Page {
        Page {
            id: "page-1".to_string(),
            name: "Page 1".to_string(),
            layout: sample_layout(),
            focused_session_id: None,
        }
    }

    fn sample_workspace() -> Workspace {
        Workspace {
            id: "workspace-1".to_string(),
            name: "Workspace 1".to_string(),
            pages: vec![sample_page()],
            active_page_id: Some("page-1".to_string()),
            active_view: None,
        }
    }

    #[test]
    fn load_returns_default_when_no_file_exists() {
        let dir = tempfile::tempdir().unwrap();
        let config = load(dir.path()).unwrap();
        assert_eq!(config, AppConfig::default());
        assert_eq!(config.workspaces, Vec::new());
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let config = AppConfig {
            workspaces: vec![sample_workspace()],
            active_workspace_id: Some("workspace-1".to_string()),
            session_names: HashMap::new(),
        };
        save(dir.path(), &config).unwrap();

        let loaded = load(dir.path()).unwrap();
        assert_eq!(loaded, config);
    }

    #[test]
    fn session_names_roundtrip_alongside_workspaces() {
        let dir = tempfile::tempdir().unwrap();
        let mut session_names = HashMap::new();
        session_names.insert("abc-123".to_string(), "my project".to_string());
        let config = AppConfig {
            workspaces: vec![sample_workspace()],
            active_workspace_id: Some("workspace-1".to_string()),
            session_names,
        };
        save(dir.path(), &config).unwrap();

        let loaded = load(dir.path()).unwrap();
        assert_eq!(loaded, config);
        assert_eq!(loaded.session_names.get("abc-123"), Some(&"my project".to_string()));
    }

    #[test]
    fn load_defaults_session_names_when_the_field_is_absent() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            config_path(dir.path()),
            r#"{"workspaces": [], "active_workspace_id": null}"#,
        )
        .unwrap();

        let config = load(dir.path()).unwrap();
        assert_eq!(config.session_names, HashMap::new());
    }

    #[test]
    fn load_defaults_workspaces_and_active_workspace_id_when_absent_from_an_older_config_file() {
        let dir = tempfile::tempdir().unwrap();
        // Mirrors a genuine config.json from before this milestone: a real
        // (non-empty) layout tree and session_names map, no workspaces key at
        // all. layout's value is irrelevant -- the field no longer exists on
        // AppConfig, so serde silently drops it -- but session_names MUST
        // survive, since it's the one piece of user data this migration is
        // required to carry forward.
        std::fs::write(
            config_path(dir.path()),
            r#"{"layout": {"type": "leaf", "tabs": ["abc-123"], "activeTabIndex": 0}, "session_names": {"abc-123": "my project"}}"#,
        )
        .unwrap();

        let config = load(dir.path()).unwrap();
        assert_eq!(config.workspaces, Vec::new());
        assert_eq!(config.active_workspace_id, None);
        assert_eq!(config.session_names.get("abc-123"), Some(&"my project".to_string()));
    }

    #[test]
    fn load_defaults_a_workspaces_active_view_to_none_when_absent_from_an_older_workspace_object() {
        let dir = tempfile::tempdir().unwrap();
        // Mirrors a real pre-this-milestone Workspace object: has
        // activePageId, has no activeView key at all.
        std::fs::write(
            config_path(dir.path()),
            r#"{"workspaces": [{"id": "ws-1", "name": "A", "pages": [], "activePageId": null}]}"#,
        )
        .unwrap();

        let config = load(dir.path()).unwrap();
        assert_eq!(config.workspaces.len(), 1);
        assert_eq!(config.workspaces[0].active_view, None);
    }

    #[test]
    fn workspace_serializes_to_the_camel_case_shape_the_frontend_expects() {
        let json = serde_json::to_value(&sample_workspace()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "id": "workspace-1",
                "name": "Workspace 1",
                "pages": [{
                    "id": "page-1",
                    "name": "Page 1",
                    "layout": { "type": "leaf", "tabs": ["abc-123"], "activeTabIndex": 0 },
                    "focusedSessionId": null
                }],
                "activePageId": "page-1",
                "activeView": null
            })
        );
    }

    #[test]
    fn save_creates_missing_parent_directories() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("nested").join("config-dir");
        let config = AppConfig {
            workspaces: vec![sample_workspace()],
            active_workspace_id: Some("workspace-1".to_string()),
            session_names: HashMap::new(),
        };
        save(&nested, &config).unwrap();

        assert!(config_path(&nested).exists());
    }

    #[test]
    fn load_treats_malformed_json_as_default() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(config_path(dir.path()), "{not valid json").unwrap();

        let config = load(dir.path()).unwrap();
        assert_eq!(config, AppConfig::default());
    }
}
