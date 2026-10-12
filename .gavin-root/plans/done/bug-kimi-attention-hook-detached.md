---
order: 14336
kind: task
title: [bug] kimi attention hooks never ring: hooks detached from tty, picker fires no event
status: Done
priority: high
---
Evidence gathered 2026-10-12 by driving kimi 2.1.1 in an expect pty (full write-up in bug-kimi-launch-integrations.md, "pty-driven verification" section):

1. gavin-attention (written by `ensure_kimi_launch_config` in app/src-tauri/src/agent_setup.rs, `GAVIN_HOOK_SCRIPT` ~line 2824) does `printf '\a' > /dev/tty`. kimi 2.1.1 spawns hook commands DETACHED from the controlling terminal (observed: hook process TTY=??, parent kimi has ttys038; `/dev/tty` fails "Device not configured", swallowed by `2>/dev/null`, exit 0). Result: PermissionRequest fires (traced live on a real approval dialog) but no BEL ever reaches the pty the daemon scans, so no waiting_for_input badge. Verified fix: resolve the pty by walking ancestors with `ps -o tty=` (skip `??`) and write to `/dev/<tty>` — proved this reaches the pty stream from a tty-less process. Rewrite GAVIN_HOOK_SCRIPT accordingly (keep drain-stdin + exit 0 + observation-only), keep it POSIX sh, and make the byte-exact tests in agent_setup.rs match. Windows hook spawning may differ — note it, don't block on it.

2. The foreground AskUserQuestion picker fires NO hook event (traced two sessions; kimi's docs say TaskStarted is background-tasks-only, so the `TaskStarted(question)` rule never matches the picker from the original symptom). Decide the detection seam for "kimi is showing a question/approval dialog": candidates are (a) daemon-side pattern-match on kimi's dialog chrome in the PTY stream ("esc cancel" / "↑/↓ select · 1/2/3/4 choose" — the daemon already scans output for status), or (b) accept idle and rely on the fixed PermissionRequest BEL plus Notification/TaskStarted for background tasks. Record the decision on the card.

After the fix lands, re-arm (identical text) the "Kimi tab status" Human test item on bug-kimi-launch-integrations.md and have the human run it.

## Done 2026-10-12

### 1. The bell now reaches kimi's PTY

`GAVIN_HOOK_SCRIPT` (app/src-tauri/src/agent_setup.rs) still drains stdin, rings, and exits 0. It now tries `/dev/tty` first, for a kimi that keeps hooks on the terminal. When that fails it walks its ancestors with `ps -o tty= -o ppid=`, skipping `??` (macOS), `?` (Linux), `-` and empty, and writes the BEL to `/dev/<tty>` of the first ancestor that has a terminal. That ancestor is kimi, whose terminal is the PTY the daemon reads. The script is POSIX sh. On Windows kimi spawns hooks differently and this script does not run there. Not handled here.

`ensure_kimi_launch_config` now rewrites the script whenever it differs from the current text, instead of only writing it when absent. Without that, every machine that already had the old `/dev/tty` script would have kept it. The script's header already said it was gavin's file and not to be edited.

There were no byte-exact tests of the script. These are new:
- `the_hook_script_rings_kimis_pty_from_a_detached_hook` (unix). A fake kimi gets a real PTY as its controlling terminal. It starts the script in its own session via perl's `setsid`, with stdio on /dev/null, and the test asserts a BEL arrives on the PTY master. I checked red/green with a Python prototype of the same setup: the old script produced no BEL, the new one did.
- `a_stale_hook_script_is_rewritten`.

### 2. Picker detection: decision = (a), a screen match in the daemon

What was measured (kimi 2.1.1 in a pty, screens rendered with the daemon's own vt100 model):
- AskUserQuestion picker footer: `↑↓ select  1-3 / ↵ choose  ←/→/tab switch  esc cancel`. It sat quiet for 57 s with no hook event.
- Approval dialog ("Run this command? Dangerous: recursive delete") footer: `↑/↓ select · 1/2/3/4 choose · ↵ confirm`. It sat quiet for 34 s.

Why (a) and not (b): (b) leaves the original symptom unfixed. The picker would read `idle`, and on a rail `idle` means the turn is done, so the rail would advance past a question nobody answered.

How it works: in `crates/daemon/src/server.rs`, `ASKING_ON_SCREEN` is a list of (opening, also) pairs. A visible row that, after trimming, starts with `↑↓ select` or `↑/↓ select` and also contains `choose` is a dialog footer. `spawn_heuristic_idle_timer` checks this at the one moment a quiet session would otherwise go `Idle`, right after the failure verdict and with the same lock order. If it matches, the session goes `WaitingForInput` and gets the same state a bare BEL gives it: renewed output, i.e. the human answering, is what ends it. Kimi sessions run under DistrustOsc133, so the quiet timer is the authority for them and this check runs.

Why a daemon constant and not per-profile patterns like `failure_patterns`: per-profile would need a new request type, and so a protocol bump, while v64–v69 are being worked on in this tree. The risk is also lower. A false failure is a verdict (rails pause, auto-resume relaunches), so failure text has to be verified per profile. A false match here is a badge. Anchoring the match at the start of the row keeps a source listing or diff that quotes the strings from matching. If a second agent ever needs its own footer, move this into the profile then.

The approval dialog is covered twice: the PermissionRequest hook rings at once, and the screen match is the fallback after 2 s of quiet.

Tests: `kimis_question_and_approval_footers_read_as_asking` (the captured rows, plus kimi's prompt and a quoted listing as negatives) and `a_quiet_session_under_a_dialog_footer_waits_for_input_not_idle` (end to end through the quiet timer).

Needs a daemon rebuild and restart before a real kimi tab shows the picker as waiting. The hook-script half needs only the rebuilt app, which rewrites `~/.kimi-code/gavin-attention` on the next kimi launch.
