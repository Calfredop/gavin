---
order: 7168
title: [feat] agent session name mcp
status: Done
complexity: moderate
---
With current implementation, when starting a new agent session both via card or rail, the agent is asked via skill to give a name to the tab. The very same skill should ask the agent to name its session and give back the session's name or id to Gavin, so the session gets linked to its entity (card). This should be done via MCP with the scope of when a tab gets resumed, the agents' session params get passed down. This also needs a resume param vocabulary for supported agents, with a custom param label for custom agents.

## Design

**The gap.** `gavin_name_session` and the `card_sessions` link already exist
(`plans/archive/tab-naming-and-link-build.md`). Real conversation resume also
already exists, but only for Claude Code: gavin *mints* the id itself at
launch (`AgentProfile::session_id_args`, `--session-id <uuid>`) and stores it
in `card_sessions.conversation_id`, then `buildResumeCommand` replays it with
`resume_args`. Every other profile — codex, gemini, opencode, cursor — has
both fields empty and falls back to a written prompt reconstruction, because
none of them let the CALLER fix a session id up front. They do, however, each
generate their own id and can be resumed by it once known:

| profile | resume flag (unverified against the real binary yet) | where its self-generated id lives |
|---|---|---|
| codex | `codex resume <id>` | newest `~/.codex/sessions/YYYY/MM/DD/rollout-<id>.jsonl` |
| gemini | `gemini --resume <uuid>` | newest file under `~/.gemini/tmp/<project_hash>/chats/` |
| opencode | `opencode run --session <id> --continue` | newest file under `~/.local/share/opencode/storage/session/<projectHash>/` |
| cursor | out of scope | gavin's `cursor` profile takes no prompt at all and never enters the headless resume path |

**The fix.** The agent self-reports that id over MCP once it exists, gavin
stores it in the same `card_sessions.conversation_id` column, and resume uses
it exactly as it already does for Claude Code — `cardRunActions.ts` and
`orchestrationState.ts` already prefer `buildResumeCommand` over the base
prompt whenever a `conversationId` is present, for every resume trigger
(manual, rail auto-resume, daemon-crash recovery), falling back to
`composeResumeTaskPrompt` only when it is null. **No new "should we resume"
decision logic is needed anywhere** — only making `conversationId` non-null
for more profiles.

**Naming.** The new MCP argument is `agent_conversation_id`, never `session_id`
— `Request::NameSession` already has a `session_id` field naming *gavin's own*
tab/PTY session (from `GAVIN_SESSION_ID`), a different thing from the agent's
native CLI session id being added here. Keep the two spelled differently in
every layer (MCP param, protocol field, code comments) so they are never
confused.

Split into three task cards below because they touch disjoint files and two
of them are real, separable judgment calls rather than steps in one sitting.
Do them in order: the third depends on the exact field/param names the first
two land with.

- [x] [Agent self-reports its own session id over MCP](./agent-session-id-self-report.md)
- [x] [Resume vocabulary per agent profile, plus a configurable custom resume flag](./agent-resume-vocabulary-and-custom-config.md)
- [x] [Wire session self-report into the naming skill and card prompts](./agent-session-report-prompt-wiring.md)
- [x] Confirm live: at least one non-Claude-Code profile (codex, gemini or
      opencode) actually reopens its real conversation on Resume — not just
      green tests, the way the original naming feature was confirmed end to
      end in `tab-naming-and-link-build.md`.

## Verification, 2026-09-11

**Live, not just green tests.** Ran the real `opencode` binary (1.18.25)
directly against its own on-disk store — no gavin daemon involved, so no
repeat of the isolation mistake below. `opencode run -m
openrouter/liquid/lfm-2.5-2.6b:free "Reply with exactly the single word
PING…"` under a scratch directory, then the profile table's own
`session_id_discovery` one-liner against `opencode.db`, then `opencode
run --session <discovered-id> "What word did you just reply with?"` —
it answered "PING", proving the SAME conversation reopened rather than a
fresh one starting blind. That run also caught a real bug: the
discovery query's bare `$(pwd)` returned bash's LOGICAL path while
opencode records the PHYSICAL one, so a cwd through a symlink (macOS's
`/tmp` → `/private/tmp`) matched nothing — fixed to `$(pwd -P)` and
re-verified. Fixed on `dev-rail`, commit `9bdf993`.

gemini and codex are not live-confirmed: gemini's own `--resume` takes
"latest" or a session index, never an arbitrary id, so it was left
unwired rather than wired to something that cannot work — see
`agent-resume-vocabulary-and-custom-config.md`'s commit for the
`--help` transcript this was checked against. codex has no installed
binary on the machine this shipped from to check against at all, so its
row stays empty by the same "unverified stays empty" rule every other
row in that table already follows.

**Incident, logged for the record.** While setting up for this
verification, a stray `./target/debug/gavin-daemon --help` (no `HOME`
override) ran real recovery against the shared, running daemon's
registry before failing to bind its socket and exiting — the daemon's
`main()` runs `Registry::open`/`recover()` before it ever tries to bind.
The human checked their live sessions afterward and confirmed nothing
was actually broken, but this is the reason the opencode check above
went through the bare CLI directly instead of a hand-rolled isolated
daemon a second time.
