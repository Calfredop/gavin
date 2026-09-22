# SSH workspaces — a workspace whose root lives on another machine

Design for `.gavin-root/plans/feat-ssh-support.md`, over commit `662e977`,
`PROTOCOL_VERSION` 38. The desktop may be macOS, Linux or Windows; the host it
reaches may be Linux or Windows. Read `docs/security/05-remote-access.md` §9
first: this document is what that section's "ssh case" becomes with the
phases it depends on not yet built.

## 1. The one fact that decides the shape

Everything that touches a workspace's files already lives in the daemon, and
the daemon already builds and runs on all three OSes:

- PTYs and the shells and agents inside them (`pty.rs`, `shell.rs`)
- the `.gavin*` watcher, the tree, the cards, the PRD (`gavin.rs`)
- the kanban and orchestration stores (`kanban.rs`, `orchestration.rs`)
- git status for a session's cwd (`git_status.rs`)
- the per-session token that scopes `gavin-mcp` (`server.rs::authorize`)

So an ssh workspace is **the desktop driving a second daemon**, the one running
where the workspace is, and not a second implementation of anything. The
alternative — the desktop's own daemon spawning `ssh host` inside a local PTY —
gives a terminal and nothing else: the board would watch a `.gavin-root` that
is not there, git status would run against the wrong disk, and an agent on the
far side would find no `gavin-mcp` to talk to. Rejected; it is not a workspace.

What does NOT live in the daemon is the Tauri host's local-filesystem work: the
Git tab (`app/src-tauri/src/git`), the Files tab and file viewer
(`fileviewer.rs`), writing MCP config and composing card prompts
(`agent_setup.rs`), worktree setup and the delete wizard. §7 says what happens
to those.

## 2. Transport: ssh's stdio, through a bridge subcommand

`gavin-daemon bridge`, run ON THE HOST, does three things and nothing else:

1. Connects to that host's own daemon endpoint — the Unix socket or the named
   pipe `protocol::socket_path()` names for the bridge's own build profile —
   and, when nothing answers, starts `gavin-daemon` (its own executable)
   detached and polls until it does. The same connect-or-spawn the app does
   locally in `daemon.rs`; a headless Linux box has nobody else to start it.
2. Prints one banner line to stdout:
   `{"type":"BridgeReady","protocolVersion":38,"daemonToken":"…","hostOs":"linux","home":"/home/me"}`.
3. Relays stdin → daemon and daemon → stdout until either side closes, then
   closes the other and exits.

The desktop runs `ssh -T -o BatchMode=yes … <host> "<gavin-daemon>" bridge`
once per connection it wants — the app opens two to a daemon, one streaming
and one request/reply, and keeps that — and speaks newline-delimited JSON
over the child's stdio.

**Why stdio and not `ssh -L`.** OpenSSH forwards TCP ports and Unix sockets.
On Windows the daemon's endpoint is a named pipe, which ssh cannot forward at
all; adding a loopback TCP listener to the daemon for the purpose means a new
listener with its own access control, a port to choose and to collide on, and
a second way in that stays open when the ssh session is gone. Stdio needs no
port, no listener, no cleanup, and no ssh feature beyond running a command,
and it is identical on every host OS. The cost is one process per connection,
which `ControlMaster` in the human's own `~/.ssh/config` collapses onto one
TCP session if they care.

**Why not the Noise handshake 05 §9 describes.** That handshake lives in
phases 2–3 of the remote-access design (`trust.rs`, `remote.rs`, a loopback
listener), none of which exist. The bridge is what those phases' "one
transport module with two dials" will dial for the ssh case; until then, ssh
is the authenticated, encrypted channel and the token below is the identity.
Nothing here has to be undone when they land: the bridge relays bytes and
does not care what handshake rides inside them.

**The daemon on the host must be installed by the human.** A release install
puts `gavin-daemon` beside the app; a headless box gets the binary copied
somewhere and named in the workspace's ssh settings (`daemonPath`, default
`gavin-daemon` on the host's PATH). The bridge is a subcommand of the daemon
binary precisely so there is one file to copy and the bridge always spawns a
daemon of its own version, which binds the endpoint its own profile names.

## 3. Identity: the host daemon's own token, so the gate is exercised

05 §9 draws one line the ssh path must not cross: a connection to a forwarded
Unix socket is role `local` on that daemon, and every later narrowing of
`local` silently misses ssh workspaces. The bridge reads the host's
`daemon.token` (`0600`, written by that daemon at start, readable because ssh
runs the bridge as the same user) and hands it to the desktop in the banner.
The desktop sends `Request::Hello { auth: DaemonToken }` on both connections
and verifies `server_proof`, exactly as `session.rs::app_handshake` does
locally. The connection is role `app` **because that daemon said so**, the
gate in `server.rs::authorize` runs on every request, and `require_local_token`
on the host does not touch it.

The token crosses only inside the ssh channel and lives only in the app's
memory for the life of the link. It is never written to `config.json` — that
file is user-editable text the app treats as such — and never sent anywhere
else. A same-user process on the desktop that could read it from memory could
equally run `ssh host` itself; nothing widens.

The host daemon's version is probed with `GetProtocolVersion` on the command
connection and banded with `classify` into a `DaemonCompat` **per link**, so a
host daemon inside the window is a degraded link with the newer requests gated
off, not an error, and a newer one is the same named error as locally. The
app's own daemon never gates a remote request: each link carries its own
verdict.

## 4. In the app: a link per host, the same `Stream` everywhere

`app/src-tauri/src/remote.rs`:

- `SshConfig { host, daemonPath? }` on `Workspace` (`config.rs`, camelCase,
  `skip_serializing_if` absent), and `ssh?: SshConfig` on the frontend
  `Workspace` type so the whole-list save round-trips it. `rootPath` stays the
  workspace's absolute path **on the host**, forward slashes, as `wire_path`
  already requires of every path on the wire. Machine-local: how this desktop
  reaches the host is not a fact about the project.
- `RemoteLink { host, compat, writer, command, home, host_os }` — the same
  three things the local connection is made of, plus what the banner said.
  It is built by spawning the ssh child, reading the banner, and then
  `Stream::pair()`: two pump threads copy child stdout → pair and pair →
  child stdin, so the rest of the app holds a `Stream` indistinguishable from
  a local one and `send_command_reconnecting`, `attach_and_relay` and the
  handshake are reused rather than re-implemented. A pair has no endpoint on
  the filesystem, so no other process can connect to it. A pair also has no
  `peer_path`, so the one-shot reconnect in `send_command_reconnecting`
  degrades to a single attempt on a link; a dropped link is reported as such
  (below) rather than silently redialled.
- `RemoteLinks` (host → `Arc<RemoteLink>`) and `SessionHosts` (session id →
  host), managed at bootstrap.
- Routing. A command finds its link by whichever argument it already carries:
  the session id (`SessionHosts`, filled when a session is created, adopted or
  resolved on a link), the workspace id (`Workspace.ssh`), the root path (a
  workspace whose `rootPath` is that path), or a card path (the workspace
  whose `rootPath` prefixes it). No link means local, and the local path is
  byte-for-byte what it was. The frontend's invoke signatures do not change.
- Pushes from a link go through `attach_and_relay` into the same Tauri events
  the local daemon's pushes take; session ids are UUIDs from whichever daemon
  minted them and workspace ids are the app's own, so the frontend does not
  need to know which daemon spoke. The one difference is the disconnect: a
  lost local connection is `daemon-error` (the whole-window overlay); a lost
  link is `remote-link-lost { host, message }` and only that host's
  workspaces are affected.
- Bootstrap. `resolve_workspaces`, `reconcile_main_sessions` and
  `attachable_session_ids` skip ssh workspaces — they are questions for the
  local daemon, which has never heard of a remote session id and would
  replace every one of them with a fresh local shell. After `workspaces-ready`
  a thread links each host: opens the link, resolves that workspace's pages
  against the host daemon's sessions (fresh sessions there for dead ids, with
  the banner's `home` as the cwd fallback rather than the desktop's), attaches,
  sends `WatchGavinRoot`, persists the resolved layout and emits
  `remote-link-ready { host, workspaces }`. A host that is down at startup
  costs the app nothing but that event never arriving; the same routine is
  the `connect_remote_workspace` command behind Reconnect.
- The cwd fallback in `create_fresh_session` is the link's `home` for a
  routed session, never `crate::home::home_dir()`, which is the desktop's.

## 5. Paths and OS

- Paths are the host's, always with forward slashes. A Windows host's root is
  `C:/Users/me/repo`; `Workspace.rootPath` holds exactly that, and the daemon
  there does what it already does with such a path.
- `gavin_root_exists` is a local `is_dir` today. For an ssh workspace it is
  answered by the host daemon (`ScanGavinRoot` returns a tree whose root
  context is absent when there is no `.gavin-root`), so the init-vs-bind fork
  in the set-root flow asks the right disk.
- The ssh command line must be valid for both `sh -c` (Linux sshd) and
  `cmd.exe` (Windows OpenSSH's default shell). A double-quoted daemon path
  followed by the bare word `bridge` is; a path containing a double quote is
  refused rather than escaped differently per host.
- `BatchMode=yes` so ssh fails instead of prompting: keys and the agent are
  the human's `~/.ssh/config` business, and a password prompt inside a hidden
  child would hang forever. `ConnectTimeout=10`, `ServerAliveInterval=15` so a
  dead network becomes a dropped link in under a minute. The rest of ssh's
  behaviour — host keys, aliases, jump hosts, `ControlMaster` — is the
  human's config, unchanged.
- The bridge's stderr is ssh's stderr; the app reads it when the child exits
  early and reports it verbatim, which is how "gavin-daemon: command not
  found" reaches the human as the actual problem.

## 6. The bridge, precisely

`crates/daemon/src/bridge.rs`, entered from `main.rs` when `argv[1] == "bridge"`.

- `--endpoint <path>` and `--no-spawn` exist for the tests; the app passes
  neither.
- The spawned daemon gets stdin from null and stdout/stderr appended to the
  per-profile `daemon.log` in the data directory (the file the app writes on
  Windows), not the bridge's stdio: a child holding ssh's pipes open would keep
  the ssh session alive after the bridge exits, and would interleave its own
  output with the protocol. On unix it is its own session (`setsid`) so the
  end of the ssh session does not reach it; on Windows it is out of the job
  (`CREATE_BREAKAWAY_FROM_JOB`, falling back without it as the app does) and
  on no console.
- Relay: two threads over `Stream::try_clone`. EOF or error on either side
  shuts the stream down both ways and ends the process. Stdout is flushed per
  chunk; the wire is newline-delimited so a chunk boundary is never a message
  boundary the reader has to wait on.
- Tests (`crates/daemon/tests/bridge.rs`, out of process like `shutdown.rs`):
  against a fake listener the bridge prints the banner with the token it read
  and relays a request and its reply both ways; with nothing listening and
  `--no-spawn` it exits non-zero naming the endpoint; without `--no-spawn`
  under a temp data directory it starts a real daemon, relays
  `GetProtocolVersion`, and the daemon it started answers `Shutdown`.

## 7. What this slice leaves to its own cards

Each is a Tauri-host operation on the desktop's disk and has no remote path
yet. On an ssh workspace each is refused with a message naming the
limitation, never allowed to run against the desktop's own filesystem by
mistake:

- **Frontend**: creating an ssh workspace (host, root on the host, optional
  daemon path), the remote badge on the sidebar and tab strip, Reconnect,
  the `remote-link-*` events, and the gating above.
- **Card runs**: `compose_agent_prompt` reads the card from the desktop's
  disk and `setup_agent_integration` writes MCP config into the desktop's
  copy of the repo. For an ssh workspace both must happen on the host, where
  the agent and its `gavin-mcp` run. The daemon there already has the card
  bodies and the root config; the prompt composition moves behind a request,
  or the app composes from the tree it already receives.
- **Git tab and Files tab** over ssh: either daemon requests or `ssh` exec
  per operation. The Git tab's 60 commands are the largest surface in the
  app; it is a card of its own.
- **Verification on real hosts** from macOS to a Linux box and to a Windows
  box, and the install note for the host-side daemon.

## 8. Rejected, in one place

- **Local daemon as multiplexer** (the desktop's daemon owns the ssh links and
  forwards requests). It outlives the window, which is attractive, but it
  moves the routing into `handle_request`, needs session-id namespacing on the
  wire, and would have every request cross two daemons. The app already holds
  a `DaemonCompat` per connection and 05 §9 already places the desktop as the
  remote daemon's client. App-side.
- **Forwarding the host's Unix socket.** Role `local` on the host, gate never
  exercised — the divergence 05 §9 forbids. And impossible on a Windows host.
- **A workspace-level `ssh://host/path` root.** Encoding the host in the path
  puts a URL through forty path-splitting modules that expect a path. A
  separate field, and the path stays a path.
- **Wrapping child stdio in `Stream` itself.** Would touch the named-pipe arm
  of `transport.rs` for a read-timeout and a `try_clone` that pipes do not
  offer; `Stream::pair()` plus two pumps gets every method for free.
