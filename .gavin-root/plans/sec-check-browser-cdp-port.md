---
order: 15360
kind: task
title: "[sec-check] An agent's headless browser keeps an unauthenticated loopback CDP port beside the secret-gated proxy, and the proxy secret travels in argv"
status: To Do
priority: low
complexity: complex
labels: security, ready-for-human
---
Decide, then fix or close, a needs-validation lead from the 2026-10-15 security audit (run-1). It is not confirmed: the audit traced it in source but could not observe a second OS account on the same host reaching Chromium's own DevTools port and attaching as a browser-level CDP client. Fingerprint: `crates/daemon/src/browser/launch.rs:launch_with:remote-debugging-port-loopback-cdp-unauthenticated`.

Full record: `NEEDS-VALIDATION.md` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

Each agent session's Playwright MCP is meant to reach its browser only through the daemon's CDP proxy. The proxy admits a websocket only on `/devtools/browser/<secret>`, where the secret is 32 random bytes compared in constant time; the proxy itself is sound. But the daemon launches the headless shell with `--remote-debugging-port=0`, so Chromium also opens its own DevTools HTTP and websocket listener on 127.0.0.1, and the daemon's screencaster dials that port directly. That listener takes no secret. `GET /json/version` hands out the browser websocket URL, and Chromium checks only the Host header (an IP or localhost) and an Origin header if one is sent; a client that sends no Origin passes both.

Loopback TCP has no uid check. On a host shared by several OS accounts, another local user can scan 127.0.0.1, find the port and attach as a full browser-level CDP client for as long as the session's browser runs. From there it can read the agent's pages and cookies, open file:// URLs the victim can read and read them back through Runtime.evaluate, or set a download directory so files land as the victim. Where Chromium has no usable sandbox (stock Ubuntu 23.10 and later), the daemon relaunches it with `--no-sandbox`, which widens that.

Secondary leak: the proxy secret travels in npx's argv (`--cdp-endpoint ws://127.0.0.1:<port>/devtools/browser/<secret>`). On Linux `/proc/<pid>/cmdline` is world-readable unless /proc is mounted with hidepid.

The likeliest shared host is an ssh workspace's machine: `gavin-daemon bridge` starts the daemon there, and that daemon runs the agents' browsers. The daemon already treats other uids as hostile on its socket (peer_uid_ok, the 0700 data directory), and agent_allows calls another session's endpoint "that agent's browser, cookies and all", so the browser is a resource the design protects. On a single-user machine the exposure needs another local account; a same-uid process is AD-1. `docs/security/05-remote-access.md:104` lists "Multi-user. One human, their own devices, their own daemon" as a non-goal, but that is written about remote access, not about the OS accounts on an ssh host.

## Trace (lines as of 2026-10-16; re-read before editing)

- `crates/daemon/src/browser/launch.rs:120` (launch_with, from line 111): `--remote-debugging-port=0`; the chosen port is written to the profile's DevToolsActivePort (read at 148). `--no-sandbox` is added at 127 when the machine has no usable sandbox (decided at 83-90).
- `crates/daemon/src/browser/mod.rs:317` (Inner::ensure_running): Launches the browser lazily on the session's first proxied connect and keeps it until the session ends or the browser dies. At 335 the screencaster dials Chromium's raw ws_url, so the raw port is live for the browser's whole lifetime.
- `crates/daemon/src/browser/mod.rs:257` and `:305` (secret, same_secret): 32 random bytes, compared in constant time.
- `crates/daemon/src/browser/proxy.rs:127` (proxy bind) and `:143` (serve): Binds 127.0.0.1:0 and admits only `/devtools/browser/<secret>` (PATH_PREFIX, line 31).
- `crates/daemon/src/server.rs:6862` (Request::PlaywrightEndpoint): The legitimate path, gated by agent_owns_session in agent_allows (7396-7397). The raw port bypasses it.
- `crates/protocol/src/playwright.rs:57` (mcp_args): The endpoint, secret included, becomes `--cdp-endpoint <url>` (61), exec'd by `crates/gavin-mcp/src/playwright.rs:72` (args), `:87` (Command::new(npx)) and `:132` (exec).
- `crates/daemon/src/bridge.rs:115` (connect_or_spawn): Starts the daemon on an ssh host; server.rs:6872-6873 says an ssh workspace's agents run Playwright on that host's daemon.

## What the audit could not observe

- The audit's sandbox could not run the pinned chromium_headless_shell-1243: it segfaulted at start before writing DevToolsActivePort, with the daemon's flags and with a reduced set. So the secretless `/json/version` and `Target.getTargets` against Chromium's own port were never observed.
- The cross-uid half needs a second OS account on the same host: whether a different uid connects to the 127.0.0.1 DevTools port, and whether this Chromium build answers `/json/version` and browser-target CDP to a client that sends no Origin.
- Whether the ssh hosts gavin users connect to have other login accounts, and whether /proc is mounted with hidepid there, is deployment, not source.

## The decision

- [ ] Decision: Are multi-account hosts (ssh hosts with other logins, Macs shared between OS accounts) in the threat model for an agent's browser?
  Options: A) Yes — launch Chromium with `--remote-debugging-pipe` so it has no TCP listener, and pass the proxy secret off argv. B) Only move the secret off argv now, and accept the raw port as AD-1 on single-user machines, recorded in docs/security. C) Accept both as AD-1 and record that in docs/security; no code change.

## After the answer

- **A.** Start the shell with `--remote-debugging-pipe` and hand it fds 3 and 4, as Playwright does when it launches Chromium itself. The daemon then owns the only CDP connection, so the proxy and the screencaster (mod.rs:335) both have to go through it: one CDP pipe shared by two clients means remapping message ids per client and routing events by sessionId. That multiplexer is most of the work, which is why the complexity here is complex. Then do B as well. Regression tests: a launch test asserts the argv has no `--remote-debugging-port` and that no DevToolsActivePort file appears; a proxy test drives two clients over the one pipe and checks each gets only its own replies. On a disposable Linux VM with two accounts, the audit's step 3 (bob scans alice's loopback for a DevTools listener) finds none.
- **B.** Move the endpoint out of `--cdp-endpoint` into an environment variable or a 0600 config file, whichever the pinned @playwright/mcp reads (check its `--help` and docs for that version before choosing); `/proc/<pid>/environ` is readable only by the same uid. Regression test in `crates/protocol/src/playwright.rs`: mcp_args never contains the secret. Then add the accepted residual to `docs/security/03-agent-surface.md`: "An agent session's headless browser listens on a loopback DevTools port with no secret for the browser's lifetime. Any process on the machine that can open loopback TCP can attach to it. Gavin accepts this on single-user machines (AD-1); on a host with other OS accounts, those accounts can drive the agent's browser."
- **C.** Add that same paragraph, plus one sentence on the argv secret ("the proxy secret is visible in the process table, so on Linux without hidepid any local account can read it"), to `docs/security/03-agent-surface.md`, and close the card.

## Done when

- The decision above is ticked, with the chosen option and the reason under a dated "## Comments" heading.
- For A or B: the regression cases named for that option are tests in the touched crate or module, they fail before the change and pass after it, and the checks in CLAUDE.md pass for every part you touched.
- For B or C: the accepted-residual text is in `docs/security/03-agent-surface.md`.
- You commit only your own files.
