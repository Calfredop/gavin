import { describe, it, expect } from "vitest";
import {
  loadPlaywrightMark,
  savePlaywrightMark,
  playwrightStepView,
  playwrightActionLabel,
  toPlaywrightReading,
  PLAYWRIGHT_MARKS_KEY,
  type PlaywrightReading,
  type PlaywrightStatus,
} from "$lib/agents/playwrightSetup";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

function status(over: Partial<PlaywrightStatus> = {}): PlaywrightStatus {
  return {
    state: "absent",
    detail: "The browser is not installed. Install sets it up.",
    checks: [
      { id: "npx", ok: true, line: "Node.js (npx) found" },
      { id: "browser", ok: false, line: "Chrome Headless Shell r1247 not installed" },
      { id: "entry", ok: true, line: "`playwright` server in .mcp.json" },
    ],
    command: "npx -y @playwright/mcp@0.0.83 install-browser chromium-headless-shell",
    installable: true,
    conflict: null,
    output: "",
    ...over,
  };
}
const reading = (over: Partial<PlaywrightStatus> = {}): PlaywrightReading => ({ kind: "status", status: status(over) });

describe("the human's answers, per root", () => {
  it("remembers each root's answer apart, and forgets one on null", () => {
    const storage = memoryStorage();
    expect(loadPlaywrightMark("/a", storage)).toBeUndefined();
    savePlaywrightMark("/a", "skipped", storage);
    savePlaywrightMark("/b", "installed", storage);
    expect(loadPlaywrightMark("/a", storage)).toBe("skipped");
    expect(loadPlaywrightMark("/b", storage)).toBe("installed");
    savePlaywrightMark("/a", null, storage);
    expect(loadPlaywrightMark("/a", storage)).toBeUndefined();
    expect(loadPlaywrightMark("/b", storage)).toBe("installed");
  });

  // A hand-edited or older value must read as "not asked", never throw
  // or come back as an answer nobody gave.
  it("reads a damaged store as no answer", () => {
    for (const raw of ["not json", "[]", "null", '{"/a":"maybe","/b":3}']) {
      expect(loadPlaywrightMark("/a", memoryStorage({ [PLAYWRIGHT_MARKS_KEY]: raw }))).toBeUndefined();
    }
  });

  it("remembers nothing, and throws nothing, without storage", () => {
    expect(() => savePlaywrightMark("/a", "skipped", undefined)).not.toThrow();
    expect(loadPlaywrightMark("/a", undefined)).toBeUndefined();
  });
});

describe("toPlaywrightReading", () => {
  it("settles a failed ask as an error rather than leaving it pending", async () => {
    expect(await toPlaywrightReading(Promise.resolve(status()))).toEqual({ kind: "status", status: status() });
    expect(await toPlaywrightReading(Promise.reject(new Error("no such command")))).toEqual({
      kind: "error",
      message: "Error: no such command",
    });
  });
});

describe("playwrightStepView", () => {
  it("offers Install only where something is missing that gavin can put there", () => {
    expect(playwrightStepView(reading(), undefined).action).toBe("install");
    expect(playwrightStepView(reading({ state: "verified", installable: false }), undefined).action).toBeNull();
    // Node missing, or an ssh host without the browser: absent, and the
    // line to run by hand instead of a button.
    const byHand = playwrightStepView(reading({ installable: false }), undefined);
    expect(byHand.action).toBeNull();
    expect(byHand.manualCommand).toContain("install-browser");
  });

  // Someone else's `playwright` server is replaced only on a button that
  // says so, and the step shows what it would remove.
  it("turns Install into Replace when the config already has someone else's server", () => {
    const conflict = { file: ".mcp.json", command: "npx", args: ["@playwright/mcp@latest"] };
    const view = playwrightStepView(reading({ conflict }), undefined);
    expect(view.action).toBe("replace");
    expect(view.conflict).toEqual(conflict);
    expect(playwrightActionLabel("replace")).toContain("Replace");
    expect(playwrightActionLabel("install")).toBe("Install");
  });

  it("offers the human's word only where gavin could not look, until it is given", () => {
    const unchecked = reading({ state: "unavailable", installable: false });
    const asked = playwrightStepView(unchecked, undefined);
    expect(asked.assert).toBe(true);
    expect(asked.tone).toBe("unknown");
    const vouched = playwrightStepView(unchecked, "installed");
    expect(vouched.assert).toBe(false);
    expect(vouched.tone).toBe("claimed");
    expect(vouched.line).toContain("not confirmed");
    // A known agent's checks are machine-true: a word cannot add to them.
    expect(playwrightStepView(reading(), undefined).assert).toBe(false);
  });

  it("reads green only on the checks, never on a mark", () => {
    expect(playwrightStepView(reading({ state: "verified", installable: false }), undefined).tone).toBe("on");
    expect(playwrightStepView(reading(), "installed").tone).toBe("off");
    expect(playwrightStepView(reading(), "skipped").tone).toBe("off");
  });

  it("names why there is nothing to show for an ssh workspace or a failed ask", () => {
    const elsewhere = playwrightStepView({ kind: "elsewhere", reason: "on the host" }, undefined);
    expect(elsewhere).toMatchObject({ tone: "unknown", line: "on the host", action: null, assert: false });
    const failed = playwrightStepView({ kind: "error", message: "boom" }, undefined);
    expect(failed).toMatchObject({ tone: "unknown", line: "boom", action: null });
  });
});
