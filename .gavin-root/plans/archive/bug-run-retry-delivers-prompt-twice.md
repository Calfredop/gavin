---
order: 4096
kind: task
title: [bug] a retried agent run receives its prompt twice
status: Done
priority: medium
---
Follow-up of bug-kimi-launch-integrations.md ("Follow-ups NOT done here", second bullet). In kimi sessions that failed on 2026-10-06 (OAuth errors, since fixed), the session wire logs under `~/.kimi-code/sessions/` show the card prompt arriving as TWO user messages. Gavin seems to re-deliver the prompt when it retries or recovers a failed run.

## Work

1. Read the evidence first: find the 2026-10-06 kimi sessions in ~/.kimi-code/sessions with duplicated user messages. Note the timing between the two copies and whether anything (a restart, a resume, an MCP reconnect) happened between them.
2. Find every path that writes a run's prompt into a PTY. Candidates:
   - the daemon's queued bracketed-paste prompt, delivered when MCP comes up (the "MCP initialize = agent ready" injection, see feat-kimi-integration.md and feat-custom-profile-prompt-injection.md)
   - `QueueInput`/`WriteInput`
   - auto-resume/recover in the daemon (registry epoch, `interrupted` flag)
   - the card-run retry in app/src/lib/cards/
   - a second gavin-mcp `initialize`, from a re-exec or an MCP server restart, that re-fires a queued prompt which was never consumed
3. Reproduce it, preferably with an isolated daemon under a temp HOME (see crates/daemon/tests/device_wire.rs for the pattern) and a fake agent that reconnects MCP or fails. Do not touch the shared daemon. Never pkill gavin-daemon.
4. If it is a gavin bug: a failing test first, then the fix (a queued prompt is delivered at most once per run). If it is kimi's own retry and not gavin: write the evidence into this card and set it Done with that conclusion.
5. Suites: `cargo test -p gavin-daemon` under a temp HOME (`require_local_token` on this Mac makes server::tests return Forbidden local otherwise), plus `cd app && npm test && npm run check` if you touch the app.

## Constraints

The working tree is shared with other sessions: edit only what you need and commit nothing. A save under app/src-tauri relaunches the owner's dev app.

## Findings (2026-10-12): not a gavin bug

- [x] Evidence read. Every K3 kimi launch that failed with `OAuthUnauthorizedError` on 2026-10-06/07, all in `~/.kimi-code/sessions/wd_dpphm_2a4a81596ad5`:
  - `aafc796c` (develop run): copy 1 at 21:40:06.80, failed at once; copy 2 at 21:40:16.09 (+9.3 s), failed at once.
  - `9b47e251` (plan run): copy 1 at 22:38:40.80, failed at once; copy 2 at 22:39:34.04 (+53 s), failed at once.
  - `3c1833f6` (21:41:57), `74b6a21c` (10-07 09:36:38), `c2459078` (10-07 15:58:42): same failure, prompt arrived ONCE.
  - In both doubled sessions nothing restarted between the copies: there is no second `runtime.set_binding` / `mcp.tools_discovered`, and kimi's `state.json` shows one process. Both copies are `source: "input"` editor submissions with distinct `promptId`s. A resume (`--session`) or a second MCP handshake would have left a mark in the wire.
- What happened between the copies:
  - `aafc796c`: kimi's input history (`~/.kimi-code/user-history/22bbbdef….jsonl`, entries 14–16) reads `<card prompt>`, `/login`, `<card prompt>`. The human ran `/login` in that tab after the "re-login required" error, then resubmitted.
  - `9b47e251`: at 22:39:18, 16 s before copy 2, the human was typing `ù/login` in another kimi tab (`feb00a6a`, submitted twice 1 s apart). Then they came back and resubmitted.
  - The two copies sit 9 s and 53 s apart, irregular, and only 2 of 5 identically failing launches doubled. Neither pattern fits a retry timer or a recovery path.
- [x] Every path that writes a run's prompt into a PTY:
  - App: one `queueInput` per launch, in `cardRunActions.ts` (develop :508, card run :924), `layoutState.ts:2764` and `orchestrationState.ts:1731`. A retry or resume is a NEW session with its own queue.
  - Command lane: never replays a request once it is written.
  - Daemon (both the 10-06 code at d1426bb6 and HEAD): `deliver_head` reads the head row, writes it once, then deletes it, under the `delivering_queued` in-flight marker. The door (`open_agent_door`) and the grace fallback each claim the `awaiting_agent_since` entry by removing it, so only one of them delivers. A reconnecting gavin-mcp's Hello finds the entry gone and does nothing.
  - Auto-resume never fires on `auth` and always relaunches a new session. `pasteToMainAgent` / `sendToMainAgent` need a human click.
- [x] Reproduced against the real PTY path, in a detached worktree with a temp HOME and an isolated in-test daemon (shared daemon untouched). The test:
  - queues the prompt on a fake K3 agent;
  - delivers it on the Hello;
  - lets the turn go idle (observed `<idle>`);
  - sends two more Hellos (MCP reconnect);
  - outlives the grace window, then writes a sentinel.

  The terminal received `PROMPT_ONCE` exactly once and the queue was empty. The door tests (`the_agent_ready_door_*`, `a_prompt_queued_for_a_fresh_session_*`) stay green. The test was not added to the tree: `server.rs` is dirty from another session. The patch is kept at the session scratchpad as `repro_test.patch` if anyone wants it as a guard.
- Conclusion: a queued prompt is already delivered at most once per run. The second copies were kimi editor resubmissions of identical text after a failed turn, made by the human retrying around `/login`, not by gavin. No code change.
