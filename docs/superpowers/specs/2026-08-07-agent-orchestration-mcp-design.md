# MCP Server + Skill Injection — Design Spec

Sub-project **3 of 6** of the agent-orchestration phase. Phase decisions live in
`docs/superpowers/brainstorms/2026-08-06-agent-orchestration-brainstorm.md`; this
sub-project is governed by **D1** (inject the full workflow), **D3** (MCP from day
one, daemon-hosted engine), **D4** (Claude Code behind a profile seam), and its own
**D18–D22**. Foundations and sub-2 provide ready handler bodies:
`init_gavin_root`, `create_gavin_context`, `scan_root`, `set_plan_field`, session
creation, and the watch registry mapping roots ↔ open workspaces.

**Goal:** agents working inside a gavin workspace get the full gavin API as MCP
tools — including spawning visible gavin terminal sessions — plus an injected
skill teaching the workflow; and the app⇄daemon protocol gains a version
handshake so stale-daemon mismatches fail with an actionable message.

**Out of scope:** additional agent profiles beyond Claude Code (the seam stays),
per-request tolerant protocol envelopes (the handshake prevents the mismatch
class up front), plan-body editing UI (sub-4/5), home tiles (sub-6).

---

## 1. The `gavin-mcp` shim (D21)

A new workspace bin crate `crates/gavin-mcp`, hand-rolled, sync, zero new
dependencies (serde/serde_json only):

- **Protocol surface:** MCP over stdio — newline-delimited JSON-RPC 2.0 on
  stdin/stdout. Handles exactly: `initialize` (replies with server info and a
  tools-only capability set), the `notifications/initialized` notification
  (ignored), `tools/list`, `tools/call`, `ping`. Anything else → JSON-RPC
  method-not-found. **stdout is protocol-only; all diagnostics to stderr.**
- **Root resolution:** Claude Code launches project-scope MCP servers with the
  project directory as cwd. The shim walks up from its cwd to the nearest
  directory containing `.gavin-root` — that is the gavin root injected into
  every tool call. No `.gavin-root` above cwd → every tool (except
  `gavin_init_root`) returns a tool error: "not inside a gavin workspace."
- **Daemon link:** one persistent command connection to
  `protocol::socket_path()`, opened lazily on the first tool call, serialized
  request/reply, one reconnect attempt per call on failure. Daemon unreachable →
  tool error: "gavin daemon isn't running — open the gavin app." Every fresh
  connect performs the §4 version probe before any real request.
- **Thin-shim boundary:** the shim shapes arguments and error wording only;
  every operation executes in the daemon.

## 2. Tools (D18) and protocol additions

Eight tools; the shim injects the resolved root, so agents never pass it.
Descriptions in the tool schemas are one sentence each — schemas ride in every
agent's context.

| Tool | Inputs | Daemon request |
|---|---|---|
| `gavin_get_tree` | — | **new** `ScanGavinRoot { root_path }` → **new** `GavinTreeScanned { tree }` (stateless scan, no watch required — distinct from `GavinTreeSnapshot`, which is workspace-keyed) |
| `gavin_read_prd` | — | **new** `ReadPrd { root_path }` → **new** `PrdContent { content }`; 1 MB cap; error when absent |
| `gavin_create_plan` | `context_folder`, `file_name`, `title`, `status?`, `priority?`, `body?` | **new** `CreatePlan { … }` → **new** `PlanCreated { path }`. Validation: `context_folder` is the root or contains `.gavin`; `file_name` matches `[A-Za-z0-9._-]+\.md`; priority ∈ vocabulary; **never overwrites** (existing file → Error naming the path). Writes canonical frontmatter (`title`, `status` — default "To Do" when omitted — optional `priority`) + body |
| `gavin_set_plan_field` | `path`, `key`, `value` | existing `SetPlanFrontmatterField` |
| `gavin_create_context` | `parent_folder` | existing `CreateGavinContext` |
| `gavin_init_root` | `path?` (default: shim cwd) | existing `InitGavinRoot` (workspace name = folder basename). The only tool that works before root resolution succeeds |
| `gavin_get_board` | — | **new** `GetBoardByRoot { root_path }` → the existing `Board` reply. Resolves the **watched** workspace via the watch registry (canonicalized root match); returns the SQLite board — columns (the status vocabulary, D6), free-form cards, labels. Unwatched → Error "workspace not open in gavin." No daemon-side merge: plans come from `gavin_get_tree`; composition is the agent's job, guided by the skill |
| `gavin_spawn_session` | `command`, `cwd?` (default root) | **new** `SpawnAgentSession { root_path, cwd, command }`. **Requires the root watched** (D19 — no invisible agents). Creates the session, replies `SessionCreated { id }`, and pushes **new** `AgentSessionSpawned { workspace_id, session_id, cwd, command }` on the watching connection's writer |

Net new protocol from this section: 5 requests, 4 response variants
(`GavinTreeScanned`, `PrdContent`, `PlanCreated`, `AgentSessionSpawned`), all
camelCase-shape-tested where frontend-crossing. §4 adds one more pair.
The shim resolves any relative `context_folder`/`cwd`/`path` argument against
the resolved root before forwarding, so agents may pass either form.

## 3. App integration

### Spawn landing (D19)

The streaming reader's new `AgentSessionSpawned` arm, in order:

1. **Sends `Attach { id }` on the streaming connection first** — a session
   nobody attaches renders blank forever (the Milestone-C lesson).
2. Emits `agent-session-spawned` with `(workspaceId, sessionId, cwd, command)`.

The frontend handler finds the workspace and **finds-or-creates a page named
"Agents"** (created with a single-leaf layout holding the session; existing page
→ session appended to its first pane's tabs), persists, and does **not** steal
focus — the sidebar's status dots/badges are the fleet monitor. Name-keying is
deliberate (no new schema); renaming the page means the next spawn creates a
fresh "Agents". **Race rule:** if the workspace no longer exists when the event
arrives, the handler kills the session — the no-invisible-agents invariant
holds on the edge.

### Setup button (D20)

A row in the hub's root-control area for **every rooted workspace**: "Agent
integration — **Set up**" (→ "Update" when the files already exist). An
app-side command writes, and reports per file:

1. **`.mcp.json`** at the root — **merge-aware**: parse an existing file and
   insert/replace only `mcpServers.gavin` (`command` = absolute path to the
   `gavin-mcp` binary, resolved by the same sibling-binary lookup the daemon
   spawn uses in dev; bundled resource path in release), preserving all other
   entries; create the file when absent. Unparseable existing file → error, no
   write.
2. **`.claude/skills/gavin/SKILL.md`** — overwritten wholesale (re-run =
   update).
3. **`CLAUDE.md`** — a block delimited by `<!-- gavin:start -->` /
   `<!-- gavin:end -->`: replaced in place if present, appended otherwise
   (file created if absent); nothing outside the markers is ever touched. The
   block: a three-line pointer at the PRD, the skill, and the gavin tools.

All filenames/paths come from a `ClaudeCodeProfile` struct (D4's seam): one
profile exists, but the writer reads fields, never literals. The skill file and
the CLAUDE.md marker block are **gavin-managed**: re-running Update overwrites
them (hand edits inside them don't survive; everything outside the markers is
never touched).

### The skill (D1 made concrete)

`SKILL.md` teaches, in order: read the PRD first (`gavin_read_prd`); **plan
before coding** — `gavin_create_plan` into the nearest context (or hand-author
the documented frontmatter: files are truth, D2); keep status current with
`gavin_set_plan_field`, using the board's **column names** as the status
vocabulary (`gavin_get_board`; matching is slug-insensitive); create `.gavin`
contexts for new features/libs (`gavin_create_context`); spawn sibling sessions
for parallelizable work (`gavin_spawn_session`), noting every spawn is visible
to the human on the Agents page. Includes the plan frontmatter reference
(`title`/`status`/`priority`) for direct file authoring.

## 4. Version handshake (D22)

- `protocol::PROTOCOL_VERSION: u32 = 1`, bumped on any wire-breaking change
  from now on.
- **New** `GetProtocolVersion` → **new** `ProtocolVersion { version }`.
- The probe interprets **failure shape**, because a daemon older than the check
  cannot parse the request and closes the connection:
  - connection closed / read error → "the gavin daemon is older than this app —
    restart it (`pkill gavin-daemon`, then relaunch the app)";
  - `version <` expected → same message;
  - `version >` expected → "the gavin daemon is newer than this app — rebuild
    and restart the app."
- The **app** probes first thing on the command connection in `bootstrap`;
  mismatch → `BootstrapError` (the existing startup overlay) with the
  actionable text. The **shim** probes on every fresh connect; mismatch → the
  same wording as a tool error.

## 5. Testing

Conventions unchanged (tempdir units, socket-level integration, mocked-backend
Vitest, no component tests; manual smoke for rendered UI and real-agent flows).

- **Protocol:** roundtrips for the 5 new requests + 3 new responses; a
  `PROTOCOL_VERSION` existence/shape test.
- **Daemon units:** `create_plan` writer — canonical output bytes, default
  status, validation matrix (bad filename, bad priority, non-context folder),
  no-overwrite; `read_prd` — content, cap, missing.
- **Daemon integration (socket):** `ScanGavinRoot` snapshot; `GetBoardByRoot`
  watched vs unwatched; `SpawnAgentSession` — session created, `SessionCreated`
  reply, **and** the `AgentSessionSpawned` push arrives on the watching
  connection; unwatched → Error; `GetProtocolVersion` roundtrip.
- **gavin-mcp units:** JSON-RPC dispatch (initialize / tools list / call happy
  paths, method-not-found, malformed line) against a `UnixStream::pair` mock
  daemon; root-resolution walk (found / nested / none) on tempdirs; version-
  probe failure-shape mapping.
- **App:** Agents-page find-or-create/insert as pure layoutState tests
  (including the kill-if-unplaceable race rule); setup-writer merge matrix as
  tempdir Rust tests (`.mcp.json` absent / other servers / stale gavin entry /
  unparseable; `CLAUDE.md` replace / append / create; skill overwrite).
- **Manual smoke:** in a set-up workspace, a real Claude Code session's `/mcp`
  lists gavin; each tool answers; a spawn lands on the Agents page attached and
  scrolling; a deliberately stale daemon produces the friendly version error at
  app startup and as a tool error.

## 6. Plan split and future consumers

Breadth suggests two plans: **Part 1 — protocol + daemon + shim** (§§1, 2, 4;
independently testable over the socket and via the shim's own tests), then
**Part 2 — app landing + setup + skill** (§3 + the app half of §4). Later
sub-projects consume: the skill/setup writer patterns for additional agent
profiles (D4), `ScanGavinRoot` for any future headless consumer, and the
Agents page as sub-6's fleet-monitor tile source.
