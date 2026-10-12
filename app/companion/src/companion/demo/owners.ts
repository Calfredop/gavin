// The Demo Workstation's session owners (v68): which Device each session
// takes input from, kept the way the daemon keeps it -- and a second,
// scripted Device that owns one of them, so a phone exploring the demo
// meets a locked session, takes it over, and can hand it back (spec
// "Demo Workstation"; App Review sees the lock this way).
//
// The rules are the daemon's (`crates/daemon/src/ownership.rs`), as far as
// one phone and one scripted tablet can reach them: this phone's input
// into a session nobody owns takes it, its input into the tablet's is
// refused naming the tablet, and a Take over while the tablet typed a
// moment ago is asked about first. Refusals are the daemon's own string,
// so the bundle reads them with the parser it reads a real Workstation's
// with.
import {
  OWNER_BUSY_SECS,
  OWNER_REFUSED_PREFIX,
  type LiveDevice,
  type OwnerChange,
  type OwnerRefusal,
  type SessionOwner,
  type SessionOwnership,
} from "$lib/core/sessionOwnership";
import { DemoFailure, text, type Answer, type DemoCommand, type DemoContext } from "$companion/demo/answer";

/// This phone, as the demo knows it: who `list_session_owners` says is
/// asking.
export const DEMO_DEVICE: LiveDevice = { deviceId: "demo-this-device", name: "This phone" };

/// The other Device: a tablet working in the field notes' agent.
export const DEMO_TABLET: LiveDevice = { deviceId: "demo-tablet", name: "iPad (demo)" };

/// The session the tablet owns when the demo opens.
export const TABLET_SESSION = "s-notes-sync";

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export function sampleOwners(now = nowSeconds()): Record<string, SessionOwner> {
  return {
    [TABLET_SESSION]: { ...DEMO_TABLET, since: now - 600, typedAt: now - 240 },
  };
}

function refuse(refusal: OwnerRefusal): never {
  throw new DemoFailure(`${OWNER_REFUSED_PREFIX}${JSON.stringify(refusal)}`);
}

function ownership(sessionId: string, owner: SessionOwner | null, changedBy: string | null, reason: OwnerChange): SessionOwnership {
  return { sessionId, owner, changedBy, reason, at: nowSeconds() };
}

function announce(demo: DemoContext, changed: SessionOwnership): SessionOwnership {
  if (changed.owner) demo.state.owners[changed.sessionId] = changed.owner;
  else delete demo.state.owners[changed.sessionId];
  demo.emit("session-owner-changed", changed);
  return changed;
}

/// This phone's input into a session, held to its owner: refused while
/// another Device owns it, and taking it when nobody does. What the
/// demo's three input commands ask before they type.
export function inputFromThisPhone(demo: DemoContext, sessionId: string): void {
  const owner = demo.state.owners[sessionId];
  if (owner && owner.deviceId !== DEMO_DEVICE.deviceId) refuse({ kind: "owned", sessionId, owner });
  if (owner) {
    owner.typedAt = nowSeconds();
    return;
  }
  const now = nowSeconds();
  announce(demo, ownership(sessionId, { ...DEMO_DEVICE, since: now, typedAt: now }, DEMO_DEVICE.deviceId, "claimed"));
}

/// A session that ended takes its owner with it.
export function sessionEndedOwner(demo: DemoContext, sessionId: string): void {
  if (demo.state.owners[sessionId]) announce(demo, ownership(sessionId, null, null, "ended"));
}

function deviceNamed(id: string): LiveDevice {
  const found = [DEMO_DEVICE, DEMO_TABLET].find((d) => d.deviceId === id);
  if (!found) refuse({ kind: "notConnected", sessionId: "", deviceId: id });
  return found;
}

export const OWNER_COMMANDS: Record<string, DemoCommand> = {
  list_session_owners: (_args, demo): Answer<"listSessionOwners"> => ({
    owners: Object.entries(demo.state.owners).map(([sessionId, owner]) => ({
      sessionId,
      owner,
      reason: "claimed" as const,
      at: owner.since,
    })),
    devices: [DEMO_DEVICE, DEMO_TABLET],
    you: DEMO_DEVICE.deviceId,
  }),

  // Always this phone asking: the demo has no desk to ask as.
  set_session_owner: (args, demo): Answer<"setSessionOwner"> => {
    const sessionId = text(args, "sessionId");
    if (!demo.state.terminals[sessionId]) throw new DemoFailure(`unknown session: ${sessionId}`);
    const to = typeof args.to === "string" ? args.to : null;
    const expect = typeof args.expect === "string" ? args.expect : null;
    const current = demo.state.owners[sessionId] ?? null;
    if ((current?.deviceId ?? null) !== expect) refuse({ kind: "changed", sessionId, owner: current });
    if ((current?.deviceId ?? null) === to) return ownership(sessionId, current, null, "other");
    const holderTyped = current && current.deviceId !== DEMO_DEVICE.deviceId ? current.typedAt : null;
    if (args.force !== true && holderTyped != null && nowSeconds() - holderTyped < OWNER_BUSY_SECS) {
      refuse({ kind: "busy", sessionId, owner: current, typedAt: holderTyped });
    }
    const reason: OwnerChange = to === DEMO_DEVICE.deviceId ? "tookOver" : to === null ? "released" : "handedOver";
    const owner = to === null ? null : { ...deviceNamed(to), since: nowSeconds() };
    return announce(demo, ownership(sessionId, owner, DEMO_DEVICE.deviceId, reason));
  },
};
