//! Removing gavin from a workspace root.
//!
//! Two commands, deliberately split: [`scan_gavin_footprint`] reports
//! what is actually there and changes nothing, and
//! [`remove_gavin_footprint`] executes a plan the user has seen. The
//! wizard walks six screens between them, so the gap is not an
//! implementation detail -- it is what makes every answer revocable
//! until the last one.
//!
//! Three rules hold throughout:
//!
//! * **The Trash, never `rm`.** A card in `plans/done/` that git never
//!   tracked is one Finder gesture away afterwards rather than gone.
//! * **A shared file is edited, never removed.** `.mcp.json` belongs to
//!   every server in it and `CLAUDE.md` to whoever wrote the prose
//!   around gavin's block; both keep every byte that is not gavin's.
//! * **A path the scan did not report cannot be removed.** The remover
//!   re-scans and intersects, so a plan that has gone stale (or been
//!   tampered with) removes less than it asked for, never more.

use crate::agent_setup;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Mirrors the daemon's own scan (`gavin::scan_root`): the same depth
/// limit and the same skipped directories, so the wizard finds exactly
/// the contexts the app has been showing all along. Duplicated rather
/// than shared because the app does not depend on the daemon crate;
/// they are pinned together by `scan_matches_the_daemons_walk` below.
const MAX_SCAN_DEPTH: usize = 12;
const EXCLUDED_DIRS: &[&str] =
    &[".git", "node_modules", "target", "dist", "build", ".venv", "venv", "__pycache__"];
const GAVIN_ROOT_DIR: &str = ".gavin-root";
const GAVIN_DIR: &str = ".gavin";

/// What a scan found. Every path is absolute and exists; a field that is
/// `None` or empty means the wizard skips that screen entirely.
/// camelCase to match the TypeScript that renders it
/// (`workspaceDelete.ts`'s `GavinFootprint`).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GavinFootprint {
    pub root: String,
    pub gavin_root: Option<GavinRootFootprint>,
    pub skills: Vec<String>,
    /// The gavin-owned agent definition, where the profile installs one
    /// (opencode's `.opencode/agent/gavin-commit.md`). Its own field
    /// rather than another entry in `skills`: that list is directories
    /// under one skill root, and a file from elsewhere in the tree
    /// hiding in it is how a scanner starts lying about what it found.
    /// The wizard answers for both on one screen, since both are whole
    /// files gavin wrote and leaves.
    pub agent_file: Option<String>,
    pub mcp: Option<McpFootprint>,
    pub instructions: Option<String>,
    pub contexts: Vec<ContextFootprint>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GavinRootFootprint {
    pub path: String,
    /// Cards still on the board: every `.md` under `plans/`, including
    /// `plans/done/`, but not `plans/archive/`.
    pub cards: usize,
    /// Cards taken off the board (`plans/archive/`). Counted apart
    /// because they are the ones nobody has looked at in months, and so
    /// the ones nobody would notice were gone.
    pub archived: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpFootprint {
    pub path: String,
    pub server_key: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextFootprint {
    pub path: String,
    /// Registered through the root config's `extra_contexts` and living
    /// beyond the root. The only paths this wizard may touch outside the
    /// root, named one by one and unticked by default.
    pub outside: bool,
}

/// What the user approved, straight from `workspaceDelete.ts`'s
/// `plannedRemovals`. `rows` is not here: clearing the daemon's rows is
/// the app's job over its own connection, and Rust never sees it.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemovalPlan {
    pub trash: Vec<String>,
    pub strip_mcp_key: Vec<McpFootprint>,
    pub cut_block: Vec<String>,
}

/// What actually happened. One failure never aborts the rest: a
/// permission error on one skill directory must not leave the other five
/// categories half-done with no way to tell which, so every item is
/// attempted and every failure is reported with the path that caused it.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemovalReport {
    /// Paths trashed and files edited, as they happened.
    pub done: Vec<String>,
    /// `(path, reason)` for everything that did not.
    pub failed: Vec<(String, String)>,
}

/// Moves one path to the OS Trash.
///
/// On macOS the crate offers two routes and neither is free. The default
/// asks Finder over Apple events: it plays the sound and fills in "Put
/// Back", but it needs the Automation permission, and a delete wizard
/// that dies on an unrelated TCC prompt is worse than one without a
/// context-menu entry. `NsFileManager` needs no grant and is markedly
/// faster; the files land in the same Trash and can still be dragged
/// back out, which is the promise this feature actually makes.
#[cfg(target_os = "macos")]
fn trash_path(path: &str) -> Result<(), String> {
    use trash::macos::{DeleteMethod, TrashContextExtMacos};
    let mut ctx = trash::TrashContext::default();
    ctx.set_delete_method(DeleteMethod::NsFileManager);
    ctx.delete(path).map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
fn trash_path(path: &str) -> Result<(), String> {
    trash::delete(path).map_err(|e| e.to_string())
}

fn md_count(dir: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    entries
        .flatten()
        .filter(|e| {
            let path = e.path();
            path.is_file() && path.extension().is_some_and(|x| x == "md")
        })
        .count()
}

/// Cards under `plans/`, recursively but excluding `plans/archive/`,
/// which is counted on its own. Recursive because a card's nested tasks
/// live in a folder beside it, and "12 cards" that ignored them would
/// undercount what is about to be trashed.
fn count_cards(plans: &Path, archive: &Path) -> usize {
    let mut total = md_count(plans);
    let Ok(entries) = std::fs::read_dir(plans) else { return total };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && path != archive {
            total += count_cards(&path, archive);
        }
    }
    total
}

fn count_archived(archive: &Path) -> usize {
    let mut total = md_count(archive);
    let Ok(entries) = std::fs::read_dir(archive) else { return total };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            total += count_archived(&path);
        }
    }
    total
}

/// Every `.gavin/` under the root. The walk matches the daemon's:
/// `.gavin*` directories are never descended into, and the same excluded
/// and dot-prefixed directories are skipped.
fn walk_contexts(dir: &Path, depth: usize, found: &mut Vec<PathBuf>) {
    if depth > MAX_SCAN_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name == GAVIN_DIR {
            found.push(path);
            continue;
        }
        if name == GAVIN_ROOT_DIR || EXCLUDED_DIRS.contains(&name.as_str()) || name.starts_with('.')
        {
            continue;
        }
        walk_contexts(&path, depth + 1, found);
    }
}

/// The root config's `extra_contexts`: absolute folders registered from
/// outside the root. Only the ones that still hold a `.gavin/` are
/// reported -- an entry pointing at a folder that has moved on is a
/// stale line in a config file, not something to offer to delete. An
/// entry that resolves back INSIDE the root is skipped too, or the walk
/// above would already have found it and the wizard would list one
/// folder twice.
fn outside_contexts(root: &Path) -> Vec<PathBuf> {
    let config = root.join(GAVIN_ROOT_DIR).join("config.toml");
    let Ok(content) = std::fs::read_to_string(&config) else { return Vec::new() };
    let Ok(table) = content.parse::<toml::Table>() else { return Vec::new() };
    let Some(entries) = table.get("extra_contexts").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let mut found: Vec<PathBuf> = entries
        .iter()
        .filter_map(|v| v.as_str())
        .map(PathBuf::from)
        .filter(|p| !p.starts_with(root))
        .map(|p| p.join(GAVIN_DIR))
        .filter(|p| p.is_dir())
        .collect();
    found.sort();
    found.dedup();
    found
}

/// What gavin has actually put into this root. Reads only.
///
/// Nothing is reported that is not there: a `.mcp.json` without gavin's
/// key, an instructions file without the marker block, and an
/// `extra_contexts` entry whose folder has moved on are all invisible
/// here, because a screen asking permission to remove nothing is a step
/// that can only be answered wrong.
pub fn scan(root: &Path) -> Result<GavinFootprint, String> {
    if !root.is_dir() {
        return Err(format!("root does not exist: {}", root.display()));
    }
    let install = agent_setup::gavin_install(root);

    let gavin_root_path = root.join(GAVIN_ROOT_DIR);
    let gavin_root = gavin_root_path.is_dir().then(|| {
        let plans = gavin_root_path.join("plans");
        let archive = plans.join("archive");
        GavinRootFootprint {
            path: gavin_root_path.to_string_lossy().to_string(),
            cards: count_cards(&plans, &archive),
            archived: count_archived(&archive),
        }
    });

    // The table's own skills, plus any gavin-prefixed sibling beside
    // them: the two step skills are installed on demand by
    // compose_agent_prompt and appear in no table, so reading the table
    // alone would leave them on disk.
    let mut skills: Vec<PathBuf> = install.skills.into_iter().filter(|p| p.is_dir()).collect();
    if let Some(skill_root) = install.skill_root.as_ref() {
        if let Ok(entries) = std::fs::read_dir(skill_root) {
            for entry in entries.flatten() {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                if path.is_dir() && name.starts_with("gavin") && !skills.contains(&path) {
                    skills.push(path);
                }
            }
        }
    }
    skills.sort();
    let skills: Vec<String> = skills.iter().map(|p| p.to_string_lossy().to_string()).collect();

    // Reported only when it is really there, the same rule the MCP and
    // instructions entries follow: a screen offering to remove a file
    // that does not exist can only be answered wrong.
    let agent_file = install
        .agent_file
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().to_string());

    let mcp = install.mcp.and_then(|(path, server_key)| {
        agent_setup::mcp_entry_present(root)
            .then(|| McpFootprint { path: path.to_string_lossy().to_string(), server_key })
    });

    let instructions = agent_setup::instructions_block_present(&install.instructions)
        .then(|| install.instructions.to_string_lossy().to_string());

    let mut inside = Vec::new();
    walk_contexts(root, 1, &mut inside);
    // The root's own `.gavin`, which the walk above starts below. gavin
    // itself ignores one that sits beside `.gavin-root`, but it is still
    // a gavin folder on disk and this wizard is about the disk.
    let root_gavin = root.join(GAVIN_DIR);
    if root_gavin.is_dir() {
        inside.push(root_gavin);
    }
    inside.sort();
    let mut contexts: Vec<ContextFootprint> = inside
        .into_iter()
        .map(|p| ContextFootprint { path: p.to_string_lossy().to_string(), outside: false })
        .collect();
    contexts.extend(outside_contexts(root).into_iter().map(|p| ContextFootprint {
        path: p.to_string_lossy().to_string(),
        outside: true,
    }));

    Ok(GavinFootprint {
        root: root.to_string_lossy().to_string(),
        gavin_root,
        skills,
        agent_file,
        mcp,
        instructions,
        contexts,
    })
}

/// Every path the scan would report as removable, for the intersection
/// below. Built from a fresh scan rather than from the plan, so a plan
/// that has gone stale between the screens and the button removes less
/// than it asked for rather than more.
fn removable_paths(footprint: &GavinFootprint) -> Vec<String> {
    let mut paths = Vec::new();
    if let Some(gr) = footprint.gavin_root.as_ref() {
        paths.push(gr.path.clone());
    }
    paths.extend(footprint.skills.iter().cloned());
    paths.extend(footprint.agent_file.iter().cloned());
    paths.extend(footprint.contexts.iter().map(|c| c.path.clone()));
    paths
}

/// Executes an approved plan. Never fails as a whole: every item is
/// attempted, and the report says which ones did not land and why.
pub fn remove(root: &Path, plan: &RemovalPlan) -> Result<RemovalReport, String> {
    let footprint = scan(root)?;
    let allowed = removable_paths(&footprint);
    let mut report = RemovalReport::default();

    for path in &plan.trash {
        if !allowed.contains(path) {
            report.failed.push((
                path.clone(),
                "not reported by the scan — nothing was removed for it".to_string(),
            ));
            continue;
        }
        match trash_path(path) {
            Ok(()) => report.done.push(format!("Moved to Trash: {path}")),
            Err(e) => report.failed.push((path.clone(), e)),
        }
    }

    // Edits, not removals. The plan names the file, but the editing is
    // agent_setup's -- the module that wrote the entry is the one that
    // knows how to take it out without reformatting everything else.
    for mcp in &plan.strip_mcp_key {
        match footprint.mcp.as_ref() {
            Some(found) if found == mcp => match agent_setup::remove_mcp_entry(root) {
                Ok(true) => report.done.push(format!(
                    "Removed the \"{}\" server from {}",
                    mcp.server_key, mcp.path
                )),
                Ok(false) => {}
                Err(e) => report.failed.push((mcp.path.clone(), e.to_string())),
            },
            _ => report.failed.push((
                mcp.path.clone(),
                "not reported by the scan — the file was left alone".to_string(),
            )),
        }
    }

    for path in &plan.cut_block {
        if footprint.instructions.as_deref() != Some(path.as_str()) {
            report.failed.push((
                path.clone(),
                "not reported by the scan — the file was left alone".to_string(),
            ));
            continue;
        }
        match agent_setup::remove_instructions_block(Path::new(path)) {
            Ok(true) => report.done.push(format!("Cut the gavin block from {path}")),
            Ok(false) => {}
            Err(e) => report.failed.push((path.clone(), e.to_string())),
        }
    }

    Ok(report)
}

#[tauri::command]
pub fn scan_gavin_footprint(root_path: String) -> Result<GavinFootprint, String> {
    scan(Path::new(&root_path))
}

#[tauri::command]
pub fn remove_gavin_footprint(
    root_path: String,
    plan: RemovalPlan,
) -> Result<RemovalReport, String> {
    remove(Path::new(&root_path), &plan)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A root set up the way `setup_agent_integration` leaves one, plus
    /// the untracked odds and ends a real workspace accumulates.
    fn workspace(dir: &Path) {
        let gavin_root = dir.join(GAVIN_ROOT_DIR);
        std::fs::create_dir_all(gavin_root.join("plans").join("done")).unwrap();
        std::fs::create_dir_all(gavin_root.join("plans").join("archive")).unwrap();
        std::fs::write(gavin_root.join("plans").join("a.md"), "---\ntitle: A\n---\n").unwrap();
        std::fs::write(gavin_root.join("plans").join("b.md"), "---\ntitle: B\n---\n").unwrap();
        std::fs::write(gavin_root.join("plans").join("done").join("c.md"), "c").unwrap();
        std::fs::write(gavin_root.join("plans").join("archive").join("d.md"), "d").unwrap();
        std::fs::write(gavin_root.join("config.toml"), "name = \"Test\"\n").unwrap();

        for skill in ["gavin", "gavin-orchestrate", "gavin-resume", "gavin-develop"] {
            let d = dir.join(".claude").join("skills").join(skill);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("SKILL.md"), "skill").unwrap();
        }

        std::fs::write(
            dir.join(".mcp.json"),
            "{\n  \"mcpServers\": {\n    \"gavin\": {\n      \"command\": \"/bin/gavin-mcp\",\n      \"args\": []\n    },\n    \"other\": {\n      \"command\": \"/bin/other\"\n    }\n  }\n}\n",
        )
        .unwrap();

        std::fs::write(
            dir.join("CLAUDE.md"),
            "# Project\n\nMy own prose, which must survive.\n\n<!-- gavin:start -->\n## Gavin workspace\n\nblah\n<!-- gavin:end -->\n",
        )
        .unwrap();

        // Something of the user's that is not gavin's, anywhere.
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src").join("main.rs").as_path(), "fn main() {}").unwrap();
        std::fs::write(dir.join("README.md"), "readme").unwrap();
    }

    #[test]
    fn the_scan_reports_what_is_there_and_counts_cards_apart_from_the_archive() {
        let dir = tempfile::tempdir().unwrap();
        workspace(dir.path());

        let f = scan(dir.path()).unwrap();

        let gr = f.gavin_root.unwrap();
        // a.md, b.md and done/c.md -- not archive/d.md.
        assert_eq!(gr.cards, 3);
        assert_eq!(gr.archived, 1);
        assert_eq!(f.skills.len(), 4);
        assert!(f.skills.iter().all(|s| s.contains(".claude/skills/gavin")));
        assert_eq!(f.mcp.as_ref().unwrap().server_key, "gavin");
        assert!(f.instructions.unwrap().ends_with("CLAUDE.md"));
    }

    /// A step skill appears in no profile table -- compose_agent_prompt
    /// writes it on demand -- so a scan that only read the table would
    /// leave it behind.
    #[test]
    fn the_scan_finds_step_skills_that_are_in_no_table() {
        let dir = tempfile::tempdir().unwrap();
        workspace(dir.path());
        let extra = dir.path().join(".claude").join("skills").join("gavin-write-prd");
        std::fs::create_dir_all(&extra).unwrap();

        let f = scan(dir.path()).unwrap();

        assert!(f.skills.iter().any(|s| s.ends_with("gavin-write-prd")));
    }

    /// The same workspace on the opencode profile. The sweep is written
    /// against `gavin_install`, so it follows the profile table to a
    /// different skill root without being told -- but "follows for free"
    /// is exactly the kind of claim that stops being true the first time
    /// somebody hardcodes a path, so it is pinned rather than trusted.
    /// The agent definition rides along: it is a whole file gavin wrote,
    /// and leaving it behind would leave the workspace claiming a
    /// permission grant for a tool that is gone.
    fn opencode_workspace(dir: &Path) {
        let gavin_root = dir.join(GAVIN_ROOT_DIR);
        std::fs::create_dir_all(gavin_root.join("plans")).unwrap();
        std::fs::write(gavin_root.join("config.toml"), "[agent]\nprofile = \"opencode\"\n")
            .unwrap();
        for skill in ["gavin", "gavin-orchestrate", "gavin-resume", "gavin-develop"] {
            let d = dir.join(".opencode").join("skills").join(skill);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("SKILL.md"), "skill").unwrap();
        }
        let agent = dir.join(".opencode").join("agent");
        std::fs::create_dir_all(&agent).unwrap();
        std::fs::write(agent.join("gavin-commit.md"), "---\nmode: primary\n---\n").unwrap();
        std::fs::write(
            dir.join("opencode.json"),
            "{\n  \"mcp\": {\n    \"gavin\": { \"type\": \"local\", \"command\": [\"/bin/gavin-mcp\"] },\n    \"other\": { \"type\": \"local\", \"command\": [\"/bin/other\"] }\n  }\n}\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("AGENTS.md"),
            "# Project\n\n<!-- gavin:start -->\nblah\n<!-- gavin:end -->\n",
        )
        .unwrap();
    }

    #[test]
    fn the_scan_follows_the_profile_to_the_opencode_layout() {
        let dir = tempfile::tempdir().unwrap();
        opencode_workspace(dir.path());
        // A step skill, which appears in no table, and somebody else's
        // agent, which is not gavin's to remove.
        std::fs::create_dir_all(dir.path().join(".opencode/skills/gavin-write-prd")).unwrap();
        std::fs::create_dir_all(dir.path().join(".opencode/skills/my-own")).unwrap();
        std::fs::write(dir.path().join(".opencode/agent/mine.md"), "mine").unwrap();

        let f = scan(dir.path()).unwrap();

        assert_eq!(f.skills.len(), 5, "four table skills plus the step skill: {:?}", f.skills);
        assert!(f.skills.iter().all(|s| s.contains(".opencode/skills/gavin")));
        assert!(f.agent_file.as_ref().unwrap().ends_with(".opencode/agent/gavin-commit.md"));
        assert_eq!(f.mcp.as_ref().unwrap().path, dir.path().join("opencode.json").to_string_lossy());
        assert!(f.instructions.as_ref().unwrap().ends_with("AGENTS.md"));
        // Nothing of Claude Code's was invented, and nothing of the
        // user's was claimed.
        assert!(!f.skills.iter().any(|s| s.contains(".claude")));
        assert!(!f.skills.iter().any(|s| s.ends_with("my-own")));
        assert_ne!(f.agent_file.as_ref().unwrap(), &dir.path().join(".opencode/agent/mine.md").to_string_lossy().to_string());
    }

    /// The agent file is removable BECAUSE the scan reported it -- the
    /// same intersection every other path goes through. Without the
    /// entry in `removable_paths` the plan would name a file the
    /// remover then refuses, and the wizard would silently do less than
    /// it said.
    #[test]
    fn the_agent_file_is_trashed_when_the_plan_names_it() {
        let dir = tempfile::tempdir().unwrap();
        opencode_workspace(dir.path());
        let agent_file = dir.path().join(".opencode/agent/gavin-commit.md");
        std::fs::write(dir.path().join(".opencode/agent/mine.md"), "mine").unwrap();

        let report = remove(
            dir.path(),
            &RemovalPlan {
                trash: vec![agent_file.to_string_lossy().to_string()],
                strip_mcp_key: vec![],
                cut_block: vec![],
            },
        )
        .unwrap();

        assert!(report.failed.is_empty(), "{:?}", report.failed);
        assert!(!agent_file.exists());
        // Its neighbour, which gavin never wrote, is untouched.
        assert!(dir.path().join(".opencode/agent/mine.md").is_file());
    }

    /// A neighbouring skill that is not gavin's must never be offered.
    #[test]
    fn the_scan_leaves_someone_elses_skills_alone() {
        let dir = tempfile::tempdir().unwrap();
        workspace(dir.path());
        std::fs::create_dir_all(dir.path().join(".claude").join("skills").join("my-own")).unwrap();

        let f = scan(dir.path()).unwrap();

        assert!(!f.skills.iter().any(|s| s.ends_with("my-own")));
    }

    /// A screen asking permission to remove nothing is a step that can
    /// only be answered wrong.
    #[test]
    fn a_config_without_gavins_key_and_a_file_without_the_block_are_not_reported() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(GAVIN_ROOT_DIR)).unwrap();
        std::fs::write(dir.path().join(".mcp.json"), "{\"mcpServers\":{\"other\":{}}}").unwrap();
        std::fs::write(dir.path().join("CLAUDE.md"), "# Just prose\n").unwrap();

        let f = scan(dir.path()).unwrap();

        assert!(f.mcp.is_none());
        assert!(f.instructions.is_none());
        assert!(f.skills.is_empty());
    }

    #[test]
    fn the_scan_finds_nested_contexts_and_marks_the_outside_ones() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        workspace(dir.path());
        std::fs::create_dir_all(dir.path().join("api").join(GAVIN_DIR)).unwrap();
        std::fs::create_dir_all(outside.path().join(GAVIN_DIR)).unwrap();
        std::fs::write(
            dir.path().join(GAVIN_ROOT_DIR).join("config.toml"),
            format!("name = \"Test\"\nextra_contexts = [\"{}\"]\n", outside.path().display()),
        )
        .unwrap();

        let f = scan(dir.path()).unwrap();

        let inside: Vec<_> = f.contexts.iter().filter(|c| !c.outside).collect();
        let beyond: Vec<_> = f.contexts.iter().filter(|c| c.outside).collect();
        assert_eq!(inside.len(), 1);
        assert!(inside[0].path.ends_with("api/.gavin"));
        assert_eq!(beyond.len(), 1);
        assert!(beyond[0].path.starts_with(outside.path().to_string_lossy().as_ref()));
    }

    /// Mirrors gavin::scan_root: excluded and dot-prefixed directories
    /// are never descended into, so a `.gavin` buried in node_modules is
    /// somebody's vendored copy, not this workspace's context.
    #[test]
    fn scan_matches_the_daemons_walk() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(GAVIN_ROOT_DIR)).unwrap();
        std::fs::create_dir_all(dir.path().join("node_modules").join("pkg").join(GAVIN_DIR))
            .unwrap();
        std::fs::create_dir_all(dir.path().join(".hidden").join(GAVIN_DIR)).unwrap();

        let f = scan(dir.path()).unwrap();

        assert!(f.contexts.is_empty(), "{:?}", f.contexts);
    }

    #[test]
    fn trashing_the_gavin_root_leaves_the_repo_otherwise_intact() {
        let dir = tempfile::tempdir().unwrap();
        workspace(dir.path());
        let footprint = scan(dir.path()).unwrap();
        let plan = RemovalPlan {
            trash: vec![footprint.gavin_root.unwrap().path],
            ..Default::default()
        };

        let report = remove(dir.path(), &plan).unwrap();

        assert!(report.failed.is_empty(), "{:?}", report.failed);
        assert!(!dir.path().join(GAVIN_ROOT_DIR).exists());
        assert!(dir.path().join("src").join("main.rs").is_file());
        assert!(dir.path().join("README.md").is_file());
        assert!(dir.path().join(".claude").join("skills").join("gavin").is_dir());
        assert!(dir.path().join(".mcp.json").is_file());
        assert!(dir.path().join("CLAUDE.md").is_file());
    }

    #[test]
    fn stripping_the_mcp_key_keeps_every_other_server() {
        let dir = tempfile::tempdir().unwrap();
        workspace(dir.path());
        let footprint = scan(dir.path()).unwrap();
        let plan =
            RemovalPlan { strip_mcp_key: vec![footprint.mcp.clone().unwrap()], ..Default::default() };

        let report = remove(dir.path(), &plan).unwrap();

        assert!(report.failed.is_empty(), "{:?}", report.failed);
        let after: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join(".mcp.json")).unwrap())
                .unwrap();
        assert!(after["mcpServers"].get("gavin").is_none());
        assert_eq!(after["mcpServers"]["other"]["command"], "/bin/other");
        // Edited, never removed: the file belongs to every server in it.
        assert!(dir.path().join(".mcp.json").is_file());
    }

    /// Codex's config is TOML, and a hand-tuned one keeps its comments
    /// and key order -- the same promise the writer makes going in.
    #[test]
    fn stripping_the_mcp_key_preserves_a_toml_configs_formatting() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(GAVIN_ROOT_DIR)).unwrap();
        std::fs::write(
            dir.path().join(GAVIN_ROOT_DIR).join("config.toml"),
            "[agent]\nprofile = \"codex\"\n",
        )
        .unwrap();
        std::fs::create_dir_all(dir.path().join(".codex")).unwrap();
        let original = "# my notes\n[mcp_servers.other]\ncommand = \"x\"\n\n[mcp_servers.gavin]\ncommand = \"/bin/gavin-mcp\"\nargs = []\n";
        std::fs::write(dir.path().join(".codex").join("config.toml"), original).unwrap();

        let footprint = scan(dir.path()).unwrap();
        let plan =
            RemovalPlan { strip_mcp_key: vec![footprint.mcp.clone().unwrap()], ..Default::default() };
        let report = remove(dir.path(), &plan).unwrap();

        assert!(report.failed.is_empty(), "{:?}", report.failed);
        let after = std::fs::read_to_string(dir.path().join(".codex").join("config.toml")).unwrap();
        assert!(after.starts_with("# my notes\n"));
        assert!(after.contains("[mcp_servers.other]"));
        assert!(!after.contains("gavin"));
    }

    #[test]
    fn cutting_the_block_leaves_the_humans_own_prose_byte_identical() {
        let dir = tempfile::tempdir().unwrap();
        workspace(dir.path());
        let before = "# Project\n\nMy own prose, which must survive.\n";
        let footprint = scan(dir.path()).unwrap();
        let plan =
            RemovalPlan { cut_block: vec![footprint.instructions.clone().unwrap()], ..Default::default() };

        let report = remove(dir.path(), &plan).unwrap();

        assert!(report.failed.is_empty(), "{:?}", report.failed);
        assert_eq!(std::fs::read_to_string(dir.path().join("CLAUDE.md")).unwrap(), before);
    }

    /// The block first, prose after: the file must not start with the
    /// blank line the block left behind.
    #[test]
    fn cutting_a_leading_block_leaves_no_stray_newline() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(GAVIN_ROOT_DIR)).unwrap();
        std::fs::write(
            dir.path().join("CLAUDE.md"),
            "<!-- gavin:start -->\nblah\n<!-- gavin:end -->\n\n# Mine\n\nProse.\n",
        )
        .unwrap();

        let footprint = scan(dir.path()).unwrap();
        let plan = RemovalPlan {
            cut_block: vec![footprint.instructions.clone().unwrap()],
            ..Default::default()
        };
        remove(dir.path(), &plan).unwrap();

        assert_eq!(
            std::fs::read_to_string(dir.path().join("CLAUDE.md")).unwrap(),
            "# Mine\n\nProse.\n"
        );
    }

    #[test]
    fn a_declined_category_is_untouched() {
        let dir = tempfile::tempdir().unwrap();
        workspace(dir.path());
        let footprint = scan(dir.path()).unwrap();
        // Plans only: skills, MCP and the instructions block were all
        // declined.
        let plan = RemovalPlan {
            trash: vec![footprint.gavin_root.unwrap().path],
            ..Default::default()
        };

        remove(dir.path(), &plan).unwrap();

        assert!(dir.path().join(".claude").join("skills").join("gavin-resume").is_dir());
        let mcp = std::fs::read_to_string(dir.path().join(".mcp.json")).unwrap();
        assert!(mcp.contains("\"gavin\""));
        assert!(std::fs::read_to_string(dir.path().join("CLAUDE.md")).unwrap().contains("gavin:start"));
    }

    /// The plan is data from the frontend, and the screens it came from
    /// may be minutes old. A path the scan does not report cannot be
    /// removed however the plan asks.
    #[test]
    fn a_path_the_scan_did_not_report_cannot_be_removed() {
        let dir = tempfile::tempdir().unwrap();
        let bystander = tempfile::tempdir().unwrap();
        workspace(dir.path());
        std::fs::write(bystander.path().join("precious.txt"), "mine").unwrap();
        let plan = RemovalPlan {
            trash: vec![
                bystander.path().to_string_lossy().to_string(),
                dir.path().join("src").to_string_lossy().to_string(),
            ],
            ..Default::default()
        };

        let report = remove(dir.path(), &plan).unwrap();

        assert_eq!(report.failed.len(), 2);
        assert!(report.done.is_empty());
        assert!(bystander.path().join("precious.txt").is_file());
        assert!(dir.path().join("src").is_dir());
    }

    /// A permission error on one item must not leave the other five
    /// categories half-done with no way to tell which.
    #[test]
    fn one_failure_does_not_abort_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        workspace(dir.path());
        let footprint = scan(dir.path()).unwrap();
        let plan = RemovalPlan {
            trash: vec![
                "/nowhere/at/all".to_string(),
                footprint.gavin_root.unwrap().path,
                footprint.skills[0].clone(),
            ],
            strip_mcp_key: vec![footprint.mcp.clone().unwrap()],
            cut_block: vec![footprint.instructions.clone().unwrap()],
        };

        let report = remove(dir.path(), &plan).unwrap();

        assert_eq!(report.failed.len(), 1);
        assert_eq!(report.failed[0].0, "/nowhere/at/all");
        assert!(!dir.path().join(GAVIN_ROOT_DIR).exists());
        assert!(!std::fs::read_to_string(dir.path().join(".mcp.json")).unwrap().contains("gavin"));
        assert!(!std::fs::read_to_string(dir.path().join("CLAUDE.md")).unwrap().contains("gavin"));
    }

    #[test]
    fn a_missing_root_is_an_error_rather_than_an_empty_footprint() {
        assert!(scan(Path::new("/definitely/not/there")).is_err());
    }
}
