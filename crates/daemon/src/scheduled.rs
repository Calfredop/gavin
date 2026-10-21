//! Scheduled tasks on disk (v77, ADR 0010): the copies under
//! `.gavin-root/scheduled/` and their Run reports under `runs/`.
//!
//! A Scheduled task is a COPY of a task card, written as its own file
//! outside `plans/`, so the board and the tree never see it and the card
//! it came from is never touched. Its run state lives in `kanban.sqlite`
//! (`kanban.rs`); this module owns only the files.
//!
//! ```text
//! .gavin-root/scheduled/nightly-deps.md          the copy (committed)
//! .gavin-root/scheduled/runs/nightly-deps/       its reports (gitignored)
//!     20261021-090000.md                         the agent's Run report
//!     20261021-090000.raw.txt                    the terminal, saved at exit
//! ```

use crate::gavin::{
    body_start, confine_card_path, parse_frontmatter, plan_file_info, slug_title, write_plan_field,
    GAVIN_ROOT_DIR,
};
use protocol::scheduled::ScheduleRule;
use protocol::{CardKind, Complexity};
use std::path::{Path, PathBuf};

pub const SCHEDULED_DIR: &str = "scheduled";
pub const RUNS_DIR: &str = "runs";

/// Reports kept per task. The listing carries the same number of fires.
pub const REPORTS_KEPT: usize = protocol::scheduled::FIRES_LISTED;

/// Cap on what a report read hands back, for each of the two files. A
/// report is a page; a raw terminal is at most the screen's 500 rows of
/// scrollback. Anything past this is not something a person reads in a
/// pane, and the reply has to fit one wire line.
const MAX_REPORT_BYTES: u64 = 256 * 1024;

/// One copy as read off disk.
#[derive(Debug, Clone, PartialEq)]
pub struct Copy {
    pub path: PathBuf,
    pub name: String,
    pub title: String,
    pub agent: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub complexity: Option<String>,
    pub from: Option<String>,
    pub schedule: Option<String>,
    pub paused: bool,
    pub body: String,
}

impl Copy {
    /// The schedule, parsed: `Ok(None)` for a task with none.
    pub fn rule(&self) -> Result<Option<ScheduleRule>, String> {
        self.schedule.as_deref().map(ScheduleRule::parse).transpose()
    }
}

/// `<root>/.gavin-root/scheduled`.
pub fn scheduled_dir(root: &Path) -> PathBuf {
    root.join(GAVIN_ROOT_DIR).join(SCHEDULED_DIR)
}

/// The workspace root a copy's path belongs to.
pub fn root_of(path: &Path) -> Option<PathBuf> {
    Some(path.parent()?.parent()?.parent()?.to_path_buf())
}

/// Where a copy's reports go: `scheduled/runs/<name>/`.
pub fn runs_dir(path: &Path) -> PathBuf {
    let name = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    path.parent().unwrap_or(Path::new(".")).join(RUNS_DIR).join(name)
}

/// The report a fire stamped `stamp` asks its agent to write.
pub fn report_path(path: &Path, stamp: &str) -> PathBuf {
    runs_dir(path).join(format!("{stamp}.md"))
}

/// The saved terminal beside a report: `<stamp>.raw.txt`.
pub fn raw_path_for(report: &Path) -> PathBuf {
    let stem = report.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    report.with_file_name(format!("{stem}.raw.txt"))
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name != RUNS_DIR
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// A copy's path, checked: `<root>/.gavin-root/scheduled/<name>.md` for a
/// root this daemon has open, and nothing else. Every request that names a
/// copy goes through here, so none of them can be pointed at another file.
pub fn confine_scheduled_path(path: &Path, watched_roots: &[PathBuf]) -> anyhow::Result<PathBuf> {
    let refuse = || anyhow::anyhow!("not a Scheduled task: {}", path.display());
    if path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(refuse());
    }
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).ok_or_else(refuse)?;
    let stem = name.strip_suffix(".md").ok_or_else(refuse)?;
    if !valid_name(stem) {
        return Err(refuse());
    }
    let dir = path.parent().ok_or_else(refuse)?;
    let canonical_dir = protocol::canonical_path(dir).map_err(|_| refuse())?;
    let ours = watched_roots
        .iter()
        .any(|root| protocol::canonical_path(&scheduled_dir(root)).is_ok_and(|d| d == canonical_dir));
    if !ours {
        anyhow::bail!("not a Scheduled task of a workspace this daemon has open: {}", path.display());
    }
    // A committed symlink in the copy's place must not turn a write here
    // into a write somewhere else.
    if path.symlink_metadata().is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(refuse());
    }
    Ok(path.to_path_buf())
}

/// Reads one copy. Never fails on a malformed frontmatter -- that is a
/// copy with a title of its file name and no schedule -- only on a file
/// that cannot be read.
pub fn read_copy(path: &Path) -> anyhow::Result<Copy> {
    let content = std::fs::read_to_string(path)?;
    let fm = parse_frontmatter(&content);
    let get = |key: &str| {
        fm.fields
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let name = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let body = match body_start(&content) {
        Some(start) => content.lines().skip(start).collect::<Vec<_>>().join("\n"),
        None => String::new(),
    };
    Ok(Copy {
        path: path.to_path_buf(),
        title: get("title").unwrap_or_else(|| name.clone()),
        name,
        agent: get("agent"),
        model: get("model"),
        effort: get("effort"),
        complexity: get("complexity"),
        from: get("from"),
        schedule: get("schedule"),
        paused: get("paused").is_some_and(|v| v.eq_ignore_ascii_case("true")),
        body: body.trim_matches('\n').to_string(),
    })
}

/// Every copy in a workspace, by file name. A file that cannot be read
/// is left out rather than failing the list.
pub fn list_copies(root: &Path) -> Vec<Copy> {
    let Ok(entries) = std::fs::read_dir(scheduled_dir(root)) else { return Vec::new() };
    let mut copies: Vec<Copy> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .map(|e| e.path())
        .filter(|p| {
            p.extension().is_some_and(|e| e == "md")
                && p.file_stem().is_some_and(|s| valid_name(&s.to_string_lossy()))
        })
        .filter_map(|p| read_copy(&p).ok())
        .collect();
    copies.sort_by(|a, b| a.name.cmp(&b.name));
    copies
}

fn one_line(key: &str, value: &str) -> anyhow::Result<()> {
    if value.contains('\n') || value.contains('\r') {
        anyhow::bail!("{key} must be a single line");
    }
    Ok(())
}

/// Whether a schedule line is one `ScheduleRule` reads, as an error the
/// human can act on.
fn check_schedule(schedule: &str) -> anyhow::Result<String> {
    let rule = ScheduleRule::parse(schedule.trim()).map_err(|e| anyhow::anyhow!("schedule: {e}"))?;
    Ok(rule.to_line())
}

/// A free file name in the scheduled folder: `<stem>.md`, else
/// `<stem>-2.md`, `<stem>-3.md`, … A copy never overwrites another.
fn free_path(dir: &Path, stem: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.md"));
    if !first.exists() {
        return first;
    }
    (2..)
        .map(|n| dir.join(format!("{stem}-{n}.md")))
        .find(|p| !p.exists())
        .expect("an unbounded range finds a free name")
}

struct NewCopy<'a> {
    title: &'a str,
    from: Option<&'a str>,
    agent: Option<&'a str>,
    model: Option<&'a str>,
    effort: Option<&'a str>,
    complexity: Option<&'a str>,
    schedule: Option<&'a str>,
    body: &'a str,
}

fn write_new(root: &Path, stem: &str, copy: NewCopy) -> anyhow::Result<PathBuf> {
    let title = copy.title.trim();
    if title.is_empty() {
        anyhow::bail!("a Scheduled task needs a title");
    }
    one_line("title", title)?;
    let schedule = copy.schedule.map(str::trim).filter(|s| !s.is_empty()).map(check_schedule).transpose()?;
    let dir = scheduled_dir(root);
    std::fs::create_dir_all(&dir)?;
    if dir.symlink_metadata().is_ok_and(|m| m.file_type().is_symlink()) {
        anyhow::bail!("the scheduled folder is a symlink: {}", dir.display());
    }
    let path = free_path(&dir, stem);
    let mut content = String::from("---\n");
    content.push_str(&format!("title: {title}\n"));
    for (key, value) in [
        ("from", copy.from),
        ("agent", copy.agent),
        ("model", copy.model),
        ("effort", copy.effort),
        ("complexity", copy.complexity),
    ] {
        if let Some(v) = value.map(str::trim).filter(|v| !v.is_empty()) {
            one_line(key, v)?;
            content.push_str(&format!("{key}: {v}\n"));
        }
    }
    if let Some(s) = &schedule {
        content.push_str(&format!("schedule: {s}\n"));
    }
    content.push_str("paused: false\n---\n");
    let body = copy.body.trim_matches('\n');
    if !body.is_empty() {
        content.push_str(body);
        content.push('\n');
    }
    std::fs::write(&path, content)?;
    Ok(path)
}

/// Copies a task card into a new Scheduled task (ADR 0010). The card can
/// be anywhere a card lives -- on the board, in `done/`, archived -- and
/// is not touched. Its body and run settings are copied, `parent:` is
/// not, and `from:` names it. A plan or a note is refused.
pub fn create_from_card(
    root: &Path,
    card: &Path,
    schedule: Option<&str>,
    agent: Option<&str>,
) -> anyhow::Result<PathBuf> {
    let card = confine_card_path(card)?;
    let canonical_root = protocol::canonical_path(root)?;
    let canonical_card = protocol::canonical_path(&card)?;
    if !canonical_card.starts_with(&canonical_root) {
        anyhow::bail!("that card is not in this workspace: {}", card.display());
    }
    let content = std::fs::read_to_string(&card)?;
    let info = plan_file_info(&card, &content);
    match info.kind {
        CardKind::Task => {}
        CardKind::Plan => anyhow::bail!("plans can't be scheduled yet"),
        CardKind::Note => anyhow::bail!("only task cards can be scheduled"),
    }
    let body = match body_start(&content) {
        Some(start) => content.lines().skip(start).collect::<Vec<_>>().join("\n"),
        None => String::new(),
    };
    let stem = card.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let stem = if valid_name(&stem) { stem } else { slug_title(&info.title).unwrap_or_else(|| "task".into()) };
    write_new(
        root,
        &stem,
        NewCopy {
            title: &info.title,
            from: Some(&info.file_name),
            agent: agent.or(info.agent.as_deref()),
            model: info.model.as_deref(),
            effort: info.effort.as_deref(),
            complexity: info.complexity.map(|c| c.as_str()),
            schedule,
            body: &body,
        },
    )
}

/// A Scheduled task written from scratch ("New scheduled task").
pub fn create_blank(
    root: &Path,
    title: &str,
    body: &str,
    schedule: Option<&str>,
    agent: Option<&str>,
) -> anyhow::Result<PathBuf> {
    let stem = slug_title(title).unwrap_or_else(|| "scheduled-task".into());
    write_new(
        root,
        &stem,
        NewCopy {
            title,
            from: None,
            agent,
            model: None,
            effort: None,
            complexity: None,
            schedule,
            body,
        },
    )
}

/// Rewrites one field of a copy, every other byte left as it was. The
/// keys are the copy's own -- this is not `set_plan_field`, and a status
/// or a parent has no meaning here.
pub fn set_field(path: &Path, key: &str, value: &str) -> anyhow::Result<()> {
    let value = value.trim_matches(|c| c == ' ' || c == '\t');
    match key {
        "body" => return write_body(path, value),
        "title" => {
            let title = value.trim();
            if title.is_empty() {
                anyhow::bail!("a Scheduled task needs a title");
            }
            one_line(key, title)?;
            return write_plan_field(path, key, title);
        }
        "schedule" => {
            let line = if value.trim().is_empty() { String::new() } else { check_schedule(value)? };
            return write_plan_field(path, key, &line);
        }
        "paused" => {
            let v = match value.trim().to_ascii_lowercase().as_str() {
                "true" => "true",
                "false" | "" => "false",
                other => anyhow::bail!("paused must be true or false, got: {other}"),
            };
            return write_plan_field(path, key, v);
        }
        "complexity" => {
            let v = value.trim();
            if !v.is_empty() && Complexity::parse(v).is_none() {
                anyhow::bail!("invalid complexity value: {v}");
            }
        }
        "agent" | "model" | "effort" => {}
        other => anyhow::bail!("a Scheduled task has no field {other}"),
    }
    one_line(key, value)?;
    write_plan_field(path, key, value.trim())
}

/// Replaces everything after the frontmatter.
fn write_body(path: &Path, body: &str) -> anyhow::Result<()> {
    let content = std::fs::read_to_string(path)?;
    let head: Vec<&str> = match body_start(&content) {
        Some(start) => content.lines().take(start).collect(),
        None => anyhow::bail!("the task's frontmatter is not closed; fix it before editing the body"),
    };
    let mut out = head.join("\n");
    out.push('\n');
    let body = body.trim_matches('\n');
    if !body.is_empty() {
        out.push_str(body);
        out.push('\n');
    }
    std::fs::write(path, out)?;
    Ok(())
}

/// A second copy beside the first, under a free name. Its runs are its
/// own from nothing: the run state is keyed by path.
pub fn duplicate(path: &Path) -> anyhow::Result<PathBuf> {
    let content = std::fs::read_to_string(path)?;
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let dir = path.parent().ok_or_else(|| anyhow::anyhow!("no folder: {}", path.display()))?;
    let target = free_path(dir, &stem);
    std::fs::write(&target, content)?;
    Ok(target)
}

/// Removes a copy and every report it left.
pub fn delete(path: &Path) -> anyhow::Result<()> {
    let runs = runs_dir(path);
    if runs.symlink_metadata().is_ok_and(|m| m.is_dir()) {
        std::fs::remove_dir_all(&runs)?;
    } else if runs.symlink_metadata().is_ok() {
        std::fs::remove_file(&runs)?;
    }
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(anyhow::anyhow!("couldn't delete {}: {e}", path.display())),
    }
}

/// Keeps a task's newest `keep` runs: every file in its runs folder is
/// `<stamp>.md` or `<stamp>.raw.txt`, and the stamps sort in time order.
pub fn prune_runs(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let files: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let stamp = name.split('.').next()?.to_string();
            protocol::scheduled::valid_report_stamp(&stamp).then(|| (stamp, e.path()))
        })
        .collect();
    let mut stamps: Vec<&String> = files.iter().map(|(s, _)| s).collect();
    stamps.sort();
    stamps.dedup();
    if stamps.len() <= keep {
        return;
    }
    let cutoff = stamps[stamps.len() - keep].clone();
    for (stamp, path) in &files {
        if *stamp < cutoff {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// A report or raw file's text, capped, if it is a regular file inside
/// the task's runs folder. An agent writes the report, so a symlink in
/// its place is not followed.
pub fn read_run_file(path: &Path) -> Option<String> {
    use std::io::Read;
    let meta = path.symlink_metadata().ok()?;
    if !meta.file_type().is_file() {
        return None;
    }
    let file = std::fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(MAX_REPORT_BYTES).read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// The headline of a report, read from its opening bytes only.
pub fn report_headline(path: &Path) -> Option<String> {
    use std::io::Read;
    let meta = path.symlink_metadata().ok()?;
    if !meta.file_type().is_file() {
        return None;
    }
    let mut head = Vec::new();
    std::fs::File::open(path).ok()?.take(4096).read_to_end(&mut head).ok()?;
    protocol::scheduled::report_headline(&String::from_utf8_lossy(&head))
}

/// Saves a finished run's terminal beside its report and prunes the
/// task's folder to `REPORTS_KEPT` runs.
pub fn save_raw(report: &Path, text: &str) {
    let Some(dir) = report.parent() else { return };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let raw = raw_path_for(report);
    if raw.symlink_metadata().is_ok_and(|m| m.file_type().is_symlink()) {
        return;
    }
    if let Err(e) = std::fs::write(&raw, text) {
        eprintln!("failed to save the terminal of a scheduled run to {}: {e}", raw.display());
    }
    prune_runs(dir, REPORTS_KEPT);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        crate::gavin::init_gavin_root(dir.path(), "WS").unwrap();
        dir
    }

    fn card(root: &Path, rel: &str, content: &str) -> PathBuf {
        let path = root.join(GAVIN_ROOT_DIR).join("plans").join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn a_task_card_is_copied_with_its_run_settings_and_left_alone() {
        let ws = workspace();
        let original = "---\nkind: task\ntitle: Bump deps\nstatus: Done\nparent: big.md\nagent: codex\nmodel: o3\neffort: high\ncomplexity: simple\n---\nRun the bump.\n\nThen test.\n";
        let src = card(ws.path(), "done/bump-deps.md", original);
        let path =
            create_from_card(ws.path(), &src, Some("at=2026-10-21T09:00 every=1d"), None).unwrap();
        assert_eq!(path, scheduled_dir(ws.path()).join("bump-deps.md"));
        assert_eq!(std::fs::read_to_string(&src).unwrap(), original, "the card is untouched");

        let copy = read_copy(&path).unwrap();
        assert_eq!(copy.title, "Bump deps");
        assert_eq!(copy.from.as_deref(), Some("bump-deps.md"));
        assert_eq!(copy.agent.as_deref(), Some("codex"));
        assert_eq!(copy.model.as_deref(), Some("o3"));
        assert_eq!(copy.effort.as_deref(), Some("high"));
        assert_eq!(copy.complexity.as_deref(), Some("simple"));
        assert_eq!(copy.schedule.as_deref(), Some("at=2026-10-21T09:00 every=1d runs=inf"));
        assert!(!copy.paused);
        assert_eq!(copy.body, "Run the bump.\n\nThen test.");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("parent:") && !text.contains("status:"), "{text}");

        // Scheduled twice, it is two copies.
        let second = create_from_card(ws.path(), &src, None, Some("claude-code")).unwrap();
        assert_eq!(second, scheduled_dir(ws.path()).join("bump-deps-2.md"));
        assert_eq!(read_copy(&second).unwrap().agent.as_deref(), Some("claude-code"));
        assert_eq!(read_copy(&second).unwrap().schedule, None);
    }

    #[test]
    fn archived_cards_are_copied_too_and_plans_and_notes_are_refused() {
        let ws = workspace();
        let archived = card(ws.path(), "archive/old.md", "---\nkind: task\ntitle: Old\n---\nbody\n");
        assert!(create_from_card(ws.path(), &archived, None, None).is_ok());
        let plan = card(ws.path(), "p.md", "---\ntitle: P\n---\n- [ ] x\n");
        let err = create_from_card(ws.path(), &plan, None, None).unwrap_err().to_string();
        assert_eq!(err, "plans can't be scheduled yet");
        let note = card(ws.path(), "n.md", "---\nkind: note\ntitle: N\n---\n");
        assert!(create_from_card(ws.path(), &note, None, None).is_err());
    }

    #[test]
    fn a_card_from_another_workspace_or_a_bad_schedule_writes_nothing() {
        let ws = workspace();
        let other = workspace();
        let theirs = card(other.path(), "t.md", "---\nkind: task\ntitle: T\n---\n");
        assert!(create_from_card(ws.path(), &theirs, None, None).is_err());
        let ours = card(ws.path(), "t.md", "---\nkind: task\ntitle: T\n---\n");
        assert!(create_from_card(ws.path(), &ours, Some("at=tomorrow"), None).is_err());
        assert!(list_copies(ws.path()).is_empty());
    }

    #[test]
    fn fields_are_written_surgically_and_checked() {
        let ws = workspace();
        let path = create_blank(ws.path(), "Nightly check", "Look around.", None, None).unwrap();
        assert_eq!(path, scheduled_dir(ws.path()).join("nightly-check.md"));
        set_field(&path, "schedule", "every=2m at=2026-10-21T09:00 runs=3").unwrap();
        set_field(&path, "paused", "true").unwrap();
        set_field(&path, "agent", "codex").unwrap();
        set_field(&path, "body", "New prompt.\n\nTwo paragraphs.").unwrap();
        let copy = read_copy(&path).unwrap();
        assert_eq!(copy.schedule.as_deref(), Some("at=2026-10-21T09:00 every=2m runs=3"));
        assert!(copy.paused);
        assert_eq!(copy.agent.as_deref(), Some("codex"));
        assert_eq!(copy.body, "New prompt.\n\nTwo paragraphs.");

        set_field(&path, "agent", "").unwrap();
        set_field(&path, "schedule", "").unwrap();
        let copy = read_copy(&path).unwrap();
        assert_eq!(copy.agent, None);
        assert_eq!(copy.schedule, None, "unscheduled");
        assert_eq!(copy.title, "Nightly check");

        assert!(set_field(&path, "schedule", "at=2026-10-21T09:00 runs=2").is_err());
        assert!(set_field(&path, "status", "Done").is_err());
        assert!(set_field(&path, "parent", "x.md").is_err());
        assert!(set_field(&path, "title", "").is_err());
        assert!(set_field(&path, "complexity", "huge").is_err());
        assert!(set_field(&path, "paused", "maybe").is_err());
    }

    #[test]
    fn duplicate_and_delete_take_the_reports_with_them() {
        let ws = workspace();
        let path = create_blank(ws.path(), "T", "b", None, None).unwrap();
        let dup = duplicate(&path).unwrap();
        assert_eq!(dup, scheduled_dir(ws.path()).join("t-2.md"));
        assert_eq!(std::fs::read_to_string(&dup).unwrap(), std::fs::read_to_string(&path).unwrap());

        let report = report_path(&path, "20261021-090000");
        save_raw(&report, "terminal");
        std::fs::write(&report, "# Done\n").unwrap();
        assert_eq!(report_headline(&report).as_deref(), Some("Done"));
        delete(&path).unwrap();
        assert!(!path.exists());
        assert!(!runs_dir(&path).exists());
        assert!(dup.exists());
        assert_eq!(list_copies(ws.path()).len(), 1, "runs/ is not a copy");
    }

    #[test]
    fn a_tasks_folder_keeps_its_newest_runs_only() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..25 {
            let stamp = format!("20261021-0900{i:02}");
            std::fs::write(dir.path().join(format!("{stamp}.md")), "#").unwrap();
            std::fs::write(dir.path().join(format!("{stamp}.raw.txt")), "x").unwrap();
        }
        std::fs::write(dir.path().join("notes.txt"), "kept").unwrap();
        prune_runs(dir.path(), 20);
        let mut left: Vec<String> =
            std::fs::read_dir(dir.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into()).collect();
        left.sort();
        assert_eq!(left.len(), 41);
        assert_eq!(left[0], "20261021-090005.md");
        assert!(left.contains(&"notes.txt".to_string()));
    }

    #[test]
    fn only_a_copy_of_an_open_workspace_passes_confinement() {
        let ws = workspace();
        let path = create_blank(ws.path(), "T", "b", None, None).unwrap();
        let roots = vec![protocol::canonical_path(ws.path()).unwrap()];
        assert!(confine_scheduled_path(&path, &roots).is_ok());
        assert!(confine_scheduled_path(&path, &[]).is_err());
        let card = card(ws.path(), "c.md", "---\ntitle: C\n---\n");
        assert!(confine_scheduled_path(&card, &roots).is_err());
        let sneaky = scheduled_dir(ws.path()).join("..").join("config.toml");
        assert!(confine_scheduled_path(&sneaky, &roots).is_err());
        let runs = scheduled_dir(ws.path()).join("runs.md");
        assert!(confine_scheduled_path(&runs, &roots).is_err());
    }
}
