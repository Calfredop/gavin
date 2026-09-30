// Which end of the channel a visit reaches.
import { createDemoWorkstation } from "$companion/demo/workstation";
import { DEMO_PACE_MS } from "$companion/state/entry";
import type { HubWorkstation } from "$shell/hub/workstations";
import type { VisitEndpoint } from "$shell/visit/visit";
import { workstationEndpoint, type ConnectionSource } from "$shell/visit/workstationEndpoint";

/// Runs `fn` every `ms`; returns how to stop it.
export type Every = (fn: () => void, ms: number) => () => void;

const every: Every = (fn, ms) => {
  const timer = setInterval(fn, ms);
  return () => clearInterval(timer);
};

/// The Demo Workstation, fresh for each visit. The shell hosts it and
/// paces it: the bundle only ever sees its end of the channel, exactly as
/// it will see a real Workstation's.
///
/// `host` is empty on purpose. Opening a link and returning to the hub are
/// the shell's acts, answered before a message could reach a Workstation.
export function demoEndpoint(schedule: Every = every): VisitEndpoint {
  const demo = createDemoWorkstation({ host: {} });
  return {
    endpoint: demo,
    start: () => schedule(() => demo.advance(), DEMO_PACE_MS),
  };
}

/// The end a Workstation's visit reaches: the Demo Workstation hosted
/// here, or a paired Workstation over the live hub's connection to it
/// (`sourceFor`), through the daemon's forwarding to its desktop app.
export function endpointFor(
  workstation: HubWorkstation,
  sourceFor: ((id: string) => ConnectionSource) | null,
  schedule: Every = every,
  log?: (line: string) => void
): VisitEndpoint {
  if (workstation.demo) return demoEndpoint(schedule);
  if (!sourceFor) throw new Error(`no way to reach ${workstation.name} from here`);
  return workstationEndpoint(sourceFor(workstation.id), { log });
}
