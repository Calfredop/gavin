# The Companion drives the running desktop app, not the daemon

`docs/security/05-remote-access.md` has the Companion talk to the daemon under a narrow remote role. But most of Gavin lives in the desktop app, not the daemon:

- Of the 211 Tauri commands, only 57 are thin proxies to a daemon `Request`.
- Git (58 commands), the file viewer, the `config.json` settings, agent profiles and PR status run only in the Tauri host.
- The rail scheduler (`orchestrationState.ts`) and card-run launching (`cards/cardRun.ts`, `cardRunActions.ts`) run only in the desktop webview.
- The workspace list exists only in `config.json`.

A daemon-only Companion would be a terminal viewer, and moving all of that into the daemon would mean rewriting working TypeScript in Rust for the sake of the phone.

We decided that the Companion requires the desktop app to be running, with its window possibly closed, and that it reuses the desktop's `backend.ts` unchanged: `invoke` and `listen` are replaced with remote versions. A call travels Device → Relay → daemon → desktop app, runs as the same Tauri command, and its result and events travel back the same way. The daemon stays the gate. It checks every forwarded call against a table that maps each Tauri command name to the Remote role's allowance, and a test fails when a registered command is missing from that table.

## Consequences

- The desktop app gains a keep-running mode: while remote access is on, closing the window leaves a menu-bar icon instead of quitting. It also prevents idle sleep while an agent is running.
- The Companion must never start the rail scheduler, which `orchestrationState` would otherwise start; if it did, every rail would launch twice.
- §6 of `05-remote-access.md` (a capability table keyed by daemon `Request`) is superseded by the command table.
- When the desktop app is not running, the Companion can show only that it is unavailable.
