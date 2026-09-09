# `app/`

The Gavin desktop app: a SvelteKit SPA (`src/`) rendered inside a Tauri host
(`src-tauri/`). The SPA is the whole UI — kanban board, git panes, terminals,
orchestration rails, the file viewer; Tauri supplies the window chrome and a
`invoke`-based command surface that shells out to `gavin-daemon` (PTYs,
SQLite, the `.gavin*` watcher) over `daemon.rs`/`session.rs`. See the root
`CLAUDE.md` for the workspace this app belongs to and the traps that bite
across both halves.

## Layout

`src/lib` is organized by domain, not by file type — a folder holds a
domain's logic, its components and its tests together. See
[`src/lib/README.md`](src/lib/README.md) for the full map; `core/backend.ts`
is the one file that names the daemon RPC surface, `core/` and `ui/` are what
every other folder is allowed to import.

`src-tauri/src` is the Rust host: `daemon.rs` and `session.rs` own the
connection to `gavin-daemon`, the rest is native surface the webview can't
provide itself — git, the file viewer, agent profiles, the window chrome.

## Commands

```
npm run dev      # vite dev server, browser or `tauri dev`
npm run check    # svelte-kit sync && svelte-check
npm test         # vitest
npm run build    # SPA build (adapter-static)
npm run bundle   # tauri build — the shipped app
```

Run these from `app/`, not the repo root. `cargo test --workspace` from the
repo root covers `src-tauri` along with the rest of the Rust workspace.
