use protocol::{
    AgentConfig, CardKind, Complexity, GavinContext, GavinContextKind, GavinTree, HumanItem,
    HumanItemKind, HumanItemOutcome, HumanItemState, MdFileInfo, PlanFileInfo, Priority, Response,
};
use std::collections::{BTreeMap, HashMap, HashSet};
use protocol::transport::Stream;
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

/// The `[worktree]` block is scaffolded COMMENTED OUT: it is the one key
/// here that gavin cannot guess, and a config.toml that never mentions it
/// leaves the feature undiscoverable to anyone who hasn't read the source.
/// Left commented rather than seeded with `setup = []` so that "no setup
/// declared" stays the absence of a declaration and not an empty one.
const ROOT_CONFIG_TEMPLATE: &str = "version = 1\n\n[agent]\nprofile = \"claude-code\"\n\n\
# What a worktree gavin creates has to run before anyone can work in it.\n\
# The commands run chained with `&&` in one visible session in the new\n\
# worktree, and an agent started there waits for them to finish.\n\
# [worktree]\n\
# setup = [\"npm install\"]\n";

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
    // Split exactly like labels, and kept RAW: an entry that does not
    // resolve -- a moved file, a hand-typed `..` -- has to survive the
    // scan so the card can show it as broken and the run gate can refuse
    // to spawn on it. Validating here would drop it instead, and an
    // attachment that silently disappears is the failure this whole
    // field exists to prevent. Parsed on every card kind (a note is a
    // fine place to park a reference); only task and plan cards put it
    // in a prompt.
    let attachments: Vec<String> = get("attachments")
        .map(|raw| {
            raw.split(',')
                .map(|a| a.trim().to_string())
                .filter(|a| !a.is_empty())
                .collect()
        })
        .unwrap_or_default();
    // Unreadable degrades to None PLUS a warning, unlike `labels` and
    // `attachments` which keep whatever junk was written. Those two are
    // shown back to the human as text; this one is READ BY GAVIN to pick
    // an agent, so a level it cannot parse has to be absent rather than
    // approximated -- and the card has to say so, or a typo would quietly
    // run every card at the workspace default.
    let complexity = match get("complexity") {
        None => None,
        Some(raw) => {
            let parsed = Complexity::parse(&raw);
            if parsed.is_none() {
                warning = true;
            }
            parsed
        }
    };
    // The other half of the same question `complexity` asks, said
    // outright instead of through a level: which agent, at which model,
    // runs THIS card. Kept raw and unvalidated, which is the `attachments`
    // posture rather than the `complexity` one -- the profile table lives
    // in the Tauri host and the model names belong to whichever CLI is
    // installed, so there is nothing here to check either value against,
    // and a rule invented at this layer would refuse writes the app knows
    // are fine. A name the app cannot resolve reads back as itself on the
    // card, which is what makes a typo visible rather than silent.
    //
    // Parsed on every kind, like `complexity` and for the same reason: a
    // note is a fine place to record that something will need the big
    // model, even though nothing will ever run it.
    let agent = get("agent").map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    let model = get("model").map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    let (checklist_done, checklist_total) = checklist_counts(content);
    PlanFileInfo {
        path: protocol::wire_path(path),
        modified_at: file_modified_at(path),
        file_name,
        title: get("title").unwrap_or(stem),
        status: get("status"),
        priority,
        order,
        kind,
        parent,
        labels,
        attachments,
        complexity,
        agent,
        model,
        checklist_done,
        checklist_total,
        parse_warning: warning,
        // Always `Some` from here: this daemon DID look. `None` is
        // reserved for the two honest "never looked" cases -- an older
        // daemon that has no such field at all, and the oversize card
        // below whose body was never read.
        human_items: Some(human_items(content)),
    }
}

/// The file's mtime as whole seconds since the unix epoch. None for a
/// path that can't be stat'd (a fabricated path in a test, a file
/// deleted between the listing and the read) and for the pre-1970 clocks
/// that would make the duration negative -- neither is worth failing a
/// scan over, and the archive grid treats None as "sorts last".
fn file_modified_at(path: &Path) -> Option<i64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let secs = modified.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
    i64::try_from(secs).ok()
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

// ---------- human items (the Decisions tab) ----------
//
// A card's checklist is where an agent says what it cannot settle on its
// own, and where the human's answer is written back. Everything in this
// section works off the SAME reading of the file -- one fence map, one
// body start, one "what is attached under this item" rule -- because the
// parse and the two writes disagreeing about which lines belong to an
// item is precisely how an answer would land under the wrong question.

/// The `Options:` line's keyword, and the three lines that record an
/// outcome. Spelled once so the writers and the parser cannot drift.
const OPTIONS_PREFIX: &str = "Options:";
const ANSWER_PREFIX: &str = "Answer (";
const RESULT_PREFIX: &str = "Result (";
const REARM_PREFIX: &str = "Ready for re-test (";

/// Which lines of `content` sit inside a fenced code block, indexed like
/// `content.lines()`.
///
/// A checklist line inside a fence is documentation OF a marker, not a
/// marker: every spec in `docs/superpowers/` that explains this feature
/// shows `- [ ] Decision: …` in a fence, and a parser that could not tell
/// the two apart would file the spec's examples as real questions on
/// whatever card quoted them.
///
/// The opening fence's character and length are remembered so a longer
/// run can close a shorter one and a `~~~` cannot close a ``` -- the
/// CommonMark rule, and the one that keeps a fenced block containing
/// backticks from ending early.
fn fenced_lines(content: &str) -> Vec<bool> {
    let mut out = Vec::new();
    let mut open: Option<(char, usize)> = None;
    for line in content.lines() {
        let t = line.trim_start();
        let fence = fence_marker(t);
        match (&open, fence) {
            // Inside a fence: the fence line that CLOSES it is itself
            // fenced, so a stray `- [ ] x` can never hide as one.
            (Some((ch, len)), Some((fch, flen, info_empty)))
                if fch == *ch && flen >= *len && info_empty =>
            {
                out.push(true);
                open = None;
            }
            (Some(_), _) => out.push(true),
            (None, Some((fch, flen, _))) => {
                out.push(true);
                open = Some((fch, flen));
            }
            (None, None) => out.push(false),
        }
    }
    out
}

/// `(fence char, run length, info string is empty)` for a line that opens
/// or closes a fence, else None.
fn fence_marker(trimmed: &str) -> Option<(char, usize, bool)> {
    let ch = trimmed.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let len = trimmed.chars().take_while(|c| *c == ch).count();
    if len < 3 {
        return None;
    }
    let info = trimmed[len..].trim();
    // A ``` info string may not itself contain a backtick (CommonMark);
    // ~~~ has no such rule. Not worth reproducing -- what matters here is
    // only whether the line can CLOSE a fence, which needs an empty one.
    Some((ch, len, info.is_empty()))
}

/// The first BODY line index -- everything after the frontmatter's
/// closing marker. `None` when an opening `---` is never closed, which is
/// exactly how `checklist_counts` reads that file: no body at all.
fn body_start(content: &str) -> Option<usize> {
    let mut lines = content.lines();
    if lines.next() != Some("---") {
        return Some(0);
    }
    for (offset, line) in lines.enumerate() {
        if line == "---" {
            return Some(offset + 2);
        }
    }
    None
}

/// The marker a checklist item carries, if it carries one: the kind it
/// names and the text after the colon.
///
/// `Decision:` and `Human test:` are what gavin writes. The rest are
/// spellings already on cards before this feature existed -- `Human:`,
/// `Human, on the other machine:`, `Owner check in the running app:`,
/// `Manual smoke:` -- and they all mean the same thing: a check only a
/// person can run. Reading them is what keeps the tab from showing an
/// empty list on a workspace whose cards are full of them.
///
/// The match is on the FIRST WORD before the colon, not a prefix of the
/// line, which is what keeps `Manually rewrite the parser: …` and
/// `Human-readable output: …` out: both start with the right letters and
/// neither is asking anything of anybody. The colon also has to arrive
/// within `MAX_MARKER_BYTES`, so a sentence that happens to contain one
/// much later cannot be read as a very long marker.
fn human_marker(text: &str) -> Option<(HumanItemKind, &str)> {
    /// Long enough for every spelling above (`Owner check in the running
    /// app` is 30) and far short of a sentence.
    const MAX_MARKER_BYTES: usize = 40;

    // Walked by chars, not sliced by bytes: a card's text is routinely
    // not ASCII, and a byte window that lands inside a multi-byte
    // character would drop the whole item rather than shorten the search.
    let colon = text
        .char_indices()
        .take_while(|(i, _)| *i < MAX_MARKER_BYTES)
        .find(|(_, c)| *c == ':')
        .map(|(i, _)| i)?;
    let marker = text[..colon].trim();
    let rest = text[colon + 1..].trim();
    let lower = marker.to_ascii_lowercase();
    // The first word, with a trailing comma dropped: `Human,` and
    // `Owner,` are the same word as `Human` and `Owner`.
    let first = lower.split_whitespace().next()?.trim_end_matches(',');
    let kind = match (lower.as_str(), first) {
        ("decision", _) => HumanItemKind::Decision,
        ("human test", _) => HumanItemKind::Test,
        // A bare `Human:`, or `Human, <where>:`. NOT `Human-readable`:
        // the trim above only drops a comma, so the first word there is
        // still `human-readable`.
        (_, "human") | (_, "owner") | (_, "manual") => HumanItemKind::Test,
        _ => return None,
    };
    Some((kind, rest))
}

/// One index past the last line ATTACHED to the item at `item`: the
/// indented continuation that belongs to it -- its `Options:` line, every
/// answer and result written under it, and any wrapped prose.
///
/// The block ends at the first line that is blank, no more indented than
/// the item itself, a checklist item of its own (a nested `- [ ]` is a
/// sibling's business, not this item's), or inside a fence. Deliberately
/// the same rule for reading and for writing: an answer appended anywhere
/// but the end of this block would read back as belonging to a different
/// item, and the parse would be right and the write wrong.
fn attached_block_end(lines: &[&str], fenced: &[bool], item: usize, indent: usize) -> usize {
    let mut end = item + 1;
    while end < lines.len() {
        let line = lines[end];
        if fenced[end] || line.trim().is_empty() {
            break;
        }
        let line_indent = line.len() - line.trim_start().len();
        if line_indent <= indent || split_checklist_line(line).is_some() {
            break;
        }
        end += 1;
    }
    end
}

/// Splits an `Options:` line's remainder into the choices it offers.
///
/// `A) keep it B) drop it` is the shape `file_human_item` writes and the
/// one the interview settled on, so labelled segments win. A line with no
/// labels falls back to `|` and then to one whole option, rather than to
/// a comma split: an option is a phrase a human wrote, and phrases have
/// commas in them.
fn split_options(rest: &str) -> Vec<String> {
    let rest = rest.trim();
    if rest.is_empty() {
        return Vec::new();
    }
    let mut cuts: Vec<usize> = Vec::new();
    let bytes = rest.as_bytes();
    for (i, w) in bytes.windows(3).enumerate() {
        let at_boundary = i == 0 || bytes[i - 1].is_ascii_whitespace();
        let labelled = w[0].is_ascii_alphanumeric()
            && (w[1] == b')' || w[1] == b'.')
            && w[2].is_ascii_whitespace();
        if at_boundary && labelled {
            cuts.push(i);
        }
    }
    if !cuts.is_empty() {
        let mut out = Vec::new();
        for (n, start) in cuts.iter().enumerate() {
            let end = cuts.get(n + 1).copied().unwrap_or(rest.len());
            let choice = rest[start + 2..end].trim();
            if !choice.is_empty() {
                out.push(choice.to_string());
            }
        }
        return out;
    }
    if rest.contains('|') {
        return rest.split('|').map(|o| o.trim().to_string()).filter(|o| !o.is_empty()).collect();
    }
    vec![rest.to_string()]
}

/// The state an `Answer (…)` / `Result (…)` / `Ready for re-test (…)`
/// line implies, or None for an attached line that records no outcome at
/// all (an `Options:` line, wrapped prose).
///
/// A `Result` line that says neither passed nor failed is deliberately
/// NOT a state line: the alternative is guessing, and both guesses are
/// wrong in a way that matters -- "passed" hides a check nobody ran, and
/// "failed" hands it back to an agent that did nothing wrong. Falling
/// through leaves the item reading as whatever the line before it said,
/// which for an untouched item is `Open`: still waiting on the human,
/// which is where a line nobody can read belongs.
fn outcome_state(line: &str) -> Option<HumanItemState> {
    let line = line.trim();
    if starts_with_ignore_case(line, ANSWER_PREFIX) {
        return Some(HumanItemState::Answered);
    }
    if starts_with_ignore_case(line, REARM_PREFIX) {
        return Some(HumanItemState::Open);
    }
    if starts_with_ignore_case(line, RESULT_PREFIX) {
        let verdict = line.split_once("):").map(|(_, v)| v.trim().to_ascii_lowercase())?;
        if verdict.starts_with("passed") {
            return Some(HumanItemState::Passed);
        }
        if verdict.starts_with("failed") {
            return Some(HumanItemState::Failed);
        }
    }
    None
}

/// `str::get` rather than a length check and a slice: the prefixes here
/// are ASCII but the lines they are tested against are not, and a `..n`
/// slice landing inside a multi-byte character panics. `get` answers
/// None there, which is also the right answer -- a line whose eighth byte
/// is the middle of an em dash does not start with `Result (`.
fn starts_with_ignore_case(line: &str, prefix: &str) -> bool {
    line.get(..prefix.len()).is_some_and(|head| head.eq_ignore_ascii_case(prefix))
}

/// Every `Decision:` / `Human test:` checklist line in a card's body,
/// with what has been written under it.
///
/// Body only, like `checklist_counts` -- a `status: Decision: x`
/// frontmatter line is not a checklist item -- and `line_index` counts
/// from the top of the FILE, because that is the index
/// `SetChecklistItem` addresses lines by.
pub fn human_items(content: &str) -> Vec<HumanItem> {
    let Some(start) = body_start(content) else { return Vec::new() };
    let lines: Vec<&str> = content.lines().collect();
    let fenced = fenced_lines(content);
    let mut out = Vec::new();
    for i in start..lines.len() {
        if fenced[i] {
            continue;
        }
        let Some((indent, mark, rest)) = split_checklist_line(lines[i]) else { continue };
        let Some((kind, text)) = human_marker(rest) else { continue };
        let end = attached_block_end(&lines, &fenced, i, indent);
        let mut options = Vec::new();
        let mut latest = None;
        let mut state = HumanItemState::Open;
        for line in &lines[i + 1..end] {
            let trimmed = line.trim();
            if options.is_empty() && starts_with_ignore_case(trimmed, OPTIONS_PREFIX) {
                options = split_options(&trimmed[OPTIONS_PREFIX.len()..]);
                continue;
            }
            // LAST wins, not first: the lines accumulate, and the one at
            // the bottom is the one that happened most recently.
            if let Some(s) = outcome_state(trimmed) {
                latest = Some(trimmed.to_string());
                state = s;
            }
        }
        out.push(HumanItem {
            kind,
            text: text.to_string(),
            done: mark == 'x',
            options,
            latest,
            state,
            line_text: rest.to_string(),
            line_index: i as u32,
        });
    }
    out
}

/// Appends a `Decision:` / `Human test:` line to a card's checklist, or
/// re-arms an identical failed test. Returns true when it re-armed.
///
/// `today` is passed in rather than read from the clock here so the write
/// is testable without one -- `server.rs` supplies `today()`.
///
/// The new line goes after the LAST checklist item in the body and its
/// attached block, which is what "appends to the card's checklist" means
/// on a card whose body continues past it: a plan card ends with an
/// auto-commit comment, and an item filed below that would sit outside
/// the list the human reads. A card with no checklist at all gets one at
/// the end of the file.
pub fn file_human_item(
    path: &Path,
    kind: HumanItemKind,
    text: &str,
    options: &[String],
    today: &str,
) -> anyhow::Result<bool> {
    let confined = confine_card_path(path)?;
    let path = confined.as_path();
    let text = text.trim();
    if text.is_empty() {
        anyhow::bail!("a human item needs text");
    }
    if text.contains('\n') || text.contains('\r') {
        anyhow::bail!("a human item is one checklist line — it cannot contain a newline");
    }
    let content = std::fs::read_to_string(path)?;
    let had_trailing_newline = content.ends_with('\n');
    let lines: Vec<&str> = content.lines().collect();
    let fenced = fenced_lines(&content);

    // Re-arm rather than duplicate: the agent fixed what the human found
    // broken and is asking for the SAME check again. Tests only -- a
    // decision that was answered and is being asked again is a new
    // question, and the old answer is the record of why.
    if kind == HumanItemKind::Test {
        let failed = human_items(&content).into_iter().filter(|i| {
            i.kind == HumanItemKind::Test
                && i.text == text
                && i.state == HumanItemState::Failed
        });
        // The LAST such item: if a card somehow carries two, the one
        // further down is the one most recently written.
        if let Some(item) = failed.last() {
            let at = item.line_index as usize;
            let indent = lines[at].len() - lines[at].trim_start().len();
            let end = attached_block_end(&lines, &fenced, at, indent);
            let mut out: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
            out.insert(end, format!("{}{REARM_PREFIX}{today})", " ".repeat(indent + 2)));
            write_lines(path, out, had_trailing_newline || content.is_empty())?;
            return Ok(true);
        }
    }

    let marker = match kind {
        HumanItemKind::Decision => "Decision",
        HumanItemKind::Test => "Human test",
    };
    let mut new_lines = vec![format!("- [ ] {marker}: {text}")];
    let options: Vec<&str> = options.iter().map(|o| o.trim()).filter(|o| !o.is_empty()).collect();
    if !options.is_empty() {
        let labelled: Vec<String> = options
            .iter()
            .enumerate()
            .map(|(n, o)| format!("{}) {o}", option_label(n)))
            .collect();
        new_lines.push(format!("  {OPTIONS_PREFIX} {}", labelled.join(" ")));
    }

    let mut out: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
    let body = body_start(&content).unwrap_or(lines.len());
    let last_item = (body..lines.len())
        .rev()
        .find(|i| !fenced[*i] && split_checklist_line(lines[*i]).is_some());
    match last_item {
        Some(i) => {
            let indent = lines[i].len() - lines[i].trim_start().len();
            let at = attached_block_end(&lines, &fenced, i, indent);
            for (n, line) in new_lines.into_iter().enumerate() {
                out.insert(at + n, line);
            }
        }
        None => {
            // No checklist yet. A blank line first, so the new list is
            // not swallowed into whatever paragraph the card ends with.
            if out.last().is_some_and(|l| !l.trim().is_empty()) {
                out.push(String::new());
            }
            out.extend(new_lines);
        }
    }
    write_lines(path, out, had_trailing_newline || content.is_empty())?;
    Ok(false)
}

/// `A`..`Z` then `AA`..: the labels an `Options:` line carries. Past 26
/// the scheme repeats a doubled letter, which is well past any shortlist
/// a person would read and only has to stay unambiguous.
fn option_label(n: usize) -> String {
    let letter = (b'A' + (n % 26) as u8) as char;
    let repeats = n / 26 + 1;
    std::iter::repeat(letter).take(repeats).collect()
}

/// Writes the human's answer under a human item and sets its checkbox.
///
/// `expected_text` is the item line's raw remainder, guarded exactly as
/// `set_checklist_item` guards it, and for the same reason: between the
/// tab rendering a row and the human pressing a button, an agent may
/// have rewritten the card. Two items with identical text are refused as
/// ambiguous rather than resolved by position -- `promote_checklist_item`
/// already takes that line, and guessing here would write an answer under
/// a question nobody asked.
pub fn resolve_human_item(
    path: &Path,
    expected_text: &str,
    outcome: &HumanItemOutcome,
    today: &str,
) -> anyhow::Result<()> {
    let confined = confine_card_path(path)?;
    let path = confined.as_path();
    let content = std::fs::read_to_string(path)?;
    let had_trailing_newline = content.ends_with('\n');
    let lines: Vec<&str> = content.lines().collect();
    let fenced = fenced_lines(&content);

    let matches: Vec<HumanItem> =
        human_items(&content).into_iter().filter(|i| i.line_text == expected_text).collect();
    let item = match matches.len() {
        0 => anyhow::bail!(
            "human item changed on disk — no checklist item reads {expected_text:?} any more"
        ),
        1 => &matches[0],
        n => anyhow::bail!("ambiguous: {n} human items read {expected_text:?}"),
    };

    let (written, checked) = match outcome {
        HumanItemOutcome::Answer { text } => {
            let text = text.trim();
            if text.is_empty() {
                anyhow::bail!("an answer needs text");
            }
            (format!("{ANSWER_PREFIX}{today}): {}", one_line(text)), true)
        }
        HumanItemOutcome::Pass => (format!("{RESULT_PREFIX}{today}): passed"), true),
        // A plain fail leaves the box unticked: the check is still owed,
        // and the note beside it says what the agent has to fix. Fail
        // and close is the human overruling exactly that.
        HumanItemOutcome::Fail { note } => (failed_line(today, note), false),
        HumanItemOutcome::FailAndClose { note } => (failed_line(today, note), true),
    };

    let at = item.line_index as usize;
    let indent = lines[at].len() - lines[at].trim_start().len();
    let end = attached_block_end(&lines, &fenced, at, indent);
    let mut out: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
    out[at] = format!(
        "{}- [{}] {}",
        &lines[at][..indent],
        if checked { 'x' } else { ' ' },
        item.line_text
    );
    out.insert(end, format!("{}{written}", " ".repeat(indent + 2)));
    write_lines(path, out, had_trailing_newline || content.is_empty())
}

fn failed_line(today: &str, note: &str) -> String {
    match note.trim() {
        "" => format!("{RESULT_PREFIX}{today}): failed"),
        note => format!("{RESULT_PREFIX}{today}): failed — {}", one_line(note)),
    }
}

/// A human's free text, flattened to the one line a checklist item can
/// hold. Newlines become spaces rather than being refused: the note comes
/// from a textarea, a stray return in it is not an error, and a write
/// that rejected it would lose the answer entirely.
fn one_line(text: &str) -> String {
    text.split(['\n', '\r']).map(str::trim).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ")
}

/// Joins and writes, preserving the file's trailing-newline habit exactly
/// as `set_checklist_item` does.
fn write_lines(path: &Path, lines: Vec<String>, trailing_newline: bool) -> anyhow::Result<()> {
    let mut rebuilt = lines.join("\n");
    if trailing_newline {
        rebuilt.push('\n');
    }
    std::fs::write(path, rebuilt)?;
    Ok(())
}

/// Today's date as `YYYY-MM-DD`, in the human's OWN timezone.
///
/// Local and not UTC because the only reader is a person looking at their
/// own card: an answer given at nine in the evening in Berlin that reads
/// as tomorrow's date is wrong in the one way this string can be wrong.
/// Both platform calls hand back the civil date directly, so no calendar
/// arithmetic is involved on either; `ymd_from_unix` is the fallback for
/// a target that is neither, and the piece a test can pin.
pub fn today() -> String {
    #[cfg(unix)]
    {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as libc::time_t)
            .unwrap_or(0);
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        // SAFETY: `localtime_r` writes into `tm` and reads `now`; both
        // are owned here and outlive the call. It is the reentrant form
        // precisely because the daemon is threaded.
        if !unsafe { libc::localtime_r(&now, &mut tm) }.is_null() {
            return format!(
                "{:04}-{:02}-{:02}",
                tm.tm_year + 1900,
                tm.tm_mon + 1,
                tm.tm_mday
            );
        }
    }
    #[cfg(windows)]
    {
        // SAFETY: no arguments, no pointers -- windows-rs returns the
        // SYSTEMTIME by value.
        let st = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
        return format!("{:04}-{:02}-{:02}", st.wYear, st.wMonth, st.wDay);
    }
    #[allow(unreachable_code)]
    ymd_from_unix(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0),
    )
}

/// `YYYY-MM-DD` for a UTC instant, by Howard Hinnant's civil-from-days --
/// the inverse of the `days_from_civil` the app already carries, and the
/// same dozen lines against a date crate.
fn ymd_from_unix(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
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

/// The root config's top-level `prd`, when it names a usable path. One
/// parse, shared by `prd_relative_path` and `build_context` -- the tree
/// reports the CONFIGURED value (None where there is none) while every
/// reader wants the RESOLVED one, and those are different answers.
fn parse_prd_path(config_path: &Path) -> Option<String> {
    let content = std::fs::read_to_string(config_path).ok()?;
    let table = content.parse::<toml::Table>().ok()?;
    protocol::usable_prd_path(table.get("prd")?.as_str()?)
}

/// Where this workspace's PRD lives, relative to the root: its configured
/// path, or the scaffolded default. Every daemon-side reader goes through
/// here, so a workspace that pointed gavin at its own `docs/PRD.md` gets
/// the same answer from `gavin_read_prd` and from the board's `has_prd`.
pub fn prd_relative_path(root: &Path) -> String {
    parse_prd_path(&root.join(GAVIN_ROOT_DIR).join("config.toml"))
        .unwrap_or_else(|| protocol::DEFAULT_PRD_PATH.to_string())
}

pub fn read_prd(root: &Path) -> anyhow::Result<String> {
    let prd = root.join(prd_relative_path(root));
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
    attachments: Option<&str>,
    complexity: Option<&str>,
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
    // Same rule as set_plan_field's `attachments`: one line, entries not
    // validated here. A card is allowed to record a path that is wrong;
    // it is the run gate's job to refuse to spawn on one, not this
    // function's job to refuse to file the card.
    let attachments = attachments.map(str::trim).filter(|a| !a.is_empty());
    if attachments.is_some_and(|a| a.contains('\n')) {
        anyhow::bail!("attachments must be a single line");
    }
    // Refused, not dropped, and stored in the enum's own spelling: a
    // card filed with an unreadable complexity would look placed and run
    // at the workspace default, which is the one failure this field
    // exists to prevent.
    let complexity = match complexity.map(str::trim).filter(|c| !c.is_empty()) {
        None => None,
        Some(raw) => Some(
            Complexity::parse(raw)
                .ok_or_else(|| anyhow::anyhow!("invalid complexity value: {raw}"))?,
        ),
    };

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
    if let Some(a) = attachments {
        content.push_str(&format!("attachments: {a}\n"));
    }
    if let Some(c) = complexity {
        content.push_str(&format!("complexity: {}\n", c.as_str()));
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

/// The explicit archive inside a `plans/` directory. Unlike `done/`,
/// nothing files a card here automatically: a human archives it, and it
/// leaves the kanban board until they take it back out. `done/` still
/// means "Done and still on the board" -- the two folders answer
/// different questions and neither replaces the other.
pub const ARCHIVE_DIR: &str = "archive";

/// A status archives iff it slugs to "done" -- the same match the board
/// makes between a card's status and a column name, so "Done", "done" and
/// " DONE " are one status and "Shipped" is not.
fn is_done_status(status: &str) -> bool {
    slug_title(status).as_deref() == Some(DONE_DIR)
}

/// The permanent column that means "a session has this card in hand".
/// Matched the same slugged way `is_done_status` matches Done, so "In
/// Progress", "in progress" and "in-progress" are one status.
///
/// Only this column earns a card<->session binding: a binding is what
/// makes the board stop offering Run, and a backlog card an agent merely
/// FILED must stay startable. Claiming (server.rs) is gated on it.
pub fn is_in_progress_status(status: &str) -> bool {
    slug_title(status).as_deref() == Some("in-progress")
}

/// Whether a directory is one of the two context markers. Exactly those
/// two names, never a `.gavin` prefix: `.gavin-worktrees` holds whole
/// checkouts in folders named after their branches, and a branch called
/// `plans`, `docs` or `specs` must not turn that checkout into a card
/// folder -- the scan already matches exactly (`scan_root`), and every
/// gate that decides what a card is has to agree with it.
fn is_marker_dir(dir: &Path) -> bool {
    dir.file_name().is_some_and(|n| n == GAVIN_DIR || n == GAVIN_ROOT_DIR)
}

/// True for a `plans` directory that really is a context's plans folder
/// (its parent is a `.gavin` / `.gavin-root` marker directory).
fn is_plans_dir(dir: &Path) -> bool {
    dir.file_name().is_some_and(|n| n == "plans") && dir.parent().is_some_and(is_marker_dir)
}

/// The `plans/` root governing this file, but ONLY for the three
/// locations the filing rules own: directly in `plans/`, in
/// `plans/done/`, or in `plans/archive/`. A file filed under a hand-made
/// `plans/roadmap/` yields None and is therefore never moved -- a status
/// write must not flatten somebody else's hierarchy.
fn governed_plans_root(path: &Path) -> Option<PathBuf> {
    let parent = path.parent()?;
    if is_plans_dir(parent) {
        return Some(parent.to_path_buf());
    }
    if parent.file_name().is_some_and(|n| n == DONE_DIR || n == ARCHIVE_DIR) {
        let plans = parent.parent()?;
        if is_plans_dir(plans) {
            return Some(plans.to_path_buf());
        }
    }
    None
}

/// True for a card sitting directly in this plans root's `archive/`.
fn in_archive(path: &Path, plans_root: &Path) -> bool {
    path.parent() == Some(plans_root.join(ARCHIVE_DIR).as_path())
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

/// The `plans/` directory this card file belongs to: the nearest ancestor
/// named `plans` whose own parent is a `.gavin*` marker. Unlike
/// `governed_plans_root` it does not care WHICH subfolder the card sits
/// in -- a card under a hand-made `plans/roadmap/` still belongs to that
/// root, it is only the filing rules that leave it alone.
fn owning_plans_root(path: &Path) -> Option<PathBuf> {
    path.ancestors().skip(1).find(|d| is_plans_dir(d)).map(Path::to_path_buf)
}

/// Re-points card paths whose file has moved out from under them, as
/// `(old, new)` pairs. The daemon re-keys a card it moved ITSELF at the
/// move; a card moved any other way -- an agent running `mv`, a one-time
/// migration, a hand edit -- would otherwise leave a rail step aimed at
/// nothing, and a rail stalls on such a step instead of skipping a card
/// that is merely finished.
///
/// The match is by file name within the card's own `plans/` root, which
/// is exactly the identity `parent:` already resolves on. Ambiguity is
/// left alone: a name that no longer answers to exactly one file is a
/// broken path, not a guess worth making. Paths whose file is right
/// where they say yield nothing, so a scan that changed nothing costs
/// one lookup per path and writes nothing.
///
/// Comparison is on the path spelling, not the inode: both sides come
/// out of the same canonicalized scan (the watcher canonicalizes its
/// root, and every path the app or an MCP agent holds was read back from
/// a tree), so there is only ever one spelling in play.
pub fn recover_moved_card_paths(tree: &GavinTree, paths: &[String]) -> Vec<(String, String)> {
    let live: HashSet<&str> = tree
        .contexts
        .iter()
        .flat_map(|c| c.plans.iter().map(|p| p.path.as_str()))
        .collect();
    // (plans root, file name) -> the files answering to it. More than one
    // is a workspace that already broke `parent:` resolution; we decline
    // to pick between them.
    let mut by_name: HashMap<(PathBuf, String), Vec<&str>> = HashMap::new();
    for path in live.iter().copied() {
        let p = Path::new(path);
        let (Some(root), Some(name)) = (owning_plans_root(p), p.file_name()) else { continue };
        by_name.entry((root, name.to_string_lossy().to_string())).or_default().push(path);
    }

    let mut pairs: BTreeMap<String, String> = BTreeMap::new();
    for stale in paths {
        if live.contains(stale.as_str()) || pairs.contains_key(stale) {
            continue;
        }
        let p = Path::new(stale);
        let (Some(root), Some(name)) = (owning_plans_root(p), p.file_name()) else { continue };
        match by_name.get(&(root, name.to_string_lossy().to_string())).map(Vec::as_slice) {
            Some([found]) => {
                pairs.insert(stale.clone(), (*found).to_string());
            }
            _ => continue,
        }
    }
    pairs.into_iter().collect()
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

/// Moves one card to `dest_dir` and drags its nested children after it.
/// Returns the card's path afterwards -- unchanged when it was already
/// there or the destination name was taken (in which case the children
/// stay put too, since their home is wherever the parent actually is).
fn move_card_with_children(
    path: &Path,
    plans_root: &Path,
    dest_dir: &Path,
    info: &PlanFileInfo,
) -> anyhow::Result<PathBuf> {
    let moved = move_card(path, dest_dir)?;
    if moved == path {
        return Ok(moved);
    }
    // The children follow. Their own home is "wherever the parent is",
    // so this is the same rule applied one level down rather than a
    // special case -- and it is the rule for BOTH kinds of move, the
    // status one into done/ and the explicit one into archive/.
    if info.kind == CardKind::Plan {
        for child in plans_tree_files(plans_root) {
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

/// Files a card where its status says it belongs, and takes its nested
/// children with it. Returns the card's path afterwards -- unchanged when
/// no move was called for, when the card lives outside the governed
/// locations, or when the destination name was taken.
pub fn relocate_for_status(path: &Path) -> anyhow::Result<PathBuf> {
    let Some(plans_root) = governed_plans_root(path) else { return Ok(path.to_path_buf()) };
    // An archived card stays archived. Archiving is a filing decision a
    // human made explicitly, and a later status edit -- theirs or an
    // agent's -- must not quietly undo it by dragging the file back onto
    // the board. `unarchive_card` is the only way out.
    if in_archive(path, &plans_root) {
        return Ok(path.to_path_buf());
    }
    let content = std::fs::read_to_string(path)?;
    let info = plan_file_info(path, &content);
    let Some(home) = home_dir_for(&plans_root, &info) else { return Ok(path.to_path_buf()) };
    move_card_with_children(path, &plans_root, &home, &info)
}

/// Moves a card into its context's `plans/archive/`, children included.
/// Already-archived cards are a no-op rather than an error: the end state
/// the caller asked for already holds.
pub fn archive_card(path: &Path) -> anyhow::Result<PathBuf> {
    let plans_root = governed_plans_root(path)
        .ok_or_else(|| anyhow::anyhow!("not an archivable plans/ card: {}", path.display()))?;
    if in_archive(path, &plans_root) {
        return Ok(path.to_path_buf());
    }
    let content = std::fs::read_to_string(path)?;
    let info = plan_file_info(path, &content);
    move_card_with_children(path, &plans_root, &plans_root.join(ARCHIVE_DIR), &info)
}

/// Takes a card back out of `plans/archive/` and files it where its
/// status says it belongs -- `plans/done/` for a Done card, `plans/`
/// otherwise. A card that is not archived is a no-op, for the same
/// reason `archive_card` treats a re-archive as one.
///
/// Un-archiving a lone NESTED child lands it back beside its parent,
/// which for a still-archived parent means it does not move at all.
/// That is the "children live where their parent lives" rule holding,
/// not a failure: the way to bring the child back is to bring the plan
/// back, and it comes with it.
pub fn unarchive_card(path: &Path) -> anyhow::Result<PathBuf> {
    let plans_root = governed_plans_root(path)
        .ok_or_else(|| anyhow::anyhow!("not a plans/ card: {}", path.display()))?;
    if !in_archive(path, &plans_root) {
        return Ok(path.to_path_buf());
    }
    let content = std::fs::read_to_string(path)?;
    let info = plan_file_info(path, &content);
    let Some(home) = home_dir_for(&plans_root, &info) else { return Ok(path.to_path_buf()) };
    move_card_with_children(path, &plans_root, &home, &info)
}

/// The public, validated entry point (and the future MCP tool body). The
/// allow-list is enforced HERE, not trusted to callers -- this must never
/// become an arbitrary-line writer. `path` is confined by
/// `confine_card_path` before anything else runs (DP-03): the key/value
/// allow-list guarded WHAT could be written, never WHERE.
///
/// Returns the file's path AFTER the write: a status write can move the
/// card between `plans/` and `plans/done/` (see `relocate_for_status`),
/// and every caller that holds the path as an identity needs the new one.
pub fn set_plan_field(path: &Path, key: &str, value: &str) -> anyhow::Result<PathBuf> {
    let confined = confine_card_path(path)?;
    let path = confined.as_path();
    // Empty value removes the line -- permitted only where the card model
    // needs it (status: nesting, parent: un-parenting, labels: clearing,
    // attachments: removing the last one, complexity: back to "nobody
    // said", which is a different answer from "trivial", agent/model:
    // back to whatever the level or the workspace picks). Clearing
    // matters more for attachments than for labels: an empty
    // `attachments:` line would parse to nothing anyway, but leaving it
    // behind is a card that still LOOKS like it references a file.
    if value.is_empty() {
        match key {
            "status" | "parent" | "labels" | "attachments" | "complexity" | "agent"
            | "model" => {
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
        // Comma-separated, one line, and NOT validated per entry: the
        // paths are the human's, they are stat'd at the moment they
        // matter (the modal opening, the run gate), and a card that
        // records a path which has since moved is a broken chip to fix,
        // not a write to refuse.
        "attachments" => {
            if value.contains('\n') {
                anyhow::bail!("attachments must be a single line");
            }
        }
        // Validated, unlike `attachments` right above, and for the
        // opposite reason: an attachment path is the human's and may
        // legitimately be wrong until they fix it, where a complexity
        // gavin cannot parse is a level that picks no agent. Written in
        // the enum's own spelling so a hand-typed "Complex" reads back
        // the same as a picked one.
        "complexity" => {
            let level = Complexity::parse(value)
                .ok_or_else(|| anyhow::anyhow!("invalid complexity value: {value}"))?;
            write_plan_field(path, key, level.as_str())?;
            return relocate_for_status(path);
        }
        // Single-line and otherwise unvalidated, the `attachments`
        // posture rather than `complexity`'s: the profile table lives in
        // the Tauri host and a model name belongs to whichever CLI is
        // installed, so the daemon has nothing to check either against.
        // Refusing what it cannot check would refuse writes the app knows
        // are fine; a name the app cannot resolve shows back on the card
        // as what it says instead.
        "agent" | "model" => {
            if value.contains('\n') {
                anyhow::bail!("{key} must be a single line");
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
/// §3). `path` is confined by `confine_card_path` first (DP-03).
/// `expected_text` must equal the line's raw remainder -- a
/// mismatch means the file changed under the UI (an agent edit) and the
/// caller must re-read and retry deliberately. Every other byte is
/// preserved.
pub fn set_checklist_item(
    path: &Path,
    line_index: u32,
    expected_text: &str,
    checked: bool,
) -> anyhow::Result<()> {
    let confined = confine_card_path(path)?;
    let path = confined.as_path();
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
/// checklist line to `- [<mark>] [item](./<file>)`. `plan_path` is
/// confined by `confine_card_path` first (DP-03). The item must match
/// exactly one unpromoted line; ambiguity or absence errors with no
/// writes. Returns the created file's path.
pub fn promote_checklist_item(plan_path: &Path, item: &str) -> anyhow::Result<PathBuf> {
    let confined = confine_card_path(plan_path)?;
    let plan_path = confined.as_path();
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
        .filter(|d| is_marker_dir(d))
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
        // No attachments inherited from the plan: the plan's references
        // are the plan's, and a promoted step that silently acquired
        // them would put a stale path in front of an agent nobody chose
        // it for. The human attaches to the child if the child needs it.
        None,
        // No complexity either, and for a sharper version of the same
        // reason: a plan being hard says nothing about one step of it,
        // and inheriting the level would spend the plan's model on every
        // checklist item promoted out of it.
        None,
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

/// The one gate every card-shaped write in this module passes through
/// (DP-03): `delete_card_file`'s original guard, lifted so a request that
/// used to skip it -- `SetPlanFrontmatterField`, `SetChecklistItem`,
/// `PromoteChecklistItem` all took a bare path straight off the wire --
/// cannot act on anything that doesn't look like a real card.
///
/// `..` is rejected lexically FIRST: `canonicalize` requires the path to
/// exist, and a `..` segment aimed at a file that is not there yet is
/// never innocent, so this must not depend on reaching the filesystem to
/// catch it. The remaining shape check -- some ancestor must be a
/// `plans/`, `docs/` or `specs/` folder directly inside a `.gavin*`
/// directory (docs and specs legitimately nest in subfolders, and the
/// scanners list nested plans too), and the file itself must be `.md` --
/// then runs against the CANONICALIZED path, the same resolve-then-check
/// order `attachment_status` uses for attachments: a lexically well-formed
/// `.gavin-root/plans/x.md` could still resolve somewhere else entirely
/// through a symlinked component, and the shape check has to see where it
/// really lands, not where it merely claims to.
///
/// This is a SHAPE check, not a workspace check: a well-formed card path
/// belonging to a workspace nobody on this connection has open still
/// passes, because nothing here says which workspace is "ours" yet --
/// that is `sec-fix-client-identity.md`'s job, and this confinement is
/// what its per-connection scope will key on.
///
/// Returns `path` itself, not the canonicalized form: canonicalizing is
/// how the check sees where a symlinked component really lands, but
/// every caller's own logic (`governed_plans_root`, file moves, the path
/// it hands back to the app) works off the SPELLING the request named --
/// same as `find_watcher_by_root` resolving symlinks only to compare, not
/// to replace what it was given. On macOS that spelling matters
/// concretely: `/tmp` and `/var/folders` both live under `/private`, and
/// returning the resolved form would silently rewrite every path that
/// crosses one.
pub fn confine_card_path(path: &Path) -> anyhow::Result<PathBuf> {
    if path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        anyhow::bail!("path may not contain ..: {}", path.display());
    }
    let canonical = path
        .canonicalize()
        .map_err(|e| anyhow::anyhow!("couldn't resolve {}: {e}", path.display()))?;
    if canonical.extension().is_none_or(|e| e != "md") {
        anyhow::bail!("not a context md file: {}", canonical.display());
    }
    let guarded = canonical.ancestors().skip(1).any(|dir| {
        dir.file_name().is_some_and(|n| n == "plans" || n == "docs" || n == "specs")
            && dir.parent().is_some_and(is_marker_dir)
    });
    if !guarded {
        anyhow::bail!("not inside a .gavin*/plans|docs|specs folder: {}", canonical.display());
    }
    Ok(path.to_path_buf())
}

/// Deletes a context md file (card-model delete design + explorer
/// delete), guarded by `confine_card_path` -- this must never become a
/// general file deleter.
pub fn delete_card_file(path: &Path) -> anyhow::Result<()> {
    let path = confine_card_path(path)?;
    std::fs::remove_file(&path)
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
                AgentConfig {
                    profile: get("profile"),
                    file: get("file"),
                    command: get("command"),
                    mcp_file: get("mcp_file"),
                    mcp_format: get("mcp_format"),
                    model: get("model"),
                    model_flag: get("model_flag"),
                }
            });
            (name, agent, false)
        }
        Err(_) => (None, None, true),
    }
}

/// The keys an empty value CLEARS rather than being refused for. Each has
/// a fallback underneath it -- the app-wide default model, the profile
/// table's own model flag, the scaffolded PRD path -- which is what makes
/// removing it meaningful; for the rest an empty value would mean nothing.
///
/// Removing rather than blanking is the point: a `model = ""` line reads
/// as a deliberate empty model to whoever opens the file next, where an
/// absent key reads as "gavin decides".
const CLEARABLE_KEYS: &[&str] = &["model", "model_flag", "prd"];

/// Writes one key of `.gavin-root/config.toml`. Uses toml_edit so
/// comments, key order and formatting survive -- this file is hand-edited
/// by users and read by their agents. Allow-listed exactly like
/// set_plan_field: never an arbitrary-key writer. mcp_file and mcp_format
/// carry the `custom` profile's MCP layout, which cannot come from the
/// static profile table.
///
/// `prd` is the one key that is NOT part of `[agent]`: which document
/// leads this workspace does not change when you switch CLI, so it sits
/// at the document root beside `name` and `extra_contexts`.
pub fn set_root_config_field(root: &Path, key: &str, value: &str) -> anyhow::Result<()> {
    let table = match key {
        "profile" | "file" | "command" | "mcp_file" | "mcp_format" | "model" | "model_flag" => {
            Some("agent")
        }
        "prd" => None,
        _ => anyhow::bail!("not a settable config key: {key}"),
    };
    if value.trim().is_empty() && CLEARABLE_KEYS.contains(&key) {
        let path = root.join(GAVIN_ROOT_DIR).join("config.toml");
        // No file means no key to remove. Returning early rather than
        // falling through keeps a clear from CREATING an empty
        // config.toml, which is the one thing this path could do that
        // the caller never asked for.
        let Ok(existing) = std::fs::read_to_string(&path) else { return Ok(()) };
        let mut doc = existing.parse::<toml_edit::DocumentMut>().map_err(|_| {
            anyhow::anyhow!("{} is not valid TOML -- fix or remove it first", path.display())
        })?;
        match table {
            Some(name) => {
                if let Some(t) = doc.get_mut(name).and_then(|a| a.as_table_mut()) {
                    t.remove(key);
                }
            }
            None => {
                doc.as_table_mut().remove(key);
            }
        }
        std::fs::write(&path, doc.to_string())?;
        return Ok(());
    }
    if value.trim().is_empty() || value.contains('\n') {
        anyhow::bail!("{key} must be a non-empty single line");
    }
    // Validated here rather than trusted from the caller: the daemon is
    // what resolves this path against the root, so the daemon is what has
    // to refuse one pointing outside it.
    let stored = if key == "prd" {
        protocol::usable_prd_path(value)
            .ok_or_else(|| anyhow::anyhow!("prd must be a path inside the root, with no `..`"))?
    } else {
        value.to_string()
    };
    let path = root.join(GAVIN_ROOT_DIR).join("config.toml");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let mut doc = existing.parse::<toml_edit::DocumentMut>().map_err(|_| {
        anyhow::anyhow!("{} is not valid TOML -- fix or remove it first", path.display())
    })?;
    match table {
        Some(name) => {
            doc[name][key] = toml_edit::value(stored);
            // A freshly created [agent] arrives implicit; make it
            // explicit so the file stays readable to whoever opens it next.
            if let Some(t) = doc[name].as_table_mut() {
                t.set_implicit(false);
            }
        }
        // A bare root key. toml_edit renders the root table's own
        // key-values above every header, so this lands where it parses as
        // top-level rather than as a member of `[agent]`.
        None => doc[key] = toml_edit::value(stored),
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
///
/// Deliberately NOT run through `confine_root_path`, unlike
/// `create_gavin_context` and `add_external_context` below: this is the
/// one root-taking request whose whole job is bootstrapping a folder
/// nothing has watched yet. The app itself calls it before the workspace
/// it is about to become is ever watched (`workspaceOpen.ts`'s
/// `initAndOpen`, deliberately: the watch's first push should see the
/// skeleton, not an empty folder), a watch install is asynchronous on its
/// own thread besides (`WatchGavinRoot` in `server.rs`), and
/// `gavin_init_root` over MCP exists precisely for a cwd with no
/// `.gavin-root` above it yet. Requiring a prior watch here would refuse
/// the one legitimate call this request exists to serve. The confinement
/// this request still lacks is scoped to `sec-fix-client-identity.md`'s
/// role check instead (an `agent` connection refused this request
/// outside its own launch scope, a `local` one left alone) -- see
/// DP-03/R4 in `docs/security/README.md`.
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
    // Only scaffold a PRD where the workspace has not already named one:
    // re-running init on a root pointing at its own `docs/PRD.md` would
    // otherwise leave a second, unread PRD behind.
    let prd = root.join(prd_relative_path(root));
    if !prd.exists() {
        if let Some(parent) = prd.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&prd, PRD_TEMPLATE.replace("{workspace}", workspace_name))?;
    }
    Ok(())
}

/// The confinement `CreateGavinContext` and `AddExternalGavinContext`
/// check their root/parent argument against, in `server.rs`'s request
/// handler rather than here: `existing directory this daemon already
/// watches, or an ancestor/descendant of one` (DP-03/R4). It is applied at
/// the request boundary, not inside `create_gavin_context` itself, because
/// `add_external_context` below calls that scaffolder a second time on
/// the EXTERNAL folder -- which by definition is not watched or nested
/// under anything -- and that internal call must stay unconfined.
///
/// `watched_roots` is every root this daemon currently has a live watcher
/// on (`SessionManager::watched_roots`), not yet narrowed to the
/// requesting connection's own: nothing on a connection says "this
/// workspace is mine" until `sec-fix-client-identity.md` lands, so this
/// is the confinement its per-connection scope will key on.
///
/// Returns `path` itself, not the canonicalized form used to check it --
/// same reasoning as `confine_card_path`. Concretely, returning the
/// resolved form here would break `add_external_context`'s own
/// `folder.starts_with(root)` check: `root` would come in canonicalized
/// while `folder` stays exactly as the caller spelled it, and on macOS
/// (`/var`, `/tmp` both symlink into `/private`) that mismatch would let
/// a folder truly inside the workspace read as `starts_with`-false and
/// pass for "external".
pub fn confine_root_path(path: &Path, watched_roots: &[PathBuf]) -> anyhow::Result<PathBuf> {
    if !path.is_dir() {
        anyhow::bail!("not an existing directory: {}", path.display());
    }
    // `protocol::canonical_path`, not `Path::canonicalize`, because the
    // other side of the comparison below was built with it: a watcher
    // stores `protocol::canonical_path(root)`, which on Windows has the
    // `\\?\` verbatim prefix stripped and its separators normalised.
    // Raw canonicalisation here hands `starts_with` a path whose very
    // first component is `Prefix::VerbatimDisk` against a root whose
    // first component is `Prefix::Disk` -- never equal, whatever the
    // rest of the path says. That refused every CreateGavinContext and
    // AddExternalGavinContext inside a watched workspace on Windows,
    // which is precisely the failure `canonical_path`'s own comment
    // exists to describe.
    let canonical = protocol::canonical_path(path).unwrap_or_else(|_| path.to_path_buf());
    let confined =
        watched_roots.iter().any(|root| canonical.starts_with(root) || root.starts_with(&canonical));
    if !confined {
        anyhow::bail!("not a workspace this daemon has open: {}", path.display());
    }
    Ok(path.to_path_buf())
}

/// Scaffolds `.gavin` at `parent` (card-model spec §5). Confinement to a
/// known workspace is the request handler's job (`confine_root_path`),
/// not this function's: `add_external_context` also calls it directly on
/// a deliberately-external folder.
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
///
/// `root` is confined by `confine_root_path` in the request handler
/// before this runs (DP-03) -- it must already be a workspace this
/// daemon watches, which is what stops an unrelated connection from
/// registering an external context into a root it merely names.
/// `folder` keeps only its existing "not under root" check: it is
/// external by design, so it is never expected to be watched.
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

/// Whether a directory entry found during a root-scoped walk is safe to
/// descend into. A plain directory always is; a symlinked one only when
/// its target's canonical path stays under `boundary` -- otherwise a
/// hostile repo could point a directory anywhere inside itself (even a
/// top-level `.gavin-root`) at `/etc`, the user's home directory, or an
/// unrelated project, and the scan would read whatever it found there
/// and report it as the repo's own plans/docs/specs (DP-05, read
/// amplification within the uid). A symlinked FILE is unaffected: only
/// directory descent is guarded.
fn safe_to_descend(path: &Path, boundary: &Path) -> bool {
    let is_symlink = std::fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);
    if !is_symlink {
        return true;
    }
    let Ok(canonical_boundary) = boundary.canonicalize() else { return false };
    path.canonicalize().is_ok_and(|c| c.starts_with(&canonical_boundary))
}

/// Per-file cap for a plan card read during a `.gavin*` scan, mirroring
/// `MAX_PRD_BYTES`: a hostile repo's `plans/*.md` is re-read on every
/// debounced rescan, so an unbounded file forces a full read into memory
/// every time a watched directory so much as flickers (DP-05). An
/// oversize file still appears in the tree -- as a `parse_warning`,
/// never actually read -- rather than vanishing silently.
const MAX_SCANNED_FILE_BYTES: u64 = 1024 * 1024;

/// A `PlanFileInfo` for a card too large to read, built from its path
/// alone. Mirrors `plan_file_info`'s defaults for everything the content
/// would otherwise have supplied.
fn oversize_plan_file_info(path: &Path) -> PlanFileInfo {
    let file_name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let stem = path
        .file_stem()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| file_name.clone());
    PlanFileInfo {
        path: path.to_string_lossy().to_string(),
        modified_at: file_modified_at(path),
        file_name,
        title: stem,
        status: None,
        priority: None,
        order: None,
        kind: CardKind::Plan,
        parent: None,
        labels: Vec::new(),
        checklist_done: 0,
        checklist_total: 0,
        parse_warning: true,
        attachments: Vec::new(),
        complexity: None,
        agent: None,
        model: None,
        // None, not an empty list: the body was never read, so "this
        // card has nothing waiting on you" is a claim nothing here can
        // make. It rides out with `parse_warning: true` beside it.
        human_items: None,
    }
}

/// Lists every `.md` file under `dir`, refusing to follow a directory
/// symlink whose canonical path leaves `boundary` (see `safe_to_descend`).
fn list_md_files(dir: &Path, boundary: &Path) -> Vec<MdFileInfo> {
    fn walk(dir: &Path, base: &Path, boundary: &Path, out: &mut Vec<MdFileInfo>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if safe_to_descend(&path, boundary) {
                    walk(&path, base, boundary, out);
                }
            } else if path.extension().map(|e| e == "md").unwrap_or(false) {
                out.push(MdFileInfo {
                    path: protocol::wire_path(&path),
                    rel_path: protocol::wire_path(path.strip_prefix(base).unwrap_or(&path)),
                });
            }
        }
    }
    if !safe_to_descend(dir, boundary) {
        return Vec::new();
    }
    let mut out = Vec::new();
    walk(dir, dir, boundary, &mut out);
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    out
}

fn build_context(
    folder: &Path,
    gavin_dir: &Path,
    kind: GavinContextKind,
    root: &Path,
) -> GavinContext {
    let config_path = gavin_dir.join("config.toml");
    let (config_name, agent_config, config_warning) = parse_context_config(&config_path);
    // Root-only, like the agent block: a `.gavin` sub-context scopes
    // plans, and the lead document belongs to the workspace.
    let prd = if matches!(kind, GavinContextKind::Root) {
        parse_prd_path(&config_path)
    } else {
        None
    };
    let folder_name =
        folder.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let plans = list_md_files(&gavin_dir.join("plans"), root)
        .into_iter()
        .map(|md| {
            let path = PathBuf::from(&md.path);
            match std::fs::metadata(&path) {
                Ok(meta) if meta.len() > MAX_SCANNED_FILE_BYTES => oversize_plan_file_info(&path),
                _ => {
                    let content = std::fs::read_to_string(&path).unwrap_or_default();
                    plan_file_info(&path, &content)
                }
            }
        })
        .collect();
    GavinContext {
        folder_path: protocol::wire_path(folder),
        kind: kind.clone(),
        name: config_name.unwrap_or(folder_name),
        plans,
        docs: list_md_files(&gavin_dir.join("docs"), root),
        specs: list_md_files(&gavin_dir.join("specs"), root),
        // Resolved, not configured: "is there a PRD" has to answer for
        // the file the workspace actually points at, or a project with
        // its own docs/PRD.md reads as having none.
        has_prd: matches!(kind, GavinContextKind::Root)
            && folder
                .join(prd.clone().unwrap_or_else(|| protocol::DEFAULT_PRD_PATH.to_string()))
                .is_file(),
        config_warning,
        // Only the root context carries an agent block: `.gavin`
        // sub-contexts scope plans, not how the workspace is worked on.
        agent: if matches!(kind, GavinContextKind::Root) { agent_config } else { None },
        outside: false,
        prd,
    }
}

/// Full scan of one bound root (spec §3). Never fails: a missing root
/// yields `root_missing: true` with no contexts.
pub fn scan_root(root: &Path) -> GavinTree {
    // Forward slashes from here on: every path this scan produces is a
    // card id the app splits on `/`, compares and joins. See
    // `protocol::wire_path`.
    let root_str = protocol::wire_path(root);
    if !root.is_dir() {
        return GavinTree { root_path: root_str, root_missing: true, contexts: vec![] };
    }

    let mut contexts = Vec::new();
    // Root context: `.gavin-root` recognized ONLY directly under the root,
    // and only when it isn't a symlink escaping the root itself (DP-05) --
    // a hostile repo controls its own top level too.
    let root_gavin = root.join(GAVIN_ROOT_DIR);
    let root_has_gavin_root = root_gavin.is_dir() && safe_to_descend(&root_gavin, root);
    if root_has_gavin_root {
        contexts.push(build_context(root, &root_gavin, GavinContextKind::Root, root));
    }

    fn walk(
        dir: &Path,
        depth: usize,
        skip_gavin_here: bool,
        contexts: &mut Vec<GavinContext>,
        root: &Path,
    ) {
        if depth > MAX_SCAN_DEPTH {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            // Refuses a directory symlink whose target leaves `root`
            // before even asking whether it's a `.gavin*` marker -- a
            // symlinked marker directory is exactly the shape of trap
            // this guards (DP-05).
            if !path.is_dir() || !safe_to_descend(&path, root) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            // A deep `.gavin-root` is ignored entirely (spec §1 edge rules);
            // `.gavin` marks its PARENT as a context, and the walker never
            // descends into `.gavin*` directories themselves.
            if name == GAVIN_DIR {
                if !skip_gavin_here {
                    contexts.push(build_context(dir, &path, GavinContextKind::Context, root));
                }
                continue;
            }
            if name == GAVIN_ROOT_DIR
                || EXCLUDED_DIRS.contains(&name.as_str())
                || name.starts_with('.')
            {
                continue;
            }
            walk(&path, depth + 1, false, contexts, root);
        }
    }
    // Depth 1 = the root's immediate children. skip_gavin_here applies the
    // spec §1 both-markers rule to the root level only: when `.gavin-root`
    // exists, a root-level `.gavin` is ignored rather than double-listing
    // the root folder as two contexts.
    walk(root, 1, root_has_gavin_root, &mut contexts, root);

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
            let mut ctx = build_context(&path, &gavin_dir, GavinContextKind::Context, root);
            ctx.outside = true;
            contexts.push(ctx);
        }
    }
    GavinTree { root_path: root_str, root_missing: false, contexts }
}

/// Whether the whole root is watched with ONE recursive registration
/// instead of one non-recursive registration per directory.
///
/// FSEvents has no non-recursive mode: a stream reports everything under
/// each of its paths, and `notify` emulates `NonRecursive` by dropping
/// the deeper events in-process -- so the per-directory set never kept a
/// single event out of this process on macOS. What it did cost is a
/// full stream stop-and-restart per `watch()` call (notify's
/// `FsEventWatcher::watch_inner` is `stop(); append_path(); run()`),
/// and `watch_targets` registers every directory the scanner would
/// descend into. A 48 GB monorepo with ~3000 such directories took over
/// five minutes to arm -- during which the app's streaming connection,
/// whose thread ran the registration, processed nothing: no Attach for
/// a freshly launched agent (a blank terminal), no tree push for the
/// PRD the human had just picked. One recursive watch on the root arms
/// in milliseconds, and `tree_relevant` already rejects the churn the
/// per-directory set was meant to keep out.
///
/// Windows is here for a different reason, and it is correctness rather
/// than speed. `ReadDirectoryChangesW` holds an open handle on every
/// directory it watches, and Windows refuses to rename or move a
/// directory while any handle is open ANYWHERE inside it -- a refusal
/// that survives opening the inner handle with FILE_SHARE_DELETE, which
/// only ever licensed deleting that file, never moving one of its
/// ancestors. So the per-directory set made a watched workspace
/// immovable: `.gavin-root`'s own watch was enough to stop the human
/// renaming the workspace folder in Explorer, and a context folder's
/// `.gavin` was enough to stop them renaming the context. With one
/// handle on the root and none below it, every folder inside stays
/// renamable, and the root itself goes too -- a handle on the directory
/// being renamed is fine, it is a handle *inside* it that is not.
///
/// `ReadDirectoryChangesW` is natively recursive (`bWatchSubtree`), so
/// unlike inotify this costs one handle rather than one per directory.
/// What it does cost is delivery: every write under `target/`,
/// `node_modules/` and `.git/` now crosses into the daemon to be thrown
/// away by `tree_relevant`. Measured rather than guessed -- see
/// `measure_recursive_watch_churn`: 2000 build-shaped writes produce
/// ~6000 event paths, `tree_relevant` rejects all of them, and the
/// filtering costs tens of milliseconds. No rescan follows a rejection,
/// so the walk is never paid.
///
/// The second Windows cost is narrower and is not about volume.
/// `ReadDirectoryChangesW` reports what happens INSIDE the directory its
/// handle is open on, so the root's OWN rename is only ever reported to
/// a watch on its parent -- which `watch_targets` deliberately never
/// takes. Renaming the root away still pushes `root_missing` (the handle
/// follows the directory and keeps reporting from its new home), but
/// renaming it BACK pushes nothing; the first change under the restored
/// root heals the tree instead. Measured on
/// `server::tests::renaming_the_root_away_pushes_root_missing_and_renaming_back_heals`,
/// which asserts exactly that on Windows and the stronger unix property
/// elsewhere. inotify does not have this gap: its watch is on the inode
/// and both renames raise IN_MOVE_SELF.
///
/// inotify is genuinely non-recursive and a recursive watch there means
/// one descriptor per directory, node_modules included, so the
/// per-directory set stays the right answer on Linux.
const ONE_RECURSIVE_WATCH: bool = cfg!(any(target_os = "macos", windows));

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
///
/// All of which describes inotify. On FSEvents the churn crosses into the
/// daemon either way and the per-directory set only multiplies the cost
/// of arming it; on Windows each entry is an open handle that makes the
/// folder it names unrenamable. On both the whole root is one recursive
/// watch instead -- see `ONE_RECURSIVE_WATCH`.
pub fn watch_targets(root: &Path) -> Vec<(PathBuf, notify::RecursiveMode)> {
    use notify::RecursiveMode::{NonRecursive, Recursive};
    if ONE_RECURSIVE_WATCH {
        // See the constant: on FSEvents the per-directory set below buys
        // nothing and costs a stream rebuild per directory, and on
        // Windows it locks every folder it names against renaming.
        return vec![(root.to_path_buf(), Recursive)];
    }
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

    fn walk(
        dir: &Path,
        depth: usize,
        targets: &mut Vec<(PathBuf, notify::RecursiveMode)>,
        root: &Path,
    ) {
        if depth > MAX_SCAN_DEPTH {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            // Mirrors scan_root's own symlink guard (DP-05): a watch is
            // cheap to register but pointless -- and, on a re-scan,
            // actively misleading -- for a directory the scanner itself
            // will never descend into.
            if !path.is_dir() || !safe_to_descend(&path, root) {
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
            walk(&path, depth + 1, targets, root);
        }
    }
    walk(root, 1, &mut targets, root);
    targets
}

/// What the human is told when the kernel runs out of watches.
///
/// It has to name the sysctl, because nothing else on the machine will:
/// `inotify_add_watch` answers ENOSPC, which every tool renders as "No
/// space left on device" and sends people looking at `df`. And it has to
/// say what is BROKEN, not just what failed -- a workspace missing part
/// of its watch set still shows every card, it just stops noticing edits
/// made outside the app, which is indistinguishable from gavin being
/// slow until you know.
///
/// Pure, and separate from `sync_watches`, so the wording is testable
/// without exhausting a real kernel's watch table.
fn watch_limit_message(root: &Path, wanted: usize, refused: usize) -> String {
    format!(
        "gavin could not watch {refused} of the {wanted} folders under {} — the kernel's inotify \
         watch limit is exhausted, so edits made to cards outside gavin will not show up in this \
         workspace until it restarts. Raise the limit with `sudo sysctl -w \
         fs.inotify.max_user_watches=524288` (and add it to /etc/sysctl.d/ to keep it across \
         reboots).",
        root.display()
    )
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
/// Anything the scanner would never descend into is rejected first. Where
/// the watch set is per directory (inotify) their events never arrive at
/// all and this is the second line of defence; under a single recursive
/// watch (FSEvents, see `ONE_RECURSIVE_WATCH`) every event under the root
/// reaches here and this check is the only thing keeping a `node_modules`
/// install from rescanning the tree a hundred thousand times.
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

/// Called with every fresh scan, before the tree goes out, and given a
/// chance to answer with something the app must be told FIRST. gavin.rs
/// owns no databases, so the daemon hands that work in as a closure
/// rather than the scanner growing a dependency on the stores.
pub type ScanHook = Box<dyn Fn(&str, &GavinTree) -> Option<Response> + Send + Sync>;

struct WatcherInner {
    last_tree: Option<GavinTree>,
    last_scan: Option<Instant>,
    /// How deep into the current burst the last rescan was; see
    /// `burst_position`.
    burst: u32,
    /// The watch set currently registered, so re-arming after a rescan
    /// can diff instead of tearing every watch down and rebuilding it.
    watched: HashMap<PathBuf, notify::RecursiveMode>,
    /// Whether the app has already been told the OS watch limit is
    /// exhausted. A latch, because `sync_watches` runs after EVERY scan
    /// and the condition persists until the human changes a sysctl: one
    /// banner is a report, one per rescan is a fault of its own. Cleared
    /// when the whole set arms again, so a second exhaustion is reported
    /// afresh.
    watch_limit_reported: bool,
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
    writer: Arc<Mutex<Stream>>,
    inner: Mutex<WatcherInner>,
    debouncer: Mutex<Option<notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>>>,
    on_scan: Option<ScanHook>,
}

impl GavinWatcher {
    /// Creates the watcher, performs the initial scan, pushes the initial
    /// GavinTreeChanged, and starts the filesystem watch. Watch-setup
    /// failure degrades to scan-on-demand (spec §4): the initial push
    /// still happens and GetGavinTree still works.
    pub fn start(
        workspace_id: String,
        root_path: PathBuf,
        writer: Arc<Mutex<Stream>>,
        on_scan: Option<ScanHook>,
    ) -> Arc<Self> {
        // Canonicalize before watching: FSEvents resolves symlinks, and a
        // watch registered on a symlinked spelling (macOS's /tmp and
        // /var/folders both live under /private) can silently never see
        // its own events. A missing root can't canonicalize -- keep the
        // given path so scan_root still reports root_missing for it.
        let root_path =
            protocol::canonical_path(&root_path).unwrap_or(root_path);
        let watcher = Arc::new(GavinWatcher {
            workspace_id,
            root_path,
            writer,
            inner: Mutex::new(WatcherInner {
                last_tree: None,
                last_scan: None,
                burst: 0,
                watched: HashMap::new(),
                watch_limit_reported: false,
            }),
            debouncer: Mutex::new(None),
            on_scan,
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
            let limit = watcher.sync_watches(&mut inner);
            drop(inner);
            watcher.report_watch_limit(limit);
        }

        watcher.rescan_and_push();
        watcher
    }

    /// Tells the app the OS refused part of the watch set.
    ///
    /// `Response::Error` on the streaming connection, which the app
    /// surfaces as the dismissible daemon-request-error strip over a
    /// still-working window -- not `daemon-error`, which means the
    /// connection is gone. That is the honest shape: the watch request
    /// was only partly honoured, everything else about the workspace
    /// still works, and the human is the only one who can fix it.
    fn report_watch_limit(&self, message: Option<String>) {
        let Some(message) = message else { return };
        self.push_response(&Response::Error { message });
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
    /// With ONE exception, and it is why this returns anything at all.
    /// Off macOS the set is one inotify watch PER scanned directory, and
    /// a kernel that has run out of them refuses every remaining watch
    /// with ENOSPC -- which `notify` reports as `MaxFilesWatch`. Silently
    /// leaving those out would mean a workspace where card edits made
    /// outside gavin never appear, with nothing anywhere to say why; the
    /// only fix is a sysctl, so the human has to be told. Returns the
    /// message to push, once per onset -- see `watch_limit_reported`.
    ///
    /// Takes the caller's `inner` guard rather than locking itself, so
    /// the lock order is always inner -> debouncer.
    #[must_use = "an exhausted watch limit has to reach the app"]
    fn sync_watches(&self, inner: &mut WatcherInner) -> Option<String> {
        let mut guard = self.debouncer.lock().unwrap();
        let Some(debouncer) = guard.as_mut() else { return None };
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
        let wanted = desired.len();
        let mut refused_for_limit = 0usize;
        let mut registered = HashMap::with_capacity(desired.len());
        for (path, mode) in desired {
            if inner.watched.get(&path) == Some(&mode) {
                registered.insert(path, mode); // already armed, leave it alone
                continue;
            }
            match fs_watcher.watch(&path, mode) {
                Ok(()) => {
                    registered.insert(path, mode);
                }
                Err(e) if matches!(e.kind, notify::ErrorKind::MaxFilesWatch) => {
                    refused_for_limit += 1;
                }
                Err(_) => {}
            }
        }
        inner.watched = registered;

        if refused_for_limit == 0 {
            inner.watch_limit_reported = false;
            return None;
        }
        if std::mem::replace(&mut inner.watch_limit_reported, true) {
            return None;
        }
        Some(watch_limit_message(&self.root_path, wanted, refused_for_limit))
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
        let watch_limit = self.sync_watches(&mut inner);
        // Ahead of the change gate, because what the hook answers about
        // depends on the STORES as much as on the tree -- a scan that
        // found the same tree can still be the one that re-keys a step
        // an arrangement wrote a moment ago. And ahead of the tree push,
        // because the tree is what re-runs the app's scheduler: it must
        // not tick on a re-keyed path the app has not been told about.
        self.report_watch_limit(watch_limit);
        if let Some(resp) = self.on_scan.as_ref().and_then(|hook| hook(&self.workspace_id, &tree)) {
            let mut writer = self.writer.lock().unwrap();
            let _ = protocol::write_message(&mut *writer, &resp);
        }
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
        let watch_limit = self.sync_watches(&mut inner);
        drop(inner);
        self.report_watch_limit(watch_limit);
        tree
    }
}

// --- Workspace files (v39) --------------------------------------------------
//
// The file access a desktop on ANOTHER machine needs from this daemon
// (`docs/superpowers/specs/2026-09-22-ssh-card-runs-design.md`): the card a
// run is composed from, the agent-integration files it writes, the
// attachments it classifies. Three functions, one confinement rule: a
// path is inside the workspace root or one of the outside contexts the
// root config names, or it is refused. The rule is the same one the
// desktop's own file viewer applies to a local root (`fileviewer.rs`),
// spelled here because this is the machine whose disk it is.

/// The roots a workspace's files may live under: the root itself, then
/// every `extra_contexts` folder its config names -- canonical, so a
/// symlinked checkout compares by where it is.
fn workspace_roots(root: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(canonical) = protocol::canonical_path(root) {
        roots.push(canonical);
    }
    for extra in parse_extra_contexts(&root.join(".gavin-root").join("config.toml")) {
        if let Ok(canonical) = protocol::canonical_path(Path::new(&extra)) {
            roots.push(canonical);
        }
    }
    roots
}

/// A path as it will be compared: the longest existing prefix
/// canonicalised (symlinks followed) and the rest appended. A symlink
/// inside the root that points outside resolves to where it leads, and a
/// file that does not exist yet -- the one a write is about to make --
/// still has a place to be judged by. Absolute only.
fn resolve_for_containment(path: &Path) -> anyhow::Result<PathBuf> {
    if !path.is_absolute() {
        anyhow::bail!("{} is not an absolute path", path.display());
    }
    let mut existing = path;
    let mut suffix: Vec<&std::ffi::OsStr> = Vec::new();
    while !existing.exists() {
        let name = existing
            .file_name()
            .ok_or_else(|| anyhow::anyhow!("{} could not be resolved", path.display()))?;
        suffix.push(name);
        existing = existing
            .parent()
            .ok_or_else(|| anyhow::anyhow!("{} could not be resolved", path.display()))?;
    }
    let mut canonical = protocol::canonical_path(existing)?;
    for name in suffix.into_iter().rev() {
        canonical.push(name);
    }
    Ok(canonical)
}

fn inside_root(root: &Path, path: &Path) -> bool {
    path == root || path.starts_with(root)
}

/// `path` as a request carries it -- absolute, or relative to the root.
fn absolute_in(root: &Path, path: &str) -> PathBuf {
    let candidate = Path::new(path);
    if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root.join(candidate)
    }
}

/// Where `path` is, when that is inside the workspace; an error naming
/// the refusal otherwise. A `..` component is refused before anything is
/// resolved, as `usable_attachment_path` refuses it for attachments.
fn confined(root: &Path, path: &str) -> anyhow::Result<PathBuf> {
    if Path::new(path).components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        anyhow::bail!("{path} contains a `..` component");
    }
    let resolved = resolve_for_containment(&absolute_in(root, path))?;
    if workspace_roots(root).iter().any(|r| inside_root(r, &resolved)) {
        Ok(resolved)
    } else {
        anyhow::bail!("{path} is outside the workspace root {}", root.display())
    }
}

/// `ReadWorkspaceFile`: the file's text, or `None` when there is no such
/// file, and whether it was cut at `MAX_WORKSPACE_FILE_BYTES`. A cut
/// that lands inside a multi-byte character backs off to the last whole
/// one; a file that is not UTF-8 at all is an error, as it is for the
/// viewer.
pub fn read_workspace_file(root: &Path, path: &str) -> anyhow::Result<(Option<String>, bool)> {
    let resolved = confined(root, path)?;
    let bytes = match std::fs::read(&resolved) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((None, false)),
        Err(e) => return Err(e.into()),
    };
    let truncated = bytes.len() > protocol::MAX_WORKSPACE_FILE_BYTES;
    let slice = if truncated { &bytes[..protocol::MAX_WORKSPACE_FILE_BYTES] } else { &bytes[..] };
    let text = match std::str::from_utf8(slice) {
        Ok(text) => text,
        Err(e) if truncated => std::str::from_utf8(&slice[..e.valid_up_to()])
            .map_err(|_| anyhow::anyhow!("{path} is not valid UTF-8 text"))?,
        Err(_) => anyhow::bail!("{path} is not valid UTF-8 text"),
    };
    Ok((Some(text.to_string()), truncated))
}

/// `WriteWorkspaceFile`: parents created, the file written whole. Plain
/// `fs::write`, the convention `write_plan_field` set.
pub fn write_workspace_file(root: &Path, path: &str, content: &str) -> anyhow::Result<()> {
    let resolved = confined(root, path)?;
    if let Some(parent) = resolved.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&resolved, content)?;
    Ok(())
}

/// Directories under this user's home that no attachment may name, by
/// name; the desktop keeps the same list for a local root. Checked HERE
/// against THIS machine's home because the agent that would be handed
/// the file runs here.
const SENSITIVE_HOME_DIRS: &[&str] = &["Library", ".ssh", ".aws", ".config"];

/// This user's home on this machine: `HOME` on unix, `USERPROFILE` on
/// Windows. `None` when the environment names none, which refuses
/// nothing rather than everything.
fn home_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var).filter(|v| !v.is_empty()).map(PathBuf::from)
}

fn sensitive_home_roots() -> Vec<(&'static str, PathBuf)> {
    let Some(home) = home_dir() else { return Vec::new() };
    SENSITIVE_HOME_DIRS
        .iter()
        .filter_map(|name| resolve_for_containment(&home.join(name)).ok().map(|p| (*name, p)))
        .collect()
}

/// `StatWorkspacePaths`: each attachment as it resolves on this machine
/// -- the desktop's `attachment_status` classification, answered for a
/// remote root. `outside` is reported, not refused: that is what the
/// classification means, and the desktop decides what to do with it.
pub fn stat_workspace_paths(root: &Path, paths: &[String]) -> Vec<protocol::WorkspacePathStat> {
    let roots = workspace_roots(root);
    let root_canonical = roots.first().cloned().unwrap_or_else(|| root.to_path_buf());
    let sensitive = sensitive_home_roots();
    paths
        .iter()
        .map(|raw| {
            let refused = |reason: String| protocol::WorkspacePathStat {
                path: raw.clone(),
                absolute_path: None,
                exists: false,
                is_dir: false,
                size_bytes: None,
                location: "refused".to_string(),
                refused_reason: Some(reason),
            };
            let Some(usable) = protocol::usable_attachment_path(raw) else {
                return refused("contains a `..` component".to_string());
            };
            let absolute = absolute_in(root, &usable);
            let resolved = resolve_for_containment(&absolute).unwrap_or(absolute);
            if let Some((name, _)) = sensitive.iter().find(|(_, s)| inside_root(s, &resolved)) {
                return refused(format!("lies inside ~/{name}, which gavin refuses to hand an agent"));
            }
            // is_file, not exists: an attachment names a file to read, and
            // one stat answers both `exists` and the size the review sheet
            // quotes, so the two can never describe different files.
            let all = resolved.metadata().ok();
            let is_dir = all.as_ref().is_some_and(|m| m.is_dir());
            let metadata = all.filter(|m| m.is_file());
            let location = if inside_root(&root_canonical, &resolved) {
                "root"
            } else if roots.iter().skip(1).any(|r| inside_root(r, &resolved)) {
                "extraContext"
            } else {
                "outside"
            };
            protocol::WorkspacePathStat {
                path: raw.clone(),
                absolute_path: Some(protocol::wire_path(&resolved)),
                exists: metadata.is_some(),
                is_dir,
                size_bytes: metadata.map(|m| m.len()),
                location: location.to_string(),
                refused_reason: None,
            }
        })
        .collect()
}

/// How long a single `RunGit` subprocess may run. The desktop's own
/// `run_git` uses ten seconds for the synchronous commands the Git tab
/// routes here; the network ops it keeps to itself have their own longer
/// ceiling, and none of them reach this.
const GIT_RUN_TIMEOUT: Duration = Duration::from_secs(30);

/// A directory a `cwd` must be inside for `RunGit` to run there. Same
/// tree as the workspace files: the root and the outside contexts its
/// config names, plus the root itself. A `..` is refused before anything
/// resolves.
fn confined_dir(root: &Path, cwd: &str) -> anyhow::Result<PathBuf> {
    if Path::new(cwd).components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        anyhow::bail!("{cwd} contains a `..` component");
    }
    let resolved = resolve_for_containment(&absolute_in(root, cwd))?;
    if workspace_roots(root).iter().any(|r| inside_root(r, &resolved)) {
        Ok(resolved)
    } else {
        anyhow::bail!("{cwd} is outside the workspace root {}", root.display())
    }
}

/// Where a git worktree is, when it is inside the workspace -- what
/// `WatchGitWorktree` resolves before pointing an OS watch at it. The
/// same confinement `RunGit` gives a cwd, exposed because the watch is
/// set up in `handle_connection` (it owns the connection's writer) rather
/// than in `handle_request`.
pub fn confined_worktree(root: &Path, cwd: &str) -> anyhow::Result<PathBuf> {
    confined_dir(root, cwd)
}

/// `RunGit`: runs `git <args>` in a cwd confined to the root, returning
/// `(stdout, stderr, code)` -- the three the desktop's local `run_git`
/// produces, so the Git tab does not care which ran it.
///
/// The binary is fixed as `git` and `args` is an argv: never a shell,
/// never interpolated, so `["status; rm -rf /"]` is one bogus subcommand
/// git rejects, not a pipeline. This is the app role's existing reach --
/// the desktop already spawns shells here through `CreateSession` -- so it
/// widens nothing; the gate denies it to `agent` and `remote`, which have
/// no business running a process on this machine. `GIT_TERMINAL_PROMPT=0`,
/// like the desktop's runner, so a credential prompt fails instead of
/// hanging a request.
pub fn run_git(
    root: &Path,
    cwd: &str,
    args: &[String],
    stdin: Option<&str>,
) -> anyhow::Result<(Vec<u8>, String, i32)> {
    use std::io::{Read, Write};
    let resolved = confined_dir(root, cwd)?;
    let mut child = crate::program::command("git")
        .args(args)
        .current_dir(&resolved)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(if stdin.is_some() { std::process::Stdio::piped() } else { std::process::Stdio::null() })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                anyhow::anyhow!("git was not found on the host's PATH")
            } else {
                anyhow::anyhow!("failed to run git: {e}")
            }
        })?;
    if let Some(bytes) = stdin {
        if let Some(mut pipe) = child.stdin.take() {
            let bytes = bytes.as_bytes().to_vec();
            std::thread::spawn(move || {
                let _ = pipe.write_all(&bytes);
            });
        }
    }
    let mut out = child.stdout.take().ok_or_else(|| anyhow::anyhow!("git stdout unavailable"))?;
    let mut err = child.stderr.take().ok_or_else(|| anyhow::anyhow!("git stderr unavailable"))?;
    let (out_tx, out_rx) = std::sync::mpsc::channel();
    let (err_tx, err_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = out.read_to_end(&mut buf);
        let _ = out_tx.send(buf);
    });
    std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = err.read_to_string(&mut buf);
        let _ = err_tx.send(buf);
    });
    let deadline = Instant::now() + GIT_RUN_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    anyhow::bail!("git {} timed out after {}s", args.join(" "), GIT_RUN_TIMEOUT.as_secs());
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => anyhow::bail!("failed waiting for git: {e}"),
        }
    };
    let stdout = out_rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
    let stderr = err_rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
    Ok((stdout, stderr, status.code().unwrap_or(-1)))
}

/// `ListWorkspaceDir`: the immediate children of a directory confined to
/// the root, name-sorted, in the shape the file tree reads. A symlinked
/// directory is refused rather than listed through, so the tree cannot
/// leave the root by a link -- the same rule the desktop's `list_directory`
/// applies to a local root.
pub fn list_workspace_dir(root: &Path, path: &str) -> anyhow::Result<Vec<protocol::WorkspaceDirEntry>> {
    let resolved = confined_dir(root, path)?;
    let meta = std::fs::symlink_metadata(&resolved)
        .map_err(|e| anyhow::anyhow!("{path}: {e}"))?;
    if meta.file_type().is_symlink() {
        anyhow::bail!("{path} is a symlink; the file tree does not follow links");
    }
    if !resolved.is_dir() {
        anyhow::bail!("{path} is not a directory");
    }
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&resolved).map_err(|e| anyhow::anyhow!("{path}: {e}"))? {
        let entry = entry.map_err(|e| anyhow::anyhow!("{path}: {e}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        // symlink_metadata: a link to a directory must not read as one, and
        // a file that vanished mid-scan is skipped, not an error -- an
        // agent writing here is the normal case.
        let Ok(meta) = entry.path().symlink_metadata() else { continue };
        let file_type = meta.file_type();
        let is_dir = file_type.is_dir();
        entries.push(protocol::WorkspaceDirEntry {
            name,
            is_dir,
            size: if is_dir { 0 } else { meta.len() },
            symlink: file_type.is_symlink(),
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

/// The only environment variable `RunGitEnv` will set. The desktop's two
/// callers -- cherry-pick and `<op> --continue` -- set exactly this one,
/// and an open-ended environment is a way to point git at a program,
/// which is the reach `RunGit`'s fixed-binary, never-a-shell rule exists
/// to deny. A request naming anything else is refused rather than
/// filtered: a silently dropped variable is how a caller ends up
/// believing it set something.
const GIT_ENV_ALLOWED: &[&str] = &["GIT_EDITOR"];

/// `RunGitEnv`: `run_git` with an allow-listed environment, for the
/// callers that need `GIT_EDITOR=true` so a cherry-pick or a
/// `rebase --continue` never waits on an editor nobody can see.
pub fn run_git_env(
    root: &Path,
    cwd: &str,
    args: &[String],
    env: &[(String, String)],
) -> anyhow::Result<(Vec<u8>, String, i32)> {
    for (key, _) in env {
        if !GIT_ENV_ALLOWED.contains(&key.as_str()) {
            anyhow::bail!("{key} is not an environment variable this daemon will set for git");
        }
    }
    let resolved = confined_dir(root, cwd)?;
    let out = crate::program::command("git")
        .args(args)
        .current_dir(&resolved)
        .env("GIT_TERMINAL_PROMPT", "0")
        .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                anyhow::anyhow!("git was not found on the host's PATH")
            } else {
                anyhow::anyhow!("failed to run git: {e}")
            }
        })?;
    Ok((
        out.stdout,
        String::from_utf8_lossy(&out.stderr).into_owned(),
        out.status.code().unwrap_or(-1),
    ))
}

/// Ceiling for a `RunGitStreaming` op. These are fetch/pull/push, which
/// stream progress and can be cancelled, so this only catches a truly
/// hung transport -- the same ten minutes the desktop's own
/// `GIT_OP_TIMEOUT` allows a local one.
const GIT_OP_TIMEOUT: Duration = Duration::from_secs(600);

/// A running `RunGitStreaming`'s child, shared with whoever may cancel
/// it: the canceller `take()`s and kills it, and the runner reports
/// `cancelled`. The desktop's `SharedChild` by another name, because the
/// op now runs on this side of the wire.
pub type SharedChild = std::sync::Arc<std::sync::Mutex<Option<std::process::Child>>>;

/// `RunGitStreaming`: runs a long git network op in a confined cwd,
/// handing every progress line to `on_line` as git draws it and the
/// child to `register` so a `CancelGitOp` can take it.
///
/// Git writes progress on stderr with `\r` rather than `\n`, so `\r`
/// counts as a line break here -- the desktop's runner splits on both
/// for the same reason, and the Git tab's progress row is what reads the
/// result.
///
/// `Ok(())` on success; `Err` carries git's own last words (the tail of
/// what it said), or `cancelled` when the child was taken.
pub fn run_git_streaming(
    root: &Path,
    cwd: &str,
    args: &[String],
    on_line: &mut dyn FnMut(String),
    register: &mut dyn FnMut(SharedChild),
) -> anyhow::Result<()> {
    use std::io::Read;
    let resolved = confined_dir(root, cwd)?;
    let mut child = crate::program::command("git")
        .args(args)
        .current_dir(&resolved)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                anyhow::anyhow!("git was not found on the host's PATH")
            } else {
                anyhow::anyhow!("failed to run git: {e}")
            }
        })?;
    let mut stderr = child.stderr.take().ok_or_else(|| anyhow::anyhow!("git stderr unavailable"))?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut acc: Vec<u8> = Vec::new();
        loop {
            let n = match stderr.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            for &b in &buf[..n] {
                if b == b'\n' || b == b'\r' {
                    if !acc.is_empty() {
                        let _ = tx.send(String::from_utf8_lossy(&acc).into_owned());
                        acc.clear();
                    }
                } else {
                    acc.push(b);
                }
            }
        }
        if !acc.is_empty() {
            let _ = tx.send(String::from_utf8_lossy(&acc).into_owned());
        }
    });
    let shared: SharedChild = std::sync::Arc::new(std::sync::Mutex::new(Some(child)));
    register(shared.clone());

    let mut tail: Vec<String> = Vec::new();
    let push_tail = |line: &str, tail: &mut Vec<String>| {
        if tail.len() >= 8 {
            tail.remove(0);
        }
        tail.push(line.to_string());
    };
    let deadline = Instant::now() + GIT_OP_TIMEOUT;
    let status = loop {
        while let Ok(line) = rx.try_recv() {
            push_tail(&line, &mut tail);
            on_line(line);
        }
        {
            let mut guard = shared.lock().unwrap();
            let Some(child) = guard.as_mut() else { anyhow::bail!("cancelled") };
            match child.try_wait() {
                Ok(Some(s)) => break s,
                Ok(None) => {
                    if Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        anyhow::bail!("git {} timed out after {}s", args.join(" "), GIT_OP_TIMEOUT.as_secs());
                    }
                }
                Err(e) => anyhow::bail!("failed waiting for git: {e}"),
            }
        }
        std::thread::sleep(Duration::from_millis(30));
    };
    // Drain what the reader still holds; it ends when the pipe closes.
    while let Ok(line) = rx.recv_timeout(Duration::from_millis(200)) {
        push_tail(&line, &mut tail);
        on_line(line);
    }
    *shared.lock().unwrap() = None;
    if status.success() {
        Ok(())
    } else {
        let msg = tail.iter().filter(|l| !l.trim().is_empty()).cloned().collect::<Vec<_>>().join("\n");
        if msg.is_empty() {
            anyhow::bail!("git exited with status {}", status.code().unwrap_or(-1))
        }
        anyhow::bail!("{msg}")
    }
}

/// `CreateWorkspacePath`: an empty file, or one directory, under the
/// root.
///
/// `create_new` rather than a write, and `create_dir` rather than
/// `create_dir_all`: an existing target is refused by the filesystem
/// itself instead of by a check with a window between it and the write,
/// and a missing parent is a typo worth reporting. The desktop's
/// `create_file` / `create_directory` make exactly these two choices for
/// a local root.
pub fn create_workspace_path(root: &Path, path: &str, directory: bool) -> anyhow::Result<()> {
    let resolved = confined(root, path)?;
    if directory {
        std::fs::create_dir(&resolved).map_err(|e| anyhow::anyhow!("{}: {e}", resolved.display()))
    } else {
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&resolved)
            .map(|_| ())
            .map_err(|e| anyhow::anyhow!("{}: {e}", resolved.display()))
    }
}

/// `RenameWorkspacePath`: both ends confined, and the destination must
/// not exist. `fs::rename` overwrites silently on unix, which would turn
/// a mistyped rename into a delete with no trip through the Trash -- the
/// desktop refuses it for the same reason, through `resolve_new`.
pub fn rename_workspace_path(root: &Path, from: &str, to: &str) -> anyhow::Result<()> {
    let source = confined(root, from)?;
    let target = confined(root, to)?;
    if !source.exists() {
        anyhow::bail!("{from} does not exist");
    }
    if target.exists() {
        anyhow::bail!("{to} already exists");
    }
    std::fs::rename(&source, &target)
        .map_err(|e| anyhow::anyhow!("{} -> {}: {e}", source.display(), target.display()))
}

/// `TrashWorkspacePath`: to THIS machine's Trash, never `rm` (see
/// `crate::trash`). The confirmation the human answered stays on the
/// desktop, where the human is; what crosses the wire is a path already
/// agreed to.
pub fn trash_workspace_path(root: &Path, path: &str) -> anyhow::Result<()> {
    let resolved = confined(root, path)?;
    if !resolved.exists() {
        anyhow::bail!("{path} does not exist");
    }
    crate::trash::trash_path(&resolved.to_string_lossy())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{wire_separators, wire_spelling};

    /// A fresh tempdir's path in the spelling a scan reports, for tests
    /// that build paths from it and compare them against scan output.
    ///
    /// Production scans a root that was already resolved --
    /// `GavinWatcher::start` stores `protocol::canonical_path(root)` -- so
    /// everything the scanner reports is resolved too. A test that hands
    /// `scan_root` the RAW tempdir scans a different spelling from the one
    /// `wire_spelling` expects wherever the tempdir sits behind a symlink:
    /// on macOS it is `/var/folders/...` and `/var` is `/private/var`.
    /// Five tests went red there, and the negative recovery tests beside
    /// them could not fail: their keys never met the scan's, so "nothing
    /// recovered" held whatever the code did. Resolving the root first
    /// gives the input and the expectation one spelling on every OS.
    fn wire_root(dir: &tempfile::TempDir) -> PathBuf {
        PathBuf::from(wire_spelling(dir.path()))
    }

    /// Makes a symlink the way the running OS makes one, and reports
    /// whether the OS allowed it at all.
    ///
    /// Two things differ off unix. `std::os::unix::fs::symlink` does not
    /// exist on Windows -- there the file and directory cases are
    /// separate calls, because a Windows symlink records which kind of
    /// object it points at. And creating one needs the
    /// SeCreateSymbolicLink privilege, which an ordinary account does
    /// not hold: without Developer Mode or elevation the call fails with
    /// ERROR_PRIVILEGE_NOT_HELD (1314). That is the normal state of a
    /// Windows machine, not a broken one, so it returns `false` and the
    /// caller returns early rather than failing a suite over something
    /// the OS refused. Every other error still panics -- a symlink that
    /// could have been made and wasn't is a real failure.
    ///
    /// The confinement guards these tests cover are therefore proved on
    /// every unix run, and on a Windows box with Developer Mode on;
    /// on a stock Windows account they are skipped, which is recorded on
    /// the windows-port card.
    #[must_use]
    fn try_symlink(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(target, link);
        #[cfg(windows)]
        let made = if target.is_dir() {
            std::os::windows::fs::symlink_dir(target, link)
        } else {
            std::os::windows::fs::symlink_file(target, link)
        };
        match made {
            Ok(()) => true,
            Err(e) if cfg!(windows) && e.raw_os_error() == Some(1314) => false,
            Err(e) => panic!("symlink {} -> {}: {e}", target.display(), link.display()),
        }
    }

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
    fn attachments_split_and_trim_on_every_kind_and_keep_junk_visible() {
        assert_eq!(
            plan("---\nattachments: docs/spec.md,  /Users/x/shot.png , \n---\n").attachments,
            vec!["docs/spec.md", "/Users/x/shot.png"]
        );
        assert!(plan("---\ntitle: A\n---\n").attachments.is_empty());
        // A note is a fine place to park a reference (card-model: the
        // field parses on any kind; only task/plan put it in a prompt).
        assert_eq!(
            plan("---\nkind: note\nattachments: ref.md\n---\n").attachments,
            vec!["ref.md"]
        );
        // Kept RAW. A `..` entry is refused later, by whoever resolves
        // it -- dropping it here would leave the card looking clean
        // while the agent it launches gets nothing.
        assert_eq!(
            plan("---\nattachments: ../outside.md\n---\n").attachments,
            vec!["../outside.md"]
        );
        assert!(!plan("---\nattachments: ../outside.md\n---\n").parse_warning);
    }

    #[test]
    fn set_plan_field_writes_clears_and_rejects_attachments() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let path = write_card(
            &dir.path().join(GAVIN_ROOT_DIR).join("plans"),
            "p.md",
            "---\ntitle: T\n---\nbody\n",
        );

        set_plan_field(&path, "attachments", "docs/spec.md, /Users/x/shot.png").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "---\nattachments: docs/spec.md, /Users/x/shot.png\ntitle: T\n---\nbody\n"
        );
        assert_eq!(
            plan_file_info(&path, &std::fs::read_to_string(&path).unwrap()).attachments,
            vec!["docs/spec.md", "/Users/x/shot.png"]
        );

        // The fourth key an empty value may clear: taking the last
        // attachment off has to remove the LINE, not leave a card that
        // still reads as if it references a file.
        set_plan_field(&path, "attachments", "").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "---\ntitle: T\n---\nbody\n");

        assert!(set_plan_field(&path, "attachments", "a.md\nb.md").is_err());
    }

    #[test]
    fn complexity_parses_on_every_kind_and_warns_rather_than_guessing() {
        assert_eq!(
            plan("---\ncomplexity: intricate\n---\n").complexity,
            Some(Complexity::Intricate)
        );
        // Case and padding are the human's, not the format's.
        assert_eq!(plan("---\ncomplexity:  Simple \n---\n").complexity, Some(Complexity::Simple));
        // A note is a fine place to record that something will be hard,
        // even though nothing will ever run it.
        assert_eq!(
            plan("---\nkind: note\ncomplexity: trivial\n---\n").complexity,
            Some(Complexity::Trivial)
        );
        assert_eq!(plan("---\ntitle: A\n---\n").complexity, None);
        assert!(!plan("---\ntitle: A\n---\n").parse_warning);
        // The opposite posture to `attachments` above: junk is NOT kept.
        // This field picks an agent, so a level gavin cannot read has to
        // read as unset, and the card has to say so.
        let junk = plan("---\ncomplexity: gnarly\n---\n");
        assert_eq!(junk.complexity, None);
        assert!(junk.parse_warning);
    }

    #[test]
    fn set_plan_field_writes_clears_and_rejects_complexity() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let path = write_card(
            &dir.path().join(GAVIN_ROOT_DIR).join("plans"),
            "p.md",
            "---\ntitle: T\n---\nbody\n",
        );

        // Normalised to the enum's own spelling, so a hand-typed level
        // reads back exactly like a picked one.
        set_plan_field(&path, "complexity", "  Complex ").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "---\ncomplexity: complex\ntitle: T\n---\nbody\n"
        );
        assert_eq!(
            plan_file_info(&path, &std::fs::read_to_string(&path).unwrap()).complexity,
            Some(Complexity::Complex)
        );

        // The fifth key an empty value may clear. "Nobody said" is a real
        // answer here -- it means the card runs the workspace's own agent
        // -- and it is not the same answer as "trivial".
        set_plan_field(&path, "complexity", "").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "---\ntitle: T\n---\nbody\n");

        assert!(set_plan_field(&path, "complexity", "gnarly").is_err());
    }

    #[test]
    fn card_agent_and_model_parse_raw_on_every_kind() {
        let card = plan("---\nagent: codex\nmodel: gpt-5.1\n---\n");
        assert_eq!(card.agent.as_deref(), Some("codex"));
        assert_eq!(card.model.as_deref(), Some("gpt-5.1"));
        // Padding is the human's; the value is not.
        let padded = plan("---\nagent:   claude-code  \nmodel:  opus \n---\n");
        assert_eq!(padded.agent.as_deref(), Some("claude-code"));
        assert_eq!(padded.model.as_deref(), Some("opus"));
        // Either half alone is meaningful: a model with no agent runs the
        // workspace's own binary at that model, which is the commonest
        // override of the two.
        assert_eq!(plan("---\nmodel: opus\n---\n").agent, None);
        assert_eq!(plan("---\nmodel: opus\n---\n").model.as_deref(), Some("opus"));
        // A note is a fine place to record which agent will be needed.
        assert_eq!(plan("---\nkind: note\nagent: codex\n---\n").agent.as_deref(), Some("codex"));
        assert_eq!(plan("---\ntitle: A\n---\n").agent, None);
        assert_eq!(plan("---\ntitle: A\n---\n").model, None);
        // The `attachments` posture, NOT `complexity`'s: the profile
        // table lives in the Tauri host and the model names belong to
        // whichever CLI is installed, so an unknown value is kept and
        // shown back rather than dropped -- that is what makes a typo
        // visible instead of silently running the workspace default.
        let unknown = plan("---\nagent: not-a-profile\n---\n");
        assert_eq!(unknown.agent.as_deref(), Some("not-a-profile"));
        assert!(!unknown.parse_warning);
    }

    #[test]
    fn set_plan_field_writes_and_clears_the_card_agent_and_model() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let path = write_card(
            &dir.path().join(GAVIN_ROOT_DIR).join("plans"),
            "p.md",
            "---\ntitle: T\n---\nbody\n",
        );

        set_plan_field(&path, "agent", "codex").unwrap();
        set_plan_field(&path, "model", "gpt-5.1").unwrap();
        let info = plan_file_info(&path, &std::fs::read_to_string(&path).unwrap());
        assert_eq!(info.agent.as_deref(), Some("codex"));
        assert_eq!(info.model.as_deref(), Some("gpt-5.1"));

        // The sixth and seventh keys an empty value may clear. Clearing
        // is what "back to inheriting" IS: the card returns to whatever
        // its complexity level, or the workspace, picks -- and a leftover
        // `agent:` line with nothing after it would read as a card that
        // still names one.
        set_plan_field(&path, "agent", "").unwrap();
        set_plan_field(&path, "model", "").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "---\ntitle: T\n---\nbody\n");

        // Unvalidated per value, single-line by shape: a second line
        // would corrupt the frontmatter rather than express anything.
        assert!(set_plan_field(&path, "agent", "codex\nclaude-code").is_err());
        assert!(set_plan_field(&path, "model", "opus\nsonnet").is_err());
    }

    #[test]
    fn create_plan_file_writes_a_complexity_line_and_refuses_an_unknown_level() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(GAVIN_ROOT_DIR)).unwrap();
        let path = create_plan_file(
            dir.path(),
            "hard.md",
            "Hard one",
            None,
            None,
            None,
            Some("task"),
            None,
            None,
            Some("Intricate"),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "---\nkind: task\ntitle: Hard one\nstatus: To Do\ncomplexity: intricate\n---\n# Hard one\n"
        );
        // Refused rather than dropped: a card filed with a misspelled
        // level would look placed and quietly run the workspace default.
        assert!(create_plan_file(
            dir.path(),
            "bad.md",
            "Bad",
            None,
            None,
            None,
            None,
            None,
            None,
            Some("gnarly"),
        )
        .is_err());
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
        init_gavin_root(dir.path(), "WS").unwrap();
        let path = write_card(
            &dir.path().join(GAVIN_ROOT_DIR).join("plans"),
            "p.md",
            "---\ntitle: T\nkind: task\nstatus: To Do\nparent: a.md\nlabels: x\n---\nbody\n",
        );
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
        init_gavin_root(dir.path(), "WS").unwrap();
        let path =
            write_card(&dir.path().join(GAVIN_ROOT_DIR).join("plans"), "p.md", "---\ntitle: T\n---\n");
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
        init_gavin_root(dir.path(), "WS").unwrap();
        let path = write_card(
            &dir.path().join(GAVIN_ROOT_DIR).join("plans"),
            "p.md",
            "---\ntitle: T\nstatus: To Do\n---\nbody\n",
        );
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
        init_gavin_root(dir.path(), "WS").unwrap();
        let path = write_card(
            &dir.path().join(GAVIN_ROOT_DIR).join("plans"),
            "p.md",
            "---\nstatus: To Do\npriority: low\n---\nbody\n",
        );
        set_plan_field(&path, "priority", "urgent").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "---\nstatus: To Do\npriority: urgent\n---\nbody\n"
        );
    }

    #[test]
    fn set_plan_field_writes_title_surgically_and_rejects_empty_or_multiline() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let path = write_card(
            &dir.path().join(GAVIN_ROOT_DIR).join("plans"),
            "p.md",
            "---\ntitle: Old\nstatus: To Do\n---\n# Body\n",
        );

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
        init_gavin_root(dir.path(), "WS").unwrap();
        let path =
            write_card(&dir.path().join(GAVIN_ROOT_DIR).join("plans"), "p.md", "---\nstatus: To Do\n---\n");
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
        init_gavin_root(dir.path(), "WS").unwrap();
        let original = "---\ntitle: P\n---\n# H\n- [ ] one\n  - [x] two\nrest\n";
        let path = write_card(&dir.path().join(GAVIN_ROOT_DIR).join("plans"), "p.md", original);
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
        init_gavin_root(dir.path(), "WS").unwrap();
        let original = "---\ntitle: P\n---\n- [ ] one\n";
        let path = write_card(&dir.path().join(GAVIN_ROOT_DIR).join("plans"), "p.md", original);
        assert!(set_checklist_item(&path, 99, "one", true).is_err()); // out of range
        assert!(set_checklist_item(&path, 3, "drifted", true).is_err()); // text mismatch
        assert!(set_checklist_item(&path, 1, "title: P", true).is_err()); // not a checkbox line
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original); // no writes on error
    }

    // ---------- human items (the Decisions tab) ----------

    /// Every marker spelling the interview settled on, including the four
    /// legacy ones already on cards in this repo -- a tab that could not
    /// read those would show an empty list on a workspace full of them.
    #[test]
    fn every_marker_spelling_parses_and_near_misses_do_not() {
        let items = human_items(
            "---\ntitle: P\n---\n\
             - [ ] Decision: Which serializer?\n\
             - [ ] Human test: install it on the other machine\n\
             - [x] Human: try the installer\n\
             - [ ] Human, on the other machine: run the smoke\n\
             - [x] Owner, in the running app: check the drag\n\
             - [ ] Owner check in the running app: the pip\n\
             - [x] Manual smoke: the hub strip\n\
             - [ ] manual pass: the whole board\n",
        );
        let kinds: Vec<_> = items.iter().map(|i| i.kind).collect();
        assert_eq!(
            kinds,
            vec![
                HumanItemKind::Decision,
                HumanItemKind::Test,
                HumanItemKind::Test,
                HumanItemKind::Test,
                HumanItemKind::Test,
                HumanItemKind::Test,
                HumanItemKind::Test,
                HumanItemKind::Test,
            ]
        );
        // The marker is stripped for display and kept whole for the guard.
        assert_eq!(items[0].text, "Which serializer?");
        assert_eq!(items[0].line_text, "Decision: Which serializer?");
        assert_eq!(items[3].text, "run the smoke");
        assert_eq!(items[5].text, "the pip");
        // The checkbox travels as itself.
        assert_eq!(items.iter().map(|i| i.done).collect::<Vec<_>>(), vec![
            false, false, true, false, true, false, true, false
        ]);

        // Near misses: the right letters, nothing being asked.
        let none = human_items(
            "---\ntitle: P\n---\n\
             - [ ] Manually rewrite the parser: it is unreadable\n\
             - [ ] Human-readable output: print a table\n\
             - [ ] Decide on the serializer: pick one\n\
             - [ ] no colon at all\n\
             - [ ] A sentence long enough that the colon it does carry arrives well past any marker: so\n",
        );
        assert!(none.is_empty(), "{none:?}");

        // Non-ASCII text, which is ordinary on these cards: an em dash
        // straddling the byte the marker window or a prefix test would
        // otherwise cut at must shorten the search, never panic and
        // never drop the item.
        let wide = human_items(
            "---\ntitle: P\n---\n\
             - [ ] Decision: ¿cuál serializador — serde o a mano?\n\
             - [ ] Un párrafo bastante largo que sí lleva dos puntos — aquí: no es marcador\n",
        );
        assert_eq!(wide.len(), 1);
        assert_eq!(wide[0].text, "¿cuál serializador — serde o a mano?");
    }

    /// The indented `Options:` line, in the shape `file_human_item`
    /// writes and the two it tolerates from a human's own hand.
    #[test]
    fn options_come_off_the_indented_options_line() {
        let labelled = human_items(
            "---\ntitle: P\n---\n- [ ] Decision: Which serializer?\n   \
             Options: A) serde, and the dep B) by hand\n",
        );
        assert_eq!(labelled[0].options, vec!["serde, and the dep", "by hand"]);

        let piped = human_items(
            "---\ntitle: P\n---\n- [ ] Decision: Which?\n  Options: serde | by hand\n",
        );
        assert_eq!(piped[0].options, vec!["serde", "by hand"]);

        // One unlabelled choice stays one choice: a comma split would
        // shred the commas a person writes inside a phrase.
        let one = human_items(
            "---\ntitle: P\n---\n- [ ] Decision: Which?\n  Options: serde, and nothing else\n",
        );
        assert_eq!(one[0].options, vec!["serde, and nothing else"]);

        // Not indented past the item -> not this item's options.
        let loose =
            human_items("---\ntitle: P\n---\n- [ ] Decision: Which?\nOptions: A) a B) b\n");
        assert!(loose[0].options.is_empty());

        // A test has none, and an item with no Options line has none.
        let bare = human_items("---\ntitle: P\n---\n- [ ] Human test: check it\n");
        assert!(bare[0].options.is_empty());
    }

    /// The answer/result/re-arm lines, and the state each implies. The
    /// LAST one wins: they accumulate under the item, newest at the
    /// bottom.
    #[test]
    fn the_last_outcome_line_sets_the_state() {
        let card = |under: &str| {
            let items =
                human_items(&format!("---\ntitle: P\n---\n- [ ] Human test: check it\n{under}"));
            (items[0].state, items[0].latest.clone())
        };
        assert_eq!(card(""), (HumanItemState::Open, None));
        assert_eq!(
            card("  Result (2026-09-23): passed\n"),
            (HumanItemState::Passed, Some("Result (2026-09-23): passed".to_string()))
        );
        assert_eq!(
            card("  Result (2026-09-23): failed — the installer hung\n"),
            (
                HumanItemState::Failed,
                Some("Result (2026-09-23): failed — the installer hung".to_string())
            )
        );
        assert_eq!(
            card("  Answer (2026-09-23): use serde\n"),
            (HumanItemState::Answered, Some("Answer (2026-09-23): use serde".to_string()))
        );
        // A re-armed failure is OPEN again -- the whole point of arming it.
        assert_eq!(
            card("  Result (2026-09-22): failed — hung\n  Ready for re-test (2026-09-23)\n"),
            (HumanItemState::Open, Some("Ready for re-test (2026-09-23)".to_string()))
        );
        // And a re-arm that was then re-run reads as its new result.
        assert_eq!(
            card(
                "  Result (2026-09-22): failed — hung\n  \
                 Ready for re-test (2026-09-23)\n  Result (2026-09-23): passed\n"
            ),
            (HumanItemState::Passed, Some("Result (2026-09-23): passed".to_string()))
        );
        // An Options line is not an outcome, and neither is a Result
        // line that says neither passed nor failed: guessing either way
        // is worse than leaving the item where it was.
        assert_eq!(card("  Options: A) a B) b\n"), (HumanItemState::Open, None));
        assert_eq!(card("  Result (2026-09-23): maybe\n"), (HumanItemState::Open, None));
        // A blank line ends the block: what comes after belongs to
        // nobody, least of all this item.
        assert_eq!(card("\n  Result (2026-09-23): passed\n"), (HumanItemState::Open, None));
    }

    /// The state and the checkbox are two different questions, which is
    /// why both travel.
    #[test]
    fn a_failed_item_is_unticked_and_a_closed_one_is_not() {
        let items = human_items(
            "---\ntitle: P\n---\n\
             - [ ] Human test: a\n  Result (2026-09-23): failed — no\n\
             - [x] Human test: b\n  Result (2026-09-23): failed — overruled\n",
        );
        assert_eq!((items[0].state, items[0].done), (HumanItemState::Failed, false));
        assert_eq!((items[1].state, items[1].done), (HumanItemState::Failed, true));
    }

    /// A marker inside a fence is a spec quoting the syntax, not a
    /// question. Every design doc for this feature contains one.
    #[test]
    fn a_marker_inside_a_code_fence_is_not_an_item() {
        let items = human_items(
            "---\ntitle: P\n---\n\
             Write them like this:\n\n\
             ```md\n\
             - [ ] Decision: which one?\n\
             ~~~\n\
             - [ ] Human test: not this either\n\
             ```\n\n\
             - [ ] Decision: but this one counts\n",
        );
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, "but this one counts");
        // A fence opened and never closed swallows the rest of the file,
        // which is what a renderer does with it too.
        let unclosed =
            human_items("---\ntitle: P\n---\n```\n- [ ] Decision: inside forever\n");
        assert!(unclosed.is_empty());
        // Tildes do not close backticks, and a shorter run does not
        // close a longer one.
        let mixed = human_items(
            "---\ntitle: P\n---\n````\n```\n- [ ] Decision: still inside\n````\n- [ ] Decision: out\n",
        );
        assert_eq!(mixed.len(), 1);
        assert_eq!(mixed[0].text, "out");
    }

    /// Frontmatter is not body, and `line_index` counts from the top of
    /// the FILE -- the index `SetChecklistItem` addresses lines by.
    #[test]
    fn items_are_read_from_the_body_and_indexed_against_the_whole_file() {
        let items =
            human_items("---\nstatus: Decision: not a checklist item\n---\n\n- [ ] Decision: real\n");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].line_index, 4);
        // An unterminated frontmatter block yields no body at all, the
        // same reading `checklist_counts` takes of it.
        assert!(human_items("---\ntitle: P\n- [ ] Decision: x\n").is_empty());
    }

    /// The tree carries the parse, and an oversize card carries `None` --
    /// "never looked" rather than "nothing waiting".
    #[test]
    fn plan_file_info_carries_the_items_and_an_unread_card_carries_none() {
        let p = plan("---\ntitle: P\n---\n- [ ] Decision: which?\n");
        assert_eq!(p.human_items.as_ref().map(Vec::len), Some(1));
        assert_eq!(plan("---\ntitle: P\n---\n# nothing\n").human_items, Some(vec![]));
        assert_eq!(oversize_plan_file_info(Path::new("/tmp/plans/big.md")).human_items, None);
    }

    fn card_with(dir: &tempfile::TempDir, body: &str) -> PathBuf {
        write_card(&dir.path().join(GAVIN_ROOT_DIR).join("plans"), "p.md", body)
    }

    fn a_root() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        dir
    }

    #[test]
    fn filing_appends_after_the_last_checklist_item_and_its_block() {
        let dir = a_root();
        // The shape of a real plan card: a checklist, then prose the
        // agent must not be filed below.
        let path = card_with(
            &dir,
            "---\ntitle: P\n---\n## Checklist\n\n- [ ] one\n- [x] two\n      wrapped continuation\n\n\
             <!-- gavin:auto-commit -->\nCommit it.\n<!-- /gavin:auto-commit -->\n",
        );
        assert!(!file_human_item(
            &path,
            HumanItemKind::Decision,
            "  Which serializer?  ",
            &["serde".to_string(), "by hand".to_string()],
            "2026-09-23",
        )
        .unwrap());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "---\ntitle: P\n---\n## Checklist\n\n- [ ] one\n- [x] two\n      wrapped continuation\n\
             - [ ] Decision: Which serializer?\n  Options: A) serde B) by hand\n\n\
             <!-- gavin:auto-commit -->\nCommit it.\n<!-- /gavin:auto-commit -->\n"
        );
        // And it reads back as what was written.
        let item = &human_items(&std::fs::read_to_string(&path).unwrap())[0];
        assert_eq!(item.options, vec!["serde", "by hand"]);
        assert_eq!(item.state, HumanItemState::Open);
    }

    #[test]
    fn filing_on_a_card_with_no_checklist_starts_one() {
        let dir = a_root();
        let path = card_with(&dir, "---\ntitle: P\n---\nDo the thing.\n");
        file_human_item(&path, HumanItemKind::Test, "check the installer", &[], "2026-09-23")
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "---\ntitle: P\n---\nDo the thing.\n\n- [ ] Human test: check the installer\n"
        );
        // A card that is nothing but frontmatter, and one with no
        // trailing newline, both survive.
        let bare = card_with(&dir, "---\ntitle: P\n---");
        file_human_item(&bare, HumanItemKind::Decision, "which?", &[], "2026-09-23").unwrap();
        assert_eq!(std::fs::read_to_string(&bare).unwrap(), "---\ntitle: P\n---\n\n- [ ] Decision: which?");
    }

    #[test]
    fn re_filing_an_identical_failed_test_re_arms_it_instead_of_duplicating() {
        let dir = a_root();
        let path = card_with(
            &dir,
            "---\ntitle: P\n---\n- [ ] Human test: check the installer\n  \
             Result (2026-09-22): failed — it hung\n",
        );
        assert!(file_human_item(
            &path,
            HumanItemKind::Test,
            "check the installer",
            &[],
            "2026-09-23"
        )
        .unwrap());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "---\ntitle: P\n---\n- [ ] Human test: check the installer\n  \
             Result (2026-09-22): failed — it hung\n  Ready for re-test (2026-09-23)\n"
        );
        let items = human_items(&std::fs::read_to_string(&path).unwrap());
        assert_eq!(items.len(), 1, "no duplicate line");
        assert_eq!(items[0].state, HumanItemState::Open);

        // Re-arming an already-armed test appends a second marker line
        // rather than a second item -- it is the same check either way.
        file_human_item(&path, HumanItemKind::Test, "check the installer", &[], "2026-09-24")
            .unwrap();
        assert_eq!(human_items(&std::fs::read_to_string(&path).unwrap()).len(), 2);
    }

    #[test]
    fn only_a_failed_test_re_arms() {
        let dir = a_root();
        // A PASSED test of the same text is a second ask, not a re-arm.
        let passed = card_with(
            &dir,
            "---\ntitle: P\n---\n- [x] Human test: check it\n  Result (2026-09-22): passed\n",
        );
        assert!(!file_human_item(&passed, HumanItemKind::Test, "check it", &[], "2026-09-23")
            .unwrap());
        assert_eq!(human_items(&std::fs::read_to_string(&passed).unwrap()).len(), 2);

        // And a DECISION never re-arms: asking again is a new question,
        // and the old answer is the record of why.
        let decided = write_card(
            &dir.path().join(GAVIN_ROOT_DIR).join("plans"),
            "d.md",
            "---\ntitle: D\n---\n- [ ] Decision: which?\n  Result (2026-09-22): failed — no\n",
        );
        assert!(!file_human_item(&decided, HumanItemKind::Decision, "which?", &[], "2026-09-23")
            .unwrap());
        assert_eq!(human_items(&std::fs::read_to_string(&decided).unwrap()).len(), 2);
    }

    #[test]
    fn filing_refuses_empty_text_a_newline_and_a_path_outside_a_root() {
        let dir = a_root();
        let path = card_with(&dir, "---\ntitle: P\n---\n- [ ] one\n");
        let before = std::fs::read_to_string(&path).unwrap();
        assert!(file_human_item(&path, HumanItemKind::Decision, "   ", &[], "2026-09-23").is_err());
        assert!(
            file_human_item(&path, HumanItemKind::Decision, "a\nb", &[], "2026-09-23").is_err()
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before, "no writes on error");

        let loose = tempfile::tempdir().unwrap();
        let outside = write_card(loose.path(), "p.md", "---\ntitle: P\n---\n- [ ] one\n");
        assert!(
            file_human_item(&outside, HumanItemKind::Decision, "which?", &[], "2026-09-23")
                .is_err()
        );
    }

    #[test]
    fn resolving_writes_the_line_and_sets_the_box() {
        let outcomes = [
            (
                HumanItemOutcome::Answer { text: "serde —\nit is already in".into() },
                "- [x] Decision: which?",
                "  Answer (2026-09-23): serde — it is already in",
            ),
            (HumanItemOutcome::Pass, "- [x] Decision: which?", "  Result (2026-09-23): passed"),
            (
                HumanItemOutcome::Fail { note: "it hung".into() },
                "- [ ] Decision: which?",
                "  Result (2026-09-23): failed — it hung",
            ),
            (
                HumanItemOutcome::FailAndClose { note: "not worth it".into() },
                "- [x] Decision: which?",
                "  Result (2026-09-23): failed — not worth it",
            ),
            (
                HumanItemOutcome::Fail { note: "  ".into() },
                "- [ ] Decision: which?",
                "  Result (2026-09-23): failed",
            ),
        ];
        for (outcome, item_line, written) in outcomes {
            let dir = a_root();
            let path = card_with(
                &dir,
                "---\ntitle: P\n---\n- [ ] Decision: which?\n  Options: A) a B) b\n- [ ] after\n",
            );
            resolve_human_item(&path, "Decision: which?", &outcome, "2026-09-23").unwrap();
            assert_eq!(
                std::fs::read_to_string(&path).unwrap(),
                format!(
                    "---\ntitle: P\n---\n{item_line}\n  Options: A) a B) b\n{written}\n- [ ] after\n"
                ),
                "{outcome:?}"
            );
        }
    }

    /// A plain fail leaves the item open for the agent; the human
    /// overruling it closes the box and keeps the same note.
    #[test]
    fn a_plain_fail_stays_open_and_fail_and_close_does_not() {
        let dir = a_root();
        let path = card_with(&dir, "---\ntitle: P\n---\n- [ ] Human test: check it\n");
        resolve_human_item(
            &path,
            "Human test: check it",
            &HumanItemOutcome::Fail { note: "hung".into() },
            "2026-09-23",
        )
        .unwrap();
        let after = human_items(&std::fs::read_to_string(&path).unwrap());
        assert_eq!((after[0].state, after[0].done), (HumanItemState::Failed, false));

        resolve_human_item(
            &path,
            "Human test: check it",
            &HumanItemOutcome::FailAndClose { note: "hung, shipping anyway".into() },
            "2026-09-24",
        )
        .unwrap();
        let closed = human_items(&std::fs::read_to_string(&path).unwrap());
        assert_eq!((closed[0].state, closed[0].done), (HumanItemState::Failed, true));
        assert_eq!(
            closed[0].latest.as_deref(),
            Some("Result (2026-09-24): failed — hung, shipping anyway")
        );
    }

    /// The `SetChecklistItem` guard, on the only key this request has.
    #[test]
    fn resolving_refuses_a_stale_or_ambiguous_expected_text() {
        let dir = a_root();
        let path = card_with(&dir, "---\ntitle: P\n---\n- [ ] Decision: which?\n- [ ] plain\n");
        let before = std::fs::read_to_string(&path).unwrap();
        // The agent rewrote the question under the tab.
        assert!(resolve_human_item(
            &path,
            "Decision: which one?",
            &HumanItemOutcome::Pass,
            "2026-09-23"
        )
        .is_err());
        // A checklist line that is not a human item at all.
        assert!(resolve_human_item(&path, "plain", &HumanItemOutcome::Pass, "2026-09-23").is_err());
        // An empty answer is not an answer.
        assert!(resolve_human_item(
            &path,
            "Decision: which?",
            &HumanItemOutcome::Answer { text: "  ".into() },
            "2026-09-23"
        )
        .is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before, "no writes on error");

        // Two items reading the same thing: refused rather than guessed.
        let twice = write_card(
            &dir.path().join(GAVIN_ROOT_DIR).join("plans"),
            "t.md",
            "---\ntitle: T\n---\n- [ ] Decision: which?\n- [ ] Decision: which?\n",
        );
        let err = resolve_human_item(&twice, "Decision: which?", &HumanItemOutcome::Pass, "2026-09-23")
            .unwrap_err()
            .to_string();
        assert!(err.contains("ambiguous"), "{err}");

        let loose = tempfile::tempdir().unwrap();
        let outside =
            write_card(loose.path(), "p.md", "---\ntitle: P\n---\n- [ ] Decision: which?\n");
        assert!(
            resolve_human_item(&outside, "Decision: which?", &HumanItemOutcome::Pass, "2026-09-23")
                .is_err()
        );
    }

    /// An indented item's answer is indented under IT, not at the top
    /// level, and the item's own indentation survives the tick.
    #[test]
    fn a_nested_item_keeps_its_indentation() {
        let dir = a_root();
        let path = card_with(&dir, "---\ntitle: P\n---\n- [ ] parent\n  - [ ] Decision: which?\n");
        resolve_human_item(&path, "Decision: which?", &HumanItemOutcome::Pass, "2026-09-23")
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "---\ntitle: P\n---\n- [ ] parent\n  - [x] Decision: which?\n    \
             Result (2026-09-23): passed\n"
        );
    }

    /// The only piece of `today()` a test can pin: the platform calls
    /// above hand back a civil date directly, and this is the fallback
    /// arm's arithmetic.
    #[test]
    fn ymd_from_unix_converts_the_epoch_to_a_civil_date() {
        assert_eq!(ymd_from_unix(0), "1970-01-01");
        assert_eq!(ymd_from_unix(1_758_585_600), "2025-09-23");
        // A leap day, and the year-2000 leap-century exception.
        assert_eq!(ymd_from_unix(951_782_400), "2000-02-29");
        assert_eq!(ymd_from_unix(-1), "1969-12-31");
        // And the real clock agrees with itself.
        assert_eq!(today().len(), 10);
        assert_eq!(today().matches('-').count(), 2);
    }

    /// DP-03: this request used to act on any path the wire named. Now it
    /// is `confine_card_path`'s job, exactly like `delete_card_file`'s own
    /// guard tests above.
    #[test]
    fn set_checklist_item_refuses_a_path_outside_any_gavin_root() {
        let dir = tempfile::tempdir().unwrap();
        let loose = write_card(dir.path(), "p.md", "---\ntitle: P\n---\n- [ ] one\n");
        assert!(set_checklist_item(&loose, 3, "one", true).is_err());
        assert_eq!(std::fs::read_to_string(&loose).unwrap(), "---\ntitle: P\n---\n- [ ] one\n");
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

    /// DP-03: `plan_path` is confined the same way `delete_card_file`'s
    /// target already was.
    #[test]
    fn promote_checklist_item_refuses_a_path_outside_any_gavin_root() {
        let dir = tempfile::tempdir().unwrap();
        let loose = write_card(dir.path(), "p.md", "---\ntitle: P\n---\n- [ ] one\n");
        assert!(promote_checklist_item(&loose, "one").is_err());
        assert_eq!(std::fs::read_to_string(&loose).unwrap(), "---\ntitle: P\n---\n- [ ] one\n");
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

    /// The other half of `confine_card_path`'s lift: a lexically
    /// well-formed `.gavin*/plans/x.md` that RESOLVES somewhere else
    /// entirely through a symlinked component must be caught too, not
    /// just a literal `..`.
    #[test]
    fn confine_card_path_resolves_symlinks_before_checking_the_shape() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let plans = dir.path().join(GAVIN_ROOT_DIR).join("plans");
        let outside = tempfile::tempdir().unwrap();
        let victim = outside.path().join("victim.md");
        std::fs::write(&victim, "x").unwrap();
        let link = plans.join("looks-like-a-card.md");
        if !try_symlink(&victim, &link) {
            return; // this account cannot make one; see try_symlink
        }
        assert!(confine_card_path(&link).is_err());
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "x");
    }

    /// A worktree folder named after a branch called `plans`, `docs` or
    /// `specs` sits directly under `.gavin-worktrees` -- a `.gavin*`
    /// name that is no marker. The card-shape gates match the two marker
    /// names exactly, so a README in that checkout is not a card: no
    /// status write files it under `done/`, and no delete reaches it.
    #[test]
    fn a_worktree_named_like_a_card_folder_is_not_one() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        for folder in ["plans", "docs", "specs"] {
            let wt = dir.path().join(".gavin-worktrees").join(folder);
            std::fs::create_dir_all(&wt).unwrap();
            let readme = wt.join("README.md");
            std::fs::write(&readme, "# not a card\n").unwrap();
            assert!(confine_card_path(&readme).is_err(), "{folder}");
            assert!(delete_card_file(&readme).is_err(), "{folder}");
            assert!(readme.exists(), "{folder}");
        }
        let readme = dir.path().join(".gavin-worktrees").join("plans").join("README.md");
        assert_eq!(governed_plans_root(&readme), None);
        // The real markers still pass.
        let card = dir.path().join(GAVIN_ROOT_DIR).join("plans").join("a.md");
        std::fs::write(&card, "---\ntitle: A\n---\n").unwrap();
        assert!(confine_card_path(&card).is_ok());
        assert!(governed_plans_root(&card).is_some());
    }

    #[test]
    fn external_contexts_register_scan_and_unregister() {
        let root_dir = tempfile::tempdir().unwrap();
        let outside_dir = tempfile::tempdir().unwrap();
        let root = wire_root(&root_dir);
        let outside = wire_root(&outside_dir);
        init_gavin_root(&root, "WS").unwrap();
        let lib = outside.join("shared-lib");
        std::fs::create_dir_all(&lib).unwrap();

        add_external_context(&root, &lib).unwrap();
        assert!(lib.join(GAVIN_DIR).join("plans").is_dir());
        // Registering twice keeps one entry:
        add_external_context(&root, &lib).unwrap();
        let config =
            std::fs::read_to_string(root.join(GAVIN_ROOT_DIR).join("config.toml")).unwrap();
        assert_eq!(config.matches("shared-lib").count(), 1);

        let tree = scan_root(&root);
        let ctx = tree.contexts.last().unwrap();
        assert_eq!(ctx.folder_path, wire_spelling(&lib));
        assert!(ctx.outside);
        assert!(!tree.contexts.first().unwrap().outside);

        // A folder inside the workspace refuses registration:
        let inner = root.join("inner");
        std::fs::create_dir_all(&inner).unwrap();
        assert!(add_external_context(&root, &inner).is_err());

        remove_external_context(&root, &lib).unwrap();
        assert!(scan_root(&root).contexts.iter().all(|c| !c.outside));
        // Removing an unregistered path is a no-op, not an error:
        remove_external_context(&root, &lib).unwrap();
    }

    /// DP-03: the confinement `CreateGavinContext` and
    /// `AddExternalGavinContext` check their root/parent argument against
    /// in `server.rs`, before either function above ever runs.
    #[test]
    fn confine_root_path_accepts_watched_roots_and_their_kin_and_refuses_the_rest() {
        let watched = tempfile::tempdir().unwrap();
        let watched_root = watched.path().canonicalize().unwrap();
        let nested = watched_root.join("feature");
        std::fs::create_dir_all(&nested).unwrap();
        let unrelated = tempfile::tempdir().unwrap();

        // Built the way `SessionManager::watched_roots` builds it -- a
        // `GavinWatcher` stores `protocol::canonical_path(root)`, not
        // `root.canonicalize()`. Spelling the list with raw
        // canonicalisation instead made both sides of the comparison
        // verbatim by construction on Windows, and hid the mismatch
        // that refused every context creation there.
        let roots = vec![protocol::canonical_path(watched.path()).unwrap()];

        // The watched root itself:
        assert_eq!(confine_root_path(&watched_root, &roots).unwrap(), watched_root);
        // A descendant of it (CreateGavinContext's ordinary case):
        assert_eq!(confine_root_path(&nested, &roots).unwrap(), nested);
        // An ancestor of it (AddExternalGavinContext's root_path could be
        // one of several nested roots this daemon watches):
        assert_eq!(
            confine_root_path(watched_root.parent().unwrap(), &roots).unwrap(),
            watched_root.parent().unwrap()
        );
        // Unrelated to every watched root: refused.
        assert!(confine_root_path(unrelated.path(), &roots).is_err());
        // Nothing watched at all: refused, not vacuously accepted.
        assert!(confine_root_path(&watched_root, &[]).is_err());
        // Must exist:
        assert!(confine_root_path(&watched_root.join("nope"), &roots).is_err());
    }

    #[test]
    fn scan_skips_extra_contexts_that_are_missing_or_inside_the_root() {
        let root_dir = tempfile::tempdir().unwrap();
        let root = wire_root(&root_dir);
        init_gavin_root(&root, "WS").unwrap();
        let config = root.join(GAVIN_ROOT_DIR).join("config.toml");
        let inside = root.join("src");
        std::fs::create_dir_all(inside.join(GAVIN_DIR)).unwrap();
        let mut body = std::fs::read_to_string(&config).unwrap();
        // TOML LITERAL strings (single quotes), not basic ones: a Windows
        // path is `C:\Users\...`, and `\U` is an escape TOML rejects, so
        // a basic string here fails to parse and the extras list silently
        // comes back empty -- which is to say the skip this test is about
        // would never be exercised on Windows. `add_external_context`
        // writes the native spelling through `toml_edit`, which escapes
        // it; writing the file by hand has to do one or the other.
        body.push_str(&format!(
            "extra_contexts = ['{}', '/definitely/not/there']\n",
            inside.display()
        ));
        std::fs::write(&config, body).unwrap();
        let tree = scan_root(&root);
        // `src` still appears once -- from the walk, not the extras list.
        let src_entries =
            tree.contexts.iter().filter(|c| c.folder_path == wire_spelling(&inside)).count();
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
        // The scaffolded config still parses with the `[worktree]` hint in
        // it, and the hint stays a hint -- a live block here would be a
        // declaration nobody made.
        let config = std::fs::read_to_string(g.join("config.toml")).unwrap();
        assert!(config.contains("# [worktree]"));
        let table = config.parse::<toml::Table>().unwrap();
        assert!(table.get("worktree").is_none());
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

    /// `.gavin-worktrees` holds whole checkouts of this repository, each
    /// with its own `.gavin-root` and `.gavin` folders. The name starts
    /// with `.gavin` because the folder is gavin's, but it is no marker:
    /// listing a worktree's copies as contexts of this workspace would put
    /// every card on the board twice, and their churn must not rescan
    /// this tree. Both hold only because the scan and `tree_relevant`
    /// match the two marker names exactly and skip every other dot
    /// directory -- a `starts_with(".gavin")` in either would break it.
    #[test]
    fn a_nested_worktree_is_neither_scanned_nor_tree_relevant() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let wt = dir.path().join(".gavin-worktrees").join("feat-x");
        let feature = wt.join("auth");
        std::fs::create_dir_all(&feature).unwrap();
        init_gavin_root(&wt, "WS").unwrap();
        create_gavin_context(&feature).unwrap();

        let tree = scan_root(dir.path());
        assert_eq!(tree.contexts.len(), 1, "{:?}", tree.contexts.iter().map(|c| &c.folder_path).collect::<Vec<_>>());
        assert_eq!(tree.contexts[0].kind, GavinContextKind::Root);

        for churn in [
            ".gavin-worktrees",
            ".gavin-worktrees/feat-x",
            ".gavin-worktrees/feat-x/.gavin-root/plans/a.md",
            ".gavin-worktrees/feat-x/auth/.gavin/plans/b.md",
        ] {
            assert!(!tree_relevant(dir.path(), Some(&tree), &dir.path().join(churn)), "{churn}");
        }
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

    /// DP-05: a hostile repo's oversize plan file must not be read into
    /// memory on every rescan. It still appears in the tree -- never
    /// silently dropped -- but as a warning, with none of its claimed
    /// frontmatter believed.
    #[test]
    fn oversize_plan_file_is_reported_as_a_warning_not_read() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let plans = dir.path().join(GAVIN_ROOT_DIR).join("plans");
        let mut body = "---\ntitle: should-not-be-read\nstatus: Done\n---\n".to_string();
        body.push_str(&"x".repeat(MAX_SCANNED_FILE_BYTES as usize + 1));
        write_card(&plans, "big.md", &body);

        let tree = scan_root(dir.path());
        let big = tree.contexts[0]
            .plans
            .iter()
            .find(|p| p.file_name == "big.md")
            .expect("oversize card still listed");
        assert!(big.parse_warning);
        assert_eq!(big.title, "big");
        assert_eq!(big.status, None);
        assert_eq!(big.checklist_total, 0);
    }

    /// DP-05: a directory symlink inside the repo must not let the scan
    /// wander outside the watched root and read whatever it finds there.
    #[test]
    fn symlinked_directory_leaving_the_root_is_not_followed() {
        let root = tempfile::tempdir().unwrap();
        init_gavin_root(root.path(), "WS").unwrap();
        let outside = tempfile::tempdir().unwrap();
        // A `.gavin` context sitting entirely outside the watched root --
        // the content a hostile repo's symlink is trying to reach.
        write_card(&outside.path().join(GAVIN_DIR).join("plans"), "leak.md", "---\ntitle: Leak\n---\n");

        let link = root.path().join("escape");
        if !try_symlink(outside.path(), &link) {
            return; // this account cannot make one; see try_symlink
        }

        let tree = scan_root(root.path());
        // Only the Root context -- the symlink was never descended into,
        // so the `.gavin` context beyond it was never found, let alone
        // its plan read.
        assert_eq!(tree.contexts.len(), 1);
        assert_eq!(tree.contexts[0].kind, GavinContextKind::Root);
        assert!(tree.contexts.iter().all(|c| c.plans.iter().all(|p| p.title != "Leak")));
    }

    /// The same guard has to apply to a symlinked FILE's plain sibling
    /// content too -- i.e. a symlinked file itself must still be read
    /// normally, only directory descent is restricted.
    #[test]
    fn symlinked_file_inside_a_context_is_still_read() {
        let root = tempfile::tempdir().unwrap();
        init_gavin_root(root.path(), "WS").unwrap();
        let plans = root.path().join(GAVIN_ROOT_DIR).join("plans");
        let real = write_card(&plans, "real.md", "---\ntitle: Real\n---\n");
        let link = plans.join("linked.md");
        if !try_symlink(&real, &link) {
            return; // this account cannot make one; see try_symlink
        }

        let tree = scan_root(root.path());
        assert!(tree.contexts[0].plans.iter().any(|p| p.file_name == "linked.md" && p.title == "Real"));
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
        assert_eq!(agent.mcp_file, None, "and so does the MCP layout");
        assert_eq!(agent.mcp_format, None);
    }

    #[test]
    fn the_prd_path_falls_back_to_the_scaffolded_one_and_follows_the_config() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        assert_eq!(prd_relative_path(dir.path()), protocol::DEFAULT_PRD_PATH);

        // A project that already had its own PRD points gavin at it; the
        // scaffolded one is left alone, and every reader follows.
        std::fs::create_dir_all(dir.path().join("docs")).unwrap();
        std::fs::write(dir.path().join("docs/PRD.md"), "# theirs\n").unwrap();
        set_root_config_field(dir.path(), "prd", "docs/PRD.md").unwrap();

        assert_eq!(prd_relative_path(dir.path()), "docs/PRD.md");
        assert_eq!(read_prd(dir.path()).unwrap(), "# theirs\n");
        assert!(scan_root(dir.path()).contexts[0].has_prd);
        assert_eq!(scan_root(dir.path()).contexts[0].prd.as_deref(), Some("docs/PRD.md"));

        // Pointed at a file that is not there yet: the tree says so
        // rather than answering for the scaffolded file behind it.
        set_root_config_field(dir.path(), "prd", "docs/MISSING.md").unwrap();
        assert!(!scan_root(dir.path()).contexts[0].has_prd);
        assert!(read_prd(dir.path()).is_err());

        // Cleared, and the default is back -- config and tree agree.
        set_root_config_field(dir.path(), "prd", "").unwrap();
        assert_eq!(prd_relative_path(dir.path()), protocol::DEFAULT_PRD_PATH);
        let root = &scan_root(dir.path()).contexts[0];
        assert!(root.has_prd);
        assert_eq!(root.prd, None, "no key means the default applies, not an echoed default");
    }

    #[test]
    fn a_prd_path_outside_the_root_is_refused_by_the_writer_and_ignored_by_the_reader() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();

        for bad in ["../elsewhere/PRD.md", "/etc/passwd"] {
            assert!(set_root_config_field(dir.path(), "prd", bad).is_err(), "{bad}");
        }

        // Hand-edited past the writer, the reader still refuses it: an
        // escape must not become a read just because it reached disk.
        let path = dir.path().join(GAVIN_ROOT_DIR).join("config.toml");
        let existing = std::fs::read_to_string(&path).unwrap();
        std::fs::write(&path, format!("prd = \"../outside/PRD.md\"\n{existing}")).unwrap();
        assert_eq!(prd_relative_path(dir.path()), protocol::DEFAULT_PRD_PATH);
    }

    #[test]
    fn a_root_level_key_stays_above_an_existing_table() {
        // toml_edit appends new root keys at the end of the root table.
        // If that renders BELOW `[agent]`, the reparse reads it as
        // `agent.prd` and the key silently stops existing -- so this
        // pins the render, not the write.
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        set_root_config_field(dir.path(), "profile", "codex").unwrap();
        set_root_config_field(dir.path(), "prd", "docs/PRD.md").unwrap();

        let path = dir.path().join(GAVIN_ROOT_DIR).join("config.toml");
        let text = std::fs::read_to_string(&path).unwrap();
        let table: toml::Table = text.parse().unwrap_or_else(|e| panic!("{e}: {text}"));
        assert_eq!(table.get("prd").and_then(|v| v.as_str()), Some("docs/PRD.md"), "{text}");
        assert!(table.get("agent").and_then(|a| a.get("prd")).is_none(), "{text}");
    }

    #[test]
    fn set_root_config_field_writes_each_allowed_key_and_rejects_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();

        set_root_config_field(dir.path(), "profile", "codex").unwrap();
        set_root_config_field(dir.path(), "file", "AGENTS.md").unwrap();
        set_root_config_field(dir.path(), "command", "codex --full-auto").unwrap();
        // The custom profile's MCP layout, which no static table can hold.
        set_root_config_field(dir.path(), "mcp_file", ".myagent/mcp.json").unwrap();
        set_root_config_field(dir.path(), "mcp_format", "json-local").unwrap();

        let tree = scan_root(dir.path());
        let agent = tree.contexts[0].agent.as_ref().unwrap();
        assert_eq!(agent.profile.as_deref(), Some("codex"));
        assert_eq!(agent.file.as_deref(), Some("AGENTS.md"));
        assert_eq!(agent.command.as_deref(), Some("codex --full-auto"));
        assert_eq!(agent.mcp_file.as_deref(), Some(".myagent/mcp.json"));
        assert_eq!(agent.mcp_format.as_deref(), Some("json-local"));

        assert!(set_root_config_field(dir.path(), "version", "9").is_err(), "unknown key");
        assert!(set_root_config_field(dir.path(), "profile", "").is_err(), "empty value");
        assert!(set_root_config_field(dir.path(), "profile", "a\nb").is_err(), "newline");
    }

    /// The seventh `[agent]` key, and the one that makes a hand-written
    /// command a model-varying agent at all: the profile table has no
    /// flag for `custom` and never can, so without this the complexity
    /// table could never reach somebody's own binary.
    #[test]
    fn model_flag_is_settable_and_an_empty_value_clears_it() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let path = dir.path().join(GAVIN_ROOT_DIR).join("config.toml");

        set_root_config_field(dir.path(), "profile", "custom").unwrap();
        set_root_config_field(dir.path(), "command", "my-agent").unwrap();
        set_root_config_field(dir.path(), "model_flag", "--llm").unwrap();
        let agent = scan_root(dir.path()).contexts[0].agent.clone().unwrap();
        assert_eq!(agent.model_flag.as_deref(), Some("--llm"));

        // Clearing means "fall back to the profile table's flag", which
        // for `custom` is no flag at all -- an absent key, not `""`.
        set_root_config_field(dir.path(), "model_flag", "").unwrap();
        let after = std::fs::read_to_string(&path).unwrap();
        assert!(!after.contains("model_flag"), "the key is removed, not blanked: {after}");
        assert!(after.contains("command = \"my-agent\""), "{after}");
        assert_eq!(scan_root(dir.path()).contexts[0].agent.as_ref().unwrap().model_flag, None);
    }

    #[test]
    fn model_is_settable_and_an_empty_value_clears_it() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let path = dir.path().join(GAVIN_ROOT_DIR).join("config.toml");

        set_root_config_field(dir.path(), "model", "opus").unwrap();
        assert_eq!(
            scan_root(dir.path()).contexts[0].agent.as_ref().unwrap().model.as_deref(),
            Some("opus")
        );

        // Clearing is what "inherit the app-wide default again" means,
        // and model is the only key with a fallback underneath it.
        set_root_config_field(dir.path(), "command", "claude").unwrap();
        set_root_config_field(dir.path(), "model", "").unwrap();
        let after = std::fs::read_to_string(&path).unwrap();
        assert!(!after.contains("model"), "the key is removed, not blanked: {after}");
        // The rest of [agent] survives the removal.
        assert!(after.contains("command = \"claude\""), "{after}");

        // Every other key still refuses an empty value.
        assert!(set_root_config_field(dir.path(), "command", "").is_err());
        // Clearing a model that was never set is a no-op, not an error.
        set_root_config_field(dir.path(), "model", "").unwrap();

        // And clearing in a root with no config.toml at all must not
        // conjure one into existence.
        let bare = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(bare.path().join(GAVIN_ROOT_DIR)).unwrap();
        set_root_config_field(bare.path(), "model", "").unwrap();
        assert!(!bare.path().join(GAVIN_ROOT_DIR).join("config.toml").exists());
    }

    #[test]
    fn parse_context_config_reads_the_model_off_the_agent_block() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(&path, "[agent]\nprofile = \"claude-code\"\nmodel = \"opus\"\n").unwrap();
        let (_, agent, warn) = parse_context_config(&path);
        assert!(!warn);
        assert_eq!(agent.unwrap().model.as_deref(), Some("opus"));
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
        let path = create_plan_file(dir.path(), "auth.md", "Auth flow", None, None, None, None, None, None, None).unwrap();
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
        let p = create_plan_file(dir.path(), "child.md", "Child", None, None, None, Some("task"), Some("parent-plan.md"), None, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(&p).unwrap(),
            "---\nkind: task\ntitle: Child\nparent: parent-plan.md\n---\n# Child\n"
        );
        // A note keeps the default/explicit status.
        let n = create_plan_file(dir.path(), "note.md", "Note", Some("Done"), None, None, Some("note"), None, None, None).unwrap();
        assert!(std::fs::read_to_string(&n).unwrap().starts_with("---\nkind: note\ntitle: Note\nstatus: Done\n"));
        // kind plan writes no kind line (backward-canonical).
        let pl = create_plan_file(dir.path(), "plan.md", "P", None, None, None, Some("plan"), None, None, None).unwrap();
        assert!(std::fs::read_to_string(&pl).unwrap().starts_with("---\ntitle: P\nstatus: To Do\n"));
        assert!(create_plan_file(dir.path(), "x.md", "X", None, None, None, Some("epic"), None, None, None).is_err());
        assert!(create_plan_file(dir.path(), "y.md", "Y", None, None, None, Some("note"), Some("p.md"), None, None).is_err());
        assert!(create_plan_file(dir.path(), "z.md", "Z", None, None, None, Some("task"), Some("../evil.md"), None, None).is_err());
    }

    #[test]
    fn create_plan_file_validates_and_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        // Not a context:
        assert!(create_plan_file(&dir.path().join("nope"), "a.md", "T", None, None, None, None, None, None, None).is_err());
        // Bad names ("../esc.md" doubles as the path-escape guard):
        for bad in ["", ".md", "no-extension", "sp ace.md", "../esc.md"] {
            assert!(create_plan_file(dir.path(), bad, "T", None, None, None, None, None, None, None).is_err(), "{bad}");
        }
        // Bad priority / bad title:
        assert!(create_plan_file(dir.path(), "a.md", "T", None, Some("banana"), None, None, None, None, None).is_err());
        assert!(create_plan_file(dir.path(), "a.md", "  ", None, None, None, None, None, None, None).is_err());
        // Never overwrites:
        create_plan_file(dir.path(), "a.md", "T", None, None, None, None, None, None, None).unwrap();
        let dup = create_plan_file(dir.path(), "a.md", "T2", None, None, None, None, None, None, None);
        assert!(dup.unwrap_err().to_string().contains("already exists"));
    }

    /// The app's "auto commit" switch is a fenced HTML-comment block the
    /// composer folds into the card's BODY (app/src/lib/autoCommit.ts) --
    /// deliberately not a frontmatter field, so it needs nothing from the
    /// daemon and reaches every agent that reads the card. Nothing is
    /// wired for it here, which is the point: this pins that the body
    /// survives verbatim and that the block cannot be mistaken for
    /// frontmatter, checklist items or anything else the scan parses.
    #[test]
    fn a_body_carrying_an_html_comment_block_round_trips_verbatim() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let body = "Do the thing.\n\n<!-- gavin:auto-commit -->\n\
                    When the implementation is done, commit it.\n\
                    <!-- /gavin:auto-commit -->";
        let path = create_plan_file(
            dir.path(), "ac.md", "T", None, None, Some(body), Some("task"), None, None, None,
        )
        .unwrap();
        let written = std::fs::read_to_string(&path).unwrap();
        assert!(written.ends_with(&format!("{body}\n")), "body must land verbatim: {written:?}");
        // The comment markers are body text, not a second frontmatter
        // block: title/status still parse, and nothing became a checklist.
        let info = plan_file_info(&path, &written);
        assert_eq!(info.title, "T");
        assert_eq!(info.status.as_deref(), Some("To Do"));
        assert_eq!(info.checklist_total, 0);
        assert!(!info.parse_warning);
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
        let (ours, theirs) = Stream::pair().unwrap();
        ours.set_read_timeout(Some(Duration::from_millis(400))).unwrap();
        let writer = Arc::new(Mutex::new(theirs));

        let watcher =
            GavinWatcher::start("ws-1".to_string(), dir.path().to_path_buf(), Arc::clone(&writer), None);

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

    /// The Linux port's watch-set measurement, kept runnable rather than
    /// written down once as a number.
    ///
    /// Off macOS the set is one inotify watch PER scanned directory, and
    /// the question the port had to answer was whether a real repo can
    /// reach `fs.inotify.max_user_watches`. This builds the shape that
    /// would: 3000 directories the scanner descends into, next to the
    /// `node_modules`/`target`/`.git` churn it skips, and reports how
    /// many watches that costs and how long arming them takes.
    ///
    /// `#[ignore]`d because it creates several thousand directories and
    /// arms several thousand OS watches -- a fine thing to run on
    /// purpose (`cargo test -p gavin-daemon -- --ignored measure_watch`)
    /// and a poor one to run on every commit.
    ///
    /// inotify only: where `watch_targets` returns the root and nothing
    /// else there is no per-directory cost to measure. The cost those
    /// platforms pay instead is measured by
    /// `measure_recursive_watch_churn`.
    #[test]
    #[cfg(not(any(target_os = "macos", windows)))]
    #[ignore = "builds a 3000-folder repo and arms the real watch set; run with --ignored"]
    fn measure_watch_set_on_a_large_repo() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(GAVIN_ROOT_DIR).join("plans")).unwrap();

        // 30 packages x 100 folders each, four levels deep -- the shape a
        // monorepo actually has, well inside MAX_SCAN_DEPTH.
        let mut scanned = 0;
        for pkg in 0..30 {
            for i in 0..100 {
                let p = root
                    .join(format!("pkg-{pkg}"))
                    .join(format!("src-{}", i / 25))
                    .join(format!("mod-{}", i % 25));
                std::fs::create_dir_all(&p).unwrap();
                scanned += 1;
            }
            // The churn the walk must NOT be paying for.
            std::fs::create_dir_all(root.join(format!("pkg-{pkg}")).join("node_modules").join("a"))
                .unwrap();
            std::fs::create_dir_all(root.join(format!("pkg-{pkg}")).join("target").join("debug"))
                .unwrap();
        }

        let t = Instant::now();
        let targets = watch_targets(root);
        let listed = t.elapsed();

        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher =
            notify::recommended_watcher(move |e| { let _ = tx.send(e); }).unwrap();
        let t = Instant::now();
        let mut armed = 0usize;
        let mut refused_for_limit = 0usize;
        let mut refused_other = 0usize;
        for (path, mode) in &targets {
            match notify::Watcher::watch(&mut watcher, path, *mode) {
                Ok(()) => armed += 1,
                Err(e) if matches!(e.kind, notify::ErrorKind::MaxFilesWatch) => {
                    refused_for_limit += 1
                }
                Err(_) => refused_other += 1,
            }
        }
        let arm_time = t.elapsed();
        drop(rx);

        println!(
            "{scanned} scanned folders created\n\
             {} watch targets listed in {listed:?}\n\
             {armed} armed in {arm_time:?} ({refused_for_limit} refused for the OS limit, \
             {refused_other} for other reasons)",
            targets.len()
        );
        // The point of the exercise: the set is the SCANNED tree, not the
        // repo. If this ever starts counting node_modules the arm cost
        // stops being bounded by anything -- so the assertion is about
        // what must be ABSENT, which the count alone cannot express (the
        // set also holds the intermediate directories the leaves hang
        // off, and `scanned` counts only the leaves).
        assert!(armed > scanned, "{armed} armed for {scanned} leaf folders");
        for (path, _) in &targets {
            let p = path.to_string_lossy();
            assert!(
                !p.contains("node_modules") && !p.contains("/target"),
                "the churny directories must never be watched: {p}"
            );
        }
    }

    #[test]
    fn the_watch_limit_message_names_the_sysctl_and_what_it_costs() {
        // The only reason this string exists: ENOSPC from
        // inotify_add_watch renders everywhere as "No space left on
        // device", which sends people to `df`.
        let msg = watch_limit_message(Path::new("/home/x/monorepo"), 3012, 2951);
        assert!(msg.contains("fs.inotify.max_user_watches"), "{msg}");
        assert!(msg.contains("2951"), "{msg}");
        assert!(msg.contains("3012"), "{msg}");
        assert!(msg.contains("/home/x/monorepo"), "{msg}");
        // And what actually breaks, in the human's terms.
        assert!(msg.contains("outside gavin"), "{msg}");
    }

    #[test]
    #[cfg(not(any(target_os = "macos", windows)))]
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

    /// The other half of the watch-set bargain, kept runnable rather
    /// than written down once as a number.
    ///
    /// Where the root is one recursive watch, the churn the
    /// per-directory set used to keep out crosses into the daemon and
    /// `tree_relevant` is the only thing left standing between a build
    /// and a rescan. This builds the shape a build makes -- writes under
    /// `target/` and `node_modules/` -- and reports how many event paths
    /// that costs, how many survive the filter, and what the filtering
    /// took. Measured 2026-09-23 on Windows 11: 2000 writes, ~6000 event
    /// paths, 0 survivors, tens of milliseconds.
    ///
    /// The survivor count is the assertion; the rest is the report. A
    /// non-zero one means a build would drive rescans, which is the
    /// failure mode that makes the recursive watch the wrong trade.
    ///
    /// `#[ignore]`d for the same reason as the measurement above: it
    /// writes two thousand files and sleeps out a watcher.
    #[test]
    #[cfg(any(target_os = "macos", windows))]
    #[ignore = "writes 2000 files under a live recursive watch; run with --ignored"]
    fn measure_recursive_watch_churn() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join(GAVIN_ROOT_DIR).join("plans")).unwrap();
        let obj = root.join("target").join("debug").join("build");
        let module = root.join("node_modules").join("pkg");
        std::fs::create_dir_all(&obj).unwrap();
        std::fs::create_dir_all(&module).unwrap();

        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |e| {
            let _ = tx.send(e);
        })
        .unwrap();
        notify::Watcher::watch(&mut watcher, &root, notify::RecursiveMode::Recursive).unwrap();
        // The watch is armed asynchronously; writing into the tree
        // before it is would measure a quieter repo than the real one.
        std::thread::sleep(Duration::from_millis(300));

        let t = Instant::now();
        for i in 0..1000 {
            std::fs::write(obj.join(format!("o{i}.o")), b"x").unwrap();
            std::fs::write(module.join(format!("m{i}.js")), b"x").unwrap();
        }
        let write_time = t.elapsed();
        std::thread::sleep(Duration::from_secs(2));

        let t = Instant::now();
        let (mut raw, mut relevant) = (0usize, 0usize);
        while let Ok(Ok(event)) = rx.recv_timeout(Duration::from_millis(200)) {
            for path in &event.paths {
                raw += 1;
                if tree_relevant(&root, None, path) {
                    relevant += 1;
                }
            }
        }
        let filter_time = t.elapsed();

        println!(
            "2000 churn writes in {write_time:?}\n\
             {raw} raw event paths crossed into the process\n\
             {relevant} survived tree_relevant\n\
             draining and filtering took {filter_time:?}"
        );
        assert!(raw > 0, "the recursive watch reported nothing -- it never armed");
        assert_eq!(relevant, 0, "build churn reached the rescan path");
    }

    #[test]
    #[cfg(any(target_os = "macos", windows))]
    fn under_one_recursive_watch_the_root_is_the_whole_set() {
        // Both reasons the set collapses, and each is fatal on its own
        // platform (see ONE_RECURSIVE_WATCH): on FSEvents every scanned
        // directory became its own `watch()` call and each one a stream
        // rebuild, which made a large repo take minutes to arm; on
        // Windows each one is an open handle that makes the folder it
        // names unrenamable. One recursive registration covers the same
        // events with neither cost.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join(GAVIN_ROOT_DIR).join("plans")).unwrap();
        std::fs::create_dir_all(root.join("packages").join("api").join(GAVIN_DIR)).unwrap();
        std::fs::create_dir_all(root.join("node_modules").join("deep")).unwrap();

        assert_eq!(names(&root), vec![(".".to_string(), true)]);
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
                prd: None,
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

        let (ours, theirs) = Stream::pair().unwrap();
        ours.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let _watcher =
            GavinWatcher::start("ws-1".to_string(), root.clone(), Arc::new(Mutex::new(theirs)), None);

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

        let (ours, theirs) = Stream::pair().unwrap();
        ours.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let _watcher =
            GavinWatcher::start("ws-1".to_string(), root.clone(), Arc::new(Mutex::new(theirs)), None);

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
    #[cfg(any(target_os = "macos", windows))]
    fn under_one_recursive_watch_a_new_folder_needs_no_watch_of_its_own() {
        // The counterpart of the two tests below, for the platforms that
        // watch the root recursively: that watch already covers a folder
        // appearing later, so a rescan must not start registering
        // per-directory watches -- on macOS that is the slow arm these
        // platforms left behind, on Windows it is a handle that would
        // lock the new folder against being renamed.
        //
        // Wire spelling rather than `canonicalize()`, because this
        // compares against paths the watcher REGISTERED and
        // `GavinWatcher::start` stores `protocol::canonical_path(root)`.
        // On Windows raw canonicalisation answers `\\?\C:\...`, which no
        // watch is ever held under; on macOS the two spellings are the
        // same and this changes nothing.
        let dir = tempfile::tempdir().unwrap();
        let root = PathBuf::from(wire_spelling(dir.path()));
        init_gavin_root(&root, "WS").unwrap();

        let (_ours, theirs) = Stream::pair().unwrap();
        let watcher =
            GavinWatcher::start("ws-1".to_string(), root.clone(), Arc::new(Mutex::new(theirs)), None);
        assert_eq!(watcher.watched_paths(), vec![root.clone()]);

        std::fs::create_dir(root.join("services")).unwrap();
        watcher.rescan_and_push();
        assert_eq!(watcher.watched_paths(), vec![root.clone()]);

        std::fs::remove_dir(root.join("services")).unwrap();
        watcher.rescan_and_push();
        assert_eq!(watcher.watched_paths(), vec![root]);
    }

    #[test]
    #[cfg(not(any(target_os = "macos", windows)))]
    fn a_new_folder_picks_up_its_own_watch_on_the_next_rescan() {
        // The watch set is non-recursive per directory, so a folder that
        // appears after the watcher started must be armed by the very
        // rescan its own creation triggers -- otherwise a `.gavin`
        // created inside it a moment later lands in a blind spot.
        //
        // Asserted against the registered set rather than a second
        // filesystem event: the mechanism is what this pins, and racing
        // the watcher twice in one test is how you get a suite that
        // fails only under load.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        init_gavin_root(&root, "WS").unwrap();

        let (_ours, theirs) = Stream::pair().unwrap();
        let watcher =
            GavinWatcher::start("ws-1".to_string(), root.clone(), Arc::new(Mutex::new(theirs)), None);
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
    #[cfg(not(any(target_os = "macos", windows)))]
    fn a_folder_that_left_gives_its_watch_back() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        init_gavin_root(&root, "WS").unwrap();
        std::fs::create_dir(root.join("services")).unwrap();

        let (_ours, theirs) = Stream::pair().unwrap();
        let watcher =
            GavinWatcher::start("ws-1".to_string(), root.clone(), Arc::new(Mutex::new(theirs)), None);
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
        // Before DP-03's guard this silently no-op'd the move but still
        // wrote the field; `confine_card_path` now refuses the write
        // outright, so the file is untouched for a stronger reason than
        // "never moved" -- it is never acted on at all.
        assert!(set_plan_field(&loose, "status", "Done").is_err());
        assert_eq!(std::fs::read_to_string(&loose).unwrap(), "---\ntitle: P\n---\n");
        assert!(loose.is_file());
    }

    #[test]
    fn create_plan_file_places_done_cards_and_children_correctly() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let plans = dir.path().join(GAVIN_ROOT_DIR).join("plans");

        let done =
            create_plan_file(dir.path(), "shipped.md", "Shipped", Some("Done"), None, None, None, None, None, None)
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
            None,
            None,
        )
        .unwrap();
        assert_eq!(child, plans.join("done").join("sub.md"));

        // A file name already used anywhere in the tree is refused.
        assert!(
            create_plan_file(dir.path(), "shipped.md", "Again", None, None, None, None, None, None, None).is_err()
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

    // --- the explicit archive (plans/archive/) ----------------------------

    #[test]
    fn archive_moves_a_card_into_archive_and_unarchive_files_it_by_status() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let plans = dir.path().join(GAVIN_ROOT_DIR).join("plans");
        let card = write_card(&plans.join("done"), "ship.md", "---\ntitle: Ship\nstatus: Done\n---\nb\n");

        let archived = archive_card(&card).unwrap();
        assert_eq!(archived, plans.join("archive").join("ship.md"));
        assert!(!card.exists());
        // The frontmatter is untouched: archiving is a filing decision,
        // not a status change.
        assert_eq!(
            std::fs::read_to_string(&archived).unwrap(),
            "---\ntitle: Ship\nstatus: Done\n---\nb\n"
        );

        // Back out, to where its status says it belongs.
        let back = unarchive_card(&archived).unwrap();
        assert_eq!(back, plans.join("done").join("ship.md"));
        assert!(!archived.exists());
    }

    #[test]
    fn unarchiving_a_to_do_card_lands_it_in_plans_not_done() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let plans = dir.path().join(GAVIN_ROOT_DIR).join("plans");
        let card = write_card(&plans, "later.md", "---\ntitle: Later\nstatus: To Do\n---\n");

        let archived = archive_card(&card).unwrap();
        assert_eq!(archived, plans.join("archive").join("later.md"));
        assert_eq!(unarchive_card(&archived).unwrap(), plans.join("later.md"));
    }

    #[test]
    fn a_status_write_never_pulls_a_card_out_of_the_archive() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let plans = dir.path().join(GAVIN_ROOT_DIR).join("plans");
        let card = write_card(&plans, "ship.md", "---\ntitle: Ship\nstatus: Done\n---\n");
        let archived = archive_card(&card).unwrap();

        // Both directions: the status that would file it into done/, and
        // the one that would file it back into plans/.
        assert_eq!(set_plan_field(&archived, "status", "To Do").unwrap(), archived);
        assert_eq!(set_plan_field(&archived, "status", "Done").unwrap(), archived);
        assert!(archived.is_file());
        assert_eq!(
            std::fs::read_to_string(&archived).unwrap(),
            "---\ntitle: Ship\nstatus: Done\n---\n"
        );
    }

    #[test]
    fn archiving_a_plan_takes_its_nested_children_with_it_and_brings_them_back() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let plans = dir.path().join(GAVIN_ROOT_DIR).join("plans");
        let plan = write_card(&plans, "big.md", "---\ntitle: Big\nstatus: Done\n---\n");
        write_card(&plans, "step.md", "---\nkind: task\ntitle: Step\nparent: big.md\n---\n");
        // A free-standing task wearing the same parent does NOT follow:
        // it has a status, so it is a card in its own column.
        write_card(
            &plans,
            "free.md",
            "---\nkind: task\ntitle: Free\nstatus: To Do\nparent: big.md\n---\n",
        );

        let archived = archive_card(&plan).unwrap();
        assert_eq!(archived, plans.join("archive").join("big.md"));
        assert!(plans.join("archive").join("step.md").is_file());
        assert!(plans.join("free.md").is_file());

        unarchive_card(&archived).unwrap();
        // Done, so parent and child land in done/ together.
        assert!(plans.join("done").join("big.md").is_file());
        assert!(plans.join("done").join("step.md").is_file());
        assert!(!plans.join("archive").join("step.md").exists());
    }

    #[test]
    fn archiving_is_idempotent_and_unarchiving_an_unarchived_card_is_a_no_op() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let plans = dir.path().join(GAVIN_ROOT_DIR).join("plans");
        let card = write_card(&plans, "a.md", "---\ntitle: A\n---\n");

        assert_eq!(unarchive_card(&card).unwrap(), card);
        let archived = archive_card(&card).unwrap();
        assert_eq!(archive_card(&archived).unwrap(), archived);
    }

    #[test]
    fn archiving_refuses_cards_outside_the_governed_plans_locations() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let plans = dir.path().join(GAVIN_ROOT_DIR).join("plans");
        // A hand-made subfolder is somebody else's hierarchy, exactly as
        // the status rule treats it.
        let filed = write_card(&plans.join("roadmap"), "q3.md", "---\ntitle: Q3\n---\n");
        assert!(archive_card(&filed).is_err());
        assert!(filed.is_file());

        let loose = write_card(dir.path(), "p.md", "---\ntitle: P\n---\n");
        assert!(archive_card(&loose).is_err());
    }

    #[test]
    fn an_archived_card_is_still_scanned_deleted_and_promoted_like_any_other() {
        let dir = tempfile::tempdir().unwrap();
        let root = wire_root(&dir);
        init_gavin_root(&root, "WS").unwrap();
        let plans = root.join(GAVIN_ROOT_DIR).join("plans");
        let plan = write_card(&plans, "big.md", "---\ntitle: Big\n---\n- [ ] step one\n");
        let archived = archive_card(&plan).unwrap();

        // The scan lists it: `plans/archive/` is inside plans/, and
        // hiding it from the tree is the FRONTEND's job, not the
        // scanner's.
        let tree = scan_root(&root);
        assert!(tree.contexts[0].plans.iter().any(|p| p.path == wire_spelling(&archived)));

        let promoted = promote_checklist_item(&archived, "step one").unwrap();
        assert_eq!(promoted, plans.join("archive").join("step-one.md"));

        delete_card_file(&archived).unwrap();
        assert!(!archived.exists());
    }

    #[test]
    fn plan_file_info_carries_the_files_mtime_and_tolerates_a_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let card = write_card(dir.path(), "a.md", "---\ntitle: A\n---\n");
        let info = plan_file_info(&card, "---\ntitle: A\n---\n");
        assert!(info.modified_at.is_some_and(|t| t > 1_600_000_000));

        let missing = dir.path().join("nope.md");
        assert_eq!(plan_file_info(&missing, "").modified_at, None);
    }

    // --- recovering a card path the daemon did not move -------------------

    /// Step paths as the orchestration store holds them: wire spelling,
    /// because that is what a scan put there. `wire_spelling` itself
    /// cannot serve -- these name cards that deliberately do NOT exist
    /// (a deleted one, one that moved) and canonicalising needs a file.
    /// So the root is resolved and the card's own segments joined on.
    fn card_paths(root: &Path, names: &[&str]) -> Vec<String> {
        let root = PathBuf::from(wire_spelling(root));
        names
            .iter()
            .map(|n| {
                wire_separators(
                    &root.join(GAVIN_ROOT_DIR).join("plans").join(n).to_string_lossy(),
                )
            })
            .collect()
    }

    #[test]
    fn a_step_path_is_recovered_when_its_card_moved_into_done() {
        let dir = tempfile::tempdir().unwrap();
        let root = wire_root(&dir);
        init_gavin_root(&root, "WS").unwrap();
        let plans = root.join(GAVIN_ROOT_DIR).join("plans");
        std::fs::create_dir_all(plans.join(DONE_DIR)).unwrap();
        write_card(&plans.join(DONE_DIR), "fs-sync.md", "---\ntitle: FS sync\nstatus: Done\n---\n");

        let stale = card_paths(&root, &["fs-sync.md"]);
        let moved = wire_spelling(&plans.join(DONE_DIR).join("fs-sync.md"));

        assert_eq!(
            recover_moved_card_paths(&scan_root(&root), &stale),
            vec![(stale[0].clone(), moved)]
        );
    }

    #[test]
    fn a_step_path_that_still_has_its_file_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let root = wire_root(&dir);
        init_gavin_root(&root, "WS").unwrap();
        let plans = root.join(GAVIN_ROOT_DIR).join("plans");
        write_card(&plans, "fs-sync.md", "---\ntitle: FS sync\n---\n");

        let live = card_paths(&root, &["fs-sync.md"]);
        assert!(recover_moved_card_paths(&scan_root(&root), &live).is_empty());
    }

    #[test]
    fn a_deleted_card_is_not_recovered_onto_some_other_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = wire_root(&dir);
        init_gavin_root(&root, "WS").unwrap();
        let plans = root.join(GAVIN_ROOT_DIR).join("plans");
        write_card(&plans, "other.md", "---\ntitle: Other\n---\n");

        let gone = card_paths(&root, &["fs-sync.md"]);
        assert!(recover_moved_card_paths(&scan_root(&root), &gone).is_empty());
    }

    #[test]
    fn recovery_never_crosses_from_one_context_into_another() {
        let dir = tempfile::tempdir().unwrap();
        let root = wire_root(&dir);
        init_gavin_root(&root, "WS").unwrap();
        let sub = root.join("app");
        std::fs::create_dir_all(&sub).unwrap();
        create_gavin_context(&sub).unwrap();
        // Same file name, but it only ever existed in the sub-context.
        write_card(&sub.join(GAVIN_DIR).join("plans"), "fs-sync.md", "---\ntitle: FS sync\n---\n");

        let stale = card_paths(&root, &["fs-sync.md"]);
        assert!(recover_moved_card_paths(&scan_root(&root), &stale).is_empty());
    }

    #[test]
    fn an_ambiguous_file_name_is_left_alone_rather_than_guessed() {
        let dir = tempfile::tempdir().unwrap();
        let root = wire_root(&dir);
        init_gavin_root(&root, "WS").unwrap();
        let plans = root.join(GAVIN_ROOT_DIR).join("plans");
        std::fs::create_dir_all(plans.join(DONE_DIR)).unwrap();
        write_card(&plans, "fs-sync.md", "---\ntitle: FS sync\n---\n");
        write_card(&plans.join(DONE_DIR), "fs-sync.md", "---\ntitle: FS sync\n---\n");

        // The step points into archive/, where nothing is: two candidates
        // answer to the name, so neither is the answer.
        let stale = vec![wire_separators(&plans.join(ARCHIVE_DIR).join("fs-sync.md").to_string_lossy())];
        assert!(recover_moved_card_paths(&scan_root(&root), &stale).is_empty());
    }

    #[test]
    fn two_steps_sharing_one_moved_card_yield_a_single_re_key() {
        let dir = tempfile::tempdir().unwrap();
        let root = wire_root(&dir);
        init_gavin_root(&root, "WS").unwrap();
        let plans = root.join(GAVIN_ROOT_DIR).join("plans");
        std::fs::create_dir_all(plans.join(DONE_DIR)).unwrap();
        write_card(&plans.join(DONE_DIR), "fs-sync.md", "---\ntitle: FS sync\n---\n");

        let stale = card_paths(&root, &["fs-sync.md", "fs-sync.md"]);
        assert_eq!(recover_moved_card_paths(&scan_root(&root), &stale).len(), 1);
    }

    // --- Workspace files (v39) ------------------------------------------

    fn workspace_root() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        dir
    }

    fn lossy(path: &Path) -> String {
        path.to_string_lossy().to_string()
    }

    #[test]
    fn read_workspace_file_takes_a_root_relative_or_an_absolute_path_inside_the_root() {
        let dir = workspace_root();
        std::fs::write(dir.path().join(".gavin-root/plans/a.md"), "---\ntitle: A\n---\nbody\n").unwrap();
        let (content, truncated) = read_workspace_file(dir.path(), ".gavin-root/plans/a.md").unwrap();
        assert_eq!(content.as_deref(), Some("---\ntitle: A\n---\nbody\n"));
        assert!(!truncated);
        let absolute = dir.path().join(".gavin-root").join("plans").join("a.md");
        let (content, _) = read_workspace_file(dir.path(), &lossy(&absolute)).unwrap();
        assert!(content.is_some());
    }

    #[test]
    fn read_workspace_file_answers_none_for_a_missing_file_and_refuses_outside_the_root() {
        let dir = workspace_root();
        let (content, truncated) = read_workspace_file(dir.path(), "nope.md").unwrap();
        assert_eq!(content, None);
        assert!(!truncated);
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret"), "s").unwrap();
        let err = read_workspace_file(dir.path(), &lossy(&outside.path().join("secret")))
            .unwrap_err()
            .to_string();
        assert!(err.contains("outside"), "{err}");
        assert!(read_workspace_file(dir.path(), "../secret").is_err());
    }

    #[test]
    fn read_workspace_file_truncates_at_the_cap() {
        let dir = workspace_root();
        let big = "x".repeat(protocol::MAX_WORKSPACE_FILE_BYTES + 10);
        std::fs::write(dir.path().join("big.txt"), &big).unwrap();
        let (content, truncated) = read_workspace_file(dir.path(), "big.txt").unwrap();
        assert!(truncated);
        assert_eq!(content.unwrap().len(), protocol::MAX_WORKSPACE_FILE_BYTES);
    }

    #[test]
    fn write_workspace_file_creates_parents_inside_the_root_and_refuses_outside() {
        let dir = workspace_root();
        write_workspace_file(dir.path(), "deep/er/file.json", "{}\n").unwrap();
        assert_eq!(std::fs::read_to_string(dir.path().join("deep/er/file.json")).unwrap(), "{}\n");
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("planted");
        assert!(write_workspace_file(dir.path(), &lossy(&target), "x").is_err());
        assert!(!target.exists());
        assert!(write_workspace_file(dir.path(), "../planted", "x").is_err());
    }

    /// A card in an outside context the root config names is the
    /// workspace's too, exactly as the tree says it is.
    #[test]
    fn workspace_files_reach_an_extra_context_the_root_config_names() {
        let dir = workspace_root();
        let extra = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(extra.path().join(".gavin").join("plans")).unwrap();
        add_external_context(dir.path(), extra.path()).unwrap();
        let card = extra.path().join(".gavin").join("plans").join("x.md");
        std::fs::write(&card, "x").unwrap();
        assert!(read_workspace_file(dir.path(), &lossy(&card)).unwrap().0.is_some());
        write_workspace_file(dir.path(), &lossy(&extra.path().join("note.md")), "n").unwrap();
        assert!(extra.path().join("note.md").is_file());
    }

    #[test]
    fn stat_workspace_paths_classifies_like_the_attachment_gate() {
        let dir = workspace_root();
        std::fs::write(dir.path().join("spec.md"), "12345").unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("o.txt"), "o").unwrap();
        let stats = stat_workspace_paths(
            dir.path(),
            &[
                "spec.md".to_string(),
                "missing.md".to_string(),
                lossy(&outside.path().join("o.txt")),
                "../escape.md".to_string(),
                lossy(dir.path()),
            ],
        );
        assert_eq!(stats.len(), 5);
        assert_eq!(stats[0].location, "root");
        assert!(stats[0].exists);
        assert_eq!(stats[0].size_bytes, Some(5));
        let absolute = stats[0].absolute_path.as_deref().unwrap();
        assert!(absolute.ends_with("spec.md"), "{absolute}");
        assert!(!absolute.contains('\\'), "wire paths use forward slashes: {absolute}");
        assert_eq!(stats[1].location, "root");
        assert!(!stats[1].exists);
        assert_eq!(stats[1].size_bytes, None);
        assert_eq!(stats[2].location, "outside");
        assert!(stats[2].exists);
        assert_eq!(stats[3].location, "refused");
        assert!(stats[3].refused_reason.as_deref().unwrap().contains(".."));
        assert_eq!(stats[3].absolute_path, None);
        assert!(!stats[4].exists, "a directory is not a file to read");
        assert!(stats[4].is_dir);
        assert!(!stats[0].is_dir && !stats[1].is_dir);
    }

    /// The refusal is about THIS machine's home: the agent that would be
    /// handed the file runs here.
    #[test]
    fn stat_workspace_paths_refuses_a_sensitive_home_directory() {
        let dir = workspace_root();
        let Some(home) = home_dir() else { return };
        let key = home.join(".ssh").join("id_rsa");
        let stats = stat_workspace_paths(dir.path(), &[lossy(&key)]);
        assert_eq!(stats[0].location, "refused");
        assert!(stats[0].refused_reason.as_deref().unwrap().contains(".ssh"));
    }

    // --- Git and directory listing (v40) --------------------------------

    fn init_repo(root: &Path) {
        // A real repo so `run_git` has something to answer about; identity
        // set so `commit` works without global config.
        let cwd = lossy(root);
        for args in [
            &["init", "-q"][..],
            &["config", "user.email", "t@example.com"][..],
            &["config", "user.name", "T"][..],
        ] {
            let argv: Vec<String> = args.iter().map(|s| s.to_string()).collect();
            let out = run_git(root, &cwd, &argv, None).unwrap();
            assert_eq!(out.2, 0, "git {args:?}: {}", out.1);
        }
    }

    #[test]
    fn run_git_runs_a_subcommand_in_the_confined_cwd() {
        let dir = workspace_root();
        init_repo(dir.path());
        std::fs::write(dir.path().join("a.txt"), "hi").unwrap();
        let (stdout, _stderr, code) = run_git(
            dir.path(),
            &lossy(dir.path()),
            &["status".to_string(), "--porcelain".to_string()],
            None,
        )
        .unwrap();
        assert_eq!(code, 0);
        assert!(String::from_utf8_lossy(&stdout).contains("a.txt"));
    }

    #[test]
    fn run_git_reports_a_non_zero_exit_rather_than_erroring() {
        let dir = workspace_root();
        init_repo(dir.path());
        // A bad subcommand exits non-zero; that is data, not an Err.
        let (_out, stderr, code) = run_git(
            dir.path(),
            &lossy(dir.path()),
            &["not-a-subcommand".to_string()],
            None,
        )
        .unwrap();
        assert_ne!(code, 0);
        assert!(stderr.contains("not-a-subcommand"), "{stderr}");
    }

    #[test]
    fn run_git_passes_stdin_and_refuses_a_cwd_outside_the_root() {
        let dir = workspace_root();
        init_repo(dir.path());
        // stripspace echoes stdin normalised -- a stdin round-trip.
        let (stdout, _stderr, code) = run_git(
            dir.path(),
            &lossy(dir.path()),
            &["stripspace".to_string()],
            Some("hello   \n\n\n"),
        )
        .unwrap();
        assert_eq!(code, 0);
        assert_eq!(String::from_utf8_lossy(&stdout), "hello\n");
        let outside = tempfile::tempdir().unwrap();
        assert!(run_git(dir.path(), &lossy(outside.path()), &["status".to_string()], None).is_err());
        assert!(run_git(dir.path(), "..", &["status".to_string()], None).is_err());
    }

    #[test]
    fn run_git_never_runs_a_shell_even_when_args_look_like_one() {
        let dir = workspace_root();
        init_repo(dir.path());
        // The argv reaches `git` verbatim: git treats this as one bogus
        // subcommand, not a shell pipeline, and exits non-zero.
        let (_out, _stderr, code) = run_git(
            dir.path(),
            &lossy(dir.path()),
            &["status; rm -rf /".to_string()],
            None,
        )
        .unwrap();
        assert_ne!(code, 0);
    }

    #[test]
    fn list_workspace_dir_lists_children_inside_the_root() {
        let dir = workspace_root();
        std::fs::write(dir.path().join("b.txt"), "x").unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        let entries = list_workspace_dir(dir.path(), &lossy(dir.path())).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"b.txt"));
        assert!(names.contains(&"sub"));
        // Name-sorted, so a folder and a file keep a stable order.
        let mut sorted = names.clone();
        sorted.sort_unstable();
        assert_eq!(names, sorted);
        let sub = entries.iter().find(|e| e.name == "sub").unwrap();
        assert!(sub.is_dir);
        let file = entries.iter().find(|e| e.name == "b.txt").unwrap();
        assert!(!file.is_dir && file.size == 1);
    }

    #[test]
    fn list_workspace_dir_refuses_outside_the_root_and_a_symlinked_dir() {
        let dir = workspace_root();
        let outside = tempfile::tempdir().unwrap();
        assert!(list_workspace_dir(dir.path(), &lossy(outside.path())).is_err());
        assert!(list_workspace_dir(dir.path(), "../..").is_err());
        // A symlinked directory inside the root is refused, not listed
        // through -- the tree must not leave the root by a link.
        if try_symlink(outside.path(), &dir.path().join("link")) {
            assert!(list_workspace_dir(dir.path(), &lossy(&dir.path().join("link"))).is_err());
        }
    }

    // --- Sync, env, and the tree's mutations (v42) ----------------------

    #[test]
    fn run_git_env_sets_the_allowed_variable_and_refuses_any_other() {
        let dir = workspace_root();
        init_repo(dir.path());
        // `git var GIT_EDITOR` prints the editor git would use -- the one
        // thing that proves the environment actually reached the child.
        let (stdout, stderr, code) = run_git_env(
            dir.path(),
            &lossy(dir.path()),
            &["var".to_string(), "GIT_EDITOR".to_string()],
            &[("GIT_EDITOR".to_string(), "true".to_string())],
        )
        .unwrap();
        assert_eq!(code, 0, "{stderr}");
        assert_eq!(String::from_utf8_lossy(&stdout).trim(), "true");

        // Anything else is refused outright, not filtered: a silently
        // dropped variable is how a caller believes it set something.
        let err = run_git_env(
            dir.path(),
            &lossy(dir.path()),
            &["var".to_string(), "GIT_EDITOR".to_string()],
            &[("GIT_SSH_COMMAND".to_string(), "sh -c evil".to_string())],
        )
        .unwrap_err();
        assert!(err.to_string().contains("GIT_SSH_COMMAND"), "{err}");
    }

    #[test]
    fn run_git_env_is_confined_like_run_git() {
        let dir = workspace_root();
        init_repo(dir.path());
        let outside = tempfile::tempdir().unwrap();
        let env = [("GIT_EDITOR".to_string(), "true".to_string())];
        assert!(run_git_env(dir.path(), &lossy(outside.path()), &["status".to_string()], &env).is_err());
        assert!(run_git_env(dir.path(), "..", &["status".to_string()], &env).is_err());
    }

    #[test]
    fn run_git_streaming_delivers_progress_lines_and_the_error_tail() {
        let dir = workspace_root();
        init_repo(dir.path());
        let mut lines = Vec::new();
        // `clone --progress` of a missing path fails fast with a stderr
        // line: enough to prove the stream and the error tail with no
        // network, exactly as the desktop's own runner is tested.
        let err = run_git_streaming(
            dir.path(),
            &lossy(dir.path()),
            &["clone".to_string(), "--progress".to_string(), "/definitely/missing/repo".to_string(), "x".to_string()],
            &mut |l| lines.push(l),
            &mut |_| {},
        )
        .unwrap_err();
        assert!(!lines.is_empty(), "git said nothing on stderr");
        let msg = err.to_string();
        assert!(msg.contains("exist") || msg.contains("fatal"), "{msg}");
    }

    #[test]
    fn run_git_streaming_succeeds_and_is_confined() {
        let dir = workspace_root();
        init_repo(dir.path());
        // A local clone needs no network and does write progress.
        let dest = dir.path().join("copy");
        std::fs::write(dir.path().join("a.txt"), "hi").unwrap();
        let _ = run_git(dir.path(), &lossy(dir.path()), &["add".into(), "a.txt".into()], None).unwrap();
        let _ = run_git(dir.path(), &lossy(dir.path()), &["commit".into(), "-q".into(), "-m".into(), "x".into()], None).unwrap();
        run_git_streaming(
            dir.path(),
            &lossy(dir.path()),
            &["clone".to_string(), "--progress".to_string(), "-q".to_string(), ".".to_string(), lossy(&dest)],
            &mut |_| {},
            &mut |_| {},
        )
        .unwrap();
        assert!(dest.join("a.txt").exists());

        let outside = tempfile::tempdir().unwrap();
        assert!(run_git_streaming(
            dir.path(),
            &lossy(outside.path()),
            &["fetch".to_string()],
            &mut |_| {},
            &mut |_| {},
        )
        .is_err());
    }

    #[test]
    fn create_workspace_path_makes_a_file_or_a_folder_and_refuses_an_existing_one() {
        let dir = workspace_root();
        create_workspace_path(dir.path(), "new.txt", false).unwrap();
        assert!(dir.path().join("new.txt").is_file());
        create_workspace_path(dir.path(), "folder", true).unwrap();
        assert!(dir.path().join("folder").is_dir());
        // An existing target is refused by the filesystem, never
        // overwritten -- `create_new`, not a write.
        std::fs::write(dir.path().join("new.txt"), "kept").unwrap();
        assert!(create_workspace_path(dir.path(), "new.txt", false).is_err());
        assert_eq!(std::fs::read_to_string(dir.path().join("new.txt")).unwrap(), "kept");
        // A missing parent is a typo worth reporting, not a mkdir -p.
        assert!(create_workspace_path(dir.path(), "nope/deep.txt", false).is_err());
        // And nothing outside the root.
        let outside = tempfile::tempdir().unwrap();
        assert!(create_workspace_path(dir.path(), &lossy(&outside.path().join("x")), false).is_err());
        assert!(create_workspace_path(dir.path(), "../escape.txt", false).is_err());
    }

    #[test]
    fn rename_workspace_path_moves_inside_the_root_and_never_clobbers() {
        let dir = workspace_root();
        std::fs::write(dir.path().join("a.txt"), "a").unwrap();
        std::fs::write(dir.path().join("b.txt"), "b").unwrap();
        rename_workspace_path(dir.path(), "a.txt", "moved.txt").unwrap();
        assert!(!dir.path().join("a.txt").exists());
        assert_eq!(std::fs::read_to_string(dir.path().join("moved.txt")).unwrap(), "a");
        // The destination existing is a refusal, not a silent overwrite:
        // fs::rename clobbers on unix, which would delete b.txt with no
        // trip through the Trash.
        assert!(rename_workspace_path(dir.path(), "moved.txt", "b.txt").is_err());
        assert_eq!(std::fs::read_to_string(dir.path().join("b.txt")).unwrap(), "b");
        assert!(rename_workspace_path(dir.path(), "gone.txt", "x.txt").is_err());
        let outside = tempfile::tempdir().unwrap();
        assert!(rename_workspace_path(dir.path(), "moved.txt", &lossy(&outside.path().join("x"))).is_err());
        assert!(rename_workspace_path(dir.path(), "moved.txt", "../escaped.txt").is_err());
    }

    /// The containment half, which holds on every OS. Whether the file
    /// reaches a Trash is the `trash` crate's business and varies with
    /// the session type (a headless CI runner may have none), so this
    /// asserts the refusals and only that the call is attempted.
    #[test]
    fn trash_workspace_path_refuses_outside_the_root_and_a_missing_file() {
        let dir = workspace_root();
        let outside = tempfile::tempdir().unwrap();
        assert!(trash_workspace_path(dir.path(), &lossy(&outside.path().join("x.txt"))).is_err());
        assert!(trash_workspace_path(dir.path(), "../x.txt").is_err());
        assert!(trash_workspace_path(dir.path(), "never-existed.txt").is_err());
    }

    #[test]
    fn confined_worktree_agrees_with_run_gits_own_confinement() {
        let dir = workspace_root();
        assert!(confined_worktree(dir.path(), &lossy(dir.path())).is_ok());
        let outside = tempfile::tempdir().unwrap();
        assert!(confined_worktree(dir.path(), &lossy(outside.path())).is_err());
        assert!(confined_worktree(dir.path(), "..").is_err());
    }
}
