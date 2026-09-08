---
kind: task
title: [sec] dependencies, build & release
parent: review-security-audit.md
complexity: moderate
---
Audit what gavin ships that gavin did not write, against `docs/security/00-threat-model.md` (read it first), and write `docs/security/04-supply-chain.md`.

## Dependencies

- Run `cargo audit` and `cargo deny check` over the workspace. Neither is installed: install them with `cargo install --root <scratch dir>` (not into the global cargo home) and record the versions used. Run `npm audit` in `app/`. Save every raw output under `docs/security/04-supply-chain/` and summarise in the report — do not paste raw output into the report body.
- For the load-bearing dependencies, one paragraph each on what it is trusted to do, how it is pinned, and whether the lockfile pins it: `portable-pty`, `rusqlite` (bundled SQLite or system?), `notify`, the vt100/screen crate behind `screen.rs`, every `tauri-plugin-*` in `app/src-tauri/Cargo.toml`, `marked`, `dompurify`, `@xterm/*`, `@codemirror/*`.
- Note any dependency with a build script or a native download step, and any git or path dependency.

## Build and release

- **`.github/workflows/` does not exist on `main`.** `ci.yml` lives only on `Feat/multi-os-support` (commit `7a03dcc`, and `a538312` for the bundle work). Audit that file there — `git show Feat/multi-os-support:.github/workflows/ci.yml` — for third-party actions and their pinning (tag vs SHA), secrets, `pull_request_target`, and write permissions. State as a finding that `main` currently has no CI at all.
- `app/src-tauri/tauri.conf.json` has no signing or notarization configuration and `beforeBuildCommand` builds `gavin-daemon` and `gavin-mcp` into the bundle. State what an unsigned bundle means on macOS, Linux, and Windows, and what a compromised build machine could ship (the daemon and the MCP server travel inside the app).
- `tauri.conf.json` `build.devUrl` is `http://localhost:1420`: what a dev build exposes on the loopback interface, and whether anything on the same machine can reach the vite server or its HMR socket.

## Rules

- Tool output is the evidence here; no reproduction against a daemon is needed.
- Nothing is installed globally, nothing is upgraded, no lockfile is modified.
- **Mark each finding** `vulnerability` or `boundary`.

## Output

`docs/security/04-supply-chain.md`: a findings table (id, severity, adversary, vulnerability/boundary, evidence), then one section per finding, with the raw tool output filed alongside under `docs/security/04-supply-chain/`. Do not fix anything. Do not file cards — the parent plan does that after the dedupe pass.
