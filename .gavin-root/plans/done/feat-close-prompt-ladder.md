---
order: 11264
kind: plan
title: [feat] Close prompt: a ladder from this window to stopping the daemon
status: Done
priority: normal
---
Closing the main window asks one question with one tick-box ("End every
terminal session too") and then destroys **only that window** — since
`162e5a9` gave each workspace a window of its own, the others are left
standing and the app keeps running. There is also no way to say "stop the
daemon" from here at all; the only route is Settings > Restart daemon,
which respawns it.

Replace the tick-box with a severity ladder the human picks one rung of:
this window / every window / every window + end sessions / that + stop the
daemon. One question, four outcomes — two prompts in a row is how a human
learns to dismiss the second unread, which is the doctrine `appClose.ts`
already states.

Sessions are swept **before** the daemon stops: `endEverySession()` ends an
orphan through its registry row, and stopping the daemon first deletes the
only thing that knows how to reach that process.

Design agreed in chat 2026-09-17. No protocol bump — no daemon request
type changes, so nothing is owed to `FEATURE_MIN_VERSION`.

- [x] `dialog.ts`: picker gains `expanded` + per-option `detail` + `default`; `ConfirmAnswer` gains `picked`; add `askConfirmPicked`
- [x] `ConfirmPrompt.svelte`: render an expanded picker as radios; `AppDialog.svelte` threads `picker` through
- [x] `appClose.ts`: `CloseScope` ladder as data, and the rung -> actions mapping
- [x] `stop_daemon` host command in `session.rs`, in `GATED_ACTIONS`, no respawn
- [x] `close_all_workspace_windows` in `workspace_window.rs`, leaving main alone
- [x] Wire `+page.svelte`'s `onCloseRequested` to the ladder's decision
- [x] Confirm button is `danger` past rung 1, so Enter cannot fire it by reflex
