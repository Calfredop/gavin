---
kind: task
title: A session's owner is told when the desk injected input into it
status: To Do
priority: low
attachments: docs/superpowers/specs/2026-10-09-session-ownership.md,crates/daemon/src/ownership.rs,app/src-tauri/src/session.rs
complexity: moderate
---
Follow-up from `companion-session-ownership-lock-and-handoff.md` (decision 2, deferred there; spec section "Gaps, on purpose").

Rails, auto-resume, the follow-up queue's delivery, Best-of-N and `gavin_*` MCP calls are exempt from the session lock: the daemon never refuses an input request that arrives on a desk connection. The card asked for a one-line notice on the OWNER's lock-free terminal when that happens ("the desk sent input"), so a phone working a session is not surprised by a line it did not type.

The daemon cannot tell those writes apart today. A Device's own forwarded `write_input`/`queue_input` reaches the daemon a second time as the desk host's `WriteInput`/`QueueInput`, on the same desk connection a rail's queue uses, and neither names a Device. Telling them apart needs the desk host to mark the writes it makes on a Device's behalf (`forwarding::origin` already knows, per call). That is a widened payload or a new request TYPE, so it carries the compat trap in CLAUDE.md: a `FEATURE_MIN_VERSION` entry and a consumer.

Build: the daemon notes desk-injected input into a Device-owned session and pushes it (or folds it into `SessionOwnerChanged`). The Companion's terminal shows one dismissable line ("The desk sent a line into this session"). Seam 1 proves that a rail-style `QueueInput` on a desk connection produces the notice and a forwarded Device write does not.
