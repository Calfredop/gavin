---
title: [feat] agent time limits + usage monitors
status: Done
---
Most subscriptions agents have sessions time limits. We need to handle this in the init wizard and workspace/app settings, with a pause X minutes every Y hours. If agent lets you access this limits automatically handle session pause/resume (with hardware sleep, reset, restart cases too).
Also let's add an agent usage tab under in the bottom part of the sidebar (where setting is residing) with in use agents usages against their limits. Search the web on how to do this for each agent we are supporting.

## What each agent actually exposes

Measured/verified 2026-09-02. Recorded here so nobody re-derives it. The
posture is `failure_patterns`': **verified rows only, and an empty row
reads as "gavin cannot see this agent's limits", never as "no limit".**

| profile | account-truth limits | route |
| --- | --- | --- |
| `claude-code` | 5-hour + 7-day utilisation, with reset instants | `GET https://api.anthropic.com/api/oauth/usage`, `Authorization: Bearer <oauth token>`, `anthropic-beta: oauth-2025-04-20`. Returns `five_hour`/`seven_day`, each `{utilization, resets_at}`. |
| `codex` | primary + secondary window | the newest `token_count` event in `~/.codex/sessions/**.jsonl`, whose payload carries `rate_limits.primary/.secondary` with `used_percent`, `window_minutes` and `resets_at`/`resets_in_seconds`. Preferred over `codex app-server`'s `account/rateLimits/read`: the RPC is live but unverifiable here (`codex` is a shim on this machine), and a file whose shape is checked beats an RPC that is not. Last-seen rather than live, so the reading carries its own age. |
| `gemini` | none | `/stats` renders through Ink and does not survive a pipe; `~/.gemini/tmp/*/chats/session-*.json` holds per-session token totals only, which is a burn estimate and not a quota. |
| `cursor` | none | usage lives in the web dashboard. |
| `opencode` | none | BYO provider keys; there is no one limit to report. |

Two traps that shape the code:

- **Hooks do not carry it.** Only the statusline's stdin JSON has
  `rate_limits.{five_hour,seven_day,spend_limit}.{used_percentage,resets_at}`
  (Unix epoch seconds). Every hook event's payload was checked; none has it.
  So a hook cannot be the feed, and taking the statusline would clobber
  whatever the human already runs there.
- **The OAuth endpoint 429s hard.** Without a `User-Agent: claude-code/<version>`
  header it lands in an aggressively limited bucket and stays 429 for hours.
  Polling has to be gentle and cached — never once per render.

Decisions taken with the human (2026-09-02):

- Claude Code is read through the **OAuth usage endpoint**, not a statusline tee
  and not a transcript estimate: it is the only route that is account truth and
  counts other devices.
- A pause **blocks new starts only**. Rails stop launching steps, card runs do
  not start, auto-resume holds. Nothing already running is touched — a pause
  that kills work in flight is not a pause.
- The scheduled cycle ships **off**, stored as absence, like `auto_resume_runs`.
  No existing workspace changes behaviour on update.

## Plan

### A. The probe seam (Rust)

- [x] Add `usage_probe: Option<UsageProbe>` to `AgentProfile` in `agent_setup.rs`, with the doc comment carrying the table above; `claude-code` and `codex` populated, the other three `None`
- [x] Extend `AgentProfileDto` + `settings.ts`'s `AgentProfileInfo` with `usageProbe`, and add the guard test that pins which profiles claim one
- [x] New `app/src-tauri/src/agent_usage.rs`: one `agent_usage(profile_id)` command returning `{windows: [{id, label, usedPercent, resetsAt}], planType?}` or a named unavailability
- [x] Claude Code probe: read the OAuth token (macOS Keychain `Claude Code-credentials`, else `~/.claude/.credentials.json`), GET the usage endpoint with the `claude-code/<version>` user-agent, map `utilization`/`resets_at`
- [x] Codex probe: newest `token_count` event with limits, scanning rollout files newest-first and resolving `resets_in_seconds` against the EVENT's clock
- [x] Host-side cache with a floor between real calls, and a 429 backoff that reports "rate limited, retrying at HH:MM" rather than hammering

### B. The pure modules (TS)

- [x] `agentUsage.ts` — window normalisation, `resets in Xh Ym`, and the severity bands the bars and the pause gate share; unit tests
- [x] `agentPause.ts` — the verdict: given (cycle config, anchor, probe windows, now) is work paused right now, until when, and **why**. Absolute epoch instants only, never an interval timer, so sleep/restart/reset all resolve correctly on the next read; unit tests including a slept-through-the-window case
- [x] Teach the resume path about the pause — done at FIRE time, not decision time: a pause DEFERS a resume (re-armed, capped at a minute so no multi-hour `setTimeout` has to survive a sleep) instead of cancelling it. `usage-limit` stays a hold, now a watched one: the pause gate releases the rail when the probe's reset passes
- [x] Gate `orchestrationState.ts`'s step launch and the card-run launch on the pause verdict, surfacing the reason through the existing `blocked` seam

### C. Config

- [x] `AgentPauseConfig` on `AppConfig` (app-wide default) and on `Workspace` (override), absence = off, machine-local like `auto_resume_runs`
- [x] Carry both through `persist_workspaces` and add them to the carry-through test — this is the trap that has silently wiped six fields already

### D. Surfaces

- [x] Sidebar footer gains a **Usage** row beside Settings, opening `AgentUsageModal.svelte`: a block per profile in use in this app, bars per window, reset countdown, and an honest "gavin cannot read <agent>'s limits" for the three that expose nothing
- [x] App-wide pause cycle section in `GlobalSettingsModal.svelte`
- [x] Per-workspace override in `SettingsHubView.svelte`, showing what it inherits
- [x] Init wizard: the pause cycle offered on the agent step, defaulting off

### E. Verify

- [x] `cargo test --workspace` green — 265 + 329 pass; the two `gavin::tests` fs-watcher failures under full parallelism pass on their own (93/93), the documented flake, and nothing here touches the daemon
- [x] `cd app && npm test && npm run check && npm run build` green — 2166 tests / 93 files, 0 check errors (warning count unchanged at 31, none in the new files), build clean
- [x] Smoke items added to `smokeChecklist.ts` (15, under “Agent limits & usage”) and statically pre-flighted — 44 checks, 0 missing
