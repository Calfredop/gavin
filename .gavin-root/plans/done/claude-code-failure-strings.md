---
kind: task
title: Widen claude-code's failure strings with the ones it really prints
status: Done
priority: medium
complexity: simple
---
Claude Code's `failure_patterns` (`["API Error:"]`) and `failure_causes` in `app/src-tauri/src/agent_setup.rs` were drawn from a fake-API measurement session. The errors Claude Code actually printed in this repo's own transcripts (`~/.claude/projects/-Users-coalpila-CloudStation-Coding-gavin*/*.jsonl`, entries with `"isApiErrorMessage": true`) show two gaps -- see `/Users/coalpila/CloudStation/Coding/gavin/.gavin-root/plans/done/typesafe-experiments.md`, E2 (an absolute path: it sits in the main checkout, uncommitted, so a worktree has no copy):

**Never detected** -- the line has no `API Error:`, so a broken turn reads as a finished one and a rail's agent step completes on it:

- `You've hit your session limit · resets 6:50pm (Europe/Rome)` -> usage-limit
- `You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.` -> usage-limit
- `Login expired · Please run /login` -> auth
- `Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access` -> auth
- `Request timed out` -> network

**Detected, cause `unknown`** -- so auto-resume never fires for what is a plain network blip:

- `API Error: Connection closed mid-response. ...` / `Connection lost mid-response` / `The response stopped arriving` -> network
- `API Error: Server error mid-response. ...` -> outage
- `API Error: Your computer went to sleep mid-response. ...` -> leave it; the daemon's own slept-mid-turn verdict owns suspend

**One ordering trap**: `API Error: Server is temporarily limiting requests (not your usage limit) · You have exceeded your usage limit. Please try again later.` matches the `exceeded your usage limit` row today. It is server-side throttling (outage), so a `temporarily limiting requests` -> outage row must come BEFORE the usage-limit rows. First match wins (`classifyFailure`), and the existing test in agent_setup.rs that pins auth-first ordering is the place to pin this one too.

Constraints:
- Every new `failure_patterns` entry is matched against the WHOLE rendered screen at the quiet->idle transition, so a pattern that could appear in an agent's own summary or tool output (e.g. `Request timed out` in a test log) turns a finished turn into a failure. Prefer the longest distinctive fragment of each line (`Please run /login`, `limit · resets`, `/usage-credits`), and add a server.rs test per new pattern the way the existing `API Error:` ones are tested.
- Keep the measured-strings comment honest: record that these came from real transcripts (2026-09), not the fake API.
- No protocol change: `failure_patterns` rides the existing `SetFailurePatterns` request.
