# Gavin security audit — report

Audit of commit `944eae2` (`PROTOCOL_VERSION` 34), 2026-09-08, on branch
`sec/review-2026090801`. Five passes, each against the threat model in
[`00-threat-model.md`](00-threat-model.md), each written as its own document:

| Doc | Pass | Findings |
|-----|------|----------|
| [`01-daemon-protocol.md`](01-daemon-protocol.md) | daemon & protocol (S1–S4) | DP-01…06 |
| [`02-app-surface.md`](02-app-surface.md) | Tauri host & frontend (S6–S8) | AS-01…09 |
| [`03-agent-surface.md`](03-agent-surface.md) | agents & workspace content (S4, S5, S9, S10) | AG-01…09 |
| [`04-supply-chain.md`](04-supply-chain.md) (+ raw output in [`04-supply-chain/`](04-supply-chain/)) | dependencies, build, release (S11) | SC-01…11 |
| [`05-remote-access.md`](05-remote-access.md) | remote-access design (S12) — a proposal, no findings | — |

This file dedupes the 35 findings into ten root causes, ranks them, says for each
whether it was reproduced, and names the To Do card that carries the fix. One root
cause is one entry, however many surfaces saw it.

## The three questions the card asked

**Can the daemon be accessed by other processes?** Yes, by any process running as
the same user, with the whole protocol. The socket at
`~/Library/Application Support/gavin/daemon.sock` is mode `0600` in a `0700`
directory and that is the entire access control: no peer-credential check, no token,
no handshake (a client need not even send `GetProtocolVersion`). One line on the
socket — `CreateSession { command }` — is a shell running as the developer; this was
reproduced against an isolated daemon (DP-01). For a same-user process that is the
Unix boundary the threat model accepts (AD-1), because such a process could exec a
shell anyway. What it is *not* is a boundary against the agents gavin runs, which
hold the same socket through `gavin-mcp` and can act on sessions and workspaces
they were not launched for (R1 below).

**How is the communication between the Tauri app and the daemon protected?** It
is not, beyond the file mode. The app and the daemon speak newline-delimited JSON
over that Unix socket with no authentication in either direction: the daemon cannot
tell the app from an agent from a rogue process, and the app cannot tell the real
daemon from a same-user process that bound the socket path first (DP-06, argued
from reading). Same-user is the boundary on both sides. The OAuth token path the
host uses for usage probes is clean (AS-06). The webview side has a single line of
defence — DOMPurify on the two `{@html}` sinks and a constrained xterm — with no CSP
behind it (R5).

**What is the best secure approach for a proxy-mediated mobile client?** Make the
*daemon* discriminate, not the proxy. Forwarding today's protocol through any
tunnel is a remote shell by design, so the design in
[`05-remote-access.md`](05-remote-access.md) puts client identity and a role gate
inside `server.rs::handle_connection` and only then adds pairing, an end-to-end
encrypted transport through a dumb relay the daemon dials out to, and a remote role
allowed 23 of the 62 request variants (14 read-only, 9 writes behind desktop-issued
grants) and denied the 38 that start a process, change what one will run, arm the
scheduler, or name a path. Its phase 1 — client identity on the *local* socket — is
worth doing with no mobile app at all: it is the fix for R1 and the prerequisite for
making an agent a narrower user than the human. Twelve open questions for the human
close that document.

## Findings, deduped and ranked

Severity follows the threat model's scale. "Reproduced" is per the strictest source:
*yes* means steps ran against an isolated daemon or throwaway workspace; *traced*
means a static trace with `file:line` where the step needs the Tauri host, which no
pass launched; *argued* means read only. Every High or Critical entry carries one
or the other, as the rules require.

| # | Root cause | Severity | Adversary | Kind | Reproduced | Sources | Card |
|---|-----------|----------|-----------|------|------------|---------|------|
| R1 | No client identity on the daemon socket | **Critical** for A3, **High** for A2, boundary for A1 | A1/A2/A3 | vulnerability (A2, A3); boundary AD-1 (A1) | yes | DP-01, DP-02, DP-06, AG-03, AG-04, AG-08, AG-09 | `sec-fix-client-identity.md` |
| R2 | Unread repo content reaches an agent on the first Run | **High** | A2 | vulnerability | yes | AG-01, AG-02 | `sec-fix-first-run-review.md`, `sec-fix-attachment-scope.md` |
| R3 | A cloned repo's `config.toml` and MCP files are executed as if the human wrote them | **High** | A2 | vulnerability (AD-6 excludes cloned config) | AS-03 yes, AG-07 yes; AS-02, AG-05, AG-06 traced | AS-02, AG-05, AG-06, AS-03, AG-07 | `sec-fix-workspace-trust.md`, `sec-fix-agent-file-path.md`, `sec-fix-shipped-mcp-config.md` |
| R4 | Path-taking requests and commands are not confined to a workspace | **Medium** | A2 (boundary for A1) | vulnerability | DP-03, AG-03 yes; AS-04 argued | DP-03, AG-03, AS-04 | `sec-fix-daemon-path-confinement.md`, `sec-fix-host-path-guard.md` |
| R5 | The webview has no second line of defence | **Medium** | A2 via S8 | vulnerability (AS-01, AS-05); boundary AD-1 (AS-09) | argued | AS-01, AS-05, AS-09 (mitigated today by AS-07) | `sec-fix-webview-defence.md` |
| R6 | Release readiness: unsigned, un-notarized, no updater, and `main` bundles no sidecars | **Medium** once a build is distributed, Info today | A1 | vulnerability (SC-06); boundary (SC-07, SC-08) | evidence (config) | SC-06, SC-07, SC-08 | `sec-fix-signing-and-sidecars.md` |
| R7 | Session state at rest: `0644` DB files, queued input never reaped | **Low** | A1 | boundary AD-1/AD-5, with a retention fix worth doing | observed | DP-04 | `sec-fix-state-at-rest.md` |
| R8 | No resource caps: sessions, connections, scan size, symlinks out of the repo | **Low** | A2 | vulnerability | argued | DP-05, SC-10 | `sec-fix-resource-caps.md` |
| R9 | No CI on `main`; the branch's `ci.yml` pins actions by tag with no `permissions:` and no `--locked` | **Low** | A1 (CI host) | vulnerability | evidence | SC-04, SC-05 | `sec-fix-ci-on-main.md` |
| R10 | git wrapper omits `--` on ref-taking commands | **Low** | A2 | vulnerability, no reachable input found | argued | AS-08 | `sec-fix-git-end-of-options.md` |

Cards live in `.gavin-root/plans/` on the board; each names its severity, the fix,
and the finding ids, and links back here.

### R1 — No client identity on the daemon socket

Every connection is equal. The daemon establishes no identity (`server.rs:3439`
`bind_server`, `:3478` `handle_connection`), so a session id is the only capability
in the system and any holder of the socket can `CreateSession` a shell (DP-01,
reproduced), `Attach`/`WriteInput`/`KillSession`/`Shutdown` against sessions it did
not open (DP-02, reproduced), write another workspace's cards by absolute path over
MCP while that workspace was never open (AG-03, reproduced), forge the run rows and
statuses the scheduler trusts (AG-08, partially reproduced), and rename or type into
any session because `GAVIN_SESSION_ID` is an id, not a token (AG-09, reproduced). The
13 `gavin_*` tools are narrower than the 62-variant protocol, but the narrowing
grants nothing while the agent also holds a shell and the socket path (AG-04). In the
other direction, a same-user process that binds the socket path first is "the
daemon" to the app (DP-06, argued).

For A1 this is AD-1, the accepted same-user boundary. For A2 it is the gap between
what AD-2 accepts (an agent works its own card, on its own board, in visible
sessions) and what the code allows (any card, any board, any session). For A3 it is
the vulnerability the remote design exists to retire.

**Fix.** Phase 1 of [`05-remote-access.md`](05-remote-access.md): a `Hello` first
request carrying a token the daemon minted, peer credentials (`getpeereid` /
`LOCAL_PEERCRED`) as the uid floor, a role per connection (`local`, `agent`,
later `remote`) checked by an exhaustive `authorize()` in `handle_connection`, the
token handed to agents beside `GAVIN_SESSION_ID` and scoped to the workspace and
card they were launched for, `gavin-mcp` taking the `agent` role, and a server
proof so the app can tell the real daemon (closes DP-06). Untokened local
connections keep full reach until the human flips a switch, so nothing breaks on
the day it lands.

### R2 — Unread repo content reaches an agent on the first Run

A cloned repo's card body is the agent's prompt, verbatim, and the board showed the
human only its title (AG-01, reproduced: a card titled "Fix a typo" carried a hidden
injection body). `attachments:` accepts any absolute path, so the same card makes the
agent read a file anywhere on disk (AG-02, reproduced with a file outside the
workspace). The auto-commit block rides along too. AD-3 accepts the Run click on a
card the human wrote; it explicitly does not accept content the human has not read.

**Fix.** Two cards. A first-Run review at the click: the composed prompt, the
resolved attachments, and the auto-commit block, shown once per card until its body
changes (`sec-fix-first-run-review.md`). And a scope rule for attachments: resolve
inside the workspace root or its extra contexts, else require that review to name
the file (`sec-fix-attachment-scope.md`).

### R3 — A cloned repo's `config.toml` and MCP files are executed as if the human wrote them

`.gavin-root/config.toml` ships with the repo, and three of its keys name things
gavin runs or writes. `[agent] command` becomes the launch shell command for Run
and every rail step with no confirmation naming it (AG-06, traced), and its first
token is executed by the host as a `Command::new` when the Home or Settings tab
merely renders — no Run click at all (AS-02, `superpowers.rs:312-317`, `:245`,
traced). `[worktree] setup` lines are `&&`-chained ahead of the agent when a
worktree is cut (AG-05, traced; the fork dialog shows the line but does not mark it
as repo-controlled). `[agent] file` is written to with no path validation, so an
absolute or `..` value writes gavin's marker block outside the root (AS-03,
reproduced). And a repo-shipped `.mcp.json` / `.codex/config.toml` /
`.gemini/settings.json` / `opencode.json` survives `setup_agent_integration`, which
merges its own `gavin` entry beside whatever servers were already there for the
agent CLI to launch (AG-07, reproduced by an existing test).

AD-6 trusts the human's own configuration and names this exact case as not
accepted. The oversight is that repo-shipped and human-written config share one
code path with no provenance.

**Fix.** Three cards. Workspace trust for the execution keys: a per-workspace
marker gavin writes when the human has blessed the config, before which `[agent]
command` and `[worktree] setup` from disk are inert and shown, and a passive
render never executes anything (`sec-fix-workspace-trust.md`). Path validation for
`[agent] file` (`sec-fix-agent-file-path.md`). And setup that lists pre-existing
MCP servers and asks before leaving them beside gavin's own
(`sec-fix-shipped-mcp-config.md`).

### R4 — Path-taking requests and commands are not confined to a workspace

`delete_card_file` refuses `..`, non-`.md`, and anything outside a
`.gavin*/plans|docs|specs` folder (`gavin.rs:1066-1078`); `SetPlanFrontmatterField`,
`SetChecklistItem`, `InitGavinRoot`, `CreateGavinContext`, and
`AddExternalGavinContext` have no such guard and act on any path the wire names
(DP-03, reproduced). Over MCP that is AG-03's cross-workspace write. Host-side,
six explorer commands apply `fileviewer.rs`'s canonical-root containment and five
do not: `read_file_for_viewer`, `write_file_for_editor`,
`resolve_path_under_cursor`, `watch_file_for_viewer`, `unwatch_file_for_viewer`
take a raw absolute path (AS-04, argued from reading; it only matters from a
compromised page, R5).

**Fix.** Two cards, one per codebase: lift the `delete_card_file` guard into a
shared daemon helper every path-taking writer passes through
(`sec-fix-daemon-path-confinement.md`); put the containment guard on the five raw-path
host commands (`sec-fix-host-path-guard.md`). R1's per-connection workspace scope
then makes "inside a workspace" mean "inside *this* workspace".

### R5 — The webview has no second line of defence

`"csp": null`, and every `#[tauri::command]` is reachable from any in-page script
(AS-01); every destructive confirmation lives in `dialog.ts` on the frontend, so a
script that runs in the page skips them all, including `restart_daemon`, which
kills the shared daemon (AS-05); `opener:allow-open-path` is scoped to `/**` and
`**`, every path (AS-09). Reaching the page needs an XSS through rendered agent or
repo content, and today the two `{@html}` sinks are DOMPurify-sanitised, xterm runs
without `allowProposedApi` (OSC 52 off), and no OSC title reaches the tab name
(AS-07) — so this is defence in depth, not a demonstrated path. All argued.

**Fix.** One hardening card: a CSP that permits what the SPA needs and nothing
inline it does not, `opener` scoped to open workspace roots, and a host-side gate
(a nonce the host mints per confirmation) on the destructive and daemon-lifecycle
commands (`sec-fix-webview-defence.md`).

### R6 — Release readiness

Nothing signs or notarizes the bundle and there is no updater, on any target
(SC-06); the app launches `gavin-daemon` and hands agents `gavin-mcp` by the path
beside its own executable with no integrity check (SC-07, boundary AD-1 — a
same-user process could replace the app too); and on `main`, `tauri build` compiles
both sidecars and bundles neither, so a bundle from `main` would fail at
`resolve_daemon_binary_path` — the staging that works lives only on
`Feat/multi-os-support` (SC-08). Info while nothing is distributed; Medium the day
a build is.

**Fix.** Gated on distribution: land the sidecar staging, then signing and
notarization per target (`sec-fix-signing-and-sidecars.md`), then an updater with
a pinned key — promoted to a card of its own, because a channel that delivers
code to a running install is a decision and a key-custody question rather than a
checklist item (`sec-fix-updater-channel.md`, and `docs/RELEASING.md` for what
each one buys).

### R7 — Session state at rest

The registry, kanban, and orchestration databases are `0644` inside the `0700`
directory, and queued-input text sits in `registry.sqlite` in plaintext and is not
reaped when a session is ended as an orphan (DP-04, observed). Screen content is
*not* persisted — a threat-model correction recorded in both documents. Same-user
reading is AD-1/AD-5; the mode and the retention are the part worth fixing.

**Fix.** `0600` on the database files to match the socket, and reap queued input
on `EndOrphan` and `KillSession` (`sec-fix-state-at-rest.md`).

### R8 — No resource caps

No ceiling on sessions, connections, or threads (one thread per connection); a
hostile repo's plan files are read uncapped on every rescan and symlinked
directories are followed out of the repo (DP-05, argued). The socket reader caps a
line at 1 MiB; the MCP server's stdin reader has no cap, but its only peer is the
agent that launched it (SC-10, Info).

**Fix.** Ceilings on sessions and connections, a size cap on scanned plan files
mirroring `MAX_PRD_BYTES`, and no following of symlinks that leave the root
(`sec-fix-resource-caps.md`).

### R9 — CI

`main` has no `.github/workflows`: no commit is built, tested, or audited anywhere
but the developer's machine (SC-04). The `ci.yml` on `Feat/multi-os-support` pins
four third-party actions by mutable tag, declares no `permissions:`, and runs
`cargo` without `--locked`; it has no `pull_request_target`, no secrets, no
artifact upload (SC-05).

**Fix.** Land CI on `main` with actions pinned by SHA, `permissions: contents:
read`, `--locked`, and `cargo audit` plus `npm audit --omit=dev` as a job
(`sec-fix-ci-on-main.md`).

### R10 — git wrapper omits `--`

`git/run.rs` builds argv arrays (no shell), but the ref-, branch-, and
remote-taking commands omit the `--` end-of-options marker. No injection was
reproduced: reachable inputs are slugged or human-typed, and `ext::` remotes are
blocked by git's defaults (AS-08).

**Fix.** Add `--` to every ref-taking invocation and refuse arguments starting with
`-` where a name is expected (`sec-fix-git-end-of-options.md`).

## Accepted by design, positive, or informational — no card

- **AD-1 boundary, stated as such by the passes:** DP-01 and DP-02 for A1 (same-user
  reach), DP-06 (socket squatting), SC-07 (sidecar path beside the app), AS-09 as
  a standalone (folded into R5 as hardening).
- **AD-2 / AD-4:** AG-04 — an agent's shell plus `gavin_spawn_session`; the MCP
  narrowing is not a boundary and is not claimed as one.
- **AD-7 dev-only:** SC-09 — `tauri dev` on `127.0.0.1:1420`; vite's host and
  origin checks hold, `invoke` is dead outside Tauri, and only `TAURI_DEV_HOST` set
  by the developer exceeds it. SC-02 — all eight npm advisories are in
  devDependencies (vitest 1.x's nested vite/esbuild, nanoid, cookie); nothing
  flagged ships. Bump vitest when convenient; not a security card.
- **Supply-chain facts:** SC-01 — `cargo audit` finds 0 vulnerabilities and 18
  warnings, of which only `serial` (via `portable-pty`, never called) and the
  `unic-*` set (via `tauri-utils`) compile on macOS; SC-03 — 113 crates run a
  `build.rs`, none downloads, `libsqlite3-sys` compiles vendored SQLite 3.45.0,
  both lockfiles pin exactly with checksums, no git/file dependency anywhere;
  SC-11 — RustSec does not track SQLite's own CVEs, and untrusted input reaches it
  only as bound parameters.
- **Positive:** AS-06 — the Claude OAuth token goes Keychain → `curl -K -` on
  stdin, never argv, log, disk, or frontend. AS-07 — DOMPurify is on both `{@html}`
  sinks, OSC 52 is off, no title plumbing; residual risk is a sanitiser or WebKit
  bypass and a Cmd+click that `open`s a repo file.

## Method and limits

- Five passes ran in parallel from this worktree, each reading
  `00-threat-model.md` first, each writing one document; this file was written
  after all five returned and the sources were spot-checked against the code
  (`superpowers.rs`, `settings.ts`, `worktreeSetup.ts`, `gavin.rs`, `registry.rs`).
- Reproductions ran against `target/debug/gavin-daemon` and `gavin-mcp` built from
  this commit, under a temporary `$HOME` with throwaway workspaces. The live daemon
  and the human's window were never touched; no isolated daemon was left running.
- The Tauri host was not built or launched, so every finding whose last step is a
  host command is *traced* (`file:line`) rather than run. `node_modules` is absent
  in this worktree and `npm install` was off-limits, so no vitest run backs the
  frontend claims; those are read from source.
- `cargo-audit 0.22.2` and `cargo-deny 0.20.2` were installed into a scratch
  directory, not the global cargo home; `cargo audit` populated its default
  advisory cache under `~/.cargo/advisory-db`. `Cargo.lock` and
  `app/package-lock.json` are unmodified.
- No source file was changed and nothing was fixed; the cards carry the fixes.
