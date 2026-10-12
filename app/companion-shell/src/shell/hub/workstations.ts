// What the Workstations hub lists.
//
// The Workstations this Device has paired with, each with its live state
// while the Companion is unlocked (`hub/live.ts`), then the Demo
// Workstation: it is built into the binary, needs no pairing, and is what
// App Review explores (ADR 0005, Guideline 2.1(a)). A paired Workstation
// opens once it is ready: its desktop app is what serves its UI and
// answers it (ADR 0003).
import { DEMO } from "$companion/demo/sampleData";
import { liveLabel, liveSummary, tryNowOffered, type LiveState, type LiveStateName } from "$shell/hub/live";
import type { PairedWorkstation } from "$shell/hub/paired";

export type WorkstationState = LiveStateName;

export interface HubWorkstation {
  /// Also the host of its bundle's origin, so it is a DNS label.
  id: string;
  name: string;
  demo: boolean;
  /// The line under the name: what is wrong, and what to do. Empty where
  /// the state says it all -- ready, or locked under the Unlock's banner.
  summary: string;
  /// How many items it has waiting on the human; none unless it is
  /// ready.
  waiting?: number;
  state: WorkstationState;
  /// The state, in words.
  label: string;
  /// Whether tapping it opens its UI: the Demo always; a paired one when
  /// it is ready, since its desktop app serves the bundle and answers it.
  openable: boolean;
  /// Whether tapping it tries it again now (`Try now`): a paired one that
  /// is not ready, and may be by now.
  tryNow?: boolean;
}

/// The Demo Workstation, under the identity its own end of the channel
/// answers to: the hub and the bundle must not name it two ways.
export const DEMO_WORKSTATION: HubWorkstation = {
  id: DEMO.workstation.id,
  name: DEMO.workstation.name,
  demo: DEMO.workstation.demo,
  summary: "Sample workspaces, cards and agents to explore. Nothing to pair.",
  state: "ready",
  label: liveLabel({ state: "ready", items: [] }),
  waiting: 0,
  openable: true,
};

/// Once a real Workstation is paired the Demo is one line, last: it is
/// still there to explore, and no longer what the hub is for.
const DEMO_COMPACT: HubWorkstation = { ...DEMO_WORKSTATION, summary: "" };

const LOCKED: LiveState = { state: "locked" };

/// `live` is each paired Workstation's state by id; one it does not
/// name is locked.
export function hubWorkstations(
  paired: PairedWorkstation[] = [],
  live: Readonly<Record<string, LiveState>> = {}
): HubWorkstation[] {
  return [
    ...paired.map((ws): HubWorkstation => {
      const state = live[ws.id] ?? LOCKED;
      return {
        id: ws.id,
        name: ws.name,
        demo: false,
        summary: state.state === "ready" || state.state === "locked" ? "" : liveSummary(state),
        state: state.state,
        label: liveLabel(state),
        waiting: state.state === "ready" ? state.items.length : 0,
        openable: state.state === "ready",
        tryNow: tryNowOffered(state),
      };
    }),
    paired.length > 0 ? DEMO_COMPACT : DEMO_WORKSTATION,
  ];
}

/// A Workstation's id becomes a host name in its bundle's origin. Anything
/// else could not be an origin of its own, so it is not a Workstation.
export function isWorkstationHost(id: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(id);
}
