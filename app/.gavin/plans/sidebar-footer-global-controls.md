---
title: Sidebar footer for global controls
status: In Progress
priority: medium
labels: ui
---
A pinned footer on the sidebar for app-global controls. Currently the
theme switcher plus an inert Settings slot.

Fixes a real seam: the theme is app-global but its control lived in the
per-workspace Settings hub view, with a hint apologising for it.

- [x] Move the scroll from `.sidebar` to `.workspace-list` so header and
      footer pin (today the whole sidebar scrolls, header included)
- [x] `.sidebar-footer` with an inert Settings row
- [x] Theme segmented control — Sun / Moon / Monitor, `aria-pressed`
- [x] Remove the Appearance section from `SettingsHubView.svelte`
- [ ] Verify both themes; `npm test` + `svelte-check` green

Built on SP1's tier-2 tokens. The three icon buttons are shaped to fold
into SP2's `IconButton` mechanically.
