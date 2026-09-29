// The hub's pairing flow, wired to what the phone has: the native keys,
// camera and store, the webview's WebSocket and random source, and the
// Companion core fetched from the hub's own files.
import { loadCore, type CoreModule } from "$shell/core/core";
import type { PairedStore } from "$shell/hub/paired";
import type { QrScannerPlugin } from "$shell/native/qrScanner";
import { createPairFlow, type PairFlow, type PairFlowDeps } from "$shell/pairing/pairFlow";
import { deviceNameFrom, pair, type PairingKeys } from "$shell/pairing/pairing";
import { webSocketOpener, type WebSocketConstructor } from "$shell/pairing/relaySocket";

/// The core, compiled the first time a pairing needs it and kept after.
/// A load that failed is tried again by the next pairing, not remembered.
export function coreOnce(fetchBytes: () => Promise<ArrayBuffer>): () => Promise<CoreModule> {
  let loading: Promise<CoreModule> | null = null;
  return () => {
    loading ??= fetchBytes()
      .then(loadCore)
      .catch((e) => {
        loading = null;
        throw e;
      });
    return loading;
  };
}

export interface PhonePairingDeps {
  keys: PairingKeys;
  scanner: Pick<QrScannerPlugin, "scan">;
  store: PairedStore;
  core: () => Promise<CoreModule>;
  WebSocket: WebSocketConstructor;
  userAgent: string;
  onChange: PairFlowDeps["onChange"];
  log?: PairFlowDeps["log"];
}

export function phonePairFlow(deps: PhonePairingDeps): PairFlow {
  const open = webSocketOpener(deps.WebSocket);
  return createPairFlow({
    scan: () => deps.scanner.scan(),
    async pair(qr, onPhase, signal) {
      let core: CoreModule;
      try {
        core = await deps.core();
      } catch (e) {
        return {
          outcome: "failed",
          problem: `This Companion could not start its pairing code: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      return pair(qr, {
        core,
        keys: deps.keys,
        open,
        random: (n) => crypto.getRandomValues(new Uint8Array(n)),
        deviceName: deviceNameFrom(deps.userAgent),
        onPhase,
        signal,
      });
    },
    store: deps.store,
    now: () => Date.now(),
    onChange: deps.onChange,
    log: deps.log,
  });
}
