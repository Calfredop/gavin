---
order: 5120
title: Per-card run history and cost
status: Done
priority: medium
---
Show a card's run history — every run, its duration, resumes, outcome and agent — and what each run cost in tokens, read from the agent CLI's own logs.

Run rows already exist in the daemon; nothing lists them per card. Token counts come from the same per-profile sources the usage probe already reads (`agent_usage.rs`: the codex rollout `token_count` events; Claude Code's session JSONL). This is Gavin's version of Cursor's analytics, scoped to one developer: per card, not per team.

Borrowed from Cursor's analytics dashboard + context usage report (2026-09-03 feature scan).

## What the code actually has today

`card_sessions` is keyed `(workspace_id, path)` and **upserted** — one live
binding per card, and the previous run is overwritten the moment the next one
launches. So there is no history to list yet; it has to be kept. The registry
does persist every session, but it holds no wall-clock timestamps
(`started_at_us` is a pid-reuse guard, not a clock), so run timings cannot be
recovered from it either. The history table owns its own clock.

## Two decisions this plan is built on

**A run is one session.** Not one conversation: a session id always exists,
is what the daemon already thinks in, and is what the human can jump to. A
*resume* launches a new session carrying the previous run's `conversation_id`,
so rows sharing a conversation id are one chain — the list says "resumed from
the run above" and the pure module derives that, rather than the daemon
guessing at run identity. `resume_attempts` on the row stays what it already
means: unattended auto-resumes *within* that session.

**Cost is tokens, never dollars.** The agent logs record tokens; a price table
would go stale silently and means nothing on a subscription plan. Show
input / output / cache-read / cache-write and a total.

## Checklist

- [x] Protocol v27: `CardRun`, `Request::CardRuns` / `Response::CardRuns`, the `min_version_for` entry and the version-history note
- [x] Daemon store: a `card_runs` table in `kanban.rs` — open a row on link, close it on relink and unlink, read a card's rows back
- [x] Daemon server: route `CardRuns`, and close the open row where the pump already reports `SessionExited`
- [x] Host: the `card_runs` Tauri command in `session.rs`
- [x] Host: `agent_tokens.rs` — per-conversation token totals from the Claude Code session JSONL (**deduped by `message.id`**: one assistant message is written once per content block, each copy carrying the same `usage`) and from the codex rollout's last `token_count`
- [x] App: `backend.ts` bindings and the `runHistory: 27` gate in `daemonCompat.ts`
- [x] App: `runHistory.ts` — the pure module (duration, outcome sentence, resume chains, agent label, token summary) with tests
- [x] App: `runHistoryState.ts` — per-card fetch, and token totals fetched lazily per run
- [x] App: `RunHistoryModal.svelte` and the Runs row on `CardDetailModal.svelte`
- [x] Smoke items in `smokeChecklist.ts`, statically pre-flighted
- [x] Full check: `cargo test --workspace`; `npm test && npm run check && npm run build`
