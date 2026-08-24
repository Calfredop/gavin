# OTA Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship signed over-the-air updates that the user applies when *they* choose, from an unobtrusive button in the sidebar, without ever silently killing running agents.

**Architecture:** Tauri's updater replaces the whole `.app` bundle, so all three binaries move together and the absolute `gavin-mcp` paths already written into users' `.mcp.json` files stay valid. The app and daemon are then restarted together, so they never disagree. The one process the app cannot choreograph is a `gavin-mcp` owned by a running Claude session; that one detects the gap and `exec()`s its own replaced binary.

**Tech Stack:** Tauri v2 + `tauri-plugin-updater`, Rust, Svelte 5 + TypeScript, `cargo test`, `vitest`.

**Spec:** `docs/superpowers/specs/2026-08-24-daemon-version-compat-ota-design.md`

## Global Constraints

- **Depends on `docs/superpowers/plans/2026-08-24-daemon-compat-window.md` being complete.** Task 3 here needs `Request::Shutdown` (v12) from that plan's Task 2.
- Updates are never automatic and never modal. The user clicks, or nothing happens.
- Any flow that ends a daemon must first show the count of running agents it would end.
- The socket path stays single and stable (`protocol::socket_path()`). Per-install socket paths would break the daemon discovery this design depends on.
- macOS is the only target in scope. `pkill`, `exec`, and bundle layout are all platform-specific here.

---

### Task 1: Ship the sidecar binaries inside the bundle

**Files:**
- Modify: `app/src-tauri/tauri.conf.json` (`bundle` section)
- Test: manual verification, recorded in this task

**Interfaces:**
- Consumes: nothing.
- Produces: a release bundle where `gavin-daemon` and `gavin-mcp` sit beside the app binary, keeping `resolve_daemon_binary_path` (`app/src-tauri/src/daemon.rs:11`) and `resolve_mcp_binary_path` (`app/src-tauri/src/agent_setup.rs:205`) working unchanged.

Both helpers join against `current_exe().parent()`. If the bundled names carry a target-triple suffix, both break — and `agent_setup.rs` would then write a dead path into users' repos, which is the worst failure in this plan because it persists outside the app.

- [ ] **Step 1: Verify the suffix behaviour before building on it**

```bash
mkdir -p app/src-tauri/binaries
cp target/release/gavin-daemon "app/src-tauri/binaries/gavin-daemon-$(rustc -Vv | grep host | cut -d' ' -f2)"
cp target/release/gavin-mcp "app/src-tauri/binaries/gavin-mcp-$(rustc -Vv | grep host | cut -d' ' -f2)"
```

Add to `tauri.conf.json` under `bundle`:

```json
    "externalBin": ["binaries/gavin-daemon", "binaries/gavin-mcp"]
```

- [ ] **Step 2: Build and inspect the bundle**

Run: `cd app && npm run tauri build`
Then: `ls -1 src-tauri/target/release/bundle/macos/Gavin.app/Contents/MacOS/`

Expected: exactly `Gavin`, `gavin-daemon`, `gavin-mcp` — **no triple suffixes**.

> If suffixes are present, stop and fix it here rather than downstream: change both resolver helpers to try the plain name and then `format!("{name}-{}", env!("TARGET"))`, adding a build script to expose `TARGET`. Do not paper over it at the call sites.

- [ ] **Step 3: Verify the resolvers against the real bundle**

Run the built app and confirm the daemon spawns and an agent setup writes a live path:

```bash
open src-tauri/target/release/bundle/macos/Gavin.app
pgrep -lf gavin-daemon
```

Expected: a `gavin-daemon` process whose path is inside `Gavin.app/Contents/MacOS/`.

- [ ] **Step 4: Commit**

```bash
git add app/src-tauri/tauri.conf.json .gitignore
git commit -m "build(app): bundle gavin-daemon and gavin-mcp as sidecars"
```

---

### Task 2: A daemon this install can identify

**Files:**
- Modify: `crates/daemon/src/server.rs` (`run_server`, near the socket bind at line 1511)
- Modify: `app/src-tauri/src/daemon.rs:50-65` (`kill_running_daemons`)
- Test: `crates/daemon/src/server.rs` (`mod tests`), `app/src-tauri/src/daemon.rs` (`mod tests`)

**Interfaces:**
- Consumes: `Request::Shutdown` from the compat-window plan's Task 2.
- Produces: `protocol::pidfile_path() -> PathBuf`; `stop_daemon(socket: &Path) -> anyhow::Result<()>` replacing `kill_running_daemons`.

`pkill -x gavin-daemon` kills *every* gavin-daemon on the machine — other installs, other versions, another user's. Acceptable in dev, not in a shipped app.

- [ ] **Step 1: Write the failing tests**

In `crates/protocol/src/lib.rs` tests:

```rust
#[test]
fn the_pidfile_sits_beside_the_socket() {
    assert_eq!(pidfile_path().parent(), socket_path().parent());
    assert_eq!(pidfile_path().file_name().unwrap(), "daemon.pid");
}
```

In `app/src-tauri/src/daemon.rs` tests:

```rust
#[test]
fn stop_daemon_asks_politely_and_returns_when_the_socket_goes_away() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("stop.sock");
    let listener = std::os::unix::net::UnixListener::bind(&sock).unwrap();

    let server = std::thread::spawn(move || {
        let (mut conn, _) = listener.accept().unwrap();
        let mut reader = std::io::BufReader::new(conn.try_clone().unwrap());
        let req: Option<protocol::Request> = protocol::read_message(&mut reader).unwrap();
        assert!(matches!(req, Some(protocol::Request::Shutdown)));
        protocol::write_message(&mut conn, &protocol::Response::Ok).unwrap();
    });

    assert!(stop_daemon(&sock).is_ok());
    server.join().unwrap();
}

#[test]
fn stop_daemon_succeeds_when_nothing_is_listening() {
    let dir = tempfile::tempdir().unwrap();
    // Already gone is a normal case, not an error -- same contract the
    // old pkill path had for exit code 1.
    assert!(stop_daemon(&dir.path().join("absent.sock")).is_ok());
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p protocol the_pidfile && cargo test -p app stop_daemon`
Expected: FAIL — `pidfile_path` and `stop_daemon` do not exist.

- [ ] **Step 3: Implement**

In `crates/protocol/src/lib.rs`, beside `socket_path()`:

```rust
pub fn pidfile_path() -> PathBuf {
    app_support_dir().join("daemon.pid")
}
```

In `run_server`, after the successful `bind` and permissions call, write the pid; remove it on clean exit:

```rust
    std::fs::write(protocol::pidfile_path(), std::process::id().to_string())?;
```

Replace `kill_running_daemons` in `app/src-tauri/src/daemon.rs`:

```rust
/// Stops the daemon this install is talking to.
///
/// Polite first: Shutdown over the socket, which only the daemon bound
/// to THIS socket path receives. Falls back to the pidfile, and only
/// then to pkill -- which is retained solely for a daemon too old to
/// parse Shutdown (pre-v12), the case the original pkill existed for.
pub fn stop_daemon(socket_path: &Path) -> anyhow::Result<()> {
    if let Ok(mut stream) = UnixStream::connect(socket_path) {
        if protocol::write_message(&mut stream, &protocol::Request::Shutdown).is_ok() {
            let mut reader = std::io::BufReader::new(&mut stream);
            let _: anyhow::Result<Option<protocol::Response>> = protocol::read_message(&mut reader);
            if wait_for_socket_to_close(socket_path, Duration::from_secs(5)) {
                return Ok(());
            }
        }
        if let Ok(pid) = std::fs::read_to_string(protocol::pidfile_path()) {
            if let Ok(pid) = pid.trim().parse::<i32>() {
                let _ = Command::new("kill").arg("-TERM").arg(pid.to_string()).status();
                if wait_for_socket_to_close(socket_path, Duration::from_secs(5)) {
                    return Ok(());
                }
            }
        }
        // Last resort: a pre-v12 daemon that can parse neither Shutdown
        // nor anything else we could send it.
        let status = Command::new("pkill").arg("-x").arg("gavin-daemon").status()?;
        match status.code() {
            Some(0) | Some(1) => return Ok(()),
            other => anyhow::bail!("pkill exited with {other:?}"),
        }
    }
    Ok(())
}

fn wait_for_socket_to_close(socket_path: &Path, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if UnixStream::connect(socket_path).is_err() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}
```

Update `session.rs:449` (`restart_daemon`) to call `stop_daemon(&protocol::socket_path())`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p protocol && cargo test -p gavin-daemon && cargo test -p app`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/protocol/src/lib.rs crates/daemon/src/server.rs \
        app/src-tauri/src/daemon.rs app/src-tauri/src/session.rs
git commit -m "feat(daemon): targeted shutdown via socket and pidfile, not pkill"
```

---

### Task 3: gavin-mcp re-execs itself when the daemon moves ahead

**Files:**
- Modify: `crates/gavin-mcp/src/main.rs:17-72` (`SocketTransport`), `:593-613` (`main`)
- Test: `crates/gavin-mcp/src/main.rs` (`mod tests`)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `DaemonTransport::reexec_requested(&self) -> bool` (defaulting to `false`), and `fn replay_blob(in_flight: &str, buffered: &[u8]) -> Vec<u8>`.

This works because `handle_line` (`main.rs:555`) is stateless — `initialize` echoes the requested version and returns static capabilities, so a fresh process needs no re-handshake. The only per-process state is `root` (re-derived from cwd, which `exec` inherits) and a lazy socket.

**The trap:** `stdin.lock().lines()` wraps a `BufReader` that may already hold pipelined bytes. Those live in userspace and `exec` throws them away — unread bytes still in the pipe survive, anything already buffered does not. Silently dropping a request here would be a miserable intermittent bug, so the buffer must be carried across.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn the_replay_blob_carries_the_in_flight_line_then_the_buffered_bytes() {
    let blob = replay_blob(r#"{"id":1}"#, b"{\"id\":2}\n{\"id\":3");
    // In-flight line first, then whatever the BufReader had already
    // swallowed -- including a trailing PARTIAL line, which the chained
    // reader completes from the real stdin.
    assert_eq!(blob, b"{\"id\":1}\n{\"id\":2}\n{\"id\":3".to_vec());
}

#[test]
fn a_replay_blob_survives_an_env_var_round_trip() {
    let original = b"{\"id\":1}\n{\"partial\":".to_vec();
    let encoded = encode_replay(&original);
    assert_eq!(decode_replay(&encoded).unwrap(), original);
}

#[test]
fn the_generation_guard_stops_a_second_reexec() {
    assert!(may_reexec(0));
    assert!(!may_reexec(1), "one re-exec is the whole budget");
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p gavin-mcp replay`
Expected: FAIL — `replay_blob`, `encode_replay`, `decode_replay`, `may_reexec` do not exist.

- [ ] **Step 3: Implement the helpers**

```rust
const REPLAY_VAR: &str = "GAVIN_MCP_REPLAY";
const GENERATION_VAR: &str = "GAVIN_MCP_GENERATION";

/// The bytes the successor must process before touching stdin: the
/// request we were mid-way through, then anything the BufReader had
/// already pulled out of the pipe. A trailing partial line is fine --
/// the successor chains this in FRONT of stdin, so the rest arrives
/// normally.
fn replay_blob(in_flight: &str, buffered: &[u8]) -> Vec<u8> {
    let mut blob = in_flight.as_bytes().to_vec();
    blob.push(b'\n');
    blob.extend_from_slice(buffered);
    blob
}

/// A JSON byte array, so arbitrary bytes survive an env var exactly --
/// no UTF-8 assumption, no extra dependency.
fn encode_replay(blob: &[u8]) -> String {
    serde_json::to_string(blob).expect("Vec<u8> always serializes")
}

fn decode_replay(encoded: &str) -> Option<Vec<u8>> {
    serde_json::from_str(encoded).ok()
}

/// One re-exec per process tree. A binary that is somehow still stale
/// after replacing itself must fail loudly, not spin.
fn may_reexec(generation: u32) -> bool {
    generation == 0
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p gavin-mcp replay`
Expected: PASS.

- [ ] **Step 5: Wire the re-exec into the transport and main loop**

Add the flag to the trait so `MockTransport` is untouched:

```rust
pub trait DaemonTransport {
    fn request(&mut self, req: &Request) -> anyhow::Result<Response>;
    /// True once the transport has seen a daemon newer than this binary.
    /// Checked by main BEFORE a reply is written, because the successor
    /// re-handles the in-flight request and would otherwise duplicate it.
    fn reexec_requested(&self) -> bool { false }
}
```

In `SocketTransport`, add `reexec: bool`, and in `connect()` replace the `version > PROTOCOL_VERSION` arm:

```rust
            Ok(Some(Response::ProtocolVersion { version })) if version > PROTOCOL_VERSION => {
                // The update replaced the binary at our own path, so the
                // newer gavin-mcp is already there. Do not answer this
                // request -- main will exec and let the successor do it.
                self.reexec = true;
                anyhow::bail!("daemon is v{version}; re-executing into the updated gavin-mcp")
            }
```

Implement `fn reexec_requested(&self) -> bool { self.reexec }`.

Rewrite `main` (`main.rs:593`):

```rust
fn main() {
    let root = std::env::current_dir().ok().and_then(|cwd| find_gavin_root(&cwd));
    let generation: u32 =
        std::env::var(GENERATION_VAR).ok().and_then(|g| g.parse().ok()).unwrap_or(0);

    // Anything handed over by a predecessor is read BEFORE stdin, and
    // chaining (rather than draining) means a partial trailing line is
    // completed from the pipe instead of corrupting the next request.
    let replay = std::env::var(REPLAY_VAR).ok().and_then(|e| decode_replay(&e)).unwrap_or_default();
    let mut reader = BufReader::new(std::io::Cursor::new(replay).chain(std::io::stdin()));

    let mut transport = SocketTransport::new();
    let stdout = std::io::stdout();
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let trimmed = line.trim_end().to_string();
        if trimmed.is_empty() {
            continue;
        }
        let reply = handle_line(&trimmed, root.as_deref(), &mut transport);

        if transport.reexec_requested() && may_reexec(generation) {
            let blob = replay_blob(&trimmed, reader.buffer());
            let exe = std::env::current_exe().expect("current_exe");
            let err = std::process::Command::new(exe)
                .env(REPLAY_VAR, encode_replay(&blob))
                .env(GENERATION_VAR, (generation + 1).to_string())
                .exec(); // never returns on success
            eprintln!("gavin-mcp: re-exec failed: {err}");
            // Fall through and answer with the error we already have.
        }

        if let Some(reply) = reply {
            let mut out = stdout.lock();
            let _ = writeln!(out, "{reply}");
            let _ = out.flush();
        }
    }
}
```

Add `use std::os::unix::process::CommandExt;`.

- [ ] **Step 6: Run the full crate tests**

Run: `cargo test -p gavin-mcp`
Expected: PASS — including the existing `initialize_echoes_version_and_lists_tools` and dispatch tests, which must be unaffected.

- [ ] **Step 7: Commit**

```bash
git add crates/gavin-mcp/src/main.rs
git commit -m "feat(mcp): re-exec into the updated binary when the daemon moves ahead"
```

---

### Task 4: Wire up the updater plugin

**Files:**
- Modify: `app/src-tauri/Cargo.toml`, `app/package.json`, `app/src-tauri/tauri.conf.json`, `app/src-tauri/capabilities/default.json`
- Create: `app/src/lib/updateState.ts`
- Test: `app/src/lib/updateState.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export const updateAvailable: Writable<UpdateInfo | null>`, `export async function checkForUpdate(): Promise<void>`, `export function shouldShowUpdateButton(u: UpdateInfo | null): boolean`.

- [ ] **Step 1: Add the dependencies**

```bash
cd app && npm install @tauri-apps/plugin-updater
cargo add tauri-plugin-updater --manifest-path src-tauri/Cargo.toml
```

Generate a signing keypair and keep the private key out of the repo:

```bash
cd app && npx tauri signer generate -w ~/.gavin-updater.key
```

- [ ] **Step 2: Write the failing test**

Create `app/src/lib/updateState.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { shouldShowUpdateButton } from "./updateState";

describe("shouldShowUpdateButton", () => {
  it("stays hidden when there is no update", () => {
    expect(shouldShowUpdateButton(null)).toBe(false);
  });

  it("appears when an update is available", () => {
    expect(shouldShowUpdateButton({ version: "0.2.0", notes: "" })).toBe(true);
  });

  it("stays hidden for a version the user already dismissed", () => {
    expect(shouldShowUpdateButton({ version: "0.2.0", notes: "", dismissed: true })).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd app && npm test -- updateState`
Expected: FAIL — cannot resolve `./updateState`.

- [ ] **Step 4: Implement**

Create `app/src/lib/updateState.ts`:

```ts
import { writable } from "svelte/store";
import { check } from "@tauri-apps/plugin-updater";

export type UpdateInfo = { version: string; notes: string; dismissed?: boolean };

export const updateAvailable = writable<UpdateInfo | null>(null);

/// The sidebar button is absent, not greyed, when there is nothing to
/// do -- a permanent badge would train the user to ignore it.
export function shouldShowUpdateButton(u: UpdateInfo | null): boolean {
  return u !== null && !u.dismissed;
}

export async function checkForUpdate(): Promise<void> {
  try {
    const update = await check();
    updateAvailable.set(update ? { version: update.version, notes: update.body ?? "" } : null);
  } catch {
    // A failed check is not worth interrupting anyone over; the next
    // one will pick it up.
    updateAvailable.set(null);
  }
}
```

Add to `tauri.conf.json`:

```json
  "plugins": {
    "updater": {
      "pubkey": "<the public key printed by tauri signer generate in Step 1>",
      "endpoints": ["https://<update host>/gavin/{{target}}/{{arch}}/{{current_version}}"]
    }
  }
```

> These two values are **external inputs, not TODOs to invent.** The
> pubkey comes from Step 1's keypair; the endpoint host is open item 3
> in the spec and needs a decision from the maintainer. Everything else
> in this plan can be built and tested without them — an updater with a
> placeholder endpoint simply reports no update available. Do not
> fabricate a host, and do not commit the private key.

Add `"updater:default"` to the permissions array in `app/src-tauri/capabilities/default.json`, and register the plugin in `lib.rs`'s builder chain beside the existing `tauri_plugin_*` registrations.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd app && npm test -- updateState`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/package.json app/package-lock.json app/src-tauri/Cargo.toml Cargo.lock \
        app/src-tauri/tauri.conf.json app/src-tauri/capabilities/default.json \
        app/src-tauri/src/lib.rs app/src/lib/updateState.ts app/src/lib/updateState.test.ts
git commit -m "feat(app): wire up the Tauri updater plugin"
```

---

### Task 5: The update button and its panel

**Files:**
- Create: `app/src/lib/UpdatePanel.svelte`
- Modify: `app/src/lib/Sidebar.svelte:873-877` (the footer Settings row)
- Test: `app/src/lib/updateState.test.ts` (extend)

**Interfaces:**
- Consumes: `updateAvailable`, `shouldShowUpdateButton` (Task 4).
- Produces: `export function updateConfirmText(version: string, runningAgents: number): string`.

The Settings row at `Sidebar.svelte:874` is currently `disabled title="Coming soon"`. This button is its first live control, and follows the `IconButton` pattern already used by the `theme-row` immediately below it.

- [ ] **Step 1: Write the failing tests**

```ts
import { updateConfirmText } from "./updateState";

describe("updateConfirmText", () => {
  it("names the version", () => {
    expect(updateConfirmText("0.2.0", 0)).toContain("0.2.0");
  });

  it("warns what a restart will end", () => {
    expect(updateConfirmText("0.2.0", 2)).toContain("2 running agents");
  });

  it("does not pluralise a single agent", () => {
    const t = updateConfirmText("0.2.0", 1);
    expect(t).toContain("1 running agent");
    expect(t).not.toContain("1 running agents");
  });

  it("says nothing about agents when none are running", () => {
    expect(updateConfirmText("0.2.0", 0)).not.toContain("running agent");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && npm test -- updateState`
Expected: FAIL — `updateConfirmText` is not exported.

- [ ] **Step 3: Implement**

Add to `updateState.ts`:

```ts
export function updateConfirmText(version: string, runningAgents: number): string {
  const base = `Update to ${version}. Gavin will restart.`;
  if (runningAgents === 0) return base;
  const noun = runningAgents === 1 ? "1 running agent" : `${runningAgents} running agents`;
  return `${base} This will end ${noun}.`;
}
```

Create `UpdatePanel.svelte` showing version, notes, `updateConfirmText(...)`, a confirm button, and a "Later" button that sets `dismissed: true`.

In `Sidebar.svelte`, inside the footer Settings row:

```svelte
    <button class="footer-row" disabled title="Coming soon">
      <Settings size={12} />
      <span>Settings</span>
      {#if shouldShowUpdateButton($updateAvailable)}
        <IconButton
          icon={ArrowUpCircle}
          label="Update available"
          size={12}
          onclick={() => (showUpdatePanel = true)}
        />
      {/if}
    </button>
```

> The row itself is `disabled`. Nest the `IconButton` outside the disabled `<button>` — a nested control inside a disabled button will not receive clicks. Restructure the row into a flex container holding the disabled label and the live icon as siblings.

Call `checkForUpdate()` from the app's startup path in `layoutState.ts`, alongside the other best-effort fetches around lines 330-355.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && npm test -- updateState && npm run check`
Expected: PASS, no new type errors.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/updateState.ts app/src/lib/updateState.test.ts \
        app/src/lib/UpdatePanel.svelte app/src/lib/Sidebar.svelte app/src/lib/layoutState.ts
git commit -m "feat(app): an update button in the sidebar settings row"
```

---

### Task 6: The install choreography

**Files:**
- Modify: `app/src/lib/UpdatePanel.svelte`
- Modify: `app/src-tauri/src/session.rs` (add a `stop_daemon_for_update` command)
- Modify: `app/src-tauri/src/lib.rs` (register it)

**Interfaces:**
- Consumes: `stop_daemon` (Task 2), the updater plugin (Task 4).
- Produces: an update that leaves app and daemon on the same version.

Order matters. The daemon must stop **after** the download and **before** the relaunch: stop it earlier and the user loses their agents while a download fails; stop it later and the new app boots against the old daemon, taking the degraded path for no reason.

- [ ] **Step 1: Add the Tauri command**

```rust
/// Stops the daemon as part of applying an update. Distinct from
/// restart_daemon: nothing is spawned to replace it, because the app is
/// about to relaunch and will spawn the NEW one via connect_or_spawn.
#[tauri::command]
pub fn stop_daemon_for_update() -> Result<(), String> {
    crate::daemon::stop_daemon(&protocol::socket_path()).map_err(|e| e.to_string())
}
```

Register it in the `invoke_handler!` list.

- [ ] **Step 2: Implement the flow in UpdatePanel.svelte**

```ts
async function applyUpdate(update: Update): Promise<void> {
  status = "downloading";
  await update.download();          // fail here and nothing has been lost
  status = "restarting";
  await invoke("stop_daemon_for_update");
  await update.install();
  await relaunch();
}
```

- [ ] **Step 3: Verify the ordering by hand**

Run the built app against a staging endpoint offering a higher version.

Expected, in order: download completes → daemon exits (`pgrep -lf gavin-daemon` empty) → app relaunches → new daemon spawns from the new bundle → **no** compat banner, because both are on the same version.

- [ ] **Step 4: Verify the failure path**

Kill the network mid-download.

Expected: an error in the panel, the daemon **still running**, agents intact, no restart.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/UpdatePanel.svelte app/src-tauri/src/session.rs app/src-tauri/src/lib.rs
git commit -m "feat(app): download, stop the daemon, install, relaunch"
```

---

### Task 7: Prove the stale-mcp path end to end

**Files:**
- Test: manual, recorded here

- [ ] **Step 1: Set up the mismatch**

```bash
# 1. Start a Claude session with gavin MCP configured, and call a gavin_* tool.
# 2. With that session still open, update the daemon underneath it:
pkill -x gavin-daemon
./target/release/gavin-daemon &   # a build with a HIGHER PROTOCOL_VERSION
# 3. In the still-open Claude session, call another gavin_* tool.
```

- [ ] **Step 2: Confirm the behaviour**

Expected: the tool call **succeeds**. `gavin-mcp` re-execs silently, and the agent sees a normal result rather than a protocol error.

Check the log for one re-exec and no loop:

```bash
grep -c "re-exec" ~/Library/Logs/Claude/mcp-server-gavin.log
```

Expected: at most one per daemon upgrade.

- [ ] **Step 3: Confirm the loop guard**

Point `.mcp.json` at a deliberately stale `gavin-mcp` that cannot satisfy the daemon, and call a tool.

Expected: exactly one re-exec attempt, then a clear tool error. **Not** a spin.

---

## Done when

- An update is offered by an icon that appears only when there is one, and never interrupts.
- Applying it never leaves app and daemon disagreeing.
- A failed download costs the user nothing.
- A running Claude session survives a daemon upgrade without user action.
- `cargo test` and `npm test` are green.
