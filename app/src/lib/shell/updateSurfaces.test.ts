import { describe, it, expect } from "vitest";
import { svelteSources } from "$lib/sources";

// The update channel is expressed on two surfaces that nothing links: a
// badge on the sidebar's Settings row, and the Updates section of the
// workspace Settings panel. Neither is reachable from any other suite --
// a badge bound to a store nobody sets renders perfectly as nothing, and
// an Install button wired to no handler type-checks fine. Both are dead
// controls, and a dead control on THIS feature means an install that
// quietly never updates, which is the whole thing the card is about.
//
// Reads the component sources rather than the rendered DOM, following
// autoCommitSurfaces.test.ts: mounting two panels to assert "this
// handler was called" tests the harness.

const SOURCES = svelteSources();

function source(name: string): string {
  const text = SOURCES[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

const SIDEBAR = "Sidebar.svelte";
const PANEL = "SettingsHubView.svelte";

describe("the sidebar badge", () => {
  it("reads the store the launch check writes", () => {
    const text = source(SIDEBAR);
    expect(text).toContain('import { availableUpdate } from "$lib/shell/updatesState";');
    expect(text).toContain("{#if $availableUpdate}");
  });

  // A version, not a verb. Nothing installs from the sidebar, and a
  // button-shaped badge would promise otherwise.
  it("names the version and points at where the install lives", () => {
    const text = source(SIDEBAR);
    expect(text).toContain("{$availableUpdate.version}<");
    expect(text).toContain("Settings › Updates");
  });
});

describe("the Updates panel", () => {
  it("draws the section", () => {
    expect(source(PANEL)).toContain("<h3>Updates</h3>");
  });

  it("wires the check button to the manual trigger", () => {
    // "manual", not "launch": the trigger is what decides whether a
    // failure is shown, and a button that silently did nothing on a
    // dead endpoint is the one bug this distinction exists to prevent.
    expect(source(PANEL)).toContain('runUpdateCheck("manual")');
  });

  it("routes the install through the prompt rather than straight at the host", () => {
    const text = source(PANEL);
    expect(text).toContain("openInstallPrompt()");
    // The token is minted from an ANSWERED prompt, so the panel must not
    // reach backend.installUpdate itself.
    expect(text).not.toContain("backend.installUpdate");
    expect(text).toContain("runInstall(update)");
  });

  it("keeps focus off the install button, so Enter cannot install", () => {
    // ConfirmPrompt puts focus on the dismissing button whenever a
    // choice is `danger` -- that flag is the whole guard here.
    expect(source(PANEL)).toContain("danger: true, onPick: () => void doInstall()");
  });

  it("explains a disabled Check button from a non-disabled ancestor", () => {
    // tooltip.ts binds mouseenter, which a disabled element never fires:
    // the reason has to hang on the wrapping span or the control refuses
    // to explain itself.
    expect(source(PANEL)).toContain("<span use:tooltip={updateBlocked ?? \"\"}>");
  });

  it("offers the endpoint as a setting, saved through the pure rule", () => {
    const text = source(PANEL);
    expect(text).toContain("endpointToSave(endpointDraft, settings)");
    // The stale answer goes with the endpoint: a version found at the
    // old URL must not sit there attributed to the new one.
    expect(text).toContain("availableUpdate.set(null);");
  });
});
