---
kind: task
title: "[sec] Daemon and app write kimi folder trust for any .mcp.json whose entry is merely named `gavin`, whatever command it runs"
status: To Do
priority: medium
complexity: moderate
---
Fix a medium-severity finding from the 2026-10-15 security audit (run-1). Fingerprint: `crates/protocol/src/kimi_trust.rs:declares_only_gavins:name-only-gavin-entry`.

Full record: `findings.json` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

Before a kimi launch in a folder strictly inside a workspace, gavin writes kimi's workspace-trust record for the launch cwd. The daemon does this for an agent's gavin_spawn_session (server.rs:4210 -> kimi_trust::prepare_spawn), and the app does it for every create_session launch (agent_setup::prepare_kimi_launch). That record is kimi's own gate before it starts a folder's project MCP servers: the installed kimi bundle loads `<git work tree root>/.mcp.json` only when `includeProject: this.trust.isTrusted()`, and it resolves a linked worktree's `.git` file to that worktree as the project root. The shared rule protocol::kimi_trust::launch_grant vets the root's .mcp.json and a gavin worktree's own .mcp.json through declares_only_gavins, which counts every server keyed `gavin` as gavin's own (`s.name == "gavin" || ...`) and never compares its command or args. On the daemon path own_command is None; on the app path Some(own_command) narrows only the `playwright` entry. A cloned repository that commits .mcp.json with a `gavin` entry running an arbitrary command therefore gets each .gavin-worktrees checkout (rail, Best-of-N, an agent's spawn) trusted for kimi with no prompt, even after Integration rewrote the root's working copy, because nothing on the launch path rewrites the worktree's committed file. The same holds for a context folder below a root whose working copy still carries the repo's `gavin` entry. Kimi then starts that command as the user at session start. No surface shows the entry to the human: the Integration foreign-MCP scan drops the `gavin` key by name, trustedConfigHash digests only config.toml execution keys, and the first-run review digests card content. The threat model (AD-3) does not accept a repo-shipped MCP config reaching an agent unread, and docs/security/03-agent-surface.md promises the worktree's file may declare nothing but gavin's own entries.

## Root cause

protocol::kimi_trust::declares_only_gavins (crates/protocol/src/kimi_trust.rs:227-236) identifies gavin's MCP entry by the key name `gavin` alone (line 229), so an entry the repository committed under that name passes as gavin's own when launch_grant decides to write kimi's trust record. The daemon passes own_command None (crates/daemon/src/kimi_trust.rs:114), and even the app's Some(own_command) is applied only to the `playwright` entry.

## The invariant to enforce

A per-launch kimi trust record is written only when every project MCP server kimi will start from the launch cwd is one gavin itself wrote: the `gavin` entry must run gavin's own resolved, absolute gavin-mcp with gavin's own args, exactly as the Playwright entry is already compared. A `gavin`-keyed entry running anything else must withhold the grant so kimi shows its own trust prompt, or be disclosed to the human like any other foreign server.

## Trace (lines as of 2026-10-16; re-read before editing)

- `crates/daemon/src/server.rs:7383` (agent_allows Request::SpawnAgentSession): An agent may spawn a command whose cwd is inside its own workspace scope, including a .gavin-worktrees checkout. The app's create_session path (app/src-tauri/src/agent_setup.rs:2924 prepare_kimi_launch) reaches the same rule for board runs, rails and Best-of-N. Cited at 7381 by the hunter; now 7383, same code.
- `crates/daemon/src/server.rs:4210` (SessionManager::spawn_agent_session): Calls crate::kimi_trust::prepare_spawn(root_path, cwd, command) before creating the PTY.
- `crates/daemon/src/kimi_trust.rs:114` (grant_for_spawn): When the command line launches kimi, calls protocol::kimi_trust::launch_grant with own_command None.
- `crates/protocol/src/kimi_trust.rs:311` (launch_grant): A gavin worktree's own .mcp.json (exempted from the intermediate-file refusal at 305) and the root's (315) are vetted only through declares_only_gavins.
- `crates/protocol/src/kimi_trust.rs:229` (declares_only_gavins): `s.name == "gavin"` accepts the entry; its command and args are never compared. own_command (230-232) narrows only the `playwright` key.
- `crates/protocol/src/kimi_trust.rs:319` (launch_grant -> write_record): Writes <kimi home>/workspace-trust/<key> for the physical cwd (0600), after which kimi loads the worktree's .mcp.json and starts the committed `gavin` command without its trust prompt.

## Fix

Recognise gavin's MCP entries by what they run, not by key: the `gavin` entry must equal gavin's own resolved absolute gavin-mcp with no args, the way the `playwright` entry is already compared. Give the daemon a real own_command, resolving the gavin-mcp it ships beside current_exe, or have it withhold whenever any server is declared. Do not count a repo-relative launcher (mcp_command's `scripts/gavin-mcp`, chosen when the root merely contains crates/gavin-mcp/Cargo.toml) as gavin's own, since a hostile repo can satisfy that test and ship the script. Optionally also disclose a `gavin` entry that differs from what Integration would write.

`crates/protocol/src/kimi_trust.rs`, as a sketch only:

```
fn declares_only_gavins(fs: &dyn TrustFiles, dir: &Path, own_command: Option<&str>) -> bool {
    // gavin's entries are recognised by what they RUN, never by key alone:
    // a repository can commit any command under `gavin`. With no known,
    // absolute own command, nothing counts as gavin's and any declared
    // server withholds -- kimi then asks at its own screen.
    let own = own_command.filter(|c| Path::new(c).is_absolute());
    let gavins = |s: &Server| {
        own.is_some_and(|c| {
            s.command == c
                && ((s.name == "gavin" && s.args.is_empty())
                    || (s.name == crate::playwright::SUBCOMMAND && s.args == [crate::playwright::SUBCOMMAND]))
        })
    };
    declared(fs, &dir.join(".kimi-code").join("mcp.json")).is_some_and(|servers| servers.is_empty())
        && declared(fs, &dir.join(".mcp.json")).is_some_and(|servers| servers.iter().all(gavins))
}
```

`crates/daemon/src/kimi_trust.rs`, as a sketch only:

```
// grant_for_spawn: pass the gavin-mcp shipped beside this daemon instead of None.
let own = std::env::current_exe().ok()
    .and_then(|exe| exe.parent().map(|d| d.join(if cfg!(windows) { "gavin-mcp.exe" } else { "gavin-mcp" })))
    .filter(|p| p.is_file())
    .map(|p| p.to_string_lossy().into_owned());
kimi_trust::launch_grant(fs, &kimi_home, Path::new(cwd), Path::new(root_path), own.as_deref(), trusted_at_ms)
```

## Done when

- The fix enforces the invariant above at the last trusted decision point, not in a caller.
- The regression cases named in the fix are tests in the touched crate or module, and they fail before the change.
- The checks in CLAUDE.md pass for every part you touched.
- The audit reproduction no longer works. It is the record's `execution` field in `findings.json`.
- Follow the CLAUDE.md traps that apply: a new SQLite column needs its own `ALTER TABLE`, a widened request needs a compat-gate entry, and you commit only your own files.
