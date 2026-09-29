import { describe, expect, it } from "vitest";
import { source } from "$lib/sources";

// A static pre-flight over the three Headroom surfaces. Every rule they
// draw is headroomSetup.ts's and tested there; what no suite can mount is
// the templates, so this reads them for the wiring those rules depend on
// -- the one reading, the one set of actions, the Update's confirmation,
// and the switch that answers the wizard's question.

const CONTROLS = source("HeadroomControls.svelte");
const APP_SETTINGS = source("GlobalSettingsView.svelte");
const WORKSPACE_SETTINGS = source("SettingsHubView.svelte");
const STEP = source("HeadroomStep.svelte");
const STATE = source("headroomState.ts");

describe("the controls Settings and the wizard share", () => {
  it("draw everything from the section view, and every action from its list", () => {
    expect(CONTROLS).toContain("headroomSectionView(reading)");
    expect(CONTROLS).toContain("{#each view.actions as action");
    expect(CONTROLS).toContain("headroomActionLabel(action, status");
  });

  it("are the same component in both places", () => {
    expect(APP_SETTINGS).toContain("<HeadroomControls reading={$headroomReading} />");
    expect(STEP).toContain("<HeadroomControls {reading} />");
  });

  // Update restarts the proxy every compressed agent is talking through,
  // so it goes through the one function that asks first.
  it("send Update through the confirmation, and nothing else past it", () => {
    expect(CONTROLS).toContain("await updateHeadroom(status)");
    expect(CONTROLS).not.toMatch(/backend\.installHeadroom/);
    expect(STATE).toMatch(/if \(!\(await askConfirm\(headroomUpdateConfirm\(status\)\)\)\) return null;/);
  });
});

// The card's third criterion, end to end: a `danger` choice reaches the
// prompt, and the prompt then focuses the dismissing button.
describe("the Update confirmation", () => {
  it("is the app's own modal, never a native dialog", () => {
    for (const text of [CONTROLS, STATE, APP_SETTINGS]) {
      expect(text).not.toMatch(/from "@tauri-apps\/plugin-dialog"/);
    }
    expect(STATE).toContain('import { askConfirm } from "$lib/core/dialog"');
  });

  it("keeps focus on the dismissing button when its choice is danger", () => {
    expect(source("AppDialog.svelte")).toContain("danger: req.danger");
    expect(source("ConfirmPrompt.svelte")).toMatch(
      /const target = enterIsSafe \? choiceButtons\[choices\.length - 1\] : cancelButton;/
    );
  });
});

describe("the app-wide Settings section", () => {
  it("offers the default through the three rows, and names the residual", () => {
    expect(APP_SETTINGS).toContain("headroomOptions(DEFAULT_HEADROOM)");
    expect(APP_SETTINGS).toContain("setHeadroomDefault(headroomFromSelect(");
    expect(APP_SETTINGS).toContain("{HEADROOM_RESIDUAL_NOTE}");
  });

  it("is live while open", () => {
    expect(APP_SETTINGS).toContain("onMount(() => watchHeadroom())");
  });
});

describe("the workspace switch", () => {
  it("takes its darkness and its notes from the switch view, for this workspace", () => {
    expect(WORKSPACE_SETTINGS).toContain("headroomSwitchView({");
    expect(WORKSPACE_SETTINGS).toContain("workspaceHeadroomReading($headroomReading, ws)");
    expect(WORKSPACE_SETTINGS).toContain("disabled={headroomSwitch.disabled}");
    expect(WORKSPACE_SETTINGS).toContain('<option value="unavailable">Unavailable</option>');
    expect(WORKSPACE_SETTINGS).toContain("{#each headroomSwitch.notes as note");
  });

  // Moving it answers the wizard's question; otherwise the step goes on
  // asking something the human settled in a panel that shows the answer.
  it("answers the wizard's step when it is moved", () => {
    const pick = WORKSPACE_SETTINGS.slice(WORKSPACE_SETTINGS.indexOf("async function pickHeadroom"));
    expect(pick).toMatch(/setWorkspaceHeadroom\(workspaceId, headroomFromSelect\(value\)\);\s*await markHeadroomAsked\(workspaceId\);/);
  });
});

describe("the wizard's step", () => {
  it("offers the switch only when Headroom is Verified, and marks the question put", () => {
    expect(STEP).toContain("headroomStepOffers(reading)");
    expect(STEP).toContain("{#if offers.switch && ws}");
    expect(STEP).toContain("await markHeadroomAsked(workspaceId);");
  });

  it("says it is checking while the reading is out, rather than drawing a state", () => {
    expect(STEP).toMatch(/\{#if reading === undefined\}\s*<p class="hint">Checking…<\/p>/);
  });
});

// Honest failures (v50). Which session is an exception, and why, is
// headroomMark.ts's and tested there; the tab is a template no suite
// mounts, so this reads it for the wiring the mark depends on.
describe("the exception mark on a tab", () => {
  const PANE = source("Pane.svelte");

  it("is decided by the one rule, from the session's facts and the workspace's setting as it is now", () => {
    expect(PANE).toContain(
      "const compressedHere = resolveHeadroom(ownHeadroom(getActiveWorkspace($layoutState)), $headroomDefault);"
    );
    expect(PANE).toContain(
      "return headroomIndicator(headroomException($sessionCompressionById[sessionId], compressedHere));"
    );
  });

  it("is drawn in the shared vocabulary, beside the tab's other badges", () => {
    expect(PANE).toContain("{#if headroom}<StatusBadge indicator={headroom} size={10} />{/if}");
  });

  // The facts reach the store three ways, and each has a writer.
  it("is fed by the create event, the reload's baselines, and the end-of-turn check", () => {
    const layout = source("layoutState.ts");
    expect(layout).toContain('"session-compression",');
    expect(layout).toContain("(event) => noteSessionCompression(event.payload.id, event.payload)");
    expect(layout).toContain("seedSessionCompression(baselines);");
    expect(source("headroomReachDriver.ts")).toContain("noteHeadroomReach(sessionId, parseReach(word));");
    expect(source("orchestrationState.ts")).toContain("const stopHeadroomReach = startHeadroomReach();");
  });

  // A reopened conversation goes quiet once before any turn: its history
  // being painted. Both launches that reopen one say so.
  it("is told which sessions reopened a conversation", () => {
    expect(source("cardRunActions.ts")).toContain("noteReopenedConversation(resumed);");
    expect(source("orchestrationState.ts")).toContain("noteReopenedConversation(sessionId);");
  });
});
