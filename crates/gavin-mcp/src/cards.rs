//! What `gavin_get_tree` and `gavin_find_cards` print.
//!
//! The daemon's scan is the canonical parse of every card, and it is
//! shaped for the app: every field of every card, archived ones included.
//! Printed whole it ran to some 457,000 characters on a workspace with a
//! long archive -- far past what an agent's MCP client shows, so the
//! answer landed in a file the agent had to grep for the two cards it
//! wanted. These views keep the parse and drop the weight:
//!
//! - the board (`gavin_get_tree`) leaves archived cards out -- a human
//!   filed them off the board -- and counts them per context instead;
//! - a card is one line, without the fields that say nothing (null,
//!   false, empty), so a long answer still greps one card per hit;
//! - `gavin_find_cards` reaches the whole tree, archive included, ranked
//!   by meaning and words when the daemon's card index can (v71) and by
//!   words alone when it cannot, and returns only the cards close to the
//!   best match.

use std::cmp::Reverse;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io;

use protocol::{
    AgentConfig, CardKind, Complexity, GavinContext, GavinContextKind, GavinTree, HumanItem, HumanItemKind,
    HumanItemState, MdFileInfo, PlanFileInfo, Priority,
};
use serde::Serialize;
use serde_json::Value;

/// A card a human archived: directly or deeper under a `plans/archive/`.
/// The rule the orchestration tab's drawer matches on too
/// (`availableCards` in orchestration.ts) -- by the folder, since the
/// folder IS the archive. Paths are `wire_path`s, so the separator is
/// `/` on every OS.
pub fn is_archived(plan: &PlanFileInfo) -> bool {
    plan.path.contains("/plans/archive/")
}

const DEFAULT_LIMIT: usize = 20;
const MAX_LIMIT: usize = 200;

/// How far below the best card's cosine a card may score and still come
/// back. Measured on this repo's 624 cards with the labelled queries in
/// `test-fixtures/card-search/queries.json`: within 0.05 of the best,
/// 3.3 cards came back on average and the card a query meant was among
/// them for 37 of 40 queries; within 0.08, 9 cards and 39 of 40; within
/// 0.10, 17 cards -- most of a default page -- and all 40. The one 0.08
/// loses was a query whose best card is a near twin of the card it named.
const CLOSE_TO_BEST: f32 = 0.08;

// ---------- the line shape ----------

/// One card, as both tools print it. The scan's own field names, in an
/// order that reads -- what it is, then where it stands, then the rest.
/// `fileName` is left off: it is the last segment of `path`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CardView<'a> {
    path: &'a str,
    title: &'a str,
    kind: CardKind,
    /// Only ever true: a direct-prompt task, whose body is sent as the
    /// whole prompt. An agent editing its body is editing what the next
    /// agent reads verbatim, with no card path or status line around it.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    direct: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    priority: Option<&'a Priority>,
    #[serde(skip_serializing_if = "Option::is_none")]
    order: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    complexity: Option<Complexity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    effort: Option<&'a str>,
    #[serde(skip_serializing_if = "<[_]>::is_empty")]
    labels: &'a [String],
    /// Both absent on a card with no checklist: "0 of 0" says nothing.
    #[serde(skip_serializing_if = "Option::is_none")]
    checklist_done: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    checklist_total: Option<u32>,
    /// The items themselves, from `gavin_find_cards`.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    human_items: Vec<HumanItemView<'a>>,
    /// How many stand in each state, on the board: see `summarized`.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    human_item_counts: BTreeMap<&'static str, u32>,
    #[serde(skip_serializing_if = "<[_]>::is_empty")]
    attachments: &'a [String],
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    parse_warning: bool,
    /// `gavin_find_cards` only, where it is the order of a list with no
    /// query; on the board it is weight with no use (`summarized`).
    #[serde(skip_serializing_if = "Option::is_none")]
    modified_at: Option<i64>,
    /// Only ever true, and only from `gavin_find_cards`: the board never
    /// shows an archived card.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    archived: bool,
    /// Similarity to the query, when the search ranked by meaning.
    #[serde(skip_serializing_if = "Option::is_none")]
    score: Option<f32>,
}

/// A `Decision:` / `Human test:` item without `lineText` and `lineIndex`,
/// which are the app's write guards and nothing an agent acts on.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HumanItemView<'a> {
    kind: HumanItemKind,
    text: &'a str,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    done: bool,
    #[serde(skip_serializing_if = "<[_]>::is_empty")]
    options: &'a [String],
    #[serde(skip_serializing_if = "Option::is_none")]
    latest: Option<&'a str>,
    state: HumanItemState,
}

impl<'a> HumanItemView<'a> {
    fn of(item: &'a HumanItem) -> Self {
        Self {
            kind: item.kind,
            text: &item.text,
            done: item.done,
            options: &item.options,
            latest: item.latest.as_deref(),
            state: item.state,
        }
    }
}

impl<'a> CardView<'a> {
    fn of(plan: &'a PlanFileInfo) -> Self {
        let checklist = (plan.checklist_total > 0).then_some((plan.checklist_done, plan.checklist_total));
        Self {
            path: &plan.path,
            title: &plan.title,
            kind: plan.kind,
            direct: plan.direct,
            status: plan.status.as_deref(),
            parent: plan.parent.as_deref(),
            priority: plan.priority.as_ref(),
            order: plan.order,
            complexity: plan.complexity,
            agent: plan.agent.as_deref(),
            model: plan.model.as_deref(),
            effort: plan.effort.as_deref(),
            labels: &plan.labels,
            checklist_done: checklist.map(|c| c.0),
            checklist_total: checklist.map(|c| c.1),
            // None is "unknown" (an oversize card, an older daemon) and
            // rides with `parseWarning`; either way there is nothing to
            // list.
            human_items: plan.human_items.iter().flatten().map(HumanItemView::of).collect(),
            human_item_counts: BTreeMap::new(),
            attachments: &plan.attachments,
            parse_warning: plan.parse_warning,
            modified_at: plan.modified_at,
            archived: is_archived(plan),
            score: None,
        }
    }

    /// The board's form of a card. Its human items become a count per
    /// state -- the card file has their text, and on a busy board the
    /// items were half the answer -- and `modifiedAt` goes.
    fn summarized(mut self) -> Self {
        for item in self.human_items.drain(..) {
            let state = match item.state {
                HumanItemState::Open => "open",
                HumanItemState::Answered => "answered",
                HumanItemState::Passed => "passed",
                HumanItemState::Failed => "failed",
            };
            *self.human_item_counts.entry(state).or_default() += 1;
        }
        self.modified_at = None;
        self
    }
}

// ---------- the board ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ContextView<'a> {
    folder_path: &'a str,
    kind: &'a GavinContextKind,
    name: &'a str,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    outside: bool,
    has_prd: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    prd: Option<&'a str>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    config_warning: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent: Option<&'a AgentConfig>,
    /// Before `plans`, so it is read before a long list rather than after.
    #[serde(skip_serializing_if = "is_zero")]
    archived_cards: usize,
    plans: Vec<CardView<'a>>,
    #[serde(skip_serializing_if = "<[_]>::is_empty")]
    docs: &'a [MdFileInfo],
    #[serde(skip_serializing_if = "<[_]>::is_empty")]
    specs: &'a [MdFileInfo],
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TreeView<'a> {
    root_path: &'a str,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    root_missing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    contexts: Vec<ContextView<'a>>,
}

impl<'a> ContextView<'a> {
    fn of(ctx: &'a GavinContext) -> Self {
        let (archived, on_board): (Vec<&PlanFileInfo>, Vec<&PlanFileInfo>) =
            ctx.plans.iter().partition(|p| is_archived(p));
        Self {
            folder_path: &ctx.folder_path,
            kind: &ctx.kind,
            name: &ctx.name,
            outside: ctx.outside,
            has_prd: ctx.has_prd,
            prd: ctx.prd.as_deref(),
            config_warning: ctx.config_warning,
            agent: ctx.agent.as_ref(),
            archived_cards: archived.len(),
            plans: on_board.into_iter().map(|p| CardView::of(p).summarized()).collect(),
            docs: &ctx.docs,
            specs: &ctx.specs,
        }
    }
}

/// `gavin_get_tree`: every context, and every card still on the board.
pub fn board(tree: &GavinTree) -> String {
    let contexts: Vec<ContextView> = tree.contexts.iter().map(ContextView::of).collect();
    let archived: usize = contexts.iter().map(|c| c.archived_cards).sum();
    let view = TreeView {
        root_path: &tree.root_path,
        root_missing: tree.root_missing,
        // In the answer and not only in the tool's description: the
        // description is read once, and this is read every time.
        note: (archived > 0).then(|| {
            format!(
                "{archived} archived card{} left out (archivedCards per context) — gavin_find_cards searches them",
                if archived == 1 { " is" } else { "s are" }
            )
        }),
        contexts,
    };
    // Pretty down to the plans array, so each card is one line.
    render(&view, 4)
}

// ---------- the search ----------

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Archived {
    Include,
    Exclude,
    Only,
}

/// What `gavin_find_cards` was asked for. Every criterion given has to
/// hold.
#[derive(Debug, PartialEq)]
pub struct Criteria {
    pub query: Option<String>,
    pub status: Option<String>,
    pub kind: Option<CardKind>,
    pub parent: Option<String>,
    pub label: Option<String>,
    pub archived: Archived,
    pub limit: usize,
}

/// An argument an agent actually gave: present, a string, not blank.
fn given(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

impl Criteria {
    pub fn from_args(args: &Value) -> anyhow::Result<Self> {
        let kind = match given(args, "kind").map(|k| k.to_ascii_lowercase()) {
            None => None,
            Some(k) => Some(match k.as_str() {
                "note" => CardKind::Note,
                "task" => CardKind::Task,
                "plan" => CardKind::Plan,
                // Named rather than ignored: a typo that quietly dropped
                // the filter would answer a different question.
                _ => anyhow::bail!("kind must be \"note\", \"task\" or \"plan\", not {k:?}"),
            }),
        };
        let archived = match given(args, "archived").map(|a| a.to_ascii_lowercase()) {
            None => Archived::Include,
            Some(a) => match a.as_str() {
                "include" => Archived::Include,
                "exclude" => Archived::Exclude,
                "only" => Archived::Only,
                _ => anyhow::bail!("archived must be \"include\", \"exclude\" or \"only\", not {a:?}"),
            },
        };
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .map(|l| (l as usize).clamp(1, MAX_LIMIT))
            .unwrap_or(DEFAULT_LIMIT);
        Ok(Self {
            query: given(args, "query"),
            status: given(args, "status"),
            kind,
            parent: given(args, "parent"),
            label: given(args, "label"),
            archived,
            limit,
        })
    }
}

/// How a query was matched.
pub enum Ranking {
    /// The daemon's card index answered: for each path, its place in the
    /// daemon's order (meaning and words fused, best first) and its
    /// cosine to the query.
    Meaning(HashMap<String, (usize, f32)>),
    /// It could not -- an older daemon, a model never downloaded -- so
    /// the query matched words instead, and `why` says what stopped it.
    Words { why: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FoundView<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    search: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    /// How many cards met the criteria. Absent from a search by meaning,
    /// which scores every card that met the rest -- "624 matched" would
    /// say every card is about the query.
    #[serde(skip_serializing_if = "Option::is_none")]
    matched: Option<usize>,
    /// How many cards a search by meaning picked its best from.
    #[serde(skip_serializing_if = "Option::is_none")]
    ranked: Option<usize>,
    /// How many of those were close enough to the best to come back.
    #[serde(skip_serializing_if = "Option::is_none")]
    close: Option<usize>,
    cards: Vec<CardView<'a>>,
}

/// A column name the way the board matches one: case, spaces and
/// punctuation do not count, so "in progress" finds "In Progress".
fn column_key(name: &str) -> String {
    name.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// A `parent:` value without its `.md`, which agents write both ways.
fn parent_key(name: &str) -> String {
    let lower = name.trim().to_lowercase();
    lower.strip_suffix(".md").map(str::to_string).unwrap_or(lower)
}

/// Lowercased words, split on anything that is not a letter or digit --
/// so `kanban-drag.md` is `kanban`, `drag`, `md`.
fn words_of(text: &str) -> Vec<String> {
    text.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_string).collect()
}

/// Every word of the query starts a word of the card's title or file
/// name. A prefix and not a substring: "auth" finds "authentication",
/// but the "a" of "card a" must not find every card with an a in it.
fn words_match(plan: &PlanFileInfo, words: &[String]) -> bool {
    let have = words_of(&format!("{} {}", plan.title, plan.file_name));
    words.iter().all(|w| have.iter().any(|h| h.starts_with(w.as_str())))
}

/// `gavin_find_cards`: the cards of `tree` that meet `criteria`, best
/// first when there is a query and newest first when there is not.
/// `ranking` is None exactly when there is no query.
pub fn find(tree: &GavinTree, criteria: &Criteria, ranking: Option<Ranking>) -> String {
    let words: Vec<String> = criteria.query.as_deref().map(words_of).unwrap_or_default();
    let wanted_status = criteria.status.as_deref().map(column_key);
    let wanted_parent = criteria.parent.as_deref().map(parent_key);
    let wanted_label = criteria.label.as_deref().map(str::to_lowercase);

    let mut found: Vec<(&PlanFileInfo, bool, Option<(usize, f32)>)> = Vec::new();
    for ctx in &tree.contexts {
        // Per CONTEXT, on file_name: the key the board nests on.
        let plan_status: HashMap<&str, Option<&str>> = ctx
            .plans
            .iter()
            .filter(|p| matches!(p.kind, CardKind::Plan))
            .map(|p| (p.file_name.as_str(), p.status.as_deref()))
            .collect();
        let plans_here: HashSet<&str> = plan_status.keys().copied().collect();
        for plan in &ctx.plans {
            let archived = is_archived(plan);
            match criteria.archived {
                Archived::Include => {}
                Archived::Exclude if archived => continue,
                Archived::Only if !archived => continue,
                _ => {}
            }
            if criteria.kind.is_some_and(|k| k != plan.kind) {
                continue;
            }
            if let Some(label) = &wanted_label {
                if !plan.labels.iter().any(|l| l.to_lowercase() == *label) {
                    continue;
                }
            }
            if let Some(parent) = &wanted_parent {
                if plan.parent.as_deref().map(parent_key).as_ref() != Some(parent) {
                    continue;
                }
            }
            if let Some(status) = &wanted_status {
                // A nested task has no status of its own: it stands where
                // its plan stands (orchestration.effectiveStatus).
                let effective = if crate::is_nested(plan, &plans_here) {
                    plan.parent.as_deref().and_then(|p| plan_status.get(p).copied().flatten())
                } else {
                    plan.status.as_deref()
                };
                if effective.map(column_key).as_ref() != Some(status) {
                    continue;
                }
            }
            let literal = !words.is_empty() && words_match(plan, &words);
            let score = match &ranking {
                Some(Ranking::Meaning(hits)) => hits.get(&plan.path).copied(),
                _ => None,
            };
            let keep = match &ranking {
                None => true,
                // A card past the index's cap has no score; a literal
                // hit still earns it a place.
                Some(Ranking::Meaning(_)) => score.is_some() || literal,
                Some(Ranking::Words { .. }) => literal,
            };
            if keep {
                found.push((plan, literal, score));
            }
        }
    }

    match &ranking {
        // Words the agent typed beat a near meaning: a title that says
        // it outright is the card they named. The rest keep the daemon's
        // order, which is not the cosine's -- words are fused into it.
        Some(Ranking::Meaning(_)) => found.sort_by(|a, b| {
            b.1.cmp(&a.1)
                .then(a.2.map_or(usize::MAX, |s| s.0).cmp(&b.2.map_or(usize::MAX, |s| s.0)))
                .then_with(|| a.0.path.cmp(&b.0.path))
        }),
        _ => found.sort_by_key(|(p, _, _)| (Reverse(p.modified_at.unwrap_or(i64::MIN)), p.path.clone())),
    }

    let matched = found.len();
    let by_meaning = matches!(ranking, Some(Ranking::Meaning(_)));
    // Only the cards close to the best match, measured against the best of
    // the cards the other criteria left -- not of the whole workspace -- so
    // a filter narrows the field before the cut is made. A literal title
    // match always stays.
    if by_meaning {
        let best = found.iter().filter_map(|(_, _, s)| s.map(|s| s.1)).fold(f32::MIN, f32::max);
        found.retain(|(_, literal, s)| *literal || s.is_some_and(|s| s.1 >= best - CLOSE_TO_BEST));
    }
    let close = found.len();
    let mut notes = Vec::new();
    if let Some(Ranking::Words { why }) = &ranking {
        notes.push(format!("matched words in titles and file names, not meaning: {why}"));
    }
    if by_meaning && close > criteria.limit {
        notes.push(format!("showing the best {} of {close} — raise limit (at most {MAX_LIMIT}) for more", criteria.limit));
    }
    if !by_meaning && matched > criteria.limit {
        notes.push(format!(
            "showing {} of {matched} — narrow the search, or raise limit (at most {MAX_LIMIT})",
            criteria.limit
        ));
    }
    let view = FoundView {
        search: ranking.as_ref().map(|r| match r {
            Ranking::Meaning(_) => "meaning",
            Ranking::Words { .. } => "words",
        }),
        note: (!notes.is_empty()).then(|| notes.join(" — ")),
        matched: (!by_meaning).then_some(matched),
        ranked: by_meaning.then_some(matched),
        close: by_meaning.then_some(close),
        cards: found
            .into_iter()
            .take(criteria.limit)
            .map(|(plan, _, score)| CardView {
                score: score.map(|s| (s.1 * 100.0).round() / 100.0),
                ..CardView::of(plan)
            })
            .collect(),
    };
    // Pretty down to the cards array, so each card is one line.
    render(&view, 2)
}

// ---------- rendering ----------

/// JSON pretty-printed down to `pretty_levels` levels of nesting and
/// compact below, so a list of cards prints one card per line.
fn render<T: Serialize>(value: &T, pretty_levels: usize) -> String {
    let mut ser = serde_json::Serializer::with_formatter(
        Vec::new(),
        Indented { pretty_levels, level: 0, has_value: false },
    );
    value.serialize(&mut ser).expect("these views always serialize");
    String::from_utf8(ser.into_inner()).expect("serde_json writes UTF-8")
}

/// serde_json's `PrettyFormatter`, except that a container opened deeper
/// than `pretty_levels` is written compact.
struct Indented {
    pretty_levels: usize,
    /// How many containers are open.
    level: usize,
    has_value: bool,
}

impl Indented {
    fn pretty(&self) -> bool {
        self.level <= self.pretty_levels
    }

    fn next_item<W: ?Sized + io::Write>(&self, w: &mut W, first: bool) -> io::Result<()> {
        if !first {
            w.write_all(b",")?;
        }
        if self.pretty() {
            w.write_all(b"\n")?;
            w.write_all("  ".repeat(self.level).as_bytes())?;
        }
        Ok(())
    }

    fn close<W: ?Sized + io::Write>(&mut self, w: &mut W, bracket: &[u8]) -> io::Result<()> {
        if self.pretty() && self.has_value {
            w.write_all(b"\n")?;
            w.write_all("  ".repeat(self.level - 1).as_bytes())?;
        }
        self.level -= 1;
        w.write_all(bracket)
    }
}

impl serde_json::ser::Formatter for Indented {
    fn begin_array<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.level += 1;
        self.has_value = false;
        w.write_all(b"[")
    }

    fn end_array<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.close(w, b"]")
    }

    fn begin_array_value<W: ?Sized + io::Write>(&mut self, w: &mut W, first: bool) -> io::Result<()> {
        self.next_item(w, first)
    }

    fn end_array_value<W: ?Sized + io::Write>(&mut self, _w: &mut W) -> io::Result<()> {
        self.has_value = true;
        Ok(())
    }

    fn begin_object<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.level += 1;
        self.has_value = false;
        w.write_all(b"{")
    }

    fn end_object<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.close(w, b"}")
    }

    fn begin_object_key<W: ?Sized + io::Write>(&mut self, w: &mut W, first: bool) -> io::Result<()> {
        self.next_item(w, first)
    }

    fn begin_object_value<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        w.write_all(if self.pretty() { b": " } else { b":" })
    }

    fn end_object_value<W: ?Sized + io::Write>(&mut self, _w: &mut W) -> io::Result<()> {
        self.has_value = true;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn card(path: &str, title: &str) -> PlanFileInfo {
        PlanFileInfo {
            path: path.into(),
            file_name: path.rsplit('/').next().unwrap().into(),
            title: title.into(),
            status: Some("To Do".into()),
            priority: None,
            order: None,
            kind: CardKind::Task,
            parent: None,
            labels: vec![],
            checklist_done: 0,
            checklist_total: 0,
            parse_warning: false,
            modified_at: None,
            attachments: vec![],
            complexity: None,
            agent: None,
            model: None,
            effort: None,
            direct: false,
            human_items: Some(vec![]),
        }
    }

    fn tree(plans: Vec<PlanFileInfo>) -> GavinTree {
        GavinTree {
            root_path: "/ws".into(),
            root_missing: false,
            contexts: vec![GavinContext {
                folder_path: "/ws".into(),
                kind: GavinContextKind::Root,
                name: "ws".into(),
                plans,
                docs: vec![],
                specs: vec![],
                has_prd: true,
                config_warning: false,
                agent: None,
                prd: None,
                outside: false,
            }],
        }
    }

    const P: &str = "/ws/.gavin-root/plans";

    /// The cards the read-back in gavin-develop checks: a plan with a
    /// checklist and a level, its nested child, a free card, an archived
    /// one and a note.
    fn workspace() -> GavinTree {
        tree(vec![
            PlanFileInfo {
                kind: CardKind::Plan,
                status: Some("In Progress".into()),
                complexity: Some(Complexity::Moderate),
                checklist_done: 1,
                checklist_total: 4,
                modified_at: Some(30),
                ..card(&format!("{P}/auth-rework.md"), "Rework auth")
            },
            PlanFileInfo {
                status: None,
                parent: Some("auth-rework.md".into()),
                complexity: Some(Complexity::Complex),
                modified_at: Some(40),
                ..card(&format!("{P}/login-flow.md"), "Fix the login flow")
            },
            PlanFileInfo {
                labels: vec!["ui".into()],
                modified_at: Some(20),
                ..card(&format!("{P}/kanban-drag.md"), "Kanban drag bug")
            },
            PlanFileInfo {
                status: Some("Done".into()),
                modified_at: Some(10),
                ..card(&format!("{P}/archive/old-login.md"), "Old login page")
            },
            PlanFileInfo { kind: CardKind::Note, status: None, ..card(&format!("{P}/idea.md"), "Login idea") },
        ])
    }

    fn criteria(args: Value) -> Criteria {
        Criteria::from_args(&args).unwrap()
    }

    fn found(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }

    fn titles(v: &Value) -> Vec<&str> {
        v["cards"].as_array().unwrap().iter().map(|c| c["title"].as_str().unwrap()).collect()
    }

    // -- the board ------------------------------------------------------

    #[test]
    fn the_board_leaves_archived_cards_out_and_counts_them() {
        let out = board(&workspace());
        let v: Value = serde_json::from_str(&out).unwrap();
        let plans = v["contexts"][0]["plans"].as_array().unwrap();
        assert_eq!(plans.len(), 4);
        assert!(!out.contains("old-login"), "{out}");
        assert_eq!(v["contexts"][0]["archivedCards"], 1);
        assert!(v["note"].as_str().unwrap().contains("gavin_find_cards"), "{out}");

        let none_archived = board(&tree(vec![card(&format!("{P}/a.md"), "A")]));
        assert!(!none_archived.contains("archived"), "{none_archived}");
    }

    #[test]
    fn a_card_is_one_line_without_the_fields_that_say_nothing() {
        let out = board(&workspace());
        let line = out.lines().find(|l| l.contains("auth-rework")).unwrap();
        assert_eq!(
            line.trim(),
            r#"{"path":"/ws/.gavin-root/plans/auth-rework.md","title":"Rework auth","kind":"plan","status":"In Progress","complexity":"moderate","checklistDone":1,"checklistTotal":4},"#
        );
        // The nested child reads back as a task with its parent, no
        // status of its own and its own level -- gavin-develop's check.
        let child = out.lines().find(|l| l.contains("login-flow")).unwrap();
        let child: Value = serde_json::from_str(child.trim().trim_end_matches(',')).unwrap();
        assert_eq!(child["kind"], "task");
        assert_eq!(child["parent"], "auth-rework.md");
        assert_eq!(child["complexity"], "complex");
        assert!(child.get("status").is_none());
        for absent in ["null", "parseWarning", "humanItems", "fileName", "modifiedAt", "\"labels\":[]", "checklistDone\":0"] {
            assert!(!out.contains(absent), "{absent} in {out}");
        }
    }

    #[test]
    fn human_items_keep_what_an_agent_reads_and_the_board_only_counts_them() {
        let mut plan = card(&format!("{P}/a.md"), "A");
        plan.human_items = Some(vec![HumanItem {
            kind: HumanItemKind::Decision,
            text: "Which serializer?".into(),
            done: false,
            options: vec!["serde".into(), "hand-rolled".into()],
            latest: None,
            state: HumanItemState::Open,
            line_text: "Decision: Which serializer?".into(),
            line_index: 7,
        }]);
        let ws = tree(vec![plan]);
        let out = find(&ws, &criteria(json!({})), None);
        assert!(
            out.contains(r#""humanItems":[{"kind":"decision","text":"Which serializer?","options":["serde","hand-rolled"],"state":"open"}]"#),
            "{out}"
        );
        assert!(!out.contains("lineText") && !out.contains("lineIndex"), "{out}");
        // The board counts them instead; the card file has the text.
        let out = board(&ws);
        assert!(out.contains(r#""humanItemCounts":{"open":1}"#), "{out}");
        assert!(!out.contains("Which serializer?"), "{out}");
    }

    /// The point of the card: a board an agent's MCP client shows rather
    /// than spills to a file. Claude Code's default cap is 25,000 tokens,
    /// taken here as 100,000 characters; 300 live cards under a real-length
    /// root, carrying what an ordinary card carries, still fit -- and an
    /// archive of any size costs nothing.
    #[test]
    fn three_hundred_live_cards_and_a_large_archive_fit_an_mcp_answer() {
        let mut plans = Vec::new();
        for i in 0..300 {
            plans.push(PlanFileInfo {
                priority: Some(Priority::Medium),
                order: Some(i * 1024),
                complexity: Some(Complexity::Moderate),
                labels: vec!["ui".into()],
                checklist_done: 2,
                checklist_total: 5,
                modified_at: Some(1_760_000_000 + i),
                ..card(
                    &format!("/Users/someone/Code/workspace/.gavin-root/plans/feat-a-card-name-{i}.md"),
                    &format!("A card title of ordinary length, number {i}"),
                )
            });
        }
        for i in 0..2000 {
            plans.push(card(&format!("{P}/archive/old-{i}.md"), "Long gone"));
        }
        let out = board(&tree(plans));
        assert!(out.len() < 100_000, "{} characters", out.len());
        assert_eq!(out.lines().filter(|l| l.contains("\"path\"")).count(), 300, "one line per card");
    }

    #[test]
    fn render_is_pretty_to_the_level_asked_and_compact_below() {
        let v = json!({ "a": [{ "b": [1, 2] }, {}], "c": [], "d": {} });
        assert_eq!(render(&v, 2), "{\n  \"a\": [\n    {\"b\":[1,2]},\n    {}\n  ],\n  \"c\": [],\n  \"d\": {}\n}");
        assert_eq!(render(&v, 0), serde_json::to_string(&v).unwrap());
        // At full depth it is exactly serde_json's own pretty printer.
        assert_eq!(render(&v, 99), serde_json::to_string_pretty(&v).unwrap());
    }

    // -- the search -----------------------------------------------------

    #[test]
    fn criteria_read_blank_as_absent_and_refuse_what_they_cannot_mean() {
        assert_eq!(
            criteria(json!({ "query": "  ", "status": "" })),
            Criteria {
                query: None,
                status: None,
                kind: None,
                parent: None,
                label: None,
                archived: Archived::Include,
                limit: DEFAULT_LIMIT,
            }
        );
        assert_eq!(criteria(json!({ "kind": "Plan", "archived": "ONLY" })).kind, Some(CardKind::Plan));
        assert_eq!(criteria(json!({ "limit": 0 })).limit, 1);
        assert_eq!(criteria(json!({ "limit": 10_000 })).limit, MAX_LIMIT);
        let err = Criteria::from_args(&json!({ "kind": "epic" })).unwrap_err().to_string();
        assert!(err.contains("note") && err.contains("epic"), "{err}");
        assert!(Criteria::from_args(&json!({ "archived": "yes" })).is_err());
    }

    #[test]
    fn a_parent_lists_its_children_either_spelling() {
        for parent in ["auth-rework.md", "auth-rework", "Auth-Rework.MD"] {
            let v = found(&find(&workspace(), &criteria(json!({ "parent": parent })), None));
            assert_eq!(titles(&v), vec!["Fix the login flow"], "{parent}");
        }
    }

    /// A nested task stands where its plan stands; reading `status` raw
    /// is what once made rails re-run finished work.
    #[test]
    fn status_is_the_effective_one_and_matched_the_way_the_board_matches_columns() {
        let v = found(&find(&workspace(), &criteria(json!({ "status": "in progress" })), None));
        assert_eq!(titles(&v), vec!["Fix the login flow", "Rework auth"], "newest first");
        let v = found(&find(&workspace(), &criteria(json!({ "status": "TODO" })), None));
        assert_eq!(titles(&v), vec!["Kanban drag bug"]);
    }

    #[test]
    fn the_archive_is_searched_by_default_and_can_be_left_out_or_alone() {
        let all = found(&find(&workspace(), &criteria(json!({})), None));
        assert_eq!(all["matched"], 5);
        let archived = all["cards"].as_array().unwrap().iter().find(|c| c["title"] == "Old login page").unwrap();
        assert_eq!(archived["archived"], true);
        let only = found(&find(&workspace(), &criteria(json!({ "archived": "only" })), None));
        assert_eq!(titles(&only), vec!["Old login page"]);
        let without = found(&find(&workspace(), &criteria(json!({ "archived": "exclude" })), None));
        assert_eq!(without["matched"], 4);
        assert!(without["cards"].as_array().unwrap().iter().all(|c| c.get("archived").is_none()));
    }

    #[test]
    fn kind_and_label_narrow_too() {
        let v = found(&find(&workspace(), &criteria(json!({ "kind": "note" })), None));
        assert_eq!(titles(&v), vec!["Login idea"]);
        let v = found(&find(&workspace(), &criteria(json!({ "label": "UI" })), None));
        assert_eq!(titles(&v), vec!["Kanban drag bug"]);
    }

    /// The daemon's answer: paths in its order, each with its cosine.
    fn meaning(hits: &[(&str, f32)]) -> Option<Ranking> {
        Some(Ranking::Meaning(
            hits.iter().enumerate().map(|(i, (file, cos))| (format!("{P}/{file}"), (i, *cos))).collect(),
        ))
    }

    #[test]
    fn by_meaning_a_title_that_says_it_outright_comes_first_then_the_daemon_s_order() {
        let ranking = meaning(&[
            ("auth-rework.md", 0.80),
            ("archive/old-login.md", 0.84),
            ("kanban-drag.md", 0.78),
            ("login-flow.md", 0.79),
            // idea.md has no score: past the index's cap, say.
        ]);
        let v = found(&find(&workspace(), &criteria(json!({ "query": "login" })), ranking));
        assert_eq!(v["search"], "meaning");
        assert!(v.get("note").is_none());
        assert_eq!((v["ranked"].clone(), v["close"].clone()), (json!(5), json!(5)));
        assert!(v.get("matched").is_none(), "every card is scored, so none 'matched'");
        // Rework auth before Kanban drag although its cosine is the
        // lower: the daemon fused words into its order, and that order is
        // the ranking.
        assert_eq!(
            titles(&v),
            vec!["Old login page", "Fix the login flow", "Login idea", "Rework auth", "Kanban drag bug"]
        );
        assert_eq!(v["cards"][0]["score"], json!(0.84), "rounded to two places");
        assert!(v["cards"][2].get("score").is_none(), "a literal hit with no score is kept");
    }

    #[test]
    fn only_the_cards_close_to_the_best_come_back_and_a_literal_title_always_does() {
        let ranking = || {
            meaning(&[
                ("auth-rework.md", 0.70),
                ("kanban-drag.md", 0.66),
                ("login-flow.md", 0.50),
                ("archive/old-login.md", 0.45),
                ("idea.md", 0.30),
            ])
        };
        let v = found(&find(&workspace(), &criteria(json!({ "query": "login idea" })), ranking()));
        assert_eq!(titles(&v), vec!["Login idea", "Rework auth", "Kanban drag bug"]);
        assert_eq!((v["ranked"].clone(), v["close"].clone()), (json!(5), json!(3)));
        // The best is the best of what the other criteria left: alone in
        // the archive, a weak card is still the closest one there.
        let v = found(&find(&workspace(), &criteria(json!({ "query": "page", "archived": "only" })), ranking()));
        assert_eq!(titles(&v), vec!["Old login page"]);
        // And a page shorter than the close cards says so.
        let v = found(&find(&workspace(), &criteria(json!({ "query": "auth", "limit": 1 })), ranking()));
        assert_eq!(titles(&v), vec!["Rework auth"]);
        assert!(v["note"].as_str().unwrap().contains("best 1 of 2"), "{v}");
    }

    #[test]
    fn by_words_only_cards_with_every_word_come_back_and_the_answer_says_why() {
        let v = found(&find(
            &workspace(),
            &criteria(json!({ "query": "LOGIN flow" })),
            Some(Ranking::Words { why: "the memory model isn't downloaded".into() }),
        ));
        assert_eq!(v["search"], "words");
        assert_eq!(titles(&v), vec!["Fix the login flow"]);
        assert!(v["note"].as_str().unwrap().contains("isn't downloaded"), "{v}");
        // The file name counts as much as the title, and a word may be
        // the start of one.
        let words = |q: &str| {
            let v = found(&find(&workspace(), &criteria(json!({ "query": q })), Some(Ranking::Words { why: "x".into() })));
            titles(&v).into_iter().map(str::to_string).collect::<Vec<_>>()
        };
        assert_eq!(words("auth-rew"), vec!["Rework auth"]);
        assert_eq!(words("kanban-drag"), vec!["Kanban drag bug"]);
        // A word inside a word is not a match.
        assert!(words("ogin").is_empty());
    }

    #[test]
    fn the_limit_caps_the_list_and_says_how_many_matched() {
        let v = found(&find(&workspace(), &criteria(json!({ "limit": 2 })), None));
        assert_eq!(v["matched"], 5);
        assert_eq!(titles(&v), vec!["Fix the login flow", "Rework auth"]);
        assert!(v["note"].as_str().unwrap().contains("showing 2 of 5"), "{v}");
    }

    #[test]
    fn the_answer_is_one_card_per_line() {
        let out = find(&workspace(), &criteria(json!({})), None);
        assert_eq!(out.lines().filter(|l| l.contains("\"path\"")).count(), 5, "{out}");
    }
}
