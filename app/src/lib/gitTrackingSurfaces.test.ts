import { describe, it, expect } from "vitest";

// Git tracking is one question asked on four surfaces -- the sidebar's
// "Initialize gavin here?" prompt, the Settings tab's own init modal, the
// workspace Settings panel and the app-wide one -- and nothing links those
// four files. So every rule they share is invisible to every other suite:
// a prompt whose tick-box is wired to nothing renders perfectly, and a
// panel that calls the setter without the root type-checks fine. Both are
// dead controls, which is what this pins.
//
// Reads the component sources rather than the rendered DOM, following
// autoCommitSurfaces.test.ts.

const SOURCES = import.meta.glob("./*.svelte", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function source(name: string): string {
  const text = SOURCES[`./${name}`];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

const SIDEBAR = "Sidebar.svelte";
const ROOT_CONTROL = "WorkspaceRootControl.svelte";
const WORKSPACE_PANEL = "SettingsHubView.svelte";
const APP_PANEL = "GlobalSettingsModal.svelte";

describe("the sidebar's initialize prompt", () => {
  it("carries the tick-box, seeded from the app-wide default", () => {
    const text = source(SIDEBAR);
    expect(text).toContain("check={{ label: INIT_TRACKING_LABEL");
    // Resolved, never read raw: `null` there is "nobody chose", and a
    // tick-box cannot render a third state -- it would draw an unticked
    // box for an install whose answer is on.
    expect(text).toContain("resolveGitTracking($gitTrackingDefault)");
  });

  it("hands the box's value to the init, not just to the prompt", () => {
    // ConfirmPrompt passes (picked, checked). Dropping the second
    // argument here is the exact shape of a dead tick-box: it moves, and
    // nothing downstream ever reads it.
    expect(source(SIDEBAR)).toContain("initAndOpen(pending, tracked)");
  });
});

describe("the Settings tab's own initialize modal", () => {
  it("asks the same question, in the same words", () => {
    const text = source(ROOT_CONTROL);
    expect(text).toContain("bind:checked={trackInGit}");
    expect(text).toContain("{INIT_TRACKING_LABEL}");
  });

  it("seeds the box when the modal opens rather than subscribing", () => {
    // A live `$gitTrackingDefault` would move the box under the pointer
    // if the default changed in another window mid-question.
    expect(source(ROOT_CONTROL)).toContain("trackInGit = resolveGitTracking($gitTrackingDefault)");
  });

  it("goes through the same helper the sidebar route does", () => {
    // Not its own setGavinGitTracking call: two routes into a fresh
    // workspace that answer the git question differently is the bug.
    expect(source(ROOT_CONTROL)).toContain("applyInitTracking(root, trackInGit)");
    expect(source(ROOT_CONTROL)).not.toContain("backend.setGavinGitTracking");
  });
});

describe("the workspace panel", () => {
  it("reads git rather than a stored field on the workspace", () => {
    const text = source(WORKSPACE_PANEL);
    expect(text).toContain("backend.gavinGitTracking(root)");
    // There is no ws.gitTracking, on purpose: the answer is the repo's
    // .gitignore, and a copy on the workspace record could disagree with
    // it the moment anyone edited the file by hand.
    expect(text).not.toContain("ws.gitTracking");
  });

  it("disables the switch until a read lands, and where gavin cannot act", () => {
    const text = source(WORKSPACE_PANEL);
    expect(text).toContain("disabled={trackingBusy || !canToggleTracking(tracking)}");
  });

  it("says what git currently does through the shared summary", () => {
    // Not prose in the template: the panel and its tests would then
    // disagree about the case where an 'off' left files in the index.
    expect(source(WORKSPACE_PANEL)).toContain("{trackingSummary(tracking)}");
  });

  it("asks before staging removals, and offers ignoring without them", () => {
    const text = source(WORKSPACE_PANEL);
    expect(text).toContain("untrackConfirm(tracking?.indexed ?? 0)");
    expect(text).toContain('label: "Ignore only", onPick: () => void applyTracking(false, false)');
    expect(text).toContain("onPick: () => void applyTracking(false, true)");
  });

  it("guards the async read against a workspace switch with a token", () => {
    // $state proxies objects, so identity cannot decide supersession
    // here; the token counter is what keeps a slow read for the previous
    // root from landing under the new one.
    const text = source(WORKSPACE_PANEL);
    expect(text).toContain("const mine = ++trackToken;");
    expect(text).toContain("if (mine === trackToken)");
  });
});

describe("the app-wide panel", () => {
  it("offers the default and writes it through the store's setter", () => {
    const text = source(APP_PANEL);
    expect(text).toContain("checked={resolveGitTracking($gitTrackingDefault)}");
    expect(text).toContain("setGitTrackingDefault(e.currentTarget.checked)");
  });

  it("says out loud that it only reaches new workspaces", () => {
    // The one thing a human could reasonably expect and must not get:
    // flipping this rewriting .gitignore in every open repo.
    expect(source(APP_PANEL)).toContain("Only new workspaces");
  });
});
