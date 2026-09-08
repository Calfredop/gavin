---
order: 6144
kind: task
title: [bug] app hub no longer opening
status: Done
---
Pressing the 'Gavin' item in the sidebar, make a blank bar appears in the main area, but the app hub is not showing. The current content keep showing instead.

## What the symptom is

That shape is a half-applied update, not a dead button. Svelte builds the
new branch of an `{#if}` before it tears the old one down
(`BranchManager.ensure()` renders at the anchor, then `#commit()` destroys
the rest), so a component that throws while it is being CREATED abandons
the update with the previous branch still on screen — while the chrome row
above, a separate block that already committed, flips to the shape of a
branch that never appeared. Reproduced in WKWebView on the app's own
svelte: the old content stayed, nothing was thrown to the caller and
nothing was logged.

## What was done (12fec9c)

`+page.svelte` now draws every view under one `<svelte:boundary>`: a view
that cannot be drawn says what broke and offers Try again, instead of
leaving the last one up under a blank bar. Verified in WKWebView. The two
daemon banners stay outside it, and the boundary stays inside the `ready`
branch (svelte 5.56 fails a boundary created outside a batch);
`viewBoundary.test.ts` pins both.

## What is still open

The build itself renders the hub correctly against a faithful copy of this
machine's real workspace state — layout, boards, trees, rails, sessions,
git, usage — in both WebKit and Blink, so the throw could not be
reproduced from source. The window it was reported in had been open 4h on
a dev server up 4 days, through ~40 commits of hot reloads, which points
at a module in that window no longer matching the source.

**Next step is one press:** open the hub again. It now names the error on
screen and logs the stack to the console. If it draws instead, the reload
of `+page.svelte`'s module cone that came with this fix was the cure, and
the card can close.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
