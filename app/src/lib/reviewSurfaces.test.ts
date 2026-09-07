import { describe, it, expect } from "vitest";
import { HUB_VIEW_META, orderableHubViewIds, tabStripHubViewIds, visibleHubViewIds } from "./hubViewMeta";

// The Review tab is four pure modules and four components, and the rules
// that hold them together are invisible to every other suite here. A tab
// registered in the metadata with no component is a crash at render; a
// list that draws "0 files" for a card nobody measured type-checks
// perfectly and lies; a terminal mounted without a {#key} keeps the
// previous card's agent on screen while reporting this pane's geometry
// to it.
//
// Reads sources rather than the rendered DOM, following
// runChangesSurfaces.test.ts: mounting the tab to assert "this handler
// was called" tests the harness.

const SOURCES = import.meta.glob("./*.{svelte,ts}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function source(name: string): string {
  const text = SOURCES[`./${name}`];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

describe("the tab's registration", () => {
  it("is a hub view that needs a root — every column of it reads a checkout", () => {
    const meta = HUB_VIEW_META.find((v) => v.id === "review");
    expect(meta).toBeDefined();
    expect(meta?.label).toBe("Review");
    expect(meta?.requiresRoot).toBe(true);
  });

  it("draws as a tab in the strip rather than behind an action", () => {
    expect(orderableHubViewIds()).toContain("review");
    expect(tabStripHubViewIds(true)).toContain("review");
  });

  it("is not offered to a workspace with no root folder", () => {
    expect(visibleHubViewIds(false)).not.toContain("review");
  });

  it("has a component bound to its id", () => {
    // HUB_VIEW_META and COMPONENTS are keyed by the same ids, and a
    // missing entry is an undefined spread that crashes at render rather
    // than a compile error the id union would catch.
    const text = source("workspaceViews.ts");
    expect(text).toContain("import ReviewHubView from \"./ReviewHubView.svelte\"");
    expect(text).toContain("review: { icon: ScanEye, component: ReviewHubView }");
  });
});

describe("the hub view", () => {
  const VIEW = "ReviewHubView.svelte";

  it("asks runChanges.ts where each run started rather than reading the sha itself", () => {
    // The shared resolver is what makes "no baseline" one answer with
    // one spelling across the Changes view and this tab.
    expect(source(VIEW)).toContain("runBaseline(cardSessionFor(board, card.id), $daemonCompat)");
  });

  it("shows that resolver's own reason rather than a second sentence", () => {
    const text = source(VIEW);
    expect(text).toContain('{:else if baseline?.kind === "none"}');
    expect(text).toContain("{baseline.reason}");
  });

  it("re-resolves the selection against the list rather than trusting the stored path", () => {
    // The list moves under the selection whenever the query changes, the
    // archive toggle flips, or a card is filed elsewhere in the app.
    expect(source(VIEW)).toContain("resolveSelection(groups, prefs.selected)");
  });

  it("groups through reviewBoard.ts rather than clustering in the template", () => {
    const text = source(VIEW);
    expect(text).toContain("groupCandidates(candidates)");
    expect(text).toContain("reviewCards(merged, reviewColumns,");
    expect(text).toContain("resolveReviewColumns(columns, prefs.columns)");
  });

  it("drops the open file when the selected card changes", () => {
    // A diff belongs to the card it was read from; leaving it up under
    // another card's heading is somebody else's work under this name.
    expect(source(VIEW)).toContain("clearReviewFile(workspaceId)");
  });

  it("mounts all three columns", () => {
    const text = source(VIEW);
    expect(text).toContain("<ReviewAgentPane");
    expect(text).toContain("<ReviewFilePane");
    expect(text).toContain("<GitFileRow");
  });

  it("offers Refresh as a forced re-read, not a cached one", () => {
    expect(source(VIEW)).toContain("loadTouchedFiles(workspaceId, requests, { force: true })");
  });
});

describe("the card list", () => {
  const LIST = "ReviewCardList.svelte";

  it("never says a number of files for a card nobody measured", () => {
    const text = source(LIST);
    // The unmeasured branch comes BEFORE any count, and says words.
    expect(text).toContain("{:else if candidate.files === null}");
    expect(text).toContain("not measured");
  });

  it("says a card is still being read rather than drawing it as fileless", () => {
    expect(source(LIST)).toContain("{#if loadingPaths.has(candidate.card.id)}");
  });

  it("keeps a way back when it is collapsed", () => {
    // Collapsed, not hidden: the three columns beside it are all ABOUT
    // the selected card, so a list that could vanish entirely would leave
    // the view with no way to reach its own subject.
    const text = source(LIST);
    expect(text).toContain("{#if collapsed}");
    expect(text).toContain("Show the review list");
  });

  it("carries the search box and the archive toggle the card asked for", () => {
    const text = source(LIST);
    expect(text).toContain("<SearchInput");
    expect(text).toContain("onToggleArchived");
  });
});

describe("the agent column", () => {
  const AGENT = "ReviewAgentPane.svelte";

  it("keys the terminal on the session id", () => {
    // TerminalPane binds its session in onMount and never re-reads it:
    // handed a new id in place it keeps showing the old session while
    // fit() reports that terminal's measurements to the new one.
    const text = source(AGENT);
    expect(text).toContain("{#key sessionId}");
    expect(text).toContain("<TerminalPane bind:this={pane} {sessionId}");
  });

  it("starts the review launch, never the ordinary run or resume", () => {
    // runCard and resumeCard both write In Progress on a Done card,
    // which un-archives it out of plans/done/ and drops it off this very
    // list.
    const text = source(AGENT);
    expect(text).toContain("reviewCardSession(workspaceId, card)");
    expect(text).not.toContain("resumeCard(");
    expect(text).not.toContain("runCard(");
  });

  it("says the launch leaves the card where it is", () => {
    expect(source(AGENT)).toContain("It leaves the card where it is.");
  });
});

describe("the file column", () => {
  const PANE = "ReviewFilePane.svelte";

  it("switches between the diff and the editor", () => {
    const text = source(PANE);
    expect(text).toContain('mode = "diff"');
    expect(text).toContain('mode = "edit"');
    expect(text).toContain("<GitDiffUnified");
    expect(text).toContain("<FileEditor");
  });

  it("keys the editor on the file it is holding", () => {
    // FileEditor reads its file in onMount and holds a buffer for it.
    expect(source(PANE)).toContain("{#key absolute}");
  });

  it("does not offer Edit until it knows which checkout the file is in", () => {
    expect(source(PANE)).toContain("disabled={absolute === null}");
  });

  it("returns to the diff on every new file", () => {
    const text = source(PANE);
    expect(text).toContain("void file;");
    expect(text).toContain('mode = "diff";');
  });
});

describe("the launch", () => {
  const ACTIONS = "cardRunActions.ts";

  it("exempts a review from the status write", () => {
    expect(source(ACTIONS)).toContain('if (mode !== "review" && runStatusNeeded(card.status))');
  });

  it("keeps the run's baseline instead of resolving a fresh one", () => {
    expect(source(ACTIONS)).toContain('(mode === "resume" || mode === "review") && binding?.baseSha');
  });

  it("reopens the conversation when the profile can", () => {
    expect(source(ACTIONS)).toContain('mode === "resume" || mode === "review"\n      ? buildResumeCommand');
  });
});
