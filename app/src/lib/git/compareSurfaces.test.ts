import { describe, it, expect } from "vitest";
import { allSources } from "$lib/sources";

// The Compare view is a nav item, a store section, two panes and two
// host commands, and nothing links those files. The state is tested
// against a mocked backend in compareState.test.ts; here the wiring
// between the surfaces is what is guarded -- a nav item nobody mounts,
// or a pane diffing against refs the list never asked about, type-checks
// perfectly and is dead on screen.
//
// Reads sources rather than the rendered DOM, following
// runChangesSurfaces.test.ts.

const SOURCES = allSources();

function source(name: string): string {
  const text = SOURCES[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

describe("the nav item", () => {
  it("sits with Local Changes and All Commits and opens the compare view", () => {
    const text = source("GitNav.svelte");
    expect(text).toContain('class:active={nav === "compare"}');
    expect(text).toContain("selectCompare(workspaceId)");
  });
});

describe("the panes", () => {
  it("swap in for the list and diff columns on the compare selection", () => {
    const text = source("GitHubView.svelte");
    expect(text).toContain('view.navSelection === "compare"');
    expect(text).toContain("<GitCompare {workspaceId} />");
    expect(text).toContain("<GitCompareDiff {workspaceId} />");
  });

  it("diffs read-only: no staging, no line selection, no hunk discard", () => {
    const text = source("GitCompareDiff.svelte");
    expect(text).toContain("canAct={false}");
    expect(text).toContain("discardLabel={nullLabel}");
  });

  it("offers the same unified/split toggle the commit detail does", () => {
    const text = source("GitCompareDiff.svelte");
    expect(text).toContain("setGitViewPrefs(workspaceId, { diffLayout:");
    expect(text).toContain("GitDiffUnified");
    expect(text).toContain("GitDiffSplit");
  });
});

describe("the list pane", () => {
  const LIST = "GitCompare.svelte";

  it("asks for both refs and offers the swap", () => {
    const text = source(LIST);
    expect(text).toContain("setCompareBase(workspaceId, v)");
    expect(text).toContain("setCompareTarget(workspaceId, v)");
    expect(text).toContain("swapCompareRefs(workspaceId)");
  });

  it("defaults to three-dot with a two-dot toggle", () => {
    const text = source(LIST);
    expect(text).toContain("setCompareMode(workspaceId, true)");
    expect(text).toContain("setCompareMode(workspaceId, false)");
  });

  it("says what the summary counted: files, lines, ahead and behind", () => {
    const text = source(LIST);
    expect(text).toContain("summary.filesChanged");
    expect(text).toContain("summary.insertions");
    expect(text).toContain("summary.deletions");
    expect(text).toContain("summary.commitsAhead");
    expect(text).toContain("summary.commitsBehind");
  });

  it("draws the same file rows the other lists draw", () => {
    const text = source(LIST);
    expect(text).toContain("<GitFileRow");
    expect(text).toContain("readonly={true}");
    expect(text).toContain("selectCompareFile(workspaceId, entry.path)");
  });
});

describe("the state", () => {
  it("re-runs an open compare from the refresh pass, never through run()", () => {
    const text = source("gitState.ts");
    expect(text).toContain('navSelection === "compare") await refreshCompare(workspaceId)');
    // Comparing mutates nothing, so it must not take the tab's busy lock.
    expect(text).not.toContain('run(workspaceId, "Compare"');
  });
});

describe("the host commands", () => {
  it("are wrapped with the refs and the mode going to git untouched", () => {
    const text = source("backend.ts");
    expect(text).toContain('invoke("git_compare", { cwd, baseRef, targetRef, threeDot })');
    expect(text).toContain('invoke("git_compare_diff", { cwd, baseRef, targetRef, path, oldPath, threeDot })');
  });
});
