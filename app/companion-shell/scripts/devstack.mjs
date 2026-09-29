// A Workstation to pair with, on this machine, touching nothing of the
// developer's: the `gavin-relay` binary on loopback, and a `gavin-daemon`
// under a temporary $HOME -- its own socket, its own trust store -- with
// this script playing the desk on its two connections, the way
// `crates/daemon/tests/device_wire.rs` does. Ticket 17's dev stack
// (docker compose) will be the long-lived version; this lives for one run.
//
// As a module, `startDevStack()` is what the node end-to-end test uses
// (`src/shell/pairing/pairing.e2e.ts`). As a script it is the desk for a
// pairing on a Simulator or an emulator (`scripts/pair.sh`):
//
//   node scripts/devstack.mjs desk --qr-out <file> --phone-log <file> [--relay-host <ip>]
//
// writes the pairing QR to `--qr-out`, waits for the desk to be asked,
// reads the six digits the phone shows out of its log, confirms only if
// they match, and exits 0 once the desk lists the phone.
//
//   node scripts/devstack.mjs hub --work <dir>
//
// is the two Workstations for `scripts/hub.sh`: two stacks, each paired
// the same way in turn -- `<dir>/qr-<n>` for the code, `<dir>/phone-<n>.log`
// for what the phone showed -- then each desktop app started with
// something waiting, and `<dir>/ready` written. It holds them until killed.
//
// The Relay is plain ws:// on 127.0.0.1, which a Relay URL may be only
// because it is loopback (`protocol::relay::RelayUrl::parse`). A Simulator
// shares the Mac's network, so it dials the same address; an emulator
// reaches it through `adb reverse`.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const shell = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(shell, "..", "..");
const TOKEN = "devstack-admission";

/// Builds the two binaries, debug. Cargo's incremental build makes a
/// second run cheap.
export function buildStack() {
  const build = spawnSync("cargo", ["build", "-p", "gavin-daemon", "-p", "gavin-relay", "--locked"], {
    cwd: repo,
    stdio: "inherit",
  });
  if (build.status !== 0) throw new Error("building gavin-daemon and gavin-relay failed");
}

/// The protocol version this checkout speaks, for the desk's Hello.
function protocolVersion() {
  const source = readFileSync(join(repo, "crates", "protocol", "src", "lib.rs"), "utf8");
  const found = /pub const PROTOCOL_VERSION: u32 = (\d+);/.exec(source);
  if (!found) throw new Error("PROTOCOL_VERSION not found in crates/protocol/src/lib.rs");
  return Number(found[1]);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what, check, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

/// One of the desktop app's connections to its daemon: newline-delimited
/// JSON, a request and its answer, or pushes read as they come.
class DeskConnection {
  static async open(socketPath, token, kind, version) {
    const socket = createConnection(socketPath);
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const desk = new DeskConnection(socket);
    const ack = await desk.request({
      type: "Hello",
      client: "app",
      protocol_version: version,
      auth: { kind: "daemon-token", token },
      nonce: "devstack",
      connection: kind,
    });
    if (ack.type !== "HelloAck" || ack.role !== "app") throw new Error(`the daemon did not accept the desk: ${JSON.stringify(ack)}`);
    return desk;
  }

  constructor(socket) {
    this.socket = socket;
    this.buffer = "";
    this.lines = [];
    this.waiting = [];
    this.closed = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      this.buffer += chunk;
      let at;
      while ((at = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        const waiter = this.waiting.shift();
        if (waiter) waiter.resolve(message);
        else this.lines.push(message);
      }
    });
    socket.on("close", () => {
      this.closed = true;
      for (const waiter of this.waiting.splice(0)) waiter.reject(new Error("the daemon closed the desk's connection"));
    });
  }

  next(timeoutMs = 20_000) {
    const queued = this.lines.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed) return Promise.reject(new Error("the daemon closed the desk's connection"));
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      const timer = setTimeout(() => {
        this.waiting = this.waiting.filter((w) => w !== waiter);
        reject(new Error("the daemon did not answer in time"));
      }, timeoutMs);
      this.waiting.push(waiter);
    });
  }

  request(message, timeoutMs) {
    this.socket.write(`${JSON.stringify(message)}\n`);
    return this.next(timeoutMs);
  }

  close() {
    this.socket.destroy();
  }
}

/// Starts the Relay and the daemon, connects the desk, and turns remote
/// access on against the Relay. `relayHost` is where the Relay listens and
/// how the code names it: loopback unless a phone on the LAN must reach it.
export async function startDevStack({ log = () => {}, relayHost = "127.0.0.1" } = {}) {
  const children = [];
  const home = mkdtempSync("/tmp/gavin-pair-");
  const files = [];
  const logFile = (name) => {
    const fd = openSync(join(home, name), "w");
    files.push(fd);
    return fd;
  };
  const stop = async () => {
    for (const child of children) child.kill();
    for (const fd of files.splice(0)) closeSync(fd);
    await sleep(100);
    rmSync(home, { recursive: true, force: true });
  };
  try {
    for (const bin of ["gavin-daemon", "gavin-relay"]) {
      if (!existsSync(join(repo, "target", "debug", bin))) {
        throw new Error(`target/debug/${bin} is not built: run buildStack() (cargo build -p gavin-daemon -p gavin-relay)`);
      }
    }

    const port = await freePort();
    const relayUrl = `ws://${relayHost}:${port}`;
    const relay = spawn(join(repo, "target", "debug", "gavin-relay"), [], {
      env: {
        PATH: process.env.PATH,
        GAVIN_RELAY_LISTEN: `${relayHost}:${port}`,
        GAVIN_RELAY_TOKENS: TOKEN,
        GAVIN_RELAY_TLS_TERMINATED: "1",
      },
      stdio: ["ignore", "pipe", logFile("relay.log")],
    });
    children.push(relay);
    let relayOut = "";
    relay.stdout.on("data", (d) => (relayOut += d));
    await until("the Relay to listen", () => relayOut.includes("listening"));
    log(`relay: ${relayUrl}`);

    // Where the daemon keeps its socket under this $HOME: macOS's
    // Application Support, else XDG's default. A debug build's names
    // carry `-dev`.
    const data =
      process.platform === "darwin"
        ? join(home, "Library", "Application Support", "gavin")
        : join(home, ".local", "share", "gavin");
    const daemon = spawn(join(repo, "target", "debug", "gavin-daemon"), [], {
      env: { PATH: process.env.PATH, HOME: home, LOCALAPPDATA: home, USERPROFILE: home },
      stdio: ["ignore", "ignore", logFile("daemon.log")],
    });
    children.push(daemon);
    const socketPath = join(data, "daemon-dev.sock");
    const tokenPath = join(data, "daemon-dev.token");
    await until("the daemon's socket", () => existsSync(socketPath) && existsSync(tokenPath));
    const daemonToken = readFileSync(tokenPath, "utf8").trim();
    const version = protocolVersion();
    const command = await until("the daemon to answer", () =>
      DeskConnection.open(socketPath, daemonToken, "command", version).catch(() => null)
    );
    const push = await DeskConnection.open(socketPath, daemonToken, "push", version);
    /// The desktop app's forwarding connections, while it runs.
    const apps = [];
    log(`daemon: ${home}`);

    const ok = (answer, what) => {
      if (answer.type !== "Ok") throw new Error(`${what}: ${JSON.stringify(answer)}`);
    };
    ok(
      await command.request({ type: "SetRemoteAccess", enabled: true, relay_url: relayUrl, relay_admission: TOKEN }),
      "turning remote access on"
    );

    const desk = {
      /// Presses "Pair a device": the QR's string.
      async offer() {
        const answer = await command.request({ type: "BeginPairing" });
        if (answer.type !== "PairingOffer") throw new Error(`no pairing offer: ${JSON.stringify(answer)}`);
        return answer.qr;
      },
      /// The pairing the desk is asked about: `{ device_id, name, sas }`.
      async asked(timeoutMs = 180_000) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const push_ = await push.next(Math.max(1, deadline - Date.now()));
          if (push_.type === "DevicePairingRequested") return push_;
        }
      },
      async confirm(deviceId) {
        ok(await command.request({ type: "ConfirmPairing", device_id: deviceId }), "confirming");
      },
      async reject(deviceId) {
        ok(await command.request({ type: "RejectPairing", device_id: deviceId }), "rejecting");
      },
      /// The trust store, as the Devices panel reads it: `DeviceInfo`,
      /// camelCase.
      async devices() {
        const answer = await command.request({ type: "ListDevices" });
        if (answer.type !== "Devices") throw new Error(`no device list: ${JSON.stringify(answer)}`);
        return answer.devices;
      },
      /// Starts the desktop app, as far as a Device can tell: the
      /// forwarding connection, answering every attention ask with
      /// `items` (`AttentionItem`s) and every forwarded command with
      /// null. Until it is started, and after `quit()`, the daemon
      /// answers "desktop app not running".
      async startApp(items = []) {
        const forward = await DeskConnection.open(socketPath, daemonToken, "forward", version);
        let answering = items;
        let running = true;
        void (async () => {
          while (running) {
            let message;
            try {
              message = await forward.next(60_000);
            } catch {
              if (forward.closed) return;
              continue;
            }
            // `Ok` acknowledges an answer this loop wrote.
            if (message.type === "ForwardAttention") {
              forward.socket.write(`${JSON.stringify({ type: "AttentionResult", call_id: message.call_id, items: answering })}\n`);
            } else if (message.type === "ForwardCommand") {
              forward.socket.write(`${JSON.stringify({ type: "ForwardResult", call_id: message.call_id, value: null, error: null })}\n`);
            }
          }
        })();
        apps.push(forward);
        return {
          setItems(next) {
            answering = next;
          },
          quit() {
            running = false;
            forward.close();
          },
        };
      },
      /// Remote access off at the desk: the daemon lets go of its Relay,
      /// which then tells a Device the Workstation is `offline`.
      async remoteAccess(enabled) {
        ok(
          await command.request({ type: "SetRemoteAccess", enabled, relay_url: relayUrl, relay_admission: TOKEN }),
          enabled ? "turning remote access on" : "turning remote access off"
        );
      },
    };

    return {
      relayUrl,
      token: TOKEN,
      home,
      desk,
      daemonLog: () => (existsSync(join(home, "daemon.log")) ? readFileSync(join(home, "daemon.log"), "utf8") : ""),
      /// Waits until the daemon is registered with the Relay: a Device
      /// asking for this Workstation is carried, not told `offline`.
      async registered(qr) {
        const key = Buffer.from(JSON.parse(qr).daemonPublicKey, "hex");
        // protocol::relay::rendezvous_id, whose vector is pinned there.
        const rendezvous = createHash("sha256").update("gavin-relay-rendezvous-v1").update(key).digest("hex");
        await until(
          "the daemon to register with the Relay",
          () =>
            new Promise((resolve) => {
              const ws = new WebSocket(relayUrl);
              ws.onopen = () =>
                // `connect`, which every daemon picks up: a `pair` probe
                // would be read as the pairing and spend the offer.
                ws.send(JSON.stringify({ role: "device", v: 1, token: TOKEN, rendezvous, purpose: "connect" }));
              ws.onmessage = (event) => {
                ws.close();
                resolve(JSON.parse(String(event.data)).type === "ready");
              };
              ws.onerror = () => resolve(false);
            }),
          30_000
        );
      },
      async stop() {
        for (const app of apps) app.close();
        command.close();
        push.close();
        await stop();
      },
    };
  } catch (e) {
    await stop();
    throw e;
  }
}

// -- as a script -----------------------------------------------------------

function option(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

async function runDesk() {
  const qrOut = option("--qr-out");
  const phoneLog = option("--phone-log");
  if (!qrOut || !phoneLog) {
    console.error("usage: node scripts/devstack.mjs desk --qr-out <file> --phone-log <file>");
    process.exit(2);
  }
  buildStack();
  const stack = await startDevStack({
    log: (line) => console.log(`[desk] ${line}`),
    relayHost: option("--relay-host") ?? "127.0.0.1",
  });
  // Killed from outside (scripts/pair.sh giving up, a Ctrl-C): the Relay
  // and the daemon go with it, and so does their $HOME.
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => void stack.stop().finally(() => process.exit(1)));
  }
  let status = 1;
  try {
    const qr = await stack.desk.offer();
    await stack.registered(qr);
    writeFileSync(qrOut, qr);
    console.log("[desk] pairing code ready; waiting for the phone");

    const asked = await stack.desk.asked();
    console.log(`[desk] asked to pair "${asked.name}"; the desk shows ${asked.sas}`);
    const phoneCode = await until(
      "the phone to show its code",
      () => /\[gavin-pair\] code (\d{6})/.exec(existsSync(phoneLog) ? readFileSync(phoneLog, "utf8") : "")?.[1],
      60_000
    );
    console.log(`[desk] the phone shows ${phoneCode}`);
    if (phoneCode !== asked.sas) {
      console.log("[desk] the codes differ: rejecting");
      await stack.desk.reject(asked.device_id);
      return;
    }
    await stack.desk.confirm(asked.device_id);
    const listed = await until("the desk to list the phone", async () =>
      (await stack.desk.devices()).find((d) => d.deviceId === asked.device_id)
    );
    console.log(`[desk] the Devices panel lists "${listed.name}" (${listed.deviceId})`);
    // The verdict is still on its way to the phone: stopping the Relay
    // now would cut it off. Held until the phone says how it ended.
    const ended = await until(
      "the phone to hear the verdict",
      () => /\[gavin-pair\] (paired|failed)/.exec(readFileSync(phoneLog, "utf8"))?.[1],
      60_000
    );
    console.log(`[desk] the phone says it ${ended}`);
    status = ended === "paired" ? 0 : 1;
  } catch (e) {
    console.error(`[desk] ${e instanceof Error ? e.message : String(e)}`);
    console.error(stack.daemonLog());
  } finally {
    await stack.stop();
    process.exit(status);
  }
}

/// Pairs the phone with `stack` the way `runDesk` does: the code in
/// `qrOut`, the phone's six digits read out of `phoneLog`.
async function pairPhone(stack, qrOut, phoneLog, say) {
  const qr = await stack.desk.offer();
  await stack.registered(qr);
  writeFileSync(qrOut, qr);
  say("pairing code ready; waiting for the phone");
  const asked = await stack.desk.asked();
  const phoneCode = await until(
    "the phone to show its code",
    () => /\[gavin-pair\] code (\d{6})/.exec(existsSync(phoneLog) ? readFileSync(phoneLog, "utf8") : "")?.[1],
    60_000
  );
  say(`the desk shows ${asked.sas}, the phone ${phoneCode}`);
  if (phoneCode !== asked.sas) {
    await stack.desk.reject(asked.device_id);
    throw new Error("the codes differ");
  }
  await stack.desk.confirm(asked.device_id);
  const ended = await until(
    "the phone to hear the verdict",
    () => /\[gavin-pair\] (paired|failed)/.exec(readFileSync(phoneLog, "utf8"))?.[1],
    60_000
  );
  if (ended !== "paired") throw new Error("the phone says the pairing failed");
  say("paired");
}

async function runHub() {
  const work = option("--work");
  if (!work) {
    console.error("usage: node scripts/devstack.mjs hub --work <dir>");
    process.exit(2);
  }
  buildStack();
  const stacks = [];
  const stopAll = () => Promise.all(stacks.map((stack) => stack.stop()));
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => void stopAll().finally(() => process.exit(0)));
  }
  try {
    for (const n of [0, 1]) {
      stacks.push(await startDevStack({ log: (line) => console.log(`[desk ${n}] ${line}`) }));
    }
    for (const n of [0, 1]) {
      await pairPhone(stacks[n], join(work, `qr-${n}`), join(work, `phone-${n}.log`), (line) =>
        console.log(`[desk ${n}] ${line}`)
      );
    }
    const item = (id, kind, text) => ({ id, workspace: "ws-1", kind, text, target: { kind: "session", id: `s-${id}` } });
    await stacks[0].desk.startApp([
      item("w1", "waiting", "feat-x asks which migration to keep"),
      item("w2", "human-test", "check the Devices panel"),
    ]);
    await stacks[1].desk.startApp([item("w1", "rail-stopped", "the nightly rail paused")]);
    writeFileSync(join(work, "ready"), "");
    console.log("[desk] both Workstations paired, their desktop apps running");
    await new Promise(() => {});
  } catch (e) {
    console.error(`[desk] ${e instanceof Error ? e.message : String(e)}`);
    for (const stack of stacks) console.error(stack.daemonLog());
    await stopAll();
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "desk") {
  await runDesk();
}
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "hub") {
  await runHub();
}
