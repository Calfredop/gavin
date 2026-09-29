---
order: 36864
kind: note
title: Outside Tauri the window label is "main", which runs rails
labels: memory
status: To Do
---
Any page that loads the desktop's orchestration modules outside a Tauri
window runs the rails, unless it answers `getCurrentWindow().label` with a
label of its own: `currentWindowLabel()` falls back to `"main"`, and every
fetch, refresh and push of a plan calls `tick()` by hand, gated only by
`runsRailsFor`.

Why: not calling `startScheduler` is not enough to keep a second client
from launching every step twice. `app/companion` carries the label
`"companion"` through its `@tauri-apps/api/window` shim for this reason.
