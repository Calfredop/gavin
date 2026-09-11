# Per-build daemon isolation

Card: `.gavin-root/plans/issue-stable-and-dev-apps-share-one-state-dir.md` —
"[issue] the stable and dev apps share one daemon and one config.json".

Every Gavin on this machine resolves the same state. `resolve_app_support_dir`
takes no override of any kind, so the socket path — and on Windows the pipe name
hashed from it — the daemon token, the daemon log and the three SQLite files are
one set, shared by a release install and the dev tree alike. `config.json` comes
from Tauri's `app_config_dir`, keyed on the identifier `com.gavin.app`, and is
shared for the same reason.

## What the card asked, and what the answer turned out to be

The card framed the decision as "whether a build can be pointed at its own
state", and named an environment override as the obvious route, with a catch: a
PTY inherits it, so every `gavin-mcp` in those tabs and any app launched from
them lands back on the wrong daemon.

That framing assumes the goal is two independent Gavins. It is not. The
requirement, stated by the owner while this was being designed, is the opposite:

> The very important thing is that I don't lose any work on both build types.
> At the moment I am working on release build and any work done here should be
> found/synced to debug and vice versa, without killing the daemon of the other.
> The baseline is that only one build at a time will be running.

So the rule this design is built on:

**Nothing is duplicated, therefore nothing needs syncing. Only the things that
name a RUNNING DAEMON split.**

The state directory stays one directory. Both builds read and write one board,
one set of rails, one workspace list and one settings file, because those are
the same files — not copies kept in step. What separates is the endpoint, the
credential for that endpoint, the log, and the one store that records live
process identity.

## Two of the card's three bullets have already moved

- **Restart daemon killing by name is fixed.** `stop_running_daemon`
  (`app/src-tauri/src/daemon.rs`) now kills the pid the kernel names as owner of
  *this* endpoint (`Stream::server_pid`) and returns `Ok` having done nothing
  when there is no owner. The `taskkill /F /IM` sweep is gone, closing
  `fix-app-tests-kill-the-running-daemon.md` and the card's first bullet with it.
- **The inheritance catch has a settled precedent.**
  `issue-launcher-env-leaks-into-sessions.md` closed with a named scrub list in
  `PtySession::spawn` and, more usefully, with the rule it drew: *a variable goes
  only if it names the LAUNCHER's session rather than this one.* That comment
  already states the two deliberate exceptions — `GAVIN_SESSION_ID` and
  `GAVIN_SESSION_TOKEN` — and this design adds a third under the same test.

The second bullet (a dev daemon newer than the stable app locks it out) is what
this design removes. The third (config drift) is deliberately left standing; see
"What this does not fix".

## The rule

A `BuildProfile` beside the existing `HostOs` in `crates/protocol/src/lib.rs`:

```rust
pub enum BuildProfile { Dev, Release }

impl BuildProfile {
    pub const fn current() -> BuildProfile {
        if cfg!(debug_assertions) { BuildProfile::Dev } else { BuildProfile::Release }
    }
}
```

`cfg!(debug_assertions)` rather than an environment variable, and that is the
whole reason the card's catch evaporates. The dev tree is built debug by
`tauri dev`; the stable install and the stable worktree's `target/release` are
release. The app, the daemon and `gavin-mcp` are resolved as siblings of each
other (`resolve_daemon_binary_path`, `resolve_mcp_binary_path`), so a build's
three binaries agree on their profile by construction, with nothing in the
environment to inherit, strip, or forget to strip.

`Release` must produce today's names byte-for-byte. There is no migration in
this design and the installed app must not notice it landed.

### What splits

| Path | Release | Dev |
|---|---|---|
| socket / pipe | `daemon.sock` | `daemon-dev.sock` |
| daemon token | `daemon.token` | `daemon-dev.token` |
| daemon log | `daemon.log` | `daemon-dev.log` |
| session registry | `registry.sqlite` | `registry-dev.sqlite` |

**The socket.** `pipe_name_for_path` hashes the whole path and keeps its last
segment as a readable tag, so the two builds land on
`\\.\pipe\gavin-daemon-<hash>` and `\\.\pipe\gavin-daemon-dev-<hash>`. Neither
daemon can be adopted by the other's app, neither Restart can reach the other,
and the stable app never sees a newer dev daemon to fail closed against — which
is the card's second bullet, gone by construction rather than by a rule the
human has to remember.

**The token.** `server.rs` writes it `0600` at startup and `session.rs` reads it
to send `Hello`. One file would hold whichever daemon started last, and the
other app's `Hello` would be refused — a credential for one endpoint presented
at another.

**The log.** Two daemons appending to one file interleave into something nobody
can read, and the daemon log is the record the Windows-port work has leaned on
repeatedly.

**The registry, and this one is not tidiness.** `registry.sqlite` is the only
store holding *process identity*: `pid` and `orphan_pid`. `ServerState::recover`
(`crates/daemon/src/server.rs`) runs at every daemon startup over every row
below the current generation, probes the recorded pid with `still_running`,
records a live one as an orphan "for the app to surface and the human to end",
and respawns a bare shell in the row's cwd. Shared, a dev daemon starting while
the stable daemon holds live PTYs would: bump the generation out from under
those rows, mark them interrupted, list the stable app's running agents in the
dev app as orphans offering to end them, and open a phantom shell for each. That
is the damage `never pkill gavin-daemon` exists to prevent, arriving through a
different door.

Splitting it costs nothing durable. A PTY cannot outlive its daemon, so live
sessions were never portable between builds; the registry also holds only
sessions, their queued input and a generation counter, none of which is work.

### What stays shared

- `kanban.sqlite` — column and label vocabularies, `card_sessions`, `card_runs`.
- `orchestration.sqlite` — rails, stages, steps, conflict notes, tools, group
  templates, and run state.
- `config.json` at `%APPDATA%\com.gavin.app` — workspaces, theme, agent defaults
  and models, the launch gate, the superpowers trust marker, font size.
- `require_local_token` — a user-facing toggle both daemons should honour.
- The cards themselves, which are files in the repo and were never in this.

`app_support_dir()` and the app's `app_config_dir()` call sites are therefore
**unchanged**. The `session_id` columns in the shared stores are ids, not pids:
one written by the other build's daemon simply fails to resolve and the surface
reports nothing running, which is true.

The result the owner asked for: switch builds and you find the same board, the
same rails, the same workspaces and the same settings, because they are the same
files. Quit the stable app and run the dev app and the stable daemon keeps
running on its own pipe with its PTYs intact — come back and the stable app
reconnects to the sessions that were there. Today the dev app adopts that daemon
instead.

## The one thing isolation forces: the session's endpoint

`resolve_mcp_binary_path` resolves `gavin-mcp` beside the running app and writes
that absolute path into the **workspace's** MCP config. One workspace, one entry:
whichever app last ran Integrate names the binary both builds' tabs will launch.
Today that is invisible, because every `gavin-mcp` resolves the same endpoint.
Split the endpoint and it bites — a debug `gavin-mcp` in a stable tab would
resolve `daemon-dev.sock` and talk to the wrong daemon, or to none.

So `PtySession::spawn` sets `GAVIN_SESSION_SOCKET` to *this* daemon's
`socket_path()`, beside the `GAVIN_SESSION_ID` and `GAVIN_SESSION_TOKEN` it
already injects, and in neither scrub list. That is not an exception to the
launcher-env rule, it is an application of it: the test is whether a variable
names the launcher's session or this one, and this names the daemon serving this
very PTY.

`gavin-mcp`'s `SocketTransport` prefers it and falls back to
`protocol::socket_path()` when it is absent or empty — an agent run outside a
gavin tab, and every existing test. Two consequences worth stating:

- It fixes a hazard that predates this design. A tab already gets whichever
  `gavin-mcp` the workspace config names; now it reaches the daemon that owns
  the tab regardless.
- It is read only by `gavin-mcp`, never by `resolve_app_support_dir`. An app
  launched from a tab still picks its own state by its own profile, so the card's
  inheritance catch has nothing to catch.

## Files

- `crates/protocol/src/lib.rs` — `BuildProfile`, and `socket_path` /
  `daemon_token_path` naming through it. `resolve_app_support_dir` untouched.
- `crates/daemon/src/main.rs` — `db_path` gains the suffix; `kanban_db_path` and
  `orchestration_db_path` do not.
- `crates/daemon/src/pty.rs` — `GAVIN_SESSION_SOCKET`, and the scrub comment
  extended to name the third deliberate exception.
- `crates/gavin-mcp/src/main.rs` — `SocketTransport::new` prefers the injected
  endpoint.
- `app/src-tauri/src/daemon.rs` — `daemon_log_file` gains the suffix.
- `scripts/start-dev-win.ps1`, `scripts/start-stable-win.ps1` — each names the
  endpoint it drives.
- `CLAUDE.md` — the shared-daemon paragraph, amended to say what is now separate
  and what still is not.

## Testing

Pure functions with the profile passed in, following the shape
`resolve_app_support_dir` already uses for `HostOs` — the suite runs
multi-threaded and the daemon tests spawn real processes, so nothing here may
depend on the profile of the test binary.

- The four per-build names differ between `Dev` and `Release`, and the `Release`
  spelling of each equals the literal it has today. The second half is the one
  that matters: it is the assertion that an installed app needs no migration.
- The two shared store paths are identical under both profiles, pinning the
  decision rather than leaving it to a reader of `main.rs`.
- `pipe_name_for_path` gives different names for the two socket paths — the
  property the whole design rests on, and testable on every platform, as that
  function is already compiled everywhere for exactly this reason.
- `PtySession::spawn` exports `GAVIN_SESSION_SOCKET` with this daemon's
  endpoint, and it SURVIVES both scrub loops. The existing `IDMARK` tests in
  `pty.rs` are the model; per that card's note, each new test is checked to fail
  with the behaviour disabled rather than assumed to be meaningful.
- `gavin-mcp` prefers the injected endpoint when set and falls back to
  `socket_path()` when absent or empty.

## What this does not fix, and why

- **Config drift — the card's third bullet — survives by design.** One
  `config.json` is what "settings sync both ways" means, and it is the same file
  a dev build may widen and a stable build then read and rewrite, dropping keys
  it does not know. The owner's requirement chose this trade knowingly. The same
  holds for the shared SQLite files: a migration the dev daemon applies is
  additive, and every read is by column name, so extra columns and tables are
  inert — a changed *meaning* for an existing column would not be, and that is
  the real constraint on future schema work against these two files.
- **`cargo test -p app` in the dev tree now addresses the dev endpoint.** A
  running dev daemon is in its blast radius; the stable one no longer is, which
  is the blast radius that was wanted.
- **The two apps still share every workspace's `.gavin*` files and MCP config.**
  Unchanged, and intended — the cards are the work.
- **The stable app still fails closed against a daemon newer than itself.** It
  can now only meet its own, which the dev tree can no longer be.
