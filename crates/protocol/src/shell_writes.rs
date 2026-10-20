//! What one shell call of an agent actually wrote, as the agent CLI's own
//! hooks see it (`feat-touched-files-shell-hook.md`).
//!
//! The Review tab reads which of a checkout's changed files a run touched
//! out of the run's transcript (`agent_edits.rs` in the app host). An edit
//! tool names its file outright; a shell command only says what it RAN,
//! so the transcript can only guess which files it wrote from the paths
//! its text names -- missing a formatter or a script that names none, and
//! crediting a file a writing command only read. The hooks close that
//! gap: around each shell call the CLI runs `gavin-mcp shell-writes`,
//! which lists the checkout's dirty files with their modification times
//! before the call and again after it, and records the difference with
//! the daemon under the conversation and the call.
//!
//! What this module holds is what more than one crate spells: the
//! subcommand and the hook commands that run it (written by the daemon
//! into a Claude Code launch, by the app into kimi's config), and
//! `may_write`, which both the hook (to skip the snapshot for a command
//! that plainly writes nothing) and the transcript reader (to decide
//! which commands' paths count) apply. One table, so a command the hook
//! leaves unobserved is exactly one the reader judges unwriting.
//!
//! Pure: no environment, filesystem or process here, so the crate still
//! checks for `wasm32-unknown-unknown` without the `os` feature.

/// `gavin-mcp shell-writes <phase>`: the hook, not the MCP server.
pub const SUBCOMMAND: &str = "shell-writes";

/// Before the shell call: take the snapshot.
pub const PRE: &str = "pre";

/// After it, whether it succeeded or failed: diff and record.
pub const POST: &str = "post";

/// The environment variable that names the gavin-mcp the hook hands a
/// call to: the one beside the daemon hosting this session, set on every
/// PTY a daemon of v72 or later opens (`PtySession::spawn`).
///
/// Its own variable, not the `GAVIN_MCP` beside it that names the same
/// file, because its PRESENCE is the promise that this gavin-mcp has the
/// subcommand. kimi's hooks live in one `config.toml` that every build on
/// the machine reads; a kimi launched by an older daemon -- the release
/// install beside a dev tree -- has a `GAVIN_MCP` whose binary would take
/// `shell-writes pre` for an MCP session and answer the hook's JSON. It
/// has no `GAVIN_SHELL_WRITES`, so the hook does nothing there, as it does
/// anywhere outside a gavin tab.
pub const HOOK_BINARY_ENV: &str = "GAVIN_SHELL_WRITES";

/// The shell line a CLI hook runs for `phase`.
///
/// A variable rather than a path: the daemon hosting the tab already says
/// which build's gavin-mcp is its own, so nothing build-specific is
/// written into any config, and two builds' sessions each reach their own
/// daemon. When the variable is unset or names nothing executable the
/// line still drains the CLI's JSON from stdin and succeeds -- a hook
/// that failed would be shown to the human on every shell call, and one
/// that left stdin unread could stall a CLI writing a large payload.
pub fn hook_command(phase: &str) -> String {
    format!(
        "[ -x \"${HOOK_BINARY_ENV}\" ] && exec \"${HOOK_BINARY_ENV}\" {SUBCOMMAND} {phase}; cat >/dev/null; exit 0"
    )
}

/// Seconds a CLI gives the hook before abandoning it. The hook takes two
/// `git status` runs at most (~30 ms each on gavin's own tree); the bound
/// is for a checkout so large that a scan is slow, where the call must go
/// ahead unobserved rather than wait.
pub const HOOK_TIMEOUT_SECS: u32 = 10;

/// The Claude Code tool whose calls are observed.
pub const CLAUDE_SHELL_TOOL: &str = "Bash";

/// The `--settings` document a Claude Code launch is given: the hook
/// before every `Bash` call, and after it on both outcomes -- a command
/// that exits non-zero fires `PostToolUseFailure` and not `PostToolUse`
/// (measured against 2.1.296), and a failing `npm run format` has still
/// rewritten files.
///
/// Settings passed this way are merged with every other source rather
/// than replacing them (measured: a project file's `PreToolUse` hook and
/// this one both ran for the same call), so the human's own hooks run as
/// before.
pub fn claude_settings() -> String {
    let entry = |phase: &str| {
        serde_json::json!([{
            "matcher": CLAUDE_SHELL_TOOL,
            "hooks": [{ "type": "command", "command": hook_command(phase), "timeout": HOOK_TIMEOUT_SECS }],
        }])
    };
    serde_json::json!({
        "hooks": {
            "PreToolUse": entry(PRE),
            "PostToolUse": entry(POST),
            "PostToolUseFailure": entry(POST),
        }
    })
    .to_string()
}

/// Programs that only read. A command built of nothing else -- and no
/// output redirect -- names files it looked at, not files it wrote.
const READERS: &[&str] = &[
    "cat", "head", "tail", "less", "grep", "egrep", "rg", "ls", "wc", "nl", "sort", "uniq", "cut", "tr",
    "echo", "printf", "cd", "pwd", "which", "file", "stat", "diff", "jq", "true", "test", "[",
];

/// git subcommands that only read.
const GIT_READERS: &[&str] = &["diff", "log", "show", "status", "ls-files", "grep", "blame", "rev-parse", "cat-file"];

/// Whether a shell command could have written a file. Errs toward yes:
/// anything not plainly a reader counts. For the transcript reader the
/// cost of a wrong yes is one file that was only read being listed
/// against a run that named it; for the hook it is one snapshot taken
/// for nothing.
pub fn may_write(command: &str) -> bool {
    // Quoted text is an argument, never a pipe or a redirect: the `|` in
    // `grep "a|b"` would otherwise make `b` a program that might write.
    // Redirects into the void or between descriptors write nothing.
    let mut stripped = unquoted(command);
    for harmless in ["2>&1", "1>&2", ">&2", "&>/dev/null", "2>/dev/null", ">/dev/null", "> /dev/null"] {
        stripped = stripped.replace(harmless, " ");
    }
    if stripped.contains('>') {
        return true;
    }
    stripped
        .split(['\n', ';', '|', '&', '(', ')'])
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .any(|segment| !reads_only(segment))
}

/// `command` with every quoted span blanked to `''`, so what is left is
/// the shell's own syntax. An unclosed quote blanks the rest.
fn unquoted(command: &str) -> String {
    let mut out = String::with_capacity(command.len());
    let mut chars = command.chars();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                out.push_str("''");
                for q in chars.by_ref() {
                    if q == '\'' {
                        break;
                    }
                }
            }
            '"' => {
                out.push_str("''");
                while let Some(q) = chars.next() {
                    match q {
                        '\\' => {
                            chars.next();
                        }
                        '"' => break,
                        _ => {}
                    }
                }
            }
            _ => out.push(c),
        }
    }
    out
}

fn reads_only(segment: &str) -> bool {
    let mut words = segment.split_whitespace().skip_while(|w| w.contains('=') && !w.starts_with('-'));
    let Some(program) = words.next() else { return true };
    let program = program.rsplit('/').next().unwrap_or(program);
    let rest: Vec<&str> = words.collect();
    match program {
        "git" => rest.iter().find(|w| !w.starts_with('-')).is_some_and(|sub| GIT_READERS.contains(sub)),
        "sed" | "perl" => !rest.iter().any(|w| w.starts_with("-i")),
        "find" => !rest.iter().any(|w| matches!(*w, "-delete" | "-exec" | "-execdir" | "-ok")),
        "awk" => true,
        _ => READERS.contains(&program),
    }
}

/// What the daemon kept for one conversation's shell calls
/// (`Request::ShellWrites`).
///
/// Not a row per call. A reader needs two things -- which calls were
/// watched, so their commands are not guessed about, and what the watched
/// calls wrote -- and a long run repeats the same files across hundreds
/// of calls; folded this way the answer grows with the files a run wrote,
/// not with how often it wrote them, and stays under `MAX_LINE_BYTES`.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellWrites {
    /// The CLI's id for every call the hook watched: Claude Code's
    /// `tool_use_id`, kimi's `tool_call_id` -- the id the call carries in
    /// the transcript too. A watched call that wrote nothing is here and
    /// adds nothing to `files`, which is the answer for it.
    pub calls: Vec<String>,
    /// What the watched calls wrote, per repository root, each path once.
    pub files: Vec<RootFiles>,
}

/// Paths under one repository root, relative to it, `/`-separated as git
/// prints them.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootFiles {
    /// The root as the hook found it from the call's working directory.
    pub root: String,
    pub paths: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_command_of_readers_alone_writes_nothing() {
        for command in [
            "cat a.ts",
            "sed -n 1,20p src/a.ts | head",
            "cd app && grep -rn foo src/lib/x.ts 2>&1 | tail -5",
            "git diff --stat src/a.ts; git log -1",
            "find . -name '*.rs' | wc -l",
            "FOO=1 rg bar src/a.ts >/dev/null",
            r#"cat x.md && grep -rniE "a|b_c" --include=*.ts . | grep -v "x>y" | head"#,
        ] {
            assert!(!may_write(command), "{command}");
        }
        for command in [
            "sed -i '' s/a/b/ src/a.ts",
            "echo x > src/a.ts",
            "python3 - <<'EOF'\nopen('src/a.ts','w')\nEOF",
            "git mv a.ts b.ts",
            "cd app && npm run format",
            "find . -name x -delete",
            "cat a | tee b.ts",
        ] {
            assert!(may_write(command), "{command}");
        }
    }

    #[test]
    fn the_hook_line_runs_the_subcommand_only_where_a_daemon_named_its_gavin_mcp() {
        assert_eq!(
            hook_command(PRE),
            r#"[ -x "$GAVIN_SHELL_WRITES" ] && exec "$GAVIN_SHELL_WRITES" shell-writes pre; cat >/dev/null; exit 0"#
        );
    }

    #[test]
    fn claude_settings_hook_bash_before_and_after_on_both_outcomes() {
        let doc: serde_json::Value = serde_json::from_str(&claude_settings()).unwrap();
        let hooks = doc["hooks"].as_object().unwrap();
        let mut events: Vec<&str> = hooks.keys().map(String::as_str).collect();
        events.sort_unstable();
        assert_eq!(events, ["PostToolUse", "PostToolUseFailure", "PreToolUse"]);
        for (event, phase) in [("PreToolUse", PRE), ("PostToolUse", POST), ("PostToolUseFailure", POST)] {
            let entry = &hooks[event][0];
            assert_eq!(entry["matcher"], "Bash");
            assert_eq!(entry["hooks"][0]["type"], "command");
            assert_eq!(entry["hooks"][0]["command"], hook_command(phase));
            assert_eq!(entry["hooks"][0]["timeout"], HOOK_TIMEOUT_SECS);
        }
        // One line: it rides a shell command as a single quoted word.
        assert!(!claude_settings().contains('\n'));
    }

    #[test]
    fn the_record_crosses_to_the_frontend_in_camel_case() {
        let writes = ShellWrites {
            calls: vec!["t".into()],
            files: vec![RootFiles { root: "/r".into(), paths: vec!["a".into()] }],
        };
        assert_eq!(
            serde_json::to_value(&writes).unwrap(),
            serde_json::json!({"calls": ["t"], "files": [{"root": "/r", "paths": ["a"]}]})
        );
    }
}
