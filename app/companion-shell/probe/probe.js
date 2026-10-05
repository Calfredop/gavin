// The bundle probe: a bundle that tries, from inside the bundle webview,
// what a hostile bundle would, and reports what happened over the one
// outlet it has -- the channel -- to the shell's probe Workstation
// (src/shell/probe/probe.ts turns the reports into a verdict).
(async function () {
  const out = document.getElementById("out");
  const show = (line) => {
    out.textContent += line + "\n";
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const channel = window.gavinChannel;
  if (!channel) {
    show("No gavinChannel in this page: nothing to report to.");
    return;
  }
  let nextId = 1;
  const waiting = new Map();
  channel.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === "result" && waiting.has(message.id)) {
      waiting.get(message.id)(message);
      waiting.delete(message.id);
    }
  };
  const ask = (message) =>
    new Promise((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      channel.postMessage(JSON.stringify({ v: 1, id, ...message }));
      setTimeout(() => {
        if (waiting.delete(id)) resolve(null);
      }, 5000);
    });

  const capabilities = await ask({ type: "capabilities" });
  const report = {
    stage: "checks",
    origin: location.origin,
    capabilities: capabilities && capabilities.ok ? capabilities.value : null,
    globals: {},
    pluginCalls: [],
    keyCalls: [],
    pairingCalls: [],
    frames: [],
    fetches: [],
  };
  show(`origin ${location.origin}; channel answers as ${JSON.stringify(report.capabilities?.workstation ?? null)}`);

  // 1. What a page in a Capacitor webview would have.
  report.globals["Capacitor"] = typeof window.Capacitor;
  report.globals["webkit.messageHandlers.bridge"] = typeof window.webkit?.messageHandlers?.bridge;
  report.globals["androidBridge"] = typeof window.androidBridge;
  report.globals["CapacitorCookiesAndroidInterface"] = typeof window.CapacitorCookiesAndroidInterface;
  report.globals["CapacitorHttpAndroidInterface"] = typeof window.CapacitorHttpAndroidInterface;

  // 2. A plugin call, each way Capacitor's own JS makes one. It targets the
  // shell's own BundleView plugin: had any of these run, openExternal would
  // have logged opening a marked URL, which scripts/probe.sh watches the
  // device log for.
  const marked = "https://probe.invalid/plugin-call-ran";
  const call = async (into, how, fn) => {
    try {
      const result = await fn();
      into.push({ how, outcome: result === undefined ? "ran" : typeof result === "string" ? result : `ran: ${JSON.stringify(result)}` });
    } catch (e) {
      into.push({ how, outcome: `failed: ${e}` });
    }
  };
  const everyWay = async (into, pluginId, methodName, options) => {
    await call(into, `Capacitor.Plugins.${pluginId}.${methodName}`, () =>
      window.Capacitor.Plugins[pluginId][methodName](options)
    );
    await call(into, `Capacitor.nativePromise ${pluginId}.${methodName}`, () =>
      window.Capacitor.nativePromise(pluginId, methodName, options)
    );
    const bridgeCall = { type: "message", callbackId: "probe", pluginId, methodName, options };
    await call(into, `webkit.messageHandlers.bridge.postMessage ${pluginId}.${methodName}`, () => {
      window.webkit.messageHandlers.bridge.postMessage(bridgeCall);
      return "posted";
    });
    await call(into, `androidBridge.postMessage ${pluginId}.${methodName}`, () => {
      window.androidBridge.postMessage(JSON.stringify(bridgeCall));
      return "posted";
    });
  };
  await everyWay(report.pluginCalls, "BundleView", "openExternal", { url: marked });
  for (const c of report.pluginCalls) show(`plugin call, ${c.how}: ${c.outcome}`);

  // 2b. The Device's keys, the one thing a bundle must never reach
  // (ADR 0001). The sign's reason carries the same mark: the shell's
  // DeviceKeys logs every sign it is asked for, reason included.
  await everyWay(report.keyCalls, "DeviceKeys", "noiseKey", {});
  await everyWay(report.keyCalls, "DeviceKeys", "sign", { handshakeHash: "00".repeat(32), reason: marked });
  for (const c of report.keyCalls) show(`keys call, ${c.how}: ${c.outcome}`);

  // 2c. What pairing added: the paired Workstations, each with its
  // notification key, and the camera.
  await everyWay(report.pairingCalls, "Workstations", "list", {});
  await everyWay(report.pairingCalls, "QrScanner", "scan", {});
  for (const c of report.pairingCalls) show(`pairing call, ${c.how}: ${c.outcome}`);

  // 3. The channel from frames: one of another origin (sandboxed, so
  // opaque), one of the page's own origin.
  const frameScript = document.getElementById("frame-script").textContent;
  const heard = new Map();
  window.addEventListener("message", (event) => {
    if (event.data && event.data.probeFrame) heard.set(event.data.probeFrame, event.data.attempts);
  });
  for (const [name, sandboxed] of [
    ["other-origin", true],
    ["own-origin-subframe", false],
  ]) {
    const frame = document.createElement("iframe");
    if (sandboxed) frame.setAttribute("sandbox", "allow-scripts");
    frame.srcdoc = `<!doctype html><script data-frame="${name}">${frameScript}</` + "script>";
    document.body.appendChild(frame);
  }
  // Long enough for both frames to run and for the native side's drops
  // to reach the shell before the report does.
  await sleep(2500);
  for (const name of ["other-origin", "own-origin-subframe"]) {
    const attempts = heard.get(name);
    report.frames.push({ frame: name, ran: attempts !== undefined, attempts: attempts ?? [] });
    show(`frame ${name}: ${attempts ? attempts.map((a) => `${a.how}: ${a.outcome}`).join("; ") : "never reported"}`);
  }

  // 4. The network, the shell's own origin, and another Workstation's.
  const own = location.protocol === "gavin-bundle:";
  const reach = async (url) => {
    try {
      const response = await fetch(url, { cache: "no-store" });
      report.fetches.push({ how: `fetch ${url}`, outcome: response.ok ? `reached: HTTP ${response.status}` : `failed: HTTP ${response.status}` });
    } catch (e) {
      report.fetches.push({ how: `fetch ${url}`, outcome: `failed: ${e}` });
    }
  };
  await reach("https://example.com/");
  await reach(own ? "capacitor://localhost/" : "https://localhost/");
  await reach(own ? "gavin-bundle://demo/" : "https://demo.bundle.gavin.invalid/");
  report.fetches.push({
    how: "WebSocket wss://example.com/",
    outcome: await new Promise((resolve) => {
      try {
        const socket = new WebSocket("wss://example.com/");
        socket.onopen = () => {
          socket.close();
          resolve("opened");
        };
        socket.onerror = () => resolve("failed: error event");
        setTimeout(() => resolve("failed: never opened"), 3000);
      } catch (e) {
        resolve(`failed: ${e}`);
      }
    }),
  });
  for (const f of report.fetches) show(`${f.how}: ${f.outcome}`);

  await ask({ type: "invoke", cmd: "probe_report", args: report });

  // 5. Leaving: a popup, then this page itself. The second report only
  // arrives if the page is still here to send it.
  let popup;
  try {
    popup = window.open("https://example.com/");
  } catch (e) {
    popup = `threw ${e}`;
  }
  const windowOpen = popup === null ? "null" : String(popup);
  show(`window.open: ${windowOpen}`);
  location.href = "https://example.com/";
  await sleep(1500);
  show(`still at ${location.href}`);
  await ask({ type: "invoke", cmd: "probe_report", args: { stage: "navigation", stillAt: location.href, windowOpen } });
  show("done");
})();
