---
title: TypeSafe experiments: turn verdicts, failure causes, card complexity
status: Done
---
Probe whether TypeSafe (Jev, System One judgments) can replace gavin's text heuristics where they are weakest, then propose changes from the most promising results. Experiments run from the session scratchpad, not the repo; nothing here changes code.

- [x] E1 quiet-turn verdict: from a quiet session's screen tail, finished / asking the human / broke / still retrying -- agent-agnostic (codex, gemini, cursor, opencode have no failure_patterns today)
- [x] E2 failure cause: classify a failure line into autoResume's FailureCause set; compare with claude-code's substring table, test lines from agents with no table
- [x] E3 card complexity: Score real cards against the 5 levels, compare with the 75 cards that already carry `complexity:`
- [x] Measure latency + cost per call for each
- [x] Write up results and proposed changes

## Results

Model `jev-1.13.0` (pinned). One request per screen carries every question (a 5-way verdict Choice, a cause Choice, four Nouls). "Today" is gavin's rule at the quiet->idle transition: a line containing a profile `failure_patterns` entry is a failure (only claude-code has one: `API Error:`), a permission menu is credited as asking (the OSC bell path), anything else is a finished turn.

**E1, synthetic screens** (53, five CLIs, labelled before any run, split dev/test):

| | TypeSafe | today |
|---|---|---|
| test split, v1 questions | 25/26 | 14/26 |
| all 53, v2 questions | 52/53 | 29/53 |
| failure cause on failed screens | 16/16 | 5/16 |

**E1, real turn endings** (70 final Claude Code messages sampled from this repo's transcripts, labelled by hand first; 16 marked ambiguous):

| | v1 | v2 | today |
|---|---|---|---|
| clear cases | 48/54 | 53/54 | 35/54 |
| real questions / approval gates caught | 16/16 | 15/16 | 0/16 |
| finished turns wrongly flagged asking | 11 | 3 | 0 |

v1 over-read closing offers ("say the word and I'll commit") as questions. v2 writes that boundary into the criteria. Caveat: v2 was worded after reading v1's misses on this set; it held on the synthetic set it was not written against.

**E2, real failure messages** (the 16 distinct errors Claude Code printed in this repo's transcripts):

| | TypeSafe | today |
|---|---|---|
| recognised as a failure | 16/16 | 11/16 |
| right cause | 15/16 | 5/16 |

Undetected today because the line has no `API Error:`: "You've hit your session limit · resets 6:50pm", "Login expired · Please run /login", "Request timed out", "You've reached your Fable 5 limit", "Your organization has disabled Claude subscription access". Detected but `unknown` cause (so auto-resume never fires): "Connection closed/lost mid-response", "The response stopped arriving", "Server error mid-response", "Your computer went to sleep mid-response". One message fools both: "Server is temporarily limiting requests (not your usage limit) · You have exceeded your usage limit" reads as usage-limit -- a hold, the safe direction.

**E3, card complexity** -- not promising. 75 cards with a written level. With the app's own level hints: exact 24/75 (always answering "moderate" gets 33), Spearman 0.68. With concrete level descriptions: exact 35/75, within one level 66/75. It orders cards sensibly but does not reproduce the written levels, and the codebase's posture is that a misread level must never pick an agent. Dropped.

**Cost and latency**: about 412 calls, 570k input tokens, about $0.024 in total. A verdict is ~1.4-1.8k input tokens, about $0.00007. Latency p50 0.67s, p95 0.81s, max 2.7s.

Method, known misses and the exact question set: `docs/superpowers/specs/2026-09-21-typesafe-turn-verdict-experiment.md`.

## Proposals

- [Widen claude-code's failure strings](../claude-code-failure-strings.md) -- no TypeSafe needed: add the measured real strings to `failure_patterns`/`failure_causes`.
- [TypeSafe turn verdict](../typesafe-turn-verdict.md) -- opt-in TypeSafe second opinion at the quiet->idle transition: asking vs finished vs blocked vs failed(+cause), for every agent profile.
