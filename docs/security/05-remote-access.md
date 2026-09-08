# 05 — Remote access: a mobile client reaching the daemon without widening the blast radius

Design pass over commit `944eae2`, `PROTOCOL_VERSION` 34, 2026-09-08. This pass makes
no findings; it cites `00-threat-model.md` (A3, S1, S2, S5, S12, AD-1..AD-7) and
`01-daemon-protocol.md` (DP-01..DP-06). It is the document an implementation card is
cut from. Nothing in it is a bump: every message shape below is illustrative, and the
version numbers are the implementer's to assign.

## 1. Context and the two facts

Gavin's daemon is a Unix socket at `~/Library/Application Support/gavin/daemon.sock`
(`protocol::socket_path`, dir `0700`, socket `0600` set in `server.rs::bind_server`).
The app opens two connections to it in `session.rs::bootstrap` (one for pushes, one for
request/reply) and `gavin-mcp` opens one per agent process
(`gavin-mcp/src/main.rs::SocketTransport::connect`). Both probe `GetProtocolVersion`,
band the answer with `protocol::version_band`, and gate outgoing requests with
`protocol::gate_request`. That is the entire handshake.

Two facts drive everything that follows.

**Fact 1 — the daemon has no client identity (S1, DP-02).** The socket mode is the whole
access control. `handle_connection` reads a `Request`, intercepts `Attach`, `Snapshot`,
`WatchGavinRoot` and `Shutdown`, and hands everything else to `handle_request`. No
request carries who is asking; no connection is ever different from another. Ids are
capabilities, and `ListSessions` hands every id out for free.

**Fact 2 — the protocol is shell execution by design (S2, DP-01).** Of 62 `Request`
variants, `CreateSession { command }` runs `/bin/sh -c` (`pty.rs:41`),
`SpawnAgentSession { command }` does the same for an agent, `WriteInput` types into any
PTY, `SetRootConfigField { key: "command" }` rewrites what the next Run executes, and
`SetOrchestration` / `SaveTool` install commands the scheduler will later launch. A
proxy that forwards the protocol as it stands is a remote shell on the developer's
machine — which is exactly what the threat model's A3 row says.

So "put the socket behind a tunnel" is not a design; it is the vulnerability. AD-1
accepts the same-uid boundary *for A1 only* and says in so many words that its
permanence is not accepted, because it is the prerequisite for A3. This design retires
AD-1's gap for remote clients by making the **daemon** discriminate: identity on every
connection, a role assigned by the daemon from that identity, and an allow-list checked
in the daemon before any handler runs. A compromised proxy, a stolen phone, or a phone
with a stolen key then holds at most the remote role, and the remote role cannot spawn.

Two more facts from the code shape the answer and are worth stating up front:

- **Running a card is an app operation, not a daemon one.** The prompt is composed in
  the Tauri host (`agent_setup.rs::compose_agent_prompt`) and launched as
  `CreateSession { command }` from `session.rs`. The daemon never composes anything. So
  "Run this card from my phone" cannot be a daemon request at all; it can only ever be
  a request to the desktop app, which is where the human's screen is. This is a gift:
  the most dangerous capability lands naturally behind a desktop confirmation.
- **The daemon only knows what the desktop has shown it.** Boards, trees and
  orchestration are keyed by `workspace_id`, which exists only after the app has sent
  `WatchGavinRoot { workspace_id, root_path }`. A remote client that may not name a
  path can only see workspaces the desktop already has open. "The phone sees what the
  desktop shows" falls out of the existing data model.

## 2. Goals and non-goals

Goals:

- A phone can watch every session's screen, the boards, the rails and the attention
  inbox while the laptop's window is closed and the laptop is behind NAT.
- Every request the daemon accepts is bound to an identity the daemon established, not
  to the proxy. The remote role is an allow-list; a variant not on it is refused before
  its handler runs.
- Nothing in the remote surface can start a process, change what a process will run,
  or reach a filesystem path the daemon did not already know.
- The local app and `gavin-mcp` keep working with no pairing and no configuration, and
  get identities and roles from the same mechanism.
- An older daemon fails closed for a remote client.
- One trust store and one gate, shared with ssh workspaces (`feat-ssh-support.md`).

Non-goals:

- Defeating A1. A same-user process can read the daemon's token file and its key
  material; AD-1 still holds on the local socket and this design does not claim
  otherwise.
- Sandboxing agents (AD-4). The agent role narrows what an agent's *tool calls* can do;
  an agent with a shell can still `nc -U` the socket as a plain local client.
- Multi-user. One human, their own devices, their own daemon. No accounts, no sharing.
- A web client. A browser cannot hold a hardware-bound key or pin a static key the way
  a native app can; the phone app is native.
- Session survival across a daemon restart, OTA, or anything from the compat spec that
  is not the compat window itself.

## 3. Pairing

Pairing is how a phone becomes a device the daemon knows. It happens once per device,
on the desktop, with the human present at both screens.

**The ceremony.** In Settings, the human turns on remote access and presses "Pair a
device". The app sends `BeginPairing` to the daemon; the daemon mints a one-time
pairing secret, records it with a two-minute expiry, and returns the QR payload. The app
draws the QR. The phone scans it, connects (over the transport in §5, or the LAN), and
runs a Noise `XX` handshake with the pairing secret mixed in as a pre-shared key. The
phone sends its static public key and a device name inside the handshake. Both screens
then show a six-digit short authentication string derived from both static keys. The
daemon pushes `DevicePairingRequested { device_id, name, sas }` to the app; the human
compares the two codes and confirms **on the desktop**. Only then does the daemon write
the device into the trust store and answer the phone with `HelloAck { role: "remote" }`.

**What the QR carries.** The daemon's static public key; the pairing secret; the
rendezvous address (relay URL, or LAN host and port, or both); the daemon's protocol
version. That is all.

**What it must not carry.** The daemon's private key. Any bearer token that outlives
the two-minute window. Any token that alone grants access: a photograph of the screen
must not be a device. The relay's own credentials. The phone's key (the phone mints its
own, and it never leaves the phone).

**Why an SAS and a desktop confirmation, not a bare token.** A QR that is itself the
credential is a device that anyone with a photo holds, and it cannot be revoked
separately from the other devices that used it. Rejected. Trust-on-first-use with no
confirmation (first scanner wins) loses to an attacker who photographs the QR and
scans faster than the owner: the desktop would show "iPhone paired" and the human would
nod. The SAS closes that: the attacker's phone and the human's phone produce different
codes, and the code on the desktop belongs to whoever actually completed the handshake.
This is Bluetooth numeric comparison and Signal safety numbers, which is where a
single-developer product should stand rather than invent.

**Where the trust is stored.** A daemon-owned SQLite file, `devices.sqlite`, `0600`, in
the same `0700` directory as the socket, beside `registry.sqlite`, opened by a new
`crates/daemon/src/trust.rs`. Rows: `device_id`, static public key, name, role
(`remote`; the ssh case in §9 adds `app`), `created_at`, `last_seen_at`,
`revoked_at`. The daemon's own static key pair lives in the same file. Rejected: the
app's `config.json`. Three reasons, each sufficient. The daemon enforces, so the daemon
must own the truth: the daemon outlives the window, and a revocation must hold at
02:00 with the app closed. `config.json` is written whole by `persist_workspaces` and
has already lost fields to save sites that did not carry them (the `removedWorkspaces`
incident); a dropped device list is a silent un-pair, and a stale copy restored over a
newer one is a silent re-pair of a revoked phone. And the trust store holds a private
key; `config.json` is a user-editable document the app treats as text. Rejected too:
the macOS Keychain for the daemon's key. It is the better cryptographic home, but the
daemon has no UI to answer an unlock prompt at login, the item would be unlocked for
the same uid anyway (AD-1), and a headless process that stalls on a Keychain dialog is
a daemon that does not come back after reboot. A `0600` file behind a `0700` directory
is the same boundary the socket already rests on; Keychain custody is a later
hardening, listed in §11.

**How many, for how long.** Three devices by default (Settings can raise it). A device's
trust has no scheduled expiry: a certificate that lapses on a laptop that sleeps for a
week is a re-pair the human did not ask for. Instead `last_seen_at` drives a nag: a
device unseen for ninety days is shown greyed with "re-pair to use", and is refused
until re-paired. Rejected: thirty-day trust with silent renewal on use, because
"silent renewal on use" means a stolen phone renews itself.

**Revocation.** From the desktop: the Settings device list has Revoke per row and
"Revoke all devices". Revoke marks `revoked_at`, and the daemon drops every live
connection carrying that `device_id` immediately (the connection holds its identity,
so this is a lookup, not a hunt). "Revoke all" also rotates the daemon's static key,
which invalidates every phone at once even if the store is somehow restored, because
each phone pinned the old key. From the phone: an `Unpair` request removes the phone's
own row; it is a courtesy, not a control, because a lost phone will not send it. On
loss: "Revoke all devices" is the one-button answer, and the pairing screen says so.

## 4. Identity, roles, authorization

**Identity is established per connection, before any other request is read.** A new
type in the daemon, `ClientIdentity { role, session_id: Option, device_id: Option,
transport }`, is constructed once in `server.rs::handle_connection` and stays with the
connection for its life. It comes from two sources, in order of trust:

1. **The transport.** A connection accepted on the Unix socket may become `local`,
   `agent` or `app`, and nothing higher. A connection arriving through `remote.rs`
   (§5) has its identity fixed by the Noise handshake — the static key that completed
   it is looked up in `devices.sqlite` — and may become `remote` and nothing else. The
   transport caps the role: no `Hello` field, no token, no claim in JSON can lift a
   remote connection above `remote`, and a daemon token presented over the remote
   transport is ignored, not honoured. This is the property that makes a compromised
   proxy harmless: the proxy never holds a key, and even the phone that does holds
   only the phone's.
2. **The `Hello`.** The first request on a Unix-socket connection may be
   `Hello { client, protocol_version, auth }`. `auth` is one of: the **daemon token**
   (a random 32-byte value the daemon writes to `daemon.token`, `0600`, in
   `bind_server`, fresh each start) — presenting it yields `app`; a **session token**
   — presenting it yields `agent`, bound to the session the token was minted for;
   nothing — the connection is `local`. A connection that sends anything other than
   `Hello` first is also `local`. That is what keeps today's clients working
   unchanged.

**The session token** is the piece that makes the agent role real. `pty.rs::spawn`
already sets `GAVIN_SESSION_ID` in every session's environment (`pty.rs:81`); it gains
a sibling, `GAVIN_SESSION_TOKEN`, minted per session at creation and stored hashed in
`registry.sqlite`. Every process in that PTY inherits it: the agent CLI, and the
`gavin-mcp` the agent CLI starts as an MCP server. `gavin-mcp` reads it from the
environment and presents it in its `Hello`. The daemon maps token → session →
`workspace_path` (the one `CreateSession` carried), and every path-taking request from
that connection is confined to that root. This is precisely the carve-out AD-2 does not
accept and DP-02 shows is unenforced today: an agent acting on a workspace or session it
was not launched for. Peer credentials alone cannot do this — `getpeereid(2)` says
"same uid", which every client already is — which is why 01's design note pairs them
with a per-client token, and this design does the same. Peer credentials still run at
accept time, as 01 recommends, to reject a cross-uid peer if the socket ever escapes its
directory; they are defence in depth, not identity.

**Roles**, from most to least reach:

| role | who | reach |
|------|-----|-------|
| `app` | the desktop app, holding the daemon token | everything (today's) |
| `local` | any same-uid connection that presents nothing | everything (today's) in phase 1; narrowable by a config switch later (§11 Q1) |
| `agent` | `gavin-mcp` holding a session token | the 17 request types `gavin-mcp` sends today, each confined to the launching session's root and own session id |
| `remote` | a paired device over the remote transport | the allow-list in §6 |
| `none` | a remote connection before its handshake completes | nothing — the handshake is not a request |

`app` and `local` are equal in phase 1 on purpose: phase 1 must break nothing, and the
socket is the same-uid boundary regardless (AD-1). The distinction exists so that
phase 2 can narrow `local` by configuration, so the Sessions manager can show which
connections are the app's, and so server authentication (DP-06) has a token to run on:
the same daemon token, presented by the daemon in `HelloAck`, lets the app verify it
reached the real daemon rather than a squatter that bound the path first.

**Authorization is per request, in one function.** `server.rs::authorize(&identity,
&req) -> Result<(), Forbidden>` runs in `handle_connection` after `read_message` and
before the intercepts and `handle_request` — including before the `Attach`, `Snapshot`
and `WatchGavinRoot` intercepts, so a remote `Attach` to a session it may not see is
refused where the others are. It is an exhaustive `match` over `Request`, like
`min_version_for`: adding a variant without deciding its roles does not compile. The
default for `remote` is deny. For `agent` the match also checks scope: `root_path`,
`path`, `context_folder`, `cwd` and `plan_path` arguments canonicalise inside the
session's root (reusing the confinement helper 01 proposes for DP-03), and
`session_id` arguments equal the connection's own. For `remote`, path arguments are not
confined but *resolved*: a `path` must be a card the watcher already lists, a
`root_path` must be a watched root, a `context_folder` must be a known context;
anything else is refused. A remote never introduces a filesystem path to the daemon.

**Rejected: authorization inside each handler.** Sixty-two handlers each remembering
to check is sixty-two places to forget, and `handle_request` is already 300 lines of
dispatch. One gate, one table, one test that walks every variant against every role.

**Rejected: authorization in the proxy or the phone.** Anything the daemon does not
check, a compromised relay or phone does not have to obey. The gate lives where the
shell is.

**Rejected: capability tokens per session ("the phone holds a token for session X").**
Attractive for the input grant in §6, but it makes the phone the holder of
authorization again, and a stolen phone holds its tokens. Grants are rows in the trust
store keyed by `device_id` and `session_id` with a TTL, checked by `authorize`, and
revocable from the desktop.

## 5. Transport

**Choice: a dumb relay that carries end-to-end Noise ciphertext, with direct
connection (LAN, Tailscale) as the same code path minus the relay.** The daemon dials
out to the relay and holds a WebSocket over TLS; the phone dials the relay; the relay
pairs the two by a rendezvous id (a hash of the daemon's static public key) and from
then on copies bytes. Inside that pipe the phone and the daemon run
`Noise_IK_25519_ChaChaPoly_BLAKE2s`: the phone knows the daemon's static key from
pairing (`IK`, the initiator knows the responder's key), so it can authenticate the
daemon in the first message and the daemon authenticates the phone's static key against
`devices.sqlite` in the second. After the handshake every frame is AEAD-sealed with a
per-direction nonce counter, padded to a 256-byte multiple, and rekeyed every hour or
2^16 frames. The plaintext inside is today's newline-delimited JSON, unchanged; the
decrypted lines feed the same `handle_connection` loop with a `ClientIdentity` of role
`remote`. New module: `crates/daemon/src/remote.rs` (dial, reconnect, handshake,
framing). New crate: `crates/gavin-relay` (rendezvous and byte-copy; small enough to
self-host).

"End to end" concretely: the relay sees TLS to itself on both legs and, inside, a
Noise stream it has no key for. It cannot read a request, forge one, replay one, or
substitute a daemon, because the phone pinned the daemon's key at pairing and the
daemon pinned the phone's. The relay's own TLS certificate is ordinary (Let's Encrypt)
and is trusted for nothing but hiding the rendezvous id from the network.

**Why the daemon dials, not the app.** The daemon outlives the window; the phone's
whole use is checking on agents while the window is closed. An app-hosted connection
dies with the window, and it would have to re-proxy the protocol — a second protocol
path, a second allow-list, exactly what §9 says must not exist.

**Against mTLS end to end through the relay.** It gives the same guarantee with more
moving parts: X.509 on both ends, a lifetime on every certificate (rotation on a laptop
that sleeps for a week is a re-pair the human did not ask for), and either a private CA
or raw-public-key TLS (RFC 7250), whose support in mobile TLS stacks is uneven. Noise
with static keys is what pairing already produces and has no clock in it. Rejected for
the phone; noted in §9 as acceptable for the ssh case where the desktop has a full TLS
stack.

**Against a tunnel the human already runs (Tailscale, SSH).** Tailscale is excellent
where it exists: no infrastructure to run, NAT and sleep/wake handled, and the daemon's
direct listener on the tailnet address is the relay path with the relay deleted. It is
supported as such. It is not the default because it is a third-party dependency the
product cannot assume, and because it authenticates the *network*, not the *client*:
any device on the tailnet reaches the listener, so the daemon still needs `Hello` and
the trust store, which is the whole design anyway. SSH is rejected as a phone transport
outright. A phone has no `ssh -L`, and the thing an ssh tunnel would forward is the Unix
socket — a connection that arrives on the Unix listener is `local`, which is full
reach. Gavin must never document or offer socket forwarding as a remote path. The
transport cap in §4 exists so that even if a human does it to themself (out of scope),
gavin has not built the path.

**Against a gavin-operated relay with no end-to-end layer (TLS to the relay, relay
reads the protocol).** The operator becomes A3 with the whole protocol. Rejected
without further argument; it is the vulnerability with a logo.

**NAT, sleep, and who runs what.** Both ends dial out, so nothing is port-forwarded.
When the laptop sleeps the daemon's WebSocket dies; the suspend watchdog the daemon
already runs (`spawn_suspend_watchdog`) is the natural place to notice wake and
reconnect with backoff, and the phone shows "desktop asleep" — there is nothing to see
while it is, since the agents are suspended too. The relay is a single binary the human
can self-host; gavin can run a public instance; the QR carries whichever URL the
desktop was configured with, so switching is a re-pair, not a migration. What the
operator sees is in §8.

## 6. The capability table

This is the load-bearing section. Columns: the desktop app (`app`), a `gavin-mcp`
holding a session token (`agent`), a paired phone (`remote`). `local` equals `app` in
phase 1 and is omitted. Values: **allow**; **deny**; **scoped** (allowed inside the
launching session's root, or for its own session id); **resolved** (allowed only for a
path the daemon already lists); **grant** (allowed while a desktop-issued per-session
grant is live, §8); **keys** (allowed for a named subset of keys). The phase in which
the remote column lands is given; before that phase it is deny.

Rule for the remote column, stated once: a remote may read what the desktop shows,
may — with a grant — type into a session it can see, may move the human's own cards
around the board the human is watching, and may never start, arm, configure, delete,
or point at a path.

| Request | app | agent | remote | Why the remote column says what it says |
|---|---|---|---|---|
| **PTY** | | | | |
| `CreateSession` | allow | deny | **deny** | `/bin/sh -c`. The variant this document exists to keep off the wire. |
| `SpawnAgentSession` | allow | scoped | **deny** | Same. Agent keeps it (AD-2), confined to its root. |
| `ResizeSession` | allow | deny | **deny** | The PTY has one size, the desktop's. The phone renders the daemon's screen model at that size. |
| **Input** | | | | |
| `WriteInput` | allow | deny | **grant** (ph 5) | Typing into a shell tab is a remote shell; typing into an agent tab is the mobile use case. Only with a live desktop grant for that session. |
| `QueueInput` | allow | deny | **grant** (ph 5) | Text delivered as input later is `WriteInput` with a delay. Same grant. |
| `SendQueuedInput` | allow | deny | **grant** (ph 5) | Fires queued text now. Same grant. |
| `SetQueuedInputs` | allow | deny | **grant** (ph 5) | Reorders or drops queued text for a session. Same grant. |
| `ListQueuedInputs` | allow | deny | **allow** (ph 4) | Read. |
| **Lifecycle** | | | | |
| `KillSession` | allow | deny | **allow** (ph 5) | Stopping a runaway agent is the reason to reach for the phone; a kill starts nothing and `recover()` restores the tab. §11 Q5. |
| `EndOrphan` | allow | deny | **deny** | Ends a process by recorded pid outside any PTY; desktop-only judgement. |
| `Shutdown` | allow | deny | **deny** | Ends the daemon serving every workspace. |
| **Read** | | | | |
| `ListSessions` | allow | deny | **allow** (ph 4) | The list. |
| `SessionProcesses` | allow | deny | **allow** (ph 4) | Command lines and figures; the owner's own. |
| `Attach` | allow | deny | **allow** (ph 4) | Live output. As sensitive as the desktop screen (AD-5); the phone is the owner's. |
| `Snapshot` | allow | deny | **allow** (ph 4) | Screen repaint from the memory-only model (DP-04). |
| `GetBoard` | allow | deny | **allow** (ph 4) | By `workspace_id`, which exists only for watched roots. |
| `GetGavinTree` | allow | deny | **allow** (ph 4) | Same. |
| `GetOrchestration` | allow | deny | **allow** (ph 4) | Same. |
| `CardRuns` | allow | deny | **allow** (ph 4) | Read. |
| `ToolRuns` | allow | deny | **allow** (ph 4) | Read. |
| `GetTools` | allow | deny | **allow** (ph 4) | Read; a tool's `command` is visible, not runnable. |
| `GetGroupTemplates` | allow | deny | **allow** (ph 4) | Read. |
| `ReadPrd` | allow | scoped | **resolved** (ph 4) | Takes a `root_path`; allowed only for a watched root. |
| `GetProtocolVersion` | allow | allow | **allow** (ph 4) | After the handshake; the version also rides in `HelloAck`. |
| **Card writes** | | | | |
| `SetPlanFrontmatterField` | allow | scoped | **keys** (ph 5): `status`, `priority`, `labels` on a resolved card | `agent`, `model`, `attachments`, `complexity` and `parent` shape the next Run's prompt or agent; denied. `status` is scheduler-trusted (S10) and is what "move the card from the sofa" means; §11 Q7. |
| `SetChecklistItem` | allow | scoped | **allow** (ph 5), resolved card | A tick; scheduler-trusted like `status`. |
| `CreatePlan` | allow | scoped | **allow** (ph 5), known context, with `agent`, `model`, `attachments`, `parent` absent | Filing "idea: fix the flaky test" from the phone. The card does not run until the human presses Run on the desktop (AD-3). |
| `NameSession` | allow | scoped | **allow** (ph 5) | A label. |
| `PromoteChecklistItem` | allow | scoped | **deny** | Creates card files; low value remotely. |
| `DeleteCardFile` | allow | deny | **deny** | v34 makes it a purge; irreversible. |
| `ArchiveCard` | allow | deny | **deny** | Kills the card's live agents as a side effect. §11 Q7. |
| `UnarchiveCard` | allow | deny | **deny** | Pairs with archive. |
| **Path-taking (roots, contexts, config)** | | | | |
| `InitGavinRoot` | allow | scoped to the session's `workspace_path` | **deny** | Creates directories at a path. |
| `CreateGavinContext` | allow | scoped | **deny** | Same. |
| `AddExternalGavinContext` | allow | deny | **deny** | Points a workspace at an arbitrary folder. |
| `RemoveExternalGavinContext` | allow | deny | **deny** | Same. |
| `WatchGavinRoot` | allow | deny | **deny** | The desktop decides what is watched; the phone sees what is. |
| `UnwatchGavinRoot` | allow | deny | **deny** | Same. |
| `ScanGavinRoot` | allow | scoped | **deny** | By path; `GetGavinTree` covers the read. |
| `SetRootConfigField` | allow | deny | **deny** | `command` is the agent launch line; `mcp_file` is what gavin writes into the repo. |
| `GitDirtyPaths` | allow | scoped | **deny** | Runs `git status` in any `cwd`. |
| `GetBoardByRoot` | allow | scoped | **deny** | By path; `GetBoard` covers it. |
| `GetOrchestrationByRoot` | allow | scoped | **deny** | Same. |
| `GetToolsByRoot` | allow | scoped | **deny** | Same. |
| **Board and orchestration state** | | | | |
| `SetBoard` | allow | deny | **deny** | Column and label configuration. |
| `DeleteBoard` | allow | deny | **deny** | Same. |
| `SetOrchestration` | allow | deny | **deny** | Rail steps carry tool ids and commands the scheduler launches; arming is configuring execution. |
| `SetOrchestrationByRoot` | allow | scoped | **deny** | Same, by path. |
| `SetRailRun` | allow | deny | **deny** | Scheduler state (S10); the scheduler runs in the app. |
| `SetRailRunByRoot` | allow | scoped | **deny** | Same, by path. |
| `SetStepRun` | allow | deny | **deny** | Same. |
| `ClaimCardForSession` | allow | own session id | **deny** | Binds a card to a session; the remote has no session. |
| `LinkCardSession` | allow | deny | **deny** | Launch bookkeeping. |
| `UnlinkCardSession` | allow | deny | **deny** | Same. |
| `StartToolRun` | allow | deny | **deny** | Same. |
| `SetToolRunOutcome` | allow | deny | **deny** | Same. |
| `SetFailurePatterns` | allow | deny | **deny** | Changes what the daemon calls a failure; app bookkeeping. |
| `SaveTool` | allow | deny | **deny** | A tool carries a `command`. |
| `DeleteTool` | allow | deny | **deny** | Pairs with save. |
| `SaveGroupTemplate` | allow | deny | **deny** | Configures execution. |
| `DeleteGroupTemplate` | allow | deny | **deny** | Pairs with save. |
| **Meta** | | | | |
| `Unknown` | — | — | — | Answered `Unsupported` for every role, as since v12. |

Totals for `remote`: **23 allowed** (14 read-only in phase 4; 9 writes in phase 5, of
which 4 need a grant, 1 is key-restricted, 3 require a resolved card or context, and
`KillSession` is the one lifecycle write), **38 denied**, 1 not applicable. Every
denial is a variant that starts a process, changes what a process will run, arms or
configures the scheduler, or names a path. The agent column is the 17 request types
`gavin-mcp` sends today, each scoped; it is offered here so that phase 1 lands one
table, and pass 03 decides per item whether the scope is right (S10).

Where the gate lives: `server.rs::authorize`, keyed on `ClientIdentity`, on every
connection regardless of transport. Not in the relay, not in the phone, not in the
app. A compromised proxy that forwards a `CreateSession` sees `Forbidden`; so does a
phone whose owner is not the human.

## 7. Protocol sketch

Illustrative shapes; not a bump. Field names are suggestions for the implementer.

**The handshake request and its replies** (additive; one `PROTOCOL_VERSION` bump):

```json
{"type":"Hello","client":"mcp","protocol_version":35,
 "auth":{"kind":"session-token","token":"…"}}

{"type":"HelloAck","role":"agent","daemon_version":35,
 "session_id":"…","server_proof":"…"}

{"type":"Forbidden","request_type":"CreateSession","role":"remote"}
```

- `Hello` is optional on the Unix socket and, if sent, must be first; a second `Hello`
  on a connection is refused. On the remote transport there is no `Hello` in JSON at
  all: identity comes from the Noise handshake, and the first JSON line may be any
  allowed request. `client` is advisory (it names the binary for the Sessions manager);
  the role comes from `auth` and the transport, never from `client`.
- `server_proof` is the daemon-token half of mutual authentication (DP-06): an HMAC
  over the connection's nonce with the daemon token, which the app checks. Over the
  remote transport the Noise `IK` handshake already proved the daemon's static key, so
  the field is absent.
- `Forbidden` is a new `Response` variant. It is only ever sent to a connection that
  has a role other than `app` or `local`, which is to say only to a client that sent
  `Hello` or completed a handshake — a client that by construction knows the variant.
  An old client never receives a `Response` shape it cannot parse, which is the
  response-direction break the compat spec warns about.

**Riding the compat window.** `min_version_for(Request::Hello)` is the new version
(call it 35). A client at 35 talking to a 34 daemon never puts `Hello` on the wire
(`gate_request` refuses it locally) and continues as it does today, in the degraded
band. Should it reach an older daemon anyway (a client that skipped the probe), a
daemon at v12 or later answers `Unsupported { request_type: "unknown" }` from the
`#[serde(other)]` arm, and one older than v12 closes the connection. Both answers are
"this daemon has no identity"; each client class decides what that means:

- **The app** (`session.rs::bootstrap`, in a `verify_daemon_protocol` that grows to send
  `Hello` on both connections right after the probe): continue, as `local`. The
  feature entry is `FEATURE_MIN_VERSION.clientIdentity: 35` in `daemonCompat.ts`, and
  its `featureBlockedReason` consumers are every surface phase 2 adds: the Remote
  access toggle, "Pair a device", the device list, and the per-session input grant
  button. Without a consumer the entry is a dead gate (CLAUDE.md); with these it is a
  greyed panel that names the version it needs. Note that this is the case the
  per-type gate handles well — `Hello` is a new TYPE, so nothing is silently dropped —
  and the entry exists for the copy, as `sessionMetrics` and `runHistory` do.
- **`gavin-mcp`** (`SocketTransport::connect`, after the version probe): send `Hello`
  with the session token from `GAVIN_SESSION_TOKEN` if the daemon's version admits
  it; otherwise continue with no identity, as today. An agent must keep working
  against a daemon inside the window.
- **A remote client**: fatal, always. The phone requires a completed Noise handshake
  whose plaintext channel answers its first request with something other than
  `Unsupported`; anything else is "this daemon does not support remote access", and
  the phone disconnects and says so. But the stronger fail-closed is structural: an
  older daemon has no `remote.rs`, dials no relay, and binds no network listener, so
  there is nothing a phone can reach. The only way a pre-35 daemon meets a remote
  client is a human forwarding their own Unix socket, which the threat model puts out
  of scope and §5 forbids gavin from ever offering.

**Phase 2 additions** (a second bump, `app` role only, so the gate is the role and not
the version):

```json
{"type":"BeginPairing"}                     -> {"type":"PairingOffer","qr":"…","expires_at":…}
{"type":"ConfirmPairing","device_id":"…"}   -> Ok
{"type":"ListDevices"}                      -> {"type":"Devices","devices":[…]}
{"type":"RevokeDevice","device_id":"…"}     -> Ok
{"type":"RevokeAllDevices"}                 -> Ok   (rotates the daemon static key)
{"type":"SetRemoteAccess","enabled":true,"relay_url":"…"} -> Ok
{"type":"GrantInput","device_id":"…","session_id":"…","ttl_secs":1800} -> Ok
{"type":"RevokeInputGrant","device_id":"…","session_id":"…"} -> Ok
```

Pushes to `app` connections: `DevicePairingRequested { device_id, name, sas }`,
`DeviceConnected`, `DeviceDisconnected`, `InputGrantRequested { device_id, session_id }`.
If no `app` connection is live when a confirmation is needed, the daemon refuses the
pairing or the grant with "open gavin on the desktop": the human keeps the wheel, and a
wheel with nobody at it is a refusal, not a wait.

## 8. The proxy's threat model

**A compromised relay** (or a network observer, which is the same set of bytes minus
the relay's TLS) learns:

- that a daemon with rendezvous id R is online, and when — the developer's laptop
  uptime pattern; R is stable, so this is linkable across days;
- when a phone connects to R, from which IP, for how long;
- frame sizes and timing, which distinguish "idle" from "an agent is streaming
  output", and — in phase 5 — a human typing (small, human-spaced frames). Padding
  to 256-byte multiples and coalescing `WriteInput` into 100 ms batches blunt this;
  they do not erase it.

It cannot read or alter a request (AEAD under keys it never had), forge a daemon (the
phone pinned the daemon's static key at pairing, and `IK` proves it in the first
message), forge a phone (the daemon looks the static key up in `devices.sqlite`), or
downgrade (one fixed suite, no negotiation). It cannot replay: nonces are per-direction
counters bound to a handshake with fresh ephemerals, so a frame from one session is
noise in another, and a whole recorded handshake replays into a failed handshake. It
can deny service, delay, and drop, and it can pair the wrong two parties, which fails
at the handshake. Connection binding: a request is authorised against the identity of
the Noise session it arrived on; there is no bearer anything in the plaintext for a
relay to lift out.

**The remote channel gets its own caps**, separate from the socket's 1 MiB line cap
(S2): a 64 KiB line, a per-connection request rate, and a ceiling on concurrent remote
connections per device (two: one streaming, one request/reply, mirroring the app).
These are the resource caps 01 asks for (DP-05) applied where the peer is least trusted.

**A stolen unlocked phone**, until revoked, holds the remote role for its device: it
sees every session's screen (what the human sees — AD-5's secrets-on-screen apply, and
DP-04's correction means this is the live screen, not a store), the boards, the PRD,
and the rails; in phase 5 it can move `status`, tick checklists, file a card, rename
and kill sessions, and type into any session with a live grant. It cannot spawn, arm,
configure, delete, or reach a path — the human's next click on the desktop is still the
human's. Bounds beyond the role: grants are short (30 minutes by default) and are
issued only from the desktop, so the thief types into what the human recently opened
and nothing else; the phone app itself requires the OS biometric to open (a real bound
in practice, though the daemon cannot verify it and this design does not count it);
and "Revoke all devices" on the desktop ends every live connection at once.

**Should `WriteInput` need a desktop grant?** Yes. Unconditional typing for a paired
device makes a stolen unlocked phone a remote shell into whichever shell tab is open,
which is the outcome the whole design exists to prevent. A per-keystroke confirmation
is unusable and defeats the point — the human is on the phone because they are away
from the desktop. A per-session grant with a TTL, issued when the human is at the
desk ("Allow typing from iPhone into this session for 30 minutes"), is the shape that
lets the human hand the phone exactly the sessions they mean to steer from the sofa,
and no other. Agent sessions and shell sessions get the same mechanism; whether agent
sessions deserve a longer default TTL is §11 Q6.

**A stolen key with no device** is the stolen phone minus the biometric, and the daemon
cannot tell them apart. The design's answer is to make the case impossible rather than
detectable: the phone's static key is generated in and never leaves the Secure Enclave
(iOS) or StrongBox/TEE Keystore (Android), so a key cannot be lifted from a backup, a
jailbroken filesystem, or a debugger. Rejected: a software key in app storage, which is
exportable by construction. Where hardware binding is unavailable the pairing
confirmation on the desktop says so, so the human knows what they are trusting.

**The rogue-daemon case (DP-06) on the remote path** is closed by the same pinning: a
squatter that binds the socket path and even dials the relay does not hold the static
key the phone pinned at pairing, so the phone's `IK` handshake fails. On the local
socket it is closed by `server_proof` in `HelloAck` — the daemon token, which a
squatter that started first did not write. This is the "two halves of one mutual
handshake" 01 asks for.

## 9. Shared with ssh workspaces

`feat-ssh-support.md` asks for workspaces on a Linux or Windows machine reached over
ssh. That is the mirror image of this design: there, the **desktop is the remote
client** of a daemon on another host; here, a phone is the remote client of the
desktop's daemon. Both are a client with a network path to a daemon that must not hand
out the whole protocol to whoever arrives. They must share:

- **Client identity on every connection, and one `Hello`.** The desktop, driving a
  daemon on a Linux box, presents its own device key and receives a role from *that*
  daemon's trust store. The role is `app`, because the human's desktop is the human;
  but it is a role that daemon assigned, not a property of arriving over ssh.
- **One gate.** `authorize` with the same table; the ssh path exercises the `app`
  column, the phone the `remote` column. Never a second allow-list for "the ssh case".
- **One trust store.** The remote host's `devices.sqlite` lists the desktop as a paired
  device with role `app`. Pairing over ssh can skip the QR — ssh already authenticated
  the human to that host — and instead install the desktop's public key into the
  remote trust store over the ssh session, the way `ssh-copy-id` does. The ceremony
  differs; the row it produces does not.
- **One transport module** with two dials: `remote.rs` dials a relay for the phone
  case and, for the ssh case, the *desktop* dials the remote daemon's loopback listener
  through an ssh port-forward. The Noise handshake is identical, and it is the Noise
  handshake — not the ssh session — that gives the connection its identity.

Where they must not diverge:

- **Two auth models.** "Being on the host as the user" must not be an identity. If the
  desktop forwards the remote daemon's *Unix socket* over ssh and connects to it, the
  connection is `local` there and the gate is never exercised; every later narrowing of
  `local` (Q1) then silently does not apply to ssh workspaces. The ssh path connects to
  a loopback TCP listener that hands out at most `app`, through the handshake.
- **Two allow-lists.** A request denied to the phone because it names a path is denied
  to the phone on a Linux daemon for the same reason; a request the desktop may send
  locally it may send over ssh. The table has three columns, not five.
- **Two pairing stores.** The desktop's own device key is one key, kept once, used for
  every remote daemon it drives; each remote daemon keeps one `devices.sqlite`. No
  per-workspace key files scattered through `config.json`.

Two facts about the ssh card make phase 1 its prerequisite rather than a nicety. On
Windows there is no Unix socket with `0600` semantics; the daemon's local listener will
be a named pipe or loopback TCP, and the per-client token is then the *only* local
control there is — the ssh card cannot be built on the socket mode this design is
retiring. And the desktop reaching a remote daemon must gate on that daemon's version
exactly as it gates on the local one: `send_request` already routes through
`gate_request` with a `DaemonCompat` per connection, so a remote daemon in the window
is a degraded connection, not an error, which the compat spec already designed for.

## 10. Phased plan

Each phase names what lands, what it proves, and what it must not do yet. Phase 1 is
worth having with no mobile app in sight: it is what 01's closing section asks for
first, and it is what makes AD-2's carve-out enforceable.

**Phase 1 — client identity on the local socket.**
Lands: `Request::Hello`, `Response::HelloAck`, `Response::Forbidden` in
`protocol::Request`/`Response` with a `min_version_for` arm; `ClientIdentity` and
`authorize` in `server.rs`, called in `handle_connection` before the intercepts; the
daemon token written in `bind_server` and rotated per start; `GAVIN_SESSION_TOKEN` in
`pty.rs::spawn` beside `GAVIN_SESSION_ID`, hashed into `registry.sqlite`; peer-uid check
at accept; the app sending `Hello` with the daemon token from `session.rs::bootstrap`
and checking `server_proof`; `gavin-mcp` sending `Hello` with the session token from
`SocketTransport::connect`; `FEATURE_MIN_VERSION.clientIdentity` with its consumers
stubbed on the Settings panel's (not yet existing) Remote access row; the Sessions
manager showing each session's connected client kinds.
Proves: the gate exists and is exhaustive — a test walks every `Request` variant
against every role; an `agent` identity cannot `CreateSession`, `Shutdown`, or touch a
path outside its root; a `remote` identity constructed in a test gets exactly the §6
column; an untokened connection is unchanged from today.
Must not: bind any network listener, dial anything, refuse an untokened local
connection, or change what the app can do.

**Phase 2 — pairing, trust store, revocation UI.**
Lands: `trust.rs` and `devices.sqlite`; daemon static key generation; the phase-2
requests and pushes from §7; the Noise `XX`+PSK pairing handshake as a library the
daemon can run over any byte stream; the Settings panel's Remote access section
(toggle, relay URL, Pair a device with QR and SAS, device list with Revoke, Revoke all).
Proves: a test client driving the pairing handshake in-process over the Unix socket
ends up in `devices.sqlite` only after `ConfirmPairing`; a revoked device's live
connection drops; "Revoke all" rotates the key and every prior device fails `IK`.
Must not: open a listener or dial a relay. Remote access "on" with no transport is a
store with rows in it and nothing to serve.

**Phase 3 — transport and relay.**
Lands: `remote.rs` (dial, reconnect on wake, Noise `IK`, framing, padding, caps) feeding
`handle_connection` with role `remote`; `crates/gavin-relay`; the direct loopback/LAN
listener for the Tailscale case; the daemon dials only when the store says enabled.
Proves: an end-to-end test client through a local relay completes `IK` against the
store, receives `HelloAck { role: "remote" }`, gets every phase-4 read answered, and
gets `Forbidden` for every other variant; a relay that replays or tampers gets a
failed handshake or a dropped frame; a daemon token presented over the remote
transport is ignored.
Must not: allow any write; ship a public relay before the self-hosted one works.

**Phase 4 — the mobile client's read-only surface.**
Lands: the phone app — pairing flow, sessions list, screen view rendered from
`Snapshot` plus `Attach` through a vt model, board, PRD, orchestration status, the
attention inbox; hardware-bound key; biometric to open.
Proves: the product's value with not one write on the wire.
Must not: send `WriteInput` or any variant in the phase-5 set; the phone's own gate
mirrors the table, but the daemon's is the one that counts.

**Phase 5 — typed input with a desktop grant, and the small writes.**
Lands: `GrantInput`/`RevokeInputGrant` and the grant rows; the per-session grant button
on the desktop terminal pane; the phone's input path for granted sessions;
`KillSession`, `status`/`priority`/`labels` moves, checklist ticks, `CreatePlan`,
`NameSession` per §6.
Proves: a `WriteInput` to an ungranted or expired session is `Forbidden`; a grant
revoked on the desktop cuts input mid-session; a card filed from the phone appears on
the board and does not run.
Must not: spawn, arm, or configure. "Run this card from my phone" is a later decision
of its own (an app-side push the desktop confirms, since composition lives in the app);
it is not part of this design.

## 11. Open questions for the human

1. Should an untokened same-uid connection keep full reach (`local` = `app`) after
   phase 1, or be narrowed to the `agent` role? — Default: keep full reach in phase 1;
   add a `require_local_token` switch in phase 2, off by default, so a hand-started
   Claude Code in a terminal keeps its tools.
2. Should gavin run a public relay, or ship `gavin-relay` self-host-only? — Default:
   ship it self-hostable first and run one public instance; the QR carries the URL, so
   the human can point at their own.
3. Maximum paired devices? — Default: three, raisable in Settings.
4. Should device trust ever expire on its own? — Default: no scheduled expiry; a
   device unseen for ninety days must re-pair.
5. Should `KillSession` be in the remote role at all? — Default: yes in phase 5, for
   any listed session, because a runaway agent is the reason to reach for the phone.
6. Grant TTL, and should agent sessions get a longer one than shell sessions? —
   Default: thirty minutes for both, renewable only from the desktop; revisit after
   phase 5 has been used.
7. Should the phone be allowed the scheduler-trusted card writes (`status`, ticks) and
   the archive pair? — Default: `status`/`priority`/`labels` and ticks yes in phase 5;
   archive stays denied because it kills live agents.
8. Hardware-bound device keys: mandatory or best-effort? — Default: mandatory on iOS;
   best-effort on Android with the pairing confirmation naming which it got.
9. Should `feat-ssh-support.md` be re-cut to depend on phase 1? — Default: yes; the ssh
   card becomes "phase 1 plus a transport and an `ssh-copy-id`-style pairing", not its
   own auth model.
10. Daemon private key in a `0600` file or the Keychain? — Default: file, same boundary
    as the socket; Keychain custody is a later hardening once the daemon has a way to
    ask.
11. Padding bucket and input coalescing? — Default: 256-byte frames and 100 ms
    `WriteInput` batches; both are constants a later measurement can move.
12. Should a `tauri dev` build refuse to enable remote access? — Default: yes (AD-7);
    the dev build has a live vite server and an HMR socket, and a paired phone should
    never meet either.
