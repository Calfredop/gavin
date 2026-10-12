//! What ONE run of a card cost, in tokens, read out of the agent CLI's
//! own transcript.
//!
//! The sibling of `agent_usage`, and deliberately not part of it. That
//! module reports the account's limit windows -- a percentage of a quota,
//! shared across every machine the human works on, useless for saying
//! which card was expensive. This one reports the tokens one conversation
//! actually burned, which is the only figure a per-card history can be
//! built from.
//!
//! Three things make it possible, and all three already exist:
//!
//!  - gavin MINTS the conversation id at launch (`--session-id <uuid>`
//!    and its per-profile equivalents), so the transcript can be found by
//!    exact name rather than matched by cwd and time -- which is what
//!    every "which log was that run" heuristic degenerates into.
//!  - the run history keeps that id per run (`CardRun::conversation_id`).
//!  - the profile table says whether the agent writes a transcript gavin
//!    can read at all (`agent_setup::TokenLog`), and `Unsupported` is the
//!    honest answer for the four profiles that do not.
//!
//! Nothing here reaches the network and nothing here needs a credential:
//! these are files the CLI wrote on this machine. The cost of being
//! wrong is a number in front of somebody, so every parse below refuses
//! rather than estimates -- an absent total is reported as absent.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use tauri::Manager;

use crate::agent_setup::{stock_profile_by_id, TokenLog};

/// The transcript layout a profile id's conversations are read through.
/// Named customs answer None even though `profile_by_id` would fall back
/// to claude-code: a custom is not claude, and reading under claude's
/// log root would attribute claude's conversations (and their token
/// costs) to it.
fn token_log_for(profile_id: &str) -> Option<TokenLog> {
    stock_profile_by_id(profile_id).and_then(|p| p.token_log)
}

/// How deep the codex rollout walk goes. Its sessions are filed
/// `sessions/<year>/<month>/<day>/rollout-*.jsonl`; the same bound
/// `agent_usage::collect_jsonl` uses, for the same directory tree.
const CODEX_MAX_DEPTH: usize = 4;

/// How many rollout files a lookup will open before giving up. The name
/// match below is exact, so this only bounds a walk over a machine with
/// years of codex history -- not a scan for the right file.
const CODEX_MAX_FILES: usize = 4000;

/// What one run cost. All four counts, not just a total: cache reads are
/// most of a long agent run's input and cost a fraction of a fresh one,
/// so a single "input" figure would make every resumed run look
/// ruinous.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenTotals {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    /// The sum of the four above. Computed here rather than in the
    /// frontend so that "total" means the same thing on every surface,
    /// and so a route that reports its OWN total (codex does) can hand
    /// back that one instead of a re-derived disagreement.
    pub total_tokens: u64,
    /// How many assistant turns the total is spread across. The
    /// denominator that makes a total legible: 400k over 12 turns and
    /// 400k over 300 are different runs.
    pub turns: u64,
}

/// What a read came back with.
///
/// A tagged union rather than `Option<TokenTotals>` for the same reason
/// `UsageReport` is one: "this agent keeps no readable transcript",
/// "this run has no conversation id", and "the log for this run is gone"
/// are three different sentences to put in front of somebody, and only
/// the last is a surprise.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TokenReport {
    Ready {
        totals: TokenTotals,
        /// The models the run actually used, in first-seen order.
        /// Plural because a single Claude Code run genuinely spans more
        /// than one.
        models: Vec<String>,
    },
    /// The profile writes nothing gavin can read (`TokenLog::None`), or
    /// the run predates gavin minting conversation ids.
    Unsupported { reason: String },
    /// The transcript should exist and does not, or exists and cannot be
    /// read as tokens. Distinct from `Unsupported`: this one is a
    /// surprise, and worth saying so.
    Unavailable { reason: String },
}

/// Totals for a finished run never change, and a run history opens ten
/// of them at once. Keyed by conversation id and invalidated on the
/// transcript's mtime, so a LIVE run's figures still move -- a cache
/// that froze the open run would be worse than none, because that is
/// the row somebody is watching.
#[derive(Default)]
pub struct TokenCache(Mutex<std::collections::HashMap<String, (SystemTime, TokenReport)>>);

impl TokenCache {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Whether the conversation a run recorded is still on this machine to
/// be reopened.
///
/// Three values rather than a bool, because `Unknown` is a different
/// sentence from `Missing` and only one of the two may stop a resume.
/// Gavin can answer this only for a profile whose transcript layout it
/// knows (`TokenLog`) and whose log ROOT it can actually see; anywhere
/// else it does not know where that CLI keeps its conversations, and a
/// guess would refuse a resume that would have worked.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConversationLog {
    /// The transcript is there, so a resume reopens it.
    Present,
    /// The log root exists and does not hold this conversation. The
    /// agent died before it wrote a line, so `<resume argv> <uuid>` has
    /// nothing to open and never will.
    Missing,
    /// Gavin cannot tell: no conversation id, no `TokenLog` for this
    /// profile, or a log root it cannot read. Today's behaviour --
    /// resume is offered and the CLI is the one that answers.
    Unknown,
}

/// Is this binding resumable? One call, answered where the resolver
/// already lives.
///
/// The SAME resolver `card_run_tokens` uses below, deliberately: it
/// scans every project directory for `<conversation_id>.jsonl` rather
/// than reproducing Claude Code's slug rule, which is undocumented, has
/// changed, and is wrong for any agent that moved into a worktree. An
/// existence check that reproduced the slug would report `Missing` for
/// every run that did.
///
/// Nothing here reaches the network and nothing needs a credential:
/// these are files the CLI wrote on this machine.
///
/// `async` + `spawn_blocking`: the resolver is a readdir of every project
/// directory (or a codex walk of up to `CODEX_MAX_FILES`), asked on every
/// resume and review launch -- auto-resume included -- and as a plain
/// `fn` that was the main thread's to wait on.
#[tauri::command]
pub async fn conversation_log(
    profile_id: String,
    conversation_id: Option<String>,
) -> Result<ConversationLog, String> {
    tauri::async_runtime::spawn_blocking(move || conversation_log_blocking(&profile_id, conversation_id))
        .await
        .map_err(|e| e.to_string())
}

fn conversation_log_blocking(profile_id: &str, conversation_id: Option<String>) -> ConversationLog {
    let Some(conversation_id) = conversation_id.filter(|id| !id.trim().is_empty()) else {
        return ConversationLog::Unknown;
    };
    let Some(log) = token_log_for(profile_id) else {
        return ConversationLog::Unknown;
    };
    conversation_log_under(log, log_root(log).as_deref(), conversation_id.trim())
}

/// The verdict, given the layout and the root gavin resolved for it.
/// Split from the command so the boundary that matters -- where
/// `Unknown` ends and `Missing` begins -- can be pinned by a test that
/// owns its own directory instead of reading this machine's home.
///
/// An ABSENT root reads as `Unknown`, not `Missing`. A CLI pointed
/// somewhere else (`CLAUDE_CONFIG_DIR`) keeps its conversations outside
/// the directory gavin knows about, and reading "nothing under
/// ~/.claude" as "this conversation never existed" would refuse every
/// resume on such a machine. Only a root gavin can see, which does not
/// hold the file, is evidence the conversation is gone.
fn conversation_log_under(log: TokenLog, root: Option<&Path>, conversation_id: &str) -> ConversationLog {
    let Some(root) = root.filter(|dir| dir.is_dir()) else {
        return ConversationLog::Unknown;
    };
    match transcript_path(log, root, conversation_id) {
        Some(_) => ConversationLog::Present,
        None => ConversationLog::Missing,
    }
}

/// The transcript for one conversation under an already-resolved log
/// root, per profile layout. Shared by the existence check above and the
/// token read below, so the two can never disagree about where a
/// conversation lives.
fn transcript_path(log: TokenLog, root: &Path, conversation_id: &str) -> Option<PathBuf> {
    match log {
        TokenLog::ClaudeSessionJsonl => claude_transcript(root, conversation_id),
        TokenLog::CodexRollout => codex_rollout(root, conversation_id),
        TokenLog::KimiWireJsonl => kimi_transcript(root, conversation_id),
    }
}

/// Read one run's token cost.
///
/// `conversation_id` is the id gavin minted for the run, off
/// `CardRun::conversation_id`. Absent means the run was launched by a
/// profile with no verified resume argv, and there is nothing to look
/// up -- which is `Unsupported`, not a failure.
///
/// `async` + `spawn_blocking`: Run history asks once per conversation on
/// every open and refresh, and a live run misses the cache every time --
/// a whole transcript read and summed, up to 29 MB measured here, on the
/// main thread while it was a plain `fn`. The cache is reached through
/// the app handle, since a `State` cannot cross into the blocking task.
#[tauri::command]
pub async fn card_run_tokens(
    app: tauri::AppHandle,
    profile_id: String,
    conversation_id: Option<String>,
) -> Result<TokenReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        card_run_tokens_blocking(&app.state::<TokenCache>(), &profile_id, conversation_id)
    })
    .await
    .map_err(|e| e.to_string())
}

fn card_run_tokens_blocking(cache: &TokenCache, profile_id: &str, conversation_id: Option<String>) -> TokenReport {
    let Some(conversation_id) = conversation_id.filter(|id| !id.trim().is_empty()) else {
        return TokenReport::Unsupported {
            reason: "gavin did not record a conversation id for this run".to_string(),
        };
    };
    let Some(log) = token_log_for(profile_id) else {
        return TokenReport::Unsupported {
            reason: format!("gavin cannot read {profile_id}'s token counts"),
        };
    };

    // Through the SAME root and resolver the existence check uses, so a
    // conversation `conversation_log` reports present is one this can
    // read, and one it reports missing is one this cannot.
    let path = log_root(log).and_then(|root| transcript_path(log, &root, &conversation_id));
    let Some(path) = path else {
        return TokenReport::Unavailable {
            reason: "the agent's transcript for this run is no longer on this machine".to_string(),
        };
    };

    // kimi writes one wire per AGENT of the session (`main` and the
    // `agent-N` subagents it spawned), and a run's cost is ALL of them:
    // subagent tokens bill to the same account, so summing only main's
    // wire would under-read exactly the runs that spent the most. Every
    // other route is one file. The cache clock is the NEWEST wire's
    // mtime, so a live run whose subagent is still writing still moves.
    let paths = match log {
        TokenLog::KimiWireJsonl => kimi_session_wires(&path),
        _ => vec![path],
    };
    let mtime = paths
        .iter()
        .filter_map(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok())
        .max()
        .unwrap_or(SystemTime::UNIX_EPOCH);
    if let Some((seen, report)) = cache.0.lock().unwrap().get(&conversation_id) {
        if *seen == mtime {
            return report.clone();
        }
    }

    let mut text = String::new();
    for p in &paths {
        let Ok(part) = std::fs::read_to_string(p) else {
            return TokenReport::Unavailable {
                reason: "the agent's transcript for this run could not be read".to_string(),
            };
        };
        text.push_str(&part);
        text.push('\n');
    }
    let report = match log {
        TokenLog::ClaudeSessionJsonl => claude_totals(&text),
        TokenLog::CodexRollout => codex_totals(&text),
        TokenLog::KimiWireJsonl => kimi_totals(&text),
    };
    cache.0.lock().unwrap().insert(conversation_id, (mtime, report.clone()));
    report
}

use crate::home::home_dir;

fn claude_projects_dir() -> Option<PathBuf> {
    Some(home_dir()?.join(".claude").join("projects"))
}

fn codex_sessions_dir() -> Option<PathBuf> {
    Some(home_dir()?.join(".codex").join("sessions"))
}

/// Where this profile's CLI keeps its conversations on this machine.
/// None only when gavin cannot find a home directory at all. A root that
/// resolves but is not on disk is the caller's to read -- `Unknown` for
/// the existence check, `Unavailable` for the token read -- so the one
/// place that names each layout's directory stays here.
fn log_root(log: TokenLog) -> Option<PathBuf> {
    match log {
        TokenLog::ClaudeSessionJsonl => claude_projects_dir(),
        TokenLog::CodexRollout => codex_sessions_dir(),
        TokenLog::KimiWireJsonl => kimi_home_dir(),
    }
}

/// `<projects>/<slugged cwd>/<session id>.jsonl`, found by looking in
/// every project directory rather than by reproducing the slug.
///
/// The slug rule is Claude Code's, undocumented, and has changed; the
/// file name is the session id, which gavin minted and therefore knows
/// exactly. Reproducing the slug would also be wrong more often than it
/// looks: a run's launch cwd is where gavin STARTED the agent, and an
/// agent that moves into a worktree is filed under where it ended up.
fn claude_transcript(projects: &Path, conversation_id: &str) -> Option<PathBuf> {
    let file = format!("{conversation_id}.jsonl");
    let entries = std::fs::read_dir(projects).ok()?;
    for entry in entries.flatten() {
        let candidate = entry.path().join(&file);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// The rollout whose name carries this conversation id. Codex files them
/// `sessions/<y>/<m>/<d>/rollout-<timestamp>-<id>.jsonl`, so the id is a
/// suffix of the stem rather than the whole of it -- matched as one, not
/// with a `contains` that a timestamp could satisfy by accident.
fn codex_rollout(sessions: &Path, conversation_id: &str) -> Option<PathBuf> {
    let suffix = format!("-{conversation_id}");
    let mut found = None;
    let mut budget = CODEX_MAX_FILES;
    walk_rollouts(sessions, 0, &mut budget, &mut |path| {
        if found.is_some() {
            return;
        }
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
        if stem.ends_with(&suffix) || stem == conversation_id {
            found = Some(path.to_path_buf());
        }
    });
    found
}

fn walk_rollouts(dir: &Path, depth: usize, budget: &mut usize, visit: &mut impl FnMut(&Path)) {
    if depth > CODEX_MAX_DEPTH || *budget == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_rollouts(&path, depth + 1, budget, visit);
        } else if path.extension().is_some_and(|e| e == "jsonl") {
            if *budget == 0 {
                return;
            }
            *budget -= 1;
            visit(&path);
        }
    }
}

fn kimi_home_dir() -> Option<PathBuf> {
    Some(home_dir()?.join(".kimi-code"))
}

/// The wire of the conversation itself, resolved through kimi's global
/// session index -- the ONLY map from the id gavin holds to the directory
/// kimi chose, since `transcript_path` gets no cwd to slug a path from
/// (see `TokenLog::KimiWireJsonl` in agent_setup.rs). main's wire wins
/// where several agents wrote; any other agent's is accepted over nothing
/// (a run that died at spawn may have written no main wire yet).
fn kimi_transcript(root: &Path, conversation_id: &str) -> Option<PathBuf> {
    let session = kimi_session_dir(root, conversation_id)?;
    kimi_agent_wires(&session.join("agents")).into_iter().next()
}

/// The session directory the index maps this conversation to. The LAST
/// matching line wins: kimi appends to the index rather than rewriting
/// it. A session whose directory is gone resolves to nothing, which the
/// callers read as missing, not as unreadable.
fn kimi_session_dir(root: &Path, conversation_id: &str) -> Option<PathBuf> {
    let index = std::fs::read_to_string(root.join("session_index.jsonl")).ok()?;
    let mut found = None;
    for line in index.lines() {
        let Ok(record) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if record.get("sessionId").and_then(|v| v.as_str()) != Some(conversation_id) {
            continue;
        }
        if let Some(dir) = record.get("sessionDir").and_then(|v| v.as_str()).map(str::trim) {
            if !dir.is_empty() {
                found = Some(PathBuf::from(dir));
            }
        }
    }
    found.filter(|d| d.is_dir())
}

/// Every `wire.jsonl` under an `agents/` directory, `main` first: main is
/// the conversation itself, the `agent-N` wires its subagents. Sorted, so
/// the answer does not depend on readdir order.
fn kimi_agent_wires(agents: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(agents) else { return Vec::new() };
    let mut files: Vec<PathBuf> =
        entries.flatten().map(|e| e.path().join("wire.jsonl")).filter(|p| p.is_file()).collect();
    files.sort_by_key(|p| {
        let main = p.parent().and_then(|a| a.file_name()).and_then(|n| n.to_str()) == Some("main");
        (!main, p.clone())
    });
    files
}

/// The session's wires, given ONE of them:
/// `<session>/agents/<agent>/wire.jsonl`. A path that does not match that
/// shape answers just itself.
fn kimi_session_wires(wire: &Path) -> Vec<PathBuf> {
    let Some(agents) = wire.parent().and_then(|p| p.parent()) else { return vec![wire.to_path_buf()] };
    let files = kimi_agent_wires(agents);
    if files.is_empty() { vec![wire.to_path_buf()] } else { files }
}

/// Sum a Claude Code transcript, ONE COUNT PER MESSAGE.
///
/// This is the whole subtlety of the route. An assistant message is
/// written to the transcript once per content block -- text, each tool
/// call, each thinking block -- and every one of those records repeats
/// the same `message.usage`. Summing lines reports a multiple of the
/// real cost that varies with how tool-heavy the run was: measured on a
/// real transcript (2026-09-03), 39 assistant records for 15 messages.
///
/// So the sum is over distinct `message.id`. A record without one is
/// skipped rather than counted -- there is no way to tell a duplicate
/// from a fresh turn without it, and over-reporting is the failure this
/// function exists to avoid.
///
/// Most of a transcript's bytes are what the sum never reads: tool
/// results in user records, and the content blocks of assistant ones.
/// So a line that does not carry `"assistant"` anywhere is passed over
/// before any parse -- Claude Code writes JSON with its ASCII unescaped,
/// so an assistant record always carries those bytes -- and the rest are
/// read into `ClaudeRecord`, which skips the content blocks without
/// building them. Measured on this machine's four largest transcripts
/// (17-29 MB), release build: 14-22 ms a file as a `Value` per line,
/// 5-8 ms this way, and the same totals from both.
pub fn claude_totals(text: &str) -> TokenReport {
    let mut totals = TokenTotals::default();
    let mut seen: HashSet<String> = HashSet::new();
    let mut models: Vec<String> = Vec::new();

    for line in text.lines() {
        if !line.contains("\"assistant\"") {
            continue;
        }
        let Ok(record) = serde_json::from_str::<ClaudeRecord>(line) else { continue };
        if record.kind.as_ref().and_then(|v| v.as_str()) != Some("assistant") {
            continue;
        }
        let Some(message) = record.message else { continue };
        let Some(id) = message.id.as_ref().and_then(|v| v.as_str()) else { continue };
        if !seen.insert(id.to_string()) {
            continue;
        }
        let Some(usage) = message.usage else { continue };
        let count = |key: &str| usage.get(key).and_then(|v| v.as_u64()).unwrap_or(0);
        totals.input_tokens += count("input_tokens");
        totals.output_tokens += count("output_tokens");
        totals.cache_read_tokens += count("cache_read_input_tokens");
        totals.cache_write_tokens += count("cache_creation_input_tokens");
        totals.turns += 1;
        if let Some(model) = message.model.as_ref().and_then(|v| v.as_str()) {
            if !models.iter().any(|m| m == model) {
                models.push(model.to_string());
            }
        }
    }

    if totals.turns == 0 {
        return TokenReport::Unavailable {
            reason: "the agent's transcript for this run records no completed turn".to_string(),
        };
    }
    totals.total_tokens =
        totals.input_tokens + totals.output_tokens + totals.cache_read_tokens + totals.cache_write_tokens;
    TokenReport::Ready { totals, models }
}

/// The parts of a Claude Code record `claude_totals` reads; every other
/// field, content blocks included, is skipped by the parser unbuilt.
///
/// Each one stays a loose `Value` on purpose. A typed `u64` count or
/// `String` model would fail the WHOLE line on a field of an unexpected
/// type and drop a turn that is really there; as `Value`s, an odd count
/// reads as zero and an odd model is left off the list, one field at a
/// time. `usage` is a handful of small numbers, so building it costs
/// nothing worth saving.
#[derive(serde::Deserialize)]
struct ClaudeRecord {
    #[serde(rename = "type")]
    kind: Option<serde_json::Value>,
    message: Option<ClaudeMessage>,
}

#[derive(serde::Deserialize)]
struct ClaudeMessage {
    id: Option<serde_json::Value>,
    model: Option<serde_json::Value>,
    usage: Option<serde_json::Value>,
}

/// Read a codex rollout's LAST cumulative total.
///
/// The same `token_count` event `agent_usage::newest_codex_limits`
/// already reads, a different field on it: `info.total_token_usage` is
/// the conversation's running total, so the answer is the newest event
/// carrying one. Summing them would multiply the conversation by its own
/// length -- the opposite mistake to the Claude route's, and the reason
/// neither route is written generically.
///
/// `total_tokens` is taken from the file rather than re-derived: codex
/// counts reasoning tokens inside its own total, and a sum of the parts
/// here would quietly disagree with what `codex` itself reports.
pub fn codex_totals(text: &str) -> TokenReport {
    for line in text.lines().rev() {
        let Ok(record) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let Some(payload) = record.get("payload") else { continue };
        if payload.get("type").and_then(|v| v.as_str()) != Some("token_count") {
            continue;
        }
        let Some(used) = payload.pointer("/info/total_token_usage").filter(|v| v.is_object()) else {
            continue;
        };
        let count = |key: &str| used.get(key).and_then(|v| v.as_u64()).unwrap_or(0);
        let cache_read = count("cached_input_tokens");
        let mut totals = TokenTotals {
            // Codex reports cached input INSIDE `input_tokens`; the two
            // are reported separately here, so the cached half is taken
            // back out rather than counted on both lines.
            input_tokens: count("input_tokens").saturating_sub(cache_read),
            output_tokens: count("output_tokens"),
            cache_read_tokens: cache_read,
            // No equivalent: codex does not bill a cache write.
            cache_write_tokens: 0,
            total_tokens: count("total_tokens"),
            // The rollout carries no turn count, and inventing one from
            // the number of events would count tool calls as turns.
            turns: 0,
        };
        if totals.total_tokens == 0 {
            totals.total_tokens = totals.input_tokens + totals.output_tokens + totals.cache_read_tokens;
        }
        if totals.total_tokens == 0 {
            continue;
        }
        let models = payload
            .get("info")
            .and_then(|i| i.get("model"))
            .and_then(|v| v.as_str())
            .map(|m| vec![m.to_string()])
            .unwrap_or_default();
        return TokenReport::Ready { totals, models };
    }
    TokenReport::Unavailable {
        reason: "the agent's transcript for this run records no token count".to_string(),
    }
}

/// Sum a kimi wire's `usage.record` events.
///
/// Unlike the other two routes there is nothing to deduplicate and no
/// cumulative row to prefer: kimi writes one record per LLM REQUEST, each
/// carrying that request's own counts -- verified live against kimi 2.1.1
/// (2026-10-05): `{"type":"usage.record","model":"kimi-code/k3","usage":
/// {"inputOther":...,"output":...,"inputCacheRead":...,
/// "inputCacheCreation":...},"usageScope":"turn"}`.
///
/// Only scope `turn` is summed. It is the one verified scope; another (a
/// cumulative one, say) added to the sum would double-count -- the exact
/// mistake the codex route exists to avoid -- so an unverified scope is
/// skipped, not guessed at. `text` may be SEVERAL wires concatenated
/// (main plus its subagents): the sum does not care which file a line
/// came from.
pub fn kimi_totals(text: &str) -> TokenReport {
    let mut totals = TokenTotals::default();
    let mut models: Vec<String> = Vec::new();
    let mut records = 0u64;

    for line in text.lines() {
        // The cheap pre-filter `claude_totals` documents: the type is
        // re-checked after the parse, so a line merely QUOTING either
        // string costs a parse and nothing else. The leading quote keeps
        // "agent.turn.ended" -- a different event that fires for every
        // turn end alongside turn.ended -- from matching here.
        if !line.contains("\"usage.record\"") && !line.contains("\"turn.ended\"") {
            continue;
        }
        let Ok(record) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        match record.get("type").and_then(|v| v.as_str()) {
            Some("usage.record") => {
                if record.get("usageScope").and_then(|v| v.as_str()) != Some("turn") {
                    continue;
                }
                let Some(usage) = record.get("usage").filter(|u| u.is_object()) else { continue };
                let count = |key: &str| usage.get(key).and_then(|v| v.as_u64()).unwrap_or(0);
                totals.input_tokens += count("inputOther");
                totals.output_tokens += count("output");
                totals.cache_read_tokens += count("inputCacheRead");
                totals.cache_write_tokens += count("inputCacheCreation");
                records += 1;
                if let Some(model) = record.get("model").and_then(|v| v.as_str()) {
                    if !models.iter().any(|m| m == model) {
                        models.push(model.to_string());
                    }
                }
            }
            // turn.ended, never agent.turn.ended: both fire per turn, and
            // counting both would double the denominator.
            Some("turn.ended") => totals.turns += 1,
            _ => {}
        }
    }

    if records == 0 {
        return TokenReport::Unavailable {
            reason: "the agent's transcript for this run records no token count".to_string(),
        };
    }
    totals.total_tokens =
        totals.input_tokens + totals.output_tokens + totals.cache_read_tokens + totals.cache_write_tokens;
    TokenReport::Ready { totals, models }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A named custom -- the migrated `custom-agent`, a user slug, a
    /// workspace `local:` id -- has no transcript layout of gavin's own:
    /// the read paths answer Unknown/Unsupported through `token_log_for`
    /// (`stock_profile_by_id`), never `profile_by_id`'s claude-code
    /// fallback, which would read claude's conversations and token costs
    /// as the custom's.
    #[test]
    fn a_named_custom_has_no_token_log_and_is_not_read_under_claudes_root() {
        for id in ["custom", "custom-agent", "my-bot", "local:desk"] {
            assert!(token_log_for(id).is_none(), "{id} took claude's token log");
            assert_eq!(
                conversation_log_blocking(id, Some("conv-1".to_string())),
                ConversationLog::Unknown,
                "{id} read a conversation"
            );
            assert!(matches!(
                card_run_tokens_blocking(&TokenCache::new(), id, Some("conv-1".to_string())),
                TokenReport::Unsupported { .. }
            ));
        }
        // And the stock rows still resolve, so the guard is the custom
        // shape and not the lookup itself.
        for id in ["claude-code", "codex", "kimi-code"] {
            assert!(token_log_for(id).is_some(), "{id} lost its token log");
        }
    }

    fn totals(report: &TokenReport) -> &TokenTotals {
        match report {
            TokenReport::Ready { totals, .. } => totals,
            other => panic!("expected a ready report, got {other:?}"),
        }
    }

    fn assistant(id: &str, input: u64, output: u64, cache_read: u64, cache_write: u64) -> String {
        format!(
            r#"{{"type":"assistant","message":{{"id":"{id}","model":"claude-opus-5","usage":{{"input_tokens":{input},"output_tokens":{output},"cache_read_input_tokens":{cache_read},"cache_creation_input_tokens":{cache_write}}}}}}}"#
        )
    }

    /// The bug this whole route is shaped around. One assistant message
    /// is written once per content block and every copy repeats the same
    /// `usage`; a sum over lines reports a multiple of the real cost.
    #[test]
    fn a_message_written_once_per_content_block_is_counted_once() {
        let one = assistant("msg-1", 10, 20, 30, 40);
        let text = [one.clone(), one.clone(), one].join("\n");

        let report = claude_totals(&text);

        let t = totals(&report);
        assert_eq!(t.input_tokens, 10, "not 30 -- three records, one message");
        assert_eq!(t.output_tokens, 20);
        assert_eq!(t.cache_read_tokens, 30);
        assert_eq!(t.cache_write_tokens, 40);
        assert_eq!(t.total_tokens, 100);
        assert_eq!(t.turns, 1);
    }

    #[test]
    fn distinct_messages_add_up_and_the_models_are_kept_in_order() {
        let text = [
            assistant("msg-1", 1, 2, 3, 4),
            r#"{"type":"user","message":{"id":"u-1"}}"#.to_string(),
            assistant("msg-2", 5, 6, 7, 8),
            "not json at all".to_string(),
        ]
        .join("\n");

        let report = claude_totals(&text);

        let t = totals(&report);
        assert_eq!(t.turns, 2);
        assert_eq!(t.total_tokens, 1 + 2 + 3 + 4 + 5 + 6 + 7 + 8);
        match &report {
            TokenReport::Ready { models, .. } => assert_eq!(models, &vec!["claude-opus-5".to_string()]),
            other => panic!("expected ready, got {other:?}"),
        }
    }

    /// A record with no `message.id` cannot be told apart from a
    /// duplicate of the one before it, and guessing wrong OVER-reports.
    #[test]
    fn an_assistant_record_without_a_message_id_is_skipped_rather_than_guessed_at() {
        let text = r#"{"type":"assistant","message":{"usage":{"input_tokens":999}}}"#;

        assert!(matches!(claude_totals(text), TokenReport::Unavailable { .. }));
    }

    /// The shape Claude Code actually writes: `message` BEFORE `type`,
    /// content blocks the sum never reads, and records of other types that
    /// mention "assistant" in their text. Only the parts the sum reads may
    /// decide it -- a line is neither dropped for the bulk it carries nor
    /// counted for a word in it.
    #[test]
    fn a_real_shaped_transcript_is_judged_by_type_and_usage_alone() {
        let text = [
            r#"{"parentUuid":null,"type":"user","message":{"role":"user","content":"ask the assistant"}}"#,
            r#"{"parentUuid":"a","message":{"id":"msg-1","type":"message","role":"assistant","model":"claude-opus-5","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/x","nested":[1,{"k":null}]}}],"usage":{"input_tokens":1,"output_tokens":2,"cache_read_input_tokens":3,"cache_creation_input_tokens":4,"cache_creation":{"ephemeral_5m_input_tokens":4},"server_tool_use":{"web_search_requests":0},"service_tier":"standard"}},"requestId":"r1","type": "assistant","uuid":"b"}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"{\"type\":\"assistant\",\"message\":{\"id\":\"msg-9\",\"usage\":{\"input_tokens\":999}}}"}]},"toolUseResult":{"file":{"content":"\"assistant\""}}}"#,
            r#"{"type":"summary","summary":"The assistant fixed it","leafUuid":"b"}"#,
        ]
        .join("\n");

        let report = claude_totals(&text);

        let t = totals(&report);
        assert_eq!(t.turns, 1, "the escaped record inside a tool result is not a turn");
        assert_eq!(t.total_tokens, 1 + 2 + 3 + 4);
    }

    /// A count of an unexpected type reads as zero rather than taking the
    /// whole message down with it, and a model that is not a string is
    /// left off the list while the turn still counts.
    #[test]
    fn an_oddly_typed_field_costs_that_field_not_the_turn() {
        let text = r#"{"type":"assistant","message":{"id":"msg-1","model":7,"usage":{"input_tokens":null,"output_tokens":5}}}"#;

        let report = claude_totals(text);

        let t = totals(&report);
        assert_eq!(t.turns, 1);
        assert_eq!(t.input_tokens, 0);
        assert_eq!(t.output_tokens, 5);
        match &report {
            TokenReport::Ready { models, .. } => assert!(models.is_empty()),
            other => panic!("expected ready, got {other:?}"),
        }
    }

    #[test]
    fn a_transcript_with_no_assistant_turn_is_unavailable_not_a_zero_bill() {
        let text = r#"{"type":"user","message":{"id":"u-1"}}"#;

        // Zero would render as a run that cost nothing, which is a
        // different claim from one whose cost could not be read.
        assert!(matches!(claude_totals(text), TokenReport::Unavailable { .. }));
    }

    /// `info.total_token_usage` is CUMULATIVE, so the newest event is
    /// the answer. Summing would multiply the conversation by its own
    /// length -- the opposite mistake to the Claude route's.
    #[test]
    fn a_codex_rollout_reports_its_last_cumulative_total_not_a_sum() {
        let text = [
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":10,"total_tokens":110}}}}"#,
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"model":"gpt-5-codex","total_token_usage":{"input_tokens":300,"cached_input_tokens":250,"output_tokens":30,"total_tokens":330}}}}"#,
        ]
        .join("\n");

        let report = codex_totals(&text);

        let t = totals(&report);
        assert_eq!(t.total_tokens, 330, "the last total, not 110 + 330");
        assert_eq!(t.cache_read_tokens, 250);
        assert_eq!(t.input_tokens, 50, "cached input is reported on its own line, not twice");
        assert_eq!(t.output_tokens, 30);
        match &report {
            TokenReport::Ready { models, .. } => assert_eq!(models, &vec!["gpt-5-codex".to_string()]),
            other => panic!("expected ready, got {other:?}"),
        }
    }

    #[test]
    fn a_rollout_with_no_token_count_event_is_unavailable() {
        let text = r#"{"type":"event_msg","payload":{"type":"agent_message","message":"hi"}}"#;

        assert!(matches!(codex_totals(text), TokenReport::Unavailable { .. }));
    }

    /// The report crosses to the frontend as a discriminated union, and
    /// `runHistory.ts` switches on `kind` and reads camelCase fields. A
    /// container `rename_all` renames enum VARIANTS, not their fields --
    /// so the field casing here rides on `TokenTotals`' own attribute,
    /// which is exactly the kind of thing that keeps compiling after
    /// somebody moves it, and shows up as every run costing "—".
    #[test]
    fn a_report_serializes_to_the_shape_the_frontend_switches_on() {
        let report = TokenReport::Ready {
            totals: TokenTotals {
                input_tokens: 1,
                output_tokens: 2,
                cache_read_tokens: 3,
                cache_write_tokens: 4,
                total_tokens: 10,
                turns: 5,
            },
            models: vec!["claude-opus-5".to_string()],
        };

        assert_eq!(
            serde_json::to_value(&report).unwrap(),
            serde_json::json!({
                "kind": "ready",
                "totals": { "inputTokens": 1, "outputTokens": 2, "cacheReadTokens": 3,
                            "cacheWriteTokens": 4, "totalTokens": 10, "turns": 5 },
                "models": ["claude-opus-5"],
            })
        );
        assert_eq!(
            serde_json::to_value(TokenReport::Unsupported { reason: "no".to_string() }).unwrap(),
            serde_json::json!({ "kind": "unsupported", "reason": "no" })
        );
        assert_eq!(
            serde_json::to_value(TokenReport::Unavailable { reason: "gone".to_string() }).unwrap(),
            serde_json::json!({ "kind": "unavailable", "reason": "gone" })
        );
    }

    /// The transcript is found by NAME, in whichever project directory
    /// holds it -- the slug is Claude Code's rule, and a run's launch
    /// cwd is not necessarily where the agent ended up.
    #[test]
    fn a_claude_transcript_is_found_by_session_id_in_any_project_directory() {
        let dir = tempfile::tempdir().unwrap();
        let projects = dir.path();
        std::fs::create_dir_all(projects.join("-Users-someone-a")).unwrap();
        std::fs::create_dir_all(projects.join("-Users-someone-b")).unwrap();
        std::fs::write(projects.join("-Users-someone-b").join("conv-1.jsonl"), "{}").unwrap();

        assert_eq!(
            claude_transcript(projects, "conv-1"),
            Some(projects.join("-Users-someone-b").join("conv-1.jsonl"))
        );
        assert_eq!(claude_transcript(projects, "conv-2"), None);
    }

    /// The verdict a resume turns on, and the boundary that decides it.
    /// A root gavin cannot see says nothing about the conversation; a
    /// root it CAN see that does not hold the file says the agent never
    /// wrote one -- which is what a run that died at launch leaves behind
    /// (`~/.claude/session-env/<id>/` exists, `<id>.jsonl` does not).
    #[test]
    fn a_conversation_is_missing_only_under_a_root_gavin_can_see() {
        let dir = tempfile::tempdir().unwrap();
        let projects = dir.path().join("projects");
        let log = TokenLog::ClaudeSessionJsonl;

        // No root: never run here, or pointed at another config dir.
        assert_eq!(conversation_log_under(log, None, "conv-1"), ConversationLog::Unknown);
        assert_eq!(conversation_log_under(log, Some(&projects), "conv-1"), ConversationLog::Unknown);

        // The root is there and holds OTHER conversations, not this one.
        let project = projects.join("-Users-someone-a");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("conv-0.jsonl"), "{}").unwrap();
        assert_eq!(conversation_log_under(log, Some(&projects), "conv-1"), ConversationLog::Missing);

        // Written since -- in a project directory the id is found by
        // name, whichever slug it landed under.
        let other = projects.join("-Users-someone-b");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("conv-1.jsonl"), "{}").unwrap();
        assert_eq!(conversation_log_under(log, Some(&projects), "conv-1"), ConversationLog::Present);
    }

    /// The frontend switches on these exact names (`ConversationLog` in
    /// `cardRun.ts`); a variant renamed here would read as `unknown`
    /// there and silently switch the guard off.
    #[test]
    fn the_verdict_serializes_to_the_names_the_frontend_switches_on() {
        assert_eq!(serde_json::to_value(ConversationLog::Present).unwrap(), serde_json::json!("present"));
        assert_eq!(serde_json::to_value(ConversationLog::Missing).unwrap(), serde_json::json!("missing"));
        assert_eq!(serde_json::to_value(ConversationLog::Unknown).unwrap(), serde_json::json!("unknown"));
    }

    /// Matched as a SUFFIX of the stem after a dash, so the timestamp
    /// half of a rollout name cannot satisfy it by accident.
    #[test]
    fn a_codex_rollout_is_found_by_the_id_at_the_end_of_its_name() {
        let dir = tempfile::tempdir().unwrap();
        let day = dir.path().join("2026").join("09").join("03");
        std::fs::create_dir_all(&day).unwrap();
        std::fs::write(day.join("rollout-2026-09-03T10-00-00-conv-1.jsonl"), "{}").unwrap();
        std::fs::write(day.join("rollout-2026-09-03T11-00-00-other.jsonl"), "{}").unwrap();

        assert_eq!(
            codex_rollout(dir.path(), "conv-1"),
            Some(day.join("rollout-2026-09-03T10-00-00-conv-1.jsonl"))
        );
        assert_eq!(codex_rollout(dir.path(), "conv-9"), None);
    }

    /// The index is the only map from conversation id to session
    /// directory, and main's wire is the transcript the existence check
    /// answers about.
    #[test]
    fn a_kimi_conversation_resolves_through_the_session_index() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let session = root.join("sessions/wd_proj_0123456789ab/session_abc");
        std::fs::create_dir_all(session.join("agents/main")).unwrap();
        std::fs::create_dir_all(session.join("agents/agent-0")).unwrap();
        std::fs::write(session.join("agents/agent-0/wire.jsonl"), "{}").unwrap();
        let main = session.join("agents/main/wire.jsonl");
        std::fs::write(&main, "{}").unwrap();
        std::fs::write(
            root.join("session_index.jsonl"),
            format!(
                "{{\"sessionId\":\"session_other\",\"sessionDir\":\"{0}\",\"workDir\":\"/w\"}}\n\
                 {{\"sessionId\":\"session_abc\",\"sessionDir\":\"{0}\",\"workDir\":\"/w\"}}\n\
                 not json\n",
                session.display()
            ),
        )
        .unwrap();

        assert_eq!(transcript_path(TokenLog::KimiWireJsonl, root, "session_abc"), Some(main));
        assert_eq!(conversation_log_under(TokenLog::KimiWireJsonl, Some(root), "session_abc"), ConversationLog::Present);

        // An id the index does not name, an index naming a directory that
        // is gone, and no index at all all resolve to nothing.
        assert_eq!(transcript_path(TokenLog::KimiWireJsonl, root, "session_absent"), None);
        assert_eq!(conversation_log_under(TokenLog::KimiWireJsonl, Some(root), "session_absent"), ConversationLog::Missing);
        std::fs::write(
            root.join("session_index.jsonl"),
            format!("{{\"sessionId\":\"session_abc\",\"sessionDir\":\"{}\",\"workDir\":\"/w\"}}\n", root.join("gone").display()),
        )
        .unwrap();
        assert_eq!(transcript_path(TokenLog::KimiWireJsonl, root, "session_abc"), None);
        let bare = tempfile::tempdir().unwrap();
        assert_eq!(transcript_path(TokenLog::KimiWireJsonl, bare.path(), "session_abc"), None);
    }

    /// A run's cost is main's wire AND its subagents' wires -- they bill
    /// to the same account -- and `kimi_session_wires` is what gathers
    /// them from the one path the resolver returns.
    #[test]
    fn a_kimi_sessions_wires_are_main_and_its_subagents() {
        let dir = tempfile::tempdir().unwrap();
        let agents = dir.path().join("agents");
        std::fs::create_dir_all(agents.join("agent-0")).unwrap();
        std::fs::create_dir_all(agents.join("main")).unwrap();
        std::fs::write(agents.join("agent-0/wire.jsonl"), "{}").unwrap();
        let main = agents.join("main/wire.jsonl");
        std::fs::write(&main, "{}").unwrap();

        assert_eq!(kimi_session_wires(&main), vec![main.clone(), agents.join("agent-0/wire.jsonl")]);
        // A path that is not a wire in an agents directory answers itself.
        let odd = dir.path().join("wire.jsonl");
        assert_eq!(kimi_session_wires(&odd), vec![odd]);
    }

    /// The verified 2.1.1 shapes: one usage.record per LLM request (scope
    /// `turn`), summed; one turn.ended per turn, counted. agent.turn.ended
    /// fires alongside every turn.ended and must NOT count.
    #[test]
    fn kimi_usage_records_sum_across_requests_and_wires() {
        let usage = |agent: &str, input: u64, output: u64, cache_read: u64, cache_write: u64| {
            format!(
                r#"{{"type":"usage.record","agentId":"{agent}","model":"kimi-code/k3","usage":{{"inputOther":{input},"output":{output},"inputCacheRead":{cache_read},"inputCacheCreation":{cache_write}}},"usageScope":"turn","time":1791218535568}}"#
            )
        };
        let main_wire = [
            usage("main", 100, 10, 1000, 5),
            r#"{"type":"turn.ended","agentId":"main","turnId":0,"reason":"completed"}"#.to_string(),
            r#"{"turnId":0,"outcome":"done","type":"agent.turn.ended","kind":"event"}"#.to_string(),
            "not json".to_string(),
        ]
        .join("\n");
        let subagent_wire = [
            usage("agent-0", 200, 20, 2000, 0),
            r#"{"type":"turn.ended","agentId":"agent-0","turnId":0,"reason":"completed"}"#.to_string(),
        ]
        .join("\n");

        let report = kimi_totals(&format!("{main_wire}\n{subagent_wire}"));

        let t = totals(&report);
        assert_eq!(t.input_tokens, 300);
        assert_eq!(t.output_tokens, 30);
        assert_eq!(t.cache_read_tokens, 3000);
        assert_eq!(t.cache_write_tokens, 5);
        assert_eq!(t.total_tokens, 3335);
        assert_eq!(t.turns, 2, "turn.ended only -- agent.turn.ended duplicates it");
        match &report {
            TokenReport::Ready { models, .. } => assert_eq!(models, &vec!["kimi-code/k3".to_string()]),
            other => panic!("expected ready, got {other:?}"),
        }
    }

    /// Only scope `turn` is verified. Another scope added to the sum
    /// could be a cumulative row, which would double-count -- so it is
    /// skipped, and a wire with nothing else is Unavailable rather than a
    /// zero bill.
    #[test]
    fn kimi_skips_unverified_scopes_and_a_wire_with_no_usage_is_unavailable() {
        let text = [
            r#"{"type":"usage.record","usage":{"inputOther":999,"output":9},"usageScope":"session"}"#,
            r#"{"type":"turn.ended","agentId":"main"}"#,
        ]
        .join("\n");
        assert!(matches!(kimi_totals(&text), TokenReport::Unavailable { .. }));
        assert!(matches!(kimi_totals(r#"{"type":"turn.ended"}"#), TokenReport::Unavailable { .. }));
    }
}
