---
order: 9216
title: Queued follow-ups delivered on idle
status: Done
priority: high
---
Let the human queue a follow-up for a busy agent session and have the daemon deliver it when the session goes idle, instead of typing into the middle of its turn.

Today "Send to workspace agent" (`cardRunActions.ts`) bracket-pastes immediately over `Request::WriteInput`. The queue lives in the daemon so it survives the app closing; the tab shows the pending messages, reorderable, with a "send now" override. This is a new request type, so the compat gate covers it per type.

Borrowed from Cursor's queued messages + non-interrupting steering (2026-09-03 feature scan).

## Decisions

- **The daemon owns the queue.** A SQLite table keyed by session id, so a
  queued follow-up survives the app closing — the same reason every PTY
  lives there. The app holds a mirror it can re-read, never the truth.
- **Four new request TYPES**, so `min_version_for` gates the whole feature
  and an older daemon never receives a byte of it: `QueueInput`,
  `ListQueuedInputs`, `SetQueuedInputs` (the surviving order — one writer
  covers reorder, cancel and clear) and `SendQueuedInput` (the override).
  `PROTOCOL_VERSION` → 29 (written as 26; the queue landed after three
  other bumps).
- **`ListQueuedInputs` answers for every session at once.** The push is
  routed to a session's attached writer like `StatusChanged`, so a
  frontend that reloaded has already missed it; a push-fed map with no
  read-back is the `gitStatusById` bug again.
- **Delivery happens on `idle` and on nothing else.** Not
  `waiting_for_input`: an agent asking the human a question would get an
  unrelated follow-up as its answer. Not `failed` or `exited`: there is
  no turn to follow up on. And **never into an `interrupted` session** —
  after a daemon restart that tab holds a bare shell, and delivering a
  prompt there would run the human's English as a shell command.
- **One item per idle.** A follow-up is a turn; the rest wait for the
  next one.
- **The queue stores plain text.** The daemon wraps it in bracketed paste
  and a CR at delivery, because the queue is a list the human reads and
  escape codes are not a message.
- **`daemonCompat.ts` owes an entry.** Against an older daemon `QueueInput`
  never reaches the wire, so a queue would look accepted and never
  arrive; every surface that can queue reads `featureBlockedReason`.

## Checklist

- [x] Protocol: `QueuedInput`, the four request variants, the `QueuedInputsChanged` push, the `min_version_for` arm, and `PROTOCOL_VERSION` 29 with its rationale
- [x] Daemon store: a `queued_inputs` table with append / read / reorder-and-prune / take-head, covered on a fresh DB and on one written by an older build
- [x] Daemon delivery: `deliver_queued_if_idle` at the idle transition and on enqueue, the four request handlers, and the Attach baseline
- [x] Tauri host: the four commands, the `queued-inputs-changed` relay, and a bootstrap read-back
- [x] `queuedInput.ts`: the pure module — ordering, move, the labels and the reasons a queue refuses — with unit tests
- [x] App state: `backend.ts` wrappers and a `queuedInputsById` store, baselined on bootstrap and patched by the push
- [x] `daemonCompat.ts`: `queuedFollowUps: 29` plus a `featureBlockedReason` consumer on every surface that can queue
- [x] Terminal pane: the follow-up queue strip — compose, reorder, send now, cancel
- [x] `sendToMainAgent`: queue instead of pasting when the workspace agent is busy
- [x] Suites green (`cargo test --workspace`; `npm test`, `npm run check`, `npm run build`) and the smoke items filed in `smokeChecklist.ts`
