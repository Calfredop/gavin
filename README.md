# Gavin

A desktop app for driving several AI coding agents at once, in real
terminals, without losing track of what each one is doing or what it was
asked to do. Work is a card on a kanban board that is a markdown file in the
repo, so the human and the agents share one view of it — see
`.gavin-root/PRD.md` for the full vision and the settled architectural
decisions.

Built for one developer running a fleet of agents across one or more repos.

## Layout

- `crates/protocol` — wire types shared by the daemon and every client.
- `crates/daemon` (`gavin-daemon`) — owns every PTY and all durable state
  (SQLite), watches `.gavin*/` for cards and plans, holds orchestration state.
  Survives the app closing or crashing.
- `crates/gavin-mcp` — the MCP server behind the `gavin_*` tools, so an agent
  can read and write the same board a human sees.
- `app/` — the desktop app: a SvelteKit SPA over a Tauri host. See
  [`app/README.md`](app/README.md).

## Building and testing

```
cargo test --workspace
cd app && npm test && npm run check && npm run build
```

`docs/dev-setup.md` has environment setup (Rust, Node) and a lower-level walk
through running the daemon and app standalone.

## Contributing

This repo is developed with AI agents in the loop; `CLAUDE.md` is the
workflow they follow and is worth reading before sending a PR — in
particular, the working tree conventions and the checks above.
