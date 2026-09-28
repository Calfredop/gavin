---
order: 7296
kind: task
title: Headroom 04: the setup surfaces
status: To Do
labels: ready-for-agent
parent: headroom.md
complexity: complex
---
Blocked by: headroom-01-daemon-runs-headroom.md, headroom-02-compressed-launches-claude-code.md

Part of `headroom.md`. Read the spec (sections "Detection and install", "The switch" and "Platforms") first.

## What to build

- **A Headroom section in the app-wide Settings** (`GlobalSettingsView.svelte`'s `SECTIONS`) showing:
  - the state (Verified, Too old, Absent, Unavailable with its reason), the version and the pin, with "newer than tested" when above it
  - running, stopped or failed, and the port
  - lifetime tokens saved
  - **Install** when `uv` is found (it calls 01's install and prefetch); otherwise the install command, **Locate…** and **Check again**
  - **Update** when the pin moves past the installed version. It asks first through `askConfirm`, never a native dialog, and says running compressed agents will retry once.
  - the app-wide default switch, starting Off
  - help text naming the one residual: commands an agent runs inherit its routing
- **The workspace switch** in the workspace Settings' Agent section (`SettingsHubView.svelte`). It shows Unavailable for an ssh workspace, and for a profile with no recipe it gives the reason: "Cursor sends everything through Cursor's servers — Headroom can't reach it", and Gemini's until 07.
- **A Headroom wizard step** after Superpowers in `SETUP_STEPS`. It offers On when Headroom is Verified and the install when it is Absent. Count it everywhere steps are counted, and do not let an unknown state read as absent (the setupProgress `pending` trap).
- The logic goes in a plain `.ts` module with unit tests; the `.svelte` files stay thin.

## Acceptance criteria

- [ ] Every state renders its own actions from the pure module (tested)
- [ ] The wizard's step count and done-ness include Headroom, and an unknown state is pending, not absent (tested)
- [ ] The Update confirmation uses `askConfirm`, and a `danger` choice keeps focus on the dismissing button
- [ ] `npm test`, `npm run check` and `npm run build` green
- [ ] Human test: on a machine without Headroom, Install from Settings finishes, the first compressed run does not stall on a model download, and the Settings section and wizard step look right

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
