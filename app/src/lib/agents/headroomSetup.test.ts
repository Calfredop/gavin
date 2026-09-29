import { describe, expect, it } from "vitest";
import type { HeadroomStatus } from "$lib/agents/compression";
import {
  HEADROOM_INHERIT,
  HEADROOM_OFF,
  HEADROOM_ON,
  SSH_UNAVAILABLE,
  compareVersions,
  headroomActionLabel,
  headroomActions,
  headroomDefaultBlocked,
  headroomFromSelect,
  headroomInstallCommand,
  headroomInstallView,
  headroomOptions,
  headroomProcess,
  headroomSaved,
  headroomSectionView,
  headroomStateLabel,
  headroomStepDone,
  headroomStepOffers,
  headroomStepSettled,
  headroomSwitchView,
  headroomToSelect,
  headroomUpdateConfirm,
  headroomUpdateLine,
  headroomVersionLine,
  profileRecipeReason,
  showsInstallCommand,
  updateOffered,
  workspaceHeadroomReading,
  type HeadroomReading,
} from "./headroomSetup";

const PIN = "0.39.1";

function status(over: Partial<HeadroomStatus> = {}): HeadroomStatus {
  return {
    state: "absent",
    reason: null,
    newerThanTested: false,
    version: null,
    floor: "0.38.0",
    pin: PIN,
    path: null,
    source: null,
    uvFound: true,
    wanted: false,
    running: false,
    ready: false,
    port: null,
    restarts: 0,
    lastError: null,
    lifetimeTokensSaved: null,
    install: null,
    ...over,
  };
}

const verified = (over: Partial<HeadroomStatus> = {}) =>
  status({ state: "verified", version: PIN, path: "/u/.local/bin/headroom", source: "uv-tool-dir", ...over });
const tooOld = (over: Partial<HeadroomStatus> = {}) =>
  status({
    state: "too-old",
    version: "0.37.4",
    reason: "Headroom 0.37.4 is older than 0.38.0, the oldest version gavin will start.",
    ...over,
  });
const unavailable = () =>
  status({ state: "unavailable", reason: "Headroom is not available on Intel Macs yet.", uvFound: false });

const read = (s: HeadroomStatus): HeadroomReading => ({ kind: "status", status: s });

describe("versions", () => {
  it("orders by the three numbers, then a pre-release under its release", () => {
    expect(compareVersions("0.39.1", "0.39.1")).toBe(0);
    expect(compareVersions("0.38.0", "0.39.1")).toBeLessThan(0);
    expect(compareVersions("0.40.0", "0.39.1")).toBeGreaterThan(0);
    expect(compareVersions("0.39.10", "0.39.9")).toBeGreaterThan(0);
    expect(compareVersions("0.39.1rc1", "0.39.1")).toBeLessThan(0);
    expect(compareVersions("0.39.1.dev3", "0.39.1")).toBeLessThan(0);
  });

  it("places nothing it cannot read", () => {
    expect(compareVersions("latest", PIN)).toBeNull();
    expect(compareVersions("0.39", PIN)).toBeNull();
    expect(compareVersions("0.39.1+local", PIN)).toBeNull();
  });

  it("offers Update below the pin, never at or above it", () => {
    expect(updateOffered(verified({ version: "0.38.2" }))).toBe(true);
    expect(updateOffered(verified({ version: "0.39.1rc2" }))).toBe(true);
    expect(updateOffered(verified())).toBe(false);
    expect(updateOffered(verified({ version: "0.40.0", newerThanTested: true }))).toBe(false);
    expect(updateOffered(tooOld())).toBe(true);
    expect(updateOffered(status())).toBe(false);
    expect(updateOffered(unavailable())).toBe(false);
  });
});

// The card's first criterion: every state renders its own actions from
// here, and none borrows another's.
describe("each state's actions", () => {
  it("Absent: Install with uv, or Locate and Check again without it", () => {
    expect(headroomActions(status())).toEqual(["install", "locate", "check-again"]);
    expect(headroomActions(status({ uvFound: false }))).toEqual(["locate", "check-again"]);
  });

  it("Too old: Update with uv, or Locate and Check again without it", () => {
    expect(headroomActions(tooOld())).toEqual(["update", "locate", "check-again"]);
    expect(headroomActions(tooOld({ uvFound: false }))).toEqual(["locate", "check-again"]);
  });

  it("Verified below the pin: Update; at or above it, only Check again", () => {
    expect(headroomActions(verified({ version: "0.38.0" }))).toEqual(["update", "check-again"]);
    expect(headroomActions(verified())).toEqual(["check-again"]);
    expect(headroomActions(verified({ version: "0.40.0", newerThanTested: true }))).toEqual(["check-again"]);
    // Without uv there is nothing to run the update with.
    expect(headroomActions(verified({ version: "0.38.0", uvFound: false }))).toEqual(["check-again"]);
  });

  it("keeps Update on offer at the pin while the last install failed, to re-run the model fetch", () => {
    const failed = { state: "failed", output: "prefetch exited 1" };
    expect(headroomActions(verified({ install: failed }))).toEqual(["update", "check-again"]);
    expect(headroomActions(verified({ install: { state: "succeeded", output: "" } }))).toEqual(["check-again"]);
    expect(headroomActions(verified({ install: failed, uvFound: false }))).toEqual(["check-again"]);
  });

  it("Unavailable: nothing, because no button can make this machine run it", () => {
    expect(headroomActions(unavailable())).toEqual([]);
  });

  it("offers nothing while an install is running", () => {
    const installing = { state: "running", output: "Resolved 86 packages" };
    expect(headroomActions(status({ install: installing }))).toEqual([]);
    expect(headroomActions(verified({ version: "0.38.0", install: installing }))).toEqual([]);
  });

  it("names each action, the pin on the ones that install it", () => {
    expect(headroomActionLabel("install", status())).toBe("Install Headroom 0.39.1");
    expect(headroomActionLabel("update", tooOld())).toBe("Update to 0.39.1…");
    expect(headroomActionLabel("locate", status())).toBe("Locate…");
    expect(headroomActionLabel("check-again", status())).toBe("Check again");
    expect(headroomActionLabel("check-again", status(), true)).toBe("Checking…");
    // Busy while its own confirmation is up, where "Updating…" would lie.
    expect(headroomActionLabel("update", tooOld(), true)).toBe("Update to 0.39.1…");
  });
});

describe("the install command", () => {
  it("is the line the daemon runs, at the pin", () => {
    expect(headroomInstallCommand("0.39.1")).toBe('uv tool install --python 3.13 "headroom-ai[all]==0.39.1"');
  });

  it("is shown only where the pin wants installing and there is no uv", () => {
    expect(showsInstallCommand(status({ uvFound: false }))).toBe(true);
    expect(showsInstallCommand(tooOld({ uvFound: false }))).toBe(true);
    expect(showsInstallCommand(verified({ version: "0.38.0", uvFound: false }))).toBe(true);
    expect(showsInstallCommand(status())).toBe(false);
    expect(showsInstallCommand(verified({ uvFound: false }))).toBe(false);
    expect(showsInstallCommand(unavailable())).toBe(false);
  });
});

describe("the lines", () => {
  it("gives the version against the pin, and says so above it", () => {
    expect(headroomVersionLine(status())).toBeNull();
    expect(headroomVersionLine(verified())).toBe("0.39.1 · tested 0.39.1");
    expect(headroomVersionLine(verified({ version: "0.40.0", newerThanTested: true }))).toBe(
      "0.40.0 · tested 0.39.1 — newer than tested"
    );
    expect(headroomVersionLine(tooOld())).toBe("0.37.4 · tested 0.39.1 · oldest gavin runs 0.38.0");
  });

  it("offers the update in the spec's words", () => {
    expect(headroomUpdateLine(verified({ version: "0.38.0" }))).toBe(
      "Headroom 0.39.1 is tested — update from 0.38.0."
    );
    expect(headroomUpdateLine(verified())).toBeNull();
  });

  it("says running, starting, stopped or failed, with the port", () => {
    expect(headroomProcess(verified({ wanted: true, running: true, ready: true, port: 51234 }))).toEqual({
      word: "running",
      line: "Running on port 51234",
    });
    expect(headroomProcess(verified({ wanted: true, running: true, port: 51234 })).word).toBe("starting");
    expect(headroomProcess(verified({ wanted: true, port: 51234 })).line).toBe("Starting on port 51234");
    const failed = headroomProcess(
      tooOld({ wanted: true, lastError: "Headroom 0.37.4 is older than 0.38.0, the oldest version gavin will start." })
    );
    expect(failed.word).toBe("failed");
    expect(failed.line).toContain("older than 0.38.0");
    expect(headroomProcess(verified({ port: 51234 }))).toEqual({
      word: "stopped",
      line: "Stopped — no workspace has compression on (port 51234 is kept for it)",
    });
    expect(headroomProcess(verified()).line).toBe("Stopped — no workspace has compression on");
    expect(
      headroomProcess(verified({ wanted: true, running: true, ready: true, port: 1, restarts: 2 })).line
    ).toBe("Running on port 1 · restarted 2 times");
  });

  // Never asked is not "saved nothing", and must not read as 0 tokens.
  it("gives the lifetime total, and nothing where Headroom was never asked", () => {
    expect(headroomSaved(verified())).toBeNull();
    expect(headroomSaved(verified({ lifetimeTokensSaved: 0 }))?.line).toBe("0 tokens saved");
    const saved = headroomSaved(verified({ lifetimeTokensSaved: 1_234_567 }));
    expect(saved?.line).toBe("1.2M tokens saved");
    expect(saved?.exact).toContain("1,234,567");
  });

  it("follows an install through running, failing and finishing", () => {
    expect(headroomInstallView(status())).toBeNull();
    const running = headroomInstallView(status({ install: { state: "running", output: "" } }));
    expect(running?.running).toBe(true);
    expect(running?.line).toContain("compression model");
    const failed = headroomInstallView(status({ install: { state: "failed", output: "error: no python" } }));
    expect(failed).toMatchObject({ running: false, failed: true, output: "error: no python" });
    const done = headroomInstallView(verified({ install: { state: "succeeded", output: "ok" } }));
    expect(done).toMatchObject({ running: false, failed: false, line: "Installed Headroom 0.39.1." });
  });
});

// The card's third criterion, the half a pure module can hold: the
// prompt is `danger`, so ConfirmPrompt keeps focus on Cancel.
describe("the Update confirmation", () => {
  const prompt = headroomUpdateConfirm(verified({ version: "0.38.0", running: true }));

  it("is a danger choice that names the action", () => {
    expect(prompt.danger).toBe(true);
    expect(prompt.confirmLabel).toBe("Update to 0.39.1");
    expect(prompt.title).toBe("Update Headroom to 0.39.1?");
  });

  it("says running compressed agents will retry once", () => {
    expect(prompt.lines?.join(" ")).toMatch(/running compressed agent.*retries it once/);
    expect(prompt.lines?.join(" ")).toContain("same port");
  });
});

describe("the section", () => {
  // Unknown is "Checking…" with nothing to press -- never Absent with an
  // Install button for a Headroom that may be installed.
  it("offers nothing while the reading is out", () => {
    const view = headroomSectionView(undefined);
    expect(view.label).toBe("Checking…");
    expect(view.tone).toBe("unknown");
    expect(view.actions).toEqual([]);
    expect(view.installCommand).toBeNull();
  });

  it("says what the daemon needs when it is too old to ask, and offers nothing", () => {
    const view = headroomSectionView({ kind: "blocked", reason: "Needs daemon v46; the running daemon is v45." });
    expect(view.reason).toContain("v46");
    expect(view.actions).toEqual([]);
  });

  it("says the ask failed, rather than that Headroom is missing", () => {
    const view = headroomSectionView({ kind: "error", message: "connection refused" });
    expect(view.label).not.toBe("Absent");
    expect(view.reason).toContain("connection refused");
    expect(view.actions).toEqual([]);
  });

  it("draws each state under its own name and LED", () => {
    expect(headroomStateLabel("verified")).toBe("Verified");
    expect(headroomStateLabel("too-old")).toBe("Too old");
    expect(headroomStateLabel("absent")).toBe("Absent");
    expect(headroomStateLabel("unavailable")).toBe("Unavailable");
    expect(headroomStateLabel("sideways")).toBe("sideways");
    expect(headroomSectionView(read(verified())).tone).toBe("on");
    expect(headroomSectionView(read(tooOld())).tone).toBe("warn");
    expect(headroomSectionView(read(status())).tone).toBe("off");
  });

  it("gives Unavailable its reason and nothing else", () => {
    const view = headroomSectionView(read(unavailable()));
    expect(view.label).toBe("Unavailable");
    expect(view.reason).toContain("Intel Macs");
    expect(view.actions).toEqual([]);
    expect(view.process).toBeNull();
    expect(view.saved).toBeNull();
  });

  it("carries a state's actions, command and process through", () => {
    const absent = headroomSectionView(read(status({ uvFound: false })));
    expect(absent.actions).toEqual(["locate", "check-again"]);
    expect(absent.installCommand).toBe(headroomInstallCommand(PIN));
    expect(absent.process).toBeNull();
    const running = headroomSectionView(
      read(verified({ wanted: true, running: true, ready: true, port: 9, lifetimeTokensSaved: 812 }))
    );
    expect(running.actions).toEqual(["check-again"]);
    expect(running.process?.word).toBe("running");
    expect(running.saved?.line).toBe("812 tokens saved");
    expect(running.installCommand).toBeNull();
  });
});

describe("the switch", () => {
  it("reads and writes the three rows, inherit clearing the workspace's own", () => {
    expect(headroomToSelect(undefined)).toBe(HEADROOM_INHERIT);
    expect(headroomToSelect(true)).toBe(HEADROOM_ON);
    expect(headroomToSelect(false)).toBe(HEADROOM_OFF);
    expect(headroomToSelect("yes")).toBe(HEADROOM_INHERIT);
    expect(headroomFromSelect(HEADROOM_ON)).toBe(true);
    expect(headroomFromSelect(HEADROOM_OFF)).toBe(false);
    expect(headroomFromSelect(HEADROOM_INHERIT)).toBeNull();
    expect(headroomOptions(false)[0].label).toBe("Default (off)");
    expect(headroomOptions(true)[0].label).toBe("Default (on)");
  });

  it("gives the reason for each profile with no recipe", () => {
    expect(profileRecipeReason("claude-code", "")).toBeNull();
    expect(profileRecipeReason("codex", "")).toBeNull();
    expect(profileRecipeReason("opencode", "")).toBeNull();
    expect(profileRecipeReason("cursor", "")).toBe(
      "Cursor sends everything through Cursor's servers — Headroom can't reach it."
    );
    expect(profileRecipeReason("gemini", "")).toContain("Gemini");
    expect(profileRecipeReason("custom", "")).toContain("API family");
    expect(profileRecipeReason("custom", "anthropic")).toBeNull();
    expect(profileRecipeReason("from-a-newer-app", "")).not.toBeNull();
  });

  const base = { switchBlocked: null, profileId: "claude-code", customApiFamily: "" as const };

  it("is Unavailable and dark for an ssh workspace, whatever the machine has", () => {
    const view = headroomSwitchView({ ...base, reading: workspaceHeadroomReading(read(verified()), { ssh: {} }) });
    expect(view).toEqual({ disabled: true, unavailable: true, notes: [SSH_UNAVAILABLE] });
  });

  it("is Unavailable and dark on a machine Headroom cannot run on", () => {
    const view = headroomSwitchView({ ...base, reading: read(unavailable()) });
    expect(view.disabled).toBe(true);
    expect(view.unavailable).toBe(true);
    expect(view.notes[0]).toContain("Intel Macs");
  });

  it("is dark on a daemon that cannot take it, with the version it needs", () => {
    const view = headroomSwitchView({ ...base, reading: read(verified()), switchBlocked: "Needs daemon v47" });
    expect(view).toEqual({ disabled: true, unavailable: false, notes: ["Needs daemon v47"] });
  });

  it("stays live for a profile with no recipe, and says why it will not compress", () => {
    const view = headroomSwitchView({ ...base, profileId: "cursor", reading: read(verified()) });
    expect(view.disabled).toBe(false);
    expect(view.notes).toEqual(["Cursor sends everything through Cursor's servers — Headroom can't reach it."]);
  });

  it("stays live ahead of the install, and says what is missing", () => {
    expect(headroomSwitchView({ ...base, reading: read(status()) }).notes[0]).toContain("isn't installed");
    expect(headroomSwitchView({ ...base, reading: read(tooOld()) }).notes[0]).toContain("0.37.4 is too old");
    expect(headroomSwitchView({ ...base, reading: read(verified()) })).toEqual({
      disabled: false,
      unavailable: false,
      notes: [],
    });
    // Unknown says nothing yet, rather than guessing.
    expect(headroomSwitchView({ ...base, reading: undefined }).notes).toEqual([]);
  });

  it("darkens the app-wide default only where moving it is pointless", () => {
    expect(headroomDefaultBlocked(read(unavailable()), null)).toContain("Intel Macs");
    expect(headroomDefaultBlocked(read(verified()), "Needs daemon v47")).toBe("Needs daemon v47");
    expect(headroomDefaultBlocked(read(status()), null)).toBeNull();
    expect(headroomDefaultBlocked(undefined, null)).toBeNull();
  });
});

describe("the wizard's step", () => {
  it("offers On when Verified and the install when Absent or Too old", () => {
    expect(headroomStepOffers(read(verified()))).toEqual({ switch: true, install: false });
    expect(headroomStepOffers(read(status()))).toEqual({ switch: false, install: true });
    expect(headroomStepOffers(read(tooOld()))).toEqual({ switch: false, install: true });
    expect(headroomStepOffers(read(unavailable()))).toEqual({ switch: false, install: false });
    expect(headroomStepOffers(undefined)).toEqual({ switch: false, install: false });
  });

  it("is done when asked, or when there is nothing to ask", () => {
    expect(headroomStepDone(read(status()), true)).toBe(true);
    expect(headroomStepDone(read(verified()), false)).toBe(false);
    expect(headroomStepDone(read(unavailable()), false)).toBe(true);
    expect(headroomStepDone({ kind: "unavailable", reason: SSH_UNAVAILABLE }, false)).toBe(true);
    expect(headroomStepDone({ kind: "error", message: "x" }, false)).toBe(false);
    expect(headroomStepDone({ kind: "blocked", reason: "x" }, false)).toBe(false);
  });

  // Unknown is pending, not absent.
  it("is neither done nor settled while the reading is out, unless answered", () => {
    expect(headroomStepDone(undefined, false)).toBe(false);
    expect(headroomStepSettled(undefined, false)).toBe(false);
    expect(headroomStepSettled(undefined, true)).toBe(true);
    expect(headroomStepSettled({ kind: "error", message: "x" }, false)).toBe(true);
  });
});
