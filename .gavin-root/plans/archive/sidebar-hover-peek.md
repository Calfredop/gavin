---
title: Collapsed sidebar opens on hover
status: Done
complexity: simple
---
Peek the collapsed icon rail after a hover dwell. Setting in app Settings, default on.

- [x] Persist `gavin.sidebarPeekOnHover` in sidebarPrefs (default true)
- [x] Dwell/leave timers in sidebarPeek (open after hover, delayed close)
- [x] Wire Sidebar.svelte; click-peek still works; setting off keeps click-only
- [x] Checkbox in Settings → Sidebar
- [x] Unit tests for prefs + hover controller
