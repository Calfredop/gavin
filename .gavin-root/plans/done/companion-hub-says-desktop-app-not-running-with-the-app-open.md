---
kind: task
title: Companion: hub reads "Desktop app not running" while the desktop app is open
status: Done
priority: high
complexity: complex
---
Found on 2026-10-08 by `companion-iphone-smoke-tests.md` (C1 BLOCKED), on a physical iPhone 16 Pro paired with the owner's own Workstation `MBP16Pro` through a dev Relay (`ws://192.168.68.125:8445`).

**Observed.**
- 15:06 to 15:15: the hub row went `locked`, `connecting`, `connected as dev-58ecf56f9cacebe4`, `ready, 195 waiting` (console log lines `[gavin-hub] ws-b8b62138dff5ea6a: ...`). The signed-bundle path was never reached.
- About 16:00 onward, for at least 40 s of polling and several minutes in all: the row reads `Desktop app not running` / `It is on, but Gavin's desktop app is not running there, so nothing can answer.` and the inbox reads `Nothing is waiting on you.`
- The owner confirmed the desktop Gavin window is OPEN. It did not come back to Ready.
- On the Mac at the time: `target/debug/Gavin` pid 17949 (up 1h32) and the dev daemon pid 18197 (started 14:32:49, listening on `daemon-dev.sock`, 31 client connections, with an ESTABLISHED connection to the Relay at 192.168.68.125:8445). Three `gavin-relay` processes (ports 8443, 8444, 8445, the phone dials 8445).

**Where "not running" comes from.** `crates/daemon/src/server.rs` `get_attention` (about line 2300) answers `WorkstationState::DesktopAppNotRunning` in three cases, which look identical to the phone: (1) the `forwarding` slot is `None`, because the desktop never registered, or registered and dropped; (2) writing `ForwardAttention` to the desktop's connection fails; (3) the desktop does not answer within `recv_timeout(60s)` (or `DesktopGone`). `get_companion_bundle` has the same shape. So a desk that is attached but whose webview is not answering (a hidden or occluded window throttles timers, see the memory note on hidden webview timer throttling) reads as "not running" after a 60 s wait. A stale `forwarding` slot after a desk reload reads the same.

**What is NOT known (investigate first).**
- Which of the three cases it is. The macOS daemon has no log file (`daemon_log_file` in `app/src-tauri/src/daemon.rs` is `#[cfg(windows)]`), so nothing says when the forwarding connection was registered or dropped. A one-line log at register, drop, write failure and timeout would have settled this; add it.
- Whether the desk window was occluded or minimized or just not in front when this started, and whether bringing it forward fixes it.
- The desk's own Remote access status panel (companion-32 "relay status at the desk") was not read. It should say whether the desk is connected to the Relay.

**Related observations.** A third daemon, pid 77252, has been running since Oct 5 12:45 under an isolated test `$HOME` (`/tmp/gs-4mr7ltla/Library/Application Support/gavin/daemon-dev.sock`). It is a test daemon that was never reaped; check which test leaves it behind. It does not serve the phone.

**To do.**
- Reproduce: pair the phone, reach Ready, then occlude the desk window for more than a minute, or reload the desk webview, and watch the hub row.
- Log forwarding register, drop, write error and timeout in the daemon on every platform (a per-profile `daemon-dev.log` on macOS and Linux).
- Make the three cases distinguishable on the wire (`WorkstationState` variant or a reason string) and in the hub text: `The desktop app is open but not answering` is not `not running`. Do not shorten the 60 s wait in a way that turns a slow desk into a false "not running".
- Make the desk re-register its forwarding connection when the daemon says it has none.
- Hub text: say what to do ("Open Gavin on that Mac" vs "Bring its window forward").

**Acceptance.**
- [x] The daemon logs why it answered `DesktopAppNotRunning`, on macOS
- [x] A desk window that is open but occluded recovers to Ready without a restart, or the hub says so honestly
- [x] A test covers a desk whose forwarding connection dropped and came back
- [x] The leaked test daemon is traced to its test and reaped
- [ ] Human test: occlude the desk window, watch the phone, bring it back; the row returns to Ready

## Findings (2026-10-08)

**Root cause: none of the three cases the card guessed.** The desk's forwarding THREAD had died. At 16:17 the live dev daemon answered `GetAttention` with `desktop-app-not-running` in 0.00 s, so its slot was `None`. A `sample` of the app (pid 17949) showed no `gavin-forwarding` thread. The window state played no part: attention is answered in Rust from a snapshot, not by the webview.

Why it died: the old desk loop wrote `OfferDesktopEvent` (for every pty-output chunk, so constantly) and then took the NEXT message as that offer's `Ok`. The daemon writes `ForwardAttention` from the Device's own thread whenever the phone polls. An ask that landed in that gap was read as a malformed ack (`forwarding ack was ForwardAttention…`), and the thread returned. Nothing started it again: `forwarding::start` runs only on bootstrap and on reconnect, and both are triggered by the COMMAND connection failing. With a phone polling every 15 s and agents streaming output, that race is a matter of minutes, which fits Ready at 15:15 and not running from about 16:00.

**Fixed (uncommitted on main):**
- `app/src-tauri/src/forwarding.rs`: `serve` gives the connection one reader thread and acts on each message by kind; it never waits for an ack. Forwarded commands run on their own thread, so a slow command no longer blocks an attention or bundle ask. `keep_connected` redials an ended connection (1 s doubling to 30 s), reading the token afresh each time.
- `crates/daemon/src/server.rs`: every forwarded ask goes through `ask_desktop`, which returns a `NotRunningReason` and logs a timestamped `forwarding:` line at register, close, write failure, timeout and the first ask with nobody connected. A newer forwarding connection SHUTS the one it replaces, and a closing connection fails only its own waiters. The commands' 60 s budget is unchanged. Attention waits 8 s and the bundle 25 s, each under the shell's own wait (10 s / 30 s), so a silent desk comes back as `not-answering` rather than the phone dropping the connection.
- `protocol`: `Attention` and `CompanionBundle` gain an optional `reason` (`not-connected` / `connection-lost` / `not-answering`). Old shells ignore it, and old daemons send none. No version bump.
- Companion shell: `reason` is read and drawn: "Desktop app not running … Open Gavin at the desk." / "Desktop app not answering … quit and reopen it at the desk." / "Desktop app disconnected … it reconnects on its own".
- `app/src-tauri/src/daemon.rs`: on macOS and Linux the app now starts the daemon with its output going to the per-profile `daemon-dev.log` / `daemon.log`, as Windows already did.

**Tests:** desk `forwarding::tests` covers an ask landing between an offer and its Ok, and a connection that ends being dialled again and served. `server::forwarding_tests` covers each reason, plus a displaced desk being shut without failing the newer one. `device_wire` has `a_desk_whose_forwarding_connection_dropped_and_came_back_is_ready_again`, which also asserts the log lines. `cargo test --workspace` passes in a detached worktree (under a temp HOME, because this Mac's `require_local_token` switch fails ~25 unrelated `server::tests` as Forbidden), as do both wasm checks and companion-shell test/check/build (one pre-existing `bundle.e2e.ts` type error that this card does not touch).

**Live:** after `tauri dev` relaunched the desk (pid 88734), the same probe answered `ready, 207 items`, and the app runs `gavin-forwarding`, `-reader` and `-dispatch`. The desk half is live now. The daemon half (reasons, log lines, shutting a displaced desk) and the log file take effect only once the dev daemon restarts, which is the owner's call. Until then the running daemon is the 14:32 build and writes no log.

**Leaked daemon:** pid 77252 is reaped and `/tmp/gs-4mr7ltla` removed. It was NOT a committed test. Its environment shows it was started by `/opt/homebrew/bin/python3` with `HOME=/tmp/gs-4mr7ltla`, from a shell inside `npm run tauri dev`, on Oct 5 12:45. That makes it an ad-hoc harness an agent session ran in a Gavin terminal. Nothing in the repo uses a `gs-` prefix, and no surviving transcript names it. The committed harnesses (`nesting_smoke.py`, `device_wire.rs`, `devstack.mjs`) all reap their daemons.
