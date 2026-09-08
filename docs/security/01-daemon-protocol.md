# 01 — Daemon & protocol surface

Scope: `gavin-daemon` and the `protocol` crate at commit `944eae2`, branch
`sec/review-2026090801`, `PROTOCOL_VERSION` 34. Read in full:
`crates/protocol/src/lib.rs` (the 62 `Request` variants incl. `Unknown`,
`min_version_for`, `gate_request`, `version_band`, `read_message`/`write_message`,
`socket_path`, `usable_prd_path`), `crates/daemon/src/{main,server,pty,registry,
kanban,orchestration,screen,gavin,proc,git_status}.rs`. Every finding was checked
against an isolated daemon built from this worktree, run under a throwaway `$HOME`
(its socket path had to live under `/tmp` — the scratchpad path overflows macOS
`SUN_LEN` — and the process was stopped by pid at the end; the live daemon was
never touched). Cites the threat model `docs/security/00-threat-model.md`:
adversaries A1–A3, surfaces S1–S12, accepted-by-design AD-1..AD-7.

## Findings

| id | severity | adversary | kind | reproduced | one line |
|----|----------|-----------|------|------------|----------|
| DP-01 | Critical | A3 (A1/A2 boundary) | boundary (AD-1/AD-2/AD-4) | yes | Any connection runs a shell: `CreateSession{command}` → `/bin/sh -c`, output read back over the same socket, no auth of any kind. |
| DP-02 | High | A2 (A1 boundary) | boundary (AD-1); vuln for A2 | yes | No client identity: a session id is the only capability, so any connection can `Attach`/`WriteInput`/`Snapshot`/`KillSession`/`Shutdown` against sessions and workspaces it did not open. |
| DP-03 | Medium | A2 (A1 boundary) | vulnerability | yes | Path-taking writes are not confined: `SetPlanFrontmatterField`, `SetChecklistItem`, `InitGavinRoot`, `CreateGavinContext`, `AddExternalGavinContext` act on any path — a guard `DeleteCardFile` has but they don't. |
| DP-04 | Low | A1 | boundary (AD-1/AD-5) | n.a. (observed) | Queued-input text sits in `registry.sqlite` in plaintext; DB files are `0644` (not `0600`). Threat-model correction: screen snapshots are NOT persisted. |
| DP-05 | Low | A2 | vulnerability | no (argued) | No caps on sessions, connections, or threads; a hostile repo's plan files are read uncapped on every rescan, and symlinked dirs are followed out of the repo. |
| DP-06 | Low | A1 | boundary (AD-1) | no (argued) | Socket squatting: a same-user process that binds the socket path first becomes "the daemon" and MITMs the app (no server authentication either). |

---

## DP-01 — Any connection obtains a shell (`CreateSession` → `/bin/sh -c`)

**What.** The socket carries no authentication. There is no peer-credential check
(`SO_PEERCRED`/`LOCAL_PEERCRED`/`getpeereid`), no token, no capability, and no
handshake — a client need never even send `GetProtocolVersion`; the daemon serves
the first parseable line. `CreateSession { workspace_path, cwd, command }` hands
`command` straight to a PTY that runs it under `/bin/sh -c`, and `SpawnAgentSession`
does the same after resolving a watched root. So one line on the socket is a shell
running as the developer.

**Where.**
- Bind, with no auth: `crates/daemon/src/server.rs:3439` (`bind_server` — dir `0700`,
  socket `0600`, nothing else), `crates/daemon/src/server.rs:3478` (`handle_connection`
  reads a line, dispatches, no identity established).
- Command → shell: `crates/daemon/src/pty.rs:41` (`CommandBuilder::new("/bin/sh")`,
  `args(["-c", c])`), reached from `create_session` `crates/daemon/src/server.rs:1426`
  and `spawn_agent_session` `:1381`.
- Absence of a check confirmed: `grep -niE 'peer_cred|SO_PEERCRED|LOCAL_PEERCRED|getpeereid|ucred|authenticate|token|handshake|credential'`
  over `crates/daemon/src` and `crates/protocol/src` returns only unrelated hits
  (card titles, API-error comments, the pid-reuse "identity token").

**Impact per adversary.**
- **A1** (same-user process): AD-1 and AD-2 — a process already running as the uid
  can `exec` a shell directly, so reaching the daemon adds no privilege. Boundary.
- **A2** (agent gavin runs): AD-2/AD-4 — the agent already holds a shell as the user,
  and `gavin_spawn_session` is explicitly a first-class tool. Boundary *as a
  capability*, but see DP-02 for the part AD-2 does **not** accept (acting on other
  sessions/workspaces).
- **A3** (future remote exposure): **Critical.** The threat model states it outright —
  "`CreateSession { command }` is a remote shell." Any proxy or off-machine path that
  forwards this protocol forwards unauthenticated remote code execution. This is the
  single request a remote design (pass 05) must never expose without per-connection
  identity and per-request authorization.

**Reproduction (isolated daemon, `PROTOCOL_VERSION` 34).**
A second process, as the user, connects to the isolated socket and reads a shell's
output:
```
-> {"type":"CreateSession","workspace_path":"/tmp","cwd":"/tmp","command":"echo GAVIN-PROBE-$$; sleep 0.2"}
<- {"type":"SessionCreated","id":"0f41f2ea-…"}
   # a fresh connection then:
-> {"type":"Attach","id":"0f41f2ea-…"}
<- {"type":"Output","id":"0f41f2ea-…","data":"GAVIN-PROBE-85493\r\n"}
<- {"type":"SessionExited","id":"0f41f2ea-…","exit_code":0}
```
The `echo` ran under `/bin/sh -c` and its output came back over the socket with no
credential presented at any point.

**AD.** AD-1 (A1), AD-2/AD-4 (A2). For A3 there is no accepting AD entry — it is the
vulnerability the accepted A1 boundary is the prerequisite for.

---

## DP-02 — No client identity: a session id is the only capability

**What.** Because no connection has an identity, authorization is by knowledge of a
session id alone. `ListSessions` (unauthenticated) returns **every** live session's
id, cwd, and command, so ids need not even be guessed. Armed with an id, any
connection can:
- **read** another session's screen and live output — `Attach` / `Snapshot`
  (`server.rs:3489`, `:3500`), which stream that session's PTY to the requesting
  connection;
- **inject** keystrokes — `WriteInput` / `QueueInput` / `SendQueuedInput`
  (`server.rs:3143`–`:3151`) type into a PTY the caller never created;
- **destroy** — `KillSession` (`server.rs:3155` → `forget_session`, `:2350`),
  `EndOrphan`, and `Shutdown` (`handle_connection`, `server.rs:3532`, which calls
  `std::process::exit(0)` for whoever asks).

The same holds across *workspaces*: `GetBoard`/`SetBoard`/`DeleteBoard`,
`GetOrchestration`/`SetOrchestration`, `SetRailRun`/`SetStepRun`, `ClaimCardForSession`,
`SaveTool`, the whole `*ByRoot` family — none check which client, or which workspace,
is asking. The `ByRoot` requests only require the workspace to be *watched* by some
connection, not by the caller.

**Where.** `server.rs:1466` (`list_sessions` — no filter), `:2095` (`write_input`
looks up the session by id and writes, no owner check), `:2308` (`kill_session`),
`:2599` (`attach`), `:3532` (`Shutdown` → `exit`). Session ids are `Uuid::new_v4`
(`server.rs:1447`) — unguessable, but `ListSessions` hands them out for free.

**Impact per adversary.**
- **A1**: AD-1 — a same-user process can `kill`/`ptrace`/read the fds of these
  processes anyway. Boundary.
- **A2**: **High, vulnerability.** This is precisely what AD-2 does *not* accept: "an
  agent acting on a card or workspace it was not launched for." An agent holding the
  `gavin_*` tools speaks this protocol over the same socket the app uses (S5); the
  daemon cannot distinguish it from the app, so a prompt-injected agent in workspace X
  can enumerate and drive the human's terminals in workspace Y — inject a command into
  a running root shell, read another agent's screen (and any secret pasted into it),
  kill sessions, or `Shutdown` the daemon serving every workspace. The scheduler-trust
  half (forging `status`/`ClaimCardForSession`/`SetStepRun`) is pass 03's (S10), but
  the daemon-level cause — no client identity — is here.
- **A3**: rolled into DP-01 (a remote client is just another equal connection).

**Reproduction.**
```
# connection A creates a session running `sh`
-> {"type":"CreateSession","workspace_path":"/tmp","cwd":"/tmp","command":"sh"}
<- {"type":"SessionCreated","id":"51e1880f-…"}
# connection B (different socket) attaches and injects input it never owned
-> {"type":"Attach","id":"51e1880f-…"}
-> {"type":"WriteInput","id":"51e1880f-…","data":"echo INJECTED-BY-OTHER-CLIENT\n"}
<- {"type":"Output",…,"data":"INJECTED-BY-OTHER-CLIENT\r\nsh-3.2$ "}
# connection C kills it
-> {"type":"KillSession","id":"51e1880f-…"}
<- {"type":"Ok"}
# any connection stops the whole daemon
-> {"type":"Shutdown"}
<- {"type":"Ok"}      # process then exits (verified: pid gone)
```

**AD.** AD-1 for A1. No AD accepts the A2 cross-session/cross-workspace case — AD-2
explicitly carves it out.

---

## DP-03 — Path-taking writes are not confined to a workspace

**What.** Several request handlers take a path or root from the wire and write there
with no check that it belongs to a gavin workspace. The Request doc comments assert an
invariant ("this must never become an arbitrary-line writer", "guarded to
`.gavin*/plans|docs|specs/` paths") — and `DeleteCardFile` **does** enforce it (rejects
any `..` component and requires an ancestor `plans|docs|specs` under a `.gavin*`
folder: `gavin.rs:1064`). The write paths do not:

- **`SetPlanFrontmatterField { path, key, value }`** → `set_plan_field`
  (`gavin.rs:797`) → `write_plan_field` (`gavin.rs:281`) does
  `read_to_string(path)` then rewrites — with **no** check that `path` is inside any
  `.gavin*` tree and **no** `..` rejection. It prepends or edits an allow-listed
  frontmatter block (`status|priority|order|title|kind|parent|labels|attachments|
  complexity|agent|model`, single-line validated values) on *any* file the uid can
  write. That is an arbitrary-file tamper primitive: it corrupts source files, shell
  rc files, anything, by prepending a `---\n…\n---\n` block.
- **`SetChecklistItem { path, … }`** (`gavin.rs:927`) — same, restricted to files that
  contain a matching `- [ ] text` line.
- **`InitGavinRoot { root_path, … }`** (`gavin.rs:1214`) and
  **`CreateGavinContext { parent_folder }`** (`gavin.rs:1238`) scaffold a full
  `.gavin*/{plans,docs,specs}` skeleton plus `config.toml`, `PRD.md`, and `.gitkeep`
  into *any* directory that exists.
- **`AddExternalGavinContext { root_path, folder }`** (`gavin.rs:1273`) scaffolds
  `.gavin` in any folder *outside* the root and records it in `config.toml`.

`usable_prd_path` (`protocol/lib.rs:1988`) *does* confine the `prd` sub-path (rejects
absolute and `..`), and `create_plan_file` confines the file name and requires an
existing `.gavin`/`.gavin-root` under the context folder — but the context folder,
root, and plan path themselves are unconfined.

**Where.** Writers listed above; contrast the guard in `delete_card_file`
(`gavin.rs:1064`–`1086`).

**Impact per adversary.**
- **A1**: AD-1 — a same-user process can write these files directly. Boundary.
- **A2**: **Medium, vulnerability.** Per the severity scale this is "a guard that
  exists on one entry point and not another" — `DeleteCardFile` is guarded, the writers
  are not. An agent already has a shell (AD-4), so the escalation over A2's baseline is
  modest, but the daemon breaks its own stated invariant, and the same unconfined write
  is a latent High for A3 (an off-machine client that has *no* shell would gain
  arbitrary-file tampering). Which of these reach an agent as `gavin_*` MCP tools is
  pass 03's mapping (S5); the daemon-level fact is that the path is not confined.

**Reproduction.** A file outside any workspace, no `.gavin` anywhere near it:
```
$ cat $GVH/victim.sh
export SECRET=1
-> {"type":"SetPlanFrontmatterField","path":"$GVH/victim.sh","key":"status","value":"PWNED"}
<- {"type":"PlanFieldSet","path":"$GVH/victim.sh"}
$ cat $GVH/victim.sh
---
status: PWNED
---
export SECRET=1
```
And `InitGavinRoot` on a plain directory created
`arbitrary-dir/.gavin-root/{PRD.md,config.toml,plans/.gitkeep,docs/.gitkeep,specs/.gitkeep}`.

**AD.** AD-1 for A1. Not accepted for A2/A3 — the code's own invariant says these must
not be arbitrary-path writers.

---

## DP-04 — State at rest: plaintext queued input, `0644` DB files (and a threat-model correction)

**What.** The daemon persists to three SQLite files in `~/Library/Application Support/
gavin/` (`main.rs`): `registry.sqlite`, `kanban.sqlite`, `orchestration.sqlite`. The
dir is `0700` (`main.rs`), the socket `0600` (`bind_server`), but the DB files are
created at the process umask — observed `0644`.

- `registry.sqlite` `queued_inputs` (`registry.rs:211`) stores the human's pasted
  follow-up **text in plaintext**, plus each session's `cwd` and `command`. It persists
  across daemon restarts by design (the feature: a queued message must survive the app
  closing). It is deleted when the session is removed — `KillSession`/natural exit →
  `forget_session` → `registry.remove` (`registry.rs:378`) drops the row and its queue —
  but `EndOrphan` clears only the orphan and leaves the session row (and its queue) in
  place.
- `kanban.sqlite` `card_runs`/`card_sessions` and `orchestration.sqlite`
  `tool_runs` store command lines, cwds, conversation ids, and base SHAs — low
  sensitivity, but a same-user reader learns the shape of every run.

**Threat-model correction.** S3 and AD-5 say "screen snapshots" and "scrollback" live
in SQLite. They do not. Screen state is an in-memory `screens: HashMap<String,
Arc<Mutex<SessionScreen>>>` (`server.rs:1116`), a `vt100::Parser` with a 500-row
scrollback (`screen.rs:21`), rebuilt from PTY replay and **dropped on session exit/kill**
(`spawn_pump` end, `forget_session`). No table stores screen bytes
(`grep 'screen|snapshot|scrollback'` over all three stores is empty). So a secret merely
*displayed* on a terminal is never at rest; only a secret the human *queued as input* is.

**Where.** `registry.rs:211` (queue schema, plaintext `text`), `main.rs` (dir `0700`;
DB files at umask → `0644`), `server.rs:1537` (`end_orphan` does not delete the queue).

**Impact per adversary.** **A1**, boundary. The `0700` dir is the real boundary; a
same-user reader (AD-1) can open the DBs regardless of the `0644` file bit, and AD-5
accepts that terminal-derived content lives on disk under that dir. Two sub-points
worth recording: (1) `0644` is more permissive than the socket's `0600` — pure
defense-in-depth, it would matter only if the dir mode ever regressed; (2) queued
plaintext outlives the window by design and an orphaned session's queue is never
reaped. **A2** reads it as a shell (AD-1/AD-5). **A3** — n.a. (no network read path
today).

**Reproduction.** n.a. — modes observed directly: `drwx------` on the dir,
`srw-------` on the socket, `-rw-r--r--` on each `*.sqlite`.

**AD.** AD-1, AD-5.

---

## DP-05 — No resource caps; hostile-repo scan reads uncapped

**What.** Nothing bounds how much a client can make the daemon allocate:
- **Sessions**: `create_session` (`server.rs:1426`) has no count cap; each attached
  session spawns a pump thread (`spawn_pump`, `server.rs:2798`) and can spin repo-poll
  threads. **Connections**: `serve` (`server.rs:3454`) spawns one thread per accepted
  connection with no cap and no rate limit. A1/A2 can exhaust threads, fds, and PTYs.
- **Bounded, correctly**: a single request line is capped at 1 MiB
  (`MAX_LINE_BYTES`, `protocol/lib.rs:7`, enforced in `read_message`), and per-screen
  memory is capped at 500 scrollback rows (`screen.rs:21`, ~4 MB).
- **Hostile repo (S4)**: `scan_root` → `build_context` (`gavin.rs`) calls
  `std::fs::read_to_string` on **every** `plans/*.md` file with **no size cap** (only
  the PRD read is capped, `MAX_PRD_BYTES` 1 MiB) to compute frontmatter and checklist
  counts, and it re-runs on every debounced rescan. A cloned repo with a giant
  `plans/*.md` forces a full read into memory on each change. `MAX_SCAN_DEPTH` 12 and
  `EXCLUDED_DIRS` bound the walk, but `entry.path().is_dir()` follows symlinks, so a
  symlinked directory inside the repo lets the scan wander outside it (read
  amplification within the uid).
- **Robust where it matters**: broken frontmatter degrades to `parse_warning` and never
  panics (`plan_file_info`), and `parent:` handling matches direct children only, so a
  `parent:` cycle does not loop.

**Impact per adversary.** **A2**, Low, vulnerability (missing caps). A prompt-injected
agent or a hostile clone can degrade the daemon (and thus every workspace it serves),
but not cross a confidentiality/integrity boundary by this alone. **A1** — AD-1.

**Reproduction.** Not reproduced — argued from reading. (A 50-session run is safe but
was not needed to establish the absence of a cap, which is visible in the code.)

**AD.** AD-1 for A1; the missing caps are a hardening gap, not an accepted boundary.

---

## DP-06 — Socket squatting: a rogue daemon impersonates gavin to the app

**What.** `bind_server` (`server.rs:3439`): if the socket path exists and a
`UnixStream::connect` to it succeeds, the daemon concludes "another gavin-daemon is
already listening" and **bails**. So a same-user process that binds
`~/Library/Application Support/gavin/daemon.sock` *first* holds the name, and the real
daemon refuses to start. Because there is no *server* authentication either (the app
does not verify what it connected to beyond `GetProtocolVersion`), the app then talks to
the impostor: it can serve fabricated boards and trees, capture every keystroke and
pasted secret the human types into "terminals," and spawn real PTYs of its own.

**Where.** `server.rs:3439`–`3452` (`bind_server` probe-and-bail), `protocol/lib.rs:2160`
(`socket_path` — a fixed, predictable location).

**Impact per adversary.** **A1**, boundary (AD-1). A same-user process can already read
`~/Library` and exec anything; squatting adds no privilege it lacked. It is recorded
because it is the concrete mechanism by which "A1 can reach the daemon" becomes "A1 is a
persistent man-in-the-middle of the human's app," which is the shape a client-identity
scheme (below) has to defeat, and which pass 05 must weigh for any remote design.
Not applicable to A2/A3 today.

**Reproduction.** Not reproduced — argued from reading `bind_server`.

**AD.** AD-1.

---

## What the daemon would need to gain

Design notes, in dependency order. Nothing here is a fix to apply now.

- **Client identity on the socket, first.** Everything else rests on the daemon knowing
  *who* connected. On macOS that is `getpeereid(2)` (or `LOCAL_PEERCRED` via
  `getsockopt`) at accept time to confirm the peer uid matches the daemon's own — the
  minimum that lets the daemon reject a cross-uid client if the socket ever escapes its
  `0700` dir. It does **not** separate two processes of the same uid (the app from an
  agent from a rogue), so it must be paired with a **per-client token**: a secret the
  daemon mints into a file only the app can read (or hands the app at spawn), presented
  on a connect handshake, so the daemon can tell the app's connections from an agent's
  and scope what each may do. This is the prerequisite for DP-01, DP-02, and any A3
  design.

- **A role or scope on each connection.** With identity established, requests stop being
  uniformly available. The app connection is privileged; an agent's connection (via
  gavin-mcp, S5) is scoped to the workspace and session it was launched for, so
  `Attach`/`WriteInput`/`KillSession`/`Shutdown` and the cross-workspace `SetBoard`/
  `SetOrchestration`/`ClaimCardForSession` writes are refused when they name something
  outside that scope. This is what makes AD-2's carve-out ("not a session it was not
  launched for") enforceable rather than merely stated (DP-02, and the S10 half in pass
  03).

- **Path confinement for every path-taking request.** Lift `delete_card_file`'s guard
  (reject `..`, require an ancestor `.gavin*/plans|docs|specs`, and canonicalize to
  defeat symlinked path segments) into a shared helper that `SetPlanFrontmatterField`,
  `SetChecklistItem`, `InitGavinRoot`, `CreateGavinContext`, and `AddExternalGavinContext`
  all pass through, so no request writes outside a known workspace tree (DP-03). Follow
  symlinks deliberately, not incidentally, in the scanner (DP-05).

- **Retention and least storage.** Reap an orphaned session's queued input when the
  orphan is ended, not only when the session is removed; consider encrypting or
  at least `0600`-ing the DB files so the on-disk bit matches the socket's, as
  defense-in-depth behind the `0700` dir (DP-04). Confirm — and then keep true — that
  screen content stays in memory only, and update S3/AD-5 to say so.

- **Resource caps.** A ceiling on concurrent sessions and connections, a per-connection
  rate limit, and a size cap on the plan files the scanner reads (mirroring
  `MAX_PRD_BYTES`) turn DP-05 from "degrade at will" into a bounded cost.

- **Server authentication, to close the impersonation loop.** The same token that
  identifies the client to the daemon lets the app verify it reached the *real* daemon
  and not a squatter that bound the path first (DP-06) — the two halves of one mutual
  handshake.
