---
order: 10240
title: [sec] sign, notarize, and bundle the sidecars
status: To Do
priority: medium
complexity: complex
---
**Severity:** Info today, Medium the day a build is distributed. Finding **R6** in `docs/security/README.md` (sources SC-06, SC-07, SC-08 in `04-supply-chain.md`). The report lives on branch `sec/review-2026090801` until merged.

**The problem.** `tauri.conf.json` has no `bundle.macOS.signingIdentity`, no `bundle.windows.certificateThumbprint`, no entitlements, and no `plugins.updater`: every target ships unsigned and un-notarized, so nothing distinguishes gavin's bundle from a modified one, and a compromised build host ships the daemon and the MCP server inside it. And on `main`, `beforeBuildCommand` compiles both sidecars but the bundle carries neither (no `externalBin`/`resources`), so a bundle from `main` fails at `resolve_daemon_binary_path`; the staging that works is only on `Feat/multi-os-support` (`tauri.bundle.conf.json`, commits `7a03dcc`, `a538312`).

**The fix**, gated on deciding to distribute:

- [ ] Land the sidecar staging from `Feat/multi-os-support` on `main` (or re-derive it: `externalBin` with target-triple-suffixed `gavin-daemon` and `gavin-mcp`) and confirm `daemon.rs::resolve_daemon_binary_path` and `agent_setup.rs`'s MCP path find them in a built `Gavin.app`.
- [ ] macOS: signing identity, hardened runtime, entitlements (the app spawns PTYs and reads the Keychain item for usage probes — list exactly what it needs), notarization in the release job; Windows: certificate; Linux: a signed AppImage or a repo with a key.
- [ ] `plugins.updater` with a pinned public key and a release endpoint; without it, every update is a fresh unsigned download.
- [ ] A release checklist in `docs/` that names the build host, the key custody, and the `--locked` build.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
