import { describe, it, expect } from "vitest";
import { svelteSources } from "./sources";

// "Mark as Read" is one acknowledgement expressed as a SPLIT across a
// dozen files, and nothing links them. A surface that nags reads the
// acknowledged view (layoutState's `attentionStatusById` / `attentionState`);
// a surface that ACTS on a session reads the daemon's own
// `sessionStatusById`. Both compile, both type-check, and getting one
// wrong is invisible to every other suite -- a badge that will not go
// quiet, or, far worse, a rail that advances past a question because a
// human silenced its badge (orchestration.ts's agentTurnEnded completes
// an `agent` step on `idle`).
//
// Reads the component sources rather than the rendered DOM, following
// autoCommitSurfaces.test.ts: mounting the sidebar, the hub and four
// modals to assert which store a lookup came from tests the harness.

const SOURCES = svelteSources();

function source(name: string): string {
  const text = SOURCES[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

describe("the surfaces that nag read the acknowledged view", () => {
  it("the tab badge", () => {
    expect(source("Pane.svelte")).toContain("const status = $attentionStatusById[sessionId];");
  });

  it("the sidebar's recap, its expanded tab rows and its search hits", () => {
    const sidebar = source("Sidebar.svelte");
    expect(sidebar).toContain("return pageAgentsSummary(page, $attentionState);");
    expect(sidebar).toContain("return pageTabRows(page, $attentionState);");
    expect(sidebar).toContain("tabs: $attentionState,");
  });

  it("the hub's fleet figures and its inbox", () => {
    const hub = source("AppHubView.svelte");
    // Both the `fleet` object and the inbox input name the same store.
    expect(hub.match(/state: \$attentionState,/g)).toHaveLength(2);
    expect(hub).toContain("workspaceAgentsSummary(ws, $attentionState)");
  });

  it("the board card's session dot", () => {
    expect(source("BoardCard.svelte")).toContain(
      "agentIndicator($attentionStatusById[binding.sessionId])"
    );
  });

  it("the card detail modal's session bar", () => {
    expect(source("CardDetailModal.svelte")).toContain("$attentionStatusById[binding.sessionId]");
  });
});

describe("the surfaces that act keep reading the daemon's own status", () => {
  // The queue refuses to deliver into a `waiting_for_input` session on
  // purpose: the message would land at the prompt of a DIFFERENT
  // question. Reading the masked map here is how a silenced badge would
  // come to paste an unrelated follow-up into an open one.
  it("the follow-up queue's gate, on a pane and on the main agent panel", () => {
    expect(source("Pane.svelte")).toContain("$layoutState.sessionStatusById[active],");
    expect(source("MainAgentPanel.svelte")).toContain("$layoutState.sessionStatusById[sessionId],");
  });

  // The menu entry exists to hide this very wait, so it has to be able to
  // see it -- read the masked map and the entry would vanish the instant
  // it was used, taking the way back with it.
  it("the menu context that offers the mark, on both surfaces that build one", () => {
    expect(source("Pane.svelte")).toContain("status: $layoutState.sessionStatusById[sessionId],");
    expect(source("Sidebar.svelte")).toContain("status: $layoutState.sessionStatusById[row.id],");
  });
});
