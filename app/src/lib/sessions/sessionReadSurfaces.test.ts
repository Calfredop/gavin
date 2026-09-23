import { describe, it, expect } from "vitest";
import { svelteSources } from "$lib/sources";

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

// The four surfaces below read one layer FURTHER on than the
// acknowledged view: `verdictAttention.ts`, which is that view with a
// quiet session the turn verdict reads as a prose question -- or as an
// agent that gave up -- shown as a wait. Both substitutions have to hold
// at once, and the second is invisible to every other suite: the daemon
// calls a prose question `idle`, so a surface that slips back to
// `attentionStatusById` draws a finished agent over a question nobody
// has answered, which is exactly the bug this card was filed for.
describe("the surfaces that nag read the acknowledged, verdict-aware view", () => {
  it("the tab badge", () => {
    // Whitespace-tolerant: the call wraps, and a reformat must not be
    // able to turn this assertion red without changing which store it
    // names.
    expect(source("Pane.svelte")).toMatch(
      /tabAgentIndicator\(\s*\$verdictAttentionStatusById\[sessionId\],/
    );
  });

  it("the sidebar's recap, its expanded tab rows and its search hits", () => {
    const sidebar = source("Sidebar.svelte");
    expect(sidebar).toContain("return pageAgentsSummary(page, $verdictAttentionState);");
    expect(sidebar).toContain("return pageTabRows(page, $verdictAttentionState);");
    expect(sidebar).toContain("tabs: $verdictAttentionState,");
    // The workspace badge is the same tally one level up, and a page
    // row that says "waiting" under a workspace row that does not is
    // the disagreement a human reads as a bug in the sidebar.
    expect(sidebar).toContain("workspaceAgentsSummary(ws, $verdictAttentionState).waiting");
  });

  it("the board card's session dot", () => {
    expect(source("BoardCard.svelte")).toContain(
      "agentIndicator($verdictAttentionStatusById[binding.sessionId])"
    );
  });

  it("the card detail modal's session bar and its best-of-N rows", () => {
    const modal = source("CardDetailModal.svelte");
    expect(modal).toContain("$verdictAttentionStatusById[binding.sessionId]");
    expect(modal).toContain("agentIndicator($verdictAttentionStatusById[row.candidate.sessionId])");
    // Nothing on this modal may be left on the un-upgraded map: the
    // label above the badge and the badge itself disagreeing is worse
    // than either being wrong on its own.
    expect(modal).not.toContain("$attentionStatusById[");
  });
});

describe("the surfaces that nag but predate the verdict read the acknowledged view", () => {
  // The hub reaches the verdict by a different road: its inbox is handed
  // `verdictsOf($turnVerdictById)` and applies the same rule inside
  // `reasonFor`, so the rows are already right. Its fleet TALLIES are
  // not, and moving them is a change to what the hub counts rather than
  // to what a badge draws -- deliberately left for the card that owns
  // that surface.
  it("the hub's fleet figures and its inbox", () => {
    const hub = source("AppHubView.svelte");
    // Both the `fleet` object and the inbox input name the same store.
    expect(hub.match(/state: \$attentionState,/g)).toHaveLength(2);
    expect(hub).toContain("workspaceAgentsSummary(ws, $attentionState)");
    expect(hub).toContain("verdicts: verdictsOf($turnVerdictById),");
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

  // The verdict goes in BESIDE that status, never instead of it. A prose
  // question is `idle` to the daemon, so without this the badge
  // verdictAttention.ts raises over it has no off switch at all -- and
  // the verdict is a judgement, so a false one would nag for ever. The
  // raw `turnVerdictById` rather than any derived view: the entry is the
  // fact, and `canMarkRead` owns the rule about it.
  it("the menu context also carries the verdict, on both surfaces", () => {
    expect(source("Pane.svelte")).toContain("verdict: $turnVerdictById[sessionId] ?? null,");
    expect(source("Sidebar.svelte")).toContain("verdict: $turnVerdictById[row.id] ?? null,");
  });
});
