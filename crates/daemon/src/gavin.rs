use protocol::{
    CardKind, GavinContext, GavinContextKind, GavinTree, MdFileInfo, PlanFileInfo, Priority, Response,
};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

pub const GAVIN_ROOT_DIR: &str = ".gavin-root";
pub const GAVIN_DIR: &str = ".gavin";
const MAX_SCAN_DEPTH: usize = 12;
const EXCLUDED_DIRS: &[&str] =
    &[".git", "node_modules", "target", "dist", "build", ".venv", "venv", "__pycache__"];

const PRD_TEMPLATE: &str = "# {workspace} — Product Requirements\n\n\
> This PRD is the lead document for development in this workspace. The main agent\n\
> session reads it first; plans in `.gavin*/plans/` should trace back to it.\n\n\
## Vision\n\n_What are we building, for whom, and why?_\n\n\
## Current focus\n\n_The active goals, roughly ordered._\n\n\
## Out of scope\n\n_Explicit non-goals._\n";

const ROOT_CONFIG_TEMPLATE: &str = "version = 1\n\n[agent]\nprofile = \"claude-code\"\n";

/// Flat `key: value` frontmatter, parsed line-by-line. `fields` keeps only
/// the recognized pairs; anything else in the block is untouched by
/// parsing and preserved by `write_plan_status`, which edits lines, never
/// re-serializes.
struct Frontmatter {
    fields: Vec<(String, String)>,
    /// True iff the file has a complete (opened AND closed) block.
    present: bool,
    /// True iff an opening `---` was never closed before EOF.
    warning: bool,
}

fn parse_frontmatter(content: &str) -> Frontmatter {
    let mut lines = content.lines();
    if lines.next() != Some("---") {
        return Frontmatter { fields: vec![], present: false, warning: false };
    }
    let mut fields = Vec::new();
    for line in lines {
        if line == "---" {
            return Frontmatter { fields, present: true, warning: false };
        }
        if let Some((key, value)) = line.split_once(':') {
            let key = key.trim();
            if !key.is_empty()
                && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            {
                let mut value = value.trim();
                for quote in ['"', '\''] {
                    if value.len() >= 2 && value.starts_with(quote) && value.ends_with(quote) {
                        value = &value[1..value.len() - 1];
                        break;
                    }
                }
                fields.push((key.to_string(), value.to_string()));
            }
        }
    }
    // Opening marker, no closing marker before EOF.
    Frontmatter { fields: vec![], present: false, warning: true }
}

/// Strict, spelled-out match rather than Priority::from_str: from_str maps
/// every unrecognized value to Priority::None, which would make a typo'd
/// `priority: hgih` indistinguishable from a deliberate `priority: none` --
/// here the typo must surface as a parse warning instead.
fn parse_priority(value: &str) -> Option<Priority> {
    match value.to_ascii_lowercase().as_str() {
        "none" => Some(Priority::None),
        "low" => Some(Priority::Low),
        "medium" => Some(Priority::Medium),
        "high" => Some(Priority::High),
        "urgent" => Some(Priority::Urgent),
        _ => None,
    }
}

/// Builds a PlanFileInfo from a plan file's path and content. Never fails:
/// unreadable frontmatter degrades to status None + parse_warning (spec §4
/// -- an agent writing bad YAML must not be able to crash a scan).
pub fn plan_file_info(path: &Path, content: &str) -> PlanFileInfo {
    let fm = parse_frontmatter(content);
    let mut warning = fm.warning;
    let get = |key: &str| {
        fm.fields
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
            .filter(|v| !v.is_empty())
    };
    let file_name =
        path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let stem = path
        .file_stem()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| file_name.clone());
    let priority = match get("priority") {
        None => None,
        Some(raw) => {
            let parsed = parse_priority(&raw);
            if parsed.is_none() {
                warning = true;
            }
            parsed
        }
    };
    let order = match get("order") {
        None => None,
        Some(raw) => match raw.trim().parse::<i64>() {
            Ok(n) => Some(n),
            Err(_) => {
                warning = true;
                None
            }
        },
    };
    let kind = match get("kind") {
        None => CardKind::Plan,
        Some(raw) => match raw.to_ascii_lowercase().as_str() {
            "note" => CardKind::Note,
            "task" => CardKind::Task,
            "plan" => CardKind::Plan,
            _ => {
                warning = true;
                CardKind::Plan
            }
        },
    };
    // parent is only meaningful on tasks (card-model spec §1) -- set on
    // any other kind it degrades to a warning, never a hidden card.
    let parent = match get("parent") {
        None => None,
        Some(p) => {
            if kind == CardKind::Task {
                Some(p)
            } else {
                warning = true;
                None
            }
        }
    };
    let labels: Vec<String> = get("labels")
        .map(|raw| {
            raw.split(',')
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let (checklist_done, checklist_total) = checklist_counts(content);
    PlanFileInfo {
        path: path.to_string_lossy().to_string(),
        file_name,
        title: get("title").unwrap_or(stem),
        status: get("status"),
        priority,
        order,
        kind,
        parent,
        labels,
        checklist_done,
        checklist_total,
        parse_warning: warning,
    }
}

/// Counts `- [ ]` / `- [x]` lines (any indentation, requiring the
/// trailing space) in the BODY -- everything after the frontmatter's
/// closing marker; an unterminated block yields no body.
fn checklist_counts(content: &str) -> (u32, u32) {
    let mut lines = content.lines();
    if content.lines().next() == Some("---") {
        lines.next();
        let mut closed = false;
        for l in lines.by_ref() {
            if l == "---" {
                closed = true;
                break;
            }
        }
        if !closed {
            return (0, 0);
        }
    }
    let mut done = 0u32;
    let mut total = 0u32;
    for line in lines {
        let t = line.trim_start();
        if t.starts_with("- [ ] ") {
            total += 1;
        } else if t.starts_with("- [x] ") {
            total += 1;
            done += 1;
        }
    }
    (done, total)
}

/// Rewrites ONLY the `{key}:` line (spec §2): replace in place if present,
/// insert as the block's first line when the block lacks it, prepend a new
/// block when the file has none. Every other byte is preserved --
/// including the presence/absence of a trailing newline.
fn write_plan_field(path: &Path, key: &str, value: &str) -> anyhow::Result<()> {
    let content = std::fs::read_to_string(path)?;
    let had_trailing_newline = content.ends_with('\n');
    let lines: Vec<&str> = content.lines().collect();
    let mut out: Vec<String>;

    let fm = parse_frontmatter(&content);
    if fm.present {
        // Find the closing marker so we only touch lines inside the block.
        let close = lines.iter().skip(1).position(|l| *l == "---").map(|i| i + 1).unwrap();
        let field_line = lines[1..close]
            .iter()
            .position(|l| l.split_once(':').map(|(k, _)| k.trim() == key).unwrap_or(false))
            .map(|i| i + 1);
        out = lines.iter().map(|l| l.to_string()).collect();
        // Empty value = remove the line (nesting/un-parenting, card-model
        // spec §1); absent line -> no-op, the file stays untouched.
        if value.is_empty() {
            match field_line {
                Some(i) => {
                    out.remove(i);
                }
                None => return Ok(()),
            }
        } else {
            match field_line {
                Some(i) => out[i] = format!("{key}: {value}"),
                None => out.insert(1, format!("{key}: {value}")),
            }
        }
    } else if value.is_empty() {
        return Ok(());
    } else {
        out = vec!["---".to_string(), format!("{key}: {value}"), "---".to_string()];
        out.extend(lines.iter().map(|l| l.to_string()));
    }

    let mut rebuilt = out.join("\n");
    if had_trailing_newline || content.is_empty() {
        rebuilt.push('\n');
    }
    std::fs::write(path, rebuilt)?;
    Ok(())
}

const MAX_PRD_BYTES: u64 = 1024 * 1024;

pub fn read_prd(root: &Path) -> anyhow::Result<String> {
    let prd = root.join(GAVIN_ROOT_DIR).join("PRD.md");
    if !prd.is_file() {
        anyhow::bail!("no PRD found at {}", prd.display());
    }
    if std::fs::metadata(&prd)?.len() > MAX_PRD_BYTES {
        anyhow::bail!("PRD exceeds the 1 MB read cap");
    }
    Ok(std::fs::read_to_string(&prd)?)
}

/// Canonical plan authoring for agents (spec §2): everything validated,
/// nothing ever overwritten. Returns the created file's path.
pub fn create_plan_file(
    context_folder: &Path,
    file_name: &str,
    title: &str,
    status: Option<&str>,
    priority: Option<&str>,
    body: Option<&str>,
    kind: Option<&str>,
    parent: Option<&str>,
) -> anyhow::Result<PathBuf> {
    let kind = match kind {
        None => "plan",
        Some(k) if matches!(k, "note" | "task" | "plan") => k,
        Some(other) => anyhow::bail!("invalid kind value: {other}"),
    };
    if let Some(p) = parent {
        if kind != "task" {
            anyhow::bail!("parent requires kind task, got: {kind}");
        }
        let valid = p.len() > ".md".len()
            && p.ends_with(".md")
            && p.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
        if !valid {
            anyhow::bail!("parent must match [A-Za-z0-9._-]+.md, got: {p}");
        }
    }
    let gavin_dir = if context_folder.join(GAVIN_ROOT_DIR).is_dir() {
        context_folder.join(GAVIN_ROOT_DIR)
    } else if context_folder.join(GAVIN_DIR).is_dir() {
        context_folder.join(GAVIN_DIR)
    } else {
        anyhow::bail!(
            "not a gavin context (no .gavin or .gavin-root): {}",
            context_folder.display()
        );
    };

    let valid_name = file_name.len() > ".md".len()
        && file_name.ends_with(".md")
        && file_name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if !valid_name {
        anyhow::bail!("file_name must match [A-Za-z0-9._-]+.md, got: {file_name}");
    }

    let title = title.trim();
    if title.is_empty() || title.contains('\n') {
        anyhow::bail!("title must be a non-empty single line");
    }
    // A nested child (task with a parent) has no status by design (spec
    // §1's nesting rule); everything else defaults to "To Do".
    let status: Option<&str> = if kind == "task" && parent.is_some() && status.is_none() {
        None
    } else {
        Some(status.map(str::trim).filter(|s| !s.is_empty()).unwrap_or("To Do"))
    };
    if status.is_some_and(|s| s.contains('\n')) {
        anyhow::bail!("status must be a single line");
    }
    if let Some(p) = priority {
        if parse_priority(p).is_none() {
            anyhow::bail!("invalid priority value: {p}");
        }
    }

    let plans = gavin_dir.join("plans");
    std::fs::create_dir_all(&plans)?;
    let path = plans.join(file_name);
    if path.exists() {
        anyhow::bail!("plan file already exists: {}", path.display());
    }

    let mut content = String::from("---\n");
    if kind != "plan" {
        content.push_str(&format!("kind: {kind}\n"));
    }
    content.push_str(&format!("title: {title}\n"));
    if let Some(s) = status {
        content.push_str(&format!("status: {s}\n"));
    }
    if let Some(p) = parent {
        content.push_str(&format!("parent: {p}\n"));
    }
    if let Some(p) = priority {
        content.push_str(&format!("priority: {p}\n"));
    }
    content.push_str("---\n");
    match body.map(str::trim).filter(|b| !b.is_empty()) {
        Some(b) => {
            content.push_str(b);
            content.push('\n');
        }
        None => content.push_str(&format!("# {title}\n")),
    }
    std::fs::write(&path, content)?;
    Ok(path)
}

/// The public, validated entry point (and the future MCP tool body). The
/// allow-list is enforced HERE, not trusted to callers -- this must never
/// become an arbitrary-line writer.
pub fn set_plan_field(path: &Path, key: &str, value: &str) -> anyhow::Result<()> {
    // Empty value removes the line -- permitted only where the card model
    // needs it (status: nesting, parent: un-parenting, labels: clearing).
    if value.is_empty() {
        match key {
            "status" | "parent" | "labels" => return write_plan_field(path, key, value),
            other => anyhow::bail!("empty value not allowed for: {other}"),
        }
    }
    match key {
        "status" => {} // free text
        "priority" => {
            if parse_priority(value).is_none() {
                anyhow::bail!("invalid priority value: {value}");
            }
        }
        "order" => {
            if value.trim().parse::<i64>().is_err() {
                anyhow::bail!("order must be an integer: {value}");
            }
        }
        "title" => {
            if value.trim().is_empty() || value.contains('\n') {
                anyhow::bail!("title must be a non-empty single line");
            }
        }
        "kind" => {
            if !matches!(value, "note" | "task" | "plan") {
                anyhow::bail!("invalid kind value: {value}");
            }
        }
        "parent" => {
            let valid = value.len() > ".md".len()
                && value.ends_with(".md")
                && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
            if !valid {
                anyhow::bail!("parent must match [A-Za-z0-9._-]+.md, got: {value}");
            }
        }
        "labels" => {
            if value.contains('\n') {
                anyhow::bail!("labels must be a single line");
            }
        }
        other => anyhow::bail!("field not allowed: {other}"),
    }
    write_plan_field(path, key, value)
}

/// Splits a checkbox line into (prefix "  - [", mark ' '|'x', rest after
/// "] "). None when the line isn't a checklist item.
fn split_checklist_line(line: &str) -> Option<(usize, char, &str)> {
    let trimmed_start = line.len() - line.trim_start().len();
    let t = &line[trimmed_start..];
    let mark = if t.starts_with("- [ ] ") {
        ' '
    } else if t.starts_with("- [x] ") {
        'x'
    } else {
        return None;
    };
    Some((trimmed_start, mark, &t["- [x] ".len()..]))
}

/// True when a checklist item's text is already a promotion link:
/// `[text](./file.md)`.
fn checklist_link_target(text: &str) -> Option<&str> {
    let inner = text.strip_prefix('[')?;
    let close = inner.find("](")?;
    let target = &inner[close + 2..];
    let target = target.strip_suffix(')')?;
    let target = target.strip_prefix("./").unwrap_or(target);
    let valid = target.len() > ".md".len()
        && target.ends_with(".md")
        && target.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if valid { Some(target) } else { None }
}

/// Rewrites exactly one checklist line's checkbox mark (card-model spec
/// §3). `expected_text` must equal the line's raw remainder -- a
/// mismatch means the file changed under the UI (an agent edit) and the
/// caller must re-read and retry deliberately. Every other byte is
/// preserved.
pub fn set_checklist_item(
    path: &Path,
    line_index: u32,
    expected_text: &str,
    checked: bool,
) -> anyhow::Result<()> {
    let content = std::fs::read_to_string(path)?;
    let had_trailing_newline = content.ends_with('\n');
    let mut lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();
    let i = line_index as usize;
    let line = lines.get(i).ok_or_else(|| anyhow::anyhow!("line {line_index} out of range"))?;
    let (indent, _mark, rest) = split_checklist_line(line)
        .ok_or_else(|| anyhow::anyhow!("line {line_index} is not a checklist item"))?;
    if rest != expected_text {
        anyhow::bail!("checklist item changed on disk — expected {expected_text:?}, found {rest:?}");
    }
    let mark = if checked { 'x' } else { ' ' };
    lines[i] = format!("{}- [{}] {}", &line[..indent], mark, rest);
    let mut rebuilt = lines.join("\n");
    if had_trailing_newline || content.is_empty() {
        rebuilt.push('\n');
    }
    std::fs::write(path, rebuilt)?;
    Ok(())
}

/// The daemon-side slug for promoted-task file names (mirrors the
/// frontend's slugFileName): lowercase, non-alphanumeric runs -> "-".
fn slug_title(title: &str) -> Option<String> {
    let mut slug = String::new();
    let mut last_dash = true;
    for c in title.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() { None } else { Some(slug) }
}

/// Promotes a plan's checklist item into a nested task card (card-model
/// spec §3): creates `<slug>.md` (kind task, parent set, no status ->
/// nested) in the plan's own plans/ folder, then rewrites ONLY that
/// checklist line to `- [<mark>] [item](./<file>)`. The item must match
/// exactly one unpromoted line; ambiguity or absence errors with no
/// writes. Returns the created file's path.
pub fn promote_checklist_item(plan_path: &Path, item: &str) -> anyhow::Result<PathBuf> {
    let content = std::fs::read_to_string(plan_path)?;
    let had_trailing_newline = content.ends_with('\n');
    let lines: Vec<&str> = content.lines().collect();

    let mut matches = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if let Some((_indent, _mark, rest)) = split_checklist_line(line) {
            if rest == item && checklist_link_target(rest).is_none() {
                matches.push(i);
            }
        }
    }
    match matches.len() {
        0 => anyhow::bail!("no unpromoted checklist item matches: {item}"),
        1 => {}
        n => anyhow::bail!("ambiguous: {n} checklist items match: {item}"),
    }
    let line_index = matches[0];

    // The plan's folder must be a `.gavin*/plans/`; the context folder is
    // its grandparent's parent.
    let plans_dir = plan_path
        .parent()
        .filter(|d| d.file_name().is_some_and(|n| n == "plans"))
        .ok_or_else(|| anyhow::anyhow!("not a plans/ file: {}", plan_path.display()))?;
    let gavin_dir = plans_dir
        .parent()
        .filter(|d| d.file_name().is_some_and(|n| n.to_string_lossy().starts_with(".gavin")))
        .ok_or_else(|| anyhow::anyhow!("not inside a .gavin* folder: {}", plan_path.display()))?;
    let context_folder = gavin_dir
        .parent()
        .ok_or_else(|| anyhow::anyhow!("no context folder above {}", gavin_dir.display()))?;

    let slug = slug_title(item)
        .ok_or_else(|| anyhow::anyhow!("item text has no usable characters for a file name: {item}"))?;
    let mut file_name = format!("{slug}.md");
    let mut n = 2;
    while plans_dir.join(&file_name).exists() {
        file_name = format!("{slug}-{n}.md");
        n += 1;
    }

    let plan_file_name = plan_path
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .ok_or_else(|| anyhow::anyhow!("plan path has no file name"))?;
    let created = create_plan_file(
        context_folder,
        &file_name,
        item,
        None,
        None,
        Some(item),
        Some("task"),
        Some(&plan_file_name),
    )?;

    let line = lines[line_index];
    let (indent, mark, _rest) = split_checklist_line(line).unwrap();
    let mut out: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
    out[line_index] = format!("{}- [{}] [{}](./{})", &line[..indent], mark, item, file_name);
    let mut rebuilt = out.join("\n");
    if had_trailing_newline || content.is_empty() {
        rebuilt.push('\n');
    }
    std::fs::write(plan_path, rebuilt)?;
    Ok(created)
}

/// Deletes a card file (card-model delete design). Guarded: the path
/// must live directly inside a `.gavin*/plans/` folder -- this must
/// never become a general file deleter. Missing file errors (the caller
/// should know its picture is stale).
pub fn delete_card_file(path: &Path) -> anyhow::Result<()> {
    let plans_dir = path
        .parent()
        .filter(|d| d.file_name().is_some_and(|n| n == "plans"))
        .ok_or_else(|| anyhow::anyhow!("not a plans/ file: {}", path.display()))?;
    plans_dir
        .parent()
        .filter(|d| d.file_name().is_some_and(|n| n.to_string_lossy().starts_with(".gavin")))
        .ok_or_else(|| anyhow::anyhow!("not inside a .gavin* folder: {}", path.display()))?;
    if path.extension().is_none_or(|e| e != "md") {
        anyhow::bail!("not a card file: {}", path.display());
    }
    std::fs::remove_file(path)
        .map_err(|e| anyhow::anyhow!("couldn't delete {}: {e}", path.display()))
}

/// A context's display name from its config.toml. The bool is
/// config_warning: false for a missing file (absent config is normal),
/// true only when the file exists but doesn't parse as TOML.
fn parse_context_name(config_path: &Path) -> (Option<String>, bool) {
    let content = match std::fs::read_to_string(config_path) {
        Ok(c) => c,
        Err(_) => return (None, false),
    };
    match content.parse::<toml::Table>() {
        Ok(table) => {
            let name = table.get("name").and_then(|v| v.as_str()).map(|s| s.to_string());
            (name, false)
        }
        Err(_) => (None, true),
    }
}

fn scaffold_gavin_dir(gavin_dir: &Path) -> anyhow::Result<()> {
    for sub in ["plans", "docs", "specs"] {
        let dir = gavin_dir.join(sub);
        std::fs::create_dir_all(&dir)?;
        let keep = dir.join(".gitkeep");
        if !keep.exists() {
            std::fs::write(&keep, "")?;
        }
    }
    Ok(())
}

/// Never overwrites: each piece is created only if missing, so this both
/// completes a partial skeleton and no-ops on a complete one (spec §4).
pub fn init_gavin_root(root: &Path, workspace_name: &str) -> anyhow::Result<()> {
    if !root.is_dir() {
        anyhow::bail!("root does not exist or is not a directory: {}", root.display());
    }
    let gavin_dir = root.join(GAVIN_ROOT_DIR);
    std::fs::create_dir_all(&gavin_dir)?;
    scaffold_gavin_dir(&gavin_dir)?;
    let config = gavin_dir.join("config.toml");
    if !config.exists() {
        std::fs::write(&config, ROOT_CONFIG_TEMPLATE)?;
    }
    let prd = gavin_dir.join("PRD.md");
    if !prd.exists() {
        std::fs::write(&prd, PRD_TEMPLATE.replace("{workspace}", workspace_name))?;
    }
    Ok(())
}

pub fn create_gavin_context(parent: &Path) -> anyhow::Result<()> {
    if !parent.is_dir() {
        anyhow::bail!("parent does not exist or is not a directory: {}", parent.display());
    }
    let gavin_dir = parent.join(GAVIN_DIR);
    std::fs::create_dir_all(&gavin_dir)?;
    scaffold_gavin_dir(&gavin_dir)?;
    let config = gavin_dir.join("config.toml");
    if !config.exists() {
        let name = parent.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        std::fs::write(&config, format!("name = \"{name}\"\n"))?;
    }
    Ok(())
}

fn list_md_files(dir: &Path) -> Vec<MdFileInfo> {
    fn walk(dir: &Path, base: &Path, out: &mut Vec<MdFileInfo>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, base, out);
            } else if path.extension().map(|e| e == "md").unwrap_or(false) {
                out.push(MdFileInfo {
                    path: path.to_string_lossy().to_string(),
                    rel_path: path
                        .strip_prefix(base)
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .to_string(),
                });
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out);
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    out
}

fn build_context(folder: &Path, gavin_dir: &Path, kind: GavinContextKind) -> GavinContext {
    let (config_name, config_warning) = parse_context_name(&gavin_dir.join("config.toml"));
    let folder_name =
        folder.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let plans = list_md_files(&gavin_dir.join("plans"))
        .into_iter()
        .map(|md| {
            let path = PathBuf::from(&md.path);
            let content = std::fs::read_to_string(&path).unwrap_or_default();
            plan_file_info(&path, &content)
        })
        .collect();
    GavinContext {
        folder_path: folder.to_string_lossy().to_string(),
        kind: kind.clone(),
        name: config_name.unwrap_or(folder_name),
        plans,
        docs: list_md_files(&gavin_dir.join("docs")),
        specs: list_md_files(&gavin_dir.join("specs")),
        has_prd: matches!(kind, GavinContextKind::Root) && gavin_dir.join("PRD.md").is_file(),
        config_warning,
    }
}

/// Full scan of one bound root (spec §3). Never fails: a missing root
/// yields `root_missing: true` with no contexts.
pub fn scan_root(root: &Path) -> GavinTree {
    let root_str = root.to_string_lossy().to_string();
    if !root.is_dir() {
        return GavinTree { root_path: root_str, root_missing: true, contexts: vec![] };
    }

    let mut contexts = Vec::new();
    // Root context: `.gavin-root` recognized ONLY directly under the root.
    let root_gavin = root.join(GAVIN_ROOT_DIR);
    let root_has_gavin_root = root_gavin.is_dir();
    if root_has_gavin_root {
        contexts.push(build_context(root, &root_gavin, GavinContextKind::Root));
    }

    fn walk(
        dir: &Path,
        depth: usize,
        skip_gavin_here: bool,
        contexts: &mut Vec<GavinContext>,
    ) {
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
            // A deep `.gavin-root` is ignored entirely (spec §1 edge rules);
            // `.gavin` marks its PARENT as a context, and the walker never
            // descends into `.gavin*` directories themselves.
            if name == GAVIN_DIR {
                if !skip_gavin_here {
                    contexts.push(build_context(dir, &path, GavinContextKind::Context));
                }
                continue;
            }
            if name == GAVIN_ROOT_DIR
                || EXCLUDED_DIRS.contains(&name.as_str())
                || name.starts_with('.')
            {
                continue;
            }
            walk(&path, depth + 1, false, contexts);
        }
    }
    // Depth 1 = the root's immediate children. skip_gavin_here applies the
    // spec §1 both-markers rule to the root level only: when `.gavin-root`
    // exists, a root-level `.gavin` is ignored rather than double-listing
    // the root folder as two contexts.
    walk(root, 1, root_has_gavin_root, &mut contexts);

    // Root context first, then by folder path.
    contexts.sort_by(|a, b| {
        let a_root = matches!(a.kind, GavinContextKind::Root);
        let b_root = matches!(b.kind, GavinContextKind::Root);
        b_root.cmp(&a_root).then(a.folder_path.cmp(&b.folder_path))
    });
    GavinTree { root_path: root_str, root_missing: false, contexts }
}

const RESCAN_DEBOUNCE: Duration = Duration::from_millis(500);
/// Floor between two full rescans, sleeping out the remainder rather than
/// skipping -- the RepoPoller lesson: without a floor, sustained
/// working-tree churn (a build, an install) can drive the debouncer to
/// flush every 500ms indefinitely.
const MIN_RESCAN_INTERVAL: Duration = Duration::from_secs(2);

struct WatcherInner {
    last_tree: Option<GavinTree>,
    last_scan: Option<Instant>,
}

/// One per watched workspace root. Owns the debouncer; dropping the
/// watcher shuts the watch thread down -- which is exactly why the
/// debouncer callback must hold a Weak, not an Arc (the RepoPoller
/// reference-cycle Critical: a strong Arc in the callback would keep
/// `drop` from ever running, leaking the watch thread and OS watches for
/// the daemon's lifetime).
pub struct GavinWatcher {
    pub workspace_id: String,
    pub root_path: PathBuf,
    writer: Arc<Mutex<UnixStream>>,
    inner: Mutex<WatcherInner>,
    debouncer: Mutex<Option<notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>>>,
}

impl GavinWatcher {
    /// Creates the watcher, performs the initial scan, pushes the initial
    /// GavinTreeChanged, and starts the filesystem watch. Watch-setup
    /// failure degrades to scan-on-demand (spec §4): the initial push
    /// still happens and GetGavinTree still works.
    pub fn start(
        workspace_id: String,
        root_path: PathBuf,
        writer: Arc<Mutex<UnixStream>>,
    ) -> Arc<Self> {
        // Canonicalize before watching: FSEvents resolves symlinks, and a
        // watch registered on a symlinked spelling (macOS's /tmp and
        // /var/folders both live under /private) can silently never see
        // its own events. A missing root can't canonicalize -- keep the
        // given path so scan_root still reports root_missing for it.
        let root_path = root_path.canonicalize().unwrap_or(root_path);
        let watcher = Arc::new(GavinWatcher {
            workspace_id,
            root_path,
            writer,
            inner: Mutex::new(WatcherInner { last_tree: None, last_scan: None }),
            debouncer: Mutex::new(None),
        });

        // Arm the watch BEFORE the initial scan+push -- the daemon-side
        // twin of the Milestone B "event emitted before the listener
        // exists" race: FSEvents only reports changes made after the
        // stream starts, so a client that reacts to the initial push by
        // touching a file could otherwise race the stream startup and
        // have that change silently missed forever. Arming first closes
        // the window; a change landing between arming and the initial
        // scan just triggers a rescan that change-gating dedupes.
        let weak: Weak<GavinWatcher> = Arc::downgrade(&watcher);
        let debounce_result = notify_debouncer_mini::new_debouncer(
            RESCAN_DEBOUNCE,
            move |res: notify_debouncer_mini::DebounceEventResult| {
                // After teardown (last strong Arc dropped), upgrade()
                // returns None and this is a silent no-op.
                let Some(watcher) = weak.upgrade() else { return };
                let Ok(events) = res else { return };
                // Only events touching a `.gavin*` path segment (which
                // includes creating/removing the marker dirs themselves)
                // schedule a rescan -- everything else in the tree churns
                // freely without cost. An event AT the root itself (the
                // root renamed away or back) must also count: the spec's
                // root_missing push depends on it, and the segment check
                // alone can never match the root's own path (found live by
                // the wire-level smoke test, not by any unit test).
                let relevant = events.iter().any(|e| {
                    e.path == watcher.root_path
                        || e.path.components().any(|c| {
                            let s = c.as_os_str().to_string_lossy();
                            s == GAVIN_DIR || s == GAVIN_ROOT_DIR
                        })
                });
                if relevant {
                    watcher.rescan_and_push();
                }
            },
        );
        if let Ok(mut d) = debounce_result {
            if d.watcher().watch(&watcher.root_path, notify::RecursiveMode::Recursive).is_ok() {
                *watcher.debouncer.lock().unwrap() = Some(d);
            }
        }

        watcher.rescan_and_push();
        watcher
    }

    /// The entire floor-check + scan + compare + emit sequence runs under
    /// one lock (the HeuristicState lesson): two debouncer flushes, or a
    /// flush racing the initial scan, can never interleave into an
    /// out-of-order emission.
    pub fn rescan_and_push(&self) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(last) = inner.last_scan {
            let elapsed = last.elapsed();
            if elapsed < MIN_RESCAN_INTERVAL {
                std::thread::sleep(MIN_RESCAN_INTERVAL - elapsed);
            }
        }
        let tree = scan_root(&self.root_path);
        inner.last_scan = Some(Instant::now());
        if inner.last_tree.as_ref() == Some(&tree) {
            return; // change-gated: identical trees never re-emit
        }
        inner.last_tree = Some(tree.clone());
        let response =
            Response::GavinTreeChanged { workspace_id: self.workspace_id.clone(), tree };
        // A dead writer (app restarted) fails silently; the next
        // WatchGavinRoot from the fresh connection replaces this watcher.
        let mut writer = self.writer.lock().unwrap();
        let _ = protocol::write_message(&mut *writer, &response);
    }

    /// Best-effort push on the watching app connection -- same
    /// dead-writer semantics as rescan_and_push (a restarted app's fresh
    /// WatchGavinRoot replaces this watcher).
    pub fn push_response(&self, resp: &Response) {
        let mut writer = self.writer.lock().unwrap();
        let _ = protocol::write_message(&mut *writer, resp);
    }

    /// Fresh scan for GetGavinTree -- shares the floor/dedup state so a
    /// snapshot request can't defeat MIN_RESCAN_INTERVAL, but always
    /// returns a tree (even when unchanged).
    pub fn snapshot(&self) -> GavinTree {
        let mut inner = self.inner.lock().unwrap();
        if let (Some(last), Some(tree)) = (inner.last_scan, &inner.last_tree) {
            if last.elapsed() < MIN_RESCAN_INTERVAL {
                return tree.clone();
            }
        }
        let tree = scan_root(&self.root_path);
        inner.last_scan = Some(Instant::now());
        inner.last_tree = Some(tree.clone());
        tree
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(content: &str) -> PlanFileInfo {
        plan_file_info(Path::new("/tmp/plans/auth-flow.md"), content)
    }

    #[test]
    fn plan_with_full_frontmatter_parses_all_fields() {
        let p = plan("---\nstatus: In Progress\npriority: high\ntitle: Auth rework\n---\n# body\n");
        assert_eq!(p.status.as_deref(), Some("In Progress"));
        assert_eq!(p.priority, Some(Priority::High));
        assert_eq!(p.title, "Auth rework");
        assert!(!p.parse_warning);
    }

    #[test]
    fn plan_without_frontmatter_gets_stem_title_and_no_status() {
        let p = plan("# just a heading\n");
        assert_eq!(p.status, None);
        assert_eq!(p.title, "auth-flow");
        assert!(!p.parse_warning);
    }

    #[test]
    fn unterminated_frontmatter_sets_parse_warning() {
        let p = plan("---\nstatus: To Do\nno closing marker\n");
        assert_eq!(p.status, None);
        assert!(p.parse_warning);
    }

    #[test]
    fn quoted_values_are_unquoted_and_unknown_priority_warns() {
        let p = plan("---\nstatus: \"Review\"\npriority: banana\n---\n");
        assert_eq!(p.status.as_deref(), Some("Review"));
        assert_eq!(p.priority, None);
        assert!(p.parse_warning);
    }

    #[test]
    fn plan_kind_parses_defaults_and_flags_garbage() {
        assert_eq!(plan("---\ntitle: A\n---\n").kind, CardKind::Plan);
        assert_eq!(plan("---\nkind: note\n---\n").kind, CardKind::Note);
        assert_eq!(plan("---\nkind: task\n---\n").kind, CardKind::Task);
        let bad = plan("---\nkind: epic\n---\n");
        assert_eq!(bad.kind, CardKind::Plan);
        assert!(bad.parse_warning);
    }

    #[test]
    fn parent_only_lives_on_tasks() {
        let t = plan("---\nkind: task\nparent: auth.md\n---\n");
        assert_eq!(t.parent.as_deref(), Some("auth.md"));
        assert!(!t.parse_warning);
        let n = plan("---\nkind: note\nparent: auth.md\n---\n");
        assert_eq!(n.parent, None);
        assert!(n.parse_warning);
    }

    #[test]
    fn labels_split_and_trim() {
        assert_eq!(plan("---\nlabels: bug,  ui , \n---\n").labels, vec!["bug", "ui"]);
        assert!(plan("---\ntitle: A\n---\n").labels.is_empty());
    }

    #[test]
    fn checklist_counts_from_body() {
        let p = plan("---\nkind: plan\n---\n# P\n- [ ] one\n  - [x] nested\n- [x] two\nnot - [ ] a list\n");
        assert_eq!((p.checklist_done, p.checklist_total), (2, 3));
        // No frontmatter: the whole file is body. Unterminated: no body.
        assert_eq!(plan("- [ ] a\n").checklist_total, 1);
        assert_eq!(plan("---\nstatus: x\n- [ ] a\n").checklist_total, 0);
    }

    #[test]
    fn plan_order_parses_integer_and_flags_garbage() {
        let ok = plan("---\ntitle: A\norder: 2048\n---\n");
        assert_eq!(ok.order, Some(2048));
        assert!(!ok.parse_warning);

        let none = plan("---\ntitle: A\n---\n");
        assert_eq!(none.order, None);
        assert!(!none.parse_warning);

        let bad = plan("---\ntitle: A\norder: soon\n---\n");
        assert_eq!(bad.order, None);
        assert!(bad.parse_warning);
    }

    #[test]
    fn empty_value_removes_the_line_for_status_parent_labels() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.md");
        std::fs::write(&path, "---\ntitle: T\nkind: task\nstatus: To Do\nparent: a.md\nlabels: x\n---\nbody\n")
            .unwrap();
        set_plan_field(&path, "status", "").unwrap();
        set_plan_field(&path, "parent", "").unwrap();
        set_plan_field(&path, "labels", "").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "---\ntitle: T\nkind: task\n---\nbody\n"
        );
        // Absent line -> no-op, no error, file untouched:
        set_plan_field(&path, "status", "").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "---\ntitle: T\nkind: task\n---\nbody\n"
        );
        assert!(set_plan_field(&path, "title", "").is_err());
        assert!(set_plan_field(&path, "priority", "").is_err());
    }

    #[test]
    fn kind_and_parent_values_are_validated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.md");
        std::fs::write(&path, "---\ntitle: T\n---\n").unwrap();
        assert!(set_plan_field(&path, "kind", "epic").is_err());
        assert!(set_plan_field(&path, "parent", "../evil.md").is_err());
        assert!(set_plan_field(&path, "parent", "no-md").is_err());
        assert!(set_plan_field(&path, "labels", "a\nb").is_err());
        set_plan_field(&path, "kind", "task").unwrap();
        set_plan_field(&path, "parent", "plan-1.md").unwrap();
        set_plan_field(&path, "labels", "bug, ui").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "---\nlabels: bug, ui\nparent: plan-1.md\nkind: task\ntitle: T\n---\n"
        );
    }

    #[test]
    fn set_plan_field_accepts_integer_order_and_rejects_garbage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.md");
        std::fs::write(&path, "---\ntitle: T\nstatus: To Do\n---\nbody\n").unwrap();
        assert!(set_plan_field(&path, "order", "1.5").is_err());
        assert!(set_plan_field(&path, "order", "soon").is_err());
        // Neither failed call may touch the file:
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "---\ntitle: T\nstatus: To Do\n---\nbody\n"
        );
        set_plan_field(&path, "order", "1024").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "---\norder: 1024\ntitle: T\nstatus: To Do\n---\nbody\n"
        );
    }

    #[test]
    fn unknown_keys_and_comments_are_ignored_without_warning() {
        let p = plan("---\n# a comment\nowner: alice\nstatus: Done\n---\n");
        assert_eq!(p.status.as_deref(), Some("Done"));
        assert!(!p.parse_warning);
    }

    #[test]
    fn write_plan_field_replaces_only_the_status_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.md");
        let original = "---\ntitle: Keep me\nstatus: To Do\nowner: alice\n---\n# Body\n\nText.\n";
        std::fs::write(&path, original).unwrap();
        write_plan_field(&path, "status", "In Progress").unwrap();
        let after = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            after,
            "---\ntitle: Keep me\nstatus: In Progress\nowner: alice\n---\n# Body\n\nText.\n"
        );
    }

    #[test]
    fn write_plan_field_inserts_into_a_block_that_lacks_one() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.md");
        std::fs::write(&path, "---\ntitle: T\n---\nbody\n").unwrap();
        write_plan_field(&path, "status", "Done").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "---\nstatus: Done\ntitle: T\n---\nbody\n"
        );
    }

    #[test]
    fn write_plan_field_prepends_a_block_when_none_exists() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.md");
        std::fs::write(&path, "# Heading only\n").unwrap();
        write_plan_field(&path, "status", "To Do").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "---\nstatus: To Do\n---\n# Heading only\n"
        );
    }

    #[test]
    fn write_plan_field_replaces_a_priority_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.md");
        std::fs::write(&path, "---\nstatus: To Do\npriority: low\n---\nbody\n").unwrap();
        set_plan_field(&path, "priority", "urgent").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "---\nstatus: To Do\npriority: urgent\n---\nbody\n"
        );
    }

    #[test]
    fn set_plan_field_writes_title_surgically_and_rejects_empty_or_multiline() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.md");
        std::fs::write(&path, "---\ntitle: Old\nstatus: To Do\n---\n# Body\n").unwrap();

        set_plan_field(&path, "title", "New title").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "---\ntitle: New title\nstatus: To Do\n---\n# Body\n"
        );

        assert!(set_plan_field(&path, "title", "   ").is_err());
        assert!(set_plan_field(&path, "title", "two\nlines").is_err());
        // Neither rejection touched the file.
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "---\ntitle: New title\nstatus: To Do\n---\n# Body\n"
        );
    }

    #[test]
    fn set_plan_field_rejects_disallowed_keys_and_invalid_priorities() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.md");
        std::fs::write(&path, "---\nstatus: To Do\n---\n").unwrap();
        // `title` used to be rejected here; it is allowed as of the plan
        // explorer's metadata panel, so this asserts the rule that
        // survives -- an arbitrary key is still refused.
        assert!(set_plan_field(&path, "owner", "alice").is_err());
        assert!(set_plan_field(&path, "priority", "banana").is_err());
        // Neither failed call may touch the file:
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "---\nstatus: To Do\n---\n");
        // Case-insensitive priority is accepted:
        set_plan_field(&path, "priority", "HIGH").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "---\npriority: HIGH\nstatus: To Do\n---\n"
        );
    }

    #[test]
    fn set_checklist_item_toggles_exactly_one_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.md");
        let original = "---\ntitle: P\n---\n# H\n- [ ] one\n  - [x] two\nrest\n";
        std::fs::write(&path, original).unwrap();
        set_checklist_item(&path, 4, "one", true).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "---\ntitle: P\n---\n# H\n- [x] one\n  - [x] two\nrest\n"
        );
        // Indentation preserved on untick:
        set_checklist_item(&path, 5, "two", false).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "---\ntitle: P\n---\n# H\n- [x] one\n  - [ ] two\nrest\n"
        );
    }

    #[test]
    fn set_checklist_item_validates_line_and_text() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.md");
        let original = "---\ntitle: P\n---\n- [ ] one\n";
        std::fs::write(&path, original).unwrap();
        assert!(set_checklist_item(&path, 99, "one", true).is_err()); // out of range
        assert!(set_checklist_item(&path, 3, "drifted", true).is_err()); // text mismatch
        assert!(set_checklist_item(&path, 1, "title: P", true).is_err()); // not a checkbox line
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original); // no writes on error
    }

    #[test]
    fn promote_checklist_item_creates_the_child_and_rewrites_the_line() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let plans = dir.path().join(GAVIN_ROOT_DIR).join("plans");
        let plan = plans.join("big-plan.md");
        std::fs::write(&plan, "---\ntitle: Big\nstatus: To Do\n---\n- [ ] Ship the API\n- [x] Done thing\n")
            .unwrap();

        let child = promote_checklist_item(&plan, "Ship the API").unwrap();
        assert_eq!(child, plans.join("ship-the-api.md"));
        assert_eq!(
            std::fs::read_to_string(&child).unwrap(),
            "---\nkind: task\ntitle: Ship the API\nparent: big-plan.md\n---\nShip the API\n"
        );
        assert_eq!(
            std::fs::read_to_string(&plan).unwrap(),
            "---\ntitle: Big\nstatus: To Do\n---\n- [ ] [Ship the API](./ship-the-api.md)\n- [x] Done thing\n"
        );

        // A checked item keeps its mark and collides into a -2 suffix.
        let child2 = promote_checklist_item(&plan, "Done thing").unwrap();
        std::fs::write(plans.join("done-thing-2-placeholder"), "").ok(); // noise, ignored
        assert_eq!(child2, plans.join("done-thing.md"));
        assert!(std::fs::read_to_string(&plan).unwrap().contains("- [x] [Done thing](./done-thing.md)"));
    }

    #[test]
    fn promote_checklist_item_errors_on_missing_ambiguous_or_promoted() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let plans = dir.path().join(GAVIN_ROOT_DIR).join("plans");
        let plan = plans.join("p.md");
        let original = "---\ntitle: P\n---\n- [ ] dup\n- [ ] dup\n- [ ] [already](./already.md)\n";
        std::fs::write(&plan, original).unwrap();
        assert!(promote_checklist_item(&plan, "missing").is_err());
        assert!(promote_checklist_item(&plan, "dup").is_err()); // ambiguous
        assert!(promote_checklist_item(&plan, "[already](./already.md)").is_err()); // already promoted
        assert_eq!(std::fs::read_to_string(&plan).unwrap(), original);

        // Name collision suffixes: an existing file with the slug name.
        std::fs::write(&plans.join("task-x.md"), "existing").unwrap();
        std::fs::write(&plan, "---\ntitle: P\n---\n- [ ] Task X\n").unwrap();
        let child = promote_checklist_item(&plan, "Task X").unwrap();
        assert_eq!(child, plans.join("task-x-2.md"));
    }

    #[test]
    fn delete_card_file_removes_only_guarded_paths() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let plans = dir.path().join(GAVIN_ROOT_DIR).join("plans");
        let card = plans.join("doomed.md");
        std::fs::write(&card, "---\ntitle: D\n---\n").unwrap();
        delete_card_file(&card).unwrap();
        assert!(!card.exists());
        // Missing file errors:
        assert!(delete_card_file(&card).is_err());
        // Outside plans/ refuses:
        let stray = dir.path().join("stray.md");
        std::fs::write(&stray, "x").unwrap();
        assert!(delete_card_file(&stray).is_err());
        assert!(stray.exists());
        // Non-md refuses:
        let notmd = plans.join("notes.txt");
        std::fs::write(&notmd, "x").unwrap();
        assert!(delete_card_file(&notmd).is_err());
        assert!(notmd.exists());
    }

    #[test]
    fn init_creates_full_skeleton_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "My WS").unwrap();
        let g = dir.path().join(GAVIN_ROOT_DIR);
        assert!(g.join("config.toml").is_file());
        assert!(g.join("PRD.md").is_file());
        for sub in ["plans", "docs", "specs"] {
            assert!(g.join(sub).join(".gitkeep").is_file());
        }
        let prd = std::fs::read_to_string(g.join("PRD.md")).unwrap();
        assert!(prd.starts_with("# My WS — Product Requirements"));
        init_gavin_root(dir.path(), "My WS").unwrap(); // second run: no-op, no error
    }

    #[test]
    fn init_never_overwrites_an_existing_prd() {
        let dir = tempfile::tempdir().unwrap();
        let g = dir.path().join(GAVIN_ROOT_DIR);
        std::fs::create_dir_all(&g).unwrap();
        std::fs::write(g.join("PRD.md"), "my precious prd\n").unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        assert_eq!(std::fs::read_to_string(g.join("PRD.md")).unwrap(), "my precious prd\n");
        // ...while still completing the missing pieces:
        assert!(g.join("config.toml").is_file());
        assert!(g.join("plans").join(".gitkeep").is_file());
    }

    #[test]
    fn create_context_scaffolds_with_folder_name() {
        let dir = tempfile::tempdir().unwrap();
        let feature = dir.path().join("auth");
        std::fs::create_dir_all(&feature).unwrap();
        create_gavin_context(&feature).unwrap();
        let config = std::fs::read_to_string(feature.join(GAVIN_DIR).join("config.toml")).unwrap();
        assert_eq!(config, "name = \"auth\"\n");
    }

    #[test]
    fn scan_finds_root_and_nested_contexts_root_first() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let feature = dir.path().join("src").join("auth");
        std::fs::create_dir_all(&feature).unwrap();
        create_gavin_context(&feature).unwrap();
        std::fs::write(
            feature.join(GAVIN_DIR).join("plans").join("login.md"),
            "---\nstatus: To Do\n---\n# Login\n",
        )
        .unwrap();

        let tree = scan_root(dir.path());
        assert!(!tree.root_missing);
        assert_eq!(tree.contexts.len(), 2);
        assert_eq!(tree.contexts[0].kind, GavinContextKind::Root);
        assert!(tree.contexts[0].has_prd);
        assert_eq!(tree.contexts[1].name, "auth");
        assert_eq!(tree.contexts[1].plans.len(), 1);
        assert_eq!(tree.contexts[1].plans[0].status.as_deref(), Some("To Do"));
    }

    #[test]
    fn scan_honors_exclusions_depth_cap_and_deep_gavin_root() {
        let dir = tempfile::tempdir().unwrap();
        // Excluded dir: a context inside node_modules must not be found.
        let hidden = dir.path().join("node_modules").join("pkg");
        std::fs::create_dir_all(hidden.join(GAVIN_DIR)).unwrap();
        // Deep .gavin-root: ignored entirely.
        let deep = dir.path().join("sub");
        std::fs::create_dir_all(deep.join(GAVIN_ROOT_DIR)).unwrap();
        // Beyond the depth cap: d1/d2/.../d13/.gavin must not be found.
        let mut too_deep = dir.path().to_path_buf();
        for i in 1..=13 {
            too_deep = too_deep.join(format!("d{i}"));
        }
        std::fs::create_dir_all(too_deep.join(GAVIN_DIR)).unwrap();

        let tree = scan_root(dir.path());
        assert_eq!(tree.contexts.len(), 0);
    }

    #[test]
    fn gavin_root_wins_when_root_has_both_markers() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        std::fs::create_dir_all(dir.path().join(GAVIN_DIR).join("plans")).unwrap();
        let tree = scan_root(dir.path());
        // Only the Root context -- the root-level .gavin is ignored.
        assert_eq!(tree.contexts.len(), 1);
        assert_eq!(tree.contexts[0].kind, GavinContextKind::Root);
    }

    #[test]
    fn scan_of_missing_root_reports_root_missing() {
        let tree = scan_root(Path::new("/definitely/not/a/real/path"));
        assert!(tree.root_missing);
        assert!(tree.contexts.is_empty());
    }

    #[test]
    fn unparseable_config_toml_falls_back_to_folder_name_with_warning() {
        let dir = tempfile::tempdir().unwrap();
        let feature = dir.path().join("auth");
        std::fs::create_dir_all(feature.join(GAVIN_DIR)).unwrap();
        std::fs::write(feature.join(GAVIN_DIR).join("config.toml"), "not [ valid toml").unwrap();
        let tree = scan_root(dir.path());
        assert_eq!(tree.contexts.len(), 1);
        assert_eq!(tree.contexts[0].name, "auth");
        assert!(tree.contexts[0].config_warning);
    }

    #[test]
    fn create_plan_file_writes_canonical_content_with_defaults() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let path = create_plan_file(dir.path(), "auth.md", "Auth flow", None, None, None, None, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "---\ntitle: Auth flow\nstatus: To Do\n---\n# Auth flow\n"
        );
        let path2 = create_plan_file(
            dir.path(),
            "auth2.md",
            "Auth 2",
            Some("In Progress"),
            Some("high"),
            Some("Body text"),
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(&path2).unwrap(),
            "---\ntitle: Auth 2\nstatus: In Progress\npriority: high\n---\nBody text\n"
        );
    }

    #[test]
    fn create_plan_file_writes_kind_and_parent() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(GAVIN_ROOT_DIR)).unwrap();
        // A nested child: kind task + parent, no status line at all.
        let p = create_plan_file(dir.path(), "child.md", "Child", None, None, None, Some("task"), Some("parent-plan.md")).unwrap();
        assert_eq!(
            std::fs::read_to_string(&p).unwrap(),
            "---\nkind: task\ntitle: Child\nparent: parent-plan.md\n---\n# Child\n"
        );
        // A note keeps the default/explicit status.
        let n = create_plan_file(dir.path(), "note.md", "Note", Some("Done"), None, None, Some("note"), None).unwrap();
        assert!(std::fs::read_to_string(&n).unwrap().starts_with("---\nkind: note\ntitle: Note\nstatus: Done\n"));
        // kind plan writes no kind line (backward-canonical).
        let pl = create_plan_file(dir.path(), "plan.md", "P", None, None, None, Some("plan"), None).unwrap();
        assert!(std::fs::read_to_string(&pl).unwrap().starts_with("---\ntitle: P\nstatus: To Do\n"));
        assert!(create_plan_file(dir.path(), "x.md", "X", None, None, None, Some("epic"), None).is_err());
        assert!(create_plan_file(dir.path(), "y.md", "Y", None, None, None, Some("note"), Some("p.md")).is_err());
        assert!(create_plan_file(dir.path(), "z.md", "Z", None, None, None, Some("task"), Some("../evil.md")).is_err());
    }

    #[test]
    fn create_plan_file_validates_and_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        // Not a context:
        assert!(create_plan_file(&dir.path().join("nope"), "a.md", "T", None, None, None, None, None).is_err());
        // Bad names ("../esc.md" doubles as the path-escape guard):
        for bad in ["", ".md", "no-extension", "sp ace.md", "../esc.md"] {
            assert!(create_plan_file(dir.path(), bad, "T", None, None, None, None, None).is_err(), "{bad}");
        }
        // Bad priority / bad title:
        assert!(create_plan_file(dir.path(), "a.md", "T", None, Some("banana"), None, None, None).is_err());
        assert!(create_plan_file(dir.path(), "a.md", "  ", None, None, None, None, None).is_err());
        // Never overwrites:
        create_plan_file(dir.path(), "a.md", "T", None, None, None, None, None).unwrap();
        let dup = create_plan_file(dir.path(), "a.md", "T2", None, None, None, None, None);
        assert!(dup.unwrap_err().to_string().contains("already exists"));
    }

    #[test]
    fn read_prd_returns_content_and_errors_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_prd(dir.path()).is_err());
        init_gavin_root(dir.path(), "My WS").unwrap();
        assert!(read_prd(dir.path()).unwrap().starts_with("# My WS — Product Requirements"));
    }

    #[test]
    fn watcher_pushes_once_per_change_and_stops_after_drop() {
        use std::io::BufReader;

        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let (ours, theirs) = UnixStream::pair().unwrap();
        ours.set_read_timeout(Some(Duration::from_millis(400))).unwrap();
        let writer = Arc::new(Mutex::new(theirs));

        let watcher =
            GavinWatcher::start("ws-1".to_string(), dir.path().to_path_buf(), Arc::clone(&writer));

        let mut reader = BufReader::new(ours);
        // Initial scan pushed exactly once.
        let first: Option<Response> = protocol::read_message(&mut reader).unwrap();
        assert!(matches!(first, Some(Response::GavinTreeChanged { .. })));

        // A manual rescan with NO underlying change must not emit again:
        // the next read times out instead of yielding a message. (The 2s
        // floor makes this rescan sleep -- that is the floor working.)
        watcher.rescan_and_push();
        let timed_out: Result<Option<Response>, _> = protocol::read_message(&mut reader);
        assert!(timed_out.is_err(), "change-gating failed: an unchanged rescan emitted");

        // After drop, even a real change must emit nothing.
        drop(watcher);
        std::fs::write(
            dir.path().join(GAVIN_ROOT_DIR).join("plans").join("late.md"),
            "---\nstatus: To Do\n---\n",
        )
        .unwrap();
        let after_drop: Result<Option<Response>, _> = protocol::read_message(&mut reader);
        assert!(after_drop.is_err(), "a dropped watcher still emitted");
    }
}
