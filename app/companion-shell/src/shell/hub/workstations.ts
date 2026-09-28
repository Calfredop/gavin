// What the Workstations hub lists.
//
// For now that is the Demo Workstation alone: it is built into the
// binary, needs no pairing, and is what App Review explores (ADR 0005,
// Guideline 2.1(a)). Paired Workstations join it with companion-21, and
// their states ("desktop app not running", "asleep") with companion-22.
import { DEMO } from "$companion/demo/sampleData";

export type WorkstationState = "ready";

export interface HubWorkstation {
  /// Also the host of its bundle's origin, so it is a DNS label.
  id: string;
  name: string;
  demo: boolean;
  /// The line under the name.
  summary: string;
  state: WorkstationState;
}

/// The Demo Workstation, under the identity its own end of the channel
/// answers to: the hub and the bundle must not name it two ways.
export const DEMO_WORKSTATION: HubWorkstation = {
  id: DEMO.workstation.id,
  name: DEMO.workstation.name,
  demo: DEMO.workstation.demo,
  summary: "Sample workspaces, cards and agents to explore. Nothing to pair.",
  state: "ready",
};

export function hubWorkstations(): HubWorkstation[] {
  return [DEMO_WORKSTATION];
}

export function stateLabel(state: WorkstationState): string {
  switch (state) {
    case "ready":
      return "Ready";
  }
}

/// A Workstation's id becomes a host name in its bundle's origin. Anything
/// else could not be an origin of its own, so it is not a Workstation.
export function isWorkstationHost(id: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(id);
}
