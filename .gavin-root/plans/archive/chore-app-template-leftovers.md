---
order: 4096
title: Clear the Tauri template leftovers out of app/
status: Done
priority: medium
complexity: simple
---
Small, entirely cosmetic, and the highest ratio of impression to effort in the
repo: `app/` still identifies itself as a scaffold. These are the first things a
visitor sees and one of them is visible to every user of the shipped app.

- [x] `app/README.md` is the untouched scaffold — *"# Tauri + SvelteKit +
      TypeScript / This template should help get you started developing with
      Tauri, SvelteKit and TypeScript in Vite."* Replace it with what `app/`
      actually is: the SvelteKit SPA + Tauri host, how `src/lib` is laid out,
      the dev and check commands, and how it talks to the daemon.
- [x] `app/src/app.html` ships `<title>Tauri + SvelteKit + Typescript App</title>`.
      That is the **real window title** of the built app, not just repo dressing.
- [x] `app/package.json` has `"name": "app"` and `"description": ""`. Name it
      `gavin-app` (or whatever the bundle wants) and describe it in one line.
- [x] `app/static/` carries `vite.svg`, `svelte.svg` and `tauri.svg`, none of
      which is referenced anywhere in `src` or `tauri.conf.json`. Only
      `favicon.png` is used (`app.html`). Delete the three.
- [x] Decide on `app/.vscode/{extensions,settings}.json` — currently tracked, and
      also scaffold output. Keep them if they carry a real project setting;
      otherwise drop them.
      Kept both: `extensions.json` recommends svelte-vscode, tauri-vscode and
      rust-analyzer, which is exactly this repo's stack (SvelteKit + Tauri +
      Rust), and `settings.json` turns on `svelte.enable-ts-plugin`, a real
      non-default setting `.svelte` files need for TS checking. Neither is
      scaffold noise.
- [x] There is no `README.md` at the **repo root** either, and no `LICENSE` file
      despite `app/package.json` claiming MIT. Both are table stakes for a public
      repo. `docs/licensing.md` and `docs/licensing/` are uncommitted work in
      that direction — check with the owner before touching them rather than
      writing a second answer.
      Added a root `README.md`. Checked with the owner on the `LICENSE` half:
      they chose to leave it (and `app/package.json`'s `"license": "MIT"`)
      untouched for now rather than have this card write a second answer
      ahead of the in-progress `docs/licensing.md` work.
- [x] Untracked but present in the source tree: `app/src/.svelte-kit/` and
      `app/src/lib/.svelte-kit/` — stray `svelte-kit sync` output from being run
      with the wrong cwd. Ignored by the root `.gitignore`, so they are only
      local litter, but they sit inside the directory the guard tests glob.
      Delete them and confirm `npm run check` regenerates only `app/.svelte-kit/`.
      Neither stray directory was present in this checkout (worktrees don't
      share uncommitted litter). Ran `npm run check` and confirmed it
      regenerates only `app/.svelte-kit/` — 0 errors, no new `.svelte-kit`
      elsewhere in the tree.

Nothing here changes behaviour except the window title, which changes it for the
better.
