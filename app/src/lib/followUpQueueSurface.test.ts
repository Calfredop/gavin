import { describe, it, expect } from "vitest";

// The follow-up queue strip is two files joined by nothing a
// type-checker can see: a band that renders perfectly while being
// mounted nowhere, and a pane whose terminal is a rectangle the band
// silently shrinks without anybody telling xterm. Both are the failure
// this pins.
//
// Reads the component sources rather than the rendered DOM, following
// sessionsManagerSurface.test.ts and autoCommitSurfaces.test.ts: mounting
// a band to assert "this handler was called" tests the harness, and a
// component `<style>` is compiled away anyway.

const SOURCES = import.meta.glob(
  ["./*.svelte", "./cardRunActions.ts", "./layoutState.ts", "./queuedInputActions.ts"],
  {
    query: "?raw",
    import: "default",
    eager: true,
  }
) as Record<string, string>;

function source(name: string): string {
  const text = SOURCES[`./${name}`];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

const STRIP = "FollowUpQueue.svelte";
const PANE = "TerminalPane.svelte";

describe("the queue strip", () => {
  it("is mounted by the one component every terminal goes through", () => {
    // TerminalPane, not Pane: the workspace agent on the Home tab is a
    // TerminalPane with no Pane around it, and it is the single most
    // important place to be able to queue -- it is where "Send to
    // workspace agent" lands.
    expect(source(PANE)).toContain("<FollowUpQueue {sessionId} />");
  });

  it("takes its height off the terminal rather than covering it", () => {
    const text = source(PANE);
    expect(text).toContain("flex-direction: column");
    // Without min-height: 0 a flex item refuses to shrink below its
    // content, and the band would push the terminal's last rows out of
    // the pane instead of taking height from it.
    expect(text).toContain("min-height: 0");
  });

  it("refits the terminal when the band appears or goes", () => {
    // xterm only learns a new size from a fit(), and the daemon sizes
    // the PTY from what that reports. Without this a full-screen TUI
    // paints its bottom lines underneath the strip.
    const text = source(PANE);
    expect(text).toContain("stripVisible(");
    expect(text).toContain("void tick().then(() => fit())");
  });

  it("says why it cannot queue rather than accepting a message that never arrives", () => {
    // All four requests are new TYPES, so an older daemon refuses them on
    // the wire -- which is exactly why the box has to say so: the human
    // wrote the follow-up because they were about to walk away, and the
    // silence would last until they came back.
    expect(source(STRIP)).toContain("composeBlocked");
  });

  it("hangs the disabled reason on an ancestor, not on the disabled button", () => {
    // tooltip.ts binds mouseenter, which a disabled element never fires,
    // so a disabled control cannot explain itself.
    const text = source(STRIP);
    expect(text).toContain("<span use:tooltip={composeBlocked ?? undefined}>");
    expect(text).toContain("<span use:tooltip={refusal ?? undefined}>");
  });

  it("offers all four actions the queue is for", () => {
    const text = source(STRIP);
    expect(text).toContain("queueFollowUp(");
    expect(text).toContain("moveFollowUp(");
    expect(text).toContain("sendFollowUpNow(");
    expect(text).toContain("cancelFollowUp(");
  });

  it("chooses no wording of its own", () => {
    // Every sentence the strip shows comes from queuedInput.ts, so the
    // tests that pin those words are the only place they are written.
    const text = source(STRIP);
    for (const fn of ["deliveryHold", "queueCountLabel", "previewLine", "queuedAgeLabel", "entryTip"]) {
      expect(text).toContain(fn);
    }
  });

  it("keeps a refused follow-up in the box", () => {
    // Clearing the draft before knowing the queue was accepted is how a
    // message the human typed disappears with nothing to show for it.
    const text = source(STRIP);
    const refused = text.indexOf("if (error) return;");
    const cleared = text.indexOf('draft = "";');
    expect(refused).toBeGreaterThan(-1);
    expect(cleared).toBeGreaterThan(refused);
  });

  it("keeps the draft when the composer closes, so nothing needs confirming", () => {
    // The ⌘N card composer asks before dropping typed content. This one
    // does not have to, because closing it drops nothing -- and that
    // only holds while `draft` is cleared on success alone.
    const text = source(STRIP);
    expect(text).not.toContain('composerOpen = false;\n    draft = ""');
    expect(text).toContain("your draft is kept");
  });

  it("does not let Escape reach the modal stack", () => {
    // This band is not a modal; a bubbling Escape would close whatever
    // is behind it instead.
    expect(source(STRIP)).toContain("e.stopPropagation()");
  });
});

describe("the compat gate", () => {
  it("is read through featureBlockedReason on the surface that composes", () => {
    expect(source("queuedInputActions.ts")).toContain(
      'featureBlockedReason(get(daemonCompat), "queuedFollowUps")'
    );
  });

  it("is read on the other surface that can queue — Send to workspace agent", () => {
    // The entry point that produces a payload without the strip being
    // open. Against an older daemon it must fall back to the paste it
    // always did, never drop the card in silence.
    const text = source("cardRunActions.ts");
    expect(text).toContain("queueTargetFor(");
    expect(text).toContain("shouldQueueForMainAgent(");
    expect(text).toContain("if (!target.blockedReason && shouldQueueForMainAgent(target.status))");
  });
});

describe("the store behind it", () => {
  it("has a read-back, not just a push", () => {
    // QueuedInputsChanged is routed to a session's attached writer, and
    // Attach runs once per app PROCESS -- so a reloaded frontend has
    // missed every one. A push-fed map with no read-back is the
    // gitStatusById bug, and here the empty strip would read as
    // "delivered".
    const text = source("layoutState.ts");
    expect(text).toContain("seedQueuedInputs");
    expect(text).toContain('listen<[string, QueuedInput[]]>("queued-inputs-changed"');
  });
});
