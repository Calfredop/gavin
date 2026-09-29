# Headroom: compressed agent sessions

Synthesised on 2026-09-28 from a grilling session. Read this beside `CONTEXT.md` (the glossary: Integration, Agent tooling, Headroom, Compressed session) and ADR 0007 in `docs/adr/`. The card is `.gavin-root/plans/headroom.md`; its tickets are `headroom-01` … `headroom-08`.

Headroom is `github.com/headroomlabs-ai/headroom` (Apache-2.0, Python with a Rust core, pre-1.0 and released roughly weekly). Every fact about it below was read from its source at v0.39.1 (commit `79daeb59`) and from the upstream Codex and Gemini CLI sources, not from its README. Where the two disagreed, the source won.

## Problem Statement

The human runs a fleet of agents on subscription logins (Claude Max, ChatGPT). What stops a rail is rarely the work; it is the 5-hour or weekly limit. Gavin already watches those limits (usage probes, a burn-rate projection, agent pause), but it can only slow the fleet down. It cannot make the same work cost less.

Most of what an agent sends its model is not the conversation. It is tool output: a `git status`, a test log, a JSON dump, a file read three turns ago that has since changed. Headroom sits between the agent and the model API and compresses that content on the way out, keeping the originals so the model can fetch them back.

Running Headroom by hand works for one terminal. It does not work for a fleet. `headroom wrap claude` rewrites the repo's `.claude/settings.local.json`, registers MCP servers in the human's `~/.claude.json` and creates `.serena/` in the checkout. Every agent Gavin launches, on every rail, in every worktree, would have to be wrapped. And nothing would tell the human whether it saved anything.

## Solution

Headroom becomes **agent tooling** that Gavin sets up and runs.

- **Setup.** The human installs Headroom from Settings or from the setup wizard with one button, the way Claude Code gets Superpowers. Gavin installs a version it has tested and fetches the compression model up front.
- **The switch.** Compression is on or off **per workspace**, with an app-wide default that starts Off.
- **Running it.** Each daemon runs its own Headroom and keeps it alive for as long as any workspace has compression on.
- **Compressed sessions.** In a workspace with compression on, every agent Gavin launches talks to its model through Headroom: Claude Code, Codex and opencode, plus a Custom agent whose API family the human names. Plain shell tabs are left alone.
- **Savings.** Every compressed session is tagged, so its savings land on the card run beside the tokens it spent, in the hub's economics for the current limit window, and as a lifetime total in Settings.
- **Honesty.** A session that should have been compressed and was not carries a mark saying why. A broken Headroom never stops a rail: the session relaunches uncompressed.

## User Stories

### Setting it up

1. As the human, I want to install Headroom from Settings with one button, so that I don't have to learn a Python packaging tool to get it.
2. As the human, I want Gavin to install a version it has tested, so that a bad upstream release doesn't reach my fleet on its own.
3. As the human, I want the compression model downloaded during setup, so that my first compressed run isn't a stall.
4. As the human, I want to point Gavin at a Headroom I installed some other way, so that a pip, Homebrew or virtualenv install still counts.
5. As the human, I want Settings to tell me plainly when Headroom is missing, too old or unavailable on this machine, so that I never see a green light for something Gavin cannot start.
6. As the human, I want to be offered an upgrade when Gavin tests a newer Headroom, and to be warned that running agents will retry once, so that upgrades happen when I choose.
7. As the human, I want the setup wizard to offer compression for a new workspace, so that I decide it once, where I decide the rest of the workspace.

### Turning it on

8. As the human, I want compression on or off per workspace, so that a repo where it misbehaves can opt out without turning it off everywhere.
9. As the human, I want an app-wide default, starting Off, so that installing Headroom never quietly changes how my existing workspaces talk to their models.
10. As the human, I want every agent launched in a compressed workspace to be compressed, whether it came from a card, a rail, Best-of-N, a hidden commit run or another agent over MCP, so that the whole fleet stretches the same limit.
11. As the human, I want my plain shell tabs left alone, so that my own project's tests don't have their API calls rewritten.
12. As the human, I want to name the API family a custom agent speaks, so that it can be compressed too.
13. As the human, I want Cursor's and Gemini's rows to say why they aren't compressed, so that I don't think the switch is broken.

### Seeing what it does

14. As the human, I want each card run to show the tokens Headroom saved beside the tokens it spent, so that I can tell whether it is earning its keep.
15. As the human, I want the hub's usage readout to show what was saved in the current limit window, so that I see it against the thing it is meant to stretch.
16. As the human, I want a lifetime total and Headroom's running state in Settings, so that I can see it is alive.
17. As the human, I want a tab marked when its session should have been compressed and was not, so that the exception is visible and the normal case is not noise.

### When it breaks

18. As the human, I want a launch to go ahead uncompressed when Headroom isn't ready, so that compression never stops a rail.
19. As the human, I want a failure caused by Headroom to be named as such and the session relaunched uncompressed, so that a broken Headroom doesn't become a retry loop across the fleet.
20. As the human, I want a session that claims to be compressed but sends Headroom nothing to be marked, so that a future agent CLI that stops honouring the routing doesn't leave a lying light.
21. As the human, I want agents that survived a daemon crash to keep their Headroom, so that restarting the daemon doesn't cut them off mid-turn.

### Privacy

22. As the human, I want Headroom run with its beacon, update check and usage polling off, so that the only traffic leaving my machine is my agents' own model traffic and the one-time model download.

## Implementation Decisions

### Gavin wires agents itself; it never runs `headroom wrap` (ADR 0007)

`headroom wrap <tool>` is Headroom's own launcher. Gavin does not use it, for any agent. Among other things, `wrap claude` writes the repo's `.claude/settings.local.json` plus a SessionStart hook, registers the Serena MCP server at user scope in `~/.claude.json`, creates `.serena/`, and cleans up other tools' leftovers. In a shared checkout with many agents and worktrees, those writes collide with each other and with the MCP config Gavin's own Integration writes. `wrap codex` writes `$CODEX_HOME/config.toml`; `wrap opencode` writes `~/.config/opencode/opencode.json`.

Gavin instead applies a **recipe** per agent: environment variables and, for Codex, one launch argument. It writes no file into the repo or the human's home.

### The daemon runs Headroom (ADR 0007)

Headroom is a child process of the daemon, not of the Tauri app and not a PTY session.

- **Why the daemon.** The first principle is "the work outlives the window". Agent PTYs belong to the daemon, and they survive the app closing. A Headroom owned by the app would die with the window, and every compressed agent would hit `API Error: Connection error` on its next turn.
- **Why not a tab.** Headroom is infrastructure like the daemon, not an agent. A status row in Settings shows it; a tab would be noise.
- **Why not an OS service.** Headroom can install itself as a launchd, systemd or Task Scheduler service, but then its flags, version and lifetime are outside Gavin's sight.

This is the daemon's first long-lived child that is not a PTY. The daemon already starts `git` through `crate::program::command`; Headroom goes through the same seam.

**One Headroom per daemon.** A release build and a dev build run a daemon each. Each runs its own Headroom:

- **Its own port.** It is chosen by the daemon, not Headroom's default 8787, which the human may already be using.
- **Its own state directory.** `HEADROOM_WORKSPACE_DIR` points under the daemon's state directory, with the same dev suffix as the socket (`headroom` and `headroom-dev`). Two proxies sharing `~/.headroom/proxy_savings.json` would overwrite each other's totals: each loads the file once, then rewrites it whole.
- **No adoption.** Gavin never adopts a Headroom it did not start. An adopted proxy runs with flags Gavin did not choose (the beacon on, memory injection on), and "Gavin runs Headroom" would stop being true.

**The flags.** Every start passes the same fixed set:

| Setting | Why |
|---|---|
| `--host 127.0.0.1 --port <port>` | Loopback only, on the daemon's port |
| `HEADROOM_WORKSPACE_DIR=<state>/headroom[-dev]` | Its own state, per daemon |
| `HEADROOM_BEACON=off`, `DO_NOT_TRACK=1` | The anonymous usage beacon is on by default |
| `HEADROOM_UPDATE_CHECK=off` | Gavin owns the version |
| `--no-subscription-tracking` | Headroom would otherwise poll Anthropic's OAuth usage endpoint every 5 minutes with the human's token. Gavin already polls that endpoint, and it rate-limits hard. |

Memory, learn, the output shaper, model routing and Serena are off by default in Headroom, and Gavin turns none of them on. Compression is Headroom's stock `coding` profile: cache mode, so only the newest turn is compressed and the provider's prompt cache survives; lossy compression capped at 25% for subscription traffic; CCR on, keeping originals for 30 minutes so the model can fetch them back.

Headroom's Codex usage poll (`/wham/usage` against chatgpt.com) has no switch. It is the one residual egress, and it is harmless to Gavin, whose Codex usage comes from local session files.

**Lifetime.**

- **Start and stop.** Headroom starts when the daemon starts and any workspace has compression on, and stops when none does. Starting it on the first compressed launch instead would make that launch uncompressed every time (the model takes seconds to load). Running it whenever it is installed would spend memory for nothing.
- **Readiness.** The daemon polls `/readyz`. A cold compression model does not fail the health check, which is one reason setup prefetches it.
- **Restarts.** When the process dies, the daemon restarts it on the same port. Agents mid-turn see a connection error, and auto-resume retries it (see "Failures").
- **After a daemon crash.** Agents can outlive their daemon (orphan recovery relies on it), and a standalone `headroom proxy` does not exit when its parent dies. The restarted daemon re-adopts its own Headroom when all of these match: the recorded pid, with its start time as the reuse guard, the way orphan recovery probes a pid; `/health`'s `service: "headroom-proxy"` and `version`; and the port. Otherwise it starts a fresh one. It never stops a Headroom it did not start. Headroom's own orphan watchdog is not used: it only runs for proxies `wrap` started (`HEADROOM_WRAP_OWNED=1`) and depends on Headroom internals.

**Requests.** The daemon answers new requests for Headroom's status (state, version, pin, port, running, lifetime savings), and for starting and stopping it. That is a protocol bump.

### Detection and install

Detection runs in the daemon, because the daemon is what has to execute the binary.

- **Where it looks.** In order: uv's tool bin directory, then `PATH`, then a path the human picked with **Locate…** (the same file picker the wizard uses for an existing CLAUDE.md). The daemon's `PATH` is the one the app was launched with, and a macOS app started from the Dock does not get `~/.local/bin`. So a Headroom the human can run from their own terminal can still be invisible to a `PATH` lookup.
- **What it stores.** The resolved absolute path is stored per machine and used at every start. `PATH` is never searched again at launch.
- **Version.** `headroom --version` prints `headroom, version X.Y.Z`. The **floor** is 0.38.0: PR #3556 in that release moved per-request state into context-local storage, which the research reads as the fix for #3549 (state leaking between concurrent compressions), although the issue is still open. The **pin** is 0.39.1.

**States.** There is no "Asserted" state. For Superpowers, the human's word is enough, because the agent runs Superpowers, not Gavin. Gavin must execute Headroom, and a word does not name a file.

| State | Meaning |
|---|---|
| Verified | Found at or above the floor. A version above the pin carries the note "newer than tested". |
| Too old | Found below the floor. Gavin will not start it. |
| Absent | Not found |
| Unavailable | Not on this platform: an Intel Mac, Windows, or an ssh workspace. The reason is shown. |

**Install.** When `uv` is found, the Install button runs `uv tool install --python 3.13 "headroom-ai[all]==<pin>"`, then prefetches the compression model (`kompress-v2-base`, about 274 MB, into the Hugging Face cache). Headroom has no CLI command for the prefetch, so it calls `prefetch_kompress_artifacts()` through the installed tool's Python. That is an internal API, and it is pinned along with the version. Without `uv`, Settings shows the command and offers Locate… and Check again.

Like the Superpowers install, it is an argv array (never a shell string) with a timeout, both pipes drained on threads, and one lock for the machine so a second click cannot start a second install.

**Upgrade.** When Gavin's pin moves past the installed version, Settings offers "Headroom X.Y tested — update". The button asks first, because restarting the proxy drops in-flight requests and every running compressed agent retries once. Gavin never upgrades on its own.

### The switch

- **Where it lives.** It is a workspace setting (`headroom`), with an app-wide default in `config.json` that starts Off. It follows the review gate's pattern: absence means inherit. The key goes on both `SETTINGS_KEYS` lists (`workspace_settings.rs`, `workspaceSettings.ts`) and is written through `set_workspace_settings`, never `persistWorkspaces` (ADR 0006).
- **Why per workspace.** Compression is a property of how a repo is run. Not per profile, and not per card.
- **The wizard.** A **Headroom** step follows the Superpowers step. It offers On when Headroom is Verified, and offers the install when it is Absent.
- **The daemon's copy.** The daemon holds the effective setting per workspace, because MCP spawns never pass through the app. The app pushes it whenever it changes, and the daemon persists its copy, so a daemon that restarts before any app connects still knows whether to start Headroom.

### Compressed sessions

**The decision is the daemon's, made at spawn.**

- **What it checks.** The workspace's effective setting is On, Headroom is ready, and the session is an agent launch whose profile has a recipe.
- **What it does.** It applies the recipe and records `compressed` on the session, together with the reason when it is not.
- **Why there.** Readiness, the port and the recipes are all daemon facts, and MCP-spawned sessions never pass through the app. Deciding in the app would split the decision in two, with a race between checking readiness and spawning.

**What counts as an agent launch:**

- **Profile launches.** `CreateSession` is widened with the launching profile's id: card runs, develop, resume and relaunch, rail steps, Best-of-N, tools, reviews, and the hidden commit run. Widening an existing request is invisible to `min_version_for`, so it needs a `FEATURE_MIN_VERSION` entry in `daemonCompat.ts` **and** a `featureBlockedReason` consumer on every surface that launches an agent.
- **MCP spawns** (`SpawnAgentSession`). The daemon recognises the first token of the command against the known agent binaries, the same heuristic `binary_for` uses for Superpowers.
- **Not plain shell tabs.** A `claude` the human types into a shell tab runs uncompressed.

**Why plain shells are left alone.** The routing variables are read by more than agents: the official Anthropic and OpenAI SDKs honour `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL`. Setting them in every terminal of a workspace would compress the human's own project's API calls, including test suites for an LLM app, where Headroom allows up to 45% lossy compression on API-key traffic.

**The residual.** The commands an agent runs itself (its Bash tool running `npm test`) inherit the agent's routing. No env-based design avoids that, and `headroom wrap` has the same property. The Settings help text says so.

**Relaunches decide again.** Resume, relaunch, the fallback chain and auto-resume all go through a fresh spawn, so a session never stays pointed at a Headroom that has gone.

**Tagging.** Every compressed session is tagged with its Gavin session id as Headroom's "project", so `/stats` reports savings per session. Gavin never sends `x-headroom-session-id`: that header opts a session into mid-turn queueing (Headroom answers `202 headroom_queued`) and turns it into a key that subagents share.

### The recipes

`<base>` is `http://127.0.0.1:<port>` and `<id>` is the Gavin session id.

| Profile | Recipe | Tag |
|---|---|---|
| **Claude Code** (`claude`) | `ANTHROPIC_BASE_URL=<base>`, `ENABLE_TOOL_SEARCH=true`, `ANTHROPIC_CUSTOM_HEADERS=X-Headroom-Project: <id>` | The header |
| **Codex** (`codex`) | Insert `-c openai_base_url="<base>/p/<id>/v1"` after the binary, and set `OPENAI_BASE_URL` to the same | The `/p/` prefix |
| **opencode** (`opencode`) | `OPENCODE_CONFIG_CONTENT` pointing the `anthropic` and `openai` providers' `baseURL` at `<base>/p/<id>/v1`, and loading Headroom's transport plugin from Headroom's install directory with `project: <id>` | The `/p/` prefix and the plugin's `project` option |
| **Custom** | Per the profile's **API family** picker: None (the default), Anthropic (`ANTHROPIC_BASE_URL=<base>/p/<id>`) or OpenAI-compatible (`OPENAI_BASE_URL=<base>/p/<id>/v1`) | The `/p/` prefix |
| **Gemini** | Only after the spike (headroom-07) | — |
| **Cursor** | None possible | — |

**Claude Code.**
- `ENABLE_TOOL_SEARCH=true` is required: behind a custom base URL, Claude Code otherwise loads every tool schema into context (#746).
- Behind a proxy, the 1M-context beta is kept only when the model id carries `[1m]` and `--model` outranks `ANTHROPIC_MODEL`. Gavin's `sonnet[1m]` and `opus[1m]` aliases already travel as `--model`, so nothing changes.
- Claude Code turns off Remote Control behind a custom base URL (2.1.196 and later). Gavin does not use it.
- Subscription OAuth works: Headroom forwards the `Authorization` header untouched and treats Claude Code's user agent as subscription traffic.

**Codex.**
- `OPENAI_BASE_URL` alone is not enough on current Codex. The built-in `openai` provider takes its base URL only from the config key `openai_base_url`, and ignores the environment variable for its WebSocket transport.
- A project's own `config.toml` may not set that key, so the `-c` flag is the only route that writes no file. Codex's own TypeScript SDK uses the same flag.
- ChatGPT login works: an explicit base URL outranks the ChatGPT default, and Headroom reads the ChatGPT token and forwards to chatgpt.com.
- Codex is the one recipe that changes the command line. It is applied only where the daemon recognises the command as a Codex launch.

**opencode.**
- `OPENCODE_CONFIG_CONTENT` merges with the on-disk config, including the MCP config Gavin's Integration writes, so no file is needed.
- Zen and Go traffic reaches Headroom only through the transport plugin, which patches fetch.

**Custom.** The API family picker joins the custom agent's other settings (command and model flag).

**Gemini.** The Gemini CLI honours `GOOGLE_GEMINI_BASE_URL` for an API key, which also flips its auth type to "gateway", and `CODE_ASSIST_ENDPOINT` for Login with Google, documented only "for development and testing". Headroom documents its `/v1internal` route for other Gemini clients, not the official CLI. And CCR originals are not recovered on streaming Gemini, so lossy compression there cannot be undone. Gemini therefore ships only the auth modes a spike proves on real logins.

**Cursor.** The `agent` CLI sends everything through Cursor's own servers over Cursor's protocol. Cursor's docs and LiteLLM's docs both say no gateway can sit in between. The row says so.

### Savings

- **Per session.** Headroom's `GET /stats` returns `per_project` savings. When a card run ends, the daemon snapshots the session's saved tokens into its `card_runs` row. The new columns need an `ALTER TABLE … ADD COLUMN` beside the `CREATE TABLE`, with a test against a database built with the old schema (the `pre_v*` pattern in `kanban.rs`).
- **Gavin keeps the record.** Headroom is not the long-term record. Its `per_project` map grows with every session, so Gavin's snapshots are what the UI reads.
- **Where it shows:**
  - **Run history:** "saved N tokens" next to the tokens spent (`runHistory.ts`).
  - **The hub's economics and usage readout:** tokens saved in the current limit window.
  - **Settings:** the lifetime total, from `/stats`' `persistent_savings`.
- **Tokens, not dollars.** Gavin computes no dollar cost anywhere, and this change does not start. The transcript tokens Gavin already reads (`agent_tokens.rs`) are what the API billed after compression. They cannot show the saving, which is why the saving comes from Headroom.

### Failures

- **Headroom not ready at launch.** The session launches uncompressed with the reason recorded. It gets the exception mark.
- **Headroom dies mid-session.** The agent's next request fails with `API Error: Connection error`. The daemon restarts Headroom on the same port, and auto-resume's retry lands on the restarted proxy.
- **A new failure cause, `headroom`.** It applies when the failing session is compressed and Headroom fails its health check at the moment of the failure. Today that failure would be classified `network`, and auto-resume would retry into the same broken proxy across the whole fleet. Auto-resume relaunches a `headroom` failure **uncompressed**, and the session gets the exception mark. The cause joins `KNOWN_CAUSES` in `autoResume.ts`; an older build reads it as `unknown`, which never resumes.
- **Not reaching Headroom.** A compressed session that finishes a turn while Headroom has seen no request tagged with its id gets the exception mark "not reaching Headroom". It exists because the routing is only as good as the agent CLI's respect for its environment. Headroom documents one such gap for Claude Code (#951: background workers that re-read the settings file instead of inheriting the environment).

**The exception mark.** A tab mark in the `ui/indicators.ts` vocabulary appears only on a session in a compressed workspace that is not compressed. It carries one of three reasons: Headroom was not ready, it failed and the session was relaunched without it, or the session is not reaching Headroom. A compressed session carries no mark; a badge on every tab would be noise.

**How headroom-06 settled what the above leaves open (2026-09-29, protocol v50).**

- **Where the cause is decided.** In the daemon, at the moment it calls a quiet session failed: the session's registry row says whether it was compressed, and `/readyz` is asked live on the daemon's port. The reason becomes gavin's own sentence, `Headroom stopped answering, …` (`HEADROOM_REASON_PREFIX`, pinned in both languages like the suspend's), and the app classifies the prefix as `headroom`. The agent's own line is left out: an app older than v50 finds causes by the agent lines a reason contains, and would read `API Error: Connection error` as `network` and resume the fleet into the broken proxy. Without it, that app reads `unknown`, which never resumes.
- **The relaunch.** `headroom` resumes on reachability, like `network`, and the resume carries `CreateSession.without_headroom`. The daemon honours it ahead of readiness, because a Headroom that looks ready is the case it overrides, and records `headroom-failed`. `FEATURE_MIN_VERSION.headroomFailures` keeps auto-resume from sending it to an older daemon; such a daemon's `headroom` failure is declined with that reason.
- **"Finishes a turn".** The app asks (`HeadroomReach`) when a session goes from working to idle, and only for a run: a session bound to a card run or a rail step, which was launched with a prompt. A terminal the human opened goes quiet after painting its welcome screen and whenever they pause mid-sentence, so "Headroom has seen nothing" means nothing there. A reopened conversation (resume, review) has no prompt, so its first quiet, the history being painted, is passed over.
- **When an absence counts.** Headroom's count can lose a session that did reach it: `per_project` evicts once it holds 50, and a Headroom restarted since the launch forgot what it had not yet written (it writes every 25 requests). So `unreached` needs the Headroom process the session was pointed at and a map below its limit; anything else is `unknown` and marks nothing. In a fleet past 50 tagged sessions the check therefore stays silent. Headroom's `--log-file` JSONL, headroom-05's open alternative, would make it exact.
- **Which reasons are marks.** `no-recipe` and `unsupported-agent` are not: those agents are uncompressed by design and Settings says so beside their rows. The mark also needs the workspace's switch to be on now, not only at launch.

### Platforms

v1 is macOS on Apple Silicon and Linux. Headroom's own docs disagree about native builds for Intel Macs, Headroom has an open Windows proxy outage (#3749), and Gavin's Windows desktop pass is not done, so Intel Macs and Windows show Unavailable with the reason (headroom-08). ssh workspaces show Unavailable as well: a compressed session there would need Headroom installed and supervised on the host.

### Suggested build order (for ticketing)

1. **headroom-01** — the daemon runs Headroom: detection, floor and pin, the fixed flags, the per-daemon port and state directory, readiness, restarts, re-adoption, the status and start/stop requests, and the concurrency probe.
2. **headroom-02** — compressed launches and Claude Code: the switch and its default reaching the daemon, `CreateSession` widened with its compat gate, the spawn-time decision including MCP spawns, the Claude Code recipe, `compressed` on the session, and relaunches deciding again.
3. **headroom-03** — Codex, opencode and Custom: the other recipes and the API family picker.
4. **headroom-04** — the setup surfaces: the Settings section, the switch and default, and the wizard step.
5. **headroom-05** — savings: the snapshots and the three surfaces.
6. **headroom-06** — honest failures: the `headroom` cause, the relaunch without Headroom, and the exception mark.
7. **headroom-07** — Gemini, after a spike on real logins.
8. **headroom-08** — Windows and Intel Macs, parked.

Once 02 lands, 03, 04 and 05 can run on parallel rails.

## Testing Decisions

- **Recipes are pure.** A recipe maps (profile, base URL, session id) to env and argv, and is unit-tested per profile in the daemon. The Codex insertion is tested against command lines with a `--model` suffix and with Gavin's prompt arguments.
- **The spawn-time decision is a pure function** of (workspace setting, Headroom readiness, profile or first token), with a test for each row: off, not ready, no recipe, Cursor, a plain shell tab, an MCP spawn of `claude`, an MCP spawn of `codex`.
- **Lifecycle against a fake.** Start, restart and re-adoption are tested against a fake Headroom (a tiny HTTP server answering `/readyz` and `/health`), in an isolated daemon under a temp `$HOME`. Never against the shared daemon.
- **The concurrency probe** runs against the real pinned Headroom. It sends two concurrent compressed requests with distinct content and checks that neither's upstream body contains the other's. If it fails, the floor rises or the default goes lossless (`--lossless`). It is `crates/daemon/tests/headroom_probe.rs`, ignored by default because it needs a real Headroom and its model; the command is in the file's header. The requests of a round share a `tool_use` id, because the state #3556 moved is keyed by it, and the probe refuses to pass on a body that was not compressed or that kept none of its own content. It also sends a file read beside each pair and checks that it arrives byte for byte: #3549's own symptom is not content crossing between bodies but a protected read compressed because a concurrent request overwrote the map naming it. A failure is proof of a leak; a pass is not proof of its absence. Run against 0.37.0, which predates the fix, the pair's half passes too, and the read's half cannot be asked of it, because 0.37.0 compresses a log read even when it is sent alone. So the bug was never reproduced from outside the process: the race is a window inside one call, and upstream's own regression test only hits it by pausing one. The floor rests on the fix being in the source (0.38.0's content router keeps its runtime state in a `ContextVar`, 0.37.0's on `self`), and the probe is the tripwire behind that reading.
- **The migration.** The `card_runs` columns are proven against a database built with the old schema.
- **The compat gate.** An older daemon must not receive a widened `CreateSession` it would silently drop. Each launch surface's `featureBlockedReason` is covered by the existing surface tests.
- **Human tests**, only where a person is needed:
  - a Claude Max card run in a compressed workspace (02)
  - Codex on a ChatGPT login and opencode on Zen (03)
  - a real install on a machine without Headroom, and how the section and wizard look (04)
  - savings on a real run (05)
  - the Gemini spike on real logins (07)

## Out of Scope

- **`headroom wrap` and Headroom's own service installer.** See ADR 0007.
- **Headroom's memory, learn, output shaper, model routing and Serena.** `headroom learn --apply` writes into CLAUDE.md-like files, and the memory store writes `.headroom/` into the repo. Neither belongs to "compress what the agent sends".
- **Compressing plain shell tabs**, and so a `claude` the human types by hand.
- **A generic "agent tooling" framework.** Superpowers installs per workspace and per profile; Headroom installs once per machine and switches per workspace. Pull out the shared shape when the Superpowers replacement lands, not before.
- **Dollar costs.**
- **ssh workspaces, Windows and Intel Macs** in v1.
- **Adopting a Headroom the human runs themselves.**

## Further Notes

- **Headroom is moving fast.** 0.36 to 0.39.1 took five weeks, and its Rust port plans to delete the Python proxy. Gavin depends on these Headroom surfaces, and each is pinned with the version:
  - the CLI flags and env names in the table above
  - `/readyz`, `/health` and `/stats` with `per_project` and `persistent_savings`
  - the `/p/<project>/` prefix and the `X-Headroom-Project` header
  - the opencode plugin's location and its `project` option
  - `prefetch_kompress_artifacts()`

  Every pin bump re-runs the concurrency probe and the recipe tests against the new version.
- **Open upstream bugs that touch this design:**
  - #3590: `ls -la` and `git status` output compressed to bare numbers
  - #3673: Kompress drops a record from single-line JSON
  - #3652: columnar output loses fields
  - #3017: Claude Code "malformed response" through the proxy
  - #3587: CCR buffering makes time-to-first-token equal to the whole generation
  - #3597: the project header `wrap` sets is not the one CCR's resolver reads, which may affect CCR attribution

  The per-workspace switch and the `headroom` failure cause are the escape hatches. The first two bugs argue for watching the savings numbers against the quality of the fleet's work in the first weeks.
- **Headroom's `per_project` map grows with every session.** Gavin snapshots each run's savings, so the map is not load-bearing. But Headroom rewrites its savings file whole, so a very large map may slow it down. If it does, Gavin can rotate its own `headroom` state directory, since Gavin owns it.
  - **Correction (2026-09-29, headroom-05).** The map does not grow without bound: 0.39.1 caps it at 50 projects (`savings_tracker.py`, `DEFAULT_MAX_PROJECTS`) and, on every new project past the cap, evicts the one that saved least. Once 50 sessions have been tagged, a live session that has saved less than every older one is evicted whenever another session arrives, and comes back from zero on its next request. Run through Headroom's own tracker, two live sessions alternating 20 requests each read back as absent and as 1 request, where each truly had 20. A solo session reads right. So the snapshot undercounts in a busy fleet. Which source savings should use instead is an open decision on `headroom-05-savings.md`; Headroom's `--log-file` JSONL, which carries the project tag per request, is the exact alternative.
- **Memory.** Headroom's compression model is resident while Headroom runs. The launch wall's memory gate sees the machine's pressure, not Headroom's share of it. That is acceptable while Headroom runs only when a workspace has compression on.
- **Superpowers is about to be replaced** by a different skill set. Headroom's setup reuses only the detector vocabulary and the install mechanics (argv, timeout, drained pipes, one lock), so nothing here depends on Superpowers staying.
