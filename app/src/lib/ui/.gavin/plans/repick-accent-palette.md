---
kind: note
title: Re-pick accent PALETTE for two-theme legibility
status: To Do
priority: low
labels: ui
---
`settings.ts:17` documents that the eight accent swatches were "chosen to
stay legible against the #1e1e1e/#2a2a2a chrome." That premise breaks on a
light surface.

Deliberately kept out of SP1 (spec §4.3): changing these alters a value
users have already chosen and persisted, so it wants its own visual pass
against both themes rather than being folded into the token work.
