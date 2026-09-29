// The bundle probe (debug builds only): proof, on a real Simulator or
// emulator, that a bundle's webview is the box ADR 0005 says it is.
//
// The probe is itself a bundle (`companion-shell/probe/`), served from an
// app-local origin of its own and opened exactly the way a Workstation's
// bundle is. From inside, it tries what a hostile bundle would: call a
// Capacitor plugin, speak on the channel from a frame that is not its
// main frame, reach the network, navigate away. It reports what happened
// over the channel -- the one outlet it has -- to the probe Workstation
// below, and the shell turns the reports and the drops it saw into a
// verdict. `scripts/probe.sh` launches it and reads that verdict from the
// device log.
import { CHANNEL_VERSION, encode, readBundleMessage } from "$companion/channel/messages";
import type { ChannelEndpoint } from "$companion/channel/port";
import type { HubWorkstation } from "$shell/hub/workstations";
import type { VisitDrop, VisitEndpoint, Visits } from "$shell/visit/visit";

export const PROBE_WORKSTATION: HubWorkstation = {
  id: "probe",
  name: "Bundle probe",
  demo: false,
  summary: "",
  state: "ready",
};

/// The command the probe page reports with, and the one its frames try.
export const PROBE_REPORT = "probe_report";
export const PROBE_FROM_FRAME = "probe_from_frame";

/// The line the probe script waits for in the device log.
export const VERDICT_MARK = "[gavin-probe]";

export interface ProbeAttempt {
  how: string;
  /// "failed: …" when it did not happen; anything else when it did.
  outcome: string;
}

export interface ProbeFrame {
  /// "other-origin" or "own-origin-subframe".
  frame: string;
  /// The frame's script ran and reported back to the page.
  ran: boolean;
  attempts: ProbeAttempt[];
}

export interface ChecksReport {
  stage: "checks";
  origin: string;
  capabilities: { workstation?: { id?: string } } | null;
  globals: Record<string, string>;
  pluginCalls: ProbeAttempt[];
  /// The same calls, made to the Device's keys plugin.
  keyCalls: ProbeAttempt[];
  frames: ProbeFrame[];
  fetches: ProbeAttempt[];
}

export interface NavigationReport {
  stage: "navigation";
  stillAt: string;
  windowOpen: string;
}

export type ProbeReport = ChecksReport | NavigationReport;

export interface ProbeCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ProbeVerdict {
  passed: boolean;
  checks: ProbeCheck[];
}

function failed(outcome: string): boolean {
  return outcome.startsWith("failed");
}

/// Whether a frame's message could have been carried: it posted
/// something on a handler it could see.
function posted(frame: ProbeFrame): boolean {
  return frame.attempts.some((a) => !failed(a.outcome));
}

export interface VerdictInput {
  reports: ProbeReport[];
  /// Every command that reached the probe Workstation.
  invokes: string[];
  drops: VisitDrop[];
}

/// What the probe proved. Every check must pass; a probe that did not run
/// far enough to report fails the checks it never reached.
export function probeVerdict({ reports, invokes, drops }: VerdictInput): ProbeVerdict {
  const checks = reports.find((r): r is ChecksReport => r.stage === "checks") ?? null;
  const navigation = reports.find((r): r is NavigationReport => r.stage === "navigation") ?? null;
  const out: ProbeCheck[] = [];
  const add = (name: string, passed: boolean, detail: string): void => {
    out.push({ name, passed, detail });
  };

  add(
    "the probe reported over the channel from its main frame",
    checks !== null && checks.capabilities?.workstation?.id === PROBE_WORKSTATION.id,
    checks ? `origin ${checks.origin}` : "no report arrived"
  );

  if (checks) {
    const bridges = Object.entries(checks.globals).filter(([, type]) => type !== "undefined");
    add(
      "the bundle webview has no Capacitor bridge",
      bridges.length === 0,
      bridges.length === 0
        ? Object.keys(checks.globals).join(", ") + ": all undefined"
        : bridges.map(([name, type]) => `${name} is ${type}`).join(", ")
    );
    add(
      "a plugin call from the bundle webview fails",
      checks.pluginCalls.length > 0 && checks.pluginCalls.every((c) => failed(c.outcome)),
      checks.pluginCalls.map((c) => `${c.how}: ${c.outcome}`).join("; ")
    );
    add(
      "the Device's keys are out of the bundle's reach",
      checks.keyCalls.length > 0 && checks.keyCalls.every((c) => failed(c.outcome)),
      checks.keyCalls.length > 0
        ? checks.keyCalls.map((c) => `${c.how}: ${c.outcome}`).join("; ")
        : "the probe made no call to the keys plugin"
    );

    const nativeDrops = drops.filter((d): d is Extract<VisitDrop, { where: "native" }> => d.where === "native");
    for (const [frameName, name, droppedNatively] of [
      [
        "other-origin",
        "a channel message from another origin is dropped",
        nativeDrops.some((d) => d.origin !== checks.origin),
      ],
      [
        "own-origin-subframe",
        "a channel message from a subframe is dropped",
        nativeDrops.some((d) => !d.mainFrame),
      ],
    ] as const) {
      const frame = checks.frames.find((f) => f.frame === frameName);
      const reached = invokes.filter((cmd) => cmd === `${PROBE_FROM_FRAME}:${frameName}`).length;
      const how = !frame
        ? "the frame never reported"
        : !frame.ran
          ? "the frame's script did not run"
          : `${frame.attempts.map((a) => `${a.how}: ${a.outcome}`).join("; ")}; ` +
            `${reached} reached the Workstation` +
            (posted(frame) ? `; dropped natively: ${droppedNatively}` : "");
      add(
        name,
        frame !== undefined && frame.ran && reached === 0 && (!posted(frame) || droppedNatively),
        how
      );
    }

    add(
      "the bundle cannot reach the network or the shell's origin",
      checks.fetches.length > 0 && checks.fetches.every((f) => failed(f.outcome)),
      checks.fetches.map((f) => `${f.how}: ${f.outcome}`).join("; ")
    );
  }

  add(
    "navigating away is blocked",
    navigation !== null && checks !== null && navigation.stillAt.startsWith(checks.origin),
    navigation ? `still at ${navigation.stillAt}` : "no report after the navigation attempt"
  );
  add(
    "window.open opens nothing",
    navigation !== null && navigation.windowOpen === "null",
    navigation ? `window.open returned ${navigation.windowOpen}` : "no report after the navigation attempt"
  );

  return { passed: out.every((c) => c.passed), checks: out };
}

export interface ProbeBench {
  /// The probe Workstation, for the visit.
  visit: VisitEndpoint;
  reports: ProbeReport[];
  invokes: string[];
  drops: VisitDrop[];
  /// Resolves when the probe has sent its last report.
  finished: Promise<void>;
}

/// The Workstation the probe bundle talks to: it records what arrives
/// and answers the probe's reports. Anything else is refused, as a
/// command no Workstation knows would be.
export function createProbeBench(): ProbeBench {
  const reports: ProbeReport[] = [];
  const invokes: string[] = [];
  const drops: VisitDrop[] = [];
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => (finish = resolve));
  const endpoint: ChannelEndpoint = {
    receive(raw, reply) {
      const read = readBundleMessage(raw);
      if (read.kind !== "message") return;
      const message = read.message;
      if (message.type === "listen" || message.type === "unlisten") {
        reply(encode({ v: CHANNEL_VERSION, type: "result", id: message.id, ok: true, value: null }));
        return;
      }
      if (message.type !== "invoke") return;
      const args = message.args as { frame?: unknown };
      invokes.push(
        message.cmd === PROBE_FROM_FRAME ? `${PROBE_FROM_FRAME}:${String(args.frame)}` : message.cmd
      );
      if (message.cmd === PROBE_REPORT) {
        const report = message.args as unknown as ProbeReport;
        reports.push(report);
        reply(encode({ v: CHANNEL_VERSION, type: "result", id: message.id, ok: true, value: null }));
        if (report.stage === "navigation") finish();
        return;
      }
      reply(
        encode({ v: CHANNEL_VERSION, type: "result", id: message.id, ok: false, error: `no command "${message.cmd}"` })
      );
    },
  };
  return { visit: { endpoint }, reports, invokes, drops, finished };
}

/// Opens the probe, waits for it to finish (or for `timeoutMs`), and
/// writes the verdict to the log on one line the probe script can find.
export async function runProbe(options: {
  visits: Visits;
  bench: ProbeBench;
  timeoutMs: number;
  log(line: string): void;
}): Promise<ProbeVerdict> {
  const { visits, bench, timeoutMs, log } = options;
  log(`${VERDICT_MARK} started`);
  await visits.open(PROBE_WORKSTATION);
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    bench.finished,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  const verdict = probeVerdict(bench);
  log(`${VERDICT_MARK} ${JSON.stringify(verdict)}`);
  await visits.close();
  return verdict;
}
