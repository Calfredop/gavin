---
order: 1024
kind: note
labels: memory
title: A component's CSS can be the raw .svelte file
status: Done
---
Before believing a CSS bug in the running dev app, check what the dev server actually served for that component:
`curl -s "http://localhost:1420/src/lib/X.svelte?svelte&type=style&lang.css" | grep -o 'const __vite__css = ".\{0,80\}'`
— if it starts with `<script`, every rule in that component is missing. `touch` the file to fix it.

Why: vite-plugin-svelte's `load()` returns the compiled CSS from a cache it fills during the component's transform. On a miss (the server restarted in-process since the page loaded — which `vite-cache-guard.sh` does on purpose) it returns nothing, and vite's default loader serves the .svelte file itself as the stylesheet. On 2026-09-07 that made the Git tab's left column read a size larger than the middle one, with nothing wrong in GitNav.svelte; nine components were in that state at once. A bundled build never is.

**The browser does NOT discard it** — that was the wrong half, and it is the half that costs the time. WebKit's CSS parser error-recovers through the `<script>` and the markup, reaches the component's own `<style>` block, and applies those rules **with no scoping class on them**. They are global. So one component served raw restyles the *whole app*, and the component that looks broken is never the one that lost its CSS: MainAgentPanel's `.head { display: flex; align-items: center; text-transform: uppercase }` is what laid the card detail modal's head out in a row, in capitals, with the title overlapping the file path. Measured in a throwaway WKWebView probe against the real files.

**Fixed at the source 2026-09-07** — `app/vite-svelte-style-cache.js`, wired in `vite.config.js`: a `pre` hook transforms the component before vite-plugin-svelte's `load()` runs, so the cache is warm; a `post` hook answers a still-cold cache with an *empty* stylesheet rather than letting vite's fs fallback hand over the file. Pinned by `viteStyleCache.test.ts`. Needs one dev-server restart to take effect.
