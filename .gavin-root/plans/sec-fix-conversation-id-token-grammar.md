---
kind: task
title: "[sec] An agent's self-reported conversation id is spliced unquoted into the Resume / auto-resume shell line, which skips the first-run review"
status: To Do
priority: low
complexity: simple
---
Fix a low-severity finding from the 2026-10-15 security audit (run-1). Fingerprint: `gavin-mcp:name_session:agent_conversation_id+cardRun.ts:buildResumeCommand:unquoted-sh-c`.

Full record: `findings.json` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

Any agent gavin launched can call gavin_name_session with an arbitrary agent_conversation_id. gavin-mcp only trims it, and the daemon checks only agent_owns_session. The daemon writes the string verbatim into card_sessions.conversation_id for the card the agent's session is bound to, overwriting the id gavin minted. When the human later presses Resume or Review on that card, or auto-resume fires unattended, launchCard calls buildResumeCommand. That function returns `${agentCommand} ${resumeArgs} ${id}` with the id unquoted, and the daemon runs the line through `sh -c`. launchCard treats a buildable resume line as 'reopening'. Reopening is the one launch exempt from both the interactive first-run review and the unattended cardReviewed refusal, on the stated assumption that the id is 'only ever an id gavin itself recorded on THIS binding'. So agent-written state becomes extra shell commands in a launch attributed to the human's Resume, or run with nobody watching, and nothing in the UI shows them. The conversation_log existence check does not stop this. It answers 'unknown', which still builds the line, for: the stock opencode profile (token_log None); custom profiles; a missing log root; and ssh workspaces, which sshLaunchBlocker gates only on host version. The claude-code transcript lookup joins the raw id into a path, so it may also be satisfiable with a crafted id. That last point was read in source only and not exercised.

## Root cause

The resume path treats card_sessions.conversation_id as gavin-minted, trusted data. But an agent can write the same column through NameSession -> SessionManager::name_session -> Kanban::set_conversation_id_for_session. No layer constrains the id's characters: not the MCP tool, not the daemon's NameSession handler or authorization, not the store, and not buildResumeCommand, which builds a shell line without the shellQuote that buildRunCommand uses for the prompt. The sibling rail-step resume uses the same builder safely only because its column, orch_step_runs.conversation_id, is written solely through SetStepRun, and agents are denied SetStepRun.

## The invariant to enforce

A Resume or auto-resume line must contain only the profile's launch command, its resume argv and one opaque id token. The daemon's NameSession handler, and gavin-mcp as defence in depth, should reject a self-reported id outside a conservative token grammar (e.g. ^[A-Za-z0-9._:-]{1,128}$). buildResumeCommand should shell-quote the id. It should also return null for an id outside the grammar, so rows already stored with such an id cannot change the command's shape and fall back to the written reconstruction.

## Trace (lines as of 2026-10-16; re-read before editing)

- `crates/gavin-mcp/src/main.rs:816` (dispatch_tool gavin_name_session): Agent tool call, handled before any root resolution; agent_conversation_id is taken from the tool arguments as-is.
- `crates/gavin-mcp/src/main.rs:1307` (clean_agent_conversation_id): Trims only, with no charset or length check, then forwards the id in Request::NameSession using the agent token from GAVIN_SESSION_TOKEN.
- `crates/daemon/src/server.rs:7393` (agent_allows NameSession): Agent role is allowed whenever it owns the session; the id value is not inspected.
- `crates/daemon/src/server.rs:4269` (SessionManager::name_session): Calls set_conversation_id_for_session(session_id, conversation_id) verbatim for the session's bound card.
- `crates/daemon/src/kanban.rs:773` (Kanban::set_conversation_id_for_session): UPDATE card_sessions SET conversation_id = ?1 WHERE session_id = ?2 overwrites the gavin-minted id.
- `app/src/lib/cards/cardRunActions.ts:692` (launchCard resume/review): buildResumeCommand(agent.launchCommand, agent.resumeArgs, binding?.conversationId, conversationLog); reopening = resumeCommand !== null && binding !== null.
- `app/src/lib/cards/cardRun.ts:419` (buildResumeCommand): Returns `${agentCommand} ${args} ${conversationId.trim()}` with the id unquoted.
- `app/src/lib/cards/cardRunActions.ts:852` (launchCard reopening branch): backend.createSession(resumeCwd, resumeCommand, ...) creates a new session with the composed line. The review gates at line 787 sit inside `if (!reopening)` and are skipped.
- `crates/daemon/src/pty.rs:164` (PTY spawn): The command string runs as `sh -c <line>`, so `;` in the id starts a separate command.

## Fix

Validate the self-reported id at every writer and quote it at the sink. The daemon's NameSession/name_session should reject an agent_conversation_id outside a conservative token grammar; that is the check that counts, and gavin-mcp should mirror it. buildResumeCommand should shell-quote the id. It should also return null for an id outside the grammar, which covers rows already stored, so launchCard falls back to the written reconstruction and its review gate. Optionally record that an id was self-reported, so reopening it does not inherit the review exemption of a gavin-minted id.

`crates/daemon/src/server.rs`, as a sketch only:

```
// in SessionManager::name_session, before the kanban write
if let Some(conversation_id) = agent_conversation_id {
    let ok = !conversation_id.is_empty()
        && conversation_id.len() <= 128
        && conversation_id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'));
    if !ok { anyhow::bail!("agent_conversation_id must be an opaque token ([A-Za-z0-9._:-], at most 128 bytes)"); }
    self.kanban.lock().unwrap().set_conversation_id_for_session(session_id, conversation_id)?;
}
```

`app/src/lib/cards/cardRun.ts`, as a sketch only:

```
const CONVERSATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
export function buildResumeCommand(agentCommand: string, resumeArgs: string, conversationId: string | null | undefined, log: ConversationLog = "unknown"): string | null {
  const args = resumeArgs.trim();
  const id = conversationId?.trim() ?? "";
  if (!args || !id) return null;
  if (!CONVERSATION_ID.test(id)) return null;
  if (log === "missing") return null;
  return `${agentCommand} ${args} ${shellQuote(id)}`;
}
```

`crates/gavin-mcp/src/main.rs`, as a sketch only:

```
fn clean_agent_conversation_id(raw: &str) -> anyhow::Result<Option<String>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() { return Ok(None); }
    if trimmed.len() > 128 || !trimmed.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':')) {
        anyhow::bail!("agent_conversation_id must be your CLI's opaque session id");
    }
    Ok(Some(trimmed.to_string()))
}
```

## Done when

- The daemon's NameSession rejects an id outside the token grammar, and buildResumeCommand quotes the id and returns null for an out-of-grammar stored id.
- The fix enforces the invariant above at the last trusted decision point, not in a caller.
- The regression cases named in the fix are tests, and they fail before the change.
- The checks in CLAUDE.md pass for every part you touched, and you commit only your own files.
