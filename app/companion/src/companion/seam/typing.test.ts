// Seam 2, typing: what the phone's dock sends reaches the Workstation as
// the bytes a program needs, and the quick replies it offers are the ones
// the turn verdict opens (companion-26's acceptance criteria).
//
// Driven the way the terminal surface drives it -- the dock's own send
// functions, the terminal's own screen (a real xterm fed from the wire,
// testing/phoneScreen.ts), the verdict through the desk's own driver --
// against the Demo Workstation, and read at the wire: what `write_input`
// carried, and what the session did with it.
import { afterEach, describe, expect, it } from "vitest";
import { get } from "svelte/store";
import { turnVerdictById } from "$lib/agents/turnVerdictState";
import { layoutState } from "$lib/core/layoutState";
import { loopback } from "$companion/channel/port";
import { createDemoWorkstation, type DemoWorkstation } from "$companion/demo/workstation";
import { write } from "$companion/demo/sessions";
import { disconnectChannel } from "$companion/remote/connection";
import { LAYOUT_SAVING_COMMANDS } from "$companion/remote/remoteRole";
import { watchTurn } from "$companion/state/turn";
import { sendKey, sendLine, sendReply, sendTyped } from "$companion/state/typing";
import { connectWorkstation } from "$companion/state/workstation";
import { quickReplies, type QuickReplies } from "$companion/surfaces/quickReplies";
import { settle } from "$companion/testing/demoBench";
import { deviceStorage, resetDesktopStores } from "$companion/testing/desktopStores";
import { openScreen, type PhoneScreen } from "$companion/testing/phoneScreen";

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

async function screen(sessionId: string): Promise<PhoneScreen> {
  const opened = await openScreen(sessionId);
  cleanups.push(opened.close);
  return opened;
}

/// What `write_input` carried to one session, in order.
function typedInto(demo: DemoWorkstation, sessionId: string): string[] {
  return demo
    .received()
    .flatMap((m) => (m.type === "invoke" && m.cmd === "write_input" && m.args.sessionId === sessionId ? [m.args.data as string] : []));
}

function status(sessionId: string) {
  return get(layoutState).sessionStatusById[sessionId];
}

/// The replies the dock would draw for a session now.
async function repliesFor(sessionId: string, shown: PhoneScreen): Promise<QuickReplies> {
  return quickReplies({
    status: status(sessionId),
    verdict: get(turnVerdictById)[sessionId],
    screen: await shown.rows(),
  });
}

/// Keeps the verdict for a session, as its open terminal does.
function watch(sessionId: string): void {
  cleanups.push(watchTurn(sessionId));
}

describe("the compose field", () => {
  it("sends an agent's input box the line as a paste, plus Enter, and the agent answers it", async () => {
    const demo = await visit();
    const shown = await screen("s-atlas-main");
    expect((await shown.modes()).bracketedPasteMode).toBe(true);

    await sendLine("s-atlas-main", "what is left?", await shown.modes());
    await settle();

    expect(typedInto(demo, "s-atlas-main")).toEqual(["\x1b[200~what is left?\x1b[201~\r"]);
    expect(await shown.text()).toContain("“what is left?”");
  });

  it("sends a shell the line and Enter, with no paste markers it never asked for", async () => {
    const demo = await visit();
    const shown = await screen("s-scratch");
    expect((await shown.modes()).bracketedPasteMode).toBe(false);

    await sendLine("s-scratch", "echo hello from the phone", await shown.modes());
    await settle();

    expect(typedInto(demo, "s-scratch")).toEqual(["echo hello from the phone\r"]);
    expect(await shown.text()).toContain("% echo hello from the phone\nhello from the phone\n");
  });

  it("sends a bare Enter for an empty field", async () => {
    const demo = await visit();
    const shown = await screen("s-scratch");
    await sendLine("s-scratch", "", await shown.modes());
    expect(typedInto(demo, "s-scratch")).toEqual(["\r"]);
  });
});

describe("the quick replies", () => {
  it("come from the verdict for a question asked in prose, and answer it", async () => {
    const demo = await visit();
    const shown = await screen("s-atlas-billing");
    expect(status("s-atlas-billing")).toBe("idle");
    // Nothing to offer before the verdict is in: to the daemon this is
    // just an agent gone quiet.
    expect((await repliesFor("s-atlas-billing", shown)).replies).toEqual([]);

    watch("s-atlas-billing");
    await settle();

    expect(demo.commands()).toContain("typesafe_verdict");
    expect(get(turnVerdictById)["s-atlas-billing"]).toEqual({ state: "read", reading: { kind: "asking" } });
    const asked = await repliesFor("s-atlas-billing", shown);
    expect(asked.shape).toBe("free-text");
    expect(asked.replies.map((r) => r.label)).toEqual(["Yes", "No", "Continue"]);

    await sendReply("s-atlas-billing", asked.replies[2], await shown.modes());
    await settle();

    expect(typedInto(demo, "s-atlas-billing")).toEqual(["\x1b[200~continue\x1b[201~\r"]);
    expect(await shown.text()).toContain("“continue”");
    // The answer ended the turn it was for; the next one is read afresh,
    // and the agent is done, so nothing is offered.
    expect(get(turnVerdictById)["s-atlas-billing"]).toEqual({ state: "read", reading: { kind: "finished" } });
    expect((await repliesFor("s-atlas-billing", shown)).replies).toEqual([]);
  });

  it("are a menu's options for an agent that rang the bell, each sent as its digit", async () => {
    const demo = await visit();
    const shown = await screen("s-atlas-store");
    expect(status("s-atlas-store")).toBe("waiting_for_input");

    const asked = await repliesFor("s-atlas-store", shown);
    expect(asked.shape).toBe("menu");
    expect(asked.replies.map((r) => r.key)).toEqual(["1", "2", "3"]);
    expect(asked.replies[1].label).toBe("Postgres — deployed, needs a sweeper");

    await sendReply("s-atlas-store", asked.replies[1], await shown.modes());
    await settle();

    expect(typedInto(demo, "s-atlas-store")).toEqual(["2"]);
    expect(await shown.text()).toContain("Postgres it is.");
    expect(status("s-atlas-store")).toBe("working");
    expect((await repliesFor("s-atlas-store", shown)).replies).toEqual([]);
  });

  it("are asked of no verdict for a terminal no card or rail runs, as at the desk", async () => {
    const demo = await visit();
    await screen("s-scratch");
    watch("s-scratch");
    await settle();
    expect(demo.commands()).not.toContain("typesafe_verdict");
    expect(get(turnVerdictById)["s-scratch"]).toBeUndefined();
  });

  it("are asked again each time the agent goes quiet, and dropped while it works", async () => {
    const demo = await visit();
    await screen("s-atlas-billing");
    watch("s-atlas-billing");
    await settle();
    const asked = () => demo.commands().filter((cmd) => cmd === "typesafe_verdict").length;
    expect(asked()).toBe(1);

    demo.emit("session-status-changed", ["s-atlas-billing", "working"]);
    await settle();
    expect(get(turnVerdictById)["s-atlas-billing"]).toBeUndefined();

    demo.emit("session-status-changed", ["s-atlas-billing", "idle"]);
    await settle();
    expect(asked()).toBe(2);
  });
});

describe("a verdict the phone holds", () => {
  it("is dropped when its session moves on, shown or not, so no list calls a finished agent waiting", async () => {
    const demo = await visit();
    const stop = watchTurn("s-atlas-billing");
    await settle();
    expect(get(turnVerdictById)["s-atlas-billing"]).toEqual({ state: "read", reading: { kind: "asking" } });
    // The terminal is closed; the agent carries on at the desk.
    stop();
    demo.emit("session-status-changed", ["s-atlas-billing", "working"]);
    await settle();
    expect(get(turnVerdictById)["s-atlas-billing"]).toBeUndefined();
  });

  it("is dropped when the visit ends", async () => {
    await visit();
    watch("s-atlas-billing");
    await settle();
    expect(get(turnVerdictById)["s-atlas-billing"]).toBeDefined();
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    expect(get(turnVerdictById)).toEqual({});
  });
});

describe("the raw keys", () => {
  it("send what a keyboard would, into a program reading them", async () => {
    const demo = await visit();
    const shown = await screen("s-scratch");
    const modes = await shown.modes();

    await sendKey("s-scratch", "up", modes);
    await sendKey("s-scratch", "tab", modes);
    await sendLine("s-scratch", "sleep 30", modes);
    await sendKey("s-scratch", "ctrl-c", modes);
    await settle();

    expect(typedInto(demo, "s-scratch")).toEqual(["\x1b[A", "\t", "sleep 30\r", "\x03"]);
  });

  it("follow a program into application cursor mode", async () => {
    const demo = await visit();
    const shown = await screen("s-scratch");
    // A full-screen program switching its cursor keys, as vim and less do.
    write(demo, "s-scratch", "\x1b[?1h");
    expect((await shown.modes()).applicationCursorKeysMode).toBe(true);

    await sendKey("s-scratch", "up", await shown.modes());
    await sendKey("s-scratch", "left", await shown.modes());
    expect(typedInto(demo, "s-scratch")).toEqual(["\x1bOA", "\x1bOD"]);
  });

  it("interrupt an agent at a menu with Esc", async () => {
    const demo = await visit();
    const shown = await screen("s-atlas-store");
    await sendKey("s-atlas-store", "esc", await shown.modes());
    await settle();
    expect(typedInto(demo, "s-atlas-store")).toEqual(["\x1b"]);
    expect(await shown.text()).toContain("Interrupted");
    expect(status("s-atlas-store")).toBe("idle");
  });

  it("put the next character through the Ctrl latch, and let go", async () => {
    const demo = await visit();
    await screen("s-scratch");
    const latched = sendTyped("s-scratch", "_", true);
    expect(latched.ctrlArmed).toBe(false);
    await latched.sent;
    await sendTyped("s-scratch", "~", false).sent;
    expect(typedInto(demo, "s-scratch")).toEqual(["\x1f", "~"]);
  });
});

describe("typing, at the wire", () => {
  it("sends the session its input and the Workstation's reads, and never a layout", async () => {
    const demo = await visit();
    const shown = await screen("s-atlas-billing");
    watch("s-atlas-billing");
    await settle();
    await sendLine("s-atlas-billing", "always ISO", await shown.modes());
    await sendKey("s-atlas-billing", "esc", await shown.modes());
    await settle();

    const sent = [...new Set(demo.commands())];
    expect(sent.filter((cmd) => (LAYOUT_SAVING_COMMANDS as readonly string[]).includes(cmd))).toEqual([]);
    expect(sent.filter((cmd) => !cmd.startsWith("get_") && cmd !== "worktree_setup").sort()).toEqual(
      // `list_browsers`: the read-back of the agents' browsers, at connect.
      ["list_browsers", "session_screen", "snapshot_session", "typesafe_settings", "typesafe_verdict", "write_input"].sort()
    );
  });
});
