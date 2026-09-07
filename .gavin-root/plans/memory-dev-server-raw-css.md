---
order: 1024
kind: note
labels: memory
title: A component's CSS can be the raw .svelte file
status: To Do
---
Before believing a CSS bug in the running dev app, check what the dev server actually served for that component:
`curl -s "http://localhost:1420/src/lib/X.svelte?svelte&type=style&lang.css" | grep -o 'const __vite__css = ".\{0,80\}'`
— if it starts with `<script`, every rule in that component is missing. `touch` the file to fix it.

Why: vite-plugin-svelte's `load()` returns the compiled CSS from a cache it fills during the component's transform. On a miss (the server restarted in-process since the page loaded — which `vite-cache-guard.sh` does on purpose) it returns nothing, and vite's default loader serves the .svelte file itself as the stylesheet. The browser then discards the whole thing, so the component renders unstyled and inherits its parent's type size, while every other component around it looks right. On 2026-09-07 that made the Git tab's left column read a size larger than the middle one, with nothing wrong in GitNav.svelte; nine components were in that state at once. A bundled build never is.
