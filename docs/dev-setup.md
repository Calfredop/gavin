# Local Dev Stack

Commands to build, test, and run the project locally.

Current scope: **daemon + minimal client** (Milestones A and B).
- `crates/daemon` — the `gavin-daemon` binary: owns terminal PTY sessions,
  persists them in SQLite, exposes them over a Unix domain socket.
- `crates/protocol` — the wire protocol shared by the daemon and any client.
- `app/` — a Tauri + Svelte + xterm.js desktop app (npm package `gavin-app`).
  Auto-spawns `gavin-daemon` if it isn't already running, creates or
  reattaches to a single terminal session (persisted across app restarts),
  and renders it full-window.

No workspaces, multiple sessions, split panes, or git status yet — see
`docs/superpowers/specs/2026-07-29-terminal-core-design.md` for the roadmap.
Platform: macOS only for now.

## Prerequisites

- Rust (stable), installed via [rustup](https://rustup.rs).
- Node.js + npm (developed against Node v22; any reasonably recent LTS
  should work).

### Installing Rust/Cargo

If you don't have Rust installed:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

**Do not run this with `sudo`.** rustup installs into your home directory
(`~/.cargo`, `~/.rustup`), not system-wide — running as root can leave
files in your home directory owned by `root` instead of you, which then
blocks normal (non-sudo) tools from writing to them later, including your
own shell profile. If a prior sudo'd install already did this, fix
ownership with (adjust the username):

```bash
sudo chown "$(whoami)" ~/.bash_profile ~/.zshenv
```

Accept the default installation options. Once it finishes, load `cargo`
into your current shell (new shells pick this up automatically via your
shell's profile, which the installer updates):

```bash
source "$HOME/.cargo/env"
```

Verify the install:

```bash
cargo --version
```

If `cargo` isn't found in a shell even after installing (e.g. a shell
started before the installer ran, or a non-standard shell config), re-run
`source "$HOME/.cargo/env"` in that shell.

To update an existing install:

```bash
rustup update
```

### Installing Node/npm

Install via your preferred method (e.g. [nvm](https://github.com/nvm-sh/nvm),
[Homebrew](https://brew.sh) `brew install node`, or the
[official installer](https://nodejs.org)). Verify:

```bash
node --version
npm --version
```

## Build

Whole workspace (daemon + protocol + the Tauri app's Rust backend):

```bash
cargo build --workspace
```

Just the daemon:

```bash
cargo build -p gavin-daemon
```

Just the app's Rust backend:

```bash
cargo build -p app
```

Frontend (first run only needs `npm install` once):

```bash
cd app && npm install && npm run build
```

## Run tests

```bash
cargo test --workspace
```

Or scoped to one crate: `cargo test -p gavin-daemon`, `cargo test -p protocol`,
`cargo test -p app`.

Frontend type-checking:

```bash
cd app && npm run check
```

## Run the app (primary dev flow)

```bash
cd app && npm run tauri dev
```

This launches the real desktop app in dev mode (hot-reloading frontend).
On first run (or whenever there's no saved session) it auto-spawns
`gavin-daemon` if one isn't already running — you don't need to start the
daemon separately for normal development.

**Auto-spawn only works in dev mode**, where the daemon binary is a sibling
of the app's own binary in the same `cargo build` output — there's no
production "sidecar" bundling yet. If you see a "couldn't connect to the
daemon" error, run `cargo build -p gavin-daemon` first so the sibling binary
exists.

### The sidecars are built by a script, not a bare `cargo build`

`beforeDevCommand` runs `node src-tauri/dev-sidecars.mjs`, and so do both
`scripts/start-dev-*` launchers. It is a `cargo build -p gavin-daemon -p
gavin-mcp` with one thing added, for one platform.

On Windows a running executable cannot be unlinked, and cargo's uplift step —
the copy from `target/debug/deps/` to `target/debug/gavin-mcp.exe` — unlinks
before it links. Every agent session open in a checkout runs a `gavin-mcp` out
of that path, so the dev loop of a tool built to run several sessions at once
used to stop on

```
error: failed to remove file `...\target\debug\gavin-mcp.exe`
Caused by:
  Access is denied. (os error 5)
```

before vite was ever reached. Windows *does* allow a running image to be
renamed, and the renamed file stays mapped in the process holding it, so the
script moves each held sidecar to `<name>.locked-<n>`, lets cargo link a fresh
binary into the name it vacated, and sweeps the parked copies on a later run
once their holders have exited. It never stops a process it finds — those are
live agent sessions, and losing an MCP server mid-task is worse than a failed
build. If a rename cannot save the build it prints the pids running that image
and leaves the decision to you.

Leftover `gavin-*.exe.locked-*` files in `target/debug/` are expected while
sessions are open, and cost only disk.

App state lives under `~/Library/Application Support/com.gavin.app/`:
- `config.json` — the currently remembered `session_id`, so relaunching the
  app reattaches to the same terminal session instead of starting fresh.

To force a clean first-launch experience (no saved session), delete that
directory. To also reset the daemon's own state, see below.

## Run the daemon standalone

Useful for testing/debugging the daemon without the GUI:

```bash
cargo run -p gavin-daemon
```

On startup it prints the socket it's listening on, e.g.:

```
gavin-daemon listening on /Users/<you>/Library/Application Support/gavin/daemon.sock
```

Daemon state lives under `~/Library/Application Support/gavin/`:
- `daemon.sock` — Unix domain socket (session control + I/O protocol)
- `registry.sqlite` — persisted session registry

Stop the daemon with `Ctrl-C`. Since it's designed to survive the app
closing, it also keeps running after `npm run tauri dev`'s window is
closed — check with `pgrep -fl gavin-daemon` and stop it manually
(`pkill gavin-daemon`) if you want a fully clean slate.

## Manually probe the running daemon

In a second terminal, send a hand-written request over the socket with `nc`:

```bash
echo '{"type":"ListSessions"}' | nc -U ~/"Library/Application Support/gavin/daemon.sock"
```

Expected response:

```json
{"type":"SessionList","sessions":[]}
```

See `crates/protocol/src/lib.rs` for the full `Request`/`Response` shapes
(shared by the daemon and the app).
