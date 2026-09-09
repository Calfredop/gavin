import { describe, it, expect } from "vitest";
import { hasSource, source } from "$lib/sources";

// The follow-up queue is three files joined by nothing a type-checker can
// see: a view that renders perfectly while being mounted nowhere, the
// tab-actions row that opens it, and a tab map that has to bring it back
// after a reload. Those are the failures this pins.
//
// Reads the component sources rather than the rendered DOM, following
// sessionsManagerSurface.test.ts and autoCommitSurfaces.test.ts: mounting
// a view to assert "this handler was called" tests the harness, and a
// component `<style>` is compiled away anyway.

const VIEW = "FollowUpQueueView.svelte";
const PANE_HOST = "FollowUpQueuePane.svelte";
const PANE = "Pane.svelte";
const TERMINAL = "TerminalPane.svelte";
const HOME_AGENT = "MainAgentPanel.svelte";
const STATE = "layoutState.ts";

describe("where the queue lives", () => {
  // It used to be a band under every terminal. Measured in WebKit with
  // the band's own CSS that cost 32px of PTY on a working agent with
  // nothing queued and 171px with three follow-ups and the compose box
  // open -- height taken off the terminal, on every tab in the app.
  it("is not a band under the terminal any more", () => {
    const text = source(TERMINAL);
    expect(text).not.toContain("FollowUpQueue");
    // The refit existed only to tell xterm the band had taken a slice of
    // the pane. Nothing takes one now, so a refit keyed on it would be a
    // resize per pane per mount for a rectangle that never moved.
    expect(text).not.toContain("stripVisible");
    expect(hasSource("FollowUpQueue.svelte")).toBe(false);
  });

  it("opens side by side from the tab-actions row, like the plan and the diff", () => {
    const text = source(PANE);
    expect(text).toContain("openFollowUpsInSplit(active, ws.id)");
    expect(text).toContain("<FollowUpQueuePane");
  });

  it("is offered on every terminal tab, not only when something is queued", () => {
    // Unlike the plan and changes chips beside it, this button is also
    // how a follow-up gets WRITTEN -- gating it on a non-empty queue
    // would hide the feature behind itself. What is conditional is the
    // badge.
    const text = source(PANE);
    const button = text.slice(text.indexOf("MessageSquarePlus,") + 1);
    expect(button).toContain("{#if !isViewTab(active)}");
    expect(button).toContain('<span class="queue-count">{queued.length}</span>');
  });

  it("keeps a way to queue on the Home tab, which has no tab bar", () => {
    // The single most important place to be able to queue: it is where
    // "Send to workspace agent" lands. There is no pane to split there,
    // so the same view opens as a dialog.
    const text = source(HOME_AGENT);
    expect(text).toContain("<FollowUpQueueView");
    expect(text).toContain("queueOpen = true");
  });

  it("hangs the disabled reason on an ancestor, not on the disabled button", () => {
    // tooltip.ts binds mouseenter, which a disabled element never fires,
    // so a disabled control cannot explain itself.
    expect(source(PANE)).toContain("<span use:tooltip={blocked ?? undefined}>");
    expect(source(HOME_AGENT)).toContain("<span use:tooltip={queueBlocked ?? undefined}>");
  });
});

describe("the queue tab", () => {
  // A card tab with no card. Reusing that map rather than adding a fourth
  // one is what keeps it out of sessionTabsOnly and its twelve callers,
  // repairUnknownTabs, the close paths and an AppConfig field -- all of
  // which already treat a card tab as a non-session tab.
  it("is keyed by the SESSION, not by a card path", () => {
    const text = source(STATE);
    expect(text).toContain('view: "followups"');
    expect(text).toContain("sessionId: anchorSessionId");
    // Two tabs on one card have two different queues, so a dedupe that
    // ignored the session would fold them into one pane.
    expect(text).toContain("open.sessionId === tab.sessionId");
  });

  it("is named after its terminal, by the label that terminal's own tab wears", () => {
    expect(source("paths.ts")).toContain("export function followUpsTabLabel");
    // The pane names its tabs through tabIdentity.ts, which is where the
    // rule now lives and is unit-tested; the sidebar still spells it out
    // for its own rows.
    for (const name of ["tabIdentity.ts", "Sidebar.svelte"]) {
      const text = source(name);
      expect(text).toContain("followUpsTabLabel(");
      // Narrowed on `view`, so cardTabLabel below it still only ever
      // sees the two views it can name.
      expect(text).toContain('view === "followups"');
    }
    expect(source(PANE)).toContain('from "$lib/panes/tabIdentity"');
  });

  it("closes its own tab, never the session it is the queue for", () => {
    const text = source(PANE_HOST);
    expect(text).toContain("closeSession(tabId)");
    expect(text).not.toContain("closeSession(sessionId)");
  });
});

describe("the view", () => {
  it("says why it cannot queue rather than accepting a message that never arrives", () => {
    // All four requests are new TYPES, so an older daemon refuses them on
    // the wire -- which is exactly why the box has to say so: the human
    // wrote the follow-up because they were about to walk away, and the
    // silence would last until they came back.
    expect(source(VIEW)).toContain("composeBlocked");
  });

  it("hangs the disabled reason on an ancestor, not on the disabled control", () => {
    const text = source(VIEW);
    expect(text).toContain('<div class="composer" use:tooltip={composeBlocked ?? undefined}>');
    expect(text).toContain("<span use:tooltip={refusal ?? undefined}>");
  });

  it("offers all four actions the queue is for", () => {
    const text = source(VIEW);
    expect(text).toContain("queueFollowUp(");
    expect(text).toContain("moveFollowUp(");
    expect(text).toContain("sendFollowUpNow(");
    expect(text).toContain("cancelFollowUp(");
  });

  it("chooses no wording of its own", () => {
    // Every sentence the view shows comes from queuedInput.ts, so the
    // tests that pin those words are the only place they are written.
    const text = source(VIEW);
    for (const fn of ["deliveryHold", "queueCountLabel", "queuedAgeLabel"]) {
      expect(text).toContain(fn);
    }
    // And the button's own tooltip, which is the queue read without
    // opening the pane.
    expect(source(PANE)).toContain("queueTip(queued)");
  });

  it("shows the message rather than the first line of it", () => {
    // The whole reason the queue left the band: there, a follow-up was
    // previewLine'd to 80 characters on one row. A pane has the room.
    const text = source(VIEW);
    expect(text).toContain("{entry.text}");
    expect(text).toContain("white-space: pre-wrap");
  });

  it("keeps a refused follow-up in the box", () => {
    // Clearing the draft before knowing the queue was accepted is how a
    // message the human typed disappears with nothing to show for it.
    const text = source(VIEW);
    const refused = text.indexOf("if (error) return;");
    const cleared = text.indexOf('draft = "";');
    expect(refused).toBeGreaterThan(-1);
    expect(cleared).toBeGreaterThan(refused);
  });

  it("does not let Escape reach the modal stack", () => {
    // As a pane this is not a modal at all; a bubbling Escape would close
    // whatever is behind it instead.
    expect(source(VIEW)).toContain("e.stopPropagation()");
  });

  it("does not take the keyboard on behalf of a pane nobody can see", () => {
    // Pane.svelte mounts every tab of a leaf, hidden ones included, so an
    // unconditional autofocus would steal focus at startup for a
    // restored tab that is not even on screen.
    expect(source(VIEW)).toContain("autofocus={!inline}");
  });
});

describe("the compat gate", () => {
  it("is read through featureBlockedReason on the surface that composes", () => {
    expect(source("queuedInputActions.ts")).toContain(
      'featureBlockedReason(get(daemonCompat), "queuedFollowUps")'
    );
  });

  it("is read on the other surface that can queue — Send to workspace agent", () => {
    // The entry point that produces a payload without the view being
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
    // gitStatusById bug, and here the empty queue would read as
    // "delivered".
    const text = source(STATE);
    expect(text).toContain("seedQueuedInputs");
    expect(text).toContain('listen<[string, QueuedInput[]]>("queued-inputs-changed"');
  });
});
