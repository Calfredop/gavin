---
order: 3072
title: [rework] sidebar rework
status: Done
---
- [x] move "Gavin" app home item in the bottom of the bar, first item, with a not full width divider after it
- [x] add collapse (not hide) sidebar button in right portion of the first row of the side bar (where system action buttons resides (close, expand...))
- [x] add an open workspace action (replace add workspace action in the workspace item, see below) in the far right of the top row of the sidebar (same row of prev item)
- [x] in same row add search workspace action, that makes a search input spawn in second row of sidebar. It should search in (sort results by this order): workspaces names, pages names, sessions names
- [x] remove "Workspaces" row
- [x] in app settings add a voice to deactivate the scratchpad
- [x] in workspace row, disable kanban badge hover, it's annoying. Just show the tooltip like we do for other badges.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
