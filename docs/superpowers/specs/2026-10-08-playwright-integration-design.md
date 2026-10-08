# Playwright integration — design

Date: 2026-10-08
Card: `.gavin-root/plans/playwright-spike.md` (nested in
`feat-tbdeveloped-playwright-integration.md`)
Machine: macOS 26.6.2 arm64, Node 22.22.3, `@playwright/mcp` 0.0.83, Chrome
Headless Shell 153 (revision 1243, already cached) and 155 (revision 1247,
installed by the spike). Throwaway spike code lived in the session
scratchpad: Node harnesses for the MCP and a second CDP client, a Node
prototype of the proxy, and a Rust `tungstenite` proxy plus screencast
client. None of it is in the repo.

Every answer below says what was run. Anything not run on this Mac is marked
**UNVERIFIED**, and the broker card's CI is what proves it.

## Settled in the interview (2026-10-08): not reopened here

- **What:** the Playwright **MCP server**. Not the test runner, and not the
  CLI or skill.
- **Init and catchup:** a new **optional** setup-wizard step, `playwright`,
  placed after `headroom`/`memory` among the tooling steps. It detects per
  profile and offers Install or "Not now". "Not now" is remembered per root
  and counts as settled. Workspaces that existed before the step are prompted
  once by the Home setup banner, not forever.
- **Every stock agent profile** with an MCP layout gets the server entry, in
  the same file and format gavin writes its own entry to.
  - Custom profiles fall back to the human's word, as agent skills do.
  - The AG-07 foreign-server chooser must recognise the entry as gavin's.
- **One headless Chromium per agent session**, launched by the daemon on the
  agent's first Playwright call.
  - The MCP entry runs a `gavin-mcp playwright` shim. The shim asks the
    daemon for its session's browser (`GAVIN_SESSION_ID`), then execs a
    **pinned** `@playwright/mcp` with `--cdp-endpoint`.
  - The browser dies with the session.
- **Live view:** CDP screencast frames, streamed by the daemon.
  - The pane is **view-only**.
  - **When it opens is a setting.** *Open automatically* is the default and
    opens the pane beside the agent's tab on the first frame. *Open from the
    tab chip* opens it only when the tab's browser chip is clicked.
  - The setting is app-wide in Settings and overridable per workspace in
    workspace settings. The workspace override is stored as an absence, like
    terminal font size: absent inherits the app value, present replaces it.
  - Closing the pane only hides it; the chip always reopens it.
  - The Companion ignores the setting. There the view is always one tap
    away and never opens on its own.
- **Rail:** a new `builtin:browser-test-playwright`, "Browser test
  (Playwright)", with the same `url`/`checks` params.
  `builtin:browser-test` (Chrome) is untouched.
- **In scope:** the Companion live view, ssh workspaces (browser on the host,
  frames across the bridge), and macOS, Windows and Linux.
- **Assumptions:**
  - The `@playwright/mcp` version is pinned in gavin and bumped by hand,
    for supply-chain reasons.
  - The browser is headless, with no pop-out window.
  - Node/npx is a prerequisite that the step detects but does not install.

## The design in one picture

```
agent (PTY, GAVIN_SESSION_ID/TOKEN)
  └─ MCP entry "playwright": <gavin-mcp> playwright
       └─ asks the daemon: PlaywrightEndpoint { session_id }
       └─ exec: npx -y @playwright/mcp@0.0.83
                  --cdp-endpoint ws://127.0.0.1:<proxy>/devtools/browser/<per-session secret>
                  --output-dir <per-session dir>
                       │  (first tool call connects)
                       ▼
daemon ── CDP proxy (one listener) ── per-session Chromium (chrome-headless-shell,
   │        taps the MCP's commands      --remote-debugging-port=0, launched on
   │        to know the agent's tab      the first connection, relaunched after a crash)
   │
   └─ screencaster (a second CDP client on the same browser) follows that tab
        └─ WatchBrowser streams ─► desktop pane (local or across the ssh bridge)
                                 └► the app re-offers a small stream to the Companion
```

The one place this goes beyond the interview's wording: the endpoint the
shim hands `--cdp-endpoint` is **a daemon-owned proxy**, not Chromium's own
port. Three observations below force it:

- **The settled lazy launch.** A direct endpoint means launching Chromium
  when the MCP server starts, which is every agent start.
- **A browser that dies stays dead.** A direct endpoint is dead forever
  after a browser crash (Q2).
- **The view must follow the agent's tab.** A passive second client cannot
  see a tab switch (Q3).

The interview's shape is unchanged: the shim, the pin, `--cdp-endpoint`, one
browser per session dying with it.

## Q1. Which Chromium, where it lives, and how the CDP port is read

**The browser is Playwright's Chrome Headless Shell (`chromium-headless-shell`),
at the revision the pinned `@playwright/mcp` brings.**

- **Install.** The command is
  `npx -y @playwright/mcp@0.0.83 install-browser chromium-headless-shell`.
  - `cli.js` maps `install-browser` onto playwright-core's own `install`.
  - Run here, it installed revision **1247** (Chrome 155.0.8059.12) plus
    ffmpeg in **19 s**, using **208 MB** on disk.
  - It writes an `INSTALLATION_COMPLETE` marker into the revision folder.
  - The same command also warms npx's cache with the pinned package, so the
    agent's first start does not download it.
- **Why the headless shell and not full Chromium or the system Chrome.**
  - It is the smallest download (208 MB here).
  - It is what Playwright itself launches headless.
  - It has no first-run, profile or window chrome.
  - It is ours to version: the human's Chrome updates under us.
- **The pin.** `@playwright/mcp@0.0.83` was published 2026-09-28.
  - It depends on `playwright`/`playwright-core`
    `1.64.0-alpha-1790635538000`, whose `browsers.json` names
    `chromium-headless-shell` revision `1247`.
  - Every 0.0.7x and 0.0.8x release depends on a playwright *alpha*. That is
    how the package ships, not a reason to avoid 0.0.83.
  - Bumping the pin means changing both constants together: the MCP version
    and the headless-shell revision.
  - Over CDP the browser need not match Playwright's revision exactly. The
    spike drove the cached revision 1243 (Chrome 153) with 0.0.83 without
    a fault. That gives the daemon a safe fallback (below).

**Path discovery** follows playwright-core's own registry (`computeDefaultCacheDirectory`
and the `chromium-headless-shell` executable table, read from the 0.0.83 bundle):

| OS | browsers directory (unless `PLAYWRIGHT_BROWSERS_PATH` is set) | executable under `chromium_headless_shell-<rev>/` |
|---|---|---|
| macOS arm64 | `~/Library/Caches/ms-playwright` | `chrome-headless-shell-mac-arm64/chrome-headless-shell` |
| macOS x64 | same | `chrome-headless-shell-mac-x64/chrome-headless-shell` |
| Linux x64 | `$XDG_CACHE_HOME/ms-playwright`, else `~/.cache/ms-playwright` | `chrome-headless-shell-linux64/chrome-headless-shell` |
| Linux arm64 | same | `chrome-headless-shell-linux-arm64/chrome-headless-shell` |
| Windows x64 | `%LOCALAPPDATA%\ms-playwright` | `chrome-headless-shell-win64\chrome-headless-shell.exe` |

- **Verified here:** only the macOS arm64 row. Linux and Windows are copied
  from the registry's table and are **UNVERIFIED** until the broker's CI runs
  them.
- **`PLAYWRIGHT_BROWSERS_PATH`.** When set, playwright-core uses it instead
  of the default directory. `0` means the package-local folder, which is
  useless to us. The daemon honours the variable only from its own
  environment, so a shell-only setting is invisible to it. The install step
  therefore never sets it.
- **The daemon's lookup.**
  1. Use the pinned revision's executable if its folder has
     `INSTALLATION_COMPLETE`.
  2. Otherwise use the highest installed `chromium_headless_shell-*` that
     has the marker, and log that it is not the pinned one.
  3. Otherwise refuse, with the reason "Playwright's browser is not
     installed — run the Playwright step".

**The CDP port.** The daemon launches with:

```
chrome-headless-shell --remote-debugging-port=0 --user-data-dir=<per-session dir>
  --no-first-run --no-default-browser-check --window-size=1280,800 about:blank
```

It then reads `<user-data-dir>/DevToolsActivePort`:

- **Line 1** is the port.
- **Line 2** is the browser target's path, `/devtools/browser/<uuid>`.
- **The websocket URL** is `ws://127.0.0.1:<port><path>`. `/json/version`
  returns the same URL.

Measured launch to port file:

| case | time |
|---|---|
| a warm revision 1243 | 0.36 s |
| revision 1247 | 0.51 s |
| revision 1247 on its very first launch after download (macOS scanning the new binary) | more than 1 s |

The daemon polls for the file every 50 ms with a **20 s** ceiling. It reads
only once the file has two lines.

- **Why `--window-size=1280,800`.** Without it the headless viewport is
  800×600. The MCP connects with `noDefaults: true` and sets no viewport.
- **Pipe mode was considered and rejected.** `--remote-debugging-pipe` would
  keep the port off localhost entirely. But Windows needs inherited handles
  passed through `--remote-debugging-io-pipes`, which `std::process` cannot
  express. The port works identically on all three OSes, and the proxy's
  secret (Q6) is the door agents actually use.

**Processes.**

- One browser is 4 processes: the browser, GPU, network utility and a
  renderer. All of them share the browser's process group: launched under
  `setpgrp`, every child's PGID equalled the browser's pid.
- `kill -TERM -<pgid>` cleared all of them within 1 s.
- A **SIGKILL of the browser process alone** also left nothing behind on
  macOS: the children noticed the parent's death.
- Memory, as summed RSS over-counting shared pages:

| page | memory |
|---|---|
| idle on `about:blank` | 240 MiB |
| one Wikipedia article | 363 MiB |

  That figure is why the launch is lazy (Q2). An agent that never calls a
  `browser_*` tool must never cost a browser.
- The user-data-dir is about 5 MB. It is per session and deleted with the
  browser.

## Q2. Does the pinned MCP drive that browser over `--cdp-endpoint`?

Yes. Driven over stdio by a Node MCP client, with a second CDP client watching
`Target.*` events.

- **Context.** With `--cdp-endpoint` the MCP calls `connectOverCDP(...,
  { noDefaults: true })` and works in the browser's **default context**.
  - Its tabs had the same `browserContextId` as the `about:blank` page the
    browser was launched with, and it adopted that page as tab 0.
  - It creates no new context.
  - The tabs outlive the MCP process. A second MCP process connecting later
    listed the first one's tabs. So an agent whose MCP restarts finds its
    pages where it left them.
- **New tabs.** `browser_tabs {action:"new"}` creates a target in the default
  context, and it becomes `(current)`.
- **Popups.** Both `target=_blank` links and `window.open` produce a new tab
  in the list, but **the current tab stays the opener**. The agent has to
  `browser_tabs select` the popup to act in it.
- **Tab select** is `page.bringToFront()`, which sends `Page.bringToFront` on
  that page's CDP session (read in the 0.0.83 bundle's `selectTab`).
- **The browser dying mid-call.** A `browser_navigate` to a page that took
  8 s was in flight when the browser was SIGKILLed.
  - **The in-flight call** returned `isError`: `Target page, context or
    browser has been closed`.
  - **With a direct endpoint, every later call** returned `isError`:
    `connect ECONNREFUSED 127.0.0.1:<old port>`. The MCP reconnects on each
    call, but always to the endpoint it was started with, and a relaunched
    browser has a new port.
  - **Through the daemon proxy's stable endpoint**, proven with the Node
    prototype, the proxy relaunched the browser on the next connection. The
    very next `browser_navigate` succeeded on browser #2, with no restart of
    the MCP or the agent.
- **Lazy launch, proven through the proxy.**
  - Starting the MCP and answering `initialize` plus `tools/list` launched
    **no** browser.
  - The first `browser_navigate` connected and the daemon launched one, 0.36 s
    from connect to ready.
  - Claude Code starts every MCP server when the agent starts, so only a
    proxy can honour "launched on the agent's first Playwright call".
- **Snapshots write files into the cwd.** In 0.0.83, the page snapshot that
  every *action* tool returns is written to a file. Only an explicit
  `browser_snapshot` returns it inline.
  - The file goes to `<cwd>/.playwright-mcp/page-<timestamp>.yml`, and the
    cwd is the agent's repo. The spike's harness left 35 such files.
  - `--output-dir <dir>` moves them; the result then links a path relative to
    the cwd.
  - **The shim must pass `--output-dir`.** It points at a per-session folder
    under gavin's state directory, deleted with the session.
- **Startup cost** to answer `tools/list`:

| how the MCP is started | time |
|---|---|
| through `npx -y @playwright/mcp@0.0.83`, npx cache warm | 0.92–1.16 s |
| `node …/cli.js` directly | 0.29 s |

  npx is fine. The shim runs the pinned package through npx and does not
  vendor a copy.

**Version to pin: `@playwright/mcp@0.0.83`, with headless shell revision 1247.**

## Q3. Can a second CDP client follow the agent's tab with `Page.startScreencast`?

**Screencasting from a second client works. Following passively does not, so
the follow signal comes from the proxy.**

**What works passively.** The observer connects to the browser websocket and
calls `Target.setDiscoverTargets`. On each target it follows, it runs
`Target.attachToTarget {flatten:true}`, then `Page.enable`, then
`Page.startScreencast`, and acks every frame with `Page.screencastFrameAck`.

- It received frames for the MCP's page while the MCP drove it.
- `Target.targetCreated` reports a new tab.
- `Target.targetInfoChanged` reports every navigation, with the new URL.

**What a passive client cannot see.**

- **Tab selects.** After `browser_tabs select`, every page still reported
  `document.visibilityState === "visible"` and `document.hasFocus() === true`,
  because headless emulates focus. No `Target.*` event fired, and
  `Page.bringToFront` is never shown to other clients.
- **Actions that change the page without navigating**, on a tab the observer
  is not screencasting. A click that rewrites the DOM is one.

So the observer, following "the newest tab or the last navigation", showed
tab 1 while the agent worked in tab 0.

**The proxy fixes it exactly.** The MCP's `--cdp-endpoint` is the daemon's
proxy, which relays every message both ways and reads two things:

- **from the browser:** each `Target.attachedToTarget` event, giving the
  `sessionId → targetId` map the MCP is using;
- **from the MCP:** the `method` and `sessionId` of each command.

**The follow rule.** The agent's tab is the target of the newest MCP command
whose method is `Page.bringToFront`, `Page.navigate` or `Input.*`. A reply to
an MCP `Target.createTarget`, which is `browser_tabs new`, also moves the
follow to the `targetId` it returns. If the followed target is destroyed,
follow the most recently followed one that still exists.

**Evidence.** The Rust spike proxy, plain `tungstenite` with std threads,
carried a real `@playwright/mcp` session in this order:

1. navigate Wikipedia → `follow 746191E1 (Page.navigate)`;
2. `browser_tabs new` with playwright.dev → `follow 9A3856B9 (Page.navigate)`;
3. `select 0` → `follow 746191E1 (Page.bringToFront)`;
4. four PageDowns and a full-page screenshot, with frames from 746191E1;
5. `select 1` → `follow 9A3856B9 (Page.bringToFront)`.

Popups were not followed, which is correct: the MCP's current tab stayed the
opener. Every MCP call succeeded through the proxy, including a full-page
screenshot of a long Wikipedia article.

**The screencaster** is the daemon's own CDP connection to the browser,
separate from the MCP's:

- On a follow change it detaches from the old target and attaches to the
  new one, then starts the screencast.
- Each frame carries `metadata.deviceWidth/Height`. The URL and title come
  from `Target.targetInfoChanged`.
- Two screencasts on the same target at different sizes ran at once without
  interfering. That is what lets the phone have its own small stream (Q4).

## Q4. Frame size, rate, and what it costs; throttling

**Measured** at JPEG, `everyNthFrame` 1 unless noted, with each frame acked
on arrival. The sizes are decoded bytes; on the wire they are base64, which
is ×4/3.

| page and activity | max size, quality | frames | size per frame |
|---|---|---|---|
| idle page, any settings | — | **0** (frames come only on a visual change) | — |
| CSS animation + 16 ms counter, 800×600 | 1280×800, q80 | 58.6 fps | 8.3 KiB |
| same | 1280×800, q60 | 60 fps | 6.9 KiB (412 KiB/s) |
| same | 1280×800, q60, `everyNthFrame` 2 | 30 fps | 6.9 KiB |
| same | 960×600, q50, `everyNthFrame` 3 | 20 fps | 6.5 KiB |
| 200 coloured text rows, 800×600 | q80 / q60 / q40 | — | 67 / 46 / 36 KiB |
| playwright.dev, 1280×800, ten PageDowns | q60 | 3 frames in 63 ms (acks pace it) | 68 KiB, max 71 |
| Wikipedia article, 1280×800, ten PageDowns | q60 | 4 frames | 118 KiB, max 129 |
| Wikipedia, six `scrollBy` 600 px | 1280×800, q60 | 27 frames | 103 KiB |
| same, at the same time on a second client | 640×400, q50 | 29 frames | 28 KiB |
| playwright.dev, same scroll | 1280×800 q60 / 640×400 q50 | 8 frames | 50 / 15 KiB |

**What it means:**

- **The source is paced by acks.** Chrome does not send the next frame until
  the previous one is acked. Ack on arrival and an animated page runs at
  60 fps.
- **The real cost is bursts.** A typical agent action produces 1–5 frames,
  roughly 100–500 KiB. A spinner left on screen would stream forever at full
  rate unless throttled.
- **Every frame fits one NDJSON line.** The largest seen was 129 KiB, which
  is 172 KiB as base64. That is far under `MAX_LINE_BYTES`, 1 MiB.

**Throttling** (the daemon enforces all of it):

- **One screencast per (browser, size class)**, running only while at
  least one watcher of that class exists:
  - **desk:** 1280×800, JPEG q60;
  - **phone:** 640×400, JPEG q50.
- **The source rate.** The daemon delays each ack until `1/fps_max` has
  passed since the previous one, where `fps_max` is the highest rate any
  watcher of that class asked for. So Chrome itself never renders faster
  than someone is watching.
- **Each watcher** has its own writer thread and a single slot, so the
  newest frame wins. A slow watcher drops frames; it never queues them, and
  it never blocks the screencaster or another watcher.
- **Rates.** The defaults are the caps. Bandwidth is the worst case under
  continuous change; it is far less in practice, because idle sends nothing.

| watcher | size class | default and cap (`max_fps`) | worst-case wire rate |
|---|---|---|---|
| desktop, local workspace | desk | 8 | about 1.1 MiB/s on the local socket |
| desktop, ssh workspace (the app asks for less) | desk | 4 | about 550 KiB/s through `ssh` |
| Companion, through the desktop | phone | 2 | about 40–75 KiB/s |

- **The Companion's frames fit the Relay.** A phone frame of 15–28 KiB
  (20–38 KiB as base64) fits one Noise frame (`device_wire::MAX_PAYLOAD`, just
  under 64 KiB) and one Relay message (`relay::MAX_STREAM_MESSAGE_BYTES`,
  128 KiB). A larger one would still work, because `remote.rs` `carry`
  splits a reply across Noise frames.
- **The guard.** The daemon drops any frame whose base64 exceeds 768 KiB
  rather than risk the 1 MiB line. The next visual change sends another.

These numbers are proposals, measured on this Mac's loopback only. **UNVERIFIED** over a
real ssh link or a real phone link; the human tests on the parent card cover both.

## Q5. How the blocking, sync daemon speaks CDP's websocket

**With `tungstenite` 0.28, which the daemon already compiles.**

- `crates/gavin-relay` depends on `tungstenite = { version = "0.28",
  default-features = false, features = ["handshake"] }`, with no feature gate.
  The daemon builds `gavin-relay` with `client`, so `tungstenite`, `http` and
  `httparse` are already in its graph.
- The daemon adds the same line as a **direct** dependency. That adds no new
  crate to `Cargo.lock`.
- No TLS is needed; everything is `127.0.0.1`.
- No base64 crate is needed. Frames arrive base64 inside CDP's JSON, and the
  daemon forwards that string into its own push untouched.

**What the Rust spike proved** (`tungstenite::accept_hdr_with_config` +
`tungstenite::client::client_with_config` over `std::net`, std threads only):

- **The server side.** `accept_hdr_with_config` reads the request path in the
  header callback. A path other than `/devtools/browser/<secret>` is refused.
- **Relaying both ways.** Each accepted socket is split for full duplex:
  - after the handshake, `get_ref().try_clone()` the `TcpStream`, and wrap
    the clone with `WebSocket::from_raw_socket(clone, Role::Server|Client, cfg)`;
  - one thread reads the client and writes upstream, the other the reverse.
- **Sizes.** `WebSocketConfig { max_message_size: Some(256 MiB),
  max_frame_size: None }` matches Playwright's own 256 MiB `maxPayload`. A
  full-page screenshot of a long article went through.
- **The screencast client** is one thread on one socket with a 100 ms read
  timeout. It sends attach and start, acks each frame, and between reads
  checks whether the followed target changed.
- `set_nodelay(true)` on every socket.

**One risk the split carries.** Each half's `WebSocket` answers pings by
itself, so a ping arriving on the read half writes a pong from that half
while the other half may be mid-frame. Neither Chromium's DevTools server nor
Playwright's `ws` client pings, and none was seen. The broker still
serialises writes per socket behind a `Mutex` held only for one `send`. That
makes any pong safe for a few lines of code.

## Q6. The protocol

**Version.** The next free `PROTOCOL_VERSION` on `main` at landing: today
64, so **65**, unless another card lands first. This section writes `N`.

**`Request::PlaywrightEndpoint { session_id: String }` → `Response::PlaywrightEndpoint { endpoint: String, output_dir: String }`**

This is the shim's request.

- **Who may send it.** `agent_allows` lets an agent identity send it only for
  its own session (`agent_owns_session`). A local app may send it for any
  session; a Device may not (absent from `remote_allows`).
- **The daemon:**
  - resolves the headless-shell executable (Q1), and refuses with the
    reason if none is installed;
  - starts the proxy listener on first use, one per daemon, on
    `127.0.0.1:0`;
  - mints the session's proxy secret with `protocol::random_hex(32)`,
    stable for the session's life;
  - returns `ws://127.0.0.1:<port>/devtools/browser/<secret>` and the
    per-session output folder.
- **It does not launch the browser.** The first websocket connection does.
- **The gate.** It is a new request type, so `min_version_for` → `N` is the
  whole gate on the shim's side, and `gavin-mcp`'s `gate_request` refuses it
  against an older daemon. No app surface sends it, so it needs no
  `daemonCompat.ts` entry.

**`Request::WatchBrowser { session_id: String, size: BrowserViewSize, max_fps: u32 }`**

A streaming request, shaped like `RunGitStreaming`: it holds the connection
it arrives on.

- **`size`** is `desk` or `phone`. `max_fps` is clamped to the class's cap.
- **The daemon writes `Response::BrowserFrame` on that connection:**
  `{ session_id, seq: u64, data: String /* base64 JPEG */, width: u32,
  height: u32, url: String, title: String }`.
- **It ends with `Response::BrowserGone { session_id }`** when the browser
  ends. That covers the session ending, and the browser dying with no MCP
  connected to relaunch it.
- **Closing the connection unwatches.** No `UnwatchBrowser` is needed.
- A `WatchBrowser` for a session with no live browser **waits**. It sends
  nothing until the first frame of a browser launched later, so the pane can
  subscribe ahead.
- **Who may send it:** apps only. Agents have no use for it. Devices are
  refused, because they reach it through the desktop (below).

**`Response::BrowserChanged { session_id: String, browser: Option<BrowserInfo> }`**

`BrowserInfo { url, title, tabs: u32 }` is pushed with
`push_to_apps_speaking(N, …)` (the v62/v63 pattern):

- **`Some`** when a session's browser launches, its followed tab navigates,
  or the follow switches to another tab;
- **`None`** when it ends.

This is what lights the tab's browser chip, and it is what makes the auto
setting open the pane. The app subscribes with `WatchBrowser` and opens the
pane when the first `BrowserFrame` arrives.

**`Request::ListBrowsers` → `Response::Browsers { browsers: Vec<(String /* session_id */, BrowserInfo)> }`**

This is the read-back. Without it a reload hides a live browser's chip until
the next navigation, which is the trap the git chip fell into. Apps only.

**The compat gate.**

- **`min_version_for`:** `PlaywrightEndpoint`, `WatchBrowser` and
  `ListBrowsers` → `N`.
- **The new `Response` variants** go only to connections that declared ≥ N:
  - `BrowserChanged` through `push_to_apps_speaking`;
  - `BrowserFrame` and `BrowserGone` only on a connection that sent a
    `WatchBrowser`, which therefore speaks ≥ N.
- **The app side.** `app/src/lib/core/daemonCompat.ts` gets
  `FEATURE_MIN_VERSION.playwrightBrowser = N`, and the pane and the chip
  consume it through `featureBlockedReason`, so an older daemon shows why
  there is no view.
- **No existing request's payload is widened.**
- **The bump owes the v64 checklist:**
  - the doc paragraph above `PROTOCOL_VERSION`;
  - the version-pin test comment, `one_of_every_request_variant` and the
    histogram;
  - `agent_allows`.

**ssh workspaces.** The bridge is a byte pipe of the same NDJSON, so nothing
in it changes.

- The browser, the proxy and the MCP all run on the host. The agent and
  `gavin-mcp` already run there.
- The desktop's `WatchBrowser` connection rides the link like its other
  streaming connections, asking `max_fps: 4`.
- The desktop's reader that matches a session stream's pushes must learn
  `BrowserFrame` and `BrowserGone`. Today its catch-all `_ => {}` would
  silently drop them.

**The Companion.** A Device reaches session output only through the desktop
app re-offering events (`forwarding::emit` → `OfferDesktopEvent` →
`DesktopEvent` to listening Devices).

- **The phone view.** The phone invokes a desktop command (a new row in
  `REMOTE_COMMAND_TABLE`), and the app opens a `WatchBrowser { size: phone,
  max_fps: 2 }`. It emits each frame as a `browser-frame` event, which the
  existing relay carries to Devices listening for it.
- **No `remote_allows` change.** Devices still never send daemon requests
  directly.

## What the broker card must do

1. **The protocol (Q6).**
   - `PlaywrightEndpoint`, `WatchBrowser`, `ListBrowsers`, `BrowserFrame`,
     `BrowserGone`, `BrowserChanged` and `BrowserInfo`.
   - `min_version_for` → N, `agent_allows`, and the full bump checklist.
   - `FEATURE_MIN_VERSION.playwrightBrowser`.
2. **A `crates/daemon/src/browser/` module** (sync, std threads). It owns:
   - **Discovery (Q1):** pinned revision, then newest complete, then refuse.
     Pin constants `PLAYWRIGHT_MCP_VERSION = "0.0.83"` and
     `HEADLESS_SHELL_REVISION = "1247"` live in **`crates/protocol`** (no
     `os` feature needed), so the shim, the daemon and the app's install step
     read one pin.
   - **Launch:**
     - through `crate::program::command`, never `Command::new`;
     - `process_group(0)` on Unix;
     - the per-session user-data-dir under the daemon's state directory;
     - the flags from Q1;
     - `DevToolsActivePort` polled at 50 ms, with a 20 s ceiling;
     - stdout and stderr to a per-session log file, never a pipe nobody
       drains.
   - **The proxy (Q3, Q5):**
     - one listener per daemon;
     - per-session secrets;
     - lazy launch on the first connection;
     - relaunch when the browser is gone at connect time;
     - the follow tap;
     - writes serialised per socket.
   - **The screencaster (Q3, Q4):**
     - one per (browser, size class) while it has watchers;
     - ack pacing at the watchers' highest rate;
     - a writer thread per watcher with a newest-wins slot;
     - the 768 KiB guard;
     - `BrowserChanged` on launch, navigation, follow switch and end.
   - **Teardown with the session.** Hook `forget_session` (idempotent,
     reached from both `kill_session` and the pump's teardown):
     - group SIGTERM, then SIGKILL after 2 s, behind a `proc::still_running`
       identity check. Windows uses `proc::terminate`. Chromium's children
       follow their parent there too, **UNVERIFIED**;
     - delete the user-data-dir and the output folder.

     Also hook `Request::Shutdown` the way `close_headroom` is.
   - **No survivor across a restart.**
     - Persist `{ session_id, pid, started_at_us, dirs }` per live browser.
       This can be a small JSON file like headroom's run record, atomically
       written.
     - On `recover()`, terminate every recorded browser still running
       (identity-checked) and delete its folders.
     - A browser is never adopted.
3. **`gavin-mcp playwright`** (argv dispatch at the top of `main`, before
   the MCP loop):
   - **Session.** No `GAVIN_SESSION_ID` means exit non-zero with: "gavin's
     Playwright server runs only inside a gavin agent session
     (GAVIN_SESSION_ID is not set)."
   - **The endpoint.** Send `PlaywrightEndpoint` (authenticated with
     `GAVIN_SESSION_TOKEN`). If the daemon refuses, print its reason and exit
     non-zero.
   - **`npx` missing:** say so ("Node.js/npx is needed for Playwright — …").
   - **Exec** `npx -y @playwright/mcp@<pin> --cdp-endpoint <endpoint>
     --output-dir <dir>`:
     - **Unix:** a true `exec()`, so stdio passes straight through.
     - **Windows:** spawn with inherited stdio and wait, exiting with the
       child's code, as the re-exec handover already does. `npx` there is
       `npx.cmd`. Resolve it on `PATH` and run it through `cmd.exe /d /s /c`
       with the pin quoted. That is the CLI-shim trap the Windows port hit
       before; prove it in the Windows CI job.
   - **Forward any extra argv** after `playwright` to the MCP, so a human can
     add flags in their own entry.
4. **Tests.**
   - **A daemon integration test under a temp `$HOME`** (the
     `device_wire.rs` pattern):
     - start the daemon;
     - create a session;
     - `PlaywrightEndpoint`;
     - connect a minimal CDP client through the proxy and `Page.navigate` a
       `data:` URL;
     - `WatchBrowser` → at least one `BrowserFrame`;
     - kill the session → `BrowserGone`, and the pid is gone.

     The CDP client is a few lines of `tungstenite`, so the test needs no
     Node.
   - **Skip with a stated reason** when no headless shell is installed.
   - **CI on all three OSes** installs it first, with
     `npx -y @playwright/mcp@<pin> install-browser chromium-headless-shell`;
     on Linux, add `--with-deps`.
   - **Unit tests** for the follow rule, the ack pacing and the newest-wins
     slot, all over fakes.
5. **Done** also requires `gavin-mcp playwright` driving a page from a real
   Claude Code session against an isolated daemon.

## Notes for the other cards

- **install-wizard: the entry.**
  - Server key `playwright`. The command is exactly gavin's own entry's
    command (the binary or the launcher) with `args: ["playwright"]`.
  - For Cursor, the same `${env:…}` block as gavin's own entry, because the
    shim needs `GAVIN_SESSION_ID`, `GAVIN_SESSION_TOKEN` and
    `GAVIN_SESSION_SOCKET`.
  - The stock profiles with an MCP layout, read from `agent_setup.rs` on
    2026-10-08:
    - claude-code — `.mcp.json`
    - codex — `.codex/config.toml`
    - gemini — `.gemini/settings.json`
    - cursor — `.cursor/mcp.json`
    - opencode — `opencode.json`
    - kimi-code — `.mcp.json`
  - Recognise the entry as gavin's by key plus command plus
    `args[0] == "playwright"`. An existing `playwright` key with any other
    command is foreign: report it, and do not overwrite it silently.
- **install-wizard: the install and detection.**
  - The install command is `npx -y @playwright/mcp@<pin> install-browser
    chromium-headless-shell`, run on the host for ssh workspaces.
  - Detection is three checks:
    - `npx` resolves;
    - the pinned revision's `INSTALLATION_COMPLETE` exists in the Q1
      directory;
    - the entry is present.
  - On Linux, a missing system library only shows at launch. The broker's
    launch error carries Chromium's stderr tail, so surface that reason
    rather than guessing it up front.
- **live-pane:**
  - The chip and auto-open key off `BrowserChanged`, read back with
    `ListBrowsers`. Frames come from `WatchBrowser { size: desk, max_fps: 8 }`,
    or 4 for an ssh workspace. The URL shown is the frame's `url`.
- **companion-view:** the `browser-frame` desktop event, carrying
  `WatchBrowser { size: phone, max_fps: 2 }`, reached through a
  `REMOTE_COMMAND_TABLE` row. Held streams must keep being read.
