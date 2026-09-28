---
order: 25600
kind: task
title: "[perf] card_run_tokens parses whole transcripts on the main thread"
labels: bug
parent: perf-main-thread-command-audit.md
status: Done
---
`card_run_tokens` (app/src-tauri/src/agent_tokens.rs:192) reads a whole agent
transcript and parses every line into a `serde_json::Value`, on the main
thread, once per conversation when Run history opens.

## Evidence (2026-09-26)

- `read_to_string` (agent_tokens.rs:225), then every line parsed (:337-338).
  The cache is keyed on mtime (:218-223), so a live run never hits it.
- `~/.claude/projects` here: 1,142 JSONL files, 1.9 GB; the largest 29 MB
  (Python parse alone 162 ms; the debug build is slower). A card with many
  long runs costs seconds.
- Trigger: Run history open/refresh — one call per conversation; the
  `Promise.all` still serialises them on the main thread, and live runs
  re-read every time (app/src/lib/cards/runHistoryState.ts:116-141).
- `conversation_log` (:143) rides along: `read_dir` of ~127 project dirs
  (codex: a walk of up to 4,000 files), ms to ~100 ms, on resume/review
  launch including auto-resume.

## Fix

- Both `async` + `spawn_blocking`, `app.state::<TokenCache>()` inside the
  closure, returning `Result`.
- Skip lines without `"assistant"` before parsing, or parse into a typed
  struct that ignores content blocks.
- Ordering: runHistoryState is already token-guarded.

## Verify

Add both to `OFF_MAIN_THREAD` in
`app/src/lib/guards/mainThreadCommands.test.ts` (red first); keep the
existing message.id dedupe tests green.
