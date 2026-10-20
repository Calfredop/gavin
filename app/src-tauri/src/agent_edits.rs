//! Which of a checkout's changed files ONE run of a card touched, read out
//! of the agent CLI's own transcript.
//!
//! The Review tab's "touched files" used to be a `git diff` of the run's
//! checkout against the commit it launched on (`runchanges.rs`). That is
//! the right question for a run alone in its worktree and the wrong one
//! for a checkout several agents share: every card launched from the same
//! commit gets the same answer -- the whole dirty tree, everyone's work --
//! and the bound `next_baseline` adds only helps once somebody commits.
//! The transcript is the one record of what THIS agent did, so the tab
//! asks it which of the checkout's changed files are the run's.
//!
//! Two kinds of evidence, read the same way for every CLI:
//!
//!  - an EDIT-tool call names its file outright (Claude Code's `Edit`,
//!    kimi's `Write`, codex's `apply_patch` headers);
//!  - a SHELL command that may write names files in its text -- an agent
//!    edits through `sed -i`, a heredoc'd script or `git mv` as often as
//!    through its edit tool, and reading only the tools under-reported
//!    such a run by most of its files. A command made of nothing but
//!    readers (`cat`, `grep`, `sed -n`, `git diff`) is left out, so a
//!    file the agent only looked at is not claimed for it.
//!
//! The shell half is a heuristic and errs toward the run: a file a
//! command named is counted even when the command only read it. What it
//! cannot see is a file a command wrote WITHOUT naming it (a formatter
//! over the tree, a codegen step). Both are narrower misses than the
//! checkout diff's, which claimed every co-tenant's work -- and the caller
//! falls back to that diff whenever this has no answer at all.
//!
//! So a third kind of evidence replaces the heuristic wherever it exists:
//! what the CLI's own hook saw each shell call change (`gavin-mcp
//! shell-writes`, kept by the daemon, handed in as `observed`). It is per
//! CALL, matched by the id the call carries in the transcript and in the
//! hook alike. A command the hook watched is judged by its record alone
//! -- the files it changed, named or not, and none it only read; a command
//! it did not watch keeps the name heuristic, which is what a run from
//! before the hook, a Codex run (no hooks) and a command the hook judged
//! read-only all get, exactly as they did. The record's own blind spot is
//! the other side of a shared checkout: anything written by anyone while
//! a watched call ran is in that call's window (`shell_writes.rs` in
//! gavin-mcp).
//!
//! It reads the same files `agent_tokens` does, through the same
//! resolver, so a run whose cost can be read is a run whose edits can be.

use std::collections::{BTreeSet, HashSet};
use std::path::{Component, Path, PathBuf};

use protocol::shell_writes::{may_write, ShellWrites};

use crate::agent_setup::TokenLog;
use crate::agent_tokens::{kimi_session_wires, log_root, transcript_path};

/// What a read came back with. Two cases rather than `TokenReport`'s
/// three: the caller does the same thing for "this agent keeps no
/// transcript" and "this transcript is gone" -- falls back to the
/// checkout diff -- so a third tag would be a distinction nobody reads.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TouchReport {
    /// The candidates the run touched, in the order they were given.
    /// Empty is an answer: the transcript names none of them.
    Ready { paths: Vec<String> },
    Unavailable { reason: String },
}

/// Which of `candidates` the run behind `conversation_id` touched.
///
/// `candidates` are root-relative paths -- the checkout's changed files
/// as `run_changes` listed them, rename sources included -- so the answer
/// is a subset the caller filters by, never a path it has to reconcile.
/// `root` is that checkout's repository root. `cwd` is the run's LAUNCH
/// directory: kimi, codex and every shell command name files relative to
/// where the session ran.
///
/// No profile id: the conversation id is a uuid gavin minted, so the
/// first layout that holds it is the right one, and a card whose agent
/// was picked by its complexity level would otherwise be looked up under
/// the workspace's default profile and never found.
///
/// `observed` is what the daemon kept of the run's shell calls
/// (`Request::ShellWrites`), or nothing -- an older daemon, a run nothing
/// was recorded for -- which reads every command by its text, as before.
///
/// `async` + `spawn_blocking` for `card_run_tokens`'s reason: a whole
/// transcript read, once per listed card, when the Review tab opens.
#[tauri::command]
pub async fn card_run_touched_files(
    conversation_id: Option<String>,
    cwd: String,
    root: String,
    candidates: Vec<String>,
    observed: Option<ShellWrites>,
) -> Result<TouchReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        touched_files_blocking(conversation_id, &cwd, &root, candidates, &observed.unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())
}

fn touched_files_blocking(
    conversation_id: Option<String>,
    cwd: &str,
    root: &str,
    candidates: Vec<String>,
    observed: &ShellWrites,
) -> TouchReport {
    let Some(conversation_id) = conversation_id.map(|id| id.trim().to_string()).filter(|id| !id.is_empty())
    else {
        return TouchReport::Unavailable { reason: "gavin did not record a conversation id for this run".to_string() };
    };
    let Some((log, transcript)) = locate(&conversation_id) else {
        return TouchReport::Unavailable {
            reason: "the agent's transcript for this run is not on this machine".to_string(),
        };
    };
    let mut evidence = Evidence::default();
    for file in transcript_files(log, &transcript) {
        let Ok(text) = std::fs::read_to_string(&file) else {
            return TouchReport::Unavailable {
                reason: "the agent's transcript for this run could not be read".to_string(),
            };
        };
        match log {
            TokenLog::ClaudeSessionJsonl => claude_evidence(&text, &mut evidence),
            TokenLog::CodexRollout => codex_evidence(&text, &mut evidence),
            TokenLog::KimiWireJsonl => kimi_evidence(&text, &mut evidence),
        }
    }
    TouchReport::Ready { paths: touched(candidates, &evidence, observed, Path::new(cwd), Path::new(root)) }
}

/// The transcript holding this conversation, under whichever layout has
/// it. Claude and kimi first because both are a direct lookup (a readdir,
/// an index file); codex is a walk, and only a run neither holds pays it.
fn locate(conversation_id: &str) -> Option<(TokenLog, PathBuf)> {
    [TokenLog::ClaudeSessionJsonl, TokenLog::KimiWireJsonl, TokenLog::CodexRollout]
        .into_iter()
        .find_map(|log| Some((log, transcript_path(log, &log_root(log)?, conversation_id)?)))
}

/// Every transcript the run's agents wrote, given the conversation's own.
///
/// A subagent edits files too, and its calls are in ITS transcript, not
/// the parent's: Claude Code files them under
/// `<session id>/subagents/agent-*.jsonl` beside `<session id>.jsonl`,
/// kimi as sibling `agents/<agent>/wire.jsonl`s. Reading only the main
/// one would drop exactly the work a run delegated.
fn transcript_files(log: TokenLog, transcript: &Path) -> Vec<PathBuf> {
    match log {
        TokenLog::ClaudeSessionJsonl => {
            let mut files = vec![transcript.to_path_buf()];
            let subagents = transcript.with_extension("").join("subagents");
            if let Ok(entries) = std::fs::read_dir(&subagents) {
                let mut found: Vec<PathBuf> = entries
                    .flatten()
                    .map(|e| e.path())
                    .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
                    .collect();
                found.sort();
                files.extend(found);
            }
            files
        }
        TokenLog::KimiWireJsonl => kimi_session_wires(transcript),
        TokenLog::CodexRollout => vec![transcript.to_path_buf()],
    }
}

/// What a transcript says the run did to files.
#[derive(Default, Debug, PartialEq)]
pub struct Evidence {
    /// Paths an edit tool named, as the agent spelled them.
    pub edited: Vec<String>,
    /// Shell commands, whole, as the agent ran them.
    pub commands: Vec<ShellCommand>,
}

/// One shell command of the run.
#[derive(Debug, PartialEq)]
pub struct ShellCommand {
    /// The CLI's id for the call -- Claude Code's `tool_use` id, kimi's
    /// `toolCallId` -- which the shell-write hook records under too.
    /// `None` where the transcript carries none worth matching (codex,
    /// which has no hook).
    pub call_id: Option<String>,
    pub text: String,
}

/// Claude Code's edit tools and the input field each names its file in.
const CLAUDE_EDIT_TOOLS: &[(&str, &str)] =
    &[("Edit", "file_path"), ("MultiEdit", "file_path"), ("Write", "file_path"), ("NotebookEdit", "notebook_path")];

/// A Claude Code transcript's evidence: every `tool_use` block of an
/// `assistant` record whose tool is one of `CLAUDE_EDIT_TOOLS` or `Bash`.
///
/// A call that was refused or failed is still read. The transcript says
/// what the agent ASKED to do; whether it landed is what the caller's
/// candidates -- files that actually differ -- answer.
pub fn claude_evidence(text: &str, out: &mut Evidence) {
    for line in text.lines() {
        // Most of a transcript is tool output and prose; only a line that
        // carries a tool call is worth a parse.
        if !line.contains("\"tool_use\"") {
            continue;
        }
        let Ok(record) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if record.get("type").and_then(|v| v.as_str()) != Some("assistant") {
            continue;
        }
        let Some(blocks) = record.pointer("/message/content").and_then(|v| v.as_array()) else { continue };
        for block in blocks {
            if block.get("type").and_then(|v| v.as_str()) != Some("tool_use") {
                continue;
            }
            let name = block.get("name").and_then(|v| v.as_str()).unwrap_or_default();
            let input = block.get("input");
            if name == "Bash" {
                if let Some(command) = input.and_then(|i| i.get("command")).and_then(|v| v.as_str()) {
                    out.commands.push(ShellCommand {
                        call_id: block.get("id").and_then(|v| v.as_str()).map(str::to_string),
                        text: command.to_string(),
                    });
                }
                continue;
            }
            let Some((_, field)) = CLAUDE_EDIT_TOOLS.iter().find(|(tool, _)| *tool == name) else { continue };
            if let Some(path) = input.and_then(|i| i.get(*field)).and_then(|v| v.as_str()) {
                out.edited.push(path.to_string());
            }
        }
    }
}

/// kimi's edit tools. Both take `path`, relative to the session's
/// working directory or absolute.
const KIMI_EDIT_TOOLS: &[&str] = &["Edit", "Write"];

/// A kimi wire's evidence. A call is a `context.append_loop_event`
/// record whose `event` is a `tool.call` (measured on this machine's
/// wires, 2026-10-13); the same call echoed into `agent.message.appended`
/// records is not read.
pub fn kimi_evidence(text: &str, out: &mut Evidence) {
    for line in text.lines() {
        if !line.contains("\"tool.call\"") {
            continue;
        }
        let Ok(record) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let Some(event) = record.get("event") else { continue };
        if event.get("type").and_then(|v| v.as_str()) != Some("tool.call") {
            continue;
        }
        let name = event.get("name").and_then(|v| v.as_str()).unwrap_or_default();
        if name == "Bash" {
            if let Some(command) = event.pointer("/args/command").and_then(|v| v.as_str()) {
                out.commands.push(ShellCommand {
                    call_id: event.get("toolCallId").and_then(|v| v.as_str()).map(str::to_string),
                    text: command.to_string(),
                });
            }
        } else if KIMI_EDIT_TOOLS.contains(&name) {
            if let Some(path) = event.pointer("/args/path").and_then(|v| v.as_str()) {
                out.edited.push(path.to_string());
            }
        }
    }
}

/// A codex rollout's evidence.
///
/// codex writes files through `apply_patch`, and has carried the patch
/// three ways: a `custom_tool_call` whose `input` is the patch, a
/// `function_call` named `apply_patch` whose `arguments` hold it, and a
/// `shell` `function_call` whose command is `["apply_patch", <patch>]`.
/// All three put the same text somewhere in the call, so every string in
/// a call is read: one carrying a patch for its file headers, any other
/// as a shell command (`["bash", "-lc", "<command>"]` is three strings,
/// and only the last names files).
pub fn codex_evidence(text: &str, out: &mut Evidence) {
    for line in text.lines() {
        if !line.contains("\"response_item\"") {
            continue;
        }
        let Ok(record) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if record.get("type").and_then(|v| v.as_str()) != Some("response_item") {
            continue;
        }
        let Some(payload) = record.get("payload") else { continue };
        let kind = payload.get("type").and_then(|v| v.as_str()).unwrap_or_default();
        if kind != "function_call" && kind != "custom_tool_call" && kind != "local_shell_call" {
            continue;
        }
        let mut strings = Vec::new();
        for field in ["input", "arguments", "action"] {
            match payload.get(field) {
                Some(serde_json::Value::String(raw)) => match serde_json::from_str::<serde_json::Value>(raw) {
                    Ok(parsed) => collect_strings(&parsed, &mut strings),
                    Err(_) => strings.push(raw.clone()),
                },
                Some(value) => collect_strings(value, &mut strings),
                None => {}
            }
        }
        for string in strings {
            if string.contains("*** Begin Patch") {
                out.edited.extend(patch_files(&string));
            } else {
                out.commands.push(ShellCommand { call_id: None, text: string });
            }
        }
    }
}

fn collect_strings(value: &serde_json::Value, out: &mut Vec<String>) {
    match value {
        serde_json::Value::String(s) => out.push(s.clone()),
        serde_json::Value::Array(items) => items.iter().for_each(|v| collect_strings(v, out)),
        serde_json::Value::Object(map) => map.values().for_each(|v| collect_strings(v, out)),
        _ => {}
    }
}

/// The files one `apply_patch` envelope names: added, updated, deleted,
/// and the destination of a move.
fn patch_files(patch: &str) -> Vec<String> {
    const HEADERS: &[&str] = &["*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: "];
    patch
        .lines()
        .filter_map(|line| HEADERS.iter().find_map(|h| line.strip_prefix(h)))
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty())
        .collect()
}

/// The path-shaped words in a shell command: runs of characters a path
/// is spelled with, holding a `/` or a `.` and not an option.
fn path_words(command: &str) -> impl Iterator<Item = &str> {
    command
        .split(|c: char| !(c.is_alphanumeric() || matches!(c, '/' | '.' | '_' | '-' | '+' | '@' | '~')))
        .filter(|w| !w.is_empty() && !w.starts_with('-') && (w.contains('/') || w.contains('.')))
        .filter(|w| w.chars().any(|c| c.is_alphanumeric()))
}

/// Which `candidates` the evidence names.
///
/// A candidate is the run's when an edit tool or a writing command named
/// it -- resolved against the launch directory, or absolute -- or when a
/// writing command named a relative path of two or more segments that
/// the candidate ENDS with. The second rule is for an agent that `cd`'d
/// first (`cd app && sed -i ... src/lib/x.ts`): the command does not say
/// where it ran from, and a two-segment tail is specific enough not to
/// match a stranger. A bare name never gets that latitude -- `lib.rs` is
/// in every crate.
///
/// A command whose call the hook watched (`observed.calls`) is not read
/// by those rules at all: what the watched calls wrote (`observed.files`)
/// stands for it, resolved like an edit tool's absolute path.
pub fn touched(
    candidates: Vec<String>,
    evidence: &Evidence,
    observed: &ShellWrites,
    cwd: &Path,
    root: &Path,
) -> Vec<String> {
    let watched: HashSet<&str> = observed.calls.iter().map(String::as_str).collect();
    let writing: Vec<&str> = evidence
        .commands
        .iter()
        .filter(|c| !c.call_id.as_deref().is_some_and(|id| watched.contains(id)))
        .map(|c| c.text.as_str())
        .filter(|c| may_write(c))
        .collect();
    // Deduped before anything touches the disk: a long run names the same
    // few files in hundreds of commands, and each word costs a resolve.
    let words: BTreeSet<&str> = writing.iter().flat_map(|c| path_words(c)).collect();
    let recorded: Vec<String> = observed
        .files
        .iter()
        .flat_map(|f| f.paths.iter().map(|p| Path::new(&f.root).join(p).to_string_lossy().into_owned()))
        .collect();
    let exact = under_root(
        evidence
            .edited
            .iter()
            .map(String::as_str)
            .chain(words.iter().copied())
            .chain(recorded.iter().map(String::as_str)),
        cwd,
        root,
    );
    let tails: BTreeSet<String> = words
        .iter()
        .filter(|w| !w.starts_with('/') && !w.starts_with('~'))
        .filter_map(|w| {
            let parts: Vec<&str> = w.split('/').filter(|p| !p.is_empty() && *p != ".").collect();
            (parts.len() >= 2 && !parts.contains(&"..")).then(|| parts.join("/"))
        })
        .collect();
    candidates
        .into_iter()
        .filter(|c| exact.contains(c) || tails.iter().any(|t| c == t || c.ends_with(&format!("/{t}"))))
        .collect()
}

/// `paths` as root-relative `/`-separated strings, with everything
/// outside `root` dropped.
///
/// Both sides are resolved through the filesystem, because the strings
/// an agent writes and the root git reports are not spelled alike: git
/// answers `--show-toplevel` with symlinks resolved (`/private/tmp/...`
/// on macOS), an agent writes whatever path it was handed (`/tmp/...`).
/// A file the run deleted no longer resolves, so its nearest existing
/// ancestor is resolved instead and the rest re-attached.
fn under_root<'a>(paths: impl Iterator<Item = &'a str>, cwd: &Path, root: &Path) -> BTreeSet<String> {
    let root = resolve(root);
    let mut out = BTreeSet::new();
    for path in paths {
        let path = Path::new(path);
        let absolute = if path.is_absolute() { path.to_path_buf() } else { cwd.join(path) };
        let Ok(relative) = resolve(&absolute).strip_prefix(&root).map(Path::to_path_buf) else { continue };
        let parts: Vec<String> = relative
            .components()
            .filter_map(|c| match c {
                Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
                _ => None,
            })
            .collect();
        if !parts.is_empty() {
            out.insert(parts.join("/"));
        }
    }
    out
}

/// `path` with `.` and `..` folded, then canonicalized as far as it
/// exists on disk.
fn resolve(path: &Path) -> PathBuf {
    let mut lexical = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                lexical.pop();
            }
            other => lexical.push(other),
        }
    }
    let mut existing = lexical.as_path();
    let mut rest: Vec<&std::ffi::OsStr> = Vec::new();
    loop {
        if let Ok(real) = std::fs::canonicalize(existing) {
            return rest.iter().rev().fold(real, |acc, part| acc.join(part));
        }
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name);
                existing = parent;
            }
            _ => return lexical,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn evidence(edited: &[&str], commands: &[&str]) -> Evidence {
        Evidence {
            edited: edited.iter().map(|s| s.to_string()).collect(),
            commands: commands.iter().map(|s| ShellCommand { call_id: None, text: s.to_string() }).collect(),
        }
    }

    fn command(call_id: &str, text: &str) -> ShellCommand {
        ShellCommand { call_id: Some(call_id.to_string()), text: text.to_string() }
    }

    fn nothing_observed() -> ShellWrites {
        ShellWrites::default()
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn claude_edit_tools_and_shell_commands_are_read_and_every_other_tool_is_not() {
        let text = [
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/r/a.ts","old_string":"x","new_string":"y"}}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hi"},{"type":"tool_use","name":"Write","input":{"file_path":"/r/b.ts","content":""}},{"type":"tool_use","name":"Read","input":{"file_path":"/r/c.ts"}}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"NotebookEdit","input":{"notebook_path":"/r/n.ipynb"}}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_9","name":"Bash","input":{"command":"sed -i '' x d.ts"}}]}}"#,
            // A tool RESULT quoting an edit call is a user record, not a call.
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"\"tool_use\" Edit /r/e.ts"}]}}"#,
        ]
        .join("\n");
        let mut out = Evidence::default();
        claude_evidence(&text, &mut out);
        assert_eq!(out.edited, strings(&["/r/a.ts", "/r/b.ts", "/r/n.ipynb"]));
        assert_eq!(out.commands, [command("toolu_9", "sed -i '' x d.ts")]);
    }

    #[test]
    fn kimi_calls_are_read_from_loop_events_only() {
        let text = [
            r#"{"type":"context.append_loop_event","agentId":"main","event":{"type":"tool.call","name":"Edit","args":{"path":"src/a.rs","old_string":"x","new_string":"y"}}}"#,
            r#"{"type":"context.append_loop_event","agentId":"main","event":{"type":"tool.call","name":"Write","args":{"path":"/abs/b.rs","content":""}}}"#,
            r#"{"type":"context.append_loop_event","agentId":"main","event":{"type":"tool.call","name":"Read","args":{"path":"src/c.rs"}}}"#,
            r#"{"type":"context.append_loop_event","agentId":"main","event":{"type":"tool.call","toolCallId":"tool_7","name":"Bash","args":{"command":"rm src/d.rs"}}}"#,
            r#"{"type":"agent.message.appended","message":{"content":"tool.call Edit src/e.rs"}}"#,
        ]
        .join("\n");
        let mut out = Evidence::default();
        kimi_evidence(&text, &mut out);
        assert_eq!(out.edited, strings(&["src/a.rs", "/abs/b.rs"]));
        assert_eq!(out.commands, [command("tool_7", "rm src/d.rs")]);
    }

    #[test]
    fn codex_patches_are_read_in_every_shape_the_call_has_carried_them() {
        let patch = "*** Begin Patch\n*** Update File: src/a.rs\n@@\n-x\n+y\n*** Add File: src/new.rs\n+z\n*** Delete File: src/old.rs\n*** Update File: src/from.rs\n*** Move to: src/to.rs\n*** End Patch";
        let custom = serde_json::json!({"type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","input":patch}});
        let function = serde_json::json!({"type":"response_item","payload":{"type":"function_call","name":"apply_patch",
            "arguments": serde_json::json!({"input": "*** Begin Patch\n*** Update File: lib/f.rs\n*** End Patch"}).to_string()}});
        let shell = serde_json::json!({"type":"response_item","payload":{"type":"function_call","name":"shell",
            "arguments": serde_json::json!({"command": ["bash", "-lc", "mv a.rs b.rs"]}).to_string()}});
        // The model's own message quoting a patch is not a call.
        let message = serde_json::json!({"type":"response_item","payload":{"type":"message","content":[{"type":"output_text","text":"*** Begin Patch\n*** Update File: no.rs"}]}});
        let text = [custom, function, shell, message].map(|v| v.to_string()).join("\n");
        let mut out = Evidence::default();
        codex_evidence(&text, &mut out);
        assert_eq!(
            out.edited,
            strings(&["src/a.rs", "src/new.rs", "src/old.rs", "src/from.rs", "src/to.rs", "lib/f.rs"])
        );
        assert!(out.commands.contains(&ShellCommand { call_id: None, text: "mv a.rs b.rs".to_string() }));
    }

    #[test]
    fn candidates_are_kept_by_what_the_run_named_and_nothing_else() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(root.join("app/src/lib")).unwrap();
        std::fs::write(root.join("app/src/lib/a.ts"), "").unwrap();
        let candidates = strings(&[
            "app/src/lib/a.ts",      // an edit tool, absolute
            "app/src/lib/gone.ts",   // deleted by a shell command, relative to the launch cwd
            "app/src/lib/moved.ts",  // a command run after `cd app/src`
            "crates/x/src/lib.rs",   // a bare `lib.rs` named elsewhere
            "app/src/lib/read.ts",   // only read
            "app/src/lib/other.ts",  // a co-tenant's
            "README.md",             // a redirect into it
        ]);
        let evidence = evidence(
            &[&root.join("app/src/lib/a.ts").to_string_lossy()],
            &[
                "rm app/src/lib/gone.ts",
                "cd app/src && git mv lib/was.ts lib/moved.ts",
                "sed -i '' s/x/y/ lib.rs",
                "cat app/src/lib/read.ts",
                "echo hi >> README.md",
            ],
        );
        assert_eq!(
            touched(candidates, &evidence, &nothing_observed(), &root, &root),
            strings(&["app/src/lib/a.ts", "app/src/lib/gone.ts", "app/src/lib/moved.ts", "README.md"])
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_spelling_of_the_root_still_matches() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("a.ts"), "").unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let evidence = evidence(&[&link.join("a.ts").to_string_lossy()], &[]);
        assert_eq!(touched(strings(&["a.ts"]), &evidence, &nothing_observed(), &link, &real), strings(&["a.ts"]));
    }

    /// The card's two cases at once. A formatter run through npm names no
    /// file and wrote two; a `sed -i` through a script names none either. A
    /// `cat` the hook never watched (read-only, no snapshot) names one and
    /// is still judged by its text -- which credits it with nothing. And a
    /// watched command that NAMES a file it only read is not credited
    /// with it: its record says what it changed.
    #[test]
    fn a_watched_command_is_judged_by_its_record_and_an_unwatched_one_by_its_text() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(root.join("src")).unwrap();
        let candidates = strings(&[
            "src/formatted.ts", // the formatter's, named nowhere
            "src/scripted.ts",  // the script's `sed -i`, named nowhere
            "src/read.ts",      // only read, by `cat` and by the script
            "src/named.ts",     // named by an UNWATCHED writing command
            "src/neighbour.ts", // a co-tenant's
        ]);
        let evidence = Evidence {
            edited: vec![],
            commands: vec![
                command("toolu_1", "npm run format"),
                command("toolu_2", "./fix.sh src/read.ts"),
                command("toolu_3", "cat src/read.ts"),
                // A run from before the hook, or a call it missed.
                command("toolu_4", "sed -i '' s/a/b/ src/named.ts"),
            ],
        };
        let observed = ShellWrites {
            calls: strings(&["toolu_1", "toolu_2"]),
            files: vec![protocol::shell_writes::RootFiles {
                root: root.to_string_lossy().into_owned(),
                paths: strings(&["src/formatted.ts", "src/scripted.ts"]),
            }],
        };
        assert_eq!(
            touched(candidates, &evidence, &observed, &root, &root),
            strings(&["src/formatted.ts", "src/scripted.ts", "src/named.ts"])
        );
    }

    /// A run with no records reads exactly as it did before the hook: the
    /// same candidates, by the same rules.
    #[test]
    fn a_run_with_no_records_reads_as_it_always_did() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let evidence = Evidence {
            edited: vec![],
            commands: vec![command("toolu_1", "sed -i '' x a.ts"), command("toolu_2", "cat b.ts")],
        };
        assert_eq!(
            touched(strings(&["a.ts", "b.ts"]), &evidence, &nothing_observed(), &root, &root),
            strings(&["a.ts"])
        );
    }

    /// Records under another checkout -- a worktree of the same run, a
    /// sibling repository -- are not this checkout's files, whatever
    /// their relative paths say.
    #[test]
    fn a_record_under_another_root_is_not_this_checkouts() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        let other = dir.path().join("worktree");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let observed = ShellWrites {
            calls: strings(&["toolu_1"]),
            files: vec![protocol::shell_writes::RootFiles {
                root: other.to_string_lossy().into_owned(),
                paths: strings(&["a.ts"]),
            }],
        };
        let evidence = Evidence { edited: vec![], commands: vec![command("toolu_1", "npm run format")] };
        assert!(touched(strings(&["a.ts"]), &evidence, &observed, &root, &root).is_empty());
    }

    #[test]
    fn a_run_with_no_conversation_id_is_unavailable() {
        let none = nothing_observed();
        assert!(matches!(touched_files_blocking(None, "/", "/", vec![], &none), TouchReport::Unavailable { .. }));
        assert!(matches!(
            touched_files_blocking(Some("  ".into()), "/", "/", vec![], &none),
            TouchReport::Unavailable { .. }
        ));
    }

    /// What the frontend hands back is what the host's `shell_writes`
    /// command gave it, in its camelCase.
    #[test]
    fn the_observed_records_arrive_in_the_shape_the_frontend_sends() {
        let observed: ShellWrites =
            serde_json::from_value(serde_json::json!({"calls": ["t"], "files": [{"root": "/r", "paths": ["a"]}]}))
                .unwrap();
        assert_eq!(observed.calls, ["t"]);
        assert_eq!(observed.files[0].paths, ["a"]);
    }

    #[test]
    fn a_report_serializes_to_the_shape_the_frontend_switches_on() {
        let ready = serde_json::to_value(TouchReport::Ready { paths: vec!["a".into()] }).unwrap();
        assert_eq!(ready, serde_json::json!({"kind": "ready", "paths": ["a"]}));
        let gone = serde_json::to_value(TouchReport::Unavailable { reason: "r".into() }).unwrap();
        assert_eq!(gone, serde_json::json!({"kind": "unavailable", "reason": "r"}));
    }
}
