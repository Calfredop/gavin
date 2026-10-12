---
title: [bug] rail card steps refuse kimi-code: launcher never consults headless_args
status: In Progress
priority: high
attachments: app/src/lib/cards/cardRun.ts, app/src-tauri/src/agent_setup.rs, .gavin-root/plans/bug-kimi-launch-integrations.md
complexity: complex
---
## Symptom

Observed live 2026-10-08 from the `dpphm` workspace (agent profile kimi-code): a card step on an orchestration rail stalls immediately. The stall reason persisted in `orch_step_runs.reason`:

> "Kimi Code takes no prompt on its command line, so gavin cannot start a card with it. Pick a different agent in Settings."

"Run with agent" on the same card works — it uses the PTY prompt-injection path (`prompt_injection: true`), which the rail launcher does not have.

## Cause

The rail card-step launch goes through `buildRunCommand(agentCommand, promptArgs, prompt)` (`app/src/lib/cards/cardRun.ts:405`), which returns null for profiles with `prompt_args: None`. kimi-code has `prompt_args: None` ON PURPOSE (`agent_setup.rs:1454`): `-p` is non-interactive-and-exits, so interactive runs launch `kimi` bare and inject the prompt into the PTY.

But the profile already carries a verified headless form — `headless_args: "-p="` (attached; the separated form does not work, verified live 2026-10-05, kimi 2.1.1) — plus `failure_patterns` / `failure_causes` for exit classification. The headless-launch test (`agent_setup.rs:3997`) even exempts kimi-code by name from "runs headless but takes no prompt". So gavin knows how to run kimi headless; the rail card-step path never consults `headless_args`.

Same gap already noted from two other angles in `bug-kimi-launch-integrations.md` ("Follow-ups NOT done"): daemon-side launches bypass `create_session`, and `startMainAgentWithPrompt` still errors for kimi.

## Fix direction

When `prompt_args` is `None` and `headless_args` is set, the rail card-step launcher should build the command from `headless_args` (attached `-p=<prompt>`) instead of refusing. Watch three kimi-specific sharp edges already documented on the profile:

- `-p` forces kimi's `auto` permission policy (print mode) — no approval prompts, static deny rules only. Confirm that is the policy a rail step should run under, or refuse with a clearer reason.
- Headless kimi launched by the daemon gets no launch-time folder-trust grant (the trust fix in `bug-kimi-launch-integrations.md` §2 lives in the app's `create_session`); a `-p` run in an untrusted cwd may hit the trust screen non-interactively. Trust-key derivation needs to be reachable from the daemon side.
- `--yolo` conflicts with `-p` (noted on the profile), so do not compose the two.

## Resolution (2026-10-08): injection, not headless

The rail card step now launches kimi the way a board Run of the same card does, using K3 prompt injection: it spawns `kimi` bare on the rail's page, then `backend.queueInput(sessionId, prompt)` right after the spawn. The daemon holds the prompt until kimi's gavin-mcp Hello. `executeLaunch` in `app/src/lib/orchestration/orchestrationState.ts` uses `usesPromptInjection(launchAgent)` (the fallback's agent when the chain walked). A failed queue write stalls the step with `couldn't hand the agent its prompt: …`. The step is not left running an agent with nothing to do.

I chose injection over the "Fix direction" above (`headless_args` / `-p=`), and the three sharp edges are the reasons:

- **Permissions.** `-p` forces kimi's `auto` policy, which never asks. The interactive launch keeps the human's `default_permission_mode` (gavin seeds `yolo`, "Ask When Needed"), which is the same policy the same card gets from a board Run.
- **Trust.** The worry was that "daemon-side launches bypass create_session". That is not true for rail steps. `createSessionOnRailPage` → `createSessionOnPage` → `backend.createSession` → the Tauri `create_session`, so `prepare_kimi_launch` (trust grant + launch config) runs for every rail launch. No trust-key derivation needs to move into a shared crate for this path. The worktree case is below.
- **`--yolo` + `-p`.** Neither flag is composed.
- There is also a fourth reason. A `-p` run exits when it answers, and the rail's whole model of a card step (attention marks, turn verdicts, `turn-ended`/`stale`, Resume by `--session`) assumes an interactive agent sitting at its prompt.

Exit classification needs nothing new. The launch already arms `armFailureDetection(sessionId, failurePatterns, untrustedOsc133)` with kimi's own `failure_patterns`, so a `Model authentication failed` stalls with kimi's sentence and the `auth` cause through rule 3d.

Tests (orchestrationState.test.ts, "an agent whose prompt is injected (K3)"):
- launches bare + queues the prompt, with kimi's patterns armed
- a failed queue write stalls
- a profile with neither argv nor injection still stalls on `noPromptReason`

Verification: app vitest 337 files / 7691 passed, `npm run check` 0 errors.

### Second bug, found live (2026-10-08): the prompt lands in kimi's input but is never sent

The owner's first live run launched and the prompt appeared in kimi's input, but nothing happened until they went to the tab and pressed Enter. kimi's own record of that run (session_6822471c, dpphm) shows the full 958-character prompt, submitted 8 s after launch. That was their Enter.

**Cause.** It is in the daemon's K3 door, so it is not specific to rails; board Runs share it.
- The door used to deliver `ESC[200~prompt ESC[201~ \r` the moment gavin-mcp said Hello. But kimi spawns its MCP servers while its TUI is still starting. In the registry, session 27's gavin-mcp started in the same second as kimi.
- If the bytes arrive before kimi has taken the pty raw, the line discipline rewrites the trailing `\r` to `\n` (ICRNL). kimi's editor treats a bare `\n` as "insert newline" (`data === "\n"` → `addNewLine`), so the prompt sits in the input, unsent.
- Delivered in the first ~150 ms after kimi goes raw, the prompt is dropped outright while kimi negotiates keyboard protocols with the terminal.

**How this was established.** I drove the real kimi 2.1.1 binary in a PTY with a scratch `KIMI_CODE_HOME` pointed at a fake local model server, so the owner's login and quota were never touched.
- Paste plus `\n` reproduced the exact symptom: text in the input, sent only by a second Enter.
- Writes before raw, or less than ~150 ms after it, lost the prompt.
- Writes after raw-for-500ms and quiet-for-500ms submitted on every run (12/12), with and without terminal query answers. That measured rule is now the door.

**Fix.**
- crates/daemon/src/server.rs:
  - A Hello now only marks the agent announced (`note_agent_ready`).
  - The per-session poller (`spawn_agent_ready_fallback`) opens the door (`open_agent_door`) once the terminal has been raw for `AGENT_SETTLE`, the agent has drawn output, and output has been quiet for `AGENT_SETTLE` (`agent_input_ready`).
  - At the 15 s grace, an announced agent still gets its prompt; an unannounced one keeps the idle fallback.
- crates/daemon/src/pty.rs: `PtySession::takes_raw_input` reads ICANON off the master.

**Tests.**
- `a_prompt_queued_for_a_fresh_session_waits_for_its_agent_to_take_the_terminal_raw`: a fake agent is cooked for 1 s, then raw and echoing. The prompt stays queued after the Hello, then arrives with its `\r` intact. It failed before the fix: the queue was empty 600 ms after the Hello.
- `an_agents_terminal_is_ready_once_raw_drawn_and_quiet`
- `takes_raw_input_follows_the_programs_own_terminal_mode`
- The door tests were updated for the announce/open split.

**Needs a daemon rebuild and restart.** The running dev daemon dates from 14:32 today. The protocol is unchanged.

### Not covered: rails bound to a `.gavin-worktrees` checkout

`grant_kimi_launch_trust` withholds when any `.mcp.json` sits between cwd and root. A worktree checks out its own tracked `.mcp.json` (dpphm tracks one, and so does this repo), so a kimi step on a WORKTREE rail still stops at "Trust this folder?". The human answered that decision on feat-kimi-integration.md (2026-10-06): "Yes — trust each gavin-created worktree at launch". It is not implemented anywhere yet. The dpphm rail that reported this bug is unbound (runs in the root), so it is unaffected. Filed as follow-up: kimi-trust-gavin-worktrees-at-launch.md.

### Not covered: the other launch surfaces with the same refusal

These still call `buildRunCommand` with no injection branch, so they refuse kimi:
- a rail's AGENT tool step (`executeToolLaunch`)
- Generate/Reorganize (`launchOrchestrationAgent`)
- `startMainAgentWithPrompt`
- Best-of-N
- code review
- critical review
- workspace agent tools

Filed as follow-up: kimi-injection-on-remaining-launch-surfaces.md.

## Acceptance

- [ ] A rail card step on a kimi-code workspace launches and runs to the card's done column (unit-proven; live run filed as a Human test below)
- [x] Exit classification uses the profile's `failure_patterns` (auth / usage-limit / context) rather than a generic stall
- [x] The refusal sentence remains for profiles that genuinely have no headless form (cursor, custom). Custom keeps it. Cursor was never refused: it has a prompt argv (`prompt_args: Some("")`).
- [ ] Human test: In the dpphm workspace (agent Kimi Code), reload the app on this build, Retry the stalled step-hardening step on the "v0.1.0 First Public Release" rail: kimi opens on the rail's page with no "Trust this folder?" screen, the card prompt arrives by itself within a few seconds, and the step stays running (not stalled with "takes no prompt") until the card reaches Done.
