// The hub's "Pair a Workstation": scan, pair, keep, and what the sheet
// over the hub shows meanwhile. `PairingSheet.svelte` draws it.
//
// One pairing at a time. A newer one -- or Cancel, or Close -- supersedes
// the one running, which is then cancelled and whose late answers are
// ignored: counted, never compared by identity (a Svelte state proxy is
// never the object it wraps).
import { writable, type Readable } from "svelte/store";
import { keepPairing, renamed, type PairedStore, type PairedWorkstation } from "$shell/hub/paired";
import type { ScanErrorCode } from "$shell/native/qrScanner";
import type { PairingOutcome, PairingPhase } from "$shell/pairing/pairing";

export type PairSheet =
  | { step: "closed" }
  | { step: "scanning" }
  | { step: "working"; phase: PairingPhase }
  | { step: "paired"; workstation: PairedWorkstation }
  | { step: "failed"; problem: string };

export interface PairFlowDeps {
  scan(): Promise<{ text: string }>;
  pair(qr: string, onPhase: (phase: PairingPhase) => void, signal: AbortSignal): Promise<PairingOutcome>;
  store: PairedStore;
  now(): number;
  /// The paired Workstations, after a pairing or a rename changed them.
  onChange(paired: PairedWorkstation[]): void;
  /// For a scripted run: one line a step (`scripts/pair.sh` reads them).
  log?(line: string): void;
}

export interface PairFlow {
  readonly sheet: Readable<PairSheet>;
  /// Scans a code, then pairs with it.
  start(): Promise<void>;
  /// Pairs with a code already in hand.
  startWith(qr: string): Promise<void>;
  /// Stops the pairing that is running. The Workstation hears the stream
  /// close, and nothing is paired.
  cancel(): void;
  /// Names the Workstation just paired.
  rename(name: string): Promise<void>;
  close(): void;
}

export function createPairFlow(deps: PairFlowDeps): PairFlow {
  const sheet = writable<PairSheet>({ step: "closed" });
  let runs = 0;
  let running: AbortController | null = null;
  let current: PairSheet = { step: "closed" };
  const show = (next: PairSheet): void => {
    current = next;
    sheet.set(next);
  };
  const log = (line: string): void => deps.log?.(`[gavin-pair] ${line}`);

  function supersede(): number {
    running?.abort();
    running = null;
    return ++runs;
  }

  async function startWith(qr: string, run = supersede()): Promise<void> {
    const controller = new AbortController();
    running = controller;
    const onPhase = (phase: PairingPhase): void => {
      if (run !== runs) return;
      log(phase.phase === "comparing" ? `code ${phase.code}` : `phase ${phase.phase}`);
      show({ step: "working", phase });
    };
    const outcome = await deps.pair(qr, onPhase, controller.signal);
    if (run !== runs) return;
    running = null;
    switch (outcome.outcome) {
      case "cancelled":
        log("cancelled");
        show({ step: "closed" });
        return;
      case "failed":
        log(`failed ${outcome.problem}`);
        show({ step: "failed", problem: outcome.problem });
        return;
      case "paired":
        try {
          const record = keepPairing(outcome.workstation, await deps.store.list(), deps.now());
          await deps.store.save(record);
          const paired = await deps.store.list();
          if (run !== runs) return;
          deps.onChange(paired);
          log(`paired ${record.id} as ${record.deviceId}`);
          show({ step: "paired", workstation: record });
        } catch (e) {
          if (run !== runs) return;
          const problem = `The desk paired this phone, but the phone could not keep the Workstation: ${
            e instanceof Error ? e.message : String(e)
          }. Pair again.`;
          log(`failed ${problem}`);
          show({ step: "failed", problem });
        }
    }
  }

  return {
    sheet: { subscribe: sheet.subscribe },

    async start() {
      const run = supersede();
      show({ step: "scanning" });
      let qr: string;
      try {
        qr = (await deps.scan()).text;
      } catch (e) {
        if (run !== runs) return;
        const problem = scanProblem((e as { code?: string } | null)?.code as ScanErrorCode | undefined, e);
        show(problem === null ? { step: "closed" } : { step: "failed", problem });
        return;
      }
      if (run !== runs) return;
      await startWith(qr, run);
    },

    startWith: (qr) => startWith(qr),

    cancel() {
      supersede();
      show({ step: "closed" });
    },

    async rename(name) {
      if (current.step !== "paired") return;
      const run = runs;
      const record = renamed(current.workstation, name);
      if (record.name === current.workstation.name) return;
      await deps.store.save(record);
      const paired = await deps.store.list();
      deps.onChange(paired);
      if (run === runs && current.step === "paired") show({ step: "paired", workstation: record });
    },

    close() {
      supersede();
      show({ step: "closed" });
    },
  };
}

/// The six digits as the sheet shows them: two groups of three, exactly
/// as the desk shows its own (`formatSas` in `$lib/core/remoteAccess.ts`,
/// not imported because that module brings the desk's hub with it).
export function spacedCode(code: string): string {
  return /^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/// What a scan that read nothing says, or null for one the owner closed.
function scanProblem(code: ScanErrorCode | undefined, e: unknown): string | null {
  switch (code) {
    case "cancelled":
      return null;
    case "no-camera":
      return "This phone has no camera to scan the code with.";
    case "camera-denied":
      return "Gavin may not use the camera. Allow it in Settings, then scan again.";
    default:
      return `The code could not be scanned: ${e instanceof Error ? e.message : String(e)}`;
  }
}
