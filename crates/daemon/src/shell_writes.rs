//! The shell-write hook on a Claude Code launch
//! (`feat-touched-files-shell-hook.md`).
//!
//! Claude Code runs `gavin-mcp shell-writes` around every `Bash` call only
//! if its settings say so, and the settings this adds are the launch's own:
//! `--settings '<hooks>'` on the command line, which Claude Code merges
//! with the human's settings files rather than replacing them. Added here,
//! at spawn, for the reason Headroom's recipes are: every launch passes
//! through `create_session_as` -- a card, a rail step, a Best-of-N copy, a
//! resume, a session another agent spawned over MCP -- and the registry
//! keeps the line that was asked for, so a relaunch is decided afresh.
//!
//! kimi needs none of this: its hooks live in its own `config.toml`, which
//! the app writes when it prepares a kimi launch.

use crate::headroom::compress::{command_words, names_binary, single_quoted, Agent, Launch};

/// `line` with Claude Code's hook settings after every command word that
/// runs the `claude` binary, or `None` when it is left as it is:
///
/// - the launch is not Claude Code's;
/// - there is no gavin-mcp beside this daemon (`mcp_beside`), so the
///   hook would find no `$GAVIN_SHELL_WRITES` and do nothing on every
///   call;
/// - the line already passes `--settings` anywhere: Claude Code keeps one
///   such flag, and the human's is the one that stands -- their run goes
///   unobserved and keeps the transcript's reading;
/// - Windows, where how Claude Code runs a hook line has not been
///   verified, and a hook that failed would be printed on every call;
/// - a line `command_words` cannot read, or one that runs no `claude`.
///
/// After the binary word, never at the end: the end of a line gavin
/// composes is its prompt.
pub fn with_claude_hooks(line: &str, launch: Launch, mcp_beside: bool) -> Option<String> {
    if cfg!(windows) || !mcp_beside || launch.agent() != Some(Agent::ClaudeCode) || line.contains("--settings") {
        return None;
    }
    let ends: Vec<usize> = command_words(line)?
        .into_iter()
        .filter(|(_, word)| names_binary(word, "claude"))
        .map(|(end, _)| end)
        .collect();
    if ends.is_empty() {
        return None;
    }
    let flag = format!(" --settings {}", single_quoted(&protocol::shell_writes::claude_settings()));
    let mut out = line.to_string();
    for end in ends.into_iter().rev() {
        out.insert_str(end, &flag);
    }
    Some(out)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn flag() -> String {
        format!(" --settings {}", single_quoted(&protocol::shell_writes::claude_settings()))
    }

    #[test]
    fn a_claude_launch_gets_the_hook_settings_right_after_its_binary() {
        let line = "claude --model opus --session-id 0b5e 'do it'";
        assert_eq!(
            with_claude_hooks(line, Launch::Profile("claude-code"), true).unwrap(),
            format!("claude{} --model opus --session-id 0b5e 'do it'", flag())
        );
        // By path, behind an assignment, and a resume.
        assert_eq!(
            with_claude_hooks("FOO=1 /opt/bin/claude --resume 0b5e", Launch::Profile("claude-code"), true).unwrap(),
            format!("FOO=1 /opt/bin/claude{} --resume 0b5e", flag())
        );
        // A session another agent spawned, judged by its line.
        assert_eq!(
            with_claude_hooks("claude 'x'", Launch::Command("claude 'x'"), true).unwrap(),
            format!("claude{} 'x'", flag())
        );
    }

    #[test]
    fn the_settings_reach_claude_as_one_word_holding_the_whole_document() {
        let line = with_claude_hooks("claude 'p'", Launch::Profile("claude-code"), true).unwrap();
        let out = crate::program::command("sh")
            .args(["-c", &line.replacen("claude", "printf '%s\\n'", 1)])
            .output()
            .unwrap();
        let words: Vec<String> = String::from_utf8(out.stdout).unwrap().lines().map(str::to_string).collect();
        assert_eq!(words, ["--settings", &protocol::shell_writes::claude_settings(), "p"]);
    }

    #[test]
    fn everything_else_is_left_alone() {
        for (line, launch, mcp) in [
            // Not Claude Code.
            ("codex 'x'", Launch::Profile("codex"), true),
            ("kimi", Launch::Profile("kimi-code"), true),
            ("claude 'x'", Launch::Shell, true),
            ("claude 'x'", Launch::Profile("my-own-agent"), true),
            // No gavin-mcp for the hook to run.
            ("claude 'x'", Launch::Profile("claude-code"), false),
            // The human's own settings stand.
            ("claude --settings mine.json 'x'", Launch::Profile("claude-code"), true),
            // A line that runs no claude, or one too odd to read.
            ("my-wrapper 'claude'", Launch::Profile("claude-code"), true),
            ("cat <<EOF\nclaude\nEOF", Launch::Profile("claude-code"), true),
        ] {
            assert_eq!(with_claude_hooks(line, launch, mcp), None, "{line}");
        }
    }
}
