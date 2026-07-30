# Local Dev Stack

Commands to build, test, and run the project locally.

Current scope: **daemon only** (`crates/daemon`, binary `gavin-daemon`). No
GUI/frontend exists yet — see
`docs/superpowers/specs/2026-07-29-terminal-core-design.md` for the roadmap.
Platform: macOS only for now.

## Prerequisites

- Rust (stable), installed via [rustup](https://rustup.rs).

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

## Build

```bash
cargo build -p gavin-daemon
```

## Run tests

```bash
cargo test -p gavin-daemon
```

## Start the daemon

```bash
cargo run -p gavin-daemon
```

On startup it prints the socket it's listening on, e.g.:

```
gavin-daemon listening on /Users/<you>/Library/Application Support/gavin/daemon.sock
```

State lives under `~/Library/Application Support/gavin/`:
- `daemon.sock` — Unix domain socket (session control + I/O protocol)
- `registry.sqlite` — persisted session registry

Stop the daemon with `Ctrl-C`.

## Manually probe the running daemon

In a second terminal, send a hand-written request over the socket with `nc`:

```bash
echo '{"type":"ListSessions"}' | nc -U ~/"Library/Application Support/gavin/daemon.sock"
```

Expected response:

```json
{"type":"SessionList","sessions":[]}
```

See `crates/daemon/src/protocol.rs` for the full `Request`/`Response` shapes.
