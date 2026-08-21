---
order: 11264
title: Workspace folder bar above the tabs; picking is settings-only
status: Done
priority: medium
---
The hub chrome currently reads tabs → folder bar → view, and the folder
bar carries two actions that belong in Settings: the ⚙ root picker and
the "Agent integration" setup row. Both are workspace *configuration*,
not per-page context.

After this the banner variant of `WorkspaceRootControl` is purely
informational — it tells you which folder you are in and shouts when
that folder is gone.

- [x] Move `<WorkspaceRootControl>` above `.tabs` in `+page.svelte`
- [x] Drop the ⚙ picker from the chip in the `banner` variant (kept in
      `settings`)
- [x] No-root / root-missing banners lose their pick buttons in `banner`
      and point at Settings instead (an "Open settings" jump, so the
      state is not a dead end)
- [x] Gate the "Agent integration — write .mcp.json…" row + its note to
      the `settings` variant only
- [x] Spacing pass so chip-over-tabs does not read as a stray line
- [x] `npm test` + `npm run check` green

Decision recorded as **D56** in
`docs/superpowers/specs/2026-08-20-workspace-settings-design.md` §2 — it
finishes D37's thought (Settings works unrooted *because* binding the root
is its job).

Verified: vitest 601 passed, svelte-check 0 errors in the four touched
files, and the change confirmed live in `npm run tauri dev` (path chip over
the tabs, no ⚙, no agent-integration banner on the Git tab).

- [x] Fix the long-standing bidi artifact the move made conspicuous:
      `.path` is `direction: rtl` for the left-side ellipsis, which left the
      leading `/` a neutral with no strong character before it — it resolved
      to the paragraph direction and parked at the far right, so
      `/Users/…/gavin` rendered as `Users/…/gavin/`. `&lrm;` bookends put
      the slashes inside the LTR run. (`unicode-bidi: plaintext` was the
      other candidate and is wrong here: it re-derives the base direction
      from the first strong character, which would send the ellipsis back
      to the right.)
