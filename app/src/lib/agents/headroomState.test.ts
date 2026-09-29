import { beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import type { DaemonCompat } from "$lib/core/daemonCompat";
import { FEATURE_MIN_VERSION } from "$lib/core/daemonCompat";
import type { HeadroomStatus } from "$lib/agents/compression";

vi.mock("$lib/core/backend", () => ({
  getHeadroomStatus: vi.fn(),
  detectHeadroom: vi.fn(),
  installHeadroom: vi.fn(),
}));

vi.mock("$lib/core/layoutState", async () => {
  const { writable } = await import("svelte/store");
  return { daemonCompat: writable(null) };
});

vi.mock("$lib/core/dialog", () => ({ askConfirm: vi.fn() }));
vi.mock("$lib/workspace/picker", () => ({ pickPath: vi.fn() }));

import * as backend from "$lib/core/backend";
import { daemonCompat } from "$lib/core/layoutState";
import { askConfirm } from "$lib/core/dialog";
import { pickPath } from "$lib/workspace/picker";
import {
  checkHeadroomAgain,
  ensureHeadroomReading,
  headroomReading,
  installHeadroom,
  locateHeadroom,
  pollFast,
  readHeadroom,
  refreshHeadroom,
  updateHeadroom,
} from "./headroomState";

const NEEDED = FEATURE_MIN_VERSION.headroomSetup;

function compatAt(daemonVersion: number): DaemonCompat {
  return { daemonVersion, appVersion: 48, degraded: daemonVersion < 48 };
}

function status(over: Partial<HeadroomStatus> = {}): HeadroomStatus {
  return {
    state: "absent",
    reason: null,
    newerThanTested: false,
    version: null,
    floor: "0.38.0",
    pin: "0.39.1",
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

async function settled(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe("reading Headroom", () => {
  it("waits for a daemon: not connected is not an answer", async () => {
    const ask = vi.fn();
    expect(await readHeadroom(null, ask)).toBeUndefined();
    expect(ask).not.toHaveBeenCalled();
  });

  // The gate's consumer. A v45 daemon would answer the ask with a wire
  // error; the reading says what it needs instead, and is settled.
  it("settles on the version it needs against a daemon too old to ask", async () => {
    const ask = vi.fn();
    const reading = await readHeadroom(compatAt(NEEDED - 1), ask);
    expect(reading?.kind).toBe("blocked");
    expect(reading?.kind === "blocked" && reading.reason).toContain(`v${NEEDED}`);
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks a daemon that can answer", async () => {
    const answer = status({ state: "verified", version: "0.39.1" });
    expect(await readHeadroom(compatAt(NEEDED), async () => answer)).toEqual({ kind: "status", status: answer });
  });

  // Settled, so nothing waits on it; and never "absent".
  it("settles a failed ask as a failure", async () => {
    const reading = await readHeadroom(compatAt(NEEDED), async () => {
      throw new Error("the daemon went away");
    });
    expect(reading).toEqual({ kind: "error", message: "the daemon went away" });
  });
});

describe("the shared reading", () => {
  beforeEach(() => {
    vi.mocked(backend.getHeadroomStatus).mockReset();
    vi.mocked(backend.detectHeadroom).mockReset();
    vi.mocked(backend.installHeadroom).mockReset();
    vi.mocked(askConfirm).mockReset();
    vi.mocked(pickPath).mockReset();
  });

  it("is read on the first connection after a surface asks, and on every one after", async () => {
    vi.mocked(backend.getHeadroomStatus).mockResolvedValue(status());
    daemonCompat.set(null);
    ensureHeadroomReading();
    await settled();
    expect(backend.getHeadroomStatus).not.toHaveBeenCalled();

    daemonCompat.set(compatAt(NEEDED));
    await settled();
    expect(backend.getHeadroomStatus).toHaveBeenCalledTimes(1);
    expect(get(headroomReading)).toEqual({ kind: "status", status: status() });

    // A restarted daemon may be another version: asked again.
    daemonCompat.set(compatAt(NEEDED + 1));
    await settled();
    expect(backend.getHeadroomStatus).toHaveBeenCalledTimes(2);
  });

  it("drops an answer that lands after a newer one was asked for", async () => {
    daemonCompat.set(compatAt(NEEDED));
    let answerSlow: (s: HeadroomStatus) => void = () => {};
    vi.mocked(backend.getHeadroomStatus).mockReturnValueOnce(new Promise((resolve) => (answerSlow = resolve)));
    const slow = refreshHeadroom();
    const installing = status({ install: { state: "running", output: "" } });
    vi.mocked(backend.installHeadroom).mockResolvedValue(installing);
    expect(await installHeadroom()).toBeNull();
    answerSlow(status());
    await slow;
    expect(get(headroomReading)).toEqual({ kind: "status", status: installing });
  });

  it("hands a refused action's error back and leaves the reading alone", async () => {
    daemonCompat.set(compatAt(NEEDED));
    vi.mocked(backend.getHeadroomStatus).mockResolvedValue(status());
    await refreshHeadroom();
    vi.mocked(backend.detectHeadroom).mockRejectedValue(new Error("refused"));
    expect(await checkHeadroomAgain()).toBe("refused");
    expect(get(headroomReading)).toEqual({ kind: "status", status: status() });
  });

  // The card's third criterion: Update asks first, through askConfirm,
  // with a danger choice -- which is what keeps ConfirmPrompt's focus on
  // Cancel -- and a no installs nothing.
  it("asks before an Update, with a danger choice, and installs only on a yes", async () => {
    const current = status({ state: "verified", version: "0.38.0", running: true });
    vi.mocked(askConfirm).mockResolvedValueOnce(false);
    expect(await updateHeadroom(current)).toBeNull();
    expect(backend.installHeadroom).not.toHaveBeenCalled();
    const asked = vi.mocked(askConfirm).mock.calls[0][0];
    expect(asked.danger).toBe(true);
    expect(asked.lines?.join(" ")).toContain("retries it once");

    vi.mocked(askConfirm).mockResolvedValueOnce(true);
    vi.mocked(backend.installHeadroom).mockResolvedValue(status({ install: { state: "running", output: "" } }));
    expect(await updateHeadroom(current)).toBeNull();
    expect(backend.installHeadroom).toHaveBeenCalledTimes(1);
  });

  it("locates the file picked, and does nothing when nothing was picked", async () => {
    vi.mocked(pickPath).mockResolvedValueOnce(null);
    expect(await locateHeadroom()).toBeNull();
    expect(backend.detectHeadroom).not.toHaveBeenCalled();

    vi.mocked(pickPath).mockResolvedValueOnce("/opt/venv/bin/headroom");
    vi.mocked(backend.detectHeadroom).mockResolvedValue(status({ state: "verified", version: "0.39.1" }));
    expect(await locateHeadroom()).toBeNull();
    expect(backend.detectHeadroom).toHaveBeenCalledWith("/opt/venv/bin/headroom");
  });

  it("checks again without naming a path, so what was located is kept", async () => {
    vi.mocked(backend.detectHeadroom).mockResolvedValue(status());
    await checkHeadroomAgain();
    expect(vi.mocked(backend.detectHeadroom).mock.calls[0]).toEqual([]);
  });
});

describe("polling", () => {
  it("is fast while an install runs or the model loads, and slow otherwise", () => {
    expect(pollFast(undefined)).toBe(false);
    expect(pollFast({ kind: "status", status: status({ install: { state: "running", output: "" } }) })).toBe(true);
    expect(pollFast({ kind: "status", status: status({ wanted: true, running: true }) })).toBe(true);
    expect(pollFast({ kind: "status", status: status({ wanted: true, running: true, ready: true }) })).toBe(false);
    expect(pollFast({ kind: "status", status: status() })).toBe(false);
    expect(pollFast({ kind: "error", message: "x" })).toBe(false);
  });
});
