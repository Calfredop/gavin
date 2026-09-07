---
order: 5120
kind: task
title: UI refinements
status: Done
---
[x] move app context icon buttons in sidebar header (collaps, search, open folder). Make collapse state of sidebare go as narrow as item+reasonable padding. The system actions (expand, close, minimize) needs they own context, with the same height as the tabs bar. When in collapse state move collapse to the first row of the side bar and hide the other actions, so it fits in the same space as other items.
[x] make the window draggable when there's a modal open, instead of prompting for close confirm right away (dnd, vs click)
[x] git tab left col doesnt seems to follow the font size directive
    — no source change: GitNav declares 0.78em and measures the same as the
    middle column (10.1px) once its CSS is actually applied. What you saw was
    the dev server serving the raw .svelte file in place of the component's
    compiled CSS (vite-plugin-svelte's load() falls back to the file on a
    cache miss), which drops EVERY rule in that component — GitNav and eight
    other Git panes were in that state. Touching the files fixed the running
    windows; a dev-stack restart clears it for good, and a bundled build was
    never affected.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
