import { describe, it, expect } from "vitest";

// The per-run Changes view is one fact -- `CardSession.base_sha` -- read
// on two surfaces and written at four launch sites, and nothing links
// those six files. Every rule they share is invisible to every other
// suite here: a chip wired to a modal nobody mounts renders as a dead
// glyph, and a launch that forgets to resolve the sha type-checks
// perfectly and simply produces runs that can never be diffed.
//
// Reads sources rather than the rendered DOM, following
// autoCommitSurfaces.test.ts: mounting two modals to assert "this
// handler was called" tests the harness.

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

describe("the card detail modal", () => {
  const DETAIL = "CardDetailModal.svelte";

  it("asks runChanges.ts where the run started rather than reading the sha itself", () => {
    // The reason matters as much as the sha: `runBaseline` is what turns
    // an absent baseline into a sentence instead of an empty diff.
    expect(source(DETAIL)).toContain("runBaseline(binding, $daemonCompat)");
  });

  it("renders the reason when there is no baseline, not a dead button", () => {
    const text = source(DETAIL);
    expect(text).toContain('{#if baseline.kind === "ready"}');
    expect(text).toContain("{baseline.reason}");
  });

  it("mounts the modal with the run's own checkout and sha", () => {
    const text = source(DETAIL);
    expect(text).toContain("<RunChangesModal");
    expect(text).toContain("cwd={baseline.cwd}");
    expect(text).toContain("baseSha={baseline.baseSha}");
    // The live-agent refusal is decided by the modal, from this flag.
    expect(text).toContain("sessionIsLive={bindingLive}");
  });
});

describe("the tab chip", () => {
  const PANE = "Pane.svelte";

  it("appears only for a run that HAS a baseline", () => {
    // `runChangesFor` returns null unless runBaseline is "ready", so the
    // chip cannot open a modal with nothing to diff.
    const text = source(PANE);
    expect(text).toContain("{#if runChangesFor(sessionId)}");
    expect(text).toContain('if (baseline.kind !== "ready") return null;');
  });

  it("fetches nothing to render itself", () => {
    // A count on a chip is a `git diff` per tab per render. The tooltip
    // names the baseline instead, and the modal does the reading.
    const text = source(PANE);
    expect(text).toContain("chipTooltip(run.baseSha)");
    expect(text).not.toContain("gitRunChanges");
  });

  it("mounts the same modal the card detail does", () => {
    expect(source(PANE)).toContain("<RunChangesModal");
  });
});

describe("the launch sites", () => {
  it("resolve the baseline through the gated helper, never git directly", () => {
    // `baseShaForLaunch` is where the daemon gate lives: against a v25
    // daemon it answers null instead of minting a sha the daemon would
    // drop. A launch calling `gitHeadSha` itself would walk past it.
    const runs = source("cardRunActions.ts");
    const orch = source("orchestrationState.ts");
    expect(runs).toContain("baseShaForLaunch(cwd)");
    expect(runs).toContain("baseShaForLaunch(binding.launchCwd ?? binding.cwd)");
    expect(orch).toContain("baseShaForLaunch(cwd)");
    expect(runs).not.toContain("gitHeadSha");
    expect(orch).not.toContain("gitHeadSha");
  });

  it("carry the baseline through a resume instead of re-resolving one", () => {
    expect(source("cardRunActions.ts")).toContain("baseSha: binding.baseSha ?? null");
    expect(source("orchestrationState.ts")).toContain(
      "cardSessionFor(get(kanbanState)[workspaceId], step.cardPath)?.baseSha ?? null"
    );
  });
});

describe("the gate", () => {
  it("is entered in FEATURE_MIN_VERSION with a consumer that reads it", () => {
    expect(source("daemonCompat.ts")).toContain("runChanges: 26");
    expect(source("layoutState.ts")).toContain('featureBlockedReason(get(daemonCompat), "runChanges")');
    expect(source("runChanges.ts")).toContain('featureBlockedReason(compat, "runChanges")');
  });
});

describe("the modal", () => {
  const MODAL = "RunChangesModal.svelte";

  it("is read-only: no staging, no line selection, no hunk discard", () => {
    // The Git tab is where a checkout is edited. Here the only
    // destructive act is the one button, which asks first.
    const text = source(MODAL);
    expect(text).toContain("canAct={false}");
    expect(text).toContain("discardLabel={nullLabel}");
  });

  it("asks before discarding, with the accounting and a danger choice", () => {
    const text = source(MODAL);
    expect(text).toContain("discardPrompt(changes, title)");
    expect(text).toContain("askConfirm(");
    expect(text).toContain("danger: true");
  });

  it("hangs the refusal on a non-disabled ancestor so it can be read", () => {
    // A disabled element fires no mouseenter, so a tooltip bound to one
    // never appears -- the reason has to sit on the span around it.
    expect(source(MODAL)).toContain("<span use:tooltip={blocked ?? undefined}>");
  });
});
