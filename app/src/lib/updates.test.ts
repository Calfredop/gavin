import { describe, it, expect } from "vitest";
import {
  availableLine,
  endpointToSave,
  installPrompt,
  liveSessions,
  shouldSurfaceCheckError,
  updateBlockedReason,
  upToDateLine,
  type AvailableUpdate,
  type UpdateSettings,
} from "$lib/updates";
import type { ManagedSession } from "$lib/sessionsManager";

const ENDPOINT = "https://github.com/Calfredop/gavin/releases/latest/download/latest.json";

function settings(over: Partial<UpdateSettings> = {}): UpdateSettings {
  return {
    currentVersion: "0.1.0",
    endpoint: ENDPOINT,
    defaultEndpoint: ENDPOINT,
    overridden: false,
    enabled: true,
    pinned: true,
    ...over,
  };
}

function update(over: Partial<AvailableUpdate> = {}): AvailableUpdate {
  return { version: "0.2.0", currentVersion: "0.1.0", notes: null, date: null, ...over };
}

function session(over: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: "s1",
    workspacePath: "/w",
    cwd: "/w",
    status: "idle",
    restored: false,
    interrupted: false,
    orphan: null,
    command: "claude",
    pid: 10,
    rssBytes: 0,
    cpuTimeUs: 0,
    processCount: 1,
    sampledAtUs: 0,
    ...over,
  };
}

describe("updateBlockedReason", () => {
  it("says nothing when the channel is whole", () => {
    expect(updateBlockedReason(settings())).toBeNull();
  });

  // Three separate answers on purpose: each has a different fix, and a
  // single "unavailable" would send somebody to the wrong one.
  it("names a build with no plugins.updater block", () => {
    expect(updateBlockedReason(settings({ enabled: false }))).toMatch(/no update channel/);
  });

  it("names a build that pins no key, ahead of the endpoint", () => {
    // Both wrong at once: the key is the one worth reporting, because an
    // endpoint set on a build that cannot verify buys nothing.
    const reason = updateBlockedReason(settings({ pinned: false, endpoint: "" }));
    expect(reason).toMatch(/pins no update key/);
  });

  it("names a missing endpoint", () => {
    expect(updateBlockedReason(settings({ endpoint: "   " }))).toMatch(/No update endpoint/);
  });
});

describe("the lines the panel prints", () => {
  it("does not claim a check that has not happened", () => {
    expect(upToDateLine(settings(), null)).toBe("gavin 0.1.0.");
  });

  it("dates a check that has", () => {
    const at = new Date(2026, 0, 1, 9, 30);
    expect(upToDateLine(settings(), at)).toContain("up to date as of");
  });

  it("names both versions when one is available", () => {
    expect(availableLine(update())).toBe("gavin 0.2.0 is available. This install is 0.1.0.");
  });
});

describe("liveSessions", () => {
  // The same rule appClose.ts's sessionsToEnd uses, for the same reason:
  // an exited row is a record with nothing behind it, EXCEPT when it
  // left an orphan -- a process still editing the checkout, which is the
  // one the human most needs counted.
  it("counts what is still running", () => {
    expect(liveSessions([session(), session({ id: "s2", status: "running" })])).toHaveLength(2);
  });

  it("drops an exited row", () => {
    expect(liveSessions([session({ status: "exited" })])).toHaveLength(0);
  });

  it("keeps an exited row that left an orphan", () => {
    const orphaned = session({
      status: "exited",
      orphan: { pid: 99 } as unknown as ManagedSession["orphan"],
    });
    expect(liveSessions([orphaned])).toHaveLength(1);
  });
});

describe("installPrompt", () => {
  it("names the version in the title and the confirm", () => {
    const prompt = installPrompt(update(), 0);
    expect(prompt.title).toBe("Install gavin 0.2.0?");
    // The label is what the confirm-gate token is bound to on the Rust
    // side, so it has to carry the version a human actually read.
    expect(prompt.confirmLabel).toBe("Install 0.2.0");
  });

  it("says the download is verified before anything is installed", () => {
    expect(installPrompt(update(), 0).lines.join(" ")).toMatch(/verified against the key/);
  });

  // The daemon consequence is the part that is peculiar to gavin, and it
  // is stated either way -- a stale daemon after an update is true with
  // zero sessions too.
  it("mentions the daemon staying old with no sessions running", () => {
    const lines = installPrompt(update(), 0).lines.join(" ");
    expect(lines).toMatch(/daemon .*stays on the old version/);
    expect(lines).not.toMatch(/terminal session/);
  });

  it("warns that the fix costs the live sessions", () => {
    const lines = installPrompt(update(), 3).lines.join(" ");
    expect(lines).toContain("3 terminal sessions keep running");
    expect(lines).toMatch(/that restart ends those sessions/);
  });

  it("counts one session in the singular", () => {
    expect(installPrompt(update(), 1).lines.join(" ")).toContain("One terminal session keeps");
  });
});

describe("shouldSurfaceCheckError", () => {
  // A silent launch check and a loud manual one. gavin is not published
  // yet, so the launch check's failure is the expected state, and a
  // banner about it every morning is how the surface gets ignored.
  it("stays quiet at launch", () => {
    expect(shouldSurfaceCheckError("launch")).toBe(false);
  });

  it("always answers a button press", () => {
    expect(shouldSurfaceCheckError("manual")).toBe(true);
  });
});

describe("endpointToSave", () => {
  it("keeps a real override", () => {
    expect(endpointToSave("https://example.test/latest.json", settings())).toBe(
      "https://example.test/latest.json"
    );
  });

  it("treats an emptied field as a clear", () => {
    expect(endpointToSave("   ", settings())).toBeNull();
  });

  // Typing the build's own URL back in must not pin it: an override
  // frozen at today's default would ignore a later release that moved
  // the endpoint, on every install that had ever touched this field.
  it("treats the default typed back in as a clear", () => {
    expect(endpointToSave(` ${ENDPOINT} `, settings())).toBeNull();
  });
});
