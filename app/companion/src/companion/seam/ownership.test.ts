// Seam 2, session ownership (v68): a session another Device works in is
// locked on this phone -- named, refused, and one Take over away -- and a
// session this phone owns can be handed on.
//
// Against the Demo Workstation, whose scripted tablet ("iPad (demo)") owns
// the field notes' agent when the demo opens (demo/owners.ts), driven the
// way the terminal's dock drives it (`sendAsOwner` over the dock's own send
// functions) and read at the wire.
import { afterEach, describe, expect, it } from "vitest";
import { get } from "svelte/store";
import { answerDialog, dialogRequest } from "$lib/core/dialog";
import { handOverTargets, OWNER_REFUSED_PREFIX } from "$lib/core/sessionOwnership";
import {
  handOver,
  inputLockedReason,
  liveDevices,
  lockBySessionId,
  ownershipViewer,
  sessionOwners,
  takeOver,
} from "$lib/core/sessionOwnershipState";
import { layoutState } from "$lib/core/layoutState";
import { loopback } from "$companion/channel/port";
import { DEMO } from "$companion/demo/sampleData";
import { DEMO_DEVICE, DEMO_TABLET, TABLET_SESSION } from "$companion/demo/owners";
import { createDemoWorkstation, type DemoWorkstation } from "$companion/demo/workstation";
import { disconnectChannel } from "$companion/remote/connection";
import { sendAsOwner, sendLine } from "$companion/state/typing";
import { connectWorkstation } from "$companion/state/workstation";
import { sessionGroups } from "$companion/surfaces/sessionList";
import { PLAIN_MODES } from "$companion/surfaces/terminalInput";
import { settle } from "$companion/testing/demoBench";
import { deviceStorage, resetDesktopStores } from "$companion/testing/desktopStores";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  disconnectChannel();
  resetDesktopStores();
});

async function visit(): Promise<DemoWorkstation> {
  const demo = createDemoWorkstation();
  cleanups.push(await connectWorkstation(loopback(demo), deviceStorage()));
  await settle();
  return demo;
}

/// What `write_input` carried to one session.
function typedInto(demo: DemoWorkstation, sessionId: string): string[] {
  return demo
    .received()
    .flatMap((m) => (m.type === "invoke" && m.cmd === "write_input" && m.args.sessionId === sessionId ? [m.args.data as string] : []));
}

const line = (sessionId: string, text: string) => () => sendLine(sessionId, text, PLAIN_MODES);

describe("a session another Device works in", () => {
  it("is locked on this phone, naming the Device", async () => {
    await visit();
    expect(get(ownershipViewer)).toBe(DEMO_DEVICE.deviceId);
    expect(get(lockBySessionId)[TABLET_SESSION]?.name).toBe(DEMO_TABLET.name);
    expect(inputLockedReason(TABLET_SESSION)).toBe(
      "iPad (demo) is working on this session. Take over to type here."
    );
    // The phone's own and the nobody's are not.
    expect(get(lockBySessionId)["s-scratch"]).toBeUndefined();
  });

  it("refuses what the phone writes into it, keeping it off the terminal", async () => {
    const demo = await visit();
    const result = await sendAsOwner(TABLET_SESSION, line(TABLET_SESSION, "hello"));
    expect(result).toEqual({
      sent: false,
      notice: "iPad (demo) is working on this session. Take over to type here.",
    });
    expect(demo.state.terminals[TABLET_SESSION].output).not.toContain("hello");
  });

  it("says who has it in the sessions list", async () => {
    await visit();
    const workspace = get(layoutState).workspaces.find((w) => w.id === DEMO.notes)!;
    const rows = sessionGroups({
      workspace,
      tabs: { fileTabsById: {}, boardTabsById: {}, cardTabsById: {} },
      statusById: {},
      sessionNames: {},
      cwdBySessionId: {},
      failureReasonById: {},
      interruptedSessionIds: new Set(),
      startedHere: [],
      lockedBy: Object.fromEntries(Object.entries(get(lockBySessionId)).map(([id, o]) => [id, o.name])),
    }).flatMap((g) => g.rows);
    expect(rows.find((r) => r.id === TABLET_SESSION)?.lockedBy).toBe(DEMO_TABLET.name);
  });

  it("is the phone's after Take over, and what it writes then goes", async () => {
    const demo = await visit();
    expect(await takeOver(TABLET_SESSION)).toBeNull();
    await settle();
    expect(get(lockBySessionId)[TABLET_SESSION]).toBeUndefined();
    expect(demo.state.owners[TABLET_SESSION]?.deviceId).toBe(DEMO_DEVICE.deviceId);
    expect(await sendAsOwner(TABLET_SESSION, line(TABLET_SESSION, "carry on"))).toEqual({ sent: true });
    expect(typedInto(demo, TABLET_SESSION).join("")).toContain("carry on");
  });

  it("asks first while the Device is typing, and a no leaves it where it is", async () => {
    const demo = await visit();
    demo.state.owners[TABLET_SESSION].typedAt = Math.floor(Date.now() / 1000);
    const taking = takeOver(TABLET_SESSION);
    await settle();
    const asked = get(dialogRequest);
    expect(asked?.title).toBe("iPad (demo) is typing right now. Take over anyway?");
    expect(asked?.danger).toBe(true);
    answerDialog(asked!.id, false, false);
    expect(await taking).toBeNull();
    expect(demo.state.owners[TABLET_SESSION]?.deviceId).toBe(DEMO_TABLET.deviceId);

    // A yes takes it.
    const again = takeOver(TABLET_SESSION);
    await settle();
    answerDialog(get(dialogRequest)!.id, true, false);
    expect(await again).toBeNull();
    expect(demo.state.owners[TABLET_SESSION]?.deviceId).toBe(DEMO_DEVICE.deviceId);
  });
});

describe("a line sent while someone else is typing", () => {
  it("asks once, takes the session on a yes, and sends the same bytes again", async () => {
    const demo = await visit();
    const busy = { kind: "busy", sessionId: "s-scratch", typedAt: Math.floor(Date.now() / 1000) };
    let calls = 0;
    const send = async (): Promise<void> => {
      calls += 1;
      if (calls === 1) throw new Error(`${OWNER_REFUSED_PREFIX}${JSON.stringify(busy)}`);
    };
    const result = sendAsOwner("s-scratch", send);
    await settle();
    expect(get(dialogRequest)?.title).toBe("The desk is typing right now. Take over anyway?");
    answerDialog(get(dialogRequest)!.id, true, false);
    expect(await result).toEqual({ sent: true });
    expect(calls).toBe(2);
    expect(demo.state.owners["s-scratch"]?.deviceId).toBe(DEMO_DEVICE.deviceId);
  });

  it("keeps it unsent on a no, with nothing to say", async () => {
    await visit();
    const busy = { kind: "busy", sessionId: "s-scratch", typedAt: Math.floor(Date.now() / 1000) };
    const result = sendAsOwner("s-scratch", async () => {
      throw new Error(`${OWNER_REFUSED_PREFIX}${JSON.stringify(busy)}`);
    });
    await settle();
    answerDialog(get(dialogRequest)!.id, false, false);
    expect(await result).toEqual({ sent: false, notice: null });
  });
});

describe("a session this phone owns", () => {
  it("is the phone's once it types into one nobody owned", async () => {
    const demo = await visit();
    expect(await sendAsOwner("s-scratch", line("s-scratch", "ls"))).toEqual({ sent: true });
    await settle();
    expect(demo.state.owners["s-scratch"]?.deviceId).toBe(DEMO_DEVICE.deviceId);
    expect(get(sessionOwners)["s-scratch"]?.deviceId).toBe(DEMO_DEVICE.deviceId);
    expect(get(lockBySessionId)["s-scratch"]).toBeUndefined();
  });

  it("can be handed to the other Device, and then it is locked here", async () => {
    const demo = await visit();
    await sendAsOwner("s-scratch", line("s-scratch", "ls"));
    await settle();
    expect(handOverTargets(get(liveDevices), get(sessionOwners), "s-scratch", get(ownershipViewer))).toEqual([
      DEMO_TABLET,
      null,
    ]);
    expect(await handOver("s-scratch", DEMO_TABLET.deviceId)).toBeNull();
    await settle();
    expect(demo.state.owners["s-scratch"]?.deviceId).toBe(DEMO_TABLET.deviceId);
    expect(get(lockBySessionId)["s-scratch"]?.name).toBe(DEMO_TABLET.name);
  });

  it("goes back to the desk when handed there, and nobody is locked out", async () => {
    const demo = await visit();
    await sendAsOwner("s-scratch", line("s-scratch", "ls"));
    await settle();
    expect(await handOver("s-scratch", null)).toBeNull();
    await settle();
    expect(demo.state.owners["s-scratch"]).toBeUndefined();
    expect(get(sessionOwners)["s-scratch"]).toBeUndefined();
  });
});
