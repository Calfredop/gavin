---
order: 9216
title: Queued follow-ups delivered on idle
status: To Do
priority: high
---
Let the human queue a follow-up for a busy agent session and have the daemon deliver it when the session goes idle, instead of typing into the middle of its turn.

Today "Send to workspace agent" (`cardRunActions.ts`) bracket-pastes immediately over `Request::WriteInput`. The queue lives in the daemon so it survives the app closing; the tab shows the pending messages, reorderable, with a "send now" override. This is a new request type, so the compat gate covers it per type.

Borrowed from Cursor's queued messages + non-interrupting steering (2026-09-03 feature scan).
