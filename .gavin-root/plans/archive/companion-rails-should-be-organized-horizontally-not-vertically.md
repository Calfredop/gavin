---
order: 28672
kind: task
title: Companion: rails should be organized horizontally not vertically
status: Done
---
<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

**Done (2026-10-08).** The Rails surface pages sideways the way the Board does, and the way the desk sets its rails side by side: a strip of tabs, one per rail (its state badge and name, 44px), above a snap pager with one rail to a page. Each page scrolls its own rail down. Tapping a tab glides to that rail, and a swipe moves the strip with it (the Board's `columnAt`/`scrollBehaviour`). The surface opens on the running rail, else a paused one, else the first (`openingRail` in `phoneRails.ts`, tested). It keeps the rail the human swiped to across pushes. New rail goes to the new rail, ready to edit. `+page.svelte` mounts Rails straight into the column, as it does Board, so the pager gets the height. Measured in WebKit at 402x874 on the Demo Workstation: the page is 402/402 wide, the pager is 804 for two rails, tap and swipe stay in step, the editor page is 402/402, and New rail lands on page 3.

- [ ] Human test: on the phone, open Rails in a workspace with two or more rails, swipe between them and tap their tabs
