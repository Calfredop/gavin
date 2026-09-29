// What the Workstations hub lists.
//
// The Workstations this Device has paired with (companion-21), then the
// Demo Workstation: it is built into the binary, needs no pairing, and is
// what App Review explores (ADR 0005, Guideline 2.1(a)). A paired
// Workstation's live state ("desktop app not running", "asleep") and
// opening its UI are companion-22's and companion-23's.
import { DEMO } from "$companion/demo/sampleData";
import type { PairedWorkstation } from "$shell/hub/paired";

export type WorkstationState = "ready" | "paired";

export interface HubWorkstation {
  /// Also the host of its bundle's origin, so it is a DNS label.
  id: string;
  name: string;
  demo: boolean;
  /// The line under the name.
  summary: string;
  state: WorkstationState;
  /// Whether tapping it opens its UI. Not yet for a paired one: there is
  /// no connection to carry its bundle.
  openable: boolean;
}

/// The Demo Workstation, under the identity its own end of the channel
/// answers to: the hub and the bundle must not name it two ways.
export const DEMO_WORKSTATION: HubWorkstation = {
  id: DEMO.workstation.id,
  name: DEMO.workstation.name,
  demo: DEMO.workstation.demo,
  summary: "Sample workspaces, cards and agents to explore. Nothing to pair.",
  state: "ready",
  openable: true,
};

/// "29 Sept", the way the phone writes a date.
export type FormatDay = (ms: number) => string;

const formatDay: FormatDay = (ms) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });

export function hubWorkstations(paired: PairedWorkstation[] = [], day: FormatDay = formatDay): HubWorkstation[] {
  return [
    ...paired.map(
      (ws): HubWorkstation => ({
        id: ws.id,
        name: ws.name,
        demo: false,
        summary: `Paired on ${day(ws.pairedAt)}. Opening it from this phone comes in a later build.`,
        state: "paired",
        openable: false,
      })
    ),
    DEMO_WORKSTATION,
  ];
}

export function stateLabel(state: WorkstationState): string {
  switch (state) {
    case "ready":
      return "Ready";
    case "paired":
      return "Paired";
  }
}

/// A Workstation's id becomes a host name in its bundle's origin. Anything
/// else could not be an origin of its own, so it is not a Workstation.
export function isWorkstationHost(id: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(id);
}
