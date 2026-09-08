# Gavin security audit — threat model

Audit of commit `944eae2` on branch `sec/review-2026090801`, `PROTOCOL_VERSION` 34,
2026-09-08. Every pass in this folder cites this document: an adversary by number, a
surface by id, and the accepted-by-design list by entry. A finding that names none of
them is out of scope.

## Adversaries, in order

| # | Adversary | What it already has | What it wants from gavin |
|---|-----------|---------------------|--------------------------|
| **A1** | **A same-user process** — a rogue npm `postinstall`, a malicious crate build script, a browser extension's native helper, anything already running under the developer's uid. | Everything the uid has: the filesystem, `~/Library`, the ability to `exec` any program, the Keychain items the user has unlocked. | Reach into gavin's *live* state (other sessions' screens and stdin, the queued inputs, the board), persist, or hide inside something the human attributes to gavin. |
| **A2** | **An agent gavin runs** — a prompt-injected coding agent holding `gavin_*` MCP tools, and the *content* that becomes its prompt: a cloned repo whose `.gavin*/plans/*.md` bodies, `attachments:`, `config.toml`, and shipped MCP config files reach a fresh agent verbatim. | A shell as the user (every agent CLI gavin launches runs unsandboxed), plus the `gavin_*` tools over the same socket the app uses. | Make the human's next click run something they did not read; move, tick, claim, or file cards so the scheduler treats undone work as done; spread to other workspaces and sessions. |
| **A3** | **Future remote exposure** — the daemon reachable off the machine, through a proxy, for a mobile client. | A network path to the socket's protocol, and possibly the proxy itself. | Any single request that the socket hands out today for free: `CreateSession { command }` is a remote shell. |

Out of scope, explicitly: physical access to an unlocked machine; another uid or root
on the same host; the OS, the kernel, and WebKit itself; the human acting against
themself; the agent vendors' own permission models (they are the agent's problem,
not gavin's — gavin's boundary starts where it hands them a prompt).

## Surfaces

Each surface names the adversaries it faces. The pass that owns it goes deep; the
others only cite it.

| id | Surface | Where | A1 | A2 | A3 | Pass |
|----|---------|-------|----|----|----|------|
| **S1** | The Unix socket. `~/Library/Application Support/gavin/daemon.sock`, dir `0700`, socket `0600`. No peer-credential check, no token, no handshake beyond a version number a client may skip. Every connection is equal. | `protocol::socket_path`, `server.rs::bind_server`, `handle_connection` | full reach | full reach via S5 | the thing a proxy must not forward | 01 |
| **S2** | The wire protocol: 62 `Request` variants, newline-delimited JSON, 1 MiB line cap. Classes: **PTY** (`CreateSession` → `/bin/sh -c`, `SpawnAgentSession`, `ResizeSession`), **input** (`WriteInput`, `QueueInput`, `SetQueuedInputs`, `SendQueuedInput`), **lifecycle** (`KillSession`, `EndOrphan`, `Shutdown`), **path-taking** (`InitGavinRoot`, `CreateGavinContext`, `AddExternalGavinContext`, `WatchGavinRoot`, `CreatePlan`, `DeleteCardFile`, `ArchiveCard`, `UnarchiveCard`, `SetPlanFrontmatterField`, `SetChecklistItem`, `PromoteChecklistItem`, `SetRootConfigField`, `ScanGavinRoot`, `ReadPrd`, `GitDirtyPaths`, the `*ByRoot` family), **state** (`SetBoard`, `DeleteBoard`, `SetOrchestration`, `SetRailRun`, `SetStepRun`, `ClaimCardForSession`, `LinkCardSession`, `StartToolRun`, `SetToolRunOutcome`, `SaveTool`, `SaveGroupTemplate`, `SetFailurePatterns`, `NameSession`), **read** (`ListSessions`, `SessionProcesses`, `Attach`, `Snapshot`, `GetBoard`, `GetGavinTree`, `GetOrchestration`, `CardRuns`, `ToolRuns`, `ListQueuedInputs`, `GetTools`, `GetGroupTemplates`, `GetProtocolVersion`). | `crates/protocol/src/lib.rs`, `server.rs::handle_request` | ✓ | ✓ | ✓ | 01 |
| **S3** | State at rest: `registry.sqlite` (sessions, queued_inputs, card_runs, card_sessions, tool_runs), `kanban.sqlite`, `orchestration.sqlite`, the empty `sessions.db`; files `0644` inside the `0700` dir. Screen content is memory-only (the vt100 model in `screen.rs`, dropped on daemon exit); queued input is the one terminal text at rest. | `registry.rs`, `kanban.rs`, `orchestration.rs` | reads | reads (it is a shell) | — | 01 |
| **S4** | The `.gavin*` watcher and the markdown it parses: file names, frontmatter, bodies, `attachments:`, `parent:`, the `gavin:auto-commit` block. Repo content is treated both as data (the board) and as instructions (the prompt). | `gavin.rs`, `kanban.rs` | — | ✓ (hostile clone) | — | 01, 03 |
| **S5** | `gavin-mcp`: 13 tools over the same socket with the same protocol; `gavin_spawn_session` takes a command string. | `crates/gavin-mcp/src/main.rs` | — | ✓ | — | 03 |
| **S6** | The Tauri host: 165 `#[tauri::command]`s; `"csp": null`; `opener:allow-open-path` on `/**` and `**`; clipboard read/write; notifications; WKWebView. A compromised page is a compromised host to the extent the commands let it be. | `app/src-tauri/tauri.conf.json`, `capabilities/default.json`, `app/src-tauri/src/*.rs` | — | ✓ (via S8) | — | 02 |
| **S7** | Host-side process spawns: git (`git/run.rs`), `security` and `curl` (`agent_usage.rs`), the agent CLIs and the daemon (`daemon.rs`, `session.rs`), `open`, `superpowers.rs`, `pull_request.rs`, `agent_models.rs`. Argument construction from branch names, file names, card titles, repo config. | `grep -rn Command::new app/src-tauri/src` | — | ✓ (repo-controlled strings) | — | 02 |
| **S8** | Rendered untrusted content: two `{@html}` sites (`FileEditor.svelte`, `CardDetailModal.svelte`) fed by `marked`; xterm.js acting on agent output (OSC 133, title, hyperlinks, OSC 52 clipboard). | `app/src/lib/*.svelte`, `osc.rs` | — | ✓ | — | 02 |
| **S9** | Agent launch: `compose_agent_prompt` (card body verbatim), `attachments:`, `[worktree] setup` in `config.toml` (`worktree_setup.rs`), the MCP config files gavin writes into the repo and the ones a repo already ships (`.mcp.json`, `.codex/config.toml`, `.gemini/settings.json`, `opencode.json` — `agent_setup.rs`), orchestration tool bodies and `builtin:*` steps. | `app/src-tauri/src/session.rs`, `worktree_setup.rs`, `agent_setup.rs`, `app/src/lib/autoCommit.ts`, `orchestration.ts` | — | ✓ | — | 03 |
| **S10** | State an agent writes that the scheduler trusts: `status`, checklist ticks, `ClaimCardForSession`, `SetStepRun`, `SetRailRun`, run rows. | `orchestration.ts`, `orchestrationState.ts`, `server.rs` | — | ✓ | — | 03 |
| **S11** | Supply chain: Cargo and npm dependencies and their build scripts; no `.github/workflows` on `main`; no signing or notarization in `tauri.conf.json`; the daemon and MCP server travel inside the bundle; `devUrl` `http://localhost:1420` in dev. | `Cargo.lock`, `app/package-lock.json`, `tauri.conf.json` | ✓ (dev server) | — | — | 04 |
| **S12** | Remote access (does not exist yet): pairing, per-connection identity, per-request authorization, the proxy's own threat model, what it shares with ssh workspaces. | design only | — | — | ✓ | 05 |

## Accepted by design

These are boundaries, not findings. A pass may cite one to say "this is that", and
may argue that an entry is wrong, but nothing on this list becomes a card.

- **AD-1 — A same-user process has the whole protocol.** `0600` on the socket is the
  Unix same-user boundary; a process running as the developer can already exec a
  shell, read `~/Library`, and edit any repo, so reaching the daemon adds no privilege
  it lacked. This holds *for A1 only*. The same gap is the prerequisite for everything
  A3 needs and for making A2 narrower than the human, so pass 01 and 05 must name what
  client identity on the socket would take — the entry accepts the boundary, not its
  permanence.
- **AD-2 — Agents are first-class users** (PRD principle). An agent creates, moves,
  ticks, claims, and files cards, and spawns *visible* sessions, through the same
  daemon the human uses. A coding agent already holds a shell as the user, so
  `gavin_spawn_session` with a command is not an escalation over what the agent had.
  What this entry does *not* accept: an agent acting on a card or workspace it was not
  launched for, or writing state the scheduler then treats as the human's decision —
  pass 03 decides, per item, whether "trusted" is design or oversight.
- **AD-3 — A card's body is the prompt, and Run is the human's click.** A card the
  human wrote and pressed Run on executes verbatim; that is the product. Not accepted:
  content the human has *not read* reaching an agent on that click (a cloned repo's
  cards, attachments, a repo-shipped `[worktree] setup`, a repo-shipped MCP config).
- **AD-4 — Agents run unsandboxed as the user.** Gavin launches the agent CLIs the
  human configured with the human's privileges and does not confine them; confining
  them is the agent vendor's permission model. Gavin's duty is to hand them only
  prompts and tools the human meant them to have.
- **AD-5 — The daemon persists session state.** Session rows, run rows and *queued
  inputs* live in SQLite so sessions survive the window ("the work outlives the
  window"); screen content and scrollback do not — they are memory-only and a daemon
  restart loses them. Text typed into the queue is on disk under a `0700` directory;
  that is the same boundary as the shell history the terminal already writes. A pass
  may still flag *what* is retained, at *what mode*, and *for how long*.
- **AD-6 — The human's own configuration is trusted.** `[agent] command` in the
  workspace `config.toml`, the agent profiles in `config.json`, and the `command` an
  orchestration tool carries are strings the human wrote and gavin executes as
  written. Not accepted: the same keys arriving from a repo the human just cloned.
- **AD-7 — Dev-only surfaces are dev-only.** The vite server on `localhost:1420` and
  the HMR socket exist under `tauri dev`; a released bundle serves `frontendDist`. Pass
  04 still states what they expose, so a developer running dev all day knows.

## Rules every pass follows

1. **Never touch the running daemon.** No `pkill`, no restart, no connecting to the
   live `daemon.sock`. Every reproduction runs against an isolated daemon (below).
2. **A reproduction, or an admission.** Every high-severity finding either carries the
   steps that demonstrate it against the isolated daemon or a throwaway workspace, or
   says in one line that it is argued from reading and not reproduced.
3. **Describe, do not weaponise.** Impact and a minimal reproduction; no polished
   exploit, no extraction tooling, no payload beyond `echo`.
4. **Separate a vulnerability from a boundary.** Every finding is marked
   `vulnerability` (gavin promised, or the threat model requires, something it does
   not deliver) or `boundary` (this is the design; AD-n says so).
5. **Cite.** Every finding names an adversary (A1–A3), a surface (S1–S12), and, when
   it is a boundary, the AD entry.

## Severity

| Level | Meaning here |
|-------|--------------|
| **Critical** | Code execution or full session control for an adversary that the threat model says must *not* have it (A2 without the human's click, A3 at all). |
| **High** | A2 or A3 crosses a boundary the product promises (acts on unread content, escalates from one workspace or session to another, defeats a confirmation); or A1 gains something beyond AD-1. |
| **Medium** | Integrity or confidentiality loss inside the boundary: state the scheduler trusts can be forged, secrets retained longer or wider than needed, a guard that exists on one entry point and not another. |
| **Low** | Hardening: a missing cap, a permissive default with no demonstrated path. |
| **Info** | A fact the design should record. |

## Finding ids

`DP-nn` daemon & protocol (01), `AS-nn` app surface (02), `AG-nn` agent surface (03),
`SC-nn` supply chain (04). The remote-access design (05) makes no findings; it cites
them. The README dedupes across prefixes: one root cause is one entry.

## The isolated daemon

Built from this worktree, run under a temporary `$HOME`; it gets its own socket and
databases and never meets the live one.

```sh
export GVH="$(mktemp -d)"                       # throwaway HOME
HOME="$GVH" ./target/debug/gavin-daemon &        # prints its socket path
SOCK="$GVH/Library/Application Support/gavin/daemon.sock"
# one request, one reply: newline-delimited JSON, tag field "type"
printf '%s\n' '{"type":"GetProtocolVersion"}' | nc -U "$SOCK"
```

Stop it with `kill %1` (or the pid you captured) — never `pkill gavin-daemon`. A
throwaway *workspace* is a fresh `git init` under `$GVH` with its own
`.gavin-root/`; a throwaway *app* is `HOME="$GVH" target/debug/Gavin` (see
`docs/superpowers` for the harness), never the human's window.
