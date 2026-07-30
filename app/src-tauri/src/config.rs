use crate::layout::LayoutNode;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct AppConfig {
    pub layout: Option<LayoutNode>,
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

    #[test]
    fn load_returns_default_when_no_file_exists() {
        let dir = tempfile::tempdir().unwrap();
        let config = load(dir.path()).unwrap();
        assert_eq!(config, AppConfig::default());
        assert_eq!(config.layout, None);
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let config = AppConfig { layout: Some(sample_layout()) };
        save(dir.path(), &config).unwrap();

        let loaded = load(dir.path()).unwrap();
        assert_eq!(loaded, config);
    }

    #[test]
    fn save_creates_missing_parent_directories() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("nested").join("config-dir");
        let config = AppConfig { layout: Some(sample_layout()) };
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
