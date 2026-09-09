import { describe, it, expect } from "vitest";
import { source } from "./sources";

// Git tracking is one question asked on five surfaces -- the sidebar's
// "Initialize gavin here?" prompt, the Settings tab's own init modal, the
// setup wizard's Git step, the workspace Settings panel and the app-wide
// one -- and nothing links those files. So every rule they share is
// invisible to every other suite: a prompt whose tick-box is wired to
// nothing renders perfectly, and a panel that calls the setter without the
// root type-checks fine. Both are dead controls, which is what this pins.
//
// Reads the component sources rather than the rendered DOM, following
// autoCommitSurfaces.test.ts.

const SIDEBAR = "Sidebar.svelte";
const ROOT_CONTROL = "WorkspaceRootControl.svelte";
const WORKSPACE_PANEL = "SettingsHubView.svelte";
const APP_PANEL = "GlobalSettingsModal.svelte";
const WIZARD = "SetupWizard.svelte";
const WIZARD_STEP = "GitStep.svelte";

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

describe("the wizard", () => {
  it("draws the Git step in the stepper and renders it", () => {
    const text = source(WIZARD);
    expect(text).toContain('{ id: "git", label: "Git" }');
    expect(text).toContain('{:else if current === "git"}');
    expect(text).toContain("<GitStep {workspaceId} onDone={advance} />");
  });

  it("feeds the derivation off the workspace record, adding no read", () => {
    // The wizard already waits on three reads before its first frame.
    // A fourth for a value sitting on the workspace would hold the modal
    // shut for a round trip that cannot change the answer.
    expect(source(WIZARD)).toContain("gitTrackingAsked: Boolean(ws?.gitTrackingAsked)");
  });
});

describe("the wizard's git step", () => {
  it("acts on the pick rather than collecting it for a Continue", () => {
    // A wizard that saved on Continue would leave git and the screen out
    // of step the moment somebody closed the modal instead.
    const text = source(WIZARD_STEP);
    expect(text).toContain("backend.setGavinGitTracking(root, tracked, untrack)");
    expect(text).toContain("void apply(tracked, false);");
  });

  it("records that the question was put, which is the step's whole evidence", () => {
    // Marked even when nothing was clicked: leaving the default in place
    // is an answer, and the one most people will give.
    const text = source(WIZARD_STEP);
    expect(text).toContain("await markGitTrackingAsked(workspaceId);");
  });

  it("asks about the index through the shared rule, not its own copy", () => {
    const text = source(WIZARD_STEP);
    expect(text).toContain("needsUntrackConfirm(status, tracked)");
    expect(text).toContain("untrackConfirm(status?.indexed ?? 0)");
  });

  it("says what git says through the shared summary", () => {
    expect(source(WIZARD_STEP)).toContain("{trackingSummary(status)}");
  });

  it("guards its own read with a token, like every other async step", () => {
    const text = source(WIZARD_STEP);
    expect(text).toContain("const mine = ++token;");
    expect(text).toContain("if (mine === token)");
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

  it("records the answer, so the wizard step does not ask it again", () => {
    expect(source(ROOT_CONTROL)).toContain("markGitTrackingAsked(workspace.id)");
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

  it("records the answer, so the wizard step stops asking it", () => {
    // The panel shows the answer; a step that went on asking for it would
    // be asking a question this human has already settled.
    expect(source(WORKSPACE_PANEL)).toContain("await markGitTrackingAsked(workspaceId);");
  });

  it("asks before staging removals, and offers ignoring without them", () => {
    const text = source(WORKSPACE_PANEL);
    expect(text).toContain("needsUntrackConfirm(tracking, tracked)");
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
