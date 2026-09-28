---
order: 7360
kind: task
title: Headroom 06: honest failures
status: To Do
labels: ready-for-agent
parent: headroom.md
complexity: complex
---
Blocked by: headroom-02-compressed-launches-claude-code.md, headroom-05-savings.md

Part of `headroom.md`. Read the spec (section "Failures") first.

## What to build

- **A `headroom` failure cause.** It applies when a compressed session fails and Headroom fails its health check at that moment. Without it, the failure reads as `network`, and auto-resume retries into the same broken proxy across the whole fleet. Add it to `FailureCause` and `KNOWN_CAUSES` in `autoResume.ts`; an older build reads it as `unknown`, which never resumes.
- **Relaunch without Headroom.** Auto-resume relaunches a `headroom` failure uncompressed: the spawn carries an explicit "not compressed" override that the daemon's decision honours.
- **Not reaching Headroom.** A compressed session that finishes a turn while Headroom has seen no request tagged with its id is flagged. Use 05's per-session request count, or read `/stats` live.
- **The exception mark.** A tab mark in the `ui/indicators.ts` vocabulary (`StatusBadge`), shown only on a session in a compressed workspace that is not compressed. It names one of three reasons: Headroom was not ready, it failed and the session was relaunched without it, or the session is not reaching Headroom. A compressed session carries no mark.

## Acceptance criteria

- [ ] The cause is classified `headroom` only when the session is compressed and the health check fails; otherwise the existing classification stands (tested)
- [ ] Auto-resume relaunches a `headroom` failure uncompressed, and the new session carries the mark (tested)
- [ ] A compressed session with zero Headroom requests after a finished turn gets "not reaching Headroom" (tested)
- [ ] The mark is decided in a pure module and appears only in the three exception cases (tested)
- [ ] `cargo test --workspace`, `npm test` and `npm run check` green

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
