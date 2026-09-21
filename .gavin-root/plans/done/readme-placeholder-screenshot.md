---
title: Swap the README screenshot for a placeholder
status: Done
complexity: simple
---
The root README's hero image (`docs/images/screenshot-agents.png`) is a capture of the owner's real workspaces — private project names, branch names and terminal contents. Replace it with a placeholder that shows the app's shape with invented data.

- [x] Draw `docs/images/screenshot-placeholder.svg` — a mock of the agents view in the app's own theme tokens, every name fictional
- [x] Point `README.md` at it and delete `docs/images/screenshot-agents.png`
- [x] Pre-flight: no remaining reference to the old file; the SVG renders

Note: the old PNG is already on `origin/main` (e2a3320). Deleting it from the tree does not remove it from history — purging is a separate, owner-only decision.
