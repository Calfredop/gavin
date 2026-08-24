use protocol::{
    AgentConfig,
    CardKind, GavinContext, GavinContextKind, GavinTree, MdFileInfo, PlanFileInfo, Priority, Response,
};
use std::collections::HashMap;
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
    // File names are unique per context (that is what `parent:` resolves
    // on), so the check spans the whole tree -- a flat `x.md` and an
    // archived `done/x.md` would be one ambiguous card, not two.
    if let Some(existing) = find_in_plans_tree(&plans, file_name) {
        anyhow::bail!("plan file already exists: {}", existing.display());
    }
    // Born in the folder it belongs in, rather than created flat and
    // immediately moved: a nested child beside its parent, a Done card in
    // done/, everything else in plans/.
    let dir = if kind == "task" && status.is_none() {
        parent
            .and_then(|p| find_in_plans_tree(&plans, p))
            .and_then(|p| p.parent().map(Path::to_path_buf))
            .unwrap_or_else(|| plans.clone())
    } else if status.is_some_and(is_done_status) {
        plans.join(DONE_DIR)
    } else {
        plans.clone()
    };
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(file_name);

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

/// The archive folder inside a `plans/` directory. Finished cards live
/// here so an agent listing or grepping `plans/` sees only live work --
/// this repo had 30 Done cards among 44 when the rule was written.
pub const DONE_DIR: &str = "done";

/// A status archives iff it slugs to "done" -- the same match the board
/// makes between a card's status and a column name, so "Done", "done" and
/// " DONE " are one status and "Shipped" is not.
fn is_done_status(status: &str) -> bool {
    slug_title(status).as_deref() == Some(DONE_DIR)
}

/// True for a `plans` directory that really is a context's plans folder
/// (its parent is a `.gavin*` marker directory).
fn is_plans_dir(dir: &Path) -> bool {
    dir.file_name().is_some_and(|n| n == "plans")
        && dir
            .parent()
            .is_some_and(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with(".gavin")))
}

/// The `plans/` root governing this file, but ONLY for the two locations
/// the archive rule owns: directly in `plans/`, or directly in
/// `plans/done/`. A file filed under a hand-made `plans/roadmap/` yields
/// None and is therefore never moved -- a status write must not flatten
/// somebody else's hierarchy.
fn governed_plans_root(path: &Path) -> Option<PathBuf> {
    let parent = path.parent()?;
    if is_plans_dir(parent) {
        return Some(parent.to_path_buf());
    }
    if parent.file_name().is_some_and(|n| n == DONE_DIR) {
        let plans = parent.parent()?;
        if is_plans_dir(plans) {
            return Some(plans.to_path_buf());
        }
    }
    None
}

/// Every md file under a `plans/` root, in walk order.
fn plans_tree_files(plans_root: &Path) -> Vec<PathBuf> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out);
            } else if path.extension().is_some_and(|e| e == "md") {
                out.push(path);
            }
        }
    }
    let mut out = Vec::new();
    walk(plans_root, &mut out);
    out.sort();
    out
}

/// The one file of this name anywhere under `plans/`. Card file names are
/// unique per context by construction -- `parent:` resolves on
/// (context, file_name) -- so a tree-wide lookup is the right one.
fn find_in_plans_tree(plans_root: &Path, file_name: &str) -> Option<PathBuf> {
    plans_tree_files(plans_root)
        .into_iter()
        .find(|p| p.file_name().is_some_and(|n| n == file_name))
}

/// The directory a card belongs in, given its own frontmatter. A nested
/// child (task + parent + no status) lives wherever its parent lives --
/// the same "children travel with their parent" rule deletion already
/// applies. Everything else is `plans/done/` when Done, `plans/`
/// otherwise. None when the answer is "leave it exactly where it is".
fn home_dir_for(plans_root: &Path, info: &PlanFileInfo) -> Option<PathBuf> {
    if info.kind == CardKind::Task && info.status.is_none() {
        if let Some(parent) = info.parent.as_deref() {
            // An unresolvable parent is a broken link, not a licence to
            // move the card: leave it and let the board flag it.
            return find_in_plans_tree(plans_root, parent).and_then(|p| p.parent().map(Path::to_path_buf));
        }
    }
    Some(match info.status.as_deref() {
        Some(s) if is_done_status(s) => plans_root.join(DONE_DIR),
        _ => plans_root.to_path_buf(),
    })
}

/// Moves one card file to `dest_dir`, creating it if needed. A taken
/// destination leaves the file where it is: two cards sharing a file name
/// in one context already break `parent:` resolution, and inventing a
/// suffix here would only make the name wrong again when the card comes
/// back out of `done/`.
fn move_card(path: &Path, dest_dir: &Path) -> anyhow::Result<PathBuf> {
    let Some(file_name) = path.file_name() else { return Ok(path.to_path_buf()) };
    let dest = dest_dir.join(file_name);
    if dest == path {
        return Ok(path.to_path_buf());
    }
    if dest.exists() {
        eprintln!(
            "not moving {} to {}: a file of that name is already there",
            path.display(),
            dest.display()
        );
        return Ok(path.to_path_buf());
    }
    std::fs::create_dir_all(dest_dir)?;
    std::fs::rename(path, &dest)?;
    Ok(dest)
}

/// Files a card where its status says it belongs, and takes its nested
/// children with it. Returns the card's path afterwards -- unchanged when
/// no move was called for, when the card lives outside the two governed
/// locations, or when the destination name was taken.
pub fn relocate_for_status(path: &Path) -> anyhow::Result<PathBuf> {
    let Some(plans_root) = governed_plans_root(path) else { return Ok(path.to_path_buf()) };
    let content = std::fs::read_to_string(path)?;
    let info = plan_file_info(path, &content);
    let Some(home) = home_dir_for(&plans_root, &info) else { return Ok(path.to_path_buf()) };
    let moved = move_card(path, &home)?;
    if moved == path {
        return Ok(moved);
    }
    // The children follow. Their own home_dir_for now resolves to the
    // parent's new folder, so this is the same rule applied one level
    // down rather than a special case.
    if info.kind == CardKind::Plan {
        for child in plans_tree_files(&plans_root) {
            if child == moved || governed_plans_root(&child).is_none() {
                continue;
            }
            let Ok(child_content) = std::fs::read_to_string(&child) else { continue };
            let child_info = plan_file_info(&child, &child_content);
            let follows = child_info.kind == CardKind::Task
                && child_info.status.is_none()
                && child_info.parent.as_deref() == Some(info.file_name.as_str());
            if follows {
                if let Some(dest) = moved.parent() {
                    move_card(&child, dest)?;
                }
            }
        }
    }
    Ok(moved)
}

/// The public, validated entry point (and the future MCP tool body). The
/// allow-list is enforced HERE, not trusted to callers -- this must never
/// become an arbitrary-line writer.
///
/// Returns the file's path AFTER the write: a status write can move the
/// card between `plans/` and `plans/done/` (see `relocate_for_status`),
/// and every caller that holds the path as an identity needs the new one.
pub fn set_plan_field(path: &Path, key: &str, value: &str) -> anyhow::Result<PathBuf> {
    // Empty value removes the line -- permitted only where the card model
    // needs it (status: nesting, parent: un-parenting, labels: clearing).
    if value.is_empty() {
        match key {
            "status" | "parent" | "labels" => {
                write_plan_field(path, key, value)?;
                return relocate_for_status(path);
            }
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
    write_plan_field(path, key, value)?;
    // Run on every field, not just status: it costs one read, and it
    // heals a card someone dragged into the wrong folder in Finder.
    relocate_for_status(path)
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

    // The plan must sit in a `.gavin*/plans/` -- or in its `done/`, since
    // an archived plan is still a plan someone can promote a step out of.
    // The context folder is the marker directory's parent.
    let plans_dir = governed_plans_root(plan_path)
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
    while find_in_plans_tree(&plans_dir, &file_name).is_some() {
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

/// Deletes a context md file (card-model delete design + explorer
/// delete). Guarded: some ancestor must be a `plans/`, `docs/` or
/// `specs/` folder directly inside a `.gavin*` directory (docs and specs
/// legitimately nest in subfolders, and the scanners list nested plans
/// too) -- this must never become a general file deleter. `..` segments
/// are rejected outright: the ancestor walk is lexical, so a `..` could
/// dress an outside path up as a guarded one. Missing file errors (the
/// caller should know its picture is stale).
pub fn delete_card_file(path: &Path) -> anyhow::Result<()> {
    if path.extension().is_none_or(|e| e != "md") {
        anyhow::bail!("not a context md file: {}", path.display());
    }
    if path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        anyhow::bail!("path may not contain ..: {}", path.display());
    }
    let guarded = path.ancestors().skip(1).any(|dir| {
        dir.file_name().is_some_and(|n| n == "plans" || n == "docs" || n == "specs")
            && dir.parent().is_some_and(|p| {
                p.file_name().is_some_and(|n| n.to_string_lossy().starts_with(".gavin"))
            })
    });
    if !guarded {
        anyhow::bail!("not inside a .gavin*/plans|docs|specs folder: {}", path.display());
    }
    std::fs::remove_file(path)
        .map_err(|e| anyhow::anyhow!("couldn't delete {}: {e}", path.display()))
}

/// A context's display name and (for a root context) its `[agent]`
/// block, from one parse of config.toml. The bool is
/// config_warning: false for a missing file (absent config is normal),
/// true only when the file exists but doesn't parse as TOML.
fn parse_context_config(config_path: &Path) -> (Option<String>, Option<AgentConfig>, bool) {
    let content = match std::fs::read_to_string(config_path) {
        Ok(c) => c,
        Err(_) => return (None, None, false),
    };
    match content.parse::<toml::Table>() {
        Ok(table) => {
            let name = table.get("name").and_then(|v| v.as_str()).map(|s| s.to_string());
            let agent = table.get("agent").and_then(|v| v.as_table()).map(|t| {
                let get = |k: &str| t.get(k).and_then(|v| v.as_str()).map(|s| s.to_string());
                AgentConfig { profile: get("profile"), file: get("file"), command: get("command") }
            });
            (name, agent, false)
        }
        Err(_) => (None, None, true),
    }
}

/// Writes one `[agent]` key of `.gavin-root/config.toml`. Uses toml_edit
/// so comments, key order and formatting survive -- this file is
/// hand-edited by users and read by their agents. Allow-listed exactly
/// like set_plan_field: never an arbitrary-key writer.
pub fn set_root_config_field(root: &Path, key: &str, value: &str) -> anyhow::Result<()> {
    if !matches!(key, "profile" | "file" | "command") {
        anyhow::bail!("not a settable agent key: {key}");
    }
    if value.trim().is_empty() || value.contains('\n') {
        anyhow::bail!("{key} must be a non-empty single line");
    }
    let path = root.join(GAVIN_ROOT_DIR).join("config.toml");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let mut doc = existing.parse::<toml_edit::DocumentMut>().map_err(|_| {
        anyhow::anyhow!("{} is not valid TOML -- fix or remove it first", path.display())
    })?;
    doc["agent"][key] = toml_edit::value(value);
    // A freshly created [agent] arrives implicit; make it explicit so the
    // file stays readable to whoever opens it next.
    if let Some(t) = doc["agent"].as_table_mut() {
        t.set_implicit(false);
    }
    std::fs::write(&path, doc.to_string())?;
    Ok(())
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

/// Top-level `extra_contexts` array of the root config: absolute folder
/// paths OUTSIDE the workspace that scans should include. Anything that
/// isn't a string array (or a file that doesn't parse) reads as empty --
/// config_warning already covers the parse failure.
fn parse_extra_contexts(config_path: &Path) -> Vec<String> {
    let Ok(content) = std::fs::read_to_string(config_path) else { return vec![] };
    let Ok(table) = content.parse::<toml::Table>() else { return vec![] };
    table
        .get("extra_contexts")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default()
}

/// Scaffolds `.gavin` in a folder outside the workspace root and records
/// it in the root config's `extra_contexts`, so scans (and therefore the
/// app and gavin_get_tree) include it. Folders under the root are
/// refused: they are scanned natively and registering them would
/// double-list. Scaffold happens BEFORE the config write, so a failed
/// write can't register a folder that has no skeleton.
pub fn add_external_context(root: &Path, folder: &Path) -> anyhow::Result<()> {
    if !folder.is_dir() {
        anyhow::bail!("folder does not exist or is not a directory: {}", folder.display());
    }
    if folder.starts_with(root) {
        anyhow::bail!(
            "{} is inside the workspace -- it is scanned natively, no registration needed",
            folder.display()
        );
    }
    let config_path = root.join(GAVIN_ROOT_DIR).join("config.toml");
    if !config_path.is_file() {
        anyhow::bail!("no {} -- is {} a gavin root?", config_path.display(), root.display());
    }
    create_gavin_context(folder)?;
    let existing = std::fs::read_to_string(&config_path).unwrap_or_default();
    let mut doc = existing.parse::<toml_edit::DocumentMut>().map_err(|_| {
        anyhow::anyhow!("{} is not valid TOML -- fix or remove it first", config_path.display())
    })?;
    let entry = folder.to_string_lossy().to_string();
    let item = doc
        .entry("extra_contexts")
        .or_insert(toml_edit::value(toml_edit::Array::new()));
    let arr = item
        .as_array_mut()
        .ok_or_else(|| anyhow::anyhow!("extra_contexts in config.toml is not an array"))?;
    if !arr.iter().any(|v| v.as_str() == Some(entry.as_str())) {
        arr.push(entry.as_str());
    }
    std::fs::write(&config_path, doc.to_string())?;
    Ok(())
}

/// Removes an outside folder from `extra_contexts`. The folder's files
/// are left untouched -- this only stops listing it. Unregistered paths
/// (or an absent config) are a no-op, not an error: the end state the
/// caller asked for already holds.
pub fn remove_external_context(root: &Path, folder: &Path) -> anyhow::Result<()> {
    let config_path = root.join(GAVIN_ROOT_DIR).join("config.toml");
    let Ok(existing) = std::fs::read_to_string(&config_path) else { return Ok(()) };
    let mut doc = existing.parse::<toml_edit::DocumentMut>().map_err(|_| {
        anyhow::anyhow!("{} is not valid TOML -- fix or remove it first", config_path.display())
    })?;
    let entry = folder.to_string_lossy().to_string();
    let Some(arr) = doc.get_mut("extra_contexts").and_then(|i| i.as_array_mut()) else {
        return Ok(());
    };
    arr.retain(|v| v.as_str() != Some(entry.as_str()));
    std::fs::write(&config_path, doc.to_string())?;
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
    let (config_name, agent_config, config_warning) =
        parse_context_config(&gavin_dir.join("config.toml"));
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
        // Only the root context carries an agent block: `.gavin`
        // sub-contexts scope plans, not how the workspace is worked on.
        agent: if matches!(kind, GavinContextKind::Root) { agent_config } else { None },
        outside: false,
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

    // Outside contexts (`extra_contexts` in the root config) come after
    // every scanned one, sorted by path. Entries under the root would
    // double-list a scanned folder and are skipped; so is a folder that
    // vanished or lost its `.gavin` -- the navigator simply stops showing
    // it until it is back.
    if root_has_gavin_root {
        let mut extras = parse_extra_contexts(&root_gavin.join("config.toml"));
        extras.sort();
        extras.dedup();
        for folder in extras {
            let path = PathBuf::from(&folder);
            if path.starts_with(root) {
                continue;
            }
            let gavin_dir = path.join(GAVIN_DIR);
            if !gavin_dir.is_dir() {
                continue;
            }
            let mut ctx = build_context(&path, &gavin_dir, GavinContextKind::Context);
            ctx.outside = true;
            contexts.push(ctx);
        }
    }
    GavinTree { root_path: root_str, root_missing: false, contexts }
}

/// The directories worth watching, and how deeply. Mirrors `scan_root`'s
/// own walk exactly, because watching what the scanner reads -- and
/// nothing else -- is the whole performance story: this repo holds 3587
/// directories under the root and 44 the scanner walks, and the 3543 it
/// skips (`target/`, `node_modules/`, `.git/`) are precisely the ones a
/// build churns. Under the old single recursive watch every one of those
/// events crossed into the daemon just to be thrown away.
///
/// A scanned directory is watched NON-recursively, and that is what
/// catches a context folder being created, deleted, renamed or moved:
/// those events are reported against the folder's own path, so only its
/// PARENT's watch can see them. A `.gavin*` marker directory is watched
/// recursively instead, since `plans/`, `docs/` and `specs/` all churn
/// below it and every one of those changes is the tree.
pub fn watch_targets(root: &Path) -> Vec<(PathBuf, notify::RecursiveMode)> {
    use notify::RecursiveMode::{NonRecursive, Recursive};
    // The root's own watch is permanent, and listed even while the root
    // is missing. It is what reports the root being renamed away (that
    // event's path IS the root, which is why `tree_relevant` has an arm
    // for it), and dropping it the moment the root vanished would mean
    // nothing was left to see the root come back.
    let mut targets = vec![(root.to_path_buf(), NonRecursive)];
    if !root.is_dir() {
        // Nothing to walk. Deliberately NOT falling back to a watch on
        // the parent folder: a workspace root's parent is routinely
        // something like ~/Code with every other project under it, and
        // subscribing to that to catch one folder reappearing is the
        // firehose this watch set exists to avoid. A root that is
        // missing when the watcher starts degrades to scan-on-demand;
        // one that goes missing later keeps the watch registered above
        // and heals the moment it is back.
        return targets;
    }

    fn walk(dir: &Path, depth: usize, targets: &mut Vec<(PathBuf, notify::RecursiveMode)>) {
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
            if name == GAVIN_DIR || name == GAVIN_ROOT_DIR {
                targets.push((path, Recursive));
                continue;
            }
            if EXCLUDED_DIRS.contains(&name.as_str()) || name.starts_with('.') {
                continue;
            }
            targets.push((path.clone(), NonRecursive));
            walk(&path, depth + 1, targets);
        }
    }
    walk(root, 1, &mut targets);
    targets
}

/// Whether a filesystem event can possibly have changed the scanned tree.
///
/// The old rule was "some path component is `.gavin*`", which silently
/// dropped the case this card exists for. Renaming or moving a folder
/// that HOLDS a context reports only the folder's own two paths --
/// verified against the live backend, `mv packages/foo packages/bar` with
/// `packages/foo/.gavin` present emits exactly `…/packages/foo` and
/// `…/packages/bar` -- and neither carries a `.gavin` segment, so the
/// rescan never fired and every tab kept the stale context until the app
/// restarted. Two rules close it, neither costing more than one `stat`:
///
/// - the path is a directory NOW: a folder appeared or moved in, and it
///   may have brought a `.gavin` with it (only the scan can settle what
///   it really holds);
/// - the path is gone, and a context we already know about lived at or
///   under it: that context's folder was deleted or moved away.
///
/// Anything the scanner would never descend into is rejected first. Those
/// directories are outside the watch set now, so in practice their events
/// never arrive at all -- this stays as the second line of defence, and
/// as the rule the unit tests pin.
pub fn tree_relevant(root: &Path, last_tree: Option<&GavinTree>, path: &Path) -> bool {
    if path == root {
        return true; // the root itself renamed away, or back
    }
    let Ok(rel) = path.strip_prefix(root) else {
        // Outside the root -- and yet it reached us, which it can only do
        // through a watch we registered, and every watch we register is
        // under the root. So a subtree that WAS ours has just been moved
        // out, and this event is its arrival at the far end (`mv
        // packages/api ~/elsewhere` is reported against the destination
        // as readily as the source). Conservatively relevant, matching
        // the git watcher's rule for the same situation; the rescan that
        // follows drops the stale watches.
        return true;
    };
    for component in rel.components() {
        let name = component.as_os_str().to_string_lossy();
        if name == GAVIN_DIR || name == GAVIN_ROOT_DIR {
            return true; // everything under a marker directory IS the tree
        }
        // Mirrors the scanner's own skips. A dot-named leaf is covered by
        // the same rule on purpose: a dot directory is never descended
        // into, and a dot FILE outside a marker directory (`.DS_Store`,
        // `.gitignore`) is not the tree either.
        if EXCLUDED_DIRS.contains(&name.as_ref()) || name.starts_with('.') {
            return false;
        }
    }
    // No depth cutoff here even though `scan_root` has one: an extra
    // rescan costs a 44-directory walk, a missed one is the bug above.
    if path.is_dir() {
        return true;
    }
    last_tree.is_some_and(|tree| {
        tree.contexts.iter().any(|ctx| Path::new(&ctx.folder_path).starts_with(path))
    })
}

/// How long events accumulate before a flush. Short, because the flush
/// itself is cheap (a component walk per path) and MIN_RESCAN_INTERVAL is
/// what actually protects against churn -- there is nothing to buy by
/// waiting longer, and this sits directly in the latency the human sees
/// after deleting a file.
const RESCAN_DEBOUNCE: Duration = Duration::from_millis(150);
/// Floor between two rescans under SUSTAINED churn -- the RepoPoller
/// lesson: without one, a burst of writes can drive the debouncer to
/// flush indefinitely.
const MIN_RESCAN_INTERVAL: Duration = Duration::from_secs(2);
/// Idle time that ends a burst. Longer than MIN_RESCAN_INTERVAL so a
/// steady stream of floored rescans can never keep re-earning the free
/// one and defeat the floor entirely.
const QUIET_PERIOD: Duration = Duration::from_secs(3);
/// Rescans a burst gets before the floor starts applying. One: a single
/// delete, rename or move is the common case and has to land
/// immediately, and one rescan can never be the churn the floor guards
/// against.
const BURST_FREE_SCANS: u32 = 1;

/// How many scans deep into the current burst a rescan starting now
/// would be. Zero means the burst is over (or never started) and the next
/// scan is free. Split out from `floor_wait` so `rescan_and_push` can
/// record it without recomputing.
fn burst_position(since_last: Option<Duration>, previous: u32) -> u32 {
    match since_last {
        // A gap long enough that this cannot be churn -- and the very
        // first scan of all, which must never count as a burst member or
        // the human's first action after opening the app would be floored.
        None => 0,
        Some(elapsed) if elapsed >= QUIET_PERIOD => 0,
        Some(_) => previous + 1,
    }
}

/// How long a rescan at `position` in the burst must sleep before
/// scanning. Pure, so the burst policy is testable without a real clock.
fn floor_wait(since_last: Option<Duration>, position: u32) -> Duration {
    let Some(elapsed) = since_last else { return Duration::ZERO };
    if position <= BURST_FREE_SCANS {
        return Duration::ZERO;
    }
    MIN_RESCAN_INTERVAL.saturating_sub(elapsed)
}

struct WatcherInner {
    last_tree: Option<GavinTree>,
    last_scan: Option<Instant>,
    /// How deep into the current burst the last rescan was; see
    /// `burst_position`.
    burst: u32,
    /// The watch set currently registered, so re-arming after a rescan
    /// can diff instead of tearing every watch down and rebuilding it.
    watched: HashMap<PathBuf, notify::RecursiveMode>,
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
            inner: Mutex::new(WatcherInner {
                last_tree: None,
                last_scan: None,
                burst: 0,
                watched: HashMap::new(),
            }),
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
                // The guard is released before rescan_and_push, which
                // takes the same lock (and may sleep out the floor under
                // it). The debouncer calls this handler serially, so no
                // second flush is ever waiting on that sleep.
                let relevant = {
                    let inner = watcher.inner.lock().unwrap();
                    events.iter().any(|e| {
                        tree_relevant(&watcher.root_path, inner.last_tree.as_ref(), &e.path)
                    })
                };
                if relevant {
                    watcher.rescan_and_push();
                }
            },
        );
        if let Ok(d) = debounce_result {
            *watcher.debouncer.lock().unwrap() = Some(d);
            let mut inner = watcher.inner.lock().unwrap();
            watcher.sync_watches(&mut inner);
        }

        watcher.rescan_and_push();
        watcher
    }

    /// Registers the current watch set and drops what is no longer in it,
    /// touching only the difference. Called after every scan because the
    /// set is derived from the tree's shape: a folder that just appeared
    /// needs its own watch before anything inside it can be seen, and a
    /// folder that just left has a watch worth releasing.
    ///
    /// A watch that fails to register is simply left out, matching the
    /// old whole-watch behaviour: that subtree stops updating live rather
    /// than the whole watcher failing, and GetGavinTree still works.
    ///
    /// Takes the caller's `inner` guard rather than locking itself, so
    /// the lock order is always inner -> debouncer.
    fn sync_watches(&self, inner: &mut WatcherInner) {
        let mut guard = self.debouncer.lock().unwrap();
        let Some(debouncer) = guard.as_mut() else { return };
        let fs_watcher = debouncer.watcher();

        let desired: HashMap<PathBuf, notify::RecursiveMode> =
            watch_targets(&self.root_path).into_iter().collect();

        // Unwatch first: a path whose recursion mode changed has to lose
        // the old watch before the new one can take.
        for (path, mode) in inner.watched.iter() {
            if desired.get(path) != Some(mode) {
                let _ = fs_watcher.unwatch(path);
            }
        }
        let mut registered = HashMap::with_capacity(desired.len());
        for (path, mode) in desired {
            if inner.watched.get(&path) == Some(&mode) {
                registered.insert(path, mode); // already armed, leave it alone
                continue;
            }
            if fs_watcher.watch(&path, mode).is_ok() {
                registered.insert(path, mode);
            }
        }
        inner.watched = registered;
    }

    /// The entire floor-check + scan + compare + emit sequence runs under
    /// one lock (the HeuristicState lesson): two debouncer flushes, or a
    /// flush racing the initial scan, can never interleave into an
    /// out-of-order emission.
    pub fn rescan_and_push(&self) {
        let mut inner = self.inner.lock().unwrap();
        let since_last = inner.last_scan.map(|t| t.elapsed());
        let position = burst_position(since_last, inner.burst);
        inner.burst = position;
        let wait = floor_wait(since_last, position);
        if !wait.is_zero() {
            std::thread::sleep(wait);
        }
        let tree = scan_root(&self.root_path);
        inner.last_scan = Some(Instant::now());
        // Re-arm against the tree we just scanned, whether or not it
        // changed shape -- an unchanged tree diffs to zero watch calls.
        self.sync_watches(&mut inner);
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

    /// The paths currently registered with the OS, for tests that need to
    /// assert the watch set itself rather than race a filesystem event.
    #[cfg(test)]
    pub fn watched_paths(&self) -> Vec<PathBuf> {
        let mut paths: Vec<PathBuf> = self.inner.lock().unwrap().watched.keys().cloned().collect();
        paths.sort();
        paths
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
        self.sync_watches(&mut inner);
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
    fn delete_card_file_covers_docs_and_specs_but_never_dotdot_escapes() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let g = dir.path().join(GAVIN_ROOT_DIR);
        // Nested doc: docs/specs listings walk subfolders, so deletion must too.
        let guide = g.join("docs").join("guides").join("setup.md");
        std::fs::create_dir_all(guide.parent().unwrap()).unwrap();
        std::fs::write(&guide, "# setup\n").unwrap();
        delete_card_file(&guide).unwrap();
        assert!(!guide.exists());
        let spec = g.join("specs").join("api.md");
        std::fs::write(&spec, "# api\n").unwrap();
        delete_card_file(&spec).unwrap();
        assert!(!spec.exists());
        // A `..` that lexically passes the ancestor check must refuse:
        let victim = dir.path().join("victim.md");
        std::fs::write(&victim, "x").unwrap();
        let sneaky = g.join("docs").join("..").join("..").join("victim.md");
        assert!(delete_card_file(&sneaky).is_err());
        assert!(victim.exists());
    }

    #[test]
    fn external_contexts_register_scan_and_unregister() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        init_gavin_root(root.path(), "WS").unwrap();
        let lib = outside.path().join("shared-lib");
        std::fs::create_dir_all(&lib).unwrap();

        add_external_context(root.path(), &lib).unwrap();
        assert!(lib.join(GAVIN_DIR).join("plans").is_dir());
        // Registering twice keeps one entry:
        add_external_context(root.path(), &lib).unwrap();
        let config =
            std::fs::read_to_string(root.path().join(GAVIN_ROOT_DIR).join("config.toml")).unwrap();
        assert_eq!(config.matches("shared-lib").count(), 1);

        let tree = scan_root(root.path());
        let ctx = tree.contexts.last().unwrap();
        assert_eq!(ctx.folder_path, lib.to_string_lossy());
        assert!(ctx.outside);
        assert!(!tree.contexts.first().unwrap().outside);

        // A folder inside the workspace refuses registration:
        let inner = root.path().join("inner");
        std::fs::create_dir_all(&inner).unwrap();
        assert!(add_external_context(root.path(), &inner).is_err());

        remove_external_context(root.path(), &lib).unwrap();
        assert!(scan_root(root.path()).contexts.iter().all(|c| !c.outside));
        // Removing an unregistered path is a no-op, not an error:
        remove_external_context(root.path(), &lib).unwrap();
    }

    #[test]
    fn scan_skips_extra_contexts_that_are_missing_or_inside_the_root() {
        let root = tempfile::tempdir().unwrap();
        init_gavin_root(root.path(), "WS").unwrap();
        let config = root.path().join(GAVIN_ROOT_DIR).join("config.toml");
        let inside = root.path().join("src");
        std::fs::create_dir_all(inside.join(GAVIN_DIR)).unwrap();
        let mut body = std::fs::read_to_string(&config).unwrap();
        body.push_str(&format!(
            "extra_contexts = [\"{}\", \"/definitely/not/there\"]\n",
            inside.display()
        ));
        std::fs::write(&config, body).unwrap();
        let tree = scan_root(root.path());
        // `src` still appears once -- from the walk, not the extras list.
        let src_entries =
            tree.contexts.iter().filter(|c| c.folder_path == inside.to_string_lossy()).count();
        assert_eq!(src_entries, 1);
        assert!(tree.contexts.iter().all(|c| !c.outside));
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
    fn scan_surfaces_the_agent_block_on_the_root_context_only() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        std::fs::write(
            dir.path().join(GAVIN_ROOT_DIR).join("config.toml"),
            "version = 1\n\n[agent]\nprofile = \"codex\"\ncommand = \"codex\"\n",
        )
        .unwrap();
        let sub = dir.path().join("svc");
        std::fs::create_dir_all(sub.join(GAVIN_DIR)).unwrap();

        let tree = scan_root(dir.path());
        let root = tree.contexts.iter().find(|c| c.kind == GavinContextKind::Root).unwrap();
        let agent = root.agent.as_ref().unwrap();
        assert_eq!(agent.profile.as_deref(), Some("codex"));
        assert_eq!(agent.command.as_deref(), Some("codex"));
        assert_eq!(agent.file, None, "absent key stays None so the profile default applies");

        let child = tree.contexts.iter().find(|c| c.kind != GavinContextKind::Root).unwrap();
        assert_eq!(child.agent, None, "only the root context carries an agent block");
    }

    #[test]
    fn a_config_without_an_agent_block_scans_to_none_not_an_error() {
        // Built by hand, NOT via init_gavin_root: the scaffold template
        // already ships an [agent] block (see the next test), so this
        // covers a config.toml predating workspace settings.
        let dir = tempfile::tempdir().unwrap();
        let g = dir.path().join(GAVIN_ROOT_DIR);
        std::fs::create_dir_all(&g).unwrap();
        std::fs::write(g.join("config.toml"), "version = 1\nname = \"Old\"\n").unwrap();

        let tree = scan_root(dir.path());
        let root = tree.contexts.iter().find(|c| c.kind == GavinContextKind::Root).unwrap();
        assert_eq!(root.agent, None);
        assert!(!root.config_warning, "an absent block is normal, not a warning");
    }

    #[test]
    fn a_freshly_scaffolded_root_already_declares_the_claude_code_profile() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let tree = scan_root(dir.path());
        let agent = tree.contexts[0].agent.as_ref().unwrap();
        assert_eq!(agent.profile.as_deref(), Some("claude-code"));
        assert_eq!(agent.file, None, "the file name follows the profile until overridden");
        assert_eq!(agent.command, None);
    }

    #[test]
    fn set_root_config_field_writes_each_allowed_key_and_rejects_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();

        set_root_config_field(dir.path(), "profile", "codex").unwrap();
        set_root_config_field(dir.path(), "file", "AGENTS.md").unwrap();
        set_root_config_field(dir.path(), "command", "codex --full-auto").unwrap();

        let tree = scan_root(dir.path());
        let agent = tree.contexts[0].agent.as_ref().unwrap();
        assert_eq!(agent.profile.as_deref(), Some("codex"));
        assert_eq!(agent.file.as_deref(), Some("AGENTS.md"));
        assert_eq!(agent.command.as_deref(), Some("codex --full-auto"));

        assert!(set_root_config_field(dir.path(), "version", "9").is_err(), "unknown key");
        assert!(set_root_config_field(dir.path(), "profile", "").is_err(), "empty value");
        assert!(set_root_config_field(dir.path(), "profile", "a\nb").is_err(), "newline");
    }

    #[test]
    fn set_root_config_field_preserves_comments_and_key_order() {
        let dir = tempfile::tempdir().unwrap();
        let g = dir.path().join(GAVIN_ROOT_DIR);
        std::fs::create_dir_all(&g).unwrap();
        std::fs::write(
            g.join("config.toml"),
            "# hand-written, keep me\nversion = 1\nname = \"Mine\"\n\n[agent]\n# and me\nprofile = \"claude-code\"\n",
        )
        .unwrap();

        set_root_config_field(dir.path(), "command", "claude --model opus").unwrap();

        let after = std::fs::read_to_string(g.join("config.toml")).unwrap();
        assert!(after.contains("# hand-written, keep me"));
        assert!(after.contains("# and me"));
        assert!(after.contains("name = \"Mine\""));
        assert!(after.contains("command = \"claude --model opus\""));
    }

    #[test]
    fn set_root_config_field_creates_the_agent_table_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        let g = dir.path().join(GAVIN_ROOT_DIR);
        std::fs::create_dir_all(&g).unwrap();
        std::fs::write(g.join("config.toml"), "version = 1\n").unwrap();

        set_root_config_field(dir.path(), "profile", "gemini").unwrap();

        let tree = scan_root(dir.path());
        assert_eq!(tree.contexts[0].agent.as_ref().unwrap().profile.as_deref(), Some("gemini"));
    }

    #[test]
    fn set_root_config_field_refuses_an_unparseable_file_rather_than_clobbering_it() {
        let dir = tempfile::tempdir().unwrap();
        let g = dir.path().join(GAVIN_ROOT_DIR);
        std::fs::create_dir_all(&g).unwrap();
        std::fs::write(g.join("config.toml"), "this is not [ valid toml\n").unwrap();

        assert!(set_root_config_field(dir.path(), "profile", "codex").is_err());
        assert_eq!(
            std::fs::read_to_string(g.join("config.toml")).unwrap(),
            "this is not [ valid toml\n",
            "the file must survive untouched"
        );
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
        // the next read times out instead of yielding a message. (This
        // one is the burst's free rescan, so it does not sleep.)
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

    // --- watch set + relevance (fs-sync) ---------------------------------

    fn names(root: &Path) -> Vec<(String, bool)> {
        let mut v: Vec<(String, bool)> = watch_targets(root)
            .into_iter()
            .map(|(p, mode)| {
                let rel = p.strip_prefix(root).unwrap().to_string_lossy().to_string();
                (if rel.is_empty() { ".".to_string() } else { rel }, mode == notify::RecursiveMode::Recursive)
            })
            .collect();
        v.sort();
        v
    }

    #[test]
    fn watch_targets_covers_the_scanned_dirs_and_skips_the_churny_ones() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join(GAVIN_ROOT_DIR).join("plans")).unwrap();
        std::fs::create_dir_all(root.join("packages").join("api").join(GAVIN_DIR)).unwrap();
        // Everything the scanner refuses to descend into.
        for skipped in ["node_modules/deep/deeper", "target/debug/build", ".git/refs", ".cache"] {
            std::fs::create_dir_all(root.join(skipped)).unwrap();
        }

        let targets = names(&root);

        assert!(targets.contains(&(".".to_string(), false)), "{targets:?}");
        assert!(targets.contains(&("packages".to_string(), false)), "{targets:?}");
        assert!(targets.contains(&("packages/api".to_string(), false)), "{targets:?}");
        // Marker directories get the recursive watch -- plans/ churns.
        assert!(targets.contains(&(GAVIN_ROOT_DIR.to_string(), true)), "{targets:?}");
        assert!(targets.contains(&("packages/api/.gavin".to_string(), true)), "{targets:?}");
        // ...and the scanner's own skips are never watched at all.
        for skipped in ["node_modules", "target", ".git", ".cache"] {
            assert!(
                !targets.iter().any(|(p, _)| p == skipped || p.starts_with(&format!("{skipped}/"))),
                "{skipped} should not be watched: {targets:?}"
            );
        }
        // A marker directory is watched recursively, so its children are
        // covered without their own entries.
        assert!(!targets.iter().any(|(p, _)| p == ".gavin-root/plans"), "{targets:?}");
    }

    #[test]
    fn a_missing_root_watches_only_itself_never_its_parent() {
        // Its own entry is how a root renamed away is noticed coming
        // back; its parent is never watched, because a workspace root's
        // parent is routinely a folder full of unrelated projects.
        let targets = watch_targets(Path::new("/definitely/not/real"));
        let paths: Vec<&Path> = targets.iter().map(|(p, _)| p.as_path()).collect();
        assert_eq!(paths, vec![Path::new("/definitely/not/real")]);
    }

    #[test]
    fn the_roots_own_watch_is_never_dropped_while_the_root_is_gone() {
        // The regression guard for renaming the root away and back: if
        // the root left `watch_targets` when it vanished, `sync_watches`
        // would unwatch it and nothing would ever see it return.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap().join("ws");
        std::fs::create_dir(&root).unwrap();
        assert!(watch_targets(&root).iter().any(|(p, _)| *p == root));
        std::fs::remove_dir(&root).unwrap();
        assert!(watch_targets(&root).iter().any(|(p, _)| *p == root));
    }

    fn tree_with_context(folder: &str) -> GavinTree {
        GavinTree {
            root_path: "/r".to_string(),
            root_missing: false,
            contexts: vec![GavinContext {
                name: "api".to_string(),
                folder_path: folder.to_string(),
                kind: GavinContextKind::Context,
                outside: false,
                has_prd: false,
                config_warning: false,
                agent: None,
                plans: vec![],
                docs: vec![],
                specs: vec![],
            }],
        }
    }

    #[test]
    fn a_folder_that_moved_in_is_relevant_even_though_no_path_says_gavin() {
        // The regression this card exists for: `mv ~/elsewhere/api
        // packages/api` reports only `<root>/packages/api`, and the old
        // ".gavin somewhere in the path" rule dropped it.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let moved_in = root.join("packages").join("api");
        std::fs::create_dir_all(moved_in.join(GAVIN_DIR)).unwrap();

        assert!(tree_relevant(&root, None, &moved_in));
    }

    #[test]
    fn a_folder_that_moved_away_is_relevant_because_a_known_context_lived_there() {
        let root = Path::new("/r");
        let gone = Path::new("/r/packages/api");
        let tree = tree_with_context("/r/packages/api");

        // The context's own folder, and any ancestor of it, both count --
        // `mv packages elsewhere` reports only `/r/packages`.
        assert!(tree_relevant(root, Some(&tree), gone));
        assert!(tree_relevant(root, Some(&tree), Path::new("/r/packages")));
        // A sibling that never held a context does not.
        assert!(!tree_relevant(root, Some(&tree), Path::new("/r/packages/web")));
        // Neither does a near-miss prefix: the match is by path component,
        // not by string.
        assert!(!tree_relevant(root, Some(&tree), Path::new("/r/packages/ap")));
        // With no tree yet there is nothing to have vanished.
        assert!(!tree_relevant(root, None, gone));
    }

    #[test]
    fn ordinary_file_churn_outside_a_marker_directory_is_irrelevant() {
        let root = Path::new("/r");
        let tree = tree_with_context("/r/packages/api");
        for quiet in [
            "/r/src/lib/Foo.svelte",
            "/r/README.md",
            "/r/packages/api/src/main.rs",
            "/r/.DS_Store",
            "/r/.gitignore",
        ] {
            assert!(!tree_relevant(root, Some(&tree), Path::new(quiet)), "{quiet}");
        }
    }

    #[test]
    fn the_scanners_skipped_directories_are_never_relevant() {
        let root = Path::new("/r");
        for churn in [
            "/r/target/debug/build/foo-123/out",
            "/r/node_modules/.bin/tsc",
            "/r/.git/refs/heads/main",
            "/r/app/node_modules/pkg/dist/index.js",
            "/r/.venv/lib/python3.12",
        ] {
            assert!(!tree_relevant(root, None, Path::new(churn)), "{churn}");
        }
    }

    #[test]
    fn marker_paths_and_the_root_itself_stay_relevant() {
        let root = Path::new("/r");
        assert!(tree_relevant(root, None, root));
        assert!(tree_relevant(root, None, Path::new("/r/.gavin-root/plans/auth.md")));
        assert!(tree_relevant(root, None, Path::new("/r/packages/api/.gavin/config.toml")));
        // Outside the root: only reachable through a watch of ours, so
        // it means a watched subtree was moved away -- relevant.
        assert!(tree_relevant(root, None, Path::new("/elsewhere/api/.gavin/plans/a.md")));
    }

    #[test]
    fn the_first_rescan_after_a_quiet_period_never_waits() {
        // Position 0 is the very first scan of all; position 1 is the
        // first flush after a quiet gap. Both go straight through.
        assert_eq!(burst_position(None, 7), 0);
        assert_eq!(floor_wait(None, 0), Duration::ZERO);
        assert_eq!(burst_position(Some(QUIET_PERIOD), 7), 0);
        assert_eq!(floor_wait(Some(Duration::from_millis(20)), 1), Duration::ZERO);
    }

    #[test]
    fn a_sustained_burst_is_floored_to_one_rescan_per_interval() {
        // Second flush inside the same burst, 300ms after the last scan:
        // sleeps out the rest of the 2s floor.
        assert_eq!(burst_position(Some(Duration::from_millis(300)), 1), 2);
        assert_eq!(
            floor_wait(Some(Duration::from_millis(300)), 2),
            MIN_RESCAN_INTERVAL - Duration::from_millis(300)
        );
        // A flush that already waited past the floor does not wait again.
        assert_eq!(floor_wait(Some(MIN_RESCAN_INTERVAL), 9), Duration::ZERO);
        // The burst keeps deepening while the gaps stay short, so the
        // floor keeps applying...
        assert_eq!(burst_position(Some(Duration::from_millis(10)), 2), 3);
        // ...until one quiet gap ends it.
        assert_eq!(burst_position(Some(QUIET_PERIOD + Duration::from_millis(1)), 3), 0);
    }

    #[test]
    fn renaming_a_context_folder_pushes_a_tree_with_the_new_name() {
        use std::io::BufReader;

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        init_gavin_root(&root, "WS").unwrap();
        std::fs::create_dir_all(root.join("packages").join("api").join(GAVIN_DIR)).unwrap();

        let (ours, theirs) = UnixStream::pair().unwrap();
        ours.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let _watcher =
            GavinWatcher::start("ws-1".to_string(), root.clone(), Arc::new(Mutex::new(theirs)));

        let mut reader = BufReader::new(ours);
        let first: Option<Response> = protocol::read_message(&mut reader).unwrap();
        match first {
            Some(Response::GavinTreeChanged { tree, .. }) => {
                assert!(tree.contexts.iter().any(|c| c.name == "api"), "{:?}", tree.contexts);
            }
            other => panic!("expected the initial push, got {other:?}"),
        }

        // The regression: neither reported path carries a `.gavin`
        // segment, so the old filter dropped this rename entirely.
        std::fs::rename(root.join("packages").join("api"), root.join("packages").join("core"))
            .unwrap();

        let second: Option<Response> = protocol::read_message(&mut reader).unwrap();
        match second {
            Some(Response::GavinTreeChanged { tree, .. }) => {
                assert!(
                    tree.contexts.iter().any(|c| c.name == "core"),
                    "renamed context missing: {:?}",
                    tree.contexts
                );
                assert!(
                    !tree.contexts.iter().any(|c| c.name == "api"),
                    "stale context survived: {:?}",
                    tree.contexts
                );
            }
            other => panic!("expected a push for the folder rename, got {other:?}"),
        }
    }

    #[test]
    fn deleting_a_context_folder_pushes_a_tree_without_it() {
        use std::io::BufReader;

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        init_gavin_root(&root, "WS").unwrap();
        std::fs::create_dir_all(root.join("lib").join(GAVIN_DIR)).unwrap();

        let (ours, theirs) = UnixStream::pair().unwrap();
        ours.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let _watcher =
            GavinWatcher::start("ws-1".to_string(), root.clone(), Arc::new(Mutex::new(theirs)));

        let mut reader = BufReader::new(ours);
        let _first: Option<Response> = protocol::read_message(&mut reader).unwrap();

        // Moving the folder OUT of the root is the harder half of a
        // delete: nothing under it is ever reported, only the folder.
        let elsewhere = tempfile::tempdir().unwrap();
        std::fs::rename(root.join("lib"), elsewhere.path().join("lib")).unwrap();

        let second: Option<Response> = protocol::read_message(&mut reader).unwrap();
        match second {
            Some(Response::GavinTreeChanged { tree, .. }) => {
                assert_eq!(tree.contexts.len(), 1, "{:?}", tree.contexts);
                assert!(matches!(tree.contexts[0].kind, GavinContextKind::Root));
            }
            other => panic!("expected a push for the folder move, got {other:?}"),
        }
    }

    #[test]
    fn a_new_folder_picks_up_its_own_watch_on_the_next_rescan() {
        // The watch set is non-recursive per directory, so a folder that
        // appears after the watcher started must be armed by the very
        // rescan its own creation triggers -- otherwise a `.gavin`
        // created inside it a moment later lands in a blind spot.
        //
        // Asserted against the registered set rather than a second
        // filesystem event: the mechanism is what this pins, and racing
        // FSEvents twice in one test is how you get a suite that fails
        // only under load.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        init_gavin_root(&root, "WS").unwrap();

        let (_ours, theirs) = UnixStream::pair().unwrap();
        let watcher =
            GavinWatcher::start("ws-1".to_string(), root.clone(), Arc::new(Mutex::new(theirs)));
        assert!(watcher.watched_paths().contains(&root), "the root is always watched");
        assert!(!watcher.watched_paths().contains(&root.join("services")));

        std::fs::create_dir(root.join("services")).unwrap();
        watcher.rescan_and_push();

        assert!(
            watcher.watched_paths().contains(&root.join("services")),
            "a new folder was left unwatched: {:?}",
            watcher.watched_paths()
        );
    }

    #[test]
    fn a_folder_that_left_gives_its_watch_back() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        init_gavin_root(&root, "WS").unwrap();
        std::fs::create_dir(root.join("services")).unwrap();

        let (_ours, theirs) = UnixStream::pair().unwrap();
        let watcher =
            GavinWatcher::start("ws-1".to_string(), root.clone(), Arc::new(Mutex::new(theirs)));
        assert!(watcher.watched_paths().contains(&root.join("services")));

        std::fs::remove_dir(root.join("services")).unwrap();
        watcher.rescan_and_push();

        assert!(!watcher.watched_paths().contains(&root.join("services")));
        // ...but never the root's own, which is what sees it come back.
        assert!(watcher.watched_paths().contains(&root));
    }

    // --- archive-on-Done (plans/done/) ------------------------------------

    /// Writes a plan file and returns its path.
    fn write_card(dir: &std::path::Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn done_status_moves_the_file_into_done_and_back_out() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let plans = dir.path().join(GAVIN_ROOT_DIR).join("plans");
        let card = write_card(&plans, "ship.md", "---\ntitle: Ship\nstatus: To Do\n---\nbody\n");

        let moved = set_plan_field(&card, "status", "Done").unwrap();
        assert_eq!(moved, plans.join("done").join("ship.md"));
        assert!(!card.exists());
        assert_eq!(
            std::fs::read_to_string(&moved).unwrap(),
            "---\ntitle: Ship\nstatus: Done\n---\nbody\n"
        );

        // ...and back out again.
        let back = set_plan_field(&moved, "status", "In Progress").unwrap();
        assert_eq!(back, plans.join("ship.md"));
        assert!(!moved.exists());
    }

    /// Contexts are not special-cased: `is_plans_dir` keys on a `.gavin*`
    /// marker, so a nested `.gavin/plans/` archives exactly like the
    /// root's. Pinned because every other test here uses GAVIN_ROOT_DIR,
    /// and a rule that quietly only worked at the root would leave every
    /// sub-context's plans folder as cluttered as before.
    #[test]
    fn a_nested_gavin_context_archives_the_same_way_the_root_does() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let plans = dir.path().join("app").join(GAVIN_DIR).join("plans");
        let card = write_card(&plans, "tokens.md", "---\ntitle: Tokens\nstatus: To Do\n---\nb\n");
        let child = write_card(&plans, "step.md", "---\nkind: task\ntitle: Step\nparent: tokens.md\n---\nb\n");

        let moved = set_plan_field(&card, "status", "Done").unwrap();
        assert_eq!(moved, plans.join("done").join("tokens.md"));
        // The nested child travels with it here too.
        assert!(plans.join("done").join("step.md").exists());
        assert!(!child.exists());

        let back = set_plan_field(&moved, "status", "To Do").unwrap();
        assert_eq!(back, plans.join("tokens.md"));
        assert!(plans.join("step.md").exists());
    }

    #[test]
    fn done_matching_is_by_slug_and_only_done_archives() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let plans = dir.path().join(GAVIN_ROOT_DIR).join("plans");

        let lower = write_card(&plans, "a.md", "---\ntitle: A\n---\n");
        assert_eq!(set_plan_field(&lower, "status", "done").unwrap(), plans.join("done").join("a.md"));
        let spaced = write_card(&plans, "b.md", "---\ntitle: B\n---\n");
        assert_eq!(set_plan_field(&spaced, "status", " DONE ").unwrap(), plans.join("done").join("b.md"));

        // Every other terminal-sounding column stays flat.
        let shipped = write_card(&plans, "c.md", "---\ntitle: C\n---\n");
        assert_eq!(set_plan_field(&shipped, "status", "Shipped").unwrap(), shipped);
        let cancelled = write_card(&plans, "d.md", "---\ntitle: D\n---\n");
        assert_eq!(set_plan_field(&cancelled, "status", "Cancelled").unwrap(), cancelled);
        assert!(shipped.exists() && cancelled.exists());
    }

    #[test]
    fn nested_children_travel_with_their_parent() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let plans = dir.path().join(GAVIN_ROOT_DIR).join("plans");
        let plan = write_card(&plans, "big.md", "---\ntitle: Big\nstatus: To Do\n---\n");
        let nested = write_card(&plans, "step.md", "---\nkind: task\ntitle: Step\nparent: big.md\n---\n");
        // A child with its own status is a free-standing card: it stays.
        let standing =
            write_card(&plans, "own.md", "---\nkind: task\ntitle: Own\nparent: big.md\nstatus: To Do\n---\n");
        // A task parented elsewhere is untouched.
        let other = write_card(&plans, "other.md", "---\nkind: task\ntitle: O\nparent: small.md\n---\n");

        set_plan_field(&plan, "status", "Done").unwrap();
        assert!(plans.join("done").join("step.md").is_file());
        assert!(!nested.exists());
        assert!(standing.exists());
        assert!(other.exists());

        // Back out: the child follows again.
        set_plan_field(&plans.join("done").join("big.md"), "status", "To Do").unwrap();
        assert!(nested.is_file());
        assert!(!plans.join("done").join("step.md").exists());
    }

    #[test]
    fn a_nested_child_stays_with_its_archived_parent_on_its_own_writes() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let plans = dir.path().join(GAVIN_ROOT_DIR).join("plans");
        let plan = write_card(&plans, "big.md", "---\ntitle: Big\nstatus: To Do\n---\n");
        write_card(&plans, "step.md", "---\nkind: task\ntitle: Step\nparent: big.md\n---\n");
        set_plan_field(&plan, "status", "Done").unwrap();

        // The child has no status of its own -- writing any other field must
        // not tear it back out of done/ (its home is wherever its parent is).
        let child = plans.join("done").join("step.md");
        assert_eq!(set_plan_field(&child, "labels", "bug").unwrap(), child);
        assert!(child.is_file());

        // Giving it a status makes it free-standing: it leaves done/.
        assert_eq!(set_plan_field(&child, "status", "To Do").unwrap(), plans.join("step.md"));
    }

    #[test]
    fn a_name_collision_leaves_the_file_in_place_and_still_writes_status() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let plans = dir.path().join(GAVIN_ROOT_DIR).join("plans");
        write_card(&plans.join("done"), "dup.md", "---\ntitle: Old\nstatus: Done\n---\n");
        let card = write_card(&plans, "dup.md", "---\ntitle: New\nstatus: To Do\n---\n");

        assert_eq!(set_plan_field(&card, "status", "Done").unwrap(), card);
        assert_eq!(
            std::fs::read_to_string(&card).unwrap(),
            "---\ntitle: New\nstatus: Done\n---\n"
        );
        assert_eq!(
            std::fs::read_to_string(plans.join("done").join("dup.md")).unwrap(),
            "---\ntitle: Old\nstatus: Done\n---\n"
        );
    }

    #[test]
    fn hand_made_subfolders_are_never_flattened() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let plans = dir.path().join(GAVIN_ROOT_DIR).join("plans");
        let filed = write_card(&plans.join("roadmap"), "q3.md", "---\ntitle: Q3\n---\n");
        assert_eq!(set_plan_field(&filed, "status", "Done").unwrap(), filed);
        assert_eq!(set_plan_field(&filed, "status", "To Do").unwrap(), filed);
        assert!(filed.is_file());
    }

    #[test]
    fn plan_files_outside_a_plans_folder_are_never_moved() {
        let dir = tempfile::tempdir().unwrap();
        let loose = write_card(dir.path(), "p.md", "---\ntitle: P\n---\n");
        assert_eq!(set_plan_field(&loose, "status", "Done").unwrap(), loose);
        assert!(loose.is_file());
    }

    #[test]
    fn create_plan_file_places_done_cards_and_children_correctly() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let plans = dir.path().join(GAVIN_ROOT_DIR).join("plans");

        let done =
            create_plan_file(dir.path(), "shipped.md", "Shipped", Some("Done"), None, None, None, None)
                .unwrap();
        assert_eq!(done, plans.join("done").join("shipped.md"));

        // A nested child of an archived plan is created beside its parent.
        let child = create_plan_file(
            dir.path(),
            "sub.md",
            "Sub",
            None,
            None,
            None,
            Some("task"),
            Some("shipped.md"),
        )
        .unwrap();
        assert_eq!(child, plans.join("done").join("sub.md"));

        // A file name already used anywhere in the tree is refused.
        assert!(
            create_plan_file(dir.path(), "shipped.md", "Again", None, None, None, None, None).is_err()
        );
    }

    #[test]
    fn promote_checklist_item_works_from_an_archived_plan() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let plans = dir.path().join(GAVIN_ROOT_DIR).join("plans");
        let plan = write_card(
            &plans.join("done"),
            "big.md",
            "---\ntitle: Big\nstatus: Done\n---\n- [ ] Ship the API\n",
        );

        let child = promote_checklist_item(&plan, "Ship the API").unwrap();
        assert_eq!(child, plans.join("done").join("ship-the-api.md"));
        assert!(
            std::fs::read_to_string(&plan).unwrap().contains("- [ ] [Ship the API](./ship-the-api.md)")
        );

        // The suffix check spans the whole tree, not one folder: a flat
        // file of that name must still push the new card to -2.
        write_card(&plans, "second.md", "x");
        std::fs::write(plans.join("done").join("big.md"), "---\ntitle: Big\nstatus: Done\n---\n- [ ] Second\n")
            .unwrap();
        let child2 = promote_checklist_item(&plan, "Second").unwrap();
        assert_eq!(child2, plans.join("done").join("second-2.md"));
    }

    #[test]
    fn delete_card_file_accepts_an_archived_card() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let plans = dir.path().join(GAVIN_ROOT_DIR).join("plans");
        let card = write_card(&plans.join("done"), "gone.md", "---\ntitle: G\n---\n");
        delete_card_file(&card).unwrap();
        assert!(!card.exists());
    }
}
